// The pieces that keep one job from stepping on another: the lock (finding 13), the SIGTERM
// grace period (finding 4), the model's confinement settings (finding 5) and the TAQEEM
// price cross-check (finding 10).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireLock, withLock } from '../lib/lock.mjs';
import { outsideDenyRules, writeConfinement } from '../lib/confine.mjs';
import { priceAppearsIn, westernise } from '../lib/price.mjs';
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

  it('steals a lock older than staleMs even if the pid is alive', async () => {
    const file = path.join(dir, 'intake.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.utimesSync(file, new Date(Date.now() - 7200e3), new Date(Date.now() - 7200e3));
    (await acquireLock(file, { timeoutMs: 500, staleMs: 3600e3, pollMs: 10 }))();
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

  it('accepts a price the owner typed in the caption', () => {
    assert.ok(priceAppearsIn('brochure text with no price\nSAR 4,500,000', 4500000));
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
    assert.match(py, /def render_matrix\(page, dpi: int, long_side: int\)/);
    assert.ok(!/pymupdf\.Matrix\(zoom, zoom\)(?![\s\S]*render_matrix)/.test(py.split('def render_matrix')[1] || ''), 'page renders go through render_matrix');
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
});
