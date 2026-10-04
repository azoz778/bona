import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, tokenHash } from '../lib/db.mjs';
import { createTeam, isExcludedLead } from '../lib/team.mjs';
import { createAlerts, ALERT_EVERY_MS, ALERT_FRESH_MS, MAX_DEVICES_PER_USER, CHECK_PENDING_MS } from '../lib/alerts.mjs';

const NOW = 1_790_600_000_000;
const b64u = (b) => Buffer.from(b).toString('base64url');
const KEYS = { p256dh: b64u(Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)])), auth: b64u(crypto.randomBytes(16)) };
const ep = (n) => `https://fcm.googleapis.com/fcm/send/device-${n}`;

/** A db with the owner, two staff members each signed in once, one `in` chat, and a fake pusher. */
function scene({ answer = () => ({ status: 201 }), configured = true, log = null } = {}) {
  const db = openDb(':memory:');
  let clock = NOW;
  const now = () => clock;
  const team = createTeam(db, { now });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Owner' });
  const sara = team.addUser({ name: 'Sara', phone: '966500000001', role: 'staff' });
  const omar = team.addUser({ name: 'Omar', phone: '966500000002', role: 'staff' });
  const session = (u) => { const t = crypto.randomBytes(16).toString('hex'); db.createAuthSession(t, { now: clock, userId: u.user_id }); return tokenHash(t); };
  const sessions = { owner: session(owner), sara: session(sara), omar: session(omar) };
  db.insertLead({ lead_id: 'LEAD-A', created: NOW, updated: NOW, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net', channel: 'whatsapp', stage: 'new', inbox_state: 'in', inbox_since: NOW });
  const sent = [];
  const pusher = configured ? { publicKey: 'PUB', send: async (endpoint) => { sent.push(endpoint); return answer(endpoint, sent.length); } } : null;
  const logs = [];
  const alerts = createAlerts({ db, pusher, isExcludedLead: (l) => isExcludedLead(team, db, l), now, log: log ?? ((e) => logs.push(e)) });
  const sub = (who, n) => alerts.subscribe({ userId: { owner, sara, omar }[who].user_id, sessionHash: sessions[who], endpoint: ep(n), keys: KEYS });
  return { db, team, owner, sara, omar, sessions, alerts, sent, logs, sub, session, tick: (ms) => { clock += ms; }, now };
}

test('createAlerts refuses to run without the exclusion rule', () => {
  const db = openDb(':memory:');
  assert.throws(() => createAlerts({ db }), /isExcludedLead/);
  db.close();
});

test('subscribe checks the endpoint and keys, stores one row per endpoint, bound to the session', () => {
  const s = scene();
  assert.deepEqual(s.sub('sara', 1), { ok: true, created: true, moved: false });
  assert.deepEqual(s.sub('sara', 1), { ok: true, created: false, moved: false }, 'the same device posted again is no new device, and has not changed hands');
  assert.deepEqual(s.alerts.subscribe({ userId: s.sara.user_id, sessionHash: s.sessions.sara, endpoint: 'https://evil.example/x', keys: KEYS }), { ok: false, error: 'bad_endpoint' });
  assert.deepEqual(s.alerts.subscribe({ userId: s.sara.user_id, sessionHash: s.sessions.sara, endpoint: ep(2), keys: { p256dh: 'x', auth: 'y' } }), { ok: false, error: 'bad_keys' });
  assert.deepEqual(s.alerts.subscribe({ userId: '', sessionHash: s.sessions.sara, endpoint: ep(2), keys: KEYS }), { ok: false, error: 'bad_request' });
  assert.deepEqual(s.alerts.subscribe({ userId: s.sara.user_id, sessionHash: '', endpoint: ep(2), keys: KEYS }), { ok: false, error: 'bad_request' });
  const rows = s.db.db.prepare('SELECT user_id, endpoint, session_hash, fail_count FROM push_subscriptions').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ user_id: s.sara.user_id, endpoint: ep(1), session_hash: s.sessions.sara, fail_count: 0 }]);
});

test('subscribe binds only to a live session of the member posting it', () => {
  const s = scene();
  const post = (userId, sessionHash) => s.alerts.subscribe({ userId, sessionHash, endpoint: ep(1), keys: KEYS });
  assert.deepEqual(post(s.sara.user_id, tokenHash('never-issued')), { ok: false, error: 'bad_request' }, 'an unknown session');
  assert.deepEqual(post(s.sara.user_id, s.sessions.omar), { ok: false, error: 'bad_request' }, "another member's live session");
  s.db.db.prepare('UPDATE auth_sessions SET expires = ? WHERE token_hash = ?').run(NOW - 1, s.sessions.sara);
  assert.deepEqual(post(s.sara.user_id, s.sessions.sara), { ok: false, error: 'bad_request' }, 'her own session, expired');
  assert.equal(s.db.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0, 'nothing was stored');
  assert.deepEqual(post(s.omar.user_id, s.sessions.omar), { ok: true, created: true, moved: false });
});

