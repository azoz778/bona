/* Summarise a developer unit sheet (src/data/units.json record) for the listing page.
   Plain JS so Astro and `node --test` (Node 22 in CI, no TS stripping) import the same code.
   Every number comes from the sheet; a unit without a printed cash price is skipped (TAQEEM). */

export const MAX_SHEET_AGE_DAYS = 90;

const BED_LABEL = {
  1: { en: '1 bedroom', ar: 'غرفة نوم واحدة' },
  2: { en: '2 bedrooms', ar: 'غرفتا نوم' },
};
const bedLabel = (n) => BED_LABEL[n] ?? { en: `${n} bedrooms`, ar: `${n} غرف نوم` };

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
    const range = lo === hi ? String(lo) : `${lo}–${hi}`;
    const label = lo === hi && lo === 1
      ? { en: 'Penthouse, 1 bedroom', ar: 'بنتهاوس، غرفة نوم واحدة' }
      : { en: `Penthouse, ${range} bedrooms`, ar: `بنتهاوس، ${range} غرف نوم` };
    rows.push(rowOf('penthouse', label, penthouses));
  }
  const all = rowOf('all', { en: '', ar: '' }, units);
  return {
    rows, count: all.count, areaMin: all.areaMin, areaMax: all.areaMax, cashFrom: all.cashFrom,
    delivery: record.delivery ?? null, updated: record.updated ?? null,
  };
}

/** Whole days between the sheet date (YYYY-MM-DD, read as UTC midnight) and `now`. */
export function sheetAgeDays(updated, now = new Date()) {
  return Math.floor((now.getTime() - Date.parse(`${updated}T00:00:00Z`)) / 86_400_000);
}
