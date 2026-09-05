// The AI contract gate. Nothing here talks to a model — a stub child process stands in for
// `claude -p`, so the retry/fallback logic is exercised without spending a token.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildPrompt, copyProblems, HYPE_WORDS, PROMPT_TEMPLATE, ROOM_KEYS, runListingAi, validateAiResult,
} from '../lib/claude.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const GOOD = {
  reject: false,
  rejectReason: null,
  confidence: 0.8,
  warnings: [],
  listing: {
    title: { en: 'Five-Bedroom Villa', ar: 'فيلا بخمس غرف نوم' },
    type: 'villa',
    category: 'buy',
    location: {
      district: { en: 'Al Khalidiyah', ar: 'الخالدية' },
      city: { en: 'Jeddah', ar: 'جدة' },
      country: { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' },
      countryCode: 'SA',
    },
    price: { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 6, areaSqm: 537, plotSqm: null, yearBuilt: null, floors: null },
    description: { en: ['One.', 'Two.'], ar: ['واحد.', 'اثنان.'] },
    highlights: { en: ['A', 'B', 'C', 'D'], ar: ['أ', 'ب', 'ج', 'د'] },
    project: null,
    unit: null,
  },
  images: [
    { index: 0, room: 'pool', rank: 1, hero: true, exclude: false, reason: 'wide pool' },
    { index: 1, room: 'living', rank: 2, hero: false, exclude: false, reason: 'living' },
  ],
};

const clone = () => structuredClone(GOOD);

describe('validateAiResult', () => {
  it('accepts a well-formed result', () => {
    assert.deepEqual(validateAiResult(clone(), { candidateCount: 2 }), []);
  });

  it('accepts a rejection with a reason', () => {
    assert.deepEqual(validateAiResult({ reject: true, rejectReason: 'this is an invoice' }), []);
  });

  it('refuses a rejection with no reason', () => {
    assert.ok(validateAiResult({ reject: true, rejectReason: null }).some((p) => /rejectReason/.test(p)));
  });

  const bad = [
    ['transliterated Arabic', (r) => { r.listing.title.ar = 'Villa Khamsa'; }, /title/],
    ['an unknown type', (r) => { r.listing.type = 'castle'; }, /type/],
    ['an unknown category', (r) => { r.listing.category = 'lease'; }, /category/],
    ['a price with no amount and no onRequest', (r) => { r.listing.price.amount = null; }, /amount must be > 0/],
    ['a guessed spec that is not a number', (r) => { r.listing.specs.beds = 'five'; }, /specs.beds/],
    ['a one-paragraph description', (r) => { r.listing.description.en = ['Only one.']; }, /description.en/],
    ['three highlights', (r) => { r.listing.highlights.en = ['A', 'B', 'C']; r.listing.highlights.ar = ['أ', 'ب', 'ج']; }, /highlights.en/],
    ['mismatched highlight counts', (r) => { r.listing.highlights.en.push('E'); }, /same length/],
    ['a bad room key', (r) => { r.images[0].room = 'jacuzzi'; }, /unknown room key/],
    ['two heroes', (r) => { r.images[1].hero = true; }, /more than one hero/],
    ['a hero that is not ranked 1', (r) => { r.images[0].hero = false; r.images[1].hero = true; }, /hero must be the image ranked 1/],
    ['a duplicate index', (r) => { r.images[1].index = 0; }, /duplicate index/],
    ['an out-of-range index', (r) => { r.images[1].index = 99; }, /bad index/],
    ['a missing confidence', (r) => { delete r.confidence; }, /confidence/],
    ['a rent listing with no period', (r) => { r.listing.category = 'rent'; r.listing.price.period = null; }, /price.period/],
    ['a bad project shape', (r) => { r.listing.project = { name: 'Kian' }; }, /project must be null/],
  ];
  for (const [label, mutate, re] of bad) {
    it(`refuses ${label}`, () => {
      const r = clone();
      mutate(r);
      const problems = validateAiResult(r, { candidateCount: 2 });
      assert.ok(problems.some((p) => re.test(p)), `expected ${re} in ${JSON.stringify(problems)}`);
    });
  }

  it('accepts price on request with a null amount', () => {
    const r = clone();
    r.listing.price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
    assert.deepEqual(validateAiResult(r, { candidateCount: 2 }), []);
  });
});

