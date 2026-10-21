import crypto from 'node:crypto';
import { ksaNow } from './daily-pack.mjs';
import { CAPTION_MAX_CHARS, CAPTION_MAX_HASHTAGS, countHashtags } from './graph.mjs';

export const SITE = 'https://bona-real-estate.com';
export const ACCOUNT = Object.freeze({ instagram: '17841427688957180', facebook: '1245646955305748' });
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export function publicListing(p) {
  const out = Object.fromEntries(['id','slug','status','category','type','title','location','price','specs','highlights'].map(k => [k,p[k] ?? null]));
  out.images = (p.images ?? []).map(({src,thumb,alt})=>({src,thumb,alt}));
  out.licence = p.licence ? {adNumber:p.licence.adNumber ?? null,adExpiry:p.licence.adExpiry ?? null,wafiNumber:p.licence.wafiNumber ?? null} : null;
  // Only when set: adding the key to every listing would change every reviewed listing's factsSha256.
  if (p.photoNote != null) out.photoNote = {en:p.photoNote?.en ?? null,ar:p.photoNote?.ar ?? null};
  return out;
}
export const fingerprint = p => sha256(JSON.stringify(publicListing(p)));
export const advertiserFingerprint = a => sha256(JSON.stringify(a));
export function imageUrl(src) {
  const u = new URL(src, SITE);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash ||
      !['bona-real-estate.com','tk-storage.azoz.uk'].includes(u.hostname) || !/\.jpe?g$/i.test(u.pathname)) throw new Error('Unapproved source image URL');
  return u.href;
}
export function realDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s ?? '')) return false;
  const d = new Date(s+'T00:00:00Z');
  return Number.isFinite(+d) && d.toISOString().slice(0,10) === s;
}
/**
 * Derived 4:5 media (owner, 2026-10-21). A frame with `fit: 'pad-4x5'` is published as its padded
 * variant (`media`): the source photo centred, whole, on a 1080x1350 brand canvas, rendered at
 * approval by lib/property-media.mjs and hosted with the site under /social/property/<id>/. A
 * frame of kind `card` (land only, policy `cards: "land-only"`) is a branded plot card hosted the
 * same way; a satellite card names the listing still it was made from (`source`). The source's
 * and the media's SHA-256 are both checked before anything is sent.
 */
export const PAD_FIT = 'pad-4x5';
export const MEDIA_SIZE = Object.freeze({ width: 1080, height: 1350 });
/** A padded frame's source aspect bounds: nothing is cropped, so portrait sources below 0.8 are fine; past 9:16 or 1.91 the photo is too small on the canvas. */
export const PAD_ASPECT = Object.freeze({ min: 0.56, max: 1.91 });
export const CARD_KINDS = Object.freeze(['satellite', 'facts', 'location']);
/** Where a listing's derived media is served (public/social/property/<id>/ in the repository). */
export const mediaBase = id => `${SITE}/social/property/${encodeURIComponent(id)}/`;
/** The size a frame is shown at: the padded variant's for a padded frame, else its own. */
export const shownSize = x => (x?.fit === PAD_FIT && x.media ? x.media : x);
/** The URL a frame is published from: the padded variant for a padded frame, else the frame (or card) itself. */
export const mediaUrl = x => (x?.fit === PAD_FIT && x.media?.url ? x.media.url : x?.url);
/** True when the derived media record is a hosted 1080x1350 JPEG of this listing with a SHA-256. */
export function derivedMediaOk(m, id) {
  if (!m || typeof m.url !== 'string' || !m.url.startsWith(mediaBase(id))) return false;
  try { imageUrl(m.url); } catch { return false; }
  return /^[a-f0-9]{64}$/.test(m.sha256 ?? '') && m.width === MEDIA_SIZE.width && m.height === MEDIA_SIZE.height;
}
/** True when a review carries plot cards. */
export const hasCards = review => (review?.photos ?? []).some(x => x?.kind === 'card');
/** 'satellite' when a review's cards show satellite imagery, 'text' when they are text-only, null without cards. */
export const cardsKind = review => (!hasCards(review) ? null : review.photos.some(x => x?.kind === 'card' && x.source != null) ? 'satellite' : 'text');
/** Instagram crops every carousel frame to the first frame's aspect ratio; keep that crop small. Padded frames count at 4:5. */
export function aspectConsistent(photos, tolerance = 0.15) {
  if (!photos.length) return false;
  const ratio = p => { const s = shownSize(p); return s.width / s.height; };
  const first = ratio(photos[0]);
  return photos.every(p => Math.abs(ratio(p) - first) / first <= tolerance);
}
const positive = n => Number.isFinite(n) && n > 0;
function fresh(ts, now, maxDays) {
  const n = Date.parse(ts);
  return Number.isFinite(n) && n <= +now && +now - n <= maxDays*86400000;
}
/**
 * A licence line the caption may carry: an 8–15 digit number with a real expiry date (eligibility
 * also refuses one that has expired). Stricter than lib/listing.mjs adLicence(), which takes a number
 * without an expiry for the legacy queue: this caption always pairs the number with its expiry, as
 * the 2 October licence gate does, and a line that cannot be shown to be current is worse than none.
 */
