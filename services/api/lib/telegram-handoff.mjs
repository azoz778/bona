/** Optional private secretary alerts. No credential discovery, polling, retries or group fallback.
 * Route evidence: docs/property-pilot-20261010/READINESS.md. A release must explicitly
 * provide the EXISTING Hermes bot credential in Bona's own protected runtime config.
 */
import { createHandoffNotifier } from './lead-tasks.mjs';
export const SECRETARY_CHAT_ID = '5890086834';
export const HERMES_BOT_ID = '8797418123';
export const SECRETARY_ROUTE = Object.freeze({platform:'telegram',chatId:SECRETARY_CHAT_ID,verified:true});
const short = value => String(value ?? '').replace(/[\r\n\t]+/g,' ').trim().slice(0,350);
export function handoffNote(payload, publicApi) {
 const lines=['Bona — buyer handoff',`Lead: ${short(payload.leadId)}`];
 for(const [label,value] of [['Source',payload.source],['Campaign',payload.campaign],['Listing',payload.listingId],['Budget',payload.needs?.budget],['Area',payload.needs?.area],['Type',payload.needs?.property_type],['Timeframe',payload.needs?.timeframe],['Financing (buyer stated)',payload.needs?.financing]])if(value)lines.push(`${label}: ${short(value)}`);
 if(payload.needsExternalSourcing)lines.push('No current match — external sourcing requested.');
 if(payload.needs?.viewing_requested)lines.push('Viewing requested; no appointment confirmed.');
 // No name, phone, transcript, free-form note, auth token or public visitor URL.
 try {const u=new URL(publicApi);if(u.protocol==='https:'&&!u.username&&!u.password){u.pathname='/dashboard/leads/'+encodeURIComponent(payload.leadId);u.search='';u.hash='';lines.push(u.href);}}catch{}
 return lines.join('\n').slice(0,3900);
}
// Keep the default below callers' remaining notification budget: form 4s + 2s < 8s;
// concierge owner WhatsApp 8s + 2s < Retell's 15s tool deadline.
export function createTelegramSender({env={},publicApi,fetchImpl=globalThis.fetch,timeoutMs=2000}={}) {
 const token=String(env.BONA_TELEGRAM_BOT_TOKEN??'');
 const enabled=env.BONA_TELEGRAM_HANDOFFS==='1';
 const configured=env.BONA_TELEGRAM_CHAT_ID===SECRETARY_CHAT_ID&&new RegExp('^'+HERMES_BOT_ID+':[A-Za-z0-9_-]{20,}$').test(token);
 return {enabled,configured,async send(payload){
  if(!enabled||!configured)return {ok:false,skipped:true};
  if(payload.route?.platform!=='telegram'||payload.route?.chatId!==SECRETARY_CHAT_ID||payload.route?.threadId!=null)return {ok:false,skipped:true};
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
   const res=await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:SECRETARY_CHAT_ID,text:handoffNote(payload,publicApi),link_preview_options:{is_disabled:true}}),signal:controller.signal});
   if(!res.ok)return {ok:false};
   const body=await res.json();const msg=body?.result;
   if(body?.ok!==true||!Number.isSafeInteger(msg?.message_id)||msg.message_id<=0||String(msg?.chat?.id)!==SECRETARY_CHAT_ID||msg?.chat?.type!=='private'||String(msg?.from?.id)!==HERMES_BOT_ID)return {ok:false};
   // Accepted by Telegram, not a read/delivery receipt from the owner's device.
   return {ok:true,messageId:String(msg.message_id),chatId:SECRETARY_CHAT_ID};
  }catch{return {ok:false};}finally{clearTimeout(timer);}
 }};
}
export function createTelegramHandoffs({db,env={},publicApi,fetchImpl,isExcludedLead=()=>false,log=()=>{}}) {
 const sender=createTelegramSender({env,publicApi,fetchImpl});
 const notify=createHandoffNotifier({db,enabled:sender.enabled&&sender.configured,route:SECRETARY_ROUTE,send:sender.send});
 return {enabled:sender.enabled,configured:sender.configured,async notifyLead(leadId){
  try {
   const lead=db.getLead(leadId);if(!lead||isExcludedLead(lead))return {status:'skipped'};
   const task=db.db.prepare("SELECT task_id FROM lead_tasks WHERE lead_id=? AND kind='handoff' AND status='open'").get(leadId);
   if(!task)return {status:'skipped'};
   const result=await notify(task.task_id);
   if(result.attempted){try{log({evt:'handoff.telegram',taskId:task.task_id,status:result.status,...(result.messageId?{messageId:result.messageId}:{})});}catch{}}
   return result;
  }catch{return {status:'uncertain'};}
 }};
}
