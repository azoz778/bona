// services/api/test/vps-deploy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VPS = path.resolve(HERE, '../../deploy/vps');
const SCRIPTS = ['lib.sh', 'install-vps.sh', 'deploy.sh', 'sync-secrets.sh', 'cutover.sh', 'rollback.sh'];
const SHIMS = path.join(HERE, 'fixtures', 'vps-shims');

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
  // where install-vps.sh lives on the VPS — /tmp/bona-vps until the branch is merged into /opt/bona
  assert.match(lib, /^BONA_VPS_DEPLOY_DIR=\$\{BONA_VPS_DEPLOY_DIR:-\$BONA_VPS_REPO\/services\/deploy\/vps\}$/m);
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
  // EnvironmentFile= values override Environment= values regardless of line order (systemd), so the
  // copied bona-services.env (PC port/paths) would cancel the VPS overrides above. The process reads
  // the env files itself (lib/env.mjs) — the unit must not.
  assert.doesNotMatch(api, /^EnvironmentFile=/m, 'the VPS unit must not load env files');
  assert.doesNotMatch(api, /@[A-Z_]+@/, 'unrendered placeholder');

  const cf = readFileSync(path.join(out, 'cloudflared-bona.service'), 'utf8');
  assert.match(cf, /--no-autoupdate/);
  assert.match(cf, /tunnel run 9022fbec-de4f-44b9-805e-8fff285d6263$/m);
  assert.match(cf, /^After=.*bona-api\.service/m);

  const sync = readFileSync(path.join(out, 'bona-repo-sync.service'), 'utf8');
  assert.match(sync, /^ExecStart=\/usr\/bin\/git -C \/opt\/bona pull --ff-only --quiet$/m);
  const timer = readFileSync(path.join(out, 'bona-repo-sync.timer'), 'utf8');
  // Wall-clock schedule: Persistent=true only catches up missed runs for OnCalendar= timers.
  assert.match(timer, /^OnCalendar=\*:0\/5$/m);
  assert.match(timer, /^RandomizedDelaySec=30$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.doesNotMatch(timer, /^On(BootSec|UnitActiveSec)=/m, 'monotonic timer keys must be gone');

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

// ---------------------------------------------------------------- cutover / rollback through the shims
// Every ssh/scp/systemctl/curl/node call the scripts make lands in the shim log, one argv per line
// (fixtures/vps-shims/*). Nothing real is touched: HOME is a temp dir, BONA_VPS_SSH is a fake host,
// BONA_WAIT_SCALE=0 makes wait_for retry without sleeping.
function runShimmed(script, args = [], scenario = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  mkdirSync(path.join(home, 'bona-data'), { recursive: true });
  writeFileSync(path.join(home, 'bona-data', 'bona.db'), '');
  const log = path.join(home, 'shim.log');
  // SHIM_PRESEED_START (test-side only): pretend an `enable --now bona-api` already went over ssh,
  // so a SHIM_SSH_DOWN_AFTER_START scenario is down from the very first call.
  const { SHIM_PRESEED_START, ...env } = scenario;
  writeFileSync(log, SHIM_PRESEED_START ? 'ssh -o BatchMode=yes -o ConnectTimeout=20 fake-vps systemctl --user enable --now bona-api\n' : '');
  const r = bash([path.join(VPS, script), ...args], {
    env: {
      PATH: `${SHIMS}:${process.env.PATH}`,
      HOME: home,
      SHIM_LOG: log,
      BONA_VPS_SSH: 'fake-vps',
      PC_NODE: path.join(SHIMS, 'node'),
      BONA_PUBLIC_HEALTH: 'https://public-health.invalid/health',
      BONA_WAIT_SCALE: '0',
      BONA_VPS_DEPLOY_DIR: '/tmp/bona-vps',
      ...env,
    },
  });
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, out: r.stdout + r.stderr, lines, home };
}
const REMOTE = '^ssh -o BatchMode=yes -o ConnectTimeout=20 fake-vps ';
const CALL = {
  pcStop: /^systemctl --user stop cloudflared-bona bona-api$/,
  scp: /^scp -q -p \S+\/bona-data\/bona\.db fake-vps:bona-data\/$/,
  vpsLeadCount: new RegExp(`${REMOTE}~\\/\\.local\\/opt\\/node-v24\\.19\\.0-linux-x64\\/bin\\/node -e .* ~\\/bona-data\\/bona\\.db$`),
  vpsStartApi: new RegExp(`${REMOTE}systemctl --user enable --now bona-api$`),
  vpsStartTimer: new RegExp(`${REMOTE}systemctl --user enable --now bona-repo-sync\\.timer$`),
  vpsStartTunnel: new RegExp(`${REMOTE}systemctl --user enable --now cloudflared-bona$`),
  vpsStopAll: new RegExp(`${REMOTE}systemctl --user disable --now cloudflared-bona bona-api bona-repo-sync\\.timer$`),
  vpsVerifyInactive: new RegExp(`${REMOTE}! systemctl --user is-active --quiet bona-api && ! systemctl --user is-active --quiet cloudflared-bona$`),
  vpsCheck: new RegExp(`${REMOTE}bash \\/tmp\\/bona-vps\\/install-vps\\.sh --check$`),
  pcNodeSqlite: /^node -e require\("node:sqlite"\)$/,
  pcDisable: /^systemctl --user disable bona-api cloudflared-bona$/,
  pcStart: /^systemctl --user enable --now bona-api cloudflared-bona$/,
  publicHealth: /^curl .*https:\/\/public-health\.invalid\/health$/,
};
// assertOrdered(lines, re1, re2, …) → each call happened, and in this order.
function assertOrdered(lines, ...res) {
  let last = -1;
  for (const re of res) {
    const i = lines.findIndex((l) => re.test(l));
    assert.ok(i >= 0, `expected a call matching ${re}\n--- shim log ---\n${lines.join('\n')}`);
    assert.ok(i > last, `${re} should come after the previous call\n--- shim log ---\n${lines.join('\n')}`);
    last = i;
  }
}
const MANUAL_STOP = 'ssh fake-vps systemctl --user disable --now cloudflared-bona bona-api';
const MANUAL_START = 'systemctl --user enable --now bona-api cloudflared-bona';

