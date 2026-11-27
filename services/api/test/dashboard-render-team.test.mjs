import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, loginPage, esc } from '../lib/dashboard/render.mjs';
import { teamPage, fundsBanner, opsPanel } from '../lib/dashboard/render-team.mjs';

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

test('the AI assistant switch: off by default with the way to test it on one chat, on with what it does, and a note when it is not set up', () => {
  const off = teamPage({ me: OWNER, users: [OWNER], danaEnabled: false, danaConfigured: true });
  assert.match(off, /<h2[^>]*>The AI assistant on WhatsApp<\/h2>/);
  assert.match(off, /Off\. The AI assistant answers nobody on WhatsApp/);
  assert.match(off, /open that chat and use its “test on this chat” button/);
  assert.match(off, /name="dana_enabled" value="1"/);
  assert.match(off, /Turn the AI assistant on/);
  assert.doesNotMatch(off, /not set up/);
  const on = teamPage({ me: OWNER, users: [OWNER], danaEnabled: true, danaConfigured: true });
  assert.match(on, /On\. The AI assistant answers Bona inbox chats when nobody on the team has replied for 24 hours/);
  assert.match(on, /It says it is an AI assistant, quotes only published prices, and hands the chat to the team when a client asks for a person\./);
  assert.match(on, /name="dana_enabled" value="0"/);
  assert.match(on, /Turn the AI assistant off/);
  assert.doesNotMatch(on, /name="dana_enabled" value="1"/);
  assert.match(teamPage({ me: OWNER, users: [OWNER], danaEnabled: 'yes' }), /name="dana_enabled" value="1"/, 'only a real true counts as on');
  const bare = teamPage({ me: OWNER, users: [OWNER], danaEnabled: false, danaConfigured: false });
  assert.match(bare, /The AI assistant is not set up for WhatsApp yet, so nothing would be sent either way\./);
});

test('the assistant copy is nameless and true on either engine: no personal name, no provider, no viewing promise', () => {
  // DESIGN §4.1 and brain/DESIGN-brain.md: clients see "Bona's AI assistant", never a name.
  // The same copy must hold while a chat is on the Retell agent and once it is on the AI
  // service, with bookings on or off: so it names no provider and says nothing about viewings.
  for (const danaEnabled of [true, false]) {
    for (const danaConfigured of [true, false]) {
      const html = teamPage({ me: OWNER, users: [OWNER], danaEnabled, danaConfigured, danaTests: 1 });
      const section = html.slice(html.indexOf('The AI assistant on WhatsApp'), html.indexOf('Go-live switches'));
      assert.ok(section.length > 100, 'the section is there');
      assert.doesNotMatch(section, /Dana|دانة|\b[Ss]he\b|\b[Hh]er\b/, `no name, no "she" (on=${danaEnabled}, configured=${danaConfigured})`);
      assert.doesNotMatch(section, /Retell|OpenAI|provision/i, 'no provider: the copy holds on both engines');
      assert.doesNotMatch(section, /viewing/i, 'no viewing promise: it depends on the booking switch');
    }
  }
  // Nowhere on the page, banners aside: the Retell funds banner keeps today's words until T28.
  assert.doesNotMatch(teamPage({ me: OWNER, users: [OWNER], danaEnabled: true, danaConfigured: true }), /Dana/);
});

test('the Team page\'s "Off" line does not deny a test the owner armed', () => {
  const page = (danaTests) => teamPage({ me: OWNER, users: [OWNER], danaEnabled: false, danaConfigured: true, danaTests });
  assert.match(page(2), /Off\. The AI assistant answers nobody on WhatsApp, except 2 chats under test\. To try it/);
  assert.match(page(1), /Off\. The AI assistant answers nobody on WhatsApp, except 1 chat under test\. To try it/);
  assert.match(page(0), /Off\. The AI assistant answers nobody on WhatsApp\. To try it/);
  assert.match(teamPage({ me: OWNER, users: [OWNER] }), /Off\. The AI assistant answers nobody on WhatsApp\. To try it/, 'the default is no tests');
});

