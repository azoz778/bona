// services/api/test/vps-deploy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PHONE_JID_RE } from '../lib/wa.mjs';
import { parseEnvText } from '../lib/env.mjs';

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
  // PC_WA (test-side only): the PC bona-api twin's WhatsApp drop-in (services/README.md, "The PC
  // bona-api twin since the WhatsApp move"); see pcWa() below. Default 'dropin': in place and good.
  // PC_LOCK (test-side only): 'locked' = the twin locked by the cutover runbook's own B5a command;
  // 'unlocked' = the same, then the one-command unlock (rm LOCKED); see lockTwin() below.
  const { SHIM_PRESEED_START, SHIM_STALE_WAL, PC_WA = 'dropin', PC_LOCK, ...rest } = scenario;
  if (SHIM_STALE_WAL) writeFileSync(path.join(home, 'bona-data', 'bona.db-wal'), 'stale');
  if (PC_LOCK) lockTwin(home, PC_LOCK);
  const env = { ...pcWa(home, PC_WA), ...rest };
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
// pcWa(home, kind) → lays out the PC's ~/.secrets as the WhatsApp move left it (bona-services.env
// keeps the owner's personal instance for bona-intake) plus the twin's drop-in in the shape `kind`
// names, and returns the systemctl shim's answer to `show bona-api -p EnvironmentFiles`.
const PC_WA_LINES = 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n';
function pcWa(home, kind) {
  const secrets = path.join(home, '.secrets');
  mkdirSync(secrets, { recursive: true });
  writeFileSync(path.join(secrets, 'bona-services.env'), 'X=1\nBONA_WA_INSTANCE=abdulaziz-personal\n', { mode: 0o600 });
  const shared = `${path.join(secrets, 'bona-services.env')} (ignore_errors=yes)`;
  const marketing = `${path.join(secrets, 'bona-marketing.env')} (ignore_errors=yes)`;
  const wa = path.join(secrets, 'bona-api-pc-wa.env');
  const listed = `${wa} (ignore_errors=no)`;
  const file = {
    dropin: PC_WA_LINES, early: PC_WA_LINES, 'no-file': null, none: null,
    'no-jid': 'BONA_WA_INSTANCE=bona\n', 'blank-jid': 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=\n',
    // Not a phone JID (lib/wa.mjs PHONE_JID_RE): bona-api would run as "invalid", on the owner's number.
    'bad-jid': 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=bona\n',
    'lid-jid': 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=123456789012345@lid\n',
    'device-jid': 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=966576267694:12@s.whatsapp.net\n',
    // systemd reads these JIDs over two lines (an open quote, a trailing backslash); line by line the
    // last BONA_WA_INSTANCE_JID= line looks valid (Codex r1).
    'multiline-jid': 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID="bona\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n"\n',
    'continued-jid': 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=bona\\\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n',
    personal: 'BONA_WA_INSTANCE=abdulaziz-personal\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n',
    'quoted-export': 'export BONA_WA_INSTANCE="bona"\nexport BONA_WA_INSTANCE_JID=\'966576267694@s.whatsapp.net\'\n',
    quoted: 'BONA_WA_INSTANCE="bona"\nBONA_WA_INSTANCE_JID=\'966576267694@s.whatsapp.net\'\n',
    'semicolon-comment': '; example="old\n# another "open\n\nBONA_WA_INSTANCE=bona\r\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\r\n',
    'escaped-quote': 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID="bad\\"\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n"\n',
    'reopened-quote': 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID="bona" "\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n"\n',
    'cr-mid': 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=bona\rBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n',
    // systemd ends a comment at a CR as well as at a LF (env-file.c: NEWLINE is "\n\r"), so what follows the CR
    // is a live assignment for it, while awk and env_value see one comment line (Claude r3 P3-1 on #84, L5).
    'cr-in-comment': 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n; old twin\rBONA_WA_INSTANCE=abdulaziz-personal\n',
    'show-fails': PC_WA_LINES,
  }[kind];
  assert.ok(file !== undefined, `unknown PC_WA kind ${kind}`);
  if (file !== null) writeFileSync(wa, file, { mode: 0o600 });
  const order = kind === 'none' ? [shared, marketing] : kind === 'early' ? [listed, shared, marketing] : [shared, marketing, listed];
  return { SHIM_PC_ENVFILES: order.join('|'), ...(kind === 'show-fails' ? { SHIM_SHOW_FAIL: '1' } : {}) };
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
  pcWaShow: /^systemctl --user show bona-api -p EnvironmentFiles --value$/,
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
  assert.match(probe, /pgrep -u \$\(id -un\) -f "\^\[\^ \]\*\/cloudflared \.\*--config \$HOME\/\.cloudflared\/bona\[\.\]yml \.\*tunnel run 9022fbec-de4f-44b9-805e-8fff285d6263"/);
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
  // The twin's WhatsApp drop-in is checked first, before anything is stopped anywhere.
  assertOrdered(r.lines, CALL.pcWaShow, CALL.vpsStopAll, CALL.vpsVerifyInactive, CALL.pcStart, CALL.publicHealth);
  assert.ok(!r.lines.some((l) => /^scp /.test(l)), `plain rollback copies nothing\n${r.lines.join('\n')}`);
  assert.ok(!r.out.includes('966576267694'), `no env value is printed\n${r.out}`);
  noRemoteUserManager(r);
});

// ---- the PC twin must not come back on the owner's personal WhatsApp (A2Z go-live item 7, 2026-11-19)
// The PC's bona-services.env keeps BONA_WA_INSTANCE=abdulaziz-personal for bona-intake; without the
// drop-in, `enable --now bona-api` would poll and send from the owner's personal number again while
// the site sends every client to Bona's own number, which nothing on the PC would read.
const refusedUntouched = (r, why) => {
  assert.notEqual(r.status, 0, `rollback must refuse: ${why}\n${r.out}`);
  assert.ok(r.lines.some((l) => CALL.pcWaShow.test(l)), `the drop-in must have been looked up\n${r.lines.join('\n')}`);
  assert.ok(!r.lines.some((l) => /^(ssh|scp) /.test(l)), `${why}: nothing may be stopped or copied on the VPS\n${r.lines.join('\n')}`);
  assert.ok(!r.lines.some((l) => /^systemctl --user (stop|enable|disable)/.test(l)), `${why}: no PC unit touched\n${r.lines.join('\n')}`);
  // The refusal says what to do instead: the drop-in, the reload, and the explicit way out.
  for (const s of ['bona-api.service.d/wa-own-number.conf', 'EnvironmentFile=%h/.secrets/bona-api-pc-wa.env', 'BONA_WA_INSTANCE_JID=', 'systemctl --user daemon-reload', '--personal-instance', 'The PC bona-api twin since the WhatsApp move']) {
    assert.ok(r.out.includes(s), `${why}: the refusal should mention ${s}\n${r.out}`);
  }
};

// What the refusal says for the JID cases (lib.sh pc_wa_dropin_ok PC_WA_WHY, printed by pc_wa_preflight).
const REFUSAL_REASON = {
  'bad-jid': 'BONA_WA_INSTANCE_JID to something that is not a phone JID',
  'lid-jid': 'BONA_WA_INSTANCE_JID to something that is not a phone JID',
  'multiline-jid': 'is not a plain KEY=value',
  'continued-jid': 'is not a plain KEY=value',
  'escaped-quote': 'is not a plain KEY=value',
  'reopened-quote': 'is not a plain KEY=value',
  'cr-mid': 'is not a plain KEY=value',
  'cr-in-comment': 'is not a plain KEY=value',
  'quoted-export': 'is not a plain KEY=value',
};

for (const [kind, why] of [
  ['none', 'no drop-in'],
  ['no-file', 'the drop-in names an env file that is not there'],
  ['no-jid', 'the env file has no BONA_WA_INSTANCE_JID'],
  ['blank-jid', 'the env file leaves BONA_WA_INSTANCE_JID empty'],
  ['bad-jid', 'the env file sets BONA_WA_INSTANCE_JID to an instance name, not a phone JID'],
  ['lid-jid', 'the env file sets BONA_WA_INSTANCE_JID to a @lid JID, not a phone JID'],
  ['multiline-jid', 'the env file has a quoted value that runs over two lines'],
  ['continued-jid', 'the env file has a line ending in a backslash'],
  ['escaped-quote', 'the env file has an escaped quote that keeps the value open'],
  ['reopened-quote', 'the env file opens a second quote after the value'],
  ['cr-mid', 'the env file has a bare carriage return inside a line'],
  ['cr-in-comment', 'the env file has a bare carriage return inside a comment line'],
  ['quoted-export', 'the env file uses export, which systemd does not read'],
  ['personal', "the env file names the owner's personal instance"],
  ['early', 'the env file is loaded before bona-services.env, so it does not win'],
  ['show-fails', 'systemctl --user show failed'],
]) {
  test(`rollback.sh: PC twin WhatsApp guard refuses before anything is stopped (${why})`, () => {
    const r = runShimmed('rollback.sh', [], { PC_WA: kind });
    refusedUntouched(r, why);
    if (REFUSAL_REASON[kind]) assert.ok(r.out.includes(REFUSAL_REASON[kind]), `${why}: the refusal should say ${REFUSAL_REASON[kind]}\n${r.out}`);
  });
}

test('rollback.sh --copy-back: no drop-in — refused before the VPS is stopped or the PC API touched', () => {
  const r = runShimmed('rollback.sh', ['--copy-back'], { PC_WA: 'none' });
  refusedUntouched(r, 'no drop-in, --copy-back');
  assert.ok(!r.lines.some((l) => /^systemctl --user is-active/.test(l)), r.lines.join('\n'));
});

test('rollback.sh: the drop-in env file may quote whole values, use # and ; comments, blank lines and CRLF (as systemd reads it)', () => {
  for (const kind of ['quoted', 'semicolon-comment']) {
    const r = runShimmed('rollback.sh', [], { PC_WA: kind });
    assert.equal(r.status, 0, `${kind}: ${r.out}`);
    assertOrdered(r.lines, CALL.pcWaShow, CALL.vpsStopAll, CALL.pcStart);
  }
});

test('lib.sh checks BONA_WA_INSTANCE_JID with the same pattern as PHONE_JID_RE in lib/wa.mjs (no drift)', () => {
  const lib = readFileSync(path.join(VPS, 'lib.sh'), 'utf8');
  const m = /if \[\[ \$jid == \*\$'\\n'\* \]\] \|\| ! printf '%s' "\$jid" \| LC_ALL=C grep -Eqx '([^']+)'; then/.exec(lib);
  assert.ok(m, 'the JID check in pc_wa_dropin_ok (newline guard + grep)');
  const values = ['966576267694', '966576267694@s.whatsapp.net', '966576267694:12@s.whatsapp.net', '12345678', '123456789012345',
    '1234567', '1234567890123456', 'bona', 'bona2', '', ' 966576267694', '966576267694 ', '966576267694@lid', '123@g.us',
    '966576267694@s.whatsapp.netX', '966576267694:@s.whatsapp.net', '+966576267694', '٩٦٦٥٧٦٢٦٧٦٩٤', '966576267694\n966576267694'];
  for (const v of values) {
    const shell = spawnSync('bash', ['-c', `[[ $1 == *$'\\n'* ]] && exit 1; printf '%s' "$1" | LC_ALL=C grep -Eqx '${m[1]}'`, '_', v]).status === 0;
    assert.equal(shell, PHONE_JID_RE.test(v), `lib.sh and PHONE_JID_RE disagree on ${JSON.stringify(v)}`);
  }
});

test('rollback.sh: a phone JID with a device suffix passes the twin check (as PHONE_JID_RE accepts it)', () => {
  const r = runShimmed('rollback.sh', [], { PC_WA: 'device-jid' });
  assert.equal(r.status, 0, r.out);
  assertOrdered(r.lines, CALL.pcWaShow, CALL.vpsStopAll, CALL.pcStart);
});

test('rollback.sh --personal-instance: no drop-in needed, a loud warning, then the usual fail-closed order', () => {
  for (const args of [['--personal-instance'], ['--copy-back', '--personal-instance'], ['--personal-instance', '--copy-back']]) {
    const r = runShimmed('rollback.sh', args, { PC_WA: 'none', SHIM_REMOTE_MISSING: 'bona.db-wal bona.db-shm' });
    assert.equal(r.status, 0, `${args}: ${r.out}`);
    // Looked up all the same, first: the route it asks for must be the one the unit will take.
    assertOrdered(r.lines, CALL.pcWaShow, CALL.vpsStopAll, CALL.vpsVerifyInactive, CALL.pcStart, CALL.publicHealth);
    assert.match(r.out, /personal WhatsApp/);
    assert.match(r.out, /item 7/);
    if (args.includes('--copy-back')) assert.ok(r.lines.some((l) => CALL.scpBack('bona.db').test(l)), `${args}: --copy-back still copies`);
  }
});

