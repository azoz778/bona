/**
 * PR-B4 (PLAN T13 test 5; DESIGN §4.3 "commit after preSend", §8.3): what the assistant's answer becomes
 * once preSend has passed. It reads the tool calls off the SAME turn (the brain's `toolCalls`, or the
 * Retell-shaped messages), commits a booking through viewing.commitBooking, adds the brochure document and
 * the exact-pin map link, and replaces a booking claim that no commit backs. A fake calendar and a fake
 * brain turn only: nothing here reaches Google, OpenAI or WhatsApp. Names and numbers are examples.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDanaCommit, turnToolCalls, BOOKING_FAILED_LINE, DEFAULT_MAX_LINKS } from '../lib/dana-commit.mjs';
import { brainReply } from '../lib/brain/fake.mjs';
import { retellMessages } from '../lib/brain.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createViewing } from '../lib/viewing.mjs';
import { createOwnerNotes } from '../lib/owner-notes.mjs';
import { createToolHandlers } from '../lib/tools.mjs';
import { createStore } from '../lib/store.mjs';
import { createPublishedUnits } from '../lib/published-units.mjs';

const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.example.com' });
const R = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 3, min); // Riyadh wall clock
const NOW = R(2026, 12, 2, 9); // a Wednesday
const SLOT = '2026-12-06T10:00+03:00'; // the Sunday after
const LEAD = { lead_id: 'LEAD-20261201-0000dc01', name: 'Sara Example' };
const EXACT = inventory.all().find((l) => l.mapPrecision === 'exact' && l.map && l.brochureUrl && l.id === 'BONA-W003');
const DISTRICT = inventory.all().find((l) => l.mapPrecision === 'district');
const RESERVED = { reserved: true, slot_id: SLOT, listing_id: 'BONA-W003', note: 'x' };
const CONFIRMATION = 'Your viewing is booked ✅\nSunday 6 December, 10:00 am (one hour)';

/** A fake viewing module: commitBooking answers what it is told, and records every call. */
function fakeViewing(answer = { ok: true, bookingId: 'bk-1', eventId: 'ev1', listingId: 'BONA-W003', slotId: SLOT, startTs: R(2026, 12, 6, 10), endTs: R(2026, 12, 6, 11), pin: 'exact', text: CONFIRMATION }) {
  const calls = [];
  const told = [];
  return {
    calls, told,
    async commitBooking(o) { calls.push(o); return typeof answer === 'function' ? answer(o) : answer; },
    markTold(id) { told.push(id); return true; },
  };
}
function fakeNotes() {
  const booked = [];
  return { booked, booking(id, o) { booked.push([id, o]); return { queued: true }; } };
}
const commitWith = (o = {}) => createDanaCommit({ inventory, log: () => {}, ...o });
const book = (args = { slot_id: SLOT, listing_id: 'BONA-W003', name: 'Sara Example' }, result = RESERVED) => ({ name: 'book_viewing', args, result });

test('no tool call, no claim: the answer is its text, one text bubble (the PR-F2b stub shape), and nothing is committed', async () => {
  const viewing = fakeViewing();
  const c = commitWith({ viewing });
  for (const turn of [brainReply('Hello'), { messages: [] }, {}, null]) {
    assert.deepEqual(await c.afterPreSend({ lead: LEAD, turn, text: 'Hello', language: 'en', coversTs: NOW }), { bubbles: [{ kind: 'text', text: 'Hello' }] });
  }
  const searched = brainReply('Here is one.', { tools: [{ name: 'search_properties', args: { query: 'villa' }, result: { count: 0, results: [] } }] });
  assert.deepEqual(await c.afterPreSend({ lead: LEAD, turn: searched, text: 'Here is one.', language: 'en' }), { bubbles: [{ kind: 'text', text: 'Here is one.' }] });
  assert.equal(viewing.calls.length, 0);
});

test('turnToolCalls reads the brain turn\'s toolCalls, else the Retell-shaped messages (results parsed, once or twice encoded)', () => {
  const calls = [{ id: 'a', name: 'book_viewing', args: { slot_id: SLOT }, result: JSON.stringify(RESERVED), ok: true }];
  assert.deepEqual(turnToolCalls({ toolCalls: calls }), [{ name: 'book_viewing', args: { slot_id: SLOT }, result: RESERVED, ok: true }]);
  const messages = retellMessages(calls, 'x');
  assert.deepEqual(turnToolCalls({ messages }), [{ name: 'book_viewing', args: { slot_id: SLOT }, result: RESERVED, ok: true }]);
  const twice = [{ role: 'tool_call_invocation', tool_call_id: 'b', name: 'send_brochure', arguments: '{"listing_id":"BONA-W003"}' },
    { role: 'tool_call_result', tool_call_id: 'b', content: JSON.stringify(JSON.stringify({ will_send: 'pdf' })) }];
  assert.deepEqual(turnToolCalls({ messages: twice }), [{ name: 'send_brochure', args: { listing_id: 'BONA-W003' }, result: { will_send: 'pdf' }, ok: true }]);
  const noResult = [{ role: 'tool_call_invocation', tool_call_id: 'c', name: 'book_viewing', arguments: 'not json' }];
  assert.deepEqual(turnToolCalls({ messages: noResult }), [{ name: 'book_viewing', args: {}, result: null, ok: false }]);
  assert.deepEqual(turnToolCalls(null), []);
});

test('the LAST book_viewing invocation is committed through viewing.commitBooking; ok → the code-built confirmation REPLACES the model text', async () => {
  const viewing = fakeViewing();
  const c = commitWith({ viewing });
  const turn = brainReply('Booking it for you now.', { tools: [book({ slot_id: '2026-12-07T12:00+03:00', listing_id: 'BONA-W003' }), book()] });
  const out = await c.afterPreSend({ lead: LEAD, turn, text: 'Booking it for you now.', language: 'en', coversTs: NOW });
  assert.equal(viewing.calls.length, 1, 'one commit per turn');
  assert.deepEqual(viewing.calls[0], { lead: LEAD, listingId: 'BONA-W003', slotId: SLOT, name: 'Sara Example', language: 'en' });
  assert.deepEqual(out.bubbles, [{ kind: 'text', text: CONFIRMATION, bookingId: 'bk-1' }]);
  assert.deepEqual(out.booking, { bookingId: 'bk-1', listingId: 'BONA-W003', startTs: R(2026, 12, 6, 10) });
  assert.equal('handover' in out, false);
  // The same off the Retell-shaped messages (no toolCalls on the turn).
  const legacy = { messages: retellMessages([{ id: 'r1', ...book(), result: JSON.stringify(RESERVED) }], 'Booking it.') };
  const viewing2 = fakeViewing();
  const out2 = await commitWith({ viewing: viewing2 }).afterPreSend({ lead: LEAD, turn: legacy, text: 'Booking it.', language: 'ar' });
  assert.equal(viewing2.calls[0].language, 'ar');
  assert.equal(out2.bubbles[0].text, CONFIRMATION);
});

test('a book_viewing the tool did not reserve (reserved false, an error, no result) is never committed', async () => {
  for (const result of [{ reserved: false, need_name: true }, { error: 'tool_failed' }, null, 'not json']) {
    const viewing = fakeViewing();
    const out = await commitWith({ viewing }).afterPreSend({ lead: LEAD, turn: brainReply('What is your name?', { tools: [book(undefined, result)] }), text: 'What is your name?', language: 'en' });
    assert.equal(viewing.calls.length, 0, JSON.stringify(result));
    assert.deepEqual(out, { bubbles: [{ kind: 'text', text: 'What is your name?' }] });
  }
});

