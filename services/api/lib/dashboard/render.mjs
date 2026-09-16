/**
 * The dashboard's HTML.
 *
 * Server-rendered strings with one embedded stylesheet and charts drawn as inline
 * SVG. There is no JavaScript on these pages at all — not "no framework", none: the
 * CSP the routes set is `default-src 'none'`, which forbids script outright, so a
 * stored cross-site script has nowhere to run even if one of the escapes below were
 * wrong. Every form is a plain form post; every filter is a GET.
 *
 * That also means the page is legible on a phone with a bad connection in a lift,
 * which is where the owner actually reads it.
 *
 * Arabic and English sit in the same tables — a lead's name, a listing's title — so
 * every cell that can hold either carries `dir="auto"` and the browser decides.
 * Phone numbers are masked to their last four digits everywhere except the one page
 * that exists to show a single person's record.
 */
import { STAGES } from '../db.mjs';

/** Everything that reaches HTML goes through here. No exceptions, no "this one is a number". */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `966593296933` → `…6933`. What a list needs to tell two leads apart, and no more. */
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return '—';
  return `…${digits.slice(-4)}`;
}

/** `+966 59 329 6933` — the readable form, for the one page that shows a whole record. */
export function fullPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return '—';
  if (digits.startsWith('966') && digits.length === 12) {
    return `+966 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return `+${digits}`;
}

const NBSP = ' ';

/** A duration a human reads at a glance: `4 min`, `3 h`, `12 d`. */
export function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}${NBSP}min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}${NBSP}h`;
  return `${Math.floor(h / 24)}${NBSP}d`;
}

/**
 * How long ago a TIMESTAMP was — the shape almost every caller actually wants.
 *
 * `ago(now - ts)` cannot defend itself: when `ts` is NULL, `now - null` is `now`, a
 * perfectly finite number, so the guard inside `ago()` passes and the page prints
 * "20712 d" — a 57-year-old lead. The nullability has to be caught on the timestamp,
 * before the subtraction, which is why this helper exists and why call sites should
 * use it instead of doing the arithmetic themselves.
 */
export function agoSince(now, ts) {
  if (ts === null || ts === undefined || ts === '') return '—';
  const t = Number(ts);
  if (!Number.isFinite(t)) return '—';
  return ago(now - t);
}

/** The largest instant a Date can hold. `Number.isFinite(1e20)` is true; `new Date(1e20)` throws. */
const MAX_TIME_MS = 8.64e15;
export const dateTime = (ts) => {
  // `Number(null)` is 0 and 0 is finite, so without this an unset timestamp renders as
  // a real-looking "1970-01-01 00:00" in the Created column. `undefined` already fell
  // through to '—'; the inconsistency was the tell.
  if (ts === null || ts === undefined || ts === '') return '—';
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(t) > MAX_TIME_MS) return '—';
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16);
};
const number = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : '—');
const money = (v) => (Number.isFinite(Number(v)) ? `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })} SAR` : '—');

/** A cell whose text may be Arabic or English; the browser picks the direction. */
export const auto = (v) => `<td dir="auto">${esc(v)}</td>`;
const cell = (v) => `<td>${esc(v)}</td>`;
const numCell = (v) => `<td class="n">${esc(number(v))}</td>`;

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */


