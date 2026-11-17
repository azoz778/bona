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
    return { index, file, abs: put(file), width: 1200, height: 900, page: 1 + index, source: 'embedded', coverage: 0.5 };
  });
  out = { ok: true, pages: cfg.pageText.length, text: cfg.pageText.join('\\n'), pageText: cfg.pageText, candidates,
    rendered: false, embeddedImageCount: candidates.length, links: [], meta: {} };
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
if (prompt.includes('VISIBLY PRINT')) {
  const amount = Number((prompt.match(/VISIBLY PRINT[^\\d]*(\\d+)/) || [])[1]);
  const subsidised = /VISIBLY PRINT the price for housing-subsidy/.test(prompt);
  fs.appendFileSync(log, JSON.stringify({ tool: 'claude-confirm', amount, subsidised, project: /unit models/.test(prompt), mirror: /only the price for everyone else counts/.test(prompt),
    subject: (prompt.match(/listing this price is for[^\\n]*\\n([^\\n]*)/) || [])[1] ?? null }) + '\\n');
  answer = { confirmed: ((subsidised ? cfg.confirmSub : null) ?? cfg.confirm ?? []).includes(amount) };
} else {
  fs.appendFileSync(log, JSON.stringify({ tool: 'claude-listing', prompt }) + '\\n');
  answer = cfg.listing;
}
process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify(answer), total_cost_usd: 0, duration_ms: 1, num_turns: 1, session_id: 'fake' }));
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

async function rig({ pageText = BROCHURE, listing, confirm = [], confirmSub = null, build = '' }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bona-price-pages-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const photo = path.join(bin, 'photo.jpg');
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#4a6b8a' } }).jpeg().toFile(photo);
  fs.writeFileSync(path.join(bin, 'fake.json'), JSON.stringify({ photo, pageText, listing, confirm, confirmSub }));
  fs.writeFileSync(path.join(bin, 'fake-py.mjs'), FAKE_PY);
  fs.writeFileSync(path.join(bin, 'fake-claude.mjs'), FAKE_CLAUDE);
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
    claudeModel: 'opus', claudeFallbackModel: null, claudeTimeoutMs: 60000,
  };
  const calls = () => fs.readFileSync(path.join(bin, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const run = () => processPdf({ pdfPath, cfg, caption: {}, workDir: path.join(dir, 'work'), dryRun: true });
  const publish = (meta = {}) => processPdf({ pdfPath, cfg, caption: { noBrochure: true }, workDir: path.join(dir, 'work'), meta });
  return { run, publish, calls, repo, pdfPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
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
    if (commit) { git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'published'); }
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
    if (commit) { git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'published'); }
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
      assert.match(first.subject, /Jeddah Heights, Al Hamdaniyah — unit H-12, block H, floor 3 — a price printed for a different unit does not count/);
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
    git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'published');
    return file;
  };

  it('refuses a listing that was corrected by hand after it was published', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015] });
    try {
      const file = seed(r);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Al Rawabi', 'Al Rehab'));
      git(r, 'commit', '-qam', 'district fix by hand');
      await assert.rejects(r.publish(META), /changed since it was published \(2 commits\)/);
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
});
