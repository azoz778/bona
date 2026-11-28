/**
 * The people who may use the dashboard, the numbers that are never a client, and the
 * switches the owner controls (2026-09-27 design §3).
 *
 * A person is a name, a phone number and a role — `owner` or `staff`. The owner is seeded
 * from `BONA_OWNER_JID` on start-up; everyone else is added on the Team page. Every
 * team number, active or not, is excluded from client matching: a colleague who writes
 * "Bona" is not an enquiry, and the login code we send them says "Bona" too.
 *
 * Phone numbers are stored the way `leads.phone_e164` stores them: digits only, country
 * code first (`normalisePhone`).
 */
import { newId } from './db.mjs';
import { bareJid } from './evolution.mjs';
import { normalisePhone } from './phone.mjs';

export const ROLES = ['owner', 'staff'];
/**
 * Every setting that exists, with its default. `inbox_replies` ships '0': the team can read
 * the Bona inbox from the day it goes live, but no reply reaches a client until the owner
 * turns replies on (design D14). `dana_enabled` ships '0' for the same reason: Dana answers
 * nobody on WhatsApp until the owner turns her on, after a test on one chat (§6, P4-3).
 *
 * The full-automation switches (2026-11-27 DESIGN §5.1) all ship so that a deploy changes
 * nothing a client or the owner sees: `own_inbox` (every chat on Bona's own number joins
 * the inbox), `owner_as_client` (the owner's test switch), `calendar_booking`,
 * `email_replies` and `dana_brain` (legacy chats move from the Retell agent to the AI
 * service) ship '0'; `owner_notes` and `owner_mail_copy` ship '1' because they only
 * gate queues that do not exist until their own tasks land. The markers below them are
 * code state, never buttons: `owner_summary_day` (the daily summary's day), `mail_cursor`
 * and `mail_since` (the mail poller), `mail_from_ok` (the reply sender checked),
 * `dana_month_alerted` / `brain_month_alerted` (the month alerts), `brain_out` (since when
 * the AI service has not answered), the restart-safe spend counters `brain_usd_day` /
 * `brain_usd_month` (micro-USD), `owner_command_ts`, the time of the newest owner
 * `#dana …` command applied to each switch (lib/owner-test.mjs, PR-A2: `<switch>:<ms>`
 * pairs, comma-separated), so a restart never lets an older command undo a newer one, and
 * `greeting_seen`, the Greeting/Away detector's memory of the sent texts the owner's test chat
 * drops (lib/inbox/ingest.mjs, PR-A2): `<text hash>.<chat hash>.<ms>` marks, comma-separated,
 * at most 500, so a restart forgets no copy the transcript does not keep. Hashes and times
 * only: never a text, a number or a lead id.
 */
export const SETTINGS_DEFAULTS = {
  sending_enabled: '1', inbox_replies: '0', dana_enabled: '0', retell_funds_out: '', retell_funds_alerted: '',
  own_inbox: '0', owner_as_client: '0', calendar_booking: '0', owner_notes: '1', email_replies: '0', owner_mail_copy: '1', dana_brain: '0',
  owner_summary_day: '', mail_cursor: '', mail_since: '', mail_from_ok: '', dana_month_alerted: '',
  brain_out: '', brain_usd_day: '', brain_usd_month: '', brain_month_alerted: '', owner_command_ts: '', greeting_seen: '',
};
/**
 * A stored instant: `''` (none) or a whole ms timestamp. The Retell funds watch
 * (lib/dana-funds.mjs, 2026-10-05 design R2) keeps two of these: `retell_funds_out`, when
 * Retell started refusing for lack of credit, and `retell_funds_alerted`, the owners' last
 * alert about it. Neither is a switch: the Team page's form cannot post them.
 */
const INSTANT = /^(?:|\d{1,16})$/;
/**
 * The latest instant a reader takes from a stored INSTANT: the last date a Date can hold
 * (8.64e15 ms), less a day so a time-zone shift still renders. Sixteen digits can say more,
 * and a value past it is junk, not an outage.
 */
