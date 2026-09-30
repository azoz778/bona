import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeVapidKeys } from '../bin/vapid-keys.mjs';
import { parseEnvText } from '../lib/env.mjs';
import { vapidKeys, VAPID_SUBJECT_RE } from '../lib/push.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/vapid-keys.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bona-vapid-'));

test('keys are appended once to the env file, as a working pair, and the file stays 0600', () => {
  const dir = tmp();
  const file = path.join(dir, 'bona-services.env');
  fs.writeFileSync(file, 'BONA_WA_POLL_MS=20000', { mode: 0o600 });
  const out = writeVapidKeys(file);
  assert.equal(out.written, true);
  const env = parseEnvText(fs.readFileSync(file, 'utf8'));
  assert.equal(env.BONA_WA_POLL_MS, '20000', 'what was there is kept');
  assert.ok(vapidKeys({ publicKey: env.BONA_VAPID_PUBLIC, privateKey: env.BONA_VAPID_PRIVATE }), 'a pair that loads');
  assert.equal(out.publicKey, env.BONA_VAPID_PUBLIC);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = writeVapidKeys(file);
  assert.deepEqual(again, { written: false, reason: 'present' });
  assert.equal(parseEnvText(fs.readFileSync(file, 'utf8')).BONA_VAPID_PRIVATE, env.BONA_VAPID_PRIVATE, 'never overwritten');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a subject is written only when given; a missing file is created 0600', () => {
  const dir = tmp();
  const file = path.join(dir, 'new.env');
  writeVapidKeys(file, { subject: 'mailto:ops@example.com' });
  assert.equal(parseEnvText(fs.readFileSync(file, 'utf8')).BONA_VAPID_SUBJECT, 'mailto:ops@example.com');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the CLI prints the public key only, never the private one', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.env');
  const printed = execFileSync(process.execPath, [BIN, '--file', file], { encoding: 'utf8' });
  const env = parseEnvText(fs.readFileSync(file, 'utf8'));
  assert.ok(printed.includes(env.BONA_VAPID_PUBLIC));
  assert.ok(!printed.includes(env.BONA_VAPID_PRIVATE));
  assert.match(execFileSync(process.execPath, [BIN, '--file', file], { encoding: 'utf8' }), /already/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the CLI guard works through a symlink', () => {
  const dir = tmp();
  const link = path.join(dir, 'link.mjs');
  fs.symlinkSync(BIN, link);
  const file = path.join(dir, 'y.env');
  execFileSync(process.execPath, [link, '--file', file], { encoding: 'utf8' });
  assert.ok(parseEnvText(fs.readFileSync(file, 'utf8')).BONA_VAPID_PRIVATE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only one key present is an error, the file untouched', () => {
  const dir = tmp();
  const file = path.join(dir, 'p.env');
  fs.writeFileSync(file, 'BONA_VAPID_PUBLIC=x\n', { mode: 0o600 });
  assert.deepEqual(writeVapidKeys(file), { written: false, reason: 'partial' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'BONA_VAPID_PUBLIC=x\n');
  let status = null;
  try { execFileSync(process.execPath, [BIN, '--file', file], { encoding: 'utf8', stdio: 'pipe' }); } catch (err) { status = err.status; }
  assert.equal(status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pre-existing 0644 file ends 0600 with the keys appended', () => {
  const dir = tmp();
  const file = path.join(dir, 'm.env');
  fs.writeFileSync(file, 'A=1\n');
  fs.chmodSync(file, 0o644);
  assert.equal(writeVapidKeys(file).written, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bad subject is refused before the file is touched', () => {
  const dir = tmp();
  const file = path.join(dir, 'b.env');
  assert.deepEqual(writeVapidKeys(file, { subject: 'ops@example.com\nEVIL=1' }), { written: false, reason: 'bad_subject' });
  assert.deepEqual(writeVapidKeys(file, { subject: 'http://bona-real-estate.com' }), { written: false, reason: 'bad_subject' }, 'not https');
  assert.equal(fs.existsSync(file), false);
  // One rule for the CLI and the server's start-up check (lib/push.mjs): mailto: or https:, no whitespace.
  for (const good of ['mailto:ops@example.com', 'https://bona-real-estate.com']) assert.ok(VAPID_SUBJECT_RE.test(good), good);
  for (const bad of ['', 'http://x', 'https://x y', 'mailto:', 'ftp://x']) assert.equal(VAPID_SUBJECT_RE.test(bad), false, JSON.stringify(bad));
  fs.rmSync(dir, { recursive: true, force: true });
});
