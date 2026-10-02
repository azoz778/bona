# Project Details Block + Listing FAQ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give listings that have a developer unit sheet a units-and-prices summary, key facts and an FAQ (with FAQPage JSON-LD), and ship it on Darco Prime Waterfront (BONA-W014).

**Architecture:** Pure summarising logic lives in a plain-JS module `src/lib/units-summary.mjs` (importable by Astro and by `node --test` on Node 22 in CI without TS stripping). Shape rules for the three new optional listing fields live in `scripts/curate/rules.mjs` beside the existing rules, so `validate.mjs` and the tests use one definition. Rendering is a new `ProjectDetails.astro` plus an FAQ section in `ListingPage.astro`. The FAQ JSON-LD is a separate `FAQPage` node with `@id <url>#faq`, so it never replaces the page's automatic `ItemPage` node.

**Tech Stack:** Astro 7, Tailwind 4, TypeScript in `src/lib/*.ts`, Node 22 (CI) / 24 (local) `node --test`.

Spec: `docs/superpowers/specs/2026-10-02-project-details-seo-design.md`.
Working dir for every command: `~/bona-wt-project-details` (worktree on branch `feat/project-details`).

**Facts used (do not add others):** `src/data/units.json` (developer sheet dated 2026-09-02: 111 units, delivery 2028-06, cash prices) and the brochure (22 buildings, 534 units). Instalment plan lengths (six months, one year, two years) come from the sheet and already appear in the live description.

Expected Darco summary (computed from units.json; the tests assert it):

| Row | Count | Area min–max | Cash from |
|---|---|---|---|
| 1 bed | 64 | 55.45–85.01 | 708,164 |
| 2 bed | 35 | 88.94–106.29 | 1,036,286 |
| 3 bed | 9 | 123.49–139.39 | 1,346,754 |
| Penthouse (1–2 bed) | 3 | 57.82–91.56 | 881,368 |
| Total | 111 | 55.45–139.39 | 708,164 |

---

### Task 1: Units summary module

**Files:**
- Create: `src/lib/units-summary.mjs`
- Test: `test/units-summary.test.mjs`

- [ ] **Step 1: Write the failing test** — `test/units-summary.test.mjs`

