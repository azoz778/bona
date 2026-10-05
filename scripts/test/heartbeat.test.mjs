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
test('the push URL is a secret: credentials are refused before any request, and failures log only a category', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-hb-secret-'));
  try {
    fs.mkdirSync(path.join(dataDir, 'daily'), { recursive: true });
    const urlFile = path.join(dataDir, 'daily', 'heartbeat-facebook.url');
    const lines = [], log = s => lines.push(String(s));
    let calls = 0;
    const ok = async () => { calls++; return new Response('{"ok":true}'); };
    const beat = { status: 'down', msg: 'x' };
    for (const bad of ['https://kuma:hunter2@uptime.example/api/push/abc123', 'https://kuma@uptime.example/api/push/abc123', 'not a url', 'http://uptime.example/api/push/abc123']) {
      fs.writeFileSync(urlFile, bad);
      lines.length = 0;
      assert.deepEqual(await pushHeartbeat('facebook', beat, { dataDir, fetchImpl: ok, log }), { sent: false, reason: 'error' }, bad);
      assert.deepEqual(lines, ['heartbeat: facebook push URL invalid'], bad);
    }
    assert.equal(calls, 0, 'nothing is requested from an invalid URL');
    const token = 'S3cretPushToken42';
    fs.writeFileSync(urlFile, `https://uptime.example/api/push/${token}`);
    lines.length = 0;
    const leaky = async url => { throw new Error(`connect ECONNREFUSED while fetching ${url} (${token})`); };
    assert.deepEqual(await pushHeartbeat('facebook', beat, { dataDir, fetchImpl: leaky, log }), { sent: false, reason: 'error' });
    assert.deepEqual(lines, ['heartbeat: facebook push failed (network)']);
    lines.length = 0;
    const unavailable = async () => new Response(`no monitor for ${token}`, { status: 503 });
    assert.deepEqual(await pushHeartbeat('facebook', beat, { dataDir, fetchImpl: unavailable, log }), { sent: false, reason: 'error' });
    assert.deepEqual(lines, ['heartbeat: facebook push failed (http 503)']);
    lines.length = 0;
    assert.deepEqual(await pushHeartbeat('facebook', { status: 'up', msg: 'published' }, { dataDir, fetchImpl: ok, log }), { sent: true });
    assert.deepEqual(lines, ['heartbeat: facebook up']);
    assert.ok(!lines.join('\n').includes(token));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
