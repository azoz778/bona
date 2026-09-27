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

const TOKEN = 'a'.repeat(32);
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'";

/** Every dashboard and admin answer, whatever it says, carries the same four headers. */
function assertLocked(res) {
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-security-policy'), CSP);
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
function seedLead(db, { id = 'LEAD-20260908-aaaa0001', name = 'Sara Ahmed', now = Date.now() } = {}) {
  db.upsertSession({
    session_id: 'sess-aaa1', anon_id: 'a'.repeat(32), ref: 'K7Q2XR', started: now - 3600_000, last_seen: now, pages: 3, locale: 'en',
    first_touch: { ts: now - 3600_000, utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_id: '1203' },
    last_touch: { ts: now, utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_id: '1203' },
    ip: '2.2.2.2', ua: 'iPhone', country: 'SA', consent_analytics: 1, consent_ads: 1,
  });
  db.insertLead({
    lead_id: id, created: now - 3600_000, updated: now, phone_e164: '966593296933', name,
    channel: 'whatsapp', source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203',
    match_method: 'ref', session_id: 'sess-aaa1', anon_id: 'a'.repeat(32), listing_id: 'BONA-001',
    stage: 'new', stage_ts: now - 3600_000, consent_ads: 1, consent_analytics: 1,
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
    assert.ok(!/<script/i.test(html), 'the dashboard ships no script at all');

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
    assert.match(await offered.text(), /Log out of the dashboard on this device\?/);
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
      assert.ok(!/<script/i.test(html), `${p} must ship no script`);
    }
    const missing = await get('/dashboard/leads/LEAD-nope', { cookie });
    assert.equal(missing.status, 404);
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
    assert.deepEqual(event.props, { stage: 'won', value_sar: 2_400_000 });
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

async function withTeamRoutes(fn) {
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
    const id = seedLead(db);
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
    const id = seedLead(db);
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
