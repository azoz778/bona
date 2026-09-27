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
import { normalisePhone } from './phone.mjs';

export const ROLES = ['owner', 'staff'];
/** Every setting that exists, with its default. Phase 4 adds `dana_enabled: '0'`. */
export const SETTINGS_DEFAULTS = { sending_enabled: '1' };
/** The only values each setting may hold. A key with no entry here accepts any string. */
export const SETTINGS_ALLOWED = { sending_enabled: ['0', '1'] };
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

/**
 * Truncated by code point (never splitting a surrogate pair), control characters
 * gone, internal whitespace collapsed to single spaces, trimmed. `null`/`undefined`
 * (and anything that cleans down to nothing) become `fallback`, never the string
 * `"null"`.
 */
function cleanName(raw, fallback = '') {
  const truncated = Array.from(String(raw ?? '')).slice(0, MAX_NAME).join('');
  const collapsed = truncated.replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim();
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

  /** Off, logged out everywhere, codes void — one transaction. Phase 3 adds push subscriptions here. */
  function deactivateUser(userId) {
    return transaction(() => {
      const user = getUser(userId);
      if (!user) throw new TeamError('not_found');
      if (!user.active) return user;
      if (user.role === 'owner' && activeOwners() <= 1) throw new TeamError('last_owner');
      prep('UPDATE users SET active = 0, deactivated = ? WHERE user_id = ?').run(now(), user.user_id);
      prep('DELETE FROM auth_sessions WHERE user_id = ?').run(user.user_id);
      prep('DELETE FROM auth_challenges WHERE user_id = ?').run(user.user_id);
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
    const digits = normalisePhone(phone);
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

  return {
    ensureOwner, getUser, getUserByPhone, listUsers, addUser, deactivateUser, reactivateUser, setRole, touchLogin,
    addNever, removeNever, listNever, isExcludedPhone,
    getSetting, setSetting, sendingEnabled,
  };
}
