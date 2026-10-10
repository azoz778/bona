import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, anchor, clickOn } from './dom.mjs';
const tags={ga4:'G-TEST',metaPixel:'123',snapPixel:'123',tiktokPixel:'123'};
function boot(href,consent={v:1,analytics:true,ads:true}) {
 const d=makeWindow({href,consent,tags,listing:'BONA-001'});d.run('measurement.js');d.run('attribution.js');d.run('tags.js');return d;
}
test('local previews, dashboard and explicit test visits send no events or vendor requests',()=>{
 for(const href of ['http://localhost:4321/properties/x/','http://127.0.0.1:4321/','https://preview.example.test/','https://bona-real-estate.com/dashboard/','https://bona-real-estate.com/ar/dashboard/','https://bona-real-estate.com/?bona_test=1']){
  const d=boot(href);d.win.bonaTrack('form_submit');assert.equal(d.requests.length,0,href);assert.equal(d.injected.length,0,href);
 }
});
test('QA flag survives navigation and explicit clearing restores normal consent gates',()=>{
 const d=boot('https://bona-real-estate.com/?bona_test=1');
 d.win.location.search='';d.fire('astro:after-swap');d.fire('astro:page-load');assert.equal(d.requests.length,0);
 d.win.location.search='?bona_test=0';d.fire('astro:page-load');d.win.bonaTagsLoad();assert.ok(d.requests.length>0);assert.ok(d.injected.length>0);
});
test('real visits still record listing events; refusal still prevents vendor loading',()=>{
 const d=boot('https://bona-real-estate.com/properties/x/',{v:1,analytics:false,ads:false});
 assert.equal(d.requests.length,2);assert.equal(d.injected.length,0);
});
test('prefilled personal messages, phone links, free-form props and URL queries never enter browser event payloads',()=>{
 const d=boot('https://bona-real-estate.com/properties/x/?message=PRIVATE_QUERY');
 const a=anchor({'data-cta':'form_whatsapp'},{href:'https://wa.me/966500000000?text=PRIVATE_NAME%20PRIVATE_MESSAGE'});
 d.fire('click',clickOn(a));d.win.bonaTrack('form_submit',{form:'listing',name:'PRIVATE_NAME',phone:'PRIVATE_PHONE',message:'PRIVATE_MESSAGE',href:a.href});
 const json=JSON.stringify(d.requests);assert.doesNotMatch(json,/PRIVATE_(NAME|PHONE|MESSAGE|QUERY)/);
 assert.ok(JSON.parse(d.requests.at(-1).init.body).props.form==='listing');
 const ga=d.win.dataLayer.map(x=>Array.from(x));const page=ga.find(x=>x[0]==='event'&&x[1]==='page_view');
 assert.equal(page[2].page_location,'https://bona-real-estate.com/properties/x/');
});