/** Ivory and ink, the site's palette, in one stylesheet small enough to inline. */
export const STYLE = `
:root{
--ivory:#f5f1ea;--ivory-2:#ede7dc;--sand:#d9d0c1;--stone:#6f6a62;--stone-2:#5f5a53;
--ink:#0f1214;--ink-2:#1b1f22;--champagne:#c8a96a;--red:#a3301f;--amber:#8a6114;--green:#2f6b3f;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans Arabic",sans-serif;
--serif:ui-serif,Georgia,"Times New Roman","Noto Naskh Arabic","Noto Sans Arabic",serif;
--tap:48px;--pad:clamp(.9rem,4vw,2rem)
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ivory);color:var(--ink);font:16px/1.5 var(--sans);
padding-bottom:calc(var(--tap) + 14px + env(safe-area-inset-bottom))}
a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--sand)}
a:hover{border-bottom-color:var(--ink)}
:focus-visible{outline:2px solid var(--amber);outline-offset:2px}

/* ---- brand bar ---------------------------------------------------- */
header.top{background:var(--ink);color:var(--ivory);display:flex;align-items:center;
gap:1rem;padding:calc(.6rem + env(safe-area-inset-top)) var(--pad) .6rem}
header.top .brand{font:600 .8rem/1 var(--sans);letter-spacing:.24em;text-transform:uppercase;
margin-inline-end:auto;border-bottom:0}
header.top form{margin:0}
header.top form button{background:none;border:0;padding:.4rem 0;color:var(--ivory);opacity:.7;
font:inherit;font-size:.78rem;letter-spacing:.08em;text-transform:none;cursor:pointer}
header.top form button:hover{opacity:1;background:none;border-bottom:1px solid var(--champagne)}

/* ---- tab bar: fixed bottom on phone, inline row on desktop -------- */
nav.tabs{position:fixed;inset-inline:0;bottom:0;z-index:30;display:flex;
background:var(--ink);border-top:1px solid #2a2e31;
padding-bottom:env(safe-area-inset-bottom)}
nav.tabs a{flex:1 1 0;min-width:0;min-height:var(--tap);display:flex;align-items:center;
justify-content:center;text-align:center;color:var(--ivory);opacity:.62;border-bottom:0;
font-size:.74rem;letter-spacing:.06em;padding:.5rem .15rem;
border-top:2px solid transparent;margin-top:-1px}
nav.tabs a.on{opacity:1;border-top-color:var(--champagne)}
nav.tabs a:hover{opacity:1;border-bottom:0}

main{padding:0 var(--pad) 2rem;max-width:1180px;margin:0 auto}

/* ---- headings ----------------------------------------------------- */
h1{font:600 1.5rem/1.2 var(--serif);letter-spacing:.01em;margin:1.1rem 0 .2rem}
h2{font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--stone-2);
margin:1.8rem 0 .6rem;font-weight:600}
h3{font-size:.95rem;margin:0 0 .4rem;font-weight:600}
p.sub{color:var(--stone-2);margin:0 0 1.2rem;font-size:.86rem}
section{margin-bottom:.5rem}
.muted{color:var(--stone-2)}
.rule{border:0;border-top:1px solid var(--sand);margin:1.6rem 0}

/* ---- hero: the two-second answer ---------------------------------- */
.hero{padding:1.3rem 0 .2rem}
.hero .n{font:600 3.6rem/1 var(--serif);letter-spacing:-.02em;display:block}
.hero .n.zero{color:var(--green)}
.hero .say{font-size:1.02rem;color:var(--ink);margin:.55rem 0 0}
.hero .say b{font-weight:600}
.hero .then{font-size:.85rem;color:var(--stone-2);margin:.3rem 0 0}

/* ---- lead card ---------------------------------------------------- */
.leadcard{background:#fff;border:1px solid var(--sand);margin-bottom:.7rem}
.leadcard.hot{border-inline-start:3px solid var(--red)}
.leadcard.warm{border-inline-start:3px solid var(--champagne)}
.leadcard.cool{border-inline-start:3px solid var(--sand)}
.leadcard .body{display:block;padding:.8rem .9rem;border-bottom:0}
a.body:hover{border-bottom:0;background:var(--ivory)}
.leadcard .l1{display:flex;align-items:baseline;justify-content:space-between;gap:.6rem}
.leadcard .who{font:600 1.08rem/1.3 var(--sans);min-width:0;overflow-wrap:anywhere}
.leadcard .tel{font-size:.86rem;color:var(--stone-2);font-variant-numeric:tabular-nums;
unicode-bidi:isolate;direction:ltr;display:inline-block;margin-top:.25rem}
.leadcard .l2{margin-top:.2rem;font-size:.88rem;color:var(--stone-2);overflow-wrap:anywhere}
.leadcard .l3{margin-top:.35rem;font-size:.82rem;color:var(--stone-2)}
.leadcard.hot .l3{color:var(--red)}
.wait{flex:0 0 auto;font-size:.74rem;font-weight:600;letter-spacing:.04em;white-space:nowrap;
padding:.18rem .5rem;border:1px solid var(--sand);background:var(--ivory);color:var(--stone-2)}
.wait.hot{color:var(--red);border-color:var(--red)}
.wait.warm{color:var(--amber);border-color:var(--amber)}
.wait.done{text-transform:uppercase;letter-spacing:.1em;font-size:.66rem}
.chips{margin-top:.5rem;display:flex;flex-wrap:wrap;gap:.3rem}
.chip{font-size:.68rem;letter-spacing:.06em;padding:.15rem .42rem;border:1px solid var(--sand);
background:var(--ivory);color:var(--stone-2);max-width:100%;overflow-wrap:anywhere}
.chip.paid{border-color:var(--champagne);color:var(--amber)}
.chip.money{border-color:var(--green);color:var(--green);font-variant-numeric:tabular-nums}

/* ---- the one-tap action bar --------------------------------------- */
.acts{display:flex;border-top:1px solid var(--ivory-2)}
.acts .act{flex:1 1 0;min-height:var(--tap);display:flex;align-items:center;justify-content:center;
border:0;border-inline-end:1px solid var(--ivory-2);border-bottom:0;
font-size:.85rem;font-weight:600;letter-spacing:.04em;color:var(--ink);background:#fff}
.acts .act:last-child{border-inline-end:0}
.acts .act:hover{background:var(--ivory);border-bottom:0}
.acts .act.wa{color:var(--green)}
.acts .act.open{color:var(--stone-2);font-weight:500}
.acts .act.off{color:var(--stone-2);font-weight:400;font-style:italic;cursor:default}

.allclear{background:#fff;border:1px solid var(--green);padding:1.3rem 1rem;text-align:center}
.allclear b{display:block;font:600 1.15rem/1.3 var(--serif);color:var(--green);margin-bottom:.25rem}
.allclear span{font-size:.88rem;color:var(--stone-2)}

/* ---- stage rail ---------------------------------------------------- */
.rail{display:flex;gap:.5rem;overflow-x:auto;padding:.1rem .1rem .4rem;
scrollbar-width:none;-webkit-overflow-scrolling:touch}
.rail::-webkit-scrollbar{display:none}
.rail a{flex:0 0 auto;min-width:5.4rem;min-height:var(--tap);background:#fff;
border:1px solid var(--sand);padding:.5rem .7rem;border-bottom:1px solid var(--sand)}
.rail a.on{border-color:var(--ink);border-bottom-color:var(--ink)}
.rail a:hover{border-bottom-color:var(--ink)}
.rail b{display:block;font:600 1.5rem/1 var(--serif);font-variant-numeric:tabular-nums}
.rail span{display:block;font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;
color:var(--stone-2);margin-top:.3rem}
.rail a.win{border-color:var(--green)}
.rail a.win b{color:var(--green)}
.rail a.all b{color:var(--stone-2)}
.railnote{font-size:.82rem;color:var(--stone-2);margin:.5rem 0 1.1rem}

/* ---- speed strip --------------------------------------------------- */
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.7rem}
.strip .cellv{background:#fff;border:1px solid var(--sand);padding:.7rem .8rem}
.strip .cellv b{display:block;font:600 1.35rem/1.1 var(--serif);font-variant-numeric:tabular-nums}
.strip .cellv small{display:block;font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;
color:var(--stone-2);margin-bottom:.3rem}
.strip .cellv i{display:block;font-style:normal;font-size:.74rem;color:var(--stone-2);margin-top:.2rem}

/* ---- collapsible secondary sections -------------------------------- */
details.more{border-top:1px solid var(--sand);margin-top:1.4rem}
details.more>summary{min-height:var(--tap);display:flex;align-items:center;cursor:pointer;
font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--stone-2);
font-weight:600;list-style:none;padding:.4rem 0}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary::after{content:"+";margin-inline-start:.6rem;font-size:1rem;line-height:1}
details.more[open]>summary::after{content:"\u2212"}
details.more>.inner{padding-bottom:1rem}

/* ---- generic surfaces (kept for the other pages) -------------------- */
.card{background:#fff;border:1px solid var(--sand);padding:.9rem 1rem}
.grid{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))}
.kpi{background:#fff;border:1px solid var(--sand);padding:.8rem .9rem}
.kpi .v{font:600 1.5rem/1.15 var(--serif);font-variant-numeric:tabular-nums}
.kpi .k{font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;color:var(--stone-2);margin-bottom:.3rem}
.kpi .note{font-size:.76rem;color:var(--stone-2);margin-top:.25rem}
.tag{display:inline-block;font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;
border:1px solid var(--sand);padding:.1rem .38rem;margin:0 .2rem .2rem 0;background:var(--ivory);color:var(--stone-2)}
.tag.bad{border-color:var(--red);color:var(--red)}
.tag.warn{border-color:var(--amber);color:var(--amber)}
.tag.ok{border-color:var(--green);color:var(--green)}
.err{border:1px solid var(--red);color:var(--red);background:#fff;padding:.7rem .9rem;margin-bottom:1rem;font-size:.88rem}
.ok{border:1px solid var(--green);color:var(--green);background:#fff;padding:.7rem .9rem;margin-bottom:1rem;font-size:.88rem}

/* ---- tables -------------------------------------------------------- */
.scroll{overflow-x:auto;border:1px solid var(--sand);background:#fff}
table{border-collapse:collapse;width:100%;font-size:.86rem}
th,td{padding:.5rem .6rem;text-align:start;border-bottom:1px solid var(--ivory-2);
white-space:nowrap;vertical-align:top}
th{font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--stone-2);
background:var(--ivory);position:sticky;top:0}
td.n,th.n{text-align:end;font-variant-numeric:tabular-nums}
td.wrap{white-space:normal;min-width:14rem}
tbody tr:hover{background:var(--ivory)}
/* .stack tables collapse into labelled rows on a phone — no script */
@media (max-width:719px){
  table.stack{font-size:.88rem}
  table.stack thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  table.stack tr{display:block;padding:.6rem .7rem;border-bottom:1px solid var(--sand)}
  table.stack tr:last-child{border-bottom:0}
  table.stack td{display:flex;gap:1rem;justify-content:space-between;align-items:baseline;
  border:0;padding:.16rem 0;white-space:normal;overflow-wrap:anywhere}
  table.stack td::before{content:attr(data-label);flex:0 0 auto;color:var(--stone-2);
  font-size:.64rem;letter-spacing:.1em;text-transform:uppercase;padding-top:.2rem}
  table.stack td:empty{display:none}
  .scroll:has(table.stack){overflow-x:visible}
}

/* ---- forms --------------------------------------------------------- */
form.filters{display:grid;grid-template-columns:1fr auto;gap:.5rem .6rem;margin:0 0 1.1rem;align-items:end}
form.filters>div:first-child{grid-column:1/-1}
form.filters .go label{visibility:hidden}
form.stack{display:grid;gap:.7rem;max-width:34rem}
form.row{display:flex;flex-wrap:wrap;gap:.6rem;align-items:end}
label{display:block;font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;
color:var(--stone-2);margin-bottom:.25rem}
input,select,textarea,button{font:inherit;color:inherit;background:#fff;border:1px solid var(--sand);
padding:.6rem .6rem;border-radius:0;min-height:var(--tap);width:100%}
input:focus,select:focus,textarea:focus{outline:2px solid var(--amber);outline-offset:-2px}
textarea{min-height:5rem;resize:vertical}
button{background:var(--ink);color:var(--ivory);border-color:var(--ink);cursor:pointer;
letter-spacing:.1em;text-transform:uppercase;font-size:.74rem;padding:.6rem 1.1rem;width:auto}
button:hover{background:var(--ink-2)}
form.row input,form.row select,form.row button{width:auto}

/* ---- charts, timeline, field lists, login -------------------------- */
.charts{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))}
.chart{background:#fff;border:1px solid var(--sand);padding:.7rem .8rem}
.chart .k{font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;color:var(--stone-2);
display:flex;justify-content:space-between;gap:.5rem;margin-bottom:.4rem}
.chart svg{display:block;width:100%;height:auto}
ol.timeline{list-style:none;margin:0;padding:0}
ol.timeline li{border-inline-start:2px solid var(--sand);padding:0 0 .8rem 0;
padding-inline-start:.9rem;margin-inline-start:.3rem}
ol.timeline .when{font-size:.72rem;color:var(--stone-2);font-variant-numeric:tabular-nums}
ol.timeline .what{font-size:.88rem}
dl.fields{display:grid;grid-template-columns:max-content 1fr;gap:.35rem .9rem;margin:0;font-size:.88rem}
dl.fields dt{color:var(--stone-2);font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;padding-top:.18rem}
dl.fields dd{margin:0;overflow-wrap:anywhere}
.login{max-width:22rem;margin:10vh auto;padding:0 1.2rem}
.login h1{letter-spacing:.22em;text-transform:uppercase;font-size:.95rem;text-align:center;margin-bottom:1.4rem}
.login form{display:grid;gap:.8rem}
.login .code{font-size:1.5rem;letter-spacing:.4em;text-align:center;font-variant-numeric:tabular-nums}
footer{color:var(--stone-2);font-size:.74rem;padding:2rem 0 1rem;text-align:center}

/* ---- desktop ------------------------------------------------------- */
@media (min-width:720px){
  body{padding-bottom:0}
  nav.tabs{position:static;border-top:0;border-bottom:1px solid #2a2e31;
  padding:0 calc(var(--pad) - .7rem);justify-content:flex-start;gap:.2rem}
  nav.tabs a{flex:0 0 auto;min-height:2.6rem;padding:.4rem .7rem;font-size:.8rem;
  border-top:0;border-bottom:2px solid transparent;margin-top:0}
  nav.tabs a.on{border-bottom-color:var(--champagne)}
  h1{font-size:1.9rem}
  .hero .n{font-size:4.4rem}
  .leadcard{margin-bottom:.6rem}
  form.filters{grid-template-columns:2fr 1fr auto;gap:.6rem}
  form.filters>div:first-child{grid-column:auto}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`.trim();

