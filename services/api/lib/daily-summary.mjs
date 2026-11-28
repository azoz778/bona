/**
 * The owner's daily WhatsApp summary (DESIGN §7.3; PLAN T11, PR-B2). Two halves:
 *
 *   - `createDailySummary({ db, team, notes })`: the minute timer's step (`minute()`, wired by
 *     PR-INT) and the `#dana summary` test (`test()`, wired with the owner commands). At or after
 *     08:00 Riyadh, when `owner_summary_day` is not today, it queues the day's summary in the
 *     owner-notes ledger AND sets the marker in the same transaction, so a restart never sends a
 *     second one. A process that was down at 08:00 catches up on start until 12:00; after that
 *     the day is folded into the next day's summary ("covers 2 days"), the first summary ever
 *     included. Exactly one a day.
 *   - `renderSummary(deps, meta, at)`: the text, built when the note is SENT (lib/owner-notes.mjs
 *     renders every note at send time; nothing of it is stored), from the read-only counts in
 *     lib/dashboard/stats.mjs `ownerSummary`.
 *
 * Same-release rule (DESIGN §2, §7.1, critic round 2 #8): a summary is made only while
 * `owner_as_client` or `own_inbox` is '1'. While `own_inbox` is '0' it names nobody except the
 * owner's own test lead (`inbox_via` 'owner_test'); every other line is a count (another client's
 * viewing included: no time, no listing). There is no cost
 * line (the month alerts cover money) and no email line until a mailbox is configured.
 *
 * The small text helpers the notes share (one line, names, Riyadh clock and day labels,
 * durations) live here too, so lib/owner-notes.mjs imports this file and never the other way.
 */
import { createStats, dayKey, dayStart, DAY_MS, TZ_OFFSET_MS } from './dashboard/stats.mjs';

export const SUMMARY_HOUR = 8;
/** A summary missed at 08:00 (the process was down) is still sent if it starts before this hour. */
export const CATCH_UP_BEFORE_HOUR = 12;
/** However long the summary was not sent, one covers at most this many days. */
export const MAX_COVERED_DAYS = 7;
export const SUMMARY_HEADER = '*Bona — daily summary*';
/** Where the owner's links point when the caller gives no `publicApi` (config.mjs's own default). */
export const DEFAULT_PUBLIC_API = 'https://api.bona-real-estate.com';

const HOUR_MS = 3_600_000;
const DAY_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The summary's channel order and words (stats.mjs `channelBucket`). */
const CHANNELS = [['whatsapp', 'WhatsApp'], ['email', 'email'], ['form', 'website form'], ['chat', 'website chat'], ['phone', 'phone'], ['other', 'other']];
/** The note kinds a held-over line counts, in order, with their words (every kind is under the limit). */
const HELD_KINDS = [['new_client', 'new clients'], ['handover', 'hand-overs'], ['booking', 'bookings'], ['stopped', 'stops'], ['alert', 'alerts'], ['mail', 'emails'],
  ['command', 'command replies'], ['summary', 'summaries']];

/* ---------------- shared text helpers ---------------- */

/**
 * One line of text: control and format characters and runs of white space become one space,
 * trimmed; at most `max` code points, with "…" when it was cut. Anything not a string or a
 * number is ''.
 */
export function oneLine(v, max = Infinity) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const cps = [...s];
  return cps.length > max ? `${cps.slice(0, max).join('')}…` : s;
}

/** A lead's name for a note: its name, else its phone, else "a client". */
export function displayName(lead) {
  const name = oneLine(lead?.name, 60);
  if (name) return name;
  const phone = String(lead?.phone_e164 ?? '');
  return /^[1-9]\d{7,14}$/.test(phone) ? `+${phone}` : 'a client';
}

