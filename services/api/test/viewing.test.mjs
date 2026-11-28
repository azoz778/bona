/**
 * PR-B1 (PLAN T10 test 3; DESIGN §8.3, §8.4): viewing bookings: validate, commit, cancel, delete,
 * the purge subscription, the worker and the daily reconcile. A fake calendar (or the real client
 * over a fake fetch) only: nothing here reaches Google. Every name, number and address is an
 * example one, and the listings are fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { openDb } from '../lib/db.mjs';
import { createTeam, learnTeamLid } from '../lib/team.mjs';
import { createAudit } from '../lib/audit.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createDashboardRoutes } from '../lib/dashboard/routes.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { calendarTag, calendarTagOf, createGcal, eventIdFor, TOKEN_URL } from '../lib/gcal.mjs';
import { DAY_CAP, confirmationText, createViewing } from '../lib/viewing.mjs';
import { addTask, ensureHandoff, tasksForLead } from '../lib/lead-tasks.mjs';

/** A Riyadh wall-clock time as epoch ms (UTC+3, no daylight saving). */
const R = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 3, min);
const H = 3_600_000;
const DAY = 24 * H;
const NOW = R(2026, 12, 2, 9); // a Wednesday
const SITE = 'https://bona.example.com';
const API_BASE = 'https://api.example.com';
const SLOT = '2026-12-06T10:00+03:00'; // the Sunday after
const SLOT_TS = R(2026, 12, 6, 10);

const jeddah = { en: 'Jeddah', ar: 'جدة' };
const LISTINGS = [
  { id: 'BONA-W901', slug: 'example-villa-exact', status: 'available', title: { en: 'Example villa, Al Shati', ar: 'فيلا مثال، الشاطئ' },
    location: { district: { en: 'Al Shati', ar: 'الشاطئ' }, city: jeddah }, map: { lat: 21.6011, lng: 39.1196 }, mapPrecision: 'exact' },
  { id: 'BONA-W902', slug: 'example-flat-district', status: 'available', title: { en: 'Example flat, Al Rawdah', ar: 'شقة مثال، الروضة' },
    location: { district: { en: 'Al Rawdah', ar: 'الروضة' }, city: jeddah }, map: { lat: 21.55, lng: 39.16 }, mapPrecision: 'district' },
  { id: 'BONA-W903', slug: 'example-plot', status: 'available', title: { en: 'Example plot', ar: 'أرض مثال' },
    location: { district: { en: 'Obhur', ar: 'أبحر' }, city: jeddah }, map: null, mapPrecision: null },
  { id: 'BONA-W904', slug: 'example-riyadh', status: 'available', title: { en: 'Example home, Riyadh', ar: 'منزل مثال، الرياض' },
    location: { district: { en: 'Al Malqa', ar: 'الملقا' }, city: { en: 'Riyadh', ar: 'الرياض' } }, map: { lat: 24.8, lng: 46.6 }, mapPrecision: 'exact' },
  { id: 'BONA-W905', slug: 'example-sold', status: 'sold', title: { en: 'Example sold villa', ar: 'فيلا مباعة' },
    location: { district: { en: 'Al Shati', ar: 'الشاطئ' }, city: jeddah }, map: null, mapPrecision: null },
  { id: 'BONA-W906', slug: 'example-reserved', status: 'reserved', title: { en: 'Example reserved flat', ar: 'شقة محجوزة' },
    location: { district: { en: 'Al Shati', ar: 'الشاطئ' }, city: jeddah }, map: null, mapPrecision: null },
];
const inventory = { siteUrl: SITE, all: () => LISTINGS };

/** A fake calendar with the gcal interface; `events` holds what was inserted. */
function fakeGcal({ busy = [], holidays = new Set(), fail = {} } = {}) {
  const calls = [];
  const events = new Map();
  const gone = new Set();
  return {
    calls, events, gone, fail, configured: true,
    async freeBusy(w) { calls.push(['freeBusy', w]); return fail.freeBusy ? { ok: false, code: fail.freeBusy } : { ok: true, busy: typeof busy === 'function' ? busy() : busy }; },
    async holidays() { calls.push(['holidays']); return fail.holidays ? { ok: false, code: fail.holidays } : { ok: true, dates: holidays }; },
    cachedHolidays: () => holidays,
    async insert(ev) {
      calls.push(['insert', ev]);
      if (fail.insert) return fail.insert;
      events.set(ev.id, { ...ev, status: 'confirmed' });
      return { ok: true, eventId: ev.id };
    },
    async get(id) {
      calls.push(['get', id]);
      if (fail.get) return { ok: false, code: fail.get };
      if (gone.has(id) || !events.has(id)) return { ok: false, code: 'not_found', gone: true };
      return { ok: true, event: events.get(id) };
    },
    async delete(id) {
      calls.push(['delete', id]);
      if (fail.delete) return { ok: false, code: fail.delete };
      events.delete(id);
      return { ok: true };
    },
    async access() { calls.push(['access']); return fail.access ? { ok: false, code: fail.access } : { ok: true, role: 'writer' }; },
    health: () => ({ configured: true, ok: true, lastErrorCode: null }),
  };
}

let phoneSeq = 10;
function setup({ gcal = fakeGcal(), auto = true, booking = '1', clock = { t: NOW } } = {}) {
  const db = openDb(':memory:');
  const team = createTeam(db);
  if (booking) team.setSetting('calendar_booking', booking);
  const logs = [];
  const ownerTest = { autoMode: (lead) => Boolean(lead) && (typeof auto === 'function' ? auto(lead) : auto) };
  const viewing = createViewing({
    db, cfg: { siteUrl: SITE, publicApi: API_BASE }, team, ownerTest, inventory, gcal, now: () => clock.t, log: (o) => logs.push(o),
  });
  const lead = (id = 'LEAD-20261201-0000aaaa', over = {}) => {
    phoneSeq += 1;
    db.insertLead({
      lead_id: id, created: NOW - H, updated: NOW - H, stage: 'new', phone_e164: `966500001${String(phoneSeq).padStart(3, '0')}`, name: 'Sara Example',
      channel: 'whatsapp', inbox_state: 'in', inbox_since: NOW - H, inbox_via: 'own_number', ...over,
    });
    return db.getLead(id);
  };
  const rows = () => db.db.prepare('SELECT * FROM viewing_bookings ORDER BY created, booking_id').all();
  return { db, team, viewing, gcal, clock, logs, lead, rows };
}

/**
 * A finished booking's row written straight into the table (another process, or an earlier day): it
 * has a task id, as every committed booking does. `taskId: null` is a commit that never finished.
 */
function insertRow(db, { id, leadId, start, status = 'booked', listing = 'BONA-W901', created = NOW - DAY, eventId = `bona${id.replace(/[^0-9a-v]/g, '')}0000`, taskId = `task-${id}` }) {
  db.db.prepare(`INSERT INTO viewing_bookings (booking_id, lead_id, task_id, listing_id, start_ts, end_ts, event_id, status, client_told, created, updated)
    VALUES (?,?,?,?,?,?,?,?,0,?,?)`).run(id, leadId, taskId, listing, start, start + H, eventId, status, created, created);
  return eventId;
}

/* ---------------- the stub's contract still holds when nothing is set up ---------------- */

test('without a database or a calendar it answers what the stub answered: nothing bookable, every hook a no-op', async () => {
  const v = createViewing();
  assert.equal(v.configured, false);
  assert.deepEqual(await v.slots({ leadId: 'L-1' }), { bookable: false });
  assert.deepEqual(v.validate({ leadId: 'L-1' }), { ok: false, reason: 'off' });
  assert.deepEqual(await v.commitBooking({ leadId: 'L-1' }), { ok: false, reason: 'off' });
  assert.equal(v.cancelForLead('L-1'), 0);
  assert.equal(v.deleteForLead('L-1'), 0);
  for (const fn of ['onTaskChange', 'onLeadLeaving', 'onPurge', 'tick']) assert.equal(v[fn]('L-1'), undefined, fn);
  assert.deepEqual(v.health(), { enabled: false, gcal: { configured: false, ok: false, lastErrorCode: null } });
  // A config without the calendar's key file or id: not configured, so not enabled even with the switch on.
  const db = openDb(':memory:');
  try {
    const team = createTeam(db);
    team.setSetting('calendar_booking', '1');
    const w = createViewing({ db, cfg: { gcalSaFile: '', gcalCalendarId: '', gcalExtraBusyIds: [] }, team, ownerTest: { autoMode: () => true } });
    assert.equal(w.configured, false);
    assert.deepEqual(w.health(), { enabled: false, gcal: { configured: false, ok: false, lastErrorCode: null } });
    assert.equal(w.tick(), undefined, 'no calendar: the worker has nothing to call');
  } finally { db.close(); }
});

test('booking needs calendar_booking=1 AND auto mode AND a calendar; health says enabled only then', async () => {
  const off = setup({ booking: null });
  try {
    const lead = off.lead();
    assert.deepEqual(off.viewing.validate({ lead, listingId: 'BONA-W901', slotId: SLOT }), { ok: false, reason: 'off' });
    assert.deepEqual(await off.viewing.slots({ lead, listingId: 'BONA-W901' }), { bookable: false });
    assert.deepEqual(await off.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT }), { ok: false, reason: 'off' });
    assert.equal(off.viewing.health().enabled, false);
    assert.equal(off.gcal.calls.length, 0, 'off: no calendar call');
  } finally { off.db.close(); }
  const proof = setup({ auto: false });
  try {
    const lead = proof.lead();
    assert.deepEqual(proof.viewing.validate({ lead, listingId: 'BONA-W901', slotId: SLOT }), { ok: false, reason: 'not_auto' });
    assert.deepEqual(await proof.viewing.slots({ lead, listingId: 'BONA-W901' }), { bookable: false, reason: 'not_auto' });
    assert.deepEqual(await proof.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT }), { ok: false, reason: 'not_auto' });
    assert.equal(proof.viewing.health().enabled, true);
    assert.equal(proof.gcal.calls.length, 0);
    assert.equal(proof.rows().length, 0);
  } finally { proof.db.close(); }
});

/* ---------------- validate ---------------- */

test('validate: the grid, tomorrow+, a published Jeddah listing, a plausible name, one active booking, at most 6 a day; it writes nothing', () => {
  const h = setup();
  try {
    const lead = h.lead();
    const ok = h.viewing.validate({ lead, listingId: 'bona-w901', slotId: SLOT });
    assert.deepEqual(ok, { ok: true, leadId: lead.lead_id, listingId: 'BONA-W901', slotId: SLOT, startTs: SLOT_TS, endTs: SLOT_TS + H, name: 'Sara Example' });
    assert.equal(h.viewing.validate({ leadId: lead.lead_id, listingId: 'BONA-W901', slotId: SLOT }).ok, true, 'by lead id too');
    const reason = (o) => h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: SLOT, ...o }).reason;
    assert.equal(reason({ slotId: '2026-12-06T11:00+03:00' }), 'slot', 'off the grid');
    assert.equal(reason({ slotId: '2026-12-04T10:00+03:00' }), 'slot', 'a Friday');
    assert.equal(reason({ slotId: '2026-12-02T18:00+03:00' }), 'too_soon', 'today');
    assert.equal(reason({ slotId: 'tomorrow at ten' }), 'slot');
    assert.equal(reason({ listingId: 'BONA-W904' }), 'listing', 'Riyadh');
    assert.equal(reason({ listingId: 'BONA-W905' }), 'listing', 'sold');
    assert.equal(reason({ listingId: 'BONA-W906' }), 'listing', 'reserved');
    assert.equal(reason({ listingId: 'BONA-W999' }), 'listing', 'unknown');
    assert.equal(reason({ listingId: 'Example villa' }), 'listing', 'an id, never a loose title match');
    for (const id of ['BONA-W902', 'BONA-W903']) assert.equal(reason({ listingId: id }), undefined, `${id}: district and no pin are bookable`);
    // A name: the lead's, or the one the client just gave.
    const nameless = h.lead('LEAD-20261201-0000bbbb', { name: '😀' });
    assert.deepEqual(h.viewing.validate({ lead: nameless, listingId: 'BONA-W901', slotId: SLOT }), { ok: false, reason: 'need_name', needName: true });
    assert.equal(h.viewing.validate({ lead: nameless, listingId: 'BONA-W901', slotId: SLOT, name: 'A' }).reason, 'need_name');
    assert.equal(h.viewing.validate({ lead: nameless, listingId: 'BONA-W901', slotId: SLOT, name: 'محمد' }).name, 'محمد');
    // One active booking per lead. Another lead's start is taken while its commit holds it (no event in Google
    // yet); a booking Google already shows is left to the live check (the owner may have moved it).
    insertRow(h.db, { id: 'bk-a', leadId: lead.lead_id, start: R(2026, 12, 7, 12) });
    assert.equal(reason({}), 'active_booking');
    const other = h.lead('LEAD-20261201-0000cccc');
    assert.equal(h.viewing.validate({ lead: other, listingId: 'BONA-W901', slotId: '2026-12-07T12:00+03:00' }).ok, true);
    insertRow(h.db, { id: 'bk-hold', leadId: 'LEAD-HOLD', start: R(2026, 12, 7, 14), taskId: null, created: NOW - 30_000 });
    assert.equal(h.viewing.validate({ lead: other, listingId: 'BONA-W901', slotId: '2026-12-07T14:00+03:00' }).reason, 'busy');
    // At most 6 bookings made today, whatever became of them (the hold above is one).
    for (let i = 0; i < DAY_CAP - 2; i += 1) insertRow(h.db, { id: `bk-cap${i}`, leadId: `LEAD-X${i}`, start: R(2026, 12, 8 + i, 10), status: i % 2 ? 'cancelled' : 'booked', created: NOW - H });
    assert.equal(h.viewing.validate({ lead: other, listingId: 'BONA-W901', slotId: SLOT }).ok, true, '5 today: still fine');
    insertRow(h.db, { id: 'bk-cap6', leadId: 'LEAD-X6', start: R(2026, 12, 16, 10), created: NOW - 2 * H });
    assert.equal(DAY_CAP, 6);
    assert.equal(h.viewing.validate({ lead: other, listingId: 'BONA-W901', slotId: SLOT }).reason, 'day_cap');
    const before = h.rows().length;
    h.viewing.validate({ lead: other, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(h.rows().length, before, 'validate writes nothing');
    assert.equal(h.gcal.calls.length, 0, 'and calls nothing');
  } finally { h.db.close(); }
});

/* ---------------- commit ---------------- */

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const CAL = 'owner-calendar@example.com';

test('commitBooking: row → freeBusy re-check → insert → task confirmed → the confirmation text (real client, fake Google)', async () => {
  const seen = [];
  let h;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.href === TOKEN_URL) return json(200, { access_token: 'tok', expires_in: 3599 });
    if (u.pathname.endsWith('/freeBusy')) {
      seen.push(['freeBusy', h.rows().map((r) => r.status), JSON.parse(init.body)]);
      return json(200, { calendars: { [CAL]: { busy: [{ start: '2026-12-06T07:30:00+03:00', end: '2026-12-06T09:30:00+03:00' }] } } });
    }
    if (u.pathname.includes('saudiarabian')) { seen.push(['holidays']); return json(200, { items: [] }); }
    if (init.method === 'POST' && u.pathname.endsWith('/events')) {
      seen.push(['insert', u.searchParams.get('sendUpdates'), JSON.parse(init.body)]);
      return json(200, { ...JSON.parse(init.body), status: 'confirmed' });
    }
    return json(500, {});
  };
  const clock = { t: NOW };
  const gcal = createGcal({ saFile: '/home/example/.secrets/sa.json', calendarId: CAL, readFile: () => JSON.stringify({ client_email: 'robot@example.com', private_key: privateKey }), fetchImpl, now: () => clock.t });
  h = setup({ gcal, clock });
  try {
    const lead = h.lead();
    ensureHandoff(h.db, { leadId: lead.lead_id, details: { viewing_requested: true } });
    const got = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT, language: 'ar' });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.deepEqual(seen.map((s) => s[0]), ['holidays', 'freeBusy', 'insert'], 'the re-check comes before the insert');
    assert.deepEqual(seen[1][1], ['booked'], 'the row is written before the re-check');
    assert.deepEqual(seen[1][2], { timeMin: '2026-12-06T09:30:00+03:00', timeMax: '2026-12-06T11:30:00+03:00', timeZone: 'Asia/Riyadh', items: [{ id: CAL }] });
    const [, sendUpdates, ev] = seen[2];
    assert.equal(sendUpdates, 'none');
    assert.equal(ev.summary, 'Bona viewing · BONA-W901');
    assert.equal(ev.description, [
      `Client: Sara Example · +${lead.phone_e164}`,
      `Home: Example villa, Al Shati ${SITE}/properties/example-villa-exact/`,
      `Lead: ${API_BASE}/dashboard/leads/${lead.lead_id}`,
      "Booked by Bona's AI assistant on WhatsApp",
    ].join('\n'));
    const [row] = h.rows();
    assert.equal(row.status, 'booked');
    assert.equal(row.event_id, ev.id);
    assert.equal(row.start_ts, SLOT_TS);
    assert.equal(row.end_ts, SLOT_TS + H);
    assert.equal(row.client_told, 0, 'told only once the confirmation is accepted (markTold)');
    assert.deepEqual(ev.extendedProperties.private, { bona_lead_id: lead.lead_id, bona_booking_id: row.booking_id, source: 'dana' });
    const task = tasksForLead(h.db, lead.lead_id).find((t) => t.kind === 'viewing');
    assert.equal(task.status, 'confirmed');
    assert.equal(task.due_ts, SLOT_TS);
    assert.deepEqual({ b: task.details.booking_id, l: task.details.listing_id, s: task.details.slot_start }, { b: row.booking_id, l: 'BONA-W901', s: SLOT });
    assert.equal(row.task_id, task.task_id);
    assert.equal(got.text, [
      'تم حجز موعد معاينتك ✅',
      'الأحد 6 ديسمبر، 10:00 صباحاً (ساعة واحدة)',
      `فيلا مثال، الشاطئ — ${SITE}/ar/properties/example-villa-exact/`,
      'الموقع: https://maps.google.com/?q=21.6011,39.1196',
      'لتغيير الموعد أو إلغائه اكتب لنا هنا.',
    ].join('\n'));
    assert.deepEqual({ id: got.bookingId, pin: got.pin, slot: got.slotId }, { id: row.booking_id, pin: 'exact', slot: SLOT });
    assert.equal(h.viewing.markTold(row.booking_id), true);
    assert.equal(h.rows()[0].client_told, 1);
    assert.deepEqual(h.viewing.health(), { enabled: true, gcal: { configured: true, ok: true, lastErrorCode: null } });
    assert.doesNotMatch(JSON.stringify(h.logs), /Sara|9665|owner-calendar|robot/, 'logs carry ids and codes only');
  } finally { h.db.close(); }
});

