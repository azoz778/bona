// BONA-W009 (Elvira Murjan) — the developer withdrew permission to advertise it (requested by Tarek,
// 2026-10-20) and the owner ordered a FULL takedown. A withdrawal is not a hidden page: the listing
// has to be gone from the site's data, its photos and brochure (which Pages serves straight out of
// public/), llms.txt, the review register's rotation and every channel's candidate list, and no
// route — the WhatsApp intake, the deploy's TK sync, the approve script — may bring it back.
//
// Two layers, both exercised here:
//   - scripts/curate/rules.mjs WITHDRAWN_ADVERTISING: permanent records matched by id, slug, the
//     brochure's SHA-256 and the project's name, so a re-import under a fresh BONA-W id is caught;
//   - a `withdrawnAdvertising` flag on a marketing/daily/property-reviews.json entry, which every
//     route reads as well (registerWithdrawals / loadRegisterWithdrawals).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as rules from '../curate/rules.mjs';
import { advertiserFingerprint, chooseProperty, eligibility, fingerprint, policyRules, reviewedCopy, sha256 } from '../social/lib/property-daily.mjs';
import { chooseToday } from '../social/lib/browser-daily.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const W009 = { id: 'BONA-W009', slug: 'elvira-murjan-townhouses-in-al-murjan', pdfSha256: '7f6e4e4a4410e714fd9d717e1cad53dcd40fa4ddad0293de6a0f01cae5d403ea' };
const REGISTER = 'marketing/daily/property-reviews.json';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const inboxW009 = () => json(`scripts/curate/inbox/${W009.slug}.json`);
/** W009 as build.mjs published it, and as the live social catalogue still served it on 2026-11-10. */
function w009Listing() {
  const { hidden, _intake, ...l } = inboxW009();
  return { ...l, kind: 'house', featured: false, licence: l.licence ?? null, map: null, mapPrecision: null };
}
const scratch = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const FLAG = { at: '2026-11-10T09:00:00.000Z', requestedBy: 'test', reason: 'developer withdrew permission (fixture)', channels: ['website', 'instagram', 'facebook', 'tiktok', 'linkedin'] };

// ------------------------------------------------------------------------------------- the rule
test('the permanent withdrawal list names W009 by id, slug, brochure hash and project name', () => {
  assert.ok(Array.isArray(rules.WITHDRAWN_ADVERTISING) && Object.isFrozen(rules.WITHDRAWN_ADVERTISING), 'a frozen list in rules.mjs');
  const w = rules.WITHDRAWN_ADVERTISING.find((x) => x.id === W009.id);
  assert.ok(w, 'BONA-W009 is on it');
  assert.equal(w.slug, W009.slug);
  assert.equal(w.pdfSha256, inboxW009()._intake.pdfSha256, 'the brochure the intake published it from');
  assert.equal(w.requestedBy, 'Tarek');
  assert.ok(Number.isFinite(Date.parse(w.withdrawnAt)) && w.reason.trim());
  assert.ok(w.names.length >= 2 && Object.isFrozen(w));
});

test('withdrawnAdvertising() catches the project however it comes back, and nothing else', () => {
  const hit = (l) => rules.withdrawnAdvertising(l)?.id ?? null;
  assert.equal(hit({ id: 'BONA-W009' }), W009.id, 'by id');
  assert.equal(hit({ id: 'bona-w009' }), W009.id, 'case is not a way round it');
  assert.equal(hit({ slug: W009.slug }), W009.id, 'by slug');
  assert.equal(hit({ _intake: { pdfSha256: W009.pdfSha256 } }), W009.id, 'by the brochure bytes');
  assert.equal(hit(w009Listing()), W009.id);
  // A re-import: the same brochure re-exported (new bytes), a fresh id, a re-worded title.
  assert.equal(hit({ id: 'BONA-W031', slug: 'elvira-townhouses-al-murjan', title: { en: 'Elvira Townhouses, Al Murjan', ar: 'تاون هاوس، المرجان' } }), W009.id);
  assert.equal(hit({ id: 'BONA-W032', slug: 'townhouses-al-murjan-2', title: { en: 'Townhouses, Al Murjan', ar: 'منازل إلفيرا، المرجان' } }), W009.id, 'by the Arabic name');
  assert.equal(hit({ id: 'BONA-W033', slug: 'x', title: { en: 'X', ar: 'س' }, project: { name: { en: 'ELVIRA  MURJAN', ar: 'ألفيرا مرجان' } } }), W009.id, 'by the project name, any alef');
  assert.equal(hit({ id: 'BONA-W034', slug: 'elvira-murjan-townhouses-in-al-murjan-2' }), W009.id, 'uniqueSlug() suffix');
  // Not a match: the district alone, a longer word that merely starts with the name, nothing at all.
  assert.equal(hit({ id: 'BONA-W035', slug: 'private-villa-al-murjan', title: { en: 'Private Villa in Al-Murjan', ar: 'فيلا خاصة في حي المرجان' } }), null);
  assert.equal(hit({ id: 'BONA-W036', slug: 'elviraton-tower', title: { en: 'Elviraton Tower', ar: 'برج' } }), null);
  assert.equal(hit(null), null);
  assert.equal(hit({}), null);
  // Every other listing the intake holds today stays publishable.
  for (const name of fs.readdirSync(path.join(ROOT, 'scripts/curate/inbox')).filter((n) => n.endsWith('.json') && n !== '_index.json' && n !== `${W009.slug}.json`)) {
    assert.equal(hit(json(`scripts/curate/inbox/${name}`)), null, name);
  }
});

