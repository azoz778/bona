/**
 * The Team page (owner only): who can log in, the numbers that are never a client, and the
 * switches for what the dashboard sends from Bona's WhatsApp — everything (Sending),
 * replies to clients (off until the owner turns them on, design D14), and the AI assistant
 * on WhatsApp (off until the owner turns it on, D14) — then the go-live switches of the
 * full automation (2026-11-27 DESIGN §5.1) and the Ops panel. While the AI service is not
 * answering, or Retell refuses for lack of credit (lib/dana-funds.mjs, 2026-10-05 design R2),
 * a red banner says so at the top. Every write is a form post to /v1/admin/*, like the rest
 * of the dashboard.
 *
 * The assistant has no client-facing name (brain migration, 27 Nov): this page calls it "the
 * AI assistant", and its copy holds on either engine (the Retell agent or the AI service)
 * and with bookings on or off. The Retell funds banner keeps today's words for the website
 * chat, which stays on Retell until T28.
 */
import { esc, fullPhone, dateTime, layout, scrollTable, knownError, messageFor } from './render.mjs';
import { TZ_OFFSET_MS } from './stats.mjs';

export const TEAM_OK = {
  added: 'Added. They can log in with their WhatsApp number now.',
  deactivated: 'Deactivated. They were logged out everywhere.',
  reactivated: 'Reactivated. They can log in again.',
  role: 'Role changed.',
  never_added: 'Added to the never-a-client list.',
  never_removed: 'Removed from the never-a-client list.',
  setting: 'Saved.',
};

const post = (action, label, fields = {}, cls = '') => `<form method="post" action="${esc(action)}" style="display:inline;margin:0 .35rem 0 0">` +
  '<input type="hidden" name="_dash" value="1">' +
  Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('') +
  `<button type="submit"${cls ? ` class="${esc(cls)}"` : ''}>${esc(label)}</button></form>`;

/** `dateTime` writes UTC; shifted by Riyadh's fixed +03:00 it reads as the owner's clock. */
const riyadh = (ms) => `${dateTime(ms + TZ_OFFSET_MS)} Riyadh time`;
const isInstant = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * The red banners, or '' while all is fine. `fundsOut` is when Retell started refusing for
 * lack of credit (ms); `brainOut` is when the AI service stopped answering (the `brain_out`
 * marker, ms). The AI-service banner comes first. Also drawn on the owners' inbox list, where
 * a tapped funds alert lands (render-inbox.mjs), which still passes `fundsOut` alone.
 */
export function fundsBanner(fundsOut, { brainOut = null } = {}) {
  const brain = isInstant(brainOut)
    ? `<div class="err">The AI service has not answered since ${esc(riyadh(brainOut))}. Until it is back, clients get a line saying the team will reply.</div>`
    : '';
  const retell = isInstant(fundsOut)
    ? `<div class="err">Dana can’t answer: Retell credit ran out at ${esc(riyadh(fundsOut))}. Top up Retell and she resumes by herself; until then clients get the hand-over line.</div>`
    : '';
  return brain + retell;
}

/**
 * The Ops panel (DESIGN §5.4): counts for the owner only, from an injected `ops()`. Until
 * T14 wires the real one it is a stub that returns `{}`, and the panel says so. Every key
 * and value is escaped; a nested value is shown as its JSON. A value that cannot be shown (a
 * cycle, a BigInt inside an object, a function) is a dash, so the counts never break the page.
 */
const json = (v) => {
  try {
    return JSON.stringify(v) ?? '—';
  } catch {
    return '—';
  }
};
const shown = (v) => {
  if (v === null || v === undefined || typeof v === 'function' || typeof v === 'symbol') return '—';
  return typeof v === 'object' ? json(v) : String(v);
};

export function opsPanel(ops) {
  const entries = ops && typeof ops === 'object' && !Array.isArray(ops) ? Object.entries(ops) : [];
  const rows = entries.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(shown(v))}</td></tr>`);
  return `<h2 style="margin-top:28px">Ops</h2>