/**
 * One page. `chrome:false` drops the nav (the login page has nowhere to go).
 */
export const NAV = [
  ['/dashboard', 'Desk'],
  ['/dashboard/leads', 'Leads'],
  ['/dashboard/listings', 'Listings'],
  ['/dashboard/spend', 'Spend'],
  ['/dashboard/integrations', 'Setup'],
];

/**
 * One page. `chrome:false` drops the nav (the login page has nowhere to go).
 *
 * The tab bar is a single element rendered once. Under 720px it is fixed to the
 * bottom of the viewport, inside the thumb's reach and clear of the notch; above
 * 720px the same element sits inline under the brand bar. No duplicate markup and
 * no script — the media query does all of it.
 */
/* ------------------------------------------------------------------ */
/* Reaching a person                                                   */
/* ------------------------------------------------------------------ */

const digitsOf = (phone) => String(phone ?? '').replace(/\D/g, '');

/** `https://wa.me/966593296933`, or null when there is no number to dial. */
export const waHref = (phone) => {
  const d = digitsOf(phone);
  return d ? `https://wa.me/${d}` : null;
};

/** `tel:+966593296933`, or null. */
export const telHref = (phone) => {
  const d = digitsOf(phone);
  return d ? `tel:+${d}` : null;
};

/**
 * A metadata line built only from the parts that exist. An em-dash is a statement —
 * "this is empty and that matters" — so it is never used as filler here.
 * Escapes its own arguments; callers pass raw values.
 */
const metaLine = (...parts) => parts
  .filter((p) => p !== null && p !== undefined && p !== '' && p !== '—')
  .map((p) => esc(p))
  .join(' · ');

/** `['a','b','c']` → `a, b and c`. For sentences about empty stages. */
const listWords = (arr) => (arr.length <= 1
  ? (arr[0] ?? '')
  : `${arr.slice(0, -1).join(', ')} and ${arr.at(-1)}`);

export const STAGE_LABEL = {
  new: 'New', contacted: 'Contacted', qualified: 'Qualified', viewing: 'Viewing',
  offer: 'Offer', negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
};
/** Prototype-safe: `?stage=constructor` must not print a function. */
const stageName = (s) => (typeof s === 'string' && Object.hasOwn(STAGE_LABEL, s)
  ? STAGE_LABEL[s]
  : (s ? String(s) : 'Unknown'));

const CLOSED = new Set(['won', 'lost']);

/**
 * Is this person still waiting on Abdulaziz, and for how long?
 *
 * Derived entirely from columns that already exist: a lead is waiting when it is not
 * won or lost and `first_reply_ts` is null. The clock starts at their first message,
 * or at creation when they arrived through a web form and have not written yet.
 */
export function waitState(lead, now) {
  // `first_reply_ts != null` rather than truthiness: the SQL that builds this queue
  // says `first_reply_ts IS NULL`, and 0 is a real (if absurd) timestamp that IS NOT
  // NULL. Under truthiness the two predicates disagreed — SQL would exclude such a
  // lead from the queue while this function still painted it as waiting, so the hero
  // count and the cards below it could tell two different stories.
  if (CLOSED.has(lead.stage) || (lead.first_reply_ts !== null && lead.first_reply_ts !== undefined)) {
    return { waiting: false, ms: null, tone: 'cool' };
  }
  // Guard the RAW value, not the coerced one: `Number(null)` is 0 and 0 IS finite, so
  // coercing first turns a NULL timestamp into the epoch and renders a 57-year wait
  // (`20712 d`), which also poisons "Longest:" on the overview and paints the card red.
  const raw = lead.first_inbound_ts ?? lead.created;
  const since = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  const ms = Number.isFinite(since) ? Math.max(0, now - since) : null;
  const hours = ms === null ? 0 : ms / 3_600_000;
  return { waiting: true, ms, tone: hours >= 24 ? 'hot' : hours >= 2 ? 'warm' : 'cool' };
}

/** Sort key: longest-waiting first, then everything else newest-first. */
export const byUrgency = (now) => (a, b) => {
  const wa = waitState(a, now);
  const wb = waitState(b, now);
  if (wa.waiting !== wb.waiting) return wa.waiting ? -1 : 1;
  if (wa.waiting) return (wb.ms ?? 0) - (wa.ms ?? 0);
  return Number(b.created ?? 0) - Number(a.created ?? 0);
};