test('a failed commit → the "team will confirm" line instead of the model text, and a booking_failed hand-over', async () => {
  for (const [answer, lang] of [[{ ok: false, reason: 'busy' }, 'en'], [{ ok: false, reason: 'calendar', code: 'timeout' }, 'ar'], [async () => { throw new Error('boom'); }, 'en']]) {
    const viewing = fakeViewing(answer);
    const out = await commitWith({ viewing }).afterPreSend({ lead: LEAD, turn: brainReply('Booking it now.', { tools: [book()] }), text: 'Booking it now.', language: lang });
    assert.deepEqual(out.bubbles, [{ kind: 'text', text: BOOKING_FAILED_LINE[lang] }]);
    assert.deepEqual(out.handover, { kind: 'booking_failed' });
    assert.equal('booking' in out, false);
  }
  assert.match(BOOKING_FAILED_LINE.en, /team will confirm/);
  assert.match(BOOKING_FAILED_LINE.ar, /فريق بونا/);
  // No viewing module wired: the same, never a confirmation.
  const none = await commitWith().afterPreSend({ lead: LEAD, turn: brainReply('Booking.', { tools: [book()] }), text: 'Booking.', language: 'en' });
  assert.deepEqual(none.handover, { kind: 'booking_failed' });
});

test('a brochure the tool said to send as a PDF → a document bubble after the text; a link or a held one → none', async () => {
  const c = commitWith();
  const pdf = { name: 'send_brochure', args: { listing_id: 'BONA-W003' }, result: { will_send: 'pdf', reason: 'ok' } };
  const out = await c.afterPreSend({ lead: LEAD, turn: brainReply('Sending it now.', { tools: [pdf] }), text: 'Sending it now.', language: 'en' });
  assert.deepEqual(out.bubbles, [
    { kind: 'text', text: 'Sending it now.' },
    { kind: 'document', url: EXACT.brochureUrl, caption: 'BONA-W003 brochure', fileName: 'BONA-W003-brochure.pdf', mediaKind: 'document', listingId: 'BONA-W003' },
  ]);
  for (const t of [
    { name: 'send_brochure', args: { listing_id: 'BONA-W003' }, result: { will_send: 'link', url: EXACT.brochureUrl } },
    { name: 'send_brochure', args: { listing_id: 'BONA-W011' }, result: { will_send: 'pdf' } },
    { name: 'send_brochure', args: { listing_id: 'BONA-W999' }, result: { will_send: 'pdf' } },
    { name: 'send_brochure', args: { listing_id: 'BONA-W003' }, result: { error: 'tool_failed' } },
  ]) {
    const r = await c.afterPreSend({ lead: LEAD, turn: brainReply('Here.', { tools: [t] }), text: 'Here.', language: 'en' });
    assert.deepEqual(r.bubbles, [{ kind: 'text', text: 'Here.' }], JSON.stringify(t));
  }
  // With a booking, the brochure follows the confirmation (DESIGN §8.3 step 8).
  const both = await commitWith({ viewing: fakeViewing() }).afterPreSend({ lead: LEAD, turn: brainReply('Done.', { tools: [book(), pdf] }), text: 'Done.', language: 'en' });
  assert.deepEqual(both.bubbles.map((b) => b.kind), ['text', 'document']);
  assert.equal(both.bubbles[0].text, CONFIRMATION);
});

test('an exact location → a maps link at the end of the text, within MAX_LINKS; a district or no pin → no link', async () => {
  const c = commitWith();
  const loc = (id, precision = 'exact') => ({ name: 'send_location', args: { listing_id: id }, result: { precision } });
  const link = `https://maps.google.com/?q=${Number(EXACT.map.lat)},${Number(EXACT.map.lng)}`;
  const en = await c.afterPreSend({ lead: LEAD, turn: brainReply('It is in Al Shati.', { tools: [loc('BONA-W003')] }), text: 'It is in Al Shati.', language: 'en' });
  assert.deepEqual(en.bubbles, [{ kind: 'text', text: `It is in Al Shati.\n\nLocation: ${link}` }]);
  const ar = await c.afterPreSend({ lead: LEAD, turn: brainReply('في الشاطئ.', { tools: [loc('BONA-W003')] }), text: 'في الشاطئ.', language: 'ar' });
  assert.equal(ar.bubbles[0].text, `في الشاطئ.\n\nالموقع: ${link}`);
  const full = Array.from({ length: DEFAULT_MAX_LINKS }, (_, i) => `https://bona.example.com/properties/x${i}/`).join('\n');
  const capped = await c.afterPreSend({ lead: LEAD, turn: brainReply(full, { tools: [loc('BONA-W003')] }), text: full, language: 'en' });
  assert.equal(capped.bubbles[0].text, full, 'MAX_LINKS already used: no map link');
  const already = `See ${link}`;
  assert.equal((await c.afterPreSend({ lead: LEAD, turn: brainReply(already, { tools: [loc('BONA-W003')] }), text: already, language: 'en' })).bubbles[0].text, already, 'never twice');
  for (const t of [loc(DISTRICT.id, 'district'), loc(DISTRICT.id, 'exact'), loc('BONA-W003', 'none'), loc('BONA-W999')]) {
    const r = await c.afterPreSend({ lead: LEAD, turn: brainReply('Here.', { tools: [t] }), text: 'Here.', language: 'en' });
    assert.equal(r.bubbles[0].text, 'Here.', JSON.stringify(t));
  }
});

test('the safety net: a brain answer that claims a booking with no successful commit → the "team will confirm" line and a booking_failed hand-over', async () => {
  const c = commitWith({ viewing: fakeViewing() });
  const slots = { name: 'viewing_slots', args: { listing_id: 'BONA-W003' }, result: { bookable: true, slots: [] } };
  const needs = { name: 'save_needs', args: { name: 'Sara Example' }, result: { saved: true } };
  for (const [text, lang] of [['Your viewing is booked for Sunday at 10.', 'en'], ['All confirmed, see you then!', 'en'], ['تم الحجز يوم الأحد الساعة 10', 'ar'], ['تم تأكيد موعدك', 'ar']]) {
    // The turn after the slots were offered has no viewing tool (or save_needs only): the claim is caught anyway.
    for (const tools of [[], [needs], [slots]]) {
      const out = await c.afterPreSend({ lead: LEAD, turn: brainReply(text, { tools }), text, language: lang });
      assert.deepEqual(out, { bubbles: [{ kind: 'text', text: BOOKING_FAILED_LINE[lang] }], handover: { kind: 'booking_failed' } }, `${text} (${tools.map((t) => t.name).join(',') || 'no tool'})`);
    }
  }
  // A claim next to a book_viewing that was not reserved: still caught.
  const refused = await c.afterPreSend({ lead: LEAD, turn: brainReply('Booked!', { tools: [book(undefined, { reserved: false })] }), text: 'Booked!', language: 'en' });
  assert.deepEqual(refused.handover, { kind: 'booking_failed' });
  // No claim: untouched ("booking" is not "booked").
  const fine = 'I am booking it for you now.';
  assert.deepEqual(await c.afterPreSend({ lead: LEAD, turn: brainReply(fine), text: fine, language: 'en' }), { bubbles: [{ kind: 'text', text: fine }] });
  // A legacy Retell completion (no toolCalls: the Retell WhatsApp agent has no booking tool) is left as today.
  const legacy = { messages: [{ role: 'agent', content: 'The price is confirmed by the developer.' }] };
  assert.deepEqual(await c.afterPreSend({ lead: LEAD, turn: legacy, text: 'The price is confirmed by the developer.', language: 'en' }),
    { bubbles: [{ kind: 'text', text: 'The price is confirmed by the developer.' }] }, 'inert for legacy leads');
});

