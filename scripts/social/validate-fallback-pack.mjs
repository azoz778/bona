#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {sharp} from "./lib/brand.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const packDir=path.join(root,"marketing/fallback-20261005");
const assetDir=path.join(root,"public/social/fallback-20261005");
const manifestPath=path.join(packDir,"manifest.json");
const fail=(message)=>{throw new Error(`Fallback pack validation failed: ${message}`)};
const sha256=(data)=>crypto.createHash("sha256").update(data).digest("hex");
const json=(name)=>JSON.parse(fs.readFileSync(path.join(packDir,name),"utf8"));
const manifest=json("manifest.json");
const source=json("content.json");
const ig=json("instagram.json");
const fb=json("facebook.json");
const exactDates=Array.from({length:7},(_,i)=>{const d=new Date("2026-10-05T00:00:00Z");d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10)});
const forbidden=[
  /تقييم مجاني/u,
  /free valuation/i,
  /prices? (?:will|are going to) (?:rise|increase|fall|drop)/i,
  /الأسعار (?:سترتفع|ستنخفض)/u,
  /(?:now |currently )?available for (?:sale|rent)/i,
  /متاح(?:ة)? (?:للبيع|للإيجار)/u,
  /رخصة إعلان/u,
  /ad licen[cs]e/i,
  /اليوم الوطني|National Day|رمضان|Ramadan|عيد|Eid/u
];
if(manifest.packageId!==source.packageId)fail("package id mismatch");
if(manifest.reviewStatus!=="pending-owner")fail("manifest must remain pending-owner");
if(manifest.approvalGate!=="AWAITING APPROVAL — DO NOT PUBLISH OR SCHEDULE")fail("approval gate missing");
if(manifest.start!==exactDates[0]||manifest.end!==exactDates.at(-1))fail("date range mismatch");
if(manifest.time!=="20:30"||manifest.timezone!=="Asia/Riyadh")fail("schedule mismatch");
if(source.days.length!==7||ig.entries.length!==7||fb.entries.length!==7)fail("expected seven days and seven posts per platform");
if(manifest.assets.length!==14)fail("expected exactly fourteen rendered assets");
if(manifest.postCountPerPlatform!==7||manifest.totalCandidatePosts!==14||"totalScheduledPosts" in manifest)fail("declared candidate counts are wrong");
if(JSON.stringify(manifest.platforms)!==JSON.stringify(["instagram","facebook"]))fail("manifest platforms are not exact");
if(source.days.map(x=>x.date).join()!==exactDates.join())fail("source dates are not consecutive and exact");
const safePolicy={propertySpecific:false,listingClaims:false,priceClaims:false,forecastClaims:false,valuationOffers:false,staleEvents:false,adLicenceRequired:false};
for(const [key,value]of Object.entries(safePolicy))if(manifest.contentPolicy?.[key]!==value)fail(`unsafe or missing content policy ${key}`);
if(source.reviewStatus!=="candidate"||source.approvalGate!==manifest.approvalGate)fail("source approval state is unsafe");
if(source.rights?.type!=="original-typographic-artwork"||source.rights.propertyPhotography!==false||source.rights.thirdPartyMedia!==false||source.rights.adLicenceRequired!==false)fail("source rights declaration is unsafe");
const textOf=(day)=>JSON.stringify({topic:day.topic,caption:day.caption,hashtags:day.hashtags,slides:day.slides});
for(const day of source.days)if(forbidden.some(r=>r.test(textOf(day))))fail(`forbidden claim/event language in source on ${day.date}`);