// Codex review r1: after R1 + R2 the site and the VPS are back on the owner's number, but a drop-in
// still in place would start the twin on Bona's instance — reading and sending from a number the
// site no longer gives out. So --personal-instance needs the drop-in gone, checked before anything
// is stopped anywhere.
for (const [kind, why] of [
  ['dropin', 'the Bona drop-in is still active'],
  ['quoted-export', 'the Bona drop-in is still active (export and quotes)'],
  ['personal', 'a drop-in env file is still loaded, whatever it names'],
  ['show-fails', 'systemctl --user show failed, so the route cannot be checked'],
]) {
  test(`rollback.sh --personal-instance: refused before anything is stopped (${why})`, () => {
    for (const args of [['--personal-instance'], ['--copy-back', '--personal-instance']]) {
      const r = runShimmed('rollback.sh', args, { PC_WA: kind });
      assert.notEqual(r.status, 0, `${args}: must refuse: ${why}\n${r.out}`);
      assert.ok(r.lines.some((l) => CALL.pcWaShow.test(l)), `${args}: the route must have been looked up\n${r.lines.join('\n')}`);
      assert.ok(!r.lines.some((l) => /^(ssh|scp) /.test(l)), `${args}: nothing may be stopped or copied on the VPS\n${r.lines.join('\n')}`);
      assert.ok(!r.lines.some((l) => /^systemctl --user (stop|enable|disable|is-active)/.test(l)), `${args}: no PC unit touched\n${r.lines.join('\n')}`);
      assert.match(r.out, /Nothing was stopped, copied or started/);
      if (kind !== 'show-fails') {
        for (const s of ['bona-api.service.d/wa-own-number.conf', 'systemctl --user daemon-reload', '--personal-instance']) {
          assert.ok(r.out.includes(s), `${args}: the refusal should mention ${s}\n${r.out}`);
        }
      }
      assert.ok(!r.out.includes('966576267694'), `${args}: no env value is printed\n${r.out}`);
    }
  });
}

// ---- the PC twin is LOCKED at the switch (owner decision 2026-11-19, "Lock the PC backup")
// The lock is made exactly as the cutover runbook makes it: its B5a command, read from the plan's
// Appendix B (a verbatim copy of the runbook) and run in the fake HOME. systemd's side of it (the
// drop-in's AssertPathExists refuses a reboot or a manual start) cannot run here; what can: the
// drop-in names the very file the command creates, and install.sh and rollback.sh refuse before
// they write, stop or start anything, saying why. After the one-command unlock (rm LOCKED) they make
// exactly the calls they make on a PC that was never locked.
const REPO_ROOT = path.resolve(HERE, '../../..');
const PLAN = path.join(REPO_ROOT, 'docs/superpowers/plans/2026-11-19-wa-own-number.md');
// The VPS runs this suite from its sparse checkout (install-vps.sh: services + src/data), which has
// no docs/ at all: there the five lock tests are skipped. Anywhere else (the PC, a worktree, and CI,
// which runs this whole api suite since PR-INFRA) they run, and a missing docs/ or plan fails in
// lockCommand(), so a moved or renamed plan, or a deleted docs/, cannot turn them off.
const SPARSE = existsSync(path.join(REPO_ROOT, '.git', 'info', 'sparse-checkout'));
const NO_DOCS = SPARSE && !existsSync(path.join(REPO_ROOT, 'docs'))
  ? 'docs/ is not in this sparse checkout (the VPS: services + src/data); the lock command is read from the plan'
  : false;
const LOCK_REL = '.config/systemd/user/bona-api.service.d/LOCKED';
function lockCommand() {
  const plan = readFileSync(PLAN, 'utf8');
  const appendixB = plan.slice(plan.indexOf('## Appendix B: Cutover runbook'));
  const cmds = appendixB.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('d=~/.config/systemd/user/bona-api.service.d;'));
  assert.equal(cmds.length, 1, 'runbook B5a has exactly one lock command');
  return cmds[0];
}
// lockTwin(home, 'locked' | 'unlocked') → the runbook's lock command in that HOME (systemctl is the
// shim, logged apart from the script's calls); 'unlocked' then runs the unlock, rm LOCKED.
function lockTwin(home, kind) {
  const r = spawnSync('bash', ['-c', lockCommand()], { encoding: 'utf8', env: { PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: path.join(home, 'lock.log') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(path.join(home, LOCK_REL)), 'the lock command creates LOCKED');
  if (kind === 'unlocked') rmSync(path.join(home, LOCK_REL));
  else assert.equal(kind, 'locked');
}
const runInstall = (args, scenario = {}) => runShimmed('../install.sh', args, { BONA_REPO_DIR: REPO_ROOT, TMPDIR: tmpdir(), ...scenario });
const lockedUntouched = (r, why) => {
  assert.notEqual(r.status, 0, `must refuse: ${why}\n${r.out}`);
  assert.deepEqual(r.lines, [], `${why}: not one call (no systemctl, ssh, scp, node, cloudflared, curl)\n${r.lines.join('\n')}`);
  for (const f of ['.config/systemd/user/bona-api.service', '.config/systemd/user/cloudflared-bona.service', '.cloudflared/bona.yml', '.secrets/bona-marketing.env']) {
    assert.ok(!existsSync(path.join(r.home, f)), `${why}: ${f} must not be written`);
  }
  // It says why, what the fall-back is, and how to unlock.
  for (const s of [`The PC bona-api twin is LOCKED (${path.join(r.home, LOCK_REL)})`, 'sudo systemctl restart bona-api', 'cutover runbook R1', `rm ${path.join(r.home, LOCK_REL)}`, 'Nothing was written, stopped, copied or started']) {
    assert.ok(r.out.includes(s), `${why}: the refusal should say ${s}\n${r.out}`);
  }
};

test('the runbook B5a lock: a drop-in whose AssertPathExists names the LOCKED file it creates, then daemon-reload', { skip: NO_DOCS }, () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  lockTwin(home, 'locked');
  const dropin = readFileSync(path.join(home, '.config/systemd/user/bona-api.service.d/locked.conf'), 'utf8');
  assert.match(dropin, /^\[Unit\]$/m);
  // %h is the home of the user manager's user: the same file the scripts check under $HOME.
  assert.deepEqual(dropin.split('\n').filter((l) => /^Assert|^Condition/.test(l)), [`AssertPathExists=!%h/${LOCK_REL}`]);
  assert.match(readFileSync(path.join(home, LOCK_REL), 'utf8'), /Unlock only with the owner: rm this file/);
  assert.deepEqual(readFileSync(path.join(home, 'lock.log'), 'utf8').split('\n').filter(Boolean), ['systemctl --user daemon-reload']);
});

test('install.sh: locked — refused before it writes or starts anything (with and without --restart), saying why', { skip: NO_DOCS }, () => {
  for (const args of [[], ['--restart'], ['--no-dns'], ['--restart', '--no-dns']]) {
    lockedUntouched(runInstall(args, { PC_LOCK: 'locked' }), `install.sh ${args.join(' ') || '(no flags)'}`);
  }
});

test('install.sh --uninstall still runs while locked: stopping the units is always allowed', { skip: NO_DOCS }, () => {
  const r = runInstall(['--uninstall'], { PC_LOCK: 'locked' });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.lines.some((l) => /^systemctl --user disable --now bona-api\.service$/.test(l)), r.lines.join('\n'));
  assert.ok(!r.lines.some((l) => /^systemctl --user (start|restart|enable )/.test(l)), r.lines.join('\n'));
});

test('rollback.sh: locked — refused before anything is stopped, copied or started (every flag), saying why', { skip: NO_DOCS }, () => {
  for (const args of [[], ['--copy-back'], ['--personal-instance'], ['--copy-back', '--personal-instance']]) {
    lockedUntouched(runShimmed('rollback.sh', args, { PC_LOCK: 'locked' }), `rollback.sh ${args.join(' ') || '(no flags)'}`);
    lockedUntouched(runShimmed('rollback.sh', args, { PC_LOCK: 'locked', PC_WA: 'none' }), `rollback.sh ${args.join(' ') || '(no flags)'}, no WhatsApp drop-in`);
  }
});

test('unlocked (rm LOCKED): install.sh and rollback.sh make exactly the calls of a PC that was never locked', { skip: NO_DOCS }, () => {
  for (const args of [[], ['--restart']]) {
    const never = runInstall(args);
    const unlocked = runInstall(args, { PC_LOCK: 'unlocked' });
    assert.ok(never.lines.some((l) => /^node /.test(l)), `past the lock the install goes on to its own checks\n${never.lines.join('\n')}`);
    assert.deepEqual(unlocked.lines, never.lines, `install.sh ${args.join(' ')}`);
    assert.equal(unlocked.status, never.status);
  }
  for (const [args, scenario] of [[[], {}], [['--personal-instance'], { PC_WA: 'none' }], [[], { PC_WA: 'none' }]]) {
    const never = runShimmed('rollback.sh', args, scenario);
    const unlocked = runShimmed('rollback.sh', args, { ...scenario, PC_LOCK: 'unlocked' });
    assert.deepEqual(unlocked.lines, never.lines, `rollback.sh ${args.join(' ')} ${JSON.stringify(scenario)}`);
    assert.equal(unlocked.status, never.status, unlocked.out);
  }
  // and the plain one is the usual successful fail-closed rollback
  const r = runShimmed('rollback.sh', [], { PC_LOCK: 'unlocked' });
  assert.equal(r.status, 0, r.out);
  assertOrdered(r.lines, CALL.pcWaShow, CALL.vpsStopAll, CALL.vpsVerifyInactive, CALL.pcStart, CALL.publicHealth);
});

test('rollback.sh: an unknown argument is a usage error and touches nothing', () => {
  const r = runShimmed('rollback.sh', ['--personal']);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /usage: rollback\.sh \[--copy-back\] \[--personal-instance\]/);
  assert.ok(!r.lines.some((l) => /^(ssh|scp|systemctl) /.test(l)), r.lines.join('\n'));
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
  // The port is held by THIS test's own socket while the script runs: bind for real (a moment's
  // EADDRINUSE is waited out, any other error fails at once) rather than taking every listen
  // error as "someone else is listening", and prove with `ss` that it shows before asking.
  let server = null;
  let lastError = null;
  for (let attempt = 0; attempt < 50 && !server; attempt += 1) {
    const candidate = net.createServer();
    lastError = await new Promise((resolve) => { candidate.once('error', resolve); candidate.listen(4121, '127.0.0.1', () => resolve(null)); });
    if (!lastError) server = candidate;
    else if (lastError.code === 'EADDRINUSE') await new Promise((r) => setTimeout(r, 100));
    else break;
  }
  assert.ok(server, `could not hold 127.0.0.1:4121 for the test: ${lastError?.code ?? lastError}`);
  try {
    const listening = spawnSync('ss', ['-ltn'], { encoding: 'utf8', timeout: 10_000 }).stdout ?? '';
    assert.match(listening, /:4121 /, 'ss must show the test\'s own listener before the script checks the port');
    const r = bash([path.join(VPS, 'install-vps.sh'), '--smoke'], { env });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /4121.*listening/);
  } finally {
    server.close();
  }
  // and when it does start, the API is exec'd (so the pid we kill is node, not a subshell)
  assert.match(readFileSync(path.join(VPS, 'install-vps.sh'), 'utf8'), /exec "\$NODE_BIN\/node" api\/index\.mjs \) &$/m);
});

test('install-vps.sh --smoke still sees a busy port when ss has much more to say after it (pipefail + an early-exit grep)', () => {
  // The deploy's full test run failed the test above twice: with many sockets open, `ss` was
  // still writing when `grep -q` stopped at the match, so `ss` died of SIGPIPE, `pipefail`
  // failed the pipeline, and the guard read "port free". A stand-in `ss` that prints the busy
  // port first and a megabyte after it makes that deterministic.
  const { env } = fakeVpsHome();
  const bin = mkdtempSync(path.join(tmpdir(), 'bona-ss-'));
  writeFileSync(path.join(bin, 'ss'), [
    '#!/usr/bin/env bash',
    'echo "LISTEN 0 511 127.0.0.1:4121 0.0.0.0:*"',
    'for i in $(seq 1 20000); do echo "LISTEN 0 511 127.0.0.1:$((20000 + i % 20000)) 0.0.0.0:* padding-padding-padding"; done',
  ].join('\n'));
  chmodSync(path.join(bin, 'ss'), 0o755);
  const r = bash([path.join(VPS, 'install-vps.sh'), '--smoke'], { env: { ...env, PATH: `${bin}:${env.PATH}` } });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /4121.*listening/);
  assert.doesNotMatch(r.stdout, /smoke passed/);
});

