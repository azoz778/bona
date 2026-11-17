// Prices the text layer cannot read (owner's Jeddah Heights brochure, 2026-11-17): the PDF's font
// maps its digits to letters, so the page shows 270,425 and the text layer says "DIB,FDG". The
// pages that talk about a price are rendered for the model to read, and every number it reads off
// them still has to be confirmed on the page before it is published.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hasSubsidyWording, pageNeedsPriceRender, pricePagesToRender, MAX_PRICE_PAGES } from '../lib/price-pages.mjs';
import { execFileSync } from 'node:child_process';
import { checkListing } from '../lib/listing.mjs';
import { processPdf } from '../lib/pipeline.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Verbatim from the brochure's text layer: Arabic presentation forms + the scrambled digits.
const PRICE_PAGE = [
  'اﻟﺴﻌﺮ ﳌﺴﺘﻔﻴﺪي اﻟﺪﻋﻢ', // السعر لمستفيدي الدعم
  'DIB,FDG ',
  'اﻟﺴﻌﺮ ﻟﻐﲑ ﻣﺴﺘﻔﻴﺪي اﻟﺪﻋﻢ', // السعر لغير مستفيدي الدعم
  'ECK,BCG',
].join('\n');
const LOCATION_PAGE = [
  'دﻗﺎﺋﻖ BH', // دقائق 17 — scrambled, but not a price
  'ﻣﺪﻳﻨﺔ اﳌﻠﻚ ﻋﺒﺪﷲ اﻟﺮﻳﺎﺿﻴﺔ',
].join('\n');

describe('pageNeedsPriceRender', () => {
  it('flags a price page whose digits are scrambled into letters', () => {
    assert.equal(pageNeedsPriceRender(PRICE_PAGE), true);
  });
  it('leaves a page with no price word alone, scrambled numbers or not', () => {
    assert.equal(pageNeedsPriceRender(LOCATION_PAGE), false);
    assert.equal(pageNeedsPriceRender('Five-bedroom villa, 450 sqm, sea view'), false);
  });
  it('leaves a price page alone when its price is readable', () => {
    assert.equal(pageNeedsPriceRender('السعر 1,250,000 ريال'), false);
    assert.equal(pageNeedsPriceRender('Price: SAR 4500000'), false);
    assert.equal(pageNeedsPriceRender('السعر ١٬٢٥٠٬٠٠٠ ريال'), false); // Arabic-Indic digits are readable
  });
  it('flags a price page that has no price-sized number at all', () => {
    assert.equal(pageNeedsPriceRender('الأسعار\nغرفة نوم 02\nدورة مياه 01'), true);
    assert.equal(pageNeedsPriceRender('Prices — see the table'), true);
  });
  it('a scrambled price wins over an unrelated readable number on the same page', () => {
    assert.equal(pageNeedsPriceRender(`${PRICE_PAGE}\n920032546`), true);
  });
  it('a phone number next to the price word does not make an unseparated scrambled price readable', () => {
    assert.equal(pageNeedsPriceRender('السعر\nDIBFDG\nللتواصل 920032546'), true);
  });
  it('a figure far from the price word does not count for it', () => {
    assert.equal(pageNeedsPriceRender('السعر\nDIBFDG\n.\n.\n.\n.\nالمساحة 1,250 م²'), true);
  });
  it('knows other ways a price is labelled', () => {
    assert.equal(pageNeedsPriceRender('قيمة الوحدة DIB,FDG'), true);
    assert.equal(pageNeedsPriceRender('SR DIB,FDG'), true);
  });
  it('every price line needs its own readable figure', () => {
    assert.equal(pageNeedsPriceRender('السعر 1,250,000 ريال\n.\n.\n.\n.\n.\nسعر الدفعة الأولى\nKLMNOP'), true);
  });
  it('knows the other ways a brochure says "subsidised"', () => {
    for (const t of ['السعر قبل الدعم 350,000 ريال', 'السعر بعد الدعم 270,425 ريال', 'السعر مع الدعم 270,425', 'سعر الوحدة المدعومة 270,425', 'Price after support SAR 270,425', 'Price for beneficiaries SAR 270,425']) {
      assert.equal(pageNeedsPriceRender(t), true, t);
    }
  });
  it('a Sakani logo with no price on the page is not a price page', () => {
    assert.equal(pageNeedsPriceRender('بالشراكة مع منصة سكني\nIn partnership with Sakani'), false);
  });
  it('round-3 cases: tables without a price word, wrapped labels, decimals, other labels', () => {
    assert.equal(pageNeedsPriceRender('لمستفيدي الدعم\n270,425\nلغير مستفيدي الدعم\n319,015'), true, 'a subsidy table needs no price word');
    assert.equal(pageNeedsPriceRender('قيمة\nالوحدة\nDIB,FDG'), true, 'a label wrapped over two lines');
    assert.equal(pageNeedsPriceRender('السعر\nDIBFDG\nالمساحة 123.456 م²'), true, 'a three-decimal area is not a price');
    assert.equal(pageNeedsPriceRender('القيمة البيعية DIB,FDG'), true);
    assert.equal(pageNeedsPriceRender('ثمن الوحدة\nDIBFDG'), true);
    assert.equal(pageNeedsPriceRender('المستحقين للدعم السكني 270,425'), true);
  });
  it('a VAT line is not a price word, and a spaced phone number is not a readable price', () => {
    assert.equal(pageNeedsPriceRender('ضريبة القيمة المضافة 15%'), false);
    assert.equal(pageNeedsPriceRender('السعر\nDIBFDG\nجوال 0555 123 456'), true);
  });
  it('always renders a page that prints prices for subsidy beneficiaries, readable or not', () => {
    assert.equal(pageNeedsPriceRender('السعر لمستفيدي الدعم 270,425 ريال\nالسعر لغير مستفيدي الدعم 319,015 ريال'), true);
    assert.equal(hasSubsidyWording('Price for Sakani beneficiaries'), true);
    assert.equal(hasSubsidyWording('مجمع سكني متكامل'), false, '"residential" alone is not subsidy wording');
  });
});

describe('pricePagesToRender', () => {
  it('returns the 1-based pages that need a look, in order', () => {
    assert.deepEqual(pricePagesToRender([LOCATION_PAGE, 'شقة بغرفتين', PRICE_PAGE, '', PRICE_PAGE]), [3, 5]);
  });
  it('is capped', () => {
    const many = Array.from({ length: 40 }, () => PRICE_PAGE);
    assert.equal(pricePagesToRender(many).length, MAX_PRICE_PAGES);
    assert.deepEqual(pricePagesToRender(many, { maxPages: 2 }), [1, 2]);
  });
  it('copes with no page text', () => {
    assert.deepEqual(pricePagesToRender(undefined), []);
  });
});

// ---- end to end: processPdf with a fake extractor and a fake `claude` ---------------------------

const FAKE_PY = `import fs from 'node:fs';
import path from 'node:path';
const cfg = JSON.parse(fs.readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
const [, , , , outDir, ...rest] = process.argv;
const opt = (k) => { const i = rest.indexOf(k); return i === -1 ? null : rest[i + 1]; };
const mode = opt('--mode') ?? 'extract';
const pages = (opt('--pages') ?? '').split(',').filter(Boolean).map(Number);
const put = (rel) => { const abs = path.join(outDir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.copyFileSync(cfg.photo, abs); return abs; };
fs.appendFileSync(new URL('./calls.jsonl', import.meta.url), JSON.stringify({ tool: 'py-' + mode, pages }) + '\\n');
let out;
if (mode === 'extract') {
  const candidates = Array.from({ length: 6 }, (_, index) => {
    const file = 'images/c' + String(index).padStart(3, '0') + '.jpg';
    // cfg.broken: candidates written as bytes no decoder reads (a truncated or hostile image).
    const abs = (cfg.broken ?? []).includes(index) ? (put(file), fs.writeFileSync(path.join(outDir, file), 'not an image'), path.join(outDir, file)) : put(file);
    return { index, file, abs, width: 1200, height: 900, page: 1 + index, source: 'embedded', coverage: 0.5 };
  });
  out = { ok: true, pages: cfg.pageText.length, text: cfg.pageText.join('\\n'), pageText: cfg.pageText, candidates,
    rendered: false, embeddedImageCount: candidates.length, links: [], meta: {} };
} else if (cfg.failPageDir && opt('--page-dir') === cfg.failPageDir) {
  out = { ok: false, error: 'extract_pdf.py failed (exit 1): cannot render' };
} else {
  const dir = opt('--page-dir') ?? 'pages';
  const want = pages.length ? pages : cfg.pageText.map((_, i) => i + 1);
  out = { ok: true, pageImages: want.map((page) => ({ page, abs: put(dir + '/p' + page + '.jpg'), width: 1600, height: 1131 })) };
}
process.stdout.write(JSON.stringify(out) + '\\n');
`;

const FAKE_CLAUDE = `import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
const log = new URL('./calls.jsonl', import.meta.url);
const prompt = fs.readFileSync(0, 'utf8');
let answer;
if (prompt.includes('For each numbered model')) {
  // The unit-model check (claude.mjs confirmModelPrices): one call per page, every model on it,
  // one JSON line per model inside the fence.
  const page = Number((prompt.match(/\\/p(\\d+)\\.jpg/) || [])[1]);
  const fenced = prompt.split('<<<BONA-UNTRUSTED-DATA: the models and figures to check>>>')[1].split('<<<END ')[0];
  const items = fenced.split('\\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
    .map(({ i, price, subsidisedPrice }) => ({ i, price, subsidisedPrice }));
  fs.appendFileSync(log, JSON.stringify({ tool: 'claude-model-confirm', page, items }) + '\\n');
  if (cfg.modelConfirmFail) {
    const quota = cfg.modelConfirmFail === 'quota';
    process.stdout.write(JSON.stringify({ is_error: true, api_error_status: quota ? 429 : null, result: quota ? "You've hit your session limit" : 'boom' }));
    process.exit(1);
  }
  // modelConfirm: null = every figure confirmed; [figures] = only those; { i: {price, subsidisedPrice} } = per model.
  const mc = cfg.modelConfirm ?? null;
  answer = items.map((it) => (Array.isArray(mc)
    ? { i: it.i, price: mc.includes(it.price), subsidisedPrice: mc.includes(it.subsidisedPrice) }
    : { i: it.i, price: true, subsidisedPrice: true, ...((mc ?? {})[it.i] ?? {}) }));
} else if (prompt.includes('VISIBLY PRINT')) {
  const amount = Number((prompt.match(/VISIBLY PRINT[^\\d]*(\\d+)/) || [])[1]);
  const subsidised = /VISIBLY PRINT the price for housing-subsidy/.test(prompt);
  fs.appendFileSync(log, JSON.stringify({ tool: 'claude-confirm', amount, subsidised, page: Number((prompt.match(/\\/p(\\d+)\\.jpg/) || [])[1]), project: /unit models/.test(prompt), mirror: /only the price for everyone else counts/.test(prompt),
    subject: (prompt.match(/listing this price is for[^\\n]*\\n([^\\n]*)/) || [])[1] ?? null }) + '\\n');
  if (cfg.confirmFail === 'quota') {
    process.stdout.write(JSON.stringify({ is_error: true, api_error_status: 429, result: "You've hit your session limit" }));
    process.exit(1);
  }
  answer = { confirmed: ((subsidised ? cfg.confirmSub : null) ?? cfg.confirm ?? []).includes(amount) };
} else {
  fs.appendFileSync(log, JSON.stringify({ tool: 'claude-listing', prompt }) + '\\n');
  answer = cfg.listing;
}
process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify(answer), total_cost_usd: 0, duration_ms: 1, num_turns: 1, session_id: 'fake' }));
`;

