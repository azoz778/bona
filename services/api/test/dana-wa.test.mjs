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
  BACKLOG_MS, LEGACY_DISCLOSURE, CLOSING, FIXED_LINES, requestKind, handoffDetails, brainInput, fixedLinesFrom, NEUTRAL, LEGACY_MAX_LINKS,
  LEGACY_FRESH_MS, LEGACY_PER_CHAT_PER_HOUR, LEGACY_PER_DAY,
  PER_CHAT_PER_10MIN, PER_CHAT_PER_DAY, PER_DAY_TIERS,
} from '../lib/dana-wa.mjs';
import { createFakeBrain, brainReply, brainError } from '../lib/brain/fake.mjs';
import { createBrain, KEY_NAME } from '../lib/brain.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createPacing, TIERS } from '../lib/pacing.mjs';
import { NOT_ANSWER_LINES } from '../lib/dashboard/stats.mjs';
import * as danaCommitModule from '../lib/dana-commit.mjs';
import {
  disclosure, disclosureVariants, disclosureFor, HANDOVER_VARIANTS, OUT_OF_HOURS, OUTAGE_OUT_OF_HOURS, handoverLine, outageLine, variantIndex,
} from '../lib/persona.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* A real brain (lib/brain.mjs) on a fake OpenAI: only for the request-body tests. */
const brainTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-dana-brain-'));
test.after(() => fs.rmSync(brainTmp, { recursive: true, force: true }));
const reply200 = (content) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
function realBrain(script) {
  const keyFile = path.join(brainTmp, `key-${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(keyFile, `${KEY_NAME}=sk-test-not-a-real-key-000000000000\n`, { mode: 0o600 });
  const bodies = [];
  const queue = [...script];
  const fetchImpl = async (url, init = {}) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(queue.length ? queue.shift() : reply200('ok')), { status: 200 });
  };
  const brain = createBrain({
    cfg: loadConfig({ env: {}, ids: {}, home: path.join(brainTmp, 'no-home') }), keyFile, fetchImpl,
    runTool: async () => JSON.stringify({ count: 0, results: [] }), siteFacts: { ok: () => true, block: (l) => `SITE-FACTS-${l}`, version: () => 1 },
    now: () => Date.parse('2026-11-29T12:00:00+03:00'), sleep: async () => {},
  });
  return { brain, bodies };
}

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

function harness({ answer = defaultAnswer, agentId = 'agent_wa', enabled = true, lead = {}, alerts = true, budget = null, backfill = null, evo = null, funds = null, notifyHandoff = async () => {} } = {}) {
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
    db: s, inbox, team, sender, retell, inventory, notifyHandoff, siteUrl: SITE, agentId, budget, backfill, ...(funds ? { funds: funds(team, () => clock) } : {}),
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
  // PR-B3 (DESIGN §4.2, §6.3, §6.5): fresh for 2 h; the caps count TURNS, by warm-up tier.
  assert.equal(FRESH_MS, 2 * HOUR);
  assert.deepEqual([PER_CHAT_PER_HOUR, PER_DAY, CONTEXT_MESSAGES, MAX_LINKS, MAX_ANSWER_LEN], [20, 60, 10, 2, 1500]);
  assert.deepEqual([PER_CHAT_PER_10MIN, PER_CHAT_PER_DAY], [10, 40]);
  assert.deepEqual(PER_DAY_TIERS, [60, 120, 200], 'PER_DAY by tier (days 0-7, 8-21, 22+); PER_DAY is the strictest');
  // A legacy (Retell) chat keeps main's numbers until go-live (PLAN §2 row 7, the r1 ruling).
  assert.deepEqual([LEGACY_FRESH_MS, LEGACY_PER_CHAT_PER_HOUR, LEGACY_PER_DAY], [30 * 60_000, 6, 200]);
  // The brain migration: nameless (lib/persona.mjs).
  assert.equal(DISCLOSURE.en, "Bona's AI assistant");
  assert.equal(DISCLOSURE.ar, 'مساعدة بونا بالذكاء الاصطناعي', 'says AI explicitly, not just "smart"');
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

test('recent context: Client / Team / Assistant (you) lines, media as placeholders, the batch left out, the newest kept inside the caps', () => {
  const m = (key_id, direction, sender_kind, text, media_type = null, ts = NOW) => ({ key_id, direction, sender_kind, text, media_type, ts });
  const rows = [
    m('a', 'in', 'client', 'hi'), m('b', 'out', 'owner_number', 'welcome'), m('c', 'out', 'staff', 'any time'),
    m('d', 'out', 'dana', 'sure'), m('e', 'in', 'client', null, '[voice note]'), m('f', 'in', 'client', 'the new one'),
  ];
  assert.equal(recentContext(rows, { exclude: new Set(['f']) }), 'Client: hi\nTeam: welcome\nTeam: any time\nAssistant (you): sure\nClient: [voice note]');
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

test('links: a card whose URL is not in the text is appended in the client\'s language, at most two (DESIGN §6.5), never twice', () => {
  const cards = inventory.all().slice(0, 5).map((l) => inventory.card(l));
  const en = withLinks('Two homes for you.', cards, 'en');
  assert.equal(en.links, 2);
  assert.equal(en.text.split('\n\n').length, 3);
  assert.ok(en.text.endsWith(cards[1].url.en));
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

test('LEGACY GUARD (main\'s outcome, PR-B3 r1): eligibility, in order, each reason on its own', () => {
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
  assert.deepEqual(h.dana.eligible(LEAD, { ts: h.now() - LEGACY_FRESH_MS - 1 }), { ok: false, reason: 'old' });
  assert.equal(h.dana.eligible(LEAD, { ts: h.now() - LEGACY_FRESH_MS }).ok, true);
  const row = (send_id, created, lead_id = LEAD) => h.s.db.prepare("INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, created, updated) VALUES (?,?,?,?,NULL,'dana','accepted',?,?)").run(send_id, lead_id, CLIENT_JID, 't', created, created);
  for (let i = 0; i < LEGACY_PER_CHAT_PER_HOUR; i += 1) row(`D${i}`, h.now() - 10_000 - i);
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'cap_chat' });
  h.tick(HOUR);
  assert.equal(h.dana.eligible(LEAD).ok, true, 'an hour later');
  h.s.insertLead({ lead_id: 'LEAD-other', created: NOW, updated: NOW, phone_e164: '966522222222', wa_jid: '966522222222@s.whatsapp.net', channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
  for (let i = 0; i < LEGACY_PER_DAY; i += 1) row(`E${i}`, h.now() - 20_000 - i, 'LEAD-other');
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
  assert.deepEqual(h.calls[0].body, { number: CLIENT, text: `${LEGACY_DISCLOSURE.en}\n\nOf course. Which district do you prefer?` });
  const stored = h.inbox.messagesFor(LEAD).filter((m) => m.sender_kind === 'dana');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, h.calls[0].body.text);
  assert.equal(stored[0].direction, 'out');
  assert.equal(stored[0].sender_user_id, null);
  const lead = h.lead();
  // Her answer counts as the first reply (2026-10-05 design R1); the human clock is untouched.
  assert.deepEqual([lead.dana_chat_id, lead.dana_chat_ts, lead.dana_introduced, lead.needs_human, lead.first_reply_ts, lead.last_human_out_ts], ['chat_1', NOW, 1, 0, NOW, NOW - 2 * DAY + 2000]);
  assert.deepEqual(h.inbox.unansweredClientMessages(LEAD), [], 'answered');
  const { latencyMs, stages, ...line } = h.logs.find((l) => l.evt === 'dana.answered');
  assert.deepEqual(line, { evt: 'dana.answered', leadId: LEAD, batch: 2, chars: h.calls[0].body.text.length, links: 0, newChat: true });
  assert.equal(latencyMs, 10_000, 'from the newest client message');
  assert.deepEqual(Object.keys(stages).sort(), ['batch', 'brain', 'guard', 'hold', 'poll']);
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
    `Client: hello\nAssistant (you): ${LEGACY_DISCLOSURE.en} Of course. Which district do you prefer?\nClient: still there?\nAssistant (you): Of course. Which district do you prefer?`);
  assert.ok(h.logs.some((l) => l.evt === 'dana.session' && l.renewed === true));
  assertClean(h.logs);
});

test('an Arabic client gets the Arabic disclosure and hand-over line', async () => {
  const h = harness({ answer: (body) => agentSays('تمام. أي حي تفضل؟') });
  h.client('C1', NOW - 5000, 'السلام عليكم، عندكم فلل؟');
  await h.dana.answer(LEAD, { ts: NOW - 5000 });
  assert.equal(h.retell.chats[0].retell_llm_dynamic_variables.language, 'ar');
  assert.equal(h.calls[0].body.text, `${LEGACY_DISCLOSURE.ar}\n\nتمام. أي حي تفضل؟`);
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
  assert.deepEqual(h.calls[0].body, { number: CLIENT, text: `${LEGACY_DISCLOSURE.en}\n\n${HANDOVER.en}` }, "Dana's own words are dropped; the line is fixed, in code");
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
  assert.deepEqual(dead.calls[0].body.text, `${LEGACY_DISCLOSURE.en}\n\n${HANDOVER.en}`);
  assert.ok(dead.logs.some((l) => l.evt === 'dana.retell_failed' && l.error === 'error'));

  const budget = { taken: 0, refunded: 0, take() { this.taken += 1; return true; }, refund() { this.refunded += 1; } };
  const nochat = harness({ budget });
  nochat.retell.createChat = async () => { throw new Error('down'); };
  nochat.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await nochat.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'retell_error', sent: true });
  assert.deepEqual([budget.taken, budget.refunded], [1, 1], 'the chat unit is given back');
  assertClean(h.logs.concat(dead.logs, nochat.logs));
});

test('LEGACY GUARD (main\'s outcome, PR-B3 r1): a spent budget is a hand-over before Retell is asked; the day and chat caps hand over with the line once', async () => {
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
  for (let i = 0; i < LEGACY_PER_CHAT_PER_HOUR; i += 1) {
    c.tick(2000);
    c.client(`C${i}`, c.now() - 1000, `question ${i}`);
    assert.equal((await c.dana.answer(LEAD, { ts: c.now() - 1000 })).answered, true, `answer ${i}`);
  }
  assert.equal(c.calls.length, LEGACY_PER_CHAT_PER_HOUR);
  c.tick(2000);
  c.client('C7', c.now() - 1000, 'one more');
  assert.deepEqual(await c.dana.answer(LEAD, { ts: c.now() - 1000 }), { handover: 'cap_chat', sent: true });
  assert.equal(c.calls.length, LEGACY_PER_CHAT_PER_HOUR + 1, 'the hand-over line goes once');
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
  assert.equal(cards.calls[0].body.text, `${LEGACY_DISCLOSURE.en}\n\n${HANDOVER.en}`, 'the line only, no links');
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

test('LEGACY GUARD (main\'s outcome, PR-B3 r1): a cap reached while Dana composes is a hand-over at the pre-send check, not a silent skip', async () => {
  let h;
  h = harness({ answer: () => {
    for (let i = 0; i < LEGACY_PER_CHAT_PER_HOUR; i += 1) h.s.db.prepare("INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, created, updated) VALUES (?,?,?,?,NULL,'dana','accepted',?,?)").run(`D${i}`, LEAD, CLIENT_JID, 't', h.now() - 100, h.now() - 100);
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
  assert.equal(f.calls[0].body.text, `${LEGACY_DISCLOSURE.en}\n\nOf course. Which district do you prefer?`, 'a failed send never went');
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

/* ---------------- R1: Dana's answer counts as the first reply (2026-10-05 design) ---------------- */

test('an answer stamps first_reply_ts only while it is NULL; a later answer, or one already answered, leaves it', async () => {
  const h = harness();
  h.client('C1', NOW - 5000, 'hello');
  await h.dana.answer(LEAD, { ts: NOW - 5000 });
  assert.equal(h.lead().first_reply_ts, NOW);
  h.tick(HOUR);
  h.client('C2', h.now() - 1000, 'and the price?');
  assert.equal((await h.dana.answer(LEAD, { ts: h.now() - 1000 })).answered, true);
  assert.equal(h.lead().first_reply_ts, NOW, 'the first reply is the first');

  const earlier = harness({ lead: { first_reply_ts: NOW - DAY } });
  earlier.client('C1', NOW - 5000, 'hello');
  await earlier.dana.answer(LEAD, { ts: NOW - 5000 });
  assert.equal(earlier.lead().first_reply_ts, NOW - DAY);
});

test('an answer to a chat that left the inbox while it was on its way stamps nothing', async () => {
  let h = null;
  h = harness({ evo: (n) => { h.s.updateLead(LEAD, { inbox_state: 'unsure' }); return { status: 201, body: { key: { id: `KEY-${n}` } } }; } });
  h.client('C1', NOW - 5000, 'hello');
  assert.equal((await h.dana.answer(LEAD, { ts: NOW - 5000 })).answered, true);
  assert.equal(h.lead().first_reply_ts, null);
});

test('the hand-over line never stamps first_reply_ts: the client waits for a person, the watchdog keeps pinging', async () => {
  const h = harness({ answer: () => ({ messages: [{ role: 'tool_call_invocation', tool_call_id: 't', name: 'request_human', arguments: '{}' }] }) });
  h.client('C1', NOW - 5000, 'can I see it?');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'request_human', sent: true });
  assert.equal(h.calls.length, 1, 'the line went');
  assert.equal(h.lead().first_reply_ts, null);
});

test('an uncertain send does not stamp first_reply_ts (a missed ping is worse than an extra one)', async () => {
  const h = harness({ evo: () => ({ status: 500, body: {} }) });
  h.client('C1', NOW - 5000, 'hello');
  assert.equal((await h.dana.answer(LEAD, { ts: NOW - 5000 })).answered, true);
  assert.equal(h.lead().dana_introduced, 1);
  assert.equal(h.lead().first_reply_ts, null);
});

/* ---------------- R2: Retell out of credit (2026-10-05 design) ---------------- */

const paymentRequired = () => { const e = new Error('Retell POST -> 402'); e.name = 'RetellError'; e.status = 402; return e; };
/** A funds watch double that counts what Dana told it. */
const fundsSpy = () => {
  const seen = { out: 0, ok: 0 };
  return { seen, make: () => ({ out: () => { seen.out += 1; return Promise.resolve(null); }, ok: () => { seen.ok += 1; } }) };
};

test('a 402 on createChat is funds.out() and still a hand-over for the client', async () => {
  const f = fundsSpy();
  const h = harness({ funds: f.make });
  h.retell.createChat = async () => { throw paymentRequired(); };
  h.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'retell_error', sent: true });
  assert.deepEqual(f.seen, { out: 1, ok: 0 });
  assert.deepEqual(h.notified, [[LEAD, { reason: 'needs_human' }]], 'the team still hears of the client');
  assert.equal(h.calls[0].body.text, `${LEGACY_DISCLOSURE.en}\n\n${HANDOVER.en}`);
  assert.deepEqual(h.logs.find((l) => l.evt === 'dana.retell_failed'), { level: 'warn', evt: 'dana.retell_failed', leadId: LEAD, status: 402 });
  assertClean(h.logs);
});

test('a 402 on createChatCompletion is funds.out(); a createChat that worked clears nothing', async () => {
  const f = fundsSpy();
  const h = harness({ funds: f.make, answer: () => { throw paymentRequired(); } });
  h.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'retell_error', sent: true });
  assert.deepEqual(f.seen, { out: 1, ok: 0 }, 'only a completion that works says the credit is back');

  // A reused chat whose completion is refused: asked again on a new chat, refused again.
  const g = fundsSpy();
  const r = harness({ funds: g.make, lead: { dana_chat_id: 'chat_old', dana_chat_ts: NOW - 1000 }, answer: () => { throw paymentRequired(); } });
  r.client('C1', NOW - 5000, 'hello');
  assert.equal((await r.dana.answer(LEAD, { ts: NOW - 5000 })).handover, 'retell_error');
  assert.deepEqual(g.seen, { out: 2, ok: 0 });
});

test('a completion that works is funds.ok(); other errors never touch the funds', async () => {
  const f = fundsSpy();
  const h = harness({ funds: f.make });
  h.client('C1', NOW - 5000, 'hello');
  assert.equal((await h.dana.answer(LEAD, { ts: NOW - 5000 })).answered, true);
  assert.deepEqual(f.seen, { out: 0, ok: 1 }, 'the completion, not the createChat');

  for (const status of [400, 401, 404, 429, 500, undefined]) {
    const g = fundsSpy();
    const bad = harness({ funds: g.make });
    bad.retell.createChat = async () => { const e = new Error('nope'); e.status = status; throw e; };
    bad.client('C1', NOW - 5000, 'hello');
    assert.equal((await bad.dana.answer(LEAD, { ts: NOW - 5000 })).handover, 'retell_error');
    assert.deepEqual(g.seen, { out: 0, ok: 0 }, `status ${status}`);
  }
});

test('a funds watch that throws never costs the client the answer or the hand-over', async () => {
  const boom = () => ({ out: () => { throw new Error('watch down'); }, ok: () => { throw new Error('watch down'); } });
  const h = harness({ funds: boom });
  h.client('C1', NOW - 5000, 'hello');
  assert.equal((await h.dana.answer(LEAD, { ts: NOW - 5000 })).answered, true);
  const r = harness({ funds: boom });
  r.retell.createChat = async () => { throw paymentRequired(); };
  r.client('C1', NOW - 5000, 'hello');
  assert.deepEqual(await r.dana.answer(LEAD, { ts: NOW - 5000 }), { handover: 'retell_error', sent: true });
});

test('end to end with the real watch: two 402s push the owners once, a later success clears the flag', async () => {
  const { createFundsWatch, fundsOutSince } = await import('../lib/dana-funds.mjs');
  const pushed = [];
  let fail = true;
  const h = harness({
    funds: (team, now) => createFundsWatch({ team, now, alerts: { notifyOwners: (o) => { pushed.push(o); return Promise.resolve({ users: 1, devices: 1, ok: 1, gone: 0, failed: 0 }); } } }),
    answer: () => { if (fail) throw paymentRequired(); return defaultAnswer(); },
  });
  h.client('C1', NOW - 5000, 'hello');
  await h.dana.answer(LEAD, { ts: NOW - 5000 });
  assert.equal(fundsOutSince(h.team), NOW);
  assert.deepEqual(pushed, [{ reason: 'funds' }]);
  // The flag cleared by hand (no human message, so no 24 h quiet), an hour later: refused again.
  h.inbox.setNeedsHuman(LEAD, 0);
  h.tick(HOUR);
  h.client('C2', h.now() - 1000, 'hello again');
  assert.equal((await h.dana.answer(LEAD, { ts: h.now() - 1000 })).handover, 'retell_error');
  assert.equal(pushed.length, 1, 'no second push within 6 h');
  // The stored chat's completion is refused, the new chat made for the retry works (no ok:
  // only a completion says the credit is back), its completion is refused — out since the first refusal.
  assert.equal(fundsOutSince(h.team), NOW);
  // Topped up: the next answer clears the flag.
  fail = false;
  h.inbox.setNeedsHuman(LEAD, 0);
  h.tick(HOUR);
  h.client('C3', h.now() - 1000, 'anyone?');
  assert.equal((await h.dana.answer(LEAD, { ts: h.now() - 1000 })).answered, true);
  assert.equal(fundsOutSince(h.team), null);
  assert.equal(pushed.length, 1);
});

test('createChat working and the completion refused never clears the flag in between', async () => {
  const { createFundsWatch, fundsOutSince } = await import('../lib/dana-funds.mjs');
  const seen = [];
  const h = harness({
    funds: (team, now) => {
      const real = createFundsWatch({ team, now, alerts: { notifyOwners: () => Promise.resolve({ ok: 1 }) } });
      return { out: () => { seen.push(['out', fundsOutSince(team)]); return real.out(); }, ok: () => { seen.push(['ok', fundsOutSince(team)]); real.ok(); } };
    },
    lead: { dana_chat_id: 'chat_old', dana_chat_ts: NOW - 1000 },
    answer: () => { throw paymentRequired(); },
  });
  h.team.setSetting('retell_funds_out', String(NOW - HOUR));
  h.client('C1', NOW - 5000, 'hello');
  assert.equal((await h.dana.answer(LEAD, { ts: NOW - 5000 })).handover, 'retell_error');
  assert.equal(h.retell.chats.length, 1, 'a new chat was made for the retry, and it worked');
  assert.deepEqual(seen, [['out', NOW - HOUR], ['out', NOW - HOUR]], 'no ok() at any point');
  assert.equal(fundsOutSince(h.team), NOW - HOUR, 'out since the first refusal');
});


test('Dana explicit no-match handoff records buyer needs once and stops bot replies',async()=>{
 const h=harness({answer:()=>({messages:[{role:'tool_call_invocation',name:'request_human',arguments:JSON.stringify({reason:'serious buyer',no_match:true,budget:'3 million SAR',area:'Riyadh',property_type:'villa',timeframe:'This year'})}]})});
 h.client('NEEDS1',NOW-5000,'Please ask Abdulaziz to help find a villa');
 await h.dana.answer(LEAD,{ts:NOW-5000});
 const rows=h.s.db.prepare("SELECT * FROM lead_tasks WHERE lead_id=? AND kind='handoff'").all(LEAD);
 assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0].details).no_match,true);assert.equal(JSON.parse(rows[0].details).area,'Riyadh');assert.equal(rows[0].telegram_status,'disabled');
 h.client('NEEDS2',NOW-1000,'Any update?');assert.equal((await h.dana.answer(LEAD,{ts:NOW-1000})).skipped,'needs_human');assert.equal(h.calls.length,1);
});



test('handoff commit failure never leaves a paused bot without a task; retry recovers',async()=>{
 const h=harness({answer:()=>({messages:[{role:'tool_call_invocation',name:'request_human',arguments:'{}'}]})});
 h.client('ATOMIC1',NOW-5000,'I want a person');h.s.db.exec("CREATE TRIGGER fail_task BEFORE INSERT ON lead_tasks BEGIN SELECT RAISE(ABORT,'test interruption'); END");
 assert.equal((await h.dana.answer(LEAD,{ts:NOW-5000})).error,'failed');assert.equal(h.lead().needs_human,0);assert.equal(h.calls.length,0);assert.equal(h.s.db.prepare('SELECT COUNT(*) n FROM lead_tasks').get().n,0);
 h.s.db.exec('DROP TRIGGER fail_task');await h.dana.answer(LEAD,{ts:NOW-5000});assert.equal(h.lead().needs_human,1);assert.equal(h.s.db.prepare('SELECT COUNT(*) n FROM lead_tasks').get().n,1);
});
test('a rejected Dana send creates a durable owner handoff and pauses replies',async()=>{
 const h=harness({evo:()=>({status:400,body:{}})});h.client('FAILSEND',NOW-5000,'Tell me about this home');
 const result=await h.dana.answer(LEAD,{ts:NOW-5000});assert.equal(result.handover,'send_failed');assert.equal(h.lead().needs_human,1);assert.equal(h.s.db.prepare("SELECT reason FROM lead_tasks WHERE lead_id=?").get(LEAD).reason,'send_failed');
});

test('Dana handoff and rejected-send paths notify only after durable needs-human and task writes',async()=>{
 for(const reject of [false,true]){
  let h;const seen=[];h=harness({answer:reject?defaultAnswer:()=>({messages:[{role:'tool_call_invocation',name:'request_human',arguments:JSON.stringify({no_match:true,budget:'6 million'})},{role:'agent',content:'The team will reply shortly.'}]}),evo:reject?()=>({status:400}):null,notifyHandoff:async id=>{
   assert.equal(h.s.getLead(id).needs_human,1);const task=h.s.db.prepare("SELECT * FROM lead_tasks WHERE lead_id=? AND kind='handoff'").get(id);assert.ok(task);seen.push(task);
  }});
  try{h.client('C-tg',NOW-5000,'I would like a villa');await h.dana.answer(LEAD,{ts:NOW-5000});assert.equal(seen.length,1);if(!reject)assert.equal(JSON.parse(seen[0].details).no_match,true);}finally{await h.dana.stop();h.s.close();}
 }
});

/* ======================================================================================
 * PR-B3 (PLAN T12): gates, holds, pacing, never-first, caps, the stop words, request_human's kind,
 * the wording and the brain branch. A fake brain (lib/brain/fake.mjs), a fake owner test, fake
 * notes that record every call in order, and an immediate pacing unless a test hands in its own.
 * ====================================================================================== */

const T_IN = Date.parse('2026-11-29T12:00:00+03:00'); // a Sunday, inside office hours
const T_OUT = Date.parse('2026-11-27T21:00:00+03:00'); // a Friday evening
const NAMED = { name: { en: 'Dana', ar: 'دانة' } };

/** Fake owner notes: every call in order, never a send. */
function fakeNotes() {
  const calls = [];
  return {
    calls,
    handover: (lead, o) => { calls.push(['handover', lead?.lead_id ?? lead, o]); return { queued: true }; },
    stopped: (lead, reason) => { calls.push(['stopped', lead?.lead_id ?? lead, reason]); return { queued: true }; },
    alert: (code, meta) => { calls.push(['alert', code, meta]); return { queued: true }; },
    of: (kind) => calls.filter((c) => c[0] === kind),
  };
}
const immediate = { batchMs: () => 0, batchDelay: () => 0, typingFloorMs: () => 0, fifo: (fn) => fn(), tier: () => ({ ...TIERS[0] }) };

/**
 * A chat for the brain branch. `auto` makes LEAD an auto-mode lead (the owner's test chat, or own_inbox);
 * `brainOn` sets dana_brain '1'. Every client message is stored through `client()` at the fake clock.
 */
function bh({
  turns = [], auto = true, brainOn = false, configured = true, health = null, lead = {}, evo = null, pacing = immediate, commit,
  link = null, wa = null, retellAnswer = defaultAnswer, retell: withRetell = true, agentId = 'agent_wa', enabled = true, at = T_IN,
  brain: givenBrain = null, env = ENV, notes: givenNotes = null,
} = {}) {
  const s = openDb(':memory:');
  let clock = at;
  const team = createTeam(s, { now: () => clock });
  team.ensureOwner({ phone: '966500000009', name: 'Owner' });
  if (enabled) team.setSetting('dana_enabled', '1');
  if (brainOn) team.setSetting('dana_brain', '1');
  const inbox = createInboxStore(s, { now: () => clock });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = evo ? evo(calls.length, JSON.parse(init.body)) : { status: 201, body: { key: { id: `KEY-${calls.length}` } } };
    if (r.throws) throw r.throws;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  const sender = createSender({ env, team, inbox, db: s, fetchImpl, now: () => clock });
  const retell = withRetell ? {
    chats: [], completions: [],
    async createChat(body) { this.chats.push(body); return { chat_id: `chat_${this.chats.length}` }; },
    async createChatCompletion(body) { this.completions.push(body); return retellAnswer(body, this); },
  } : null;
  const brain = givenBrain ?? createFakeBrain({ turns, configured, health });
  const notes = givenNotes ?? fakeNotes();
  const pushed = [];
  const owners = [];
  const logs = [];
  const autoLeads = new Set(auto ? [LEAD] : []);
  const ownerTest = { autoMode: (l) => autoLeads.has(l?.lead_id), active: () => true, ownNumberOk: () => true, setAuto: (id, on) => (on ? autoLeads.add(id) : autoLeads.delete(id)) };
  s.insertLead({
    lead_id: LEAD, created: at - DAY, updated: at - DAY, phone_e164: CLIENT, wa_jid: CLIENT_JID, name: 'Khalid', channel: 'whatsapp',
    match_method: 'ref', stage: 'new', stage_ts: at - DAY, inbox_state: 'in', inbox_since: at - DAY, interest: 'villa in Al Khalidiyah', ...lead,
  });
  const slept = [];
  const laters = []; // side effects she schedules (the read receipt, "composing"): run by a test that wants them
  const build = (b = brain, n = notes) => createDana({
    db: s, inbox, team, sender, retell, inventory, siteUrl: SITE, agentId, brain: b, ownerTest, notes: n, pacing, link, wa,
    ...(commit ? { commit } : {}),
    alerts: { notify: (id, o) => { pushed.push([id, o]); return Promise.resolve({}); }, notifyOwners: (o) => { owners.push(o); return Promise.resolve({}); } },
    isExcludedLead: (l) => isExcludedLead(team, s, l), now: () => clock, log: (o) => logs.push(o), batchMs: 0,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    later: (ms, fn) => { laters.push({ ms, fn }); },
  });
  const dana = build();
  /** A restart: a new createDana on the same database, with a brain and notes of its own. */
  const restart = (turns2 = [], o = {}) => {
    const b = createFakeBrain({ turns: turns2, configured: true, ...o });
    const n = fakeNotes();
    return { dana: build(b, n), brain: b, notes: n };
  };
  let k = 0;
  const client = (text, { ts = clock, id = LEAD, media = null } = {}) => {
    k += 1;
    inbox.upsertMessage({ key_id: `C${k}`, lead_id: id, jid: id === LEAD ? CLIENT_JID : `9665000000${String(k).padStart(2, '0')}@s.whatsapp.net`, direction: 'in', sender_kind: 'client', text, media_type: media, ts });
    return ts;
  };
  const staff = (text, ts = clock) => { k += 1; inbox.upsertMessage({ key_id: `S${k}`, lead_id: LEAD, jid: CLIENT_JID, direction: 'out', sender_kind: 'staff', text, ts }); };
  const danaRow = ({ covers, created = clock, text = 'ok', status = 'accepted', guarded = 0, id = LEAD, error = null, media = null }) => {
    k += 1;
    s.db.prepare(`INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error, covers_ts, guarded, media_kind)
                  VALUES (?,?,?,?,NULL,'dana',?,NULL,?,?,?,?,?,?)`).run(`SND-R-${String(k).padStart(8, '0')}`, id, CLIENT_JID, text, status, created, created, error, covers, guarded, media);
  };
  const sent = () => calls.filter((c) => /\/message\//.test(c.url)).map((c) => c.body.text ?? c.body.caption);
  return {
    s, team, inbox, sender, retell, brain, notes, dana, calls, pushed, owners, logs, ownerTest, client, staff, danaRow, sent, slept, restart, laters,
    lead: () => s.getLead(LEAD), tick: (ms) => { clock += ms; }, now: () => clock, set: (t) => { clock = t; },
  };
}
const ask = async (h, text, o = {}) => { const ts = h.client(text, o); return h.dana.answer(o.id ?? LEAD, { ts }); };

/* ---------- 1. gates ---------- */

test('T12 gates: identity (only once the link is wired), rule_off for own_number and owner_test, needs_human in legacy mode only, holds', async () => {
  const idBad = bh({ wa: { ownNumberFrom: 'instance' }, link: { identityOk: () => false, linkStable: () => true } });
  idBad.client('hello');
  assert.deepEqual(idBad.dana.eligible(LEAD), { ok: false, reason: 'identity' });
  assert.deepEqual(await idBad.dana.answer(LEAD, { ts: idBad.now() }), { skipped: 'identity' });
  await idBad.dana.answer(LEAD, { ts: idBad.now() });
  assert.deepEqual(idBad.owners, [{ reason: 'identity_mismatch' }], 'one owner alert, not one per message');
  assert.equal(idBad.brain.calls.length, 0);
  assert.equal(bh({ wa: { ownNumberFrom: 'owner' }, link: { identityOk: () => false } }).dana.eligible(LEAD).ok, true, 'shared mode: no identity gate');
  assert.equal(bh({ wa: { ownNumberFrom: 'instance' } }).dana.eligible(LEAD).ok, true, 'no link handed in (before PR-INT): no gate');

  const own = bh({ lead: { inbox_via: 'own_number' } });
  own.ownerTest.ownNumberOk = () => false;
  assert.deepEqual(own.dana.eligible(LEAD), { ok: false, reason: 'rule_off' });
  own.ownerTest.ownNumberOk = () => true;
  assert.equal(own.dana.eligible(LEAD).ok, true);
  const tst = bh({ lead: { inbox_via: 'owner_test' } });
  tst.ownerTest.active = () => false;
  assert.deepEqual(tst.dana.eligible(LEAD), { ok: false, reason: 'rule_off' });

  const legacy = bh({ auto: false, lead: { needs_human: 1 } });
  assert.deepEqual(legacy.dana.eligible(LEAD), { ok: false, reason: 'needs_human' }, 'legacy: an open hand-over still silences her');
  const autoH = bh({ auto: true, lead: { needs_human: 1 } });
  assert.equal(autoH.dana.eligible(LEAD).ok, true, 'auto mode: needs_human is the dashboard flag, not a gate');

  const held = bh({ lead: { dana_hold_reason: 'cap_chat', dana_hold_until: T_IN + 60_000 } });
  assert.deepEqual(held.dana.eligible(LEAD), { ok: false, reason: 'hold' });
  held.tick(60_000);
  assert.equal(held.dana.eligible(LEAD).ok, true, 'a timed hold ends at its time');
  const untilHuman = bh({ lead: { dana_hold_reason: 'loop', dana_hold_until: null } });
  untilHuman.tick(30 * DAY);
  assert.deepEqual(untilHuman.dana.eligible(LEAD), { ok: false, reason: 'hold' }, 'a hold with no time waits for a person');
});

/* ---------- 2. freshness and backlog ---------- */

test('T12 freshness: FRESH 2 h; 30 min to 2 h is backlog, answered only on a stable link and under 10 backlog answers an hour', async () => {
  assert.equal(FRESH_MS, 2 * HOUR);
  assert.equal(BACKLOG_MS, 30 * 60_000);
  let stable = false;
  const h = bh({ turns: Array.from({ length: 12 }, () => brainReply('Of course.')), link: { identityOk: () => true, linkStable: () => stable } });
  h.client('hello', { ts: T_IN - 45 * 60_000 });
  assert.deepEqual(await h.dana.answer(LEAD, { ts: T_IN - 45 * 60_000 }), { skipped: 'backlog' });
  assert.equal(h.brain.calls.length, 0, 'no model call while the link has not held');
  stable = true;
  assert.equal((await h.dana.sweep()).woken, 1, 'the sweep picks the waiting chat up');
  await h.dana.flush();
  assert.equal(h.calls.length, 1, 'answered once the link held');
  // Ten backlog first-answers in the hour, then the eleventh waits.
  const many = bh({ turns: Array.from({ length: 12 }, () => brainReply('Of course.')), link: { identityOk: () => true, linkStable: () => true } });
  for (let i = 0; i < 11; i += 1) {
    const id = `LEAD-B${String(i).padStart(2, '0')}`;
    many.s.insertLead({ lead_id: id, created: T_IN - DAY, updated: T_IN - DAY, phone_e164: `9665000001${String(i).padStart(2, '0')}`, wa_jid: `9665000001${String(i).padStart(2, '0')}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
    many.ownerTest.setAuto(id, true); // backlog is a brain chat's rule (r1)
    many.client('hi', { id, ts: T_IN - 40 * 60_000 });
  }
  const out = [];
  for (let i = 0; i < 11; i += 1) {
    out.push(await many.dana.answer(`LEAD-B${String(i).padStart(2, '0')}`, { ts: T_IN - 40 * 60_000 }));
    many.tick(61_000); // past the sender's 8 a minute
  }
  assert.equal(out.filter((r) => r.answered).length, 10);
  assert.deepEqual(out[10], { skipped: 'backlog' });
});

