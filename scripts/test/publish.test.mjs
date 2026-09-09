// scripts/social/publish.mjs — the unattended Instagram publisher. Everything here runs with
// injected fetch / graph / ledger / clock: no network, no files touched outside a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  absoluteImageUrl, acquireLock, composeCaption, decide, DEFAULTS, fmtKsa, hasLicencePlaceholder, indexLedger,
  jpegCandidates, ksaToEpoch, normaliseEntry, parseArgs, parseLedger, parseNow, resolveImage, run, TERMINAL,
} from '../social/publish.mjs';
import { DEFAULT_LEDGER_PATH, lockPathFor, readLedgerFile, resolveLedgerPath } from '../social/lib/ledger.mjs';

const H = 3_600_000;
const mk = (over = {}) => normaliseEntry({
  id: 'ig-2026-09-10-post-test', date: '2026-09-10', time: '20:30', platform: 'instagram', format: 'post',
  topic: { en: 'Test post', ar: 'x' }, caption: { en: 'English body.', ar: 'نص عربي.' }, hashtags: ['#a', '#b'],
  image: 'https://media.example/a.jpg', images: ['https://media.example/a.jpg'], alt: { en: 'alt' }, adLicenceRequired: false, status: 'planned', ...over,
});
const ledgerOf = (...rows) => indexLedger(rows);
const readCaption = (f) => `LAUNCH ${f}\n\n#launch`;
const ctx = (over = {}) => ({ now: ksaToEpoch('2026-09-10', '20:30'), graceMs: 6 * H, ledger: ledgerOf(), readCaption, ...over });
const headers = (ct) => ({ get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) });
const imageFetch = (map) => async (url, init = {}) => {
  const r = map[String(url)];
  if (!r) return { status: 404, headers: headers('text/html') };
  if (typeof r === 'function') return r(init);
  return { status: r.status ?? 200, headers: headers(r.ct ?? 'image/jpeg'), body: { cancel: async () => {} } };
};

test('time: KSA is UTC+3 with no DST; --now accepts KSA wall-clock or a zoned ISO time', () => {
  assert.equal(ksaToEpoch('2026-09-09', '18:30'), Date.UTC(2026, 8, 9, 15, 30));
  assert.equal(ksaToEpoch('2026-01-09', '01:00'), Date.UTC(2026, 0, 8, 22, 0), 'early-morning KSA is the previous UTC day');
  assert.equal(fmtKsa(Date.UTC(2026, 8, 9, 15, 30)), '2026-09-09 18:30 KSA');
  assert.equal(parseNow('2026-09-09T18:30'), Date.UTC(2026, 8, 9, 15, 30));
  assert.equal(parseNow('2026-09-09 18:30:15'), Date.UTC(2026, 8, 9, 15, 30, 15));
  assert.equal(parseNow('2026-09-09'), Date.UTC(2026, 8, 8, 21, 0), 'a bare date is KSA midnight');
  assert.equal(parseNow('2026-09-09T15:30:00Z'), Date.UTC(2026, 8, 9, 15, 30));
  assert.equal(parseNow('2026-09-09T18:30:00+03:00'), Date.UTC(2026, 8, 9, 15, 30));
  assert.throws(() => parseNow('yesterday'), /--now must be/);
  assert.throws(() => parseNow('2026-09-09T18:30:00.000'), /--now must be/, 'no zone, not the KSA form → refused rather than guessed');
});

test('due selection: due from the slot until --grace hours after it, missed beyond that, never before', () => {
  const e = mk();
  const at = ksaToEpoch('2026-09-10', '20:30');
  assert.equal(decide(e, ctx({ now: at - 60_000 })).status, null, 'one minute early: not yet');
  assert.equal(decide(e, ctx({ now: at })).status, 'candidate', 'on the slot');
  assert.equal(decide(e, ctx({ now: at + 6 * H })).status, 'candidate', 'exactly grace: still due');
  const missed = decide(e, ctx({ now: at + 6 * H + 60_000 }));
  assert.equal(missed.status, 'skipped:missed');
  assert.equal(missed.terminal, true);
  assert.equal(decide(e, ctx({ now: at + 2 * H, graceMs: 1 * H })).status, 'skipped:missed', '--grace is honoured');
  // timezone edge: a 00:15 KSA slot is 21:15 UTC the day before; a UTC-minded clock must not push it a day out
  const early = mk({ date: '2026-09-11', time: '00:15' });
  assert.equal(decide(early, ctx({ now: Date.UTC(2026, 8, 10, 21, 14) })).status, null);
  assert.equal(decide(early, ctx({ now: Date.UTC(2026, 8, 10, 21, 15) })).status, 'candidate');
  assert.equal(decide(mk({ platform: 'tiktok' }), ctx()).status, null, 'other platforms are ignored');
});

test('REGA: adLicenceRequired / blocked entries are skipped while due, silent once past, and --force-id does not override', () => {
  for (const over of [{ adLicenceRequired: true }, { blocked: true }]) {
    const d = decide(mk(over), ctx());
    assert.equal(d.status, 'skipped:ad-licence');
    assert.equal(d.terminal, false, 'not terminal: the licence may arrive');
    assert.equal(decide(mk(over), ctx({ now: ksaToEpoch('2026-09-12') })).status, null);
    assert.equal(decide(mk(over), ctx({ forceId: 'ig-2026-09-10-post-test', now: 0 })).status, 'skipped:ad-licence');
  }
});

test('reels are never automated: skipped:manual once, terminal', () => {
  const d = decide(mk({ format: 'reel' }), ctx());
  assert.equal(d.status, 'skipped:manual');
  assert.equal(d.terminal, true);
  assert.ok(TERMINAL.has('skipped:manual'));
  assert.equal(decide(mk({ format: 'reel' }), ctx({ now: ksaToEpoch('2026-09-13') })).status, 'skipped:manual', 'a missed reel still tells the human');
});

