/**
 * The Bona inbox through the real HTTP server (2026-09-27 design §4, and the hostile list
 * in §8): who may read a chat, who may answer it, and that an answer goes out exactly
 * once — through the one real sender, over a fake Evolution that counts every request.
 * The backfill is a spy: it records what it is asked for and, when a test says so,
 * "finds" a message that arrived while the page was open. Login codes go to a spy of
 * their own, so the only requests the fake Evolution ever sees are replies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createApp } from '../index.mjs';
import { openDb } from '../lib/db.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';
import { createTeam } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { OWNER_HISTORY_MS } from '../lib/inbox/backfill.mjs';
import { createSender } from '../lib/wa-send.mjs';
import { REPLY_MAX_BODY_BYTES, REPLY_DRAIN_MAX_BYTES } from '../lib/dashboard/routes.mjs';

const NOW = 1_790_500_000_000;
const CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'";
/** An HTML page's CSP (P3-1): the same, plus our own script, worker, fetches and manifest — nothing inline. */
const PAGE_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'";
const OWN_SCRIPT = '<script src="/dashboard/app.js" defer></script>';
/** The one script a signed-in page may carry is our own app.js; nothing else, nothing inline. */
const onlyOurScript = (html) => !/<script/i.test(html.split(OWN_SCRIPT).join(''));
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const OWNER_PHONE = '966593296933';
const STAFF_PHONE = '966500000001';
const CLIENT = '966500000077';

/** The inbox opens nothing beyond ourselves in the CSP: same four headers as every dashboard answer. */
function assertLocked(res) {
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = String(res.headers.get('content-type') ?? '').startsWith('text/html');
  assert.equal(res.headers.get('content-security-policy'), html ? PAGE_CSP : CSP);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
}

/** The value of a named form field on a page, whatever order the input's attributes come in. */
function fieldOf(html, name) {
  const tag = new RegExp(`<input[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0];
  return tag ? (/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? null) : null;
}

async function withInbox(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-inbox-'));
  const db = openDb(':memory:');
  let clock = NOW;
  const now = () => clock;
  const logs = [];
  const log = (e) => logs.push(e);
  // The team's clock is pinned too: `users.created` is where a person's unread count
  // starts (P2-8), and every seeded message below is newer than it.
  const team = createTeam(db, { now });
  // Dashboard replies ship switched off (design D14). These tests are about what a reply
  // does once the owner has turned them on; the switch itself has its own test.
  team.setSetting('inbox_replies', '1');
  const inboxStore = createInboxStore(db, { now });

  // Evolution's sendText, faked. Every request is counted; `evo.reply` decides the answer
  // ('timeout' throws the AbortError a real timeout produces); `evo.hold()` parks the
  // next request at WhatsApp until the test releases it — the double-click race.
  const evo = { calls: [], reply: (n) => ({ status: 201, body: { key: { id: `KEY-${n}` } } }), gate: null };
  evo.hold = () => {
    let release;
    let entered;
    const released = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    evo.gate = { released, entered };
    return { reached, release };
  };
  const fetchImpl = async (url, init) => {
    evo.calls.push({ url, body: JSON.parse(init.body) });
    const gate = evo.gate;
    if (gate) {
      evo.gate = null;
      gate.entered();
      await gate.released;
    }
    const r = evo.reply(evo.calls.length);
    if (r === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  const sender = createSender({ env: ENV, team, inbox: inboxStore, db, fetchImpl, now, log });

  const spy = { history: [], refresh: [], onRefresh: null };
  const backfill = {
    configured: true,
    phoneJidOf: (lead) => (lead?.phone_e164 ? `${lead.phone_e164}@s.whatsapp.net` : null),
    async history(lead, opts = {}) {
      spy.history.push({ leadId: lead?.lead_id ?? null, sinceTs: opts.sinceTs, untilTs: opts.untilTs });
      return { stored: 0, scanned: 0, truncated: false };
    },
    async refresh(lead) {
      spy.refresh.push(lead?.lead_id ?? null);
      spy.onRefresh?.(lead);
      return { stored: 0, scanned: 0, truncated: false };
    },
  };

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
    },
    inventory, db, team, inboxStore, sender, backfill, now, log,
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

  /** A JSON write, marked with the header our own scripts would send. */
  const postJson = (p, body, { cookie } = {}) => go(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

  const staffUser = team.addUser({ name: 'Sara', phone: STAFF_PHONE, role: 'staff' });
  const owner = team.getUserByPhone(OWNER_PHONE);
  try {
    await fn({
      app, db, team, inboxStore, evo, spy, notes, logs, staffUser, owner, get, postForm, postJson,
      staff: () => login('0500000001'),
      boss: () => login('0593296933'),
      tick: (ms) => { clock += ms; },
    });
  } finally {
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

/**
 * The cast most tests share: a client in the inbox, a lid-only client in the inbox, and
 * one of every chat that must never be shown — a guess (unsure), a "not a client" (out),
 * a never-list number and a team member's number (both still marked `in`, as a lead can
 * be when its number was listed after it joined), and a form lead with no chat at all.
 */
function seedScene(h) {
  seedChat(h, { id: 'LEAD-A', name: 'Alya Client', messages: [{ key_id: 'A-1', text: 'Is BONA-012 still free?', ts: NOW + 60_000 }] });
  seedChat(h, { id: 'LEAD-L', name: 'Layla Lid', phone: null, lid: '123456789012345@lid', messages: [{ key_id: 'L-1', text: 'hello from a lid chat', ts: NOW + 50_000 }] });
  seedChat(h, { id: 'LEAD-U', name: 'Umar Unsure', phone: '966500000078', state: 'unsure' });
  seedChat(h, { id: 'LEAD-O', name: 'Omar Out', phone: '966500000079', state: 'out' });
  seedChat(h, { id: 'LEAD-N', name: 'Nadia Never', phone: '966500000080', messages: [{ key_id: 'N-1', text: 'never words', ts: NOW + 40_000 }] });
  h.team.addNever({ phone: '966500000080', note: 'family' });
  seedChat(h, { id: 'LEAD-T', name: 'Tariq Team', phone: STAFF_PHONE, messages: [{ key_id: 'T-1', text: 'team words', ts: NOW + 30_000 }] });
  seedChat(h, { id: 'LEAD-F', name: 'Farah Form', phone: '966500000081', jid: null });
}

const replyTo = (h, leadId, fields, cookie) => h.postForm(`/v1/admin/inbox/${leadId}/reply`, fields, { cookie });
/**
 * A form POST over a bare socket that says its body is `claimed` bytes long and sends only
 * `body`, then waits for the server to close the connection. fetch cannot stop part-way
 * through a body it has been handed, and the point is a body the server stops reading.
 */
function partialPost(h, p, { cookie, claimed, body }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(h.app.server.address().port, '127.0.0.1');
    const got = [];
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('the server kept the connection open')); });
    socket.on('data', (chunk) => got.push(chunk));
    socket.on('error', reject);
    // `end`: the server closed its side, having sent everything it was going to.
    socket.on('end', () => {
      socket.end();
      const all = Buffer.concat(got).toString('utf8');
      const cut = all.indexOf('\r\n\r\n');
      const [statusLine, ...lines] = all.slice(0, cut).split('\r\n');
      const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      resolve({ status: Number(statusLine.split(' ')[1]), headers, text: all.slice(cut + 4) });
    });
    socket.write([
      `POST ${p} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: keep-alive',
      'Content-Type: application/x-www-form-urlencoded', `Content-Length: ${claimed}`, `Cookie: ${cookie}`, '', '',
    ].join('\r\n'));
    socket.write(body);
  });
}
/** The chat's revision now, as a form carries it: what a page drawn at this moment would say it saw. */
const revOf = (h, leadId) => String(h.inboxStore.revision(leadId));

/* ---------------- who sees what ---------------- */

test('the inbox lists only chats that are in, to everyone; the Unsure list is the owner\'s alone', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    // A guess whose number went on the never list after it arrived: on no list, in no count.
    seedChat(h, { id: 'LEAD-NU', name: 'Noor Never Guess', phone: '966500000082', state: 'unsure' });
    h.team.addNever({ phone: '966500000082' });
    const staff = await h.staff();
    const boss = await h.boss();
    for (const cookie of [staff, boss]) {
      const res = await h.get('/dashboard/inbox', { cookie });
      assert.equal(res.status, 200);
      assertLocked(res);
      const html = await res.text();
      assert.ok(onlyOurScript(html), 'no script but our own app.js');
      assert.equal(html.split(OWN_SCRIPT).length, 2, 'exactly one script tag, ours');
      for (const name of ['Alya Client', 'Layla Lid']) assert.ok(html.includes(name), name);
      for (const hidden of ['Umar Unsure', 'Omar Out', 'Nadia Never', 'Tariq Team', 'Farah Form', 'Noor Never Guess', 'never words', 'team words']) {
        assert.ok(!html.includes(hidden), hidden);
      }
      // The badge counts what the list shows: Alya's and Layla's messages, never the
      // never-list or the colleague's chat still marked `in`.
      assert.match(html, /Inbox<span class="c">2<\/span>/);
    }
    const tabs = await (await h.get('/dashboard/inbox', { cookie: boss })).text();
    assert.match(tabs, /Unsure · 1<\/a>/, 'Umar alone: the never-list guess is not counted either');
    const denied = await h.get('/dashboard/inbox?tab=unsure', { cookie: staff });
    assert.equal(denied.status, 403);
    assertLocked(denied);
    assert.ok(!(await denied.text()).includes('Umar Unsure'));
    const unsure = await h.get('/dashboard/inbox?tab=unsure', { cookie: boss });
    assert.equal(unsure.status, 200);
    assertLocked(unsure);
    const list = await unsure.text();
    assert.ok(list.includes('Umar Unsure'));
    assert.ok(!list.includes('Alya Client'), 'the Unsure list is the guesses only');
    assert.ok(!list.includes('Noor Never Guess'));
  });
});

/**
 * seedScene plus an undecided lead (no inbox state yet), and the first-message snippets
 * the lead_created touchpoints keep: the one a staff member must never read, and one they may.
 */