test('afterSend: the confirmation accepted → markTold and the booking note; not accepted → the untold note and a booking_unconfirmed hand-over', async () => {
  const viewing = fakeViewing();
  const notes = fakeNotes();
  const c = commitWith({ viewing, notes });
  assert.deepEqual(await c.afterSend({ lead: LEAD, booking: { bookingId: 'bk-1' }, accepted: true }), { told: true });
  assert.deepEqual(viewing.told, ['bk-1']);
  assert.deepEqual(notes.booked, [['bk-1', { told: true }]]);
  assert.deepEqual(await c.afterSend({ lead: LEAD, booking: { bookingId: 'bk-2' }, accepted: false }), { told: false, handover: { kind: 'booking_unconfirmed' } });
  assert.deepEqual(viewing.told, ['bk-1'], 'not told');
  assert.deepEqual(notes.booked.at(-1), ['bk-2', { told: false }]);
  assert.deepEqual(await c.afterSend({ lead: LEAD, booking: null, accepted: true }), {});
  assert.deepEqual(await createDanaCommit().afterSend({ lead: LEAD, booking: { bookingId: 'bk-3' }, accepted: true }), { told: true }, 'nothing wired: no throw');
});

test('end to end on the real modules (a fake calendar): the tools validate, the commit books, the confirmation goes, the row is told and the booking note is queued', async () => {
  const db = openDb(':memory:');
  try {
    const team = createTeam(db);
    team.setSetting('calendar_booking', '1');
    const events = new Map();
    const gcal = {
      configured: true,
      async freeBusy() { return { ok: true, busy: [] }; },
      async holidays() { return { ok: true, dates: new Set() }; },
      cachedHolidays: () => new Set(),
      async insert(ev, { ready } = {}) { if (ready && !ready()) return { ok: false, aborted: true }; events.set(ev.id, ev); return { ok: true, eventId: ev.id }; },
      async get(id) { return events.has(id) ? { ok: true, event: events.get(id) } : { ok: false, code: 'not_found', gone: true }; },
      async access() { return { ok: true, role: 'writer' }; },
      health: () => ({ configured: true, ok: true, lastErrorCode: null }),
    };
    const ownerTest = { autoMode: (l) => Boolean(l) };
    const t = { now: NOW };
    const viewing = createViewing({ db, cfg: { siteUrl: 'https://bona.example.com', publicApi: 'https://api.example.com' }, team, ownerTest, inventory, gcal, now: () => t.now });
    const notes = createOwnerNotes({ db, siteUrl: 'https://bona.example.com', sendNote: async () => ({ ok: true }), team, ownerTest, ledger: true, now: () => t.now });
    db.insertLead({ lead_id: LEAD.lead_id, created: NOW - 3_600_000, updated: NOW - 3_600_000, stage: 'new', phone_e164: '966500000077', name: 'Sara Example', channel: 'whatsapp', inbox_state: 'in', inbox_since: NOW - 3_600_000, inbox_via: 'own_number', dana_introduced: 1 });
    const tools = createToolHandlers({
      inventory, store: createStore(), db, dataDir: '/nonexistent', siteUrl: 'https://bona.example.com', env: {}, ownerTest, viewing, notes, now: () => t.now,
      publishedUnits: createPublishedUnits({ fetch: async () => { throw new Error('no network in tests'); } }),
      fetchImpl: async () => { throw new Error('no network in tests'); },
    });
    const run = async (name, args) => tools.run(name, { chat: { chat_id: `wa:${LEAD.lead_id}`, metadata: { source: 'bona-whatsapp', lead_id: LEAD.lead_id }, retell_llm_dynamic_variables: { language: 'en', locale: 'en' } }, args }, { inProcess: true });
    const args = { slot_id: SLOT, listing_id: 'BONA-W003' };
    const result = await run('book_viewing', args);
    assert.equal(JSON.parse(result).reserved, true);
    assert.equal(db.db.prepare('SELECT COUNT(*) n FROM viewing_bookings').get().n, 0, 'the tool wrote nothing');
    const turn = brainReply('I am booking it for you now.', { tools: [{ name: 'book_viewing', args, result }] });
    const lead = db.getLead(LEAD.lead_id);
    const c = createDanaCommit({ viewing, notes, inventory, log: () => {} });
    const out = await c.afterPreSend({ lead, turn, text: 'I am booking it for you now.', language: 'en', coversTs: NOW });
    assert.ok(out.bubbles[0].text.startsWith('Your viewing is booked ✅'), 'the code-built confirmation');
    assert.ok(out.bubbles[0].text.includes('https://maps.google.com/?q='), 'an exact pin: the maps link is in it');
    assert.equal(events.size, 1, 'one calendar event');
    const row = db.db.prepare('SELECT * FROM viewing_bookings').get();
    assert.equal(row.status, 'booked');
    assert.equal(row.client_told, 0, 'not told before the send');
    assert.equal(out.booking.bookingId, row.booking_id);
    assert.deepEqual(await c.afterSend({ lead, booking: out.booking, accepted: true }), { told: true });
    assert.equal(db.db.prepare('SELECT client_told FROM viewing_bookings').get().client_told, 1);
    const note = db.db.prepare("SELECT kind, dedupe_key, status FROM owner_notes WHERE kind = 'booking'").get();
    assert.deepEqual({ ...note }, { kind: 'booking', dedupe_key: `bk:${row.booking_id}`, status: 'queued' });
    notes.stop?.();
  } finally { db.close(); }
});

/* ---------------- PR-B4 r2 (the r1 reviews) ---------------- */

test('the safety net fires only with booking intent (a viewing tool, a viewing word, a weekday or clock time, a personal claim form): delivery, availability and price sentences are untouched', async () => {
  const c = commitWith({ viewing: fakeViewing() });
  const search = { name: 'search_properties', args: { query: 'x' }, result: { count: 1, results: [] } };
  const details = { name: 'listing_details', args: { listing_id: 'BONA-W014' }, result: { found: true } };
  const untouched = [
    ['Yes, the developer has confirmed delivery in Q4 2027.', 'en'],
    ['Confirmed: it has a private pool', 'en'],
    ['The 2-bedroom units are fully booked right now, but the 3-bedroom ones are available.', 'en'],
    ['تم تأكيد موعد التسليم في الربع الرابع 2027', 'ar'],
    ['تم حجز كل الشقق بغرفتين، والمتاح الحين 3 غرف', 'ar'],
    ['The price is confirmed by the developer.', 'en'],
    ['Delivery is confirmed for 15 December 2027.', 'en'],
  ];
  const needs = { name: 'save_needs', args: { name: 'Sara Example' }, result: { saved: true } };
  for (const [text, lang] of untouched) {
    for (const tools of [[], [search], [details], [needs]]) {
      const out = await c.afterPreSend({ lead: LEAD, turn: brainReply(text, { tools }), text, language: lang });
      assert.deepEqual(out, { bubbles: [{ kind: 'text', text }] }, `${text} (${tools.map((t) => t.name).join(',') || 'no tool'})`);
    }
  }
  const caught = [
    ['Your viewing is booked for Sunday at 10.', 'en'],
    ['Great, your visit is confirmed for Monday 12:00 pm.', 'en'],
    ['Done! The viewing is booked for 6 December.', 'en'],
    ['تم حجز موعد معاينتك يوم الأحد الساعة 10', 'ar'],
    ['تم تأكيد زيارتك بكرة الساعة ٢ ظهراً', 'ar'],
  ];
  for (const [text, lang] of caught) {
    for (const tools of [[], [search]]) {
      const out = await c.afterPreSend({ lead: LEAD, turn: brainReply(text, { tools }), text, language: lang });
      assert.deepEqual(out, { bubbles: [{ kind: 'text', text: BOOKING_FAILED_LINE[lang] }], handover: { kind: 'booking_failed' } }, text);
    }
  }
  // With a viewing tool in the turn, a bare claim is enough.
  const slots = { name: 'viewing_slots', args: { listing_id: 'BONA-W003' }, result: { bookable: true, slots: [] } };
  assert.deepEqual((await c.afterPreSend({ lead: LEAD, turn: brainReply('Booked!', { tools: [slots] }), text: 'Booked!', language: 'en' })).handover, { kind: 'booking_failed' });
});