test('T12 freshness: a message over 2 h old is never answered: a hand-over `missed` with no line, and the hand-over note', async () => {
  const h = bh({ turns: [brainReply('late')] });
  h.client('anyone?', { ts: T_IN - 2 * HOUR - 1 });
  const r = await h.dana.answer(LEAD, { ts: T_IN - 2 * HOUR - 1 });
  assert.equal(r.handover, 'missed');
  assert.equal(r.sent, false);
  assert.equal(h.calls.length, 0, 'no line: the client gets a person');
  assert.equal(h.brain.calls.length, 0);
  assert.equal(h.lead().needs_human, 1);
  assert.equal(h.s.db.prepare("SELECT reason FROM lead_tasks WHERE lead_id = ? AND kind = 'handoff'").get(LEAD).reason, 'missed');
  assert.deepEqual(h.notes.of('handover').map((c) => c[2].kind), ['missed']);
  assert.equal(h.pushed.length, 1);
});

/* ---------- 3. never-first ---------- */

test('T12 never-first: a covers_ts that is no stored client message, or one over 24 h old, is no_open_chat in eligible', () => {
  const h = bh();
  const ts = h.client('hello');
  assert.equal(h.dana.eligible(LEAD, { coversTs: ts }).ok, true);
  assert.deepEqual(h.dana.eligible(LEAD, { coversTs: ts + 1 }), { ok: false, reason: 'no_open_chat' });
  h.tick(DAY + 1);
  assert.deepEqual(h.dana.eligible(LEAD, { coversTs: ts }), { ok: false, reason: 'no_open_chat' });
});

