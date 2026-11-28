import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect, isDeepStrictEqual } from 'node:util';
import { createToolHandlers, tokenMatches, extractToken, conversationId, conversationLocale, toolArgs, leadKey, HANDOVER_TOOL, TOOL_NAMES, FULL_UNIT_ROW_SOURCES, UNITS_NOTE, UNITS_NOT_PUBLISHED_NOTE, BLOCKED_BROCHURES, BROCHURE_HEAD_MS, BROCHURE_CACHE_MS, BROCHURE_MAX_BYTES, BROCHURE_FAIL_CACHE_MS, HANDOVER_KINDS, WA_ONLY_TOOLS } from '../lib/tools.mjs';
import { saveNeeds as realSaveNeeds } from '../lib/lead-tasks.mjs';
import { createInventory, readInventoryFile, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { createUnits, WORKTREE_UNITS } from '../lib/units.mjs';
import { createPublishedUnits } from '../lib/published-units.mjs';
import { recordFor, unitSummary } from '../lib/units-summary.mjs';
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
  const deps = {
    inventory, store, db, dataDir, siteUrl: 'https://bona.azoz.uk', env: {},
    // The real Evolution API is NEVER touched from tests.
    sendWhatsApp: async (text) => { sent.push(text); return { ok: true }; },
    // Nor the live site: search_units reads the listing page through this (a test that needs a page brings its own).
    publishedUnits: createPublishedUnits({ fetch: async () => { throw new Error('tests never touch the network'); } }),
  };
  const tools = createToolHandlers(deps);
  return { deps, dataDir, sent, store, db, tools, cleanup: () => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
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

test('request_human answers a note that hands the chat over, logs the lead id only, never the reason', async () => {
  const logs = [];
  const h = harness();
  const tools = createToolHandlers({ ...h.deps, log: (o) => logs.push(o) });
  try {
    assert.equal(HANDOVER_TOOL, 'request_human');
    assert.ok(TOOL_NAMES.includes('request_human'));
    const body = { chat: { chat_id: 'chat_wa_1', metadata: { source: 'bona-whatsapp', lead_id: 'LEAD-20260930-0000dddd' } }, name: 'request_human', args: { reason: 'wants a viewing with Sara 0500000009' } };
    const out = JSON.parse(await tools.run('request_human', body));
    assert.equal(out.ok, true);
    assert.match(out.note, /team will reply shortly/);
    assert.deepEqual(logs.filter((l) => l.evt === 'tool.request_human'), [{ evt: 'tool.request_human', leadId: 'LEAD-20260930-0000dddd' }]);
    const odd = JSON.parse(await tools.run('request_human', { chat: { chat_id: 'c', metadata: { lead_id: '../etc' } }, name: 'request_human', args: {} }));
    assert.equal(odd.ok, true);
    assert.equal(logs.at(-1).leadId, null, 'a lead id that does not look like one is not logged');
    assert.doesNotMatch(JSON.stringify(logs), /viewing|Sara|0500000009/);
    assert.equal(h.sent.length, 0, 'no WhatsApp note is sent');
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'leads.jsonl')), 'no lead is written');
  } finally {
    h.cleanup();
  }
});


test('site chat and voice serious buyers create durable no-match handoffs and requested viewings', async()=>{
 const h=harness();try {
  const body={chat:{chat_id:'handoff-web'},args:{phone:'0500000077',budget:'Buyer stated amount',area:'Riyadh',property_type:'villa',timeline:'Soon',no_match:true,viewing_requested:true}};
  const first=JSON.parse(await h.tools.run('create_lead',body));await h.tools.run('create_lead',body);
  const tasks=h.db.db.prepare('SELECT kind,status,details FROM lead_tasks WHERE lead_id=?').all(first.id);
  assert.equal(tasks.length,2);assert.equal(tasks.find(t=>t.kind==='viewing').status,'requested');
  const detail=JSON.parse(tasks.find(t=>t.kind==='handoff').details);assert.equal(detail.no_match,true);assert.equal(detail.area,'Riyadh');assert.equal('financing' in detail,false);assert.equal(h.sent.length,1);
 }finally{h.cleanup();}
});



test('qualification after initial contact capture enriches and corrects one existing handoff',async()=>{
 const h=harness();try {
  const chat={chat_id:'enriched-contact'};const first=JSON.parse(await h.tools.run('create_lead',{chat,args:{phone:'0500000078',budget:'4 million'}}));
  const second=JSON.parse(await h.tools.run('create_lead',{chat,args:{phone:'0500000078',budget:'6 million',area:'Riyadh',property_type:'villa',timeline:'Next month',no_match:true,viewing_requested:true}}));
  assert.equal(second.id,first.id);assert.equal(h.sent.length,1);const rows=h.db.db.prepare('SELECT kind,details FROM lead_tasks WHERE lead_id=?').all(first.id);
  assert.equal(rows.length,2);const needs=JSON.parse(rows.find(r=>r.kind==='handoff').details);assert.equal(needs.budget,'6 million');assert.equal(needs.no_match,true);assert.equal(needs.timeframe,'Next month');assert.equal(h.db.getLead(first.id).budget,'6 million');
 }finally{h.cleanup();}
});


test('a later concierge conversation notifies using the newly corrected requirements',async()=>{
 const h=harness();try {
  await h.tools.run('create_lead',{chat:{chat_id:'old'},args:{phone:'0500000076',budget:'4 million'}});
  await h.tools.run('create_lead',{chat:{chat_id:'new'},args:{phone:'0500000076',budget:'6 million'}});
  assert.match(h.sent.at(-1),/6 million/);assert.doesNotMatch(h.sent.at(-1),/4 million/);
 }finally{h.cleanup();}
});

test('concierge wiring calls the handoff notifier after commit, including enriched repeated qualification',async()=>{
 const h=harness();try{const called=[];const tools=createToolHandlers({...h.deps,notifyHandoff:async id=>{const task=h.db.db.prepare("SELECT * FROM lead_tasks WHERE lead_id=? AND kind='handoff'").get(id);assert.ok(task);called.push(JSON.parse(task.details));}});
  const chat={chat_id:'telegram-wiring'};await tools.run('create_lead',{chat,args:{phone:'0500000074',budget:'4 million'}});await tools.run('create_lead',{chat,args:{phone:'0500000074',budget:'6 million',no_match:true}});
  assert.equal(called.length,2);assert.equal(called[1].budget,'6 million');assert.equal(called[1].no_match,true);assert.equal(h.sent.length,1);
 }finally{h.cleanup();}
});

test("the tool notes offer the site's WhatsApp number (src/data/site.json)", async () => {
  const site = JSON.parse(fs.readFileSync(new URL('../../../src/data/site.json', import.meta.url), 'utf8'));
  const h = harness();
  const empty = JSON.parse(await h.tools.run('search_properties', { call: { call_id: 'c1' }, args: { district: 'Atlantis' } }));
  assert.ok(empty.note.includes(`WhatsApp ${site.whatsapp.display}`), empty.note);
  const saved = JSON.parse(await h.tools.run('create_lead', {
    chat: { chat_id: 'chat_9', retell_llm_dynamic_variables: { locale: 'en' } },
    args: { phone: '+966500000000', name: 'Sara', interest: 'villa' },
  }));
  assert.ok(saved.note.includes(`WhatsApp ${site.whatsapp.display}`), saved.note);
  h.cleanup();
});


/* ---------------- search_units: the live page's published cut for every source (DESIGN §4.5, PR-0) ---------------- */

