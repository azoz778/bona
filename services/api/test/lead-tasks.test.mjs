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
