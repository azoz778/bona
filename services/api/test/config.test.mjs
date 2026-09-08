import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, siteDefaults, SITE_FILE } from '../lib/config.mjs';
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
