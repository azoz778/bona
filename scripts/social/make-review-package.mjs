import { C, sharp, text, wordmark } from "./lib/brand.mjs";
import fs from "node:fs";
import path from "node:path";
const out=path.resolve(process.argv[2] || "marketing/quality-review");
fs.mkdirSync(out,{recursive:true});
const slides=[
 {ar:"قبل أن تختار\nمنزلك في أبحر",en:"Before you choose a home\nin North Obhur",intro:"ثلاثة أمور اختبرها بنفسك في المعاينة",sub:"Three checks to make at your viewing",rows:[["المسار اليومي","Your daily route"],["الضوء والخصوصية","Light & privacy"],["الإطلالة والوصول","View & access"]]},
 {ar:"ابدأ برحلتك اليومية",en:"Start with your daily route",rows:[["جرّب الطريق في وقت خروجك المعتاد","Drive the route at your usual departure time."],["سجّل وقت الذهاب والعودة كلّاً على حدة","Record the outbound and return journey separately."],["تفقّد مدخل الشارع والمواقف عند العودة مساءً","Check street access and parking on an evening visit."]],note:"اكتب الوقت الفعلي؛ لا تعتمد على تقدير خارج وقت الذروة.",noteEn:"Write down actual times, not an off-peak estimate."},
 {ar:"عُد في وقت مختلف",en:"See it in a different light",rows:[["قف في غرفة المعيشة صباحاً وبعد الظهر","Check the living room in the morning and afternoon."],["افتح الستائر وتفقّد الخصوصية من النوافذ","Open the curtains and check privacy from the windows."],["استمع لضوضاء الشارع مع النوافذ مغلقة ومفتوحة","Listen to street noise with windows closed, then open."]],note:"دوّن ما شاهدته في كل زيارة قبل مقارنة الخيارات.",noteEn:"Keep notes from each visit before comparing homes."},
 {ar:"إطلالة أم وصول؟",en:"A view, or access?",rows:[["حدّد الغرفة التي تظهر منها الإطلالة","Identify the room from which the view is visible."],["تحقّق من وجود طريق فعلي للوصول إلى الماء","Check whether there is a physical route to the water."],["اطلب مستنداً لأي حق وصول خاص يُذكر لك","Request documents for any claimed private access right."]],note:"الإطلالة لا تعني تلقائياً حق استخدام الشاطئ.",noteEn:"A water view does not establish a right to use the beach."}
];
const bounds=[];
async function render(s,index,h,name){
 const w=1080,pad=82,cw=916,story=h===1920,layers=[];
 const dark=index===0,bg=dark?C.ink:C.ivory,fg=dark?C.ivory:C.ink,muted=dark?C.sand:C.stone2;
 async function block(body,{y,size=40,ar=true,color=fg,width=cw,x=pad,face}={}){
  const r=await text({text:body,face:face||(ar?"ar-body":"en-body"),size,color,width,align:"right",dir:ar?"rtl":"ltr",lineHeight:1.25});
  const left=x+width-r.width;
  if(y<0||y+r.height>h-(story?250:60)||left<0||left+r.width>w)throw new Error(`Overflow ${name}: ${body}`);
  layers.push({input:r.data,left:Math.round(left),top:Math.round(y)});bounds.push({file:name,text:body,left,top:y,width:r.width,height:r.height});return y+r.height;
 }
 function svg(data){layers.push({input:Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${data}</svg>`),left:0,top:0})}
 const top=story?260:65;
 const mark=await wordmark({size:45,color:fg,arabic:false});layers.push({input:mark.data,left:pad,top});
 await block("بونا  /  دليل المعاينة",{y:top+9,size:24,width:500,x:498,color:muted});
 svg(`<line x1="82" y1="${top+85}" x2="998" y2="${top+85}" stroke="${C.champagne}" stroke-width="2"/>`);
 let y=top+130;
 y=await block(s.ar,{y,size:dark?(h===1080?64:76):(h===1080?64:78)});
 y=await block(s.en,{y:y+25,size:dark?40:32,ar:false,face:"en-display",color:muted});
 y+=dark?45:40;
 if(s.intro && h!==1080){y=await block(s.intro,{y,size:32});y=await block(s.sub,{y:y+14,size:25,ar:false,color:muted});y+=35}
 for(const [i,[ar,en]]of s.rows.entries()){
  const ry=y;
  svg(`<rect x="946" y="${ry+4}" width="52" height="52" rx="26" fill="${dark?C.ink3:C.ivory2}"/>`);
  await block(String(i+1).padStart(2,"0"),{y:ry+16,size:22,ar:false,x:958,width:40,color:dark?C.champagne2:C.stone2});
  y=await block(ar,{y:ry,size:dark?36:(h===1080?36:44),width:822});
  y=await block(en,{y:y+15,size:h===1080?26:30,ar:false,width:822,color:muted});
  y+=h===1080?44:65;
 }
 if(s.note&&h!==1080){y+=10;svg(`<line x1="82" y1="${y}" x2="998" y2="${y}" stroke="${C.champagne}" stroke-width="1"/>`);y=await block(s.note,{y:y+24,size:30});y=await block(s.noteEn,{y:y+16,size:23,ar:false,color:muted})}
 const footer=story?1530:h-94;
 if(y>footer-25)throw new Error(`Footer collision ${name}: ${y}`);
 await block(story ? "BONA  •  NORTH OBHUR  /  VIEWING CHECKLIST" : `BONA  •  NORTH OBHUR   /   ${index+1} — 4`,{y:footer,size:21,ar:false,color:muted});
 await sharp({create:{width:w,height:h,channels:3,background:bg}}).composite(layers).jpeg({quality:95,mozjpeg:true}).toFile(path.join(out,name));
}
for(const [i,s]of slides.entries()){await render(s,i,1350,`instagram-${i+1}.jpg`);await render(s,i,1080,`facebook-${i+1}.jpg`)}
await render({...slides[0],ar:"معاينة في أبحر؟\nاحفظ هذه القائمة",en:"Viewing in North Obhur?\nKeep this checklist"},0,1920,"story.jpg");
const caption={ar:"قبل المعاينة في أبحر الشمالية، جهّز ملاحظاتك عن ثلاثة أمور: الطريق الذي ستستخدمه كل يوم، الضوء والخصوصية داخل المنزل، وما تعنيه الإطلالة فعلياً.\n\nجرّب المسار في وقت خروجك، وعُد في وقت مختلف. وإذا ذُكر لك وصول خاص إلى الماء، اطلب مستنده.\n\nاحفظ القائمة للزيارة القادمة. أي نقطة تبدأ بها عادةً؟",en:"Before a viewing in North Obhur, prepare notes on your daily route, light and privacy, and what the view actually includes.\n\nTest your usual journey and return at a different time. If private waterfront access is claimed, request the supporting documents.\n\nSave this checklist for your next viewing. Which check do you start with?"};
fs.writeFileSync(path.join(out,"captions.txt"),`${caption.ar}\n\n${caption.en}\n\n#بونا #أبحر_الشمالية #NorthObhur\n`);
fs.writeFileSync(path.join(out,"manifest.json"),JSON.stringify({reviewStatus:"pending",purpose:"Owner approval only. No publication or automatic scheduling.",source:"Original viewing checklist. No property, travel-time, price or access claims. No location photo or synthetic property image.",platforms:{instagram:{format:"carousel",assets:slides.map((_,i)=>`instagram-${i+1}.jpg`)},facebook:{format:"photos",assets:slides.map((_,i)=>`facebook-${i+1}.jpg`)},story:{assets:["story.jpg"],note:"Burned copy; requires no caption or interactive sticker."}},caption},null,2));
fs.writeFileSync(path.join(out,"layout-checks.json"),JSON.stringify(bounds,null,2));
console.log(`Rendered 9 approval-only assets; ${bounds.length} text bounds checked.`);

