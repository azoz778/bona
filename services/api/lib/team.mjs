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
 * Every setting that exists, with its default. Phase 4 adds `dana_enabled: '0'`.
 * `inbox_replies` ships '0': the team can read the Bona inbox from the day it goes live,
 * but no reply reaches a client until the owner turns replies on — the first real client
 * message from the dashboard is sent with him (design D14). `dana_enabled` ships '0' for the
 * same reason: Dana answers nobody on WhatsApp until the owner turns her on (P4-3).
 */
export const SETTINGS_DEFAULTS = { sending_enabled: '1', inbox_replies: '0', dana_enabled: '0' };
/** The only values each setting may hold. A key with no entry here accepts any string. */
export const SETTINGS_ALLOWED = { sending_enabled: ['0', '1'], inbox_replies: ['0', '1'], dana_enabled: ['0', '1'] };
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
 * @param {{ now?: () => number, log?: (e: object) => void }} [o]
 */
export function createTeam(store, { now = () => Date.now(), log = () => {} } = {}) {
  const { db, transaction } = store;
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
   * that does not parse as a phone number is `false`, never a thrown error.
   */
  function isExcludedPhone(phone) {
    const digits = normalisePhone(phone);
    if (!digits) return false;
    return Boolean(prep('SELECT 1 FROM users WHERE phone_e164 = ?').get(digits) || prep('SELECT 1 FROM never_list WHERE phone_e164 = ?').get(digits));
  }

  /* -------------------- switches -------------------- */

  function getSetting(key) {
    const row = prep('SELECT value FROM settings WHERE key = ?').get(String(key));
    return row ? row.value : (SETTINGS_DEFAULTS[key] ?? null);
  }
  function setSetting(key, value, { by = null } = {}) {
    if (!Object.hasOwn(SETTINGS_DEFAULTS, key)) throw new TeamError('bad_setting');
    const allowed = SETTINGS_ALLOWED[key];
    if (allowed && !allowed.includes(String(value))) throw new TeamError('bad_setting_value');
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

  return {
    ensureOwner, getUser, getUserByPhone, listUsers, addUser, deactivateUser, reactivateUser, setRole, touchLogin,
    addNever, removeNever, listNever, isExcludedPhone,
    getSetting, setSetting, sendingEnabled, repliesEnabled, danaEnabled,
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
 * number.
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
  return team.isExcludedPhone(lead.phone_e164)
    || team.isExcludedPhone(phoneOfJid(lead.wa_jid))
    || isTeamLid(store, lead.wa_lid);
}