test('the LAST book_viewing decides: Sunday reserved then Monday refused commits nothing; two homes both reserved → only the last is booked (one booking per lead)', async () => {
  const viewing = fakeViewing();
  const c = commitWith({ viewing });
  const sunday = book({ slot_id: SLOT, listing_id: 'BONA-W003' });
  const monday = book({ slot_id: '2026-12-07T12:00+03:00', listing_id: 'BONA-W003' }, { reserved: false, reason: 'busy' });
  const text = 'Monday at 12 is taken; shall I keep Sunday at 10?';
  const out = await c.afterPreSend({ lead: LEAD, turn: brainReply(text, { tools: [sunday, monday] }), text, language: 'en' });
  assert.equal(viewing.calls.length, 0, 'Sunday is not booked behind the client\'s back');
  assert.deepEqual(out, { bubbles: [{ kind: 'text', text }] }, 'the question goes as written');
  // Refused, then reserved: the last one (reserved) is committed.
  await c.afterPreSend({ lead: LEAD, turn: brainReply('Booking Sunday.', { tools: [monday, sunday] }), text: 'Booking Sunday.', language: 'en' });
  assert.deepEqual(viewing.calls.map((o) => o.slotId), [SLOT]);
  // Two homes in one turn: both validate (nothing is written by a tool), the last is the one committed; the
  // confirmation names that home, and the other is not booked (DESIGN §8.4: one active booking per lead).
  const two = fakeViewing();
  const w006 = book({ slot_id: '2026-12-07T12:00+03:00', listing_id: 'BONA-W006' }, { ...RESERVED, listing_id: 'BONA-W006' });
  const r = await commitWith({ viewing: two }).afterPreSend({ lead: LEAD, turn: brainReply('Booking both.', { tools: [sunday, w006] }), text: 'Booking both.', language: 'en' });
  assert.deepEqual(two.calls.map((o) => [o.listingId, o.slotId]), [['BONA-W006', '2026-12-07T12:00+03:00']]);
  assert.equal(r.bubbles[0].text, CONFIRMATION, 'one confirmation, from the commit');
});

test('dana-commit does not import lib/dana-wa.mjs (dana-wa imports BOOKING_FAILED_LINE from here); maxLinks comes from deps', async () => {
  const src = fs.readFileSync(new URL('../lib/dana-commit.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from\s+['"]\.\/dana-wa\.mjs['"]/);
  assert.equal(DEFAULT_MAX_LINKS, 2, 'DESIGN §6.5');
  const loc = { name: 'send_location', args: { listing_id: 'BONA-W003' }, result: { precision: 'exact' } };
  const one = 'See https://bona.example.com/properties/x/';
  assert.equal((await commitWith({ maxLinks: 1 }).afterPreSend({ lead: LEAD, turn: brainReply(one, { tools: [loc] }), text: one, language: 'en' })).bubbles[0].text, one);
  assert.match((await commitWith({ maxLinks: 3 }).afterPreSend({ lead: LEAD, turn: brainReply(one, { tools: [loc] }), text: one, language: 'en' })).bubbles[0].text, /maps\.google\.com/);
});

test("a brochure document is only ever a PDF on Bona's site (https, the site's hosts), whatever the listing says", async () => {
  const listing = (id, brochureUrl) => ({ ...EXACT, id, slug: `example-${id.toLowerCase()}`, brochureUrl });
  const list = [listing('BONA-W961', 'https://evil.example/b.pdf'), listing('BONA-W962', 'http://bona-real-estate.com/b.pdf'), listing('BONA-W965', 'https://www.bona-real-estate.com/b.pdf')];
  const c = commitWith({ inventory: { exact: (ref) => list.find((l) => l.id === ref) ?? null } });
  const pdf = (id) => ({ name: 'send_brochure', args: { listing_id: id }, result: { will_send: 'pdf' } });
  for (const id of ['BONA-W961', 'BONA-W962']) {
    assert.deepEqual((await c.afterPreSend({ lead: LEAD, turn: brainReply('Here.', { tools: [pdf(id)] }), text: 'Here.', language: 'en' })).bubbles.length, 1, id);
  }
  assert.equal((await c.afterPreSend({ lead: LEAD, turn: brainReply('Here.', { tools: [pdf('BONA-W965')] }), text: 'Here.', language: 'en' })).bubbles[1].url, 'https://www.bona-real-estate.com/b.pdf');
});

/* ---------------- PR-B4 r3 (the r2 reviews) ---------------- */

const NEEDS = { name: 'save_needs', args: { name: 'Sara Example' }, result: { saved: true } };

test('the safety net catches the realistic claims of the turn after the slots were offered: no viewing tool, or save_needs only (Claude r2 P1-1, Codex r2 P1)', async () => {
  const c = commitWith({ viewing: fakeViewing() });
  const claims = [
    ['All confirmed, see you then!', 'en'],
    ['Booked! See you on Sunday.', 'en'],
    ["Done, you're booked for Sunday 10:00.", 'en'],
    ['Great, your appointment is confirmed.', 'en'],
    ['Your viewing is confirmed, Sara.', 'en'],
    ['Perfect, it is booked for tomorrow at 10 am.', 'en'],
    ['Your viewing is booked.', 'en'], // Codex r2: an affirmative claim with no time
    ['تمام، تم الحجز ✅', 'ar'],
    ['تم الحجز يوم الأحد الساعة 10', 'ar'],
    ['تم تأكيد موعدك', 'ar'],
    ['أبشري، حجزت لك الأحد الساعة 10 الصبح', 'ar'],
    ['تم حجز المعاينة ✅', 'ar'],
    ['تم تأكيد موعد المعاينة يوم الأحد', 'ar'],
    ['تم حجز موعدك يوم الأحد الساعة ١٠ صباحاً', 'ar'],
  ];
  for (const [text, lang] of claims) {
    for (const tools of [[], [NEEDS]]) {
      const out = await c.afterPreSend({ lead: LEAD, turn: brainReply(text, { tools }), text, language: lang });
      assert.deepEqual(out, { bubbles: [{ kind: 'text', text: BOOKING_FAILED_LINE[lang] }], handover: { kind: 'booking_failed' } }, `${text} (${tools.length ? 'save_needs' : 'no tool'})`);
    }
  }
});