// A W014-shaped sheet: two 1-bed units (the dearer one's cash price is NOT published), a 3-bed, a priceless
// 2-bed, and two penthouses (the dearest cash price, units.mjs summary()'s price_to_en, is NOT published).
// Every unit has instalment prices, none of which is published. Refs and amounts are made up: the public repo
// must not carry a real unit's unpublished prices in a fixture (a test below checks them against the real sheet).
// search_units no longer reads it (it quotes the live page); the owner's veto path and the leak checks do.
const UNIT = (ref, beds, cls, areaSqm, [cash, half, year, twoYear]) => ({
  ref, building: ref.split('-')[0], unit: ref.split('-')[1], floor: { en: '3rd', ar: 'الدور الثالث' }, floorIndex: 3,
  facing: { en: 'South', ar: 'جنوبية' }, beds, baths: beds + 1, maidRoom: beds > 2, class: cls,
  type: { en: 'Apartment', ar: 'شقة' }, areaSqm, roofSqm: 0, feature: { en: 'Main garden', ar: 'حديقة رئيسية' },
  price: { cash, half, year, twoYear },
});
const SHEET = {
  listingId: 'BONA-W014', project: { en: 'Darco Prime Waterfront', ar: 'داركو برايم' },
  district: { en: 'Al-Shati District', ar: 'حي الشاطئ' }, city: { en: 'Jeddah', ar: 'جدة' },
  delivery: '2028-06', currency: 'SAR', updated: '2026-09-02',
  units: [
    UNIT('B91-22', 1, 'Standard', 54.25, [701500, 716500, 771500, 806500]),
    UNIT('B91-23', 1, 'Standard', 60.1, [745000, 761000, 819500, 856750]),
    UNIT('B92-12', 3, 'Standard', 121.75, [1351500, 1381500, 1486500, 1554500]),
    UNIT('B99-11', 2, 'Premium', 90, [null, null, null, null]),
    UNIT('B07-31', 2, 'Penthouse', 210.5, [2100000, 2145000, 2310000, 2415000]),
    UNIT('B07-32', 2, 'Penthouse', 230.25, [2450000, 2502000, 2695000, 2817500]),
  ],
};
const PUBLISHED_CUT = {
  rows: [
    { label: { en: '1 bedroom', ar: 'غرفة نوم واحدة' }, count: 2, areaMin: 54.25, areaMax: 60.1, cashFrom: 701500 },
    { label: { en: '3 bedrooms', ar: '3 غرف نوم' }, count: 1, areaMin: 121.75, areaMax: 121.75, cashFrom: 1351500 },
    { label: { en: 'Penthouse, 2 bedrooms', ar: 'بنتهاوس، غرفتا نوم' }, count: 2, areaMin: 210.5, areaMax: 230.25, cashFrom: 2100000 },
  ],
  delivery: '2028-06', updated: '2026-09-02',
};
/** What the live listing page's data-units-summary carries for SHEET: the table it prints (ProjectDetails.astro). */
const PAGE_SUMMARY = {
  listingId: 'BONA-W014', count: 5, areaMin: 54.25, areaMax: 230.25, cashFrom: 701500,
  delivery: PUBLISHED_CUT.delivery, updated: PUBLISHED_CUT.updated, rows: PUBLISHED_CUT.rows,
};
// The page as an earlier build printed it (made-up figures): the site has not deployed the newer sheet yet.
const OLDER_PAGE_SUMMARY = {
  ...PAGE_SUMMARY, count: 4, cashFrom: 698250, updated: '2026-08-20',
  rows: [{ ...PAGE_SUMMARY.rows[0], count: 1, cashFrom: 698250 }, ...PAGE_SUMMARY.rows.slice(1)],
};
const OLDER_CUT = { rows: OLDER_PAGE_SUMMARY.rows, delivery: OLDER_PAGE_SUMMARY.delivery, updated: OLDER_PAGE_SUMMARY.updated };
// The page after a Pages deploy changed a starting price (a made-up figure).
const CHANGED_PAGE_SUMMARY = {
  ...PAGE_SUMMARY, cashFrom: 689750, updated: '2026-11-20',
  rows: [{ ...PAGE_SUMMARY.rows[0], cashFrom: 689750 }, ...PAGE_SUMMARY.rows.slice(1)],
};
const CHANGED_CUT = { rows: CHANGED_PAGE_SUMMARY.rows, delivery: CHANGED_PAGE_SUMMARY.delivery, updated: CHANGED_PAGE_SUMMARY.updated };
const SITE = 'https://site.example.com';
const W014_PAGE = `${SITE}/properties/darco-prime-waterfront-fixture/`;
const UNITS_NOW = Date.parse('2026-11-27T09:00:00Z');
const SOURCES = ['bona-whatsapp', 'bona-email', 'bona-web', undefined, 'someone-else'];
// What a model asking for a unit would send: a unit ref, a plan, a bed count, a budget.
const UNIT_ARGS = { listing_id: 'BONA-W014', beds: 1, plan: 'twoYear', query: 'B91-23', max_price: 900000, limit: 20, maid_room: false };

/** Astro's attribute escaping (html-escaper): & < > ' " become entities. */
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
/** A listing page as the site builds it; `summary` null is a page without the units table (sold, hidden, no sheet). */
function listingPage(summary) {
  const table = summary == null ? '' : `<section id="units" data-project-details><div class="mt-5 overflow-x-auto" data-units-summary="${
    escapeAttr(typeof summary === 'string' ? summary : JSON.stringify(summary))}"><table></table></div></section>`;
  return `<!doctype html><html lang="en"><body><main><h1>Darco Prime Waterfront</h1>${table}</main></body></html>`;
}

/** A one-listing inventory (W014, with the given status) built on a real listing so cards render. */
function w014Inventory(status = 'available') {
  const template = readInventoryFile(WORKTREE_LISTINGS)[0];
  const w014 = { ...template, id: 'BONA-W014', slug: 'darco-prime-waterfront-fixture', status };
  return createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk', read: () => [w014] });
}

/** A fake live site: `answer(url, callNo)` gives a page (a string: 200), a Response, or an Error (thrown). */
function fakeSite(answer) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const a = await answer(String(url), calls.length);
    if (a instanceof Error) throw a;
    return typeof a === 'string' ? new Response(a, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) : a;
  };
  return { fetch, calls };
}

