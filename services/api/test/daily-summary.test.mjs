/**
 * The owner's daily summary (PLAN T11 tests 8 (Warnings), 10, 12; DESIGN §7.3, DESIGN-brain §10):
 * the 08:00 Riyadh minute timer with its catch-up rule, the test summary, the layout, and the
 * same-release naming rule. A fake clock and a fake transport; example names only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { ensureHandoff } from '../lib/lead-tasks.mjs';
import { createOwnerNotes } from '../lib/owner-notes.mjs';
import { createDailySummary, renderSummary, SUMMARY_HOUR, CATCH_UP_BEFORE_HOUR } from '../lib/daily-summary.mjs';

const API = 'https://api.bona-real-estate.com';
const SITE = 'https://bona-real-estate.com';
const MIN = 60_000;
/** A Riyadh wall-clock time (UTC+3) as an instant. */
const riyadh = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 3, mi);
const MON_0800 = riyadh(2026, 11, 30, 8);
const INBOX = `${API}/dashboard/inbox?filter=needs_human`;

function harness({ clock: start = MON_0800, settings = {}, brain = null, waLink = null, viewing = null, mail = null } = {}) {
  const db = openDb(':memory:');
  let clock = start;
  const now = () => clock;
  const team = createTeam(db, { now });
  team.ensureOwner({ phone: '966500000009', name: 'Owner Example' });
  for (const [k, v] of Object.entries(settings)) team.setSetting(k, v);
  const inbox = createInboxStore(db, { now });
  const ownerTest = { autoMode: () => false, active: () => team.ownerAsClientEnabled() };
  const sent = [];
  const deps = {
    ledger: true, db, siteUrl: SITE, publicApi: API, team, inbox, ownerTest, brain, waLink, viewing, mail, now, setTimer: null,
    sendNote: async (t) => { sent.push(t); return { ok: true }; },
  };
  const notes = createOwnerNotes(deps);
  const summary = createDailySummary({ db, team, notes, now });
  return {
    db, team, inbox, notes, summary, sent, deps, now,
    at: (ms) => { clock = ms; },
    rows: () => db.db.prepare("SELECT dedupe_key, status, meta FROM owner_notes WHERE kind = 'summary' ORDER BY created").all().map((r) => ({ ...r })),
  };
}