test('sync-secrets.sh chmods the four named secret files on the VPS, not *.env', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  mkdirSync(path.join(home, '.secrets'), { recursive: true });
  mkdirSync(path.join(home, '.cloudflared'), { recursive: true });
  for (const f of ['retell.env', 'evolution-api.env', 'bona-services.env', 'bona-marketing.env']) writeFileSync(path.join(home, '.secrets', f), 'X=1\n');
  writeFileSync(path.join(home, '.cloudflared', '9022fbec-de4f-44b9-805e-8fff285d6263.json'), '{}');
  const log = path.join(home, 'shim.log');
  writeFileSync(log, '');
  // a VPS whose ~/.secrets is still empty (a fresh one): it says so in its answers, so the copy goes ahead
  const r = bash([path.join(VPS, 'sync-secrets.sh')], { env: { PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_SSH: 'fake-vps', SHIM_VPS_HOME: fakeVpsSecrets({}) } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const chmod = lines.find((l) => /^ssh fake-vps chmod 600 /.test(l));
  assert.ok(chmod, `expected a remote chmod\n${lines.join('\n')}`);
  for (const f of ['retell.env', 'evolution-api.env', 'bona-services.env', 'bona-marketing.env']) assert.ok(chmod.includes(`~/.secrets/${f}`), `${f} in: ${chmod}`);
  assert.ok(chmod.includes('~/.cloudflared/9022fbec-de4f-44b9-805e-8fff285d6263.json'), chmod);
  assert.ok(!chmod.includes('*.env'), `must not chmod a glob: ${chmod}`);
  assert.ok(lines.some((l) => /^scp -q -p .*\/\.secrets\/retell\.env .* fake-vps:\.secrets\/$/.test(l)), lines.join('\n'));
});

// ---------------------------------------------------------------- sync-secrets keeps the VPS's WhatsApp lines (2026-11-19)
const keepRun = (pc, vps) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bona-keep-'));
  writeFileSync(path.join(dir, 'pc'), pc);
  writeFileSync(path.join(dir, 'vps'), vps);
  const r = bash(['-c', '. ./lib.sh; keep_vps_keys "$1" "$2" "$3" "$(vps_keep_keys bona-services.env)"', 'keep', path.join(dir, 'pc'), path.join(dir, 'vps'), path.join(dir, 'out')], { env: { HOME: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '', 'prints nothing');
  return readFileSync(path.join(dir, 'out'), 'utf8');
};

test('keep_vps_keys: the VPS line wins in place, other PC lines keep their order, a key only the VPS has is appended', () => {
  const pc = 'A=1\nBONA_WA_INSTANCE=abdulaziz-personal\nBONA_OWNER_JID=owner\n# BONA_WA_INSTANCE=commented\nZ=9\n';
  const vps = 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n';
  assert.equal(keepRun(pc, vps), 'A=1\nBONA_WA_INSTANCE=bona\nBONA_OWNER_JID=owner\n# BONA_WA_INSTANCE=commented\nZ=9\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n');
});

test('keep_vps_keys: nothing on the VPS means the PC file as it is; a key the VPS lacks keeps the PC line; export is understood', () => {
  const pc = 'A=1\nexport BONA_WA_INSTANCE=abdulaziz-personal\n';
  assert.equal(keepRun(pc, ''), pc);
  assert.equal(keepRun(pc, 'BONA_WA_INSTANCE_JID=x@s.whatsapp.net\n'), `${pc}BONA_WA_INSTANCE_JID=x@s.whatsapp.net\n`);
  assert.equal(keepRun(pc, 'export BONA_WA_INSTANCE=bona\n'), 'A=1\nexport BONA_WA_INSTANCE=bona\n');
});

test('vps_keep_grep: the VPS lines are found with or without spaces before the =, and nothing else is', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-keepgrep-'));
  mkdirSync(path.join(home, '.secrets'));
  writeFileSync(path.join(home, '.secrets', 'bona-services.env'),
    'A=1\nBONA_WA_INSTANCE = bona\nexport BONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\nBONA_WA_INSTANCE_X=no\n# BONA_WA_INSTANCE=commented\n');
  const r = bash(['-c', '. ./lib.sh; eval "$(vps_keep_grep bona-services.env)"'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'BONA_WA_INSTANCE = bona\nexport BONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n= bona-services.env 2\n= end\n');
});

test('keep_vps_keys: a key the PC writes twice comes out once, as the VPS line; other keys are never touched', () => {
  const pc = 'BONA_WA_INSTANCE=abdulaziz-personal\nBONA_WA_INSTANCE_X=keep\nBONA_WA_INSTANCE=again\n';
  assert.equal(keepRun(pc, 'BONA_WA_INSTANCE=bona\nOTHER=vps-only\n'), 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_X=keep\n');
});

function syncHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  mkdirSync(path.join(home, '.secrets'), { recursive: true });
  mkdirSync(path.join(home, '.cloudflared'), { recursive: true });
  for (const f of ['retell.env', 'evolution-api.env', 'bona-marketing.env']) writeFileSync(path.join(home, '.secrets', f), 'X=1\n');
  writeFileSync(path.join(home, '.secrets', 'bona-services.env'), 'X=1\nBONA_WA_INSTANCE=abdulaziz-personal\n');
  writeFileSync(path.join(home, '.cloudflared', '9022fbec-de4f-44b9-805e-8fff285d6263.json'), '{}');
  const log = path.join(home, 'shim.log');
  writeFileSync(log, '');
  const capture = path.join(home, 'captured');
  mkdirSync(capture);
  return { home, log, capture };
}

test('sync-secrets.sh copies bona-services.env with the VPS\'s own WhatsApp lines, reads them before any copy, prints no value, leaves no temp file', () => {
  const { home, log, capture } = syncHome();
  // the VPS's bona-services.env, read for real by the ssh shim (SHIM_VPS_HOME): both reads see the same file
  const vps = fakeVpsSecrets({ 'bona-services.env': 'X=vps\nBONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n' });
  const r = bash([path.join(VPS, 'sync-secrets.sh')], { env: {
    PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_SSH: 'fake-vps', SHIM_SCP_CAPTURE: capture,
    SHIM_VPS_HOME: vps,
  } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(path.join(capture, 'bona-services.env'), 'utf8'), 'X=1\nBONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n');
  assert.equal(readFileSync(path.join(capture, 'retell.env'), 'utf8'), 'X=1\n', 'the other files go verbatim');
  assert.equal(readFileSync(path.join(home, '.secrets', 'bona-services.env'), 'utf8'), 'X=1\nBONA_WA_INSTANCE=abdulaziz-personal\n', 'the PC file is left as it was');
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const readAt = lines.findIndex((l) => /^ssh fake-vps f=~\/\.secrets\/bona-services\.env; .*BONA_WA_INSTANCE BONA_WA_INSTANCE_JID/.test(l));
  const firstScp = lines.findIndex((l) => /^scp /.test(l));
  assert.ok(readAt >= 0 && readAt < firstScp, lines.join('\n'));
  assert.doesNotMatch(r.stdout + r.stderr, /abdulaziz-personal|576267694|=bona/);
  assert.deepEqual(readdirSync(path.join(home, '.secrets')).filter((f) => f.startsWith('.')), [], 'no temp file left behind');
});

test('sync-secrets.sh copies nothing when the VPS lines cannot be read', () => {
  const { home, log } = syncHome();
  const r = bash([path.join(VPS, 'sync-secrets.sh')], { env: {
    PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_SSH: 'fake-vps', SHIM_VPS_KEEP_FAIL: '1',
  } });
  assert.notEqual(r.status, 0);
  assert.ok(!readFileSync(log, 'utf8').split('\n').some((l) => /^scp /.test(l)), 'no scp after a failed read');
  assert.deepEqual(readdirSync(path.join(home, '.secrets')).filter((f) => f.startsWith('.')), []);
});

test('sync-secrets.sh --dry-run names the kept keys and contacts nothing', () => {
  const { home, log } = syncHome();
  const r = bash([path.join(VPS, 'sync-secrets.sh'), '--dry-run'], { env: { PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_SSH: 'fake-vps' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BONA_WA_INSTANCE BONA_WA_INSTANCE_JID/);
  assert.equal(readFileSync(log, 'utf8'), '');
});

// ---------------------------------------------------------------- kept keys per file + the missing-key guard (PR-INFRA, 2026-11-27)
// T00 step 6 (names only): the VPS copies hold keys the PC copies lack, bona-services.env the dashboard push pair
// (BONA_VAPID_PUBLIC / BONA_VAPID_PRIVATE) and bona-marketing.env the three TikTok keys, and BONA_WA_POLL_MS differs
// between the two machines (phase 1 critic C5). A verbatim copy would delete or reset them, so the VPS's own line wins
// for each, per file; and a key the VPS has that the PC lacks (and that is not kept) stops the copy (the guard).
const KEEP = {
  'retell.env': [],
  'evolution-api.env': [],
  'bona-services.env': ['BONA_WA_INSTANCE', 'BONA_WA_INSTANCE_JID', 'BONA_WA_POLL_MS', 'BONA_VAPID_PUBLIC', 'BONA_VAPID_PRIVATE'],
  'bona-marketing.env': ['TIKTOK_PIXEL_ID', 'TIKTOK_EVENTS_ACCESS_TOKEN', 'TIKTOK_TEST_EVENT_CODE'],
};
// fakeVpsSecrets({ file: text }) → a temp HOME whose ~/.secrets holds those files: the ssh shim runs sync-secrets'
// two remote reads (the key names, the kept lines) for real against it when SHIM_VPS_HOME points there.
function fakeVpsSecrets(files) {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-fake-vps-'));
  mkdirSync(path.join(home, '.secrets'));
  for (const [f, text] of Object.entries(files)) writeFileSync(path.join(home, '.secrets', f), text, { mode: 0o600 });
  return home;
}
const syncRun = (args, { home, log }, extra = {}) => bash([path.join(VPS, 'sync-secrets.sh'), ...args], { env: {
  PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_SSH: 'fake-vps', ...extra,
} });
const shimLines = (log) => readFileSync(log, 'utf8').split('\n').filter(Boolean);
// The two remote reads as the ssh shim logs them: one file's kept lines, and the key names of every file.
const KEEP_READ = (file, key) => new RegExp(`^ssh fake-vps f=~/\\.secrets/${file.replace(/\./g, '\\.')}; .*${key}`);
const NAMES_READ = /^ssh fake-vps cd ~\/\.secrets/;
const noTempLeft = (home) => assert.deepEqual(readdirSync(path.join(home, '.secrets')).filter((f) => f.startsWith('.')), [], 'no temp file left behind');
// The guard's list: one "  FILE KEY" line per key a copy would delete on the VPS.
const lostList = (out) => (stripAnsi(out).match(/^ {2}\S+\.env [A-Za-z_][A-Za-z0-9_]*$/gm) || []).map((l) => l.trim()).sort();

test('lib.sh keeps the VPS lines per file: the exact VAPID, WA poll and TikTok names (T00 step 6)', () => {
  const r = bash(['-c', '. ./lib.sh; printf "files=%s\\n" "$VPS_KEEP_FILES"; for f in $SECRET_FILES; do printf "%s=%s\\n" "$f" "$(vps_keep_keys "$f")"; done'], { env: { HOME: tmpdir() } });
  assert.equal(r.status, 0, r.stderr);
  const got = Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).split(' ').filter(Boolean)]; }));
  assert.deepEqual([...got.files].sort(), ['bona-marketing.env', 'bona-services.env']);
  for (const [f, keys] of Object.entries(KEEP)) assert.deepEqual([...(got[f] ?? [])].sort(), [...keys].sort(), f);
});

test('vps_keep_grep FILE: each file is searched for its own kept keys only; a missing file is a "-" record', () => {
  const home = fakeVpsSecrets({ 'bona-marketing.env': 'META_PIXEL_ID=m\nTIKTOK_PIXEL_ID=p\nexport TIKTOK_EVENTS_ACCESS_TOKEN = t\nTIKTOK_TEST_EVENT_CODE=c\nTIKTOK_OTHER=x\nBONA_WA_INSTANCE=nope\n# TIKTOK_PIXEL_ID=commented\n' });
  const r = bash(['-c', '. ./lib.sh; eval "$(vps_keep_grep bona-marketing.env)"'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'TIKTOK_PIXEL_ID=p\nexport TIKTOK_EVENTS_ACCESS_TOKEN = t\nTIKTOK_TEST_EVENT_CODE=c\n= bona-marketing.env 3\n= end\n');
  const none = bash(['-c', '. ./lib.sh; eval "$(vps_keep_grep bona-services.env)"'], { env: { HOME: home } });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, '= bona-services.env -\n= end\n', 'a missing file says so (a record, then the end marker)');
});

