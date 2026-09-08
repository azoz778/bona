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

export const dateTime = (ts) => (Number.isFinite(Number(ts)) ? new Date(Number(ts)).toISOString().replace('T', ' ').slice(0, 16) : '—');
const number = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : '—');
const money = (v) => (Number.isFinite(Number(v)) ? `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })} SAR` : '—');

/** A cell whose text may be Arabic or English; the browser picks the direction. */
export const auto = (v) => `<td dir="auto">${esc(v)}</td>`;
const cell = (v) => `<td>${esc(v)}</td>`;
const numCell = (v) => `<td class="n">${esc(number(v))}</td>`;

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

export const NAV = [
  ['/dashboard', 'Overview'],
  ['/dashboard/leads', 'Leads'],
  ['/dashboard/listings', 'Listings'],
  ['/dashboard/spend', 'Spend'],
  ['/dashboard/integrations', 'Integrations'],
];

/** Ivory and ink, the site's palette, in one stylesheet small enough to inline. */
export const STYLE = `
:root{--ivory:#f5f1ea;--ivory-2:#ede7dc;--sand:#d9d0c1;--stone:#6f6a62;--stone-2:#5f5a53;--ink:#0f1214;--ink-2:#1b1f22;--champagne:#c8a96a;--red:#a3301f;--amber:#8a6114;--green:#2f6b3f}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ivory);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans Arabic",sans-serif}
a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--sand)}
a:hover{border-bottom-color:var(--ink)}
header.top{background:var(--ink);color:var(--ivory);padding:.7rem clamp(.9rem,3vw,2rem);display:flex;flex-wrap:wrap;gap:.4rem 1.1rem;align-items:baseline}
header.top .brand{font-size:.78rem;letter-spacing:.18em;text-transform:uppercase;margin-inline-end:auto}
header.top a{color:var(--ivory);border-bottom:0;font-size:.82rem;letter-spacing:.06em;opacity:.72}
header.top a:hover,header.top a.on{opacity:1;border-bottom:1px solid var(--champagne)}
header.top form{display:inline;margin:0}
header.top form button{background:none;border:0;padding:0;color:var(--ivory);opacity:.72;font-size:.82rem;letter-spacing:.06em;text-transform:none;cursor:pointer}
header.top form button:hover{opacity:1;border-bottom:1px solid var(--champagne);background:none}
main{padding:clamp(1rem,3vw,2rem);max-width:1180px;margin:0 auto}
h1{font-size:1.35rem;font-weight:600;letter-spacing:.02em;margin:0 0 .2rem}
h2{font-size:.78rem;letter-spacing:.16em;text-transform:uppercase;color:var(--stone-2);margin:2rem 0 .7rem;font-weight:600}
h3{font-size:.95rem;margin:0 0 .4rem;font-weight:600}
p.sub{color:var(--stone);margin:0 0 1.4rem;font-size:.85rem}
section{margin-bottom:.5rem}
.card{background:#fff;border:1px solid var(--sand);padding:.9rem 1rem}
.grid{display:grid;gap:.8rem;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.kpi{background:#fff;border:1px solid var(--sand);padding:.8rem .9rem}
.kpi .v{font-size:1.5rem;font-weight:600;line-height:1.15}
.kpi .k{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--stone);margin-bottom:.3rem}
.kpi .note{font-size:.75rem;color:var(--stone);margin-top:.25rem}
.scroll{overflow-x:auto;border:1px solid var(--sand);background:#fff}
table{border-collapse:collapse;width:100%;font-size:.85rem}
th,td{padding:.45rem .6rem;text-align:start;border-bottom:1px solid var(--ivory-2);white-space:nowrap;vertical-align:top}
th{font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--stone-2);background:var(--ivory);position:sticky;top:0}
td.n,th.n{text-align:end;font-variant-numeric:tabular-nums}
td.wrap{white-space:normal;min-width:16rem}
tbody tr:hover{background:var(--ivory)}
.muted{color:var(--stone)}
.tag{display:inline-block;font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--sand);padding:.1rem .38rem;margin:0 .2rem .2rem 0;background:var(--ivory)}
.tag.bad{border-color:var(--red);color:var(--red)}
.tag.warn{border-color:var(--amber);color:var(--amber)}
.tag.ok{border-color:var(--green);color:var(--green)}
.board{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));align-items:start}
.col{background:#fff;border:1px solid var(--sand);padding:.6rem}
.col>h3{font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:var(--stone-2);display:flex;justify-content:space-between}
.lead{border-top:1px solid var(--ivory-2);padding:.5rem 0;font-size:.8rem}
.lead .nm{font-weight:600}
.lead .meta{color:var(--stone);font-size:.72rem}
form.filters{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 .8rem}
form.stack{display:grid;gap:.6rem;max-width:34rem}
form.row{display:flex;flex-wrap:wrap;gap:.6rem;align-items:end}
label{display:block;font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--stone-2);margin-bottom:.2rem}
input,select,textarea,button{font:inherit;color:inherit;background:#fff;border:1px solid var(--sand);padding:.45rem .55rem;border-radius:0}
input:focus,select:focus,textarea:focus{outline:2px solid var(--champagne);outline-offset:-2px}
textarea{min-height:4.5rem;resize:vertical}
button{background:var(--ink);color:var(--ivory);border-color:var(--ink);cursor:pointer;letter-spacing:.1em;text-transform:uppercase;font-size:.72rem;padding:.55rem 1.1rem}
button:hover{background:var(--ink-2)}
.err{border:1px solid var(--red);color:var(--red);background:#fff;padding:.6rem .8rem;margin-bottom:1rem;font-size:.85rem}
.ok{border:1px solid var(--green);color:var(--green);background:#fff;padding:.6rem .8rem;margin-bottom:1rem;font-size:.85rem}
.charts{display:grid;gap:.8rem;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.chart{background:#fff;border:1px solid var(--sand);padding:.7rem .8rem}
.chart .k{font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--stone);display:flex;justify-content:space-between;margin-bottom:.4rem}
.chart svg{display:block;width:100%;height:auto}
ol.timeline{list-style:none;margin:0;padding:0}
ol.timeline li{border-inline-start:2px solid var(--sand);padding:0 0 .8rem 0;padding-inline-start:.9rem;margin-inline-start:.3rem}
ol.timeline .when{font-size:.7rem;color:var(--stone);font-variant-numeric:tabular-nums}
ol.timeline .what{font-size:.85rem}
dl.fields{display:grid;grid-template-columns:max-content 1fr;gap:.3rem .9rem;margin:0;font-size:.85rem}
dl.fields dt{color:var(--stone);font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;padding-top:.15rem}
dl.fields dd{margin:0}
.login{max-width:22rem;margin:12vh auto;padding:0 1rem}
.login h1{letter-spacing:.2em;text-transform:uppercase;font-size:.9rem;text-align:center;margin-bottom:1.4rem}
.login form{display:grid;gap:.8rem}
.login .code{font-size:1.5rem;letter-spacing:.5em;text-align:center;font-variant-numeric:tabular-nums}
footer{color:var(--stone);font-size:.72rem;padding:2rem 0 1rem;text-align:center}
`.trim();