test('cutover.sh: happy path — stop PC, copy, start VPS API then tunnel, disable PC; no rollback', () => {
  const r = runShimmed('cutover.sh');
  assert.equal(r.status, 0, r.out);
  // The VPS lead count is a copy-integrity check: it is taken right after the scp, before the VPS
  // API (and its poller) can open the database.
  assertOrdered(r.lines, CALL.pcNodeSqlite, CALL.vpsCheck, CALL.pcStop, CALL.scp, CALL.vpsLeadCount, CALL.vpsStartApi, CALL.vpsStartTimer, CALL.vpsStartTunnel, CALL.publicHealth, CALL.pcDisable);
  assert.ok(!r.lines.some((l) => /^systemctl .*enable --now/.test(l)), `no PC unit may be started on success\n${r.lines.join('\n')}`);
  assert.ok(!r.lines.some((l) => CALL.vpsStopAll.test(l)), 'no rollback on success');
});

test('cutover.sh: a PC node without node:sqlite is refused before anything is touched', () => {
  const r = runShimmed('cutover.sh', [], { SHIM_NODE_NO_SQLITE: '1' });
  assert.notEqual(r.status, 0, 'cutover must refuse');
  assert.match(r.out, /node:sqlite/);
  assert.ok(!r.lines.some((l) => /^(ssh|scp|systemctl) /.test(l)), `nothing may be called before the preflight passes\n${r.lines.join('\n')}`);
});

test('cutover.sh: public health never comes back — VPS units stopped AND verified inactive before the PC units start', () => {
  const r = runShimmed('cutover.sh', [], { SHIM_PUBLIC_HEALTH_FAIL: '1' });
  assert.notEqual(r.status, 0, 'cutover must fail');
  assertOrdered(r.lines, CALL.vpsStartTunnel, CALL.publicHealth, CALL.vpsStopAll, CALL.vpsVerifyInactive, CALL.pcStart);
  assert.ok(!r.lines.some((l) => CALL.pcDisable.test(l)), 'the PC units must not be disabled after a failed cutover');
});

test('cutover.sh: a VPS unit refuses to stop — fail closed: the PC units are never started, manual commands printed', () => {
  const r = runShimmed('cutover.sh', [], { SHIM_PUBLIC_HEALTH_FAIL: '1', SHIM_VPS_STOP_FAILS: '1' });
  assert.notEqual(r.status, 0, 'cutover must fail');
  assertOrdered(r.lines, CALL.vpsStopAll, CALL.vpsVerifyInactive);
  assert.ok(!r.lines.some((l) => /^systemctl .*enable --now/.test(l)), `PC units must NOT be started while the VPS may still run\n${r.lines.join('\n')}`);
  assert.ok(r.out.includes(MANUAL_STOP), `manual stop command missing:\n${r.out}`);
  assert.ok(r.out.includes(MANUAL_START), `manual start command missing:\n${r.out}`);
});

