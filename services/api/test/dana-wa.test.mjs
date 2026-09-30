/**
 * Dana on WhatsApp (design §6, Phase 4). Nothing here contacts Retell or Evolution: the
 * Retell client is a double that records what it was asked, the sender's fetch is a fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam, isExcludedLead } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createSender } from '../lib/wa-send.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import {
  createDana, languageOf, leadFacts, recentContext, batchText, withLinks, clip, answerFrom,
  HUMAN_QUIET_MS, SESSION_IDLE_MS, FRESH_MS, PER_CHAT_PER_HOUR, PER_DAY, CONTEXT_MESSAGES, MAX_LINKS, MAX_ANSWER_LEN, DISCLOSURE, HANDOVER,
} from '../lib/dana-wa.mjs';

const NOW = 1_790_600_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const SITE = 'https://bona.azoz.uk';
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };
const LEAD = 'LEAD-20260930-0000dddd';
const CLIENT = '966511111111';
const CLIENT_JID = `${CLIENT}@s.whatsapp.net`;
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: SITE });
const FIRST = inventory.all()[0];

const agentSays = (content) => ({ messages: [{ role: 'agent', content, message_id: 'm1' }] });
const defaultAnswer = () => agentSays('Of course. Which district do you prefer?');

/** Every number, name and message these tests use. None may reach a log line. */
const PERSONAL = [CLIENT, 'Khalid', 'Sara', 'villa in Al Khalidiyah', 'Of course. Which district', 'chat_1', 'chat_2'];
function assertClean(logs) {
  const out = JSON.stringify(logs);
  for (const needle of PERSONAL) assert.equal(out.includes(needle), false, `a log line carries "${needle}"`);
}

