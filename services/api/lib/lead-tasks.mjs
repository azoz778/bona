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
/** updateTask's error for a moved calendar-booked viewing: the calendar is the source of truth (DESIGN §3.3, §8.4). */
export const CALENDAR_BOOKED = 'calendar_booked';
export function updateTask(db, { leadId, taskId, status, actor, dueTs, now=Date.now() }) {
 const task=decode(db.db.prepare('SELECT * FROM lead_tasks WHERE lead_id=? AND task_id=?').get(leadId,taskId));
 if(!task)return null;
 // A viewing booked on the calendar moves in Google Calendar only; the daily reconcile brings the
 // new time back here (moveBookedViewing). A status change (cancel, done) stays the owner's.
 if(task.details?.booking_id&&dueTs!==undefined&&dueTs!==task.due_ts)throw Object.assign(new RangeError(CALENDAR_BOOKED),{code:CALENDAR_BOOKED});
 const allowed=task.kind==='viewing'?['requested','confirmed','done','cancelled']:['open','done','cancelled'];
 if(!allowed.includes(status))throw new RangeError('Invalid task status');
 const due=dueTs===undefined?task.due_ts:dueTs;
 if(due!==null&&(!Number.isSafeInteger(due)||due<=0||due>8.64e15))throw new RangeError('Invalid task date');
 if(status==='confirmed'&&!due)throw new RangeError('A confirmed viewing needs a date and time');
 db.db.prepare('UPDATE lead_tasks SET status=?,due_ts=?,updated=?,done_by=? WHERE task_id=?').run(status,due,now,['done','cancelled'].includes(status)?text(actor):null,taskId);
 return decode(db.db.prepare('SELECT * FROM lead_tasks WHERE task_id=?').get(taskId));
}

/* ------------------------------------------------------------------ */
/* The assistant's needs and its calendar bookings (PR-B1; DESIGN §4.3, §8.3, §8.4) */
/* ------------------------------------------------------------------ */

/** Listing ids as listings.json has them (BONA-001, BONA-W012). */
const LISTING_ID_RE = /^BONA-W?\d{3,4}$/;
const letters = (v) => (v.match(/\p{L}/gu) ?? []).length;
/**
 * A name worth writing on a lead and in a calendar event: at least 2 letters, at most 80
 * characters, and not a phone number in disguise (5 or more digits). Blank, an emoji or one
 * letter is not a name (DESIGN §4.1: the assistant asks for it in the slot bubble then).
 */
export function plausibleName(v) {
 if(typeof v!=='string')return false;
 const s=v.trim();
 return s.length>0&&s.length<=80&&letters(s)>=2&&(s.match(/\d/g)??[]).length<5;
}
const oneLine = (v, max) => typeof v === 'string' && v.trim() ? v.replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0, max) : null;
const fold = (v) => String(v ?? '').toLowerCase();

/**
 * save_needs (DESIGN §4.3): what the client said they want, straight onto the lead row, through
 * its own allow-list. NOT cleanNeeds, which keeps only the hand-over keys and would drop the name.
 * name, interest, budget, district, timeline and listing_id each land on their column;
 * property_type has no column of its own, so it lands on `interest`, as ensureHandoff already
 * does (added once, never twice). Unknown keys are dropped. No hand-over, no task, no send.
 * @returns {{ saved: boolean, fields: string[] }}  the lead columns that changed
 */
