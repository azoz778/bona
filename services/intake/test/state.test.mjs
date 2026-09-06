import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
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

// A crash between the push and `finishJob()` used to publish the brochure twice: the job
// came back pending, `replayPendingJobs()` set `retryPath` because the PDF was still on
// disk, and `retryPath` switched the sha256 duplicate check off.
describe('replay after a crash never publishes the same PDF twice', () => {
  let dir;
  let file;
  const SHA = crypto.createHash('sha256').update('brochure bytes').digest('hex');
  const LIVE = { id: 'BONA-W042', slug: 'sea-view-villa', url: 'https://bona.azoz.uk/properties/sea-view-villa/' };

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-replay-')); file = path.join(dir, 'state.json'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A brochure that has just arrived: durable job first, message id seen second. */
  const arrive = (s, id = 'M1') => {
    s.addJob({ id, jid: 'g@g.us', key: { id }, caption: '', fileName: 'villa.pdf', pdfPath: path.join(dir, `${id}.pdf`) });
    s.markSeen(id);
    return s;
  };

  it('closes the job and answers with the live URL when its own push already landed', () => {
    const first = arrive(createState(file));
    first.completePublish({ sha: SHA, messageId: 'M1', ...LIVE });
    // …and the daemon is killed here, before `reply()` — the job is closed, but even if it
    // were not, the replay must not push again.
    const s = createState(file);
    s.updateJob('M1', { status: 'pending' });          // the worst case: the close was lost too
    assert.deepEqual(s.pendingJobs().map((j) => j.id), ['M1'], 'the job is replayed on boot');

    const guard = s.duplicateGuard({ sha: SHA, messageId: 'M1' });
    assert.ok(guard, 'the replay must be stopped by the sha256 guard');
    assert.equal(guard.outcome, 'done', 'our own push finished — the job is done, not a duplicate');
    assert.equal(guard.published.url, LIVE.url);
    assert.match(msg.alreadyLive(guard.published), /sea-view-villa/);

    s.finishJob('M1', guard.outcome);
    assert.deepEqual(createState(file).pendingJobs(), [], 'and it is answered once, then never again');
  });

  it('ignores retryPath entirely — the guard has no way to be switched off by a replay', () => {
    const s = arrive(createState(file));
    s.completePublish({ sha: SHA, messageId: 'M1', ...LIVE });
    // Whatever the daemon knows about the downloaded file, the question is only ever
    // "is this sha live?". The guard takes no retry/replay argument at all.
    assert.equal(s.duplicateGuard.length, 1);
    assert.ok(s.duplicateGuard({ sha: SHA, messageId: 'M1' }));
    assert.ok(s.duplicateGuard({ sha: SHA, messageId: 'M9' }), 'another message, same bytes');
    assert.equal(s.duplicateGuard({ sha: SHA, messageId: 'M9' }).outcome, 'duplicate');
    assert.equal(s.duplicateGuard({ sha: 'other-bytes', messageId: 'M1' }), null, 'a new brochure still publishes');
  });

  it('still catches a half-written publish from an older state file', () => {
    // Two separate saves (record, then close) leave a window; a crash inside it is what the
    // guard has to survive. It does, because it asks the sha and nothing else.
    const s = arrive(createState(file));
    s.recordPublished(SHA, { ...LIVE, messageId: 'M1' });
    const rebooted = createState(file);
    assert.equal(rebooted.getJob('M1').status, 'pending');
    assert.equal(rebooted.duplicateGuard({ sha: SHA, messageId: 'M1' }).outcome, 'done');
  });

  it('records the sha and closes the job in ONE write, so no crash can land half of it', () => {
    const s = arrive(createState(file));
    const renames = [];
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => { renames.push(to); return realRename(from, to); };
    try {
      s.completePublish({ sha: SHA, messageId: 'M1', ...LIVE });
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(renames.length, 1, 'two saves would leave a replayable window between them');

    const reloaded = createState(file);
    assert.equal(reloaded.publishedFor(SHA).id, LIVE.id, 'the sha is live on disk');
    assert.equal(reloaded.publishedFor(SHA).messageId, 'M1', 'and it remembers which message published it');
    assert.equal(reloaded.getJob('M1').status, 'done', 'and the job is closed in the same write');
    assert.deepEqual(reloaded.pendingJobs(), []);
  });

  it('lets a dry run preview a brochure that is already live', () => {
    const s = arrive(createState(file));
    s.completePublish({ sha: SHA, messageId: 'M1', ...LIVE });
    assert.equal(s.duplicateGuard({ sha: SHA, messageId: 'M2', dryRun: true }), null);
  });
});