function harness({ answer = defaultAnswer, agentId = 'agent_wa', enabled = true, lead = {}, alerts = true, budget = null, backfill = null, evo = null } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const staff = team.addUser({ name: 'Sara', phone: '0500000009', role: 'staff' });
  if (enabled) team.setSetting('dana_enabled', '1');
  const inbox = createInboxStore(s, { now: () => clock });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = evo ? evo(calls.length) : { status: 201, body: { key: { id: `KEY-${calls.length}` } } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  const sender = createSender({ env: ENV, team, inbox, db: s, fetchImpl, now: () => clock });
  const retell = {
    chats: [], completions: [],
    async createChat(body) { this.chats.push(body); return { chat_id: `chat_${this.chats.length}`, chat_status: 'ongoing' }; },
    async createChatCompletion(body) { this.completions.push(body); return answer(body, this); },
  };
  const notified = [];
  const logs = [];
  s.insertLead({
    lead_id: LEAD, created: NOW - DAY, updated: NOW - DAY, phone_e164: CLIENT, wa_jid: CLIENT_JID, name: 'Khalid', channel: 'whatsapp',
    match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY, interest: 'villa in Al Khalidiyah', ...lead,
  });
  const dana = createDana({
    db: s, inbox, team, sender, retell, inventory, siteUrl: SITE, agentId, budget, backfill,
    alerts: alerts ? { notify: (id, o) => { notified.push([id, o]); return Promise.resolve({ users: 1 }); } } : null,
    isExcludedLead: (l) => isExcludedLead(team, s, l), now: () => clock, log: (o) => logs.push(o), batchMs: 0,
  });
  const client = (id, ts, text, extra = {}) => inbox.upsertMessage({ key_id: id, lead_id: LEAD, jid: CLIENT_JID, direction: 'in', sender_kind: 'client', text, ts, ...extra });
  const human = (id, ts, text, kind = 'owner_number') => { inbox.upsertMessage({ key_id: id, lead_id: LEAD, jid: CLIENT_JID, direction: 'out', sender_kind: kind, text, ts, sender_user_id: kind === 'staff' ? staff.user_id : null }); inbox.noteHumanOutbound(LEAD, ts); inbox.setNeedsHuman(LEAD, 0); };
  return { s, team, staff, inbox, sender, retell, dana, calls, notified, logs, client, human, lead: () => s.getLead(LEAD), tick: (ms) => { clock += ms; }, now: () => clock };
}

/* ---------------- pure helpers ---------------- */

test('the constants are the spec\'s numbers', () => {
  assert.equal(HUMAN_QUIET_MS, 24 * HOUR);
  assert.equal(SESSION_IDLE_MS, 23 * HOUR);
  assert.equal(FRESH_MS, 30 * 60_000);
  assert.deepEqual([PER_CHAT_PER_HOUR, PER_DAY, CONTEXT_MESSAGES, MAX_LINKS, MAX_ANSWER_LEN], [6, 200, 10, 3, 1500]);
  assert.equal(DISCLOSURE.en, "Dana — Bona's AI assistant");
  assert.match(DISCLOSURE.ar, /دانة/);
  assert.match(HANDOVER.en, /team will reply/);
  assert.match(HANDOVER.ar, /فريق بونا/);
});

test('the language is the client\'s: Arabic letters win, Latin letters else, the lead\'s language when there are no letters, Arabic as the last word', () => {
  assert.equal(languageOf({ texts: ['hello', 'كم السعر'] }), 'ar');
  assert.equal(languageOf({ texts: ['hello 4 million'] }), 'en');
  assert.equal(languageOf({ texts: ['[voice note]'], lead: { language: 'en' } }), 'en');
  assert.equal(languageOf({ texts: ['[voice note]'], lead: { language: 'fr' } }), 'ar');
  assert.equal(languageOf({ texts: [null, undefined, 42] }), 'ar');
  assert.equal(languageOf(), 'ar');
});

test('lead facts: only what is set, one line each, never the phone number', () => {
  const facts = leadFacts({ name: '  Khalid\n Al  Saud ', phone_e164: CLIENT, wa_jid: CLIENT_JID, interest: 'villa', budget: null, district: '', listing_id: 'BONA-005', stage: 'new', timeline: 'x'.repeat(500) });
  assert.deepEqual(facts.split('\n'), ['Name: Khalid Al Saud', 'Interest: villa', 'Listing: BONA-005', 'Stage: new', `Timeline: ${'x'.repeat(120)}`]);
  assert.doesNotMatch(facts, /9665/);
  assert.equal(leadFacts(null), '');
  assert.equal(leadFacts({}), '');
});

test('recent context: Client / Team / Dana lines, media as placeholders, the batch left out, the newest kept inside the caps', () => {
  const m = (key_id, direction, sender_kind, text, media_type = null, ts = NOW) => ({ key_id, direction, sender_kind, text, media_type, ts });
  const rows = [
    m('a', 'in', 'client', 'hi'), m('b', 'out', 'owner_number', 'welcome'), m('c', 'out', 'staff', 'any time'),
    m('d', 'out', 'dana', 'sure'), m('e', 'in', 'client', null, '[voice note]'), m('f', 'in', 'client', 'the new one'),
  ];
  assert.equal(recentContext(rows, { exclude: new Set(['f']) }), 'Client: hi\nTeam: welcome\nTeam: any time\nDana: sure\nClient: [voice note]');
  const long = Array.from({ length: 30 }, (_, i) => m(`k${i}`, 'in', 'client', `message ${i} ${'y'.repeat(400)}`));
  const out = recentContext(long);
  assert.ok(out.length <= 3000);
  assert.ok(out.includes('message 29'), 'the newest line is kept');
  assert.ok(!out.includes('message 19'), 'at most ten lines');
  assert.ok(out.split('\n').every((l) => l.length <= 300 + 'Client: '.length));
  assert.equal(recentContext([]), '');
  assert.equal(recentContext(null), '');
});

test('the batch is the messages\' texts, one per line, media as its placeholder', () => {
  assert.equal(batchText([{ text: ' first ' }, { text: null, media_type: '[image]' }, { text: '', media_type: null }, { text: 'last' }]), 'first\n[image]\n[message]\nlast');
  assert.equal(batchText([]), '');
});

test('links: a card whose URL is not in the text is appended in the client\'s language, at most three, never twice', () => {
  const cards = inventory.all().slice(0, 5).map((l) => inventory.card(l));
  const en = withLinks('Two homes for you.', cards, 'en');
  assert.equal(en.links, 3);
  assert.equal(en.text.split('\n\n').length, 4);
  assert.ok(en.text.endsWith(cards[2].url.en));
  assert.ok(en.text.includes(`${cards[0].title.en} — ${cards[0].url.en}`));
  const ar = withLinks('بيتين لك.', cards, 'ar', { max: 1 });
  assert.equal(ar.links, 1);
  assert.ok(ar.text.endsWith(cards[0].url.ar));
  const already = withLinks(`See ${cards[0].url.en} and ${cards[1].url.ar}`, cards.slice(0, 2), 'en');
  assert.equal(already.links, 0, 'either language\'s URL counts as already there');
  assert.deepEqual(withLinks('', [], 'en'), { text: '', links: 0 });
});

test('clip cuts a long answer at whitespace, never mid-word when it can help it', () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const out = clip(words, 100);
  assert.ok(out.length <= 100);
  assert.match(out, /word\d+$/);
  assert.equal(clip('short', 100), 'short');
  assert.equal(clip('x'.repeat(200), 100).length, 100, 'one endless word is simply cut');
  const emoji = clip('😀'.repeat(60), 101);
  assert.ok(emoji.length <= 101);
  assert.ok(emoji.isWellFormed(), 'a surrogate pair is never split');
  assert.equal(emoji, '😀'.repeat(50));
});

test('answerFrom: markers and markdown gone, cards become links, request_human is seen', () => {
  const completion = {
    messages: [
      { role: 'tool_call_invocation', tool_call_id: 't1', name: 'search_properties', arguments: JSON.stringify({ query: 'villa' }) },
      { role: 'tool_call_result', tool_call_id: 't1', content: JSON.stringify(JSON.stringify({ count: 1, results: [{ id: FIRST.id, slug: FIRST.slug }] })) },
      { role: 'agent', content: `**Here** is one:\n- ${FIRST.title.en}\n[[navigate:/properties/houses/]]` },
    ],
  };
  const out = answerFrom(completion, { inventory, siteUrl: SITE, language: 'en' });
  assert.equal(out.handover, false);
  assert.equal(out.links, 1);
  assert.equal(out.text, `Here is one:\n• ${FIRST.title.en}\n\n${FIRST.title.en} — ${inventory.card(FIRST).url.en}`);
  const hand = answerFrom({ messages: [{ role: 'tool_call_invocation', tool_call_id: 't2', name: 'request_human', arguments: '{"reason":"viewing"}' }, { role: 'agent', content: 'The team will reply shortly.' }] }, { inventory, siteUrl: SITE, language: 'en' });
  assert.equal(hand.handover, true);
  assert.deepEqual(answerFrom({ messages: [] }, { inventory, siteUrl: SITE, language: 'en' }), { text: '', handover: false, links: 0 });
  const unreturned = answerFrom({ messages: [
    { role: 'tool_call_invocation', tool_call_id: 't3', name: 'search_properties', arguments: JSON.stringify({ query: 'villa' }) },
    { role: 'agent', content: 'We have a few villas.' },
  ] }, { inventory, siteUrl: SITE, language: 'en' });
  assert.deepEqual(unreturned, { text: 'We have a few villas.', handover: false, links: 0 }, 'no link to a home no tool returned');
  const cardsOnly = answerFrom({ messages: completion.messages.slice(0, 2) }, { inventory, siteUrl: SITE, language: 'en' });
  assert.deepEqual(cardsOnly, { text: '', handover: false, links: 0 }, 'links never go out alone');
  assert.deepEqual(answerFrom(null, { inventory, siteUrl: SITE, language: 'en' }), { text: '', handover: false, links: 0 });
});

