#!/usr/bin/env node
// bona-intake — the daemon.
//
// Polls the owner's OWN WhatsApp (Evolution API, instance `abdulaziz-personal`) for PDFs he
// drops into any group whose subject matches BONA_WA_GROUP_MATCH, turns each brochure into a
// listing in the Bona repo, pushes, and replies in the group.
//
// READ-ONLY on the instance apart from `sendText`. It never configures a webhook, websocket
// or RabbitMQ binding — another agent consumes this instance's events and a webhook here
// would steal them.
//
// One job at a time (a single worker over a FIFO queue): the AI step and the git push must
// never interleave.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, missingRequired } from './lib/env.mjs';
import { createEvolutionClient, documentOf, fileLengthOf, isFromOwner, textOf } from './lib/evolution.mjs';
import { HELP_TEXT, parseCaption, parseCommand } from './lib/commands.mjs';
import * as edits from './lib/edits.mjs';
import { listInbox } from './lib/listing.mjs';
import { log } from './lib/log.mjs';
import * as msg from './lib/messages.mjs';
import { processPdf, RejectError, sha256File } from './lib/pipeline.mjs';
import { gitCommitPush, gitPull, rebuild, waitForLive } from './lib/publish.mjs';
import { createState } from './lib/state.mjs';

const cfg = loadConfig();
const state = createState(cfg.statePath);
const evo = createEvolutionClient({ baseUrl: cfg.evolutionUrl, apiKey: cfg.evolutionKey, instance: cfg.instance });

let groups = [];          // [{ id, subject }]
let stopping = false;
const queue = [];
let working = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reply(jid, text) {
  if (!cfg.sendReplies) { log.info('wa.reply_suppressed', { to: jid, text }); return; }
  try { await evo.sendText(jid, text); } catch (err) { log.error('wa.reply_failed', { to: jid, error: err.message }); }
}

// ---------------------------------------------------------------- group discovery
async function discoverGroups() {
  const re = new RegExp(cfg.groupMatch, 'i');
  const all = await evo.fetchAllGroups();
  const selected = all.filter((g) => re.test(g.subject) || cfg.groupJids.includes(g.id));
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
    state.markSeen(record.key.id);
    if (!isFromOwner(record, cfg.ownerJid)) {
      log.info('msg.ignored_not_owner', { jid: group.id, id: record.key.id, type: record.messageType });
      continue;
    }
    const doc = documentOf(record);
    if (isPdf(doc)) {
      enqueue({ kind: 'pdf', group, record, doc });
      continue;
    }
    const text = textOf(record).trim();
    if (!text) continue;
    const command = parseCommand(text);
    if (command.cmd) enqueue({ kind: 'command', group, record, command });
    else log.debug('msg.no_command', { id: record.key.id });
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
      try {
        if (job.kind === 'pdf') await handlePdf(job);
        else await handleCommand(job);
        state.setError(null);
      } catch (err) {
        log.error('job.failed', { kind: job.kind, error: err.message, stack: process.env.BONA_DEBUG ? err.stack : undefined });
        state.setError(err.message);
        await reply(job.group.id, msg.failed(err.message.slice(0, 300)));
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
    pdfPath = path.join(dir, `${messageId}.pdf`);
    media = await evo.downloadMedia(record.key);
    fs.writeFileSync(pdfPath, media.buffer);
    log.info('pdf.downloaded', { id: messageId, bytes: media.buffer.length, fileName: media.fileName });
  }

  const sha = sha256File(pdfPath);
  const already = state.publishedFor(sha);
  if (already && !caption.dryRun && !retryPath) {
    await reply(jid, msg.alreadyLive(already));
    return;
  }

  state.raw.lastPdf = { messageId, jid, pdfPath, caption: caption.text, fileName: media.fileName };
  state.save();

  const workDir = path.join(dir, messageId.replace(/[^A-Za-z0-9-]/g, '_'));
  let report;
  try {
    report = await processPdf({
      pdfPath,
      cfg,
      caption,
      workDir,
      dryRun: caption.dryRun,
      meta: { messageId, groupJid: jid, pdfFileName: media.fileName || path.basename(pdfPath) },
    });
  } catch (err) {
    if (err instanceof RejectError) {
      log.warn('pdf.rejected', { id: messageId, stage: err.stage, reason: err.reason });
      // A rejected PDF is never copied into the repo; drop the download too when the gate
      // says it is a private document.
      if (err.stage === 'classify' && !retryPath) fs.rmSync(pdfPath, { force: true });
      await reply(jid, msg.rejected(err.reason));
      return;
    }
    throw err;
  }

  if (report.dryRun) {
    await reply(jid, msg.dryRunSummary(report));
    return;
  }

  await gitPull(cfg.repo, { remote: cfg.gitRemote, branch: cfg.gitBranch });
  await rebuild(cfg.repo); // the pull may have brought new curated listings
  report.push = await gitCommitPush(cfg.repo, `intake: ${report.listing.title.en} (${report.id})`, { remote: cfg.gitRemote, branch: cfg.gitBranch });
  state.recordPublished(sha, { id: report.id, slug: report.slug, url: report.url });
  log.info('pdf.published', { id: report.id, slug: report.slug, sha: report.push.sha, images: report.listing.images.length });

  const live = await waitForLive(report.url, { timeoutMs: cfg.liveCheckMs });
  await reply(jid, msg.published(report, { live }));
}