test('the confirmation text: AR/EN; a maps link for an exact pin, the meeting-point line for a district pin or none', () => {
  const [exact, district, none] = LISTINGS;
  const at = R(2026, 11, 29, 14);
  assert.equal(confirmationText({ listing: district, startTs: at, language: 'en', siteUrl: SITE }), [
    'Your viewing is booked ✅',
    'Sunday 29 November, 2:00 pm (one hour)',
    `Example flat, Al Rawdah — ${SITE}/properties/example-flat-district/`,
    'Location: our team will send you the meeting point before the viewing',
    'To change or cancel, write to us here.',
  ].join('\n'));
  assert.equal(confirmationText({ listing: district, startTs: at, language: 'ar', siteUrl: SITE }), [
    'تم حجز موعد معاينتك ✅',
    'الأحد 29 نوفمبر، 2:00 ظهراً (ساعة واحدة)',
    `شقة مثال، الروضة — ${SITE}/ar/properties/example-flat-district/`,
    'الموقع: يرسل لك فريقنا نقطة اللقاء قبل الموعد',
    'لتغيير الموعد أو إلغائه اكتب لنا هنا.',
  ].join('\n'));
  assert.match(confirmationText({ listing: exact, startTs: at, language: 'en', siteUrl: SITE }), /\nLocation: https:\/\/maps\.google\.com\/\?q=21\.6011,39\.1196\n/);
  assert.match(confirmationText({ listing: none, startTs: at, language: 'en', siteUrl: SITE }), /\nLocation: our team will send you the meeting point before the viewing\n/);
  for (const l of LISTINGS.slice(0, 3)) {
    for (const lang of ['ar', 'en']) {
      const text = confirmationText({ listing: l, startTs: at, language: lang, siteUrl: SITE });
      assert.ok((text.match(/https?:\/\//g) ?? []).length <= 2, 'within MAX_LINKS (2)');
      assert.doesNotMatch(text, /Dana|دانة/);
    }
  }
});

test('a busy re-check deletes the row and answers busy; nothing is inserted', async () => {
  const h = setup({ gcal: fakeGcal({ busy: [{ start: R(2026, 12, 6, 9), end: R(2026, 12, 6, 9, 31) }] }) });
  try {
    const lead = h.lead();
    assert.deepEqual(await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT }), { ok: false, reason: 'busy' });
    assert.equal(h.rows().length, 0);
    assert.equal(h.gcal.calls.some((c) => c[0] === 'insert'), false);
    assert.equal(tasksForLead(h.db, lead.lead_id).length, 0);
  } finally { h.db.close(); }
  // A calendar that cannot be read fails closed the same way; a holiday too.
  for (const [g, reason] of [[fakeGcal({ fail: { freeBusy: 'timeout' } }), 'calendar'], [fakeGcal({ fail: { holidays: 'auth' } }), 'calendar'],
    [fakeGcal({ holidays: new Set(['2026-12-06']) }), 'holiday']]) {
    const k = setup({ gcal: g });
    try {
      const got = await k.viewing.commitBooking({ lead: k.lead(), listingId: 'BONA-W901', slotId: SLOT });
      assert.equal(got.ok, false);
      assert.equal(got.reason, reason);
      assert.equal(k.rows().length, 0);
    } finally { k.db.close(); }
  }
});

test('an insert failure deletes the row; one that may have gone through leaves it cancel_pending, so the worker removes any event', async () => {
  const h = setup({ gcal: fakeGcal({ fail: { insert: { ok: false, code: 'forbidden', uncertain: false } } }) });
  try {
    const lead = h.lead();
    const got = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    assert.deepEqual(got, { ok: false, reason: 'insert_failed', code: 'forbidden' });
    assert.equal(h.rows().length, 0, 'row deleted');
    assert.equal(tasksForLead(h.db, lead.lead_id).length, 0, 'no task confirmed');
    // A timeout: the event may exist; the row is kept as cancel_pending, never booked.
    h.gcal.fail.insert = { ok: false, code: 'timeout', uncertain: true };
    assert.deepEqual(await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT }), { ok: false, reason: 'insert_failed', code: 'timeout' });
    assert.deepEqual(h.rows().map((r) => r.status), ['cancel_pending']);
    await h.viewing.tick();
    assert.deepEqual(h.rows().map((r) => r.status), ['cancelled']);
    // The lead can book that slot again: a new event id, since Google keeps a deleted one's.
    delete h.gcal.fail.insert;
    const again = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(again.ok, true);
    const ids = h.rows().map((r) => r.event_id);
    assert.equal(new Set(ids).size, 2);
  } finally { h.db.close(); }
});

test('a second active booking, or the same start for another lead, is refused by the DB', async () => {
  const h = setup();
  try {
    const a = h.lead('LEAD-20261201-0000aaaa');
    const b = h.lead('LEAD-20261201-0000bbbb');
    assert.equal((await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT })).ok, true);
    assert.deepEqual(await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W902', slotId: '2026-12-07T10:00+03:00' }), { ok: false, reason: 'active_booking' });
    assert.deepEqual(await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W902', slotId: SLOT }), { ok: false, reason: 'busy' });
    // The partial unique indexes are the last word, whoever writes.
    assert.throws(() => insertRow(h.db, { id: 'bk-dup-lead', leadId: a.lead_id, start: R(2026, 12, 9, 10) }), /UNIQUE/);
    assert.throws(() => insertRow(h.db, { id: 'bk-dup-slot', leadId: b.lead_id, start: SLOT_TS }), /UNIQUE/);
    assert.equal(h.rows().length, 1);
    // Two commits at once for the same slot: one wins, the other is refused.
    const c = h.lead('LEAD-20261201-0000cccc');
    const d = h.lead('LEAD-20261201-0000dddd');
    const both = await Promise.all([
      h.viewing.commitBooking({ lead: c, listingId: 'BONA-W901', slotId: '2026-12-08T12:00+03:00' }),
      h.viewing.commitBooking({ lead: d, listingId: 'BONA-W901', slotId: '2026-12-08T12:00+03:00' }),
    ]);
    assert.deepEqual(both.map((x) => x.ok), [true, false]);
    assert.equal(both[1].reason, 'busy');
  } finally { h.db.close(); }
});

test('a past booked row turns done before the reserve, once its event says it is over, so a returning client can book again', async () => {
  const clock = { t: NOW };
  const h = setup({ clock });
  try {
    const lead = h.lead();
    const old = insertRow(h.db, { id: 'bk-old', leadId: lead.lead_id, start: R(2026, 11, 30, 10), created: NOW - 5 * DAY });
    h.gcal.events.set(old, { id: old, status: 'confirmed', start: { dateTime: '2026-11-30T10:00:00+03:00' }, end: { dateTime: '2026-11-30T11:00:00+03:00' } });
    clock.t = NOW; // the old viewing (30 Nov) is over
    assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: SLOT }).ok, true, 'a past booking is not active');
    const got = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(got.ok, true);
    assert.deepEqual(h.rows().map((r) => [r.booking_id === 'bk-old' ? 'old' : 'new', r.status]), [['old', 'done'], ['new', 'booked']]);
  } finally { h.db.close(); }
});

test('the past booking turns done in the SAME transaction as the reserve: a reserve the start index refuses rolls it back', async () => {
  const h = setup();
  try {
    const lead = h.lead('LEAD-20261201-0000aaaa');
    const other = h.lead('LEAD-20261201-0000bbbb');
    const old = insertRow(h.db, { id: 'bk-old', leadId: lead.lead_id, start: R(2026, 11, 30, 10), created: NOW - 5 * DAY });
    h.gcal.events.set(old, { id: old, status: 'confirmed', start: { dateTime: '2026-11-30T10:00:00+03:00' }, end: { dateTime: '2026-11-30T11:00:00+03:00' } });
    // Another client's booking stored at the start, and still there in Google: validate passes (no stored time
    // decides it), the read finds it where it is, and the unique start index refuses the reserve.
    const theirs = insertRow(h.db, { id: 'bk-theirs', leadId: other.lead_id, start: SLOT_TS });
    h.gcal.events.set(theirs, { id: theirs, status: 'confirmed', start: { dateTime: '2026-12-06T10:00:00+03:00' }, end: { dateTime: '2026-12-06T11:00:00+03:00' } });
    assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: SLOT }).ok, true);
    assert.deepEqual(await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT }), { ok: false, reason: 'busy' });
    const statusOf = (id) => h.rows().find((r) => r.booking_id === id).status;
    assert.equal(h.gcal.calls.filter((c) => c[0] === 'get' && c[1] === old).length, 1, 'its event was read: it is over');
    assert.equal(statusOf('bk-old'), 'booked', 'the refused reserve took the done with it');
    assert.deepEqual(h.rows().map((r) => r.booking_id), ['bk-old', 'bk-theirs'], 'no new row');
    assert.equal(h.gcal.calls.filter((c) => c[0] === 'insert').length, 0);
    // Another start: the same transaction turns it done and reserves the new booking.
    const got = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: '2026-12-06T12:00+03:00' });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(statusOf('bk-old'), 'done');
    assert.equal(statusOf(got.bookingId), 'booked');
  } finally { h.db.close(); }
});

test('a name the client gave in book_viewing is saved on a lead that had none; a lead that already has one keeps it', async () => {
  const h = setup();
  try {
    const nameless = h.lead('LEAD-20261201-0000aaaa', { name: null });
    const got = await h.viewing.commitBooking({ lead: nameless, listingId: 'BONA-W902', slotId: SLOT, name: 'Omar Example', language: 'en' });
    assert.equal(got.ok, true);
    assert.equal(h.db.getLead(nameless.lead_id).name, 'Omar Example');
    assert.match(h.gcal.calls.find((c) => c[0] === 'insert')[1].description, /^Client: Omar Example · \+966500001\d{3}\n/);
    assert.match(got.text, /^Your viewing is booked ✅\nSunday 6 December, 10:00 am \(one hour\)\n/);
    // A lead with a name keeps it; the event names whom the client said the viewing is for.
    const named = h.lead('LEAD-20261201-0000bbbb', { name: 'Sara Example' });
    assert.equal((await h.viewing.commitBooking({ lead: named, listingId: 'BONA-W901', slotId: '2026-12-07T10:00+03:00', name: 'Huda Example' })).ok, true);
    assert.equal(h.db.getLead(named.lead_id).name, 'Sara Example');
    assert.match(h.gcal.calls.filter((c) => c[0] === 'insert').at(-1)[1].description, /^Client: Huda Example · /);
  } finally { h.db.close(); }
});

/* ---------------- cancel, delete, purge, worker ---------------- */

test('cancelForLead marks booked rows cancel_pending (and their task cancelled); the worker treats 404 as done and retries a 500', async () => {
  const h = setup();
  try {
    const lead = h.lead();
    const got = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    const eventId = h.rows()[0].event_id;
    insertRow(h.db, { id: 'bk-done', leadId: lead.lead_id, start: R(2026, 11, 25, 10), status: 'done', created: NOW - 9 * DAY });
    assert.equal(h.viewing.cancelForLead(lead.lead_id), 1, 'booked rows only');
    assert.deepEqual(h.rows().map((r) => [r.booking_id === got.bookingId, r.status]).sort(), [[false, 'done'], [true, 'cancel_pending']]);
    assert.equal(tasksForLead(h.db, lead.lead_id).find((t) => t.kind === 'viewing').status, 'cancelled');
    assert.equal(h.gcal.calls.filter((c) => c[0] === 'delete').length, 0, 'marking never calls Google');
    h.gcal.fail.delete = 'bad_response';
    await h.viewing.tick();
    assert.equal(h.rows().find((r) => r.booking_id === got.bookingId).status, 'cancel_pending', 'a 500 keeps it for the next run');
    delete h.gcal.fail.delete;
    h.gcal.gone.add(eventId);
    h.gcal.events.delete(eventId);
    await h.viewing.tick();
    assert.equal(h.rows().find((r) => r.booking_id === got.bookingId).status, 'cancelled');
    assert.deepEqual(h.gcal.calls.filter((c) => c[0] === 'delete').map((c) => c[1]), [eventId, eventId]);
    await h.viewing.tick();
    assert.equal(h.gcal.calls.filter((c) => c[0] === 'delete').length, 2, 'done once cancelled');
  } finally { h.db.close(); }
});

test('deleteForLead: the booked AND the done row go cancel_pending, and the worker deletes both events', async () => {
  const h = setup();
  try {
    const lead = h.lead();
    await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    const doneId = insertRow(h.db, { id: 'bk-done', leadId: lead.lead_id, start: R(2026, 11, 25, 10), status: 'done', created: NOW - 9 * DAY });
    h.gcal.events.set(doneId, { id: doneId, status: 'confirmed' });
    insertRow(h.db, { id: 'bk-gone', leadId: lead.lead_id, start: R(2026, 11, 20, 10), status: 'cancelled', created: NOW - 12 * DAY });
    assert.equal(h.viewing.deleteForLead(lead.lead_id), 2);
    assert.deepEqual(h.rows().map((r) => r.status).sort(), ['cancel_pending', 'cancel_pending', 'cancelled']);
    await h.viewing.tick();
    assert.deepEqual(h.rows().map((r) => r.status), ['cancelled', 'cancelled', 'cancelled']);
    assert.equal(h.gcal.events.size, 0, 'both events are gone from the calendar');
    // cancelForLead alone would have left the done one.
    const k = setup();
    try {
      const l2 = k.lead();
      const id2 = insertRow(k.db, { id: 'bk-done2', leadId: l2.lead_id, start: R(2026, 11, 25, 10), status: 'done' });
      k.gcal.events.set(id2, { id: id2 });
      assert.equal(k.viewing.cancelForLead(l2.lead_id), 0);
      assert.equal(k.rows()[0].status, 'done');
    } finally { k.db.close(); }
  } finally { h.db.close(); }
});

test('the onPurge subscription: purgeLead (through leaveInbox) marks the booked rows inside its transaction, with no network call', async () => {
  const h = setup();
  try {
    const lead = h.lead();
    await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    const callsBefore = h.gcal.calls.length;
    let inTx = null;
    const inbox = createInboxStore(h.db, { onPurge: (id) => { inTx = h.db.db.isTransaction; h.viewing.onPurge(id); } });
    inbox.leaveInbox(lead.lead_id);
    assert.equal(inTx, true);
    assert.deepEqual(h.rows().map((r) => r.status), ['cancel_pending']);
    assert.equal(h.gcal.calls.length, callsBefore, 'no call inside the purge');
    // A purge that fails after the mark takes the mark back with it.
    const k = setup();
    try {
      const l2 = k.lead();
      await k.viewing.commitBooking({ lead: l2, listingId: 'BONA-W901', slotId: SLOT });
      const boom = createInboxStore(k.db, { onPurge: (id) => { k.viewing.onPurge(id); throw new Error('later subscriber failed'); } });
      assert.throws(() => boom.leaveInbox(l2.lead_id), /later subscriber failed/);
      assert.deepEqual(k.rows().map((r) => r.status), ['booked']);
    } finally { k.db.close(); }
  } finally { h.db.close(); }
});

test('reconcile: a moved event updates start, end and the task due_ts; a deleted one → cancelled (task too)', async () => {
  const clock = { t: NOW };
  const h = setup({ clock });
  try {
    const a = h.lead('LEAD-20261201-0000aaaa');
    const b = h.lead('LEAD-20261201-0000bbbb');
    const ga = await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    const gb = await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W902', slotId: '2026-12-07T12:00+03:00' });
    const rowOf = (id) => h.rows().find((r) => r.booking_id === id);
    // The owner moves A's viewing by an hour and a half in Google, and deletes B's.
    const ev = h.gcal.events.get(rowOf(ga.bookingId).event_id);
    ev.start = { dateTime: '2026-12-06T11:30:00+03:00', timeZone: 'Asia/Riyadh' };
    ev.end = { dateTime: '2026-12-06T12:30:00+03:00', timeZone: 'Asia/Riyadh' };
    h.gcal.events.get(rowOf(gb.bookingId).event_id).status = 'cancelled';
    const out = await h.viewing.reconcile();
    assert.deepEqual(out, { checked: 2, moved: 1, cancelled: 1, held: 0 });
    assert.equal(rowOf(ga.bookingId).start_ts, R(2026, 12, 6, 11, 30));
    assert.equal(rowOf(ga.bookingId).end_ts, R(2026, 12, 6, 12, 30));
    assert.equal(rowOf(ga.bookingId).status, 'booked');
    assert.equal(tasksForLead(h.db, a.lead_id).find((t) => t.kind === 'viewing').due_ts, R(2026, 12, 6, 11, 30));
    assert.equal(rowOf(gb.bookingId).status, 'cancelled');
    assert.equal(tasksForLead(h.db, b.lead_id).find((t) => t.kind === 'viewing').status, 'cancelled');
    // An event removed outright (404) is cancelled too, while the calendar still shows another booking's
    // event; a calendar that cannot be read changes nothing.
    const c = h.lead('LEAD-20261201-0000cccc');
    const gc = await h.viewing.commitBooking({ lead: c, listingId: 'BONA-W903', slotId: '2026-12-08T10:00+03:00' });
    h.gcal.events.delete(rowOf(ga.bookingId).event_id);
    h.gcal.fail.get = 'timeout';
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 0, held: 0 });
    assert.equal(rowOf(ga.bookingId).status, 'booked');
    delete h.gcal.fail.get;
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 0, cancelled: 1, held: 0 });
    assert.equal(rowOf(ga.bookingId).status, 'cancelled');
    assert.equal(rowOf(gc.bookingId).status, 'booked');
    assert.equal(h.viewing.health().gcal.ok, true);
  } finally { h.db.close(); }
});

test('a booking the owner moved in Google never blocks its first start: the same lead books that start again, under a new event id', async () => {
  const TUE = '2026-12-08T10:00+03:00';
  const clock = { t: NOW };
  const h = setup({ clock });
  try {
    const lead = h.lead();
    const first = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: TUE });
    assert.equal(first.ok, true);
    // The owner moves it to Sunday 12:00 in Google; reconcile follows the calendar.
    const ev = h.gcal.events.get(first.eventId);
    ev.start = { dateTime: '2026-12-06T12:00:00+03:00', timeZone: 'Asia/Riyadh' };
    ev.end = { dateTime: '2026-12-06T13:00:00+03:00', timeZone: 'Asia/Riyadh' };
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 1, cancelled: 0, held: 0 });
    // Monday: that viewing is over, and the client asks for Tuesday 10:00 again.
    clock.t = R(2026, 12, 7, 9);
    const again = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: TUE });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.notEqual(again.eventId, first.eventId);
    assert.deepEqual(h.rows().map((r) => [r.event_id, r.status]), [[first.eventId, 'done'], [again.eventId, 'booked']]);
    assert.equal(h.logs.some((l) => l.evt === 'viewing.reserve_failed'), false);
  } finally { h.db.close(); }
  // Moved later, then cancelled, twice over: each new booking of the first start takes an id no row holds yet.
  const kc = { t: NOW };
  const k = setup({ clock: kc });
  try {
    const lead = k.lead();
    const first = await k.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: TUE });
    const ev = k.gcal.events.get(first.eventId);
    ev.start = { dateTime: '2026-12-09T14:00:00+03:00' };
    ev.end = { dateTime: '2026-12-09T15:00:00+03:00' };
    assert.equal((await k.viewing.reconcile()).moved, 1);
    for (let i = 0; i < 2; i += 1) {
      kc.t += 60_000;
      assert.equal(k.viewing.cancelForLead(lead.lead_id), 1);
      await k.viewing.tick();
      const again = await k.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: TUE });
      assert.equal(again.ok, true, JSON.stringify(again));
    }
    const ids = k.rows().map((r) => r.event_id);
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(k.rows().map((r) => r.status), ['cancelled', 'cancelled', 'booked']);
  } finally { k.db.close(); }
});