test('the same endpoint posted by someone else (a shared phone) moves to them, it is never two rows', () => {
  const s = scene();
  s.sub('sara', 1);
  s.db.db.prepare('UPDATE push_subscriptions SET fail_count = 3').run();
  s.tick(1000);
  s.sub('omar', 1);
  const rows = s.db.db.prepare('SELECT user_id, session_hash, fail_count, updated FROM push_subscriptions').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ user_id: s.omar.user_id, session_hash: s.sessions.omar, fail_count: 0, updated: NOW + 1000 }]);
  assert.equal(s.alerts.countFor(s.sara.user_id), 0);
});

test(`at most ${MAX_DEVICES_PER_USER} devices a member: the least recently posted goes`, () => {
  const s = scene();
  for (let i = 1; i <= MAX_DEVICES_PER_USER + 2; i += 1) { s.sub('sara', i); s.tick(10); }
  assert.equal(s.alerts.countFor(s.sara.user_id), MAX_DEVICES_PER_USER);
  const kept = s.db.db.prepare('SELECT endpoint FROM push_subscriptions ORDER BY updated').all().map((r) => r.endpoint);
  assert.deepEqual(kept, Array.from({ length: MAX_DEVICES_PER_USER }, (_, i) => ep(i + 3)));
});

test('unsubscribe removes only the member\'s own endpoint; forgetSession removes that session\'s devices', () => {
  const s = scene();
  s.sub('sara', 1); s.sub('sara', 2); s.sub('omar', 3);
  assert.equal(s.alerts.unsubscribe({ userId: s.omar.user_id, endpoint: ep(1) }), false, 'not his');
  assert.equal(s.alerts.unsubscribe({ userId: s.sara.user_id, endpoint: ep(1) }), true);
  assert.equal(s.alerts.unsubscribe({ userId: s.sara.user_id, endpoint: 'nonsense' }), false);
  assert.equal(s.alerts.forgetSession(s.sessions.sara), 1);
  assert.equal(s.alerts.countFor(s.sara.user_id), 0);
  assert.equal(s.alerts.countFor(s.omar.user_id), 1);
});

test('recipients: the handler; nobody handling → everyone active; needs a human → everyone; never the one excepted', () => {
  const s = scene();
  const lead = () => s.db.getLead('LEAD-A');
  const all = [s.owner.user_id, s.sara.user_id, s.omar.user_id].sort();
  assert.deepEqual(s.alerts.recipients(lead()).sort(), all);
  s.db.db.prepare('UPDATE leads SET handler_user_id = ? WHERE lead_id = ?').run(s.sara.user_id, 'LEAD-A');
  assert.deepEqual(s.alerts.recipients(lead()), [s.sara.user_id]);
  s.team.deactivateUser(s.sara.user_id);
  assert.deepEqual(s.alerts.recipients(lead()).sort(), [s.owner.user_id, s.omar.user_id].sort(), 'an inactive handler is nobody');
  s.team.reactivateUser(s.sara.user_id);
  s.db.db.prepare('UPDATE leads SET needs_human = 1 WHERE lead_id = ?').run('LEAD-A');
  assert.deepEqual(s.alerts.recipients(lead()).sort(), all);
  s.db.db.prepare('UPDATE leads SET needs_human = 0 WHERE lead_id = ?').run('LEAD-A');
  assert.deepEqual(s.alerts.recipients(lead(), { reason: 'needs_human' }).sort(), all);
  assert.deepEqual(s.alerts.recipients(lead(), { reason: 'needs_human', exceptUserId: s.omar.user_id }).sort(), [s.owner.user_id, s.sara.user_id].sort());
});

