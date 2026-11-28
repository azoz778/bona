/**
 * Google Calendar for viewing bookings (DESIGN §8.1, §8.3). Zero dependencies: a service account's
 * RS256 JWT signed with node:crypto, then the Calendar REST API over fetch.
 *
 * - Auth: the JWT has no `sub` (the robot acts as itself on the calendar shared with it) and both
 *   scopes, calendar.events and calendar.freebusy (freeBusy does not accept calendar.events alone).
 *   The access token is cached 55 minutes. Every call has a 5 s timeout.
 * - freeBusy fails closed: an `errors[]` entry, a 401, 403 or 404, a timeout, or an answer that is
 *   not what was asked (a calendar missing, or without a `busy` list) → `{ ok: false, code }`, so no
 *   slot is ever offered on a calendar it could not read.
 * - holidays(): the Saudi holiday feed. A day is blocked when an event's description starts with
 *   "Public holiday", or its summary is on the allow-list (Eid al-Fitr, Eid al-Adha, Arafat Day,
 *   Founding Day, National Day), "(tentative)" included. "Observance" entries (Ramadan begins, Flag
 *   Day, Muharram) do not block (verify/T00.md step 4: 9 "Public holiday", 3 "Observance"). The feed
 *   is cached 12 hours; when Google fails, the last good copy is used for up to 7 days, then it
 *   fails closed. One copy covers today and the next 60 days, so a 7-day-old copy still covers every
 *   bookable day (MAX_AHEAD_DAYS in lib/slots.mjs).
 * - insert / get / delete: events.insert with `sendUpdates=none` and a deterministic id
 *   (eventIdFor), so a retry of the same booking can be recognised: a 409 is a success only when
 *   the event there carries this lead's id. delete treats 404/410 as done. insert's `ready` is the
 *   caller's last word, asked right before the request (after any token refresh): false sends nothing.
 * - The event id records the calendar it was made in (calendarTag: a short fingerprint, never the
 *   id), so a 404 from another calendar id is never read as that event gone (calendarTagOf).
 * - access(): may the robot still manage events on the owner's calendar? A calendar that is no
 *   longer shared with it answers 404 for every event too, so the worker and reconcile ask this
 *   before they read a 404 as "already gone".
 *
 * Errors are a fixed enum (GCAL_ERROR_CODES, the /health `lastErrorCode` vocabulary), never
 * Google's words: an error text can carry a calendar id or an address. Nothing here logs a
 * calendar id, the service account's address, the key, a name or a phone: an operation and a code.
 *
 * outage() (T18a, DESIGN §14 "calendar failing over 1 h"): the calls that found the calendar NOT
 * ANSWERING since the last real success, in memory: a network error, a timeout, auth (the key or the
 * token), or a 5xx (its code is bad_response). The first and the latest such failure and the latest
 * one's code. A calendar that answers, however oddly (not_found, forbidden, quota, another 4xx, a 200
 * that is not what was asked), neither opens nor extends nor ends it; that includes an event get or
 * delete answered 404/410 and a get whose event has no usable times, which health() still reads as a
 * call that went through, as before. Only a real success ends it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TIMEZONE, dayStart, isoRiyadh, riyadhDay } from './slots.mjs';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const API = 'https://www.googleapis.com/calendar/v3';
export const SCOPES = Object.freeze(['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy']);
/** Google's public Saudi holiday calendar (not a personal id). */
export const HOLIDAY_CALENDAR = 'en.saudiarabian#holiday@group.v.calendar.google.com';
export const TOKEN_TTL_MS = 55 * 60_000;
export const TIMEOUT_MS = 5000;
export const HOLIDAY_TTL_MS = 12 * 3_600_000;
export const HOLIDAY_STALE_MS = 7 * 86_400_000;
/** How far ahead one holiday copy reaches. */
export const HOLIDAY_WINDOW_DAYS = 60;
/** The only codes a caller (and /health) ever sees. */
export const GCAL_ERROR_CODES = Object.freeze(['auth', 'forbidden', 'not_found', 'timeout', 'quota', 'network', 'bad_response']);
/** The codes that say the calendar is not answering at all (outage()); a 5xx counts too, whose code is bad_response. */
const NOT_ANSWERING = new Set(['auth', 'timeout', 'network']);
/** The holidays that block a day by their summary alone (verify/T00.md step 4). */
export const HOLIDAY_SUMMARY_RE = /\b(?:Eid al-Fitr|Eid al-Adha|Arafat Day|Founding Day|National Day)\b/i;
/** The line that ends every event description (no assistant name: brain/DESIGN-brain.md §6.3). */
export const BOOKED_BY = "Booked by Bona's AI assistant on WhatsApp";