export function layout({ title, body, active = null, chrome = true }) {
  const tabs = NAV.map(([href, label]) =>
    `<a href="${esc(href)}"${href === active ? ' class="on" aria-current="page"' : ''}>${esc(label)}</a>`).join('');
  const nav = chrome
    ? `<header class="top"><span class="brand">Bona</span>` +
      `<form method="post" action="/dashboard/logout"><input type="hidden" name="_dash" value="1">` +
      `<button type="submit">Log out</button></form></header>` +
      `<nav class="tabs" aria-label="Sections">${tabs}</nav>`
    : '';
  return `<!doctype html>
<html lang="en" translate="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, notranslate">
<meta name="google" content="notranslate">
<meta name="theme-color" content="#0f1214">
<title>${esc(title)} · Bona</title>
<style>${STYLE}</style>
</head>
<body>
${nav}
${chrome ? `<main>${body}</main>` : body}
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */

/**
 * A bar per day, drawn as SVG the server already knows the shape of. Each bar carries
 * a `<title>`, which every browser shows on hover and reads out to a screen reader —
 * the whole tooltip story, with no script.
 */
export function bars(points, { label = '', color = '#0f1214', height = 56 } = {}) {
  const list = Array.isArray(points) ? points : [];
  const n = Math.max(1, list.length);
  const width = 300;
  const gap = n > 1 ? Math.min(4, width / (n * 6)) : 0;
  const bw = (width - gap * (n - 1)) / n;
  const max = Math.max(1, ...list.map((p) => Number(p.value) || 0));
  const total = list.reduce((a, p) => a + (Number(p.value) || 0), 0);

  const rects = list.map((p, i) => {
    const v = Number(p.value) || 0;
    // A day with something on it always gets a visible sliver: a one-pixel bar and an
    // empty day must not look the same.
    const h = v > 0 ? Math.max(2, (v / max) * (height - 2)) : 0;
    const x = i * (bw + gap);
    return `<rect x="${x.toFixed(2)}" y="${(height - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" fill="${esc(color)}" fill-opacity="${v > 0 ? 1 : 0}"><title>${esc(p.label)}: ${esc(v)}</title></rect>`;
  }).join('');

  return `<div class="chart"><div class="k"><span>${esc(label)}</span><span>${esc(number(total))}</span></div>` +
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}: ${esc(total)} over ${n} days" preserveAspectRatio="none">${rects}</svg>` +
    `<div class="k"><span>${esc(list[0]?.label ?? '')}</span><span>${esc(list.at(-1)?.label ?? '')}</span></div></div>`;
}

const kpi = (k, v, note = '') => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${note ? `<div class="note">${esc(note)}</div>` : ''}</div>`;

const scrollTable = (head, rows, empty = 'Nothing yet.') =>
  (rows.length
    ? `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<p class="muted">${esc(empty)}</p>`);

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

/**
 * The messages an error code turns into. Codes travel in the query string, so the
 * lookup is by own property only — `?error=constructor` must be an unknown code, not a
 * function printed onto the page.
 */
export const MESSAGES = {
  rate_limited: 'Too many codes requested. Try again in a few minutes.',
  send_failed: 'WhatsApp would not take the message. Check the Evolution instance and try again.',
  bad_code: 'That code is not right.',
  unknown: 'That code is not right.',
  expired: 'That code has expired. Ask for a new one.',
  used: 'That code has already been used. Ask for a new one.',
  attempts: 'Too many wrong attempts on that code. Ask for a new one.',
  no_request: 'Ask for a new code, then type it into this same browser — a code only works where it was requested.',
  forbidden: 'That request did not come from this page. Open api.bona-real-estate.com/dashboard directly, with translation off.',
  bad_stage: 'That is not one of the stages.',
  bad_value: 'A deal value has to be a number.',
  empty_note: 'A note cannot be empty.',
  bad_request: 'That row was not accepted — check the day and the amount.',
};

/** A code the templates will render, or null. Anything unrecognised is nothing at all. */
export const knownError = (code) =>
  (typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : null);

const messageFor = (code) => (knownError(code) ? MESSAGES[code] : 'Something went wrong.');

/**
 * Two steps in one page: ask for a code, then type it in. Nothing here says whether
 * the owner exists, whether a code is outstanding, or how many attempts are left —
 * the login page is the one surface a stranger can reach.
 */
export function loginPage({ step = 'request', error = null, sent = false } = {}) {
  const message = error ? `<div class="err">${esc(messageFor(error))}</div>` : '';
  const notice = sent && !error ? '<div class="ok">Code sent to the owner\'s WhatsApp. It is valid for 10 minutes.</div>' : '';
  const body = step === 'code'
    ? `<form method="post" action="/dashboard/login/verify">
  <input type="hidden" name="_dash" value="1">
  <div><label for="code">6-digit code</label>
  <input class="code" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></div>
  <button type="submit">Sign in</button>
</form>
<p class="muted" style="margin-top:1rem"><a href="/dashboard/login">Send another code</a></p>`
    : `<form method="post" action="/dashboard/login/code">
  <input type="hidden" name="_dash" value="1">
  <p class="muted">A 6-digit code goes to the Bona WhatsApp number.</p>
  <button type="submit">Send me a code</button>
</form>`;
  return layout({
    title: 'Sign in',
    chrome: false,
    body: `<div class="login"><h1>Bona</h1>${message}${notice}${body}<footer>Private dashboard</footer></div>`,
  });
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

/** The one line that says where this person stands. Never ambiguous, never half a sentence. */
export function replyLine(lead, now) {
  // Same NULL trap as waitState(): `Number(null)` is 0, which is finite, so coercing
  // before guarding renders "for 20712 d" instead of omitting the clause.
  const rawStage = lead.stage_ts ?? lead.created;
  const stageMs = rawStage === null || rawStage === undefined || rawStage === ''
    ? null : now - Number(rawStage);
  const inStage = stageMs === null || !Number.isFinite(stageMs) ? null : ago(stageMs);
  const held = inStage ? ` for ${inStage}` : '';
  // `!= null` rather than truthiness, to match waitState() and the SQL — otherwise a
  // lead with first_reply_ts = 0 is correctly excluded from the queue and the hero
  // count, while its own card still reads "Waiting 2 h for your first reply". The
  // number and the sentence beside it must not contradict each other.
  const answered = lead.first_reply_ts !== null && lead.first_reply_ts !== undefined;
  if (lead.first_inbound_ts && answered) {
    // A reply logged at or before the inbound message is a clock artefact, not a
    // negative wait — say "Replied" rather than the nonsense "You replied in —".
    const took = Number(lead.first_reply_ts) - Number(lead.first_inbound_ts);
    const span = Number.isFinite(took) && took > 0 ? `You replied in ${ago(took)}` : 'Replied';
    return `${span} · ${stageName(lead.stage)}${held}`;
  }
  if (lead.first_inbound_ts && !answered) {
    return `Waiting ${ago(now - lead.first_inbound_ts)} for your first reply`;
  }
  return `No message from them yet · ${stageName(lead.stage)}${held}`;
}

/**
 * A lead, and the two taps that matter: WhatsApp and Call.
 *
 * The action bar is three top-level links, so it works with script disabled, with a
 * CSP of `default-src 'none'`, and on a lock-screened phone. `wa.me` takes bare digits;
 * `tel:` takes E.164. Neither can carry markup, because both are rebuilt from
 * `/\D/`-stripped digits before they are printed.
 *
 * Names and districts are Arabic as often as not, so every element that can hold one
 * carries `dir="auto"` and the browser decides which way it runs.
 */
export function leadCard(lead, now) {
  const href = `/dashboard/leads/${encodeURIComponent(lead.lead_id)}`;
  const st = waitState(lead, now);
  const wa = waHref(lead.phone_e164);
  const tel = telHref(lead.phone_e164);

  const badge = st.waiting && st.ms !== null
    ? `<span class="wait ${esc(st.tone)}">${esc(ago(st.ms))}</span>`
    : `<span class="wait done">${esc(stageName(lead.stage))}</span>`;

  const paid = typeof lead.medium === 'string' && /^(cpc|ppc|paid|paid_social|display|ads?)$/i.test(lead.medium);
  const chips = [
    lead.source ? `<span class="chip${paid ? ' paid' : ''}" dir="auto">${esc(lead.source)}</span>` : '',
    lead.campaign ? `<span class="chip" dir="auto">${esc(lead.campaign)}</span>` : '',
    lead.listing_id ? `<span class="chip" dir="auto">${esc(lead.listing_id)}</span>` : '',
    lead.value_sar ? `<span class="chip money">${esc(money(lead.value_sar))}</span>` : '',
  ].join('');

  const detail = metaLine(lead.district, lead.interest, lead.timeline);

  const acts = (wa || tel)
    ? `${wa ? `<a class="act wa" href="${esc(wa)}" rel="noreferrer">WhatsApp</a>` : ''}` +
      `${tel ? `<a class="act" href="${esc(tel)}">Call</a>` : ''}` +
      `<a class="act open" href="${href}">Open</a>`
    : `<span class="act off">No number on file</span><a class="act open" href="${href}">Open</a>`;

  return `<article class="leadcard ${esc(st.waiting ? st.tone : 'cool')}">
  <a class="body" href="${href}">
    <div class="l1"><span class="who" dir="auto">${esc(lead.name || lead.lead_id)}</span>${badge}</div>
    ${tel ? `<span class="tel">${esc(fullPhone(lead.phone_e164))}</span>` : ''}
    ${detail ? `<div class="l2" dir="auto">${detail}</div>` : ''}
    <div class="l3">${esc(replyLine(lead, now))}</div>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
  </a>
  <div class="acts">${acts}</div>
