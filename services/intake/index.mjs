#!/usr/bin/env node
// bona-intake — the daemon.
//
// Polls the owner's OWN WhatsApp (Evolution API, instance `abdulaziz-personal`) for PDFs he
// drops into any group whose subject matches BONA_WA_GROUP_MATCH *and which he created*,
// turns each brochure into a listing in the Bona repo, pushes, and replies in the group.
//
// READ-ONLY on the instance apart from `sendText`. It never configures a webhook, websocket
// or RabbitMQ binding — another agent consumes this instance's events and a webhook here
// would steal them.
//
// One job at a time (a single worker over a FIFO queue), and a lock file on top of that so
// run-once.mjs can never write the clone at the same moment. The git order is fixed:
// clean tree -> pull -> work -> commit+push. Nothing pulls mid-flight.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, missingRequired } from './lib/env.mjs';
import { createEvolutionClient, documentOf, fileLengthOf, isFromOwner, isOwnerGroup, messageTs, oldestFirst, textOf, videoOf } from './lib/evolution.mjs';
import { findListingId, HELP_TEXT, parseCaption, parseCommand } from './lib/commands.mjs';
import * as edits from './lib/edits.mjs';
import { pickListingForVideo, prepareVideo, wakeParkedClip } from './lib/video.mjs';
import { candidateListings, matchVideoToListing } from './lib/video-match.mjs';
import { listInbox } from './lib/listing.mjs';
import { withLock } from './lib/lock.mjs';
import { log } from './lib/log.mjs';
import * as msg from './lib/messages.mjs';
import { processPdf, RejectError, sha256File } from './lib/pipeline.mjs';
import { assertCleanTree, gitCommitPush, gitPull, rebuild, resetTree, waitForLive } from './lib/publish.mjs';
import { STOP_GRACE_MS, waitForIdle } from './lib/shutdown.mjs';
import { createState } from './lib/state.mjs';

const cfg = loadConfig();
const state = createState(cfg.statePath);
const evo = createEvolutionClient({ baseUrl: cfg.evolutionUrl, apiKey: cfg.evolutionKey, instance: cfg.instance });

let groups = [];          // [{ id, subject }]
let stopping = false;
const queue = [];
let working = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = () => working || queue.length > 0;

async function reply(jid, text) {
  if (!cfg.sendReplies) { log.info('wa.reply_suppressed', { to: jid, text }); return; }
  try { await evo.sendText(jid, text); } catch (err) { log.error('wa.reply_failed', { to: jid, error: err.message }); }
}

/** Repo-relative paths this job may stage. Nothing else is ever committed. */
const stagePaths = (slug) => [path.posix.join('public', 'listings', slug), path.posix.join('scripts', 'curate', 'inbox'), path.posix.join('src', 'data', 'listings.json')];

/** Bring the clone to a known-good state. ALWAYS before the first write, never after. */
async function prepareRepo() {
  const clean = await assertCleanTree(cfg.repo);
  if (clean.recovered) log.warn('git.tree_recovered', { repo: cfg.repo });
  await gitPull(cfg.repo, { remote: cfg.gitRemote, branch: cfg.gitBranch });
}

// ---------------------------------------------------------------- group discovery
async function discoverGroups() {
  const re = new RegExp(cfg.groupMatch, 'i');
  const all = await evo.fetchAllGroups();
  const selected = all.filter((g) => {
    // An explicitly configured jid is trusted: the owner put it in the env file himself.
    if (cfg.groupJids.includes(g.id)) return true;
    if (!re.test(g.subject)) return false;
    // A subject match alone is not enough — anyone can call a group "Bona Listings" and add
    // the owner's number to it. Only a group the owner created (or last renamed) counts,
    // and a group that reports no owner at all fails closed.
    if (isOwnerGroup(g, cfg.ownerJid)) return true;
    log.warn('group.rejected_not_owned', { jid: g.id, subject: g.subject, owner: g.owner ?? null, subjectOwner: g.subjectOwner ?? null });
    return false;
  });
  const added = selected.filter((g) => !groups.some((x) => x.id === g.id));
  groups = selected;
  for (const g of added) {
    log.info('group.selected', { jid: g.id, subject: g.subject });
    if (!state.isAnnounced(g.id)) {
      // First sight of this group: treat everything already in it as history so an old PDF
      // in an existing chat is never published behind the owner's back.
      try {
        const { records } = await evo.findMessages(g.id, { pageSize: 100 });
        state.markSeenBulk(records.map((r) => r?.key?.id).filter(Boolean));
        log.info('group.seeded', { jid: g.id, seeded: records.length });
      } catch (err) {
        log.warn('group.seed_failed', { jid: g.id, error: err.message });
      }
      state.markAnnounced(g.id);
      await reply(g.id, msg.ANNOUNCE);
    }
  }
  if (!selected.length) log.warn('group.none', { match: cfg.groupMatch, scanned: all.length });
  return selected;
}