let n = 0;
function lead(h, over = {}) {
  n += 1;
  const id = over.lead_id ?? `LEAD-20261129-${String(n).padStart(8, '0')}`;
  const phone = `9665000002${String(n % 100).padStart(2, '0')}`;
  h.db.insertLead({
    lead_id: id, created: riyadh(2026, 11, 1, 9), updated: riyadh(2026, 11, 1, 9), phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`,
    name: 'Client Example', channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', inbox_since: riyadh(2026, 11, 1, 9), ...over,
  });
  return h.db.getLead(id);
}
function booking(h, l, start, listingId) {
  const id = `BK-${l.lead_id.slice(-4)}-${start}`;
  h.db.db.prepare(`INSERT INTO viewing_bookings (booking_id, lead_id, task_id, listing_id, start_ts, end_ts, event_id, status, client_told, created, updated)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, l.lead_id, `task-${id}`, listingId, start, start + 60 * MIN, `ev${start}`, 'booked', 1, start - 86_400_000, start - 86_400_000);
}
/** One `dana` outbox row, `delay` after the client message it covers. */
function danaSend(h, l, coversTs, delay, { status = 'accepted', guarded = 1, text = 'Of course.' } = {}) {
  h.at(coversTs + delay);
  const sendId = `SND-${l.lead_id.slice(-4)}-${coversTs}-${delay}`;
  h.inbox.insertOutbox({ send_id: sendId, lead_id: l.lead_id, jid: l.wa_jid, text, sender_kind: 'dana', covers_ts: coversTs, status });
  if (guarded) h.db.db.prepare('UPDATE wa_outbox SET guarded = 1 WHERE send_id = ?').run(sendId);
}
/** The assistant's answer, as a brain turn leaves it: bubbles the reply guard passed (`guarded = 1`), each taken by WhatsApp. */
function danaTurn(h, l, coversTs, ...delays) {
  for (const d of delays) danaSend(h, l, coversTs, d);
}
/**
 * A hand-over or holding line (lib/dana-wa.mjs `handover`, the outage's one line): a `dana` row WhatsApp took, like an answer,
 * but never the reply guard's and never the reply clock's: the client still waits for a person.
 */
const holdingLine = (h, l, coversTs, delay) => danaSend(h, l, coversTs, delay, { guarded: 0, text: 'Thank you — a member of the Bona team will reply to you shortly.' });
const healthy = {
  brain: { configured: true, health: () => ({ configured: true, ok: true, backup: false }), ops: () => ({ backupTurns: 0 }) },
  waLink: { health: () => ({ linkOk: true, identityOk: true }) },
  viewing: { health: () => ({ enabled: true, gcal: { configured: true, ok: true, lastErrorCode: null } }) },
  mail: { health: () => ({ configured: false, ok: false, lastErrorCode: null, replies: false }) },
};

test('the constants: 08:00 Riyadh, a missed one caught up until 12:00', () => {
  assert.equal(SUMMARY_HOUR, 8);
  assert.equal(CATCH_UP_BEFORE_HOUR, 12);
});

test('07:59 → nothing; 08:00 → one; a restart after 08:00 → none (the marker is set in the same transaction)', async () => {
  const h = harness({ clock: MON_0800 - MIN, settings: { owner_as_client: '1' } });
  assert.deepEqual(h.summary.minute(), { sent: false, reason: 'early' });
  assert.deepEqual(h.rows(), []);
  h.at(MON_0800);
  assert.deepEqual(h.summary.minute(), { sent: true, days: 1 });
  assert.equal(h.team.getSetting('owner_summary_day'), '2026-11-30');
  h.at(MON_0800 + MIN);
  assert.deepEqual(h.summary.minute(), { sent: false, reason: 'done' });
  const restarted = createDailySummary({ db: h.db, team: h.team, notes: createOwnerNotes(h.deps), now: h.now });
  assert.deepEqual(restarted.minute(), { sent: false, reason: 'done' });
  assert.deepEqual(h.rows().map((r) => [r.dedupe_key, r.status]), [['sum:2026-11-30', 'queued']]);
  await h.notes.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^\*Bona — daily summary\* · Mon 30 Nov\n/);
});

test('the marker and the note are one transaction: a note that cannot be written leaves the marker unset', () => {
  const h = harness({ settings: { owner_as_client: '1' } });
  const broken = createDailySummary({ db: h.db, team: h.team, notes: { summary: () => { throw new Error('disk full'); } }, now: h.now });
  assert.throws(() => broken.minute(), /disk full/);
  assert.equal(h.team.getSetting('owner_summary_day'), '');
});

test('down at 08:00 and started at 10:00 → it sends; started at 13:00 → folded into the next day ("covers 2 days")', async () => {
  const ten = harness({ clock: riyadh(2026, 11, 30, 10), settings: { owner_as_client: '1', owner_summary_day: '2026-11-29' } });
  assert.deepEqual(ten.summary.minute(), { sent: true, days: 1 });

  const one = harness({ clock: riyadh(2026, 11, 30, 13), settings: { owner_as_client: '1', owner_summary_day: '2026-11-29' } });
  assert.deepEqual(one.summary.minute(), { sent: false, reason: 'late' });
  one.at(riyadh(2026, 11, 30, 23, 59));
  assert.deepEqual(one.summary.minute(), { sent: false, reason: 'late' });
  one.at(riyadh(2026, 12, 1, 8));
  assert.deepEqual(one.summary.minute(), { sent: true, days: 2 });
  await one.notes.tick();
  assert.match(one.sent[0], /^\*Bona — daily summary\* · Tue 1 Dec · covers 2 days\n/);
  assert.equal(one.rows().length, 1, 'exactly one summary for the two days');
});