test('isPublishable() refuses a withdrawn listing; the named withheld list is unchanged and there is no price cap', () => {
  assert.equal(rules.isPublishable(w009Listing()), false);
  assert.equal(rules.isPublishable({ id: 'BONA-W031', title: { en: 'Elvira Townhouses', ar: 'منازل' } }), false);
  assert.equal(rules.isPublishable({ id: 'BONA-001' }), true);
  assert.equal(rules.isPublishable({ id: 'BONA-999', kind: 'house', price: { amount: 90_000_000, currency: 'SAR' } }), true, 'no SAR 10m house cap');
  assert.deepEqual([...rules.WITHHELD_LISTINGS].sort(), ['BONA-002', 'BONA-028']);
});

test('a withdrawnAdvertising flag on a review-register entry withdraws that listing', () => {
  const reg = {
    'BONA-T9': { status: 'withdrawn', reviewedAt: FLAG.at, reviewer: 'test', withdrawnAdvertising: FLAG },
    'BONA-T8': { status: 'approved', reviewedAt: FLAG.at, reviewer: 'test' },
    'BONA-T7': { status: 'withdrawn', reviewedAt: FLAG.at, reviewer: 'test', withdrawnAdvertising: { ...FLAG, slug: 'tower-seven', names: ['Septima'] } },
  };
  const extra = rules.registerWithdrawals(reg);
  assert.deepEqual(extra.map((w) => w.id).sort(), ['BONA-T7', 'BONA-T9']);
  assert.equal(rules.isPublishable({ id: 'BONA-T9' }, extra), false, 'the flag alone is enough');
  assert.equal(rules.isPublishable({ id: 'BONA-T9' }), true, 'and it is the flag that does it');
  assert.equal(rules.isPublishable({ id: 'BONA-T8' }, extra), true);
  assert.equal(rules.isPublishable({ id: 'BONA-W040', slug: 'tower-seven' }, extra), false, 'a flag may carry a slug');
  assert.equal(rules.isPublishable({ id: 'BONA-W041', slug: 'x', title: { en: 'Septima Residences', ar: 'س' } }, extra), false, '…and names');
  assert.deepEqual(rules.registerWithdrawals(null), []);
  assert.deepEqual(rules.registerWithdrawals({}), []);

  const dir = scratch('bona-withdrawn-reg-');
  try {
    assert.deepEqual(rules.loadRegisterWithdrawals(dir), [], 'no register file: nothing flagged');
    fs.mkdirSync(path.join(dir, 'marketing/daily'), { recursive: true });
    fs.writeFileSync(path.join(dir, REGISTER), '{ not json');
    assert.throws(() => rules.loadRegisterWithdrawals(dir), 'an unreadable register fails closed');
    fs.writeFileSync(path.join(dir, REGISTER), JSON.stringify(reg));
    assert.deepEqual(rules.loadRegisterWithdrawals(dir).map((w) => w.id).sort(), ['BONA-T7', 'BONA-T9']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.ok(rules.loadRegisterWithdrawals(ROOT).some((w) => w.id === W009.id), 'BONA-W009 carries the flag in the repository register');
});

// --------------------------------------------------------------------------- the repository
test('the repository carries the takedown: data, files, register, llms.txt', () => {
  const flagged = rules.loadRegisterWithdrawals(ROOT);
  const listings = json('src/data/listings.json');
  assert.deepEqual(listings.filter((l) => rules.withdrawnAdvertising(l, flagged)).map((l) => l.id), [], 'src/data/listings.json');
  assert.equal(fs.existsSync(path.join(ROOT, 'public/listings', W009.slug)), false, 'photos and brochure.pdf are not served any more');
  assert.equal(fs.existsSync(path.join(ROOT, 'public/social/property', W009.id)), false, 'no derived social media');
  const inbox = inboxW009();
  assert.equal(inbox.hidden, true, 'the intake record stays, hidden, so the id and the brochure hash stay known');
  assert.equal(json('scripts/curate/inbox/_index.json').listings[W009.slug], W009.id, 'the id is never reused');

  const r = json(REGISTER)[W009.id];
  assert.equal(r.status, 'withdrawn');
  assert.equal(r.withdrawnAdvertising.requestedBy, 'Tarek');
  assert.ok(Number.isFinite(Date.parse(r.withdrawnAdvertising.at)) && r.withdrawnAdvertising.reason.trim());
  for (const c of ['website', 'instagram', 'facebook', 'tiktok', 'linkedin']) assert.ok(r.withdrawnAdvertising.channels.includes(c), c);
  assert.equal(r.photos, undefined, 'a tombstone: no approved frame is left to post');

  const terms = /BONA-W009|elvira|إلفيرا|الفيرا/i;
  for (const f of ['public/llms.txt', 'public/llms-full.txt', 'marketing/content-calendar.md', 'src/data/content-calendar.json', 'marketing/queue/queue.json']) {
    assert.doesNotMatch(read(f), terms, f);
  }
});

// ------------------------------------------------------------------------------ every channel
const now = new Date('2026-11-21T17:30:00Z'); // the day the rotation would have reached W009 again
const advertiser = { name: { ar: 'المعلن التجريبي', en: 'Fixture advertiser' }, fal: '1100000000', phone: '+966500000000' };
const policy = () => policyRules(json('marketing/daily/property-policy.json'), now); // the production policy
/** A review that passes every other check: built, hashed and captioned exactly as approve would. */
function approvedReview(p) {
  const review = {
    status: 'approved', reviewedAt: '2026-11-20T12:00:00Z', reviewer: 'forged for the test',
    factsSha256: fingerprint(p), advertiserSha256: advertiserFingerprint(advertiser), licenceEvidence: null,
    legalDisclosuresVerified: true, legalDisclosures: { ar: 'مواعيد التسليم والمواصفات حسب المطوّر.', en: 'Delivery dates and specifications are per the developer.' },
    photos: p.images.slice(0, 3).map((x, i) => ({ url: `https://bona-real-estate.com${x.src}`, sha256: sha256(`frame ${p.id} ${i}`), width: 1920, height: 1280, kind: 'render', visuallyApproved: true, alt: x.alt })),
  };
  review.captionSha256 = sha256(JSON.stringify(reviewedCopy(p, advertiser, review)));
  return review;
}
function control() {
  const base = w009Listing();
  const slug = 'fixture-townhouses-al-rawdah';
  return { ...base, id: 'BONA-T1', slug, title: { en: 'Fixture Townhouses, Al Rawdah', ar: 'منازل تجريبية، الروضة' }, project: null,
    images: base.images.map((im, i) => ({ src: `/listings/${slug}/${String(i + 1).padStart(2, '0')}.jpg`, thumb: null, alt: { en: `Photo ${i + 1}`, ar: `صورة ${i + 1}` } })) };
}

test('every channel\'s candidate list leaves W009 out, even beside a forged approval', () => {
  const rulesNow = policy();
  const p = w009Listing(), c = control();
  const reviews = { [p.id]: approvedReview(p), [c.id]: approvedReview(c) };
  assert.deepEqual(eligibility(c, reviews[c.id], advertiser, now, rulesNow), [], 'control: the forged review is otherwise publishable');
  assert.deepEqual(eligibility(p, reviews[p.id], advertiser, now, rulesNow), ['marketing_permission_withdrawn']);
  for (const channel of ['instagram', 'facebook']) {
    const sel = chooseProperty([p, c], reviews, advertiser, [], channel, now, undefined, rulesNow);
    assert.equal(sel.listing?.id, c.id, channel);
    assert.ok(!sel.candidates.some((x) => x.id === p.id), `${channel}: not a candidate`);
    assert.ok(sel.rejected.find((x) => x.id === p.id)?.reasons.includes('marketing_permission_withdrawn'), `${channel}: rejected as withdrawn`);
    assert.equal(chooseProperty([p], reviews, advertiser, [], channel, now, undefined, rulesNow).listing, null, `${channel}: alone, nothing`);
  }
  for (const channel of ['tiktok', 'linkedin']) {
    const base = { channel, date: '2026-11-21', now, reviews, advertiser, events: [], pool: [], repeatDays: rulesNow.repeatDays, rules: rulesNow, only: 'property' };
    assert.equal(chooseToday({ ...base, listings: [p, c] })?.listing?.id, c.id, channel);
    assert.equal(chooseToday({ ...base, listings: [p] }), null, `${channel}: alone, nothing`);
  }
});

test('with today\'s repository register, W009 is nobody\'s candidate', () => {
  const rulesNow = policy(), p = w009Listing(), reviews = json(REGISTER);
  for (const channel of ['instagram', 'facebook', 'tiktok', 'linkedin']) {
    const sel = chooseProperty([p], reviews, advertiser, [], channel, now, undefined, rulesNow);
    assert.equal(sel.listing, null, channel);
    assert.ok(sel.rejected[0].reasons.includes('marketing_permission_withdrawn'), channel);
  }
});

test('a register flag alone takes a listing off every channel, including under a new id', () => {
  const rulesNow = policy(), c = control();
  const ok = approvedReview(c);
  const flagged = { ...ok, status: 'withdrawn', withdrawnAdvertising: { ...FLAG, names: ['Fixture Townhouses'] } };
  assert.ok(eligibility(c, flagged, advertiser, now, rulesNow).includes('marketing_permission_withdrawn'));
  const twin = { ...c, id: 'BONA-T2', slug: 'fixture-townhouses-al-rawdah-2' };
  const reviews = { [c.id]: flagged, [twin.id]: approvedReview(twin) };
  for (const channel of ['instagram', 'facebook', 'tiktok', 'linkedin']) {
    const sel = chooseProperty([c, twin], reviews, advertiser, [], channel, now, undefined, rulesNow);
    assert.equal(sel.listing, null, `${channel}: neither the flagged listing nor its re-import`);
    assert.ok(sel.rejected.every((x) => x.reasons.includes('marketing_permission_withdrawn')), channel);
  }
});

// ----------------------------------------------------------------- the routes that write the site
/** A scratch copy of the repository files a script reads; public/listings/* are symlinked, never copied. */
function tree(files, { publicListings = true } = {}) {
  const dir = scratch('bona-withdrawn-tree-');
  for (const f of files) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  }
  if (publicListings) {
    fs.mkdirSync(path.join(dir, 'public/listings'), { recursive: true });
    for (const d of fs.readdirSync(path.join(ROOT, 'public/listings'))) {
      if (d !== W009.slug) fs.symlinkSync(path.join(ROOT, 'public/listings', d), path.join(dir, 'public/listings', d));
    }
    fs.symlinkSync(path.join(ROOT, 'public/land'), path.join(dir, 'public/land'));
  }
  return dir;
}
const node = (dir, script) => spawnSync(process.execPath, [path.join(dir, script)], { cwd: dir, encoding: 'utf8' });
const flagIn = (dir, id) => {
  const file = path.join(dir, REGISTER);
  const reg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  reg[id] = { status: 'withdrawn', reviewedAt: FLAG.at, reviewer: 'test', withdrawnAdvertising: FLAG };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(reg, null, 2));
};