// ---------------------------------------------------------------- polling
function isPdf(doc) {
  if (!doc) return false;
  return doc.mimetype === 'application/pdf' || /\.pdf$/i.test(doc.fileName || '') || /\.pdf$/i.test(doc.title || '');
}

async function pollGroup(group) {
  const { records } = await evo.findMessages(group.id, { pageSize: 30 });
  // Oldest first, so a brochure's job exists before the clip sent seconds after it is
  // handled. A record with no usable timestamp keeps the API's own order, reversed —
  // Evolution is newest-first — instead of the old `Number(x || 0)` comparator, which
  // collapsed to "whatever sort() felt like" and could hand the clip in before its PDF
  // (Codex review, 2026-09-06).
  const fresh = oldestFirst(records.filter((r) => r?.key?.id && !state.hasSeen(r.key.id)));
  for (const record of fresh) {
    if (!isFromOwner(record, cfg.ownerJid)) {
      state.markSeen(record.key.id);
      log.info('msg.ignored_not_owner', { jid: group.id, id: record.key.id, type: record.messageType });
      continue;
    }
    const doc = documentOf(record);
    if (isPdf(doc)) {
      // Durable FIRST, seen SECOND: a crash between the two replays the job, a crash the
      // other way round would lose the brochure silently.
      state.addJob({
        id: record.key.id,
        jid: group.id,
        key: record.key,
        caption: textOf(record) || doc.caption || '',
        fileName: doc.fileName ?? null,
        fileLength: fileLengthOf(doc),
        // WhatsApp send time — what a captionless clip is matched against (lib/video.mjs).
        // Poll time stands in when the record carries none: polls are 20 s apart, the
        // matching window is minutes.
        ts: messageTs(record) ?? Math.floor(Date.now() / 1000),
      });
      state.markSeen(record.key.id);
      enqueue({ kind: 'pdf', group, record, doc });
      continue;
    }
    // A video — see handleVideo(). Checked BEFORE the text-only fallthrough below so a clip
    // with no caption is still recognized instead of silently vanishing (the original bug:
    // caption-less media has no `text`, and `if (!text) continue;` was the only thing that
    // ever looked at it; four clips sent 2026-09-06 14:14 were lost exactly that way).
    const video = videoOf(record);
    if (video) {
      if (video.gifPlayback) {
        // An animated GIF arrives as a videoMessage too; it is never a walkthrough clip.
        state.markSeen(record.key.id);
        log.debug('video.gif_ignored', { jid: group.id, id: record.key.id });
        continue;
      }
      // Durable FIRST, seen SECOND — the same rule as a PDF. A clip usually lands seconds after
      // its brochure, while that brochure is still being published, and has to survive a
      // restart in between.
      state.addJob({
        id: record.key.id,
        jid: group.id,
        key: record.key,
        kind: 'video',
        ts: messageTs(record) ?? Math.floor(Date.now() / 1000),
        caption: textOf(record) || video.caption || '',
        fileLength: fileLengthOf(video),
      });
      state.markSeen(record.key.id);
      enqueue({ kind: 'video', group, record, video });
      continue;
    }
    state.markSeen(record.key.id);
    const text = textOf(record).trim();
    if (!text) continue;
    const command = parseCommand(text);
    if (command.cmd) enqueue({ kind: 'command', group, record, command });
    else log.debug('msg.no_command', { id: record.key.id });
  }
}

/** A queue entry rebuilt from a durable video job — a startup replay, or a clip parked behind its brochure. */
function videoJobFromState(job) {
  return {
    kind: 'video',
    group: { id: job.jid },
    record: {
      key: job.key || { id: job.id, fromMe: true, remoteJid: job.jid },
      messageTimestamp: job.ts ?? null,
      message: { videoMessage: { caption: job.caption || '' } },
    },
    video: { caption: job.caption || '', fileLength: job.fileLength ?? null },
    retryPath: job.videoPath && fs.existsSync(job.videoPath) ? job.videoPath : undefined,
    replay: true,
  };
}

/** Anything left `pending` in the state file is re-run when the daemon comes back. */
function replayPendingJobs() {
  const pending = state.pendingJobs();
  if (!pending.length) return;
  log.info('jobs.replay', { count: pending.length });
  for (const job of pending) {
    if (job.kind === 'video') { enqueue(videoJobFromState(job)); continue; }
    enqueue({
      kind: 'pdf',
      group: { id: job.jid },
      record: { key: job.key || { id: job.id, fromMe: true, remoteJid: job.jid }, message: { conversation: job.caption || '' } },
      doc: { mimetype: 'application/pdf', fileName: job.fileName ?? null },
      retryPath: job.pdfPath && fs.existsSync(job.pdfPath) ? job.pdfPath : undefined,
      replay: true,
    });
  }
}