/* ---------------- createDana ---------------- */

test('createDana needs the sender and the exclusion rule; without an agent id it is not configured and does nothing', async () => {
  const h = harness();
  assert.throws(() => createDana({ db: h.s, inbox: h.inbox, team: h.team, retell: h.retell, agentId: 'a', isExcludedLead: () => false }), TypeError);
  assert.throws(() => createDana({ db: h.s, inbox: h.inbox, team: h.team, sender: h.sender, retell: h.retell, agentId: 'a' }), TypeError);
  const off = harness({ agentId: null });
  assert.equal(off.dana.configured, false);
  assert.deepEqual(off.dana.status(), { configured: false, enabled: true, pending: 0, inflight: 0 });
  off.client('C1', NOW - 1000, 'hello');
  off.dana.wake(LEAD, NOW - 1000);
  await off.dana.flush();
  assert.deepEqual(await off.dana.answer(LEAD, { ts: NOW - 1000 }), { skipped: 'not_configured' });
  assert.equal(off.calls.length, 0);
  assert.equal(off.retell.chats.length, 0);
});

test('eligibility, in order, each reason on its own', () => {
  const h = harness();
  h.client('C1', NOW - 1000, 'hello');
  assert.equal(h.dana.eligible(LEAD, { ts: NOW - 1000 }).ok, true);
  assert.deepEqual(h.dana.eligible('LEAD-none'), { ok: false, reason: 'not_in_inbox' });
  h.s.updateLead(LEAD, { inbox_state: 'unsure' });
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'not_in_inbox' });
  h.s.updateLead(LEAD, { inbox_state: 'in' });
  h.team.addNever({ phone: CLIENT, note: 'x', by: 'U' });
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'not_in_inbox' }, 'a never-list number is no client');
  h.team.removeNever(CLIENT);
  h.team.setSetting('dana_enabled', '0');
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'off' });
  h.s.updateLead(LEAD, { dana_test: 1 });
  assert.equal(h.dana.eligible(LEAD).ok, true, 'the owner\'s test on this chat overrides the global switch');
  h.s.updateLead(LEAD, { dana_test: 0 });
  h.team.setSetting('dana_enabled', '1');
  h.s.updateLead(LEAD, { dana_off: 1 });
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'chat_off' });
  h.s.updateLead(LEAD, { dana_off: 0, needs_human: 1 });
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'needs_human' });
  h.s.updateLead(LEAD, { needs_human: 0, last_human_out_ts: NOW - HOUR });
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'human_recent' });
  h.tick(HUMAN_QUIET_MS - HOUR - 1);
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'human_recent' }, 'a millisecond short of 24 h');
  h.tick(1);
  assert.equal(h.dana.eligible(LEAD).ok, true, '24 h after the last human message');
  h.s.updateLead(LEAD, { wa_jid: '123456789012345@lid', phone_e164: null, wa_lid: '123456789012345@lid' });
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'lid_only' });
  h.s.updateLead(LEAD, { wa_jid: CLIENT_JID, phone_e164: CLIENT, wa_lid: null });
  assert.deepEqual(h.dana.eligible(LEAD, { ts: h.now() - FRESH_MS - 1 }), { ok: false, reason: 'old' });
  assert.equal(h.dana.eligible(LEAD, { ts: h.now() - FRESH_MS }).ok, true);
  const row = (send_id, created, lead_id = LEAD) => h.s.db.prepare("INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, created, updated) VALUES (?,?,?,?,NULL,'dana','accepted',?,?)").run(send_id, lead_id, CLIENT_JID, 't', created, created);
  for (let i = 0; i < PER_CHAT_PER_HOUR; i += 1) row(`D${i}`, h.now() - 10_000 - i);
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'cap_chat' });
  h.tick(HOUR);
  assert.equal(h.dana.eligible(LEAD).ok, true, 'an hour later');
  h.s.insertLead({ lead_id: 'LEAD-other', created: NOW, updated: NOW, phone_e164: '966522222222', wa_jid: '966522222222@s.whatsapp.net', channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
  for (let i = 0; i < PER_DAY; i += 1) row(`E${i}`, h.now() - 20_000 - i, 'LEAD-other');
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'cap_day' });
});

