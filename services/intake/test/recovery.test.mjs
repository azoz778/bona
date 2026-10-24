import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createState } from '../lib/state.mjs';

test('a prolonged storage outage does not exhaust the systemd restart budget', () => {
  const unit = fs.readFileSync(new URL('../../deploy/bona-intake.service', import.meta.url), 'utf8');
  const seconds = key => Number(new RegExp('^' + key + '=(\\d+)$', 'm').exec(unit)?.[1]);
  const interval = seconds('StartLimitIntervalSec');
  const burst = seconds('StartLimitBurst');
  const delay = seconds('RestartSec');
  assert.match(unit, /^Restart=always$/m);
  assert.ok(delay >= 30, 'retry slowly while the host is unavailable');
  const starts = [];
  for (let time = 0; time < 3600; time += delay) {
    const recent = starts.filter(at => time - at <= interval);
    assert.ok(interval === 0 || recent.length < burst,
      'fast startup failures must not leave intake stopped after storage recovers');
    starts.push(time);
  }
});

test('ENOSPC leaves durable pending jobs and duplicate guards intact for restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-disk-recovery-'));
  const file = path.join(dir, 'state.json');
  const state = createState(file);
  state.addJob({ id: 'affected', jid: 'owner-group@g.us' });
  state.markSeen('affected');
  state.completePublish({ sha: 'published-pdf', messageId: 'previous', id: 'BONA-W001', slug: 'existing', url: 'https://example.test/existing/' });
  const before = fs.readFileSync(file, 'utf8');
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    if (String(target).startsWith(file + '.tmp-')) {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
    return write(target, ...args);
  };
  try {
    assert.throws(() => state.addJob({ id: 'not-persisted', jid: 'owner-group@g.us' }), { code: 'ENOSPC' });
  } finally {
    fs.writeFileSync = write;
  }
  try {
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const recovered = createState(file);
    assert.deepEqual(recovered.pendingJobs().map(j => j.id), ['affected']);
    assert.equal(recovered.hasSeen('not-persisted'), false);
    assert.equal(recovered.duplicateGuard({ sha: 'published-pdf' }).published.id, 'BONA-W001');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quota limits remain queued across restarts and become eligible only after the cooldown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-quota-recovery-'));
  const file = path.join(dir, 'state.json');
  const now = Date.parse('2026-10-25T00:00:00Z');
  try {
    const state = createState(file);
    state.addJob({ id: 'quota', jid: 'owner-group@g.us', key: { id: 'quota', fromMe: true }, pdfPath: '/saved/original.pdf' });
    state.addJob({ id: 'other', jid: 'owner-group@g.us' });
    for (let i = 0; i < 5; i++) state.failJob('quota', "claude -p failed: You've hit your weekly limit · resets Oct 27, 6am (Asia/Riyadh)", { now });
    const restarted = createState(file);
    assert.equal(restarted.getJob('quota').status, 'pending');
    assert.equal(restarted.getJob('quota').attempts, 0);
    assert.equal(restarted.getJob('quota').pdfPath, '/saved/original.pdf');
    assert.deepEqual(restarted.pendingJobs({ now }).map(j => j.id), ['other']);
    const later = now + 3600_000;
    assert.deepEqual(restarted.pendingJobs({ now: later, retriesOnly: true }).map(j => j.id), ['quota']);
    assert.deepEqual(restarted.pendingJobs({ now: later, retriesOnly: true, activeIds: ['quota'] }), []);
    restarted.completePublish({ sha: 'new-pdf', messageId: 'quota', id: 'BONA-W002', slug: 'new', url: 'https://example.test/new/' });
    assert.deepEqual(restarted.pendingJobs({ now: later, retriesOnly: true }), []);
    restarted.failJob('quota', "claude -p failed: You've hit your session limit", { now });
    assert.equal(restarted.getJob('quota').status, 'done', 'a post-push error never reopens publication');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ordinary errors still exhaust three attempts and clear an old quota cooldown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-real-failure-'));
  try {
    const state = createState(path.join(dir, 'state.json'));
    state.addJob({ id: 'broken' });
    state.failJob('broken', "claude -p failed: You've hit your session limit");
    for (let i = 0; i < 3; i++) state.failJob('broken', 'invalid PDF');
    assert.equal(state.getJob('broken').status, 'failed');
    assert.equal(state.getJob('broken').retryAt, null);
    assert.equal(state.getJob('broken').attempts, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
