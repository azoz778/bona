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
import { createTeam } from '../lib/team.mjs';
import { createAudit } from '../lib/audit.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createDashboardRoutes } from '../lib/dashboard/routes.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { createGcal, TOKEN_URL } from '../lib/gcal.mjs';
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

/** A booked row written straight into the table (another process, or an earlier day). */
function insertRow(db, { id, leadId, start, status = 'booked', listing = 'BONA-W901', created = NOW - DAY, eventId = `bona${id.replace(/[^0-9a-v]/g, '')}0000` }) {
  db.db.prepare(`INSERT INTO viewing_bookings (booking_id, lead_id, task_id, listing_id, start_ts, end_ts, event_id, status, client_told, created, updated)
    VALUES (?,?,NULL,?,?,?,?,?,0,?,?)`).run(id, leadId, listing, start, start + H, eventId, status, created, created);
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
    // One active booking per lead; another lead's booked start is taken.
    insertRow(h.db, { id: 'bk-a', leadId: lead.lead_id, start: R(2026, 12, 7, 12) });
    assert.equal(reason({}), 'active_booking');
    const other = h.lead('LEAD-20261201-0000cccc');
    assert.equal(h.viewing.validate({ lead: other, listingId: 'BONA-W901', slotId: '2026-12-07T12:00+03:00' }).reason, 'busy');
    // At most 6 bookings made today, whatever became of them.
    for (let i = 0; i < DAY_CAP - 1; i += 1) insertRow(h.db, { id: `bk-cap${i}`, leadId: `LEAD-X${i}`, start: R(2026, 12, 8 + i, 10), status: i % 2 ? 'cancelled' : 'booked', created: NOW - H });
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

test('a past booked row turns done in the same transaction, so a returning client can book again', async () => {
  const clock = { t: NOW };
  const h = setup({ clock });
  try {
    const lead = h.lead();
    insertRow(h.db, { id: 'bk-old', leadId: lead.lead_id, start: R(2026, 11, 30, 10), created: NOW - 5 * DAY });
    clock.t = NOW; // the old viewing (30 Nov) is over
    assert.equal(h.viewing.validate({ lead, listingId: 'BONA-W901', slotId: SLOT }).ok, true, 'a past booking is not active');
    const got = await h.viewing.commitBooking({ lead, listingId: 'BONA-W901', slotId: SLOT });
    assert.equal(got.ok, true);
    assert.deepEqual(h.rows().map((r) => [r.booking_id === 'bk-old' ? 'old' : 'new', r.status]), [['old', 'done'], ['new', 'booked']]);
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
    assert.deepEqual(out, { checked: 2, moved: 1, cancelled: 1 });
    assert.equal(rowOf(ga.bookingId).start_ts, R(2026, 12, 6, 11, 30));
    assert.equal(rowOf(ga.bookingId).end_ts, R(2026, 12, 6, 12, 30));
    assert.equal(rowOf(ga.bookingId).status, 'booked');
    assert.equal(tasksForLead(h.db, a.lead_id).find((t) => t.kind === 'viewing').due_ts, R(2026, 12, 6, 11, 30));
    assert.equal(rowOf(gb.bookingId).status, 'cancelled');
    assert.equal(tasksForLead(h.db, b.lead_id).find((t) => t.kind === 'viewing').status, 'cancelled');
    // An event removed outright (404) is cancelled too; a calendar that cannot be read changes nothing.
    h.gcal.events.delete(rowOf(ga.bookingId).event_id);
    h.gcal.fail.get = 'timeout';
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 0 });
    assert.equal(rowOf(ga.bookingId).status, 'booked');
    delete h.gcal.fail.get;
    assert.deepEqual(await h.viewing.reconcile(), { checked: 1, moved: 0, cancelled: 1 });
    assert.equal(rowOf(ga.bookingId).status, 'cancelled');
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

/* ---------------- slots ---------------- */

test('slots: the free grid from tomorrow, minus Google busy time and booked rows; a calendar that fails gives none', async () => {
  const h = setup({ gcal: fakeGcal({ busy: [{ start: R(2026, 12, 3, 9), end: R(2026, 12, 3, 13) }] }) });
  try {
    const lead = h.lead();
    insertRow(h.db, { id: 'bk-other', leadId: 'LEAD-OTHER', start: R(2026, 12, 3, 14), created: NOW - 3 * DAY });
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
