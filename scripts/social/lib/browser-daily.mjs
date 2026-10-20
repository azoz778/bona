// The daily TikTok and LinkedIn publisher's decisions — pure functions, no browser, no network.
// scripts/social/browser-publish.mjs drives the browser; everything that decides WHAT goes out
// lives here so the tests can pin it down (scripts/test/browser-publish.test.mjs).
//
// What goes out (owner, 2026-10-20): the same owner-approved Saudi property register as the
// Instagram/Facebook daily posts (marketing/daily/property-reviews.json under the 2026-10-05
// ad-licence waiver: same eligibility, same fingerprints, same reviewed caption and disclosures),
// interleaved with licence-free education. One post per channel per Riyadh day, fully automatic.
import fs from 'node:fs';
import path from 'node:path';
import { ksaNow } from './daily-pack.mjs';
import { SITE, dayState, unsettled, chooseProperty, reviewedCopy, propertyHashtags, sha256, showsPrice, photoNoteText } from './property-daily.mjs';
import { refuseText } from './facebook.mjs';
import { EDITORIAL } from './editorial.mjs';

export const CHANNELS = Object.freeze({
  tiktok: Object.freeze({
    id: 'tiktok', handle: 'bonarealestatesa', maxCaption: 2200,
    // Riyadh window in which a run may post (after Isha: Maghrib–Isha is avoided everywhere, see
    // scripts/social/README.md). The timer fires inside it; a run outside does nothing.
    window: Object.freeze({ from: '21:30', to: '23:30' }), days: null,
  }),
  linkedin: Object.freeze({
    id: 'linkedin', companyId: '145349037', pageName: 'Bona | بونا', maxCaption: 3000,
    // LinkedIn is a working-hours network: Sunday–Thursday mornings only.
    window: Object.freeze({ from: '09:00', to: '12:00' }), days: Object.freeze([0, 1, 2, 3, 4]),
  }),
});
export const EDUCATION_REPEAT_DAYS = 28;
/** Editorial items not fit for this publisher: explaining the per-ad licence while posting under its waiver reads as a contradiction. */
export const EDUCATION_EXCLUDED = Object.freeze(['edu-ad-licence']);
export const TIKTOK_CORE_TAGS = Object.freeze(['#عقارات_جدة', '#جدة', '#بونا']);

