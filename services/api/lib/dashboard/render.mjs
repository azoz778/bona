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
/* ============================================================
   Bona dashboard — built on Linear's design language.

   Elevation comes from LUMINANCE STEPPING (each raised surface
   adds white opacity), not drop shadows, which are invisible
   dark-on-dark. Borders are whisper-thin semi-transparent white.
   Text is never pure white.

   No webfonts: the production CSP is default-src 'none', so an
   external font can never load. Identity is carried by weight,
   tracking and tabular numerals instead.

   Dark is the default. The light theme is a re-tune, not an
   inversion, and is switched by a checkbox + :has() — the page
   ships zero JavaScript by design.
   ============================================================ */
:root{
--l0:#0a0b0c;--l1:rgba(255,255,255,.022);--l2:rgba(255,255,255,.04);--l3:rgba(255,255,255,.06);
--panel:#101214;--bd:rgba(255,255,255,.07);--bd2:rgba(255,255,255,.11);
--t1:#f5f4f1;--t2:#c9c5bd;--t3:#8e8a82;--t4:#65625b;
--gold:#c8a96a;--gold2:#dcc189;--goldt:rgba(200,169,106,.13);
--teal:#6aa8a2;--plum:#a87f9b;--slate:#7d94a6;
--red:#e0705a;--redt:rgba(224,112,90,.13);
--green:#6fb37d;--greent:rgba(111,179,125,.13);
--amber:#d9a851;--ambert:rgba(217,168,81,.13);
--field:rgba(255,255,255,.04);
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans Arabic",sans-serif;
--tap:44px;
}
:root:has(#thm:checked){
--l0:#f6f3ed;--l1:rgba(21,24,27,.025);--l2:rgba(21,24,27,.045);--l3:rgba(21,24,27,.065);
--panel:#fffefb;--bd:rgba(21,24,27,.10);--bd2:rgba(21,24,27,.15);
--t1:#15181b;--t2:#4a463f;--t3:#6f6a61;--t4:#8e887e;
--gold:#96722f;--gold2:#a8823f;--goldt:rgba(150,114,47,.10);
--teal:#2c5f5c;--plum:#6b3f5e;--slate:#44586a;
--red:#9c2f1e;--redt:rgba(156,47,30,.08);
--green:#2c663c;--greent:rgba(44,102,60,.09);
--amber:#856012;--ambert:rgba(133,96,18,.10);
--field:#fff;
}
*{box-sizing:border-box}
/* color-scheme drives the scrollbar, the caret and form controls. Without it the
   browser keeps painting a dark scrollbar over the light theme, which is the one
   piece of chrome CSS variables cannot reach. The html background matches the app
   canvas so the overscroll gutter is not a different colour from the page. */