const MAX_INSTANT_MS = 8.64e15 - 86_400_000;
/** A calendar month and day, shape only (`2026-02-31` passes; the code writing it uses a real clock). */
const MONTH = String.raw`\d{4}-(?:0[1-9]|1[0-2])`;
const DAY = String.raw`${MONTH}-(?:0[1-9]|[12]\d|3[01])`;
/** A whole number written the one way: no sign, no leading zero, no exponent, at most 15 digits. */
const COUNT = String.raw`(?:0|[1-9]\d{0,14})`;
const SWITCH = Object.freeze(['0', '1']);
/** One Greeting/Away mark (lib/inbox/ingest.mjs): a text hash, a chat hash, the copy's time. */
const GREETING_MARK = String.raw`[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{11}\.\d{1,16}`;
/**
 * The values each setting may hold: a list, or a pattern the whole value must match. Every
 * key has an entry (team.test.mjs checks it), so none accepts any string.
 */
export const SETTINGS_ALLOWED = {
  sending_enabled: SWITCH, inbox_replies: SWITCH, dana_enabled: SWITCH,
  retell_funds_out: INSTANT, retell_funds_alerted: INSTANT,
  own_inbox: SWITCH, owner_as_client: SWITCH, calendar_booking: SWITCH, owner_notes: SWITCH,
  email_replies: SWITCH, owner_mail_copy: SWITCH, dana_brain: SWITCH,
  owner_summary_day: new RegExp(`^(?:|${DAY})$`),
  // A JMAP Email state string: opaque, so any visible ASCII, but never a blank or a control.
  mail_cursor: /^[\x21-\x7e]{0,256}$/,
  mail_since: INSTANT, mail_from_ok: INSTANT, brain_out: INSTANT,
  // The month alerts fire at 80% and at 100%: the month, and the level last sent.
  dana_month_alerted: new RegExp(`^(?:|${MONTH}(?::(?:80|100))?)$`),
  brain_month_alerted: new RegExp(`^(?:|${MONTH}(?::(?:80|100))?)$`),
  brain_usd_day: new RegExp(`^(?:|${DAY}:${COUNT})$`),
  brain_usd_month: new RegExp(`^(?:|${MONTH}:${COUNT})$`),
  // `<switch>:<ms>` pairs, comma-separated, one per switch a command has set (six today).
  owner_command_ts: /^(?:|[a-z_]{1,32}:\d{1,16}(?:,[a-z_]{1,32}:\d{1,16}){0,15})$/,
  // 16 + 11 base64url characters (two truncated SHA-256 hashes) and a time, at most 500 marks (ingest's GREETING_MARKS).
  greeting_seen: new RegExp(`^(?:|${GREETING_MARK}(?:,${GREETING_MARK}){0,499})$`),
};
/** The owner's on/off switches: each one is '0' or '1' and nothing else, and fails closed. */
export const SWITCH_KEYS = Object.keys(SETTINGS_ALLOWED).filter((k) => SETTINGS_ALLOWED[k] === SWITCH);
export const MAX_NAME = 80;
export const MAX_NEVER_NOTE = 120;

export class TeamError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TeamError';
    this.code = code;
  }
}

const jidFor = (digits) => `${digits}@s.whatsapp.net`;
const plain = (row) => (row ? { ...row } : null);

/**
 * A phone fit to identify a person on the team: not a lid id, not a raw jid with a
 * device suffix, no letters — and, once normalised, an international number (never
 * one still starting with the local trunk `0`, which means `normalisePhone` could not
 * add a country code to it). Returns `null` rather than throwing, like `normalisePhone`.
 */
function cleanPhone(raw) {
  const s = String(raw ?? '');
  if (/[@:]/.test(s) || /[a-zA-Z]/.test(s)) return null;
  const digits = normalisePhone(s);
  return digits && !digits.startsWith('0') ? digits : null;
}

// Bidi control characters (Unicode category Cf, not Cc, so `\p{Cc}` misses them): the
// Arabic Letter Mark plus the explicit directional marks, embeddings, overrides and
// isolates. A name carrying one of these can repaint how the *rest* of the row reads —
// e.g. a trailing U+202E (RLO) turning the table cells after it right-to-left — so they
// are stripped at the source rather than merely contained on render.
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/**
 * Truncated by code point (never splitting a surrogate pair), control and bidi-control
 * characters gone, internal whitespace collapsed to single spaces, trimmed.
 * `null`/`undefined` (and anything that cleans down to nothing) become `fallback`,
 * never the string `"null"`.
 */
