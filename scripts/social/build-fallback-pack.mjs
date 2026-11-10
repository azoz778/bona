#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {renderCard} from "./lib/daily-card.mjs";
import {sharp} from "./lib/brand.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const packDir=path.join(root,"marketing/fallback-20261005");
const contentPath=path.join(packDir,"content.json");
const source=JSON.parse(fs.readFileSync(contentPath,"utf8"));
const assetRelDir="public/social/fallback-20261005";
const assetDir=path.join(root,assetRelDir);
const captionsDir=path.join(packDir,"captions");
const reviewDir=path.join(packDir,"review");
for(const dir of [assetDir,captionsDir,reviewDir])fs.mkdirSync(dir,{recursive:true});
for(const dir of [assetDir,captionsDir,reviewDir])for(const name of fs.readdirSync(dir))fs.rmSync(path.join(dir,name),{recursive:true,force:true});
const sha256=(data)=>crypto.createHash("sha256").update(data).digest("hex");
const rel=(p)=>path.relative(root,p).split(path.sep).join("/");
const approvalGate="AWAITING APPROVAL — DO NOT PUBLISH OR SCHEDULE";
const safeArea={top:48,right:48,bottom:48,left:48};
const assetRecords=[];
const platforms={instagram:[],facebook:[]};
const contactInputs={instagram:[],facebook:[]};

for(const day of source.days){
  const platformAssets={instagram:[],facebook:[]};
  for(const [index,slide] of day.slides.entries()){
    for(const spec of [{platform:"instagram",tag:"ig",height:1350,format:"portrait-4:5"},{platform:"facebook",tag:"fb",height:1080,format:"square-1:1"}]){
      const name=`${day.date}-${spec.tag}-${index+1}.jpg`;
      const audit=[];
      const rendered=await renderCard({...slide,highContrast:true,count:day.slides.length,seriesAr:"بونا  /  دليل واضح",seriesEn:"CLEAR PROPERTY NOTES"},index,spec.height,name,assetDir,audit);
      const absolute=path.join(assetDir,name);
      const relative=rel(absolute);
      const bytes=fs.readFileSync(absolute);
      const record={
        packageId:source.packageId,
        platform:spec.platform,
        path:relative,
        kind:"original-typographic-card",
        format:"jpeg",
        dimensions:{width:rendered.width,height:rendered.height},
        aspect:spec.format,
        safeArea,
        contentBounds:rendered.contentBounds,
        foregroundColor:rendered.foregroundColor,
        mutedColor:rendered.mutedColor,
        backgroundColor:rendered.backgroundColor,
        sha256:sha256(bytes),
        rights:"Original Bona typographic artwork; no property photography or third-party media."
      };
      assetRecords.push(record);
      platformAssets[spec.platform].push(relative);
      contactInputs[spec.platform].push({path:absolute,date:day.date});
    }
  }
  const captionText=`${day.caption.ar}\n\n—\n\n${day.caption.en}\n\n${day.hashtags.join(" ")}\n`;
  const captionPath=path.join(captionsDir,`${day.date}.txt`);
  fs.writeFileSync(captionPath,captionText);
  for(const platform of ["instagram","facebook"]){
    platforms[platform].push({
      id:`bona-fallback-${platform === "instagram" ? "ig" : "fb"}-${day.date}`,
      packageId:source.packageId,
      date:day.date,
      time:source.time,
      timezone:source.timezone,
      platform,
      format:platformAssets[platform].length>1?"carousel":"image",
      pillar:"buyer/seller education",
      audience:day.audience,
      topic:day.topic,
      caption:day.caption,
      hashtags:day.hashtags,
      captionText,
      captionPath:rel(captionPath),
      assets:platformAssets[platform],
      alt:day.topic,
      adLicenceRequired:false,
      propertySpecific:false,
      reviewStatus:"pending-owner",
      status:"candidate",
      approvalGate
    });
  }
}

async function contactSheet(items,name,height){
  const thumbW=250;
  const thumbH=Math.round(thumbW*height/1080);
  const gap=20;
  const cols=4;
  const rows=Math.ceil(items.length/cols);
  const width=cols*thumbW+(cols+1)*gap;
  const canvasH=rows*thumbH+(rows+1)*gap;
  const layers=[];
  for(const [i,item] of items.entries()){
    const input=await sharp(item.path).resize(thumbW,thumbH,{fit:"fill"}).jpeg({quality:88}).toBuffer();
    layers.push({input,left:gap+(i%cols)*(thumbW+gap),top:gap+Math.floor(i/cols)*(thumbH+gap)});
  }
  const output=path.join(reviewDir,name);
  await sharp({create:{width,height:canvasH,channels:3,background:"#d9d0c1"}}).composite(layers).jpeg({quality:92,mozjpeg:true}).toFile(output);
  return output;
}
const igSheet=await contactSheet(contactInputs.instagram,"instagram-contact-sheet.jpg",1350);
const fbSheet=await contactSheet(contactInputs.facebook,"facebook-contact-sheet.jpg",1080);

fs.writeFileSync(path.join(packDir,"instagram.json"),JSON.stringify({packageId:source.packageId,reviewStatus:"pending-owner",approvalGate,entries:platforms.instagram},null,2)+"\n");
fs.writeFileSync(path.join(packDir,"facebook.json"),JSON.stringify({packageId:source.packageId,reviewStatus:"pending-owner",approvalGate,entries:platforms.facebook},null,2)+"\n");

const tracked=[contentPath,path.join(packDir,"instagram.json"),path.join(packDir,"facebook.json"),...fs.readdirSync(captionsDir).sort().map(x=>path.join(captionsDir,x)),igSheet,fbSheet];
const supportingFiles=Object.fromEntries(tracked.map(p=>[rel(p),sha256(fs.readFileSync(p))]));
const manifest={
  version:1,
  packageId:source.packageId,
  reviewStatus:"pending-owner",
  approvalGate,
  start:"2026-10-05",
  end:"2026-10-11",
  postCountPerPlatform:7,
  totalCandidatePosts:14,
  time:source.time,
  timezone:source.timezone,
  platforms:["instagram","facebook"],
  contentPolicy:{pillar:"buyer/seller education",propertySpecific:false,listingClaims:false,priceClaims:false,forecastClaims:false,valuationOffers:false,staleEvents:false,adLicenceRequired:false},
  rights:source.rights,
  assets:assetRecords,
  captions:platforms.instagram.map(x=>({date:x.date,path:x.captionPath,sha256:supportingFiles[x.captionPath]})),
  previews:[rel(igSheet),rel(fbSheet)],
  supportingFiles
};
const manifestPath=path.join(packDir,"manifest.json");
fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n");
const manifestHash=sha256(fs.readFileSync(manifestPath));
const report=[
  `PACKAGE ${source.packageId}`,
  `STATE pending-owner`,
  approvalGate,
  `MANIFEST_SHA256 ${manifestHash}`,
  ...assetRecords.map(a=>`${a.sha256}  ${a.path}`),
  ...Object.entries(supportingFiles).sort(([a],[b])=>a.localeCompare(b)).map(([p,h])=>`${h}  ${p}`),
  ""
].join("\n");
fs.writeFileSync(path.join(packDir,"hash-report.txt"),report);
console.log(`Built ${source.packageId}: ${source.days.length} days, ${platforms.instagram.length} Instagram + ${platforms.facebook.length} Facebook candidates, ${assetRecords.length} JPEGs.`);
console.log(`Manifest SHA-256: ${manifestHash}`);