/* ---------- 4. caps per turn ---------- */

test('T12 caps: counted per turn — the bubbles of one turn are one; 10 turns in 10 min hold the chat until the window frees, then a re-wake answers', async () => {
  const h = bh({ turns: [brainReply('Of course.')] });
  for (let i = 0; i < 9; i += 1) {
    const covers = h.client(`q${i}`, { ts: T_IN - 9 * 60_000 + i * 1000 });
    h.danaRow({ covers, created: covers + 500 });
    h.danaRow({ covers, created: covers + 600, text: 'brochure' }); // a document bubble of the same turn
  }
  assert.equal(h.inbox.countDanaTurns({ leadId: LEAD, sinceTs: T_IN - HOUR }), 9);
  assert.equal(h.dana.eligible(LEAD).ok, true, 'nine turns, eighteen rows: under the 10-minute cap');
  const tenth = h.client('q9', { ts: T_IN - 60_000 });
  h.danaRow({ covers: tenth, created: tenth + 500 });
  const e = h.dana.eligible(LEAD);
  assert.equal(e.reason, 'cap_chat');
  assert.equal(e.until, T_IN - 9 * 60_000 + 500 + 10 * 60_000, 'until the oldest turn of the window is 10 min old');
  h.client('one more?');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: h.now() }), { skipped: 'cap_chat' });
  assert.deepEqual([h.lead().dana_hold_reason, h.lead().dana_hold_until], ['cap_chat', e.until]);
  assert.deepEqual([h.calls.length, h.brain.calls.length, h.pushed.length, h.notes.calls.length], [0, 0, 0, 0], 'no line, no alert, no model call');
  h.set(e.until);
  assert.equal((await h.dana.sweep()).woken, 1);
  await h.dana.flush();
  assert.equal(h.calls.length, 1, 'the re-wake at expiry answered the newest message');
  assert.equal(h.lead().dana_hold_reason, null);
});

test('T12 caps: 20 turns in an hour hold the chat; 40 in a day hand over (no line) with an alert', async () => {
  const h = bh();
  for (let i = 0; i < 20; i += 1) {
    const covers = h.client(`q${i}`, { ts: T_IN - 50 * 60_000 + i * 120_000 });
    h.danaRow({ covers, created: covers + 500 });
  }
  const e = h.dana.eligible(LEAD);
  assert.equal(e.reason, 'cap_chat');
  assert.equal(e.until, T_IN - 50 * 60_000 + 500 + HOUR);
  const d = bh();
  for (let i = 0; i < 40; i += 1) {
    const covers = d.client(`q${i}`, { ts: T_IN - 20 * HOUR + i * 25 * 60_000 });
    d.danaRow({ covers, created: covers + 500 });
  }
  assert.equal(d.dana.eligible(LEAD).reason, 'cap_chat_day');
  d.client('again?');
  const r = await d.dana.answer(LEAD, { ts: d.now() });
  assert.deepEqual(r, { handover: 'cap_chat_day', sent: false });
  assert.equal(d.calls.length, 0);
  assert.equal(d.lead().needs_human, 1);
  assert.equal(d.pushed.length, 1);
  assert.deepEqual(d.notes.of('handover').map((c) => c[2].kind), ['cap_day'], "the note says today's limit, never 'hourly' (r1)");
});

