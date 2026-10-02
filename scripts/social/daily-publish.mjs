#!/usr/bin/env node
// A finite reviewed daily release only. Never reads the legacy queue/calendar.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {verifyPack,dueToday,ksaNow,verifyPublic,facebookState,ROOT} from "./lib/daily-pack.mjs";
import {withLock,pageToken,publishEntry,appendLedger,captionFromEntry,filesFor} from "./lib/facebook.mjs";
const channel=process.argv[2],dry=process.argv.includes("--dry-run");
if(!["instagram","facebook"].includes(channel))throw new Error("Choose instagram or facebook");
const data=process.env.BONA_DATA||path.join(os.homedir(),"bona-data"),dir=path.join(data,"daily");
fs.mkdirSync(dir,{recursive:true});
function record(file,obj){const fd=fs.openSync(file,"a",0o600);try{fs.writeSync(fd,JSON.stringify({...obj,at:new Date().toISOString()})+"\n");fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
function rows(file){if(!fs.existsSync(file))return [];return fs.readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(x=>JSON.parse(x))}
try{
 if(fs.existsSync(path.join(ROOT,"marketing/daily/property-policy.json"))){
  const {propertyDaily}=await import("./property-publish.mjs");
  await propertyDaily(channel,{dry,now:dry&&process.env.BONA_DAILY_TEST_NOW?new Date(process.env.BONA_DAILY_TEST_NOW):new Date()});
  process.exit(0);
 }
 const pack=verifyPack();
 // Positive isolation: a legacy timer accidentally restored by an installer is a stop.
 if(!dry)for(const name of ["bona-ig-publish.timer","bona-fb-publish.timer"]){
  const check=spawnSync("systemctl",["--user","is-enabled",name],{encoding:"utf8"});
  if(!["disabled","masked","not-found"].includes(check.stdout.trim()))throw new Error(`Legacy timer is not disabled: ${name}`);
  const active=spawnSync("systemctl",["--user","is-active",name],{encoding:"utf8"});
  if(!["inactive","unknown"].includes(active.stdout.trim()))throw new Error(`Legacy timer is active: ${name}`);
 }
 const now=dry&&process.env.BONA_DAILY_TEST_NOW?new Date(process.env.BONA_DAILY_TEST_NOW):new Date();
 const entry=dueToday(pack[channel],now);
 if(!entry){console.log(`No daily content due (${JSON.stringify(ksaNow(now))}); no backfill or legacy fallback.`);process.exit(0)}
 if(channel==="instagram"){
  await verifyPublic(entry,pack.manifest);
  if(dry){console.log(`Validated public bytes and reviewed source: ${entry.id}; no publish`);process.exit(0)}
  const r=spawnSync(process.execPath,["scripts/social/publish.mjs","--live","--source","marketing/daily/instagram.json","--grace","2.5","--limit","1"],{cwd:ROOT,stdio:"inherit",env:process.env});
  if(r.status!==0)throw new Error(`Instagram publisher requires attention (exit ${r.status})`);
  const published=rows(path.join(data,"ig/published.jsonl")).some(x=>x.id===entry.id&&x.status==="published");
  if(!published)throw new Error("Instagram did not confirm publication; inspect ledger skip/defer or in-flight reason");
 }else{
  if(dry){console.log(`Validated local reviewed assets: ${entry.id}; no publish`);process.exit(0)}
  const journal=path.join(dir,"facebook.jsonl");
  await withLock(path.join(dir,".facebook.lock"),async()=>{
   const state=facebookState(rows(journal),entry.id);
   if(state==="published"){console.log("Already published today");return}
   if(state==="uncertain")throw new Error(`Uncertain Facebook intent ${entry.id}; manual reconciliation required, no retry`);
   if(!process.env.META_ACCESS_TOKEN||!process.env.FB_PAGE_ID)throw new Error("Facebook credentials unavailable");
   const page=await pageToken({fetch,token:process.env.META_ACCESS_TOKEN,pageId:process.env.FB_PAGE_ID});
   captionFromEntry(entry);
   for(const f of filesFor(entry,ROOT))if(!fs.existsSync(f))throw new Error("Reviewed Facebook asset missing before upload");
   record(journal,{id:entry.id,status:"intent",date:entry.date});
   const result=await publishEntry(entry,{fetch,pageToken:page.token,pageId:process.env.FB_PAGE_ID,root:ROOT});
   record(journal,{id:entry.id,status:"published",...result});
   appendLedger(path.join(data,"fb/published.jsonl"),{id:entry.id,...result,at:new Date().toISOString()});
   console.log(`Published ${entry.id}: ${JSON.stringify(result)}`);
  });
 }
}catch(e){
 // Errors deliberately contain no token or provider request/response body.
 record(path.join(dir,"alerts.jsonl"),{channel,status:"needs-attention",reason:String(e.message).replace(/EAA[A-Za-z0-9]+/g,"[redacted]").slice(0,800)});
 console.error(`Daily ${channel} failed; see ${path.join(dir,"alerts.jsonl")}. No fallback was used.`);process.exitCode=1;
}
