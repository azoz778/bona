#!/usr/bin/env node
// Daily TikTok / LinkedIn publisher, through the shared logged-in Windows Chrome (CDP :9222).
//
//   node scripts/social/browser-publish.mjs tiktok   [--dry-run] [--any-time] [--kind property|education] [--shots DIR] [--render-only]
//   node scripts/social/browser-publish.mjs linkedin [--dry-run] ...
//
// Why the browser: TikTok's Content Posting API posts private-only until an app audit, and
// LinkedIn's posting API needs partner approval, so the owner approved posting through the
// browser that is already logged in to both accounts (2026-10-20). docs/browser-publishing.md.
//
// One post per channel per Riyadh day. The ledger <dataDir>/<channel>/published.jsonl is the
// record: `intent` is written immediately before Post is clicked; `published` (with the post URL)
// once the new post is seen on the account; `uncertain` when the click went through but the post
// could not be confirmed — that blocks the channel until a human appends `confirmed-not-published`
// or `published` (same rule as the Instagram/Facebook journal). A failure before the click is
// `confirmed-not-published` and the next timer tick retries.
//
// --dry-run goes all the way: renders the media, opens our own tab, uploads, fills the caption,
// screenshots the filled form, then DISCARDS the draft. It writes nothing to the ledger.
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROOT, ksaNow } from './lib/daily-pack.mjs';
import { dataDir } from './lib/ledger.mjs';
import { fingerprint, eligibility, policyRules } from './lib/property-daily.mjs';
import { catalogue, photos as downloadReviewedPhotos } from './property-publish.mjs';
import {
  CHANNELS, acquireLock, appendRecord, assertRenderable, captionFor, channelState, chooseToday, educationPool, entryId, inWindow,
  ledgerPath, lockPath, readLedgerStrict, reelLicenceLines, REPAIR_REASON, renderedStrings,
} from './lib/browser-daily.mjs';

// IPv6 to Cloudflare from this WSL host resets ~1 in 4 connections (ops/systemd ipv4first drop-in);
// a hand run gets the same preference as the unit.
dns.setDefaultResultOrder('ipv4first');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
/**
 * What must be undone if the process is told to stop (systemctl stop, the unit's timeout, Ctrl-C):
 * close our tab, remove the staged copies, release the lock. An intent already written stays, so
 * the next run treats the day as uncertain instead of posting twice.
 */
export const cleanups = new Set();
export async function runCleanups() { for (const f of [...cleanups].reverse()) { try { await f(); } catch { /* best effort */ } cleanups.delete(f); } }
const redact = s => String(s?.message ?? s).replace(/EAA[A-Za-z0-9]+/g, '[redacted]').slice(0, 800);

/** The real browser + media implementations; tests replace them. */
export async function defaultDeps() {
  const cdp = await import('./lib/cdp.mjs');
  const sites = await import('./lib/browser-sites.mjs');
  const media = await import('./lib/browser-media.mjs');
  const { FAL } = await import('./lib/listing.mjs');
  return { cdp, sites, media, fal: FAL, catalogue, downloadReviewedPhotos };
}

/** Render this channel's own media for the choice. Returns local file paths. */
async function renderMedia(channel, choice, dir, deps, advertiser) {
  fs.mkdirSync(dir, { recursive: true });
  const { media } = deps;
  if (choice.kind === 'property') {
    // The approved frames in this post's order (a repeat gets another cover and order; TikTok re-renders the reel from it).
    // The media host resets ~1 in 4 connections from this box; a network failure is retried, a hash mismatch is not.
    let frames;
    for (let attempt = 1; ; attempt++) {
      try { frames = await deps.downloadReviewedPhotos(choice.frames ?? choice.review, dir, false, deps.fetchImpl ?? fetch); break; }
      catch (e) { if (attempt >= 3 || /changed since visual review/.test(e.message)) throw e; await new Promise(r => setTimeout(r, 2000 * attempt)); }
    }
    if (channel === 'tiktok') return [media.propertyReel(choice.listing, frames, reelLicenceLines(choice.listing, advertiser), path.join(dir, `tiktok-${choice.listing.id}.mp4`))];
    return media.linkedinPropertyImages(frames, path.join(dir, 'linkedin'));
  }
  if (channel === 'tiktok') return [await media.educationReel(choice.item, path.join(dir, `tiktok-${choice.item.id}.mp4`))];
  return media.linkedinEducationImages(choice.item, path.join(dir, 'linkedin'));
}

