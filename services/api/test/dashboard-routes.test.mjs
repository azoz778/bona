/**
 * The dashboard through the real HTTP server: the login round trip, the pages, the
 * admin JSON and every gate in front of the writes. Nothing external is contacted —
 * the WhatsApp sender is a spy, and the code is read back out of the message the
 * owner would have received.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.mjs';
import { openDb } from '../lib/db.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';
import { leadsPage, spendPage } from '../lib/dashboard/render.mjs';
import http from 'node:http';
import { createDashboardRoutes } from '../lib/dashboard/routes.mjs';
import { createTeam } from '../lib/team.mjs';
import { createAudit } from '../lib/audit.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { addTask, tasksForLead, bookViewing } from '../lib/lead-tasks.mjs';

const TOKEN = 'a'.repeat(32);
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'";
/** An HTML page's CSP (P3-1): the same, plus our own script, worker, fetches and manifest — nothing inline. */
const PAGE_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'";
const OWN_SCRIPT = '<script src="/dashboard/app.js" defer></script>';
/** The one script a signed-in page may carry is our own app.js; nothing else, nothing inline. */
const onlyOurScript = (html) => !/<script/i.test(html.split(OWN_SCRIPT).join(''));

/** Every dashboard and admin answer, whatever it says, carries the same four headers; a page's CSP opens self only. */
function assertLocked(res) {
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = String(res.headers.get('content-type') ?? '').startsWith('text/html');
  assert.equal(res.headers.get('content-security-policy'), html ? PAGE_CSP : CSP);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  // NOT `no-referrer`: that made Chrome send `Origin: null` on the login form's own
  // same-origin POST, and `sameOrigin()` refused it — the owner could not log in at
  // all. `same-origin` still strips the referrer from every cross-site request.
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
}

async function withDash(overrides = {}, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-dash-'));
  const db = openDb(':memory:');
  const sent = [];
  const sentTo = [];
  const app = createApp({
    config: {
      port: 0, host: '127.0.0.1', siteUrl: 'https://bona.azoz.uk', publicApi: 'https://bona-api.azoz.uk',
      dataDir, inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS, toolToken: TOKEN,
      retellApiKey: 'test', retellMock: true, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice',
      maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, env: {}, ids: {}, version: '1.0.0',
      toolRatePerMin: 600, toolAuthFailRatePerMin: 10, allowQueryToken: false, trustedProxies: [],
      maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40,
      dashCookieDays: 30,
      metaPixelId: '111', metaCapiToken: 'meta-token', ga4MeasurementId: '', ga4ApiSecret: '',
      snapPixelId: '', snapCapiToken: '',
      ...(overrides.config ?? {}),
    },
    inventory: overrides.inventory ?? inventory,
    db,
    probeRetell: overrides.probeRetell ?? (async () => 'ok'),
    sendWhatsApp: overrides.sendWhatsApp ?? (async (text) => { sent.push(text); return { ok: true }; }),
    sendCode: overrides.sendCode ?? (async ({ jid, text }) => { sent.push(text); sentTo.push(jid); return { ok: true }; }),
    log: overrides.log ?? (() => {}),
    ...(overrides.app ?? {}),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  /** Every `Set-Cookie` on a response, as a browser would see them. */
  const cookiesOf = (res) => res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  /** One named cookie's value, or null when the response cleared or never set it. */
  const cookieValue = (res, name) => {
    for (const c of cookiesOf(res)) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      if (k.trim() !== name) continue;
      return attrs.some((a) => a.trim() === 'Max-Age=0') ? null : v;
    }
    return undefined;
  };

  const go = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const get = (p, { cookie, headers } = {}) => go(p, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  const postForm = (p, fields, { cookie, headers } = {}) => go(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: new URLSearchParams(fields).toString(),
  });
  const postJson = (p, body, { cookie, headers } = {}) => go(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });

  /**
   * Ask for a code the way a browser does, and keep what the browser would keep: the
   * six digits from the "phone" and the `bona_dash_try` nonce from the response.
   */
  async function askForCode({ phone = '0593296933', ...opts } = {}) {
    const before = sent.length;
    const res = await postForm('/dashboard/login/code', { _dash: '1', phone }, opts);
    await app.dashboard?.auth?.flush?.();
    const code = sent.length > before ? (/(\d{6})/.exec(sent.at(-1) ?? '')?.[1] ?? null) : null;
    const nonce = cookieValue(res, 'bona_dash_try');
    return { res, code, nonce, tryCookie: nonce ? `bona_dash_try=${nonce}` : '' };
  }

  /** The whole login: ask for a code, read it off the "phone", type it back. */
  async function login({ phone = '0593296933' } = {}) {
    const asked = await askForCode({ phone });
    assert.equal(asked.res.status, 303, 'the code request redirects to the code form');
    assert.ok(asked.code, 'no code was sent for that login');
    assert.ok(asked.nonce, 'the code request must hand the browser a try nonce');
    const verified = await postForm('/dashboard/login/verify', { _dash: '1', code: asked.code }, { cookie: asked.tryCookie });
    const session = cookieValue(verified, 'bona_dash');
    assert.ok(session, 'the verify step must set the session cookie');
    return { cookie: `bona_dash=${session}`, code: asked.code, nonce: asked.nonce, res: verified };
  }

  try {
    await fn({ app, db, base, get, postForm, postJson, login, askForCode, cookiesOf, cookieValue, sent, sentTo });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** A lead with a session behind it, so the journey and the fan-out have something to work with. */
/**
 * `phone` and `inboxState` for a lead a staff member may act on: staff see only the Bona
 * inbox's leads (`in`, and not a colleague's or a never-list number, such as the owner's own).
 */
function seedLead(db, { id = 'LEAD-20260908-aaaa0001', name = 'Sara Ahmed', now = Date.now(), phone = '966593296933', inboxState = null } = {}) {
  db.upsertSession({
    session_id: 'sess-aaa1', anon_id: 'a'.repeat(32), ref: 'K7Q2XR', started: now - 3600_000, last_seen: now, pages: 3, locale: 'en',
    first_touch: { ts: now - 3600_000, utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_id: '1203' },
    last_touch: { ts: now, utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_id: '1203' },
    ip: '2.2.2.2', ua: 'iPhone', country: 'SA', consent_analytics: 1, consent_ads: 1,
  });
  db.insertLead({
    lead_id: id, created: now - 3600_000, updated: now, phone_e164: phone, name,
    channel: 'whatsapp', source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203',
    match_method: 'ref', session_id: 'sess-aaa1', anon_id: 'a'.repeat(32), listing_id: 'BONA-001',
    stage: 'new', stage_ts: now - 3600_000, consent_ads: 1, consent_analytics: 1,
    inbox_state: inboxState, inbox_since: inboxState === 'in' ? now - 3600_000 : null,
  });
  db.setStage(id, 'new', { actor: 'system', now: now - 3600_000 });
  return id;
}

/* ---------------- the gate ---------------- */

test('a logged-out browser is sent to the login, and the JSON API says 401', async () => {
  await withDash({}, async ({ get, postJson }) => {
    for (const p of ['/dashboard', '/dashboard/leads', '/dashboard/listings', '/dashboard/spend', '/dashboard/integrations']) {
      const res = await get(p);
      assert.equal(res.status, 302, p);
      assert.equal(res.headers.get('location'), '/dashboard/login', p);
      assertLocked(res);
    }
    for (const p of ['/v1/admin/stats', '/v1/admin/leads', '/v1/admin/listings']) {
      const res = await get(p);
      assert.equal(res.status, 401, p);
      assert.deepEqual(await res.json(), { error: 'unauthorised' });
      assertLocked(res);
    }
    const write = await postJson('/v1/admin/spend', { day: '2026-09-08', platform: 'meta', spend_sar: 10 }, { headers: { 'X-Bona-Dash': '1' } });
    assert.equal(write.status, 401, 'a write with no cookie never reaches the store');
  });
});

test('an unguessable cookie is not a session', async () => {
  await withDash({}, async ({ get }) => {
    const res = await get('/dashboard', { cookie: `bona_dash=${'f'.repeat(32)}` });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/dashboard/login');
  });
});

/* ---------------- login ---------------- */

test('the login round trip: ask, receive on WhatsApp, type it back', async () => {
  await withDash({}, async ({ get, login, sent }) => {
    const page = await get('/dashboard/login');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assertLocked(page);
    const html = await page.text();
    assert.match(html, /Send me a code/);
    assert.ok(!/<script/i.test(html), 'the login page ships no script at all: app.js rides only on a signed-in page');

    const { cookie, res } = await login();
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard');
    const all = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')];
    const session = all.find((c) => c.startsWith('bona_dash='));
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) {
      assert.ok(session.includes(flag), `${flag} missing from ${session}`);
    }
    assert.ok(all.some((c) => c.startsWith('bona_dash_try=') && c.includes('Max-Age=0')),
      'the spent try nonce is cleared with the same response that opens the session');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^Bona dashboard code: \d{6} \(valid 10 min\)$/);

    const overview = await get('/dashboard', { cookie });
    assert.equal(overview.status, 200);
    const body = await overview.text();
    assert.match(body, /Needs a reply/, 'the overview leads with the queue, not a title');
    assert.match(body, /<svg/, 'the daily strip is inline SVG, not a CDN chart library');
    assert.ok(!body.includes('cdn'), 'nothing is loaded from a CDN');
  });
});

test('five wrong codes from the browser that asked burn the real one', async () => {
  await withDash({}, async ({ postForm, askForCode, cookieValue }) => {
    const { code, tryCookie } = await askForCode();
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i += 1) {
      const res = await postForm('/dashboard/login/verify', { _dash: '1', code: wrong }, { cookie: tryCookie });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard/login?step=code&error=bad_code', `guess ${i + 1}`);
    }
    const real = await postForm('/dashboard/login/verify', { _dash: '1', code }, { cookie: tryCookie });
    assert.equal(real.headers.get('location'), '/dashboard/login?step=code&error=attempts');
    assert.equal(cookieValue(real, 'bona_dash'), undefined, 'no session cookie is handed out');
  });
});

test('a stranger cannot burn the code the owner is holding', async () => {
  await withDash({}, async ({ postForm, askForCode, get }) => {
    const owner = await askForCode();

    // No nonce, a forged one, over and over — kept under the route's own 20-a-minute
    // guessing cap so that what is being tested here is the binding, not that limiter.
    // The sender is capped at one code a minute globally, so if these guesses counted
    // against the owner's code he could never win the race back.
    for (let i = 0; i < 8; i += 1) {
      const bare = await postForm('/dashboard/login/verify', { _dash: '1', code: '000000' });
      assert.equal(bare.headers.get('location'), '/dashboard/login?step=code&error=no_request');
      const forged = await postForm('/dashboard/login/verify', { _dash: '1', code: '000000' }, { cookie: `bona_dash_try=${'f'.repeat(32)}` });
      assert.equal(forged.headers.get('location'), '/dashboard/login?step=code&error=no_request');
    }

    const real = await postForm('/dashboard/login/verify', { _dash: '1', code: owner.code }, { cookie: owner.tryCookie });
    assert.equal(real.headers.get('location'), '/dashboard', 'the owner still gets in');
    const session = (real.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('bona_dash='));
    assert.ok(session);
    assert.equal((await get('/dashboard', { cookie: session.split(';')[0] })).status, 200);
  });
});

test('two codes then a wrong one on the first: the same redirect and cookies for a member and a stranger', async () => {
  const run = async (phone) => {
    let out = null;
    await withDash({}, async ({ postForm, askForCode, cookiesOf }) => {
      const first = await askForCode({ phone });
      const second = await askForCode({ phone });
      assert.ok(first.nonce && second.nonce);
      const res = await postForm('/dashboard/login/verify', { _dash: '1', code: '000000' }, { cookie: first.tryCookie });
      out = { status: res.status, location: res.headers.get('location'), cookies: cookiesOf(res) };
    });
    return out;
  };
  const member = await run('0593296933');
  const stranger = await run('0511111111');
  assert.equal(member.location, '/dashboard/login?step=code&error=used');
  assert.deepEqual(stranger, member);
});

test('guessing at the login is capped a minute at a time', async () => {
  await withDash({}, async ({ postForm, askForCode }) => {
    const { tryCookie } = await askForCode();
    const seen = new Set();
    for (let i = 0; i < 24; i += 1) {
      const res = await postForm('/dashboard/login/verify', { _dash: '1', code: '000000' }, { cookie: tryCookie });
      seen.add(res.headers.get('location'));
    }
    assert.ok(seen.has('/dashboard/login?step=code&error=rate_limited'), 'the twenty-first guess in a minute is refused outright');
  });
});

test('a code cannot be redeemed from a browser that did not ask for it', async () => {
  await withDash({}, async ({ postForm, askForCode, cookieValue }) => {
    const { code } = await askForCode();
    // The digits alone are not enough: whoever shoulder-surfed the WhatsApp still needs
    // the nonce, and that only ever existed as an HttpOnly cookie on the asker's browser.
    const res = await postForm('/dashboard/login/verify', { _dash: '1', code });
    assert.equal(res.headers.get('location'), '/dashboard/login?step=code&error=no_request');
    assert.equal(cookieValue(res, 'bona_dash'), undefined);
  });
});

test('a login POST from someone else\'s page is refused', async () => {
  await withDash({}, async ({ postForm, sent }) => {
    for (const origin of ['https://evil.example', 'null']) {
      const res = await postForm('/dashboard/login/code', { _dash: '1' }, { headers: { Origin: origin } });
      assert.equal(res.headers.get('location'), '/dashboard/login?error=forbidden', origin);
    }
    assert.equal(sent.length, 0, 'no WhatsApp is sent on behalf of a foreign page');
  });
});

test('logout ends the session on the server, not just in the browser', async () => {
  await withDash({}, async ({ get, postForm, login }) => {
    const { cookie } = await login();

    // A GET only offers the button: with SameSite=Lax the cookie rides a top-level
    // navigation, so a link on any page could otherwise log the owner out.
    const offered = await get('/dashboard/logout', { cookie });
    assert.equal(offered.status, 200);
    const offer = await offered.text();
    assert.match(offer, /Log out of the dashboard on this device\?/);
    assert.ok(!/<script/i.test(offer), 'the logout page ships no script at all: app.js rides only on a signed-in page');
    assert.equal((await get('/dashboard', { cookie })).status, 200, 'still signed in');

    const out = await postForm('/dashboard/logout', { _dash: '1' }, { cookie });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get('location'), '/dashboard/login');
    assert.ok((out.headers.getSetCookie?.()[0] ?? '').includes('Max-Age=0'));
    const after = await get('/dashboard', { cookie });
    assert.equal(after.status, 302, 'the same cookie is worthless once logged out');
  });
});

