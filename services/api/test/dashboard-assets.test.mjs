/**
 * The installable app's static files and the two CSPs (design §5, P3-1 / P3-2 / P3-3):
 * the fixed asset map, a service worker that shows one notification and never caches or
 * intercepts, the manifest, the page CSP that opens script/worker/connect/manifest to
 * ourselves only, and the layout head that links them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ASSETS } from '../lib/dashboard/assets.mjs';
import { PAGE_CSP, PAGE_SECURITY_HEADERS, SECURITY_HEADERS } from '../lib/dashboard/routes.mjs';
import { layout } from '../lib/dashboard/render.mjs';

const PATHS = ['/dashboard/sw.js', '/dashboard/app.js', '/dashboard/manifest.webmanifest', '/dashboard/icon-192.png', '/dashboard/icon-512.png', '/dashboard/apple-touch-icon.png'];

test('the asset map is exactly the six files, each with its type', () => {
  assert.deepEqual([...ASSETS.keys()].sort(), [...PATHS].sort());
  assert.equal(ASSETS.get('/dashboard/sw.js').type, 'text/javascript; charset=utf-8');
  assert.equal(ASSETS.get('/dashboard/app.js').type, 'text/javascript; charset=utf-8');
  assert.equal(ASSETS.get('/dashboard/manifest.webmanifest').type, 'application/manifest+json; charset=utf-8');
  for (const p of PATHS.filter((x) => x.endsWith('.png'))) {
    assert.equal(ASSETS.get(p).type, 'image/png');
    assert.deepEqual([...ASSETS.get(p).body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${p} is a PNG`);
  }
});

test('the service worker shows a fixed notification and caches nothing, intercepts nothing (P3-3)', () => {
  const src = ASSETS.get('/dashboard/sw.js').body.toString('utf8');
  new vm.Script(src, { filename: 'sw.js' });
  assert.doesNotMatch(src, /\bcaches\b|addEventListener\(\s*['"]fetch['"]|importScripts|onfetch/);
  assert.match(src, /addEventListener\(\s*'push'/);
  assert.match(src, /showNotification\(\s*'New Bona message'/);
  assert.match(src, /addEventListener\(\s*'notificationclick'/);
  assert.match(src, /'\/dashboard\/push\/open'/);
});

test('app.js is one classic script that compiles', () => {
  new vm.Script(ASSETS.get('/dashboard/app.js').body.toString('utf8'), { filename: 'app.js' });
});

test('the manifest makes /dashboard/ an app that starts on the inbox', () => {
  const m = JSON.parse(ASSETS.get('/dashboard/manifest.webmanifest').body.toString('utf8'));
  assert.equal(m.scope, '/dashboard/');
  assert.equal(m.start_url, '/dashboard/inbox');
  assert.equal(m.id, '/dashboard/');
  assert.equal(m.display, 'standalone');
  assert.deepEqual(m.icons.map((i) => [i.src, i.sizes]), [['/dashboard/icon-192.png', '192x192'], ['/dashboard/icon-512.png', '512x512']]);
});

test('pages open script, worker, connect and manifest to self only; JSON keeps default-src none (P3-1)', () => {
  assert.equal(PAGE_CSP, "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'");
  assert.equal(PAGE_SECURITY_HEADERS['Content-Security-Policy'], PAGE_CSP);
  assert.equal(SECURITY_HEADERS['Content-Security-Policy'], "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'");
  assert.doesNotMatch(PAGE_CSP, /unsafe-inline'[^;]*script|script-src[^;]*unsafe/);
});

test('the layout links the manifest and icons on every page; app.js and the push key only for a signed-in person', () => {
  const out = layout({ title: 'Login', body: '', chrome: false });
  assert.match(out, /<link rel="manifest" href="\/dashboard\/manifest\.webmanifest">/);
  assert.match(out, /<link rel="apple-touch-icon" href="\/dashboard\/apple-touch-icon\.png">/);
  assert.doesNotMatch(out, /<script|bona-push-key/);
  const me = { user_id: 'U1', name: 'Sara', role: 'staff', pushKey: 'BKey"<x>' };
  const signed = layout({ title: 'Inbox', body: '', me });
  assert.equal((signed.match(/<script\b[^>]*>/g) ?? []).join('|'), '<script src="/dashboard/app.js" defer>', 'one script, ours, no inline code');
  assert.match(signed, /<meta name="bona-push-key" content="BKey&quot;&lt;x&gt;">/);
  assert.match(layout({ title: 'x', body: '', me: { ...me, pushKey: undefined } }), /<meta name="bona-push-key" content="">/);
});
