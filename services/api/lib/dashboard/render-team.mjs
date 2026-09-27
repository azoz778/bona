/**
 * The Team page (owner only): who can log in, the numbers that are never a client, and
 * the switch for everything the dashboard sends from the owner's WhatsApp.
 * Every write is a form post to /v1/admin/*, like the rest of the dashboard.
 */
import { esc, fullPhone, dateTime, layout, scrollTable, knownError, messageFor } from './render.mjs';

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

export function teamPage({ me, users = [], never = [], sendingEnabled = true, ok = null, error = null }) {
  const flash = knownError(error)
    ? `<div class="err">${esc(messageFor(error))}</div>`
    : (ok && Object.hasOwn(TEAM_OK, ok) ? `<div class="ok">${esc(TEAM_OK[ok])}</div>` : '');

  const people = users.map((u) => {
    const self = me && u.user_id === me.user_id;
    const buttons = [];
    if (u.active && !self) buttons.push(post(`/v1/admin/team/${u.user_id}/deactivate`, 'Deactivate'));
    if (!u.active) buttons.push(post(`/v1/admin/team/${u.user_id}/reactivate`, 'Reactivate'));
    if (u.active && !self) {
      const to = u.role === 'owner' ? 'staff' : 'owner';
      buttons.push(post(`/v1/admin/team/${u.user_id}/role`, to === 'owner' ? 'Make owner' : 'Make team', { role: to }));
    }
    return `<tr${u.active ? '' : ' style="opacity:.55"'}><td dir="auto">${esc(u.name)}${self ? ' <span class="muted">(you)</span>' : ''}</td>` +
      `<td dir="ltr">${esc(fullPhone(u.phone_e164))}</td><td>${u.role === 'owner' ? 'Owner' : 'Team'}</td>` +
      `<td>${u.active ? 'Active' : 'Deactivated'}</td><td>${u.last_login ? esc(dateTime(u.last_login)) : '—'}</td>` +
      `<td class="wrap">${buttons.join('')}</td></tr>`;
  });

  const nevers = never.map((n) => `<tr><td dir="ltr">${esc(fullPhone(n.phone_e164))}</td><td dir="auto">${esc(n.note ?? '')}</td>` +
    `<td>${post('/v1/admin/never/remove', 'Remove', { phone: n.phone_e164 })}</td></tr>`);

  const body = `${flash}
<h2>People</h2>
<p class="sub">Everyone here logs in with a 6-digit code sent to their own WhatsApp from your number, and sees the same dashboard you do. Only owners see this page.</p>
${scrollTable('<th>Name</th><th>WhatsApp</th><th>Role</th><th>Status</th><th>Last login</th><th></th>', people, 'Nobody yet.')}
<form method="post" action="/v1/admin/team" class="card" style="display:grid;gap:10px;max-width:420px;margin-top:14px">
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
<form method="post" action="/v1/admin/never" class="card" style="display:grid;gap:10px;max-width:420px;margin-top:14px">
  <input type="hidden" name="_dash" value="1">
  <label for="n-phone">Number</label><input id="n-phone" name="phone" inputmode="tel" dir="ltr" placeholder="05XXXXXXXX" maxlength="20" required>
  <label for="n-note">Note (only you see it)</label><input id="n-note" name="note" maxlength="120" dir="auto">
  <button type="submit">Add to the list</button>
</form>

<h2 style="margin-top:28px">Sending from your WhatsApp</h2>
<p class="sub">${sendingEnabled
    ? 'On. The dashboard may send login codes to your team (and, later, replies to clients) from your number.'
    : 'Off. Nothing is sent from your number except your own login code.'}</p>
${post('/v1/admin/settings', sendingEnabled ? 'Turn sending off' : 'Turn sending on', { sending_enabled: sendingEnabled ? '0' : '1' })}`;

  return layout({ title: 'Team', active: '/dashboard/team', me, body: `<h1>Team</h1>${body}` });
}