```js
/** Pure unit-sheet summarising (src/lib/units-summary.mjs). Runs without dist/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unitSummary, sheetAgeDays, MAX_SHEET_AGE_DAYS } from '../src/lib/units-summary.mjs';

const u = (beds, cls, areaSqm, cash) => ({ beds, class: cls, areaSqm, price: { cash } });
const fixture = { listingId: 'BONA-W999', delivery: '2028-06', updated: '2026-09-02', units: [
  u(1, 'Standard', 60, 800000), u(1, 'Premium', 70, 750000), u(1, 'The Jewel', 85, 1000000),
  u(2, 'Standard', 95, 1100000), u(3, 'Premium', 130, 1400000),
  u(1, 'Penthouse', 58, 900000), u(2, 'Penthouse', 92, 1200000),
] };

test('one row per bedroom count, penthouses in their own row, sorted', () => {
  const s = unitSummary(fixture);
  assert.deepEqual(s.rows.map((r) => [r.key, r.count]), [['1', 3], ['2', 1], ['3', 1], ['penthouse', 2]]);
});

test('row maths: min/max area and the lowest cash price', () => {
  const [one, , , ph] = unitSummary(fixture).rows;
  assert.equal(one.areaMin, 60); assert.equal(one.areaMax, 85); assert.equal(one.cashFrom, 750000);
  assert.equal(ph.areaMin, 58); assert.equal(ph.areaMax, 92); assert.equal(ph.cashFrom, 900000);
});

test('labels are bilingual and the penthouse label carries its bed range', () => {
  const rows = unitSummary(fixture).rows;
  assert.equal(rows[0].label.en, '1 bedroom'); assert.equal(rows[0].label.ar, 'غرفة نوم واحدة');
  assert.equal(rows[1].label.en, '2 bedrooms'); assert.equal(rows[1].label.ar, 'غرفتا نوم');
  assert.equal(rows[2].label.en, '3 bedrooms'); assert.equal(rows[2].label.ar, '3 غرف نوم');
  assert.equal(rows[3].label.en, 'Penthouse, 1–2 bedrooms'); assert.equal(rows[3].label.ar, 'بنتهاوس، 1–2 غرف نوم');
});

test('totals cover every unit', () => {
  const s = unitSummary(fixture);
  assert.deepEqual([s.count, s.areaMin, s.areaMax, s.cashFrom], [7, 58, 130, 750000]);
  assert.equal(s.delivery, '2028-06'); assert.equal(s.updated, '2026-09-02');
});

test('no record or no units gives null', () => {
  assert.equal(unitSummary(null), null);
  assert.equal(unitSummary({ ...fixture, units: [] }), null);
});

test('a unit with no cash price is ignored rather than shown as 0', () => {
  const s = unitSummary({ ...fixture, units: [...fixture.units, u(1, 'Standard', 50, null)] });
  assert.equal(s.count, 7); assert.equal(s.areaMin, 58);
});

test('sheet age in whole days, and the limit is 90', () => {
  assert.equal(sheetAgeDays('2026-09-02', new Date('2026-10-02T12:00:00Z')), 30);
  assert.equal(MAX_SHEET_AGE_DAYS, 90);
});

test('the real Darco sheet summarises to the published figures', () => {
  const rec = JSON.parse(readFileSync(new URL('../src/data/units.json', import.meta.url), 'utf8'));
  const s = unitSummary(rec);
  assert.deepEqual(s.rows.map((r) => [r.key, r.count, r.areaMin, r.areaMax, r.cashFrom]), [
    ['1', 64, 55.45, 85.01, 708164], ['2', 35, 88.94, 106.29, 1036286],
    ['3', 9, 123.49, 139.39, 1346754], ['penthouse', 3, 57.82, 91.56, 881368],
  ]);
  assert.deepEqual([s.count, s.cashFrom], [111, 708164]);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `node --test test/units-summary.test.mjs`
Expected: FAIL, `Cannot find module .../src/lib/units-summary.mjs`.

- [ ] **Step 3: Implement** — `src/lib/units-summary.mjs`

```js
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
```

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/units-summary.test.mjs`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/units-summary.mjs test/units-summary.test.mjs
git commit -m "units: summarise a developer unit sheet by bedroom count (penthouses apart)"
```

---

### Task 2: Shape rules for `faq`, `seoTitle`, `projectFacts` + sheet staleness

**Files:**
- Modify: `scripts/curate/rules.mjs` (append)
- Modify: `scripts/curate/validate.mjs` (import line 10; inside the `for (const l of data)` loop before the copy-hygiene block; after the loop)
- Test: `test/listing-extras.test.mjs`

- [ ] **Step 1: Write the failing test** — `test/listing-extras.test.mjs`

```js
/** Shape rules for the optional listing fields faq / seoTitle / projectFacts, and the unit-sheet age rule. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { faqProblems, seoTitleProblems, projectFactsProblems, unitsSheetProblems } from '../scripts/curate/rules.mjs';

const q = (id) => ({ id, q: { en: 'Who builds it?', ar: 'من المطور؟' }, a: { en: ['Darco Real Estate Company.'], ar: ['شركة داركو العقارية.'] } });

test('faq: absent is fine, a good list is fine', () => {
  assert.deepEqual(faqProblems(undefined), []);
  assert.deepEqual(faqProblems([q('developer'), q('handover'), q('sizes')]), []);
});

test('faq: 3–8 items, unique kebab ids, both languages, Arabic really Arabic', () => {
  assert.match(faqProblems([q('a'), q('b')]).join(), /3–8/);
  assert.match(faqProblems([q('a'), q('a'), q('b')]).join(), /duplicate/);
  assert.match(faqProblems([q('Bad Id'), q('b'), q('c')]).join(), /id/);
  const noAr = { ...q('c'), a: { en: ['x'], ar: [] } };
  assert.match(faqProblems([q('a'), q('b'), noAr]).join(), /a\.ar/);
  const latinAr = { ...q('c'), q: { en: 'x', ar: 'not arabic' } };
  assert.match(faqProblems([q('a'), q('b'), latinAr]).join(), /q\.ar/);
});

test('seoTitle: both languages, at most 70 characters', () => {
  assert.deepEqual(seoTitleProblems(undefined), []);
  assert.deepEqual(seoTitleProblems({ en: 'Darco Prime Apartments for Sale', ar: 'شقق داركو برايم للبيع' }), []);
  assert.match(seoTitleProblems({ en: 'x' }).join(), /ar/);
  assert.match(seoTitleProblems({ en: 'x'.repeat(71), ar: 'شقق' }).join(), /70/);
});

test('projectFacts: positive integers only', () => {
  assert.deepEqual(projectFactsProblems(undefined), []);
  assert.deepEqual(projectFactsProblems({ totalUnits: 534, buildings: 22 }), []);
  assert.match(projectFactsProblems({ totalUnits: 0 }).join(), /totalUnits/);
  assert.match(projectFactsProblems({ buildings: 2.5 }).join(), /buildings/);
  assert.match(projectFactsProblems({ floors: 3 }).join(), /unknown/);
});

test('unit sheet: fails past 90 days, and with a bad date', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  assert.deepEqual(unitsSheetProblems({ updated: '2026-09-02', units: [{}] }, now), []);
  assert.match(unitsSheetProblems({ updated: '2026-06-01', units: [{}] }, now).join(), /123 days/);
  assert.match(unitsSheetProblems({ updated: 'soon', units: [{}] }, now).join(), /updated/);
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test test/listing-extras.test.mjs`
Expected: FAIL, `does not provide an export named 'faqProblems'`.

- [ ] **Step 3: Implement** — append to `scripts/curate/rules.mjs`

```js
// ---- Optional listing fields for project pages (2026-10-02, SEO audit rec. 1) --------------------
// faq / seoTitle / projectFacts are optional on any listing; when present both languages are required,
// because the page renders whichever locale it is building and a blank half would ship silently.
import { sheetAgeDays, MAX_SHEET_AGE_DAYS } from '../../src/lib/units-summary.mjs';

const AR_RE = /[؀-ۿ]/;
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

export function faqProblems(faq) {
  if (faq === undefined || faq === null) return [];
  if (!Array.isArray(faq) || faq.length < 3 || faq.length > 8) return ['faq must be an array of 3–8 items'];
  const out = []; const seen = new Set();
  faq.forEach((it, i) => {
    const at = `faq[${i}]`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(it?.id ?? '')) out.push(`${at}.id must be lowercase-hyphenated`);
    else if (seen.has(it.id)) out.push(`${at}.id "${it.id}" is a duplicate`);
    seen.add(it?.id);
    if (!nonEmpty(it?.q?.en)) out.push(`${at}.q.en required`);
    if (!nonEmpty(it?.q?.ar) || !AR_RE.test(it.q.ar)) out.push(`${at}.q.ar required (Arabic)`);
    for (const lang of ['en', 'ar']) {
      const a = it?.a?.[lang];
      if (!Array.isArray(a) || !a.length || !a.every(nonEmpty)) out.push(`${at}.a.${lang} must be a non-empty array of paragraphs`);
      else if (lang === 'ar' && !a.every((p) => AR_RE.test(p))) out.push(`${at}.a.ar must be Arabic`);
    }
  });
  return out;
}

export function seoTitleProblems(t) {
  if (t === undefined || t === null) return [];
  const out = [];
  if (!nonEmpty(t.en)) out.push('seoTitle.en required');
  if (!nonEmpty(t.ar) || !AR_RE.test(t.ar)) out.push('seoTitle.ar required (Arabic)');
  for (const lang of ['en', 'ar']) if (nonEmpty(t[lang]) && t[lang].length > 70) out.push(`seoTitle.${lang} is ${t[lang].length} characters, keep it to 70 (the brand is appended)`);
  return out;
}

export function projectFactsProblems(f) {
  if (f === undefined || f === null) return [];
  const out = [];
  for (const k of Object.keys(f)) if (!['totalUnits', 'buildings'].includes(k)) out.push(`projectFacts.${k} is unknown`);
  for (const k of ['totalUnits', 'buildings']) if (k in f && !(Number.isInteger(f[k]) && f[k] > 0)) out.push(`projectFacts.${k} must be a positive integer`);
  return out;
}

export function unitsSheetProblems(record, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record?.updated ?? '') || Number.isNaN(Date.parse(record.updated))) return ['units.json updated must be a YYYY-MM-DD sheet date'];
  const age = sheetAgeDays(record.updated, now);
  return age > MAX_SHEET_AGE_DAYS
    ? [`units.json sheet for ${record.listingId} is ${age} days old (limit ${MAX_SHEET_AGE_DAYS}): ask the owner for a fresh developer sheet, or remove the record so the prices come off the site`]
    : [];
}
```

Move the new `import` line to the top of `rules.mjs` with any other imports (ES modules require it at top level; place it after the file's header comment).

- [ ] **Step 4: Wire into `validate.mjs`**

Change the import on line 10 to add `faqProblems, projectFactsProblems, seoTitleProblems, unitsSheetProblems`.

Inside the `for (const l of data)` loop, just before the `// copy hygiene` comment, add:

```js
  // Project-page extras (rules.mjs): optional, but whole when present.
  for (const p of [...faqProblems(l.faq), ...seoTitleProblems(l.seoTitle), ...projectFactsProblems(l.projectFacts)]) err(id, p);
  for (const it of Array.isArray(l.faq) ? l.faq : []) for (const [label, str] of [['faq.q.en', it.q?.en], ['faq.q.ar', it.q?.ar], ...(it.a?.en ?? []).map((x) => ['faq.a.en', x]), ...(it.a?.ar ?? []).map((x) => ['faq.a.ar', x])]) if (isStr(str)) checkCopy(id, label, str);
```

After the loop (just before `const featured = …`), add:

```js
// Developer unit sheet: prices on the site must not outlive the sheet they came from.
const UNITS_FILE = path.join(ROOT, 'src', 'data', 'units.json');
if (fs.existsSync(UNITS_FILE)) {
  const sheet = JSON.parse(fs.readFileSync(UNITS_FILE, 'utf8'));
  for (const rec of Array.isArray(sheet) ? sheet : [sheet]) {
    if (!ids.has(rec.listingId)) err('units', `units.json record ${rec.listingId} has no listing`);
    for (const p of unitsSheetProblems(rec)) err('units', p);
  }
}
```

- [ ] **Step 5: Run tests and the validator**

Run: `node --test test/listing-extras.test.mjs && node scripts/curate/validate.mjs`
Expected: 5 tests pass; `listings.json OK — 48 listings …`.

- [ ] **Step 6: Commit**

```bash
git add scripts/curate/rules.mjs scripts/curate/validate.mjs test/listing-extras.test.mjs
git commit -m "validate: faq/seoTitle/projectFacts shapes, and a 90-day limit on developer unit sheets"
```

---

### Task 3: Types, UI strings and the `ProjectDetails` component

**Files:**
- Modify: `src/lib/listings.ts` (Listing interface, after `licence?`)
- Modify: `src/lib/i18n.ts` (inside `ui`, after `aboutThisResidence`)
- Create: `src/components/ProjectDetails.astro`

- [ ] **Step 1: Extend the Listing type** — add inside `interface Listing` after the `licence?` line:

```ts
  /** Project pages (2026-10-02): short bilingual FAQ, rendered with FAQPage JSON-LD. Facts only from developer documents. */
  faq?: { id: string; q: Localised; a: { en: string[]; ar: string[] } }[];
  /** Replaces the auto-built title tag (brand still appended by <Head>). */
  seoTitle?: Localised;
  /** Brochure-sourced project counts shown beside the unit sheet. */
  projectFacts?: { totalUnits?: number; buildings?: number } | null;