test('a calendar the robot can no longer see (unshared: every event call 404) changes no row and cancels no task; health says not_found', async () => {
  const state = { shared: true, role: 'writer' };
  const events = new Map();
  const deletes = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const notFound = () => json(404, { error: { code: 404, errors: [{ domain: 'global', reason: 'notFound' }] } });
  const base = `/calendar/v3/calendars/${encodeURIComponent(CAL)}/events`;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    if (u.href === TOKEN_URL) return json(200, { access_token: 'tok', expires_in: 3599 });
    if (u.pathname.includes('saudiarabian')) return json(200, { items: [] }); // the public feed answers either way
    if (u.pathname.endsWith('/freeBusy')) {
      return json(200, { calendars: { [CAL]: state.shared ? { busy: [] } : { errors: [{ domain: 'global', reason: 'notFound' }] } } });
    }
    if (method === 'DELETE') deletes.push(u.pathname);
    if (!state.shared) return notFound();
    if (method === 'GET' && u.pathname === base) return json(200, { accessRole: state.role });
    if (method === 'POST' && u.pathname === base) {
      const ev = JSON.parse(init.body);
      events.set(ev.id, { ...ev, status: 'confirmed' });
      return json(200, events.get(ev.id));
    }
    const id = u.pathname.slice(base.length + 1);
    if (method === 'GET') return events.has(id) ? json(200, events.get(id)) : notFound();
    if (method === 'DELETE') {
      if (!events.has(id)) return notFound();
      events.delete(id);
      return new Response(null, { status: 204 });
    }
    return json(500, {});
  };
  const clock = { t: NOW };
  const gcal = createGcal({ saFile: '/home/example/.secrets/sa.json', calendarId: CAL, readFile: () => JSON.stringify({ client_email: 'robot@example.com', private_key: privateKey }), fetchImpl, now: () => clock.t });
  const h = setup({ gcal, clock });
  try {
    const a = h.lead('LEAD-20261201-0000aaaa');
    const b = h.lead('LEAD-20261201-0000bbbb');
    const ga = await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    const gb = await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W902', slotId: '2026-12-07T12:00+03:00' });
    assert.equal(ga.ok && gb.ok, true);
    assert.equal(h.viewing.cancelForLead(b.lead_id), 1, "B's booking waits for the worker");
    const statusOf = (id) => h.rows().find((r) => r.booking_id === id).status;
    const taskOf = (lead) => tasksForLead(h.db, lead.lead_id).find((t) => t.kind === 'viewing').status;
    // The owner stops sharing the calendar with the robot (or shares free/busy only): nothing changes.
    for (const [shared, role, code] of [[false, 'writer', 'not_found'], [true, 'freeBusyReader', 'forbidden'], [true, 'reader', 'forbidden']]) {
      Object.assign(state, { shared, role });
      assert.deepEqual(await h.viewing.reconcile(), { checked: 0, moved: 0, cancelled: 0, held: 0 }, code);
      await h.viewing.tick();
      assert.equal(statusOf(ga.bookingId), 'booked', code);
      assert.equal(taskOf(a), 'confirmed', code);
      assert.equal(statusOf(gb.bookingId), 'cancel_pending', `${code}: still the worker's, its event still to delete`);
      assert.equal(deletes.length, 0, code);
      assert.deepEqual(h.viewing.health(), { enabled: true, gcal: { configured: true, ok: false, lastErrorCode: code } });
    }
    // Shared again: the worker deletes B's event, reconcile finds A's.
    Object.assign(state, { shared: true, role: 'writer' });
    await h.viewing.tick();
    assert.equal(statusOf(gb.bookingId), 'cancelled');
    assert.equal(deletes.length, 1);
    assert.equal(events.has(gb.eventId), false);
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 0, held: 0 });
    assert.equal(statusOf(ga.bookingId), 'booked');
    assert.deepEqual(h.viewing.health(), { enabled: true, gcal: { configured: true, ok: true, lastErrorCode: null } });
    assert.doesNotMatch(JSON.stringify(h.logs), /Sara|9665|owner-calendar|robot/, 'logs carry ids and codes only');
  } finally { h.db.close(); }
});

test("a calendar that shows none of the bookings' events (another calendar id) holds the reconcile: nothing is cancelled, and health says not_found", async () => {
  const h = setup();
  try {
    const a = h.lead('LEAD-20261201-0000aaaa');
    const b = h.lead('LEAD-20261201-0000bbbb');
    const ga = await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    const gb = await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W902', slotId: '2026-12-07T12:00+03:00' });
    const statusOf = (id) => h.rows().find((r) => r.booking_id === id).status;
    const saved = new Map(h.gcal.events);
    h.gcal.events.clear(); // the calendar now named holds none of them: every get is a 404
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 0, cancelled: 0, held: 2 });
    assert.deepEqual([statusOf(ga.bookingId), statusOf(gb.bookingId)], ['booked', 'booked']);
    assert.deepEqual([a, b].map((l) => tasksForLead(h.db, l.lead_id).find((t) => t.kind === 'viewing').status), ['confirmed', 'confirmed']);
    assert.deepEqual(h.viewing.health(), { enabled: true, gcal: { configured: true, ok: false, lastErrorCode: 'not_found' } });
    assert.ok(h.logs.some((l) => l.evt === 'viewing.reconcile_held' && l.gone === 2));
    // The right calendar again, where the owner deleted A's viewing (Google's get returns it as cancelled): A goes, the hold lifts.
    for (const [id, ev] of saved) h.gcal.events.set(id, ev);
    h.gcal.events.get(ga.eventId).status = 'cancelled';
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 0, cancelled: 1, held: 0 });
    assert.equal(statusOf(ga.bookingId), 'cancelled');
    assert.equal(statusOf(gb.bookingId), 'booked');
    assert.deepEqual(h.viewing.health(), { enabled: true, gcal: { configured: true, ok: true, lastErrorCode: null } });
    // A lone booking whose event is a 404 is held too: a 404 is not how Google reports a deleted event.
    h.gcal.events.delete(gb.eventId);
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 0, held: 1 });
    assert.equal(statusOf(gb.bookingId), 'booked');
    assert.equal(h.viewing.health().gcal.lastErrorCode, 'not_found');
    // The worker never runs on a calendar the robot cannot manage either.
    h.gcal.fail.access = 'not_found';
    h.viewing.cancelForLead(b.lead_id);
    await h.viewing.tick();
    assert.equal(statusOf(gb.bookingId), 'cancel_pending');
    assert.equal(h.gcal.calls.some((c) => c[0] === 'delete'), false);
  } finally { h.db.close(); }
});

test("a purge, the worker and reconcile while the insert is on its way: the row waits for Google's answer, then its event is deleted (never left behind)", async () => {
  const gcal = fakeGcal();
  const insert = gcal.insert;
  const gate = { on: false, release: null, lost: false };
  gcal.insert = async (ev) => {
    if (gate.on) await new Promise((resolve) => { gate.release = resolve; });
    if (gate.lost) { // it went through, but the answer was lost
      gcal.events.set(ev.id, { ...ev, status: 'confirmed' });
      return { ok: false, code: 'timeout', uncertain: true };
    }
    return insert(ev);
  };
  const inFlight = async () => {
    for (let i = 0; i < 200 && !gate.release; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(gate.release, 'the commit reached the insert');
  };
  const answer = () => { const r = gate.release; gate.release = null; r(); };
  const h = setup({ gcal });
  try {
    const rowOf = (leadId) => h.rows().find((r) => r.lead_id === leadId);
    const deletes = () => gcal.calls.filter((c) => c[0] === 'delete').map((c) => c[1]);
    // Another booking the calendar shows, so a reconcile would read a 404 as deleted.
    const o = h.lead('LEAD-20261201-0000eeee');
    assert.equal((await h.viewing.commitBooking({ lead: o, listingId: 'BONA-W902', slotId: '2026-12-07T12:00+03:00' })).ok, true);
    gate.on = true;

    // 1. The lead leaves (a purge) and the worker runs before Google answers the insert.
    const a = h.lead('LEAD-20261201-0000aaaa');
    const pa = h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    await inFlight();
    h.viewing.onPurge(a.lead_id);
    assert.equal(rowOf(a.lead_id).status, 'cancel_pending');
    await h.viewing.tick();
    assert.deepEqual(deletes(), [], 'the worker leaves a row whose insert has not answered');
    answer();
    assert.deepEqual(await pa, { ok: false, reason: 'cancelled' });
    const eventA = rowOf(a.lead_id).event_id;
    assert.equal(gcal.events.has(eventA), true, 'the event landed');
    assert.equal(rowOf(a.lead_id).status, 'cancel_pending');
    await h.viewing.tick();
    assert.deepEqual(deletes(), [eventA]);
    assert.equal(gcal.events.has(eventA), false);
    assert.equal(rowOf(a.lead_id).status, 'cancelled');

    // 2. reconcile runs before Google answers: it skips the row (its 404 is no deletion), and the booking stands.
    const b = h.lead('LEAD-20261201-0000bbbb');
    const pb = h.viewing.commitBooking({ lead: b, listingId: 'BONA-W903', slotId: '2026-12-08T10:00+03:00' });
    await inFlight();
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 0, held: 0 });
    answer();
    assert.equal((await pb).ok, true);
    assert.equal(rowOf(b.lead_id).status, 'booked');
    assert.equal(tasksForLead(h.db, b.lead_id).find((t) => t.kind === 'viewing').status, 'confirmed');

    // 3. An insert that went through but lost its answer, with a purge and a worker run in between.
    gate.lost = true;
    const c = h.lead('LEAD-20261201-0000cccc');
    const pc = h.viewing.commitBooking({ lead: c, listingId: 'BONA-W901', slotId: '2026-12-09T10:00+03:00' });
    await inFlight();
    h.viewing.onPurge(c.lead_id);
    await h.viewing.tick();
    assert.deepEqual(deletes(), [eventA]);
    answer();
    assert.deepEqual(await pc, { ok: false, reason: 'insert_failed', code: 'timeout' });
    const eventC = rowOf(c.lead_id).event_id;
    assert.equal(rowOf(c.lead_id).status, 'cancel_pending');
    await h.viewing.tick();
    assert.equal(gcal.events.has(eventC), false, 'no event is left behind');
    assert.equal(rowOf(c.lead_id).status, 'cancelled');
  } finally { h.db.close(); }
});

test('a purge, Not a client, the lead gone or booking off while the re-check is on its way: no insert at all (nothing personal reaches Google), the row ends cancelled', async () => {
  const gcal = fakeGcal();
  const held = { holidays: false, freeBusy: false, release: null };
  for (const op of ['holidays', 'freeBusy']) {
    const real = gcal[op];
    gcal[op] = async (...args) => {
      if (held[op]) { held[op] = false; await new Promise((resolve) => { held.release = resolve; }); }
      return real(...args);
    };
  }
  const reached = async () => {
    for (let i = 0; i < 200 && !held.release; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(held.release, 'the commit reached the re-check');
  };
  const answer = () => { const r = held.release; held.release = null; r(); };
  const h = setup({ gcal });
  try {
    const rowOf = (leadId) => h.rows().find((r) => r.lead_id === leadId);
    const inserts = () => gcal.calls.filter((c) => c[0] === 'insert');
    const cases = [
      ['a purge (leaving the inbox, the retention purge, the test switch off)', 'freeBusy', 'LEAD-20261201-0000aaaa', (id) => h.viewing.onPurge(id)],
      ['Not a client (deleteForLead)', 'holidays', 'LEAD-20261201-0000bbbb', (id) => h.viewing.onLeadLeaving(id)],
      ['the lead row gone', 'freeBusy', 'LEAD-20261201-0000cccc', (id) => h.db.db.prepare('DELETE FROM leads WHERE lead_id = ?').run(id)],
      ['calendar booking switched off', 'freeBusy', 'LEAD-20261201-0000dddd', () => h.team.setSetting('calendar_booking', '0')],
    ];
    for (const [what, op, id, act] of cases) {
      const lead = h.lead(id);
      held[op] = true;
      const p = h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
      await reached();
      assert.equal(rowOf(id).status === 'booked' || rowOf(id).status === 'cancel_pending', true, what);
      act(id);
      answer();
      assert.deepEqual(await p, { ok: false, reason: 'cancelled' }, what);
      assert.equal(inserts().length, 0, `${what}: no insert was called`);
      assert.equal(gcal.events.size, 0, what);
      assert.equal(rowOf(id).status, 'cancelled', `${what}: no event was sent, so there is none to delete`);
      assert.equal(tasksForLead(h.db, id).some((t) => t.kind === 'viewing'), false, `${what}: no task`);
      h.team.setSetting('calendar_booking', '1');
    }
    await h.viewing.tick();
    assert.equal(gcal.calls.some((c) => c[0] === 'delete'), false, 'the worker has nothing to delete');
    // The start is free again: the next client books it.
    const next = h.lead('LEAD-20261201-0000eeee');
    assert.equal((await h.viewing.commitBooking({ lead: next, listingId: 'BONA-W901', slotId: SLOT })).ok, true);
    assert.doesNotMatch(JSON.stringify(h.logs), /Sara|9665/, 'logs carry ids and codes only');
  } finally { h.db.close(); }

  // The real client: the token runs out while freeBusy answers, so the insert mints a new one first,
  // and the purge lands during that mint. The client asks again right before the request: nothing goes out.
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const hold = { token: false, freeBusy: false, release: null };
  const posts = [];
  let mints = 0;
  const pause = () => new Promise((resolve) => { hold.release = resolve; });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.href === TOKEN_URL) {
      mints += 1;
      if (hold.token) { hold.token = false; await pause(); }
      return json(200, { access_token: `tok-${mints}`, expires_in: 3599 });
    }
    if (u.pathname.includes('saudiarabian')) return json(200, { items: [] });
    if (u.pathname.endsWith('/freeBusy')) {
      if (hold.freeBusy) { hold.freeBusy = false; await pause(); }
      return json(200, { calendars: { [CAL]: { busy: [] } } });
    }
    if ((init.method ?? 'GET') === 'POST') { posts.push(JSON.parse(init.body)); return json(200, { ...JSON.parse(init.body), status: 'confirmed' }); }
    return json(500, {});
  };
  const clock = { t: NOW };
  const real = createGcal({ saFile: '/home/example/.secrets/sa.json', calendarId: CAL, readFile: () => JSON.stringify({ client_email: 'robot@example.com', private_key: privateKey }), fetchImpl, now: () => clock.t });
  const k = setup({ gcal: real, clock });
  try {
    const lead = k.lead('LEAD-20261201-0000ffff');
    const waitHold = async () => {
      for (let i = 0; i < 200 && !hold.release; i += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.ok(hold.release, 'held');
    };
    const go = () => { const r = hold.release; hold.release = null; r(); };
    hold.freeBusy = true;
    const p = k.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    await waitHold();
    assert.equal(mints, 1);
    clock.t += 56 * 60_000; // past the 55 min token cache
    hold.token = true;
    go();
    await waitHold();
    assert.equal(mints, 2, 'the insert is minting its token');
    k.viewing.onPurge(lead.lead_id);
    go();
    assert.deepEqual(await p, { ok: false, reason: 'cancelled' });
    assert.deepEqual(posts, [], 'no insert request went out');
    assert.equal(k.rows()[0].status, 'cancelled');
  } finally { k.db.close(); }
});

test('a commit validated late on a Wednesday for Thursday whose Google calls answer after Riyadh midnight books nothing: the slot is checked against the clock again right before the insert (same-day never), the row ends cancelled', async () => {
  const LATE = R(2026, 12, 2, 23, 59); // Wednesday 23:59
  const AFTER = R(2026, 12, 3, 0, 1); // Thursday 00:01
  const THU_10 = '2026-12-03T10:00+03:00';
  const gcal = fakeGcal();
  const held = { holidays: false, freeBusy: false, release: null };
  for (const op of ['holidays', 'freeBusy']) {
    const real = gcal[op];
    gcal[op] = async (...args) => {
      if (held[op]) { held[op] = false; await new Promise((resolve) => { held.release = resolve; }); }
      return real(...args);
    };
  }
  const reached = async () => {
    for (let i = 0; i < 200 && !held.release; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(held.release, 'the commit reached the re-check');
  };
  const answer = () => { const r = held.release; held.release = null; r(); };
  const clock = { t: LATE };
  const h = setup({ gcal, clock });
  try {
    const rowOf = (leadId) => h.rows().find((r) => r.lead_id === leadId);
    const inserts = () => gcal.calls.filter((c) => c[0] === 'insert');
    // The control: at 23:59 on Wednesday, Thursday is tomorrow and books.
    const ok = h.lead('LEAD-20261201-0000a0a0');
    assert.equal(h.viewing.validate({ lead: ok, listingId: 'BONA-W901', slotId: '2026-12-03T14:00+03:00' }).ok, true);
    assert.equal((await h.viewing.commitBooking({ lead: ok, listingId: 'BONA-W901', slotId: '2026-12-03T14:00+03:00' })).ok, true);
    assert.equal(inserts().length, 1);
    for (const [op, id] of [['freeBusy', 'LEAD-20261201-0000b0b0'], ['holidays', 'LEAD-20261201-0000c0c0']]) {
      clock.t = LATE;
      const lead = h.lead(id);
      assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: THU_10 }).ok, true, `${op}: valid before midnight`);
      held[op] = true;
      const p = h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: THU_10 });
      await reached();
      assert.equal(rowOf(id).status, 'booked', `${op}: reserved before midnight`);
      clock.t = AFTER;
      answer();
      assert.deepEqual(await p, { ok: false, reason: 'too_soon' }, `${op}: Thursday is today now`);
      assert.equal(inserts().length, 1, `${op}: no insert was called`);
      assert.equal(rowOf(id).status, 'cancelled', `${op}: no event was sent, so there is none to delete`);
      assert.equal(tasksForLead(h.db, id).some((t) => t.kind === 'viewing'), false, `${op}: no task`);
      assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: THU_10 }).reason, 'too_soon');
    }
    await h.viewing.tick();
    assert.equal(gcal.calls.some((c) => c[0] === 'delete'), false, 'the worker has nothing to delete');
  } finally { h.db.close(); }

  // The real client: freeBusy answers at 23:59 with the token run out, so the insert mints a new one
  // first, and midnight passes during that mint. gcal asks ready() right before the request: nothing goes out.
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const hold = { token: false, freeBusy: false, release: null };
  const posts = [];
  let mints = 0;
  const pause = () => new Promise((resolve) => { hold.release = resolve; });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.href === TOKEN_URL) {
      mints += 1;
      if (hold.token) { hold.token = false; await pause(); }
      return json(200, { access_token: `tok-${mints}`, expires_in: 3599 });
    }
    if (u.pathname.includes('saudiarabian')) return json(200, { items: [] });
    if (u.pathname.endsWith('/freeBusy')) {
      if (hold.freeBusy) { hold.freeBusy = false; await pause(); }
      return json(200, { calendars: { [CAL]: { busy: [] } } });
    }
    if ((init.method ?? 'GET') === 'POST') { posts.push(JSON.parse(init.body)); return json(200, { ...JSON.parse(init.body), status: 'confirmed' }); }
    return json(500, {});
  };
  const clock2 = { t: R(2026, 12, 2, 23, 0) };
  const real = createGcal({ saFile: '/home/example/.secrets/sa.json', calendarId: CAL, readFile: () => JSON.stringify({ client_email: 'robot@example.com', private_key: privateKey }), fetchImpl, now: () => clock2.t });
  const k = setup({ gcal: real, clock: clock2 });
  try {
    const lead = k.lead('LEAD-20261201-0000d0d0');
    const waitHold = async () => {
      for (let i = 0; i < 200 && !hold.release; i += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.ok(hold.release, 'held');
    };
    const go = () => { const r = hold.release; hold.release = null; r(); };
    hold.freeBusy = true;
    const p = k.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: THU_10 });
    await waitHold();
    assert.equal(mints, 1);
    clock2.t = LATE; // past the 55 min token cache, still Wednesday
    hold.token = true;
    go();
    await waitHold();
    assert.equal(mints, 2, 'the insert is minting its token (the first check passed on Wednesday)');
    clock2.t = AFTER;
    go();
    assert.deepEqual(await p, { ok: false, reason: 'too_soon' });
    assert.deepEqual(posts, [], 'no insert request went out');
    assert.equal(k.rows()[0].status, 'cancelled');
    assert.equal(tasksForLead(k.db, lead.lead_id).some((t) => t.kind === 'viewing'), false);
  } finally { k.db.close(); }
});

