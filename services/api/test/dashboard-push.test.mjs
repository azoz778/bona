/**
 * Phone alerts through the real HTTP server (2026-09-27 design §5, Phase 3): a member
 * subscribes or unsubscribes their own device behind the same marker and origin check as
 * every other write; a subscription is bound to the login session that posted it, so
 * logging out ends alerts on that device only (P3-5); a tapped alert lands on the newest
 * unread chat (P3-4); the pulse answers what a page was drawn from (P3-12) and applies
 * rule 1 like every inbox read; and the signed-in pages carry the push key and our one
 * script (P3-13). The pusher is a fake that records endpoints and says 201.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.mjs';
import { openDb, tokenHash } from '../lib/db.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';
import { createTeam, isExcludedLead } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createSender } from '../lib/wa-send.mjs';
import { createAlerts } from '../lib/alerts.mjs';

const NOW = 1_790_500_000_000;
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const OWNER_PHONE = '966593296933';
const STAFF_PHONE = '966500000001';
const CLIENT = '966500000077';

/**
 * The inbox harness of dashboard-inbox.test.mjs, with alerts: `createAlerts` over a fake
 * pusher (or none, `{ configured: false }`), handed to `createApp`. Every request WhatsApp
 * would see goes to a fake Evolution that only counts; login codes go to a spy.
 */
