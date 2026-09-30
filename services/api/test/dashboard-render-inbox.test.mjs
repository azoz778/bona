/**
 * The inbox screens, rendered directly: the chat list, the owner's Unsure list, one
 * thread, and the inbox parts of the rail and the lead page. Every value that came from
 * a client or a team member is hostile until escaped; a list never shows a whole number;
 * an owner-only control never reaches a staff page, not even as a link.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, loginPage, leadDetailPage, knownError, NAV } from '../lib/dashboard/render.mjs';
import { inboxPage, unsurePage, threadPage, INBOX_OK } from '../lib/dashboard/render-inbox.mjs';

const NOW = 1_790_500_000_000;
const HOUR = 3_600_000;
const EVIL = '<img src=x onerror=alert(1)>';
const OWN_SCRIPT = '<script src="/dashboard/app.js" defer></script>';
/** The one script a signed-in page may carry is our own app.js; nothing else, nothing inline. */
const onlyOurScript = (html) => !/<script/i.test(html.split(OWN_SCRIPT).join(''));

const OWNER = { user_id: 'USR-o', name: 'Abdulaziz Zidan', role: 'owner', phone_e164: '966593296933', active: 1, created: 1 };
const STAFF = { user_id: 'USR-s', name: 'Sara', role: 'staff', phone_e164: '966500000001', active: 1, created: 1 };
const GONE = { user_id: 'USR-g', name: 'Omar Old', role: 'staff', phone_e164: '966500000003', active: 0, created: 1 };
const USERS = [OWNER, STAFF, GONE];

const LEAD = {
  lead_id: 'LEAD-20260928-aaaa0001', name: 'Mona', phone_e164: '966512345678',
  wa_jid: '966512345678@s.whatsapp.net', wa_lid: '111222333@lid', stage: 'new', match_method: 'ad_meta',
  inbox_state: 'in', inbox_since: NOW - 48 * HOUR, handler_user_id: null, needs_human: 0,
  last_msg_ts: NOW - HOUR, created: NOW - 48 * HOUR, stage_ts: NOW - 48 * HOUR, channel: 'whatsapp',
};

const row = (over = {}) => ({
  ...LEAD, unread: 0, last_text: null, last_media: null, last_direction: 'in', last_sender_kind: 'client', handler_name: null, ...over,
});

const msg = (over = {}) => ({
  key_id: 'K1', lead_id: LEAD.lead_id, jid: LEAD.wa_lid, direction: 'in', sender_kind: 'client',
  sender_user_id: null, text: 'hello', media_type: null, ts: NOW - 2 * HOUR, status: null, ...over,
});

const thread = (over = {}) => threadPage({
  me: OWNER, lead: LEAD, messages: [], gaps: [], outbox: [], users: USERS,
  sendId: 'SND-abcdefghijklmnop', seenTs: NOW - HOUR, seenRev: 42, sendingEnabled: true, canReply: true, repliesEnabled: true, now: NOW, ...over,
});

/* ---------------- the rail ---------------- */

test('the rail has an Inbox entry right after Desk, with the viewer\'s own unread count, and still no Team link for staff', () => {
  assert.deepEqual(NAV.slice(0, 2).map(([href, label]) => [href, label]), [['/dashboard', 'Desk'], ['/dashboard/inbox', 'Inbox']]);

  const staff = layout({ title: 'Desk', body: '', me: { ...STAFF, unread: 3 } });
  assert.match(staff, /Desk<\/a><a class="it" href="\/dashboard\/inbox">/);
  assert.match(staff, /Inbox<span class="c">3<\/span><\/a>/);
  assert.doesNotMatch(staff, /href="\/dashboard\/team"/);

  const none = layout({ title: 'Desk', body: '', me: { ...STAFF, unread: 0 } });
  assert.match(none, /Inbox<\/a>/, 'nothing unread: no number at all, not a 0');

  const owner = layout({ title: 'Desk', body: '', me: { ...OWNER, unread: 2 } });
  assert.match(owner, /Inbox<span class="c">2<\/span><\/a>/);
  assert.match(owner, /href="\/dashboard\/team"/);

  const explicit = layout({ title: 'Inbox', body: '', me: { ...STAFF, unread: 3 }, counts: { '/dashboard/inbox': 9 } });
  assert.match(explicit, /Inbox<span class="c">9<\/span><\/a>/, 'a count the page passes itself wins');
});

test('the inbox error codes are real messages, and the login page shows none of them', () => {
  for (const code of ['stale', 'lid_only', 'not_in_inbox', 'excluded', 'sending_disabled', 'send_uncertain',
    'bad_text', 'bad_send_id', 'bad_handler', 'reply_rate_limited', 'not_a_chat']) {
    assert.equal(knownError(code), code, code);
    assert.doesNotMatch(loginPage({ step: 'request', error: code }), /class="err"/, code);
  }
});

/* ---------------- the chat list ---------------- */

