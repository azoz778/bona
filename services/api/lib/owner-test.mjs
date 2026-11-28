/**
 * The owner's test switch, the per-lead "auto mode" and the owner's `#dana …` commands
 * (DESIGN §2, §3.2; DESIGN-brain §10; PLAN T07, PR-A2). It replaces the PR-F2b stub.
 *
 * What it answers, per DESIGN §2:
 *   ownNumberOk()  = wa.ownNumberFrom === 'instance' && link.identityOk()   (DESIGN §5.3)
 *   active()       = owner_as_client is '1' AND ownNumberOk AND the owner's digits
 *                    (BONA_OWNER_JID) differ from the instance's (BONA_WA_INSTANCE_JID)
 *   autoMode(lead) = ownNumberOk && (lead.inbox_via === 'owner_test' ? active()
 *                                  : lead.inbox_via === 'own_number' ? true
 *                                  : own_inbox === '1')
 *   ownRuleFor(jids) = ownNumberOk && (own_inbox === '1' || (active() && the jids are the owner's))
 *   ownerLid()     = the owner's users-row lid WHILE active(), else null. It is the team-lid
 *                    exception of the poller (wa-poller.mjs isTeamLidSafely, PR-A1) and of
 *                    team.mjs (isExcludedLead), so like the phone override it never applies
 *                    with the test off. Never role-based: the owner is BONA_OWNER_JID's row.
 *   ownerDigits()  = BONA_OWNER_JID's digits (config only), for team.mjs's phone override.
 * Every switch is read fail-closed (team.isOn: only an exact '1' is on), and anything that
 * throws reads as off / false / null.
 *
 * The owner commands: `command(rec)`, which the poller's tick calls right after waSeenHas and
 * before the team drop (that hook is PR-A1's). A record is one of his commands only when ALL hold:
 *   - it was received (`!fromMe`), in a 1:1 chat whose one number is the owner's digits or,
 *     with no number at all, whose one lid is his users-row lid (G14);
 *   - its text is one of COMMANDS (case and runs of whitespace do not matter).
 * Such a record is CONSUMED (true: never stored, never wakes the assistant) in both switch
 * states, whether or not it is applied. It is applied only when, too:
 *   - its time is within 10 min of now (COMMAND_MAX_AGE_MS) and, for a switch, newer than that
 *     setting's `updated` stamp and than the newest command on it applied before (the
 *     `owner_command_ts` marker, kept in the store so a restart forgets none), so a replay after
 *     an outage never undoes a later change;
 *   - its id is not in waSeen.
 * Applied: team.setSetting(key, value, { by: the owner's user_id }), the setting's `updated`
 * stamped with the command's own time (rec.ts, not the processing time, so two commands on one
 * switch read in one poll keep their order and the later one stands), the command's time in the
 * `owner_command_ts` marker, and waSeenAdd, in one transaction. A command for the value the
 * switch already has writes only the marker and waSeen: its `updated` and updated_by stay,
 * because owner_as_client's stamp is the moment the test went on (T06's history floor for the
 * test chat), which a second `#dana test on` must not move. Either way:
 * an audit row (action 'setting', meta {value, via:'whatsapp'}, as a repeat on the Team page
 * gets one), the lifecycle below on a real change only, and the reply as an owner note of kind
 * `command` (notes.command, deduplicated by the ledger as `cmd:<record id>`). `#dana status`
 * replies with the switches and an "AI: …" line from brain.health(); `#dana summary` asks the
 * notes for a summary marked TEST (no day marker), and replies only when none can go. In shared
 * mode (the instance is not a number of its own) `#dana test on|off` changes nothing, and the
 * reply says the test switch needs Bona's own number. `#dana live off` never touches dana_enabled: `#dana off` is the one
 * that stops the assistant (critic round 2 #10). An ignored command gets no reply.
 *
 * The lifecycle: `onSettingChanged(key, value)`. The Team page's saveSetting calls it once per
 * real change (routes.mjs), and an applied command does the same. Only owner_as_client has one:
 *   - on: the owner's lead (by his phone), if there is one, is reopened (store.reopenOwnerTest,
 *     guarded to his digits), so a sticky `out` from an earlier test never blocks this one. The
 *     history floor is set by the join itself (PR-A1, DESIGN §3.1).
 *   - off: leaveInbox at once (it resets dana_test, critic C14), then viewing.cancelForLead.
 *
 * Wiring: index.mjs builds this module before the notes, the viewing module and the brain
 * (they read it), so `notes`, `viewing` and `brain` may each be handed in as the module or as a
 * function that returns it. Until PR-INT (T14) hands in `db` and `inbox`, `command()` answers
 * false (the record goes on exactly as before: the team drop, or ingest's `#dana` refusal) and
 * the lifecycle does nothing.
 *
 * Nothing here logs a number, a lid, a name or a message's text: event names and codes only.
 */
