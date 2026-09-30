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
  // A tap asks the page (a `bona:open` message) and never drives an existing tab itself.
  assert.match(src, /type: 'bona:open'/);
  assert.doesNotMatch(src, /\.navigate\(/, 'no navigate(): a tab may hold a draft');
});

/**
 * Run the worker's source against a stub `self` and hand back its handlers and the calls
 * it made. `windows` is what `clients.matchAll` answers; each window answers the worker's
 * `bona:open` question with `answer` (`true`: the page goes there itself; `false`: it holds
 * a draft; left out: it never answers — a tab without our script, or one asleep). With
 * `immediateTimeout`, the worker's half-second wait fires at once.
 */
function runWorker({ windows = [], immediateTimeout = false } = {}) {
  const calls = { showNotification: [], openWindow: [], focus: [], asked: [], skipWaiting: 0, claim: 0 };
  const handlers = {};
  const windowClients = windows.map((w) => ({
    url: w.url,
    async focus() { calls.focus.push(w.url); return this; },
    postMessage(msg, transfer) {
      calls.asked.push({ type: msg.type, url: msg.url }); // copied: the worker's object is from the VM's realm
      const port = transfer && transfer[0];
      if (!port) return;
      if (w.answer !== undefined) port.postMessage({ ok: w.answer });
      port.close();
    },
  }));
  const self = {
    addEventListener(name, fn) { handlers[name] = fn; },
    skipWaiting() { calls.skipWaiting += 1; },
    registration: { async showNotification(title, options) { calls.showNotification.push([title, options]); } },
    clients: {
      async claim() { calls.claim += 1; },
      async matchAll() { return windowClients; },
      async openWindow(target) { calls.openWindow.push(target); return null; },
    },
  };
  const timers = immediateTimeout
    ? { setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {} }
    : { setTimeout, clearTimeout };
  vm.runInNewContext(ASSETS.get('/dashboard/sw.js').body.toString('utf8'), { self, URL, MessageChannel, ...timers }, { filename: 'sw.js' });
  /** Fire one event and wait for what the handler put in `waitUntil`. */
  const fire = async (name, event = {}) => {
    let pending = Promise.resolve();
    handlers[name]({ notification: { close() {} }, waitUntil(p) { pending = Promise.resolve(p); }, ...event });
    await pending;
  };
  return { calls, handlers, fire };
}

test('the worker: a push always shows the one notification; a tap asks our window first and opens a fresh one only when it says no or nothing (P3-3)', async () => {
  const pushed = runWorker();
  assert.deepEqual(Object.keys(pushed.handlers).sort(), ['activate', 'install', 'notificationclick', 'push']);
  await pushed.fire('push');
  assert.equal(pushed.calls.showNotification.length, 1);
  assert.equal(pushed.calls.showNotification[0][0], 'New Bona message');
  assert.ok(pushed.calls.showNotification[0][1].tag, 'a tag, so a second push replaces the first rather than stacking');
  assert.equal(pushed.calls.showNotification[0][1].badge, undefined, 'no badge: a monochrome blob on Android, ignored on iOS');
  await pushed.fire('install');
  assert.equal(pushed.calls.skipWaiting, 1);
  await pushed.fire('activate');
  assert.equal(pushed.calls.claim, 1);

  // A dashboard window with nothing being typed: focused, asked, and it goes there itself.
  const willing = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/dashboard/inbox', answer: true }] });
  await willing.fire('notificationclick');
  assert.deepEqual(willing.calls.focus, ['https://bona-api.azoz.uk/dashboard/inbox']);
  assert.deepEqual(willing.calls.asked, [{ type: 'bona:open', url: '/dashboard/push/open' }]);
  assert.deepEqual(willing.calls.openWindow, [], 'no second window: the page navigates');

  // The overview at /dashboard itself (no trailing slash) is ours too.
  const overview = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/dashboard', answer: true }] });
  await overview.fire('notificationclick');
  assert.equal(overview.calls.asked.length, 1);
  assert.deepEqual(overview.calls.openWindow, []);

  // A window holding a draft says no: it is left exactly as it is, and a fresh one opens.
  const drafting = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/dashboard/inbox/L', answer: false }] });
  await drafting.fire('notificationclick');
  assert.deepEqual(drafting.calls.focus, ['https://bona-api.azoz.uk/dashboard/inbox/L']);
  assert.deepEqual(drafting.calls.openWindow, ['/dashboard/push/open'], 'one fresh window instead');

  // A window that never answers (no script, asleep): the wait runs out, a fresh one opens.
  const silent = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/dashboard/leads' }], immediateTimeout: true });
  await silent.fire('notificationclick');
  assert.equal(silent.calls.asked.length, 1);
  assert.deepEqual(silent.calls.openWindow, ['/dashboard/push/open']);

  // No window at all, or none of ours: open one, and ask nobody.
  const none = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/', answer: true }] });
  await none.fire('notificationclick');
  assert.deepEqual(none.calls.focus, [], 'a window outside /dashboard is not ours');
  assert.deepEqual(none.calls.asked, []);
  assert.deepEqual(none.calls.openWindow, ['/dashboard/push/open']);
  const empty = runWorker();
  await empty.fire('notificationclick');
  assert.deepEqual(empty.calls.openWindow, ['/dashboard/push/open']);
});

