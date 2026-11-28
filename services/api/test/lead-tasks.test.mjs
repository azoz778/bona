import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { ensureHandoff, tasksForLead, addTask, updateTask, taskCounts, createHandoffNotifier } from '../lib/lead-tasks.mjs';
import { handoffDetails } from '../lib/dana-wa.mjs';
import { leadTasksPanel, taskQueue } from '../lib/dashboard/render-tasks.mjs';
function fixture() {
 const db=openDb(':memory:');const id='LEAD-20261010-1234abcd';
 db.insertLead({lead_id:id,created:1,updated:1,stage:'new',phone_e164:'966500000000',source:'google',campaign:'bona_test'});
 return {db,id};
}
test('serious no-match buyers receive one durable handoff; missing needs stay unknown',()=>{
 const {db,id}=fixture();try{
  const a=ensureHandoff(db,{leadId:id,details:{no_match:true,budget:'Buyer stated budget',area:'Any GCC city'}});
  const b=ensureHandoff(db,{leadId:id,details:{property_type:'villa',timeframe:'This year'}});
  assert.equal(a.task_id,b.task_id);assert.equal(tasksForLead(db,id).length,1);assert.equal(b.details.no_match,true);
  assert.equal(db.getLead(id).district,'Any GCC city');assert.equal(db.getLead(id).timeline,'This year');
  assert.equal('financing' in b.details,false);assert.equal(db.getLead(id).stage,'new','not silently marked qualified');
 }finally{db.close();}
});
test('a viewing is only requested by the bot; only an owner action with a time confirms it',()=>{
 const {db,id}=fixture();try{
  ensureHandoff(db,{leadId:id,details:{viewing_requested:true}});ensureHandoff(db,{leadId:id,details:{viewing_requested:true}});
  const v=tasksForLead(db,id).filter(t=>t.kind==='viewing');assert.equal(v.length,1);assert.equal(v[0].status,'requested');
  assert.throws(()=>updateTask(db,{leadId:id,taskId:v[0].task_id,status:'confirmed',actor:'Owner'}));
  assert.equal(updateTask(db,{leadId:id,taskId:v[0].task_id,status:'confirmed',dueTs:1000000,actor:'Owner'}).status,'confirmed');
 }finally{db.close();}
});
test('due follow-up records do not send messages and an unverified Telegram route fails closed',async()=>{
 const {db,id}=fixture();try{
  addTask(db,{leadId:id,kind:'followup',dueTs:1});const h=ensureHandoff(db,{leadId:id});let calls=0;
  const notify=createHandoffNotifier({db,enabled:true,route:{platform:'telegram',chatId:'unverified'},send:async()=>{calls++;}});
  assert.equal((await notify(h.task_id)).status,'disabled');assert.equal(calls,0);assert.equal(taskCounts(db).automaticReminders,false);assert.equal(taskCounts(db).overdue,1);
 }finally{db.close();}
});
test('verified injected sender is once-only, and uncertainty is never blindly retried',async()=>{
 const {db,id}=fixture();try{
  const h=ensureHandoff(db,{leadId:id,details:{no_match:true}});let calls=0;
  const notify=createHandoffNotifier({db,enabled:true,route:{platform:'telegram',chatId:'test-only',verified:true},send:async payload=>{calls++;assert.equal(payload.needsExternalSourcing,true);throw Error('uncertain');}});
  assert.equal((await notify(h.task_id)).status,'uncertain');await notify(h.task_id);assert.equal(calls,1);
 }finally{db.close();}
});
test('handoff details come from the explicit tool, with strict boolean flags and no invented finance facts',()=>{
 const c={messages:[{role:'tool_call_invocation',name:'request_human',arguments:JSON.stringify({budget:'5m',no_match:true,viewing_requested:'true',phone:'private'})}]};
 assert.deepEqual(handoffDetails(c),{budget:'5m',no_match:true});assert.deepEqual(handoffDetails({messages:[{role:'agent',content:'no_match: true'}]}),{});
});
test('task UI escapes private details and exposes no mutation forms to staff',()=>{
 const task={task_id:'task-1',lead_id:'LEAD-20261010-1234abcd',kind:'handoff',status:'open',reason:'<script>x</script>',details:{area:'<img onerror=evil>'},telegram_status:'disabled'};
 const staff=leadTasksPanel(task.lead_id,[task],false);assert.doesNotMatch(staff,/<script>|<img|<form/);assert.match(staff,/&lt;img/);
 assert.match(leadTasksPanel(task.lead_id,[task],true),/Save task; do not send a message/);assert.match(taskQueue([task]),/Telegram: disabled/);
});


test('restart recovery marks uncertain sends without resending or losing handoff records',async()=>{
 const {recoverPendingNotifications}=await import('../lib/enquiry-receipt.mjs');const {db,id}=fixture();try{
  const task=ensureHandoff(db,{leadId:id});db.db.prepare("UPDATE lead_tasks SET telegram_status='pending' WHERE task_id=?").run(task.task_id);
  db.db.prepare("INSERT INTO enquiry_receipts VALUES('evt-recovery','private-hash',?,1,'pending')").run(id);
  assert.deepEqual(recoverPendingNotifications(db),{enquiries:1,handoffs:1});assert.deepEqual(recoverPendingNotifications(db),{enquiries:0,handoffs:0});
  assert.equal(tasksForLead(db,id)[0].telegram_status,'uncertain');assert.equal(db.db.prepare('SELECT notify_status FROM enquiry_receipts').get().notify_status,'uncertain');
 }finally{db.close();}
});