test('cutover.sh: ssh dies after the VPS API was started — fail closed, PC units never started', () => {
  const r = runShimmed('cutover.sh', [], { SHIM_SSH_DOWN_AFTER_START: '1' });
  assert.notEqual(r.status, 0, 'cutover must fail');
  assertOrdered(r.lines, CALL.vpsStartApi, CALL.vpsStopAll);
  assert.ok(!r.lines.some((l) => /^systemctl .*enable --now/.test(l)), `PC units must NOT be started when the VPS cannot be reached\n${r.lines.join('\n')}`);
  assert.ok(r.out.includes(MANUAL_STOP) && r.out.includes(MANUAL_START), `manual commands missing:\n${r.out}`);
});

test('rollback.sh: stops the VPS units and verifies them inactive, only then starts the PC units', () => {
  const r = runShimmed('rollback.sh');
  assert.equal(r.status, 0, r.out);
  assertOrdered(r.lines, CALL.vpsStopAll, CALL.vpsVerifyInactive, CALL.pcStart, CALL.publicHealth);
});

test('rollback.sh: a VPS unit refuses to stop — fail closed, PC units never started', () => {
  const r = runShimmed('rollback.sh', [], { SHIM_VPS_STOP_FAILS: '1' });
  assert.notEqual(r.status, 0, 'rollback must fail');
  assertOrdered(r.lines, CALL.vpsStopAll, CALL.vpsVerifyInactive);
  assert.ok(!r.lines.some((l) => /^systemctl .*enable --now/.test(l)), `PC units must NOT be started\n${r.lines.join('\n')}`);
  assert.ok(r.out.includes(MANUAL_STOP) && r.out.includes(MANUAL_START), `manual commands missing:\n${r.out}`);
});

test('rollback.sh: VPS unreachable — fail closed (a "could not reach" warning is not enough)', () => {
  // SHIM_SSH_DOWN_AFTER_START needs an enable to have been seen; pre-seed the log with one so every call fails.
  const r = runShimmed('rollback.sh', [], { SHIM_SSH_DOWN_AFTER_START: '1', SHIM_PRESEED_START: '1' });
  assert.notEqual(r.status, 0, 'rollback must fail');
  assert.ok(!r.lines.some((l) => /^systemctl .*enable --now/.test(l)), `PC units must NOT be started\n${r.lines.join('\n')}`);
  assert.ok(r.out.includes(MANUAL_STOP) && r.out.includes(MANUAL_START), `manual commands missing:\n${r.out}`);
});

// ---------------------------------------------------------------- hardening (review 2026-09-08)
// fakeVpsHome() → a temp HOME laid out like the VPS user's: the pinned node and cloudflared paths
// point at the shims, and a temp "repo" holds the four files install-vps.sh --check looks for.
function fakeVpsHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-vps-home-'));
  const nodeBin = path.join(home, '.local', 'opt', 'node-v24.19.0-linux-x64', 'bin');
  mkdirSync(nodeBin, { recursive: true });
  symlinkSync(path.join(SHIMS, 'node'), path.join(nodeBin, 'node'));
  mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  symlinkSync(path.join(SHIMS, 'cloudflared'), path.join(home, '.local', 'bin', 'cloudflared'));
  const repo = mkdtempSync(path.join(tmpdir(), 'bona-repo-'));
  for (const f of ['services/api/index.mjs', 'src/data/listings.json', 'src/data/site.json', 'services/api/retell/ids.json']) {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), f.endsWith('.json') ? '{}' : '// stub');
  }
  const log = path.join(home, 'shim.log');
  writeFileSync(log, '');
  const env = { PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_REPO: repo, BONA_WAIT_SCALE: '0' };
  const shimLog = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { home, repo, env, shimLog };
}

test('install-vps.sh --smoke refuses to start when the smoke port is already listening', async () => {
  if (spawnSync('ss', ['-V'], { encoding: 'utf8' }).error) return; // no `ss` here: the check cannot run
  const { env } = fakeVpsHome();
  const server = net.createServer();
  await new Promise((resolve) => { server.once('error', resolve); server.listen(4121, '127.0.0.1', resolve); }); // EADDRINUSE is fine: still listening
  try {
    const r = bash([path.join(VPS, 'install-vps.sh'), '--smoke'], { env });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /4121.*listening/);
  } finally {
    server.close();
  }
  // and when it does start, the API is exec'd (so the pid we kill is node, not a subshell)
  assert.match(readFileSync(path.join(VPS, 'install-vps.sh'), 'utf8'), /exec "\$NODE_BIN\/node" api\/index\.mjs \) &$/m);
});

