# Intake unit models + Bona brochure (TK system) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The WhatsApp intake extracts every unit model (rooms, area, both printed prices, floor plan) from a developer brochure, the site shows them, and every listing gets a bilingual Bona brochure rebuilt from scratch in the TK design system.

**Architecture:** The model returns `models/amenities/nearby/warranties` in its JSON; the TAQEEM step confirms model prices per page (one call per page); the pipeline publishes floor-plan images and writes the new fields; a new WeasyPrint script `brochure_pdf.py` renders the brochure from the final listing + its published files (no developer page is reused). `run-once --enrich <id>` adds the new fields and brochure to listings already published, without touching their copy.

**Tech Stack:** Node 24 (node:test), Astro 5, Python via `uv run` (PyMuPDF, WeasyPrint 70, segno, Pillow).

**Spec:** `docs/superpowers/specs/2026-11-17-intake-brochure-and-unit-models-design.md` — read it first.
**Approved visual reference:** `/home/azoz778/bona-debug-w023/dirs/tk_style.py` and its output `4-tk-style.pdf` (owner-approved sample). The TK design system it follows: `~/.claude/skills/synced/*/tk-property-brochure/references/design-spec.md` + `scripts/build_brochure.py` (CSS block).

**Conventions (all tasks):** work in `/home/azoz778/bona-wt/brochure-models`. Run intake tests with `cd services/intake && run-capped node --test --test-concurrency=4 test/*.test.mjs`; site tests with `run-capped node --test --test-concurrency=4 scripts/test/*.test.mjs && node scripts/curate/validate.mjs`. Python only through `uv run --with … python -I` inside `run-capped`. Never write to `/tmp` beyond test temp dirs; never touch `~/bona`, `~/bona-bot`, WhatsApp, git remotes. Commit after each task with the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `services/intake/extract_pdf.py` (modify) | apply image soft masks; flatten transparent images onto white |
| `services/intake/lib/prompt.md` (modify) | contract text for `models`, `amenities`, `nearby`, `warranties` |
| `services/intake/lib/claude.mjs` (modify) | `validateAiResult` for the new fields; `copyProblems` over them; `confirmModelPrices()` (one call per page) |
| `services/intake/lib/model-prices.mjs` (create) | the model-price TAQEEM step + headline alignment (pure logic + injected confirm fn) |
| `services/intake/lib/images.mjs` (modify) | `writeFloorPlans()` → `plan-NN.jpg` + `plan-NN-thumb.webp` |
| `services/intake/lib/listing.mjs` (modify) | `buildListing` writes the new fields; `checkListing` uses shared rules |
| `scripts/curate/rules.mjs` (modify) | `modelsProblems(listing)`, `bilingualListProblems()` shared by intake + site validator |
| `scripts/curate/validate.mjs` (modify) | call the new rules |
| `src/lib/listings.ts`, `src/lib/i18n.ts` (modify) | types + strings |
| `src/components/UnitModels.astro` (create) | "Residences & prices" section |
| `src/components/pages/ListingPage.astro` (modify) | render `UnitModels` after highlights |
| `services/intake/brochure_pdf.py` (create) | the TK-system Bona brochure generator |
| `services/intake/assets/fonts/*` (create) | Cormorant Garamond 300/400, Montserrat 300/400/500, Amiri 400, Tajawal 300/400/500 (copied from the TK skill, OFL) |
| `services/intake/lib/brochure.mjs` (modify) | call `brochure_pdf.py` (listing JSON + files dir + site.json) instead of `rebrand_pdf.py` |
| `services/intake/lib/pipeline.mjs` (modify) | model-price step, floor plans, new brochure, `meta.enrich` |
| `services/intake/lib/edits.mjs` (modify) | `rebuildBrochure` from repo files only |
| `services/intake/run-once.mjs` (modify) | `--enrich <id>` |
| `services/intake/backfill-enrich.mjs` (create) | list/dry-run/run the backfill |
| `services/intake/rebrand_pdf.py` (delete) + its tests | replaced |
| `test/unit-models.test.mjs` (create) | dist test: every model row rendered |
| `src/data/LISTING-SCHEMA.md`, `services/intake/README.md` | docs |

---

### Task 1: Floor plans keep their transparency (extract_pdf.py)

**Files:** Modify `services/intake/extract_pdf.py` (the `for info in images:` loop, ~line 455); Test: `services/intake/test/extract-smask.test.mjs` (create)

- [ ] **Step 1: Write the failing test.** It builds a PDF whose only image is a transparent PNG (black RGB with an alpha mask), runs `extract_pdf.py`, and checks the extracted candidate's corner pixel is white.

```js
// services/intake/test/extract-smask.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'extract_pdf.py');
const UV = spawnSync('uv', ['--version']).status === 0;

const MAKE = `
import sys, fitz
from PIL import Image
import io
w, h = 900, 700
img = Image.new('RGBA', (w, h), (0, 0, 0, 0))            # fully transparent ...
for x in range(200, 700):
    for y in range(200, 500):
        img.putpixel((x, y), (120, 90, 60, 255))          # ... except a brown "plan" block