export const showsLicence = l => /^\d{8,15}$/.test(l?.adNumber ?? '') && realDate(l?.adExpiry);
/** Whether the caption prints a price: a SAR amount that is not "on request". disclosuresFor() follows the same test. */
export const showsPrice = p => Boolean(p?.price?.amount && p.price.currency === 'SAR' && !p.price.onRequest);
const CATEGORIES = ['buy', 'rent', 'off-plan'];
/** What a policy without the 2026-10-05 fields means: licensed Saudi sale/rent stock, real photographs, 30-day reviews, 30-day repeats. */
export const STRICT_RULES = Object.freeze({ licenceRequired: true, countries: Object.freeze(['SA']), categories: Object.freeze(['buy', 'rent']), renders: 'none', cards: 'none', satellite: true, reviewValidDays: 30, repeatDays: 30 });
/**
 * Bounds of the policy's repeatDays, the one repeat interval every daily channel reads (Instagram,
 * Facebook, TikTok, LinkedIn). What makes a repeat safe is its changed frame order (pickFrames()):
 * same caption, different image sequence, so a different content hash. The 14-day floor matches
 * publish.mjs's duplicate window (dedupeDays: same images + caption within 14×24 h is skipped), so
 * at most one earlier post of a listing can fall inside that window.
 */