test('notify pushes every live device of every recipient once, and logs counts only', async () => {
  const s = scene();
  s.sub('owner', 1); s.sub('sara', 2); s.sub('sara', 3); s.sub('omar', 4);
  const out = await s.alerts.notify('LEAD-A', { ts: NOW });
  assert.deepEqual(out, { users: 3, devices: 4, ok: 4, gone: 0, failed: 0 });
  assert.deepEqual(s.sent.sort(), [ep(1), ep(2), ep(3), ep(4)]);
  const line = s.logs.find((l) => l.evt === 'push.sent');
  assert.deepEqual(line, { evt: 'push.sent', leadId: 'LEAD-A', reason: 'inbound', users: 3, devices: 4, ok: 4, gone: 0, failed: 0 });
  assert.doesNotMatch(JSON.stringify(s.logs), /fcm\.googleapis|device-|966|Sara|Omar/);
  assert.equal(s.db.db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE last_ok = ?').get(NOW).n, 4);
});

test('one push per chat per member per 2 minutes, however many messages; marked before the sends', async () => {
  const s = scene();
  s.sub('sara', 1);
  const [a, b] = await Promise.all([s.alerts.notify('LEAD-A', { ts: NOW }), s.alerts.notify('LEAD-A', { ts: NOW })]);
  assert.equal(a.ok, 1);
  assert.deepEqual(b, { skipped: 'quiet' });
  s.tick(ALERT_EVERY_MS - 1);
  assert.deepEqual(await s.alerts.notify('LEAD-A', { ts: NOW }), { skipped: 'quiet' });
  s.tick(1);
  assert.equal((await s.alerts.notify('LEAD-A', { ts: NOW })).ok, 1);
  assert.equal(s.sent.length, 2);
});

test('the rule is per member: a member who was just alerted is skipped, the others are not', async () => {
  const s = scene();
  s.sub('sara', 1); s.sub('omar', 2);
  s.db.db.prepare('UPDATE leads SET handler_user_id = ? WHERE lead_id = ?').run(s.sara.user_id, 'LEAD-A');
  await s.alerts.notify('LEAD-A', { ts: NOW });
  s.db.db.prepare('UPDATE leads SET handler_user_id = NULL WHERE lead_id = ?').run('LEAD-A');
  const out = await s.alerts.notify('LEAD-A', { ts: NOW });
  assert.deepEqual({ users: out.users, devices: out.devices }, { users: 1, devices: 1 });
  assert.deepEqual(s.sent, [ep(1), ep(2)]);
});

test('notify never pushes to the member excepted, whatever the reason', async () => {
  const s = scene();
  s.sub('sara', 1); s.sub('omar', 2);
  const out = await s.alerts.notify('LEAD-A', { ts: NOW, reason: 'needs_human', exceptUserId: s.sara.user_id });
  assert.deepEqual(out, { users: 1, devices: 1, ok: 1, gone: 0, failed: 0 });
  assert.deepEqual(s.sent, [ep(2)]);
});

test('no push for a chat that is not in the inbox, or is a colleague\'s or never-list number', async () => {
  const s = scene();
  s.sub('sara', 1);
  s.db.db.prepare("UPDATE leads SET inbox_state = 'unsure' WHERE lead_id = 'LEAD-A'").run();
  assert.deepEqual(await s.alerts.notify('LEAD-A', { ts: NOW }), { skipped: 'not_in_inbox' });
  s.db.db.prepare("UPDATE leads SET inbox_state = 'in' WHERE lead_id = 'LEAD-A'").run();
  s.db.db.prepare("UPDATE leads SET phone_e164 = ?, wa_jid = ? WHERE lead_id = 'LEAD-A'").run(s.omar.phone_e164, s.omar.wa_jid);
  assert.deepEqual(await s.alerts.notify('LEAD-A', { ts: NOW }), { skipped: 'not_in_inbox' }, "a colleague's number");
  s.db.db.prepare("UPDATE leads SET phone_e164 = '966500000077', wa_jid = '966500000077@s.whatsapp.net' WHERE lead_id = 'LEAD-A'").run();
  s.team.addNever({ phone: '966500000077' });
  assert.deepEqual(await s.alerts.notify('LEAD-A', { ts: NOW }), { skipped: 'not_in_inbox' }, 'a never-list number');
  assert.deepEqual(await s.alerts.notify('LEAD-NOPE', { ts: NOW }), { skipped: 'not_in_inbox' });
  assert.equal(s.sent.length, 0);
});

test(`a message older than ${ALERT_FRESH_MS / 60_000} minutes is not an alert (an outage's catch-up)`, async () => {
  const s = scene();
  s.sub('sara', 1);
  assert.deepEqual(await s.alerts.notify('LEAD-A', { ts: NOW - ALERT_FRESH_MS - 1 }), { skipped: 'old' });
  assert.equal((await s.alerts.notify('LEAD-A', { ts: NOW - ALERT_FRESH_MS })).ok, 1);
});

test('only live sessions of active members get pushes: logged out, expired, deactivated, another member\'s session', async () => {
  const s = scene();
  const lina = s.team.addUser({ name: 'Lina', phone: '966500000003', role: 'staff' });
  const linaSession = s.session(lina);
  s.sub('sara', 1); s.sub('omar', 2); s.sub('owner', 3);
  assert.deepEqual(s.alerts.subscribe({ userId: lina.user_id, sessionHash: linaSession, endpoint: ep(4), keys: KEYS }), { ok: true, created: true, moved: false });
  s.db.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(s.sessions.sara); // logged out
  s.db.db.prepare('UPDATE auth_sessions SET expires = ? WHERE token_hash = ?').run(NOW - 1, s.sessions.omar); // expired
  s.db.db.prepare('UPDATE push_subscriptions SET session_hash = ? WHERE endpoint = ?').run(linaSession, ep(3)); // a colleague's live session
  s.db.db.prepare('UPDATE users SET active = 0 WHERE user_id = ?').run(lina.user_id); // deactivated, her session and device still there
  assert.deepEqual(await s.alerts.notify('LEAD-A', { ts: NOW }), { skipped: 'no_devices' });
  assert.equal(s.sent.length, 0);
  assert.equal(s.alerts.pruneOrphans(), 3, "gone, expired and a colleague's sessions take their devices with them");
  assert.equal(s.alerts.countFor(lina.user_id), 1, "a deactivated member's own live session is not the sweep's to judge");
});

test('pruneOrphans sweeps a row that has no session at all', () => {
  const s = scene();
  s.sub('sara', 1);
  s.db.db.prepare('UPDATE push_subscriptions SET session_hash = NULL WHERE endpoint = ?').run(ep(1));
  assert.equal(s.alerts.pruneOrphans(), 1);
  assert.equal(s.alerts.countFor(s.sara.user_id), 0);
});

test('404/410 delete the device; any other answer counts a failure, is logged by status, and is not retried', async () => {
  const answers = { [ep(1)]: { status: 410 }, [ep(2)]: { status: 404 }, [ep(3)]: { status: 403 }, [ep(4)]: { error: 'timeout' }, [ep(5)]: { status: 201 } };
  const s = scene({ answer: (endpoint) => answers[endpoint] });
  for (let i = 1; i <= 5; i += 1) s.sub('sara', i);
  const out = await s.alerts.notify('LEAD-A', { ts: NOW });
  assert.deepEqual(out, { users: 1, devices: 5, ok: 1, gone: 2, failed: 2 }, 'everyone is due, only Sara has devices');
  assert.equal(s.sent.length, 5, 'one try each');
  const left = s.db.db.prepare('SELECT endpoint, fail_count FROM push_subscriptions ORDER BY endpoint').all().map((r) => [r.endpoint, r.fail_count]);
  assert.deepEqual(left, [[ep(3), 1], [ep(4), 1], [ep(5), 0]]);
  const refused = s.logs.filter((l) => l.evt === 'push.refused').map(({ level, status, error }) => ({ level, status, error }));
  assert.deepEqual(refused, [{ level: 'warn', status: 403, error: undefined }, { level: 'warn', status: undefined, error: 'timeout' }]);
});

test('a late answer never touches a device re-posted while the push was in flight', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = scene({ answer: async () => { await gate; return { status: 410 }; } });
  s.sub('sara', 1);
  const p = s.alerts.notify('LEAD-A', { ts: NOW });
  await new Promise((r) => setImmediate(r)); // the push has left; the service has not answered
  s.tick(1);
  assert.deepEqual(s.sub('omar', 1), { ok: true, created: false, moved: true }, 'the shared phone is now signed in as Omar: it changed hands');
  release();
  assert.deepEqual(await p, { users: 1, devices: 1, ok: 0, gone: 1, failed: 0 });
  const rows = s.db.db.prepare('SELECT user_id, endpoint, fail_count FROM push_subscriptions').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ user_id: s.omar.user_id, endpoint: ep(1), fail_count: 0 }], "Sara's 410 is not Omar's");
});