// A stand-in for brochure_pdf.py, run through the real spawn (cfg.brochurePyCmd = [node, this]):
// records what it was handed — the listing JSON, the files folder AS IT WAS at that moment, the
// site.json path — and answers with the script's JSON line.
const FAKE_BROCHURE = `import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const i = args.findIndex((a) => a.endsWith('brochure_pdf.py'));
const [listingJson, filesDir, siteJson, out] = args.slice(i + 1, i + 5);
fs.appendFileSync(new URL('./calls.jsonl', import.meta.url), JSON.stringify({ tool: 'brochure', args, filesDir, siteJson, out,
  listing: JSON.parse(fs.readFileSync(listingJson, 'utf8')), files: fs.readdirSync(filesDir).sort() }) + '\\n');
if (cfg.brochureFail) {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'error', error: 'layout does not fit: page 4' }) + '\\n');
  process.exit(1);
}
fs.writeFileSync(out, '%PDF-1.7 fake brochure\\n');
process.stdout.write(JSON.stringify({ ok: true, out, bytes: 23, pages: 12, steps: ['measure', 'render', 'write'] }) + '\\n');
`;

const PLACE = {
  district: { en: 'Al Hamdaniyah', ar: 'الحمدانية' }, city: { en: 'Jeddah', ar: 'جدة' },
  country: { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' }, countryCode: 'SA',
};
const answer = ({ price, priceEvidence = null, subsidisedPriceEvidence = null, unit = null }) => ({
  reject: false, rejectReason: null, confidence: 0.8, warnings: [],
  listing: {
    title: { en: 'Jeddah Heights, Al Hamdaniyah', ar: 'جدة هايتس، الحمدانية' }, type: 'apartment', category: 'off-plan', location: PLACE,
    price,
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    description: { en: ['One.', 'Two.'], ar: ['واحد.', 'اثنان.'] },
    highlights: { en: ['A', 'B', 'C', 'D'], ar: ['أ', 'ب', 'ج', 'د'] },
    project: { name: { en: 'Jeddah Heights', ar: 'جدة هايتس' }, developer: { en: 'NHC', ar: 'الوطنية للإسكان' } },
    unit,
  },
  images: Array.from({ length: 6 }, (_, index) => ({
    index, room: ['exterior', 'living', 'kitchen', 'master', 'garden', 'gym'][index], rank: index + 1, hero: index === 0, exclude: false,
    reason: 'photograph', focus: { x: 0.5, y: index === 1 ? 0.8 : 0.5 },
  })),
  priceEvidence,
  subsidisedPriceEvidence,
});

const PRICE = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
const BROCHURE = ['مشروع سكني — شقق بغرفتي نوم وثلاث غرف نوم في حي الحمدانية', LOCATION_PAGE, PRICE_PAGE, 'غرفة نوم 03', PRICE_PAGE];

async function rig({ pageText = BROCHURE, listing, confirm = [], confirmSub = null, confirmFail = null, modelConfirm = null, modelConfirmFail = null, failPageDir = null, broken = [], brochureFail = false, cfgExtra = {}, build = '' }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bona-price-pages-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const photo = path.join(bin, 'photo.jpg');
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#4a6b8a' } }).jpeg().toFile(photo);
  fs.writeFileSync(path.join(bin, 'fake.json'), JSON.stringify({ photo, pageText, listing, confirm, confirmSub, confirmFail, modelConfirm, modelConfirmFail, failPageDir, broken, brochureFail }));
  fs.writeFileSync(path.join(bin, 'fake-py.mjs'), FAKE_PY);
  fs.writeFileSync(path.join(bin, 'fake-claude.mjs'), FAKE_CLAUDE);
  fs.writeFileSync(path.join(bin, 'fake-brochure.mjs'), FAKE_BROCHURE);
  const claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(claude, 0o755);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'data'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'src', 'data', 'kind-map.json'), path.join(repo, 'src', 'data', 'kind-map.json'));
  for (const f of ['build.mjs', 'validate.mjs']) {
    fs.mkdirSync(path.join(repo, 'scripts', 'curate'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'curate', f), f === 'build.mjs' && build ? build : '// stand-in: the real build is not under test here\n');
  }
  const pdfPath = path.join(dir, 'brochure.pdf');
  fs.writeFileSync(pdfPath, `%PDF-1.4 jeddah heights ${crypto.randomUUID()}`);
  const cfg = {
    repo, site: 'https://bona-real-estate.com', maxPdfMb: 50, maxPdfPages: 60, minImageSide: 100, minImages: 4, maxImages: 10,
    pageReadLongSide: 1600, pyCmd: [process.execPath, path.join(bin, 'fake-py.mjs')], claudeBin: claude,
    brochurePyCmd: [process.execPath, path.join(bin, 'fake-brochure.mjs')], maxBrochureMb: 25,
    claudeModel: 'opus', claudeFallbackModel: null, claudeTimeoutMs: 60000, ...cfgExtra,
  };
  const calls = () => fs.readFileSync(path.join(bin, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const run = () => processPdf({ pdfPath, cfg, caption: {}, workDir: path.join(dir, 'work'), dryRun: true });
  const publish = (meta = {}, caption = { noBrochure: true }) => processPdf({ pdfPath, cfg, caption, workDir: path.join(dir, 'work'), meta });
  return { run, publish, calls, repo, pdfPath, cfg, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('processPdf: prices on pages whose digits are scrambled', { timeout: 120000 }, () => {
  it('renders exactly the price pages and tells the model why', async () => {
    const r = await rig({ listing: answer({ price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true } }) });
    try {
      await r.run();
      const calls = r.calls();
      const renders = calls.filter((c) => c.tool === 'py-pages');
      assert.equal(renders.length, 1, 'one page-render call');
      assert.deepEqual(renders[0].pages, [3, 5]);
      const { prompt } = calls.find((c) => c.tool === 'claude-listing');
      assert.match(prompt, /digits are missing or scrambled/);
      assert.match(prompt, /page 3: .*p3\.jpg/);
      assert.match(prompt, /page 5: .*p5\.jpg/);
      assert.doesNotMatch(prompt, /no usable text layer/);
    } finally { r.cleanup(); }
  });

  it('publishes both prices once each is confirmed on its page', async () => {
    const r = await rig({
      listing: answer({
        price: PRICE,
        priceEvidence: { page: 3, quote: '319,015' },
        subsidisedPriceEvidence: { page: 3, quote: '270,425' },
      }),
      confirm: [319015, 270425],
    });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.price, { ...PRICE });
      const confirms = r.calls().filter((c) => c.tool === 'claude-confirm');
      assert.deepEqual(confirms.map((c) => [c.amount, c.subsidised, c.project]), [[319015, false, true], [270425, true, true]]);
      assert.ok(!report.warningCodes.includes('price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('carries each photo\'s focus point into the listing', async () => {
    const r = await rig({ listing: answer({ price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true } }) });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.images[1].focus, { x: 0.5, y: 0.8 });
    } finally { r.cleanup(); }
  });

  it('drops an unconfirmed subsidised price but keeps the confirmed headline price', async () => {
    const r = await rig({
      listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }),
      confirm: [319015],
    });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.amount, 319015);
      assert.equal('subsidisedAmount' in report.listingPreview.price, false);
      assert.ok(report.warningCodes.includes('subsidised-price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('a subsidised price with no evidence at all is dropped', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015, 270425] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.amount, 319015);
      assert.equal('subsidisedAmount' in report.listingPreview.price, false);
    } finally { r.cleanup(); }
  });

  it('an unconfirmed headline price takes the subsidised one down with it', async () => {
    const r = await rig({
      listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }),
      confirm: [270425],
    });
    try {
      const report = await r.run();
      const p = report.listingPreview.price;
      assert.equal(p.onRequest, true);
      assert.equal(p.amount, null);
      assert.equal('subsidisedAmount' in p, false);
      assert.ok(report.warningCodes.includes('price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('evidence pointing at a page that was not rendered is not confirmed', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 4, quote: '319,015' } }), confirm: [319015, 270425] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.onRequest, true);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 0);
    } finally { r.cleanup(); }
  });

  it('a brochure whose single price is readable renders nothing extra and needs no second model', async () => {
    const pageText = ['مشروع سكني — شقق بغرفتي نوم — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات', 'السعر 319,015 ريال\nشقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات'];
    const price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false };
    const r = await rig({ pageText, listing: answer({ price }), confirm: [] });
    try {
      const report = await r.run();
      assert.equal(r.calls().filter((c) => c.tool === 'py-pages').length, 0);
      assert.deepEqual(report.listingPreview.price, price);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 0);
    } finally { r.cleanup(); }
  });

  it('readable prices beside subsidy wording are still confirmed on the page, evidence or not', async () => {
    const pageText = ['مشروع سكني — شقق بغرفتي نوم', 'السعر لمستفيدي الدعم 270,425 ريال\nالسعر لغير مستفيدي الدعم 319,015 ريال'];
    const r = await rig({ pageText, listing: answer({ price: PRICE }), confirm: [319015, 270425] });
    try {
      const report = await r.run();
      assert.deepEqual(r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages), [[2]]);
      assert.deepEqual(report.listingPreview.price, PRICE);
      const confirms = r.calls().filter((c) => c.tool === 'claude-confirm');
      assert.deepEqual(confirms.map((c) => [c.amount, c.subsidised, c.mirror]), [[319015, false, true], [270425, true, false]]);
    } finally { r.cleanup(); }
  });

  it('a Sakani figure taken as the headline price is refused by the page check', async () => {
    const pageText = ['مشروع سكني — شقق بغرفتي نوم', 'السعر لمستفيدي الدعم 270,425 ريال\nالسعر لغير مستفيدي الدعم 319,015 ريال'];
    const price = { amount: 270425, currency: 'SAR', from: true, period: null, onRequest: false };
    const r = await rig({ pageText, listing: answer({ price }), confirm: [319015] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.onRequest, true, 'the number is printed, but not as the price everyone pays');
      assert.ok(report.warningCodes.includes('price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('a printed number that is not labelled as the subsidised price is not published as one', async () => {
    // Reviewer repro: a down payment the model mistook for the Sakani price, in a readable brochure.
    const pageText = ['فيلا للبيع في حي الشاطئ — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات', 'السعر 1,500,000 ريال\nالدفعة الأولى 300,000 ريال\nشقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات'];
    const price = { amount: 1500000, currency: 'SAR', from: false, period: null, onRequest: false, subsidisedAmount: 300000 };
    const r = await rig({ pageText, listing: answer({ price }), confirm: [1500000, 300000] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.amount, 1500000);
      assert.equal('subsidisedAmount' in report.listingPreview.price, false);
      assert.ok(report.warningCodes.includes('subsidised-price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('the "any unit model counts" allowance is only for a whole development quoted "from"', async () => {
    for (const [label, opts, project] of [
      ['whole development, from', { price: PRICE }, true],
      ['one unit of it', { price: PRICE, unit: { floor: 3, block: 'H', unitRef: null } }, false],
      ['not marked from', { price: { ...PRICE, from: false } }, false],
    ]) {
      const r = await rig({ listing: answer({ ...opts, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015, 270425] });
      try {
        await r.run();
        const first = r.calls().find((c) => c.tool === 'claude-confirm');
        assert.equal(first.project, project, label);
      } finally { r.cleanup(); }
    }
  });
});

describe('processPdf: replacing a published listing in place (run-once --replace)', { timeout: 120000 }, () => {
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  /** Seed the repo with the listing as the first run published it (same PDF, six photos and a stray seventh), committed. */
  const seed = (r, { nextSeq = 30, commit = true } = {}) => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
    const inbox = path.join(r.repo, 'scripts', 'curate', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, `${SLUG}.json`), JSON.stringify({
      id: 'BONA-W023', slug: SLUG, status: 'available', listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06',
      price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true }, videos: [], licence: null,
      _intake: { source: 'whatsapp', pdfSha256: sha },
    }));
    fs.writeFileSync(path.join(inbox, '_index.json'), JSON.stringify({ nextSeq, listings: { [SLUG]: 'BONA-W023' } }));
    const pub = path.join(r.repo, 'public', 'listings', SLUG);
    fs.mkdirSync(pub, { recursive: true });
    for (const f of ['01.jpg', '06.jpg', '07.jpg', '07-thumb.webp', 'brochure.pdf']) fs.writeFileSync(path.join(pub, f), 'old');
    if (commit) { git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: Jeddah Heights (BONA-W023)'); }
    return pub;
  };
  const META = { id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', replace: true };

  it('the same PDF is still refused as a duplicate without --replace', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }), confirm: [319015, 270425] });
    try {
      seed(r);
      await assert.rejects(r.publish(), (err) => err.stage === 'duplicate' && /already published as BONA-W023/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('rewrites the listing under its own id, slug, date and reference, and drops the old photos', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }), confirm: [319015, 270425] });
    try {
      const pub = seed(r);
      const report = await r.publish(META);
      assert.equal(report.id, 'BONA-W023');
      assert.equal(report.slug, SLUG);
      const saved = JSON.parse(fs.readFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', `${SLUG}.json`), 'utf8'));
      assert.equal(saved.id, 'BONA-W023');
      assert.equal(saved.listedAt, '2026-11-17');
      assert.equal(saved.sourceRef, 'WA-20261117-AC7D06');
      assert.deepEqual(saved.price, PRICE);
      assert.deepEqual(saved.images[1].focus, { x: 0.5, y: 0.8 });
      assert.deepEqual(fs.readdirSync(pub).filter((f) => f.endsWith('.jpg')).sort(), ['01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg', '06.jpg']);
      assert.equal(fs.existsSync(path.join(pub, '07-thumb.webp')), false, 'a photo the new run did not publish is gone');
      assert.equal(fs.existsSync(path.join(pub, 'brochure.pdf')), false, 'the old brochure is not left behind');
      const index = JSON.parse(fs.readFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', '_index.json'), 'utf8'));
      assert.equal(index.nextSeq, 30, 'replacing an old id never winds the counter back');
    } finally { r.cleanup(); }
  });

  it('refuses to replace a listing that is not there', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015] });
    try {
      await assert.rejects(r.publish(META), /BONA-W023.*not in the inbox|no inbox listing/i);
    } finally { r.cleanup(); }
  });
});

