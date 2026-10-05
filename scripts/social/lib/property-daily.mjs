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
export function eligibility(p, review, advertiser, now = new Date()) {
  const reasons = [];
  if (p?.status !== 'available') reasons.push('not_available');
  if (p?.location?.countryCode !== 'SA' || !['buy','rent'].includes(p?.category)) reasons.push('requires_separate_market_or_offplan_review');
  const licence = p?.licence;
  if (!/^\d{8,15}$/.test(licence?.adNumber ?? '')) reasons.push('missing_ad_licence');
  if (!realDate(licence?.adExpiry) || licence.adExpiry < ksaNow(now).date) reasons.push('missing_or_expired_ad_licence');
  if (!review || review.status !== 'approved') reasons.push('photo_and_copy_review_pending');
  if (!review) return reasons;
  if (review.factsSha256 !== fingerprint(p)) reasons.push('listing_changed_since_review');
  if (review.advertiserSha256 !== advertiserFingerprint(advertiser)) reasons.push('advertiser_changed_since_review');
  if (!fresh(review.reviewedAt,now,30)) reasons.push('review_expired');
  const e = review.licenceEvidence;
  if (!e || e.adNumber !== licence?.adNumber || e.adExpiry !== licence?.adExpiry ||
      !e.sourceReference || !e.marketingAuthorizationReference || e.socialMediaAllowed !== true ||
      e.contactMatches !== true || !fresh(e.verifiedAt,now,30)) reasons.push('licence_and_marketing_authority_unverified');
  if (review.legalDisclosuresVerified !== true || !review.legalDisclosures?.ar?.trim() || !review.legalDisclosures?.en?.trim()) reasons.push('property_condition_services_and_rights_disclosures_pending');
  if (!advertiser?.name?.ar || !advertiser?.name?.en || !/^\d{8,15}$/.test(advertiser?.fal ?? '') ||
      !/^\+\d{8,15}$/.test(advertiser?.phone ?? '')) reasons.push('advertiser_details_incomplete');
  const photos = review.photos ?? [];
  if (photos.length < 3 || photos.length > 6 || new Set(photos.map(x=>x.url)).size !== photos.length) reasons.push('need_three_to_six_distinct_photos');
  const allowed = new Set((p.images ?? []).map(x=>{try{return imageUrl(x.src)}catch{return null}}));
  for (const photo of photos) {
    let url; try { url = imageUrl(photo.url); } catch { reasons.push('unapproved_photo_source'); continue; }
    if (!allowed.has(url) || photo.kind !== 'photograph' || photo.visuallyApproved !== true ||
        !/^[a-f0-9]{64}$/.test(photo.sha256 ?? '') || photo.width < 1080 || photo.height < 720 ||
        photo.width/photo.height < 0.8 || photo.width/photo.height > 1.91 || !photo.alt?.ar || !photo.alt?.en) reasons.push('photo_quality_or_provenance_unverified');
  }
  if (review.captionSha256 !== sha256(JSON.stringify(propertyCaption(p,advertiser,review.legalDisclosures)))) reasons.push('caption_changed_since_review');
  return [...new Set(reasons)];
}
export function propertyCaption(p, advertiser, disclosures = {}) {
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
  const disclosureAr = p.licence?.adNumber ? `المعلن: ${advertiser.name.ar} | فال ${advertiser.fal}\nترخيص الإعلان: ${p.licence.adNumber} | ينتهي ${p.licence.adExpiry}\n${advertiser.phone}` : '';
  const disclosureEn = p.licence?.adNumber ? `Advertiser: ${advertiser.name.en} | FAL ${advertiser.fal}\nAd licence ${p.licence.adNumber} | Expires ${p.licence.adExpiry}` : '';
  return {
    ar: `${p.title.ar}\n${p.location?.city?.ar ?? ''} · ${p.category==='rent'?'للإيجار':'للبيع'}\n\n${ar.join(' · ')}\n\nتبحث عن منزل بهذه المواصفات؟ راسل بونا بالرقم ${p.id} لمعرفة التوفر وترتيب معاينة.\n${url}\n\n${disclosures.ar ?? ''}\n${disclosureAr}`.trim(),
    en: `${p.title.en} · ${p.category==='rent'?'For rent':'For sale'}\n${en.join(' · ')}\n\nInterested? Message Bona with ${p.id} for current availability and a viewing.\n\n${disclosures.en ?? ''}\n${disclosureEn}`.trim()
  };
}
export function dayState(events, channel, date) {
  const records = events.filter(x => x.channel === channel && x.date === date);
  if (records.some(x=>x.status === 'published')) return 'published';
  if (records.some(x=>['intent','uncertain'].includes(x.status))) return 'uncertain';
  return 'ready';
}
export function chooseProperty(listings, reviews, advertiser, events, channel, now = new Date(), repeatDays = 30) {
  const rejected = [];
  const last = id => Math.max(0,...events.filter(x=>x.channel===channel && x.listingId===id && x.status==='published').map(x=>Date.parse(x.at)||0));
  const candidates = listings.filter(p=>{
    const why = eligibility(p,reviews[p.id],advertiser,now);
    if (+now-last(p.id) < repeatDays*86400000) why.push('recently_published');
    if (why.length) { rejected.push({id:p.id,reasons:why}); return false; }
    return true;
  }).sort((a,b)=>last(a.id)-last(b.id)||a.id.localeCompare(b.id));
  return {listing:candidates[0] ?? null,rejected};
}
export function entryFor(p, review, advertiser, channel, date, assets = []) {
  return {id:`bona-daily-${channel==='instagram'?'ig':'fb'}-${date}`,date,time:'20:30',platform:channel,
    listingId:p.id,topic:p.title,format:'carousel',caption:propertyCaption(p,advertiser,review.legalDisclosures),hashtags:['#بونا','#عقارات'],
    reviewStatus:'approved',adLicenceRequired:false,adLicenceVerified:true,blocked:false,
    images:review.photos.map(x=>x.url),assets,assetsJpg:assets,alt:review.photos[0].alt,status:'planned'};
}
