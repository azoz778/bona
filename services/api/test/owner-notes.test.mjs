/**
 * The owner's notes ledger (PLAN T11 tests 1-9, 12, 13; DESIGN §7.1-7.2; DESIGN-brain §4.2, §10).
 * A fake transport or the real one sender (lib/wa-send.mjs, kind 'note') over a fake fetch, and a
 * fake clock: nothing leaves the process. Most tests tick by hand; the scheduler tests run the
 * module's own timers (and, where said, PR-INT's 5 s tick) on the fake clock.
 * The ledger is opt-in (`ledger: true`, which PR-INT passes); without it the module is today's path.
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
  createOwnerNotes, FORM_NOTIFY_WAIT_MS, MIN_GAP_MS, MERGE_WINDOW_MS, MAX_PER_DAY, MAX_NOTE_CHARS, RETRY_AFTER_MS, HEADERS, ALERT_CODES,
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
 * @param {{ auto?: string[], env?: object|null, sendNote?: Function|null, inventory?: object|null, timers?: boolean, extra?: object }} [o]
 *   `env` set = the real one sender as the transport (what PR-INT wires); otherwise a fake that
 *   answers from `answers` (ok when empty). `timers` = the module's own timers on the fake clock,
 *   run by `runUntil` (no timer otherwise: each test ticks by hand).
 */