test('a logout POST without the marker or from a foreign page does nothing', async () => {
  await withDash({}, async ({ get, postForm, login }) => {
    const { cookie } = await login();
    const noMarker = await postForm('/dashboard/logout', {}, { cookie });
    assert.equal(noMarker.headers.get('location'), '/dashboard/login?error=forbidden');
    const foreign = await postForm('/dashboard/logout', { _dash: '1' }, { cookie, headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.headers.get('location'), '/dashboard/login?error=forbidden');
    assert.equal((await get('/dashboard', { cookie })).status, 200, 'the session survived both');
  });
});

/* ---------------- pages ---------------- */

test('every page renders for a signed-in owner', async () => {
  await withDash({}, async ({ db, get, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    for (const [p, needle] of [
      ['/dashboard', /Where leads come from/],
      ['/dashboard/leads', /Leads/],
      [`/dashboard/leads/${id}`, /Journey/],
      ['/dashboard/listings', /Ad licence/],
      ['/dashboard/spend', /Attribution coverage/],
      ['/dashboard/integrations', /Owner checklists/],
    ]) {
      const res = await get(p, { cookie });
      assert.equal(res.status, 200, p);
      assertLocked(res);
      const html = await res.text();
      assert.match(html, needle, p);
      assert.ok(onlyOurScript(html), `${p}: no script but our own app.js`);
      assert.equal(html.split(OWN_SCRIPT).length, 2, 'exactly one script tag, ours');
    }
    const missing = await get('/dashboard/leads/LEAD-nope', { cookie });
    assert.equal(missing.status, 404);
  });
});

/**
 * A request sent exactly as written: `fetch` normalises `..`, and this test needs the
 * server to see the literal target. Resolves once the whole body is in.
 */
function rawRequest(base, { path: target, method = 'GET' }) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: hostname, port, path: target, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the app files are served signed out, with their types, never cached; a POST is refused; nothing but the six literal paths', async () => {
  await withDash({}, async (h) => {
    const files = [
      ['/dashboard/sw.js', 'text/javascript; charset=utf-8'],
      ['/dashboard/app.js', 'text/javascript; charset=utf-8'],
      ['/dashboard/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
      ['/dashboard/icon-192.png', 'image/png'],
      ['/dashboard/icon-512.png', 'image/png'],
      ['/dashboard/apple-touch-icon.png', 'image/png'],
    ];
    for (const [p, type] of files) {
      const res = await h.get(p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('content-type'), type, p);
      assert.equal(res.headers.get('cache-control'), 'no-store', p);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
      assert.ok((await res.arrayBuffer()).byteLength > 0, p);
    }
    assert.equal((await h.get('/dashboard/sw.js')).headers.get('content-security-policy'), "default-src 'none'; connect-src 'self'; img-src 'self'");
    assert.equal((await h.get('/dashboard/app.js')).headers.get('content-security-policy'), CSP, 'only the worker gets its own policy');

    // HEAD: the same headers, no body.
    const got = await rawRequest(h.base, { path: '/dashboard/app.js' });
    const head = await rawRequest(h.base, { path: '/dashboard/app.js', method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], got.headers['content-length'], 'HEAD states the same length as GET');
    assert.ok(Number(got.headers['content-length']) > 0);
    assert.equal(head.body.length, 0, 'HEAD sends no body');

    const post = await rawRequest(h.base, { path: '/dashboard/sw.js', method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');

    // Sent literally (fetch would normalise the `..`): none of these is a file, so each is
    // an ordinary page, which needs a login.
    for (const target of ['/dashboard/sw.js/../team', '/dashboard/sw%2Ejs', '/dashboard/SW.js', '/dashboard/sw.js/']) {
      const res = await rawRequest(h.base, { path: target });
      assert.equal(res.status, 302, target);
      assert.equal(res.headers.location, '/dashboard/login', target);
    }
  });
});

test('a phone number is masked in the list and whole on the record', async () => {
  await withDash({}, async ({ db, get, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    const list = await (await get('/dashboard/leads', { cookie })).text();
    // Masking was removed deliberately: this is a private, OTP-gated, single-user
    // dashboard, so hiding the owner's own leads' numbers from him protected nobody
    // and cost a page load before every call. The number IS the action here.
    assert.match(list, /\+966 59 329 6933/, 'the list shows the number so it can be tapped');
    assert.match(list, /href="tel:\+966593296933"/, 'and it is a one-tap call link');
    assert.match(list, /href="https:\/\/wa\.me\/966593296933"/, 'and a one-tap WhatsApp link');

    const detail = await (await get(`/dashboard/leads/${id}`, { cookie })).text();
    assert.match(detail, /\+966 59 329 6933/, 'the record shows the number the owner has to dial');
  });
});

test('a lead named like an attack renders as text, never as markup', async () => {
  await withDash({}, async ({ db, get, login }) => {
    const nasty = '<script>alert(1)</script>';
    db.insertLead({
      lead_id: 'LEAD-20260908-bbbb0002', created: Date.now(), updated: Date.now(), phone_e164: '966500000002',
      name: nasty, notes: '"><img src=x onerror=alert(2)>', channel: 'whatsapp', source: nasty, stage: 'new', stage_ts: Date.now(),
    });
    const { cookie } = await login();
    for (const p of ['/dashboard/leads', '/dashboard/leads/LEAD-20260908-bbbb0002']) {
      const html = await (await get(p, { cookie })).text();
      assert.ok(!html.includes(nasty), `${p} rendered the raw tag`);
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), `${p} did not escape the name`);
      assert.ok(!html.includes('<img src=x'), `${p} let a tag through`);
    }
    // The notes are only printed on the record, and that is where the quote that would
    // break out of an attribute has to be neutralised.
    const detail = await (await get('/dashboard/leads/LEAD-20260908-bbbb0002', { cookie })).text();
    assert.ok(detail.includes('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;'), 'the note did not have its quote escaped');
  });
});

test('the leads list honours the stage and search filters', async () => {
  await withDash({}, async ({ db, get, login }) => {
    seedLead(db, { id: 'LEAD-20260908-cccc0001', name: 'Sara Ahmed' });
    db.insertLead({
      lead_id: 'LEAD-20260908-cccc0002', created: Date.now(), updated: Date.now(), phone_e164: '966500000009',
      name: 'Khalid Omar', channel: 'form', source: 'form', stage: 'won', stage_ts: Date.now(),
    });
    const { cookie } = await login();

    // The stage rail above the list shows every lead whatever the filter says, so
    // asserting on the whole page would pass with the filter ripped out. Only the
    // table is filtered. (The old marker was `<h2>List</h2>`; the redesign renders
    // the table inside a <details> labelled "Full table". indexOf(-1) silently
    // slices the last character, so a stale marker here passes as an empty string.)
    const MARKER = 'Full table';
    const listOnly = (html) => {
      const i = html.indexOf(MARKER);
      assert.ok(i !== -1, `the list section marker ${MARKER} is missing from the page`);
      return html.slice(i);
    };

    const won = listOnly(await (await get('/dashboard/leads?stage=won', { cookie })).text());
    assert.match(won, /Khalid Omar/);
    assert.ok(!won.includes('Sara Ahmed'), 'a lead in another stage is not in the filtered list');

    const searched = listOnly(await (await get('/dashboard/leads?q=khalid', { cookie })).text());
    assert.match(searched, /Khalid Omar/);
    assert.ok(!searched.includes('Sara Ahmed'));

    // …and the JSON, where there is no board to hide behind.
    const byStage = await (await get('/v1/admin/leads?stage=won', { cookie })).json();
    assert.deepEqual(byStage.leads.map((l) => l.name), ['Khalid Omar']);
    const byQuery = await (await get('/v1/admin/leads?q=sara', { cookie })).json();
    assert.deepEqual(byQuery.leads.map((l) => l.name), ['Sara Ahmed']);
    const nonsense = await (await get('/v1/admin/leads?stage=not_a_stage', { cookie })).json();
    assert.equal(nonsense.count, 2, 'an unknown stage is no filter at all, not an error');
  });
});

test('the board counts the whole pipeline even when it can only show part of it', () => {
  // Past a few hundred leads the cards become a slice. The number on the heading is a
  // COUNT(*), so it must keep telling the truth and say what it is not showing.
  const lead = (id) => ({ lead_id: id, name: id, phone_e164: '966500000000', stage: 'contacted', stage_ts: Date.now(), created: Date.now() });
  const html = leadsPage({
    board: { contacted: [lead('a'), lead('b')] },
    counts: { new: 0, contacted: 517, qualified: 0, viewing: 0, offer: 0, negotiation: 0, won: 3, lost: 0 },
    leads: [], total: 520,
  });
  // The 8-column board was replaced by a stage rail, but the invariant it protected
  // still holds: the rail reports COUNT(*) for the whole pipeline, not the number of
  // cards this page happened to render. Two cards, 517 in the stage — it must say 517.
  assert.match(html, /<b>517<\/b>\s*<span>Contacted<\/span>/,
    'the rail reports the whole stage, not the handful of rendered cards');
  assert.match(html, /<b>3<\/b>\s*<span>Won<\/span>/,
    'a stage with no rendered cards still reports its count');
  assert.match(html, /<b>520<\/b>\s*<span>All<\/span>/, 'and the total is the pipeline total');
  // Stages that are genuinely empty are omitted rather than drawn as a wall of dashes.
  assert.ok(!/<span>Qualified<\/span>/.test(html), 'an empty stage is not rendered at all');
});

test('the reporting window is clamped, whatever the query string says', async () => {
  await withDash({}, async ({ db, get, login }) => {
    seedLead(db);
    const { cookie } = await login();
    for (const [q, expected] of [['?days=7', 7], ['?days=999', 90], ['?days=-3', 1], ['?days=abc', 14], ['', 14], ['?days=0', 14]]) {
      const body = await (await get(`/v1/admin/stats${q}`, { cookie })).json();
      assert.equal(body.days, expected, `days${q}`);
      assert.equal(body.daily.length, expected, `daily length for ${q}`);
    }
    for (const q of ['?days=999', '?days=-3', '?days=abc']) {
      assert.equal((await get(`/dashboard${q}`, { cookie })).status, 200, `the page survives ${q}`);
    }
  });
});

/* ---------------- admin JSON ---------------- */

test('GET /v1/admin/stats answers with every section', async () => {
  await withDash({}, async ({ db, get, login }) => {
    seedLead(db);
    const { cookie } = await login();
    const res = await get('/v1/admin/stats?days=7', { cookie });
    assert.equal(res.status, 200);
    assertLocked(res);
    const body = await res.json();
    assert.equal(body.days, 7);
    assert.equal(body.daily.length, 7);
    assert.deepEqual(Object.keys(body.daily[0]).sort(), ['day', 'leads', 'sessions', 'viewings', 'wa_clicks']);
    assert.ok(Array.isArray(body.sources) && Array.isArray(body.match_quality));
    assert.equal(body.pipeline.length, 8);
    assert.deepEqual(Object.keys(body.response_times).sort(), ['count', 'median_min', 'p90_min']);
    assert.equal(body.totals.leads, 1);
    const meta = body.sources.find((s) => s.source === 'meta');
    assert.equal(meta.last_touch_leads, 1);
    assert.equal(meta.first_touch_leads, 1);
  });
});

test('GET /v1/admin/leads masks the phones; the single record does not', async () => {
  await withDash({}, async ({ db, get, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    const list = await (await get('/v1/admin/leads?limit=10', { cookie })).json();
    assert.equal(list.count, 1);
    assert.equal(list.leads[0].phone_e164, '…6933');
    assert.equal(list.leads[0].phone_masked, true);

    const one = await (await get(`/v1/admin/leads/${id}`, { cookie })).json();
    assert.equal(one.lead.phone_e164, '966593296933');
    assert.ok(Array.isArray(one.journey));
    assert.ok(one.stage_history.length >= 1);

    assert.equal((await get('/v1/admin/leads/LEAD-nope', { cookie })).status, 404);
    const listings = await (await get('/v1/admin/listings', { cookie })).json();
    assert.ok(listings.listings.length > 0);
    assert.ok('flags' in listings.listings[0]);
  });
});

/* ---------------- writes ---------------- */

test('a stage change without the dashboard marker is refused', async () => {
  await withDash({}, async ({ db, postJson, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    const res = await postJson(`/v1/admin/leads/${id}/stage`, { stage: 'qualified' }, { cookie });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'forbidden');
    assert.equal(db.getLead(id).stage, 'new', 'nothing moved');
  });
});

test('a stage change from a foreign origin is refused before the body is read', async () => {
  await withDash({}, async ({ db, postJson, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    const res = await postJson(`/v1/admin/leads/${id}/stage`, { stage: 'won' }, { cookie, headers: { 'X-Bona-Dash': '1', Origin: 'https://bona.azoz.uk' } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'forbidden_origin');
    assert.equal(db.getLead(id).stage, 'new');
  });
});

/**
 * The bug this guards against, in the two places it lived.
 *
 * 1. `Referrer-Policy: no-referrer` left Chrome with no referrer to derive an origin
 *    from, so it sent `Origin: null` on the login form's own same-origin POST. That is
 *    byte-identical to a sandboxed iframe, `sameOrigin()` refused it, and the owner
 *    could not log in from any browser. Reproduced in a real Chrome and confirmed
 *    against a local server: `no-referrer` -> `Origin: null`, `same-origin` -> the
 *    page's own origin.
 * 2. `sameOrigin()` used to refuse on ANY unfamiliar `Referer`, which also refused a
 *    click through from the marketing site or an in-app browser.
 *
 * `Origin: null` must still be refused — this asserts the header no longer provokes it
 * rather than that the check has been loosened to accept it.
 */
test('the login is reachable from the owner\'s own browser, and only from it', async () => {
  await withDash({}, async ({ get, postForm, base }) => {
    const errorOf = (res) =>
      new URL(res.headers.get('location'), 'https://x').searchParams.get('error');

    // The header that caused it: anything but `no-referrer`, or Chrome sends null.
    const page = await get('/dashboard/login');
    assert.equal(page.headers.get('referrer-policy'), 'same-origin');

    // The owner's real POST: its own origin, whatever referrer the arrival had.
    const own = await postForm('/dashboard/login/code', { _dash: '1' },
      { headers: { Origin: base, Referer: 'https://t.me/' } });
    assert.notEqual(errorOf(own), 'forbidden');

    // Still refused: a foreign origin, an opaque origin, a foreign referer.
    for (const [label, headers] of [
      ['attacker page', { Origin: 'https://evil.example' }],
      ['sandboxed iframe', { Origin: 'null' }],
      ['translate proxy', { Origin: 'https://api-bona--real--estate-com.translate.goog' }],
      ['foreign referer, no origin', { Referer: 'https://evil.example/x' }],
    ]) {
      const res = await postForm('/dashboard/login/code', { _dash: '1' }, { headers });
      assert.equal(errorOf(res), 'forbidden', label);
    }
  });
});

test('a stage change with the marker moves the lead, writes history and queues the fan-out', async () => {
  await withDash({}, async ({ db, postJson, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    const res = await postJson(`/v1/admin/leads/${id}/stage`, { stage: 'won', value_sar: 2_400_000, note: 'Signed today' },
      { cookie, headers: { 'X-Bona-Dash': '1' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.dests, ['meta', 'ga4', 'snap']);

    const lead = db.getLead(id);
    assert.equal(lead.stage, 'won');
    assert.equal(lead.value_sar, 2_400_000);

    const history = db.stageHistory(id);
    assert.equal(history.at(-1).stage, 'won');
    assert.equal(history.at(-1).actor, 'Abdulaziz', 'the actor is the signed-in person, not a role');
    assert.equal(history.at(-1).note, 'Signed today');

    const event = db.getEvent(body.event_id);
    assert.equal(event.name, 'lead_stage');
    assert.deepEqual(event.props, { stage: 'won', value_sar: 2_400_000, _consent_ads: true, _consent_analytics: true });
    assert.equal(event.lead_id, id);

    const queued = db.db.prepare('SELECT dest, status FROM fanout WHERE event_id = ? ORDER BY dest').all(body.event_id);
    assert.deepEqual(queued.map((r) => r.dest), ['ga4', 'meta', 'snap']);
    assert.ok(queued.every((r) => r.status === 'pending'));
  });
});

test('the HTML stage form redirects back to the lead it moved', async () => {
  await withDash({}, async ({ db, postForm, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    const res = await postForm(`/v1/admin/leads/${id}/stage`, { _dash: '1', stage: 'viewing', value_sar: '' }, { cookie });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/dashboard/leads/${id}?ok=stage`);
    assert.equal(db.getLead(id).stage, 'viewing');
    assert.equal(db.getLead(id).value_sar, null, 'an empty value box is not a zero deal');
  });
});

test('an unknown stage is refused and the lead stays where it was', async () => {
  await withDash({}, async ({ db, postJson, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    const res = await postJson(`/v1/admin/leads/${id}/stage`, { stage: 'closed_maybe' }, { cookie, headers: { 'X-Bona-Dash': '1' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_stage');
    assert.equal(db.getLead(id).stage, 'new');
  });
});

test('a note lands on the lead and in its journey', async () => {
  await withDash({}, async ({ db, postJson, get, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    const res = await postJson(`/v1/admin/leads/${id}/note`, { note: 'Wants a sea view' }, { cookie, headers: { 'X-Bona-Dash': '1' } });
    assert.equal(res.status, 200);
    assert.match(db.getLead(id).notes, /Wants a sea view/);
    const journey = (await (await get(`/v1/admin/leads/${id}`, { cookie })).json()).journey;
    const note = journey.find((e) => e.kind === 'note');
    assert.deepEqual(note.text, 'Wants a sea view');

    const empty = await postJson(`/v1/admin/leads/${id}/note`, { note: '   ' }, { cookie, headers: { 'X-Bona-Dash': '1' } });
    assert.equal(empty.status, 400);
  });
});

test('spend is upserted per day, platform and campaign', async () => {
  await withDash({}, async ({ db, postForm, postJson, login }) => {
    const { cookie } = await login();
    const first = await postJson('/v1/admin/spend',
      { day: '2026-09-07', platform: 'meta', campaign_id: '1203', campaign_name: 'Villas Sept', spend_sar: 3000, clicks: 120, impressions: 40_000 },
      { cookie, headers: { 'X-Bona-Dash': '1' } });
    assert.equal(first.status, 200);
    assert.deepEqual(db.listSpend(), [{
      day: '2026-09-07', platform: 'meta', campaign_id: '1203', campaign_name: 'Villas Sept',
      spend_sar: 3000, clicks: 120, impressions: 40_000,
      source_spend: null, source_currency: null, imported_at: null,
    }]);

    // The same three keys again: a corrected figure replaces the old one.
    const again = await postForm('/v1/admin/spend',
      { _dash: '1', day: '2026-09-07', platform: 'meta', campaign_id: '1203', campaign_name: 'Villas Sept', spend_sar: '3500', clicks: '130', impressions: '41000' },
      { cookie });
    assert.equal(again.status, 303);
    assert.equal(again.headers.get('location'), '/dashboard/spend?ok=1');
    assert.equal(db.listSpend().length, 1);
    assert.equal(db.listSpend()[0].spend_sar, 3500);

    const bad = await postJson('/v1/admin/spend', { day: 'yesterday', platform: 'meta', spend_sar: 10 }, { cookie, headers: { 'X-Bona-Dash': '1' } });
    assert.equal(bad.status, 400);
    assert.equal(db.listSpend().length, 1);
  });
});

/* ---------------- shape of the surface ---------------- */

test('the dashboard is not CORS-enabled and does not answer other methods', async () => {
  await withDash({}, async ({ get, login, base }) => {
    const { cookie } = await login();
    const res = await get('/dashboard', { cookie, headers: { Origin: 'https://bona.azoz.uk' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no origin may read the owner\'s pipeline');

    const wrongMethod = await fetch(`${base}/v1/admin/leads`, { method: 'DELETE', headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(wrongMethod.status, 405);
    const unknown = await fetch(`${base}/v1/admin/nope`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(unknown.status, 404);
  });
});

test('an oversized or wrongly typed write body is refused', async () => {
  await withDash({}, async ({ base, login }) => {
    const { cookie } = await login();
    const plain = await fetch(`${base}/v1/admin/spend`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'text/plain', Cookie: cookie, 'X-Bona-Dash': '1' },
      body: 'day=2026-09-07',
    });
    assert.equal(plain.status, 415);

    const huge = await fetch(`${base}/v1/admin/spend`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Bona-Dash': '1' },
      body: JSON.stringify({ day: '2026-09-07', platform: 'meta', spend_sar: 1, campaign_name: 'x'.repeat(200_000) }),
    });
    assert.equal(huge.status, 413);
    // The rest of that body is never read, so the connection goes with the answer
    // rather than being left half-full on a keep-alive socket.
    assert.equal(huge.headers.get('connection'), 'close');
    assert.deepEqual(await huge.json(), { error: 'payload_too_large' });
  });
});

test('the integrations page reports key presence as booleans and never a key', async () => {
  await withDash({}, async ({ get, login }) => {
    const { cookie } = await login();
    const html = await (await get('/dashboard/integrations', { cookie })).text();
    assert.ok(!html.includes('meta-token'), 'a token must never reach the page');
    assert.match(html, /Meta — Conversions API token/);
    assert.match(html, /GA4 — measurement id/);
    assert.match(html, /docs\/checklists\/rega-ad-licences\.md/);
    assert.match(html, /The WhatsApp poller is not running in this process/);
  });
});

test('a poller from another branch is read defensively, whatever shape it has', async () => {
  const cases = [
    { poller: { health: () => ({ lastRun: Date.now() - 30_000, lag: 30_000, unmatched: 4 }) }, expect: /Poller last run/ },
    { poller: { health: () => { throw new Error('boom'); } }, expect: /not running in this process/ },
    { poller: { health: () => null }, expect: /not running in this process/ },
    { poller: {}, expect: /Poller last run/ },
  ];
  for (const { poller, expect } of cases) {
    await withDash({ app: { poller } }, async ({ get, login }) => {
      const { cookie } = await login();
      const res = await get('/dashboard/integrations', { cookie });
      assert.equal(res.status, 200);
      assert.match(await res.text(), expect);
    });
  }
});

test('the browser routes and the tool routes are untouched by the mount', async () => {
  await withDash({}, async ({ base }) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'bona-api');

    // Still fail-closed on origin, still token-gated, still 404 for anything else.
    const noOrigin = await fetch(`${base}/v1/enquiry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noOrigin.status, 403);
    const tool = await fetch(`${base}/v1/tools/search_properties`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(tool.status, 401);
    const nowhere = await fetch(`${base}/v1/admins`, { redirect: 'manual' });
    assert.equal(nowhere.status, 404);
  });
});

test('an error code from the query string can only ever be one of ours', async () => {
  await withDash({}, async ({ db, get, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    for (const [p, cookieNeeded] of [['/dashboard/login?error=constructor', false], [`/dashboard/leads/${id}?error=constructor`, true], ['/dashboard/spend?error=constructor', true]]) {
      const html = await (await get(p, cookieNeeded ? { cookie } : {})).text();
      assert.ok(!html.includes('function'), `${p} printed a prototype member`);
      assert.ok(!html.includes('class="err"'), `${p} treated an unknown code as an error`);
    }
    const known = await (await get('/dashboard/login?step=code&error=expired')).text();
    assert.match(known, /That code has expired/);
  });
});

test('a JSON caller cannot smuggle an object where text belongs', async () => {
  await withDash({}, async ({ db, postJson, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    const res = await postJson(`/v1/admin/leads/${id}/note`, { note: { toString: 'x' } }, { cookie, headers: { 'X-Bona-Dash': '1' } });
    assert.equal(res.status, 400);
    assert.equal(db.getLead(id).notes, null, '"[object Object]" is not a note');

    const staged = await postJson(`/v1/admin/leads/${id}/stage`, { stage: 'qualified', note: ['a'] }, { cookie, headers: { 'X-Bona-Dash': '1' } });
    assert.equal(staged.status, 200);
    assert.equal(db.stageHistory(id).at(-1).note, null);
  });
});

test('a stage value that is not a number is refused', async () => {
  await withDash({}, async ({ db, postJson, login }) => {
    const id = seedLead(db);
    const { cookie } = await login();
    const res = await postJson(`/v1/admin/leads/${id}/stage`, { stage: 'won', value_sar: 'a lot' }, { cookie, headers: { 'X-Bona-Dash': '1' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_value');
    assert.equal(db.getLead(id).stage, 'new');
  });
});

test('the spend page renders unknown campaign metrics as dashes, never fabricated zeroes', () => {
  const html = spendPage({
    rows: [{ day: '2026-09-23', platform: 'meta', campaign_id: 'entry-missing-counts', campaign_name: null,
      spend_sar: 10, clicks: null, impressions: null }],
    campaigns: [{ platform: 'meta', campaign_id: 'all-time-missing-counts', campaign_name: null,
      spend_sar: 10, clicks: null, impressions: null, leads: 0, unmatched_leads: 0, cpl: null }],
    roi: {
      coverage: { attributed: 1, total: 1, percent: 100 }, totals: { unknown_leads: 0 }, spend_freshness: null,
      campaigns: [{ platform: 'meta', campaign_id: 'never-imported', campaign_name: null,
        spend_sar: null, clicks: null, impressions: null, leads: 1, qualified_leads: 0, won_leads: 0,
        revenue_sar: null, cpl: null, roas: null, unmatched_leads: 0 }],
    },
    today: '2026-09-23',
  });
  const row = html.match(/<tr><td>meta<\/td><td>never-imported<\/td>.*?<\/tr>/s)?.[0] ?? '';
  assert.match(row, /<td class="n">—<\/td><td class="n">—<\/td><td class="n">—<\/td>/);
  assert.doesNotMatch(row, /0 SAR/);
  for (const id of ['entry-missing-counts', 'all-time-missing-counts']) {
    const rendered = html.match(new RegExp(`<tr>.*?<td>${id}<\\/td>.*?<\\/tr>`, 's'))?.[0] ?? '';
    assert.match(rendered, /<td class="n">—<\/td><td class="n">—<\/td>/, `${id} preserves unknown counts`);
  }
});

/* ---------------- team accounts, routes built directly ---------------- */
//
// These build the routes the way index.mjs will once it passes `team` (Task 10): a real
// team store, audit log and a spy for the code sender, mounted on a bare HTTP server.

const OWNER_PHONE = '966593296933';
const STAFF_PHONE = '966500000001';

/**
 * `extra` goes into createDashboardRoutes as well: an object, or a function of `{ db, team, audit }`
 * for the options that need the store (an inbox built on it, say).
 */
async function withTeamRoutes(fn, extra = {}) {
  const db = openDb(':memory:');
  const team = createTeam(db);
  const owner = team.ensureOwner({ phone: OWNER_PHONE, name: 'Abdulaziz' });
  const staffUser = team.addUser({ name: 'Sara', phone: STAFF_PHONE, role: 'staff' });
  const audit = createAudit(db);
  const sent = [];
  const logs = [];
  const routes = createDashboardRoutes({
    db, cfg: { publicApi: 'https://bona-api.azoz.uk', dashCookieDays: 30, maxBodyBytes: 16 * 1024 },
    inventory, team, audit,
    sendCode: async ({ jid, text }) => { sent.push({ jid, text }); return { ok: true }; },
    log: (o) => logs.push(o),
    ...(typeof extra === 'function' ? extra({ db, team, audit }) : extra),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    routes.handle({ req, res, url, p, ip: '127.0.0.1' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const go = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const get = (p, { cookie } = {}) => go(p, { headers: cookie ? { Cookie: cookie } : {} });
  const postForm = (p, fields, { cookie } = {}) => go(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  const cookieOf = (res, name) => {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      if (pair.slice(0, pair.indexOf('=')) === name && !c.includes('Max-Age=0')) return pair.slice(pair.indexOf('=') + 1);
    }
    return null;
  };
  async function login(phone) {
    const before = sent.length;
    const asked = await postForm('/dashboard/login/code', { _dash: '1', phone });
    assert.equal(asked.status, 303);
    await routes.auth.flush();
    assert.equal(sent.length, before + 1, 'one code went out');
    const code = /(\d{6})/.exec(sent.at(-1).text)[1];
    const nonce = cookieOf(asked, 'bona_dash_try');
    const verified = await postForm('/dashboard/login/verify', { _dash: '1', code }, { cookie: `bona_dash_try=${nonce}` });
    assert.equal(verified.status, 303);
    return `bona_dash=${cookieOf(verified, 'bona_dash')}`;
  }
  try {
    await fn({ db, team, audit, owner, staffUser, sent, logs, routes, base, get, postForm, login, port });
  } finally {
    await routes.auth.flush();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

test('the routes refuse to be built without the team store', () => {
  const db = openDb(':memory:');
  try {
    assert.throws(() => createDashboardRoutes({ db, cfg: {} }), /needs the team store/);
  } finally {
    db.close();
  }
});

test('a code goes to the WhatsApp of the person whose number was typed; a bad number goes back to step one', async () => {
  await withTeamRoutes(async ({ sent, postForm, routes }) => {
    const bad = await postForm('/dashboard/login/code', { _dash: '1', phone: 'hello' });
    assert.equal(bad.status, 303);
    assert.equal(bad.headers.get('location'), '/dashboard/login?error=bad_phone');
    const ok = await postForm('/dashboard/login/code', { _dash: '1', phone: '0500000001' });
    assert.equal(ok.headers.get('location'), '/dashboard/login?step=code&sent=1');
    await routes.auth.flush();
    assert.equal(sent.at(-1).jid, `${STAFF_PHONE}@s.whatsapp.net`);
  });
});

test('a staff member sees their own name, no Team link, and cannot open Team', async () => {
  await withTeamRoutes(async ({ get, login }) => {
    const staff = await login('0500000001');
    for (const p of ['/dashboard', '/dashboard/leads', '/dashboard/listings', '/dashboard/spend', '/dashboard/integrations']) {
      const res = await get(p, { cookie: staff });
      assert.equal(res.status, 200, p);
      const html = await res.text();
      assert.match(html, /<b><bdi>Sara<\/bdi><\/b><s>Team<\/s>/, p);
      assert.doesNotMatch(html, /Abdulaziz/, p);
      assert.doesNotMatch(html, /href="\/dashboard\/team"/, p);
    }
    const team = await get('/dashboard/team', { cookie: staff });
    assert.equal(team.status, 403);
    assertLocked(team);
    assert.doesNotMatch(await team.text(), /966500000001|0500000001/);

    const owner = await login('0593296933');
    const page = await get('/dashboard/team', { cookie: owner });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<b><bdi>Abdulaziz<\/bdi><\/b><s>Owner<\/s>/);
    assert.match(html, /href="\/dashboard\/team"/);
    assert.match(html, /Sara/);
  });
});

test('every Team write is refused to a staff member and changes nothing', async () => {
  await withTeamRoutes(async ({ team, audit, owner, postForm, login, db }) => {
    const staff = await login('0500000001');
    const beforeUsers = JSON.stringify(team.listUsers());
    const beforeNever = JSON.stringify(team.listNever());
    const beforeSetting = team.getSetting('sending_enabled');
    const auditBefore = audit.recent(500).length;
    const writes = [
      ['/v1/admin/team', { name: 'X', phone: '0500000009', role: 'owner' }],
      [`/v1/admin/team/${owner.user_id}/deactivate`, {}],
      [`/v1/admin/team/${owner.user_id}/role`, { role: 'staff' }],
      [`/v1/admin/team/${owner.user_id}/reactivate`, {}],
      ['/v1/admin/never', { phone: '0511111111', note: 'x' }],
      ['/v1/admin/never/remove', { phone: '0511111111' }],
      ['/v1/admin/settings', { sending_enabled: beforeSetting === '1' ? '0' : '1' }],
    ];
    for (const [p, fields] of writes) {
      const res = await postForm(p, { _dash: '1', ...fields }, { cookie: staff });
      assert.equal(res.status, 403, p);
      assertLocked(res);
      assert.deepEqual(await res.json(), { error: 'owner_only' }, p);
    }
    assert.equal(JSON.stringify(team.listUsers()), beforeUsers);
    assert.equal(JSON.stringify(team.listNever()), beforeNever);
    assert.equal(team.getSetting('sending_enabled'), beforeSetting);
    assert.equal(audit.recent(500).length, auditBefore);
    assert.ok(db, 'store still open');
  });
});

test('Team writes still need the marker, even from an owner', async () => {
  await withTeamRoutes(async ({ team, postForm, login, get }) => {
    const owner = await login('0593296933');
    const res = await postForm('/v1/admin/team', { name: 'Omar', phone: '0500000002' }, { cookie: owner });
    assert.equal(res.status, 403);
    assert.equal(team.getUserByPhone('0500000002'), null);
    const signedOut = await postForm('/v1/admin/team', { _dash: '1', name: 'Omar', phone: '0500000002' });
    assert.equal(signedOut.status, 401);
    assert.equal(team.getUserByPhone('0500000002'), null);
    assert.equal((await get('/dashboard/team')).status, 302);
  });
});

test('the owner adds, demotes, deactivates and reactivates; each write is audited by id only', async () => {
  await withTeamRoutes(async ({ team, audit, owner, staffUser, postForm, login, get }) => {
    const ownerCookie = await login('0593296933');
    const staffCookie = await login('0500000001');

    const add = await postForm('/v1/admin/team', { _dash: '1', name: 'Omar', phone: '0500000002', role: 'staff' }, { cookie: ownerCookie });
    assert.equal(add.status, 303);
    assert.equal(add.headers.get('location'), '/dashboard/team?ok=added');
    const omar = team.getUserByPhone('0500000002');
    assert.equal(omar.role, 'staff');
    const dup = await postForm('/v1/admin/team', { _dash: '1', name: 'Omar again', phone: '0500000002' }, { cookie: ownerCookie });
    assert.equal(dup.headers.get('location'), '/dashboard/team?error=duplicate_phone');
    const flash = await (await get('/dashboard/team?error=duplicate_phone', { cookie: ownerCookie })).text();
    assert.match(flash, /already on the team/);

    const promote = await postForm(`/v1/admin/team/${omar.user_id}/role`, { _dash: '1', role: 'owner' }, { cookie: ownerCookie });
    assert.equal(promote.headers.get('location'), '/dashboard/team?ok=role');
    assert.equal(team.getUser(omar.user_id).role, 'owner');
    const badRole = await postForm(`/v1/admin/team/${omar.user_id}/role`, { _dash: '1', role: 'admin' }, { cookie: ownerCookie });
    assert.equal(badRole.headers.get('location'), '/dashboard/team?error=bad_role');

    const off = await postForm(`/v1/admin/team/${staffUser.user_id}/deactivate`, { _dash: '1' }, { cookie: ownerCookie });
    assert.equal(off.headers.get('location'), '/dashboard/team?ok=deactivated');
    const out = await get('/dashboard', { cookie: staffCookie });
    assert.equal(out.status, 302, 'a deactivated person is out on their very next request');
    const back = await postForm(`/v1/admin/team/${staffUser.user_id}/reactivate`, { _dash: '1' }, { cookie: ownerCookie });
    assert.equal(back.headers.get('location'), '/dashboard/team?ok=reactivated');
    assert.equal(team.getUser(staffUser.user_id).active, 1);

    const ghost = await postForm('/v1/admin/team/USR-nobody/deactivate', { _dash: '1' }, { cookie: ownerCookie });
    assert.equal(ghost.headers.get('location'), '/dashboard/team?error=not_found');

    const actions = audit.recent(50).map((r) => r.action);
    for (const a of ['team_add', 'team_role', 'team_deactivate', 'team_reactivate']) assert.ok(actions.includes(a), a);
    const text = JSON.stringify(audit.recent(50));
    assert.doesNotMatch(text, /966500000002|0500000002|Omar|Sara/, 'no number or name in the audit log');
    assert.ok(owner.user_id);
  });
});

test('an owner cannot deactivate or demote themselves: a message, not a 500 (form and JSON)', async () => {
  await withTeamRoutes(async ({ team, owner, postForm, login }) => {
    const ownerCookie = await login('0593296933');
    const self = await postForm(`/v1/admin/team/${owner.user_id}/deactivate`, { _dash: '1' }, { cookie: ownerCookie });
    assert.equal(self.status, 303);
    assert.equal(self.headers.get('location'), '/dashboard/team?error=self_change');
    const demote = await postForm(`/v1/admin/team/${owner.user_id}/role`, { _dash: '1', role: 'staff' }, { cookie: ownerCookie });
    assert.equal(demote.headers.get('location'), '/dashboard/team?error=self_change');
    const json = await fetch(`${'http://127.0.0.1:'}${(new URL(self.url)).port}/v1/admin/team/${owner.user_id}/deactivate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: ownerCookie }, body: '{}',
    });
    assert.equal(json.status, 400);
    assert.deepEqual(await json.json(), { error: 'self_change' });
    const jsonDemote = await fetch(`${'http://127.0.0.1:'}${(new URL(self.url)).port}/v1/admin/team/${owner.user_id}/role`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: ownerCookie }, body: JSON.stringify({ role: 'staff' }),
    });
    assert.equal(jsonDemote.status, 400);
    assert.deepEqual(await jsonDemote.json(), { error: 'self_change' });
    assert.equal(team.getUser(owner.user_id).active, 1);
    assert.equal(team.getUser(owner.user_id).role, 'owner');
  });
});

test('the self-change guard holds even with a second active owner in the room', async () => {
  await withTeamRoutes(async ({ team, owner, postForm, login }) => {
    // With only one owner, `team.mjs`'s own `last_owner` check would already refuse
    // this. A second active owner removes that reason, so what stops it here has to
    // be the guard in routes.mjs, not the one in team.mjs.
    const second = team.addUser({ name: 'Omar', phone: '0500000002', role: 'owner' });
    const ownerCookie = await login('0593296933');
    const self = await postForm(`/v1/admin/team/${owner.user_id}/deactivate`, { _dash: '1' }, { cookie: ownerCookie });
    assert.equal(self.headers.get('location'), '/dashboard/team?error=self_change');
    const demote = await postForm(`/v1/admin/team/${owner.user_id}/role`, { _dash: '1', role: 'staff' }, { cookie: ownerCookie });
    assert.equal(demote.headers.get('location'), '/dashboard/team?error=self_change');
    assert.equal(team.getUser(owner.user_id).active, 1);
    assert.equal(team.getUser(owner.user_id).role, 'owner');
    // The other owner is untouched, and an owner acting on someone ELSE is still fine.
    const off = await postForm(`/v1/admin/team/${second.user_id}/deactivate`, { _dash: '1' }, { cookie: ownerCookie });
    assert.equal(off.headers.get('location'), '/dashboard/team?ok=deactivated');
    assert.equal(team.getUser(second.user_id).active, 0);
  });
});

test('the never list and the sending switch take effect, and the audit keeps no number', async () => {
  await withTeamRoutes(async ({ team, audit, postForm, login }) => {
    const ownerCookie = await login('0593296933');
    const add = await postForm('/v1/admin/never', { _dash: '1', phone: '0511111111', note: 'cousin' }, { cookie: ownerCookie });
    assert.equal(add.headers.get('location'), '/dashboard/team?ok=never_added');
    assert.equal(team.isExcludedPhone('966511111111'), true);
    const rm = await postForm('/v1/admin/never/remove', { _dash: '1', phone: '966511111111' }, { cookie: ownerCookie });
    assert.equal(rm.headers.get('location'), '/dashboard/team?ok=never_removed');
    assert.equal(team.isExcludedPhone('966511111111'), false);
    await postForm('/v1/admin/settings', { _dash: '1', sending_enabled: '0' }, { cookie: ownerCookie });
    assert.equal(team.sendingEnabled(), false);
    const on = await postForm('/v1/admin/settings', { _dash: '1', sending_enabled: '1' }, { cookie: ownerCookie });
    assert.equal(on.headers.get('location'), '/dashboard/team?ok=setting');
    assert.equal(team.sendingEnabled(), true);
    const none = await postForm('/v1/admin/settings', { _dash: '1' }, { cookie: ownerCookie });
    assert.equal(none.headers.get('location'), '/dashboard/team?error=bad_setting');
    const text = JSON.stringify(audit.recent(50));
    assert.doesNotMatch(text, /511111111|cousin/);
  });
});

test('the sending switch fails closed: only an explicit "0" or "1" is accepted, form and JSON alike', async () => {
  await withTeamRoutes(async ({ team, postForm, login, base }) => {
    const ownerCookie = await login('0593296933');
    const before = team.getSetting('sending_enabled');
    assert.equal(before, '1');
    for (const bad of [false, null, 'off', '']) {
      const res = await fetch(`${base}/v1/admin/settings`, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: ownerCookie },
        body: JSON.stringify({ sending_enabled: bad }),
      });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.deepEqual(await res.json(), { error: 'bad_setting_value' }, JSON.stringify(bad));
      assert.equal(team.getSetting('sending_enabled'), before, JSON.stringify(bad));
    }
    // The form path shares the same guard: a value that is not literally "0" no
    // longer falls through to "1" the way `=== '0' ? '0' : '1'` used to coerce it.
    const formBad = await postForm('/v1/admin/settings', { _dash: '1', sending_enabled: 'off' }, { cookie: ownerCookie });
    assert.equal(formBad.headers.get('location'), '/dashboard/team?error=bad_setting_value');
    assert.equal(team.getSetting('sending_enabled'), before);
    // The two real values still work.
    const off = await postForm('/v1/admin/settings', { _dash: '1', sending_enabled: '0' }, { cookie: ownerCookie });
    assert.equal(off.headers.get('location'), '/dashboard/team?ok=setting');
    assert.equal(team.getSetting('sending_enabled'), '0');
  });
});

test('removing a number that was never on the never list is reported, not silently accepted', async () => {
  await withTeamRoutes(async ({ team, postForm, login, base }) => {
    const ownerCookie = await login('0593296933');
    assert.equal(team.isExcludedPhone('966522222222'), false);

    const form = await postForm('/v1/admin/never/remove', { _dash: '1', phone: '0522222222' }, { cookie: ownerCookie });
    assert.equal(form.status, 303);
    assert.equal(form.headers.get('location'), '/dashboard/team?error=never_not_found');

    const json = await fetch(`${base}/v1/admin/never/remove`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: ownerCookie },
      body: JSON.stringify({ phone: '0522222222' }),
    });
    assert.equal(json.status, 404);
    assert.deepEqual(await json.json(), { error: 'never_not_found' });
  });
});

test('a stage change and a note carry the person who made them', async () => {
  await withTeamRoutes(async ({ db, audit, staffUser, postForm, login }) => {
    const id = seedLead(db, { phone: '966500000055', inboxState: 'in' });
    const staff = await login('0500000001');
    await postForm(`/v1/admin/leads/${id}/stage`, { _dash: '1', stage: 'contacted' }, { cookie: staff });
    assert.equal(db.stageHistory(id).at(-1).actor, 'Sara');
    await postForm(`/v1/admin/leads/${id}/note`, { _dash: '1', note: 'called her' }, { cookie: staff });
    const tp = db.touchpointsForLead(id).at(-1);
    assert.equal(tp.meta.actor, 'Sara');
    assert.equal(tp.meta.actor_id, staffUser.user_id);
    const rows = audit.recent(10).filter((r) => r.action === 'stage' || r.action === 'note');
    assert.equal(rows.length, 2);
    for (const r of rows) { assert.equal(r.user_id, staffUser.user_id); assert.equal(r.target, id); }
    assert.doesNotMatch(JSON.stringify(rows), /called her/);
  });
});

test('logout is audited against the person who logged out', async () => {
  await withTeamRoutes(async ({ audit, staffUser, postForm, login, get }) => {
    const staff = await login('0500000001');
    const out = await postForm('/dashboard/logout', { _dash: '1' }, { cookie: staff });
    assert.equal(out.status, 303);
    assert.equal((await get('/dashboard', { cookie: staff })).status, 302);
    const row = audit.recent(10).find((r) => r.action === 'logout');
    assert.equal(row?.user_id, staffUser.user_id);
  });
});

test('a person deactivated while their write body is still arriving does not get the write through', async () => {
  await withTeamRoutes(async ({ db, team, staffUser, login, port }) => {
    const id = seedLead(db);
    const staff = await login('0500000001');
    const body = JSON.stringify({ stage: 'contacted' });
    const answer = new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: `/v1/admin/leads/${id}/stage`,
        headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: staff, 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
      req.on('error', reject);
      req.write(body.slice(0, 5));
      // The route has checked the cookie and is waiting for the rest of the body.
      setTimeout(() => { team.deactivateUser(staffUser.user_id); req.end(body.slice(5)); }, 50);
    });
    const res = await answer;
    assert.equal(res.status, 401);
    assert.equal(db.getLead(id).stage, 'new');
  });
});

test('every Team write is refused to a staff member over JSON with the header marker too, not just a form', async () => {
  await withTeamRoutes(async ({ team, audit, owner, login, base }) => {
    const staff = await login('0500000001');
    const beforeUsers = JSON.stringify(team.listUsers());
    const beforeNever = JSON.stringify(team.listNever());
    const beforeSetting = team.getSetting('sending_enabled');
    const auditBefore = audit.recent(500).length;
    const writes = [
      ['/v1/admin/team', { name: 'X', phone: '0500000009', role: 'owner' }],
      [`/v1/admin/team/${owner.user_id}/deactivate`, {}],
      [`/v1/admin/team/${owner.user_id}/role`, { role: 'staff' }],
      [`/v1/admin/team/${owner.user_id}/reactivate`, {}],
      ['/v1/admin/never', { phone: '0511111111', note: 'x' }],
      ['/v1/admin/never/remove', { phone: '0511111111' }],
      ['/v1/admin/settings', { sending_enabled: beforeSetting === '1' ? '0' : '1' }],
    ];
    for (const [p, fields] of writes) {
      const res = await fetch(`${base}${p}`, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: staff },
        body: JSON.stringify(fields),
      });
      assert.equal(res.status, 403, p);
      assert.deepEqual(await res.json(), { error: 'owner_only' }, p);
    }
    assert.equal(JSON.stringify(team.listUsers()), beforeUsers);
    assert.equal(JSON.stringify(team.listNever()), beforeNever);
    assert.equal(team.getSetting('sending_enabled'), beforeSetting);
    assert.equal(audit.recent(500).length, auditBefore);
  });
});

test('an owner demoted to staff while their Team write body is still arriving is refused, not honoured', async () => {
  await withTeamRoutes(async ({ team, owner, login, port }) => {
    // A second active owner, so the mid-flight demotion below is not itself refused
    // by team.mjs's own last_owner protection — what has to stop the write here is
    // the fresh re-check of `me` in handleAdmin, not that.
    const second = team.addUser({ name: 'Omar', phone: '0500000002', role: 'owner' });
    const ownerCookie = await login('0593296933');
    const body = JSON.stringify({ phone: '0511111111', note: 'x' });
    const answer = new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/v1/admin/never',
        headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: ownerCookie, 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
      req.on('error', reject);
      req.write(body.slice(0, 5));
      // The route has checked the cookie and is waiting for the rest of the body.
      setTimeout(() => { team.setRole(owner.user_id, 'staff'); req.end(body.slice(5)); }, 50);
    });
    const res = await answer;
    assert.equal(res.status, 403);
    assert.deepEqual(JSON.parse(res.text), { error: 'owner_only' });
    assert.equal(team.isExcludedPhone('966511111111'), false);
    assert.equal(team.getUser(second.user_id).role, 'owner');
  });
});

/* ---------------- team accounts, through createApp's own wiring ---------------- */

test('an unknown number gets the same answer and nothing is sent', async () => {
  await withDash({}, async ({ askForCode, sent }) => {
    const before = sent.length;
    const asked = await askForCode({ phone: '0511111111' });
    assert.equal(asked.res.status, 303);
    assert.equal(asked.res.headers.get('location'), '/dashboard/login?step=code&sent=1');
    assert.ok(asked.nonce);
    assert.equal(sent.length, before);
  });
});

test('the owner adds a person, who logs in with a code sent to their own WhatsApp and cannot open Team', async () => {
  await withDash({}, async ({ get, postForm, login, sentTo }) => {
    const owner = await login();
    assert.equal(sentTo.at(-1), '966593296933@s.whatsapp.net', 'the owner seeded from BONA_OWNER_JID gets his own code');
    const team = await get('/dashboard/team', { cookie: owner.cookie });
    assert.equal(team.status, 200);
    assertLocked(team);
    const add = await postForm('/v1/admin/team', { _dash: '1', name: 'Sara', phone: '0500000001', role: 'staff' }, { cookie: owner.cookie });
    assert.equal(add.status, 303);
    assert.equal(add.headers.get('location'), '/dashboard/team?ok=added');

    const staff = await login({ phone: '0500000001' });
    assert.equal(sentTo.at(-1), '966500000001@s.whatsapp.net');
    const desk = await (await get('/dashboard', { cookie: staff.cookie })).text();
    assert.match(desk, /<b><bdi>Sara<\/bdi><\/b><s>Team<\/s>/);
    assert.doesNotMatch(desk, /href="\/dashboard\/team"/);
    assert.equal((await get('/dashboard/team', { cookie: staff.cookie })).status, 403);
    const denied = await postForm('/v1/admin/team', { _dash: '1', name: 'X', phone: '0500000002' }, { cookie: staff.cookie });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'owner_only' });
  });
});

test('deactivating a person logs them out everywhere at once', async () => {
  await withDash({}, async ({ app, get, postForm, login }) => {
    const owner = await login();
    await postForm('/v1/admin/team', { _dash: '1', name: 'Sara', phone: '0500000001' }, { cookie: owner.cookie });
    const staff = await login({ phone: '0500000001' });
    assert.equal((await get('/dashboard', { cookie: staff.cookie })).status, 200);
    const id = app.team.getUserByPhone('0500000001').user_id;
    const off = await postForm(`/v1/admin/team/${id}/deactivate`, { _dash: '1' }, { cookie: owner.cookie });
    assert.equal(off.headers.get('location'), '/dashboard/team?ok=deactivated');
    const after = await get('/dashboard', { cookie: staff.cookie });
    assert.equal(after.status, 302);
    assert.equal(after.headers.get('location'), '/dashboard/login');
    const me = app.team.getUserByPhone('0593296933').user_id;
    const self = await postForm(`/v1/admin/team/${me}/deactivate`, { _dash: '1' }, { cookie: owner.cookie });
    assert.equal(self.headers.get('location'), '/dashboard/team?error=self_change');
  });
});

test('a stage change and a note carry the name of the person who made them', async () => {
  await withDash({}, async ({ app, db, postForm, login }) => {
    const id = seedLead(db, { phone: '966500000055', inboxState: 'in' });
    const owner = await login();
    await postForm('/v1/admin/team', { _dash: '1', name: 'Sara', phone: '0500000001' }, { cookie: owner.cookie });
    const staff = await login({ phone: '0500000001' });
    await postForm(`/v1/admin/leads/${id}/stage`, { _dash: '1', stage: 'contacted' }, { cookie: staff.cookie });
    assert.equal(db.stageHistory(id).at(-1).actor, 'Sara');
    await postForm(`/v1/admin/leads/${id}/note`, { _dash: '1', note: 'called her' }, { cookie: staff.cookie });
    assert.equal(db.touchpointsForLead(id).at(-1).meta.actor, 'Sara');
    // The two may share a millisecond, so assert membership rather than order.
    const actions = app.audit.recent(10).map((r) => r.action);
    assert.ok(actions.includes('note') && actions.includes('stage'), actions.join(','));
  });
});

test('the never list and the sending switch are owner-only and take effect', async () => {
  await withDash({}, async ({ app, postForm, login }) => {
    const owner = await login();
    await postForm('/v1/admin/never', { _dash: '1', phone: '0511111111', note: 'cousin' }, { cookie: owner.cookie });
    assert.equal(app.team.isExcludedPhone('966511111111'), true);
    await postForm('/v1/admin/settings', { _dash: '1', sending_enabled: '0' }, { cookie: owner.cookie });
    assert.equal(app.team.sendingEnabled(), false);
    await postForm('/v1/admin/settings', { _dash: '1', sending_enabled: '1' }, { cookie: owner.cookie });
    assert.equal(app.team.sendingEnabled(), true);
  });
});

test('createApp seeds the owner from BONA_OWNER_JID and hands him every session that predates accounts', () => {
  const db = openDb(':memory:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-dash-'));
  // A session opened before team accounts existed: no user behind it. Written directly,
  // because the store's own API no longer opens one without a person.
  db.db.prepare('INSERT INTO auth_sessions (token_hash, created, expires, ua) VALUES (?,?,?,?)')
    .run('legacy-hash', Date.now(), Date.now() + 86_400_000, 'test');
  try {
    const app = createApp({
      config: {
        port: 0, host: '127.0.0.1', siteUrl: 'https://bona.azoz.uk', publicApi: 'https://bona-api.azoz.uk',
        dataDir, inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS, toolToken: TOKEN,
        retellApiKey: 'test', retellMock: true, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice',
        maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, toolRatePerMin: 600, toolAuthFailRatePerMin: 10,
        allowQueryToken: false, maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40, dashCookieDays: 30,
        env: { BONA_OWNER_JID: '966500000009:3@s.whatsapp.net', BONA_OWNER_NAME: 'Owner Two' },
        ids: {}, version: '1.0.0', trustedProxies: [],
      },
      inventory, db, probeRetell: async () => 'ok', sendWhatsApp: async () => ({ ok: true }), log: () => {},
    });
    const owner = app.team.getUserByPhone('966500000009');
    assert.equal(owner.role, 'owner');
    assert.equal(owner.active, 1);
    assert.equal(owner.name, 'Owner Two');
    const row = db.db.prepare('SELECT user_id FROM auth_sessions WHERE token_hash = ?').get('legacy-hash');
    assert.equal(row.user_id, owner.user_id);
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a malformed BONA_OWNER_JID is logged and does not stop the server from being built', () => {
  const db = openDb(':memory:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-dash-'));
  const logs = [];
  try {
    const app = createApp({
      config: {
        port: 0, host: '127.0.0.1', siteUrl: 'https://bona.azoz.uk', publicApi: 'https://bona-api.azoz.uk',
        dataDir, inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS, toolToken: TOKEN,
        retellApiKey: 'test', retellMock: true, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice',
        maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, toolRatePerMin: 600, toolAuthFailRatePerMin: 10,
        allowQueryToken: false, maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40, dashCookieDays: 30,
        env: { BONA_OWNER_JID: 'not-a-number' }, ids: {}, version: '1.0.0', trustedProxies: [],
      },
      inventory, db, probeRetell: async () => 'ok', sendWhatsApp: async () => ({ ok: true }), log: (e) => logs.push(e),
    });
    assert.ok(app.server);
    assert.equal(app.team.listUsers().length, 0);
    assert.ok(logs.some((e) => e.evt === 'team.owner_seed_failed' && e.error === 'bad_phone'));
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});


test('task controls require owner session and same-origin form marker; viewing confirmation requires date',async()=>{
 await withDash({},async({db,login,postJson,postForm,get,sent})=>{
  const id=seedLead(db,{phone:'966500000088',inboxState:'in'});const route='/v1/admin/leads/'+id+'/task';
  assert.equal((await postJson(route,{kind:'viewing',due_at:'2026-11-02T16:30'})).status,401);
  const owner=await login();const sends=sent.length;
  assert.equal((await postJson(route,{kind:'viewing',due_at:'2026-11-02T16:30'},{cookie:owner.cookie,headers:{Origin:'https://evil.test'}})).status,403);
  const bad=await postForm(route,{kind:'viewing',due_at:'2026-11-02T16:30'},{cookie:owner.cookie});assert.equal(bad.status,403);
  const saved=await postJson(route,{kind:'viewing',due_at:'2026-11-02T16:30'},{cookie:owner.cookie,headers:{'X-Bona-Dash':'1'}});assert.equal(saved.status,200);const task=(await saved.json()).task;
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='lead_task'").get().n,1);
  assert.equal(task.status,'requested');assert.equal(task.due_ts,Date.parse('2026-11-02T13:30:00Z'));
  assert.equal((await postJson(route,{task_id:task.task_id,status:'confirmed'},{cookie:owner.cookie,headers:{'X-Bona-Dash':'1'}})).status,200);
  assert.equal((await postJson(route,{task_id:task.task_id,status:'bad'},{cookie:owner.cookie,headers:{'X-Bona-Dash':'1'}})).status,400);
  const team=createTeam(db);team.addUser({name:'Test Staff',phone:'0500000009',role:'staff'});const staff=await login({phone:'0500000009'});
  assert.equal((await postJson(route,{kind:'followup',due_at:'2026-11-02T16:30'},{cookie:staff.cookie,headers:{'X-Bona-Dash':'1'}})).status,403);
  const page=await(await get('/dashboard/leads/'+id,{cookie:staff.cookie})).text();assert.ok(!page.includes('Save task; do not send a message'));
  assert.equal(sent.length,sends+1,'only the staff login code; no task notification');
 });
});



test('task dates reject calendar rollover and queue pages show total and next link',async()=>{
 await withDash({},async({db,login,postJson,get})=>{
  const id=seedLead(db,{phone:'966500000089',inboxState:'in'});const {cookie}=await login();
  const r=await postJson('/v1/admin/leads/'+id+'/task',{kind:'viewing',due_at:'2026-02-30T16:30'},{cookie,headers:{'X-Bona-Dash':'1'}});assert.equal(r.status,400);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lead_tasks').get().n,0);
  const {addTask}=await import('../lib/lead-tasks.mjs');for(let n=0;n<105;n++)addTask(db,{leadId:id,kind:'followup',dueTs:Date.now()+86400000+n});
  const html=await(await get('/dashboard',{cookie})).text();assert.match(html,/105 open tasks/);assert.match(html,/tasks_page=1/);
  assert.match(await(await get('/dashboard?tasks_page=1',{cookie})).text(),/Previous/);
 });
});

/* ---------------- the go-live switches and the seams for later tasks (PLAN T04) ---------------- */

const GO_LIVE_SWITCHES = ['own_inbox', 'owner_as_client', 'calendar_booking', 'owner_notes', 'email_replies', 'owner_mail_copy', 'dana_brain'];
/** Lets a hook's promise (or a fire-and-forget catch) settle before the test looks. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('every go-live switch is owner-only: a staff member is refused and nothing changes', async () => {
  await withTeamRoutes(async ({ team, audit, postForm, login }) => {
    const staff = await login('0500000001');
    const auditBefore = audit.recent(500).length;
    for (const key of GO_LIVE_SWITCHES) {
      const before = team.getSetting(key);
      const res = await postForm('/v1/admin/settings', { _dash: '1', [key]: before === '1' ? '0' : '1' }, { cookie: staff });
      assert.equal(res.status, 403, key);
      assert.deepEqual(await res.json(), { error: 'owner_only' }, key);
      assert.equal(team.getSetting(key), before, key);
    }
    assert.equal(audit.recent(500).length, auditBefore, 'a refused write is not audited as a change');
  });
});

test('the owner flips every go-live switch from the Team page; each write is audited by key and value only', async () => {
  await withTeamRoutes(async ({ team, audit, owner, postForm, login, get }) => {
    const cookie = await login(OWNER_PHONE);
    for (const key of GO_LIVE_SWITCHES) {
      const want = team.getSetting(key) === '1' ? '0' : '1';
      const res = await postForm('/v1/admin/settings', { _dash: '1', [key]: want }, { cookie });
      assert.equal(res.status, 303, key);
      assert.equal(res.headers.get('location'), '/dashboard/team?ok=setting', key);
      assert.equal(team.getSetting(key), want, key);
      const row = audit.recent(1)[0];
      assert.deepEqual([row.user_id, row.action, row.target, row.meta], [owner.user_id, 'setting', key, { value: want }], key);
    }
    const html = await (await get('/dashboard/team', { cookie })).text();
    for (const key of GO_LIVE_SWITCHES) {
      const now = team.getSetting(key);
      assert.match(html, new RegExp(`name="${key}" value="${now === '1' ? '0' : '1'}"`), `${key}: the page offers the opposite of ${now}`);
    }
    // Two switches in one post, or a value outside '0'/'1', is refused as before.
    const two = await postForm('/v1/admin/settings', { _dash: '1', own_inbox: '1', dana_brain: '1' }, { cookie });
    assert.equal(two.headers.get('location'), '/dashboard/team?error=bad_setting');
    const bad = await postForm('/v1/admin/settings', { _dash: '1', own_inbox: 'on' }, { cookie });
    assert.equal(bad.headers.get('location'), '/dashboard/team?error=bad_setting_value');
    // A marker is not a switch: the Team page's form cannot post one.
    for (const marker of ['brain_out', 'brain_usd_day', 'mail_from_ok', 'owner_summary_day']) {
      const res = await postForm('/v1/admin/settings', { _dash: '1', [marker]: '' }, { cookie });
      assert.equal(res.headers.get('location'), '/dashboard/team?error=bad_setting', marker);
    }
  });
});

test('onSettingChanged gets (key, value) once per real change, never for a repeat or a refusal', async () => {
  const calls = [];
  await withTeamRoutes(async ({ postForm, login }) => {
    const cookie = await login(OWNER_PHONE);
    await postForm('/v1/admin/settings', { _dash: '1', owner_as_client: '1' }, { cookie });
    await postForm('/v1/admin/settings', { _dash: '1', owner_as_client: '1' }, { cookie });
    await postForm('/v1/admin/settings', { _dash: '1', owner_as_client: 'yes' }, { cookie });
    await postForm('/v1/admin/settings', { _dash: '1', owner_notes: '1' }, { cookie }); // ships on: no change
    await postForm('/v1/admin/settings', { _dash: '1', owner_as_client: '0' }, { cookie });
    await postForm('/v1/admin/settings', { _dash: '1', sending_enabled: '0' }, { cookie });
    await settle();
    assert.deepEqual(calls, [['owner_as_client', '1'], ['owner_as_client', '0'], ['sending_enabled', '0']]);
  }, { onSettingChanged: (key, value) => { calls.push([key, value]); } });
});

test('onSettingChanged runs only after the row and its audit are written, and never for a write that threw', async () => {
  const seen = [];
  await withTeamRoutes(async ({ team, postForm, login, owner }) => {
    const cookie = await login(OWNER_PHONE);
    const res = await postForm('/v1/admin/settings', { _dash: '1', owner_as_client: '1' }, { cookie });
    assert.equal(res.headers.get('location'), '/dashboard/team?ok=setting');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].stored, '1', 'the setting was already saved when the hook ran');
    assert.deepEqual(seen[0].audited, [owner.user_id, 'setting', 'owner_as_client', { value: '1' }], 'and its audit row was already written');
    // A write that throws (the disk, say) is no change: the hook hears nothing.
    const real = team.setSetting;
    team.setSetting = () => { throw new Error('disk I/O error'); };
    try {
      const failed = await postForm('/v1/admin/settings', { _dash: '1', owner_as_client: '0' }, { cookie });
      assert.equal(failed.status, 500);
    } finally {
      team.setSetting = real;
    }
    await settle();
    assert.equal(seen.length, 1, 'a write that threw tells nobody');
    assert.equal(team.getSetting('owner_as_client'), '1');
  }, ({ team, audit }) => ({
    onSettingChanged: (key) => {
      const row = audit.recent(1)[0];
      seen.push({ stored: team.getSetting(key), audited: [row.user_id, row.action, row.target, row.meta] });
    },
  }));
});

test('a failing onSettingChanged is logged, never a 500: the setting is saved and the owner sees "Saved"', async () => {
  let n = 0;
  await withTeamRoutes(async ({ team, postForm, login, logs }) => {
    const cookie = await login(OWNER_PHONE);
    const res = await postForm('/v1/admin/settings', { _dash: '1', own_inbox: '1' }, { cookie });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/team?ok=setting');
    assert.equal(team.getSetting('own_inbox'), '1');
    const res2 = await postForm('/v1/admin/settings', { _dash: '1', own_inbox: '0' }, { cookie });
    assert.equal(res2.headers.get('location'), '/dashboard/team?ok=setting');
    await settle();
    const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
    assert.deepEqual(failed.map((l) => [l.hook, l.target]), [['onSettingChanged', 'own_inbox'], ['onSettingChanged', 'own_inbox']], 'a thrown error and a rejected promise alike');
    assert.doesNotMatch(JSON.stringify(failed), /boom/, 'the log names the hook and the key, never the error\'s words');
  }, { onSettingChanged: () => { n += 1; if (n === 1) throw new Error('boom'); return Promise.reject(new Error('boom')); } });
});

test('dash.hook_failed names the error by a known class or a system code only: a code or name holding words is logged as Error', async () => {
  const thrown = [
    Object.assign(new Error('x'), { code: 'cal-0123abc for 966500000000' }),
    Object.assign(new Error('x'), { name: 'Sara Ahmed' }),
    Object.assign(new Error('x'), { code: 'E966500000000' }),
    Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }),
    Object.assign(new Error('x'), { code: 'ECONNRESET' }),
    new TypeError('x'),
    'a bare string 966500000000',
    // Shaped like a system code, but not one: a list of real codes decides, not a pattern (Codex r2).
    Object.assign(new Error('x'), { code: 'ERR_966500000000' }),
    Object.assign(new Error('x'), { code: 'ERR_SARA_AHMED' }),
    Object.assign(new Error('x'), { code: 'ESARA' }),
    Object.assign(new Error('x'), { code: 'SQLITE_SARA' }),
    // Real ones are still named: node:sqlite's own code, and a DNS errno.
    Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR' }),
    Object.assign(new Error('x'), { code: 'EAI_AGAIN' }),
  ];
  let i = 0;
  await withTeamRoutes(async ({ postForm, login, logs }) => {
    const cookie = await login(OWNER_PHONE);
    for (let k = 0; k < thrown.length; k += 1) {
      const res = await postForm('/v1/admin/settings', { _dash: '1', owner_as_client: k % 2 ? '0' : '1' }, { cookie });
      assert.equal(res.headers.get('location'), '/dashboard/team?ok=setting');
    }
    const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
    assert.deepEqual(failed.map((l) => l.error), [
      'Error', 'Error', 'Error', 'SQLITE_BUSY', 'ECONNRESET', 'TypeError', 'Error',
      'Error', 'Error', 'Error', 'Error', 'ERR_SQLITE_ERROR', 'EAI_AGAIN',
    ]);
    assert.doesNotMatch(JSON.stringify(logs), /966500000000|Sara|SARA|cal-0123abc|bare string/);
  }, { onSettingChanged: () => { throw thrown[i++]; } });
});

test('a hook is called on the object it came from, so a method-style module keeps its `this`', async () => {
  const viewing = {
    seen: [],
    onTaskChange(task) { this.seen.push(['task', task.task_id]); },
    onLeadLeaving(leadId) { this.seen.push(['leaving', leadId]); },
  };
  await withTeamRoutes(async ({ db, postForm, login, logs }) => {
    const leadId = seedLead(db, { phone: '966500000079', inboxState: 'in' });
    const task = addTask(db, { leadId, kind: 'viewing', source: 'owner', details: { note: 'x' }, dueTs: Date.UTC(2026, 11, 1, 13, 30), now: Date.UTC(2026, 10, 27) });
    const cookie = await login(OWNER_PHONE);
    await postForm(`/v1/admin/leads/${leadId}/task`, { _dash: '1', task_id: task.task_id, status: 'cancelled' }, { cookie });
    assert.equal((await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie })).status, 303);
    assert.deepEqual(viewing.seen, [['task', task.task_id], ['leaving', leadId]]);
    assert.equal(logs.filter((l) => l.evt === 'dash.hook_failed').length, 0);
  }, ({ db }) => ({ inbox: createInboxStore(db), hooks: viewing }));
});

test('the Team page shows the AI-service banner while brain_out is set, and renders the injected ops()', async () => {
  const at = Date.UTC(2026, 9, 3, 9, 30);
  await withTeamRoutes(async ({ team, get, login }) => {
    const cookie = await login(OWNER_PHONE);
    let html = await (await get('/dashboard/team', { cookie })).text();
    assert.doesNotMatch(html, /AI service has not answered/);
    assert.match(html, /<td>answers_24h<\/td><td>7<\/td>/);
    team.setSetting('brain_out', String(at));
    html = await (await get('/dashboard/team', { cookie })).text();
    assert.match(html, /The AI service has not answered since 2026-10-03 12:30 Riyadh time\./);
    // Junk that fits the 16-digit write pattern is no outage: no banner "since —".
    team.setSetting('brain_out', '9999999999999999');
    html = await (await get('/dashboard/team', { cookie })).text();
    assert.doesNotMatch(html, /AI service has not answered/);
  }, { ops: () => ({ answers_24h: 7 }) });
});

test('an ops() result that cannot be shown (a cycle) still opens the Team page', async () => {
  const loop = { turns: 1 };
  loop.self = loop;
  await withTeamRoutes(async ({ get, login }) => {
    const cookie = await login(OWNER_PHONE);
    const res = await get('/dashboard/team', { cookie });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<td>loop<\/td><td>—<\/td>/);
  }, { ops: () => ({ loop }) });
});

test('an ops() result whose value throws when read still opens the Team page: that row is a dash, the rest are shown', async () => {
  await withTeamRoutes(async ({ get, login }) => {
    const cookie = await login(OWNER_PHONE);
    const res = await get('/dashboard/team', { cookie });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<td>count<\/td><td>—<\/td>/);
    assert.match(html, /<td>answers_24h<\/td><td>4<\/td>/);
    assert.doesNotMatch(html, /unavailable/);
  }, { ops: () => ({ get count() { throw new Error('unavailable'); }, answers_24h: 4 }) });
});

test('an ops() that returns a promise is not waited for: the placeholder, and a rejection is only logged', async () => {
  await withTeamRoutes(async ({ get, login, logs }) => {
    const cookie = await login(OWNER_PHONE);
    for (let k = 0; k < 2; k += 1) {
      const res = await get('/dashboard/team', { cookie });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /No counts yet\./);
      assert.doesNotMatch(html, /answers_24h/);
    }
    await settle();
    assert.deepEqual(logs.filter((l) => l.evt === 'dash.hook_failed').map((l) => [l.hook, l.error]), [['ops', 'Error']], 'the rejected one, by class only');
    assert.doesNotMatch(JSON.stringify(logs), /ops down 966/);
  }, (() => {
    let k = 0;
    return { ops: () => (k++ === 0 ? Promise.resolve({ answers_24h: 9 }) : Promise.reject(new Error('ops down 966500000000'))) };
  })());
});

test('without an ops() the Team page shows the placeholder; a throwing ops() is logged and the page still opens', async () => {
  await withTeamRoutes(async ({ get, login }) => {
    const cookie = await login(OWNER_PHONE);
    const res = await get('/dashboard/team', { cookie });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /No counts yet\./);
  });
  await withTeamRoutes(async ({ get, login, logs }) => {
    const cookie = await login(OWNER_PHONE);
    const res = await get('/dashboard/team', { cookie });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /No counts yet\./);
    assert.ok(logs.some((l) => l.evt === 'dash.hook_failed' && l.hook === 'ops'));
  }, { ops: () => { throw new Error('ops down'); } });
});

test('hooks.onTaskChange(task, patch) runs after an owner changes a task; adding one does not call it, and a failing hook is only logged', async () => {
  const calls = [];
  await withTeamRoutes(async ({ db, postForm, login, logs }) => {
    const leadId = seedLead(db, { phone: '966500000071', inboxState: 'in' });
    const task = addTask(db, { leadId, kind: 'viewing', source: 'owner', details: { note: 'x' }, dueTs: Date.UTC(2026, 11, 1, 13, 30), now: Date.UTC(2026, 10, 27) });
    const cookie = await login(OWNER_PHONE);
    const added = await postForm(`/v1/admin/leads/${leadId}/task`, { _dash: '1', kind: 'followup', due_at: '2026-12-02T10:00' }, { cookie });
    assert.equal(added.status, 303);
    assert.equal(calls.length, 0, 'a new task is not a change');
    const res = await postForm(`/v1/admin/leads/${leadId}/task`, { _dash: '1', task_id: task.task_id, status: 'cancelled' }, { cookie });
    assert.equal(res.headers.get('location'), `/dashboard/leads/${leadId}?ok=task`);
    await settle();
    assert.equal(calls.length, 1);
    const [seen, patch] = calls[0];
    assert.equal(seen.task_id, task.task_id);
    assert.equal(seen.status, 'cancelled', 'the hook gets the task as saved');
    assert.deepEqual(patch, { status: 'cancelled', dueTs: undefined });
    const moved = await postForm(`/v1/admin/leads/${leadId}/task`, { _dash: '1', task_id: task.task_id, status: 'cancelled', due_at: '2026-12-03T12:00' }, { cookie });
    assert.equal(moved.headers.get('location'), `/dashboard/leads/${leadId}?ok=task`, 'a failing hook does not turn a saved task into an error');
    await settle();
    assert.deepEqual(calls[1][1], { status: 'cancelled', dueTs: Date.parse('2026-12-03T12:00:00+03:00') });
    assert.ok(logs.some((l) => l.evt === 'dash.hook_failed' && l.hook === 'onTaskChange'));
    const refused = await postForm(`/v1/admin/leads/${leadId}/task`, { _dash: '1', task_id: task.task_id, status: 'nonsense' }, { cookie });
    assert.equal(refused.headers.get('location'), `/dashboard/leads/${leadId}?error=bad_task`);
    await settle();
    assert.equal(calls.length, 2, 'a refused change is no change');
  }, { hooks: { onTaskChange: (task, patch) => { calls.push([task, patch]); if (calls.length === 2) throw new Error('calendar down'); } } });
});

/** One client message in a chat's transcript, so a test can tell whether the purge has run yet. */
const seedMessage = (inbox, leadId, key) => inbox.upsertMessage({
  key_id: key, lead_id: leadId, jid: null, direction: 'in', sender_kind: 'client', text: 'hello', ts: Date.UTC(2026, 10, 27, 9),
});

test('hooks.onLeadLeaving(leadId) runs before "Not a client" takes the chat out, while its transcript is still there', async () => {
  const seen = [];
  let inbox;
  await withTeamRoutes(async ({ db, postForm, login, logs }) => {
    const leadId = seedLead(db, { phone: '966500000072', inboxState: 'in' });
    seedMessage(inbox, leadId, 'K-72');
    const cookie = await login(OWNER_PHONE);
    const res = await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie });
    assert.equal(res.status, 303);
    assert.deepEqual(seen, [[leadId, 'in', 1]], 'called once, while the lead is still in and before its transcript goes');
    assert.equal(db.getLead(leadId).inbox_state, 'out');
    assert.equal(inbox.countMessages(leadId), 0);
    assert.equal(logs.filter((l) => l.evt === 'dash.hook_failed').length, 0);
  }, ({ db }) => {
    inbox = createInboxStore(db);
    return { inbox, hooks: { onLeadLeaving: (id) => { seen.push([id, db.getLead(id).inbox_state, inbox.countMessages(id)]); } } };
  });
});

test('a throwing onLeadLeaving stops the purge (DESIGN §8.4: marks first, then deletes): the chat and its transcript stay, logged by name only', async () => {
  let inbox;
  await withTeamRoutes(async ({ db, audit, postForm, login, logs }) => {
    const leadId = seedLead(db, { phone: '966500000073', inboxState: 'in' });
    seedMessage(inbox, leadId, 'K-73');
    const cookie = await login(OWNER_PHONE);
    const auditBefore = audit.recent(500).length;
    const res = await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie });
    assert.equal(res.status, 500);
    assert.equal(db.getLead(leadId).inbox_state, 'in', 'still in: nothing was purged without the mark');
    assert.equal(inbox.countMessages(leadId), 1, 'the transcript is still there');
    assert.equal(audit.recent(500).length, auditBefore, 'no inbox_out was audited');
    // The same for a number that becomes a never-list one: the chat is not taken out without the mark.
    const cousin = seedLead(db, { id: 'LEAD-20260908-aaaa0004', phone: '966500000077', inboxState: 'in' });
    seedMessage(inbox, cousin, 'K-77');
    const never = await postForm('/v1/admin/never', { _dash: '1', phone: '0500000077' }, { cookie });
    assert.equal(never.status, 500);
    assert.equal(db.getLead(cousin).inbox_state, 'in');
    assert.equal(inbox.countMessages(cousin), 1);
    const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
    assert.deepEqual(failed.map((l) => [l.hook, l.target, l.error]), [['onLeadLeaving', leadId, 'Error'], ['onLeadLeaving', cousin, 'Error']]);
    assert.doesNotMatch(JSON.stringify(logs), /cal-secret|966500000073@/, 'neither the hook_failed line nor the 500 line carries the error\'s words');
  }, ({ db }) => {
    inbox = createInboxStore(db);
    return { inbox, hooks: { onLeadLeaving: () => { throw new Error('cal-secret 966500000073@example.com'); } } };
  });
});

test('hooks.onLeadLeaving(leadId) runs when a new colleague or never-list number takes a chat out of the inbox', async () => {
  const seen = [];
  await withTeamRoutes(async ({ db, postForm, login }) => {
    const colleague = seedLead(db, { phone: '966500000074', inboxState: 'in' });
    const cousin = seedLead(db, { id: 'LEAD-20260908-aaaa0003', phone: '966500000075', inboxState: 'in' });
    const cookie = await login(OWNER_PHONE);
    await postForm('/v1/admin/team', { _dash: '1', name: 'Omar', phone: '0500000074', role: 'staff' }, { cookie });
    assert.deepEqual(seen, [[colleague, 'in']]);
    assert.equal(db.getLead(colleague).inbox_state, 'out');
    await postForm('/v1/admin/never', { _dash: '1', phone: '0500000075', note: 'cousin' }, { cookie });
    assert.deepEqual(seen, [[colleague, 'in'], [cousin, 'in']]);
    assert.equal(db.getLead(cousin).inbox_state, 'out');
    // A number with no chat in the inbox: nothing leaves, so nothing is called.
    await postForm('/v1/admin/never', { _dash: '1', phone: '0500000076' }, { cookie });
    assert.equal(seen.length, 2);
  }, ({ db }) => ({ inbox: createInboxStore(db), hooks: { onLeadLeaving: (id) => { seen.push([id, db.getLead(id).inbox_state]); } } }));
});

test('an onLeadLeaving that returns a promise is refused like a throw (it cannot be waited for): nothing leaves, nothing is kept half-done', async () => {
  let inbox;
  let k = 0;
  // A resolved promise and a rejected one alike: neither has marked anything as far as the purge can tell.
  const answers = [() => Promise.resolve(), () => Promise.reject(new Error('cal-secret 966500000080@example.com'))];
  await withTeamRoutes(async ({ db, team, audit, postForm, login, logs }) => {
    const cookie = await login(OWNER_PHONE);
    const leadId = seedLead(db, { phone: '966500000080', inboxState: 'in' });
    seedMessage(inbox, leadId, 'K-80');
    const colleague = seedLead(db, { id: 'LEAD-20260908-aaaa0005', phone: '966500000081', inboxState: 'in' });
    seedMessage(inbox, colleague, 'K-81');
    const auditBefore = audit.recent(500).length;
    for (let n = 0; n < answers.length; n += 1) {
      const res = await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie });
      assert.equal(res.status, 500, `Not a client, answer ${n}`);
      assert.equal(db.getLead(leadId).inbox_state, 'in');
      assert.equal(inbox.countMessages(leadId), 1, 'the transcript is still there');
    }
    const add = await postForm('/v1/admin/team', { _dash: '1', name: 'Omar', phone: '0500000081', role: 'staff' }, { cookie });
    assert.equal(add.status, 500);
    assert.equal(team.getUserByPhone('966500000081'), null, 'no account without the chat leaving');
    assert.equal(db.getLead(colleague).inbox_state, 'in');
    assert.equal(inbox.countMessages(colleague), 1);
    await settle();
    assert.equal(audit.recent(500).length, auditBefore, 'no inbox_out, no team_add');
    const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
    assert.deepEqual(failed.map((l) => [l.hook, l.target, l.error]), [
      ['onLeadLeaving', leadId, 'TypeError'], ['onLeadLeaving', leadId, 'TypeError'], ['onLeadLeaving', colleague, 'TypeError'],
    ], 'logged once each, when refused; a later settling adds nothing');
    assert.doesNotMatch(JSON.stringify(logs), /cal-secret|966500000080@/);
  }, ({ db }) => {
    inbox = createInboxStore(db);
    return { inbox, hooks: { onLeadLeaving: () => answers[k++ % answers.length]() } };
  });
});

test('a failing onLeadLeaving on "Add a person" or the never list takes the whole step back: no account or never row, no audit, the candidate and the chat stay; a retry then works', async () => {
  let inbox;
  let failing = true;
  await withTeamRoutes(async ({ db, team, audit, postForm, login }) => {
    const cookie = await login(OWNER_PHONE);
    const colleague = seedLead(db, { phone: '966500000082', inboxState: 'in' });
    seedMessage(inbox, colleague, 'K-82');
    const cand = inbox.noteCandidate({ phone: '966500000082', jid: '966500000082@s.whatsapp.net', ts: Date.UTC(2026, 10, 27, 9), words: ['villa'], dir: 'in' }).cand_id;
    const cousin = seedLead(db, { id: 'LEAD-20260908-aaaa0006', phone: '966500000083', inboxState: 'in' });
    seedMessage(inbox, cousin, 'K-83');
    const auditBefore = audit.recent(500).length;

    const add = await postForm('/v1/admin/team', { _dash: '1', name: 'Omar', phone: '0500000082', role: 'staff' }, { cookie });
    assert.equal(add.status, 500);
    assert.equal(team.getUserByPhone('966500000082'), null, 'the account went back with the rest');
    assert.ok(inbox.getCandidate(cand), 'so did the candidate row');
    assert.equal(db.getLead(colleague).inbox_state, 'in');
    assert.equal(inbox.countMessages(colleague), 1);
    const never = await postForm('/v1/admin/never', { _dash: '1', phone: '0500000083', note: 'cousin' }, { cookie });
    assert.equal(never.status, 500);
    assert.equal(team.isExcludedPhone('966500000083'), false, 'the never row went back too');
    assert.equal(team.listNever().length, 0);
    assert.equal(db.getLead(cousin).inbox_state, 'in');
    assert.equal(inbox.countMessages(cousin), 1);
    assert.equal(team.getSetting('owner_summary_day'), '', 'and the hook\'s own row writes, made before it threw');
    assert.equal(audit.recent(500).length, auditBefore, 'no team_add, no never_add, no inbox_out');

    // Once the hook works, the very same posts go through: no duplicate_phone, nothing left behind.
    failing = false;
    const again = await postForm('/v1/admin/team', { _dash: '1', name: 'Omar', phone: '0500000082', role: 'staff' }, { cookie });
    assert.equal(again.headers.get('location'), '/dashboard/team?ok=added');
    assert.ok(team.getUserByPhone('966500000082'));
    assert.equal(inbox.getCandidate(cand), null);
    assert.equal(db.getLead(colleague).inbox_state, 'out');
    assert.equal(inbox.countMessages(colleague), 0);
    const neverAgain = await postForm('/v1/admin/never', { _dash: '1', phone: '0500000083', note: 'cousin' }, { cookie });
    assert.equal(neverAgain.headers.get('location'), '/dashboard/team?ok=never_added');
    assert.equal(db.getLead(cousin).inbox_state, 'out');
    assert.deepEqual(audit.recent(4).map((r) => [r.action, r.target]).reverse(), [
      ['team_add', team.getUserByPhone('966500000082').user_id], ['inbox_out', colleague], ['never_add', null], ['inbox_out', cousin],
    ]);
  }, ({ db, team }) => {
    inbox = createInboxStore(db);
    return {
      inbox,
      hooks: {
        onLeadLeaving: () => {
          if (!failing) return;
          team.setSetting('owner_summary_day', '2026-11-27');
          throw new Error('calendar down');
        },
      },
    };
  });
});

test('Not a client marks and purges in one step: a purge that fails after the hook wrote its marks takes the marks back too', async () => {
  let inbox;
  await withTeamRoutes(async ({ db, team, audit, postForm, login }) => {
    const cookie = await login(OWNER_PHONE);
    const leadId = seedLead(db, { phone: '966500000084', inboxState: 'in' });
    seedMessage(inbox, leadId, 'K-84');
    const auditBefore = audit.recent(500).length;
    const real = inbox.leaveInbox;
    // The purge does its work, then the disk fails before the request is done.
    inbox.leaveInbox = (id) => { real(id); throw new Error('disk I/O error'); };
    try {
      const res = await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie });
      assert.equal(res.status, 500);
    } finally {
      inbox.leaveInbox = real;
    }
    assert.equal(db.getLead(leadId).inbox_state, 'in');
    assert.equal(inbox.countMessages(leadId), 1, 'the transcript came back with the rollback');
    assert.equal(team.getSetting('owner_summary_day'), '', 'the mark did not outlive the purge it was for');
    assert.equal(audit.recent(500).length, auditBefore);
  }, ({ db, team }) => {
    inbox = createInboxStore(db);
    return { inbox, hooks: { onLeadLeaving: () => { team.setSetting('owner_summary_day', '2026-11-27'); } } };
  });
});

test('an onLeadLeaving that throws a falsy value (undefined, null, 0, \'\', false) stops the step like any throw', async () => {
  let inbox;
  let k = 0;
  const falsy = [undefined, null, 0, '', false];
  await withTeamRoutes(async ({ db, team, audit, postForm, login, logs }) => {
    const cookie = await login(OWNER_PHONE);
    const leadId = seedLead(db, { phone: '966500000085', inboxState: 'in' });
    seedMessage(inbox, leadId, 'K-85');
    const colleague = seedLead(db, { id: 'LEAD-20260908-aaaa0007', phone: '966500000086', inboxState: 'in' });
    seedMessage(inbox, colleague, 'K-86');
    const cousin = seedLead(db, { id: 'LEAD-20260908-aaaa0008', phone: '966500000087', inboxState: 'in' });
    seedMessage(inbox, cousin, 'K-87');
    const auditBefore = audit.recent(500).length;
    for (const value of falsy) {
      const res = await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie });
      assert.equal(res.status, 500, `Not a client, throw ${String(value)}`);
      assert.equal(db.getLead(leadId).inbox_state, 'in');
      assert.equal(inbox.countMessages(leadId), 1, 'the transcript is still there');
    }
    const add = await postForm('/v1/admin/team', { _dash: '1', name: 'Omar', phone: '0500000086', role: 'staff' }, { cookie });
    assert.equal(add.status, 500);
    assert.equal(team.getUserByPhone('966500000086'), null);
    assert.equal(inbox.countMessages(colleague), 1);
    const never = await postForm('/v1/admin/never', { _dash: '1', phone: '0500000087' }, { cookie });
    assert.equal(never.status, 500);
    assert.equal(team.isExcludedPhone('966500000087'), false);
    assert.equal(inbox.countMessages(cousin), 1);
    assert.equal(audit.recent(500).length, auditBefore);
    const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
    assert.deepEqual(failed.map((l) => [l.hook, l.error]), Array(falsy.length + 2).fill(['onLeadLeaving', 'Error']));
  }, ({ db }) => {
    inbox = createInboxStore(db);
    return { inbox, hooks: { onLeadLeaving: () => { throw falsy[k++ % falsy.length]; } } };
  });
});

test('an async or generator onLeadLeaving is refused before it is called: none of its work can land after the step is rolled back', async () => {
  let inbox;
  let store;
  let ran = 0;
  const hooks = {};
  // Each would write its mark only after the route has answered: an async body after an await,
  // a generator body never (nobody steps it), so the purge would go ahead with no mark at all.
  const mark = () => store.setSetting('owner_summary_day', '2026-11-27');
  const variants = [
    async function onLeadLeaving() { ran += 1; await null; mark(); },
    async () => { ran += 1; await null; mark(); },
    function* onLeadLeaving() { ran += 1; mark(); },
    async function* onLeadLeaving() { ran += 1; mark(); },
  ];
  await withTeamRoutes(async ({ db, team, audit, postForm, login, logs }) => {
    const cookie = await login(OWNER_PHONE);
    const leadId = seedLead(db, { phone: '966500000088', inboxState: 'in' });
    seedMessage(inbox, leadId, 'K-88');
    const colleague = seedLead(db, { id: 'LEAD-20260908-aaaa0009', phone: '966500000089', inboxState: 'in' });
    seedMessage(inbox, colleague, 'K-89');
    const auditBefore = audit.recent(500).length;
    for (const fn of variants) {
      hooks.onLeadLeaving = fn;
      const res = await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie });
      assert.equal(res.status, 500);
      await settle();
      assert.equal(db.getLead(leadId).inbox_state, 'in');
      assert.equal(inbox.countMessages(leadId), 1);
    }
    hooks.onLeadLeaving = variants[0];
    const add = await postForm('/v1/admin/team', { _dash: '1', name: 'Omar', phone: '0500000089', role: 'staff' }, { cookie });
    assert.equal(add.status, 500);
    await settle();
    assert.equal(team.getUserByPhone('966500000089'), null);
    assert.equal(inbox.countMessages(colleague), 1);
    assert.equal(ran, 0, 'never called, so nothing of it started');
    assert.equal(team.getSetting('owner_summary_day'), '', 'and no mark was written after the rollback');
    assert.equal(audit.recent(500).length, auditBefore);
    const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
    assert.deepEqual(failed.map((l) => [l.hook, l.error]), Array(variants.length + 1).fill(['onLeadLeaving', 'TypeError']));
  }, ({ db, team }) => {
    inbox = createInboxStore(db);
    store = team;
    return { inbox, hooks };
  });
});

test('dash.hook_failed reads an error\'s code and name once each, and an error that throws when read is logged as Error, never a 500 or an unhandled rejection', async () => {
  let codeReads = 0;
  let nameReads = 0;
  const secret = 'cal-secret 966500000000';
  const made = [
    // A known value on the first read only, the secret on any later one: one read decides and is logged
    // (Codex r4: counted, so a second read fails here even when it would log a known value).
    () => { throw Object.defineProperty(new Error('x'), 'code', { get: () => (++codeReads === 1 ? 'SQLITE_BUSY' : secret) }); },
    () => { throw Object.defineProperty(new Error('x'), 'name', { get: () => (++nameReads === 1 ? 'TypeError' : secret) }); },
    () => { throw Object.defineProperty(new Error('x'), 'code', { get() { throw new Error(secret); } }); },
    () => { throw new Proxy(new Error('x'), { get() { throw new Error(secret); } }); },
    () => Promise.reject(Object.defineProperty(new Error('x'), 'name', { get() { throw new Error(secret); } })),
  ];
  let i = 0;
  await withTeamRoutes(async ({ postForm, login, logs }) => {
    const cookie = await login(OWNER_PHONE);
    for (let k = 0; k < made.length; k += 1) {
      const res = await postForm('/v1/admin/settings', { _dash: '1', email_replies: k % 2 ? '0' : '1' }, { cookie });
      assert.equal(res.headers.get('location'), '/dashboard/team?ok=setting', `error ${k}`);
    }
    await settle();
    const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
    assert.deepEqual(failed.map((l) => l.error), ['SQLITE_BUSY', 'TypeError', 'Error', 'Error', 'Error']);
    assert.equal(codeReads, 1, 'the code is read once');
    assert.equal(nameReads, 1, 'the name is read once');
    assert.doesNotMatch(JSON.stringify(logs), /cal-secret/);
  }, { onSettingChanged: () => made[i++]() });
});

test('a hook\'s thenable is watched without trusting its `then`: an async `then` that throws is logged once and never an unhandled rejection; one that rejects and then throws is logged once; one that resolves and then throws is no failure; one that resolves with a rejected promise is logged once', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  const secret = 'cal-secret 966500000000';
  const made = [
    () => ({ async then() { throw new Error(secret); } }),
    () => ({ then(_ok, fail) { fail(new TypeError('x')); throw new Error(secret); } }),
    () => ({ then(ok) { ok(1); throw new Error(secret); } }),
    () => ({ then(ok) { ok(Promise.reject(new RangeError(secret))); } }),
  ];
  let i = 0;
  try {
    await withTeamRoutes(async ({ postForm, login, logs }) => {
      const cookie = await login(OWNER_PHONE);
      for (let k = 0; k < made.length; k += 1) {
        const res = await postForm('/v1/admin/settings', { _dash: '1', email_replies: k % 2 ? '0' : '1' }, { cookie });
        assert.equal(res.headers.get('location'), '/dashboard/team?ok=setting', `thenable ${k}`);
      }
      await settle();
      const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
      assert.deepEqual(failed.map((l) => [l.hook, l.target, l.error]), [
        ['onSettingChanged', 'email_replies', 'Error'], ['onSettingChanged', 'email_replies', 'TypeError'],
        ['onSettingChanged', 'email_replies', 'RangeError'],
      ]);
      assert.doesNotMatch(JSON.stringify(logs), /cal-secret/);
    }, { onSettingChanged: () => made[i++]() });
    await settle();
    assert.deepEqual(unhandled, [], 'no rejection is left for Node to report');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('an onLeadLeaving thenable whose async `then` throws is refused once and leaves no unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  let inbox;
  try {
    await withTeamRoutes(async ({ db, postForm, login, logs }) => {
      const cookie = await login(OWNER_PHONE);
      const leadId = seedLead(db, { phone: '966500000094', inboxState: 'in' });
      seedMessage(inbox, leadId, 'K-94');
      const res = await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie });
      assert.equal(res.status, 500);
      await settle();
      assert.equal(db.getLead(leadId).inbox_state, 'in');
      assert.equal(inbox.countMessages(leadId), 1);
      const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
      assert.deepEqual(failed.map((l) => [l.hook, l.target, l.error]), [['onLeadLeaving', leadId, 'TypeError']]);
      assert.doesNotMatch(JSON.stringify(logs), /cal-secret/);
    }, ({ db }) => {
      inbox = createInboxStore(db);
      return { inbox, hooks: { onLeadLeaving: () => ({ async then() { throw new Error('cal-secret 966500000094'); } }) } };
    });
    await settle();
    assert.deepEqual(unhandled, [], 'no rejection is left for Node to report');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('an async or generator onLeadLeaving that carries a tag of its own is still refused: by its prototype before the call, or by the iterator it hands back; the purge never runs without its marks', async () => {
  let inbox;
  let store;
  let ran = 0;
  const hooks = {};
  const mark = () => store.setSetting('owner_summary_day', '2026-11-27');
  // Object.prototype.toString now says "[object Function]" for each (Codex r4).
  const tagged = (fn) => Object.defineProperty(fn, Symbol.toStringTag, { value: 'Function' });
  const variants = [
    tagged(function* onLeadLeaving() { ran += 1; mark(); }),
    tagged(async function onLeadLeaving() { ran += 1; await null; mark(); }),
    tagged(async function* onLeadLeaving() { ran += 1; mark(); }),
    // Its prototype swapped as well, so it is called; a generator's body still has not run, and what it returns is refused.
    Object.setPrototypeOf(tagged(function* onLeadLeaving() { ran += 1; mark(); }), Function.prototype),
    Object.setPrototypeOf(tagged(async function* onLeadLeaving() { ran += 1; mark(); }), Function.prototype),
  ];
  await withTeamRoutes(async ({ db, team, audit, postForm, login, logs }) => {
    const cookie = await login(OWNER_PHONE);
    const leadId = seedLead(db, { phone: '966500000095', inboxState: 'in' });
    seedMessage(inbox, leadId, 'K-95');
    const colleague = seedLead(db, { id: 'LEAD-20260908-aaaa0012', phone: '966500000096', inboxState: 'in' });
    seedMessage(inbox, colleague, 'K-96');
    const auditBefore = audit.recent(500).length;
    for (const [k, fn] of variants.entries()) {
      hooks.onLeadLeaving = fn;
      const res = await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie });
      assert.equal(res.status, 500, `variant ${k}`);
      await settle();
      assert.equal(db.getLead(leadId).inbox_state, 'in', `variant ${k}: the chat stays in`);
      assert.equal(inbox.countMessages(leadId), 1, `variant ${k}: its transcript stays`);
    }
    hooks.onLeadLeaving = variants[3];
    const add = await postForm('/v1/admin/team', { _dash: '1', name: 'Omar', phone: '0500000096', role: 'staff' }, { cookie });
    assert.equal(add.status, 500);
    await settle();
    assert.equal(team.getUserByPhone('966500000096'), null);
    assert.equal(inbox.countMessages(colleague), 1);
    assert.equal(ran, 0, 'no body ran');
    assert.equal(team.getSetting('owner_summary_day'), '', 'and no mark was written after the rollback');
    assert.equal(audit.recent(500).length, auditBefore);
    const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
    assert.deepEqual(failed.map((l) => [l.hook, l.error]), Array(variants.length + 1).fill(['onLeadLeaving', 'TypeError']));
  }, ({ db, team }) => {
    inbox = createInboxStore(db);
    store = team;
    return { inbox, hooks };
  });
});

test('an onTaskChange that throws when it is read is a failed hook, not a failed save: the task is saved, the owner sees ok=task, and it is logged by name', async () => {
  const secret = 'cal-secret 966500000000';
  const shapes = [
    { get onTaskChange() { throw new Error(secret); } },
    new Proxy({}, { get(_t, key) { if (key === 'onTaskChange') throw new Error(secret); return undefined; } }),
  ];
  for (const hooks of shapes) {
    await withTeamRoutes(async ({ db, postForm, login, logs }) => {
      const leadId = seedLead(db, { phone: '966500000097', inboxState: 'in' });
      const task = addTask(db, { leadId, kind: 'viewing', source: 'owner', details: { note: 'x' }, dueTs: Date.UTC(2026, 11, 1, 13, 30), now: Date.UTC(2026, 10, 27) });
      const cookie = await login(OWNER_PHONE);
      const res = await postForm(`/v1/admin/leads/${leadId}/task`, { _dash: '1', task_id: task.task_id, status: 'cancelled' }, { cookie });
      assert.equal(res.headers.get('location'), `/dashboard/leads/${leadId}?ok=task`);
      assert.equal(tasksForLead(db, leadId).find((t) => t.task_id === task.task_id).status, 'cancelled', 'the change is saved');
      await settle();
      const failed = logs.filter((l) => l.evt === 'dash.hook_failed');
      assert.deepEqual(failed.map((l) => [l.hook, l.target, l.error]), [['onTaskChange', task.task_id, 'Error']]);
      assert.doesNotMatch(JSON.stringify(logs), /cal-secret/);
    }, { hooks });
  }
});

test('an ops() result is checked for a promise once, inside the guard: a value that throws when read again still opens the Team page', async () => {
  let thenReads = 0;
  const counts = new Proxy({ answers_24h: 5 }, {
    get(target, key, receiver) {
      if (key === 'then' && thenReads++ > 0) throw new Error('ops-secret 966500000000');
      return Reflect.get(target, key, receiver);
    },
  });
  await withTeamRoutes(async ({ get, login, logs }) => {
    const cookie = await login(OWNER_PHONE);
    const res = await get('/dashboard/team', { cookie });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<td>answers_24h<\/td><td>5<\/td>/);
    assert.doesNotMatch(JSON.stringify(logs), /ops-secret/);
  }, { ops: () => counts });
});

test('the audit rows of Not a client, Add a person and the never list are written after their step commits: an audit error that rolls the transaction back cannot undo the step', async () => {
  let inbox;
  // SQLITE_FULL, SQLITE_IOERR or SQLITE_NOMEM can make SQLite roll the whole transaction back on
  // its own, and lib/audit.mjs swallows the insert's error (logged as audit.failed). This audit
  // does just that for the three actions, so the step must not be inside the transaction it ends.
  const lost = new Set(['inbox_out', 'team_add', 'never_add']);
  await withTeamRoutes(async ({ db, team, postForm, login }) => {
    const cookie = await login(OWNER_PHONE);
    const leadId = seedLead(db, { phone: '966500000090', inboxState: 'in' });
    seedMessage(inbox, leadId, 'K-90');
    const colleague = seedLead(db, { id: 'LEAD-20260908-aaaa0010', phone: '966500000091', inboxState: 'in' });
    seedMessage(inbox, colleague, 'K-91');
    const cousin = seedLead(db, { id: 'LEAD-20260908-aaaa0011', phone: '966500000092', inboxState: 'in' });
    seedMessage(inbox, cousin, 'K-92');
    const out = await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie });
    assert.equal(out.headers.get('location'), '/dashboard/inbox?ok=out', 'as on main: the chat left, its audit row is lost');
    assert.equal(db.getLead(leadId).inbox_state, 'out');
    assert.equal(inbox.countMessages(leadId), 0);
    const add = await postForm('/v1/admin/team', { _dash: '1', name: 'Omar', phone: '0500000091', role: 'staff' }, { cookie });
    assert.equal(add.headers.get('location'), '/dashboard/team?ok=added');
    assert.ok(team.getUserByPhone('966500000091'), 'the account is kept');
    assert.equal(db.getLead(colleague).inbox_state, 'out');
    assert.equal(inbox.countMessages(colleague), 0);
    const never = await postForm('/v1/admin/never', { _dash: '1', phone: '0500000092' }, { cookie });
    assert.equal(never.headers.get('location'), '/dashboard/team?ok=never_added');
    assert.equal(team.isExcludedPhone('966500000092'), true);
    assert.equal(db.getLead(cousin).inbox_state, 'out');
    assert.equal(inbox.countMessages(cousin), 0);
  }, ({ db, audit }) => {
    inbox = createInboxStore(db);
    return {
      inbox,
      audit: {
        ...audit,
        record(entry) {
          if (!lost.has(entry.action)) return audit.record(entry);
          try { db.db.exec('ROLLBACK'); } catch { /* no transaction to end: the insert alone failed */ }
          return undefined;
        },
      },
    };
  });
});

test('without hooks the routes behave exactly as before: the defaults are no-ops', async () => {
  await withTeamRoutes(async ({ db, postForm, login, logs }) => {
    const leadId = seedLead(db, { phone: '966500000078', inboxState: 'in' });
    const cookie = await login(OWNER_PHONE);
    assert.equal((await postForm(`/v1/admin/inbox/${leadId}/out`, { _dash: '1' }, { cookie })).status, 303);
    assert.equal((await postForm('/v1/admin/settings', { _dash: '1', own_inbox: '1' }, { cookie })).headers.get('location'), '/dashboard/team?ok=setting');
    assert.equal(logs.filter((l) => l.evt === 'dash.hook_failed').length, 0);
  }, ({ db }) => ({ inbox: createInboxStore(db) }));
});

/* ---------------- T08 (PR-A3, DESIGN §3.3): login return-to, "Let the AI answer again", the booked-task guard, the inbox rules ---------------- */

/** The PLAN T08 test 1 values: none of them is a place a login returns to. */
const BAD_NEXT = ['//evil.example', '/dashboard//x', '/dashboard/leads/../../v1', 'https://evil.example', '%2F%2Fevil', `/dashboard/leads/${'a'.repeat(81)}`];
const withNextQuery = (next) => `next=${encodeURIComponent(next)}`;

/** A code request carrying extra form fields (the login form's hidden `next`), read back off the "phone". */
async function codeWith(h, fields = {}, opts = {}) {
  const before = h.sent.length;
  const res = await h.postForm('/dashboard/login/code', { _dash: '1', phone: '0593296933', ...fields }, opts);
  await h.app.dashboard?.auth?.flush?.();
  const code = h.sent.length > before ? (/(\d{6})/.exec(h.sent.at(-1) ?? '')?.[1] ?? null) : null;
  return { res, code, nonce: h.cookieValue(res, 'bona_dash_try') };
}

test('T08-1 a next= that is not a lead or inbox deep link falls back to /dashboard: never carried, never set as a cookie, never followed', async () => {
  for (const next of BAD_NEXT) {
    await withDash({}, async (h) => {
      const page = await (await h.get(`/dashboard/login?${withNextQuery(next)}`)).text();
      assert.doesNotMatch(page, /name="next"/, `${next}: the login form does not carry it`);
      const asked = await codeWith(h, { next });
      assert.equal(asked.res.headers.get('location'), '/dashboard/login?step=code&sent=1', `${next}: the code step does not carry it`);
      assert.equal(h.cookieValue(asked.res, 'bona_dash_next'), undefined, `${next}: no return-to cookie`);
      const wrong = String((Number(asked.code) + 1) % 1_000_000).padStart(6, '0');
      const missed = await h.postForm('/dashboard/login/verify', { _dash: '1', code: wrong, next }, { cookie: `bona_dash_try=${asked.nonce}` });
      assert.equal(missed.headers.get('location'), '/dashboard/login?step=code&error=bad_code', `${next}: a wrong code does not carry it`);
      // A cookie the server never set (a sibling subdomain can plant one) is checked the same way as the field.
      const verified = await h.postForm('/dashboard/login/verify', { _dash: '1', code: asked.code, next },
        { cookie: `bona_dash_try=${asked.nonce}; bona_dash_next=${encodeURIComponent(next)}` });
      assert.equal(verified.status, 303);
      assert.equal(verified.headers.get('location'), '/dashboard', `${next}: the verify falls back`);
      const cookie = `bona_dash=${h.cookieValue(verified, 'bona_dash')}`;
      const signedIn = await h.get(`/dashboard/login?${withNextQuery(next)}`, { cookie });
      assert.equal(signedIn.status, 302);
      assert.equal(signedIn.headers.get('location'), '/dashboard', `${next}: a signed-in login page falls back`);
    });
  }
});

test('T08-2 next rides the code step: the gate adds it for a deep link, both forms carry it, the code step sets a login-scoped cookie, and verify lands on it', async () => {
  await withDash({}, async (h) => {
    const { db, get, postForm, cookieValue, cookiesOf } = h;
    const id = seedLead(db, { phone: '966500000081', inboxState: 'in' });
    const deep = `/dashboard/leads/${id}`;

    // The auth gate: a deep link to a lead or a chat keeps where it was going; nothing else does.
    const gate = await get(deep);
    assert.equal(gate.status, 302);
    assert.equal(gate.headers.get('location'), `/dashboard/login?${withNextQuery(deep)}`);
    assert.equal((await get(`/dashboard/inbox/${id}`)).headers.get('location'), `/dashboard/login?${withNextQuery(`/dashboard/inbox/${id}`)}`);
    assert.equal((await get(`${deep}/`)).headers.get('location'), `/dashboard/login?${withNextQuery(deep)}`, 'a trailing slash is the same page');
    for (const p of ['/dashboard', '/dashboard/leads', '/dashboard/inbox', '/dashboard/team', '/dashboard/spend', `/dashboard/leads/${'a'.repeat(81)}`]) {
      assert.equal((await get(p)).headers.get('location'), '/dashboard/login', p);
    }

    // Step 1 carries it as a hidden field.
    const first = await (await get(gate.headers.get('location'))).text();
    assert.match(first, new RegExp(`<form method="post" action="/dashboard/login/code">[\\s\\S]*<input type="hidden" name="next" value="${deep}">[\\s\\S]*</form>`));

    // The code step: in the redirect, and in a cookie scoped like the try nonce.
    const asked = await codeWith(h, { next: deep });
    assert.equal(asked.res.headers.get('location'), `/dashboard/login?step=code&sent=1&${withNextQuery(deep)}`);
    const nextCookie = cookiesOf(asked.res).find((c) => c.startsWith('bona_dash_next='));
    assert.ok(nextCookie, 'the code step sets the return-to cookie');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/dashboard/login', 'Max-Age=600']) assert.ok(nextCookie.includes(flag), `${flag} missing from ${nextCookie}`);
    assert.equal(decodeURIComponent(cookieValue(asked.res, 'bona_dash_next')), deep);
    const browser = `bona_dash_try=${asked.nonce}; bona_dash_next=${cookieValue(asked.res, 'bona_dash_next')}`;

    // Step 2 carries it too, and so does "Send another code".
    const second = await (await get(asked.res.headers.get('location'))).text();
    assert.match(second, new RegExp(`<form method="post" action="/dashboard/login/verify">[\\s\\S]*<input type="hidden" name="next" value="${deep}">[\\s\\S]*</form>`));
    assert.match(second, new RegExp(`<a href="/dashboard/login\\?${withNextQuery(deep)}">Send another code</a>`));

    // A wrong code keeps it in the redirect, so the page it lands on still carries it.
    const wrong = String((Number(asked.code) + 1) % 1_000_000).padStart(6, '0');
    const missed = await postForm('/dashboard/login/verify', { _dash: '1', code: wrong, next: deep }, { cookie: browser });
    assert.equal(missed.headers.get('location'), `/dashboard/login?step=code&error=bad_code&${withNextQuery(deep)}`);

    // The right code lands on the deep link and clears the return-to cookie with the try nonce.
    const verified = await postForm('/dashboard/login/verify', { _dash: '1', code: asked.code, next: deep }, { cookie: browser });
    assert.equal(verified.status, 303);
    assert.equal(verified.headers.get('location'), deep);
    assert.ok(cookiesOf(verified).some((c) => c.startsWith('bona_dash_next=') && c.includes('Max-Age=0') && c.includes('Path=/dashboard/login')), 'the spent return-to is cleared');
    const cookie = `bona_dash=${cookieValue(verified, 'bona_dash')}`;
    assert.equal((await get(deep, { cookie })).status, 200, 'and the lead opens');

    // Signed in already: the login page sends a deep link straight on, and anything else to /dashboard as before.
    const on = await get(`/dashboard/login?${withNextQuery(deep)}`, { cookie });
    assert.equal(on.status, 302);
    assert.equal(on.headers.get('location'), deep);
    assert.equal((await get('/dashboard/login', { cookie })).headers.get('location'), '/dashboard');
  });
});

test('T08-2 the cookie alone carries next through the code step when the form loses it; a new code without next forgets an old one', async () => {
  await withDash({}, async (h) => {
    const { db, postForm, cookieValue, cookiesOf } = h;
    const id = seedLead(db, { phone: '966500000082', inboxState: 'in' });
    const deep = `/dashboard/inbox/${id}`;
    const asked = await codeWith(h, { next: deep });
    const carried = cookieValue(asked.res, 'bona_dash_next');
    const browser = `bona_dash_try=${asked.nonce}; bona_dash_next=${carried}`;
    // A verify that is refused before its body is read (a foreign origin) still says where it was going.
    const foreign = await postForm('/dashboard/login/verify', { _dash: '1', code: asked.code }, { cookie: browser, headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.headers.get('location'), `/dashboard/login?step=code&error=forbidden&${withNextQuery(deep)}`);
    // A code form without the field (an old tab) still lands on the deep link.
    const verified = await postForm('/dashboard/login/verify', { _dash: '1', code: asked.code }, { cookie: browser });
    assert.equal(verified.headers.get('location'), deep);

    // A login started over without next: the old cookie is cleared at the code step, so it cannot redirect this one.
    const plain = await codeWith(h, {}, { cookie: `bona_dash_next=${carried}` });
    assert.equal(plain.res.headers.get('location'), '/dashboard/login?step=code&sent=1');
    assert.ok(cookiesOf(plain.res).some((c) => c.startsWith('bona_dash_next=') && c.includes('Max-Age=0')), 'the stale return-to is cleared');
    assert.equal(cookiesOf(plain.res).filter((c) => c.startsWith('bona_dash_next=')).length, 1, 'cleared once, never set');
    // With no return-to anywhere the verify is as before T08: /dashboard, and no return-to cookie touched.
    const again = await postForm('/dashboard/login/verify', { _dash: '1', code: plain.code }, { cookie: `bona_dash_try=${plain.nonce}` });
    assert.equal(again.headers.get('location'), '/dashboard');
    assert.equal(cookiesOf(again).filter((c) => c.startsWith('bona_dash_next=')).length, 0, 'no return-to cookie is touched when the browser has none');
  });
});

test('T08-2 an explicitly given next that is not a return-to wins over an earlier lead\'s cookie: /dashboard, and the cookie is cleared', async () => {
  await withDash({}, async (h) => {
    const { db, postForm, cookieValue, cookiesOf } = h;
    const id = seedLead(db, { phone: '966500000080', inboxState: 'in' });
    const asked = await codeWith(h, { next: `/dashboard/leads/${id}` });
    const browser = `bona_dash_try=${asked.nonce}; bona_dash_next=${cookieValue(asked.res, 'bona_dash_next')}`;
    const cleared = (res) => cookiesOf(res).some((c) => c.startsWith('bona_dash_next=') && c.includes('Max-Age=0'));
    for (const next of ['//evil.example', '']) {
      const wrong = String((Number(asked.code) + 1) % 1_000_000).padStart(6, '0');
      const missed = await postForm('/dashboard/login/verify', { _dash: '1', code: wrong, next }, { cookie: browser });
      assert.equal(missed.headers.get('location'), '/dashboard/login?step=code&error=bad_code', `${JSON.stringify(next)}: not the cookie's lead`);
      assert.ok(cleared(missed), `${JSON.stringify(next)}: the cookie goes`);
    }
    const verified = await postForm('/dashboard/login/verify', { _dash: '1', code: asked.code, next: 'https://evil.example' }, { cookie: browser });
    assert.equal(verified.status, 303);
    assert.equal(verified.headers.get('location'), '/dashboard', 'the earlier lead is not opened');
    assert.ok(cleared(verified));
    assert.equal(cookiesOf(verified).filter((c) => c.startsWith('bona_dash_next=')).length, 1, 'cleared once');
  });
});

test('T08-2 an invalid next on the code step page clears an earlier lead\'s cookie, so the code then typed lands on /dashboard', async () => {
  await withDash({}, async (h) => {
    const id = seedLead(h.db, { phone: '966500000078', inboxState: 'in' });
    const asked = await codeWith(h, { next: `/dashboard/leads/${id}` });
    // What the browser keeps, and what it does with each page's Set-Cookie.
    const jar = { bona_dash_try: asked.nonce, bona_dash_next: h.cookieValue(asked.res, 'bona_dash_next') };
    const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const apply = (res) => { for (const name of Object.keys(jar)) if (h.cookieValue(res, name) === null) delete jar[name]; };

    // The page without a next leaves the return-to alone (an old tab still lands on the lead)...
    const plain = await h.get('/dashboard/login?step=code', { cookie: cookie() });
    assert.equal(h.cookieValue(plain, 'bona_dash_next'), undefined);
    // ...but a page that names one which is not a deep link forgets the earlier lead's.
    const page = await h.get(`/dashboard/login?step=code&${withNextQuery('//evil.example')}`, { cookie: cookie() });
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /name="next"/);
    apply(page);
    assert.equal(jar.bona_dash_next, undefined, 'the page cleared the earlier return-to');
    const verified = await h.postForm('/dashboard/login/verify', { _dash: '1', code: asked.code }, { cookie: cookie() });
    assert.equal(verified.status, 303);
    assert.equal(verified.headers.get('location'), '/dashboard', 'the earlier lead is not opened');
  });
});

/** An inbox chat (DESIGN §3.1 rule 1: `in`, with a jid) for the T08 inbox tests. */
function chatLead(db, { id, name, phone, ...over }) {
  db.insertLead({
    lead_id: id, created: Date.now() - 3_600_000, updated: Date.now(), phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`, name,
    channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: Date.now() - 3_600_000,
    inbox_state: 'in', inbox_since: Date.now() - 3_600_000, last_msg_ts: Date.now() - 60_000, ...over,
  });
  return id;
}

test('T08-3 "Let the AI answer again": anyone on the team clears the chat\'s stop and holds; audited, behind the marker and the origin check; nothing is sent', async () => {
  let inbox;
  await withTeamRoutes(async ({ db, audit, sent, postForm, login, base, logs, staffUser, owner }) => {
    const held = { dana_off: 1, dana_test: 0, dana_hold_until: Date.now() + 86_400_000, dana_hold_reason: 'loop' };
    const id = chatLead(db, { id: 'LEAD-20261128-aaaa0083', name: 'Held Client', phone: '966500000083', ...held });
    const route = `/v1/admin/inbox/${id}/answer_again`;
    const state = () => { const l = db.getLead(id); return [l.dana_off, l.dana_hold_until, l.dana_hold_reason, l.dana_test]; };
    const raw = (headers, body = '_dash=1') => fetch(base + route, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body });

    assert.equal((await raw({})).status, 401, 'signed out: refused');
    const staff = await login(STAFF_PHONE);
    const codes = sent.length;
    assert.equal((await raw({ Cookie: staff }, '')).status, 403, 'no marker: refused');
    assert.equal((await raw({ Cookie: staff, Origin: 'https://evil.example' })).status, 403, 'a foreign page: refused');
    assert.deepEqual(state(), [1, held.dana_hold_until, 'loop', 0], 'a refused post changes nothing');

    const res = await postForm(route, { _dash: '1' }, { cookie: staff });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/dashboard/inbox/${id}?ok=again`);
    assert.deepEqual(state(), [0, null, null, 0], 'dana_off and both hold columns cleared; the test switch untouched');
    const row = audit.recent(50).find((r) => r.action === 'dana_chat');
    assert.deepEqual([row.user_id, row.target, row.meta], [staffUser.user_id, id, { dana_off: 0, dana_hold_until: null, dana_hold_reason: null }]);
    assert.ok(logs.some((l) => l.evt === 'dash.dana_again' && l.leadId === id));
    assert.doesNotMatch(JSON.stringify(logs.filter((l) => l.evt === 'dash.dana_again')), /Held Client|966500000083/, 'logged by lead id only');

    // The owner too, over JSON with the header marker; a hold alone (no stop) is cleared the same way.
    db.updateLead(id, { dana_hold_reason: 'cap_chat', dana_hold_until: null });
    const ownerCookie = await login(OWNER_PHONE);
    const json = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: ownerCookie }, body: '{}' });
    assert.equal(json.status, 200);
    assert.deepEqual(await json.json(), { ok: true, dana_off: 0, dana_hold_until: null, dana_hold_reason: null });
    assert.deepEqual(state(), [0, null, null, 0]);
    assert.equal(audit.recent(50).filter((r) => r.action === 'dana_chat').length, 2);
    assert.equal(audit.recent(50).find((r) => r.action === 'dana_chat').user_id, owner.user_id);

    // Rule 1: a lead that is not an inbox chat is refused like every other inbox write.
    const out = chatLead(db, { id: 'LEAD-20261128-aaaa0084', name: 'Out Client', phone: '966500000084', inbox_state: 'out', dana_off: 1 });
    const refused = await fetch(base + `/v1/admin/inbox/${out}/answer_again`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: staff }, body: '{}' });
    assert.equal(refused.status, 404);
    assert.equal(db.getLead(out).dana_off, 1);
    assert.equal(sent.length, codes + 1, 'only the owner\'s login code went out: the button sends nothing');
  }, ({ db }) => { inbox = createInboxStore(db); return { inbox }; });
});

test('T08-3 the thread offers "Let the AI answer again" on a stopped or held chat, to staff as well', async () => {
  await withTeamRoutes(async ({ db, get, login }) => {
    const id = chatLead(db, { id: 'LEAD-20261128-aaaa0085', name: 'Stopped Client', phone: '966500000085', dana_off: 1 });
    const staff = await login(STAFF_PHONE);
    const html = await (await get(`/dashboard/inbox/${id}`, { cookie: staff })).text();
    assert.match(html, new RegExp(`action="/v1/admin/inbox/${id}/answer_again"`));
    assert.match(html, />Let the AI answer again<\/button>/);
    assert.match(html, /only if the client asked you/);
    assert.match(await (await get(`/dashboard/inbox/${id}?ok=again`, { cookie: staff })).text(), /class="ok"/);
  }, ({ db }) => ({ inbox: createInboxStore(db) }));
});

test('T08-4 a calendar-booked viewing: moving its time is refused with "move it in Google Calendar", its time is read-only, and Cancel still works', async () => {
  const calls = [];
  await withTeamRoutes(async ({ db, base, get, postForm, login }) => {
    const leadId = seedLead(db, { phone: '966500000086', inboxState: 'in' });
    const slot = Date.parse('2026-12-06T10:00:00+03:00');
    const booked = bookViewing(db, { leadId, bookingId: 'BKG-t08', listingId: 'BONA-W012', slotStart: '2026-12-06T10:00:00+03:00', dueTs: slot, now: Date.parse('2026-11-28T09:00:00Z') });
    const plain = addTask(db, { leadId, kind: 'followup', source: 'owner', details: { note: 'call back' }, dueTs: slot + 86_400_000 });
    const cookie = await login(OWNER_PHONE);
    const route = `/v1/admin/leads/${leadId}/task`;

    const moved = await postForm(route, { _dash: '1', task_id: booked.task_id, status: 'confirmed', due_at: '2026-12-07T12:00' }, { cookie });
    assert.equal(moved.status, 303);
    assert.equal(moved.headers.get('location'), `/dashboard/leads/${leadId}?error=calendar_booked`);
    const json = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: cookie }, body: JSON.stringify({ task_id: booked.task_id, status: 'confirmed', due_at: '2026-12-07T12:00' }) });
    assert.equal(json.status, 409);
    assert.deepEqual(await json.json(), { error: 'calendar_booked' });
    assert.equal(tasksForLead(db, leadId).find((t) => t.task_id === booked.task_id).due_ts, slot, 'the time is the calendar\'s');
    assert.equal(calls.length, 0, 'a refused move is no change');
    const banner = await (await get(`/dashboard/leads/${leadId}?error=calendar_booked`, { cookie })).text();
    assert.match(banner, /<div class="err">[^<]*move it in Google Calendar; Bona follows the calendar[^<]*<\/div>/);

    // The page: the booked task has no time field, says where to move it, and keeps its status (Cancel).
    const page = await (await get(`/dashboard/leads/${leadId}`, { cookie })).text();
    const card = (taskId) => page.slice(page.lastIndexOf('<div class="card"', page.indexOf(`value="${taskId}"`)), page.indexOf('</form>', page.indexOf(`value="${taskId}"`)));
    assert.doesNotMatch(card(booked.task_id), /name="due_at"/, 'the booked time is read-only');
    assert.match(card(booked.task_id), /move it in Google Calendar; Bona follows the calendar/);
    assert.match(card(booked.task_id), /<option value="cancelled">cancelled<\/option>/, 'Cancel stays');
    assert.match(card(plain.task_id), /name="due_at"/, 'a task the owner made keeps its time field');

    // Cancel (no time sent) goes through and reaches the viewing seam as before.
    const cancelled = await postForm(route, { _dash: '1', task_id: booked.task_id, status: 'cancelled' }, { cookie });
    assert.equal(cancelled.headers.get('location'), `/dashboard/leads/${leadId}?ok=task`);
    assert.equal(tasksForLead(db, leadId).find((t) => t.task_id === booked.task_id).status, 'cancelled');
    assert.equal(calls.length, 1);
    // A wrong status on a booked task is still the old bad_task, not the calendar message.
    assert.equal((await postForm(route, { _dash: '1', task_id: booked.task_id, status: 'nonsense' }, { cookie })).headers.get('location'), `/dashboard/leads/${leadId}?error=bad_task`);
  }, { hooks: { onTaskChange: (task, patch) => { calls.push([task.task_id, patch]); } } });
});

test('T08-4 a booked viewing with no time on its task still says to move it in Google Calendar, never "for Not scheduled"', async () => {
  await withTeamRoutes(async ({ db, get, login }) => {
    const leadId = seedLead(db, { phone: '966500000079', inboxState: 'in' });
    const task = addTask(db, { leadId, kind: 'viewing', source: 'dana', details: {}, dueTs: null });
    db.db.prepare('UPDATE lead_tasks SET details = ? WHERE task_id = ?').run(JSON.stringify({ booking_id: 'BKG-t08b', listing_id: 'BONA-W012' }), task.task_id);
    const page = await (await get(`/dashboard/leads/${leadId}`, { cookie: await login(OWNER_PHONE) })).text();
    const form = page.slice(page.indexOf(`value="${task.task_id}"`), page.indexOf('</form>', page.indexOf(`value="${task.task_id}"`)));
    assert.match(form, /Booked on the calendar\. To change the time, move it in Google Calendar; Bona follows the calendar\./);
    assert.doesNotMatch(form, /Not scheduled|name="due_at"/);
  });
});

test('T08-5 the inbox list hides a chat with inbox_via set while Bona\'s number is not checked; a chat joined by proof is listed either way; the lead page stays', async () => {
  let numberOk = false;
  let inbox;
  await withTeamRoutes(async ({ db, get, login }) => {
    chatLead(db, { id: 'LEAD-20261128-aaaa0087', name: 'Own Number Client', phone: '966500000087', inbox_via: 'own_number' });
    chatLead(db, { id: 'LEAD-20261128-aaaa0088', name: 'Owner Test Chat', phone: '966500000088', inbox_via: 'owner_test' });
    chatLead(db, { id: 'LEAD-20261128-aaaa0089', name: 'Proof Client', phone: '966500000089', inbox_via: null });
    const owner = await login(OWNER_PHONE);
    const staff = await login(STAFF_PHONE);
    // Newer than both people's accounts, so it is unread for each of them.
    inbox.upsertMessage({ key_id: 'K-87', lead_id: 'LEAD-20261128-aaaa0087', jid: null, direction: 'in', sender_kind: 'client', text: 'hello', ts: Date.now() + 5_000 });
    const list = async (cookie) => (await get('/dashboard/inbox', { cookie })).text();

    for (const cookie of [owner, staff]) {
      const off = await list(cookie);
      assert.match(off, /Proof Client/);
      assert.doesNotMatch(off, /Own Number Client|Owner Test Chat/, 'hidden while ownNumberOk() is false');
      assert.doesNotMatch(off, /Inbox<span class="c">/, 'and its unread message is not on the badge');
    }
    assert.equal((await get('/dashboard/leads/LEAD-20261128-aaaa0087', { cookie: owner })).status, 200, 'it stays on the Leads page');

    numberOk = true;
    for (const cookie of [owner, staff]) {
      const on = await list(cookie);
      assert.match(on, /Proof Client/);
      assert.match(on, /Own Number Client/);
      assert.match(on, /Owner Test Chat/);
      assert.match(on, /Inbox<span class="c">1<\/span>/);
    }

    numberOk = () => { throw new Error('link state unreadable'); };
    const failing = await list(owner);
    assert.doesNotMatch(failing, /Own Number Client/, 'an ownNumberOk() that throws reads as false');
    assert.match(failing, /Proof Client/);
  }, ({ db }) => {
    inbox = createInboxStore(db);
    return { inbox, ownerTest: { ownNumberOk() { return typeof numberOk === 'function' ? numberOk() : numberOk; } } };
  });
});

test('T08-5 while Bona\'s number is not checked an inbox_via chat cannot be opened, read from WhatsApp or answered (DESIGN §13.2); once checked, all of it works', async () => {
  let numberOk = false;
  const refreshes = [];
  const replies = [];
  await withTeamRoutes(async ({ db, base, get, postForm, login }) => {
    const via = chatLead(db, { id: 'LEAD-20261128-aaaa0098', name: 'Own Number Client', phone: '966500000098', inbox_via: 'own_number', dana_off: 1 });
    const proof = chatLead(db, { id: 'LEAD-20261128-aaaa0099', name: 'Proof Client', phone: '966500000099' });
    const owner = await login(OWNER_PHONE);
    const staff = await login(STAFF_PHONE);
    const json = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bona-Dash': '1', Cookie: cookie }, body: JSON.stringify(body) });
    const openChatLink = new RegExp(`href="/dashboard/inbox/${via}"`);

    for (const cookie of [owner, staff]) {
      const thread = await get(`/dashboard/inbox/${via}`, { cookie });
      assert.equal(thread.status, 404, 'the thread answers not-in-inbox');
      assert.match(await thread.text(), /That chat is not in the Bona inbox/);
      assert.equal((await postForm(`/v1/admin/inbox/${via}/reply`, { _dash: '1', text: 'hello', send_id: 'a'.repeat(24), seen_rev: '0' }, { cookie })).status, 404, 'a reply is refused');
      assert.equal((await json(`/v1/admin/inbox/${via}/handler`, { user_id: '' }, cookie)).status, 404);
      assert.equal((await json(`/v1/admin/inbox/${via}/dana`, { dana_off: '0' }, cookie)).status, 404);
      assert.equal((await json(`/v1/admin/inbox/${via}/answer_again`, {}, cookie)).status, 404);
      assert.equal((await get(`/v1/admin/inbox/pulse?lead=${via}`, { cookie })).status, 404, 'its pulse says nothing either');
    }
    assert.deepEqual([refreshes, replies], [[], []], 'no Evolution read and nothing sent');
    assert.equal(db.getLead(via).dana_off, 1, 'nothing written');
    const leadPage = await (await get(`/dashboard/leads/${via}`, { cookie: owner })).text();
    assert.doesNotMatch(leadPage, openChatLink, 'the lead page offers no "Open chat" for it');
    assert.match(leadPage, /hidden from the inbox until Bona’s WhatsApp number is checked/);
    // A chat joined by proof is untouched by the guard.
    assert.equal((await get(`/dashboard/inbox/${proof}`, { cookie: staff })).status, 200);
    assert.match(await (await get(`/dashboard/leads/${proof}`, { cookie: owner })).text(), new RegExp(`href="/dashboard/inbox/${proof}"`));

    numberOk = true;
    refreshes.length = 0;
    assert.equal((await get(`/dashboard/inbox/${via}`, { cookie: staff })).status, 200, 'checked: the thread opens');
    assert.deepEqual(refreshes, [via], 'and is read from WhatsApp as any chat is');
    const sent = await postForm(`/v1/admin/inbox/${via}/reply`, { _dash: '1', text: 'hello', send_id: 'b'.repeat(24), seen_rev: '0' }, { cookie: staff });
    assert.equal(sent.headers.get('location'), `/dashboard/inbox/${via}?ok=sent`);
    assert.equal(replies.length, 1);
    assert.equal((await get(`/v1/admin/inbox/pulse?lead=${via}`, { cookie: staff })).status, 200);
    assert.equal((await json(`/v1/admin/inbox/${via}/answer_again`, {}, staff)).status, 200);
    assert.match(await (await get(`/dashboard/leads/${via}`, { cookie: owner })).text(), openChatLink);
  }, ({ db }) => ({
    inbox: createInboxStore(db),
    ownerTest: { ownNumberOk: () => numberOk },
    backfill: { refresh: async (lead) => { refreshes.push(lead.lead_id); } },
    sender: { reply: async (o) => { replies.push(o); return { ok: true, sendId: o.sendId }; } },
  }));
});

test('T08-5 an older proof-joined chat behind 1,001 newer unread own-number chats is still listed, on the badge and opened by an alert while the guard is on', async () => {
  let inbox;
  await withTeamRoutes(async ({ db, get, login }) => {
    const owner = await login(OWNER_PHONE);
    const t = Date.now() + 10_000;
    const proof = chatLead(db, { id: 'LEAD-20261128-eeee0000', name: 'Proof Client', phone: '966500020000', last_msg_ts: t });
    inbox.upsertMessage({ key_id: 'K-proof', lead_id: proof, jid: null, direction: 'in', sender_kind: 'client', text: 'hello', ts: t });
    db.transaction(() => {
      for (let i = 1; i <= 1001; i += 1) {
        const n = String(i).padStart(4, '0');
        const id = chatLead(db, { id: `LEAD-20261128-dddd${n}`, name: `Own ${n}`, phone: `96650002${n}`, inbox_via: 'own_number', last_msg_ts: t + i });
        inbox.upsertMessage({ key_id: `K-own-${n}`, lead_id: id, jid: null, direction: 'in', sender_kind: 'client', text: 'hi', ts: t + i });
      }
    });
    const list = await (await get('/dashboard/inbox', { cookie: owner })).text();
    assert.match(list, /Proof Client/, 'the list: the store leaves the own-number chats out before its limit');
    assert.doesNotMatch(list, /Own \d{4}/);
    assert.match(list, /Inbox<span class="c">1<\/span>/, 'the badge counts its unread message');
    const open = await get('/dashboard/push/open', { cookie: owner });
    assert.equal(open.status, 302);
    assert.equal(open.headers.get('location'), `/dashboard/inbox/${proof}`, 'an alert opens it');
  }, ({ db }) => { inbox = createInboxStore(db); return { inbox, ownerTest: { ownNumberOk: () => false } }; });
});

test('T08-5 a reply that waits on its WhatsApp refresh is refused when the identity check fails meanwhile: nothing is sent', async () => {
  let numberOk = true;
  const replies = [];
  await withTeamRoutes(async ({ db, postForm, login }) => {
    const via = chatLead(db, { id: 'LEAD-20261128-ffff0001', name: 'Own Number Client', phone: '966500000071', inbox_via: 'own_number' });
    const proof = chatLead(db, { id: 'LEAD-20261128-ffff0002', name: 'Proof Client', phone: '966500000072' });
    const staff = await login(STAFF_PHONE);
    const reply = (leadId, sendId) => postForm(`/v1/admin/inbox/${leadId}/reply`, { _dash: '1', text: 'hello', send_id: sendId, seen_rev: '0' }, { cookie: staff });
    const res = await reply(via, 'c'.repeat(24));
    assert.equal(res.status, 404, 'checked again after the refresh, right before the send');
    assert.match(await res.text(), /That chat is not in the Bona inbox/);
    assert.equal(replies.length, 0, 'nothing sent');
    // A chat joined by proof is not the guard's: the same flip does not stop its reply.
    numberOk = true;
    const ok = await reply(proof, 'd'.repeat(24));
    assert.equal(ok.headers.get('location'), `/dashboard/inbox/${proof}?ok=sent`);
    assert.deepEqual(replies.map((r) => r.leadId), [proof]);
  }, ({ db }) => ({
    inbox: createInboxStore(db),
    ownerTest: { ownNumberOk: () => numberOk },
    // The identity probe reports a mismatch while the refresh is out at WhatsApp.
    backfill: { refresh: async () => { numberOk = false; } },
    sender: { reply: async (o) => { replies.push(o); return { ok: true, sendId: o.sendId }; } },
  }));
});

test('T08-5 while the number is not checked the owner cannot Move, Add or move a chat to check in for a hidden own-number client: refused before any WhatsApp history read', async () => {
  let numberOk = false;
  const reads = [];
  let inbox;
  await withTeamRoutes(async ({ db, get, postForm, login }) => {
    const out = chatLead(db, { id: 'LEAD-20261128-ffff0003', name: 'Own Out Client', phone: '966500000073', inbox_via: 'own_number', inbox_state: 'out' });
    const cand = inbox.noteCandidate({ phone: '966500000073', jid: '966500000073@s.whatsapp.net', name: 'Own Out Client', ts: Date.now(), words: ['villa'], dir: 'in' }).cand_id;
    const cookie = await login(OWNER_PHONE);
    const moved = await postForm(`/v1/admin/inbox/${out}/move`, { _dash: '1' }, { cookie });
    assert.equal(moved.headers.get('location'), `/dashboard/leads/${out}?error=number_unchecked`);
    const added = await postForm('/v1/admin/inbox/add', { _dash: '1', phone: '0500000073' }, { cookie });
    assert.equal(added.headers.get('location'), '/dashboard/inbox?error=number_unchecked');
    const fromList = await postForm(`/v1/admin/inbox/candidates/${cand}/move`, { _dash: '1' }, { cookie });
    assert.equal(fromList.headers.get('location'), '/dashboard/inbox?tab=unsure&error=number_unchecked');
    assert.deepEqual(reads, [], 'no history read from the personal number');
    assert.equal(db.getLead(out).inbox_state, 'out', 'nothing moved');
    assert.equal(inbox.getCandidate(cand).state, 'open', 'the chat to check stays');
    assert.match(await (await get(`/dashboard/leads/${out}?error=number_unchecked`, { cookie })).text(), /<div class="err">[^<]*until Bona’s WhatsApp number is checked/);

    numberOk = true;
    const now = await postForm(`/v1/admin/inbox/${out}/move`, { _dash: '1' }, { cookie });
    assert.equal(now.status, 303);
    assert.equal(db.getLead(out).inbox_state, 'in', 'checked: Move works as today');
    assert.deepEqual(reads, [out]);
  }, ({ db }) => {
    inbox = createInboxStore(db);
    return { inbox, ownerTest: { ownNumberOk: () => numberOk }, backfill: { refresh: async () => {}, history: async (lead) => { reads.push(lead.lead_id); } } };
  });
});

test('T08-5 without an ownerTest the routes fail closed: an inbox_via chat is not listed, a proof chat is', async () => {
  await withTeamRoutes(async ({ db, get, login }) => {
    chatLead(db, { id: 'LEAD-20261128-aaaa0090', name: 'Own Number Client', phone: '966500000090', inbox_via: 'own_number' });
    chatLead(db, { id: 'LEAD-20261128-aaaa0091', name: 'Proof Client', phone: '966500000091' });
    const html = await (await get('/dashboard/inbox', { cookie: await login(OWNER_PHONE) })).text();
    assert.match(html, /Proof Client/);
    assert.doesNotMatch(html, /Own Number Client/);
  }, ({ db }) => ({ inbox: createInboxStore(db) }));
});

/** An owner_notes alert row as the notes ledger writes one (PR-B2: kind alert, the lead, `al:old_out_wrote:<lead>:<day>`). */
function oldOutRow(db, { leadId = null, key, created, status = 'sent' }) {
  db.db.prepare(`INSERT INTO owner_notes (note_id, kind, lead_id, dedupe_key, due_ts, status, send_id, meta, created, updated)
    VALUES (?, 'alert', ?, ?, ?, ?, NULL, ?, ?, ?)`).run(`NOTE-${key}`, leadId, key, created, status, JSON.stringify({ alert: 'old_out_wrote' }), created, created);
}

test('T08-6 "Chats to check" lists the old out leads that wrote in the last 30 days: the lead row\'s name, the time, no text, and Move', async () => {
  let inbox;
  await withTeamRoutes(async ({ db, get, postForm, login }) => {
    const t = Date.now();
    const old = chatLead(db, { id: 'LEAD-20261128-aaaa0092', name: 'Old Out Client', phone: '966500000092', inbox_state: 'out' });
    inbox.upsertMessage({ key_id: 'K-92', lead_id: old, jid: null, direction: 'in', sender_kind: 'client', text: 'secret villa words', ts: t - 7_200_000 });
    oldOutRow(db, { leadId: old, key: `al:old_out_wrote:${old}:2026-11-27`, created: t - 26 * 3_600_000 });
    oldOutRow(db, { leadId: old, key: `al:old_out_wrote:${old}:2026-11-28`, created: t - 2 * 3_600_000, status: 'dropped' });
    const stale = chatLead(db, { id: 'LEAD-20261128-aaaa0093', name: 'Long Ago Client', phone: '966500000093', inbox_state: 'out' });
    oldOutRow(db, { leadId: stale, key: `al:old_out_wrote:${stale}:2026-10-01`, created: t - 31 * 86_400_000 });
    const back = chatLead(db, { id: 'LEAD-20261128-aaaa0094', name: 'Moved Back Client', phone: '966500000094', inbox_state: 'in' });
    oldOutRow(db, { leadId: back, key: `al:old_out_wrote:${back}:2026-11-28`, created: t - 3_600_000 });
    const colleague = chatLead(db, { id: 'LEAD-20261128-aaaa0095', name: 'Colleague Client', phone: STAFF_PHONE, inbox_state: 'out' });
    oldOutRow(db, { leadId: colleague, key: `al:old_out_wrote:${colleague}:2026-11-28`, created: t - 3_600_000 });
    oldOutRow(db, { key: 'al:old_out_wrote:CND-mf3k2a-1a2b:2026-11-28', created: t - 3_600_000 });
    const other = chatLead(db, { id: 'LEAD-20261128-aaaa0096', name: 'Other Alert Client', phone: '966500000096', inbox_state: 'out' });
    oldOutRow(db, { leadId: other, key: 'al:breaker:493000', created: t - 3_600_000 });

    const cookie = await login(OWNER_PHONE);
    const res = await get('/dashboard/inbox?tab=unsure', { cookie });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<bdi>Old Out Client<\/bdi>/, 'the name comes from the lead row');
    assert.match(html, /wrote 2\sh ago/, 'the newest of its rows');
    assert.match(html, new RegExp(`action="/v1/admin/inbox/${old}/move"`), 'and its Move button');
    assert.doesNotMatch(html, /secret villa words/, 'never what they wrote');
    assert.doesNotMatch(html, /966500000092/, 'never the number');
    assert.equal(html.match(/Old Out Client/g).length, 1, 'one row a lead, however many days it wrote');
    for (const gone of ['Long Ago Client', 'Moved Back Client', 'Colleague Client', 'Other Alert Client', 'CND-mf3k2a']) assert.doesNotMatch(html, new RegExp(gone), gone);
    assert.match(html, /Unsure · 1<\/a>/, 'the tab counts it');
    assert.match(await (await get('/dashboard/inbox', { cookie })).text(), /Unsure · 1<\/a>/, 'and so does the inbox list\'s tab');

    // Move brings it in, as today, and it leaves the list.
    const moved = await postForm(`/v1/admin/inbox/${old}/move`, { _dash: '1' }, { cookie });
    assert.equal(moved.status, 303);
    assert.equal(db.getLead(old).inbox_state, 'in');
    assert.doesNotMatch(await (await get('/dashboard/inbox?tab=unsure', { cookie })).text(), /Old Out Client/);
  }, ({ db }) => { inbox = createInboxStore(db); return { inbox }; });
});

test('T08-6 "Chats to check" finds an eligible old out lead behind 200 newer rows that are no longer out, or are a never-list number', async () => {
  for (const crowd of ['moved back in', 'never list']) {
    let inbox;
    await withTeamRoutes(async ({ db, team, get, login }) => {
      const t = Date.now();
      const eligible = chatLead(db, { id: 'LEAD-20261128-bbbb0000', name: 'Eligible Old Client', phone: '966500001000', inbox_state: 'out' });
      oldOutRow(db, { leadId: eligible, key: `al:old_out_wrote:${eligible}:2026-11-20`, created: t - 8 * 86_400_000 });
      for (let i = 1; i <= 201; i += 1) {
        const n = String(i).padStart(4, '0');
        const phone = `96650000${1000 + i}`;
        const id = chatLead(db, { id: `LEAD-20261128-cccc${n}`, name: `Crowd ${n}`, phone, inbox_state: crowd === 'moved back in' ? 'in' : 'out' });
        if (crowd === 'never list') team.addNever({ phone });
        oldOutRow(db, { leadId: id, key: `al:old_out_wrote:${id}:2026-11-28`, created: t - 3_600_000 - i });
      }
      const html = await (await get('/dashboard/inbox?tab=unsure', { cookie: await login(OWNER_PHONE) })).text();
      assert.match(html, /<bdi>Eligible Old Client<\/bdi>/, `${crowd}: the eligible lead is still listed`);
      assert.doesNotMatch(html, /Crowd \d{4}/, `${crowd}: none of the crowd is`);
      assert.match(html, /Unsure · 1<\/a>/);
    }, ({ db }) => { inbox = createInboxStore(db); return { inbox }; });
  }
});

test('T08-6 an old_out_wrote alert the owner has handled (moved in, then Not a client again) is not listed again; a newer one is', async () => {
  let inbox;
  await withTeamRoutes(async ({ db, owner, get, postForm, login }) => {
    const t = Date.now();
    const old = chatLead(db, { id: 'LEAD-20261128-ffff0004', name: 'Handled Client', phone: '966500000074', inbox_state: 'out' });
    // His Not a client from before the move: older than the alert, so the alert stands.
    db.db.prepare('INSERT INTO audit_log (id, ts, user_id, action, target, meta) VALUES (?, ?, ?, ?, ?, NULL)').run('AUD-t08-old', t - 40 * 86_400_000, owner.user_id, 'inbox_out', old);
    oldOutRow(db, { leadId: old, key: `al:old_out_wrote:${old}:2026-11-27`, created: t - 2 * 3_600_000 });
    const cookie = await login(OWNER_PHONE);
    const tab = async () => (await get('/dashboard/inbox?tab=unsure', { cookie })).text();
    assert.match(await tab(), /<bdi>Handled Client<\/bdi>/);

    assert.equal((await postForm(`/v1/admin/inbox/${old}/move`, { _dash: '1' }, { cookie })).status, 303);
    assert.equal((await postForm(`/v1/admin/inbox/${old}/out`, { _dash: '1' }, { cookie })).status, 303);
    assert.equal(db.getLead(old).inbox_state, 'out');
    const handled = await tab();
    assert.doesNotMatch(handled, /Handled Client/, 'marked Not a client again: the older alert is handled');
    assert.doesNotMatch(handled, /Unsure · \d/);

    oldOutRow(db, { leadId: old, key: `al:old_out_wrote:${old}:2026-11-28`, created: Date.now() + 1000 });
    assert.match(await tab(), /<bdi>Handled Client<\/bdi>/, 'an alert raised after that dismissal is listed');
  }, ({ db }) => { inbox = createInboxStore(db); return { inbox }; });
});

test('T08-7 an enquiry whose note was skipped (a merge into an existing contact) reads "No note: an existing contact" on the lead page', async () => {
  await withTeamRoutes(async ({ db, get, login }) => {
    const leadId = seedLead(db, { phone: '966500000097', inboxState: 'in' });
    const t = Date.now();
    const receipt = db.db.prepare('INSERT INTO enquiry_receipts (event_id, payload_hash, lead_id, created, notify_status) VALUES (?, ?, ?, ?, ?)');
    receipt.run('evt-t08-skipped', 'h1', leadId, t - 4000, 'skipped');
    receipt.run('evt-t08-sent', 'h2', leadId, t - 3000, 'sent');
    receipt.run('evt-t08-pending', 'h3', leadId, t - 2000, 'pending');
    receipt.run('evt-t08-uncertain', 'h4', leadId, t - 1000, 'uncertain');
    // The ledger's other two (PR-B2): dropped (owner notes off, or no longer sendable) and over (the day's limit).
    receipt.run('evt-t08-dropped', 'h5', leadId, t - 900, 'dropped');
    receipt.run('evt-t08-over', 'h6', leadId, t - 800, 'over');
    const html = await (await get(`/dashboard/leads/${leadId}`, { cookie: await login(OWNER_PHONE) })).text();
    assert.equal(html.match(/No note: an existing contact/g)?.length, 1);
    assert.equal(html.match(/No note sent: owner notes were off, or it could no longer go/g)?.length, 1);
    assert.equal(html.match(/No note of its own: over the day’s limit, so it is in the daily summary/g)?.length, 1);
    assert.equal(html.match(/Accepted by WhatsApp; not proof of delivery/g)?.length, 1);
    assert.equal(html.match(/Awaiting acknowledgement/g)?.length, 1);
    assert.equal(html.match(/Not confirmed — check WhatsApp before resending/g)?.length, 1, 'skipped, dropped and over are no longer read as "not confirmed"');
  });
});