test('vps_key_names_cmd and env_key_names: FILE KEY per key line, never a value; comments and non-keys are skipped', () => {
  const text = 'A=1\n  export B = two\n# C=3\n; D=4\nnot a key\n=x\n1BAD=4\nE=\r\nF="q=1"\n';
  const home = fakeVpsSecrets({ 'retell.env': text, 'bona-marketing.env': 'G=7\n' });
  const r = bash(['-c', '. ./lib.sh; eval "$(vps_key_names_cmd)"'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '= evolution-api.env -\n= bona-services.env -\nretell.env A\nretell.env B\nretell.env E\nretell.env F\nbona-marketing.env G\n= retell.env 4\n= bona-marketing.env 1\n= end\n');
  // the PC side reads the same names out of the same text
  const pc = bash(['-c', '. ./lib.sh; env_key_names "$1"', 'names', path.join(home, '.secrets', 'retell.env')], { env: { HOME: home } });
  assert.equal(pc.status, 0, pc.stderr);
  assert.equal(pc.stdout, 'A\nB\nE\nF\n');
});

test('sync-secrets.sh keeps the VPS lines per file: VAPID, the poll interval, the WhatsApp pair and the TikTok keys survive; no value printed', () => {
  const ctx = syncHome();
  writeFileSync(path.join(ctx.home, '.secrets', 'bona-services.env'), 'X=1\nBONA_WA_INSTANCE=abdulaziz-personal\nBONA_WA_POLL_MS=pc-interval\n');
  writeFileSync(path.join(ctx.home, '.secrets', 'bona-marketing.env'), 'META_PIXEL_ID=pc-meta\n');
  const vps = fakeVpsSecrets({
    'retell.env': 'X=vps-old\n',
    'evolution-api.env': 'X=vps-old\n',
    'bona-services.env': 'X=vps-old\nBONA_WA_INSTANCE=bona2\nBONA_WA_INSTANCE_JID=966500000000@s.whatsapp.net\nBONA_WA_POLL_MS=vps-interval\nBONA_VAPID_PUBLIC=vps-pub\nBONA_VAPID_PRIVATE=vps-priv\n',
    'bona-marketing.env': 'META_PIXEL_ID=vps-meta\nTIKTOK_PIXEL_ID=vps-px\nTIKTOK_EVENTS_ACCESS_TOKEN=vps-tok\nTIKTOK_TEST_EVENT_CODE=vps-code\n',
  });
  const r = syncRun([], ctx, { SHIM_VPS_HOME: vps, SHIM_SCP_CAPTURE: ctx.capture });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const got = (f) => readFileSync(path.join(ctx.capture, f), 'utf8');
  assert.equal(got('bona-services.env'), 'X=1\nBONA_WA_INSTANCE=bona2\nBONA_WA_POLL_MS=vps-interval\nBONA_WA_INSTANCE_JID=966500000000@s.whatsapp.net\nBONA_VAPID_PUBLIC=vps-pub\nBONA_VAPID_PRIVATE=vps-priv\n');
  assert.equal(got('bona-marketing.env'), 'META_PIXEL_ID=pc-meta\nTIKTOK_PIXEL_ID=vps-px\nTIKTOK_EVENTS_ACCESS_TOKEN=vps-tok\nTIKTOK_TEST_EVENT_CODE=vps-code\n');
  assert.equal(got('retell.env'), 'X=1\n', 'a file without kept keys goes verbatim');
  assert.equal(readFileSync(path.join(ctx.home, '.secrets', 'bona-marketing.env'), 'utf8'), 'META_PIXEL_ID=pc-meta\n', 'the PC file is left as it was');
  assert.deepEqual(lostList(r.stdout + r.stderr), [], 'every VPS-only key here is a kept key');
  assert.match(stripAnsi(r.stdout), /VPS lines kept: 5 in bona-services\.env, 3 in bona-marketing\.env/);
  assert.doesNotMatch(r.stdout + r.stderr, /vps-|pc-|966500000000|abdulaziz-personal/, 'no value is printed');
  // both kept-line reads and the key-name read happen before the first copy
  const lines = shimLines(ctx.log);
  const firstScp = lines.findIndex((l) => /^scp /.test(l));
  for (const re of [KEEP_READ('bona-services.env', 'BONA_VAPID_PUBLIC'), KEEP_READ('bona-marketing.env', 'TIKTOK_PIXEL_ID'), NAMES_READ]) {
    const at = lines.findIndex((l) => re.test(l));
    assert.ok(at >= 0 && at < firstScp, `${re} before the first scp\n${lines.join('\n')}`);
  }
  noTempLeft(ctx.home);
});

test('sync-secrets.sh refuses when a VPS copy has a key the PC copy lacks: key names only, nothing copied', () => {
  const ctx = syncHome();
  const vps = fakeVpsSecrets({
    'retell.env': 'X=vps\nRETELL_NEW_AGENT=vps-secret-1\n',
    'bona-services.env': 'X=vps\nBONA_WA_INSTANCE=bona2\nBONA_VAPID_PUBLIC=vps-pub\nexport BONA_NEW_SWITCH = vps-secret-2\n# BONA_COMMENTED=vps-secret-3\n',
    'bona-marketing.env': 'TIKTOK_PIXEL_ID=vps-px\n',
  });
  const r = syncRun([], ctx, { SHIM_VPS_HOME: vps });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout + r.stderr;
  // kept keys (BONA_WA_INSTANCE, BONA_VAPID_PUBLIC, TIKTOK_PIXEL_ID) are not lost; X is on the PC; a comment is no key
  assert.deepEqual(lostList(out), ['bona-services.env BONA_NEW_SWITCH', 'retell.env RETELL_NEW_AGENT']);
  assert.match(out, /--force/);
  assert.match(out, /nothing copied/i);
  assert.doesNotMatch(out, /vps-secret|vps-pub|vps-px|=vps/, 'no value is printed');
  const lines = shimLines(ctx.log);
  assert.ok(lines.some((l) => NAMES_READ.test(l)), `the names were read\n${lines.join('\n')}`);
  assert.ok(!lines.some((l) => /^scp /.test(l)), `nothing copied\n${lines.join('\n')}`);
  assert.ok(!lines.some((l) => /^ssh fake-vps chmod /.test(l)), `nothing chmodded\n${lines.join('\n')}`);
  noTempLeft(ctx.home);
});

test('sync-secrets.sh --force copies anyway: the VPS-only keys are dropped (named, with a warning), the kept keys still kept', () => {
  const ctx = syncHome();
  const vps = fakeVpsSecrets({
    'retell.env': 'X=vps\nRETELL_NEW_AGENT=vps-secret-1\n',
    'bona-services.env': 'X=vps\nBONA_WA_INSTANCE=bona2\nBONA_VAPID_PUBLIC=vps-pub\nBONA_NEW_SWITCH=vps-secret-2\n',
  });
  const r = syncRun(['--force'], ctx, { SHIM_VPS_HOME: vps, SHIM_SCP_CAPTURE: ctx.capture });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout + r.stderr;
  assert.deepEqual(lostList(out), ['bona-services.env BONA_NEW_SWITCH', 'retell.env RETELL_NEW_AGENT']);
  assert.match(out, /--force/);
  assert.doesNotMatch(out, /vps-secret|vps-pub|=vps/, 'no value is printed');
  assert.equal(readFileSync(path.join(ctx.capture, 'retell.env'), 'utf8'), 'X=1\n');
  assert.equal(readFileSync(path.join(ctx.capture, 'bona-services.env'), 'utf8'), 'X=1\nBONA_WA_INSTANCE=bona2\nBONA_VAPID_PUBLIC=vps-pub\n');
  noTempLeft(ctx.home);
});

test('sync-secrets.sh copies nothing when the VPS key names cannot be read', () => {
  const ctx = syncHome();
  const r = syncRun([], ctx, { SHIM_VPS_NAMES_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /key names/);
  assert.ok(!shimLines(ctx.log).some((l) => /^scp /.test(l)), 'no scp after a failed read');
  noTempLeft(ctx.home);
});

test('sync-secrets.sh: an unknown argument is a usage error and contacts nothing', () => {
  const ctx = syncHome();
  const r = syncRun(['--forced'], ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /usage: sync-secrets\.sh \[--dry-run\] \[--force\]/);
  assert.equal(readFileSync(ctx.log, 'utf8'), '');
});

// ---------------------------------------------------------------- the VPS answers are checked before anything is copied (PR-INFRA fix round 1)
// A zero ssh exit is not enough (Codex r1 P1): a banner or a profile script on stdout, or two reads that disagree,
// would let the guard pass and the merge fall back to the PC's values. And the shell must read key lines the way
// lib/env.mjs parseEnvText does (a UTF-8 BOM, `export` + a tab; Codex r1 P1), or a key is erased or overwritten.
const BOM = '﻿';
const refusedNothingCopied = (r, ctx, why) => {
  assert.equal(r.status, 1, `${why}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /nothing copied/i, why);
  const lines = shimLines(ctx.log);
  assert.ok(!lines.some((l) => /^scp /.test(l)), `${why}: nothing copied\n${lines.join('\n')}`);
  assert.ok(!lines.some((l) => /^ssh fake-vps chmod /.test(l)), `${why}: nothing chmodded\n${lines.join('\n')}`);
  noTempLeft(ctx.home);
};

test('sync-secrets.sh: a VPS_KEEP_FILES file without kept keys stops the script; ssh never gets an empty remote command (Claude r1)', () => {
  // `die` inside "$(vps_keep_grep …)" only leaves the subshell; the script must stop itself.
  const ctx = syncHome();
  const dir = mkdtempSync(path.join(tmpdir(), 'bona-vps-copy-'));
  const lib = readFileSync(path.join(VPS, 'lib.sh'), 'utf8');
  const patched = lib.replace(/^VPS_KEEP_FILES="([^"]*)"$/m, 'VPS_KEEP_FILES="$1 retell.env"');
  assert.notEqual(patched, lib, 'the VPS_KEEP_FILES line was found');
  writeFileSync(path.join(dir, 'lib.sh'), patched);
  writeFileSync(path.join(dir, 'sync-secrets.sh'), readFileSync(path.join(VPS, 'sync-secrets.sh')));
  const r = bash([path.join(dir, 'sync-secrets.sh')], { env: { PATH: `${SHIMS}:${process.env.PATH}`, HOME: ctx.home, SHIM_LOG: ctx.log, BONA_VPS_SSH: 'fake-vps' } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /retell\.env has no kept keys/);
  const lines = shimLines(ctx.log);
  assert.ok(!lines.some((l) => /^ssh fake-vps\s*$/.test(l)), `no ssh with an empty remote command\n${lines.join('\n')}`);
  assert.ok(!lines.some((l) => /^scp /.test(l)), `nothing copied\n${lines.join('\n')}`);
  noTempLeft(ctx.home);
});

test('sync-secrets.sh refuses when the key-name read has a line that is not FILE KEY (a banner on stdout); the line is never printed', () => {
  const ctx = syncHome();
  const r = syncRun([], ctx, { SHIM_VPS_HOME: fakeVpsSecrets({ 'bona-services.env': 'X=vps\n' }), SHIM_VPS_BANNER: 'Welcome to fake-vps (banner-text-1)', SHIM_VPS_BANNER_ON: 'names' });
  refusedNothingCopied(r, ctx, 'banner in the names');
  assert.doesNotMatch(r.stdout + r.stderr, /banner-text-1/);
});

test('sync-secrets.sh refuses when a kept-lines read brings a line that sets no kept key of that file (a banner): the PC values are not copied over the VPS ones', () => {
  const ctx = syncHome();
  const r = syncRun([], ctx, { SHIM_VPS_HOME: fakeVpsSecrets({ 'bona-services.env': 'X=vps\nBONA_WA_INSTANCE=bona2\n' }), SHIM_VPS_BANNER: 'Welcome to fake-vps (banner-text-2)', SHIM_VPS_BANNER_ON: 'keep' });
  refusedNothingCopied(r, ctx, 'banner in the kept lines');
  assert.doesNotMatch(r.stdout + r.stderr, /banner-text-2|bona2/);
});

test('sync-secrets.sh refuses when the names list a kept key that the kept-lines read did not bring (the two reads disagree)', () => {
  const ctx = syncHome();
  // a whole names answer that lists BONA_WA_INSTANCE, while the file the kept-lines read sees has no such line
  const r = syncRun([], ctx, {
    SHIM_VPS_KEY_NAMES: '= retell.env -\n= evolution-api.env -\n= bona-marketing.env -\nbona-services.env X\nbona-services.env BONA_WA_INSTANCE\n= bona-services.env 2\n= end',
    SHIM_VPS_HOME: fakeVpsSecrets({ 'bona-services.env': 'X=vps\n' }),
  });
  refusedNothingCopied(r, ctx, 'kept key named, not read');
  assert.match(r.stdout + r.stderr, /disagree/);
});

// PR-INFRA fix round 2 (Codex r2 P1): an answer that exits 0 but is not whole. Each read ends with "= end" and gives every file
// a record ("= FILE N", N its rows, or "= FILE -" when the file is not there), so a lost or cut answer is told apart from a VPS
// that has no such file.
test('sync-secrets.sh refuses answers that exit 0 but bring nothing (all three empty); a fresh VPS says it has no files, and that copies', () => {
  const lost = syncHome();
  refusedNothingCopied(syncRun([], lost), lost, 'empty answers'); // the ssh shim without SHIM_VPS_HOME prints nothing, exit 0
  const fresh = syncHome();
  const r = syncRun([], fresh, { SHIM_VPS_HOME: fakeVpsSecrets({}), SHIM_SCP_CAPTURE: fresh.capture });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(path.join(fresh.capture, 'bona-services.env'), 'utf8'), 'X=1\nBONA_WA_INSTANCE=abdulaziz-personal\n');
});

test('sync-secrets.sh refuses a names answer that left out the rows of one file, its record, or the end, while the kept-lines reads are whole', () => {
  const vpsFiles = { 'retell.env': 'X=vps\nRETELL_NEW_AGENT=vps-secret-1\n', 'bona-services.env': 'X=vps\nBONA_WA_INSTANCE=bona2\n' };
  const whole = '= evolution-api.env -\n= bona-marketing.env -\nretell.env X\nretell.env RETELL_NEW_AGENT\nbona-services.env X\nbona-services.env BONA_WA_INSTANCE\n= retell.env 2\n= bona-services.env 2\n= end';
  // this is what the real read prints for those files, so each case below differs from a real answer only by what it lacks
  const real = bash(['-c', '. ./lib.sh; eval "$(vps_key_names_cmd)"'], { env: { HOME: fakeVpsSecrets(vpsFiles) } });
  assert.equal(real.status, 0, real.stderr);
  assert.equal(real.stdout, `${whole}\n`);
  const noRetell = whole.replace('retell.env X\nretell.env RETELL_NEW_AGENT\n', '');
  for (const [why, names] of [
    ['only the bona-services.env rows (the answer of the old read, without records)', 'bona-services.env X\nbona-services.env BONA_WA_INSTANCE'],
    ['the retell.env rows left out', noRetell],
    ['the retell.env rows and its record left out', noRetell.replace('= retell.env 2\n', '')],
    ['cut before the end marker', whole.replace(/\n= end$/, '')],
    ['cut in the middle', whole.slice(0, whole.indexOf('bona-services.env X'))],
  ]) {
    const ctx = syncHome();
    const r = syncRun([], ctx, { SHIM_VPS_HOME: fakeVpsSecrets(vpsFiles), SHIM_VPS_KEY_NAMES: names });
    refusedNothingCopied(r, ctx, why);
    assert.doesNotMatch(r.stdout + r.stderr, /vps-secret|bona2/, `${why}: no value printed`);
  }
});

// readsCheck(names, { file: keptLines }) → vps_reads_check on a work dir laid out as sync-secrets.sh writes it. A keep file not
// given is the answer for a missing file.
const readsCheck = (names, keep = {}, env = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bona-reads-'));
  writeFileSync(path.join(dir, 'vps-names'), names);
  for (const f of ['bona-services.env', 'bona-marketing.env']) writeFileSync(path.join(dir, `keep.${f}`), keep[f] ?? `= ${f} -\n= end\n`);
  return bash(['-c', 'set -euo pipefail; . ./lib.sh; vps_reads_check "$1"', 'check', dir], { env: { HOME: dir, ...env } });
};
const READS_OK = {
  names: '= evolution-api.env -\nretell.env A\nbona-services.env BONA_WA_INSTANCE\nbona-services.env X\nbona-marketing.env TIKTOK_PIXEL_ID\n= retell.env 1\n= bona-services.env 2\n= bona-marketing.env 1\n= end\n',
  keep: { 'bona-services.env': 'BONA_WA_INSTANCE = bona2\n= bona-services.env 1\n= end\n', 'bona-marketing.env': 'export TIKTOK_PIXEL_ID=px\n= bona-marketing.env 1\n= end\n' },
};

test('vps_reads_check: rows, one record per file and the end marker; kept lines of that file only; both reads agree on the kept keys and on which files are there', () => {
  const { names, keep } = READS_OK;
  const ok = readsCheck(names, keep);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const none = readsCheck('= retell.env -\n= evolution-api.env -\n= bona-services.env -\n= bona-marketing.env -\n= end\n');
  assert.equal(none.status, 0, `a VPS without the files says so: nothing to keep\n${none.stderr}`);
  // bona-marketing.env there, but without a kept key: the kept-lines read says "0", not "-"
  const noKept = readsCheck(names.replace('bona-marketing.env TIKTOK_PIXEL_ID', 'bona-marketing.env META_PIXEL_ID'), { ...keep, 'bona-marketing.env': '= bona-marketing.env 0\n= end\n' });
  assert.equal(noKept.status, 0, noKept.stderr);
  const svc = (text) => ({ ...keep, 'bona-services.env': text });
  const bad = [
    ['everything empty (the answers lost on the way)', '', { 'bona-services.env': '', 'bona-marketing.env': '' }],
    ['the names empty', '', keep],
    ['a banner in the names', `Welcome banner\n${names}`, keep],
    ['a file that is not a secret file', `other.env A\n${names}`, keep],
    ['more than a name', names.replace('retell.env A\n', 'retell.env A=1\n'), keep],
    ['the rows of a file left out', names.replace('retell.env A\n', ''), keep],
    ['the record of a file left out', names.replace('= evolution-api.env -\n', ''), keep],
    ['two records for a file', names.replace('= end\n', '= evolution-api.env -\n= end\n'), keep],
    ['a row after its file\'s record', names.replace('retell.env A\n', '').replace('= retell.env 1\n', '= retell.env 1\nretell.env A\n'), keep],
    ['a count that is not a number', names.replace('= retell.env 1', '= retell.env one'), keep],
    ['no end marker', names.replace('= end\n', ''), keep],
    ['a line after the end marker', `${names}retell.env B\n`, keep],
    ['a banner in the kept lines', names, svc(`Welcome banner\n${keep['bona-services.env']}`)],
    ['a blank line in the kept lines', names, svc(`\n${keep['bona-services.env']}`)],
    ['the kept lines without their end', names, svc('BONA_WA_INSTANCE = bona2\n= bona-services.env 1\n')],
    ['the kept lines without their record', names, svc('BONA_WA_INSTANCE = bona2\n= end\n')],
    ['a kept-lines count that is wrong', names, svc('BONA_WA_INSTANCE = bona2\n= bona-services.env 2\n= end\n')],
    ['the record of the other file', names, svc('BONA_WA_INSTANCE = bona2\n= bona-marketing.env 1\n= end\n')],
    ['the kept lines empty', names, svc('')],
    ['a kept key of the other file', names.replace('bona-marketing.env TIKTOK_PIXEL_ID', 'bona-marketing.env BONA_WA_INSTANCE'), { ...keep, 'bona-marketing.env': 'BONA_WA_INSTANCE=bona2\n= bona-marketing.env 1\n= end\n' }],
    ['a kept key named but not read', names, svc('= bona-services.env 0\n= end\n')],
    ['a kept key read but not named', names.replace('bona-services.env BONA_WA_INSTANCE\n', 'bona-services.env Y\n'), keep],
    ['a kept key read twice, named once', names, svc('BONA_WA_INSTANCE = bona2\nBONA_WA_INSTANCE=bona3\n= bona-services.env 2\n= end\n')],
    ['the names: a file is there; the kept lines: it is not', names.replace('bona-marketing.env TIKTOK_PIXEL_ID', 'bona-marketing.env META_PIXEL_ID'), { ...keep, 'bona-marketing.env': '= bona-marketing.env -\n= end\n' }],
    ['the names: a file is not there; the kept lines: it is', names.replace('bona-marketing.env TIKTOK_PIXEL_ID\n', '').replace('= bona-marketing.env 1', '= bona-marketing.env -'), { ...keep, 'bona-marketing.env': '= bona-marketing.env 0\n= end\n' }],
  ];
  for (const [why, n, k] of bad) {
    const r = readsCheck(n, k);
    assert.equal(r.status, 1, `${why}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /bona2|bona3|banner|A=1|px/, `${why}: no line is printed`);
  }
});