/** `page`: the summary the live W014 page carries (null: none). `answer` replaces the whole fake site. */
function unitsHarness({ sheet = SHEET, status = 'available', withUnits = true, extra = {}, page = PAGE_SUMMARY, answer = null, timeoutMs } = {}) {
  const h = harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-tool-units-'));
  const file = path.join(dir, 'units.json');
  fs.writeFileSync(file, JSON.stringify(sheet));
  const site = fakeSite(answer ?? ((url) => (url === W014_PAGE ? listingPage(page) : new Response('not found', { status: 404 }))));
  const tools = createToolHandlers({
    ...h.deps, siteUrl: SITE, inventory: w014Inventory(status), units: withUnits ? createUnits({ file }) : null, now: () => UNITS_NOW,
    publishedUnits: createPublishedUnits({ siteUrl: SITE, fetch: site.fetch, ...(timeoutMs ? { timeoutMs } : {}) }),
    ...extra,
  });
  const ask = async (source, args = UNIT_ARGS) => {
    const raw = await tools.run('search_units', { chat: { chat_id: `units-${source}`, metadata: source === undefined ? {} : { source } }, args });
    return { raw, result: JSON.parse(raw) };
  };
  return {
    ...h, tools, ask, file, site,
    cleanup: () => { h.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Nothing unpublished in the tool result: no per-unit rows, refs, plan keys or prices beyond the "from" rows.
 * A failure prints in a public CI log, so it never shows the result or the value it found: assert.ok on a boolean
 * (its `actual` is `false`, not the result), and a unit named by its place on the sheet, never by its ref or amount.
 */
function assertNoUnpublished(raw, sheet = SHEET) {
  const absent = (re, what) => assert.ok(!re.test(raw), `${what} is in the result`);
  absent(/price_to/, 'price_to / price_to_en (the highest cash price)');
  absent(/price_two_year/, 'a two-year price key');
  absent(/"(plan|plans|cash|half|year|twoYear|price_cash_en|price_en|price_ar|availability|total_matching)"\s*:/, 'a plan or per-unit price key');
  absent(/\bB\d{2}-\d{2}\b/, 'a unit reference (B00-00 shape)');
  absent(/\bB\d{2}-\d+\b/, 'a unit reference of any length');
  absent(/results/, 'a per-unit results list');
  const published = new Set(JSON.parse(raw).summary?.rows.map((r) => r.cashFrom) ?? []);
  sheet.units.forEach((u, i) => {
    for (const [plan, amount] of Object.entries(u.price)) {
      if (typeof amount !== 'number' || (plan === 'cash' && published.has(amount))) continue;
      assert.ok(!raw.includes(String(amount)) && !raw.includes(amount.toLocaleString('en-US')), `unit #${i}: its unpublished ${plan} price is in the result`);
    }
  });
}

test('assertNoUnpublished catches a leak without printing the leaked value or the result (public CI logs)', () => {
  const [ref, amount] = [SHEET.units[1].ref, SHEET.units[1].price.twoYear];
  const leaks = [
    { summary: null, note: `ask about ${ref}` },
    { summary: null, note: `two years: ${amount}` },
    { summary: null, note: `two years: SAR ${amount.toLocaleString('en-US')}` },
  ];
  for (const leak of leaks) {
    let err = null;
    try { assertNoUnpublished(JSON.stringify(leak)); } catch (e) { err = e; }
    assert.ok(err instanceof assert.AssertionError, 'the leak is caught');
    const shown = `${err.message}\n${inspect(err)}`;
    assert.ok(![ref, String(amount), amount.toLocaleString('en-US'), leak.note].some((v) => shown.includes(v)), 'the failure output shows no leaked value');
  }
});

const keys = (o) => Object.keys(o).sort();
const notPublished = (result, what) => {
  assert.deepEqual(result, { count: 0, summary: null, note: UNITS_NOT_PUBLISHED_NOTE }, `${what}: the allow-listed shape, nothing quoted`);
};

test('search_units: every source (WhatsApp, email, website, none, unknown) gets exactly the live page\'s per-bedroom "from" rows', async () => {
  const h = unitsHarness();
  try {
    for (const source of SOURCES) {
      const { raw, result } = await h.ask(source);
      assert.deepEqual(keys(result), ['count', 'note', 'summary'], `${source}: top-level keys`);
      assert.deepEqual(keys(result.summary), ['delivery', 'rows', 'updated'], `${source}: summary keys`);
      for (const row of result.summary.rows) {
        assert.deepEqual(keys(row), ['areaMax', 'areaMin', 'cashFrom', 'count', 'label'], `${source}: row keys`);
        assert.deepEqual(keys(row.label), ['ar', 'en'], `${source}: label keys`);
      }
      assert.deepEqual(result.summary, PUBLISHED_CUT, `${source}: the rows the live page shows`);
      assert.equal(result.count, 5, `${source}: the available units the page counts`);
      assert.equal(result.note, UNITS_NOTE, source);
      assertNoUnpublished(raw);
    }
    // The project card still goes on the visitor's screen (the website chat's "mentioned properties").
    assert.equal(h.store.getCall('units-bona-web').cards[0].id, 'BONA-W014');
    // No arguments at all is the same published cut (W014 is the default project).
    const bare = await h.ask('bona-whatsapp', {});
    assert.deepEqual(bare.result.summary, PUBLISHED_CUT);
    assertNoUnpublished(bare.raw);
    // A blank id is no id: W014 still answers (the Retell schema: "Defaults to BONA-W014").
    for (const blank of [{ listing_id: '' }, { listing_id: '   ' }, { listing_id: null }, { id: '' }, { listing_id: '', id: ' ' }, { listing_id: ' ', id: 'bona-w014' }]) {
      const r = await h.ask('bona-whatsapp', blank);
      assert.deepEqual(r.result.summary, PUBLISHED_CUT, `${JSON.stringify(blank)}: W014 is the default project`);
      assertNoUnpublished(r.raw);
    }
    // The first id that is not blank decides: a blank listing_id does not hide the id given beside it.
    notPublished((await h.ask('bona-whatsapp', { listing_id: ' ', id: 'BONA-005' })).result, 'BONA-005 beside a blank id');
    // No cache: each of the 12 W014 answers above is a GET of the live W014 page of its own (BONA-005 is not fetched).
    assert.equal(h.site.calls.length, SOURCES.length + 1 + 6, 'one GET per W014 call');
    assert.ok(h.site.calls.every((url) => url === W014_PAGE), 'only the W014 page');
  } finally { h.cleanup(); }
});

test('search_units quotes the live page, never units.json: a sheet the page does not show yet is not quoted, and no local sheet is needed', async () => {
  // units.json on the VPS has the newer sheet (SHEET); the live page still shows the build before it.
  const behind = unitsHarness({ page: OLDER_PAGE_SUMMARY });
  try {
    for (const source of SOURCES) {
      const { raw, result } = await behind.ask(source);
      assert.deepEqual(result.summary, OLDER_CUT, `${source}: the page's rows, not the newer sheet's`);
      assert.equal(result.count, OLDER_PAGE_SUMMARY.count, source);
      assertNoUnpublished(raw);
    }
  } finally { behind.cleanup(); }
  // units.json has a current sheet, the page shows no table (a failed build, a hidden table): nothing.
  const hidden = unitsHarness({ page: null });
  try {
    for (const source of SOURCES) notPublished((await hidden.ask(source)).result, `no table on the page, ${source}`);
    assert.equal(hidden.store.getCall('units-bona-web'), null, 'no project card for an unpublished summary');
  } finally { hidden.cleanup(); }
  // No sheet loaded on this host at all: the page alone decides.
  const noSheet = unitsHarness({ withUnits: false });
  try {
    for (const source of SOURCES) assert.deepEqual((await noSheet.ask(source)).result.summary, PUBLISHED_CUT, `no units.json, ${source}`);
  } finally { noSheet.cleanup(); }
});

test('search_units: a page whose summary is malformed, not the allow-listed shape, another listing\'s or a non-bedroom label → the "not published" note, no card', async () => {
  const row0 = PAGE_SUMMARY.rows[0];
  const withRow = (r) => ({ ...PAGE_SUMMARY, rows: [r, ...PAGE_SUMMARY.rows.slice(1)] });
  for (const [name, page] of [
    ['broken JSON', '{"listingId":"BONA-W014","rows":['],
    ['per-unit rows beside the summary', { ...PAGE_SUMMARY, units: [{ ref: 'B91-22' }] }],
    ['a plan price in a row', withRow({ ...row0, twoYear: 806500 })],
    ['a unit ref in a row', withRow({ ...row0, ref: 'B91-22' })],
    ['a negative price', withRow({ ...row0, cashFrom: -1 })],
    ['a price that is not a number', withRow({ ...row0, cashFrom: null })],
    ['another listing\'s summary', { ...PAGE_SUMMARY, listingId: 'BONA-W999' }],
    ['a unit ref as a row label (a malformed sheet)', withRow({ ...row0, label: { en: 'B95-17 bedrooms', ar: 'B95-17 غرف نوم' } })],
    ['a blank bedroom count as a row label', withRow({ ...row0, label: { en: 'null bedrooms', ar: 'null غرف نوم' } })],
  ]) {
    const h = unitsHarness({ page });
    try {
      for (const source of SOURCES) {
        const { raw, result } = await h.ask(source);
        notPublished(result, `${name}, ${source}`);
        assertNoUnpublished(raw);
      }
      assert.equal(h.store.getCall('units-bona-web'), null, `${name}: no project card`);
    } finally { h.cleanup(); }
  }
  // A penthouse with a blank bedroom cell: the page prints "Penthouse, 0–2 bedrooms", a whole-count label, quoted.
  const blank = { label: { en: 'Penthouse, 0–2 bedrooms', ar: 'بنتهاوس، من 0 إلى 2 غرف نوم' }, count: 3, areaMin: 205.75, areaMax: 230.25, cashFrom: 1950000 };
  const h = unitsHarness({ page: { ...PAGE_SUMMARY, count: 6, rows: [...PAGE_SUMMARY.rows.slice(0, 2), blank] } });
  try {
    assert.deepEqual((await h.ask('bona-whatsapp')).result.summary, { ...PUBLISHED_CUT, rows: [...PUBLISHED_CUT.rows.slice(0, 2), blank] });
  } finally { h.cleanup(); }
});

test('search_units: no cache and no fallback: every call reads the live page; a changed price is quoted as changed, a removed table or a failure on the next call → "not published"', async () => {
  let state = 'up';
  const pages = {
    up: () => listingPage(PAGE_SUMMARY),
    changed: () => listingPage(CHANGED_PAGE_SUMMARY),
    'the table removed': () => listingPage(null),
    'HTTP 500': () => new Response('oops', { status: 500 }),
    'a 404': () => new Response('not found', { status: 404 }),
    'a timeout': () => new Promise(() => {}),
    'a network error': () => new TypeError('fetch failed'),
  };
  const h = unitsHarness({ answer: () => pages[state](), timeoutMs: 20 });
  let asked = 0;
  const ask = (source) => { asked++; return h.ask(source); };
  try {
    for (const source of SOURCES) assert.deepEqual((await ask(source)).result.summary, PUBLISHED_CUT, `${source}: up`);
    // A Pages deploy changes a starting price: the very next call quotes the new price, for every source.
    state = 'changed';
    for (const source of SOURCES) {
      const { raw, result } = await ask(source);
      assert.deepEqual(result.summary, CHANGED_CUT, `${source}: the changed price, at once`);
      assert.equal(result.note, UNITS_NOTE);
      assertNoUnpublished(raw);
      assert.ok(!raw.includes('701500') && !raw.includes('701,500'), `${source}: the price the page no longer shows is not quoted`);
    }
    // The table taken off the page, then each kind of failure, each right after a good answer: "not published".
    for (const gone of ['the table removed', 'HTTP 500', 'a 404', 'a timeout', 'a network error']) {
      state = 'up';
      assert.deepEqual((await ask('bona-whatsapp')).result.summary, PUBLISHED_CUT, `${gone}: up just before`);
      state = gone;
      for (const source of SOURCES) {
        const { raw, result } = await ask(source);
        notPublished(result, `${gone}, ${source}: on the very next call, not the summary a moment ago`);
        assertNoUnpublished(raw);
      }
    }
    state = 'up';
    assert.deepEqual((await ask('bona-email')).result.summary, PUBLISHED_CUT, 'back');
    assert.equal(h.site.calls.length, asked, 'one GET of the live page per search_units call');
    assert.ok(h.site.calls.every((url) => url === W014_PAGE));
  } finally { h.cleanup(); }
});

test('search_units: calls that arrive together share one GET of the live page; the next call has a GET of its own', async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let summary = PAGE_SUMMARY;
  const h = unitsHarness({ answer: async () => { await gate; return listingPage(summary); } });
  try {
    const together = [h.ask('bona-whatsapp'), h.ask('bona-web'), h.ask('bona-email')];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.site.calls.length, 1, 'three calls in flight, one GET');
    open();
    for (const { raw, result } of await Promise.all(together)) {
      assert.deepEqual(result.summary, PUBLISHED_CUT);
      assertNoUnpublished(raw);
    }
    summary = CHANGED_PAGE_SUMMARY;
    assert.deepEqual((await h.ask('bona-whatsapp')).result.summary, CHANGED_CUT, 'the next call reads the page as it is now');
    assert.equal(h.site.calls.length, 2);
  } finally { h.cleanup(); }
});

test('search_units: a listing the inventory does not list as available, an unknown project or one without a page → not published, and only a listed project\'s page is asked', async () => {
  const sold = unitsHarness({ status: 'sold' });
  try {
    for (const source of SOURCES) notPublished((await sold.ask(source)).result, `a sold listing, ${source}`);
    assert.deepEqual(sold.site.calls, [], 'a listing the inventory has as sold: the page is not asked');
    assert.equal(sold.store.getCall('units-bona-web'), null);
  } finally { sold.cleanup(); }
  const h = unitsHarness();
  try {
    for (const listing_id of ['BONA-005', 'BONA-W999', 'darco-prime-waterfront-fixture', '../admin']) {
      const { raw, result } = await h.ask('bona-whatsapp', { listing_id });
      notPublished(result, listing_id);
      assertNoUnpublished(raw);
    }
    assert.deepEqual(h.site.calls, [], 'an id the inventory does not list by that exact id: no request');
  } finally { h.cleanup(); }
  // The page is gone (404): nothing.
  const gone = unitsHarness({ answer: () => new Response('not found', { status: 404 }) });
  try {
    notPublished((await gone.ask('bona-whatsapp')).result, 'a 404');
  } finally { gone.cleanup(); }
});

test('search_units: by default it reads the live page of the site the service is configured with (siteUrl: BONA_SITE or site.json)', async () => {
  const h = harness();
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(listingPage(PAGE_SUMMARY), { status: 200 }); };
  try {
    const { publishedUnits: _fake, ...deps } = h.deps;
    const tools = createToolHandlers({ ...deps, siteUrl: 'https://live.example.com', inventory: w014Inventory() });
    const result = JSON.parse(await tools.run('search_units', { chat: { chat_id: 'default', metadata: { source: 'bona-whatsapp' } }, args: {} }));
    assert.deepEqual(result.summary, PUBLISHED_CUT);
    assert.deepEqual(calls, ['https://live.example.com/properties/darco-prime-waterfront-fixture/']);
  } finally { globalThis.fetch = realFetch; h.cleanup(); }
});