test('one answer: a Retell chat with the facts and context, the batch as one message, the disclosure once, the message stored as Dana\'s', async () => {
  const h = harness();
  h.human('O0', NOW - 2 * DAY, 'welcome');
  h.client('C0', NOW - 2 * DAY + 1000, 'thanks');
  h.human('O1', NOW - 2 * DAY + 2000, 'any time');
  h.client('C1', NOW - 20_000, 'hello');
  h.client('C2', NOW - 10_000, 'is the villa in Al Khalidiyah still free?');
  h.dana.wake(LEAD, NOW - 20_000);
  h.dana.wake(LEAD, NOW - 10_000);
  await h.dana.flush();

  assert.equal(h.retell.chats.length, 1, 'two wakes, one run, one chat');
  const chat = h.retell.chats[0];
  assert.equal(chat.agent_id, 'agent_wa');
  assert.deepEqual(chat.metadata, { source: 'bona-whatsapp', lead_id: LEAD });
  assert.equal(chat.retell_llm_dynamic_variables.channel, 'whatsapp');
  assert.equal(chat.retell_llm_dynamic_variables.language, 'en');
  assert.match(chat.retell_llm_dynamic_variables.lead_facts, /^Name: Khalid\nInterest: villa in Al Khalidiyah\nStage: new$/);
  assert.equal(chat.retell_llm_dynamic_variables.recent_messages, 'Team: welcome\nClient: thanks\nTeam: any time', 'the history before the batch, not the batch');
  assert.deepEqual(h.retell.completions, [{ chat_id: 'chat_1', content: 'hello\nis the villa in Al Khalidiyah still free?' }]);

  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].body, { number: CLIENT, text: `${DISCLOSURE.en}\n\nOf course. Which district do you prefer?` });
  const stored = h.inbox.messagesFor(LEAD).filter((m) => m.sender_kind === 'dana');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, h.calls[0].body.text);
  assert.equal(stored[0].direction, 'out');
  assert.equal(stored[0].sender_user_id, null);
  const lead = h.lead();
  assert.deepEqual([lead.dana_chat_id, lead.dana_chat_ts, lead.dana_introduced, lead.needs_human, lead.first_reply_ts, lead.last_human_out_ts], ['chat_1', NOW, 1, 0, null, NOW - 2 * DAY + 2000]);
  assert.deepEqual(h.inbox.unansweredClientMessages(LEAD), [], 'answered');
  const line = h.logs.find((l) => l.evt === 'dana.answered');
  assert.deepEqual(line, { evt: 'dana.answered', leadId: LEAD, batch: 2, chars: h.calls[0].body.text.length, links: 0, newChat: true });
  assert.ok(h.logs.some((l) => l.evt === 'dana.session' && l.renewed === false));
  assert.equal(h.notified.length, 0);
  assertClean(h.logs);
});

test('the Retell chat is reused under 23 h idle and renewed after, with the conversation so far as context; no second disclosure', async () => {
  const h = harness();
  h.client('C1', NOW - 5000, 'hello');
  await h.dana.answer(LEAD, { ts: NOW - 5000 });
  h.tick(SESSION_IDLE_MS - 1000);
  h.client('C2', h.now() - 1000, 'still there?');
  const r2 = await h.dana.answer(LEAD, { ts: h.now() - 1000 });
  assert.deepEqual(r2, { answered: true, chars: 'Of course. Which district do you prefer?'.length, links: 0, newChat: false });
  assert.equal(h.retell.chats.length, 1);
  assert.equal(h.retell.completions[1].chat_id, 'chat_1');
  assert.equal(h.calls[1].body.text, 'Of course. Which district do you prefer?', 'introduced already');
  assert.equal(h.lead().dana_chat_ts, h.now());
  h.tick(SESSION_IDLE_MS + 1);
  h.client('C3', h.now() - 1000, 'and now?');
  const r3 = await h.dana.answer(LEAD, { ts: h.now() - 1000 });
  assert.equal(r3.newChat, true);
  assert.equal(h.retell.chats.length, 2);
  assert.equal(h.lead().dana_chat_id, 'chat_2');
  assert.equal(h.retell.chats[1].retell_llm_dynamic_variables.recent_messages,
    `Client: hello\nDana: ${DISCLOSURE.en} Of course. Which district do you prefer?\nClient: still there?\nDana: Of course. Which district do you prefer?`);
  assert.ok(h.logs.some((l) => l.evt === 'dana.session' && l.renewed === true));
  assertClean(h.logs);
});

test('an Arabic client gets the Arabic disclosure and hand-over line', async () => {
  const h = harness({ answer: (body) => agentSays('تمام. أي حي تفضل؟') });
  h.client('C1', NOW - 5000, 'السلام عليكم، عندكم فلل؟');
  await h.dana.answer(LEAD, { ts: NOW - 5000 });
  assert.equal(h.retell.chats[0].retell_llm_dynamic_variables.language, 'ar');
  assert.equal(h.calls[0].body.text, `${DISCLOSURE.ar}\n\nتمام. أي حي تفضل؟`);
});