test('licence placeholder in a caption is a hard stop, even forced, in every spelling — until the caption is fixed', () => {
  assert.equal(hasLicencePlaceholder('REGA advertising licence: {{AD_LICENCE}}'), true);
  assert.equal(hasLicencePlaceholder('REGA ad licence: [add number before publishing]'), true);
  assert.equal(hasLicencePlaceholder('رقم ترخيص الإعلان العقاري: [يُضاف قبل النشر]'), true);
  assert.equal(hasLicencePlaceholder('REGA ad licence: 7200012345'), false);
  for (const cap of [{ ar: 'x {{AD_LICENCE}}', en: 'y' }, { ar: 'x', en: 'REGA ad licence: [add number before publishing]' }, { ar: 'رقم ترخيص الإعلان العقاري: [يُضاف قبل النشر]', en: '' }]) {
    const d = decide(mk({ caption: cap }), ctx({ forceId: 'ig-2026-09-10-post-test' }));
    assert.equal(d.status, 'skipped:ad-licence-placeholder');
    assert.equal(d.terminal, false, 'not permanent: the number may be pasted in before the slot lapses');
  }
  assert.equal(TERMINAL.has('skipped:ad-licence-placeholder'), false);
  const prior = { id: 'ig-2026-09-10-post-test', status: 'skipped:ad-licence-placeholder', ts: '2026-09-10T17:31:00Z' };
  assert.equal(decide(mk({ caption: { ar: 'x {{AD_LICENCE}}', en: 'y' } }), ctx({ ledger: ledgerOf(prior) })).status, 'skipped:ad-licence-placeholder', 'still there: still refused (logged, written only on a status change)');
  assert.equal(decide(mk({ caption: { ar: 'رقم ترخيص الإعلان العقاري: 7200012345', en: 'REGA ad licence: 7200012345' } }), ctx({ ledger: ledgerOf(prior) })).status, 'candidate', 'the real number went in during the grace window: the post goes out');
  const launch = mk({ launch: 9 });
  assert.equal(decide(launch, ctx({ readCaption: () => 'Bona is open {{AD_LICENCE}}' })).status, 'skipped:ad-licence-placeholder', 'the launch caption file is checked too');
  assert.equal(decide(launch, ctx({ ledger: ledgerOf({ id: launch.id, status: 'skipped:ad-licence-placeholder', ts: 't' }) })).status, 'candidate', 'the caption FILE is re-read every run, so fixing it is enough');
  assert.equal(decide(launch, ctx()).status, 'candidate');
});

