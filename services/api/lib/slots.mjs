/**
 * Viewing slots (DESIGN §8.2). Pure: no clock, no network, no database. lib/viewing.mjs hands
 * in the time, the busy blocks Google's freeBusy returned and the blocked holiday dates.
 *
 * - Riyadh dates from tomorrow; Sunday to Thursday; starts at 10, 12, 14, 16 and 18; a viewing is
 *   one hour; the next 7 bookable days.
 * - A slot S is free when no busy block overlaps [S - 30 min, S + 90 min) (half-open), and its day
 *   is not a blocked holiday. An all-day opaque event is a busy block over the whole day, so it
 *   takes every slot of that day. Past slots are never offered.
 * - At most 3 a day and 6 in all: the earliest bookable days first, each day's slots spread over
 *   the day (morning to evening). So an open week offers 3 on each of the first two bookable days;
 *   a busier calendar spreads the 6 over more days. validate() still takes any free grid slot up to
 *   MAX_AHEAD_DAYS ahead.
 * - The labels come from code, never from the model: AR "الأحد 29 نوفمبر 10:00 صباحاً", EN
 *   "Sunday 29 November, 10:00 am".
 *
 * Riyadh is UTC+3 all year (no daylight saving), so a Riyadh wall time is plain arithmetic.
 */

export const TIMEZONE = 'Asia/Riyadh';
/** Riyadh's offset from UTC (no daylight saving). */
export const OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
/** The start hours, Riyadh time. */
export const GRID_HOURS = Object.freeze([10, 12, 14, 16, 18]);
/** A viewing lasts one hour. */
export const VIEWING_MS = 60 * MIN_MS;
/** Nothing else may sit in [S - 30 min, S + 90 min): half an hour around the viewing hour. */
export const BUFFER_MS = 30 * MIN_MS;
export const MAX_PER_DAY = 3;
export const MAX_TOTAL = 6;
/** How many bookable days are offered. */
export const BOOKABLE_DAYS = 7;
/** The furthest a slot may be, in calendar days from today (7 bookable days, even across Eid). */
export const MAX_AHEAD_DAYS = 21;
/** Sunday (0) to Thursday (4). */
const WORKDAYS = new Set([0, 1, 2, 3, 4]);

const DAYS = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
};
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
};

