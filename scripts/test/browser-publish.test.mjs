import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256, fingerprint, advertiserFingerprint, reviewedCopy, policyRules } from '../social/lib/property-daily.mjs';
import {
  CHANNELS, channelState, chooseEducation, chooseToday, educationPool, epochDay, inWindow, preferredKind,
  tiktokPropertyCaption, linkedinPropertyCaption, tiktokEducationCaption, linkedinEducationCaption, reelLicenceLines,
  readLedger, ledgerPath, EDUCATION_EXCLUDED,
} from '../social/lib/browser-daily.mjs';
import { connect, stageForUpload, unstage } from '../social/lib/cdp.mjs';
import { checkCaptionHeld } from '../social/lib/browser-sites.mjs';
import { run } from '../social/browser-publish.mjs';

// 2026-10-21 18:45Z = 21:45 Riyadh, a Wednesday: inside both the TikTok window (evening) and a LinkedIn day.
const NOW = new Date('2026-10-21T18:45:00Z');
const advertiser = { name: { ar: 'المعلن التجريبي', en: 'Fixture advertiser' }, fal: '1100000000', phone: '+966500000000' };
const RULES = policyRules({ adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-05' }, countries: ['SA'], categories: ['buy', 'rent', 'off-plan'], renders: 'off-plan-only', reviewValidDays: 90 }, NOW);
function listing(id, extra = {}) {
  return { id, slug: id.toLowerCase(), status: 'available', category: 'buy', type: 'villa',
    location: { countryCode: 'SA', district: { ar: 'الشاطئ', en: 'Al Shati' }, city: { ar: 'جدة', en: 'Jeddah' } },
    title: { ar: `فيلا ${id}`, en: `Villa ${id}` }, price: { amount: 1000000, currency: 'SAR' }, specs: { beds: 4, plotSqm: 500 },
    images: [1, 2, 3].map(i => ({ src: `/listings/${id.toLowerCase()}/${i}.jpg` })), licence: null, ...extra };
}
function review(p) {
  const r = { status: 'approved', reviewedAt: '2026-10-06T00:00:00Z', reviewer: 'fixture', factsSha256: fingerprint(p), advertiserSha256: advertiserFingerprint(advertiser),
    captionSha256: null, licenceEvidence: null, legalDisclosuresVerified: true,
    legalDisclosures: { ar: 'الأسعار المعروضة هي الأسعار المطلوبة وقابلة للتغيير.', en: 'Prices shown are asking prices and may change.' },
    photos: p.images.map((x, i) => ({ url: 'https://bona-real-estate.com' + x.src, kind: 'photograph', visuallyApproved: true, sha256: sha256(`${p.id}${i}`), width: 1920, height: 1280, alt: { ar: 'صورة', en: 'Photo' } })) };
  r.captionSha256 = sha256(JSON.stringify(reviewedCopy(p, advertiser, r)));
  return r;
}
const A = listing('BONA-A'), B = listing('BONA-B');
const REVIEWS = { [A.id]: review(A), [B.id]: review(B) };
const CONTENT = [{ key: 'k1', topic: { ar: 'موضوع', en: 'Topic one' }, caption: { ar: 'نص', en: 'Text' }, slides: [{ ar: 'ش', en: 's', rows: [] }] },
  { key: 'k2', topic: { ar: 'موضوع ٢', en: 'Topic two' }, caption: { ar: 'نص ٢', en: 'Text two' }, slides: [{ ar: 'ش', en: 's', rows: [] }] }];
const POOL = educationPool(CONTENT, []);
const pub = (channel, extra) => ({ channel, status: 'published', ...extra });

test('property every day (owner 2026-10-21): education only when no property is eligible', () => {
  assert.equal(epochDay('2026-10-31') + 1, epochDay('2026-11-01'));
  const base = { channel: 'tiktok', now: NOW, listings: [A, B], reviews: REVIEWS, advertiser, pool: POOL, rules: RULES };
  for (const date of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-31', '2026-11-01']) {
    assert.equal(preferredKind(date), 'property', date);
    for (const channel of ['tiktok', 'linkedin']) assert.equal(chooseToday({ ...base, channel, date }).kind, 'property', `${channel} ${date}`);
  }
  const even = '2026-10-22';
  assert.equal(epochDay(even) % 2, 0, 'an even day, which used to be education');
  assert.equal(chooseToday({ ...base, date: even, listings: [] }).kind, 'education', 'no property left → education');
  assert.equal(chooseToday({ ...base, date: even, pool: [] }).kind, 'property');
  assert.equal(chooseToday({ ...base, date: even, listings: [], pool: [] }), null);
  assert.equal(chooseToday({ ...base, date: even, only: 'education' }).kind, 'education');
  assert.equal(chooseToday({ ...base, date: even, only: 'property', listings: [] }), null, 'a forced kind never swaps');
});

test('property rotation is oldest-unposted-first per channel and reuses the register eligibility', () => {
  const date = ['2026-10-20', '2026-10-21'].find(d => preferredKind(d) === 'property');
  const base = { channel: 'tiktok', date, now: NOW, listings: [A, B], reviews: REVIEWS, advertiser, pool: [], rules: RULES };
  assert.equal(chooseToday(base).listing.id, 'BONA-A');
  const events = [pub('tiktok', { listingId: 'BONA-A', itemId: 'BONA-A', at: '2026-10-19T19:00:00Z' })];
  assert.equal(chooseToday({ ...base, events }).listing.id, 'BONA-B', 'A was just posted on TikTok');
  assert.equal(chooseToday({ ...base, channel: 'linkedin', events }).listing.id, 'BONA-A', 'LinkedIn has its own ledger');
  // A listing changed since review is out, exactly as on Instagram/Facebook.
  const changed = { ...A, price: { amount: 2, currency: 'SAR' } };
  const r = chooseToday({ ...base, listings: [changed] });
  assert.equal(r, null);
  // Both posted within 30 days → nothing (no recycling inside the interval).
  const both = [...events, pub('tiktok', { listingId: 'BONA-B', itemId: 'BONA-B', at: '2026-10-20T19:00:00Z' })];
  assert.equal(chooseToday({ ...base, events: both }), null);
});

test('education is oldest-unposted-first, repeats only after the interval, and drops the licence explainer', () => {
  assert.equal(chooseEducation(POOL, [], 'tiktok', NOW).id, 'edu-pack-k1');
  const ev = [pub('tiktok', { itemId: 'edu-pack-k1', at: '2026-10-20T19:00:00Z' })];
  assert.equal(chooseEducation(POOL, ev, 'tiktok', NOW).id, 'edu-pack-k2');
  assert.equal(chooseEducation(POOL, [...ev, pub('tiktok', { itemId: 'edu-pack-k2', at: '2026-10-21T00:00:00Z' })], 'tiktok', NOW), null);
  const later = new Date('2026-11-20T18:45:00Z');
  assert.equal(chooseEducation(POOL, [...ev, pub('tiktok', { itemId: 'edu-pack-k2', at: '2026-10-21T00:00:00Z' })], 'tiktok', later).id, 'edu-pack-k1');
  const full = educationPool([]);
  assert.ok(full.length >= 7);
  assert.ok(!full.some(x => EDUCATION_EXCLUDED.includes(x.id)));
  assert.equal(educationPool([{ key: 'bad', topic: { ar: 'x', en: 'x' }, caption: { ar: 'تقييم مجاني', en: 'x' }, slides: [] }], []).length, 0);
});

test('captions mirror the reviewed disclosures and fit the platforms', () => {
  const tt = tiktokPropertyCaption(A, advertiser, REVIEWS[A.id]);
  for (const s of ['المعلن: المعلن التجريبي · فال 1100000000 · +966500000000', 'الأسعار المعروضة هي الأسعار المطلوبة', '#عقارات_جدة', '#جدة', '#بونا', 'Message Bona with BONA-A', 'https://bona-real-estate.com/properties/bona-a/'])
    assert.ok(tt.includes(s), s);
  assert.ok(tt.indexOf('المعلن') < tt.indexOf('Message Bona'), 'Arabic first');
  assert.ok(tt.length <= CHANNELS.tiktok.maxCaption);
  const li = linkedinPropertyCaption(A, advertiser, REVIEWS[A.id]);
  assert.ok(li.startsWith('Villa BONA-A'));
  for (const s of ['Advertiser: Fixture advertiser · FAL 1100000000', 'Prices shown are asking prices', 'المعلن: المعلن التجريبي · فال 1100000000', '#BonaRealEstate'])
    assert.ok(li.includes(s), s);
  assert.ok(!/تقييم مجاني/.test(tt + li));
  assert.throws(() => tiktokPropertyCaption({ ...A, price: { amount: 3, currency: 'SAR' } }, advertiser, REVIEWS[A.id]), /caption changed since review/);
  assert.throws(() => tiktokPropertyCaption(A, advertiser, REVIEWS[A.id], { max: 100 }), /over 100/);
  const te = tiktokEducationCaption(POOL[0], { fal: '1100313556' });
  assert.ok(te.startsWith('موضوع') && te.includes('Topic one') && te.includes('فال 1100313556') && te.includes('#بونا'));
  const le = linkedinEducationCaption(POOL[0], { fal: '1100313556' });
  assert.ok(le.startsWith('Topic one') && le.includes('موضوع') && le.includes('FAL 1100313556'));
  assert.throws(() => tiktokEducationCaption({ ...POOL[0], caption: { ar: 'نقدم تقييم مجاني', en: 'x' } }, { fal: '1' }), /forbidden phrase/);
  const lines = reelLicenceLines(A, advertiser);
  assert.ok(lines.ar.includes('فال 1100000000') && lines.en.includes('FAL 1100000000') && !/AD_LICENCE/.test(lines.ar + lines.en));
  assert.ok(reelLicenceLines({ ...A, licence: { adNumber: '7200000000', adExpiry: '2026-12-31' } }, advertiser).en.includes('Ad licence 7200000000'));
});

test('ledger state: published is final, intent/uncertain blocks until confirmed-not-published, across days', () => {
  const d = '2026-10-21', id = 'bona-tiktok-2026-10-21';
  assert.equal(channelState([], 'tiktok', d), 'ready');
  assert.equal(channelState([{ channel: 'tiktok', date: d, id, status: 'intent' }, { channel: 'tiktok', date: d, id, status: 'published' }], 'tiktok', d), 'published');
  assert.equal(channelState([{ channel: 'tiktok', date: d, id, status: 'intent' }], 'tiktok', d), 'uncertain');
  assert.equal(channelState([{ channel: 'tiktok', date: d, id, status: 'uncertain' }, { channel: 'tiktok', date: d, id, status: 'confirmed-not-published' }], 'tiktok', d), 'ready');
  const yesterday = [{ channel: 'tiktok', date: '2026-10-20', id: 'bona-tiktok-2026-10-20', status: 'uncertain' }];
  assert.equal(channelState(yesterday, 'tiktok', d), 'uncertain', 'an unsettled earlier day blocks today');
  assert.equal(channelState(yesterday, 'linkedin', d), 'ready', 'per channel');
});

test('posting windows: TikTok evenings after Isha, LinkedIn Sunday–Thursday mornings', () => {
  assert.equal(inWindow('tiktok', NOW).ok, true);
  assert.equal(inWindow('tiktok', new Date('2026-10-21T16:00:00Z')).ok, false, '19:00 Riyadh is Maghrib–Isha');
  assert.equal(inWindow('linkedin', new Date('2026-10-21T06:30:00Z')).ok, true, 'Wed 09:30');
  assert.equal(inWindow('linkedin', new Date('2026-10-23T06:30:00Z')).ok, false, 'Friday');
  assert.equal(inWindow('linkedin', new Date('2026-10-24T06:30:00Z')).ok, false, 'Saturday');
  assert.equal(inWindow('linkedin', new Date('2026-10-25T06:30:00Z')).ok, true, 'Sunday');
});

test('the caption box check ignores the blank blocks editors add, not missing text', () => {
  assert.doesNotThrow(() => checkCaptionHeld('سطر\n\n\nline two\n\n\n#بونا ', 'سطر\nline two\n\n#بونا'));
  assert.throws(() => checkCaptionHeld('سطر\nline two', 'سطر\nline two\n\n#بونا'), /does not hold/);
});

// ------------------------------------------------------------------ CDP client against a fake socket
test('cdp client: evaluates by value and sets files by objectId; staging maps to Windows paths', async () => {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); setTimeout(() => this.onopen?.()); }
    send(raw) {
      const d = JSON.parse(raw); this.sent.push(d);
      const result = d.method === 'Runtime.evaluate' ? (d.params.returnByValue ? { result: { value: 42 } } : { result: { objectId: 'obj-1' } }) : {};
      setTimeout(() => this.onmessage({ data: JSON.stringify({ id: d.id, result }) }));
    }
    close() {}
  }
  const s = await connect({ webSocketDebuggerUrl: 'ws://fake/devtools/page/1' }, { WebSocketImpl: FakeWS });
  assert.equal(await s.ev('6*7'), 42);
  assert.equal(await s.setFiles('document.querySelector("input")', ['C:\\x\\a.mp4']), true);
  const set = sockets[0].sent.find(m => m.method === 'DOM.setFileInputFiles');
  assert.deepEqual(set.params, { objectId: 'obj-1', files: ['C:\\x\\a.mp4'] });
  s.close();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-stage-'));
  const src = path.join(tmp, 'reel.mp4'); fs.writeFileSync(src, 'x');
  const out = stageForUpload([src], 'tiktok-2026-10-21-1', { wslDir: path.join(tmp, 'win'), winDir: 'C:\\U\\up' });
  assert.deepEqual(out, ['C:\\U\\up\\tiktok-2026-10-21-1\\reel.mp4']);
  assert.ok(fs.existsSync(path.join(tmp, 'win', 'tiktok-2026-10-21-1', 'reel.mp4')));
  unstage('tiktok-2026-10-21-1', { wslDir: path.join(tmp, 'win') });
  assert.ok(!fs.existsSync(path.join(tmp, 'win', 'tiktok-2026-10-21-1')));
});

// ------------------------------------------------------------------ run(): ledger, idempotency, uncertain
function sandbox({ repeatDays = 30 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-browser-'));
  const root = path.join(dir, 'repo'), data = path.join(dir, 'data');
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify({ repeatDays, countries: ['SA'], categories: ['buy', 'rent', 'off-plan'], renders: 'off-plan-only', reviewValidDays: 90, adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-05' } }));
  fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), JSON.stringify(REVIEWS));
  fs.writeFileSync(path.join(root, 'marketing/daily/content.json'), JSON.stringify(CONTENT));
  return { root, data, env: { BONA_DATA: data } };
}
function deps({ confirm = 'https://www.tiktok.com/@bonarealestatesa/video/7', postError = null, catalogue = null } = {}) {
  const calls = [];
  const file = (dir, name) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); fs.writeFileSync(f, 'x'); return f; };
  const site = name => async (...a) => { calls.push(name); return a; };
  return { calls, d: {
    fal: '1100313556',
    catalogue: catalogue ?? (async () => ({ listings: [A, B], advertiser })),
    downloadReviewedPhotos: async (r, dir) => { calls.push(['download', r.photos.map(x => x.url), r.photos]); return r.photos.map((x, i) => file(dir, `${i + 1}-${path.basename(x.url)}`)); },
    media: {
      propertyReel: (l, frames, lines, out) => { calls.push(['reel', l.id, lines.en, frames.map(f => path.basename(f))]); return file(path.dirname(out), path.basename(out)); },
      linkedinPropertyImages: async (frames, dir) => { calls.push(['li-encode', frames.map(f => path.basename(f))]); return frames.map((_, i) => file(dir, `li-${i + 1}.jpg`)); },
      educationReel: async (item, out) => { calls.push(['edu-reel', item.id]); return file(path.dirname(out), path.basename(out)); },
      linkedinEducationImages: async (item, dir) => [file(dir, 'li-1.jpg')],
    },
    cdp: { stageForUpload: files => files.map(f => `C:\\up\\${path.basename(f)}`), unstage: () => {}, withTab: async (_url, fn) => { calls.push('tab'); return fn({ screenshot: async f => f, ev: async () => null }); } },
    sites: {
      tiktokSession: async () => { calls.push('session'); return ['1']; },
      tiktokFill: async (_s, win, caption) => { calls.push(['fill', win, caption.length]); },
      tiktokPost: async () => { calls.push('POST'); if (postError) throw postError; return 'redirected-to-content'; },
      tiktokConfirm: async () => { calls.push('confirm'); return confirm; },
      tiktokDiscard: async () => { calls.push('discard'); return true; },
      linkedinSession: async () => ['9'], linkedinFill: site('li-fill'), linkedinPost: site('LI-POST'),
      linkedinConfirm: async () => 'https://www.linkedin.com/feed/update/urn:li:activity:1/', linkedinDiscard: site('li-discard'),
    },
  } };
}
const quiet = () => {};