test('future tasks cannot hide new handoffs and every open task is reachable by pagination',async()=>{
 const {openTasks,countOpenTasks}=await import('../lib/lead-tasks.mjs');const {db,id}=fixture();try {
  for(let i=0;i<105;i++)addTask(db,{leadId:id,kind:'followup',dueTs:Date.now()+86400000+i});
  const h=ensureHandoff(db,{leadId:id});assert.equal(openTasks(db)[0].task_id,h.task_id);assert.equal(countOpenTasks(db),106);
  const first=openTasks(db),second=openTasks(db,{offset:100});assert.equal(first.length,100);assert.equal(second.length,6);assert.equal(new Set([...first,...second].map(t=>t.task_id)).size,106);
  assert.match(taskQueue(first,{total:106,page:0}),/106 open tasks/);assert.match(taskQueue(first,{total:106,page:0}),/tasks_page=1/);assert.match(taskQueue(second,{total:106,page:1}),/Previous/);
 }finally{db.close();}
});
test('owner task UI distinguishes unconfirmed notification from provider acceptance',()=>{
 const html=leadTasksPanel('lead',[],true,[{created:1,notify_status:'uncertain'},{created:2,notify_status:'sent'}]);
 assert.match(html,/check WhatsApp before resending/);assert.match(html,/not proof of delivery/);
});

/* ---------------- PR-B1 (PLAN T10 test 4; DESIGN §4.3, §8.3, §8.4) ---------------- */
const DAY_MS=86400000;