/**
 * Clips parked behind a brochure that was still publishing (handleVideo → `wait`): back in
 * the queue once that brochure has answered, or once the wait has run out. Called on every
 * poll tick; a job already queued or in flight is left alone.
 */
function requeueWaitingVideos() {
  for (const job of state.pendingJobs()) {
    if (job.kind !== 'video' || !job.waitSince) continue; // a parked clip carries waitSince
    if (currentJobId === job.id || queue.some((q) => q.record?.key?.id === job.id)) continue;
    const w = wakeParkedClip(job, Object.values(state.raw.jobs || {}), { waitMs: cfg.videoWaitMin * 60 * 1000 });
    if (!w.wake) continue;
    // `wakeSeen`: the brochure jobs this clip has already been woken for, so one rejected PDF
    // cannot wake it again on every poll (lib/video.mjs wakeParkedClip).
    state.updateJob(job.id, { waitingFor: null, ...(w.seen ? { wakeSeen: w.seen } : {}) });
    log.info('video.requeue', { id: job.id, reason: w.reason, pdf: job.waitingFor ?? null });
    enqueue(videoJobFromState(job));
  }
}

// ---------------------------------------------------------------- queue
function enqueue(job) {
  queue.push(job);
  log.info('queue.push', { kind: job.kind, id: job.record?.key?.id, depth: queue.length });
  drain();
}

/** The job drain() is handling right now — so requeueWaitingVideos() never double-queues it. */
let currentJobId = null;

async function drain() {
  if (working || stopping) return;
  working = true;
  try {
    while (queue.length && !stopping) {
      const job = queue.shift();
      const jobId = job.record?.key?.id;
      currentJobId = jobId;
      try {
        if (job.kind === 'pdf') await handlePdf(job);
        else if (job.kind === 'video') await handleVideo(job);
        else await handleCommand(job);
        state.setError(null);
      } catch (err) {
        // `err.message` can carry git/build/model output. It goes to the journal only; the
        // group gets one generic line.
        log.error('job.failed', {
          kind: job.kind, id: jobId, error: err.message, detail: err.detail,
          rolledBack: Boolean(err.rolledBack), stack: process.env.BONA_DEBUG ? err.stack : undefined,
        });
        state.setError(err.message);
        if ((job.kind === 'pdf' || job.kind === 'video') && jobId) state.failJob(jobId, err.message);
        await reply(job.group.id, msg.failed());
      }
    }
  } finally {
    working = false;
    currentJobId = null;
  }
}

