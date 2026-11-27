import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect, isDeepStrictEqual } from 'node:util';
import { createToolHandlers, tokenMatches, extractToken, conversationId, conversationLocale, toolArgs, leadKey, HANDOVER_TOOL, TOOL_NAMES, FULL_UNIT_ROW_SOURCES, UNITS_NOTE, UNITS_NOT_PUBLISHED_NOTE } from '../lib/tools.mjs';
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
const SITE = 'https://site.example.com';
const W014_PAGE = `${SITE}/properties/darco-prime-waterfront-fixture/`;
const UNITS_NOW = Date.parse('2026-11-27T09:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
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
  let clock = UNITS_NOW;
  const site = fakeSite(answer ?? ((url) => (url === W014_PAGE ? listingPage(page) : new Response('not found', { status: 404 }))));
  const tools = createToolHandlers({
    ...h.deps, siteUrl: SITE, inventory: w014Inventory(status), units: withUnits ? createUnits({ file }) : null, now: () => clock,
    publishedUnits: createPublishedUnits({ siteUrl: SITE, fetch: site.fetch, now: () => clock, ...(timeoutMs ? { timeoutMs } : {}) }),
    ...extra,
  });
  const ask = async (source, args = UNIT_ARGS) => {
    const raw = await tools.run('search_units', { chat: { chat_id: `units-${source}`, metadata: source === undefined ? {} : { source } }, args });
    return { raw, result: JSON.parse(raw) };
  };
  return {
    ...h, tools, ask, file, site, advance: (ms) => { clock += ms; },
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
    // Every call above, every source: one GET of the live W014 page (the 15-minute cache).
    assert.deepEqual(h.site.calls, [W014_PAGE]);
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

test('search_units: the site down (HTTP 500, a timeout) → the last good page for at most 6 hours, then the "not published" note', async () => {
  for (const [name, down] of [
    ['HTTP 500', () => new Response('oops', { status: 500 })],
    ['a timeout', () => new Promise(() => {})],
    ['a network error', () => new TypeError('fetch failed')],
  ]) {
    let up = true;
    const h = unitsHarness({ answer: () => (up ? listingPage(PAGE_SUMMARY) : down()), timeoutMs: 20 });
    try {
      assert.deepEqual((await h.ask('bona-whatsapp')).result.summary, PUBLISHED_CUT, `${name}: up`);
      up = false;
      h.advance(6 * HOUR - MINUTE);
      for (const source of SOURCES) {
        const { raw, result } = await h.ask(source);
        assert.deepEqual(result.summary, PUBLISHED_CUT, `${name}, ${source}: the last good page, within 6 hours`);
        assertNoUnpublished(raw);
      }
      h.advance(15 * MINUTE);
      for (const source of SOURCES) notPublished((await h.ask(source)).result, `${name}, ${source}: past 6 hours`);
      assert.equal(h.site.calls.length, 3, `${name}: one GET per 15 minutes, failures included`);
    } finally { h.cleanup(); }
  }
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
  [OLDER_PAGE_SUMMARY.cashFrom].forEach((n, i) => assert.ok(!amounts.has(n), `older page figure #${i} is on the real sheet`));
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