<p class="sub">Counts for you only: answers, hand-overs, notes and bookings. Never a client’s words.</p>
${rows.length ? scrollTable('<th>What</th><th>Count</th>', rows, '') : '<p class="sub">No counts yet.</p>'}`;
}

/**
 * The go-live switches, in the order the go-live runs them. Each: the setting key, its
 * heading, what it does while on and while off, and the button for each state. The copy
 * says what is true in either state once its part is merged; until then a switch changes
 * nothing either way, and a value changed early is stored and takes effect at that merge
 * (repo-sync restarts bona-api), which the section's first line says once for all of them.
 */
const GO_LIVE = [
  {
    key: 'own_inbox', title: 'Every chat on Bona’s number',
    on: 'On. Every one-to-one chat on Bona’s WhatsApp number joins the Bona inbox (the AI assistant answers it while it is on), except the team’s chats and the never list. It works only while Bona’s own number is linked and checked.',
    off: 'Off. A chat joins the Bona inbox only as before: by its Ref code, an ad or a listing number, or by your Move or Add. Turning this off stops new chats joining; chats that joined while it was on stay served.',
    turnOn: 'Turn on for every chat', turnOff: 'Turn off for new chats',
  },
  {
    key: 'owner_as_client', title: 'Test mode: your own chat as a client',
    on: 'On. Your own WhatsApp chat with Bona’s number is treated as a client’s, so you can try the whole flow before clients see it. It works only while Bona’s own number is linked and checked, and stays on until you turn it off.',
    off: 'Off. Your own chat with Bona’s number is never treated as a client’s.',
    turnOn: 'Turn test mode on', turnOff: 'Turn test mode off',
  },
  {
    key: 'calendar_booking', title: 'Viewing bookings',
    on: 'On. In the chats it fully serves, the AI assistant can offer free times from Bona’s viewing calendar and book a viewing, once Google Calendar is set up.',
    off: 'Off. The AI assistant passes viewing requests to the team.',
    turnOn: 'Turn bookings on', turnOff: 'Turn bookings off',
  },
  {
    key: 'owner_notes', title: 'Notes to your WhatsApp',
    on: 'On. Notes about new enquiries, hand-overs and bookings, and the daily summary, reach your WhatsApp from Bona’s number while Sending is on.',
    off: 'Off. Those notes are dropped, not kept for later.',
    turnOn: 'Turn notes on', turnOff: 'Turn notes off',
  },
  {
    key: 'email_replies', title: 'Email replies',
    on: 'On. The AI assistant answers enquiry emails to info@bona-real-estate.com, but only once the sender address has been checked.',
    off: 'Off. Clients’ email is sorted by its headers and listed for you; no AI reads it.',
    turnOn: 'Turn email replies on', turnOff: 'Turn email replies off',
  },
  {
    key: 'owner_mail_copy', title: 'Platform mail to your Gmail',
    on: 'On. Account and security mail to info@bona-real-estate.com from trusted platforms (Meta, WhatsApp, Google, TikTok and similar) is copied to your Gmail.',
    off: 'Off. Platform mail stays in Bona’s mailbox only.',
    turnOn: 'Copy to my Gmail', turnOff: 'Stop the Gmail copy',
  },
  {
    key: 'dana_brain', title: 'AI service for every WhatsApp chat',
    on: 'On. Every WhatsApp chat the AI assistant answers uses Bona’s AI service (OpenAI). Once the privacy page names OpenAI, do not turn this off to stop the assistant: use “Turn the AI assistant off” above.',
    off: 'Off. Only the chats the AI assistant fully serves use Bona’s AI service (OpenAI); every other chat still uses the Retell agent. Turn this on only once the privacy page names OpenAI.',
    turnOn: 'Move every chat to OpenAI', turnOff: 'Back to the Retell agent',
  },
];

/**
 * `switches` maps each go-live key to its state; only a real `true` is on (a missing key is
 * off), the same fail-closed reading as the three switches before it. `ops` is the injected
 * `ops()` result, `brainOut` the `brain_out` marker (ms) or null.
 */
export function teamPage({ me, users = [], never = [], sendingEnabled = true, repliesEnabled = false, danaEnabled = false, danaConfigured = false, danaTests = 0, fundsOut = null, brainOut = null, switches = {}, ops = {}, ok = null, error = null }) {
  // Fails closed like the setting itself: only a real `true` from team.repliesEnabled() is on.
  const repliesOn = repliesEnabled === true;
  const danaOn = danaEnabled === true;
  const tests = Number.isInteger(danaTests) && danaTests > 0 ? danaTests : 0;
  const flash = knownError(error)
    ? `<div class="err">${esc(messageFor(error))}</div>`
    : (ok && Object.hasOwn(TEAM_OK, ok) ? `<div class="ok">${esc(TEAM_OK[ok])}</div>` : '');

  const people = users.map((u) => {
    const self = me && u.user_id === me.user_id;
    // Same reasoning as `lead.lead_id` in render.mjs: a `user_id` reaches this template
    // as-is, so `/` or `?` inside it must not be able to reshape the form's `action`
    // path or add a query string. `post()` already `esc()`s the attribute; encoding
    // the id first is what keeps it a single, inert path segment.
    const uid = encodeURIComponent(u.user_id);
    const buttons = [];
    if (u.active && !self) buttons.push(post(`/v1/admin/team/${uid}/deactivate`, 'Deactivate'));
    if (!u.active) buttons.push(post(`/v1/admin/team/${uid}/reactivate`, 'Reactivate'));
    if (u.active && !self) {
      const to = u.role === 'owner' ? 'staff' : 'owner';
      buttons.push(post(`/v1/admin/team/${uid}/role`, to === 'owner' ? 'Make owner' : 'Make team', { role: to }));
    }
    return `<tr${u.active ? '' : ' style="opacity:.55"'}><td dir="auto"><bdi>${esc(u.name)}</bdi>${self ? ' <span class="muted">(you)</span>' : ''}</td>` +
      `<td dir="ltr">${esc(fullPhone(u.phone_e164))}</td><td>${u.role === 'owner' ? 'Owner' : 'Team'}</td>` +
      `<td>${u.active ? 'Active' : 'Deactivated'}</td><td>${u.last_login ? esc(dateTime(u.last_login)) : '—'}</td>` +
      `<td class="wrap">${buttons.join('')}</td></tr>`;
  });

  const nevers = never.map((n) => `<tr><td dir="ltr">${esc(fullPhone(n.phone_e164))}</td><td dir="auto">${esc(n.note ?? '')}</td>` +
    `<td>${post('/v1/admin/never/remove', 'Remove', { phone: n.phone_e164 })}</td></tr>`);

  // Each go-live switch reads as on only for a real `true`, like the three above.
  const state = switches && typeof switches === 'object' ? switches : {};
  const goLive = GO_LIVE.map(({ key, title, on, off, turnOn, turnOff }) => {
    const isOn = state[key] === true;
    return `<h3 style="margin-top:18px">${esc(title)}</h3>
