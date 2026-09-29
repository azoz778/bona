import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, loginPage } from '../lib/dashboard/render.mjs';
import { teamPage } from '../lib/dashboard/render-team.mjs';

const OWNER = { user_id: 'USR-o', name: 'Abdulaziz Zidan', role: 'owner', phone_e164: '966593296933', active: 1, last_login: null };
const STAFF = { user_id: 'USR-s', name: 'Sara <b>', role: 'staff', phone_e164: '966500000001', active: 1, last_login: 1_790_500_000_000 };

test('the rail shows who is signed in, and only an owner sees Team', () => {
  const asOwner = layout({ title: 'Desk', body: '', me: OWNER });
  assert.match(asOwner, /<b><bdi>Abdulaziz Zidan<\/bdi><\/b><s>Owner<\/s>/);
  assert.match(asOwner, /aria-hidden="true">AZ<\/span>/);
  assert.match(asOwner, /href="\/dashboard\/team"/);
  const asStaff = layout({ title: 'Desk', body: '', me: STAFF });
  assert.match(asStaff, /<b><bdi>Sara &lt;b&gt;<\/bdi><\/b><s>Team<\/s>/);
  assert.doesNotMatch(asStaff, /href="\/dashboard\/team"/);
});

test('the rail has a neutral fallback identity when nobody is signed in: no name, no owner label, no Team link', () => {
  const html = layout({ title: 'Desk', body: '' });
  assert.match(html, /aria-hidden="true">·<\/span>/);
  assert.match(html, /<b><bdi><\/bdi><\/b><s>Signed in<\/s>/);
  assert.doesNotMatch(html, /Abdulaziz/, 'the owner\'s name must never appear when nobody is signed in');
  assert.doesNotMatch(html, /Owner/, 'no owner label without a real, owning `me`');
  assert.doesNotMatch(html, /href="\/dashboard\/team"/);
});

test('the login asks for a phone number and never says whether it is on the team', () => {
  const ask = loginPage({ step: 'request' });
  assert.match(ask, /name="phone"/);
  assert.match(ask, /inputmode="tel"/);
  const sent = loginPage({ step: 'code', sent: true });
  assert.match(sent, /If that number is on the Bona team/);
  assert.match(sent, /name="code"/);
});

test('the login page shows a real login error, but never Team-page copy for a Team-page error code', () => {
  // `attempts` is a real login error code (auth.mjs `verify()`), so it must still show.
  const real = loginPage({ step: 'code', error: 'attempts' });
  assert.match(real, /Too many wrong attempts/);
  // `duplicate_phone` is a real, known `MESSAGES` code — just never one the login
  // routes can produce — so the login page must show nothing for it rather than
  // reaching into the Team page's copy and revealing that team membership is a thing.
  const leaked = loginPage({ step: 'request', error: 'duplicate_phone' });
  assert.doesNotMatch(leaked, /already on the team/);
  assert.doesNotMatch(leaked, /class="err"/);
  // Same for every other Team/leads/spend-only code that happens to share the MESSAGES table.
  for (const code of ['bad_name', 'bad_role', 'last_owner', 'not_found', 'bad_setting', 'owner_only', 'bad_stage', 'bad_value', 'empty_note']) {
    assert.doesNotMatch(loginPage({ step: 'request', error: code }), /class="err"/, code);
  }
});

test('the Team page lists people with the right buttons and escapes everything', () => {
  const html = teamPage({ me: OWNER, users: [OWNER, STAFF, { ...STAFF, user_id: 'USR-x', name: 'Old', active: 0 }], never: [{ phone_e164: '966511111111', note: 'cousin', ts: 1 }], sendingEnabled: true, ok: 'added' });
  assert.match(html, /Sara &lt;b&gt;/);
  assert.doesNotMatch(html, /Sara <b>/);
  assert.match(html, /action="\/v1\/admin\/team\/USR-s\/deactivate"/);
  assert.match(html, /action="\/v1\/admin\/team\/USR-x\/reactivate"/);
  assert.doesNotMatch(html, /action="\/v1\/admin\/team\/USR-o\/deactivate"/, 'no button to deactivate yourself');
  assert.match(html, /\+966 51 111 1111/);
  assert.match(html, /cousin/);
  assert.match(html, /name="sending_enabled" value="0"/, 'switch offers to turn sending off');
  assert.match(html, /class="ok"/);
  // The name sits in its own <bdi>, closed before "(you)" — so a bidi character that
  // slips past `cleanName` can reorder the name itself, but can never pull the
  // "(you)" marker into, or in front of, the name it belongs to.
  assert.match(html, /<td dir="auto"><bdi>Abdulaziz Zidan<\/bdi> <span class="muted">\(you\)<\/span><\/td>/);
  assert.match(html, /<td dir="auto"><bdi>Sara &lt;b&gt;<\/bdi><\/td>/);
});

test('the Team page URL-encodes a user id before it reaches a form action, so "/" or "?" cannot reshape the path', () => {
  const weird = { user_id: 'USR/1?x=1', name: 'Weird', role: 'staff', phone_e164: '966500000009', active: 1, last_login: null };
  const html = teamPage({ me: OWNER, users: [OWNER, weird] });
  assert.match(html, /action="\/v1\/admin\/team\/USR%2F1%3Fx%3D1\/deactivate"/);
  assert.doesNotMatch(html, /action="\/v1\/admin\/team\/USR\/1/);
});

test('the Team page carries the owner\'s switch for replies to clients, off until he turns it on', () => {
  const off = teamPage({ me: OWNER, users: [OWNER], sendingEnabled: true });
  assert.match(off, /<h2 style="margin-top:28px">Replies to clients from the dashboard<\/h2>/);
  assert.match(off, /Off\. Nobody can send a client a message from the dashboard yet/);
  assert.match(off, /name="inbox_replies" value="1"/, 'offers to turn replies on');
  assert.match(off, /Turn replies on/);
  assert.match(off, /name="sending_enabled" value="0"/, 'the Sending switch is still its own form');

  const on = teamPage({ me: OWNER, users: [OWNER], sendingEnabled: true, repliesEnabled: true });
  assert.match(on, /On\. Everyone on the team can answer Bona inbox chats/);
  assert.match(on, /name="inbox_replies" value="0"/);
  assert.match(on, /Turn replies off/);
  assert.doesNotMatch(on, /name="inbox_replies" value="1"/);

  assert.match(teamPage({ me: OWNER, users: [OWNER], repliesEnabled: 'yes' }), /name="inbox_replies" value="1"/, 'only a real true counts as on');
});