describe('copyProblems — owner rules', () => {
  it('is clean for good copy', () => {
    assert.deepEqual(copyProblems(GOOD.listing), []);
  });
  it('catches the old brand anywhere in the copy', () => {
    for (const [field, mutate] of [
      ['title', (l) => { l.title.en = 'Villa sold through TK'; }],
      ['description', (l) => { l.description.en = ['Listed by TK Estates.', 'Two.']; }],
      ['highlight', (l) => { l.highlights.en[0] = 'tk-estates.com'; }],
      ['project name', (l) => { l.project = { name: { en: 'TK Prime', ar: 'تي كي' }, developer: { en: 'X', ar: 'س' } }; }],
    ]) {
      const l = structuredClone(GOOD.listing);
      mutate(l);
      assert.ok(copyProblems(l).length > 0, `${field} should be caught`);
    }
  });
  it('catches a phone number', () => {
    const l = structuredClone(GOOD.listing);
    l.description.en = ['Call +966 59 329 6933.', 'Two.'];
    assert.ok(copyProblems(l).some((p) => /description/.test(p)));
  });
  it('catches every hype word the site validator bans', () => {
    for (const word of HYPE_WORDS) {
      const l = structuredClone(GOOD.listing);
      l.description.en = [`A ${word} property.`, 'Two.'];
      assert.ok(copyProblems(l).some((p) => p.includes(word)), `${word} should be caught`);
    }
  });
  it('agrees with the hype list in scripts/curate/validate.mjs', () => {
    const validator = fs.readFileSync(path.join(REPO, 'scripts', 'curate', 'validate.mjs'), 'utf8');
    const line = /const HYPE = \/\\b\(([^)]+)\)/.exec(validator);
    assert.ok(line, 'could not find the HYPE regex in validate.mjs');
    const words = line[1].split('|').map((w) => w.replace(/\\/g, '').trim());
    assert.deepEqual(words.sort(), [...HYPE_WORDS].sort());
  });
});

describe('buildPrompt', () => {
  const extraction = {
    pages: 3,
    meta: { title: 'Brochure' },
    pageText: ['page one text', 'page two text', ''],
    candidates: [
      { index: 0, abs: '/tmp/x/000.jpg', width: 1600, height: 1067, page: 1, source: 'embedded' },
      { index: 1, abs: '/tmp/x/001.jpg', width: 900, height: 1200, page: 2, source: 'embedded' },
    ],
  };
  const sheets = [{ file: '/tmp/x/sheets/contact-sheet-1.jpg', from: 0, to: 1 }];

  it('fills every placeholder', () => {
    const p = buildPrompt({ extraction, sheets, caption: { text: 'rent', category: 'rent', period: 'year' } });
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(p), `unfilled placeholder in prompt: ${/\{\{[A-Z_]+\}\}/.exec(p)}`);
    assert.ok(p.includes('/tmp/x/sheets/contact-sheet-1.jpg'));
    assert.ok(p.includes('/tmp/x/000.jpg'));
    assert.ok(p.includes('page two text'));
    assert.ok(p.includes('the category is: rent'));
  });

  it('states the TAQEEM rule and offers the room vocabulary', () => {
    const p = buildPrompt({ extraction, sheets, caption: {} });
    assert.match(p, /TAQEEM/);
    assert.match(p, /Never estimate a price/);
    assert.ok(ROOM_KEYS.every((k) => p.includes(k)), 'every room key must be offered');
    assert.match(p, /No price in the caption/);
  });

  it('passes an explicit caption price straight through', () => {
    const p = buildPrompt({ extraction, sheets, caption: { text: 'SAR 4,500,000', price: { amount: 4500000, currency: 'SAR' } } });
    assert.match(p, /4500000 SAR/);
  });

  it('prefers a repo rubric over the built-in default', () => {
    const rubric = path.join(REPO, 'services', 'intake', 'test', 'tmp-rubric.md');
    fs.writeFileSync(rubric, 'HOUSE RUBRIC MARKER');
    try {
      assert.match(buildPrompt({ extraction, sheets, caption: {}, rubricPath: rubric }), /HOUSE RUBRIC MARKER/);
    } finally {
      fs.rmSync(rubric, { force: true });
    }
  });

  it('the template file is the one the code documents', () => {
    assert.ok(fs.existsSync(PROMPT_TEMPLATE));
    assert.match(PROMPT_TEMPLATE, /services\/intake\/lib\/prompt\.md$/);
  });
});