function seedLeadsScene(h) {
  seedScene(h);
  seedChat(h, { id: 'LEAD-X', name: 'Xena Undecided', phone: '966500000083', state: null });
  h.db.addTouchpoint({ lead_id: 'LEAD-U', ts: NOW - 3_600_000, channel: 'whatsapp', event_type: 'lead_created', meta: { snippet: 'umar secret words' } });
  h.db.addTouchpoint({ lead_id: 'LEAD-A', ts: NOW - 3_600_000, channel: 'whatsapp', event_type: 'lead_created', meta: { snippet: 'alya first words' } });
}
/** Staff see the leads that are in the Bona inbox (a chat or not yet), and nothing else. */
const STAFF_SEES = { 'LEAD-A': 'Alya Client', 'LEAD-L': 'Layla Lid', 'LEAD-F': 'Farah Form' };
/** Unsure, out, undecided, and `in` under a never-list or a colleague's number. */
const STAFF_NEVER = { 'LEAD-U': 'Umar Unsure', 'LEAD-O': 'Omar Out', 'LEAD-X': 'Xena Undecided', 'LEAD-N': 'Nadia Never', 'LEAD-T': 'Tariq Team' };

test('staff see only Bona-inbox leads on the Leads board and list, and on the Desk; the owner sees every lead', async () => {
  await withInbox(async (h) => {
    seedLeadsScene(h);
    const staff = await h.staff();
    const boss = await h.boss();
    for (const p of ['/dashboard/leads', '/dashboard/leads?stage=new', '/dashboard/leads?q=a']) {
      const html = await (await h.get(p, { cookie: staff })).text();
      for (const [id, name] of Object.entries(STAFF_SEES)) assert.ok(html.includes(name) && html.includes(id), `${p}: ${name}`);
      for (const [id, name] of Object.entries(STAFF_NEVER)) assert.ok(!html.includes(name) && !html.includes(id), `${p}: ${name}`);
      assert.ok(!html.includes('umar secret words'), p);
    }
    // The list's own count is what staff may see; the stage counts are the pipeline's
    // aggregate and stay as they are.
    assert.match(await (await h.get('/dashboard/leads', { cookie: staff })).text(), /3 leads\. 3 are waiting on your first reply\./);
    const all = await (await h.get('/dashboard/leads', { cookie: boss })).text();
    for (const name of [...Object.values(STAFF_SEES), ...Object.values(STAFF_NEVER)]) assert.ok(all.includes(name), name);
    assert.match(all, /8 leads\. 8 are waiting on your first reply\./);

    // The Desk: the waiting queue and its count.
    const desk = await (await h.get('/dashboard', { cookie: staff })).text();
    assert.match(desk, /Waiting on you<\/u><b class="alert"><span class="n">3<\/span>/);
    for (const name of Object.values(STAFF_NEVER)) assert.ok(!desk.includes(name), `Desk: ${name}`);
    assert.match(await (await h.get('/dashboard', { cookie: boss })).text(), /Waiting on you<\/u><b class="alert"><span class="n">8<\/span>/);
  });
});

test('staff counts and lists read past the first 500 in-inbox leads: a count is a count, never a slice', async () => {
  // staffRows reads `in` leads 500 at a time until a short page; with 513 a count that
  // stopped after one page would say 500 (or fewer once the exclusion test ran).
  await withInbox(async (h) => {
    seedLeadsScene(h);
    const extra = 510;
    for (let i = 0; i < extra; i += 1) {
      seedChat(h, { id: `LEAD-P${String(i).padStart(3, '0')}`, name: `Page Client ${i}`, phone: `9665100${String(i).padStart(5, '0')}` });
    }
    const seen = Object.keys(STAFF_SEES).length + extra;
    const staff = await h.staff();

    // The Leads page's total (its "waiting" figure is of the 200 rows it lists, for everyone).
    const html = await (await h.get('/dashboard/leads', { cookie: staff })).text();
    assert.match(html, new RegExp(`>${seen} leads\\. `));
    const desk = await (await h.get('/dashboard', { cookie: staff })).text();
    assert.match(desk, new RegExp(`Waiting on you</u><b class="alert"><span class="n">${seen}</span>`));

    const list = await (await h.get('/v1/admin/leads?limit=500', { cookie: staff })).json();
    assert.equal(list.count, 500, 'the list is capped by limit');
    assert.equal(list.total, seen, 'the total is every lead staff may see');
    const staged = await (await h.get('/v1/admin/leads?stage=new&q=Client&limit=500', { cookie: staff })).json();
    assert.equal(staged.total, seen, 'the total counts by stage alone');
    assert.equal(staged.count, 500);
    // Every lead is reachable: none of the ones past the first page is lost to a slice.
    const ids = new Set();
    for (let d = 0; d < 10; d += 1) {
      const found = await (await h.get(`/v1/admin/leads?q=${encodeURIComponent(`Page Client ${d}`)}&limit=500`, { cookie: staff })).json();
      for (const l of found.leads) ids.add(l.lead_id);
    }
    assert.equal(ids.size, extra, 'all 510 page clients, each found by a search');
    for (const id of Object.keys(STAFF_NEVER)) assert.ok(!ids.has(id), id);
  });
});

test('staff cannot open, read over JSON, move or note a lead outside the Bona inbox: it answers as one that does not exist', async () => {
  await withInbox(async (h) => {
    seedLeadsScene(h);
    const staff = await h.staff();
    const boss = await h.boss();
    const nope = await (await h.get('/dashboard/leads/LEAD-nope', { cookie: staff })).text();
    for (const id of Object.keys(STAFF_NEVER)) {
      const page = await h.get(`/dashboard/leads/${id}`, { cookie: staff });
      assert.equal(page.status, 404, id);
      assertLocked(page);
      assert.equal(await page.text(), nope, `${id}: the same page as a lead that does not exist`);
      const json = await h.get(`/v1/admin/leads/${id}`, { cookie: staff });
      assert.equal(json.status, 404, id);
      assert.deepEqual(await json.json(), { error: 'not_found' }, id);
      assert.equal((await h.get(`/dashboard/leads/${id}`, { cookie: boss })).status, 200, `${id}: the owner still opens it`);

      const stage = await h.postJson(`/v1/admin/leads/${id}/stage`, { stage: 'contacted' }, { cookie: staff });
      assert.equal(stage.status, 404, id);
      assert.deepEqual(await stage.json(), { error: 'not_found' }, id);
      const note = await h.postJson(`/v1/admin/leads/${id}/note`, { note: 'called' }, { cookie: staff });
      assert.equal(note.status, 404, id);
      assert.deepEqual(await note.json(), { error: 'not_found' }, id);
      // A form answers as it does for a lead that does not exist: back to the list.
      const form = await h.postForm(`/v1/admin/leads/${id}/stage`, { stage: 'contacted' }, { cookie: staff });
      assert.equal(form.status, 303, id);
      assert.equal(form.headers.get('location'), '/dashboard/leads', id);
      assert.equal(h.db.getLead(id).stage, 'new', `${id}: not moved`);
      assert.ok(!h.db.touchpointsForLead(id).some((tp) => tp.event_type === 'note'), `${id}: no note`);
    }
    assert.ok(!h.app.audit.recent(50).some((r) => r.action === 'stage' || r.action === 'note'), 'nothing to audit');

    // The JSON list, and a lead staff may see, whose touchpoints they may read.
    const list = await (await h.get('/v1/admin/leads', { cookie: staff })).json();
    assert.deepEqual(list.leads.map((l) => l.lead_id).sort(), Object.keys(STAFF_SEES).sort());
    assert.equal(list.count, 3);
    assert.equal(list.total, 3);
    const staged = await (await h.get('/v1/admin/leads?stage=new', { cookie: staff })).json();
    assert.equal(staged.total, 3);
    assert.ok(!JSON.stringify(list).includes('umar secret words'));
    const alya = await h.get('/v1/admin/leads/LEAD-A', { cookie: staff });
    assert.equal(alya.status, 200);
    assert.ok(JSON.stringify(await alya.json()).includes('alya first words'));
    assert.equal((await h.postJson('/v1/admin/leads/LEAD-A/stage', { stage: 'contacted' }, { cookie: staff })).status, 200);
    assert.equal((await h.postJson('/v1/admin/leads/LEAD-A/note', { note: 'called' }, { cookie: staff })).status, 200);

    // The owner reads and moves every lead, as before, snippet included.
    const everyone = await (await h.get('/v1/admin/leads', { cookie: boss })).json();
    assert.equal(everyone.count, 8);
    assert.equal(everyone.total, 8);
    const umar = await h.get('/v1/admin/leads/LEAD-U', { cookie: boss });
    assert.equal(umar.status, 200);
    assert.ok(JSON.stringify(await umar.json()).includes('umar secret words'));
    assert.equal((await h.postJson('/v1/admin/leads/LEAD-U/stage', { stage: 'contacted' }, { cookie: boss })).status, 200);
    assert.equal((await h.postJson('/v1/admin/leads/LEAD-U/note', { note: 'called' }, { cookie: boss })).status, 200);
    assert.equal(h.db.getLead('LEAD-U').stage, 'contacted');
  });
});

test('a chat that is not in the inbox cannot be opened or answered, and nothing goes out', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const boss = await h.boss();
    // The control: the one chat that IS in opens, so every 404 below is a refusal, not a missing route.
    assert.equal((await h.get('/dashboard/inbox/LEAD-A', { cookie: staff })).status, 200);
    for (const id of ['LEAD-U', 'LEAD-O', 'LEAD-N', 'LEAD-T', 'LEAD-F', 'LEAD-nope']) {
      for (const cookie of [staff, boss]) {
        const page = await h.get(`/dashboard/inbox/${id}`, { cookie });
        assert.equal(page.status, 404, id);
        assertLocked(page);
        const html = await page.text();
        assert.ok(!html.includes('never words') && !html.includes('team words'), id);
      }
      const reply = await replyTo(h, id, { text: 'hello there', send_id: `send-${id}-000000000000`, seen_rev: revOf(h, id) }, staff);
      assert.equal(reply.status, 404, id);
    }
    assert.equal(h.evo.calls.length, 0, 'not one request reached WhatsApp');
    assert.equal(h.db.db.prepare('SELECT COUNT(*) AS n FROM wa_outbox').get().n, 0);
    assert.deepEqual(h.spy.refresh, ['LEAD-A'], 'a refused chat does not even cost an Evolution read');
  });
});