import { createAudit } from './audit.mjs';
import { bareJid } from './evolution.mjs';
import { normalisePhone } from './phone.mjs';
import { waConfig } from './wa.mjs';

/** How old (or how far ahead) a command may be and still be applied (DESIGN §3.2 replay guard). */
export const COMMAND_MAX_AGE_MS = 10 * 60_000;
/** A `#dana` text: ingest refuses it in every chat, so a command never becomes a client message (DESIGN §3.2). */
export const DANA_COMMAND_RE = /^\s*#dana\b/i;
/** Every reply starts with it: the ledger's command header (DESIGN §7.2), one the poller's own-note check knows. */
export const COMMAND_HEADER = '*Bona — test mode*';
/** The marker setting that keeps each switch's newest command time (lib/team.mjs SETTINGS_ALLOWED). */
export const COMMAND_TIMES_KEY = 'owner_command_ts';

/**
 * The commands (DESIGN §3.2), by their words after `#dana` (lower case, single spaces). A switch
 * names its setting and the value it writes; `status` and `summary` only read.
 * `#dana email verified` is PR-C2's (T21).
 */
export const COMMANDS = Object.freeze({
  'test on': { code: 'test_on', key: 'owner_as_client', value: '1' },
  'test off': { code: 'test_off', key: 'owner_as_client', value: '0' },
  on: { code: 'on', key: 'dana_enabled', value: '1' },
  off: { code: 'off', key: 'dana_enabled', value: '0' },
  'live on': { code: 'live_on', key: 'own_inbox', value: '1' },
  'live off': { code: 'live_off', key: 'own_inbox', value: '0' },
  'booking on': { code: 'booking_on', key: 'calendar_booking', value: '1' },
  'booking off': { code: 'booking_off', key: 'calendar_booking', value: '0' },
  'email on': { code: 'email_on', key: 'email_replies', value: '1' },
  'email off': { code: 'email_off', key: 'email_replies', value: '0' },
  'brain on': { code: 'brain_on', key: 'dana_brain', value: '1' },
  'brain off': { code: 'brain_off', key: 'dana_brain', value: '0' },
  status: { code: 'status' },
  summary: { code: 'summary' },
});

/** Invisible marks a phone keyboard may slip in (bidi marks, the zero-width space, a BOM): never part of a command. */
const INVISIBLE = /[\u200B-\u200F\u2066-\u2069\uFEFF]/g;

/**
 * A `#dana` line however a keyboard spelt it: whitespace and format marks (Unicode Cf: the
 * zero-width marks and joiners, bidi marks, the word joiner, a soft hyphen, a BOM) before the
 * sign, between the sign and the word and inside the word, and after the word no letter, digit
 * or underscore (DANA_COMMAND_RE's `\b`), so `#danavilla` is still no `#dana` line.
 */
const DANA_LINE_RE = /^[\s\p{Cf}]*#[\s\p{Cf}]*d\p{Cf}*a\p{Cf}*n\p{Cf}*a(?![A-Za-z0-9_])/iu;

