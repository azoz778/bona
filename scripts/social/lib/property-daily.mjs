import crypto from 'node:crypto';
import { ksaNow } from './daily-pack.mjs';

export const SITE = 'https://bona-real-estate.com';
export const ACCOUNT = Object.freeze({ instagram: '17841427688957180', facebook: '1245646955305748' });
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export function publicListing(p) {
  const out = Object.fromEntries(['id','slug','status','category','type','title','location','price','specs','highlights'].map(k => [k,p[k] ?? null]));
  out.images = (p.images ?? []).map(({src,thumb,alt})=>({src,thumb,alt}));
  out.licence = p.licence ? {adNumber:p.licence.adNumber ?? null,adExpiry:p.licence.adExpiry ?? null,wafiNumber:p.licence.wafiNumber ?? null} : null;
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
const showsLicence = l => /^\d{8,15}$/.test(l?.adNumber ?? '') && realDate(l?.adExpiry);
const CATEGORIES = ['buy', 'rent', 'off-plan'];
/** What a policy without the 2026-10-05 fields means: licensed Saudi sale/rent stock, real photographs, 30-day reviews. */
export const STRICT_RULES = Object.freeze({ licenceRequired: true, countries: Object.freeze(['SA']), categories: Object.freeze(['buy', 'rent']), renders: 'none', reviewValidDays: 30 });
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
  const reviewValidDays = policy.reviewValidDays ?? STRICT_RULES.reviewValidDays;
  if (!Number.isInteger(reviewValidDays) || reviewValidDays < 1 || reviewValidDays > 180) throw new Error('Invalid reviewValidDays in the property policy');
  return Object.freeze({ licenceRequired: licence.requirement === 'required', countries: Object.freeze([...countries]), categories: Object.freeze([...categories]), renders, reviewValidDays });
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
  if (photos.length < 3 || photos.length > 6 || new Set(photos.map(x=>x.url)).size !== photos.length) reasons.push('need_three_to_six_distinct_photos');
  const allowed = new Set((p.images ?? []).map(x=>{try{return imageUrl(x.src)}catch{return null}}));
  const rendersAllowed = rules.renders === 'off-plan-only' && p?.category === 'off-plan';
  for (const photo of photos) {
    let url; try { url = imageUrl(photo.url); } catch { reasons.push('unapproved_photo_source'); continue; }
    if (photo.kind === 'render' && !rendersAllowed) reasons.push('render_not_allowed');
    if (!allowed.has(url) || !['photograph','render'].includes(photo.kind) || photo.visuallyApproved !== true ||
        !/^[a-f0-9]{64}$/.test(photo.sha256 ?? '') || photo.width < 1080 || photo.height < 720 ||
        photo.width/photo.height < 0.8 || photo.width/photo.height > 1.91 || !photo.alt?.ar || !photo.alt?.en) reasons.push('photo_quality_or_provenance_unverified');
  }
  if (review.captionSha256 !== sha256(JSON.stringify(reviewedCopy(p,advertiser,review)))) reasons.push('caption_changed_since_review');
  return [...new Set(reasons)];
}
/** 'none' | 'some' | 'all' — how many reviewed photographs are developer renders. */
export function renderShare(review) {
  const kinds = (review?.photos ?? []).map(x => x.kind);
  const renders = kinds.filter(k => k === 'render').length;
  return renders === 0 ? 'none' : renders === kinds.length ? 'all' : 'some';
}
const RENDER_NOTE = Object.freeze({
  all: { ar: 'الصور تصاميم تصوّرية من المطوّر.', en: "Images are the developer's artist's impressions." },
  some: { ar: 'بعض الصور تصاميم تصوّرية من المطوّر.', en: "Some images are the developer's artist's impressions." },
});
export function propertyCaption(p, advertiser, disclosures = {}, { renders = 'none' } = {}) {
  const n = x => Number(x).toLocaleString('en-US');
  const ar = [], en = [];
  if (p.specs?.beds) { ar.push(`${n(p.specs.beds)} غرف نوم`); en.push(`${n(p.specs.beds)} bedrooms`); }
  if (p.specs?.plotSqm) { ar.push(`مساحة الأرض ${n(p.specs.plotSqm)} م²`); en.push(`${n(p.specs.plotSqm)} m² plot`); }
  else if (p.specs?.areaSqm) { ar.push(`المساحة ${n(p.specs.areaSqm)} م²`); en.push(`${n(p.specs.areaSqm)} m²`); }
  if (p.price?.amount && p.price?.currency === 'SAR' && !p.price?.onRequest) {
    ar.push(`${p.price.from ? 'تبدأ الأسعار من ' : ''}${n(p.price.amount)} ريال${p.category === 'rent' ? ' — '+(p.price.period ?? 'مدة الإيجار عند الاستفسار') : ''}`);
    en.push(`${p.price.from ? 'From ' : ''}SAR ${n(p.price.amount)}${p.category === 'rent' ? ' / '+(p.price.period ?? 'enquire for rental period') : ''}`);
  }
  const url = `${SITE}/properties/${encodeURIComponent(p.slug)}/`;
  const deal = p.category === 'rent' ? { ar: 'للإيجار', en: 'For rent' } : p.category === 'off-plan' ? { ar: 'على الخارطة', en: 'Off-plan' } : { ar: 'للبيع', en: 'For sale' };
  const place = l => [p.location?.district?.[l], p.location?.city?.[l]].filter(Boolean).join(l === 'ar' ? '، ' : ', ');
  const lines = (...xs) => xs.filter(Boolean).join('\n');
  const blocks = (...xs) => xs.filter(Boolean).join('\n\n');
  const note = RENDER_NOTE[renders] ?? {};
  const licence = showsLicence(p.licence)
    ? { ar: `ترخيص الإعلان: ${p.licence.adNumber} · ينتهي ${p.licence.adExpiry}`, en: `Ad licence ${p.licence.adNumber} · Expires ${p.licence.adExpiry}` }
    : {};
  return {
    ar: blocks(
      lines(p.title.ar, [place('ar'), deal.ar].filter(Boolean).join(' · ')),
      ar.join(' · '),
      lines(`تبحث عن منزل بهذه المواصفات؟ راسل بونا بالرقم ${p.id} لمعرفة التوفر وترتيب معاينة.`, url),
      lines(disclosures.ar, `المعلن: ${advertiser.name.ar} · فال ${advertiser.fal} · ${advertiser.phone}`, licence.ar, note.ar)),
    en: blocks(
      lines(p.title.en, [place('en'), deal.en].filter(Boolean).join(' · ')),
      en.join(' · '),
      `Interested? Message Bona with ${p.id} for current availability and a viewing.`,
      lines(disclosures.en, `Advertiser: ${advertiser.name.en} · FAL ${advertiser.fal} · ${advertiser.phone}`, licence.en, note.en)),
  };
}
/** The caption a review binds: its disclosures and whether its photographs are renders. */
export const captionFor = (p, advertiser, review) => propertyCaption(p, advertiser, review?.legalDisclosures ?? {}, { renders: renderShare(review) });
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
export function chooseProperty(listings, reviews, advertiser, events, channel, now = new Date(), repeatDays = 30, rules = STRICT_RULES) {
  const rejected = [];
  const last = id => Math.max(0,...events.filter(x=>x.channel===channel && x.listingId===id && x.status==='published').map(x=>Date.parse(x.at)||0));
  const candidates = listings.filter(p=>{
    const why = eligibility(p,reviews[p.id],advertiser,now,rules);
    if (+now-last(p.id) < repeatDays*86400000) why.push('recently_published');
    if (why.length) { rejected.push({id:p.id,reasons:why}); return false; }
    return true;
  }).sort((a,b)=>last(a.id)-last(b.id)||a.id.localeCompare(b.id));
  return {listing:candidates[0] ?? null,rejected};
}
export function entryFor(p, review, advertiser, channel, date, assets = []) {
  return {id:`bona-daily-${channel==='instagram'?'ig':'fb'}-${date}`,date,time:'20:30',platform:channel,
    listingId:p.id,topic:p.title,format:'carousel',caption:captionFor(p,advertiser,review),hashtags:propertyHashtags(p),
    reviewStatus:'approved',adLicenceRequired:false,adLicenceVerified:true,blocked:false,
    images:review.photos.map(x=>x.url),assets,assetsJpg:assets,alt:review.photos[0].alt,status:'planned'};
}
