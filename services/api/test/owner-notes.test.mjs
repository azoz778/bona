/**
 * The owner's notes ledger (PLAN T11 tests 1-9, 12, 13; DESIGN §7.1-7.2; DESIGN-brain §4.2, §10).
 * A fake transport or the real one sender (lib/wa-send.mjs, kind 'note') over a fake fetch, and a
 * fake clock: nothing leaves the process, and no timer runs (each test ticks by hand).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createSender } from '../lib/wa-send.mjs';
import { leadNote } from '../lib/leads.mjs';
import { recoverPendingNotifications } from '../lib/enquiry-receipt.mjs';
import {
  createOwnerNotes, FORM_NOTIFY_WAIT_MS, MIN_GAP_MS, MERGE_WINDOW_MS, MAX_PER_DAY, MAX_NOTE_CHARS, HEADERS, ALERT_CODES,
} from '../lib/owner-notes.mjs';

const NOW = 1_795_935_600_000; // Sun 29 Nov 2026 10:00 Riyadh (07:00 UTC)
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const SITE = 'https://bona-real-estate.com';
const API = 'https://api.bona-real-estate.com';
const OWNER_DIGITS = '966500000009';
const OWNER_JID = `${OWNER_DIGITS}@s.whatsapp.net`;
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'bona-test', BONA_OWNER_JID: OWNER_JID };

/**
 * @param {{ auto?: string[], env?: object|null, sendNote?: Function|null, inventory?: object|null, extra?: object }} [o]
 *   `env` set = the real one sender as the transport (what PR-INT wires); otherwise a fake that
 *   answers from `answers` (ok when empty).
 */
function harness({ auto = [], env = null, sendNote = null, inventory = null, extra = {} } = {}) {
  const db = openDb(':memory:');
  let clock = NOW;
  const now = () => clock;
  const team = createTeam(db, { now });
  team.ensureOwner({ phone: OWNER_DIGITS, name: 'Owner Example' });
  const inbox = createInboxStore(db, { now });
  const autoIds = new Set(auto);
  const ownerTest = { autoMode: (lead) => Boolean(lead && autoIds.has(lead.lead_id)), active: () => false };
  const sent = [];
  const answers = [];
  const evo = [];
  let transport = sendNote;
  let sender = null;
  if (env) {
    const fetchImpl = async (url, init) => {
      evo.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: { id: `KEY-${evo.length}` } }) };
    };
    sender = createSender({ env, team, inbox, db, fetchImpl, now });
    transport = async (text) => { sent.push(text); return sender.sendTo({ jid: OWNER_JID, text, kind: 'note' }); };
  } else if (!transport) {
    transport = async (text) => { sent.push(text); return answers.length ? answers.shift() : { ok: true }; };
  }
  const logs = [];
  const deps = { db, siteUrl: SITE, publicApi: API, sendNote: transport, team, inbox, ownerTest, inventory, now, log: (e) => logs.push(e), setTimer: null, ...extra };
  const notes = createOwnerNotes(deps);
  return {
    db, team, inbox, notes, sent, answers, evo, logs, sender, autoIds, deps,
    at: (ms) => { clock = ms; }, now,
    rows: () => db.db.prepare('SELECT * FROM owner_notes ORDER BY created, rowid').all().map((r) => ({ ...r, meta: JSON.parse(r.meta ?? '{}') })),
    row: (key) => { const r = db.db.prepare('SELECT * FROM owner_notes WHERE dedupe_key = ?').get(key); return r ? { ...r, meta: JSON.parse(r.meta ?? '{}') } : null; },
    receipt: (ev) => db.db.prepare('SELECT notify_status FROM enquiry_receipts WHERE event_id = ?').get(ev)?.notify_status ?? null,
    outbox: () => db.db.prepare('SELECT * FROM wa_outbox').all().map((r) => ({ ...r })),
  };
}

