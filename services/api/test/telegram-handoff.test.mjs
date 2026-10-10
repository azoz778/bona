import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { ensureHandoff, tasksForLead } from '../lib/lead-tasks.mjs';
import { createTelegramSender, createTelegramHandoffs, SECRETARY_CHAT_ID, HERMES_BOT_ID, SECRETARY_ROUTE, handoffNote } from '../lib/telegram-handoff.mjs';
const token=HERMES_BOT_ID+':'+ 'synthetic_test_only_'.repeat(3);
const env={BONA_TELEGRAM_HANDOFFS:'1',BONA_TELEGRAM_CHAT_ID:SECRETARY_CHAT_ID,BONA_TELEGRAM_BOT_TOKEN:token};
const payload={route:SECRETARY_ROUTE,leadId:'LEAD-20261010-test',source:'google',campaign:'pilot',listingId:'BONA-001',needs:{budget:'6 million',area:'Riyadh',no_match:true},needsExternalSourcing:true};
const accepted=()=>new Response(JSON.stringify({ok:true,result:{message_id:123,chat:{id:Number(SECRETARY_CHAT_ID),type:'private'},from:{id:Number(HERMES_BOT_ID)}}}),{status:200});
function fixture(){const db=openDb(':memory:');db.insertLead({lead_id:payload.leadId,created:1,updated:1,stage:'new',phone_e164:'966500000000'});const task=ensureHandoff(db,{leadId:payload.leadId,details:payload.needs});return {db,task};}
test('Telegram requires an explicit enable, the verified private destination and the existing bot identity',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return accepted();};
 for(const settings of [{},{...env,BONA_TELEGRAM_HANDOFFS:'0'},{...env,BONA_TELEGRAM_CHAT_ID:'-1004434411806'},{...env,BONA_TELEGRAM_BOT_TOKEN:'9999999999:'+token.split(':')[1]},{...env,BONA_TELEGRAM_BOT_TOKEN:''}]){
  const s=createTelegramSender({env:settings,fetchImpl});assert.equal((await s.send(payload)).skipped,true);
 }
 assert.equal(calls,0);
});
test('Telegram uses one private send, no redirects, no topic, no markup, no visitor PII and a clean authenticated-dashboard URL',async()=>{
 let call;const sender=createTelegramSender({env,publicApi:'https://bona-api.azoz.uk/?token=do-not-copy',fetchImpl:async(url,init)=>{call={url,init};return accepted();}});
 const r=await sender.send({...payload,name:'Sensitive Name',phone:'0500000000',needs:{...payload.needs,note:'Private transcript'}});
 assert.equal(r.ok,true);assert.equal(r.messageId,'123');assert.equal(call.init.redirect,'error');
 const body=JSON.parse(call.init.body);assert.equal(body.chat_id,SECRETARY_CHAT_ID);assert.equal(body.message_thread_id,undefined);assert.equal(body.parse_mode,undefined);assert.equal(body.link_preview_options.is_disabled,true);
 assert.match(body.text,/6 million/);assert.match(body.text,/external sourcing/);assert.match(body.text,/https:\/\/bona-api.azoz.uk\/dashboard\/leads\/LEAD-/);assert.doesNotMatch(body.text,/Sensitive|0500000000|Private transcript|token=/);
});
test('an unverified payload route cannot override the private destination',async()=>{
 let calls=0;const s=createTelegramSender({env,fetchImpl:async()=>{calls++;return accepted();}});
 for(const route of [{...SECRETARY_ROUTE,chatId:'other'},{...SECRETARY_ROUTE,threadId:3},{...SECRETARY_ROUTE,platform:'slack'}])assert.equal((await s.send({...payload,route})).ok,false);
 assert.equal(calls,0);
});
test('HTTP success alone, a wrong destination or bot, and malformed replies are not provider acknowledgement',async()=>{
 for(const body of [{ok:false},{ok:true,result:{message_id:1,chat:{id:'wrong',type:'private'},from:{id:HERMES_BOT_ID}}},{ok:true,result:{message_id:1,chat:{id:SECRETARY_CHAT_ID,type:'private'},from:{id:'wrong'}}},{ok:true,result:{message_id:0,chat:{id:SECRETARY_CHAT_ID,type:'private'},from:{id:HERMES_BOT_ID}}}]){
  let calls=0;const s=createTelegramSender({env,fetchImpl:async()=>{calls++;return new Response(JSON.stringify(body));}});assert.equal((await s.send(payload)).ok,false);assert.equal(calls,1);
 }
});
test('timeouts and HTTP failures make exactly one attempt and do not expose token-bearing errors',async()=>{
 for(const fetchImpl of [async()=>new Response('{}',{status:502}),async()=>{throw Error('https://api.telegram.org/bot'+token+'/sendMessage');},async(_,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error(token))))]){
  let n=0;const s=createTelegramSender({env,timeoutMs:5,fetchImpl:async(...args)=>{n++;return fetchImpl(...args);}});const r=await s.send(payload);assert.deepEqual(r,{ok:false});assert.equal(n,1);assert.doesNotMatch(JSON.stringify(r),new RegExp(token));
 }
});
test('concurrent notifications claim one durable handoff and emit only accepted receipt metadata',async()=>{
 const {db,task}=fixture();try{
  let n=0;const logs=[];const h=createTelegramHandoffs({db,env,fetchImpl:async()=>{n++;await new Promise(r=>setTimeout(r,3));return accepted();},log:r=>logs.push(r)});
  await Promise.all([h.notifyLead(payload.leadId),h.notifyLead(payload.leadId)]);await h.notifyLead(payload.leadId);
  assert.equal(n,1);assert.equal(tasksForLead(db,payload.leadId)[0].telegram_status,'sent');assert.deepEqual(logs,[{evt:'handoff.telegram',taskId:task.task_id,status:'sent',messageId:'123'}]);
 }finally{db.close();}
});
test('uncertain sends are not replayed, and excluded/private contacts never leave Bona',async()=>{
 const {db}=fixture();try{
  let n=0;const h=createTelegramHandoffs({db,env,fetchImpl:async()=>{n++;throw Error('uncertain');}});
  const excluded=createTelegramHandoffs({db,env,fetchImpl:async()=>{throw Error('must not send');},isExcludedLead:()=>true});assert.equal((await excluded.notifyLead(payload.leadId)).status,'skipped');
  assert.equal((await h.notifyLead(payload.leadId)).status,'uncertain');assert.equal((await h.notifyLead(payload.leadId)).status,'uncertain');assert.equal(n,1);
 }finally{db.close();}
});
test('disabled startup does not drain old handoffs or schedule follow-up messages',async()=>{
 const {db}=fixture();try{let n=0;const h=createTelegramHandoffs({db,env:{},fetchImpl:async()=>{n++;}});assert.equal((await h.notifyLead(payload.leadId)).status,'disabled');assert.equal(n,0);assert.equal(tasksForLead(db,payload.leadId)[0].telegram_status,'disabled');}finally{db.close();}
});
test('notification formatting stays within Telegram limits and strips credentials from dashboard links',()=>{
 const needs=Object.fromEntries(['budget','area','property_type','timeframe','financing'].map(k=>[k,'x'.repeat(1000)]));const text=handoffNote({...payload,needs},'https://user:secret@example.test');assert.ok(text.length<=3900);assert.doesNotMatch(text,/secret|example.test/);
});
