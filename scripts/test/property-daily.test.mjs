import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publicListing,sha256,fingerprint,advertiserFingerprint,eligibility,propertyCaption,chooseProperty,dayState,realDate } from '../social/lib/property-daily.mjs';
import { propertyDaily,legacyDayState } from '../social/property-publish.mjs';
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
test('publication eligibility needs a current licence, matching evidence, reviewed facts and photographs',()=>{
  const {listing:p,advertiser:a,review:r}=fixture();assert.deepEqual(eligibility(p,r,a,now),[]);
  assert.ok(eligibility({...p,licence:null},r,a,now).includes('missing_ad_licence'));
  assert.ok(eligibility({...p,status:'sold'},r,a,now).includes('not_available'));
  assert.ok(eligibility({...p,category:'off-plan'},r,a,now).includes('requires_separate_market_or_offplan_review'));
  assert.ok(eligibility(p,{...r,licenceEvidence:{...r.licenceEvidence,socialMediaAllowed:false}},a,now).includes('licence_and_marketing_authority_unverified'));
  assert.ok(eligibility(p,{...r,photos:r.photos.map(x=>({...x,kind:'render'}))},a,now).includes('photo_quality_or_provenance_unverified'));
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