export const REPEAT_DAYS_MIN = 14, REPEAT_DAYS_MAX = 90;
/** property-policy.json → eligibility rules. Anything unreadable throws: no run proceeds on a policy it cannot read. */
export function policyRules(policy = {}, now = new Date()) {
  const licence = policy.adLicence ?? { requirement: 'required' };
  if (!['required', 'waived'].includes(licence.requirement)) throw new Error('Invalid ad-licence requirement in the property policy');
  if (licence.requirement === 'waived' && (typeof licence.by !== 'string' || !licence.by.trim() || !realDate(licence.on) || licence.on > ksaNow(now).date))
    throw new Error('An ad-licence waiver must name who waived it and a date that is not in the future');
  const countries = policy.countries ?? STRICT_RULES.countries;
  if (!Array.isArray(countries) || !countries.length || countries.some(c => !/^[A-Z]{2}$/.test(c))) throw new Error('Invalid countries in the property policy');
  const categories = policy.categories ?? STRICT_RULES.categories;
  if (!Array.isArray(categories) || !categories.length || categories.some(c => !CATEGORIES.includes(c))) throw new Error('Invalid categories in the property policy');
  const renders = policy.renders ?? STRICT_RULES.renders;
  if (!['none', 'off-plan-only'].includes(renders)) throw new Error('Invalid renders rule in the property policy');
  const cards = policy.cards ?? STRICT_RULES.cards;
  if (!['none', 'land-only'].includes(cards)) throw new Error('Invalid cards rule in the property policy');
  // satellite: false (owner may drop the Esri imagery) refuses every card showing a satellite still.
  const satellite = policy.satellite ?? STRICT_RULES.satellite;
  if (typeof satellite !== 'boolean') throw new Error('Invalid satellite rule in the property policy');
  const reviewValidDays = policy.reviewValidDays ?? STRICT_RULES.reviewValidDays;
  if (!Number.isInteger(reviewValidDays) || reviewValidDays < 1 || reviewValidDays > 180) throw new Error('Invalid reviewValidDays in the property policy');
  const repeatDays = policy.repeatDays ?? STRICT_RULES.repeatDays;
  if (!Number.isInteger(repeatDays) || repeatDays < REPEAT_DAYS_MIN || repeatDays > REPEAT_DAYS_MAX) throw new Error('Invalid repeatDays in the property policy');
  return Object.freeze({ licenceRequired: licence.requirement === 'required', countries: Object.freeze([...countries]), categories: Object.freeze([...categories]), renders, cards, satellite, reviewValidDays, repeatDays });
}
export function eligibility(p, review, advertiser, now = new Date(), rules = STRICT_RULES) {
  const reasons = [];
  if (p?.status !== 'available') reasons.push('not_available');
  if (!rules.countries.includes(p?.location?.countryCode) || !rules.categories.includes(p?.category)) reasons.push('outside_policy_scope');
  const licence = p?.licence;
  if (rules.licenceRequired) {
    if (!/^\d{8,15}$/.test(licence?.adNumber ?? '')) reasons.push('missing_ad_licence');
    if (!realDate(licence?.adExpiry) || licence.adExpiry < ksaNow(now).date) reasons.push('missing_or_expired_ad_licence');
  } else if (licence?.adNumber && (!showsLicence(licence) || licence.adExpiry < ksaNow(now).date)) reasons.push('ad_licence_invalid_or_expired');
  if (!review || review.status !== 'approved') reasons.push('photo_and_copy_review_pending');
  if (!review) return reasons;
  if (review.factsSha256 !== fingerprint(p)) reasons.push('listing_changed_since_review');
  if (review.advertiserSha256 !== advertiserFingerprint(advertiser)) reasons.push('advertiser_changed_since_review');
  if (!fresh(review.reviewedAt,now,rules.reviewValidDays)) reasons.push('review_expired');
  if (rules.licenceRequired) {
    const e = review.licenceEvidence;
    if (!e || e.adNumber !== licence?.adNumber || e.adExpiry !== licence?.adExpiry ||
        !e.sourceReference || !e.marketingAuthorizationReference || e.socialMediaAllowed !== true ||
        e.contactMatches !== true || !fresh(e.verifiedAt,now,30)) reasons.push('licence_and_marketing_authority_unverified');
  }
  if (review.legalDisclosuresVerified !== true || !review.legalDisclosures?.ar?.trim() || !review.legalDisclosures?.en?.trim()) reasons.push('property_condition_services_and_rights_disclosures_pending');
  if (!advertiser?.name?.ar || !advertiser?.name?.en || !/^\d{8,15}$/.test(advertiser?.fal ?? '') ||
      !/^\+\d{8,15}$/.test(advertiser?.phone ?? '')) reasons.push('advertiser_details_incomplete');
  const photos = review.photos ?? [];
  // Plot cards stand alone: a set is all cards or none. A text-only land set (no satellite still, policy satellite: false) may be two cards.
  const cardCount = photos.filter(x => x?.kind === 'card').length;
  if (cardCount && cardCount !== photos.length) reasons.push('mixed_cards_and_photos');
  const min = cardCount && cardCount === photos.length && !photos.some(x => x.source != null) ? 2 : 3;
  if (photos.length < min || photos.length > 6 || new Set(photos.map(x=>x.url)).size !== photos.length) reasons.push('need_three_to_six_distinct_photos');
  const allowed = new Set((p.images ?? []).map(x=>{try{return imageUrl(x.src)}catch{return null}}));
  const rendersAllowed = rules.renders === 'off-plan-only' && p?.category === 'off-plan';
  const cardsAllowed = rules.cards === 'land-only' && p?.type === 'land';
  const sourceOk = s => { try { return allowed.has(imageUrl(s?.url)) && /^[a-f0-9]{64}$/.test(s.sha256 ?? '') && positive(s.width) && positive(s.height); } catch { return false; } };
  for (const photo of photos) {
    if (photo?.kind === 'card') {
      // A plot card: land only, a hosted 1080x1350 card of this listing; a satellite or location card names its listing still.
      if (!cardsAllowed) reasons.push('card_not_allowed');
      if (photo.source != null && !rules.satellite) reasons.push('satellite_imagery_off');
      // The satellite card always shows its still; the location card may be text-only; the facts card never shows one.
      if (!CARD_KINDS.includes(photo.card) || !derivedMediaOk(photo, p?.id) || photo.visuallyApproved !== true || photo.fit != null ||
          !photo.alt?.ar || !photo.alt?.en || (photo.source != null && !sourceOk(photo.source)) ||
          (photo.card === 'satellite' && photo.source == null) || (photo.card === 'facts' && photo.source != null)) reasons.push('card_media_unverified');
      continue;
    }
    let url; try { url = imageUrl(photo.url); } catch { reasons.push('unapproved_photo_source'); continue; }
    if (photo.kind === 'render' && !rendersAllowed) reasons.push('render_not_allowed');
    // A padded frame is never cropped, so its source may be narrower than 0.8; the size floor still applies to the source.
    const padded = photo.fit != null;
    if (padded && (photo.fit !== PAD_FIT || !derivedMediaOk(photo.media, p?.id))) reasons.push('padded_media_unverified');
    const [lo, hi] = padded ? [PAD_ASPECT.min, PAD_ASPECT.max] : [0.8, 1.91];
    if (!allowed.has(url) || !['photograph','render'].includes(photo.kind) || photo.visuallyApproved !== true ||
        !/^[a-f0-9]{64}$/.test(photo.sha256 ?? '') || !positive(photo.width) || !positive(photo.height) || photo.width < 1080 || photo.height < 720 ||
        photo.width/photo.height < lo || photo.width/photo.height > hi || !photo.alt?.ar || !photo.alt?.en) reasons.push('photo_quality_or_provenance_unverified');
  }
  if (photos.length && !aspectConsistent(photos)) reasons.push('carousel_aspect_mismatch');
  // Photos of another project (an owner-confirmed photoNote): the caption opens with the note, in both languages,
  // and none of the frames may be presented as the developer's renders of this listing.
  const note = p?.photoNote != null ? photoNoteText(p) : null;
  if (note && !note.ar) reasons.push('photo_note_malformed');
  if (note && photos.some(x => x.kind === 'render')) reasons.push('photo_note_conflicts_with_renders');
  const copy = reviewedCopy(p,advertiser,review);
  if (review.captionSha256 !== sha256(JSON.stringify(copy))) reasons.push('caption_changed_since_review');
  if (note?.ar && !(copy.ar.includes(note.ar) && copy.en.includes(note.en))) reasons.push('photo_note_not_in_caption');
  // The text publish.mjs composeCaption() sends to Instagram for a two-language caption, held to graph.mjs's limits.
  const text = [copy.ar, copy.en].join('\n\n—\n\n') + '\n\n' + copy.hashtags.join(' ');
  if (text.length > CAPTION_MAX_CHARS || countHashtags(text) > CAPTION_MAX_HASHTAGS) reasons.push('caption_exceeds_platform_limits');
  return [...new Set(reasons)];
}
/** 'none' | 'some' | 'all' — how many reviewed photographs are developer renders. */
export function renderShare(review) {
  const kinds = (review?.photos ?? []).map(x => x.kind);
  const renders = kinds.filter(k => k === 'render').length;
  return renders === 0 ? 'none' : renders === kinds.length ? 'all' : 'some';
}
/** Said once in each language whenever a review carries plot cards: what the images are, and nothing they are not. */
export const CARD_NOTE = Object.freeze({
  ar: 'الصور الجوية تقريبية، والبطاقات معدّة من بيانات الإعلان.',
  en: 'Satellite views are approximate; the cards are made from the listing details.',
});
/** The same, for text-only cards (policy satellite: false). */
export const CARD_NOTE_TEXT = Object.freeze({
  ar: 'البطاقات معدّة من بيانات الإعلان.',
  en: 'The cards are made from the listing details.',
});
const RENDER_NOTE = Object.freeze({
  all: { ar: 'الصور تصاميم تصوّرية من المطوّر.', en: "Images are the developer's artist's impressions." },
  some: { ar: 'بعض الصور تصاميم تصوّرية من المطوّر.', en: "Some images are the developer's artist's impressions." },
});
/** A listing's photoNote when it is usable in both languages (at least three Arabic / Latin letters; the Arabic
    block's punctuation and digits do not count), else {}. Same rule as rules.mjs photoNoteProblems. */