/** A fake `claude -p`: emits the given stdout and exit code. */
function fakeSpawn(responses) {
  const calls = [];
  return {
    calls,
    spawnImpl(bin, args) {
      const r = responses[calls.length] ?? responses[responses.length - 1];
      calls.push({ bin, args, model: args[args.indexOf('--model') + 1] });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(r.envelope)));
        child.emit('close', r.code ?? 0);
      });
      return child;
    },
  };
}

const envelope = (result, extra = {}) => ({ is_error: false, result: typeof result === 'string' ? result : JSON.stringify(result), total_cost_usd: 0.03, duration_ms: 1000, num_turns: 2, session_id: 's', ...extra });

describe('runListingAi', () => {
  const opts = { prompt: 'p', cwd: '/tmp', model: 'sonnet', fallbackModel: 'opus', candidateCount: 2 };

  it('returns a good first answer', async () => {
    const f = fakeSpawn([{ envelope: envelope(GOOD) }]);
    const { result, attempt } = await runListingAi({ ...opts, spawnImpl: f.spawnImpl });
    assert.equal(attempt, 1);
    assert.equal(result.listing.title.en, 'Five-Bedroom Villa');
    assert.equal(f.calls.length, 1);
  });

  it('unwraps a fenced JSON answer', async () => {
    const f = fakeSpawn([{ envelope: envelope(`Here you go:\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\`\n`) }]);
    const { result } = await runListingAi({ ...opts, spawnImpl: f.spawnImpl });
    assert.equal(result.confidence, 0.8);
  });

  it('retries with a repair prompt, then falls back to the second model', async () => {
    const broken = clone();
    broken.listing.type = 'castle';
    const f = fakeSpawn([
      { envelope: envelope(broken) },
      { envelope: envelope(broken) },
      { envelope: envelope(GOOD) },
    ]);
    const { attempt } = await runListingAi({ ...opts, spawnImpl: f.spawnImpl });
    assert.equal(attempt, 3);
    assert.deepEqual(f.calls.map((c) => c.model), ['sonnet', 'sonnet', 'opus']);
  });

  it('refuses copy that breaks the owner rules even when the shape is valid', async () => {
    const tk = clone();
    tk.listing.description.en = ['Marketed by TK Estates.', 'Two.'];
    const f = fakeSpawn([{ envelope: envelope(tk) }]);
    await assert.rejects(() => runListingAi({ ...opts, spawnImpl: f.spawnImpl }), /contract/);
    assert.equal(f.calls.length, 3, 'it should have used every attempt before giving up');
  });

  it('gives up immediately on a quota error instead of burning attempts', async () => {
    const f = fakeSpawn([{ code: 1, envelope: { is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 1am" } }]);
    await assert.rejects(() => runListingAi({ ...opts, spawnImpl: f.spawnImpl }), /session limit/);
    assert.equal(f.calls.length, 1);
  });

  it('passes the verified flags, including --safe-mode', async () => {
    const f = fakeSpawn([{ envelope: envelope(GOOD) }]);
    await runListingAi({ ...opts, addDirs: ['/tmp/work'], spawnImpl: f.spawnImpl });
    const { args } = f.calls[0];
    for (const flag of ['-p', '--output-format', '--allowedTools', '--permission-mode', '--safe-mode', '--strict-mcp-config']) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read', 'the model must only be able to Read');
    assert.equal(args[args.indexOf('--add-dir') + 1], '/tmp/work');
  });
});