// ---------------------------------------------------------------- command job
async function publishEdit(jid, id, listing, what) {
  await gitPull(cfg.repo, { remote: cfg.gitRemote, branch: cfg.gitBranch });
  await rebuild(cfg.repo);
  await gitCommitPush(cfg.repo, `intake: ${what.toLowerCase()} (${id})`, { remote: cfg.gitRemote, branch: cfg.gitBranch });
  await reply(jid, msg.updated(id, what, listing));
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
      enqueue({
        kind: 'pdf',
        group,
        record: { key: { id: `${last.messageId}-retry-${Date.now()}`, fromMe: true }, message: { conversation: last.caption || '' } },
        doc: { mimetype: 'application/pdf', fileName: last.fileName },
        retryPath: last.pdfPath,
      });
      return reply(jid, 'Retrying the last brochure…');
    }
    case 'remove': {
      const listing = edits.removeListing(cfg.repo, command.id);
      if (!listing) return reply(jid, msg.notFound(command.id));
      state.forgetPublished((info) => info.id === command.id);
      await gitPull(cfg.repo, { remote: cfg.gitRemote, branch: cfg.gitBranch });
      await rebuild(cfg.repo);
      await gitCommitPush(cfg.repo, `intake: remove ${listing.title.en} (${command.id})`, { remote: cfg.gitRemote, branch: cfg.gitBranch });
      return reply(jid, msg.removed(command.id, listing.title.en));
    }
    case 'hero': {
      const res = edits.setHero(cfg.repo, command.id, command.index);
      if (!res) return reply(jid, msg.notFound(command.id));
      if (res.error) return reply(jid, `✋ ${res.error}`);
      return publishEdit(jid, command.id, res.listing, `Cover is now photo ${command.index}`);
    }
    case 'price': {
      const res = edits.setPrice(cfg.repo, command.id, command);
      if (!res) return reply(jid, msg.notFound(command.id));
      return publishEdit(jid, command.id, res.listing, command.onRequest ? 'Price on request' : `Price set to ${res.listing.price.currency} ${res.listing.price.amount.toLocaleString('en-US')}`);
    }
    case 'status-set': {
      const res = edits.setStatus(cfg.repo, command.id, command.status);
      if (!res) return reply(jid, msg.notFound(command.id));
      if (res.error) return reply(jid, `✋ ${res.error}`);
      return publishEdit(jid, command.id, res.listing, `Marked ${command.status}`);
    }
    case 'hidden-set': {
      const res = edits.setHidden(cfg.repo, command.id, command.hidden);
      if (!res) return reply(jid, msg.notFound(command.id));
      return publishEdit(jid, command.id, res.listing, command.hidden ? 'Hidden from the site' : 'Published to the site');
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- main
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

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { log.info('stopping', { signal: sig, queued: queue.length }); stopping = true; setTimeout(() => process.exit(0), 2000); });
  }

  let lastScan = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastScan >= cfg.groupScanMs) { await discoverGroups(); lastScan = Date.now(); }
      for (const g of groups) await pollGroup(g);
    } catch (err) {
      log.error('poll.failed', { error: err.message });
      state.setError(err.message);
    }
    await sleep(cfg.pollMs);
  }
}

main().catch((err) => { log.error('fatal', { error: err.message, stack: err.stack }); process.exit(1); });