test('a send that rejects is that device\'s failure only, never the batch\'s', async () => {
  const s = scene({ answer: (endpoint) => { if (endpoint === ep(1)) throw new Error('boom device-1'); return { status: 201 }; } });
  s.sub('sara', 1); s.sub('sara', 2);
  assert.deepEqual(await s.alerts.notify('LEAD-A', { ts: NOW }), { users: 1, devices: 2, ok: 1, gone: 0, failed: 1 });
  const rows = s.db.db.prepare('SELECT endpoint, last_ok, fail_count FROM push_subscriptions ORDER BY endpoint').all().map((r) => [r.endpoint, r.last_ok, r.fail_count]);
  assert.deepEqual(rows, [[ep(1), null, 1], [ep(2), NOW, 0]]);
  const refused = s.logs.filter((l) => l.evt === 'push.refused').map(({ status, error }) => ({ status, error }));
  assert.deepEqual(refused, [{ status: undefined, error: 'threw' }]);
  assert.doesNotMatch(JSON.stringify(s.logs), /boom|device-/);
});

test('a reason that is not one of ours follows the inbound rules and is logged as "other", never echoed', async () => {
  const s = scene();
  s.sub('sara', 1);
  s.db.db.prepare('UPDATE leads SET handler_user_id = ? WHERE lead_id = ?').run(s.omar.user_id, 'LEAD-A');
  assert.deepEqual(await s.alerts.notify('LEAD-A', { ts: NOW, reason: 'Sara said 0500000077' }), { skipped: 'no_devices' }, 'the handler rule applied, Omar has no device');
  s.db.db.prepare('UPDATE leads SET handler_user_id = NULL WHERE lead_id = ?').run('LEAD-A');
  assert.equal((await s.alerts.notify('LEAD-A', { ts: NOW, reason: 'Sara said 0500000077' })).ok, 1);
  assert.equal(s.logs.find((l) => l.evt === 'push.sent').reason, 'other');
  assert.doesNotMatch(JSON.stringify(s.logs), /0500000077|Sara/);
});

test('without keys nothing is ever sent, and notify still resolves', async () => {
  const s = scene({ configured: false });
  assert.equal(s.alerts.configured, false);
  assert.equal(s.alerts.publicKey, null);
  s.sub('sara', 1);
  assert.deepEqual(await s.alerts.notify('LEAD-A', { ts: NOW }), { skipped: 'off' });
});

