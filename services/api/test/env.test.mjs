import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText, loadEnvFile, loadEnv, ensureServicesEnv, randomToken, defaultEnvFiles, setEnvValues } from '../lib/env.mjs';

test('dotenv parsing handles comments, blanks, export and quotes', () => {
  const parsed = parseEnvText([
    '# a comment', '', '  ', 'A=1', 'export B=two',
    "C='three'", 'D="four"', 'E=with=equals', 'not a pair', '9BAD=x',
  ].join('\n'));
  assert.deepEqual(parsed, { A: '1', B: 'two', C: 'three', D: 'four', E: 'with=equals' });
});

test('a missing env file is empty, never an exception', () => {
  assert.deepEqual(loadEnvFile('/definitely/not/here.env'), {});
});

test('process.env wins over the files, so systemd stays authoritative', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-env-'));
  const file = path.join(dir, 'a.env');
  fs.writeFileSync(file, 'BONA_SITE=https://from-file\nONLY_IN_FILE=1\n');
  const merged = loadEnv({ files: [file], base: { BONA_SITE: 'https://from-process' } });
  assert.equal(merged.BONA_SITE, 'https://from-process');
  assert.equal(merged.ONLY_IN_FILE, '1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('later files override earlier ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-env-'));
  fs.writeFileSync(path.join(dir, '1.env'), 'K=first\n');
  fs.writeFileSync(path.join(dir, '2.env'), 'K=second\n');
  const merged = loadEnv({ files: [path.join(dir, '1.env'), path.join(dir, '2.env')], base: {} });
  assert.equal(merged.K, 'second');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the four secret files are read in the documented order, marketing keys last', () => {
  const files = defaultEnvFiles('/home/tester');
  assert.deepEqual(files.map((f) => path.basename(f)), ['retell.env', 'evolution-api.env', 'bona-services.env', 'bona-marketing.env']);
  assert.ok(files.every((f) => f.startsWith('/home/tester/.secrets/')));
});

test('bona-services.env is created 0600 with every key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-home-'));
  const defaults = { BONA_SITE: 'https://bona.azoz.uk', BONA_TOOL_TOKEN: randomToken(16) };
  const res = ensureServicesEnv(defaults, { home });
  assert.equal(res.created, true);
  const stat = fs.statSync(res.file);
  assert.equal(stat.mode & 0o777, 0o600, 'secrets must not be world readable');
  assert.deepEqual(Object.keys(loadEnvFile(res.file)).sort(), Object.keys(defaults).sort());
  fs.rmSync(home, { recursive: true, force: true });
});

test('re-running only appends missing keys and never rewrites an existing value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-home-'));
  const first = ensureServicesEnv({ A: '1', BONA_TOOL_TOKEN: 'keepme' }, { home });
  const second = ensureServicesEnv({ A: '9', BONA_TOOL_TOKEN: 'newtoken', B: '2' }, { home });
  assert.equal(second.created, false);
  assert.deepEqual(second.added, ['B']);
  const values = loadEnvFile(first.file);
  assert.equal(values.A, '1');
  assert.equal(values.BONA_TOOL_TOKEN, 'keepme', 'an existing token must survive re-provisioning');
  assert.equal(values.B, '2');
  fs.rmSync(home, { recursive: true, force: true });
});

test('randomToken is 32 hex characters and does not repeat', () => {
  const a = randomToken(16);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, randomToken(16));
});

test('setEnvValues rewrites one key in place and leaves the rest of the file alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-env-'));
  const file = path.join(dir, 'bona-services.env');
  fs.writeFileSync(file, [
    '# Bona services — created automatically. Do not commit.',
    'BONA_SITE=https://bona.azoz.uk',
    'BONA_TOOL_TOKEN=oldtokenvalue',
    '# BONA_TOOL_TOKEN=a-commented-out-decoy',
    'export BONA_DATA=/home/x/bona-data',
    '',
  ].join('\n'), { mode: 0o600 });

  const res = setEnvValues(file, { BONA_TOOL_TOKEN: 'newtokenvalue' });
  assert.deepEqual(res.replaced, ['BONA_TOOL_TOKEN']);
  assert.deepEqual(res.appended, []);

  const after = fs.readFileSync(file, 'utf8');
  assert.equal(loadEnvFile(file).BONA_TOOL_TOKEN, 'newtokenvalue');
  assert.equal(loadEnvFile(file).BONA_SITE, 'https://bona.azoz.uk');
  assert.equal(loadEnvFile(file).BONA_DATA, '/home/x/bona-data');
  assert.ok(after.includes('# Bona services'), 'comments survive');
  assert.ok(after.includes('# BONA_TOOL_TOKEN=a-commented-out-decoy'), 'a commented key is not a key');
  assert.equal(after.includes('oldtokenvalue'), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setEnvValues appends a key the file does not have yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-env-'));
  const file = path.join(dir, 'new.env');
  setEnvValues(file, { BONA_TOOL_TOKEN: 'abc', BONA_SITE: 'https://bona.azoz.uk' });
  assert.deepEqual(loadEnvFile(file), { BONA_TOOL_TOKEN: 'abc', BONA_SITE: 'https://bona.azoz.uk' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
