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
import { leadsPage } from '../lib/dashboard/render.mjs';

const TOKEN = 'a'.repeat(32);
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'";

/** Every dashboard and admin answer, whatever it says, carries the same four headers. */
function assertLocked(res) {
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-security-policy'), CSP);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
}

async function withDash(overrides = {}, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-dash-'));
  const db = openDb(':memory:');
  const sent = [];
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
  async function askForCode(opts = {}) {
    const res = await postForm('/dashboard/login/code', { _dash: '1' }, opts);
    const code = /(\d{6})/.exec(sent.at(-1) ?? '')?.[1] ?? null;
    const nonce = cookieValue(res, 'bona_dash_try');
    return { res, code, nonce, tryCookie: nonce ? `bona_dash_try=${nonce}` : '' };
  }

  /** The whole login: ask for a code, read it off the "phone", type it back. */
  async function login() {
    const asked = await askForCode();
    assert.equal(asked.res.status, 303, 'the code request redirects to the code form');
    assert.ok(asked.code, `no code in the WhatsApp message: ${sent.at(-1)}`);
    assert.ok(asked.nonce, 'the code request must hand the browser a try nonce');
    const verified = await postForm('/dashboard/login/verify', { _dash: '1', code: asked.code }, { cookie: asked.tryCookie });
    const session = cookieValue(verified, 'bona_dash');
    assert.ok(session, 'the verify step must set the session cookie');
    return { cookie: `bona_dash=${session}`, code: asked.code, nonce: asked.nonce, res: verified };
  }

  try {
    await fn({ app, db, base, get, postForm, postJson, login, askForCode, cookiesOf, cookieValue, sent });
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
    assert.match(body, /Overview/);
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
      ['/dashboard', /Sources — first touch vs last touch/],
      ['/dashboard/leads', /Leads/],
      [`/dashboard/leads/${id}`, /Journey/],
      ['/dashboard/listings', /Ad licence/],
      ['/dashboard/spend', /Cost per lead/],
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
    assert.match(list, /…6933/);
    assert.ok(!list.includes('966593296933'), 'the whole number does not belong in a list');

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

    // The board above the list shows every lead whatever the filter says, so asserting
    // on the whole page would pass with the filter ripped out. Only the list is filtered.
    const listOnly = (html) => html.slice(html.indexOf('<h2>List</h2>'));

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
  assert.match(html, /<span>contacted<\/span><span>517<\/span>/);
  assert.match(html, /\+515 older not shown/);
  assert.match(html, /<span>won<\/span><span>3<\/span>/, 'a column with no cards still reports its count');
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
    assert.equal(history.at(-1).actor, 'owner');
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
    assert.deepEqual(db.listSpend(), [{ day: '2026-09-07', platform: 'meta', campaign_id: '1203', campaign_name: 'Villas Sept', spend_sar: 3000, clicks: 120, impressions: 40_000 }]);

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