test('a negated claim is no claim: the need_name flow and "not booked yet" answers go as written, with no hand-over (Codex r2 P2)', async () => {
  const viewing = fakeViewing();
  const c = commitWith({ viewing });
  const needName = book({ slot_id: SLOT, listing_id: 'BONA-W003' }, { reserved: false, need_name: true, reason: 'need_name' });
  const slots = { name: 'viewing_slots', args: { listing_id: 'BONA-W003' }, result: { bookable: true, slots: [] } };
  const denials = [
    ["Your viewing isn't booked yet. What name should I use?", 'en'],
    ['Your viewing is not confirmed yet; which name should I put it under?', 'en'],
    ["It's not booked yet. Shall I book Sunday 10:00 for you?", 'en'],
    ['The viewing is not yet confirmed: what is your name?', 'en'],
    ['لم يتم الحجز بعد، إيش اسمك الكريم؟', 'ar'],
    ['ما تم الحجز للحين، أي اسم أسجّله؟', 'ar'],
    ['لسه ما تم الحجز، إيش اسمك؟', 'ar'],
    ['Not booked yet: may I have your name?', 'en'],
    ["You're not booked yet; which name should I use?", 'en'],
    ["Your viewing hasn't been confirmed yet. Your name, please?", 'en'],
    ['الحجز لسه ما تأكد، إيش اسمك؟', 'ar'],
    ['للحين ما تم الحجز، أرسل لي اسمك', 'ar'],
    ['الحجز غير مؤكد للحين، إيش اسمك الكريم؟', 'ar'],
  ];
  for (const [text, lang] of denials) {
    for (const tools of [[needName], [slots], []]) {
      const out = await c.afterPreSend({ lead: LEAD, turn: brainReply(text, { tools }), text, language: lang });
      assert.deepEqual(out, { bubbles: [{ kind: 'text', text }] }, `${text} (${tools.map((t) => t.name).join(',') || 'no tool'})`);
    }
  }
  assert.equal(viewing.calls.length, 0);
  // A denial next to a real claim in another sentence: the claim still counts.
  const mixed = "Sorry, Monday isn't free. Your viewing is booked for Sunday at 10.";
  assert.deepEqual((await c.afterPreSend({ lead: LEAD, turn: brainReply(mixed), text: mixed, language: 'en' })).handover, { kind: 'booking_failed' });
  // And an affirmative claim after a refused book_viewing (Codex r2): caught.
  const refused = await c.afterPreSend({ lead: LEAD, turn: brainReply('Your viewing is booked.', { tools: [needName] }), text: 'Your viewing is booked.', language: 'en' });
  assert.deepEqual(refused.handover, { kind: 'booking_failed' });
});

test('a reserved book_viewing followed by one that never ran (the tool limit, a thrown tool) → no commit, and the line + a booking_failed hand-over, never the unbacked "booking it" text (Claude r2 P3-1)', async () => {
  const sunday = book({ slot_id: SLOT, listing_id: 'BONA-W003' });
  for (const later of [
    { name: 'book_viewing', args: { slot_id: '2026-12-07T12:00+03:00', listing_id: 'BONA-W003' }, result: { error: 'tool_limit' }, ok: false },
    { name: 'book_viewing', args: { slot_id: SLOT, listing_id: 'BONA-W003' }, result: { error: 'tool_failed', note: 'x' }, ok: false },
  ]) {
    const viewing = fakeViewing();
    const text = "I'm booking Sunday at 10 for you now.";
    const out = await commitWith({ viewing }).afterPreSend({ lead: LEAD, turn: brainReply(text, { tools: [sunday, later] }), text, language: 'en' });
    assert.equal(viewing.calls.length, 0, 'the last call decides: nothing is committed');
    assert.deepEqual(out, { bubbles: [{ kind: 'text', text: BOOKING_FAILED_LINE.en }], handover: { kind: 'booking_failed' } }, later.result.error);
  }
  // A last call that ran and was refused is the model's to answer (r1): its question goes as written.
  const refusedLast = book({ slot_id: '2026-12-07T12:00+03:00', listing_id: 'BONA-W003' }, { reserved: false, reason: 'busy' });
  const q = 'Monday at 12 is taken; shall I keep Sunday at 10?';
  assert.deepEqual(await commitWith({ viewing: fakeViewing() }).afterPreSend({ lead: LEAD, turn: brainReply(q, { tools: [sunday, refusedLast] }), text: q, language: 'en' }), { bubbles: [{ kind: 'text', text: q }] });
  // A failed call with nothing reserved before it: no claim, no hand-over (the model says it cannot check).
  const onlyFailed = { name: 'book_viewing', args: { slot_id: SLOT, listing_id: 'BONA-W003' }, result: { error: 'tool_failed' }, ok: false };
  const sorry = 'I cannot check that right now; a person from the team can help.';
  assert.deepEqual(await commitWith({ viewing: fakeViewing() }).afterPreSend({ lead: LEAD, turn: brainReply(sorry, { tools: [onlyFailed] }), text: sorry, language: 'en' }), { bubbles: [{ kind: 'text', text: sorry }] });
});

/* ---------------- PR-B4 r4 (the r3 reviews) ---------------- */

const caughtWith = async (c, text, lang, tools) => {
  const out = await c.afterPreSend({ lead: LEAD, turn: brainReply(text, { tools }), text, language: lang });
  return out.handover?.kind === 'booking_failed' && out.bubbles[0].text === BOOKING_FAILED_LINE[lang];
};

test('a denial counts only where it governs the claim word: a negative word about something else never hides a claim (Claude r3 P2-1, Codex r3 P1)', async () => {
  const c = commitWith({ viewing: fakeViewing() });
  const claims = [
    ["You're booked for Sunday at 10, the exact meeting point isn't set yet, the team will send it.", 'en'],
    ['Your viewing is confirmed for Sunday at 10 am; the meeting point is not shared yet.', 'en'],
    ['Booked for Sunday 10:00, not yet sent you the location but I will.', 'en'],
    ["Your viewing is booked for Sunday at 10, and there's nothing you haven't sent us.", 'en'],
    ["Monday isn't available, but your Sunday viewing is booked", 'en'], // Codex r3
    ["Not to worry, you're booked for Sunday 10:00", 'en'],
    ["Your viewing is booked for Sunday at 10 — you don't need to do anything else.", 'en'],
    ['تم حجز موعدك يوم الأحد الساعة 10، ولم يتم تحديد نقطة اللقاء بعد', 'ar'],
    ['تم الحجز ✅ ولسه ما أرسلت لك الموقع، الفريق بيرسله', 'ar'],
    ['تم تأكيد موعدك يوم الأحد، والموقع غير مؤكد للحين', 'ar'],
    ['تم الحجز يوم الأحد، وهذا ما تم الاتفاق عليه', 'ar'], // «ما تم» = "what was", no denial
    ['بعد ما حجزت لك الأحد الساعة 10، الفريق بيرسل لك الموقع', 'ar'], // «بعد ما» + a past verb = "after"
    ['بعد ما تم الحجز، بيرسل لك الفريق نقطة اللقاء', 'ar'],
    ['لا تشيل هم، تم الحجز', 'ar'],
  ];
  for (const [text, lang] of claims) {
    for (const tools of [[], [NEEDS]]) assert.ok(await caughtWith(c, text, lang, tools), `${text} (${tools.length ? 'save_needs' : 'no tool'})`);
  }
  // Ambiguous or itself false: they hand over, the safe side (a needless hand-over, never a phantom booking).
  for (const [text, lang] of [['بعد ما تأكد الحجز، أرسل لي اسمك وأكمّل لك', 'ar'], ['حجزت لك الموعد مبدئياً، وهو غير مؤكد للحين. إيش اسمك؟', 'ar']]) {
    assert.ok(await caughtWith(c, text, lang, []), text);
  }
});