const EVENT_ID_RE = /^[0-9a-v]{5,1024}$/;
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';
const TAG_RE = /^[0-9a-v]{8}$/;
/** An id that records its calendar: this prefix, the tag, then the 26-character hash. Ids written before are `bona` + hash. */
const TAGGED_ID_RE = /^bonc([0-9a-v]{8})[0-9a-v]{26}$/;

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/** An event part's time as lib/viewing.mjs reads it (its eventTime): a dateTime, or an all-day date. */
const eventPartTime = (part) => (part?.dateTime ? Date.parse(part.dateTime) : (part?.date ? dayStart(part.date) : NaN));
/** An event the viewing module can use (its planOf): cancelled, or readable times with the end after the start. */
function usableEvent(ev) {
  if (ev?.status === 'cancelled') return true;
  const start = eventPartTime(ev?.start);
  const end = eventPartTime(ev?.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

/** Lowercase base32hex (RFC 4648 §7) without padding: the alphabet Google takes for event ids. */
function base32hex(buf) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The calendar's fingerprint that its events' ids carry: 8 base32hex characters (40 bits) of a
 * hash of the calendar id. Never the id itself: an event id is no place for an address.
 */
export function calendarTag(calendarId) {
  return base32hex(crypto.createHash('sha256').update(`bona-calendar|${calendarId}`, 'utf8').digest().subarray(0, 5));
}

/** The calendar fingerprint an event id records, or null (an id written before ids recorded one). */
export function calendarTagOf(eventId) {
  return TAGGED_ID_RE.exec(String(eventId ?? ''))?.[1] ?? null;
}

/**
 * The event id of a booking: from the lead and the start, so the same booking always maps to the
 * same event (a retried insert answers 409, never a second event). `attempt` picks another id for
 * the same lead and start: Google keeps a deleted event's id, and an owner's move keeps the first
 * start's id on the moved booking, so a new booking takes the first attempt no row holds yet.
 * `tag` (calendarTag of the calendar the event goes to) is recorded in the id; without one, the
 * id is the earlier form, which records no calendar.
 */
export function eventIdFor(leadId, startTs, attempt = 0, tag = null) {
  if (tag != null && !TAG_RE.test(String(tag))) throw new TypeError('eventIdFor: tag must be a calendarTag');
  const seed = `${leadId}|${startTs}${attempt > 0 ? `|${attempt}` : ''}`;
  const hash = base32hex(crypto.createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16));
  return tag == null ? `bona${hash}` : `bonc${tag}${hash}`;
}

/** One line of text: no line breaks (a name cannot add a line to the description), clipped. */
const line = (v, max = 200) => String(v ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/**
 * The name the client typed, as plain words on one line. No `<` or `>`: Google renders HTML in a
 * description (no disguised link). No link either, since Google also links a bare URL, domain or
 * address there: a word with a scheme or `www.` is dropped, and `.`, `:`, `/`, `\` and `@` become spaces.
 */
const nameLine = (v) => line(String(v ?? '')
  .replace(/[<>]/g, ' ')
  .replace(/\S*(?::\/\/|\bwww[.\u3002\uFF0E\uFF61])\S*/giu, ' ')
  .replace(/[.:/\\@\u3002\uFF0E\uFF61\uFF1A\uFF0F\uFF20]/gu, ' '), 80);

/**
 * The calendar event of a booking (DESIGN §8.3 step 6). The summary carries the listing, never the
 * client: Hermes reads summaries (and locations) out in its reminders and the Secretary brief.
 * No attendees, `visibility: 'private'`, `transparency: 'opaque'`, Riyadh time, no location.
 */
export function bookingEvent({ eventId, leadId, bookingId, listingId, title, homeUrl, leadUrl, name, phone, startTs, endTs }) {
  return {
    id: eventId,
    summary: `Bona viewing · ${line(listingId, 40)}`,
    description: [
      `Client: ${nameLine(name)}${phone ? ` · ${line(phone, 20)}` : ''}`,
      `Home: ${line(title)} ${line(homeUrl, 300)}`,
      `Lead: ${line(leadUrl, 300)}`,
      BOOKED_BY,
    ].join('\n'),
    start: { dateTime: isoRiyadh(startTs), timeZone: TIMEZONE },
    end: { dateTime: isoRiyadh(endTs), timeZone: TIMEZONE },
    visibility: 'private',
    transparency: 'opaque',
    extendedProperties: { private: { bona_lead_id: String(leadId), bona_booking_id: String(bookingId), source: 'dana' } },
  };
}

/**
 * True for a holiday-feed event that blocks its day(s) (DESIGN §8.1). The feed's label (the first
 * line of the description) wins over the title: "Public holiday" blocks, "Observance" never does,
 * even under an allow-listed summary. With any other label, or none, the summary allow-list decides.
 */
export function isBlockingHoliday(event) {
  if (!event || event.status === 'cancelled') return false;
  const first = String(event.description ?? '').split('\n')[0].trim();
  if (/^public holiday\b/i.test(first)) return true;
  if (/^observance\b/i.test(first)) return false;
  return HOLIDAY_SUMMARY_RE.test(String(event.summary ?? ''));
}

/** The Riyadh dates an event covers: all-day `start.date` to the exclusive `end.date`, or the days of a timed one. */
function eventDays(event) {
  const out = [];
  const from = event.start?.date ? dayStart(event.start.date) : Date.parse(event.start?.dateTime ?? '');
  let to;
  if (event.end?.date) to = dayStart(event.end.date);
  else to = Date.parse(event.end?.dateTime ?? '');
  if (!Number.isFinite(from)) return out;
  if (!Number.isFinite(to) || to <= from) return [riyadhDay(from)];
  for (let t = dayStart(riyadhDay(from)); t < to && out.length < 31; t += 86_400_000) out.push(riyadhDay(t));
  return out;
}

/** Google's answer → one code from the enum. */
function codeForStatus(status, body) {
  if (status === 401) return 'auth';
  if (status === 403) {
    const reasons = Array.isArray(body?.error?.errors) ? body.error.errors.map((e) => String(e?.reason ?? '')) : [];
    return reasons.some((r) => /rateLimit|quota|usageLimit/i.test(r)) ? 'quota' : 'forbidden';
  }
  if (status === 404 || status === 410) return 'not_found';
  if (status === 429) return 'quota';
  return 'bad_response';
}

const codeForError = (err) => (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network');

/**
 * @param {{ saFile?: string, calendarId?: string, extraBusyIds?: string[], fetchImpl?: typeof fetch,
 *           now?: () => number, readFile?: (path: string) => string, timeoutMs?: number, log?: Function }} [o]
 *   `saFile` is the service account's key file (BONA_GCAL_SA_FILE), read when a token is minted and
 *   never logged; `calendarId` the owner's calendar (BONA_GCAL_CALENDAR_ID); `extraBusyIds` more
 *   calendars whose busy time counts (BONA_GCAL_EXTRA_BUSY_IDS). All three come from env only.
 */
export function createGcal({
  saFile = '', calendarId = '', extraBusyIds = [], fetchImpl = globalThis.fetch, now = () => Date.now(),
  readFile = (p) => fs.readFileSync(p, 'utf8'), timeoutMs = TIMEOUT_MS, log = () => {},
} = {}) {
  const configured = Boolean(saFile && calendarId);
  const extra = Array.isArray(extraBusyIds) ? extraBusyIds.map((s) => String(s).trim()).filter(Boolean) : [];
  // `outage`: { since, last, code } of the not-answering failures since the last success, or null (outage()).
  const state = { ok: false, lastErrorCode: null, outage: null };
  let token = null; // { value, until }
  let holidayCopy = null; // { dates: Set<string>, fetchedAt }

  /** A call Google answered as asked: health ok. The outage is left as it is (answered() alone) or over (succeeded()). */
  const answered = () => { state.ok = true; state.lastErrorCode = null; };
  const succeeded = () => { answered(); state.outage = null; };
  /** A failed call. `serverError`: Google answered 5xx (code bad_response), which counts as not answering. */
  function failed(op, code, extraOut = {}, serverError = false) {
    state.ok = false;
    state.lastErrorCode = code;
    if (serverError || NOT_ANSWERING.has(code)) {
      const t = now();
      state.outage = { since: state.outage?.since ?? t, last: t, code };
    }
    log({ level: 'warn', evt: 'gcal.failed', op, code });
    return fail(code, extraOut);
  }
  /** A call answered with an HTTP status that is not the one asked for (codeForStatus); a 5xx is not answering. */
  const failedStatus = (op, r, extraOut = {}) => failed(op, codeForStatus(r.status, r.body), extraOut, r.status >= 500);

  /** One HTTP call: `{ status, body }` (body parsed when it is JSON), or `{ error: code }` for a timeout or a network error. */
  async function http(method, url, { headers = {}, body } = {}) {
    try {
      const res = await fetchImpl(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let parsed = null;
      let parseOk = true;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parseOk = false; }
      }
      return { status: res.status, body: parsed, parseOk };
    } catch (err) {
      return { error: codeForError(err) };
    }
  }

  async function accessToken() {
    if (token && now() < token.until) return { ok: true, value: token.value };
    let key;
    try { key = JSON.parse(readFile(saFile)); } catch { return failed('token', 'auth'); }
    if (typeof key?.client_email !== 'string' || typeof key?.private_key !== 'string') return failed('token', 'auth');
    const iat = Math.floor(now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: key.client_email, scope: SCOPES.join(' '), aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    let signature;
    try { signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url'); } catch { return failed('token', 'auth'); }
    const r = await http('POST', TOKEN_URL, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    });
    if (r.error) return failed('token', r.error);
    if (r.status === 400 || r.status === 401 || r.status === 403) return failed('token', 'auth');
    if (r.status !== 200 || typeof r.body?.access_token !== 'string' || !r.body.access_token) return failedStatus('token', r);
    token = { value: r.body.access_token, until: now() + TOKEN_TTL_MS };
    return { ok: true, value: token.value };
  }

  /**
   * An authorised API call. A 401 drops the cached token, so the next call mints a new one.
   * `ready`, when given, is asked once the token is in hand, with no await before the request:
   * anything but true (a throw too) sends nothing and answers `{ aborted: true }`.
   */
  async function api(op, method, path, { query = null, json = undefined, ready = null } = {}) {
    if (!configured) return { error: 'auth', notConfigured: true };
    const t = await accessToken();
    if (!t.ok) return { error: t.code, reported: true };
    if (ready) {
      let go = false;
      try { go = ready() === true; } catch { go = false; }
      if (!go) return { aborted: true };
    }
    const url = new URL(`${API}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const headers = { authorization: `Bearer ${t.value}` };
    if (json !== undefined) headers['content-type'] = 'application/json';
    const r = await http(method, url.href, { headers, body: json === undefined ? undefined : JSON.stringify(json) });
    if (r.status === 401) token = null;
    return r;
  }

  const calendarPath = (id) => `/calendars/${encodeURIComponent(id)}/events`;

  /**
   * The busy blocks of the calendar and the extra ones between `timeMin` and `timeMax` (ISO).
   * @returns {Promise<{ ok: true, busy: Array<{ start: number, end: number }> } | { ok: false, code: string }>}
   */
  async function freeBusy({ timeMin, timeMax }) {
    const ids = [calendarId, ...extra];
    const r = await api('freeBusy', 'POST', '/freeBusy', { json: { timeMin, timeMax, timeZone: TIMEZONE, items: ids.map((id) => ({ id })) } });
    if (r.notConfigured) return fail('auth');
    if (r.reported) return fail(r.error);
    if (r.error) return failed('freeBusy', r.error);
    if (r.status !== 200) return failedStatus('freeBusy', r);
    const cals = r.parseOk ? r.body?.calendars : null;
    if (!cals || typeof cals !== 'object' || Array.isArray(cals)) return failed('freeBusy', 'bad_response');
    const busy = [];
    for (const id of ids) {
      const cal = Object.hasOwn(cals, id) ? cals[id] : null;
      if (!cal || typeof cal !== 'object') return failed('freeBusy', 'bad_response');
      if (cal.errors != null && (!Array.isArray(cal.errors) || cal.errors.length)) {
        return failed('freeBusy', Array.isArray(cal.errors) && cal.errors.some((e) => e?.reason === 'notFound') ? 'not_found' : 'bad_response');
      }
      // No busy list is no answer: never read as a free calendar.
      if (!Array.isArray(cal.busy)) return failed('freeBusy', 'bad_response');
      for (const b of cal.busy) {
        const start = Date.parse(b?.start ?? '');
        const end = Date.parse(b?.end ?? '');
        if (!Number.isFinite(start) || !Number.isFinite(end)) return failed('freeBusy', 'bad_response');
        busy.push({ start, end });
      }
    }
    succeeded();
    return { ok: true, busy };
  }

  /** The holiday copy if it is young enough to use (≤ 7 days), else null. For a check that cannot wait. */
  function cachedHolidays() {
    return holidayCopy && now() - holidayCopy.fetchedAt <= HOLIDAY_STALE_MS ? holidayCopy.dates : null;
  }

  /**
   * The blocked holiday dates from today for HOLIDAY_WINDOW_DAYS ('YYYY-MM-DD', Riyadh).
   * @returns {Promise<{ ok: true, dates: Set<string>, stale?: true } | { ok: false, code: string }>}
   */
  async function holidays() {
    if (!configured) return fail('auth');
    if (holidayCopy && now() - holidayCopy.fetchedAt < HOLIDAY_TTL_MS) return { ok: true, dates: holidayCopy.dates };
    const from = dayStart(riyadhDay(now()));
    const query = { timeMin: isoRiyadh(from), timeMax: isoRiyadh(from + HOLIDAY_WINDOW_DAYS * 86_400_000), singleEvents: 'true', maxResults: '250' };
    const fallback = (code) => {
      const old = cachedHolidays();
      return old ? { ok: true, dates: old, stale: true } : fail(code);
    };
    const dates = new Set();
    let pageToken = null;
    for (let page = 0; page < 5; page += 1) {
      const r = await api('holidays', 'GET', calendarPath(HOLIDAY_CALENDAR), { query: pageToken ? { ...query, pageToken } : query });
      if (r.reported) return fallback(r.error);
      if (r.error) { failed('holidays', r.error); return fallback(r.error); }
      if (r.status !== 200 || !r.parseOk || !Array.isArray(r.body?.items)) {
        // A 200 without the list is bad_response (codeForStatus' default), and the calendar answered.
        return fallback(failedStatus('holidays', r).code);
      }
      for (const ev of r.body.items) if (isBlockingHoliday(ev)) for (const d of eventDays(ev)) dates.add(d);
      pageToken = typeof r.body.nextPageToken === 'string' && r.body.nextPageToken ? r.body.nextPageToken : null;
      if (!pageToken) break;
    }
    holidayCopy = { dates, fetchedAt: now() };
    succeeded();
    return { ok: true, dates };
  }

  /**
   * Insert a booking's event (bookingEvent()). A 409 means that id exists: a success only when the
   * event there is live and carries the same lead. `uncertain` says whether the event may exist
   * although the call failed (a timeout, a network error, a 5xx), so the caller cleans it up.
   * `ready()` is asked right before the request goes out: not true → `{ ok: false, aborted: true,
   * uncertain: false }`, nothing sent (no code: no calendar failure either).
   */
  async function insert(event, { ready = null } = {}) {
    if (!EVENT_ID_RE.test(String(event?.id ?? ''))) return fail('bad_response', { uncertain: false });
    const r = await api('insert', 'POST', calendarPath(calendarId), { query: { sendUpdates: 'none' }, json: event, ready });
    if (r.notConfigured) return fail('auth', { uncertain: false });
    if (r.reported) return fail(r.error, { uncertain: false });
    if (r.aborted) return { ok: false, aborted: true, uncertain: false };
    if (r.error) return failed('insert', r.error, { uncertain: true });
    if (r.status === 200) { succeeded(); return { ok: true, eventId: event.id }; }
    if (r.status === 409) {
      const got = await get(event.id);
      const lead = event.extendedProperties?.private?.bona_lead_id;
      if (got.ok && got.event?.status !== 'cancelled' && got.event?.extendedProperties?.private?.bona_lead_id === lead) {
        return { ok: true, eventId: event.id, existed: true };
      }
      return failed('insert', 'bad_response', { uncertain: false });
    }
    return failedStatus('insert', r, { uncertain: r.status >= 500 });
  }

  /**
   * One event. 404/410 → `{ ok:false, code:'not_found', gone:true }`, which is not a calendar failure.
   * Google's get returns a deleted event itself (status 'cancelled'), so a 404 says the event is not
   * in this calendar, which is also what a calendar the robot cannot see answers (see access()).
   */
  async function get(eventId) {
    if (!EVENT_ID_RE.test(String(eventId ?? ''))) return fail('bad_response');
    const r = await api('get', 'GET', `${calendarPath(calendarId)}/${eventId}`);
    if (r.notConfigured) return fail('auth');
    if (r.reported) return fail(r.error);
    if (r.error) return failed('get', r.error);
    // A 404/410 proves nothing about the calendar's events being readable: health ok, the outage left as it is.
    if (r.status === 404 || r.status === 410) { answered(); return fail('not_found', { gone: true }); }
    if (r.status !== 200 || !r.parseOk || !r.body || typeof r.body !== 'object') return failedStatus('get', r);
    // The caller judges the event; one it cannot use (no readable times) ends no outage either.
    if (usableEvent(r.body)) succeeded(); else answered();
    return { ok: true, event: r.body };
  }

  /**
   * May the robot manage events on the owner's calendar? One events.list that returns only the
   * robot's `accessRole` (no event): `writer` or `owner` is ok. A calendar not shared with it any
   * more answers 404 (not_found); free/busy or read-only sharing is `forbidden`.
   * @returns {Promise<{ ok: true, role: string } | { ok: false, code: string }>}
   */
  async function access() {
    const r = await api('access', 'GET', calendarPath(calendarId), { query: { maxResults: '1', fields: 'accessRole' } });
    if (r.notConfigured) return fail('auth');
    if (r.reported) return fail(r.error);
    if (r.error) return failed('access', r.error);
    if (r.status !== 200) return failedStatus('access', r);
    if (!r.parseOk || !r.body || typeof r.body !== 'object') return failed('access', 'bad_response');
    const role = r.body.accessRole;
    if (role !== 'writer' && role !== 'owner') return failed('access', 'forbidden');
    succeeded();
    return { ok: true, role };
  }

  /** Delete one event, telling nobody (`sendUpdates=none`). Already gone (404/410) is done. */
  async function remove(eventId) {
    if (!EVENT_ID_RE.test(String(eventId ?? ''))) return fail('bad_response');
    const r = await api('delete', 'DELETE', `${calendarPath(calendarId)}/${eventId}`, { query: { sendUpdates: 'none' } });
    if (r.notConfigured) return fail('auth');
    if (r.reported) return fail(r.error);
    if (r.error) return failed('delete', r.error);
    if (r.status === 404 || r.status === 410) { answered(); return { ok: true, gone: true }; }
    if (r.status === 200 || r.status === 204) { succeeded(); return { ok: true }; }
    return failedStatus('delete', r);
  }

  return {
    configured,
    /** The fingerprint new event ids carry (calendarTag of the configured calendar); null when not configured. */
    calendarTag: configured ? calendarTag(calendarId) : null,
    freeBusy,
    holidays,
    cachedHolidays,
    insert,
    get,
    delete: remove,
    access,
    /** The /health `booking.gcal` keys: ok = the last call went through; lastErrorCode = the last failure's code. */
    health: () => ({ configured, ok: configured && state.ok, lastErrorCode: configured ? state.lastErrorCode : null }),
    /** The calendar not answering since the last success: `{ since, last, code }` (times in ms), or null. Never on /health. */
    outage: () => (configured && state.outage ? { ...state.outage } : null),
  };
}