describe('processPdf --replace: what it refuses and how it rolls back', { timeout: 120000 }, () => {
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const META = { id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', replace: true };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  const seed = (r, { commit = true } = {}) => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
    const inbox = path.join(r.repo, 'scripts', 'curate', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, `${SLUG}.json`), JSON.stringify({ id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', _intake: { pdfSha256: sha } }));
    fs.writeFileSync(path.join(inbox, '_index.json'), JSON.stringify({ nextSeq: 24, listings: { [SLUG]: 'BONA-W023' } }));
    const pub = path.join(r.repo, 'public', 'listings', SLUG);
    fs.mkdirSync(pub, { recursive: true });
    for (const f of ['01.jpg', '07.jpg', 'brochure.pdf']) fs.writeFileSync(path.join(pub, f), 'old');
    if (commit) { git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: Jeddah Heights (BONA-W023)'); }
    return pub;
  };
  const listing = () => answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } });

  it('refuses when the listing is not committed, before the model is paid', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425] });
    try {
      const pub = seed(r, { commit: false });
      git(r, 'init', '-q');
      await assert.rejects(r.publish(META), /uncommitted changes \(or is not in git\)/);
      assert.equal(fs.readFileSync(path.join(pub, '07.jpg'), 'utf8'), 'old', 'nothing was deleted');
      assert.equal(fs.existsSync(path.join(r.repo, '..', 'bin', 'calls.jsonl')), false, 'no extraction, no model call');
    } finally { r.cleanup(); }
  });

  it('refuses when the committed listing has local edits', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425] });
    try {
      const pub = seed(r);
      fs.writeFileSync(path.join(pub, '01.jpg'), 'edited by hand');
      await assert.rejects(r.publish(META), /uncommitted changes/);
    } finally { r.cleanup(); }
  });

  it('a failed rebuild puts the old listing back exactly', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425], build: 'process.exit(1);\n' });
    try {
      const pub = seed(r);
      const before = git(r, 'status', '--porcelain');
      await assert.rejects(r.publish(META));
      assert.equal(git(r, 'status', '--porcelain'), before, 'the clone is back to the commit');
      assert.equal(fs.readFileSync(path.join(pub, '07.jpg'), 'utf8'), 'old');
      assert.equal(fs.readFileSync(path.join(pub, 'brochure.pdf'), 'utf8'), 'old');
      assert.equal(fs.existsSync(path.join(pub, '02.jpg')), false, 'none of the new photos stayed');
    } finally { r.cleanup(); }
  });
});

describe('processPdf: round-2 review cases', { timeout: 120000 }, () => {
  const PAD = ' — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات';

  it('"before/after subsidy" wording: the subsidised figure taken as the headline is refused on the page', async () => {
    const pageText = [`مشروع سكني${PAD}`, `السعر قبل الدعم 350,000 ريال\nالسعر بعد الدعم 270,425 ريال\n${PAD}`];
    const price = { amount: 270425, currency: 'SAR', from: true, period: null, onRequest: false };
    const r = await rig({ pageText, listing: answer({ price }), confirm: [350000] });
    try {
      const report = await r.run();
      assert.deepEqual(r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages), [[2]]);
      assert.equal(report.listingPreview.price.onRequest, true);
    } finally { r.cleanup(); }
  });

  it('a Sakani footer on every page does not push the real price page out of the render budget', async () => {
    const pageText = Array.from({ length: 13 }, () => `مشروع سكني${PAD}\nبالشراكة مع منصة سكني`);
    pageText.push(`السعر 319,015 ريال\n${PAD}`);
    const price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false };
    const r = await rig({ pageText, listing: answer({ price }), confirm: [] });
    try {
      const report = await r.run();
      assert.equal(r.calls().filter((c) => c.tool === 'py-pages').length, 0);
      assert.equal(report.listingPreview.price.amount, 319015);
    } finally { r.cleanup(); }
  });

  it('evidence citing a page that was not rendered falls back to the rendered page carrying the number', async () => {
    const pageText = [`مشروع سكني${PAD}`, `السعر لمستفيدي الدعم 270,425 ريال\nالسعر لغير مستفيدي الدعم 319,015 ريال\n${PAD}`];
    const price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false };
    const r = await rig({ pageText, listing: answer({ price, priceEvidence: { page: 1, quote: '319,015' } }), confirm: [319015] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.amount, 319015);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 1);
    } finally { r.cleanup(); }
  });

  it('the page check is told which listing — and which unit — the price is for', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, unit: { floor: 3, block: 'H', unitRef: 'H-12' } }), confirm: [319015, 270425] });
    try {
      await r.run();
      const first = r.calls().find((c) => c.tool === 'claude-confirm');
      assert.equal(first.subject, 'Jeddah Heights, Al Hamdaniyah — unit H-12, block H, floor 3');
    } finally { r.cleanup(); }
  });
});

describe('processPdf --replace: history and the CLI', { timeout: 120000 }, () => {
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const META = { id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', replace: true };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  const seed = (r) => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
    const inbox = path.join(r.repo, 'scripts', 'curate', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const file = path.join(inbox, `${SLUG}.json`);
    fs.writeFileSync(file, JSON.stringify({ id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', location: { district: { en: 'Al Rawabi' } }, _intake: { pdfSha256: sha } }));
    fs.writeFileSync(path.join(inbox, '_index.json'), JSON.stringify({ nextSeq: 24, listings: { [SLUG]: 'BONA-W023' } }));
    fs.mkdirSync(path.join(r.repo, 'public', 'listings', SLUG), { recursive: true });
    fs.writeFileSync(path.join(r.repo, 'public', 'listings', SLUG, '01.jpg'), 'old');
    git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: Jeddah Heights (BONA-W023)');
    return file;
  };

  it('refuses a listing that was corrected by hand after it was published', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015] });
    try {
      const file = seed(r);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Al Rawabi', 'Al Rehab'));
      git(r, 'commit', '-qam', 'district fix by hand');
      await assert.rejects(r.publish(META), /changed since it was published \(1 later commit\(s\), e\.g\. "district fix by hand"\)/);
    } finally { r.cleanup(); }
  });

  it('run-once --replace refuses a dirty publishing clone instead of discarding its changes', async () => {
    const r = await rig({ listing: answer({ price: PRICE }), confirm: [] });
    try {
      const file = seed(r);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Al Rawabi', 'Al Rehab (unsaved fix)'));
      const data = path.join(r.repo, '..', 'data');
      fs.mkdirSync(data);
      let out = '';
      try {
        execFileSync(process.execPath, [path.join(REPO, 'services', 'intake', 'run-once.mjs'), r.pdfPath, '--repo', r.repo, '--replace', 'BONA-W023', '--work', path.join(data, 'work')], {
          env: { ...process.env, BONA_DATA: data }, stdio: 'pipe',
        });
      } catch (err) { out = `${err.stdout}${err.stderr}`; }
      assert.match(out, /has uncommitted changes, which --replace will not discard/);
      assert.match(fs.readFileSync(file, 'utf8'), /unsaved fix/, 'the change is still there');
    } finally { r.cleanup(); }
  });

  it('run-once refuses --replace with --no-git', () => {
    let out = '';
    try {
      execFileSync(process.execPath, [path.join(REPO, 'services', 'intake', 'run-once.mjs'), path.join(REPO, 'package.json'), '--no-git', '--replace', 'BONA-W023'], { stdio: 'pipe' });
    } catch (err) { out = `${err.stdout}${err.stderr}`; }
    assert.match(out, /--replace needs git/);
  });

  it('run-once treats `--replace --dry-run` as a usage error, not as the id', () => {
    for (const flag of ['--replace', '--enrich']) {
      let out = '';
      let code = 0;
      try {
        execFileSync(process.execPath, [path.join(REPO, 'services', 'intake', 'run-once.mjs'), path.join(REPO, 'package.json'), flag, '--dry-run'], { stdio: 'pipe' });
      } catch (err) { out = `${err.stdout}${err.stderr}`; code = err.status; }
      assert.equal(code, 2, flag);
      assert.match(out, new RegExp(`${flag} needs a listing id`));
    }
  });
});