test('a lid-only chat opens but has no reply box, and a reply to it is refused unsent', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const page = await h.get('/dashboard/inbox/LEAD-L', { cookie: staff });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('hello from a lid chat'));
    assert.doesNotMatch(html, /action="\/v1\/admin\/inbox\/LEAD-L\/reply"/, 'WhatsApp gave no number to send to');
    const reply = await replyTo(h, 'LEAD-L', { text: 'hi', send_id: 'send-lid-0000000000001', seen_rev: revOf(h, 'LEAD-L') }, staff);
    assert.equal(reply.status, 409);
    assertLocked(reply);
    assert.equal(h.evo.calls.length, 0);
    assert.equal(h.inboxStore.getOutbox('send-lid-0000000000001'), null);
  });
});

/* ---------------- replying ---------------- */

test('a reply goes out once from the owner\'s number: 303 ok=sent, in the thread, handler set, audited without the words', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const page = await h.get('/dashboard/inbox/LEAD-A', { cookie: staff });
    assert.equal(page.status, 200);
    assertLocked(page);
    const html = await page.text();
    assert.ok(html.includes('Is BONA-012 still free?'));
    assert.match(html, /action="\/v1\/admin\/inbox\/LEAD-A\/reply"/);
    assert.deepEqual(h.spy.refresh, ['LEAD-A'], 'opening the thread fetched it from WhatsApp first');
    assert.match(html, /<input type="hidden" name="seen_rev" value="\d+">/, 'the form carries the revision the page was drawn at');
    assert.equal(fieldOf(html, 'seen_rev'), revOf(h, 'LEAD-A'));
    assert.equal(fieldOf(html, 'seen_ts'), String(NOW + 60_000), 'and the newest message it showed');

    h.tick(120_000);
    const text = 'Yes it is, when can you visit';
    const res = await replyTo(h, 'LEAD-A', { text, send_id: 'send-ok-000000000000001', seen_rev: fieldOf(html, 'seen_rev') }, staff);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');
    assert.deepEqual(h.spy.refresh, ['LEAD-A', 'LEAD-A'], 'and again right before the reply was checked');
    assert.equal(h.evo.calls.length, 1);
    assert.equal(h.evo.calls[0].url, 'http://evo.test/message/sendText/abdulaziz-personal');
    assert.deepEqual(h.evo.calls[0].body, { number: CLIENT, text });

    assert.equal(h.db.getLead('LEAD-A').handler_user_id, h.staffUser.user_id, 'the first to reply becomes the handler');
    const row = h.inboxStore.getOutbox('send-ok-000000000000001');
    assert.equal(row.status, 'accepted');
    assert.equal(row.key_id, 'KEY-1');
    assert.equal(row.user_id, h.staffUser.user_id);
    const mine = h.inboxStore.messagesFor('LEAD-A').find((m) => m.direction === 'out');
    assert.equal(mine.text, text);
    assert.equal(mine.sender_kind, 'staff');
    assert.equal(mine.sender_user_id, h.staffUser.user_id);

    const audited = h.app.audit.recent(50).filter((r) => r.action === 'reply_sent');
    assert.equal(audited.length, 1);
    assert.equal(audited[0].user_id, h.staffUser.user_id);
    assert.equal(audited[0].target, 'LEAD-A');
    assert.deepEqual(audited[0].meta, { status: 'accepted' });
    assert.ok(!JSON.stringify(h.app.audit.recent(50)).includes('when can you visit'), 'never the words');

    const after = await (await h.get('/dashboard/inbox/LEAD-A?ok=sent', { cookie: staff })).text();
    assert.ok(after.includes(text), 'the reply is in the thread');
  });
});

test('a double submit with one send_id sends once, whether the second click lands after the first or during it', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    h.tick(120_000);
    const form = { text: 'On my way', send_id: 'send-twice-00000000001', seen_rev: revOf(h, 'LEAD-A') };
    const first = await replyTo(h, 'LEAD-A', form, staff);
    const again = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(first.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');
    assert.equal(again.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent', 'the resubmit reports the send it repeats');
    assert.equal(h.evo.calls.length, 1);

    // The real double click: the second post arrives while the first is still at WhatsApp.
    h.tick(60_000);
    const race = { text: 'See you at five', send_id: 'send-race-000000000001', seen_rev: revOf(h, 'LEAD-A') };
    const held = h.evo.hold();
    const firstOfRace = replyTo(h, 'LEAD-A', race, staff);
    await held.reached;
    const secondOfRace = await replyTo(h, 'LEAD-A', race, staff);
    assert.equal(secondOfRace.status, 303);
    assert.equal(secondOfRace.headers.get('location'), '/dashboard/inbox/LEAD-A?error=send_uncertain', 'in flight: not sure yet, and not sent again');
    held.release();
    assert.equal((await firstOfRace).headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');

    assert.equal(h.evo.calls.length, 2, 'one request per send_id');
    assert.equal(h.inboxStore.messagesFor('LEAD-A').filter((m) => m.direction === 'out').length, 2);
    assert.equal(h.app.audit.recent(50).filter((r) => r.action === 'reply_sent').length, 2);
  });
});

test('a timeout is "not sure it went", shown as such, and resubmitting it sends nothing', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    h.tick(120_000);
    h.evo.reply = () => 'timeout';
    const form = { text: 'Calling you now', send_id: 'send-slow-000000000001', seen_rev: revOf(h, 'LEAD-A') };
    const res = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox/LEAD-A?error=send_uncertain', 'and no words in the URL');
    assert.equal(h.inboxStore.getOutbox('send-slow-000000000001').status, 'uncertain');
    assert.ok(!h.inboxStore.messagesFor('LEAD-A').some((m) => m.text === 'Calling you now'), 'not drawn as sent: it may not have gone');
    assert.deepEqual(h.app.audit.recent(50).find((r) => r.action === 'reply_sent').meta, { status: 'uncertain' });

    h.evo.reply = (n) => ({ status: 201, body: { key: { id: `KEY-${n}` } } });
    const again = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(again.headers.get('location'), '/dashboard/inbox/LEAD-A?error=send_uncertain');
    assert.equal(h.evo.calls.length, 1, 'an uncertain send is never retried');
    assert.equal((await h.get('/dashboard/inbox/LEAD-A?error=send_uncertain', { cookie: staff })).status, 200);
  });
});

test('an HTTP 500 or 503 from Evolution is "not sure it went": no draft kept, counted against the day, never retried; a 400 keeps the draft', async () => {
  for (const status of [500, 503]) {
    await withInbox(async (h) => {
      seedScene(h);
      const staff = await h.staff();
      h.tick(120_000);
      h.evo.reply = (n) => (n === 1 ? { status, body: {} } : { status: 201, body: { key: { id: `KEY-${n}` } } });
      const sendId = `send-${status}-00000000000001`;
      const form = { text: 'Upstream words', send_id: sendId, seen_rev: revOf(h, 'LEAD-A') };
      const res = await replyTo(h, 'LEAD-A', form, staff);
      assert.equal(res.status, 303, String(status));
      assert.equal(res.headers.get('location'), '/dashboard/inbox/LEAD-A?error=send_uncertain', `${status}: no page, so no draft to send twice`);
      assert.equal(h.inboxStore.getOutbox(sendId).status, 'uncertain', String(status));
      assert.equal(h.inboxStore.countSentSince(NOW), 1, `${status}: it may have gone, so it counts against the day`);
      assert.deepEqual(h.app.audit.recent(50).find((r) => r.action === 'reply_sent').meta, { status: 'uncertain' }, String(status));
      const json = await h.postJson('/v1/admin/inbox/LEAD-A/reply', form, { cookie: staff });
      assert.equal(json.status, 202, `${status}: a JSON resubmit is told the same`);
      assert.deepEqual(await json.json(), { ok: false, error: 'send_uncertain', send_id: sendId });
      const again = await replyTo(h, 'LEAD-A', form, staff);
      assert.equal(again.headers.get('location'), '/dashboard/inbox/LEAD-A?error=send_uncertain', String(status));
      assert.equal(h.evo.calls.length, 1, `${status}: never retried`);
    });
  }

  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    h.tick(120_000);
    h.evo.reply = () => ({ status: 400, body: {} });
    const draft = 'Refused words';
    const res = await replyTo(h, 'LEAD-A', { text: draft, send_id: 'send-400-00000000000001', seen_rev: revOf(h, 'LEAD-A') }, staff);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', 'WhatsApp refused it: the thread again');
    const html = await res.text();
    assert.ok(html.includes(draft), 'the words are still in the box');
    assert.notEqual(fieldOf(html, 'send_id'), 'send-400-00000000000001', 'and a fresh send_id');
    assert.equal(h.inboxStore.getOutbox('send-400-00000000000001').status, 'failed');
    assert.equal(h.inboxStore.countSentSince(NOW), 0, 'a refused request costs nothing');
  });
});

test('a member deactivated while the chat refreshes before their reply is signed out: nothing sent, nothing written', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    h.tick(120_000);
    h.spy.onRefresh = () => h.team.deactivateUser(h.staffUser.user_id);
    const form = { text: 'Words from someone who just left', send_id: 'send-gone-000000000001', seen_rev: revOf(h, 'LEAD-A') };
    const res = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/login', 'a form goes to the login, like any signed-out page');
    assert.deepEqual(h.spy.refresh, ['LEAD-A'], 'the refresh ran; the session was asked again after it');
    assert.equal(h.evo.calls.length, 0, 'nothing reached WhatsApp');
    assert.equal(h.inboxStore.getOutbox('send-gone-000000000001'), null, 'and nothing was written');
    assert.ok(!h.app.audit.recent(50).some((r) => r.action === 'reply_sent'));
  });

  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    h.tick(120_000);
    h.spy.onRefresh = () => h.team.deactivateUser(h.staffUser.user_id);
    const res = await h.postJson('/v1/admin/inbox/LEAD-A/reply', { text: 'x', send_id: 'send-gone-000000000002', seen_rev: h.inboxStore.revision('LEAD-A') }, { cookie: staff });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorised' });
    assert.equal(h.evo.calls.length, 0);
    assert.equal(h.inboxStore.getOutbox('send-gone-000000000002'), null);
  });

  // The sender's own last look at the member (lib/wa-send.mjs) is answered the same way.
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    h.app.sender.reply = async () => ({ ok: false, error: 'inactive_user' });
    const form = await replyTo(h, 'LEAD-A', { text: 'x', send_id: 'send-gone-000000000003', seen_rev: revOf(h, 'LEAD-A') }, staff);
    assert.equal(form.status, 303);
    assert.equal(form.headers.get('location'), '/dashboard/login');
    const json = await h.postJson('/v1/admin/inbox/LEAD-A/reply', { text: 'x', send_id: 'send-gone-000000000003', seen_rev: h.inboxStore.revision('LEAD-A') }, { cookie: staff });
    assert.equal(json.status, 401);
    assert.deepEqual(await json.json(), { error: 'unauthorised' });
  });
});