test('Not a client, or a number put on the never list, BEFORE the reserve (the commit waits on the lock behind another lead, or its reads are on their way): no row, no insert, no task; slots and validate refuse it too', async () => {
  // One harness per case: a fake calendar whose held call waits once for the test to answer.
  const harness = (clock = { t: NOW }) => {
    const gcal = fakeGcal();
    const held = { op: null, release: null };
    for (const op of ['holidays', 'get']) {
      const real = gcal[op];
      gcal[op] = async (...args) => {
        if (held.op === op) { held.op = null; await new Promise((resolve) => { held.release = resolve; }); }
        return real(...args);
      };
    }
    const h = setup({ gcal, clock });
    const inbox = createInboxStore(h.db, { onPurge: (id) => h.viewing.onPurge(id) });
    return {
      ...h,
      hold: (op) => { held.op = op; },
      reached: async () => {
        for (let i = 0; i < 200 && !held.release; i += 1) await new Promise((resolve) => setImmediate(resolve));
        assert.ok(held.release, 'the call is on its way');
      },
      answer: () => { const r = held.release; held.release = null; r(); },
      // As routes.mjs runs them: the viewing seam first, then the purge, in one transaction (DESIGN §8.4).
      leaves: {
        'Not a client': (id) => h.db.transaction(() => { h.viewing.onLeadLeaving(id); inbox.leaveInbox(id); }),
        'a never-list number': (id) => h.db.transaction(() => {
          h.team.addNever({ phone: h.db.getLead(id).phone_e164 });
          h.viewing.onLeadLeaving(id);
          inbox.leaveInbox(id);
        }),
      },
      inserts: () => gcal.calls.filter((c) => c[0] === 'insert').map((c) => c[1]),
      viewingTasks: (id) => tasksForLead(h.db, id).filter((t) => t.kind === 'viewing'),
    };
  };

  for (const what of ['Not a client', 'a never-list number']) {
    // 1. Waiting on the lock: another lead's commit holds it while Google answers its re-check.
    const h = harness();
    try {
      const x = h.lead('LEAD-20261201-0000aaaa');
      const y = h.lead('LEAD-20261201-0000bbbb');
      h.hold('holidays');
      const px = h.viewing.commitBooking({ lead: x, listingId: 'BONA-W901', slotId: SLOT });
      await h.reached();
      // The caller read the lead before it left: the commit reads it again.
      const py = h.viewing.commitBooking({ lead: y, listingId: 'BONA-W902', slotId: '2026-12-07T10:00+03:00' });
      h.leaves[what](y.lead_id);
      assert.equal(h.db.getLead(y.lead_id).inbox_state, 'out', what);
      h.answer();
      assert.equal((await px).ok, true, `${what}: the other lead's booking stands`);
      assert.deepEqual(await py, { ok: false, reason: 'not_in_inbox' }, what);
      assert.equal(h.inserts().length, 1, `${what}: only the other lead's event went out`);
      assert.doesNotMatch(JSON.stringify(h.inserts()), new RegExp(y.phone_e164), `${what}: nothing of the lead reached Google`);
      assert.deepEqual(h.rows().filter((r) => r.lead_id === y.lead_id), [], `${what}: no row`);
      assert.deepEqual(h.viewingTasks(y.lead_id), [], `${what}: no task`);
      // The tools refuse it as well, from the lead the caller holds or its id.
      for (const ask of [{ lead: y }, { leadId: y.lead_id }]) {
        assert.deepEqual(h.viewing.validate({ ...ask, listingId: 'BONA-W902', slotId: '2026-12-07T10:00+03:00' }), { ok: false, reason: 'not_in_inbox' }, what);
        assert.deepEqual(await h.viewing.slots({ ...ask, listingId: 'BONA-W902' }), { bookable: false, reason: 'not_in_inbox' }, what);
      }
    } finally { h.db.close(); }

    // 2. While the commit's reads are on their way: its booking that is over by its stored times is read first.
    const k = harness();
    try {
      const y = k.lead('LEAD-20261201-0000cccc');
      const first = await k.viewing.commitBooking({ lead: y, listingId: 'BONA-W901', slotId: SLOT });
      assert.equal(first.ok, true);
      k.clock.t = R(2026, 12, 6, 11, 5);
      k.hold('get');
      const p = k.viewing.commitBooking({ lead: y, listingId: 'BONA-W902', slotId: '2026-12-09T10:00+03:00' });
      await k.reached();
      k.leaves[what](y.lead_id);
      k.answer();
      assert.deepEqual(await p, { ok: false, reason: 'not_in_inbox' }, what);
      assert.equal(k.inserts().length, 1, `${what}: only the first booking's event ever went out`);
      assert.deepEqual(k.rows().map((r) => [r.booking_id, r.status]), [[first.bookingId, 'cancel_pending']], `${what}: no new row`);
      assert.deepEqual(k.viewingTasks(y.lead_id).map((t) => t.status), ['cancelled'], `${what}: no new task`);
      await k.viewing.tick();
      assert.equal(k.gcal.events.size, 0, `${what}: the first booking's event is deleted`);
      assert.deepEqual(k.rows().map((r) => r.status), ['cancelled']);
    } finally { k.db.close(); }
  }

  // 3. A chat excluded while still in (a lid learned as a colleague's; the daily sweep takes it out later): refused the same way.
  const e = harness();
  try {
    const lid = '100000000000001@lid';
    const y = e.lead('LEAD-20261201-0000dddd', { wa_lid: lid });
    e.team.ensureOwner({ phone: '966500000009', name: 'Owner Example' });
    assert.equal(learnTeamLid(e.db, '966500000009', lid), true);
    assert.equal(e.db.getLead(y.lead_id).inbox_state, 'in');
    assert.deepEqual(e.viewing.validate({ lead: y, listingId: 'BONA-W901', slotId: SLOT }), { ok: false, reason: 'not_in_inbox' });
    assert.deepEqual(await e.viewing.commitBooking({ lead: y, listingId: 'BONA-W901', slotId: SLOT }), { ok: false, reason: 'not_in_inbox' });
    assert.deepEqual(e.inserts(), []);
    assert.deepEqual(e.rows(), []);
  } finally { e.db.close(); }
});

test('a restart on another WRITABLE calendar id: no slots and no booking there (calendar_mismatch), a queued deletion waits (a 404 there is no "already gone"), reconcile cancels none of its bookings, health says not_found; the right calendar back, the event goes and booking works again', async () => {
  const CAL2 = 'other-calendar@example.com';
  const cals = new Map([[CAL, new Map()], [CAL2, new Map()]]);
  const deletes = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const notFound = () => json(404, { error: { code: 404, errors: [{ domain: 'global', reason: 'notFound' }] } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    if (u.href === TOKEN_URL) return json(200, { access_token: 'tok', expires_in: 3599 });
    if (u.pathname.includes('saudiarabian')) return json(200, { items: [] });
    if (u.pathname.endsWith('/freeBusy')) {
      const ids = JSON.parse(init.body).items.map((i) => i.id);
      return json(200, { calendars: Object.fromEntries(ids.map((id) => [id, { busy: [] }])) });
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    const calId = m ? decodeURIComponent(m[1]) : null;
    const events = calId ? cals.get(calId) : null;
    if (!events) return notFound();
    const id = m[2];
    if (!id && method === 'GET') return json(200, { accessRole: 'writer' }); // both calendars are writable
    if (!id && method === 'POST') {
      const ev = JSON.parse(init.body);
      events.set(ev.id, { ...ev, status: 'confirmed' });
      return json(200, events.get(ev.id));
    }
    if (method === 'GET') return events.has(id) ? json(200, events.get(id)) : notFound();
    if (method === 'DELETE') {
      deletes.push([calId, id]);
      if (!events.has(id)) return notFound();
      events.delete(id);
      return new Response(null, { status: 204 });
    }
    return json(500, {});
  };
  const clock = { t: NOW };
  const gcalFor = (calendarId) => createGcal({ saFile: '/home/example/.secrets/sa.json', calendarId, readFile: () => JSON.stringify({ client_email: 'robot@example.com', private_key: privateKey }), fetchImpl, now: () => clock.t });
  const h = setup({ gcal: gcalFor(CAL), clock });
  const restart = (calendarId) => createViewing({
    db: h.db, cfg: { siteUrl: SITE, publicApi: API_BASE }, team: h.team, ownerTest: { autoMode: () => true }, inventory, gcal: gcalFor(calendarId),
    now: () => clock.t, log: (o) => h.logs.push(o),
  });
  try {
    const statusOf = (bookingId) => h.rows().find((r) => r.booking_id === bookingId).status;
    const taskOf = (leadId) => tasksForLead(h.db, leadId).find((t) => t.kind === 'viewing').status;
    const a = h.lead('LEAD-20261201-0000aaaa');
    const b = h.lead('LEAD-20261201-0000bbbb');
    const ga = await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    const gb = await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W902', slotId: '2026-12-07T12:00+03:00' });
    assert.equal(ga.ok && gb.ok, true);
    assert.equal(calendarTagOf(ga.eventId), gcalFor(CAL).calendarTag, 'the event id records its calendar');
    assert.equal(cals.get(CAL).has(ga.eventId), true);
    assert.equal(h.viewing.cancelForLead(a.lead_id), 1, "A's deletion is queued");
    // A row written before this change carries no calendar: today's behaviour (its 404 is done).
    insertRow(h.db, { id: 'bk-old', leadId: 'LEAD-OLD', start: R(2026, 12, 10, 10), status: 'cancel_pending' });

    // The restart, on another calendar id the robot can also write to.
    const wrong = restart(CAL2);
    assert.equal(wrong.health().gcal.lastErrorCode, 'not_found', 'the bookings were made in another calendar');
    await wrong.tick();
    assert.equal(statusOf(ga.bookingId), 'cancel_pending', "a 404 in another calendar is not A's event gone");
    assert.equal(cals.get(CAL).has(ga.eventId), true, 'still in the calendar it was made in');
    assert.deepEqual(deletes.find((d) => d[1] === ga.eventId), [CAL2, ga.eventId]);
    assert.equal(statusOf('bk-old'), 'cancelled', 'no calendar recorded: as before');
    assert.ok(h.logs.some((l) => l.evt === 'viewing.cancel_retry' && l.bookingId === ga.bookingId && l.code === 'not_found'));
    assert.deepEqual(wrong.health(), { enabled: true, gcal: { configured: true, ok: false, lastErrorCode: 'not_found' } });
    // No booking on this calendar while it is not the one the bookings were made in: its busy time is not the
    // owner's, and a client's name and phone must not land there. Nothing is asked of it, nothing is sent.
    const c = h.lead('LEAD-20261201-0000cccc');
    const askC = { lead: c, listingId: 'BONA-W903', slotId: '2026-12-08T10:00+03:00' };
    const rowsBefore = h.rows().length;
    assert.deepEqual(await wrong.slots({ lead: c, listingId: 'BONA-W903' }), { bookable: false, reason: 'calendar_mismatch' });
    assert.deepEqual(wrong.validate(askC), { ok: false, reason: 'calendar_mismatch' });
    assert.deepEqual(await wrong.commitBooking(askC), { ok: false, reason: 'calendar_mismatch' });
    assert.equal(cals.get(CAL2).size, 0, 'no event in the replacement calendar');
    assert.equal(h.rows().length, rowsBefore, 'no row');
    // Reconcile on it finds none of the bookings' events: B's 404 is no deletion (made elsewhere), the run is held.
    assert.deepEqual(await wrong.reconcile(), { checked: 1, moved: 0, cancelled: 0, held: 1 });
    assert.equal(statusOf(gb.bookingId), 'booked');
    assert.equal(taskOf(b.lead_id), 'confirmed');
    // A deletion of this calendar's own event still goes through.
    const ownId = eventIdFor('LEAD-20261201-0000dddd', R(2026, 12, 9, 10), 0, gcalFor(CAL2).calendarTag);
    cals.get(CAL2).set(ownId, { id: ownId, status: 'confirmed' });
    insertRow(h.db, { id: 'bk-own2', leadId: 'LEAD-20261201-0000dddd', start: R(2026, 12, 9, 10), status: 'cancel_pending', eventId: ownId });
    await wrong.tick();
    assert.equal(statusOf('bk-own2'), 'cancelled');
    assert.equal(cals.get(CAL2).has(ownId), false);
    assert.equal(statusOf(ga.bookingId), 'cancel_pending', 'retried, and still waiting');
    assert.deepEqual(await wrong.commitBooking(askC), { ok: false, reason: 'calendar_mismatch' }, "B's booking is still the other calendar's");

    // The right calendar back: A's event goes, health clears, and booking works again (on the right calendar).
    const right = restart(CAL);
    await right.tick();
    assert.equal(statusOf(ga.bookingId), 'cancelled');
    assert.equal(cals.get(CAL).has(ga.eventId), false);
    assert.deepEqual(right.health(), { enabled: true, gcal: { configured: true, ok: true, lastErrorCode: null } });
    assert.equal((await right.slots({ lead: c, listingId: 'BONA-W903' })).bookable, true);
    const gc = await right.commitBooking(askC);
    assert.equal(gc.ok, true, JSON.stringify(gc));
    assert.equal(cals.get(CAL).has(gc.eventId), true);
    assert.equal(cals.get(CAL2).size, 0);
    // In its own calendar a 404 is "already gone": the owner deleted B's event himself.
    cals.get(CAL).delete(gb.eventId);
    right.cancelForLead(b.lead_id);
    await right.tick();
    assert.equal(statusOf(gb.bookingId), 'cancelled');
    assert.doesNotMatch(JSON.stringify(h.logs), /Sara|9665|owner-calendar|other-calendar|robot/, 'logs carry ids and codes only');
  } finally { h.db.close(); }
});

test('a booking or a queued deletion made in another calendar than the one configured stops booking (calendar_mismatch): slots, validate and commitBooking refuse before any call to Google; past and finished rows from it do not; the right calendar back, booking works again', async () => {
  const clock = { t: NOW };
  const calA = Object.assign(fakeGcal(), { calendarTag: calendarTag('calendar-a@example.com') });
  const calB = Object.assign(fakeGcal(), { calendarTag: calendarTag('calendar-b@example.com') });
  const h = setup({ gcal: calA, clock });
  const restart = (gcal) => createViewing({
    db: h.db, cfg: { siteUrl: SITE, publicApi: API_BASE }, team: h.team, ownerTest: { autoMode: () => true }, inventory, gcal,
    now: () => clock.t, log: (o) => h.logs.push(o),
  });
  try {
    const statusOf = (id) => h.rows().find((r) => r.booking_id === id).status;
    const a = h.lead('LEAD-20261201-0000aaaa');
    const c = h.lead('LEAD-20261201-0000cccc');
    const ga = await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(ga.ok, true, JSON.stringify(ga));
    assert.equal(calendarTagOf(ga.eventId), calA.calendarTag);
    const ask = { lead: c, listingId: 'BONA-W902', slotId: '2026-12-07T12:00+03:00' };

    // A restart on calendar B while A's booking (calendar A) is active.
    const wrong = restart(calB);
    assert.deepEqual(await wrong.slots({ lead: c, listingId: 'BONA-W902' }), { bookable: false, reason: 'calendar_mismatch' });
    assert.deepEqual(wrong.validate(ask), { ok: false, reason: 'calendar_mismatch' });
    assert.deepEqual(await wrong.commitBooking(ask), { ok: false, reason: 'calendar_mismatch' });
    assert.deepEqual(calB.calls, [], 'nothing asked of calendar B, nothing sent to it');
    assert.equal(h.rows().length, 1);
    // A queued deletion of calendar A's event keeps it too: that calendar is still the owner's.
    assert.equal(h.viewing.cancelForLead(a.lead_id), 1);
    assert.equal(statusOf(ga.bookingId), 'cancel_pending');
    assert.deepEqual(await wrong.commitBooking(ask), { ok: false, reason: 'calendar_mismatch' });
    assert.deepEqual(calB.calls, []);
    assert.equal(wrong.health().gcal.lastErrorCode, 'not_found');

    // Calendar A back: the worker deletes A's event, and booking works again. Rows of another calendar that are
    // over (done) or cancelled are no booking and no deletion: they never stop it.
    const right = restart(calA);
    const elsewhere = calB.calendarTag;
    insertRow(h.db, { id: 'bk-done-b', leadId: 'LEAD-OLD-1', start: NOW - 3 * DAY, status: 'done', eventId: eventIdFor('LEAD-OLD-1', NOW - 3 * DAY, 0, elsewhere) });
    insertRow(h.db, { id: 'bk-gone-b', leadId: 'LEAD-OLD-2', start: NOW - 2 * DAY, status: 'cancelled', eventId: eventIdFor('LEAD-OLD-2', NOW - 2 * DAY, 0, elsewhere) });
    await right.tick();
    assert.equal(statusOf(ga.bookingId), 'cancelled');
    assert.equal(right.health().gcal.lastErrorCode, null);
    assert.equal((await right.slots({ lead: c, listingId: 'BONA-W902' })).bookable, true);
    const gc = await right.commitBooking(ask);
    assert.equal(gc.ok, true, JSON.stringify(gc));
    assert.equal(calA.events.has(gc.eventId), true);
    assert.deepEqual(calB.calls, []);
  } finally { h.db.close(); }
});

test('reconcile: a 404 for the ONLY booking, whose id records this calendar (and the access probe passed), is the owner deleting it: the row and its task are cancelled and the client can book again; an id written before (no calendar) is still held', async () => {
  const clock = { t: NOW };
  const gcal = Object.assign(fakeGcal(), { calendarTag: calendarTag('calendar-a@example.com') });
  const h = setup({ gcal, clock });
  try {
    const statusOf = (id) => h.rows().find((r) => r.booking_id === id).status;
    const taskOf = (bookingId) => tasksForLead(h.db, h.rows().find((r) => r.booking_id === bookingId).lead_id)
      .find((t) => t.details?.booking_id === bookingId);
    const a = h.lead('LEAD-20261201-0000aaaa');
    const first = await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(calendarTagOf(first.eventId), gcal.calendarTag);
    // The owner deletes the only booking: Google answers 404 (or 410) for it.
    gcal.events.delete(first.eventId);
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 1, held: 0 });
    assert.equal(statusOf(first.bookingId), 'cancelled');
    assert.equal(taskOf(first.bookingId).status, 'cancelled');
    assert.deepEqual(h.viewing.health(), { enabled: true, gcal: { configured: true, ok: true, lastErrorCode: null } });
    assert.equal(h.logs.some((l) => l.evt === 'viewing.reconcile_held'), false);
    // The client can book again.
    const again = await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.notEqual(again.eventId, first.eventId);

    // A calendar the robot cannot manage answers 404 for every event too: no 404 is read before the probe passes.
    gcal.events.delete(again.eventId);
    gcal.fail.access = 'not_found';
    assert.deepEqual(await h.viewing.reconcile(), { checked: 0, moved: 0, cancelled: 0, held: 0 });
    assert.equal(statusOf(again.bookingId), 'booked');
    delete gcal.fail.access;
    // With a booking whose id records no calendar (written before ids did), and none of the run's events found:
    // this calendar's 404 is a deletion, the older one is held.
    const legacy = insertRow(h.db, { id: 'bk-legacy', leadId: 'LEAD-20261201-0000eeee', start: R(2026, 12, 9, 10) });
    assert.equal(calendarTagOf(legacy), null);
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 0, cancelled: 1, held: 1 });
    assert.equal(statusOf(again.bookingId), 'cancelled');
    assert.equal(taskOf(again.bookingId).status, 'cancelled');
    assert.equal(statusOf('bk-legacy'), 'booked');
    assert.equal(h.viewing.health().gcal.lastErrorCode, 'not_found');
    // The older booking alone: still held, as before.
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 0, held: 1 });
    assert.equal(statusOf('bk-legacy'), 'booked');
    assert.equal(h.viewing.health().gcal.lastErrorCode, 'not_found');
  } finally { h.db.close(); }
});