// PR-INFRA fix round 2 (Codex r2 P1): no step of the guard may turn a failing tool into "no keys" or "the answers look fine".
const failingTool = (name) => {
  const bin = mkdtempSync(path.join(tmpdir(), 'bona-failing-'));
  writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return bin;
};

test('sync-secrets.sh still refuses a VPS-only key when `sort` fails on the PC, and when the two reads disagree (no failing step reads as "none")', () => {
  const bin = failingTool('sort');
  const run = (ctx, extra) => bash([path.join(VPS, 'sync-secrets.sh')], { env: {
    PATH: `${bin}:${SHIMS}:${process.env.PATH}`, HOME: ctx.home, SHIM_LOG: ctx.log, BONA_VPS_SSH: 'fake-vps', ...extra,
  } });
  const lost = syncHome();
  const r = run(lost, { SHIM_VPS_HOME: fakeVpsSecrets({ 'retell.env': 'X=vps\nRETELL_NEW_AGENT=vps-secret-1\n' }) });
  refusedNothingCopied(r, lost, 'a VPS-only key, sort failing');
  assert.deepEqual(lostList(r.stdout + r.stderr), ['retell.env RETELL_NEW_AGENT']);
  const split = syncHome();
  const r2 = run(split, {
    SHIM_VPS_KEY_NAMES: '= retell.env -\n= evolution-api.env -\n= bona-marketing.env -\nbona-services.env X\nbona-services.env BONA_WA_INSTANCE\n= bona-services.env 2\n= end',
    SHIM_VPS_HOME: fakeVpsSecrets({ 'bona-services.env': 'X=vps\n' }),
  });
  refusedNothingCopied(r2, split, 'the reads disagree, sort failing');
});

test('vps_only_keys and vps_reads_check: a failing awk is a failure (status 1), never "no keys" or "the answers look fine"', () => {
  const bin = failingTool('awk');
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const home = fakeVpsSecrets({ 'retell.env': 'X=1\n' });
  const names = path.join(home, 'names');
  writeFileSync(names, 'retell.env X\nretell.env RETELL_NEW_AGENT\n= retell.env 2\n= evolution-api.env -\n= bona-services.env -\n= bona-marketing.env -\n= end\n');
  const only = bash(['-c', 'set -euo pipefail; . ./lib.sh; SECRETS_DIR=$HOME/.secrets; vps_only_keys "$1"; echo after', 'only', names], { env: { HOME: home, ...env } });
  assert.notEqual(only.status, 0, only.stdout + only.stderr);
  assert.doesNotMatch(only.stdout, /after/);
  const check = readsCheck(READS_OK.names, READS_OK.keep, env);
  assert.equal(check.status, 1, check.stdout + check.stderr);
});

test('vps_key_names_cmd: no ~/.secrets on the VPS is an error, not an empty answer', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-nosecrets-'));
  const r = bash(['-c', '. ./lib.sh; eval "$(vps_key_names_cmd)"; echo after'], { env: { HOME: home } });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /after/);
});

test('vps_only_keys: a read that fails is passed up (the caller stops), never taken as "no keys"', () => {
  const home = fakeVpsSecrets({});
  const r = bash(['-c', 'set -euo pipefail; . ./lib.sh; vps_only_keys "$1"; echo after', 'only', path.join(home, 'no-such-file')], { env: { HOME: home } });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /after/);
});

