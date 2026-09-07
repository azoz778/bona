import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolHandlers, tokenMatches, extractToken, conversationId, conversationLocale, toolArgs, leadKey } from '../lib/tools.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { createStore } from '../lib/store.mjs';
import { normaliseLead, leadNote, appendLead, appendJsonl } from '../lib/leads.mjs';
import { openDb } from '../lib/db.mjs';

const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const KHALIDIYAH = inventory.all().find((l) => l.location.district.en === 'Al Khalidiyah');

function harness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-tools-'));
  const sent = [];
  const store = createStore();
  const db = openDb(':memory:');
  const tools = createToolHandlers({
    inventory, store, db, dataDir, siteUrl: 'https://bona.azoz.uk', env: {},
    // The real Evolution API is NEVER touched from tests.
    sendWhatsApp: async (text) => { sent.push(text); return { ok: true }; },
  });
  return { dataDir, sent, store, db, tools, cleanup: () => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

/* ---------------- auth ---------------- */

test('tool auth: only the exact token passes', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
  assert.equal(tokenMatches('abc124', 'abc123'), false);
  assert.equal(tokenMatches('abc', 'abc123'), false, 'a prefix must not pass');
  assert.equal(tokenMatches('', 'abc123'), false);
  assert.equal(tokenMatches(null, 'abc123'), false);
});

test('tool auth: an unset server token denies everything', () => {
  assert.equal(tokenMatches('anything', ''), false);
  assert.equal(tokenMatches('anything', undefined), false);
  assert.equal(tokenMatches('', ''), false);
});

test('the token arrives in a header or a bearer', () => {
  assert.equal(extractToken({ url: new URL('https://x/y'), headers: { 'x-bona-token': 'h1' } }), 'h1');
  assert.equal(extractToken({ url: new URL('https://x/y'), headers: { authorization: 'Bearer b1' } }), 'b1');
  assert.equal(extractToken({ url: new URL('https://x/y'), headers: {} }), null);
});

test('?token= is ignored unless BONA_ALLOW_QUERY_TOKEN turns it back on', () => {
  const url = new URL('https://bona-api.azoz.uk/v1/tools/show_property?token=q1');
  assert.equal(extractToken({ url, headers: {} }), null, 'a token in a URL lands in logs — off by default');
  assert.equal(extractToken({ url, headers: {} , allowQuery: true }), 'q1');
  assert.equal(
    extractToken({ url, headers: { 'x-bona-token': 'h1' }, allowQuery: true }),
    'h1',
    'the header wins when both are present',
  );
});

test('tokenMatches is length-blind: a wrong length is just a wrong token', () => {
  assert.equal(tokenMatches('a'.repeat(32), 'a'.repeat(32)), true);
  assert.equal(tokenMatches('a', 'a'.repeat(32)), false);
  assert.equal(tokenMatches('a'.repeat(4000), 'a'.repeat(32)), false);
  assert.equal(tokenMatches('a'.repeat(31) + 'b', 'a'.repeat(32)), false);
});

/* ---------------- envelope parsing ---------------- */

test('the conversation is identified for calls, chats and dynamic variables', () => {
  assert.equal(conversationId({ call: { call_id: 'c1' } }), 'c1');
  assert.equal(conversationId({ chat: { chat_id: 'h1' } }), 'h1');
  assert.equal(conversationId({ call: { retell_llm_dynamic_variables: { session_id: 's1' } } }), 's1');
  assert.equal(conversationId({}), null);
  assert.equal(conversationLocale({ call: { retell_llm_dynamic_variables: { locale: 'ar' } } }), 'ar');
  assert.equal(conversationLocale({}), 'en');
});

test('args come from `args`, or from the root when args_at_root is used', () => {
  assert.deepEqual(toolArgs({ call: {}, name: 'x', args: { id: 'A' } }), { id: 'A' });
  assert.deepEqual(toolArgs({ call: {}, name: 'x', id: 'A' }), { id: 'A' });
});

/* ---------------- search_properties ---------------- */

test('search_properties returns at most five real listings as a JSON string', async () => {
  const h = harness();
  const raw = await h.tools.run('search_properties', { call: { call_id: 'c1' }, name: 'search_properties', args: { district: 'Al Nuzhah' } });
  assert.equal(typeof raw, 'string');
  const payload = JSON.parse(raw);
  assert.ok(payload.count > 0 && payload.count <= 5);
  assert.ok(payload.results.every((r) => r.id && r.title_ar && r.price_en && r.url_en));
  assert.ok(raw.length < 4000, 'must fit Retell’s tool-result cap');
  h.cleanup();
});

