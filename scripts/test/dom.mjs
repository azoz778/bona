/* A DOM small enough to run the two inline <head> scripts (src/scripts/attribution.js and
   src/scripts/tags.js) under `node --test`, and honest enough that the assertions mean something.

   Those two files are plain ES2017 IIFEs with no imports — they are inlined into every page by
   Head.astro — so the only way to test them is to run them the way the browser does: as a script
   whose global object IS `window`. `node:vm` gives us exactly that, and in exchange we can watch
   every script element they inject and every request they make, which is the whole point: the
   promise this stack makes is that NOTHING third-party is requested before consent. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const readScript = (name) => fs.readFileSync(path.join(root, 'src', 'scripts', name), 'utf8');

/**
 * @param {object} o
 * @param {string} [o.href]        the page the visitor is on
 * @param {string} [o.referrer]
 * @param {string} [o.listing]     <body data-listing>, i.e. a listing page
 * @param {string} [o.lang]
 * @param {object|null} [o.consent] the `bona_consent` record already in localStorage, or null
 * @param {object} [o.tags]        window.BONA_TAGS — the ids from site.json → analytics
 * @param {string} [o.api]         window.BONA_API
 */
export function makeWindow({ href = 'https://example.test/', referrer = '', listing = null, lang = 'en', consent = null, tags = {}, api = 'https://api.example.test' } = {}) {
  const injected = [];   // every <script src> the page ends up asking for
  const requests = [];   // every fetch()
  const listeners = new Map();
  const store = (initial = {}) => {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
      _map: map,
    };
  };

  const url = new URL(href);
  const element = (tagName) => {
    const el = { tagName: tagName.toUpperCase(), attrs: {}, async: false, src: '', type: '' };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
    return el;
  };
  const appendChild = (node) => { if (node?.tagName === 'SCRIPT' && node.src) injected.push(node.src); return node; };

  const body = element('body');
  if (listing) body.setAttribute('data-listing', listing);
  body.closest = () => null;

  const documentElement = element('html');
  documentElement.setAttribute('lang', lang);

  const localStorage = store(consent ? { bona_consent: JSON.stringify(consent) } : {});

  const win = {
    BONA_TAGS: tags,
    BONA_API: api,
    localStorage,
    sessionStorage: store(),
    crypto: { getRandomValues: (a) => { crypto.randomFillSync(a); return a; } },
    URL, URLSearchParams, Date, Math, JSON, RegExp, Error, String, Number, Boolean, Array, Object,
    console,
    location: { href, pathname: url.pathname, search: url.search, hostname: url.hostname, origin: url.origin },
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0),
    fetch: (u, init) => { requests.push({ url: String(u), init }); return Promise.resolve({ ok: true, status: 204 }); },
    document: {
      readyState: 'complete',
      referrer,
      cookie: '',
      documentElement,
      head: { appendChild },
      body,
      createElement: element,
      getElementsByTagName: () => [],
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    },
  };
  win.window = win;         // the scripts run with `window` as their global object
  win.globalThis = win;
  win.document.defaultView = win;
  vm.createContext(win);

  return {
    win,
    injected,
    requests,
    /** Fire a listener the script registered on `document` (click, astro:page-load, …). */
    fire: (type, ev) => { for (const fn of listeners.get(type) ?? []) fn(ev); },
    listeners,
    run: (name) => vm.runInContext(readScript(name), win, { filename: name }),
    /** Write a consent record the way Consent.astro does, then let the loader see it. */
    setConsent: (analytics, ads) => localStorage.setItem('bona_consent', JSON.stringify({ v: 1, analytics, ads, ts: Date.now() })),
  };
}

/** A click event shaped like the one the capture-phase listener receives. */
export function clickOn(target) {
  return { type: 'click', target };
}

/** An <a>/<button> that answers `closest()` for itself, which is all the handler asks of it. */
export function anchor(attrs = {}, { href = '' } = {}) {
  const el = { tagName: 'A', nodeType: 1, attrs: { ...attrs }, href };
  el.getAttribute = (k) => (k === 'href' ? el.href : (k in el.attrs ? el.attrs[k] : null));
  el.setAttribute = (k, v) => { if (k === 'href') el.href = String(v); else el.attrs[k] = String(v); };
  el.matches = (sel) => {
    if (sel.includes('[data-track]')) return 'data-track' in el.attrs;
    if (sel.includes('tel:')) return el.href.startsWith('tel:');
    return /wa\.me|api\.whatsapp\.com/.test(sel) && /wa\.me|api\.whatsapp\.com/.test(el.href);
  };
  el.closest = (sel) => (el.matches(sel) ? el : null);
  return el;
}