const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
export const ledgerPath = (data, channel) => path.join(data, channel, 'published.jsonl');
export const lockPath = (data, channel) => path.join(data, channel, '.publish.lock');
export const readLedger = file => rows(file);
export function appendRecord(file, row, now = () => new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify({ ...row, at: now().toISOString() }) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
export const entryId = (channel, date) => `bona-${channel}-${date}`;

/** The day's state on this channel: 'published' | 'uncertain' | 'ready' (same rules as the Instagram/Facebook journal). */
export function channelState(events, channel, date) {
  const day = dayState(events, channel, date);
  if (day !== 'ready') return day;
  // An older day left in intent/uncertain blocks every later day too, until a human settles it.
  return unsettled(events, channel) ? 'uncertain' : 'ready';
}

/** Whether a run at `now` may post on this channel: inside its window, on one of its days. */
export function inWindow(channel, now = new Date()) {
  const c = CHANNELS[channel];
  const { date, time } = ksaNow(now);
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (c.days && !c.days.includes(dow)) return { ok: false, why: `not a ${channel} day (Riyadh weekday ${dow})` };
  if (time < c.window.from || time >= c.window.to) return { ok: false, why: `outside ${c.window.from}–${c.window.to} Riyadh` };
  return { ok: true, date, time };
}

/** Day number since the epoch for a YYYY-MM-DD: consecutive days alternate parity across month ends. */
export const epochDay = date => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
/** Property on odd days, education on even; each falls back to the other when its pool is empty. */
export function preferredKind(date) { return epochDay(date) % 2 === 1 ? 'property' : 'education'; }

/** The licence-free education pool: the reviewed daily-pack notes (content.json), then the editorial education cards. */
export function educationPool(content = [], editorial = EDITORIAL) {
  const fromPack = content.map(d => ({ id: `edu-pack-${d.key}`, source: 'pack', key: d.key, topic: d.topic, caption: d.caption, slides: d.slides }));
  const fromEditorial = editorial.filter(e => e.pillar === 'education' && !EDUCATION_EXCLUDED.includes(e.id))
    .map(e => ({ id: e.id, source: 'editorial', key: e.id, topic: e.title, caption: e.caption, card: { ar: e.ar, en: e.en } }));
  const pool = [...fromPack, ...fromEditorial];
  return pool.filter(x => x.topic?.ar && x.topic?.en && x.caption?.ar && x.caption?.en && !refuseText(`${x.topic.ar}\n${x.topic.en}\n${x.caption.ar}\n${x.caption.en}`));
}
/** Oldest-unposted-first on this channel; an item posted within EDUCATION_REPEAT_DAYS is not a candidate. */
export function chooseEducation(pool, events, channel, now = new Date(), repeatDays = EDUCATION_REPEAT_DAYS) {
  const last = id => Math.max(0, ...events.filter(e => e.channel === channel && e.itemId === id && e.status === 'published').map(e => Date.parse(e.at) || 0));
  const ok = pool.filter(x => +now - last(x.id) >= repeatDays * 86_400_000);
  ok.sort((a, b) => last(a.id) - last(b.id) || pool.indexOf(a) - pool.indexOf(b));
  return ok[0] ?? null;
}

/**
 * Today's item: { kind: 'property', listing, review, rejected } | { kind: 'education', item } | null.
 * `events` are this channel's ledger rows; property rows carry listingId so chooseProperty()'s
 * repeat interval applies per channel, exactly as on Instagram and Facebook.
 */
export function chooseToday({ channel, date, now = new Date(), listings = [], reviews = {}, advertiser = null, events = [], pool = [], repeatDays = 30, rules, only = null }) {
  const prop = () => {
    const sel = chooseProperty(listings, reviews, advertiser, events, channel, now, repeatDays, rules);
    return sel.listing ? { kind: 'property', listing: sel.listing, review: reviews[sel.listing.id], rejected: sel.rejected } : null;
  };
  const edu = () => { const item = chooseEducation(pool, events, channel, now); return item ? { kind: 'education', item } : null; };
  // `only` (a human's --kind) takes that kind or nothing, never the other.
  if (only) return only === 'property' ? prop() : edu();
  return preferredKind(date) === 'property' ? (prop() ?? edu()) : (edu() ?? prop());
}

// ------------------------------------------------------------------------------- captions
const dedupe = xs => [...new Set(xs.filter(Boolean))];
const place = (p, l) => [p.location?.district?.[l], p.location?.city?.[l]].filter(Boolean).join(l === 'ar' ? '، ' : ', ');
const deal = p => p.category === 'rent' ? { ar: 'للإيجار', en: 'For rent' } : p.category === 'off-plan' ? { ar: 'على الخارطة', en: 'Off-plan' } : { ar: 'للبيع', en: 'For sale' };
const fit = (parts, max) => parts.filter(Boolean).join('\n\n').length <= max;

/**
 * The reviewed copy, verified against the review's captionSha256 (the same binding
 * eligibility() checks). Throws rather than post copy nobody reviewed.
 */
export function reviewedPropertyCopy(p, advertiser, review) {
  const copy = reviewedCopy(p, advertiser, review);
  if (sha256(JSON.stringify(copy)) !== review?.captionSha256) throw new Error(`${p?.id}: caption changed since review`);
  return copy;
}
/**
 * TikTok, property: the full reviewed Arabic block (title, place, specs, price, CTA + link,
 * disclosures, advertiser · FAL · phone, licence line when set, render note) — the same
 * disclosures as Instagram — then one short English line, then hashtags.
 */
export function tiktokPropertyCaption(p, advertiser, review, { max = CHANNELS.tiktok.maxCaption } = {}) {
  const copy = reviewedPropertyCopy(p, advertiser, review);
  const note = photoNoteText(p);
  const en = [note.en, `${p.title.en} · ${place(p, 'en')} · ${deal(p).en}`, `Message Bona with ${p.id}.`].filter(Boolean).join(' ');
  let tags = dedupe([...TIKTOK_CORE_TAGS, ...copy.hashtags]).slice(0, 10);
  let parts = [copy.ar, en, tags.join(' ')];
  while (!fit(parts, max) && tags.length > TIKTOK_CORE_TAGS.length) { tags = tags.slice(0, -1); parts = [copy.ar, en, tags.join(' ')]; }
  if (!fit(parts, max)) parts = [copy.ar, tags.join(' ')];
  return finish(parts, max);
}
/** LinkedIn, property: the full reviewed English block, then the Arabic title line and the Arabic advertiser line, then a few hashtags. */
export function linkedinPropertyCaption(p, advertiser, review, { max = CHANNELS.linkedin.maxCaption } = {}) {
  const copy = reviewedPropertyCopy(p, advertiser, review);
  const note = photoNoteText(p);
  const ar = [note.ar, `${p.title.ar} — ${[place(p, 'ar'), deal(p).ar].filter(Boolean).join(' · ')}`,
    `المعلن: ${advertiser.name.ar} · فال ${advertiser.fal} · ${advertiser.phone}`].filter(Boolean).join('\n');
  const tags = dedupe(['#BonaRealEstate', ...copy.hashtags.filter(t => /^#[A-Za-z]/.test(t)), '#SaudiRealEstate']).slice(0, 5);
  return finish([copy.en, ar, tags.join(' ')], max);
}
export function tiktokEducationCaption(item, { fal, max = CHANNELS.tiktok.maxCaption }) {
  const tags = [...TIKTOK_CORE_TAGS, '#نصائح_عقارية', '#BonaRealEstate'];
  return finish([`${item.topic.ar}\n${item.caption.ar}`, item.topic.en, `بونا · ترخيص فال ${fal}`, tags.join(' ')], max);
}
export function linkedinEducationCaption(item, { fal, max = CHANNELS.linkedin.maxCaption }) {
  const tags = ['#BonaRealEstate', '#JeddahRealEstate', '#SaudiRealEstate'];
  return finish([`${item.topic.en}\n\n${item.caption.en}`, item.topic.ar, `Bona · FAL ${fal} · ${SITE.replace('https://', '')}`, tags.join(' ')], max);
}
function finish(parts, max) {
  const text = parts.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  const why = refuseText(text);
  if (why) throw new Error(`caption refused: ${why}`);
  if (/\[add number before publishing\]|\[يُضاف قبل النشر\]/.test(text)) throw new Error('caption refused: licence placeholder');
  if (text.length > max) throw new Error(`caption is ${text.length} characters, over ${max}`);
  return text;
}
export function captionFor(channel, choice, { advertiser, fal }) {
  if (choice.kind === 'property') return channel === 'tiktok'
    ? tiktokPropertyCaption(choice.listing, advertiser, choice.review)
    : linkedinPropertyCaption(choice.listing, advertiser, choice.review);
  return channel === 'tiktok' ? tiktokEducationCaption(choice.item, { fal }) : linkedinEducationCaption(choice.item, { fal });
}
/** The CTA card's licence pair for a property reel: the advertiser line every caption carries, plus the ad-licence line once the listing has one. */
export function reelLicenceLines(p, advertiser) {
  const lic = /^\d{8,15}$/.test(p?.licence?.adNumber ?? '') ? p.licence.adNumber : null;
  return {
    ar: [`المعلن: ${advertiser.name.ar} · فال ${advertiser.fal}`, lic && `ترخيص الإعلان ${lic}`].filter(Boolean).join(' · '),
    en: [`Advertiser ${advertiser.name.en} · FAL ${advertiser.fal}`, lic && `Ad licence ${lic}`].filter(Boolean).join(' · '),
  };
}
export { showsPrice };