for(const [platform,doc] of [["instagram",ig],["facebook",fb]]){
  if(doc.reviewStatus!=="pending-owner"||doc.approvalGate!==manifest.approvalGate)fail(`${platform} approval state is unsafe`);
  for(const [i,entry] of doc.entries.entries()){
    const day=source.days[i];
    if(entry.date!==exactDates[i]||entry.time!=="20:30"||entry.timezone!=="Asia/Riyadh")fail(`${platform} schedule mismatch on ${entry.date}`);
    if(entry.platform!==platform||entry.pillar!=="buyer/seller education")fail(`${platform} classification mismatch on ${entry.date}`);
    if(entry.reviewStatus!=="pending-owner"||entry.status!=="candidate")fail(`${platform} entry claims a non-candidate state`);
    if(entry.adLicenceRequired!==false||entry.propertySpecific!==false)fail(`${platform} entry is not licence-free`);
    if(!entry.caption?.ar||!entry.caption?.en||entry.hashtags.length<4)fail(`${platform} bilingual copy or hashtags missing`);
    if(JSON.stringify({topic:entry.topic,caption:entry.caption,hashtags:entry.hashtags,audience:entry.audience})!==JSON.stringify({topic:day.topic,caption:day.caption,hashtags:day.hashtags,audience:day.audience}))fail(`${platform} source drift on ${entry.date}`);
    const exact=`${entry.caption.ar}\n\n—\n\n${entry.caption.en}\n\n${entry.hashtags.join(" ")}\n`;
    if(entry.captionText!==exact)fail(`${platform} captionText drift on ${entry.date}`);
    const expectedCaptionPath=`marketing/fallback-20261005/captions/${entry.date}.txt`;
    if(entry.captionPath!==expectedCaptionPath)fail(`${platform} caption path mismatch on ${entry.date}`);
    const captionFile=fs.readFileSync(path.join(root,entry.captionPath),"utf8");
    if(captionFile!==exact)fail(`${platform} caption file drift on ${entry.date}`);
    if(forbidden.some(r=>r.test(exact)))fail(`${platform} forbidden claim/event language on ${entry.date}`);
    if(entry.assets.length!==1)fail(`${platform} expected one independently rendered asset on ${entry.date}`);
    const shortPlatform=platform==="instagram"?"ig":"fb";
    const expectedPath=`public/social/fallback-20261005/${entry.date}-${shortPlatform}-1.jpg`;
    if(entry.assets[0]!==expectedPath)fail(`${platform} entry asset path mismatch on ${entry.date}`);
    const declaredAsset=manifest.assets.find(asset=>asset.path===expectedPath);
    if(!declaredAsset||declaredAsset.platform!==platform)fail(`${platform} manifest linkage mismatch on ${entry.date}`);
    const expectedGeometry=platform==="instagram"
      ?{dimensions:{width:1080,height:1350},aspect:"portrait-4:5"}
      :{dimensions:{width:1080,height:1080},aspect:"square-1:1"};
    if(JSON.stringify({dimensions:declaredAsset.dimensions,aspect:declaredAsset.aspect})!==JSON.stringify(expectedGeometry))fail(`${platform} geometry mismatch on ${entry.date}`);
  }
}
for(const platform of ["instagram","facebook"]){
  if(manifest.assets.filter(asset=>asset.platform===platform).length!==7)fail(`expected exactly seven ${platform} assets`);
}
const expectedAssetFiles=exactDates.flatMap(date=>[`${date}-fb-1.jpg`,`${date}-ig-1.jpg`]).sort();
const actualAssetEntries=fs.readdirSync(assetDir,{withFileTypes:true});
if(actualAssetEntries.some(entry=>!entry.isFile()))fail("rendered asset directory contains a non-file entry");
const actualAssetFiles=actualAssetEntries.map(entry=>entry.name).sort();
if(JSON.stringify(actualAssetFiles)!==JSON.stringify(expectedAssetFiles))fail("rendered asset directory differs from the exact fourteen expected JPEGs");