test('the chat list: escaped names in bdi, masked numbers, last message, time, stage, handler, unread and Needs a human', () => {
  const html = inboxPage({
    me: STAFF,
    now: NOW,
    rows: [
      row({ name: EVIL, unread: 2, needs_human: 1, last_text: 'x'.repeat(100), handler_name: 'Sara <b>' }),
      row({ lead_id: 'LEAD-20260928-aaaa0002', name: 'Khalid', phone_e164: '966598765432', stage: 'viewing',
        last_media: '[voice note]', last_direction: 'out', last_sender_kind: 'staff', last_msg_ts: NOW - 3 * HOUR }),
      row({ lead_id: 'LEAD-20260928-aaaa0003', name: null, phone_e164: null, wa_jid: null, last_text: 'السلام <script>',
        last_direction: 'out', last_sender_kind: 'dana' }),
    ],
  });
  assert.ok(!html.includes('<img'), 'a name is text, never markup');
  assert.ok(onlyOurScript(html), 'a message is text, never markup: no script but our own app.js');
  assert.match(html, /<bdi>&lt;img src=x onerror=alert\(1\)&gt;<\/bdi>/);
  assert.match(html, /…5678/);
  assert.match(html, /…5432/);
  assert.doesNotMatch(html, /966512345678|966598765432|\+966 51/, 'a list never shows a whole number');
  assert.ok(html.includes(`${'x'.repeat(80)}…`), 'the last message is cut at 80 characters');
  assert.ok(!html.includes('x'.repeat(81)));
  assert.match(html, /Bona: \[voice note\]/, 'a media message shows its placeholder, and our side is marked');
  assert.match(html, /Dana: السلام &lt;script&gt;/);
  assert.match(html, /<span>1\sh<\/span>/, 'time since the last message');
  assert.match(html, /<span>3\sh<\/span>/);
  assert.match(html, /<span class="pl gold">2 new<\/span>/);
  assert.match(html, /<span class="pl hot">Needs a human<\/span>/);
  assert.equal(html.match(/Needs a human/g).length, 1, 'only the chat that needs one');
  assert.match(html, /<span class="pl done">New<\/span>/);
  assert.match(html, /<span class="pl done">Viewing<\/span>/);
  assert.match(html, /Handler: <bdi>Sara &lt;b&gt;<\/bdi>/);
  assert.match(html, /No handler/);
  assert.match(html, /<bdi>Unnamed<\/bdi>/);
  assert.match(html, /href="\/dashboard\/inbox\/LEAD-20260928-aaaa0001"/);
  assert.match(html, /href="\/dashboard\/inbox\/LEAD-20260928-aaaa0002"/);
  assert.match(html, /3 chats, 1 with new messages/);
  assert.ok(onlyOurScript(html), 'no script but our own app.js');
});

test('only the owner sees the Unsure tab, its count and "Add chat by phone number"', () => {
  const owner = inboxPage({ me: OWNER, rows: [row()], unsureCount: 4, now: NOW });
  assert.match(owner, /<a class="on" href="\/dashboard\/inbox">Inbox<\/a><a href="\/dashboard\/inbox\?tab=unsure">Unsure · 4<\/a>/);
  assert.match(owner, /action="\/v1\/admin\/inbox\/add"/);
  assert.match(owner, /<input type="hidden" name="_dash" value="1">/);
  assert.match(owner, /name="phone" inputmode="tel"/);

  const staff = inboxPage({ me: STAFF, rows: [row()], unsureCount: 4, now: NOW });
  assert.doesNotMatch(staff, /tab=unsure/);
  assert.doesNotMatch(staff, /Unsure/);
  assert.doesNotMatch(staff, /\/v1\/admin\/inbox\/add/);
  assert.doesNotMatch(staff, /href="\/dashboard\/team"/);
});

test('an empty inbox says so, and a banner shows only for a code it knows', () => {
  const empty = inboxPage({ me: STAFF, rows: [], now: NOW });
  assert.match(empty, /No chats in the Bona inbox yet/);

  assert.ok(inboxPage({ me: OWNER, rows: [], ok: 'added', now: NOW }).includes(`<div class="ok">${INBOX_OK.added}</div>`));
  assert.match(inboxPage({ me: OWNER, rows: [], error: 'not_a_chat', now: NOW }), /<div class="err">That lead has no WhatsApp chat yet/);
  const odd = inboxPage({ me: OWNER, rows: [], ok: 'constructor', error: 'toString', now: NOW });
  assert.doesNotMatch(odd, /class="ok"|class="err"/, 'a prototype name is not a message');
});

/* ---------------- Unsure ---------------- */

