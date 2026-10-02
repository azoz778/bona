#!/usr/bin/env node
// Draft packaging only. Original JPEG bytes are preserved; nothing is uploaded/published.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { imageUrl,fingerprint,advertiserFingerprint,sha256,propertyCaption,eligibility } from './lib/property-daily.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [id,output,selection]=process.argv.slice(2);
if(!id || !output || !/^\d+(,\d+){2,5}$/.test(selection ?? ''))throw new Error('Usage: build-property-preview.mjs BONA-ID NEW_OUTPUT_DIR 3,6,4');
const out=path.resolve(output);
if(fs.existsSync(out))throw new Error('Choose a new output directory; existing previews are preserved');
const listing=JSON.parse(fs.readFileSync(path.join(root,'src/data/listings.json'),'utf8')).find(p=>p.id===id);
if(!listing)throw new Error('Listing not found');
const site=JSON.parse(fs.readFileSync(path.join(root,'src/data/site.json'),'utf8'));
const advertiser={...site.advertiser,phone:site.phone.e164};
const photos=[];fs.mkdirSync(out,{recursive:true});
for(const [n,index] of selection.split(',').map(x=>Number(x)-1).entries()) {
  const source=listing.images[index];if(!source)throw new Error('Image selection out of bounds');
  const url=imageUrl(source.src);
  const res=await fetch(url,{redirect:'error',headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)});
  if(!res.ok || !res.headers.get('content-type')?.startsWith('image/jpeg'))throw new Error('Source photo unavailable');
  const bytes=Buffer.from(await res.arrayBuffer());if(bytes.length>8000000)throw new Error('Source photo exceeds platform limit');
  const meta=await sharp(bytes).metadata();
  if(meta.width<1080||meta.height<720||meta.width/meta.height<0.8||meta.width/meta.height>1.91)throw new Error('Photo cannot be used uncropped at adequate resolution');
  const file=`photo-${n+1}.jpg`;fs.writeFileSync(path.join(out,file),bytes);
  photos.push({file,url,sha256:sha256(bytes),width:meta.width,height:meta.height,kind:'unreviewed',visuallyApproved:false,alt:source.alt});
}
const caption=propertyCaption(listing,advertiser);
const review={status:'draft',factsSha256:fingerprint(listing),advertiserSha256:advertiserFingerprint(advertiser),captionSha256:sha256(JSON.stringify(caption)),photos,licenceEvidence:null};
const block=eligibility(listing,review,advertiser);
fs.writeFileSync(path.join(out,'draft.json'),JSON.stringify({listingId:id,review,caption,blocked:block,sourcePage:`https://bona-real-estate.com/properties/${listing.slug}/`},null,2)+'\n');
fs.writeFileSync(path.join(out,'instagram-caption.txt'),caption.ar+'\n\n—\n\n'+caption.en+'\n');
fs.writeFileSync(path.join(out,'facebook-caption.txt'),caption.ar+'\n\n'+caption.en+'\n');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cards=photos.map((p,i)=>`<figure><img src="${p.file}" alt="${esc(p.alt.ar)}"><figcaption dir="rtl">${esc(p.alt.ar)}<span dir="ltr">${i+1} / ${photos.length}</span></figcaption></figure>`).join('');
fs.writeFileSync(path.join(out,'preview.html'),`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BONA — ${esc(id)} — Private draft</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f1ea;color:#0f1214;font:18px/1.65 Arial,sans-serif}header,main{max-width:1080px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #c8a96a}.brand{font-family:Georgia,serif;font-size:32px;letter-spacing:5px}small{color:#6f6a62}.note{background:#ede7dc;padding:14px 20px;border-right:3px solid #c8a96a}figure{margin:26px 0;background:#fff}img{display:block;width:100%;height:auto}figcaption{padding:10px 18px;font-size:15px;display:flex;justify-content:space-between;gap:15px}.caption{background:white;padding:24px;white-space:pre-wrap;overflow-wrap:anywhere}.en{font-size:16px}h1{font-size:28px}h2{font-size:19px;font-weight:400}@media(max-width:600px){header,main{padding:16px}h1{font-size:24px}.caption{padding:18px}}</style><header><div class="brand" dir="ltr">BONA</div><small>معاينة خاصة — غير منشورة</small></header><main><h1>${esc(listing.title.ar)}</h1><div class="note">مسودة للمراجعة. النشر متوقف حتى توثيق رخصة الإعلان وصلاحية التسويق. الصور الأصلية محفوظة دون قص أو تعديل.</div>${cards}<h2>Instagram / Facebook — النص المقترح</h2><div class="caption" dir="rtl">${esc(caption.ar)}</div><div class="caption en" dir="ltr">${esc(caption.en)}</div><p dir="ltr"><small>Source: ${esc(id)} · Original photography · No post has been sent.</small></p></main></html>`);
console.log(JSON.stringify({out,listingId:id,photos:photos.map(p=>({file:p.file,width:p.width,height:p.height})),blocked:block}));