test('personal claim forms are claims on their own: "You\'re all set for Sunday at 10. See you then!", «نشوفك الأحد الساعة 10»; a plain goodbye is not (Codex r3 P1)', async () => {
  const c = commitWith({ viewing: fakeViewing() });
  for (const [text, lang] of [
    ["You're all set for Sunday at 10. See you then!", 'en'],
    ['You are all set for Monday 12:00.', 'en'],
    ['See you on Sunday at 10!', 'en'],
    ['See you then!', 'en'],
    ['تمام، نشوفك الأحد الساعة 10', 'ar'],
    ['أبشر، بنشوفك بكرة الساعة 12 الظهر', 'ar'],
  ]) {
    for (const tools of [[], [NEEDS]]) assert.ok(await caughtWith(c, text, lang, tools), `${text} (${tools.length ? 'save_needs' : 'no tool'})`);
  }
  for (const [text, lang] of [['Hope to see you soon!', 'en'], ['See you soon, take care.', 'en'], ['نشوفك على خير', 'ar'], ['حياك الله، نشوفك قريب', 'ar']]) {
    assert.deepEqual(await c.afterPreSend({ lead: LEAD, turn: brainReply(text), text, language: lang }), { bubbles: [{ kind: 'text', text }] }, text);
  }
});

test("the booking sign is read in the claim's own sentence (the viewing tool turn-wide): a goodbye next to \"fully booked\", or \"today\", is no claim (Claude r3 P3-1)", async () => {
  const c = commitWith({ viewing: fakeViewing() });
  const untouched = [
    ['Hope to see you soon! The 2-bedroom units are fully booked.', 'en'],
    ['The 2-bedroom units are fully booked; the 3-bedroom ones are open from Sunday.', 'en'],
    ['The developer confirmed the handover date today.', 'en'],
    ['تم حجز كل الشقق بغرفتين اليوم', 'ar'],
  ];
  for (const [text, lang] of untouched) {
    for (const tools of [[], [NEEDS]]) {
      assert.deepEqual(await c.afterPreSend({ lead: LEAD, turn: brainReply(text, { tools }), text, language: lang }), { bubbles: [{ kind: 'text', text }] }, text);
    }
  }
  // A viewing tool in the turn is a sign for every sentence: the claim in the second one hands over.
  const slots = { name: 'viewing_slots', args: { listing_id: 'BONA-W003' }, result: { bookable: true, slots: [] } };
  assert.ok(await caughtWith(c, untouched[0][0], 'en', [slots]));
});

/* ---------------- PR-B4 r5 (the r4 reviews) ---------------- */

test('a claim whose slot sits in the next sentence is caught (the sign may come from anywhere unless the claim names stock), and «تم التأكيد» is a claim (Claude r4 P2-1)', async () => {
  const c = commitWith({ viewing: fakeViewing() });
  for (const [text, lang] of [
    ["Sunday at 10 works. It's booked!", 'en'], ['Perfect, Sunday at 10. Booked!', 'en'], ['Great choice: Sunday 10 am. It is confirmed.', 'en'],
    ['Sunday at 10 it is. All confirmed!', 'en'], ['تمام، الأحد الساعة 10. تم التأكيد ✅', 'ar'], ['الأحد الساعة 10. تم تأكيد الموعد', 'ar'],
    ['يوم الأحد الساعة ١٠ صباحاً. تم الحجز ✅', 'ar'],
  ]) {
    for (const tools of [[], [NEEDS]]) assert.ok(await caughtWith(c, text, lang, tools), `${text} (${tools.length ? 'save_needs' : 'no tool'})`);
  }
  // A claim about stock keeps needing its sign in its own sentence.
  const stock = 'The team is in on Sunday. The 3-bedroom units are fully booked.';
  assert.deepEqual(await c.afterPreSend({ lead: LEAD, turn: brainReply(stock), text: stock, language: 'en' }), { bubbles: [{ kind: 'text', text: stock }] });
});

test('"I\'ve booked you in" is a claim on its own: a second-person object on the claim word is a booking sign (Codex r4 P1)', async () => {
  const c = commitWith({ viewing: fakeViewing() });
  for (const [text, lang] of [["Perfect, I've booked you in!", 'en'], ["Done, I've reserved you a place.", 'en'], ['All good, I booked it for you.', 'en'], ['تمام، حجزنا لك', 'ar']]) {
    for (const tools of [[], [NEEDS]]) assert.ok(await caughtWith(c, text, lang, tools), `${text} (${tools.length ? 'save_needs' : 'no tool'})`);
  }
});

test('active-voice denials pass in the need_name flow: "I haven\'t booked your viewing yet", «ما حجزت لك للحين» (Codex r4 P2, Claude r4 P2-2)', async () => {
  const c = commitWith({ viewing: fakeViewing() });
  const needName = book({ slot_id: SLOT, listing_id: 'BONA-W003' }, { reserved: false, need_name: true, reason: 'need_name' });
  for (const [text, lang] of [
    ["I haven't booked your viewing yet. What name should I use?", 'en'], ["I haven't booked it yet. What name should I put it under?", 'en'],
    ["We haven't confirmed it yet; may I have your name?", 'en'], ['I have not booked it yet — what is your name?', 'en'],
    ["I didn't book it yet, may I have your name?", 'en'], ['ما حجزت لك للحين، إيش اسمك؟', 'ar'], ['لسه ما حجزت لك، إيش اسمك الكريم؟', 'ar'],
  ]) {
    for (const tools of [[], [needName]]) {
      assert.deepEqual(await c.afterPreSend({ lead: LEAD, turn: brainReply(text, { tools }), text, language: lang }), { bubbles: [{ kind: 'text', text }] }, `${text} (${tools.length ? 'need_name' : 'no tool'})`);
    }
  }
});

/**
 * THE CLAIM CORPUS (PR-B4 r1-r5; Claude's and Codex's examples from every round). One row per sentence:
 * `trips` is the outcome with no tool in the turn AND with save_needs only (the turn after the slots were offered);
 * `viewing`, when set, is the outcome with a viewing tool in the turn (viewing_slots, and a need_name book_viewing).
 * Later rounds add rows here. Kinds: claim, split (the slot in another sentence), personal (no claim word), today,
 * denial (the need_name flow), ordinary (an answer about stock, price, delivery or a goodbye), over (an accepted
 * over-trigger: a needless hand-over, never a phantom booking).
 */