test('an empty search tells the model not to invent anything', async () => {
  const h = harness();
  const payload = JSON.parse(await h.tools.run('search_properties', { call: { call_id: 'c1' }, args: { district: 'Atlantis' } }));
  assert.equal(payload.count, 0);
  assert.deepEqual(payload.results, []);
  assert.match(payload.note, /never estimate|do not invent|Do not invent/i);
  h.cleanup();
});

test('search results land in the call context for the live "mentioned properties" list', async () => {
  const h = harness();
  await h.tools.run('search_properties', { call: { call_id: 'call_1' }, args: { district: 'Al Nuzhah' } });
  const ctx = h.store.getCall('call_1');
  assert.ok(ctx.cards.length > 0 && ctx.cards.length <= 3);
  assert.ok(ctx.cards[0].title.ar);
  h.cleanup();
});

/* ---------------- show_property ---------------- */

test('show_property records the card and confirms', async () => {
  const h = harness();
  const payload = JSON.parse(await h.tools.run('show_property', { call: { call_id: 'call_2' }, args: { id: KHALIDIYAH.id } }));
  assert.equal(payload.shown, true);
  assert.equal(payload.id, KHALIDIYAH.id);
  assert.equal(h.store.getCall('call_2').cards[0].id, KHALIDIYAH.id);
  h.cleanup();
});

test('show_property on an unknown id refuses rather than improvising', async () => {
  const h = harness();
  const payload = JSON.parse(await h.tools.run('show_property', { call: { call_id: 'call_3' }, args: { id: 'BONA-999' } }));
  assert.equal(payload.shown, false);
  assert.equal(payload.reason, 'not_found');
  h.cleanup();
});

/* ---------------- create_lead ---------------- */