test('the search_units fixture is made up: no unit ref or price of it is on the real sheet (src/data/units.json)', () => {
  const real = [JSON.parse(fs.readFileSync(WORKTREE_UNITS, 'utf8'))].flat().flatMap((r) => r?.units ?? []);
  assert.ok(real.length > 0, 'the real sheet has units');
  const refs = new Set(real.map((u) => u.ref));
  const amounts = new Set(real.flatMap((u) => Object.values(u.price ?? {})).filter((n) => typeof n === 'number'));
  // The messages name the fixture unit by its place, never by a value: a failure here prints in a public CI log.
  SHEET.units.forEach((u, i) => {
    assert.ok(!refs.has(u.ref), `fixture unit #${i}: its ref is on the real sheet`);
    for (const plan of Object.keys(u.price)) assert.ok(!amounts.has(u.price[plan]), `fixture unit #${i}: its ${plan} price is on the real sheet`);
  });
  [OLDER_PAGE_SUMMARY.cashFrom, CHANGED_PAGE_SUMMARY.cashFrom].forEach((n, i) => assert.ok(!amounts.has(n), `made-up page figure #${i} is on the real sheet`));
});

test('search_units: the source set the full rows by default is empty (deny by default); the veto is that one set', async () => {
  assert.deepEqual([...FULL_UNIT_ROW_SOURCES], [], 'no source gets per-unit rows unless the owner vetoes the cut');
  assert.ok(Object.isFrozen(FULL_UNIT_ROW_SOURCES), 'nothing can add a source at run time');
  // The owner's veto on the website-chat cut: bona-web alone gets the old per-unit rows back.
  const h = unitsHarness({ extra: { fullUnitRowSources: ['bona-web'] } });
  try {
    const web = (await h.ask('bona-web', { listing_id: 'BONA-W014', beds: 1 })).result;
    assert.deepEqual(web.results.map((r) => r.ref), ['B91-22', 'B91-23'], 'the veto path: today\'s per-unit rows');
    assert.ok(web.availability, 'the veto path keeps the old availability block');
    for (const source of ['bona-whatsapp', 'bona-email', undefined]) {
      const { raw, result } = await h.ask(source);
      assert.deepEqual(result.summary, PUBLISHED_CUT, `${source}: still the cut under the website veto`);
      assertNoUnpublished(raw);
    }
  } finally { h.cleanup(); }
});

test('search_units: the note says the prices are "from" prices and no longer asks for a unit reference', async () => {
  const h = unitsHarness();
  try {
    for (const source of SOURCES) {
      const { result } = await h.ask(source);
      assert.match(result.note, /quote them as 'from'/, result.note);
      assert.match(result.note, /published starting cash prices per bedroom count/, result.note);
      assert.match(result.note, /payment plans are not published: offer a person/, result.note);
      assert.doesNotMatch(result.note, /unit reference|B\d{2}-\d+|quote them exactly/i, result.note);
    }
    assert.match(UNITS_NOT_PUBLISHED_NOTE, /not published/);
    assert.doesNotMatch(UNITS_NOT_PUBLISHED_NOTE, /unit reference|B\d{2}-\d+/i);
  } finally { h.cleanup(); }
});