export function photoNoteText(p) {
  const n = p?.photoNote, en = typeof n?.en === 'string' ? n.en.trim() : '', ar = typeof n?.ar === 'string' ? n.ar.trim() : '';
  const count = (s, re) => (s.match(re) ?? []).length;
  return count(en, /[A-Za-z]/g) >= 3 && count(ar, /[\u0621-\u063A\u0641-\u064A\u0671-\u06D3]/g) >= 3 ? { ar, en } : {};
}
export function propertyCaption(p, advertiser, disclosures = {}, { renders = 'none', cards = false } = {}) {
  const n = x => Number(x).toLocaleString('en-US');
  const ar = [], en = [];
  if (p.specs?.beds) {
    // Arabic number agreement: 1 and 2 have their own forms, 3–10 take the plural, 11 and more the singular.
    const beds = Number(p.specs.beds);
    ar.push(beds === 1 ? 'غرفة نوم واحدة' : beds === 2 ? 'غرفتا نوم' : beds >= 3 && beds <= 10 ? `${n(beds)} غرف نوم` : `${n(beds)} غرفة نوم`);
    en.push(beds === 1 ? '1 bedroom' : `${n(beds)} bedrooms`);
  }
  if (p.specs?.plotSqm) { ar.push(`مساحة الأرض ${n(p.specs.plotSqm)} م²`); en.push(`${n(p.specs.plotSqm)} m² plot`); }
  else if (p.specs?.areaSqm) { ar.push(`المساحة ${n(p.specs.areaSqm)} م²`); en.push(`${n(p.specs.areaSqm)} m²`); }
  if (showsPrice(p)) {
    ar.push(`${p.price.from ? 'تبدأ الأسعار من ' : ''}${n(p.price.amount)} ريال${p.category === 'rent' ? ' — '+(p.price.period ?? 'مدة الإيجار عند الاستفسار') : ''}`);
    en.push(`${p.price.from ? 'From ' : ''}SAR ${n(p.price.amount)}${p.category === 'rent' ? ' / '+(p.price.period ?? 'enquire for rental period') : ''}`);
  }
  const url = `${SITE}/properties/${encodeURIComponent(p.slug)}/`;
  const deal = p.category === 'rent' ? { ar: 'للإيجار', en: 'For rent' } : p.category === 'off-plan' ? { ar: 'على الخارطة', en: 'Off-plan' } : { ar: 'للبيع', en: 'For sale' };
  // Off-plan units are not viewed before delivery: ask about the project, promise no viewing.
  const cta = p.category === 'off-plan'
    ? { ar: `تبحث عن وحدة في هذا المشروع؟ راسل بونا بالرقم ${p.id} لمعرفة التوفر والتفاصيل.`, en: `Interested? Message Bona with ${p.id} for availability and details.` }
    // A plot is not a home: land asks about "a plot with these specifications" (no existing review is of land).
    : { ar: `تبحث عن ${p.type === 'land' ? 'أرض' : 'منزل'} بهذه المواصفات؟ راسل بونا بالرقم ${p.id} لمعرفة التوفر وترتيب معاينة.`, en: `Interested? Message Bona with ${p.id} for current availability and a viewing.` };
  const place = l => [p.location?.district?.[l], p.location?.city?.[l]].filter(Boolean).join(l === 'ar' ? '، ' : ', ');
  const lines = (...xs) => xs.filter(Boolean).join('\n');
  const blocks = (...xs) => xs.filter(Boolean).join('\n\n');
  const note = cards === 'text' ? CARD_NOTE_TEXT : cards ? CARD_NOTE : RENDER_NOTE[renders] ?? {};
  // Photos of another project say so on the caption's first line, the only one a feed preview reliably shows.
  const photos = photoNoteText(p);
  const licence = showsLicence(p.licence)
    ? { ar: `ترخيص الإعلان: ${p.licence.adNumber} · ينتهي ${p.licence.adExpiry}`, en: `Ad licence ${p.licence.adNumber} · Expires ${p.licence.adExpiry}` }
    : {};
  return {
    ar: blocks(
      lines(photos.ar, p.title.ar, [place('ar'), deal.ar].filter(Boolean).join(' · ')),
      ar.join(' · '),
      lines(cta.ar, url),
      lines(disclosures.ar, `المعلن: ${advertiser.name.ar} · فال ${advertiser.fal} · ${advertiser.phone}`, licence.ar, note.ar)),
    en: blocks(
      lines(photos.en, p.title.en, [place('en'), deal.en].filter(Boolean).join(' · ')),
      en.join(' · '),
      lines(cta.en, url),
      lines(disclosures.en, `Advertiser: ${advertiser.name.en} · FAL ${advertiser.fal} · ${advertiser.phone}`, licence.en, note.en)),
  };
}
/** The caption a review binds: its disclosures and whether its photographs are renders. */
export const captionFor = (p, advertiser, review) => propertyCaption(p, advertiser, review?.legalDisclosures ?? {}, { renders: renderShare(review), cards: cardsKind(review) });
/** Everything a review's captionSha256 binds: the caption and the generated hashtags, as they would be posted. */
export const reviewedCopy = (p, advertiser, review) => ({ ...captionFor(p, advertiser, review), hashtags: propertyHashtags(p) });