function harness({ auto = [], env = null, sendNote = null, inventory = null, timers = false, extra = {} } = {}) {
  const db = openDb(':memory:');
  let clock = NOW;
  const now = () => clock;
  const team = createTeam(db, { now });
  team.ensureOwner({ phone: OWNER_DIGITS, name: 'Owner Example' });
  const inbox = createInboxStore(db, { now });
  const autoIds = new Set(auto);
  const ownerTest = { autoMode: (lead) => Boolean(lead && autoIds.has(lead.lead_id)), active: () => false };
  const sent = [];
  const sentAt = [];
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
    transport = async (text) => { sent.push(text); sentAt.push(clock); return sender.sendTo({ jid: OWNER_JID, text, kind: 'note' }); };
  } else if (!transport) {
    transport = async (text) => { sent.push(text); sentAt.push(clock); return answers.length ? answers.shift() : { ok: true }; };
  }
  const armed = [];
  const scheduler = timers
    ? { setTimer: (fn, ms) => { const t = { fn, ms, at: clock + ms, cleared: false, fired: false }; armed.push(t); return t; }, clearTimer: (t) => { if (t) t.cleared = true; } }
    : { setTimer: null };
  const logs = [];
  const deps = { ledger: true, db, siteUrl: SITE, publicApi: API, sendNote: transport, team, inbox, ownerTest, inventory, now, log: (e) => logs.push(e), ...scheduler, ...extra };
  const notes = createOwnerNotes(deps);
  /**
   * The module's own timers, in time order, up to `until` (the clock jumps to each), and with
   * `tickEvery` also PR-INT's tick (lib T14: every 5 s) in between.
   */
  async function runUntil(until, { tickEvery = 0 } = {}) {
    let ext = tickEvery ? clock + tickEvery : Infinity;
    for (;;) {
      const next = armed.filter((t) => !t.cleared && !t.fired).sort((a, b) => a.at - b.at)[0];
      const at = Math.min(next?.at ?? Infinity, ext);
      if (at > until) break;
      clock = Math.max(clock, at);
      if (next && next.at === at) {
        next.fired = true;
        await next.fn();
      } else {
        ext += tickEvery;
        await notes.tick();
      }
    }
    clock = Math.max(clock, until);
  }
  return {
    db, team, inbox, notes, sent, sentAt, answers, evo, logs, sender, autoIds, deps, armed, runUntil,
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
/**
 * Awaits `p` with a REF'D timer open: the form wait and the send timeout are unref'd timers, so a
 * test awaiting them must not lean on whatever handles the runner happens to hold. A promise still
 * open after `ms` fails the test (it never hangs, and is never cancelled as passed).
 */
async function settled(p, label, ms = 5_000) {
  let guard = null;
  const late = new Promise((_, reject) => { guard = setTimeout(() => reject(new Error(`${label}: still pending after ${ms} ms`)), ms); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(guard); }
}
/** The assistant's answer, as the one sender leaves it once Evolution took it (`accepted`); `pending` = still in flight. */
const danaAnswered = (h, lead, sendId, coversTs, status = 'accepted') => h.inbox.insertOutbox({ send_id: sendId, lead_id: lead.lead_id, jid: lead.wa_jid, text: 'Of course.', sender_kind: 'dana', covers_ts: coversTs, status });

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

test('ledger: the same key twice is one row; a WhatsApp new client is due at min(first answer + 20 s, first message + 3 min), and the module\'s own timer sends it then', async () => {
  const h = harness({ timers: true });
  const a = addLead(h, { name: 'Sara Example' });
  const b = addLead(h, { name: 'Omar Example' });
  await h.notes.leadEvent(a, { why: 'wa', created: true, ts: NOW });
  await h.notes.leadEvent(a, { why: 'wa', created: true, ts: NOW });
  await h.notes.leadEvent(b, { why: 'wa', created: true, ts: NOW });
  assert.equal(h.rows().filter((r) => r.dedupe_key === `new:${a.lead_id}`).length, 1, 'one row per key, ever');
  assert.equal(h.row(`new:${a.lead_id}`).due_ts, NOW + 3 * MIN);
  assert.equal(h.row(`new:${a.lead_id}`).status, 'queued');
  assert.equal(h.sent.length, 0, 'nothing goes at once');

  await h.runUntil(NOW + 30_000);
  danaAnswered(h, a, 'SND-ANSWER-A', NOW);
  await h.runUntil(NOW + 10 * MIN);
  assert.deepEqual(h.sentAt, [NOW + 50_000, NOW + 3 * MIN], 'answered at +30 s: at +50 s; never answered: at first message + 3 min');
  assert.match(h.sent[0], /Name: Sara Example/);
  assert.doesNotMatch(h.sent[0], /Omar Example/, 'the other is due at +3 min, outside the 2-min merge window');
  assert.match(h.sent[1], /Name: Omar Example/);
  await h.notes.leadEvent(a, { why: 'wa', created: true, ts: NOW });
  await h.runUntil(NOW + 20 * MIN);
  assert.equal(h.sent.length, 2, 'a sent key is never queued again');
});

test('the scheduler wakes at the real due time: answered at +5 s, the note goes at +25 s (not at the stored +3-min deadline)', async () => {
  const h = harness({ timers: true });
  const lead = addLead(h, { name: 'Sara Example' });
  clientSays(h, lead, 'IN-T-0001', NOW, 'Hello');
  await h.notes.leadEvent(lead, { why: 'wa', created: true, ts: NOW });
  await h.runUntil(NOW + 5_000);
  danaAnswered(h, lead, 'SND-T-0001', NOW);
  await h.runUntil(NOW + 10 * MIN);
  assert.deepEqual(h.sentAt, [NOW + 25_000]);
});

test('a definite failure is retried once, exactly 2 min later, even when an answer had brought the note forward (with PR-INT\'s 5 s tick too)', async () => {
  for (const tickEvery of [0, 5_000]) {
    const h = harness({ timers: true });
    const lead = addLead(h, { name: 'Sara Example' });
    clientSays(h, lead, `IN-R-${tickEvery}`, NOW, 'Hello');
    h.answers.push({ ok: false, error: 'disabled' });
    await h.notes.leadEvent(lead, { why: 'wa', created: true, ts: NOW });
    await h.runUntil(NOW + 5_000, { tickEvery });
    danaAnswered(h, lead, `SND-R-${tickEvery}`, NOW);
    await h.runUntil(NOW + 30 * MIN, { tickEvery });
    assert.deepEqual(h.sentAt, [NOW + 25_000, NOW + 25_000 + 2 * MIN], `tick every ${tickEvery} ms`);
    assert.equal(h.row(`new:${lead.lead_id}`).status, 'sent');
  }
});

test('an answer still in flight (a pending outbox row) is not an answer: the note waits for first message + 3 min, and does not say it was answered', async () => {
  for (const tickEvery of [0, 5_000]) {
    const h = harness({ timers: true });
    const lead = addLead(h, { name: 'Sara Example' });
    h.autoIds.add(lead.lead_id);
    clientSays(h, lead, `IN-P-${tickEvery}`, NOW, 'Hello');
    await h.notes.leadEvent(lead, { why: 'wa', created: true, ts: NOW });
    await h.runUntil(NOW + 5_000, { tickEvery });
    danaAnswered(h, lead, `SND-P-${tickEvery}`, NOW, 'pending');
    await h.runUntil(NOW + 10 * MIN, { tickEvery });
    assert.deepEqual(h.sentAt, [NOW + 3 * MIN], `tick every ${tickEvery} ms`);
    assert.match(h.sent[0], /\nAI: not answered: not yet\n/);
  }
});

test('the first answer counts from when WhatsApp TOOK it, not from when its send began: begun at +5 s, accepted at +15 s → due at +35 s, "answered in 15 s"', async () => {
  for (const tickEvery of [0, 5_000]) {
    const h = harness({ timers: true });
    const lead = addLead(h, { name: 'Sara Example' });
    h.autoIds.add(lead.lead_id);
    clientSays(h, lead, `IN-ACC-${tickEvery}`, NOW, 'Hello');
    await h.notes.leadEvent(lead, { why: 'wa', created: true, ts: NOW });
    await h.runUntil(NOW + 5_000, { tickEvery });
    danaAnswered(h, lead, `SND-ACC-${tickEvery}`, NOW, 'pending');
    await h.runUntil(NOW + 15_000, { tickEvery });
    h.inbox.updateOutbox(`SND-ACC-${tickEvery}`, { status: 'accepted', key_id: `KEY-ACC-${tickEvery}` });
    await h.runUntil(NOW + 10 * MIN, { tickEvery });
    assert.deepEqual(h.sentAt, [NOW + 35_000], `tick every ${tickEvery} ms`);
    assert.match(h.sent[0], /\nAI: answered in 15 s\n/);
  }
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

/** `n` alerts, one per 25 s from `from`, each ticked: every one is its own send. */
async function alertsEvery25s(h, n, from, tag) {
  for (let i = 0; i < n; i += 1) {
    h.at(from + i * MIN_GAP_MS);
    h.notes.alert('old_out_wrote', { candId: `CND-${tag}-${String(i).padStart(4, '0')}` });
    await h.notes.tick();
  }
}
const overRows = (h) => h.rows().filter((r) => r.meta.over);

test('at most 40 sends a day, the summary one of them: after the day\'s summary, 39 more; then nothing, not a command reply or a test summary either', async () => {
  const h = harness();
  h.team.setSetting('owner_as_client', '1');
  assert.equal(h.notes.summary({ day: '2026-11-29' }).queued, true);
  await h.notes.tick();
  assert.match(h.sent[0], /^\*Bona — daily summary\*/);
  await alertsEvery25s(h, MAX_PER_DAY - 1, NOW + MIN_GAP_MS, 'A');
  assert.equal(h.sent.length, MAX_PER_DAY);
  h.at(NOW + MAX_PER_DAY * MIN_GAP_MS);
  h.notes.alert('old_out_wrote', { candId: 'CND-OVER' });
  h.notes.command('REC-0001', '*Bona — test mode* ON');
  h.notes.summary({ test: true, ts: h.now() });
  await h.notes.tick();
  h.at(NOW + (MAX_PER_DAY + 1) * MIN_GAP_MS);
  await h.notes.tick();
  assert.equal(h.sent.length, MAX_PER_DAY, 'the 41st send never goes');
  assert.deepEqual(overRows(h).map((r) => [r.kind, r.status, r.send_id]).sort(), [['alert', 'merged', null], ['command', 'merged', null], ['summary', 'merged', null]]);
  assert.ok(overRows(h).every((r) => r.meta.over === '2026-11-29'), 'held for the summary');
  // A new Riyadh day starts a new count.
  h.at(Date.UTC(2026, 10, 29, 21, 0, 0));
  h.notes.alert('breaker');
  await h.notes.tick();
  assert.equal(h.sent.length, MAX_PER_DAY + 1);
});

test("before the day's summary has gone, one of the 40 is kept for it: 39 other sends, then the summary is the 40th", async () => {
  const h = harness();
  h.team.setSetting('owner_as_client', '1');
  await alertsEvery25s(h, MAX_PER_DAY, NOW, 'B');
  assert.equal(h.sent.length, MAX_PER_DAY - 1, 'the 40th other note is held');
  assert.equal(overRows(h).length, 1);
  h.at(NOW + MAX_PER_DAY * MIN_GAP_MS);
  h.notes.summary({ day: '2026-11-29' });
  await h.notes.tick();
  assert.equal(h.sent.length, MAX_PER_DAY);
  assert.match(h.sent.at(-1), /^\*Bona — daily summary\*/);
  h.at(NOW + (MAX_PER_DAY + 1) * MIN_GAP_MS);
  h.notes.alert('breaker');
  await h.notes.tick();
  assert.equal(h.sent.length, MAX_PER_DAY);
});

test('with no summary on (before go-live) the limit holds all the same: the 41st note is held, never sent; a held form note says so on its receipt', async () => {
  const h = harness();
  await alertsEvery25s(h, MAX_PER_DAY, NOW, 'C');
  assert.equal(h.sent.length, MAX_PER_DAY);
  h.at(NOW + MAX_PER_DAY * MIN_GAP_MS);
  h.notes.alert('old_out_wrote', { candId: 'CND-OVER' });
  h.notes.command('REC-0002', '*Bona — test mode* OFF');
  const lead = addLead(h, { channel: 'form', match_method: 'form' });
  receiptFor(h, 'ev-over-0000001', lead.lead_id);
  await h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-over-0000001' });
  h.at(NOW + (MAX_PER_DAY + 1) * MIN_GAP_MS);
  await h.notes.tick();
  assert.equal(h.sent.length, MAX_PER_DAY, 'nothing over 40');
  assert.deepEqual(overRows(h).map((r) => r.kind).sort(), ['alert', 'command', 'new_client']);
  assert.equal(h.receipt('ev-over-0000001'), 'over', 'held over the limit, not dropped');
});

test('a purge never reopens the day\'s 40: a lead whose note went on its own is purged after the 40th send, and the 41st is still held', async () => {
  const h = harness();
  const lead = addLead(h, { name: 'Sara Example', inbox_state: 'out' });
  h.notes.alert('old_out_wrote', { leadId: lead.lead_id });
  await h.notes.tick();
  await alertsEvery25s(h, MAX_PER_DAY - 1, NOW + MIN_GAP_MS, 'P');
  assert.equal(h.sent.length, MAX_PER_DAY);
  h.notes.onPurge(lead.lead_id);
  const raw = JSON.stringify(h.db.db.prepare('SELECT * FROM owner_notes').all());
  assert.ok(!raw.includes(lead.lead_id), 'nothing of the purged lead is left');
  h.at(NOW + MAX_PER_DAY * MIN_GAP_MS);
  h.notes.alert('breaker');
  await h.notes.tick();
  h.at(NOW + (MAX_PER_DAY + 1) * MIN_GAP_MS);
  await h.notes.tick();
  assert.equal(h.sent.length, MAX_PER_DAY, 'the purge did not hand back a send');
  assert.deepEqual(overRows(h).map((r) => [r.kind, r.meta.alert]), [['alert', 'breaker']]);
});

test('a send cut off by a restart (WhatsApp may have taken it) counts: the 40th send dies mid-call, and after the restart the 41st is held', async () => {
  let calls = 0;
  const h = harness({ sendNote: async () => { calls += 1; return calls < MAX_PER_DAY ? { ok: true } : new Promise(() => {}); } });
  for (let i = 0; i < MAX_PER_DAY; i += 1) {
    h.at(NOW + i * MIN_GAP_MS);
    h.notes.alert('old_out_wrote', { candId: `CND-X-${String(i).padStart(4, '0')}` });
    if (i < MAX_PER_DAY - 1) await h.notes.tick();
    else { void h.notes.tick(); await new Promise((resolve) => setImmediate(resolve)); }
  }
  assert.equal(calls, MAX_PER_DAY);
  h.notes.stop();

  const after = [];
  const restarted = createOwnerNotes({ ...h.deps, sendNote: async (t) => { after.push(t); return { ok: true }; } });
  h.at(NOW + MAX_PER_DAY * MIN_GAP_MS);
  restarted.alert('breaker');
  await restarted.tick();
  h.at(NOW + (MAX_PER_DAY + 1) * MIN_GAP_MS);
  await restarted.tick();
  assert.deepEqual(after, [], 'nothing goes over 40');
  assert.deepEqual(overRows(h).map((r) => [r.kind, r.meta.alert]), [['alert', 'breaker']]);
});

test("an outage alert over the day's 40 takes its chats into the overflow with it: handed over at 23:58, held at 23:59, nothing of them goes after midnight, and the next summary counts them", async () => {
  for (const asked of [true, false]) {
    const label = asked ? 'alert() asked for it' : 'opened by the hand-overs only';
    const h = harness();
    h.team.setSetting('owner_as_client', '1');
    h.notes.summary({ day: '2026-11-29' });
    await h.notes.tick();
    await alertsEvery25s(h, MAX_PER_DAY - 1, NOW + MIN_GAP_MS, `M${asked ? 'A' : 'H'}`);
    assert.equal(h.sent.length, MAX_PER_DAY, label);
    const [one, two, three, gone] = ['One Example', 'Two Example', 'Three Example', 'Gone Example'].map((name) => addLead(h, { name }));
    for (const l of [one, two, three, gone]) h.autoIds.add(l.lead_id);
    const at2358 = Date.UTC(2026, 10, 29, 20, 58, 0); // 23:58 Riyadh
    const hour = Math.floor(at2358 / HOUR);
    h.at(at2358);
    if (asked) assert.deepEqual(h.notes.alert('brain_out', { code: 'quota' }), { queued: true }, label);
    for (const l of [one, two, three, gone]) assert.equal(h.notes.handover(l, { kind: 'brain' }).queued, true, label);
    const alertKey = `al:brain_out:${hour}`;
    assert.equal(h.row(alertKey).status, 'queued', `${label}: the 23:00 hour's alert`);
    h.autoIds.delete(gone.lead_id); // out of auto mode before the alert's turn: never listed, never counted
    h.at(at2358 + MIN); // 23:59: over the day's 40
    await h.notes.tick();
    assert.equal(h.sent.length, MAX_PER_DAY, `${label}: nothing over 40`);
    const alertRow = h.row(alertKey);
    assert.deepEqual([alertRow.status, alertRow.meta.over], ['merged', '2026-11-29'], label);
    for (const l of [one, two, three]) {
      const r = h.row(`ho:${l.lead_id}:brain:${hour}`);
      assert.deepEqual([r.status, r.meta.over, r.meta.into], ['merged', '2026-11-29', alertRow.note_id], `${label}: the chat is held with its alert`);
    }
    assert.equal(h.row(`ho:${gone.lead_id}:brain:${hour}`).status, 'dropped', label);
    // After midnight a new day's 40: none of those chats goes as a hand-over of its own.
    for (const t of [Date.UTC(2026, 10, 29, 21, 0, 30), Date.UTC(2026, 10, 29, 22, 0, 0)]) { h.at(t); await h.notes.tick(); }
    assert.equal(h.sent.length, MAX_PER_DAY, `${label}: nothing after midnight`);
    assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)), `${label}: no hand-over of its own`);
    // The 08:00 summary counts the alert and its three chats as held over the limit.
    h.at(Date.UTC(2026, 10, 30, 5, 0, 0));
    h.notes.summary({ day: '2026-11-30' });
    await h.notes.tick();
    assert.equal(h.sent.length, MAX_PER_DAY + 1, label);
    assert.match(h.sent.at(-1), /^\*Bona — daily summary\*/, label);
    assert.match(h.sent.at(-1), /\nNotes over the day's limit: 4 \(hand-overs 3 · alerts 1\)(\n|$)/, label);
  }
});

test("an outage alert over the day's 40 that only a hand-over opened, whose one chat left auto mode, is dropped (it would never go), not counted as held over", async () => {
  const h = harness();
  await alertsEvery25s(h, MAX_PER_DAY, NOW, 'ME');
  assert.equal(h.sent.length, MAX_PER_DAY);
  const lead = addLead(h, { name: 'Left Example' });
  h.autoIds.add(lead.lead_id);
  h.at(NOW + 2 * HOUR);
  assert.equal(h.notes.handover(lead, { kind: 'brain' }).queued, true);
  const hour = Math.floor((NOW + 2 * HOUR) / HOUR);
  h.autoIds.delete(lead.lead_id);
  h.at(NOW + 2 * HOUR + MIN);
  await h.notes.tick();
  assert.equal(h.sent.length, MAX_PER_DAY);
  assert.equal(h.row(`al:brain_out:${hour}`).status, 'dropped');
  assert.equal(h.row(`al:brain_out:${hour}`).meta.over, undefined);
  assert.equal(h.row(`ho:${lead.lead_id}:brain:${hour}`).status, 'dropped');
  assert.deepEqual(overRows(h), [], 'nothing held over: neither would ever have gone');
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

test("Sending off after the day's 40 sends: a new form note stays queued with its receipt pending, never settled into the overflow; Sending back on the next day → it goes, the same day → the overflow", async () => {
  for (const back of ['next day', 'same day']) {
    const calls = [];
    let h = null;
    // As the one sender answers (lib/wa-send.mjs): Sending off → `sending_disabled`.
    h = harness({ sendNote: async (text) => { calls.push(text); return h.team.sendingEnabled() ? { ok: true } : { ok: false, error: 'sending_disabled' }; } });
    for (let i = 0; i < MAX_PER_DAY; i += 1) {
      h.at(NOW + i * MIN_GAP_MS);
      h.notes.alert('old_out_wrote', { candId: `CND-SO-${String(i).padStart(4, '0')}` });
      await h.notes.tick();
    }
    assert.equal(calls.length, MAX_PER_DAY, back);
    h.team.setSetting('sending_enabled', '0');
    const lead = addLead(h, { channel: 'form', match_method: 'form' });
    receiptFor(h, 'ev-off-over-01', lead.lead_id);
    h.at(NOW + MAX_PER_DAY * MIN_GAP_MS);
    await settled(h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-off-over-01' }), back);
    for (const t of [NOW + (MAX_PER_DAY + 1) * MIN_GAP_MS, NOW + 2 * HOUR]) { h.at(t); await h.notes.tick(); }
    const held = h.row(`new:${lead.lead_id}`);
    assert.equal(held.status, 'queued', `${back}: held while Sending is off`);
    assert.equal(held.meta.over, undefined, `${back}: not settled into the overflow`);
    assert.equal(h.receipt('ev-off-over-01'), 'pending', back);
    assert.equal(calls.length, MAX_PER_DAY, back);
    h.team.setSetting('sending_enabled', '1');
    if (back === 'next day') {
      h.at(Date.UTC(2026, 10, 29, 21, 0, 0)); // 00:00 Riyadh, a new day's 40
      await h.notes.tick();
      assert.equal(calls.length, MAX_PER_DAY + 1, back);
      assert.match(calls.at(-1), /^\*Bona — new enquiry\*/, back);
      assert.equal(h.row(`new:${lead.lead_id}`).status, 'sent', back);
      assert.equal(h.receipt('ev-off-over-01'), 'sent', back);
    } else {
      h.at(NOW + 3 * HOUR);
      await h.notes.tick();
      assert.equal(calls.length, MAX_PER_DAY, `${back}: still over today's 40`);
      const over = h.row(`new:${lead.lead_id}`);
      assert.deepEqual([over.status, over.meta.over], ['merged', '2026-11-29'], back);
      assert.equal(h.receipt('ev-off-over-01'), 'over', back);
    }
  }
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
  // The summary goes on its own, so it is drawn at the next pass, and dropped there.
  h.at(NOW + MIN_GAP_MS);
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
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

test('an untold booking never says something went to the client, even for an exact pin', async () => {
  const h = harness({ inventory: inventory('exact') });
  const lead = addLead(h, { name: 'Sara Example', phone_e164: '966500000011' });
  h.autoIds.add(lead.lead_id);
  const id = bookingFixture(h, lead);
  assert.equal(h.notes.booking(id, { told: false }).queued, true);
  await h.notes.tick();
  assert.equal(h.sent[0], [
    '*Bona — viewing booked*', 'Sun 29 Nov 14:00-15:00', 'BONA-W012 · Marina Tower Villa', 'Sara Example · +966500000011',
    'Meeting point: exact pin, map link NOT sent', 'Booked, but the client was NOT told; please write to them.', leadLink(lead.lead_id),
  ].join('\n'));
  assert.doesNotMatch(h.sent[0], /link sent/);
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
  const sent = h.rows()[0];
  h.notes.onPurge(lead.lead_id);
  // Today's send stays counted, as a record with nothing of the lead (no id, its own key, no meta).
  assert.deepEqual(h.rows().map((r) => [r.note_id, r.lead_id, r.dedupe_key, r.meta, r.send_id, r.updated]),
    [[sent.note_id, null, `purged:${sent.note_id}`, {}, sent.send_id, sent.updated]]);
  // The lead can be told about again (its keys are free), and the record goes once its day is over.
  assert.equal(h.notes.alert('old_out_wrote', { leadId: lead.lead_id }).queued, true);
  h.at(Date.UTC(2026, 10, 29, 21, 0, 0));
  h.notes.onPurge(lead.lead_id);
  assert.deepEqual(h.rows(), []);
});

test('purge: rows with no send are deleted; a send of an earlier day is deleted outright', async () => {
  const h = harness();
  const lead = addLead(h, { name: 'Sara Example', inbox_state: 'out' });
  h.notes.alert('old_out_wrote', { leadId: lead.lead_id });
  await h.notes.tick();
  h.at(Date.UTC(2026, 10, 29, 21, 0, 0)); // the next Riyadh day
  h.autoIds.add(lead.lead_id);
  h.notes.handover(lead, { kind: 'offer' });
  assert.deepEqual(h.rows().map((r) => [r.kind, r.status]), [['alert', 'sent'], ['handover', 'queued']]);
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
  assert.match(h.sent[1], /^\*Bona — alert\*\nOpenAI credit ran out\..*Top up at platform\.openai\.com\./, 'the outage\'s cause carries on into the next hour');
  assert.match(h.sent[1], /Late Example \(WhatsApp\)/);
});

test("an outage alert for the next hour never goes before its hour: a 10:59 note does not take it along, so a chat handed over at 10:59:30 is still in the 11:00 alert (never a hand-over of its own)", async () => {
  for (const tickEvery of [0, 5_000]) {
    const label = `tick every ${tickEvery} ms`;
    const h = harness({ timers: true });
    const [early, later, next] = ['Early Example', 'Later Example', 'Next Example'].map((name) => addLead(h, { name }));
    for (const l of [early, later, next]) h.autoIds.add(l.lead_id);
    h.notes.alert('brain_out', { code: 'quota' });
    await h.runUntil(NOW + 58 * MIN, { tickEvery });
    assert.deepEqual(h.sentAt, [NOW], `${label}: the 10:00 alert went`);
    assert.equal(h.notes.handover(early, { kind: 'brain' }).queued, true);
    assert.equal(h.row(`al:brain_out:${Math.floor(NOW / HOUR) + 1}`).status, 'queued', `${label}: 10:58 opens the 11:00 alert`);
    await h.runUntil(NOW + 59 * MIN, { tickEvery });
    h.notes.alert('breaker');
    await h.runUntil(NOW + 59 * MIN + 30_000, { tickEvery });
    assert.deepEqual(h.sentAt, [NOW, NOW + 59 * MIN], label);
    assert.doesNotMatch(h.sent[1], /OpenAI|Chats waiting|Early Example/, `${label}: the 10:59 note goes alone`);
    assert.equal(h.row(`al:brain_out:${Math.floor(NOW / HOUR) + 1}`).status, 'queued', `${label}: the 11:00 alert waits for its hour`);
    assert.equal(h.notes.handover(later, { kind: 'brain' }).queued, true);
    await h.runUntil(NOW + HOUR - 1, { tickEvery });
    assert.equal(h.sent.length, 2, `${label}: nothing before 11:00`);
    await h.runUntil(NOW + HOUR + 5 * MIN, { tickEvery });
    assert.deepEqual(h.sentAt, [NOW, NOW + 59 * MIN, NOW + HOUR], `${label}: the next hour's alert at the hour, not earlier`);
    assert.match(h.sent[2], /^\*Bona — alert\*\nOpenAI credit ran out\..*Top up at platform\.openai\.com\./, `${label}: the cause carries on`);
    assert.match(h.sent[2], /\nChats waiting: 2 → /);
    assert.match(h.sent[2], /Early Example \(WhatsApp\) · Later Example \(WhatsApp\)/);
    assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)), `${label}: no hand-over of its own`);
    assert.deepEqual(h.rows().filter((r) => r.kind === 'handover').map((r) => r.status), ['merged', 'merged'], label);

    // Just after the 11:00 alert went: the chat waits for 12:00's, never a note of its own.
    h.at(NOW + HOUR + 5 * MIN + 10_000);
    assert.equal(h.notes.handover(next, { kind: 'brain' }).queued, true);
    await h.runUntil(NOW + 2 * HOUR + 5 * MIN, { tickEvery });
    assert.deepEqual(h.sentAt, [NOW, NOW + 59 * MIN, NOW + HOUR, NOW + 2 * HOUR], label);
    assert.match(h.sent[3], /^\*Bona — alert\*\nOpenAI credit ran out\./, `${label}: still the outage's cause at 12:00`);
    assert.match(h.sent[3], /\nChats waiting: 1 → /);
    assert.match(h.sent[3], /Next Example \(WhatsApp\)/);
    assert.doesNotMatch(h.sent[3], /Early Example|Later Example/);
    assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)), label);
  }
});

test("a chat handed over for an hour whose outage alert was dropped while owner notes were off goes in that hour's alert once notes are back on (queued again), never a hand-over of its own", async () => {
  const h = harness();
  const [early, later] = ['Early Example', 'Later Example'].map((name) => addLead(h, { name }));
  for (const l of [early, later]) h.autoIds.add(l.lead_id);
  const hour = Math.floor(NOW / HOUR);
  h.notes.alert('brain_out', { code: 'quota' });
  await h.notes.tick();
  h.at(NOW + 58 * MIN);
  h.notes.handover(early, { kind: 'brain' });
  h.team.setSetting('owner_notes', '0');
  await h.notes.tick();
  assert.equal(h.row(`al:brain_out:${hour + 1}`).status, 'dropped', 'the 11:00 alert was dropped with the switch');
  assert.equal(h.row(`ho:${early.lead_id}:brain:${hour}`).status, 'dropped');
  h.team.setSetting('owner_notes', '1');
  h.at(NOW + 59 * MIN + 30_000);
  assert.equal(h.notes.handover(later, { kind: 'brain' }).queued, true);
  assert.equal(h.row(`ho:${later.lead_id}:brain:${hour}`).meta.alertHour, hour + 1, 'a dropped alert never counts as gone');
  assert.equal(h.row(`al:brain_out:${hour + 1}`).status, 'queued', 'the dropped 11:00 alert is queued again');
  h.at(NOW + HOUR - 1);
  await h.notes.tick();
  assert.equal(h.sent.length, 1, 'nothing before 11:00');
  h.at(NOW + HOUR);
  await h.notes.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /^\*Bona — alert\*\nOpenAI credit ran out\./);
  assert.match(h.sent[1], /\nChats waiting: 1 → /);
  assert.match(h.sent[1], /Later Example \(WhatsApp\)/);
  assert.doesNotMatch(h.sent[1], /Early Example/, 'a chat dropped with the switch stays dropped');
  for (const t of [NOW + HOUR + 30 * MIN, NOW + 2 * HOUR]) { h.at(t); await h.notes.tick(); }
  assert.equal(h.sent.length, 2, 'nothing more: no 12:00 alert, no hand-over of its own');
  assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)));
});

