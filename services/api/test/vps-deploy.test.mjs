// services/api/test/vps-deploy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir, userInfo } from 'node:os';
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
  const r = bash([path.join(VPS, 'install-vps.sh'), '--render-only', out], { env: { HOME: home, VPS_USER: 'svc' } });
  assert.equal(r.status, 0, r.stderr + r.stdout);

  const api = readFileSync(path.join(out, 'bona-api.service'), 'utf8');
  // SYSTEM units run as the service user (Ubuntu 24.04's userns restriction kills the sandbox
  // directives under `systemctl --user`: 218/CAPABILITIES on the first live cutover, 2026-09-08).
  // User=/Group= come from VPS_USER; HOME is explicit because the process resolves ~/.secrets,
  // cloudflared ~/.cloudflared and git its config through it.
  for (const [name, text] of [['bona-api.service', api], ['cloudflared-bona.service', readFileSync(path.join(out, 'cloudflared-bona.service'), 'utf8')], ['bona-repo-sync.service', readFileSync(path.join(out, 'bona-repo-sync.service'), 'utf8')]]) {
    assert.match(text, /^User=svc$/m, `${name}: User=`);
    assert.match(text, /^Group=svc$/m, `${name}: Group=`);
    assert.match(text, new RegExp(`^Environment=HOME=${home}$`, 'm'), `${name}: HOME`);
  }
  // system units hook multi-user.target (the timer keeps timers.target); no user-manager specifier survives
  assert.match(api, /^WantedBy=multi-user\.target$/m);
  assert.match(readFileSync(path.join(out, 'cloudflared-bona.service'), 'utf8'), /^WantedBy=multi-user\.target$/m);
  assert.match(readFileSync(path.join(out, 'bona-repo-sync.timer'), 'utf8'), /^WantedBy=timers\.target$/m);
  for (const f of readdirSync(out)) assert.ok(!readFileSync(path.join(out, f), 'utf8').includes('%h'), `${f}: %h is a user-manager specifier`);
  assert.doesNotMatch(api, /^WantedBy=default\.target$/m);
  assert.match(api, /apparmor_restrict_unprivileged_userns/, 'the unit explains why it is a system unit');
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
  assert.doesNotMatch(sync, /@[A-Z_]+@/, 'unrendered placeholder');
  // GIT_BIN is the one knob for that path (rendered from lib.sh, checked by --check)
  const out2 = mkdtempSync(path.join(tmpdir(), 'bona-render-'));
  const r2 = bash([path.join(VPS, 'install-vps.sh'), '--render-only', out2], { env: { HOME: home, GIT_BIN: '/snap/bin/git' } });
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  assert.match(readFileSync(path.join(out2, 'bona-repo-sync.service'), 'utf8'), /^ExecStart=\/snap\/bin\/git -C \/opt\/bona pull --ff-only --quiet$/m);
  // VPS_USER defaults to whoever runs install-vps.sh (azoz on the VPS)
  assert.match(readFileSync(path.join(out2, 'bona-api.service'), 'utf8'), new RegExp(`^User=${userInfo().username}$`, 'm'));
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
  // BONA_UNIT_DIR: the system unit directory (/etc/systemd/system on the VPS) — pointed at a temp dir
  // here so the host's /etc never decides the test. The sudo shim refuses (SHIM_SUDO_FAIL) so the host's
  // own sudo setup does not decide it either.
  const r = bash([path.join(VPS, 'install-vps.sh'), '--check'], { env: { PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, BONA_VPS_REPO: path.join(home, 'repo'), GIT_BIN: path.join(home, 'no-git'), BONA_UNIT_DIR: path.join(home, 'units'), SHIM_SUDO_FAIL: '1' } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  // the sync unit's ExecStart is an absolute git path: --check must say when it is not there
  assert.match(stripAnsi(r.stdout), new RegExp(`^MISSING: git at ${home}/no-git`, 'm'), r.stdout);
  for (const s of ['retell.env', 'evolution-api.env', 'bona-services.env', 'bona-marketing.env', '9022fbec-de4f-44b9-805e-8fff285d6263.json', 'node', 'cloudflared', 'bona-api.service']) {
    assert.ok(r.stdout.includes(s), `--check should mention ${s}\n${r.stdout}`);
  }
  // one greppable line per missing item
  assert.match(stripAnsi(r.stdout), /^MISSING: secret file .*retell\.env \(0600\)$/m, r.stdout);
  // the units are SYSTEM units under BONA_UNIT_DIR, driven with sudo -n: both are readiness items
  assert.match(stripAnsi(r.stdout), new RegExp(`^MISSING: unit ${home}/units/bona-api\\.service$`, 'm'), r.stdout);
  assert.match(stripAnsi(r.stdout), /^MISSING: passwordless sudo/m, r.stdout);
  assert.ok(!r.stdout.includes('linger'), `linger is a user-manager concern; system units do not need it\n${r.stdout}`);
});