function cleanName(raw, fallback = '') {
  const truncated = Array.from(String(raw ?? '')).slice(0, MAX_NAME).join('');
  const collapsed = truncated.replace(/\p{Cc}/gu, '').replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim();
  return collapsed || fallback;
}

/**
 * @param {ReturnType<import('./db.mjs').openDb>} store
 * @param {{ now?: () => number, log?: (e: object) => void,
 *           ownerTest?: object|(() => object|null)|null }} [o]
 *   `ownerTest` is lib/owner-test.mjs (2026-11-27 DESIGN §3.2, PR-A2), or a function that returns
 *   it: index.mjs builds it after the team, which it reads. While its `active()` is true, the
 *   owner's own number (its `ownerDigits()`, BONA_OWNER_JID) and his users-row lid (its
 *   `ownerLid()`) are not excluded, so his test chat is a client's chat; every other team number,
 *   another owner-role account included, stays excluded, and the never list still wins. Left
 *   out, or answering anything but true, nothing changes.
 */
export function createTeam(store, { now = () => Date.now(), log = () => {}, ownerTest = null } = {}) {
  const { db, transaction } = store;
  /** The test switch, read on every call; a missing one, or one that throws, is no switch. */
  const testSwitch = () => {
    try {
      const t = typeof ownerTest === 'function' ? ownerTest() : ownerTest;
      return t && t.active?.() === true ? t : null;
    } catch { return null; }
  };
  /** The owner's digits while his test is in force, else null (fail closed: he stays excluded). */
  function exceptPhone() {
    const t = testSwitch();
    if (!t) return null;
    try { return normalisePhone(t.ownerDigits?.() ?? '') ?? null; } catch { return null; }
  }
  /** The owner's users-row lid while his test is in force, else null (isExcludedLead below reads it). */
  function exceptLid() {
    const t = testSwitch();
    if (!t) return null;
    try {
      const lid = t.ownerLid?.();
      return typeof lid === 'string' && lid ? lid : null;
    } catch { return null; }
  }
  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  const getUser = (userId) => plain(prep('SELECT * FROM users WHERE user_id = ?').get(String(userId ?? '')));
  function getUserByPhone(phone) {
    const digits = normalisePhone(phone);
    return digits ? plain(prep('SELECT * FROM users WHERE phone_e164 = ?').get(digits)) : null;
  }
  const listUsers = () => prep('SELECT * FROM users ORDER BY active DESC, role ASC, name ASC').all().map(plain);
  const activeOwners = () => prep("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1").get().n;

  /** Maps the UNIQUE constraint on `phone_e164` to a `TeamError`, never a raw SQLite error. */
  function insertUser({ name, digits, role }) {
    const userId = newId('USR');
    try {
      prep('INSERT INTO users (user_id, name, phone_e164, wa_jid, role, active, created) VALUES (?,?,?,?,?,1,?)')
        .run(userId, name, digits, jidFor(digits), role, now());
    } catch (err) {
      if (String(err?.message ?? '').includes('UNIQUE constraint failed')) throw new TeamError('duplicate_phone');
      throw err;
    }
    return getUser(userId);
  }

  /**
   * Make sure the env phone number has an active owner account, and give him every
   * session that predates accounts (there was only ever one person who could have
   * opened them). Idempotent when called again with the same phone.
   *
   * The env phone is looked up directly: an existing active owner there is returned
   * as-is; an existing staff member (or a deactivated owner) there is promoted and
   * reactivated; a stranger is inserted as a new owner. A prior owner at a different
   * phone is never touched — several owners are allowed, and the old one is not
   * demoted just because the env var moved. When the resolved owner's phone differs
   * from another active owner's, `log` is told (no phone numbers or names) so a
   * changed `BONA_OWNER_JID` is visible in the logs, not just in the `users` table.
   */
  function ensureOwner({ phone, name = 'Owner' }) {
    const digits = cleanPhone(phone);
    if (!digits) throw new TeamError('bad_phone');
    return transaction(() => {
      const existing = getUserByPhone(digits);
      let owner;
      if (existing && existing.role === 'owner' && existing.active) {
        owner = existing;
      } else if (existing) {
        prep("UPDATE users SET role = 'owner', active = 1, deactivated = NULL WHERE user_id = ?").run(existing.user_id);
        owner = getUser(existing.user_id);
      } else {
        owner = insertUser({ name: cleanName(name, 'Owner'), digits, role: 'owner' });
      }
      const others = prep("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1 AND phone_e164 != ?").get(digits).n;
      if (others > 0) log({ evt: 'team.owner_env_changed' });
      prep('UPDATE auth_sessions SET user_id = ? WHERE user_id IS NULL').run(owner.user_id);
      return owner;
    });
  }

  function addUser({ name, phone, role = 'staff' } = {}) {
    const clean = cleanName(name);
    if (!clean) throw new TeamError('bad_name');
    const digits = cleanPhone(phone);
    if (!digits) throw new TeamError('bad_phone');
    if (!ROLES.includes(role)) throw new TeamError('bad_role');
    return insertUser({ name: clean, digits, role });
  }

  /** Off, logged out everywhere, codes void, phone alerts gone — one transaction. */
  function deactivateUser(userId) {
    return transaction(() => {
      const user = getUser(userId);
      if (!user) throw new TeamError('not_found');
      if (!user.active) return user;
      if (user.role === 'owner' && activeOwners() <= 1) throw new TeamError('last_owner');
      prep('UPDATE users SET active = 0, deactivated = ? WHERE user_id = ?').run(now(), user.user_id);
      prep('DELETE FROM auth_sessions WHERE user_id = ?').run(user.user_id);
      // Their phones stop getting alerts at once (§3.4, Phase 3): every device, not only the
      // sessions' ones — a subscription whose session was already gone is theirs too.
      prep('DELETE FROM push_subscriptions WHERE user_id = ?').run(user.user_id);
      // Their codes become decoys rather than vanishing: a deleted row would answer
      // 'no_request' where a stranger's challenge answers 'bad_code', telling whoever holds
      // the nonce that this number was on the team (see dashboard/auth.mjs).
      prep('UPDATE auth_challenges SET user_id = NULL WHERE user_id = ?').run(user.user_id);
      return getUser(user.user_id);
    });
  }

  function reactivateUser(userId) {
    return transaction(() => {
      const user = getUser(userId);
      if (!user) throw new TeamError('not_found');
      prep('UPDATE users SET active = 1, deactivated = NULL WHERE user_id = ?').run(user.user_id);
      return getUser(user.user_id);
    });
  }

  function setRole(userId, role) {
    if (!ROLES.includes(role)) throw new TeamError('bad_role');
    return transaction(() => {
      const user = getUser(userId);
      if (!user) throw new TeamError('not_found');
      if (user.role === 'owner' && role !== 'owner' && user.active && activeOwners() <= 1) throw new TeamError('last_owner');
      prep('UPDATE users SET role = ? WHERE user_id = ?').run(role, user.user_id);
      return getUser(user.user_id);
    });
  }

  const touchLogin = (userId) => prep('UPDATE users SET last_login = ? WHERE user_id = ?').run(now(), String(userId ?? ''));

  /* -------------------- never a client -------------------- */

  function addNever({ phone, note = null, by = null } = {}) {
    const digits = cleanPhone(phone);
    if (!digits) throw new TeamError('bad_phone');
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, MAX_NEVER_NOTE) : null;
    prep('INSERT OR REPLACE INTO never_list (phone_e164, note, added_by, ts) VALUES (?,?,?,?)').run(digits, cleanNote, by, now());
    return plain(prep('SELECT * FROM never_list WHERE phone_e164 = ?').get(digits));
  }
  function removeNever(phone) {
    const digits = cleanPhone(phone);
    return digits ? prep('DELETE FROM never_list WHERE phone_e164 = ?').run(digits).changes === 1 : false;
  }
  const listNever = () => prep('SELECT * FROM never_list ORDER BY ts DESC').all().map(plain);

  /**
   * True for any team number (active or not) and any never-list number. Normalises
   * whatever it is given first, so a loosely formatted number still matches; anything
   * that does not parse as a phone number is `false`, never a thrown error. The one
   * exception is the owner's own number while his test switch is in force (`ownerTest`
   * above): then only the never list counts for it.
   */
  function isExcludedPhone(phone) {
    const digits = normalisePhone(phone);
    if (!digits) return false;
    const member = digits !== exceptPhone() && prep('SELECT 1 FROM users WHERE phone_e164 = ?').get(digits);
    return Boolean(member || prep('SELECT 1 FROM never_list WHERE phone_e164 = ?').get(digits));
  }

  /* -------------------- switches -------------------- */

  function getSetting(key) {
    const row = prep('SELECT value FROM settings WHERE key = ?').get(String(key));
    return row ? row.value : (SETTINGS_DEFAULTS[key] ?? null);
  }
  function setSetting(key, value, { by = null } = {}) {
    if (!Object.hasOwn(SETTINGS_DEFAULTS, key)) throw new TeamError('bad_setting');
    const allowed = SETTINGS_ALLOWED[key];
    const v = String(value);
    if (allowed && !(Array.isArray(allowed) ? allowed.includes(v) : allowed.test(v))) throw new TeamError('bad_setting_value');
    prep(`INSERT INTO settings (key, value, updated, updated_by) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, updated_by = excluded.updated_by`)
      .run(String(key), String(value), now(), by);
    return getSetting(key);
  }
  /** Fail closed: only an exact `'1'` is ON. Anything else — including old or corrupt data — is OFF. */
  const sendingEnabled = () => getSetting('sending_enabled') === '1';
  /** Replies to clients from the dashboard: fails closed the same way, and ships off. */
  const repliesEnabled = () => getSetting('inbox_replies') === '1';
  /** Dana on WhatsApp: fails closed like the other two, and ships off (P4-3). */
  const danaEnabled = () => getSetting('dana_enabled') === '1';
  /**
   * Any switch, read the same fail-closed way: true only for a key in SWITCH_KEYS whose
   * stored value is exactly '1'. A marker, an unknown key or corrupt data is off.
   */
  const isOn = (key) => SWITCH_KEYS.includes(key) && getSetting(key) === '1';
  // The full-automation switches (DESIGN §5.1). Each is read by the module its task builds;
  // until then nothing reads them, so flipping one changes nothing.
  const ownInboxEnabled = () => isOn('own_inbox');
  const ownerAsClientEnabled = () => isOn('owner_as_client');
  const calendarBookingEnabled = () => isOn('calendar_booking');
  const ownerNotesEnabled = () => isOn('owner_notes');
  const emailRepliesEnabled = () => isOn('email_replies');
  const ownerMailCopyEnabled = () => isOn('owner_mail_copy');
  const danaBrainEnabled = () => isOn('dana_brain');
  /**
   * Since when the AI service has not answered (ms), or null while it is fine: the `brain_out`
   * marker. A value that is not a safe whole number a clock can show reads as null, so the
   * Team page never claims an outage "since —" from junk.
   */
  function brainOutSince() {
    const v = getSetting('brain_out');
    const n = Number(v);
    return typeof v === 'string' && /^\d{1,16}$/.test(v) && Number.isSafeInteger(n) && n > 0 && n <= MAX_INSTANT_MS ? n : null;
  }

  return {
    ensureOwner, getUser, getUserByPhone, listUsers, addUser, deactivateUser, reactivateUser, setRole, touchLogin,
    addNever, removeNever, listNever, isExcludedPhone, exceptLid,
    getSetting, setSetting, sendingEnabled, repliesEnabled, danaEnabled,
    isOn, ownInboxEnabled, ownerAsClientEnabled, calendarBookingEnabled, ownerNotesEnabled, emailRepliesEnabled,
    ownerMailCopyEnabled, danaBrainEnabled, brainOutSince,
  };
}