describe('processPdf: round-3 review cases', { timeout: 120000 }, () => {
  const PAD = ' — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات';
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const META = { id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', replace: true };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  const seed = (r, { init = true } = {}) => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
    const inbox = path.join(r.repo, 'scripts', 'curate', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, `${SLUG}.json`), JSON.stringify({ id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', _intake: { pdfSha256: sha } }));
    fs.writeFileSync(path.join(inbox, '_index.json'), JSON.stringify({ nextSeq: 24, listings: { [SLUG]: 'BONA-W023' } }));
    const pub = path.join(r.repo, 'public', 'listings', SLUG);
    fs.mkdirSync(pub, { recursive: true });
    fs.writeFileSync(path.join(pub, '01.jpg'), 'old');
    if (init) { git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: Jeddah Heights (BONA-W023)'); }
    return pub;
  };
  const listing = () => answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } });

  it('a subsidy table with no price word: the subsidised figure as headline is refused on the page', async () => {
    const pageText = [`مشروع سكني${PAD}`, `لمستفيدي الدعم\n270,425\nلغير مستفيدي الدعم\n319,015\n${PAD}`];
    const r = await rig({ pageText, listing: answer({ price: { amount: 270425, currency: 'SAR', from: true, period: null, onRequest: false } }), confirm: [319015] });
    try {
      const report = await r.run();
      assert.deepEqual(r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages), [[2]]);
      assert.equal(report.listingPreview.price.onRequest, true);
    } finally { r.cleanup(); }
  });

  it('a price the check took away cannot stay in the copy', async () => {
    const pageText = [`مشروع سكني${PAD}`, `غرفتا نوم ودورتا مياه${PAD}`];
    const a = answer({ price: { amount: 1250000, currency: 'SAR', from: false, period: null, onRequest: false } });
    a.listing.description.en = ['The asking figure is 1,250,000 for this unit.', 'Two.']; // no price word: still the refused price
    const r = await rig({ pageText, listing: a, confirm: [] });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price' && /copy states the price 1,250,000/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('refuses a listing whose photos were fixed by hand after it was published', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425] });
    try {
      const pub = seed(r);
      fs.writeFileSync(path.join(pub, '01.jpg'), 're-cropped');
      git(r, 'commit', '-qam', 'W023 re-crop');
      await assert.rejects(r.publish(META), /1 later commit\(s\), e\.g\. "W023 re-crop"/);
    } finally { r.cleanup(); }
  });

  it('a listing that was only ever replaced by the intake can be replaced again', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425] });
    try {
      const pub = seed(r);
      fs.writeFileSync(path.join(pub, '01.jpg'), 'first replacement');
      git(r, 'commit', '-qam', 'intake: replace Jeddah Heights (BONA-W023)');
      const report = await r.publish(META);
      assert.equal(report.id, 'BONA-W023');
    } finally { r.cleanup(); }
  });

  it('a --replace dry run does not need git', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425] });
    try {
      seed(r, { init: false });
      const report = await processPdf({ pdfPath: r.pdfPath, cfg: { ...JSON.parse('{}'), ...r.cfg }, caption: {}, workDir: path.join(r.repo, '..', 'work'), dryRun: true, meta: META });
      assert.equal(report.id, 'BONA-W023');
    } finally { r.cleanup(); }
  });
});

describe('processPdf: round-4 review cases', { timeout: 120000 }, () => {
  const PAD = ' — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات';
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const META = { id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', replace: true };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();

  for (const [form, a, b] of [['space', '270 425', '319 015'], ['dot', '270.425', '319.015'], ['decimals', '270,425.00', '319,015.00']]) {
    it(`a subsidy table written with ${form} grouping is still checked on the page`, async () => {
      const pageText = [`مشروع سكني${PAD}`, `لمستفيدي الدعم\n${a}\nلغير مستفيدي الدعم\n${b}\n${PAD}`];
      const r = await rig({ pageText, listing: answer({ price: { amount: 270425, currency: 'SAR', from: true, period: null, onRequest: false } }), confirm: [319015] });
      try {
        const report = await r.run();
        assert.deepEqual(r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages), [[2]]);
        assert.equal(report.listingPreview.price.onRequest, true);
      } finally { r.cleanup(); }
    });
  }

  it('a refused price stated with a price word is caught too', async () => {
    const pageText = [`مشروع سكني${PAD}`, `غرفتا نوم ودورتا مياه${PAD}`];
    const a = answer({ price: { amount: 1250000, currency: 'SAR', from: false, period: null, onRequest: false } });
    a.listing.description.ar = ['قيمة الوحدة 1,250,000 فقط.', 'اثنان.'];
    const r = await rig({ pageText, listing: a, confirm: [] });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price');
    } finally { r.cleanup(); }
  });

  it('a refused price that only matches an area in the copy does not reject the run', async () => {
    const pageText = [`مشروع سكني${PAD}`, `غرفتا نوم ودورتا مياه${PAD}`];
    const a = answer({ price: { amount: 3000000, currency: 'SAR', from: false, period: null, onRequest: false } });
    a.listing.description.en = ['The master plan spans more than 3 million square metres.', 'Two.'];
    const r = await rig({ pageText, listing: a, confirm: [] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.onRequest, true);
    } finally { r.cleanup(); }
  });

  const withCopy = async (r, line) => {
    const f = path.join(r.repo, '..', 'bin', 'fake.json');
    const a = JSON.parse(fs.readFileSync(f, 'utf8'));
    a.listing.listing.highlights.en[0] = line;
    fs.writeFileSync(f, JSON.stringify(a));
  };
  const captioned = (r) => processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: { price: { amount: 300000, currency: 'SAR' }, text: '300000' }, workDir: path.join(r.repo, '..', 'work'), dryRun: true });

  it('under the owner\'s caption price, an unconfirmed Sakani figure in the copy is still refused', async () => {
    const r = await rig({ listing: answer({ price: PRICE }), confirm: [] });
    try {
      await withCopy(r, 'Sakani beneficiaries: 270,425');
      await assert.rejects(captioned(r), (err) => err.stage === 'price' && /270,425.*send it again/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('under the owner\'s caption price, a Sakani figure confirmed on the page may stay in the copy', async () => {
    const r = await rig({ listing: answer({ price: PRICE, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }), confirm: [], confirmSub: [270425] });
    try {
      await withCopy(r, 'Sakani beneficiaries: 270,425');
      const report = await captioned(r);
      assert.equal(report.listingPreview.price.amount, 300000);
      assert.equal('subsidisedAmount' in report.listingPreview.price, false, 'the caption price replaces both');
    } finally { r.cleanup(); }
  });

  for (const line of ['Two-bedroom apartments from 319,015 in phase one.', 'Villas from 1.2 million in phase one.', 'فلل من 1.2 مليون في المرحلة الأولى.', 'Units go for 319,015 each']) {
    it(`a refused price in the copy is caught however it is worded: ${line}`, async () => {
      const amount = /1\.2/.test(line) ? 1200000 : 319015;
      const r = await rig({ listing: answer({ price: { amount, currency: 'SAR', from: true, period: null, onRequest: false } }), confirm: [] });
      try {
        await withCopy(r, line);
        await assert.rejects(r.run(), (err) => err.stage === 'price');
      } finally { r.cleanup(); }
    });
  }

  it('refuses a listing whose history does not start at the intake\'s publish commit (a hand rename)', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015, 270425] });
    try {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
      const inbox = path.join(r.repo, 'scripts', 'curate', 'inbox');
      fs.mkdirSync(inbox, { recursive: true });
      fs.writeFileSync(path.join(inbox, `${SLUG}.json`), JSON.stringify({ id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', _intake: { pdfSha256: sha } }));
      fs.mkdirSync(path.join(r.repo, 'public', 'listings', SLUG), { recursive: true });
      fs.writeFileSync(path.join(r.repo, 'public', 'listings', SLUG, '01.jpg'), 'old');
      git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'Rename W023 and fix its district by hand');
      await assert.rejects(r.publish(META), /history starts at "Rename W023/);
    } finally { r.cleanup(); }
  });
});

describe('processPdf: round-6 review cases', { timeout: 120000 }, () => {
  const PAD = ' — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات';
  const pageText = [`مشروع سكني${PAD}`, `غرفتا نوم ودورتا مياه${PAD}`];
  const withLine = (amount, line) => {
    const a = answer({ price: { amount, currency: 'SAR', from: true, period: null, onRequest: false } });
    a.listing.description.en = [line, 'Two.'];
    return a;
  };

  for (const [line, amount] of [
    ['The asking figure is 1,250,000 for a 120 m² apartment', 1250000],
    ['Two-bedroom apartments of 120 m² from 319,015', 319015],
    ['1,710 units from 319,015 each', 319015],
    ['Villas of 400 m² from 1.2 million', 1200000],
    ['Four-bedroom villas from 4.5m.', 4500000],
    ['Townhouses from 2.8M, ready in 2027.', 2800000],
  ]) {
    it(`an area elsewhere in the sentence does not excuse a refused price: ${line}`, async () => {
      const r = await rig({ pageText, listing: withLine(amount, line), confirm: [] });
      try {
        await assert.rejects(r.run(), (err) => err.stage === 'price');
      } finally { r.cleanup(); }
    });
  }

  for (const [line, amount] of [['يمتد المخطط على ٣ ملايين متر مربع', 3000000], ['The project plants 1 million trees', 1000000], ['Every plot faces a 20 m street', 20000000]]) {
    it(`a measurement that equals the refused price is not the price: ${line}`, async () => {
      const r = await rig({ pageText, listing: withLine(amount, line), confirm: [] });
      try {
        const report = await r.run();
        assert.equal(report.listingPreview.price.onRequest, true);
      } finally { r.cleanup(); }
    });
  }

  it('under the owner\'s caption price, the model\'s own unprinted figure in the copy is refused', async () => {
    const r = await rig({ pageText, listing: withLine(319015, 'Two-bedroom apartments from 319,015 in phase one.'), confirm: [] });
    try {
      await assert.rejects(
        processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: { price: { amount: 300000, currency: 'SAR' }, text: '300000' }, workDir: path.join(r.repo, '..', 'work'), dryRun: true }),
        (err) => err.stage === 'price' && /319,015/.test(err.reason),
      );
    } finally { r.cleanup(); }
  });
});