</article>`;
}

/**
 * The first screen: who is waiting, and the button that reaches them.
 *
 * Everything that used to be above the fold — four sparklines, the source table, the
 * match-quality table — is still here, complete, one tap down inside a `<details>`.
 * Those are desk questions. This page is for the ten seconds between viewings.
 */
export function overviewPage({
  daily, sources, matchQuality, responseTimes, pipeline, days,
  waiting = [], waitingTotal = null, now = Date.now(),
}) {
  // Each of these is a separate query wrapped in its own try/catch in the route, so any
  // one of them can legitimately arrive as null after a failure. A default parameter
  // only fires on `undefined`, so an explicit null sails past it — normalise instead.
  // The overview is the page the owner opens first; a single failed aggregate must
  // degrade one section, never 500 the whole screen.
  const days14 = Array.isArray(daily) ? daily : [];
  const sourceList = Array.isArray(sources) ? sources : [];
  const matchList = Array.isArray(matchQuality) ? matchQuality : [];
  const replies = responseTimes ?? { median_min: null, p90_min: null, count: 0 };
  const queueIn = Array.isArray(waiting) ? waiting : [];

  /* ---- the answer -------------------------------------------------- */
  const queue = [...queueIn].sort(byUrgency(now)).filter((l) => waitState(l, now).waiting);
  const shown = queue.slice(0, 6);
  const oldest = queue.length ? waitState(queue[0], now).ms : null;
  const overnight = queue.filter((l) => (waitState(l, now).ms ?? 0) >= 86_400_000).length;

  // `waiting` is a CAPPED slice (the route asks for 50). Showing its length as the
  // headline would tell the owner he has 50 people waiting when he has 400, which is
  // the same "count the slice, not the set" bug the stage rail exists to avoid.
  // `waitingTotal` is a real COUNT(*); fall back to the slice only when it is absent.
  const total = Number(waitingTotal);
  const trueWaiting = Number.isFinite(total) ? Math.max(total, queue.length) : queue.length;
  const rest = trueWaiting - shown.length;

  const hero = trueWaiting === 0
    ? `<div class="hero"><span class="n zero">0</span>
       <p class="say"><b>All caught up.</b></p>
       <p class="then">Every lead has had a reply.</p></div>`
    : `<div class="hero"><span class="n">${esc(trueWaiting)}</span>
       <p class="say"><b>${esc(trueWaiting === 1 ? 'lead is' : 'leads are')} waiting on your first reply</b></p>
       <p class="then">Longest: ${esc(ago(oldest))}.${overnight ? ` ${esc(overnight)} over a day old.` : ''}</p></div>`;

  const queueBlock = trueWaiting
    ? shown.map((l) => leadCard(l, now)).join('') +
      (rest > 0 ? `<p class="muted">${esc(rest)} more waiting — <a href="/dashboard/leads">open the full list</a>.</p>` : '')
    : `<div class="allclear"><b>All caught up</b><span>Every lead has had a reply. Nothing needs you right now.</span></div>`;

  /* ---- pipeline, honest about empty stages -------------------------- */
  const counts = new Map((pipeline ?? []).map((p) => [p.stage, Number(p.count) || 0]));
  const live = STAGES.filter((s) => (counts.get(s) ?? 0) > 0);
  const empty = STAGES.filter((s) => (counts.get(s) ?? 0) <= 0);
  const openLeads = STAGES.filter((s) => !CLOSED.has(s)).reduce((a, s) => a + (counts.get(s) ?? 0), 0);

  const rail = live.map((s) => `<a class="${esc(s === 'won' ? 'win' : '')}" href="/dashboard/leads?stage=${encodeURIComponent(s)}">` +
    `<b>${esc(number(counts.get(s)))}</b><span>${esc(stageName(s))}</span></a>`).join('');

  const railBlock = live.length
    ? `<div class="rail">${rail}</div>` +
      (empty.length ? `<p class="railnote">Nothing in ${esc(listWords(empty.map(stageName).map((n) => n.toLowerCase())))}.</p>` : '')
    : `<p class="muted">No leads in the pipeline yet.</p>`;

  /* ---- speed -------------------------------------------------------- */
  const speed = replies.median_min === null || !replies.count
    ? `<p class="muted">Nothing measured yet — no lead has both a message and a reply logged.</p>`
    : `<div class="strip">
    <div class="cellv"><small>Median first reply</small><b>${esc(replies.median_min)} min</b><i>across ${esc(replies.count)} leads</i></div>
    <div class="cellv"><small>Slowest 1 in 10</small><b>${esc(replies.p90_min === null ? '—' : `${replies.p90_min} min`)}</b><i>p90</i></div>
    <div class="cellv"><small>Open leads</small><b>${esc(number(openLeads))}</b><i>not won or lost</i></div>
    <div class="cellv"><small>Leads, ${esc(days)} d</small><b>${esc(number(days14.reduce((a, d) => a + (Number(d.leads) || 0), 0)))}</b><i>new in the window</i></div>
  </div>`;

  /* ---- the desk-at-night material ----------------------------------- */
  const strip = [
    ['Sessions', 'sessions', '#0f1214'],
    ['WhatsApp clicks', 'wa_clicks', '#c8a96a'],
    ['Leads', 'leads', '#2f6b3f'],
    ['Viewings', 'viewings', '#6f6a62'],
  ].map(([label, key, color]) =>
    bars(days14.map((d) => ({ label: d.day, value: d[key] })), { label, color })).join('');

  const sourceRows = sourceList.map((s) => `<tr>
    <td data-label="Source" dir="auto">${esc(s.source)}</td>
    <td data-label="Medium">${esc(s.medium)}</td>
    <td data-label="Campaign" dir="auto">${esc(s.campaign ?? '—')}</td>
    <td data-label="ID">${esc(s.campaign_id ?? '—')}</td>
    <td data-label="First touch" class="n">${esc(number(s.first_touch_leads))}</td>
    <td data-label="Last touch" class="n">${esc(number(s.last_touch_leads))}</td>
    <td data-label="WA clicks" class="n">${esc(number(s.wa_clicks))}</td>
    <td data-label="Spend" class="n">${esc(s.spend_sar ? money(s.spend_sar) : '—')}</td>
    <td data-label="CPL" class="n">${esc(s.cpl === null || s.cpl === undefined ? '—' : money(s.cpl))}</td>
  </tr>`);

  const matchTotal = matchList.reduce((a, m) => a + m.count, 0);
  const matchRows = matchList.map((m) => `<tr>
    <td data-label="Method">${esc(m.match_method)}</td>
    <td data-label="Leads" class="n">${esc(number(m.count))}</td>
    <td data-label="Share" class="n">${esc(matchTotal ? `${Math.round((m.count / matchTotal) * 100)}%` : '—')}</td>
  </tr>`);

  const stacked = (head, rows, empty2) => (rows.length
    ? `<div class="scroll"><table class="stack"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<p class="muted">${esc(empty2)}</p>`);

  return layout({
    title: 'Desk',
    active: '/dashboard',
    body: `${hero}