/**
 * One page. `chrome:false` drops the nav (the login page has nowhere to go).
 */
export function layout({ title, body, active = null, chrome = true }) {
  const nav = chrome
    ? `<header class="top"><span class="brand">Bona</span>${NAV.map(([href, label]) =>
        `<a href="${esc(href)}"${href === active ? ' class="on"' : ''}>${esc(label)}</a>`).join('')}<form method="post" action="/dashboard/logout"><input type="hidden" name="_dash" value="1"><button type="submit">Log out</button></form></header>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
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
  forbidden: 'That request did not come from this page.',
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

export function overviewPage({ daily, sources, matchQuality, responseTimes, pipeline, days }) {
  const strip = [
    ['Sessions', 'sessions', '#0f1214'],
    ['WhatsApp clicks', 'wa_clicks', '#c8a96a'],
    ['Leads', 'leads', '#2f6b3f'],
    ['Viewings', 'viewings', '#6f6a62'],
  ].map(([label, key, color]) => bars(daily.map((d) => ({ label: d.day, value: d[key] })), { label, color })).join('');

  const sourceRows = sources.map((s) => `<tr>${auto(s.source)}${cell(s.medium)}${auto(s.campaign ?? '—')}${cell(s.campaign_id ?? '—')}` +
    `${numCell(s.first_touch_leads)}${numCell(s.last_touch_leads)}${numCell(s.wa_clicks)}` +
    `<td class="n">${esc(s.spend_sar ? money(s.spend_sar) : '—')}</td><td class="n">${esc(s.cpl === null ? '—' : money(s.cpl))}</td></tr>`);

  const matchTotal = matchQuality.reduce((a, m) => a + m.count, 0);
  const matchRows = matchQuality.map((m) => `<tr>${cell(m.match_method)}${numCell(m.count)}` +
    `<td class="n">${esc(matchTotal ? `${Math.round((m.count / matchTotal) * 100)}%` : '—')}</td></tr>`);

  const openLeads = pipeline.filter((p) => !['won', 'lost'].includes(p.stage)).reduce((a, p) => a + p.count, 0);
  const won = pipeline.find((p) => p.stage === 'won')?.count ?? 0;

  return layout({
    title: 'Overview',
    active: '/dashboard',
    body: `<h1>Overview</h1><p class="sub">The last ${esc(days)} days, Jeddah time.</p>
<div class="charts">${strip}</div>

<h2>Right now</h2>
<div class="grid">
  ${kpi('Open leads', number(openLeads), 'everything not won or lost')}
  ${kpi('Won', number(won))}
  ${kpi('First reply, median', responseTimes.median_min === null ? '—' : `${responseTimes.median_min} min`, responseTimes.p90_min === null ? 'no replies logged yet' : `p90 ${responseTimes.p90_min} min · ${responseTimes.count} leads`)}
  ${kpi('Leads in window', number(daily.reduce((a, d) => a + d.leads, 0)))}
</div>

<h2>Sources — first touch vs last touch</h2>
<p class="sub">First touch is the campaign that found the person; last touch is the visit the enquiry happened on. They are counted separately on purpose.</p>
${scrollTable(
  '<th>Source</th><th>Medium</th><th>Campaign</th><th>ID</th><th class="n">First-touch leads</th><th class="n">Last-touch leads</th><th class="n">WA clicks</th><th class="n">Spend</th><th class="n">CPL</th>',
  sourceRows, 'No leads yet.')}

<h2>Match quality</h2>
<p class="sub">How each lead was tied to its traffic. <code>time_window</code> is an inference, not a fact.</p>
${scrollTable('<th>Method</th><th class="n">Leads</th><th class="n">Share</th>', matchRows, 'No leads yet.')}`,
  });
}

/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

const stageOptions = (selected) => STAGES.map((s) => `<option value="${esc(s)}"${s === selected ? ' selected' : ''}>${esc(s)}</option>`).join('');

function leadCard(lead, now) {
  const replied = lead.first_inbound_ts && lead.first_reply_ts
    ? ago(lead.first_reply_ts - lead.first_inbound_ts)
    : (lead.first_inbound_ts ? 'no reply yet' : '—');
  return `<div class="lead">
  <div class="nm"><a href="/dashboard/leads/${encodeURIComponent(lead.lead_id)}" dir="auto">${esc(lead.name || lead.lead_id)}</a></div>
  <div class="meta">${esc(maskPhone(lead.phone_e164))} · ${esc(lead.source ?? '—')}${lead.listing_id ? ` · ${esc(lead.listing_id)}` : ''}</div>
  <div class="meta">in stage ${esc(ago(now - (lead.stage_ts ?? lead.created)))} · reply ${esc(replied)}</div>
</div>`;
}

export function leadsPage({ board, leads, stage = '', q = '', now = Date.now(), total = 0 }) {
  const columns = STAGES.map((s) => {
    const inStage = board[s] ?? [];
    return `<div class="col"><h3><span>${esc(s)}</span><span>${esc(inStage.length)}</span></h3>` +
      (inStage.length ? inStage.map((l) => leadCard(l, now)).join('') : '<div class="lead muted">—</div>') +
      '</div>';
  }).join('');

  const rows = leads.map((l) => `<tr>
    <td><a href="/dashboard/leads/${encodeURIComponent(l.lead_id)}" dir="auto">${esc(l.name || l.lead_id)}</a></td>
    ${cell(maskPhone(l.phone_e164))}${cell(l.stage)}${auto(l.source ?? '—')}${cell(l.medium ?? '—')}${auto(l.campaign ?? '—')}
    ${cell(l.listing_id ?? '—')}${cell(l.channel ?? '—')}${cell(l.match_method ?? '—')}
    ${cell(ago(now - l.created))}${cell(dateTime(l.created))}</tr>`);

  return layout({
    title: 'Leads',
    active: '/dashboard/leads',
    body: `<h1>Leads</h1><p class="sub">${esc(total)} in the pipeline. Phone numbers are masked here; the detail page shows the whole record.</p>
<div class="board">${columns}</div>

<h2>List</h2>
<form class="filters" method="get" action="/dashboard/leads">
  <div><label for="f-stage">Stage</label><select id="f-stage" name="stage"><option value="">any</option>${stageOptions(stage)}</select></div>
  <div><label for="f-q">Search</label><input id="f-q" name="q" value="${esc(q)}" placeholder="name, phone, district…"></div>
  <div><label>&nbsp;</label><button type="submit">Filter</button></div>
</form>
${scrollTable(
  '<th>Name</th><th>Phone</th><th>Stage</th><th>Source</th><th>Medium</th><th>Campaign</th><th>Listing</th><th>Channel</th><th>Match</th><th>Age</th><th>Created</th>',
  rows, 'No leads match that filter.')}`,
  });
}

const JOURNEY_LABEL = {
  event: (e) => `${e.name}${e.listing_id ? ` · ${e.listing_id}` : ''}${e.path ? ` · ${e.path}` : ''}`,
  touchpoint: (e) => `${e.event_type} · ${e.channel}${e.source ? ` · ${e.source}${e.medium ? `/${e.medium}` : ''}` : ''}${e.campaign ? ` · ${e.campaign}` : ''}`,
  stage: (e) => `moved to ${e.stage}${e.actor ? ` by ${e.actor}` : ''}${e.note ? ` — ${e.note}` : ''}`,
  note: (e) => `note — ${e.text}`,
};

export function leadDetailPage({ lead, journey, saved = null, error = null, now = Date.now() }) {
  const field = (k, v) => `<dt>${esc(k)}</dt><dd dir="auto">${esc(v ?? '—')}</dd>`;
  const responded = lead.first_inbound_ts && lead.first_reply_ts ? ago(lead.first_reply_ts - lead.first_inbound_ts) : '—';

  const items = journey.map((e) => `<li><div class="when">${esc(dateTime(e.ts))} · ${esc(e.kind)}</div><div class="what" dir="auto">${esc(JOURNEY_LABEL[e.kind](e))}</div></li>`).join('');

  const banner = error ? `<div class="err">${esc(messageFor(error))}</div>`
    : saved ? `<div class="ok">${esc(saved === 'stage' ? 'Stage updated.' : 'Note added.')}</div>` : '';

  return layout({
    title: lead.name || lead.lead_id,
    active: '/dashboard/leads',
    body: `<h1 dir="auto">${esc(lead.name || lead.lead_id)}</h1>
<p class="sub">${esc(lead.lead_id)} · created ${esc(dateTime(lead.created))} (${esc(ago(now - lead.created))} ago)</p>
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
    ${field('Stage', `${lead.stage} · ${ago(now - (lead.stage_ts ?? lead.created))}`)}
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
    <td class="wrap">${r.flags.length ? r.flags.map((f) => `<span class="tag ${esc(FLAG_LABEL[f]?.[0] ?? '')}">${esc(FLAG_LABEL[f]?.[1] ?? f)}</span>`).join('') : '<span class="tag ok">clear</span>'}</td>
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

export function spendPage({ rows, campaigns, saved = false, error = null, today }) {
  const spendRows = rows.map((r) => `<tr>${cell(r.day)}${cell(r.platform)}${cell(r.campaign_id || '—')}${auto(r.campaign_name ?? '—')}` +
    `<td class="n">${esc(money(r.spend_sar))}</td>${numCell(r.clicks)}${numCell(r.impressions)}</tr>`);
  const campaignRows = campaigns.map((c) => `<tr>${cell(c.platform)}${cell(c.campaign_id || '—')}${auto(c.campaign_name ?? '—')}` +
    `<td class="n">${esc(money(c.spend_sar))}</td>${numCell(c.clicks)}${numCell(c.impressions)}${numCell(c.leads)}` +
    `<td class="n">${esc(c.cpl === null ? '—' : money(c.cpl))}</td></tr>`);

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
${scrollTable('<th>Day</th><th>Platform</th><th>Campaign ID</th><th>Name</th><th class="n">Spend</th><th class="n">Clicks</th><th class="n">Impressions</th>', spendRows, 'No spend recorded yet.')}`,
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
  const keyRows = keys.map((k) => `<tr>${cell(k.label)}<td>${yesNo(k.present)}</td>${cell(k.note ?? '')}</tr>`);
  const destRows = Object.entries(fanout.dests).map(([dest, configured]) => {
    const last = lastAccepted[dest];
    return `<tr>${cell(dest)}<td>${configured ? '<span class="tag ok">configured</span>' : '<span class="tag warn">no keys</span>'}</td>` +
      `${cell(last ? dateTime(last.ts) : '—')}${cell(last?.event_id ?? '—')}</tr>`;
  });

  const pollerBlock = poller
    ? `<div class="grid">
        ${kpi('Poller last run', poller.lastRun ? dateTime(poller.lastRun) : '—', poller.lag === null || poller.lag === undefined ? '' : `lag ${ago(poller.lag)}`)}
        ${kpi('Unmatched messages', poller.unmatched ?? '—', 'discarded in memory, never stored')}
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
  ${kpi('Pending', fanout.counts.pending)}
  ${kpi('Sent', fanout.counts.sent)}
  ${kpi('Failed', fanout.counts.failed)}
  ${kpi('Skipped', fanout.counts.skipped, 'no keys, or no ads consent')}
</div>
${scrollTable('<th>Destination</th><th>Status</th><th>Last accepted</th><th>Event</th>', destRows)}

<h2>Poller</h2>
${pollerBlock}

<h2>Service</h2>
<div class="grid">
  ${kpi('Retell', retell === 'ok' ? 'ok' : 'unreachable')}
  ${kpi('Store', db.ok ? 'ok' : 'error', db.file ?? '')}
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