test('search_units on the real W014 sheet (src/data/units.json), as the page would publish it: nothing beyond the "from" rows, for every source', async () => {
  // The page's attribute for the real sheet, built the way ProjectDetails.astro builds it (from the summary the
  // table prints). Every check is a boolean: these are the real sheet's figures (public CI logs).
  const record = recordFor(JSON.parse(fs.readFileSync(WORKTREE_UNITS, 'utf8')), 'BONA-W014');
  const s = unitSummary(record);
  assert.ok(s !== null, 'the real W014 sheet summarises');
  const page = {
    listingId: 'BONA-W014', count: s.count, areaMin: s.areaMin, areaMax: s.areaMax, cashFrom: s.cashFrom, delivery: s.delivery, updated: s.updated,
    rows: s.rows.map((r) => ({ label: r.label, count: r.count, areaMin: r.areaMin, areaMax: r.areaMax, cashFrom: r.cashFrom })),
  };
  const h = unitsHarness({ page });
  try {
    // One record today, an array once a second project has a sheet: every unit of every sheet is checked.
    const sheet = { units: [JSON.parse(fs.readFileSync(WORKTREE_UNITS, 'utf8'))].flat().flatMap((r) => r?.units ?? []) };
    for (const source of SOURCES) {
      const { raw, result } = await h.ask(source);
      assert.deepEqual(keys(result), ['count', 'note', 'summary']);
      assert.ok(result.summary !== null, `${source}: the real sheet's page summary is quoted`);
      assert.deepEqual(keys(result.summary), ['delivery', 'rows', 'updated']);
      for (const row of result.summary.rows) assert.deepEqual(keys(row), ['areaMax', 'areaMin', 'cashFrom', 'count', 'label']);
      assert.ok(isDeepStrictEqual(result.summary.rows, page.rows), `${source}: exactly the page's rows`);
      assert.ok(result.count === s.count, `${source}: the page's count`);
      assertNoUnpublished(raw, sheet);
    }
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* PR-B4 (PLAN T13 tests 1-2; DESIGN §4.3): the assistant's WhatsApp tools, listing_details, notes and locale */
/* ------------------------------------------------------------------ */

const R4 = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 3, min); // Riyadh wall clock (UTC+3)
const B4_NOW = R4(2026, 12, 2, 9); // a Wednesday
const B4_SLOT = '2026-12-06T10:00+03:00'; // the Sunday after
const B4_LEAD = 'LEAD-20261201-0000b4aa';
const NEW_TOOLS = ['listing_details', 'viewing_slots', 'book_viewing', 'send_brochure', 'send_location', 'save_needs'];
const WA_ONLY = ['viewing_slots', 'book_viewing', 'send_brochure', 'send_location', 'save_needs'];
/** What a WhatsApp-only tool answers when it does nothing (DESIGN §4.3, the autoMode gate). */
const OFF = { viewing_slots: ['bookable', false], book_viewing: ['reserved', false], send_brochure: ['will_send', false], send_location: ['precision', 'none'], save_needs: ['saved', false] };
const ARGS = {
  listing_details: { listing_id: 'BONA-W003' },
  viewing_slots: { listing_id: 'BONA-W003' },
  book_viewing: { listing_id: 'BONA-W003', slot_id: B4_SLOT, name: 'Sara Example' },
  send_brochure: { listing_id: 'BONA-W003' },
  send_location: { listing_id: 'BONA-W003' },
  save_needs: { name: 'Sara Example', budget: 'around 3 million', district: 'Al Shati', timeline: 'this year' },
};
const MB = 1024 * 1024;

/** Every row of every table: "nothing is written" is this before and after. */
const dump = (db) => Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
  .map(({ name }) => [name, db.db.prepare(`SELECT * FROM "${name}"`).all()]));

/** A HEAD answer: a status and the headers a fake server sends (never the network). */
const head = (status, headers = {}) => new Response(null, { status, headers });

/**
 * The tools as the brain runs them (lib/brain.mjs runOne: source and lead id from code, language AND locale,
 * in-process: `run(name, body, { inProcess: true })`, never the HTTP route), with a fake owner test, a fake (or
 * real) viewing module and a fake fetch for the brochure HEAD.
 */
function b4({ auto = true, viewing = null, fetchImpl = null, extra = {} } = {}) {
  const h = harness();
  const clock = { t: B4_NOW };
  const heads = [];
  const ownerTest = { autoMode: (lead) => Boolean(lead) && (typeof auto === 'function' ? auto(lead) : auto) };
  const fetchFake = fetchImpl ?? (async (url, init) => { heads.push([url, init?.method]); return head(200, { 'content-length': String(3 * MB) }); });
  const tools = createToolHandlers({ ...h.deps, ownerTest, viewing, fetchImpl: async (url, init) => { if (fetchImpl) heads.push([url, init?.method]); return fetchFake(url, init); }, now: () => clock.t, ...extra });
  let seq = 40;
  const lead = (id = B4_LEAD, over = {}) => {
    seq += 1;
    h.db.insertLead({
      lead_id: id, created: B4_NOW - 3_600_000, updated: B4_NOW - 3_600_000, stage: 'new', phone_e164: `9665000000${seq}`, name: 'Sara Example',
      channel: 'whatsapp', inbox_state: 'in', inbox_since: B4_NOW - 3_600_000, inbox_via: 'own_number', dana_introduced: 1, ...over,
    });
    return h.db.getLead(id);
  };
  const body = (args, { leadId = B4_LEAD, source = 'bona-whatsapp', language = 'en' } = {}) => ({
    chat: { chat_id: `wa:${leadId}`, metadata: { ...(source === null ? {} : { source }), lead_id: leadId }, retell_llm_dynamic_variables: { language, locale: language } },
    args,
  });
  const wa = async (name, args = ARGS[name], o = {}) => JSON.parse(await tools.run(name, body(args, o), { inProcess: true }));
  /** The same envelope on the HTTP route's call (index.mjs: `tools.run(name, body)`, no in-process flag). */
  const http = async (name, args = ARGS[name], o = {}) => JSON.parse(await tools.run(name, body(args, o)));
  return { ...h, tools, lead, wa, http, heads, clock };
}

/** A fake viewing module: what lib/viewing.mjs answers, and every call it got. */
function fakeViewing({ slots = { bookable: true, timezone: 'Asia/Riyadh', slots: [{ slot_id: B4_SLOT, label_ar: 'الأحد 6 ديسمبر، 10:00 صباحاً', label_en: 'Sunday 6 December, 10:00 am' }] }, validate = null } = {}) {
  const calls = [];
  return {
    calls,
    async slots(o) { calls.push(['slots', o]); return typeof slots === 'function' ? slots(o) : slots; },
    validate(o) {
      calls.push(['validate', o]);
      return validate ? validate(o) : { ok: true, leadId: o.lead.lead_id, listingId: o.listingId, slotId: o.slotId, startTs: R4(2026, 12, 6, 10), endTs: R4(2026, 12, 6, 11), name: o.name };
    },
    async commitBooking() { throw new Error('the tools never commit (dana-commit does, after preSend)'); },
  };
}

test('TOOL_NAMES has the six new tools, so the HTTP route knows them too; the guarded five refuse without bona-whatsapp, with a bad lead id, and are idempotent', async () => {
  for (const n of NEW_TOOLS) assert.ok(TOOL_NAMES.includes(n), n);
  const h = b4({ viewing: fakeViewing() });
  try {
    h.lead();
    for (const name of WA_ONLY) {
      const [key, off] = OFF[name];
      for (const source of [null, 'bona-web', 'bona-email', 'BONA-WHATSAPP']) {
        const out = await h.wa(name, ARGS[name], { source });
        assert.equal(out[key], off, `${name} from ${source}`);
        assert.match(out.note, source === 'bona-email' ? /not on email/i : /not available here/i, `${name} from ${source}`);
      }
      for (const leadId of ['LEAD-20261201-0000ffff', '../etc', '', 'lead-1']) {
        const out = await h.wa(name, ARGS[name], { leadId });
        assert.equal(out[key], off, `${name} for ${leadId || 'no lead'}`);
        assert.equal(out.reason, 'bad_lead');
      }
      h.lead('LEAD-20261201-0000b4dd', { inbox_state: 'out' });
      const gone = await h.wa(name, ARGS[name], { leadId: 'LEAD-20261201-0000b4dd' });
      assert.deepEqual([gone[key], gone.reason], [off, 'not_in_inbox'], `${name}: a lead out of the inbox (Not a client) gets nothing`);
      h.db.db.prepare('DELETE FROM leads WHERE lead_id = ?').run('LEAD-20261201-0000b4dd');
      const one = await h.wa(name);
      const two = await h.wa(name);
      assert.deepEqual(two, one, `${name} answers the same twice (the brain may retry a turn on the backup model)`);
      assert.notEqual(one[key], off, `${name} works for the auto-mode WhatsApp lead`);
    }
    assert.equal(h.sent.length, 0, 'nothing is sent from inside a tool');
  } finally { h.cleanup(); }
});

test('the autoMode gate (#8): a proof lead with the switches off gets bookable:false, will_send:false, precision none, saved:false, and nothing is written', async () => {
  const viewing = fakeViewing();
  const h = b4({ auto: false, viewing });
  try {
    h.lead(B4_LEAD, { name: null, budget: null });
    const before = dump(h.db);
    assert.deepEqual(await h.wa('viewing_slots'), { bookable: false, reason: 'not_auto', note: 'Not available here: call request_human with kind viewing.' });
    const booked = await h.wa('book_viewing');
    assert.equal(booked.reserved, false);
    assert.equal(booked.reason, 'not_auto');
    assert.deepEqual(await h.wa('send_brochure'), { will_send: false, reason: 'not_auto', note: 'Not available here.' });
    assert.deepEqual(await h.wa('send_location'), { precision: 'none', reason: 'not_auto', note: 'Not available here.' });
    assert.deepEqual(await h.wa('save_needs'), { saved: false, reason: 'not_auto', note: 'Not available here.' });
    assert.deepEqual(dump(h.db), before, 'no row anywhere changed');
    assert.equal(viewing.calls.length, 0, 'the calendar is not even asked');
    assert.equal(h.heads.length, 0, 'no HEAD request');
    // An ownerTest that throws reads as off; none at all (today's index.mjs wiring) too.
    const t = b4({ auto: () => { throw new Error('boom'); }, viewing });
    try { t.lead(); assert.equal((await t.wa('save_needs')).saved, false); } finally { t.cleanup(); }
    const none = createToolHandlers({ ...h.deps });
    const out = JSON.parse(await none.run('send_location', { chat: { chat_id: 'wa:x', metadata: { source: 'bona-whatsapp', lead_id: B4_LEAD } }, args: { listing_id: 'BONA-W003' } }, { inProcess: true }));
    assert.equal(out.precision, 'none');
    assert.equal(out.reason, 'not_auto');
  } finally { h.cleanup(); }
});

test('viewing_slots: outside auto mode, with booking off or without a calendar → {bookable:false, note}; otherwise the slots viewing gives, by id and labels', async () => {
  const off = b4({ viewing: fakeViewing({ slots: { bookable: false } }) });
  try {
    off.lead();
    assert.deepEqual(await off.wa('viewing_slots'), { bookable: false, note: 'Not available here: call request_human with kind viewing.' });
  } finally { off.cleanup(); }
  const busy = b4({ viewing: fakeViewing({ slots: { bookable: false, reason: 'calendar', code: 'timeout' } }) });
  try {
    busy.lead();
    assert.deepEqual(await busy.wa('viewing_slots'), { bookable: false, reason: 'calendar', note: 'Not available here: call request_human with kind viewing.' }, 'a calendar code never reaches the model');
  } finally { busy.cleanup(); }
  const none = b4({ viewing: null });
  try {
    none.lead();
    assert.equal((await none.wa('viewing_slots')).bookable, false, 'no viewing module wired (today): nothing bookable');
  } finally { none.cleanup(); }
  const viewing = fakeViewing();
  const on = b4({ viewing });
  try {
    on.lead();
    const out = await on.wa('viewing_slots');
    assert.equal(out.bookable, true);
    assert.equal(out.timezone, 'Asia/Riyadh');
    assert.deepEqual(out.slots, [{ slot_id: B4_SLOT, label_ar: 'الأحد 6 ديسمبر، 10:00 صباحاً', label_en: 'Sunday 6 December, 10:00 am' }]);
    assert.match(out.note, /3 or 4/);
    assert.equal(viewing.calls[0][1].listingId, 'BONA-W003');
    assert.equal(viewing.calls[0][1].lead.lead_id, B4_LEAD, 'the lead from the chat metadata, never from the model');
  } finally { on.cleanup(); }
});

test('viewing_slots and book_viewing on the real viewing module: booking off → bookable:false; on → book_viewing validates, answers reserved or need_name, and writes nothing', async () => {
  const { createViewing } = await import('../lib/viewing.mjs');
  const { createTeam } = await import('../lib/team.mjs');
  const fb = [];
  const gcal = {
    configured: true,
    async freeBusy(w) { fb.push(w); return { ok: true, busy: [] }; },
    async holidays() { return { ok: true, dates: new Set() }; },
    cachedHolidays: () => new Set(),
    async insert() { throw new Error('the tools never insert an event'); },
    async get() { return { ok: false, code: 'not_found', gone: true }; },
    health: () => ({ configured: true, ok: true, lastErrorCode: null }),
  };
  const h = b4();
  try {
    const team = createTeam(h.db);
    const ownerTest = { autoMode: (l) => Boolean(l) };
    const viewing = createViewing({ db: h.db, cfg: { siteUrl: 'https://bona.example.com', publicApi: 'https://api.example.com' }, team, ownerTest, inventory, gcal, now: () => h.clock.t });
    const tools = createToolHandlers({ ...h.deps, ownerTest, viewing, now: () => h.clock.t });
    const run = async (name, args, leadId = B4_LEAD) => JSON.parse(await tools.run(name, { chat: { chat_id: `wa:${leadId}`, metadata: { source: 'bona-whatsapp', lead_id: leadId } }, args }, { inProcess: true }));
    h.lead();
    h.lead('LEAD-20261201-0000b4bb', { name: '🙂' });
    // calendar_booking is '0' by default.
    assert.equal((await run('viewing_slots', { listing_id: 'BONA-W003' })).bookable, false);
    assert.equal((await run('book_viewing', { listing_id: 'BONA-W003', slot_id: B4_SLOT })).reserved, false);
    team.setSetting('calendar_booking', '1');
    const slots = await run('viewing_slots', { listing_id: 'BONA-W003' });
    assert.equal(slots.bookable, true);
    assert.ok(slots.slots.some((s) => s.slot_id === B4_SLOT), 'the Sunday 10:00 slot is offered');
    const before = dump(h.db);
    const ok = await run('book_viewing', { listing_id: 'BONA-W003', slot_id: B4_SLOT });
    assert.equal(ok.reserved, true);
    assert.match(ok.note, /never state it as confirmed — the system sends the confirmation/);
    const nameless = await run('book_viewing', { listing_id: 'BONA-W003', slot_id: B4_SLOT }, 'LEAD-20261201-0000b4bb');
    assert.deepEqual([nameless.reserved, nameless.need_name], [false, true], 'an emoji is no name: ask for it');
    const named = await run('book_viewing', { listing_id: 'BONA-W003', slot_id: B4_SLOT, name: 'Nora Example' }, 'LEAD-20261201-0000b4bb');
    assert.equal(named.reserved, true, 'the name in the call is enough');
    for (const [args, reason] of [[{ listing_id: 'BONA-W003', slot_id: '2026-12-06T11:00+03:00' }, 'slot'], [{ listing_id: 'BONA-W003', slot_id: '2026-12-02T14:00+03:00' }, null], [{ listing_id: 'BONA-W008', slot_id: B4_SLOT }, 'listing'], [{ listing_id: 'BONA-W003', slot_id: 'tomorrow' }, 'slot']]) {
      const out = await run('book_viewing', args);
      assert.equal(out.reserved, false, JSON.stringify(args));
      if (reason) assert.equal(out.reason, reason, JSON.stringify(args));
      assert.doesNotMatch(out.note, /booked|confirmed/i, 'never says booked');
    }
    assert.deepEqual(dump(h.db), before, 'book_viewing validates and writes nothing: no booking row, no task, no lead change');
    assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM viewing_bookings').get().n, 0);
  } finally { h.cleanup(); }
});

test('send_brochure: BLOCKED_BROCHURES (W011, W018, W024) and a home without one → false; Dana\'s first message → the link; otherwise the PDF (3 MB)', async () => {
  assert.deepEqual([...BLOCKED_BROCHURES], ['BONA-W011', 'BONA-W018', 'BONA-W024']);
  const h = b4();
  try {
    h.lead();
    h.lead('LEAD-20261201-0000b4cc', { dana_introduced: 0 });
    for (const id of BLOCKED_BROCHURES) {
      assert.ok(inventory.find(id)?.brochureUrl, `${id} has a brochure in listings.json (held back, not missing)`);
      assert.deepEqual(await h.wa('send_brochure', { listing_id: id }), { will_send: false, reason: 'held', note: 'There is no brochure to send for this home: offer its page.' });
    }
    const without = inventory.all().find((l) => !l.brochureUrl);
    assert.deepEqual(await h.wa('send_brochure', { listing_id: without.id }), { will_send: false, reason: 'no_brochure', note: 'There is no brochure to send for this home: offer its page.' });
    assert.equal((await h.wa('send_brochure', { listing_id: 'BONA-W999' })).will_send, false);
    assert.equal(h.heads.length, 0, 'no HEAD for a held, missing or unknown brochure');
    const first = await h.wa('send_brochure', { listing_id: 'BONA-W003' }, { leadId: 'LEAD-20261201-0000b4cc' });
    assert.deepEqual(first, { will_send: 'link', reason: 'first_message', url: inventory.find('BONA-W003').brochureUrl, note: 'Give this link on its own line; no PDF is sent.' });
    assert.equal(h.heads.length, 0, 'the first message never carries a PDF: no HEAD either');
    const pdf = await h.wa('send_brochure', { listing_id: 'BONA-W003' });
    assert.deepEqual(pdf, { will_send: 'pdf', reason: 'ok', note: 'The PDF goes right after your message: say one short line that you are sending it.' });
    assert.deepEqual(h.heads, [[inventory.find('BONA-W003').brochureUrl, 'HEAD']]);
    // A search row says whether a home has a brochure; a held one says no.
    const rows = JSON.parse(await h.tools.run('search_properties', { chat: { chat_id: 'c', metadata: { source: 'bona-whatsapp' } }, args: { query: 'Sadana' } }, { inProcess: true })).results;
    const held = rows.find((r) => r.id === 'BONA-W011');
    if (held) assert.equal(held.has_brochure, false);
  } finally { h.cleanup(); }
});

test('send_brochure size (#18): a HEAD on brochureUrl, 5 s; 22 MB, no Content-Length, a 404 or a timeout → the link; cached 12 h per URL', async () => {
  assert.equal(BROCHURE_HEAD_MS, 5_000);
  assert.equal(BROCHURE_CACHE_MS, 12 * 3_600_000);
  assert.equal(BROCHURE_MAX_BYTES, 8 * MB);
  const cases = [
    ['22 MB', async () => head(200, { 'content-length': String(22 * MB) }), 'too_big'],
    ['no Content-Length', async () => head(200), 'size_unknown'],
    ['a 404', async () => head(404, { 'content-length': '1000' }), 'size_unknown'],
    ['a network error', async () => { throw new TypeError('fetch failed'); }, 'size_unknown'],
    ['a timeout', () => new Promise(() => {}), 'size_unknown'],
  ];
  for (const [what, fetchImpl, reason] of cases) {
    const h = b4({ fetchImpl, extra: { brochureHeadMs: 30 } });
    try {
      h.lead();
      const out = await h.wa('send_brochure');
      assert.equal(out.will_send, 'link', what);
      assert.equal(out.reason, reason, what);
      assert.equal(out.url, inventory.find('BONA-W003').brochureUrl, what);
    } finally { h.cleanup(); }
  }
  // The timeout really is the deadline: a HEAD that never answers is abandoned on time, with its signal aborted.
  let signal = null;
  const slow = b4({ fetchImpl: (url, init) => { signal = init.signal; return new Promise(() => {}); }, extra: { brochureHeadMs: 30 } });
  try {
    slow.lead();
    const t0 = Date.now();
    await slow.wa('send_brochure');
    assert.ok(Date.now() - t0 < 2_000);
    assert.equal(signal?.aborted, true);
  } finally { slow.cleanup(); }
  // The cache: a second call within 12 h makes no HEAD, whatever the first answered; after 12 h it asks again.
  const h = b4();
  try {
    h.lead();
    assert.equal((await h.wa('send_brochure')).will_send, 'pdf');
    h.clock.t += 12 * 3_600_000 - 1;
    assert.equal((await h.wa('send_brochure')).will_send, 'pdf');
    assert.equal(h.heads.length, 1, 'cached');
    h.clock.t += 2;
    await h.wa('send_brochure');
    assert.equal(h.heads.length, 2, 'asked again after 12 h');
  } finally { h.cleanup(); }
  // A failed size is cached for 10 minutes only (no HEAD storm, and one timeout does not cost 12 h of links).
  assert.equal(BROCHURE_FAIL_CACHE_MS, 10 * 60_000);
  const miss = b4({ fetchImpl: async () => head(404) });
  try {
    miss.lead();
    await miss.wa('send_brochure');
    miss.clock.t += 10 * 60_000 - 1;
    await miss.wa('send_brochure');
    assert.equal(miss.heads.length, 1, 'cached within 10 min');
    miss.clock.t += 2;
    await miss.wa('send_brochure');
    assert.equal(miss.heads.length, 2, 'asked again after 10 min');
  } finally { miss.cleanup(); }
});

test('send_location: an exact pin → exact (the commit adds the map link); a district centroid → described in words; no pin → none', async () => {
  const h = b4();
  try {
    h.lead();
    const exact = inventory.all().find((l) => l.mapPrecision === 'exact' && l.map);
    const district = inventory.all().find((l) => l.mapPrecision === 'district');
    const none = inventory.all().find((l) => !l.mapPrecision);
    const e = await h.wa('send_location', { listing_id: exact.id });
    assert.equal(e.precision, 'exact');
    assert.doesNotMatch(JSON.stringify(e), /maps\.google|\d{2}\.\d{3}/, 'no link or coordinates for the model to write');
    const d = await h.wa('send_location', { listing_id: district.id });
    assert.equal(d.precision, 'district');
    assert.equal(d.district, district.location.district.en);
    assert.equal(d.city, district.location.city.en);
    assert.match(d.note, /in words; never give a pin/);
    const ar = await h.wa('send_location', { listing_id: district.id }, { language: 'ar' });
    assert.equal(ar.district, district.location.district.ar, 'in the conversation language');
    assert.equal((await h.wa('send_location', { listing_id: none.id })).precision, 'none');
    assert.equal((await h.wa('send_location', { listing_id: 'BONA-W999' })).precision, 'none');
  } finally { h.cleanup(); }
});

test('save_needs (#5): lead-tasks saveNeeds with name, interest, budget, district, property_type, timeline, listing_id; no hand-over, nothing sent', async () => {
  const calls = [];
  const all = { name: 'Sara Example', interest: 'a home to buy', budget: 'around 3 million', district: 'Al Shati', property_type: 'villa', timeline: 'this year', listing_id: 'BONA-W003' };
  const spy = b4({ extra: { saveNeeds: (db, o) => { calls.push(o); return realSaveNeeds(db, o); } } });
  try {
    spy.lead();
    const out = await spy.wa('save_needs', { ...all, phone: '0500000099', area: 'ignored', kind: 'x' });
    assert.equal(out.saved, true);
    assert.deepEqual(calls, [{ leadId: B4_LEAD, needs: all, now: B4_NOW }], 'exactly the seven keys, nothing the schema does not name');
  } finally { spy.cleanup(); }
  let handed = 0;
  const h = b4({ extra: { notifyHandoff: async () => { handed += 1; } } });
  try {
    h.lead(B4_LEAD, { name: null, budget: null, district: null, timeline: null, interest: null, listing_id: null });
    assert.equal((await h.wa('save_needs', all)).saved, true);
    const lead = h.db.getLead(B4_LEAD);
    assert.equal(lead.name, 'Sara Example');
    assert.equal(lead.budget, 'around 3 million');
    assert.equal(lead.district, 'Al Shati');
    assert.equal(lead.timeline, 'this year');
    assert.equal(lead.listing_id, 'BONA-W003');
    assert.equal(lead.interest, 'a home to buy · villa');
    assert.equal(lead.needs_human, 0, 'no hand-over');
    assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM lead_tasks').get().n, 0, 'no task');
    assert.equal(handed, 0);
    assert.equal(h.sent.length, 0);
    assert.equal((await h.wa('save_needs', all)).saved, true, 'idempotent: the same needs again is still saved');
    assert.equal(h.db.getLead(B4_LEAD).interest, 'a home to buy · villa', 'merged once, not twice');
    assert.deepEqual(await h.wa('save_needs', { name: '', budget: '  ' }), { saved: false, reason: 'nothing_to_save', note: 'Nothing to save: pass only what the client said.' });
  } finally { h.cleanup(); }
});

test('request_human: the kind enum; an unknown kind is other; the note and the log are as before', async () => {
  assert.deepEqual([...HANDOVER_KINDS], ['person', 'offer', 'complaint', 'contract', 'selling', 'viewing', 'other', 'stop', 'privacy', 'deletion']);
  const logs = [];
  const h = harness();
  const tools = createToolHandlers({ ...h.deps, log: (o) => logs.push(o) });
  try {
    const ask = async (kind) => JSON.parse(await tools.run('request_human', { chat: { chat_id: 'wa:x', metadata: { source: 'bona-whatsapp', lead_id: B4_LEAD } }, args: { reason: 'r', kind } }));
    for (const k of HANDOVER_KINDS) assert.equal((await ask(k)).kind, k);
    assert.equal((await ask('refund')).kind, 'other');
    assert.equal((await ask(undefined)).kind, 'other');
    assert.match((await ask('privacy')).note, /team will reply shortly/);
    assert.deepEqual(logs.at(-1), { evt: 'tool.request_human', leadId: B4_LEAD });
  } finally { h.cleanup(); }
});

test('listing_details: a published listing in the conversation language from listings.json; unknown → {found:false}; any source, read-only (in TOOL_NAMES: the HTTP route serves it)', async () => {
  const h = b4();
  let cards = 0;
  h.store.addCard = () => { cards += 1; };
  try {
    const en = await h.wa('listing_details', { listing_id: 'BONA-W003' });
    const w003 = inventory.find('BONA-W003');
    assert.equal(en.found, true);
    assert.equal(en.title, w003.title.en);
    assert.equal(en.description, w003.description.en);
    assert.equal(en.url, inventory.card(w003).url.en);
    const ar = JSON.parse(await h.tools.run('listing_details', { chat: { chat_id: 'c', retell_llm_dynamic_variables: { language: 'ar' } }, args: { listing_id: 'bona-w003' } }));
    assert.equal(ar.title, w003.title.ar, 'dyn.language alone gives Arabic (the brain sets both keys)');
    assert.equal(ar.url, inventory.card(w003).url.ar);
    for (const id of ['BONA-W999', '', 'Al Shati villa', null]) {
      assert.deepEqual(JSON.parse(await h.tools.run('listing_details', { call: { call_id: 'v1' }, args: { listing_id: id } })), { found: false }, String(id));
    }
    // Read-only: no card on a screen, no lead, nothing sent, for every source.
    for (const source of [null, 'bona-web', 'bona-email', 'bona-whatsapp']) {
      assert.equal((await h.wa('listing_details', { listing_id: 'BONA-W003' }, { source })).found, true, String(source));
    }
    assert.equal(cards, 0, 'no card is put on a screen');
    assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM leads').get().n, 0, 'no lead');
    assert.equal(h.sent.length, 0);
    assert.ok(TOOL_NAMES.includes('listing_details'));
  } finally { h.cleanup(); }
});

test('the WhatsApp tool note does not offer the number; the concierge note still does (contact-numbers.test.mjs)', async () => {
  const site = JSON.parse(fs.readFileSync(new URL('../../../src/data/site.json', import.meta.url), 'utf8'));
  const h = harness();
  try {
    const wa = JSON.parse(await h.tools.run('search_properties', { chat: { chat_id: 'wa:x', metadata: { source: 'bona-whatsapp', lead_id: B4_LEAD } }, args: { district: 'Atlantis' } }));
    assert.equal(wa.count, 0);
    assert.doesNotMatch(wa.note, /\+966|WhatsApp \+|\d{3} \d{4}/, wa.note);
    assert.match(wa.note, /request_human/);
    for (const metadata of [{}, { source: 'bona-web' }, { source: 'bona-email' }]) {
      const web = JSON.parse(await h.tools.run('search_properties', { chat: { chat_id: 'web', metadata }, args: { district: 'Atlantis' } }));
      assert.ok(web.note.includes(`WhatsApp ${site.whatsapp.display}`), web.note);
    }
  } finally { h.cleanup(); }
});

test('conversationLocale reads dyn.language too (the brain and the WhatsApp agent set it; dyn.locale still wins)', () => {
  assert.equal(conversationLocale({ chat: { retell_llm_dynamic_variables: { language: 'ar' } } }), 'ar');
  assert.equal(conversationLocale({ chat: { retell_llm_dynamic_variables: { language: 'en' } } }), 'en');
  assert.equal(conversationLocale({ chat: { retell_llm_dynamic_variables: { locale: 'en', language: 'ar' } } }), 'en');
  assert.equal(conversationLocale({ chat: { retell_llm_dynamic_variables: { language: 'fr' } } }), 'en');
  assert.equal(conversationLocale({ chat: { metadata: { locale: 'ar' } } }), 'ar');
});

test('create_lead passes `created` to the owner notes (why concierge); with the ledger a merge sends no note; without notes, today\'s path', async () => {
  const events = [];
  const h = harness();
  try {
    const notes = { leadEvent: async (lead, o) => { events.push([lead.lead_id, o]); } };
    const tools = createToolHandlers({ ...h.deps, notes });
    const first = JSON.parse(await tools.run('create_lead', { chat: { chat_id: 'n1' }, args: { phone: '0500000061', name: 'Sara Example' } }));
    const merged = JSON.parse(await tools.run('create_lead', { chat: { chat_id: 'n2' }, args: { phone: '0500000061', name: 'Sara Example' } }));
    assert.equal(merged.id, first.id, 'the same person: a merge');
    assert.deepEqual(events.map(([id, o]) => [id, o]), [[first.id, { why: 'concierge', created: true }], [first.id, { why: 'concierge', created: false }]]);
    assert.equal(h.sent.length, 0, 'the notes send it, not sendWhatsApp');
  } finally { h.cleanup(); }
  // The real ledger (PR-B2, ledger:true, as PR-INT wires it): the created lead's note is queued, a merge's is not.
  const { createOwnerNotes } = await import('../lib/owner-notes.mjs');
  const { createTeam } = await import('../lib/team.mjs');
  const l = harness();
  try {
    const team = createTeam(l.db);
    const notes = createOwnerNotes({ db: l.db, siteUrl: 'https://bona.azoz.uk', sendNote: async () => ({ ok: true }), team, ownerTest: { autoMode: () => false }, ledger: true, now: () => B4_NOW });
    const tools = createToolHandlers({ ...l.deps, notes });
    const first = JSON.parse(await tools.run('create_lead', { chat: { chat_id: 'm1' }, args: { phone: '0500000062', name: 'Sara Example' } }));
    await tools.run('create_lead', { chat: { chat_id: 'm2' }, args: { phone: '0500000062', name: 'Sara Example' } });
    const rows = l.db.db.prepare('SELECT kind, lead_id, dedupe_key FROM owner_notes').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ kind: 'new_client', lead_id: first.id, dedupe_key: `new:${first.id}` }], 'one note: the created lead; the merge queued nothing');
    notes.stop?.();
  } finally { l.cleanup(); }
  // No notes handed in (index.mjs today): sendWhatsApp exactly as before, merges told too.
  const t = harness();
  try {
    await t.tools.run('create_lead', { chat: { chat_id: 'o1' }, args: { phone: '0500000063', name: 'Sara Example' } });
    await t.tools.run('create_lead', { chat: { chat_id: 'o2' }, args: { phone: '0500000063', name: 'Sara Example' } });
    assert.equal(t.sent.length, 2, "today's concierge path, byte for byte (PR-F2b)");
  } finally { t.cleanup(); }
});

