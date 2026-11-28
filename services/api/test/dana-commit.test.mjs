/**
 * PR-B4 (PLAN T13 test 5; DESIGN §4.3 "commit after preSend", §8.3): what the assistant's answer becomes
 * once preSend has passed. It reads the tool calls off the SAME turn (the brain's `toolCalls`, or the
 * Retell-shaped messages), commits a booking through viewing.commitBooking, adds the brochure document and
 * the exact-pin map link, and replaces a booking claim that no commit backs. A fake calendar and a fake
 * brain turn only: nothing here reaches Google, OpenAI or WhatsApp. Names and numbers are examples.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDanaCommit, turnToolCalls, BOOKING_FAILED_LINE } from '../lib/dana-commit.mjs';
import { brainReply } from '../lib/brain/fake.mjs';
import { retellMessages } from '../lib/brain.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { MAX_LINKS } from '../lib/dana-wa.mjs';
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
  const full = Array.from({ length: MAX_LINKS }, (_, i) => `https://bona.example.com/properties/x${i}/`).join('\n');
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
  for (const [text, lang] of [['Your viewing is booked for Sunday at 10.', 'en'], ['All confirmed, see you then!', 'en'], ['تم الحجز يوم الأحد الساعة 10', 'ar'], ['تم تأكيد موعدك', 'ar']]) {
    const out = await c.afterPreSend({ lead: LEAD, turn: brainReply(text), text, language: lang });
    assert.deepEqual(out, { bubbles: [{ kind: 'text', text: BOOKING_FAILED_LINE[lang] }], handover: { kind: 'booking_failed' } }, text);
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
    const run = async (name, args) => tools.run(name, { chat: { chat_id: `wa:${LEAD.lead_id}`, metadata: { source: 'bona-whatsapp', lead_id: LEAD.lead_id }, retell_llm_dynamic_variables: { language: 'en', locale: 'en' } }, args });
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
