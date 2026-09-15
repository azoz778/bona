#!/usr/bin/env node
// Builds marketing/queue/queue.json — a 30-day, multi-platform posting queue.
//
//   node scripts/social/queue.mjs                    # plan only
//   node scripts/social/queue.mjs --render           # plan + render every asset it schedules
//   node scripts/social/queue.mjs --start 2026-09-09 --days 30 --reels 12 --carousels 12
//
// What it decides, and on what grounds:
//
// TIMES. Every time is Asia/Riyadh. The Saudi week runs Sunday-Thursday; Friday and Saturday
// are the weekend. Saudi social use skews later than almost anywhere else — the evening peak
// is 21:00-24:00 and TikTok and Snapchat run past midnight — with a secondary midday peak
// around 13:00-15:00 and a commute peak on Snapchat around 07:30-08:30. LinkedIn is the
// exception: it is a working-hours network, so it only gets Sunday-Thursday mornings.
// Two windows are avoided everywhere: the Maghrib/Isha stretch (roughly 18:15-20:10 in
// Jeddah in this season) and Friday's Jumu'ah (11:15-13:45), when attention drops off.
// >> These are documented heuristics, not measured facts about THIS account. After 30 days,
// >> replace SLOTS below with what Instagram/TikTok Insights actually show. See README.md.
//
// FORMATS. No platform gets the same format twice in a row (`--strict-mix` makes that fatal
// rather than best-effort). Single-format surfaces — YouTube Shorts is only ever a Short —
// alternate pillar instead, so the channel still varies.
//
// REGA. Every entry states its `licenceBasis` (lib/listing.mjs adLicence()). A Saudi property
// post needs a REGA per-ad licence number: while none is recorded on the listing its captions
// and CTA card carry the literal string {{AD_LICENCE}} and the entry is `blocked: true`; once
// the owner records one (WhatsApp `licence <id> <number> <YYYY-MM-DD>`, rebuild listings.json,
// re-run this with --render) the number is printed and the entry is publishable. Property
// OUTSIDE the Kingdom cannot get a REGA ad licence and is marketed under the developer's
// authorisation (owner decision 2026-09-09): its copy says so, carries no placeholder and is
// never blocked. Editorial entries are never blocked. `--only-publishable` prints what can go out.
import './lib/fonts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { EDITORIAL, districtNote } from './lib/editorial.mjs';
import {
  AD_LICENCE_TOKEN, BASE, FAL, WA_DISPLAY, WA_LINK, adLicence, adLicenceLine, captionFor, districtLabel,
  editorialTags, falLine, firstCommentFor, hashtagsFor, hasPrice, listingUrl, loadListings,
  placeLabel, priceText, site, specLine, t, typeLabel, uniq,
} from './lib/listing.mjs';
import { OUT_ROOT, ensureDir, log, relToRepo } from './lib/util.mjs';
import { REPO_ROOT, SOCIAL_DIR } from './lib/fonts.mjs';