/**
 * Ingest's refusal (DESIGN §3.2): a `#dana` line is never stored as a message, by any read path
 * (the poller, the join history, a thread refresh), whether or not it is a command. It is one
 * when DANA_COMMAND_RE matches the text as typed, or as parseCommand reads it (its invisible
 * marks gone), so every text parseCommand could take is refused too; or when it is a `#dana`
 * line by DANA_LINE_RE, as typed or in NFKC (a fullwidth `＃` or letters, a no-break space).
 * As typed counts on its own (Codex T07 r4): `#dana​off` is a `#dana` line there, but once
 * the mark is dropped it reads `#danaoff`, which is none. Only parseCommand, on the owner's
 * text, makes a line a command; a `#dana` line it does not take is dropped here, unanswered.
 */
export function isDanaCommandText(text) {
  if (typeof text !== 'string') return false;
  return DANA_COMMAND_RE.test(text) || DANA_COMMAND_RE.test(text.replace(INVISIBLE, ''))
    || DANA_LINE_RE.test(text) || DANA_LINE_RE.test(text.normalize('NFKC'));
}

/**
 * The command a text is, or null: `#dana` and one of COMMANDS, in any case, with any run of
 * whitespace around and between the words. Anything else (`#dana foo`, `#danaoff`, more words
 * after the command) is no command.
 */
export function parseCommand(text) {
  if (typeof text !== 'string' || text.length > 200) return null;
  const words = text.replace(INVISIBLE, '').trim().toLowerCase().split(/\s+/);
  if (words[0] !== '#dana' || words.length < 2) return null;
  const rest = words.slice(1).join(' ');
  return Object.hasOwn(COMMANDS, rest) ? COMMANDS[rest] : null;
}

const isLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
/** A group, a broadcast or status, a channel: never one person's chat. */
const notAPerson = (jid) => typeof jid === 'string' && (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'));
/** A dependency handed in as the module or as a function that returns it (one index.mjs builds later). */
const use = (dep) => {
  try { return (typeof dep === 'function' ? dep() : dep) ?? null; } catch { return null; }
};
const onOff = (on) => (on ? 'ON' : 'OFF');
const errCode = (err) => String(err?.code ?? err?.name ?? 'error').slice(0, 40);

/**
 * @typedef {object} OwnerTest
 * @property {() => boolean} active            the owner's test switch is in force
 * @property {() => boolean} ownNumberOk       the instance is Bona's own number and its identity checked out
 * @property {(lead: object|null) => boolean} autoMode  the new semantics apply to this lead
 * @property {(jids: object) => boolean} ownRuleFor     a chat joins under the own-number rule
 * @property {() => string|null} ownerLid      the owner's users-row @lid while active(), else null
 * @property {() => string|null} ownerDigits   BONA_OWNER_JID's digits (config only)
 * @property {(rec: object) => boolean} command  an owner `#dana …` command was consumed
 * @property {(key: string, value: string) => void} onSettingChanged  a switch really changed (the lifecycle)
 * @property {() => { rule: 'own'|'shared', ownerAsClient: boolean }} health  the /health `inbox` keys this module owns
 */

/**
 * @param {object} [deps]
 * @param {object} [deps.cfg]    loadConfig(); its `env` gives `wa` when `wa` is not handed in
 * @param {ReturnType<import('./team.mjs').createTeam>} [deps.team]
 * @param {ReturnType<import('./wa.mjs').waConfig>} [deps.wa]
 * @param {{ identityOk: () => boolean, linkOk?: () => boolean }} [deps.link]  lib/wa-link.mjs
 * @param {ReturnType<import('./db.mjs').openDb>} [deps.db]   settings stamps, waSeen, the owner's lead (PR-INT wires it)
 * @param {ReturnType<import('./inbox/store.mjs').createInboxStore>} [deps.inbox]  the lifecycle's reopen and leave (PR-INT)
 * @param {ReturnType<import('./audit.mjs').createAudit>} [deps.audit]  built from `db` when left out
 * @param {object|(() => object)} [deps.notes]    lib/owner-notes.mjs: `command(recId, text)`, `summary({ test, ts })`
 * @param {object|(() => object)} [deps.viewing]  lib/viewing.mjs: `cancelForLead(leadId)`
 * @param {object|(() => object)} [deps.brain]    lib/brain.mjs: `health()` for the status line
 * @param {(e: object) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @returns {OwnerTest}
 */
export function createOwnerTest({
  cfg = null, team = null, wa = null, link = null, db = null, inbox = null, audit = null,
  notes = null, viewing = null, brain = null, log = () => {}, now = () => Date.now(),
} = {}) {
  const w = wa ?? (cfg?.env ? waConfig(cfg.env) : null);
  const ownerDigits = () => (w ? normalisePhone(bareJid(w.ownerJid)) : null);
  const instanceDigits = () => (w ? normalisePhone(bareJid(w.instanceJid)) : null);
  const say = (e) => { try { log(e); } catch { /* a logger that throws never breaks a command */ } };
  const auditLog = audit ?? (db ? createAudit(db, { now, log }) : null);
  let stampStmt = null;
  let stampSetStmt = null;
  /**
   * switch → the time of the newest command applied to it, a repeat that changed nothing
   * included: the `owner_command_ts` marker (`<switch>:<ms>,…`, lib/team.mjs). A repeat leaves
   * `updated` alone (see `command`), so this is what keeps a late-read older command from
   * undoing it, and it is in the store, so a restart in between forgets nothing. Throws when it
   * cannot be read: the guard then fails closed.
   */
  const commandTimes = () => {
    const out = new Map();
    for (const part of String(team.getSetting(COMMAND_TIMES_KEY) ?? '').split(',')) {
      const m = /^([a-z_]{1,32}):(\d{1,16})$/.exec(part);
      if (m) out.set(m[1], Number(m[2]));
    }
    return out;
  };
  /**
   * A setting's `updated` stamp (0 for a key never written): the Team page's write time, or the
   * time of the command that set it (`command` below). Throws when it cannot be read: the guard
   * then fails closed.
   */
  const settingStamp = (key) => {
    stampStmt ??= db.db.prepare('SELECT updated FROM settings WHERE key = ?');
    return Number(stampStmt.get(String(key))?.updated ?? 0) || 0;
  };

  /** A switch, fail closed: only an exact '1' is on; no team, or a throw, reads as off. */
  const on = (key) => {
    try { return Boolean(team?.isOn?.(key)); } catch { return false; }
  };

  function ownNumberOk() {
    if (w?.ownNumberFrom !== 'instance') return false;
    try { return link?.identityOk?.() === true; } catch { return false; }
  }

  /** The instance is not a number of its own: the owner's (BONA_WA_INSTANCE_JID unset or no phone jid), or equal to his. */
  function sharedMode() {
    const owner = ownerDigits();
    return w?.ownNumberFrom !== 'instance' || !owner || owner === instanceDigits();
  }

  function active() {
    const owner = ownerDigits();
    if (!owner || owner === instanceDigits()) return false;
    return on('owner_as_client') && ownNumberOk();
  }

  /** The owner's users-row lid in either switch state (a command may come from it), or null. */
  function rawOwnerLid() {
    const owner = ownerDigits();
    if (!owner) return null;
    try {
      const lid = team?.getUserByPhone?.(owner)?.wa_lid;
      return typeof lid === 'string' && lid ? lid : null;
    } catch { return null; }
  }

  const ownerLid = () => (active() ? rawOwnerLid() : null);

  /** The number and the lid a jids object names: jidsOf's shape ({ phone, waJid, waLid }) or a bare { jid, jidAlt }. */
  function idsOf(jids) {
    const out = { phone: null, lid: null };
    if (!jids || typeof jids !== 'object') return out;
    out.phone = normalisePhone(typeof jids.phone === 'string' ? jids.phone : '') ?? null;
    if (typeof jids.waLid === 'string' && jids.waLid) out.lid = jids.waLid;
    for (const j of [jids.waJid, jids.jid, jids.jidAlt]) {
      if (typeof j !== 'string' || !j || notAPerson(j)) continue;
      if (isLid(j)) out.lid ??= j;
      else out.phone ??= normalisePhone(bareJid(j));
    }
    return out;
  }

  /** The owner's chat: his number, or (no number known) his users-row lid. */
  function isOwners(jids) {
    const { phone, lid } = idsOf(jids);
    const owner = ownerDigits();
    if (phone) return Boolean(owner) && phone === owner;
    const ownLid = rawOwnerLid();
    return Boolean(ownLid) && lid === ownLid;
  }

  function ownRuleFor(jids) {
    if (!ownNumberOk()) return false;
    return on('own_inbox') || (active() && isOwners(jids));
  }

  function autoMode(lead) {
    if (!lead || typeof lead !== 'object' || !ownNumberOk()) return false;
    if (lead.inbox_via === 'owner_test') return active();
    if (lead.inbox_via === 'own_number') return true;
    return on('own_inbox');
  }

  /**
   * Who sent a received record, from its jids: true only for a 1:1 chat whose one number is the
   * owner's, or (no number at all) whose one lid is his users-row lid. A group, a broadcast, a
   * channel, a second number or a second lid is never him.
   */
  function sentByOwner(rec) {
    const owner = ownerDigits();
    if (!owner) return false;
    const phones = new Set();
    const lids = new Set();
    for (const j of [rec.jid, rec.jidAlt]) {
      if (typeof j !== 'string' || !j) continue;
      if (notAPerson(j)) return false;
      if (isLid(j)) { lids.add(j); continue; }
      const d = normalisePhone(bareJid(j));
      if (!d) return false;
      phones.add(d);
    }
    if (lids.size > 1) return false;
    if (phones.size) return phones.size === 1 && phones.has(owner);
    const ownLid = rawOwnerLid();
    return Boolean(ownLid) && lids.has(ownLid);
  }

  const ownerUserId = () => {
    const owner = ownerDigits();
    try { return owner ? (team?.getUserByPhone?.(owner)?.user_id ?? null) : null; } catch { return null; }
  };

  /** The owner's lead, by his phone: the only lead reopenOwnerTest will touch. */
  function ownerLeadId() {
    const owner = ownerDigits();
    if (!owner || !db) return null;
    try { return db.getLeadByPhone(owner)?.lead_id ?? null; } catch { return null; }
  }

  /** The test switch's lifecycle (DESIGN §3.2). Never throws: a failure is a log line. */
  function onSettingChanged(key, value) {
    if (key !== 'owner_as_client') return;
    if (!inbox || !db) {
      say({ level: 'warn', evt: 'owner_test.lifecycle_unwired' });
      return;
    }
    const leadId = ownerLeadId();
    if (!leadId) return;
    if (value === '1') {
      try {
        say({ evt: 'owner_test.on', leadId, reopened: Boolean(inbox.reopenOwnerTest(leadId, { ownerPhone: ownerDigits() })) });
      } catch (err) {
        say({ level: 'error', evt: 'owner_test.reopen_failed', leadId, error: errCode(err) });
      }
      return;
    }
    try {
      inbox.leaveInbox(leadId);
    } catch (err) {
      say({ level: 'error', evt: 'owner_test.leave_failed', leadId, error: errCode(err) });
    }
    try {
      use(viewing)?.cancelForLead?.(leadId);
    } catch (err) {
      say({ level: 'error', evt: 'owner_test.cancel_failed', leadId, error: errCode(err) });
    }
    say({ evt: 'owner_test.off', leadId });
  }

  /** The "AI: …" status line, from the brain's own health (DESIGN-brain §10). */
  function aiLine() {
    let h = null;
    try { h = use(brain)?.health?.() ?? null; } catch { h = null; }
    if (!h?.configured) return 'AI: OpenAI down (not set up)';
    if (h.ok && !h.backup) return 'AI: OpenAI ✓ (main model)';
    if (h.ok) return 'AI: OpenAI on backup';
    return 'AI: OpenAI down';
  }

  /** Why a switch that is set is not in force: the empty string when it is. */
  const notInForce = () => {
    if (sharedMode()) return " (not in force: this is not Bona's own number)";
    return ownNumberOk() ? '' : " (not in force yet: Bona's number has not been checked)";
  };

  function statusText() {
    let linkUp = false;
    try { linkUp = link?.linkOk?.() !== false; } catch { linkUp = false; }
    const testOn = on('owner_as_client');
    return [
      `${COMMAND_HEADER} ${onOff(testOn)}${testOn && !active() ? notInForce() : ''}`,
      `AI assistant: ${onOff(on('dana_enabled'))}`,
      `Live (new chats on Bona's number): ${onOff(on('own_inbox'))}`,
      `Booking: ${onOff(on('calendar_booking'))}`,
      `Email replies: ${onOff(on('email_replies'))}`,
      `OpenAI for every chat: ${onOff(on('dana_brain'))}`,
      `Bona's number: ${ownNumberOk() ? 'checked ✓' : 'not checked ✗'} · WhatsApp link: ${linkUp ? '✓' : '✗'}`,
      aiLine(),
    ].join('\n');
  }

  /** What a switch command says back, read after the change. Nameless (DESIGN-brain §6.3). */
  function switchReply(c) {
    const value = on(c.key);
    switch (c.key) {
      case 'owner_as_client':
        return value
          ? `${COMMAND_HEADER} ON${active() ? '' : notInForce()}\nWrite to Bona's number from this phone as a client would; the AI assistant answers you. #dana test off ends it.`
          : `${COMMAND_HEADER} OFF\nYour test chat has left the inbox.`;
      case 'dana_enabled':
        return value
          ? `${COMMAND_HEADER}\nAI assistant: ON`
          : `${COMMAND_HEADER}\nAI assistant: OFF everywhere. #dana on turns it back on.`;
      case 'own_inbox':
        return value
          ? `${COMMAND_HEADER}\nLive: ON${notInForce()}. New chats on Bona's number join the inbox and get AI answers.`
          : `${COMMAND_HEADER}\nLive: OFF. New chats no longer join; chats already in stay served. #dana off stops the AI assistant everywhere.`;
      case 'calendar_booking':
        return `${COMMAND_HEADER}\nBooking: ${onOff(value)}`;
      case 'email_replies':
        return `${COMMAND_HEADER}\nEmail replies: ${onOff(value)}`;
      default:
        // dana_brain: the chats outside test and live mode move from Retell to OpenAI (DESIGN §5.1).
        return value
          ? `${COMMAND_HEADER}\nOpenAI for every chat: ON`
          : `${COMMAND_HEADER}\nOpenAI for every chat: OFF (chats outside test and live mode stay on Retell)`;
    }
  }

  function reply(rec, text) {
    try {
      use(notes)?.command?.(String(rec.id), text);
    } catch (err) {
      say({ level: 'warn', evt: 'owner_test.reply_failed', error: errCode(err) });
    }
  }

  /** `#dana summary`: a summary marked TEST, without the day marker (the notes module's own). */
  function summaryCommand(rec) {
    const n = use(notes);
    if (typeof n?.summary !== 'function') {
      reply(rec, `${COMMAND_HEADER}\nSummary: not available yet.`);
      return;
    }
    let out = null;
    try { out = n.summary({ test: true, ts: rec.ts }); } catch { out = { queued: false }; }
    if (out && out.queued === false) {
      reply(rec, out.reason === 'off'
        ? `${COMMAND_HEADER}\nSummary: not sent (it goes only while test mode or live is ON).`
        : `${COMMAND_HEADER}\nSummary: not sent.`);
    }
  }

  const markSeen = (rec) => {
    try { db.waSeenAdd(rec.id, rec.ts); } catch { /* the poller marks a consumed record too */ }
  };

  /**
   * An owner command (see the header). True = consumed (never stored, never wakes the
   * assistant), applied or not; false = not a command of the owner's, so the record goes on as
   * before.
   */
  function command(rec) {
    if (!rec || typeof rec !== 'object' || rec.fromMe) return false;
    const c = parseCommand(rec.text);
    if (!c) return false;
    // Unwired (before PR-INT hands in the store): nothing could be applied or audited, so it is
    // not taken, and the record goes on as today (the team drop, or ingest's `#dana` refusal).
    if (!team || !db) return false;
    if (!sentByOwner(rec)) return false;
    const ignore = (reason) => { say({ evt: 'owner_test.command_ignored', cmd: c.code, reason }); return true; };
    if (typeof rec.id !== 'string' || !rec.id) return ignore('no_id');
    if (!Number.isFinite(rec.ts) || Math.abs(now() - rec.ts) > COMMAND_MAX_AGE_MS) return ignore('stale');
    try {
      if (db.waSeenHas(rec.id)) return ignore('seen');
    } catch { return ignore('seen_unknown'); }

    if (!c.key) {
      markSeen(rec);
      say({ evt: 'owner_test.command', cmd: c.code });
      if (c.code === 'status') reply(rec, statusText());
      else summaryCommand(rec);
      return true;
    }
    if (c.key === 'owner_as_client' && sharedMode()) {
      markSeen(rec);
      say({ evt: 'owner_test.command', cmd: c.code, applied: false, reason: 'shared' });
      reply(rec, `${COMMAND_HEADER}\nThe test switch needs Bona's own number.`);
      return true;
    }
    let stamp;
    try { stamp = Math.max(settingStamp(c.key), commandTimes().get(c.key) ?? 0); } catch { return ignore('stamp_unknown'); }
    if (!(rec.ts > stamp)) return ignore('older_than_setting');

    const by = ownerUserId();
    let before = null;
    let after = null;
    try {
      db.transaction(() => {
        before = team.getSetting(c.key);
        // Already so: nothing is written but the marker and waSeen. For owner_as_client the
        // stamp is when the test went on, the test chat's history floor (T06), and a repeat
        // must not move it.
        if (before === c.value) {
          after = before;
        } else {
          after = team.setSetting(c.key, c.value, { by });
          // The switch carries the command's own time, not this tick's: a later command read in
          // the same poll (records come oldest first) is newer than it, an older one is not.
          stampSetStmt ??= db.db.prepare('UPDATE settings SET updated = ? WHERE key = ?');
          stampSetStmt.run(rec.ts, String(c.key));
        }
        // The owner's newest word on this switch, repeat or not, for whatever process reads the next one.
        const times = commandTimes();
        times.set(c.key, rec.ts);
        team.setSetting(COMMAND_TIMES_KEY, [...times].map(([k, t]) => `${k}:${Math.trunc(t)}`).join(','), { by });
        db.waSeenAdd(rec.id, rec.ts);
      });
    } catch (err) {
      say({ level: 'error', evt: 'owner_test.command_failed', cmd: c.code, error: errCode(err) });
      return true;
    }
    try {
      auditLog?.record({ userId: by, action: 'setting', target: c.key, meta: { value: c.value, via: 'whatsapp' } });
    } catch { /* best effort, as every audit (lib/audit.mjs) */ }
    say({ evt: 'owner_test.command', cmd: c.code, applied: true, changed: after !== before });
    if (after !== before) onSettingChanged(c.key, after);
    reply(rec, switchReply(c));
    return true;
  }

  function health() {
    return { rule: ownNumberOk() && on('own_inbox') ? 'own' : 'shared', ownerAsClient: active() };
  }

  return { active, ownNumberOk, autoMode, ownRuleFor, ownerLid, ownerDigits, command, onSettingChanged, health };
}