/* -------------------- @lid learning (2026-09-27 carryover, §3.5) -------------------- */

/**
 * Prepared statements for `learnTeamLid`/`isTeamLid`, cached per `store.db` (the raw
 * `node:sqlite` connection) rather than re-prepared on every poller tick — the two
 * statement texts below are the only ones either function ever runs, so one prepare per
 * connection is all this needs. Keyed by a `WeakMap` so a connection that is closed and
 * discarded takes its cache with it; nothing here is ever cleared by hand.
 */
const lidStatements = new WeakMap();
function lidStmt(rawDb, sql) {
  let cache = lidStatements.get(rawDb);
  if (!cache) { cache = new Map(); lidStatements.set(rawDb, cache); }
  let stmt = cache.get(sql);
  if (!stmt) { stmt = rawDb.prepare(sql); cache.set(sql, stmt); }
  return stmt;
}

/**
 * A privacy-mode `@lid` chat carries no phone number of its own — WhatsApp only ever
 * links it to one through `jidAlt` on a message that also shows the real jid. The
 * WhatsApp poller calls this the moment it sees that pairing for a number that is on
 * the team, so a later message arriving as the lid ALONE can still be matched to the
 * same person. Deliberately the only door in: nothing here ever turns a lid's own
 * digits into a phone number.
 *
 * Plain functions, not part of `createTeam()` — the poller has the store (`db.mjs`'s
 * `openDb()`) but not a `team` instance, and this is the one place it needs a `users`
 * write.
 *
 * @param {ReturnType<import('./db.mjs').openDb>} store
 * @returns {boolean} true when a row was actually updated (false for an unknown phone,
 *   a missing lid, or a lid this phone is already recorded under)
 */
