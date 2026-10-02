/* Summarise a developer unit sheet (src/data/units.json record) for the listing page.
   Plain JS so Astro and `node --test` (Node 22 in CI, no TS stripping) import the same code.
   Every number comes from the sheet; a unit without a printed cash price is skipped (TAQEEM). */

export const MAX_SHEET_AGE_DAYS = 90;

const BED_LABEL = {
  1: { en: '1 bedroom', ar: 'غرفة نوم واحدة' },
  2: { en: '2 bedrooms', ar: 'غرفتا نوم' },
};
/* Arabic counts: 3–10 take the plural (3 غرف نوم), 11+ the singular (11 غرفة نوم). */
const arBeds = (n) => (n <= 10 ? `${n} غرف نوم` : `${n} غرفة نوم`);
const bedLabel = (n) => BED_LABEL[n] ?? { en: `${n} bedrooms`, ar: arBeds(n) };

function rowOf(key, label, units) {
  const areas = units.map((x) => x.areaSqm);
  return {
    key, label, count: units.length,
    areaMin: Math.min(...areas), areaMax: Math.max(...areas),
    cashFrom: Math.min(...units.map((x) => x.price.cash)),
  };
}

/** @returns {null | { rows: {key:string,label:{en:string,ar:string},count:number,areaMin:number,areaMax:number,cashFrom:number}[],
 *   count:number, areaMin:number, areaMax:number, cashFrom:number, delivery:string|null, updated:string|null }} */
export function unitSummary(record) {
  const units = (record?.units ?? []).filter((x) => typeof x?.price?.cash === 'number' && x.price.cash > 0 && typeof x.areaSqm === 'number');
  if (!units.length) return null;
  const byBeds = new Map();
  const penthouses = [];
  for (const x of units) {
    if (x.class === 'Penthouse') { penthouses.push(x); continue; }
    if (!byBeds.has(x.beds)) byBeds.set(x.beds, []);
    byBeds.get(x.beds).push(x);
  }
  const rows = [...byBeds.keys()].sort((a, b) => a - b).map((b) => rowOf(String(b), bedLabel(b), byBeds.get(b)));
  if (penthouses.length) {
    const beds = penthouses.map((x) => x.beds);
    const lo = Math.min(...beds); const hi = Math.max(...beds);
    const one = bedLabel(lo);
    const label = lo === hi
      ? { en: `Penthouse, ${one.en}`, ar: `بنتهاوس، ${one.ar}` }
      : lo === 1 && hi === 2
        ? { en: 'Penthouse, 1–2 bedrooms', ar: 'بنتهاوس، من غرفة إلى غرفتي نوم' }
        : { en: `Penthouse, ${lo}–${hi} bedrooms`, ar: `بنتهاوس، من ${lo} إلى ${arBeds(hi)}` };
    rows.push(rowOf('penthouse', label, penthouses));
  }
  const all = rowOf('all', { en: '', ar: '' }, units);
  return {
    rows, count: all.count, areaMin: all.areaMin, areaMax: all.areaMax, cashFrom: all.cashFrom,
    // An impossible delivery ("2028-02-30", "2028-13") is dropped, never rolled over into a date the sheet does not give.
    delivery: isDeliveryDate(record.delivery) ? record.delivery : null, updated: record.updated ?? null,
  };
}

/** Whole days between the sheet date (YYYY-MM-DD, read as UTC midnight) and `now`. */
export function sheetAgeDays(updated, now = new Date()) {
  return Math.floor((now.getTime() - Date.parse(`${updated}T00:00:00Z`)) / 86_400_000);
}

/** True for a real YYYY-MM-DD calendar date (2026-02-30 is not one). */
export function isSheetDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A delivery is a real YYYY-MM month or a real YYYY-MM-DD date. */
export function isDeliveryDate(s) {
  if (typeof s !== 'string') return false;
  if (/^\d{4}-\d{2}$/.test(s)) { const m = Number(s.slice(5)); return m >= 1 && m <= 12; }
  return isSheetDate(s);
}

/** A sheet is shown while its date is real and not in the future. Its AGE never hides it: owner decision
    2026-10-02 ("it can warn me, but not disappear"). The table always prints the sheet date, and an old sheet
    only produces warnings (rules.mjs::unitsSheetProblems) and the owner's calendar reminder. */
export function isSheetCurrent(record, now = new Date()) {
  if (!isSheetDate(record?.updated)) return false;
  return sheetAgeDays(record.updated, now) >= 0;
}

/** The record for a listing from units.json (one object today, an array once a second project has a sheet). */
export function recordFor(unitsData, listingId) {
  const all = Array.isArray(unitsData) ? unitsData : [unitsData];
  return all.find((r) => r?.listingId === listingId) ?? null;
}

/** What the page may publish from the sheet: the summary, or null when the listing is not available or the
    sheet's date is impossible or in the future. Checked at BUILD time; never fails the build. */
export function liveSummary(record, listing, now = new Date()) {
  if (!record || listing?.status !== 'available' || !isSheetCurrent(record, now)) return null;
  return unitSummary(record);
}

const num = (n) => new Intl.NumberFormat('en-US').format(n);
/** Long date in the page language: "2 September 2026" / "2 سبتمبر 2026"; month-only for YYYY-MM. Gregorian, Western digits. */
export function sheetDateText(iso, locale) {
  const withDay = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB',
    withDay ? { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' },
  ).format(new Date(withDay ? `${iso}T00:00:00Z` : `${iso}-01T00:00:00Z`));
}

/** Placeholders a listing FAQ answer may use; each is filled from the live sheet summary. */
export const FAQ_PLACEHOLDERS = ['cashFrom', 'count', 'areaMin', 'areaMax', 'sheetDate', 'delivery'];

export function sheetVars(summary, locale) {
  if (!summary) return null;
  return {
    cashFrom: num(summary.cashFrom), count: num(summary.count),
    areaMin: num(summary.areaMin), areaMax: num(summary.areaMax),
    sheetDate: summary.updated ? sheetDateText(summary.updated, locale) : null,
    delivery: summary.delivery ? sheetDateText(summary.delivery, locale) : null,
  };
}

/** Localise a listing FAQ and fill its {placeholders}. An item that needs a value the sheet cannot give
    (no live sheet, or a missing field) is dropped whole — a half-filled price answer is worse than none. */
export function localFaq(faq, locale, vars) {
  const out = [];
  for (const it of faq ?? []) {
    const q = it.q?.[locale] ?? it.q?.en;
    const raw = it.a?.[locale] ?? it.a?.en ?? [];
    let ok = true;
    const a = raw.map((p) => p.replace(/\{(\w+)\}/g, (m, k) => {
      const v = vars?.[k];
      if (v === null || v === undefined) { ok = false; return m; }
      return v;
    }));
    if (ok && q && a.length) out.push({ id: it.id, q, a });
  }
  return out;
}