test('the first summary ever (no marker yet): down at 08:00 and started at 10:00 → it sends; started at 13:00 → folded into the next day ("covers 2 days")', async () => {
  const ten = harness({ clock: riyadh(2026, 11, 30, 10), settings: { owner_as_client: '1' } });
  assert.deepEqual(ten.summary.minute(), { sent: true, days: 1 });

  const one = harness({ clock: riyadh(2026, 11, 30, 13), settings: { owner_as_client: '1' } });
  assert.deepEqual(one.summary.minute(), { sent: false, reason: 'late' });
  one.at(riyadh(2026, 11, 30, 18));
  assert.deepEqual(one.summary.minute(), { sent: false, reason: 'late' });
  one.at(riyadh(2026, 12, 1, 7, 59));
  assert.deepEqual(one.summary.minute(), { sent: false, reason: 'early' });
  one.at(riyadh(2026, 12, 1, 8));
  assert.deepEqual(one.summary.minute(), { sent: true, days: 2 });
  await one.notes.tick();
  assert.match(one.sent[0], /^\*Bona — daily summary\* · Tue 1 Dec · covers 2 days\n/);
  assert.equal(one.rows().length, 1, 'exactly one summary for the two days');
  one.at(riyadh(2026, 12, 2, 8));
  assert.deepEqual(one.summary.minute(), { sent: true, days: 1 }, 'then one day each');
});

test('#dana summary → a TEST summary now, and the day marker is left alone', async () => {
  const h = harness({ clock: riyadh(2026, 11, 30, 15, 30), settings: { owner_as_client: '1', owner_summary_day: '2026-11-30' } });
  assert.deepEqual(h.summary.test(), { sent: true });
  assert.equal(h.team.getSetting('owner_summary_day'), '2026-11-30');
  assert.equal(h.rows()[0].dedupe_key, `sumtest:${riyadh(2026, 11, 30, 15, 30)}`);
  await h.notes.tick();
  assert.match(h.sent[0], /^\*Bona — daily summary\* · TEST · Mon 30 Nov\n/);
  const fresh = harness({ clock: riyadh(2026, 11, 30, 9), settings: { owner_as_client: '1' } });
  fresh.summary.test();
  assert.equal(fresh.team.getSetting('owner_summary_day'), '', 'unset stays unset');
});

/** The period the Monday 08:00 summary covers: Sunday 08:00 to Monday 08:00. */
function layoutFixture(h) {
  const inPeriod = (hh, mm = 0) => riyadh(2026, 11, 29, hh, mm);
  const mohammed = lead(h, { name: 'Mohammed Example', created: inPeriod(9), inbox_since: inPeriod(9) });
  lead(h, { name: 'New One Example', created: inPeriod(11), inbox_since: inPeriod(11) });
  lead(h, { name: 'New Two Example', created: inPeriod(20), inbox_since: inPeriod(20) });
  lead(h, { name: 'Form Example', channel: 'form', match_method: 'form', inbox_state: null, created: inPeriod(14) });
  lead(h, { name: 'Owner Started Example', match_method: 'owner_outbound', created: inPeriod(15) });
  lead(h, { name: 'Too Early Example', created: riyadh(2026, 11, 29, 7, 59) });
  const sara = lead(h, { name: 'Sara Example' });
  const ali = lead(h, { name: 'Ali Example' });
  lead(h, { name: 'Waiting One Example', needs_human: 1 });
  const waiting = lead(h, { name: 'Waiting Two Example', needs_human: 1 });
  lead(h, { name: 'Left Example', needs_human: 1, inbox_state: 'out' });
  booking(h, mohammed, riyadh(2026, 11, 30, 12), 'BONA-W012');
  booking(h, sara, riyadh(2026, 11, 30, 16), 'BONA-W003');
  booking(h, ali, riyadh(2026, 12, 1, 10), 'BONA-W007');
  danaTurn(h, mohammed, inPeriod(9, 1), 15_000);
  danaTurn(h, sara, inPeriod(12), 21_000, 25_000);
  danaTurn(h, ali, inPeriod(18), 40_000);
  danaTurn(h, ali, riyadh(2026, 11, 30, 8, 30), 5_000); // after the period
  // No answers, each (Codex r9): the hand-over line, a send still in flight, one never confirmed.
  holdingLine(h, waiting, inPeriod(19), 2_000);
  danaSend(h, sara, inPeriod(21), 3_000, { status: 'pending' });
  danaSend(h, ali, inPeriod(21, 30), 4_000, { status: 'uncertain' });
  ensureHandoff(h.db, { leadId: waiting.lead_id, source: 'dana', reason: 'missed', now: inPeriod(19) });
  ensureHandoff(h.db, { leadId: mohammed.lead_id, source: 'form', reason: 'Enquiry received', now: inPeriod(9) });
  h.inbox.noteCandidate({ lid: '123456789012345@lid', name: 'Ahmed Example', ts: inPeriod(22, 10), words: ['villa'], dir: 'in' });
  h.at(MON_0800);
}