async function withPush(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  // `config` and `appOptions` extend what createApp is given (the /health test builds Dana).
  const { configured = true, config = {}, appOptions = {} } = opts;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-push-'));
  const db = openDb(':memory:');
  let clock = NOW;
  const now = () => clock;
  const logs = [];
  const log = (e) => logs.push(e);
  const team = createTeam(db, { now });
  team.setSetting('inbox_replies', '1');
  const inboxStore = createInboxStore(db, { now });

  const evo = { calls: [] };
  const fetchImpl = async (url, init) => {
    evo.calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => JSON.stringify({ key: { id: `KEY-${evo.calls.length}` } }) };
  };
  const sender = createSender({ env: ENV, team, inbox: inboxStore, db, fetchImpl, now, log });

  const spy = { history: [], refresh: [] };
  const backfill = {
    configured: true,
    phoneJidOf: (lead) => (lead?.phone_e164 ? `${lead.phone_e164}@s.whatsapp.net` : null),
    async history(lead, o = {}) { spy.history.push({ leadId: lead?.lead_id ?? null, sinceTs: o.sinceTs, untilTs: o.untilTs }); return { stored: 0, scanned: 0, truncated: false }; },
    async refresh(lead) { spy.refresh.push(lead?.lead_id ?? null); return { stored: 0, scanned: 0, truncated: false }; },
  };

  const pushes = [];
  const fakePusher = { publicKey: 'BPUBLICKEY', send: async (endpoint) => { pushes.push(endpoint); return { status: 201 }; } };
  const alerts = createAlerts({ db, pusher: configured ? fakePusher : null, isExcludedLead: (l) => isExcludedLead(team, db, l), now, log });

  const codes = [];
  const notes = [];
  const app = createApp({
    config: {
      port: 0, host: '127.0.0.1', siteUrl: 'https://bona.azoz.uk', publicApi: 'https://bona-api.azoz.uk',
      dataDir, inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS, toolToken: 'a'.repeat(32),
      retellApiKey: 'test', retellMock: true, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice',
      maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, env: ENV, ids: {}, version: '1.0.0',
      toolRatePerMin: 600, toolAuthFailRatePerMin: 10, allowQueryToken: false, trustedProxies: [],
      maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40, dashCookieDays: 30,
      ...config,
    },
    inventory, db, team, inboxStore, sender, backfill, alerts, now, log,
    ...appOptions,
    probeRetell: async () => 'ok',
    sendWhatsApp: async (text) => { notes.push(text); return { ok: true }; },
    sendCode: async ({ text }) => { codes.push(text); return { ok: true }; },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const go = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const get = (p, { cookie } = {}) => go(p, { headers: cookie ? { Cookie: cookie } : {} });
  /** Every write carries the form marker, as our own pages do. */
  const postForm = (p, fields, { cookie } = {}) => go(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams({ _dash: '1', ...fields }).toString(),
  });
  const cookieOf = (res, name) => {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      if (pair.slice(0, pair.indexOf('=')) === name && !c.includes('Max-Age=0')) return pair.slice(pair.indexOf('=') + 1);
    }
    return null;
  };
  /** The whole login, as a browser does it: ask, read the code off the "phone", type it back. */
  async function login(phone) {
    const before = codes.length;
    const asked = await postForm('/dashboard/login/code', { phone });
    assert.equal(asked.status, 303);
    await app.dashboard.auth.flush();
    assert.equal(codes.length, before + 1, 'one code went out');
    const code = /(\d{6})/.exec(codes.at(-1))[1];
    const verified = await postForm('/dashboard/login/verify', { code }, { cookie: `bona_dash_try=${cookieOf(asked, 'bona_dash_try')}` });
    assert.equal(verified.status, 303);
    return `bona_dash=${cookieOf(verified, 'bona_dash')}`;
  }
  /** A JSON write, marked with the header our own script sends. */
  const postJson = (p, body, { cookie } = {}) => go(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

  const staffUser = team.addUser({ name: 'Sara', phone: STAFF_PHONE, role: 'staff' });
  const owner = team.getUserByPhone(OWNER_PHONE);
  const h = {
    app, db, team, inboxStore, alerts, pushes, base, evo, spy, notes, logs, staffUser, owner, get, postForm, postJson,
    staff: () => login('0500000001'),
    boss: () => login('0593296933'),
    tick: (ms) => { clock += ms; },
  };
  // One `in` chat with one unread client message: what every alert and pulse test starts from.
  seedChat(h, { id: 'LEAD-A', name: 'Alya Client', messages: [{ key_id: 'A-1', text: 'Is BONA-012 still free?', ts: NOW + 60_000 }] });
  try {
    await fn(h);
  } finally {
    await alerts.flush();
    await app.dashboard.auth.flush();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** One lead in whatever inbox state the test needs, with its stored messages (inbound unless said). */
function seedChat(h, { id, name, phone = CLIENT, jid = phone ? `${phone}@s.whatsapp.net` : null, lid = null, state = 'in', messages = [] }) {
  h.db.insertLead({
    lead_id: id, created: NOW - 3_600_000, updated: NOW - 3_600_000, phone_e164: phone, wa_jid: jid, wa_lid: lid, name,
    channel: 'whatsapp', source: 'meta', medium: 'paid', match_method: state === 'in' ? 'ad_meta' : 'keyword',
    stage: 'new', stage_ts: NOW - 3_600_000, first_inbound_ts: NOW - 3_600_000,
    inbox_state: state, inbox_since: state === 'in' ? NOW - 3_600_000 : null,
  });
  for (const m of messages) h.inboxStore.upsertMessage({ lead_id: id, jid: jid ?? lid, direction: 'in', sender_kind: 'client', ...m });
  return id;
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const KEYS = { p256dh: b64u(Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)])), auth: b64u(crypto.randomBytes(16)) };
const EP = 'https://fcm.googleapis.com/fcm/send/phone-1';