test('a red banner at the top of the Team page while Retell is out of credit, with the time in Riyadh; none otherwise (2026-10-05 R2)', () => {
  // 2026-10-03 09:30 UTC is 12:30 in Riyadh (UTC+3, no DST).
  const at = Date.UTC(2026, 9, 3, 9, 30);
  const html = teamPage({ me: OWNER, users: [OWNER], fundsOut: at, ok: 'setting' });
  const banner = /<div class="err">Dana can’t answer: Retell credit ran out at 2026-10-03 12:30 Riyadh time\. Top up Retell and she resumes by herself; until then clients get the hand-over line\.<\/div>/;
  assert.match(html, banner);
  assert.ok(html.indexOf('Retell credit ran out') < html.indexOf('<h2>People</h2>'), 'at the top');
  assert.ok(html.indexOf('Retell credit ran out') < html.indexOf('class="ok"'), 'above the flash too');
  for (const fine of [null, undefined, 0, NaN, '1790', 'x']) {
    assert.doesNotMatch(teamPage({ me: OWNER, users: [OWNER], fundsOut: fine }), /Retell credit/, String(fine));
  }
});

test("the Team page names Bona's WhatsApp number as the sender, never \"your number\" (2026-11-19 move)", () => {
  for (const [sendingEnabled, repliesEnabled] of [[true, true], [false, false]]) {
    const html = teamPage({ me: OWNER, users: [OWNER], sendingEnabled, repliesEnabled });
    assert.doesNotMatch(html, /your number|from your WhatsApp|Sending from your/i);
    assert.match(html, /<h2[^>]*>Sending from Bona&#39;s WhatsApp<\/h2>|<h2[^>]*>Sending from Bona's WhatsApp<\/h2>/);
    assert.match(html, /from Bona(&#39;|')s WhatsApp number/);
  }
});

/* ---------------- the go-live switches, the AI-service banner and the Ops panel (PLAN T04) ---------------- */

const SWITCH_ROWS = [
  // [key, heading, the button offered while off, the button offered while on]
  ['own_inbox', 'Every chat on Bona’s number', 'Turn on for every chat', 'Turn off for new chats'],
  ['owner_as_client', 'Test mode: your own chat as a client', 'Turn test mode on', 'Turn test mode off'],
  ['calendar_booking', 'Viewing bookings', 'Turn bookings on', 'Turn bookings off'],
  ['owner_notes', 'Notes to your WhatsApp', 'Turn notes on', 'Turn notes off'],
  ['email_replies', 'Email replies', 'Turn email replies on', 'Turn email replies off'],
  ['owner_mail_copy', 'Platform mail to your Gmail', 'Copy to my Gmail', 'Stop the Gmail copy'],
  ['dana_brain', 'AI service for every WhatsApp chat', 'Move every chat to OpenAI', 'Back to the Retell agent'],
];

test('every go-live switch has its own button, off by default, offering the opposite value', () => {
  const off = teamPage({ me: OWNER, users: [OWNER] });
  assert.match(off, /<h2[^>]*>Go-live switches<\/h2>/);
  // owner_notes and owner_mail_copy ship on, so "turning it on" alone would not cover them; and a
  // switch changed early is stored, so it takes effect when its part merges (repo-sync restarts).
  assert.ok(off.includes(esc('Leave each one as it ships until the go-live step that names it: a switch changed early takes effect as soon as its part is merged, and until then turning it on or off changes nothing.')));
  assert.doesNotMatch(off, /once its part is deployed/);
  for (const [key, heading, offLabel, onLabel] of SWITCH_ROWS) {
    assert.ok(off.includes(`>${heading}</h3>`), `${key} heading`);
    assert.match(off, new RegExp(`name="${key}" value="1"`), `${key} offers on`);
    assert.ok(off.includes(`>${offLabel}</button>`), `${key} label while off`);
    assert.doesNotMatch(off, new RegExp(`name="${key}" value="0"`), `${key} never offers off while off`);
  }
  const allOn = Object.fromEntries(SWITCH_ROWS.map(([key]) => [key, true]));
  const on = teamPage({ me: OWNER, users: [OWNER], switches: allOn });
  for (const [key, , , onLabel] of SWITCH_ROWS) {
    assert.match(on, new RegExp(`name="${key}" value="0"`), `${key} offers off`);
    assert.ok(on.includes(`>${onLabel}</button>`), `${key} label while on`);
    assert.doesNotMatch(on, new RegExp(`name="${key}" value="1"`), `${key} never offers on while on`);
  }
  // Fails closed like the setting itself: only a real `true` is on.
  const fuzzy = teamPage({ me: OWNER, users: [OWNER], switches: Object.fromEntries(SWITCH_ROWS.map(([key]) => [key, 'yes'])) });
  for (const [key] of SWITCH_ROWS) assert.match(fuzzy, new RegExp(`name="${key}" value="1"`), `${key}: only true is on`);
});

test('each go-live switch posts to the settings route, one switch per form, with the dashboard marker', () => {
  const html = teamPage({ me: OWNER, users: [OWNER] });
  for (const [key] of SWITCH_ROWS) {
    const form = new RegExp(`<form method="post" action="/v1/admin/settings"[^>]*><input type="hidden" name="_dash" value="1"><input type="hidden" name="${key}" value="1"><button`);
    assert.match(html, form, key);
  }
});

test('the go-live switch copy says what each one does in either state, and names no client-facing assistant', () => {
  const off = teamPage({ me: OWNER, users: [OWNER] });
  const on = teamPage({ me: OWNER, users: [OWNER], switches: Object.fromEntries(SWITCH_ROWS.map(([key]) => [key, true])) });
  for (const line of [
    'Off. A chat joins the Bona inbox only as before: by its Ref code, an ad or a listing number, or by your Move or Add.',
    'Off. Your own chat with Bona’s number is never treated as a client’s.',
    'Off. The AI assistant passes viewing requests to the team.',
    'Off. Those notes are dropped, not kept for later.',
    'Off. Clients’ email is sorted by its headers and listed for you; no AI reads it.',
    'Off. Platform mail stays in Bona’s mailbox only.',
    'Off. Only the chats the AI assistant fully serves use Bona’s AI service (OpenAI); every other chat still uses the Retell agent. Turn this on only once the privacy page names OpenAI.',
  ]) assert.ok(off.includes(esc(line)), line);
  for (const line of [
    'joins the Bona inbox (the AI assistant answers it while it is on), except the team’s chats and the never list.',
    'It works only while Bona’s own number is linked and checked.',
    'stays on until you turn it off.',
    'once Google Calendar is set up.',
    'reach your WhatsApp from Bona’s number while Sending is on.',
    'but only once the sender address has been checked.',
    'is copied to your Gmail.',
    'do not turn this off to stop the assistant: use “Turn the AI assistant off” above.',
  ]) assert.ok(on.includes(esc(line)), line);
  for (const html of [on, off]) {
    const section = html.slice(html.indexOf('Go-live switches'));
    assert.doesNotMatch(section, /Dana|دانة/, 'no client-facing name');
    assert.doesNotMatch(section, /\+?966\s?5\d|@gmail|@example/, 'no number, no address');
  }
});

test('the AI-service banner: "the AI service has not answered" with the time in Riyadh, above the Retell one; none while it is fine', () => {
  const at = Date.UTC(2026, 9, 3, 9, 30);
  const html = teamPage({ me: OWNER, users: [OWNER], brainOut: at, ok: 'setting' });
  const banner = /<div class="err">The AI service has not answered since 2026-10-03 12:30 Riyadh time\. Until it is back, clients get a line saying the team will reply\.<\/div>/;
  assert.match(html, banner);
  assert.ok(html.indexOf('The AI service has not answered') < html.indexOf('<h2>People</h2>'), 'at the top');
  assert.ok(html.indexOf('The AI service has not answered') < html.indexOf('class="ok"'), 'above the flash too');
  assert.doesNotMatch(html, /Retell credit/, 'the Retell banner is its own: only while Retell is out');
  assert.doesNotMatch(html.slice(0, html.indexOf('<h2>People</h2>')), /Dana/, 'nameless');
  for (const fine of [null, undefined, 0, NaN, '1790', 'x']) {
    assert.doesNotMatch(teamPage({ me: OWNER, users: [OWNER], brainOut: fine }), /AI service has not answered/, String(fine));
  }
  // Both out: both banners, the AI service first; the Retell words are today's (the website chat stays on Retell until T28).
  const both = teamPage({ me: OWNER, users: [OWNER], brainOut: at, fundsOut: at });
  assert.match(both, banner);
  assert.match(both, /<div class="err">Dana can’t answer: Retell credit ran out at 2026-10-03 12:30 Riyadh time\. Top up Retell and she resumes by herself; until then clients get the hand-over line\.<\/div>/);
  assert.ok(both.indexOf('The AI service has not answered') < both.indexOf('Retell credit ran out'));
});

test('fundsBanner keeps its one-argument form for the inbox list: the Retell banner only, byte for byte', () => {
  const at = Date.UTC(2026, 9, 3, 9, 30);
  assert.equal(fundsBanner(at), '<div class="err">Dana can’t answer: Retell credit ran out at 2026-10-03 12:30 Riyadh time. Top up Retell and she resumes by herself; until then clients get the hand-over line.</div>');
  assert.equal(fundsBanner(null), '');
  assert.equal(fundsBanner(null, { brainOut: at }), '<div class="err">The AI service has not answered since 2026-10-03 12:30 Riyadh time. Until it is back, clients get a line saying the team will reply.</div>');
  assert.equal(fundsBanner(null, {}), '');
});

test('the Ops panel renders an injected ops() result: a placeholder while it is empty, escaped rows otherwise', () => {
  const empty = teamPage({ me: OWNER, users: [OWNER] });
  assert.match(empty, /<h2[^>]*>Ops<\/h2>/);
  assert.match(empty, /No counts yet\./);
  assert.match(teamPage({ me: OWNER, users: [OWNER], ops: {} }), /No counts yet\./);
  for (const junk of [null, 'x', 42, ['a']]) assert.match(teamPage({ me: OWNER, users: [OWNER], ops: junk }), /No counts yet\./, String(junk));
  const html = teamPage({ me: OWNER, users: [OWNER], ops: { answers_24h: 12, 'p90 <s>': '41 s', brain: { turns: 3 }, none: null } });
  assert.doesNotMatch(html, /No counts yet/);
  assert.match(html, /<td>answers_24h<\/td><td>12<\/td>/);
  assert.match(html, /<td>p90 &lt;s&gt;<\/td><td>41 s<\/td>/);
  assert.match(html, /<td>brain<\/td><td>\{&quot;turns&quot;:3\}<\/td>/);
  assert.match(html, /<td>none<\/td><td>—<\/td>/);
  assert.equal(opsPanel({}), opsPanel(undefined), 'the stub and nothing at all render the same');
});

test('an ops() value that cannot be shown is a dash, never a thrown page: a cycle, a BigInt, a function', () => {
  const loop = { a: 1 };
  loop.self = loop;
  let html;
  assert.doesNotThrow(() => { html = opsPanel({ loop, big: { n: 10n }, fn: () => 'secret source', plain: 3 }); });
  assert.match(html, /<td>loop<\/td><td>—<\/td>/);
  assert.match(html, /<td>big<\/td><td>—<\/td>/);
  assert.match(html, /<td>fn<\/td><td>—<\/td>/);
  assert.doesNotMatch(html, /secret source/, 'a function is never printed as its source');
  assert.match(html, /<td>plain<\/td><td>3<\/td>/);
  assert.doesNotThrow(() => teamPage({ me: OWNER, users: [OWNER], ops: { loop } }));
});