test('notify never rejects, even when the db throws; flush waits for every push in flight', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = scene({ answer: async () => { await gate; return { status: 201 }; } });
  s.sub('sara', 1);
  const p = s.alerts.notify('LEAD-A', { ts: NOW });
  let flushed = false;
  const f = s.alerts.flush().then(() => { flushed = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(flushed, false);
  release();
  await f;
  assert.equal((await p).ok, 1);
  s.db.close();
  const broken = await s.alerts.notify('LEAD-A', { ts: NOW });
  assert.deepEqual(broken, { error: 'failed' });
  assert.ok(s.logs.some((l) => l.evt === 'push.failed' && l.level === 'error'));
});

test('a logger that throws changes nothing: notify still answers what happened', async () => {
  const s = scene({ answer: (endpoint) => (endpoint === ep(2) ? { status: 403 } : { status: 201 }), log: () => { throw new Error('logger down'); } });
  s.sub('sara', 1); s.sub('sara', 2);
  assert.deepEqual(await s.alerts.notify('LEAD-A', { ts: NOW }), { users: 1, devices: 2, ok: 1, gone: 0, failed: 1 });
  const rows = s.db.db.prepare('SELECT endpoint, fail_count FROM push_subscriptions ORDER BY endpoint').all().map((r) => [r.endpoint, r.fail_count]);
  assert.deepEqual(rows, [[ep(1), 0], [ep(2), 1]]);
});

/** The scene plus one chat in the Unsure list (no handler), and a device each for the owner and Sara. */
function checkScene() {
  const s = scene();
  s.db.insertLead({ lead_id: 'LEAD-U', created: NOW, updated: NOW, phone_e164: '966500000088', wa_jid: '966500000088@s.whatsapp.net', channel: 'whatsapp', stage: 'new', inbox_state: 'unsure', inbox_since: NOW });
  s.sub('owner', 1); s.sub('sara', 2);
  return s;
}
const setLead = (s, sql, ...args) => s.db.db.prepare(`UPDATE leads SET ${sql} WHERE lead_id = 'LEAD-U'`).run(...args);

test("reason 'check': an Unsure chat alerts active owners only, once per 2 min, and is remembered until the chat leaves Unsure", async () => {
  const s = checkScene();
  const out = await s.alerts.notify('LEAD-U', { reason: 'check', ts: NOW - 1000 });
  assert.deepEqual(out, { users: 1, devices: 1, ok: 1, gone: 0, failed: 0 });
  assert.deepEqual(s.sent, [ep(1)], 'the owner only, never staff');
  assert.deepEqual(s.alerts.pendingCheck(s.owner.user_id), { leadId: 'LEAD-U', ts: NOW, msgTs: NOW - 1000 });
  assert.equal(s.alerts.pendingCheck(s.sara.user_id), null);
  assert.deepEqual(await s.alerts.notify('LEAD-U', { reason: 'check', ts: NOW }), { skipped: 'quiet' }, 'one per chat per owner per 2 min');
  setLead(s, "inbox_state = 'in'");
  assert.equal(s.alerts.pendingCheck(s.owner.user_id), null, 'forgotten once the chat is no longer Unsure');
  setLead(s, "inbox_state = 'unsure'");
  assert.equal(s.alerts.pendingCheck(s.owner.user_id), null, 'and stays forgotten');
  setLead(s, "inbox_state = 'in'");
  s.tick(ALERT_EVERY_MS);
  assert.deepEqual(await s.alerts.notify('LEAD-U', { reason: 'check', ts: s.now() }), { skipped: 'not_unsure' }, 'an in chat is not a check');
  assert.ok(s.logs.some((l) => l.evt === 'push.sent' && l.reason === 'check' && l.users === 1));
  assert.doesNotMatch(JSON.stringify(s.logs), /fcm\.googleapis|device-|966/);
});

test('a pending check ages out after CHECK_PENDING_MS (longer than the push TTL: a late delivery still reads as a check)', async () => {
  assert.equal(CHECK_PENDING_MS, 2 * 3_600_000);
  const s = checkScene();
  await s.alerts.notify('LEAD-U', { reason: 'check', ts: NOW });
  s.tick(CHECK_PENDING_MS);
  assert.deepEqual(s.alerts.pendingCheck(s.owner.user_id), { leadId: 'LEAD-U', ts: NOW, msgTs: NOW }, 'at exactly 2 h, still pending');
  s.tick(1);
  assert.equal(s.alerts.pendingCheck(s.owner.user_id), null, 'a millisecond past: gone');
  s.tick(-1);
  assert.equal(s.alerts.pendingCheck(s.owner.user_id), null, 'and forgotten, not just hidden');
});

test("reason 'check' keeps the freshness rule and the excluded rule", async () => {
  const s = checkScene();
  assert.deepEqual(await s.alerts.notify('LEAD-U', { reason: 'check', ts: NOW - 31 * 60_000 }), { skipped: 'old' });
  setLead(s, 'phone_e164 = ?, wa_jid = ?', s.sara.phone_e164, s.sara.wa_jid);
  assert.deepEqual(await s.alerts.notify('LEAD-U', { reason: 'check', ts: NOW }), { skipped: 'not_unsure' }, "a colleague's number is never a chat to check");
  assert.deepEqual(await s.alerts.notify('LEAD-NOPE', { reason: 'check', ts: NOW }), { skipped: 'not_unsure' });
  assert.equal(s.sent.length, 0);
  assert.equal(s.alerts.pendingCheck(s.owner.user_id), null);
});

test('recipients for check are the active owners, whoever handles the chat', () => {
  const s = checkScene();
  setLead(s, 'handler_user_id = ?', s.sara.user_id);
  const lead = () => s.db.getLead('LEAD-U');
  assert.deepEqual(s.alerts.recipients(lead(), { reason: 'check' }), [s.owner.user_id]);
  s.team.setRole(s.omar.user_id, 'owner');
  assert.deepEqual(s.alerts.recipients(lead(), { reason: 'check' }).sort(), [s.owner.user_id, s.omar.user_id].sort());
  s.team.deactivateUser(s.omar.user_id);
  assert.deepEqual(s.alerts.recipients(lead(), { reason: 'check' }), [s.owner.user_id], 'a deactivated owner is not a recipient');
});

test('a newer check replaces the older one; pendingCheck answers only an active owner', async () => {
  const s = checkScene();
  s.db.insertLead({ lead_id: 'LEAD-V', created: NOW, updated: NOW, phone_e164: '966500000089', wa_jid: '966500000089@s.whatsapp.net', channel: 'whatsapp', stage: 'new', inbox_state: 'unsure', inbox_since: NOW });
  await s.alerts.notify('LEAD-U', { reason: 'check', ts: NOW });
  s.tick(5000);
  await s.alerts.notify('LEAD-V', { reason: 'check', ts: s.now() });
  assert.deepEqual(s.alerts.pendingCheck(s.owner.user_id), { leadId: 'LEAD-V', ts: NOW + 5000, msgTs: NOW + 5000 }, 'A → B: the newest check');
  s.team.setRole(s.omar.user_id, 'owner');
  s.team.setRole(s.owner.user_id, 'staff');
  assert.equal(s.alerts.pendingCheck(s.owner.user_id), null, 'no longer an owner');
  s.team.setRole(s.owner.user_id, 'owner');
  assert.equal(s.alerts.pendingCheck(s.owner.user_id), null, 'forgotten, not hidden');
  s.tick(ALERT_EVERY_MS);
  await s.alerts.notify('LEAD-U', { reason: 'check', ts: s.now() });
  assert.equal(s.alerts.pendingCheck(s.owner.user_id)?.leadId, 'LEAD-U');
  s.team.deactivateUser(s.owner.user_id);
  assert.equal(s.alerts.pendingCheck(s.owner.user_id), null, 'a deactivated owner');
});

test("a check's mark never quiets the inbound alert of the same chat once it is moved in", async () => {
  const s = checkScene();
  assert.equal((await s.alerts.notify('LEAD-U', { reason: 'check', ts: NOW })).ok, 1);
  setLead(s, "inbox_state = 'in'");
  s.tick(10_000);
  const out = await s.alerts.notify('LEAD-U', { ts: s.now() });
  assert.notDeepEqual(out, { skipped: 'quiet' });
  assert.equal(out.ok, 2, 'the owner and Sara (nobody handles it yet)');
  assert.deepEqual(s.sent, [ep(1), ep(1), ep(2)]);
});

test('pendingCheck forgets a check whose chat became excluded (never list, or a team number) and it stays forgotten', async () => {
  const s = checkScene();
  await s.alerts.notify('LEAD-U', { reason: 'check', ts: NOW });
  assert.equal(s.alerts.pendingCheck(s.owner.user_id)?.leadId, 'LEAD-U');
  s.team.addNever({ phone: '966500000088' });
  assert.equal(s.alerts.pendingCheck(s.owner.user_id), null, 'a never-list number is no check');
  s.team.removeNever('966500000088');
  assert.equal(s.alerts.pendingCheck(s.owner.user_id), null, 'and stays forgotten');

  const t = checkScene();
  await t.alerts.notify('LEAD-U', { reason: 'check', ts: NOW });
  t.db.db.prepare("UPDATE leads SET phone_e164 = ?, wa_jid = ? WHERE lead_id = 'LEAD-U'").run(t.sara.phone_e164, t.sara.wa_jid);
  assert.equal(t.alerts.pendingCheck(t.owner.user_id), null, "a colleague's number is no check");
});

test('a pending check carries the triggering message time (msgTs) apart from when it was sent (ts)', async () => {
  const s = checkScene();
  await s.alerts.notify('LEAD-U', { reason: 'check', ts: NOW - 60_000 });
  assert.deepEqual(s.alerts.pendingCheck(s.owner.user_id), { leadId: 'LEAD-U', ts: NOW, msgTs: NOW - 60_000 });
  s.tick(ALERT_EVERY_MS);
  await s.alerts.notify('LEAD-U', { reason: 'check' });
  assert.deepEqual(s.alerts.pendingCheck(s.owner.user_id), { leadId: 'LEAD-U', ts: NOW + ALERT_EVERY_MS, msgTs: NOW + ALERT_EVERY_MS }, 'no ts given: the clock');
});

/* ---------------- reason 'funds' (2026-10-05 design R2): owner-wide, no chat ---------------- */

test("notifyOwners 'funds': every live device of the active owners, never staff; logged with counts and no lead", async () => {
  const s = scene();
  const boss2 = s.team.addUser({ name: 'Second Owner', phone: '966500000003', role: 'owner' });
  const h2 = s.session(boss2);
  s.sub('owner', 1); s.sub('owner', 2); s.sub('sara', 3); s.sub('omar', 4);
  s.alerts.subscribe({ userId: boss2.user_id, sessionHash: h2, endpoint: ep(5), keys: KEYS });
  const out = await s.alerts.notifyOwners({ reason: 'funds' });
  assert.deepEqual(out, { users: 2, devices: 3, ok: 3, gone: 0, failed: 0 });
  assert.deepEqual(s.sent.sort(), [ep(1), ep(2), ep(5)], 'the owners only');
  assert.deepEqual(s.logs.find((l) => l.evt === 'push.sent'), { evt: 'push.sent', reason: 'funds', users: 2, devices: 3, ok: 3, gone: 0, failed: 0 });
  assert.doesNotMatch(JSON.stringify(s.logs), /fcm\.googleapis|device-|966|Owner/);
});

test("notifyOwners 'funds' shares the device handling: 410 deletes, a failure counts, a deactivated owner hears nothing", async () => {
  const answers = { [ep(1)]: { status: 410 }, [ep(2)]: { status: 500 } };
  const s = scene({ answer: (endpoint) => answers[endpoint] ?? { status: 201 } });
  s.sub('owner', 1); s.sub('owner', 2);
  assert.deepEqual(await s.alerts.notifyOwners({ reason: 'funds' }), { users: 1, devices: 2, ok: 0, gone: 1, failed: 1 });
  assert.deepEqual(s.db.db.prepare('SELECT endpoint, fail_count FROM push_subscriptions').all().map((r) => [r.endpoint, r.fail_count]), [[ep(2), 1]]);
  assert.ok(s.logs.some((l) => l.evt === 'push.refused' && l.status === 500));
  // A second owner keeps the team owned; the first is deactivated: no devices left to push.
  const boss2 = s.team.addUser({ name: 'Second Owner', phone: '966500000003', role: 'owner' });
  s.team.deactivateUser(s.owner.user_id);
  assert.deepEqual(await s.alerts.notifyOwners({ reason: 'funds' }), { skipped: 'no_devices' });
});

test("notifyOwners: off without keys, a reason that is not an owner-wide one is refused, and it never rejects", async () => {
  const off = scene({ configured: false });
  off.sub('owner', 1);
  assert.deepEqual(await off.alerts.notifyOwners({ reason: 'funds' }), { skipped: 'off' });
  const s = scene();
  s.sub('owner', 1);
  assert.deepEqual(await s.alerts.notifyOwners({ reason: 'inbound' }), { skipped: 'bad_reason' });
  assert.deepEqual(await s.alerts.notifyOwners(), { skipped: 'bad_reason' });
  assert.deepEqual(s.sent, []);
  const broken = scene();
  broken.db.close();
  assert.deepEqual(await broken.alerts.notifyOwners({ reason: 'funds' }), { error: 'failed' });
  assert.ok(broken.logs.some((l) => l.evt === 'push.failed'));
});

test('fundsPending: an active owner, an alert under an hour old, and no other push to them since', async () => {
  const s = scene();
  s.sub('owner', 1); s.sub('sara', 2);
  const alerted = NOW;
  await s.alerts.notifyOwners({ reason: 'funds' });
  assert.equal(s.alerts.fundsPending(s.owner.user_id, alerted), true);
  assert.equal(s.alerts.fundsPending(s.sara.user_id, alerted), false, 'staff never');
  assert.equal(s.alerts.fundsPending(s.owner.user_id, null), false, 'no alert time, no funds');
  s.tick(3_600_000 - 1);
  assert.equal(s.alerts.fundsPending(s.owner.user_id, alerted), true);
  s.tick(1);
  assert.equal(s.alerts.fundsPending(s.owner.user_id, alerted), false, 'an hour on, the push is gone (its TTL)');
});

test('fundsPending: the hand-over push that follows the funds alert within 2 minutes does not hide it; a chat push later than that does', async () => {
  const s = scene();
  s.sub('owner', 1);
  await s.alerts.notifyOwners({ reason: 'funds' });
  // The 402's own hand-over: a few ms, then about a second after the funds alert.
  s.tick(5);
  assert.equal((await s.alerts.notify('LEAD-A', { reason: 'needs_human', ts: s.now() })).ok, 1);
  assert.equal(s.alerts.fundsPending(s.owner.user_id, NOW), true, 'a few ms after: still funds');
  s.tick(1000);
  s.db.insertLead({ lead_id: 'LEAD-B', created: NOW, updated: NOW, phone_e164: '966500000099', wa_jid: '966500000099@s.whatsapp.net', channel: 'whatsapp', stage: 'new', inbox_state: 'in', inbox_since: NOW });
  assert.equal((await s.alerts.notify('LEAD-B', { reason: 'needs_human', ts: s.now() })).ok, 1);
  assert.equal(s.alerts.fundsPending(s.owner.user_id, NOW), true, 'about a second after: still funds');
  s.tick(ALERT_EVERY_MS);
  assert.equal((await s.alerts.notify('LEAD-A', { ts: s.now() })).ok, 1);
  assert.equal(s.alerts.fundsPending(s.owner.user_id, NOW), false, 'a chat push more than 2 min after the alert is what the phone shows now');
  // A later funds alert is newer than that push again.
  s.tick(1000);
  assert.equal(s.alerts.fundsPending(s.owner.user_id, s.now()), true);
});

test('fundsPending: only a chat push that reached one of that member\'s devices counts', async () => {
  // Every send to the owner's device fails (503): the funds alert is still what the phone shows.
  const failing = scene({ answer: (endpoint, n) => (n === 1 ? { status: 201 } : { status: 503 }) });
  failing.sub('owner', 1);
  assert.equal((await failing.alerts.notifyOwners({ reason: 'funds' })).ok, 1);
  failing.tick(ALERT_EVERY_MS + 1000);
  assert.deepEqual(await failing.alerts.notify('LEAD-A', { ts: failing.now() }), { users: 1, devices: 1, ok: 0, gone: 0, failed: 1 });
  assert.equal(failing.alerts.fundsPending(failing.owner.user_id, NOW), true);

  // The owner has no device left for the chat push, while staff got it.
  const s = scene();
  s.sub('owner', 1); s.sub('sara', 2);
  await s.alerts.notifyOwners({ reason: 'funds' });
  s.alerts.unsubscribe({ userId: s.owner.user_id, endpoint: ep(1) });
  s.tick(ALERT_EVERY_MS + 1000);
  assert.deepEqual(await s.alerts.notify('LEAD-A', { reason: 'needs_human', ts: s.now() }), { users: 1, devices: 1, ok: 1, gone: 0, failed: 0 });
  assert.equal(s.alerts.fundsPending(s.owner.user_id, NOW), true, 'nothing new reached the owner');
  // The two-minute marks are unchanged: every member due was marked, delivered or not.
  assert.deepEqual(await s.alerts.notify('LEAD-A', { reason: 'needs_human', ts: s.now() }), { skipped: 'quiet' });
});

test('fundsPending survives a restart: a new alerts instance over the same db has no later pushes to weigh, so the alert still reads as funds', async () => {
  const s = scene();
  s.sub('owner', 1);
  await s.alerts.notifyOwners({ reason: 'funds' });
  await s.alerts.notify('LEAD-A', { reason: 'needs_human', ts: NOW });
  const again = createAlerts({ db: s.db, pusher: null, isExcludedLead: () => false, now: s.now });
  s.tick(60_000);
  assert.equal(again.fundsPending(s.owner.user_id, NOW - 1), true);
  s.team.addUser({ name: 'Second Owner', phone: '966500000003', role: 'owner' });
  s.team.deactivateUser(s.owner.user_id);
  assert.equal(again.fundsPending(s.owner.user_id, NOW - 1), false, 'a deactivated owner: never');
});

test('fundsPending: an older chat batch that completes last never lowers the recorded time', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = scene({ answer: (endpoint, n) => (n === 2 ? gate.then(() => ({ status: 201 })) : { status: 201 }) });
  s.db.insertLead({ lead_id: 'LEAD-B', created: NOW, updated: NOW, phone_e164: '966500000099', wa_jid: '966500000099@s.whatsapp.net', channel: 'whatsapp', stage: 'new', inbox_state: 'in', inbox_since: NOW });
  s.sub('owner', 1);
  assert.equal((await s.alerts.notifyOwners({ reason: 'funds' })).ok, 1);
  s.tick(60_000);
  const older = s.alerts.notify('LEAD-A', { reason: 'needs_human', ts: s.now() }); // within the grace, stalls
  await new Promise((r) => setImmediate(r));
  s.tick(120_000);
  assert.equal((await s.alerts.notify('LEAD-B', { reason: 'needs_human', ts: s.now() })).ok, 1); // past the grace
  assert.equal(s.alerts.fundsPending(s.owner.user_id, NOW), false);
  release();
  assert.equal((await older).ok, 1);
  assert.equal(s.alerts.fundsPending(s.owner.user_id, NOW), false, 'the older batch finishing last does not bring funds back');
});

test('fundsPending: a member is recorded as soon as one of their devices answers 2xx, not when the slowest one does', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = scene({ answer: (endpoint, n) => (endpoint === ep(2) && n > 2 ? gate.then(() => ({ status: 201 })) : { status: 201 }) });
  s.sub('owner', 1); s.sub('owner', 2);
  assert.equal((await s.alerts.notifyOwners({ reason: 'funds' })).ok, 2);
  s.tick(ALERT_EVERY_MS + 1000);
  const p = s.alerts.notify('LEAD-A', { ts: s.now() });
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(s.alerts.fundsPending(s.owner.user_id, NOW), false, 'device 1 answered: the chat push is on that phone');
  release();
  assert.equal((await p).ok, 2);
});