test('env_key_names reads the same key names as lib/env.mjs parseEnvText: a BOM, `export` + a tab, odd spacing (no drift)', () => {
  const cases = [
    `${BOM}FIRST=1\nA=2\n`,
    `A=1\n${BOM}MID=2\n`,
    'export\tTABBED=1\nexport  \tSPACED=2\nexport PLAIN=3\n  \t INDENT = 4\nexportGLUED=5\n',
    '# C=1\n; D=2\nKEY.X=3\nKEY X=4\n=5\nexport\n1BAD=6\nE=\r\nF="q=1"\n',
  ];
  const dir = mkdtempSync(path.join(tmpdir(), 'bona-parity-'));
  cases.forEach((text, i) => {
    const file = path.join(dir, `case${i}.env`);
    writeFileSync(file, text);
    const r = bash(['-c', '. ./lib.sh; env_key_names "$1"', 'names', file], { env: { HOME: dir } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([...new Set(r.stdout.split('\n').filter(Boolean))].sort(), Object.keys(parseEnvText(text)).sort(), JSON.stringify(text));
  });
  // the VPS side runs the same expression
  const home = fakeVpsSecrets({ 'retell.env': cases[0] + cases[2] });
  const vps = bash(['-c', '. ./lib.sh; eval "$(vps_key_names_cmd)"'], { env: { HOME: home } });
  assert.equal(vps.status, 0, vps.stderr);
  const rows = vps.stdout.split('\n').filter((l) => l.startsWith('retell.env '));
  assert.deepEqual(rows.map((l) => l.replace(/^retell\.env /, '')).sort(), Object.keys(parseEnvText(cases[0] + cases[2])).sort());
});

test('sync-secrets.sh reads a file that starts with a UTF-8 BOM as the API does: a line-1 VPS-only key stops the copy, a line-1 kept key is kept, a PC line-1 key counts', () => {
  const lost = syncHome();
  const r1 = syncRun([], lost, { SHIM_VPS_HOME: fakeVpsSecrets({ 'retell.env': `${BOM}RETELL_NEW_AGENT=vps-secret-1\nX=vps\n` }) });
  refusedNothingCopied(r1, lost, 'VPS-only key on a BOM line');
  assert.deepEqual(lostList(r1.stdout + r1.stderr), ['retell.env RETELL_NEW_AGENT']);
  const kept = syncHome();
  const r2 = syncRun([], kept, { SHIM_VPS_HOME: fakeVpsSecrets({ 'bona-services.env': `${BOM}BONA_WA_INSTANCE=bona2\nX=vps\n` }), SHIM_SCP_CAPTURE: kept.capture });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(readFileSync(path.join(kept.capture, 'bona-services.env'), 'utf8'), 'X=1\nBONA_WA_INSTANCE=bona2\n', 'the VPS line wins, without its BOM');
  const pc = syncHome();
  writeFileSync(path.join(pc.home, '.secrets', 'retell.env'), `${BOM}RETELL_AGENT=pc\n`);
  const r3 = syncRun([], pc, { SHIM_VPS_HOME: fakeVpsSecrets({ 'retell.env': 'RETELL_AGENT=vps\n' }), SHIM_SCP_CAPTURE: pc.capture });
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  assert.deepEqual(lostList(r3.stdout + r3.stderr), []);
});

test('sync-secrets.sh: a PC line `export<TAB>KEY=…` is no key (the API skips it), so a VPS line for KEY still stops the copy', () => {
  const ctx = syncHome();
  writeFileSync(path.join(ctx.home, '.secrets', 'bona-services.env'), 'X=1\nexport\tBONA_NEW_SWITCH=pc\n');
  const r = syncRun([], ctx, { SHIM_VPS_HOME: fakeVpsSecrets({ 'bona-services.env': 'X=vps\nBONA_NEW_SWITCH=vps-secret-2\n' }) });
  refusedNothingCopied(r, ctx, 'export<TAB> on the PC');
  assert.deepEqual(lostList(r.stdout + r.stderr), ['bona-services.env BONA_NEW_SWITCH']);
});

test('vps_keep_grep and keep_vps_keys read kept lines as the API does: after a BOM yes, after `export<TAB>` no', () => {
  const home = fakeVpsSecrets({ 'bona-services.env': `${BOM}BONA_WA_INSTANCE=bona2\nexport\tBONA_WA_INSTANCE_JID=tabbed\nBONA_WA_POLL_MS=5000\n` });
  const r = bash(['-c', '. ./lib.sh; eval "$(vps_keep_grep bona-services.env)"'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'BONA_WA_INSTANCE=bona2\nBONA_WA_POLL_MS=5000\n= bona-services.env 2\n= end\n', 'the BOM is dropped; the export<TAB> line is no key');
  assert.equal(keepRun(`${BOM}BONA_WA_INSTANCE=abdulaziz-personal\nA=1\nexport\tBONA_WA_POLL_MS=pc\n`, 'BONA_WA_INSTANCE=bona2\nBONA_WA_POLL_MS=5000\n'),
    'BONA_WA_INSTANCE=bona2\nA=1\nexport\tBONA_WA_POLL_MS=pc\nBONA_WA_POLL_MS=5000\n');
});

// PR-INFRA fix round 2 (Claude r2 P3, Codex r2 P1): one parser. parseEnvText trims each line with String.prototype.trim(), so any
// white space JavaScript knows (\v, \f, \r, the no-break space, U+2000-U+200A, U+2028/9, U+3000, the BOM, ...) may stand before a
// name, after `export `, or between the name and its `=`. Every read in the shell (the PC names, both VPS reads, the check of the
// answers and the merge) goes through the one awk function key() in lib.sh, so they cannot disagree with each other, and these
// tests hold that function to the API, for every such character.
const JS_WS = [...Array(0x110000).keys()]
  .filter((c) => (c < 0xd800 || c > 0xdfff) && String.fromCodePoint(c).trim() === '')
  .map((c) => String.fromCodePoint(c))
  .filter((c) => c !== '\n'); // the line break itself
// lines whose first character is no white space for trim(): a zero-width space, NEL, the Mongolian vowel separator, a word joiner
const NOT_WS = ['​', '\u0085', '᠎', '⁠'];
// keyLines(text, key) → how many lines of text set key, each line read on its own by parseEnvText
const keyLines = (text, key) => text.split(/\r?\n/).filter((l) => Object.keys(parseEnvText(l))[0] === key).length;

test('every white space trim() strips, and no other character, is read around a key name by env_key_names, vps_key_names_cmd and vps_keep_grep as parseEnvText reads it', () => {
  assert.equal(JS_WS.length, 24, `the white space of this node: ${JS_WS.map((c) => c.codePointAt(0).toString(16)).join(' ')}`);
  const lines = [];
  JS_WS.forEach((c, i) => lines.push(`${c}LEAD_${i}=v`, `TRAIL_${i}${c}=v`, `export ${c}EXP_${i}=v`, `${c}${c}export ${c}${c}BOTH_${i}${c}${c}= v`));
  NOT_WS.forEach((c, i) => lines.push(`${c}NOT_${i}=v`, `NOT_AFTER_${i}${c}=v`, `export${c}NOT_EXPORT_${i}=v`));
  lines.push('export =1', 'export\t=2', 'export=3', 'exportGLUED=4', 'export NBSP_EXPORT=5', '#C=6', ' #COMMENT=7', 'KEY X=8', 'KEY.X=9');
  const text = `${lines.join('\n')}\n`;
  const want = Object.keys(parseEnvText(text)).sort();
  assert.equal(want.length, 4 * JS_WS.length + 2, `the corpus: four keys per white space, plus export and exportGLUED\n${want.join(' ')}`);
  const home = fakeVpsSecrets({ 'retell.env': text });
  const pc = bash(['-c', '. ./lib.sh; env_key_names "$1"', 'names', path.join(home, '.secrets', 'retell.env')], { env: { HOME: home } });
  assert.equal(pc.status, 0, pc.stderr);
  assert.deepEqual([...new Set(pc.stdout.split('\n').filter(Boolean))].sort(), want, 'env_key_names');
  const vps = bash(['-c', '. ./lib.sh; eval "$(vps_key_names_cmd)"'], { env: { HOME: home } });
  assert.equal(vps.status, 0, vps.stderr);
  const rows = vps.stdout.split('\n').filter((l) => l.startsWith('retell.env ')).map((l) => l.slice('retell.env '.length));
  assert.deepEqual([...new Set(rows)].sort(), want, 'vps_key_names_cmd');
  assert.match(vps.stdout, new RegExp(`^= retell\\.env ${rows.length}$`, 'm'), 'its record counts the rows');
  // the kept-lines read: kept keys written with each white space, among the lines above (none of them a kept key)
  const services = KEEP['bona-services.env'];
  const kept = JS_WS.map((c, i) => `${c}export ${c}${services[i % services.length]}${c}=v${i}`);
  const svc = fakeVpsSecrets({ 'bona-services.env': `${lines.join('\n')}\n${kept.join('\n')}\n` });
  const k = bash(['-c', '. ./lib.sh; eval "$(vps_keep_grep bona-services.env)"'], { env: { HOME: svc } });
  assert.equal(k.status, 0, k.stderr);
  assert.equal(k.stdout, `${kept.map((l) => l.replace(/^﻿/, '')).join('\n')}\n= bona-services.env ${kept.length}\n= end\n`, 'vps_keep_grep: every kept line, a leading BOM dropped');
});

test('keep_vps_keys reads both files with the same key(): for each white space, the PC line of a kept key is replaced in place by the VPS line', () => {
  for (const c of JS_WS) {
    const pc = `A=1\n${c}BONA_WA_POLL_MS${c}=pc\nZ=9\n`;
    const vps = `${c}export ${c}BONA_WA_POLL_MS = vps\n= bona-services.env 1\n= end\n`;
    assert.equal(keepRun(pc, vps), `A=1\n${c}export ${c}BONA_WA_POLL_MS = vps\nZ=9\n`, `U+${c.codePointAt(0).toString(16)}`);
  }
});

test('sync-secrets.sh end to end: kept lines after \\f, \\v, \\r, a no-break space, U+3000 or `export ` + U+2028 are kept (the API reads the VPS values in the copy); a VPS-only key after a no-break space stops the copy', () => {
  const ctx = syncHome();
  writeFileSync(path.join(ctx.home, '.secrets', 'bona-services.env'), 'X=1\n BONA_WA_INSTANCE=abdulaziz-personal\nBONA_WA_POLL_MS=pc-interval\n');
  const vpsText = 'X=vps\n\fBONA_WA_POLL_MS=vps-interval\n\rBONA_WA_INSTANCE=bona2\n\vBONA_WA_INSTANCE_JID=966500000000@s.whatsapp.net\n BONA_VAPID_PUBLIC=vps-pub\n　export  BONA_VAPID_PRIVATE = vps-priv\n';
  const r = syncRun([], ctx, { SHIM_VPS_HOME: fakeVpsSecrets({ 'bona-services.env': vpsText }), SHIM_SCP_CAPTURE: ctx.capture });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = readFileSync(path.join(ctx.capture, 'bona-services.env'), 'utf8');
  const merged = parseEnvText(text);
  const vps = parseEnvText(vpsText);
  for (const key of KEEP['bona-services.env']) {
    assert.equal(merged[key], vps[key], `${key}: the VPS value`);
    assert.equal(keyLines(text, key), 1, `${key}: one line, the PC's replaced in place`);
  }
  assert.deepEqual(Object.keys(merged).sort(), ['X', ...KEEP['bona-services.env']].sort());
  assert.equal(merged.X, '1', 'the other keys: the PC value');
  assert.doesNotMatch(r.stdout + r.stderr, /vps-|pc-|966500000000|abdulaziz-personal/, 'no value is printed');
  const lost = syncHome();
  const r2 = syncRun([], lost, { SHIM_VPS_HOME: fakeVpsSecrets({ 'bona-services.env': 'X=vps\n BONA_NEW_SWITCH=vps-secret-2\n' }) });
  refusedNothingCopied(r2, lost, 'a VPS-only key after a no-break space');
  assert.deepEqual(lostList(r2.stdout + r2.stderr), ['bona-services.env BONA_NEW_SWITCH']);
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

// The deploy's database snapshot (PR-INFRA): the pinned node runs db-snapshot.mjs on ~/bona-data/bona.db after the
// tests and before the restart, keeps the newest 5 deploy snapshots, and deletes every snapshot (any label) older
// than 30 days (Codex r3 P1: the copies must not outlive the live database's deletions for long).
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SNAPSHOT_CALL = (home) => new RegExp(`^node ${reEsc(VPS)}/db-snapshot\\.mjs --db ${reEsc(home)}/bona-data/bona\\.db --out ${reEsc(home)}/bona-data/release-backups --label deploy --keep 5 --max-age-days 30$`);

test('deploy.sh pauses bona-repo-sync.timer (+ its service) around pull/test/snapshot/restart and starts the timer again only if it was active', () => {
  const { home, repo, env, shimLog } = fakeVpsHome();
  const r = bash([path.join(VPS, 'deploy.sh')], { env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assertOrdered(shimLog(),
    TIMER.wasActive,
    TIMER.stopBoth,
    new RegExp(`^git -C ${repo} pull --ff-only --quiet$`),
    /^node --test api\/test\/\*\.test\.mjs$/,
    SNAPSHOT_CALL(home),
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
  assert.ok(!lines.some((l) => /db-snapshot\.mjs/.test(l)), `no snapshot on red tests\n${lines.join('\n')}`);
  assertOrdered(lines, TIMER.wasActive, TIMER.stopBoth, /^node --test/, TIMER.start);

  // the snapshot fails → no restart either (the new code would run migrations on an unsaved database), timer back on
  const nosnap = fakeVpsHome();
  const s = bash([path.join(VPS, 'deploy.sh')], { env: { ...nosnap.env, SHIM_NODE_SNAPSHOT_FAIL: '1' } });
  assert.notEqual(s.status, 0, 'deploy must fail when the snapshot fails');
  assert.match(s.stderr, /snapshot failed.*NOT restarted/);
  const slines = nosnap.shimLog();
  assert.ok(!slines.some((l) => /systemctl restart/.test(l)), `no restart without a snapshot\n${slines.join('\n')}`);
  assertOrdered(slines, TIMER.stopBoth, /^node --test/, SNAPSHOT_CALL(nosnap.home), TIMER.start);

  // timer was NOT active before (the owner paused it, or before the cutover enabled it) → deploy
  // must not switch it on as a side effect
  const paused = fakeVpsHome();
  const p = bash([path.join(VPS, 'deploy.sh')], { env: { ...paused.env, SHIM_LOCAL_INACTIVE: 'bona-repo-sync.timer' } });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  const plines = paused.shimLog();
  assertOrdered(plines, TIMER.wasActive, TIMER.stopBoth, TIMER.restart);
  assert.ok(!plines.some((l) => TIMER.start.test(l)), `an inactive timer must stay inactive\n${plines.join('\n')}`);
});

// ---------------------------------------------------------------- db-snapshot.mjs (PR-INFRA): VACUUM INTO before every restart
// node:sqlite, because the VPS has no sqlite3 CLI. The copy is consistent while bona-api keeps writing (a read
// transaction on the live file, WAL frames included), 0600, integrity-checked, and only then given its final name.
const SNAP = path.join(VPS, 'db-snapshot.mjs');
const snap = (args, env = {}) => spawnSync(process.execPath, [SNAP, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir(), ...env } });
// liveDb(dir) → a bona.db in WAL mode with its writer still open and one row only in the WAL, the way bona-api holds it.
function liveDb(dir = mkdtempSync(path.join(tmpdir(), 'bona-snap-'))) {
  const file = path.join(dir, 'bona.db');
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE leads (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO leads (name) VALUES ('Example One'); PRAGMA user_version = 7;");
  db.exec("INSERT INTO leads (name) VALUES ('Example Two')");
  assert.ok(statSync(`${file}-wal`).size > 0, 'the last row is still in the WAL');
  return { dir, file, db };
}
const SNAP_NAME = (label) => new RegExp(`^bona-${label}-\\d{8}T\\d{6}Z\\.db$`);

test('db-snapshot.mjs: VACUUM INTO a 0600 file under release-backups/, integrity_check ok, WAL rows in, the source untouched', () => {
  const { dir, file, db } = liveDb();
  try {
    const out = path.join(dir, 'release-backups');
    const before = readFileSync(file);
    const r = snap(['--db', file, '--out', out, '--label', 'pre-v8']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const files = readdirSync(out);
    assert.equal(files.length, 1, `one file, no partial left: ${files.join(', ')}`);
    assert.match(files[0], SNAP_NAME('pre-v8'));
    const copyFile = path.join(out, files[0]);
    assert.equal(statSync(copyFile).mode & 0o777, 0o600, 'the snapshot is 0600');
    assert.equal(statSync(out).mode & 0o777, 0o700, 'a new release-backups/ is 0700');
    const copy = new DatabaseSync(copyFile, { readOnly: true });
    try {
      assert.deepEqual(copy.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check), ['ok']);
      assert.equal(copy.prepare('SELECT count(*) AS n FROM leads').get().n, 2, 'the WAL row is in the copy');
      assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 7, 'the schema version is kept');
    } finally { copy.close(); }
    assert.ok(readFileSync(file).equals(before), 'the live file is only read');
    assert.ok(r.stdout.includes(copyFile), `it says where the copy is\n${r.stdout}`);
    assert.match(r.stdout, /integrity ok/);
    assert.match(r.stdout, /user_version 7/);
    assert.doesNotMatch(r.stdout + r.stderr, /Example/, 'no row data is printed');
  } finally { db.close(); }
});

test('db-snapshot.mjs with no --db/--out: ~/bona-data/bona.db into ~/bona-data/release-backups (the manual pre-v8 command)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-snap-home-'));
  mkdirSync(path.join(home, 'bona-data'));
  const { db } = liveDb(path.join(home, 'bona-data'));
  try {
    const r = snap(['--label', 'pre-v8'], { HOME: home });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const files = readdirSync(path.join(home, 'bona-data', 'release-backups'));
    assert.equal(files.length, 1, files.join(', '));
    assert.match(files[0], SNAP_NAME('pre-v8'));
  } finally { db.close(); }
});

test('db-snapshot.mjs --keep 5: only that label is pruned, the newest 5 stay, other files and labels are never touched', () => {
  const { dir, file, db } = liveDb();
  try {
    const out = path.join(dir, 'release-backups');
    mkdirSync(path.join(out, '20261010-property-handoff'), { recursive: true });
    writeFileSync(path.join(out, '20261010-property-handoff', 'bona-before-v7.db'), 'precedent');
    const old = ['20261101T000000Z', '20261102T000000Z', '20261103T000000Z', '20261104T000000Z', '20261105T000000Z', '20261106T000000Z'];
    for (const t of old) writeFileSync(path.join(out, `bona-deploy-${t}.db`), 'x', { mode: 0o600 });
    const others = ['bona-pre-v8-20261001T000000Z.db', 'bona-deploy-latest.db', 'notes.txt', '20261010-property-handoff'];
    for (const f of others.slice(0, 3)) writeFileSync(path.join(out, f), 'x');
    const r = snap(['--db', file, '--out', out, '--label', 'deploy', '--keep', '5']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const left = readdirSync(out).sort();
    assert.equal(left.filter((f) => SNAP_NAME('deploy').test(f)).length, 5, left.join('\n'));
    for (const t of old.slice(2)) assert.ok(left.includes(`bona-deploy-${t}.db`), `${t} kept`);
    for (const t of old.slice(0, 2)) {
      assert.ok(!left.includes(`bona-deploy-${t}.db`), `${t} pruned`);
      assert.match(r.stdout, new RegExp(`pruned bona-deploy-${t}\\.db`));
    }
    for (const f of others) assert.ok(left.includes(f), `${f} left alone`);
    assert.equal(readFileSync(path.join(out, '20261010-property-handoff', 'bona-before-v7.db'), 'utf8'), 'precedent');
  } finally { db.close(); }
});

test('db-snapshot.mjs refuses and leaves no file: no database, not a database, a bad label or keep (usage = 2)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bona-snap-bad-'));
  const out = path.join(dir, 'release-backups');
  const listed = () => (existsSync(out) ? readdirSync(out) : []);
  const missing = snap(['--db', path.join(dir, 'nope.db'), '--out', out]);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /no database/);
  assert.deepEqual(listed(), []);
  writeFileSync(path.join(dir, 'junk.db'), 'this is not an SQLite file. '.repeat(200));
  const junk = snap(['--db', path.join(dir, 'junk.db'), '--out', out, '--label', 'deploy']);
  assert.equal(junk.status, 1, junk.stdout + junk.stderr);
  assert.deepEqual(listed(), [], 'no snapshot and no partial file left');
  for (const args of [['--label', '../x'], ['--label', ''], ['--label', 'Deploy'], ['--keep', '0'], ['--keep', '2x'], ['--bogus'], ['extra']]) {
    const r = snap(['--db', path.join(dir, 'junk.db'), '--out', out, ...args]);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: db-snapshot\.mjs/);
  }
  assert.deepEqual(listed(), []);
  const src = readFileSync(SNAP, 'utf8');
  assert.match(src, /from 'node:sqlite'/);
  assert.doesNotMatch(src, /child_process|spawn|execFile/, 'no sqlite3 CLI or any other program (the VPS has none)');
});