test('run: one post per channel per day — intent before the click, published with the URL, re-runs are no-ops', async () => {
  const sb = sandbox(), { d, calls } = deps();
  const r = await run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, d);
  assert.equal(r.status, 'published');
  const rows = readLedger(ledgerPath(sb.data, 'tiktok'));
  assert.deepEqual(rows.map(x => x.status), ['intent', 'published']);
  assert.equal(rows[1].url, 'https://www.tiktok.com/@bonarealestatesa/video/7');
  assert.equal(rows[1].listingId, 'BONA-A');
  assert.ok(calls.indexOf('POST') > calls.findIndex(c => Array.isArray(c) && c[0] === 'fill'));
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'reel' && /FAL 1100000000/.test(c[2])), 'reel CTA carries the advertiser/FAL line');
  const again = deps();
  assert.equal((await run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet }, again.d)).status, 'already-published');
  assert.deepEqual(again.calls, [], 'no browser, no render on a re-run');
  // LinkedIn on the same day is independent.
  assert.equal((await run('linkedin', { env: sb.env, root: sb.root, now: new Date('2026-10-21T06:30:00Z'), clock: () => new Date('2026-10-21T06:30:00Z'), log: quiet }, deps().d)).status, 'published');
});

test('run: clicked but not confirmed → uncertain, and the channel stays blocked until a human settles it', async () => {
  const sb = sandbox();
  await assert.rejects(run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, deps({ confirm: null }).d), e => e.uncertain === true);
  const file = ledgerPath(sb.data, 'tiktok');
  assert.deepEqual(readLedger(file).map(x => x.status), ['intent', 'uncertain']);
  const next = deps();
  await assert.rejects(run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet }, next.d), /uncertain/);
  assert.deepEqual(next.calls, []);
  // The human checked the account: nothing went out.
  fs.appendFileSync(file, JSON.stringify({ channel: 'tiktok', date: '2026-10-21', id: 'bona-tiktok-2026-10-21', status: 'confirmed-not-published', at: NOW.toISOString() }) + '\n');
  assert.equal((await run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet }, deps().d)).status, 'published');
});

test('run: a failure before the click is confirmed-not-published and the next tick retries; a crash after it is uncertain', async () => {
  const sb = sandbox();
  const disabled = Object.assign(new Error('TikTok Post button stayed disabled'), { kind: 'post-disabled', beforeClick: true });
  await assert.rejects(run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, deps({ postError: disabled }).d));
  assert.deepEqual(readLedger(ledgerPath(sb.data, 'tiktok')).map(x => x.status), ['intent', 'confirmed-not-published']);
  assert.equal((await run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet }, deps().d)).status, 'published');
  const sb2 = sandbox();
  await assert.rejects(run('tiktok', { env: sb2.env, root: sb2.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, deps({ postError: new Error('socket closed') }).d), e => e.uncertain);
  assert.deepEqual(readLedger(ledgerPath(sb2.data, 'tiktok')).map(x => x.status), ['intent', 'uncertain']);
});

test('run: dry run fills then discards and writes nothing; outside the window nothing happens; stale catalogue → education', async () => {
  const sb = sandbox(), { d, calls } = deps();
  const r = await run('tiktok', { dry: true, env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, d);
  assert.equal(r.status, 'dry-run-filled');
  assert.ok(calls.includes('discard') && !calls.includes('POST'));
  assert.equal(fs.existsSync(ledgerPath(sb.data, 'tiktok')), false);
  const early = deps();
  assert.equal((await run('tiktok', { env: sb.env, root: sb.root, now: new Date('2026-10-21T16:00:00Z'), log: quiet }, early.d)).status, 'not-due');
  assert.deepEqual(early.calls, []);
  const stale = deps({ catalogue: async () => { throw new Error('Live catalogue is stale'); } });
  const date = '2026-10-21';
  const res = await run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet }, stale.d);
  assert.equal(res.status, 'published');
  assert.equal(res.choice.kind, 'education', `property is off without a live catalogue (preferred today: ${preferredKind(date)})`);
});

test('run: the slot is re-checked on the real clock before intent', async () => {
  const sb = sandbox(), { d, calls } = deps();
  const r = await run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => new Date('2026-10-21T21:00:00Z'), log: quiet, kind: 'property' }, d);
  assert.equal(r.status, 'not-due');
  assert.ok(calls.includes('discard') && !calls.includes('POST'));
  assert.equal(fs.existsSync(ledgerPath(sb.data, 'tiktok')), false);
});

// ================================================================== review fixes (HOLD 2026-10-20)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Namespace imports on purpose: against the pre-fix code a missing export is undefined and only
// the test that needs it fails, so each test below shows its own fix (verified on 7b7024a).
import * as SITES from '../social/lib/browser-sites.mjs';
import * as CDP from '../social/lib/cdp.mjs';
import * as DAILY from '../social/lib/browser-daily.mjs';
import * as CLI from '../social/browser-publish.mjs';
const { bindNewPost, tiktokConfirm, tiktokPost, tiktokSession, tiktokDismissPopups, linkedinConfirm,
  linkedinActorProblem, linkedinPost, linkedinUrl, SELECTORS } = SITES;
const { withTab } = CDP;
const { readLedgerStrict, acquireLock, lockPath, renderedStrings, assertRenderable, appendRecord } = DAILY;
const cleanups = CLI.cleanups ?? new Set(), runCleanups = CLI.runCleanups;

function fakeSession({ ev = () => null, clickEl = () => ({ w: 1 }), start = 'https://x/' } = {}) {
  let cur = start;
  const log = { clicks: [], navs: [], ops: [] };
  return { log,
    navigate: async u => { cur = u; log.navs.push(u); log.ops.push('navigate'); },
    waitFor: async () => { log.ops.push('waitFor'); return true; },
    ev: async expr => { log.ops.push(expr.includes('const linkedinActorProblem') ? 'actor-read' : 'ev'); return ev(expr, cur); },
    clickEl: async expr => { log.clicks.push(expr); log.ops.push('clickEl'); return clickEl(expr, cur); },
    clickAt: async (x, y) => { log.clicks.push(`clickAt ${x},${y}`); log.ops.push('clickAt'); return true; },
    url: async () => cur, key: async () => {}, typeInto: async () => true, setFiles: async () => true, screenshot: async f => f };
}
/** Runs the real actor+button evaluation against a fake composer DOM. */
const composer = (actor = { name: 'Bona | بونا', asset: 'A1' }) => expr => {
  const img = { src: actor.asset ? `https://media.licdn.com/dms/image/v2/${actor.asset}/company-logo_100_100/x` : 'https://media.licdn.com/dms/image/v2/P/profile-displayphoto/x' };
  const box = { querySelector: q => (q.includes('img') ? img : { innerText: actor.name }) };
  const btn = { disabled: false, scrollIntoView() {}, getBoundingClientRect: () => ({ x: 10, y: 20, width: 4, height: 6 }) };
  return vm.runInNewContext(expr, { document: { querySelector: q => (q.includes('settings-entry') ? box : btn) } });
};
const isActorRead = e => e.includes('const linkedinActorProblem');
const isIds = e => e.includes('matchAll(/@');
const isAccount = e => e.includes('/passport/web/account/info/');

test('fix 1: a new post counts only when its own text holds the full caption and the evidence', () => {
  const caption = 'فيلا بشاطئ خاص، درة العروس\nدرة العروس، جدة\n\nBONA-001\n\n#بونا #جدة';
  const sub = { caption, evidence: 'BONA-001' };
  assert.equal(bindNewPost([{ key: '5', text: 'a promo' }], [], sub), null, 'new id, wrong text');
  assert.equal(bindNewPost([{ key: '4', text: caption }], ['4'], sub), null, 'matching text but already in the baseline');
  assert.equal(bindNewPost([{ key: '5', text: 'promo' }, { key: '6', text: caption.replace(/\n+/g, ' ') + ' …more' }], [], sub), '6');
  assert.equal(bindNewPost([{ key: 'share:9', text: 'promo' }, { key: 'activity:7', text: caption }], [], sub, { prefer: 'share:9' }), 'activity:7', 'a toast id must qualify too');
  assert.equal(linkedinUrl('ugcPost:123'), 'https://www.linkedin.com/feed/update/urn:li:ugcPost:123/');
  assert.equal(bindNewPost([{ key: '6', text: caption }], [], { caption: '', evidence: 'BONA-001' }), null, 'no caption, no binding');
});
test('fix 1: TikTok confirm rejects an unrelated new video id; accepts one whose own description is the caption', async () => {
  const caption = 'فيلا بشاطئ خاص\nBONA-001 more\n#بونا';
  const isRows = e => e.includes('/*studio-rows*/');
  const other = fakeSession({ ev: e => isRows(e) ? [{ key: '111', text: 'somebody else' }] : null });
  assert.equal(await tiktokConfirm(other, 'bonarealestatesa', [], { caption, evidence: 'BONA-001', timeoutMs: 30, every: 0, settleMs: 0 }), null);
  const ours = fakeSession({ ev: e => isRows(e) ? [{ key: '111', text: 'an older post' }, { key: '222', text: 'فيلا بشاطئ خاص BONA-001 more #بونا' }] : null });
  assert.equal(await tiktokConfirm(ours, 'bonarealestatesa', ['111'], { caption, evidence: 'BONA-001', timeoutMs: 30, every: 0, settleMs: 0 }), 'https://www.tiktok.com/@bonarealestatesa/video/222');
});
test('fix 1: the TikTok baseline comes from the settled profile grid AND Studio /content', async () => {
  const s = fakeSession({ ev: (e, cur) => isAccount(e) ? 'bonarealestatesa' : isIds(e) ? (cur.includes('tiktokstudio') ? ['2'] : ['1']) : e.includes('edit-profile-entrance') ? true : null });
  assert.deepEqual((await tiktokSession(s, 'bonarealestatesa', { settleMs: 0 })).sort(), ['1', '2']);
  assert.ok(s.log.navs.some(u => u.includes('tiktokstudio/content')));
  let settled = false;
  const unsettled = fakeSession({ ev: e => isAccount(e) ? 'bonarealestatesa' : e.includes('edit-profile-entrance') ? true : null });
  unsettled.waitFor = async cond => (cond.includes('user-post-item') && !cond.includes('edit-profile') ? (settled = false) : true);
  await assert.rejects(tiktokSession(unsettled, 'bonarealestatesa', { settleMs: 0 }), /grid did not load/);
});

test('fix 1: LinkedIn confirm binds the URN to the post element with the caption and keeps the URN type', async () => {
  const caption = 'Villa BONA-A\nmore';
  const promo = fakeSession({ ev: e => e.includes("data-activity-urn") ? [{ key: 'activity:1000000001', text: 'Hiring Pro promo' }] : null });
  assert.equal(await linkedinConfirm(promo, '145349037', [], { caption, evidence: 'BONA-A', timeoutMs: 30, every: 0, settleMs: 0 }), null);
  const ours = fakeSession({ ev: e => e.includes("data-activity-urn") ? [{ key: 'activity:1000000001', text: 'promo' }, { key: 'ugcPost:1000000002', text: 'Villa BONA-A more' }] : null });
  assert.equal(await linkedinConfirm(ours, '145349037', [], { caption, evidence: 'BONA-A', timeoutMs: 30, every: 0, settleMs: 0 }), 'https://www.linkedin.com/feed/update/urn:li:ugcPost:1000000002/');
});
test('fix 2: the TikTok Post and "Post now" buttons are each pressed at most once', async () => {
  const s = fakeSession({ ev: e => isAccount(e) ? 'bonarealestatesa' : e.includes('caption_container') ? 'cap' : '' });
  const signal = await tiktokPost(s, { handle: 'bonarealestatesa', caption: 'cap', polls: 8, every: 0 });
  assert.equal(s.log.clicks.filter(c => c.includes('post_video_button')).length, 1);
  assert.equal(s.log.clicks.filter(c => c.includes('Post now')).length, 1);
  assert.equal(signal, 'post-now-no-signal');
});

test('fix 3: a corrupt ledger line refuses; a truncated tail is repaired and the day becomes uncertain', async () => {
  const sb = sandbox(), file = ledgerPath(sb.data, 'tiktok');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"channel":"tiktok","status":"skipped-nothing-eligible","date":"2026-10-19"}\nnot json\n{"channel":"tiktok","status":"skipped-nothing-eligible","date":"2026-10-20"}\n');
  assert.throws(() => readLedgerStrict(file), /line 2 is not a ledger record/);
  const corrupt = deps();
  await assert.rejects(run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet }, corrupt.d), /not a ledger record/);
  assert.deepEqual(corrupt.calls, []);
  fs.writeFileSync(file, '{"channel":"tiktok","date":"2026-10-21","id":"bona-tiktok-2026-10-21","status":"published","url":"u"}\n{"channel":"tiktok","date":"2026-10-21","id":"bona-tik');
  assert.equal(readLedgerStrict(file).truncated, true);
  const sb2 = sandbox(), f2 = ledgerPath(sb2.data, 'tiktok');
  fs.mkdirSync(path.dirname(f2), { recursive: true });
  fs.writeFileSync(f2, '{"channel":"tiktok","date":"2026-10-21","id":"bona-tiktok-2026-10-21","status":"intent"}\n{"channel":"tiktok","date":"2026-10-21","id":"bona-tiktok-2026-10-21","sta');
  const t = deps();
  await assert.rejects(run('tiktok', { env: sb2.env, root: sb2.root, now: NOW, clock: () => NOW, log: quiet }, t.d), e => e.uncertain && /truncated/.test(e.message));
  assert.deepEqual(t.calls, []);
  const text = fs.readFileSync(f2, 'utf8');
  assert.ok(text.endsWith('\n'));
  const r = readLedgerStrict(f2);
  assert.equal(r.truncated, false, 'the torn line is newline-terminated and marked');
  assert.equal(r.rows.at(-1).status, 'uncertain');
  assert.equal(channelState(r.rows, 'tiktok', '2026-10-21'), 'uncertain', 'the day stays blocked until a human settles it');
  const again = deps();
  await assert.rejects(run('tiktok', { env: sb2.env, root: sb2.root, now: NOW, clock: () => NOW, log: quiet }, again.d), /uncertain/);
  assert.deepEqual(again.calls, []);
  // appendRecord never glues a record onto a torn line.
  const f3 = path.join(sb2.data, 'x.jsonl'); fs.writeFileSync(f3, '{"status":"a"}');
  appendRecord(f3, { status: 'b' });
  assert.deepEqual(fs.readFileSync(f3, 'utf8').trim().split('\n').map(l => JSON.parse(l).status), ['a', 'b']);
});