test('request_human: the flag first, everyone alerted, one line, then silence until a human replies and 24 h pass', async () => {
  let asked = 0;
  const h = harness({
    answer: () => (asked++ === 0
      ? { messages: [{ role: 'tool_call_invocation', tool_call_id: 't', name: 'request_human', arguments: '{"reason":"viewing"}' }, { role: 'tool_call_result', tool_call_id: 't', content: '"{\\"ok\\":true}"' }, { role: 'agent', content: 'Sure, let me get a colleague.' }] }
      : defaultAnswer()),
  });
  h.client('C1', NOW - 5000, 'can I see it tomorrow?');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'request_human', sent: true });
  assert.equal(h.lead().needs_human, 1);
  assert.deepEqual(h.notified, [[LEAD, { reason: 'needs_human' }]]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].body, { number: CLIENT, text: `${DISCLOSURE.en}\n\n${HANDOVER.en}` }, "Dana's own words are dropped; the line is fixed, in code");
  assert.equal(h.inbox.messagesFor(LEAD).filter((m) => m.sender_kind === 'dana').length, 1);
  assert.deepEqual(h.logs.find((l) => l.evt === 'dana.handover'), { evt: 'dana.handover', leadId: LEAD, why: 'request_human', sent: true });

  h.client('C2', NOW - 1000, 'hello??');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 1000 }), { skipped: 'needs_human' });
  assert.equal(h.calls.length, 1, 'no second line, no answer');
  assert.equal(h.notified.length, 1);

  h.human('S1', NOW, 'Sara here, tomorrow at 5 works', 'staff');
  assert.equal(h.lead().needs_human, 0);
  h.tick(HOUR);
  h.client('C3', h.now() - 1000, 'great');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: h.now() - 1000 }), { skipped: 'human_recent' });
  h.tick(HUMAN_QUIET_MS);
  h.client('C4', h.now() - 1000, 'anyone?');
  assert.equal((await h.dana.answer(LEAD, { ts: h.now() - 1000 })).answered, true, 'back after 24 h of team silence');
  assertClean(h.logs);
});

test('a completion that fails on a reused chat is asked once more on a new chat; twice is a hand-over; a chat that cannot be created is one too', async () => {
  let fails = 0;
  const h = harness({
    lead: { dana_chat_id: 'chat_old', dana_chat_ts: NOW - 1000 },
    answer: (body) => { if (body.chat_id === 'chat_old') { fails += 1; const e = new Error('Retell POST -> 404'); e.status = 404; throw e; } return defaultAnswer(); },
  });
  h.client('C1', NOW - 5000, 'hello');
  assert.equal((await h.dana.answer(LEAD, { ts: NOW - 5000 })).newChat, true);
  assert.equal(fails, 1);
  assert.equal(h.retell.chats.length, 1, 'renewed once after the failure');
  assert.equal(h.lead().dana_chat_id, 'chat_1');
  assert.ok(h.logs.some((l) => l.evt === 'dana.session' && l.renewed === true));
  assert.equal(h.calls.length, 1, 'answered');
  assert.deepEqual(h.logs.filter((l) => l.evt === 'dana.retell_failed'), [{ level: 'warn', evt: 'dana.retell_failed', leadId: LEAD, status: 404 }]);

  const dead = harness({ answer: () => { throw new Error('boom'); } });
  dead.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await dead.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'retell_error', sent: true });
  assert.equal(dead.retell.chats.length, 1, 'a fresh chat is not renewed again');
  assert.equal(dead.lead().needs_human, 1);
  assert.deepEqual(dead.calls[0].body.text, `${DISCLOSURE.en}\n\n${HANDOVER.en}`);
  assert.ok(dead.logs.some((l) => l.evt === 'dana.retell_failed' && l.error === 'error'));

  const budget = { taken: 0, refunded: 0, take() { this.taken += 1; return true; }, refund() { this.refunded += 1; } };
  const nochat = harness({ budget });
  nochat.retell.createChat = async () => { throw new Error('down'); };
  nochat.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await nochat.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'retell_error', sent: true });
  assert.deepEqual([budget.taken, budget.refunded], [1, 1], 'the chat unit is given back');
  assertClean(h.logs.concat(dead.logs, nochat.logs));
});

test('a spent budget is a hand-over before Retell is asked; the day and chat caps hand over with the line once', async () => {
  const budget = { take: () => false, refund() {} };
  const h = harness({ budget });
  h.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'budget', sent: true });
  assert.equal(h.retell.chats.length, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.lead().needs_human, 1);

  const c = harness();
  // The clock moves two seconds per exchange: Dana's message is stored at the second it
  // went, and the next client message must be newer than it to count as unanswered.
  for (let i = 0; i < PER_CHAT_PER_HOUR; i += 1) {
    c.tick(2000);
    c.client(`C${i}`, c.now() - 1000, `question ${i}`);
    assert.equal((await c.dana.answer(LEAD, { ts: c.now() - 1000 })).answered, true, `answer ${i}`);
  }
  assert.equal(c.calls.length, PER_CHAT_PER_HOUR);
  c.tick(2000);
  c.client('C7', c.now() - 1000, 'one more');
  assert.deepEqual(await c.dana.answer(LEAD, { ts: c.now() - 1000 }), { handover: 'cap_chat', sent: true });
  assert.equal(c.calls.length, PER_CHAT_PER_HOUR + 1, 'the hand-over line goes once');
  assert.equal(c.lead().needs_human, 1);
  assert.deepEqual(c.notified.at(-1), [LEAD, { reason: 'needs_human' }]);
});

test('an answer with no words is a hand-over', async () => {
  const h = harness({ answer: () => ({ messages: [{ role: 'agent', content: '[[navigate:/tours/]]' }] }) });
  h.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'empty', sent: true });
  const cards = harness({ answer: () => ({ messages: [
    { role: 'tool_call_invocation', tool_call_id: 't1', name: 'search_properties', arguments: JSON.stringify({ query: 'villa' }) },
    { role: 'tool_call_result', tool_call_id: 't1', content: JSON.stringify(JSON.stringify({ count: 1, results: [{ id: FIRST.id, slug: FIRST.slug }] })) },
  ] }) });
  cards.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await cards.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'empty', sent: true }, 'cards with no words are no answer');
  assert.equal(cards.calls[0].body.text, `${DISCLOSURE.en}\n\n${HANDOVER.en}`, 'the line only, no links');
});