test('no reply outcome answers 502 or 504 (Cloudflare replaces those pages, and the typed words with them): a refusal upstream draws the thread with 503', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const failed = (error) => ({ ok: false, error, status: 'failed', sendId: 'send-any-0000000000001' });
    const uncertain = (error) => ({ ok: false, error, status: 'uncertain', sendId: 'send-any-0000000000001', uncertain: true });
    const again = (status, error) => ({ ok: status === 'accepted', duplicate: true, status, sendId: 'send-any-0000000000001', error, ...(status === 'pending' || status === 'uncertain' ? { uncertain: true } : {}) });
    // Every answer lib/wa-send.mjs `reply` can give: its own refusals, the gate's, what came
    // back from Evolution, and a resubmit of every outbox status.
    const outcomes = [
      { ok: true, status: 'accepted', sendId: 'send-any-0000000000001', keyId: 'KEY-X' },
      ...['bad_send_id', 'replies_off', 'bad_text', 'not_found', 'not_in_inbox', 'lid_only', 'excluded', 'stale', 'inactive_user']
        .map((error) => ({ ok: false, error })),
      ...['bad_recipient', 'bad_kind', 'bad_text', 'sending_disabled', 'disabled', 'evolution-not-configured', 'rate_limited', 'duplicate', 'network', 'http_400', 'http_404', 'http_429', 'mystery']
        .map(failed),
      ...['timeout', 'network', 'no_ack', 'http_500', 'http_502', 'http_503', 'http_504'].map(uncertain),
      again('accepted', null), again('pending', 'pending'), again('uncertain', 'http_502'), again('failed', 'http_400'), again('failed', 'sending_disabled'),
    ];
    for (const out of outcomes) {
      h.app.sender.reply = async () => out;
      const label = JSON.stringify(out);
      const form = await replyTo(h, 'LEAD-A', { text: 'Words worth keeping', send_id: 'send-any-0000000000001', seen_rev: revOf(h, 'LEAD-A') }, staff);
      assert.ok(![502, 504].includes(form.status), `form ${form.status}: ${label}`);
      if (form.headers.get('content-type')?.startsWith('application/json')) assert.fail(`a form never gets raw JSON: ${label}`);
      await form.arrayBuffer();
      const json = await h.postJson('/v1/admin/inbox/LEAD-A/reply', { text: 'x', send_id: 'send-any-0000000000001', seen_rev: h.inboxStore.revision('LEAD-A') }, { cookie: staff });
      assert.ok(![502, 504].includes(json.status), `json ${json.status}: ${label}`);
      await json.arrayBuffer();
    }
  });

  // The real thing: Evolution turns a reply away (a 4xx), then the same form is sent again.
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    h.tick(120_000);
    h.evo.reply = () => ({ status: 400, body: {} });
    const form = { text: 'Turned away upstream', send_id: 'send-4xx-00000000000001', seen_rev: revOf(h, 'LEAD-A') };
    const res = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(res.status, 503);
    assertLocked(res);
    const html = await res.text();
    assert.ok(html.includes('Turned away upstream'), 'the thread again, the words still in the box');
    assert.ok(html.includes('WhatsApp would not take the message.'));
    const resubmit = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(resubmit.status, 503, 'a resubmit of a failed send too');
    const json = await h.postJson('/v1/admin/inbox/LEAD-A/reply', form, { cookie: staff });
    assert.equal(json.status, 503);
    assert.deepEqual(await json.json(), { error: 'send_failed' });
    assert.equal(h.evo.calls.length, 1);
  });
});

test('a 4,096-character Arabic reply reaches WhatsApp whole; a body too big even for that draws the thread again (bad_text), never raw JSON', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    h.tick(120_000);
    // Two bytes a letter in UTF-8, six once a form percent-encodes it: 24 KiB of body.
    const arabic = 'ب'.repeat(4096);
    const res = await replyTo(h, 'LEAD-A', { text: arabic, send_id: 'send-long-000000000001', seen_rev: revOf(h, 'LEAD-A') }, staff);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');
    assert.equal(h.evo.calls.length, 1);
    assert.equal(h.evo.calls[0].body.text, arabic, 'every letter reached the sender');

    // The worst a character can be: three bytes in UTF-8 (ﻻ, the lam-alef ligature), nine encoded — 36 KiB.
    const ligatures = 'ﻻ'.repeat(4096);
    const worst = await replyTo(h, 'LEAD-A', { text: ligatures, send_id: 'send-long-000000000002', seen_rev: revOf(h, 'LEAD-A') }, staff);
    assert.equal(worst.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');
    assert.equal(h.evo.calls[1].body.text, ligatures);

    // Past 64 KiB (72 KB here) the words are read to the end and thrown away: the thread comes
    // back with a message a person can act on, as any other over-long reply does. The body was
    // read whole, so the connection is not closed under a browser still sending it — closing
    // it then could cut the page off and show a connection error instead.
    const huge = await replyTo(h, 'LEAD-A', { text: 'ب'.repeat(12_000), send_id: 'send-long-000000000003', seen_rev: revOf(h, 'LEAD-A') }, staff);
    assert.equal(huge.status, 400, 'the ordinary bad_text answer');
    assertLocked(huge);
    assert.equal(huge.headers.get('content-type'), 'text/html; charset=utf-8', 'the page, never raw JSON');
    assert.equal(huge.headers.get('connection'), 'keep-alive', 'read to its end, so the connection stays');
    const html = await huge.text();
    assert.ok(html.includes('A reply has to have some text, and at most 4,096 characters.'));
    assert.ok(html.includes('Is BONA-012 still free?'), 'the thread itself');
    assert.match(fieldOf(html, 'send_id'), /^[A-Za-z0-9_-]{16,64}$/, 'with a fresh form to send from');
    assert.match(html, /<textarea id="r-text"[^>]*><\/textarea>/, 'the words were thrown away unread: the box is empty');
    assert.equal(h.evo.calls.length, 2, 'nothing more went');
    assert.equal(h.inboxStore.getOutbox('send-long-000000000003'), null, 'and nothing was written');

    // Past the 1 MiB ceiling it is not read to its end: the same page at 413, and the
    // connection goes with it. This body says it is 2 MiB and stops one byte past the
    // ceiling — the byte the server answers on — so nothing unread is left on the socket.
    assert.ok(REPLY_DRAIN_MAX_BYTES === 1024 * 1024 && REPLY_DRAIN_MAX_BYTES > REPLY_MAX_BODY_BYTES);
    const head = '_dash=1&send_id=send-long-000000000005&text=';
    const past = await partialPost(h, '/v1/admin/inbox/LEAD-A/reply', {
      cookie: staff, claimed: 2 * 1024 * 1024, body: head + 'x'.repeat(REPLY_DRAIN_MAX_BYTES + 1 - head.length),
    });
    assert.equal(past.status, 413);
    assert.equal(past.headers.connection, 'close', 'the unread rest of the body goes with the connection');
    assert.equal(past.headers['content-type'], 'text/html; charset=utf-8', 'the page, never raw JSON');
    assert.equal(past.headers['cache-control'], 'no-store');
    assert.ok(past.text.includes('A reply has to have some text, and at most 4,096 characters.'));
    assert.ok(past.text.includes('Is BONA-012 still free?'), 'the thread itself');
    assert.equal(Buffer.byteLength(past.text), Number(past.headers['content-length']), 'the whole page arrived');
    assert.equal(h.evo.calls.length, 2, 'nothing more went');
    assert.equal(h.inboxStore.getOutbox('send-long-000000000005'), null, 'and nothing was written');

    // A JSON caller still gets JSON, and every other write keeps the ordinary 16 KiB cap.
    const json = await h.postJson('/v1/admin/inbox/LEAD-A/reply', { text: 'x'.repeat(70_000), send_id: 'send-long-000000000004', seen_rev: h.inboxStore.revision('LEAD-A') }, { cookie: staff });
    assert.equal(json.status, 413);
    assert.deepEqual(await json.json(), { error: 'payload_too_large' });
    const handler = await h.postForm('/v1/admin/inbox/LEAD-A/handler', { user_id: '', pad: 'x'.repeat(20_000) }, { cookie: staff });
    assert.equal(handler.status, 413);
    assert.deepEqual(await handler.json(), { error: 'payload_too_large' });
  });
});