test('a signed-in member subscribes their device; the row is bound to this login session', async () => {
  await withPush(async (h) => {
    const cookie = await h.staff();
    const res = await h.postJson('/v1/admin/push/subscribe', { endpoint: EP, keys: KEYS }, { cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const row = h.db.db.prepare('SELECT user_id, session_hash FROM push_subscriptions').get();
    assert.equal(row.user_id, h.staffUser.user_id);
    assert.equal(row.session_hash, tokenHash(cookie.split('=')[1]));
    // app.js re-posts the device on every page load: one log line for a new device, none after.
    assert.deepEqual(await (await h.postJson('/v1/admin/push/subscribe', { endpoint: EP, keys: KEYS }, { cookie })).json(), { ok: true });
    const subscribed = () => h.logs.filter((l) => l.evt === 'push.subscribed').map(({ userId, moved }) => ({ userId, moved }));
    assert.deepEqual(subscribed(), [{ userId: h.staffUser.user_id, moved: false }]);
    assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n, 1);
    // A shared phone signed in as someone else: the device changes hands, and that is logged.
    const boss = await h.boss();
    assert.deepEqual(await (await h.postJson('/v1/admin/push/subscribe', { endpoint: EP, keys: KEYS }, { cookie: boss })).json(), { ok: true });
    assert.deepEqual(subscribed(), [{ userId: h.staffUser.user_id, moved: false }, { userId: h.owner.user_id, moved: true }]);
    assert.equal(h.db.db.prepare('SELECT user_id FROM push_subscriptions').get().user_id, h.owner.user_id);
    assert.doesNotMatch(JSON.stringify(h.logs), /phone-1|fcm\.googleapis/);
  });
});

test('subscribe refuses: signed out 401, no marker 403, foreign origin 403, a bad endpoint or keys 400, no keys configured 503', async () => {
  await withPush(async (h) => {
    const cookie = await h.staff();
    assert.equal((await h.postJson('/v1/admin/push/subscribe', { endpoint: EP, keys: KEYS })).status, 401);
    const noMarker = await fetch(h.base + '/v1/admin/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ endpoint: EP, keys: KEYS }) });
    assert.equal(noMarker.status, 403);
    const foreign = await fetch(h.base + '/v1/admin/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Origin: 'https://evil.example', Cookie: cookie }, body: JSON.stringify({ endpoint: EP, keys: KEYS }) });
    assert.equal(foreign.status, 403);
    const bad = await h.postJson('/v1/admin/push/subscribe', { endpoint: 'https://127.0.0.1/steal', keys: KEYS }, { cookie });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'bad_endpoint' });
    assert.deepEqual(await (await h.postJson('/v1/admin/push/subscribe', { endpoint: EP, keys: { p256dh: 'x', auth: 'y' } }, { cookie })).json(), { error: 'bad_keys' });
    assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n, 0);
  });
  await withPush({ configured: false }, async (h) => {
    const cookie = await h.staff();
    const off = await h.postJson('/v1/admin/push/subscribe', { endpoint: EP, keys: KEYS }, { cookie });
    assert.equal(off.status, 503);
    assert.deepEqual(await off.json(), { error: 'push_off' });
  });
});

test('unsubscribe removes the member\'s own device only', async () => {
  await withPush(async (h) => {
    const staff = await h.staff();
    const boss = await h.boss();
    await h.postJson('/v1/admin/push/subscribe', { endpoint: EP, keys: KEYS }, { cookie: staff });
    assert.deepEqual(await (await h.postJson('/v1/admin/push/unsubscribe', { endpoint: EP }, { cookie: boss })).json(), { ok: true, removed: false });
    assert.deepEqual(await (await h.postJson('/v1/admin/push/unsubscribe', { endpoint: EP }, { cookie: staff })).json(), { ok: true, removed: true });
  });
});

test('logging out ends alerts on this device only (P3-5)', async () => {
  await withPush(async (h) => {
    const phone = await h.staff();
    const laptop = await h.staff();
    await h.postJson('/v1/admin/push/subscribe', { endpoint: EP, keys: KEYS }, { cookie: phone });
    await h.postJson('/v1/admin/push/subscribe', { endpoint: 'https://web.push.apple.com/laptop', keys: KEYS }, { cookie: laptop });
    const out = await h.postForm('/dashboard/logout', {}, { cookie: laptop });
    assert.equal(out.status, 303);
    assert.deepEqual(h.db.db.prepare('SELECT endpoint FROM push_subscriptions').all().map((r) => r.endpoint), [EP]);
  });
});

