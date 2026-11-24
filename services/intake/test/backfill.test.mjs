// The backfill (backfill-enrich.mjs + lib/backfill.mjs): which published listings are enriched,
// which only get their brochure rebuilt, which are left alone — and how the CLI drives run-once:
// one job at a time, with the right argv, stopping on a FAILED job or a quota, never on a refusal.
//
// The CLI tests point it at a stand-in run-once (the hidden `--run-once <path>`) and a stand-in
// brochure renderer (BONA_BROCHURE_PY_CMD), over a real git clone with a bare origin. Everything is
// written under ~/.cache/bona-tests — never /tmp, which is RAM on this host.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  QUOTA_RE, classifyRun, formatPlanTable, makePdfFinder, parseOnly, planBackfill, resumeCommand, stopsBackfill, summarizeRun, unknownIds,
} from '../lib/backfill.mjs';
import { buildBrandedBrochure, findSourcePdf } from '../lib/brochure.mjs';
import { registerWithdrawals } from '../../../scripts/curate/rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'backfill-enrich.mjs');
const TEST_ROOT = path.join(os.homedir(), '.cache', 'bona-tests');
const scratch = (prefix) => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(TEST_ROOT, prefix)));
};
const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');
const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

const listing = (id, extra = {}) => ({
  id,
  slug: `slug-${id.toLowerCase()}`,
  status: 'available',
  title: { en: `Title of ${id}`, ar: 'عنوان' },
  price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true },
  _intake: { source: 'whatsapp', pdfSha256: sha(`pdf of ${id}`) },
  ...extra,
});