test('a refused reply is drawn again with the words kept and a fresh send_id, and nothing is sent', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const opened = await (await h.get('/dashboard/inbox/LEAD-A', { cookie: staff })).text();
    // A message that arrived while the page was open, found by the refresh the reply makes.
    let played = false;
    h.spy.onRefresh = (lead) => {
      if (played || lead.lead_id !== 'LEAD-A') return;
      played = true;
      h.inboxStore.upsertMessage({
        key_id: 'A-2', lead_id: 'LEAD-A', jid: `${CLIENT}@s.whatsapp.net`, direction: 'in', sender_kind: 'client',
        text: 'Or is BONA-014 better?', ts: NOW + 90_000,
      });
    };
    const draft = 'Draft about the villa';
    const stale = await replyTo(h, 'LEAD-A', { text: draft, send_id: 'send-stale-00000000001', seen_rev: fieldOf(opened, 'seen_rev') }, staff);
    assert.equal(stale.status, 409, 'new activity since the page was opened');
    assertLocked(stale);
    const html = await stale.text();
    assert.ok(html.includes(draft), 'the words are still in the box');
    assert.ok(html.includes('Or is BONA-014 better?'), 'and the new message is on the page');
    assert.ok(!html.includes('send-stale-00000000001'), 'the old send_id is not handed out again');
    const fresh = fieldOf(html, 'send_id');
    assert.match(fresh, /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(fieldOf(html, 'seen_ts'), String(NOW + 90_000));
    assert.equal(fieldOf(html, 'seen_rev'), revOf(h, 'LEAD-A'), 'and a revision that covers it');
    assert.ok(Number(fieldOf(html, 'seen_rev')) > Number(fieldOf(opened, 'seen_rev')));

    const empty = await replyTo(h, 'LEAD-A', { text: '   ', send_id: fresh, seen_rev: fieldOf(html, 'seen_rev') }, staff);
    assert.equal(empty.status, 400);

    h.team.setSetting('sending_enabled', '0');
    const off = await replyTo(h, 'LEAD-A', { text: draft, send_id: fresh, seen_rev: fieldOf(html, 'seen_rev') }, staff);
    assert.equal(off.status, 503, 'the owner switched sending off');
    assert.equal(h.evo.calls.length, 0, 'none of the three reached WhatsApp');
    assert.equal(fieldOf(await off.text(), 'seen_rev'), null, 'with sending off the page has no reply box to send from');

    h.team.setSetting('sending_enabled', '1');
    h.tick(120_000);
    // Opened again once sending is back on: the refused send is on that page, and in its revision.
    const reopened = await (await h.get('/dashboard/inbox/LEAD-A', { cookie: staff })).text();
    assert.ok(Number(fieldOf(reopened, 'seen_rev')) > Number(fieldOf(html, 'seen_rev')), "the refused send's row counts");
    const sent = await replyTo(h, 'LEAD-A', { text: draft, send_id: 'send-after-00000000001', seen_rev: fieldOf(reopened, 'seen_rev') }, staff);
    assert.equal(sent.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');
    assert.equal(h.evo.calls.length, 1);
  });
});

test('two people on one page: once the first reply is accepted the second is stale, though the first is stored in the same second as the newest message both saw', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const boss = await h.boss();
    // Both open the chat in the second its newest message was stamped with.
    h.tick(60_000);
    const saras = await (await h.get('/dashboard/inbox/LEAD-A', { cookie: staff })).text();
    const owners = await (await h.get('/dashboard/inbox/LEAD-A', { cookie: boss })).text();
    assert.equal(fieldOf(owners, 'seen_rev'), fieldOf(saras, 'seen_rev'));
    assert.equal(fieldOf(owners, 'seen_ts'), String(NOW + 60_000));
    // Every field each form carries, as a browser posts it.
    const formOf = (page, text) => ({ text, send_id: fieldOf(page, 'send_id'), seen_rev: fieldOf(page, 'seen_rev'), seen_ts: fieldOf(page, 'seen_ts') });

    h.tick(700);
    const first = await replyTo(h, 'LEAD-A', formOf(saras, 'Yes, still free'), staff);
    assert.equal(first.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');
    assert.equal(h.inboxStore.newestTs('LEAD-A'), NOW + 60_000, "stored in the second of the newest message the owner's page showed");

    const second = await replyTo(h, 'LEAD-A', formOf(owners, 'It is, come by'), boss);
    assert.equal(second.status, 409);
    const html = await second.text();
    assert.ok(html.includes('It is, come by'), 'the words are still in the box');
    assert.ok(html.includes('Yes, still free'), 'under the reply that page had not shown');
    assert.equal(h.evo.calls.length, 1, 'the client got one answer, not two');
    assert.equal(h.inboxStore.getOutbox(fieldOf(owners, 'send_id')), null, 'nothing written for the refused one');
  });
});

test('a page drawn before the chat was marked Not a client never sends once it is moved back in and the client writes again', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    // The client's newest message is also the newest row of the whole transcript table, so
    // the purge below frees its rowid for the next message stored.
    h.inboxStore.upsertMessage({
      key_id: 'A-2', lead_id: 'LEAD-A', jid: `${CLIENT}@s.whatsapp.net`, direction: 'in', sender_kind: 'client', text: 'Tomorrow at five?', ts: NOW + 61_000,
    });
    const staff = await h.staff();
    const boss = await h.boss();
    const opened = await (await h.get('/dashboard/inbox/LEAD-A', { cookie: staff })).text();
    assert.equal((await h.postForm('/v1/admin/inbox/LEAD-A/out', {}, { cookie: boss })).status, 303);
    assert.equal((await h.postForm('/v1/admin/inbox/LEAD-A/move', {}, { cookie: boss })).status, 303);
    h.inboxStore.upsertMessage({
      key_id: 'A-3', lead_id: 'LEAD-A', jid: `${CLIENT}@s.whatsapp.net`, direction: 'in', sender_kind: 'client', text: 'Different question: the duplex?', ts: NOW + 120_000,
    });
    const draft = 'Yes, five works';
    const res = await replyTo(h, 'LEAD-A', {
      text: draft, send_id: fieldOf(opened, 'send_id'), seen_rev: fieldOf(opened, 'seen_rev'), seen_ts: fieldOf(opened, 'seen_ts'),
    }, staff);
    assert.equal(res.status, 409, 'the page Sara typed on is not the conversation now');
    const html = await res.text();
    assert.ok(html.includes(draft), 'the words are still in the box');
    assert.ok(html.includes('Different question: the duplex?'), 'under the message the old page never showed');
    assert.ok(!html.includes('Tomorrow at five?'), 'and without the purged one');
    assert.equal(h.evo.calls.length, 0, 'nothing reached WhatsApp');
    assert.equal(h.inboxStore.getOutbox(fieldOf(opened, 'send_id')), null, 'nothing written for it');
  });
});

test('a reply keeps its author\'s name after they leave the team, and they are no longer offered as handler', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const gone = h.team.addUser({ name: 'Hadi Former', phone: '0500000002', role: 'staff' });
    h.inboxStore.upsertMessage({
      key_id: 'A-out-1', lead_id: 'LEAD-A', jid: `${CLIENT}@s.whatsapp.net`, direction: 'out', sender_kind: 'staff',
      sender_user_id: gone.user_id, text: 'Happy to show you round', ts: NOW + 61_000,
    });
    h.team.deactivateUser(gone.user_id);
    const staff = await h.staff();
    const page = await h.get('/dashboard/inbox/LEAD-A', { cookie: staff });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('Happy to show you round'));
    assert.ok(html.includes('<bdi>Hadi Former</bdi>'), 'the bubble still names who wrote it, not just "Team"');
    assert.ok(!html.includes(`value="${gone.user_id}"`), 'but nobody can hand the chat to someone who has left');
    assert.ok(html.includes(`value="${h.staffUser.user_id}"`), 'the control: the picker is on the page');
  });
});

test('replies ship switched off: the chat reads but has no reply box, a posted reply goes nowhere, and only the owner turns them on', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    h.team.setSetting('inbox_replies', '0');
    const staff = await h.staff();
    const boss = await h.boss();

    const page = await h.get('/dashboard/inbox/LEAD-A', { cookie: staff });
    assert.equal(page.status, 200, 'the chat can still be read');
    const html = await page.text();
    assert.ok(html.includes('Is BONA-012 still free?'));
    assert.match(html, /Replies from the dashboard are not switched on yet/);
    assert.doesNotMatch(html, /action="\/v1\/admin\/inbox\/LEAD-A\/reply"/);

    h.tick(120_000);
    const form = { text: 'First words to a client', send_id: 'send-off-0000000000001', seen_rev: revOf(h, 'LEAD-A') };
    const refused = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(refused.status, 503);
    assertLocked(refused);
    assert.match(await refused.text(), /<div class="err">Replies from the dashboard are not switched on yet\.<\/div>/);
    assert.equal(h.evo.calls.length, 0, 'nothing reached WhatsApp');
    assert.equal(h.inboxStore.getOutbox('send-off-0000000000001'), null, 'and nothing was written');
    assert.ok(!h.app.audit.recent(50).some((r) => r.action === 'reply_sent'));

    const denied = await h.postForm('/v1/admin/settings', { inbox_replies: '1' }, { cookie: staff });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'owner_only' });
    assert.equal(h.team.repliesEnabled(), false);

    const both = await h.postForm('/v1/admin/settings', { inbox_replies: '1', sending_enabled: '1' }, { cookie: boss });
    assert.equal(both.headers.get('location'), '/dashboard/team?error=bad_setting', 'one switch per post');
    assert.equal(h.team.repliesEnabled(), false);

    assert.match(await (await h.get('/dashboard/team', { cookie: boss })).text(), /name="inbox_replies" value="1"/, 'the Team page offers to turn them on');
    const on = await h.postForm('/v1/admin/settings', { inbox_replies: '1' }, { cookie: boss });
    assert.equal(on.status, 303);
    assert.equal(on.headers.get('location'), '/dashboard/team?ok=setting');
    assert.equal(h.team.repliesEnabled(), true);
    const audited = h.app.audit.recent(50).filter((r) => r.action === 'setting');
    assert.equal(audited.length, 1);
    assert.equal(audited[0].user_id, h.owner.user_id);
    assert.equal(audited[0].target, 'inbox_replies');
    assert.deepEqual(audited[0].meta, { value: '1' });

    const sent = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(sent.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent', 'the same form goes once they are on');
    assert.equal(h.evo.calls.length, 1);
  });
});