test('saveNeeds has its own allow-list onto the lead row (not cleanNeeds): each field lands, unknown keys are dropped, no hand-over', async () => {
 const {saveNeeds}=await import('../lib/lead-tasks.mjs');const {db,id}=fixture();try{
  const before=db.getLead(id);
  const out=saveNeeds(db,{leadId:id,now:5000,needs:{name:'Sara Example',interest:'Buy a family home',budget:'SAR 3-4m',district:'Al Shati',
   property_type:'villa',timeline:'within 3 months',listing_id:'bona-w012',phone:'+966500000099',stage:'won',notes:'private',viewing_requested:true,handler_user_id:'u-1'}});
  assert.equal(out.saved,true);
  const lead=db.getLead(id);
  assert.equal(lead.name,'Sara Example');
  assert.equal(lead.interest,'Buy a family home · villa','property_type lands on interest: the lead row has no column of its own');
  assert.equal(lead.budget,'SAR 3-4m');
  assert.equal(lead.district,'Al Shati');
  assert.equal(lead.timeline,'within 3 months');
  assert.equal(lead.listing_id,'BONA-W012');
  assert.equal(lead.phone_e164,before.phone_e164,'unknown keys are dropped');
  assert.equal(lead.stage,'new');assert.equal(lead.notes,null);assert.equal(lead.handler_user_id,null);
  assert.equal(tasksForLead(db,id).length,0,'saving needs is not a hand-over: no task');
  assert.deepEqual(out.fields.sort(),['budget','district','interest','listing_id','name','timeline']);
  // property_type alone: it lands on interest once, and again is a no-op.
  const {db:db2,id:id2}=fixture();try{
   saveNeeds(db2,{leadId:id2,needs:{property_type:'apartment'}});assert.equal(db2.getLead(id2).interest,'apartment');
   assert.equal(saveNeeds(db2,{leadId:id2,needs:{property_type:'Apartment'}}).saved,false,'already there');
   assert.equal(db2.getLead(id2).interest,'apartment');
  }finally{db2.close();}
 }finally{db.close();}
});
test('saveNeeds writes no name that is blank, emoji or one letter; a bad listing id or an unknown lead saves nothing',async()=>{
 const {saveNeeds,plausibleName}=await import('../lib/lead-tasks.mjs');const {db,id}=fixture();try{
  for(const bad of ['','   ','😀','😀😀','A','a.','1234567','Ahmed 0500000000',null,undefined,42,{},'x'.repeat(81)]){
   assert.equal(plausibleName(bad),false,String(bad));
   assert.deepEqual(saveNeeds(db,{leadId:id,needs:{name:bad}}),{saved:false,fields:[]},String(bad));
   assert.equal(db.getLead(id).name,null,String(bad));
  }
  for(const good of ['Mo','محمد','Sara Example','عبدالله بن محمد',"O'Neil"])assert.equal(plausibleName(good),true,good);
  assert.equal(saveNeeds(db,{leadId:id,needs:{listing_id:'W012; DROP'}}).saved,false);assert.equal(db.getLead(id).listing_id,null);
  assert.deepEqual(saveNeeds(db,{leadId:'LEAD-NOPE',needs:{name:'Sara'}}),{saved:false,fields:[]});
  assert.equal(saveNeeds(db,{leadId:id,needs:{budget:'  '}}).saved,false,'a blank value is not a value');
 }finally{db.close();}
});
test('bookViewing writes details {booking_id, listing_id, slot_start} directly and confirms the viewing task with its time',async()=>{
 const {bookViewing}=await import('../lib/lead-tasks.mjs');const {db,id}=fixture();try{
  ensureHandoff(db,{leadId:id,details:{viewing_requested:true,budget:'5m'}});
  const requested=tasksForLead(db,id).find(t=>t.kind==='viewing');assert.equal(requested.status,'requested');
  const due=Date.UTC(2026,11,6,7);
  const task=bookViewing(db,{leadId:id,bookingId:'bk-1',listingId:'BONA-W012',slotStart:'2026-12-06T10:00+03:00',dueTs:due,now:7000});
  assert.equal(task.task_id,requested.task_id,'the requested viewing becomes the booked one');
  assert.equal(task.status,'confirmed');assert.equal(task.due_ts,due);
  assert.equal(task.details.booking_id,'bk-1');assert.equal(task.details.listing_id,'BONA-W012');assert.equal(task.details.slot_start,'2026-12-06T10:00+03:00');
  assert.equal(task.details.budget,'5m','what was asked before stays');
  assert.equal(tasksForLead(db,id).filter(t=>t.kind==='viewing').length,1);
  // No requested task: a new confirmed one, nameless.
  const {db:db2,id:id2}=fixture();try{
   const t2=bookViewing(db2,{leadId:id2,bookingId:'bk-2',listingId:'BONA-001',slotStart:'2026-12-07T12:00+03:00',dueTs:due+DAY_MS,now:7000});
   assert.equal(t2.status,'confirmed');assert.equal(t2.source,'dana');assert.deepEqual(t2.details,{booking_id:'bk-2',listing_id:'BONA-001',slot_start:'2026-12-07T12:00+03:00'});
   assert.doesNotMatch(t2.reason,/Dana/);
  }finally{db2.close();}
 }finally{db.close();}
});
test("updateTask refuses a due_ts change on a calendar-booked task ('calendar_booked'); the same time, a status change and other tasks are fine",async()=>{
 const {bookViewing,CALENDAR_BOOKED}=await import('../lib/lead-tasks.mjs');const {db,id}=fixture();try{
  const due=Date.UTC(2026,11,6,7);
  const t=bookViewing(db,{leadId:id,bookingId:'bk-1',listingId:'BONA-W012',slotStart:'2026-12-06T10:00+03:00',dueTs:due,now:1});
  assert.equal(CALENDAR_BOOKED,'calendar_booked');
  assert.throws(()=>updateTask(db,{leadId:id,taskId:t.task_id,status:'confirmed',dueTs:due+3600000,actor:'Owner'}),e=>e instanceof RangeError&&e.code==='calendar_booked');
  assert.equal(tasksForLead(db,id)[0].due_ts,due,'unchanged');
  assert.equal(updateTask(db,{leadId:id,taskId:t.task_id,status:'confirmed',dueTs:due,actor:'Owner'}).status,'confirmed','the same time is no move');
  assert.equal(updateTask(db,{leadId:id,taskId:t.task_id,status:'confirmed',actor:'Owner'}).due_ts,due,'no time given is no move');
  const cancelled=updateTask(db,{leadId:id,taskId:t.task_id,status:'cancelled',actor:'Owner'});
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.details.booking_id,'bk-1','the hook gets the booking id');
  const other=addTask(db,{leadId:id,kind:'viewing',dueTs:due});
  assert.equal(updateTask(db,{leadId:id,taskId:other.task_id,status:'confirmed',dueTs:due+3600000,actor:'Owner'}).due_ts,due+3600000);
 }finally{db.close();}
});
test('the calendar moves and cancels a booked task itself (moveBookedViewing / cancelBookedViewing), past the guard',async()=>{
 const {bookViewing,moveBookedViewing,cancelBookedViewing}=await import('../lib/lead-tasks.mjs');const {db,id}=fixture();try{
  const due=Date.UTC(2026,11,6,7);
  const t=bookViewing(db,{leadId:id,bookingId:'bk-1',listingId:'BONA-W012',slotStart:'2026-12-06T10:00+03:00',dueTs:due,now:1});
  assert.equal(moveBookedViewing(db,{taskId:t.task_id,bookingId:'bk-1',dueTs:due+DAY_MS,now:2}),true);
  assert.equal(tasksForLead(db,id)[0].due_ts,due+DAY_MS);
  assert.equal(moveBookedViewing(db,{taskId:t.task_id,bookingId:'bk-other',dueTs:due,now:3}),false,'only the task of that booking');
  assert.equal(cancelBookedViewing(db,{taskId:t.task_id,bookingId:'bk-1',now:4}),true);
  assert.equal(tasksForLead(db,id)[0].status,'cancelled');
  assert.equal(cancelBookedViewing(db,{taskId:t.task_id,bookingId:'bk-1',now:5}),false,'already cancelled');
 }finally{db.close();}
});