const pad = (n) => String(n).padStart(2, '0');
/** The Riyadh wall clock of `ts`, read from a Date shifted by the offset. */
const wall = (ts) => new Date(ts + OFFSET_MS);
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD', the Riyadh date of `ts`. */
export function riyadhDay(ts) {
  const d = wall(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Riyadh midnight of a 'YYYY-MM-DD' day (ms), or NaN for anything else. */
export function dayStart(day) {
  const m = DAY_RE.exec(String(day ?? ''));
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  return utc - OFFSET_MS;
}

const addDays = (day, n) => riyadhDay(dayStart(day) + n * DAY_MS);
const weekday = (day) => new Date(dayStart(day) + OFFSET_MS).getUTCDay();

/** An ISO time with Riyadh's offset, `2026-11-29T10:00:00+03:00` (what Google is sent). */
export function isoRiyadh(ts) {
  const d = wall(ts);
  return `${riyadhDay(ts)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+03:00`;
}

/** The slot id the tools pass around: `2026-11-29T10:00+03:00`. */
export function slotId(ts) {
  const d = wall(ts);
  return `${riyadhDay(ts)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}+03:00`;
}

const SLOT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):00\+03:00$/;
/** A slot id on the grid → its start (ms); anything else (another hour, minute or offset, a bad date) → null. */
export function parseSlotId(id) {
  if (typeof id !== 'string') return null;
  const m = SLOT_RE.exec(id);
  if (!m) return null;
  const hour = Number(m[2]);
  if (!GRID_HOURS.includes(hour)) return null;
  const start = dayStart(m[1]);
  return Number.isFinite(start) ? start + hour * 3_600_000 : null;
}

/**
 * Why `ts` cannot be booked, or null when it can (as far as the calendar's busy blocks allow):
 * 'slot' (not a start on the grid, or a Friday or Saturday), 'too_soon' (today or earlier),
 * 'too_far' (more than MAX_AHEAD_DAYS ahead) or 'holiday'.
 * @param {number} ts
 * @param {{ now: number, holidays?: Set<string>|null }} o
 */
export function checkSlot(ts, { now, holidays = null } = {}) {
  if (!Number.isFinite(ts) || parseSlotId(slotId(ts)) !== ts) return 'slot';
  const day = riyadhDay(ts);
  const today = riyadhDay(now);
  if (day <= today) return 'too_soon';
  if (day > addDays(today, MAX_AHEAD_DAYS)) return 'too_far';
  if (!WORKDAYS.has(weekday(day))) return 'slot';
  if (holidays?.has(day)) return 'holiday';
  return null;
}

/**
 * The next `count` bookable days from tomorrow: Sunday to Thursday, not a holiday, within
 * MAX_AHEAD_DAYS. Riyadh dates, oldest first.
 * @param {number} now
 * @param {{ holidays?: Set<string>|null, count?: number }} [o]
 */
export function bookableDays(now, { holidays = null, count = BOOKABLE_DAYS } = {}) {
  const today = riyadhDay(now);
  const out = [];
  for (let i = 1; i <= MAX_AHEAD_DAYS && out.length < count; i += 1) {
    const day = addDays(today, i);
    if (WORKDAYS.has(weekday(day)) && !holidays?.has(day)) out.push(day);
  }
  return out;
}

/** The busy window of a slot: [S - 30 min, S + 90 min). */
export const slotWindow = (ts) => ({ start: ts - BUFFER_MS, end: ts + VIEWING_MS + BUFFER_MS });

/** True when no busy block overlaps the slot's half-open window. Blocks are `{ start, end }` in ms. */
export function isFree(ts, busy = []) {
  const w = slotWindow(ts);
  for (const b of busy) {
    if (!Number.isFinite(b?.start) || !Number.isFinite(b?.end)) return false;
    if (b.start < w.end && b.end > w.start) return false;
  }
  return true;
}

/** `k` items spread over `list` (first, last and evenly between); the whole list when it is short. */
function spread(list, k) {
  if (list.length <= k) return list.slice();
  if (k <= 1) return list.slice(0, Math.max(0, k));
  const picked = new Set();
  for (let i = 0; i < k; i += 1) picked.add(Math.round((i * (list.length - 1)) / (k - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => list[i]);
}

/**
 * The slots to offer: at most `maxPerDay` a day and `maxTotal` in all, earliest days first.
 * @param {{ now: number, busy?: Array<{start:number,end:number}>, holidays?: Set<string>|null,
 *           days?: string[], maxPerDay?: number, maxTotal?: number }} o
 * @returns {Array<{ slot_id: string, label_ar: string, label_en: string }>}
 */
export function freeSlots({ now, busy = [], holidays = null, days = null, maxPerDay = MAX_PER_DAY, maxTotal = MAX_TOTAL }) {
  const out = [];
  for (const day of days ?? bookableDays(now, { holidays })) {
    if (out.length >= maxTotal) break;
    const free = GRID_HOURS.map((h) => dayStart(day) + h * 3_600_000)
      .filter((ts) => checkSlot(ts, { now, holidays }) === null && ts > now && isFree(ts, busy));
    for (const ts of spread(free, Math.min(maxPerDay, maxTotal - out.length))) {
      out.push({ slot_id: slotId(ts), label_ar: slotLabel(ts, 'ar'), label_en: slotLabel(ts, 'en') });
    }
  }
  return out;
}

/** The freeBusy query window for `days`: the first one's Riyadh midnight to the day after the last. */
export function searchWindow(days) {
  if (!Array.isArray(days) || !days.length) return null;
  const sorted = [...days].sort();
  return { timeMin: isoRiyadh(dayStart(sorted[0])), timeMax: isoRiyadh(dayStart(addDays(sorted.at(-1), 1))) };
}

const lang = (l) => (l === 'en' ? 'en' : 'ar');

/** "Sunday 29 November" / "الأحد 29 نوفمبر". */
export function dateLabel(ts, language = 'ar') {
  const l = lang(language);
  const d = wall(ts);
  return `${DAYS[l][d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[l][d.getUTCMonth()]}`;
}

/** "10:00 am" / "10:00 صباحاً", "2:00 pm" / "2:00 ظهراً", "6:00 pm" / "6:00 مساءً" (Western digits, like the site). */
export function timeLabel(ts, language = 'ar') {
  const d = wall(ts);
  const h = d.getUTCHours();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const clock = `${hh}:${pad(d.getUTCMinutes())}`;
  if (lang(language) === 'en') return `${clock} ${h < 12 ? 'am' : 'pm'}`;
  return `${clock} ${h < 12 ? 'صباحاً' : h < 16 ? 'ظهراً' : 'مساءً'}`;
}

/** A slot's label in the list the assistant offers. */
export function slotLabel(ts, language = 'ar') {
  return lang(language) === 'en'
    ? `${dateLabel(ts, 'en')}, ${timeLabel(ts, 'en')}`
    : `${dateLabel(ts, 'ar')} ${timeLabel(ts, 'ar')}`;
}

/** The date and time line of the booking confirmation (DESIGN §4.1): "Sunday 29 November, 2:00 pm" / "الأحد 29 نوفمبر، 2:00 ظهراً". */
export function slotWhen(ts, language = 'ar') {
  return lang(language) === 'en'
    ? `${dateLabel(ts, 'en')}, ${timeLabel(ts, 'en')}`
    : `${dateLabel(ts, 'ar')}، ${timeLabel(ts, 'ar')}`;
}