test('anyone on the team can hand a chat to someone else, and it is audited by id', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const to = await h.postForm('/v1/admin/inbox/LEAD-A/handler', { user_id: h.owner.user_id }, { cookie: staff });
    assert.equal(to.status, 303);
    assert.equal(to.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=handler');
    assert.equal(h.db.getLead('LEAD-A').handler_user_id, h.owner.user_id);
    const none = await h.postForm('/v1/admin/inbox/LEAD-A/handler', { user_id: '' }, { cookie: staff });
    assert.equal(none.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=handler');
    assert.equal(h.db.getLead('LEAD-A').handler_user_id, null);

    const gone = h.team.addUser({ name: 'Old Hand', phone: '0500000002', role: 'staff' });
    h.team.deactivateUser(gone.user_id);
    for (const userId of ['USR-nobody', gone.user_id]) {
      const bad = await h.postForm('/v1/admin/inbox/LEAD-A/handler', { user_id: userId }, { cookie: staff });
      assert.equal(bad.headers.get('location'), '/dashboard/inbox/LEAD-A?error=bad_handler', userId);
    }
    assert.equal(h.db.getLead('LEAD-A').handler_user_id, null);
    const refused = await h.postForm('/v1/admin/inbox/LEAD-U/handler', { user_id: h.owner.user_id }, { cookie: staff });
    assert.equal(refused.status, 404, 'not a chat anyone may pick up');

    const rows = h.app.audit.recent(50).filter((r) => r.action === 'handler');
    assert.deepEqual(rows.map((r) => r.meta).reverse(), [{ to: h.owner.user_id }, { to: null }]);
    assert.ok(rows.every((r) => r.user_id === h.staffUser.user_id && r.target === 'LEAD-A'));
  });
});

/* ---------------- the owner's moves ---------------- */

test('move, Not a client and add by phone are the owner\'s alone', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    for (const [p, fields] of [['/v1/admin/inbox/LEAD-U/move', {}], ['/v1/admin/inbox/LEAD-A/out', {}], ['/v1/admin/inbox/add', { phone: '0500000088' }]]) {
      const res = await h.postForm(p, fields, { cookie: staff });
      assert.equal(res.status, 403, p);
      assertLocked(res);
      assert.deepEqual(await res.json(), { error: 'owner_only' }, p);
    }
    assert.equal(h.db.getLead('LEAD-U').inbox_state, 'unsure');
    assert.equal(h.db.getLead('LEAD-A').inbox_state, 'in');
    assert.equal(h.inboxStore.hasMessages('LEAD-A'), true);
    assert.equal(h.db.getLeadByPhone('966500000088'), null);
    assert.deepEqual(h.spy.history, []);
    assert.ok(!h.app.audit.recent(50).some((r) => r.action.startsWith('inbox_')));
  });
});

test('the owner moves a guess into the inbox, and it brings its last 30 days', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const boss = await h.boss();
    const res = await h.postForm('/v1/admin/inbox/LEAD-U/move', {}, { cookie: boss });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox/LEAD-U?ok=moved');
    const lead = h.db.getLead('LEAD-U');
    assert.equal(lead.inbox_state, 'in');
    assert.ok(Number.isFinite(lead.inbox_since));
    assert.equal(h.spy.history.length, 1);
    assert.equal(h.spy.history[0].leadId, 'LEAD-U');
    assert.equal(h.spy.history[0].untilTs - h.spy.history[0].sinceTs, OWNER_HISTORY_MS);
    const audited = h.app.audit.recent(50).find((r) => r.action === 'inbox_move');
    assert.equal(audited.target, 'LEAD-U');
    assert.equal(audited.user_id, h.owner.user_id);
    const staff = await h.staff();
    assert.ok((await (await h.get('/dashboard/inbox', { cookie: staff })).text()).includes('Umar Unsure'), 'the team sees it now');
  });
});

test('Not a client: the chat leaves the inbox and its transcript is purged at once', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    h.inboxStore.setHandler('LEAD-A', h.staffUser.user_id);
    const boss = await h.boss();
    const res = await h.postForm('/v1/admin/inbox/LEAD-A/out', {}, { cookie: boss });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox?ok=out');
    const lead = h.db.getLead('LEAD-A');
    assert.equal(lead.inbox_state, 'out');
    assert.equal(lead.handler_user_id, null);
    assert.equal(h.inboxStore.hasMessages('LEAD-A'), false);
    assert.equal((await h.get('/dashboard/inbox/LEAD-A', { cookie: boss })).status, 404);
    assert.equal(h.app.audit.recent(50).find((r) => r.action === 'inbox_out').target, 'LEAD-A');
    // From the Unsure list it lands back on the Unsure list.
    const fromUnsure = await h.postForm('/v1/admin/inbox/LEAD-U/out', {}, { cookie: boss });
    assert.equal(fromUnsure.headers.get('location'), '/dashboard/inbox?tab=unsure&ok=out');
    assert.equal(h.db.getLead('LEAD-U').inbox_state, 'out');
  });
});

test('add by phone: a new chat joins with 30 days of history; team, never-list and bad numbers are refused', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const boss = await h.boss();
    const leadsBefore = h.db.countLeads();
    for (const [phone, error] of [['0500000001', 'excluded'], ['0500000080', 'excluded'], ['hello', 'bad_phone'], ['123456789@lid', 'bad_phone']]) {
      const res = await h.postForm('/v1/admin/inbox/add', { phone }, { cookie: boss });
      assert.equal(res.status, 303, phone);
      assert.equal(res.headers.get('location'), `/dashboard/inbox?error=${error}`, phone);
    }
    assert.equal(h.db.countLeads(), leadsBefore);
    assert.deepEqual(h.spy.history, []);

    const res = await h.postForm('/v1/admin/inbox/add', { phone: '0500000088' }, { cookie: boss });
    assert.equal(res.status, 303);
    const id = /^\/dashboard\/inbox\/(LEAD-[A-Za-z0-9-]+)\?ok=added$/.exec(res.headers.get('location'))?.[1];
    assert.ok(id, res.headers.get('location'));
    const lead = h.db.getLead(id);
    assert.equal(lead.phone_e164, '966500000088');
    assert.equal(lead.wa_jid, '966500000088@s.whatsapp.net');
    assert.equal(lead.match_method, 'owner_added');
    assert.equal(lead.inbox_state, 'in');
    assert.equal(h.spy.history.at(-1).leadId, id);
    assert.equal(h.spy.history.at(-1).untilTs - h.spy.history.at(-1).sinceTs, OWNER_HISTORY_MS);
    assert.equal(h.app.audit.recent(50).find((r) => r.action === 'inbox_add').target, id);
    assert.deepEqual(h.notes, [], 'no new-lead note to the owner for a chat he added himself');

    const known = await h.postForm('/v1/admin/inbox/add', { phone: '0500000078' }, { cookie: boss });
    assert.equal(known.headers.get('location'), '/dashboard/inbox/LEAD-U?ok=added', 'a number already on a lead brings that lead in');
    assert.equal(h.db.getLead('LEAD-U').inbox_state, 'in');
  });
});

test('adding a number to the never list takes its chat out of the inbox and purges it at once', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const boss = await h.boss();
    const res = await h.postForm('/v1/admin/never', { phone: '0500000077', note: 'cousin' }, { cookie: boss });
    assert.equal(res.headers.get('location'), '/dashboard/team?ok=never_added');
    assert.equal(h.db.getLead('LEAD-A').inbox_state, 'out');
    assert.equal(h.inboxStore.hasMessages('LEAD-A'), false);
    assert.equal((await h.get('/dashboard/inbox/LEAD-A', { cookie: boss })).status, 404);
    assert.ok(h.app.audit.recent(50).some((r) => r.action === 'inbox_out' && r.target === 'LEAD-A'));
    assert.doesNotMatch(JSON.stringify(h.app.audit.recent(50)), /500000077|cousin/);
  });
});

test('adding a colleague whose number already has a chat takes it out of the inbox and purges it at once', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const boss = await h.boss();
    const res = await h.postForm('/v1/admin/team', { name: 'Alya Now Staff', phone: '0500000077', role: 'staff' }, { cookie: boss });
    assert.equal(res.headers.get('location'), '/dashboard/team?ok=added');
    assert.equal(h.db.getLead('LEAD-A').inbox_state, 'out');
    assert.equal(h.inboxStore.hasMessages('LEAD-A'), false, 'a colleague\'s words are never kept (§3.5)');
    assert.equal((await h.get('/dashboard/inbox/LEAD-A', { cookie: boss })).status, 404);
    assert.ok(h.app.audit.recent(50).some((r) => r.action === 'inbox_out' && r.target === 'LEAD-A'));
    // A number with no chat: the person is added and nothing else moves.
    const fresh = await h.postForm('/v1/admin/team', { name: 'New Hand', phone: '0500000090', role: 'staff' }, { cookie: boss });
    assert.equal(fresh.headers.get('location'), '/dashboard/team?ok=added');
    assert.equal(h.app.audit.recent(50).filter((r) => r.action === 'inbox_out').length, 1);
    assert.equal(h.db.getLead('LEAD-U').inbox_state, 'unsure');
    assert.doesNotMatch(JSON.stringify(h.app.audit.recent(50)), /500000077|Alya/);
  });
});

/* ---------------- unread, logs ---------------- */

test('unread: the nav badge counts it on every page, and opening the thread marks it read for that person only', async () => {
  await withInbox(async (h) => {
    seedChat(h, { id: 'LEAD-A', name: 'Alya Client', messages: [
      { key_id: 'A-1', text: 'Hello', ts: NOW + 60_000 },
      { key_id: 'A-2', text: 'Is BONA-012 free?', ts: NOW + 70_000 },
    ] });
    const staff = await h.staff();
    const boss = await h.boss();
    for (const p of ['/dashboard', '/dashboard/leads', '/dashboard/spend']) {
      assert.match(await (await h.get(p, { cookie: staff })).text(), /Inbox<span class="c">2<\/span>/, p);
    }
    assert.equal((await h.get('/dashboard/inbox/LEAD-A', { cookie: staff })).status, 200);
    assert.doesNotMatch(await (await h.get('/dashboard/leads', { cookie: staff })).text(), /Inbox<span class="c">/);
    const read = h.db.db.prepare('SELECT last_read_ts FROM inbox_reads WHERE user_id = ? AND lead_id = ?').get(h.staffUser.user_id, 'LEAD-A');
    assert.equal(read.last_read_ts, NOW + 70_000, 'read up to the newest message on the page, not "now"');
    assert.match(await (await h.get('/dashboard/leads', { cookie: boss })).text(), /Inbox<span class="c">2<\/span>/, 'the owner has not read it');
  });
});

