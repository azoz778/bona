import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createState } from '../lib/state.mjs';
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

  it('says so when the page is not live yet', () => {
    assert.match(msg.published(report, { live: false }), /goes live a few minutes/);
  });

  it('never prints a price it does not have', () => {
    const onRequest = structuredClone(report);
    onRequest.listing.price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
    assert.match(msg.published(onRequest, { live: true }), /Price on request/);
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