test('a signed-in page carries the push key and our script; the inbox list and a thread carry their pulse tokens', async () => {
  await withPush(async (h) => {
    const cookie = await h.staff();
    const list = await (await h.get('/dashboard/inbox', { cookie })).text();
    assert.match(list, /<meta name="bona-push-key" content="BPUBLICKEY">/);
    assert.match(list, /<script src="\/dashboard\/app\.js" defer><\/script>/);
    assert.match(list, /data-pulse="\/v1\/admin\/inbox\/pulse" data-pulse-token="1:1:\d+"/);
    const drawn = /data-pulse-token="([^"]+)"/.exec(list)[1];
    assert.deepEqual(await (await h.get('/v1/admin/inbox/pulse', { cookie })).json(), { token: drawn }, 'the list pulse answers what the page was drawn from');
    const thread = await (await h.get('/dashboard/inbox/LEAD-A', { cookie })).text();
    const rev = h.inboxStore.revision('LEAD-A');
    assert.match(thread, new RegExp(`data-pulse="/v1/admin/inbox/pulse\\?lead=LEAD-A" data-pulse-token="${rev}"`));
  });
});

test('the pulse answers the same token the page was drawn with, and a new one after a client message', async () => {
  await withPush(async (h) => {
    const cookie = await h.staff();
    const page = await (await h.get('/dashboard/inbox/LEAD-A', { cookie })).text();
    const drawn = /data-pulse-token="(\d+)"/.exec(page)[1];
    const first = await h.get('/v1/admin/inbox/pulse?lead=LEAD-A', { cookie });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-security-policy'), "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'");
    assert.deepEqual(await first.json(), { token: drawn });
    h.inboxStore.upsertMessage({ key_id: 'A-2', lead_id: 'LEAD-A', jid: '966500000077@s.whatsapp.net', direction: 'in', sender_kind: 'client', text: 'hello?', ts: NOW + 120_000 });
    assert.notDeepEqual(await (await h.get('/v1/admin/inbox/pulse?lead=LEAD-A', { cookie })).json(), { token: drawn });
    const list1 = (await (await h.get('/v1/admin/inbox/pulse', { cookie })).json()).token;
    h.inboxStore.upsertMessage({ key_id: 'A-3', lead_id: 'LEAD-A', jid: '966500000077@s.whatsapp.net', direction: 'in', sender_kind: 'client', text: 'hi again', ts: NOW + 180_000 });
    assert.notEqual((await (await h.get('/v1/admin/inbox/pulse', { cookie })).json()).token, list1);
  });
});

test('the pulse of a chat the member may not read is 404, like every inbox read (rule 1)', async () => {
  await withPush(async (h) => {
    const cookie = await h.staff();
    // A chat that is not in the inbox, one that does not exist, and an `in` chat under a
    // colleague's number: the same answer for all three, so the pulse tells nobody apart.
    h.db.db.prepare("UPDATE leads SET inbox_state = 'unsure' WHERE lead_id = 'LEAD-A'").run();
    seedChat(h, { id: 'LEAD-T', name: 'Tariq Team', phone: STAFF_PHONE, messages: [{ key_id: 'T-1', text: 'team words', ts: NOW + 30_000 }] });
    for (const leadId of ['LEAD-A', 'NOPE', 'LEAD-T']) {
      const res = await h.get(`/v1/admin/inbox/pulse?lead=${leadId}`, { cookie });
      assert.equal(res.status, 404, leadId);
      assert.deepEqual(await res.json(), { error: 'not_in_inbox' }, leadId);
    }
    assert.equal((await h.get('/v1/admin/inbox/pulse?lead=../../x', { cookie })).status, 404);
    assert.equal((await h.get('/v1/admin/inbox/pulse')).status, 401, 'signed out');
  });
});