// ---------------------------------------------------------------- PDF job
async function handlePdf({ group, record, doc, retryPath }) {
  const jid = group.id;
  const messageId = record.key.id;
  const size = fileLengthOf(doc);
  if (size && size > cfg.maxPdfMb * 1024 * 1024) {
    state.finishJob(messageId, 'rejected');
    await reply(jid, msg.rejected(`the PDF is ${(size / 1048576).toFixed(1)} MB — the limit is ${cfg.maxPdfMb} MB`));
    return;
  }
  const caption = parseCaption(textOf(record) || doc.caption || '');
  await reply(jid, msg.READING);

  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(cfg.intakeDir, day);
  fs.mkdirSync(dir, { recursive: true });
  let pdfPath = retryPath;
  let media = { fileName: doc?.fileName ?? null };
  if (!pdfPath) {
    pdfPath = path.join(dir, `${messageId.replace(/[^A-Za-z0-9-]/g, '_')}.pdf`);
    media = await evo.downloadMedia(record.key);
    fs.writeFileSync(pdfPath, media.buffer);
    state.updateJob(messageId, { pdfPath });
    log.info('pdf.downloaded', { id: messageId, bytes: media.buffer.length, fileName: media.fileName });
  }

  // The duplicate guard runs on every pass, replay included. `retryPath` used to switch it
  // off, and `replayPendingJobs()` sets `retryPath` for any job whose PDF is still on disk
  // — so a crash after the push but before the job closed came back, skipped the check and
  // published the same brochure again. It answers with the live URL instead, once: closing
  // the job here takes it out of `pendingJobs()` for good.
  const sha = sha256File(pdfPath);
  const duplicate = state.duplicateGuard({ sha, messageId, dryRun: caption.dryRun });
  if (duplicate) {
    state.finishJob(messageId, duplicate.outcome);
    log.info('pdf.already_published', { id: messageId, outcome: duplicate.outcome, listing: duplicate.published.id, replay: Boolean(retryPath) });
    await reply(jid, msg.alreadyLive(duplicate.published));
    return;
  }

  state.raw.lastPdf = { messageId, jid, pdfPath, caption: caption.text, fileName: media.fileName };
  state.save();

  const workDir = path.join(dir, messageId.replace(/[^A-Za-z0-9-]/g, '_'));
  let report;
  try {
    // ONE lock around the whole repo phase — pull, write, rebuild, commit, push — so a
    // `run-once.mjs` can never be writing the clone while this pulls, and vice versa.
    report = await withLock(cfg.lockPath, async () => {
      // The clone must be clean AND up to date BEFORE the first byte is written: build.mjs
      // rewrites a tracked file, and `git rebase` will not run over unstaged changes. A dry
      // run touches neither the clone nor the remote, so it does not pull at all.
      if (!caption.dryRun) await prepareRepo();
      const r = await processPdf({
        pdfPath,
        cfg,
        caption,
        workDir,
        dryRun: caption.dryRun,
        meta: { messageId, groupJid: jid, pdfFileName: media.fileName || path.basename(pdfPath) },
      });
      if (r.dryRun) return r;
      try {
        r.push = await gitCommitPush(cfg.repo, `intake: ${r.listing.title.en} (${r.id})`, {
          remote: cfg.gitRemote, branch: cfg.gitBranch, paths: stagePaths(r.slug),
        });
      } catch (err) {
        const clean = await resetTree(cfg.repo, { dirs: [path.posix.join('public', 'listings', r.slug)] }).catch(() => false);
        log.error('git.push_failed', { error: err.message, detail: err.detail, clean });
        err.rolledBack = true;
        throw err;
      }
      // The commit is on the remote and cannot be taken back. Record the sha and close the
      // job in ONE write, still inside the lock and before a single word goes to WhatsApp:
      // from here on a crash must replay into the duplicate guard, not into a second push.
      state.completePublish({ sha, messageId, id: r.id, slug: r.slug, url: r.url });
      return r;
    }, { timeoutMs: cfg.lockWaitMs, label: `pdf ${messageId}` });
  } catch (err) {
    if (err instanceof RejectError) {
      // The repo knew about this PDF even though the state file did not (a lost state file,
      // or a `run-once.mjs` publish). Write what the repo already proves, so the next copy
      // of this brochure is answered from state without a pull.
      if (err.published) {
        log.warn('pdf.already_in_repo', { id: messageId, listing: err.published.id });
        state.completePublish({ sha, messageId, ...err.published });
        await reply(jid, msg.alreadyLive(err.published));
        return;
      }
      log.warn('pdf.rejected', { id: messageId, stage: err.stage, reason: err.reason });
      // A rejected PDF is never copied into the repo; drop the download too when the gate
      // says it is a private document.
      if (err.stage === 'classify' && !retryPath) fs.rmSync(pdfPath, { force: true });
      state.finishJob(messageId, 'rejected');
      await reply(jid, msg.rejected(err.reason));
      return;
    }
    // processPdf rolls back what it wrote; make sure of it even if it threw before it could.
    if (!caption.dryRun && !err.rolledBack) {
      const clean = await resetTree(cfg.repo).catch(() => false);
      log.warn('git.reset_after_failure', { clean });
    }
    throw err;
  }

  if (report.dryRun) {
    state.finishJob(messageId, 'dry-run');
    await reply(jid, msg.dryRunSummary(report));
    return;
  }

  // `state.completePublish()` already recorded the sha and closed the job, inside the lock.
  log.info('pdf.published', { id: report.id, slug: report.slug, sha: report.push.sha, images: report.listing.images.length, staged: report.push.staged?.length });

  // Reply NOW; the live check runs detached and only speaks up if the page never appears.
  await reply(jid, msg.published(report));
  watchLive(jid, report.url);
}

/** Detached: never block the worker on a GitHub Pages deploy. */
function watchLive(jid, url) {
  waitForLive(url, { timeoutMs: cfg.liveCheckMs })
    .then((live) => {
      log.info('live.check', { url, live });
      if (!live) return reply(jid, msg.notLive(url, Math.round(cfg.liveCheckMs / 60000)));
      return undefined;
    })
    .catch((err) => log.warn('live.check_failed', { url, error: err.message }));
}