<h2>Needs a reply</h2>
${queueBlock}

<h2>Pipeline</h2>
${railBlock}

<h2>Speed — all time</h2>
${speed}

<details class="more"><summary>The last ${esc(days)} days</summary><div class="inner">
<div class="charts">${strip}</div>
</div></details>

<details class="more"><summary>Where leads come from</summary><div class="inner">
<p class="sub">First touch is the campaign that found the person; last touch is the visit the enquiry happened on. They are counted separately on purpose. Only the day-by-day charts are windowed — every lead ever is counted here.</p>
${stacked('<th>Source</th><th>Medium</th><th>Campaign</th><th>ID</th><th class="n">First touch</th><th class="n">Last touch</th><th class="n">WA clicks</th><th class="n">Spend</th><th class="n">CPL</th>', sourceRows, 'No leads yet.')}
</div></details>

<details class="more"><summary>Match quality</summary><div class="inner">
<p class="sub">How each lead was tied to its traffic. <code>time_window</code> is an inference, not a fact.</p>
${stacked('<th>Method</th><th class="n">Leads</th><th class="n">Share</th>', matchRows, 'No leads yet.')}
</div></details>

<footer>Jeddah time.</footer>`,
  });
}


/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

const stageOptions = (selected) => STAGES.map((s) =>
  `<option value="${esc(s)}"${s === selected ? ' selected' : ''}>${esc(stageName(s))}</option>`).join('');

/**
 * Every lead, sorted by who has been left hanging longest.
 *
 * The eight-column board is gone. With tens of leads it was four empty columns and a
 * sideways scroll; a rail of the stages that actually hold something, plus one sentence
 * naming the ones that do not, says strictly more in a fifth of the space.
 */
export function leadsPage({ board, counts = null, leads, stage = '', q = '', now = Date.now(), total = 0 }) {
  // A default parameter only fires on `undefined`; an explicit `null` sails past it and
  // throws "leads is not iterable" at the spread below. Normalise instead.
  const allLeads = Array.isArray(leads) ? leads : [];
  /* ---- stage rail from the counts the route already computes -------- */
  // The rail must report COUNT(*), never the handful of cards this page rendered.
  // `counts[s]` is coerced before the finite check: better-sqlite3 in safeIntegers mode
  // yields BigInt, and a JSON round-trip yields a string — both fail Number.isFinite()
  // directly and would silently fall back to the rendered slice, which is exactly the
  // lie the rail exists to prevent. When `counts` is present but the key is missing,
  // report 0 rather than the slice: a partial counts object must not mix two units.
  const tally = new Map(STAGES.map((s) => {
    const cards = board?.[s] ?? [];
    if (!counts) return [s, cards.length];
    const n = Number(counts[s]);
    return [s, Number.isFinite(n) ? n : 0];
  }));
  const live = STAGES.filter((s) => (tally.get(s) ?? 0) > 0);
  const empty = STAGES.filter((s) => (tally.get(s) ?? 0) <= 0);

  const rail = `<div class="rail">` +
    `<a class="all${stage === '' ? ' on' : ''}" href="/dashboard/leads${q ? `?q=${encodeURIComponent(q)}` : ''}">` +
    `<b>${esc(number(total))}</b><span>All</span></a>` +
    live.map((s) => `<a class="${esc(s === 'won' ? 'win' : '')}${s === stage ? ' on' : ''}" ` +
      `href="/dashboard/leads?stage=${encodeURIComponent(s)}${q ? `&q=${encodeURIComponent(q)}` : ''}">` +
      `<b>${esc(number(tally.get(s)))}</b><span>${esc(stageName(s))}</span></a>`).join('') +
    `</div>` +
    (empty.length && empty.length < STAGES.length
      ? `<p class="railnote">Nothing in ${esc(listWords(empty.map((s) => stageName(s).toLowerCase())))}.</p>`
      : '');

  /* ---- the list, urgent first --------------------------------------- */
  const sorted = [...allLeads].sort(byUrgency(now));
  const hot = sorted.filter((l) => waitState(l, now).waiting);
  const cool = sorted.filter((l) => !waitState(l, now).waiting);

  const hotBlock = hot.length
    ? `<h2>Waiting on you — ${esc(hot.length)}</h2>${hot.map((l) => leadCard(l, now)).join('')}`
    : (allLeads.length
      ? `<h2>Waiting on you</h2><div class="allclear"><b>All caught up</b><span>Every lead here has had a reply.</span></div>`
      : '');

  const coolBlock = cool.length
    ? `<h2>Everyone else — ${esc(cool.length)}</h2>${cool.map((l) => leadCard(l, now)).join('')}`
    : '';

  const nothing = allLeads.length
    ? ''
    : `<p class="muted">${esc(stage || q ? 'No leads match that filter.' : 'No leads yet.')}</p>`;

  /* ---- the full table, one tap down --------------------------------- */
  const rows = sorted.map((l) => `<tr>
    <td data-label="Name"><a href="/dashboard/leads/${encodeURIComponent(l.lead_id)}" dir="auto">${esc(l.name || l.lead_id)}</a></td>
    <td data-label="Phone">${esc(fullPhone(l.phone_e164))}</td>
    <td data-label="Stage">${esc(stageName(l.stage))}</td>
    <td data-label="Source" dir="auto">${esc(l.source ?? '—')}</td>
    <td data-label="Medium">${esc(l.medium ?? '—')}</td>
    <td data-label="Campaign" dir="auto">${esc(l.campaign ?? '—')}</td>
    <td data-label="Listing">${esc(l.listing_id ?? '—')}</td>
    <td data-label="District" dir="auto">${esc(l.district ?? '—')}</td>
    <td data-label="Channel">${esc(l.channel ?? '—')}</td>
    <td data-label="Match">${esc(l.match_method ?? '—')}</td>
    <td data-label="Age">${esc(agoSince(now, l.created))}</td>
    <td data-label="Created">${esc(dateTime(l.created))}</td>
  </tr>`);

  const table = rows.length
    ? `<div class="scroll"><table class="stack"><thead><tr>` +
      `<th>Name</th><th>Phone</th><th>Stage</th><th>Source</th><th>Medium</th><th>Campaign</th>` +
      `<th>Listing</th><th>District</th><th>Channel</th><th>Match</th><th>Age</th><th>Created</th>` +
      `</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<p class="muted">Nothing to show.</p>`;

  const headline = hot.length
    ? `${esc(total)} leads. ${esc(hot.length)} ${hot.length === 1 ? 'is' : 'are'} waiting on your first reply.`
    : `${esc(total)} leads. None are waiting on a reply.`;

  return layout({
    title: 'Leads',
    active: '/dashboard/leads',
    body: `<h1>Leads</h1><p class="sub">${headline}</p>

${rail}

<form class="filters" method="get" action="/dashboard/leads">
  <div><label for="f-q">Search</label>
    <input id="f-q" name="q" value="${esc(q)}" placeholder="name, phone, district…" dir="auto"></div>
  <div><label for="f-stage">Stage</label>
    <select id="f-stage" name="stage"><option value="">Any stage</option>${stageOptions(stage)}</select></div>
  <div class="go"><label for="f-go">Go</label><button id="f-go" type="submit">Filter</button></div>