test('pre-send: the chat is re-read and a human answer that landed meanwhile drops Dana\'s; a newer client message does not', async () => {
  const refreshed = [];
  const h = harness({
    backfill: { refresh: async (lead) => { refreshed.push(lead.lead_id); h.human('O9', h.now(), 'typed on the phone meanwhile'); return { stored: 1 }; } },
  });
  h.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { skipped: 'dropped_human' });
  assert.deepEqual(refreshed, [LEAD]);
  assert.equal(h.retell.completions.length, 1, 'Retell was asked');
  assert.equal(h.calls.length, 0, 'nothing sent');
  assert.equal(h.lead().needs_human, 0);
  assert.ok(h.logs.some((l) => l.evt === 'dana.skipped' && l.reason === 'dropped_human'));

  const later = harness({ backfill: { refresh: async () => { later.client('C9', later.now(), 'and one more thing'); return { stored: 1 }; } } });
  later.client('C1', NOW - 5000, 'hello');
  assert.equal((await later.dana.answer(LEAD, { ts: NOW - 5000 })).answered, true, 'a newer client message does not drop the answer');
  assert.deepEqual(later.inbox.unansweredClientMessages(LEAD).map((m) => m.key_id), ['C9'], 'her row covers the batch she read; C9 came after it and is the next run\'s');

  const staffPending = harness({ backfill: { refresh: async () => { staffPending.inbox.insertOutbox({ send_id: 'SND-staff00000001', lead_id: LEAD, jid: CLIENT_JID, text: 'on my way', user_id: staffPending.staff.user_id, sender_kind: 'staff' }); return { stored: 0 }; } } });
  staffPending.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await staffPending.dana.answer(LEAD, { ts: NOW - 5000 }), { skipped: 'dropped_human' }, 'a team reply on its way counts');
  const broken = harness({ backfill: { refresh: async () => { throw new Error('evo down'); } } });
  broken.client('C1', NOW - 5000, 'hello');
  assert.equal((await broken.dana.answer(LEAD, { ts: NOW - 5000 })).answered, true, 'a refresh that throws is not a reason to stay silent');
});

test('a hand-over runs the pre-send check: a person who answered, or a switch turned off, meanwhile means nothing happens', async () => {
  const asks = { messages: [{ role: 'tool_call_invocation', tool_call_id: 't', name: 'request_human', arguments: '{}' }, { role: 'agent', content: 'One moment.' }] };
  let h;
  h = harness({ answer: () => { h.human('O9', h.now(), 'typed on the phone meanwhile'); return asks; } });
  h.client('C1', NOW - 5000, 'can I see it?');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { skipped: 'dropped_human' });
  assert.deepEqual([h.calls.length, h.notified.length, h.lead().needs_human], [0, 0, 0]);
  assert.ok(!h.logs.some((l) => l.evt === 'dana.handover'));

  let off;
  off = harness({ answer: () => { off.s.updateLead(LEAD, { dana_off: 1 }); throw new Error('boom'); } });
  off.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await off.dana.answer(LEAD, { ts: NOW - 5000 }), { skipped: 'chat_off' });
  assert.deepEqual([off.calls.length, off.notified.length, off.lead().needs_human], [0, 0, 0]);

  let global;
  global = harness({ answer: () => { global.team.setSetting('dana_enabled', '0'); return asks; } });
  global.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await global.dana.answer(LEAD, { ts: NOW - 5000 }), { skipped: 'off' });
  assert.deepEqual([global.calls.length, global.notified.length], [0, 0]);

  let flagged;
  flagged = harness({ answer: () => { flagged.s.updateLead(LEAD, { needs_human: 1 }); return asks; } });
  flagged.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await flagged.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'request_human', sent: false }, 'flagged meanwhile: the line went already');
  assert.equal(flagged.calls.length, 0);
  assert.deepEqual(flagged.notified, [[LEAD, { reason: 'needs_human' }]]);
  assertClean(h.logs.concat(off.logs, global.logs, flagged.logs));
});

test('a hand-over for a chat that turned lid-only meanwhile flags and alerts, and sends nothing (no phone jid to send to)', async () => {
  const asks = { messages: [{ role: 'tool_call_invocation', tool_call_id: 't', name: 'request_human', arguments: '{}' }, { role: 'agent', content: 'One moment.' }] };
  let h;
  h = harness({ answer: () => { h.s.updateLead(LEAD, { wa_jid: '123456789012345@lid', phone_e164: null }); return asks; } });
  h.client('C1', NOW - 5000, 'can I see it?');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'request_human', sent: false });
  assert.equal(h.lead().needs_human, 1);
  assert.deepEqual(h.notified, [[LEAD, { reason: 'needs_human' }]]);
  assert.equal(h.calls.length, 0, 'nothing went to Evolution');
  assert.deepEqual(h.inbox.openOutboxFor(LEAD), [], 'no outbox row either');
  assert.ok(!h.logs.some((l) => l.evt === 'dana.failed'));
  assert.deepEqual(h.logs.find((l) => l.evt === 'dana.handover'), { evt: 'dana.handover', leadId: LEAD, why: 'request_human', sent: false });
  assertClean(h.logs);
});