describe('processPdf: unit-model prices (every figure confirmed on its page, one call per page)', { timeout: 120000 }, () => {
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  const model = (en, price, subsidisedPrice, page) => ({
    name: { en, ar: `نموذج ${en}` }, bedrooms: 2, bathrooms: 2, areaSqm: 105, rooms: null, availability: null,
    price, subsidisedPrice, evidence: page ? { page, quote: String(price) } : null, floorPlan: null,
  });
  const withModels = (models, opts = {}) => ({ ...answer({ price: ON_REQUEST, ...opts }), models });
  const modelCalls = (r) => r.calls().filter((c) => c.tool === 'claude-model-confirm');

  it('two models on the scrambled price page: ONE check, headline = the cheaper model, from', async () => {
    const r = await rig({ listing: withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)]) });
    try {
      const report = await r.run();
      const checks = modelCalls(r);
      assert.equal(checks.length, 1, 'one call for the page, however many models are on it');
      assert.equal(checks[0].page, 3);
      assert.deepEqual(checks[0].items, [{ i: 0, price: 419994, subsidisedPrice: 356024 }, { i: 1, price: 319015, subsidisedPrice: 270425 }]);
      assert.deepEqual(report.listingPreview.price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 });
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[419994, 356024], [319015, 270425]]);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 0, 'the headline is the confirmed model figure: no second check');
      assert.ok(!report.warningCodes.includes('model-price-not-printed'));
      assert.deepEqual(report.modelPrices, { models: 2, calls: 1, refused: [], incomplete: [], incompletePages: [], fatal: false, tooMany: null });
      assert.deepEqual(report.priceEvidence, { inText: false, confirmed: true, fromModels: true }, 'the { inText, confirmed } shape stays');
    } finally { r.cleanup(); }
  });

  it('a model price the page check refuses is dropped, and the headline comes from the other model', async () => {
    const r = await rig({
      listing: withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)]),
      modelConfirm: [419994, 356024, 270425],
    });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[419994, 356024], [null, null]], 'a Sakani price never outlives its model\'s price');
      assert.deepEqual(report.listingPreview.price, { amount: 419994, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 356024 });
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
      assert.ok(report.listingPreview._intake.warnings.includes('model-price-not-printed'));
      assert.deepEqual(report.modelPrices.refused.sort(), [270425, 319015]);
    } finally { r.cleanup(); }
  });

  it('evidence citing a page that was not rendered (no price on it in the text) renders that page and checks it', async () => {
    const r = await rig({ listing: withModels([model('Lulu', 319015, 270425, 3), model('Corner', 299000, null, 2)]) });
    try {
      const report = await r.run();
      assert.deepEqual(r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages), [[3, 5], [2]]);
      assert.deepEqual(report.modelPages, [2]);
      assert.deepEqual(modelCalls(r).map((c) => c.page).sort(), [2, 3]);
      assert.deepEqual(modelCalls(r).find((c) => c.page === 2).items, [{ i: 1, price: 299000, subsidisedPrice: null }]);
      assert.equal(report.listingPreview.price.amount, 299000);
      assert.equal(report.listingPreview.price.subsidisedAmount, 270425);
    } finally { r.cleanup(); }
  });

  it('the owner\'s caption price drops every model price, with no page check', async () => {
    const r = await rig({ listing: withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)]) });
    try {
      const report = await processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: { price: { amount: 300000, currency: 'SAR' }, text: '300000' }, workDir: path.join(r.repo, '..', 'work'), dryRun: true });
      assert.equal(modelCalls(r).length, 0);
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null]]);
      assert.equal(report.listingPreview.price.amount, 300000);
      assert.ok(!report.warningCodes.includes('model-price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('a refused model price stated in the copy refuses the run', async () => {
    const a = withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 3)]);
    a.listing.description.en = ['Two-bedroom apartments from 319,015 in phase one.', 'Two.'];
    const r = await rig({ listing: a, modelConfirm: [419994] });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price' && /copy states the price 319,015/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('a figure refused for one model but confirmed for another may stay in the copy', async () => {
    const a = withModels([model('Lulu', 319015, null, 3), model('Lulu corner', 319015, null, 3)]);
    a.listing.description.en = ['Two-bedroom apartments from 319,015 in phase one.', 'Two.'];
    const r = await rig({ listing: a, modelConfirm: { 1: { price: false } } });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => m.price), [319015, null]);
      assert.equal(report.listingPreview.price.amount, 319015);
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('the model\'s own headline figure, replaced by the models, must still be printed if the copy states it', async () => {
    const a = withModels([model('Lulu', 319015, null, 3)], { price: { amount: 300000, currency: 'SAR', from: true, period: null, onRequest: false } });
    a.listing.description.en = ['Two-bedroom apartments from 300,000 in phase one.', 'Two.'];
    const r = await rig({ listing: a });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price' && /copy states the price 300,000/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('when every model price is refused, the headline falls back to its own checks', async () => {
    const r = await rig({
      listing: withModels([model('Lulu', 319015, 270425, 3)], { price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }),
      modelConfirm: [], confirm: [319015, 270425],
    });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null]]);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 2, 'headline + Sakani checked the old way');
      assert.deepEqual(report.listingPreview.price, PRICE);
    } finally { r.cleanup(); }
  });
});

describe('processPdf: unit-model prices — failures, bounds and the headline fallback', { timeout: 120000 }, () => {
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  const model = (en, price, subsidisedPrice, page) => ({
    name: { en, ar: `نموذج ${en}` }, bedrooms: 2, bathrooms: 2, areaSqm: 105, rooms: null, availability: null,
    price, subsidisedPrice, evidence: page ? { page, quote: String(price) } : null, floorPlan: null,
  });
  const withModels = (models, opts = {}) => ({ ...answer({ price: ON_REQUEST, ...opts }), models });
  const modelCalls = (r) => r.calls().filter((c) => c.tool === 'claude-model-confirm');
  const renders = (r) => r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages);

  it('(a) a model page that fails to render costs only the models on it; the run goes on', async () => {
    const r = await rig({ listing: withModels([model('Lulu', 319015, 270425, 3), model('Corner', 299000, null, 2)]), failPageDir: 'model-pages' });
    try {
      const report = await r.run();
      assert.deepEqual(renders(r), [[3, 5], [2]], 'the cited page was asked for');
      assert.equal(report.modelPages, undefined);
      assert.deepEqual(modelCalls(r).map((c) => c.page), [3], 'nothing to look at for Corner: no call');
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[319015, 270425], [null, null]]);
      assert.deepEqual(report.listingPreview.price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 });
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
      assert.deepEqual(report.modelPrices.incompletePages, [2]);
      assert.ok(report.warnings.some((w) => /could not be completed/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('(b) the model check failing (claude -p exits non-zero): refused, and the warning says the check could not be completed', async () => {
    const r = await rig({ listing: withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)]), modelConfirmFail: true });
    try {
      const report = await r.run();
      assert.equal(modelCalls(r).length, 1);
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null]]);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST, 'no model price kept and no headline figure of its own');
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
      assert.ok(report.warnings.some((w) => /could not be completed/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
      assert.ok(!report.warnings.some((w) => /could not be confirmed on the brochure's own pages/.test(w)), 'the brochure is not blamed');
      assert.deepEqual(report.modelPrices.incompletePages, [3]);
    } finally { r.cleanup(); }
  });

  it('(b) a quota error (fatal): refused, and the same warning (the stop after a fatal error is pinned in model-prices.test.mjs)', async () => {
    const r = await rig({ listing: withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 5)]), modelConfirmFail: 'quota', cfgExtra: { maxModelPricePages: 12 } });
    try {
      const report = await r.run();
      assert.ok(modelCalls(r).length <= 2);
      assert.deepEqual(report.ai.models.map((m) => m.price), [null, null]);
      assert.deepEqual(report.modelPrices.incompletePages, [3, 5]);
      assert.ok(report.warnings.some((w) => /could not be completed/.test(w)));
    } finally { r.cleanup(); }
  });

  it('a refusal and a check that could not be done get separate warnings', async () => {
    const r = await rig({
      listing: withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 3), model('Corner', 299000, null, 2)]),
      modelConfirm: [319015], failPageDir: 'model-pages',
    });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => m.price), [null, 319015, null]);
      assert.deepEqual(report.modelPrices.incompletePages, [2]);
      assert.deepEqual(report.modelPrices.incomplete, [299000]);
      assert.ok(report.warnings.some((w) => /^1 unit-model price\(s\) could not be confirmed on the brochure's own pages/.test(w)), report.warnings.join(' | '));
      const later = report.warnings.filter((w) => /try again later/.test(w));
      assert.equal(later.length, 1, report.warnings.join(' | '));
      assert.match(later[0], /the check of 1 unit-model price\(s\) could not be completed \(page 2\)/);
    } finally { r.cleanup(); }
  });

  it('after a quota error in the model check, the headline and Sakani checks make no call and say "try again later"', async () => {
    const r = await rig({
      listing: withModels([model('Lulu', 319015, 270425, 3)], { price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }),
      modelConfirmFail: 'quota', confirm: [319015, 270425],
    });
    try {
      const report = await r.run();
      assert.equal(modelCalls(r).length, 1);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 0, 'no call after a quota error');
      assert.equal(report.modelPrices.fatal, true);
      assert.equal(report.listingPreview.price.onRequest, true);
      assert.equal(report.listingPreview.price.amount, null);
      assert.deepEqual(report.priceEvidence, { inText: false, confirmed: null, unchecked: true });
      assert.ok(report.warnings.some((w) => /^the price could not be checked/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
      assert.ok(!report.warnings.some((w) => /was not printed in the brochure/.test(w)), 'the brochure is not blamed');
    } finally { r.cleanup(); }
  });

  it('a quota error on the headline check stops the Sakani check too', async () => {
    const r = await rig({
      listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }),
      confirmFail: 'quota',
    });
    try {
      const report = await r.run();
      assert.deepEqual(r.calls().filter((c) => c.tool === 'claude-confirm').map((c) => c.amount), [319015], 'the Sakani check is never sent');
      assert.equal(report.listingPreview.price.onRequest, true);
      assert.ok(report.warnings.some((w) => /^the price could not be checked/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
      assert.ok(!report.warnings.some((w) => /was not printed in the brochure/.test(w)));
    } finally { r.cleanup(); }
  });

  it('after a quota error, a headline found in the text layer stays and the Sakani price says "try again later"', async () => {
    const PAD = ' — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات';
    const pageText = [`مشروع سكني من 319,015 ريال${PAD}`, `السعر لمستفيدي الدعم 270,425 ريال\nالسعر لغير مستفيدي الدعم 319,015 ريال\n${PAD}`];
    const r = await rig({
      pageText,
      listing: withModels([model('Lulu', 319015, 270425, 2)], { price: PRICE, subsidisedPriceEvidence: { page: 2, quote: '270,425' } }),
      modelConfirmFail: 'quota', confirm: [319015, 270425],
    });
    try {
      const report = await r.run();
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 0);
      assert.equal(report.listingPreview.price.amount, 319015, 'printed in the text layer: no call needed');
      assert.equal(report.listingPreview.price.subsidisedAmount ?? null, null);
      assert.ok(report.warningCodes.includes('subsidised-price-not-printed'));
      assert.ok(report.warnings.some((w) => /Sakani\) price could not be checked/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('(c) a cited page past the end of the PDF: refused without a render or a call', async () => {
    const r = await rig({ listing: withModels([model('Lulu', 319015, null, 3), model('Ghost', 288000, null, 9)]) });
    try {
      const report = await r.run();
      assert.deepEqual(renders(r), [[3, 5]], 'page 9 of a 5-page PDF is never rendered');
      assert.deepEqual(modelCalls(r).map((c) => c.page), [3]);
      assert.deepEqual(modelCalls(r)[0].items.map((it) => it.i), [0]);
      assert.deepEqual(report.ai.models.map((m) => m.price), [319015, null]);
      assert.deepEqual(report.modelPrices.refused, [288000]);
      assert.ok(report.warnings.some((w) => /could not be confirmed on the brochure's own pages/.test(w)));
    } finally { r.cleanup(); }
  });

  it('(d) every model price refused: the headline\'s own check may confirm it on a page rendered for the models', async () => {
    const r = await rig({
      listing: withModels([model('Corner', 319015, null, 2)], { price: { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false }, priceEvidence: { page: 2, quote: '319,015' } }),
      modelConfirm: [], confirm: [319015],
    });
    try {
      const report = await r.run();
      assert.deepEqual(report.modelPages, [2]);
      assert.deepEqual(report.ai.models.map((m) => m.price), [null]);
      const headline = r.calls().filter((c) => c.tool === 'claude-confirm');
      assert.deepEqual(headline.map((c) => [c.amount, c.page]), [[319015, 2]], 'the second model looked at the model page');
      assert.deepEqual(report.priceEvidence, { inText: false, confirmed: true });
      assert.deepEqual(report.listingPreview.price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false });
    } finally { r.cleanup(); }
  });

  it('more priced pages than BONA_MAX_MODEL_PRICE_PAGES: every model price refused, nothing rendered, no call', async () => {
    const r = await rig({
      listing: withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 5), model('Corner', 299000, null, 2)]),
      cfgExtra: { maxModelPricePages: 2 },
    });
    try {
      const report = await r.run();
      assert.deepEqual(renders(r), [[3, 5]], 'page 2 is not rendered for the models');
      assert.equal(modelCalls(r).length, 0);
      assert.deepEqual(report.ai.models.map((m) => m.price), [null, null, null]);
      assert.deepEqual(report.modelPrices.tooMany, { pages: 3, max: 2 });
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
      assert.ok(report.warnings.some((w) => /too many pages/.test(w) && /3/.test(w) && /2/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('one specific unit is not "from the cheapest model": the headline keeps its own checks', async () => {
    const a = withModels([model('Lulu', 319015, null, 3)], {
      price: { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false }, priceEvidence: { page: 3, quote: '350,000' },
      unit: { unitRef: 'A-12', block: null, floor: 3 },
    });
    const r = await rig({ listing: a, confirm: [350000] });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => m.price), [319015], 'the model price is still checked and kept');
      assert.deepEqual(r.calls().filter((c) => c.tool === 'claude-confirm').map((c) => c.amount), [350000], 'the unit\'s own price is checked the old way');
      assert.deepEqual(report.listingPreview.price, { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false });
      assert.deepEqual(report.priceEvidence, { inText: false, confirmed: true });
    } finally { r.cleanup(); }
  });

  it('the headline taken from the models keeps the period the model read (a monthly rent stays monthly)', async () => {
    const a = withModels([model('Studio', 4500, null, 3)], { price: { amount: null, currency: 'SAR', from: false, period: 'month', onRequest: true } });
    a.listing.category = 'rent';
    const r = await rig({ listing: a });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.amount, 4500);
      assert.equal(report.listingPreview.price.from, true);
      assert.equal(report.listingPreview.price.period, 'month', 'not reset, and so not turned into a yearly rent');
    } finally { r.cleanup(); }
  });
});