const TYPE_WORDS = Object.freeze({
  villa: { ar: 'فلل', en: 'Villas' }, mansion: { ar: 'قصور', en: 'Mansions' },
  apartment: { ar: 'شقق', en: 'Apartments' }, penthouse: { ar: 'بنتهاوس', en: 'Penthouses' },
  duplex: { ar: 'دوبلكس', en: 'Duplexes' }, townhouse: { ar: 'تاون_هاوس', en: 'Townhouses' },
  land: { ar: 'أراضي', en: 'Land' },
});
const firstPart = s => String(s ?? '').split(/[،,]/)[0].trim();
const wordCount = s => firstPart(s).split(/\s+/).filter(Boolean).length;
const arTag = s => firstPart(s).replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '');
const enTag = s => firstPart(s).split(/[\s-]+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
/** Deterministic hashtags from listing facts (bound by the review's factsSha256): at most twelve. */
export function propertyHashtags(p) {
  const city = p.location?.city ?? {}, district = p.location?.district ?? {};
  const cityAr = arTag(city.ar), cityEn = enTag(city.en), word = TYPE_WORDS[p.type];
  const deal = p.category === 'rent' ? 'للإيجار' : 'للبيع';
  const out = ['#بونا', '#BonaRealEstate'];
  if (cityAr) out.push(`#عقارات_${cityAr}`);
  if (cityEn) out.push(`#${cityEn}RealEstate`);
  if (word && cityAr) out.push(`#${word.ar}_${cityAr}`);
  if (word) out.push(`#${word.ar}_${deal}`);
  if (word && cityEn) out.push(`#${cityEn}${word.en}`);
  if (p.category === 'off-plan') out.push('#مشاريع_على_الخارطة', '#OffPlan');
  if (district.ar && wordCount(district.ar) <= 3 && arTag(district.ar)) out.push(`#${arTag(district.ar)}`);
  if (district.en && wordCount(district.en) <= 3 && enTag(district.en)) out.push(`#${enTag(district.en)}`);
  out.push('#عقارات_فاخرة');
  return [...new Set(out)].slice(0, 12);
}
export function dayState(events, channel, date) {
  const records = events.filter(x => x.channel === channel && x.date === date);
  if (records.some(x => x.status === 'published')) return 'published';
  if (records.some((x, i) => ['intent', 'uncertain'].includes(x.status) && !records.slice(i + 1).some(y => y.status === 'confirmed-not-published'))) return 'uncertain';
  return 'ready';
}
/** True while an intent/uncertain attempt on this channel has no 'published' record, nor a 'confirmed-not-published' record written after it. */
export function unsettled(events, channel) {
  return events.some((e, i) => e.channel === channel && ['intent', 'uncertain'].includes(e.status) &&
    !events.some((p, j) => p.channel === channel && p.id === e.id && (p.status === 'published' || (p.status === 'confirmed-not-published' && j > i))));
}
/** Riyadh calendar day number of an instant: a repeat interval counts whole Riyadh days, not hours. */
const riyadhDay = ms => Math.round(Date.parse(`${ksaNow(new Date(ms)).date}T00:00:00Z`) / 86400000);
/** When this listing was last published on this channel (ms), 0 if never. */
export const lastPublished = (events, channel, id) =>
  Math.max(0, ...events.filter(x => x.channel === channel && x.listingId === id && x.status === 'published').map(x => Date.parse(x.at) || 0));
/**
 * Today's property on this channel. Eligible: everything eligibility() passes and not published on
 * this channel within the last `repeatDays` Riyadh calendar days (posted on day D, it may return on
 * day D + repeatDays; a future-dated record counts as recent). Order: least recently posted on this
 * channel first, never-posted listings before all others (so a newly approved listing goes out
 * next), then by id.
 */
/**
 * Listing families for spacing (owner review 2026-10-21): listings whose reviews share an image
 * (the same SHA-256, e.g. BONA-W003/W004/W005's common Malfa renders) are one family, and every
 * plot-card review is one family ("land cards"). Returns id → family key (the smallest id in it).
 */
export function familyOf(reviews = {}) {
  const ids = Object.keys(reviews).sort(), parent = new Map(ids.map(id => [id, id]));
  const find = id => { while (parent.get(id) !== id) id = parent.get(id); return id; };
  const join = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(x < y ? y : x, x < y ? x : y); };
  const bySha = new Map();
  for (const id of ids) {
    const photos = reviews[id]?.photos ?? [];
    const shas = photos.flatMap(x => [x.kind === 'card' ? null : x.sha256, x.media?.sha256, x.source?.sha256]).filter(Boolean);
    if (photos.some(x => x.kind === 'card')) shas.push('family:land-cards');
    for (const sha of shas) { if (bySha.has(sha)) join(id, bySha.get(sha)); else bySha.set(sha, id); }
  }
  return new Map(ids.map(id => [id, find(id)]));
}
export function chooseProperty(listings, reviews, advertiser, events, channel, now = new Date(), repeatDays = undefined, rules = STRICT_RULES) {
  repeatDays ??= rules?.repeatDays ?? STRICT_RULES.repeatDays;
  const rejected = [];
  const last = id => lastPublished(events, channel, id);
  const recent = id => { const t = last(id); return t > 0 && (t > +now || riyadhDay(+now) - riyadhDay(t) < repeatDays); };
  const candidates = listings.filter(p=>{
    const why = eligibility(p,reviews[p.id],advertiser,now,rules);
    if (recent(p.id)) why.push('recently_published');
    if (why.length) { rejected.push({id:p.id,reasons:why}); return false; }
    return true;
  }).sort((a,b)=>last(a.id)-last(b.id)||a.id.localeCompare(b.id));
  // Spacing: skip a candidate whose family was published on this channel yesterday (Riyadh), when another candidate is not.
  const family = familyOf(reviews), today = riyadhDay(+now);
  const postedYesterday = new Set(events.filter(x => x.channel === channel && x.status === 'published' && Number.isFinite(Date.parse(x.at)) &&
    riyadhDay(Date.parse(x.at)) === today - 1).map(x => family.get(x.listingId) ?? x.listingId));
  const spaced = candidates.filter(p => !postedYesterday.has(family.get(p.id) ?? p.id));
  const ordered = [...spaced, ...candidates.filter(p => !spaced.includes(p))];
  return {listing:ordered[0] ?? null,rejected,candidates:ordered};
}
/** How many times this listing has been published on this channel (distinct post ids): 0 on its first post. */
export function repeatIndex(events, channel, id) {
  const ids = new Set(events.filter(x => x.channel === channel && x.listingId === id && x.status === 'published').map(x => x.id ?? x.at));
  return ids.size;
}
/**
 * The frame orders a repeat may use, all made only of the review's own approved frames: first the
 * reviewed order, then each other frame as the cover with the rest following in review order
 * (wrapping), then the same covers with the rest reversed. Orders whose frames would not all sit
 * within the carousel aspect tolerance of the new cover (Instagram crops to the first frame) are
 * dropped; the reviewed order always qualifies. Values are 0-based indexes into review.photos.
 */
