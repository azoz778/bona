import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {renderCard} from "./lib/daily-card.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const dir=path.join(root,"marketing/daily");
const content=JSON.parse(fs.readFileSync(path.join(dir,"content.json"),"utf8"));
const batch="daily-"+content[0].date.replaceAll("-","");
const assetDir=path.join(root,"public/social",batch);
fs.mkdirSync(assetDir,{recursive:true});
const bounds=[],ig=[],fb=[],files={};
const hash=b=>crypto.createHash("sha256").update(b).digest("hex");
for(const day of content){
 const assets={ig:[],fb:[]};
 for(const [i,slide] of day.slides.entries())for(const [platform,h] of [["ig",1350],["fb",1080]]){
  const file=`${day.date}-${platform}-${i+1}.jpg`;
  await renderCard({...slide,dark:slide.dark ?? false,count:day.slides.length,seriesAr:"بونا  /  ملاحظات عقارية",seriesEn:"PROPERTY NOTES"},i,h,file,assetDir,bounds);
  const rel=`public/social/${batch}/${file}`;files[rel]=hash(fs.readFileSync(path.join(root,rel)));assets[platform].push(rel);
 }
 const shared={date:day.date,time:"20:30",topic:day.topic,caption:day.caption,hashtags:["#بونا","#عقارات_جدة"],reviewStatus:"approved",pillar:"buyer/seller education",blocked:false,adLicenceRequired:false};
 ig.push({...shared,id:`bona-daily-ig-${day.date}`,platform:"instagram",format:assets.ig.length>1?"carousel":"post",images:assets.ig.map(x=>"https://bona-real-estate.com/"+x.replace(/^public\//,"")),alt:{ar:day.topic.ar,en:day.topic.en},status:"planned"});
 fb.push({...shared,id:`bona-daily-fb-${day.date}`,platform:"facebook",format:assets.fb.length>1?"carousel":"image",assets:assets.fb,assetsJpg:assets.fb});
}
for(const [name,data]of [["instagram.json",ig],["facebook.json",{entries:fb}],["layout-checks.json",bounds]])fs.writeFileSync(path.join(dir,name),JSON.stringify(data,null,2)+"\n");
for(const name of ["content.json","instagram.json","facebook.json"])files[`marketing/daily/${name}`]=hash(fs.readFileSync(path.join(dir,name)));
const calendarPath=path.join(root,"src/data/content-calendar.json");
const history=JSON.parse(fs.readFileSync(calendarPath,"utf8")).filter(e=>e.status==="published"&&!e.id.startsWith("bona-daily-"));
fs.writeFileSync(calendarPath,JSON.stringify([...history,...ig],null,2)+"\n");
const manifest={version:1,batch,start:content[0].date,end:content.at(-1).date,time:"20:30",timezone:"Asia/Riyadh",missedSlot:"Skip after 23:00 KSA; never backfill or recycle.",artwork:"Original typographic checklists only; no property photography.",files};
fs.writeFileSync(path.join(dir,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
console.log(`Rendered ${Object.keys(files).length-3} JPEGs; ${ig.length} daily posts per channel. Requires matching release receipt before live use.`);
