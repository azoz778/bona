import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnquirySubmitter } from '../../src/lib/enquiry-client.mjs';

const fields = { name: 'Local Test', phone: '0500000000', message: 'Viewing request', form: 'listing', listing_id: 'BONA-001' };
const accepted = () => ({ ok: true, json: async () => ({ lead_id: 'LEAD-20261010-1234abcd' }) });
function setup(fetchImpl, timeoutMs) {
  let ids=0;
  return createEnquirySubmitter({ api: 'https://api.example.test', fetchImpl, timeoutMs, eventId: () => `test-request-${++ids}` });
}
test('only an acknowledged lead is accepted and repeat clicks are not posted twice', async () => {
  const calls=[]; const submit=setup(async (url,init)=>{ calls.push({url,init}); return accepted(); });
  const first=await submit(fields); const second=await submit(fields);
  assert.equal(first.ok,true); assert.equal(second.duplicate,true); assert.equal(calls.length,1);
  assert.equal(calls[0].init.credentials,'omit'); assert.equal(calls[0].init.headers['content-type'],'text/plain');
  await submit({...fields,message:'A different question'}); assert.equal(calls.length,2);
  assert.notEqual(JSON.parse(calls[0].init.body).event_id,JSON.parse(calls[1].init.body).event_id);
});
test('a failed or timed-out attempt retries the SAME id, even if attribution changes', async () => {
  const bodies=[]; const submit=setup(async (_url,init)=>{ bodies.push(JSON.parse(init.body)); if(bodies.length===1)throw Error('network');return accepted(); });
  assert.equal((await submit(fields,{attr:{ref:'ABCDEF'}})).ok,false);
  assert.equal((await submit(fields,{attr:{ref:'UVWXYZ'}})).ok,true);
  assert.equal(bodies[0].event_id,bodies[1].event_id);
});
test('a 2xx without a valid receipt, malformed JSON and HTTP failures are never success', async () => {
  for(const response of [{ok:true,json:async()=>({})},{ok:true,json:async()=>{throw Error('JSON');}},{ok:false,status:503},{ok:false,status:429}]) {
    const result=await setup(async()=>response)(fields);assert.equal(result.ok,false);
  }
});
test('a second submit is blocked while the first request is outstanding',async()=>{
  let resolve;const submit=setup(()=>new Promise(r=>{resolve=r;}));const first=submit(fields);
  assert.equal((await submit(fields)).reason,'busy');resolve(accepted());assert.equal((await first).ok,true);
});
test('timeouts return recoverable failure and an absent API makes no request',async()=>{
  const submit=setup((_url,{signal})=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Error('abort')))),5);
  assert.equal((await submit(fields)).reason,'timeout');
  const disabled=createEnquirySubmitter({api:'',eventId:()=> 'test-no-api',fetchImpl:()=>{throw Error('must not call');}});
  assert.equal((await disabled(fields)).reason,'unavailable');
});
