/**
 * Viewing bookings on the owner's calendar (DESIGN §8; PR-B1, task T10). It replaces PR-F2b's stub
 * behind the same seam, and adds deleteForLead, markTold and reconcile.
 *
 * Booking needs three things at once (DESIGN §2): `calendar_booking` = '1', auto mode for the lead
 * (ownerTest.autoMode), and a calendar (BONA_GCAL_SA_FILE and BONA_GCAL_CALENDAR_ID). Without them
 * nothing is bookable and nothing is booked, exactly as the stub answered. A bookable home is a
 * listing in listings.json, by its exact id, `available`, in Jeddah. Only a chat Dana may answer
 * books: in the inbox, and no colleague's or never-list number (as dana-wa eligible()). The lead is
 * always read from the database, never from the caller's copy: a Not a client while a commit waited
 * (on the lock, or on Google) leaves no row to mark, and only that read stops the booking.
 *
 * Who calls what (the callers arrive with later PRs; index.mjs already wires the hooks):
 *   - the tools (PR-B4): slots() for viewing_slots, validate() for book_viewing (writes nothing);
 *   - dana-commit (PR-B4), after preSend: commitBooking(), then markTold() once the confirmation
 *     was accepted, then the booking note;
 *   - the dashboard (routes.mjs hooks): onTaskChange (a booked task set to cancelled) and
 *     onLeadLeaving (Not a client, a new colleague's or never-list number → deleteForLead);
 *   - the inbox store's `onPurge` (purgeLead: leaving the inbox, the retention purge, the test
 *     switch going off) → cancelForLead;
 *   - the timers (PR-INT): tick() every 5 min (rows a restart left untold, bookings over by their
 *     stored times, cancellations, the holiday copy) and reconcile() at 05:00 and before the summary.
 *
 * Google Calendar is the source of truth for viewing times and busy time (DESIGN §8.4). A row's
 * start_ts/end_ts are a copy of its event's times, from the booking or the last read: the owner may
 * move the event at any time. So:
 *   - a row is `done` only when a read of its event shows its real end is past (settle(): the worker,
 *     slots and every commit for the lead); a 404 or a failed read never makes it done;
 *   - a booking whose event is in Google (it has a task) adds no busy time of its own: freeBusy
 *     shows it where it is now. Only a hold (a commit between its reserve and its task) is local
 *     busy time, and, for one slots() lookup, a booking whose task landed, or whose insert went uncertain,
 *     while its freeBusy was on its way (that answer may predate the event); one booking per lead goes by the row's status, not by its stored times;
 *   - the reads of a run are applied in one transaction (apply()), so swaps resolve. A commit reads the
 *     lead's bookings over by their stored times and the chain of bookings from its start, then applies
 *     those reads, checks again and reserves in ONE transaction (commit()).
 *
 * The hooks and the purge only write rows, synchronously, inside the caller's transaction; they
 * never call Google (DESIGN §8.4). Google is called from slots, commitBooking, tick and reconcile.
 * A commit sends the event (the client's name and phone) only if its row is still `booked`, the
 * lead may still book and the slot is still from tomorrow by the clock then, read right before the
 * request: a purge, or Riyadh midnight, while Google answered sends nothing. slots() reads the clock again
 * once Google answered too: it offers only the days its freeBusy query covered, from tomorrow by the clock then.
 * Logs carry booking ids, lead ids and codes only: never a name, a phone, a calendar id or text.
 *
 * Each event id records the calendar it was made in (gcal calendarTag). A 404 from another calendar
 * id (a restart on the wrong BONA_GCAL_CALENDAR_ID, even one the robot can write to) never cancels a
 * row or finishes a deletion: the row waits, and health says not_found until the right calendar is
 * back. While any booking or queued deletion was made in another calendar, nothing is offered or
 * booked either (reason 'calendar_mismatch'): that calendar's busy time is not the owner's, and a
 * client's name and phone never go to it. In the calendar an event was made in, a 404 after the access
 * probe passed is the owner deleting it, wherever it is read (deletedHere()): reconcile cancels the row
 * and its task, and so do settle() (the worker, slots) and a commit for the rows it reads (before their
 * moves, so a start the deleted booking kept is free at once). Such a row is never flagged missing, so
 * validate(), which reads nothing, sees no booking either. Ids written before carry no calendar and keep
 * the earlier rule (a 404 counts only when a reconcile run found other events; settle() and a commit
 * never read it as a deletion, and the row stays the lead's booking, flagged missing).
 *
 * For PR-INT (index.mjs): pass `inventory` (the shared one; without it no listing is bookable),
 * and `fetchImpl` for the tests' fake fetch.
 */
import { newId } from './db.mjs';
import { bookingEvent, calendarTagOf, createGcal, eventIdFor } from './gcal.mjs';
import { propertyPath } from './inventory.mjs';
import { isExcludedLead } from './team.mjs';
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
/**
 * A `booked` row with no task that no commit in this process holds, and older than this, was left by
 * a process that stopped between the reserve and the task (a restart). A commit takes at most a
 * few 5 s calls; the margin also covers a commit in another process over the same database.
 */
export const STRANDED_MS = 2 * 60_000;
/**
 * How long an insert that went uncertain may still land in Google after its call timed out: until then a 404 for
 * that booking's event is no proof it is gone, and the worker tries the deletion again (Codex r16).
 */
