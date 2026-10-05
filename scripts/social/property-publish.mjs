import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, ksaNow } from './lib/daily-pack.mjs';
import { ACCOUNT, SITE, sha256, fingerprint, eligibility, chooseProperty, dayState, entryFor, policyRules, unsettled } from './lib/property-daily.mjs';
import { withLock, whoami, pageToken, publishEntry, appendLedger, refusal } from './lib/facebook.mjs';
import { createGraph, checkCaption } from './lib/graph.mjs';
import { run as publishInstagram, indexLedger, composeCaption, hasLicencePlaceholder, decide, normaliseEntry } from './publish.mjs';
import { resolveLedgerPath } from './lib/ledger.mjs';

const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const rows = file => fs.existsSync(file) ? fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
function record(file,row) {
  const fd=fs.openSync(file,'a',0o600);
  try { fs.writeSync(fd,JSON.stringify({...row,at:new Date().toISOString()})+'\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
export function legacyDayState(events,date) {
  const matching=events.filter(e=>e.date===date || e.id?.endsWith('-'+date) ||
    (e.status==='published' && Number.isFinite(Date.parse(e.ts ?? e.at)) && ksaNow(new Date(e.ts ?? e.at)).date===date));
  if(matching.some(e=>e.status==='published' || (!e.status && (e.postId || e.mediaId)))) return 'published';
  if(matching.some(e=>['publishing','intent','uncertain'].includes(e.status))) return 'uncertain';
  return 'ready';
}
/**
 * A `publishing` line in the Instagram ledger is settled only by a line in that ledger. A
 * confirmed-not-published record in the property journal does not settle it on purpose: the
 * Instagram publisher reconciles an in-flight container by re-sending media_publish while the
 * container is still FINISHED (up to 24 h), which would post the earlier attempt's copy without
 * the live-catalogue re-check.
 */
export function assertNoPendingInstagram(events) {
  const pending=[...indexLedger(events)].filter(([,r])=>r.inFlight&&!r.published).map(([id])=>id);
  if(pending.length)throw new Error(`Earlier Instagram container is unsettled (${pending.slice(0,3).join(', ')}): check the account, then append a published or error line for it to ig/published.jsonl; no backfill`);
  return events;
}
const IG_GRACE_HOURS=2.5;
/**
 * Proof that a failed attempt made nothing visible, as {evidence, message}, or null when the
 * outcome is unknown. Instagram: publish.mjs run() appends a `publishing` line for the entry
 * before media_publish, the only call that makes a post visible; with neither that line nor a
 * `published` one for the id in the ledger, media_publish was never sent. A ledger that cannot be
 * read proves nothing. Facebook: lib/facebook.mjs postPhotos() marks `notPublished` a failure among
 * the unpublished photo uploads, which all come before the one Page feed request.
 */
export function provenNotSent(channel,id,error,readIgLedger) {
  if(channel==='facebook')return error?.notPublished===true?{evidence:'failed before the Page feed request; only unpublished photo uploads were made',
    message:'Facebook post not sent: a photo upload failed before the Page feed request'}:null;
  if(channel!=='instagram')return null;
  let mine;
  try{mine=readIgLedger().filter(x=>x.id===id);}catch{return null;}
  if(mine.some(x=>x.status==='publishing'||x.status==='published'))return null;
  const last=mine.at(-1)?.status;
  return {evidence:`no publishing line for ${id} in ig/published.jsonl; media_publish was never sent`,
    message:`Instagram post not sent${last?` (last ledger status for ${id}: ${last})`:''}`};
}
/**
 * Why this channel's own publisher would turn the entry down before any network call, or null.
 * Checked before the intent record: a refusal that is certain in advance stops the run cleanly
 * instead of being journalled as an uncertain attempt that blocks the channel until reconciled.
 */
export function publisherRefusal(entry,channel,{igLedger=[],now=new Date()}={}) {
  if(hasLicencePlaceholder(composeCaption(entry)))return 'caption carries a licence placeholder';
  if(channel==='facebook')return refusal(entry);
  const d=decide(normaliseEntry(entry),{now:+now,graceMs:IG_GRACE_HOURS*3600000,ledger:indexLedger(igLedger)});
  return d.status==='candidate'?null:d.status?`${d.status}: ${d.detail}`:'not due, or already settled in the Instagram ledger';
}
async function catalogue(fetchImpl=fetch,now=new Date()) {
  const res=await fetchImpl(`${SITE}/social-catalogue.json`,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
  if(!res.ok || !res.headers.get('content-type')?.includes('application/json')) throw new Error('Live catalogue unavailable');
  const text=await res.text(); if(Buffer.byteLength(text)>3000000)throw new Error('Live catalogue oversized');
  const d=JSON.parse(text);
  if(d.version!==1 || !Array.isArray(d.listings) || !d.advertiser || new Set(d.listings.map(x=>x.id)).size!==d.listings.length)throw new Error('Invalid live catalogue');
  const generated=Date.parse(d.generatedAt);
  if(!Number.isFinite(generated)||generated>+now||+now-generated>48*3600000)throw new Error('Live catalogue is stale; daily website refresh needs attention');
  return d;
}
async function photos(review,dir,dry,fetchImpl=fetch) {
  const paths=[];
  for(const [i,p] of review.photos.entries()) {
    const res=await fetchImpl(p.url,{redirect:'error',headers:{'User-Agent':'BonaPropertyPublisher/1.0'},signal:AbortSignal.timeout(20000)});
    if(!res.ok || !res.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('Reviewed source photo unavailable');
    const bytes=Buffer.from(await res.arrayBuffer());
    if(bytes.length>8000000 || sha256(bytes)!==p.sha256)throw new Error('Source photo changed since visual review');
    const file=path.join(dir,`${i+1}.jpg`);
    if(!dry)fs.writeFileSync(file,bytes,{mode:0o600});
    paths.push(file);
  }
  return paths;
}
async function identity(channel,env,fetchImpl=fetch) {
  if(!env.META_ACCESS_TOKEN)throw new Error('Existing Meta credential unavailable');
  if(channel==='instagram') {
    if(env.IG_BUSINESS_ID!==ACCOUNT.instagram)throw new Error('Instagram account mismatch');
    const graph=createGraph({token:env.META_ACCESS_TOKEN,igId:env.IG_BUSINESS_ID,fetch:fetchImpl});
    const me=await graph.me();
    if(me.id!==ACCOUNT.instagram || me.username!=='bonarealestatesa')throw new Error('Instagram identity changed');
    await graph.publishingLimit();
  } else {
    if(env.FB_PAGE_ID!==ACCOUNT.facebook)throw new Error('Facebook account mismatch');
    const info=await whoami({fetch:fetchImpl,token:env.META_ACCESS_TOKEN,pageId:env.FB_PAGE_ID});
    if(info.page.id!==ACCOUNT.facebook || info.page.name!=='Bona Real Estate' || !info.page.published)throw new Error('Facebook identity changed');
  }
}
/** True when both legacy publisher timers are disabled, masked or absent, and not running. A failed systemctl call counts as not disabled. */
function legacyTimersOff() {
  return ['bona-ig-publish.timer','bona-fb-publish.timer'].every(name=>{
    const enabled=String(spawnSync('systemctl',['--user','is-enabled',name],{encoding:'utf8'}).stdout??'').trim();
    const active=String(spawnSync('systemctl',['--user','is-active',name],{encoding:'utf8'}).stdout??'').trim();
    return ['disabled','masked','not-found'].includes(enabled)&&['inactive','unknown'].includes(active);
  });
}
/**
 * `legacyTimersDisabled` replaces the systemctl check in tests; anything but `true` refuses the send.
 * `now` (read when the run starts) picks the slot; `clock` is read again just before the intent record.
 */
export async function propertyDaily(channel,{dry=false,now=new Date(),root=ROOT,env=process.env,fetchImpl=fetch,legacyTimersDisabled=legacyTimersOff,clock=()=>new Date()}={}) {
  const policy=read(path.join(root,'marketing/daily/property-policy.json'));
  if(policy.version!==1 || policy.mode!=='property-photography' || policy.time!=='20:30' || policy.timezone!=='Asia/Riyadh' ||
     policy.catalogueUrl!==`${SITE}/social-catalogue.json` || policy.repeatDays<30 ||
     policy.channels?.join(',')!=='instagram,facebook' || !policy.channels.includes(channel))throw new Error('Invalid property publishing policy');
  const rules=policyRules(policy,now);
  const {date,time}=ksaNow(now);
  if(time<'20:30'||time>='23:00'){console.log('Outside daily slot; no catch-up or off-schedule post');return {status:'not-due'};}
  const data=env.BONA_DATA||path.join(os.homedir(),'bona-data'),dir=path.join(data,'daily'),journal=path.join(dir,'property.jsonl');
  // The Instagram ledger exactly as publish.mjs run() resolves it (~ expanded, absolute), so every
  // read here, the not-sent proof included, sees the file run() appends to.
  const igLedger=resolveLedgerPath(path.join(data,'ig/published.jsonl'));
  const operation=async()=>{
    const history=rows(journal),state=dayState(history,channel,date);
    const legacy=legacyDayState(channel==='instagram'?rows(igLedger):[...rows(path.join(dir,'facebook.jsonl')),...rows(path.join(data,'fb/published.jsonl'))],date);
    if(state==='published'||legacy==='published'){console.log('Daily slot already published');return {status:'already-published'};}
    if(state==='uncertain'||legacy==='uncertain')throw new Error('Uncertain daily publication; reconcile before retry');
    if(channel==='instagram')assertNoPendingInstagram(rows(igLedger));
    if(unsettled(history,channel))throw new Error('Earlier property publication remains uncertain; reconcile it before retrying');
    const live=await catalogue(fetchImpl,now),reviews=read(path.join(root,'marketing/daily/property-reviews.json'));
    const selected=chooseProperty(live.listings,reviews,live.advertiser,history,channel,now,policy.repeatDays,rules);
    if(!selected.listing){
      const reasons={};for(const r of selected.rejected)for(const why of r.reasons)reasons[why]=(reasons[why]||0)+1;
      const row={channel,date,status:'skipped-no-eligible-property',catalogueCount:live.listings.length,reasons};
      if(!dry && !history.some(e=>e.channel===channel&&e.date===date&&e.status===row.status&&JSON.stringify(e.reasons)===JSON.stringify(reasons)))record(journal,row);
      console.log(JSON.stringify(row));return row;
    }
    const p=selected.listing,review=reviews[p.id];
    await identity(channel,env,fetchImpl);
    const assetDir=path.join(dir,'property-assets',date,channel);
    if(!dry)fs.mkdirSync(assetDir,{recursive:true});
    const assets=await photos(review,assetDir,dry,fetchImpl);
    const entry=entryFor(p,review,live.advertiser,channel,date,assets);
    if(checkCaption(composeCaption(entry)).problems.length)throw new Error('Reviewed caption does not fit platform limits');
    const refused=publisherRefusal(entry,channel,{igLedger:channel==='instagram'?rows(igLedger):[],now});
    if(refused)throw new Error(`The ${channel} publisher would refuse this post (${refused}); stopped before any record`);
    // Re-read the live source immediately before intent/upload: changed facts, withdrawn
    // stock, expired licence and changed advertiser all stop this run.
    const current=await catalogue(fetchImpl,now),updated=current.listings.find(x=>x.id===p.id);
    if(!updated || fingerprint(updated)!==fingerprint(p) || eligibility(updated,review,current.advertiser,now,rules).length)throw new Error('Property changed during preflight');
    if(dry){console.log(`Ready after read-only preflight: ${entry.id}, ${p.id}; no post`);return {status:'ready',entry};}
    if(legacyTimersDisabled()!==true)throw new Error('Legacy publisher must remain disabled');
    // Before the intent record: failing to get the Page token sends nothing and leaves nothing to reconcile.
    const page=channel==='facebook'?await pageToken({fetch:fetchImpl,token:env.META_ACCESS_TOKEN,pageId:ACCOUNT.facebook}):null;
    // A slow preflight must not record intent or send after the slot: check it again on the real clock.
    const sendAt=ksaNow(clock());
    if(sendAt.date!==date||sendAt.time<'20:30'||sendAt.time>='23:00'){console.log('Outside daily slot at send time; no post');return {status:'not-due'};}
    record(journal,{channel,date,id:entry.id,listingId:p.id,status:'intent'});
    try {
      let receipt;
      if(channel==='instagram') {
        const result=await publishInstagram({dryRun:false,limit:1,graceHours:IG_GRACE_HOURS,ledger:igLedger},
          {now:+now,token:env.META_ACCESS_TOKEN,igId:ACCOUNT.instagram,loadEntries:()=>[entry],
           readLedger:()=>assertNoPendingInstagram(rows(igLedger)),fetch:fetchImpl});
        receipt=rows(igLedger).find(x=>x.id===entry.id&&x.status==='published');
        if(result.code!==0||!receipt)throw new Error('Instagram did not confirm publication');
      } else {
        receipt=await publishEntry(entry,{fetch:fetchImpl,pageToken:page.token,pageId:ACCOUNT.facebook,root});
        appendLedger(path.join(data,'fb/published.jsonl'),{id:entry.id,date,listingId:p.id,status:'published',...receipt,at:new Date().toISOString()});
        record(path.join(dir,'facebook.jsonl'),{id:entry.id,date,status:'published',...receipt});
      }
      record(journal,{channel,date,id:entry.id,listingId:p.id,status:'published',mediaId:receipt.mediaId,postId:receipt.postId,permalink:receipt.permalink});
      console.log(JSON.stringify({status:'published',channel,id:entry.id,listingId:p.id,mediaId:receipt.mediaId,postId:receipt.postId,permalink:receipt.permalink}));
      return {status:'published',receipt};
    } catch(e) {
      // Only a failure that provably made nothing visible settles itself; anything else stays uncertain.
      const notSent=provenNotSent(channel,entry.id,e,()=>rows(igLedger));
      if(notSent){
        record(journal,{channel,date,id:entry.id,listingId:p.id,status:'confirmed-not-published',evidence:notSent.evidence});
        throw new Error(`${notSent.message}; recorded confirmed-not-published, the next run retries`);
      }
      record(journal,{channel,date,id:entry.id,listingId:p.id,status:'uncertain'});throw new Error('Property publication unconfirmed; automatic retry stopped');
    }
  };
  if(dry)return operation();
  fs.mkdirSync(dir,{recursive:true});
  return withLock(path.join(dir,`.property-${channel}.lock`),operation);
}