test('a restart between the reserve and the task: the next process moves the untold row (booked, no task) to cancel_pending and deletes its event; a commit in flight is never touched', async () => {
  const clock = { t: NOW };
  const gcal = fakeGcal();
  const insert = gcal.insert;
  const gate = { on: false, release: null };
  // The event lands; Google's answer only comes when the test releases it (the process "dies" in between).
  gcal.insert = async (ev) => {
    const got = await insert(ev);
    if (gate.on) await new Promise((resolve) => { gate.release = resolve; });
    return got;
  };
  const h = setup({ gcal, clock });
  try {
    const lead = h.lead();
    gate.on = true;
    const first = h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    for (let i = 0; i < 200 && !gate.release; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(gate.release, 'the commit reached the insert');
    gate.on = false;
    const [row] = h.rows();
    assert.deepEqual({ status: row.status, task: row.task_id, told: row.client_told }, { status: 'booked', task: null, told: 0 });
    assert.equal(gcal.events.has(row.event_id), true, 'the event landed');

    // The restart: a new process over the same database, with nothing in flight.
    const after = createViewing({
      db: h.db, cfg: { siteUrl: SITE, publicApi: API_BASE }, team: h.team, ownerTest: { autoMode: () => true }, inventory, gcal,
      now: () => clock.t, log: (o) => h.logs.push(o),
    });
    // A row this young may still be another process's commit: left alone.
    clock.t = NOW + 30_000;
    await after.tick();
    assert.equal(h.rows()[0].status, 'booked');
    // The process that holds the commit leaves its own row alone, however long Google takes.
    clock.t = NOW + 10 * 60_000;
    await h.viewing.tick();
    assert.equal(h.rows()[0].status, 'booked');
    assert.deepEqual(gcal.calls.filter((c) => c[0] === 'delete'), []);

    // The new process: the row goes cancel_pending, and the same run deletes the event.
    const out = await after.tick();
    assert.equal(out.stranded, 1);
    assert.equal(h.rows()[0].status, 'cancelled');
    assert.equal(gcal.events.has(row.event_id), false, 'no event is left in the calendar for a client who was never told');
    assert.ok(h.logs.some((l) => l.evt === 'viewing.stranded' && l.bookingId === row.booking_id));
    assert.doesNotMatch(JSON.stringify(h.logs), /Sara|9665/, 'logs carry ids and codes only');
    // The lead can book again, in the new process (a new event id: Google keeps the deleted one's).
    const again = await after.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.notEqual(again.eventId, row.event_id);
    // The old commit's late answer (were it still alive) finds its row cancelled: no second booking.
    gate.release();
    assert.deepEqual(await first, { ok: false, reason: 'cancelled' });
    assert.deepEqual(h.rows().map((r) => r.status), ['cancelled', 'booked']);
  } finally { h.db.close(); }
});

test('reconcile sweeps an untold row (booked, no task) left by an earlier process before it checks the calendar', async () => {
  const h = setup();
  try {
    const at = (ts) => ({ dateTime: new Date(ts).toISOString() });
    const lead = h.lead();
    const strandedEvent = insertRow(h.db, { id: 'bk-stranded', leadId: lead.lead_id, start: SLOT_TS, taskId: null });
    h.gcal.events.set(strandedEvent, { id: strandedEvent, status: 'confirmed', start: at(SLOT_TS), end: at(SLOT_TS + H) });
    const other = h.lead('LEAD-20261201-0000bbbb');
    const fineEvent = insertRow(h.db, { id: 'bk-fine', leadId: other.lead_id, start: R(2026, 12, 7, 12) });
    h.gcal.events.set(fineEvent, { id: fineEvent, status: 'confirmed', start: at(R(2026, 12, 7, 12)), end: at(R(2026, 12, 7, 13)) });
    assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: '2026-12-08T10:00+03:00' }).ok, true, 'an untold row is no booking, even before the sweep');
    assert.equal(h.rows().find((r) => r.booking_id === 'bk-stranded').status, 'booked', 'validate wrote nothing');

    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 0, held: 0 }, 'only the finished booking is checked');
    assert.deepEqual(h.rows().map((r) => [r.booking_id, r.status]), [['bk-fine', 'booked'], ['bk-stranded', 'cancel_pending']]);
    await h.viewing.tick();
    assert.deepEqual(h.rows().map((r) => [r.booking_id, r.status]), [['bk-fine', 'booked'], ['bk-stranded', 'cancelled']]);
    assert.deepEqual([h.gcal.events.has(strandedEvent), h.gcal.events.has(fineEvent)], [false, true]);
    assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: '2026-12-08T10:00+03:00' }).ok, true, 'the lead can book again');
  } finally { h.db.close(); }
});

test('the worker turns past booked rows done and keeps the holiday copy warm; it runs one at a time', async () => {
  const clock = { t: NOW };
  const h = setup({ clock });
  try {
    const lead = h.lead();
    await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    clock.t = SLOT_TS + 2 * H;
    const first = h.viewing.tick();
    assert.equal(h.viewing.tick(), first, 'a second call while one runs joins it');
    await first;
    assert.equal(h.rows()[0].status, 'done');
    assert.ok(h.gcal.calls.some((c) => c[0] === 'holidays'));
  } finally { h.db.close(); }
});

/* ---------------- the stored times are a copy: a row is done only when its event is over ---------------- */

const taskFor = (h, bookingId) => tasksForLead(h.db, h.rows().find((r) => r.booking_id === bookingId).lead_id)
  .find((t) => t.details?.booking_id === bookingId);
const moveEvent = (h, eventId, start, end) => {
  const ev = h.gcal.events.get(eventId);
  ev.start = { dateTime: start, timeZone: 'Asia/Riyadh' };
  ev.end = { dateTime: end, timeZone: 'Asia/Riyadh' };
};

test('a viewing the owner moved LATER in Google after the reconcile is never done by its old end: the worker, slots and the next booking read the event first; the task follows and the lead keeps one booking', async () => {
  const WED = '2026-12-09T10:00+03:00';
  // 1. The worker runs first.
  const clock = { t: NOW };
  const h = setup({ clock });
  try {
    const lead = h.lead();
    const first = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(first.ok, true);
    clock.t = R(2026, 12, 6, 5); // Sunday 05:00: the reconcile finds it where it was booked
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 0, held: 0 });
    moveEvent(h, first.eventId, '2026-12-08T12:00:00+03:00', '2026-12-08T13:00:00+03:00'); // 07:00: moved to Tuesday 12:00
    clock.t = R(2026, 12, 6, 11, 5); // past the old end
    const out = await h.viewing.tick();
    assert.equal(out.moved, 1);
    const [row] = h.rows();
    assert.deepEqual({ status: row.status, start: row.start_ts, end: row.end_ts }, { status: 'booked', start: R(2026, 12, 8, 12), end: R(2026, 12, 8, 13) });
    assert.deepEqual({ status: taskFor(h, first.bookingId).status, due: taskFor(h, first.bookingId).due_ts }, { status: 'confirmed', due: R(2026, 12, 8, 12) });
    assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W902', slotId: WED }).reason, 'active_booking');
    assert.deepEqual(await h.viewing.commitBooking({ lead, listingId: 'BONA-W902', slotId: WED }), { ok: false, reason: 'active_booking' });
    // Tuesday 13:30: the moved viewing is over; it turns done, and the lead can book again.
    clock.t = R(2026, 12, 8, 13, 30);
    await h.viewing.tick();
    assert.equal(h.rows()[0].status, 'done');
    assert.equal((await h.viewing.commitBooking({ lead, listingId: 'BONA-W902', slotId: '2026-12-10T10:00+03:00' })).ok, true);
  } finally { h.db.close(); }

  // 2. The client asks again before the worker runs: the commit and slots read the event themselves.
  const kc = { t: NOW };
  const k = setup({ clock: kc });
  try {
    const lead = k.lead();
    const first = await k.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    kc.t = R(2026, 12, 6, 5);
    await k.viewing.reconcile();
    moveEvent(k, first.eventId, '2026-12-08T12:00:00+03:00', '2026-12-08T13:00:00+03:00');
    kc.t = R(2026, 12, 6, 11, 2);
    assert.deepEqual(await k.viewing.commitBooking({ lead, listingId: 'BONA-W902', slotId: WED }), { ok: false, reason: 'active_booking' });
    assert.deepEqual(k.rows().map((r) => [r.status, r.start_ts, r.end_ts]), [['booked', R(2026, 12, 8, 12), R(2026, 12, 8, 13)]]);
    assert.equal(taskFor(k, first.bookingId).due_ts, R(2026, 12, 8, 12));
    assert.equal(k.gcal.calls.filter((c) => c[0] === 'insert').length, 1, 'no second event');
    assert.deepEqual(await k.viewing.slots({ lead, listingId: 'BONA-W902' }), { bookable: false, reason: 'active_booking' });
  } finally { k.db.close(); }
  const sc = { t: NOW };
  const s = setup({ clock: sc });
  try {
    const lead = s.lead();
    const first = await s.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    moveEvent(s, first.eventId, '2026-12-08T12:00:00+03:00', '2026-12-08T13:00:00+03:00');
    sc.t = R(2026, 12, 6, 11, 2);
    assert.deepEqual(await s.viewing.slots({ lead, listingId: 'BONA-W902' }), { bookable: false, reason: 'active_booking' });
    assert.equal(s.rows()[0].start_ts, R(2026, 12, 8, 12));
  } finally { s.db.close(); }

  // 3. A calendar that cannot answer: the row stays booked (never done by its old end), and a booking waits for it.
  const mc = { t: NOW };
  const m = setup({ clock: mc });
  try {
    const lead = m.lead();
    await m.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    mc.t = R(2026, 12, 6, 11, 5);
    m.gcal.fail.get = 'timeout';
    await m.viewing.tick();
    assert.equal(m.rows()[0].status, 'booked');
    assert.deepEqual(await m.viewing.commitBooking({ lead, listingId: 'BONA-W902', slotId: WED }), { ok: false, reason: 'calendar', code: 'timeout' });
    assert.equal(m.rows().length, 1);
    delete m.gcal.fail.get;
    await m.viewing.tick();
    assert.equal(m.rows()[0].status, 'done', 'it was not moved: done once the calendar says so');
    assert.equal((await m.viewing.commitBooking({ lead, listingId: 'BONA-W902', slotId: WED })).ok, true);
  } finally { m.db.close(); }
});

test('a viewing the owner moved EARLIER (or deleted) in Google: done at its real end with the task following, by the worker or by the reconcile while its old end is still ahead', async () => {
  // 1. Moved earlier, both ends past: the worker calls it done at its real time.
  const clock = { t: NOW };
  const h = setup({ clock });
  try {
    const lead = h.lead();
    const first = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    moveEvent(h, first.eventId, '2026-12-03T18:00:00+03:00', '2026-12-03T19:00:00+03:00');
    clock.t = R(2026, 12, 6, 11, 5);
    assert.equal((await h.viewing.tick()).moved, 1);
    assert.deepEqual(h.rows().map((r) => [r.status, r.start_ts, r.end_ts]), [['done', R(2026, 12, 3, 18), R(2026, 12, 3, 19)]]);
    assert.equal(taskFor(h, first.bookingId).due_ts, R(2026, 12, 3, 18));
    assert.equal((await h.viewing.commitBooking({ lead, listingId: 'BONA-W902', slotId: '2026-12-09T10:00+03:00' })).ok, true);
  } finally { h.db.close(); }

  // 2. Moved earlier, its old end still ahead: the reconcile follows it, and the lead is free again.
  const kc = { t: NOW };
  const k = setup({ clock: kc });
  try {
    const lead = k.lead();
    const first = await k.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: '2026-12-08T10:00+03:00' });
    moveEvent(k, first.eventId, '2026-12-07T10:00:00+03:00', '2026-12-07T11:00:00+03:00');
    kc.t = R(2026, 12, 7, 12);
    assert.deepEqual(await k.viewing.reconcile(), { checked: 1, moved: 1, cancelled: 0, held: 0 });
    assert.deepEqual(k.rows().map((r) => [r.status, r.start_ts]), [['done', R(2026, 12, 7, 10)]]);
    assert.equal(taskFor(k, first.bookingId).due_ts, R(2026, 12, 7, 10));
    assert.equal(k.viewing.validate({ lead, listingId: 'BONA-W902', slotId: '2026-12-09T10:00+03:00' }).ok, true);
  } finally { k.db.close(); }

  // 3. Deleted in Google (its get answers status cancelled) before its time: cancelled with its task, never done.
  const dc = { t: NOW };
  const d = setup({ clock: dc });
  try {
    const lead = d.lead();
    const first = await d.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    d.gcal.events.get(first.eventId).status = 'cancelled';
    dc.t = R(2026, 12, 6, 11, 5);
    await d.viewing.tick();
    assert.equal(d.rows()[0].status, 'cancelled');
    assert.equal(taskFor(d, first.bookingId).status, 'cancelled');
  } finally { d.db.close(); }
});

/* ---------------- Google is the source of truth for times and busy time (DESIGN §8.4) ---------------- */

/** The fake calendar's busy time: every event it holds that is not cancelled, at its current times. */
const calendarBusy = (g) => [...g.events.values()].filter((e) => e.status !== 'cancelled')
  .map((e) => ({ start: Date.parse(e.start.dateTime), end: Date.parse(e.end.dateTime) }));
const doubleBooked = (h) => h.db.db.prepare("SELECT start_ts, COUNT(*) n FROM viewing_bookings WHERE status = 'booked' GROUP BY start_ts HAVING n > 1").all();