for x in range(0, w, 7):
    img.putpixel((x, 100), (10, 200, 30, 255))            # a few colours so it is not "flat art"
buf = io.BytesIO(); img.save(buf, 'PNG')
doc = fitz.open(); page = doc.new_page(width=842, height=595)
page.insert_image(page.rect, stream=buf.getvalue())
page.insert_text((40, 40), 'Floor plan 105.02 m2 apartment bedroom')
doc.save(sys.argv[1])
`;

describe('extract_pdf.py — transparent images', { skip: !UV && 'uv not installed' }, () => {
  it('flattens an image with a soft mask onto white instead of black', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-smask-'));
    try {
      const pdf = path.join(dir, 'plan.pdf');
      const mk = spawnSync('uv', ['run', '--with', 'pymupdf', '--with', 'pillow', 'python', '-I', '-c', MAKE, pdf], { encoding: 'utf8' });
      assert.equal(mk.status, 0, mk.stderr);
      const out = path.join(dir, 'out');
      const run = spawnSync('uv', ['run', '--with', 'pymupdf', 'python', '-I', SCRIPT, pdf, out, '--min-side', '300'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const res = JSON.parse(run.stdout.trim().split('\n').pop());
      assert.equal(res.candidates.length, 1);
      const probe = spawnSync('uv', ['run', '--with', 'pillow', 'python', '-I', '-c',
        'import sys; from PIL import Image; im = Image.open(sys.argv[1]).convert("RGB"); print(im.getpixel((5, 5)))', res.candidates[0].abs], { encoding: 'utf8' });
      assert.equal(probe.stdout.trim(), '(255, 255, 255)');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`(0, 0, 0)` instead of white): `cd services/intake && run-capped node --test test/extract-smask.test.mjs`

- [ ] **Step 3: Implement.** In the image loop, after `ext_img = doc.extract_image(xref)` and the usable/colour checks, when `info[1]` (the smask xref) is non-zero, composite the image over white with Pillow (C speed — never a Python per-pixel loop on a 9 MP image) and write PNG bytes instead of the raw stream:

```python
            smask = info[1]
            data, ext = ext_img["image"], (ext_img.get("ext") or "png").lower()
            if smask:
                try:
                    base = fitz.Pixmap(doc, xref)
                    if base.n - base.alpha >= 4:          # CMYK -> RGB first
                        base = fitz.Pixmap(fitz.csRGB, base)
                    rgba = fitz.Pixmap(base, fitz.Pixmap(doc, smask))   # RGB + alpha from the mask
                    im = Image.frombytes("RGBA", (rgba.width, rgba.height), rgba.samples)  # samples read ONCE
                    white = Image.new("RGBA", im.size, (255, 255, 255, 255))
                    white.alpha_composite(im)
                    buf = io.BytesIO(); white.convert("RGB").save(buf, "PNG")
                    data, ext = buf.getvalue(), "png"
                    base = rgba = im = white = None
                except Exception:
                    pass  # keep the raw stream: a black ground is better than no candidate
