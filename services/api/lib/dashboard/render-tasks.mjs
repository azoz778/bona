import { esc } from './render.mjs';
const detailLabels = {budget:'Budget',area:'Preferred area',property_type:'Property type',timeframe:'Buying timeframe',financing:'Financing',note:'Note',no_match:'External sourcing needed',viewing_requested:'Viewing requested',booking_id:'Calendar booking',listing_id:'Listing',slot_start:'Booked slot'};
const telegramLabel = s => s==='sent'?'accepted by Telegram; not proof of reading':s==='uncertain'?'not confirmed; check Telegram before resending':s;
const kindLabel = k => ({handoff:'Handoff',followup:'Follow-up',viewing:'Viewing'}[k] ?? k);
const date = t => t ? new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Riyadh'})+' Riyadh' : 'Not scheduled';
/**
 * An owner enquiry note's state (enquiry_receipts.notify_status, as the notes ledger keeps it; DESIGN
 * §7.1): 'skipped' is a merge into an existing contact, which sends none; 'dropped' never went (owner
 * notes off, or no longer sendable); 'over' went into the daily summary instead. Anything else may
 * have gone, so it says to check.
 */
const NOTIFY_LABELS = {
 sent:'Accepted by WhatsApp; not proof of delivery', pending:'Awaiting acknowledgement', skipped:'No note: an existing contact',
 dropped:'No note sent: owner notes were off, or it could no longer go', over:'No note of its own: over the day’s limit, so it is in the daily summary',
};
const notifyLabel = s => typeof s==='string'&&Object.hasOwn(NOTIFY_LABELS,s)?NOTIFY_LABELS[s]:'Not confirmed — check WhatsApp before resending';
/**
 * A viewing the assistant booked on the calendar (details.booking_id, lead-tasks bookViewing): its
 * time is the calendar's, so the form has no time field, and says where to move it (DESIGN §3.3,
 * §8.4). Its status (Cancel) stays the owner's.
 */
const dueField = t => t.details?.booking_id
 ? `<p class="muted">Booked on the calendar${t.due_ts ? ` for ${esc(date(t.due_ts))}` : ''}. To change the time, move it in Google Calendar; Bona follows the calendar.</p>`
 : '<label>Date and time (Riyadh, UTC+3; leave blank to keep) <input type="datetime-local" name="due_at"></label>';
export function taskQueue(tasks=[],{page=0,total=tasks.length,limit=100}={}) {
 if(!total)return '<p class="muted">No open handoffs, follow-ups or viewing requests.</p>';
 const pager=`<p>${esc(total)} open tasks · page ${page+1}${page>0?` · <a href="/dashboard?tasks_page=${page-1}#task-queue">Previous</a>`:''}${(page+1)*limit<total?` · <a href="/dashboard?tasks_page=${page+1}#task-queue">Next</a>`:''}</p>`;
 return `<div class="card" id="task-queue" style="padding:20px">${pager}<ul>${tasks.map(t=>`<li><a href="/dashboard/leads/${encodeURIComponent(t.lead_id)}">${esc(t.lead_id)}</a> · ${esc(kindLabel(t.kind))} · ${esc(t.status)} · ${esc(date(t.due_ts))}${t.details.no_match?' · External sourcing needed':''} · Telegram: ${esc(telegramLabel(t.telegram_status))}</li>`).join('')}</ul></div>`;
}
export function leadTasksPanel(leadId,tasks=[],owner=false,notifications=[]) {
 const action='/v1/admin/leads/'+encodeURIComponent(leadId)+'/task';
 const cards=tasks.map(t=>`<div class="card" style="padding:20px;margin-bottom:16px"><h3>${esc(kindLabel(t.kind))} · ${esc(t.status)}</h3><p>${esc(t.reason??'')} · ${esc(date(t.due_ts))}</p><dl class="fields">${Object.entries(t.details).map(([k,v])=>`<dt>${esc(detailLabels[k] ?? k)}</dt><dd dir="auto">${esc(v === true ? 'Yes' : v)}</dd>`).join('')}</dl><p class="muted">Owner: Abdulaziz · Telegram: ${esc(telegramLabel(t.telegram_status))}</p>${owner?`<form method="post" action="${action}"><input type="hidden" name="_dash" value="1"><input type="hidden" name="task_id" value="${esc(t.task_id)}"><label>Status <select name="status">${(t.kind==='viewing'?['requested','confirmed','done','cancelled']:['open','done','cancelled']).map(s=>`<option value="${s}"${s===t.status?' selected':''}>${s}</option>`).join('')}</select></label>${dueField(t)}<button type="submit">Save task</button></form>`:''}</div>`).join('');
 return `<h2>Handoff, follow-up &amp; viewing</h2><p class="sub">Automatic reminder messages are off. Telegram status is shown on each handoff. A requested viewing is not a confirmed booking.</p>${notifications.length ? '<div class="card" style="padding:20px;margin-bottom:16px"><h3>Owner enquiry notifications</h3>'+notifications.map(n=>'<p>'+esc(date(n.created))+' · '+esc(notifyLabel(n.notify_status))+'</p>').join('')+'</div>' : ''}${cards||'<p>No tasks recorded.</p>'}${owner?`<form class="stack" method="post" action="${action}"><input type="hidden" name="_dash" value="1"><label>New task <select name="kind"><option value="followup">Follow-up</option><option value="viewing">Viewing request</option></select></label><label>Date and time (Riyadh, UTC+3) <input type="datetime-local" name="due_at" required></label><label>Note <textarea name="note" maxlength="500"></textarea></label><button type="submit">Save task; do not send a message</button></form>`:''}`;
}