const CORPUS = [
  // claims
  ['claim', 'Your viewing is booked for Sunday at 10.', 'en', true, true],
  ['claim', 'All confirmed, see you then!', 'en', true, true],
  ['claim', 'تم الحجز يوم الأحد الساعة 10', 'ar', true, true],
  ['claim', 'تم تأكيد موعدك', 'ar', true, true],
  ['claim', 'Great, your visit is confirmed for Monday 12:00 pm.', 'en', true, true],
  ['claim', 'Done! The viewing is booked for 6 December.', 'en', true, true],
  ['claim', 'تم حجز موعد معاينتك يوم الأحد الساعة 10', 'ar', true, true],
  ['claim', 'تم تأكيد زيارتك بكرة الساعة ٢ ظهراً', 'ar', true, true],
  ['claim', 'Booked! See you on Sunday.', 'en', true, true],
  ['claim', "Done, you're booked for Sunday 10:00.", 'en', true, true],
  ['claim', 'Great, your appointment is confirmed.', 'en', true, true],
  ['claim', 'Your viewing is confirmed, Sara.', 'en', true, true],
  ['claim', 'Perfect, it is booked for tomorrow at 10 am.', 'en', true, true],
  ['claim', 'Your viewing is booked.', 'en', true, true],
  ['claim', 'تمام، تم الحجز ✅', 'ar', true, true],
  ['claim', 'أبشري، حجزت لك الأحد الساعة 10 الصبح', 'ar', true, true],
  ['claim', 'تم حجز المعاينة ✅', 'ar', true, true],
  ['claim', 'تم تأكيد موعد المعاينة يوم الأحد', 'ar', true, true],
  ['claim', 'تم حجز موعدك يوم الأحد الساعة ١٠ صباحاً', 'ar', true, true],
  ['claim', "Sorry, Monday isn't free. Your viewing is booked for Sunday at 10.", 'en', true, true],
  ['claim', "You're booked for Sunday at 10, the exact meeting point isn't set yet, the team will send it.", 'en', true, true],
  ['claim', 'Your viewing is confirmed for Sunday at 10 am; the meeting point is not shared yet.', 'en', true, true],
  ['claim', 'Booked for Sunday 10:00, not yet sent you the location but I will.', 'en', true, true],
  ['claim', "Your viewing is booked for Sunday at 10, and there's nothing you haven't sent us.", 'en', true, true],
  ['claim', "Monday isn't available, but your Sunday viewing is booked", 'en', true, true],
  ['claim', "Not to worry, you're booked for Sunday 10:00", 'en', true, true],
  ['claim', 'No worries, your viewing is booked for Sunday at 10.', 'en', true, true],
  ['claim', "Your viewing is booked for Sunday at 10 — you don't need to do anything else.", 'en', true, true],
  ['claim', "Your viewing is booked for Sunday at 10 a.m. The team hasn't sent the pin yet.", 'en', true, true],
  ['claim', 'تم حجز موعدك يوم الأحد الساعة 10، ولم يتم تحديد نقطة اللقاء بعد', 'ar', true, true],
  ['claim', 'تم الحجز ✅ ولسه ما أرسلت لك الموقع، الفريق بيرسله', 'ar', true, true],
  ['claim', 'تم تأكيد موعدك يوم الأحد، والموقع غير مؤكد للحين', 'ar', true, true],
  ['claim', 'تم الحجز يوم الأحد، وهذا ما تم الاتفاق عليه', 'ar', true, true],
  ['claim', 'بعد ما حجزت لك الأحد الساعة 10، الفريق بيرسل لك الموقع', 'ar', true, true],
  ['claim', 'بعد ما تم الحجز، بيرسل لك الفريق نقطة اللقاء', 'ar', true, true],
  ['claim', 'لا تشيل هم، تم الحجز', 'ar', true, true],
  ['claim', 'ولا يهمك، تم الحجز يوم الأحد الساعة 10', 'ar', true, true],
  ['claim', "Perfect, I've booked you in!", 'en', true, true],
  ['claim', 'All good, I booked it for you.', 'en', true, true],
  // the slot in the next sentence
  ['split', "Sunday at 10 works. It's booked!", 'en', true, true],
  ['split', 'Perfect, Sunday at 10. Booked!', 'en', true, true],
  ['split', 'Great choice: Sunday 10 am. It is confirmed.', 'en', true, true],
  ['split', 'Sunday at 10 it is. All confirmed!', 'en', true, true],
  ['split', 'Sunday 10:00 — booked!', 'en', true, true],
  ['split', 'Sunday at 10, booked and confirmed.', 'en', true, true],
  ['split', 'تمام، الأحد الساعة 10. تم التأكيد ✅', 'ar', true, true],
  ['split', 'الأحد الساعة 10. تم تأكيد الموعد', 'ar', true, true],
  ['split', 'يوم الأحد الساعة ١٠ صباحاً. تم الحجز ✅', 'ar', true, true],
  // personal forms, no claim word
  ['personal', "You're all set for Sunday at 10. See you then!", 'en', true, true],
  ['personal', 'You are all set for Monday 12:00.', 'en', true, true],
  ['personal', 'See you on Sunday at 10!', 'en', true, true],
  ['personal', 'See you Sunday at 10!', 'en', true, true],
  ['personal', 'See you then!', 'en', true, true],
  ['personal', 'Looking forward to seeing you on Sunday at 10.', 'en', true, true],
  ['personal', 'تمام، نشوفك الأحد الساعة 10', 'ar', true, true],
  ['personal', 'أبشر، بنشوفك بكرة الساعة 12 الظهر', 'ar', true, true],
  ['personal', 'تمام، نشوفك إن شاء الله يوم الأحد الساعة 10', 'ar', true, true],
  ['personal', 'أبشري، نشوفك الأحد', 'ar', true, true],
  ['personal', 'نشوفك بكرة الساعة 10', 'ar', true, true],
  ['personal', 'نشوفك هناك يوم الأحد', 'ar', true, true],
  ['personal', 'نشوفك في المعاينة يوم الأحد', 'ar', true, true],
  // "today": no viewing is same-day, so a claim for today is itself a phantom
  ['today', 'Booked for today!', 'en', true, true],
  ['today', "You're booked for today.", 'en', true, true],
  ['today', 'Your viewing is confirmed for today.', 'en', true, true],
  ['today', 'تم تأكيد موعدك اليوم', 'ar', true, true],
  // denials: the need_name flow passes as written, with a viewing tool in the turn too
  ['denial', "Your viewing isn't booked yet. What name should I use?", 'en', false, false],
  ['denial', 'Your viewing is not confirmed yet; which name should I put it under?', 'en', false, false],
  ['denial', "It's not booked yet. Shall I book Sunday 10:00 for you?", 'en', false, false],
  ['denial', 'The viewing is not yet confirmed: what is your name?', 'en', false, false],
  ['denial', 'Not booked yet: may I have your name?', 'en', false, false],
  ['denial', "You're not booked yet; which name should I use?", 'en', false, false],
  ['denial', "Your viewing hasn't been confirmed yet. Your name, please?", 'en', false, false],
  ['denial', "It hasn't been booked yet. What's your name?", 'en', false, false],
  ['denial', "I haven't booked your viewing yet. What name should I use?", 'en', false, false],
  ['denial', "I haven't booked it yet. What name should I put it under?", 'en', false, false],
  ['denial', "We haven't confirmed it yet; may I have your name?", 'en', false, false],
  ['denial', 'I have not booked it yet — what is your name?', 'en', false, false],
  ['denial', "Your viewing isn't booked yet — what name should I use?", 'en', false, false],
  ['denial', "Sorry, Monday isn't free. Shall I book Sunday at 10?", 'en', false, false],
  ['denial', 'لم يتم الحجز بعد، إيش اسمك الكريم؟', 'ar', false, false],
  ['denial', 'ما تم الحجز للحين، أي اسم أسجّله؟', 'ar', false, false],
  ['denial', 'لسه ما تم الحجز، إيش اسمك؟', 'ar', false, false],
  ['denial', 'الحجز لسه ما تأكد، إيش اسمك؟', 'ar', false, false],
  ['denial', 'للحين ما تم الحجز، أرسل لي اسمك', 'ar', false, false],
  ['denial', 'الحجز غير مؤكد للحين، إيش اسمك الكريم؟', 'ar', false, false],
  ['denial', 'ما حجزت لك للحين، إيش اسمك؟', 'ar', false, false],
  ['denial', 'لسه ما حجزت لك، إيش اسمك الكريم؟', 'ar', false, false],
  ['denial', 'Monday at 12 is taken; shall I keep Sunday at 10?', 'en', false, false],
  // ordinary answers (stock, price, delivery, brochures, needs, goodbyes)
  ['ordinary', 'Yes, the developer has confirmed delivery in Q4 2027.', 'en', false],
  ['ordinary', 'Confirmed: it has a private pool', 'en', false],
  ['ordinary', 'The 2-bedroom units are fully booked right now, but the 3-bedroom ones are available.', 'en', false],
  ['ordinary', 'تم تأكيد موعد التسليم في الربع الرابع 2027', 'ar', false],
  ['ordinary', 'تم حجز كل الشقق بغرفتين، والمتاح الحين 3 غرف', 'ar', false],
  ['ordinary', 'The price is confirmed by the developer.', 'en', false],
  ['ordinary', 'Delivery is confirmed for 15 December 2027.', 'en', false],
  ['ordinary', "You're all set: I've sent you the brochure.", 'en', false],
  ['ordinary', "Thanks Sara, you're all set — I've noted your budget.", 'en', false],
  ['ordinary', 'Hope to see you soon! The 2-bedroom units are fully booked.', 'en', false],
  ['ordinary', 'The 2-bedroom units are fully booked; the 3-bedroom ones are open from Sunday.', 'en', false],
  ['ordinary', 'The developer confirmed the handover date today.', 'en', false],
  ['ordinary', 'تم حجز كل الشقق بغرفتين اليوم', 'ar', false],
  ['ordinary', 'The team is in on Sunday. The 3-bedroom units are fully booked.', 'en', false],
  ['ordinary', 'The 2-bedroom units are fully booked today.', 'en', false],
  ['ordinary', 'I am booking it for you now.', 'en', false, false],
  ['ordinary', 'Hope to see you soon!', 'en', false, false],
  ['ordinary', 'See you soon, take care.', 'en', false, false],
  ['ordinary', 'نشوفك على خير', 'ar', false, false],
  ['ordinary', 'حياك الله، نشوفك قريب', 'ar', false, false],
  ['ordinary', 'Here is one villa in Al Shati that matches.', 'en', false, false],
  // accepted over-triggers: a needless hand-over, never a phantom booking
  ['over', 'تم تأكيد السعر من المطور يوم الأحد', 'ar', true],
  ['over', 'بعد ما تأكد الحجز، أرسل لي اسمك وأكمّل لك', 'ar', true],
  ['over', 'حجزت لك الموعد مبدئياً، وهو غير مؤكد للحين. إيش اسمك؟', 'ar', true],
  // r5 (Claude P2-1): how booking works, or a slot offer that mentions the confirmation, is no claim
  ['ordinary', 'يتم الحجز من هنا مباشرة، أي يوم يناسبك؟', 'ar', false, false],
  ['ordinary', 'المعاينة مجانية، ويتم الحجز هنا في الواتساب', 'ar', false, false],
  ['ordinary', 'بيتم الحجز بعد ما تختار الموعد', 'ar', false, false],
  ['ordinary', 'هذي المواعيد المتاحة: الأحد 10 الصبح أو الاثنين 12 الظهر. وأول ما يتم الحجز يوصلك تأكيد هنا', 'ar', false, false],
  ['ordinary', 'اختاري الموعد اللي يناسبك، وبعد ما يتأكد الحجز توصلك رسالة', 'ar', false, false],
  ['ordinary', 'راح يتم تأكيد الموعد برسالة هنا بعد ما تختار', 'ar', false, false],
  ['ordinary', "Viewings are free, and once it's booked you get a confirmation here.", 'en', false, false],
  ['ordinary', "These times are free: Sunday 10 am or Monday 12 pm. Once it's booked you'll get a confirmation here.", 'en', false, false],
  ['ordinary', "Which one suits you? You'll get a message here once it's confirmed.", 'en', false, false],
  ['ordinary', 'عشان يتم الحجز أحتاج اسمك الكريم', 'ar', false, false],
  ['ordinary', 'Your viewing will be confirmed by a message here once you pick a time.', 'en', false, false],
  ['claim', 'تمام، وتم الحجز يوم الأحد الساعة 10', 'ar', true, true],
  ['claim', 'Once again, your viewing is booked for Sunday at 10.', 'en', true, true],
  ['claim', 'Your viewing is booked and will be confirmed by message.', 'en', true, true],
  // r5 (Codex P1, P2)
  ['claim', 'Your slot is reserved.', 'en', true, true],
  ['claim', 'Your place is reserved for Sunday.', 'en', true, true],
  ['denial', "I haven't reserved your viewing yet. What name should I use?", 'en', false, false],
  ['denial', "I haven’t reserved your viewing yet. What name should I use?", 'en', false, false],
  // r5 (Claude P3-1): synonym claims
  ['claim', 'Your viewing is scheduled for Sunday at 10.', 'en', true, true],
  ['claim', "I've scheduled you for Sunday at 10.", 'en', true, true],
  ['claim', 'Your viewing is set for Sunday at 10 am.', 'en', true, true],
  ['claim', 'Sunday at 10 is locked in.', 'en', true, true],
  ['claim', 'تمام، ثبتنا لك الموعد يوم الأحد الساعة 10', 'ar', true, true],
  ['claim', 'تم تثبيت الموعد يوم الأحد الساعة 10', 'ar', true, true],
  ['claim', 'سجلت لك موعد يوم الأحد الساعة 10', 'ar', true, true],
  ['claim', 'تم تسجيل موعدك يوم الأحد الساعة 10', 'ar', true, true],
  ['claim', 'انحجز لك الموعد يوم الأحد', 'ar', true, true],
  ['ordinary', 'The price is set by the developer.', 'en', false],
  ['ordinary', 'The date is set for delivery.', 'en', false],
  ['ordinary', 'The handover is set for Q4 2027.', 'en', false],
  ['ordinary', 'سجلت لك طلبك، وبيتواصل معك الفريق', 'ar', false],
  // r5 (Claude P3-2): office hours (a weekday range, a time range of many hours) are no booking sign
  ['ordinary', 'Yes, the private pool is confirmed. The team replies Sunday to Thursday, 10:00–19:00.', 'en', false],
  ["ordinary", "Thanks, you're all set — I've noted your budget. The team replies Sunday to Thursday, 10:00–19:00.", 'en', false],
  ['ordinary', 'تم تأكيد وجود مسبح خاص. والفريق يرد من الأحد إلى الخميس 10:00–19:00', 'ar', false],
  ['claim', 'Your viewing is booked for Sunday, 10:00–11:00.', 'en', true, true],
  ['claim', 'Booked: 10:00–11:00 on Sunday.', 'en', true, true],
].map(([kind, text, lang, trips, viewing]) => ({ kind, text, lang, trips, viewing }));