```

Add `from PIL import Image` and `import io` at the top of `extract_pdf.py`, and add Pillow to the extraction command default in `services/intake/lib/env.mjs` (`pyCmd`: `['uv','run','--with','pymupdf','--with','pillow','python']`) and to the test's `run` argv.

- [ ] **Step 4: Run the test — expect PASS.** Also run the whole intake suite (photo-regions tests use real extraction).
- [ ] **Step 5: Commit** `intake: extract transparent images on white (floor plans were black)`.

---

### Task 2: The AI contract for unit models and facts

**Files:** Modify `services/intake/lib/prompt.md`, `services/intake/lib/claude.mjs` (`validateAiResult`, `copyProblems`); Test: `services/intake/test/claude.test.mjs`

- [ ] **Step 1: Failing tests** in `claude.test.mjs` (`describe('validateAiResult')`), using the existing `clone()` helper:

```js
const MODEL = {
  name: { en: 'Nawras 2', ar: 'نورس 2' }, bedrooms: 3, bathrooms: 2, areaSqm: 105.02,
  rooms: { en: ['Laundry'], ar: ['غرفة غسيل'] },
  availability: { en: 'Buildings G–P, first to seventh floor', ar: 'المباني G–P، من الأول إلى السابع' },
  price: 419994, subsidisedPrice: 356024, evidence: { page: 10, quote: '419,994' }, floorPlan: 1,
};
it('accepts unit models and bilingual fact lists', () => {
  const r = clone();
  r.images[1].exclude = true; r.images[1].rank = null; r.images[1].room = 'render';
  r.models = [MODEL];
  r.amenities = { en: ['Health club'], ar: ['نادٍ صحي'] };
  r.nearby = { en: ['King Abdulaziz International Airport'], ar: ['مطار الملك عبدالعزيز الدولي'] };
  r.warranties = { en: ['Structure — 10 years'], ar: ['الهيكل الإنشائي — 10 سنوات'] };
  assert.deepEqual(validateAiResult(r, { candidateCount: 2 }), []);
});
for (const [label, mutate, re] of [
  ['a model with no Arabic name', (m) => { m.name.ar = 'Nawras'; }, /models\[0\]\.name/],
  ['a model price with no evidence', (m) => { m.evidence = null; }, /models\[0\]\.evidence/],
  ['a negative area', (m) => { m.areaSqm = -1; }, /models\[0\]\.areaSqm/],
  ['a subsidised price above the price', (m) => { m.subsidisedPrice = 500000; }, /models\[0\]\.subsidisedPrice/],
  ['rooms lists of different lengths', (m) => { m.rooms.ar = []; }, /models\[0\]\.rooms/],
  ['a floor plan that is a gallery photo', (m) => { m.floorPlan = 0; }, /models\[0\]\.floorPlan/],
]) {
  it(`refuses ${label}`, () => {
    const r = clone();
    r.images[1].exclude = true; r.images[1].rank = null; r.images[1].room = 'render';
    const m = structuredClone(MODEL); mutate(m); r.models = [m];
    assert.ok(validateAiResult(r, { candidateCount: 2 }).some((p) => re.test(p)));
  });
}
it('refuses fact lists of different lengths', () => {
  const r = clone(); r.amenities = { en: ['Gym', 'Pool'], ar: ['نادٍ'] };
  assert.ok(validateAiResult(r, { candidateCount: 2 }).some((p) => /amenities/.test(p)));
});
```

and in `describe('copyProblems')`: a model name containing a phone number and an amenity containing `SAR 319,015` are both reported (`copyProblems(listing, ai)` — see Step 3 signature).

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
  - `prompt.md`: add the four fields to the output schema exactly as in spec §1 (with the comment lines), plus a "### Unit models" rule block: one entry per layout/model the brochure prints with its own area or price; never invent a model; `price`/`subsidisedPrice` only as printed (same TAQEEM rule) and then `evidence {page, quote}` is required; `floorPlan` = the candidate index of that model's floor plan (that candidate stays `exclude: true`); `rooms` = other rooms printed for the model (bilingual, same length); `availability` = buildings/floors exactly as printed or null; amenities/nearby/warranties = short noun phrases (2–8 words) as printed, Arabic as real Arabic, same counts; when `models` carry prices, `price.amount` is the lowest model `price` with `from: true` and `price.subsidisedAmount` the lowest `subsidisedPrice`.
  - `claude.mjs` `validateAiResult`: optional `models` (array ≤ 24); per model: `isPair(name)`; `bedrooms/bathrooms` null or integer 0–20; `areaSqm` null or number 10–100000; `rooms` null or `{en[], ar[]}` equal length, strings, ar Arabic; `availability` null or `isPair`; `price`/`subsidisedPrice` null or number > 0, subsidised < price when both; if either price set, `evidence` must be `{page ≥ 1 int, quote str}`; `floorPlan` null or an integer index whose `result.images` entry has `exclude: true`, used by at most one model. Optional `amenities` (≤16), `nearby` (≤8), `warranties` (≤8): `{en[], ar[]}` equal length, non-empty strings, ar Arabic. Messages start with the field path (`models[0].name …`, `amenities …`).
  - `copyProblems(listing, ai = {})`: also scan `ai.models[*].name/rooms/availability` and the three fact lists with the same FORBIDDEN / hype / `PRICE_IN_COPY_RE` rules (prices belong in `price` fields only). Update the call in `runListingAi` to pass `result`.
- [ ] **Step 4: Run — expect PASS** (whole intake suite).
- [ ] **Step 5: Commit** `intake: AI contract for unit models, amenities, nearby, warranties`.

---

### Task 3: TAQEEM for model prices, one confirmation per page, headline aligned

**Files:** Create `services/intake/lib/model-prices.mjs`; Modify `services/intake/lib/claude.mjs` (add `confirmModelPrices`), `services/intake/lib/pipeline.mjs` (call it in stage `price`, before the existing headline checks); Test: `services/intake/test/model-prices.test.mjs` (create), plus 2 end-to-end cases in `test/price-pages.test.mjs`.

- [ ] **Step 1: Failing unit tests** (pure logic, confirm function injected):

```js
// services/intake/test/model-prices.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkModelPrices, alignHeadline } from '../lib/model-prices.mjs';

const pages = [{ page: 9, abs: '/x/p9.jpg' }, { page: 10, abs: '/x/p10.jpg' }];
const M = (name, price, sub, page) => ({ name: { en: name, ar: name }, price, subsidisedPrice: sub, evidence: page ? { page, quote: String(price) } : null });

