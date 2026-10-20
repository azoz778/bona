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

test('property and education alternate by day, across a month end, and each falls back to the other', () => {
  assert.equal(epochDay('2026-10-31') + 1, epochDay('2026-11-01'));
  assert.notEqual(preferredKind('2026-10-31'), preferredKind('2026-11-01'));
  const odd = ['2026-10-20', '2026-10-21'].find(d => preferredKind(d) === 'property');
  const even = ['2026-10-20', '2026-10-21'].find(d => preferredKind(d) === 'education');
  const base = { channel: 'tiktok', now: NOW, listings: [A, B], reviews: REVIEWS, advertiser, pool: POOL, rules: RULES };
  assert.equal(chooseToday({ ...base, date: odd }).kind, 'property');
  assert.equal(chooseToday({ ...base, date: even }).kind, 'education');
  assert.equal(chooseToday({ ...base, date: odd, listings: [] }).kind, 'education', 'no property left → education');
  assert.equal(chooseToday({ ...base, date: even, pool: [] }).kind, 'property', 'no education left → property');
  assert.equal(chooseToday({ ...base, date: odd, listings: [], pool: [] }), null);
  assert.equal(chooseToday({ ...base, date: odd, only: 'education' }).kind, 'education');
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
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-browser-'));
  const root = path.join(dir, 'repo'), data = path.join(dir, 'data');
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify({ repeatDays: 30, countries: ['SA'], categories: ['buy', 'rent', 'off-plan'], renders: 'off-plan-only', reviewValidDays: 90, adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-05' } }));
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
    downloadReviewedPhotos: async (r, dir) => r.photos.map((_, i) => file(dir, `${i + 1}.jpg`)),
    media: {
      propertyReel: (l, frames, lines, out) => { calls.push(['reel', l.id, lines.en]); return file(path.dirname(out), path.basename(out)); },
      linkedinPropertyImages: async (frames, dir) => frames.map((_, i) => file(dir, `li-${i + 1}.jpg`)),
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
const { bindNewPost, captionHead, tiktokConfirm, tiktokPost, tiktokSession, tiktokDismissPopups, linkedinConfirm,
  linkedinActorProblem, linkedinPost, linkedinUrl, SELECTORS } = SITES;
const { withTab } = CDP;
const { readLedgerStrict, acquireLock, lockPath, renderedStrings, assertRenderable, appendRecord } = DAILY;
const cleanups = CLI.cleanups ?? new Set(), runCleanups = CLI.runCleanups;

function fakeSession({ ev = () => null, clickEl = () => ({ w: 1 }), start = 'https://x/' } = {}) {
  let cur = start;
  const log = { clicks: [], navs: [] };
  return { log,
    navigate: async u => { cur = u; log.navs.push(u); },
    waitFor: async () => true,
    ev: async expr => ev(expr, cur),
    clickEl: async expr => { log.clicks.push(expr); return clickEl(expr, cur); },
    url: async () => cur, key: async () => {}, typeInto: async () => true, setFiles: async () => true, screenshot: async f => f };
}
const isIds = e => e.includes('matchAll(/@');
const isAccount = e => e.includes('/passport/web/account/info/');
const isVideoText = e => e.includes('og:description');

test('fix 1: a new post counts only when its own element/page shows the caption head', () => {
  const head = captionHead('فيلا بشاطئ خاص، درة العروس\nدرة العروس، جدة\n\n#بونا');
  assert.equal(head, 'فيلا بشاطئ خاص، درة العروس');
  assert.equal(captionHead('#a #b\nTopic one'), 'Topic one');
  assert.equal(bindNewPost([{ key: '5', text: 'a promo' }], [], head), null, 'new id, wrong text');
  assert.equal(bindNewPost([{ key: '4', text: head }], ['4'], head), null, 'matching text but already in the baseline');
  assert.equal(bindNewPost([{ key: '5', text: 'promo' }, { key: '6', text: `x ${head} y` }], [], head), '6');
  assert.equal(bindNewPost([{ key: 'share:9', text: 'promo' }, { key: 'activity:7', text: head }], [], head, { prefer: 'share:9' }), 'activity:7', 'a toast id must qualify too');
  assert.equal(linkedinUrl('ugcPost:123'), 'https://www.linkedin.com/feed/update/urn:li:ugcPost:123/');
  assert.equal(bindNewPost([{ key: '6', text: head }], [], ''), null, 'no head, no binding');
});

test('fix 1: TikTok confirm rejects an unrelated new video id; accepts one whose page shows the caption', async () => {
  const caption = 'فيلا بشاطئ خاص\nmore';
  const other = fakeSession({ ev: e => isIds(e) ? ['111'] : isVideoText(e) ? 'somebody else' : null });
  assert.equal(await tiktokConfirm(other, 'bonarealestatesa', [], { caption, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  const ours = fakeSession({ ev: e => isIds(e) ? ['111', '222'] : isVideoText(e) ? 'فيلا بشاطئ خاص more #بونا' : null });
  assert.equal(await tiktokConfirm(ours, 'bonarealestatesa', ['111'], { caption, timeoutMs: 30, every: 0, settleMs: 0 }), 'https://www.tiktok.com/@bonarealestatesa/video/222');
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
  assert.equal(await linkedinConfirm(promo, '145349037', [], { caption, timeoutMs: 30, every: 0, settleMs: 0 }), null);
  const ours = fakeSession({ ev: e => e.includes("data-activity-urn") ? [{ key: 'activity:1000000001', text: 'promo' }, { key: 'ugcPost:1000000002', text: 'Villa BONA-A more' }] : null });
  assert.equal(await linkedinConfirm(ours, '145349037', [], { caption, timeoutMs: 30, every: 0, settleMs: 0 }), 'https://www.linkedin.com/feed/update/urn:li:ugcPost:1000000002/');
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
  const good = { path: '/company/145349037/admin/page-posts/published/', adminSettings: true, actorName: 'Bona | بونا', actorImg: 'https://media.licdn.com/x/company-logo_100_100/a', railImgs: ['https://media.licdn.com/x/company-logo_100_100/a'] };
  const o = { companyId: '145349037', pageName: 'Bona | بونا' };
  assert.equal(linkedinActorProblem(good, o), null);
  assert.match(linkedinActorProblem({ ...good, path: '/company/999/admin/' }, o), /not the admin of company 145349037/);
  assert.match(linkedinActorProblem({ ...good, adminSettings: false }, o), /no admin Settings/);
  assert.match(linkedinActorProblem({ ...good, actorImg: 'https://media.licdn.com/x/profile-displayphoto/a' }, o), /not a company logo/);
  assert.match(linkedinActorProblem({ ...good, railImgs: ['https://media.licdn.com/x/company-logo_100_100/OTHER'] }, o), /not the logo of company/);
  assert.match(linkedinActorProblem({ ...good, actorName: 'Abdulaziz Zaidan' }, o), /posts as/);
  const s = fakeSession({ ev: e => e.includes('adminSettings') ? { ...good, actorImg: 'https://media.licdn.com/x/profile-displayphoto/a' } : 'cap' });
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
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, `${process.pid} live\n`);
  const x = deps();
  await assert.rejects(run('tiktok', { dry: true, env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, x.d), /another run holds/);
  assert.deepEqual(x.calls, []);
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

test('fix 9: the lock outlives the unit timeout, a dead holder is taken over, and SIGTERM cleanup closes the tab, unstages and releases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-lock-'));
  const lock = path.join(dir, '.publish.lock');
  fs.writeFileSync(lock, 'no pid here\n');
  const t35 = Date.now() + 35 * 60_000;
  assert.throws(() => acquireLock(lock, { now: () => t35 }), /another run holds/, 'a 35 min old lock is still inside the 40 min unit timeout');
  fs.writeFileSync(lock, '999999999 dead\n');
  const rel = acquireLock(lock); assert.ok(fs.readFileSync(lock, 'utf8').startsWith(String(process.pid))); rel();
  assert.ok(!fs.existsSync(lock));
  const sb = sandbox(), x = deps(), closed = [], unstaged = [];
  x.d.cdp.withTab = async (_u, fn, opts) => { opts.onOpen({ id: 'TAB9' }); try { return await fn({ screenshot: async f => f, ev: async () => null }); } finally { opts.onClose(); } };
  x.d.cdp.closeTab = async id => closed.push(id);
  x.d.cdp.unstage = id => unstaged.push(id);
  let lockedDuring = null;
  x.d.sites.tiktokFill = async () => { await runCleanups(); lockedDuring = fs.existsSync(lockPath(sb.data, 'tiktok')); throw Object.assign(new Error('stopped'), { kind: 'sigterm' }); };
  await assert.rejects(run('tiktok', { env: sb.env, root: sb.root, now: NOW, clock: () => NOW, log: quiet, kind: 'property' }, x.d), /stopped/);
  assert.deepEqual(closed, ['TAB9']);
  assert.ok(unstaged.length >= 1);
  assert.equal(lockedDuring, false, 'lock released by the SIGTERM cleanup');
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
