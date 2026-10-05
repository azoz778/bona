import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {ROOT,sha,verifyPack,dueToday,verifyPublic,facebookState} from "../social/lib/daily-pack.mjs";
const receipt=(root)=>fs.writeFileSync(path.join(root,"marketing/daily/release.json"),JSON.stringify({status:"approved",reviews:["claude-fable-5"],manifestSha256:sha(fs.readFileSync(path.join(root,"marketing/daily/manifest.json")))}));
function fixture(){const r=fs.mkdtempSync(path.join(os.tmpdir(),"bona-daily-"));fs.cpSync(path.join(ROOT,"marketing/daily"),path.join(r,"marketing/daily"),{recursive:true});fs.cpSync(path.join(ROOT,"public/social/daily-20260928"),path.join(r,"public/social/daily-20260928"),{recursive:true});receipt(r);return r}
test("review receipt binds exact source, schedule, copy and JPEG bytes",()=>{const r=fixture();try{const pack=verifyPack(r);assert.equal(pack.instagram.length,7);fs.appendFileSync(path.join(r,"marketing/daily/instagram.json")," ");assert.throws(()=>verifyPack(r),/changed/)}finally{fs.rmSync(r,{recursive:true})}});
test("missing receipt or modified manifest cannot publish",()=>{const r=fixture();try{fs.unlinkSync(path.join(r,"marketing/daily/release.json"));assert.throws(()=>verifyPack(r));receipt(r);fs.appendFileSync(path.join(r,"marketing/daily/manifest.json")," ");assert.throws(()=>verifyPack(r),/unapproved or changed/)}finally{fs.rmSync(r,{recursive:true})}});
test("no early publish, no backfill, no exhausted-pack fallback",()=>{const pack=verifyPack(ROOT,{draft:true});assert.equal(dueToday(pack.instagram,new Date("2026-09-28T17:29:59Z")),null);assert.equal(dueToday(pack.instagram,new Date("2026-09-28T17:30:00Z")).date,"2026-09-28");assert.equal(dueToday(pack.instagram,new Date("2026-09-28T20:00:00Z")),null);assert.equal(dueToday(pack.instagram,new Date("2026-10-05T17:30:00Z")),null)});
test("Instagram public bytes must equal the reviewed JPEG, not merely HTTP 200",async()=>{const pack=verifyPack(ROOT,{draft:true});const entry=pack.instagram[0];const ok=async u=>({ok:true,headers:new Headers({"content-type":"image/jpeg"}),arrayBuffer:async()=>fs.readFileSync(path.join(ROOT,"public"+new URL(u).pathname))});await verifyPublic(entry,pack.manifest,ok);await assert.rejects(verifyPublic(entry,pack.manifest,async()=>({ok:true,headers:new Headers({"content-type":"image/jpeg"}),arrayBuffer:async()=>Buffer.from("stale")})),/differs/)});
test("Facebook uncertain intent never retries; reconciliation applies only to that attempt",()=>{const e=s=>({id:"day",status:s});assert.equal(facebookState([],"day"),"ready");assert.equal(facebookState([e("intent")],"day"),"uncertain");assert.equal(facebookState([e("intent"),e("confirmed-not-published")],"day"),"ready");assert.equal(facebookState([e("intent"),e("confirmed-not-published"),e("intent")],"day"),"uncertain");assert.equal(facebookState([e("intent"),e("published"),e("intent")],"day"),"published")});
test("BONA_DATA starting with ~ is the home directory for alerts, heartbeat and journals, not a directory under the working directory",()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"bona-daily-home-")),cwd=fs.mkdtempSync(path.join(os.tmpdir(),"bona-daily-cwd-"));
 try{
  // 10:00 Riyadh: outside the slot, so the dry run stops before any network call.
  const r=spawnSync(process.execPath,[path.join(ROOT,"scripts/social/daily-publish.mjs"),"instagram","--dry-run"],{cwd,encoding:"utf8",env:{PATH:process.env.PATH,HOME:home,BONA_DATA:"~/x",BONA_DAILY_TEST_NOW:"2026-10-06T07:00:00Z"}});
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/Outside daily slot/);
  assert.ok(fs.statSync(path.join(home,"x/daily")).isDirectory());
  assert.deepEqual(fs.readdirSync(cwd),[]);
 }finally{fs.rmSync(home,{recursive:true,force:true});fs.rmSync(cwd,{recursive:true,force:true})}
});
