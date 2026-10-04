/**
 * The Retell out-of-credit watch (2026-10-05 design R2): a durable flag in `settings`, one
 * owner alert per six hours at most, cleared by the next Retell call that works. The alerts
 * are a spy that records what it was asked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createFundsWatch, fundsOutSince, FUNDS_ALERT_EVERY_MS } from '../lib/dana-funds.mjs';

const NOW = 1_790_600_000_000;
const HOUR = 3_600_000;

function scene({ alerts = true, result = () => ({ users: 1, devices: 1, ok: 1, gone: 0, failed: 0 }) } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  const pushed = [];
  const spy = alerts ? { notifyOwners: (o) => { pushed.push(o); return Promise.resolve(result(pushed.length)); } } : null;
  const logs = [];
  const make = () => createFundsWatch({ team, alerts: spy, now: () => clock, log: (e) => logs.push(e) });
  return { s, team, pushed, logs, funds: make(), make, tick: (ms) => { clock += ms; }, now: () => clock };
}

test('six hours between owner alerts', () => {
  assert.equal(FUNDS_ALERT_EVERY_MS, 6 * HOUR);
});

test('out(): the flag is set once, the owners are pushed once, and the alert time is stored', async () => {
  const h = scene();
  assert.deepEqual(h.funds.status(), { out: null, alerted: null });
  assert.equal(fundsOutSince(h.team), null);
  await h.funds.out();
  assert.equal(h.team.getSetting('retell_funds_out'), String(NOW));
  assert.equal(h.team.getSetting('retell_funds_alerted'), String(NOW));
  assert.deepEqual(h.pushed, [{ reason: 'funds' }]);
  assert.equal(fundsOutSince(h.team), NOW);
  assert.deepEqual(h.funds.status(), { out: NOW, alerted: NOW });
  assert.deepEqual(h.logs, [{ level: 'warn', evt: 'dana.funds_out' }]);

  // A second refusal within six hours: the flag keeps its start, no second push, no second line.
  h.tick(HOUR);
  await h.funds.out();
  assert.equal(h.team.getSetting('retell_funds_out'), String(NOW));
  assert.equal(h.pushed.length, 1);
  assert.equal(h.logs.length, 1);

  // Six hours after the alert, still out: the owners hear again.
  h.tick(5 * HOUR);
  await h.funds.out();
  assert.equal(h.pushed.length, 2);
  assert.equal(h.team.getSetting('retell_funds_alerted'), String(NOW + 6 * HOUR));
  assert.equal(h.team.getSetting('retell_funds_out'), String(NOW), 'still out since the first refusal');
});

test('ok(): clears the flag (one line), keeps the alert time, so a flapping balance alerts once per 6 h', async () => {
  const h = scene();
  h.funds.ok();
  assert.deepEqual(h.logs, [], 'nothing to clear: no line, no write');
  assert.equal(h.s.db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'retell_funds%'").get().n, 0);
  await h.funds.out();
  h.tick(1000);
  h.funds.ok();
  assert.equal(h.team.getSetting('retell_funds_out'), '');
  assert.equal(h.team.getSetting('retell_funds_alerted'), String(NOW));
  assert.equal(fundsOutSince(h.team), null);
  assert.deepEqual(h.logs.map((l) => l.evt), ['dana.funds_out', 'dana.funds_ok']);
  h.funds.ok();
  assert.equal(h.logs.length, 2, 'a second success says nothing');

  h.tick(HOUR);
  await h.funds.out();
  assert.equal(h.team.getSetting('retell_funds_out'), String(NOW + 1000 + HOUR), 'a new outage starts now');
  assert.equal(h.pushed.length, 1, 'but no second push within six hours of the last');
  assert.deepEqual(h.logs.map((l) => l.evt), ['dana.funds_out', 'dana.funds_ok', 'dana.funds_out']);
});

test('the state survives a restart: a new watch over the same settings sees the flag and the alert time', async () => {
  const h = scene();
  await h.funds.out();
  const again = h.make();
  h.tick(HOUR);
  await again.out();
  assert.equal(h.pushed.length, 1, 'no second alert after the restart');
  assert.deepEqual(again.status(), { out: NOW, alerted: NOW });
});

test('without alerts the flag is still kept; no alert time is stored for a push that never went', async () => {
  const h = scene({ alerts: false });
  await h.funds.out();
  assert.equal(fundsOutSince(h.team), NOW);
  assert.equal(h.team.getSetting('retell_funds_alerted'), '');
});

test('out() and ok() never throw: a broken store or alerts is a logged line, not a failed answer', async () => {
  const h = scene();
  const funds = createFundsWatch({
    team: h.team, alerts: { notifyOwners: () => { throw new Error('push down'); } }, now: h.now, log: (e) => h.logs.push(e),
  });
  await funds.out();
  assert.equal(fundsOutSince(h.team), NOW, 'the flag went in before the push');
  h.s.close();
  assert.doesNotThrow(() => funds.out());
  assert.doesNotThrow(() => funds.ok());
  assert.doesNotThrow(() => funds.status());
  assert.ok(h.logs.some((l) => l.evt === 'dana.funds_failed' && l.level === 'error'));
  assert.doesNotMatch(JSON.stringify(h.logs), /push down/);
});

test('fundsOutSince reads only a real timestamp: anything else is "fine"', () => {
  const h = scene();
  h.s.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated, updated_by) VALUES ('retell_funds_out','oops',?,NULL)").run(NOW);
  assert.equal(fundsOutSince(h.team), null);
  h.s.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated, updated_by) VALUES ('retell_funds_out','0',?,NULL)").run(NOW);
  assert.equal(fundsOutSince(h.team), null);
});

test('the alert time stands only when a push reached a device: off, no devices, all failed, an error each leave the previous value', async () => {
  for (const [label, answer] of [
    ['pusher off', { skipped: 'off' }],
    ['no owner devices', { skipped: 'no_devices' }],
    ['every send failed', { users: 1, devices: 2, ok: 0, gone: 1, failed: 1 }],
    ['the push threw', { error: 'failed' }],
    ['no answer at all', null],
  ]) {
    const h = scene({ result: () => answer });
    await h.funds.out();
    assert.equal(h.team.getSetting('retell_funds_alerted'), '', `${label}: rolled back to none`);
    assert.equal(fundsOutSince(h.team), NOW, `${label}: the flag stays`);
    // A previous alert, more than 6 h ago, is what it goes back to.
    h.team.setSetting('retell_funds_alerted', String(NOW - 7 * HOUR));
    h.tick(1000);
    await h.funds.out();
    assert.equal(h.team.getSetting('retell_funds_alerted'), String(NOW - 7 * HOUR), `${label}: back to the previous alert`);
    assert.equal(h.pushed.length, 2, `${label}: tried each time`);
  }
});

test('a later 402 after the owner subscribes does push: a push that reached nobody never quiets the next', async () => {
  const h = scene({ result: (n) => (n === 1 ? { skipped: 'no_devices' } : { users: 1, devices: 1, ok: 1, gone: 0, failed: 0 }) });
  await h.funds.out();
  assert.equal(h.team.getSetting('retell_funds_alerted'), '');
  h.tick(10 * 60_000);
  await h.funds.out();
  assert.equal(h.pushed.length, 2);
  assert.equal(h.team.getSetting('retell_funds_alerted'), String(NOW + 10 * 60_000));
  h.tick(60_000);
  await h.funds.out();
  assert.equal(h.pushed.length, 2, 'delivered: quiet for 6 h now');
});

test('the alert time is stamped before the push leaves: a 402 during the send is quiet', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const pushed = [];
  const h = scene();
  const funds = createFundsWatch({ team: h.team, now: h.now, alerts: { notifyOwners: (o) => { pushed.push(o); return gate; } } });
  const first = funds.out();
  await funds.out();
  assert.equal(pushed.length, 1);
  release({ users: 1, devices: 1, ok: 1, gone: 0, failed: 0 });
  await first;
  assert.equal(h.team.getSetting('retell_funds_alerted'), String(NOW));
});