test('a cap reached while Dana composes is a hand-over at the pre-send check, not a silent skip', async () => {
  let h;
  h = harness({ answer: () => {
    for (let i = 0; i < PER_CHAT_PER_HOUR; i += 1) h.s.db.prepare("INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, created, updated) VALUES (?,?,?,?,NULL,'dana','accepted',?,?)").run(`D${i}`, LEAD, CLIENT_JID, 't', h.now() - 100, h.now() - 100);
    return defaultAnswer();
  } });
  h.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'cap_chat', sent: true });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.text, HANDOVER.en, 'six sends of hers in this chat: she introduced herself already');
  assert.equal(h.lead().needs_human, 1);
  assertClean(h.logs);
});

test('two answers for one chat at once: the second waits for the first and never answers the same batch', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ answer: async () => { await gate; return defaultAnswer(); } });
  h.client('C1', NOW - 5000, 'hello');
  const a = h.dana.answer(LEAD, { ts: NOW - 5000 });
  const b = h.dana.answer(LEAD, { ts: NOW - 5000 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.dana.status().inflight, 1);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.answered, true);
  assert.deepEqual(rb, { skipped: 'nothing' });
  assert.equal(h.calls.length, 1, 'one send');
  assert.equal(h.retell.completions.length, 1);
  assert.equal(h.dana.status().inflight, 0);
});

test('stop() is final: a wake after it arms nothing', async () => {
  const h = harness();
  await h.dana.stop();
  h.client('C1', NOW - 5000, 'hello');
  h.dana.wake(LEAD, NOW - 5000);
  assert.equal(h.dana.status().pending, 0);
  await h.dana.flush();
  assert.equal(h.calls.length, 0);
});

test('a send that fails leaves the client flagged for the team; an uncertain one is not retried and counts as the introduction', async () => {
  const h = harness({ evo: () => ({ status: 400, body: {} }) });
  h.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'send_failed', sent: false });
  assert.equal(h.lead().needs_human, 1);
  assert.deepEqual(h.notified, [[LEAD, { reason: 'needs_human' }]]);
  assert.equal(h.inbox.messagesFor(LEAD).filter((m) => m.sender_kind === 'dana').length, 0);
  assert.equal(h.lead().dana_introduced, 0);
  assert.ok(h.logs.some((l) => l.evt === 'dana.send_failed' && l.error === 'http_400'));

  const abort = harness({ evo: () => ({ status: 500, body: {} }) });
  abort.client('C1', NOW - 5000, 'hello');
  assert.equal((await abort.dana.answer(LEAD, { ts: NOW - 5000 })).answered, true, 'it may have gone: reported as sent, never retried');
  assert.equal(abort.lead().dana_introduced, 1);
  assert.equal(abort.inbox.getOutbox(abort.inbox.openOutboxFor(LEAD)[0].send_id).status, 'uncertain');
  assert.equal(abort.calls.length, 1);
  assertClean(h.logs.concat(abort.logs));
});

test('a wake during a run runs once more when it lands; stop() drops an armed batch and waits for the run in flight', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const h = harness({ answer: async () => { n += 1; if (n === 1) await gate; return defaultAnswer(); } });
  h.client('C1', NOW - 5000, 'hello');
  h.dana.wake(LEAD, NOW - 5000);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.dana.status().inflight, 1);
  // Stamped a second after the pinned clock: Dana's first answer is stored at NOW, and only
  // a message newer than that is unanswered.
  h.client('C2', NOW + 1000, 'and this');
  h.dana.wake(LEAD, NOW + 1000);
  assert.equal(h.dana.status().pending, 0, 'marked, not armed, while a run is in flight');
  release();
  await h.dana.flush();
  assert.equal(h.retell.completions.length, 2, 'the second message got its own run');
  assert.deepEqual(h.retell.completions.map((c) => c.content), ['hello', 'and this']);
  assert.equal(h.calls.length, 2);

  const s = harness({ answer: async () => { await new Promise((r) => setTimeout(r, 20)); return defaultAnswer(); } });
  s.client('C1', NOW - 5000, 'hello');
  s.dana.wake(LEAD, NOW - 5000);
  await new Promise((r) => setTimeout(r, 5));
  s.client('C2', NOW + 1000, 'again');
  s.dana.wake(LEAD, NOW + 1000);
  await s.dana.stop();
  assert.equal(s.calls.length, 1, 'the run in flight finished; the marked one never started');
  assert.deepEqual(s.dana.status(), { configured: true, enabled: true, pending: 0, inflight: 0 });
  const armed = harness();
  armed.client('C1', NOW - 5000, 'hello');
  armed.dana.wake(LEAD, NOW - 5000);
  assert.equal(armed.dana.status().pending, 1);
  await armed.dana.stop();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(armed.calls.length, 0, 'an armed batch is dropped');
});

