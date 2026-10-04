/**
 * The Bona inbox (2026-09-27 design §4.4): the chat list, the owner's Unsure list, and
 * one chat's thread with its reply box.
 *
 * Same rules as render.mjs: no script of its own — a signed-in page may run our own
 * `/dashboard/app.js` and nothing inline (the CSP allows nothing else), and every screen
 * works without it — every value through `esc`, every write a plain form post to
 * /v1/admin/*. With it (Phase 3), the list and a thread carry a pulse — `data-pulse`, the
 * URL to ask, and `data-pulse-token`, what the page was drawn from — and the list draws
 * the Phone alerts panel, hidden until the script knows what this device can do. Without
 * script a page is as fresh as its last load, and the browser's reload still works.
 *
 * Numbers: a list shows the last four digits only; the thread header shows the whole
 * number, because that page exists to talk to that one person. Names sit in `<bdi>`, so
 * an Arabic name cannot reorder the words around it.
 *
 * Who wrote a bubble: the client, a team member by name, Dana, or the owner's own phone,
 * which the owner reads as "Your number" and everyone else as "Owner's number". What he
 * types on that phone and what Lisa sends for him look the same to the API, so the
 * label never claims more than "it came from that number".
 */
import {
  esc, maskPhone, fullPhone, agoSince, dateTime, layout, knownError, messageFor, stageName, postButton,
} from './render.mjs';
import { MAX_TEXT_LEN } from '../wa-send.mjs';
import { fundsBanner } from './render-team.mjs';

export const INBOX_OK = {
  sent: 'Sent.',
  handler: 'Handler saved.',
  moved: 'Moved to the Bona inbox.',
  out: 'Marked not a client. What the dashboard stored from that chat is deleted.',
  added: 'Added to the Bona inbox.',
  dana: 'Dana setting saved.',
  dismissed: 'Marked not a client. It is off the list; only its number and WhatsApp id are kept, for a year, so it is not listed again.',
};

/** One banner. A known error wins over an ok; a code nobody knows shows nothing. */
function flash(ok, error) {
  if (knownError(error)) return `<div class="err">${esc(messageFor(error))}</div>`;
  return typeof ok === 'string' && Object.hasOwn(INBOX_OK, ok) ? `<div class="ok">${esc(INBOX_OK[ok])}</div>` : '';
}

// A lead id reaches these templates as-is, so it is encoded before it becomes a path
// segment: a `/` or `?` inside it must not be able to reshape a link or a form action.
const threadHref = (leadId) => `/dashboard/inbox/${encodeURIComponent(leadId)}`;
const leadHref = (leadId) => `/dashboard/leads/${encodeURIComponent(leadId)}`;
const writeHref = (leadId, what) => `/v1/admin/inbox/${encodeURIComponent(leadId)}/${what}`;

