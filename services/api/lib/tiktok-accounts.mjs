/** TikTok API for Business Accounts OAuth (not Marketing OAuth or Events API).
 * https://business-api.tiktok.com/portal/docs/accounts-api-authentication/v1.3
 * No provider responses, authorization codes or tokens are logged or rendered.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
export const CALLBACK = '/dashboard/tiktok/callback/';
const BASE = 'https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/';
const TTL = 10 * 60_000;
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
export class AccountsError extends Error {
  constructor(code) { super(code); this.name = 'AccountsError'; this.code = code; }
}
const fail = (code) => { throw new AccountsError(code); };
const text = (v, max = 8192) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\r\n\x00]/.test(v);
export function createTiktokAccounts({ cfg = {}, now = () => Date.now(), fetcher = fetch } = {}) {
  const pending = new Map();
  let busy = false;
  const dir = cfg.dataDir ? path.join(cfg.dataDir, 'private') : null;
  const file = dir ? path.join(dir, 'tiktok-accounts.json') : null;
  const appId = cfg.tiktokAccountsAppId || '';
  const secret = cfg.tiktokAccountsAppSecret || '';
  function callbackUrl() {
    try {
      const u = new URL(cfg.publicApi);
      if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
      return new URL(CALLBACK, u).href;
    } catch { return null; }
  }
  function authorizeUrl() {
    try {
      const u = new URL(cfg.tiktokAccountsAuthUrl);
      if (u.origin !== 'https://www.tiktok.com' || !/^\/v2\/auth\/authorize\/?$/.test(u.pathname) || u.username || u.password || u.hash || !callbackUrl()) return null;
      if (u.searchParams.getAll('redirect_uri').length !== 1 || u.searchParams.get('redirect_uri') !== callbackUrl()) return null;
      if (['client_secret', 'access_token', 'refresh_token', 'auth_code', 'code'].some(k => u.searchParams.has(k))) return null;
      if (!u.searchParams.get('client_key') && !u.searchParams.get('client_id')) return null;
      return u;
    } catch { return null; }
  }
  function configured() { return !!(text(appId, 256) && text(secret) && file && authorizeUrl()); }
  function safeStorage() {
    if (!file) fail('storage_unavailable');
    for (const p of [dir, file]) {
      if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('storage_unavailable');
    }
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) fail('storage_unavailable');
  }
  function read() {
    try {
      safeStorage();
      if (!fs.existsSync(file)) return null;
      if (!fs.statSync(file).isFile() || fs.statSync(file).size > 65536) fail('storage_unavailable');
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (r.version !== 1 || !text(r.accessToken) || !text(r.refreshToken) || !text(r.openId, 256) || !Array.isArray(r.scopes) || !Number.isFinite(r.expiresAt) || !Number.isFinite(r.refreshExpiresAt)) fail('storage_unavailable');
      return r;
    } catch { fail('storage_unavailable'); }
  }
  function write(record) {
    let tmp;
    try {
      safeStorage();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      tmp = path.join(dir, `.tiktok-${randomBytes(16).toString('hex')}.tmp`);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
      const directoryFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch { fail('storage_unavailable'); }
    finally { if (tmp && fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch { /* no secrets logged */ } } }
  }
  function status() {
    let r = null, storageError = false;
    try { r = read(); } catch { storageError = true; }
    const sameApp = !r || (r.appId === appId && r.redirectUri === callbackUrl());
    return { configured: configured(), callbackUrl: callbackUrl(), storageError, busy,
      grantStored: !!r, sameApp, openId: r?.openId || null, scopes: r?.scopes || [],
      expiresAt: r?.expiresAt || null, refreshExpiresAt: r?.refreshExpiresAt || null,
      expired: !!r && r.expiresAt <= now(), refreshExpired: !!r && r.refreshExpiresAt <= now(),
      // A stored grant is not a verified account identity or a running publisher.
      publishingEnabled: false };
  }
  function begin(session) {
    if (!configured()) fail('not_configured');
    if (!text(session, 256)) fail('invalid_state');
    if (busy) fail('busy');
    for (const [k, v] of pending) if (v.expires <= now()) pending.delete(k);
    if (pending.size >= 20) fail('busy');
    const state = randomBytes(32).toString('base64url');
    pending.set(hash(state), { session: hash(session), expires: now() + TTL });
    const u = authorizeUrl();
    u.searchParams.set('state', state);
    u.searchParams.set('disable_auto_auth', '1');
    return u.href;
  }
  async function post(endpoint, values) {
    let res, raw;
    try {
      res = await fetcher(BASE + endpoint + '/', { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: appId, client_secret: secret, ...values }), signal: AbortSignal.timeout(10_000) });
      const chunks = []; let size = 0;
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) { await reader.cancel(); fail('provider_failed'); } chunks.push(Buffer.from(value)); } }
        finally { reader.releaseLock(); }
        raw = Buffer.concat(chunks).toString('utf8');
      } else { raw = await res.text(); if (Buffer.byteLength(raw) > 65536) fail('provider_failed'); }
      const parsed = JSON.parse(raw);
      if (!res.ok || parsed.code !== 0 || !parsed.data || typeof parsed.data !== 'object') fail('provider_failed');
      return parsed.data;
    } catch { fail('provider_failed'); }
  }
  function record(data, started, previous = null) {
    const seconds = n => Number.isFinite(n) && n > 0 && n <= 2 * 366 * 86400;
    if (!text(data.access_token) || !text(data.refresh_token) || !text(data.open_id, 256) || data.token_type !== 'Bearer' || !text(data.scope, 4096) || !seconds(data.expires_in) || !seconds(data.refresh_token_expires_in)) fail('invalid_response');
    if (previous && data.open_id !== previous.openId) fail('different_account');
    const scopes = [...new Set(data.scope.split(',').map(s => s.trim()).filter(Boolean))];
    if (!scopes.length || scopes.some(s => !/^[a-zA-Z0-9_.:-]{1,100}$/.test(s))) fail('invalid_response');
    return { version: 1, appId, redirectUri: callbackUrl(), openId: data.open_id, scopes,
      accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: started + data.expires_in * 1000, refreshExpiresAt: started + data.refresh_token_expires_in * 1000, updatedAt: now() };
  }
  async function exclusive(fn) {
    if (busy) fail('busy'); busy = true;
    try { return await fn(); } finally { busy = false; }
  }
  async function finish({ params, session }) {
    if (!configured()) fail('not_configured');
    if (params.getAll('state').length !== 1) fail('invalid_state');
    const state = params.get('state');
    if (!/^[A-Za-z0-9_-]{43}$/.test(state || '') || !text(session, 256)) fail('invalid_state');
    const key = hash(state), entry = pending.get(key);
    if (!entry || entry.expires <= now() || entry.session !== hash(session)) { if (entry?.expires <= now()) pending.delete(key); fail('invalid_state'); }
    pending.delete(key); // single use, including denial/provider failures, before any await
    if (params.has('error')) fail('denied');
    // Provider documentation calls the returned value auth_code. Some authorization
    // pages label it code; accept either, never an ambiguous/duplicated pair.
    const codes = [...params.getAll('auth_code'), ...params.getAll('code')];
    if (codes.length !== 1 || !text(codes[0], 2048)) fail('invalid_code');
    return exclusive(async () => {
      const old = read();
      if (old && (old.appId !== appId || old.redirectUri !== callbackUrl())) fail('different_app');
      const started = now();
      const data = await post('token', { grant_type: 'authorization_code', auth_code: codes[0], redirect_uri: callbackUrl() });
      write(record(data, started, old)); return status();
    });
  }
  async function refresh() {
    if (!configured()) fail('not_configured');
    return exclusive(async () => {
      const old = read(); if (!old) fail('no_grant');
      if (old.appId !== appId || old.redirectUri !== callbackUrl()) fail('different_app');
      if (old.refreshExpiresAt <= now()) fail('reauthorize');
      const started = now();
      const data = await post('refresh_token', { grant_type: 'refresh_token', refresh_token: old.refreshToken, redirect_uri: callbackUrl() });
      write(record(data, started, old)); return status();
    });
  }
  async function revoke() {
    if (!configured()) fail('not_configured');
    return exclusive(async () => {
      let old = read(); if (!old) fail('no_grant');
      if (old.appId !== appId || old.redirectUri !== callbackUrl()) fail('different_app');
      if (old.expiresAt <= now()) {
        if (old.refreshExpiresAt <= now()) fail('reauthorize');
        const started = now();
        const data = await post('refresh_token', { grant_type: 'refresh_token', refresh_token: old.refreshToken, redirect_uri: callbackUrl() });
        old = record(data, started, old);
        write(old); // Persist rotated credentials before attempting revocation.
      }
      await post('revoke', { access_token: old.accessToken });
      try { safeStorage(); fs.unlinkSync(file); pending.clear(); } catch { fail('storage_unavailable'); }
      return status();
    });
  }
  async function forget() {
    return exclusive(async () => {
      try { safeStorage(); if (fs.existsSync(file)) fs.unlinkSync(file); pending.clear(); }
      catch { fail('storage_unavailable'); }
      return status();
    });
  }
  return { status, begin, finish, refresh, revoke, forget, callbackUrl };
}