test('captions: launch posts read marketing/captions/launch-0N.txt, the rest are AR — EN + ≤30 hashtags; over-long is skipped (not terminal)', () => {
  assert.equal(composeCaption(mk({ launch: 4 }), readCaption), 'LAUNCH launch-04.txt\n\n#launch');
  assert.equal(composeCaption(mk(), readCaption), 'نص عربي.\n\n—\n\nEnglish body.\n\n#a #b');
  assert.equal(composeCaption(mk({ caption: 'plain', hashtags: [] }), readCaption), 'plain');
  const many = mk({ hashtags: Array.from({ length: 40 }, (_, i) => `#t${i}`) });
  const d = decide(many, ctx());
  assert.equal(d.status, 'candidate');
  assert.equal((d.caption.match(/#t\d+/g) || []).length, 30, 'hashtags are cut to 30, not refused');
  const long = decide(mk({ caption: { ar: 'ع'.repeat(1200), en: 'e'.repeat(1200) } }), ctx());
  assert.equal(long.status, 'skipped:caption');
  assert.equal(long.terminal, false);
  assert.match(long.detail, /chars \(max 2,200\)/);
  assert.equal(decide(mk({ format: 'story', caption: { ar: 'ع'.repeat(3000) } }), ctx()).status, 'candidate', 'a story sends no caption, so its length does not matter');
});

test('ledger idempotency: terminal statuses are never retried; error retries up to 3 times; --force-id re-opens everything but published', () => {
  const e = mk();
  const row = (status, extra = {}) => ({ id: e.id, status, ts: '2026-09-10T17:31:00Z', ...extra });
  for (const s of ['published', 'skipped:manual', 'skipped:no-image', 'skipped:missed', 'skipped:gave-up']) {
    assert.ok(TERMINAL.has(s));
    assert.equal(decide(e, ctx({ ledger: ledgerOf(row(s)) })).status, null, s);
  }
  assert.equal(decide(e, ctx({ ledger: ledgerOf(row('skipped:ad-licence')) })).status, 'candidate', 'a non-terminal skip is re-evaluated against the calendar');
  assert.equal(TERMINAL.has('skipped:no-jpeg'), false, 'a 404 is a deploy away from a 200');
  assert.equal(decide(e, ctx({ ledger: ledgerOf(row('skipped:no-jpeg')) })).status, 'candidate', 'no-jpeg is re-checked live every run within the grace window');
  assert.equal(decide(mk({ image: null, images: [] }), ctx()).status, 'skipped:no-image');
  assert.equal(decide(mk({ image: null, images: [] }), ctx()).terminal, true);
  assert.equal(decide(e, ctx({ ledger: ledgerOf(row('error'), row('error')) })).status, 'candidate', 'two errors: try again');
  const gaveUp = decide(e, ctx({ ledger: ledgerOf(row('error'), row('error'), row('error')) }));
  assert.equal(gaveUp.status, 'skipped:gave-up');
  assert.equal(gaveUp.terminal, true);
  assert.equal(decide(e, ctx({ ledger: ledgerOf(row('error'), row('error'), row('error'), row('published')) })).status, null, 'published after three errors is published');
  for (const later of [[row('error')], [row('skipped:quota')], [row('error'), row('error'), row('skipped:missed')]]) {
    assert.equal(decide(e, ctx({ ledger: ledgerOf(row('published'), ...later) })).status, null, `published is irrevocable: a later ${later.map((r) => r.status).join('+')} line (hand edit, merge, recovery script) never re-opens it`);
    assert.equal(decide(e, ctx({ ledger: ledgerOf(row('published'), ...later), forceId: e.id, now: 0 })).status, 'refused:published', 'not even forced');
  }
  assert.equal(decide(mk({ status: 'published' }), ctx()).status, null, 'the calendar itself saying published (gen-social read-back, or a human) is settled');
  assert.equal(decide(mk({ status: 'published' }), ctx({ forceId: e.id, now: 0 })).status, 'refused:published');
  assert.equal(decide(e, ctx({ ledger: ledgerOf(row('publishing', { containerId: 'c9' })) })).status, null, 'an in-flight line is never a candidate — reconcile settles it');
  assert.equal(decide(e, ctx({ ledger: ledgerOf(row('publishing', { containerId: 'c9' })), forceId: e.id, now: 0 })).status, 'refused:publishing');
  assert.equal(decide(e, ctx({ ledger: ledgerOf(row('publishing', { containerId: 'c9' }), row('error')) })).status, 'candidate', 'reconciled to error: the container failed, so the post may be tried again (counted)');
  const forced = { forceId: e.id, now: 0 };
  assert.equal(decide(e, ctx({ ...forced, ledger: ledgerOf(row('skipped:gave-up')) })).status, 'candidate');
  assert.equal(decide(e, ctx({ ...forced, ledger: ledgerOf(row('skipped:missed')) })).status, 'candidate');
  assert.equal(decide(e, ctx({ ...forced, ledger: ledgerOf(row('skipped:no-jpeg')) })).status, 'candidate', 'forced: the image is re-checked live');
  assert.equal(decide(e, ctx({ ...forced, ledger: ledgerOf(row('skipped:no-image')) })).status, 'candidate', 'forced re-opens a structural skip too (the calendar may have been fixed)');
  assert.equal(decide(e, ctx({ ...forced, ledger: ledgerOf(row('skipped:manual')) })).status, null, 'a manual (reel) line is not re-opened by force — a reel is a human job whatever the flag says');
  assert.equal(decide(mk({ caption: { ar: 'x {{AD_LICENCE}}', en: 'y' } }), ctx({ ...forced, ledger: ledgerOf(row('skipped:ad-licence-placeholder')) })).status, 'skipped:ad-licence-placeholder', 'a placeholder still in the caption is refused whatever the flag says');
  const refused = decide(e, ctx({ ...forced, ledger: ledgerOf(row('published', { permalink: 'https://instagram.com/p/x' })) }));
  assert.equal(refused.status, 'refused:published');
  assert.match(refused.detail, /never re-posted, not even with --force-id/);
  assert.equal(decide(mk({ id: 'other' }), ctx(forced)).status, null, '--force-id ignores every other entry');
});

test('ledger location: outside the repo — ~/bona-data/ig by default, $BONA_IG_LEDGER or --ledger override, lock beside it, absent = empty', () => {
  const home = os.homedir();
  assert.equal(DEFAULT_LEDGER_PATH, path.join(home, 'bona-data', 'ig', 'published.jsonl'));
  assert.equal(resolveLedgerPath(null, {}), DEFAULT_LEDGER_PATH);
  assert.equal(resolveLedgerPath(null, { BONA_IG_LEDGER: '/srv/ig/l.jsonl' }), '/srv/ig/l.jsonl');
  assert.equal(resolveLedgerPath('/tmp/x.jsonl', { BONA_IG_LEDGER: '/srv/ig/l.jsonl' }), '/tmp/x.jsonl', '--ledger beats the env');
  assert.equal(resolveLedgerPath('~/ig/l.jsonl', {}), path.join(home, 'ig', 'l.jsonl'), 'a leading ~ is the home directory');
  assert.equal(lockPathFor('/srv/ig/l.jsonl'), '/srv/ig/.publish.lock');
  assert.ok(!DEFAULT_LEDGER_PATH.includes(path.join(home, 'bona') + path.sep), 'never inside the working tree');
  assert.deepEqual(readLedgerFile(path.join(os.tmpdir(), 'bona-no-such-ledger-' + process.pid + '.jsonl')), [], 'a missing ledger reads as empty');
});

test('ledger parsing: JSON lines, corrupt lines skipped, last line per id wins, error count resets on publish', () => {
  const recs = parseLedger('{"id":"a","status":"error"}\nnot json\n\n{"id":"a","status":"error"}\n{"id":"b","status":"published","ts":"t"}\n{"id":"a","status":"published"}\n{"id":"a","status":"error"}\n{"status":"published"}\n');
  assert.equal(recs.length, 5);
  const idx = indexLedger(recs);
  assert.equal(idx.get('a').latest.status, 'error');
  assert.equal(idx.get('a').errors, 1);
  assert.equal(idx.get('a').published.status, 'published', 'the published line is remembered even when it is not the last');
  assert.equal(idx.get('b').errors, 0);
  assert.equal(idx.has('c'), false);
  const fl = indexLedger(parseLedger('{"id":"x","status":"publishing","containerId":"c1"}\n{"id":"y","status":"publishing","containerId":"c2"}\n{"id":"y","status":"published"}\n'));
  assert.equal(fl.get('x').inFlight.containerId, 'c1');
  assert.equal(fl.get('y').inFlight, null, 'a later published line settles the flight');
});

test('image URLs: site-relative → absolute, PNG → its .jpg/.jpeg twin, local paths are not hosted', () => {
  assert.equal(absoluteImageUrl('/listings/x/01.jpg'), 'https://bona-real-estate.com/listings/x/01.jpg');
  assert.equal(absoluteImageUrl('/listings/x/01.jpg', 'https://example.org/'), 'https://example.org/listings/x/01.jpg');
  assert.equal(absoluteImageUrl('https://h/a.jpg'), 'https://h/a.jpg');
  assert.equal(absoluteImageUrl('marketing/queue/posts/a.png'), null, 'a queue.json asset path is not a URL');
  assert.equal(absoluteImageUrl(''), null);
  assert.deepEqual(jpegCandidates('https://h/a.jpg'), ['https://h/a.jpg']);
  assert.deepEqual(jpegCandidates('https://h/a.JPEG?v=1'), ['https://h/a.JPEG?v=1']);
  assert.deepEqual(jpegCandidates('https://bona-real-estate.com/og-default.png'), ['https://bona-real-estate.com/og-default.jpg', 'https://bona-real-estate.com/og-default.jpeg']);
  assert.deepEqual(jpegCandidates('https://h/dir/file.webp?x=1'), ['https://h/dir/file.jpg?x=1', 'https://h/dir/file.jpeg?x=1']);
});

test('resolveImage: HEAD-verified JPEG, twin lookup, no twin → no-jpeg, HEAD refused → ranged GET, network → retryable', async () => {
  const ok = await resolveImage('/listings/x/01.jpg', { fetch: imageFetch({ 'https://bona-real-estate.com/listings/x/01.jpg': {} }) });
  assert.deepEqual(ok, { ok: true, url: 'https://bona-real-estate.com/listings/x/01.jpg', tried: ['https://bona-real-estate.com/listings/x/01.jpg → 200 image/jpeg'] });
  const twin = await resolveImage('https://bona-real-estate.com/og-default.png', { fetch: imageFetch({ 'https://bona-real-estate.com/og-default.jpg': {} }) });
  assert.equal(twin.ok, true);
  assert.equal(twin.url, 'https://bona-real-estate.com/og-default.jpg');
  const none = await resolveImage('https://bona-real-estate.com/og-default.png', { fetch: imageFetch({}) });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no-jpeg');
  assert.equal(none.tried.length, 2, 'both .jpg and .jpeg were tried');
  assert.match(none.detail, /og-default\.jpg → 404/);
  const wrongType = await resolveImage('https://h/a.jpg', { fetch: imageFetch({ 'https://h/a.jpg': { ct: 'text/html' } }) });
  assert.equal(wrongType.reason, 'no-jpeg', 'a 200 that is not image/jpeg is not good enough');
  const png200 = await resolveImage('https://h/a.png', { fetch: imageFetch({ 'https://h/a.png': { ct: 'image/png' } }) });
  assert.equal(png200.ok, false, 'the PNG itself is never used');
  let methods = [];
  const ranged = await resolveImage('https://h/a.jpg', { fetch: imageFetch({ 'https://h/a.jpg': (init) => { methods.push(init.method); return init.method === 'HEAD' ? { status: 405, headers: headers('') } : { status: 206, headers: headers('image/jpeg; charset=binary'), body: { cancel: async () => {} } }; } }) });
  assert.equal(ranged.ok, true);
  assert.deepEqual(methods, ['HEAD', 'GET']);
  const net = await resolveImage('https://h/a.jpg', { fetch: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(net.reason, 'network');
  assert.equal((await resolveImage('http://h/a.jpg', { fetch: imageFetch({}) })).reason, 'no-image', 'plain http is refused before any request — structural');
  assert.equal((await resolveImage('marketing/queue/a.jpg', { fetch: imageFetch({}) })).reason, 'no-image', 'a local path is not hosted — structural');
  assert.equal((await resolveImage('https://h/a.jpg', { fetch: imageFetch({ 'https://h/a.jpg': { status: 503, ct: 'text/html' } }) })).reason, 'no-jpeg', 'a 5xx is the server having a moment, not the image missing');
});

test('normaliseEntry: content-calendar.json shape and queue.json shape both map to one form', () => {
  const cal = normaliseEntry({ date: '2026-09-10', format: 'carousel', topic: { en: 'District guide — Al Shati' }, images: ['/a.jpg', '/b.jpg'], caption: { ar: 'a', en: 'b' } }, 3);
  assert.equal(cal.id, 'ig-2026-09-10-carousel-district-guide-al-shati', 'a missing id is derived the way gen-social.mjs derives it');
  assert.equal(cal.time, DEFAULTS.defaultTime);
  assert.equal(cal.kind, 'carousel');
  assert.equal(normaliseEntry({ date: 'd', launch: 7, topic: { en: 'x' } }).id, 'ig-launch-07');
  const q = normaliseEntry({ id: 'q-001', date: '2026-09-10', time: '21:05', platform: 'instagram', surface: 'story', format: 'image', pieceKey: 'story-new-BONA-001', assets: ['marketing/queue/s.png'], assetsJpg: ['marketing/queue/s.jpg'], caption: { ar: 'a', en: 'b' }, blocked: true });
  assert.equal(q.kind, 'story');
  assert.deepEqual(q.images, ['marketing/queue/s.jpg'], 'assetsJpg is preferred over assets');
  assert.equal(q.blocked, true);
  assert.equal(normaliseEntry({ date: 'd', surface: 'reel', format: 'video', topic: 'r' }).kind, 'reel');
});

test('parseArgs: defaults, numbers validated, unknown flags refused', () => {
  const d = parseArgs([]);
  assert.deepEqual(d, { dryRun: false, now: undefined, graceHours: 6, limit: 3, forceId: null, source: DEFAULTS.source, ledger: null, json: false, help: false });
  const o = parseArgs(['--dry-run', '--now', '2026-09-09T18:30', '--grace', '2', '--limit', '1', '--force-id', 'ig-launch-04', '--source', '/tmp/x.json', '--ledger', '/tmp/l.jsonl', '--json']);
  assert.deepEqual(o, { dryRun: true, now: '2026-09-09T18:30', graceHours: 2, limit: 1, forceId: 'ig-launch-04', source: '/tmp/x.json', ledger: '/tmp/l.jsonl', json: true, help: false });
  assert.throws(() => parseArgs(['--limit', 'three']), /--limit must be a number/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
});

// ---- the run itself -------------------------------------------------------------------
function harness({ entries, ledger = [], quota = 0, publishFail = null, failAfterLine = null, imageMap = null, containers = {}, publishContainerFail = null, onPublish = null } = {}) {
  const appended = [], logs = [], slept = [], calls = [];
  const map = imageMap ?? Object.fromEntries(entries.flatMap((e) => (e.images || [e.image]).filter(Boolean).map((u) => [absoluteImageUrl(u), {}])));
  let n = 0, k = 0;
  // Mirrors lib/graph.mjs: container → wait → beforePublish(containerId) → media_publish.
  const flow = async (p) => {
    if (publishFail) throw publishFail;
    const cid = `c${++k}`;
    await p.beforePublish?.(cid);
    if (failAfterLine) throw failAfterLine;
    await onPublish?.(cid);
    return { mediaId: `m${++n}`, permalink: `https://instagram.com/p/m${n}`, containerId: cid };
  };
  const graph = {
    publishingLimit: async () => { calls.push('limit'); return { quotaUsage: quota, quotaTotal: 25, quotaDurationSec: 86400 }; },
    publishImage: async (p) => { calls.push(['image', p.imageUrl, p.altText]); return flow(p); },
    publishCarousel: async (p) => { calls.push(['carousel', p.imageUrls]); return flow(p); },
    publishStory: async (p) => { calls.push(['story', p.imageUrl]); return flow(p); },
    containerStatus: async (cid) => { calls.push(['status', cid]); const c = containers[cid]; if (c instanceof Error) throw c; if (!c) throw new Error(`unexpected containerStatus(${cid})`); return c; },
    publishContainer: async (cid) => { calls.push(['media_publish', cid]); if (publishContainerFail) throw publishContainerFail; return { mediaId: `m${++n}`, permalink: `https://instagram.com/p/m${n}`, containerId: cid }; },
  };
  const deps = {
    now: ksaToEpoch('2026-09-10', '21:00'), wallClock: Date.UTC(2026, 8, 10, 18, 0), lock: false, graph, fetch: imageFetch(map),
    loadEntries: () => entries, readLedger: () => ledger, appendLedger: (r) => appended.push(r), readCaption, sleep: async (ms) => slept.push(ms), log: (s) => logs.push(s),
  };
  return { appended, logs, slept, calls, deps };
}
const raw = (over = {}) => ({ id: `ig-${over.date || '2026-09-10'}-${over.format || 'post'}-${over.n || 'a'}`, date: '2026-09-10', time: '20:30', platform: 'instagram', format: 'post', topic: { en: `Post ${over.n || 'a'}` }, caption: { ar: 'ع', en: 'e' }, hashtags: ['#x'], image: `https://media.example/${over.n || 'a'}.jpg`, images: [`https://media.example/${over.n || 'a'}.jpg`], alt: { en: 'alt' }, adLicenceRequired: false, ...over });

test('run: publishes what is due in slot order, 60 s apart, records the ledger, skips REGA once, exits 0', async () => {
  const entries = [raw({ n: 'b', time: '20:45' }), raw({ n: 'a' }), raw({ n: 'lic', adLicenceRequired: true }), raw({ n: 'future', date: '2026-09-11' }), raw({ n: 'story', format: 'story', time: '17:15' })];
  const h = harness({ entries });
  const r = await run({ dryRun: false, limit: 3 }, h.deps);
  assert.equal(r.code, 0);
  assert.equal(r.published, 3);
  assert.deepEqual(h.calls, ['limit', ['story', 'https://media.example/story.jpg'], ['image', 'https://media.example/a.jpg', 'alt'], ['image', 'https://media.example/b.jpg', 'alt']], 'quota read once, then oldest slot first');
  assert.deepEqual(h.slept, [60_000, 60_000], 'a gap before every publish after the first');
  assert.deepEqual(h.appended.map((x) => [x.id, x.status, x.mediaId]), [
    ['ig-2026-09-10-post-lic', 'skipped:ad-licence', null],
    ['ig-2026-09-10-story-story', 'publishing', null], ['ig-2026-09-10-story-story', 'published', 'm1'],
    ['ig-2026-09-10-post-a', 'publishing', null], ['ig-2026-09-10-post-a', 'published', 'm2'],
    ['ig-2026-09-10-post-b', 'publishing', null], ['ig-2026-09-10-post-b', 'published', 'm3'],
  ], 'the in-flight line lands BEFORE media_publish, the published line after');
  const flight = h.appended[1];
  assert.deepEqual(Object.keys(flight), ['id', 'date', 'slot', 'kind', 'status', 'mediaId', 'permalink', 'ts', 'containerId', 'imageUrl']);
  assert.equal(flight.containerId, 'c1');
  const pub = h.appended[2];
  assert.deepEqual(Object.keys(pub), ['id', 'date', 'slot', 'kind', 'status', 'mediaId', 'permalink', 'ts', 'containerId', 'imageUrl']);
  assert.equal(pub.ts, '2026-09-10T18:00:00.000Z');
  assert.equal(pub.permalink, 'https://instagram.com/p/m1');
  assert.equal(pub.containerId, 'c1');
  assert.equal(r.results.some((x) => x.status === 'publishing'), false, 'the in-flight line is a ledger fact, not a result');
  assert.ok(h.logs.some((l) => /^published\s+ig-2026-09-10-post-a  2026-09-10 20:30  post/.test(l)), 'one log line per entry');

  // second run against the ledger it just wrote: nothing is repeated, the ad-licence line is not re-appended
  const h2 = harness({ entries, ledger: h.appended });
  const r2 = await run({ dryRun: false }, h2.deps);
  assert.equal(r2.published, 0);
  assert.deepEqual(h2.calls, []);
  assert.deepEqual(h2.appended, [], 'same status as last time → no new ledger line');
  assert.ok(h2.logs.some((l) => l.startsWith('skipped:ad-licence')), 'but it is still logged');
});

test('run: a failure after the publishing line is needs-reconcile — no error line, never re-posted; the next run asks Instagram', async () => {
  const { GraphError } = await import('../social/lib/graph.mjs');
  const entries = [raw({ n: 'a' }), raw({ n: 'b', time: '20:31' })];
  const h = harness({ entries, failAfterLine: new GraphError('POST /media_publish → HTTP 500', { status: 500 }) });
  const r = await run({ dryRun: false }, h.deps);
  assert.equal(r.code, 2, 'a unit failure is what makes the human look');
  assert.deepEqual(h.appended.map((x) => x.status), ['publishing', 'publishing'], 'nothing but the in-flight lines: no error line can re-open them');
  assert.ok(h.logs.filter((l) => l.startsWith('needs-reconcile')).length === 2);
  assert.ok(h.logs.some((l) => /NOT re-posted/.test(l)));

  // next run, same ledger: c1 went through (PUBLISHED), c2 never did (ERROR) → one reconciled publish, one retriable error, no blind re-post of either
  const h2 = harness({ entries, ledger: h.appended, containers: { c1: { statusCode: 'PUBLISHED', status: '' }, c2: { statusCode: 'ERROR', status: 'Media upload failed' } } });
  const r2 = await run({ dryRun: false }, h2.deps);
  assert.deepEqual(h2.calls.slice(0, 2), [['status', 'c1'], ['status', 'c2']], 'reconcile runs before anything else');
  assert.deepEqual(h2.appended.map((x) => [x.id, x.status, x.mediaId, x.containerId]), [
    ['ig-2026-09-10-post-a', 'published', null, 'c1'],
    ['ig-2026-09-10-post-b', 'error', null, 'c2'],
    ['ig-2026-09-10-post-b', 'publishing', null, 'c1'],
    ['ig-2026-09-10-post-b', 'published', 'm1', 'c1'],
  ], 'a: settled as published (mediaId unknown); b: the container died, so it is tried again with a NEW container');
  assert.equal(h2.calls.filter((c) => c[0] === 'image').length, 1, 'a is never re-posted');
  assert.equal(r2.published, 1);
  assert.equal(r2.errors, 1);

  // third run: the ledger says a is published, b is published → nothing to do, nothing asked
  const h3 = harness({ entries, ledger: [...h.appended, ...h2.appended] });
  const r3 = await run({ dryRun: false }, h3.deps);
  assert.deepEqual(h3.calls, []);
  assert.equal(r3.code, 0);
});

test('run: reconcile — FINISHED re-sends media_publish with the same creation_id; GET failure / IN_PROGRESS stay in flight and are never a candidate; dry-run only reports', async () => {
  const { GraphError } = await import('../social/lib/graph.mjs');
  const a = raw({ n: 'a' }), b = raw({ n: 'b', time: '20:31' }), c = raw({ n: 'c', time: '20:32' });
  const flight = (e, cid) => ({ id: e.id, date: e.date, slot: e.time, kind: 'post', status: 'publishing', containerId: cid, ts: '2026-09-10T17:40:00.000Z' });
  const h = harness({ entries: [a, b, c], ledger: [flight(a, 'ca'), flight(b, 'cb'), flight(c, 'cc')], containers: { ca: { statusCode: 'FINISHED', status: '' }, cb: new GraphError('GET /cb → network error: ECONNRESET', { network: true }), cc: { statusCode: 'IN_PROGRESS', status: '' } } });
  const r = await run({ dryRun: false }, h.deps);
  assert.deepEqual(h.calls, [['status', 'ca'], ['media_publish', 'ca'], ['status', 'cb'], ['status', 'cc']], 'a: media_publish for the SAME container; b and c: asked, left alone; no new containers for anyone');
  assert.deepEqual(h.appended.map((x) => [x.id, x.status, x.mediaId, x.containerId, x.detail?.split(':')[0]]), [[a.id, 'published', 'm1', 'ca', 'reconciled']]);
  assert.equal(r.published, 1, 'a reconciled publish counts against the per-run limit');
  assert.equal(r.errors, 1, 'the unanswered GET is loud: exit 2');
  assert.equal(r.code, 2);
  assert.ok(h.logs.some((l) => l.startsWith('needs-reconcile') && l.includes(b.id) && /left in flight, NOT re-posted/.test(l)));
  assert.ok(h.logs.some((l) => l.startsWith('needs-reconcile') && l.includes(c.id) && /IN_PROGRESS/.test(l)));
  assert.equal(h.appended.some((x) => x.status === 'error'), false, 'no error line — that would re-open the entry');

  // media_publish itself failing on reconcile: still in flight, still not an error line
  const h2 = harness({ entries: [a], ledger: [flight(a, 'ca')], containers: { ca: { statusCode: 'FINISHED', status: '' } }, publishContainerFail: new GraphError('POST /media_publish → HTTP 400 code=9007', { code: 9007 }) });
  const r2 = await run({ dryRun: false }, h2.deps);
  assert.deepEqual(h2.appended, []);
  assert.equal(r2.code, 2);
  assert.ok(h2.logs.some((l) => l.startsWith('needs-reconcile') && /left in flight, NOT re-posted/.test(l)));

  // an in-flight line whose entry left the calendar is still reconciled (the id is the key, not the calendar)
  const h3 = harness({ entries: [b], ledger: [flight(a, 'ca')], containers: { ca: { statusCode: 'PUBLISHED', status: '' } } });
  await run({ dryRun: false }, h3.deps);
  assert.deepEqual(h3.appended.map((x) => [x.id, x.status]), [[a.id, 'published'], [b.id, 'publishing'], [b.id, 'published']]);

  // dry-run: nothing is asked, nothing is written, the human is told
  const h4 = harness({ entries: [a], ledger: [flight(a, 'ca')], containers: {} });
  const r4 = await run({ dryRun: true }, h4.deps);
  assert.deepEqual(h4.calls, []);
  assert.ok(h4.logs.some((l) => l.startsWith('needs-reconcile') && /a live run asks Instagram/.test(l)));
  assert.equal(r4.results.some((x) => x.id === a.id && x.status !== 'needs-reconcile'), false, 'not a candidate either');

  // an auth error on the reconcile GET stops the run: nothing else is attempted
  const h5 = harness({ entries: [a, b], ledger: [flight(a, 'ca')], containers: { ca: new GraphError('bad token', { code: 190, hint: 'h' }) } });
  const r5 = await run({ dryRun: false }, h5.deps);
  assert.deepEqual(h5.calls, [['status', 'ca']]);
  assert.ok(h5.logs.some((l) => l.startsWith('deferred:auth') && l.includes(b.id)));
  assert.equal(r5.code, 2);
});

test('run: SIGTERM/SIGINT never interrupt a publish — the flag is read between entries, the rest is deferred and not written', async () => {
  const entries = ['a', 'b', 'c'].map((n, i) => raw({ n, time: `20:${30 + i}` }));
  const h = harness({ entries, onPublish: async () => { process.emit('SIGTERM', 'SIGTERM'); } });
  const r = await run({ dryRun: false }, h.deps);
  assert.equal(r.code, 0);
  assert.equal(r.published, 1, 'the entry in flight when the signal came finished');
  assert.deepEqual(h.appended.map((x) => [x.id, x.status]), [['ig-2026-09-10-post-a', 'publishing'], ['ig-2026-09-10-post-a', 'published']]);
  assert.deepEqual(h.calls.filter((c) => c[0] === 'image').length, 1);
  assert.equal(h.logs.filter((l) => l.startsWith('deferred:signal')).length, 2);
  assert.ok(h.logs.some((l) => /SIGTERM received — finishing the current entry/.test(l)));
  assert.equal(process.listenerCount('SIGTERM'), 0, 'handlers are removed when the run ends');
  // an injected stop flag (what the unit's TimeoutStopSec relies on) defers everything before the first publish
  const h2 = harness({ entries });
  h2.deps.stopRequested = () => 'SIGTERM';
  const r2 = await run({ dryRun: false }, h2.deps);
  assert.equal(r2.published, 0);
  assert.deepEqual(h2.appended, []);
});

test('run: the per-run cap is 3 even if --limit asks for more; the rest is deferred, not written', async () => {
  const entries = ['a', 'b', 'c', 'd'].map((n, i) => raw({ n, time: `20:${30 + i}` }));
  const h = harness({ entries });
  const r = await run({ dryRun: false, limit: 10 }, h.deps);
  assert.equal(r.published, 3);
  assert.equal(h.appended.filter((x) => x.status === 'published').length, 3);
  assert.equal(h.appended.some((x) => x.status === 'deferred:limit'), false);
  assert.ok(h.logs.some((l) => l.startsWith('deferred:limit') && l.includes('post-d')));
  const h1 = harness({ entries });
  assert.equal((await run({ dryRun: false, limit: 1 }, h1.deps)).published, 1);
});

test('run: the daily quota guard stops the run at 20 of 25 without publishing', async () => {
  const h = harness({ entries: [raw({ n: 'a' }), raw({ n: 'b', time: '20:31' })], quota: 20 });
  const r = await run({ dryRun: false }, h.deps);
  assert.equal(r.code, 0);
  assert.equal(r.published, 0);
  assert.deepEqual(h.calls, ['limit']);
  assert.deepEqual(h.appended.map((x) => x.status), ['skipped:quota', 'skipped:quota']);
  const h2 = harness({ entries: ['a', 'b', 'c'].map((n, i) => raw({ n, time: `20:${30 + i}` })), quota: 18 });
  assert.equal((await run({ dryRun: false }, h2.deps)).published, 2, '18 used + 2 published = 20 → the third waits');
});

test('run: PNG with no JPEG twin → skipped:no-jpeg, written once, re-checked until a deploy serves it; a local path → skipped:no-image (terminal); a network failure → error (retried)', async () => {
  const png = raw({ n: 'png', image: 'https://bona-real-estate.com/og-default.png', images: ['https://bona-real-estate.com/og-default.png'] });
  const h = harness({ entries: [png, raw({ n: 'a', time: '20:31' })], imageMap: { 'https://media.example/a.jpg': {} } });
  const r = await run({ dryRun: false }, h.deps);
  assert.equal(r.code, 0);
  assert.equal(r.published, 1);
  assert.equal(h.appended[0].status, 'skipped:no-jpeg');
  assert.match(h.appended[0].detail, /og-default\.jpg → 404.*og-default\.jpeg → 404/);
  // next tick, still no twin: checked again, not written again
  const again = harness({ entries: [png], ledger: h.appended, imageMap: {} });
  await run({ dryRun: false }, again.deps);
  assert.deepEqual(again.appended, [], 'same status as last time → no new line');
  assert.ok(again.logs.some((l) => l.startsWith('skipped:no-jpeg')), 'but it was checked and logged');
  // the deploy lands: the twin is served and the post goes out inside its grace window
  const twin = harness({ entries: [png], ledger: h.appended, imageMap: { 'https://bona-real-estate.com/og-default.jpg': {} } });
  await run({ dryRun: false }, twin.deps);
  assert.deepEqual(twin.calls[1], ['image', 'https://bona-real-estate.com/og-default.jpg', 'alt'], 'the twin is what gets posted');
  assert.equal(twin.appended.at(-1).status, 'published');
  const local = harness({ entries: [raw({ n: 'loc', image: 'marketing/queue/x.jpg', images: ['marketing/queue/x.jpg'] })] });
  await run({ dryRun: false }, local.deps);
  assert.equal(local.appended[0].status, 'skipped:no-image');
  assert.ok(TERMINAL.has('skipped:no-image'));
  const net = harness({ entries: [raw({ n: 'a' })] });
  net.deps.fetch = async () => { throw new Error('ENOTFOUND media.example'); };
  const rn = await run({ dryRun: false }, net.deps);
  assert.equal(rn.code, 2);
  assert.equal(net.appended[0].status, 'error');
  assert.equal(TERMINAL.has('error'), false);
});

test('run: carousels send every verified image (max 10); a one-image carousel posts as a single image; relative paths are prefixed', async () => {
  const car = raw({ n: 'car', format: 'carousel', images: ['/listings/x/01.jpg', '/listings/x/02.jpg', 'https://media.example/3.jpg'] });
  const one = raw({ n: 'one', format: 'carousel', time: '20:31', images: ['/listings/y/01.jpg'] });
  const h = harness({ entries: [car, one], imageMap: { 'https://bona-real-estate.com/listings/x/01.jpg': {}, 'https://bona-real-estate.com/listings/x/02.jpg': {}, 'https://media.example/3.jpg': {}, 'https://bona-real-estate.com/listings/y/01.jpg': {} } });
  await run({ dryRun: false }, h.deps);
  assert.deepEqual(h.calls[1], ['carousel', ['https://bona-real-estate.com/listings/x/01.jpg', 'https://bona-real-estate.com/listings/x/02.jpg', 'https://media.example/3.jpg']]);
  assert.deepEqual(h.calls[2], ['image', 'https://bona-real-estate.com/listings/y/01.jpg', 'alt']);
  assert.deepEqual(h.appended[0].imageUrls.length, 3);
  const broken = harness({ entries: [car], imageMap: { 'https://bona-real-estate.com/listings/x/01.jpg': {}, 'https://media.example/3.jpg': {} } });
  await run({ dryRun: false }, broken.deps);
  assert.equal(broken.appended[0].status, 'skipped:no-jpeg', 'one bad slide sinks the carousel rather than posting it short');
});

test('run: a Graph error is recorded as error and the run continues; an auth error stops it; exit 2 either way', async () => {
  const { GraphError } = await import('../social/lib/graph.mjs');
  const h = harness({ entries: [raw({ n: 'a' }), raw({ n: 'b', time: '20:31' })], publishFail: new GraphError('POST /media → HTTP 400 code=9004', { code: 9004, hint: 'Instagram could not fetch the image URL.' }) });
  const r = await run({ dryRun: false }, h.deps);
  assert.equal(r.code, 2);
  assert.equal(r.errors, 2);
  assert.deepEqual(h.appended.map((x) => x.status), ['error', 'error']);
  assert.match(h.appended[0].detail, /hint: Instagram could not fetch/);
  const auth = harness({ entries: [raw({ n: 'a' }), raw({ n: 'b', time: '20:31' })], publishFail: new GraphError('bad token', { code: 190, hint: 'h' }) });
  const ra = await run({ dryRun: false }, auth.deps);
  assert.equal(ra.code, 2);
  assert.equal(ra.errors, 1, 'stopped after the first');
  assert.equal(auth.calls.filter((c) => c[0] === 'image').length, 1);
  assert.ok(auth.logs.some((l) => l.startsWith('auth error — stopping')));
  assert.ok(auth.logs.some((l) => l.startsWith('deferred:auth')));
});

test('run: dry-run writes nothing, sleeps nowhere, and still shows the image checks; config errors exit 1', async () => {
  const h = harness({ entries: [raw({ n: 'a' }), raw({ n: 'b', time: '20:31' })] });
  const r = await run({ dryRun: true }, h.deps);
  assert.equal(r.code, 0);
  assert.equal(r.published, 2);
  assert.deepEqual(h.appended, []);
  assert.deepEqual(h.slept, []);
  assert.ok(h.logs.some((l) => l.startsWith('[dry-run] HEAD https://media.example/a.jpg → 200 image/jpeg')));
  assert.ok(h.logs.some((l) => l.includes('would wait 60 s')));
  const bad = harness({ entries: [] });
  bad.deps.loadEntries = () => { throw new Error('ENOENT'); };
  assert.equal((await run({ dryRun: false }, bad.deps)).code, 1);
  const shape = harness({ entries: [] });
  shape.deps.loadEntries = () => ({ nope: true });
  assert.equal((await run({ dryRun: false }, shape.deps)).code, 1);
  const force = harness({ entries: [raw({ n: 'a' })] });
  assert.equal((await run({ dryRun: false, forceId: 'ig-nope' }, force.deps)).code, 1, 'an unknown --force-id is a config error');
  const f2 = harness({ entries: [raw({ n: 'a', date: '2026-09-01' })] });
  assert.equal((await run({ dryRun: false, forceId: 'ig-2026-09-01-post-a' }, f2.deps)).published, 1, '--force-id ignores the slot');
});

test('lock: one holder at a time; a stale or orphaned lock is taken over; release removes it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-publish-lock-'));
  const file = path.join(dir, '.publish.lock');
  const t0 = Date.UTC(2026, 8, 10, 18, 0);
  const a = acquireLock(file, { now: t0, pid: 111, isAlive: () => true });
  assert.equal(a.ok, true);
  const b = acquireLock(file, { now: t0 + 60_000, pid: 222, isAlive: () => true });
  assert.equal(b.ok, false);
  assert.match(b.reason, /another run holds the lock \(pid 111, 60 s old\)/);
  const stale = acquireLock(file, { now: t0 + DEFAULTS.lockStaleMs + 1, pid: 333, isAlive: () => true });
  assert.equal(stale.ok, true, 'older than the stale window: taken over');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 333);
  const orphan = acquireLock(file, { now: t0 + DEFAULTS.lockStaleMs + 2, pid: 444, isAlive: (pid) => pid !== 333 });
  assert.equal(orphan.ok, true, 'holder is dead: taken over');
  fs.writeFileSync(file, 'garbage');
  assert.equal(acquireLock(file, { now: t0, pid: 555 }).ok, true, 'a corrupt lock is stale');
  acquireLock(file, { now: t0, pid: 555 }).release?.();
  const last = acquireLock(file, { now: t0, pid: 666, isAlive: () => true });
  last.release();
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