test('a thread draws every unread message past 200 (up to 1,000), says how many earlier ones it leaves out, and marks read only what it drew', async () => {
  await withInbox(async (h) => {
    const burst = (id, phone, n) => seedChat(h, {
      id, name: id, phone,
      messages: Array.from({ length: n }, (_, i) => ({ key_id: `${id}-${i}`, text: `${id} message ${i}`, ts: NOW + 1_000 + i * 1_000 })),
    });
    const bubbles = (html) => (html.match(/class="bub in"/g) ?? []).length;
    const readMark = (leadId) => h.db.db.prepare('SELECT last_read_ts FROM inbox_reads WHERE user_id = ? AND lead_id = ?').get(h.staffUser.user_id, leadId)?.last_read_ts;
    const staff = await h.staff();

    // 250 messages, every one unread (the account is older than all of them): all drawn.
    burst('LEAD-250', '966500000091', 250);
    const all = await (await h.get('/dashboard/inbox/LEAD-250', { cookie: staff })).text();
    assert.equal(bubbles(all), 250, 'not only the newest 200');
    assert.doesNotMatch(all, /not shown here/);
    assert.equal(readMark('LEAD-250'), NOW + 250_000);

    // 300 messages, the first 150 already read: 150 unread fit the usual 200, and 100 older ones are left out.
    burst('LEAD-300', '966500000092', 300);
    h.inboxStore.markRead(h.staffUser.user_id, 'LEAD-300', NOW + 150_000);
    const some = await (await h.get('/dashboard/inbox/LEAD-300', { cookie: staff })).text();
    assert.equal(bubbles(some), 200);
    assert.match(some, /100 earlier messages are not shown here\./);
    assert.match(some, /LEAD-300 message 100</, 'the oldest drawn');
    assert.doesNotMatch(some, /LEAD-300 message 99</);

    // 1,100 unread: the thread stops at 1,000, says so, and marks read up to the newest it drew.
    // Accepted (plan P4, README): the 100 unread ones past the cap count as read too — the
    // read mark is one timestamp, and a page drawn from the oldest unread one forward would
    // leave out the newest messages — the ones a reply answers.
    burst('LEAD-1100', '966500000093', 1_100);
    const capped = await (await h.get('/dashboard/inbox/LEAD-1100', { cookie: staff })).text();
    assert.equal(bubbles(capped), 1_000);
    assert.match(capped, /100 earlier messages are not shown here\./);
    assert.equal(readMark('LEAD-1100'), NOW + 1_100_000, 'the newest drawn message');
    assert.equal(h.inboxStore.unreadSpan('LEAD-1100', { userId: h.staffUser.user_id, userCreated: h.staffUser.created }), 0, 'the ones past the cap are not left unread');
    assert.equal(fieldOf(capped, 'seen_ts'), String(NOW + 1_100_000), 'the form names the newest message it drew');
    assert.equal(fieldOf(capped, 'seen_rev'), revOf(h, 'LEAD-1100'), 'and the chat\'s revision, which a reply is checked against');
  });
});

test('a thread sizes its page by every message from the oldest unread one on, replies included, so a busy chat draws all its unread messages', async () => {
  await withInbox(async (h) => {
    const staff = await h.staff();
    // 30 messages Sara has read, then 150 unread client messages, each answered from the
    // owner's phone: the answers sit between the unread ones, so 150 unread span 300 messages.
    seedChat(h, {
      id: 'LEAD-MIX', name: 'Mix', phone: '966500000094',
      messages: Array.from({ length: 30 }, (_, i) => ({ key_id: `mix-old-${i}`, text: `mix old ${i}`, ts: NOW + 1_000 + i * 1_000 })),
    });
    h.inboxStore.markRead(h.staffUser.user_id, 'LEAD-MIX', NOW + 30_000);
    for (let i = 0; i < 150; i += 1) {
      const ts = NOW + 100_000 + i * 2_000;
      h.inboxStore.upsertMessage({ key_id: `mix-in-${i}`, lead_id: 'LEAD-MIX', jid: '966500000094@s.whatsapp.net', direction: 'in', sender_kind: 'client', text: `mix in ${i}`, ts });
      h.inboxStore.upsertMessage({ key_id: `mix-out-${i}`, lead_id: 'LEAD-MIX', jid: '966500000094@s.whatsapp.net', direction: 'out', sender_kind: 'owner_number', text: `mix out ${i}`, ts: ts + 1_000 });
    }
    const html = await (await h.get('/dashboard/inbox/LEAD-MIX', { cookie: staff })).text();
    const drawn = new Set([...html.matchAll(/mix in (\d+)</g)].map((m) => Number(m[1])));
    assert.equal(drawn.size, 150, 'every unread client message is drawn, not only the newest 100');
    assert.match(html, /mix old 10</, '20 messages before the oldest unread one');
    assert.doesNotMatch(html, /mix old 9</);
    assert.match(html, /10 earlier messages are not shown here\./);
    assert.equal(h.inboxStore.unreadSpan('LEAD-MIX', { userId: h.staffUser.user_id, userCreated: h.staffUser.created }), 0, 'all of them read now');
  });
});

test('nothing the inbox writes to the log carries message text, a phone number or a name', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const boss = await h.boss();
    await h.get('/dashboard/inbox', { cookie: staff });
    await h.get('/dashboard/inbox/LEAD-A', { cookie: staff });
    h.tick(120_000);
    await replyTo(h, 'LEAD-A', { text: 'Secret reply words', send_id: 'send-log-0000000000001', seen_rev: revOf(h, 'LEAD-A') }, staff);
    h.evo.reply = () => 'timeout';
    await replyTo(h, 'LEAD-A', { text: 'Second secret words', send_id: 'send-log-0000000000002', seen_rev: revOf(h, 'LEAD-A') }, staff);
    await h.postForm('/v1/admin/inbox/LEAD-A/handler', { user_id: h.owner.user_id }, { cookie: staff });
    await h.postForm('/v1/admin/inbox/add', { phone: '0500000088' }, { cookie: boss });
    await h.postForm('/v1/admin/inbox/LEAD-U/move', {}, { cookie: boss });
    await h.postForm('/v1/admin/never', { phone: '0500000077' }, { cookie: boss });
    assert.ok(h.logs.some((e) => e.evt === 'dash.reply'), 'the replies were logged');
    const dump = JSON.stringify(h.logs);
    for (const secret of ['Secret reply words', 'Second secret words', 'Is BONA-012 still free?', '500000077', '500000088', '500000078', '500000001', 'Alya', 'Sara']) {
      assert.ok(!dump.includes(secret), secret);
    }
  });
});

/* ---------------- real-estate chats to check (D17) ---------------- */

const CAND_PHONE = '966500000091';
/** One chat on the owner's list, as the poller would have noted it. */
const noteCand = (h, { phone = CAND_PHONE, name = 'Candi Date', words = ['شقة', 'إيجار'], dir = 'in', ts = NOW + 10_000 } = {}) =>
  h.inboxStore.noteCandidate({ phone, jid: `${phone}@s.whatsapp.net`, name, ts, words, dir }).cand_id;

test('the owner\'s Unsure tab lists and counts the real-estate chats to check; a never-list one is on no list', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const id = noteCand(h);
    h.team.addNever({ phone: '966500000092' });
    noteCand(h, { phone: '966500000092', name: 'Never Cand' });
    const boss = await h.boss();
    assert.match(await (await h.get('/dashboard/inbox', { cookie: boss })).text(), /Unsure · 2<\/a>/, 'Umar and Candi, not the never-list chat');
    const res = await h.get('/dashboard/inbox?tab=unsure', { cookie: boss });
    assert.equal(res.status, 200);
    assertLocked(res);
    const html = await res.text();
    assert.match(html, /Real-estate chats to check/);
    assert.ok(html.includes('Candi Date'));
    assert.ok(html.includes('Umar Unsure'), 'the guesses are still there');
    assert.match(html, /شقة · إيجار/);
    assert.ok(html.includes(`action="/v1/admin/inbox/candidates/${id}/move"`));
    assert.ok(html.includes(`action="/v1/admin/inbox/candidates/${id}/dismiss"`));
    assert.ok(!html.includes('Never Cand'));
    assert.ok(!html.includes(CAND_PHONE), 'a masked number only');
  });
});

test('a chat to check that has become a lead meanwhile is on no list and in no count: the lead decides', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    noteCand(h);
    noteCand(h, { phone: '966500000078', name: 'Umar Again' });
    const boss = await h.boss();
    const html = await (await h.get('/dashboard/inbox?tab=unsure', { cookie: boss })).text();
    assert.ok(html.includes('Candi Date'));
    assert.ok(!html.includes('Umar Again'), 'LEAD-U already holds that number');
    assert.match(await (await h.get('/dashboard/inbox', { cookie: boss })).text(), /Unsure · 2<\/a>/, 'Umar once, as the guess he is, and Candi');
  });
});

test('staff never see a chat to check: not on any page, not in any JSON', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    noteCand(h);
    const staff = await h.staff();
    for (const p of ['/dashboard', '/dashboard/inbox', '/dashboard/leads', '/dashboard/inbox?tab=unsure', '/v1/admin/leads']) {
      const res = await h.get(p, { cookie: staff });
      const body = await res.text();
      for (const secret of ['Candi Date', 'candidates/', 'شقة · إيجار', CAND_PHONE, '…0091']) assert.ok(!body.includes(secret), `${p}: ${secret}`);
    }
  });
});

