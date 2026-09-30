import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeVapidKeys } from '../bin/vapid-keys.mjs';
import { parseEnvText } from '../lib/env.mjs';
import { vapidKeys } from '../lib/push.mjs';

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