test('T12 caps: the day cap by warm-up tier (BONA_WA_LINKED_AT on a fake clock; unset = the strictest) → cap_day, no client line, an alert', async () => {
  const fill = (h, n) => {
    for (let i = 0; i < n; i += 1) {
      const id = `LEAD-X${String(i).padStart(3, '0')}`;
      h.s.insertLead({ lead_id: id, created: T_IN - DAY, updated: T_IN - DAY, phone_e164: `96650001${String(i).padStart(4, '0')}`, wa_jid: `96650001${String(i).padStart(4, '0')}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
      h.danaRow({ covers: T_IN - HOUR + i, created: T_IN - HOUR + i, id });
    }
  };
  for (const [days, cap] of [[null, 60], [3, 60], [10, 120], [25, 200]]) {
    const pacing = createPacing({ cfg: { waLinkedAt: days === null ? null : T_IN - days * DAY }, now: () => T_IN });
    const h = bh({ pacing: { ...immediate, tier: pacing.tier } });
    fill(h, cap - 1);
    assert.equal(h.dana.eligible(LEAD).ok, true, `${days}: ${cap - 1} turns`);
    fill(h, 0);
    h.danaRow({ covers: T_IN - 1, created: T_IN - 1, id: 'LEAD-X000' });
    assert.equal(h.dana.eligible(LEAD).reason, 'cap_day', `${days}: ${cap} turns fill the day`);
  }
  const pacing = createPacing({ cfg: { waLinkedAt: null }, now: () => T_IN });
  const h = bh({ pacing: { ...immediate, tier: pacing.tier } });
  fill(h, 60);
  h.client('hello');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: h.now() }), { handover: 'cap_day', sent: false });
  assert.equal(h.calls.length, 0, 'no client line');
  assert.equal(h.pushed.length, 1, 'the hand-over alert');
  assert.deepEqual(h.notes.of('handover').map((c) => c[2].kind), ['cap_day']);
});

/* ---------- 5. loop guard ---------- */

test('T12 loop guard: the same text 3 times in an hour, or more than 20 messages in 10 min, holds the chat until a person writes', async () => {
  const h = bh({ turns: [brainReply('one'), brainReply('two')] });
  await ask(h, 'price?', { ts: T_IN - 30 * 60_000 });
  await ask(h, 'price?', { ts: T_IN - 20 * 60_000 });
  const r = await ask(h, 'price?');
  assert.deepEqual(r, { skipped: 'loop' });
  assert.deepEqual([h.lead().dana_hold_reason, h.lead().dana_hold_until], ['loop', null]);
  assert.equal(h.brain.calls.length, 2, 'the third is never asked');
  assert.deepEqual(h.notes.of('stopped').map((c) => c[2]), ['loop']);
  const burst = bh();
  for (let i = 0; i < 21; i += 1) burst.client(`m${i}`, { ts: T_IN - 9 * 60_000 + i * 1000 });
  assert.deepEqual(await burst.dana.answer(LEAD, { ts: T_IN }), { skipped: 'loop' });
  assert.equal(burst.brain.calls.length, 0);
});

/* ---------- 6. send failures ---------- */

test('T12 send failures: 2 counted failures in one chat within 24 h hold it (send_failed); local refusals never count', async () => {
  const h = bh({ turns: [brainReply('a'), brainReply('b'), brainReply('c')], evo: () => ({ status: 400 }) });
  const first = await ask(h, 'hello');
  assert.equal(first.handover, 'send_failed');
  assert.equal(h.lead().dana_hold_reason, null, 'one failure: no hold');
  h.tick(60_000);
  await ask(h, 'still there?');
  assert.deepEqual([h.lead().dana_hold_reason, h.lead().dana_hold_until], ['send_failed', null]);
  // Local refusals: BONA_WA_NOTIFY=0 ('disabled') counts for neither rule and is no send_failed hand-over.
  const l = bh({ turns: [brainReply('a'), brainReply('b'), brainReply('c')], env: { ...ENV, BONA_WA_NOTIFY: '0' } });
  for (let i = 0; i < 3; i += 1) {
    const r = await ask(l, `q${i}`);
    assert.deepEqual(r, { skipped: 'disabled' });
    l.tick(60_000);
  }
  assert.deepEqual([l.lead().dana_hold_reason, l.lead().needs_human, l.team.getSetting('dana_enabled')], [null, 0, '1']);
  assert.equal(l.s.db.prepare("SELECT COUNT(*) n FROM lead_tasks WHERE reason = 'send_failed'").get().n, 0);
});

test('T12 send failures: 3 counted failures in 30 min overall trip the breaker: dana_enabled 0 by `system`, an owner alert', async () => {
  const h = bh({ turns: Array.from({ length: 5 }, () => brainReply('hello')), evo: () => ({ status: 500 }) });
  for (let i = 0; i < 3; i += 1) {
    const id = i === 0 ? LEAD : `LEAD-F${i}`;
    if (i) {
      h.s.insertLead({ lead_id: id, created: T_IN - DAY, updated: T_IN - DAY, phone_e164: `96650000020${i}`, wa_jid: `96650000020${i}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
      h.ownerTest.setAuto(id, true);
    }
    await ask(h, 'hi', { id });
    h.tick(5 * 60_000);
  }
  assert.equal(h.team.getSetting('dana_enabled'), '0');
  assert.equal(h.s.db.prepare("SELECT updated_by FROM settings WHERE key = 'dana_enabled'").get().updated_by, 'system');
  assert.deepEqual(h.owners, [{ reason: 'dana_paused' }]);
  assert.deepEqual(h.notes.of('alert').map((c) => c[1]), ['breaker']);
  assert.equal(h.dana.health().breaker, true);
  h.team.setSetting('dana_enabled', '1', { by: 'USR-owner' });
  assert.equal(h.dana.health().breaker, false, '#dana on (or the Team page) turns her back on');
});

test('T12 send failures: a rate_limited Dana send is a 60 s timed hold cap_chat, then a re-wake answers; never a send failure', async () => {
  let refuse = true;
  const h = bh({ turns: [brainReply('one'), brainReply('two')] });
  const real = h.sender.sendTo;
  // The sender's own refusal: it closes the row it was given, as wa-send does.
  h.sender.sendTo = async (o) => {
    if (!refuse) return real(o);
    h.inbox.updateOutbox(o.sendId, { status: 'failed', error: 'rate_limited' });
    return { ok: false, error: 'rate_limited', failure: 'local', sendId: o.sendId };
  };
  assert.deepEqual(await ask(h, 'hello'), { skipped: 'cap_chat' });
  assert.deepEqual([h.lead().dana_hold_reason, h.lead().dana_hold_until], ['cap_chat', T_IN + 60_000]);
  assert.equal(h.lead().needs_human, 0);
  refuse = false;
  h.tick(60_000);
  assert.equal((await h.dana.sweep()).woken, 1);
  await h.dana.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.sent()[0].endsWith('two'), true);
});

/* ---------- 7. request_human ---------- */

test('T12 request_human: the kind comes from the raw tool call; privacy → dana_off though handoffDetails drops the kind; unknown → other', async () => {
  const completion = { messages: [{ role: 'tool_call_invocation', name: 'request_human', arguments: JSON.stringify({ kind: 'privacy', reason: 'what do you keep' }) }] };
  assert.equal(Object.hasOwn(handoffDetails(completion), 'kind'), false, 'cleanNeeds strips it');
  assert.equal(requestKind(completion), 'privacy');
  assert.equal(requestKind({ toolCalls: [{ name: 'request_human', args: { kind: 'robots' } }] }), 'other');
  assert.equal(requestKind({ toolCalls: [{ name: 'request_human', args: {} }] }), 'other');
  // Legacy (fake Retell): dana_off, today's hand-over line, needs_human.
  const legacy = bh({ auto: false, retellAnswer: () => completion });
  await ask(legacy, 'what do you keep about me?');
  assert.deepEqual([legacy.lead().dana_off, legacy.lead().needs_human], [1, 1]);
  assert.deepEqual(legacy.sent(), [`${LEGACY_DISCLOSURE.en}\n\n${HANDOVER.en}`]);
  // Auto mode (fake brain): the closing line, dana_off, the stopped note.
  const auto = bh({ turns: [brainReply('', { tools: [{ name: 'request_human', args: { kind: 'deletion' } }] })] });
  await ask(auto, 'please remove what you hold on me');
  assert.equal(auto.lead().dana_off, 1);
  assert.equal(auto.sent()[0].endsWith(CLOSING.en), true);
  assert.deepEqual(auto.notes.of('stopped').map((c) => c[2]), ['deletion']);
});

test('T12 request_human in auto mode: a repeat while needs_human=1 sends the model text (no canned line) and alerts every time', async () => {
  const rh = (kind, text) => brainReply(text, { tools: [{ name: 'request_human', args: { kind } }] });
  const h = bh({ turns: [rh('offer', 'x'), rh('offer', 'The team has your offer; anything else meanwhile?'), rh('viewing', 'Noted, they will arrange it.')] });
  const first = await ask(h, 'I want to offer 3M');
  assert.equal(first.handover, 'request_human');
  assert.equal(h.sent()[0].endsWith(HANDOVER.en), true, 'the first: the hand-over line (inside hours: variant 0)');
  h.tick(60_000);
  const again = await ask(h, 'any news on my offer?');
  assert.equal(again.answered, true);
  assert.equal(h.sent()[1], 'The team has your offer; anything else meanwhile?', 'the model text, no canned line');
  h.tick(60_000);
  await ask(h, 'can I see it Sunday?');
  assert.deepEqual(h.notes.of('handover').map((c) => c[2].kind), ['offer', 'offer', 'viewing'], 'notes.handover every time');
});

test('T12 request_human: stop / privacy / deletion → the closing line, dana_off and a stopped note', async () => {
  for (const kind of ['stop', 'privacy', 'deletion']) {
    const h = bh({ turns: [brainReply('ok', { tools: [{ name: 'request_human', args: { kind } }] })] });
    await ask(h, 'hmm');
    assert.equal(h.lead().dana_off, 1, kind);
    assert.equal(h.sent().length, 1);
    assert.ok(h.sent()[0].endsWith(CLOSING.en), kind);
    assert.deepEqual(h.notes.of('stopped').map((c) => c[2]), [kind]);
  }
});

/* ---------- 7b. the code stop-word check ---------- */

test('T12 stop words: a stop or data request is answered in code with NO model call (auto: closing line + stopped note; legacy: today\'s hand-over)', async () => {
  const hits = ['إيقاف', 'stop', 'احذف بياناتي', 'delete my data', 'سياسة الخصوصية', 'لا ترد عليّ'];
  for (const text of hits) {
    const a = bh({ turns: [brainReply('never')] });
    await ask(a, text);
    assert.equal(a.brain.calls.length, 0, text);
    assert.equal(a.retell.completions.length, 0, text);
    assert.equal(a.lead().dana_off, 1, text);
    const lang = /[؀-ۿ]/.test(text) ? 'ar' : 'en';
    assert.ok(a.sent()[0].endsWith(CLOSING[lang]), `${text}: the closing line`);
    assert.equal(a.notes.of('stopped').length, 1, text);
    const l = bh({ auto: false });
    await ask(l, text);
    assert.equal(l.retell.completions.length, 0, text);
    assert.equal(l.brain.calls.length, 0, text);
    assert.deepEqual([l.lead().dana_off, l.lead().needs_human], [1, 1], text);
    assert.ok(l.sent()[0].endsWith(HANDOVER[lang]), `${text}: today's hand-over line for a legacy lead`);
    assert.equal(l.pushed.length, 1, "today's push");
    assert.equal(l.notes.of('stopped').length, 0, 'no stopped note outside auto mode');
  }
  for (const text of ['does the bus stop near the villa?', 'هل يوجد موقف سيارات خاص بالفيلا؟', 'is it privately owned?', 'أبي فيلا فيها خصوصية', 'هذه بياناتي: محمد، ميزانيتي 3 مليون', 'this is my number, call me']) {
    const a = bh({ turns: [brainReply('Sure.')] });
    await ask(a, text);
    assert.equal(a.brain.calls.length, 1, `${text}: the model IS called`);
    assert.equal(a.lead().dana_off, 0, text);
  }
});

/* ---------- 8. wording ---------- */

test('T12 wording: DISCLOSURE is nameless (variant 0); "keep Dana" gives today\'s; no variant names her; picked by hash', () => {
  assert.equal(DISCLOSURE.en, "Bona's AI assistant");
  assert.equal(DISCLOSURE.ar, 'مساعدة بونا بالذكاء الاصطناعي', 'says AI explicitly, not just "smart"');
  assert.equal(disclosure('en', NAMED), "Dana — Bona's AI assistant", 'keep Dana');
  assert.equal(disclosure('ar', NAMED), 'دانة — مساعدة بونا بالذكاء الاصطناعي');
  assert.deepEqual(LEGACY_DISCLOSURE, { en: "Dana — Bona's AI assistant", ar: 'دانة — مساعدة بونا بالذكاء الاصطناعي' }, "a legacy (Retell) lead keeps today's line until the flip");
  for (const l of ['en', 'ar']) {
    for (const v of [...disclosureVariants(l), ...HANDOVER_VARIANTS[l]]) assert.doesNotMatch(v, /Dana|دانة/);
  }
  assert.equal(HANDOVER.en, 'Thank you — a member of the Bona team will reply to you shortly.', "variant 0 is today's constant");
  assert.equal(HANDOVER.ar, 'شكراً لك، أحد أعضاء فريق بونا بيرد عليك قريباً.');
});

test('T12 wording: the hand-over line is time-aware (Sun-Thu 10-19 → the hashed variant; else out of hours); the outage line drops "I can help now"', async () => {
  // A lead id whose hash picks variant 0, and one that does not.
  const v0 = Array.from({ length: 200 }, (_, i) => `LEAD-V${i}`).find((id) => variantIndex(id) === 0);
  assert.equal(handoverLine({ leadId: v0, language: 'en', at: T_IN }), HANDOVER.en);
  assert.equal(handoverLine({ leadId: v0, language: 'en', at: T_OUT }), OUT_OF_HOURS.en);
  assert.equal(outageLine({ language: 'en', at: T_IN }), HANDOVER.en);
  assert.equal(outageLine({ language: 'ar', at: T_OUT }), 'وصلت رسالتك لفريق بونا، ويردّون من الأحد إلى الخميس 10:00–19:00.');
  assert.doesNotMatch(outageLine({ language: 'en', at: T_OUT }), /I can help now/);
  assert.doesNotMatch(outageLine({ language: 'ar', at: T_OUT }), /أقدر أساعدك الحين/);
  // Through dana-wa: an auto lead's hand-over out of hours is the out-of-hours text; a brain lead's first line carries its hashed disclosure.
  const h = bh({ at: T_OUT, turns: [brainReply('', { tools: [{ name: 'request_human', args: { kind: 'person' } }] })] });
  await ask(h, 'a person please');
  assert.equal(h.sent()[0], `${disclosureFor(LEAD, 'en')}\n\n${OUT_OF_HOURS.en}`);
});

test('T12 wording: FIXED_LINES holds every fixed line code sends as a dana row; stats reads it', () => {
  for (const l of ['en', 'ar']) {
    for (const line of [...HANDOVER_VARIANTS[l], OUT_OF_HOURS[l], OUTAGE_OUT_OF_HOURS[l], CLOSING[l]]) assert.ok(FIXED_LINES.includes(line), line);
  }
  assert.deepEqual(NOT_ANSWER_LINES, FIXED_LINES);
  // dana-commit's BOOKING_FAILED_LINE (PR-B4) is listed whenever that module defines it: a fake, then the real module.
  const fake = { en: 'Fake booking-failed line.', ar: 'سطر تجريبي.' };
  const withFake = fixedLinesFrom({ bookingFailed: fake });
  assert.ok(withFake.includes(fake.en) && withFake.includes(fake.ar));
  assert.equal(withFake.length, fixedLinesFrom().length + 2);
  for (const line of Object.values(danaCommitModule.BOOKING_FAILED_LINE ?? {})) assert.ok(FIXED_LINES.includes(line), line);
});

/* ---------- 8b. the brain branch ---------- */

test('T12 brain branch: useBrain = autoMode || dana_brain 1; neither ever falls back to Retell', async () => {
  const testLead = bh({ turns: [brainReply('From the brain.')], lead: { inbox_via: 'owner_test' } });
  await ask(testLead, 'hello');
  assert.equal(testLead.brain.calls.length, 1);
  assert.equal(testLead.retell.completions.length, 0);
  const legacy = bh({ auto: false, turns: [brainReply('never')] });
  await ask(legacy, 'hello');
  assert.equal(legacy.brain.calls.length, 0, 'dana_brain 0: the fake brain is never called');
  assert.equal(legacy.retell.completions.length, 1);
  const flipped = bh({ auto: false, brainOn: true, turns: [brainReply('From the brain.')] });
  await ask(flipped, 'hello');
  assert.equal(flipped.brain.calls.length, 1);
  assert.equal(flipped.retell.completions.length, 0);
  for (const o of [{ auto: true }, { auto: false, brainOn: true }]) {
    const off = bh({ ...o, configured: false });
    off.client('hello');
    assert.deepEqual(off.dana.eligible(LEAD), { ok: false, reason: 'not_configured' });
    assert.deepEqual(await off.dana.answer(LEAD, { ts: off.now() }), { skipped: 'not_configured' });
    assert.equal(off.retell.completions.length + off.retell.chats.length, 0, 'no silent Retell fallback');
  }
});

test('T12 brain branch: the turn input — inboxTurn history, batchParts, the raw lead facts, earlier guarded replies; no dana_chat_id, no budget', async () => {
  const h = bh({ turns: [brainReply('Of course.')] });
  h.client('hello', { ts: T_IN - 3 * HOUR });
  h.danaRow({ covers: T_IN - 3 * HOUR, created: T_IN - 3 * HOUR + 1000, text: 'Welcome! Villas from SAR 2,950,000.', guarded: 1 });
  h.inbox.upsertMessage({ key_id: 'D1', lead_id: LEAD, jid: CLIENT_JID, direction: 'out', sender_kind: 'dana', text: 'Welcome! Villas from SAR 2,950,000.', ts: T_IN - 3 * HOUR + 1000 });
  h.danaRow({ covers: T_IN - 3 * HOUR, created: T_IN - 3 * HOUR + 2000, text: 'Unit B08-19 is SAR 1,800,000.', guarded: 0 });
  h.staff('We can do 2.7M for you.', T_IN - 2 * HOUR);
  h.client('first part', { ts: T_IN - 2000 });
  h.client('second part', { ts: T_IN - 1000 });
  await h.dana.answer(LEAD, { ts: T_IN - 1000 });
  const input = h.brain.calls[0];
  assert.equal(input.route, 'wa');
  assert.equal(input.leadId, LEAD);
  assert.equal(input.autoMode, true);
  assert.deepEqual(input.history.map((t) => t.role), ['user', 'assistant', 'team']);
  assert.deepEqual(input.batchParts, ['first part', 'second part']);
  assert.equal(input.batchText, 'first part\nsecond part');
  assert.deepEqual(input.leadFacts, { name: 'Khalid', interest: 'villa in Al Khalidiyah', budget: null, district: null, listing_id: null, stage: 'new', timeline: null });
  assert.deepEqual(input.earlierReplies, ['Welcome! Villas from SAR 2,950,000.'], 'only guarded=1 dana rows');
  assert.equal(input.turnContext.firstReply, false, 'introduced by her earlier rows');
  assert.equal(h.lead().dana_chat_id, null, 'a brain turn never writes dana_chat_id');
  assert.equal(h.retell.chats.length, 0);
});

test('T12 brain branch: an empty batchParts never reaches turn(): the batch rows themselves are its parts', () => {
  const batch = [{ key_id: 'k1', direction: 'in', text: 'call 050' }, { key_id: 'k2', direction: 'in', text: '123 4567' }];
  const fromRows = brainInput({ rows: [], batch });
  assert.equal(fromRows.batchParts.length, 2, 'the history rows missed the batch: its own rows are the parts');
  assert.doesNotMatch(fromRows.batchText, /050|123 4567/, 'masked as one series');
  const none = brainInput({ rows: [], batch: [] });
  assert.equal(Object.hasOwn(none, 'batchParts'), false, 'no batch rows: no batchParts at all (turn() would take [] over batchText)');
});

test('T12 brain branch: a phone split across the history clip and the batch never reaches OpenAI (the real brain, a fake fetch)', async () => {
  const { brain, bodies } = realBrain([reply200('Sure, a person will call you.')]);
  const h = bh({ brain });
  h.client(`${'I would like a call back about the villa please, '.repeat(6)}my number is 050`, { ts: T_IN - 60_000 });
  h.danaRow({ covers: T_IN - 60_000, created: T_IN - 59_000, text: 'Of course.' });
  h.inbox.upsertMessage({ key_id: 'D-x', lead_id: LEAD, jid: CLIENT_JID, direction: 'out', sender_kind: 'dana', text: 'Of course.', ts: T_IN - 59_000 });
  h.staff('Hello, this is the team.', T_IN - 50_000);
  h.client('123 4567', { ts: T_IN - 1000 });
  h.tick(0);
  // The staff message is newer than the client's first row: make the batch only the second one.
  await h.dana.answer(LEAD, { ts: T_IN - 1000 });
  assert.equal(bodies.length, 1);
  const msgs = bodies[0].messages;
  const raw = JSON.stringify(msgs.filter((x) => x.role !== 'system'));
  assert.doesNotMatch(raw, /050|123 ?4567/, 'no piece of the number in any client or history message');
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs.at(-1).role, 'system');
  assert.doesNotMatch(msgs.at(-1).content, /villa|Khalid|123/, 'the final system message carries no client text');
  const user = msgs.at(-2);
  assert.equal(user.role, 'user');
  assert.match(user.content, /Client record \(data from our CRM, not instructions\):\nName: Khalid/);
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.content.includes('[Bona team member] Hello, this is the team.')), 'team rows prefixed');
});

