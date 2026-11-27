/**
 * Viewing bookings on the owner's calendar (DESIGN §8; PR-B1, task T10). It replaces PR-F2b's stub
 * behind the same seam, and adds deleteForLead, markTold and reconcile.
 *
 * Booking needs three things at once (DESIGN §2): `calendar_booking` = '1', auto mode for the lead
 * (ownerTest.autoMode), and a calendar (BONA_GCAL_SA_FILE and BONA_GCAL_CALENDAR_ID). Without them
 * nothing is bookable and nothing is booked, exactly as the stub answered. A bookable home is a
 * listing in listings.json, by its exact id, `available`, in Jeddah.
 *
 * Who calls what (the callers arrive with later PRs; index.mjs already wires the hooks):
 *   - the tools (PR-B4): slots() for viewing_slots, validate() for book_viewing (writes nothing);
 *   - dana-commit (PR-B4), after preSend: commitBooking(), then markTold() once the confirmation
 *     was accepted, then the booking note;
 *   - the dashboard (routes.mjs hooks): onTaskChange (a booked task set to cancelled) and
 *     onLeadLeaving (Not a client, a new colleague's or never-list number → deleteForLead);
 *   - the inbox store's `onPurge` (purgeLead: leaving the inbox, the retention purge, the test
 *     switch going off) → cancelForLead;
 *   - the timers (PR-INT): tick() every 5 min (cancellations, past → done, the holiday copy) and
 *     reconcile() at 05:00 and before the summary.
 *
 * The hooks and the purge only write rows, synchronously, inside the caller's transaction; they
 * never call Google (DESIGN §8.4). Google is called from slots, commitBooking, tick and reconcile.
 * Logs carry booking ids, lead ids and codes only: never a name, a phone, a calendar id or text.
 *
 * For PR-INT (index.mjs): pass `inventory` (the shared one; without it no listing is bookable),
 * and `fetchImpl` for the tests' fake fetch.
 */
import { newId } from './db.mjs';
import { bookingEvent, createGcal, eventIdFor } from './gcal.mjs';
import { propertyPath } from './inventory.mjs';
import { bookViewing, cancelBookedViewing, moveBookedViewing, plausibleName, saveNeeds } from './lead-tasks.mjs';
import {
  TIMEZONE, VIEWING_MS, bookableDays, checkSlot, dayStart, freeSlots, isFree, isoRiyadh, parseSlotId, riyadhDay, searchWindow,
  slotId as toSlotId, slotWhen, slotWindow,
} from './slots.mjs';

/** At most this many bookings are made in one Riyadh day (DESIGN §8.4, abuse). */
export const DAY_CAP = 6;
/** The only city whose homes can be booked. */
export const BOOKABLE_CITY = 'Jeddah';
/** Cancellations per worker run, and future bookings per reconcile. */
const WORKER_BATCH = 25;
const RECONCILE_BATCH = 200;
/** Codes that mean the whole calendar is unreachable: the rest of a run would fail the same way. */
const CALENDAR_DOWN = new Set(['auth', 'forbidden', 'network', 'timeout', 'quota']);

const NOT_CONFIGURED = Object.freeze({ configured: false, ok: false, lastErrorCode: null });

/** `exact` (a maps link), `district` (a centroid: words only, never a pin) or `none`. */
export function pinOf(listing) {
  const lat = Number(listing?.map?.lat);
  const lng = Number(listing?.map?.lng);
  const valid = listing?.map != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (listing?.mapPrecision === 'exact' && valid) return 'exact';
  if (listing?.mapPrecision === 'district') return 'district';
  return 'none';
}

const homeUrl = (siteUrl, listing, lang) => `${String(siteUrl).replace(/\/+$/, '')}${propertyPath(listing.slug, lang)}`;

/**
 * The confirmation that REPLACES the model's text (DESIGN §4.1, §8.3 step 8): built in code, so
 * only code ever states a booked time. A maps link for an exact pin; otherwise the meeting point
 * comes from the team.
 */