test('app.js is one classic script that compiles', () => {
  new vm.Script(ASSETS.get('/dashboard/app.js').body.toString('utf8'), { filename: 'app.js' });
});

test('the manifest makes /dashboard an app that starts on the inbox', () => {
  const m = JSON.parse(ASSETS.get('/dashboard/manifest.webmanifest').body.toString('utf8'));
  assert.equal(m.scope, '/dashboard', 'no trailing slash: the overview at /dashboard itself is in scope');
  assert.equal(m.start_url, '/dashboard/inbox');
  assert.equal(m.id, '/dashboard/');
  assert.equal(m.display, 'standalone');
  assert.deepEqual(m.icons.map((i) => [i.src, i.sizes]), [['/dashboard/icon-192.png', '192x192'], ['/dashboard/icon-512.png', '512x512']]);
});

test('pages open script, worker, connect and manifest to self only; JSON keeps default-src none (P3-1)', () => {
  assert.equal(PAGE_CSP, "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'");
  assert.equal(PAGE_SECURITY_HEADERS['Content-Security-Policy'], PAGE_CSP);
  assert.equal(SECURITY_HEADERS['Content-Security-Policy'], "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'");
  assert.doesNotMatch(PAGE_CSP, /unsafe-inline'[^;]*script|script-src[^;]*unsafe/);
  assert.equal(PAGE_SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff', "'self' trusts every same-origin GET, so nothing may be sniffed into a script");
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

test('app.js registers the worker, subscribes only on a click, posts with the write marker, and never uses innerHTML', () => {
  const src = ASSETS.get('/dashboard/app.js').body.toString('utf8');
  new vm.Script(src);
  assert.match(src, /serviceWorker\.register\('\/dashboard\/sw\.js', \{ scope: '\/dashboard\/' \}\)/);
  assert.match(src, /pushManager\.subscribe\(\{ userVisibleOnly: true, applicationServerKey:/);
  assert.match(src, /'X-Bona-Dash': '1'/);
  assert.match(src, /'\/v1\/admin\/push\/subscribe'/);
  assert.match(src, /'\/v1\/admin\/push\/unsubscribe'/);
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/, 'nothing kept in the browser');
});

test('app.js live refresh: reloads a changed list, never a thread with a draft in the box', async () => {
  const src = ASSETS.get('/dashboard/app.js').body.toString('utf8');
  /**
   * The page as app.js sees it: the pulse element, the note (with its reload link when the
   * page has one), and the fields a draft could sit in — the thread's reply box `#r-text`,
   * the list's `#a-phone`. `reloads` records what the script navigated to: the note's link
   * (`location.replace`) or a bare `reload`. `answer` may be a token or `{ status }`.
   */
  const make = ({ pulse, token, answer, draft = '', focused = false, phone = '', link = null }) => {
    const reloads = [];
    const note = { hidden: true, querySelector: (sel) => (sel === 'a' && link ? { href: link } : null) };
    const box = { value: draft };
    const phoneField = { value: phone };
    const thread = pulse.includes('?lead=');
    const fields = thread ? [box] : [phoneField];
    const el = { dataset: { pulse, pulseToken: token } };
    const windowListeners = {};
    const documentListeners = {};
    const document = {
      visibilityState: 'visible',
      activeElement: focused ? box : null,
      querySelector: (sel) => ({ '[data-pulse]': el, '[data-pulse-note]': note, '#r-text': thread ? box : null })[sel] ?? null,
      querySelectorAll: () => fields,
      addEventListener: (name, fn) => { documentListeners[name] = fn; },
    };
    let tick = null;
    const ctx = {
      document, navigator: {},
      window: { matchMedia: () => ({ matches: false }), addEventListener: (name, fn) => { windowListeners[name] = fn; } },
      location: { origin: 'https://bona-api.azoz.uk', reload: () => reloads.push('reload'), replace: (href) => reloads.push(href) },
      fetch: async () => (typeof answer === 'object'
        ? { ok: false, status: answer.status, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ token: answer }) }),
      setInterval: (fn) => { tick = fn; return 1; }, clearInterval() {}, console,
    };
    vm.runInNewContext(src, ctx);
    return { run: async () => { await tick(); await new Promise((r) => setImmediate(r)); }, reloads, note, windowListeners, documentListeners };
  };
  const same = make({ pulse: '/v1/admin/inbox/pulse', token: '1:0:5', answer: '1:0:5' });
  await same.run();
  assert.equal(same.reloads.length, 0);
  const list = make({ pulse: '/v1/admin/inbox/pulse', token: '1:0:5', answer: '2:1:9', link: '/dashboard/inbox' });
  await list.run();
  assert.deepEqual(list.reloads, ['/dashboard/inbox'], "by the note's own link: a GET, never a re-post");
  const bare = make({ pulse: '/v1/admin/inbox/pulse', token: '1:0:5', answer: '2:1:9' });
  await bare.run();
  assert.deepEqual(bare.reloads, ['reload'], 'a page without a note link reloads');
  const draft = make({ pulse: '/v1/admin/inbox/pulse?lead=L', token: '4', answer: '5', draft: 'half a reply' });
  await draft.run();
  assert.equal(draft.reloads.length, 0);
  assert.equal(draft.note.hidden, false, 'the note says there is something new');
  const focused = make({ pulse: '/v1/admin/inbox/pulse?lead=L', token: '4', answer: '5', focused: true });
  await focused.run();
  assert.equal(focused.reloads.length, 0);
  assert.equal(focused.note.hidden, false);
  const empty = make({ pulse: '/v1/admin/inbox/pulse?lead=L', token: '4', answer: '5', link: '/dashboard/inbox/L' });
  await empty.run();
  assert.deepEqual(empty.reloads, ['/dashboard/inbox/L']);

  // The owner half-way through typing a number into "Add chat by phone number" keeps it.
  const adding = make({ pulse: '/v1/admin/inbox/pulse', token: '1:0:5', answer: '2:1:9', phone: '05000', link: '/dashboard/inbox' });
  await adding.run();
  assert.equal(adding.reloads.length, 0);
  assert.equal(adding.note.hidden, false, 'the list notes the new messages instead');

  // A pulse the server turned away (rate limited, signed out): nothing happens at all.
  const refused = make({ pulse: '/v1/admin/inbox/pulse', token: '1:0:5', answer: { status: 429 }, link: '/dashboard/inbox' });
  await refused.run();
  assert.equal(refused.reloads.length, 0);
  assert.equal(refused.note.hidden, true);

  // A navigation the person started (Send tapped, a link followed) is never raced by a reload.
  const leaving = make({ pulse: '/v1/admin/inbox/pulse?lead=L', token: '4', answer: '5', link: '/dashboard/inbox/L' });
  assert.equal(typeof leaving.windowListeners.beforeunload, 'function', 'the script listens for the page leaving');
  leaving.windowListeners.beforeunload();
  await leaving.run();
  assert.equal(leaving.reloads.length, 0);
  // Back from the back-forward cache, the page is not leaving any more.
  assert.equal(typeof leaving.windowListeners.pageshow, 'function', 'the script listens for a restore');
  leaving.windowListeners.pageshow();
  await leaving.run();
  assert.equal(leaving.reloads.length, 1, 'refreshes again after a restore');
  // iOS Safari never fires beforeunload: pagehide counts too.
  leaving.windowListeners.pagehide();
  await leaving.run();
  assert.equal(leaving.reloads.length, 1, 'no reload after pagehide');

  // A tap on one of our own links is a navigation the person started; a link elsewhere, a
  // tap that opens a new tab (a modifier key, target=_blank) or one a handler cancelled is not.
  const tapped = make({ pulse: '/v1/admin/inbox/pulse', token: '1:0:5', answer: '2:1:9', link: '/dashboard/inbox' });
  const click = (link, over = {}) => tapped.documentListeners.click({ target: { closest: () => link }, button: 0, ...over });
  click({ href: 'https://evil.example/x', origin: 'https://evil.example', target: '' });
  click({ href: 'https://bona-api.azoz.uk/dashboard/leads', origin: 'https://bona-api.azoz.uk', target: '_blank' });
  click({ href: 'https://bona-api.azoz.uk/dashboard/leads', origin: 'https://bona-api.azoz.uk', target: '' }, { ctrlKey: true });
  click({ href: 'https://bona-api.azoz.uk/dashboard/leads', origin: 'https://bona-api.azoz.uk', target: '' }, { defaultPrevented: true });
  click(null);
  await tapped.run();
  assert.equal(tapped.reloads.length, 1, 'none of those is leaving: the list still refreshes');
  click({ href: 'https://bona-api.azoz.uk/dashboard/leads', origin: 'https://bona-api.azoz.uk', target: '' });
  await tapped.run();
  assert.equal(tapped.reloads.length, 1, 'a plain tap on our own link: no reload over it');
});

/**
 * A signed-in Inbox page as app.js sees it, with the alerts panel and a browser that can do
 * push: the worker registers at once, `Notification.permission` is `granted`, and the
 * browser already holds `sub` (or none). `fields` are what a draft could sit in. Hands back
 * the listeners the script registered, the panel's state, and what it navigated to or posted.
 */
function signedInPage({ sub = null, draft = '', fields = null, active = null } = {}) {
  const src = ASSETS.get('/dashboard/app.js').body.toString('utf8');
  const posts = [];
  const navigations = [];
  const listeners = { window: {}, document: {}, sw: {}, onBtn: {}, offBtn: {} };
  const panel = { hidden: true };
  const text = { textContent: '' };
  const onBtn = { hidden: true, addEventListener: (n, fn) => { listeners.onBtn[n] = fn; } };
  const offBtn = { hidden: true, addEventListener: (n, fn) => { listeners.offBtn[n] = fn; } };
  const box = { value: draft };
  const el = { dataset: {} };
  const document = {
    visibilityState: 'visible',
    activeElement: active,
    querySelector: (sel) => ({
      '[data-pulse]': el, 'meta[name="bona-push-key"]': { content: 'BKEY' }, '[data-alerts]': panel,
      '[data-alerts-text]': text, '[data-alerts-on]': onBtn, '[data-alerts-off]': offBtn, '#r-text': box,
    })[sel] ?? null,
    querySelectorAll: () => fields ?? [box],
    addEventListener: (n, fn) => { listeners.document[n] = fn; },
  };
  const registration = { pushManager: { getSubscription: async () => sub, subscribe: async () => sub } };
  const ctx = {
    document,
    navigator: {
      serviceWorker: { register: async () => registration, addEventListener: (n, fn) => { listeners.sw[n] = fn; } },
      userAgent: 'test',
    },
    window: { PushManager: {}, Notification: {}, matchMedia: () => ({ matches: false }), addEventListener: (n, fn) => { listeners.window[n] = fn; } },
    Notification: { permission: 'granted' },
    location: { origin: 'https://bona-api.azoz.uk', assign: (url) => navigations.push(url), replace: (url) => navigations.push(url), reload: () => navigations.push('reload') },
    fetch: async (path, init) => { posts.push({ path, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    setInterval: () => 1, clearInterval() {}, console, JSON, Uint8Array, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  };
  vm.runInNewContext(src, ctx);
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
  return { listeners, panel, text, onBtn, offBtn, posts, navigations, settle };
}

test('app.js answers the worker\'s bona:open: goes there itself with no draft, refuses over one, ignores anything but a same-origin path', async () => {
  const ask = (page, url) => {
    const answers = [];
    // `{ ok }` copied: the page's answer object is from the VM's realm.
    page.listeners.sw.message({ data: { type: 'bona:open', url }, ports: [{ postMessage: (m) => answers.push({ ok: m.ok }) }] });
    return answers;
  };
  const clean = signedInPage();
  await clean.settle();
  assert.equal(typeof clean.listeners.sw.message, 'function', 'the script listens to the worker');
  assert.deepEqual(ask(clean, '/dashboard/push/open'), [{ ok: true }]);
  assert.deepEqual(clean.navigations, ['/dashboard/push/open'], 'the page navigates itself');

  const drafting = signedInPage({ draft: 'half a reply' });
  await drafting.settle();
  assert.deepEqual(ask(drafting, '/dashboard/push/open'), [{ ok: false }]);
  assert.deepEqual(drafting.navigations, [], 'the draft stays: the worker opens a fresh window instead');

  // A select being picked from (the handler picker) counts as a draft: a reload drops the pick.
  const picking = signedInPage({ fields: [], active: { tagName: 'select' } });
  await picking.settle();
  assert.deepEqual(ask(picking, '/dashboard/push/open'), [{ ok: false }]);
  assert.deepEqual(picking.navigations, []);

  for (const bad of ['https://evil.example/x', '//evil.example', 'javascript:alert(1)', '', 42, null]) {
    const page = signedInPage();
    await page.settle();
    assert.deepEqual(ask(page, bad), [], `${JSON.stringify(bad)} is not answered`);
    assert.deepEqual(page.navigations, [], `${JSON.stringify(bad)} is not followed`);
  }
  // A message that is not ours at all is ignored too.
  const other = signedInPage();
  await other.settle();
  other.listeners.sw.message({ data: { type: 'something-else', url: '/dashboard' }, ports: [] });
  other.listeners.sw.message({ data: null, ports: [] });
  assert.deepEqual(other.navigations, []);
});

test('app.js turn off is honest: "off" only when the browser lets the subscription go, else it says so and keeps the button', async () => {
  const device = (unsubscribeAnswers) => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/phone-1',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/phone-1', keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: async () => { const next = unsubscribeAnswers.shift(); if (next instanceof Error) throw next; return next; },
  });
  // Turned on already: the page re-posts the device (binds it to this login) and shows "on".
  const stuck = signedInPage({ sub: device([false, new Error('busy'), true]) });
  await stuck.settle();
  assert.equal(stuck.panel.hidden, false);
  assert.equal(stuck.offBtn.hidden, false, 'shown as on');
  assert.deepEqual(stuck.posts.map((p) => p.path), ['/v1/admin/push/subscribe']);
  assert.equal(typeof stuck.listeners.offBtn.click, 'function');

  await stuck.listeners.offBtn.click();
  assert.deepEqual(stuck.posts.map((p) => p.path), ['/v1/admin/push/subscribe', '/v1/admin/push/unsubscribe'], 'the server is told first');
  assert.match(stuck.text.textContent, /could not be turned off on this device/);
  assert.equal(stuck.offBtn.hidden, false, 'the Off button stays: the browser still holds the subscription');
  assert.equal(stuck.onBtn.hidden, true);

  await stuck.listeners.offBtn.click(); // unsubscribe() throws
  assert.match(stuck.text.textContent, /could not be turned off/);
  assert.equal(stuck.offBtn.hidden, false);

  await stuck.listeners.offBtn.click(); // unsubscribe() → true
  assert.doesNotMatch(stuck.text.textContent, /could not/);
  assert.equal(stuck.offBtn.hidden, true, 'off at last');
  assert.equal(stuck.onBtn.hidden, false);

  // Nothing subscribed: nothing to turn off, and honestly off.
  const none = signedInPage({ sub: null });
  await none.settle();
  assert.equal(none.onBtn.hidden, false, 'shown as off');
  await none.listeners.offBtn.click();
  assert.equal(none.offBtn.hidden, true);
  assert.deepEqual(none.posts, [], 'nothing to tell the server');
});