/* ---------------- PR-B4 r2 (the r1 reviews) ---------------- */

test('the five WhatsApp tools run only in-process (the brain), never from a forged source on the HTTP /v1/tools route; listing_details and search_properties stay open', async () => {
  const h = b4({ viewing: fakeViewing() });
  try {
    h.lead();
    const before = dump(h.db);
    for (const name of WA_ONLY_TOOLS) {
      const [key, off] = OFF[name];
      const out = await h.http(name);
      assert.equal(out[key], off, name);
      assert.equal(out.reason, 'not_in_process', name);
    }
    assert.deepEqual(dump(h.db), before, 'the HTTP calls wrote nothing');
    assert.equal(h.heads.length, 0);
    for (const name of WA_ONLY_TOOLS) {
      const [key, off] = OFF[name];
      assert.notEqual((await h.wa(name))[key], off, `${name} works in-process`);
    }
    assert.equal((await h.http('listing_details')).found, true);
    assert.equal((await h.http('search_properties', { query: 'villa' })).count > 0, true);
  } finally { h.cleanup(); }
});

test("search_properties keeps main's row shape for every caller but the brain route (in-process): the concierge, the legacy WhatsApp agent, the phone line", async () => {
  const LEGACY_KEYS = ['id', 'slug', 'title_en', 'title_ar', 'type', 'category', 'district_en', 'district_ar', 'city', 'price_en', 'price_ar', 'beds', 'baths', 'area_sqm', 'url_en', 'url_ar'];
  const h = b4();
  try {
    h.lead();
    const args = { district: 'Jeddah' };
    for (const metadata of [undefined, { source: 'bona-web' }, { source: 'bona-whatsapp', lead_id: B4_LEAD }, { source: 'bona-email', lead_id: B4_LEAD }]) {
      const raw = await h.tools.run('search_properties', { chat: { chat_id: 'c', ...(metadata ? { metadata } : {}) }, args });
      const out = JSON.parse(raw);
      assert.ok(out.results.length > 0);
      for (const row of out.results) {
        assert.deepEqual(Object.keys(row), LEGACY_KEYS, JSON.stringify(metadata));
        assert.equal(JSON.stringify(row), JSON.stringify(inventory.row(inventory.find(row.id))), 'byte for byte the row main gave');
      }
      assert.doesNotMatch(raw, /"(pin|lat|lng|has_brochure)"/, 'no pin, coordinates or brochure flag for a legacy caller');
    }
    const brain = await h.wa('search_properties', args);
    for (const row of brain.results) {
      assert.deepEqual(Object.keys(row).slice(0, LEGACY_KEYS.length), LEGACY_KEYS);
      assert.ok('pin' in row && 'has_brochure' in row, 'the brain route gets the new fields');
    }
  } finally { h.cleanup(); }
});