test('the owner moves a chat to check into the inbox: an owner_added lead, in, 30 days of history, off the list, audited by ids only', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const id = noteCand(h);
    const boss = await h.boss();
    const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/move`, {}, { cookie: boss });
    assert.equal(res.status, 303);
    const leadId = /^\/dashboard\/inbox\/(LEAD-[A-Za-z0-9-]+)\?ok=moved$/.exec(res.headers.get('location'))?.[1];
    assert.ok(leadId, res.headers.get('location'));
    const lead = h.db.getLead(leadId);
    assert.equal(lead.phone_e164, CAND_PHONE);
    assert.equal(lead.wa_jid, `${CAND_PHONE}@s.whatsapp.net`);
    assert.equal(lead.name, 'Candi Date');
    assert.equal(lead.match_method, 'owner_added');
    assert.equal(lead.inbox_state, 'in');
    assert.equal(h.spy.history.at(-1).leadId, leadId);
    assert.equal(h.spy.history.at(-1).untilTs - h.spy.history.at(-1).sinceTs, OWNER_HISTORY_MS);
    assert.equal(h.inboxStore.getCandidate(id), null, 'it is a lead now: off the list');
    assert.deepEqual(h.notes, [], 'no new-lead note: the owner vouched for it himself');
    const audited = h.app.audit.recent(50).find((r) => r.action === 'inbox_move');
    assert.equal(audited.target, id);
    assert.deepEqual(audited.meta, { lead_id: leadId });
    assert.equal(audited.user_id, h.owner.user_id);
    const staff = await h.staff();
    assert.ok((await (await h.get('/dashboard/inbox', { cookie: staff })).text()).includes('Candi Date'), 'the team sees it now');
    const again = await h.postForm(`/v1/admin/inbox/candidates/${id}/move`, {}, { cookie: boss });
    assert.equal(again.headers.get('location'), '/dashboard/inbox?tab=unsure&error=candidate_gone');
    const dump = JSON.stringify([h.app.audit.recent(50), h.logs]);
    for (const secret of [CAND_PHONE, '500000091', 'Candi', 'شقة']) assert.ok(!dump.includes(secret), secret);
  });
});

test('every owner join floors the chat\'s history 30 days back: Move, Add chat by phone number, and Move on a chat to check', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const cand = noteCand(h);
    const boss = await h.boss();
    // The routes keep their own clock: the floor is 30 days before the moment it joined.
    const floorOf = (lead) => [lead.history_from, lead.inbox_since - OWNER_HISTORY_MS];
    assert.equal((await h.postForm('/v1/admin/inbox/LEAD-O/move', {}, { cookie: boss })).status, 303);
    assert.deepEqual(...floorOf(h.db.getLead('LEAD-O')), 'Move of a chat that was out');
    assert.equal((await h.postForm('/v1/admin/inbox/add', { phone: '0500000088' }, { cookie: boss })).status, 303);
    assert.deepEqual(...floorOf(h.db.getLeadByPhone('966500000088')), 'Add chat by phone number');
    assert.equal((await h.postForm(`/v1/admin/inbox/candidates/${cand}/move`, {}, { cookie: boss })).status, 303);
    assert.deepEqual(...floorOf(h.db.getLeadByPhone(CAND_PHONE)), 'Move on a chat to check');
    // A chat already in keeps the floor it joined with: a Move or Add of it changes nothing.
    h.db.updateLead('LEAD-A', { history_from: NOW - 3_600_000 - 86_400_000 });
    await h.postForm('/v1/admin/inbox/LEAD-A/move', {}, { cookie: boss });
    await h.postForm('/v1/admin/inbox/add', { phone: '0500000077' }, { cookie: boss });
    assert.equal(h.db.getLead('LEAD-A').history_from, NOW - 3_600_000 - 86_400_000);
  });
});

test('Not a client on a chat to check: off the list, not listed again, audited by its id only', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const id = noteCand(h);
    const boss = await h.boss();
    const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/dismiss`, {}, { cookie: boss });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox?tab=unsure&ok=dismissed');
    assert.equal(h.inboxStore.getCandidate(id).state, 'dismissed');
    assert.equal(h.db.getLeadByPhone(CAND_PHONE), null, 'not a lead either');
    const html = await (await h.get('/dashboard/inbox?tab=unsure&ok=dismissed', { cookie: boss })).text();
    assert.ok(!html.includes('Candi Date'));
    assert.match(html, /<div class="ok">Marked not a client/);
    assert.equal(h.inboxStore.noteCandidate({ phone: CAND_PHONE, ts: NOW + 99_000, words: ['villa'], dir: 'in' }).state, 'dismissed', 'a later message does not ask again');
    const audited = h.app.audit.recent(50).find((r) => r.action === 'inbox_out');
    assert.equal(audited.target, id);
    const again = await h.postForm(`/v1/admin/inbox/candidates/${id}/dismiss`, {}, { cookie: boss });
    assert.equal(again.headers.get('location'), '/dashboard/inbox?tab=unsure&error=candidate_gone');
    assert.ok(!JSON.stringify([h.app.audit.recent(50), h.logs]).includes('500000091'));
  });
});

test('a chat to check whose number is a colleague\'s or on the never list is never moved in, and leaves the list', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const never = noteCand(h, { phone: '966500000092', name: 'Never Cand' });
    const colleague = noteCand(h, { phone: '966500000001', name: 'Sara Again' });
    h.team.addNever({ phone: '966500000092' });
    const boss = await h.boss();
    const leadsBefore = h.db.countLeads();
    for (const id of [never, colleague]) {
      const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/move`, {}, { cookie: boss });
      assert.equal(res.headers.get('location'), '/dashboard/inbox?tab=unsure&error=excluded', id);
      assert.equal(h.inboxStore.getCandidate(id), null, id);
    }
    assert.equal(h.db.countLeads(), leadsBefore);
    assert.deepEqual(h.spy.history, []);
  });
});

test('Move on a chat to check that became an excluded lead after the page was drawn is refused, and the row leaves the list', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const id = noteCand(h);
    const boss = await h.boss();
    assert.ok((await (await h.get('/dashboard/inbox?tab=unsure', { cookie: boss })).text()).includes('Candi Date'), 'the page is drawn with it');
    // Since then a lead holds the candidate's jid, and that lead's own number is on the never
    // list: the candidate's ids alone are not excluded, the lead it has become is.
    seedChat(h, { id: 'LEAD-X', name: 'Stale Page', phone: '966500000096', jid: `${CAND_PHONE}@s.whatsapp.net`, state: 'unsure' });
    h.team.addNever({ phone: '966500000096' });
    const leadsBefore = h.db.countLeads();
    const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/move`, {}, { cookie: boss });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox?tab=unsure&error=excluded');
    assert.equal(h.inboxStore.getCandidate(id), null, 'off the list');
    assert.equal(h.db.countLeads(), leadsBefore, 'no new lead');
    assert.equal(h.db.getLead('LEAD-X').inbox_state, 'unsure', 'the excluded lead is not moved in either');
    assert.equal(h.db.getLeadByPhone(CAND_PHONE), null);
    assert.deepEqual(h.spy.history, [], 'no history is read');
    assert.ok(!h.app.audit.recent(50).some((r) => r.action === 'inbox_move'), 'nothing to audit');
  });
});

test('Move on a chat to check that became a lead after the page was drawn moves that lead in: no second lead', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const id = noteCand(h);
    seedChat(h, { id: 'LEAD-G', name: 'Guess Since', phone: CAND_PHONE, state: 'unsure' });
    const boss = await h.boss();
    const leadsBefore = h.db.countLeads();
    const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/move`, {}, { cookie: boss });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox/LEAD-G?ok=moved');
    assert.equal(h.db.countLeads(), leadsBefore, 'merged into the lead that holds the number');
    assert.equal(h.db.getLead('LEAD-G').inbox_state, 'in');
    assert.equal(h.inboxStore.getCandidate(id), null);
  });
});

test('move and Not a client on a chat to check are the owner\'s alone', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const id = noteCand(h);
    const staff = await h.staff();
    for (const what of ['move', 'dismiss']) {
      const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/${what}`, {}, { cookie: staff });
      assert.equal(res.status, 403, what);
      assertLocked(res);
      assert.deepEqual(await res.json(), { error: 'owner_only' }, what);
      assert.ok(h.logs.some((e) => e.evt === 'dash.owner_only' && e.path === `/v1/admin/inbox/candidates/:id/${what}`), what);
    }
    assert.equal(h.inboxStore.getCandidate(id).state, 'open');
    assert.equal(h.db.getLeadByPhone(CAND_PHONE), null);
    assert.deepEqual(h.spy.history, []);
  });
});

test('a number added to the never list or the team leaves the list of chats to check at once', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const never = noteCand(h, { phone: '966500000093', name: 'Cousin' });
    const hire = noteCand(h, { phone: '966500000094', name: 'New Hire' });
    const boss = await h.boss();
    assert.equal((await h.postForm('/v1/admin/never', { phone: '0500000093' }, { cookie: boss })).headers.get('location'), '/dashboard/team?ok=never_added');
    assert.equal(h.inboxStore.getCandidate(never), null);
    assert.equal((await h.postForm('/v1/admin/team', { name: 'New Hire', phone: '0500000094', role: 'staff' }, { cookie: boss })).headers.get('location'), '/dashboard/team?ok=added');
    assert.equal(h.inboxStore.getCandidate(hire), null);
  });
});

test('Add chat by phone number, and Move on a lead, take that chat off the list of chats to check at once', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const added = noteCand(h, { phone: '966500000095', name: 'Added Later' });
    const umar = noteCand(h, { phone: '966500000078', name: 'Umar Again' });
    const boss = await h.boss();
    assert.match((await h.postForm('/v1/admin/inbox/add', { phone: '0500000095' }, { cookie: boss })).headers.get('location'), /\?ok=added$/);
    assert.equal(h.inboxStore.getCandidate(added), null, 'a lead now: the row is gone, not only hidden');
    assert.equal((await h.postForm('/v1/admin/inbox/LEAD-U/move', {}, { cookie: boss })).headers.get('location'), '/dashboard/inbox/LEAD-U?ok=moved');
    assert.equal(h.inboxStore.getCandidate(umar), null, 'LEAD-U holds that number, and it is in now');
  });
});

test('a chat to check with no phone number, a lid alone or a WhatsApp channel, is never moved in, and leaves the list', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const note = (ids) => h.inboxStore.noteCandidate({ ...ids, name: 'No Number', ts: NOW + 10_000, words: ['villa'], dir: 'in' }).cand_id;
    const lidOnly = note({ lid: '272516946294599@lid' });
    const channel = note({ phone: '12036302524', jid: '12036302524@newsletter' });
    const boss = await h.boss();
    const leadsBefore = h.db.countLeads();
    for (const id of [lidOnly, channel]) {
      const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/move`, {}, { cookie: boss });
      assert.equal(res.headers.get('location'), '/dashboard/inbox?tab=unsure&error=candidate_no_number', id);
      assert.equal(h.inboxStore.getCandidate(id), null, id);
    }
    assert.equal(h.db.countLeads(), leadsBefore);
    assert.deepEqual(h.spy.history, []);
  });
});