describe('checkModelPrices', () => {
  it('confirms all figures of one page in ONE call and nulls the refused ones', async () => {
    const calls = [];
    const confirm = async ({ page, items }) => { calls.push(page); return items.map((it) => ({ ...it, price: it.price !== 999, subsidisedPrice: true })); };
    const models = [M('A', 319015, 270425, 9), M('B', 999, null, 9), M('C', 419994, 356024, 10)];
    const res = await checkModelPrices(models, { plainText: '', pageImages: pages, pageText: [], confirm });
    assert.deepEqual(calls.sort(), [10, 9].sort());                  // one call per page
    assert.equal(res.models[1].price, null);                          // refused -> null
    assert.equal(res.models[0].price, 319015);
    assert.deepEqual(res.refused, [999]);
  });
  it('accepts a headline-type figure from the plain text without a call; never a subsidised one', async () => {
    let n = 0; const confirm = async ({ items }) => { n += 1; return items.map((it) => ({ ...it, price: false, subsidisedPrice: false })); };
    const res = await checkModelPrices([M('A', 319015, 270425, 9)], { plainText: 'Lulu 2 319,015 SAR', pageImages: pages, pageText: [], confirm });
    assert.equal(res.models[0].price, 319015);
    assert.equal(res.models[0].subsidisedPrice, null);
    assert.equal(n, 1);
  });
  it('a figure whose page was not rendered and is not in the text is refused', async () => {
    const res = await checkModelPrices([M('A', 319015, null, 4)], { plainText: '', pageImages: pages, pageText: [], confirm: async () => [] });
    assert.equal(res.models[0].price, null);
  });
});