```

- [ ] **Step 2: Add UI strings** — in `ui`, after `aboutThisResidence`:

```ts
  unitsAndPrices: s('Units and prices', 'الوحدات والأسعار'),
  unitTypeCol: s('Type', 'النوع'),
  unitAreaCol: s('Area (sqm)', 'المساحة (م²)'),
  unitFromCashCol: s('From (cash)', 'ابتداءً من (كاش)'),
  unitAvailableCol: s('Available', 'المتاح'),
  unitsAllRow: s('All units', 'جميع الوحدات'),
  unitsSheetNote: s('Cash prices and availability from the developer’s unit sheet dated {date}. The developer also offers instalment plans; ask us for the schedule for a specific unit.', 'أسعار الكاش والتوافر من كشف وحدات المطور بتاريخ {date}. يقدم المطور أيضاً خطط تقسيط، واسألنا عن جدول السداد لوحدة بعينها.'),
  keyFacts: s('Key facts', 'معلومات أساسية'),
  factDeveloper: s('Developer', 'المطور'),
  factHandover: s('Expected handover', 'التسليم المتوقع'),
  factUnitsAvailable: s('Units available', 'الوحدات المتاحة'),
  factUnitsOfTotal: s('{n} of {total}', '{n} من {total}'),
  factBuildings: s('Buildings', 'المباني'),
  faqSectionTitle: s('Questions', 'أسئلة شائعة'),