test('a booking the owner moved in Google frees its old start at once: slots offer it, validate passes it and a commit books it once the moved row followed its event; only a hold not yet in Google is local busy time', async () => {
  const THU = { start: R(2026, 12, 3, 0), end: R(2026, 12, 4, 0) }; // Thursday is full, so the offer starts on Sunday
  const gcal = fakeGcal({ busy: () => [THU, ...calendarBusy(gcal)] });
  const h = setup({ gcal });
  try {
    const a = h.lead('LEAD-20261201-0000aaaa');
    const b = h.lead('LEAD-20261201-0000bbbb');
    const offered = async (lead) => (await h.viewing.slots({ lead, listingId: 'BONA-W902' })).slots.map((s) => s.slot_id);
    assert.equal((await offered(b)).includes(SLOT), true, 'free at first');
    const first = await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(first.ok, true);
    // Where Google shows it, it is busy for everyone else: slots leave it out, and the live check refuses it.
    assert.equal((await offered(b)).includes(SLOT), false);
    assert.equal(h.viewing.validate({ lead: b, listingId: 'BONA-W902', slotId: SLOT }).ok, true, 'no stored time decides it');
    assert.deepEqual(await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W902', slotId: SLOT }), { ok: false, reason: 'busy' });
    assert.equal(gcal.calls.filter((c) => c[0] === 'insert').length, 1, 'no second event at that start');

    // After the morning reconcile, the owner moves it to Sunday 16:00: 10:00 is free at once, 16:00 is not.
    moveEvent(h, first.eventId, '2026-12-06T16:00:00+03:00', '2026-12-06T17:00:00+03:00');
    const now = await offered(b);
    assert.equal(now.includes(SLOT), true, 'the old start is offered');
    assert.equal(now.includes('2026-12-06T16:00+03:00'), false, 'the new one is busy');
    assert.equal(h.viewing.validate({ lead: b, listingId: 'BONA-W902', slotId: SLOT }).ok, true);
    const got = await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W902', slotId: SLOT });
    assert.equal(got.ok, true, JSON.stringify(got));
    const rowOf = (id) => h.rows().find((r) => r.booking_id === id);
    assert.deepEqual([rowOf(first.bookingId).status, rowOf(first.bookingId).start_ts, rowOf(first.bookingId).end_ts], ['booked', R(2026, 12, 6, 16), R(2026, 12, 6, 17)]);
    assert.equal(taskFor(h, first.bookingId).due_ts, R(2026, 12, 6, 16), "the moved booking's task follows");
    assert.deepEqual([rowOf(got.bookingId).status, rowOf(got.bookingId).start_ts], ['booked', SLOT_TS]);
    assert.equal(h.viewing.validate({ lead: a, listingId: 'BONA-W902', slotId: '2026-12-07T10:00+03:00' }).reason, 'active_booking', 'A keeps its one booking');
    assert.deepEqual(doubleBooked(h), []);

    // A hold (another process between its reserve and its insert) is not in Google yet: it is the local busy time.
    const c = h.lead('LEAD-20261201-0000cccc');
    const d = h.lead('LEAD-20261201-0000dddd');
    const MON = '2026-12-07T10:00+03:00';
    assert.equal((await offered(d)).includes(MON), true);
    insertRow(h.db, { id: 'bk-hold', leadId: c.lead_id, start: R(2026, 12, 7, 10), taskId: null, created: NOW - 30_000 });
    assert.equal((await offered(d)).includes(MON), false);
    assert.equal(h.viewing.validate({ lead: d, listingId: 'BONA-W902', slotId: MON }).reason, 'busy');
    assert.equal(h.viewing.validate({ lead: c, listingId: 'BONA-W902', slotId: '2026-12-08T10:00+03:00' }).reason, 'active_booking', "the hold is its lead's booking");
  } finally { h.db.close(); }
});

test('a start freed by a CHAIN of owner moves (12:00 → 14:00, then 10:00 → 12:00; and three steps) is offered and books at once: the commit reads every booking along the chain and follows them in the reserve\'s transaction; never two booked rows on one start', async () => {
  const leads = ['LEAD-20261201-0000aaaa', 'LEAD-20261201-0000bbbb', 'LEAD-20261201-0000cccc'];
  const at = (hour) => `2026-12-06T${String(hour).padStart(2, '0')}:00`;
  for (const steps of [2, 3]) {
    const THU = { start: R(2026, 12, 3, 0), end: R(2026, 12, 4, 0) }; // Thursday is full, so the offer starts on Sunday
    const gcal = fakeGcal({ busy: () => [THU, ...calendarBusy(gcal)] });
    const h = setup({ gcal });
    try {
      const hours = [10, 12, 14].slice(0, steps);
      const booked = [];
      for (const [i, hour] of hours.entries()) {
        const got = await h.viewing.commitBooking({ lead: h.lead(leads[i]), listingId: 'BONA-W901', slotId: `${at(hour)}+03:00` });
        assert.equal(got.ok, true, JSON.stringify(got));
        booked.push(got);
      }
      // The owner moves the last one two hours later, then each earlier one onto the start the next one left.
      for (let i = steps - 1; i >= 0; i -= 1) moveEvent(h, booked[i].eventId, `${at(hours[i] + 2)}:00+03:00`, `${at(hours[i] + 3)}:00+03:00`);
      const newcomer = h.lead('LEAD-20261201-0000dddd');
      const offer = await h.viewing.slots({ lead: newcomer, listingId: 'BONA-W902' });
      assert.equal(offer.slots.map((s) => s.slot_id).includes(SLOT), true, `${steps} steps: Google shows 10:00 free, so it is offered`);
      const got = await h.viewing.commitBooking({ lead: newcomer, listingId: 'BONA-W902', slotId: SLOT });
      assert.equal(got.ok, true, `${steps} steps: ${JSON.stringify(got)}`);
      const rowOf = (id) => h.rows().find((r) => r.booking_id === id);
      for (const [i, b] of booked.entries()) {
        const want = R(2026, 12, 6, hours[i] + 2);
        assert.deepEqual([rowOf(b.bookingId).status, rowOf(b.bookingId).start_ts, rowOf(b.bookingId).end_ts], ['booked', want, want + H], `${steps} steps: row ${i} followed its event`);
        assert.equal(taskFor(h, b.bookingId).due_ts, want, `${steps} steps: task ${i} follows`);
      }
      assert.deepEqual([rowOf(got.bookingId).status, rowOf(got.bookingId).start_ts], ['booked', SLOT_TS]);
      assert.deepEqual(doubleBooked(h), []);
      assert.deepEqual(h.logs.filter((l) => l.evt === 'viewing.reconcile_conflict'), []);
      assert.equal(gcal.calls.filter((c) => c[0] === 'insert').length, steps + 1, 'one event per booking, none refused');
    } finally { h.db.close(); }
  }
});

test('a start freed by an owner DELETE and a move (12:00 deleted, Google 404; then 10:00 → 12:00), or by a delete alone, books at once: in the calendar the event was made in, the commit reads the 404 as reconcile does and cancels that row before the moves, in the reserve\'s transaction', async () => {
  const THU = { start: R(2026, 12, 3, 0), end: R(2026, 12, 4, 0) }; // Thursday is full, so the offer starts on Sunday
  const gcal = Object.assign(fakeGcal({ busy: () => [THU, ...calendarBusy(gcal)] }), { calendarTag: calendarTag('calendar-a@example.com') });
  const clock = { t: NOW };
  const h = setup({ gcal, clock });
  try {
    const rowOf = (id) => h.rows().find((r) => r.booking_id === id);
    const ten = await h.viewing.commitBooking({ lead: h.lead('LEAD-20261201-0000aaaa'), listingId: 'BONA-W901', slotId: SLOT });
    const noon = await h.viewing.commitBooking({ lead: h.lead('LEAD-20261201-0000bbbb'), listingId: 'BONA-W901', slotId: '2026-12-06T12:00+03:00' });
    assert.equal(ten.ok && noon.ok, true);
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 0, cancelled: 0, held: 0 }, 'the morning reconcile');
    // The owner deletes the 12:00 viewing (Google answers 404 for it), then moves the 10:00 one to 12:00.
    gcal.events.delete(noon.eventId);
    moveEvent(h, ten.eventId, '2026-12-06T12:00:00+03:00', '2026-12-06T13:00:00+03:00');
    const newcomer = h.lead('LEAD-20261201-0000cccc');
    const offer = await h.viewing.slots({ lead: newcomer, listingId: 'BONA-W902' });
    assert.equal(offer.slots.map((s) => s.slot_id).includes(SLOT), true, 'Google shows 10:00 free, so it is offered');
    const got = await h.viewing.commitBooking({ lead: newcomer, listingId: 'BONA-W902', slotId: SLOT });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(rowOf(noon.bookingId).status, 'cancelled', 'the deleted booking is cancelled');
    assert.equal(taskFor(h, noon.bookingId).status, 'cancelled', 'and its task');
    assert.deepEqual([rowOf(ten.bookingId).status, rowOf(ten.bookingId).start_ts, rowOf(ten.bookingId).end_ts], ['booked', R(2026, 12, 6, 12), R(2026, 12, 6, 13)]);
    assert.equal(taskFor(h, ten.bookingId).due_ts, R(2026, 12, 6, 12), "the moved booking's task follows");
    assert.deepEqual([rowOf(got.bookingId).status, rowOf(got.bookingId).start_ts], ['booked', SLOT_TS]);
    assert.deepEqual(doubleBooked(h), []);
    assert.deepEqual(h.logs.filter((l) => l.evt === 'viewing.reconcile_conflict' || l.evt === 'viewing.event_missing'), []);
    assert.equal(gcal.calls.filter((c) => c[0] === 'insert').length, 3, 'one event per booking, none refused');
    assert.deepEqual(h.viewing.health(), { enabled: true, gcal: { configured: true, ok: true, lastErrorCode: null } });

    // A delete alone: the owner deletes the 10:00 viewing just booked, and the next client books 10:00 at once.
    gcal.events.delete(got.eventId);
    const again = await h.viewing.commitBooking({ lead: h.lead('LEAD-20261201-0000dddd'), listingId: 'BONA-W902', slotId: SLOT });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(rowOf(got.bookingId).status, 'cancelled');
    assert.equal(taskFor(h, got.bookingId).status, 'cancelled');
    assert.deepEqual(doubleBooked(h), []);

    // A calendar the robot cannot manage answers 404 for every event too: no 404 is read before the probe passes.
    gcal.events.delete(again.eventId);
    gcal.fail.access = 'not_found';
    assert.deepEqual(await h.viewing.commitBooking({ lead: h.lead('LEAD-20261201-0000eeee'), listingId: 'BONA-W902', slotId: SLOT }),
      { ok: false, reason: 'calendar', code: 'not_found' });
    assert.equal(rowOf(again.bookingId).status, 'booked');
    assert.equal(taskFor(h, again.bookingId).status, 'confirmed');
    delete gcal.fail.access;

    // The lead's own booking, over by its stored times, that the owner deleted (404 in its own calendar): the
    // commit reads it as reconcile does, so it is cancelled and the client books again (never done on a 404).
    clock.t = R(2026, 12, 7, 9);
    gcal.events.delete(ten.eventId);
    const later = await h.viewing.commitBooking({ lead: h.db.getLead('LEAD-20261201-0000aaaa'), listingId: 'BONA-W901', slotId: '2026-12-09T10:00+03:00' });
    assert.equal(later.ok, true, JSON.stringify(later));
    assert.equal(rowOf(ten.bookingId).status, 'cancelled');
    assert.equal(taskFor(h, ten.bookingId).status, 'cancelled');
    assert.equal(h.logs.some((l) => l.evt === 'viewing.event_missing' && l.bookingId === ten.bookingId), false);
    assert.deepEqual(doubleBooked(h), []);
  } finally { h.db.close(); }
});

test('a booking over by its stored times that the owner deleted after the reconcile (a 404 in the calendar its id records, the access probe passed) is no booking wherever it is read: slots() and the worker cancel the row and its task, validate() (writing nothing) passes, and the client books again; an id with no calendar keeps the hold rule', async () => {
  const WED = '2026-12-09T10:00+03:00';
  const tagged = () => Object.assign(fakeGcal(), { calendarTag: calendarTag('calendar-a@example.com') });
  /** A books Sunday 10:00, the morning reconcile finds it, the owner deletes it at 07:00, and the clock is past its stored end. */
  async function deletedAfterReconcile() {
    const clock = { t: NOW };
    const h = setup({ gcal: tagged(), clock });
    const lead = h.lead('LEAD-20261201-0000aaaa');
    const first = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(calendarTagOf(first.eventId), h.gcal.calendarTag);
    clock.t = R(2026, 12, 6, 5);
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 0, held: 0 }, 'the morning reconcile');
    h.gcal.events.delete(first.eventId); // Google answers 404 (or 410) for it now
    clock.t = R(2026, 12, 6, 11, 5);
    return { h, clock, lead, first, rowOf: (id) => h.rows().find((r) => r.booking_id === id) };
  }

  // 1. The client asks for slots first: slots() reads the event (settle()), cancels the row and its task, and offers.
  {
    const { h, lead, first, rowOf } = await deletedAfterReconcile();
    try {
      // validate() before any read: no booking, and it writes nothing and calls nothing.
      const before = JSON.stringify(h.rows());
      const calls = h.gcal.calls.length;
      assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W902', slotId: WED }).ok, true);
      assert.equal(JSON.stringify(h.rows()), before, 'validate writes nothing');
      assert.equal(h.gcal.calls.length, calls, 'validate calls nothing');
      const offer = await h.viewing.slots({ lead, listingId: 'BONA-W902' });
      assert.equal(offer.bookable, true, JSON.stringify(offer));
      assert.equal(rowOf(first.bookingId).status, 'cancelled', 'slots cancels the deleted booking');
      assert.equal(taskFor(h, first.bookingId).status, 'cancelled', 'and its task');
      assert.equal(h.logs.some((l) => l.evt === 'viewing.event_missing'), false, 'a deletion is not a missing event');
      assert.deepEqual(h.viewing.health(), { enabled: true, gcal: { configured: true, ok: true, lastErrorCode: null } });
      assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W902', slotId: WED }).ok, true);
      const got = await h.viewing.commitBooking({ lead, listingId: 'BONA-W902', slotId: WED });
      assert.equal(got.ok, true, JSON.stringify(got));
    } finally { h.db.close(); }
  }

  // 2. The worker runs first: its settle() cancels the row and its task, so validate() and slots() see no booking,
  //    and the commit books. An id with no calendar (written before ids did), over by its stored times and a 404 in
  //    the same run, keeps the hold rule: booked, flagged missing, still the lead's booking.
  {
    const { h, lead, first, rowOf } = await deletedAfterReconcile();
    try {
      const old = h.lead('LEAD-20261201-0000eeee');
      const legacy = insertRow(h.db, { id: 'bk-legacy', leadId: old.lead_id, start: R(2026, 12, 6, 8) });
      assert.equal(calendarTagOf(legacy), null);
      const out = await h.viewing.tick();
      assert.deepEqual([out.cancelled, out.done, out.moved], [1, 0, 0]);
      assert.equal(rowOf(first.bookingId).status, 'cancelled');
      assert.equal(taskFor(h, first.bookingId).status, 'cancelled');
      assert.equal(h.logs.some((l) => l.evt === 'viewing.event_missing' && l.bookingId === first.bookingId), false);
      assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W902', slotId: WED }).ok, true, 'no missing flag blocks the lead');
      assert.equal((await h.viewing.slots({ lead, listingId: 'BONA-W902' })).bookable, true);
      const got = await h.viewing.commitBooking({ lead, listingId: 'BONA-W902', slotId: WED });
      assert.equal(got.ok, true, JSON.stringify(got));
      // The older id: held as before.
      assert.equal(rowOf('bk-legacy').status, 'booked');
      assert.equal(h.logs.filter((l) => l.evt === 'viewing.event_missing' && l.bookingId === 'bk-legacy').length, 1);
      assert.equal(h.viewing.validate({ lead: old, listingId: 'BONA-W902', slotId: '2026-12-10T10:00+03:00' }).reason, 'active_booking');
      assert.deepEqual(await h.viewing.slots({ lead: old, listingId: 'BONA-W902' }), { bookable: false, reason: 'active_booking' });
      assert.equal(h.viewing.health().gcal.lastErrorCode, 'not_found');
    } finally { h.db.close(); }
  }

  // 3. A calendar the robot cannot manage answers 404 for every event too: no 404 is read before the probe passes.
  {
    const { h, lead, first, rowOf } = await deletedAfterReconcile();
    try {
      h.gcal.fail.access = 'not_found';
      await h.viewing.tick();
      assert.deepEqual(await h.viewing.slots({ lead, listingId: 'BONA-W902' }), { bookable: false, reason: 'calendar', code: 'not_found' });
      assert.equal(rowOf(first.bookingId).status, 'booked');
      assert.equal(taskFor(h, first.bookingId).status, 'confirmed');
      delete h.gcal.fail.access;
      assert.equal((await h.viewing.tick()).cancelled, 1);
      assert.equal(rowOf(first.bookingId).status, 'cancelled');
      assert.equal(taskFor(h, first.bookingId).status, 'cancelled');
    } finally { h.db.close(); }
  }
});

test('the same DELETE and move with bookings whose ids record no calendar (written before ids did): the commit cancels nothing on a 404 and answers busy, as before; the next reconcile settles it and the start books', async () => {
  const THU = { start: R(2026, 12, 3, 0), end: R(2026, 12, 4, 0) };
  const gcal = fakeGcal({ busy: () => [THU, ...calendarBusy(gcal)] });
  const h = setup({ gcal });
  try {
    const rowOf = (id) => h.rows().find((r) => r.booking_id === id);
    const ten = await h.viewing.commitBooking({ lead: h.lead('LEAD-20261201-0000aaaa'), listingId: 'BONA-W901', slotId: SLOT });
    const noon = await h.viewing.commitBooking({ lead: h.lead('LEAD-20261201-0000bbbb'), listingId: 'BONA-W901', slotId: '2026-12-06T12:00+03:00' });
    assert.equal(ten.ok && noon.ok, true);
    assert.equal(calendarTagOf(ten.eventId), null);
    assert.equal(calendarTagOf(noon.eventId), null);
    gcal.events.delete(noon.eventId);
    moveEvent(h, ten.eventId, '2026-12-06T12:00:00+03:00', '2026-12-06T13:00:00+03:00');
    const newcomer = h.lead('LEAD-20261201-0000cccc');
    assert.deepEqual(await h.viewing.commitBooking({ lead: newcomer, listingId: 'BONA-W902', slotId: SLOT }), { ok: false, reason: 'busy' });
    assert.deepEqual([rowOf(noon.bookingId).status, rowOf(noon.bookingId).start_ts], ['booked', R(2026, 12, 6, 12)], 'no 404 of an id with no calendar cancels at commit');
    assert.equal(taskFor(h, noon.bookingId).status, 'confirmed');
    assert.deepEqual([rowOf(ten.bookingId).status, rowOf(ten.bookingId).start_ts], ['booked', SLOT_TS]);
    assert.equal(gcal.calls.filter((c) => c[0] === 'insert').length, 2, 'nothing inserted');
    // The reconcile found the other event here, so it reads the 404 as a deletion: the start is free again.
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 1, cancelled: 1, held: 0 });
    const got = await h.viewing.commitBooking({ lead: newcomer, listingId: 'BONA-W902', slotId: SLOT });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(rowOf(noon.bookingId).status, 'cancelled');
    assert.deepEqual([rowOf(ten.bookingId).status, rowOf(ten.bookingId).start_ts], ['booked', R(2026, 12, 6, 12)]);
    assert.deepEqual(doubleBooked(h), []);
  } finally { h.db.close(); }
});

