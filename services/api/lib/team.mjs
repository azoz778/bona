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
 * @param {ReturnType<import('./db.mjs').openDb>} store
 * @param {{ now?: () => number }} [o]
 */
export function createTeam(store, { now = () => Date.now() } = {}) {
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

  function insertUser({ name, digits, role }) {
    const userId = newId('USR');
    prep('INSERT INTO users (user_id, name, phone_e164, wa_jid, role, active, created) VALUES (?,?,?,?,?,1,?)')
      .run(userId, name, digits, jidFor(digits), role, now());
    return getUser(userId);
  }

  /**
   * Make sure there is an active owner, and give him every session that predates
   * accounts (there was only ever one person who could have opened them). Idempotent.
   */
  function ensureOwner({ phone, name = 'Owner' }) {
    const digits = normalisePhone(phone);
    if (!digits) throw new TeamError('bad_phone');
    return transaction(() => {
      let owner = plain(prep("SELECT * FROM users WHERE role = 'owner' AND active = 1 ORDER BY created LIMIT 1").get());
      if (!owner) {
        const existing = getUserByPhone(digits);
        if (existing) {
          prep("UPDATE users SET role = 'owner', active = 1, deactivated = NULL WHERE user_id = ?").run(existing.user_id);
          owner = getUser(existing.user_id);
        } else {
          owner = insertUser({ name: String(name).trim().slice(0, MAX_NAME) || 'Owner', digits, role: 'owner' });
        }
      }
      prep('UPDATE auth_sessions SET user_id = ? WHERE user_id IS NULL').run(owner.user_id);
      return owner;
    });
  }

  function addUser({ name, phone, role = 'staff' } = {}) {
    const clean = typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '';
    if (!clean) throw new TeamError('bad_name');
    const digits = normalisePhone(phone);
    if (!digits) throw new TeamError('bad_phone');
    if (!ROLES.includes(role)) throw new TeamError('bad_role');
    if (prep('SELECT 1 FROM users WHERE phone_e164 = ?').get(digits)) throw new TeamError('duplicate_phone');
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
    const user = getUser(userId);
    if (!user) throw new TeamError('not_found');
    prep('UPDATE users SET active = 1, deactivated = NULL WHERE user_id = ?').run(user.user_id);
    return getUser(user.user_id);
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
    const digits = normalisePhone(phone);
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

  /** Digits as `jidsOf()` returns them. True for any team number (active or not) and any never-list number. */
  function isExcludedPhone(digits) {
    const d = String(digits ?? '');
    if (!d) return false;
    return Boolean(prep('SELECT 1 FROM users WHERE phone_e164 = ?').get(d) || prep('SELECT 1 FROM never_list WHERE phone_e164 = ?').get(d));
  }

  /* -------------------- switches -------------------- */

  function getSetting(key) {
    const row = prep('SELECT value FROM settings WHERE key = ?').get(String(key));
    return row ? row.value : (SETTINGS_DEFAULTS[key] ?? null);
  }
  function setSetting(key, value, { by = null } = {}) {
    if (!Object.hasOwn(SETTINGS_DEFAULTS, key)) throw new TeamError('bad_setting');
    prep(`INSERT INTO settings (key, value, updated, updated_by) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, updated_by = excluded.updated_by`)
      .run(String(key), String(value), now(), by);
    return getSetting(key);
  }
  const sendingEnabled = () => getSetting('sending_enabled') !== '0';

  return {
    ensureOwner, getUser, getUserByPhone, listUsers, addUser, deactivateUser, reactivateUser, setRole, touchLogin,
    addNever, removeNever, listNever, isExcludedPhone,
    getSetting, setSetting, sendingEnabled,
  };
}