test('the layout, one screen, on fixtures with example names (own_inbox on): every line, lid-only rows listed, no email line while mail is off', async () => {
  const h = harness({ clock: MON_0800, settings: { own_inbox: '1', owner_as_client: '1' }, ...healthy });
  layoutFixture(h);
  assert.deepEqual(h.summary.minute(), { sent: true, days: 1 });
  await h.notes.tick();
  assert.equal(h.sent[0], [
    '*Bona — daily summary* · Mon 30 Nov',
    'New clients: 4 (WhatsApp 3 · website form 1) — 1 booked a viewing',
    `Waiting for you: 2 → ${INBOX}`,
    'Viewings today: 12:00 Mohammed Example (W012) · 16:00 Sara Example (W003) | tomorrow: 10:00 Ali Example (W007)',
    'AI: 3 answers · 1 hand-over · median reply 21 s',
    `Not answered by the AI: 1 (outage/limit) → ${INBOX}`,
    'Chats to check: 1 without a phone number (Ahmed Example, 22:10)',
    'Warnings: test mode ON · link ✓ · AI ✓ · calendar ✓',
  ].join('\n'));
  assert.doesNotMatch(h.sent[0], /Email:/);
  assert.doesNotMatch(h.sent[0], /Dana/);
});

test('an AI outage day: twenty holding lines are no answers → "AI: 0 answers", no median, and the twenty chats are "Not answered by the AI" (Codex r9)', () => {
  const h = harness({ settings: { own_inbox: '1' } });
  for (let i = 0; i < 20; i += 1) {
    const at = riyadh(2026, 11, 29, 10, i);
    const l = lead(h, { name: `Outage Example ${i + 1}`, created: at, inbox_since: at });
    holdingLine(h, l, at, 4_000);
    ensureHandoff(h.db, { leadId: l.lead_id, source: 'dana', reason: 'brain', now: at + 4_000 });
  }
  h.at(MON_0800);
  const lines = renderSummary(h.deps, { day: '2026-11-30', days: 1 }, MON_0800).split('\n');
  assert.ok(lines.includes('AI: 0 answers · 20 hand-overs'), lines.join('\n'));
  assert.ok(lines.includes(`Not answered by the AI: 20 (outage/limit) → ${INBOX}`), lines.join('\n'));
  assert.ok(!lines.some((l) => /median reply/.test(l)), 'no reply time made of holding lines');
});

test('a quiet day: zeros and "none", no empty lines', () => {
  const h = harness({ settings: { own_inbox: '1' } });
  const text = renderSummary(h.deps, { day: '2026-11-30', days: 1 }, MON_0800);
  assert.equal(text, [
    '*Bona — daily summary* · Mon 30 Nov',
    'New clients: 0',
    'Waiting for you: 0',
    'Viewings today: none | tomorrow: none',
    'AI: 0 answers · 0 hand-overs',
  ].join('\n'));
});

test('same-release gating, switches off: neither the 08:00 timer nor #dana summary sends a summary', () => {
  const h = harness({ clock: MON_0800 });
  assert.deepEqual(h.summary.minute(), { sent: false, reason: 'off' });
  assert.deepEqual(h.summary.test(), { sent: false, reason: 'off' });
  assert.deepEqual(h.rows(), []);
  assert.equal(h.team.getSetting('owner_summary_day'), '', 'the day is not used up while it is off');
});

test('owner_as_client on, own_inbox off: the summary names the test lead and nobody else (counts only for the rest)', async () => {
  const h = harness({ clock: MON_0800, settings: { owner_as_client: '1' } });
  const tester = lead(h, { name: 'Owner Test Example', inbox_via: 'owner_test', match_method: 'owner_test' });
  const sara = lead(h, { name: 'Sara Example', created: riyadh(2026, 11, 29, 10) });
  const ali = lead(h, { name: 'Ali Example', created: riyadh(2026, 11, 29, 11) });
  booking(h, tester, riyadh(2026, 11, 30, 12), 'BONA-W012');
  booking(h, sara, riyadh(2026, 11, 30, 16), 'BONA-W003');
  booking(h, ali, riyadh(2026, 12, 1, 10), 'BONA-W007');
  h.inbox.noteCandidate({ lid: '123456789012399@lid', name: 'Ahmed Example', ts: riyadh(2026, 11, 29, 22, 10), words: ['villa'], dir: 'in' });
  h.summary.minute();
  await h.notes.tick();
  const text = h.sent[0];
  assert.match(text, /\nViewings today: 12:00 Owner Test Example \(W012\) · 1 other client \| tomorrow: 1 client\n/,
    "another client's viewing is a count: no time, no listing");
  assert.doesNotMatch(text, /16:00|W003|W007|10:00/);
  assert.match(text, /\nChats to check: 1 without a phone number\n/);
  assert.match(text, /\nNew clients: 2 \(WhatsApp 2\)/);
  assert.doesNotMatch(text, /Sara|Ali Example|Ahmed/);
});