// ---------------------------------------------------------------- planBackfill
describe('planBackfill', () => {
  const PDFS = { [sha('pdf of BONA-W003')]: '/data/intake/2026-09-06/w3.pdf', [sha('pdf of BONA-W010')]: '/data/intake/2026-09-07/w10.pdf' };
  const asked = [];
  const findPdf = (s) => { asked.push(s); return PDFS[s] ?? null; };
  const withdrawals = registerWithdrawals({
    'BONA-W011': { status: 'withdrawn', withdrawnAdvertising: { at: '2026-11-10T09:00:00Z', reason: 'developer withdrew permission (fixture)' } },
  });
  const listings = [
    listing('BONA-W010'),                                                           // enrich
    listing('BONA-W003'),                                                           // enrich
    listing('BONA-W002'),                                                           // sha recorded, file gone
    listing('BONA-W004', { _intake: { source: 'whatsapp' } }),                      // no sha recorded
    listing('BONA-W005', { hidden: true }),
    listing('BONA-W009', { slug: 'elvira-murjan-townhouses-in-al-murjan', hidden: true, status: 'withdrawn' }), // rules.mjs record
    listing('BONA-W011'),                                                           // review-register flag
    listing('BONA-W012', { status: 'withdrawn' }),                                  // its own record says so
    listing('BONA-W013', { title: { en: 'Elvira Murjan Phase 2', ar: 'x' } }),      // the withdrawn project by NAME
    listing('BONA-015'),                                                            // a curated id
    listing('BONA-W100', { slug: '' }),
    listing('BONA-W001', { models: [{ name: 'A', price: 319015 }, { name: 'B', price: null }], _intake: { pdfSha256: sha('pdf of BONA-W010') } }),
  ];

  it('orders by id and gives every listing one action and a reason', () => {
    asked.length = 0;
    const plan = planBackfill(listings, { findPdf, withdrawals });
    assert.deepEqual(plan.map((r) => r.id), [
      'BONA-015', 'BONA-W001', 'BONA-W002', 'BONA-W003', 'BONA-W004', 'BONA-W005', 'BONA-W009', 'BONA-W010', 'BONA-W011', 'BONA-W012', 'BONA-W013', 'BONA-W100',
    ]);
    const by = Object.fromEntries(plan.map((r) => [r.id, r]));
    for (const r of plan) {
      assert.ok(['enrich', 'brochure-only', 'skip'].includes(r.action), r.id);
      assert.ok(r.reason, `${r.id} has a reason`);
      assert.deepEqual(Object.keys(r), ['id', 'slug', 'title', 'action', 'reason', 'pdf']);
    }
    assert.equal(by['BONA-W003'].action, 'enrich');
    assert.equal(by['BONA-W003'].pdf, '/data/intake/2026-09-06/w3.pdf');
    assert.equal(by['BONA-W003'].title, 'Title of BONA-W003');
    assert.equal(by['BONA-W003'].slug, 'slug-bona-w003');
    assert.equal(by['BONA-W010'].action, 'enrich');
    assert.equal(by['BONA-W002'].action, 'brochure-only');
    assert.match(by['BONA-W002'].reason, /not in the intake folder/);
    assert.equal(by['BONA-W002'].pdf, null);
    assert.equal(by['BONA-W004'].action, 'brochure-only');
    assert.match(by['BONA-W004'].reason, /no source PDF recorded/);
    assert.match(by['BONA-W001'].reason, /^already enriched \(2 unit model\(s\)\) — --include-enriched to enrich it again$/);
    assert.equal(by['BONA-W001'].action, 'skip');
    assert.equal(by['BONA-W001'].pdf, null);
  });

  it('a listing that already carries unit models is enriched again only with includeEnriched', () => {
    const by = Object.fromEntries(planBackfill(listings, { findPdf, withdrawals, includeEnriched: true }).map((r) => [r.id, r]));
    assert.equal(by['BONA-W001'].action, 'enrich');
    assert.match(by['BONA-W001'].reason, /source PDF found \(already has 2 unit model\(s\) — enriched again\)/);
    assert.equal(by['BONA-W010'].action, 'enrich', 'the others are planned as before');
    // An empty models list is not an enrichment.
    const empty = planBackfill([listing('BONA-W010', { models: [] })], { findPdf });
    assert.equal(empty[0].action, 'enrich');
  });

  it('Codex r1 #6a: a record whose slug is not a slug is skipped — never enriched or rebuilt', () => {
    for (const slug of ['../../outside', 'a/b', 'Upper-Case', 'trailing-', '.']) {
      const [row] = planBackfill([listing('BONA-W010', { slug }), listing('BONA-W002', { slug })].slice(0, 1), { findPdf });
      assert.equal(row.action, 'skip', slug);
      assert.match(row.reason, /not a valid slug/, slug);
      assert.equal(row.pdf, null);
    }
  });

  it('P6c: a listing that carries amenities, nearby or warranties (and no models) is already enriched too', () => {
    const facts = (k, en = ['Gym'], ar = ['نادٍ رياضي']) => ({ [k]: { en, ar } });
    const list = [
      listing('BONA-W010', facts('amenities')),
      listing('BONA-W003', { ...facts('nearby', ['Airport'], ['المطار']), ...facts('warranties', ['Structure — 10 years'], ['الهيكل — 10 سنوات']) }),
      listing('BONA-W002', { models: [{ name: 'A', price: 319015 }], ...facts('warranties', ['Structure — 10 years'], ['الهيكل — 10 سنوات']) }),
      listing('BONA-W004', { amenities: { en: [], ar: [] }, nearby: { en: [], ar: [] }, models: [] }),   // empty lists are not an enrichment
    ];
    asked.length = 0;
    const by = Object.fromEntries(planBackfill(list, { findPdf }).map((r) => [r.id, r]));
    assert.equal(by['BONA-W010'].action, 'skip');
    assert.match(by['BONA-W010'].reason, /^already enriched \(amenities\) — --include-enriched to enrich it again$/);
    assert.match(by['BONA-W003'].reason, /^already enriched \(nearby, warranties\) — /);
    assert.match(by['BONA-W002'].reason, /^already enriched \(1 unit model\(s\), warranties\) — /);
    assert.equal(by['BONA-W004'].action, 'brochure-only', 'empty lists: not enriched');
    assert.ok(!asked.includes(sha('pdf of BONA-W010')) && !asked.includes(sha('pdf of BONA-W003')), 'a skipped listing is not hashed for');
    const again = Object.fromEntries(planBackfill(list, { findPdf, includeEnriched: true }).map((r) => [r.id, r]));
    assert.equal(again['BONA-W010'].action, 'enrich');
    assert.match(again['BONA-W010'].reason, /^source PDF found \(already has amenities — enriched again\)$/);
    assert.match(again['BONA-W003'].reason, /^source PDF found \(already has nearby, warranties — enriched again\)$/);
  });

  it('M8: unit models that carry no price and no floor plan are not an enrichment — the listing is planned again (an earlier read may have been cut short)', () => {
    const bare = (n) => Array.from({ length: n }, (_, i) => ({ name: { en: `M${i}`, ar: 'م' }, price: null, subsidisedPrice: null, floorPlan: null }));
    const plan = { src: '/listings/slug-bona-w003/plan-01.jpg', thumb: '/listings/slug-bona-w003/plan-01-thumb.webp' };
    const list = [
      listing('BONA-W010', { models: bare(2) }),                                                               // nothing kept: planned
      listing('BONA-W002', { models: bare(1) }),                                                               // no PDF: brochure-only
      listing('BONA-W003', { models: [...bare(1), { ...bare(1)[0], floorPlan: plan }] }),                     // a plan: enriched
      listing('BONA-W004', { models: [{ ...bare(1)[0], subsidisedPrice: 270425 }], _intake: { pdfSha256: sha('pdf of BONA-W010') } }), // a Sakani price: enriched
      listing('BONA-W005', { models: bare(3), amenities: { en: ['Gym'], ar: ['نادٍ رياضي'] }, _intake: { pdfSha256: sha('pdf of BONA-W003') } }), // a fact list: enriched
    ];
    const by = Object.fromEntries(planBackfill(list, { findPdf }).map((r) => [r.id, r]));
    assert.equal(by['BONA-W010'].action, 'enrich');
    assert.equal(by['BONA-W010'].reason, 'source PDF found (its 2 unit model(s) carry no price or floor plan — enriched again)');
    assert.equal(by['BONA-W002'].action, 'brochure-only');
    assert.equal(by['BONA-W003'].action, 'skip');
    assert.match(by['BONA-W003'].reason, /^already enriched \(2 unit model\(s\)\) — /);
    assert.equal(by['BONA-W004'].action, 'skip');
    assert.match(by['BONA-W004'].reason, /^already enriched \(1 unit model\(s\)\) — /);
    assert.equal(by['BONA-W005'].action, 'skip');
    assert.match(by['BONA-W005'].reason, /^already enriched \(amenities\) — /, 'the bare models are not counted, the fact list is');
  });

  it('r5 #11: a listing published without the floor plans whose contact check did not finish (`plans-unchecked`) is planned for enrich, though already enriched', () => {
    const priced = () => [{ name: { en: 'A', ar: 'أ' }, price: 319015, subsidisedPrice: null, floorPlan: null }];
    const unchecked = (id, sha256 = sha(`pdf of ${id}`)) => listing(id, { models: priced(), _intake: { source: 'whatsapp', pdfSha256: sha256, warnings: ['map-unconfirmed', 'plans-unchecked'] } });
    const list = [
      unchecked('BONA-W010'),                                     // its PDF is here: enrich
      unchecked('BONA-W002'),                                     // its PDF is gone: left alone, and says why
      listing('BONA-W003', { models: priced() }),                 // no code: already enriched, as before
    ];
    asked.length = 0;
    const by = Object.fromEntries(planBackfill(list, { findPdf }).map((r) => [r.id, r]));
    assert.equal(by['BONA-W010'].action, 'enrich');
    assert.equal(by['BONA-W010'].pdf, '/data/intake/2026-09-07/w10.pdf');
    assert.equal(by['BONA-W010'].reason, 'source PDF found (published without its floor plans, left out because their contact check did not finish — enriched again)');
    assert.equal(by['BONA-W002'].action, 'skip', 'no PDF to read the plans from: never a pointless brochure-only rebuild');
    assert.equal(by['BONA-W002'].pdf, null);
    assert.match(by['BONA-W002'].reason, /^already enriched \(1 unit model\(s\)\) — published without its floor plans, left out because their contact check did not finish, but its source PDF is not in the intake folder$/);
    assert.equal(by['BONA-W003'].action, 'skip');
    assert.match(by['BONA-W003'].reason, /^already enriched \(1 unit model\(s\)\) — --include-enriched to enrich it again$/);
    assert.ok(!asked.includes(sha('pdf of BONA-W003')), 'a listing without the code is not hashed for');
    // --include-enriched: the same rows, enriched.
    const again = Object.fromEntries(planBackfill(list, { findPdf, includeEnriched: true }).map((r) => [r.id, r]));
    assert.equal(again['BONA-W010'].action, 'enrich');
    assert.equal(again['BONA-W010'].reason, 'source PDF found (published without its floor plans, left out because their contact check did not finish — enriched again)');
    // r6 #9: the plans were left out, never published unchecked — the plan table must not say otherwise.
    for (const row of [...Object.values(by), ...Object.values(again)]) assert.doesNotMatch(row.reason, /published unchecked/, row.id);
  });

  it('skips hidden, withdrawn (rules.mjs, the register, the record, the name), non-intake and slug-less listings', () => {
    const by = Object.fromEntries(planBackfill(listings, { findPdf, withdrawals }).map((r) => [r.id, r]));
    const skip = (id, re) => {
      assert.equal(by[id].action, 'skip', id);
      assert.equal(by[id].pdf, null, id);
      assert.match(by[id].reason, re, id);
    };
    skip('BONA-W005', /hidden/);
    skip('BONA-W009', /advertising withdrawn \(the developer does not permit/);
    skip('BONA-W011', /advertising withdrawn \(developer withdrew permission \(fixture\)\)/);
    skip('BONA-W012', /record says withdrawn/);
    skip('BONA-W013', /advertising withdrawn/);
    skip('BONA-015', /not an intake listing/);
    skip('BONA-W100', /no slug/);
  });

  it('without the register flags, the register-only withdrawal is not known (the CLI must pass them)', () => {
    const by = Object.fromEntries(planBackfill(listings, { findPdf }).map((r) => [r.id, r]));
    assert.equal(by['BONA-W011'].action, 'brochure-only');
  });

  it('looks for a source PDF only for the listings it may act on', () => {
    asked.length = 0;
    planBackfill(listings, { findPdf, withdrawals });
    const skipped = ['BONA-W005', 'BONA-W009', 'BONA-W011', 'BONA-W012', 'BONA-W013', 'BONA-015', 'BONA-W100'];
    for (const id of skipped) assert.ok(!asked.includes(sha(`pdf of ${id}`)), `${id} was not hashed for`);
    assert.equal(asked.length, 3, 'W002, W003 and W010 — nothing for W004, which records no sha, nor W001, already enriched');
  });

  it('`only` narrows the plan, case-insensitively, and keeps the id order', () => {
    const plan = planBackfill(listings, { findPdf, withdrawals, only: ['bona-w010', 'BONA-W002', 'BONA-W005'] });
    assert.deepEqual(plan.map((r) => [r.id, r.action]), [['BONA-W002', 'brochure-only'], ['BONA-W005', 'skip'], ['BONA-W010', 'enrich']]);
  });

  it('orders ids by number, not by string', () => {
    const plan = planBackfill([listing('BONA-W1000'), listing('BONA-W999'), listing('BONA-W020')], { findPdf: () => null });
    assert.deepEqual(plan.map((r) => r.id), ['BONA-W020', 'BONA-W999', 'BONA-W1000']);
  });

  it('needs a findPdf function', () => {
    assert.throws(() => planBackfill(listings, {}), /findPdf/);
  });

  it('parseOnly / unknownIds', () => {
    assert.equal(parseOnly(undefined), null);
    assert.equal(parseOnly(''), null);
    assert.deepEqual(parseOnly('bona-w002, BONA-W010  BONA-W002'), ['BONA-W002', 'BONA-W010']);
    assert.deepEqual(unknownIds(listings, ['BONA-W002', 'BONA-W999']), ['BONA-W999']);
    assert.deepEqual(unknownIds(listings, null), []);
  });

  it('formatPlanTable shows every row, the source PDF relative to the intake folder, and the totals', () => {
    const plan = planBackfill(listings, { findPdf, withdrawals });
    const table = formatPlanTable(plan, { intakeDir: '/data/intake' });
    for (const r of plan) assert.match(table, new RegExp(r.id));
    assert.match(table, /yes 2026-09-06\/w3\.pdf/);
    assert.match(table, /12 listing\(s\): 2 enrich · 2 brochure-only · 8 skip/);
  });
});

// ---------------------------------------------------------------- makePdfFinder
describe('makePdfFinder — findSourcePdf for many listings, every PDF hashed once', () => {
  let dir;
  const bodies = {};
  before(() => {
    dir = scratch('backfill-finder-');
    const put = (rel, body) => { write(path.join(dir, rel), body); bodies[rel] = body; };
    put('top.pdf', 'top');
    put('2026-09-06/a.pdf', 'A');
    put('2026-09-06/sub/b.PDF', 'B');
    put('2026-09-07/dup.pdf', 'DUP');
    put('2026-09-08/dup-again.pdf', 'DUP');
    put('2026-09-08/notes.txt', 'A');                       // same bytes, not a PDF
    put('d1/d2/d3/c.pdf', 'C');                             // depth 3: found
    put('d1/d2/d3/d4/too-deep.pdf', 'DEEP');                // past maxDepth: never found
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('answers exactly what findSourcePdf answers', () => {
    const finder = makePdfFinder(dir);
    for (const body of ['top', 'A', 'B', 'DUP', 'C', 'DEEP', 'nothing']) {
      assert.equal(finder(sha(body)), findSourcePdf(dir, sha(body)), body);
    }
    assert.equal(finder(sha('DEEP')), null);
    assert.equal(finder(sha('nothing')), null);
    assert.equal(finder(null), null);
    assert.equal(makePdfFinder(path.join(dir, 'missing'))(sha('A')), null);
  });

  it('hashes each PDF at most once however many listings ask', () => {
    const seen = new Map();
    const hashFile = (file) => {
      seen.set(file, (seen.get(file) ?? 0) + 1);
      return sha(fs.readFileSync(file));
    };
    const finder = makePdfFinder(dir, { hashFile });
    for (let round = 0; round < 3; round += 1) {
      for (const body of ['top', 'A', 'B', 'DUP', 'C', 'nothing']) finder(sha(body));
    }
    assert.ok([...seen.values()].every((n) => n === 1), JSON.stringify([...seen]));
    assert.equal(seen.size, 6, 'every PDF within the depth (not too-deep.pdf, not the .txt)');
    assert.equal(finder.hashed(), 6);
  });
});

// ---------------------------------------------------------------- reading run-once's output
describe('classifyRun / summarizeRun', () => {
  it('REJECTED is a rejection, whatever else was printed', () => {
    const r = classifyRun({ code: 1, output: 'Gate x\n\nREJECTED at "classify": not a property brochure\nNothing was written to the repo.\nwork dir: /w' });
    assert.equal(r.outcome, 'rejected');
    assert.equal(r.line, 'REJECTED at "classify": not a property brochure');
  });

  it('run-once\'s own refusal of one listing (`FAILED: --enrich <id>: …`) is a refusal, not a failure', () => {
    const r = classifyRun({ code: 1, output: "FAILED: --enrich BONA-W023: BONA-W023 shows SAR 350,000 but the brochure's lowest model price is SAR 319,015 — send `price BONA-W023 …` or re-run with --replace\nwork dir: /w" });
    assert.equal(r.outcome, 'refused');
    assert.match(r.line, /^REFUSED: --enrich BONA-W023: .*SAR 350,000/);
  });

  it('r3 #7: a brochure too large to build is a permanent refusal of that listing — skipped, the backfill goes on', () => {
    const out = 'FAILED: the Bona brochure could not be rebuilt (the brochure is over the 25 MB limit even with its photos scaled down), and the listing\'s old brochure would contradict the enriched listing (its models, prices and plans), so nothing was changed; run --enrich again once the brochure builds\nwork dir: /w';
    const r = classifyRun({ code: 1, output: out });
    assert.equal(r.outcome, 'refused');
    assert.equal(stopsBackfill(r.outcome), false);
    // A quota stays a quota (retryable), and any other failure a failure.
    assert.equal(classifyRun({ code: 1, output: 'FAILED: the AI quota ran out during the unit-model price check — nothing was changed; try again later\n' }).outcome, 'quota');
    assert.equal(classifyRun({ code: 1, output: 'FAILED: the check of 4 unit-model price(s) could not be completed (page 3) — nothing was changed; try again later\n' }).outcome, 'failed');
  });

  it('r5 #11: only the brochure-size refusal, as buildBrandedBrochure words it, is skipped — any other "too large" or "MB limit" is a failure', async () => {
    // The refusal word for word: buildBrandedBrochure's too-large error (a stand-in renderer that answers
    // too-large), inside the failure pipeline.mjs throws when an enrichment cannot rebuild the brochure.
    const dir = scratch('bf-too-large-');
    try {
      const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({ ok: false, reason: 'too-large', error: '30000000 bytes, cap 26214400' })}\n`));
          child.emit('close', 1);
        });
        return child;
      };
      for (const maxBrochureMb of [25, 12.5]) {
        const built = await buildBrandedBrochure({ listing: listing('BONA-W023'), filesDir: dir, outPath: path.join(dir, 'brochure.pdf'), workDir: path.join(dir, 'work'), cfg: { maxBrochureMb }, spawnImpl });
        assert.equal(built.reason, 'too-large');
        const out = `FAILED: the Bona brochure could not be rebuilt (${built.error}), and the listing's old brochure would contradict the enriched listing (its models, prices and plans), so nothing was changed; run --enrich again once the brochure builds\nwork dir: /w`;
        assert.equal(classifyRun({ code: 1, output: out }).outcome, 'refused', built.error);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    // Any other "too large" or "MB limit" is not that refusal: a failure, which stops the backfill.
    for (const msg of ['the brochure is too large', 'the request body is too large for the API', 'argument list too large', 'the PDF is over the 50 MB limit']) {
      const r = classifyRun({ code: 1, output: `FAILED: ${msg}\n` });
      assert.equal(r.outcome, 'failed', msg);
      assert.equal(stopsBackfill(r.outcome), true, msg);
    }
  });

  it('a dirty clone is a failure: every later job would hit it too', () => {
    assert.equal(classifyRun({ code: 1, output: 'FAILED: --enrich BONA-W023: /x has uncommitted changes, which --enrich will not discard' }).outcome, 'failed');
  });

  it('any other FAILED, or a non-zero exit with no marker, is a failure', () => {
    assert.deepEqual(classifyRun({ code: 1, output: 'FAILED: git push failed — see the journal\nwork dir: /w' }), { outcome: 'failed', line: 'FAILED: git push failed — see the journal' });
    const r = classifyRun({ code: 2, output: 'usage: run-once.mjs <file.pdf> …' });
    assert.equal(r.outcome, 'failed');
    assert.match(r.line, /^exit 2: usage/);
  });

  it('a killed child stops everything, with the memory hint', () => {
    assert.equal(classifyRun({ code: null, signal: 'SIGKILL', output: 'Models 8' }).outcome, 'killed');
    assert.match(classifyRun({ code: 137, output: '' }).line, /memory limit/);
  });

  it('a usage/session limit, a quota or a 429 anywhere is `quota` — even on exit 0', () => {
    for (const output of [
      "FAILED: claude -p failed: You've hit your session limit · resets 5pm",
      'claude -p failed: Claude AI usage limit reached|1763380800',
      '{"level":"warn","event":"ai.call_failed","error":"429 Too Many Requests"}',
      '{"api_error_status":429}',
      "  ! the price could not be checked on the brochure (the AI quota ran out), so the listing says \"price on request\"",
      'rate_limit_error',
    ]) {
      assert.equal(classifyRun({ code: output.startsWith('FAILED') ? 1 : 0, output }).outcome, 'quota', output);
    }
  });

  it('a 429 inside a price, a hash or a time is not a quota', () => {
    for (const text of ['SAR 429,000', 'SAR 1,429', 'sha 7f6e4e4a4429bd', '2026-11-17T04:29:00.429Z', 'plot 4290 sqm', 'the brochure is over the 25 MB limit']) {
      assert.equal(QUOTA_RE.test(text), false, text);
    }
  });

  it('a dry run that says WOULD BE REJECTED is a rejection', () => {
    const r = classifyRun({ code: 0, output: 'WOULD BE REJECTED — the copy names the developer\nDRY RUN — nothing written.' });
    assert.equal(r.outcome, 'rejected');
  });

  // The lines run-once's printEnrichReport writes.
  const enrichReport = ({ headline = 'adopted — was on request: the models\' confirmed headline is adopted', extra = '' } = {}) => [
    '══ Bona intake — enrich ══════════════════════════════════════',
    'PDF        /data/intake/2026-10-13/A.pdf',
    '           61.20 MB · 24 pages · sha 7a0a5548a8ff',
    'AI         attempt 1 · opus · 312s · $1.204',
    '',
    'BONA-W023   araco-jeddah-heights',
    'EN  Araco Jeddah Heights Apartments, Jeddah',
    '',
    'Models     8 — 6 priced · prices kept 6 / refused 2 (319,015, 420,000)',
    '           Lulu                     319,015 · Sakani 270,425  /listings/araco/plan-01.jpg',
    'Facts      amenities 6 · nearby 4',
    `Headline   ${headline}`,
    '           before Price on request',
    extra,
    'Plans      plan-01.jpg plan-02.jpg plan-03.jpg  (removing plan-09.jpg)',
    '',
    'DRY RUN — nothing written.',
  ].join('\n');

  it('a success line: models, model prices kept/refused, the headline decision and the plans (run-once\'s enrich report)', () => {
    assert.deepEqual(classifyRun({ code: 0, output: enrichReport() }), { outcome: 'ok', line: 'models 8 · prices kept 6 / refused 2 · headline adopted · plans 3' });
    assert.match(classifyRun({ code: 0, output: enrichReport({ headline: 'owner-price — the owner\'s own price stays; the models are published without prices' }) }).line, /headline owner-price/);
    assert.match(classifyRun({ code: 0, output: enrichReport({ headline: 'no-model-prices — no model price was confirmed: the price stays as it is' }) }).line, /headline no-model-prices/);
    assert.match(classifyRun({ code: 0, output: enrichReport({ headline: 'currency-mismatch — the brochure prices its models in AED, the listing is in SAR: the models are published without prices' }) }).line, /headline currency-mismatch/);
    assert.equal(summarizeRun('{"ts":"x","level":"info","event":"intake.enrich","models":2,"kept":0,"refused":0,"headline":"currency-mismatch"}'), 'models 2 · prices kept 0 / refused 0 · headline currency-mismatch');
    const logged = [
      '{"ts":"x","level":"info","event":"intake.model_prices","models":5,"calls":2,"refused":1,"incomplete":0,"fatal":false}',
      '{"ts":"x","level":"info","event":"intake.enrich_headline","decision":"kept"}',
    ].join('\n');
    assert.equal(summarizeRun(logged), 'models 5 · prices kept ? / refused 1 · headline kept');
    assert.equal(summarizeRun('  ! 3 unit-model price(s) could not be confirmed on the brochure\'s own pages'), 'prices kept ? / refused 3');
  });

  it('a dry run whose headline would be refused is a refusal, with the reason', () => {
    const r = classifyRun({ code: 0, output: enrichReport({ headline: 'refused — REFUSED', extra: "           BONA-W023 shows SAR 350,000 but the brochure's lowest model price is SAR 319,015 — send `price BONA-W023 …` or re-run with --replace" }) });
    assert.equal(r.outcome, 'refused');
    assert.match(r.line, /^REFUSED \(headline\): BONA-W023 shows SAR 350,000 .*--replace · models 8 · prices kept 6 \/ refused 2 · headline refused/);
  });

  it('nothing to read: the last three lines', () => {
    const r = classifyRun({ code: 0, output: 'one\ntwo\n\nthree\nfour\n' });
    assert.deepEqual(r, { outcome: 'ok', line: 'two | three | four' });
    assert.equal(summarizeRun('nothing here'), null);
  });

  it('stopsBackfill and resumeCommand', () => {
    assert.equal(stopsBackfill('quota', { continueOnError: true }), true);
    assert.equal(stopsBackfill('killed', { continueOnError: true }), true);
    assert.equal(stopsBackfill('failed'), true);
    assert.equal(stopsBackfill('failed', { continueOnError: true }), false);
    for (const o of ['ok', 'rejected', 'refused', 'listed']) assert.equal(stopsBackfill(o), false, o);
    assert.equal(resumeCommand(['BONA-W003', 'BONA-W004'], { repo: '/r', dryRun: true, model: 'opus' }),
      'node services/intake/backfill-enrich.mjs --repo /r --dry-run --model opus --only BONA-W003,BONA-W004');
    assert.equal(resumeCommand(['BONA-W003'], { repo: '/r', includeEnriched: true }),
      'node services/intake/backfill-enrich.mjs --repo /r --include-enriched --only BONA-W003');
  });
});

// ---------------------------------------------------------------- the CLI
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

// Stand-in run-once: records its argv, notices an overlap with another copy of itself, then prints
// and exits as the scenario says for its listing.
const STUB_RUN_ONCE = `import fs from 'node:fs';
const args = process.argv.slice(2);
const id = args[args.indexOf('--enrich') + 1];
let overlap = false;
try { fs.writeFileSync(process.env.STUB_RUNNING, String(process.pid), { flag: 'wx' }); } catch { overlap = true; }
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify({ id, args, overlap }) + '\\n');
const all = JSON.parse(fs.readFileSync(process.env.STUB_SCENARIO, 'utf8'));
const sc = all[id] ?? { code: 0, out: 'Models     2 unit model(s)\\nDRY RUN — nothing written.\\n' };
await new Promise((r) => setTimeout(r, 80));
process.stdout.write(sc.out ?? '');
if (sc.err) process.stderr.write(sc.err);
if (!overlap) fs.rmSync(process.env.STUB_RUNNING, { force: true });
process.exit(sc.code ?? 0);
`;

// Stand-in brochure_pdf.py: argv is [-I, SCRIPT, listing.json, filesDir, site.json, out.pdf, …].
const STUB_BROCHURE = `import fs from 'node:fs';
const a = process.argv.slice(2);
fs.writeFileSync(a[5], '%PDF-1.4 stand-in brochure\\n');
process.stdout.write(JSON.stringify({ ok: true, bytes: 27, pages: 6, steps: [] }) + '\\n');
`;

/** A publishing clone with a bare origin, an inbox, source PDFs under BONA_DATA, and the stand-ins. */
function makeRig() {
  const base = scratch('backfill-cli-');
  const rig = {
    base,
    origin: path.join(base, 'origin.git'),
    repo: path.join(base, 'clone'),
    data: path.join(base, 'data'),
    stub: write(path.join(base, 'stub-run-once.mjs'), STUB_RUN_ONCE),
    fakePy: write(path.join(base, 'stub-brochure.mjs'), STUB_BROCHURE),
    scenario: path.join(base, 'scenario.json'),
    calls: path.join(base, 'calls.jsonl'),
    running: path.join(base, 'running'),
  };
  rig.intake = path.join(rig.data, 'intake');
  rig.pdfs = {
    'BONA-W002': write(path.join(rig.intake, '2026-09-06', 'w2.pdf'), 'pdf of BONA-W002'),
    'BONA-W003': write(path.join(rig.intake, '2026-09-06', 'w3.pdf'), 'pdf of BONA-W003'),
    'BONA-W004': write(path.join(rig.intake, '2026-09-07', 'job', 'w4.pdf'), 'pdf of BONA-W004'),
  };
  git(base, 'init', '--bare', '-b', 'main', rig.origin);
  git(base, 'clone', rig.origin, rig.repo);
  write(path.join(rig.repo, 'scripts', 'curate', 'build.mjs'), 'process.exit(0);\n');
  write(path.join(rig.repo, 'scripts', 'curate', 'validate.mjs'), "console.log('ok');\n");
  write(path.join(rig.repo, 'src', 'data', 'listings.json'), '[]\n');
  write(path.join(rig.repo, 'src', 'data', 'site.json'), '{}\n');
  const inbox = [
    listing('BONA-W004'), listing('BONA-W002'), listing('BONA-W003'),
    listing('BONA-W005'),                                    // its PDF is gone → brochure-only
    listing('BONA-W006', { hidden: true }),
    listing('BONA-W009', { slug: 'elvira-murjan-townhouses-in-al-murjan', hidden: true, status: 'withdrawn' }),
  ];
  for (const l of inbox) {
    write(path.join(rig.repo, 'scripts', 'curate', 'inbox', `${l.slug}.json`), `${JSON.stringify(l, null, 2)}\n`);
    if (!l.hidden) write(path.join(rig.repo, 'public', 'listings', l.slug, '01.jpg'), `photo of ${l.id}`);
  }
  write(path.join(rig.repo, 'scripts', 'curate', 'inbox', '_index.json'), '{"nextSeq":10,"listings":{}}\n');
  git(rig.repo, 'add', '-A');
  git(rig.repo, 'commit', '-m', 'init');
  git(rig.repo, 'push', 'origin', 'main');
  rig.env = {
    ...process.env,
    ...GIT_ENV,
    BONA_DATA: rig.data,
    BONA_REPO: rig.repo,
    BONA_SITE: 'https://bona.example',
    BONA_GIT_REMOTE: 'origin',
    BONA_GIT_BRANCH: 'main',
    BONA_LOCK_WAIT_MS: '20000',
    BONA_BROCHURE_PY_CMD: `${process.execPath} ${rig.fakePy}`,
    STUB_SCENARIO: rig.scenario,
    STUB_CALLS: rig.calls,
    STUB_RUNNING: rig.running,
  };
  delete rig.env.BONA_DEBUG;
  return rig;
}

function cli(rig, args, scenario = {}) {
  fs.writeFileSync(rig.scenario, JSON.stringify(scenario));
  fs.rmSync(rig.calls, { force: true });
  const r = spawnSync(process.execPath, [CLI, '--repo', rig.repo, '--run-once', rig.stub, ...args], {
    env: rig.env, encoding: 'utf8', timeout: 120000,
  });
  const calls = fs.existsSync(rig.calls)
    ? fs.readFileSync(rig.calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

/** The one backfill folder a run made (the newest). */
function lastLogDir(rig) {
  const root = path.join(rig.intake, 'backfill');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
  return dirs.length ? path.join(root, dirs.at(-1)) : null;
}

describe('backfill-enrich.mjs (stand-in run-once)', () => {
  const rigs = [];
  const rig = () => { const r = makeRig(); rigs.push(r); return r; };
  after(() => { for (const r of rigs) fs.rmSync(r.base, { recursive: true, force: true }); });

  it('--plan-only prints the plan and runs nothing', () => {
    const r = rig();
    const res = cli(r, ['--plan-only']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /BONA-W002\s+Title of BONA-W002\s+enrich\s+yes 2026-09-06\/w2\.pdf/);
    assert.match(res.out, /BONA-W004\s+.*enrich\s+yes 2026-09-07\/job\/w4\.pdf/);
    assert.match(res.out, /BONA-W005\s+.*brochure-only\s+no\s+source PDF not in the intake folder/);
    assert.match(res.out, /BONA-W006\s+.*skip\s+—\s+hidden/);
    assert.match(res.out, /BONA-W009\s+.*skip\s+—\s+advertising withdrawn/);
    assert.match(res.out, /6 listing\(s\): 3 enrich · 1 brochure-only · 2 skip/);
    assert.deepEqual(res.calls, []);
    assert.equal(lastLogDir(r), null, 'no log folder');
  });

  it('a listing that already carries unit models is skipped as "already enriched" unless --include-enriched', () => {
    const r = rig();
    const file = path.join(r.repo, 'scripts', 'curate', 'inbox', 'slug-bona-w003.json');
    const l = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, `${JSON.stringify({ ...l, models: [{ name: { en: 'A', ar: 'أ' }, price: 319015 }] }, null, 2)}\n`);
    git(r.repo, 'commit', '-qam', 'intake: enrich W003');
    const plain = cli(r, ['--plan-only']);
    assert.equal(plain.code, 0, plain.out);
    assert.match(plain.out, /BONA-W003\s+.*skip\s+—\s+already enriched \(1 unit model\(s\)\)/);
    assert.match(plain.out, /6 listing\(s\): 2 enrich · 1 brochure-only · 3 skip/);
    const again = cli(r, ['--plan-only', '--include-enriched']);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /BONA-W003\s+.*enrich\s+yes 2026-09-06\/w3\.pdf\s+source PDF found \(already has 1 unit model\(s\) — enriched again\)/);
    const dry = cli(r, ['--dry-run', '--include-enriched', '--only', 'BONA-W003']);
    assert.equal(dry.code, 0, dry.out);
    assert.deepEqual(dry.calls.map((c) => c.id), ['BONA-W003']);
    assert.ok(!dry.calls[0].args.includes('--force'), 'run-once still refuses a reading with less than the listing carries');
  });

  it('--dry-run runs run-once once per enrich listing, in id order, one at a time, with the right argv, and logs each', () => {
    const r = rig();
    const res = cli(r, ['--dry-run', '--model', 'opus'], {
      'BONA-W002': { code: 0, out: 'Models     8 — 6 priced · prices kept 6 / refused 2 (319,015, 420,000)\nHeadline   adopted — was on request: the models\' confirmed headline is adopted\nPlans      plan-01.jpg\nDRY RUN — nothing written.\n' },
      'BONA-W003': { code: 0, out: 'alpha\nbravo\ncharlie\ndelta\n' },
      'BONA-W004': { code: 0, out: 'Models 3\n', err: '{"level":"error","event":"x"}\n' },
    });
    assert.equal(res.code, 0, res.out);
    const dir = lastLogDir(r);
    assert.ok(dir, 'a log folder under $BONA_DATA/intake/backfill');
    assert.deepEqual(res.calls.map((c) => c.id), ['BONA-W002', 'BONA-W003', 'BONA-W004']);
    assert.ok(res.calls.every((c) => !c.overlap), 'never two at once');
    for (const c of res.calls) {
      assert.deepEqual(c.args, [r.pdfs[c.id], '--enrich', c.id, '--dry-run', '--repo', r.repo, '--model', 'opus', '--work', path.join(dir, `${c.id}-work`)]);
    }
    assert.match(res.out, /BONA-W002\s+OK\s+models 8 · prices kept 6 \/ refused 2 · headline adopted · plans 1/);
    assert.match(res.out, /BONA-W003\s+OK\s+bravo \| charlie \| delta/);
    assert.match(res.out, /BONA-W005\s+LISTED\s+brochure-only/);
    assert.match(res.out, /ok 3 · listed 1/);
    assert.match(res.out, new RegExp(`logs:\\s+${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(fs.readFileSync(path.join(dir, 'BONA-W002.log'), 'utf8'), /Headline\s+adopted/);
    assert.match(fs.readFileSync(path.join(dir, 'BONA-W003.log'), 'utf8'), /charlie/);
    const w4log = fs.readFileSync(path.join(dir, 'BONA-W004.log'), 'utf8');
    assert.match(w4log, /"event":"x"/, 'stderr is in the log too');
    assert.match(w4log, /^\$ .*run-once\.mjs .* --enrich BONA-W004 /m, 'the command heads the log');
    assert.match(w4log, /# exit 0/);
    assert.ok(fs.existsSync(path.join(dir, 'plan.txt')));
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    assert.equal(summary.counts.ok, 3);
    assert.equal(summary.stopped, null);
    assert.equal(git(r.repo, 'status', '--porcelain'), '', 'a dry run writes nothing in the clone');
  });

  it('stops on the first FAILED and prints the --only that resumes it', () => {
    const r = rig();
    const res = cli(r, ['--dry-run'], { 'BONA-W003': { code: 1, out: 'FAILED: claude -p exited 1: boom\nwork dir: /w\n' } });
    assert.equal(res.code, 1, res.out);
    assert.deepEqual(res.calls.map((c) => c.id), ['BONA-W002', 'BONA-W003']);
    assert.match(res.out, /BONA-W003\s+FAILED\s+FAILED: claude -p exited 1: boom/);
    assert.match(res.out, /STOPPED at BONA-W003/);
    assert.match(res.out, /resume:\s+node services\/intake\/backfill-enrich\.mjs --repo \S+ --dry-run --only BONA-W003,BONA-W004,BONA-W005/);
    assert.match(res.out, /not run 2/);
  });

  it('--continue-on-error goes on after a FAILED job and names the failed ones at the end', () => {
    const r = rig();
    const res = cli(r, ['--dry-run', '--continue-on-error'], { 'BONA-W003': { code: 1, out: 'FAILED: claude -p exited 1: boom\n' } });
    assert.equal(res.code, 1, res.out);
    assert.deepEqual(res.calls.map((c) => c.id), ['BONA-W002', 'BONA-W003', 'BONA-W004']);
    assert.match(res.out, /retry the failed ones:\s+.*--continue-on-error --only BONA-W003$/m);
  });

  it('a REJECTED or refused listing is reported and skipped, and the run goes on', () => {
    const r = rig();
    const res = cli(r, ['--dry-run'], {
      'BONA-W002': { code: 1, out: '\nREJECTED at "classify": not a property brochure\nNothing was written to the repo.\n' },
      'BONA-W003': { code: 1, out: "FAILED: --enrich BONA-W003: BONA-W003 shows SAR 350,000 but the brochure's lowest model price is SAR 319,015 — send `price BONA-W003 …` or re-run with --replace\n" },
    });
    assert.equal(res.code, 0, res.out);
    assert.deepEqual(res.calls.map((c) => c.id), ['BONA-W002', 'BONA-W003', 'BONA-W004']);
    assert.match(res.out, /BONA-W002\s+REJECTED\s+REJECTED at "classify": not a property brochure/);
    assert.match(res.out, /BONA-W003\s+REFUSED\s+REFUSED: --enrich BONA-W003/);
    assert.match(res.out, /ok 1 · rejected 1 · refused 1 · listed 1/);
  });

  it('a usage/session limit stops at once — even with --continue-on-error — and says how to resume', () => {
    const r = rig();
    const res = cli(r, ['--dry-run', '--continue-on-error'], {
      'BONA-W002': { code: 1, out: "FAILED: claude -p failed: You've hit your session limit · resets 5pm\n" },
    });
    assert.equal(res.code, 1, res.out);
    assert.deepEqual(res.calls.map((c) => c.id), ['BONA-W002']);
    assert.match(res.out, /BONA-W002\s+QUOTA\s+/);
    assert.match(res.out, /STOPPED at BONA-W002: a usage\/session limit or quota was hit/);
    assert.match(res.out, /resume:\s+.*--only BONA-W002,BONA-W003,BONA-W004,BONA-W005/);
  });

  it('a quota note in a run that exited 0 stops it too (its prices were never checked)', () => {
    const r = rig();
    const res = cli(r, ['--dry-run'], {
      'BONA-W002': { code: 0, out: '  ! the price could not be checked on the brochure (the AI quota ran out), so the listing says "price on request" for now\nDRY RUN — nothing written.\n' },
    });
    assert.equal(res.code, 1, res.out);
    assert.deepEqual(res.calls.map((c) => c.id), ['BONA-W002']);
    assert.match(res.out, /resume:\s+.*--only BONA-W002,BONA-W003,BONA-W004,BONA-W005/);
  });

  it('--only runs just those, in id order; an id that is not in the inbox is refused before anything runs', () => {
    const r = rig();
    const res = cli(r, ['--dry-run', '--only', 'bona-w004,BONA-W002']);
    assert.equal(res.code, 0, res.out);
    assert.deepEqual(res.calls.map((c) => c.id), ['BONA-W002', 'BONA-W004']);
    const bad = cli(r, ['--dry-run', '--only', 'BONA-W002,BONA-W777']);
    assert.equal(bad.code, 2);
    assert.match(bad.out, /--only names BONA-W777, which is not in/);
    assert.deepEqual(bad.calls, []);
  });

  it('an unknown option is refused (a script that pushes does not guess)', () => {
    const r = rig();
    const res = cli(r, ['--dryrun']);
    assert.equal(res.code, 2);
    assert.match(res.out, /unknown option --dryrun/);
    assert.deepEqual(res.calls, []);
  });

  it('a live run refuses a clone with uncommitted changes before it starts', () => {
    const r = rig();
    write(path.join(r.repo, 'notes.txt'), 'somebody\'s work');
    const res = cli(r, ['--only', 'BONA-W002']);
    assert.equal(res.code, 2, res.out);
    assert.match(res.out, /uncommitted changes/);
    assert.deepEqual(res.calls, []);
    assert.equal(fs.readFileSync(path.join(r.repo, 'notes.txt'), 'utf8'), 'somebody\'s work');
  });

  it('a live run passes no --dry-run to run-once', () => {
    const r = rig();
    const res = cli(r, ['--only', 'BONA-W002'], { 'BONA-W002': { code: 0, out: 'Pushed abc1234 — live in a few minutes\n' } });
    assert.equal(res.code, 0, res.out);
    assert.equal(res.calls.length, 1);
    assert.ok(!res.calls[0].args.includes('--dry-run'));
    assert.deepEqual(res.calls[0].args.slice(0, 5), [r.pdfs['BONA-W002'], '--enrich', 'BONA-W002', '--repo', r.repo]);
  });

  it('a live brochure-only listing: brochure rebuilt, committed and pushed as `intake: rebuild brochure <id>`', () => {
    const r = rig();
    const res = cli(r, ['--only', 'BONA-W005']);
    assert.equal(res.code, 0, res.out);
    assert.deepEqual(res.calls, [], 'run-once is not involved');
    assert.match(res.out, /BONA-W005\s+OK\s+brochure rebuilt \(6 pages, 0\.0 MB\) · pushed [0-9a-f]+/);
    const slug = 'slug-bona-w005';
    assert.equal(git(r.origin, 'log', '-1', '--format=%s', 'main'), 'intake: rebuild brochure BONA-W005');
    assert.equal(git(r.origin, 'show', `main:public/listings/${slug}/brochure.pdf`), '%PDF-1.4 stand-in brochure');
    const inbox = JSON.parse(git(r.origin, 'show', `main:scripts/curate/inbox/${slug}.json`));
    assert.equal(inbox.brochureUrl, `https://bona.example/listings/${slug}/brochure.pdf`);
    assert.equal(git(r.repo, 'status', '--porcelain'), '', 'the clone is left clean');
    const log = JSON.parse(fs.readFileSync(path.join(lastLogDir(r), 'BONA-W005.log'), 'utf8'));
    assert.equal(log.outcome, 'ok');
    assert.equal(fs.existsSync(path.join(r.data, 'intake.lock')), false, 'the lock is released');
  });
});