test("owner notes off: a brain hand-over opens and steps past no hour's alert, so once notes are on the 12:05 outage alert goes and a 12:10 chat goes in the 13:00 alert", async () => {
  const h = harness();
  const hour = Math.floor(NOW / HOUR);
  const offs = Array.from({ length: 5 }, (_, i) => addLead(h, { name: `Off ${i + 1} Example` }));
  const next = addLead(h, { name: 'Next Example' });
  for (const l of [...offs, next]) h.autoIds.add(l.lead_id);
  h.team.setSetting('owner_notes', '0');
  h.at(NOW + 10 * MIN);
  for (const l of offs) assert.deepEqual(h.notes.handover(l, { kind: 'brain' }), { queued: false, reason: 'dropped' });
  assert.deepEqual(h.rows().filter((r) => r.kind === 'alert'), [], 'no alert row opened while notes are off');
  assert.deepEqual(h.rows().map((r) => [r.kind, r.status]), Array(5).fill(['handover', 'dropped']));
  h.team.setSetting('owner_notes', '1');
  h.at(NOW + 2 * HOUR + 5 * MIN);
  assert.deepEqual(h.notes.alert('brain_out', { code: 'quota' }), { queued: true }, "12:05: this hour's alert");
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^\*Bona — alert\*\nOpenAI credit ran out\./);
  assert.doesNotMatch(h.sent[0], /Chats waiting|Off \d Example/, 'the chats dropped with the switch stay dropped');
  h.at(NOW + 2 * HOUR + 10 * MIN);
  assert.equal(h.notes.handover(next, { kind: 'brain' }).queued, true);
  assert.equal(h.row(`ho:${next.lead_id}:brain:${hour + 2}`).meta.alertHour, hour + 3, '12:00 went: the 13:00 alert');
  h.at(NOW + 3 * HOUR - 1);
  await h.notes.tick();
  assert.equal(h.sent.length, 1, 'nothing before 13:00');
  h.at(NOW + 3 * HOUR);
  await h.notes.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /^\*Bona — alert\*\nOpenAI credit ran out\./, 'the cause carries on');
  assert.match(h.sent[1], /\nChats waiting: 1 → /);
  assert.match(h.sent[1], /Next Example \(WhatsApp\)/);
  assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)));
});

