import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolHandlers, tokenMatches, extractToken, conversationId, conversationLocale, toolArgs } from '../lib/tools.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { createStore } from '../lib/store.mjs';
import { normaliseLead, leadNote } from '../lib/leads.mjs';

const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const KHALIDIYAH = inventory.all().find((l) => l.location.district.en === 'Al Khalidiyah');

function harness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-tools-'));
  const sent = [];
  const store = createStore();
  const tools = createToolHandlers({
    inventory, store, dataDir, siteUrl: 'https://bona.azoz.uk', env: {},
    // The real Evolution API is NEVER touched from tests.
    sendWhatsApp: async (text) => { sent.push(text); return { ok: true }; },
  });
  return { dataDir, sent, store, tools, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
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

test('the token may arrive as a query param, a header or a bearer', () => {
  const url = new URL('https://api.bona.azoz.uk/v1/tools/show_property?token=q1');
  assert.equal(extractToken({ url, headers: {} }), 'q1');
  assert.equal(extractToken({ url: new URL('https://x/y'), headers: { 'x-bona-token': 'h1' } }), 'h1');
  assert.equal(extractToken({ url: new URL('https://x/y'), headers: { authorization: 'Bearer b1' } }), 'b1');
  assert.equal(extractToken({ url: new URL('https://x/y'), headers: {} }), null);
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
    inventory, store: createStore(), dataDir, siteUrl: 'https://bona.azoz.uk', env: {},
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

test('an unknown tool name is rejected', async () => {
  const h = harness();
  await assert.rejects(() => h.tools.run('drop_tables', {}), /unknown tool/);
  h.cleanup();
});