test('save_needs answers what was saved and what was refused: a name "A" or "🙂" is not saved, and saved:true only when something is stored', async () => {
  const h = b4();
  try {
    h.lead(B4_LEAD, { name: null, budget: null, listing_id: null });
    for (const name of ['A', '🙂', '  b ']) {
      const out = await h.wa('save_needs', { name });
      assert.deepEqual(out, { saved: false, reason: 'rejected', saved_fields: [], rejected: ['name'], note: 'Nothing was saved: name was not accepted (a name needs at least two letters). Do not say you noted it; ask again if it matters.' }, name);
      assert.equal(h.db.getLead(B4_LEAD).name, null);
    }
    const mixed = await h.wa('save_needs', { name: '🙂', budget: 'around 3 million', listing_id: 'not an id' });
    assert.equal(mixed.saved, true);
    assert.deepEqual(mixed.saved_fields, ['budget']);
    assert.deepEqual(mixed.rejected, ['name', 'listing_id']);
    assert.match(mixed.note, /not saved: name, listing_id/);
    assert.equal(h.db.getLead(B4_LEAD).budget, 'around 3 million');
    // The same budget again: already stored, so still saved (idempotent), nothing refused.
    assert.deepEqual((await h.wa('save_needs', { budget: 'around 3 million' })).saved_fields, ['budget']);
  } finally { h.cleanup(); }
});