/** Drive the page. `commit(stage)` is called right before the irreversible click and must record intent. */
async function drive(channel, s, winFiles, caption, { dry, shots, date, commit, sites, evidence }) {
  const c = CHANNELS[channel];
  const shot = async name => { try { return await s.screenshot(path.join(shots, `${date}-${channel}-${name}.png`)); } catch { return null; } };
  let before;
  try {
    before = channel === 'tiktok' ? await sites.tiktokSession(s, c.handle) : await sites.linkedinSession(s, c.companyId);
    if (channel === 'tiktok') await sites.tiktokFill(s, winFiles[0], caption);
    else await sites.linkedinFill(s, winFiles, caption, { pageName: c.pageName, companyId: c.companyId });
  } catch (e) {
    await shot('failed-before-post');
    // Leave no half-filled draft behind for the next run (or a human) to trip over.
    try { if (channel === 'tiktok') await sites.tiktokDiscard(s); else await sites.linkedinDiscard(s); } catch { /* nothing open */ }
    throw Object.assign(e, { beforeClick: true });
  }
  const filled = await shot('filled');
  // A second look further down: the attached media and the Post button.
  await s.ev(channel === 'tiktok'
    ? `(() => { document.querySelectorAll('*').forEach(e => { if (e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== 'visible') e.scrollTop = e.scrollHeight; }); window.scrollTo(0, document.body.scrollHeight); })()`
    : `document.querySelectorAll('.share-box-v2__modal *').forEach(e => { if (e.scrollHeight > e.clientHeight + 40) e.scrollTop = e.scrollHeight; })`).catch(() => null);
  const filledBelow = await shot('filled-below');
  if (dry) {
    // The exact pre-click checks a live run makes (account / Page actor, caption box), then discard.
    let preClick = 'passed';
    try { if (channel === 'tiktok') await sites.tiktokPreClick?.(s, { handle: c.handle, caption }); else await sites.linkedinPreClick?.(s, { companyId: c.companyId, pageName: c.pageName, caption }); }
    catch (e) { preClick = `FAILED: ${e.message}`; }
    const discarded = channel === 'tiktok' ? await sites.tiktokDiscard(s) : await sites.linkedinDiscard(s);
    const after = await shot('discarded');
    return { status: 'dry-run-filled', screenshots: [filled, filledBelow, after].filter(Boolean), discarded, preClick, existing: before.length };
  }
  const go = await commit();
  if (go !== true) {
    if (channel === 'tiktok') await sites.tiktokDiscard(s); else await sites.linkedinDiscard(s);
    return { status: 'not-due', reason: go };
  }
  let signal;
  // The adapters re-check the account / Page actor and the caption box immediately before the click.
  try { signal = channel === 'tiktok' ? await sites.tiktokPost(s, { handle: c.handle, caption }) : await sites.linkedinPost(s, { companyId: c.companyId, pageName: c.pageName, caption }); }
  catch (e) { await shot('post-click-failed'); throw e; } // e.beforeClick is set by the adapter only when no click was dispatched
  await shot('after-post');
  const url = channel === 'tiktok'
    ? await sites.tiktokConfirm(s, c.handle, before, { caption, evidence })
    : await sites.linkedinConfirm(s, c.companyId, before, { toast: signal, caption, evidence });
  await shot('confirm');
  return { status: url ? 'published' : 'unconfirmed', url, signal };
}