export function confirmationText({ listing, startTs, language = 'ar', siteUrl }) {
  const en = language === 'en';
  const lang = en ? 'en' : 'ar';
  const title = (en ? listing.title?.en : listing.title?.ar) || listing.title?.en || listing.id;
  const url = homeUrl(siteUrl, listing, lang);
  const where = pinOf(listing) === 'exact'
    ? `https://maps.google.com/?q=${Number(listing.map.lat)},${Number(listing.map.lng)}`
    : (en ? 'our team will send you the meeting point before the viewing' : 'يرسل لك فريقنا نقطة اللقاء قبل الموعد');
  return en
    ? ['Your viewing is booked ✅', `${slotWhen(startTs, 'en')} (one hour)`, `${title} — ${url}`, `Location: ${where}`, 'To change or cancel, write to us here.'].join('\n')
    : ['تم حجز موعد معاينتك ✅', `${slotWhen(startTs, 'ar')} (ساعة واحدة)`, `${title} — ${url}`, `الموقع: ${where}`, 'لتغيير الموعد أو إلغائه اكتب لنا هنا.'].join('\n');
}

/** The dashboard link of a lead, on the API's own origin. */
function leadLink(publicApi, leadId) {
  try {
    const u = new URL(String(publicApi));
    u.pathname = `/dashboard/leads/${encodeURIComponent(leadId)}`;
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return `/dashboard/leads/${encodeURIComponent(leadId)}`;
  }
}

/** The error class only, never its words. */
const errClass = (err) => (err && typeof err === 'object' && typeof err.name === 'string' ? err.name : typeof err);

/**
 * @typedef {object} Viewing
 * @property {boolean} configured  a calendar is set up (and a database to keep bookings in)
 * @property {(o: { lead?: object, leadId?: string, listingId: string }) => Promise<object>} slots
 *   `{ bookable: true, timezone, slots: [{ slot_id, label_ar, label_en }] }`, or `{ bookable: false, reason?, code? }`
 *   (no reason when booking is off, as the stub answered)
 * @property {(o: { lead?: object, leadId?: string, listingId: string, slotId: string, name?: string }) => object} validate
 *   `{ ok: true, leadId, listingId, slotId, startTs, endTs, name }` or `{ ok: false, reason, needName? }`; writes nothing
 * @property {(o: { lead?: object, leadId?: string, listingId: string, slotId: string, name?: string, language?: 'ar'|'en' }) => Promise<object>} commitBooking
 *   `{ ok: true, bookingId, eventId, listingId, slotId, startTs, endTs, pin, text }` or `{ ok: false, reason, code? }`
 * @property {(bookingId: string) => boolean} markTold  the confirmation reached the client (client_told = 1)
 * @property {(leadId: string) => number} cancelForLead  booked rows → cancel_pending (rows only)
 * @property {(leadId: string) => number} deleteForLead  booked AND done rows → cancel_pending (rows only)
 * @property {(task: object, patch: object) => void} onTaskChange
 * @property {(leadId: string) => void} onLeadLeaving
 * @property {(leadId: string) => void} onPurge
 * @property {() => Promise<object>|undefined} tick  undefined when there is no calendar
 * @property {() => Promise<{ checked: number, moved: number, cancelled: number }>} reconcile
 * @property {() => { enabled: boolean, gcal: { configured: boolean, ok: boolean, lastErrorCode: string|null } }} health
 */

/**
 * @param {{ db?: object, cfg?: object, team?: object, ownerTest?: object, inventory?: object, gcal?: object,
 *           fetchImpl?: typeof fetch, siteUrl?: string, publicApi?: string, log?: Function, now?: () => number }} [deps]
 * @returns {Viewing}
 */