test('a tap on an alert opens the newest unread chat, else the newest chat, else the inbox; signed out, the login', async () => {
  await withPush(async (h) => {
    const cookie = await h.staff();
    // An older chat that is unread sorts first; a newer one that is read does not win.
    seedChat(h, { id: 'LEAD-B', name: 'Badr Client', phone: '966500000078', messages: [{ key_id: 'B-1', text: 'BONA-020?', ts: NOW + 90_000 }] });
    await h.get('/dashboard/inbox/LEAD-B', { cookie }); // reading it marks it read
    const open = await h.get('/dashboard/push/open', { cookie });
    assert.equal(open.status, 302);
    assert.equal(open.headers.get('location'), '/dashboard/inbox/LEAD-A', 'the unread chat, not the newest');
    await h.get('/dashboard/inbox/LEAD-A', { cookie });
    const read = await h.get('/dashboard/push/open', { cookie });
    assert.equal(read.headers.get('location'), '/dashboard/inbox/LEAD-B', 'nothing unread (a colleague got there first): the newest chat');
    h.db.db.prepare("UPDATE leads SET inbox_state = 'unsure' WHERE lead_id IN ('LEAD-A', 'LEAD-B')").run();
    const none = await h.get('/dashboard/push/open', { cookie });
    assert.equal(none.headers.get('location'), '/dashboard/inbox', 'no chat the member may see: the list');
    const out = await h.get('/dashboard/push/open');
    assert.equal(out.status, 302);
    assert.match(out.headers.get('location'), /^\/dashboard\/login/);
  });
});

const JSON_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'";
/** An owner's device: subscribed under the login it posted from, so a check alert finds it. */
async function subscribedBoss(h) {
  const cookie = await h.boss();
  assert.equal((await h.postJson('/v1/admin/push/subscribe', { endpoint: EP, keys: KEYS }, { cookie })).status, 200);
  return cookie;
}
const latest = async (h, cookie) => (await (await h.get('/dashboard/push/latest', { cookie })).json()).kind;
const openTo = async (h, cookie) => (await h.get('/dashboard/push/open', { cookie })).headers.get('location');

test('push/latest: signed out 401 JSON (the worker asks, not a browser); a member with no check gets inbound, locked and no-store (U3)', async () => {
  await withPush(async (h) => {
    const out = await h.get('/dashboard/push/latest');
    assert.equal(out.status, 401, 'not the login redirect');
    assert.deepEqual(await out.json(), { error: 'unauthorised' });
    const cookie = await h.staff();
    const res = await h.get('/dashboard/push/latest', { cookie });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(res.headers.get('content-security-policy'), JSON_CSP);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await res.json(), { kind: 'inbound' });
  });
});

test('a check newer than the owner\'s unread messages: push/latest says check and the tap opens it first on the Unsure page; staff land as before (U3, U4)', async () => {
  await withPush(async (h) => {
    const boss = await subscribedBoss(h);
    const staff = await h.staff();
    seedChat(h, { id: 'LEAD-U', name: 'Umar Unsure', phone: '966500000078', state: 'unsure' });
    // The check comes after Alya's unread message (NOW + 60 s).
    h.tick(120_000);
    const sent = await h.alerts.notify('LEAD-U', { reason: 'check', ts: NOW + 120_000 });
    assert.equal(sent.ok, 1, 'the owner\'s device was pushed');
    assert.equal(await latest(h, boss), 'check');
    const open = await h.get('/dashboard/push/open', { cookie: boss });
    assert.equal(open.status, 302);
    assert.equal(open.headers.get('location'), '/dashboard/inbox?tab=unsure&focus=LEAD-U');
    assert.equal(await latest(h, staff), 'inbound', 'a check is the owners\' only');
    assert.equal(await openTo(h, staff), '/dashboard/inbox/LEAD-A', 'staff land on the newest unread chat, as before');

    // (c) A client message newer than the check, unread: the inbox wins again.
    h.tick(60_000);
    h.inboxStore.upsertMessage({ key_id: 'A-2', lead_id: 'LEAD-A', jid: `${CLIENT}@s.whatsapp.net`, direction: 'in', sender_kind: 'client', text: 'still there?', ts: NOW + 180_000 });
    assert.equal(await latest(h, boss), 'inbound');
    assert.equal(await openTo(h, boss), '/dashboard/inbox/LEAD-A');
    // Read it: the check is the newest thing again.
    await h.get('/dashboard/inbox/LEAD-A', { cookie: boss });
    assert.equal(await latest(h, boss), 'check');

    // (d) The chat leaves the Unsure list: the check is forgotten.
    h.db.updateLead('LEAD-U', { inbox_state: 'in', inbox_since: NOW + 180_000 });
    assert.equal(await latest(h, boss), 'inbound');
    assert.equal(h.alerts.pendingCheck(h.owner.user_id), null);
    assert.notEqual(await openTo(h, boss), '/dashboard/inbox?tab=unsure&focus=LEAD-U');
  });
});