test("an outage alert of this hour dropped while owner notes were off is queued again once they are on: by a brain hand-over (with its own cause) or by the outage's next alert", async () => {
  const h = harness();
  const [first, second] = ['First Example', 'Second Example'].map((name) => addLead(h, { name }));
  for (const l of [first, second]) h.autoIds.add(l.lead_id);
  const hour = Math.floor(NOW / HOUR);
  h.team.setSetting('owner_notes', '0');
  assert.deepEqual(h.notes.alert('brain_out', { code: 'quota' }), { queued: false, reason: 'dropped' });
  h.team.setSetting('owner_notes', '1');
  h.at(NOW + 20 * MIN);
  assert.equal(h.notes.handover(first, { kind: 'brain' }).queued, true);
  assert.equal(h.row(`al:brain_out:${hour}`).status, 'queued');
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^\*Bona — alert\*\nOpenAI credit ran out\./);
  assert.match(h.sent[0], /First Example \(WhatsApp\)/);

  h.team.setSetting('owner_notes', '0');
  h.at(NOW + HOUR + 5 * MIN);
  assert.deepEqual(h.notes.alert('brain_out', { code: 'auth' }), { queued: false, reason: 'dropped' });
  h.team.setSetting('owner_notes', '1');
  h.at(NOW + HOUR + 10 * MIN);
  assert.deepEqual(h.notes.alert('brain_out', { code: 'auth' }), { queued: true });
  assert.equal(h.notes.handover(second, { kind: 'brain' }).queued, true);
  await h.notes.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /^\*Bona — alert\*\nOpenAI refused the Bona key \(auth\)\./);
  assert.match(h.sent[1], /Second Example \(WhatsApp\)/);
  assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)));
});

test("a later hour's outage alert keeps the outage's cause: a budget stop says so at 11:00, and a new cause after an hour's alert went is the next alert's", async () => {
  const h = harness();
  const [first, second] = ['First Example', 'Second Example'].map((name) => addLead(h, { name }));
  for (const l of [first, second]) h.autoIds.add(l.lead_id);
  const hour = Math.floor(NOW / HOUR);
  h.notes.alert('brain_out', { code: 'budget' });
  await h.notes.tick();
  assert.match(h.sent[0], /^\*Bona — alert\*\nThe AI spend stop was reached\./);
  h.at(NOW + 30 * MIN);
  assert.equal(h.notes.handover(first, { kind: 'brain' }).queued, true);
  assert.equal(h.row(`al:brain_out:${hour + 1}`).meta.code, 'budget', 'the 11:00 alert carries the cause on');
  h.at(NOW + HOUR);
  await h.notes.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /^\*Bona — alert\*\nThe AI spend stop was reached\. Clients get a holding line until the day or the month rolls over\./);
  assert.match(h.sent[1], /First Example \(WhatsApp\)/);
  assert.doesNotMatch(h.sent[1], /is not answering/);

  // 11:20: the 11:00 alert went, so a chat opens 12:00's; the outage's cause changes at 11:40 (quota): 12:00's says so.
  h.at(NOW + HOUR + 20 * MIN);
  assert.equal(h.notes.handover(second, { kind: 'brain' }).queued, true);
  h.at(NOW + HOUR + 40 * MIN);
  assert.deepEqual(h.notes.alert('brain_out', { code: 'quota' }), { queued: false, reason: 'duplicate' }, "this hour's alert went");
  assert.equal(h.row(`al:brain_out:${hour + 1}`).meta.code, 'budget', 'what went is kept as it went');
  h.at(NOW + 2 * HOUR);
  await h.notes.tick();
  assert.equal(h.sent.length, 3);
  assert.match(h.sent[2], /^\*Bona — alert\*\nOpenAI credit ran out\./);
  assert.match(h.sent[2], /Second Example \(WhatsApp\)/);
  assert.equal(h.row(`al:brain_out:${hour + 2}`).meta.code, 'quota', 'the 12:00 alert went with the new cause, and its row says so');
  assert.equal(h.row(`al:brain_out:${hour + 1}`).meta.code, 'budget', 'the 11:00 alert still says what it went with');
  assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)));
});

