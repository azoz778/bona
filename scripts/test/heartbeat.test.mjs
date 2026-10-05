import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heartbeatFor, pushHeartbeat, continueToPack } from '../social/lib/heartbeat.mjs';

const at = hhmm => new Date(`2026-10-05T${hhmm}:00+03:00`);
test('only a skipped property run continues into the reviewed pack', () => {
  assert.equal(continueToPack({ status: 'skipped-no-eligible-property' }), true);
  for (const status of ['published', 'already-published', 'ready', 'not-due']) assert.equal(continueToPack({ status }), false);
  assert.equal(continueToPack(undefined), false);
});
test('a confirmed publication is always up; silence before 22:30; down in the last two runs', () => {
  assert.deepEqual(heartbeatFor({ status: 'published', now: at('20:31') }), { status: 'up', msg: 'published' });
  assert.deepEqual(heartbeatFor({ status: 'already-published', now: at('22:45') }), { status: 'up', msg: 'already-published' });
  assert.equal(heartbeatFor({ status: 'skipped-no-eligible-property', now: at('20:30') }), null);
  assert.equal(heartbeatFor({ status: 'skipped-no-eligible-property', now: at('22:29') }), null);
  assert.deepEqual(heartbeatFor({ status: 'skipped-no-eligible-property', now: at('22:30') }), { status: 'down', msg: 'skipped-no-eligible-property' });
  assert.equal(heartbeatFor({ status: 'not-due', now: at('23:00') }), null);
  assert.equal(heartbeatFor({ status: 'published', now: at('20:31'), dry: true }), null);
  assert.deepEqual(heartbeatFor({ error: new Error('boom EAAabc123'), now: at('22:45') }), { status: 'down', msg: 'boom [redacted]' });
});
test('push reads the URL outside the repo, adds status and message, and never throws', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-hb-'));
  try {
    const log = () => {};
    const calls = [];
    const ok = async (url, opts) => { calls.push({ url, opts }); return new Response('{"ok":true}'); };
    assert.deepEqual(await pushHeartbeat('instagram', { status: 'up', msg: 'published' }, { dataDir, fetchImpl: ok, log }), { sent: false, reason: 'no-url' });
    assert.equal(calls.length, 0);
    fs.mkdirSync(path.join(dataDir, 'daily'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'daily', 'heartbeat-instagram.url'), 'https://uptime.example/api/push/abc123\n');
    assert.deepEqual(await pushHeartbeat('instagram', { status: 'up', msg: 'published' }, { dataDir, fetchImpl: ok, log }), { sent: true });
    const u = new URL(calls[0].url);
    assert.equal(u.origin + u.pathname, 'https://uptime.example/api/push/abc123');
    assert.equal(u.searchParams.get('status'), 'up');
    assert.equal(u.searchParams.get('msg'), 'instagram: published');
    assert.equal(calls[0].opts.redirect, 'error');
    const boom = async () => { throw new Error('network down'); };
    assert.deepEqual(await pushHeartbeat('instagram', { status: 'down', msg: 'x' }, { dataDir, fetchImpl: boom, log }), { sent: false, reason: 'error' });
    const notFound = async () => new Response('nope', { status: 404 });
    assert.deepEqual(await pushHeartbeat('instagram', { status: 'down', msg: 'x' }, { dataDir, fetchImpl: notFound, log }), { sent: false, reason: 'error' });
    fs.writeFileSync(path.join(dataDir, 'daily', 'heartbeat-instagram.url'), 'http://uptime.example/api/push/abc123');
    assert.deepEqual(await pushHeartbeat('instagram', { status: 'up', msg: 'x' }, { dataDir, fetchImpl: ok, log }), { sent: false, reason: 'error' });
    assert.deepEqual(await pushHeartbeat('instagram', null, { dataDir, fetchImpl: ok, log }), { sent: false, reason: 'nothing-to-say' });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