function luminance(hex){
  const rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
  return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
for(const asset of manifest.assets){
  const absolute=path.join(root,asset.path);
  if(!fs.existsSync(absolute))fail(`missing ${asset.path}`);
  const bytes=fs.readFileSync(absolute);
  if(bytes[0]!==0xff||bytes[1]!==0xd8||bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)fail(`bad JPEG signature ${asset.path}`);
  if(sha256(bytes)!==asset.sha256)fail(`hash mismatch ${asset.path}`);
  const meta=await sharp(bytes).metadata();
  if(meta.format!=="jpeg"||meta.width!==asset.dimensions.width||meta.height!==asset.dimensions.height)fail(`dimension/format mismatch ${asset.path}`);
  const s=asset.safeArea,b=asset.contentBounds,d=asset.dimensions;
  if(!s||!b||![s.top,s.right,s.bottom,s.left,b.left,b.top,b.right,b.bottom].every(Number.isFinite))fail(`missing/non-finite bounds ${asset.path}`);
  if(JSON.stringify(s)!==JSON.stringify({top:48,right:48,bottom:48,left:48}))fail(`safe-area policy mismatch ${asset.path}`);
  if(b.left<b.right&&b.top<b.bottom){
    if(b.left<s.left||b.top<s.top||b.right>d.width-s.right||b.bottom>d.height-s.bottom)fail(`foreground outside safe area ${asset.path}`);
  }else fail(`inverted/empty bounds ${asset.path}`);
  if(d.width-s.left-s.right<=0||d.height-s.top-s.bottom<=0)fail(`no usable safe rectangle ${asset.path}`);
  for(const color of [asset.foregroundColor,asset.mutedColor,asset.backgroundColor])if(typeof color!=="string"||!/^#[0-9a-f]{6}$/i.test(color))fail(`invalid colour ${asset.path}`);
  const mainContrast=contrast(asset.foregroundColor,asset.backgroundColor),mutedContrast=contrast(asset.mutedColor,asset.backgroundColor);
  if(!Number.isFinite(mainContrast)||mainContrast<7)fail(`insufficient main contrast ${asset.path}`);
  if(!Number.isFinite(mutedContrast)||mutedContrast<4.5)fail(`insufficient muted contrast ${asset.path}`);
  if(asset.kind!=="original-typographic-card"||!/no property photography/i.test(asset.rights))fail(`rights provenance mismatch ${asset.path}`);
}
for(const [p,h] of Object.entries(manifest.supportingFiles)){
  const absolute=path.join(root,p);
  if(!fs.existsSync(absolute)||sha256(fs.readFileSync(absolute))!==h)fail(`supporting file hash mismatch ${p}`);
}
const expectedCaptionPaths=exactDates.map(date=>`marketing/fallback-20261005/captions/${date}.txt`);
const expectedPreviews=[
  "marketing/fallback-20261005/review/instagram-contact-sheet.jpg",
  "marketing/fallback-20261005/review/facebook-contact-sheet.jpg"
];
const expectedSupportingPaths=[
  "marketing/fallback-20261005/content.json",
  "marketing/fallback-20261005/instagram.json",
  "marketing/fallback-20261005/facebook.json",
  ...expectedCaptionPaths,
  ...expectedPreviews
].sort();
if(JSON.stringify(Object.keys(manifest.supportingFiles).sort())!==JSON.stringify(expectedSupportingPaths))fail("supporting file set is not exact");
if(JSON.stringify(manifest.previews)!==JSON.stringify(expectedPreviews))fail("contact-sheet preview list is not exact");
const expectedCaptions=exactDates.map((date,i)=>({date,path:expectedCaptionPaths[i],sha256:manifest.supportingFiles[expectedCaptionPaths[i]]}));
if(JSON.stringify(manifest.captions)!==JSON.stringify(expectedCaptions))fail("caption manifest is not exact");
for(const [preview,dimensions] of [[expectedPreviews[0],{width:1100,height:686}],[expectedPreviews[1],{width:1100,height:560}]]){
  const bytes=fs.readFileSync(path.join(root,preview));
  if(bytes[0]!==0xff||bytes[1]!==0xd8||bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)fail(`bad contact-sheet JPEG signature ${preview}`);
  const meta=await sharp(bytes).metadata();
  if(meta.format!=="jpeg"||meta.width!==dimensions.width||meta.height!==dimensions.height)fail(`contact-sheet geometry mismatch ${preview}`);
}
const report=fs.readFileSync(path.join(packDir,"hash-report.txt"),"utf8");
const expectedReport=[
  `PACKAGE ${manifest.packageId}`,
  "STATE pending-owner",
  manifest.approvalGate,
  `MANIFEST_SHA256 ${sha256(fs.readFileSync(manifestPath))}`,
  ...manifest.assets.map(asset=>`${asset.sha256}  ${asset.path}`),
  ...Object.entries(manifest.supportingFiles).sort(([a],[b])=>a.localeCompare(b)).map(([p,h])=>`${h}  ${p}`),
  ""
].join("\n");
if(report!==expectedReport)fail("hash report differs from the exact expected report");
console.log(`PASS: ${source.days.length} dates, ${ig.entries.length+fb.entries.length} candidate posts, ${manifest.assets.length} JPEGs, ${manifest.captions.length} exact caption files, 2 contact sheets.`);
console.log("State: pending-owner; no publish or schedule authorization.");