test('the brochure HEAD goes only to Bona\'s site over https, with no redirect; another host or http is no brochure at all', async () => {
  const w003 = inventory.find('BONA-W003');
  const listing = (id, brochureUrl) => ({ ...w003, id, slug: `example-${id.toLowerCase()}`, brochureUrl });
  const list = [
    listing('BONA-W961', 'https://evil.example/listings/x/brochure.pdf'),
    listing('BONA-W962', 'http://bona-real-estate.com/listings/x/brochure.pdf'),
    listing('BONA-W963', 'https://bona-real-estate.com.evil.example/listings/x/brochure.pdf'),
    listing('BONA-W964', 'https://user@bona-real-estate.com/listings/x/brochure.pdf'),
    listing('BONA-W965', 'https://www.bona-real-estate.com/listings/x/brochure.pdf'),
    listing('BONA-W966', 'https://bona.azoz.uk/listings/x/brochure.pdf'), // the configured site (cfg.siteUrl)
  ];
  const fake = { ...inventory, exact: (ref) => list.find((l) => l.id === String(ref).toUpperCase()) ?? null, all: () => list };
  const inits = [];
  const h = b4({ fetchImpl: async (url, init) => { inits.push(init); return head(200, { 'content-length': String(MB) }); }, extra: { inventory: fake } });
  try {
    h.lead();
    for (const id of ['BONA-W961', 'BONA-W962', 'BONA-W963', 'BONA-W964']) {
      assert.deepEqual(await h.wa('send_brochure', { listing_id: id }), { will_send: false, reason: 'not_on_site', note: 'There is no brochure to send for this home: offer its page.' }, id);
    }
    assert.equal(h.heads.length, 0, 'no request to another host');
    assert.equal((await h.wa('send_brochure', { listing_id: 'BONA-W965' })).will_send, 'pdf');
    assert.equal((await h.wa('send_brochure', { listing_id: 'BONA-W966' })).will_send, 'pdf');
    assert.equal(h.heads.length, 2);
    assert.ok(inits.every((i) => i.method === 'HEAD' && i.redirect === 'error'), 'a redirect is a failure, never followed');
  } finally { h.cleanup(); }
});

/* ---------------- PR-B4 r5 (the r4 reviews) ---------------- */

test('viewing_slots says ask_name when the CRM name is missing or not plausible (lead-tasks plausibleName, as book_viewing validates it; Codex r4 P1)', async () => {
  const h = b4({ viewing: fakeViewing() });
  try {
    const cases = [['LEAD-20261201-0000b501', 'Sara Example', false], ['LEAD-20261201-0000b502', 'A', true], ['LEAD-20261201-0000b503', '🙂', true],
      ['LEAD-20261201-0000b504', null, true], ['LEAD-20261201-0000b505', '0500000099', true], ['LEAD-20261201-0000b506', 'نورة', false]];
    for (const [id, name, ask] of cases) {
      h.lead(id, { name });
      const out = await h.wa('viewing_slots', ARGS.viewing_slots, { leadId: id });
      assert.equal(out.bookable, true);
      assert.equal(out.ask_name, ask, String(name));
      if (ask) assert.match(out.note, /ask for their name in that same message/, String(name));
      else assert.doesNotMatch(out.note, /ask for their name/, String(name));
    }
  } finally { h.cleanup(); }
});