// ---------------------------------------------------------------- video job
/**
 * A WhatsApp video. It never mints a listing; it attaches to one `handlePdf` (or
 * `run-once.mjs`) already published, through the same edit/commit/push path as
 * `hero <id>` / `price <id>` / `brochure <id>`.
 *
 * WHICH LISTING — the owner's rule is "it should know which video is for which property; I
 * shouldn't be picking anything", so three answers are tried, cheapest first:
 *   1. an id in the caption (`video BONA-W001`, or just the id) always wins;
 *   2. the burst rule: the brochure sent closest to the clip in time (lib/video.mjs
 *      pickListingForVideo) — he drops the PDF and its clips in one go, uncaptioned. If that
 *      brochure is still being published the clip is parked (`waitingFor`) and
 *      requeueWaitingVideos() brings it back; a tie between two listings asks instead of
 *      guessing;
 *   3. when that finds nothing at all (`kind: 'none'`), the CONTENT matcher
 *      (lib/video-match.mjs): frames of the clip itself, in front of one confined `claude -p`
 *      alongside the hero photos of the last ~15 intake listings. It attaches at
 *      `cfg.videoMatchConfidence` (0.75) or better and otherwise says it could not tell.
 *      Run at most ONCE per clip — `contentTried` on the durable job record — because it
 *      costs a model call, and a parked clip is re-queued every time a new brochure lands.
 *
 * WHAT IS STORED — not the file WhatsApp sent: ffmpeg re-encodes it (H.264/AAC, ≤1080p,
 * faststart) and cuts a poster frame out of it (lib/video.mjs prepareVideo), and a clip that
 * still will not fit `cfg.maxVideoMb` after a second, smaller pass is refused rather than
 * committed. The download happens once — a replay reuses `videoPath` the way a PDF replay
 * reuses `pdfPath` — and the video is never read into a Buffer: everything works on paths.
 */