describe('processPdf: unit models and their floor plans reach the repo', { timeout: 120000 }, () => {
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  const SLUG = 'jeddah-heights-al-hamdaniyah';
  const PLAN = { src: `/listings/${SLUG}/plan-01.jpg`, thumb: `/listings/${SLUG}/plan-01-thumb.webp` };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  const seedGit = (r) => { git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'seed'); };
  const inboxJson = (r) => JSON.parse(fs.readFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', `${SLUG}.json`), 'utf8'));
  /** Two priced models on page 3; Nawras's floor plan is candidate 5, which the ranking excluded from the gallery. */
  const withPlans = () => {
    const a = {
      ...answer({ price: ON_REQUEST }),
      models: [
        {
          name: { en: 'Nawras', ar: 'نموذج Nawras' }, bedrooms: 3, bathrooms: 2, areaSqm: 105.02, rooms: { en: ['Laundry'], ar: ['غرفة غسيل'] }, availability: null,
          price: 419994, subsidisedPrice: 356024, evidence: { page: 3, quote: '419994' }, floorPlan: 5,
        },
        {
          name: { en: 'Lulu', ar: 'نموذج Lulu' }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null,
          price: 319015, subsidisedPrice: 270425, evidence: { page: 3, quote: '319015' }, floorPlan: null,
        },
      ],
      amenities: { en: ['Health club'], ar: ['نادٍ صحي'] },
      nearby: { en: [], ar: [] },
      warranties: { en: ['Structure — 10 years'], ar: ['الهيكل الإنشائي — 10 سنوات'] },
    };
    a.images[5] = { ...a.images[5], rank: null, hero: false, exclude: true, reason: 'floor plan', focus: null };
    return a;
  };

  it('publishes plan-01.jpg + its thumbnail beside the photos, and the inbox JSON carries both models', async () => {
    const r = await rig({ listing: withPlans() });
    try {
      seedGit(r);
      const report = await r.publish();
      assert.equal(report.slug, SLUG);
      const pub = path.join(r.repo, 'public', 'listings', SLUG);
      assert.deepEqual(fs.readdirSync(pub).sort(), [...[1, 2, 3, 4, 5].flatMap((n) => [`0${n}-thumb.webp`, `0${n}.jpg`]), 'plan-01-thumb.webp', 'plan-01.jpg']);
      const sharp = (await import('sharp')).default;
      assert.equal((await sharp(path.join(pub, 'plan-01.jpg')).metadata()).format, 'jpeg');
      assert.equal((await sharp(path.join(pub, 'plan-01-thumb.webp')).metadata()).format, 'webp');
      assert.deepEqual(report.floorPlans, [{ model: 0, candidate: 5, src: PLAN.src }]);

      const saved = inboxJson(r);
      assert.deepEqual(saved.models.map((m) => m.floorPlan), [PLAN, null]);
      assert.deepEqual(saved.models.map((m) => [m.name.en, m.price, m.subsidisedPrice]), [['Nawras', 419994, 356024], ['Lulu', 319015, 270425]]);
      assert.deepEqual(saved.price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 });
      assert.deepEqual(saved.amenities, { en: ['Health club'], ar: ['نادٍ صحي'] });
      assert.deepEqual(saved.warranties, { en: ['Structure — 10 years'], ar: ['الهيكل الإنشائي — 10 سنوات'] });
      assert.equal('nearby' in saved, false);
      assert.ok(!JSON.stringify(saved).includes('evidence'), 'the model\'s citation is never committed');
      assert.deepEqual(saved._intake.images.map((im) => im.candidate), [0, 1, 2, 3, 4], 'the floor plan never enters the gallery');
      assert.deepEqual(checkListing(saved), [], 'the committed listing passes the shared rules');
      // New files under the allowlisted public/listings, so the intake's own commit carries them.
      const status = git(r, 'status', '--porcelain', '--untracked-files=all', '--', 'public/listings');
      assert.match(status, new RegExp(`^\\?\\? public/listings/${SLUG}/plan-01\\.jpg$`, 'm'));
      assert.match(status, new RegExp(`^\\?\\? public/listings/${SLUG}/plan-01-thumb\\.webp$`, 'm'));
    } finally { r.cleanup(); }
  });

  it('a dry run previews the plan paths without writing a file', async () => {
    const r = await rig({ listing: withPlans() });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.models.map((m) => m.floorPlan), [PLAN, null]);
      assert.deepEqual(checkListing(report.listingPreview), []);
      assert.equal(fs.existsSync(path.join(r.repo, 'public', 'listings')), false);
      assert.equal(fs.existsSync(path.join(r.repo, '..', 'work', 'publish')), false, 'nothing staged either');
    } finally { r.cleanup(); }
  });

  it('a floor plan that cannot be decoded is left out with a warning; the listing still publishes', async () => {
    const r = await rig({ listing: withPlans(), broken: [5] });
    try {
      seedGit(r);
      const report = await r.publish();
      const pub = path.join(r.repo, 'public', 'listings', SLUG);
      assert.equal(fs.readdirSync(pub).some((f) => f.startsWith('plan-')), false);
      const saved = inboxJson(r);
      assert.deepEqual(saved.models.map((m) => m.floorPlan), [null, null]);
      assert.ok(report.warnings.some((w) => /1 floor plan\(s\) could not be processed/.test(w)), report.warnings.join(' | '));
      assert.ok(saved._intake.warnings.includes('images-skipped'));
    } finally { r.cleanup(); }
  });

  // The new brochure is drawn from the STAGED folder (photos + floor plans), after both are
  // written and before anything is promoted, so it lands in the repo with them in one commit.
  it('builds the brochure from the staged photos and plans and publishes it beside them', async () => {
    const r = await rig({ listing: withPlans() });
    try {
      seedGit(r);
      const report = await r.publish({}, {});
      const [call, ...more] = r.calls().filter((c) => c.tool === 'brochure');
      assert.equal(more.length, 0, 'one brochure build');
      assert.equal(call.filesDir, path.join(r.repo, '..', 'work', 'publish', SLUG), 'the staging folder, not the repo');
      assert.ok(call.files.includes('plan-01.jpg') && call.files.includes('01.jpg'), call.files.join(' '));
      assert.equal(call.siteJson, path.join(r.repo, 'src', 'data', 'site.json'));
      assert.equal(call.out, path.join(call.filesDir, 'brochure.pdf'));
      assert.equal('_intake' in call.listing, false, 'the intake\'s bookkeeping never reaches the page');
      assert.equal('hidden' in call.listing, false);
      assert.deepEqual(call.listing.models.map((m) => m.floorPlan?.src ?? null), [PLAN.src, null]);
      assert.equal(call.args[call.args.indexOf('--max-mb') + 1], '25');

      assert.deepEqual({ ok: report.brochure.ok, pages: report.brochure.pages, bytes: report.brochure.bytes }, { ok: true, pages: 12, bytes: 23 });
      const pub = path.join(r.repo, 'public', 'listings', SLUG, 'brochure.pdf');
      assert.equal(fs.readFileSync(pub, 'utf8'), '%PDF-1.7 fake brochure\n');
      const saved = inboxJson(r);
      assert.equal(saved.brochureUrl, `https://bona-real-estate.com/listings/${SLUG}/brochure.pdf`);
      assert.ok(!saved._intake.warnings.some((w) => w.startsWith('brochure-')), saved._intake.warnings.join(' '));
    } finally { r.cleanup(); }
  });

  it('a brochure that cannot be built costs the listing nothing but the download button', async () => {
    const r = await rig({ listing: withPlans(), brochureFail: true });
    try {
      seedGit(r);
      const report = await r.publish({}, {});
      assert.equal(report.ok, true);
      assert.equal(report.brochure.ok, false);
      assert.equal(fs.existsSync(path.join(r.repo, 'public', 'listings', SLUG, 'brochure.pdf')), false);
      assert.ok(fs.existsSync(path.join(r.repo, 'public', 'listings', SLUG, 'plan-01.jpg')), 'the rest still publishes');
      const saved = inboxJson(r);
      assert.equal(saved.brochureUrl, null);
      assert.ok(saved._intake.warnings.includes('brochure-failed'));
      assert.ok(report.warnings.some((w) => /brochure could not be built/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('a failed rebuild takes the plan files away with the photos', async () => {
    const r = await rig({ listing: withPlans(), build: 'process.exit(1);\n' });
    try {
      seedGit(r);
      await assert.rejects(r.publish());
      assert.equal(fs.existsSync(path.join(r.repo, 'public', 'listings', SLUG)), false);
      assert.equal(git(r, 'status', '--porcelain'), '', 'the clone is back to the commit');
    } finally { r.cleanup(); }
  });
});

describe('processPdf --enrich: unit models + brochure on a published listing, nothing else touched', { timeout: 120000 }, () => {
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  const PRICED = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  const inboxFile = (r) => path.join(r.repo, 'scripts', 'curate', 'inbox', `${SLUG}.json`);
  const pubDir = (r) => path.join(r.repo, 'public', 'listings', SLUG);
  const META = { enrich: { id: 'BONA-W023', slug: SLUG } };
  const ENRICHED = ['models', 'amenities', 'nearby', 'warranties', 'brochureUrl'];
  const PHOTOS = [1, 2, 3, 4].flatMap((n) => [`0${n}.jpg`, `0${n}-thumb.webp`]);
  /** Two models priced on page 3 (Lulu is the cheaper), Nawras's floor plan = candidate 5 — the brochure as read today. */
  const reading = () => {
    const a = {
      ...answer({ price: { amount: 999999, currency: 'SAR', from: false, period: null, onRequest: false } }),
      models: [
        { name: { en: 'Nawras', ar: 'نموذج نورس' }, bedrooms: 3, bathrooms: 2, areaSqm: 105, rooms: null, availability: null, price: 419994, subsidisedPrice: 356024, evidence: { page: 3, quote: '419994' }, floorPlan: 5 },
        { name: { en: 'Lulu', ar: 'نموذج لؤلؤ' }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null, price: 319015, subsidisedPrice: 270425, evidence: { page: 3, quote: '319015' }, floorPlan: null },
      ],
      amenities: { en: ['Health club'], ar: ['نادٍ صحي'] },
      nearby: { en: [], ar: [] },
      warranties: { en: ['Structure — 10 years'], ar: ['الهيكل الإنشائي — 10 سنوات'] },
    };
    a.listing.title = { en: 'A brand new title the model wrote', ar: 'عنوان جديد' };
    a.images[5] = { ...a.images[5], rank: null, hero: false, exclude: true, reason: 'floor plan', focus: null };
    return a;
  };
  /**
   * The listing as published by the first run and then corrected by hand: its own title, district,
   * photos, licence, video, photo note, FAQ, SEO title, featured flag — and an old floor plan file
   * and brochure that the new run must replace. Committed, like the publishing clone holds it.
   */
  const seed = (r, { price = PRICED, sha = null, intake = {}, unit = null } = {}) => {
    const pdfSha256 = sha ?? crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
    const img = (n) => ({ src: `/listings/${SLUG}/0${n}.jpg`, thumb: `/listings/${SLUG}/0${n}-thumb.webp`, alt: { en: `Photo ${n}`, ar: `صورة ${n}` } });
    const listing = {
      id: 'BONA-W023', slug: SLUG, sourceRef: 'WA-20261101-AC7D06', status: 'reserved', category: 'off-plan', type: 'apartment', kind: 'apartment',
      featured: true, title: { en: 'Jeddah Heights — corrected by hand', ar: 'جدة هايتس — تصحيح يدوي' },
      location: { ...PLACE, district: { en: 'Al Rehab', ar: 'الرحاب' } }, price,
      specs: { beds: 2, baths: 2, areaSqm: 88, plotSqm: null, yearBuilt: null, floors: null },
      images: [1, 2, 3, 4].map(img), videos: [{ src: `/listings/${SLUG}/v-01.mp4`, poster: null }],
      description: { en: 'Hand-written one.\n\nHand-written two.', ar: 'فقرة أولى.\n\nفقرة ثانية.' },
      highlights: { en: ['A', 'B', 'C', 'D'], ar: ['أ', 'ب', 'ج', 'د'] }, virtualTourUrl: null,
      brochureUrl: `https://bona-real-estate.com/listings/${SLUG}/brochure.pdf`,
      project: { name: { en: 'Jeddah Heights', ar: 'جدة هايتس' }, developer: { en: 'NHC', ar: 'الوطنية للإسكان' } }, unit,
      map: null, mapPrecision: null, listedAt: '2026-11-01', hidden: false,
      licence: { adNumber: '7200123', adExpiry: null, wafiNumber: null, escrowAccount: null },
      photoNote: { en: 'Photos show the sister project', ar: 'الصور للمشروع الشقيق' },
      faq: [{ q: { en: 'Q1', ar: 'س١' }, a: { en: 'A1', ar: 'ج١' } }], seoTitle: { en: 'SEO', ar: 'عنوان' },
      _intake: { source: 'whatsapp', pdfSha256, model: 'opus', confidence: 0.8, warnings: ['map-unconfirmed'], images: [], createdAt: '2026-11-01T10:00:00.000Z', site: 'https://bona-real-estate.com', ...intake },
    };
    fs.mkdirSync(path.dirname(inboxFile(r)), { recursive: true });
    fs.writeFileSync(inboxFile(r), `${JSON.stringify(listing, null, 2)}\n`);
    fs.writeFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', '_index.json'), `${JSON.stringify({ nextSeq: 30, listings: { [SLUG]: 'BONA-W023' } }, null, 2)}\n`);
    fs.mkdirSync(pubDir(r), { recursive: true });
    for (const f of [...PHOTOS, 'v-01.mp4']) fs.writeFileSync(path.join(pubDir(r), f), `first run ${f}`);
    for (const f of ['plan-03.jpg', 'plan-03-thumb.webp']) fs.writeFileSync(path.join(pubDir(r), f), 'old plan');
    fs.writeFileSync(path.join(pubDir(r), 'brochure.pdf'), 'old brochure');
    git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: Jeddah Heights (BONA-W023)');
    // Corrected by hand afterwards — exactly what --replace refuses to undo.
    for (const f of [...PHOTOS, 'v-01.mp4']) fs.writeFileSync(path.join(pubDir(r), f), `hand-made ${f}`);
    git(r, 'commit', '-qam', 'photos re-cropped by hand');
    return listing;
  };
  const without = (l, keys) => Object.fromEntries(Object.entries(l).filter(([k]) => !keys.includes(k)));
  const saved = (r) => JSON.parse(fs.readFileSync(inboxFile(r), 'utf8'));
  const enrich = (r, { dryRun = false, caption = {} } = {}) => processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption, workDir: path.join(r.repo, '..', 'work'), dryRun, meta: { ...META } });

  it('(a) adds the models, plan and brochure to a hand-corrected listing; its photos, copy and every other key stay byte for byte', async () => {
    const r = await rig({ listing: reading() });
    try {
      const before = seed(r);
      const rawBefore = fs.readFileSync(inboxFile(r), 'utf8');
      const report = await enrich(r);
      assert.equal(report.ok, true);
      assert.equal(report.id, 'BONA-W023');
      assert.equal(report.enrich.headline, 'kept');
      // Photos, video: the same bytes.
      for (const f of [...PHOTOS, 'v-01.mp4']) assert.equal(fs.readFileSync(path.join(pubDir(r), f), 'utf8'), `hand-made ${f}`, f);
      // The old plan is gone, the new one is a real JPEG + WebP; the brochure is the new one.
      const files = fs.readdirSync(pubDir(r)).sort();
      assert.deepEqual(files.filter((f) => f.startsWith('plan-')), ['plan-01-thumb.webp', 'plan-01.jpg']);
      const sharp = (await import('sharp')).default;
      assert.equal((await sharp(path.join(pubDir(r), 'plan-01.jpg')).metadata()).format, 'jpeg');
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'brochure.pdf'), 'utf8'), '%PDF-1.7 fake brochure\n');
      assert.ok(!files.some((f) => f.includes('.tmp')), files.join(' '));
      // The brochure was drawn from the MERGED listing, out of the repo's own folder.
      const call = r.calls().find((c) => c.tool === 'brochure');
      assert.equal(call.filesDir, pubDir(r));
      assert.equal(call.listing.title.en, 'Jeddah Heights — corrected by hand');
      assert.ok(call.files.includes('plan-01.jpg') && !call.files.includes('plan-03.jpg'), call.files.join(' '));
      assert.equal(call.listing.models.length, 2);
      // The inbox JSON: models, fact lists, brochureUrl — and nothing else.
      const after = saved(r);
      assert.deepEqual(after.models.map((m) => [m.name.en, m.price, m.subsidisedPrice, m.floorPlan?.src ?? null]),
        [['Nawras', 419994, 356024, `/listings/${SLUG}/plan-01.jpg`], ['Lulu', 319015, 270425, null]]);
      assert.deepEqual(after.amenities, { en: ['Health club'], ar: ['نادٍ صحي'] });
      assert.equal('nearby' in after, false);
      assert.equal(after.brochureUrl, `https://bona-real-estate.com/listings/${SLUG}/brochure.pdf`);
      assert.equal(JSON.stringify(without(after, ENRICHED), null, 2), JSON.stringify(without(before, ENRICHED), null, 2), 'every other key, in order, unchanged');
      const lines = (s) => new Set(s.split('\n'));
      const kept = [...lines(rawBefore)].filter((l) => !lines(fs.readFileSync(inboxFile(r), 'utf8')).has(l));
      assert.deepEqual(kept, [], 'every line of the old file is still in the new one');
      assert.deepEqual(checkListing(after), []);
      // Commit-ready: only the intake's own paths changed, the index untouched.
      const status = git(r, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map((l) => l.slice(3));
      assert.ok(status.length > 0);
      for (const p of status) assert.match(p, new RegExp(`^(public/listings/${SLUG}/|scripts/curate/inbox/${SLUG}\\.json$)`), p);
      // No headline check and no photo-region call: the copy and photos are not published.
      assert.deepEqual(r.calls().filter((c) => c.tool.startsWith('claude')).map((c) => c.tool), ['claude-listing', 'claude-model-confirm']);
    } finally { r.cleanup(); }
  });

  it('(b) a price that is not the models\' lowest is refused with both figures, and nothing is changed', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false } });
      await assert.rejects(enrich(r), (err) => err.stage === 'enrich'
        && /BONA-W023 shows SAR 350,000 but the brochure's lowest model price is SAR 319,015/.test(err.reason)
        && /send `price BONA-W023 …` or re-run with --replace/.test(err.reason));
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'plan-03.jpg'), 'utf8'), 'old plan');
      assert.equal(r.calls().filter((c) => c.tool === 'brochure').length, 0);
    } finally { r.cleanup(); }
  });

  it('(c) a listing on request adopts the models\' confirmed headline', async () => {
    const r = await rig({ listing: reading() });
    try {
      const before = seed(r, { price: { ...ON_REQUEST } });
      const report = await enrich(r);
      assert.equal(report.enrich.headline, 'adopted');
      const after = saved(r);
      assert.deepEqual(after.price, PRICED);
      assert.equal(JSON.stringify(without(after, [...ENRICHED, 'price'])), JSON.stringify(without(before, [...ENRICHED, 'price'])));
      assert.deepEqual(checkListing(after), []);
    } finally { r.cleanup(); }
  });

  it('(d) the owner\'s own price stays; the models are published without prices and never checked', async () => {
    const r = await rig({ listing: reading() });
    try {
      const own = { amount: 300000, currency: 'SAR', from: false, period: null, onRequest: false };
      seed(r, { price: own, intake: { edits: ['price'] } });
      const report = await enrich(r);
      assert.equal(report.enrich.headline, 'owner-price');
      const after = saved(r);
      assert.deepEqual(after.price, own);
      assert.deepEqual(after.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null]]);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-model-confirm').length, 0, 'no figure is checked that will not be published');
      assert.deepEqual(after._intake.edits, ['price']);
      assert.deepEqual(checkListing(after), []);
    } finally { r.cleanup(); }
  });

  it('(e) a PDF that is not the one the listing was published from is refused before anything is read', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { sha: 'b'.repeat(64) });
      await assert.rejects(enrich(r), /this PDF is not the one BONA-W023 was published from/);
      assert.equal(fs.existsSync(path.join(r.repo, '..', 'bin', 'calls.jsonl')), false, 'no extraction, no model call');
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
    } finally { r.cleanup(); }
  });

  it('(f) a failed rebuild rolls everything back: the old plan and brochure return, the new plan goes', async () => {
    const r = await rig({ listing: reading(), build: 'process.exit(1);\n' });
    try {
      seed(r);
      const raw = fs.readFileSync(inboxFile(r), 'utf8');
      await assert.rejects(enrich(r), (err) => err.rolledBack === true);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '', 'the clone is back to the commit');
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'plan-03.jpg'), 'utf8'), 'old plan');
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'brochure.pdf'), 'utf8'), 'old brochure');
      assert.equal(fs.existsSync(path.join(pubDir(r), 'plan-01.jpg')), false);
      assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
    } finally { r.cleanup(); }
  });

  it('a brochure that cannot be built keeps the enrichment, the old brochure, and says so', async () => {
    const r = await rig({ listing: reading(), brochureFail: true });
    try {
      const before = seed(r);
      const report = await enrich(r);
      assert.equal(report.brochure.ok, false);
      assert.ok(report.warnings.some((w) => /brochure could not be built/.test(w)), report.warnings.join(' | '));
      const after = saved(r);
      assert.equal(after.models.length, 2);
      assert.equal(after.brochureUrl, before.brochureUrl);
      assert.deepEqual(after._intake.warnings, ['map-unconfirmed', 'brochure-failed']);
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'brochure.pdf'), 'utf8'), 'old brochure');
    } finally { r.cleanup(); }
  });

  it('a dry run says what would change and writes nothing', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const report = await enrich(r, { dryRun: true });
      assert.equal(report.dryRun, true);
      assert.equal(report.enrich.models, 2);
      assert.equal(report.enrich.headline, 'adopted');
      assert.deepEqual(report.enrich.price, PRICED);
      assert.deepEqual(report.enrich.plans, [`/listings/${SLUG}/plan-01.jpg`]);
      assert.deepEqual(report.enrich.removedPlans, ['plan-03-thumb.webp', 'plan-03.jpg']);
      assert.deepEqual(report.listingPreview.price, PRICED);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(r.calls().filter((c) => c.tool === 'brochure').length, 0);
    } finally { r.cleanup(); }
  });

  it('a dry run of a refused headline shows the refusal instead of throwing', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false } });
      const report = await enrich(r, { dryRun: true });
      assert.equal(report.enrich.headline, 'refused');
      assert.match(report.blocked, /shows SAR 350,000/);
    } finally { r.cleanup(); }
  });

  it('a listing with local edits is refused before the model is paid', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      fs.writeFileSync(path.join(pubDir(r), '01.jpg'), 'edited, not committed');
      await assert.rejects(enrich(r), /uncommitted changes \(or is not in git\)/);
      assert.equal(fs.existsSync(path.join(r.repo, '..', 'bin', 'calls.jsonl')), false);
    } finally { r.cleanup(); }
  });

  it('a hidden listing is refused', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { intake: {} });
      const l = JSON.parse(fs.readFileSync(inboxFile(r), 'utf8'));
      fs.writeFileSync(inboxFile(r), `${JSON.stringify({ ...l, hidden: true }, null, 2)}\n`);
      git(r, 'commit', '-qam', 'hide (BONA-W023)');
      await assert.rejects(enrich(r), /it is hidden/);
    } finally { r.cleanup(); }
  });

  it('one specific unit keeps its own price while its models keep theirs', async () => {
    const r = await rig({ listing: reading() });
    try {
      const own = { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false };
      seed(r, { price: own, unit: { floor: 3, block: 'H', unitRef: null } });
      await enrich(r);
      const after = saved(r);
      assert.deepEqual(after.price, own);
      assert.deepEqual(after.models.map((m) => m.price), [419994, 319015]);
      assert.deepEqual(checkListing(after), []);
    } finally { r.cleanup(); }
  });

  /** run-once.mjs itself, pointed at the rig's fake extractor, `claude` and brochure renderer. */
  const runOnce = (r, ...args) => {
    const bin = path.join(r.repo, '..', 'bin');
    const data = path.join(r.repo, '..', 'data');
    fs.mkdirSync(data, { recursive: true });
    const env = {
      ...process.env, BONA_DATA: data, BONA_REPO: r.repo, BONA_CLAUDE_BIN: r.cfg.claudeBin, BONA_MIN_IMAGE_SIDE: '100',
      BONA_PY_CMD: r.cfg.pyCmd.join(' '), BONA_BROCHURE_PY_CMD: r.cfg.brochurePyCmd.join(' '), BONA_SITE: 'https://bona-real-estate.com',
      // The rig's own bare remote, whatever ~/.secrets/bona-services.env says.
      BONA_GIT_REMOTE: 'origin', BONA_GIT_BRANCH: 'main',
    };
    assert.ok(fs.existsSync(bin));
    try {
      const out = execFileSync(process.execPath, [path.join(REPO, 'services', 'intake', 'run-once.mjs'), r.pdfPath, '--repo', r.repo, '--work', path.join(data, 'work'), ...args], { env, stdio: 'pipe' });
      return { status: 0, out: out.toString() };
    } catch (err) { return { status: err.status, out: `${err.stdout}${err.stderr}` }; }
  };

  it('run-once --enrich --dry-run prints the models, the headline decision and the plan files, and writes nothing', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const { status, out } = runOnce(r, '--enrich', 'BONA-W023', '--dry-run');
      assert.equal(status, 0, out);
      assert.match(out, /Models {5}2 — 2 priced · prices kept 4 \/ refused 0/);
      assert.match(out, /Headline {3}adopted — was on request: the models' confirmed headline is adopted/);
      assert.match(out, /after {2}SAR 319,015 \(from\) · Sakani beneficiaries SAR 270,425/);
      assert.match(out, new RegExp(`Plans {6}/listings/${SLUG}/plan-01\\.jpg {2}\\(removing plan-03-thumb\\.webp plan-03\\.jpg\\)`));
      assert.match(out, /DRY RUN — nothing written/);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
    } finally { r.cleanup(); }
  });

  it('run-once --enrich commits "intake: enrich <title> (<id>) — unit models + brochure" with the listing\'s own paths, and pushes', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      const remote = path.join(r.repo, '..', 'remote.git');
      execFileSync('git', ['init', '-q', '--bare', remote]);
      git(r, 'branch', '-M', 'main');
      git(r, 'remote', 'add', 'origin', remote);
      git(r, 'push', '-q', 'origin', 'main');
      const { status, out } = runOnce(r, '--enrich', 'BONA-W023');
      assert.equal(status, 0, out);
      assert.match(out, /Headline {3}kept — equals the lowest model price: kept/);
      const line = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.event === 'intake.enrich');
      assert.deepEqual([line.models, line.kept, line.refused, line.headline], [2, 4, 0, 'kept'], 'one JSON log line says what the run did');
      assert.match(out, /brochure rebuilt/);
      assert.match(out, /Pushed [0-9a-f]+/);
      const log = execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: remote }).toString().trim();
      assert.equal(log, 'intake: enrich Jeddah Heights — corrected by hand (BONA-W023) — unit models + brochure');
      const files = execFileSync('git', ['show', '--name-only', '--format=', 'main'], { cwd: remote }).toString().split('\n').filter(Boolean).sort();
      assert.deepEqual(files, [
        `public/listings/${SLUG}/brochure.pdf`, `public/listings/${SLUG}/plan-01-thumb.webp`, `public/listings/${SLUG}/plan-01.jpg`,
        `public/listings/${SLUG}/plan-03-thumb.webp`, `public/listings/${SLUG}/plan-03.jpg`, `scripts/curate/inbox/${SLUG}.json`,
      ]);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
    } finally { r.cleanup(); }
  });

  it('run-once --enrich: a refused headline is "WOULD BE REJECTED" in a dry run and "REJECTED at enrich" for real, with nothing written', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false } });
      const dry = runOnce(r, '--enrich', 'BONA-W023', '--dry-run');
      assert.equal(dry.status, 0, dry.out);
      assert.match(dry.out, /Headline {3}refused — REFUSED/);
      assert.match(dry.out, /WOULD BE REJECTED — BONA-W023 shows SAR 350,000 but the brochure's lowest model price is SAR 319,015/);
      const remote = path.join(r.repo, '..', 'remote.git');
      execFileSync('git', ['init', '-q', '--bare', remote]);
      git(r, 'branch', '-M', 'main'); git(r, 'remote', 'add', 'origin', remote); git(r, 'push', '-q', 'origin', 'main');
      const real = runOnce(r, '--enrich', 'BONA-W023');
      assert.equal(real.status, 1);
      assert.match(real.out, /REJECTED at "enrich": BONA-W023 shows SAR 350,000/);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(git(r, 'rev-parse', 'HEAD'), execFileSync('git', ['rev-parse', 'main'], { cwd: remote }).toString(), 'nothing committed or pushed');
    } finally { r.cleanup(); }
  });

  it('run-once --enrich refuses a dirty publishing clone instead of discarding its changes', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      fs.writeFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', '_index.json'), '{"unsaved": true}\n');
      const { status, out } = runOnce(r, '--enrich', 'BONA-W023');
      assert.equal(status, 1);
      assert.match(out, /has uncommitted changes, which --enrich will not discard/);
      assert.match(fs.readFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', '_index.json'), 'utf8'), /unsaved/);
    } finally { r.cleanup(); }
  });

  it('a listing the intake enriched can still be replaced later (an enrich commit is the intake\'s own)', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      git(r, 'reset', '-q', '--hard', 'HEAD~1'); // drop the hand-fix commit: a listing only the intake ever touched
      await enrich(r);
      git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: enrich Jeddah Heights (BONA-W023) — unit models + brochure');
      const { changedSincePublished } = await import('../lib/publish.mjs');
      assert.equal(await changedSincePublished(r.repo, [path.join('scripts', 'curate', 'inbox', `${SLUG}.json`), path.join('public', 'listings', SLUG)]), null);
    } finally { r.cleanup(); }
  });
});