let seq = 0;
/** A lead row, stored. Example names and +966 50 000 000x numbers only. */
function addLead(h, over = {}) {
  seq += 1;
  const id = over.lead_id ?? `LEAD-20261129-${String(seq).padStart(8, '0')}`;
  const phone = over.phone_e164 ?? `9665000001${String(seq % 100).padStart(2, '0')}`;
  h.db.insertLead({
    lead_id: id, created: NOW - DAY, updated: NOW - DAY, phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`, name: 'Sara Example',
    channel: 'whatsapp', source: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY, ...over,
  });
  return h.db.getLead(id);
}
const receiptFor = (h, ev, leadId) => h.db.db.prepare('INSERT INTO enquiry_receipts(event_id,payload_hash,lead_id,created) VALUES(?,?,?,?)').run(ev, 'h', leadId, NOW);
const leadLink = (id) => `Lead: ${API}/dashboard/leads/${encodeURIComponent(id)}`;
const clientSays = (h, lead, key, ts, text) => h.inbox.upsertMessage({ key_id: key, lead_id: lead.lead_id, jid: lead.wa_jid, direction: 'in', sender_kind: 'client', text, ts });
const danaAnswered = (h, lead, sendId, coversTs) => h.inbox.insertOutbox({ send_id: sendId, lead_id: lead.lead_id, jid: lead.wa_jid, text: 'Of course.', sender_kind: 'dana', covers_ts: coversTs });

/* ---------------- 1. the ledger ---------------- */

test('the constants are the design\'s numbers', () => {
  assert.equal(FORM_NOTIFY_WAIT_MS, 4000);
  assert.equal(MIN_GAP_MS, 25_000);
  assert.equal(MERGE_WINDOW_MS, 2 * MIN);
  assert.equal(MAX_PER_DAY, 40);
  assert.equal(MAX_NOTE_CHARS, 3500);
  assert.deepEqual(HEADERS, {
    new_client: '*Bona — new enquiry*', handover: '*Bona — hand-over*', booking: '*Bona — viewing booked*', stopped: '*Bona — assistant stopped*',
    summary: '*Bona — daily summary*', command: '*Bona — test mode*', alert: '*Bona — alert*', mail: '*Bona — email*',
  });
  // wa-poller's OWN_NOTE_RE (DESIGN §7.1) knows every header.
  const ownNote = /^\*?Bona — (new enquiry|hand-over|viewing booked|assistant stopped|daily summary|test mode|alert|email)/;
  for (const header of Object.values(HEADERS)) assert.match(header, ownNote);
});

test('ledger: the same key twice is one row; a WhatsApp new client is due at min(first answer + 20 s, first message + 3 min)', async () => {
  const h = harness();
  const a = addLead(h, { name: 'Sara Example' });
  const b = addLead(h, { name: 'Omar Example' });
  await h.notes.leadEvent(a, { why: 'wa', created: true, ts: NOW });
  await h.notes.leadEvent(a, { why: 'wa', created: true, ts: NOW });
  await h.notes.leadEvent(b, { why: 'wa', created: true, ts: NOW });
  assert.equal(h.rows().filter((r) => r.dedupe_key === `new:${a.lead_id}`).length, 1, 'one row per key, ever');
  assert.equal(h.row(`new:${a.lead_id}`).due_ts, NOW + 3 * MIN);
  assert.equal(h.row(`new:${a.lead_id}`).status, 'queued');
  assert.equal(h.sent.length, 0, 'nothing goes at once');

  h.at(NOW + 30_000);
  danaAnswered(h, a, 'SND-ANSWER-A', NOW);
  h.at(NOW + 49_999);
  await h.notes.tick();
  assert.equal(h.sent.length, 0, 'answered at +30 s: due at +50 s, not before');
  h.at(NOW + 50_000);
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /Name: Sara Example/);
  assert.doesNotMatch(h.sent[0], /Omar Example/, 'the other is due at +3 min, outside the 2-min merge window');

  h.at(NOW + 3 * MIN - 1);
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  h.at(NOW + 3 * MIN);
  await h.notes.tick();
  assert.equal(h.sent.length, 2, 'no answer: at first message + 3 min');
  assert.match(h.sent[1], /Name: Omar Example/);
  await h.notes.leadEvent(a, { why: 'wa', created: true, ts: NOW });
  h.at(NOW + 10 * MIN);
  await h.notes.tick();
  assert.equal(h.sent.length, 2, 'a sent key is never queued again');
});

/* ---------------- 2. merging and pacing ---------------- */

test('merging: notes due within 2 min go out as ONE message, the first row sent and the others merged into it', async () => {
  const h = harness();
  const a = addLead(h, { name: 'Sara Example' });
  const b = addLead(h, { name: 'Omar Example' });
  const c = addLead(h, { name: 'Lina Example' });
  await h.notes.leadEvent(a, { why: 'wa', created: true, ts: NOW - 3 * MIN });         // due now
  await h.notes.leadEvent(b, { why: 'wa', created: true, ts: NOW - 3 * MIN + 90_000 }); // due in 90 s
  await h.notes.leadEvent(c, { why: 'wa', created: true, ts: NOW - 30_000 });           // due in 150 s
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  const parts = h.sent[0].split('\n\n');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^\*Bona — new enquiry\*\nName: Sara Example/);
  assert.match(parts[1], /^\*Bona — new enquiry\*\nName: Omar Example/);
  const ra = h.row(`new:${a.lead_id}`);
  const rb = h.row(`new:${b.lead_id}`);
  assert.equal(ra.status, 'sent');
  assert.equal(rb.status, 'merged');
  assert.ok(ra.send_id && ra.send_id === rb.send_id, 'one send');
  assert.equal(h.row(`new:${c.lead_id}`).status, 'queued');
  h.at(NOW + 150_000);
  await h.notes.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /Name: Lina Example/);
});

test('merging stops at 3,500 characters: what does not fit waits for the next send', async () => {
  const h = harness();
  const long = 'x'.repeat(1400);
  const leads = [1, 2, 3].map((i) => addLead(h, { name: `Client ${i} Example`, notes: long }));
  for (const l of leads) await h.notes.leadEvent(l, { why: 'wa', created: true, ts: NOW - 3 * MIN });
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0].length <= MAX_NOTE_CHARS);
  assert.equal(h.sent[0].split('\n\n').length, 2);
  assert.equal(h.row(`new:${leads[2].lead_id}`).status, 'queued');
  h.at(NOW + MIN_GAP_MS);
  await h.notes.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /Client 3 Example/);
});

test('one note longer than 3,500 characters is cut before its tail, which keeps the Lead line', async () => {
  const h = harness();
  const lead = addLead(h, { name: 'Long Example', notes: 'z'.repeat(5000) });
  await h.notes.leadEvent(lead, { why: 'wa', created: true, ts: NOW - 3 * MIN });
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0].length <= MAX_NOTE_CHARS, String(h.sent[0].length));
  assert.ok(h.sent[0].endsWith(`…\n${leadLink(lead.lead_id)}`));
});

test('pacing: at least 25 s between two sends, restart-safe (the gap is read from the ledger)', async () => {
  const h = harness();
  h.notes.alert('old_out_wrote', { candId: 'CND-0001' });
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  h.at(NOW + 5_000);
  h.notes.alert('old_out_wrote', { candId: 'CND-0002' });
  await h.notes.tick();
  h.at(NOW + MIN_GAP_MS - 1);
  await h.notes.tick();
  assert.equal(h.sent.length, 1, 'the gap holds');
  const restarted = createOwnerNotes({ ...h.deps });
  await restarted.tick();
  assert.equal(h.sent.length, 1, 'a restart does not hand out a fresh gap');
  h.at(NOW + MIN_GAP_MS);
  await restarted.tick();
  assert.equal(h.sent.length, 2);
});

test('at most 40 sends a day: the overflow is held for the summary (merged, never sent); summary and command replies still go', async () => {
  const h = harness();
  h.team.setSetting('owner_as_client', '1');
  for (let i = 0; i < MAX_PER_DAY; i += 1) {
    h.at(NOW + i * MIN_GAP_MS);
    h.notes.alert('old_out_wrote', { candId: `CND-${String(i).padStart(4, '0')}` });
    await h.notes.tick();
  }
  assert.equal(h.sent.length, MAX_PER_DAY);
  h.at(NOW + MAX_PER_DAY * MIN_GAP_MS);
  h.notes.alert('old_out_wrote', { candId: 'CND-OVER' });
  await h.notes.tick();
  assert.equal(h.sent.length, MAX_PER_DAY, 'the 41st is not sent');
  const over = h.rows().find((r) => r.meta.candId === 'CND-OVER');
  assert.equal(over.status, 'merged');
  assert.ok(over.meta.over, 'held for the summary');
  assert.equal(over.send_id, null);
  h.notes.command('REC-0001', '*Bona — test mode* ON');
  await h.notes.tick();
  assert.equal(h.sent.length, MAX_PER_DAY + 1, 'a command reply is not counted out');
  assert.equal(h.sent.at(-1), '*Bona — test mode* ON');
});

test('while no summary can carry the overflow (switches off, before go-live), the 40-a-day limit holds nothing back', async () => {
  const h = harness();
  for (let i = 0; i <= MAX_PER_DAY; i += 1) {
    h.at(NOW + i * MIN_GAP_MS);
    h.notes.alert('old_out_wrote', { candId: `CND-${String(i).padStart(4, '0')}` });
    await h.notes.tick();
  }
  assert.equal(h.sent.length, MAX_PER_DAY + 1, 'nothing is lost into a summary that is not sent');
});

/* ---------------- 3. switches ---------------- */

test('Sending off: the note stays queued (no outbox row, no call) and goes once Sending is back on', async () => {
  const h = harness({ env: ENV });
  const lead = addLead(h, { channel: 'form', match_method: 'form' });
  receiptFor(h, 'ev-sending-off-01', lead.lead_id);
  h.team.setSetting('sending_enabled', '0');
  await h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-sending-off-01' });
  assert.equal(h.row(`new:${lead.lead_id}`).status, 'queued');
  assert.equal(h.receipt('ev-sending-off-01'), 'pending');
  assert.equal(h.evo.length, 0);
  assert.deepEqual(h.outbox(), [], 'a held note is never an outbox row');
  assert.equal(h.inbox.markStalePending(NOW + DAY), 0, 'so the stale-pending upkeep cannot touch it');
  h.at(NOW + 10_000);
  await h.notes.tick();
  assert.equal(h.sent.length, 1, 'not asked again while Sending is off');
  h.team.setSetting('sending_enabled', '1');
  h.at(NOW + 11_000);
  await h.notes.tick();
  assert.equal(h.evo.length, 1);
  assert.equal(h.row(`new:${lead.lead_id}`).status, 'sent');
  assert.equal(h.receipt('ev-sending-off-01'), 'sent', 'a later send moves pending to sent');
  const [row] = h.outbox();
  assert.equal(row.sender_kind, 'note');
  assert.equal(row.text, null);
  assert.equal(row.lead_id, null);
  assert.equal(h.row(`new:${lead.lead_id}`).send_id, row.send_id, 'the ledger names the outbox row');
});

test('owner_notes 0: a new note is dropped at once, and a queued one at the next tick; health says not enabled', async () => {
  const h = harness();
  const a = addLead(h);
  const b = addLead(h);
  await h.notes.leadEvent(a, { why: 'wa', created: true, ts: NOW });
  h.team.setSetting('owner_notes', '0');
  await h.notes.leadEvent(b, { why: 'wa', created: true, ts: NOW });
  assert.equal(h.row(`new:${b.lead_id}`).status, 'dropped');
  h.at(NOW + 5 * MIN);
  await h.notes.tick();
  assert.equal(h.row(`new:${a.lead_id}`).status, 'dropped');
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.notes.health(), { enabled: false, ok: true });
  h.team.setSetting('owner_notes', '1');
  await h.notes.tick();
  assert.equal(h.sent.length, 0, 'dropped means dropped');
});

test('BONA_WA_NOTIFY=0 is a definite failure: tried, retried once 2 min later, then failed; nothing reaches Evolution', async () => {
  const h = harness({ env: { ...ENV, BONA_WA_NOTIFY: '0' } });
  h.notes.alert('breaker');
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.row(`al:breaker:${Math.floor(NOW / HOUR)}`).status, 'queued');
  h.at(NOW + 2 * MIN - 1);
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  h.at(NOW + 2 * MIN);
  await h.notes.tick();
  assert.equal(h.sent.length, 2, 'retried once');
  assert.equal(h.row(`al:breaker:${Math.floor(NOW / HOUR)}`).status, 'failed');
  h.at(NOW + HOUR);
  await h.notes.tick();
  assert.equal(h.sent.length, 2, 'never a third try');
  assert.equal(h.evo.length, 0);
});

/* ---------------- 4. sending ---------------- */

test('an uncertain send is never retried', async () => {
  const h = harness();
  h.answers.push({ ok: false, error: 'timeout', uncertain: true });
  h.notes.alert('brain_bug');
  await h.notes.tick();
  assert.equal(h.rows()[0].status, 'uncertain');
  for (const t of [NOW + 3 * MIN, NOW + HOUR]) { h.at(t); await h.notes.tick(); }
  assert.equal(h.sent.length, 1);
});

test('a transport that throws, or gives no answer at all, is uncertain too (it may have gone)', async () => {
  const thrown = harness({ sendNote: async () => { throw new Error('socket hang up'); } });
  thrown.notes.alert('brain_bug');
  await thrown.notes.tick();
  assert.equal(thrown.rows()[0].status, 'uncertain');
  for (const error of ['network', 'http_502', 'no_ack']) {
    const h = harness();
    h.answers.push({ ok: false, error });
    h.notes.alert('brain_bug');
    await h.notes.tick();
    assert.equal(h.rows()[0].status, 'uncertain', error);
  }
});

test('a restart in the middle of the queue resumes with no duplicate', async () => {
  let calls = 0;
  const h = harness({ sendNote: () => { calls += 1; return new Promise(() => {}); } });
  const lead = addLead(h, { name: 'Omar Example' });
  h.notes.alert('brain_bug');
  await h.notes.leadEvent(lead, { why: 'wa', created: true, ts: NOW });
  const inFlight = h.notes.tick();
  void inFlight;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(h.row(`al:brain_bug:${Math.floor(NOW / HOUR)}`).status, 'uncertain', 'marked before the call');
  h.notes.stop();

  const after = [];
  const restarted = createOwnerNotes({ ...h.deps, sendNote: async (t) => { after.push(t); return { ok: true }; } });
  h.at(NOW + 3 * MIN);
  await restarted.tick();
  assert.equal(after.length, 1);
  assert.match(after[0], /^\*Bona — new enquiry\*\nName: Omar Example/);
  assert.doesNotMatch(after[0], /alert/, 'the interrupted alert is not sent again');
  assert.equal(h.row(`new:${lead.lead_id}`).status, 'sent');
});

test('a note that cannot be drawn is dropped (and logged by kind); the notes behind it still go', async () => {
  const h = harness({ inventory: { find: () => { throw new Error('listings unreadable'); } } });
  const lead = addLead(h, { name: 'Sara Example' });
  h.autoIds.add(lead.lead_id);
  h.db.db.prepare(`INSERT INTO viewing_bookings (booking_id, lead_id, task_id, listing_id, start_ts, end_ts, event_id, status, client_told, created, updated)
                   VALUES ('BK-POISON', ?, NULL, 'BONA-W012', ?, ?, 'evpoison', 'booked', 1, ?, ?)`).run(lead.lead_id, NOW + DAY, NOW + DAY + HOUR, NOW, NOW);
  h.notes.booking('BK-POISON', { told: true });
  h.notes.alert('breaker');
  const summaryOf = h.notes;
  // A summary row whose render throws (here: the stats read fails).
  h.team.setSetting('owner_as_client', '1');
  summaryOf.summary({ day: '2026-11-29' });
  h.db.db.exec('ALTER TABLE viewing_bookings RENAME TO viewing_bookings_gone');
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^\*Bona — alert\*\n/);
  assert.equal(h.row('sum:2026-11-29').status, 'dropped');
  assert.ok(h.logs.some((e) => e.evt === 'notes.render_failed' && e.kind === 'summary'));
  assert.doesNotMatch(JSON.stringify(h.logs), /listings unreadable|Sara/);
});

test('a thrown transport error is logged by name, and its message only when it is short and carries no number', async () => {
  const h = harness({ sendNote: async () => { throw new Error('connect refused by 966500000001'); } });
  const lead = addLead(h, { channel: 'form', match_method: 'form' });
  receiptFor(h, 'ev-thrown-00001', lead.lead_id);
  await h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-thrown-00001' });
  assert.equal(h.receipt('ev-thrown-00001'), 'uncertain');
  assert.deepEqual(h.logs.find((e) => e.evt === 'lead.wa_error'), { evt: 'lead.wa_error', id: lead.lead_id, error: 'error' });
  assert.doesNotMatch(JSON.stringify(h.logs), /966500000001/);
});

/* ---------------- 5. rendered at send time ---------------- */

test('a note is rendered when it is sent: a name changed after it was queued shows the new name; no note text is stored', async () => {
  const h = harness();
  const lead = addLead(h, { name: 'Sara Example' });
  await h.notes.leadEvent(lead, { why: 'wa', created: true, ts: NOW });
  h.db.updateLead(lead.lead_id, { name: 'Sara Renamed' });
  h.at(NOW + 3 * MIN);
  await h.notes.tick();
  assert.match(h.sent[0], /Name: Sara Renamed/);
  assert.doesNotMatch(JSON.stringify(h.rows()), /Sara|966500/, 'the ledger holds codes only');
});

/* ---------------- 6. new_client content ---------------- */

test("new client outside auto mode: today's leadNote lines byte for byte, then the Lead line only", async () => {
  const h = harness();
  const lead = addLead(h, { channel: 'form', match_method: 'form', interest: 'villa', district: 'Al Rawdah', budget: '3M', listing_id: 'BONA-W012' });
  clientSays(h, lead, 'IN-0001', NOW - 1000, 'Hello, I want a villa');
  receiptFor(h, 'ev-form-00000001', lead.lead_id);
  await h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-form-00000001' });
  assert.deepEqual(h.sent, [`${leadNote(h.db.getLead(lead.lead_id), { siteUrl: SITE })}\n${leadLink(lead.lead_id)}`]);
  assert.ok(h.sent[0].startsWith('*Bona — new enquiry*\n'), 'the header, verbatim');
  assert.doesNotMatch(h.sent[0], /Wants:|First message:|AI:/);
});

test('new client in auto mode: Wants, First message (80 chars), AI: answered in …, then the Lead line', async () => {
  const lead0 = { interest: 'villa', district: 'Al Rawdah', budget: '3M', listing_id: 'BONA-W012' };
  const h = harness();
  const lead = addLead(h, lead0);
  h.autoIds.add(lead.lead_id);
  const first = 'Hello, is the villa in Al Rawdah still available? I would like to know the size and the payment plan please.';
  clientSays(h, lead, 'IN-0002', NOW, first);
  await h.notes.leadEvent(lead, { why: 'joined', created: false, ts: NOW });
  h.at(NOW + 19_000);
  danaAnswered(h, lead, 'SND-ANSWER-0002', NOW);
  h.at(NOW + 39_000);
  await h.notes.tick();
  const quoted = `${[...first].slice(0, 80).join('')}…`;
  assert.equal(h.sent[0], [
    leadNote(h.db.getLead(lead.lead_id), { siteUrl: SITE }),
    'Wants: villa · Al Rawdah · 3M · W012',
    `First message: "${quoted}"`,
    'AI: answered in 19 s',
    leadLink(lead.lead_id),
  ].join('\n'));

  const quiet = addLead(h, { name: 'Lina Example' });
  h.autoIds.add(quiet.lead_id);
  clientSays(h, quiet, 'IN-0003', NOW + 40_000, 'Salam');
  h.db.updateLead(quiet.lead_id, { needs_human: 1 });
  await h.notes.leadEvent(quiet, { why: 'joined', ts: NOW + 40_000 });
  h.at(NOW + 40_000 + 3 * MIN);
  await h.notes.tick();
  assert.match(h.sent[1], /\nWants: not said yet\nFirst message: "Salam"\nAI: not answered: handed to you\n/);
});

test('a merge (created false) sends nothing, for any channel; an own-number join always counts (a returning unsure lead, G13)', async () => {
  const h = harness();
  const lead = addLead(h);
  receiptFor(h, 'ev-merge-0000001', lead.lead_id);
  for (const why of ['form', 'concierge', 'wa', 'email']) await h.notes.leadEvent(lead, { why, created: false, eventId: 'ev-merge-0000001' });
  assert.deepEqual(h.rows(), []);
  assert.equal(h.receipt('ev-merge-0000001'), 'skipped', 'the receipt says why no note went');
  await h.notes.leadEvent(lead, { why: 'joined', created: false, ts: NOW });
  assert.equal(h.rows().length, 1);
});

/* ---------------- 7. hand-overs ---------------- */

test('hand-over: 0→1 alerts; the same kind in the same 10-min bucket does not; 11 min later it does; another kind does; a repeat while needs_human=1 does', async () => {
  const h = harness();
  const lead = addLead(h, { name: 'Sara Example' });
  h.autoIds.add(lead.lead_id);
  clientSays(h, lead, 'IN-HO-1', NOW - 5000, 'Can I pay 5.5M instead?');
  assert.equal(h.notes.handover(lead, { kind: 'offer', coversTs: NOW - 5000, words: 'MODEL SAID: the owner will accept' }).queued, true);
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0], [
    '*Bona — hand-over*', 'Sara Example (WhatsApp)', 'Reason: the client wants to make an offer', 'Last message: "Can I pay 5.5M instead?"',
    'The AI keeps answering simple questions until someone writes.', leadLink(lead.lead_id),
  ].join('\n'));
  assert.doesNotMatch(h.sent[0], /MODEL SAID|accept/, "the model's words never appear");

  h.at(NOW + 2 * MIN);
  assert.equal(h.notes.handover(lead, { kind: 'offer' }).queued, false, 'same kind, same bucket');
  h.at(NOW + 11 * MIN);
  assert.equal(h.notes.handover(lead, { kind: 'offer' }).queued, true, 'same kind, 11 min later');
  await h.notes.tick();
  h.at(NOW + 12 * MIN);
  assert.equal(h.notes.handover(lead, { kind: 'complaint' }).queued, true, 'another kind');
  await h.notes.tick();
  h.db.updateLead(lead.lead_id, { needs_human: 1 });
  h.at(NOW + 22 * MIN);
  assert.equal(h.notes.handover(lead, { kind: 'complaint' }).queued, true, 'a repeat while needs_human=1 still alerts');
  await h.notes.tick();
  assert.equal(h.sent.length, 4);
  assert.match(h.sent[2], /Reason: the client has a complaint/);
  assert.equal(h.notes.handover(lead, { kind: 'whatever <b>' }).queued, true);
  h.at(NOW + 23 * MIN);
  await h.notes.tick();
  assert.match(h.sent[4], /Reason: the client needs a person/, 'an unknown kind is "other"');
  assert.match(h.row(`ho:${lead.lead_id}:other:${Math.floor((NOW + 22 * MIN) / (10 * MIN))}`)?.dedupe_key ?? '', /:other:/);
});

test('hand-over reasons come from the code: system kinds and a reason code (brain_refusal) have their own words', async () => {
  const h = harness();
  const lead = addLead(h);
  h.autoIds.add(lead.lead_id);
  const cases = [
    [{ kind: 'cap_day' }, "the assistant reached today's answer limit"],
    [{ kind: 'missed' }, 'a message waited more than 2 hours without an answer'],
    [{ kind: 'send_failed' }, "WhatsApp did not take the assistant's messages"],
    [{ kind: 'price_guard' }, 'the answer named a price that is not published, so it was not sent'],
    [{ kind: 'other', reason: 'brain_refusal' }, 'the AI would not answer this message'],
  ];
  for (const [i, [o, words]] of cases.entries()) {
    h.at(NOW + i * MIN_GAP_MS);
    assert.equal(h.notes.handover(lead, o).queued, true, JSON.stringify(o));
    await h.notes.tick();
    assert.match(h.sent.at(-1), new RegExp(`Reason: ${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

/* ---------------- 8. the other kinds ---------------- */

function bookingFixture(h, lead, { id = 'BK-0001', start = Date.UTC(2026, 10, 29, 11, 0, 0) } = {}) {
  h.db.db.prepare(`INSERT INTO viewing_bookings (booking_id, lead_id, task_id, listing_id, start_ts, end_ts, event_id, status, client_told, created, updated)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, lead.lead_id, null, 'BONA-W012', start, start + HOUR, `ev${id.toLowerCase().replace(/[^a-z0-9]/g, '')}`, 'booked', 1, NOW, NOW);
  return id;
}
const inventory = (precision) => ({ find: (id) => (id === 'BONA-W012' ? { id, title: { en: 'Marina Tower Villa', ar: 'فيلا' }, mapPrecision: precision } : null) });

test('booking: told (with the meeting point by the pin) and untold; outside auto mode nothing', async () => {
  const h = harness({ inventory: inventory('exact') });
  const lead = addLead(h, { name: 'Sara Example', phone_e164: '966500000011' });
  const id = bookingFixture(h, lead);
  assert.equal(h.notes.booking(id, { told: true }).queued, false, 'not in auto mode: no note');
  h.autoIds.add(lead.lead_id);
  assert.equal(h.notes.booking(id, { told: true }).queued, true);
  await h.notes.tick();
  assert.equal(h.sent[0], [
    '*Bona — viewing booked*', 'Sun 29 Nov 14:00-15:00', 'BONA-W012 · Marina Tower Villa', 'Sara Example · +966500000011',
    'Meeting point: map link sent', leadLink(lead.lead_id),
  ].join('\n'));
  assert.equal(h.row(`bk:${id}`).status, 'sent');

  const d = harness({ inventory: inventory('district') });
  const dl = addLead(d, { name: 'Omar Example' });
  d.autoIds.add(dl.lead_id);
  const did = bookingFixture(d, dl);
  assert.equal(d.notes.booking(did, { told: false }).queued, true);
  await d.notes.tick();
  assert.match(d.sent[0], /^\*Bona — viewing booked\*\n/);
  assert.match(d.sent[0], /\nMeeting point: NEEDED \(district only\)\n/);
  assert.match(d.sent[0], /\nBooked, but the client was NOT told; please write to them\.\n/);
  assert.ok(d.row(`bk-untold:${did}`));
  assert.equal(d.notes.booking('BK-NONE', { told: true }).queued, false, 'an unknown booking');
});

test('stopped: the header, the reason, the link, and never a quote', async () => {
  const h = harness();
  const lead = addLead(h, { name: 'Sara Example' });
  h.autoIds.add(lead.lead_id);
  clientSays(h, lead, 'IN-STOP-1', NOW - 1000, 'delete my data please');
  assert.equal(h.notes.stopped(lead, 'deletion').queued, true);
  await h.notes.tick();
  assert.equal(h.sent[0], ['*Bona — assistant stopped*', 'Sara Example (WhatsApp)', 'Reason: the client asked for their data to be deleted', leadLink(lead.lead_id)].join('\n'));
  assert.doesNotMatch(h.sent[0], /delete my data/);
  assert.equal(h.rows()[0].dedupe_key, `stop:${lead.lead_id}:${NOW}`);
});

test('alerts: a fixed sentence per code, one per code an hour; link-down and identity never go by WhatsApp; unknown codes are refused', async () => {
  const h = harness();
  const hour = Math.floor(NOW / HOUR);
  assert.deepEqual(h.notes.alert('link_down'), { queued: false, reason: 'push_only' });
  assert.deepEqual(h.notes.alert('identity'), { queued: false, reason: 'push_only' });
  assert.deepEqual(h.notes.alert('rm -rf'), { queued: false, reason: 'unknown_code' });
  const want = {
    breaker: /3 of its messages failed within 30 minutes/,
    greeting_away: /greeting or away message/,
    turns_month: /passed 80% of this month's answer alert level/,
    gcal: /The calendar is not answering \(code: auth\)\./,
    mail: /The mailbox is not answering \(code: timeout\)\./,
    brain_bug: /3 or more unusable answers in the last hour/,
  };
  const meta = { turns_month: { level: '80' }, gcal: { code: 'auth' }, mail: { code: 'timeout' } };
  let i = 0;
  for (const [code, re] of Object.entries(want)) {
    h.at(NOW + i * MIN_GAP_MS);
    i += 1;
    assert.equal(h.notes.alert(code, meta[code] ?? {}).queued, true, code);
    assert.equal(h.notes.alert(code, meta[code] ?? {}).queued, false, `${code}: once an hour`);
    await h.notes.tick();
    assert.match(h.sent.at(-1), /^\*Bona — alert\*\n/);
    assert.match(h.sent.at(-1), re, code);
  }
  assert.ok(h.row(`al:breaker:${hour}`));
  h.at(NOW + HOUR);
  assert.equal(h.notes.alert('breaker').queued, true, 'the next hour, again');
  h.at(NOW + HOUR + 30_000);
  assert.equal(h.notes.alert('gcal', { code: 'Bearer abc.def' }).queued, true);
  await h.notes.tick();
  assert.doesNotMatch(h.sent.at(-1), /Bearer/, 'only an enum code is ever printed');
  for (const code of ALERT_CODES) assert.match(code, /^[a-z_]+$/);
});

test('old_out_wrote: a fixed sentence and the Chats to check link, no name; once a day per chat; purged with its lead', async () => {
  const h = harness();
  const lead = addLead(h, { name: 'Sara Example', inbox_state: 'out' });
  assert.equal(h.notes.alert('old_out_wrote', { leadId: lead.lead_id }).queued, true);
  assert.equal(h.notes.alert('old_out_wrote', { leadId: lead.lead_id }).queued, false);
  await h.notes.tick();
  assert.equal(h.sent[0], [
    '*Bona — alert*', 'A chat you marked Not a client before the move wrote to Bona; the AI does not answer it.',
    `Chats to check: ${API}/dashboard/inbox?tab=unsure`,
  ].join('\n'));
  assert.doesNotMatch(h.sent[0], /Sara|966500/);
  assert.equal(h.rows()[0].dedupe_key, `al:old_out_wrote:${lead.lead_id}:2026-11-29`);
  h.notes.onPurge(lead.lead_id);
  assert.deepEqual(h.rows(), []);
});

test('the brain codes: brain_out (quota names Lisa\'s voice and the phone line), brain_spend 80/100/stop, brain_bug', async () => {
  const h = harness();
  const cases = [
    ['brain_out', { code: 'quota' }, "OpenAI credit ran out. Lisa's voice and the Bona phone line use the same balance and are affected too. Top up at platform.openai.com."],
    ['brain_spend', { level: '80' }, "This OpenAI balance also pays Lisa's voice, the Bona phone line and TK's AI fallback; check it."],
    ['brain_spend', { level: '100' }, 'passed 100% of'],
    ['brain_spend', { level: 'stop' }, 'The AI spend stop was reached'],
  ];
  for (const [i, [code, meta, words]] of cases.entries()) {
    h.at(NOW + i * MIN_GAP_MS);
    assert.equal(h.notes.alert(code, meta).queued, true, `${code} ${JSON.stringify(meta)}`);
    await h.notes.tick();
    assert.ok(h.sent.at(-1).includes(words), `${code}: ${h.sent.at(-1)}`);
  }
  for (const [code, sentence] of [['auth', /refused the Bona key/], ['down', /is not answering/], ['budget', /spend stop was reached/]]) {
    const one = harness();
    one.notes.alert('brain_out', { code });
    await one.notes.tick();
    assert.match(one.sent[0], sentence, code);
  }
});

test('an AI outage: 20 chats handed over with kind brain in one hour make ONE note, the brain_out alert listing them', async () => {
  const h = harness();
  const leads = Array.from({ length: 20 }, (_, i) => addLead(h, { name: `Client ${String(i + 1).padStart(2, '0')} Example` }));
  for (const l of leads) h.autoIds.add(l.lead_id);
  h.notes.alert('brain_out', { code: 'quota' });
  for (const [i, l] of leads.entries()) {
    h.at(NOW + i * 1000);
    assert.equal(h.notes.handover(l, { kind: 'brain' }).queued, true);
    assert.equal(h.notes.handover(l, { kind: 'brain' }).queued, false, 'an hour bucket per chat');
  }
  h.at(NOW + 30_000);
  await h.notes.tick();
  h.at(NOW + 30 * MIN);
  await h.notes.tick();
  assert.equal(h.sent.length, 1, 'one note, not 20');
  assert.match(h.sent[0], /^\*Bona — alert\*\nOpenAI credit ran out\./);
  assert.match(h.sent[0], /\nChats waiting: 20 → https:\/\/api\.bona-real-estate\.com\/dashboard\/inbox\?filter=needs_human/);
  assert.match(h.sent[0], /Client 01 Example \(WhatsApp\)/);
  assert.match(h.sent[0], /and 10 more/);
  assert.ok(h.rows().filter((r) => r.kind === 'handover').every((r) => r.status === 'merged'));

  // Later in the same hour: the hour's note went, so a new chat waits for the next hour's.
  const late = addLead(h, { name: 'Late Example' });
  h.autoIds.add(late.lead_id);
  h.at(NOW + 40 * MIN);
  assert.equal(h.notes.handover(late, { kind: 'brain' }).queued, true);
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  h.at(Math.ceil((NOW + 1) / HOUR) * HOUR);
  await h.notes.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /The AI service \(OpenAI\) is not answering/);
  assert.match(h.sent[1], /Late Example \(WhatsApp\)/);
});

test('mail: sender and subject read at send time (60 chars), what to do, the dashboard link; never stored in the ledger', async () => {
  const h = harness();
  h.notes.mail({ messageId: 'M-0001', what: 'possible_client' });
  await h.notes.tick();
  assert.equal(h.sent[0], ['*Bona — email*', 'Possibly a client: the AI did not answer it; please check.', `Email: ${API}/dashboard/email`].join('\n'),
    'before the mail tables exist (v9): no sender, no subject');
  // The v9 table (PR-C2), as far as this note reads it.
  h.db.db.exec('CREATE TABLE mail_seen (message_id TEXT PRIMARY KEY, from_addr TEXT, subject_short TEXT)');
  h.db.db.prepare('INSERT INTO mail_seen VALUES (?,?,?)').run('M-0002', 'client@example.com', `Villa in Al Rawdah ${'y'.repeat(80)}`);
  h.at(NOW + MIN_GAP_MS);
  assert.equal(h.notes.mail({ messageId: 'M-0002', what: 'stop' }).queued, true);
  assert.equal(h.notes.mail({ messageId: 'M-0002', what: 'stop' }).queued, false);
  await h.notes.tick();
  const lines = h.sent[1].split('\n');
  assert.equal(lines[1], 'From: client@example.com');
  assert.equal(lines[2], `Subject: ${[...`Villa in Al Rawdah ${'y'.repeat(80)}`].slice(0, 60).join('')}…`);
  assert.equal(lines[3], 'The sender asked us to stop emailing them.');
  assert.doesNotMatch(JSON.stringify(h.rows()), /example\.com|Rawdah/);
});

test('command replies: in memory only, the header added when missing; a restart drops one it no longer has', async () => {
  const h = harness();
  h.notes.command('REC-0001', '*Bona — test mode* ON');
  await h.notes.tick();
  h.at(NOW + MIN_GAP_MS);
  h.notes.command('REC-0002', 'Status: test mode off · link ✓ · #dana status');
  await h.notes.tick();
  assert.deepEqual(h.sent, ['*Bona — test mode* ON', '*Bona — test mode*\nStatus: test mode off · link ✓ · #dana status']);
  h.notes.command('REC-0003', 'queued, then the process restarts');
  const restarted = createOwnerNotes({ ...h.deps });
  h.at(NOW + 2 * MIN_GAP_MS);
  await restarted.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.row('cmd:REC-0003').status, 'dropped');
  assert.doesNotMatch(JSON.stringify(h.rows()), /queued, then/);
});

test('no rendered note names the assistant "Dana" (only a #dana command echo may)', async () => {
  const h = harness({ inventory: inventory('exact') });
  const lead = addLead(h, { name: 'Sara Example', interest: 'villa' });
  h.autoIds.add(lead.lead_id);
  clientSays(h, lead, 'IN-ND-1', NOW - 1000, 'hi');
  await h.notes.leadEvent(lead, { why: 'joined', ts: NOW - 3 * MIN });
  h.notes.handover(lead, { kind: 'viewing' });
  h.notes.handover(lead, { kind: 'brain' });
  h.notes.stopped(lead, 'stop');
  h.notes.booking(bookingFixture(h, lead), { told: false });
  for (const code of ALERT_CODES) h.notes.alert(code, { code: 'quota', level: 'stop', candId: 'CND-ND' });
  h.notes.mail({ messageId: 'M-ND', what: 'over_cap' });
  for (let i = 0; i < 40; i += 1) { h.at(NOW + i * MIN_GAP_MS); await h.notes.tick(); }
  const all = h.sent.join('\n\n');
  for (const header of ['new enquiry', 'hand-over', 'assistant stopped', 'viewing booked', 'alert', 'email']) assert.ok(all.includes(`*Bona — ${header}*`), header);
  assert.deepEqual(h.rows().filter((r) => r.status === 'queued'), [], 'everything went');
  assert.doesNotMatch(all, /Dana|دانة/i);
  h.notes.command('REC-ND', '#dana status: test mode off');
  h.at(NOW + 41 * MIN_GAP_MS);
  await h.notes.tick();
  assert.match(h.sent.at(-1), /#dana status/, 'the command echo is allowed');
});

/* ---------------- 9. purge and health ---------------- */

test('purge: the onPurge subscription deletes the lead\'s rows, inside the purge (the store\'s own seam)', async () => {
  const db = openDb(':memory:');
  let notes = null;
  const inbox = createInboxStore(db, { now: () => NOW, onPurge: (leadId) => notes.onPurge(leadId) });
  const team = createTeam(db, { now: () => NOW });
  notes = createOwnerNotes({ db, siteUrl: SITE, publicApi: API, sendNote: async () => ({ ok: true }), team, inbox, ownerTest: { autoMode: () => true }, now: () => NOW, setTimer: null });
  db.insertLead({ lead_id: 'LEAD-P1', created: NOW, updated: NOW, phone_e164: '966500000021', wa_jid: '966500000021@s.whatsapp.net', name: 'Sara Example', channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
  db.insertLead({ lead_id: 'LEAD-P2', created: NOW, updated: NOW, phone_e164: '966500000022', wa_jid: '966500000022@s.whatsapp.net', name: 'Omar Example', channel: 'whatsapp', stage: 'new', inbox_state: 'in' });
  await notes.leadEvent(db.getLead('LEAD-P1'), { why: 'wa', created: true, ts: NOW });
  notes.handover(db.getLead('LEAD-P1'), { kind: 'offer' });
  await notes.leadEvent(db.getLead('LEAD-P2'), { why: 'wa', created: true, ts: NOW });
  inbox.leaveInbox('LEAD-P1');
  const left = db.db.prepare('SELECT lead_id FROM owner_notes').all().map((r) => r.lead_id);
  assert.deepEqual(left, ['LEAD-P2']);
  db.close();
});

test('health: enabled follows owner_notes; ok is false once a queued note is 15 min overdue; booleans only', async () => {
  const h = harness({ env: ENV });
  assert.deepEqual(h.notes.health(), { enabled: true, ok: true });
  h.team.setSetting('sending_enabled', '0');
  h.notes.alert('breaker');
  await h.notes.tick();
  h.at(NOW + 15 * MIN - 1);
  assert.deepEqual(h.notes.health(), { enabled: true, ok: true });
  h.at(NOW + 15 * MIN);
  assert.deepEqual(h.notes.health(), { enabled: true, ok: false });
  assert.deepEqual(createOwnerNotes().health(), { enabled: true, ok: true }, 'no ledger: nothing can be stuck');
});

/* ---------------- 12. same-release gating ---------------- */

test('switches off (auto mode false): no hand-over, booking or stopped note; no summary; a WhatsApp lead gets today\'s lines + the Lead line', async () => {
  const h = harness({ inventory: inventory('exact') });
  const lead = addLead(h, { name: 'Sara Example', interest: 'villa' });
  clientSays(h, lead, 'IN-G-1', NOW - 1000, 'Hello there');
  h.db.updateLead(lead.lead_id, { needs_human: 1 });
  assert.deepEqual(h.notes.handover(lead, { kind: 'person' }), { queued: false, reason: 'not_auto' });
  assert.deepEqual(h.notes.stopped(lead, 'stop'), { queued: false, reason: 'not_auto' });
  assert.deepEqual(h.notes.booking(bookingFixture(h, lead), { told: true }), { queued: false, reason: 'not_auto' });
  assert.deepEqual(h.notes.summary({ day: '2026-11-29' }), { queued: false, reason: 'off' });
  assert.deepEqual(h.notes.summary({ test: true, ts: NOW }), { queued: false, reason: 'off' });
  await h.notes.leadEvent(lead, { why: 'wa', created: true, ts: NOW - 3 * MIN });
  await h.notes.tick();
  assert.deepEqual(h.sent, [`${leadNote(h.db.getLead(lead.lead_id), { siteUrl: SITE })}\n${leadLink(lead.lead_id)}`]);
});

test('a note queued in auto mode whose lead left auto mode before it went is dropped, not sent', async () => {
  const h = harness();
  const lead = addLead(h);
  h.autoIds.add(lead.lead_id);
  h.notes.handover(lead, { kind: 'person' });
  h.autoIds.delete(lead.lead_id);
  await h.notes.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.rows()[0].status, 'dropped');
});

/* ---------------- 13. form notes and notify_status ---------------- */

test('form notes: sent → sent; a definite failure → uncertain (retried once later → sent); uncertain → uncertain; held → pending', async () => {
  const ok = harness();
  const l1 = addLead(ok, { channel: 'form', match_method: 'form' });
  receiptFor(ok, 'ev-ok-000000001', l1.lead_id);
  await ok.notes.leadEvent(l1, { why: 'form', created: true, eventId: 'ev-ok-000000001' });
  assert.equal(ok.receipt('ev-ok-000000001'), 'sent');

  const failed = harness();
  const l2 = addLead(failed, { channel: 'form', match_method: 'form' });
  receiptFor(failed, 'ev-failed-00001', l2.lead_id);
  failed.answers.push({ ok: false, error: 'evolution-not-configured' });
  await failed.notes.leadEvent(l2, { why: 'form', created: true, eventId: 'ev-failed-00001' });
  assert.equal(failed.receipt('ev-failed-00001'), 'uncertain');
  assert.deepEqual(failed.logs.find((e) => e.evt === 'lead.wa_failed'), { evt: 'lead.wa_failed', id: l2.lead_id, error: 'evolution-not-configured' });
  failed.at(NOW + 2 * MIN);
  await failed.notes.tick();
  assert.equal(failed.sent.length, 2);
  assert.equal(failed.receipt('ev-failed-00001'), 'sent', 'a later send updates it');

  const unsure = harness();
  const l3 = addLead(unsure, { channel: 'form', match_method: 'form' });
  receiptFor(unsure, 'ev-unsure-00001', l3.lead_id);
  unsure.answers.push({ ok: false, error: 'timeout', uncertain: true });
  await unsure.notes.leadEvent(l3, { why: 'form', created: true, eventId: 'ev-unsure-00001' });
  assert.equal(unsure.receipt('ev-unsure-00001'), 'uncertain');

  const held = harness();
  const l4 = addLead(held, { channel: 'form', match_method: 'form' });
  receiptFor(held, 'ev-held-0000001', l4.lead_id);
  held.answers.push({ ok: false, error: 'rate_limited' });
  await held.notes.leadEvent(l4, { why: 'form', created: true, eventId: 'ev-held-0000001' });
  assert.equal(held.receipt('ev-held-0000001'), 'pending');
  assert.equal(held.sent.length, 1, 'asked once');
  held.at(NOW + 30_000);
  await held.notes.tick();
  assert.equal(held.receipt('ev-held-0000001'), 'sent');
  assert.doesNotMatch(JSON.stringify([...ok.logs, ...failed.logs, ...unsure.logs, ...held.logs]), /Sara|9665000001/, 'ids and codes only');
});

test('the form request waits for the first attempt for at most the limit; a send that answers later still updates the receipt', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const h = harness({ sendNote: () => slow, extra: { formWaitMs: 30 } });
  const lead = addLead(h, { channel: 'form', match_method: 'form' });
  receiptFor(h, 'ev-slow-0000001', lead.lead_id);
  const started = Date.now();
  await h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-slow-0000001' });
  assert.ok(Date.now() - started < 2000);
  assert.equal(h.receipt('ev-slow-0000001'), 'uncertain');
  assert.deepEqual(h.logs.find((e) => e.evt === 'lead.wa_error'), { evt: 'lead.wa_error', id: lead.lead_id, error: 'owner notification unconfirmed' });
  release({ ok: true });
  await h.notes.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.receipt('ev-slow-0000001'), 'sent');
});

test('a form note the pacing holds is pending, and goes 25 s after the one before it', async () => {
  const h = harness();
  h.notes.alert('breaker');
  await h.notes.tick();
  const lead = addLead(h, { channel: 'form', match_method: 'form' });
  receiptFor(h, 'ev-paced-000001', lead.lead_id);
  h.at(NOW + 10_000);
  await h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-paced-000001' });
  assert.equal(h.receipt('ev-paced-000001'), 'pending');
  h.at(NOW + MIN_GAP_MS);
  await h.notes.tick();
  assert.equal(h.receipt('ev-paced-000001'), 'sent');
});

test('owner_notes 0: the form note is dropped and its receipt says so', async () => {
  const h = harness();
  h.team.setSetting('owner_notes', '0');
  const lead = addLead(h, { channel: 'form', match_method: 'form' });
  receiptFor(h, 'ev-dropped-0001', lead.lead_id);
  await h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-dropped-0001' });
  assert.equal(h.sent.length, 0);
  assert.equal(h.receipt('ev-dropped-0001'), 'dropped');
});

test('recoverPendingNotifications leaves a receipt whose note is still queued pending, and still marks one without a note uncertain', async () => {
  const h = harness({ env: ENV });
  const queued = addLead(h, { channel: 'form', match_method: 'form' });
  const orphan = addLead(h, { channel: 'form', match_method: 'form' });
  receiptFor(h, 'ev-queued-00001', queued.lead_id);
  receiptFor(h, 'ev-orphan-00001', orphan.lead_id);
  h.team.setSetting('sending_enabled', '0');
  await h.notes.leadEvent(queued, { why: 'form', created: true, eventId: 'ev-queued-00001' });
  assert.equal(h.receipt('ev-queued-00001'), 'pending');
  const out = recoverPendingNotifications(h.db);
  assert.equal(out.enquiries, 1);
  assert.equal(h.receipt('ev-queued-00001'), 'pending', 'its note is still in the ledger');
  assert.equal(h.receipt('ev-orphan-00001'), 'uncertain');
});

/* ---------------- the timer (no T14 needed for a held note to go) ---------------- */

test('the module wakes itself for its next due note (one timer, unref-able), and stop() clears it', async () => {
  const armed = [];
  const h = harness({ extra: { setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; armed.push(t); return t; }, clearTimer: (t) => { t.cleared = true; } } });
  const lead = addLead(h);
  await h.notes.leadEvent(lead, { why: 'wa', created: true, ts: NOW });
  assert.equal(armed.length, 1);
  assert.equal(armed[0].ms, 60_000, 'at most a minute ahead, so a clock change is caught');
  h.at(NOW + 3 * MIN);
  await armed[0].fn();
  assert.equal(h.sent.length, 1, 'the timer sent it');
  h.notes.alert('breaker');
  const last = armed.at(-1);
  h.notes.stop();
  assert.equal(last.cleared, true);
  h.notes.alert('brain_bug');
  await h.notes.tick();
  assert.equal(h.sent.length, 1, 'stopped: nothing goes');
});