test('a booking over by its stored times whose event the calendar does not show (the calendar id changed) is never done on that: it stays the lead\'s one booking, health says not_found, and the right calendar again moves it to its real time', async () => {
  const WED = '2026-12-09T10:00+03:00';
  const clock = { t: NOW };
  const h = setup({ clock });
  try {
    const a = h.lead('LEAD-20261201-0000aaaa');
    const o = h.lead('LEAD-20261201-0000bbbb');
    const first = await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    const other = await h.viewing.commitBooking({ lead: o, listingId: 'BONA-W902', slotId: '2026-12-07T12:00+03:00' });
    assert.equal(first.ok && other.ok, true);
    const rowOf = (id) => h.rows().find((r) => r.booking_id === id);
    clock.t = R(2026, 12, 6, 5);
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 0, cancelled: 0, held: 0 });
    // 07:00: the owner moves A's viewing to Tuesday 12:00 on calendar A. Then BONA_GCAL_CALENDAR_ID names calendar B,
    // which holds none of the bookings' events (every get is a 404).
    moveEvent(h, first.eventId, '2026-12-08T12:00:00+03:00', '2026-12-08T13:00:00+03:00');
    const calendarA = new Map(h.gcal.events);
    h.gcal.events.clear();
    clock.t = R(2026, 12, 6, 11, 5); // past the old end
    const out = await h.viewing.tick();
    assert.deepEqual([out.done, out.moved], [0, 0]);
    assert.equal(rowOf(first.bookingId).status, 'booked', 'a 404 never makes it done');
    assert.equal(taskFor(h, first.bookingId).status, 'confirmed');
    assert.deepEqual(h.viewing.health(), { enabled: true, gcal: { configured: true, ok: false, lastErrorCode: 'not_found' } });
    assert.equal(h.logs.filter((l) => l.evt === 'viewing.event_missing' && l.bookingId === first.bookingId).length, 1);
    await h.viewing.tick();
    assert.equal(h.logs.filter((l) => l.evt === 'viewing.event_missing').length, 1, 'one journal line, not one per run');
    // The lead keeps its one booking, wherever it asks.
    assert.equal(h.viewing.validate({ lead: a, listingId: 'BONA-W902', slotId: WED }).reason, 'active_booking');
    assert.deepEqual(await h.viewing.slots({ lead: a, listingId: 'BONA-W902' }), { bookable: false, reason: 'active_booking' });
    assert.deepEqual(await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W902', slotId: WED }), { ok: false, reason: 'active_booking' });
    assert.equal(h.gcal.calls.filter((c) => c[0] === 'insert').length, 2, 'no second event for the lead');
    // The reconcile on calendar B is held: nothing is cancelled or done.
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 0, cancelled: 0, held: 2 });
    assert.deepEqual([rowOf(first.bookingId).status, rowOf(other.bookingId).status], ['booked', 'booked']);

    // Calendar A again: the next read moves the booking to its real time; it is still the lead's.
    for (const [id, ev] of calendarA) h.gcal.events.set(id, ev);
    assert.equal((await h.viewing.tick()).moved, 1);
    assert.deepEqual([rowOf(first.bookingId).status, rowOf(first.bookingId).start_ts, rowOf(first.bookingId).end_ts], ['booked', R(2026, 12, 8, 12), R(2026, 12, 8, 13)]);
    assert.equal(taskFor(h, first.bookingId).due_ts, R(2026, 12, 8, 12));
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 0, cancelled: 0, held: 0 });
    assert.deepEqual(h.viewing.health(), { enabled: true, gcal: { configured: true, ok: true, lastErrorCode: null } });
    assert.equal(h.viewing.validate({ lead: a, listingId: 'BONA-W902', slotId: WED }).reason, 'active_booking');
    // Tuesday 13:30: over by its real end, so done, and the lead can book again.
    clock.t = R(2026, 12, 8, 13, 30);
    await h.viewing.tick();
    assert.equal(rowOf(first.bookingId).status, 'done');
    assert.equal((await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W902', slotId: '2026-12-10T10:00+03:00' })).ok, true);
  } finally { h.db.close(); }

  // The lead asks before the worker runs: the commit's own read is a 404, so no second booking either.
  const kc = { t: NOW };
  const k = setup({ clock: kc });
  try {
    const lead = k.lead();
    const first = await k.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    k.gcal.events.clear();
    kc.t = R(2026, 12, 6, 11, 5);
    assert.deepEqual(await k.viewing.commitBooking({ lead, listingId: 'BONA-W902', slotId: WED }), { ok: false, reason: 'active_booking' });
    assert.deepEqual(k.rows().map((r) => [r.booking_id, r.status]), [[first.bookingId, 'booked']]);
    assert.equal(k.viewing.health().gcal.lastErrorCode, 'not_found');
  } finally { k.db.close(); }
});

test('reconcile follows a swap or a rotation the owner made in Google, in one transaction; a move onto a start another booking keeps leaves that row as it was; never two booked rows on one start', async () => {
  const h = setup();
  try {
    const book = async (leadId, slotId) => {
      const got = await h.viewing.commitBooking({ lead: h.lead(leadId), listingId: 'BONA-W901', slotId });
      assert.equal(got.ok, true, JSON.stringify(got));
      return got;
    };
    const startOf = (g) => h.rows().find((r) => r.booking_id === g.bookingId).start_ts;
    const dueOf = (g) => taskFor(h, g.bookingId).due_ts;
    const conflicts = () => h.logs.filter((l) => l.evt === 'viewing.reconcile_conflict').map((l) => l.bookingId);
    const SUN10 = R(2026, 12, 6, 10);
    const MON12 = R(2026, 12, 7, 12);
    const TUE10 = R(2026, 12, 8, 10);
    const a = await book('LEAD-20261201-0000aaaa', '2026-12-06T10:00+03:00');
    const b = await book('LEAD-20261201-0000bbbb', '2026-12-07T12:00+03:00');

    // 1. A two-way swap: each row would collide with the other's stored start one at a time.
    moveEvent(h, a.eventId, '2026-12-07T12:00:00+03:00', '2026-12-07T13:00:00+03:00');
    moveEvent(h, b.eventId, '2026-12-06T10:00:00+03:00', '2026-12-06T11:00:00+03:00');
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 2, cancelled: 0, held: 0 });
    assert.deepEqual([startOf(a), startOf(b)], [MON12, SUN10]);
    assert.deepEqual([dueOf(a), dueOf(b)], [MON12, SUN10]);
    assert.deepEqual(conflicts(), []);

    // 2. A three-way rotation: A (Mon 12) → Tue 10, C (Tue 10) → Sun 10, B (Sun 10) → Mon 12.
    const c = await book('LEAD-20261201-0000cccc', '2026-12-08T10:00+03:00');
    moveEvent(h, a.eventId, '2026-12-08T10:00:00+03:00', '2026-12-08T11:00:00+03:00');
    moveEvent(h, c.eventId, '2026-12-06T10:00:00+03:00', '2026-12-06T11:00:00+03:00');
    moveEvent(h, b.eventId, '2026-12-07T12:00:00+03:00', '2026-12-07T13:00:00+03:00');
    assert.deepEqual(await h.viewing.reconcile(), { checked: 3, moved: 3, cancelled: 0, held: 0 });
    assert.deepEqual([startOf(a), startOf(b), startOf(c)], [TUE10, MON12, SUN10]);
    assert.deepEqual([dueOf(a), dueOf(b), dueOf(c)], [TUE10, MON12, SUN10]);
    assert.deepEqual(conflicts(), []);
    assert.deepEqual(doubleBooked(h), []);

    // 3. C moved onto B's start, and B stays there: C is left as it was (the owner sees both in Google), B untouched.
    moveEvent(h, c.eventId, '2026-12-07T12:00:00+03:00', '2026-12-07T13:00:00+03:00');
    assert.deepEqual(await h.viewing.reconcile(), { checked: 3, moved: 0, cancelled: 0, held: 0 });
    assert.deepEqual([startOf(b), startOf(c)], [MON12, SUN10]);
    assert.deepEqual(conflicts(), [c.bookingId]);
    // Then the owner deletes B: the same run cancels it first, so C lands on its start.
    h.gcal.events.get(b.eventId).status = 'cancelled';
    assert.deepEqual(await h.viewing.reconcile(), { checked: 3, moved: 1, cancelled: 1, held: 0 });
    assert.equal(h.rows().find((r) => r.booking_id === b.bookingId).status, 'cancelled');
    assert.deepEqual([startOf(c), dueOf(c)], [MON12, MON12]);

    // 4. Two bookings moved onto one new start: the first (by start) takes it, the other keeps its own.
    moveEvent(h, c.eventId, '2026-12-09T14:00:00+03:00', '2026-12-09T15:00:00+03:00');
    moveEvent(h, a.eventId, '2026-12-09T14:00:00+03:00', '2026-12-09T15:00:00+03:00');
    assert.deepEqual(await h.viewing.reconcile(), { checked: 2, moved: 1, cancelled: 0, held: 0 });
    assert.deepEqual([startOf(c), startOf(a)], [R(2026, 12, 9, 14), TUE10]);
    assert.deepEqual(doubleBooked(h), []);
  } finally { h.db.close(); }
});

test('slots and validate see a row a restart left untold (booked, no task) as no booking: slots sweeps it first, as commit does; validate ignores it and writes nothing', async () => {
  const h = setup();
  try {
    const lead = h.lead();
    const other = h.lead('LEAD-20261201-0000bbbb');
    insertRow(h.db, { id: 'bk-left', leadId: lead.lead_id, start: SLOT_TS, taskId: null, created: NOW - DAY });
    const before = JSON.stringify(h.rows());
    assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: '2026-12-07T10:00+03:00' }).ok, true, 'it is not the lead\'s booking');
    assert.equal(h.viewing.validate({ lead: other, listingId: 'BONA-W901', slotId: SLOT }).ok, true, 'its start is not held');
    assert.equal(JSON.stringify(h.rows()), before, 'validate writes nothing');
    assert.equal((await h.viewing.slots({ lead, listingId: 'BONA-W901' })).bookable, true);
    assert.equal(h.rows()[0].status, 'cancel_pending', 'slots swept it, so the worker deletes its event');
    assert.ok(h.logs.some((l) => l.evt === 'viewing.stranded' && l.bookingId === 'bk-left'));
  } finally { h.db.close(); }
});

test('a restart that left an untold row (no task) past its slot: a booking before the first worker run never turns it done; the sweep takes it, booked or done, and its event goes', async () => {
  const at = (ts) => ({ dateTime: new Date(ts).toISOString() });
  const clock = { t: SLOT_TS + 2 * H }; // the new process starts after the slot ended
  const h = setup({ clock });
  try {
    const statusOf = (id) => h.rows().find((r) => r.booking_id === id).status;
    const a = h.lead('LEAD-20261201-0000aaaa');
    const b = h.lead('LEAD-20261201-0000bbbb');
    const c = h.lead('LEAD-20261201-0000cccc');
    // The earlier process reserved A's and B's rows and Google created the events; it stopped before the tasks.
    const eventA = insertRow(h.db, { id: 'bk-a', leadId: a.lead_id, start: SLOT_TS, taskId: null, created: NOW });
    const eventB = insertRow(h.db, { id: 'bk-b', leadId: b.lead_id, start: SLOT_TS + 2 * H, taskId: null, created: NOW });
    h.gcal.events.set(eventA, { id: eventA, status: 'confirmed', start: at(SLOT_TS), end: at(SLOT_TS + H) });
    h.gcal.events.set(eventB, { id: eventB, status: 'confirmed', start: at(SLOT_TS + 2 * H), end: at(SLOT_TS + 3 * H) });
    // An untold row an older build turned done (no task either): still the sweep's.
    const eventC = insertRow(h.db, { id: 'bk-c', leadId: c.lead_id, start: R(2026, 12, 3, 10), status: 'done', taskId: null, created: NOW - 2 * DAY });
    h.gcal.events.set(eventC, { id: eventC, status: 'confirmed', start: at(R(2026, 12, 3, 10)), end: at(R(2026, 12, 3, 11)) });

    // Before the first worker run, another client books, and so does A.
    const o = h.lead('LEAD-20261201-0000dddd');
    assert.equal((await h.viewing.commitBooking({ lead: o, listingId: 'BONA-W902', slotId: '2026-12-08T10:00+03:00' })).ok, true);
    assert.equal((await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: '2026-12-08T12:00+03:00' })).ok, true);
    assert.deepEqual([statusOf('bk-a'), statusOf('bk-b'), statusOf('bk-c')], ['cancel_pending', 'cancel_pending', 'cancel_pending'], 'never done: those clients were never told');
    await h.viewing.tick();
    assert.deepEqual([statusOf('bk-a'), statusOf('bk-b'), statusOf('bk-c')], ['cancelled', 'cancelled', 'cancelled']);
    assert.deepEqual([eventA, eventB, eventC].map((id) => h.gcal.events.has(id)), [false, false, false], 'no event is left for a client who was never told');
    assert.equal(h.rows().filter((r) => r.status === 'booked').length, 2, 'the two new bookings stand');
  } finally { h.db.close(); }
});

/* ---------------- slots ---------------- */

test('slots: the free grid from tomorrow, minus Google busy time and the holds of commits not yet in Google; a calendar that fails gives none', async () => {
  const h = setup({ gcal: fakeGcal({ busy: [{ start: R(2026, 12, 3, 9), end: R(2026, 12, 3, 13) }] }) });
  try {
    const lead = h.lead();
    // Another commit's hold: reserved, its insert not answered yet.
    insertRow(h.db, { id: 'bk-other', leadId: 'LEAD-OTHER', start: R(2026, 12, 3, 14), taskId: null, created: NOW - 30_000 });
    const got = await h.viewing.slots({ lead, listingId: 'BONA-W901' });
    assert.equal(got.bookable, true);
    assert.equal(got.timezone, 'Asia/Riyadh');
    assert.deepEqual(got.slots.map((s) => s.slot_id), [
      '2026-12-03T16:00+03:00', '2026-12-03T18:00+03:00',
      '2026-12-06T10:00+03:00', '2026-12-06T14:00+03:00', '2026-12-06T18:00+03:00', '2026-12-07T10:00+03:00',
    ]);
    assert.deepEqual(got.slots[0], { slot_id: '2026-12-03T16:00+03:00', label_ar: 'الخميس 3 ديسمبر 4:00 مساءً', label_en: 'Thursday 3 December, 4:00 pm' });
    const fb = h.gcal.calls.find((c) => c[0] === 'freeBusy')[1];
    assert.deepEqual(fb, { timeMin: '2026-12-03T00:00:00+03:00', timeMax: '2026-12-14T00:00:00+03:00' });
    assert.deepEqual(await h.viewing.slots({ lead, listingId: 'BONA-W904' }), { bookable: false, reason: 'listing' });
    insertRow(h.db, { id: 'bk-mine', leadId: lead.lead_id, start: R(2026, 12, 9, 10) });
    assert.deepEqual(await h.viewing.slots({ lead, listingId: 'BONA-W901' }), { bookable: false, reason: 'active_booking' });
  } finally { h.db.close(); }
  const k = setup({ gcal: fakeGcal({ fail: { freeBusy: 'forbidden' } }) });
  try {
    assert.deepEqual(await k.viewing.slots({ lead: k.lead(), listingId: 'BONA-W901' }), { bookable: false, reason: 'calendar', code: 'forbidden' });
  } finally { k.db.close(); }
});

test('slots asked late on a Wednesday whose Google calls answer after Riyadh midnight: the clock is read again after them, so Thursday (today now) is never offered, and only days the freeBusy query covered are', async () => {
  const LATE = R(2026, 12, 2, 23, 59); // Wednesday 23:59
  const AFTER = R(2026, 12, 3, 0, 1); // Thursday 00:01
  const fbBusy = { blocks: [] };
  const gcal = fakeGcal({ busy: () => fbBusy.blocks });
  const held = { holidays: false, freeBusy: false, release: null };
  for (const op of ['holidays', 'freeBusy']) {
    const real = gcal[op];
    gcal[op] = async (...args) => {
      if (held[op]) { held[op] = false; await new Promise((resolve) => { held.release = resolve; }); }
      return real(...args);
    };
  }
  const reached = async () => {
    for (let i = 0; i < 200 && !held.release; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(held.release, 'slots reached the Google call');
  };
  const answer = () => { const r = held.release; held.release = null; r(); };
  const clock = { t: LATE };
  const h = setup({ gcal, clock });
  try {
    const lead = h.lead();
    const windows = () => gcal.calls.filter((c) => c[0] === 'freeBusy').map((c) => c[1]);
    const ids = (got) => got.slots.map((s) => s.slot_id);
    // The control: at 23:59 on Wednesday, Thursday is tomorrow and is offered.
    const before = await h.viewing.slots({ lead, listingId: 'BONA-W901' });
    assert.deepEqual(ids(before), [
      '2026-12-03T10:00+03:00', '2026-12-03T14:00+03:00', '2026-12-03T18:00+03:00',
      '2026-12-06T10:00+03:00', '2026-12-06T14:00+03:00', '2026-12-06T18:00+03:00',
    ]);

    // freeBusy answers at 00:01 on Thursday. It was asked for Wednesday's days (Thursday 3 to Sunday 13):
    // Thursday is dropped, the Friday and Saturday were never offered, Sunday and Monday are.
    gcal.calls.length = 0;
    held.freeBusy = true;
    let p = h.viewing.slots({ lead, listingId: 'BONA-W901' });
    await reached();
    clock.t = AFTER;
    answer();
    let got = await p;
    assert.deepEqual(windows(), [{ timeMin: '2026-12-03T00:00:00+03:00', timeMax: '2026-12-14T00:00:00+03:00' }]);
    assert.equal(got.bookable, true);
    assert.deepEqual(ids(got), [
      '2026-12-06T10:00+03:00', '2026-12-06T14:00+03:00', '2026-12-06T18:00+03:00',
      '2026-12-07T10:00+03:00', '2026-12-07T14:00+03:00', '2026-12-07T18:00+03:00',
    ]);
    for (const s of got.slots) assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: s.slot_id }).ok, true, s.slot_id);

    // The same, with Sunday 6 to Thursday 10 busy: only Sunday 13 is left of the days queried. Monday 14
    // (a bookable day by Thursday's clock) was not in the query, so its busy time is unknown: never offered.
    clock.t = LATE;
    fbBusy.blocks = [{ start: R(2026, 12, 6, 0), end: R(2026, 12, 11, 0) }];
    gcal.calls.length = 0;
    held.freeBusy = true;
    p = h.viewing.slots({ lead, listingId: 'BONA-W901' });
    await reached();
    clock.t = AFTER;
    answer();
    got = await p;
    assert.deepEqual(windows(), [{ timeMin: '2026-12-03T00:00:00+03:00', timeMax: '2026-12-14T00:00:00+03:00' }]);
    assert.deepEqual(ids(got), ['2026-12-13T10:00+03:00', '2026-12-13T14:00+03:00', '2026-12-13T18:00+03:00']);

    // Thursday 3 the only free day queried: nothing is left once it is today.
    clock.t = LATE;
    fbBusy.blocks = [{ start: R(2026, 12, 6, 0), end: R(2026, 12, 14, 0) }];
    gcal.calls.length = 0;
    held.freeBusy = true;
    p = h.viewing.slots({ lead, listingId: 'BONA-W901' });
    await reached();
    clock.t = AFTER;
    answer();
    assert.deepEqual(await p, { bookable: false, reason: 'none_free', timezone: 'Asia/Riyadh', slots: [] });

    // The holidays answer after midnight: the days and the freeBusy window come from the clock then (Sunday 6 on).
    clock.t = LATE;
    fbBusy.blocks = [];
    gcal.calls.length = 0;
    held.holidays = true;
    p = h.viewing.slots({ lead, listingId: 'BONA-W901' });
    await reached();
    clock.t = AFTER;
    answer();
    got = await p;
    assert.deepEqual(windows(), [{ timeMin: '2026-12-06T00:00:00+03:00', timeMax: '2026-12-15T00:00:00+03:00' }]);
    assert.deepEqual(ids(got), [
      '2026-12-06T10:00+03:00', '2026-12-06T14:00+03:00', '2026-12-06T18:00+03:00',
      '2026-12-07T10:00+03:00', '2026-12-07T14:00+03:00', '2026-12-07T18:00+03:00',
    ]);
    assert.deepEqual(h.rows(), [], 'slots writes no booking');
  } finally { h.db.close(); }
});