test('validate.mjs (the deploy\'s last gate) fails a withdrawn listing, its public files, or a register-flagged one', () => {
  const files = ['scripts/curate/validate.mjs', 'scripts/curate/rules.mjs', 'src/lib/units-summary.mjs', 'src/data/kind-map.json', 'src/data/listings.json', REGISTER];
  const current = json('src/data/listings.json').filter((l) => l.id !== W009.id);
  const write = (dir, listings) => fs.writeFileSync(path.join(dir, 'src/data/listings.json'), JSON.stringify(listings, null, 2));
  const dir = tree(files, { publicListings: false });
  try {
    write(dir, current);
    const clean = node(dir, 'scripts/curate/validate.mjs');
    assert.equal(clean.status, 0, `control passes: ${clean.stderr}`);

    write(dir, [...current, w009Listing()]);
    const back = node(dir, 'scripts/curate/validate.mjs');
    assert.equal(back.status, 1, 'a listings.json that carries W009 fails the deploy');
    assert.match(back.stderr, /BONA-W009: .*withdrawn/);

    write(dir, current);
    fs.mkdirSync(path.join(dir, 'public/listings', W009.slug), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public/listings', W009.slug, 'brochure.pdf'), '%PDF');
    const files_ = node(dir, 'scripts/curate/validate.mjs');
    assert.equal(files_.status, 1, 'its photos or brochure back under public/ fail the deploy');
    assert.match(files_.stderr, new RegExp(`public/listings/${W009.slug}`));
    fs.rmSync(path.join(dir, 'public'), { recursive: true, force: true });

    const curated = current.find((l) => /^BONA-\d{3}$/.test(l.id)).id;
    flagIn(dir, curated);
    const flagged = node(dir, 'scripts/curate/validate.mjs');
    assert.equal(flagged.status, 1, 'a register flag on a published listing fails the deploy until the build drops it');
    assert.match(flagged.stderr, new RegExp(`${curated}: .*withdrawn`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const BUILD_FILES = [
  'scripts/curate/build.mjs', 'scripts/curate/listings.source.mjs', 'scripts/curate/rooms.mjs', 'scripts/curate/rules.mjs',
  'scripts/curate/licences.json', 'scripts/curate/inbox', 'scripts/tk-gallery-data.json', 'scripts/tk-public-properties.snapshot.json',
  'src/data/site.json', 'src/data/kind-map.json', 'src/data/district-pins.json', 'src/lib/units-summary.mjs', REGISTER,
];
const built = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'src/data/listings.json'), 'utf8'));

test('build.mjs leaves W009 out even un-hidden, and refuses to build while its public files remain', () => {
  const dir = tree(BUILD_FILES);
  const inboxFile = path.join(dir, 'scripts/curate/inbox', `${W009.slug}.json`);
  try {
    // `show BONA-W009` through an intake that predates the gate: the build itself still says no.
    fs.writeFileSync(inboxFile, JSON.stringify({ ...inboxW009(), hidden: false }, null, 2));
    const shown = node(dir, 'scripts/curate/build.mjs');
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /BONA-W009/, 'the build says what it withdrew');
    assert.deepEqual(built(dir).filter((l) => rules.withdrawnAdvertising(l)).map((l) => l.id), []);
    assert.ok(built(dir).length > 40, 'everything else is still published');

    fs.writeFileSync(inboxFile, JSON.stringify({ ...inboxW009(), hidden: true }, null, 2));
    fs.mkdirSync(path.join(dir, 'public/listings', W009.slug));
    fs.writeFileSync(path.join(dir, 'public/listings', W009.slug, 'brochure.pdf'), '%PDF');
    const leaking = node(dir, 'scripts/curate/build.mjs');
    assert.notEqual(leaking.status, 0, 'a withdrawal with its brochure still public is half a takedown');
    assert.match(leaking.stderr, new RegExp(`withdrawn.*public/listings/${W009.slug}`, 's'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build.mjs drops a listing whose review-register entry carries the withdrawnAdvertising flag', () => {
  const dir = tree(BUILD_FILES);
  try {
    const before = node(dir, 'scripts/curate/build.mjs');
    assert.equal(before.status, 0, before.stderr);
    const victim = built(dir).find((l) => /^BONA-\d{3}$/.test(l.id)).id;
    flagIn(dir, victim);
    const after = node(dir, 'scripts/curate/build.mjs');
    assert.equal(after.status, 0, after.stderr);
    assert.ok(!built(dir).some((l) => l.id === victim), `${victim} is off src/data/listings.json`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the three routes that write listings.json all apply the withdrawal rule with the register', () => {
  for (const route of ['scripts/curate/build.mjs', 'scripts/sync-listings.mjs', 'scripts/curate/validate.mjs']) {
    assert.match(read(route), /loadRegisterWithdrawals\(ROOT\)/, `${route} reads the register's flags`);
  }
});