</form>

${nothing}
${hotBlock}
${coolBlock}

<details class="more"><summary>Full table</summary><div class="inner">
<p class="sub">Every column, for the nights you are reconciling attribution at a desk.</p>
${table}
</div></details>`,
  });
}


/** A table lookup that cannot answer with a prototype member. */
const from = (table, key, fallback = null) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : fallback);

const JOURNEY_LABEL = {
  event: (e) => `${e.name}${e.listing_id ? ` · ${e.listing_id}` : ''}${e.path ? ` · ${e.path}` : ''}`,
  touchpoint: (e) => `${e.event_type} · ${e.channel}${e.source ? ` · ${e.source}${e.medium ? `/${e.medium}` : ''}` : ''}${e.campaign ? ` · ${e.campaign}` : ''}`,
  stage: (e) => `moved to ${e.stage}${e.actor ? ` by ${e.actor}` : ''}${e.note ? ` — ${e.note}` : ''}`,
  note: (e) => `note — ${e.text}`,
};

export function leadDetailPage({ lead, journey, saved = null, error = null, now = Date.now() }) {
  const field = (k, v) => `<dt>${esc(k)}</dt><dd dir="auto">${esc(v ?? '—')}</dd>`;
  const responded = lead.first_inbound_ts && lead.first_reply_ts ? ago(lead.first_reply_ts - lead.first_inbound_ts) : '—';

  const items = journey.map((e) => {
    const label = from(JOURNEY_LABEL, e.kind);
    return `<li><div class="when">${esc(dateTime(e.ts))} · ${esc(e.kind)}</div><div class="what" dir="auto">${esc(label ? label(e) : e.kind)}</div></li>`;
  }).join('');

  const banner = error ? `<div class="err">${esc(messageFor(error))}</div>`
    : saved ? `<div class="ok">${esc(saved === 'stage' ? 'Stage updated.' : 'Note added.')}</div>` : '';

  return layout({
    title: lead.name || lead.lead_id,
    active: '/dashboard/leads',
    body: `<h1 dir="auto">${esc(lead.name || lead.lead_id)}</h1>
<p class="sub">${esc(lead.lead_id)} · created ${esc(dateTime(lead.created))} (${esc(agoSince(now, lead.created))} ago)</p>
${banner}
<div class="grid">
  <div class="card"><h3>Contact</h3><dl class="fields">
    ${field('Phone', fullPhone(lead.phone_e164))}
    ${field('WhatsApp', lead.wa_jid ?? lead.wa_lid)}
    ${field('Language', lead.language)}
    ${field('Channel', lead.channel)}
    ${field('First reply', responded)}
  </dl></div>
  <div class="card"><h3>Attribution</h3><dl class="fields">
    ${field('Source', lead.source)}
    ${field('Medium', lead.medium)}
    ${field('Campaign', lead.campaign)}
    ${field('Campaign ID', lead.campaign_id)}
    ${field('Ref', lead.ref)}
    ${field('Match', lead.match_method)}
    ${field('Session', lead.session_id)}
    ${field('Consent (ads / analytics)', `${lead.consent_ads ? 'yes' : 'no'} / ${lead.consent_analytics ? 'yes' : 'no'}`)}
  </dl></div>
  <div class="card"><h3>Brief</h3><dl class="fields">
    ${field('Stage', `${lead.stage} · ${agoSince(now, lead.stage_ts ?? lead.created)}`)}
    ${field('Value', lead.value_sar ? money(lead.value_sar) : null)}
    ${field('Listing', lead.listing_id)}
    ${field('Interest', lead.interest)}
    ${field('Budget', lead.budget)}
    ${field('Timeline', lead.timeline)}
    ${field('District', lead.district)}
  </dl></div>
</div>

<h2>Notes</h2>
<div class="card"><p dir="auto" style="white-space:pre-wrap;margin:0">${esc(lead.notes || '—')}</p></div>

<h2>Move the lead</h2>
<form class="stack" method="post" action="/v1/admin/leads/${encodeURIComponent(lead.lead_id)}/stage">
  <input type="hidden" name="_dash" value="1">
  <div><label for="stage">Stage</label><select id="stage" name="stage">${stageOptions(lead.stage)}</select></div>
  <div><label for="value_sar">Deal value (SAR, on a win)</label><input id="value_sar" name="value_sar" inputmode="decimal" value="${esc(lead.value_sar ?? '')}"></div>
  <div><label for="stage-note">Note (optional)</label><textarea id="stage-note" name="note"></textarea></div>
  <div><button type="submit">Save stage</button></div>
</form>

<h2>Add a note</h2>
<form class="stack" method="post" action="/v1/admin/leads/${encodeURIComponent(lead.lead_id)}/note">
  <input type="hidden" name="_dash" value="1">
  <div><label for="note">Note</label><textarea id="note" name="note" required></textarea></div>
  <div><button type="submit">Add note</button></div>
</form>

<h2>Journey</h2>
${items ? `<ol class="timeline">${items}</ol>` : '<p class="muted">Nothing recorded yet.</p>'}`,
  });
}

/* ------------------------------------------------------------------ */
/* Listings                                                            */
/* ------------------------------------------------------------------ */

const FLAG_LABEL = {
  no_ad_licence: ['bad', 'no ad licence'],
  expired: ['bad', 'licence expired'],
  expiring_30d: ['warn', 'expires ≤ 30 d'],
  wafi_missing: ['bad', 'Wafi missing'],
};

export function listingsPage({ rows }) {
  const flagged = rows.filter((r) => r.flags.length).length;
  const body = rows.map((r) => `<tr>
    ${cell(r.listing_id)}${auto(r.title)}${cell(r.category ?? '—')}${cell(r.status ?? '—')}
    ${numCell(r.views)}${numCell(r.gallery)}${numCell(r.tour)}${numCell(r.brochure)}${numCell(r.wa_clicks)}${numCell(r.leads)}
    ${cell(r.licence?.adNumber ?? '—')}${cell(r.licence?.adExpiry ?? '—')}
    <td class="wrap">${r.flags.length ? r.flags.map((f) => { const l = from(FLAG_LABEL, f, ['', f]); return `<span class="tag ${esc(l[0])}">${esc(l[1])}</span>`; }).join('') : '<span class="tag ok">clear</span>'}</td>
  </tr>`);

  return layout({
    title: 'Listings',
    active: '/dashboard/listings',
    body: `<h1>Listings</h1><p class="sub">${esc(rows.length)} listings, ${esc(flagged)} with a compliance flag. Advertising a property without a valid REGA ad licence is the expensive kind of mistake.</p>
${scrollTable(
  '<th>ID</th><th>Title</th><th>Category</th><th>Status</th><th class="n">Views</th><th class="n">Gallery</th><th class="n">Tour</th><th class="n">Brochure</th><th class="n">WA clicks</th><th class="n">Leads</th><th>Ad licence</th><th>Expires</th><th>Flags</th>',
  body, 'No listings loaded.')}`,
  });
}

/* ------------------------------------------------------------------ */
/* Spend                                                               */
/* ------------------------------------------------------------------ */

export function spendPage({ rows, campaigns, saved = false, error = null, today, windowDays = 90 }) {
  const spendRows = rows.map((r) => `<tr>${cell(r.day)}${cell(r.platform)}${cell(r.campaign_id || '—')}${auto(r.campaign_name ?? '—')}` +
    `<td class="n">${esc(money(r.spend_sar))}</td>${numCell(r.clicks)}${numCell(r.impressions)}</tr>`);
  const campaignRows = campaigns.map((c) => {
    // Zero leads and "we could not tie any lead to this row" look identical in a number,
    // and they call for opposite actions: kill the campaign, or fix the UTM source.
    const unmatched = !c.leads && c.unmatched_leads
      ? `<span class="tag warn">unmatched — check the UTM source</span>`
      : '';
    return `<tr>${cell(c.platform)}${cell(c.campaign_id || '—')}${auto(c.campaign_name ?? '—')}` +
      `<td class="n">${esc(money(c.spend_sar))}</td>${numCell(c.clicks)}${numCell(c.impressions)}` +
      `<td class="n">${esc(number(c.leads))}${unmatched ? ` ${unmatched}` : ''}</td>` +
      `<td class="n">${esc(c.cpl === null ? '—' : money(c.cpl))}</td></tr>`;
  });

  const banner = error ? `<div class="err">${esc(messageFor(error))}</div>`
    : saved ? '<div class="ok">Spend saved.</div>' : '';

  return layout({
    title: 'Spend',
    active: '/dashboard/spend',
    body: `<h1>Spend</h1><p class="sub">One row per day, platform and campaign. Re-entering the same three overwrites the amount, so a corrected figure replaces the old one instead of adding to it.</p>