export function learnTeamLid(store, phone, lid) {
  const digits = normalisePhone(phone);
  if (!digits || !lid) return false;
  const { changes } = lidStmt(store.db, 'UPDATE users SET wa_lid = ? WHERE phone_e164 = ? AND (wa_lid IS NULL OR wa_lid != ?)')
    .run(String(lid), digits, String(lid));
  return changes > 0;
}

/**
 * True when `lid` was learned as a team member's id by `learnTeamLid`. Never-list
 * numbers are not covered — they have no row in `users` to attach a lid to, so a
 * lid-only chat from one stays in the poller's logged, uncheckable gap.
 * @param {ReturnType<import('./db.mjs').openDb>} store
 */
export function isTeamLid(store, lid) {
  if (!lid) return false;
  return Boolean(lidStmt(store.db, 'SELECT 1 FROM users WHERE wa_lid = ?').get(String(lid)));
}

/**
 * The phone number in a jid, read the way lib/wa-poller.mjs `jidsOf` reads it (and so the
 * way ingest does): any jid that is not a lid, a group or a broadcast, device suffix
 * stripped. `jidsOf` itself is not imported: the poller imports this file.
 */
function phoneOfJid(jid) {
  if (typeof jid !== 'string' || !jid) return null;
  if (jid.endsWith('@lid') || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return null;
  return normalisePhone(bareJid(jid));
}

/**
 * True when a lead's chat is a team member's (active or not) or a never-list number's,
 * however the row holds it: its phone, the number in its phone jid, or a lid learned as
 * a colleague's by `learnTeamLid`. The Bona inbox's one exclusion test (§3.5, P2-7): the
 * dashboard routes refuse such a chat, ingest refuses its records, and the daily upkeep
 * takes it out of the inbox. A lid's own digits are an opaque id, never read as a phone
 * number. While the owner's test switch is in force, his own users-row lid is not a
 * colleague's (`team.exceptLid()`, 2026-11-27 DESIGN §3.2): the same exception his number gets
 * in `isExcludedPhone`. isTeamLid itself is unchanged.
 *
 * It decides from the identifier fields of the object it is handed — `phone_e164`,
 * `wa_jid`, `wa_lid` — and nothing else: it never reads the row again by `lead_id`.
 * Ingest calls it with per-identifier views of a lead (the row as if it held one number
 * or lid a record names), and a re-read would answer for the stored row instead.
 *
 * @param {ReturnType<typeof createTeam>} team
 * @param {ReturnType<import('./db.mjs').openDb>} store
 * @param {{ phone_e164?: string|null, wa_jid?: string|null, wa_lid?: string|null }|null} lead
 */
export function isExcludedLead(team, store, lead) {
  if (!lead) return false;
  if (team.isExcludedPhone(lead.phone_e164) || team.isExcludedPhone(phoneOfJid(lead.wa_jid))) return true;
  if (!isTeamLid(store, lead.wa_lid)) return false;
  const except = typeof team.exceptLid === 'function' ? team.exceptLid() : null;
  return !(except && lead.wa_lid === except);
}