async function handleVideo({ group, record, video, retryPath }) {
  const jid = group.id;
  const messageId = record.key.id;
  const caption = textOf(record) || video.caption || '';
  const job = state.getJob(messageId);

  // The declared size, checked BEFORE anything is downloaded (the content matcher below may
  // need the file long before a listing has been chosen).
  const declared = fileLengthOf(video);
  if (declared && declared > cfg.maxVideoInputMb * 1024 * 1024) {
    state.finishJob(messageId, 'rejected');
    log.warn('video.too_large', { id: messageId, size: declared });
    await reply(jid, msg.videoTooLarge(declared / 1048576, cfg.maxVideoInputMb));
    return;
  }

  const dayDir = () => {
    const dir = path.join(cfg.intakeDir, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const safeId = messageId.replace(/[^A-Za-z0-9-]/g, '_');
  let videoPath = retryPath && fs.existsSync(retryPath) ? retryPath : null;
  let announced = false;
  /** Downloaded once, kept next to the day's PDFs, so a replay after a crash never re-fetches it. */
  const ensureDownloaded = async () => {
    if (videoPath) return videoPath;
    if (!announced) { announced = true; await reply(jid, msg.READING_VIDEO); }
    const file = path.join(dayDir(), `${safeId}.mp4`);
    const media = await evo.downloadMedia(record.key);
    fs.writeFileSync(file, media.buffer);
    videoPath = file;
    state.updateJob(messageId, { videoPath });
    log.info('video.downloaded', { id: messageId, bytes: media.buffer.length });
    // The declared length can be absent or wrong; the bytes that actually arrived are the
    // real check.
    if (media.buffer.length > cfg.maxVideoInputMb * 1024 * 1024) {
      const err = new Error('video over the download limit');
      err.videoTooLarge = media.buffer.length;
      throw err;
    }
    return videoPath;
  };

  let id = findListingId(caption);
  let matched = null;
  let unsure = null;
  if (!id) {
    // Send time: the record's, else what the job recorded at poll time, else when the job was
    // written — a clip never fails to match just because one field was missing.
    const ts = messageTs(record) ?? job?.ts ?? (job?.at ? Math.round(Date.parse(job.at) / 1000) : null);
    const pick = pickListingForVideo({ ts, jid }, Object.values(state.raw.jobs || {}), state.publishedByMessage, { windowSec: cfg.videoWindowMin * 60 });

    if (pick.kind === 'ambiguous') {
      state.finishJob(messageId, 'rejected');
      log.info('video.ambiguous', { id: messageId, listings: pick.listingIds });
      await reply(jid, msg.videoAmbiguous(pick.listingIds));
      return;
    }
    if (pick.kind === 'attach') {
      id = pick.listingId;
      matched = { by: 'burst', pdfMessageId: pick.pdfMessageId, deltaSec: pick.deltaSec };
      log.info('video.matched', { id: messageId, listing: id, pdf: pick.pdfMessageId, deltaSec: pick.deltaSec });
    } else if (pick.kind === 'none' && !job?.contentTried) {
      // No brochure anywhere near this clip: look at the clip itself. ONE call per clip.
      const candidates = candidateListings(cfg.repo, { limit: cfg.videoMatchListings });
      if (candidates.length) {
        try {
          await ensureDownloaded();
          // Written before the call, not after: a crash inside the model call must not buy
          // this clip a second one on the replay.
          state.updateJob(messageId, { contentTried: true });
          const verdict = await matchVideoToListing({
            videoPath,
            workDir: path.join(dayDir(), `${safeId}-match`),
            candidates,
            cfg,
            logger: log,
          });
          log.info('video.content_match', {
            id: messageId, kind: verdict.kind, listing: verdict.listingId ?? null,
            confidence: verdict.confidence ?? null, frames: verdict.frames,
            candidates: verdict.candidates.length, why: verdict.why ?? null,
            reason: verdict.reason ?? null, costUsd: verdict.meta?.costUsd ?? null,
          });
          if (verdict.kind === 'match') {
            id = verdict.listingId;
            matched = { by: 'content', confidence: verdict.confidence, reason: verdict.reason };
          } else if (verdict.kind === 'ambiguous') {
            unsure = verdict;
            // Kept on the job, because the clip is usually PARKED after this and only asks
            // about itself when the wait runs out, several requeues later — by which time
            // this verdict would otherwise be gone and the reply would name nothing.
            state.updateJob(messageId, { contentSaw: { listingId: verdict.listingId ?? null, confidence: verdict.confidence ?? 0, candidates: verdict.candidates } });
          }
        } catch (err) {
          if (err.videoTooLarge) {
            state.finishJob(messageId, 'rejected');
            log.warn('video.too_large', { id: messageId, bytes: err.videoTooLarge });
            await reply(jid, msg.videoTooLarge(err.videoTooLarge / 1048576, cfg.maxVideoInputMb));
            return;
          }
          log.warn('video.content_match_failed', { id: messageId, error: err.message });
        }
      }
    }

    if (!id) {
      // Park the clip rather than reject it while its brochure may still be coming: the nearest
      // brochure is mid-publish (`wait`), or nothing matched yet but the clip is fresh (`none` —
      // the owner sent the video first, or the PDF lands in the next poll). requeueWaitingVideos()
      // brings it back when that brochure answers, a new one appears, or the wait runs out.
      const freshClip = ts != null && Math.floor(Date.now() / 1000) - ts <= cfg.videoWindowMin * 60;
      if (job && (pick.kind === 'wait' || (pick.kind === 'none' && freshClip))) {
        const since = job.waitSince || new Date().toISOString();
        const waitedMs = Date.now() - Date.parse(since);
        if (waitedMs <= cfg.videoWaitMin * 60 * 1000) {
          const waitingFor = pick.kind === 'wait' ? pick.pdfMessageId : null;
          state.updateJob(messageId, { waitingFor, waitSince: since });
          log.info('video.waiting', { id: messageId, pdf: waitingFor, waitedMs });
          if (!job.waitNotified) {
            state.updateJob(messageId, { waitNotified: true });
            await reply(jid, msg.videoWaiting(waitingFor ? state.getJob(waitingFor)?.fileName : null));
          }
          return;
        }
        log.warn('video.wait_expired', { id: messageId, pdf: pick.pdfMessageId ?? null, waitedMs });
      }
      state.finishJob(messageId, 'rejected');
      // Exactly ONE line back, and never a guess: if the matcher looked at the clip and could
      // not place it, say so and name what it compared against; otherwise the plain ask.
      const saw = unsure || state.getJob(messageId)?.contentSaw;
      if (saw) {
        log.info('video.unsure', { jid, id: messageId, listing: saw.listingId ?? null, confidence: saw.confidence ?? null, why: unsure?.why ?? null });
        // Its best guess first (it was under the bar, so it is a suggestion, not a choice),
        // then everything else it compared against.
        const others = (saw.candidates || []).filter((c) => c !== saw.listingId);
        await reply(jid, msg.videoUnsure(saw.listingId ? [saw.listingId, ...others] : others));
      } else {
        log.info('video.no_id', { jid, id: messageId, caption });
        await reply(jid, msg.videoNoId());
      }
      return;
    }
  }
  const found = edits.locate(cfg.repo, id);
  if (!found) {
    state.finishJob(messageId, 'rejected');
    log.info('video.not_found', { jid, id });
    await reply(jid, msg.notFound(id));
    return;
  }
  try {
    await ensureDownloaded();
  } catch (err) {
    if (!err.videoTooLarge) throw err;
    state.finishJob(messageId, 'rejected');
    log.warn('video.too_large', { id, bytes: err.videoTooLarge });
    await reply(jid, msg.videoTooLarge(err.videoTooLarge / 1048576, cfg.maxVideoInputMb));
    return;
  }

  // What goes into the repo is the TRANSCODED clip and its poster, never the raw download.
  const mediaDir = path.join(dayDir(), `${safeId}-video`);
  const prepared = await prepareVideo({ input: videoPath, outDir: mediaDir, cfg, logger: log });
  if (!prepared.ok) {
    state.finishJob(messageId, 'rejected');
    log.warn('video.prepare_failed', { id, reason: prepared.reason, bytes: prepared.bytes ?? null, error: prepared.error ?? null });
    await reply(jid, prepared.reason === 'too-large'
      ? msg.videoStillTooLarge(prepared.bytes / 1048576, cfg.maxVideoMb)
      : msg.videoUnreadable());
    return;
  }
  log.info('video.prepared', { id, bytes: prepared.bytes, width: prepared.width, height: prepared.height, durationSec: prepared.durationSec, poster: Boolean(prepared.poster), passes: prepared.passes.length });

  const res = await publishEdit(
    jid, id,
    () => edits.addVideo(cfg.repo, id, { file: prepared.file, poster: prepared.poster }),
    () => `intake: video (${id})`,
    (r) => msg.videoAdded(id, r.listing, r.video, { matched }),
    // Close the job the instant the push lands, inside the lock, before any reply. A crash
    // after the push but before this replays the clip; addVideo() then finds the identical
    // bytes already on the listing and answers `duplicate` instead of appending a second copy.
    { onPushed: (r) => state.completeVideo({ messageId, id, src: r.video?.src }) },
  );
  // The transcoded copy now lives in the repo; the raw download stays for a replay.
  fs.rmSync(prepared.file, { force: true });
  if (res?.error) {
    state.finishJob(messageId, 'rejected');
    log.warn('video.rejected', { id, error: res.error });
    await reply(jid, `✋ ${res.error}`);
    return;
  }
  if (res?.duplicate) {
    state.completeVideo({ messageId, id, src: res.video?.src });
    log.info('video.already_on_listing', { id, messageId, src: res.video?.src });
    await reply(jid, msg.videoAlreadyOn(id, res.listing, res.video));
    return;
  }
  if (res) log.info('video.added', { id, messageId, bytes: res.video?.bytes, n: res.video?.n, poster: res.video?.poster ?? null, matched: matched?.by ?? null });
}

// ---------------------------------------------------------------- command job
/**
 * Every edit follows the same order as a publish: clean tree, pull, edit, rebuild, push —
 * and on any failure the clone is restored, because the next job has to be able to pull.
 */
async function publishEdit(jid, id, apply, commitMessage, replyText, { onPushed = null } = {}) {
  return withLock(cfg.lockPath, async () => {
    await prepareRepo();
    let res;
    try {
      // `await`: most edits are synchronous file writes, but `brochure <id>` shells out to
      // rebrand_pdf.py and must finish before the rebuild and the commit.
      res = await apply();
      // `duplicate`: the edit found its work already done (a replayed video) — nothing to commit.
      if (!res || res.error || res.duplicate) return res;
      await rebuild(cfg.repo);
      await gitCommitPush(cfg.repo, commitMessage(res), {
        remote: cfg.gitRemote, branch: cfg.gitBranch, paths: stagePaths(res.listing.slug),
      });
      // The commit is on the remote and cannot be taken back: durable bookkeeping goes HERE,
      // inside the lock and before a word reaches the group — the same rule handlePdf follows
      // with completePublish(). A reply can be retried; a second commit cannot be undone.
      if (onPushed) await onPushed(res);
    } catch (err) {
      const clean = await resetTree(cfg.repo).catch(() => false);
      log.error('edit.rolled_back', { id, clean, error: err.message, detail: err.detail });
      err.rolledBack = true;
      throw err;
    }
    await reply(jid, replyText(res));
    return res;
  }, { timeoutMs: cfg.lockWaitMs, label: `command ${id}` });
}

async function handleCommand({ group, command }) {
  const jid = group.id;
  switch (command.cmd) {
    case 'help':
      return reply(jid, HELP_TEXT);
    case 'error':
      return reply(jid, `✋ ${command.message}`);
    case 'status':
      return reply(jid, msg.statusReport({
        listings: listInbox(cfg.repo).map((x) => x.listing),
        groups,
        lastError: state.raw.lastError,
        queueLength: queue.length,
      }));
    case 'retry': {
      const last = state.raw.lastPdf;
      if (!last || !fs.existsSync(last.pdfPath)) return reply(jid, '✋ Nothing to retry — send the PDF again.');
      const id = `${last.messageId}-retry-${Date.now()}`;
      state.addJob({ id, jid, caption: last.caption || '', fileName: last.fileName, pdfPath: last.pdfPath });
      enqueue({
        kind: 'pdf',
        group,
        record: { key: { id, fromMe: true }, message: { conversation: last.caption || '' } },
        doc: { mimetype: 'application/pdf', fileName: last.fileName },
        retryPath: last.pdfPath,
      });
      return reply(jid, 'Retrying the last brochure…');
    }
    case 'remove': {
      const found = edits.locate(cfg.repo, command.id);
      if (!found) return reply(jid, msg.notFound(command.id));
      const res = await publishEdit(
        jid, command.id,
        () => ({ listing: edits.removeListing(cfg.repo, command.id) }),
        (r) => `intake: remove ${r.listing.title.en} (${command.id})`,
        (r) => msg.removed(command.id, r.listing.title.en),
      );
      if (res) state.forgetPublished((info) => info.id === command.id);
      return undefined;
    }
    case 'hero': {
      const found = edits.locate(cfg.repo, command.id);
      if (!found) return reply(jid, msg.notFound(command.id));
      const res = await publishEdit(
        jid, command.id,
        () => edits.setHero(cfg.repo, command.id, command.index),
        () => `intake: cover photo ${command.index} (${command.id})`,
        (r) => msg.updated(command.id, `Cover is now photo ${command.index}`, r.listing),
      );
      if (res?.error) return reply(jid, `✋ ${res.error}`);
      return undefined;
    }
    case 'price': {
      const found = edits.locate(cfg.repo, command.id);
      if (!found) return reply(jid, msg.notFound(command.id));
      const res = await publishEdit(
        jid, command.id,
        () => edits.setPrice(cfg.repo, command.id, command),
        () => `intake: price (${command.id})`,
        (r) => msg.updated(command.id, command.onRequest ? 'Price on request' : `Price set to ${r.listing.price.currency} ${r.listing.price.amount.toLocaleString('en-US')}`, r.listing),
      );
      if (res?.error) return reply(jid, `✋ ${res.error}`);
      return undefined;
    }
    case 'brochure': {
      const found = edits.locate(cfg.repo, command.id);
      if (!found) return reply(jid, msg.notFound(command.id));
      const workDir = path.join(cfg.intakeDir, 'brochure', `${command.id}-${Date.now()}`);
      const res = await publishEdit(
        jid, command.id,
        () => edits.rebuildBrochure(cfg.repo, command.id, { cfg, workDir }),
        () => `intake: branded brochure (${command.id})`,
        (r) => msg.brochureRebuilt(command.id, r.listing, r.brochure),
      );
      if (res?.error) return reply(jid, `✋ ${res.error}`);
      return undefined;
    }
    case 'status-set': {
      const found = edits.locate(cfg.repo, command.id);
      if (!found) return reply(jid, msg.notFound(command.id));
      const res = await publishEdit(
        jid, command.id,
        () => edits.setStatus(cfg.repo, command.id, command.status),
        () => `intake: ${command.status} (${command.id})`,
        (r) => msg.updated(command.id, `Marked ${command.status}`, r.listing),
      );
      if (res?.error) return reply(jid, `✋ ${res.error}`);
      return undefined;
    }
    case 'hidden-set': {
      const found = edits.locate(cfg.repo, command.id);
      if (!found) return reply(jid, msg.notFound(command.id));
      const res = await publishEdit(
        jid, command.id,
        () => edits.setHidden(cfg.repo, command.id, command.hidden),
        () => `intake: ${command.hidden ? 'hide' : 'show'} (${command.id})`,
        (r) => msg.updated(command.id, command.hidden ? 'Hidden from the site' : 'Published to the site', r.listing),
      );
      if (res?.error) return reply(jid, `✋ ${res.error}`);
      return undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- main
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('stopping', { signal, queued: queue.length, working });
  // NEVER process.exit() in the middle of a git push or a sharp encode. The unit gives us
  // TimeoutStopSec=45; wait 40 s for the in-flight job, then go.
  const idle = await waitForIdle(() => working, { timeoutMs: STOP_GRACE_MS });
  log.info('stopped', { signal, idle, queued: queue.length });
  process.exit(0);
}

async function main() {
  const missing = missingRequired(cfg);
  if (missing.length) {
    log.error('config.missing', { missing, hint: 'put them in ~/.secrets/bona-services.env or ~/.secrets/evolution-api.env' });
    process.exit(1);
  }
  if (!fs.existsSync(path.join(cfg.repo, 'scripts', 'curate', 'build.mjs'))) {
    log.error('config.bad_repo', { repo: cfg.repo, hint: 'BONA_REPO must be a clone of the Bona site repo' });
    process.exit(1);
  }
  log.info('start', {
    instance: cfg.instance, repo: cfg.repo, data: cfg.data, site: cfg.site,
    pollMs: cfg.pollMs, groupScanMs: cfg.groupScanMs, match: cfg.groupMatch, model: cfg.claudeModel,
  });
  try {
    const st = await evo.connectionState();
    log.info('wa.state', { state: st?.instance?.state ?? st?.state ?? 'unknown' });
  } catch (err) {
    log.warn('wa.state_failed', { error: err.message });
  }

  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { shutdown(sig); });

  replayPendingJobs();

  let lastScan = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastScan >= cfg.groupScanMs) { await discoverGroups(); lastScan = Date.now(); }
      for (const g of groups) await pollGroup(g);
      requeueWaitingVideos();
    } catch (err) {
      log.error('poll.failed', { error: err.message });
      state.setError(err.message);
    }
    for (let waited = 0; waited < cfg.pollMs && !stopping; waited += 500) await sleep(Math.min(500, cfg.pollMs - waited));
  }
}

main().catch((err) => { log.error('fatal', { error: err.message, stack: err.stack }); process.exit(1); });
