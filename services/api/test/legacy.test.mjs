/**
 * The 301 that carries bona.azoz.uk to bona-real-estate.com — the pure helpers, and the
 * whole service answering on a real socket with a legacy `Host` header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../index.mjs';
import { openDb } from '../lib/db.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';
import {
  DEFAULT_LEGACY_HOSTS, isLegacyHost, legacyRedirectUrl, normaliseHost, parseLegacyHosts, resolveLegacyHosts,
} from '../lib/legacy.mjs';

const SITE = 'https://bona-real-estate.com';

/* ---------------- the list ---------------- */

test('the default list is the old site host, and only hosts that can hold a certificate', () => {
  assert.ok(isLegacyHost('bona.azoz.uk', DEFAULT_LEGACY_HOSTS));
  // Universal SSL stops at one label under the zone, so www.bona.azoz.uk could never
  // complete a handshake here — promising a redirect for it would be a lie.
  assert.ok(!isLegacyHost('www.bona.azoz.uk', DEFAULT_LEGACY_HOSTS));
});

test('host matching ignores case and a :port suffix', () => {
  for (const h of ['BONA.AZOZ.UK', 'Bona.Azoz.Uk:443', 'bona.azoz.uk:4102', '  bona.azoz.uk  ', 'bona.azoz.uk.']) {
    assert.ok(isLegacyHost(h, DEFAULT_LEGACY_HOSTS), `${h} should redirect`);
  }
});

test('the hosts we actually serve are never legacy', () => {
  for (const h of [
    'bona-real-estate.com', 'www.bona-real-estate.com', 'api.bona-real-estate.com',
    'bona-api.azoz.uk', 'localhost', 'localhost:4102', '127.0.0.1:4102', '[::1]:4102',
    'bona.azoz.uk.evil.example', 'evil.example', '', undefined,
  ]) {
    assert.equal(isLegacyHost(h, DEFAULT_LEGACY_HOSTS), false, `${h} must not redirect`);
  }
});

test('a bracketed IPv6 host keeps its colons and loses only the port', () => {
  assert.equal(normaliseHost('[2001:db8::1]:4102'), '[2001:db8::1]');
  assert.equal(normaliseHost('[2001:db8::1]'), '[2001:db8::1]');
});

test('BONA_LEGACY_HOSTS overrides the defaults, and is normalised as it is read', () => {
  assert.deepEqual(parseLegacyHosts('Old.Test:443, other.test.'), ['old.test', 'other.test']);
  assert.deepEqual(parseLegacyHosts(''), DEFAULT_LEGACY_HOSTS);
  assert.deepEqual(parseLegacyHosts('  ,  '), DEFAULT_LEGACY_HOSTS);
});

test('the host we redirect to is dropped from the list, so a stale BONA_SITE cannot loop', () => {
  assert.deepEqual(resolveLegacyHosts(undefined, SITE), DEFAULT_LEGACY_HOSTS);
  assert.deepEqual(resolveLegacyHosts(undefined, 'https://bona.azoz.uk'), []);
  assert.deepEqual(resolveLegacyHosts('bona.azoz.uk,old.example', 'https://bona.azoz.uk'), ['old.example']);
  assert.deepEqual(resolveLegacyHosts(undefined, 'not a url'), DEFAULT_LEGACY_HOSTS);
});

/* ---------------- the target ---------------- */

test('path and query survive verbatim, escaping and all', () => {
  assert.equal(legacyRedirectUrl(SITE, '/'), `${SITE}/`);
  assert.equal(legacyRedirectUrl(SITE, '/ar/properties/'), `${SITE}/ar/properties/`);
  assert.equal(
    legacyRedirectUrl(SITE, '/properties/houses/?district=%D8%A7%D9%84%D8%B1%D9%88%D8%B6%D8%A9&sort=price'),
    `${SITE}/properties/houses/?district=%D8%A7%D9%84%D8%B1%D9%88%D8%B6%D8%A9&sort=price`,
  );
  assert.equal(legacyRedirectUrl(`${SITE}/`, '/a'), `${SITE}/a`);
});