test("an outage alert's sentence is the outage's latest cause, chosen when it goes: an alert() refused as a duplicate still counts, a later hour with no alert() keeps it, a new cause wins, and what went keeps its sentence", async () => {
  const hour = Math.floor(NOW / HOUR);
  const SAYS = {
    quota: /^\*Bona — alert\*\nOpenAI credit ran out\. .*Top up at platform\.openai\.com\./,
    auth: /^\*Bona — alert\*\nOpenAI refused the Bona key \(auth\)\./,
    budget: /^\*Bona — alert\*\nThe AI spend stop was reached\./,
    down: /^\*Bona — alert\*\nThe AI service \(OpenAI\) is not answering\./,
  };
  const setup = (...names) => {
    const h = harness();
    const leads = names.map((name) => addLead(h, { name }));
    for (const l of leads) h.autoIds.add(l.lead_id);
    return [h, ...leads];
  };

  // (1) A 'down' alert went at 10:00; alert(quota) at 10:30 is a duplicate; a chat at 10:31: the 11:00 alert says quota.
  {
    const [h, one] = setup('One Example');
    h.notes.alert('brain_out', { code: 'down' });
    await h.notes.tick();
    assert.match(h.sent[0], SAYS.down);
    h.at(NOW + 30 * MIN);
    assert.deepEqual(h.notes.alert('brain_out', { code: 'quota' }), { queued: false, reason: 'duplicate' }, "10:30: this hour's alert went");
    h.at(NOW + 31 * MIN);
    assert.equal(h.notes.handover(one, { kind: 'brain' }).queued, true);
    h.at(NOW + HOUR);
    await h.notes.tick();
    assert.equal(h.sent.length, 2);
    assert.match(h.sent[1], SAYS.quota, '(1) the 11:00 alert has the quota sentence');
    assert.match(h.sent[1], /One Example \(WhatsApp\)/);
    assert.equal(h.row(`al:brain_out:${hour}`).meta.code, 'down', '(1) the 10:00 alert keeps the cause it went with');
    assert.equal(h.row(`al:brain_out:${hour + 1}`).meta.code, 'quota', '(1) the 11:00 alert records the cause it went with');
    const { kind, lead_id: leadId, status, send_id: sendId, meta } = h.row('brain_out:cause');
    assert.deepEqual({ kind, leadId, status, sendId, meta }, { kind: 'alert', leadId: null, status: 'dropped', sendId: null, meta: { cause: 'quota' } },
      'the cause is one row holding a code only, never queued or sent');
  }
  // (2) A quota alert went at 10:00; a chat at 11:03 with no alert() call: the 11:00-hour alert says quota.
  {
    const [h, one] = setup('One Example');
    h.notes.alert('brain_out', { code: 'quota' });
    await h.notes.tick();
    h.at(NOW + HOUR + 3 * MIN);
    assert.equal(h.notes.handover(one, { kind: 'brain' }).queued, true);
    assert.equal(h.row(`ho:${one.lead_id}:brain:${hour + 1}`).meta.alertHour, hour + 1);
    await h.notes.tick();
    assert.equal(h.sent.length, 2);
    assert.match(h.sent[1], SAYS.quota, '(2) the 11:00-hour alert has the quota sentence');
    assert.match(h.sent[1], /One Example \(WhatsApp\)/);
  }
  // (3) A budget stop at 10:00, no chat in hour 11, a chat at 12:05: the 12:00-hour alert says the spend stop.
  {
    const [h, one] = setup('One Example');
    h.notes.alert('brain_out', { code: 'budget' });
    await h.notes.tick();
    for (const t of [NOW + HOUR, NOW + HOUR + 30 * MIN]) { h.at(t); await h.notes.tick(); }
    assert.equal(h.sent.length, 1, 'no chat in hour 11: no 11:00 alert');
    h.at(NOW + 2 * HOUR + 5 * MIN);
    assert.equal(h.notes.handover(one, { kind: 'brain' }).queued, true);
    await h.notes.tick();
    assert.equal(h.sent.length, 2);
    assert.match(h.sent[1], SAYS.budget, '(3) the 12:00-hour alert says the spend stop');
    assert.doesNotMatch(h.sent[1], /is not answering/);
  }
  // (4) The cause changes quota → auth mid-outage, before or after the next hour's alert was opened: that alert says auth,
  //     and so does the one after it (no alert() in between).
  for (const authFirst of [true, false]) {
    const label = authFirst ? 'auth before the chat' : 'auth after the chat';
    const [h, one, two] = setup('One Example', 'Two Example');
    h.notes.alert('brain_out', { code: 'quota' });
    await h.notes.tick();
    assert.match(h.sent[0], SAYS.quota);
    if (authFirst) { h.at(NOW + 40 * MIN); assert.equal(h.notes.alert('brain_out', { code: 'auth' }).queued, false, label); }
    h.at(NOW + 45 * MIN);
    assert.equal(h.notes.handover(one, { kind: 'brain' }).queued, true, label);
    if (!authFirst) { h.at(NOW + 50 * MIN); assert.equal(h.notes.alert('brain_out', { code: 'auth' }).queued, false, label); }
    h.at(NOW + HOUR);
    await h.notes.tick();
    assert.equal(h.sent.length, 2, label);
    assert.match(h.sent[1], SAYS.auth, `(4) ${label}: the next alert uses auth`);
    assert.match(h.sent[1], /One Example \(WhatsApp\)/, label);
    h.at(NOW + HOUR + 10 * MIN);
    assert.equal(h.notes.handover(two, { kind: 'brain' }).queued, true, label);
    h.at(NOW + 2 * HOUR);
    await h.notes.tick();
    assert.equal(h.sent.length, 3, label);
    assert.match(h.sent[2], SAYS.auth, `(4) ${label}: still auth at 12:00`);
    assert.match(h.sent[0], SAYS.quota, `(4) ${label}: what went at 10:00 is as it went`);
    assert.equal(h.row(`al:brain_out:${hour}`).meta.code, 'quota', label);
    assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)), label);
  }
  // No alert() ever (no cause recorded): a brain hand-over's alert says 'down'.
  {
    const [h, one] = setup('One Example');
    assert.equal(h.notes.handover(one, { kind: 'brain' }).queued, true);
    await h.notes.tick();
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0], SAYS.down);
    assert.match(h.sent[0], /One Example \(WhatsApp\)/);
  }
});

test("a brain hand-over of a chat already handed over this hour (a duplicate) opens no later hour's alert: after the 10:00 alert listed it, nothing goes at 11:00", async () => {
  for (const before of ['sent', 'queued']) {
    const h = harness();
    const one = addLead(h, { name: 'One Example' });
    h.autoIds.add(one.lead_id);
    const hour = Math.floor(NOW / HOUR);
    h.notes.alert('brain_out', { code: 'quota' });
    assert.equal(h.notes.handover(one, { kind: 'brain' }).queued, true);
    if (before === 'sent') {
      await h.notes.tick();
      assert.equal(h.sent.length, 1);
      assert.match(h.sent[0], /One Example \(WhatsApp\)/);
    }
    h.at(NOW + 10 * MIN);
    assert.deepEqual(h.notes.handover(one, { kind: 'brain' }), { queued: false, reason: 'duplicate' }, before);
    assert.equal(h.row(`al:brain_out:${hour + 1}`), null, `${before}: a duplicate opens no 11:00 alert`);
    assert.equal(h.rows().filter((r) => r.kind === 'handover').length, 1, before);
    for (const t of [NOW + 10 * MIN + MIN_GAP_MS, NOW + HOUR, NOW + HOUR + 30 * MIN, NOW + 2 * HOUR]) { h.at(t); await h.notes.tick(); }
    assert.equal(h.sent.length, 1, `${before}: one note, nothing at 11:00`);
    assert.match(h.sent[0], /\nChats waiting: 1 → /, before);
    assert.deepEqual(h.rows().filter((r) => r.status === 'queued'), [], before);
  }
});

test("an outage alert a hand-over opened goes only with chats: its chat purged or out of auto mode before its hour → dropped at its hour, never sent empty; one alert() asked for goes on its own", async () => {
  for (const gone of ['purged', 'not auto']) {
    const h = harness();
    const one = addLead(h, { name: 'One Example' });
    h.autoIds.add(one.lead_id);
    const hour = Math.floor(NOW / HOUR);
    h.notes.alert('brain_out', { code: 'quota' });
    await h.notes.tick();
    assert.equal(h.sent.length, 1, `${gone}: the outage's own alert goes with no chat waiting yet`);
    assert.match(h.sent[0], /^\*Bona — alert\*\nOpenAI credit ran out\./);
    assert.doesNotMatch(h.sent[0], /Chats waiting/);
    h.at(NOW + 30 * MIN);
    assert.equal(h.notes.handover(one, { kind: 'brain' }).queued, true);
    assert.equal(h.row(`al:brain_out:${hour + 1}`).status, 'queued');
    h.at(NOW + 40 * MIN);
    if (gone === 'purged') h.notes.onPurge(one.lead_id);
    else h.autoIds.delete(one.lead_id);
    h.at(NOW + HOUR);
    await h.notes.tick();
    assert.equal(h.sent.length, 1, `${gone}: the 11:00 alert has no chat to list, so it does not go`);
    assert.equal(h.row(`al:brain_out:${hour + 1}`).status, 'dropped', gone);
    assert.deepEqual(h.rows().filter((r) => r.status === 'queued'), [], gone);
    for (const t of [NOW + HOUR + MIN, NOW + HOUR + 30 * MIN]) { h.at(t); await h.notes.tick(); }
    assert.equal(h.sent.length, 1, `${gone}: nothing later either`);

    // The same hour, a new chat: the dropped 11:00-hour alert is queued again and lists it.
    const two = addLead(h, { name: 'Two Example' });
    h.autoIds.add(two.lead_id);
    h.at(NOW + HOUR + 50 * MIN);
    assert.equal(h.notes.handover(two, { kind: 'brain' }).queued, true);
    assert.equal(h.row(`ho:${two.lead_id}:brain:${hour + 1}`).meta.alertHour, hour + 1, `${gone}: a dropped alert never counts as gone`);
    await h.notes.tick();
    assert.equal(h.sent.length, 2, gone);
    assert.match(h.sent[1], /^\*Bona — alert\*\nOpenAI credit ran out\./, gone);
    assert.match(h.sent[1], /\nChats waiting: 1 → /, gone);
    assert.match(h.sent[1], /Two Example \(WhatsApp\)/, gone);
    assert.doesNotMatch(h.sent[1], /One Example/, gone);
  }
});

test("a chat whose brain hand-over was dropped while owner notes were off is listed when it is handed over again in that hour once they are on (queued again), so the hour's alert never goes without it", async () => {
  const h = harness();
  const one = addLead(h, { name: 'One Example' });
  h.autoIds.add(one.lead_id);
  const hour = Math.floor(NOW / HOUR);
  h.team.setSetting('owner_notes', '0');
  assert.deepEqual(h.notes.alert('brain_out', { code: 'quota' }), { queued: false, reason: 'dropped' });
  assert.deepEqual(h.notes.handover(one, { kind: 'brain' }), { queued: false, reason: 'dropped' });
  h.team.setSetting('owner_notes', '1');
  h.at(NOW + 20 * MIN);
  assert.deepEqual(h.notes.alert('brain_out', { code: 'quota' }), { queued: true });
  assert.deepEqual(h.notes.handover(one, { kind: 'brain' }), { queued: true }, 'the dropped hand-over is queued again');
  assert.equal(h.row(`ho:${one.lead_id}:brain:${hour}`).status, 'queued');
  assert.deepEqual(h.notes.handover(one, { kind: 'brain' }), { queued: false, reason: 'duplicate' }, 'once');
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^\*Bona — alert\*\nOpenAI credit ran out\./);
  assert.match(h.sent[0], /\nChats waiting: 1 → /);
  assert.match(h.sent[0], /One Example \(WhatsApp\)/);
  assert.equal(h.row(`ho:${one.lead_id}:brain:${hour}`).status, 'merged');
  assert.equal(h.rows().filter((r) => r.kind === 'handover').length, 1, 'one row per chat and hour');
  assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)));
});

/* The invariant (T11; Codex r7 P1 on PR-B2): a brain hand-over is never sent on its own. Whatever an
   outage alert comes to, the chats it lists come to it too; a queued one with no queued alert for its
   hour (which no path leaves) is listed in the next open hour's alert, or dropped. */