/** `YYYY-MM-DD` → "Mon 30 Nov". */
export function dayLabel(day) {
  if (!DAY_RE.test(String(day ?? ''))) return '';
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** An instant's Riyadh wall clock, "14:00". */
export const clockLabel = (ts, offsetMs = TZ_OFFSET_MS) => new Date(Number(ts) + offsetMs).toISOString().slice(11, 16);

/** "19 s", "4 min", "2.5 h". */
export function formatDuration(ms) {
  const s = Math.round(Math.max(0, Number(ms) || 0) / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** The same-release gate for every summary: the owner's test switch or the go-live switch. */
export function summaryOn(team) {
  try {
    return team?.ownerAsClientEnabled?.() === true || team?.ownInboxEnabled?.() === true;
  } catch {
    return false;
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** A module's health(), read so that a missing module or one that throws is simply "not there". */
function healthOf(mod) {
  if (!mod || typeof mod.health !== 'function') return null;
  try {
    return mod.health() ?? {};
  } catch {
    return { ok: false, configured: true };
  }
}

/** How many days a summary covers: since the last one sent, at least 1 and at most MAX_COVERED_DAYS. */
export function coveredDays(marker, today, offsetMs = TZ_OFFSET_MS) {
  if (!DAY_RE.test(String(marker ?? '')) || !DAY_RE.test(String(today ?? ''))) return 1;
  const diff = Math.round((dayStart(today, offsetMs) - dayStart(marker, offsetMs)) / DAY_MS);
  return Math.max(1, Math.min(MAX_COVERED_DAYS, diff));
}

/** The AI part of the Warnings line: "AI ✓", "AI on backup 3×", "AI ✗ 7 min"; null before a brain is configured. */
function aiWarning(brain, team, at) {
  if (!brain) return null;
  const h = healthOf(brain) ?? {};
  if (!(brain.configured === true || h.configured === true)) return null;
  if (h.ok !== true) {
    let since = null;
    try { since = team?.brainOutSince?.() ?? null; } catch { since = null; }
    return Number.isFinite(since) && at >= since ? `AI ✗ ${Math.max(1, Math.round((at - since) / 60_000))} min` : 'AI ✗';
  }
  let ops = {};
  try { ops = brain.ops?.() ?? {}; } catch { ops = {}; }
  const backup = Number(ops.backupTurns);
  return Number.isInteger(backup) && backup > 0 ? `AI on backup ${backup}×` : 'AI ✓';
}

/**
 * The summary's text, as sent. `meta` is the ledger row's: `{ day, days }` for the 08:00 one
 * (covering the 24 h × days up to 08:00 that day), or `{ test, ts }` for `#dana summary` (the
 * 24 h up to `ts`). `deps` are the owner-notes module's: db, team, publicApi and, when PR-INT
 * wires them, brain, viewing, waLink and mail (each read through its health() only).
 * @returns {string}
 */
export function renderSummary(deps = {}, meta = {}, at = Date.now()) {
  const { db, team = null, brain = null, viewing = null, waLink = null, mail = null } = deps;
  const off = Number.isFinite(Number(deps.tzOffsetMs)) ? Number(deps.tzOffsetMs) : TZ_OFFSET_MS;
  const api = String(deps.publicApi || DEFAULT_PUBLIC_API).replace(/\/+$/, '');
  const link = (path) => `${api}${path}`;
  const test = Boolean(meta.test);
  const today = dayKey(at, off);
  const day = test || !DAY_RE.test(String(meta.day ?? '')) ? today : meta.day;
  const days = Math.max(1, Math.min(MAX_COVERED_DAYS, Math.trunc(num(meta.days)) || 1));
  const end = test ? (Number.isFinite(Number(meta.ts)) ? Number(meta.ts) : at) : dayStart(day, off) + SUMMARY_HOUR * HOUR_MS;
  const from = end - (test ? 1 : days) * DAY_MS;
  const todayStart = dayStart(today, off);
  const s = createStats({ db, now: () => at, tzOffsetMs: off })
    .ownerSummary({ from, to: end, viewingsFrom: todayStart, viewingsTo: todayStart + 2 * DAY_MS });
  let named = false;
  try { named = team?.ownInboxEnabled?.() === true; } catch { named = false; }
  const nameOf = (row) => (named || row?.inbox_via === 'owner_test' ? displayName(row) : 'a client');
  const waitingLink = link('/dashboard/inbox?filter=needs_human');
  const checkLink = link('/dashboard/inbox?tab=unsure');

  const lines = [[SUMMARY_HEADER, ...(test ? ['TEST'] : []), dayLabel(day), ...(!test && days > 1 ? [`covers ${days} days`] : [])].join(' · ')];

  const nc = s.newClients;
  const channels = CHANNELS.filter(([k]) => nc.byChannel[k]).map(([k, words]) => `${words} ${nc.byChannel[k]}`);
  lines.push(`New clients: ${nc.total}${nc.total ? ` (${channels.join(' · ')})` : ''}${nc.booked ? ` — ${nc.booked} booked a viewing` : ''}`);
  lines.push(`Waiting for you: ${s.waiting}${s.waiting ? ` → ${waitingLink}` : ''}`);

  const tomorrowStart = todayStart + DAY_MS;
  // Before go-live (own_inbox '0') only the owner's own test lead is shown; every other viewing
  // is a count, with no time and no listing (DESIGN §7.3; PLAN T11 test 12).
  const viewingList = (rows) => {
    const shown = rows.filter((v) => named || v.inbox_via === 'owner_test');
    const parts = shown.map((v) => `${clockLabel(v.start_ts, off)} ${nameOf(v)} (${oneLine(String(v.listing_id ?? '').replace(/^BONA-/i, ''), 20)})`);
    const hidden = rows.length - shown.length;
    if (hidden) parts.push(parts.length ? plural(hidden, 'other client', 'other clients') : plural(hidden, 'client', 'clients'));
    return parts.join(' · ') || 'none';
  };
  lines.push(`Viewings today: ${viewingList(s.viewings.filter((v) => v.start_ts < tomorrowStart))} | tomorrow: ${viewingList(s.viewings.filter((v) => v.start_ts >= tomorrowStart))}`);

  const ai = s.ai;
  lines.push(`AI: ${plural(ai.answers, 'answer', 'answers')} · ${plural(ai.handovers, 'hand-over', 'hand-overs')}${ai.medianReplyMs === null ? '' : ` · median reply ${formatDuration(ai.medianReplyMs)}`}`);
  if (s.notAnswered) lines.push(`Not answered by the AI: ${s.notAnswered} (outage/limit) → ${waitingLink}`);

  const check = [];
  if (s.lidOnlyCount) {
    const who = s.lidOnly.map((r) => `${oneLine(r.name, 40) || 'no name'}, ${clockLabel(r.last_ts, off)}`).join(' · ');
    check.push(`${s.lidOnlyCount} without a phone number${named && who ? ` (${who})` : ''}`);
  }
  if (s.candidatesWithPhone) check.push(`${s.candidatesWithPhone} with a number → ${checkLink}`);
  if (check.length) lines.push(`Chats to check: ${check.join(' · ')}`);
  if (s.oldOutWrote) lines.push(`Marked Not a client, wrote again: ${s.oldOutWrote} → ${checkLink}`);

  const mailHealth = healthOf(mail);
  if (mailHealth?.configured === true) {
    const m = createStats({ db, now: () => at, tzOffsetMs: off }).mailCounts({ from, to: end });
    lines.push(`Email: ${m.listed} listed${m.possible ? ` · ${plural(m.possible, 'possible client', 'possible clients')} → ${link('/dashboard/email')}` : ''}`);
  }

  if (s.heldOver.total) {
    const kinds = HELD_KINDS.filter(([k]) => s.heldOver.byKind[k]).map(([k, words]) => `${words} ${s.heldOver.byKind[k]}`);
    lines.push(`Notes over the day's limit: ${s.heldOver.total}${kinds.length ? ` (${kinds.join(' · ')})` : ''}`);
  }

  const warnings = [];
  let testOn = false;
  try { testOn = team?.ownerAsClientEnabled?.() === true; } catch { testOn = false; }
  if (testOn) warnings.push('test mode ON');
  const linkHealth = healthOf(waLink);
  if (linkHealth) warnings.push(`link ${linkHealth.linkOk === true ? '✓' : '✗'}`);
  const aiPart = aiWarning(brain, team, at);
  if (aiPart) warnings.push(aiPart);
  const cal = healthOf(viewing)?.gcal;
  if (cal?.configured === true) warnings.push(`calendar ${cal.ok === true ? '✓' : '✗'}`);
  if (mailHealth?.configured === true) warnings.push(`mail ${mailHealth.ok === true ? '✓' : '✗'}`);
  if (warnings.length) lines.push(`Warnings: ${warnings.join(' · ')}`);

  return lines.join('\n');
}

/**
 * The daily summary's timer step and test. `notes` is lib/owner-notes.mjs (its `summary()`).
 * @param {{ db: object, team: object, notes: { summary: Function }, now?: () => number, log?: Function, tzOffsetMs?: number }} deps
 */
export function createDailySummary({ db, team, notes, now = () => Date.now(), log = () => {}, tzOffsetMs = TZ_OFFSET_MS } = {}) {
  if (!db || typeof db.transaction !== 'function') throw new TypeError('createDailySummary needs the store');
  if (!team || typeof team.getSetting !== 'function') throw new TypeError('createDailySummary needs the team (settings)');
  if (!notes || typeof notes.summary !== 'function') throw new TypeError('createDailySummary needs the owner notes');
  const off = tzOffsetMs;

  /** The minute timer's step: queue today's summary once, at or after 08:00 (catch-up until 12:00). */
  function minute() {
    const t = now();
    const today = dayKey(t, off);
    const hour = new Date(t + off).getUTCHours();
    if (hour < SUMMARY_HOUR) return { sent: false, reason: 'early' };
    const marker = String(team.getSetting('owner_summary_day') ?? '');
    if (marker === today) return { sent: false, reason: 'done' };
    if (!summaryOn(team)) return { sent: false, reason: 'off' };
    // Started too late for today's: tomorrow's covers both days (the marker stays behind). With
    // no marker yet (the first summary ever), it is set to yesterday, so that tomorrow's still
    // counts today's missed window ("covers 2 days") instead of dropping it.
    if (hour >= CATCH_UP_BEFORE_HOUR) {
      if (!DAY_RE.test(marker)) team.setSetting('owner_summary_day', dayKey(dayStart(today, off) - DAY_MS, off), { by: 'system' });
      return { sent: false, reason: 'late' };
    }
    const days = coveredDays(marker, today, off);
    return db.transaction(() => {
      const queued = notes.summary({ day: today, days });
      team.setSetting('owner_summary_day', today, { by: 'system' });
      try { log({ evt: 'notes.summary', days, queued: queued?.queued === true }); } catch { /* a logger never stops it */ }
      return { sent: queued?.queued === true, days };
    });
  }

  /** `#dana summary`: a TEST summary of the last 24 h, now; the day's marker is not touched. */
  function test() {
    if (!summaryOn(team)) return { sent: false, reason: 'off' };
    const queued = notes.summary({ test: true, ts: now() });
    return { sent: queued?.queued === true };
  }

  return { minute, test };
}
