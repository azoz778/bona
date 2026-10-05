import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publicListing,sha256,fingerprint,advertiserFingerprint,eligibility,propertyCaption,chooseProperty,dayState,realDate,policyRules,STRICT_RULES,renderShare,captionFor,propertyHashtags,entryFor } from '../social/lib/property-daily.mjs';
import { propertyDaily,legacyDayState,assertNoPendingInstagram } from '../social/property-publish.mjs';
const now=new Date('2026-10-02T17:30:00Z');
function fixture() {
  const advertiser={name:{ar:'المعلن التجريبي',en:'Fixture advertiser'},fal:'1100000000',phone:'+966500000000'};
  const listing={id:'BONA-TEST',slug:'fixture',status:'available',category:'buy',location:{countryCode:'SA',city:{ar:'جدة',en:'Jeddah'}},title:{ar:'فيلا تجريبية',en:'Fixture villa'},price:{amount:1000000,currency:'SAR'},specs:{beds:3,plotSqm:400},images:[1,2,3].map(i=>({src:`/listings/fixture/${i}.jpg`})),licence:{adNumber:'7200000000',adExpiry:'2026-12-31'}};
  const review={status:'approved',factsSha256:fingerprint(listing),advertiserSha256:advertiserFingerprint(advertiser),reviewedAt:'2026-10-02T12:00:00Z',captionSha256:sha256(JSON.stringify(propertyCaption(listing,advertiser))),licenceEvidence:{adNumber:listing.licence.adNumber,adExpiry:listing.licence.adExpiry,sourceReference:'fixture only',marketingAuthorizationReference:'fixture only',socialMediaAllowed:true,contactMatches:true,verifiedAt:'2026-10-02T12:00:00Z'},photos:listing.images.map((x,i)=>({url:'https://bona-real-estate.com'+x.src,kind:'photograph',visuallyApproved:true,sha256:sha256('fixture '+i),width:1920,height:1280,alt:{ar:'صورة اختبار',en:'Fixture photo'}}))};
  review.legalDisclosuresVerified=true;
  review.legalDisclosures={ar:'بيانات اختبار فقط: حالة العقار والخدمات والحقوق.',en:'Test fixture only: property condition, services and rights.'};
  review.captionSha256=sha256(JSON.stringify(propertyCaption(listing,advertiser,review.legalDisclosures)));
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
  review.captionSha256 = sha256(JSON.stringify(captionFor(p, a, review)));
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
test('rotation applies the policy rules it is given', () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null };
  const reviews = { [p.id]: waivedReview(p, a) };
  assert.equal(chooseProperty([p], reviews, a, [], 'instagram', now).listing, null);
  assert.equal(chooseProperty([p], reviews, a, [], 'instagram', now, 30, WAIVED).listing.id, p.id);
});
