import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createState, MAX_JOB_ATTEMPTS } from '../lib/state.mjs';
import { parseEnv, loadConfig } from '../lib/env.mjs';
import { redact } from '../lib/log.mjs';
import * as msg from '../lib/messages.mjs';

describe('state — dedupe and durability', () => {
  let dir;
  let file;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-state-')); file = path.join(dir, 'intake-state.json'); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('starts empty and survives a reload', () => {
    const s = createState(file);
    assert.equal(s.hasSeen('A'), false);
    s.markSeen('A');
    assert.equal(createState(file).hasSeen('A'), true);
  });

  it('dedupes by PDF sha256, not by message id', () => {
    const s = createState(file);
    const sha = crypto.createHash('sha256').update('same pdf bytes').digest('hex');
    assert.equal(s.publishedFor(sha), null);
    s.recordPublished(sha, { id: 'BONA-W001', slug: 'villa', url: 'https://bona.azoz.uk/properties/villa/' });
    // A second message carrying the identical file must resolve to the live listing.
    assert.equal(createState(file).publishedFor(sha).url, 'https://bona.azoz.uk/properties/villa/');
    assert.equal(s.publishedFor('other'), null);
  });

  it('forgets a published listing when it is removed', () => {
    const s = createState(file);
    const sha = crypto.createHash('sha256').update('x').digest('hex');
    s.recordPublished(sha, { id: 'BONA-W002', slug: 'x', url: 'u' });
    s.forgetPublished((info) => info.id === 'BONA-W002');
    assert.equal(s.publishedFor(sha), null);
  });

  it('announces a group only once, and seeds history in bulk', () => {
    const s = createState(file);
    assert.equal(s.isAnnounced('g@g.us'), false);
    s.markAnnounced('g@g.us');
    s.markAnnounced('g@g.us');
    assert.equal(createState(file).raw.announcedGroups.filter((x) => x === 'g@g.us').length, 1);
    s.markSeenBulk(['h1', 'h2', 'h3']);
    assert.equal(createState(file).hasSeen('h2'), true);
  });

  it('recovers from a corrupt file instead of crashing the daemon', () => {
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{not json');
    assert.equal(createState(broken).hasSeen('anything'), false);
  });
});