/** One line of at most `max` characters: whitespace folded, cut on a whole character. */
function preview(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

const firstLetter = (name) => (name ? [...name][0] : '·');

/** The owner's two lists. Staff never get this strip: Unsure is the owner's call (D9). */
function tabs(active, unsureCount) {
  const n = Number(unsureCount);
  return `<div class="seg"><a${active === 'inbox' ? ' class="on"' : ''} href="/dashboard/inbox">Inbox</a>` +
    `<a${active === 'unsure' ? ' class="on"' : ''} href="/dashboard/inbox?tab=unsure">Unsure${Number.isFinite(n) && n > 0 ? ` · ${esc(n)}` : ''}</a></div>`;
}

/* ------------------------------------------------------------------ */
/* The chat list                                                       */
/* ------------------------------------------------------------------ */

/** The last message in a word or two: who sent it from our side, then what it said. */
function lastLine(row) {
  const said = preview([row.last_media, row.last_text].filter(Boolean).join(' '), 80);
  if (!said) return '';
  if (row.last_direction !== 'out') return said;
  return `${row.last_sender_kind === 'dana' ? 'Dana' : 'Bona'}: ${said}`;
}

function inboxRow(row, now) {
  const name = String(row.name ?? '').trim();
  const unread = Number(row.unread) || 0;
  const last = lastLine(row);
  const pills = [
    unread > 0 ? `<span class="pl gold">${esc(unread)} new</span>` : '',
    Number(row.needs_human) === 1 ? '<span class="pl hot">Needs a human</span>' : '',
    `<span class="pl done">${esc(stageName(row.stage))}</span>`,
  ].join('');
  const handler = row.handler_name ? `Handler: <bdi>${esc(row.handler_name)}</bdi>` : 'No handler';
  return `<a class="lr ix" href="${esc(threadHref(row.lead_id))}">
  <span class="av2" aria-hidden="true"><span dir="auto">${esc(firstLetter(name))}</span></span>
  <div>
    <div class="l1"><span class="nm"><bdi>${esc(name || 'Unnamed')}</bdi></span>${pills}</div>
    <div class="l2"><span class="tel">${esc(maskPhone(row.phone_e164))}</span><span>·</span><span>${esc(agoSince(now, row.last_msg_ts ?? row.inbox_since ?? row.created))}</span><span>·</span><span>${handler}</span></div>
    ${last ? `<div class="l2"><span dir="auto">${esc(last)}</span></div>` : ''}
  </div>
</a>`;
}

/**
 * Every chat in the Bona inbox, in the order the store gives them (unread first, then
 * newest). The owner also gets the Unsure tab and "Add chat by phone number"; a team
 * member sees neither, not even as a link. `pulseToken` is what the list was drawn from
 * (the route's `listToken`, P3-12); app.js reloads the page when the pulse answers another.
 */
export function inboxPage({ me, rows, unsureCount = 0, ok = null, error = null, now = Date.now(), pulseToken = '', fundsOut = null }) {
  const owner = me?.role === 'owner';
  const list = Array.isArray(rows) ? rows : [];
  const withNew = list.filter((r) => (Number(r.unread) || 0) > 0).length;

  const block = list.length
    ? `<p class="sub">${esc(list.length)} ${list.length === 1 ? 'chat' : 'chats'}${withNew ? `, ${esc(withNew)} with new messages` : ''}.</p>
<div class="card cp">${list.map((r) => inboxRow(r, now)).join('')}</div>`
    : '<p class="muted">No chats in the Bona inbox yet. A chat joins when a client writes from an ad, with a Ref code or with a listing number, or when the owner\'s number sends them a Bona link, a brochure or a listing number.</p>';

  // Phone alerts (Phase 3): drawn above the list only when the server has push keys, hidden
  // until app.js has worked out what this device can do (P3-11) — a new member sees "Turn
  // on alerts" without scrolling past the chats. Without script the page is as before.
  const alerts = me?.pushKey
    ? `<section class="card cp alerts" data-alerts hidden>
  <h2>Phone alerts</h2>
  <p class="sub" data-alerts-text></p>
  <div class="row"><button type="button" data-alerts-on hidden>Turn on alerts</button><button type="button" data-alerts-off hidden>Turn off alerts on this device</button></div>
</section>`
    : '';

  const add = owner
    ? `<h2 style="margin-top:22px">Add chat by phone number</h2>
<p class="sub">For a client who is not in the list yet. The chat's last 30 days are copied in from WhatsApp.</p>
<form class="row" method="post" action="/v1/admin/inbox/add">
  <input type="hidden" name="_dash" value="1">
  <div><label for="a-phone">WhatsApp number</label><input id="a-phone" name="phone" inputmode="tel" dir="ltr" placeholder="05XXXXXXXX" maxlength="20" required></div>
  <div><button type="submit">Add chat</button></div>
</form>`
    : '';

  // The pulse (P3-12): what this page was drawn from, and the note app.js shows instead of
  // reloading while the owner is typing a number into "Add chat by phone number".
  const note = '<p class="flash" data-pulse-note hidden>New messages — <a href="/dashboard/inbox">reload</a> to see them.</p>';

  return layout({
    title: 'Inbox',
    active: '/dashboard/inbox',
    me,
    actions: owner ? tabs('inbox', unsureCount) : '',
    // Retell out of credit (2026-10-05 R2): the owners' red banner, where a funds alert's tap lands.
    body: `${owner ? fundsBanner(fundsOut) : ''}${flash(ok, error)}${alerts}${note}<div data-pulse="/v1/admin/inbox/pulse" data-pulse-token="${esc(pulseToken)}">${block}</div>${add}`,
  });
}

/* ------------------------------------------------------------------ */
/* Unsure (owner only)                                                 */
/* ------------------------------------------------------------------ */

const WHY_UNSURE = {
  keyword: 'wrote the word “bona”',
  time_window: 'wrote within 15 minutes of a tap on the site',
};

/** One Unsure chat; `focused` is the tapped "chat to check" (U4): marked, its decisions right there. */
function unsureRow(row, now, { focused = false } = {}) {
  const name = String(row.name ?? '').trim();
  const why = typeof row.match_method === 'string' && Object.hasOwn(WHY_UNSURE, row.match_method)
    ? WHY_UNSURE[row.match_method]
    : 'no sure sign it is about Bona';
  const snippet = preview(row.snippet, 160);
  return `<div class="lr ix${focused ? ' focus' : ''}">
  <span class="av2" aria-hidden="true"><span dir="auto">${esc(firstLetter(name))}</span></span>
  <div>
    <div class="l1"><span class="nm"><a href="${esc(leadHref(row.lead_id))}"><bdi>${esc(name || 'Unnamed')}</bdi></a></span>${focused ? '<span class="pl hot">new chat to check</span>' : ''}<span class="pl warm">${esc(why)}</span></div>
    <div class="l2"><span class="tel">${esc(maskPhone(row.phone_e164))}</span><span>·</span><span>${esc(agoSince(now, row.created))}</span></div>
    ${snippet ? `<div class="l2"><span dir="auto">${esc(snippet)}</span></div>` : ''}
    <div class="acts" style="margin-top:8px">${postButton(writeHref(row.lead_id, 'move'), 'Move to Bona inbox')}${postButton(writeHref(row.lead_id, 'out'), 'Not a client')}</div>
  </div>
</div>`;
}

/* ------------------------------------------------------------------ */
/* Real-estate chats to check (owner only, D17)                        */
/* ------------------------------------------------------------------ */

const candidateHref = (candId, what) => `/v1/admin/inbox/candidates/${encodeURIComponent(candId)}/${what}`;

/**
 * One chat that talks about property with nothing that says Bona. No lead is behind it and
 * nothing it said was kept: the name WhatsApp shows for the client, or the masked number
 * when there is none; the property words; when it first and last wrote; how many messages;
 * and whether the last one was the owner's or theirs.
 */
function candidateRow(c, now) {
  const name = String(c.name ?? '').trim();
  const masked = maskPhone(c.phone_e164);
  const words = (Array.isArray(c.words) ? c.words : String(c.words ?? '').split(',')).filter((w) => typeof w === 'string' && w);
  const hits = Number(c.hits) || 0;
  const when = (ts) => {
    const a = agoSince(now, ts);
    return a === '—' || a === 'just now' ? a : `${a} ago`;
  };
  const last = c.last_dir === 'out' ? 'you wrote last' : c.last_dir === 'in' ? 'they wrote last' : '';
  const facts = [
    name ? `<span class="tel">${esc(masked)}</span>` : '',
    `<span>first ${esc(when(c.first_ts))}</span>`,
    `<span>last ${esc(when(c.last_ts))}</span>`,
    hits ? `<span>${esc(hits)} ${hits === 1 ? 'message' : 'messages'}</span>` : '',
    last ? `<span>${esc(last)}</span>` : '',
  ].filter(Boolean).join('<span>·</span>');
  return `<div class="lr ix">
  <span class="av2" aria-hidden="true"><span dir="auto">${esc(firstLetter(name))}</span></span>
  <div>
    <div class="l1"><span class="nm">${name ? `<bdi>${esc(name)}</bdi>` : `<span class="tel">${esc(masked)}</span>`}</span>${words.length ? `<span class="pl warm" dir="auto">${esc(words.join(' · '))}</span>` : ''}</div>
    <div class="l2">${facts}</div>
    <div class="acts" style="margin-top:8px">${postButton(candidateHref(c.cand_id, 'move'), 'Move to Bona inbox')}${postButton(candidateHref(c.cand_id, 'dismiss'), 'Not a client')}</div>
  </div>
</div>`;
}

/**
 * Chats that might be about Bona: the guessed leads, then the real-estate chats to check
 * (D17). Only the owner decides, so only the owner sees them; the chats to check are drawn
 * only for an owner even if a caller passes them for someone else. The tab counts both.
 */
export function unsurePage({ me, rows, candidates = [], ok = null, error = null, now = Date.now(), focus = null }) {
  const list = Array.isArray(rows) ? rows : [];
  const cands = me?.role === 'owner' && Array.isArray(candidates) ? candidates : [];
  // A tapped "chat to check" (U4) is drawn first; a focus that matches no row changes nothing.
  const ordered = focus ? [...list.filter((r) => r.lead_id === focus), ...list.filter((r) => r.lead_id !== focus)] : list;
  const guesses = list.length
    ? `<div class="card cp">${ordered.map((r) => unsureRow(r, now, { focused: focus != null && r.lead_id === focus })).join('')}</div>`
    : `<p class="muted">${cands.length ? 'No chats that mention Bona to decide.' : 'Nothing to decide.'}</p>`;
  const toCheck = cands.length
    ? `<h2 style="margin-top:22px">Real-estate chats to check</h2>
<p class="sub">Chats on your number that talk about property but carry nothing that says Bona: a TK client, someone you know, or a new Bona client. Nothing they wrote is kept, only the number, the name WhatsApp shows and the property words, until 30 days after the last such message. <b>Move to Bona inbox</b> makes it a Bona chat and copies in its last 30 days; <b>Not a client</b> takes it off this list, and it is not listed again for a year.</p>
<div class="card cp">${cands.map((c) => candidateRow(c, now)).join('')}</div>`
    : '';
  const body = `${flash(ok, error)}
<p class="sub">Chats that might be about Bona but carry no ad, Ref code or listing number. Only owners see this list. <b>Move to Bona inbox</b> copies in the chat's last 30 days so the team can read and reply; <b>Not a client</b> keeps it out of the inbox, and it never comes back on its own.</p>
${guesses}${toCheck}`;
  return layout({ title: 'Unsure', active: '/dashboard/inbox', me, actions: tabs('unsure', list.length + cands.length), body });
}

/* ------------------------------------------------------------------ */
/* One chat                                                            */
/* ------------------------------------------------------------------ */

/** Why a send failed, in words. Own-property lookup: an error code is data, not a key into anything. */
const FAIL_REASON = {
  rate_limited: 'too many messages this minute, try again shortly',
  sending_disabled: 'sending is off',
  disabled: 'WhatsApp sending is switched off on the server',
  'evolution-not-configured': 'WhatsApp is not set up on the server',
  network: 'WhatsApp could not be reached',
  bad_recipient: 'there is no phone number to send to',
};

function failReason(code) {
  if (typeof code !== 'string') return 'something went wrong';
  if (Object.hasOwn(FAIL_REASON, code)) return FAIL_REASON[code];
  const http = /^http_(\d{3})$/.exec(code);
  return http ? `WhatsApp refused it (HTTP ${http[1]})` : 'something went wrong';
}

function senderLabel(kind, userId, { owner, names }) {
  if (kind === 'client') return 'Client';
  if (kind === 'dana') return 'Dana';
  if (kind === 'owner_number') return owner ? 'Your number' : "Owner's number";
  // A reply keeps its author's name after they leave the team, so the lookup covers
  // every user, not only the active ones.
  if (kind === 'staff') return names.get(userId) ?? 'Team';
  return 'Bona';
}

function bubble({ side, label, media = null, text = null, ts, status = '', pending = false }) {
  return `<div class="bub ${side}${pending ? ' pend' : ''}">` +
    `<span class="who"><bdi>${esc(label)}</bdi></span>` +
    (media ? `<span class="md">${esc(media)}</span>` : '') +
    (text ? `<div class="tx" dir="auto">${esc(text)}</div>` : '') +
    `<span class="at">${esc(dateTime(ts))}</span>${status}</div>`;
}

/** A reply the dashboard sent (or tried to) that WhatsApp has not confirmed. */
function outboxStatus(row) {
  if (row.status === 'pending') return '<span class="st">Sending…</span>';
  if (row.status === 'uncertain') return '<span class="st">Not sure it went — check WhatsApp.</span>';
  if (row.status === 'failed') return `<span class="st bad">Not sent — ${esc(failReason(row.error))}.</span>`;
  return '';
}

/**
 * The thread: stored messages, the gaps where a message could not be read, and the
 * dashboard's own replies that WhatsApp has not confirmed yet, merged by time.
 *
 * The reply box is replaced by one plain sentence when a reply cannot go: a chat with
 * no phone number (an `@lid` is not something we send to), the owner's Sending switch
 * off, or replies from the dashboard not switched on yet (they ship off, design D14,
 * and only a real `true` turns them on). The form carries `send_id` (a double tap sends
 * once) and `seen_rev`, the chat's revision when this page was drawn, so a reply written
 * against an old view is held back (lib/wa-send.mjs `reply`). `seen_ts`, the newest
 * message this page showed, rides along too; the guard no longer reads it.
 *
 * `hidden` is how many stored messages older than the first one drawn the page leaves out
 * (the route draws every unread message, up to 1,000); the thread says so above the first
 * one rather than looking like the start of the chat, and leaves out the gaps and
 * unconfirmed replies older than that first one too.
 *
 * `pulseToken` is the revision this page was drawn from (the route passes `seenRev` as a
 * string, P3-12). When the pulse answers another, app.js reloads the page — unless the
 * reply box has words or focus, when it shows the hidden "new activity" note instead and
 * never touches the draft.
 */
export function threadPage({
  me, lead, messages, gaps = [], outbox = [], users = [], sendId, seenTs, seenRev, sendingEnabled, canReply, repliesEnabled = false,
  draft = '', ok = null, error = null, now = Date.now(), hidden = 0, pulseToken = '',
  danaEnabled = false, danaConfigured = false,
}) {
  const owner = me?.role === 'owner';
  const people = Array.isArray(users) ? users : [];
  const names = new Map(people.map((u) => [u.user_id, u.name]));
  const msgs = Array.isArray(messages) ? messages : [];
  const shown = new Set(msgs.map((m) => m.key_id));
  const who = { owner, names };
  const left = Number.isInteger(hidden) && hidden > 0 ? hidden : 0;
  // With older messages left out, a gap or an unconfirmed reply older than the first one
  // drawn sits among them: drawn at the top of the thread, it would read as coming after them.
  const from = left && msgs.length ? msgs.reduce((min, m) => Math.min(min, Number(m.ts) || 0), Infinity) : -Infinity;
  const drawnSpan = (ts) => (Number(ts) || 0) >= from;

  const items = [
    ...msgs.map((m) => ({
      ts: Number(m.ts) || 0,
      html: bubble({
        side: m.direction === 'out' ? 'out' : 'in',
        label: senderLabel(m.sender_kind, m.sender_user_id, who),
        media: m.media_type,
        text: m.text,
        ts: m.ts,
      }),
    })),
    ...(Array.isArray(gaps) ? gaps : []).filter((g) => drawnSpan(g.ts)).map((g) => ({
      ts: Number(g.ts) || 0,
      html: '<div class="wgap">A message could not be loaded — check WhatsApp.</div>',
    })),
    // A row whose WhatsApp id is already a stored message is that message; showing both
    // would print one reply twice.
    ...(Array.isArray(outbox) ? outbox : []).filter((o) => !(o.key_id && shown.has(o.key_id)) && drawnSpan(o.created)).map((o) => ({
      ts: Number(o.created) || 0,
      html: bubble({
        side: 'out',
        label: senderLabel(o.sender_kind, o.user_id, who),
        text: o.text,
        ts: o.created,
        status: outboxStatus(o),
        pending: true,
      }),
    })),
  ].map((it, i) => ({ ...it, i })).sort((a, b) => a.ts - b.ts || a.i - b.i);

  const name = String(lead.name ?? '').trim();
  const handler = people.find((u) => u.active && u.user_id === lead.handler_user_id) ?? null;

  const head = `<div class="card cp">
  <div class="hd"><div><h2><bdi>${esc(name || 'Unnamed')}</bdi></h2>
    <div class="s"><span dir="ltr">${esc(fullPhone(lead.phone_e164))}</span> · ${esc(stageName(lead.stage))} · ${handler ? `Handler: <bdi>${esc(handler.name)}</bdi>` : 'No handler'}${Number(lead.needs_human) === 1 ? ' <span class="pl hot">Needs a human</span>' : ''}</div></div>
    <a class="r" href="${esc(leadHref(lead.lead_id))}">Lead record →</a></div>
</div>`;

  const earlier = left
    ? `<p class="muted">${esc(left.toLocaleString('en-US'))} earlier ${left === 1 ? 'message is' : 'messages are'} not shown here.</p>`
    : '';
  const thread = items.length
    ? `${earlier}<div class="thread">${items.map((it) => it.html).join('')}</div>`
    : '<p class="muted">No messages stored for this chat yet.</p>';
  // The pulse (P3-12): what this page was drawn from, and a note app.js shows when the chat
  // has moved on but the reply box is in use. Drawn right above the reply box, where the
  // person typing sees it; a plain link, a reload they choose, never one forced over a draft.
  const note = `<p class="flash" data-pulse-note hidden>New activity in this chat — <a href="${esc(threadHref(lead.lead_id))}">reload</a> to see it.</p>`;
  const pulsed = `<div data-pulse="/v1/admin/inbox/pulse?lead=${esc(encodeURIComponent(lead.lead_id))}" data-pulse-token="${esc(pulseToken)}">${thread}</div>`;

  let reply;
  if (!canReply) {
    reply = '<p class="muted">This chat has no phone number — reply from your phone.</p>';
  } else if (!sendingEnabled) {
    // Only an owner can open the Team page, so only an owner gets it as a link: a
    // staff page never contains that link at all (Phase 1 rule).
    reply = `<p class="muted">Sending is off (${owner ? '<a href="/dashboard/team">Team page</a>' : 'Team page'}).</p>`;
  } else if (repliesEnabled !== true) {
    // Replies ship switched off until the owner turns them on (design D14). Same link
    // rule as above; the sender refuses a posted reply (`replies_off`) on its own too.
    reply = owner
      ? '<p class="muted">Replies from the dashboard are not switched on yet (<a href="/dashboard/team">Team page</a>).</p>'
      : '<p class="muted">Replies from the dashboard are not switched on yet — the owner turns them on.</p>';
  } else {
    reply = `<form class="reply" method="post" action="${esc(writeHref(lead.lead_id, 'reply'))}">
  <input type="hidden" name="_dash" value="1">
  <input type="hidden" name="send_id" value="${esc(sendId)}">
  <input type="hidden" name="seen_rev" value="${esc(seenRev)}">
  <input type="hidden" name="seen_ts" value="${esc(seenTs)}">
  <label for="r-text">${esc(owner ? 'Reply — it goes from your WhatsApp' : "Reply — it goes from the owner's WhatsApp")}</label>
  <textarea id="r-text" name="text" maxlength="${esc(MAX_TEXT_LEN)}" dir="auto" required>${esc(draft)}</textarea>
  <div><button type="submit">Send</button></div>
</form>`;
  }

  const options = [`<option value=""${handler ? '' : ' selected'}>Nobody</option>`,
    ...people.filter((u) => u.active).map((u) =>
      `<option value="${esc(u.user_id)}" dir="auto"${handler && u.user_id === handler.user_id ? ' selected' : ''}>${esc(u.name)}</option>`)].join('');
  const picker = `<form class="row" method="post" action="${esc(writeHref(lead.lead_id, 'handler'))}" style="margin-top:18px">
  <input type="hidden" name="_dash" value="1">
  <div><label for="h-user">Handler</label><select id="h-user" name="user_id">${options}</select></div>
  <div><button type="submit">Save handler</button></div>
</form>`;

  // Dana on WhatsApp (Phase 4, P4-4): her state in this chat, anyone's off switch, the owner's
  // test switch (she answers here even while off everywhere). Same Team-page link rule as above.
  const danaOff = Number(lead.dana_off) === 1;
  const danaTest = Number(lead.dana_test) === 1;
  const danaState = danaOff ? 'Dana is off for this chat.'
    : danaTest ? 'Dana is testing on this chat: she answers here even while she is off everywhere (the usual hand-over rules still apply).'
      : danaEnabled === true ? (danaConfigured
        ? 'Dana answers this chat when nobody on the team has replied for 24 hours.'
        : 'Dana would answer this chat when nobody on the team has replied for 24 hours, but she is not provisioned yet, so nothing is sent.')
        : `Dana is off everywhere${owner ? ' (<a href="/dashboard/team">Team page</a>)' : ''}; she does not answer here.`;
  const onUnprovisioned = !danaOff && !danaTest && danaEnabled === true && !danaConfigured;
  const danaNote = danaConfigured || onUnprovisioned ? '' : ' <span class="muted">Dana is not provisioned for WhatsApp yet, so nothing is sent either way.</span>';
  const danaButtons = postButton(writeHref(lead.lead_id, 'dana'), danaOff ? 'Let Dana answer here' : 'Turn Dana off for this chat', { dana_off: danaOff ? '0' : '1' })
    + (owner && !danaOff ? postButton(writeHref(lead.lead_id, 'dana'), danaTest ? 'Stop the Dana test here' : 'Let Dana test on this chat', { dana_test: danaTest ? '0' : '1' }) : '');
  const danaRow = `<div style="margin-top:18px"><p class="sub" style="margin:0 0 6px">${danaState}${danaNote}</p>${danaButtons}</div>`;

  const notClient = owner
    ? `<div style="margin-top:18px">${postButton(writeHref(lead.lead_id, 'out'), 'Not a client')}<span class="muted">Deletes what the dashboard stored from this chat; it never comes back on its own.</span></div>`
    : '';

  return layout({
    title: 'Chat',
    active: '/dashboard/inbox',
    me,
    actions: `<div class="seg"><a href="/dashboard/inbox">← Inbox</a><a href="${esc(threadHref(lead.lead_id))}">Reload</a></div>`,
    body: `${flash(ok, error)}${head}${pulsed}${note}${reply}${picker}${danaRow}${notClient}`,
  });
}