test(`the claim corpus: ${CORPUS.filter((r) => r.trips).length} claims trip and ${CORPUS.filter((r) => !r.trips).length} non-claims pass, with no tool, with save_needs only, and with a viewing tool where the row says`, async () => {
  const c = commitWith({ viewing: fakeViewing() });
  const slots = { name: 'viewing_slots', args: { listing_id: 'BONA-W003' }, result: { bookable: true, slots: [] } };
  const needName = book({ slot_id: SLOT, listing_id: 'BONA-W003' }, { reserved: false, need_name: true, reason: 'need_name' });
  const outcome = async (row, tools) => {
    const out = await c.afterPreSend({ lead: LEAD, turn: brainReply(row.text, { tools }), text: row.text, language: row.lang });
    if (isDeepStrictEqualish(out, { bubbles: [{ kind: 'text', text: row.text }] })) return false;
    assert.deepEqual(out, { bubbles: [{ kind: 'text', text: BOOKING_FAILED_LINE[row.lang] }], handover: { kind: 'booking_failed' } }, `${row.kind}: ${row.text}`);
    return true;
  };
  const wrong = [];
  for (const row of CORPUS) {
    const runs = [['no tool', [], row.trips], ['save_needs', [NEEDS], row.trips]];
    if (row.viewing !== undefined) runs.push(['viewing_slots', [slots], row.viewing], ['need_name book_viewing', [needName], row.viewing]);
    for (const [label, tools, want] of runs) if ((await outcome(row, tools)) !== want) wrong.push(`${row.kind} (${label}, wants ${want ? 'trip' : 'untouched'}): ${row.text}`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
  assert.equal(new Set(CORPUS.map((r) => r.text)).size, CORPUS.length, 'no row twice');
});

function isDeepStrictEqualish(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
