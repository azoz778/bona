import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTiktokAccounts, CALLBACK } from '../lib/tiktok-accounts.mjs';
import { tiktokAccountsPage, tiktokContinuePage, validateTiktokDraft } from '../lib/dashboard/render-tiktok.mjs';
const origin = 'https://api.bona-real-estate.com';
const grant = (suffix = '') => ({ access_token: 'access-secret' + suffix, refresh_token: 'refresh-secret' + suffix, token_type: 'Bearer', scope: 'user.info.basic,video.list', expires_in: 3600, refresh_token_expires_in: 86400, open_id: 'own-account' });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-tiktok-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 1790000000000, reply = grant();
  const calls = [];
  const cfg = { dataDir: dir, publicApi: origin, tiktokAccountsAppId: 'app', tiktokAccountsAppSecret: 'app-secret', tiktokAccountsAuthUrl: `https://www.tiktok.com/v2/auth/authorize/?client_key=portal-key&redirect_uri=${encodeURIComponent(origin + CALLBACK)}` };
  const service = createTiktokAccounts({ cfg, now: () => time, fetcher: async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); if (reply instanceof Error) throw reply; return new Response(JSON.stringify({ code: 0, data: reply })); } });
  const params = (session = 'owner-session') => new URLSearchParams({ state: new URL(service.begin(session)).searchParams.get('state'), auth_code: 'one-time-code' });
  const connect = () => service.finish({ params: params(), session: 'owner-session' });
  return { service, cfg, dir, calls, params, connect, advance: n => { time += n; }, reply: r => { reply = r; }, file: path.join(dir, 'private/tiktok-accounts.json') };
}
test('Accounts OAuth is dormant without credentials or exact canonical URL', t => {
  const f = fixture(t);
  for (const edit of [{ tiktokAccountsAppSecret: '' }, { publicApi: 'http://api.bona-real-estate.com' }, { publicApi: origin + '/path' }, { tiktokAccountsAuthUrl: 'https://evil.example/v2/auth/authorize/' }]) {
    const s = createTiktokAccounts({ cfg: { ...f.cfg, ...edit } });
    assert.equal(s.status().configured, false); assert.throws(() => s.begin('s'), /not_configured/);
  }
  assert.equal(fs.existsSync(f.file), false);
});
test('session binding, duplicate state, expiry, replay and provider denial fail closed', async t => {
  const f = fixture(t), p = f.params();
  await assert.rejects(f.service.finish({ params: p, session: 'other' }), /invalid_state/);
  const duplicate = new URLSearchParams(p); duplicate.append('state', p.get('state'));
  await assert.rejects(f.service.finish({ params: duplicate, session: 'owner-session' }), /invalid_state/);
  await f.service.finish({ params: p, session: 'owner-session' });
  await assert.rejects(f.service.finish({ params: p, session: 'owner-session' }), /invalid_state/);
  const expired = f.params(); f.advance(600001);
  await assert.rejects(f.service.finish({ params: expired, session: 'owner-session' }), /invalid_state/);
  const denied = f.params(); denied.set('error', 'access_denied');
  await assert.rejects(f.service.finish({ params: denied, session: 'owner-session' }), /denied/);
  await assert.rejects(f.service.finish({ params: denied, session: 'owner-session' }), /invalid_state/);
  assert.equal(f.calls.length, 1);
});
test('exchange uses Accounts endpoint; stores private atomic grant without exposing secrets', async t => {
  const f = fixture(t); const status = await f.connect();
  assert.match(f.calls[0].url, /tt_user\/oauth2\/token\/$/);
  assert.deepEqual(f.calls[0].body, { client_id: 'app', client_secret: 'app-secret', grant_type: 'authorization_code', auth_code: 'one-time-code', redirect_uri: origin + CALLBACK });
  assert.equal(f.calls[0].opts.redirect, 'error');
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.file)).mode & 0o777, 0o700);
  assert.equal(status.publishingEnabled, false);
  const html = tiktokAccountsPage({ me: { role: 'owner' }, state: status });
  for (const secret of ['access-secret', 'refresh-secret', 'app-secret', 'one-time-code']) assert.ok(!JSON.stringify(status).includes(secret) && !html.includes(secret));
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['tiktok-accounts.json']);
});
test('ambiguous codes, malformed response and different account preserve existing grant', async t => {
  const f = fixture(t); await f.connect(); const before = fs.readFileSync(f.file, 'utf8');
  const p = f.params(); p.set('code', 'ambiguous');
  await assert.rejects(f.service.finish({ params: p, session: 'owner-session' }), /invalid_code/);
  f.reply({ ...grant(), refresh_token: '' }); await assert.rejects(f.connect(), /invalid_response/);
  f.reply({ ...grant(), open_id: 'different' }); await assert.rejects(f.connect(), /different_account/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
test('refresh rotates both tokens; failed requests preserve grant and sanitize error', async t => {
  const f = fixture(t); await f.connect(); f.reply(grant('-rotated')); await f.service.refresh();
  let saved = JSON.parse(fs.readFileSync(f.file)); assert.equal(saved.accessToken, 'access-secret-rotated'); assert.equal(saved.refreshToken, 'refresh-secret-rotated');
  assert.match(f.calls[1].url, /refresh_token\/$/);
  f.reply(new Error('provider leaked access-secret')); await assert.rejects(f.service.refresh(), /^AccountsError: provider_failed$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), saved);
});
test('expired access refreshes and persists before revoke; failed revoke permits explicit local removal', async t => {
  const f = fixture(t); await f.connect(); f.advance(3600001); f.reply(grant('-renewed')); await f.service.revoke();
  assert.match(f.calls[1].url, /refresh_token\/$/); assert.match(f.calls[2].url, /revoke\/$/); assert.equal(f.calls[2].body.access_token, 'access-secret-renewed');
  assert.equal(fs.existsSync(f.file), false);
  await f.connect(); f.reply(new Error('failure')); await assert.rejects(f.service.revoke(), /provider_failed/); assert.equal(f.service.status().grantStored, true);
  await f.service.forget(); assert.equal(f.service.status().grantStored, false);
});
test('symlink storage refuses writes without touching target', async t => {
  const f = fixture(t); const other = path.join(f.dir, 'target'); fs.mkdirSync(other); fs.symlinkSync(other, path.join(f.dir, 'private'));
  await assert.rejects(f.connect(), /storage_unavailable/); assert.deepEqual(fs.readdirSync(other), []);
});
test('draft validates local fields and escapes content without publishing', () => {
  const d = validateTiktokDraft({ caption: '<script>bad</script>', media: 'https://bona-real-estate.com/video.mp4', schedule: '2099-01-01T10:00:00+03:00' }, 'https://bona-real-estate.com');
  assert.equal(d.issues.length, 0);
  assert.ok(validateTiktokDraft({ caption: 'ok', media: 'https://evil.example/x', schedule: '2099-01-01T10:00:00' }, 'https://bona-real-estate.com').issues.length === 2);
  const html = tiktokAccountsPage({ me: { role: 'owner' }, state: { scopes: [] }, draft: d });
  assert.ok(!html.includes('<script>bad')); assert.match(html, /not saved, scheduled or published/);
  assert.match(tiktokContinuePage({ me: { role: 'owner' }, authorizationUrl: 'https://www.tiktok.com/v2/auth/authorize/?state=x&client_key=y' }), /rel="noreferrer">Continue to TikTok/);
});
import http from 'node:http';
import { createDashboardRoutes } from '../lib/dashboard/routes.mjs';
async function routesFixture(t) {
  const f = fixture(t); let active = true; const logs = [];
  const auth = { readCookie: req => req.headers.cookie, check: token => active && ['owner-session', 'staff-session'].includes(token) ? { user_id: token, name: 'Test operator', role: token === 'owner-session' ? 'owner' : 'staff' } : null };
  const routes = createDashboardRoutes({ cfg: { ...f.cfg, siteUrl: 'https://bona-real-estate.com' }, team: {}, stats: {}, auth, tiktokAccounts: f.service, log: x => logs.push(x) });
  const server = http.createServer((req, res) => { const url = new URL(req.url, origin); routes.handle({ req, res, url, p: url.pathname.replace(/\/+$/, '') || '/', ip: '127.0.0.1' }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  async function request(url, { method = 'GET', cookie = 'owner-session', requestOrigin = origin, host = new URL(origin).host, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method, headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: new Headers(res.headers), html: Buffer.concat(chunks).toString() }));
      }); req.on('error', reject); req.end(body);
    });
  }
  return { ...f, request, logs, deactivate: () => { active = false; } };
}
test('owner routes reject unauthenticated/staff/missing-origin/foreign-origin/missing-marker writes', async t => {
  const f = await routesFixture(t);
  assert.equal((await f.request('/dashboard/tiktok', { cookie: '' })).status, 302);
  assert.equal((await f.request('/dashboard/tiktok', { cookie: 'staff-session' })).status, 403);
  for (const opts of [{ cookie: 'staff-session' }, { requestOrigin: null }, { requestOrigin: 'https://evil.example' }]) assert.equal((await f.request('/v1/admin/tiktok/connect', { method: 'POST', body: '_dash=1', ...opts })).status, 403);
  assert.equal((await f.request('/v1/admin/tiktok/connect', { method: 'POST', body: 'a=1' })).status, 403);
  assert.equal(f.calls.length, 0);
});
test('connect renders real provider anchor under strict CSP, callback requires exact host/path and clears secrets', async t => {
  const f = await routesFixture(t);
  const start = await f.request('/v1/admin/tiktok/connect', { method: 'POST', body: '_dash=1' });
  assert.equal(start.status, 200); assert.match(start.html, /Continue to TikTok/); assert.match(start.headers.get('content-security-policy'), /form-action 'self'/);
  assert.equal(start.headers.get('referrer-policy'), 'no-referrer');
  const href = start.html.match(/href="(https:\/\/www.tiktok.com[^\"]+)"/)[1].replaceAll('&amp;', '&');
  const query = new URLSearchParams({ state: new URL(href).searchParams.get('state'), auth_code: 'sensitive-code' });
  for (const [url, opts] of [[`/dashboard/tiktok/callback?${query}`, {}], [`${CALLBACK}?${query}`, { host: 'evil.example' }], [`${CALLBACK}?${query}`, { cookie: 'staff-session' }], [`${CALLBACK}?${query}`, { cookie: '' }]]) assert.equal((await f.request(url, opts)).status, 400);
  const done = await f.request(`${CALLBACK}?${query}`); assert.equal(done.status, 303); assert.equal(done.headers.get('location'), '/dashboard/tiktok?ok=connected'); assert.equal(done.headers.get('referrer-policy'), 'no-referrer'); assert.match(done.headers.get('cache-control'), /no-store/);
  const replay = await f.request(`${CALLBACK}?${query}`); assert.equal(replay.headers.get('location'), '/dashboard/tiktok?error=invalid_state');
  assert.ok(!JSON.stringify(f.logs).includes('sensitive-code'));
});
test('deactivated session cannot finish; local removal requires explicit confirmation', async t => {
  const f = await routesFixture(t); await f.connect();
  assert.equal((await f.request('/v1/admin/tiktok/forget', { method: 'POST', body: '_dash=1' })).status, 400);
  assert.equal(f.service.status().grantStored, true);
  const done = await f.request('/v1/admin/tiktok/forget', { method: 'POST', body: '_dash=1&confirm=remove-local-grant' });
  assert.equal(done.headers.get('location'), '/dashboard/tiktok?ok=forgotten'); assert.equal(f.service.status().grantStored, false);
  const p = f.params(); f.deactivate(); assert.equal((await f.request(`${CALLBACK}?${p}`)).status, 400); assert.equal(f.calls.length, 1);
});