describe('alignHeadline', () => {
  it('sets the headline from the lowest confirmed model prices', () => {
    const price = { amount: 1, currency: 'SAR', from: false, period: null, onRequest: true };
    alignHeadline(price, [M('A', 419994, 356024), M('B', 319015, 270425), M('C', null, null)]);
    assert.deepEqual(price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 });
  });
  it('leaves the headline alone when no model kept a price', () => {
    const price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
    alignHeadline(price, [M('A', null, null)]);
    assert.equal(price.onRequest, true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).
- [ ] **Step 3: Implement `model-prices.mjs`:**

```js
// The TAQEEM rule for unit-model prices: a figure is published only when it is printed — in the
// plain (non-subsidy) text layer for a regular price, or confirmed on its page image by a second
// model. One confirmation call per page, whatever the number of models on it.
import { priceAppearsIn } from './price.mjs';

/**
 * @param {Array} models  ai.models (mutated copy returned)
 * @param {{plainText:string, pageImages:Array<{page:number,abs:string}>, pageText:string[],
 *          confirm:(arg:{page:number, abs:string, items:Array<{i:number,name:object,price:number|null,subsidisedPrice:number|null}>})=>Promise<Array<{i:number,price:boolean,subsidisedPrice:boolean}>>}} ctx
 * @returns {Promise<{models:Array, refused:number[], calls:number}>}
 */
export async function checkModelPrices(models, { plainText, pageImages, pageText, confirm }) {
  const out = structuredClone(models ?? []);
  const refused = [];
  const byPage = new Map();
  for (const [i, m] of out.entries()) {
    const wantsPrice = typeof m.price === 'number' && m.price > 0;
    const wantsSub = typeof m.subsidisedPrice === 'number' && m.subsidisedPrice > 0;
    if (!wantsPrice && !wantsSub) continue;
    const priceInText = wantsPrice && priceAppearsIn(plainText, m.price);
    const needs = { i, name: m.name, price: wantsPrice && !priceInText ? m.price : null, subsidisedPrice: wantsSub ? m.subsidisedPrice : null };
    if (needs.price === null && needs.subsidisedPrice === null) continue;
    const cited = m.evidence && pageImages.some((p) => p.page === m.evidence.page) ? m.evidence.page
      : (pageImages.find((p) => [needs.price, needs.subsidisedPrice].some((v) => v && priceAppearsIn(pageText[p.page - 1] ?? '', v)))?.page ?? null);
    if (cited === null) {
      if (needs.price !== null) { refused.push(m.price); m.price = null; }
      if (needs.subsidisedPrice !== null) { refused.push(m.subsidisedPrice); m.subsidisedPrice = null; }
      continue;
    }
    if (!byPage.has(cited)) byPage.set(cited, []);
    byPage.get(cited).push(needs);
  }
  let calls = 0;
  for (const [page, items] of byPage) {
    const abs = pageImages.find((p) => p.page === page).abs;
    calls += 1;
    let answers = [];
    try { answers = await confirm({ page, abs, items }); } catch { answers = []; }
    for (const it of items) {
      const a = answers.find((x) => x.i === it.i) ?? { price: false, subsidisedPrice: false };
      const m = out[it.i];
      if (it.price !== null && a.price !== true) { refused.push(m.price); m.price = null; }
      if (it.subsidisedPrice !== null && a.subsidisedPrice !== true) { refused.push(m.subsidisedPrice); m.subsidisedPrice = null; }
    }
  }
  for (const m of out) if (m.subsidisedPrice !== null && (m.price === null || m.subsidisedPrice >= m.price)) { refused.push(m.subsidisedPrice); m.subsidisedPrice = null; }
  return { models: out, refused, calls };
}

/** Headline = the lowest confirmed model figures (both printed). Mutates `price`. */
export function alignHeadline(price, models) {
  const prices = (models ?? []).map((m) => m.price).filter((v) => typeof v === 'number' && v > 0);
  if (!prices.length) return price;
  const subs = (models ?? []).map((m) => m.subsidisedPrice).filter((v) => typeof v === 'number' && v > 0);
  price.amount = Math.min(...prices);
  price.from = true;
  price.onRequest = false;
  price.period = null;
  if (subs.length && Math.min(...subs) < price.amount) price.subsidisedAmount = Math.min(...subs);
  else delete price.subsidisedAmount;
  return price;
}
```

  - `claude.mjs` `confirmModelPrices({ pageImage, items, currency, bin, model, cwd, addDirs, settingsPath })`: one `runClaudeOnce` prompt: "Read the page image … For each numbered model below, answer whether the page VISIBLY PRINTS its price (the regular price, for everyone) and its subsidised price (for housing-subsidy beneficiaries, 'لمستفيدي الدعم'), for THAT model. A figure for another model does not count. Answer `[{\"i\":0,\"price\":true|false,\"subsidisedPrice\":true|false}, …]` and nothing else." The model names go inside `fence('the models and figures to check', …)`. Returns the parsed array, or `[]` on error.
  - `pipeline.mjs` stage `price`: when `ai.models?.length` and no `caption.price`: `const mp = await checkModelPrices(ai.models, { plainText, pageImages, pageText, confirm: ({abs, items}) => confirmModelPrices({ pageImage: abs, items, currency: price.currency, bin: cfg.claudeBin, model: cfg.claudeModel, cwd: workDir, addDirs: [workDir], settingsPath: confinement.file }) })`; `ai.models = mp.models`; push `mp.refused` into `rejectedPrices`; if any model kept a price → `alignHeadline(price, ai.models)` and mark the headline (and Sakani) as already evidenced (skip their own checks); log `intake.model_prices` `{models, calls, refused: mp.refused.length}`; add warning code `model-price-not-printed` when anything was refused. Under `caption.price`: set every model `price/subsidisedPrice` to null and push the non-null ones into `rejectedPrices` only if they appear in the copy (existing `inCopy` rule). Add `'model-price-not-printed'` to `WARNING_CODES`.
- [ ] **Step 4: E2E cases** in `test/price-pages.test.mjs` (reuse `rig`; extend `FAKE_CLAUDE` to answer the model-confirm prompt — detect `'For each numbered model'` and return `cfg.modelConfirm` (default all true)): (a) two models on scrambled page 3 → one model-confirm call → listingPreview.models has both prices and `price` = lowest; (b) `modelConfirm` refuses one model's price → that model's `price` null, headline from the other.
- [ ] **Step 5: Run — expect PASS. Commit** `intake: TAQEEM for unit-model prices (one check per page), headline from the lowest model`.

---

### Task 4: Floor-plan files and the listing fields

**Files:** Modify `services/intake/lib/images.mjs` (`writeFloorPlans`), `services/intake/lib/listing.mjs` (`buildListing`, `checkListing`), `scripts/curate/rules.mjs` (`modelsProblems`, `bilingualListProblems`), `scripts/curate/validate.mjs`, `services/intake/lib/pipeline.mjs` (write plans in stage `write`, pass to `buildListing`); Tests: `test/listing.test.mjs`, `test/price-pages.test.mjs` (publish case).

Listing shape (site):

```jsonc
"models": [ { "name": {en,ar}, "bedrooms": 3, "bathrooms": 2, "areaSqm": 105.02,
              "rooms": {en:[],ar:[]} | null, "availability": {en,ar} | null,
              "price": 419994 | null, "subsidisedPrice": 356024 | null,
              "floorPlan": { "src": "/listings/<slug>/plan-02.jpg", "thumb": "/listings/<slug>/plan-02-thumb.webp" } | null } ],
"amenities": {en:[],ar:[]}, "nearby": {en:[],ar:[]}, "warranties": {en:[],ar:[]}      // each optional
```

- [ ] **Step 1: Failing tests** (`listing.test.mjs`): `buildListing` with `ai.models` (2 models, one plan) + `floorPlans: [{ model: 0, src, thumb }]` writes `models[0].floorPlan = {src, thumb}`, `models[1].floorPlan = null`, drops `evidence` (never published); omits `models` when empty; `checkListing` refuses (`modelsProblems`): a model price that is not `> 0`, a Sakani ≥ price, a floorPlan src outside `/listings/<slug>/plan-NN.jpg`, a headline `price.amount` ≠ the lowest model price when any model has a price, bilingual lists of unequal length. `rules.mjs` exports `LOCAL_PLAN_SRC = /^\/listings\/[a-z0-9]+(?:-[a-z0-9]+)*\/plan-\d{2,3}\.jpg$/`, `LOCAL_PLAN_THUMB` likewise `-thumb.webp`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `writeFloorPlans(candidates, models, outDir, slug)` in `images.mjs` with sharp: for each model with a `floorPlan` index → `plan-NN.jpg` (flatten `{background:'#ffffff'}`, resize inside 1600, JPEG q85 mozjpeg) + `plan-NN-thumb.webp` (inside 480, q78); returns `[{ model, src, thumb, file, thumbFile }]`; skips undecodable ones (logged). `buildListing({ …, floorPlans })` writes the shape above (copy only validated fields; `evidence` never). `rules.mjs` `modelsProblems(listing)` + `bilingualListProblems(obj, field, max)`; `checkListing` and `validate.mjs` call them (validate: `for (const m of modelsProblems(l)) err(id, m)`). Pipeline: in stage `write` after `writeListingImages`, `const plans = await writeFloorPlans(extraction.candidates, ai.models ?? [], stageDir, slug)`; dry run: `plans` = computed src paths without writing.
- [ ] **Step 4: Run all intake + site tests — PASS. Commit** `intake: publish unit models with floor plans; shared validators`.

---

### Task 5: "Residences & prices" on the website

**Files:** Create `src/components/UnitModels.astro`, `test/unit-models.test.mjs`; Modify `src/lib/listings.ts` (types), `src/lib/i18n.ts` (strings), `src/components/pages/ListingPage.astro` (after the highlights section, before `<ProjectDetails>`).

- [ ] **Step 1: Types + strings.** `Listing.models?: { name: Localised; bedrooms?: number|null; bathrooms?: number|null; areaSqm?: number|null; rooms?: {en:string[];ar:string[]}|null; availability?: Localised|null; price?: number|null; subsidisedPrice?: number|null; floorPlan?: {src:string;thumb?:string|null}|null }[]`; `amenities?/nearby?/warranties?: {en:string[];ar:string[]}`. `ui` strings (EN / AR): `residencesPrices` "Residences & prices" / "النماذج والأسعار"; `layoutCol` "Layout" / "النموذج"; `bedroomsCol` "Bedrooms" / "غرف النوم"; `bathroomsCol` "Bathrooms" / "دورات المياه"; `areaCol` "Area" / "المساحة"; `priceCol` "Price" / "السعر"; `sakaniCol` "Sakani price" / "سعر مستفيدي الدعم"; `planCol` "Plan" / "المخطط"; `viewPlan` "View plan" / "عرض المخطط"; `onRequestShort` "On request" / "عند الطلب"; `modelsNote` "Prices as printed in the developer's brochure. The Sakani price applies to housing-support beneficiaries." / "الأسعار كما وردت في كتيب المطوّر، وسعر مستفيدي الدعم لمستفيدي برنامج سكني."; `amenitiesHeading` "Amenities" / "المرافق"; `nearbyHeading` "Nearby" / "بالقرب"; `warrantiesHeading` "Warranties" / "الضمانات".
- [ ] **Step 2: Component** `UnitModels.astro` (props `listing`, `locale`): renders nothing when `!l.models?.length`. Desktop (`md:` and up): `<table>` with columns Layout | Bedrooms | Bathrooms | Area (`formatNumber` + " m²" / " م²", `dir="ltr"`) | Price (`formatPrice({amount, currency: l.price.currency}, locale)` or `onRequestShort`) | Sakani (column only if any model has one) | Plan (thumbnail `<a href={src} target="_blank" rel="noopener">` with `<img src={thumb ?? src} loading="lazy" style="object-fit:contain">`, label `viewPlan`). Mobile: the same rows as stacked `<article>` cards (name, "3 bedrooms · 2 bathrooms · 105.02 m²", rooms line, prices, plan link). Then the note, then three small lists (amenities, nearby, warranties) when present. Section id `residences`, `data-unit-models`, each row `data-model-row`. Styling: existing tokens (`label`, `text-stone-2`, `border-ink/10`), same look as `ProjectDetails.astro`.
- [ ] **Step 3: Page.** In `ListingPage.astro` import and render `<UnitModels listing={l} locale={locale} class="mt-14" />` right after the highlights `</section>` block.
- [ ] **Step 4: Dist test** `test/unit-models.test.mjs`: read `src/data/listings.json`; for every listing with `models`, read `dist/properties/<slug>/index.html` and `dist/ar/properties/<slug>/index.html`; assert `data-unit-models` present and the count of `data-model-row` equals `models.length` (×2 when both table and cards render — count the table rows only: `data-model-row="table"`). With no listing carrying models yet, the test passes vacuously — that is expected until the enrich run.
- [ ] **Step 5: Verify visually** with temporary data: put W023's 8 models (from `/home/azoz778/bona-debug-w023/dirs/tk_style.py` list `M`) into the worktree `src/data/listings.json` (do NOT commit), `run-capped npx astro build`, `npx astro preview --port 4391 --host 127.0.0.1` in the background, screenshot EN desktop and AR mobile with `node /home/azoz778/bona-debug-w023/cdp-shot.mjs <url> <out.jpg> 1440 1100` / `390 1500`, look at both, then `git checkout -- src/data/listings.json` and stop the preview (`pkill -f '[a]stro preview --port 4391'`). Run `node --test test/unit-models.test.mjs` against that build before reverting (it must find 8 rows ×2 locales).
- [ ] **Step 6: Commit** `site: Residences & prices — every unit model with floor plan and both prices`.

---

### Task 6: The brochure generator (`brochure_pdf.py`, TK system)

**Files:** Create `services/intake/brochure_pdf.py`, `services/intake/assets/fonts/` (copy the 9 TTFs from `~/.claude/skills/synced/*/tk-property-brochure/assets/fonts/` — they are OFL), `services/intake/test/brochure-pdf.test.mjs`.

CLI: `uv run --with weasyprint --with segno --with pillow --with pymupdf python -I brochure_pdf.py <listing.json> <files-dir> <site.json> <out.pdf> [--max-mb 25]` → one JSON line `{ok, out, bytes, pages, steps}` or `{ok:false, reason, error}` (exit 1). `files-dir` holds `01.jpg…` and `plan-NN.jpg` (the staged or published listing folder). Paths in the listing (`/listings/<slug>/02.jpg`) map to `files-dir/<basename>`.

- [ ] **Step 1: Failing test** (skip without uv): build a fixture listing (W023-like: title, district, description 4 paragraphs EN/AR, highlights, price with Sakani, project+developer, 2 models with plans, amenities/nearby/warranties, 4 photos with focus) + generated JPEGs (Pillow solid colours) in a temp dir; run the script; then with PyMuPDF (`uv run --with pymupdf python -I -c …`) read every page's text and assert: page count = 1 flysheet + 1 cover + ≥1 narrative + 1 residences + 2 model pages + ≥1 photo page + 1 amenities + 1 location; text contains both model names in EN and AR, `SAR 319,015`, `SAR 270,425`, `Developer`, the listing URL, `FAL`, the hours from site.json; text contains none of: `Araco Sales`, `araco-sa.com`, `920032546`, `NHC`-only logos are images so assert no image smaller than 40×40 px other than the QR and our logo (logo is SVG → vector, so assert image count = photos + plans + 0 extra). Size < 6 MB.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** by turning the approved sample into a data-driven builder:
  - Start from `/home/azoz778/bona-debug-w023/dirs/tk_style.py` (copy into place, then refactor). Keep the TK CSS verbatim (copy the `CSS = """…"""` block from the skill's `scripts/build_brochure.py` into the file — no runtime dependency on the skill) and the `EXTRA` CSS from the sample.
  - Fonts from `services/intake/assets/fonts/` via `@font-face file://` URLs. Logo: read `public/logo.svg` (repo root resolved from the script path), recolour every fill/stroke to `#000000` / `#ffffff` (ALSO the champagne hairline — black & white only), write both to the work dir.
  - Pages exactly as spec §5, builders: `flysheet()`, `cover()`, `narrative()` (split paragraphs across pages: measure by character budget — EN ≤ 1700 chars and AR ≤ 1500 chars per page beside the ledger; overflow → a continuation page without ledger), `residences()` (≤ 10 rows/page), `model_page(m)` per model with a plan, `photo_pages()` (hero + pair; leftovers as quad/pair), `amenities()` (omit when all lists empty), `location()` (QR → listing URL via segno; Maps button only when `listing.map` and `mapPrecision == 'exact'`, else "View on bona-real-estate.com"; facts: district+city, nearby (first 3 joined), reference `<id> · FAL <licence>`; enquiry block from site.json phone/email/hours + FAL from `site.json.licences` / `advertiser`). Footer on every inner page: black logo + `<city> · <nn>`.
  - Ledger for a single property: from `specs` (beds, baths, areaSqm, plotSqm, floors, yearBuilt; up to 6 non-null). For a project with models: models count, bedroom range, bathroom range, smallest/largest area, plus warranty years when a warranty starts with a number.
  - Captions: room key → bilingual label table (reuse the alt-text room labels: read `scripts/curate/rooms.mjs` ROOMS via a small JSON dump passed in by `brochure.mjs`, or duplicate a 15-entry dict); add "Illustrative" / "صورة توضيحية" when `listing.project` is set (developer renders).
  - Digits: Western everywhere; numbers formatted `f"{v:,.0f}"`, areas `f"{v:.2f}"` trimmed of `.00`.
  - Images: downsample to ~300dpi of the printed box with Pillow (hero 2100px, half 1400px, cover 2400px, plan 1800px), JPEG q86, into the work dir; cover uses `background-position` from `focus`.
  - Escape every listing string with `html.escape` (copy passed validation, but this is HTML).
  - Size: if > `--max-mb`, re-render with images at 75% then 55% size; still too big → `{ok:false, reason:'too-large'}` and delete the output.
- [ ] **Step 4: Run test — PASS.** Render the fixture and W023 (from the replace-run listing JSON + `~/bona-bot/public/listings/<slug>/` files + the floor plans in `/home/azoz778/bona-debug-w023/dirs/assets/plan*.jpg` copied as `plan-0N.jpg`) and LOOK at every page (rasterise with PyMuPDF, read the JPGs). Fix overflow/alignment until clean.
- [ ] **Step 5: Commit** `intake: Bona brochure rebuilt from scratch in the TK design system (brochure_pdf.py)`.

---

### Task 7: Wire the new brochure everywhere; retire rebrand_pdf.py

**Files:** Modify `services/intake/lib/brochure.mjs`, `services/intake/lib/env.mjs` (`brochurePyCmd` default `['uv','run','--with','weasyprint','--with','segno','--with','pillow','--with','pymupdf','python']`), `services/intake/lib/pipeline.mjs` (stage `brochure`), `services/intake/lib/edits.mjs` (`rebuildBrochure`); Delete `services/intake/rebrand_pdf.py`, `services/intake/rebrand-once.mjs` (if it only wraps rebrand); Update `test/brochure.test.mjs`.

- [ ] **Step 1: Tests** (`brochure.test.mjs`): `buildBrandedBrochure({ listing, filesDir, outPath, workDir, cfg })` spawns `brochure_pdf.py` with `[listingJson, filesDir, siteJson, outPath, '--max-mb', N]` (assert via an injected `spawnImpl` fake that captures argv and returns `{ok:true,…}`); writes the listing JSON (without `_intake`) to `workDir/brochure-listing.json`; `rebuildBrochure(repo, id, { cfg, workDir })` uses `public/listings/<slug>` as `filesDir` and no longer needs the source PDF (a listing whose source PDF is gone still gets a brochure). Remove the rebrand-specific tests (`brochureFacts` scrub etc. stay only if still used).
- [ ] **Step 2: FAIL → implement → PASS.** Pipeline: `buildBrandedBrochure({ listing, filesDir: stageDir, outPath: brochureFileIn(stageDir), workDir, cfg })` after floor plans are staged. `brochure <id>` reply text unchanged.
- [ ] **Step 3: Commit** `intake: publish the new brochure on every run and on 'brochure <id>'; retire rebrand_pdf.py`.

---

### Task 8: `run-once --enrich <id>` (backfill without touching hand-corrected copy)

**Files:** Modify `services/intake/lib/pipeline.mjs` (`meta.enrich`), `services/intake/lib/listing.mjs` (`enrichMetaFor(repo, id)`, `mergeEnrichment(existing, built)`), `services/intake/run-once.mjs`; Tests: `test/price-pages.test.mjs` (git rig) + `test/listing.test.mjs`.

Behaviour: like `--replace` up to the listing build, then instead of writing the new listing it **merges** into the existing inbox JSON only: `models`, `amenities`, `nearby`, `warranties`, `brochureUrl`; copies only `plan-*.jpg|webp` + `brochure.pdf` into `public/listings/<slug>/` (old `plan-*` files removed first; photos untouched); the brochure is built from the MERGED listing with `filesDir` = the repo folder + staged plans. Refusals: no inbox listing; withdrawn; dirty clone (run-once, as `--replace`); the model's headline (lowest model price, or `price.amount`) differs from the existing `price.amount` while the existing price is not on request → refuse with both figures ("send `price <id> …` first or re-run with --replace"); `--no-git` without `--dry-run`. No history rule (copy is not rewritten). Commit message `intake: enrich <title> (<id>) — unit models + brochure`. Existing `price`, `title`, `description`, `highlights`, `images`, `location`, `project`, `licence`, `videos`, `photoNote`, `faq`, `seoTitle` are byte-identical after enrich (test asserts this on a fixture with all of them).

- [ ] **Step 1: Failing tests** for `mergeEnrichment` (only the five fields change), `enrichMetaFor` refusals, and an end-to-end git-rig run (`meta.enrich`) asserting the old photo files are untouched, `plan-*.jpg` written, inbox JSON has models, other fields identical.
- [ ] **Step 2: FAIL → implement → PASS.**
- [ ] **Step 3: Commit** `intake: run-once --enrich adds unit models + the new brochure to a published listing`.

---

### Task 9: Backfill script

**Files:** Create `services/intake/backfill-enrich.mjs`; Test: `test/backfill.test.mjs` (pure planning function).

`node services/intake/backfill-enrich.mjs [--repo ~/bona-bot] [--dry-run] [--only BONA-W002,BONA-W010]`: lists inbox listings (skip hidden, withdrawn, `videos`-free rule does not apply), finds each source PDF with `findSourcePdf(cfg.intakeDir, _intake.pdfSha256)`, prints a plan table (id · title · source found? · action: `enrich` | `brochure-only`), and without `--dry-run` runs `run-once.mjs <pdf> --enrich <id>` sequentially as a child process (stdout to `~/bona-data/intake/backfill/<id>.log`), stopping on the first FAILED (not on REJECTED/refused — those are reported and skipped). Listings with no source PDF → `brochure <id>` path via `edits.rebuildBrochure` + commit (`intake: rebuild brochure <id>`). Summary at the end.

- [ ] **Step 1: Test `planBackfill(listings, findPdf)`** → actions as above. **Step 2: implement. Step 3: commit** `intake: backfill script for unit models + new brochures`.

---

### Task 10: Docs

**Files:** `src/data/LISTING-SCHEMA.md` (new fields), `services/intake/README.md` (models, TAQEEM per page, brochure_pdf.py, --enrich, backfill, extraction fix). Commit `docs: unit models, new brochure, enrich + backfill`.

---

### Task 11: Real dry runs, then the two-model review

- [ ] `run-capped node services/intake/run-once.mjs <W023 pdf> --dry-run --repo <worktree> --model opus --work ~/bona-debug-w023/enrich-dry` — check models (8, both prices each, 8 plans), the confirm calls (≤ 8 pages → ≤ 8 calls), the brochure (rasterise and look at every page).
- [ ] Same for one single-property brochure from the inbox (e.g. the source of BONA-W022).
- [ ] Claude review (superpowers:code-reviewer subagent) and Codex (`codex exec … < /dev/null`) in parallel on the branch diff; fix → re-review until both SHIP.