test("an outage alert whose retry fails takes every chat it lists with it: A's alert fails at 10:00, B joins at 10:01, the 10:02 retry fails → the alert, A and B all failed; nothing goes as a hand-over of its own, and a 10:05 chat goes in the 11:00 alert", async () => {
  for (const tickEvery of [0, 5_000]) {
    const label = `tick every ${tickEvery} ms`;
    const h = harness({ timers: true });
    const [a, b, c] = ['Alpha Example', 'Bravo Example', 'Charlie Example'].map((name) => addLead(h, { name }));
    for (const l of [a, b, c]) h.autoIds.add(l.lead_id);
    const hour = Math.floor(NOW / HOUR);
    h.answers.push({ ok: false, error: 'http_400' }, { ok: false, error: 'http_400' });
    assert.equal(h.notes.handover(a, { kind: 'brain' }).queued, true, label);
    await h.runUntil(NOW + MIN, { tickEvery });
    assert.deepEqual(h.sentAt, [NOW], `${label}: 10:00, a definite failure`);
    assert.equal(h.row(`al:brain_out:${hour}`).status, 'queued', `${label}: to be retried at 10:02`);
    assert.equal(h.notes.handover(b, { kind: 'brain' }).queued, true, label);
    assert.equal(h.row(`ho:${b.lead_id}:brain:${hour}`).meta.alertHour, hour, `${label}: B joins the queued 10:00 alert`);
    await h.runUntil(NOW + 4 * MIN, { tickEvery });
    assert.deepEqual(h.sentAt, [NOW, NOW + RETRY_AFTER_MS], `${label}: the one retry, and nothing at 10:04`);
    assert.match(h.sent[1], /\nChats waiting: 2 → /, label);
    assert.match(h.sent[1], /Alpha Example \(WhatsApp\)/, label);
    assert.match(h.sent[1], /Bravo Example \(WhatsApp\)/, label);
    const alertRow = h.row(`al:brain_out:${hour}`);
    assert.equal(alertRow.status, 'failed', label);
    for (const l of [a, b]) {
      const r = h.row(`ho:${l.lead_id}:brain:${hour}`);
      assert.deepEqual([r.status, r.send_id, r.meta.into], ['failed', alertRow.send_id, alertRow.note_id], `${label}: ${l.name} settles with its alert`);
    }
    h.at(NOW + 5 * MIN);
    assert.equal(h.notes.handover(c, { kind: 'brain' }).queued, true, label);
    assert.equal(h.row(`ho:${c.lead_id}:brain:${hour}`).meta.alertHour, hour + 1, `${label}: the 10:00 alert is over (failed): 11:00's`);
    await h.runUntil(NOW + 3 * HOUR, { tickEvery });
    assert.deepEqual(h.sentAt, [NOW, NOW + RETRY_AFTER_MS, NOW + HOUR], label);
    assert.match(h.sent[2], /^\*Bona — alert\*\n/, label);
    assert.match(h.sent[2], /\nChats waiting: 1 → /, label);
    assert.match(h.sent[2], /Charlie Example \(WhatsApp\)/, label);
    assert.doesNotMatch(h.sent[2], /Alpha|Bravo/, label);
    assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)), `${label}: no hand-over of its own`);
    assert.deepEqual(h.rows().filter((r) => r.status === 'queued'), [], label);
  }
});

test("a chat that joins an outage alert between two of its attempts comes to what the alert comes to: held then sent, failed then sent, unsure or failed; never a hand-over of its own", async () => {
  const fail = { ok: false, error: 'http_400' };
  const cases = [
    { label: 'held (minute used up), then sent', first: { ok: false, error: 'rate_limited' }, second: { ok: true }, again: NOW + 15_000, then: ['sent', 'merged'] },
    { label: 'held (Sending off), then sent once Sending is back on', first: { ok: false, error: 'sending_disabled' }, second: { ok: true }, again: NOW + 10_000, then: ['sent', 'merged'], sendingOff: true },
    { label: 'failed, then sent', first: fail, second: { ok: true }, again: NOW + RETRY_AFTER_MS, then: ['sent', 'merged'] },
    { label: 'failed, then unsure', first: fail, second: { ok: false, error: 'timeout', uncertain: true }, again: NOW + RETRY_AFTER_MS, then: ['uncertain', 'uncertain'] },
    { label: 'failed, then failed', first: fail, second: fail, again: NOW + RETRY_AFTER_MS, then: ['failed', 'failed'] },
  ];
  for (const { label, first, second, again, then, sendingOff = false } of cases) {
    const h = harness();
    const [a, b] = ['Alpha Example', 'Bravo Example'].map((name) => addLead(h, { name }));
    for (const l of [a, b]) h.autoIds.add(l.lead_id);
    const hour = Math.floor(NOW / HOUR);
    h.answers.push(first, second);
    if (sendingOff) h.team.setSetting('sending_enabled', '0');
    h.notes.alert('brain_out', { code: 'quota' });
    assert.equal(h.notes.handover(a, { kind: 'brain' }).queued, true, label);
    await h.notes.tick();
    assert.equal(h.sent.length, 1, label);
    assert.equal(h.row(`al:brain_out:${hour}`).status, 'queued', `${label}: still to go`);
    h.at(NOW + 5_000);
    assert.equal(h.notes.handover(b, { kind: 'brain' }).queued, true, label);
    assert.equal(h.row(`ho:${b.lead_id}:brain:${hour}`).meta.alertHour, hour, `${label}: B joins it`);
    h.at(again - 1);
    await h.notes.tick();
    assert.equal(h.sent.length, 1, `${label}: not before its time`);
    h.at(again);
    if (sendingOff) h.team.setSetting('sending_enabled', '1');
    await h.notes.tick();
    assert.equal(h.sent.length, 2, label);
    assert.match(h.sent[1], /^\*Bona — alert\*\nOpenAI credit ran out\./, label);
    assert.match(h.sent[1], /\nChats waiting: 2 → /, label);
    assert.match(h.sent[1], /Alpha Example \(WhatsApp\)/, label);
    assert.match(h.sent[1], /Bravo Example \(WhatsApp\)/, label);
    const alertRow = h.row(`al:brain_out:${hour}`);
    assert.equal(alertRow.status, then[0], label);
    for (const l of [a, b]) {
      const r = h.row(`ho:${l.lead_id}:brain:${hour}`);
      assert.deepEqual([r.status, r.send_id, r.meta.into], [then[1], alertRow.send_id, alertRow.note_id], `${label}: ${l.name} comes to what its alert came to`);
    }
    for (const t of [NOW + 10 * MIN, NOW + HOUR, NOW + 2 * HOUR]) { h.at(t); await h.notes.tick(); }
    assert.equal(h.sent.length, 2, `${label}: nothing more`);
    assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)), `${label}: no hand-over of its own`);
    assert.deepEqual(h.rows().filter((r) => r.status === 'queued'), [], label);
  }
});

/** A queued brain hand-over as an older build or a fault could leave it: no queued outage alert for its hour. */
const strayBrainHandover = (h, lead, hour, due) => h.db.db.prepare(`INSERT INTO owner_notes (note_id, kind, lead_id, dedupe_key, due_ts, status, send_id, meta, created, updated)
  VALUES (?, 'handover', ?, ?, ?, 'queued', NULL, ?, ?, ?)`).run(`NOTE-stray-${lead.lead_id}`, lead.lead_id, `ho:${lead.lead_id}:brain:${hour}`, due, JSON.stringify({ kind: 'brain', alertHour: hour }), due, due);

test("the guard: a queued brain hand-over whose hour has no queued outage alert is never drawn as a hand-over: its hour's alert went, failed hours ago, is missing or was dropped → the next open hour's alert lists it; no hour left → dropped; logged as a count only", async () => {
  const hour = Math.floor(NOW / HOUR);
  const setup = () => {
    const h = harness();
    const x = addLead(h, { name: 'Stray Example' });
    h.autoIds.add(x.lead_id);
    return [h, x];
  };
  /** The guard's one log line: an error, counts only (never a name or a lead id). */
  const strayLogged = (h, dropped, label) => {
    const lines = h.logs.filter((e) => e.evt === 'notes.brain_orphan');
    assert.deepEqual(lines, [{ level: 'error', evt: 'notes.brain_orphan', n: 1, dropped }], label);
    assert.doesNotMatch(JSON.stringify(h.logs), /Example|LEAD-/, label);
  };
  // (1) Its hour's alert went: the 11:00 alert lists it, never earlier.
  {
    const [h, x] = setup();
    h.notes.alert('brain_out', { code: 'quota' });
    await h.notes.tick();
    assert.equal(h.sent.length, 1);
    strayBrainHandover(h, x, hour, NOW + MIN);
    h.at(NOW + MIN);
    await h.notes.tick();
    assert.equal(h.sent.length, 1, '(1) nothing before 11:00');
    assert.equal(h.row(`ho:${x.lead_id}:brain:${hour}`).meta.alertHour, hour + 1, '(1) moved to the 11:00 alert');
    assert.deepEqual([h.row(`al:brain_out:${hour + 1}`).status, h.row(`al:brain_out:${hour + 1}`).due_ts], ['queued', NOW + HOUR], '(1)');
    h.at(NOW + HOUR);
    await h.notes.tick();
    assert.equal(h.sent.length, 2, '(1)');
    assert.match(h.sent[1], /^\*Bona — alert\*\nOpenAI credit ran out\./, '(1)');
    assert.match(h.sent[1], /\nChats waiting: 1 → /, '(1)');
    assert.match(h.sent[1], /Stray Example \(WhatsApp\)/, '(1)');
    assert.equal(h.row(`ho:${x.lead_id}:brain:${hour}`).status, 'merged', '(1)');
    strayLogged(h, 0, '(1)');
    assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)), '(1)');
  }
  // (2) Its hour's alert failed, and it is found 3 hours later: this hour's alert, at once.
  {
    const [h, x] = setup();
    h.answers.push({ ok: false, error: 'http_400' }, { ok: false, error: 'http_400' });
    h.notes.alert('brain_out', { code: 'auth' });
    await h.notes.tick();
    h.at(NOW + RETRY_AFTER_MS);
    await h.notes.tick();
    assert.equal(h.row(`al:brain_out:${hour}`).status, 'failed', '(2)');
    strayBrainHandover(h, x, hour, NOW + 3 * MIN);
    h.at(NOW + 3 * HOUR);
    await h.notes.tick();
    assert.equal(h.sent.length, 3, '(2)');
    assert.match(h.sent[2], /^\*Bona — alert\*\nOpenAI refused the Bona key \(auth\)\./, '(2)');
    assert.match(h.sent[2], /Stray Example \(WhatsApp\)/, '(2)');
    assert.equal(h.row(`al:brain_out:${hour + 3}`).status, 'sent', "(2) this hour's alert");
    strayLogged(h, 0, '(2)');
    assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)), '(2)');
  }
  // (3) No alert row at all: this hour's is opened and goes now.
  {
    const [h, x] = setup();
    strayBrainHandover(h, x, hour, NOW);
    await h.notes.tick();
    assert.equal(h.sent.length, 1, '(3)');
    assert.match(h.sent[0], /^\*Bona — alert\*\nThe AI service \(OpenAI\) is not answering\./, '(3)');
    assert.match(h.sent[0], /Stray Example \(WhatsApp\)/, '(3)');
    strayLogged(h, 0, '(3)');
    assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)), '(3)');
  }
  // (4) Its hour's alert was dropped while owner notes were off: queued again, and lists it.
  {
    const [h, x] = setup();
    h.team.setSetting('owner_notes', '0');
    assert.deepEqual(h.notes.alert('brain_out', { code: 'budget' }), { queued: false, reason: 'dropped' });
    h.team.setSetting('owner_notes', '1');
    strayBrainHandover(h, x, hour, NOW + MIN);
    h.at(NOW + MIN);
    await h.notes.tick();
    assert.equal(h.sent.length, 1, '(4)');
    assert.match(h.sent[0], /^\*Bona — alert\*\nThe AI spend stop was reached\./, '(4)');
    assert.match(h.sent[0], /Stray Example \(WhatsApp\)/, '(4)');
    assert.equal(h.row(`al:brain_out:${hour}`).status, 'sent', '(4)');
    strayLogged(h, 0, '(4)');
    assert.ok(!h.sent.some((s) => s.includes(HEADERS.handover)), '(4)');
  }
  // (5) Every hour it could join (this one and the next 24) is over: dropped, never sent.
  {
    const [h, x] = setup();
    for (let i = 0; i <= 24; i += 1) {
      h.db.db.prepare(`INSERT INTO owner_notes (note_id, kind, lead_id, dedupe_key, due_ts, status, send_id, meta, created, updated)
        VALUES (?, 'alert', NULL, ?, ?, 'sent', ?, ?, ?, ?)`).run(`NOTE-gone-${i}`, `al:brain_out:${hour + i}`, NOW - 2 * DAY, `NB-gone-${i}`, JSON.stringify({ alert: 'brain_out', code: 'down', hour: hour + i }), NOW - 2 * DAY, NOW - 2 * DAY);
    }
    strayBrainHandover(h, x, hour, NOW);
    await h.notes.tick();
    for (const t of [NOW + MIN, NOW + HOUR]) { h.at(t); await h.notes.tick(); }
    assert.equal(h.sent.length, 0, '(5) nothing goes');
    assert.equal(h.row(`ho:${x.lead_id}:brain:${hour}`).status, 'dropped', '(5)');
    strayLogged(h, 1, '(5)');
  }
});