test('a check is ranked by its message, not by when it was sent: an older message than an unread inbox one is inbound (U3, U4)', async () => {
  await withPush(async (h) => {
    const boss = await subscribedBoss(h);
    seedChat(h, { id: 'LEAD-U', name: 'Umar Unsure', phone: '966500000078', state: 'unsure' });
    // The check is SENT after Alya's unread message (NOW + 60 s), but its message came before it.
    h.tick(120_000);
    assert.equal((await h.alerts.notify('LEAD-U', { reason: 'check', ts: NOW + 30_000 })).ok, 1);
    assert.deepEqual(h.alerts.pendingCheck(h.owner.user_id), { leadId: 'LEAD-U', ts: NOW + 120_000, msgTs: NOW + 30_000 });
    assert.equal(await latest(h, boss), 'inbound');
    assert.equal(await openTo(h, boss), '/dashboard/inbox/LEAD-A');
    // Read Alya: nothing unread is newer, so the check leads again.
    await h.get('/dashboard/inbox/LEAD-A', { cookie: boss });
    assert.equal(await latest(h, boss), 'check');
  });
});

test('/health says whether alerts are configured, and nothing more about them', async () => {
  await withPush(async (h) => {
    const health = await (await fetch(h.base + '/health')).json();
    assert.deepEqual(health.push, { configured: true });
    assert.deepEqual(health.dana, { configured: false, enabled: false, fundsOut: false }, 'no WhatsApp agent id here: Dana is not configured, and she ships off');
  });
  await withPush({ configured: false }, async (h) => {
    assert.deepEqual((await (await fetch(h.base + '/health')).json()).push, { configured: false });
  });
  await withPush({ config: { waChatAgentId: 'agent_wa' }, appOptions: { danaOnMock: true } }, async (h) => {
    assert.deepEqual((await (await fetch(h.base + '/health')).json()).dana, { configured: true, enabled: false, fundsOut: false }, 'provisioned, still off');
  });
});

/* ---------------- Retell out of credit (2026-10-05 design R2) ---------------- */

const outOfCredit = (h, at = NOW) => h.team.setSetting('retell_funds_out', String(at));

