// The pieces that keep one job from stepping on another: the lock (finding 13), the SIGTERM
// grace period (finding 4), the model's confinement settings (finding 5) and the TAQEEM
// price cross-check (finding 10).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireLock, withLock, LOCK_CEILING_MS, LOCK_ORPHAN_MS } from '../lib/lock.mjs';
import { outsideDenyRules, writeConfinement } from '../lib/confine.mjs';
import { figureMatches, priceAppearsIn, printedInCurrency, westernise } from '../lib/price.mjs';
import { STOP_GRACE_MS, waitForIdle } from '../lib/shutdown.mjs';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-runtime-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('lock — one writer at a time, daemon or run-once', () => {
  it('is exclusive while held and free afterwards', async () => {
    const file = path.join(dir, 'intake.lock');
    const release = await acquireLock(file, { timeoutMs: 200, pollMs: 10 });
    assert.equal(fs.existsSync(file), true);
    await assert.rejects(() => acquireLock(file, { timeoutMs: 120, pollMs: 10 }), /holds intake\.lock/);
    release();
    assert.equal(fs.existsSync(file), false);
    (await acquireLock(file, { timeoutMs: 200, pollMs: 10 }))();
  });

  it('serialises two jobs rather than interleaving them', async () => {
    const file = path.join(dir, 'intake.lock');
    const order = [];
    const job = (name) => withLock(file, async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name}:end`);
    }, { timeoutMs: 5000, pollMs: 5 });
    await Promise.all([job('a'), job('b')]);
    assert.equal(order.length, 4);
    assert.equal(order[1].split(':')[0], order[0].split(':')[0], `interleaved: ${order}`);
  });

  it('steals a lock whose holder is gone (kill -9 during a publish)', async () => {
    const file = path.join(dir, 'intake.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 999999999, at: new Date().toISOString() }));
    const release = await acquireLock(file, { timeoutMs: 500, pollMs: 10 });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
    release();
  });

  // Age is not evidence of death. One publish is an AI call, a full Astro build and a push
  // over a Jeddah link; an hour of that is a working job. Stealing on age alone let the
  // daemon and run-once.mjs into the repo phase together — two writers in one clone.
  it('never steals from a live holder, however long it has been working', async () => {
    const file = path.join(dir, 'intake.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, label: 'pdf ABC', at: new Date().toISOString() }));
    const twoHoursAgo = new Date(Date.now() - 2 * 3600e3);
    fs.utimesSync(file, twoHoursAgo, twoHoursAgo);
    await assert.rejects(
      () => acquireLock(file, { timeoutMs: 120, pollMs: 10 }),
      /holds intake\.lock/,
      'a two-hour publish must be waited out and then failed, never barged into',
    );
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'the holder still owns its lock');
  });

  it('waits for a live holder and takes the lock the moment it lets go', async () => {
    const file = path.join(dir, 'intake.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const hourAgo = new Date(Date.now() - 3600e3);
    fs.utimesSync(file, hourAgo, hourAgo);
    setTimeout(() => fs.rmSync(file, { force: true }), 40);
    const release = await acquireLock(file, { timeoutMs: 2000, pollMs: 10 });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
    release();
  });

  it('steals a lock past the hard ceiling, alive pid or not', async () => {
    const file = path.join(dir, 'intake.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const ancient = new Date(Date.now() - LOCK_CEILING_MS - 60e3);
    fs.utimesSync(file, ancient, ancient);
    assert.equal(LOCK_CEILING_MS, 6 * 3600e3);
    (await acquireLock(file, { timeoutMs: 500, pollMs: 10 }))();
  });

  // A lock that names nobody is wreckage from a kill -9 between the open and the pid write.
  // Left alone it would wedge every intake job until the six-hour ceiling.
  for (const [what, contents] of [['empty', ''], ['half-written', '{"pid": 12'], ['not an object', '"hello"']]) {
    it(`steals an ${what} lock file once it is plainly ownerless`, async () => {
      const file = path.join(dir, 'intake.lock');
      fs.writeFileSync(file, contents);
      const old = new Date(Date.now() - LOCK_ORPHAN_MS - 1000);
      fs.utimesSync(file, old, old);
      const release = await acquireLock(file, { timeoutMs: 500, pollMs: 10 });
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
      release();
    });
  }

  it('waits on a fresh empty lock file rather than racing the pid write', async () => {
    const file = path.join(dir, 'intake.lock');
    fs.writeFileSync(file, '');
    await assert.rejects(() => acquireLock(file, { timeoutMs: 80, pollMs: 10 }), /holds intake\.lock/);
  });

  it('does not steal from a live holder just because the file could not be read', async () => {
    // A transient EACCES/EMFILE must read as "someone holds this", never as "nobody does".
    const file = path.join(dir, 'intake.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const old = new Date(Date.now() - LOCK_ORPHAN_MS - 1000);
    fs.utimesSync(file, old, old);
    const realRead = fs.readFileSync;
    fs.readFileSync = (f, ...rest) => {
      if (String(f) === file) throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
      return realRead(f, ...rest);
    };
    try {
      await assert.rejects(() => acquireLock(file, { timeoutMs: 80, pollMs: 10 }), /holds intake\.lock/);
    } finally {
      fs.readFileSync = realRead;
    }
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'the holder kept its lock');
  });

  it('releases even when the job throws', async () => {
    const file = path.join(dir, 'intake.lock');
    await assert.rejects(() => withLock(file, () => { throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(file), false);
  });
});

describe('shutdown — SIGTERM waits for the job in flight', () => {
  it('gives the worker up to 40 s, inside the unit\'s TimeoutStopSec=45', () => {
    assert.equal(STOP_GRACE_MS, 40000);
    const unit = fs.readFileSync(new URL('../../deploy/bona-intake.service', import.meta.url), 'utf8');
    const stop = /TimeoutStopSec=(\d+)/.exec(unit);
    assert.ok(stop && Number(stop[1]) * 1000 > STOP_GRACE_MS, 'the unit must allow more time than we take');
    assert.match(unit, /KillSignal=SIGTERM/);
  });

  it('returns as soon as the worker goes idle', async () => {
    let busy = true;
    setTimeout(() => { busy = false; }, 40);
    const started = Date.now();
    assert.equal(await waitForIdle(() => busy, { timeoutMs: 5000, pollMs: 5 }), true);
    assert.ok(Date.now() - started < 2000);
  });

  it('gives up after the deadline instead of hanging forever', async () => {
    const slept = [];
    const idle = await waitForIdle(() => true, { timeoutMs: 100, pollMs: 10, sleepImpl: async (ms) => { slept.push(ms); } });
    assert.equal(idle, false);
    assert.ok(slept.length > 0);
  });
});

describe('confinement — the model only ever sees its own work dir', () => {
  it('denies every branch of the filesystem except the work dir', () => {
    const work = path.join(dir, 'intake', '2026-09-06', 'MSG1');
    fs.mkdirSync(work, { recursive: true });
    const rules = outsideDenyRules(work);
    assert.ok(rules.includes('Read(//etc/**)'), 'the /etc branch must be denied');
    assert.ok(rules.includes('Read(//etc)'));
    assert.ok(!rules.some((r) => r.startsWith(`Read(/${work}`)), 'the work dir itself is never denied');
    // no ancestor of the work dir is denied either, or nothing under it would be readable
    for (const rule of rules) {
      const p = /^Read\((\/.+?)(?:\/\*\*)?\)$/.exec(rule)[1].slice(1);
      assert.ok(!work.startsWith(`${p}/`) && work !== p, `rule ${rule} blocks the work dir`);
    }
  });

  it('writes a settings file that allows the work dir and denies the rest', () => {
    const work = path.join(dir, 'work');
    fs.mkdirSync(work, { recursive: true });
    const { file, ruleCount } = writeConfinement(work);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(settings.permissions.allow.length, 1);
    assert.equal(settings.permissions.allow[0], `Read(/${fs.realpathSync(work) === work ? work : work}/**)`);
    assert.ok(ruleCount > 5 && settings.permissions.deny.length === ruleCount);
    assert.ok(settings.permissions.deny.includes('Read(//etc/**)'));
  });
});

describe('TAQEEM cross-check — a price must actually be printed', () => {
  it('finds a plain number and every thousands separator', () => {
    for (const t of ['990000', '990,000', '990.000', '990 000', 'SAR 990,000 total']) {
      assert.ok(priceAppearsIn(t, 990000), `${t} should match`);
    }
  });

  it('reads Arabic-Indic digits', () => {
    assert.equal(westernise('٤٥٠٠٠٠٠'), '4500000');
    assert.ok(priceAppearsIn('السعر ٤٬٥٠٠٬٠٠٠ ريال', 4500000));
  });

  it('reads the "4.5m" and "مليون" forms', () => {
    assert.ok(priceAppearsIn('from 4.5m SAR', 4500000));
    assert.ok(priceAppearsIn('4.5 million', 4500000));
  });

  it('a figure inside a longer one is not "printed" (review 2026-11-17)', () => {
    assert.equal(priceAppearsIn('السعر 1,450,000 ريال', 450000), false);
    assert.equal(priceAppearsIn('2,319,015', 319015), false);
    assert.equal(priceAppearsIn('319,015,000', 319015), false);
    assert.equal(priceAppearsIn('spans 1.3 million square metres', 3000000), false);
    assert.equal(priceAppearsIn('السعر 319,015 ريال.', 319015), true);
    assert.equal(priceAppearsIn('بسعر 3 ملايين ريال', 3000000), true);
    assert.equal(priceAppearsIn('250 آلاف', 250000), true);
    assert.equal(priceAppearsIn('SAR 1,250,000.00', 1250000), true, 'a decimal tail is not more digits');
    assert.equal(priceAppearsIn('ر.س.1,250,000', 1250000), true, 'nor is a dot before the figure');
    assert.equal(priceAppearsIn('a 20 m street', 20000000), false, '"20 m" is metres; only "20m" is a million');
    assert.equal(priceAppearsIn('990 k', 990000), false);
    assert.ok(priceAppearsIn('٤٫٥ مليون ريال', 4500000));
    assert.ok(priceAppearsIn('990k', 990000));
  });

  it('does not accept a number the brochure never printed', () => {
    assert.equal(priceAppearsIn('A five bedroom villa, 600 sqm, three floors.', 4500000), false);
    assert.equal(priceAppearsIn('', 4500000), false);
    assert.equal(priceAppearsIn('990,000', 0), false);
  });

  it('does not match a longer number that merely contains it', () => {
    assert.equal(priceAppearsIn('reference 19900001', 990000), false);
    assert.equal(priceAppearsIn('unit 4500000A', 450000), false);
  });

  it('figureMatches: where the figure is printed, by the same rules, leftmost first', () => {
    assert.deepEqual(figureMatches('from SAR 4,400,000 — 4.4m', 4400000), [{ index: 9, end: 18 }, { index: 21, end: 25 }]);
    assert.deepEqual(figureMatches('تبدأ من ٤٬٤٠٠٬٠٠٠ ريال', 4400000), [{ index: 8, end: 17 }], 'Arabic-Indic digits keep their offsets');
    assert.deepEqual(figureMatches('14,400,000', 4400000), []);
    assert.deepEqual(figureMatches('4,400,000', 0), []);
  });

  it('accepts a price the owner typed in the caption', () => {
    assert.ok(priceAppearsIn('brochure text with no price\nSAR 4,500,000', 4500000));
  });
});

describe('TAQEEM currency — a figure printed in another currency is not that price (review 2026-11-17)', () => {
  it('a figure marked with the currency counts — code, symbol or Arabic name, before or after it', () => {
    for (const t of ['SAR 1,250,000', '1,250,000 SAR', 'SR 1,250,000', '1,250,000 ريال', '1,250,000 ريال سعودي', 'ر.س 1,250,000',
      'ر.س.1,250,000', '\u20c1 1,250,000', '1,250,000 \ufdfc', 'SAR 1,250,000.00', 'السعر ١٬٢٥٠٬٠٠٠ ريال', 'from 1.25m SAR', '1.25 مليون ريال',
      'Riyals 1,250,000', 'ﺭﻳﺎﻝ 1,250,000']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR'), true, t);
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: false }), true, `${t} (marked)`);
    }
    for (const [t, c] of [['£1,250,000', 'GBP'], ['$1,250,000', 'USD'], ['US$ 1,250,000', 'USD'], ['1,250,000 AED', 'AED'], ['€1,250,000', 'EUR'],
      ['1,250,000 درهم', 'AED'], ['1,250,000 ريال عماني', 'OMR'], ['1,250,000 دولار', 'USD']]) {
      assert.equal(printedInCurrency(t, 1250000, c), true, `${t} in ${c}`);
    }
  });

  it('the same figure in £ / GBP / $ / USD / AED / € or any other currency does NOT count', () => {
    for (const t of ['£1,250,000', '1,250,000 GBP', 'GBP 1,250,000', '£ 1.25m', '1.25 million pounds', '$1,250,000', 'USD 1,250,000',
      '1,250,000 AED', '€1,250,000', '1,250,000 EUR', 'QAR 1,250,000', '1,250,000 جنيه إسترليني', '1,250,000 دولار', '1,250,000 ريال عماني']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR'), false, t);
    }
    assert.equal(printedInCurrency('Flat A £1,250,000\nFlat B £2,000,000', 1250000, 'SAR'), false, 'P1: a Hampstead price table');
  });

  it('Codex r1 #1b: a currency mark counts only beside the figure, on its own line — not one a line away', () => {
    for (const t of ['AED 1,250,000\nSAR prices on request', 'AED 1,250,000\r\nSAR prices on request', 'SAR prices on request\nAED 1,250,000',
      '1,250,000 AED\nSAR', 'SAR\n1,250,000 AED', '£1,250,000\u2028SAR', 'AED 1,250,000\u2029ر.س']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR'), false, JSON.stringify(t));
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: false }), false, `${JSON.stringify(t)} (abroad)`);
    }
    // A mark on the line above a bare figure is no mark of it: the figure is bare, which counts only where bare figures may.
    assert.equal(printedInCurrency('SAR\n1,250,000', 1250000, 'SAR', { bareCounts: false }), false);
    assert.equal(printedInCurrency('$\n250,000', 250000, 'USD', { bareCounts: false }), false);
    // Beside it, on the same line, it still counts — spaces, a colon or a dash between.
    for (const t of ['AED 1,250,000\nSAR 1,250,000', 'Price: SAR — 1,250,000\nnext line', 'first line\n1,250,000 SAR']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: false }), true, JSON.stringify(t));
    }
  });

  it('a bare figure counts only when bare figures may (a property in the country of that currency) — and one marked occurrence is enough', () => {
    assert.equal(printedInCurrency('Price 1,250,000', 1250000, 'SAR'), true);
    assert.equal(printedInCurrency('Price 1,250,000', 1250000, 'SAR', { bareCounts: false }), false);
    assert.equal(printedInCurrency('£1,250,000 (about SAR 1,250,000 on the cover)', 1250000, 'SAR', { bareCounts: false }), true);
    assert.equal(printedInCurrency('£1,250,000 … total 1,250,000', 1250000, 'SAR'), true, 'the bare occurrence');
    assert.equal(printedInCurrency('£1,250,000 … total 1,250,000', 1250000, 'SAR', { bareCounts: false }), false);
  });

  it('a bare riyal is the riyal of the country the property is in (`home`): Omani in Oman, Qatari in Qatar, Saudi elsewhere (OM1/QA1)', () => {
    // OM1: an Omani villa printing "190,000 ريال" is 190,000 Omani rials — about 1.85 million SAR, not 190,000 SAR.
    for (const t of ['السعر 190,000 ريال', '190,000 ﷼', '190,000 riyals', 'Rial 190,000']) {
      assert.equal(printedInCurrency(t, 190000, 'SAR', { bareCounts: false, home: 'OMR' }), false, `${t} in Oman is not SAR`);
      assert.equal(printedInCurrency(t, 190000, 'SAR', { bareCounts: true, home: 'OMR' }), false, `${t} in Oman: a marked figure, never a bare one`);
      assert.equal(printedInCurrency(t, 190000, 'OMR', { bareCounts: true, home: 'OMR' }), true, `${t} in Oman is OMR`);
      // QA1: in Qatar it is the Qatari riyal — a currency the site does not print.
      assert.equal(printedInCurrency(t, 190000, 'SAR', { bareCounts: false, home: 'QAR' }), false, `${t} in Qatar is not SAR`);
      assert.equal(printedInCurrency(t, 190000, 'SAR', { bareCounts: true, home: 'QAR' }), false, `${t} in Qatar is not bare`);
      // Anywhere else — Saudi Arabia, no country recorded — a bare riyal is the Saudi riyal, and only that.
      for (const home of ['SAR', null, undefined, 'AED', 'USD']) {
        assert.equal(printedInCurrency(t, 190000, 'SAR', { bareCounts: false, home }), true, `${t} with home ${home} is SAR`);
        assert.equal(printedInCurrency(t, 190000, 'OMR', { bareCounts: false, home }), false, `${t} with home ${home} is not OMR`);
      }
    }
    // The Saudi riyal marked as such stays SAR in Oman and Qatar; the Omani rial marked as such stays OMR anywhere.
    for (const t of ['190,000 ريال سعودي', 'ر.س 190,000', 'SAR 190,000', '⃁ 190,000', '190,000 Saudi riyals']) {
      for (const home of ['OMR', 'QAR', 'SAR']) assert.equal(printedInCurrency(t, 190000, 'SAR', { bareCounts: false, home }), true, `${t} with home ${home}`);
    }
    for (const t of ['190,000 ريال عماني', '190,000 ر.ع.', 'OMR 190,000', '190,000 Omani rials']) {
      for (const home of ['OMR', 'SAR', null]) {
        assert.equal(printedInCurrency(t, 190000, 'OMR', { bareCounts: false, home }), true, `${t} with home ${home}`);
        assert.equal(printedInCurrency(t, 190000, 'SAR', { bareCounts: true, home }), false, `${t} with home ${home} is not SAR`);
      }
    }
    assert.equal(printedInCurrency('190,000 ريال قطري', 190000, 'SAR', { bareCounts: true }), false);
    assert.equal(printedInCurrency('190,000 Qatari riyals', 190000, 'SAR', { bareCounts: true }), false);
  });

  it('the mark table (final review M4): A$/C$/HK$ are not USD, dinars/lira/TL/₺/ر.ق/د.ك are never bare, "رسوم" is not ر.س, "د.إ." before a figure is AED', () => {
    for (const t of ['A$1,250,000', 'HK$ 1,250,000', 'C$1,250,000', 'NZ$1,250,000', 'S$ 1,250,000', '1,250,000 A$']) {
      assert.equal(printedInCurrency(t, 1250000, 'USD', { bareCounts: false }), false, `${t} is not USD`);
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true }), false, `${t} is not bare`);
    }
    for (const t of ['$1,250,000', 'US$1,250,000', '1,250,000$', 'Price: $ 1,250,000', '1,250,000 USD']) {
      assert.equal(printedInCurrency(t, 1250000, 'USD', { bareCounts: false }), true, `${t} is USD`);
    }
    for (const t of ['1,250,000 دينار', '1,250,000 دينار كويتي', '1,250,000 د.ك', 'د.ك 1,250,000', '1,250,000 ر.ق', 'ر.ق. 1,250,000',
      '1,250,000 TL', '₺1,250,000', '1,250,000 ₺', '1,250,000 ليرة تركية']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true }), false, `${t} is another currency, never bare`);
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true, home: 'SAR' }), false, `${t} (home SAR)`);
    }
    // ر.س / ر.ع are a mark only on their own: not the start of a word ("رسوم" fees, "رسمي", "رعاية") nor its end ("مدارس").
    for (const t of ['السعر 1,250,000 رسوم التسجيل', '1,250,000 رسمي', 'مدارس 1,250,000']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: false }), false, `${t}: no SAR mark`);
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true }), true, `${t}: bare`);
    }
    assert.equal(printedInCurrency('1,250,000 رعاية', 1250000, 'OMR', { bareCounts: false }), false);
    assert.equal(printedInCurrency('1,250,000 رعاية', 1250000, 'SAR', { bareCounts: true }), true);
    for (const t of ['ر.س 1,250,000', 'ر.س. 1,250,000', 'ر.س.1,250,000', '1,250,000 ر.س', '1,250,000 ر.س.', '1,250,000 ر س']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: false }), true, t);
    }
    for (const t of ['ر.ع 190,000', '190,000 ر.ع.']) assert.equal(printedInCurrency(t, 190000, 'OMR', { bareCounts: false }), true, t);
    for (const t of ['د.إ. 1,250,000', 'د.إ 1,250,000', '1,250,000 د.إ.', '1,250,000 د.إ']) {
      assert.equal(printedInCurrency(t, 1250000, 'AED', { bareCounts: false }), true, t);
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true }), false, `${t} is not SAR`);
    }
  });

  it('a dotted abbreviation stays the mark when Arabic punctuation, a tatweel or a word follows with no space (final review I1)', () => {
    // An Omani villa whose page prints the Saudi price: "850,000 ر.س،" is 850,000 SAR — never a bare figure,
    // which on an Omani property's pages would be 850,000 Omani rials (about ten times as much).
    for (const t of ['850,000 ر.س،', '850,000 ر.س؛ شاملة', '850,000 ر.س؟', '850,000 ر.سـ', '850,000 ر.سشاملة', '850,000 ر. س،',
      'تبدأ الأسعار من 850,000 ر.س، شاملة الضريبة', '850,000 ﺭ.ﺱ،']) {
      assert.equal(printedInCurrency(t, 850000, 'OMR', { bareCounts: true, home: 'OMR' }), false, `${t} is SAR, not a bare Omani figure`);
      assert.equal(printedInCurrency(t, 850000, 'SAR', { bareCounts: false, home: 'OMR' }), true, `${t} is SAR`);
      assert.equal(printedInCurrency(t, 850000, 'SAR', { bareCounts: false }), true, `${t} is SAR anywhere`);
    }
    // The other way round: a Saudi villa whose page prints a dirham / Omani rial / Qatari riyal / Kuwaiti dinar figure.
    for (const [t, c] of [['1,250,000 د.إ،', 'AED'], ['1,250,000 د.إ؛', 'AED'], ['1,250,000 د.إشامل', 'AED'], ['1,250,000 د. إ،', 'AED'],
      ['1,250,000 ر.ع،', 'OMR'], ['1,250,000 ر.ع؟', 'OMR'], ['1,250,000 ر.عـ', 'OMR'], ['1,250,000 ر.ق،', null], ['1,250,000 د.ك،', null]]) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true, home: 'SAR' }), false, `${t} is not a bare Saudi figure`);
      if (c) assert.equal(printedInCurrency(t, 1250000, c, { bareCounts: false }), true, `${t} is ${c}`);
    }
    // Undotted, the letters are a mark only when the word ends there — punctuation ends it, a letter, a vowel mark or a tatweel does not.
    assert.equal(printedInCurrency('1,250,000 رس،', 1250000, 'SAR', { bareCounts: false }), true);
    for (const t of ['1,250,000 رسوم', '1,250,000 رسـوم', '1,250,000 رسُوم', '1,250,000 رسمي', '1,250,000 ر سوم']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: false }), false, `${t}: a word, not ر.س`);
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true, home: 'SAR' }), true, `${t}: bare`);
    }
    for (const t of ['1,250,000 رعاية', '1,250,000 رعـاية', '1,250,000 رقم', '1,250,000 دكان']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true, home: 'SAR' }), true, `${t}: bare`);
    }
  });

  it('a "$" straight after a word is still USD; only the named prefixes make another dollar (final review M1)', () => {
    for (const t of ['price$1,250,000', 'from$1,250,000', 'only$ 1,250,000', 'Price:$1,250,000', 'us$1,250,000']) {
      assert.equal(printedInCurrency(t, 1250000, 'USD', { bareCounts: false }), true, `${t} is USD`);
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true, home: 'SAR' }), false, `${t} is not a bare Saudi figure`);
      assert.equal(printedInCurrency(t, 1250000, 'EUR', { bareCounts: true, home: 'EUR' }), false, `${t} is not a bare euro figure`);
    }
    for (const p of ['A', 'AU', 'C', 'CA', 'HK', 'NZ', 'S', 'SG', 'NT', 'R', 'MX']) {
      for (const t of [`${p}$1,250,000`, `${p}$ 1,250,000`, `1,250,000 ${p}$`, `price ${p}$1,250,000`]) {
        assert.equal(printedInCurrency(t, 1250000, 'USD', { bareCounts: false }), false, `${t} is not USD`);
        assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true }), false, `${t} is not bare`);
      }
    }
  });

  it('AUD$ / CAD$ / HKD$ / SGD$ / NZD$ / TWD$ / MXN$ before a figure are other dollars, not USD (fix review 4)', () => {
    for (const p of ['AUD', 'CAD', 'HKD', 'SGD', 'NZD', 'TWD', 'MXN']) {
      for (const t of [`${p}$1,250,000`, `${p}$ 1,250,000`, `price ${p}$1,250,000`]) {
        assert.equal(printedInCurrency(t, 1250000, 'USD', { bareCounts: false }), false, `${t} is not USD`);
        assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true }), false, `${t} is not bare`);
      }
    }
    assert.equal(printedInCurrency('$1,250,000', 1250000, 'USD', { bareCounts: false }), true);
  });

  it('a spaced dotted Arabic abbreviation is a mark only where the word ends; the unspaced forms keep whatever follows (fix review 4)', () => {
    for (const t of ['1,250,000 د. إبراهيم', '1,250,000 د. كمال', '1,250,000 د. كريم', '1,250,000 ر. قطعة', '1,250,000 ر. عبدالله']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: true, home: 'SAR' }), true, `${t} is a bare figure, not another currency`);
      assert.equal(printedInCurrency(t, 1250000, 'AED', { bareCounts: false }), false, `${t} is not AED`);
    }
    for (const t of ['1,250,000 ر. س،', '1,250,000 ر. س', '1,250,000 ر.س،', '1,250,000 ر.سشاملة']) {
      assert.equal(printedInCurrency(t, 1250000, 'SAR', { bareCounts: false }), true, `${t} is SAR`);
    }
  });

  it('KN Group is not a currency; lowercase kn and HRK still are (fix review 4)', () => {
    assert.equal(printedInCurrency('1,250,000\nKN Group', 1250000, 'SAR', { bareCounts: true, home: 'SAR' }), true);
    assert.equal(printedInCurrency('125,000 kn', 125000, 'EUR', { bareCounts: true, home: 'EUR' }), false);
  });

  it('Bulgarian leva and Croatian kuna are other currencies: a euro-area property\'s old-currency price is never a bare euro figure (final review M7)', () => {
    for (const t of ['125,000 лв.', '125,000 лв', '125 000 лв', 'Цена: 125,000лв.', 'BGN 125,000', '125,000 BGN', '125,000 kn', 'HRK 125,000', '125,000 HRK']) {
      assert.equal(printedInCurrency(t, 125000, 'EUR', { bareCounts: true, home: 'EUR' }), false, `${t} is not euros`);
      assert.equal(printedInCurrency(t, 125000, 'SAR', { bareCounts: true, home: 'SAR' }), false, `${t} is not bare`);
    }
    // "kn" only as a word of its own; a euro price stays one.
    for (const t of ['125,000 knots', '€125,000', '125,000 EUR']) assert.equal(printedInCurrency(t, 125000, 'EUR', { bareCounts: true, home: 'EUR' }), true, t);
  });

  it('the figure rules are priceAppearsIn\'s: no figure inside a longer one, nothing that is not a price', () => {
    assert.equal(printedInCurrency('SAR 1,450,000', 450000, 'SAR'), false);
    assert.equal(printedInCurrency('', 1250000, 'SAR'), false);
    assert.equal(printedInCurrency('SAR 1,250,000', 0, 'SAR'), false);
    assert.equal(printedInCurrency('SAR 1,250,000', 1250000, null), false, 'no currency to check against');
  });
});

// Finding 6 — a hostile or broken candidate must cost the pipeline a photo, not the job.
describe('images — a candidate sharp cannot decode is skipped, not fatal', () => {
  it('keeps the numbering contiguous and reports what it dropped', async () => {
    const sharp = (await import('sharp')).default;
    const { writeListingImages, MAX_INPUT_PIXELS } = await import('../lib/images.mjs');
    const src = path.join(dir, 'src');
    fs.mkdirSync(src, { recursive: true });
    const good = [];
    for (let i = 0; i < 3; i += 1) {
      const f = path.join(src, `ok${i}.jpg`);
      await sharp({ create: { width: 900, height: 600, channels: 3, background: '#334455' } }).jpeg().toFile(f);
      good.push(f);
    }
    const broken = path.join(src, 'broken.jpg');
    fs.writeFileSync(broken, Buffer.from('not an image at all'));

    const candidates = [
      { index: 0, abs: good[0] }, { index: 1, abs: broken },
      { index: 2, abs: good[1] }, { index: 3, abs: good[2] },
    ];
    const picks = candidates.map((c, i) => ({ index: c.index, room: 'view', rank: i + 1, reason: null }));
    const out = path.join(dir, 'out');
    const images = await writeListingImages(candidates, picks, out, 'villa');

    assert.equal(images.length, 3, 'the three decodable candidates survive');
    assert.deepEqual(images.map((im) => im.n), [1, 2, 3], 'no gap in the numbering');
    assert.deepEqual(images.map((im) => im.src), ['/listings/villa/01.jpg', '/listings/villa/02.jpg', '/listings/villa/03.jpg']);
    assert.equal(images.skipped.length, 1);
    assert.equal(images.skipped[0].index, 1);
    for (const im of images) {
      assert.ok(fs.existsSync(im.file) && fs.existsSync(im.thumbFile));
    }
    assert.ok(!fs.existsSync(path.join(out, '04.jpg')), 'no orphan file left behind by the failure');
    assert.equal(MAX_INPUT_PIXELS, 50_000_000, 'the decompression-bomb cap matches extract_pdf.py');
  });

  it('extract_pdf.py caps pixels before it ever builds a Pixmap', () => {
    const py = fs.readFileSync(new URL('../extract_pdf.py', import.meta.url), 'utf8');
    assert.match(py, /MAX_PIXELS = 50_000_000/);
    const usable = /def usable\([\s\S]*?\n\n/.exec(py)[0];
    assert.match(usable, /width \* height > MAX_PIXELS/, 'the cap must be inside usable(), which runs before colour_ratio()');
    assert.match(py, /def render_matrix\(page, dpi: int, long_side: int/);
    assert.match(py, /def clip_matrix\(clip, dpi: int, long_side: int/);
    // Every zoom this file builds goes through render_zoom, which is where the caps live —
    // a page render (or a view slice of one) that built its own Matrix would escape them.
    const matrices = py.split('\n').filter((l) => /pymupdf\.Matrix\(/.test(l));
    assert.equal(matrices.length, 2, 'only render_matrix and clip_matrix may build a Matrix');
    assert.match(py, /def render_zoom\([\s\S]*?if max_pixels and[\s\S]*?\n\n/, 'render_zoom is where the pixel cap is applied');
  });
});

// Finding 15 — the extractor is an argv array, never a shell string.
describe('pdf.mjs — the python command is argv, not a shell line', () => {
  it('accepts an array and splits a legacy string', async () => {
    const { pyArgv, DEFAULT_PY_CMD } = await import('../lib/pdf.mjs');
    assert.deepEqual(pyArgv(['uv', 'run', 'python']), ['uv', 'run', 'python']);
    assert.deepEqual(pyArgv('uv  run   --with pymupdf python'), ['uv', 'run', '--with', 'pymupdf', 'python']);
    assert.deepEqual(pyArgv(''), DEFAULT_PY_CMD);
    assert.deepEqual(pyArgv(undefined), DEFAULT_PY_CMD);
  });

  it('the config hands it an array', async () => {
    const { loadConfig } = await import('../lib/env.mjs');
    assert.ok(Array.isArray(loadConfig().pyCmd));
  });

  it('the rescue attempt always uses a different model from the main one', async () => {
    const { loadConfig } = await import('../lib/env.mjs');
    const saved = { m: process.env.BONA_CLAUDE_MODEL, f: process.env.BONA_CLAUDE_FALLBACK_MODEL };
    try {
      delete process.env.BONA_CLAUDE_FALLBACK_MODEL;
      process.env.BONA_CLAUDE_MODEL = 'sonnet';
      assert.deepEqual([loadConfig().claudeModel, loadConfig().claudeFallbackModel], ['sonnet', 'opus']);
      process.env.BONA_CLAUDE_MODEL = 'opus';
      assert.deepEqual([loadConfig().claudeModel, loadConfig().claudeFallbackModel], ['opus', 'sonnet']);
    } finally {
      for (const [k, v] of [['BONA_CLAUDE_MODEL', saved.m], ['BONA_CLAUDE_FALLBACK_MODEL', saved.f]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