test('cutover.sh --dry-run prints the five steps and touches nothing', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  const r = bash([path.join(VPS, 'cutover.sh'), '--dry-run'], { env: { HOME: home, BONA_VPS_SSH: 'ssh-must-not-be-called' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const s of ['stop', 'copy', 'start bona-api', 'start cloudflared-bona', 'disable']) assert.ok(r.stdout.toLowerCase().includes(s), s);
  assert.match(r.stdout, /sudo systemctl/, 'the plan says the VPS units are driven with sudo systemctl');
  assert.equal(readdirSync(home).length, 0, 'dry run must not create files');
});

// walk(dir) → every regular file below dir (templates/ and the shim fixtures included).
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const stripAnsi = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');

test('no script, template or test shim under deploy/vps carries a secret-looking value', () => {
  const files = [...walk(VPS), ...walk(SHIMS)];
  assert.ok(files.some((f) => f.endsWith('bona-api.service.in')) && files.some((f) => f.endsWith('vps-shims/ssh')), 'scan covers templates and shims');
  for (const p of files) {
    const text = readFileSync(p, 'utf8');
    assert.doesNotMatch(text, /(key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{24,}/i, p);
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
  // SHIM_STALE_WAL (test-side only): the PC still has a bona.db-wal from before the cutover.
  const { SHIM_PRESEED_START, SHIM_STALE_WAL, ...env } = scenario;
  if (SHIM_STALE_WAL) writeFileSync(path.join(home, 'bona-data', 'bona.db-wal'), 'stale');
  writeFileSync(log, SHIM_PRESEED_START ? 'ssh -o BatchMode=yes -o ConnectTimeout=20 fake-vps sudo -n systemctl enable --now bona-api\n' : '');
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
// On the VPS the units are SYSTEM units driven with `sudo -n systemctl` (lib.sh VPS_SYSTEMCTL);
// on the PC they stay `systemctl --user`. The two prefixes below keep that distinction visible.
const VPS_CTL = 'sudo -n systemctl';
const CALL = {
  pcStop: /^systemctl --user stop cloudflared-bona bona-api$/,
  pcApiInactive: /^systemctl --user is-active --quiet bona-api$/,
  pcTunnelInactive: /^systemctl --user is-active --quiet cloudflared-bona$/,
  scp: /^scp -q -p \S+\/bona-data\/bona\.db fake-vps:bona-data\/$/,
  vpsClearWal: new RegExp(`${REMOTE}rm -f ~\\/bona-data\\/bona\\.db-wal ~\\/bona-data\\/bona\\.db-shm$`),
  vpsLeadCount: new RegExp(`${REMOTE}~\\/\\.local\\/opt\\/node-v24\\.19\\.0-linux-x64\\/bin\\/node -e .* ~\\/bona-data\\/bona\\.db$`),
  vpsStartApi: new RegExp(`${REMOTE}${VPS_CTL} enable --now bona-api$`),
  vpsStartTimer: new RegExp(`${REMOTE}${VPS_CTL} enable --now bona-repo-sync\\.timer$`),
  vpsStartTunnel: new RegExp(`${REMOTE}${VPS_CTL} enable --now cloudflared-bona$`),
  vpsStopAll: new RegExp(`${REMOTE}${VPS_CTL} disable --now cloudflared-bona bona-api bona-repo-sync\\.timer$`),
  vpsVerifyInactive: new RegExp(`${REMOTE}! ${VPS_CTL} is-active --quiet bona-api && ! ${VPS_CTL} is-active --quiet cloudflared-bona$`),
  vpsApiActive: new RegExp(`${REMOTE}${VPS_CTL} is-active --quiet bona-api$`),
  vpsCheck: new RegExp(`${REMOTE}bash \\/tmp\\/bona-vps\\/install-vps\\.sh --check$`),
  pcNodeSqlite: /^node -e require\("node:sqlite"\)$/,
  pcDisable: /^systemctl --user disable bona-api cloudflared-bona$/,
  pcStart: /^systemctl --user enable --now bona-api cloudflared-bona$/,
  publicHealth: /^curl .*https:\/\/public-health\.invalid\/health$/,
  // rollback.sh --copy-back: VPS → a temp dir under the PC's bona-data
  scpBack: (f) => new RegExp(`^scp -q -p fake-vps:bona-data\\/${f.replace(/\./g, '\\.')} \\S+\\/bona-data\\/\\.copy-back\\.[^/]+\\/$`),
  vpsHasFile: (f) => new RegExp(`${REMOTE}test -f ~\\/bona-data\\/${f.replace(/\./g, '\\.')}$`),
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
const MANUAL_STOP = 'ssh fake-vps sudo -n systemctl disable --now cloudflared-bona bona-api';
const MANUAL_START = 'systemctl --user enable --now bona-api cloudflared-bona';
// Nothing sent over ssh may address the user manager: the VPS units are system units.
const noRemoteUserManager = (r) => assert.ok(!r.lines.some((l) => /^ssh .*(systemctl|journalctl) --user/.test(l)), `remote systemctl/journalctl --user\n${r.lines.join('\n')}`);

test('cutover.sh: happy path — stop PC, copy, start VPS API then tunnel, disable PC; no rollback', () => {
  const r = runShimmed('cutover.sh');
  assert.equal(r.status, 0, r.out);
  // The PC units are verified inactive (both of them) between the stop and the copy: the copy is
  // consistent only when nothing on the PC still writes. The VPS lead count is a copy-integrity
  // check: it is taken right after the scp, before the VPS API (and its poller) can open the database.
  // Stale WAL/SHM left on the VPS by an earlier attempt are cleared before the copy, so the copied
  // database is never opened next to someone else's write-ahead log.
  assertOrdered(r.lines, CALL.pcNodeSqlite, CALL.vpsCheck, CALL.pcStop, CALL.pcApiInactive, CALL.pcTunnelInactive, CALL.vpsClearWal, CALL.scp, CALL.vpsLeadCount, CALL.vpsStartApi, CALL.vpsStartTimer, CALL.vpsStartTunnel, CALL.publicHealth, CALL.pcDisable);
  const scpAt = r.lines.findIndex((l) => CALL.scp.test(l));
  for (const re of [CALL.pcApiInactive, CALL.pcTunnelInactive]) {
    const i = r.lines.findIndex((l) => re.test(l));
    assert.ok(i > r.lines.findIndex((l) => CALL.pcStop.test(l)) && i < scpAt, `${re} must sit between the PC stop and the scp\n${r.lines.join('\n')}`);
  }
  assert.ok(!r.lines.some((l) => /^systemctl .*enable --now/.test(l)), `no PC unit may be started on success\n${r.lines.join('\n')}`);
  assert.ok(!r.lines.some((l) => CALL.vpsStopAll.test(l)), 'no rollback on success');
  noRemoteUserManager(r);
  // and the PC side still talks to its own user manager, never to sudo
  assert.ok(r.lines.some((l) => CALL.pcStop.test(l)) && !r.lines.some((l) => /^sudo /.test(l)), `PC commands stay systemctl --user\n${r.lines.join('\n')}`);
});

test('cutover.sh: a PC node without node:sqlite is refused before anything is touched', () => {
  const r = runShimmed('cutover.sh', [], { SHIM_NODE_NO_SQLITE: '1' });
  assert.notEqual(r.status, 0, 'cutover must refuse');
  assert.match(r.out, /node:sqlite/);
  assert.ok(!r.lines.some((l) => /^(ssh|scp|systemctl) /.test(l)), `nothing may be called before the preflight passes\n${r.lines.join('\n')}`);
});

// A refused preflight must leave BOTH sides alone: nothing stopped on the PC, nothing disabled on
// the VPS (a copy that is legitimately live there must not be knocked over by a re-run).
const untouchedAfterPreflight = (r) => {
  assert.notEqual(r.status, 0, 'cutover must refuse');
  assert.ok(!r.lines.some((l) => CALL.pcStop.test(l)), `no local stop\n${r.lines.join('\n')}`);
  assert.ok(!r.lines.some((l) => /^systemctl .*enable --now/.test(l)), `no local start\n${r.lines.join('\n')}`);
  assert.ok(!r.lines.some((l) => CALL.vpsStopAll.test(l)), `no remote disable --now\n${r.lines.join('\n')}`);
  assert.ok(!r.lines.some((l) => /^scp /.test(l)), `nothing copied\n${r.lines.join('\n')}`);
  assert.ok(!r.lines.some((l) => /^ssh .*enable --now/.test(l)), `nothing started on the VPS\n${r.lines.join('\n')}`);
};

test('cutover.sh: preflight finds bona-api already active on the VPS — refused, PC not stopped, VPS not disabled', () => {
  const r = runShimmed('cutover.sh', [], { SHIM_VPS_ALREADY_ACTIVE: '1' });
  untouchedAfterPreflight(r);
  assert.match(r.out, /ALREADY running on the VPS/);
  assertOrdered(r.lines, CALL.vpsCheck, CALL.vpsApiActive);
});

test('cutover.sh: preflight finds legacy user units or processes on the VPS — refused, PC not stopped, VPS not disabled', () => {
  const r = runShimmed('cutover.sh', [], { SHIM_LEGACY_PRESENT: '1' });
  untouchedAfterPreflight(r);
  assert.match(r.out, /legacy user units or processes/);
  const probe = r.lines.find((l) => /^ssh .*! ls ~\/\.config\/systemd\/user\/bona-api\.service/.test(l));
  assert.ok(probe, r.lines.join('\n'));
  // the process probes are anchored to the binary, so the remote shell carrying the pattern never matches itself
  assert.match(probe, /pgrep -u \$\(id -un\) -f '\^\[\^ \]\*\/node \/opt\/bona\/services\/api\/index\[\.\]mjs'/);
  assert.match(probe, /pgrep -u \$\(id -un\) -f '\^\[\^ \]\*\/cloudflared \.\*tunnel run 9022fbec-de4f-44b9-805e-8fff285d6263'/);
});

test('cutover.sh: preflight install-vps.sh --check fails on the VPS — refused, PC not stopped, VPS not disabled', () => {
  const r = runShimmed('cutover.sh', [], { SHIM_CHECK_FAIL: '1' });
  untouchedAfterPreflight(r);
  assert.match(r.out, /not ready/);
  assert.ok(r.lines.some((l) => CALL.vpsCheck.test(l)), `--check must have been asked\n${r.lines.join('\n')}`);
  assert.ok(!r.lines.some((l) => /^ssh .*is-active/.test(l)), `the unit probe comes after --check, so it must not run\n${r.lines.join('\n')}`);
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
  // the manual "is it really inactive?" line goes through sudo as well
  assert.ok(r.out.includes('ssh fake-vps sudo -n systemctl is-active bona-api cloudflared-bona'), r.out);
  noRemoteUserManager(r);
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
  assert.ok(!r.lines.some((l) => /^scp /.test(l)), `plain rollback copies nothing\n${r.lines.join('\n')}`);
  noRemoteUserManager(r);
});

// ---- --copy-back: the VPS's newer data replaces the PC's, all of it or none of it (Codex review)
const JSONL = ['leads.jsonl', 'chats.jsonl', 'calls.jsonl'];
const noPcStart = (r, why) => assert.ok(!r.lines.some((l) => /^systemctl .*enable --now/.test(l)), `${why}\n${r.lines.join('\n')}`);

test('rollback.sh --copy-back: VPS verified inactive, PC API stopped, bona.db + the jsonl files fetched into a temp dir, counts compared, then the PC units start', () => {
  const r = runShimmed('rollback.sh', ['--copy-back'], { SHIM_REMOTE_MISSING: 'bona.db-wal bona.db-shm', SHIM_STALE_WAL: '1' });
  assert.equal(r.status, 0, r.out);
  assertOrdered(r.lines, CALL.pcNodeSqlite, CALL.vpsStopAll, CALL.vpsVerifyInactive,
    /^systemctl --user is-active --quiet bona-api$/, /^systemctl --user stop bona-api$/,
    CALL.scpBack('bona.db'), CALL.vpsHasFile('bona.db-wal'), CALL.vpsHasFile('leads.jsonl'), CALL.scpBack('leads.jsonl'),
    CALL.scpBack('calls.jsonl'), CALL.vpsLeadCount, CALL.pcStart, CALL.publicHealth);
  // bona.db is fetched unconditionally (never probed with test -f); the WAL/SHM pair was absent, so never fetched
  assert.ok(!r.lines.some((l) => CALL.vpsHasFile('bona.db').test(l)), r.lines.join('\n'));
  for (const f of ['bona.db-wal', 'bona.db-shm']) assert.ok(!r.lines.some((l) => CALL.scpBack(f).test(l)), `${f} must not be fetched`);
  for (const f of ['bona.db', ...JSONL]) assert.ok(statSync(path.join(r.home, 'bona-data', f)).isFile(), `${f} should be in bona-data`);
  for (const f of ['bona.db', ...JSONL]) assert.equal(statSync(path.join(r.home, 'bona-data', f)).mode & 0o777, 0o600, `${f} mode`);
  assert.ok(!readdirSync(path.join(r.home, 'bona-data')).some((f) => f.startsWith('.copy-back.')), 'temp dir removed');
  assert.match(r.out, /absent on the VPS: bona\.db-wal/);
  // the PC's pre-cutover WAL belongs to the OLD database; left beside the fresh bona.db SQLite would replay it
  assert.ok(!existsSync(path.join(r.home, 'bona-data', 'bona.db-wal')), 'stale bona.db-wal must be removed');
});

test('rollback.sh --copy-back: scp fails — exit ≠ 0, PC data untouched, temp dir removed, PC units NOT started', () => {
  const r = runShimmed('rollback.sh', ['--copy-back'], { SHIM_SCP_FAIL: '1' });
  assert.notEqual(r.status, 0, 'rollback must fail');
  assertOrdered(r.lines, CALL.vpsVerifyInactive, CALL.scpBack('bona.db'));
  noPcStart(r, 'PC units must NOT start on stale data');
  assert.ok(!r.lines.some((l) => CALL.vpsLeadCount.test(l)), 'no count after a failed copy');
  assert.ok(!readdirSync(path.join(r.home, 'bona-data')).some((f) => f.startsWith('.copy-back.')), 'temp dir removed');
  assert.ok(!r.lines.some((l) => /^systemctl --user disable/.test(l)), r.lines.join('\n'));
});

test('rollback.sh --copy-back: bona.db is not on the VPS — exit ≠ 0, PC units NOT started', () => {
  // bona.db is never probed with `test -f`; the scp itself fails (the shim answers like scp does for a missing file).
  const r = runShimmed('rollback.sh', ['--copy-back'], { SHIM_REMOTE_MISSING: 'bona.db' });
  assert.notEqual(r.status, 0, 'rollback must fail');
  noPcStart(r, 'PC units must NOT start without the database');
  assert.ok(!r.lines.some((l) => CALL.vpsLeadCount.test(l)), 'no count without the database');
  assert.ok(!readdirSync(path.join(r.home, 'bona-data')).some((f) => f.startsWith('.copy-back.')), 'temp dir removed');
});

test('rollback.sh --copy-back: a VPS unit refuses to stop — fail closed: no scp, PC units NOT started', () => {
  const r = runShimmed('rollback.sh', ['--copy-back'], { SHIM_VPS_STOP_FAILS: '1' });
  assert.notEqual(r.status, 0, 'rollback must fail');
  assertOrdered(r.lines, CALL.vpsStopAll, CALL.vpsVerifyInactive);
  assert.ok(!r.lines.some((l) => /^scp /.test(l)), `nothing may be copied while the VPS may still write\n${r.lines.join('\n')}`);
  noPcStart(r, 'PC units must NOT be started');
  assert.ok(r.out.includes(MANUAL_STOP) && r.out.includes(MANUAL_START), `manual commands missing:\n${r.out}`);
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
  // GIT_BIN: the sync unit hardcodes the git path and --check verifies it; the host's /usr/bin/git must not decide the test.
  const env = { PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_REPO: repo, BONA_WAIT_SCALE: '0', GIT_BIN: path.join(SHIMS, 'git') };
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

// deploy.sh runs ON the VPS, so its systemctl calls go through `sudo -n` (system units); the sudo
// shim logs the `sudo -n systemctl …` line and then execs the systemctl shim, which logs its own.
const TIMER = {
  wasActive: /^sudo -n systemctl is-active --quiet bona-repo-sync\.timer$/,
  // the timer AND its service: a pull already in flight must not collide with deploy.sh's own
  stopBoth: /^sudo -n systemctl stop bona-repo-sync\.timer bona-repo-sync\.service$/,
  start: /^sudo -n systemctl start bona-repo-sync\.timer$/,
  restart: /^sudo -n systemctl restart bona-api\.service$/,
};

test('deploy.sh pauses bona-repo-sync.timer (+ its service) around pull/test/restart and starts the timer again only if it was active', () => {
  const { repo, env, shimLog } = fakeVpsHome();
  const r = bash([path.join(VPS, 'deploy.sh')], { env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assertOrdered(shimLog(),
    TIMER.wasActive,
    TIMER.stopBoth,
    new RegExp(`^git -C ${repo} pull --ff-only --quiet$`),
    /^node --test api\/test\/\*\.test\.mjs$/,
    TIMER.restart,
    /^curl .*http:\/\/127\.0\.0\.1:4120\/health$/,
    TIMER.start);
  assert.ok(!shimLog().some((l) => /^(sudo -n )?systemctl --user/.test(l)), `deploy.sh must never address the user manager on the VPS\n${shimLog().join('\n')}`);

  // tests red → no restart, timer still started again (EXIT trap)
  const failing = fakeVpsHome();
  const f = bash([path.join(VPS, 'deploy.sh')], { env: { ...failing.env, SHIM_NODE_TEST_FAIL: '1' } });
  assert.notEqual(f.status, 0, 'deploy must fail when the tests fail');
  const lines = failing.shimLog();
  assert.ok(!lines.some((l) => /systemctl restart/.test(l)), `no restart on red tests\n${lines.join('\n')}`);
  assertOrdered(lines, TIMER.wasActive, TIMER.stopBoth, /^node --test/, TIMER.start);

  // timer was NOT active before (the owner paused it, or before the cutover enabled it) → deploy
  // must not switch it on as a side effect
  const paused = fakeVpsHome();
  const p = bash([path.join(VPS, 'deploy.sh')], { env: { ...paused.env, SHIM_LOCAL_INACTIVE: 'bona-repo-sync.timer' } });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  const plines = paused.shimLog();
  assertOrdered(plines, TIMER.wasActive, TIMER.stopBoth, TIMER.restart);
  assert.ok(!plines.some((l) => TIMER.start.test(l)), `an inactive timer must stay inactive\n${plines.join('\n')}`);
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

// ---------------------------------------------------------------- readiness, install mode, unit parity
test('install-vps.sh --check on a fully provisioned HOME reports every item ok and exits 0', () => {
  const { home, env } = fakeVpsHome();
  const secrets = path.join(home, '.secrets');
  const cf = path.join(home, '.cloudflared');
  // the system unit dir (/etc/systemd/system on the VPS) is a temp dir here; the sudo shim answers `-n true` with 0
  const units = path.join(home, 'etc-systemd-system');
  env.BONA_UNIT_DIR = units;
  for (const d of [secrets, cf, units]) mkdirSync(d, { recursive: true });
  for (const f of ['retell.env', 'evolution-api.env', 'bona-services.env', 'bona-marketing.env']) {
    writeFileSync(path.join(secrets, f), 'X=1\n');
    chmodSync(path.join(secrets, f), 0o600);
  }
  writeFileSync(path.join(cf, '9022fbec-de4f-44b9-805e-8fff285d6263.json'), '{}');
  chmodSync(path.join(cf, '9022fbec-de4f-44b9-805e-8fff285d6263.json'), 0o600);
  writeFileSync(path.join(cf, 'bona.yml'), 'tunnel: x\n');
  mkdirSync(path.join(home, 'bona-data'));
  chmodSync(path.join(home, 'bona-data'), 0o700);
  for (const u of ['bona-api.service', 'cloudflared-bona.service', 'bona-repo-sync.service', 'bona-repo-sync.timer']) writeFileSync(path.join(units, u), '[Unit]\n');
  const r = bash([path.join(VPS, 'install-vps.sh'), '--check'], { env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = stripAnsi(r.stdout).split('\n').filter(Boolean);
  assert.ok(lines.length > 15, `expected one line per item\n${r.stdout}`);
  for (const l of lines) assert.match(l, /^( ok  |==> )/, `every line must be ok: ${l}`);
  assert.ok(!stripAnsi(r.stdout + r.stderr).includes('MISSING'), r.stdout + r.stderr);
  assert.ok(lines.some((l) => l.startsWith(` ok  git at ${path.join(SHIMS, 'git')}`)), `--check must verify the git the sync unit will exec\n${r.stdout}`);
  assert.ok(lines.some((l) => l.startsWith(` ok  unit ${units}/bona-api.service`)), `--check must look for the units under BONA_UNIT_DIR\n${r.stdout}`);
  assert.ok(lines.some((l) => l.startsWith(' ok  passwordless sudo')), `system units are driven with sudo -n; --check must prove it works\n${r.stdout}`);
  assert.ok(!r.stdout.includes('linger'), r.stdout);
});

test('install-vps.sh install mode never enables, starts or restarts a unit', () => {
  const src = readFileSync(path.join(VPS, 'install-vps.sh'), 'utf8');
  // neither directly, nor through sudo, nor through lib.sh's $VPS_SYSTEMCTL, nor on the user manager
  assert.doesNotMatch(src, /(systemctl( --user)?|\$VPS_SYSTEMCTL) (enable|start|restart)\b/);
  // The only user-manager calls left are the retire step for the first attempt's user units:
  // `disable --now` (stop what may still be flapping) and a daemon-reload once the files are gone.
  const userCalls = [...new Set(src.match(/systemctl --user [a-z-]+/g) || [])].sort();
  assert.deepEqual(userCalls, ['systemctl --user daemon-reload', 'systemctl --user disable', 'systemctl --user is-active']);
  // …and a unit file is only deleted once the unit is verified inactive (a fileless running unit would be invisible)
  assert.match(src, /systemctl --user is-active --quiet "\$u"[^\n]*\n[^\n]*rm -f "\$LEGACY_USER_UNIT_DIR\/\$u"/);
  assert.match(src, /\[ "\$\(id -u\)" != 0 \] \|\| die/, 'refuses to run as root');
  // the legacy-process probe must not flag the live system units themselves after the cutover
  assert.match(src, /systemctl show -p MainPID --value bona-api cloudflared-bona/, 'live MainPIDs are excluded from the legacy probe');
  assert.match(src, /systemctl --user disable --now "\$u"/);
  // and the system units land in BONA_UNIT_DIR through sudo -n when the service user cannot write there
  assert.match(src, /sudo -n install -m 644 "\$tmp\/\$u" "\$BONA_UNIT_DIR\/\$u"/);
  assert.match(src, /\$VPS_SYSTEMCTL daemon-reload/);
});

// serviceKeys(unit text) → Map key → [values…] for the [Service] section only.
function serviceKeys(text) {
  const map = new Map();
  let inService = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inService = line === '[Service]'; continue; }
    if (!inService || !line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const k = line.slice(0, eq);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(line.slice(eq + 1));
  }
  return map;
}

test('the rendered VPS unit keeps every [Service] directive of the PC unit (hardening parity)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  const out = mkdtempSync(path.join(tmpdir(), 'bona-render-'));
  const r = bash([path.join(VPS, 'install-vps.sh'), '--render-only', out], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const pc = serviceKeys(readFileSync(path.resolve(HERE, '../../deploy/bona-api.service'), 'utf8'));
  const vps = serviceKeys(readFileSync(path.join(out, 'bona-api.service'), 'utf8'));
  const differsByDesign = new Set(['Environment', 'WorkingDirectory', 'ExecStart', 'ReadWritePaths']);
  assert.ok(pc.has('ProtectSystem') && pc.has('SystemCallFilter'), 'PC unit parsed');
  for (const [k, vals] of pc) {
    if (k === 'EnvironmentFile') continue; // the VPS unit must not load env files (see the render test)
    assert.ok(vps.has(k), `VPS unit lacks ${k}=`);
    if (!differsByDesign.has(k)) assert.deepEqual(vps.get(k), vals, `${k}= differs from the PC unit`);
  }
});
