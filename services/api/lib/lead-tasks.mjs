import { newId } from './db.mjs';
export const AUTO_REMINDERS = false;
export const TASK_KINDS = ['handoff', 'followup', 'viewing'];
const text = v => typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null;
const decode = row => row ? { ...row, details: JSON.parse(row.details) } : null;
export function cleanNeeds(input = {}) {
  const result = {};
  for (const key of ['budget', 'area', 'property_type', 'timeframe', 'financing', 'note']) {
    const value = text(input?.[key]); if (value) result[key] = value;
  }
  if (typeof input?.no_match === 'boolean') result.no_match = input.no_match;
  if (typeof input?.viewing_requested === 'boolean') result.viewing_requested = input.viewing_requested;
  return result;
}
export function tasksForLead(db, leadId) {
  return db.db.prepare('SELECT * FROM lead_tasks WHERE lead_id=? ORDER BY created DESC,task_id DESC').all(leadId).map(decode);
}
export function openTasks(db, { limit=100, offset=0 }={}) {
  return db.db.prepare("SELECT * FROM lead_tasks WHERE status IN ('open','requested','confirmed') ORDER BY CASE WHEN kind='handoff' THEN 0 ELSE 1 END,due_ts IS NULL,due_ts,created,task_id LIMIT ? OFFSET ?").all(Math.max(1,Math.min(500,limit)),Math.max(0,Math.floor(offset))).map(decode);
}
export function taskCounts(db, now=Date.now()) {
  const rows=db.db.prepare("SELECT kind,COUNT(*) count FROM lead_tasks WHERE status IN ('open','requested','confirmed') GROUP BY kind").all();
  return { ...Object.fromEntries(rows.map(r=>[r.kind,r.count])), overdue:db.db.prepare("SELECT COUNT(*) count FROM lead_tasks WHERE status IN ('open','requested','confirmed') AND due_ts < ?").get(now).count, automaticReminders:false, telegramConfigured:false };
}
export function addTask(db, { leadId, kind, source='owner', reason=null, details={}, dueTs=null, now=Date.now() }) {
  if (!TASK_KINDS.includes(kind) || !db.getLead(leadId)) throw new RangeError('Invalid task');
  if (dueTs !== null && (!Number.isSafeInteger(dueTs) || dueTs <= 0 || dueTs > 8.64e15)) throw new RangeError('Invalid task date');
  const taskId=newId('task');const status=kind==='viewing'?'requested':'open';
  db.db.prepare('INSERT INTO lead_tasks(task_id,lead_id,kind,source,reason,details,status,due_ts,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(taskId,leadId,kind,source,text(reason),JSON.stringify(cleanNeeds(details)),status,dueTs,now,now);
  return decode(db.db.prepare('SELECT * FROM lead_tasks WHERE task_id=?').get(taskId));
}
export function ensureHandoff(db, { leadId, source='dana', reason='buyer', details={}, now=Date.now() }) {
 return db.transaction(()=>{
  const lead=db.getLead(leadId);if(!lead)return null;
  const needs=cleanNeeds(details);
  const old=decode(db.db.prepare("SELECT * FROM lead_tasks WHERE lead_id=? AND kind='handoff' AND status='open'").get(leadId));
  let task;
  if(old){
   const merged={...old.details,...needs};
   db.db.prepare('UPDATE lead_tasks SET details=?,updated=? WHERE task_id=?').run(JSON.stringify(merged),now,old.task_id);
   task={...old,details:merged,updated:now};
  }else task=addTask(db,{leadId,kind:'handoff',source,reason,details:needs,now});
  const patch={};for(const [field,key] of [['budget','budget'],['district','area'],['interest','property_type'],['timeline','timeframe']])if(needs[key]&&lead[field]!==needs[key])patch[field]=needs[key];
  if(Object.keys(patch).length)db.updateLead(leadId,patch);
  if(needs.viewing_requested&&!db.db.prepare("SELECT task_id FROM lead_tasks WHERE lead_id=? AND kind='viewing' AND status IN ('requested','confirmed')").get(leadId))addTask(db,{leadId,kind:'viewing',source,reason:'Viewing requested; time not confirmed',details:needs,now});
  return task;
 });
}
export function updateTask(db, { leadId, taskId, status, actor, dueTs, now=Date.now() }) {
 const task=decode(db.db.prepare('SELECT * FROM lead_tasks WHERE lead_id=? AND task_id=?').get(leadId,taskId));
 if(!task)return null;
 const allowed=task.kind==='viewing'?['requested','confirmed','done','cancelled']:['open','done','cancelled'];
 if(!allowed.includes(status))throw new RangeError('Invalid task status');
 const due=dueTs===undefined?task.due_ts:dueTs;
 if(due!==null&&(!Number.isSafeInteger(due)||due<=0||due>8.64e15))throw new RangeError('Invalid task date');
 if(status==='confirmed'&&!due)throw new RangeError('A confirmed viewing needs a date and time');
 db.db.prepare('UPDATE lead_tasks SET status=?,due_ts=?,updated=?,done_by=? WHERE task_id=?').run(status,due,now,['done','cancelled'].includes(status)?text(actor):null,taskId);
 return decode(db.db.prepare('SELECT * FROM lead_tasks WHERE task_id=?').get(taskId));
}

/** Disabled by default. Route verification and enabling are deployment-review actions.
 * Never guesses a self-chat or a Telegram recipient and never retries an uncertain send. */
export function createHandoffNotifier({db, send=null, route=null, enabled=false}) {
 return async function notify(taskId) {
  if(!enabled||!send||route?.verified!==true||route?.platform!=='telegram'||!route?.chatId)return {status:'disabled'};
  const task=decode(db.db.prepare('SELECT * FROM lead_tasks WHERE task_id=?').get(taskId));
  if(!task||task.kind!=='handoff'||task.status!=='open')return {status:'skipped'};
  const changed=db.db.prepare("UPDATE lead_tasks SET telegram_status='pending' WHERE task_id=? AND kind='handoff' AND status='open' AND telegram_status='disabled'").run(taskId).changes;
  if(!changed)return {status:task.telegram_status};
  const lead=db.getLead(task.lead_id);
  try {
   const result=await send({route, leadId:lead.lead_id, source:lead.source, campaign:lead.campaign, listingId:lead.listing_id, needs:task.details, needsExternalSourcing:task.details.no_match===true});
   const status=result?.ok===true?'sent':'uncertain';db.db.prepare('UPDATE lead_tasks SET telegram_status=? WHERE task_id=?').run(status,taskId);return {status,attempted:true,...(status==='sent'&&result.messageId?{messageId:result.messageId}:{})};
  } catch { db.db.prepare("UPDATE lead_tasks SET telegram_status='uncertain' WHERE task_id=?").run(taskId);return {status:'uncertain',attempted:true}; }
 };
}

export function countOpenTasks(db) { return db.db.prepare("SELECT COUNT(*) n FROM lead_tasks WHERE status IN ('open','requested','confirmed')").get().n; }