test('slots runs the whole gate again after every Google answer and right before it returns: booking switched off, Not a client, a calendar mismatch or a booking of the lead landing while settle, the holidays or freeBusy is on its way answers that reason, never a slot', async () => {
  const WED = '2026-12-09T10:00+03:00';
  const other = calendarTag('calendar-b@example.com');
  /** One harness per run: a fake calendar of calendar A whose one held call waits for the test to answer. */
  const harness = () => {
    const gcal = Object.assign(fakeGcal(), { calendarTag: calendarTag('calendar-a@example.com') });
    const held = { op: null, release: null };
    for (const op of ['access', 'holidays', 'freeBusy']) {
      const real = gcal[op];
      gcal[op] = async (...args) => {
        if (held.op === op) { held.op = null; await new Promise((resolve) => { held.release = resolve; }); }
        return real(...args);
      };
    }
    const h = setup({ gcal });
    const inbox = createInboxStore(h.db, { onPurge: (id) => h.viewing.onPurge(id) });
    return {
      ...h,
      inbox,
      hold: (op) => { held.op = op; },
      reached: async () => {
        for (let i = 0; i < 200 && !held.release; i += 1) await new Promise((resolve) => setImmediate(resolve));
        assert.ok(held.release, 'slots reached the held call');
      },
      answer: () => { const r = held.release; held.release = null; r(); },
    };
  };
  // What changes while Google answers, and the reason slots must give for it.
  const changes = {
    'booking switched off': { reason: 'off', run: (h) => h.team.setSetting('calendar_booking', '0') },
    // As routes.mjs runs it: the viewing seam first, then the purge, in one transaction (DESIGN §8.4).
    'Not a client': { reason: 'not_in_inbox', run: (h, lead) => h.db.transaction(() => { h.viewing.onLeadLeaving(lead.lead_id); h.inbox.leaveInbox(lead.lead_id); }) },
    // Another lead's booking whose event was made in calendar B (a process on another calendar id wrote it).
    'a calendar mismatch': {
      reason: 'calendar_mismatch',
      run: (h) => insertRow(h.db, { id: 'bk-elsewhere', leadId: 'LEAD-20261201-0000eeee', start: R(2026, 12, 10, 14), eventId: eventIdFor('LEAD-20261201-0000eeee', R(2026, 12, 10, 14), 0, other) }),
    },
    // The lead's own commit (another tool call) lands meanwhile; the one held call was the slots' own.
    'a booking of the lead': {
      reason: 'active_booking',
      run: async (h, lead) => {
        const got = await h.viewing.commitBooking({ lead, listingId: 'BONA-W902', slotId: WED });
        assert.equal(got.ok, true, JSON.stringify(got));
      },
    },
  };
  /** settle() reads only when the lead has a booking over by its stored times: one booked Sunday, the clock past its end. */
  const ready = async (h, lead, op) => {
    if (op !== 'access') return;
    const first = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(first.ok, true, JSON.stringify(first));
    h.clock.t = R(2026, 12, 6, 11, 5);
  };
  for (const op of ['access', 'holidays', 'freeBusy']) {
    // The control: nothing changes while the call is held, and slots are offered.
    {
      const h = harness();
      try {
        const lead = h.lead();
        await ready(h, lead, op);
        h.hold(op);
        const p = h.viewing.slots({ lead, listingId: 'BONA-W901' });
        await h.reached();
        h.answer();
        const got = await p;
        assert.equal(got.bookable, true, `${op}: ${JSON.stringify(got)}`);
        assert.ok(got.slots.length > 0, op);
      } finally { h.db.close(); }
    }
    for (const [what, change] of Object.entries(changes)) {
      const h = harness();
      try {
        const lead = h.lead();
        await ready(h, lead, op);
        h.hold(op);
        const p = h.viewing.slots({ lead, listingId: 'BONA-W901' });
        await h.reached();
        await change.run(h, lead);
        h.answer();
        assert.deepEqual(await p, { bookable: false, reason: change.reason }, `${what} while ${op} is on its way`);
        // validate() says the same for a slot slots would otherwise have offered.
        assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: '2026-12-09T14:00+03:00' }).reason, change.reason, `${what} (${op}): validate`);
      } finally { h.db.close(); }
    }
  }
});

test("a start another lead books while this lookup's freeBusy is on its way is never offered: a booked row with no task when freeBusy was asked (reserved meanwhile, or a hold then) is local busy time for that lookup, task or not; a booking Google had before the ask goes by Google, so an owner move still frees its first start", async () => {
  const THU = { start: R(2026, 12, 3, 0), end: R(2026, 12, 4, 0) }; // Thursday is full, so the offer starts on Sunday
  const SUN16 = '2026-12-06T16:00+03:00';
  const MON = '2026-12-07T10:00+03:00';
  /**
   * A fake calendar whose freeBusy answers with the calendar as it was when the request arrived (a snapshot), and
   * whose next call of a held op waits, after Google computed its answer, until the test releases it.
   */
  const harness = () => {
    const gcal = fakeGcal({ busy: () => [THU, ...calendarBusy(gcal)] });
    const pending = [];
    for (const op of ['holidays', 'freeBusy']) {
      const real = gcal[op];
      gcal[op] = async (...args) => {
        const answer = await real(...args);
        const i = pending.findIndex((g) => g.op === op);
        if (i >= 0) {
          const [g] = pending.splice(i, 1);
          await new Promise((resolve) => { g.release = resolve; });
        }
        return answer;
      };
    }
    const h = setup({ gcal });
    const hold = (op) => {
      const g = { op, release: null };
      pending.push(g);
      return {
        reached: async () => {
          for (let i = 0; i < 200 && !g.release; i += 1) await new Promise((resolve) => setImmediate(resolve));
          assert.ok(g.release, `the held ${op} was reached`);
        },
        answer: () => g.release(),
      };
    };
    const offered = async (lead) => {
      const got = await h.viewing.slots({ lead, listingId: 'BONA-W902' });
      assert.equal(got.bookable, true, JSON.stringify(got));
      return got.slots.map((s) => s.slot_id);
    };
    return { ...h, hold, offered };
  };
  const rowOf = (h, id) => h.rows().find((r) => r.booking_id === id);

  // B reserves AND finishes (its task attached) while A's freeBusy answer, taken before B's insert, is on its way.
  {
    const h = harness();
    try {
      const a = h.lead('LEAD-20261201-0000aaaa');
      const b = h.lead('LEAD-20261201-0000bbbb');
      assert.equal((await h.offered(a)).includes(SLOT), true, 'free at first');
      const fb = h.hold('freeBusy');
      const p = h.offered(a);
      await fb.reached();
      const got = await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W901', slotId: SLOT });
      assert.equal(got.ok, true, JSON.stringify(got));
      assert.ok(rowOf(h, got.bookingId).task_id, "B's task is attached before A's answer is read");
      fb.answer();
      const list = await p;
      assert.equal(list.includes(SLOT), false, "B's new booking is busy for A's lookup, though A's snapshot predates it");
      assert.equal(list.includes(SUN16), true, 'the rest of the day is still offered');
      // The next lookup goes by Google, which shows B's event; once the owner moves it, its first start is free again.
      assert.equal((await h.offered(a)).includes(SLOT), false);
      moveEvent(h, got.eventId, '2026-12-06T16:00:00+03:00', '2026-12-06T17:00:00+03:00');
      const after = await h.offered(a);
      assert.equal(after.includes(SLOT), true, 'an owner move frees the first start');
      assert.equal(after.includes(SUN16), false, 'the new one is busy');
    } finally { h.db.close(); }
  }

  // B reserved BEFORE A asked (a hold then, its insert not sent yet) and got its task while A's answer was on its way.
  {
    const h = harness();
    try {
      const a = h.lead('LEAD-20261201-0000aaaa');
      const b = h.lead('LEAD-20261201-0000bbbb');
      const bHol = h.hold('holidays');
      const pb = h.viewing.commitBooking({ lead: b, listingId: 'BONA-W901', slotId: SLOT });
      await bHol.reached();
      assert.equal(h.rows().length, 1, "B's row is reserved");
      assert.equal(h.rows()[0].task_id, null, 'a hold: no task yet');
      const aFb = h.hold('freeBusy');
      const pa = h.offered(a);
      await aFb.reached();
      bHol.answer();
      const got = await pb;
      assert.equal(got.ok, true, JSON.stringify(got));
      assert.ok(rowOf(h, got.bookingId).task_id);
      aFb.answer();
      assert.equal((await pa).includes(SLOT), false, 'a hold when A asked stays busy for that lookup once its task is attached');
    } finally { h.db.close(); }
  }

  // A booking Google already had when A asked, which the owner moved: its first start is offered during the held
  // lookup, while a start C books meanwhile is not.
  {
    const h = harness();
    try {
      const a = h.lead('LEAD-20261201-0000aaaa');
      const b = h.lead('LEAD-20261201-0000bbbb');
      const c = h.lead('LEAD-20261201-0000cccc');
      const first = await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W901', slotId: SLOT });
      assert.equal(first.ok, true, JSON.stringify(first));
      moveEvent(h, first.eventId, '2026-12-06T16:00:00+03:00', '2026-12-06T17:00:00+03:00');
      const fb = h.hold('freeBusy');
      const p = h.offered(a);
      await fb.reached();
      const other = await h.viewing.commitBooking({ lead: c, listingId: 'BONA-W901', slotId: MON });
      assert.equal(other.ok, true, JSON.stringify(other));
      fb.answer();
      const list = await p;
      assert.equal(list.includes(SLOT), true, "the moved booking's first start is free: Google decides, not its stored times");
      assert.equal(list.includes(SUN16), false, 'where Google shows it now is busy');
      assert.equal(list.includes(MON), false, "C's booking made during the lookup is busy");
    } finally { h.db.close(); }
  }

  // Codex r12: B's insert reaches Google but its answer is lost (uncertain), so B's row waits for the worker as
  // cancel_pending with its event still in the calendar, while A's answer, taken before that insert, is on its way.
  {
    const h = harness();
    try {
      const a = h.lead('LEAD-20261201-0000aaaa');
      const b = h.lead('LEAD-20261201-0000bbbb');
      const realInsert = h.gcal.insert;
      h.gcal.insert = async (ev) => {
        h.gcal.events.set(ev.id, { ...ev, status: 'confirmed' }); // it went through, but the answer was lost
        return { ok: false, code: 'timeout', uncertain: true };
      };
      const fb = h.hold('freeBusy');
      const p = h.offered(a);
      await fb.reached();
      const got = await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W901', slotId: SLOT });
      assert.equal(got.ok, false, JSON.stringify(got));
      assert.deepEqual(h.rows().map((r) => r.status), ['cancel_pending'], "B's row waits for the worker to delete its event");
      fb.answer();
      const list = await p;
      assert.equal(list.includes(SLOT), false, 'an uncertain insert awaiting its deletion is busy for that lookup');
      assert.equal(list.includes(SUN16), true, 'the rest of the day is still offered');
      h.gcal.insert = realInsert;
      // The worker deletes the event and cancels the row: the start is free again.
      await h.viewing.tick();
      assert.deepEqual(h.rows().map((r) => r.status), ['cancelled']);
      assert.equal((await h.offered(a)).includes(SLOT), true, 'free once the worker deleted the event');
    } finally { h.db.close(); }
  }

  // Codex r13: a confirmed booking the owner moved in Google, then cancelled (its row cancel_pending, its task kept)
  // before the worker deleted the event: Google decides, so its old start is offered and the moved one is busy.
  {
    const h = harness();
    try {
      const a = h.lead('LEAD-20261201-0000aaaa');
      const b = h.lead('LEAD-20261201-0000bbbb');
      const got = await h.viewing.commitBooking({ lead: b, listingId: 'BONA-W901', slotId: SLOT });
      assert.equal(got.ok, true, JSON.stringify(got));
      moveEvent(h, got.eventId, '2026-12-06T16:00:00+03:00', '2026-12-06T17:00:00+03:00');
      assert.equal(h.viewing.cancelForLead(b.lead_id), 1);
      assert.equal(rowOf(h, got.bookingId).status, 'cancel_pending');
      assert.ok(rowOf(h, got.bookingId).task_id, 'the row keeps its task until the worker settles it');
      const list = await h.offered(a);
      assert.equal(list.includes(SLOT), true, "the moved booking's old start is free: its stored times never count");
      assert.equal(list.includes(SUN16), false, 'where Google shows it until the worker deletes it is busy');
      await h.viewing.tick();
      assert.equal(rowOf(h, got.bookingId).status, 'cancelled');
      // The offer is a spread of starts, so the commit's own freeBusy check says whether 16:00 is free now.
      const at16 = await h.viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SUN16 });
      assert.equal(at16.ok, true, `free once the worker deleted the event: ${JSON.stringify(at16)}`);
    } finally { h.db.close(); }
  }
});

/* ---------------- the dashboard hooks, wired the way index.mjs wires them ---------------- */

const OWNER = '966500000009';
async function withDashboard(fn) {
  const h = setup();
  const inbox = createInboxStore(h.db, { onPurge: (id) => h.viewing.onPurge(id) });
  h.team.ensureOwner({ phone: OWNER, name: 'Owner Example' });
  const sent = [];
  const routes = createDashboardRoutes({
    db: h.db, cfg: { publicApi: API_BASE, dashCookieDays: 30, maxBodyBytes: 16 * 1024 },
    inventory: createInventory({ file: WORKTREE_LISTINGS, siteUrl: SITE }), team: h.team, audit: createAudit(h.db), inbox,
    sendCode: async ({ jid, text }) => { sent.push({ jid, text }); return { ok: true }; },
    hooks: { onTaskChange: (task, patch) => h.viewing.onTaskChange(task, patch), onLeadLeaving: (leadId) => h.viewing.onLeadLeaving(leadId) },
    log: () => {},
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    routes.handle({ req, res, url, p: url.pathname.replace(/\/+$/, '') || '/', ip: '127.0.0.1' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const postForm = (p, fields, { cookie } = {}) => fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  const cookieOf = (res, name) => {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      if (pair.slice(0, pair.indexOf('=')) === name && !c.includes('Max-Age=0')) return pair.slice(pair.indexOf('=') + 1);
    }
    return null;
  };
  const asked = await postForm('/dashboard/login/code', { _dash: '1', phone: OWNER });
  await routes.auth.flush();
  const code = /(\d{6})/.exec(sent.at(-1).text)[1];
  const verified = await postForm('/dashboard/login/verify', { _dash: '1', code }, { cookie: `bona_dash_try=${cookieOf(asked, 'bona_dash_try')}` });
  const cookie = `bona_dash=${cookieOf(verified, 'bona_dash')}`;
  try {
    await fn({ ...h, inbox, post: (p, fields) => postForm(p, { _dash: '1', ...fields }, { cookie }) });
  } finally {
    await routes.auth.flush();
    await new Promise((resolve) => server.close(resolve));
    h.db.close();
  }
}

test('Not a client and a never-list number call deleteForLead first: the rows are marked before the purge, and they outlive the lead row (no FK)', async () => {
  await withDashboard(async ({ db, viewing, lead, rows, post, gcal }) => {
    const a = lead('LEAD-20261201-0000aaaa');
    await viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    const doneId = insertRow(db, { id: 'bk-done', leadId: a.lead_id, start: R(2026, 11, 25, 10), status: 'done', created: NOW - 9 * DAY });
    gcal.events.set(doneId, { id: doneId });
    assert.equal((await post(`/v1/admin/inbox/${a.lead_id}/out`, {})).status, 303);
    assert.equal(db.getLead(a.lead_id).inbox_state, 'out');
    assert.deepEqual(rows().map((r) => r.status), ['cancel_pending', 'cancel_pending']);
    // The deletion runbook then removes the lead row: the bookings stay, so the worker still finds the events.
    db.db.prepare('DELETE FROM leads WHERE lead_id = ?').run(a.lead_id);
    assert.equal(rows().length, 2);
    await viewing.tick();
    assert.deepEqual(rows().map((r) => r.status), ['cancelled', 'cancelled']);
    assert.equal(gcal.events.size, 0);
    // A number put on the never list: the same.
    const b = lead('LEAD-20261201-0000bbbb', { phone_e164: '966500000077' });
    await viewing.commitBooking({ lead: b, listingId: 'BONA-W902', slotId: '2026-12-07T10:00+03:00' });
    assert.equal((await post('/v1/admin/never', { phone: '0500000077', note: 'family' })).status, 303);
    assert.equal(db.getLead(b.lead_id).inbox_state, 'out');
    assert.equal(rows().find((r) => r.lead_id === b.lead_id).status, 'cancel_pending');
    // A number that becomes a colleague's: the same.
    const c = lead('LEAD-20261201-0000cccc', { phone_e164: '966500000074' });
    await viewing.commitBooking({ lead: c, listingId: 'BONA-W903', slotId: '2026-12-08T10:00+03:00' });
    assert.equal((await post('/v1/admin/team', { name: 'Omar Example', phone: '0500000074', role: 'staff' })).status, 303);
    assert.equal(db.getLead(c.lead_id).inbox_state, 'out');
    assert.equal(rows().find((r) => r.lead_id === c.lead_id).status, 'cancel_pending');
  });
});

test('a booked task set to cancelled on the dashboard reaches onTaskChange and cancels its booking; any other change does not', async () => {
  await withDashboard(async ({ db, viewing, lead, rows, post }) => {
    const a = lead();
    const got = await viewing.commitBooking({ lead: a, listingId: 'BONA-W901', slotId: SLOT });
    const task = tasksForLead(db, a.lead_id).find((t) => t.kind === 'viewing');
    assert.equal((await post(`/v1/admin/leads/${a.lead_id}/task`, { task_id: task.task_id, status: 'done' })).status, 303);
    assert.equal(rows()[0].status, 'booked', 'done is not a cancel');
    assert.equal((await post(`/v1/admin/leads/${a.lead_id}/task`, { task_id: task.task_id, status: 'cancelled' })).status, 303);
    assert.equal(rows()[0].status, 'cancel_pending');
    assert.equal(rows()[0].booking_id, got.bookingId);
    // A viewing task the owner added by hand has no booking: cancelling it touches nothing.
    const b = lead('LEAD-20261201-0000bbbb');
    await viewing.commitBooking({ lead: b, listingId: 'BONA-W902', slotId: '2026-12-07T10:00+03:00' });
    const own = addTask(db, { leadId: b.lead_id, kind: 'viewing', dueTs: NOW + 9 * DAY });
    assert.equal((await post(`/v1/admin/leads/${b.lead_id}/task`, { task_id: own.task_id, status: 'cancelled' })).status, 303);
    assert.equal(rows().find((r) => r.lead_id === b.lead_id).status, 'booked');
    // Moving a booked task's time is refused (the calendar is the source of truth).
    const booked = tasksForLead(db, b.lead_id).find((t) => t.details.booking_id);
    const moved = await post(`/v1/admin/leads/${b.lead_id}/task`, { task_id: booked.task_id, status: 'confirmed', due_at: '2026-12-08T14:00' });
    assert.match(moved.headers.get('location') ?? '', /error=bad_task/);
    assert.equal(tasksForLead(db, b.lead_id).find((t) => t.task_id === booked.task_id).due_ts, R(2026, 12, 7, 10));
  });
});
