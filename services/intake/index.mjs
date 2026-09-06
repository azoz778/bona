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
import { createEvolutionClient, documentOf, fileLengthOf, isFromOwner, isOwnerGroup, textOf } from './lib/evolution.mjs';
import { HELP_TEXT, parseCaption, parseCommand } from './lib/commands.mjs';
import * as edits from './lib/edits.mjs';
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
  const fresh = records
    .filter((r) => r?.key?.id && !state.hasSeen(r.key.id))
    .sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
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
      });
      state.markSeen(record.key.id);
      enqueue({ kind: 'pdf', group, record, doc });
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

/** Anything left `pending` in the state file is re-run when the daemon comes back. */
function replayPendingJobs() {
  const pending = state.pendingJobs();
  if (!pending.length) return;
  log.info('jobs.replay', { count: pending.length });
  for (const job of pending) {
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

// ---------------------------------------------------------------- queue
function enqueue(job) {
  queue.push(job);
  log.info('queue.push', { kind: job.kind, id: job.record?.key?.id, depth: queue.length });
  drain();
}

async function drain() {
  if (working || stopping) return;
  working = true;
  try {
    while (queue.length && !stopping) {
      const job = queue.shift();
      const jobId = job.record?.key?.id;
      try {
        if (job.kind === 'pdf') await handlePdf(job);
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
        if (job.kind === 'pdf' && jobId) state.failJob(jobId, err.message);
        await reply(job.group.id, msg.failed());
      }
    }
  } finally {
    working = false;
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

// ---------------------------------------------------------------- command job
/**
 * Every edit follows the same order as a publish: clean tree, pull, edit, rebuild, push —
 * and on any failure the clone is restored, because the next job has to be able to pull.
 */
async function publishEdit(jid, id, apply, commitMessage, replyText) {
  return withLock(cfg.lockPath, async () => {
    await prepareRepo();
    let res;
    try {
      res = apply();
      if (!res || res.error) return res;
      await rebuild(cfg.repo);
      await gitCommitPush(cfg.repo, commitMessage(res), {
        remote: cfg.gitRemote, branch: cfg.gitBranch, paths: stagePaths(res.listing.slug),
      });
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
    } catch (err) {
      log.error('poll.failed', { error: err.message });
      state.setError(err.message);
    }
    for (let waited = 0; waited < cfg.pollMs && !stopping; waited += 500) await sleep(Math.min(500, cfg.pollMs - waited));
  }
}

main().catch((err) => { log.error('fatal', { error: err.message, stack: err.stack }); process.exit(1); });