export const INSERT_LAND_MS = 10 * 60_000;

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
 *   (no reason when booking is off, as the stub answered; 'calendar_mismatch' while a booking or a queued deletion
 *   was made in another calendar than the one configured)
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
 * @property {() => Promise<{ checked: number, moved: number, cancelled: number, held: number }>} reconcile
 *   `held` counts the 404s left alone because the run found none of its events in the calendar (ids that record
 *   no calendar, or another one); a 404 of an event this calendar made is a deletion, never held
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
  /** The lead as the database has it now, by the caller's lead or id: a caller's copy may predate a Not a client. */
  const leadOf = (o) => {
    const id = o?.lead && typeof o.lead === 'object' ? o.lead.lead_id : o?.leadId;
    return db && id ? db.getLead(String(id)) ?? null : null;
  };
  /** A colleague's or never-list chat the daily sweep has not taken out yet (lib/team.mjs, the inbox's one exclusion test). */
  const excluded = (lead) => typeof team?.isExcludedPhone === 'function' && isExcludedLead(team, db, lead);
  /** Why this lead cannot book at all right now, or null. */
  function gate(lead) {
    if (!enabled()) return 'off';
    if (!lead?.lead_id) return 'lead';
    // Only a chat Dana may answer (dana-wa eligible()): auto mode alone stays true for an own-number lead after Not a client.
    if (lead.inbox_state !== 'in' || excluded(lead)) return 'not_in_inbox';
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
  /** The event was made in another calendar than the one configured now (its id says so; an id written before says nothing). */
  const madeElsewhere = (eventId) => {
    const tag = calendarTagOf(eventId);
    return tag !== null && tag !== (gcal?.calendarTag ?? null);
  };
  /** The event was made in the calendar configured now (its id says so). */
  const madeHere = (eventId) => calendarTagOf(eventId) !== null && !madeElsewhere(eventId);
  /**
   * The 404s of a read (readEvents(), readForCommit()) that are the owner deleting the event: read after the
   * run's access probe passed, for an event made in the calendar configured now. One rule for reconcile,
   * settle() and a commit. Their rows are cancelled by the caller's apply()/follow(); none stays flagged
   * missing (validate() reads that flag), so if that write does not land the next read cancels them.
   */
  const deletedHere = (res) => {
    const judged = res.probed ? res.gone.filter((r) => madeHere(r.event_id)) : [];
    for (const r of judged) missing.delete(r.booking_id);
    return judged;
  };
  /**
   * A booking or a queued deletion whose event was made in another calendar than the one configured now
   * (a restart on another BONA_GCAL_CALENDAR_ID). Until it is resolved (the right calendar back), nothing is
   * offered or booked: this calendar's busy time is not the owner's, and the client's name and phone must
   * not land in it. Health says not_found meanwhile.
   */
  const calendarMismatch = () => prep("SELECT event_id FROM viewing_bookings WHERE status IN ('booked','cancel_pending')").all()
    .some((r) => madeElsewhere(r.event_id));
  /**
   * Booked rows over by their stored times whose event no read confirmed (a 404/410 of an id that
   * records no calendar, or an event with no times; a 404 in the calendar the id records is a
   * deletion, deletedHere(), never missing): never done on that, since the owner may have moved it
   * later in a calendar the robot no longer reads (another calendar id, say). They stay the lead's booking, health says
   * not_found, the journal has one line each, and every later read tries again. In memory: after a
   * restart the first read finds them again.
   */
  const missing = new Set();
  /**
   * The newest calendar read sent for each booking (readEvents()): a number per read, in the order the reads went
   * out. A read's result (a plan, a 404) applies only while no newer read of that booking has been sent since, in
   * either order of their answers: an older read never undoes a newer one (Codex r14, r15). In memory: a restart
   * starts no read before its first.
   */
  const readSeq = new Map();
  let readN = 0;
  /** True when `r` (a row a read was for) carries the newest read of its booking, or came from no read. */
  const newestRead = (r) => r.readSeq === undefined || readSeq.get(r.booking_id) === r.readSeq;
  /** Not a row a restart left untold (no task, older than STRANDED_MS, held by no commit here): sweepStranded() takes those. */
  const live = (r, t) => r.task_id !== null || inFlight.has(r.booking_id) || r.created >= t - STRANDED_MS;
  /**
   * The lead's one booking (DESIGN §8.4): any live `booked` row of it, by status, once the lead's rows
   * over by their stored times were read (`settled`, in slots() and commit() after settle()). Before
   * that read (validate() calls nothing), such a row counts only when its event was missing (never
   * one the owner deleted in its own calendar: deletedHere() cancels it and flags nothing): the
   * commit reads it first, and the row follows its event.
   */
  function leadBooked(leadId, t, settled = false) {
    return prep("SELECT booking_id, task_id, end_ts, created FROM viewing_bookings WHERE lead_id = ? AND status = 'booked'").all(String(leadId))
      .some((r) => live(r, t) && (settled || r.end_ts >= t || missing.has(r.booking_id)));
  }
  /**
   * Holds: rows a commit reserved whose event Google may not show yet (no task); validate() refuses
   * their start. A booking with a task has its event in Google, and freeBusy shows it where it is
   * now, moved or not: outside one slots() lookup (unseen()), its stored times never block another client.
   */
  const holds = (t) => prep("SELECT booking_id, task_id, start_ts, end_ts, created FROM viewing_bookings WHERE status = 'booked' AND task_id IS NULL").all()
    .filter((r) => live(r, t));
  /**
   * The rows whose event is in Google now: place() sets a row's task only once its insert answered, so a `booked`
   * row with a task, and a `cancel_pending` one with a task (its event stays until the worker deletes it, wherever
   * the owner moved it: Codex r13), is one freeBusy shows where it is.
   */
  const withEvent = () => new Set(prep("SELECT booking_id FROM viewing_bookings WHERE status IN ('booked','cancel_pending') AND task_id IS NOT NULL").all()
    .map((r) => r.booking_id));
  /**
   * The local busy time of one freeBusy answer (slots()): every live row whose event may be in Google but missing
   * from that answer, i.e. every live `booked` or `cancel_pending` row not in `before`, the withEvent() read right
   * before that request went out (a row with its task then is in Google, so it goes by Google even once cancelled). That is the holds now, a row that was a hold then or was reserved since whose
   * task landed while Google answered (another lead's commit), and a row whose insert went uncertain (Codex r12: its
   * event may be in the calendar until the worker deletes it). Each counts by its stored times, for that answer
   * only. A booking Google had before the request goes by Google, as everywhere else: an owner move frees its first
   * start. `cancelled` and `done` rows never count.
   */
  const unseen = (before, t) => prep("SELECT booking_id, task_id, start_ts, end_ts, created FROM viewing_bookings WHERE status IN ('booked','cancel_pending')").all()
    .filter((r) => !before.has(r.booking_id) && live(r, t));
  const bookedToday = (t) => prep('SELECT COUNT(*) n FROM viewing_bookings WHERE created >= ?').get(dayStart(riyadhDay(t))).n;

  /** What slots() checks before it asks Google (and again, `settled`, once the lead's rows were read). */
  function precheck(lead, listingId, t, settled = false) {
    const g = gate(lead);
    if (g) return g;
    if (calendarMismatch()) return 'calendar_mismatch';
    if (!bookableListing(listingFor(listingId))) return 'listing';
    if (leadBooked(lead.lead_id, t, settled)) return 'active_booking';
    if (bookedToday(t) >= DAY_CAP) return 'day_cap';
    return null;
  }

  function validate(o = {}) {
    if (!enabled()) return { ok: false, reason: 'off' };
    const t = now();
    const lead = leadOf(o);
    const g = gate(lead);
    if (g) return { ok: false, reason: g };
    // Before anything is read or sent (commit() runs this first, and again inside the reserve's transaction).
    if (calendarMismatch()) return { ok: false, reason: 'calendar_mismatch' };
    const listing = listingFor(o.listingId);
    if (!bookableListing(listing)) return { ok: false, reason: 'listing' };
    const startTs = parseSlotId(o.slotId);
    if (startTs === null) return { ok: false, reason: 'slot' };
    const why = checkSlot(startTs, { now: t, holidays: gcal.cachedHolidays?.() ?? null });
    if (why) return { ok: false, reason: why };
    if (leadBooked(lead.lead_id, t)) return { ok: false, reason: 'active_booking' };
    // Another commit's hold on this start. A booking Google shows is the live check's (commit()).
    if (holds(t).some((r) => r.start_ts === startTs)) return { ok: false, reason: 'busy' };
    if (bookedToday(t) >= DAY_CAP) return { ok: false, reason: 'day_cap' };
    const name = plausibleName(o.name) ? String(o.name).trim() : (plausibleName(lead.name) ? lead.name.trim() : null);
    if (!name) return { ok: false, reason: 'need_name', needName: true };
    return { ok: true, leadId: lead.lead_id, listingId: listing.id, slotId: toSlotId(startTs), startTs, endTs: startTs + VIEWING_MS, name };
  }

  async function slots(o = {}) {
    if (!enabled()) return { bookable: false };
    // A row a restart left untold is no booking and no busy time (as in commit()).
    sweepStranded(now());
    // The whole gate (precheck(): booking on, the lead as the database has it now, in the inbox and not excluded,
    // auto mode, no calendar mismatch, the listing, one booking per lead, the day cap), by the clock now. It runs
    // before the first call to Google, again after EVERY answer (booking switched off, Not a client, a mismatch or
    // a booking of the lead may land while Google answers), and once more with no await before the return, as
    // commit() checks again inside its reserve's transaction: what slots offers, validate() and a commit accept.
    // `settled` once settle() read the lead's rows over by their stored times (leadBooked()).
    let settled = false;
    const gated = () => {
      const why = precheck(leadOf(o), o.listingId, now(), settled);
      return why ? { bookable: false, reason: why } : null;
    };
    let stop = gated();
    if (stop) return stop;
    // The lead's booking that is over by its stored times: is it really (settle())?
    const s = await settle(now(), leadOf(o).lead_id);
    settled = !s.code;
    if ((stop = gated())) return stop;
    if (s.code) return { bookable: false, reason: 'calendar', code: s.code };
    const hol = await gcal.holidays();
    if ((stop = gated())) return stop;
    if (!hol.ok) return { bookable: false, reason: 'calendar', code: hol.code };
    // The days to ask Google about, by the clock once the holidays answered (Riyadh midnight may have passed).
    const days = bookableDays(now(), { holidays: hol.dates });
    const window = searchWindow(days);
    if (!window) return { bookable: false, reason: 'none_free', timezone: TIMEZONE, slots: [] };
    // The bookings Google has as this request goes out (withEvent()): its answer shows them where they are now.
    const inGoogle = withEvent();
    const fb = await gcal.freeBusy(window);
    if ((stop = gated())) return stop;
    if (!fb.ok) return { bookable: false, reason: 'calendar', code: fb.code };
    // The clock again once freeBusy answered: a day that turned today meanwhile is not offered (a commit would
    // answer too_soon). Only the days just queried are: a later day's busy time was never read.
    const tn = now();
    // Google's busy time, plus every booking its answer may not show (unseen()): the holds now, another lead's
    // booking reserved, or still a hold, when the request went out, whose task landed while Google answered, and an
    // insert that went uncertain meanwhile, whose event may stay until the worker deletes it.
    const own = unseen(inGoogle, tn).map((r) => ({ start: r.start_ts, end: r.end_ts }));
    const list = freeSlots({ now: tn, busy: [...fb.busy, ...own], holidays: hol.dates, days });
    if (!list.length) return { bookable: false, reason: 'none_free', timezone: TIMEZONE, slots: [] };
    // The last check, nothing awaited since: no slot leaves here unless the gate passes now.
    if ((stop = gated())) return stop;
    return { bookable: true, timezone: TIMEZONE, slots: list };
  }

  // One booking at a time in this process (DESIGN §8.3 step 2); the partial unique indexes guard the rest.
  // A row whose insert has not answered yet is the commit's alone: the worker and reconcile skip it,
  // or a purge in that window would let them finish the row (a 404, since the event does not exist
  // yet) and leave the event that lands afterwards behind with no row to delete it.
  const inFlight = new Set();
  let chain = Promise.resolve();
  const locked = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  /**
   * Step 3: the `booked` row. It runs inside commit()'s write transaction, after the rows the commit
   * read followed their events there: the lead's own booking that is over turns done in that same
   * transaction (PLAN T10), from its event, never by a blind "end_ts < now → done" (that would end a
   * viewing the owner moved later, or a row a restart left untold; DESIGN §8.4). An insert the
   * unique indexes refuse rolls all of it back.
   */
  function reserve(v, t) {
    return db.transaction(() => {
      // Google keeps a deleted event's id, and a booking the owner moved keeps the id of its first
      // start: a lead booking that start again takes the first id no row holds yet. (Every event id
      // the robot ever sent has a row: dropRow only removes a row whose insert never went out or
      // was refused.)
      const taken = prep('SELECT 1 FROM viewing_bookings WHERE event_id = ?');
      const tag = gcal.calendarTag ?? null;
      let eventId = eventIdFor(v.leadId, v.startTs, 0, tag);
      for (let attempt = 1; taken.get(eventId); attempt += 1) eventId = eventIdFor(v.leadId, v.startTs, attempt, tag);
      const bookingId = newId('bk');
      prep(`INSERT INTO viewing_bookings (booking_id, lead_id, task_id, listing_id, start_ts, end_ts, event_id, status, client_told, created, updated)
            VALUES (?, ?, NULL, ?, ?, ?, ?, 'booked', 0, ?, ?)`).run(bookingId, v.leadId, v.listingId, v.startTs, v.endTs, eventId, t, t);
      return { bookingId, eventId };
    }, { immediate: true });
  }
  const dropRow = (bookingId) => prep('DELETE FROM viewing_bookings WHERE booking_id = ?').run(bookingId);
  const markPending = (bookingId) => prep("UPDATE viewing_bookings SET status = 'cancel_pending', updated = ? WHERE booking_id = ? AND status IN ('booked','done')").run(now(), bookingId);

  /**
   * A restart between the reserve (step 3) and the task (step 7) leaves a row with no task: its
   * insert may have landed, and the client was never told. Such a row → cancel_pending, so the
   * worker deletes any event (404 = none) and the lead and the start are free again. It runs first
   * in every commit, worker run and reconcile, so no commit counts it, and settle() and reconcile
   * never read a row with no task (nor turn one done). A row this process's own commit holds is never
   * touched; every other commit sets its task, drops its row or marks it before it lets go (place()).
   * slots() runs it too; validate() writes nothing, and reads such a row as the sweep will (live()).
   */
  function sweepStranded(t) {
    // `done` too: nothing here turns a row with no task done any more, but an older build's flip did.
    const rows = prep("SELECT booking_id FROM viewing_bookings WHERE status IN ('booked','done') AND task_id IS NULL AND created < ? ORDER BY created, booking_id")
      .all(t - STRANDED_MS).filter((r) => !inFlight.has(r.booking_id));
    if (!rows.length) return 0;
    const marked = db.transaction(() => rows.filter((r) => prep("UPDATE viewing_bookings SET status = 'cancel_pending', updated = ? WHERE booking_id = ? AND status IN ('booked','done') AND task_id IS NULL")
      .run(t, r.booking_id).changes === 1));
    for (const r of marked) log({ level: 'warn', evt: 'viewing.stranded', bookingId: r.booking_id });
    return marked.length;
  }

  async function commit(o) {
    // Before anything counts: a row a restart left untold is no booking, and never turns done.
    sweepStranded(now());
    const pre = validate(o);
    if (!pre.ok) return pre;
    // The reads first, no write yet (readForCommit()): the lead's booking that is over by its stored times
    // (its event says whether it is: moved later = still to come), and the chain of bookings from this start,
    // which the owner may have moved away in Google. A start Google shows free stays refused by the unique
    // start index until every row along that chain followed its event.
    const t0 = now();
    const res = await readForCommit(pre.leadId, pre.startTs, t0);
    // A 404 read after the run's access probe passed, for an event made in this calendar, is the owner
    // deleting it (reconcile's rule): follow() cancels that row before the moves, so a start it kept is
    // free for the row the owner moved onto it. An id that records no calendar keeps its row until reconcile.
    const judged = deletedHere(res);
    unconfirmed([...res.gone.filter((r) => !judged.includes(r)), ...res.unread], t0);
    if (res.code) {
      apply(res.plans, judged);
      return { ok: false, reason: 'calendar', code: res.code };
    }
    // Then ONE write transaction: the rows follow their events (the lead's past booking turns done), the
    // checks run again on what they now say, and the row is reserved. A reserve the indexes refuse rolls
    // all of it back ('busy': another booking is still at this start); a check that refuses keeps what
    // the reads found. The checks read the lead from the database by its id, never the caller's copy: a
    // Not a client while the reads were on their way (or while this commit waited on the lock) left no
    // row to mark, and the lead's row is what says it left.
    const t = now();
    const again = { ...o, lead: null, leadId: pre.leadId };
    let step = 'follow';
    let made;
    try {
      made = db.transaction(() => {
        const { stuck } = follow(res.plans, judged);
        step = 'check';
        const v = validate(again);
        if (!v.ok) return { v, stuck };
        // Read: any booked row of the lead left is its booking (moved later, or its event missing).
        if (leadBooked(v.leadId, now(), true)) return { v: { ok: false, reason: 'active_booking' }, stuck };
        step = 'reserve';
        return { v, stuck, row: reserve(v, t) };
      }, { immediate: true });
    } catch (err) {
      const msg = String(err?.message ?? '');
      if (step === 'reserve' && /viewing_bookings\.lead_id/.test(msg)) return { ok: false, reason: 'active_booking' };
      if (step === 'reserve' && /viewing_bookings\.start_ts/.test(msg)) return { ok: false, reason: 'busy' };
      log({ level: 'error', evt: `viewing.${step}_failed`, leadId: pre.leadId, error: errClass(err) });
      return { ok: false, reason: 'error' };
    }
    conflicts(made.stuck);
    if (!made.row) return made.v;
    const { v, row } = made;
    const lead = db.getLead(v.leadId);
    const listing = listingFor(v.listingId);
    inFlight.add(row.bookingId);
    try {
      return await place(v, o, row, lead, listing, t);
    } finally {
      inFlight.delete(row.bookingId);
    }
  }

  /** Steps 4-7 for a reserved row. Whatever it answers, the row ends dropped, `booked` with its task, or the worker's. */
  async function place(v, o, row, lead, listing, t) {
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
    // Step 6: the event, only while the row is still this booking and the lead may still book (its row read
    // again: still in the inbox, no colleague's or never-list number, auto mode). A purge, Not a client, the
    // lead gone or booking off while Google answered: the client's name and phone are never sent. And only
    // while the slot is still bookable by the clock now (checkSlot(), slots()' rule: from tomorrow, Sun-Thu,
    // the grid, not a holiday read here): a commit validated late on a Wednesday for Thursday whose calls
    // answered after Riyadh midnight would book a same-day viewing; it answers checkSlot's reason. Read here
    // with no await before the call, and again by gcal.insert right before its request (after any token
    // refresh). No event went out, so the row ends cancelled (nothing to delete).
    let why = 'cancelled';
    const sendable = () => {
      why = 'cancelled';
      if (prep('SELECT status FROM viewing_bookings WHERE booking_id = ?').get(row.bookingId)?.status !== 'booked') return false;
      if (gate(db.getLead(v.leadId)) !== null) return false;
      why = checkSlot(v.startTs, { now: now(), holidays: hol.dates });
      return why === null;
    };
    const unsent = () => {
      prep("UPDATE viewing_bookings SET status = 'cancelled', updated = ? WHERE booking_id = ? AND status IN ('booked','cancel_pending')").run(now(), row.bookingId);
      return failed(why ?? 'cancelled');
    };
    if (!sendable()) return unsent();
    const current = db.getLead(v.leadId);
    const event = bookingEvent({
      eventId: row.eventId, leadId: v.leadId, bookingId: row.bookingId, listingId: listing.id,
      title: listing.title?.en || listing.id, homeUrl: homeUrl(siteUrl, listing, 'en'), leadUrl: leadLink(publicApi, v.leadId),
      name: v.name, phone: current?.phone_e164 ? `+${current.phone_e164}` : null, startTs: v.startTs, endTs: v.endTs,
    });
    const ins = await gcal.insert(event, { ready: sendable });
    if (ins.aborted) return unsent();
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

  /**
   * The worker: rows a restart left untold → cancel_pending; bookings over by their stored times →
   * their events read (settle()); then the cancellations, oldest first. A failure waits for the next run.
   */
  async function work() {
    const t = now();
    const stranded = sweepStranded(t);
    const settled = await settle(t);
    const out = { stranded, done: settled.done, moved: settled.moved, cancelled: settled.cancelled, failed: 0 };
    const pending = prep("SELECT booking_id, event_id, task_id, created FROM viewing_bookings WHERE status = 'cancel_pending' ORDER BY updated, booking_id LIMIT ?").all(WORKER_BATCH)
      .filter((r) => !inFlight.has(r.booking_id));
    // A delete answers 404 on a calendar the robot cannot see as well: that is no "already gone".
    const probe = pending.length ? await gcal.access() : null;
    if (probe && !probe.ok) {
      out.failed = pending.length;
      log({ level: 'warn', evt: 'viewing.worker_stopped', code: probe.code });
    }
    for (const r of probe?.ok ? pending : []) {
      const res = await gcal.delete(r.event_id);
      // 404 is "already gone" only in the calendar the event was made in: another calendar id (one the
      // robot can write to as well) says nothing about it, and the row waits for the right one.
      const elsewhere = res.ok && res.gone === true && madeElsewhere(r.event_id);
      // A 404 for a booking whose insert never answered ok (no task) may come before that insert lands: the row
      // waits, and the deletion is tried again, until INSERT_LAND_MS after the booking was made (Codex r16).
      const mayLand = res.ok && res.gone === true && r.task_id === null && now() - r.created < INSERT_LAND_MS;
      if (mayLand) {
        prep("UPDATE viewing_bookings SET updated = ? WHERE booking_id = ? AND status = 'cancel_pending'").run(now(), r.booking_id);
        continue;
      }
      if (res.ok && !elsewhere) {
        out.cancelled += prep("UPDATE viewing_bookings SET status = 'cancelled', updated = ? WHERE booking_id = ? AND status = 'cancel_pending'").run(now(), r.booking_id).changes;
        continue;
      }
      const code = elsewhere ? 'not_found' : res.code;
      out.failed += 1;
      // To the back of the queue, so one event that keeps failing never blocks the others.
      prep("UPDATE viewing_bookings SET updated = ? WHERE booking_id = ? AND status = 'cancel_pending'").run(now(), r.booking_id);
      log({ level: 'warn', evt: 'viewing.cancel_retry', bookingId: r.booking_id, code });
      if (CALENDAR_DOWN.has(code)) break;
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
  /** 'not_found' while the last reconcile found none of its bookings' events in the calendar (health shows it). */
  let held = null;

  /** A booked row and its open task → cancelled (the calendar cancelled it). 1 when the row changed. */
  const cancelRow = (r) => db.transaction(() => {
    const n = prep("UPDATE viewing_bookings SET status = 'cancelled', updated = ? WHERE booking_id = ? AND status = 'booked'").run(now(), r.booking_id).changes;
    if (n && r.task_id) cancelBookedViewing(db, { taskId: r.task_id, bookingId: r.booking_id, now: now() });
    return n;
  });

  /**
   * What an event makes of its booked row: `cancel` (Google's get returns a deleted event as
   * cancelled), or its real start and end, `done` only once that real end is past. null for an
   * event with no readable times: nothing is decided by the stored ones.
   */
  function planOf(event, t) {
    if (event?.status === 'cancelled') return { cancel: true };
    const start = eventTime(event?.start);
    const end = eventTime(event?.end);
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) return null;
    return { start, end, status: end < t ? 'done' : 'booked' };
  }

  /**
   * The rows read take their events' state in ONE write transaction. Cancellations go first (the
   * events deleted in Google, and the 404s the caller judged deleted): they free their starts. Then
   * the real times, and `done` where the real end is past; a moved row's task takes its new start.
   * A row that stays `booked` on a new start takes it only when no other booked row keeps that start,
   * so a swap or a rotation the owner made resolves: those rows first go to a temporary start no row
   * holds (below zero), then to their own. A move onto a start another booking keeps (or a second
   * move onto one start: the first read wins) leaves the row as it was, with a journal line (the
   * owner sees both in the calendar). Never two booked rows on one start; the unique index stays
   * the last word, and a write it refuses rolls the whole run back.
   * @returns {{ moved: number, done: number, cancelled: number }}
   */
  function apply(plans, judgedGone = []) {
    if (!plans.length && !judgedGone.length) return { moved: 0, done: 0, cancelled: 0 };
    let did;
    try {
      did = db.transaction(() => follow(plans, judgedGone), { immediate: true });
    } catch (err) {
      log({ level: 'error', evt: 'viewing.follow_failed', error: errClass(err) });
      return { moved: 0, done: 0, cancelled: 0 };
    }
    conflicts(did.stuck);
    return did.out;
  }
  const conflicts = (stuck) => { for (const id of stuck) log({ level: 'warn', evt: 'viewing.reconcile_conflict', bookingId: id }); };

  /**
   * apply()'s writes, inside the caller's transaction (apply()'s own, or a commit's with its reserve).
   * A write the unique index refuses throws, so the caller's whole transaction rolls back.
   * @returns {{ out: { moved: number, done: number, cancelled: number }, stuck: Set<string> }}
   */
  function follow(plans, judgedGone = []) {
    const out = { moved: 0, done: 0, cancelled: 0 };
    const stuck = new Set();
    const t = now();
    for (const p of plans) if (p.cancel && newestRead(p.r)) out.cancelled += cancelRow(p.r);
    for (const r of judgedGone) if (newestRead(r)) out.cancelled += cancelRow(r);
    const booked = new Map(prep("SELECT booking_id, task_id, start_ts, end_ts FROM viewing_bookings WHERE status = 'booked'").all()
      .map((x) => [x.booking_id, x]));
    // What changes, from the rows as they are now (a purge may have taken one while Google answered). A plan
    // applies only when its read is the newest sent for that booking (newestRead()) and to the row its read was
    // for, unchanged: a row whose times changed since (another path followed the owner's move) is left as it is,
    // and the next read decides. An older read never undoes a newer one (Codex r14, r15).
    const changes = [];
    for (const p of plans) {
      const cur = p.cancel ? null : booked.get(p.r.booking_id);
      if (!cur || !newestRead(p.r)) continue;
      if (cur.start_ts !== p.r.start_ts || cur.end_ts !== p.r.end_ts) continue;
      const moved = p.start !== cur.start_ts || p.end !== cur.end_ts;
      if (moved || p.status === 'done') changes.push({ ...p, cur, moved });
    }
    const leaving = new Set(changes.filter((p) => p.status === 'done').map((p) => p.r.booking_id));
    const relocating = changes.filter((p) => p.status === 'booked' && p.start !== p.cur.start_ts);
    const relocIds = new Set(relocating.map((p) => p.r.booking_id));
    // Which relocations can land: a start is kept by every booked row that neither leaves nor moves
    // off it, and by every row whose move cannot land. Each refusal can free nothing, only keep a
    // start, so this ends after at most one pass per relocating row.
    for (;;) {
      const kept = new Set();
      for (const [id, x] of booked) if (!leaving.has(id) && (!relocIds.has(id) || stuck.has(id))) kept.add(x.start_ts);
      const claimed = new Set();
      const clash = relocating.find((p) => {
        if (stuck.has(p.r.booking_id)) return false;
        if (kept.has(p.start) || claimed.has(p.start)) return true;
        claimed.add(p.start);
        return false;
      });
      if (!clash) break;
      stuck.add(clash.r.booking_id);
    }
    const set = prep("UPDATE viewing_bookings SET start_ts = ?, end_ts = ?, status = ?, updated = ? WHERE booking_id = ? AND status = 'booked'");
    const go = changes.filter((p) => !stuck.has(p.r.booking_id));
    // Off their starts first: a done row leaves the start index, a relocating one takes a temporary start.
    go.forEach((p, i) => {
      if (p.status === 'done') set.run(p.start, p.end, 'done', t, p.r.booking_id);
      else if (p.start !== p.cur.start_ts) set.run(-(i + 1), p.cur.end_ts, 'booked', t, p.r.booking_id);
    });
    for (const p of go) {
      if (p.status === 'booked') set.run(p.start, p.end, 'booked', t, p.r.booking_id);
      if (p.moved && p.cur.task_id) moveBookedViewing(db, { taskId: p.cur.task_id, bookingId: p.r.booking_id, dueTs: p.start, now: t });
      out[p.moved ? 'moved' : 'done'] += 1;
    }
    // To the back of the worker's queue, so a row that cannot follow never holds the others up.
    for (const id of stuck) prep('UPDATE viewing_bookings SET updated = ? WHERE booking_id = ?').run(t, id);
    return { out, stuck };
  }

  /**
   * Reads each row's event (no write): `plans` for the events found, `gone` for the 404s (for the
   * caller to judge, deletedHere(): a deletion or a missing event, never over), `unread` for an
   * event with no times. A calendar that cannot answer leaves the rest unread, with `code`. Rows a commit in this process
   * holds are skipped. `probe: false` only for a further read in a run whose access probe passed.
   */
  async function readEvents(op, rows, t, { probe = true } = {}) {
    const res = { checked: 0, found: 0, plans: [], gone: [], unread: [], code: null, stopped: false, probed: false };
    const todo = rows.filter((r) => !inFlight.has(r.booking_id));
    if (!todo.length) return res;
    // The reads of this run are numbered as it takes its rows, before any await (the access probe, the gets):
    // from here on an older run's result for these bookings is not applied (newestRead(), Codex r16).
    for (const r of todo) {
      r.readSeq = ++readN;
      readSeq.set(r.booking_id, r.readSeq);
    }
    // A calendar the robot cannot see any more answers 404 for every event too: no 404 is read before this.
    if (probe) {
      const p = await gcal.access();
      if (!p.ok) {
        log({ level: 'warn', evt: `viewing.${op}_stopped`, code: p.code });
        return { ...res, code: p.code, stopped: true };
      }
      res.probed = true;
    }
    for (const r of todo) {
      res.checked += 1;
      const got = await gcal.get(r.event_id);
      if (!got.ok && got.gone === true) { res.gone.push(r); continue; }
      if (!got.ok) {
        res.code = got.code;
        log({ level: 'warn', evt: `viewing.${op}_failed`, bookingId: r.booking_id, code: got.code });
        if (CALENDAR_DOWN.has(got.code)) { res.stopped = true; break; }
        continue;
      }
      res.found += 1;
      const plan = planOf(got.event, t);
      if (!plan) { res.unread.push(r); continue; }
      missing.delete(r.booking_id);
      res.plans.push({ r, ...plan });
    }
    return res;
  }

  /** Rows over by their stored times that no read confirmed: flagged for the owner (see `missing`), and to the back of the worker's queue. */
  function unconfirmed(rows, t) {
    for (const r of rows) {
      if (r.end_ts >= t) continue;
      if (prep("UPDATE viewing_bookings SET updated = ? WHERE booking_id = ? AND status = 'booked'").run(now(), r.booking_id).changes !== 1) continue;
      if (missing.has(r.booking_id)) continue;
      missing.add(r.booking_id);
      log({ level: 'warn', evt: 'viewing.event_missing', bookingId: r.booking_id });
    }
  }

  /**
   * Bookings over by their stored times (every one, or one lead's): a row is done only once a read of
   * its event shows its real end is past, since the owner may have moved it later after the last
   * reconcile. A 404 in the calendar the event was made in, after the access probe passed, is the owner
   * deleting it (deletedHere(), as reconcile and a commit read it): the row and its task are cancelled in
   * the same transaction as the other reads, so the lead can book again at once (slots(), the worker).
   * Any other 404, or a failed read, leaves it booked, so the lead keeps one booking (`code` for a
   * calendar that cannot answer; a missing event is flagged). Rows with no task are the stranded
   * sweep's, never read here.
   */
  async function settle(t, leadId = null) {
    const rows = leadId === null
      ? prep("SELECT * FROM viewing_bookings WHERE status = 'booked' AND task_id IS NOT NULL AND end_ts < ? ORDER BY updated, booking_id LIMIT ?").all(t, WORKER_BATCH)
      : prep("SELECT * FROM viewing_bookings WHERE status = 'booked' AND task_id IS NOT NULL AND end_ts < ? AND lead_id = ? ORDER BY end_ts, booking_id").all(t, String(leadId));
    const res = await readEvents('settle', rows, t);
    const judged = deletedHere(res);
    const did = apply(res.plans, judged);
    unconfirmed([...res.gone.filter((r) => !judged.includes(r)), ...res.unread], t);
    return { checked: res.checked, ...did, code: res.code };
  }

  /**
   * What a commit reads before its reserve (no write; commit() applies it with the reserve): the lead's
   * bookings over by their stored times, as settle() reads them, and the chain from the requested start.
   * That is the row stored at the start, then, when its event moved, the row stored where the event is
   * now, and so on. The owner moved 12:00 to 14:00, then 10:00 to 12:00: Google shows 10:00 free, and the
   * 10:00 row can take 12:00 only in the same transaction as the 12:00 row takes 14:00 (or is cancelled:
   * the owner deleted it, a 404 in its own calendar, commit()). One access probe for the run (`probed`
   * once it passed), at most WORKER_BATCH chain rows; a calendar that cannot answer stops it with `code`.
   */
  async function readForCommit(leadId, startTs, t) {
    const own = prep("SELECT * FROM viewing_bookings WHERE status = 'booked' AND task_id IS NOT NULL AND end_ts < ? AND lead_id = ? ORDER BY end_ts, booking_id").all(t, String(leadId));
    const seen = new Set(own.map((r) => r.booking_id));
    const storedAt = prep("SELECT * FROM viewing_bookings WHERE status = 'booked' AND task_id IS NOT NULL AND start_ts = ? ORDER BY booking_id");
    let budget = WORKER_BATCH;
    const rowsAt = (starts) => {
      const out = [];
      for (const s of starts) {
        for (const r of storedAt.all(s)) {
          if (seen.has(r.booking_id) || budget <= 0) continue;
          seen.add(r.booking_id);
          budget -= 1;
          out.push(r);
        }
      }
      return out;
    };
    const res = { plans: [], gone: [], unread: [], code: null, probed: false };
    let batch = [...own, ...rowsAt([startTs])];
    let probe = true;
    while (batch.length) {
      const got = await readEvents('settle', batch, t, { probe });
      if (got.probed) { probe = false; res.probed = true; }
      res.plans.push(...got.plans);
      res.gone.push(...got.gone);
      res.unread.push(...got.unread);
      if (got.code) { res.code = got.code; break; }
      // Where the events are now: the rows stored there follow in the same transaction.
      batch = rowsAt(got.plans.filter((p) => p.status === 'booked' && p.start !== p.r.start_ts).map((p) => p.start));
    }
    return res;
  }

  /**
   * The calendar is the source of truth: a moved event moves the booking and its task; a deleted one
   * (Google's get returns it with status 'cancelled') cancels them. A 404 means the event is not in
   * this calendar. For an event made in this calendar (its id records it) whose access probe passed,
   * that is the owner deleting it: cancelled, the only booking too, so the client can book again. Never
   * for an event made in another calendar (health says not_found). An id written before records no
   * calendar: its 404 reads as deleted only when the same run found other bookings' events there; when
   * none was found (another calendar id, say), the run is held: nothing changes, and health says
   * not_found until a reconcile finds the events again. Every booking with a task is read, over by its
   * stored times or not.
   */
  async function reconcile() {
    const out = { checked: 0, moved: 0, cancelled: 0, held: 0 };
    if (!configured) return out;
    const t = now();
    // A row a restart left untold is no booking to check: the worker deletes its event.
    sweepStranded(t);
    const rows = prep("SELECT * FROM viewing_bookings WHERE status = 'booked' AND task_id IS NOT NULL ORDER BY start_ts, booking_id LIMIT ?").all(RECONCILE_BATCH);
    if (!rows.length) {
      held = null;
      log({ evt: 'viewing.reconciled', ...out });
      return out;
    }
    const res = await readEvents('reconcile', rows, t);
    // Every time update of the run, and the 404s judged deleted, in one transaction (apply()). A 404 is read
    // only after the run's access probe passed (readEvents()). In the calendar the event was made in, it is a
    // deletion; an id that records no calendar counts only when the run found other events here. Never the
    // 404 of an event made in another calendar: this one cannot show it (health says not_found).
    const here = deletedHere(res);
    const judged = res.gone.filter((r) => here.includes(r) || (res.probed && res.found > 0 && calendarTagOf(r.event_id) === null));
    const left = res.gone.filter((r) => !judged.includes(r));
    const did = apply(res.plans, judged);
    Object.assign(out, { checked: res.checked, moved: did.moved, cancelled: did.cancelled });
    if (res.found > 0) {
      held = null;
    } else if (left.length && !res.stopped) {
      held = 'not_found';
      out.held = left.length;
      log({ level: 'warn', evt: 'viewing.reconcile_held', gone: left.length });
    } else if (judged.length && !res.stopped) {
      held = null; // the calendar answered for each of the run's events: deletions, none missing
    }
    unconfirmed([...left, ...res.unread], t);
    log({ evt: 'viewing.reconciled', ...out });
    return out;
  }

  function health() {
    if (!configured) return { enabled: false, gcal: { ...NOT_CONFIGURED } };
    const g = gcal.health?.() ?? {};
    for (const id of missing) if (!prep("SELECT 1 FROM viewing_bookings WHERE booking_id = ? AND status = 'booked'").get(id)) missing.delete(id);
    // A booking or a queued deletion whose event was made in another calendar than the one configured now.
    const elsewhere = calendarMismatch();
    // The client's own failure first; else a held reconcile, or a booking whose event is missing (the calendar
    // answers, without our events, or it is another calendar).
    const own = held ?? (missing.size || elsewhere ? 'not_found' : null);
    return { enabled: enabled(), gcal: { configured: true, ok: g.ok === true && !own, lastErrorCode: g.lastErrorCode ?? own ?? null } };
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