<p class="sub">${esc(isOn ? on : off)}</p>
${post('/v1/admin/settings', isOn ? turnOff : turnOn, { [key]: isOn ? '0' : '1' })}`;
  }).join('\n');

  const body = `${fundsBanner(fundsOut, { brainOut })}${flash}
<h2>People</h2>
<p class="sub">Everyone here logs in with a 6-digit code sent to their own WhatsApp from Bona's WhatsApp number, and sees the same dashboard you do. Only owners see this page.</p>
${scrollTable('<th>Name</th><th>WhatsApp</th><th>Role</th><th>Status</th><th>Last login</th><th></th>', people, 'Nobody yet.')}
<form method="post" action="/v1/admin/team" class="stack" style="margin-top:14px">
  <input type="hidden" name="_dash" value="1">
  <b>Add a person</b>
  <label for="t-name">Name</label><input id="t-name" name="name" maxlength="80" required dir="auto">
  <label for="t-phone">WhatsApp number</label><input id="t-phone" name="phone" inputmode="tel" dir="ltr" placeholder="05XXXXXXXX" maxlength="20" required>
  <label for="t-role">Role</label><select id="t-role" name="role"><option value="staff">Team</option><option value="owner">Owner</option></select>
  <button type="submit">Add</button>
</form>

<h2 style="margin-top:28px">Never a client</h2>
<p class="sub">Family, friends, drivers: chats with these numbers are never picked up, stored or shown, whatever they write.</p>
${scrollTable('<th>Number</th><th>Note</th><th></th>', nevers, 'The list is empty.')}
<form method="post" action="/v1/admin/never" class="stack" style="margin-top:14px">
  <input type="hidden" name="_dash" value="1">
  <label for="n-phone">Number</label><input id="n-phone" name="phone" inputmode="tel" dir="ltr" placeholder="05XXXXXXXX" maxlength="20" required>
  <label for="n-note">Note (only you see it)</label><input id="n-note" name="note" maxlength="120" dir="auto">
  <button type="submit">Add to the list</button>
</form>

<h2 style="margin-top:28px">Sending from Bona's WhatsApp</h2>
<p class="sub">${sendingEnabled
    ? "On. The dashboard may send login codes to your team (and, later, replies to clients) from Bona's WhatsApp number."
    : "Off. Nothing is sent from Bona's WhatsApp number except your own login code."}</p>
${post('/v1/admin/settings', sendingEnabled ? 'Turn sending off' : 'Turn sending on', { sending_enabled: sendingEnabled ? '0' : '1' })}

<h2 style="margin-top:28px">Replies to clients from the dashboard</h2>
<p class="sub">${repliesOn
    ? "On. Everyone on the team can answer Bona inbox chats from the dashboard; the reply goes from Bona's WhatsApp number (while sending above is on)."
    : 'Off. Nobody can send a client a message from the dashboard yet; the team can still read the inbox, and login codes still go.'}</p>
${post('/v1/admin/settings', repliesOn ? 'Turn replies off' : 'Turn replies on', { inbox_replies: repliesOn ? '0' : '1' })}

<h2 style="margin-top:28px">The AI assistant on WhatsApp</h2>
<p class="sub">${danaOn
    ? 'On. The AI assistant answers Bona inbox chats when nobody on the team has replied for 24 hours. It says it is an AI assistant, quotes only published prices, and hands the chat to the team when a client asks for a person. Turn it off for one chat from that chat’s page.'
    : `Off. The AI assistant answers nobody on WhatsApp${tests > 0 ? `, except ${tests} chat${tests === 1 ? '' : 's'} under test` : ''}. To try it on one chat first, open that chat and use its “test on this chat” button.`}${danaConfigured ? '' : ' The AI assistant is not set up for WhatsApp yet, so nothing would be sent either way.'}</p>
${post('/v1/admin/settings', danaOn ? 'Turn the AI assistant off' : 'Turn the AI assistant on', { dana_enabled: danaOn ? '0' : '1' })}

<h2 style="margin-top:28px">Go-live switches</h2>
<p class="sub">These belong to the move to full automation. Leave each one as it ships until the go-live step that names it: a switch changed early takes effect as soon as its part is merged, and until then turning it on or off changes nothing.</p>
${goLive}

${opsPanel(ops)}`;
  return layout({ title: 'Team', active: '/dashboard/team', me, body: `<h1>Team</h1>${body}` });
}
