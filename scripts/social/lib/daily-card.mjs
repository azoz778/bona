import {C,sharp,text,wordmark} from "./brand.mjs";
import path from "node:path";
export async function renderCard(s,index,h,name,out,bounds=[]){
 const w=1080,pad=82,cw=916,story=h===1920,layers=[];
 const dark=s.dark ?? index===0,bg=dark?C.ink:C.ivory,fg=dark?C.ivory:C.ink,muted=dark?C.sand:C.stone2;
 async function block(body,{y,size=40,ar=true,color=fg,width=cw,x=pad,face}={}){
  const r=await text({text:body,face:face||(ar?"ar-body":"en-body"),size,color,width,align:"right",dir:ar?"rtl":"ltr",lineHeight:1.25});
  const left=x+width-r.width;
  if(y<0||y+r.height>h-(story?250:60)||left<0||left+r.width>w)throw new Error(`Overflow ${name}: ${body}`);
  layers.push({input:r.data,left:Math.round(left),top:Math.round(y)});bounds.push({file:name,text:body,left,top:y,width:r.width,height:r.height});return y+r.height;
 }
 function svg(data){layers.push({input:Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${data}</svg>`),left:0,top:0})}
 const top=story?260:65;
 const mark=await wordmark({size:45,color:fg,arabic:false});layers.push({input:mark.data,left:pad,top});
 await block(s.seriesAr || "بونا  /  دليل المعاينة",{y:top+9,size:24,width:500,x:498,color:muted});
 svg(`<line x1="82" y1="${top+85}" x2="998" y2="${top+85}" stroke="${C.champagne}" stroke-width="2"/>`);
 let y=top+130;
 y=await block(s.ar,{y,size:dark?(h===1080?64:76):(h===1080?64:78)});
 y=await block(s.en,{y:y+25,size:dark?40:32,ar:false,face:"en-display",color:muted});
 y+=dark?45:40;
 if(s.intro && h!==1080){y=await block(s.intro,{y,size:32});y=await block(s.sub,{y:y+14,size:25,ar:false,color:muted});y+=35}
 for(const [i,[ar,en]]of s.rows.entries()){
  const ry=y;
  svg(`<rect x="946" y="${ry+4}" width="52" height="52" rx="26" fill="${dark?C.ink3:C.ivory2}"/>`);
  await block(String(i+1).padStart(2,"0"),{y:ry+16,size:22,ar:false,x:948,width:38,color:dark?C.champagne2:C.stone2});
  y=await block(ar,{y:ry,size:dark?36:(h===1080?40:44),width:822});
  y=await block(en,{y:y+15,size:30,ar:false,width:822,color:muted});
  y+=h===1080?40:65;
 }
 if(s.note&&h!==1080){y+=10;svg(`<line x1="82" y1="${y}" x2="998" y2="${y}" stroke="${C.champagne}" stroke-width="1"/>`);y=await block(s.note,{y:y+24,size:30});y=await block(s.noteEn,{y:y+16,size:23,ar:false,color:muted})}
 const footer=story?1530:h-94;
 if(y>footer-25)throw new Error(`Footer collision ${name}: ${y}`);
 await block(`BONA  /  ${s.seriesEn || "VIEWING NOTES"}  /  ${index+1} — ${s.count || 1}`,{y:footer,size:21,ar:false,color:muted});
 await sharp({create:{width:w,height:h,channels:3,background:bg}}).composite(layers).jpeg({quality:95,mozjpeg:true}).toFile(path.join(out,name));
}
