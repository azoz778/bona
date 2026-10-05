import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNT,publicListing,sha256,fingerprint,advertiserFingerprint,eligibility,propertyCaption,chooseProperty,dayState,realDate,policyRules,STRICT_RULES,renderShare,captionFor,propertyHashtags,entryFor,unsettled,reviewedCopy } from '../social/lib/property-daily.mjs';
import { propertyDaily,legacyDayState,assertNoPendingInstagram,publisherRefusal,provenNotSent } from '../social/property-publish.mjs';
const now=new Date('2026-10-02T17:30:00Z');
function fixture() {
  const advertiser={name:{ar:'المعلن التجريبي',en:'Fixture advertiser'},fal:'1100000000',phone:'+966500000000'};
  const listing={id:'BONA-TEST',slug:'fixture',status:'available',category:'buy',location:{countryCode:'SA',city:{ar:'جدة',en:'Jeddah'}},title:{ar:'فيلا تجريبية',en:'Fixture villa'},price:{amount:1000000,currency:'SAR'},specs:{beds:3,plotSqm:400},images:[1,2,3].map(i=>({src:`/listings/fixture/${i}.jpg`})),licence:{adNumber:'7200000000',adExpiry:'2026-12-31'}};
  const review={status:'approved',factsSha256:fingerprint(listing),advertiserSha256:advertiserFingerprint(advertiser),reviewedAt:'2026-10-02T12:00:00Z',captionSha256:null,licenceEvidence:{adNumber:listing.licence.adNumber,adExpiry:listing.licence.adExpiry,sourceReference:'fixture only',marketingAuthorizationReference:'fixture only',socialMediaAllowed:true,contactMatches:true,verifiedAt:'2026-10-02T12:00:00Z'},photos:listing.images.map((x,i)=>({url:'https://bona-real-estate.com'+x.src,kind:'photograph',visuallyApproved:true,sha256:sha256('fixture '+i),width:1920,height:1280,alt:{ar:'صورة اختبار',en:'Fixture photo'}}))};
  review.legalDisclosuresVerified=true;
  review.legalDisclosures={ar:'بيانات اختبار فقط: حالة العقار والخدمات والحقوق.',en:'Test fixture only: property condition, services and rights.'};
  review.captionSha256=sha256(JSON.stringify(reviewedCopy(listing,advertiser,review)));
  return {listing,advertiser,review};
}
function offPlanFixture() {
  const { advertiser } = fixture();
  const listing = { id: 'BONA-OP', slug: 'tower', status: 'available', category: 'off-plan', type: 'apartment',
    location: { countryCode: 'SA', district: { ar: 'الشاطئ، الكورنيش', en: 'Al Shati, Corniche' }, city: { ar: 'جدة', en: 'Jeddah' } },
    title: { ar: 'برج تجريبي', en: 'Fixture Tower' }, price: { amount: 3200000, currency: 'SAR', from: true }, specs: {},
    images: [1,2,3].map(i => ({ src: `/listings/tower/${i}.jpg` })), licence: null };
  return { listing, advertiser };
}
const WAIVED = policyRules({ adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-02' }, countries: ['SA'], categories: ['buy','rent','off-plan'], renders: 'off-plan-only', reviewValidDays: 90 }, now);
function waivedReview(p, a, kind = 'photograph') {
  const { review: base } = fixture();
  const review = { ...base, factsSha256: fingerprint(p), advertiserSha256: advertiserFingerprint(a), licenceEvidence: null,
    photos: p.images.map((x, i) => ({ ...base.photos[0], url: 'https://bona-real-estate.com' + x.src, sha256: sha256('fixture ' + i), kind })) };
  review.captionSha256 = sha256(JSON.stringify(reviewedCopy(p, a, review)));
  return review;
}
test('publication eligibility needs a current licence, matching evidence, reviewed facts and photographs',()=>{
  const {listing:p,advertiser:a,review:r}=fixture();assert.deepEqual(eligibility(p,r,a,now),[]);
  assert.ok(eligibility({...p,licence:null},r,a,now).includes('missing_ad_licence'));
  assert.ok(eligibility({...p,status:'sold'},r,a,now).includes('not_available'));
  assert.ok(eligibility({...p,category:'off-plan'},r,a,now).includes('outside_policy_scope'));
  assert.ok(eligibility(p,{...r,licenceEvidence:{...r.licenceEvidence,socialMediaAllowed:false}},a,now).includes('licence_and_marketing_authority_unverified'));
  assert.ok(eligibility(p,{...r,photos:r.photos.map(x=>({...x,kind:'render'}))},a,now).includes('render_not_allowed'));
  assert.ok(eligibility(p,{...r,photos:r.photos.map(x=>({...x,width:600}))},a,now).includes('photo_quality_or_provenance_unverified'));
});
test('changed prices, captions, photos or advertiser invalidate approval',()=>{
  const {listing:p,advertiser:a,review:r}=fixture();
  assert.ok(eligibility({...p,price:{...p.price,amount:2}},r,a,now).includes('listing_changed_since_review'));
  assert.ok(eligibility(p,{...r,captionSha256:'bad'},a,now).includes('caption_changed_since_review'));
  assert.ok(eligibility(p,r,{...a,phone:'+966500000001'},now).includes('advertiser_changed_since_review'));
  assert.ok(eligibility(p,{...r,photos:r.photos.map(x=>({...x,url:'https://example.com/photo.jpg'}))},a,now).includes('unapproved_photo_source'));
});
test('licence dates are real and expiry/review age fail closed',()=>{
  assert.equal(realDate('2026-02-31'),false);assert.equal(realDate('2026-99-99'),false);assert.equal(realDate('2026-10-02'),true);
  const {listing:p,advertiser:a,review:r}=fixture();
  assert.ok(eligibility({...p,licence:{...p.licence,adExpiry:'2026-10-01'}},r,a,now).includes('missing_or_expired_ad_licence'));
  assert.ok(eligibility(p,{...r,reviewedAt:'2026-08-01'},a,now).includes('review_expired'));
});
test('rotation skips recently published property and does not recycle when exhausted',()=>{
  const {listing:p,advertiser:a,review:r}=fixture();const reviews={[p.id]:r};
  assert.equal(chooseProperty([p],reviews,a,[],'instagram',now).listing.id,p.id);
  const events=[{channel:'instagram',listingId:p.id,status:'published',at:'2026-10-01T17:30:00Z'}];
  assert.equal(chooseProperty([p],reviews,a,events,'instagram',now).listing,null);
  assert.equal(chooseProperty([p],reviews,a,events,'facebook',now).listing.id,p.id);
});
test('existing editorial publication occupies the same daily slot; uncertain attempts never retry',()=>{
  assert.equal(legacyDayState([{id:'bona-daily-fb-2026-10-02',postId:'fixture'}],'2026-10-02'),'published');
  assert.equal(legacyDayState([{date:'2026-10-02',status:'publishing'}],'2026-10-02'),'uncertain');
  assert.equal(dayState([{channel:'instagram',date:'2026-10-02',status:'intent'}],'instagram','2026-10-02'),'uncertain');
  assert.equal(dayState([{channel:'instagram',date:'2026-10-02',status:'published'},{channel:'instagram',date:'2026-10-02',status:'intent'}],'instagram','2026-10-02'),'published');
});
test('an older unsettled Instagram container cannot enter the legacy automatic reconciliation path',()=>{
  const pending={id:'old-editorial',date:'2026-09-30',status:'publishing',containerId:'test-container',ts:'2026-09-30T17:30:00Z'};
  assert.throws(()=>assertNoPendingInstagram([pending]),/no backfill/);
  assert.doesNotThrow(()=>assertNoPendingInstagram([pending,{...pending,status:'published'}]));
});
test('public catalogue deliberately excludes internal notes and client/source references',()=>{
  const {listing:p}=fixture();const out=publicListing({...p,notes:'private',sourceRef:'private',client:'private'});
  assert.equal(out.notes,undefined);assert.equal(out.sourceRef,undefined);assert.equal(out.client,undefined);
});
test('an unlicensed live catalogue results in no provider calls or fallback publication',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bona-property-test-'));
  try {
    fs.mkdirSync(path.join(root,'marketing/daily'),{recursive:true});
    fs.writeFileSync(path.join(root,'marketing/daily/property-policy.json'),JSON.stringify({version:1,mode:'property-photography',time:'20:30',timezone:'Asia/Riyadh',repeatDays:30,catalogueUrl:'https://bona-real-estate.com/social-catalogue.json',channels:['instagram','facebook']}));
    fs.writeFileSync(path.join(root,'marketing/daily/property-reviews.json'),'{}');
    const {listing:p,advertiser:a}=fixture();let calls=0;
    const fetchImpl=async(url,opts)=>{calls++;assert.equal(url,'https://bona-real-estate.com/social-catalogue.json');assert.equal(opts?.method,undefined);return new Response(JSON.stringify({version:1,generatedAt:now.toISOString(),advertiser:a,listings:[{...p,licence:null}]}),{headers:{'content-type':'application/json'}})};
    const env={BONA_DATA:path.join(root,'data')};
    const result=await propertyDaily('instagram',{dry:true,now,root,env,fetchImpl});
    assert.equal(result.status,'skipped-no-eligible-property');assert.equal(calls,1);assert.equal(fs.existsSync(env.BONA_DATA),false);
    const early=await propertyDaily('instagram',{dry:true,now:new Date('2026-10-02T17:29:59Z'),root,env,fetchImpl});
    assert.equal(early.status,'not-due');assert.equal(calls,1);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('approved dry preflight reads account and exact photo bytes, then rechecks availability without writes',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bona-property-preflight-'));
  try {
    fs.mkdirSync(path.join(root,'marketing/daily'),{recursive:true});
    fs.writeFileSync(path.join(root,'marketing/daily/property-policy.json'),JSON.stringify({version:1,mode:'property-photography',time:'20:30',timezone:'Asia/Riyadh',repeatDays:30,catalogueUrl:'https://bona-real-estate.com/social-catalogue.json',channels:['instagram','facebook']}));
    const {listing:p,advertiser:a,review:r}=fixture();
    fs.writeFileSync(path.join(root,'marketing/daily/property-reviews.json'),JSON.stringify({[p.id]:r}));
    const env={BONA_DATA:path.join(root,'data'),META_ACCESS_TOKEN:'not-a-real-token',IG_BUSINESS_ID:'17841427688957180'};
    let catalogueReads=0,withdraw=false,photoChanged=false;
    const fetchImpl=async(url,opts)=>{
      assert.ok(!opts?.method||opts.method==='GET','preflight must never mutate');
      const u=new URL(url);
      if(u.pathname==='/social-catalogue.json'){
        catalogueReads++;const row=withdraw&&catalogueReads>1?{...p,status:'sold'}:p;
        return Response.json({version:1,generatedAt:now.toISOString(),advertiser:a,listings:[row]});
      }
      if(u.hostname==='graph.facebook.com')return Response.json(u.pathname.endsWith('content_publishing_limit')?{data:[{quota_usage:0,config:{quota_total:100}}]}:{id:env.IG_BUSINESS_ID,username:'bonarealestatesa'});
      const i=r.photos.findIndex(x=>x.url===url);assert.ok(i>=0);
      return new Response(photoChanged?'changed':'fixture '+i,{headers:{'content-type':'image/jpeg'}});
    };
    const ready=await propertyDaily('instagram',{dry:true,now,root,env,fetchImpl});
    assert.equal(ready.status,'ready');assert.equal(catalogueReads,2);assert.equal(fs.existsSync(env.BONA_DATA),false);
    catalogueReads=0;withdraw=true;
    await assert.rejects(propertyDaily('instagram',{dry:true,now,root,env,fetchImpl}),/changed during preflight/);
    catalogueReads=0;withdraw=false;photoChanged=true;
    await assert.rejects(propertyDaily('instagram',{dry:true,now,root,env,fetchImpl}),/changed since visual review/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('policy rules: no new fields means the strict 2 October behaviour', () => {
  assert.deepEqual({ ...policyRules({}, now) }, { ...STRICT_RULES });
  assert.equal(policyRules({}, now).licenceRequired, true);
});
test('policy rules: an owner waiver with a past or current date lifts the licence requirement', () => {
  const r = policyRules({ adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-02' }, countries: ['SA'], categories: ['buy','rent','off-plan'], renders: 'off-plan-only', reviewValidDays: 90 }, now);
  assert.equal(r.licenceRequired, false);
  assert.deepEqual([...r.categories], ['buy','rent','off-plan']);
  assert.equal(r.renders, 'off-plan-only');
  assert.equal(r.reviewValidDays, 90);
});
test('policy rules: a malformed waiver or scope stops the run', () => {
  const bad = [
    { adLicence: { requirement: 'waived', on: '2026-10-02' } },
    { adLicence: { requirement: 'waived', by: ' ', on: '2026-10-02' } },
    { adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-03' } },
    { adLicence: { requirement: 'waived', by: 'owner', on: '2026-02-31' } },
    { adLicence: { requirement: 'sometimes' } },
    { countries: ['sa'] }, { countries: [] },
    { categories: ['buy','auction'] }, { categories: [] },
    { renders: 'all' },
    { reviewValidDays: 0 }, { reviewValidDays: 181 }, { reviewValidDays: 1.5 },
  ];
  for (const policy of bad) assert.throws(() => policyRules(policy, now), /property policy|waiver/, JSON.stringify(policy));
});
test('caption: advertiser line always, licence line only with a number, renders disclosed', () => {
  const { listing: p, advertiser: a } = fixture();
  const d = { ar: 'إفصاح.', en: 'Disclosure.' };
  const licensed = propertyCaption(p, a, d);
  assert.match(licensed.ar, /المعلن: المعلن التجريبي · فال 1100000000 · \+966500000000/);
  assert.match(licensed.en, /Advertiser: Fixture advertiser · FAL 1100000000 · \+966500000000/);
  assert.match(licensed.ar, /ترخيص الإعلان: 7200000000 · ينتهي 2026-12-31/);
  assert.match(licensed.en, /Ad licence 7200000000 · Expires 2026-12-31/);
  const bare = propertyCaption({ ...p, licence: null }, a, d);
  assert.doesNotMatch(bare.ar, /ترخيص الإعلان/);
  assert.doesNotMatch(bare.en, /Ad licence/);
  assert.match(bare.ar, /المعلن: /);
  assert.match(bare.en, /Advertiser: /);
  assert.doesNotMatch(bare.en, /artist's impressions/);
  assert.match(propertyCaption(p, a, d, { renders: 'all' }).en, /^Images are the developer's artist's impressions\.$/m);
  assert.match(propertyCaption(p, a, d, { renders: 'all' }).ar, /^الصور تصاميم تصوّرية من المطوّر\.$/m);
  assert.match(propertyCaption(p, a, d, { renders: 'some' }).en, /^Some images are the developer's artist's impressions\.$/m);
  assert.match(propertyCaption(p, a, d, { renders: 'some' }).ar, /^بعض الصور تصاميم تصوّرية من المطوّر\.$/m);
});
test('caption: place and deal line, off-plan wording and the from-price exactly as the site shows it', () => {
  const { listing: p, advertiser: a } = offPlanFixture();
  const c = propertyCaption(p, a, {});
  assert.equal(c.ar.split('\n')[0], 'برج تجريبي');
  assert.equal(c.ar.split('\n')[1], 'الشاطئ، الكورنيش، جدة · على الخارطة');
  assert.equal(c.en.split('\n')[0], 'Fixture Tower');
  assert.equal(c.en.split('\n')[1], 'Al Shati, Corniche, Jeddah · Off-plan');
  assert.match(c.ar, /تبدأ الأسعار من 3,200,000 ريال/);
  assert.match(c.en, /From SAR 3,200,000/);
  assert.match(c.ar, /راسل بونا بالرقم BONA-OP/);
  assert.match(c.ar, /https:\/\/bona-real-estate\.com\/properties\/tower\//);
  const ready = propertyCaption(fixture().listing, a, {});
  assert.match(ready.ar.split('\n')[1], /· للبيع$/);
  assert.match(ready.en.split('\n')[1], /· For sale$/);
});
test('caption: bedroom counts read correctly in Arabic and English', () => {
  const { listing, advertiser: a } = fixture();
  const beds = n => { const c = propertyCaption({ ...listing, specs: { beds: n } }, a, {}); return [c.ar.split('\n\n')[1].split(' · ')[0], c.en.split('\n\n')[1].split(' · ')[0]]; };
  assert.deepEqual(beds(1), ['غرفة نوم واحدة', '1 bedroom']);
  assert.deepEqual(beds(2), ['غرفتا نوم', '2 bedrooms']);
  assert.deepEqual(beds(3), ['3 غرف نوم', '3 bedrooms']);
  assert.deepEqual(beds(10), ['10 غرف نوم', '10 bedrooms']);
  assert.deepEqual(beds(11), ['11 غرفة نوم', '11 bedrooms']);
  assert.deepEqual(beds(24), ['24 غرفة نوم', '24 bedrooms']);
});
test('caption: off-plan asks about the project without promising a viewing; both languages give the page after the call to action', () => {
  const { listing: op, advertiser: a } = offPlanFixture();
  const after = (text, line) => { const xs = text.split('\n'), i = xs.indexOf(line); assert.ok(i >= 0, `has the line ${line}`); return xs[i + 1]; };
  const c = propertyCaption(op, a, {});
  assert.equal(after(c.ar, 'تبحث عن وحدة في هذا المشروع؟ راسل بونا بالرقم BONA-OP لمعرفة التوفر والتفاصيل.'), 'https://bona-real-estate.com/properties/tower/');
  assert.equal(after(c.en, 'Interested? Message Bona with BONA-OP for availability and details.'), 'https://bona-real-estate.com/properties/tower/');
  assert.doesNotMatch(c.ar, /معاينة/);
  assert.doesNotMatch(c.en, /viewing/i);
  const { listing: ready } = fixture();
  const r = propertyCaption(ready, a, {});
  assert.equal(after(r.ar, 'تبحث عن منزل بهذه المواصفات؟ راسل بونا بالرقم BONA-TEST لمعرفة التوفر وترتيب معاينة.'), 'https://bona-real-estate.com/properties/fixture/');
  assert.equal(after(r.en, 'Interested? Message Bona with BONA-TEST for current availability and a viewing.'), 'https://bona-real-estate.com/properties/fixture/');
});
test('renderShare and captionFor follow the reviewed photo kinds', () => {
  const { listing: p, advertiser: a, review: r } = fixture();
  assert.equal(renderShare(r), 'none');
  assert.equal(renderShare({ photos: r.photos.map(x => ({ ...x, kind: 'render' })) }), 'all');
  assert.equal(renderShare({ photos: r.photos.map((x, i) => ({ ...x, kind: i ? 'render' : 'photograph' })) }), 'some');
  assert.equal(renderShare(undefined), 'none');
  assert.deepEqual(captionFor(p, a, r), propertyCaption(p, a, r.legalDisclosures, { renders: 'none' }));
});
test('hashtags: brand, city, type, off-plan, district and luxury, at most twelve, valid characters only', () => {
  const { listing: p } = offPlanFixture();
  assert.deepEqual(propertyHashtags(p), ['#بونا','#BonaRealEstate','#عقارات_جدة','#JeddahRealEstate','#شقق_جدة','#شقق_للبيع','#JeddahApartments','#مشاريع_على_الخارطة','#OffPlan','#الشاطئ','#AlShati','#عقارات_فاخرة']);
  const villa = { ...p, category: 'buy', type: 'villa', location: { ...p.location, district: { ar: 'درة العروس', en: 'Durrat Al Arous' } } };
  assert.deepEqual(propertyHashtags(villa), ['#بونا','#BonaRealEstate','#عقارات_جدة','#JeddahRealEstate','#فلل_جدة','#فلل_للبيع','#JeddahVillas','#درة_العروس','#DurratAlArous','#عقارات_فاخرة']);
  const riyadh = { ...villa, location: { countryCode: 'SA', city: { ar: 'الرياض', en: 'Riyadh' }, district: { ar: 'شمال الرياض الجديد الكبير', en: 'North Riyadh New Big Area' } } };
  const tags = propertyHashtags(riyadh);
  assert.ok(tags.includes('#عقارات_الرياض') && tags.includes('#RiyadhVillas'));
  assert.ok(!tags.some(t => /جدة|Jeddah/.test(t)));
  assert.ok(!tags.includes('#شمال_الرياض_الجديد_الكبير'), 'districts longer than three words are left out');
  for (const t of [...propertyHashtags(p), ...tags]) assert.match(t, /^#[\p{L}\p{N}_]+$/u);
  assert.ok(propertyHashtags(p).length <= 12);
});
test('entryFor carries the reviewed caption and the generated hashtags', () => {
  const { listing: p, advertiser: a, review: r } = fixture();
  const e = entryFor(p, r, a, 'instagram', '2026-10-05', []);
  assert.equal(e.id, 'bona-daily-ig-2026-10-05');
  assert.deepEqual(e.caption, captionFor(p, a, r));
  assert.deepEqual(e.hashtags, propertyHashtags(p));
  assert.deepEqual(e.images, r.photos.map(x => x.url));
});
test('waived policy: an unlicensed Saudi listing with a current review is eligible; the strict policy still refuses it', () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null };
  const r = waivedReview(p, a);
  assert.deepEqual(eligibility(p, r, a, now, WAIVED), []);
  const strict = eligibility(p, r, a, now);
  for (const why of ['missing_ad_licence','missing_or_expired_ad_licence','licence_and_marketing_authority_unverified']) assert.ok(strict.includes(why), why);
});
test('waived policy: off-plan may use renders; ready stock may not; foreign stock is out of scope', () => {
  const { listing: p, advertiser: a } = offPlanFixture();
  assert.deepEqual(eligibility(p, waivedReview(p, a, 'render'), a, now, WAIVED), []);
  const { listing: ready } = fixture(); const bare = { ...ready, licence: null };
  assert.ok(eligibility(bare, waivedReview(bare, a, 'render'), a, now, WAIVED).includes('render_not_allowed'));
  const oman = { ...p, location: { ...p.location, countryCode: 'OM' } };
  assert.ok(eligibility(oman, waivedReview(oman, a, 'render'), a, now, WAIVED).includes('outside_policy_scope'));
  assert.ok(eligibility(p, waivedReview(p, a, 'sketch'), a, now, WAIVED).includes('photo_quality_or_provenance_unverified'));
});
test('waived policy: reviews last reviewValidDays and changed facts or captions still invalidate them', () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null };
  const r = { ...waivedReview(p, a), reviewedAt: '2026-08-10T12:00:00Z' };
  assert.deepEqual(eligibility(p, r, a, now, WAIVED), []);
  assert.ok(eligibility(p, r, a, now).includes('review_expired'));
  assert.ok(eligibility(p, { ...r, reviewedAt: '2026-06-30T12:00:00Z' }, a, now, WAIVED).includes('review_expired'));
  assert.ok(eligibility({ ...p, price: { ...p.price, amount: 2 } }, r, a, now, WAIVED).includes('listing_changed_since_review'));
  assert.ok(eligibility(p, { ...r, captionSha256: 'bad' }, a, now, WAIVED).includes('caption_changed_since_review'));
});
test('a review binds the generated hashtags as well as the caption', () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null };
  const r = waivedReview(p, a);
  assert.deepEqual(reviewedCopy(p, a, r), { ...captionFor(p, a, r), hashtags: propertyHashtags(p) });
  assert.deepEqual(eligibility(p, r, a, now, WAIVED), []);
  const captionOnly = { ...r, captionSha256: sha256(JSON.stringify(captionFor(p, a, r))) };
  assert.ok(eligibility(p, captionOnly, a, now, WAIVED).includes('caption_changed_since_review'), 'hashtags that differ from the reviewed ones invalidate the review');
});
test('a listing is eligible only when its reviewed copy fits Instagram: 2,200 characters and 30 hashtags', () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null };
  assert.deepEqual(eligibility(p, waivedReview(p, a), a, now, WAIVED), []);
  const { listing: op } = offPlanFixture();
  assert.deepEqual(eligibility(op, waivedReview(op, a, 'render'), a, now, WAIVED), []);
  const long = { ...p, title: { ...p.title, en: 'x'.repeat(2500) } };
  assert.deepEqual(eligibility(long, waivedReview(long, a), a, now, WAIVED), ['caption_exceeds_platform_limits']);
  assert.equal(propertyHashtags(p).length, 5);
  const tagged = n => ({ ...p, title: { ...p.title, en: Array.from({ length: n }, (_, i) => `#tag${i}`).join(' ') } });
  assert.deepEqual(eligibility(tagged(25), waivedReview(tagged(25), a), a, now, WAIVED), [], '25 in the title + 5 generated = 30');
  assert.deepEqual(eligibility(tagged(26), waivedReview(tagged(26), a), a, now, WAIVED), ['caption_exceeds_platform_limits'], '31 hashtags');
});
test('reviewed photo sizes must be finite positive numbers, and the carousel must keep one aspect ratio', () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null };
  const r = waivedReview(p, a);
  const withPhoto = (i, dims) => ({ ...r, photos: r.photos.map((x, j) => j === i ? { ...x, ...dims } : x) });
  for (const dims of [{ width: undefined }, { height: undefined }, { width: '1920' }, { height: '1280' }, { width: NaN }, { width: Infinity, height: Infinity }, { height: null }, { width: 0, height: 0 }])
    assert.ok(eligibility(p, withPhoto(1, dims), a, now, WAIVED).includes('photo_quality_or_provenance_unverified'), JSON.stringify(dims));
  assert.deepEqual(eligibility(p, withPhoto(1, { width: 1080, height: 1350 }), a, now, WAIVED), ['carousel_aspect_mismatch'], 'portrait frame in a landscape carousel');
  assert.deepEqual(eligibility(p, withPhoto(1, { width: 1800, height: 1200 }), a, now, WAIVED), []);
  assert.deepEqual(eligibility(p, withPhoto(2, { width: 1920, height: 1200 }), a, now, WAIVED), [], '16:10 is within 15% of 3:2');
  assert.deepEqual(eligibility(p, withPhoto(2, { width: 1920, height: 1080 }), a, now, WAIVED), ['carousel_aspect_mismatch'], '16:9 is not');
});
test('rotation applies the policy rules it is given', () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null };
  const reviews = { [p.id]: waivedReview(p, a) };
  assert.equal(chooseProperty([p], reviews, a, [], 'instagram', now).listing, null);
  assert.equal(chooseProperty([p], reviews, a, [], 'instagram', now, 30, WAIVED).listing.id, p.id);
});
test('a later confirmed-not-published record settles an attempt; an earlier one does not', () => {
  const intent = { channel: 'instagram', date: '2026-10-05', id: 'bona-daily-ig-2026-10-05', status: 'intent' };
  const uncertain = { ...intent, status: 'uncertain' };
  const cleared = { ...intent, status: 'confirmed-not-published', evidence: 'fixture' };
  assert.equal(dayState([intent, uncertain, cleared], 'instagram', '2026-10-05'), 'ready');
  assert.equal(dayState([cleared, intent], 'instagram', '2026-10-05'), 'uncertain');
  assert.equal(unsettled([intent, uncertain], 'instagram'), true);
  assert.equal(unsettled([intent, uncertain, cleared], 'instagram'), false);
  assert.equal(unsettled([cleared, intent], 'instagram'), true);
  assert.equal(unsettled([intent, { ...intent, status: 'published' }], 'instagram'), false);
  assert.equal(unsettled([intent], 'facebook'), false);
});
function writePolicy(root, extra = {}) {
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify({ version: 1, mode: 'property-photography', time: '20:30', timezone: 'Asia/Riyadh', repeatDays: 30, catalogueUrl: 'https://bona-real-estate.com/social-catalogue.json', channels: ['instagram', 'facebook'], ...extra }));
}
const WAIVER_POLICY = { adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-02' }, countries: ['SA'], categories: ['buy', 'rent', 'off-plan'], renders: 'off-plan-only', reviewValidDays: 90 };
test('waived policy: an unlicensed off-plan listing with reviewed renders passes the dry preflight without writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-property-waiver-'));
  try {
    writePolicy(root, WAIVER_POLICY);
    const { listing: p, advertiser: a } = offPlanFixture(); const r = waivedReview(p, a, 'render');
    fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), JSON.stringify({ [p.id]: r }));
    const env = { BONA_DATA: path.join(root, 'data'), META_ACCESS_TOKEN: 'not-a-real-token', IG_BUSINESS_ID: '17841427688957180' };
    const fetchImpl = async (url, opts) => {
      assert.ok(!opts?.method || opts.method === 'GET', 'preflight must never mutate');
      const u = new URL(url);
      if (u.pathname === '/social-catalogue.json') return Response.json({ version: 1, generatedAt: now.toISOString(), advertiser: a, listings: [p] });
      if (u.hostname === 'graph.facebook.com') return Response.json(u.pathname.endsWith('content_publishing_limit') ? { data: [{ quota_usage: 0, config: { quota_total: 100 } }] } : { id: env.IG_BUSINESS_ID, username: 'bonarealestatesa' });
      const i = r.photos.findIndex(x => x.url === url); assert.ok(i >= 0);
      return new Response('fixture ' + i, { headers: { 'content-type': 'image/jpeg' } });
    };
    const ready = await propertyDaily('instagram', { dry: true, now, root, env, fetchImpl });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.entry.listingId, p.id);
    assert.match(ready.entry.caption.en, /artist's impressions/);
    assert.ok(ready.entry.hashtags.includes('#OffPlan'));
    assert.equal(fs.existsSync(env.BONA_DATA), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('a waiver without a name or date stops the run before any network call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-property-badwaiver-'));
  try {
    writePolicy(root, { adLicence: { requirement: 'waived' } });
    fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), '{}');
    let calls = 0; const fetchImpl = async () => { calls++; throw new Error('no network expected'); };
    await assert.rejects(propertyDaily('instagram', { dry: true, now, root, env: { BONA_DATA: path.join(root, 'data') }, fetchImpl }), /waiver/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('the repository policy is the owner waiver for Saudi ready and off-plan stock', () => {
  const policy = JSON.parse(fs.readFileSync(new URL('../../marketing/daily/property-policy.json', import.meta.url), 'utf8'));
  const r = policyRules(policy, new Date('2026-10-05T17:30:00Z'));
  assert.equal(r.licenceRequired, false);
  assert.deepEqual([...r.countries], ['SA']);
  assert.deepEqual([...r.categories], ['buy', 'rent', 'off-plan']);
  assert.equal(r.renders, 'off-plan-only');
  assert.equal(r.reviewValidDays, 90);
  assert.equal(policy.adLicence.by, 'owner');
  assert.equal(policy.adLicence.on, '2026-10-05');
});
const LIVE_ENV = { META_ACCESS_TOKEN: 'not-a-real-token', IG_BUSINESS_ID: ACCOUNT.instagram, FB_PAGE_ID: ACCOUNT.facebook };
/** Read-only stand-in for the live site and Graph API: catalogue, both identities, the reviewed photo bytes. */
function liveStub(p, a, r, clock = () => now) {
  return async (url, opts) => {
    assert.ok(!opts?.method || opts.method === 'GET', 'preflight must never mutate');
    const u = new URL(url);
    if (u.pathname === '/social-catalogue.json') return Response.json({ version: 1, generatedAt: clock().toISOString(), advertiser: a, listings: [p] });
    if (u.hostname === 'graph.facebook.com') {
      if (u.pathname.endsWith('/content_publishing_limit')) return Response.json({ data: [{ quota_usage: 0, config: { quota_total: 100 } }] });
      if (u.pathname.endsWith('/me')) return Response.json({ id: 'fixture-user', name: 'Fixture user' });
      if (u.pathname.endsWith(`/${ACCOUNT.facebook}`)) return Response.json({ id: ACCOUNT.facebook, name: 'Bona Real Estate', access_token: 'not-a-real-page-token', is_published: true });
      return Response.json({ id: ACCOUNT.instagram, username: 'bonarealestatesa' });
    }
    const i = r.photos.findIndex(x => x.url === url); assert.ok(i >= 0, url);
    return new Response('fixture ' + i, { headers: { 'content-type': 'image/jpeg' } });
  };
}
test('waived policy: a licence that is present must be valid and current; the caption never prints a broken one', () => {
  const { listing, advertiser: a } = fixture();
  const valid = { ...listing, licence: { adNumber: '7200012345', adExpiry: '2026-12-31' } };
  assert.deepEqual(eligibility(valid, waivedReview(valid, a), a, now, WAIVED), []);
  assert.match(captionFor(valid, a, waivedReview(valid, a)).en, /^Ad licence 7200012345 · Expires 2026-12-31$/m);
  assert.match(captionFor(valid, a, waivedReview(valid, a)).ar, /^ترخيص الإعلان: 7200012345 · ينتهي 2026-12-31$/m);
  const today = { ...listing, licence: { adNumber: '7200012345', adExpiry: '2026-10-02' } };
  assert.deepEqual(eligibility(today, waivedReview(today, a), a, now, WAIVED), [], 'a licence expiring today is still current');
  const wafiOnly = { ...listing, licence: { adNumber: null, adExpiry: null, wafiNumber: 'W-1234' } };
  assert.deepEqual(eligibility(wafiOnly, waivedReview(wafiOnly, a), a, now, WAIVED), []);
  assert.doesNotMatch(captionFor(wafiOnly, a, waivedReview(wafiOnly, a)).en, /Ad licence/);
  const broken = [{ adNumber: '7200012345', adExpiry: null }, { adNumber: '7200012345' }, { adNumber: '7200012345', adExpiry: '2026-02-31' },
    { adNumber: 'pending' }, { adNumber: '{{AD_LICENCE}}', adExpiry: '2026-12-31' }, { adNumber: '72000', adExpiry: '2026-12-31' }];
  for (const licence of broken) {
    const p = { ...listing, licence }, r = waivedReview(p, a), c = captionFor(p, a, r);
    assert.ok(eligibility(p, r, a, now, WAIVED).includes('ad_licence_invalid_or_expired'), JSON.stringify(licence));
    assert.doesNotMatch(c.en, /Ad licence|Expires|\bnull\b|\bundefined\b|\{\{/, JSON.stringify(licence));
    assert.doesNotMatch(c.ar, /ترخيص الإعلان|ينتهي|\{\{/, JSON.stringify(licence));
  }
  const expired = { ...listing, licence: { adNumber: '7200012345', adExpiry: '2026-10-01' } };
  assert.ok(eligibility(expired, waivedReview(expired, a), a, now, WAIVED).includes('ad_licence_invalid_or_expired'));
  const strict = eligibility({ ...listing, licence: broken[0] }, fixture().review, a, now);
  assert.ok(strict.includes('missing_or_expired_ad_licence') && !strict.includes('ad_licence_invalid_or_expired'), 'the strict gate keeps its own reasons');
});
test("publisherRefusal applies each channel publisher's own pre-network gate", () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null }; const r = waivedReview(p, a);
  const files = ['1.jpg', '2.jpg', '3.jpg'];
  const ig = entryFor(p, r, a, 'instagram', '2026-10-02', files), fb = entryFor(p, r, a, 'facebook', '2026-10-02', files);
  const say = (e, text) => ({ ...e, caption: { ...e.caption, en: `${e.caption.en}\n${text}` } });
  assert.equal(publisherRefusal(ig, 'instagram', { now }), null);
  assert.equal(publisherRefusal(fb, 'facebook', { now }), null);
  for (const [e, channel] of [[ig, 'instagram'], [fb, 'facebook']])
    for (const placeholder of ['{{AD_LICENCE}}', '[add number before publishing]', '[يُضاف قبل النشر]'])
      assert.match(publisherRefusal(say(e, placeholder), channel, { now }) ?? '', /placeholder/, `${channel} ${placeholder}`);
  assert.match(publisherRefusal(say(fb, 'Free valuation on request'), 'facebook', { now }) ?? '', /forbidden phrase/);
  assert.match(publisherRefusal(ig, 'instagram', { now, igLedger: [{ id: ig.id, date: ig.date, status: 'skipped:manual' }] }) ?? '', /already settled/);
});
test('a post its own publisher would refuse stops in the preflight, before any intent record', async () => {
  const cases = [['instagram', 'Fixture villa [add number before publishing]', 'placeholder'], ['facebook', 'Fixture villa [add number before publishing]', 'placeholder'],
    ['facebook', 'Fixture villa, free valuation included', 'forbidden phrase']];
  for (const [channel, title, why] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-property-refusal-'));
    try {
      writePolicy(root, WAIVER_POLICY);
      const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null, title: { ...listing.title, en: title } }; const r = waivedReview(p, a);
      assert.deepEqual(eligibility(p, r, a, now, WAIVED), [], 'eligible, so the rotation offers it');
      fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), JSON.stringify({ [p.id]: r }));
      const env = { ...LIVE_ENV, BONA_DATA: path.join(root, 'data') }, fetchImpl = liveStub(p, a, r);
      const refused = new RegExp(`${channel} publisher would refuse.*${why}`);
      await assert.rejects(propertyDaily(channel, { dry: true, now, root, env, fetchImpl }), refused, `${channel} dry run`);
      await assert.rejects(propertyDaily(channel, { now, root, env, fetchImpl }), refused, `${channel} live run`);
      assert.equal(fs.existsSync(path.join(env.BONA_DATA, 'daily/property.jsonl')), false, `${channel}: no intent, so nothing to reconcile`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
test('reconciling an Instagram attempt: the journal line settles the journal; the Instagram ledger needs its own line, and that date stays closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-property-reconcile-'));
  try {
    writePolicy(root, WAIVER_POLICY);
    const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null }; const r = waivedReview(p, a);
    fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), JSON.stringify({ [p.id]: r }));
    const data = path.join(root, 'data'), env = { ...LIVE_ENV, BONA_DATA: data };
    let clock = now; const fetchImpl = liveStub(p, a, r, () => clock);
    const run = at => { clock = at; return propertyDaily('instagram', { dry: true, now: at, root, env, fetchImpl }); };
    const lines = (file, xs) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, xs.map(x => JSON.stringify(x) + '\n').join('')); };
    const D = '2026-10-02', id = `bona-daily-ig-${D}`, nextDay = new Date('2026-10-03T17:30:00Z');
    const intent = { channel: 'instagram', date: D, id, listingId: p.id, status: 'intent', at: '2026-10-02T17:30:05Z' };
    lines(path.join(data, 'daily/property.jsonl'), [intent, { ...intent, status: 'uncertain', at: '2026-10-02T17:31:30Z' },
      { ...intent, status: 'confirmed-not-published', evidence: 'fixture', at: '2026-10-02T18:10:00Z' }]);
    // No container was created: the journal line alone settles the attempt, the same evening included.
    assert.equal((await run(now)).status, 'ready');
    assert.equal((await run(nextDay)).status, 'ready');
    // A container was in flight: the journal line is not enough, and the error says where to settle it.
    const publishing = { id, date: D, slot: '20:30', kind: 'carousel', status: 'publishing', containerId: 'fixture-container', ts: '2026-10-02T17:30:40Z' };
    lines(path.join(data, 'ig/published.jsonl'), [publishing]);
    await assert.rejects(run(nextDay), e => /Earlier Instagram container is unsettled/.test(e.message) && e.message.includes(id) && e.message.includes('ig/published.jsonl'));
    // An error line after it settles the ledger, so the next day's slot is ready ...
    lines(path.join(data, 'ig/published.jsonl'), [publishing, { id, date: D, status: 'error', detail: 'fixture: absent from the account media', ts: '2026-10-02T18:10:00Z' }]);
    assert.equal((await run(nextDay)).status, 'ready');
    // ... and the attempted date stays closed: no same-day retry once a container existed.
    await assert.rejects(run(now), /Uncertain daily publication/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
// ---- the send path: a temp BONA_DATA, a fake fetch, and stand-ins for systemctl and the clock ----
/** A temp repo root with the waiver policy and one reviewed unlicensed listing; data goes to a temp BONA_DATA. */
function sendFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  writePolicy(root, WAIVER_POLICY);
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null }; const r = waivedReview(p, a);
  fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), JSON.stringify({ [p.id]: r }));
  const data = path.join(root, 'data');
  return { root, p, a, r, data, env: { ...LIVE_ENV, BONA_DATA: data }, journal: path.join(data, 'daily/property.jsonl'), igLedger: path.join(data, 'ig/published.jsonl') };
}
const jsonl = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
/**
 * liveStub for the preflight reads; `provider(url, init)` answers first (a Response, a throw, or
 * undefined to pass). Every request is logged as "METHOD host/path"; an unanswered write throws,
 * which the publishers swallow as a network error, so tests assert on `calls` instead.
 */