describe('run-once --enrich: the CLI guards', () => {
  const cli = (...args) => {
    try {
      execFileSync(process.execPath, [path.join(REPO, 'services', 'intake', 'run-once.mjs'), path.join(REPO, 'package.json'), ...args], { stdio: 'pipe' });
      return { status: 0, out: '' };
    } catch (err) { return { status: err.status, out: `${err.stdout}${err.stderr}` }; }
  };

  it('--enrich and --replace together: exit 2', () => {
    const r = cli('--enrich', 'BONA-W023', '--replace', 'BONA-W023', '--dry-run');
    assert.equal(r.status, 2);
    assert.match(r.out, /--enrich and --replace do not go together/);
  });

  it('--enrich with --no-git (and no --dry-run) is refused', () => {
    const r = cli('--no-git', '--enrich', 'BONA-W023');
    assert.equal(r.status, 2);
    assert.match(r.out, /--enrich needs git/);
  });

  it('--enrich takes no caption: the price comes from the listing', () => {
    const r = cli('--enrich', 'BONA-W023', '--caption', 'SAR 300000', '--dry-run');
    assert.equal(r.status, 2);
    assert.match(r.out, /--enrich takes no --caption/);
  });

  it('--enrich with no id is a usage error — also when the next word is another flag', () => {
    for (const args of [['--dry-run', '--enrich'], ['--enrich', '--dry-run']]) {
      const r = cli(...args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.out, /--enrich needs a listing id/);
    }
  });
});
