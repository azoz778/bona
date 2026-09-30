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
  // A tap asks the page (`bona:open`), tells it to go only on a yes (`bona:go`), and never drives an existing tab itself.
  assert.match(src, /type: 'bona:open'/);
  assert.match(src, /type: 'bona:go'/);
  assert.doesNotMatch(src, /\.navigate\(/, 'no navigate(): a tab may hold a draft');
});

/**
 * Run the worker's source against a stub `self` and hand back its handlers and the calls
 * it made. `windows` is what `clients.matchAll` answers; each window answers the worker's
 * `bona:open` question with `answer` (`true`: nothing being typed; `false`: it holds a
 * draft and has shown its note; left out: it never answers — a tab without our script, or
 * one asleep) and records any `bona:go` the worker then sends it in `calls.go`. With
 * `late`, the window answers only after the worker's wait has run out. With
 * `immediateTimeout`, that half-second wait fires at once.
 */
function runWorker({ windows = [], immediateTimeout = false } = {}) {
  const calls = { showNotification: [], openWindow: [], focus: [], asked: [], go: [], skipWaiting: 0, claim: 0 };
  const handlers = {};
  const windowClients = windows.map((w) => ({
    url: w.url,
    async focus() { calls.focus.push(w.url); return this; },
    postMessage(msg, transfer) {
      calls.asked.push({ type: msg.type, url: msg.url, to: w.url }); // copied: the worker's object is from the VM's realm
      const port = transfer && transfer[0];
      if (!port) return;
      port.onmessage = (e) => { calls.go.push({ type: e.data.type, url: e.data.url }); };
      const answer = () => port.postMessage({ ok: w.answer });
      if (w.answer === undefined) return;
      if (w.late) setImmediate(answer); else answer();
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
  /** Fire one event, wait for what the handler put in `waitUntil`, then let any port traffic settle. */
  const fire = async (name, event = {}) => {
    let pending = Promise.resolve();
    handlers[name]({ notification: { close() {} }, waitUntil(p) { pending = Promise.resolve(p); }, ...event });
    await pending;
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };
  return { calls, handlers, fire };
}

test('the worker: a push always shows the one notification; a tap asks our window and says go only on a yes, opens a fresh one only with no answer (P3-3)', async () => {
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

  // A dashboard window with nothing being typed: focused, asked, told to go; no second window.
  const willing = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/dashboard/inbox', answer: true }] });
  await willing.fire('notificationclick');
  assert.deepEqual(willing.calls.focus, ['https://bona-api.azoz.uk/dashboard/inbox']);
  assert.deepEqual(willing.calls.asked, [{ type: 'bona:open', url: '/dashboard/push/open', to: 'https://bona-api.azoz.uk/dashboard/inbox' }]);
  assert.deepEqual(willing.calls.go, [{ type: 'bona:go', url: '/dashboard/push/open' }], 'the page navigates on this, and only this');
  assert.deepEqual(willing.calls.openWindow, []);

  // The overview at /dashboard itself (no trailing slash) is ours too.
  const overview = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/dashboard', answer: true }] });
  await overview.fire('notificationclick');
  assert.equal(overview.calls.go.length, 1);
  assert.deepEqual(overview.calls.openWindow, []);

  // A window holding a draft says no (it has shown its own note with the link): it is left
  // exactly as it is — focused, no go, and no second window either.
  const drafting = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/dashboard/inbox/L', answer: false }] });
  await drafting.fire('notificationclick');
  assert.deepEqual(drafting.calls.focus, ['https://bona-api.azoz.uk/dashboard/inbox/L']);
  assert.deepEqual(drafting.calls.go, []);
  assert.deepEqual(drafting.calls.openWindow, [], 'never a fresh window for a page that refused');

  // A window that never answers (no script, asleep): the wait runs out, a fresh one opens.
  const silent = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/dashboard/leads' }], immediateTimeout: true });
  await silent.fire('notificationclick');
  assert.equal(silent.calls.asked.length, 1);
  assert.deepEqual(silent.calls.go, []);
  assert.deepEqual(silent.calls.openWindow, ['/dashboard/push/open']);

  // An answer that arrives after the wait ran out changes nothing: no go ever follows it.
  const late = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/dashboard/leads', answer: true, late: true }], immediateTimeout: true });
  await late.fire('notificationclick');
  assert.deepEqual(late.calls.openWindow, ['/dashboard/push/open']);
  assert.deepEqual(late.calls.go, [], 'a late yes is never turned into a go');

  // The login and logout pages carry no script: a signed-in window beside one is the one asked.
  const beside = runWorker({ windows: [
    { url: 'https://bona-api.azoz.uk/dashboard/login?step=code', answer: true },
    { url: 'https://bona-api.azoz.uk/dashboard/logout', answer: true },
    { url: 'https://bona-api.azoz.uk/dashboard/inbox', answer: true },
  ] });
  await beside.fire('notificationclick');
  assert.deepEqual(beside.calls.focus, ['https://bona-api.azoz.uk/dashboard/inbox']);
  assert.deepEqual(beside.calls.asked.map((a) => a.to), ['https://bona-api.azoz.uk/dashboard/inbox']);
  assert.deepEqual(beside.calls.openWindow, []);
  // Only a login window: not ours to ask; a fresh window instead of a second login tab's wait.
  const loginOnly = runWorker({ windows: [{ url: 'https://bona-api.azoz.uk/dashboard/login', answer: true }] });
  await loginOnly.fire('notificationclick');
  assert.deepEqual(loginOnly.calls.asked, []);
  assert.deepEqual(loginOnly.calls.openWindow, ['/dashboard/push/open']);

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
function signedInPage({ sub = null, draft = '', fields = null, active = null, withNote = true, noteHref = '', pulse = null } = {}) {
  const src = ASSETS.get('/dashboard/app.js').body.toString('utf8');
  const posts = [];
  const navigations = [];
  const listeners = { window: {}, document: {}, sw: {}, onBtn: {}, offBtn: {} };
  const panel = { hidden: true };
  const text = { textContent: '' };
  const onBtn = { hidden: true, addEventListener: (n, fn) => { listeners.onBtn[n] = fn; } };
  const offBtn = { hidden: true, addEventListener: (n, fn) => { listeners.offBtn[n] = fn; } };
  const box = { value: draft };
  // With `pulse` (`{ url, token, answer }`), the page carries a live refresh whose fetch answers `answer`.
  const el = { dataset: pulse ? { pulse: pulse.url, pulseToken: pulse.token } : {} };
  const noteLink = { href: noteHref, textContent: 'reload' };
  const note = { hidden: true, querySelector: (sel) => (sel === 'a' ? noteLink : null) };
  // Just enough DOM for a note built from nodes: elements with children, attributes and text.
  const element = (tag) => ({
    tagName: tag.toUpperCase(), className: '', hidden: false, textContent: '', attributes: {}, children: [], firstChild: null,
    setAttribute(k, v) { this.attributes[k] = v; },
    appendChild(c) { this.children.push(c); this.firstChild = this.children[0]; return c; },
    insertBefore(c, before) { const i = before ? this.children.indexOf(before) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); this.firstChild = this.children[0]; return c; },
  });
  const content = element('div');
  content.appendChild(element('h2')); // the page's own first element, which the note must go before
  const document = {
    visibilityState: 'visible',
    activeElement: active,
    querySelector: (sel) => ({
      '[data-pulse]': el, 'meta[name="bona-push-key"]': { content: 'BKEY' }, '[data-alerts]': panel,
      '[data-alerts-text]': text, '[data-alerts-on]': onBtn, '[data-alerts-off]': offBtn, '#r-text': box,
      '[data-pulse-note]': withNote ? note : (content.children.find((c) => c.attributes && 'data-pulse-note' in c.attributes) ?? null),
      '.content': content,
    })[sel] ?? null,
    querySelectorAll: () => fields ?? [box],
    addEventListener: (n, fn) => { listeners.document[n] = fn; },
    createElement: element,
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    body: element('body'),
  };
  // `lookups` scripts what later `getSubscription()` calls answer (an Error rejects); empty → `sub` as before.
  const lookups = [];
  const registration = { pushManager: {
    getSubscription: async () => { if (!lookups.length) return sub; const next = lookups.shift(); if (next instanceof Error) throw next; return next; },
    subscribe: async () => sub,
  } };
  const ctx = {
    document,
    navigator: {
      serviceWorker: { register: async () => registration, addEventListener: (n, fn) => { listeners.sw[n] = fn; } },
      userAgent: 'test',
    },
    window: { PushManager: {}, Notification: {}, matchMedia: () => ({ matches: false }), addEventListener: (n, fn) => { listeners.window[n] = fn; } },
    Notification: { permission: 'granted' },
    location: { origin: 'https://bona-api.azoz.uk', assign: (url) => navigations.push(url), replace: (url) => navigations.push(url), reload: () => navigations.push('reload') },
    fetch: async (path, init) => {
      if (!init || init.method !== 'POST') return { ok: true, status: 200, json: async () => ({ token: pulse ? pulse.answer : '' }) };
      posts.push({ path, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    setInterval: (fn) => { timers.tick = fn; return 1; }, clearInterval() {}, console, JSON, Uint8Array, URL, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  };
  const timers = { tick: null };
  vm.runInNewContext(src, ctx);
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
  /** One pulse tick, as the interval would fire it. */
  const tick = async () => { await timers.tick(); await settle(); };
  return { listeners, panel, text, onBtn, offBtn, posts, navigations, settle, tick, box, note, noteLink, lookups, content };
}

test('app.js and the worker\'s two steps: yes then go, no with the note over a draft, and only our own address ever followed', async () => {
  const TARGET = 'https://bona-api.azoz.uk/dashboard/push/open';
  /** Post `bona:open` as the worker does; hands back the page's answers and the port to send `go` on. */
  const open = (page, url) => {
    const answers = [];
    const port = { postMessage: (m) => answers.push({ ok: m.ok }), onmessage: null }; // `{ ok }` copied: the answer is from the VM's realm
    page.listeners.sw.message({ data: { type: 'bona:open', url }, ports: [port] });
    return { answers, go: () => port.onmessage && port.onmessage({ data: { type: 'bona:go', url } }) };
  };
  const clean = signedInPage();
  await clean.settle();
  assert.equal(typeof clean.listeners.sw.message, 'function', 'the script listens to the worker');
  const yes = open(clean, '/dashboard/push/open');
  assert.deepEqual(yes.answers, [{ ok: true }]);
  assert.deepEqual(clean.navigations, [], 'a yes moves nothing yet');
  yes.go();
  assert.deepEqual(clean.navigations, [TARGET], 'the page goes on the go, to the full same-origin address');

  // A draft on the page: no, and the note now carries the chat's link; nothing moves.
  const THREAD = 'https://bona-api.azoz.uk/dashboard/inbox/L';
  const drafting = signedInPage({ draft: 'half a reply', noteHref: THREAD, pulse: { url: '/v1/admin/inbox/pulse?lead=L', token: '4', answer: '5' } });
  await drafting.settle();
  const no = open(drafting, '/dashboard/push/open');
  assert.deepEqual(no.answers, [{ ok: false }]);
  assert.equal(drafting.note.hidden, false, 'the note is shown');
  assert.equal(drafting.noteLink.href, TARGET, 'and points at the chat');
  assert.equal(drafting.noteLink.textContent, 'open it', 'and says so');
  no.go(); // a go the worker would never send after a no: still nothing
  assert.deepEqual(drafting.navigations, []);
  // The draft sent, a later change of the chat refreshes the page to ITS OWN address — the
  // note's repointed link is the alert's chat, not where a refresh goes.
  drafting.box.value = '';
  await drafting.tick();
  assert.deepEqual(drafting.navigations, [THREAD], 'refreshed to the thread, not sent to the alert');

  // Typing began between the yes and the go: the go is refused too, with the note.
  const between = signedInPage();
  await between.settle();
  const later = open(between, '/dashboard/push/open');
  assert.deepEqual(later.answers, [{ ok: true }]);
  between.box.value = 'started typ';
  later.go();
  assert.deepEqual(between.navigations, [], 'a go never lands on a draft');
  assert.equal(between.note.hidden, false);
  assert.equal(between.noteLink.href, TARGET);

  // A busy page with no note of its own (Leads with a search typed, a lead record with an
  // unfinished note) gets one built from DOM nodes at the top of its content: the tap is not lost.
  const noteless = signedInPage({ draft: 'a search', withNote: false });
  await noteless.settle();
  assert.deepEqual(open(noteless, '/dashboard/push/open').answers, [{ ok: false }]);
  assert.deepEqual(noteless.navigations, []);
  const made = noteless.content.firstChild;
  assert.equal(made.tagName, 'P');
  assert.equal(made.className, 'flash');
  assert.deepEqual(made.attributes, { 'data-pulse-note': '' });
  assert.equal(made.hidden, false);
  assert.deepEqual(made.children.map((c) => c.tagName ?? c.textContent), ['New Bona message — ', 'A', '.']);
  assert.equal(made.children[1].href, TARGET, 'its link is the chat');
  assert.equal(made.children[1].textContent, 'open it');
  assert.equal(noteless.content.children.length, 2, 'inserted before the page\'s own content, nothing replaced');
  // Asked again, the same note is reused rather than a second one made.
  open(noteless, '/dashboard/push/open');
  assert.equal(noteless.content.children.filter((c) => c.attributes && 'data-pulse-note' in c.attributes).length, 1);
  // And the go that would never come still moves nothing.
  assert.deepEqual(noteless.navigations, []);

  // A select being picked from (the handler picker) counts as a draft: a reload drops the pick.
  const picking = signedInPage({ fields: [], active: { tagName: 'select' } });
  await picking.settle();
  assert.deepEqual(open(picking, '/dashboard/push/open').answers, [{ ok: false }]);

  // The person already tapped Send (the submit capture): the page is leaving, so no.
  const sending = signedInPage();
  await sending.settle();
  sending.listeners.document.submit();
  assert.deepEqual(open(sending, '/dashboard/push/open').answers, [{ ok: false }]);
  assert.deepEqual(sending.navigations, []);

  // Anything but our own /dashboard/push/open on this origin is not answered, not followed.
  for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example/x', '/dashboard/inbox', 'javascript:x', '', 42, null]) {
    const page = signedInPage();
    await page.settle();
    const out = open(page, bad);
    assert.deepEqual(out.answers, [], `${JSON.stringify(bad)} is not answered`);
    out.go();
    assert.deepEqual(page.navigations, [], `${JSON.stringify(bad)} is not followed`);
    assert.equal(page.note.hidden, true);
  }
  // A message that is not ours at all, or without a port, is ignored too.
  const other = signedInPage();
  await other.settle();
  other.listeners.sw.message({ data: { type: 'something-else', url: '/dashboard/push/open' }, ports: [] });
  other.listeners.sw.message({ data: { type: 'bona:open', url: '/dashboard/push/open' }, ports: [] });
  other.listeners.sw.message({ data: null, ports: [] });
  assert.deepEqual(other.navigations, []);
});

test('app.js turn off is honest: "off" only when the browser lets the subscription go, else it says so and keeps the button', async () => {
  /** A held subscription whose `unsubscribe()` answers in turn; `afterwards` runs on each call (to script what the browser then holds). */
  const device = (unsubscribeAnswers, afterwards = () => {}) => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/phone-1',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/phone-1', keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: async () => { const next = unsubscribeAnswers.shift(); afterwards(); if (next instanceof Error) throw next; return next; },
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

  // unsubscribe() answers false for a subscription already inactive: a fresh lookup finding
  // nothing proves alerts are off; one still finding it, or failing, does not.
  const inactive = signedInPage({ sub: device([false], () => inactive.lookups.push(null)) }); // after the false, the browser holds nothing
  await inactive.settle();
  await inactive.listeners.offBtn.click();
  assert.deepEqual(inactive.posts.map((p) => p.path), ['/v1/admin/push/subscribe', '/v1/admin/push/unsubscribe'], 'it was a real turn-off, not an empty one');
  assert.equal(inactive.offBtn.hidden, true, 'off: the browser holds nothing any more');
  const stillThere = signedInPage({ sub: device([false]) });
  await stillThere.settle();
  await stillThere.listeners.offBtn.click(); // the lookup still finds the same device
  assert.match(stillThere.text.textContent, /could not be turned off/);
  const lookupFails = signedInPage({ sub: device([false], () => lookupFails.lookups.push(new Error('no'))) });
  await lookupFails.settle();
  await lookupFails.listeners.offBtn.click();
  assert.match(lookupFails.text.textContent, /could not be turned off/);

  // A lookup that fails before anything proves nothing: not "off".
  const blind = signedInPage({ sub: device([true]) });
  await blind.settle();
  blind.lookups.push(new Error('no'));
  await blind.listeners.offBtn.click();
  assert.match(blind.text.textContent, /could not be turned off/);
  assert.equal(blind.offBtn.hidden, false);
  assert.deepEqual(blind.posts.map((p) => p.path), ['/v1/admin/push/subscribe'], 'the server was not told either');

  // Nothing subscribed: nothing to turn off, and honestly off.
  const none = signedInPage({ sub: null });
  await none.settle();
  assert.equal(none.onBtn.hidden, false, 'shown as off');
  await none.listeners.offBtn.click();
  assert.equal(none.offBtn.hidden, true);
  assert.deepEqual(none.posts, [], 'nothing to tell the server');
});
