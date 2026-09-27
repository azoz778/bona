import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
export const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const json=p=>JSON.parse(fs.readFileSync(p,"utf8"));
export function verifyPack(root=ROOT,{draft=false}={}){
 const manifestPath=path.join(root,"marketing/daily/manifest.json"),raw=fs.readFileSync(manifestPath),m=JSON.parse(raw);
 if(m.version!==1||m.time!=="20:30"||m.timezone!=="Asia/Riyadh")throw new Error("Invalid daily schedule");
 if(!draft){const receipt=json(path.join(root,"marketing/daily/release.json"));if(receipt.status!=="approved"||receipt.manifestSha256!==sha(raw)||!receipt.reviews?.includes("claude-fable-5"))throw new Error("Daily release is unapproved or changed");}
 for(const [rel,digest]of Object.entries(m.files)){
  if(!/^(public\/social\/daily-[\w-]+\/[\w.-]+\.jpg|marketing\/daily\/(content|instagram|facebook)\.json)$/.test(rel))throw new Error("Non-daily file in manifest");
  if(sha(fs.readFileSync(path.join(root,rel)))!==digest)throw new Error(`Reviewed file changed: ${rel}`);
 }
 for(const required of ["content","instagram","facebook"])if(!m.files[`marketing/daily/${required}.json`])throw new Error("Missing source hash");
 const ig=json(path.join(root,"marketing/daily/instagram.json")),fb=json(path.join(root,"marketing/daily/facebook.json")).entries;
 const length=(Date.parse(m.end)-Date.parse(m.start))/86400000+1;
 if(!Number.isInteger(length)||length<1||length>14||ig.length!==length||fb.length!==length)throw new Error("Invalid finite calendar length");
 for(const [platform,rows]of [["instagram",ig],["facebook",fb]]){
  const days=new Set();
  for(const e of rows){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(e.date)||!Number.isFinite(Date.parse(e.date))||e.platform!==platform||e.reviewStatus!=="approved"||e.time!==m.time||e.date<m.start||e.date>m.end||days.has(e.date)||e.id!==`bona-daily-${platform==="instagram"?"ig":"fb"}-${e.date}`)throw new Error("Invalid or duplicate channel/day");
   if(e.blocked||e.adLicenceRequired||e.listingId||e.listingRef||!e.caption?.ar||!e.caption?.en)throw new Error("Daily pack must be reviewed factual editorial");
   const files=platform==="instagram"?e.images.map(u=>{
    if(!u.startsWith("https://bona-real-estate.com/social/"))throw new Error("Unexpected asset host");
    return "public"+new URL(u).pathname;
   }):e.assets;
   if(!files?.length||files.length>10||files.some(f=>!m.files[f])||new Set(files).size!==files.length)throw new Error("Missing or duplicated reviewed asset");
   days.add(e.date);
  }
 }
 return {manifest:m,instagram:ig,facebook:fb};
}
export function ksaNow(now=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Riyadh",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now).map(x=>[x.type,x.value]));
 return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
}
export function dueToday(rows,now=new Date()){
 const {date,time}=ksaNow(now);
 if(time<"20:30"||time>="23:00")return null;
 return rows.find(e=>e.date===date)??null;
}
export async function verifyPublic(entry,manifest,fetchImpl=fetch){
 for(const url of entry.images){const r=await fetchImpl(url,{signal:AbortSignal.timeout(30000),redirect:"error"});if(!r.ok||!r.headers.get("content-type")?.startsWith("image/jpeg"))throw new Error("Public JPEG unavailable");const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>8000000||sha(bytes)!==manifest.files["public"+new URL(url).pathname])throw new Error("Public image differs from reviewed JPEG");}
}

export function facebookState(events,id){
 const matched=events.filter(x=>x.id===id);
 if(matched.some(x=>x.status==="published"))return "published";
 if(!matched.length||matched.at(-1).status==="confirmed-not-published")return "ready";
 return "uncertain";
}