describe('env parsing', () => {
  it('handles quotes, export and comments', () => {
    const env = parseEnv([
      '# a comment',
      'export EVOLUTION_API_URL=https://wa-api.azoz.uk',
      'QUOTED="with spaces"',
      "SINGLE='v'",
      'TRAILING=value # note',
      'BLANKLINE=',
    ].join('\n'));
    assert.equal(env.EVOLUTION_API_URL, 'https://wa-api.azoz.uk');
    assert.equal(env.QUOTED, 'with spaces');
    assert.equal(env.SINGLE, 'v');
    assert.equal(env.TRAILING, 'value');
    assert.equal(env.BLANKLINE, '');
  });

  it('applies the documented defaults and lets overrides win', () => {
    const cfg = loadConfig({ repo: '/tmp/repo' });
    assert.equal(cfg.repo, '/tmp/repo');
    assert.equal(cfg.instance, 'abdulaziz-personal');
    assert.equal(cfg.ownerJid, '966593296933@s.whatsapp.net');
    assert.equal(cfg.groupMatch, 'bona');
    assert.equal(cfg.minImages, 4);
    assert.equal(cfg.maxImages, 10);
    assert.match(cfg.site, /^https:\/\//);
  });
});

describe('log redaction', () => {
  it('never lets a secret through', () => {
    const out = redact({ apiKey: 'super-secret', nested: { EVOLUTION_API_KEY: 'x', token: 'y' }, keep: 'visible' });
    assert.equal(out.apiKey, '[redacted]');
    assert.equal(out.nested.EVOLUTION_API_KEY, '[redacted]');
    assert.equal(out.nested.token, '[redacted]');
    assert.equal(out.keep, 'visible');
  });
  it('truncates long values so a base64 blob cannot reach the journal', () => {
    assert.match(redact({ blob: 'x'.repeat(5000) }).blob, /\[5000 chars\]$/);
  });
});

describe('reply messages', () => {
  const report = {
    url: 'https://bona.azoz.uk/properties/villa/',
    warnings: ['floor unclear'],
    picks: [{ index: 0, room: 'pool', rank: 1 }],
    blocked: null,
    listing: {
      id: 'BONA-W001',
      title: { en: 'Five-Bedroom Villa', ar: 'فيلا' },
      price: { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false },
      images: [1, 2, 3, 4].map(() => ({})),
      hidden: false,
      _intake: { images: [{ n: 1, room: 'pool' }] },
    },
  };

  it('the success reply carries the URL, the count, the cover and the commands', () => {
    const text = msg.published(report, { live: true });
    assert.match(text, /Five-Bedroom Villa/);
    assert.match(text, /https:\/\/bona\.azoz\.uk\/properties\/villa\//);
    assert.match(text, /4 photos/);
    assert.match(text, /cover: Swimming pool/);
    assert.match(text, /SAR 4,500,000/);
    assert.match(text, /remove BONA-W001/);
    assert.match(text, /hero BONA-W001 4/);
  });

  // Finding 14: the reply goes out the moment the push lands, not after a 3-minute poll.
  it('promises the page in about three minutes instead of waiting for it', () => {
    assert.match(msg.published(report), /live in about 3 minutes/);
    assert.match(msg.published(report), /https:\/\/bona\.azoz\.uk\/properties\/villa\//);
  });

  it('has a separate follow-up for a page that never appeared', () => {
    const late = msg.notLive('https://bona.azoz.uk/properties/villa/', 10);
    assert.match(late, /still not answering 10 minutes/);
    assert.match(late, /committed/);
  });

  // Finding 15: a failure reply never quotes git/build/model output.
  it('never echoes raw command output into the group', () => {
    const line = msg.failed();
    assert.match(line, /journal/);
    assert.ok(line.length < 220);
    assert.equal(msg.failed.length, 0, 'failed() takes no message argument any more');
  });

  it('never prints a price it does not have', () => {
    const onRequest = structuredClone(report);
    onRequest.listing.price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
    assert.match(msg.published(onRequest), /Price on request/);
  });

  it('the dry-run reply publishes nothing and says why it would fail', () => {
    const dry = { ...report, listingPreview: { ...report.listing, type: 'villa', location: { district: { en: 'Al Khalidiyah' }, city: { en: 'Jeddah' } }, specs: { beds: 5, baths: 6, areaSqm: 537 } }, blocked: 'not enough usable photos' };
    const text = msg.dryRunSummary(dry);
    assert.match(text, /Dry run/);
    assert.match(text, /nothing was published/i);
    assert.match(text, /would NOT publish: not enough usable photos/);
  });

  it('rejection and failure replies are one line each', () => {
    assert.match(msg.rejected('looks like a private document'), /^✋ Not published — looks like a private document$/);
    assert.match(msg.failed('git push failed'), /^⚠️ /);
  });

  it('the announcement documents the caption hints', () => {
    for (const hint of ['#test', '#brochure', 'rent', 'help']) assert.ok(msg.ANNOUNCE.includes(hint), hint);
  });
});

// Finding 11 — a crash between "seen" and "published" must not lose a brochure.
describe('durable jobs', () => {
  let dir;
  let file;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-jobs-')); file = path.join(dir, 'state.json'); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('survives a restart as pending, in arrival order', () => {
    const s = createState(file);
    s.addJob({ id: 'M1', jid: 'g@g.us', key: { id: 'M1' }, caption: 'rent', fileName: 'a.pdf' });
    s.markSeen('M1');
    s.addJob({ id: 'M2', jid: 'g@g.us', key: { id: 'M2' }, caption: '', fileName: 'b.pdf' });
    s.markSeen('M2');
    const reloaded = createState(file);
    assert.deepEqual(reloaded.pendingJobs().map((j) => j.id), ['M1', 'M2']);
    assert.equal(reloaded.hasSeen('M1'), true, 'the id is seen, so polling will not re-enqueue it');
    assert.equal(reloaded.getJob('M1').caption, 'rent');
  });

  it('remembers where the PDF was downloaded so a replay does not re-download it', () => {
    const s = createState(file);
    s.updateJob('M1', { pdfPath: '/data/intake/2026-09-06/M1.pdf' });
    assert.equal(createState(file).getJob('M1').pdfPath, '/data/intake/2026-09-06/M1.pdf');
  });

  it('stops replaying a job once the pipeline has answered', () => {
    const s = createState(file);
    s.finishJob('M1', 'done');
    s.finishJob('M2', 'rejected');
    assert.deepEqual(createState(file).pendingJobs(), []);
    assert.equal(s.getJob('M2').status, 'rejected');
  });

  it('gives up on a job that keeps failing instead of looping on every boot', () => {
    const s = createState(file);
    s.addJob({ id: 'M3', jid: 'g@g.us' });
    for (let i = 0; i < MAX_JOB_ATTEMPTS - 1; i += 1) {
      s.failJob('M3', 'git push failed');
      assert.equal(s.pendingJobs().length, 1, `still retryable after ${i + 1} attempt(s)`);
    }
    s.failJob('M3', 'git push failed');
    assert.deepEqual(s.pendingJobs(), []);
    assert.equal(s.getJob('M3').status, 'failed');
  });

  it('does not grow without bound', () => {
    const s = createState(file);
    for (let i = 0; i < 400; i += 1) { s.addJob({ id: `X${i}` }); s.finishJob(`X${i}`); }
    assert.ok(Object.keys(createState(file).raw.jobs).length <= 200);
  });
});