test('Warnings, the AI part: ✓ / on backup n× / ✗ <minutes> (from brain.health() and brain.ops())', () => {
  const at = MON_0800;
  const render = (brain, settings = {}) => {
    const h = harness({ settings: { own_inbox: '1', ...settings }, brain });
    return renderSummary(h.deps, { day: '2026-11-30', days: 1 }, at).split('\n').at(-1);
  };
  assert.equal(render(healthy.brain), 'Warnings: AI ✓');
  assert.equal(render({ ...healthy.brain, ops: () => ({ backupTurns: 3 }) }), 'Warnings: AI on backup 3×');
  assert.equal(render({ ...healthy.brain, health: () => ({ configured: true, ok: false, backup: false }) }, { brain_out: String(at - 7 * MIN) }), 'Warnings: AI ✗ 7 min');
  assert.equal(render({ ...healthy.brain, health: () => ({ configured: true, ok: false, backup: false }) }), 'Warnings: AI ✗');
  assert.notEqual(render({ configured: false, health: () => ({ configured: false, ok: false, backup: false }), ops: () => ({}) }).startsWith('Warnings'), true,
    'no brain yet: no AI warning');
  assert.equal(render({ ...healthy.brain, health: () => { throw new Error('x'); } }), 'Warnings: AI ✗', 'a brain that throws reads as down');
});

test('Warnings: link ✗, calendar ✗, mail ✓ when configured; the email line comes with a configured mailbox', () => {
  const h = harness({
    settings: { own_inbox: '1' },
    waLink: { health: () => ({ linkOk: false }) },
    viewing: { health: () => ({ enabled: true, gcal: { configured: true, ok: false, lastErrorCode: 'auth' } }) },
    mail: { health: () => ({ configured: true, ok: true }) },
  });
  const text = renderSummary(h.deps, { day: '2026-11-30', days: 1 }, MON_0800);
  assert.equal(text.split('\n').at(-1), 'Warnings: link ✗ · calendar ✗ · mail ✓');
  assert.match(text, /\nEmail: 0 listed\n/, 'no mail table yet (v9): zero');
});

test('notes held over the day\'s limit, and old Not-a-client chats that wrote, are in the next summary', () => {
  const h = harness({ settings: { own_inbox: '1' } });
  const put = (key, kind, status, meta, ts) => h.db.db.prepare(`INSERT INTO owner_notes (note_id, kind, lead_id, dedupe_key, due_ts, status, meta, created, updated)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(`NOTE-${key}`, kind, null, key, ts, status, JSON.stringify(meta), ts, ts);
  const sun = riyadh(2026, 11, 29, 21);
  put('new:A', 'new_client', 'merged', { over: '2026-11-29' }, sun);
  put('ho:B:offer:1', 'handover', 'merged', { over: '2026-11-29' }, sun);
  put('ho:C:offer:1', 'handover', 'merged', { into: 'NOTE-x' }, sun);
  put('cmd:REC-1', 'command', 'merged', { over: '2026-11-29' }, sun);
  put('al:old_out_wrote:LEAD-1:2026-11-29', 'alert', 'sent', { code: 'old_out_wrote' }, sun);
  put('al:old_out_wrote:CND-1:2026-11-28', 'alert', 'sent', { code: 'old_out_wrote' }, riyadh(2026, 11, 28, 21));
  const text = renderSummary(h.deps, { day: '2026-11-30', days: 1 }, MON_0800);
  assert.match(text, /\nNotes over the day's limit: 3 \(new clients 1 · hand-overs 1 · command replies 1\)(\n|$)/);
  assert.ok(text.split('\n').includes(`Marked Not a client, wrote again: 1 → ${API}/dashboard/inbox?tab=unsure`));
});