export function frameOrders(photos = []) {
  const n = photos.length, seen = new Set(), out = [];
  const add = order => { const key = order.join(','); if (seen.has(key) || !aspectConsistent(order.map(i => photos[i]))) return; seen.add(key); out.push(order); };
  const rest = c => Array.from({ length: n - 1 }, (_, j) => (c + 1 + j) % n);
  for (let c = 0; c < n; c++) add([c, ...rest(c)]);
  for (let c = 0; c < n; c++) add([c, ...rest(c).reverse()]);
  return out;
}
/**
 * The review with its approved frames in the order for this listing's `repeat`-th post on a channel
 * (repeatIndex()): the reviewed order on the first post, a different cover and order on each repeat,
 * deterministic. When `lastPosted` (the image URL sequence of the previous post) is given, the first
 * order in the sequence starting at `repeat` whose URL sequence differs from it is taken, so a
 * re-review that adds, removes or reorders frames never repeats the last post. Only the order
 * changes: same frames, hashes, kinds and alt texts, so the caption (captionSha256), renderShare()
 * and eligibility() are exactly the review's.
 */
export function variedReview(review, repeat = 0, lastPosted = null) {
  const photos = review?.photos ?? [], orders = frameOrders(photos);
  if (!orders.length) return { review, order: [] };
  const start = ((repeat % orders.length) + orders.length) % orders.length;
  const same = order => Array.isArray(lastPosted) && order.length === lastPosted.length && order.every((i, k) => photos[i].url === lastPosted[k]);
  let order = orders[start];
  for (let k = 0; k < orders.length; k++) { const o = orders[(start + k) % orders.length]; if (!same(o)) { order = o; break; } }
  return { review: { ...review, photos: order.map(i => review.photos[i]) }, order };
}
/**
 * The image URL sequence of this listing's last published post on this channel, or null if never.
 * Rows written since 2026-10-21 carry `images`; older ones `frameOrder` (1-based positions in the
 * review), mapped through the current review; rows with neither were the reviewed order.
 */
