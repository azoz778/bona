import test from 'node:test';
import assert from 'node:assert/strict';
import { corsHeaders, isAllowedOrigin, parseOrigins, DEFAULT_ORIGINS } from '../lib/cors.mjs';

test('the default allowlist covers the live site, Pages and local dev', () => {
  for (const o of ['https://bona.azoz.uk', 'https://azoz778.github.io', 'http://localhost:4321', 'http://127.0.0.1:4321']) {
    assert.ok(isAllowedOrigin(o, DEFAULT_ORIGINS), `${o} should be allowed`);
  }
});

test('everything else is refused — including look-alike origins', () => {
  for (const o of ['https://evil.example', 'https://bona.azoz.uk.evil.example', 'http://bona.azoz.uk', 'null', '', undefined]) {
    assert.equal(isAllowedOrigin(o, DEFAULT_ORIGINS), false, `${o} must not be allowed`);
  }
});

test('a trailing slash on the Origin header still matches', () => {
  assert.ok(isAllowedOrigin('https://bona.azoz.uk/', DEFAULT_ORIGINS));
});

test('allowed origins get echoed back, never a wildcard', () => {
  const h = corsHeaders('https://bona.azoz.uk', DEFAULT_ORIGINS);
  assert.equal(h['Access-Control-Allow-Origin'], 'https://bona.azoz.uk');
  assert.equal(h.Vary, 'Origin');
  assert.ok(h['Access-Control-Allow-Methods'].includes('POST'));
  assert.ok(!Object.values(h).includes('*'));
});

test('refused origins get no allow-origin header at all', () => {
  const h = corsHeaders('https://evil.example', DEFAULT_ORIGINS);
  assert.equal(h['Access-Control-Allow-Origin'], undefined);
  assert.equal(h.Vary, 'Origin');
});

test('BONA_CORS_ORIGINS overrides the defaults', () => {
  const list = parseOrigins('https://a.test, https://b.test/');
  assert.deepEqual(list, ['https://a.test', 'https://b.test']);
  assert.deepEqual(parseOrigins(''), DEFAULT_ORIGINS);
  assert.deepEqual(parseOrigins('   ,  '), DEFAULT_ORIGINS);
});
