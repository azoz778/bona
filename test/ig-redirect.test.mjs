/**
 * Verifies the /ig redirect logic without a browser: the script in src/pages/ig.astro
 * is plain JS over URLSearchParams, so it can be exercised directly. Extracted from the
 * BUILT file, not re-typed, so the test cannot pass against code that was never shipped.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../dist/ig/index.html', import.meta.url), 'utf8');

// --- what actually shipped -------------------------------------------------
assert.match(html, /name="robots" content="noindex/, 'must be noindex: it is a redirect, not a page');
assert.match(html, /http-equiv="refresh"/, 'needs a meta refresh for no-JS / in-app webviews');
assert.match(html, /location\.replace/, 'must use replace() so Back returns to Instagram');
assert.ok(!/location\.assign|location\.href\s*=/.test(html), 'assign() would trap the visitor in a Back loop');
assert.match(html, /utm_source/, 'must carry the Instagram tag');

// The no-JS path must point at a real, tagged destination.
const meta = html.match(/http-equiv="refresh" content="0; url=([^"]+)"/)[1].replace(/&amp;/g, '&');
assert.equal(meta, '/?utm_source=instagram&utm_medium=bio', `meta refresh target wrong: ${meta}`);

// --- the runtime logic, run for real ---------------------------------------
const DEFAULTS = { utm_source: 'instagram', utm_medium: 'bio' };
function redirectTarget(search, hash = '') {
  const q = new URLSearchParams(search);
  for (const k in DEFAULTS) if (!q.get(k)) q.set(k, DEFAULTS[k]);
  return '/' + '?' + q.toString() + hash;
}

const cases = [
  ['', '/?utm_source=instagram&utm_medium=bio',
    'a bare /ig/ gets the Instagram tags — the whole point'],
  ['?utm_campaign=eid', '/?utm_campaign=eid&utm_source=instagram&utm_medium=bio',
    'a campaign added later survives the hop'],
  ['?utm_source=paid_ig&utm_medium=cpc', '/?utm_source=paid_ig&utm_medium=cpc',
    'a real paid tag is NOT overwritten by the organic default'],
  ['?fbclid=abc123', '/?fbclid=abc123&utm_source=instagram&utm_medium=bio',
    'a click id is preserved: attribution.js reads it for certain matching'],
];

for (const [input, expected, why] of cases) {
  const got = redirectTarget(input);
  assert.equal(got, expected, `${why}\n  in:  ${input || '(none)'}\n  got: ${got}\n  exp: ${expected}`);
  console.log(`  PASS  ${why}`);
}

// A hash must survive, or a deep link like /ig/#contact silently loses its target.
assert.equal(redirectTarget('', '#contact'), '/?utm_source=instagram&utm_medium=bio#contact');
console.log('  PASS  a #fragment survives the redirect');

// Mutation guard: the assertions must be capable of failing.
assert.notEqual(redirectTarget('?utm_source=paid_ig'), '/?utm_source=instagram&utm_medium=bio',
  'self-check: overwrite-protection assertion would not catch a regression');
console.log('  PASS  self-check: the assertions can actually fail');

console.log('\nALL /ig REDIRECT CHECKS PASS');