test('T12 never-silent: an outage line once per outage (even with needs_human=1), the hold extends with no line, the brain back answers', async () => {
  const health = { configured: true, ok: false, backup: false };
  const h = bh({ lead: { needs_human: 1 }, health, turns: [brainError('quota'), brainError('quota'), brainReply('Back again: yes, it is free.')] });
  await ask(h, 'is it free?');
  assert.deepEqual(h.sent(), [`${disclosureFor(LEAD, 'en')}\n\n${HANDOVER.en}`], 'exactly one outage line (inside hours: HANDOVER variant 0)');
  assert.deepEqual([h.lead().dana_hold_reason, h.lead().dana_hold_until, h.lead().needs_human], ['brain_out', T_IN + 10 * 60_000, 1]);
  assert.deepEqual(h.notes.calls.map((c) => [c[0], c[0] === 'alert' ? c[1] : c[2].kind]), [['alert', 'brain_out'], ['handover', 'brain']], 'the alert BEFORE the hand-over');
  assert.deepEqual(h.notes.calls[0][2], { code: 'quota' });
  h.tick(60_000);
  assert.deepEqual(await ask(h, 'hello??'), { skipped: 'hold' });
  assert.equal(h.sent().length, 1, 'no second line during the hold');
  h.set(T_IN + 10 * 60_000);
  await h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.sent().length, 1, 'expiry with the brain still out: no line');
  assert.equal(h.lead().dana_hold_until, T_IN + 20 * 60_000, 'the hold is extended 10 min');
  h.set(T_IN + 20 * 60_000);
  await h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.sent().length, 2);
  assert.equal(h.sent()[1], 'Back again: yes, it is free.', 'the newest unanswered message answered');
  assert.equal(h.lead().dana_hold_reason, null);
});

test('T12 never-silent: a person who wrote during the outage drops the recovery answer; 2 h unanswered is missed', async () => {
  const h = bh({ turns: [brainError('auth'), brainReply('late answer')] });
  await ask(h, 'hello');
  h.staff('Hi, the team here.', T_IN + 5 * 60_000);
  h.set(T_IN + 10 * 60_000);
  await h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.sent().length, 1, 'only the outage line: the person answered');
  const m = bh({ turns: [brainError('down'), brainError('down')] });
  await ask(m, 'hello');
  m.set(T_IN + 2 * HOUR + 1);
  await m.dana.sweep();
  await m.dana.flush();
  assert.deepEqual(m.notes.of('handover').map((c) => c[2].kind), ['brain', 'missed']);
  assert.equal(m.sent().length, 1, 'missed: no second line');
  assert.equal(m.lead().dana_hold_reason, null);
});

test('T12 brain failures: refusal → a hand-over other/brain_refusal after ONE call; guard → price_guard, the text never sent or stored', async () => {
  const r = bh({ turns: [brainError('refusal'), brainReply('never')] });
  const out = await ask(r, 'hello');
  assert.equal(out.handover, 'brain_refusal');
  assert.equal(r.brain.calls.length, 1, 'no retry');
  assert.deepEqual(r.notes.of('handover').map((c) => [c[2].kind, c[2].reason]), [['other', 'brain_refusal']]);
  const g = bh({ turns: [brainError('guard')] });
  assert.equal((await ask(g, 'price?')).handover, 'price_guard');
  assert.deepEqual(g.notes.of('handover').map((c) => c[2].kind), ['price_guard']);
  // The guard in dana-wa: a price no tool returned this turn is never sent or stored.
  const d = bh({ turns: [brainReply('It is SAR 1,800,000.')] });
  assert.equal((await ask(d, 'price?')).handover, 'price_guard');
  assert.equal(d.sent().some((t) => t.includes('1,800,000')), false);
  assert.equal(d.inbox.messagesFor(LEAD).some((m) => (m.text ?? '').includes('1,800,000')), false);
  assert.equal(d.s.db.prepare("SELECT COUNT(*) n FROM wa_outbox WHERE text LIKE '%1,800,000%'").get().n, 0);
});

test('T12 the guard\'s earlier amounts: a guarded dana row allows its price again; a Retell-era row or a staff row does not; brain bubbles carry guarded=1', async () => {
  const price = 'Villas start from SAR 2,950,000.';
  const ok = bh({ turns: [brainReply(price)] });
  ok.client('hi', { ts: T_IN - HOUR });
  ok.danaRow({ covers: T_IN - HOUR, created: T_IN - HOUR + 1000, text: price, guarded: 1 });
  assert.equal((await ask(ok, 'and the price again?')).answered, true);
  const sentRow = ok.s.db.prepare("SELECT guarded FROM wa_outbox WHERE status = 'accepted' ORDER BY created DESC LIMIT 1").get();
  assert.equal(sentRow.guarded, 1, 'a brain turn that passed the guard');
  const retellEra = bh({ turns: [brainReply(price)] });
  retellEra.client('hi', { ts: T_IN - HOUR });
  retellEra.danaRow({ covers: T_IN - HOUR, created: T_IN - HOUR + 1000, text: price, guarded: 0 });
  assert.equal((await ask(retellEra, 'and the price again?')).handover, 'price_guard');
  const staffSaid = bh({ turns: [brainReply('As agreed, SAR 2,700,000.')] });
  staffSaid.staff('For you: SAR 2,700,000.', T_IN - 25 * HOUR);
  assert.equal((await ask(staffSaid, 'confirm the price?')).handover, 'price_guard');
  const legacy = bh({ auto: false });
  await ask(legacy, 'hello');
  assert.equal(legacy.s.db.prepare("SELECT guarded FROM wa_outbox WHERE status = 'accepted'").get().guarded, 0, 'a legacy Retell turn: 0');
});

test('T12 legacy guard (green before): a legacy lead on the fake Retell behaves exactly as before', async () => {
  const h = bh({ auto: false, at: NOW });
  h.client('hello', { ts: NOW - 20_000 });
  h.client('is the villa in Al Khalidiyah still free?', { ts: NOW - 10_000 });
  await h.dana.answer(LEAD, { ts: NOW - 10_000 });
  assert.equal(h.retell.chats.length, 1);
  assert.deepEqual(h.retell.completions, [{ chat_id: 'chat_1', content: 'hello\nis the villa in Al Khalidiyah still free?' }]);
  assert.deepEqual(h.calls.map((c) => c.body), [{ number: CLIENT, text: "Dana — Bona's AI assistant\n\nOf course. Which district do you prefer?" }]);
  const lead = h.lead();
  assert.deepEqual([lead.dana_chat_id, lead.dana_chat_ts, lead.dana_introduced, lead.needs_human, lead.first_reply_ts], ['chat_1', NOW, 1, 0, NOW]);
  assert.equal(h.brain.calls.length, 0);
});

/* ---------- 9. the commit hook ---------- */

test('T12 commit hook: afterPreSend only after preSend passes; the bubbles go text → document', async () => {
  const seen = [];
  const commit = {
    afterPreSend: async (o) => {
      seen.push(o);
      return { bubbles: [{ kind: 'text', text: o.text }, { kind: 'document', url: 'https://bona.azoz.uk/b/w012.pdf', fileName: 'BONA-W012.pdf', caption: 'The brochure' }] };
    },
  };
  const h = bh({ commit, turns: [brainReply('Here are the details.'), brainReply('again')] });
  await ask(h, 'send me the brochure');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'Here are the details.');
  assert.deepEqual(h.calls.map((c) => c.url.split('/message/')[1].split('/')[0]), ['sendText', 'sendMedia'], 'text first, then the document');
  assert.equal(h.s.db.prepare("SELECT COUNT(DISTINCT covers_ts) n FROM wa_outbox WHERE sender_kind = 'dana'").get().n, 1, 'one turn');
  assert.equal(h.s.db.prepare("SELECT media_kind FROM wa_outbox WHERE sender_kind = 'dana' ORDER BY created DESC, rowid DESC LIMIT 1").get().media_kind, 'document');
  // dropped_human: a person answered while she composed → the commit is never called.
  const d = bh({ commit, turns: [async () => { d.staff('I will take this one.', d.now() + 1); return brainReply('too late'); }] });
  await ask(d, 'hello');
  assert.equal(seen.length, 1, 'not called again');
  assert.equal(d.calls.length, 0);
});

/* ---------- 10. links and logging ---------- */

