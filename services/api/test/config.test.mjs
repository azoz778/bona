import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, redacted, siteDefaults, SITE_FILE } from '../lib/config.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';

/** A throwaway site.json with whatever shape the test needs. */
function siteFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-site-'));
  const file = path.join(dir, 'site.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('both domains are read out of src/data/site.json, not written down a second time', () => {
  const { file, cleanup } = siteFile({ url: 'https://example.test/', concierge: { apiBase: 'https://api.example.test/' } });
  assert.deepEqual(siteDefaults(file), { siteUrl: 'https://example.test', publicApi: 'https://api.example.test' });
  cleanup();
});

test('the repo\'s own site.json is readable and carries both — this is the live default', () => {
  const live = siteDefaults();
  assert.equal(live.siteUrl, JSON.parse(fs.readFileSync(SITE_FILE, 'utf8')).url.replace(/\/+$/, ''));
  assert.match(live.siteUrl, /^https:\/\//);
  assert.match(live.publicApi, /^https:\/\//);
});

test('anything that is not an http(s) URL is not a domain, and falls through', () => {
  for (const bad of [{}, { url: 42 }, { url: 'bona-real-estate.com' }, { url: 'javascript:alert(1)' }, 'not json at all']) {
    const { file, cleanup } = siteFile(bad);
    assert.deepEqual(siteDefaults(file), { siteUrl: null, publicApi: null }, JSON.stringify(bad));
    cleanup();
  }
  assert.deepEqual(siteDefaults('/nonexistent/site.json'), { siteUrl: null, publicApi: null });
});

test('the environment still wins over site.json, and a literal is only the last resort', () => {
  const env = { BONA_SITE: 'https://staging.example.test/', BONA_PUBLIC_API: 'https://api.staging.example.test' };
  const cfg = loadConfig({ env, ids: {} });
  assert.equal(cfg.siteUrl, 'https://staging.example.test');
  assert.equal(cfg.publicApi, 'https://api.staging.example.test');
});

test('the site\'s own origin is always allowed, whatever the allowlist says', () => {
  // Browser routes are origin-checked fail-closed, so a domain move that outran
  // BONA_CORS_ORIGINS would 403 every event, every enquiry and the whole concierge.
  const cfg = loadConfig({ env: { BONA_SITE: 'https://brand-new.test', BONA_CORS_ORIGINS: 'https://somewhere.else' }, ids: {} });
  assert.deepEqual(cfg.origins, ['https://somewhere.else', 'https://brand-new.test']);

  const dflt = loadConfig({ env: {}, ids: {} });
  for (const o of DEFAULT_ORIGINS) assert.ok(dflt.origins.includes(o), o);
  assert.ok(dflt.origins.includes(siteDefaults().siteUrl));
  assert.equal(new Set(dflt.origins).size, dflt.origins.length, 'no duplicate origins');
});

test('the WhatsApp poller reads every 20 s by default, and the environment still wins', () => {
  // The inbox (2026-09-27 design §4.3, P2-11): a staff member waits at most one interval
  // to see a client's message. The VPS env file pins its own value, which still wins.
  assert.equal(loadConfig({ env: {}, ids: {} }).waPollMs, 20_000);
  assert.equal(loadConfig({ env: { BONA_WA_POLL_MS: '45000' }, ids: {} }).waPollMs, 45_000);
});

test('VAPID keys come from the env; the subject defaults to the site; redacted() says only whether keys exist', () => {
  const cfg = loadConfig({ env: { BONA_VAPID_PUBLIC: ' PUB ', BONA_VAPID_PRIVATE: 'PRIV' }, ids: {} });
  assert.equal(cfg.vapidPublic, 'PUB');
  assert.equal(cfg.vapidPrivate, 'PRIV');
  assert.equal(cfg.vapidSubject, cfg.siteUrl);
  assert.equal(loadConfig({ env: { BONA_VAPID_SUBJECT: 'mailto:ops@example.com' }, ids: {} }).vapidSubject, 'mailto:ops@example.com');
  const r = redacted(cfg);
  assert.equal(r.hasVapid, true);
  assert.doesNotMatch(JSON.stringify(r), /PUB|PRIV/);
  assert.equal(redacted(loadConfig({ env: {}, ids: {} })).hasVapid, false);
  assert.doesNotMatch(JSON.stringify(redacted(loadConfig({ env: { BONA_VAPID_PUBLIC: 'P', BONA_VAPID_PRIVATE: 'K', BONA_VAPID_SUBJECT: 'mailto:ops@example.com' }, ids: {} }))), /ops@example/);
  assert.equal(redacted(loadConfig({ env: { BONA_VAPID_PUBLIC: 'P' }, ids: {} })).hasVapid, false);
});

test('the WhatsApp chat agent id comes from the env, else ids.json, and never falls back to the site agent', () => {
  const base = { env: { BONA_RETELL_CHAT_AGENT_ID: 'agent_site_env' }, ids: { chatAgentId: 'agent_site', voiceAgentId: 'agent_voice' } };
  assert.equal(loadConfig(base).waChatAgentId, null, 'the web prompt must never answer WhatsApp');
  assert.equal(loadConfig({ ...base, ids: { ...base.ids, waChatAgentId: 'agent_wa' } }).waChatAgentId, 'agent_wa');
  assert.equal(loadConfig({ env: { BONA_RETELL_WA_CHAT_AGENT_ID: 'agent_env' }, ids: { waChatAgentId: 'agent_wa' } }).waChatAgentId, 'agent_env');
  const cfg = loadConfig({ env: { RETELL_API_KEY: 'secret' }, ids: { waChatAgentId: 'agent_wa' } });
  assert.equal(redacted(cfg).waChatAgentId, 'agent_wa');
  assert.doesNotMatch(JSON.stringify(redacted(cfg)), /secret/);
});