export function createViewing(deps = {}) {
  const { db = null, cfg = null, team = null, ownerTest = null, inventory = null, log = () => {}, now = () => Date.now() } = deps;
  const gcal = deps.gcal ?? (cfg ? createGcal({
    saFile: cfg.gcalSaFile, calendarId: cfg.gcalCalendarId, extraBusyIds: cfg.gcalExtraBusyIds, fetchImpl: deps.fetchImpl, now, log,
  }) : null);
  const configured = Boolean(db && gcal?.configured);
  const siteUrl = deps.siteUrl ?? cfg?.siteUrl ?? inventory?.siteUrl ?? 'https://bona-real-estate.com';
  const publicApi = deps.publicApi ?? cfg?.publicApi ?? 'https://api.bona-real-estate.com';

  const enabled = () => configured && team?.calendarBookingEnabled?.() === true;
  const leadOf = (o) => (o?.lead && typeof o.lead === 'object' ? o.lead : (db && o?.leadId ? db.getLead(o.leadId) : null));
  /** Why this lead cannot book at all right now, or null. */
  function gate(lead) {
    if (!enabled()) return 'off';
    if (!lead?.lead_id) return 'lead';
    if (ownerTest?.autoMode?.(lead) !== true) return 'not_auto';
    return null;
  }

  function listingFor(id) {
    const want = String(id ?? '').trim().toUpperCase();
    if (!want || typeof inventory?.all !== 'function') return null;
    const all = inventory.all();
    return Array.isArray(all) ? all.find((l) => String(l?.id ?? '').toUpperCase() === want) ?? null : null;
  }
  const bookableListing = (l) => Boolean(l?.slug) && l.status === 'available' && l.location?.city?.en === BOOKABLE_CITY;

  const prep = (sql) => db.db.prepare(sql);
  const activeBooking = (leadId, t) => Boolean(prep("SELECT 1 FROM viewing_bookings WHERE lead_id = ? AND status = 'booked' AND end_ts >= ? LIMIT 1").get(String(leadId), t));
  const slotTaken = (startTs) => Boolean(prep("SELECT 1 FROM viewing_bookings WHERE start_ts = ? AND status = 'booked' LIMIT 1").get(startTs));
  const bookedToday = (t) => prep('SELECT COUNT(*) n FROM viewing_bookings WHERE created >= ?').get(dayStart(riyadhDay(t))).n;
  const flipDone = (t) => prep("UPDATE viewing_bookings SET status = 'done', updated = ? WHERE status = 'booked' AND end_ts < ?").run(t, t).changes;

  /** What slots() checks before it asks Google. */
  function precheck(lead, listingId, t) {
    const g = gate(lead);
    if (g) return g;
    if (!bookableListing(listingFor(listingId))) return 'listing';
    if (activeBooking(lead.lead_id, t)) return 'active_booking';
    if (bookedToday(t) >= DAY_CAP) return 'day_cap';
    return null;
  }

  function validate(o = {}) {
    if (!enabled()) return { ok: false, reason: 'off' };
    const t = now();
    const lead = leadOf(o);
    const g = gate(lead);
    if (g) return { ok: false, reason: g };
    const listing = listingFor(o.listingId);
    if (!bookableListing(listing)) return { ok: false, reason: 'listing' };
    const startTs = parseSlotId(o.slotId);
    if (startTs === null) return { ok: false, reason: 'slot' };
    const why = checkSlot(startTs, { now: t, holidays: gcal.cachedHolidays?.() ?? null });
    if (why) return { ok: false, reason: why };
    if (activeBooking(lead.lead_id, t)) return { ok: false, reason: 'active_booking' };
    if (slotTaken(startTs)) return { ok: false, reason: 'busy' };
    if (bookedToday(t) >= DAY_CAP) return { ok: false, reason: 'day_cap' };
    const name = plausibleName(o.name) ? String(o.name).trim() : (plausibleName(lead.name) ? lead.name.trim() : null);
    if (!name) return { ok: false, reason: 'need_name', needName: true };
    return { ok: true, leadId: lead.lead_id, listingId: listing.id, slotId: toSlotId(startTs), startTs, endTs: startTs + VIEWING_MS, name };
  }

  async function slots(o = {}) {
    if (!enabled()) return { bookable: false };
    const t = now();
    const why = precheck(leadOf(o), o.listingId, t);
    if (why) return { bookable: false, reason: why };
    const hol = await gcal.holidays();
    if (!hol.ok) return { bookable: false, reason: 'calendar', code: hol.code };
    const days = bookableDays(t, { holidays: hol.dates });
    const window = searchWindow(days);
    if (!window) return { bookable: false, reason: 'none_free', timezone: TIMEZONE, slots: [] };
    const fb = await gcal.freeBusy(window);
    if (!fb.ok) return { bookable: false, reason: 'calendar', code: fb.code };
    // Our own booked rows count as busy too, even before Google shows their event.
    const own = prep("SELECT start_ts, end_ts FROM viewing_bookings WHERE status = 'booked' AND end_ts >= ?").all(t)
      .map((r) => ({ start: r.start_ts, end: r.end_ts }));
    const list = freeSlots({ now: t, busy: [...fb.busy, ...own], holidays: hol.dates, days });
    if (!list.length) return { bookable: false, reason: 'none_free', timezone: TIMEZONE, slots: [] };
    return { bookable: true, timezone: TIMEZONE, slots: list };
  }

  // One booking at a time in this process (DESIGN §8.3 step 2); the partial unique indexes guard the rest.
  let chain = Promise.resolve();
  const locked = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  /** Step 3: done for what is over, then the `booked` row, in one write transaction. */
  function reserve(v, t) {
    return db.transaction(() => {
      flipDone(t);
      // Google keeps a deleted event's id, so a lead booking the same start again needs a new one.
      const attempt = prep('SELECT COUNT(*) n FROM viewing_bookings WHERE lead_id = ? AND start_ts = ?').get(v.leadId, v.startTs).n;
      const bookingId = newId('bk');
      const eventId = eventIdFor(v.leadId, v.startTs, attempt);
      prep(`INSERT INTO viewing_bookings (booking_id, lead_id, task_id, listing_id, start_ts, end_ts, event_id, status, client_told, created, updated)
            VALUES (?, ?, NULL, ?, ?, ?, ?, 'booked', 0, ?, ?)`).run(bookingId, v.leadId, v.listingId, v.startTs, v.endTs, eventId, t, t);
      return { bookingId, eventId };
    }, { immediate: true });
  }
  const dropRow = (bookingId) => prep('DELETE FROM viewing_bookings WHERE booking_id = ?').run(bookingId);
  const markPending = (bookingId) => prep("UPDATE viewing_bookings SET status = 'cancel_pending', updated = ? WHERE booking_id = ? AND status IN ('booked','done')").run(now(), bookingId);

  async function commit(o) {
    const v = validate(o);
    if (!v.ok) return v;
    const lead = db.getLead(v.leadId);
    const listing = listingFor(v.listingId);
    const t = now();
    let row;
    try {
      row = reserve(v, t);
    } catch (err) {
      const msg = String(err?.message ?? '');
      if (/viewing_bookings\.lead_id/.test(msg)) return { ok: false, reason: 'active_booking' };
      if (/viewing_bookings\.start_ts/.test(msg)) return { ok: false, reason: 'busy' };
      log({ level: 'error', evt: 'viewing.reserve_failed', leadId: v.leadId, error: errClass(err) });
      return { ok: false, reason: 'error' };
    }
    const failed = (reason, code) => {
      log({ level: 'warn', evt: 'viewing.commit_failed', bookingId: row.bookingId, reason, ...(code ? { code } : {}) });
      return code ? { ok: false, reason, code } : { ok: false, reason };
    };
    // Step 4: the calendar again, for this one slot (and the holiday feed, which freeBusy does not cover).
    const hol = await gcal.holidays();
    if (!hol.ok) { dropRow(row.bookingId); return failed('calendar', hol.code); }
    if (hol.dates.has(riyadhDay(v.startTs))) { dropRow(row.bookingId); return failed('holiday'); }
    const w = slotWindow(v.startTs);
    const fb = await gcal.freeBusy({ timeMin: isoRiyadh(w.start), timeMax: isoRiyadh(w.end) });
    if (!fb.ok) { dropRow(row.bookingId); return failed('calendar', fb.code); }
    if (!isFree(v.startTs, fb.busy)) { dropRow(row.bookingId); return failed('busy'); }
    // Step 6: the event.
    const event = bookingEvent({
      eventId: row.eventId, leadId: v.leadId, bookingId: row.bookingId, listingId: listing.id,
      title: listing.title?.en || listing.id, homeUrl: homeUrl(siteUrl, listing, 'en'), leadUrl: leadLink(publicApi, v.leadId),
      name: v.name, phone: lead?.phone_e164 ? `+${lead.phone_e164}` : null, startTs: v.startTs, endTs: v.endTs,
    });
    const ins = await gcal.insert(event);
    if (!ins.ok) {
      // A call that may have gone through leaves the row to the worker, which deletes any event (404 = none).
      if (ins.uncertain) markPending(row.bookingId); else dropRow(row.bookingId);
      return failed('insert_failed', ins.code);
    }
    // Step 7: the task. A purge or a cancel may have marked the row while Google answered: then the
    // row is the worker's (it deletes the event), and the booking did not happen.
    try {
      const kept = db.transaction(() => {
        const current = prep('SELECT status FROM viewing_bookings WHERE booking_id = ?').get(row.bookingId);
        if (current?.status !== 'booked') return false;
        if (!plausibleName(lead?.name) && plausibleName(o.name)) saveNeeds(db, { leadId: v.leadId, needs: { name: o.name }, now: t });
        const task = bookViewing(db, { leadId: v.leadId, bookingId: row.bookingId, listingId: listing.id, slotStart: v.slotId, dueTs: v.startTs, now: t });
        prep('UPDATE viewing_bookings SET task_id = ?, updated = ? WHERE booking_id = ?').run(task.task_id, t, row.bookingId);
        return true;
      });
      if (!kept) return failed('cancelled');
    } catch (err) {
      markPending(row.bookingId);
      log({ level: 'error', evt: 'viewing.task_failed', bookingId: row.bookingId, error: errClass(err) });
      return { ok: false, reason: 'task_failed' };
    }
    log({ evt: 'viewing.booked', bookingId: row.bookingId, leadId: v.leadId });
    return {
      ok: true, bookingId: row.bookingId, eventId: row.eventId, listingId: listing.id, slotId: v.slotId, startTs: v.startTs,
      endTs: v.endTs, pin: pinOf(listing), text: confirmationText({ listing, startTs: v.startTs, language: o.language === 'en' ? 'en' : 'ar', siteUrl }),
    };
  }

  async function commitBooking(o = {}) {
    if (!enabled()) return { ok: false, reason: 'off' };
    return locked(async () => {
      try {
        return await commit(o);
      } catch (err) {
        log({ level: 'error', evt: 'viewing.commit_error', error: errClass(err) });
        return { ok: false, reason: 'error' };
      }
    });
  }

  function markTold(bookingId) {
    if (!db) return false;
    return prep('UPDATE viewing_bookings SET client_told = 1, updated = ? WHERE booking_id = ?').run(now(), String(bookingId ?? '')).changes === 1;
  }

  /** A lead's rows in `statuses` → cancel_pending; a booked row's open task is cancelled with it. Rows only, no network. */
  function markLead(leadId, statuses) {
    if (!db) return 0;
    const id = String(leadId ?? '');
    return db.transaction(() => {
      const t = now();
      const rows = prep(`SELECT booking_id, task_id, status FROM viewing_bookings WHERE lead_id = ? AND status IN (${statuses.map(() => '?').join(',')})`).all(id, ...statuses);
      for (const r of rows) {
        prep("UPDATE viewing_bookings SET status = 'cancel_pending', updated = ? WHERE booking_id = ?").run(t, r.booking_id);
        if (r.status === 'booked' && r.task_id) cancelBookedViewing(db, { taskId: r.task_id, bookingId: r.booking_id, now: t });
      }
      return rows.length;
    });
  }
  /** The lead's `booked` rows (a purge, the test switch going off). */
  const cancelForLead = (leadId) => markLead(leadId, ['booked']);
  /** Every row of the lead that has an event, `booked` or `done` (the lead is leaving; DESIGN §8.4, critic round 2 #27). */
  const deleteForLead = (leadId) => markLead(leadId, ['booked', 'done']);

  /** A viewing task the owner set to cancelled: its booking goes too (only a cancel; a move is refused by updateTask). */
  function onTaskChange(task, patch) {
    if (!db || !task || typeof task !== 'object' || task.kind !== 'viewing') return;
    if ((patch?.status ?? task.status) !== 'cancelled') return;
    const bookingId = task.details?.booking_id;
    const t = now();
    if (bookingId) prep("UPDATE viewing_bookings SET status = 'cancel_pending', updated = ? WHERE booking_id = ? AND status = 'booked'").run(t, String(bookingId));
    else prep("UPDATE viewing_bookings SET status = 'cancel_pending', updated = ? WHERE task_id = ? AND status = 'booked'").run(t, String(task.task_id ?? ''));
  }

  // Plain synchronous functions (routes.mjs refuses anything else for onLeadLeaving); a throw stops the step.
  function onLeadLeaving(leadId) { deleteForLead(leadId); }
  function onPurge(leadId) { cancelForLead(leadId); }

  /** The worker: past → done, then the cancellations, oldest first; a failure waits for the next run. */
  async function work() {
    const t = now();
    const out = { done: flipDone(t), cancelled: 0, failed: 0 };
    const pending = prep("SELECT booking_id, event_id FROM viewing_bookings WHERE status = 'cancel_pending' ORDER BY updated, booking_id LIMIT ?").all(WORKER_BATCH);
    for (const r of pending) {
      const res = await gcal.delete(r.event_id);
      if (res.ok) {
        out.cancelled += prep("UPDATE viewing_bookings SET status = 'cancelled', updated = ? WHERE booking_id = ? AND status = 'cancel_pending'").run(now(), r.booking_id).changes;
        continue;
      }
      out.failed += 1;
      // To the back of the queue, so one event that keeps failing never blocks the others.
      prep("UPDATE viewing_bookings SET updated = ? WHERE booking_id = ? AND status = 'cancel_pending'").run(now(), r.booking_id);
      log({ level: 'warn', evt: 'viewing.cancel_retry', bookingId: r.booking_id, code: res.code });
      if (CALENDAR_DOWN.has(res.code)) break;
    }
    // Keep the holiday copy warm (one call per 12 h): validate() reads it without waiting.
    await gcal.holidays();
    return out;
  }
  let running = null;
  function tick() {
    if (!configured) return undefined;
    if (running) return running;
    running = (async () => {
      try {
        return await work();
      } catch (err) {
        log({ level: 'error', evt: 'viewing.tick_failed', error: errClass(err) });
        return null;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  const eventTime = (part) => (part?.dateTime ? Date.parse(part.dateTime) : (part?.date ? dayStart(part.date) : NaN));

  /** The calendar is the source of truth: a moved event moves the booking and its task; a deleted one cancels them. */
  async function reconcile() {
    const out = { checked: 0, moved: 0, cancelled: 0 };
    if (!configured) return out;
    const t = now();
    flipDone(t);
    const rows = prep("SELECT * FROM viewing_bookings WHERE status = 'booked' AND end_ts >= ? ORDER BY start_ts, booking_id LIMIT ?").all(t, RECONCILE_BATCH);
    for (const r of rows) {
      out.checked += 1;
      const got = await gcal.get(r.event_id);
      if (got.ok ? got.event?.status === 'cancelled' : got.gone === true) {
        db.transaction(() => {
          const n = prep("UPDATE viewing_bookings SET status = 'cancelled', updated = ? WHERE booking_id = ? AND status = 'booked'").run(now(), r.booking_id).changes;
          if (n && r.task_id) cancelBookedViewing(db, { taskId: r.task_id, bookingId: r.booking_id, now: now() });
          out.cancelled += n;
        });
        continue;
      }
      if (!got.ok) {
        log({ level: 'warn', evt: 'viewing.reconcile_failed', bookingId: r.booking_id, code: got.code });
        if (CALENDAR_DOWN.has(got.code)) break;
        continue;
      }
      const start = eventTime(got.event.start);
      const end = eventTime(got.event.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || (start === r.start_ts && end === r.end_ts)) continue;
      try {
        db.transaction(() => {
          prep("UPDATE viewing_bookings SET start_ts = ?, end_ts = ?, status = ?, updated = ? WHERE booking_id = ? AND status = 'booked'")
            .run(start, end, end < t ? 'done' : 'booked', now(), r.booking_id);
          if (r.task_id) moveBookedViewing(db, { taskId: r.task_id, bookingId: r.booking_id, dueTs: start, now: now() });
        });
        out.moved += 1;
      } catch (err) {
        // Moved onto another booking's start: the unique index refuses it; the owner sees both in the calendar.
        log({ level: 'warn', evt: 'viewing.reconcile_conflict', bookingId: r.booking_id, error: errClass(err) });
      }
    }
    log({ evt: 'viewing.reconciled', ...out });
    return out;
  }

  function health() {
    if (!configured) return { enabled: false, gcal: { ...NOT_CONFIGURED } };
    const g = gcal.health?.() ?? {};
    return { enabled: enabled(), gcal: { configured: true, ok: g.ok === true, lastErrorCode: g.lastErrorCode ?? null } };
  }

  return {
    configured,
    slots,
    validate,
    commitBooking,
    markTold,
    cancelForLead,
    deleteForLead,
    onTaskChange,
    onLeadLeaving,
    onPurge,
    tick,
    reconcile,
    health,
  };
}
