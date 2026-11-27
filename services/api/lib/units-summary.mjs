/* The per-bedroom summary of a developer unit sheet that the listing page publishes: a copy of
   src/lib/units-summary.mjs (unitSummary, liveSummary and the date checks they use), because the VPS runs
   bona-api from a sparse checkout (services + src/data) that has no src/lib. search_units builds its answer
   from liveSummary for every source (through tools.mjs quotableSummary, which never quotes a sheet before the
   page's build shows it), so a client hears only what the page shows (DESIGN §4.5).
   Keep it in step with the site: test/units-summary-parity.test.mjs compares both wherever src/lib exists.
   Every number comes from the sheet; a unit without a printed cash price is skipped (TAQEEM). */

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
    2026-10-02 ("it can warn me, but not disappear"). */
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
    sheet's date is impossible or in the future. */
export function liveSummary(record, listing, now = new Date()) {
  if (!record || listing?.status !== 'available' || !isSheetCurrent(record, now)) return null;
  return unitSummary(record);
}