```

- [ ] **Step 3: Create** `src/components/ProjectDetails.astro`

```astro
---
/* Units-and-prices summary + key facts for a listing backed by a developer unit sheet
   (src/data/units.json). Renders nothing when the listing has no sheet. Spec:
   docs/superpowers/specs/2026-10-02-project-details-seo-design.md */
import unitsData from '../data/units.json';
import { unitSummary } from '../lib/units-summary.mjs';
import { t, ui, fill, formatNumber, formatPrice, type Locale } from '../lib/i18n';
import type { Listing } from '../lib/listings';

interface Props { listing: Listing; locale: Locale; class?: string }
const { listing: l, locale, class: cls = '' } = Astro.props;
const records = (Array.isArray(unitsData) ? unitsData : [unitsData]) as any[];
const record = records.find((r) => r.listingId === l.id) ?? null;
const summary = unitSummary(record);
const dateFmt = (iso: string, withDay: boolean) => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB',
  withDay ? { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' }
).format(new Date(withDay ? `${iso}T00:00:00Z` : `${iso}-01T00:00:00Z`));
const cash = (n: number) => formatPrice({ amount: n, currency: record?.currency ?? 'SAR' }, locale);
const area = (lo: number, hi: number) => (lo === hi ? formatNumber(lo) : `${formatNumber(lo)}–${formatNumber(hi)}`);
const developer = record?.developer ? t(record.developer, locale) : (l.project?.developer ? t(l.project.developer, locale) : '');
const total = l.projectFacts?.totalUnits;
const facts = summary ? [
  developer ? { k: t(ui.factDeveloper, locale), v: developer } : null,
  summary.delivery ? { k: t(ui.factHandover, locale), v: dateFmt(summary.delivery, false) } : null,
  { k: t(ui.factUnitsAvailable, locale), v: total ? fill(t(ui.factUnitsOfTotal, locale), { n: formatNumber(summary.count), total: formatNumber(total) }) : formatNumber(summary.count) },
  l.projectFacts?.buildings ? { k: t(ui.factBuildings, locale), v: formatNumber(l.projectFacts.buildings) } : null,
].filter(Boolean) as { k: string; v: string }[] : [];
---
{summary && (
  <section id="units" class={`scroll-mt-28 ${cls}`} aria-labelledby={`units-${l.id}`} data-project-details>
    <h2 id={`units-${l.id}`} class="label text-stone-2">{t(ui.unitsAndPrices, locale)}</h2>
    <div class="mt-5 overflow-x-auto">
      <table class="w-full min-w-[30rem] text-[15px]">
        <thead>
          <tr class="border-b border-ink/15 text-start text-xs text-stone-2">
            <th scope="col" class="py-2 pe-4 text-start font-medium">{t(ui.unitTypeCol, locale)}</th>
            <th scope="col" class="py-2 pe-4 text-end font-medium">{t(ui.unitAreaCol, locale)}</th>
            <th scope="col" class="py-2 pe-4 text-end font-medium">{t(ui.unitFromCashCol, locale)}</th>
            <th scope="col" class="py-2 text-end font-medium">{t(ui.unitAvailableCol, locale)}</th>
          </tr>
        </thead>
        <tbody>
          {summary.rows.map((r) => (
            <tr class="border-b border-ink/10">
              <th scope="row" class="py-3 pe-4 text-start font-normal">{t(r.label, locale)}</th>
              <td class="py-3 pe-4 text-end tabular-nums" dir="ltr">{area(r.areaMin, r.areaMax)}</td>
              <td class="py-3 pe-4 text-end tabular-nums">{cash(r.cashFrom)}</td>
              <td class="py-3 text-end tabular-nums">{formatNumber(r.count)}</td>
            </tr>
          ))}
          <tr class="font-semibold">
            <th scope="row" class="py-3 pe-4 text-start">{t(ui.unitsAllRow, locale)}</th>
            <td class="py-3 pe-4 text-end tabular-nums" dir="ltr">{area(summary.areaMin, summary.areaMax)}</td>
            <td class="py-3 pe-4 text-end tabular-nums">{cash(summary.cashFrom)}</td>
            <td class="py-3 text-end tabular-nums">{formatNumber(summary.count)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    {summary.updated && <p class="mt-4 max-w-[60ch] text-sm leading-relaxed text-stone-2" data-units-note>{fill(t(ui.unitsSheetNote, locale), { date: dateFmt(summary.updated, true) })}</p>}
    {facts.length > 0 && (
      <>
        <h3 class="label mt-10 text-stone-2">{t(ui.keyFacts, locale)}</h3>
        <dl class="mt-4 grid gap-x-10 gap-y-4 sm:grid-cols-2">
          {facts.map((f) => (
            <div class="border-t border-ink/10 pt-3">
              <dt class="text-xs text-stone-2">{f.k}</dt>
              <dd class="mt-1 text-[15px]">{f.v}</dd>
            </div>
          ))}
        </dl>
      </>
    )}
  </section>
)}
```

Note: `units.json` today is a single object, not an array; the `Array.isArray` guard lets a second project become an array later without touching this file.

- [ ] **Step 4: Type-check**

Run: `npx astro check 2>&1 | tail -5`
Expected: `0 errors`. If `.mjs` import types complain, add `// @ts-ignore` on nothing; instead create `src/lib/units-summary.d.mts`:

```ts
export const MAX_SHEET_AGE_DAYS: number;
export type SummaryRow = { key: string; label: { en: string; ar: string }; count: number; areaMin: number; areaMax: number; cashFrom: number };
export function unitSummary(record: unknown): null | { rows: SummaryRow[]; count: number; areaMin: number; areaMax: number; cashFrom: number; delivery: string | null; updated: string | null };
export function sheetAgeDays(updated: string, now?: Date): number;
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/listings.ts src/lib/i18n.ts src/components/ProjectDetails.astro src/lib/units-summary.d.mts 2>/dev/null; git add -u
git commit -m "listing: ProjectDetails block — units-by-type table and key facts from the developer sheet"
```

---

### Task 4: FAQ JSON-LD helper and ListingPage wiring

**Files:**
- Modify: `src/lib/seo.ts` (after `faqPageJsonLd`, ~line 590)
- Modify: `src/components/pages/ListingPage.astro` (imports; `metaTitle`; `jsonLd`; body after Highlights)

- [ ] **Step 1: Add `listingFaqJsonLd`** in `src/lib/seo.ts`, right after `faqPageJsonLd`:

```ts
/** FAQPage node for a listing's own FAQ. Its @id is <url>#faq — NOT the page @id — so it sits beside
    Head's automatic ItemPage node instead of replacing it. Undefined when the listing has no FAQ. */
export function listingFaqJsonLd(listing: Listing, locale: Locale): object | undefined {
  const items = (listing.faq ?? []).map((it) => ({ id: it.id, q: it.q[locale] ?? it.q.en, a: it.a[locale] ?? it.a.en }))
    .filter((it) => it.q && it.a.length);
  if (!items.length) return undefined;
  const url = absoluteUrl(listingPath(listing, locale));
  return {
    '@type': 'FAQPage',
    '@id': `${url}#faq`,
    url,
    inLanguage: locale === 'ar' ? 'ar-SA' : 'en',
    isPartOf: { '@id': url },
    mainEntity: items.map((it) => ({
      '@type': 'Question',
      '@id': `${url}#faq-${it.id}`,
      name: it.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: it.a.map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join(''),
        url: `${url}#faq-${it.id}`,
      },
    })),
  };
}
```

Check `listingPath` exists in seo.ts with signature `(listing, locale)` (`grep -n "export function listingPath" src/lib/seo.ts`). If its signature differs, use `localePath(locale, \`/properties/${listing.slug}/\`)` instead.

- [ ] **Step 2: Wire ListingPage** — `src/components/pages/ListingPage.astro`
  - Import: change line 15 to `import { listingJsonLd, breadcrumbJsonLd, listingFaqJsonLd, metaDescription } from '../../lib/seo';` and add `import ProjectDetails from '../ProjectDetails.astro';` after the RegaBlock import.
  - Title: replace `const metaTitle = [title, …].filter(Boolean).join(' — ');` with
    ```ts
    const autoTitle = [title, [categoryText, !titleHasCity && cityText].filter(Boolean).join(locale === 'ar' ? ' في ' : ' in ')]
      .filter(Boolean).join(' — ');
    const metaTitle = l.seoTitle?.[locale]?.trim() || autoTitle;
    const faq = (l.faq ?? []).map((it) => ({ id: it.id, q: t(it.q, locale), a: it.a[locale] ?? it.a.en }));
    ```
  - jsonLd: `jsonLd={[listingJsonLd(l, locale), breadcrumbJsonLd(crumbs), listingFaqJsonLd(l, locale)].filter(Boolean)}`
  - Body: directly after the Highlights `</section>)}` block and before `{hasMatterport && <TourEmbed …`, insert:
    ```astro
          <ProjectDetails listing={l} locale={locale} class="mt-14" />

          {faq.length > 0 && (
            <section id="faq" class="mt-14 scroll-mt-28" aria-labelledby={`faq-${l.id}`} data-listing-faq>
              <h2 id={`faq-${l.id}`} class="label text-stone-2">{t(ui.faqSectionTitle, locale)}</h2>
              <div class="mt-5 divide-y divide-ink/10 border-y border-ink/10">
                {faq.map((it) => (
                  <div id={`faq-${it.id}`} class="scroll-mt-28 py-5">
                    <h3 class="text-[15px] font-semibold md:text-base">{it.q}</h3>
                    <div class="mt-2 text-[15px] leading-relaxed text-ink/85">{it.a.map((p) => <p class="mt-2 first:mt-0">{p}</p>)}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
    ```

- [ ] **Step 3: Build**

Run: `npx astro check 2>&1 | tail -3 && npm run build 2>&1 | tail -3`
Expected: 0 errors; build completes. (No listing has `faq` yet, so the pages are unchanged except Darco gains the units table.)

- [ ] **Step 4: Commit**

```bash
git add -u && git commit -m "listing: per-listing FAQ section + FAQPage node (#faq), seoTitle override"
```

---

### Task 5: Darco Prime content

**Files:**
- Modify: `scripts/curate/inbox/darco-prime-waterfront-al-shati.json` (add three keys)
- Regenerate: `src/data/listings.json` via `node scripts/curate/build.mjs`

- [ ] **Step 1: Add the fields** with a one-off Node script (keeps the file's key order and formatting):

```bash
node -e '
const fs=require("fs");const f="scripts/curate/inbox/darco-prime-waterfront-al-shati.json";
const d=JSON.parse(fs.readFileSync(f,"utf8"));
d.seoTitle={en:"Darco Prime Waterfront Apartments for Sale, Al Shati Jeddah",ar:"شقق داركو برايم للبيع، الشاطئ جدة"};
d.projectFacts={totalUnits:534,buildings:22};
d.faq=[
 {id:"developer",q:{en:"Who is developing Darco Prime Waterfront?",ar:"من مطور مشروع داركو برايم الواجهة البحرية؟"},
  a:{en:["Darco Real Estate Company. The project sits in the Al-Shati district of Jeddah, near the Red Sea, and comprises 22 buildings with 534 residential units."],
     ar:["شركة داركو العقارية. يقع المشروع في حي الشاطئ بمدينة جدة بالقرب من البحر الأحمر، ويضم 22 مبنى تحتوي على 534 وحدة سكنية."]}},
 {id:"handover",q:{en:"When is handover expected?",ar:"متى موعد التسليم المتوقع؟"},
  a:{en:["The developer’s unit sheet dated 2 September 2026 gives an expected delivery of June 2028."],
     ar:["يحدد كشف وحدات المطور بتاريخ 2 سبتمبر 2026 موعد التسليم المتوقع في يونيو 2028."]}},
 {id:"sizes",q:{en:"What unit sizes are available?",ar:"ما مساحات الوحدات المتاحة؟"},
  a:{en:["According to the developer’s sheet dated 2 September 2026, 111 units are available: one-, two- and three-bedroom apartments from 55.45 to 139.39 square metres, including three penthouses."],
     ar:["بحسب كشف المطور بتاريخ 2 سبتمبر 2026، تتوفر 111 وحدة: شقق بغرفة وغرفتين وثلاث غرف نوم بمساحات من 55.45 إلى 139.39 متراً مربعاً، منها ثلاث وحدات بنتهاوس."]}},
 {id:"price",q:{en:"What is the starting price?",ar:"ما السعر الابتدائي؟"},
  a:{en:["Cash prices start from SAR 708,164 on the developer’s sheet dated 2 September 2026. Prices and availability change; we confirm the current figure for any unit before you commit."],
     ar:["تبدأ أسعار الكاش من 708,164 ريال سعودي بحسب كشف المطور بتاريخ 2 سبتمبر 2026. تتغير الأسعار والتوافر، ونؤكد لك السعر الحالي لأي وحدة قبل الالتزام."]}},
 {id:"instalments",q:{en:"Is there an instalment plan?",ar:"هل يتوفر التقسيط؟"},
  a:{en:["Yes. Besides the cash price, the developer offers instalment plans over six months, one year and two years. Ask us and we will send the schedule for the unit you are considering."],
     ar:["نعم. إلى جانب سعر الكاش، يقدم المطور خطط تقسيط على ستة أشهر وسنة وسنتين. تواصل معنا ونرسل لك جدول السداد للوحدة التي تهمك."]}}
];
fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n");'
```

- [ ] **Step 2: Rebuild and validate**

Run: `node scripts/curate/build.mjs | tail -1 && node scripts/curate/validate.mjs && git diff --stat`
Expected: `listings.json OK — 48 listings …`; diff touches only the inbox file and `src/data/listings.json` (Darco entry gains `seoTitle`, `projectFacts`, `faq`).

- [ ] **Step 3: Commit**

```bash
git add scripts/curate/inbox/darco-prime-waterfront-al-shati.json src/data/listings.json
git commit -m "darco prime: SEO title, project facts and a five-question FAQ from the developer sheet and brochure"
```

---

### Task 6: Built-site tests

**Files:**
- Modify: `test/seo-jsonld.test.mjs` (the FAQ test at ~line 299; append a new test block)

- [ ] **Step 1: Update the FAQ rule** — replace the first loop of `'FAQPage appears only on /faq/ and its questions are the visible ones'` with:

```js
  const listingFaqSlugs = new Set(listingsSource.filter((l) => Array.isArray(l.faq) && l.faq.length).map((l) => l.slug));
  for (const p of indexable) {
    const isFaq = /^(\/ar)?\/faq\/$/.test(p.route);
    const listingSlug = p.route.match(/^(?:\/ar)?\/properties\/([^/]+)\/$/)?.[1];
    const expected = isFaq || (listingSlug && listingFaqSlugs.has(listingSlug)) ? 1 : 0;
    assert.equal(nodesOf(p, 'FAQPage').length, expected, `${p.route}: FAQPage where ${expected ? 'expected' : 'no FAQ is visible'}`);
  }
```

and rename the test to `'FAQPage appears only where questions are visible (/faq/ and listings with an faq), matching them'`.

- [ ] **Step 2: Append the project-page test**

```js
// ---- project pages: unit sheet + listing FAQ (2026-10-02) -------------------------------------------

for (const [route, lang] of [['/properties/darco-prime-waterfront-al-shati/', 'en'], ['/ar/properties/darco-prime-waterfront-al-shati/', 'ar']]) {
  const slug = 'darco-prime-waterfront-al-shati';
  const src = listingsSource.find((l) => l.slug === slug);
  test(`${route}: seoTitle, units table, sheet note, and a separate FAQPage beside the ItemPage`, { skip: listingSkipReason(slug) ?? undefined }, () => {
    const p = requireBuiltListing(route);
    assert.ok(p.title.startsWith(src.seoTitle[lang]), `${route}: title "${p.title}" should start with the seoTitle`);
    assert.match(p.html, /data-project-details/, 'units block missing');
    const rows = [...p.html.matchAll(/<tr[^>]*>\s*<th scope="row"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));
    assert.ok(rows.length >= 4, `expected ≥3 type rows + total, got ${rows.length}`);
    assert.match(text(p.html.match(/<p[^>]*data-units-note[^>]*>([\s\S]*?)<\/p>/)[1]), lang === 'ar' ? /2026/ : /2 September 2026/);
    const url = `${SITE}${route}`;
    const [faq] = nodesOf(p, 'FAQPage');
    assert.equal(faq['@id'], `${url}#faq`);
    assert.ok(nodesOf(p, 'RealEstateListing').length === 1, 'listing node must survive');
    assert.ok((p.graph ?? []).some((n) => n['@id'] === url), 'page node (ItemPage) must keep the page @id');
    const visible = [...p.html.matchAll(/<section[^>]*data-listing-faq[\s\S]*?<\/section>/g)].flatMap((s) => [...s[0].matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => text(m[1])));
    assert.deepEqual(faq.mainEntity.map((q) => q.name), visible, 'FAQ JSON-LD must match the visible questions');
    assert.deepEqual(faq.mainEntity.map((q) => q.name), src.faq.map((it) => it.q[lang]));
  });
}