// PR-INFRA fix round 1 (Codex r1): a zero-byte or uninitialised file is no backup; two runs never share a temp file or
// overwrite a published copy; and pruning never deletes the copy just made, whatever the clock says.
test('db-snapshot.mjs refuses a database that is not Bona\'s (zero bytes, user_version 0, no leads table): exit 1, no file left', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bona-snap-empty-'));
  const out = path.join(dir, 'release-backups');
  const listed = () => (existsSync(out) ? readdirSync(out) : []);
  writeFileSync(path.join(dir, 'zero.db'), '');
  const make = (name, sql) => { const db = new DatabaseSync(path.join(dir, name)); db.exec(sql); db.close(); };
  make('v0.db', 'CREATE TABLE leads (id INTEGER PRIMARY KEY)');
  make('noleads.db', 'CREATE TABLE other (id INTEGER PRIMARY KEY); PRAGMA user_version = 7');
  for (const name of ['zero.db', 'v0.db', 'noleads.db']) {
    const r = snap(['--db', path.join(dir, name), '--out', out, '--label', 'deploy']);
    assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /not a Bona database/, name);
    assert.deepEqual(listed(), [], `${name}: no snapshot and no partial file left`);
  }
  assert.equal(statSync(path.join(dir, 'zero.db')).size, 0, 'the source is only read');
});

test('db-snapshot.mjs: its temp file is its own (another run\'s is left alone) and a published snapshot is never overwritten', async () => {
  const { publishNew, snapshotDb } = await import('../../deploy/vps/db-snapshot.mjs');
  const { dir, file, db } = liveDb();
  try {
    const out = path.join(dir, 'release-backups');
    mkdirSync(out, { mode: 0o700 });
    const name = 'bona-deploy-20261127T111500Z.db';
    const theirs = path.join(out, `.${name}.partial`);
    writeFileSync(theirs, 'another run');
    const r = snapshotDb({ db: file, outDir: out, label: 'deploy', now: new Date('2026-11-27T11:15:00.123Z') });
    assert.equal(r.file, path.join(out, name));
    assert.equal(readFileSync(theirs, 'utf8'), 'another run', 'another run\'s temp file is neither removed nor reused');
    assert.deepEqual(readdirSync(out).sort(), [`.${name}.partial`, name].sort(), 'no temp file of its own left');
    const published = readFileSync(r.file);
    assert.throws(() => snapshotDb({ db: file, outDir: out, label: 'deploy', now: new Date('2026-11-27T11:15:00.900Z') }), /already exists/);
    // a name that appeared after that check (another run published first): refused at publish time, nothing overwritten
    const mine = path.join(out, '.mine.partial');
    writeFileSync(mine, 'a later copy');
    assert.throws(() => publishNew(mine, r.file), /already exists/);
    assert.ok(readFileSync(r.file).equals(published), 'the published snapshot is untouched');
  } finally { db.close(); }
});