html{-webkit-text-size-adjust:100%;color-scheme:dark;background:var(--l0)}
:root:has(#thm:checked){color-scheme:light}
body{margin:0;background:var(--l0);color:var(--t1);
font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
/* No transition on any background that is driven by a custom property. Chrome keeps
   a transitioning background on its own composited layer and repaints it from the
   PRE-toggle variable value, so the rail stayed dark over the light theme while
   getComputedStyle reported white — a paint bug no amount of reflowing cleared.
   Only the toggle knob animates; it moves with transform, which is unaffected. */
a{color:inherit;text-decoration:none}
:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.n{font-variant-numeric:tabular-nums}
#thm{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}

/* ---- app shell: rail + main, full width, no max-width ------------- */
.app{display:grid;grid-template-columns:230px minmax(0,1fr);min-height:100vh;width:100%}
.rail{background:var(--panel);border-inline-end:1px solid var(--bd);display:flex;
flex-direction:column;padding:16px 0 14px}
.brandrow{display:flex;align-items:center;gap:10px;padding:0 16px 18px}
.mk{width:30px;height:30px;border-radius:8px;background:linear-gradient(145deg,var(--gold2),var(--gold));
color:#12100a;display:grid;place-items:center;font:600 14px/1 var(--sans)}
.brandrow b{display:block;font-size:13px;font-weight:600;letter-spacing:-.18px}
.brandrow s{display:block;text-decoration:none;font-size:10.5px;color:var(--t4);margin-top:1px}
.grp{padding:11px 16px 5px;font-size:10.5px;color:var(--t4);font-weight:600;letter-spacing:.04em}
.rail a.it{position:relative;display:flex;align-items:center;gap:9px;margin:1px 8px;padding:7px 9px;
border-radius:6px;color:var(--t2);font-size:13px;font-weight:500;letter-spacing:-.13px}
.rail a.it .i{width:14px;height:14px;flex:0 0 14px;stroke:currentColor;fill:none;stroke-width:1.6;
stroke-linecap:round;stroke-linejoin:round;opacity:.7}
.rail a.it .c{margin-inline-start:auto;font-size:11px;color:var(--t4);font-variant-numeric:tabular-nums}
.rail a.it:hover{background:var(--l1);color:var(--t1)}
.rail a.it.on{background:var(--l2);color:var(--t1)}
.rail a.it.on .i{opacity:1;color:var(--gold)}
.rail a.it.on .c{color:var(--gold)}
.railend{margin-top:auto;padding:12px 10px 0}
.me{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:7px;
background:var(--l1);border:1px solid var(--bd)}
.ava{width:26px;height:26px;border-radius:50%;background:var(--goldt);border:1px solid var(--bd2);
color:var(--gold);display:grid;place-items:center;font:600 10.5px/1 var(--sans)}
.me b{display:block;font-size:12px;font-weight:500}
.me s{display:block;text-decoration:none;font-size:10px;color:var(--t4);margin-top:1px}
.tg{display:flex;align-items:center;justify-content:space-between;margin:10px 2px 0;cursor:pointer;
user-select:none;min-height:30px}
.tg em{font-style:normal;font-size:11.5px;color:var(--t4);font-weight:500}
.trk{width:34px;height:19px;border-radius:99px;background:var(--l2);border:1px solid var(--bd);position:relative}
.knb{position:absolute;top:2px;inset-inline-start:2px;width:13px;height:13px;border-radius:50%;
background:var(--gold);transition:transform .25s cubic-bezier(.4,.1,.3,1)}
body:has(#thm:checked) .knb{transform:translateX(15px)}
.tg .lt{display:none}
body:has(#thm:checked) .tg .dk{display:none}
body:has(#thm:checked) .tg .lt{display:inline}
.railout{margin:10px 2px 0}
.railout button{width:100%;background:var(--l1);border:1px solid var(--bd);color:var(--t3);
font:inherit;font-size:11.5px;padding:7px 9px;border-radius:6px;cursor:pointer;text-align:start}
.railout button:hover{color:var(--t1);background:var(--l2)}

/* ---- top bar ------------------------------------------------------ */
.main{display:flex;flex-direction:column;min-width:0}
.bar{display:flex;align-items:center;justify-content:space-between;gap:14px;
padding:13px 22px;border-bottom:1px solid var(--bd);flex-wrap:wrap}
.bar h1{font-size:15px;font-weight:600;letter-spacing:-.2px;margin:0}
.bar .cr{font-size:12px;color:var(--t3);margin-top:1px}
.seg{display:flex;gap:2px;padding:2px;border-radius:7px;background:var(--l1);border:1px solid var(--bd)}
.seg a{padding:5px 11px;border-radius:5px;font-size:12px;font-weight:500;color:var(--t3)}
.seg a.on{background:var(--l3);color:var(--t1)}
.content{padding:18px 22px 30px;display:flex;flex-direction:column;gap:14px}

/* ---- surfaces ----------------------------------------------------- */
.card{background:var(--l1);border:1px solid var(--bd);border-radius:10px}
.cp{padding:15px 17px 16px}
.hd{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:2px}
.hd h2{font-size:13px;font-weight:600;letter-spacing:-.16px;margin:0;text-transform:none;color:var(--t1)}
.hd .s{font-size:11.5px;color:var(--t4);margin-top:2px}
.hd .r{font-size:11.5px;color:var(--t4);font-weight:500}
.muted{color:var(--t3);font-size:12.5px}
.hint{margin-top:11px;padding:9px 11px;border-radius:7px;background:var(--l1);
border:1px solid var(--bd);font-size:11.5px;color:var(--t3);line-height:1.5}
.hint b{color:var(--t1);font-weight:500}

/* ---- KPI strip ----------------------------------------------------- */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kc{padding:13px 15px;background:var(--l1);border:1px solid var(--bd);border-radius:10px}
.kc u{display:block;text-decoration:none;font-size:11px;color:var(--t4);font-weight:500}
.kc b{display:block;font-size:26px;font-weight:500;letter-spacing:-.62px;margin-top:7px;line-height:1.08;
font-variant-numeric:tabular-nums}
.kc b i{font-style:normal;font-size:12.5px;color:var(--t4);font-weight:400;margin-inline-start:3px;letter-spacing:0}
.kc .f{display:flex;align-items:center;gap:5px;margin-top:5px;font-size:11px;color:var(--t4)}
.kc b.alert{color:var(--red)}
.kc b.good{color:var(--green)}
.dl{display:inline-flex;align-items:center;gap:2px;font-weight:600;font-size:10.5px;padding:1px 5px;border-radius:4px}
.dl.u{color:var(--green);background:var(--greent)}
.dl.d{color:var(--red);background:var(--redt)}

.row2{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);gap:14px}
.row3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.stack2{display:flex;flex-direction:column;gap:14px;min-width:0}

/* ---- the queue ----------------------------------------------------- */
.lr{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:12px;align-items:center;
padding:11px 10px;margin:0 -10px;border-radius:8px;border-bottom:1px solid var(--bd)}
.lr:last-of-type{border-bottom:0}
.lr.urgent{background:var(--redt)}
.lr .av2{width:28px;height:28px;border-radius:50%;background:var(--l3);border:1px solid var(--bd);
display:grid;place-items:center;font:600 11px/1 var(--sans);color:var(--t2)}
.lr.urgent .av2{border-color:var(--red);color:var(--red)}
.l1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.l1 .nm{font-size:13.5px;font-weight:600;letter-spacing:-.14px;min-width:0;overflow-wrap:anywhere}
.l1 .nm span{unicode-bidi:isolate}
.pl{font-size:10.5px;font-weight:500;padding:1px 6px;border-radius:99px;border:1px solid var(--bd);
color:var(--t3);max-width:100%;overflow-wrap:anywhere}
.pl.hot{background:var(--redt);color:var(--red);border-color:transparent}
.pl.warm{background:var(--ambert);color:var(--amber);border-color:transparent}
.pl.gold{background:var(--goldt);color:var(--gold);border-color:transparent}
.pl.mon{background:var(--greent);color:var(--green);border-color:transparent;font-variant-numeric:tabular-nums}
.pl.done{background:var(--l2);color:var(--t3);border-color:transparent}
.l2{margin-top:3px;font-size:11.5px;color:var(--t4);display:flex;gap:7px;align-items:center;
flex-wrap:wrap;overflow-wrap:anywhere}
.l2 .tel{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums}
.acts{display:flex;align-items:center;gap:6px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:var(--tap);
padding:0 12px;border-radius:6px;font-size:12px;font-weight:500;
background:var(--l3);border:1px solid var(--bd);color:var(--t1);white-space:nowrap}
.btn.pri{background:var(--gold);border-color:var(--gold);color:#12100a}
.btn.pri:hover{background:var(--gold2)}
.btn svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ib{display:inline-grid;place-items:center;width:var(--tap);min-height:var(--tap);border-radius:6px;
background:var(--l3);border:1px solid var(--bd)}
.ib svg{width:13px;height:13px;stroke:var(--t2);fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.allclear{display:flex;flex-direction:column;gap:4px;padding:20px 16px;border-radius:9px;
background:var(--greent);border:1px solid var(--bd);margin-top:12px}
.allclear b{font-size:15px;font-weight:600;color:var(--green)}
.allclear span{font-size:12.5px;color:var(--t3)}

/* ---- chart --------------------------------------------------------- */
.plot{flex:1 1 auto;display:flex;flex-direction:column;justify-content:center;min-height:0}
.plot svg{display:block;width:100%;height:100%;min-height:150px;margin-top:9px}
.ax{display:flex;justify-content:space-between;margin-top:5px;font-size:10.5px;color:var(--t4)}
.lg{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;margin-top:11px;font-size:11.5px}
.lg span{display:flex;align-items:center;gap:7px;color:var(--t2)}
.lg i{width:7px;height:7px;border-radius:2px;flex:0 0 7px}
.lg em{margin-inline-start:auto;font-style:normal;font-weight:600;color:var(--t1);font-variant-numeric:tabular-nums}
.mix{display:flex;height:9px;border-radius:99px;overflow:hidden;margin-top:12px;background:var(--l2)}
.mix i{height:100%}

/* ---- metric rows / funnel ------------------------------------------ */
.mr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;
border-bottom:1px solid var(--bd);font-size:12.5px}
.mr:last-of-type{border-bottom:0}
.mr .k{color:var(--t2);display:flex;align-items:center;gap:8px;min-width:0;overflow-wrap:anywhere}
.mr .v{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.mr .v s{text-decoration:none;font-weight:400;color:var(--t4);font-size:11px;margin-inline-start:5px}
.sq{width:8px;height:8px;border-radius:2.5px;flex:0 0 8px;display:inline-block}
.fn{display:grid;gap:7px;margin-top:11px}
.fr{display:grid;grid-template-columns:104px minmax(0,1fr) 48px;gap:10px;align-items:center;font-size:12px}
.fr .k{color:var(--t2)}
.fr .t{height:20px;border-radius:4px;background:var(--l2);overflow:hidden;position:relative}
.fr .t i{display:block;height:100%;background:linear-gradient(90deg,var(--gold),var(--gold2));border-radius:4px}
.fr .t em{position:absolute;inset-inline-start:7px;top:0;line-height:20px;font-style:normal;
font-size:11px;font-weight:600;color:#12100a}
.fr .t.zero em{color:var(--t3)}
.fr .p{text-align:end;color:var(--t4);font-variant-numeric:tabular-nums;font-size:11.5px}

/* ---- tables --------------------------------------------------------- */
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12.5px}
th{text-align:start;font-size:11px;color:var(--t4);font-weight:500;padding:0 8px 8px 0;
border-bottom:1px solid var(--bd);white-space:nowrap}
td{padding:9px 8px 9px 0;border-bottom:1px solid var(--bd);vertical-align:middle}
tr:last-child td{border-bottom:0}
th.n,td.n{text-align:end;padding-inline-end:0;font-variant-numeric:tabular-nums}
td.wrap{white-space:normal;min-width:12rem}
tbody tr:hover{background:var(--l1)}
.sc{display:flex;align-items:center;gap:8px;min-width:0}
.sc b{font-weight:500;font-size:12.5px;display:block;overflow-wrap:anywhere}
.sc s{text-decoration:none;display:block;font-size:10.5px;color:var(--t4);margin-top:1px;overflow-wrap:anywhere}
.mb{display:block;width:100%;height:5px;border-radius:99px;background:var(--l2);overflow:hidden}
.mb i{display:block;height:100%;border-radius:99px}
td.n b{font-weight:600}
td.n s{text-decoration:none;display:block;font-size:10.5px;color:var(--t4);margin-top:1px}

/* ---- legacy component classes, retuned to the same tokens ---------- */
h1{font-size:19px;font-weight:600;letter-spacing:-.3px;margin:0 0 4px}
h2{font-size:13px;font-weight:600;letter-spacing:-.16px;color:var(--t1);margin:6px 0 8px;text-transform:none}
h3{font-size:12.5px;font-weight:600;margin:0 0 4px}
p.sub{color:var(--t3);font-size:12.5px;margin:0 0 12px}
.rule{border:0;border-top:1px solid var(--bd);margin:18px 0}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))}
.kpi{background:var(--l1);border:1px solid var(--bd);border-radius:10px;padding:13px 15px}
.kpi .k{font-size:11px;color:var(--t4);font-weight:500;margin-bottom:6px}
.kpi .v{font-size:22px;font-weight:500;letter-spacing:-.4px;font-variant-numeric:tabular-nums}
.kpi .note{font-size:11px;color:var(--t4);margin-top:4px}
.tag{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:99px;border:1px solid var(--bd);
color:var(--t3);margin:0 .2rem .2rem 0}
.tag.bad{background:var(--redt);color:var(--red);border-color:transparent}
.tag.warn{background:var(--ambert);color:var(--amber);border-color:transparent}
.tag.ok{background:var(--greent);color:var(--green);border-color:transparent}
.err{border:1px solid var(--bd);background:var(--redt);color:var(--red);padding:10px 12px;
border-radius:8px;margin-bottom:12px;font-size:12.5px}
.ok{border:1px solid var(--bd);background:var(--greent);color:var(--green);padding:10px 12px;
border-radius:8px;margin-bottom:12px;font-size:12.5px}
.chips{margin-top:8px;display:flex;flex-wrap:wrap;gap:5px}
.chip{font-size:10.5px;padding:1px 6px;border-radius:99px;border:1px solid var(--bd);color:var(--t3);
max-width:100%;overflow-wrap:anywhere}
.chip.paid{background:var(--goldt);color:var(--gold);border-color:transparent}
.chip.money{background:var(--greent);color:var(--green);border-color:transparent;font-variant-numeric:tabular-nums}
.leadcard{background:var(--l1);border:1px solid var(--bd);border-radius:10px;margin-bottom:10px;overflow:hidden}
.leadcard.hot{border-inline-start:3px solid var(--red)}
.leadcard.warm{border-inline-start:3px solid var(--gold)}
.leadcard.cool{border-inline-start:3px solid var(--bd2)}
.leadcard .body{display:block;padding:12px 14px}
a.body:hover{background:var(--l2)}
.leadcard .l1{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.leadcard .who{font-size:14px;font-weight:600;min-width:0;overflow-wrap:anywhere}
.leadcard .tel{font-size:12px;color:var(--t3);font-variant-numeric:tabular-nums;
unicode-bidi:isolate;direction:ltr;display:inline-block;margin-top:3px}
.leadcard .l2{margin-top:3px;font-size:12px;color:var(--t3);overflow-wrap:anywhere}
.leadcard .l3{margin-top:5px;font-size:11.5px;color:var(--t4)}
.leadcard.hot .l3{color:var(--red)}
.wait{flex:0 0 auto;font-size:10.5px;font-weight:600;white-space:nowrap;padding:2px 7px;border-radius:99px;
border:1px solid var(--bd);color:var(--t3)}
.wait.hot{background:var(--redt);color:var(--red);border-color:transparent}
.wait.warm{background:var(--ambert);color:var(--amber);border-color:transparent}
.wait.done{background:var(--l2);color:var(--t3);border-color:transparent}
.leadcard .acts{display:flex;border-top:1px solid var(--bd)}
.leadcard .acts .act{flex:1 1 0;min-height:var(--tap);display:flex;align-items:center;justify-content:center;
font-size:12.5px;font-weight:500;color:var(--t1);border-inline-end:1px solid var(--bd)}
.leadcard .acts .act:last-child{border-inline-end:0}
.leadcard .acts .act:hover{background:var(--l2)}
.leadcard .acts .act.wa{color:var(--green)}
.leadcard .acts .act.open{color:var(--t3);font-weight:400}
.leadcard .acts .act.off{color:var(--t4);font-style:italic;cursor:default}
.stagerail{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 6px;scrollbar-width:none}
.stagerail::-webkit-scrollbar{display:none}
.stagerail a{flex:0 0 auto;min-width:5.4rem;background:var(--l1);border:1px solid var(--bd);
border-radius:9px;padding:9px 12px}
.stagerail a.on{border-color:var(--gold)}
.stagerail a:hover{background:var(--l2)}
.stagerail b{display:block;font-size:19px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.stagerail span{display:block;font-size:11px;color:var(--t4);margin-top:3px}
.stagerail a.win b{color:var(--green)}
.stagerail a.all b{color:var(--t3)}
.railnote{font-size:12px;color:var(--t4);margin:8px 0 14px}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:12px}
.strip .cellv{background:var(--l1);border:1px solid var(--bd);border-radius:10px;padding:13px 15px}
.strip .cellv small{display:block;font-size:11px;color:var(--t4);font-weight:500;margin-bottom:6px}
.strip .cellv b{display:block;font-size:22px;font-weight:500;letter-spacing:-.4px;font-variant-numeric:tabular-nums}
.strip .cellv i{display:block;font-style:normal;font-size:11px;color:var(--t4);margin-top:4px}
details.more{border-top:1px solid var(--bd);margin-top:14px}
details.more>summary{min-height:var(--tap);display:flex;align-items:center;cursor:pointer;
font-size:12.5px;color:var(--t2);font-weight:500;list-style:none;padding:6px 0}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary::after{content:"+";margin-inline-start:8px;font-size:15px;line-height:1;color:var(--t4)}
details.more[open]>summary::after{content:"\u2212"}
details.more>.inner{padding-bottom:12px}
.charts{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))}
.chart{background:var(--l1);border:1px solid var(--bd);border-radius:10px;padding:12px 14px}
.chart .k{font-size:11px;color:var(--t4);display:flex;justify-content:space-between;gap:8px;margin-bottom:6px}
.chart svg{display:block;width:100%;height:auto}
ol.timeline{list-style:none;margin:0;padding:0}
ol.timeline li{border-inline-start:2px solid var(--bd);padding:0 0 12px;padding-inline-start:14px;margin-inline-start:4px}
ol.timeline .when{font-size:11px;color:var(--t4);font-variant-numeric:tabular-nums}
ol.timeline .what{font-size:12.5px}
dl.fields{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0;font-size:12.5px}
dl.fields dt{color:var(--t4);font-size:11px;padding-top:2px}
dl.fields dd{margin:0;overflow-wrap:anywhere}
form.filters{display:grid;grid-template-columns:2fr 1fr auto;gap:10px;margin:0 0 14px;align-items:end}
form.stack{display:grid;gap:10px;max-width:34rem}
form.row{display:flex;flex-wrap:wrap;gap:10px;align-items:end}
form.row input,form.row select,form.row button{width:auto}
form.filters .go label{visibility:hidden}
label{display:block;font-size:11px;color:var(--t4);margin-bottom:5px}
input,select,textarea,button{font:inherit;font-size:13px;color:var(--t1);background:var(--field);
border:1px solid var(--bd);border-radius:7px;padding:9px 10px;min-height:var(--tap);width:100%}
input:focus,select:focus,textarea:focus{outline:2px solid var(--gold);outline-offset:-2px}
textarea{min-height:6rem;resize:vertical}
button{background:var(--gold);color:#12100a;border-color:var(--gold);cursor:pointer;
font-weight:600;font-size:12.5px;padding:9px 16px;width:auto}
button:hover{background:var(--gold2)}
.login{max-width:23rem;margin:10vh auto;padding:0 20px}
.login h1{text-align:center;margin-bottom:18px;font-size:15px}
.login form{display:grid;gap:12px}
.login .code{font-size:22px;letter-spacing:.35em;text-align:center;font-variant-numeric:tabular-nums}
footer{color:var(--t4);font-size:11.5px;padding:22px 0 6px;text-align:center}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--t2);
background:var(--l2);padding:1px 5px;border-radius:4px}

/* ---- narrow: the rail becomes a top strip, content stacks ---------- */
@media (max-width:1100px){
  .row2,.row3{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:860px){
  .app{grid-template-columns:minmax(0,1fr)}
  .rail{flex-direction:row;flex-wrap:wrap;align-items:center;gap:2px;padding:10px 12px;
  border-inline-end:0;border-bottom:1px solid var(--bd)}
  .brandrow{padding:0 10px 0 0}
  .grp{display:none}
  .rail a.it{margin:0;padding:8px 10px;min-height:var(--tap)}
  .rail a.it .c{margin-inline-start:6px}
  .railend{margin-top:0;padding:0;margin-inline-start:auto;display:flex;align-items:center;gap:10px}
  .railout{margin:0}
  .tg{margin:0}
  .me{display:none}
  .content{padding:14px 14px 26px}
  .bar{padding:12px 14px}
  .lr{grid-template-columns:30px minmax(0,1fr);row-gap:8px}
  .lr .acts{grid-column:1/-1}
  .lr .acts .btn{flex:1 1 auto}
  form.filters{grid-template-columns:minmax(0,1fr)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`.trim();

/**
 * One page. `chrome:false` drops the nav (the login page has nowhere to go).
 */
export const NAV = [
  ['/dashboard', 'Desk', '<path d="M2 8h3l1.8-4.4L9.2 12l1.7-4H14"/>', 'Workspace'],
  ['/dashboard/leads', 'Leads', '<circle cx="8" cy="5.4" r="2.5"/><path d="M2.8 13.8c0-2.9 2.3-4.5 5.2-4.5s5.2 1.6 5.2 4.5"/>', 'Workspace'],
  ['/dashboard/listings', 'Listings', '<path d="M2.3 6.8 8 2.2l5.7 4.6v7H2.3z"/><path d="M6.3 13.8V9.3h3.4v4.5"/>', 'Workspace'],
  ['/dashboard/spend', 'Spend', '<path d="M8 1.8v12.4M11.2 4.3H6.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H4.4"/>', 'Marketing'],
  ['/dashboard/integrations', 'Setup', '<circle cx="8" cy="8" r="2"/><path d="M8 2v2.2M8 11.8V14M14 8h-2.2M4.2 8H2"/>', 'System'],
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

export function layout({ title, body, active = null, chrome = true, counts = {}, subtitle = null, actions = '' }) {
  // Each rail item is drawn inline: the CSP is `default-src 'none'`, so an icon font
  // or a sprite sheet from anywhere — including our own /img — is one more thing that
  // can fail to load. An inline path cannot.
  const items = NAV.map(([href, label, icon, group]) => {
    const c = counts && Object.hasOwn(counts, href) && Number.isFinite(Number(counts[href]))
      ? `<span class="c">${esc(number(counts[href]))}</span>` : '';
    return { group, html: `<a class="it${href === active ? ' on' : ''}" href="${esc(href)}"` +
      `${href === active ? ' aria-current="page"' : ''}><svg class="i" viewBox="0 0 16 16" aria-hidden="true">${icon}</svg>${esc(label)}${c}</a>` };
  });
  const groups = [];
  for (const it of items) {
    const last = groups[groups.length - 1];
    if (last && last.name === it.group) last.html.push(it.html);
    else groups.push({ name: it.group, html: [it.html] });
  }
  const rail = groups.map((g) => `<div class="grp">${esc(g.name)}</div>${g.html.join('')}`).join('');

  const nav = chrome
    ? `<div class="rail">
  <div class="brandrow"><span class="mk" aria-hidden="true">B</span><span><b>Bona</b><s>Jeddah · Brokerage</s></span></div>
  ${rail}
  <div class="railend">
    <div class="me"><span class="ava" aria-hidden="true">AA</span><span><b>Abdulaziz</b><s>Principal</s></span></div>
    <label class="tg" for="thm"><em><span class="dk">Dark</span><span class="lt">Light</span></em><span class="trk" aria-hidden="true"><span class="knb"></span></span></label>
    <div class="railout"><form method="post" action="/dashboard/logout"><input type="hidden" name="_dash" value="1"><button type="submit">Log out</button></form></div>
  </div>
</div>`
    : '';

  const head = chrome
    ? `<div class="bar"><div><h1>${esc(title)}</h1>${subtitle ? `<div class="cr">${esc(subtitle)}</div>` : ''}</div>${actions}</div>`
    : '';

  return `<!doctype html>
<html lang="en" translate="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, notranslate">
<meta name="google" content="notranslate">
<meta name="theme-color" content="#0a0b0c">
<title>${esc(title)} · Bona</title>
<style>${STYLE}</style>
</head>
<body>
<input type="checkbox" id="thm" aria-label="Light theme">
${chrome ? `<div class="app">${nav}<div class="main">${head}<div class="content">${body}</div></div></div>` : body}
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
/**
 * A smooth area chart, drawn server-side. Two series on one grid: the solid gold one
 * is the primary, the dashed one the comparison. Points are spaced evenly across the
 * viewBox and a flat series still draws a line — an empty chart and a zero chart must
 * not look the same.
 *
 * `preserveAspectRatio="none"` lets the card decide the height; the stroke is drawn in
 * a nested untransformed group so it does not get stretched with it.
 */
export function area(seriesA, seriesB, { labels = [] } = {}) {
  const W = 460;
  const H = 150;
  const PAD = 6;
  const a = (Array.isArray(seriesA) ? seriesA : []).map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
  const b = (Array.isArray(seriesB) ? seriesB : []).map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
  const n = Math.max(a.length, b.length);
  if (!n) return '<p class="muted">Nothing recorded in this window yet.</p>';

  const max = Math.max(1, ...a, ...b);
  const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v) => H - PAD - (v / max) * (H - PAD * 2);
  const path = (list) => list.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const grid = [0.25, 0.5, 0.75, 1].map((f) =>
    `<line x1="0" y1="${(H * f).toFixed(1)}" x2="${W}" y2="${(H * f).toFixed(1)}"/>`).join('');

  const fill = a.length
    ? `<path d="${path(a)} L${x(a.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z" style="fill:var(--goldt)"/>`
    : '';
  const lineA = a.length
    ? `<path d="${path(a)}" fill="none" style="stroke:var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';
  const lineB = b.length
    ? `<path d="${path(b)}" fill="none" style="stroke:var(--teal)" stroke-width="1.7" stroke-dasharray="4 4" stroke-linecap="round"/>`
    : '';
  const dot = a.length
    ? `<circle cx="${x(a.length - 1).toFixed(1)}" cy="${y(a[a.length - 1]).toFixed(1)}" r="3.4" style="fill:var(--gold);stroke:var(--l0)" stroke-width="2"/>`
    : '';

  const ticks = labels.length
    ? `<div class="ax">${labels.map((l) => `<span>${esc(l)}</span>`).join('')}</div>`
    : '';

  return `<div class="plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Enquiries and viewings over time">
<g style="stroke:var(--bd)" stroke-width="1">${grid}</g>${fill}${lineA}${lineB}${dot}
</svg></div>${ticks}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `26 h` / `1.4 d` from a median age in hours, or an em-dash. */
/**
 * A reply time a human can read. The raw stat is minutes with one decimal, which is
 * right for 14 min and absurd for 344.2 min — nobody thinks in 344 minutes. Anything
 * from an hour and a half up is re-expressed in hours, and past two days, in days.
 * Returns the pair so the unit can be styled separately from the number.
 */
export function minutesReadable(minutes) {
  // Guard the RAW value before coercion: Number(null) is 0, which is finite, so a
  // missing stat would render a confident "0 min" — the same null-is-zero trap that
  // once printed a 20,000-day wait on a lead card.
  if (minutes === null || minutes === undefined || minutes === '') return null;
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) return null;
  if (m < 90) return [`${Math.round(m * 10) / 10}`, 'min'];
  const h = m / 60;
  if (h < 48) return [`${Math.round(h * 10) / 10}`, h === 1 ? 'hour' : 'hours'];
  const d = h / 24;
  return [`${Math.round(d * 10) / 10}`, d === 1 ? 'day' : 'days'];
}

const round1h = (hours) => {
  const h = Number(hours);
  if (!Number.isFinite(h)) return '—';
  return h >= 48 ? `${Math.round(h / 24)} d` : `${Math.round(h)} h`;
};

const ICON_WA = '<path d="M2.4 13.6 3.3 10a5.6 5.6 0 1 1 2.1 2.1z"/>';
const ICON_TEL = '<path d="M5.2 2.6 6.9 6 5.4 7.5a8 8 0 0 0 3.1 3.1L10 9.1l3.4 1.7v2c0 .6-.5 1.1-1.1 1A11 11 0 0 1 2.2 3.7c-.1-.6.4-1.1 1-1.1z"/>';

/**
 * One waiting lead as a Desk row: who, how long, and the two taps that matter.
 *
 * Both actions are plain links, so they work with script disabled, under a CSP of
 * `default-src 'none'`, and on a lock-screened phone. `wa.me` takes bare digits and
 * `tel:` takes E.164 — both are rebuilt from `/\D/`-stripped digits before printing,
 * so neither can carry markup. Names and districts are Arabic as often as not, so
 * every element that can hold one carries `dir="auto"` on an INLINE span: putting it
 * on the block would right-align the whole row and look broken beside a Latin name.
 */
export function leadRow(lead, now) {
  const st = waitState(lead, now);
  const wa = waHref(lead.phone_e164);
  const tel = telHref(lead.phone_e164);
  const href = `/dashboard/leads/${encodeURIComponent(lead.lead_id)}`;

  const name = String(lead.name ?? '').trim();
  const initial = name ? [...name][0] : '·';

  const badge = st.waiting && st.ms !== null
    ? `<span class="pl ${esc(st.tone)}">${esc(ago(st.ms))}</span>`
    : `<span class="pl done">${esc(stageName(lead.stage))}</span>`;

  const paid = typeof lead.medium === 'string' && /^(cpc|ppc|paid|paid_social|display|ads?)$/i.test(lead.medium);
  const chips = [
    lead.value_sar ? `<span class="pl mon">${esc(money(lead.value_sar))}</span>` : '',
    lead.campaign ? `<span class="pl${paid ? ' gold' : ''}" dir="auto">${esc(lead.campaign)}</span>` : '',
    lead.listing_id ? `<span class="pl" dir="auto">${esc(lead.listing_id)}</span>` : '',
  ].join('');

  const meta = metaLine(lead.district, lead.source, lead.interest);

  const acts = `<div class="acts">` +
    (wa ? `<a class="btn pri" href="${esc(wa)}" rel="noreferrer"><svg viewBox="0 0 16 16" aria-hidden="true">${ICON_WA}</svg>WhatsApp</a>` : '') +
    (tel ? `<a class="ib" href="${esc(tel)}" aria-label="Call"><svg viewBox="0 0 16 16" aria-hidden="true">${ICON_TEL}</svg></a>` : '') +
    `<a class="ib" href="${esc(href)}" aria-label="Open record"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none"/></svg></a></div>`;

  return `<div class="lr${st.tone === 'hot' ? ' urgent' : ''}">
  <span class="av2" aria-hidden="true"><span dir="auto">${esc(initial)}</span></span>
  <div>
    <div class="l1"><span class="nm"><a href="${esc(href)}"><span dir="auto">${esc(name || 'Unnamed')}</span></a></span>${badge}${chips}</div>
    <div class="l2"><span class="tel">${esc(maskPhone(lead.phone_e164))}</span>${meta ? `<span>·</span><span dir="auto">${esc(meta)}</span>` : ''}</div>
  </div>
  ${acts}
</div>`;
}

export function overviewPage({
  daily, sources, matchQuality, responseTimes, pipeline, days,
  waiting = [], waitingTotal = null, now = Date.now(),
}) {
  // Each of these is a separate query wrapped in its own try/catch in the route, so any
  // one of them can legitimately arrive as null after a failure. A default parameter
  // only fires on `undefined`, so an explicit null sails past it — normalise instead.
  // The Desk is the page the owner opens first; a single failed aggregate must degrade
  // one card, never 500 the whole screen.
  const days14 = Array.isArray(daily) ? daily : [];
  const sourceList = Array.isArray(sources) ? sources : [];
  const matchList = Array.isArray(matchQuality) ? matchQuality : [];
  const replies = responseTimes ?? { median_min: null, p90_min: null, count: 0 };
  const queueIn = Array.isArray(waiting) ? waiting : [];

  /* ---- the queue: the reason this page exists ---------------------- */
  const queue = [...queueIn].sort(byUrgency(now)).filter((l) => waitState(l, now).waiting);
  const shown = queue.slice(0, 6);
  const oldest = queue.length ? waitState(queue[0], now).ms : null;
  const overnight = queue.filter((l) => (waitState(l, now).ms ?? 0) >= 86_400_000).length;

  // `waiting` is a CAPPED slice (the route asks for 50). Showing its length as the
  // headline would tell the owner he has 50 people waiting when he has 400 — the same
  // "count the slice, not the set" bug the stage rail exists to avoid. `waitingTotal`
  // is a real COUNT(*); fall back to the slice only when it is absent.
  const total = Number(waitingTotal);
  const trueWaiting = Number.isFinite(total) ? Math.max(total, queue.length) : queue.length;
  const rest = trueWaiting - shown.length;

  const queueBlock = trueWaiting
    ? shown.map((l) => leadRow(l, now)).join('') +
      (rest > 0 ? `<p class="muted" style="margin-top:12px">${esc(number(rest))} more waiting — <a href="/dashboard/leads">open the full list</a>.</p>` : '')
    : `<div class="allclear"><b>All caught up</b><span>Every lead has had a reply. Nothing needs you right now.</span></div>`;

  /* ---- pipeline, honest about empty stages ------------------------- */
  const counts = new Map((pipeline ?? []).map((p) => [p.stage, Number(p.count) || 0]));
  const live = STAGES.filter((s) => (counts.get(s) ?? 0) > 0);
  const empty = STAGES.filter((s) => (counts.get(s) ?? 0) <= 0);
  const openLeads = STAGES.filter((s) => !CLOSED.has(s)).reduce((a, s) => a + (counts.get(s) ?? 0), 0);
  const allLeads = STAGES.reduce((a, s) => a + (counts.get(s) ?? 0), 0);

  const pipeRows = live.map((s) => {
    const c = counts.get(s) ?? 0;
    const age = (pipeline ?? []).find((p) => p.stage === s)?.median_age_h;
    const aged = Number.isFinite(Number(age)) ? `<s>${esc(round1h(age))}</s>` : '';
    return `<div class="mr"><a class="k" href="/dashboard/leads?stage=${encodeURIComponent(s)}">` +
      `<i class="sq" style="background:var(--${s === 'won' ? 'green' : s === 'lost' ? 't4' : 'gold'})"></i>${esc(stageName(s))}</a>` +
      `<span class="v"${s === 'won' ? ' style="color:var(--green)"' : ''}>${esc(number(c))}${aged}</span></div>`;
  }).join('');

  const pipeBlock = live.length
    ? pipeRows + (empty.length
      ? `<div class="hint">A boutique book stays thin — <b>${esc(listWords(empty.map(stageName).map((x) => x.toLowerCase())))}</b> ${empty.length === 1 ? 'is' : 'are'} empty right now.</div>`
      : '')
    : `<p class="muted">No leads in the pipeline yet.</p>`;

  /* ---- the window ------------------------------------------------- */
  const sum = (key) => days14.reduce((a, d) => a + (Number(d[key]) || 0), 0);
  const waClicks = sum('wa_clicks');
  const winLeads = sum('leads');
  const winViewings = sum('viewings');
  const winSessions = sum('sessions');

  const dayLabel = (d) => {
    const s = String(d ?? '');
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1] ?? ''}`.trim() : s;
  };
  const ticks = days14.length
    ? [0, Math.floor((days14.length - 1) / 3), Math.floor(((days14.length - 1) * 2) / 3), days14.length - 1]
      .filter((v, i, arr) => arr.indexOf(v) === i).map((i) => dayLabel(days14[i]?.day))
    : [];

  const chart = area(days14.map((d) => d.leads), days14.map((d) => d.viewings), { labels: ticks });

  /* ---- speed ------------------------------------------------------- */
  const medianReply = replies.median_min === null || !replies.count ? null : minutesReadable(replies.median_min);
  const p90Reply = minutesReadable(replies.p90_min);

  /* ---- channels ---------------------------------------------------- */
  const SWATCH = ['--gold', '--teal', '--green', '--plum', '--slate', '--amber', '--t4', '--bd2'];
  const chanTotal = sourceList.reduce((a, s) => a + (Number(s.last_touch_leads) || 0), 0);
  const topLeads = Math.max(1, ...sourceList.map((s) => Number(s.last_touch_leads) || 0));

  const sourceRows = sourceList.map((s, i) => {
    const colour = `var(${SWATCH[i % SWATCH.length]})`;
    const leads = Number(s.last_touch_leads) || 0;
    const share = chanTotal ? `${Math.round((leads / chanTotal) * 100)}%` : '—';
    const detail = metaLine(s.medium && s.medium !== '(none)' ? s.medium : null, s.campaign, s.campaign_id);
    return `<tr>
    <td data-label="Channel" class="wrap"><div class="sc"><i class="sq" style="background:${colour}"></i>` +
      `<span><b dir="auto">${esc(s.source ?? '(direct)')}</b>${detail ? `<s dir="auto">${esc(detail)}</s>` : ''}</span></div></td>
    <td data-label="Share" style="width:14%"><span class="mb"><i style="width:${Math.max(4, Math.round((leads / topLeads) * 100))}%;background:${colour}"></i></span></td>
    <td data-label="Leads" class="n"><b>${esc(number(leads))}</b><s>${esc(share)}</s></td>
    <td data-label="First touch" class="n"><b>${esc(number(s.first_touch_leads))}</b></td>
    <td data-label="WA clicks" class="n"><b>${esc(number(s.wa_clicks))}</b></td>
    <td data-label="Spend" class="n"><b>${esc(s.spend_sar ? money(s.spend_sar) : '—')}</b></td>
    <td data-label="Cost / lead" class="n"><b>${esc(s.cpl === null || s.cpl === undefined ? '—' : money(s.cpl))}</b></td>
  </tr>`;
  });

  const mix = sourceList.filter((s) => (Number(s.last_touch_leads) || 0) > 0).map((s, i) =>
    `<i style="width:${((Number(s.last_touch_leads) || 0) / (chanTotal || 1)) * 100}%;background:var(${SWATCH[i % SWATCH.length]})"></i>`).join('');
  const mixLegend = sourceList.filter((s) => (Number(s.last_touch_leads) || 0) > 0).map((s, i) =>
    `<span><i style="background:var(${SWATCH[i % SWATCH.length]})"></i><span dir="auto">${esc(s.source ?? '(direct)')}</span><em>${esc(number(s.last_touch_leads))}</em></span>`).join('');

  /* ---- attribution quality ----------------------------------------- */
  const matchTotal = matchList.reduce((a, m) => a + (Number(m.count) || 0), 0);
  const MATCH_TONE = { click_id: ['--green', 'certain'], keyword: ['--teal', 'matched on wording'], time_window: ['--amber', 'inferred'], manual: ['--t4', 'entered by hand'] };
  const matchRows = matchList.map((m) => {
    const [colour, note] = from(MATCH_TONE, m.match_method, ['--t4', '']);
    const c = Number(m.count) || 0;
    return `<div class="mr"><span class="k"><i class="sq" style="background:var(${colour})"></i>` +
      `${esc(m.match_method)}${note ? ` — ${esc(note)}` : ''}</span>` +
      `<span class="v">${esc(number(c))}<s>${esc(matchTotal ? `${Math.round((c / matchTotal) * 100)}%` : '—')}</s></span></div>`;
  }).join('');
  const inferred = matchList.filter((m) => m.match_method === 'time_window').reduce((a, m) => a + (Number(m.count) || 0), 0);

  /* ---- funnel ------------------------------------------------------ */
  // Only a funnel when the stages actually nest. Leads that arrive straight into
  // WhatsApp from an ad never touched the site, so `leads` can legitimately exceed
  // `wa_clicks` — drawing that as a funnel would show a 500% conversion rate and be
  // read as a bug in the tracking rather than a fact about the channel.
  const nests = waClicks >= winLeads && winLeads >= winViewings;
  const funnelRows = [
    ['WhatsApp clicks · site', waClicks],
    ['Became a lead', winLeads],
    ['Viewing booked', winViewings],
  ];
  const funnelTop = Math.max(1, ...funnelRows.map(([, v]) => v));
  const funnel = funnelRows.map(([label, v]) =>
    `<div class="fr"><span class="k">${esc(label)}</span>` +
    `<span class="t${v ? '' : ' zero'}"><i style="width:${v ? Math.max(3, (v / funnelTop) * 100) : 0}%"></i><em>${esc(number(v))}</em></span>` +
    `<span class="p">${esc(nests && funnelTop ? `${Math.round((v / funnelTop) * 100)}%` : '')}</span></div>`).join('');

  const seg = ['7', '14', '30', '90'].map((d) =>
    `<a${String(days) === d ? ' class="on"' : ''} href="/dashboard?days=${d}">${d} days</a>`).join('');

  const body = `<div class="kpis">
  <div class="kc"><u>Waiting on you</u><b class="${trueWaiting ? 'alert' : 'good'}"><span class="n">${esc(trueWaiting)}</span></b>
    <div class="f">${trueWaiting ? `longest ${esc(ago(oldest))}${overnight ? ` · ${esc(overnight)} over a day` : ''}` : 'everyone has had a reply'}</div></div>
  <div class="kc"><u>Median first reply</u><b class="n">${medianReply === null ? '—' : `${esc(medianReply[0])}<i>${esc(medianReply[1])}</i>`}</b>
    <div class="f">${replies.count ? `across ${esc(number(replies.count))} leads` : 'nothing measured yet'}</div></div>
  <div class="kc"><u>Open leads</u><b class="n">${esc(number(openLeads))}</b><div class="f">${esc(number(allLeads))} in the book</div></div>
  <div class="kc"><u>Leads · ${esc(days)} d</u><b class="n">${esc(number(winLeads))}</b><div class="f">${esc(number(winViewings))} reached a viewing</div></div>
  <div class="kc"><u>WhatsApp clicks · ${esc(days)} d</u><b class="n">${esc(number(waClicks))}</b>
    <div class="f">${waClicks && winLeads <= waClicks
      ? `${esc(Math.round((winLeads / waClicks) * 100))}% became a lead`
      : waClicks ? 'most leads arrive off-site' : 'no taps on the site'}</div></div>
  <div class="kc"><u>Sessions · ${esc(days)} d</u><b class="n">${esc(number(winSessions))}</b><div class="f">visits to the site</div></div>
</div>

<div class="row2">
  <div class="card cp">
    <div class="hd"><div><h2>Needs a reply</h2><div class="s">Oldest first — reply before a rival broker does</div></div>
      <a class="r" href="/dashboard/leads">All ${esc(number(allLeads))} →</a></div>
    ${queueBlock}
  </div>

  <div class="card cp" style="display:flex;flex-direction:column">
    <div class="hd"><div><h2>Leads &amp; viewings</h2><div class="s">Last ${esc(days)} days</div></div></div>
    ${chart}
    <div class="lg"><span><i style="background:var(--gold)"></i>Leads<em>${esc(number(winLeads))}</em></span>
      <span><i style="background:var(--teal)"></i>Viewings<em>${esc(number(winViewings))}</em></span></div>
  </div>
</div>

<div class="row2">
  <div class="card cp">
    <div class="hd"><div><h2>Where leads come from</h2><div class="s">Last touch is the visit the enquiry happened on; first touch is the campaign that found the person. They are counted separately on purpose.</div></div><span class="r">all time</span></div>
    ${sourceRows.length
      ? `<div class="scroll"><table class="stack"><thead><tr><th>Channel</th><th>Share</th><th class="n">Leads</th><th class="n">First touch</th><th class="n">WA clicks</th><th class="n">Spend</th><th class="n">Cost / lead</th></tr></thead><tbody>${sourceRows.join('')}</tbody></table></div>`
      : '<p class="muted">No leads yet.</p>'}
  </div>

  <div class="stack2">
    <div class="card cp">
      <div class="hd"><div><h2>Channel mix</h2><div class="s">Share of ${esc(number(chanTotal))} leads</div></div></div>
      ${mix ? `<div class="mix">${mix}</div><div class="lg">${mixLegend}</div>` : '<p class="muted">No leads yet.</p>'}
    </div>
    <div class="card cp">
      <div class="hd"><div><h2>Attribution quality</h2><div class="s">How each lead was tied to its traffic</div></div></div>
      ${matchRows || '<p class="muted">No leads yet.</p>'}
      ${inferred ? `<div class="hint"><b>${esc(number(inferred))}</b> of ${esc(number(matchTotal))} ${matchTotal === 1 ? 'lead' : 'leads'} ${inferred === 1 ? 'is' : 'are'} matched on a time window — inferred, not proven. Treat that source as a best guess.</div>` : ''}
    </div>
  </div>
</div>

<div class="row3">
  <div class="card cp">
    <div class="hd"><div><h2>${esc(nests ? 'Tap to lead' : 'This window')}</h2><div class="s">Last ${esc(days)} days</div></div></div>
    <div class="fn">${funnel}</div>
    ${nests && waClicks && winLeads < waClicks
      ? `<div class="hint"><b>${esc(number(waClicks - winLeads))}</b> ${waClicks - winLeads === 1 ? 'person' : 'people'} tapped WhatsApp on the site and never sent a message. That gap is worth more than any ad budget.</div>`
      : !nests && winLeads
        ? `<div class="hint">These are not stages of one funnel: <b>${esc(number(winLeads))}</b> ${winLeads === 1 ? 'lead' : 'leads'} arrived against <b>${esc(number(waClicks))}</b> ${waClicks === 1 ? 'tap' : 'taps'} on the site, so most came straight into WhatsApp from an ad and never visited.</div>`
        : ''}
  </div>

  <div class="card cp">
    <div class="hd"><div><h2>Pipeline</h2><div class="s">${esc(number(openLeads))} open</div></div>
      <a class="r" href="/dashboard/leads">Board →</a></div>
    ${pipeBlock}
  </div>

  <div class="card cp">
    <div class="hd"><div><h2>Speed</h2><div class="s">All time, not the window</div></div></div>
    <div class="mr"><span class="k">Median first reply</span><span class="v">${medianReply === null ? '—' : `${esc(medianReply[0])}<s>${esc(medianReply[1])}</s>`}</span></div>
    <div class="mr"><span class="k">Slowest 1 in 10</span><span class="v">${p90Reply === null ? '—' : `${esc(p90Reply[0])}<s>${esc(p90Reply[1])}</s>`}</span></div>
    <div class="mr"><span class="k">Leads measured</span><span class="v">${esc(number(replies.count))}</span></div>
    ${replies.count ? '' : '<div class="hint">Nothing measured yet — no lead has both a message and a reply logged.</div>'}
  </div>
</div>

<footer>Jeddah time.</footer>`;

  return layout({
    title: 'Desk',
    subtitle: dateTime(now),
    active: '/dashboard',
    counts: { '/dashboard': trueWaiting || null, '/dashboard/leads': allLeads || null },
    actions: `<div class="seg">${seg}</div>`,
    body,
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