test('create_lead appends to leads.jsonl and notifies the owner', async () => {
  const h = harness();
  const payload = JSON.parse(await h.tools.run('create_lead', {
    chat: { chat_id: 'chat_1', retell_llm_dynamic_variables: { locale: 'ar' } },
    args: { phone: '+966500000000', name: 'Sara', interest: 'villa in Al Shati', budget: '8m', notes: 'evenings' },
  }));
  assert.equal(payload.saved, true);
  const lines = fs.readFileSync(path.join(h.dataDir, 'leads.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.phone, '+966500000000');
  assert.equal(record.name, 'Sara');
  assert.equal(record.channel, 'chat');
  assert.equal(record.conversationId, 'chat_1');
  assert.match(record.id, /^LEAD-\d{8}-[0-9a-f]{8}$/);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /\+966500000000/);
  h.cleanup();
});

test('create_lead without any contact detail asks for one instead of saving', async () => {
  const h = harness();
  const payload = JSON.parse(await h.tools.run('create_lead', { call: { call_id: 'c9' }, args: { interest: 'a villa' } }));
  assert.equal(payload.saved, false);
  assert.equal(payload.reason, 'missing_contact');
  assert.equal(fs.existsSync(path.join(h.dataDir, 'leads.jsonl')), false);
  h.cleanup();
});

test('a failing WhatsApp notification never loses the lead', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-tools-'));
  const tools = createToolHandlers({
    inventory, store: createStore(), db: openDb(':memory:'), dataDir, siteUrl: 'https://bona.azoz.uk', env: {},
    sendWhatsApp: async () => { throw new Error('evolution down'); },
  });
  const payload = JSON.parse(await tools.run('create_lead', { call: { call_id: 'c1' }, args: { phone: '+966500000001' } }));
  assert.equal(payload.saved, true);
  assert.ok(fs.readFileSync(path.join(dataDir, 'leads.jsonl'), 'utf8').includes('+966500000001'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('lead fields are whitelisted and trimmed — an LLM cannot smuggle extra keys in', () => {
  const lead = normaliseLead({ phone: '  +966 50 000 0000 ', evil: 'x', notes: `a${' '.repeat(20)}b`, language: 'FR' });
  assert.deepEqual(Object.keys(lead).sort(), ['notes', 'phone']);
  assert.equal(lead.phone, '+966 50 000 0000');
  assert.equal(lead.notes, 'a b');
});

test('the owner note reads as a briefing, not as JSON', () => {
  const note = leadNote({ name: 'Sara', phone: '+966500000000', interest: 'villa', ts: '2026-09-05T20:00:00Z' });
  assert.match(note, /Bona — new enquiry/);
  assert.match(note, /Sara/);
  assert.ok(!note.includes('{'));
});

test('create_lead is idempotent inside its window — one enquiry, one WhatsApp note', async () => {
  const h = harness();
  const body = {
    chat: { chat_id: 'chat_dupe' },
    args: { phone: '+966 50 000 0000', name: 'Sara', notes: 'first' },
  };
  const first = JSON.parse(await h.tools.run('create_lead', body));
  const again = JSON.parse(await h.tools.run('create_lead', body));
  const spelled = JSON.parse(await h.tools.run('create_lead', {
    chat: { chat_id: 'chat_dupe' }, args: { phone: '0500000000', name: 'Sara' },
  }));
  assert.equal(again.id, first.id, 'a retry must return the lead that already exists');
  assert.equal(again.duplicate, true);
  assert.equal(spelled.id, first.id, 'the same number written another way is the same person');
  const lines = fs.readFileSync(path.join(h.dataDir, 'leads.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(h.sent.length, 1, 'the owner is told once');
  h.cleanup();
});

test('the dedupe window expires, and another conversation is a fresh touch on the same lead', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-tools-'));
  let t = 0;
  const db = openDb(':memory:');
  const tools = createToolHandlers({
    inventory, store: createStore(), db, dataDir, siteUrl: 'https://bona.azoz.uk', env: {},
    sendWhatsApp: async () => ({ ok: true }), now: () => t, leadDedupeMs: 10 * 60 * 1000,
  });
  const args = { phone: '+966500000000', name: 'Sara' };
  const first = JSON.parse(await tools.run('create_lead', { chat: { chat_id: 'c1' }, args }));
  const other = JSON.parse(await tools.run('create_lead', { chat: { chat_id: 'c2' }, args }));
  assert.equal(other.id, first.id, 'a second conversation from the same phone is the same person');
  assert.equal(other.duplicate, undefined, 'but not a retry — it went through the model and merged');
  t = 10 * 60 * 1000 + 1;
  const later = JSON.parse(await tools.run('create_lead', { chat: { chat_id: 'c1' }, args }));
  assert.equal(later.id, first.id);
  assert.equal(later.duplicate, undefined, 'ten minutes on, the retry window has closed');
  assert.deepEqual(db.touchpointsForLead(first.id).map((tp) => tp.event_type), ['lead_created', 'concierge', 'concierge']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'leads.jsonl'), 'utf8').trim().split('\n').length, 1, 'the raw log has one line per lead');
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('leadKey folds phone spellings together and falls back to the name', () => {
  const k = (phone, name) => leadKey({ conversationId: 'c1', phone, name });
  assert.equal(k('+966500000000'), k('0500000000'));
  assert.equal(k('+966500000000'), k('٠٥٠٠٠٠٠٠٠٠'), 'Arabic-Indic digits are the same number');
  assert.notEqual(k('+966500000000'), k('+966500000001'));
  assert.equal(k(null, ' Sara  Ahmed '), k('', 'sara ahmed'));
  assert.notEqual(leadKey({ conversationId: 'a', name: 'Sara' }), leadKey({ conversationId: 'b', name: 'Sara' }));
});

/* ---------------- attribution through Retell metadata ---------------- */

const ANON = '9f1c'.repeat(8);
const touch = (over = {}) => ({
  ts: 1, landing: '/properties/bona-w003/', referrer: 'https://l.instagram.com/', utm_source: 'meta', utm_medium: 'paid',
  utm_campaign: 'villas_sep', utm_content: 'reels', utm_term: null, utm_id: '1203', click_ids: { fbclid: 'IwAR1' }, ...over,
});

test('create_lead inherits the visitor\'s source from the session Retell\'s metadata names', async () => {
  const h = harness();
  h.db.upsertSession({ session_id: 'mf3k2a-7b1c', anon_id: ANON, ref: 'K7Q2XR', started: 1, last_seen: 2, pages: 2, locale: 'en', first_touch: touch(), last_touch: touch(), consent_ads: true, consent_analytics: true });
  const payload = JSON.parse(await h.tools.run('create_lead', {
    call: { call_id: 'call_9', metadata: { locale: 'en', page: '/properties/bona-w003/', source: 'bona-web', anon_id: ANON, session_id: 'mf3k2a-7b1c', ref: 'K7Q2XR', listing_id: 'BONA-W003' } },
    args: { phone: '0500000000', name: 'Sara' },
  }));
  assert.equal(payload.saved, true);
  const lead = h.db.getLead(payload.id);
  assert.equal(lead.channel, 'concierge_voice');
  assert.equal(lead.match_method, 'concierge');
  assert.equal(lead.source, 'meta');
  assert.equal(lead.medium, 'paid');
  assert.equal(lead.campaign, 'villas_sep');
  assert.equal(lead.session_id, 'mf3k2a-7b1c');
  assert.equal(lead.anon_id, ANON);
  assert.equal(lead.ref, 'K7Q2XR');
  assert.equal(lead.listing_id, 'BONA-W003', 'no property named in the call, so the page the widget opened on');
  assert.equal(lead.phone_e164, '966500000000');
  assert.equal(h.db.getEvent(h.db.recentEvents({ name: 'lead_created' })[0].event_id).session_id, 'mf3k2a-7b1c');
  assert.match(h.sent[0], /Source: meta \/ paid · villas_sep · Ref K7Q2XR · BONA-W003/);
  const raw = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'leads.jsonl'), 'utf8').trim());
  assert.equal(raw.id, payload.id);
  assert.equal(raw.channel, 'voice', 'the raw log keeps its old channel names');
  assert.equal(raw.conversationId, 'call_9');
  h.cleanup();
});

test('a property the model names wins over the page, and is resolved against inventory', async () => {
  const h = harness();
  const payload = JSON.parse(await h.tools.run('create_lead', {
    chat: { chat_id: 'chat_9', metadata: { listing_id: 'BONA-W003' } },
    args: { phone: '0500000000', listing_id: KHALIDIYAH.slug },
  }));
  const lead = h.db.getLead(payload.id);
  assert.equal(lead.listing_id, KHALIDIYAH.id);
  assert.equal(lead.channel, 'concierge_chat');
  assert.equal(lead.source, 'concierge', 'no session on record for this metadata');
  assert.equal(lead.session_id, null);
  h.cleanup();
});

test('a returning caller merges into the lead they already are, and the owner still hears', async () => {
  const h = harness();
  const first = JSON.parse(await h.tools.run('create_lead', { chat: { chat_id: 'c1' }, args: { phone: '+966500000000', name: 'Sara' } }));
  const later = JSON.parse(await h.tools.run('create_lead', { call: { call_id: 'c2' }, args: { phone: '0500000000', interest: 'now a penthouse' } }));
  assert.equal(later.saved, true);
  assert.equal(later.id, first.id, 'the same phone from another conversation is the same person');
  assert.equal(later.duplicate, undefined, 'not a retry — a new conversation');
  assert.deepEqual(h.db.touchpointsForLead(first.id).map((t) => t.event_type), ['lead_created', 'concierge']);
  assert.equal(h.db.getLead(first.id).interest, 'now a penthouse');
  assert.equal(h.db.getLead(first.id).name, 'Sara');
  assert.equal(h.sent.length, 2);
  assert.equal(fs.readFileSync(path.join(h.dataDir, 'leads.jsonl'), 'utf8').trim().split('\n').length, 1, 'one raw-log line per lead');
  h.cleanup();
});

test('the tool context exposes the metadata as ctx.attr', async () => {
  const h = harness();
  let seen;
  h.tools.handlers.show_property = async (args, ctx) => { seen = ctx; return {}; };
  await h.tools.run('show_property', { chat: { chat_id: 'c1', metadata: { session_id: 'mf3k2a-7b1c', anon_id: ANON } }, args: { id: 'x' } });
  assert.deepEqual(seen.attr, { session_id: 'mf3k2a-7b1c', anon_id: ANON });
  await h.tools.run('show_property', { call: { call_id: 'c2' }, args: { id: 'x' } });
  assert.deepEqual(seen.attr, {});
  h.cleanup();
});

test('an unknown tool name is rejected', async () => {
  const h = harness();
  await assert.rejects(() => h.tools.run('drop_tables', {}), /unknown tool/);
  h.cleanup();
});

test('the data directory and its files are owner-only — enquiries are personal data', function (t) {
  if (process.platform === 'win32') return t.skip('POSIX modes only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-modes-'));
  const dataDir = path.join(dir, 'bona-data');
  appendLead(dataDir, { phone: '+966500000000' });
  appendJsonl(dataDir, 'calls.jsonl', { event: 'call_ended' });
  appendJsonl(dataDir, 'chats.jsonl', { event: 'chat_ended' });
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  for (const name of ['leads.jsonl', 'calls.jsonl', 'chats.jsonl']) {
    assert.equal(fs.statSync(path.join(dataDir, name)).mode & 0o777, 0o600, name);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
