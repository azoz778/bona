// services/api/test/vps-deploy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VPS = path.resolve(HERE, '../../deploy/vps');
const SCRIPTS = ['lib.sh', 'install-vps.sh', 'deploy.sh', 'sync-secrets.sh', 'cutover.sh', 'rollback.sh'];

function bash(args, opts = {}) {
  return spawnSync('bash', args, { encoding: 'utf8', env: { PATH: process.env.PATH, ...opts.env }, cwd: VPS });
}

test('every script parses (bash -n)', () => {
  for (const s of SCRIPTS) {
    const r = bash(['-n', path.join(VPS, s)]);
    assert.equal(r.status, 0, `${s}: ${r.stderr}`);
  }
});

test('lib.sh pins versions with real checksums and the three public hostnames', () => {
  const lib = readFileSync(path.join(VPS, 'lib.sh'), 'utf8');
  assert.match(lib, /^NODE_VERSION=v24\.19\.0$/m);
  assert.match(lib, /^NODE_SHA256=[0-9a-f]{64}$/m);
  assert.match(lib, /^CLOUDFLARED_VERSION=2026\.8\.3$/m);
  assert.match(lib, /^CLOUDFLARED_SHA256=[0-9a-f]{64}$/m);
  assert.match(lib, /^BONA_TUNNEL_ID=9022fbec-de4f-44b9-805e-8fff285d6263$/m);
  for (const h of ['api.bona-real-estate.com', 'bona-api.azoz.uk', 'bona.azoz.uk']) assert.ok(lib.includes(h), h);
  assert.match(lib, /^BONA_VPS_PORT=4120$/m);
});

test('install-vps.sh --render-only renders units and tunnel config for the VPS', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  const out = mkdtempSync(path.join(tmpdir(), 'bona-render-'));
  const r = bash([path.join(VPS, 'install-vps.sh'), '--render-only', out], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr + r.stdout);

  const api = readFileSync(path.join(out, 'bona-api.service'), 'utf8');
  assert.match(api, /^Environment=BONA_API_PORT=4120$/m);
  assert.match(api, /^Environment=BONA_REPO=\/opt\/bona$/m);
  assert.match(api, new RegExp(`^Environment=BONA_DATA=${home}/bona-data$`, 'm'));
  assert.match(api, /^Environment=EVOLUTION_API_URL=http:\/\/127\.0\.0\.1:8085$/m);
  assert.match(api, new RegExp(`^ExecStart=${home}/\\.local/opt/node-v24\\.19\\.0-linux-x64/bin/node /opt/bona/services/api/index\\.mjs$`, 'm'));
  assert.match(api, /^WorkingDirectory=\/opt\/bona\/services$/m);
  assert.match(api, new RegExp(`^ReadWritePaths=${home}/bona-data$`, 'm'));
  assert.doesNotMatch(api, /^Environment=.*BONA_WA_POLL/m, 'the unit must never force the poller on or off');
  assert.doesNotMatch(api, /@[A-Z_]+@/, 'unrendered placeholder');

  const cf = readFileSync(path.join(out, 'cloudflared-bona.service'), 'utf8');
  assert.match(cf, /--no-autoupdate/);
  assert.match(cf, /tunnel run 9022fbec-de4f-44b9-805e-8fff285d6263$/m);
  assert.match(cf, /^After=.*bona-api\.service/m);

  const sync = readFileSync(path.join(out, 'bona-repo-sync.service'), 'utf8');
  assert.match(sync, /^ExecStart=\/usr\/bin\/git -C \/opt\/bona pull --ff-only --quiet$/m);
  const timer = readFileSync(path.join(out, 'bona-repo-sync.timer'), 'utf8');
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(timer, /^Persistent=true$/m);

  const yml = readFileSync(path.join(out, 'bona.yml'), 'utf8');
  assert.match(yml, /^tunnel: 9022fbec-de4f-44b9-805e-8fff285d6263$/m);
  assert.match(yml, new RegExp(`^credentials-file: ${home}/\\.cloudflared/9022fbec-de4f-44b9-805e-8fff285d6263\\.json$`, 'm'));
  for (const h of ['api.bona-real-estate.com', 'bona-api.azoz.uk', 'bona.azoz.uk']) assert.match(yml, new RegExp(`^  - hostname: ${h.replace(/\./g, '\\.')}$`, 'm'), h);
  assert.equal((yml.match(/service: http:\/\/127\.0\.0\.1:4120/g) || []).length, 3);
  assert.match(yml.trimEnd(), /- service: http_status:404$/);
  for (const f of readdirSync(out)) assert.equal(statSync(path.join(out, f)).mode & 0o777, 0o600, `${f} mode`);
});

test('install-vps.sh --check on an empty HOME reports what is missing and exits 2', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  const r = bash([path.join(VPS, 'install-vps.sh'), '--check'], { env: { HOME: home, BONA_VPS_REPO: path.join(home, 'repo') } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  for (const s of ['retell.env', 'evolution-api.env', 'bona-services.env', 'bona-marketing.env', '9022fbec-de4f-44b9-805e-8fff285d6263.json', 'node', 'cloudflared', 'bona-api.service']) {
    assert.ok(r.stdout.includes(s), `--check should mention ${s}\n${r.stdout}`);
  }
});

test('cutover.sh --dry-run prints the five steps and touches nothing', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  const r = bash([path.join(VPS, 'cutover.sh'), '--dry-run'], { env: { HOME: home, BONA_VPS_SSH: 'ssh-must-not-be-called' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const s of ['stop', 'copy', 'start bona-api', 'start cloudflared-bona', 'disable']) assert.ok(r.stdout.toLowerCase().includes(s), s);
  assert.equal(readdirSync(home).length, 0, 'dry run must not create files');
});

test('no script under deploy/vps carries a secret-looking value', () => {
  for (const f of readdirSync(VPS)) {
    const p = path.join(VPS, f);
    if (!statSync(p).isFile()) continue;
    const text = readFileSync(p, 'utf8');
    assert.doesNotMatch(text, /(key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{24,}/i, f);
  }
});