test('a listing without a unit sheet or faq has neither block', () => {
  const plain = listingsSource.find((l) => !l.faq && l.id !== 'BONA-W014');
  const p = requireBuiltListing(`/properties/${plain.slug}/`);
  assert.doesNotMatch(p.html, /data-project-details|data-listing-faq/);
  assert.equal(nodesOf(p, 'FAQPage').length, 0);
});
```

- [ ] **Step 3: Run the whole dist suite**

Run: `npm run build >/dev/null && npm run test:dist 2>&1 | tail -8`
Expected: all pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add test/seo-jsonld.test.mjs && git commit -m "test(dist): project page carries units table, sheet note and a #faq FAQPage that matches what is visible"
```

---

### Task 7: Full verification, visual check

- [ ] **Step 1:** `node scripts/curate/validate.mjs && node scripts/og/gen-llms.mjs && npx astro check | tail -2 && npm run build | tail -2 && npm run test:dist | tail -4 && npm test 2>&1 | tail -4`. Expected: everything green. (`npm test` = the scripts/test suite; it must stay as green as on `main`. Compare with `git stash; npm test; git stash pop` if anything fails.)
- [ ] **Step 2:** `npx astro preview --port 4329 &` then screenshot both locales at phone and desktop width with `node ~/.claude/scripts/browse.mjs http://localhost:4329/ar/properties/darco-prime-waterfront-al-shati/ ar.png` (start Chrome first: `~/.claude/scripts/chrome-debug.sh`). Check that the table fits a 390px viewport (it scrolls horizontally inside its own box, and the page doesn't), RTL column order is right, and the numbers read correctly. Kill the preview afterwards.
- [ ] **Step 3:** Commit any fix found.

### Task 8: Review and ship

- [ ] **Step 1:** Push the branch, open a PR (`gh pr create`) with a summary, the expected-figures table, and the test evidence.
- [ ] **Step 2:** Claude review (superpowers:code-reviewer subagent) **and** Codex review (`codex exec --skip-git-repo-check "<review prompt with git diff origin/main...HEAD>"`). Fix the findings, report both models' findings, and note where they disagree.
- [ ] **Step 3:** Wait for CI green on the final commit. Merge (squash). Record the rollback commit = the `origin/main` SHA before the merge.
- [ ] **Step 4:** After the Pages deploy finishes: `curl -s https://bona-real-estate.com/ar/properties/darco-prime-waterfront-al-shati/ | grep -c data-project-details` → 1; title check; JSON-LD parses with a FAQPage `#faq`. Ask Search Console to recrawl both URLs (`mcp__gsc__inspect_url`, or have the owner click Request indexing).
- [ ] **Step 5:** Update memory + the OpenSEO research log; notify the owner.