test('db-snapshot.mjs --keep 5 never prunes the copy it just made, even when older copies carry later times (a clock that went back)', () => {
  const { dir, file, db } = liveDb();
  try {
    const out = path.join(dir, 'release-backups');
    mkdirSync(out, { mode: 0o700 });
    const later = ['20991101T000000Z', '20991102T000000Z', '20991103T000000Z', '20991104T000000Z', '20991105T000000Z'];
    for (const t of later) writeFileSync(path.join(out, `bona-deploy-${t}.db`), 'x', { mode: 0o600 });
    const r = snap(['--db', file, '--out', out, '--label', 'deploy', '--keep', '5']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const left = readdirSync(out).filter((f) => SNAP_NAME('deploy').test(f));
    assert.equal(left.length, 5, left.join('\n'));
    const made = left.filter((f) => !later.some((t) => f.includes(t)));
    assert.equal(made.length, 1, `the new copy is there\n${left.join('\n')}`);
    assert.ok(r.stdout.includes(path.join(out, made[0])), r.stdout);
    for (const t of later.slice(1)) assert.ok(left.includes(`bona-deploy-${t}.db`), `${t} kept`);
    assert.match(r.stdout, new RegExp(`pruned bona-deploy-${later[0]}\\.db`));
  } finally { db.close(); }
});

// PR-INFRA fix round 2 (Codex r2 P2): two runs of one label must not prune each other's copy (with --keep 1 each would delete the
// other's). A run holds its label's lock, release-backups/.bona-<label>.lock with its pid, from before the copy until after the prune;
// another run of that label is refused while the lock's run is alive, before it copies or deletes anything.
test('db-snapshot.mjs: refused while a live run of the same label holds the lock (nothing made, nothing pruned); a lock whose run is gone is taken over; no lock is left', () => {
  const { dir, file, db } = liveDb();
  try {
    const out = path.join(dir, 'release-backups');
    mkdirSync(out, { mode: 0o700 });
    const older = 'bona-deploy-20261101T000000Z.db';
    writeFileSync(path.join(out, older), 'x', { mode: 0o600 });
    const lock = path.join(out, '.bona-deploy.lock');
    writeFileSync(lock, `${process.pid} a-live-run\n`); // this test's own pid: a run that is still going
    const held = snap(['--db', file, '--out', out, '--label', 'deploy', '--keep', '1']);
    assert.equal(held.status, 1, held.stdout + held.stderr);
    assert.match(held.stderr, /another db-snapshot of --label deploy is running/);
    assert.deepEqual(readdirSync(out).sort(), ['.bona-deploy.lock', older], 'nothing made or pruned, the lock left to its run');
    assert.equal(readFileSync(lock, 'utf8'), `${process.pid} a-live-run\n`);
    const other = snap(['--db', file, '--out', out, '--label', 'pre-v8']);
    assert.equal(other.status, 0, `another label is not held up\n${other.stdout}${other.stderr}`);
    const gone = spawnSync(process.execPath, ['-e', '']).pid; // a run that was killed: its pid no longer runs
    writeFileSync(lock, `${gone} a-killed-run\n`);
    const r = snap(['--db', file, '--out', out, '--label', 'deploy', '--keep', '1']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const left = readdirSync(out);
    assert.equal(left.filter((f) => SNAP_NAME('deploy').test(f)).length, 1, left.join('\n'));
    assert.ok(!left.includes(older), `--keep 1 pruned the older copy\n${left.join('\n')}`);
    assert.deepEqual(left.filter((f) => f.startsWith('.')), [], 'the lock is released, no temp file left');
    writeFileSync(path.join(dir, 'zero.db'), '');
    const failed = snap(['--db', path.join(dir, 'zero.db'), '--out', out, '--label', 'deploy']);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.deepEqual(readdirSync(out).filter((f) => f.startsWith('.')), [], 'a failed run releases its lock too');
  } finally { db.close(); }
});

// PR-INFRA fix round 3 (Codex r3 P1): the snapshots are whole copies of bona.db, so a conversation the API deletes stays in
// them; a count alone kept a copy for as long as deploys stopped, and a pre-v8 copy for ever. --max-age-days N deletes every
// snapshot in release-backups (every label) whose UTC time in its name is more than N days before the run's clock, never the
// copy just made, and nothing that is not a snapshot name of this script.
test('db-snapshot.mjs --max-age-days 30 (an injected clock): every label older than 30 days goes, newer ones and other files stay, the new copy stays', async () => {
  const { snapshotDb } = await import('../../deploy/vps/db-snapshot.mjs');
  const { dir, file, db } = liveDb();
  try {
    const out = path.join(dir, 'release-backups');
    mkdirSync(path.join(out, '20261010-property-handoff'), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(out, '20261010-property-handoff', 'bona-before-v7.db'), 'precedent');
    const now = new Date('2026-12-31T12:00:00.000Z');
    const expired = [
      'bona-pre-v8-20261127T100000Z.db', // the manual copy before v8: 34 days
      'bona-deploy-20261201T115959Z.db', // 30 days and a second
      'bona-manual-20251231T120000Z.db', // a year
      'bona-pre-v9-20261001T000000Z.db', // a label with a digit and a hyphen
    ];
    const kept = [
      'bona-deploy-20261201T120000Z.db', // exactly 30 days: not older than 30 days
      'bona-pre-v8-20261230T000000Z.db', // a day
      'bona-deploy-20991101T000000Z.db', // a later time (a clock that went back): not old
      'bona-deploy-20261341T000000Z.db', // no real UTC time in the name: not judged
      'bona-deploy-latest.db', 'bona-Deploy-20261001T000000Z.db', 'bona-deploy-20261001T000000Z.db.bak', 'notes.txt',
      '.bona-deploy-20261001T000000Z.db.123.abc.partial', // another run's temp file
    ];
    for (const f of [...expired, ...kept]) writeFileSync(path.join(out, f), 'x', { mode: 0o600 });
    const r = snapshotDb({ db: file, outDir: out, label: 'deploy', keep: 5, maxAgeDays: 30, now });
    assert.equal(r.file, path.join(out, 'bona-deploy-20261231T120000Z.db'));
    const left = readdirSync(out).sort();
    for (const f of expired) assert.ok(!left.includes(f), `${f} is older than 30 days: deleted\n${left.join('\n')}`);
    assert.deepEqual([...r.expired].sort(), [...expired].sort(), 'it names what it deleted for age');
    assert.deepEqual([...r.pruned].sort(), [...expired].sort(), 'nothing else went (5 deploy copies at most)');
    for (const f of [...kept, 'bona-deploy-20261231T120000Z.db', '20261010-property-handoff']) assert.ok(left.includes(f), `${f} stays\n${left.join('\n')}`);
    assert.equal(readFileSync(path.join(out, '20261010-property-handoff', 'bona-before-v7.db'), 'utf8'), 'precedent', 'a sub-folder is never entered');

    // the count and the age together: --keep 1 leaves the new copy only of this label; the age pass still spares the new copy
    const far = new Date('2099-12-31T00:00:00.000Z'); // every other name is older than 30 days by then
    const r2 = snapshotDb({ db: file, outDir: out, label: 'deploy', keep: 1, maxAgeDays: 30, now: far });
    const left2 = readdirSync(out).sort();
    assert.ok(left2.includes('bona-deploy-20991231T000000Z.db'), `the copy just made stays\n${left2.join('\n')}`);
    assert.deepEqual(left2.filter((f) => /^bona-[a-z0-9-]+-\d{8}T\d{6}Z\.db$/.test(f) && f !== 'bona-deploy-20261341T000000Z.db'), ['bona-deploy-20991231T000000Z.db'], left2.join('\n'));
    assert.ok(r2.pruned.includes('bona-pre-v8-20261230T000000Z.db') && r2.expired.includes('bona-pre-v8-20261230T000000Z.db'), 'another label goes for age');
    assert.equal(new Set(r2.pruned).size, r2.pruned.length, 'a file is deleted (and named) once');
    assert.throws(() => snapshotDb({ db: file, outDir: out, label: 'deploy', maxAgeDays: -1, now: far }), /bad --max-age-days/);
  } finally { db.close(); }
});

test('db-snapshot.mjs --max-age-days on the command line: the real clock, "pruned … (older than N days)" printed; 0 or not a number is a usage error', async () => {
  const { stamp } = await import('../../deploy/vps/db-snapshot.mjs');
  const { dir, file, db } = liveDb();
  try {
    const out = path.join(dir, 'release-backups');
    mkdirSync(out, { mode: 0o700 });
    const day = 24 * 3600 * 1000;
    const old = `bona-pre-v8-${stamp(new Date(Date.now() - 31 * day))}.db`;
    const young = `bona-pre-v8-${stamp(new Date(Date.now() - 29 * day))}.db`;
    for (const f of [old, young]) writeFileSync(path.join(out, f), 'x', { mode: 0o600 });
    const r = snap(['--db', file, '--out', out, '--label', 'deploy', '--keep', '5', '--max-age-days', '30']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const left = readdirSync(out);
    assert.ok(!left.includes(old) && left.includes(young), left.join('\n'));
    assert.match(r.stdout, new RegExp(`ok pruned ${reEsc(old)} \\(older than 30 days\\)`));
    assert.equal(left.filter((f) => SNAP_NAME('deploy').test(f)).length, 1, left.join('\n'));
    for (const v of ['0', '30d', '', '1.5']) {
      const bad = snap(['--db', file, '--out', out, '--max-age-days', v]);
      assert.equal(bad.status, 2, `--max-age-days ${JSON.stringify(v)}: ${bad.stdout}${bad.stderr}`);
      assert.match(bad.stderr, /bad --max-age-days/);
    }
    assert.match(readFileSync(SNAP, 'utf8'), /--max-age-days N/, 'the header says what it does');
  } finally { db.close(); }
});

// Codex r3 P2: two runs that both found the same stale lock must not both take it over (the second rmSync used to delete the
// lock the first had just made). A run sets the stale lock aside under a name of its own (an atomic rename), and only when the
// file it moved is the stale one it read does it go on; when it moved another run's live lock it puts that back and is refused.
test('db-snapshot.mjs takeLock: two runs taking over one stale lock at once — only one holds it, the other is refused, nothing is left', async () => {
  const { takeLock } = await import('../../deploy/vps/db-snapshot.mjs');
  const out = mkdtempSync(path.join(tmpdir(), 'bona-snap-lock-'));
  const lock = path.join(out, '.bona-deploy.lock');
  const gone = spawnSync(process.execPath, ['-e', '']).pid; // a run that was killed
  writeFileSync(lock, `${gone} a-killed-run\n`);
  let releaseA;
  // B has read the stale lock and decided to take it over; before it acts, A takes it over (the race)
  assert.throws(() => takeLock(out, 'deploy', { beforeTakeover: () => { releaseA = takeLock(out, 'deploy'); } }), /another db-snapshot of --label deploy is running/);
  assert.equal(typeof releaseA, 'function', 'A took the stale lock over');
  assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid} [0-9a-f]+\\n$`), 'the lock is A\'s');
  assert.deepEqual(readdirSync(out), ['.bona-deploy.lock'], 'no temp or set-aside file of B left');
  releaseA();
  assert.deepEqual(readdirSync(out), [], 'A released its lock');

  // A took it over and was already done before B acted: B finds no lock to set aside and takes the free one
  writeFileSync(lock, `${gone} a-killed-run\n`);
  const releaseB = takeLock(out, 'deploy', { beforeTakeover: () => { takeLock(out, 'deploy')(); } });
  assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid} [0-9a-f]+\\n$`));
  assert.deepEqual(readdirSync(out), ['.bona-deploy.lock']);
  releaseB();
  assert.deepEqual(readdirSync(out), []);
});

test('services/README.md: a deletion request also reaches the snapshots in release-backups, and a labelled copy goes once its migration is verified', () => {
  const readme = readFileSync(path.resolve(VPS, '../../README.md'), 'utf8');
  const at = readme.indexOf('`deploy.sh` snapshots');
  assert.ok(at >= 0, 'the snapshot paragraph');
  const para = readme.slice(at, readme.indexOf('\n\n', at));
  for (const re of [/deletion request/, /release-backups/, /pre-v8/, /verified/, /privacy/]) assert.match(para, re);
});

test('services/README.md: snapshots are kept at most 30 days (deploy.sh --max-age-days 30, every label, pre-v8 too), what deletes them, and that the privacy line comes with PR-D1', () => {
  const readme = readFileSync(path.resolve(VPS, '../../README.md'), 'utf8');
  const at = readme.indexOf('`deploy.sh` snapshots');
  const para = readme.slice(at, readme.indexOf('\n\n', at));
  for (const re of [/--max-age-days 30/, /30 days/, /every label/, /pre-v8/, /PR-D1/, /T15/, /between deploys/i]) assert.match(para, re);
  assert.doesNotMatch(para, /never pruned/, 'a copy by hand expires too');
  const restore = readme.slice(readme.indexOf('To restore a snapshot'));
  assert.match(restore.slice(0, restore.indexOf('\n\n')), /at most 30 days/, 'the restore paragraph says how far back a snapshot can go');
  assert.match(readFileSync(path.join(VPS, 'deploy.sh'), 'utf8'), /older than 30 days/, 'the deploy.sh header says it too');
});

test('services/README.md says how to restore a snapshot: stop bona-api, move bona.db-wal and bona.db-shm aside, copy, chmod 600, start', () => {
  const readme = readFileSync(path.resolve(VPS, '../../README.md'), 'utf8');
  const at = readme.indexOf('To restore a snapshot');
  assert.ok(at >= 0, 'a restore paragraph next to the snapshot one');
  const para = readme.slice(at, readme.indexOf('\n\n', at));
  for (const re of [/stop bona-api/, /bona\.db-wal/, /bona\.db-shm/, /chmod 600/, /start/, /owner/]) assert.match(para, re);
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

test('install-vps.sh --check refuses while a stray API process for this user runs from the repo path', () => {
  // A real process whose command line is exactly what a leftover attempt-1 unit would show:
  // <some>/node <repo>/services/api/index.mjs — spawned with node's absolute path.
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'bona-repo-'));
  mkdirSync(path.join(repo, 'services/api'), { recursive: true });
  writeFileSync(path.join(repo, 'services/api/index.mjs'), 'setTimeout(() => {}, 60000);\n');
  const stray = spawn(process.execPath, [path.join(repo, 'services/api/index.mjs')], { stdio: 'ignore' });
  try {
    const r = bash([path.join(VPS, 'install-vps.sh'), '--check'], { env: { HOME: home, BONA_VPS_REPO: repo } });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^MISSING: no legacy bona-api \/ tunnel processes for /m, r.stdout);
  } finally {
    stray.kill('SIGKILL');
  }
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