test('a request target that is not a path becomes the homepage, never a header we did not write', () => {
  assert.equal(legacyRedirectUrl(SITE, '*'), `${SITE}/`);
  assert.equal(legacyRedirectUrl(SITE, 'https://evil.example/'), `${SITE}/`);
  assert.equal(legacyRedirectUrl(SITE, '/a\r\nX-Injected: 1'), `${SITE}/`);
  assert.equal(legacyRedirectUrl(SITE, undefined), `${SITE}/`);
});

/* ---------------- the service ---------------- */

const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: SITE });

/**
 * The app on a real socket. `fetch` will not let us name a `Host` other than the one it
 * dialled, so requests go out through `node:http`, which does exactly what it is told.
 */
async function withServer(configOverrides, fn) {
  const app = createApp({
    config: {
      port: 0, host: '127.0.0.1', siteUrl: SITE, publicApi: 'https://bona-api.azoz.uk',
      dataDir: '/nonexistent', inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS,
      legacyHosts: [...DEFAULT_LEGACY_HOSTS], toolToken: 'a'.repeat(32),
      retellApiKey: 'test', retellMock: false, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice',
      maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, env: {}, ids: {}, version: '1.0.0',
      toolRatePerMin: 600, toolAuthFailRatePerMin: 10, allowQueryToken: false, trustedProxies: [],
      maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40,
      ...configOverrides,
    },
    inventory,
    // The redirect is decided before anything else runs, so this suite has no use for the
    // store — but createApp opens one, and `dataDir: '/nonexistent'` is deliberate here.
    db: openDb(':memory:'),
    retell: { async ping() { return { ok: true }; } },
    probeRetell: async () => 'ok',
    sendWhatsApp: async () => ({ ok: true }),
    log: () => {},
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  /** One request, with the `Host` header spelled out. Resolves to status + headers + body. */
  const call = (path, { host = 'bona.azoz.uk', method = 'GET', headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    await fn({ call, app });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
}

test('a request on the old host is 301d to the same path on the new domain', async () => {
  await withServer({}, async ({ call }) => {
    const res = await call('/ar/properties/');
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, `${SITE}/ar/properties/`);
    assert.match(res.headers['cache-control'], /max-age=\d+/);
    assert.equal(res.body, '');
  });
});

test('the old host matches whatever case and port it arrives in', async () => {
  await withServer({}, async ({ call }) => {
    for (const host of ['BONA.AZOZ.UK', 'Bona.Azoz.uk:443', 'bona.azoz.uk:4102', 'bona.azoz.uk.']) {
      const res = await call('/', { host });
      assert.equal(res.status, 301, `${host} should have been redirected`);
      assert.equal(res.headers.location, `${SITE}/`);
    }
  });
});

test('the query string rides along untouched', async () => {
  await withServer({}, async ({ call }) => {
    const res = await call('/properties/?district=Al%20Rawdah&beds=4');
    assert.equal(res.headers.location, `${SITE}/properties/?district=Al%20Rawdah&beds=4`);
  });
});

test('a path with no route behind it still redirects rather than 404s — old links are the point', async () => {
  await withServer({}, async ({ call }) => {
    const res = await call('/blog/2024/why-jeddah.html');
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, `${SITE}/blog/2024/why-jeddah.html`);
  });
});

test('a token-gated route redirects too: the host is answered before anything authenticates', async () => {
  await withServer({}, async ({ call }) => {
    const res = await call('/v1/tools/search_properties', { method: 'POST' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, `${SITE}/v1/tools/search_properties`);
  });
});

test('every other host passes through untouched — the API still answers on its own', async () => {
  await withServer({}, async ({ call }) => {
    const health = await call('/health', { host: 'bona-api.azoz.uk' });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).service, 'bona-api');

    const missing = await call('/nope', { host: 'bona-api.azoz.uk' });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.location, undefined);
  });
});

test('an empty legacy list turns the redirect off entirely', async () => {
  await withServer({ legacyHosts: [] }, async ({ call }) => {
    const res = await call('/health');
    assert.equal(res.status, 200);
  });
});