test('fix 4: the LinkedIn actor must be company 145349037 itself, re-checked right before Post', async () => {
  const company = { entityUrn: 'urn:li:fs_normalized_company:145349037', name: 'Bona | بونا', logoAsset: 'urn:li:digitalmediaAsset:D4D0BAQGFPaN0HRiiUw', canAdmin: true };
  const actor = { name: 'Bona | بونا', asset: 'D4D0BAQGFPaN0HRiiUw' };
  const o = { companyId: '145349037', pageName: 'Bona | بونا' };
  assert.equal(linkedinActorProblem(actor, company, o), null);
  assert.match(linkedinActorProblem(actor, { ...company, entityUrn: 'urn:li:fs_normalized_company:999' }, o), /could not be read/);
  assert.match(linkedinActorProblem(actor, { ...company, canAdmin: false }, o), /not an admin/);
  assert.match(linkedinActorProblem({ ...actor, asset: null }, company, o), /not a company logo/);
  assert.match(linkedinActorProblem({ ...actor, asset: 'OTHERASSET' }, company, o), /not the logo of company/);
  assert.match(linkedinActorProblem({ ...actor, name: 'Abdulaziz Zaidan' }, company, o), /posts as/);
  const member = composer({ name: 'Bona | بونا', asset: null });
  const s = fakeSession({ ev: e => e.includes('/voyager/api/organization/companies/') ? company : isActorRead(e) ? member(e) : 'cap' });
  await assert.rejects(linkedinPost(s, { ...o, caption: 'cap' }), e => e.kind === 'wrong-actor' && e.beforeClick === true);
  assert.equal(s.log.clicks.length, 0, 'Post never clicked');
});
test('fix 5: CDP connect has a handshake deadline, close rejects in-flight requests, and the tab is always closed', async () => {
  class Silent { constructor() { } send() {} close() {} }
  const t0 = Date.now();
  await assert.rejects(connect({ webSocketDebuggerUrl: 'ws://x' }, { WebSocketImpl: Silent, connectTimeoutMs: 50 }), /did not open/);
  assert.ok(Date.now() - t0 < 2000);
  class Dropper { constructor() { setTimeout(() => this.onopen()); } send() { setTimeout(() => this.onclose?.()); } close() {} }
  const s = await connect({ webSocketDebuggerUrl: 'ws://x' }, { WebSocketImpl: Dropper });
  const t1 = Date.now();
  await assert.rejects(s.ev('1'), /closed/);
  assert.ok(Date.now() - t1 < 2000, 'not left to the 60 s request timer');
  const closed = [];
  const fetchImpl = async (url, o) => {
    if (url.endsWith('/json/version')) return { ok: true, json: async () => ({}) };
    if (url.includes('/json/new')) return { ok: true, json: async () => ({ id: 'TAB1', webSocketDebuggerUrl: 'ws://x' }) };
    if (url.includes('/json/close/')) { closed.push(url.split('/').at(-1)); return { ok: true }; }
    throw new Error(url);
  };
  class Refuses { constructor() { setTimeout(() => this.onerror?.()); } send() {} close() {} }
  await assert.rejects(withTab('about:blank', async () => 'never', { fetchImpl, WebSocketImpl: Refuses, ensureScript: null }), /websocket failed/);
  assert.deepEqual(closed, ['TAB1']);
});

test('fix 5/9: navigate waits for this navigation\'s load event, not the previous page\'s readyState', async () => {
  let nav = null;
  class WS {
    constructor() { setTimeout(() => this.onopen()); }
    send(raw) {
      const d = JSON.parse(raw);
      let result = {};
      if (d.method === 'Runtime.evaluate') result = { result: { value: d.params.expression.includes('location.href.startsWith') ? false : true } };
      if (d.method === 'Page.navigate') { nav = Date.now(); setTimeout(() => this.onmessage({ data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }) }), 1500); }
      setTimeout(() => this.onmessage({ data: JSON.stringify({ id: d.id, result }) }));
    }
    close() {}
  }
  const s = await connect({ webSocketDebuggerUrl: 'ws://x' }, { WebSocketImpl: WS });
  await s.navigate('https://example.com/next');
  assert.ok(Date.now() - nav >= 1450, 'resolved only after Page.loadEventFired');
});

test('fix 6: intent is durable when the Post stub runs; concurrent runs are refused', async () => {
  const sb = sandbox(), { d } = deps();
  let seen = null;
  d.sites.tiktokPost = async () => { seen = readLedgerStrict(ledgerPath(sb.data, 'tiktok')).rows.at(-1); return 'redirected-to-content'; };
  await run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, d);
  assert.equal(seen?.status, 'intent');
  assert.equal(seen?.itemId, 'BONA-A');
  const sb2 = sandbox(), slow = deps(), second = deps();
  let release;
  slow.d.sites.tiktokFill = () => new Promise(r => { release = r; });
  const first = run('tiktok', { env: sb2.env, root: sb2.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, slow.d);
  while (!release) await new Promise(r => setTimeout(r, 5));
  await assert.rejects(run('tiktok', { env: sb2.env, root: sb2.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, second.d), /another run holds/);
  assert.ok(!second.calls.includes('tab'));
  release();
  assert.equal((await first).status, 'published');
});

test('fix 6: a literal {{AD_LICENCE}} anywhere in the caption or the rendered text is refused before any browser work', async () => {
  assert.throws(() => tiktokEducationCaption({ ...POOL[0], caption: { ar: 'رقم {{AD_LICENCE}}', en: 'x' } }, { fal: '1' }), /refused/);
  assert.throws(() => linkedinEducationCaption({ ...POOL[0], caption: { ar: 'x', en: 'licence {{AD_LICENCE}}' } }, { fal: '1' }), /refused/);
  assert.throws(() => assertRenderable(renderedStrings({ kind: 'property', listing: { ...A, title: { ar: 'فيلا {{AD_LICENCE}}', en: 'x' } } }, advertiser)), /rendered text refused/);
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.root, 'marketing/daily/content.json'), JSON.stringify([{ ...CONTENT[0], slides: [{ ar: 'ش', en: 's', rows: [['نقدم تقييم مجاني', 'free']] }] }]));
  const x = deps();
  await assert.rejects(run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'education' }, x.d), /rendered text refused/);
  assert.ok(!x.calls.includes('tab') && !x.calls.some(c => Array.isArray(c) && c[0] === 'edu-reel'));
});

test('fix 7: a dry run takes the channel lock, so it cannot discard a live run\'s draft', async () => {
  const sb = sandbox(), lock = lockPath(sb.data, 'tiktok');
  const held = acquireLock(lock); // a live run holding the kernel lock
  const x = deps();
  await assert.rejects(run('tiktok', { dry: true, env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, x.d), /another run holds/);
  assert.deepEqual(x.calls, []);
  held();
});
test('fix 8: ensure-deps never leaves the tree without node_modules when npm ci fails; the unit sets a writable npm cache', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, '../../ops/systemd/ensure-deps.sh');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-deps-'));
  const tree = path.join(tmp, 'tree'), bin = path.join(tmp, 'bin');
  fs.mkdirSync(path.join(tree, 'node_modules'), { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(tree, 'node_modules/marker'), 'old');
  fs.writeFileSync(path.join(tree, 'package.json'), '{}'); fs.writeFileSync(path.join(tree, 'package-lock.json'), '{}');
  // npm ci deletes node_modules where it runs, then fails half way.
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nrm -rf node_modules\nexit 1\n', { mode: 0o755 });
  const r = spawnSync('bash', [script, tree], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BONA_DATA: path.join(tmp, 'data') } });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(tree, 'node_modules/marker'), 'utf8'), 'old');
  const unit = fs.readFileSync(path.join(here, '../../ops/systemd/bona-browser@.service'), 'utf8');
  assert.match(unit, /Environment=npm_config_cache=%h\/bona-data\/\.npm/);
});

test('fix 9: SIGTERM cleanup closes the tab, unstages and releases the lock', async () => {
  const sb = sandbox(), x = deps(), closed = [], unstaged = [];
  x.d.cdp.withTab = async (_u, fn, opts) => { opts.onOpen({ id: 'TAB9' }); try { return await fn({ screenshot: async f => f, ev: async () => null }); } finally { opts.onClose(); } };
  x.d.cdp.closeTab = async id => closed.push(id);
  x.d.cdp.unstage = id => unstaged.push(id);
  let freeDuring = null;
  x.d.sites.tiktokFill = async () => {
    await runCleanups();
    try { acquireLock(lockPath(sb.data, 'tiktok'))(); freeDuring = true; } catch { freeDuring = false; }
    throw Object.assign(new Error('stopped'), { kind: 'sigterm' });
  };
  await assert.rejects(run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, x.d), /stopped/);
  assert.deepEqual(closed, ['TAB9']);
  assert.ok(unstaged.length >= 1);
  assert.equal(freeDuring, true, 'lock released by the SIGTERM cleanup');
  assert.equal(cleanups.size, 0);
});
test('fix 9: reel licence line uses the caption rule (number AND real expiry); popups are only dismissed inside dialogs', async () => {
  assert.ok(!reelLicenceLines({ ...A, licence: { adNumber: '7200000000' } }, advertiser).en.includes('Ad licence'), 'no expiry → no licence line, like the caption');
  assert.ok(reelLicenceLines({ ...A, licence: { adNumber: '7200000000', adExpiry: '2026-12-31' } }, advertiser).en.includes('Ad licence 7200000000 · Expires 2026-12-31'));
  const s = fakeSession({ clickEl: () => null });
  await tiktokDismissPopups(s);
  assert.ok(s.log.clicks.length > 0 && s.log.clicks.every(c => c.includes(JSON.stringify(SELECTORS.tiktok.popupButton))));
  assert.ok(!SELECTORS.tiktok.popupButton.split(',').some(x => x.trim() === 'button'));
});

test('fix 9: TikTok account is re-checked right before Post', async () => {
  const s = fakeSession({ ev: e => isAccount(e) ? 'someoneelse' : 'cap' });
  await assert.rejects(tiktokPost(s, { handle: 'bonarealestatesa', caption: 'cap', polls: 1, every: 0 }), e => e.kind === 'wrong-account' && e.beforeClick);
  assert.equal(s.log.clicks.length, 0);
});

test('fix 9: overseas property keeps the developer-authorisation CTA even when licence lines are passed', async () => {
  const { ctaCard } = await import('../social/lib/cards.mjs');
  const abroad = { ...A, location: { ...A.location, country: { en: 'Oman', ar: 'عُمان' }, countryCode: 'OM' }, country: 'Oman' };
  const plain = await ctaCard(540, 960, { l: abroad });
  const withLines = await ctaCard(540, 960, { l: abroad, licenceLines: { ar: 'المعلن', en: 'Advertiser' } });
  assert.ok(plain.equals(withLines));
});

// ================================================================== review round 2 (Codex HOLD)
import vm from 'node:vm';
import { spawn } from 'node:child_process';

// A DOM just big enough for the candidate extractor: attribute and class selectors, comma lists, closest().
class El {
  constructor(tag, attrs = {}, kids = [], text = '') { this.tag = tag; this.attrs = attrs; this.kids = kids; this.text = text; this.parent = null; for (const k of kids) k.parent = this; }
  getAttribute(n) { return this.attrs[n] ?? null; }
  get parentElement() { return this.parent; }
  get innerText() { return [this.text, ...this.kids.map(k => k.innerText)].filter(Boolean).join(' '); }
  matches(sel) {
    return sel.split(',').some(part => {
      const p = part.trim();
      return [...p.matchAll(/\.([\w-]+)|\[([\w-]+)(?:([\^*]?=)"([^"]*)")?\]/g)].every(([, cls, attr, op, val]) => {
        if (cls) return String(this.attrs.class ?? '').split(/\s+/).includes(cls);
        const v = this.attrs[attr];
        if (v == null) return false;
        return !op || (op === '=' ? v === val : op === '^=' ? v.startsWith(val) : v.includes(val));
      });
    });
  }
  closest(sel) { for (let e = this; e; e = e.parent) if (e.matches?.(sel)) return e; return null; }
  querySelectorAll(sel) { const out = []; const walk = e => { for (const k of e.kids) { if (k.matches(sel)) out.push(k); walk(k); } }; walk(this); return out; }
}
const domSession = root => ({ ev: async expr => vm.runInNewContext(expr, { document: root }) });

test('round 2 fix 2: binding uses the post\'s OWN text node — not a reshared post or a comment that quotes the caption', async () => {
  const caption = 'Villa BONA-A\nFor sale\n\n#BonaRealEstate';
  const ours = new El('div', { 'data-urn': 'urn:li:activity:2000000001' }, [new El('div', { class: 'update-components-text' }, [], 'Villa BONA-A For sale #BonaRealEstate')]);
  const resharer = new El('div', { 'data-urn': 'urn:li:activity:2000000002' }, [
    new El('div', { class: 'update-components-text' }, [], 'Look at this'),
    new El('div', { 'data-urn': 'urn:li:share:2000000003' }, [new El('div', { class: 'update-components-text' }, [], 'old text')]),
    new El('div', { class: 'comments-comments-list' }, [new El('div', { class: 'update-components-text' }, [], 'Villa BONA-A For sale #BonaRealEstate')]),
  ]);
  const root = new El('main', {}, [resharer]);
  const c1 = await SITES.linkedinPostCandidates(domSession(root));
  assert.equal(SITES.bindNewPost(c1, [], { caption, evidence: 'BONA-A' }), null, 'a comment quoting the caption does not make the outer post ours');
  root.kids.push(ours); ours.parent = root;
  const c2 = await SITES.linkedinPostCandidates(domSession(root));
  assert.equal(SITES.bindNewPost(c2, [], { caption, evidence: 'BONA-A' }), 'activity:2000000001');
});

test('round 2 fix 2: the FULL caption must match (not a 40-char prefix) and the evidence must be there', () => {
  const caption = 'فيلا بشاطئ خاص، درة العروس\nدرة العروس، جدة · للبيع\n\nBONA-001\n\n#بونا';
  const sub = { caption, evidence: 'BONA-001' };
  assert.equal(SITES.bindNewPost([{ key: '7', text: 'فيلا بشاطئ خاص، درة العروس — another listing BONA-009' }], [], sub), null, 'same first line, different post');
  assert.equal(SITES.bindNewPost([{ key: '7', text: 'فيلا بشاطئ خاص، درة العروس درة العروس، جدة · للبيع BONA-001 hashtag#بونا ✨ …see more' }], [], sub), '7', 'only whitespace / hashtag-link / emoji / see-more differ');
  assert.equal(SITES.bindNewPost([{ key: '7', text: 'Topic one Text' }], [], { caption: 'Topic one\nText', evidence: 'Topic two' }), null, 'the evidence line must be present');
});