${banner}
<form class="row" method="post" action="/v1/admin/spend">
  <input type="hidden" name="_dash" value="1">
  <div><label for="s-day">Day</label><input id="s-day" name="day" type="date" value="${esc(today)}" required></div>
  <div><label for="s-platform">Platform</label><select id="s-platform" name="platform">${['meta', 'google', 'snapchat', 'tiktok', 'other'].map((p) => `<option>${esc(p)}</option>`).join('')}</select></div>
  <div><label for="s-cid">Campaign ID</label><input id="s-cid" name="campaign_id" placeholder="utm_id"></div>
  <div><label for="s-name">Campaign name</label><input id="s-name" name="campaign_name"></div>
  <div><label for="s-spend">Spend (SAR)</label><input id="s-spend" name="spend_sar" inputmode="decimal" required></div>
  <div><label for="s-clicks">Clicks</label><input id="s-clicks" name="clicks" inputmode="numeric" size="6"></div>
  <div><label for="s-impr">Impressions</label><input id="s-impr" name="impressions" inputmode="numeric" size="8"></div>
  <div><button type="submit">Save</button></div>
</form>

<h2>Cost per lead</h2>
${scrollTable('<th>Platform</th><th>Campaign ID</th><th>Name</th><th class="n">Spend</th><th class="n">Clicks</th><th class="n">Impressions</th><th class="n">Leads</th><th class="n">CPL</th>', campaignRows, 'No spend recorded yet.')}

<h2>Entries</h2>
<p class="sub">The last ${esc(windowDays)} days.</p>
${scrollTable('<th>Day</th><th>Platform</th><th>Campaign ID</th><th>Name</th><th class="n">Spend</th><th class="n">Clicks</th><th class="n">Impressions</th>', spendRows, 'No spend recorded in this window.')}`,
  });
}

/* ------------------------------------------------------------------ */
/* Integrations                                                        */
/* ------------------------------------------------------------------ */

const yesNo = (v) => (v ? '<span class="tag ok">present</span>' : '<span class="tag warn">missing</span>');

export const CHECKLISTS = [
  ['meta-bona-portfolio', 'Meta — portfolio, page, pixel, CAPI token'],
  ['google-bona', 'Google — GA4, Search Console, Business Profile'],
  ['snapchat-bona', 'Snapchat — ads account, pixel, CAPI'],
  ['tiktok-bona', 'TikTok — account and pixel'],
  ['aqar', 'Aqar — portal listing and export'],
  ['rega-ad-licences', 'REGA — ad licences and Wafi numbers'],
  ['pdpl', 'PDPL — NDGP registration and transfer risk'],
];
const CHECKLIST_BASE = 'https://github.com/azoz778/bona/blob/main/docs/checklists';

/**
 * What is wired up and what is still a form the owner has to fill in. Only booleans
 * about the keys — never a key, never a fragment of one.
 */
export function integrationsPage({ keys, fanout, retell, poller, lastAccepted, db }) {
  // Every input here describes a subsystem that can be down — that is the entire point
  // of the page. It must render when one of them answers with nothing, rather than
  // 500ing and taking away the one screen that would have told the owner what broke.
  const keyList = Array.isArray(keys) ? keys : [];
  const dests = fanout?.dests ?? { meta: false, ga4: false, snap: false };
  const tallies = fanout?.counts ?? { pending: null, sent: null, failed: null, skipped: null };
  const seen = lastAccepted ?? {};
  const health = db ?? { ok: false, file: null };
  const poll = poller ?? { lastRun: null, lag: null, unmatched: null };
  const keyRows = keyList.map((k) => `<tr>${cell(k.label)}<td>${yesNo(k.present)}</td>${cell(k.note ?? '')}</tr>`);
  const destRows = Object.entries(dests).map(([dest, configured]) => {
    const last = seen[dest];
    return `<tr>${cell(dest)}<td>${configured ? '<span class="tag ok">configured</span>' : '<span class="tag warn">no keys</span>'}</td>` +
      `${cell(last ? dateTime(last.ts) : '—')}${cell(last?.event_id ?? '—')}</tr>`;
  });

  const pollerBlock = poller
    ? `<div class="grid">
        ${kpi('Poller last run', poll.lastRun ? dateTime(poll.lastRun) : '—', poll.lag === null || poll.lag === undefined ? '' : `lag ${ago(poll.lag)}`)}
        ${kpi('Unmatched messages', poll.unmatched ?? '—', 'discarded in memory, never stored')}
      </div>`
    : '<p class="muted">The WhatsApp poller is not running in this process.</p>';

  return layout({
    title: 'Integrations',
    active: '/dashboard/integrations',
    body: `<h1>Integrations</h1><p class="sub">Which keys this process can see — presence only, never a value.</p>

<h2>Keys</h2>
${scrollTable('<th>Integration</th><th>Key</th><th>Note</th>', keyRows)}

<h2>Fan-out</h2>
<div class="grid">
  ${kpi('Pending', tallies.pending)}
  ${kpi('Sent', tallies.sent)}
  ${kpi('Failed', tallies.failed)}
  ${kpi('Skipped', tallies.skipped, 'no keys, or no ads consent')}
</div>
${scrollTable('<th>Destination</th><th>Status</th><th>Last accepted</th><th>Event</th>', destRows)}

<h2>Poller</h2>
${pollerBlock}

<h2>Service</h2>
<div class="grid">
  ${kpi('Retell', retell === 'ok' ? 'ok' : 'unreachable')}
  ${kpi('Store', health.ok ? 'ok' : 'error', health.file ?? '')}
</div>

<h2>Owner checklists</h2>
<ul>${CHECKLISTS.map(([slug, label]) => `<li><a href="${CHECKLIST_BASE}/${esc(slug)}.md" rel="noreferrer">${esc(label)}</a></li>`).join('')}</ul>`,
  });
}

/**
 * The one thing a GET on `/dashboard/logout` may do: offer the button. Ending the
 * session is a POST, so a link on someone else's page cannot do it for the owner.
 */
export function logoutPage() {
  return layout({
    title: 'Log out',
    chrome: false,
    body: `<div class="login"><h1>Bona</h1>
<form method="post" action="/dashboard/logout">
  <input type="hidden" name="_dash" value="1">
  <p class="muted">Log out of the dashboard on this device?</p>
  <button type="submit">Log out</button>
</form>
<p class="muted" style="margin-top:1rem"><a href="/dashboard">Stay signed in</a></p></div>`,
  });
}

/** A bare page for the handful of states that are not a dashboard page. */
export function messagePage({ title, message }) {
  return layout({ title, chrome: false, body: `<div class="login"><h1>Bona</h1><p class="muted">${esc(message)}</p><p><a href="/dashboard">Back to the dashboard</a></p></div>` });
}