test("the invariant under seeded random runs (answers, joins, the switches, purges, auto mode, the day's 40): a queued brain hand-over always has its hour's outage alert queued, one settles with its alert, and none is ever sent as a hand-over of its own", async () => {
  const CODES = ['quota', 'auth', 'down', 'budget'];
  const ANSWERS = [{ ok: true }, { ok: true }, { ok: false, error: 'http_400' }, { ok: false, error: 'timeout', uncertain: true }, { ok: false, error: 'rate_limited' }];
  const STEPS = [0, 5_000, 15_000, 30_000, MIN, 2 * MIN, 5 * MIN, 20 * MIN];
  const GONE = new Set(['sent', 'merged', 'uncertain', 'failed']);
  const mulberry = (a) => () => {
    a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  for (let seed = 1; seed <= 30; seed += 1) {
    const rnd = mulberry(seed * 7919);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const texts = [];
    let calm = true;
    let h = null;
    h = harness({ sendNote: async (text) => {
      texts.push(text);
      if (calm) return { ok: true };
      if (!h.team.sendingEnabled()) return { ok: false, error: 'sending_disabled' };
      return pick(ANSWERS);
    } });
    if (seed % 3 === 0) await alertsEvery25s(h, MAX_PER_DAY - 3, NOW - 2 * HOUR, `FZ${seed}`);
    const leads = Array.from({ length: 6 }, (_, i) => addLead(h, { name: `Fuzz ${i + 1} Example` }));
    for (const l of leads) h.autoIds.add(l.lead_id);
    const check = (label) => {
      const rows = h.rows();
      const byId = new Map(rows.map((r) => [r.note_id, r]));
      const open = new Set(rows.filter((r) => r.status === 'queued' && r.kind === 'alert' && r.meta.alert === 'brain_out').map((r) => r.meta.hour));
      for (const r of rows) {
        if (r.kind !== 'handover' || r.meta.kind !== 'brain') continue;
        if (r.status === 'queued') assert.ok(open.has(r.meta.alertHour), `${label}: a queued brain hand-over has its hour's alert queued`);
        const a = byId.get(r.meta.into);
        if (a?.kind === 'alert' && a.meta.alert === 'brain_out' && GONE.has(a.status)) {
          assert.equal(r.status, a.status === 'sent' ? 'merged' : a.status, `${label}: a chat comes to what its alert came to`);
        }
      }
      assert.ok(!texts.some((x) => x.includes(HEADERS.handover)), `${label}: never a hand-over of its own`);
    };
    calm = false;
    let t = NOW;
    for (let step = 0; step < 60; step += 1) {
      t += pick(STEPS);
      h.at(t);
      const label = `seed ${seed} step ${step}`;
      const op = Math.floor(rnd() * 16);
      const lead = pick(leads);
      if (op <= 3) h.notes.handover(lead, { kind: 'brain' });
      else if (op === 4) h.notes.alert('brain_out', { code: pick(CODES) });
      else if (op === 5) h.notes.alert(pick(['breaker', 'brain_bug']));
      else if (op === 6 && rnd() < 0.4) h.team.setSetting('owner_notes', rnd() < 0.6 ? '1' : '0');
      else if (op === 7 && rnd() < 0.5) h.team.setSetting('sending_enabled', rnd() < 0.6 ? '1' : '0');
      else if (op === 8) { if (rnd() < 0.5) h.autoIds.delete(lead.lead_id); else h.autoIds.add(lead.lead_id); }
      else if (op === 9 && rnd() < 0.3) h.notes.onPurge(lead.lead_id);
      else await h.notes.tick();
      check(label);
    }
    calm = true;
    h.team.setSetting('owner_notes', '1');
    h.team.setSetting('sending_enabled', '1');
    for (let i = 0; i < 4 * 60; i += 1) { t += MIN; h.at(t); await h.notes.tick(); }
    check(`seed ${seed} drained`);
    assert.deepEqual(h.rows().filter((r) => r.status === 'queued').map((r) => r.kind), [], `seed ${seed}: nothing left queued`);
  }
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
  notes = createOwnerNotes({ ledger: true, db, siteUrl: SITE, publicApi: API, sendNote: async () => ({ ok: true }), team, inbox, ownerTest: { autoMode: () => true }, now: () => NOW, setTimer: null });
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

test('a purge while the send is out: whatever WhatsApp answers (ok, unsure, held, a first failure) the record keeps nothing of the lead, nothing goes again, the receipt is not touched, and the send still counts for the day', async () => {
  const cases = [
    [{ ok: true }, 'sent'],
    [{ ok: false, error: 'timeout', uncertain: true }, 'uncertain'],
    [{ ok: false, error: 'rate_limited' }, 'dropped'],
    [{ ok: false, error: 'evolution-not-configured' }, 'dropped'],
  ];
  for (const [reply, status] of cases) {
    const label = JSON.stringify(reply);
    let release = null;
    const calls = [];
    const h = harness({
      sendNote: (text) => {
        calls.push(text);
        return calls.length === 1 ? new Promise((resolve) => { release = resolve; }) : { ok: true };
      },
    });
    const lead = addLead(h, { name: 'Sara Example', channel: 'form', match_method: 'form' });
    receiptFor(h, 'ev-inflight-00001', lead.lead_id);
    const request = h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-inflight-00001' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, `${label}: the send is out`);
    const [out] = h.rows();
    h.notes.onPurge(lead.lead_id);
    release(reply);
    await settled(request, label);
    const rows = h.rows();
    assert.deepEqual(rows.map((r) => [r.note_id, r.lead_id, r.dedupe_key, r.meta, r.status]),
      [[out.note_id, null, `purged:${out.note_id}`, {}, status]], label);
    assert.ok(rows[0].send_id, `${label}: the record carries its send`);
    const raw = JSON.stringify(h.db.db.prepare('SELECT * FROM owner_notes').all());
    assert.ok(!raw.includes(lead.lead_id) && !raw.includes('ev-inflight'), `${label}: nothing of the lead or its form comes back`);
    assert.equal(h.receipt('ev-inflight-00001'), 'pending', `${label}: a purged note's event is not written`);
    assert.equal(h.logs.some((e) => String(e.evt).startsWith('lead.')), false, `${label}: no form line for a purged note`);
    // Past the hold and the retry time: nothing goes again.
    const later = NOW + RETRY_AFTER_MS + MIN_GAP_MS;
    h.at(later);
    await h.notes.tick();
    assert.equal(calls.length, 1, `${label}: nothing re-sent`);
    // The day's 40 still counts it: 39 more go, the next one is held.
    await alertsEvery25s(h, MAX_PER_DAY - 1, later, `F${status[0]}`);
    assert.equal(calls.length, MAX_PER_DAY, label);
    h.at(later + MAX_PER_DAY * MIN_GAP_MS);
    h.notes.alert('breaker');
    await h.notes.tick();
    assert.equal(calls.length, MAX_PER_DAY, `${label}: the purge did not hand back a send`);
    assert.deepEqual(overRows(h).map((r) => [r.kind, r.meta.alert]), [['alert', 'breaker']], label);
  }
});

test('a purge while the form request still waits: the request does not mark the purged note\'s receipt either', async (t) => {
  t.plan(6);
  let release = null;
  const h = harness({ sendNote: () => new Promise((resolve) => { release = resolve; }), extra: { formWaitMs: 30 } });
  const lead = addLead(h, { channel: 'form', match_method: 'form' });
  receiptFor(h, 'ev-waiting-00001', lead.lead_id);
  const request = h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-waiting-00001' });
  await new Promise((resolve) => setImmediate(resolve));
  t.assert.strictEqual(typeof release, 'function', 'the send is out');
  h.notes.onPurge(lead.lead_id);
  await settled(request, 'the form request');
  t.assert.strictEqual(h.receipt('ev-waiting-00001'), 'pending');
  t.assert.strictEqual(h.logs.some((e) => e.evt === 'lead.wa_error'), false);
  release({ ok: true });
  await settled(h.notes.tick(), 'the send');
  await new Promise((resolve) => setImmediate(resolve));
  t.assert.strictEqual(h.receipt('ev-waiting-00001'), 'pending');
  t.assert.strictEqual(h.rows().length, 1);
  t.assert.strictEqual(h.rows()[0].status, 'sent');
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

test('the form request waits for the first attempt for at most the limit; a send that answers later still updates the receipt', async (t) => {
  t.plan(4);
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const h = harness({ sendNote: () => slow, extra: { formWaitMs: 30 } });
  const lead = addLead(h, { channel: 'form', match_method: 'form' });
  receiptFor(h, 'ev-slow-0000001', lead.lead_id);
  const started = Date.now();
  await settled(h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-slow-0000001' }), 'the form request');
  t.assert.ok(Date.now() - started < 2000);
  t.assert.strictEqual(h.receipt('ev-slow-0000001'), 'uncertain');
  t.assert.deepStrictEqual(h.logs.find((e) => e.evt === 'lead.wa_error'), { evt: 'lead.wa_error', id: lead.lead_id, error: 'owner notification unconfirmed' });
  release({ ok: true });
  await settled(h.notes.tick(), 'the send');
  await new Promise((resolve) => setImmediate(resolve));
  t.assert.strictEqual(h.receipt('ev-slow-0000001'), 'sent');
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

test('recoverPendingNotifications matches a queued note by its EVENT: a second form receipt of the same lead does not stay pending', async () => {
  const h = harness({ env: ENV });
  const lead = addLead(h, { channel: 'form', match_method: 'form' });
  receiptFor(h, 'ev-first-000001', lead.lead_id);
  receiptFor(h, 'ev-second-00001', lead.lead_id);
  h.team.setSetting('sending_enabled', '0');
  await h.notes.leadEvent(lead, { why: 'form', created: true, eventId: 'ev-first-000001' });
  // The second form (a merge) died before leadEvent marked its receipt skipped: it is still pending.
  assert.equal(h.receipt('ev-second-00001'), 'pending');
  assert.equal(recoverPendingNotifications(h.db).enquiries, 1);
  assert.equal(h.receipt('ev-first-000001'), 'pending', 'its own note is still queued');
  assert.equal(h.receipt('ev-second-00001'), 'uncertain', 'no note of its own: recovered, never pending for ever');
  h.team.setSetting('sending_enabled', '1');
  h.at(NOW + MIN);
  await h.notes.tick();
  assert.equal(h.receipt('ev-first-000001'), 'sent');
  assert.equal(h.receipt('ev-second-00001'), 'uncertain');
});

/* ---------------- one message per summary ---------------- */

test('a summary goes as its own message: never inside another note, nor another note inside it', async () => {
  const h = harness();
  h.team.setSetting('owner_as_client', '1');
  h.notes.alert('breaker');
  h.notes.summary({ day: '2026-11-29' });
  h.notes.alert('brain_bug');
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^\*Bona — alert\*\n.*3 of its messages failed/s);
  assert.match(h.sent[0], /3 or more unusable answers/, 'the two alerts merge');
  assert.doesNotMatch(h.sent[0], /daily summary/);
  h.at(NOW + MIN_GAP_MS);
  await h.notes.tick();
  assert.match(h.sent[1], /^\*Bona — daily summary\*/);
  assert.doesNotMatch(h.sent[1], /\n\n/);

  const first = harness();
  first.team.setSetting('owner_as_client', '1');
  first.notes.summary({ day: '2026-11-29' });
  first.notes.alert('breaker');
  await first.notes.tick();
  assert.equal(first.sent.length, 1);
  assert.match(first.sent[0], /^\*Bona — daily summary\*/);
  assert.doesNotMatch(first.sent[0], /\*Bona — alert\*/);
  first.at(NOW + MIN_GAP_MS);
  await first.notes.tick();
  assert.match(first.sent[1], /^\*Bona — alert\*/);
});

/* ---------------- the timer (no T14 needed for a held note to go) ---------------- */

test('the module wakes itself for its next due note (one timer, at most a minute ahead), and stop() clears it', async () => {
  const h = harness({ timers: true });
  const lead = addLead(h, { channel: 'email', match_method: 'email' });
  await h.notes.leadEvent(lead, { why: 'email', created: true, ts: NOW });
  assert.deepEqual(h.armed.map((t) => t.ms), [60_000], 'at most a minute ahead, so a clock change is caught');
  await h.runUntil(NOW + 5 * MIN);
  assert.deepEqual(h.sentAt, [NOW + 3 * MIN], 'the timer sent it');
  h.notes.alert('breaker');
  const last = h.armed.at(-1);
  h.notes.stop();
  assert.equal(last.cleared, true);
  h.notes.alert('brain_bug');
  await h.notes.tick();
  assert.equal(h.sent.length, 1, 'stopped: nothing goes');
});

test('a WhatsApp client still waiting for an answer is looked at every 5 s (so an answer is seen in time), and no faster', async () => {
  const h = harness({ timers: true });
  const lead = addLead(h);
  await h.notes.leadEvent(lead, { why: 'wa', created: true, ts: NOW });
  assert.deepEqual(h.armed.filter((t) => !t.cleared).map((t) => t.at - NOW), [5_000]);
  await h.runUntil(NOW + 3 * MIN);
  assert.ok(h.armed.length <= 3 * 60 / 5 + 2, String(h.armed.length));
  assert.deepEqual(h.sentAt, [NOW + 3 * MIN]);
});

test('a pass that throws still re-arms the timer for the notes behind it', async () => {
  const calls = [];
  let h = null;
  h = harness({ timers: true, sendNote: async () => { calls.push(h.now()); return { get ok() { throw new Error('a broken answer'); } }; } });
  h.notes.alert('breaker');
  const lead = addLead(h, { channel: 'email', match_method: 'email' });
  await h.notes.leadEvent(lead, { why: 'email', created: true, ts: NOW });
  await h.runUntil(NOW + 10 * MIN);
  assert.deepEqual(calls, [NOW, NOW + 3 * MIN], 'the email note still went at +3 min');
  assert.ok(h.logs.some((e) => e.evt === 'notes.tick_failed'));
  assert.equal(h.row('al:breaker:' + Math.floor(NOW / HOUR)).status, 'uncertain', 'the broken send is never retried');
});

/* ---------------- without `ledger: true`: today's path (INERT until PR-INT opts in) ---------------- */

test("without ledger: true (index.mjs today) it is today's path: every form note at once, byte for byte; no queue, no timer, no restart pick-up", async () => {
  const db = openDb(':memory:');
  try {
    let clock = NOW;
    const team = createTeam(db, { now: () => clock });
    // The switches never governed today's note, and still do not on this path.
    team.setSetting('owner_notes', '0');
    team.setSetting('sending_enabled', '0');
    // A row a ledger process left queued: today's path neither sends it nor wakes for it.
    db.db.prepare(`INSERT INTO owner_notes (note_id, kind, lead_id, dedupe_key, due_ts, status, meta, created, updated)
                   VALUES ('NOTE-LEFT', 'alert', NULL, 'al:breaker:1', ?, 'queued', '{"alert":"breaker"}', ?, ?)`).run(NOW - HOUR, NOW - HOUR, NOW - HOUR);
    const armed = [];
    const sent = [];
    const answers = [];
    const logs = [];
    const notes = createOwnerNotes({
      db, siteUrl: SITE, publicApi: API, team, ownerTest: { autoMode: () => true }, now: () => clock, log: (e) => logs.push(e),
      setTimer: (fn, ms) => { armed.push(ms); return {}; }, clearTimer: () => {},
      sendNote: async (t) => { sent.push([t, clock]); return answers.length ? answers.shift() : { ok: true }; },
    });
    assert.deepEqual(armed, [], 'no restart pick-up');
    const lead = (id, phone) => {
      db.insertLead({ lead_id: id, created: NOW, updated: NOW, phone_e164: phone, name: 'Sara Example', channel: 'form', match_method: 'form', stage: 'new' });
      return db.getLead(id);
    };
    const receipt = (ev, leadId) => db.db.prepare('INSERT INTO enquiry_receipts(event_id,payload_hash,lead_id,created) VALUES(?,?,?,?)').run(ev, 'h', leadId, clock);
    const status = (ev) => db.db.prepare('SELECT notify_status FROM enquiry_receipts WHERE event_id = ?').get(ev).notify_status;
    const a = lead('LEAD-20261129-legacy01', '966500000031');
    const b = lead('LEAD-20261129-legacy02', '966500000032');
    receipt('ev-legacy-00001', a.lead_id);
    await notes.leadEvent(a, { why: 'form', created: true, eventId: 'ev-legacy-00001' });
    clock = NOW + 10_000;
    receipt('ev-legacy-00002', b.lead_id);
    await notes.leadEvent(b, { why: 'form', created: true, eventId: 'ev-legacy-00002' });
    assert.deepEqual(sent, [[leadNote(a, { siteUrl: SITE }), NOW], [leadNote(b, { siteUrl: SITE }), NOW + 10_000]],
      'both at once, 10 s apart, today\'s text (no Lead line)');
    assert.equal(status('ev-legacy-00001'), 'sent');
    assert.equal(status('ev-legacy-00002'), 'sent');
    // A merge is told too, and a refusal is the answer, asked once: as today.
    receipt('ev-legacy-00003', a.lead_id);
    answers.push({ ok: false, error: 'rate_limited' });
    await notes.leadEvent(a, { why: 'form', created: false, eventId: 'ev-legacy-00003' });
    assert.equal(sent.length, 3);
    assert.equal(status('ev-legacy-00003'), 'uncertain');
    assert.deepEqual(logs.at(-1), { evt: 'lead.wa_failed', id: a.lead_id, error: 'rate_limited' });
    // Nothing else exists on this path: no ledger row, no tick, no other kind.
    assert.deepEqual(db.db.prepare('SELECT note_id, status FROM owner_notes').all().map((r) => ({ ...r })), [{ note_id: 'NOTE-LEFT', status: 'queued' }]);
    assert.equal(await notes.tick(), undefined);
    for (const [fn, args] of [['handover', [a, { kind: 'person' }]], ['booking', ['BK-1', { told: true }]], ['stopped', [a, 'stop']],
      ['alert', ['breaker', {}]], ['mail', [{ messageId: 'M-1' }]], ['command', ['R-1', '#dana status']], ['onPurge', [a.lead_id]]]) {
      assert.equal(notes[fn](...args), undefined, fn);
    }
    assert.equal(typeof notes.summary, 'undefined', 'no summary on this path: createDailySummary refuses it, loudly');
    clock = NOW + DAY;
    await notes.tick();
    assert.equal(sent.length, 3);
    assert.deepEqual(armed, []);
    assert.deepEqual(notes.health(), { enabled: true, ok: true });
    // ledger: true is the switch PR-INT turns: the same second form 10 s later is then held for the 25 s gap
    // (test 'a form note the pacing holds is pending, and goes 25 s after the one before it').
  } finally {
    db.close();
  }
});