function sendStub(f, provider = () => undefined) {
  const read = liveStub(f.p, f.a, f.r), calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET';
    calls.push(`${method} ${u.hostname}${u.pathname}`);
    const answer = await provider(u, init);
    if (answer !== undefined) return answer;
    if (method !== 'GET') throw new Error(`unexpected ${method} ${u.pathname}`);
    return read(url, init);
  };
  return { fetchImpl, calls, writes: () => calls.filter(c => !c.startsWith('GET ')) };
}
const send = (channel, f, fetchImpl, over = {}) => propertyDaily(channel, { now, root: f.root, env: f.env, fetchImpl, legacyTimersDisabled: () => true, ...over });
test('a live run refuses while a legacy publisher timer is on, before any intent record', async () => {
  const f = sendFixture('bona-property-legacy-');
  try {
    const s = sendStub(f);
    await assert.rejects(send('instagram', f, s.fetchImpl, { legacyTimersDisabled: () => false }), /Legacy publisher must remain disabled/);
    assert.deepEqual(jsonl(f.journal), []);
    assert.deepEqual(s.writes(), []);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
const IG_ID = 'bona-daily-ig-2026-10-02';
const without = (row, ...keys) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
test('Instagram: a send stopped before any publishing line is confirmed not published and the channel stays open', async () => {
  const f = sendFixture('bona-property-ig-unsent-');
  try {
    const s = sendStub(f, (u, init) => { if (init.method === 'HEAD') throw new TypeError('fetch failed'); });
    await assert.rejects(send('instagram', f, s.fetchImpl), e => e.message.startsWith(`Instagram post not sent (last ledger status for ${IG_ID}: error)`));
    const rows = jsonl(f.journal);
    assert.deepEqual(rows.map(x => x.status), ['intent', 'confirmed-not-published']);
    assert.deepEqual(without(rows[1], 'at'), { channel: 'instagram', date: '2026-10-02', id: IG_ID, listingId: f.p.id, status: 'confirmed-not-published',
      evidence: `no publishing line for ${IG_ID} in ig/published.jsonl; media_publish was never sent` });
    assert.equal(unsettled(rows, 'instagram'), false);
    assert.equal(dayState(rows, 'instagram', '2026-10-02'), 'ready');
    assert.deepEqual(jsonl(f.igLedger).map(x => `${x.id} ${x.status}`), [`${IG_ID} error`]);
    assert.deepEqual(s.writes(), ['HEAD bona-real-estate.com/listings/fixture/1.jpg', 'HEAD bona-real-estate.com/listings/fixture/1.jpg'], 'the first image asked twice; nothing sent to Instagram');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('Instagram: a run that never got the publisher lock sent nothing either', async () => {
  const f = sendFixture('bona-property-ig-locked-');
  try {
    fs.mkdirSync(path.dirname(f.igLedger), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(f.igLedger), '.publish.lock'), JSON.stringify({ pid: process.pid, ts: now.toISOString() }));
    const s = sendStub(f);
    await assert.rejects(send('instagram', f, s.fetchImpl), e => e.message.startsWith('Instagram post not sent;'));
    assert.deepEqual(jsonl(f.journal).map(x => x.status), ['intent', 'confirmed-not-published']);
    assert.deepEqual(s.writes(), []);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('Instagram: once a publishing line exists the outcome is unknown, so the attempt stays uncertain and blocks the channel', async () => {
  const f = sendFixture('bona-property-ig-unknown-');
  try {
    let n = 0;
    const s = sendStub(f, (u, init) => {
      if (init.method === 'HEAD') return new Response(null, { headers: { 'content-type': 'image/jpeg' } });
      if (u.hostname !== 'graph.facebook.com') return undefined;
      if (u.pathname.endsWith('/media_publish')) throw new TypeError('fetch failed');
      if (u.pathname.endsWith('/media')) return Response.json({ id: `container-${++n}` });
      if (/\/container-\d+$/.test(u.pathname)) return Response.json({ status_code: 'FINISHED' });
      return undefined;
    });
    await assert.rejects(send('instagram', f, s.fetchImpl), e => e.message === 'Property publication unconfirmed; automatic retry stopped');
    const rows = jsonl(f.journal);
    assert.deepEqual(rows.map(x => x.status), ['intent', 'uncertain']);
    assert.equal(unsettled(rows, 'instagram'), true);
    assert.equal(dayState(rows, 'instagram', '2026-10-02'), 'uncertain');
    assert.deepEqual(jsonl(f.igLedger).map(x => `${x.id} ${x.status}`), [`${IG_ID} publishing`]);
    assert.equal(s.writes().filter(c => c.endsWith('/media_publish')).length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('provenNotSent: only an Instagram ledger with no publishing or published line for the id proves nothing went out', () => {
  const ledger = (...xs) => () => xs;
  assert.equal(provenNotSent('instagram', IG_ID, null, ledger()).message, 'Instagram post not sent');
  assert.equal(provenNotSent('instagram', IG_ID, null, ledger({ id: IG_ID, status: 'error' }, { id: IG_ID, status: 'skipped:no-jpeg' })).message, `Instagram post not sent (last ledger status for ${IG_ID}: skipped:no-jpeg)`);
  assert.ok(provenNotSent('instagram', IG_ID, null, ledger({ id: 'bona-daily-ig-2026-10-01', status: 'publishing' })), "another id's line says nothing about this attempt");
  assert.equal(provenNotSent('instagram', IG_ID, null, ledger({ id: IG_ID, status: 'publishing' }, { id: IG_ID, status: 'error' })), null, 'a publishing line keeps it unknown, whatever follows');
  assert.equal(provenNotSent('instagram', IG_ID, null, ledger({ id: IG_ID, status: 'published' })), null);
  assert.equal(provenNotSent('instagram', IG_ID, null, () => { throw new SyntaxError('Unexpected end of JSON input'); }), null, 'an unreadable ledger proves nothing');
});