test('round 2 fix 3: baselines settle on rendered posts or an explicit empty state — never on the Start-a-post box', () => {
  const doc = ({ text = '', feed = 0, grid = 0, links = 0 }) => {
    const box = { innerText: text };
    return { body: box, querySelector: () => box,
      querySelectorAll: sel => Array(/data-urn/.test(sel) ? feed : /user-post-item/.test(sel) ? grid : /\/video\//.test(sel) ? links : 0).fill({}) };
  };
  const on = (expr, d) => Boolean(vm.runInNewContext(expr, { document: d }));
  const filler = 'Start a post Video Photo Write article '.repeat(5);
  assert.equal(on(SITES.postsSettled, doc({ text: filler })), false, 'admin: only the composer box');
  assert.equal(on(SITES.postsSettled, doc({ text: filler, feed: 1 })), true);
  assert.equal(on(SITES.publicSettled, doc({ text: filler })), false, 'public: long text is not a loaded feed');
  assert.equal(on(SITES.publicSettled, doc({ text: "Your page doesn’t have any posts from the last 90 days" })), true);
  assert.equal(on(SITES.profileSettled, doc({ text: 'No content' })), false, 'TikTok: a generic word is not the empty state');
  assert.equal(on(SITES.profileSettled, doc({ text: 'Upload your first video Your videos will appear here' })), true);
  assert.equal(on(SITES.profileSettled, doc({ grid: 2 })), true);
  assert.equal(on(SITES.studioSettled, doc({ text: 'No posts yet' })), false, 'Studio needs both empty-state lines');
  assert.equal(on(SITES.studioSettled, doc({ text: 'No posts yet Your posted and scheduled videos will appear here' })), true);
});

test('round 2 fix 4: account and Page actor are re-checked AFTER the last readiness wait, right before the one click', async () => {
  let ready = false;
  const tt = fakeSession({ ev: e => isAccount(e) ? (ready ? 'someoneelse' : 'bonarealestatesa') : 'cap' });
  tt.waitFor = async () => { ready = true; return true; };
  await assert.rejects(SITES.tiktokPost(tt, { handle: 'bonarealestatesa', caption: 'cap', polls: 1, every: 0 }), e => e.kind === 'wrong-account' && e.beforeClick);
  assert.equal(tt.log.clicks.length, 0);
  const company = { entityUrn: 'urn:li:fs_normalized_company:145349037', name: 'Bona | بونا', logoAsset: 'urn:li:digitalmediaAsset:A1', canAdmin: true };
  let waited = false;
  const li = fakeSession({ ev: e => e.includes('/voyager/api/organization/companies/') ? (waited ? { ...company, canAdmin: false } : company) : isActorRead(e) ? composer()(e) : 'cap' });
  li.waitFor = async () => { waited = true; return true; };
  await assert.rejects(SITES.linkedinPost(li, { companyId: '145349037', pageName: 'Bona | بونا', caption: 'cap' }), e => e.kind === 'wrong-actor' && e.beforeClick);
  assert.equal(li.log.clicks.length, 0);
});
test('round 2 fix 5: a caption mismatch found before the click is confirmed-not-published, not uncertain', async () => {
  const s = fakeSession({ ev: e => isAccount(e) ? 'bonarealestatesa' : 'something else' });
  await assert.rejects(SITES.tiktokPost(s, { handle: 'bonarealestatesa', caption: 'cap', polls: 1, every: 0 }), e => e.kind === 'caption-mismatch' && e.beforeClick === true);
  const li = fakeSession({ ev: () => 'something else' });
  await assert.rejects(SITES.linkedinPost(li, { caption: 'cap' }), e => e.kind === 'caption-mismatch' && e.beforeClick === true);
  const sb = sandbox(), x = deps();
  x.d.sites.tiktokPost = (_s, o) => SITES.tiktokPost(fakeSession({ ev: e => isAccount(e) ? 'bonarealestatesa' : 'drifted caption' }), { ...o, polls: 1, every: 0 });
  await assert.rejects(run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, x.d), e => !e.uncertain);
  assert.deepEqual(readLedgerStrict(ledgerPath(sb.data, 'tiktok')).rows.map(r => r.status), ['intent', 'confirmed-not-published']);
});


// ================================================================== review round 3 (Codex HOLD)
const libDaily = path.join(path.dirname(fileURLToPath(import.meta.url)), '../social/lib/browser-daily.mjs');
const holder = (lock, extra = '') => spawn(process.execPath, ['--input-type=module', '-e',
  `import { acquireLock } from ${JSON.stringify(libDaily)}; try { acquireLock(${JSON.stringify(lock)}); console.log('GOT'); } catch { console.log('NO'); } ${extra}`]);
const firstLine = c => new Promise(res => { let out = ''; c.stdout.on('data', d => { out += d; if (out.includes('\n')) res(out.trim()); }); c.on('close', () => res(out.trim())); });

test('round 3 fix 1: the channel lock is a kernel flock — one winner across processes, freed the instant a holder is SIGKILLed, file contents irrelevant', async () => {
  for (let round = 0; round < 3; round++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-flock-'));
    const lock = path.join(dir, '.publish.lock'), go = path.join(dir, 'go');
    fs.writeFileSync(lock, '999999999 deadbeef stale\n');
    const kids = Array.from({ length: 10 }, () => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(libDaily)}; import fs from 'node:fs';
        while (!fs.existsSync(${JSON.stringify(go)})) {}
        let r; try { r = acquireLock(${JSON.stringify(lock)}); console.log('GOT'); } catch { console.log('NO'); }
        setTimeout(() => r?.(), 1500);`]);
      return new Promise(res => { let out = ''; c.stdout.on('data', d => { out += d; }); c.on('close', () => res(out.trim())); });
    });
    setTimeout(() => fs.writeFileSync(go, ''), 700);
    assert.equal((await Promise.all(kids)).filter(x => x === 'GOT').length, 1, `round ${round}: exactly one winner`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-flock-'));
  const lock = path.join(dir, '.publish.lock');
  const h = holder(lock, 'setInterval(() => {}, 1000);');
  assert.equal(await firstLine(h), 'GOT');
  // A dead pid written into the file means nothing: the kernel, not the file, says who holds it.
  fs.writeFileSync(lock, '999999999 deadbeef\n');
  assert.throws(() => acquireLock(lock), /another run holds/);
  h.kill('SIGKILL');
  await new Promise(r => h.on('close', r));
  const mine = acquireLock(lock); // no staleness wait, no takeover: free at once
  mine();
});

test('round 3 fix 1: under the unit, the inherited flock fd is verified, never trusted blind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-flock-'));
  const lock = path.join(dir, '.publish.lock'), other = path.join(dir, 'other.lock');
  const probe = `import { acquireLock } from ${JSON.stringify(libDaily)}; try { acquireLock(process.argv[1]); console.log('verified'); } catch (e) { console.log('refused'); }`;
  const wrap = (target) => spawnSync('bash', ['-c', `exec 9>>"$1" && /usr/bin/flock -n -E 75 9 && BONA_LOCK_FD=9 exec "$3" --input-type=module -e "$4" "$2"`, 'x', target, lock, process.execPath, probe], { encoding: 'utf8' }).stdout.trim();
  assert.equal(wrap(lock), 'verified', 'ExecStart holds it on fd 9, node checks fd 9 is this file and holds it');
  assert.equal(wrap(other), 'refused', 'an fd on some other file is refused');
  const unit = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../ops/systemd/bona-browser@.service'), 'utf8');
  assert.match(unit, /ExecStart=.*\/usr\/bin\/flock -n -E 75 9 && BONA_LOCK_FD=9 exec node scripts\/social\/browser-publish\.mjs/);
});

test('round 3 fix 2: a nested / reshared container is never a candidate, even when it carries the submitted caption', async () => {
  const caption = 'Villa BONA-A\nFor sale\n\n#BonaRealEstate';
  const nested = new El('div', { 'data-urn': 'urn:li:share:3000000002' }, [new El('div', { class: 'update-components-text' }, [], 'Villa BONA-A For sale #BonaRealEstate')]);
  const outer = new El('div', { 'data-urn': 'urn:li:activity:3000000001' }, [new El('div', { class: 'update-components-text' }, [], 'Reposting this'), nested]);
  const root = new El('main', {}, [outer]);
  const c = await SITES.linkedinPostCandidates(domSession(root));
  assert.equal(c.map(x => x.key).join(','), 'activity:3000000001', 'only the top-level post');
  assert.equal(SITES.bindNewPost(c, [], { caption, evidence: 'BONA-A' }), null);
});

test('round 3 fix 3: LinkedIn — company record first, then actor read and button target in ONE evaluation, then only the click', async () => {
  const company = { entityUrn: 'urn:li:fs_normalized_company:145349037', name: 'Bona | بونا', logoAsset: 'urn:li:digitalmediaAsset:A1', canAdmin: true };
  const s = fakeSession({ ev: e => e.includes('/voyager/api/organization/companies/') ? company : isActorRead(e) ? composer()(e) : e.includes('toast') ? 'https://www.linkedin.com/feed/update/urn:li:activity:1/' : 'cap' });
  await SITES.linkedinPost(s, { companyId: '145349037', pageName: 'Bona | بونا', caption: 'cap' });
  const ops = s.log.ops, i = ops.indexOf('actor-read');
  assert.ok(i > 0, 'the actor is read in the combined evaluation');
  assert.equal(ops[i + 1], 'clickAt', `nothing between the actor read and the click (got ${ops.slice(i, i + 3)})`);
  assert.deepEqual(s.log.clicks, ['clickAt 12,23'], 'clicked at the button the same evaluation measured');
});

test('round 3 fix 4: long captions are read in full — LinkedIn from the post\'s own page with "see more" expanded, TikTok from Studio\'s full row (since 2026-11-11)', async () => {
  const caption = 'Villa BONA-A\n' + 'Long line of the property description. '.repeat(12) + '\n#BonaRealEstate';
  const full = caption.replace(/\n/g, ' '), clamped = full.slice(0, 120) + '…see more';
  let expanded = false;
  const li = fakeSession({ ev: (e, cur) => {
    if (e.startsWith('/*expand*/')) { if (cur.includes('/feed/update/')) expanded = true; return 1; }
    if (e.includes('flatMap')) return [{ key: 'activity:4000000001', text: cur.includes('/feed/update/') && expanded ? full : clamped }];
    return null; } });
  assert.equal(await linkedinConfirm(li, '145349037', [], { caption, evidence: 'BONA-A', timeoutMs: 30, every: 0, settleMs: 0 }), 'https://www.linkedin.com/feed/update/urn:li:activity:4000000001/');
  assert.ok(li.log.navs.includes('https://www.linkedin.com/feed/update/urn:li:activity:4000000001/'));
  // TikTok (since 2026-11-11): Studio's list row shows the whole description; a shortened one never binds.
  const tt = fakeSession({ ev: e => (e.includes('/*studio-rows*/') ? [{ key: '555', text: `00:20\n${full}\nNov 11, 9:47 PM` }] : null) });
  assert.equal(await tiktokConfirm(tt, 'bonarealestatesa', [], { caption, evidence: 'BONA-A', timeoutMs: 30, every: 0, settleMs: 0 }), 'https://www.tiktok.com/@bonarealestatesa/video/555');
  const ttCut = fakeSession({ ev: e => (e.includes('/*studio-rows*/') ? [{ key: '555', text: full.slice(0, 90) + '… more' }] : null) });
  assert.equal(await tiktokConfirm(ttCut, 'bonarealestatesa', [], { caption, evidence: 'BONA-A', timeoutMs: 30, every: 0, settleMs: 0 }), null);
  // Not loosened: a clamped text alone never binds.
  assert.equal(SITES.bindNewPost([{ key: 'k', text: clamped }], [], { caption, evidence: 'BONA-A' }), null);
});

test('round 3 fix 5: the runbook names the Voyager fields relied on and shows what a refusal looks like in the journal', () => {
  const doc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/browser-publishing.md'), 'utf8');
  assert.match(doc, /## Voyager fields relied on/);
  for (const f of ['entityUrn', 'name', 'logos.logo.digitalmediaAsset', 'viewerPermissions.canUpdateOrganizationProfile']) assert.ok(doc.includes(f), f);
  assert.match(doc, /## What a refusal looks like/);
  assert.match(doc, /"status":"needs-attention"/);
  assert.match(doc, /wrong-actor/);
});

// ------------------------------------------------ 2026-10-21: property every day, 14-day repeats with varied frames
test('run: an even day posts a property on TikTok and LinkedIn without --kind', async () => {
  const even = new Date('2026-10-22T18:45:00Z'), evenLi = new Date('2026-10-22T06:30:00Z');
  assert.equal(epochDay('2026-10-22') % 2, 0);
  const sb = sandbox();
  const tt = await run('tiktok', { env: sb.env, root: sb.root, now: even, clock: () => even, log: quiet }, deps().d);
  assert.equal(tt.choice.kind, 'property');
  const li = await run('linkedin', { env: sb.env, root: sb.root, now: evenLi, clock: () => evenLi, log: quiet }, deps().d);
  assert.equal(li.choice.kind, 'property');
});

test('run: the policy repeatDays is the browser channels\' interval, and a repeat re-renders the reel from a varied order of the approved frames', async () => {
  const sb = sandbox({ repeatDays: 14 });
  const file = ledgerPath(sb.data, 'tiktok');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A posted on 10-07 (14 Riyadh days before NOW), B posted yesterday: A is due again, as a repeat.
  fs.writeFileSync(file, [
    { channel: 'tiktok', date: '2026-10-07', id: 'bona-tiktok-2026-10-07', kind: 'property', itemId: 'BONA-A', listingId: 'BONA-A', status: 'published', url: 'u1', at: '2026-10-07T19:00:00Z' },
    { channel: 'tiktok', date: '2026-10-20', id: 'bona-tiktok-2026-10-20', kind: 'property', itemId: 'BONA-B', listingId: 'BONA-B', status: 'published', url: 'u2', at: '2026-10-20T19:00:00Z' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const { d, calls } = deps();
  const r = await run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet }, d);
  assert.equal(r.status, 'published');
  assert.equal(r.choice.itemId, 'BONA-A');
  assert.deepEqual(r.choice.frameOrder, [2, 3, 1], 'the second post has another cover');
  const urls = REVIEWS[A.id].photos.map(x => x.url);
  assert.deepEqual(calls.find(c => c[0] === 'download')[1], [urls[1], urls[2], urls[0]], 'only the approved frames, in the new order');
  assert.deepEqual(calls.find(c => c[0] === 'reel')[3], [1, 2, 0].map((i, k) => `${k + 1}-${path.basename(urls[i])}`), 'the reel is rendered in that order');
  assert.equal(r.caption, tiktokPropertyCaption(A, advertiser, REVIEWS[A.id]), 'the reviewed caption, unchanged');
  const rows = readLedger(file);
  assert.deepEqual(rows.at(-1).frameOrder, [2, 3, 1]);
  // The first post of a listing keeps the reviewed order.
  const first = deps();
  const li = await run('linkedin', { env: sb.env, root: sb.root, now: new Date('2026-10-21T06:30:00Z'), clock: () => new Date('2026-10-21T06:30:00Z'), log: quiet }, first.d);
  assert.deepEqual(li.choice.frameOrder, [1, 2, 3]);
  assert.deepEqual(first.calls.find(c => c[0] === 'download')[1], urls);
  // Inside the interval nothing repeats: with 30 days A (posted 14 days ago) is not due.
  const sb30 = sandbox({ repeatDays: 30 });
  fs.mkdirSync(path.dirname(ledgerPath(sb30.data, 'tiktok')), { recursive: true });
  fs.copyFileSync(path.join(path.dirname(file), 'published.jsonl'), ledgerPath(sb30.data, 'tiktok'));
  const lines = readLedger(ledgerPath(sb30.data, 'tiktok')).filter(x => x.date !== '2026-10-21');
  fs.writeFileSync(ledgerPath(sb30.data, 'tiktok'), lines.map(x => JSON.stringify(x)).join('\n') + '\n');
  const r30 = await run('tiktok', { env: sb30.env, root: sb30.root, now: NOW, clock: () => NOW, log: quiet }, deps().d);
  assert.equal(r30.choice.kind, 'education');
});

test('run: a LinkedIn repeat re-encodes the approved frames in a new order, never the last posted one, with the reviewed caption and frameOrder in the ledger', async () => {
  const sb = sandbox({ repeatDays: 14 });
  const file = ledgerPath(sb.data, 'linkedin');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const urls = REVIEWS[A.id].photos.map(x => x.url);
  fs.writeFileSync(file, [
    { channel: 'linkedin', date: '2026-10-07', id: 'bona-linkedin-2026-10-07', kind: 'property', itemId: 'BONA-A', listingId: 'BONA-A', status: 'published', url: 'u1', frameOrder: [1, 2, 3], at: '2026-10-07T06:40:00Z' },
    { channel: 'linkedin', date: '2026-10-20', id: 'bona-linkedin-2026-10-20', kind: 'property', itemId: 'BONA-B', listingId: 'BONA-B', status: 'published', url: 'u2', at: '2026-10-20T06:40:00Z' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const at = new Date('2026-10-21T06:30:00Z'), { d, calls } = deps();
  const r = await run('linkedin', { env: sb.env, root: sb.root, now: at, clock: () => at, log: quiet }, d);
  assert.equal(r.status, 'published');
  assert.equal(r.choice.itemId, 'BONA-A');
  assert.deepEqual(r.choice.frameOrder, [2, 3, 1]);
  const [, got, photos] = calls.find(c => c[0] === 'download');
  assert.deepEqual(got, [urls[1], urls[2], urls[0]]);
  assert.deepEqual(new Set(photos.map(x => x.sha256)), new Set(REVIEWS[A.id].photos.map(x => x.sha256)), 'the approved frames and hashes, nothing added');
  assert.ok(photos.every(x => x.visuallyApproved === true));
  assert.deepEqual(calls.find(c => c[0] === 'li-encode')[1], [1, 2, 0].map((i, k) => `${k + 1}-${path.basename(urls[i])}`), 'encoded in that order');
  assert.equal(r.caption, linkedinPropertyCaption(A, advertiser, REVIEWS[A.id]), 'the reviewed caption, unchanged');
  const last = readLedger(file).at(-1);
  assert.equal(last.status, 'published');
  assert.deepEqual(last.frameOrder, [2, 3, 1]);
  assert.deepEqual(last.images, [urls[1], urls[2], urls[0]]);
  // The ledger says 2,3,1 was posted last (e.g. by hand): the next repeat avoids it even at the same count.
  const sb2 = sandbox({ repeatDays: 14 });
  fs.mkdirSync(path.dirname(ledgerPath(sb2.data, 'linkedin')), { recursive: true });
  fs.writeFileSync(ledgerPath(sb2.data, 'linkedin'), JSON.stringify({ channel: 'linkedin', date: '2026-10-07', id: 'bona-linkedin-2026-10-07', kind: 'property', itemId: 'BONA-A', listingId: 'BONA-A', status: 'published', url: 'u1', manual: true, images: [urls[1], urls[2], urls[0]], at: '2026-10-07T06:40:00Z' }) + '\n'
    + JSON.stringify({ channel: 'linkedin', date: '2026-10-20', id: 'bona-linkedin-2026-10-20', kind: 'property', itemId: 'BONA-B', listingId: 'BONA-B', status: 'published', url: 'u2', at: '2026-10-20T06:40:00Z' }) + '\n');
  const r2 = await run('linkedin', { env: sb2.env, root: sb2.root, now: at, clock: () => at, log: quiet }, deps().d);
  assert.deepEqual(r2.choice.frameOrder, [3, 1, 2]);
});

// ------------------------------------------- 2026-11-08: unblock (lnkd.in binding, block pages, Kuma, own Chrome)
// The real 2026-10-21 LinkedIn post: the caption as submitted (its `intent` line) and the text LinkedIn
// published (the Page's public post, urn:li:activity:7518559300538146817). Only the link differs:
// LinkedIn swapped the listing URL for its own short link, so the post was never bound and the channel
// blocked itself for 18 days.
const LI_1021_CAPTION = 'Private Beach Villa, Durrat Al Arous\nDurrat Al Arous, Jeddah · For sale\n\n5 bedrooms · 537 m² plot · SAR 8,000,000\n\nInterested? Message Bona with BONA-001 for current availability and a viewing.\nhttps://bona-real-estate.com/properties/private-beach-villa-durrat-al-arous/\n\nPrices shown are asking prices and may change. Details, condition and services are confirmed at viewing.\nAdvertiser: Abdulaziz Zaidan · FAL 1100313556 · +966593296933\n\nفيلا بشاطئ خاص، درة العروس — درة العروس، جدة · للبيع\nالمعلن: عبدالعزيز زيدان · فال 1100313556 · +966593296933\n\n#BonaRealEstate #JeddahRealEstate #JeddahVillas #DurratAlArous #SaudiRealEstate';
const LI_1021_LIVE = LI_1021_CAPTION.replace('https://bona-real-estate.com/properties/private-beach-villa-durrat-al-arous/', 'https://lnkd.in/dnG_C5SM');

test('2026-11-08: a post whose link LinkedIn shortened to lnkd.in still binds — and nothing else is loosened', () => {
  const sub = { caption: LI_1021_CAPTION, evidence: 'BONA-001' };
  const key = 'activity:7518559300538146817';
  const LI = { shortLinks: true }; // LinkedIn's confirm passes it; TikTok's never does (R4 item 3)
  assert.equal(SITES.bindNewPost([{ key, text: LI_1021_LIVE }], [], sub, LI), key, 'the real 10-21 post');
  // As the feed renders it: hashtag links, a clamp control, the short link without its scheme.
  const dom = LI_1021_LIVE.replace(/#(\w+)/g, 'hashtag#$1').replace('https://lnkd.in/dnG_C5SM', 'lnkd.in/dnG_C5SM') + ' …see more';
  assert.equal(SITES.bindNewPost([{ key, text: dom }], [], sub, LI), key, 'feed rendering of the same post');
  assert.equal(SITES.bindNewPost([{ key: '7500000000000000001', text: LI_1021_CAPTION }], [], sub), '7500000000000000001', 'a site that keeps the link as typed (TikTok)');
  // Still strict everywhere else.
  assert.equal(SITES.bindNewPost([{ key, text: LI_1021_LIVE }], [key], sub, LI), null, 'already in the baseline');
  assert.equal(SITES.bindNewPost([{ key, text: LI_1021_LIVE.replace('SAR 8,000,000', 'SAR 9,000,000') }], [], sub, LI), null, 'a changed price is another post');
  assert.equal(SITES.bindNewPost([{ key, text: LI_1021_LIVE.replaceAll('BONA-001', 'BONA-002') }], [], { caption: LI_1021_CAPTION.replaceAll('BONA-001', 'BONA-002'), evidence: 'BONA-001' }, LI), null, 'the evidence must be there');
  assert.equal(SITES.bindNewPost([{ key, text: LI_1021_LIVE.replace('https://lnkd.in/dnG_C5SM\n', '') }], [], sub, LI), null, 'a missing link is a difference too');
  // Codex P0: only the caption's own addresses and lnkd.in short links are tokens; any other link stays literal.
  assert.equal(SITES.bindNewPost([{ key, text: LI_1021_LIVE.replace('https://lnkd.in/dnG_C5SM', 'https://example.org/elsewhere') }], [], sub, LI), null, 'a post linking somewhere else');
  assert.equal(SITES.bindNewPost([{ key, text: LI_1021_LIVE.replace('https://lnkd.in/dnG_C5SM', SITES.LINK_TOKEN) }], [], sub, LI), null, 'the token itself in a post means nothing');
  assert.equal(SITES.bindNewPost([{ key, text: LI_1021_LIVE.replace('https://lnkd.in/dnG_C5SM', '‹link›') }], [], sub, LI), null);
  // Education captions carry a bare domain; LinkedIn may link or shorten it.
  const edu = 'Topic one\n\nText\nBona · FAL 1100313556 · bona-real-estate.com\n#BonaRealEstate';
  assert.equal(SITES.bindNewPost([{ key: 'share:1', text: edu.replace('bona-real-estate.com', 'https://lnkd.in/eXyZ12') }], [], { caption: edu, evidence: 'Topic one' }, LI), 'share:1');
  assert.equal(SITES.bindNewPost([{ key: 'share:1', text: edu }], [], { caption: edu, evidence: 'Topic one' }, LI), 'share:1');
  assert.equal(SITES.bindNewPost([{ key: 'share:1', text: edu.replace('bona-real-estate.com', 'https://bona-real-estate.com') }], [], { caption: edu, evidence: 'Topic one' }, LI), 'share:1', 'Codex R2: a scheme added to the bare domain');
  assert.equal(SITES.bindNewPost([{ key: 'share:1', text: edu.replace('bona-real-estate.com', 'https://bona-real-estate.co') }], [], { caption: edu, evidence: 'Topic one' }, LI), null, 'but not another domain');
  // The token never swallows the facts the binding relies on.
  const facts = 'BONA-001 · SAR 8,000,000 · 537 m² · FAL 1100313556 · +966593296933 · فال https://bona-real-estate.com/p/';
  const t = SITES.bindText(facts, SITES.captionLinks(facts));
  for (const kept of ['BONA-001', '8,000,000', '537 m²', '1100313556', '+966593296933', 'فال']) assert.ok(t.includes(kept), kept);
  assert.ok(!t.includes('bona-real-estate.com'));
});

test('2026-11-08: a post created before the run never binds, even when the baseline missed it (same listing 14 days later)', () => {
  const sub = { caption: LI_1021_CAPTION, evidence: 'BONA-001' };
  const old = 'activity:7518559300538146817'; // 2026-10-21T06:30:25Z
  assert.equal(new Date(SITES.idTime(old)).toISOString(), '2026-10-21T06:30:25.325Z');
  assert.equal(new Date(SITES.idTime('ugcPost:7518559299627921408')).toISOString(), '2026-10-21T06:30:25.108Z');
  const runStart = Date.parse('2026-11-04T06:25:00Z');
  assert.equal(SITES.bindNewPost([{ key: old, text: LI_1021_LIVE }], [], sub, { notBefore: runStart, shortLinks: true }), null, 'the 10-21 post is not the 11-04 post');
  const fresh = `activity:${(BigInt(Date.parse('2026-11-04T06:30:40Z')) << 22n) + 123n}`;
  assert.equal(SITES.bindNewPost([{ key: old, text: LI_1021_LIVE }, { key: fresh, text: LI_1021_LIVE }], [], sub, { notBefore: runStart, shortLinks: true }), fresh);
  const ttNew = String((BigInt(Math.floor(Date.parse('2026-11-04T18:46:00Z') / 1000)) << 32n) + 77n);
  assert.equal(SITES.bindNewPost([{ key: ttNew, text: LI_1021_CAPTION }], [], sub, { notBefore: Date.parse('2026-11-04T18:35:00Z') }), ttNew, 'TikTok ids carry seconds');
  // An id that does not decode to a plausible time is judged by the baseline only (never rejected on time).
  assert.equal(SITES.idTime('5'), null);
  assert.equal(SITES.bindNewPost([{ key: '6', text: LI_1021_LIVE }], [], sub, { notBefore: runStart, shortLinks: true }), '6');
});

const pageFake = ({ url, title = '', body = '', captcha = false, settled = true }) => ({
  navigate: async () => {}, waitFor: async () => settled, url: async () => url,
  ev: async e => (e.includes('captcha') ? captcha : e.includes('document.title') ? { title, body } : null),
});

test('2026-11-08: block pages are recognised by their structure (TikTok 403 error page, Cloudflare), not by a phrase in a feed', async () => {
  const tt = await SITES.tiktokBlocker(pageFake({ url: 'chrome-error://chromewebdata/', title: 'www.tiktok.com', body: 'Access to www.tiktok.com was denied\nYou don\'t have authorization to view this page.\nHTTP ERROR 403\nReload' }));
  assert.equal(tt?.kind, 'blocked');
  assert.match(tt.message, /TikTok refused this browser \(Chrome error page: HTTP ERROR 403\)/);
  const offline = await SITES.tiktokBlocker(pageFake({ url: 'chrome-error://chromewebdata/', body: 'No internet\nERR_INTERNET_DISCONNECTED' }));
  assert.equal(offline?.kind, 'navigation', 'a network error is not a refusal');
  assert.match(offline.message, /ERR_INTERNET_DISCONNECTED/);
  const li = await SITES.linkedinBlocker(pageFake({ url: 'https://www.linkedin.com/company/145349037/admin/page-posts/published/', title: 'Attention Required! | Cloudflare', body: 'Sorry, you have been blocked\nYou are unable to access linkedin.com\nCloudflare Ray ID: a571a1df3a0b809b' }));
  assert.equal(li?.kind, 'blocked');
  assert.match(li.message, /LinkedIn refused this browser/);
  // Codex P1: a real page quoting those phrases (a post, a comment, a job ad) is not a block page.
  const quoting = 'Bona | بونا\nOur post: if you see "HTTP ERROR 403" or "Sorry, you have been blocked", or are unable to access Ejar, call us. Access to ejar.sa was denied?';
  assert.equal(await SITES.linkedinBlocker(pageFake({ url: 'https://www.linkedin.com/company/145349037/posts/', title: 'Bona | بونا: Posts | LinkedIn', body: quoting })), null);
  assert.equal(await SITES.tiktokBlocker(pageFake({ url: 'https://www.tiktok.com/@bonarealestatesa', title: 'Bona Real Estate (@bonarealestatesa) | TikTok', body: quoting })), null);
  // Codex R2: even both Cloudflare lines quoted inside a feed are not Cloudflare's page.
  const both = 'Bona | بونا\nA reader wrote: "Sorry, you have been blocked … Cloudflare Ray ID: 1234" — here is how to fix it.';
  assert.equal(await SITES.linkedinBlocker(pageFake({ url: 'https://www.linkedin.com/company/145349037/posts/', title: 'Bona | بونا: Posts | LinkedIn', body: both })), null);
  assert.equal((await SITES.linkedinBlocker(pageFake({ url: 'https://www.linkedin.com/feed/', title: 'linkedin.com', body: '  Sorry, you have been blocked\nYou are unable to access linkedin.com\nCloudflare Ray ID: a571' }))).kind, 'blocked', 'the page itself, even with another title');
  assert.equal((await SITES.tiktokBlocker(pageFake({ url: 'https://www.tiktok.com/@bonarealestatesa', captcha: true }))).kind, 'captcha', 'captcha still wins');
});

test('2026-11-08: TikTok\'s empty-body 403 fails the navigation itself; it is reported as blocked, also on a video\'s own page', async () => {
  // cdp.navigate: Page.navigate answers errorText for an HTTP error without a body (the 10-21 case).
  // Chrome then shows its own error page; its status says whether the site refused us (403) or just failed (503).
  const errorPageWS = page => class {
    constructor() { setTimeout(() => this.onopen?.()); }
    send(raw) {
      const d = JSON.parse(raw);
      const result = d.method === 'Page.navigate' ? { frameId: 'F', errorText: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' } : d.method === 'Runtime.evaluate' ? { result: { value: page } } : {};
      setTimeout(() => this.onmessage({ data: JSON.stringify({ id: d.id, result }) }));
    }
    close() {}
  };
  const c403 = await connect({ webSocketDebuggerUrl: 'ws://fake/1' }, { WebSocketImpl: errorPageWS('www.tiktok.com\nAccess to www.tiktok.com was denied\nHTTP ERROR 403') });
  await assert.rejects(c403.navigate('https://www.tiktok.com/@bonarealestatesa'), e => e.kind === 'blocked' && /www\.tiktok\.com refused this browser \(HTTP 403/.test(e.message));
  c403.close();
  const c503 = await connect({ webSocketDebuggerUrl: 'ws://fake/2' }, { WebSocketImpl: errorPageWS('This page isn’t working\nHTTP ERROR 503') });
  await assert.rejects(c503.navigate('https://www.tiktok.com/@bonarealestatesa'), e => e.kind === 'navigation' && /answered HTTP 503/.test(e.message), 'a server failure is not a refusal (Codex R2)');
  c503.close();
  const refused = () => Object.assign(new Error('www.tiktok.com refused this browser (HTTP 403, net::ERR_HTTP_RESPONSE_CODE_FAILURE)'), { kind: 'blocked' });
  // The list pages themselves refuse.
  const r1 = { blocked: null };
  const s1 = { ...pageFake({ url: 'https://www.tiktok.com/@bonarealestatesa' }), navigate: async () => { throw refused(); } };
  assert.equal(await SITES.tiktokConfirm(s1, 'bonarealestatesa', [], { caption: 'x BONA-A', evidence: 'BONA-A', report: r1, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  assert.match(r1.blocked, /refused this browser/);
  // Since 2026-11-11 a video's own page (which refused us) is never opened: a new id whose row lacks the caption is just not ours.
  const r2 = { blocked: null }, navs2 = [];
  const s2 = { ...pageFake({ url: SITES.URLS.tiktokContent }),
    navigate: async u => { navs2.push(u); if (u.includes('/video/')) throw refused(); },
    ev: async e => (e.includes('/*studio-rows*/') ? [{ key: '555', text: 'another post' }] : e.includes('captcha') ? false : e.includes('document.title') ? { title: '', body: '' } : null) };
  assert.equal(await SITES.tiktokConfirm(s2, 'bonarealestatesa', [], { caption: 'x BONA-A', evidence: 'BONA-A', report: r2, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  assert.equal(r2.blocked, null);
  assert.ok(navs2.length > 0 && !navs2.some(u => u.includes('/video/')), 'no video page is opened');
  // LinkedIn: a refused list page is reported the same way.
  const r3 = { blocked: null };
  const s3 = { ...pageFake({ url: 'https://www.linkedin.com/company/145349037/posts/' }), navigate: async () => { throw Object.assign(new Error('www.linkedin.com answered with an HTTP error'), { kind: 'blocked' }); } };
  assert.equal(await SITES.linkedinConfirm(s3, '145349037', [], { caption: 'x BONA-A', evidence: 'BONA-A', report: r3, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  assert.match(r3.blocked, /HTTP error/);
});

test('2026-11-08: confirmation reports only a refusal that lasts; the uncertain record and error say why', async () => {
  // A Cloudflare page on the first round, normal pages after: nothing is reported.
  let n = 0;
  const report = { blocked: null };
  const s = { navigate: async () => { n++; }, waitFor: async () => n > 1, url: async () => 'https://www.linkedin.com/company/145349037/posts/',
    ev: async e => (e.includes('document.title') ? { title: n > 1 ? 'Bona' : 'Attention Required! | Cloudflare', body: '' } : e.includes('flatMap') ? [] : null) };
  assert.equal(await SITES.linkedinConfirm(s, '145349037', [], { caption: 'x BONA-A', evidence: 'BONA-A', report, timeoutMs: 40, every: 0, settleMs: 0 }), null);
  assert.ok(n > 1);
  assert.equal(report.blocked, null, 'a transient block is not the reason');
  // Codex R2: a lasting refusal on one page is not hidden by ANOTHER page loading normally.
  const one = { blocked: null };
  let cur = '';
  const half = { navigate: async u => { cur = u; }, url: async () => cur, waitFor: async () => !cur.includes('/admin/'),
    ev: async e => (e.includes('document.title') ? { title: cur.includes('/admin/') ? 'Attention Required! | Cloudflare' : 'Bona', body: '' } : e.includes('flatMap') ? [] : null) };
  assert.equal(await SITES.linkedinConfirm(half, '145349037', [], { caption: 'x BONA-A', evidence: 'BONA-A', report: one, timeoutMs: 40, every: 0, settleMs: 0 }), null);
  assert.match(one.blocked, /LinkedIn refused this browser/, 'the admin list kept refusing while the public list loaded');
  // A block that lasts is.
  const lasting = { blocked: null };
  const li = pageFake({ url: 'https://www.linkedin.com/company/145349037/posts/', title: 'Attention Required! | Cloudflare', settled: false });
  assert.equal(await SITES.linkedinConfirm(li, '145349037', [], { caption: 'x BONA-A', evidence: 'BONA-A', report: lasting, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  assert.match(lasting.blocked, /LinkedIn refused this browser/);
  // Through run(): the ledger's uncertain line and the error carry the reason.
  const sb = sandbox(), x = deps({ confirm: null });
  x.d.sites.tiktokConfirm = async (_s, _h, _b, opts) => { assert.equal(typeof opts.notBefore, 'number', 'drive passes notBefore'); opts.report.blocked = 'TikTok refused this browser (Chrome error page: HTTP ERROR 403)'; return null; };
  await assert.rejects(run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, x.d), e => e.uncertain === true && /refused this browser/.test(e.message));
  const rows = readLedger(ledgerPath(sb.data, 'tiktok'));
  assert.deepEqual(rows.map(r => r.status), ['intent', 'uncertain']);
  assert.match(rows[1].blocked, /HTTP ERROR 403/);
  assert.equal(channelState(rows, 'tiktok', '2026-10-22'), 'uncertain', 'the line with `blocked` still blocks later days');
});

test('2026-11-08: Uptime Kuma hears up on a post, down at once when blocked, down when the day\'s LAST run (by its end) has no post', () => {
  const beat = CLI.browserBeat;
  const at = t => new Date(`2026-11-08T${t}:00+03:00`); // a Sunday: a TikTok day and a LinkedIn day
  const run = (s, e, x) => beat('tiktok', { now: at(s), end: at(e), ...x });
  const blocked = Object.assign(new Error('tiktok: an earlier post is uncertain; check the account'), { uncertain: true });
  const login = Object.assign(new Error('TikTok is not logged in'), { kind: 'not-logged-in' });
  assert.deepEqual(run('21:45', '21:52', { result: { status: 'published' } }), { status: 'up', msg: 'published' });
  assert.deepEqual(run('22:15', '22:15', { result: { status: 'already-published' } }), { status: 'up', msg: 'already-published' });
  assert.equal(run('21:45', '21:45', { error: blocked }).status, 'down', 'blocked: down at the first run, no waiting');
  assert.equal(run('21:45', '21:50', { error: login }), null, 'an early failure may still be retried');
  assert.equal(run('22:35', '22:37', { error: login }), null, 'a missed 22:15 run caught up at 22:35 (Persistent=true) is not the last run');
  assert.deepEqual(run('22:45', '22:47', { error: login }), { status: 'down', msg: 'TikTok is not logged in' });
  assert.equal(run('22:15', '22:50', { error: login }).status, 'down', 'a run still going at 22:45 absorbed that timer start: it is the last');
  assert.equal(run('22:45', '23:40', { error: login }).status, 'down', 'ending after the window still counts');
  assert.equal(run('22:45', '22:46', { result: { status: 'skipped-nothing-eligible' } }).status, 'down');
  assert.equal(run('09:30', '09:30', { result: { status: 'not-due' } }), null, 'outside the window: nothing to say');
  assert.equal(run('21:45', '21:52', { result: { status: 'published' }, dry: true }), null);
  const li = (s, e, x) => beat('linkedin', { now: at(s), end: at(e), ...x });
  assert.equal(li('09:30', '09:35', { error: login }), null);
  assert.equal(li('10:00', '10:29', { error: login }), null);
  assert.equal(li('10:30', '10:33', { error: login }).status, 'down', 'LinkedIn\'s last run is 10:30');
  assert.equal(li('09:30', '09:30', { error: blocked }).status, 'down');
  // --any-time runs outside the window: a post is up and a block is down; anything else says nothing.
  const fri = t => new Date(`2026-11-13T${t}:00+03:00`);
  assert.deepEqual(beat('linkedin', { result: { status: 'published' }, now: fri('15:00'), end: fri('15:05') }), { status: 'up', msg: 'published' });
  assert.equal(beat('linkedin', { error: blocked, now: fri('15:00'), end: fri('15:05') }).status, 'down');
  assert.equal(beat('linkedin', { error: login, now: fri('15:00'), end: fri('15:05') }), null);
  assert.equal(beat('instagram', { result: { status: 'published' }, now: at('21:45') }), null);
  assert.equal(CHANNELS.tiktok.lastRun, '22:45');
  assert.equal(CHANNELS.linkedin.lastRun, '10:30');
  // The last-run times are the timers' last OnCalendar entries.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const ch of ['tiktok', 'linkedin']) {
    const timer = fs.readFileSync(path.join(here, `../../ops/systemd/bona-browser@${ch}.timer`), 'utf8');
    const times = [...timer.matchAll(/OnCalendar=.* (\d\d:\d\d) Asia\/Riyadh/g)].map(m => m[1]).sort();
    assert.equal(times.at(-1), CHANNELS[ch].lastRun, `${ch} timer`);
  }
});

test('2026-11-08: the unit drives Bona\'s own Chrome (:9230), never the shared :9222 one, and its launcher passes no --remote-allow-origins', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const unit = fs.readFileSync(path.join(here, '../../ops/systemd/bona-browser@.service'), 'utf8');
  assert.match(unit, /^Environment=BONA_CDP_URL=http:\/\/localhost:9230$/m);
  assert.match(unit, /^Environment=BONA_CHROME_ENSURE=%h\/bona-publish\/ops\/systemd\/bona-chrome\.sh$/m);
  const sh = fs.readFileSync(path.join(here, '../../ops/systemd/bona-chrome.sh'), 'utf8');
  const code = sh.split('\n').filter(l => !/^\s*#/.test(l)).join('\n'); // the comments explain the flags; only code counts
  assert.match(code, /PORT="\$\{BONA_CHROME_PORT:-9230\}"/);
  assert.doesNotMatch(code, /remote-allow-origins/, 'no web page may open a DevTools socket to the Bona profile');
  assert.doesNotMatch(code, /--headless/, 'a real window: headless announces itself as HeadlessChrome');
  assert.match(sh, /bona-social-chrome/);
  assert.equal(spawnSync('bash', ['-n', path.join(here, '../../ops/systemd/bona-chrome.sh')]).status, 0, 'shell syntax');
  // cmd.exe would expand %…% or split on & before Chrome sees the URL: refused before anything is launched.
  for (const bad of ['https://www.linkedin.com/login?next=%2Fcompany%2F1', 'https://x/?a=1&b=2']) {
    // BONA_CHROME_CMD=/bin/false: even a broken guard can never open a window in the real Bona Chrome.
    const r = spawnSync('bash', [path.join(here, '../../ops/systemd/bona-chrome.sh'), 'show', bad], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, BONA_CHROME_PORT: '1', BONA_CHROME_CMD: '/bin/false', BONA_CHROME_PROFILE: 'C:\\nowhere' } });
    assert.equal(r.status, 2, bad);
  }
});

// ================================================================== round 4 (Claude round-2 items, 2026-11-11)
test('R4 item 1: only 401/403/429 on Chrome\'s error page is a refusal; any other status is "answered HTTP nnn" (navigation)', async () => {
  const err = body => SITES.blockPageProblem('TikTok', 'chrome-error://chromewebdata/', { title: 'www.tiktok.com', body });
  for (const status of ['401', '403', '429']) {
    const e = err(`This page isn’t working\nHTTP ERROR ${status}\nReload`);
    assert.equal(e?.kind, 'blocked', status);
    assert.match(e.message, new RegExp(`TikTok refused this browser \\(Chrome error page: HTTP ERROR ${status}\\)`));
  }
  for (const status of ['404', '410', '500', '503']) {
    const e = err(`This page isn’t working\nHTTP ERROR ${status}\nReload`);
    assert.equal(e?.kind, 'navigation', `${status} is not a refusal`);
    assert.match(e.message, new RegExp(`TikTok answered HTTP ${status}`), status);
    assert.doesNotMatch(e.message, /network error|refused/, status);
  }
  assert.equal(err('Access to www.tiktok.com was denied\nYou don\'t have authorization to view this page.\nHTTP ERROR 403').kind, 'blocked');
  assert.equal(err('This site can’t be reached\nERR_BLOCKED_BY_RESPONSE').kind, 'blocked');
  const offline = err('No internet\nERR_INTERNET_DISCONNECTED');
  assert.equal(offline.kind, 'navigation');
  assert.match(offline.message, /did not load \(Chrome error page: ERR_INTERNET_DISCONNECTED\)/);
  // The same status rule as cdp.navigate's, from one place.
  assert.deepEqual(['401', '403', '404', '429', '500', '503', null].map(CDP.isRefusalStatus), [true, true, false, true, false, false, false]);
});

test('R4 item 2: a post\'s own page that serves a block page WITH a body is checked and reported (LinkedIn Cloudflare); TikTok: Studio\'s own captcha (since 2026-11-11 the only page read)', async () => {
  const CF = { title: 'Attention Required! | Cloudflare', body: 'Sorry, you have been blocked\nYou are unable to access linkedin.com\nCloudflare Ray ID: a571a1df3a0b809b' };
  let cur = '';
  const li = { navigate: async u => { cur = u; }, url: async () => cur,
    waitFor: async cond => (cur.includes('/feed/update/') ? null : true), // the post element never appears on the block page
    ev: async e => (e.includes('document.title') ? (cur.includes('/feed/update/') ? CF : { title: 'Bona | بونا: Posts | LinkedIn', body: '' })
      : e.includes('flatMap') ? (cur.includes('/feed/update/') ? [] : [{ key: 'activity:1000000009', text: 'Villa BONA-A' }]) : null) };
  const r1 = { blocked: null };
  assert.equal(await SITES.linkedinConfirm(li, '145349037', [], { caption: 'Villa BONA-A', evidence: 'BONA-A', report: r1, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  assert.match(r1.blocked ?? '', /LinkedIn refused this browser \(Cloudflare/, 'the refused post page is the reason');
  // TikTok (since 2026-11-11 only Studio's list is read): Studio loads TikTok's captcha instead of the list.
  let tcur = '';
  const tt = { navigate: async u => { tcur = u; }, url: async () => tcur,
    waitFor: async () => null,
    ev: async e => (e.includes('/*studio-rows*/') ? [] : e.includes('captcha_verify') ? tcur.includes('tiktokstudio') : e.includes('document.title') ? { title: '', body: '' } : null) };
  const r2 = { blocked: null };
  assert.equal(await SITES.tiktokConfirm(tt, 'bonarealestatesa', [], { caption: 'x BONA-A', evidence: 'BONA-A', report: r2, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  assert.match(r2.blocked ?? '', /captcha/i);
  // A post page that loads normally is not judged by a phrase in it, and binds as before.
  let ocur = '';
  const ok = { navigate: async u => { ocur = u; }, url: async () => ocur, waitFor: async () => true,
    ev: async e => (e.includes('document.title') ? { title: 'Post | LinkedIn', body: 'Sorry, you have been blocked' } : e.includes('flatMap') ? [{ key: 'activity:1000000009', text: 'Villa BONA-A' }] : null) };
  const r3 = { blocked: null };
  assert.equal(await SITES.linkedinConfirm(ok, '145349037', [], { caption: 'Villa BONA-A', evidence: 'BONA-A', report: r3, timeoutMs: 30, every: 0, settleMs: 0 }), 'https://www.linkedin.com/feed/update/urn:li:activity:1000000009/');
  assert.equal(r3.blocked, null);
});

test('R4 item 3: lnkd.in short links are a link token on LinkedIn only — TikTok never makes them', async () => {
  const sub = { caption: LI_1021_CAPTION, evidence: 'BONA-001' };
  const ttKey = '7500000000000000001';
  assert.equal(SITES.bindNewPost([{ key: ttKey, text: LI_1021_LIVE }], [], sub), null, 'TikTok: a video whose link is lnkd.in/… is not ours');
  assert.equal(SITES.bindNewPost([{ key: ttKey, text: LI_1021_CAPTION }], [], sub), ttKey, 'TikTok keeps the link as typed');
  assert.equal(SITES.bindNewPost([{ key: 'activity:1', text: LI_1021_LIVE }], [], sub, { shortLinks: true }), 'activity:1', 'LinkedIn shortens it');
  assert.ok(!SITES.bindText('a https://lnkd.in/x b').includes(SITES.LINK_TOKEN), 'off by default');
  assert.ok(SITES.bindText('a https://lnkd.in/x b', [], { shortLinks: true }).includes(SITES.LINK_TOKEN));
  // Wired: linkedinConfirm binds the lnkd.in post; tiktokConfirm does not bind the same text.
  const liS = { navigate: async () => {}, url: async () => 'https://www.linkedin.com/x', waitFor: async () => true,
    ev: async e => (e.includes('flatMap') ? [{ key: 'activity:1000000009', text: LI_1021_LIVE }] : null) };
  assert.equal(await SITES.linkedinConfirm(liS, '145349037', [], { ...sub, timeoutMs: 30, every: 0, settleMs: 0 }), 'https://www.linkedin.com/feed/update/urn:li:activity:1000000009/');
  const ttS = { navigate: async () => {}, url: async () => 'https://www.tiktok.com/x', waitFor: async () => true,
    ev: async e => (e.includes('/*studio-rows*/') ? [{ key: '555', text: LI_1021_LIVE }] : null) };
  assert.equal(await SITES.tiktokConfirm(ttS, 'bonarealestatesa', [], { ...sub, timeoutMs: 30, every: 0, settleMs: 0 }), null);
});

test('R4 item 4: a caption link next to punctuation or an emoji is still one token (no false rejection)', () => {
  const li = { shortLinks: true };
  const dot = 'Villa BONA-A. See https://bona-real-estate.com/properties/x/. Call us';
  assert.deepEqual(SITES.captionLinks(dot), ['https://bona-real-estate.com/properties/x/', 'bona-real-estate.com/properties/x/']);
  assert.equal(SITES.bindNewPost([{ key: 'k', text: dot.replace('https://bona-real-estate.com/properties/x/', 'https://lnkd.in/abc') }], [], { caption: dot, evidence: 'BONA-A' }, li), 'k', 'trailing full stop');
  assert.equal(SITES.bindNewPost([{ key: 'k', text: dot }], [], { caption: dot, evidence: 'BONA-A' }), 'k', 'kept as typed');
  const ar = 'فيلا BONA-A شاهد https://bona-real-estate.com/properties/x، اتصل بنا';
  assert.equal(SITES.bindNewPost([{ key: 'k', text: ar.replace('https://bona-real-estate.com/properties/x', 'https://lnkd.in/abc') }], [], { caption: ar, evidence: 'BONA-A' }, li), 'k', 'Arabic comma');
  const emoji = 'Villa BONA-A https://bona-real-estate.com/properties/x🏡 call';
  assert.equal(SITES.bindNewPost([{ key: 'k', text: emoji.replace('https://bona-real-estate.com/properties/x', 'https://lnkd.in/abc') }], [], { caption: emoji, evidence: 'BONA-A' }, li), 'k', 'glued emoji');
  assert.equal(SITES.bindNewPost([{ key: 'k', text: emoji }], [], { caption: emoji, evidence: 'BONA-A' }), 'k', 'glued emoji, kept as typed');
  const paren = 'Villa BONA-A (https://bona-real-estate.com/properties/x) call';
  assert.equal(SITES.bindNewPost([{ key: 'k', text: paren.replace('https://bona-real-estate.com/properties/x', 'https://lnkd.in/abc') }], [], { caption: paren, evidence: 'BONA-A' }, li), 'k', 'closing bracket');
  // Still strict: a longer address that only starts with ours is another link.
  assert.equal(SITES.bindNewPost([{ key: 'k', text: dot.replace('/properties/x/', '/properties/x/y') }], [], { caption: dot, evidence: 'BONA-A' }, li), null);
  assert.equal(SITES.bindNewPost([{ key: 'k', text: ar.replace('/properties/x', '/properties/xy') }], [], { caption: ar, evidence: 'BONA-A' }, li), null);
});

test('R4 item 5: LinkedIn\'s security check is recognised by the page itself, not by a phrase inside a feed', async () => {
  const feed = 'Skip to main content\nHome\nMy Network\nJobs\nMessaging\nNotifications\nMe\nFor Business\n' + 'Bona | بونا\nReal estate · Jeddah\n'.repeat(6) + 'Post: scammers ask you to "verify you\'re human" or run a "quick security check" — never do it. Let\'s do a quick review of the rules.';
  assert.equal(await SITES.linkedinBlocker(pageFake({ url: 'https://www.linkedin.com/company/145349037/posts/', title: 'Bona | بونا: Posts | LinkedIn', body: feed })), null, 'a post quoting the phrases');
  assert.equal((await SITES.linkedinBlocker(pageFake({ url: 'https://www.linkedin.com/company/145349037/posts/', title: 'Security Verification | LinkedIn', body: '' })))?.kind, 'captcha', 'by title');
  assert.equal((await SITES.linkedinBlocker(pageFake({ url: 'https://www.linkedin.com/feed/', title: 'LinkedIn', body: '\nLinkedIn\nLet’s do a quick security check\nPlease verify you’re human' })))?.kind, 'captcha', 'the page begins with it');
  assert.equal((await SITES.linkedinBlocker(pageFake({ url: 'https://www.linkedin.com/checkpoint/challenge/AgF', title: 'LinkedIn', body: '' })))?.kind, 'verification', 'checkpoint URL kept');
});

test('R4 item 7: add-browser-monitors.py stops before touching anything when a monitor must be created and the notification is missing', () => {
  const py = spawnSync('python3', ['--version']);
  if (py.status !== 0) return; // no python3 on this box: the script is run by hand with uv
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kuma-mock-'));
  try {
    fs.mkdirSync(path.join(tmp, 'mod')); fs.mkdirSync(path.join(tmp, 'home', '.secrets'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'home', '.secrets', 'uptime-kuma.env'), 'KUMA_USER=u\nKUMA_PASSWORD=p\nKUMA_URL=https://kuma.example\n');
    fs.writeFileSync(path.join(tmp, 'mod', 'uptime_kuma_api.py'), `
import json, os
LOG = os.environ["MOCK_LOG"]
def log(*a):
    with open(LOG, "a") as f: f.write(json.dumps(a) + "\\n")
class MonitorType: PUSH = "push"
class UptimeKumaApi:
    def __init__(self, *a, **k): pass
    def login(self, *a): pass
    def disconnect(self): log("disconnect")
    def get_monitors(self): return [{"id": 40, "name": "Bona daily post — tiktok", "active": False, "pushToken": "t" * 32, "interval": 93600}]
    def get_notifications(self): return []
    def resume_monitor(self, i): log("resume", i)
    def add_monitor(self, **k): log("add"); return {"monitorID": 41}
    def get_monitor(self, i): return {"id": i, "active": False, "pushToken": "x" * 32}
`);
    const r = spawnSync('python3', [path.join(here, '../../ops/systemd/add-browser-monitors.py'), '--resume'], { encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: path.join(tmp, 'mod'), HOME: path.join(tmp, 'home'), BONA_DATA: path.join(tmp, 'data'), MOCK_LOG: path.join(tmp, 'log') } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /no notification named .*Bona daily post — linkedin/s);
    assert.doesNotMatch(r.stderr, /nothing else changed/);
    assert.doesNotMatch(r.stderr, /Traceback/);
    const calls = fs.existsSync(path.join(tmp, 'log')) ? fs.readFileSync(path.join(tmp, 'log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)[0]) : [];
    assert.deepEqual(calls, ['disconnect'], 'no resume, no create: nothing changed');
    assert.equal(fs.existsSync(path.join(tmp, 'data', 'daily', 'heartbeat-tiktok.url')), false, 'no URL file rewritten');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('R5 (Codex R3 P2): a short header plus a post quoting the phrase in the first lines is still not LinkedIn\'s security check', async () => {
  const at = body => SITES.linkedinBlocker(pageFake({ url: 'https://www.linkedin.com/company/145349037/posts/', title: 'Bona | بونا: Posts | LinkedIn', body }));
  assert.equal(await at('Home\nPost: please verify you’re human before you pay anyone'), null, 'second line quotes it');
  assert.equal(await at('Bona | بونا\nverify you’re human — a scam alert'), null, 'a header that is not the LinkedIn wordmark');
  assert.equal(await at('Scam alert: quick security check messages are fake'), null, 'the phrase inside the first line, not its start');
  assert.equal((await at('LinkedIn\n\nLet’s do a quick security check'))?.kind, 'captcha', 'the wordmark, then the heading');
  assert.equal((await at('  Please verify you’re human'))?.kind, 'captcha', 'the page begins with it');
  assert.equal(SITES.linkedinCheckPage({ title: 'Security Verification | LinkedIn' }), true);
});

// ================================================================== round 6 (Claude R3 reviewers A/B/C, 2026-11-11)
test('R6: LinkedIn\'s security check is matched by a title that BEGINS with "Security Verification"; a post page whose title quotes the phrase still binds', async () => {
  assert.equal(SITES.linkedinCheckPage({ title: 'Bona | بونا on LinkedIn: A quick security check before you sign a lease' }), false);
  assert.equal(SITES.linkedinCheckPage({ title: 'Security Verification | LinkedIn' }), true);
  assert.equal(SITES.linkedinCheckPage({ title: '(3) Security Verification | LinkedIn' }), true, 'a notification count before it');
  // The post element's selector never matches (slow page, or the URN inside a longer attribute), but the post IS on the page.
  const caption = 'Villa BONA-A — a quick security check of the title deed comes with every viewing';
  let cur = '';
  const s = { navigate: async u => { cur = u; }, url: async () => cur, waitFor: async () => (cur.includes('/feed/update/') ? null : true),
    ev: async e => (e.includes('document.title') ? { title: `Bona | بونا on LinkedIn: ${caption}`, body: 'Skip to main content' }
      : e.includes('flatMap') ? [{ key: 'activity:1000000009', text: caption }] : null) };
  const report = { blocked: null };
  assert.equal(await SITES.linkedinConfirm(s, '145349037', [], { caption, evidence: 'BONA-A', report, timeoutMs: 30, every: 0, settleMs: 0 }), 'https://www.linkedin.com/feed/update/urn:li:activity:1000000009/');
  assert.equal(report.blocked, null);
});

test('R6: LinkedIn\'s 999 "Request denied" is a refusal; Cloudflare\'s "used Cloudflare to restrict access" page is a block page', () => {
  assert.equal(CDP.isRefusalStatus('999'), true);
  assert.equal(SITES.blockPageProblem('LinkedIn', 'chrome-error://chromewebdata/', { body: 'This page isn’t working\nHTTP ERROR 999' })?.kind, 'blocked');
  const cf = SITES.blockPageProblem('LinkedIn', 'https://www.linkedin.com/feed/', { title: 'Access denied | www.linkedin.com used Cloudflare to restrict access', body: 'Error 1020' });
  assert.equal(cf?.kind, 'blocked');
  assert.equal(SITES.blockPageProblem('LinkedIn', 'https://www.linkedin.com/feed/', { title: 'Bona | بونا: Posts | LinkedIn', body: 'a post: "www.linkedin.com used Cloudflare to restrict access"' }), null, 'quoted in a feed');
});

test('R6: the HTTP status is read from Chrome\'s own error page only, never from the page that was there before', async () => {
  // The first reads still see the previous document (a feed quoting "HTTP ERROR 403"); then the error page commits with 500.
  let reads = 0;
  const WS = class {
    constructor() { setTimeout(() => this.onopen?.()); }
    send(raw) {
      const d = JSON.parse(raw);
      let result = {};
      if (d.method === 'Page.navigate') result = { frameId: 'F', errorText: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' };
      else if (d.method === 'Runtime.evaluate') {
        const old = reads++ < 2;
        const ctx = { location: { href: old ? 'https://www.linkedin.com/feed/' : 'chrome-error://chromewebdata/', protocol: old ? 'https:' : 'chrome-error:' },
          document: { body: { innerText: old ? 'Post: if you see HTTP ERROR 403, call us' : 'This page isn’t working\nHTTP ERROR 500' } } };
        result = { result: { value: vm.runInNewContext(d.params.expression, ctx) } };
      }
      setTimeout(() => this.onmessage({ data: JSON.stringify({ id: d.id, result }) }));
    }
    close() {}
  };
  const c = await connect({ webSocketDebuggerUrl: 'ws://fake/r6' }, { WebSocketImpl: WS });
  await assert.rejects(c.navigate('https://www.linkedin.com/company/145349037/posts/'), e => e.kind === 'navigation' && /answered HTTP 500/.test(e.message));
  c.close();
});

test('R6: a caption link is ASCII only — text glued to it is not swallowed into the link token', () => {
  const caption = 'Villa BONA-A https://bona-real-estate.com/properties/x/·SAR8,000,000 end';
  assert.deepEqual(SITES.captionLinks(caption), ['https://bona-real-estate.com/properties/x/', 'bona-real-estate.com/properties/x/']);
  assert.equal(SITES.bindNewPost([{ key: 'k', text: 'Villa BONA-A https://lnkd.in/abc end' }], [], { caption, evidence: 'BONA-A' }, { shortLinks: true }), null, 'the price is not part of the link');
  assert.equal(SITES.bindNewPost([{ key: 'k', text: caption.replace('https://bona-real-estate.com/properties/x/', 'https://lnkd.in/abc') }], [], { caption, evidence: 'BONA-A' }, { shortLinks: true }), 'k');
  const ar = 'فيلا BONA-A https://bona-real-estate.com/p/xجدة';
  assert.equal(SITES.bindNewPost([{ key: 'k', text: ar.replace('https://bona-real-estate.com/p/x', 'https://lnkd.in/abc') }], [], { caption: ar, evidence: 'BONA-A' }, { shortLinks: true }), 'k', 'Arabic glued after the link');
});

test('R6: bona-chrome.sh show opens only an https:// URL (never a Chrome switch), and refuses every character cmd.exe would mangle', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sh = path.join(here, '../../ops/systemd/bona-chrome.sh');
  const env = { ...process.env, BONA_CHROME_PORT: '1', BONA_CHROME_CMD: '/bin/false', BONA_CHROME_PROFILE: 'C:\\nowhere' };
  const bad = ['--remote-allow-origins=*', '--headless', 'http://www.linkedin.com/login', 'file:///C:/x', 'javascript:alert(1)',
    ...['&', '^', '|', '<', '>', '"', '%'].map(c => `https://www.linkedin.com/login?a=1${c}b`)];
  for (const url of bad) assert.equal(spawnSync('bash', [sh, 'show', url], { encoding: 'utf8', timeout: 10_000, env }).status, 2, url);
});

function kumaMock(monitors, notifications) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kuma-mock-'));
  fs.mkdirSync(path.join(tmp, 'mod')); fs.mkdirSync(path.join(tmp, 'home', '.secrets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'home', '.secrets', 'uptime-kuma.env'), 'KUMA_USER=u\nKUMA_PASSWORD=p\nKUMA_URL=https://kuma.example\n');
  fs.writeFileSync(path.join(tmp, 'mod', 'uptime_kuma_api.py'), `
import json, os
LOG = os.environ["MOCK_LOG"]
def log(*a):
    with open(LOG, "a") as f: f.write(json.dumps(a) + "\\n")
class MonitorType: PUSH = "push"
class UptimeKumaApi:
    def __init__(self, *a, **k): self.mon = json.loads(os.environ["MOCK_MONITORS"])
    def login(self, *a): pass
    def disconnect(self): log("disconnect")
    def get_monitors(self): return self.mon
    def get_notifications(self): log("get_notifications"); return json.loads(os.environ["MOCK_NOTIFICATIONS"])
    def resume_monitor(self, i): log("resume", i)
    def add_monitor(self, **k): log("add", k["name"], k["interval"], sorted(k["notificationIDList"])); m = {"id": 70 + len(self.mon), "name": k["name"], "active": False, "pushToken": "n" * 32, "interval": k["interval"]}; self.mon.append(m); return {"monitorID": m["id"]}
    def get_monitor(self, i): return next(m for m in self.mon if m["id"] == i)
`);
  const run = (...args) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const r = spawnSync('python3', ['-B', path.join(here, '../../ops/systemd/add-browser-monitors.py'), ...args], { encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: path.join(tmp, 'mod'), HOME: path.join(tmp, 'home'), BONA_DATA: path.join(tmp, 'data'), MOCK_LOG: path.join(tmp, 'log'),
        MOCK_MONITORS: JSON.stringify(monitors), MOCK_NOTIFICATIONS: JSON.stringify(notifications) } });
    const calls = fs.existsSync(path.join(tmp, 'log')) ? fs.readFileSync(path.join(tmp, 'log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
    fs.rmSync(path.join(tmp, 'log'), { force: true });
    return { r, calls, url: ch => path.join(tmp, 'data', 'daily', `heartbeat-${ch}.url`) };
  };
  return { run, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
test('R6: add-browser-monitors.py — existing monitors are resumed without any notification; new ones are created paused with it', (t) => {
  if (spawnSync('python3', ['--version']).status !== 0) { t.skip('no python3 on this box (the script is run by hand with uv)'); return; }
  const have = [{ id: 58, name: 'Bona daily post — tiktok', active: false, pushToken: 't'.repeat(32), interval: 93600 },
    { id: 59, name: 'Bona daily post — linkedin', active: false, pushToken: 'l'.repeat(32), interval: 273600 }];
  const a = kumaMock(have, []);
  try {
    const { r, calls, url } = a.run('--resume');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls, [['resume', 58], ['resume', 59], ['disconnect']], 'no notification lookup when nothing is created');
    for (const ch of ['tiktok', 'linkedin']) {
      assert.equal(fs.statSync(url(ch)).mode & 0o777, 0o600, ch);
      assert.match(fs.readFileSync(url(ch), 'utf8'), /^https:\/\/kuma\.example\/api\/push\/[a-z]{32}\n$/);
    }
    assert.doesNotMatch(r.stdout, /kuma\.example\/api\/push/, 'push URLs are never printed');
  } finally { a.done(); }
  const b = kumaMock([], [{ id: 7, name: 'Telegram — Hermes bot → owner' }]);
  try {
    const { r, calls } = b.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls.filter(c => c[0] === 'add'), [['add', 'Bona daily post — tiktok', 93600, [7]], ['add', 'Bona daily post — linkedin', 273600, [7]]]);
    assert.equal(calls.some(c => c[0] === 'resume'), false, 'created paused, not resumed without --resume');
  } finally { b.done(); }
});

test('R7: when the candidate scan itself fails on a post page, the block page is still checked and reported', async () => {
  let cur = '';
  const s = { navigate: async u => { cur = u; }, url: async () => cur, waitFor: async () => (cur.includes('/feed/update/') ? null : true),
    ev: async e => {
      if (e.includes('document.title')) return cur.includes('/feed/update/') ? { title: 'Attention Required! | Cloudflare', body: '' } : { title: 'Bona', body: '' };
      if (e.includes('flatMap')) { if (cur.includes('/feed/update/')) throw new Error('eval: Execution context was destroyed'); return [{ key: 'activity:1000000009', text: 'Villa BONA-A' }]; }
      return null;
    } };
  const report = { blocked: null };
  assert.equal(await SITES.linkedinConfirm(s, '145349037', [], { caption: 'Villa BONA-A', evidence: 'BONA-A', report, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  assert.match(report.blocked ?? '', /LinkedIn refused this browser \(Cloudflare/);
});

// ================================================================== 2026-11-11: Bona's own Chrome is a real (minimised) window
test('2026-11-11: every tab the publisher opens behaves as focused (focus emulation), before the first navigation', async () => {
  // A tab in Bona's own visible Chrome reports document.hasFocus() === false (the old headless one
  // always counted as focused); TikTok's editor then lost 16 of 574 caption characters in the 11-11 dry run.
  const methods = [], calls = [];
  class Recorder {
    constructor() { setTimeout(() => this.onopen?.()); }
    send(raw) {
      const d = JSON.parse(raw); methods.push(d.method); calls.push(d);
      const result = d.method === 'Runtime.evaluate' ? { result: { value: true } } : {};
      setTimeout(() => {
        this.onmessage({ data: JSON.stringify({ id: d.id, result }) });
        if (d.method === 'Page.navigate') this.onmessage({ data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }) });
      });
    }
    close() {}
  }
  const fetchImpl = async url => {
    if (url.endsWith('/json/version')) return { ok: true, json: async () => ({}) };
    if (url.includes('/json/new')) return { ok: true, json: async () => ({ id: 'TAB1', webSocketDebuggerUrl: 'ws://x' }) };
    if (url.includes('/json/close/')) return { ok: true };
    throw new Error(url);
  };
  assert.equal(await withTab('https://www.tiktok.com/tiktokstudio/upload', async () => 'ok', { fetchImpl, WebSocketImpl: Recorder, ensureScript: null }), 'ok');
  const focus = methods.indexOf('Emulation.setFocusEmulationEnabled');
  assert.ok(focus >= 0, 'focus emulation is set');
  assert.deepEqual(calls[focus].params, { enabled: true }, 'and turned ON');
  assert.ok(focus < methods.indexOf('Page.navigate'), 'before the first page loads');
  assert.ok(!methods.includes('Page.bringToFront'), 'the window is never raised on the owner\'s screen');
});

test('2026-11-11: a caption-box mismatch says WHERE the held text differs, so a failed run can be diagnosed from its log', () => {
  const want = 'نوبال 5، الروضة\nالروضة، جدة · للبيع\n\nBONA-014\n\n#عقارات_جدة #جدة #بونا #BonaRealEstate #AlRawdah';
  assert.throws(() => checkCaptionHeld(want.replace('#BonaRealEstate ', ''), want), e =>
    e.kind === 'caption-mismatch' && /have \d+ chars, want \d+/.test(e.message) && /first difference at char \d+/.test(e.message)
    && /want "BonaRealEstate #AlRawdah"/.test(e.message));
  assert.throws(() => checkCaptionHeld(want.split('\n').slice(1).join('\n'), want), e => /first difference at char 0/.test(e.message) && e.message.includes('نوبال'), 'a dropped first line');
  assert.throws(() => checkCaptionHeld(want.slice(0, -9), want), e => /held text ends early|first difference at char/.test(e.message), 'a cut-off end');
});

// 2026-11-11 21:45 live run: Post went through (BONA-014, video 7706987328367119636, Studio "Nov 11, 9:47 PM, Everyone"),
// but every visit to the video's own page answered HTTP 403 (the profile and Studio loaded each round, Chrome history),
// so the run recorded `uncertain` — the 10-21 case again, now on Bona's own Chrome. Studio's list shows each video's
// FULL description next to its id, so the confirmation binds from there and never opens a public page.
const TT_1111_CAPTION = "نوبال 5، الروضة\nالروضة، جدة · للبيع\n\n3 غرف نوم · المساحة 307 م² · 1,800,000 ريال\n\nتبحث عن منزل بهذه المواصفات؟ راسل بونا بالرقم BONA-014 لمعرفة التوفر وترتيب معاينة.\nhttps://bona-real-estate.com/properties/nobal-five-al-rawdah/\n\nالأسعار المعروضة هي الأسعار المطلوبة وقابلة للتغيير. تُؤكَّد التفاصيل والحالة والخدمات عند المعاينة.\nالمعلن: عبدالعزيز زيدان · فال 1100313556 · +966593296933\n\nNOBAL 5, Al Rawdah · Al Rawdah, Jeddah · For sale Message Bona with BONA-014.\n\n#عقارات_جدة #جدة #بونا #BonaRealEstate #JeddahRealEstate #شقق_جدة #شقق_للبيع #JeddahApartments #الروضة #AlRawdah";
const TT_1111_ROW = `00:20\n${TT_1111_CAPTION.replace(/\n+/g, ' ')}\nNov 11, 9:47 PM\nEveryone\n0\n0\n0`;
const TT_1021_ROW = '00:20\nفيلا بشاطئ خاص، درة العروس درة العروس، جدة · للبيع BONA-001 #بونا\nOct 21, 9:46 PM\nEveryone\n105\n1\n0';
const isRows = e => e.includes('/*studio-rows*/');
/** A tiny DOM: each node has its own text, optional href, children; innerText = own text + children's, one per line. */
function miniDom(tree) {
  const mk = ([text, href, kids = []]) => {
    const e = { text, href, kids: kids.map(mk), parentElement: null,
      get innerText() { return [e.text, ...e.kids.map(k => k.innerText)].filter(Boolean).join('\n'); },
      querySelectorAll(sel) {
        assert.equal(sel, 'a[href*="/video/"]');
        const out = []; const walk = n => { for (const k of n.kids) { if (k.href && k.href.includes('/video/')) out.push(k); walk(k); } }; walk(e); return out;
      } };
    for (const k of e.kids) k.parentElement = e;
    return e;
  };
  const body = mk(tree);
  return { body, querySelectorAll: sel => body.querySelectorAll(sel) };
}
const V = id => `https://www.tiktok.com/@bonarealestatesa/video/${id}`;

test('2026-11-11: TikTok confirm reads only Studio\'s list — never the public profile or a video\'s own page (both refuse this browser)', async () => {
  const s = fakeSession({ ev: e => (isRows(e) ? [{ key: '7706987328367119636', text: TT_1111_ROW }, { key: '7699194501109271829', text: TT_1021_ROW }] : null) });
  const url = await SITES.tiktokConfirm(s, 'bonarealestatesa', ['7699194501109271829'],
    { caption: TT_1111_CAPTION, evidence: 'BONA-014', notBefore: Date.parse('2026-11-11T18:45:01Z'), timeoutMs: 30, every: 0, settleMs: 0 });
  assert.equal(url, V('7706987328367119636'));
  assert.ok(s.log.navs.length > 0 && s.log.navs.every(u => u === SITES.URLS.tiktokContent), `only Studio /content is opened: ${s.log.navs}`);
});

test('2026-11-11: a Studio row binds only when the id is new, created after the run started, and its row holds the full caption + listing id', () => {
  const rows = [{ key: '7706987328367119636', text: TT_1111_ROW }, { key: '7699194501109271829', text: TT_1021_ROW }];
  const sub = { caption: TT_1111_CAPTION, evidence: 'BONA-014' };
  const before = ['7699194501109271829'];
  assert.equal(SITES.idTime('7706987328367119636'), Date.parse('2026-11-11T18:47:00Z'), 'video id time');
  assert.equal(SITES.bindNewPost(rows, before, sub, { notBefore: Date.parse('2026-11-11T18:45:01Z') }), '7706987328367119636');
  assert.equal(SITES.bindNewPost(rows, [...before, '7706987328367119636'], sub), null, 'already in the baseline');
  assert.equal(SITES.bindNewPost(rows, before, sub, { notBefore: Date.parse('2026-11-11T18:48:00Z') }), null, 'created before this run');
  const cut = [{ key: '7706987328367119636', text: TT_1111_ROW.slice(0, 200) + '…' }];
  assert.equal(SITES.bindNewPost(cut, before, sub), null, 'a shortened description never binds');
});

test('2026-11-11: Studio rows — each video\'s text is the largest block around its link that holds no other video', () => {
  const dom = miniDom(['', null, [['TikTok Studio\nUpload\nPosts', null], ['', null, [
    ['Posts (Created on)\nPrivacy\nViews', null],
    ['', null, [['00:20', V('7706987328367119636')], ['', null, [['', V('7706987328367119636'), [[TT_1111_ROW.split('\n')[1], null]]], ['Nov 11, 9:47 PM', null]]], ['Everyone', null]]],
    ['', null, [['00:20', V('7699194501109271829')], ['فيلا BONA-001', null], ['Oct 21, 9:46 PM', null]]],
    ['', 'https://www.tiktok.com/@someoneelse/video/7000000000000000001', [['not ours', null]]],
  ]]]]);
  const rows = JSON.parse(JSON.stringify(vm.runInNewContext(SITES.studioRowsJs('bonarealestatesa'), { document: dom }))); // out of the vm's realm
  assert.deepEqual(rows.map(r => r.key), ['7706987328367119636', '7699194501109271829'], 'only @bonarealestatesa videos, once each');
  assert.ok(rows[0].text.includes('BONA-014') && rows[0].text.includes('Nov 11, 9:47 PM') && !rows[0].text.includes('BONA-001'), rows[0].text);
  assert.ok(rows[1].text.includes('BONA-001') && !rows[1].text.includes('BONA-014'), rows[1].text);
  // A list with one video: the block grows up to (never including) <body>, still that one video only.
  const one = miniDom(['', null, [['', null, [['Posts', null], ['', null, [['00:20', V('7706987328367119636')], ['BONA-014 caption', null]]]]]]]);
  const r1 = JSON.parse(JSON.stringify(vm.runInNewContext(SITES.studioRowsJs('bonarealestatesa'), { document: one })));
  assert.deepEqual(r1.map(r => r.key), ['7706987328367119636']);
  assert.ok(r1[0].text.includes('BONA-014 caption'));
});

test('2026-11-11: a refused or captcha\'d Studio list is the confirmation\'s `blocked` reason', async () => {
  const refused = () => Object.assign(new Error('www.tiktok.com refused this browser (HTTP 403, net::ERR_HTTP_RESPONSE_CODE_FAILURE)'), { kind: 'blocked' });
  const r1 = { blocked: null };
  const s1 = { ...pageFake({ url: SITES.URLS.tiktokContent }), navigate: async () => { throw refused(); } };
  assert.equal(await SITES.tiktokConfirm(s1, 'bonarealestatesa', [], { caption: 'x BONA-A', evidence: 'BONA-A', report: r1, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  assert.match(r1.blocked ?? '', /refused this browser/);
  const r2 = { blocked: null };
  const s2 = pageFake({ url: SITES.URLS.tiktokContent, captcha: true, settled: false });
  assert.equal(await SITES.tiktokConfirm(s2, 'bonarealestatesa', [], { caption: 'x BONA-A', evidence: 'BONA-A', report: r2, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  assert.match(r2.blocked ?? '', /captcha/i);
  // The list loads again and shows the post: bound, and the earlier refusal is no longer the reason.
  const r3 = { blocked: null };
  let n = 0;
  const s3 = { ...pageFake({ url: SITES.URLS.tiktokContent }),
    navigate: async () => { if (n++ === 0) throw refused(); },
    ev: async e => (isRows(e) ? [{ key: '7706987328367119636', text: TT_1111_ROW }] : e.includes('captcha') ? false : e.includes('document.title') ? { title: 'TikTok Studio', body: '' } : null) };
  assert.equal(await SITES.tiktokConfirm(s3, 'bonarealestatesa', [], { caption: TT_1111_CAPTION, evidence: 'BONA-014', report: r3, timeoutMs: 1000, every: 0, settleMs: 0 }), V('7706987328367119636'));
  assert.equal(r3.blocked, null);
});