const { values: a } = parseArgs({
  options: {
    start: { type: 'string' }, days: { type: 'string', default: '30' },
    reels: { type: 'string', default: '12' }, carousels: { type: 'string', default: '12' },
    out: { type: 'string' }, render: { type: 'boolean', default: false },
    'only-publishable': { type: 'boolean', default: false },
    'strict-mix': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (a.help) {
  console.log('usage: queue.mjs [--start YYYY-MM-DD] [--days 30] [--reels N] [--carousels N] [--render] [--only-publishable] [--strict-mix]');
  process.exit(0);
}

const TZ = 'Asia/Riyadh';
const DAYS = Math.max(1, parseInt(a.days, 10) || 30);
/**
 * Default start = tomorrow IN RIYADH. Computing it from a UTC ISO string is wrong for three
 * hours every night: between 00:00 and 02:59 Riyadh it is still "yesterday" in UTC, so
 * `+1 day` lands on today rather than tomorrow.
 */
function riyadhTomorrow() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const START = a.start || riyadhTomorrow();
const N_REELS = Math.max(1, parseInt(a.reels, 10) || 12);
const N_CAROUSELS = Math.max(1, parseInt(a.carousels, 10) || 12);

// ---------------------------------------------------------------------------------------
// Platforms and their slots. wd = Sunday-Thursday, we = Friday/Saturday.
// ---------------------------------------------------------------------------------------
const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6;
const WEEKEND = new Set([FRI, SAT]);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const PLATFORMS = {
  instagram: {
    name: 'Instagram', account: `@${site.instagram.handle}`, accountStatus: 'live',
    // The account's home surface. Reels carry reach, carousels carry saves, stories carry replies.
    lanes: [
      { surface: 'reel', days: [SUN, TUE, THU], time: { wd: '21:30', we: '22:00' } },
      { surface: 'carousel', days: [MON, WED], time: { wd: '20:45', we: '21:15' } },
      { surface: 'post', days: [SAT], time: { wd: '20:45', we: '21:15' } },
      { surface: 'story', days: [SUN, MON, TUE, WED, THU, FRI, SAT], time: { wd: '13:30', we: '12:15' } },
      { surface: 'story', days: [SUN, TUE, THU, SAT], time: { wd: '21:05', we: '21:40' } },
    ],
  },
  tiktok: {
    name: 'TikTok', account: null, accountStatus: 'to-claim',
    // The latest-skewing audience of the seven; a 22:15 post is still climbing at 01:00.
    lanes: [
      { surface: 'reel', days: [SUN, TUE, THU], time: { wd: '22:15', we: '22:45' } },
      { surface: 'carousel', days: [MON, WED, FRI], time: { wd: '15:30', we: '16:30' } },
    ],
  },
  youtube: {
    name: 'YouTube Shorts', account: null, accountStatus: 'to-claim',
    // Only one format exists here, so this lane alternates pillar instead of format.
    lanes: [{ surface: 'short', days: [MON, WED, SAT], time: { wd: '20:15', we: '17:00' } }],
  },
  snapchat: {
    name: 'Snapchat', account: null, accountStatus: 'to-claim',
    // Highest penetration of any app in KSA, and the only one with a real morning peak.
    lanes: [
      { surface: 'story', days: [SUN, TUE, THU], time: { wd: '07:45', we: '10:30' } },
      { surface: 'reel', days: [MON, WED], time: { wd: '22:45', we: '23:15' } },
    ],
  },
  x: {
    name: 'X', account: null, accountStatus: 'to-claim',
    // Short captions only; the AR line does the work and the EN line follows in the thread.
    lanes: [
      { surface: 'post', days: [SUN], time: { wd: '21:15', we: '21:45' } },
      { surface: 'reel', days: [TUE], time: { wd: '21:40', we: '22:10' } },
      { surface: 'carousel', days: [THU], time: { wd: '14:00', we: '15:00' } },
    ],
  },
  linkedin: {
    name: 'LinkedIn', account: null, accountStatus: 'to-claim',
    // Working hours only, and never a listing: a price on LinkedIn reads as spam. Brand,
    // market fact and education only.
    lanes: [
      { surface: 'post', days: [SUN, WED], time: { wd: '08:30', we: '08:30' }, pillars: ['brand', 'education', 'market'] },
    ],
  },
  facebook: {
    name: 'Facebook', account: null, accountStatus: 'to-claim',
    // Older skew than Instagram, so an hour earlier, and it mirrors the feed rather than leading it.
    lanes: [
      { surface: 'reel', days: [TUE], time: { wd: '20:00', we: '20:30' } },
      { surface: 'carousel', days: [SUN], time: { wd: '19:45', we: '20:15' } },
      { surface: 'post', days: [THU], time: { wd: '20:00', we: '20:30' } },
    ],
  },
};

/** Windows nothing is scheduled into. */
const AVOID = [
  { from: '18:15', to: '20:10', why: 'Maghrib / Isha' },
  { from: '11:15', to: '13:45', days: [FRI], why: 'Jumuʿah' },
];
const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Nudge a slot out of an avoid window rather than dropping the post. */
function respectAvoid(time, dow) {
  let m = mins(time);
  for (const w of AVOID) {
    if (w.days && !w.days.includes(dow)) continue;
    const from = mins(w.from);
    const to = mins(w.to);
    if (m >= from && m < to) m = to + 10;
  }
  return hhmm(m);
}

// ---------------------------------------------------------------------------------------
// Content pools
// ---------------------------------------------------------------------------------------
const listings = loadListings();
// Post-worthiness: featured first, then depth of photography, then a printed price (a post
// with a real number outperforms "price on request"), then a home over a plot.
const score = (l) => (l.featured ? 100 : 0) + Math.min(10, (l.images?.length ?? 0)) * 4
  + (hasPrice(l) ? 12 : 0) + (l.kind === 'land' ? -18 : 0) + (l.category === 'buy' ? 5 : 0)
  + ((l.highlights?.ar?.length ?? 0) * 2);
const ranked = [...listings].sort((x, y) => score(y) - score(x));

const reelListings = ranked.slice(0, N_REELS);
// Offset the carousel pool so the two formats do not both open on the same five homes.
const carouselListings = uniq([...ranked.slice(0, 4), ...ranked.slice(N_REELS, N_REELS + N_CAROUSELS)]).slice(0, N_CAROUSELS);

const districts = (() => {
  const m = new Map();
  for (const l of listings) {
    const en = districtLabel(l, 'en');
    if (!en) continue;
    if (!m.has(en)) m.set(en, []);
    m.get(en).push(l);
  }
  // Only districts we can actually illustrate, biggest first.
  return [...m.entries()].filter(([, v]) => v.length).sort((x, y) => y[1].length - x[1].length).map(([en, v]) => ({ en, ar: districtLabel(v[0], 'ar'), listings: v }));
})();

const rel = (...p) => relToRepo(path.join(OUT_ROOT, ...p));

/** Every distinct creative the queue can reference, with the command that renders it. */
const PIECES = [];
const piece = (p) => { PIECES.push(p); return p; };

for (const l of reelListings) {
  piece({
    key: `reel-${l.id}`, kind: 'reel', pillar: 'listings', listing: l,
    assets: [rel('reels', `reel-${l.id}.mp4`)],
    render: ['make-reel.mjs', '--listing', l.id],
  });
}
for (const l of carouselListings) {
  piece({
    key: `carousel-${l.id}`, kind: 'carousel', pillar: 'listings', listing: l,
    assets: [1, 2, 3, 4, 5, 6].map((n) => rel('carousels', l.id, `${String(n).padStart(2, '0')}.png`)),
    assetsJpg: [1, 2, 3, 4, 5, 6].map((n) => rel('carousels', l.id, `${String(n).padStart(2, '0')}.jpg`)),
    render: ['make-carousel.mjs', '--listing', l.id],
  });
}
for (const l of ranked.slice(0, Math.max(N_REELS, N_CAROUSELS))) {
  piece({
    key: `story-${l.id}`, kind: 'story', pillar: 'listings', listing: l,
    assets: [rel('stories', `story-new-${l.id}.png`)],
    assetsJpg: [rel('stories', `story-new-${l.id}.jpg`)],
    render: ['make-story.mjs', '--listing', l.id, '--kind', 'new'],
  });
  piece({
    key: `post-${l.id}`, kind: 'image', pillar: 'listings', listing: l,
    assets: [rel('posts', `post-new-${l.id}.png`)],
    assetsJpg: [rel('posts', `post-new-${l.id}.jpg`)],
    render: ['make-story.mjs', '--listing', l.id, '--kind', 'new', '--ratio', '4:5', '--out', path.join(OUT_ROOT, 'posts', `post-new-${l.id}.png`)],
  });
}
for (const e of EDITORIAL) {
  piece({
    key: `ed-story-${e.id}`, kind: 'story', pillar: e.pillar, editorial: e,
    assets: [rel('stories', `editorial-${e.id}.png`)],
    assetsJpg: [rel('stories', `editorial-${e.id}.jpg`)],
    render: ['make-story.mjs', '--editorial', e.id],
  });
  piece({
    key: `ed-post-${e.id}`, kind: 'image', pillar: e.pillar, editorial: e,
    assets: [rel('posts', `editorial-${e.id}-4x5.png`)],
    assetsJpg: [rel('posts', `editorial-${e.id}-4x5.jpg`)],
    render: ['make-story.mjs', '--editorial', e.id, '--ratio', '4:5', '--out', path.join(OUT_ROOT, 'posts', `editorial-${e.id}-4x5.png`)],
  });
}
for (const d of districts) {
  const slug = d.en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  piece({
    key: `district-${slug}`, kind: 'story', pillar: 'district', district: d,
    assets: [rel('stories', `story-district-${slug}.png`)],
    assetsJpg: [rel('stories', `story-district-${slug}.jpg`)],
    render: ['make-story.mjs', '--district', d.en, '--kind', 'district'],
  });
}

// ---------------------------------------------------------------------------------------
// Copy per piece
// ---------------------------------------------------------------------------------------
function editorialCaption(e, lang) {
  const body = e.caption[lang];
  const lines = [body, ''];
  // Some editorial copy already ends on the tagline (the manifesto does); repeating it in the
  // sign-off two lines later reads like a template.
  const tagline = site.tagline[lang];
  const repeats = body.trimEnd().endsWith(tagline);
  lines.push(lang === 'ar'
    ? `بونا${repeats ? '' : ` — ${tagline}`}  ·  واتساب ${WA_DISPLAY}`
    : `Bona${repeats ? '' : ` — ${tagline}`}  ·  WhatsApp ${WA_DISPLAY}`);
  lines.push(falLine(lang));
  return lines.join('\n').trim();
}

function districtCaption(d, lang) {
  const note = districtNote(d.en);
  const kinds = uniq(d.listings.map((l) => typeLabel(l, lang)));
  const lines = [];
  lines.push(lang === 'ar' ? `دليل الأحياء — ${d.ar}` : `District guide — ${d.en}`);
  if (note) { lines.push(''); lines.push(note[lang]); }
  lines.push('');
  lines.push(lang === 'ar'
    ? `ما لدينا هناك اليوم: ${kinds.join('، ')}. لا نذكر عقاراً بعينه في هذا المنشور — اسأل عن الحي وسنرسل ما يناسبك.`
    : `What we hold there today: ${kinds.join(', ')}. This post names no individual property — ask about the district and we will send what fits.`);
  lines.push('');
  lines.push(lang === 'ar' ? `واتساب ${WA_DISPLAY}` : `WhatsApp ${WA_DISPLAY}`);
  lines.push(falLine(lang));
  return lines.join('\n').trim();
}

/**
 * X gives 280 characters, so a listing caption has to be cut. Cutting it from the top is
 * how the REGA licence line ends up on the floor: it is the LAST line of a listing caption
 * and therefore the first casualty of a naive truncate. So the TAIL — licence line and link
 * — is reserved first, and the body is what gets dropped. `assertCompliance()` below fails
 * the build if a listing caption ever loses the placeholder anyway.
 */
function shortCaption(head, tail, limit = 275) {
  const tailText = tail.filter(Boolean).join('\n');
  const budget = limit - tailText.length - 1;
  const kept = [];
  let used = 0;
  for (const line of head.filter(Boolean)) {
    const cost = (kept.length ? 1 : 0) + line.length;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  if (!kept.length && head.length && budget > 8) kept.push(String(head[0]).slice(0, budget - 1) + '…');
  return [...kept, tailText].filter(Boolean).join('\n');
}

function copyFor(p, platform) {
  if (p.listing) {
    const l = p.listing;
    const format = p.kind === 'reel' ? 'reel' : 'post';
    let ar = captionFor(l, 'ar', { format });
    let en = captionFor(l, 'en', { format });
    if (platform === 'x') {
      // Rebuilt, not truncated: the licence line and the link are mandatory and reserved.
      const build = (lang) => shortCaption(
        [t(l.title, lang), placeLabel(l, lang), specLine(l, lang), priceText(l, lang)],
        [adLicenceLine(lang, l), listingUrl(l, lang)],
      );
      ar = build('ar');
      en = build('en');
    }
    return {
      caption: { ar, en },
      hashtags: hashtagsFor(l, { limit: platform === 'x' ? 4 : 20 }),
      firstComment: { ar: firstCommentFor(l, 'ar'), en: firstCommentFor(l, 'en') },
      link: listingUrl(l, 'en'),
    };
  }
  if (p.editorial) {
    const e = p.editorial;
    let ar = editorialCaption(e, 'ar');
    let en = editorialCaption(e, 'en');
    if (platform === 'x') { ar = shortCaption(ar.split('\n'), [BASE]); en = shortCaption(en.split('\n'), [BASE]); }
    const tags = editorialTags({ kind: e.tags, extra: e.extraTags ?? [], limit: platform === 'x' ? 3 : 16 });
    return { caption: { ar, en }, hashtags: tags, firstComment: { ar: `${BASE}\n\n${tags.join(' ')}`, en: `${BASE}\n\n${tags.join(' ')}` }, link: BASE };
  }
  const d = p.district;
  let ar = districtCaption(d, 'ar');
  let en = districtCaption(d, 'en');
  if (platform === 'x') { ar = shortCaption(ar.split('\n'), [`${BASE}/properties/`]); en = shortCaption(en.split('\n'), [`${BASE}/properties/`]); }
  const tags = editorialTags({ kind: 'brand', extra: hashtagsFor(d.listings[0], { limit: 6 }), limit: platform === 'x' ? 3 : 16 });
  return { caption: { ar, en }, hashtags: tags, firstComment: { ar: `${BASE}/properties/\n\n${tags.join(' ')}`, en: `${BASE}/properties/\n\n${tags.join(' ')}` }, link: `${BASE}/properties/` };
}

// ---------------------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------------------
/** A piece is eligible for a lane when its kind matches the surface. */
const SURFACE_KINDS = {
  reel: ['reel'], short: ['reel'], carousel: ['carousel'],
  // "post" means a single image in the feed. A multi-image post is the `carousel` surface,
  // and letting `post` resolve to a carousel piece silently put two carousels back to back
  // on X and Facebook.
  post: ['image'],
  story: ['story'],
};

const cursors = new Map();
/**
 * Round-robin over the pool so the same twelve homes are not posted in the same order on
 * every platform, while staying deterministic across runs.
 */
function nextPiece(poolKey, candidates, { avoidFormat = null, avoidPillar = null, usedToday = new Set() } = {}) {
  if (!candidates.length) return null;
  const start = cursors.get(poolKey) ?? 0;
  let fallback = null;
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[(start + i) % candidates.length];
    if (usedToday.has(p.key)) continue;
    if (!fallback) fallback = { p, i };
    const formatClash = avoidFormat && p.kind === avoidFormat;
    const pillarClash = avoidPillar && p.pillar === avoidPillar;
    if (!formatClash && !pillarClash) { cursors.set(poolKey, (start + i + 1) % candidates.length); return p; }
  }
  if (!fallback) return null;
  cursors.set(poolKey, (start + fallback.i + 1) % candidates.length);
  return fallback.p;
}

const d0 = new Date(`${START}T00:00:00Z`);
const isoDate = (n) => { const d = new Date(d0); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowOf = (n) => { const d = new Date(d0); d.setUTCDate(d.getUTCDate() + n); return d.getUTCDay(); };

// Format alternation is a FEED rule: a follower scrolling a profile should not meet the same
// format twice running. Stories are a separate, ephemeral surface, so they alternate PILLAR
// instead (never two property stories back to back) rather than format, which is fixed.
const FEED_SURFACES = new Set(['reel', 'carousel', 'post', 'short']);
const lastFeed = new Map();
const lastStory = new Map();
const entries = [];
const mixWarnings = [];
const structuralNotes = [];
let seq = 0;

for (let day = 0; day < DAYS; day++) {
  const date = isoDate(day);
  const dow = dowOf(day);
  const weekend = WEEKEND.has(dow);
  const usedToday = new Set();

  for (const [pKey, plat] of Object.entries(PLATFORMS)) {
    for (const [laneIdx, lane] of plat.lanes.entries()) {
      if (!lane.days.includes(dow)) continue;
      const laneKey = `${pKey}:${lane.surface}:${laneIdx}`;
      const kinds = SURFACE_KINDS[lane.surface] ?? ['image'];
      let candidates = PIECES.filter((p) => kinds.includes(p.kind));
      if (lane.pillars) candidates = candidates.filter((p) => lane.pillars.includes(p.pillar));
      if (!candidates.length) continue;

      const isFeed = FEED_SURFACES.has(lane.surface);
      const prev = isFeed ? lastFeed.get(pKey) : lastStory.get(pKey);
      // Only one kind can serve this surface (YouTube Shorts, or any story lane): format
      // cannot vary, so vary the pillar instead.
      const singleFormat = new Set(candidates.map((c) => c.kind)).size === 1;
      const p = nextPiece(laneKey, candidates, {
        avoidFormat: isFeed && !singleFormat ? prev?.kind ?? null : null,
        avoidPillar: singleFormat ? prev?.pillar ?? null : null,
        usedToday,
      });
      if (!p) continue;
      usedToday.add(p.key);

      if (isFeed) lastFeed.set(pKey, p); else lastStory.set(pKey, p);

      const time = respectAvoid(weekend ? lane.time.we : lane.time.wd, dow);
      const c = copyFor(p, pKey);
      const isListing = !!p.listing;
      // A property piece with no listing object would slip past every REGA check as "editorial".
      if (p.pillar === 'listings' && !isListing) throw new Error(`${p.key}: listings piece without a listing object`);
      const lic = isListing ? adLicence(p.listing) : null;
      seq += 1;
      entries.push({
        id: `q-${String(seq).padStart(3, '0')}`,
        date, time, timezone: TZ, weekday: DOW[dow],
        platform: pKey, platformName: plat.name, account: plat.account, accountStatus: plat.accountStatus,
        surface: lane.surface,
        format: p.kind === 'reel' ? 'video' : p.kind === 'carousel' ? 'carousel' : 'image',
        pillar: p.pillar,
        pieceKey: p.key,
        listingRef: p.listing?.id ?? null,
        listingUrl: p.listing ? listingUrl(p.listing, 'en') : null,
        district: p.district?.en ?? (p.listing ? districtLabel(p.listing, 'en') : null),
        assets: p.assets,
        assetsJpg: p.assetsJpg ?? [],
        caption: c.caption,
        captionPrimary: 'ar',
        hashtags: c.hashtags,
        firstComment: c.firstComment,
        link: c.link,
        audio: p.kind === 'reel'
          ? 'Asset is silent by design (no music licence). Pick a trending in-app track when posting.'
          : null,
        licenceBasis: lic?.basis ?? null,
        adLicenceRequired: isListing && lic.basis !== 'developer-authorisation',
        blocked: lic?.blocked ?? false,
        blockedReason: !lic?.blocked ? null
          : lic.basis === 'unknown-country'
            ? `${p.listing.id} says country "${lic.country}", which is neither Saudi Arabia nor a country in FOREIGN_COUNTRIES (scripts/social/lib/listing.mjs). Fix the listing or add the country, then re-run queue.mjs --render.`
            : `REGA per-ad advertising licence not recorded for ${p.listing.id}. Record it in the WhatsApp group (licence ${p.listing.id} <number> <YYYY-MM-DD>), rebuild listings.json, then re-run queue.mjs --render so the caption AND the CTA card carry the number instead of ${AD_LICENCE_TOKEN}.`,
      });
    }
  }
}

entries.sort((x, y) => (x.date === y.date ? x.time.localeCompare(y.time) : x.date.localeCompare(y.date)));

// ---------------------------------------------------------------------------------------
// Format mix, checked on the finished queue rather than guessed at while building it.
//
// The rule that matters to a follower is what the PROFILE looks like: scrolling a platform's
// feed, two posts of the same format must not sit next to each other. Stories are a separate
// surface and are always "story", so they are checked on pillar instead — never two property
// stories running.
// ---------------------------------------------------------------------------------------
{
  const feed = new Map();
  const story = new Map();
  for (const e of entries) {
    const bucket = FEED_SURFACES.has(e.surface) ? feed : story;
    if (!bucket.has(e.platform)) bucket.set(e.platform, []);
    bucket.get(e.platform).push(e);
  }
  for (const [pKey, list] of feed) {
    // A platform whose feed only ever carries one format cannot alternate, and saying so 165
    // times is noise. LinkedIn is deliberately single-format here (one editorial image post),
    // so it varies pillar instead; that is checked below.
    const formats = new Set(list.map((e) => e.format));
    if (formats.size < 2) {
      // A channel that only carries one format cannot alternate format. If its content pool
      // also only holds one pillar — YouTube Shorts can only be a reel, and every reel we
      // make is a property — there is nothing to vary and nothing to report. Otherwise the
      // pillar is what must alternate.
      const pillars = new Set(list.map((e) => e.pillar));
      if (pillars.size > 1) {
        for (let i = 1; i < list.length; i++) {
          if (list[i].pillar === list[i - 1].pillar) {
            mixWarnings.push(`${pKey} feed: ${list[i - 1].date} then ${list[i].date} — single-format channel repeated the "${list[i].pillar}" pillar`);
          }
        }
      } else {
        structuralNotes.push(`${pKey}: single-format, single-pillar channel (${[...formats][0]} / ${[...pillars][0]}) — format mixing does not apply.`);
      }
      continue;
    }
    for (let i = 1; i < list.length; i++) {
      if (list[i].format === list[i - 1].format) {
        mixWarnings.push(`${pKey} feed: ${list[i - 1].date} ${list[i - 1].format} then ${list[i].date} ${list[i].format} — same format back to back`);
      }
    }
  }
  for (const [pKey, list] of story) {
    for (let i = 1; i < list.length; i++) {
      if (list[i].pillar === list[i - 1].pillar && list[i].pillar === 'listings') {
        mixWarnings.push(`${pKey} stories: ${list[i - 1].date} ${list[i - 1].time} then ${list[i].date} ${list[i].time} — two property stories back to back`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Render (optional)
// ---------------------------------------------------------------------------------------
/** A renderer that hangs must not hang the whole queue: kill it and move on. */
const RENDER_TIMEOUT_MS = Number(process.env.BONA_SOCIAL_RENDER_TIMEOUT_MS) || 900000;
const run = (script, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(SOCIAL_DIR, script), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  let settled = false;
  const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    done({ code: -2, err: `${script} timed out after ${RENDER_TIMEOUT_MS}ms` });
  }, RENDER_TIMEOUT_MS);
  child.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  child.on('close', (code) => done({ code, err }));
  child.on('error', (e) => done({ code: -1, err: e.message }));
});

if (a.render) {
  const scheduled = new Set(entries.map((e) => e.pieceKey));
  const todo = PIECES.filter((p) => scheduled.has(p.key));
  log(`rendering ${todo.length} pieces referenced by the queue…`);
  let done = 0;
  let failed = 0;
  for (const p of todo) {
    // Every asset, not just the first: a carousel that died after slide 3 left slide 1 on
    // disk, and checking only slide 1 would skip the re-render and schedule a broken post.
    if (p.assets.every((f) => fs.existsSync(path.join(REPO_ROOT, f)))) { done += 1; continue; }
    const [script, ...args] = p.render;
    const { code, err } = await run(script, args);
    if (code !== 0) { failed += 1; log(`FAILED ${p.key}: ${err.trim().split('\n').slice(-2).join(' ')}`); }
    else { done += 1; log(`${done + failed}/${todo.length} ${p.key}`); }
  }
  log(`render finished: ${done} ok, ${failed} failed`);
}

// Mark anything whose asset is not on disk, so nobody schedules a post with no picture.
for (const e of entries) {
  const missing = e.assets.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
  e.assetsReady = missing.length === 0;
  if (missing.length) e.missingAssets = missing;
}

// ---------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------
// Compliance guard. These are the rules the owner cannot afford to have quietly regress, so
// they are asserted on the finished queue rather than trusted to the code above.
// ---------------------------------------------------------------------------------------
function assertCompliance(list) {
  const problems = [];
  for (const e of list) {
    const both = `${e.caption.ar}\n${e.caption.en}`;
    if (e.listingRef) {
      const l = listings.find((x) => x.id === e.listingRef);
      const lic = l ? adLicence(l) : null;
      const where = `${e.id} (${e.listingRef}, ${e.platform})`;
      if (!lic) problems.push(`${where}: promotes a listing that is not in listings.json`);
      else if (e.licenceBasis !== lic.basis) problems.push(`${where}: licenceBasis ${e.licenceBasis} but the listing says ${lic.basis}`);
      else if (lic.basis === 'developer-authorisation') {
        // Outside the Kingdom: the developer line, never the REGA placeholder, never blocked.
        if (both.includes(AD_LICENCE_TOKEN)) problems.push(`${where}: foreign property carries ${AD_LICENCE_TOKEN}`);
        if (!/المطوّر/.test(e.caption.ar) || !/developer authorisation/.test(e.caption.en)) problems.push(`${where}: foreign property lacks the developer-authorisation line`);
        if (e.blocked !== false) problems.push(`${where}: foreign property must not be blocked`);
      } else if (lic.basis === 'rega-ad-licence') {
        // A recorded number replaces the placeholder in both captions and the entry may go out.
        if (!e.caption.ar.includes(lic.number) || !e.caption.en.includes(lic.number)) problems.push(`${where}: licence ${lic.number} missing from a caption`);
        if (both.includes(AD_LICENCE_TOKEN)) problems.push(`${where}: licensed but still carries ${AD_LICENCE_TOKEN}`);
        if (e.blocked !== false) problems.push(`${where}: licensed but blocked`);
      } else {
        // REGA pending (or an unrecognised country): placeholder in both captions, entry blocked.
        if (!e.caption.ar.includes(AD_LICENCE_TOKEN)) problems.push(`${where}: AR caption has no ${AD_LICENCE_TOKEN}`);
        if (!e.caption.en.includes(AD_LICENCE_TOKEN)) problems.push(`${where}: EN caption has no ${AD_LICENCE_TOKEN}`);
        if (e.blocked !== true) problems.push(`${where}: promotes an unlicensed Saudi property but is not blocked`);
      }
      // TAQEEM: a listing with no printed price must say so, in words, in both languages.
      if (l && !hasPrice(l)) {
        if (!/السعر عند الطلب/.test(e.caption.ar)) problems.push(`${e.id} (${e.listingRef}): no printed price and no "السعر عند الطلب"`);
        if (!/Price on request/.test(e.caption.en)) problems.push(`${e.id} (${e.listingRef}): no printed price and no "Price on request"`);
      }
    } else if (e.blocked !== false) {
      problems.push(`${e.id}: editorial entry marked blocked`);
    }
    if (/tk[\s-]?estate/i.test(both)) problems.push(`${e.id}: caption mentions TK`);
  }
  return problems;
}
const compliance = assertCompliance(entries);
if (compliance.length) {
  console.error(`compliance check failed (${compliance.length}):`);
  for (const c of compliance.slice(0, 20)) console.error(`  ${c}`);
  process.exit(4);
}

const kept = a['only-publishable'] ? entries.filter((e) => !e.blocked) : entries;
const byPlatform = kept.reduce((acc, e) => { acc[e.platform] = (acc[e.platform] ?? 0) + 1; return acc; }, {});
const byPillar = kept.reduce((acc, e) => { acc[e.pillar] = (acc[e.pillar] ?? 0) + 1; return acc; }, {});
const byFormat = kept.reduce((acc, e) => { acc[e.format] = (acc[e.format] ?? 0) + 1; return acc; }, {});

const doc = {
  generatedAt: new Date().toISOString(),
  generator: 'scripts/social/queue.mjs',
  timezone: TZ,
  start: START,
  days: DAYS,
  brand: {
    name: site.name, nameAr: site.nameAr, site: site.url,
    whatsapp: site.whatsapp.display, whatsappLink: WA_LINK,
    instagram: site.instagram.url, falLicence: FAL,
  },
  rules: {
    price: 'Never invented. A listing with no printed asking price says "السعر عند الطلب / Price on request" (TAQEEM reserves valuation to accredited valuers).',
    regaAdLicence: `Every entry states its licenceBasis. A Saudi property post needs a REGA per-ad advertising licence number: until one is recorded on the listing (WhatsApp: licence <id> <number> <YYYY-MM-DD>) the entry carries ${AD_LICENCE_TOKEN} and blocked:true; a recorded, unexpired number is printed instead and the entry is publishable. Property outside the Kingdom (developer-authorisation) is marketed under the developer's mandate, says so in the caption and on the CTA card, and is never blocked. Editorial entries carry no such requirement.`,
    audio: 'Reels are rendered silent. Add a trending in-app track at post time — an unlicensed music bed risks a muted rights claim and kills reach.',
    language: 'Arabic is the primary caption on every platform; English follows.',
    formatMix: 'No platform posts the same format twice in a row. Single-format surfaces alternate pillar instead.',
    times: 'Asia/Riyadh. Sun-Thu working week. Evening peak 21:00-24:00, secondary 13:00-15:00, Snapchat morning 07:30-08:30, LinkedIn working hours only. Maghrib/Isha (18:15-20:10) and Friday Jumuʿah (11:15-13:45) are avoided. Heuristics — replace with the account\'s own Insights after 30 days.',
  },
  counts: {
    entries: kept.length,
    publishableNow: kept.filter((e) => !e.blocked).length,
    blockedOnAdLicence: kept.filter((e) => e.blocked).length,
    byLicenceBasis: Object.fromEntries(['developer-authorisation', 'rega-ad-licence', 'rega-pending'].map((b) => [b, kept.filter((e) => e.licenceBasis === b).length])),
    assetsReady: kept.filter((e) => e.assetsReady).length,
    byPlatform, byPillar, byFormat,
    distinctPieces: new Set(kept.map((e) => e.pieceKey)).size,
    listingsCovered: new Set(kept.map((e) => e.listingRef).filter(Boolean)).size,
  },
  warnings: mixWarnings,
  notes: structuralNotes,
  entries: kept,
};

const out = a.out ? path.resolve(a.out) : path.join(OUT_ROOT, 'queue.json');
ensureDir(path.dirname(out));
fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);

if (a['strict-mix'] && mixWarnings.length) {
  console.error(`strict-mix: ${mixWarnings.length} adjacency violation(s)`);
  for (const w of mixWarnings.slice(0, 10)) console.error(`  ${w}`);
  process.exit(3);
}

log(`queue → ${out}`);
log(`${doc.counts.entries} entries · ${doc.counts.publishableNow} publishable now · ${doc.counts.blockedOnAdLicence} blocked on the REGA licence`);
log(`platforms: ${Object.entries(byPlatform).map(([k, v]) => `${k} ${v}`).join(', ')}`);
log(`pillars:   ${Object.entries(byPillar).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (mixWarnings.length) log(`adjacency warnings: ${mixWarnings.length}`);
console.log(out);