export async function run(channel, opts = {}, deps = null) {
  const { dry = false, anyTime = false, kind = null, shots: shotsOpt = null, renderOnly = false,
    env = process.env, now = new Date(), clock = () => new Date(), root = ROOT, log = console.log } = opts;
  if (!CHANNELS[channel]) throw new Error('Choose tiktok or linkedin');
  deps ??= await defaultDeps();
  const data = dataDir(env), ledger = ledgerPath(data, channel);
  const { date } = ksaNow(now);
  const shots = shotsOpt ?? path.join(data, channel, 'shots');
  const win = inWindow(channel, now);
  if (!win.ok && !anyTime) { log(`${channel}: ${win.why}; nothing to do`); return { status: 'not-due' }; }

  const operation = async () => {
    const { rows: events, truncated } = readLedgerStrict(ledger);
    if (truncated) {
      // A crash mid-write: the last record is cut off. Newline-terminate it (appendRecord does) and
      // mark today uncertain; a human decides what that record was.
      if (!dry) appendRecord(ledger, { channel, date, id: entryId(channel, date), status: 'uncertain', reason: REPAIR_REASON });
      throw Object.assign(new Error(`${channel}: ${ledger} ended in a truncated record; recorded uncertain — check the account and settle it (docs/browser-publishing.md)`), { uncertain: true });
    }
    const state = channelState(events, channel, date);
    if (state === 'published') { log(`${channel}: already published today (${date})`); return { status: 'already-published' }; }
    if (state === 'uncertain') throw Object.assign(new Error(`${channel}: an earlier post is uncertain; check the account, then append a published or confirmed-not-published line to ${ledger} (docs/browser-publishing.md)`), { uncertain: true });

    const policy = read(path.join(root, 'marketing/daily/property-policy.json'));
    const rules = policyRules(policy, now);
    let live = null;
    try { live = await deps.catalogue(deps.fetchImpl ?? fetch, now); }
    catch (e) { log(`${channel}: live catalogue unavailable (${redact(e)}); property posts are off for this run`); }
    const reviews = read(path.join(root, 'marketing/daily/property-reviews.json'));
    const pool = educationPool(read(path.join(root, 'marketing/daily/content.json')));
    const choice = chooseToday({ channel, date, now, listings: live?.listings ?? [], reviews, advertiser: live?.advertiser, events, pool, repeatDays: rules.repeatDays, rules, only: kind });
    if (!choice) {
      const row = { channel, date, id: entryId(channel, date), status: 'skipped-nothing-eligible' };
      if (!dry && !events.some(e => e.channel === channel && e.date === date && e.status === row.status)) appendRecord(ledger, row);
      log(`${channel}: nothing eligible today`); return row;
    }
    const itemId = choice.kind === 'property' ? choice.listing.id : choice.item.id;
    // Everything burned into the pixels gets the caption's refusal too.
    assertRenderable(renderedStrings(choice, live?.advertiser));
    const caption = captionFor(channel, choice, { advertiser: live?.advertiser, fal: live?.advertiser?.fal ?? deps.fal });
    // What a confirmed post must also show besides the full caption: the listing id, or the topic line.
    const evidence = choice.kind === 'property' ? choice.listing.id : (channel === 'tiktok' ? choice.item.topic.ar : choice.item.topic.en);
    if (!caption.includes(evidence)) throw new Error(`${channel}: caption does not carry its binding evidence "${evidence}"`);
    log(`${channel}: ${date} → ${choice.kind} ${itemId}${choice.frameOrder ? ` frames ${choice.frameOrder.join(',')}` : ''} (${caption.length} chars)`);

    const workRoot = dry ? fs.mkdtempSync(path.join(os.tmpdir(), `bona-${channel}-dry-`)) : path.join(data, channel, 'assets', date);
    const files = await renderMedia(channel, choice, workRoot, deps, live?.advertiser);
    log(`${channel}: media ${files.map(f => path.basename(f)).join(', ')}`);
    if (renderOnly) return { status: 'rendered', choice: { kind: choice.kind, itemId, frameOrder: choice.frameOrder }, caption, files };

    const recheck = async () => {
      if (choice.kind !== 'property') return;
      // Changed facts, withdrawn stock or a changed advertiser stop the run before anything is uploaded.
      const current = await deps.catalogue(deps.fetchImpl ?? fetch, now);
      const updated = current.listings.find(x => x.id === choice.listing.id);
      if (!updated || fingerprint(updated) !== fingerprint(choice.listing) || eligibility(updated, choice.review, current.advertiser, now, rules).length)
        throw Object.assign(new Error(`${choice.listing.id} changed during preflight`), { beforeClick: true });
    };
    await recheck();
    const base = { channel, date, id: entryId(channel, date), kind: choice.kind, itemId, ...(choice.kind === 'property' ? { listingId: itemId, frameOrder: choice.frameOrder } : {}) };
    const runId = `${channel}-${date}-${process.pid}`;
    const winFiles = deps.cdp.stageForUpload(files, runId);
    const unstageNow = () => deps.cdp.unstage(runId);
    cleanups.add(unstageNow);
    let tab = null;
    const closeOpenTab = async () => { if (tab) await deps.cdp.closeTab?.(tab.id); };
    cleanups.add(closeOpenTab);
    let intent = false;
    const commit = async () => {
      const at = inWindow(channel, clock());
      if (!anyTime && (!at.ok || at.date !== date)) return at.why ?? 'day changed';
      appendRecord(ledger, { ...base, status: 'intent', caption });
      intent = true;
      return true;
    };
    try {
      const result = await deps.cdp.withTab('about:blank', s => drive(channel, s, winFiles, caption, { dry, shots, date, commit, sites: deps.sites, evidence }),
        { onOpen: t => { tab = t; }, onClose: () => { tab = null; } });
      if (result.status === 'published') {
        appendRecord(ledger, { ...base, status: 'published', url: result.url });
        log(`${channel}: published ${result.url}`);
      } else if (result.status === 'unconfirmed') {
        appendRecord(ledger, { ...base, status: 'uncertain', signal: result.signal });
        throw Object.assign(new Error(`${channel}: Post was clicked (${result.signal}) but the new post was not seen on the account; recorded uncertain, the channel is blocked until reconciled`), { uncertain: true });
      } else log(`${channel}: ${result.status}${result.preClick ? ` (pre-click checks ${result.preClick}; baseline ${result.existing} existing)` : ''}${result.screenshots ? ` — ${result.screenshots.join(', ')}` : ''}`);
      if (dry && result.preClick && result.preClick !== 'passed') throw new Error(`${channel}: dry run filled the form but the pre-click checks ${result.preClick}`);
      return { ...result, choice: { kind: choice.kind, itemId, frameOrder: choice.frameOrder }, caption, files };
    } catch (e) {
      if (intent && !e.uncertain) {
        if (e.beforeClick) appendRecord(ledger, { ...base, status: 'confirmed-not-published', evidence: `failed before Post was clicked: ${redact(e)}` });
        else { appendRecord(ledger, { ...base, status: 'uncertain', error: redact(e) }); e.uncertain = true; }
      }
      throw e;
    } finally {
      try { unstageNow(); } catch { /* staging is best effort */ }
      cleanups.delete(unstageNow); cleanups.delete(closeOpenTab);
      if (dry) fs.rmSync(workRoot, { recursive: true, force: true });
    }
  };
  if (renderOnly) return operation();
  // Dry runs take the same lock: they discard drafts, so they must never overlap a live run.
  const release = acquireLock(lockPath(data, channel), { env });
  cleanups.add(release);
  try { return await operation(); } finally { release(); cleanups.delete(release); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
    'dry-run': { type: 'boolean', default: false }, 'any-time': { type: 'boolean', default: false },
    kind: { type: 'string' }, shots: { type: 'string' }, 'render-only': { type: 'boolean', default: false },
  } });
  const channel = positionals[0];
  const dry = a['dry-run'] || a['render-only'];
  const now = dry && process.env.BONA_BROWSER_TEST_NOW ? new Date(process.env.BONA_BROWSER_TEST_NOW) : new Date();
  if (a.kind && !['property', 'education'].includes(a.kind)) { console.error('--kind property|education'); process.exit(1); }
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, async () => {
    console.error(`browser-publish ${channel}: ${sig}; closing the tab, removing staged files, releasing the lock`);
    await runCleanups();
    process.exit(143);
  });
  try {
    const r = await run(channel, { dry, anyTime: a['any-time'], kind: a.kind ?? null, shots: a.shots ?? null, renderOnly: a['render-only'], now });
    if (dry) console.log(JSON.stringify({ status: r.status, choice: r.choice, files: r.files, screenshots: r.screenshots, caption: r.caption }, null, 1));
  } catch (e) {
    const data = dataDir(process.env);
    if (!dry && CHANNELS[channel]) appendRecord(path.join(data, channel, 'alerts.jsonl'), { channel, status: e.uncertain ? 'uncertain' : 'needs-attention', kind: e.kind ?? null, reason: redact(e) });
    console.error(`browser-publish ${channel ?? ''}: ${redact(e)}`);
    process.exitCode = e.uncertain ? 2 : 1;
  }
}