test('funds: push/latest says funds to an owner pushed within the hour while the flag is set, above a check; the tap opens the Team page', async () => {
  await withPush(async (h) => {
    const boss = await subscribedBoss(h);
    const staff = await h.staff();
    assert.equal((await h.postJson('/v1/admin/push/subscribe', { endpoint: `${EP}-staff`, keys: KEYS }, { cookie: staff })).status, 200);
    // A pending check newer than the unread inbox message: on its own, it would be a check.
    seedChat(h, { id: 'LEAD-U', name: 'Umar Unsure', phone: '966500000078', state: 'unsure' });
    h.tick(120_000);
    assert.equal((await h.alerts.notify('LEAD-U', { reason: 'check', ts: NOW + 120_000 })).ok, 1);
    assert.equal(await latest(h, boss), 'check');

    outOfCredit(h, NOW + 120_000);
    assert.equal(await latest(h, boss), 'check', 'flagged, but this owner was not pushed about it: not funds');
    const before = h.pushes.length;
    const sent = await h.alerts.notifyOwners({ reason: 'funds' });
    assert.deepEqual(sent, { users: 1, devices: 1, ok: 1, gone: 0, failed: 0 });
    assert.deepEqual(h.pushes.slice(before), [EP], "the owner's device only, never staff's");
    assert.equal(await latest(h, boss), 'funds', 'funds > check');
    assert.equal(await openTo(h, boss), '/dashboard/team');
    assert.equal(await latest(h, staff), 'inbound', 'staff never get the funds kind');
    assert.equal(await openTo(h, staff), '/dashboard/inbox/LEAD-A');

    // The push's TTL is an hour: a push older than that is no longer what the worker is showing.
    h.tick(3_600_000);
    assert.equal(await latest(h, boss), 'funds', 'exactly an hour: still funds');
    h.tick(1);
    assert.notEqual(await latest(h, boss), 'funds');
    assert.notEqual(await openTo(h, boss), '/dashboard/team');
  });
});

test('funds: a cleared flag is not funds, even right after the push', async () => {
  await withPush(async (h) => {
    const boss = await subscribedBoss(h);
    outOfCredit(h);
    await h.alerts.notifyOwners({ reason: 'funds' });
    assert.equal(await latest(h, boss), 'funds');
    h.team.setSetting('retell_funds_out', '');
    assert.equal(await latest(h, boss), 'inbound');
    assert.equal(await openTo(h, boss), '/dashboard/inbox/LEAD-A');
  });
});

test('funds: the Team page carries the red banner only while the flag is set; /health says fundsOut', async () => {
  await withPush(async (h) => {
    const boss = await h.boss();
    const page = async () => (await h.get('/dashboard/team', { cookie: boss })).text();
    assert.doesNotMatch(await page(), /Retell credit ran out/);
    assert.equal((await (await fetch(h.base + '/health')).json()).dana.fundsOut, false);
    outOfCredit(h, Date.UTC(2026, 9, 3, 9, 30));
    assert.match(await page(), /<div class="err">Dana can’t answer: Retell credit ran out at 2026-10-03 12:30 Riyadh time\./);
    assert.equal((await (await fetch(h.base + '/health')).json()).dana.fundsOut, true);
    h.team.setSetting('retell_funds_out', '');
    assert.doesNotMatch(await page(), /Retell credit ran out/);
    assert.equal((await (await fetch(h.base + '/health')).json()).dana.fundsOut, false);
  });
});

test('funds: the app wires the watch into Dana — a 402 from Retell flags the owners and pushes them once', async () => {
  const refuse = { async createChat() { const e = new Error('Retell POST -> 402'); e.status = 402; throw e; }, async createChatCompletion() { throw new Error('unused'); } };
  await withPush({ config: { waChatAgentId: 'agent_wa' }, appOptions: { danaOnMock: true, retell: refuse } }, async (h) => {
    await subscribedBoss(h);
    assert.ok(h.app.funds, 'the app exposes the watch');
    h.team.setSetting('dana_enabled', '1');
    assert.deepEqual(await h.app.dana.answer('LEAD-A', { ts: NOW + 60_000 }), { handover: 'retell_error', sent: true }, 'the client still gets the hand-over');
    await h.alerts.flush();
    assert.equal(h.team.getSetting('retell_funds_out'), String(NOW));
    assert.equal(h.team.getSetting('retell_funds_alerted'), String(NOW));
    const sent = (reason) => h.logs.filter((l) => l.evt === 'push.sent' && l.reason === reason);
    assert.equal(sent('funds').length, 1, 'one owner alert about the credit');
    assert.equal(sent('needs_human').length, 1, 'and the hand-over alert as before');
    assert.equal((await (await fetch(h.base + '/health')).json()).dana.fundsOut, true);
    assert.ok(h.logs.some((l) => l.evt === 'dana.funds_out'));
  });
});