test('the Unsure list: escaped snippet, masked number, why it is unsure, and the two decisions', () => {
  const html = unsurePage({
    me: OWNER,
    now: NOW,
    rows: [
      { ...LEAD, inbox_state: 'unsure', match_method: 'keyword', name: 'Ali', snippet: 'is bona <b>real</b>?' },
      { ...LEAD, lead_id: 'LEAD/1?x=1', inbox_state: null, match_method: 'time_window', name: EVIL, snippet: null },
    ],
  });
  assert.match(html, /is bona &lt;b&gt;real&lt;\/b&gt;\?/);
  assert.ok(!html.includes('<b>real</b>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /…5678/);
  assert.doesNotMatch(html, /966512345678/);
  assert.match(html, /wrote the word “bona”/);
  assert.match(html, /wrote within 15 minutes of a tap on the site/);
  assert.match(html, /action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/move"/);
  assert.match(html, /action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/out"/);
  assert.match(html, />Move to Bona inbox<\/button>/);
  assert.match(html, />Not a client<\/button>/);
  assert.match(html, /action="\/v1\/admin\/inbox\/LEAD%2F1%3Fx%3D1\/move"/, 'an odd id stays one path segment');
  assert.doesNotMatch(html, /action="\/v1\/admin\/inbox\/LEAD\/1/);
  assert.match(html, /<a href="\/dashboard\/inbox">Inbox<\/a><a class="on" href="\/dashboard\/inbox\?tab=unsure">Unsure · 2<\/a>/);
  assert.match(unsurePage({ me: OWNER, rows: [], now: NOW }), /Nothing to decide/);
});

/* ---------------- one chat ---------------- */

test('a thread: client bubbles left, ours right, each labelled; media shows its placeholder and caption', () => {
  const messages = [
    msg({ key_id: 'K1', text: `hi ${EVIL}`, ts: NOW - 5 * HOUR }),
    msg({ key_id: 'K2', direction: 'out', sender_kind: 'owner_number', text: 'Welcome', ts: NOW - 4 * HOUR }),
    msg({ key_id: 'K3', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-s', text: 'Here is the villa', ts: NOW - 3 * HOUR }),
    msg({ key_id: 'K4', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-g', text: 'Old reply', ts: NOW - 170 * 60_000 }),
    msg({ key_id: 'K5', direction: 'out', sender_kind: 'dana', text: 'Dana here', ts: NOW - 160 * 60_000 }),
    msg({ key_id: 'K6', media_type: '[image]', text: 'the view', ts: NOW - 150 * 60_000 }),
    msg({ key_id: 'K7', media_type: '[document: <b>plan</b>.pdf]', text: null, ts: NOW - 140 * 60_000 }),
    msg({ key_id: 'K8', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-unknown', text: 'who?', ts: NOW - 130 * 60_000 }),
  ];
  const html = thread({ messages });
  assert.ok(!html.includes('<img'), 'message text is escaped');
  assert.ok(!html.includes('<b>plan</b>'), 'a file name is escaped');
  assert.match(html, /\[document: &lt;b&gt;plan&lt;\/b&gt;\.pdf\]/);
  assert.match(html, /<div class="bub in"><span class="who"><bdi>Client<\/bdi><\/span><div class="tx" dir="auto">hi &lt;img/);
  assert.match(html, /<div class="bub out"><span class="who"><bdi>Your number<\/bdi><\/span><div class="tx" dir="auto">Welcome/);
  assert.match(html, /<div class="bub out"><span class="who"><bdi>Sara<\/bdi><\/span><div class="tx" dir="auto">Here is the villa/);
  assert.match(html, /<bdi>Omar Old<\/bdi><\/span><div class="tx" dir="auto">Old reply/, 'a reply keeps its author after they leave');
  assert.match(html, /<div class="bub out"><span class="who"><bdi>Dana<\/bdi><\/span>/);
  assert.match(html, /<bdi>Team<\/bdi><\/span><div class="tx" dir="auto">who\?/, 'an author we cannot name is still "Team"');
  assert.match(html, /<span class="md">\[image\]<\/span><div class="tx" dir="auto">the view<\/div>/);
  assert.ok(html.indexOf('K1') === -1, 'no WhatsApp message id is printed');
  assert.ok(html.indexOf('hi &lt;img') < html.indexOf('Welcome') && html.indexOf('Welcome') < html.indexOf('Here is the villa'), 'oldest first');

  const asStaff = thread({ me: STAFF, messages });
  assert.match(asStaff, /<bdi>Owner&#39;s number<\/bdi>/);
  assert.doesNotMatch(asStaff, /Your number/);
});

test('the thread header shows the whole number, the stage, the handler and a link to the lead', () => {
  const html = thread({ lead: { ...LEAD, handler_user_id: 'USR-s', needs_human: 1, stage: 'viewing', name: 'Mona <i>' } });
  assert.match(html, /<span dir="ltr">\+966 51 234 5678<\/span>/);
  assert.match(html, /Viewing/);
  assert.match(html, /Handler: <bdi>Sara<\/bdi>/);
  assert.match(html, /<span class="pl hot">Needs a human<\/span>/);
  assert.match(html, /<h2><bdi>Mona &lt;i&gt;<\/bdi><\/h2>/);
  assert.match(html, /href="\/dashboard\/leads\/LEAD-20260928-aaaa0001"/);
  assert.match(html, /href="\/dashboard\/inbox">← Inbox<\/a>/);
  assert.match(thread({ lead: { ...LEAD, handler_user_id: 'USR-g' } }), /No handler/, 'a deactivated handler is nobody');
  assert.match(thread(), /No messages stored for this chat yet/);
});

test('gaps and unconfirmed replies sit in time order with an honest status line', () => {
  const html = thread({
    messages: [msg({ key_id: 'K1', text: 'first', ts: NOW - 5 * HOUR }), msg({ key_id: 'K9', text: 'last', ts: NOW - HOUR })],
    gaps: [{ key_id: 'G1', lead_id: LEAD.lead_id, jid: LEAD.wa_lid, ts: NOW - 4 * HOUR, reason: 'failed' }],
    outbox: [
      { send_id: 'S1', lead_id: LEAD.lead_id, text: 'going <now>', user_id: 'USR-s', sender_kind: 'staff', status: 'pending', key_id: null, created: NOW - 3 * HOUR, error: null },
      { send_id: 'S2', lead_id: LEAD.lead_id, text: 'maybe', user_id: 'USR-s', sender_kind: 'staff', status: 'uncertain', key_id: null, created: NOW - 2.5 * HOUR, error: 'timeout' },
      { send_id: 'S3', lead_id: LEAD.lead_id, text: 'refused', user_id: 'USR-o', sender_kind: 'staff', status: 'failed', key_id: null, created: NOW - 2.2 * HOUR, error: 'http_500' },
      { send_id: 'S4', lead_id: LEAD.lead_id, text: 'too fast', user_id: 'USR-o', sender_kind: 'staff', status: 'failed', key_id: null, created: NOW - 2.1 * HOUR, error: 'rate_limited' },
      { send_id: 'S5', lead_id: LEAD.lead_id, text: 'odd', user_id: 'USR-o', sender_kind: 'staff', status: 'failed', key_id: null, created: NOW - 2 * HOUR, error: 'constructor' },
      { send_id: 'S6', lead_id: LEAD.lead_id, text: 'last', user_id: 'USR-s', sender_kind: 'staff', status: 'uncertain', key_id: 'K9', created: NOW - HOUR, error: null },
    ],
  });
  assert.match(html, /<div class="wgap">A message could not be loaded — check WhatsApp\.<\/div>/);
  assert.match(html, /<div class="bub out pend"><span class="who"><bdi>Sara<\/bdi><\/span><div class="tx" dir="auto">going &lt;now&gt;<\/div>/);
  assert.match(html, /Sending…/);
  assert.match(html, /Not sure it went — check WhatsApp\./);
  assert.match(html, /Not sent — WhatsApp refused it \(HTTP 500\)\./);
  assert.match(html, /Not sent — too many messages this minute, try again shortly\./);
  assert.match(html, /Not sent — something went wrong\./, 'an unknown code is not printed');
  assert.doesNotMatch(html, /constructor|function/);
  const order = ['first', 'A message could not be loaded', 'going &lt;now&gt;', 'maybe', 'refused', 'too fast', '>odd<', '>last<'].map((s) => html.indexOf(s));
  assert.ok(order.every((at) => at >= 0), 'every item is on the page');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in time order');
  assert.equal(html.match(/>last</g).length, 1, 'an outbox row that is already a stored message is not shown twice');
});

test('the reply form carries send_id, seen_rev, seen_ts and the kept draft, and posts to this chat', () => {
  const html = thread({ draft: 'my text </textarea><script>x</script>', error: 'stale' });
  assert.match(html, /<form class="reply" method="post" action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/reply">/);
  assert.match(html, /<input type="hidden" name="_dash" value="1">/);
  assert.match(html, /<input type="hidden" name="send_id" value="SND-abcdefghijklmnop">/);
  assert.match(html, /<input type="hidden" name="seen_rev" value="42">/, 'the revision the stale-view guard compares');
  assert.match(html, new RegExp(`<input type="hidden" name="seen_ts" value="${NOW - HOUR}">`));
  assert.match(html, /<textarea id="r-text" name="text" maxlength="4096" dir="auto" required>my text &lt;\/textarea&gt;&lt;script&gt;x&lt;\/script&gt;<\/textarea>/);
  assert.ok(onlyOurScript(html), 'no script but our own app.js');
  assert.match(html, /<div class="err">New activity since you opened this chat/);
  assert.match(html, /it goes from your WhatsApp/);
  assert.match(thread({ me: STAFF }), /it goes from the owner&#39;s WhatsApp/);
});

test('no reply box for a chat with no phone number, or while sending is off', () => {
  const lid = thread({ lead: { ...LEAD, phone_e164: null, wa_jid: null }, canReply: false });
  assert.match(lid, /This chat has no phone number — reply from your phone\./);
  assert.doesNotMatch(lid, /\/reply"/);
  assert.doesNotMatch(lid, /name="text"/);
  assert.match(lid, /<span dir="ltr">—<\/span>/, 'no number to show');

  const offStaff = thread({ me: STAFF, sendingEnabled: false });
  assert.match(offStaff, /Sending is off \(Team page\)\./);
  assert.doesNotMatch(offStaff, /\/reply"/);
  assert.doesNotMatch(offStaff, /href="\/dashboard\/team"/, 'a staff page never carries the Team link');

  const offOwner = thread({ sendingEnabled: false });
  assert.match(offOwner, /Sending is off \(<a href="\/dashboard\/team">Team page<\/a>\)\./);

  const both = thread({ lead: { ...LEAD, phone_e164: null, wa_jid: null }, canReply: false, sendingEnabled: false });
  assert.match(both, /reply from your phone/, 'turning sending on would not help a chat with no number, so that is what it says');
  assert.doesNotMatch(both, /Sending is off/);
});

test('no reply box until the owner turns dashboard replies on, and only an owner is pointed to the Team page', () => {
  const offOwner = thread({ repliesEnabled: false });
  assert.match(offOwner, /Replies from the dashboard are not switched on yet \(<a href="\/dashboard\/team">Team page<\/a>\)\./);
  assert.doesNotMatch(offOwner, /\/reply"/);
  assert.doesNotMatch(offOwner, /name="text"/);
  assert.doesNotMatch(offOwner, /name="send_id"/);

  const offStaff = thread({ me: STAFF, repliesEnabled: false });
  assert.match(offStaff, /Replies from the dashboard are not switched on yet — the owner turns them on\./);
  assert.doesNotMatch(offStaff, /\/reply"/);
  assert.doesNotMatch(offStaff, /href="\/dashboard\/team"/, 'a staff page never carries the Team link');

  assert.match(thread({ repliesEnabled: 'yes' }), /not switched on yet/, 'only a real true turns the box on');
  const leftOut = threadPage({
    me: OWNER, lead: LEAD, messages: [], users: USERS, sendId: 'SND-abcdefghijklmnop', seenTs: NOW, sendingEnabled: true, canReply: true, now: NOW,
  });
  assert.match(leftOut, /not switched on yet/, 'a caller that does not say gets no reply box');

  const bothOff = thread({ repliesEnabled: false, sendingEnabled: false });
  assert.match(bothOff, /Sending is off/, 'the switch that stops everything is named first');
  assert.doesNotMatch(bothOff, /not switched on yet/);
  const lid = thread({ repliesEnabled: false, lead: { ...LEAD, phone_e164: null, wa_jid: null }, canReply: false });
  assert.match(lid, /reply from your phone/, 'a chat with no number says so, whatever the switches are');

  assert.match(thread({ repliesEnabled: false, error: 'replies_off' }), /<div class="err">Replies from the dashboard are not switched on yet\.<\/div>/);
  assert.equal(knownError('replies_off'), 'replies_off');
  assert.doesNotMatch(loginPage({ step: 'request', error: 'replies_off' }), /class="err"/, 'never on the login page');
});

test('the handler picker offers active people and Nobody, with the current handler chosen', () => {
  const html = thread({ lead: { ...LEAD, handler_user_id: 'USR-s' }, users: [...USERS, { ...STAFF, user_id: 'USR-x', name: 'X <b>', active: 1 }] });
  assert.match(html, /<form class="row" method="post" action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/handler"/);
  assert.match(html, /<select id="h-user" name="user_id"><option value="">Nobody<\/option>/);
  assert.match(html, /<option value="USR-o" dir="auto">Abdulaziz Zidan<\/option>/);
  assert.match(html, /<option value="USR-s" dir="auto" selected>Sara<\/option>/);
  assert.match(html, /<option value="USR-x" dir="auto">X &lt;b&gt;<\/option>/);
  assert.doesNotMatch(html, /value="USR-g"/, 'a deactivated person cannot be picked');
  assert.match(thread(), /<option value="" selected>Nobody<\/option>/);
});

test('only the owner gets "Not a client" on a thread; nobody gets Move there', () => {
  const owner = thread();
  assert.match(owner, /action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/out"/);
  assert.doesNotMatch(owner, /\/move"/);
  const staff = thread({ me: STAFF });
  assert.doesNotMatch(staff, /\/out"/);
  assert.doesNotMatch(staff, /Not a client/);
  assert.doesNotMatch(staff, /\/move"/);
  assert.match(thread({ ok: 'sent' }), /<div class="ok">Sent\.<\/div>/);
});

test('rows full of nulls render without "undefined", "NaN", "[object" or a 1970 date', () => {
  const blank = Object.fromEntries(Object.keys(row({ snippet: null })).map((k) => [k, null]));
  blank.lead_id = 'n';
  const blankMsg = Object.fromEntries(Object.keys(msg()).map((k) => [k, null]));
  const pages = [
    inboxPage({ me: null, rows: [blank] }),
    inboxPage({ me: null, rows: null }),
    unsurePage({ me: null, rows: [blank] }),
    threadPage({
      me: null, lead: blank, messages: [blankMsg], gaps: [{ ts: null }], outbox: [{ status: 'failed', created: null, error: null, text: null }],
      users: null, sendId: null, seenTs: null, sendingEnabled: true, canReply: true,
    }),
    threadPage({ me: null, lead: blank, messages: null, users: null, sendingEnabled: true, canReply: true, repliesEnabled: true }),
    threadPage({ me: null, lead: blank, messages: null, gaps: null, outbox: null, users: null }),
  ];
  for (const html of pages) assert.doesNotMatch(html, /undefined|NaN|\[object|1970-01-01/);
});

/* ---------------- the lead page ---------------- */

test('the lead page offers the inbox controls that fit the viewer and the lead', () => {
  const page = (lead, me) => leadDetailPage({ lead: { ...LEAD, ...lead }, journey: [], now: NOW, me });
  const OPEN = /<a class="btn pri" href="\/dashboard\/inbox\/LEAD-20260928-aaaa0001">Open chat<\/a>/;
  const MOVE = /action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/move"/;
  const OUT = /action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/out"/;

  const ownerIn = page({ inbox_state: 'in' }, OWNER);
  assert.match(ownerIn, OPEN);
  assert.match(ownerIn, OUT);
  assert.doesNotMatch(ownerIn, MOVE);
  assert.match(ownerIn, /<dt>Inbox<\/dt><dd dir="auto">In the Bona inbox<\/dd>/);

  const ownerUnsure = page({ inbox_state: 'unsure' }, OWNER);
  assert.match(ownerUnsure, MOVE);
  assert.match(ownerUnsure, OUT);
  assert.doesNotMatch(ownerUnsure, OPEN);
  assert.match(ownerUnsure, /Unsure — waiting for your decision/);

  const ownerOut = page({ inbox_state: 'out' }, OWNER);
  assert.match(ownerOut, MOVE, 'the owner can change his mind');
  assert.doesNotMatch(ownerOut, OUT);
  assert.match(ownerOut, /<dd dir="auto">Not a client<\/dd>/);

  const ownerNone = page({ inbox_state: null }, OWNER);
  assert.match(ownerNone, MOVE);
  assert.doesNotMatch(ownerNone, OUT);

  const noChat = page({ inbox_state: 'in', wa_jid: null, wa_lid: null, channel: 'form' }, OWNER);
  assert.doesNotMatch(noChat, OPEN, 'nothing to open until they write on WhatsApp');
  assert.match(noChat, /In the Bona inbox — no WhatsApp chat yet/);

  const staffIn = page({ inbox_state: 'in' }, STAFF);
  assert.match(staffIn, OPEN);
  assert.doesNotMatch(staffIn, MOVE);
  assert.doesNotMatch(staffIn, OUT);

  const staffUnsure = page({ inbox_state: 'unsure' }, STAFF);
  assert.doesNotMatch(staffUnsure, MOVE);
  assert.doesNotMatch(staffUnsure, OUT);
  assert.doesNotMatch(staffUnsure, OPEN);
  assert.doesNotMatch(staffUnsure, /Unsure/, 'Unsure is the owner\'s word');
  assert.match(staffUnsure, /Not in the Bona inbox/);

  const odd = page({ lead_id: 'LEAD/1?x=1', inbox_state: 'unsure' }, OWNER);
  assert.match(odd, /action="\/v1\/admin\/inbox\/LEAD%2F1%3Fx%3D1\/move"/);
});

/* ---------------- real-estate chats to check (D17) ---------------- */

const cand = (over = {}) => ({
  cand_id: 'CND-mf3k2a-1a2b', jid: '966512340077@s.whatsapp.net', lid: null, phone_e164: '966512340077', name: 'Umm Khalid',
  first_ts: NOW - 50 * HOUR, last_ts: NOW - HOUR, hits: 3, words: ['شقة', 'إيجار'], last_dir: 'in', state: 'open', updated: NOW - HOUR, ...over,
});

test('the owner\'s Unsure tab lists the real-estate chats to check: name or masked number, words, times, count, who wrote last, two decisions', () => {
  const html = unsurePage({
    me: OWNER,
    now: NOW,
    rows: [],
    candidates: [
      cand(),
      cand({ cand_id: 'CND/1?x=1', name: EVIL, phone_e164: '966598760011', words: ['villa', '<b>x</b>'], hits: 1, last_dir: 'out', first_ts: NOW - 30_000, last_ts: NOW - 30_000 }),
      cand({ cand_id: 'CND-3', name: null, phone_e164: '966555550022', words: [], last_dir: null }),
    ],
  });
  assert.match(html, /<h2[^>]*>Real-estate chats to check<\/h2>/);
  assert.match(html, /<bdi>Umm Khalid<\/bdi>/);
  assert.match(html, /<bdi>&lt;img src=x onerror=alert\(1\)&gt;<\/bdi>/);
  assert.ok(!html.includes('<img'), 'a name is text, never markup');
  assert.ok(!html.includes('<b>x</b>'), 'so is a word');
  assert.match(html, /شقة · إيجار/);
  assert.match(html, /…0077/);
  assert.match(html, /<span class="nm"><span class="tel">…0022<\/span><\/span>/, 'no name: the masked number stands in');
  assert.doesNotMatch(html, /966512340077|966598760011|966555550022/, 'never a whole number');
  assert.match(html, /first 2\sd ago/);
  assert.match(html, /last 1\sh ago/);
  assert.match(html, /last just now/);
  assert.match(html, /3 messages/);
  assert.match(html, /1 message</);
  assert.match(html, /they wrote last/);
  assert.match(html, /you wrote last/);
  assert.match(html, /action="\/v1\/admin\/inbox\/candidates\/CND-mf3k2a-1a2b\/move"/);
  assert.match(html, /action="\/v1\/admin\/inbox\/candidates\/CND-mf3k2a-1a2b\/dismiss"/);
  assert.match(html, /action="\/v1\/admin\/inbox\/candidates\/CND%2F1%3Fx%3D1\/move"/, 'an odd id stays one path segment');
  assert.equal(html.match(/>Move to Bona inbox<\/button>/g).length, 3);
  assert.equal(html.match(/>Not a client<\/button>/g).length, 3);
  assert.match(html, /Unsure · 3<\/a>/, 'the tab counts the chats to check');
  assert.match(html, /until 30 days after the last such message/, 'how long, as the privacy page says');
  assert.match(html, /No chats that mention Bona to decide/);
  assert.doesNotMatch(html, /Nothing to decide/);
});

test('the Unsure tab counts guesses and chats to check together, and says so when there is neither', () => {
  const both = unsurePage({ me: OWNER, now: NOW, rows: [{ ...LEAD, inbox_state: 'unsure', match_method: 'keyword', snippet: 'bona?' }], candidates: [cand()] });
  assert.match(both, /Unsure · 2<\/a>/);
  assert.match(both, /wrote the word “bona”/);
  assert.match(both, /Real-estate chats to check/);
  const none = unsurePage({ me: OWNER, now: NOW, rows: [], candidates: [] });
  assert.match(none, /Nothing to decide/);
  assert.doesNotMatch(none, /Real-estate chats to check/);
});

test('only an owner\'s page ever draws a chat to check, even when one is passed', () => {
  for (const me of [STAFF, null, { ...OWNER, role: 'staff' }]) {
    const html = unsurePage({ me, now: NOW, rows: [], candidates: [cand()] });
    assert.doesNotMatch(html, /Umm Khalid|Real-estate chats to check|\/candidates\/|…0077|شقة/, JSON.stringify(me?.role ?? null));
    assert.doesNotMatch(html, /Unsure · \d/, 'and it counts none');
  }
});

test('a chat to check full of nulls renders without "undefined", "NaN", "[object" or a 1970 date', () => {
  const blank = Object.fromEntries(Object.keys(cand()).map((k) => [k, null]));
  blank.cand_id = 'n';
  const html = unsurePage({ me: OWNER, now: NOW, rows: [], candidates: [blank, { cand_id: 'w', words: 'villa,flat' }] });
  assert.doesNotMatch(html, /undefined|NaN|\[object|1970-01-01/);
  assert.match(html, /villa · flat/, 'words stored as text still read as words');
  assert.match(html, /action="\/v1\/admin\/inbox\/candidates\/n\/dismiss"/);
});

test('a chat to check has its own banners: dismissed, gone, and no number to move in', () => {
  assert.equal(knownError('candidate_gone'), 'candidate_gone');
  assert.equal(knownError('candidate_no_number'), 'candidate_no_number');
  assert.match(unsurePage({ me: OWNER, rows: [], error: 'candidate_no_number', now: NOW }), /<div class="err">That chat has no phone number/);
  assert.ok(unsurePage({ me: OWNER, rows: [], ok: 'dismissed', now: NOW }).includes(`<div class="ok">${INBOX_OK.dismissed}</div>`));
  assert.match(unsurePage({ me: OWNER, rows: [], error: 'candidate_gone', now: NOW }), /<div class="err">That chat is no longer on the list/);
});

/* ---------------- final review fixes 2026-09-29: a long thread ---------------- */

test('a thread that does not draw every message says how many earlier ones are not shown, before the first it draws', () => {
  const many = thread({ messages: [msg({ key_id: 'K9', text: 'the newest' })], hidden: 1250 });
  assert.match(many, /1,250 earlier messages are not shown here\./);
  assert.ok(many.indexOf('earlier messages are not shown') < many.indexOf('the newest'), 'above the messages it draws');
  assert.match(thread({ messages: [msg()], hidden: 1 }), /1 earlier message is not shown here\./);
  for (const hidden of [0, undefined, null, -3, 'x']) {
    assert.doesNotMatch(thread({ messages: [msg()], hidden }), /not shown here/, String(hidden));
  }
});

test('a thread that leaves earlier messages out leaves out the gaps and unconfirmed replies among them too', () => {
  const window = {
    messages: [msg({ key_id: 'K1', text: 'first drawn', ts: NOW - 5 * HOUR }), msg({ key_id: 'K9', text: 'last drawn', ts: NOW - HOUR })],
    gaps: [
      { key_id: 'G0', lead_id: LEAD.lead_id, jid: LEAD.wa_lid, ts: NOW - 9 * HOUR, reason: 'failed' },
      { key_id: 'G1', lead_id: LEAD.lead_id, jid: LEAD.wa_lid, ts: NOW - 4 * HOUR, reason: 'failed' },
    ],
    outbox: [
      { send_id: 'S0', lead_id: LEAD.lead_id, text: 'an old failed reply', user_id: 'USR-s', sender_kind: 'staff', status: 'failed', key_id: null, created: NOW - 8 * HOUR, error: 'http_500' },
      { send_id: 'S1', lead_id: LEAD.lead_id, text: 'a newer failed reply', user_id: 'USR-s', sender_kind: 'staff', status: 'failed', key_id: null, created: NOW - 3 * HOUR, error: 'http_500' },
    ],
  };
  const gapCount = (html) => (html.match(/class="wgap"/g) ?? []).length;

  const cut = thread({ ...window, hidden: 300 });
  assert.equal(gapCount(cut), 1, 'the gap among the hidden messages is not drawn under "not shown here"');
  assert.doesNotMatch(cut, /an old failed reply/);
  assert.match(cut, /a newer failed reply/, 'what sits among the drawn messages stays');
  assert.ok(cut.indexOf('not shown here') < cut.indexOf('first drawn'));

  const whole = thread(window);
  assert.equal(gapCount(whole), 2, 'with nothing left out, a gap before the first message is the chat\'s own start');
  assert.match(whole, /an old failed reply/);
});

/* ---------------- phone alerts and the pulse (Phase 3) ---------------- */

test('the inbox list draws the Phone alerts panel, hidden until app.js shows it, only when push is configured', () => {
  const me = { user_id: 'U1', name: 'Sara', role: 'staff', pushKey: 'BKEY' };
  const html = inboxPage({ me, rows: [], pulseToken: '0:0:0' });
  assert.match(html, /<section class="card cp alerts" data-alerts hidden>/);
  assert.match(html, /<button type="button" data-alerts-on hidden>Turn on alerts<\/button>/);
  assert.match(html, /<button type="button" data-alerts-off hidden>Turn off alerts on this device<\/button>/);
  assert.match(html, /<p class="sub" data-alerts-text><\/p>/);
  assert.doesNotMatch(inboxPage({ me: { ...me, pushKey: '' }, rows: [] }), /data-alerts/);
  assert.doesNotMatch(html, /onclick|onload|javascript:/i, 'no inline handlers: the CSP would block them');
  // Above the list: a new member finds "Turn on alerts" without scrolling past the chats.
  const listed = inboxPage({ me, rows: [row({ unread: 1 })], pulseToken: '1:1:5', now: NOW });
  assert.ok(listed.indexOf('data-alerts') < listed.indexOf('data-pulse='), 'the panel comes before the list');
});

test('the list and the thread carry their pulse, each with a hidden "new activity" note', () => {
  const me = { user_id: 'U1', name: 'Sara', role: 'staff' };
  const list = inboxPage({ me, rows: [], pulseToken: '3:1:17"x' });
  assert.match(list, /<div data-pulse="\/v1\/admin\/inbox\/pulse" data-pulse-token="3:1:17&quot;x">/);
  // The list's note (shown over a half-typed "Add chat" number) links to the list's own GET.
  assert.match(list, /<p class="flash" data-pulse-note hidden>New messages — <a href="\/dashboard\/inbox">reload<\/a> to see them\.<\/p>/);
  const html = thread({ pulseToken: '42', messages: [msg()] }); // the file's `thread(over)` helper, with threadPage's usual fields
  assert.match(html, /data-pulse="\/v1\/admin\/inbox\/pulse\?lead=[A-Za-z0-9_-]+" data-pulse-token="42"/);
  assert.match(html, /<p class="flash" data-pulse-note hidden>New activity in this chat — <a href="[^"]+">reload<\/a> to see it\.<\/p>/);
  // Right above the reply box, after the messages: where the person typing is looking.
  const note = html.indexOf('data-pulse-note');
  assert.ok(html.indexOf('class="thread"') < note && note < html.indexOf('<form class="reply"'), 'the note sits between the messages and the reply box');
});