export function lastPostedSequence(events, channel, id, review) {
  const rows = events.filter(x => x.channel === channel && x.listingId === id && x.status === 'published');
  if (!rows.length) return null;
  const last = rows.reduce((a, b) => ((Date.parse(b.at) || 0) >= (Date.parse(a.at) || 0) ? b : a));
  const photos = review?.photos ?? [];
  if (Array.isArray(last.images) && last.images.every(u => typeof u === 'string')) return last.images;
  if (Array.isArray(last.frameOrder) && last.frameOrder.every(n => Number.isInteger(n) && photos[n - 1])) return last.frameOrder.map(n => photos[n - 1].url);
  return photos.map(x => x.url);
}
/** This post's frames on this channel: variedReview() at repeatIndex(), never the last posted sequence. Returns { review, order, frameOrder, images }. */
export function pickFrames(review, events, channel, id) {
  const { review: framed, order } = variedReview(review, repeatIndex(events, channel, id), lastPostedSequence(events, channel, id, review));
  return { review: framed, order, frameOrder: order.map(i => i + 1), images: (framed?.photos ?? []).map(x => x.url) };
}
/** publish.mjs's duplicate window: the same images + caption within this many 24-hour days is a duplicate. */
export const DEDUPE_DAYS = 14;
/** A `published` ledger row with this content hash inside the duplicate window (ms, like publish.mjs), or null. */
export function recentDuplicate(rows, hash, now = new Date(), days = DEDUPE_DAYS) {
  return rows.find(r => r.status === 'published' && r.contentHash === hash && Number.isFinite(Date.parse(r.ts ?? r.at)) &&
    +now - Date.parse(r.ts ?? r.at) <= days * 86400000) ?? null;
}
export function entryFor(p, review, advertiser, channel, date, assets = []) {
  return {id:`bona-daily-${channel==='instagram'?'ig':'fb'}-${date}`,date,time:'20:30',platform:channel,
    listingId:p.id,topic:p.title,format:'carousel',caption:captionFor(p,advertiser,review),hashtags:propertyHashtags(p),
    reviewStatus:'approved',adLicenceRequired:false,adLicenceVerified:true,blocked:false,
    images:review.photos.map(mediaUrl),assets,assetsJpg:assets,alt:review.photos[0].alt,status:'planned'};
}