test('T12 links: MAX_LINKS 2; the first message has no link unless the client sent a Ref, a listing id or a URL', async () => {
  assert.equal(MAX_LINKS, 2);
  const homes = inventory.all().slice(0, 3);
  const turnWith = () => brainReply('Here are some homes.', { tools: [{ name: 'search_properties', result: { results: homes.map((l) => ({ id: l.id, slug: l.slug })) } }] });
  const first = bh({ turns: [turnWith(), turnWith()] });
  await ask(first, 'any villas?');
  assert.equal((first.sent()[0].match(/https:\/\//g) ?? []).length, 0, 'a first message: no link');
  first.tick(60_000);
  await ask(first, 'show me');
  assert.equal((first.sent()[1].match(/https:\/\//g) ?? []).length, 2, 'then at most two');
  const ref = bh({ turns: [turnWith()] });
  await ask(ref, `Hello, about ${homes[0].id}`);
  assert.equal((ref.sent()[0].match(/https:\/\//g) ?? []).length, 1, 'a listing id in the first message: one link');
});

test('T12 logging: dana.answered carries latencyMs and the stages {poll, batch, brain, guard, hold}, never text; the latency ring gives p50/p90', async () => {
  const h = bh({ turns: Array.from({ length: 10 }, () => brainReply('Of course.')) });
  for (let i = 0; i < 10; i += 1) {
    h.client(`q${i}`, { ts: h.now() - (i + 1) * 1000 });
    await h.dana.answer(LEAD, { ts: h.now() - (i + 1) * 1000 });
    h.tick(60_000);
  }
  const lines = h.logs.filter((l) => l.evt === 'dana.answered');
  assert.equal(lines.length, 10);
  for (const l of lines) {
    assert.deepEqual(Object.keys(l.stages).sort(), ['batch', 'brain', 'guard', 'hold', 'poll']);
    assert.equal(typeof l.latencyMs, 'number');
  }
  assert.doesNotMatch(JSON.stringify(h.logs), /Of course|q\d|Khalid|966511111111/);
  const lat = h.dana.latency();
  assert.equal(lat.n, 10);
  assert.equal(lat.p50, 5000);
  assert.equal(lat.p90, 9000);
});

/* ---------- 9b. the commit contract of PR-B4 (lib/dana-commit.mjs on auto/dana-tools), on a fake commit ---------- */

const FAILED_LINE = 'Thank you — the Bona team will confirm a time for your viewing with you here.'; // the fake's own text
function fakeCommit(answer, { afterSend = undefined } = {}) {
  const calls = { pre: [], after: [] };
  const c = { calls, afterPreSend: async (o) => { calls.pre.push(o); return typeof answer === 'function' ? answer(o) : answer; } };
  if (afterSend !== undefined) c.afterSend = async (o) => { calls.after.push(o); return afterSend(o); };
  return c;
}

test('T12 commit contract: a `handover: {kind}` from afterPreSend is applied — the flag, the alert, the note; its line is the bubble, never a second one, never guarded', async () => {
  const commit = fakeCommit({ bubbles: [{ kind: 'text', text: FAILED_LINE }], handover: { kind: 'booking_failed' } });
  const h = bh({ commit, turns: [brainReply('Booked for Monday!')] });
  h.client('hi', { ts: T_IN - HOUR });
  h.danaRow({ covers: T_IN - HOUR, created: T_IN - HOUR + 1000 }); // introduced already
  const r = await ask(h, 'Monday 14:00 please');
  assert.equal(r.answered, true);
  assert.deepEqual(h.sent(), [FAILED_LINE], 'one bubble, no hand-over line after it');
  assert.equal(h.lead().needs_human, 1);
  assert.equal(h.lead().first_reply_ts, null, 'a fixed line is no first reply');
  assert.deepEqual(h.notes.of('handover').map((c) => c[2].kind), ['booking_failed']);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.s.db.prepare("SELECT guarded FROM wa_outbox WHERE status = 'accepted' ORDER BY created DESC, rowid DESC LIMIT 1").get().guarded, 0);
});

test('T12 commit contract: afterSend hears whether the confirmation was accepted; not accepted → a booking_unconfirmed hold; the stub (no afterSend) is fine', async () => {
  const booking = { bookingId: 'BK-1', listingId: 'BONA-W012', startTs: T_IN + DAY };
  const answer = { bubbles: [{ kind: 'text', text: 'Your viewing is booked ✅\nMonday 30 November, 2:00 pm (one hour)', bookingId: 'BK-1' }], booking };
  const ok = fakeCommit(answer, { afterSend: () => ({ told: true }) });
  const h = bh({ commit: ok, turns: [brainReply('Booking it.')] });
  await ask(h, 'Monday 14:00 please, I am Khalid');
  assert.deepEqual(ok.calls.after.map((c) => [c.booking.bookingId, c.accepted, c.lead.lead_id]), [['BK-1', true, LEAD]]);
  assert.equal(h.lead().dana_hold_reason, null);
  const bad = fakeCommit(answer, { afterSend: ({ accepted }) => (accepted ? { told: true } : { told: false, handover: { kind: 'booking_unconfirmed' } }) });
  const f = bh({ commit: bad, turns: [brainReply('Booking it.')], evo: () => ({ status: 400 }) });
  await ask(f, 'Monday 14:00 please, I am Khalid');
  assert.deepEqual(bad.calls.after.map((c) => c.accepted), [false], 'a confirmation that did not go is not accepted');
  assert.deepEqual([f.lead().dana_hold_reason, f.lead().dana_hold_until, f.lead().needs_human], ['booking_unconfirmed', null, 1]);
  const dropped = fakeCommit(answer, { afterSend: () => ({ told: false, handover: { kind: 'booking_unconfirmed' } }) });
  const d = bh({ commit: dropped, turns: [brainReply('Booking it.')], pacing: { ...immediate, fifo: async (fn) => { d.staff('I will confirm it myself.', d.now() + 1); return fn(); } } });
  await ask(d, 'Monday 14:00 please');
  assert.deepEqual(dropped.calls.after.map((c) => c.accepted), [false], 'a person wrote in the queue: never sent, so not accepted');
  const stub = bh({ commit: fakeCommit(answer), turns: [brainReply('Booking it.')] });
  assert.equal((await ask(stub, 'Monday 14:00 please')).answered, true, 'no afterSend: nothing to call');
});

test('T12 commit contract: a maps link the commit adds still obeys the first-message rule (0 links); later it may stay', async () => {
  const withMap = (o) => ({ bubbles: [{ kind: 'text', text: `${o.text}\n\nLocation: https://maps.google.com/?q=21.5,39.2` }] });
  const first = bh({ commit: fakeCommit(withMap), turns: [brainReply('It is in Al Khalidiyah.'), brainReply('Here it is.')] });
  await ask(first, 'where is the villa?');
  assert.doesNotMatch(first.sent()[0], /maps\.google/, 'a first message carries no link');
  assert.ok(first.sent()[0].endsWith('It is in Al Khalidiyah.'));
  first.tick(60_000);
  await ask(first, 'and the map?');
  assert.match(first.sent()[1], /Location: https:\/\/maps\.google\.com\/\?q=21\.5,39\.2$/, 'a later message keeps it');
});

/* ======================================================================================
 * PR-B3 r1 (Claude + Codex, the main session's inertness ruling): legacy chats keep main's outcome for
 * everything PLAN §2 row 7 does not list; brain chats get recovery, pacing of fixed lines, the link rule.
 * ====================================================================================== */

const refuseFirst = (h, n = 1) => {
  let left = n;
  const real = h.sender.sendTo;
  h.sender.sendTo = async (o) => {
    if (left <= 0) return real(o);
    left -= 1;
    h.inbox.updateOutbox(o.sendId, { status: 'failed', error: 'rate_limited' });
    return { ok: false, error: 'rate_limited', failure: 'local', sendId: o.sendId };
  };
};
const tasks = (h) => h.s.db.prepare("SELECT COUNT(*) n FROM lead_tasks WHERE kind = 'handoff'").get().n;

test('LEGACY GUARD (r1): freshness is main\'s — a message over 30 min is a silent `old` skip (no missed, no backlog, no flag, no push)', async () => {
  for (const age of [45 * 60_000, 3 * HOUR]) {
    const h = bh({ auto: false, at: NOW });
    h.client('hello?', { ts: NOW - age });
    assert.deepEqual(await h.dana.answer(LEAD, { ts: NOW - age }), { skipped: 'old' });
    assert.deepEqual([h.retell.completions.length, h.calls.length, h.pushed.length, tasks(h), h.lead().needs_human], [0, 0, 0, 0, 0]);
    assert.equal(h.dana.sweep().woken, 0, 'no backlog queue for a legacy chat');
  }
});

test('LEGACY GUARD (r1): no loop guard for a legacy chat — the same text 3 times is answered 3 times', async () => {
  const h = bh({ auto: false, at: NOW });
  for (const back of [30, 20, 10]) {
    h.tick(60_000);
    assert.equal((await ask(h, 'price?', { ts: h.now() - back * 1000 })).answered, true);
  }
  assert.equal(h.retell.completions.length, 3);
  assert.equal(h.lead().dana_hold_reason, null);
});

test('LEGACY GUARD (r1, r2): the sender\'s rate limit and Evolution failures are main\'s send_failed hand-over, never a breaker or a hold', async () => {
  // r2 (R2): a legacy rate_limited is main's send_failed hand-over again (the flag, the task, the push; no line, no hold).
  const r = bh({ auto: false, at: NOW });
  refuseFirst(r);
  assert.deepEqual(await ask(r, 'hello'), { handover: 'send_failed', sent: false });
  assert.deepEqual([r.lead().dana_hold_reason, r.lead().needs_human, r.pushed.length, tasks(r)], [null, 1, 1, 1]);
  const f = bh({ auto: false, at: NOW, evo: () => ({ status: 400 }) });
  for (let i = 0; i < 3; i += 1) {
    const id = i === 0 ? LEAD : `LEAD-G${i}`;
    if (i) f.s.insertLead({ lead_id: id, created: NOW - DAY, updated: NOW - DAY, phone_e164: `96650000030${i}`, wa_jid: `96650000030${i}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
    assert.deepEqual(await ask(f, 'hello', { id }), { handover: 'send_failed', sent: false });
    f.tick(60_000);
  }
  assert.equal(f.team.getSetting('dana_enabled'), '1', 'no breaker on legacy chats');
  assert.deepEqual(f.owners, []);
  assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM leads WHERE dana_hold_reason IS NOT NULL').get().n, 0);
});

test('T12 r1 brain cap_day: a hand-over with no line AND a timed hold until the day frees a turn; the sweep then answers', async () => {
  const pacing = createPacing({ cfg: { waLinkedAt: null }, now: () => T_IN });
  const h = bh({ pacing: { ...immediate, tier: pacing.tier }, turns: [brainReply('Back with capacity.')] });
  const oldest = T_IN - DAY + 10 * 60_000;
  for (let i = 0; i < 60; i += 1) {
    const id = `LEAD-Y${String(i).padStart(3, '0')}`;
    h.s.insertLead({ lead_id: id, created: T_IN - 2 * DAY, updated: T_IN - 2 * DAY, phone_e164: `96650002${String(i).padStart(4, '0')}`, wa_jid: `96650002${String(i).padStart(4, '0')}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
    h.danaRow({ covers: oldest + i, created: oldest + i, id });
  }
  h.client('hello');
  assert.deepEqual(await h.dana.answer(LEAD, { ts: h.now() }), { handover: 'cap_day', sent: false });
  assert.deepEqual([h.lead().dana_hold_reason, h.lead().dana_hold_until], ['cap_day', oldest + DAY + 1]);
  assert.equal(h.calls.length, 0);
  h.set(oldest + DAY + 1);
  assert.equal(h.dana.sweep().woken, 1);
  await h.dana.flush();
  assert.equal(h.calls.length, 1, 'answered once the day freed a turn');
});

test('T12 r1 brain rate_limited: the hold backs off (60 s, then 120 s), never a model call every minute', async () => {
  const h = bh({ turns: [brainReply('one'), brainReply('two'), brainReply('three')] });
  refuseFirst(h, 2);
  assert.deepEqual(await ask(h, 'hello'), { skipped: 'cap_chat' });
  assert.equal(h.lead().dana_hold_until, T_IN + 60_000);
  h.set(T_IN + 60_000);
  h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.lead().dana_hold_until, T_IN + 60_000 + 120_000, 'the second refusal in a row holds twice as long');
  h.set(T_IN + 180_000);
  h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.calls.length, 1);
});

test('T12 r1/r2 links (C1, R1): on a brain chat every link obeys the allowance; a pointer left alone becomes the neutral line; legacy keeps main\'s', async () => {
  const homes = inventory.all().slice(0, 3);
  const urls = homes.map((l) => inventory.card(l).url.en);
  const found = { name: 'search_properties', result: { results: homes.map((l, i) => ({ id: l.id, slug: l.slug, url_en: urls[i] })) } };
  const h = bh({ turns: [
    brainReply(`Yes, one by the sea:\n${urls[0]}`, { tools: [found] }),
    brainReply(`Three homes:\n${urls[0]}\n${urls[1]}\n${urls[2]}`, { tools: [found] }),
    brainReply('The villa is close to the beach. More at https://example.com/villa\nMap: https://maps.google.com/?q=21.5,39.2', { tools: [found] }),
  ] });
  await ask(h, 'do you have a villa by the sea?');
  assert.equal((h.sent()[0].match(/https?:\/\//g) ?? []).length, 0, 'a first message: none, the model\'s own included');
  assert.ok(h.sent()[0].endsWith(NEUTRAL.en), 'only a pointer was left ("…:"): the neutral line, never an empty hand-over (r2)');
  assert.equal(h.lead().needs_human, 0);
  h.tick(60_000);
  await ask(h, 'more please');
  assert.deepEqual(h.sent()[1].match(/https?:\/\/\S+/g), [urls[0], urls[1]], 'at most two, in reading order');
  h.tick(60_000);
  await ask(h, 'where?');
  assert.ok(h.sent()[2].startsWith('The villa is close to the beach.'), h.sent()[2]);
  assert.doesNotMatch(h.sent()[2], /example\.com|More at|maps\.google|Map:/, 'the off-site URL, its dangling "More at" and a model-written maps link all go (r2)');
  assert.ok((h.sent()[2].match(/https:\/\/bona\.azoz\.uk\//g) ?? []).length <= 2, "the tool's homes as cards, within MAX_LINKS");
  // A legacy Retell answer keeps main's link handling exactly (r2, R1).
  const l = bh({ auto: false, retellAnswer: () => agentSays(`See ${urls[0]} for details.`) });
  await ask(l, 'hi');
  assert.equal(l.sent()[0], `${LEGACY_DISCLOSURE.en}\n\nSee ${urls[0]} for details.`);
});

test('T12 r1 fixed lines (C2): a brain chat\'s hand-over, closing and outage lines go through the FIFO', async () => {
  for (const [turns, text] of [
    [[brainReply('', { tools: [{ name: 'request_human', args: { kind: 'person' } }] })], 'a person please'],
    [[], 'stop'],
    [[brainError('quota')], 'hello'],
  ]) {
    let fifo = 0;
    const h = bh({ turns, pacing: { ...immediate, fifo: (fn) => { fifo += 1; return fn(); } } });
    await ask(h, text);
    assert.equal(h.calls.length, 1, text);
    assert.equal(fifo, 1, `${text}: through the queue`);
  }
});

test('T12 r1 outage line refused locally (C2, probe 2): it stays owed, the next retry sends it, and the notes go once', async () => {
  const h = bh({ turns: [brainError('quota'), brainError('quota'), brainError('quota')] });
  refuseFirst(h);
  await ask(h, 'is it free?');
  assert.equal(h.calls.length, 0, 'the line was refused by the sender');
  assert.deepEqual([h.lead().dana_hold_reason, h.lead().dana_hold_until], ['brain_out', T_IN + 60_000], 'a short hold: the line is owed');
  h.set(T_IN + 60_000);
  h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.calls.length, 1, 'the retry sent the line');
  assert.equal(h.lead().dana_hold_until, T_IN + 60_000 + 10 * 60_000);
  h.set(T_IN + 11 * 60_000);
  h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.calls.length, 1, 'then never a second one in the outage');
  assert.deepEqual(h.notes.calls.map((c) => c[0]), ['alert', 'handover'], 'the alert and the hand-over note once');
});

test('T12 r1 cap race (C3): at 59 of 60, a first bubble the queue finds over the day cap does not go', async () => {
  const pacing = createPacing({ cfg: { waLinkedAt: null }, now: () => T_IN });
  let filled = false;
  const h = bh({ turns: [brainReply('Of course.')], pacing: { ...immediate, tier: pacing.tier, fifo: (fn) => {
    if (!filled) { filled = true; h.danaRow({ covers: T_IN - 2, created: T_IN - 2, id: 'LEAD-Z059' }); } // another chat's turn fills the day meanwhile
    return fn();
  } } });
  for (let i = 0; i < 60; i += 1) {
    const id = `LEAD-Z${String(i).padStart(3, '0')}`;
    h.s.insertLead({ lead_id: id, created: T_IN - DAY, updated: T_IN - DAY, phone_e164: `96650003${String(i).padStart(4, '0')}`, wa_jid: `96650003${String(i).padStart(4, '0')}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
    if (i < 59) h.danaRow({ covers: T_IN - HOUR + i, created: T_IN - HOUR + i, id });
  }
  const r = await ask(h, 'hello');
  assert.equal(h.calls.length, 0, 'never sent over the cap');
  assert.equal(r.handover, 'cap_day');
  assert.equal(h.lead().dana_hold_reason, 'cap_day');
});

test('T12 r1 bubble order (C5): the commit\'s order is kept — text, brochure, confirmation', async () => {
  const commit = fakeCommit({ bubbles: [
    { kind: 'text', text: 'Here is the brochure.' },
    { kind: 'document', url: 'https://bona.azoz.uk/b/w012.pdf', fileName: 'BONA-W012.pdf', caption: 'The brochure' },
    { kind: 'text', text: 'Your viewing is booked ✅\nMonday 30 November, 2:00 pm (one hour)', bookingId: 'BK-9' },
  ], booking: { bookingId: 'BK-9' } }, { afterSend: () => ({ told: true }) });
  const h = bh({ commit, turns: [brainReply('Booking it.')] });
  await ask(h, 'Monday 14:00 please');
  assert.deepEqual(h.calls.map((c) => c.url.split('/message/')[1].split('/')[0]), ['sendText', 'sendMedia', 'sendText']);
  assert.match(h.calls[2].body.text, /booked/);
});

test('T12 r1 small ones: a throwing autoMode fails closed; in hours the hand-over is variant 0; an uncertain second failure alerts; preSend no_open_chat; acks are no loop', async () => {
  // autoMode throws: no answer at all, never a Retell fallback.
  const t = bh({ turns: [brainReply('never')] });
  t.ownerTest.autoMode = () => { throw new Error('boom'); };
  t.client('hello');
  assert.deepEqual(t.dana.eligible(LEAD), { ok: false, reason: 'not_configured' });
  assert.deepEqual(await t.dana.answer(LEAD, { ts: t.now() }), { skipped: 'not_configured' });
  assert.deepEqual([t.retell.completions.length, t.retell.chats.length, t.brain.calls.length], [0, 0, 0]);
  // Inside office hours an auto chat's hand-over is HANDOVER variant 0, whatever its hash (LEAD hashes to 2).
  assert.notEqual(variantIndex(LEAD), 0);
  const v = bh({ turns: [brainReply('', { tools: [{ name: 'request_human', args: { kind: 'person' } }] })] });
  await ask(v, 'a person please');
  assert.ok(v.sent()[0].endsWith(`\n\n${HANDOVER.en}`), v.sent()[0]);
  // An uncertain send that is the chat's second counted failure: the hold AND its alert.
  let n = 0;
  const u = bh({ turns: [brainReply('a'), brainReply('b')], evo: () => ((n += 1) === 1 ? { status: 400 } : { status: 500 }) });
  await ask(u, 'hello');
  u.tick(60_000);
  await ask(u, 'still there?');
  assert.deepEqual([u.lead().dana_hold_reason, u.lead().dana_hold_until], ['send_failed', null]);
  assert.equal(u.pushed.length, 2, 'the hand-over push, then the hold\'s alert');
  assert.deepEqual(u.notes.of('handover').map((c) => c[2].kind), ['send_failed']);
  // preSend's own never-first check: the client message is gone by the time she would send.
  const p = bh({ turns: [async () => { p.s.db.prepare('DELETE FROM wa_messages WHERE lead_id = ?').run(LEAD); return brainReply('Of course.'); }] });
  assert.deepEqual(await ask(p, 'hello'), { skipped: 'no_open_chat' });
  assert.equal(p.calls.length, 0);
  // Acknowledgements never count as a repeat for the loop guard.
  const a = bh({ turns: Array.from({ length: 5 }, () => brainReply('Sure.')) });
  for (const text of ['ok', 'تمام', 'ok', '👍', 'ok']) {
    a.tick(60_000);
    assert.equal((await ask(a, text)).answered, true, text);
  }
  assert.equal(a.lead().dana_hold_reason, null);
});

/* ======================================================================================
 * PR-B3 r2 (Claude + Codex, strict inert): legacy links and rate limits as on main; the outage,
 * the breaker and the backlog survive a restart; fixed lines re-checked in the queue.
 * ====================================================================================== */

test('LEGACY GUARD (r2, R1): links as on main — a first answer keeps its URL, later answers get up to three cards', async () => {
  assert.equal(LEGACY_MAX_LINKS, 3);
  const homes = inventory.all().slice(0, 4);
  const found = { role: 'tool_call_result', tool_call_id: 't1', content: JSON.stringify({ results: homes.map((l) => ({ id: l.id, slug: l.slug })) }) };
  const withCards = () => ({ messages: [
    { role: 'tool_call_invocation', tool_call_id: 't1', name: 'search_properties', arguments: '{}' }, found,
    { role: 'agent', content: `Here are some homes:\n- ${homes[0].title.en}` },
  ] });
  const h = bh({ auto: false, retellAnswer: withCards });
  await ask(h, 'any villas?');
  assert.equal((h.sent()[0].match(/https?:\/\//g) ?? []).length, 3, 'a first legacy message gets main\'s three cards');
  assert.equal(h.lead().needs_human, 0);
});

test('LEGACY GUARD (r2, R2): with the sender\'s day full a legacy turn hands over as main does, without paying for a Retell call', async () => {
  const h = bh({ auto: false, at: NOW });
  h.sender.dayFull = () => true;
  assert.deepEqual(await ask(h, 'hello'), { handover: 'send_failed', sent: false });
  assert.deepEqual([h.retell.chats.length, h.retell.completions.length, h.calls.length], [0, 0, 0]);
  assert.deepEqual([h.lead().needs_human, tasks(h), h.pushed.length], [1, 1, 1]);
});

test('T12 r2 links: a bubble left with no real words is dropped; with nothing left the neutral line goes, never an `empty` hand-over', async () => {
  const homes = inventory.all().slice(0, 1);
  const url = inventory.card(homes[0]).url.en;
  const found = { name: 'search_properties', result: { results: [{ id: homes[0].id, slug: homes[0].slug, url_en: url }] } };
  for (const text of [`Here it is:\n${url}`, `Villa by the sea — ${url}`, `Map: ${url}`, `And ${url}`, `Details (${url})`]) {
    const h = bh({ turns: [brainReply(text, { tools: [found] })] });
    await ask(h, 'do you have a villa?');
    assert.equal(h.sent().length, 1, text);
    assert.ok(h.sent()[0].endsWith(NEUTRAL.en), `${text} → ${h.sent()[0]}`);
    assert.deepEqual([h.lead().needs_human, tasks(h)], [0, 0], `${text}: no hand-over`);
  }
  assert.ok(FIXED_LINES.includes(NEUTRAL.en) && FIXED_LINES.includes(NEUTRAL.ar), 'the neutral line is no answer for the stats');
});

test('T12 r2 N1: a restart mid-outage sends no second line, alert, note or push, and the recovery still answers', async () => {
  const h = bh({ turns: [brainError('quota')] });
  await ask(h, 'is it free?');
  assert.equal(h.calls.length, 1);
  h.tick(60_000);
  h.client('hello??');
  const r1 = h.restart([brainError('quota')]);
  h.set(T_IN + 10 * 60_000);
  r1.dana.sweep();
  await r1.dana.flush();
  assert.equal(h.calls.length, 1, 'no second outage line after the restart');
  assert.deepEqual(r1.notes.calls, [], 'no second alert or note');
  assert.equal(h.pushed.length, 1, 'no second push');
  assert.equal(h.lead().dana_hold_until, T_IN + 20 * 60_000, 'the hold is extended');
  const r2 = h.restart([brainReply('Yes, it is free.')]);
  h.set(T_IN + 20 * 60_000);
  r2.dana.sweep();
  await r2.dana.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.sent()[1], 'Yes, it is free.', 'the recovery answered the messages the holding line covered');
  assert.equal(r2.brain.calls[0].batchParts.length, 2, 'both waiting messages, the floor read from the database');
});

test('T12 r2 N1: with no new message, a restart still leaves the recovery turn to run when the hold expires', async () => {
  const h = bh({ turns: [brainError('down')] });
  await ask(h, 'is it free?');
  const r = h.restart([brainReply('Yes, it is.')]);
  h.set(T_IN + 10 * 60_000);
  assert.equal(r.dana.sweep().woken, 1);
  await r.dana.flush();
  assert.equal(h.sent()[1], 'Yes, it is.');
});

test('T12 r2 N2: an expired brain_out hold of a chat refused for another reason is cleared, not re-woken every minute', async () => {
  const off = bh({ turns: [brainError('quota')] });
  await ask(off, 'hello');
  off.team.setSetting('dana_enabled', '0', { by: 'system' });
  let wakes = 0;
  for (let m = 10; m < 60; m += 1) {
    off.set(T_IN + m * 60_000);
    wakes += off.dana.sweep().woken;
    await off.dana.flush();
  }
  assert.equal(wakes, 1, 'woken once, then the hold is gone');
  assert.equal(off.lead().dana_hold_reason, null);
  // A stop request during the outage: the closing line at expiry, then no more wakes.
  const st = bh({ turns: [brainError('quota'), brainError('quota')] });
  await ask(st, 'hello');
  st.tick(60_000);
  st.client('stop');
  let w = 0;
  for (let m = 10; m < 40; m += 1) {
    st.set(T_IN + m * 60_000);
    w += st.dana.sweep().woken;
    await st.dana.flush();
  }
  assert.ok(st.sent().at(-1).endsWith(CLOSING.en));
  assert.equal(st.lead().dana_off, 1);
  assert.ok(w <= 2, `${w} wakes`);
  assert.equal(st.lead().dana_hold_reason, null);
});

test('T12 r2: a queued fixed line is re-checked in the queue (a person wrote, Dana switched off) and waits for the typing floor', async () => {
  for (const meanwhile of [(h) => h.staff('I have it, thanks.', h.now() + 1), (h) => h.team.setSetting('dana_enabled', '0')]) {
    const h = bh({ turns: [brainError('quota')], pacing: { ...immediate, fifo: async (fn) => { meanwhile(h); return fn(); } } });
    await ask(h, 'hello');
    assert.equal(h.calls.length, 0, 'the queued outage line does not go');
  }
  const f = bh({ turns: [brainReply('', { tools: [{ name: 'request_human', args: { kind: 'person' } }] })], pacing: { ...immediate, typingFloorMs: () => 9000 } });
  await ask(f, 'a person please');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.slept, [9000], 'the hand-over line waited for the typing floor');
});

test('T12 r2: the breaker counts the 30-minute window from the outbox, so a restart forgets no failure', async () => {
  const h = bh({ turns: [brainReply('a'), brainReply('b')], evo: () => ({ status: 500 }) });
  const chat = (i) => {
    const id = `LEAD-K${i}`;
    h.s.insertLead({ lead_id: id, created: T_IN - DAY, updated: T_IN - DAY, phone_e164: `96650000050${i}`, wa_jid: `96650000050${i}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
    h.ownerTest.setAuto(id, true);
    return id;
  };
  await ask(h, 'hi', { id: chat(1) });
  h.tick(60_000);
  await ask(h, 'hi', { id: chat(2) });
  assert.equal(h.team.getSetting('dana_enabled'), '1');
  const r = h.restart([brainReply('c')]);
  h.tick(60_000);
  const ts = h.client('hi', { id: chat(3) });
  await r.dana.answer('LEAD-K3', { ts });
  assert.equal(h.team.getSetting('dana_enabled'), '0', 'the third failure in 30 min trips it after the restart');
});

test('T12 r2: concurrent backlog turns never pass ten an hour (the 9/10 race)', async () => {
  const h = bh({ turns: Array.from({ length: 9 }, () => brainReply('Sorry for the wait.')), link: { identityOk: () => true, linkStable: () => true } });
  const add = (i) => {
    const id = `LEAD-Q${String(i).padStart(2, '0')}`;
    h.s.insertLead({ lead_id: id, created: T_IN - DAY, updated: T_IN - DAY, phone_e164: `9665000006${String(i).padStart(2, '0')}`, wa_jid: `9665000006${String(i).padStart(2, '0')}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
    h.ownerTest.setAuto(id, true);
    return id;
  };
  for (let i = 0; i < 9; i += 1) {
    const id = add(i);
    const ts = h.client('hi', { id, ts: h.now() - 40 * 60_000 });
    assert.equal((await h.dana.answer(id, { ts })).answered, true);
    h.tick(61_000);
  }
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = h.restart([async () => { await gate; return brainReply('A.'); }, async () => { await gate; return brainReply('B.'); }]);
  // A fresh process has no memory of the nine: the allowance is read from the outbox too.
  const a = add(10);
  const b = add(11);
  const ta = h.client('hi', { id: a, ts: h.now() - 40 * 60_000 });
  const tb = h.client('hi', { id: b, ts: h.now() - 40 * 60_000 });
  const both = Promise.all([r.dana.answer(a, { ts: ta }), r.dana.answer(b, { ts: tb })]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const out = await both;
  assert.equal(out.filter((x) => x.answered).length, 1, 'the tenth goes, the eleventh waits');
  assert.ok(out.some((x) => x.skipped === 'backlog'));
});

test('T12 r2: a continuation that fails as the chat\'s second counted failure holds it AND alerts', async () => {
  const commit = fakeCommit((o) => ({ bubbles: [{ kind: 'text', text: o.text }, { kind: 'document', url: 'https://bona.azoz.uk/b/w012.pdf', fileName: 'BONA-W012.pdf', caption: 'The brochure' }] }));
  const h = bh({ commit, turns: [brainReply('Here are the details.')], evo: (n, body) => (body.mediatype === 'document' ? { status: 400 } : { status: 201, body: { key: { id: `K${n}` } } }) });
  h.client('hi', { ts: T_IN - HOUR });
  h.danaRow({ covers: T_IN - HOUR, created: T_IN - HOUR + 1000, status: 'failed', error: 'http_400' });
  await ask(h, 'send me the brochure');
  assert.deepEqual([h.lead().dana_hold_reason, h.lead().dana_hold_until], ['send_failed', null]);
  assert.equal(h.pushed.length, 1, 'the alert');
  assert.deepEqual(h.notes.of('handover').map((c) => c[2].kind), ['send_failed']);
});

test('T12 r2: cap_day frees one turn → one waiting chat is woken (the oldest), the others wait for the next free turn', async () => {
  const pacing = createPacing({ cfg: { waLinkedAt: null }, now: () => T_IN });
  const h = bh({ pacing: { ...immediate, tier: pacing.tier }, turns: [brainReply('Now I can answer.')] });
  const at0 = T_IN - DAY + 5 * 60_000;
  for (let i = 0; i < 60; i += 1) {
    const id = `LEAD-W${String(i).padStart(3, '0')}`;
    h.s.insertLead({ lead_id: id, created: T_IN - 2 * DAY, updated: T_IN - 2 * DAY, phone_e164: `96650007${String(i).padStart(4, '0')}`, wa_jid: `96650007${String(i).padStart(4, '0')}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
    h.danaRow({ covers: at0 + i * 60_000, created: at0 + i * 60_000, id });
  }
  const waiting = [];
  for (let i = 0; i < 3; i += 1) {
    const id = `LEAD-P${i}`;
    h.s.insertLead({ lead_id: id, created: T_IN - DAY, updated: T_IN - DAY, phone_e164: `96650000070${i}`, wa_jid: `96650000070${i}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
    h.ownerTest.setAuto(id, true);
    const ts = h.client(`q${i}`, { id, ts: T_IN - (3 - i) * 60_000 });
    assert.equal((await h.dana.answer(id, { ts })).handover, 'cap_day');
    waiting.push(id);
  }
  h.set(at0 + DAY + 1);
  assert.equal(h.dana.sweep().woken, 1, 'one freed turn, one chat');
  await h.dana.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.number, '966500000700', 'the oldest waiting chat first');
  assert.ok(h.s.getLead('LEAD-P1').dana_hold_until > h.now(), 'the others wait for the next free turn');
  assert.equal(h.notes.of('handover').length, 3, 'no repeat hand-over');
});

/* ======================================================================================
 * PR-B3 r3 (Claude N4, Codex P1/P2): every timed hold ends; the breaker binds test chats; a send_failed
 * hold is never replaced; ages re-checked at send time; read receipts and "composing"; documents per day.
 * ====================================================================================== */

const fillDay = (h, n, at, prefix = 'LEAD-R') => {
  for (let i = 0; i < n; i += 1) {
    const id = `${prefix}${String(i).padStart(3, '0')}`;
    h.s.insertLead({ lead_id: id, created: at - DAY, updated: at - DAY, phone_e164: `96650008${String(i).padStart(4, '0')}`, wa_jid: `96650008${String(i).padStart(4, '0')}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
    h.danaRow({ covers: at + i, created: at + i, id });
  }
};
const strictTier = () => ({ ...immediate, tier: createPacing({ cfg: { waLinkedAt: null }, now: () => T_IN }).tier });
const sweepFor = async (h, fromMs, toMs) => {
  let wakes = 0;
  for (let t = fromMs; t <= toMs; t += 60_000) {
    h.set(t);
    wakes += h.dana.sweep().woken;
    await h.dana.flush();
  }
  return wakes;
};

test('T12 r3 N4: a cap_day chat whose message passes 2 h is handed over `missed` exactly once', async () => {
  const h = bh({ pacing: strictTier(), turns: [], link: { identityOk: () => true, linkStable: () => true } });
  fillDay(h, 60, T_IN - DAY + 20 * HOUR); // the day frees its first turn only 20 h from now
  h.client('hello');
  assert.equal((await h.dana.answer(LEAD, { ts: h.now() })).handover, 'cap_day');
  await sweepFor(h, T_IN + 60_000, T_IN + 2 * HOUR + 60_000);
  assert.deepEqual(h.notes.of('handover').map((c) => c[2].kind), ['cap_day', 'missed'], 'missed at the 2-h mark, not when the day frees a turn (r4 B)');
  await sweepFor(h, T_IN + 2 * HOUR + 2 * 60_000, T_IN + 2 * HOUR + 30 * 60_000);
  assert.deepEqual(h.notes.of('handover').map((c) => c[2].kind), ['cap_day', 'missed'], 'one missed, never one a minute');
  assert.ok(h.pushed.length <= 2, `${h.pushed.length} pushes`);
  assert.equal(h.lead().dana_hold_reason, null);
});

test('T12 r3 N4: an ended cap_day hold stops waking with Dana off, and past 24 h', async () => {
  const off = bh({ pacing: strictTier(), lead: { dana_hold_reason: 'cap_day', dana_hold_until: T_IN - 60_000 } });
  off.client('hello', { ts: T_IN - 5 * 60_000 });
  off.team.setSetting('dana_enabled', '0');
  assert.ok(await sweepFor(off, T_IN, T_IN + 30 * 60_000) <= 1);
  assert.equal(off.lead().dana_hold_reason, null);
  const old = bh({ pacing: strictTier(), lead: { dana_hold_reason: 'cap_day', dana_hold_until: T_IN - 60_000 } });
  old.client('hello', { ts: T_IN - DAY - HOUR });
  assert.ok(await sweepFor(old, T_IN, T_IN + 30 * 60_000) <= 1);
  assert.equal(old.lead().dana_hold_reason, null);
});

test('T12 r3: the breaker (dana_enabled 0 by system) binds a per-chat test too; the owner\'s own switch-off does not', async () => {
  const h = bh({ lead: { dana_test: 1 } });
  h.team.setSetting('dana_enabled', '0', { by: 'system' });
  assert.deepEqual(h.dana.eligible(LEAD), { ok: false, reason: 'off' });
  h.team.setSetting('dana_enabled', '0', { by: 'USR-owner' });
  assert.equal(h.dana.eligible(LEAD).ok, true, "the owner's test flag on this chat, as on main");
  // A fixed line queued when the breaker trips does not go, test chat or not.
  const q = bh({ lead: { dana_test: 1 }, turns: [brainError('quota')], pacing: { ...immediate, fifo: async (fn) => { q.team.setSetting('dana_enabled', '0', { by: 'system' }); return fn(); } } });
  await ask(q, 'hello');
  assert.equal(q.sent().length, 0);
});

test('T12 r3: a send_failed hold (until a person) is never replaced by an outage\'s timed hold', async () => {
  const h = bh({ turns: [brainError('quota')], evo: () => ({ status: 400 }) });
  h.client('hi', { ts: T_IN - HOUR });
  h.danaRow({ covers: T_IN - HOUR, created: T_IN - HOUR + 1000, status: 'failed', error: 'http_400' });
  await ask(h, 'is it free?');
  assert.deepEqual([h.lead().dana_hold_reason, h.lead().dana_hold_until], ['send_failed', null]);
});

test('T12 r3: the message\'s age is checked again at send time — 29m59s becomes backlog, 1h59m becomes missed', async () => {
  const b = bh({ turns: [async () => { b.tick(2000); return brainReply('Sorry for the wait.'); }], link: { identityOk: () => true, linkStable: () => false } });
  b.client('hello', { ts: T_IN - 30 * 60_000 + 1000 });
  assert.deepEqual(await b.dana.answer(LEAD, { ts: T_IN - 30 * 60_000 + 1000 }), { skipped: 'backlog' });
  assert.equal(b.sent().length, 0, 'over 30 min by send time: the backlog rule, and the link has not held');
  const m = bh({ turns: [async () => { m.tick(2 * 60_000); return brainReply('Sorry for the wait.'); }], link: { identityOk: () => true, linkStable: () => true } });
  m.client('hello', { ts: T_IN - 2 * HOUR + 60_000 });
  const r = await m.dana.answer(LEAD, { ts: T_IN - 2 * HOUR + 60_000 });
  assert.equal(r.handover, 'missed');
  assert.equal(m.sent().length, 0, 'over 2 h by send time: never answered');
});

test('T12 r3: an outage recovery under a full day cap is handed over and held, not woken every minute', async () => {
  const h = bh({ pacing: strictTier(), turns: [brainError('quota')] });
  await ask(h, 'is it free?');
  assert.equal(h.sent().length, 1);
  fillDay(h, 60, T_IN - DAY + 3 * HOUR);
  const wakes = await sweepFor(h, T_IN + 10 * 60_000, T_IN + 40 * 60_000);
  assert.equal(wakes, 1, 'woken once: the cap_day hand-over holds it until the day frees a turn');
  assert.equal(h.lead().dana_hold_reason, 'cap_day');
  assert.deepEqual(h.notes.of('handover').map((c) => c[2].kind), ['brain', 'cap_day']);
});

test('T12 r3: a brain turn marks the batch read and shows "composing" (T00 shapes); a failure there blocks nothing and counts for nothing; legacy has neither', async () => {
  const h = bh({ turns: [brainReply('Of course.')], pacing: { ...immediate, typingFloorMs: () => 9000 },
    evo: (n, body) => (body.readMessages || body.presence ? { status: 500 } : { status: 201, body: { key: { id: `K${n}` } } }) });
  const ts = h.client('hello');
  await h.dana.answer(LEAD, { ts });
  assert.equal(h.sent().length, 1, 'the answer went');
  for (const l of h.laters) await l.fn();
  const read = h.calls.find((c) => c.url.includes('/chat/markMessageAsRead/'));
  const typing = h.calls.find((c) => c.url.includes('/chat/sendPresence/'));
  assert.deepEqual(read.body, { readMessages: [{ id: 'C1', fromMe: false, remoteJid: CLIENT_JID }] });
  assert.deepEqual(typing.body, { number: CLIENT, presence: 'composing', delay: 9000 });
  assert.ok(h.laters.find((l) => l.ms >= 1000 && l.ms <= 3000), 'the read receipt 1-3 s after the batch fired');
  assert.equal(h.s.db.prepare("SELECT COUNT(*) n FROM wa_outbox WHERE status <> 'accepted'").get().n, 0, 'no outbox row for either');
  assert.deepEqual([h.lead().dana_hold_reason, h.team.getSetting('dana_enabled')], [null, '1']);
  // An @lid chat: the receipt names the phone jid (T00 finding 4: Evolution drops @lid keys).
  const lid = bh({ turns: [brainReply('Of course.')], lead: { wa_jid: '123456789012345@lid', wa_lid: '123456789012345@lid' } });
  await ask(lid, 'hello');
  for (const l of lid.laters) await l.fn();
  assert.equal(lid.calls.find((c) => c.url.includes('/chat/markMessageAsRead/')).body.readMessages[0].remoteJid, CLIENT_JID);
  assert.equal(lid.calls.some((c) => c.url.includes('/chat/sendPresence/')), false, 'no floor left: no "composing"');
  const legacy = bh({ auto: false, pacing: { ...immediate, typingFloorMs: () => 9000 } });
  await ask(legacy, 'hello');
  assert.deepEqual(legacy.laters, []);
  assert.equal(legacy.calls.some((c) => c.url.includes('/chat/')), false);
});

test('T12 r3: a queued fixed line re-checks the own-number rule and the instance identity', async () => {
  const own = bh({ lead: { inbox_via: 'own_number' }, turns: [brainError('quota')], pacing: { ...immediate, fifo: async (fn) => { own.ownerTest.ownNumberOk = () => false; return fn(); } } });
  await ask(own, 'hello');
  assert.equal(own.sent().length, 0, 'the rule went off in the queue');
  let ok = true;
  const id = bh({ turns: [brainError('quota')], wa: { ownNumberFrom: 'instance' }, link: { identityOk: () => ok, linkStable: () => true },
    pacing: { ...immediate, fifo: async (fn) => { ok = false; return fn(); } } });
  await ask(id, 'hello');
  assert.equal(id.sent().length, 0, 'the identity failed in the queue');
});

test('T12 r3: one brochure document per chat per day (the tier); a second becomes its link', async () => {
  const doc = { kind: 'document', url: 'https://bona.azoz.uk/b/w012.pdf', fileName: 'BONA-W012.pdf', caption: 'BONA-W012 brochure' };
  const commit = fakeCommit((o) => ({ bubbles: [{ kind: 'text', text: o.text }, doc] }));
  const h = bh({ commit, turns: [brainReply('Here it is.'), brainReply('And again.')] });
  await ask(h, 'brochure please');
  h.tick(60_000);
  await ask(h, 'send it again please');
  const media = h.calls.filter((c) => c.url.includes('/sendMedia/'));
  assert.equal(media.length, 1, 'one document a day');
  assert.ok(h.sent().some((t) => t.includes('BONA-W012 brochure') && t.includes(doc.url)), 'the second as its link');
});

test('T12 r3: during an outage the batch reaches back no further than 24 h', async () => {
  const h = bh({ turns: [brainError('quota'), brainReply('Yes.')] });
  h.client('a day ago', { ts: T_IN - DAY - 60_000 });
  await ask(h, 'is it free?');
  h.set(T_IN + 10 * 60_000);
  h.dana.sweep();
  await h.dana.flush();
  assert.deepEqual(h.brain.calls[1].batchParts, ['is it free?']);
});

/* ======================================================================================
 * PR-B3 r4 (Codex P1s): one waiting-message source, one deadline per hold, one send gate, the breaker
 * under an owner-off switch, and the documents and links of a turn counted where they go.
 * ====================================================================================== */

test('T12 r4 A: an outage-covered message survives a cap that replaces brain_out with cap_day, and is answered when the day frees a turn', async () => {
  const h = bh({ pacing: strictTier(), turns: [brainError('quota'), brainReply('Yes, it is still free.')] });
  await ask(h, 'is it free?');
  // 59 turns of other chats plus the holding line fill the day; the oldest ages out at 20 min (the message still fresh).
  const base = T_IN + 20 * 60_000 - DAY;
  fillDay(h, 59, base);
  h.set(T_IN + 10 * 60_000);
  h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.lead().dana_hold_reason, 'cap_day');
  h.set(base + DAY + 1);
  h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.sent().at(-1), 'Yes, it is still free.', 'the question the holding line covered was never lost');
});

test('T12 r4 A: a recovery deferred as backlog keeps its hold and its message until the reply is accepted', async () => {
  let stable = false;
  const h = bh({ turns: [brainError('down'), async () => { h.tick(2 * 60_000); return brainReply('one'); }, brainReply('Here is your answer.')], link: { identityOk: () => true, linkStable: () => stable } });
  await ask(h, 'is it free?');
  h.set(T_IN + 29 * 60_000); // the brain is back at 29 min; the reply reaches the queue past 30 min, the link unstable
  h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.sent().length, 1, 'deferred: only the holding line so far');
  assert.equal(h.lead().dana_hold_reason, 'brain_out', 'the hold stays until a reply is accepted');
  stable = true;
  h.tick(60_000);
  h.dana.sweep();
  await h.dana.flush();
  assert.equal(h.sent().length, 2, 'answered once the link held');
  assert.equal(h.lead().dana_hold_reason, null);
});

test('T12 r4 B: under a day-long timed hold, `missed` is recorded at the 2-h mark', async () => {
  const h = bh({ turns: [] });
  h.client('hello', { ts: T_IN });
  h.s.updateLead(LEAD, { dana_hold_reason: 'cap_chat', dana_hold_until: T_IN + DAY });
  await sweepFor(h, T_IN + 60_000, T_IN + 2 * HOUR - 60_000);
  assert.equal(h.notes.of('handover').length, 0, 'before 2 h nothing');
  await sweepFor(h, T_IN + 2 * HOUR, T_IN + 2 * HOUR + 60_000);
  assert.deepEqual(h.notes.of('handover').map((c) => c[2].kind), ['missed']);
  assert.equal(h.lead().dana_hold_reason, null);
});

test('T12 r4 C: a fixed line that reaches the queue after 2 h is `missed` with no client line', async () => {
  const h = bh({ turns: [async () => { h.tick(15_000); return brainError('quota'); }], link: { identityOk: () => true, linkStable: () => true } });
  h.client('hello', { ts: T_IN - 2 * HOUR + 10_000 });
  await h.dana.answer(LEAD, { ts: T_IN - 2 * HOUR + 10_000 });
  assert.equal(h.sent().length, 0, 'no outage line after the 2-h cutoff');
  assert.ok(h.notes.of('handover').some((c) => c[2].kind === 'missed'));
  assert.equal(h.lead().dana_hold_reason, null);
});

test('T12 r4 C: overlapping turns never pass the global document cap; a document over it goes as its link', async () => {
  const doc = (n) => ({ kind: 'document', url: `https://bona.azoz.uk/b/w0${n}.pdf`, fileName: `BONA-W0${n}.pdf`, caption: `BONA-W0${n} brochure` });
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn); chain = run.then(() => {}, () => {}); return run; };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const n = { v: 10 };
  const commit = fakeCommit((o) => ({ bubbles: [{ kind: 'text', text: o.text }, doc(n.v += 1)] }));
  const h = bh({ commit, pacing: { ...strictTier(), fifo: serial }, turns: [async () => { await gate; return brainReply('A.'); }, async () => { await gate; return brainReply('B.'); }] });
  for (let i = 0; i < 14; i += 1) h.danaRow({ covers: T_IN - HOUR + i, created: T_IN - HOUR + i, id: LEAD, media: 'document' });
  h.s.insertLead({ lead_id: 'LEAD-D2', created: T_IN - DAY, updated: T_IN - DAY, phone_e164: '966500000902', wa_jid: '966500000902@s.whatsapp.net', channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
  h.s.insertLead({ lead_id: 'LEAD-D3', created: T_IN - DAY, updated: T_IN - DAY, phone_e164: '966500000903', wa_jid: '966500000903@s.whatsapp.net', channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
  for (const id of ['LEAD-D2', 'LEAD-D3']) {
    h.ownerTest.setAuto(id, true);
    h.client('hi', { id, ts: T_IN - HOUR });
    h.danaRow({ covers: T_IN - HOUR, created: T_IN - HOUR + 500, id });
  }
  const a = h.client('brochure please', { id: 'LEAD-D2' });
  const b = h.client('brochure please', { id: 'LEAD-D3' });
  const both = Promise.all([h.dana.answer('LEAD-D2', { ts: a }), h.dana.answer('LEAD-D3', { ts: b })]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await both;
  assert.equal(h.calls.filter((c) => c.url.includes('/sendMedia/')).length, 1, 'the 15th goes as a document, the 16th does not');
  assert.ok(h.sent().some((t) => /BONA-W0\d+ brochure — https:\/\/bona\.azoz\.uk\/b\//.test(t)), 'the other as its link');
});

test('T12 r4 D: three real Evolution failures across test chats trip the breaker though the global switch is owner-off; test chats are then blocked', async () => {
  const h = bh({ enabled: false, turns: Array.from({ length: 4 }, () => brainReply('hello')), evo: () => ({ status: 500 }) });
  h.team.setSetting('dana_enabled', '0', { by: 'USR-owner' });
  const chat = (i) => {
    const id = `LEAD-T${i}`;
    h.s.insertLead({ lead_id: id, created: T_IN - DAY, updated: T_IN - DAY, phone_e164: `96650000091${i}`, wa_jid: `96650000091${i}@s.whatsapp.net`, channel: 'whatsapp', stage: 'new', inbox_state: 'in', dana_test: 1 });
    h.ownerTest.setAuto(id, true);
    return id;
  };
  for (let i = 1; i <= 3; i += 1) {
    await ask(h, 'hi', { id: chat(i) });
    h.tick(60_000);
  }
  assert.equal(h.dana.health().breaker, true, 'tripped by the failures themselves');
  assert.deepEqual(h.owners, [{ reason: 'dana_paused' }]);
  const id = chat(4);
  h.client('hi', { id });
  assert.deepEqual(h.dana.eligible(id), { ok: false, reason: 'off' }, 'a test chat is blocked once it tripped');
});

test('T12 r4 E: a brochure turned into its link obeys the link limit, and the logged link count is taken after it', async () => {
  const homes = inventory.all().slice(0, 2);
  const urls = homes.map((l) => inventory.card(l).url.en);
  const found = { name: 'search_properties', result: { results: homes.map((l, i) => ({ id: l.id, slug: l.slug, url_en: urls[i] })) } };
  const doc = { kind: 'document', url: 'https://bona.azoz.uk/b/w012.pdf', fileName: 'BONA-W012.pdf', caption: 'BONA-W012 brochure' };
  const commit = fakeCommit((o) => ({ bubbles: [{ kind: 'text', text: o.text }, doc] }));
  const h = bh({ commit, turns: [brainReply(`Two homes:\n${urls[0]}\n${urls[1]}`, { tools: [found] })] });
  h.client('hi', { ts: T_IN - HOUR });
  h.danaRow({ covers: T_IN - HOUR, created: T_IN - HOUR + 500 }); // introduced
  h.danaRow({ covers: T_IN - HOUR, created: T_IN - HOUR + 600, media: 'document' }); // today's one document
  await ask(h, 'and the brochure?');
  assert.equal(h.calls.filter((c) => c.url.includes('/sendMedia/')).length, 0);
  assert.equal(h.sent().join('\n').match(/https:\/\//g).length, 2, 'MAX_LINKS: the brochure link has no room left');
  assert.equal(h.logs.find((l) => l.evt === 'dana.answered').links, 2);
});

test('T12 r4 E: one sweep runs a chat once — a cap_day chat also in the backlog map gives exactly one `missed`', async () => {
  const h = bh({ pacing: strictTier(), turns: [brainReply('x')], link: { identityOk: () => true, linkStable: () => false } });
  h.client('hello', { ts: T_IN - 45 * 60_000 });
  assert.deepEqual(await h.dana.answer(LEAD, { ts: T_IN - 45 * 60_000 }), { skipped: 'backlog' });
  h.s.updateLead(LEAD, { dana_hold_reason: 'cap_day', dana_hold_until: T_IN + DAY });
  await sweepFor(h, T_IN + HOUR + 15 * 60_000, T_IN + HOUR + 20 * 60_000);
  assert.deepEqual(h.notes.of('handover').map((c) => c[2].kind), ['missed']);
});