test('a client message that arrives while Dana composes is not covered by her answer; her row says what it answered', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ answer: async () => { await gate; return defaultAnswer(); } });
  h.client('C1', NOW - 5000, 'hello');
  const run = h.dana.answer(LEAD, { ts: NOW - 5000 });
  await new Promise((r) => setTimeout(r, 5));
  h.tick(4000);
  h.client('C2', h.now() - 1000, 'and a villa in Obhur?');
  release();
  assert.equal((await run).answered, true);
  const row = h.s.db.prepare("SELECT * FROM wa_outbox WHERE lead_id = ? AND sender_kind = 'dana'").get(LEAD);
  assert.equal(row.covers_ts, NOW - 5000, 'the newest message of the batch she answered');
  assert.equal(row.status, 'accepted');
  assert.equal(row.text, h.calls[0].body.text, 'the row holds exactly what went out');
  assert.deepEqual(h.inbox.unansweredClientMessages(LEAD).map((m) => m.key_id), ['C2'], 'stamped during the round trip: still hers to answer');
  h.dana.wake(LEAD, h.now() - 1000);
  await h.dana.flush();
  assert.equal(h.retell.completions.length, 2);
  assert.equal(h.retell.completions[1].content, 'and a villa in Obhur?');
  assert.deepEqual(h.inbox.unansweredClientMessages(LEAD), []);
});

test('nothing to answer, and a run that throws, are a line each and never a rejection', async () => {
  const h = harness();
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW }), { skipped: 'nothing' });
  h.inbox.unansweredClientMessages = () => { throw new TypeError(`${CLIENT} boom`); };
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW }), { error: 'failed' });
  assert.deepEqual(h.logs.filter((l) => l.evt === 'dana.failed'), [{ level: 'error', evt: 'dana.failed', name: 'TypeError' }]);
  assertClean(h.logs);
});

/* ---------------- whole-branch review fixes (Claude + Codex) ---------------- */

const asksHuman = () => ({ messages: [{ role: 'tool_call_invocation', tool_call_id: 't', name: 'request_human', arguments: '{}' }, { role: 'agent', content: 'One moment.' }] });
const rawDanaRow = (h, sendId, status, created, leadId = LEAD) => h.s.db.prepare("INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, created, updated) VALUES (?,?,?,?,NULL,'dana',?,?,?)").run(sendId, leadId, CLIENT_JID, 't', status, created, created);

test('a cap with no client message waiting is no hand-over: no flag, no alert, no line', async () => {
  const h = harness();
  for (let i = 0; i < PER_CHAT_PER_HOUR; i += 1) rawDanaRow(h, `D${i}`, 'accepted', NOW - 10_000 - i);
  assert.equal(h.dana.eligible(LEAD).reason, 'cap_chat');
  assert.deepEqual(await h.dana.answer(LEAD), { skipped: 'nothing' });
  assert.deepEqual([h.lead().needs_human, h.notified.length, h.calls.length], [0, 0, 0]);
  assert.ok(h.logs.some((l) => l.evt === 'dana.skipped' && l.reason === 'nothing'));
  assert.ok(!h.logs.some((l) => l.evt === 'dana.handover'));
  assertClean(h.logs);
});

test('a person active within 24 h (a message older than the batch, stored meanwhile) stops a hand-over', async () => {
  let h;
  h = harness({ answer: () => {
    h.inbox.upsertMessage({ key_id: 'O8', lead_id: LEAD, jid: CLIENT_JID, direction: 'out', sender_kind: 'owner_number', text: 'typed earlier', ts: NOW - 5000 - 1000 });
    h.inbox.noteHumanOutbound(LEAD, NOW - 5000 - 1000);
    return asksHuman();
  } });
  h.client('C1', NOW - 5000, 'can I see it?');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { skipped: 'human_recent' });
  assert.deepEqual([h.lead().needs_human, h.notified.length, h.calls.length], [0, 0, 0]);
  assert.ok(!h.logs.some((l) => l.evt === 'dana.handover'));
  assertClean(h.logs);
});

test('the disclosure is decided from her sends, not only the flag: an uncertain send counts, a failed one does not', async () => {
  const h = harness();
  rawDanaRow(h, 'SND-crashed000001', 'uncertain', NOW - 60_000);
  assert.equal(h.lead().dana_introduced, 0);
  h.client('C1', NOW - 5000, 'hello');
  assert.equal((await h.dana.answer(LEAD, { ts: NOW - 5000 })).answered, true);
  assert.equal(h.calls[0].body.text, 'Of course. Which district do you prefer?', 'a send that may have gone introduced her');

  const f = harness();
  rawDanaRow(f, 'SND-failed0000001', 'failed', NOW - 60_000);
  f.client('C1', NOW - 5000, 'hello');
  assert.equal((await f.dana.answer(LEAD, { ts: NOW - 5000 })).answered, true);
  assert.equal(f.calls[0].body.text, `${DISCLOSURE.en}\n\nOf course. Which district do you prefer?`, 'a failed send never went');
});

test('the Sending switch off: Dana is not eligible, Retell is not asked, and a hand-over does nothing', async () => {
  const h = harness();
  h.team.setSetting('sending_enabled', '0');
  h.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(h.dana.eligible(LEAD, { ts: NOW - 5000 }), { ok: false, reason: 'sending_off' });
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { skipped: 'sending_off' });
  assert.equal(h.retell.chats.length, 0);
  assert.ok(!h.logs.some((l) => l.evt === 'dana.skipped'), 'a state, not logged');

  let g;
  g = harness({ answer: () => { g.team.setSetting('sending_enabled', '0'); return asksHuman(); } });
  g.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await g.dana.answer(LEAD, { ts: NOW - 5000 }), { skipped: 'sending_off' });
  assert.deepEqual([g.lead().needs_human, g.notified.length, g.calls.length], [0, 0, 0]);
});