test('sync-secrets.sh chmods the four named secret files on the VPS, not *.env', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  mkdirSync(path.join(home, '.secrets'), { recursive: true });
  mkdirSync(path.join(home, '.cloudflared'), { recursive: true });
  for (const f of ['retell.env', 'evolution-api.env', 'bona-services.env', 'bona-marketing.env']) writeFileSync(path.join(home, '.secrets', f), 'X=1\n');
  writeFileSync(path.join(home, '.cloudflared', '9022fbec-de4f-44b9-805e-8fff285d6263.json'), '{}');
  const log = path.join(home, 'shim.log');
  writeFileSync(log, '');
  const r = bash([path.join(VPS, 'sync-secrets.sh')], { env: { PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_SSH: 'fake-vps' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const chmod = lines.find((l) => /^ssh fake-vps chmod 600 /.test(l));
  assert.ok(chmod, `expected a remote chmod\n${lines.join('\n')}`);
  for (const f of ['retell.env', 'evolution-api.env', 'bona-services.env', 'bona-marketing.env']) assert.ok(chmod.includes(`~/.secrets/${f}`), `${f} in: ${chmod}`);
  assert.ok(chmod.includes('~/.cloudflared/9022fbec-de4f-44b9-805e-8fff285d6263.json'), chmod);
  assert.ok(!chmod.includes('*.env'), `must not chmod a glob: ${chmod}`);
  assert.ok(lines.some((l) => /^scp -q -p .*\/\.secrets\/retell\.env .* fake-vps:\.secrets\/$/.test(l)), lines.join('\n'));
});

test('deploy.sh pauses bona-repo-sync.timer around pull/test/restart and always starts it again', () => {
  const { repo, env, shimLog } = fakeVpsHome();
  const r = bash([path.join(VPS, 'deploy.sh')], { env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assertOrdered(shimLog(),
    /^systemctl --user stop bona-repo-sync\.timer$/,
    new RegExp(`^git -C ${repo} pull --ff-only --quiet$`),
    /^node --test api\/test\/\*\.test\.mjs$/,
    /^systemctl --user restart bona-api\.service$/,
    /^curl .*http:\/\/127\.0\.0\.1:4120\/health$/,
    /^systemctl --user start bona-repo-sync\.timer$/);

  // tests red → no restart, timer still started again (EXIT trap)
  const failing = fakeVpsHome();
  const f = bash([path.join(VPS, 'deploy.sh')], { env: { ...failing.env, SHIM_NODE_TEST_FAIL: '1' } });
  assert.notEqual(f.status, 0, 'deploy must fail when the tests fail');
  const lines = failing.shimLog();
  assert.ok(!lines.some((l) => /^systemctl --user restart/.test(l)), `no restart on red tests\n${lines.join('\n')}`);
  assertOrdered(lines, /^systemctl --user stop bona-repo-sync\.timer$/, /^node --test/, /^systemctl --user start bona-repo-sync\.timer$/);
});

test('render() keeps & and | in a value verbatim (no sed, no patsub_replacement surprises)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  const out = mkdtempSync(path.join(tmpdir(), 'bona-render-'));
  const odd = 'http://127.0.0.1:8085/a&b|c';
  const r = bash([path.join(VPS, 'install-vps.sh'), '--render-only', out], { env: { HOME: home, BONA_VPS_EVOLUTION_URL: odd } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const api = readFileSync(path.join(out, 'bona-api.service'), 'utf8');
  assert.ok(api.includes(`Environment=EVOLUTION_API_URL=${odd}\n`), api);
  assert.doesNotMatch(api, /@[A-Z_]+@/, 'unrendered placeholder');
  // and the guard still fires for a placeholder nobody substitutes
  const lib = readFileSync(path.join(VPS, 'lib.sh'), 'utf8');
  assert.doesNotMatch(lib, /\bsed\b.*@HOME@/, 'render() must not go through sed');
  assert.match(lib, /unrendered placeholder/);
});

test('install-vps.sh refuses a non-x86_64 machine before downloading anything', () => {
  const { env, shimLog } = fakeVpsHome();
  const r = bash([path.join(VPS, 'install-vps.sh')], { env: { ...env, SHIM_UNAME_M: 'aarch64' } });
  assert.notEqual(r.status, 0, 'install must refuse');
  assert.match(r.stderr, /x86_64/);
  const lines = shimLog();
  assert.ok(!lines.some((l) => /^curl /.test(l)), `no download may start\n${lines.join('\n')}`);
});