export function saveNeeds(db, { leadId, needs = {}, now = Date.now() }) {
 return db.transaction(()=>{
  const lead=db.getLead(leadId);if(!lead)return {saved:false,fields:[]};
  const patch={};
  const set=(col,value)=>{if(value!==null&&value!==undefined&&value!==lead[col])patch[col]=value;};
  if(plausibleName(needs?.name))set('name',oneLine(needs.name,200));
  for(const col of ['budget','district','timeline'])set(col,oneLine(needs?.[col],200));
  const listing=oneLine(needs?.listing_id,20)?.toUpperCase()??null;
  if(listing&&LISTING_ID_RE.test(listing))set('listing_id',listing);
  let interest=oneLine(needs?.interest,500)??lead.interest??null;
  const type=oneLine(needs?.property_type,100);
  if(type&&!fold(interest).includes(fold(type)))interest=interest?`${interest} · ${type}`.slice(0,500):type;
  set('interest',interest);
  const fields=Object.keys(patch);
  if(!fields.length)return {saved:false,fields:[]};
  db.updateLead(leadId,{...patch,updated:now});
  return {saved:true,fields};
 });
}

/**
 * A viewing booked on the calendar (DESIGN §8.3 step 7): the lead's requested viewing task (or a
 * new one) becomes `confirmed` at the slot's time, and its details get
 * `{ booking_id, listing_id, slot_start }`, written directly (cleanNeeds would strip them). What
 * the requested task already held stays.
 */
export function bookViewing(db, { leadId, bookingId, listingId, slotStart, dueTs, source = 'dana', now = Date.now() }) {
 if(!Number.isSafeInteger(dueTs)||dueTs<=0)throw new RangeError('Invalid task date');
 return db.transaction(()=>{
  if(!db.getLead(leadId))throw new RangeError('Invalid task');
  const keys={booking_id:String(bookingId),listing_id:String(listingId),slot_start:String(slotStart)};
  const open=decode(db.db.prepare("SELECT * FROM lead_tasks WHERE lead_id=? AND kind='viewing' AND status='requested' ORDER BY created DESC,task_id DESC LIMIT 1").get(leadId));
  if(open){
   db.db.prepare("UPDATE lead_tasks SET status='confirmed',due_ts=?,details=?,updated=? WHERE task_id=?").run(dueTs,JSON.stringify({...open.details,...keys}),now,open.task_id);
   return decode(db.db.prepare('SELECT * FROM lead_tasks WHERE task_id=?').get(open.task_id));
  }
  const taskId=newId('task');
  db.db.prepare("INSERT INTO lead_tasks(task_id,lead_id,kind,source,reason,details,status,due_ts,created,updated) VALUES(?,?,'viewing',?,?,?,'confirmed',?,?,?)")
   .run(taskId,leadId,text(source)??'dana','Viewing booked in the calendar by the AI assistant',JSON.stringify(keys),dueTs,now,now);
  return decode(db.db.prepare('SELECT * FROM lead_tasks WHERE task_id=?').get(taskId));
 });
}

const bookedTask = (db, taskId, bookingId) => {
 const task=decode(db.db.prepare('SELECT * FROM lead_tasks WHERE task_id=?').get(String(taskId??'')));
 return task&&task.kind==='viewing'&&task.details?.booking_id===String(bookingId)?task:null;
};

/** The calendar moved a booked viewing (the daily reconcile): its task follows, past updateTask's guard. */
export function moveBookedViewing(db, { taskId, bookingId, dueTs, now = Date.now() }) {
 if(!Number.isSafeInteger(dueTs)||dueTs<=0)return false;
 const task=bookedTask(db,taskId,bookingId);
 if(!task||!['requested','confirmed'].includes(task.status)||task.due_ts===dueTs)return false;
 return db.db.prepare('UPDATE lead_tasks SET due_ts=?,updated=? WHERE task_id=?').run(dueTs,now,task.task_id).changes===1;
}

/** A booked viewing that is cancelled (by the calendar, a purge or a lead leaving): its open task is cancelled too. */
export function cancelBookedViewing(db, { taskId, bookingId, now = Date.now(), actor = 'Calendar' }) {
 const task=bookedTask(db,taskId,bookingId);
 if(!task||!['requested','confirmed'].includes(task.status))return false;
 return db.db.prepare("UPDATE lead_tasks SET status='cancelled',updated=?,done_by=? WHERE task_id=?").run(now,text(actor),task.task_id).changes===1;
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
