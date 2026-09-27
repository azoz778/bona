# Bona dashboard — team accounts + inbox + alerts + Dana on WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Employees log in to the Bona dashboard with a WhatsApp code and (in later phases) read and answer Bona clients' WhatsApp from it, get phone alerts, and have Dana answer when nobody on the team is talking.

**Architecture:** Everything lives in `services/api` (bona-api, Node 24, dependency-free, `node:sqlite`). Phase 1 adds a `users` table and a per-user login (challenge rows bound to one user and one browser), an audit log, a "never a client" list, a sending switch, a recipient-aware WhatsApp sender with a shared rate gate, an owner-only Team page, and poller exclusions for team and never-list numbers. Phases 2–4 build on those units.

**Tech Stack:** Node 24.19 built-ins (`node:http`, `node:sqlite`, `node:crypto`, `node:test`), Evolution API 2.3.7 (Baileys) on the VPS, server-rendered HTML.

**Spec:** `docs/superpowers/specs/2026-09-27-dashboard-team-inbox-design.md` (owner-approved 2026-09-27). Read it first; §1 (decisions D1–D14) is binding.

**Scope of this file:** Phase 1 is fully specified below (code + tests). Phases 2, 3 and 4 are outlined at the end with their task lists and acceptance checks. **At the start of each of those phases, run superpowers:writing-plans again to expand that phase into the same level of detail against the code as it then is**, and append it to this file (`## Phase N — detailed`). Do not start coding a phase from its outline.

---

## Ground rules (every phase)

- Work only in the worktree `~/bona-wt/team-inbox` on branch `feat/team-inbox` (per phase you may branch `feat/team-inbox-pN` from it). `~/bona` is shared by other sessions: never `git add -A` there, never switch its branch.
- Test command (the same one `deploy.sh` runs on the VPS): `cd ~/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`. Baseline on 2026-09-27: **512 pass, 0 fail**.
- Never restart `bona-api` on the PC. The live service is on `hermes-vps`. Deploy = merge to `main`, then `ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh` (pull → tests → restart → health; refuses to restart on red tests). Before a deploy that migrates the schema: `ssh hermes-vps 'cp ~/bona-data/bona.db ~/bona-data/bona.db.bak-$(date +%Y%m%d-%H%M%S)'`.
- Rollback = `git revert` the merge on `main` + `deploy.sh`. The schema changes are additive; an older build ignores the new tables. Record the pre-merge `main` SHA as the rollback point in the PR body.
- Every phase: Claude review (superpowers:requesting-code-review) **then** Codex review (`codex exec --sandbox read-only "<review prompt>"` in the worktree, or `/gstack-codex`). Report both models' findings and where they disagree. Fix, re-run tests, then PR → merge → deploy → verify on the live dashboard in a browser (`~/.claude/scripts/chrome-debug.sh` then `node ~/.claude/scripts/browse.mjs <url> out.png`) → tell the owner.
- **Stop for the owner** (D14): before the first real client message is sent from the dashboard (Phase 2), before Dana is switched on (Phase 4), and whenever blocked. Adding the first staff member is the owner's own action on the Team page.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Never log a phone number, a name, a code or message text (existing house rule in `wa-poller.mjs` and `auth.mjs`).

## File map — Phase 1

| File | Status | Responsibility |
|---|---|---|
| `services/api/lib/db.mjs` | modify | schema v3 (users, auth_challenges, audit_log, never_list, settings, `auth_sessions.user_id`); session helpers take `userId`; drop `createAuthCode`/`consumeAuthCode` |
| `services/api/lib/team.mjs` | create | users, owner seeding, never list, settings, `isExcludedPhone` |
| `services/api/lib/audit.mjs` | create | append-only audit log |
| `services/api/lib/wa-send.mjs` | create | send to a 1:1 jid from the owner's number through the shared gate (switch + limits) |
| `services/api/lib/dashboard/auth.mjs` | rewrite | per-user challenges, decoy for unknown numbers, `check()` returns the user |
| `services/api/lib/dashboard/render.mjs` | modify | login asks for a phone; `layout` shows the signed-in person and the owner-only Team link; new messages |
| `services/api/lib/dashboard/render-team.mjs` | create | the Team page |
| `services/api/lib/dashboard/routes.mjs` | modify | resolve the user on every request; real actors; Team page + owner-only writes |
| `services/api/lib/wa-poller.mjs` | modify | drop team and never-list numbers before matching |
| `services/api/index.mjs` | modify | wire team, audit, sender, `sendCode`; seed the owner |
| `services/api/test/team.test.mjs` | create | schema v3, team, audit |
| `services/api/test/wa-send.test.mjs` | create | sender gate |
| `services/api/test/dashboard-auth.test.mjs` | rewrite | new auth |
| `services/api/test/dashboard-routes.test.mjs` | modify | harness logs in by phone; team routes |
| `services/api/test/db.test.mjs` | modify | drop the auth-code test; sessions carry `user_id` |
| `services/api/test/wa-poller.test.mjs` | modify | exclusion test |
| `services/README.md` | modify | Dashboard → Login / Team |

---

## Phase 1 — Team accounts (detailed)

### Task 1: Baseline

**Files:** none

- [ ] **Step 1: Confirm the worktree and a green baseline**

```bash
cd ~/bona-wt/team-inbox && git status -sb && git log --oneline -3
cd services && node --test api/test/*.test.mjs 2>&1 | tail -8
```
Expected: branch `feat/team-inbox`, clean tree; `ℹ pass 512`, `ℹ fail 0` (or more passes if main moved; zero failures either way). If `origin/main` moved since the branch was cut, `git fetch && git rebase origin/main` first and re-run.

### Task 2: Schema v3

**Files:**
- Modify: `services/api/lib/db.mjs` (`SCHEMA_VERSION`, `MIGRATIONS`, `createAuthSession`, remove `createAuthCode`/`consumeAuthCode`, export list)
- Modify: `services/api/test/db.test.mjs` (tables list; remove the auth-code test; session test)
- Test: `services/api/test/team.test.mjs` (new)

- [ ] **Step 1: Write the failing test** — create `services/api/test/team.test.mjs`:

```js
/**
 * Team accounts: the schema they live in, the people, the never-a-client list, the
 * switches and the audit log. The clock is injected so every timestamp is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, SCHEMA_VERSION } from '../lib/db.mjs';

const NOW = 1_790_500_000_000;

test('schema v3 adds the team tables and a user on every session', () => {
  const s = openDb(':memory:');
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 3);
  const tables = new Set(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  for (const name of ['users', 'auth_challenges', 'audit_log', 'never_list', 'settings']) assert.ok(tables.has(name), name);
  const cols = s.db.prepare('PRAGMA table_info(auth_sessions)').all().map((c) => c.name);
  assert.ok(cols.includes('user_id'));
  s.createAuthSession('tok_one', { now: NOW, ttlMs: 1000, ua: 'UA', userId: 'USR-1' });
  assert.equal(s.checkAuthSession('tok_one', { now: NOW }).user_id, 'USR-1');
  s.close();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/team.test.mjs`
Expected: FAIL — `SCHEMA_VERSION` is 2 / `users` missing.

- [ ] **Step 3: Implement** — in `services/api/lib/db.mjs`:

Change `export const SCHEMA_VERSION = 2;` to:
```js
export const SCHEMA_VERSION = 3;
```

Append a third entry to `MIGRATIONS` (after the `version: 2` object):
```js
  {
    // Team accounts (2026-09-27 design §3.1). `auth_challenges.user_id` is NULL for the
    // decoy challenge a number that is not on the team receives — see dashboard/auth.mjs.
    // `auth_codes` stays in the file, unused: migrations here only ever add.
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY, name TEXT NOT NULL, phone_e164 TEXT NOT NULL UNIQUE, wa_jid TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner','staff')), active INTEGER NOT NULL DEFAULT 1,
        created INTEGER NOT NULL, last_login INTEGER, deactivated INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_challenges (
        challenge_id TEXT PRIMARY KEY, user_id TEXT, code_hash TEXT NOT NULL, nonce_hash TEXT NOT NULL UNIQUE,
        created INTEGER NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS auth_challenges_user ON auth_challenges(user_id);
      CREATE INDEX IF NOT EXISTS auth_challenges_expires ON auth_challenges(expires);
      ALTER TABLE auth_sessions ADD COLUMN user_id TEXT;
      CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
      CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, user_id TEXT, action TEXT NOT NULL, target TEXT, meta TEXT);
      CREATE INDEX IF NOT EXISTS audit_ts ON audit_log(ts);
      CREATE TABLE IF NOT EXISTS never_list (phone_e164 TEXT PRIMARY KEY, note TEXT, added_by TEXT, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, updated_by TEXT);
    `,
  },
```

Replace `createAuthSession` with:
```js
  function createAuthSession(token, { now = Date.now(), ttlMs = 30 * 86_400_000, ua = null, userId = null } = {}) {
    prep('INSERT OR REPLACE INTO auth_sessions (token_hash, created, expires, ua, user_id) VALUES (?,?,?,?,?)')
      .run(sha256(token), toInt(now), toInt(now + ttlMs), ua == null ? null : String(ua).slice(0, 300), userId == null ? null : String(userId));
    return { expires: now + ttlMs };
  }
```

Delete the functions `createAuthCode` and `consumeAuthCode` (the block starting `function createAuthCode(` through the end of `consumeAuthCode`, including its doc comment), and in the returned object change
`createAuthCode, consumeAuthCode, createAuthSession, checkAuthSession, deleteAuthSession,` to
`createAuthSession, checkAuthSession, deleteAuthSession,`.

In `services/api/test/db.test.mjs`: delete the whole test `'a login code is one-shot, expires, and five wrong guesses burn it'` (its behaviour moves to `dashboard-auth.test.mjs`, Task 6); in the table-list loop (line ~35) append `'users', 'auth_challenges', 'audit_log', 'never_list', 'settings'` to the array; leave the session test as is (it passes no `userId`, which stays valid).

`lib/dashboard/auth.mjs` still calls `db.createAuthCode` at this point; that file is rewritten in Task 6, and its tests are expected to fail until then.

- [ ] **Step 4: Run**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/team.test.mjs api/test/db.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/bona-wt/team-inbox && git add services/api/lib/db.mjs services/api/test/db.test.mjs services/api/test/team.test.mjs
git commit -m "db: schema v3 — users, auth challenges, audit log, never list, settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: `lib/team.mjs`

**Files:**
- Create: `services/api/lib/team.mjs`
- Test: `services/api/test/team.test.mjs` (append)

- [ ] **Step 1: Write the failing tests** — append to `services/api/test/team.test.mjs` (add the import line at the top with the others):

```js
import { createTeam, TeamError } from '../lib/team.mjs';

function teamHarness() {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  return { s, team, tick: (ms) => { clock += ms; } };
}
const codeOf = (fn) => { try { fn(); } catch (err) { return err instanceof TeamError ? err.code : `not a TeamError: ${err}`; } return null; };

test('ensureOwner seeds the owner once and hands him the sessions from before accounts existed', () => {
  const { s, team } = teamHarness();
  s.createAuthSession('tok_old', { now: NOW, ttlMs: 1000 });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  assert.equal(owner.role, 'owner');
  assert.equal(owner.phone_e164, '966593296933');
  assert.equal(owner.wa_jid, '966593296933@s.whatsapp.net');
  assert.equal(s.checkAuthSession('tok_old', { now: NOW }).user_id, owner.user_id);
  const again = team.ensureOwner({ phone: '966593296933', name: 'Someone else' });
  assert.equal(again.user_id, owner.user_id, 'idempotent');
  assert.equal(team.listUsers().length, 1);
  s.close();
});

test('addUser normalises the phone and refuses bad or duplicate input', () => {
  const { s, team } = teamHarness();
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: '  Sara  ', phone: '0500000001', role: 'staff' });
  assert.equal(sara.name, 'Sara');
  assert.equal(sara.phone_e164, '966500000001');
  assert.equal(sara.active, 1);
  assert.equal(team.getUserByPhone('+966 50 000 0001').user_id, sara.user_id);
  assert.equal(codeOf(() => team.addUser({ name: '', phone: '0500000002' })), 'bad_name');
  assert.equal(codeOf(() => team.addUser({ name: 'X', phone: '12' })), 'bad_phone');
  assert.equal(codeOf(() => team.addUser({ name: 'X', phone: '0500000001' })), 'duplicate_phone');
  assert.equal(codeOf(() => team.addUser({ name: 'X', phone: '0500000003', role: 'admin' })), 'bad_role');
  s.close();
});

test('deactivating kills that person\'s sessions and codes at once; the last owner stays', () => {
  const { s, team } = teamHarness();
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: 'Sara', phone: '0500000001' });
  s.createAuthSession('tok_sara', { now: NOW, ttlMs: 86_400_000, userId: sara.user_id });
  s.db.prepare("INSERT INTO auth_challenges (challenge_id, user_id, code_hash, nonce_hash, created, expires) VALUES ('CH-1', ?, 'h', 'n', ?, ?)").run(sara.user_id, NOW, NOW + 1000);
  const off = team.deactivateUser(sara.user_id);
  assert.equal(off.active, 0);
  assert.equal(off.deactivated, NOW);
  assert.equal(s.checkAuthSession('tok_sara', { now: NOW }), null);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM auth_challenges WHERE user_id = ?').get(sara.user_id).n, 0);
  assert.equal(codeOf(() => team.deactivateUser(owner.user_id)), 'last_owner');
  assert.equal(codeOf(() => team.setRole(owner.user_id, 'staff')), 'last_owner');
  assert.equal(team.reactivateUser(sara.user_id).active, 1);
  team.setRole(sara.user_id, 'owner');
  assert.equal(team.deactivateUser(owner.user_id).active, 0, 'with a second owner the first can go');
  assert.equal(codeOf(() => team.deactivateUser('USR-nope')), 'not_found');
  s.close();
});

test('team numbers (active or not) and never-list numbers are excluded from client matching', () => {
  const { s, team } = teamHarness();
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: 'Sara', phone: '0500000001' });
  team.deactivateUser(sara.user_id);
  assert.equal(team.isExcludedPhone('966500000001'), true, 'a former employee is still not a client');
  assert.equal(team.isExcludedPhone('966511111111'), false);
  team.addNever({ phone: '0511111111', note: 'cousin', by: 'USR-x' });
  assert.equal(team.isExcludedPhone('966511111111'), true);
  assert.deepEqual(team.listNever().map((r) => r.phone_e164), ['966511111111']);
  assert.equal(team.removeNever('0511111111'), true);
  assert.equal(team.isExcludedPhone('966511111111'), false);
  assert.equal(codeOf(() => team.addNever({ phone: 'abc' })), 'bad_phone');
  s.close();
});

test('settings default to on, can be switched, and refuse unknown keys', () => {
  const { s, team } = teamHarness();
  assert.equal(team.sendingEnabled(), true);
  team.setSetting('sending_enabled', '0', { by: 'USR-1' });
  assert.equal(team.sendingEnabled(), false);
  assert.equal(s.db.prepare("SELECT updated_by FROM settings WHERE key = 'sending_enabled'").get().updated_by, 'USR-1');
  assert.equal(codeOf(() => team.setSetting('dana_enabled', '1')), 'bad_setting', 'Phase 4 adds that key');
  s.close();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/team.test.mjs`
Expected: FAIL — `Cannot find module '../lib/team.mjs'`.

- [ ] **Step 3: Implement** — create `services/api/lib/team.mjs`:

```js
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
```

- [ ] **Step 4: Run**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/team.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/bona-wt/team-inbox && git add services/api/lib/team.mjs services/api/test/team.test.mjs
git commit -m "team: people, owner seeding, never-a-client list, switches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: `lib/audit.mjs`

**Files:**
- Create: `services/api/lib/audit.mjs`
- Test: `services/api/test/team.test.mjs` (append)

- [ ] **Step 1: Write the failing test** — append to `services/api/test/team.test.mjs` (import at top):

```js
import { createAudit, AUDIT_ACTIONS } from '../lib/audit.mjs';

test('the audit log records who did what, newest first, and refuses an unknown action', () => {
  const s = openDb(':memory:');
  let clock = NOW;
  const audit = createAudit(s, { now: () => clock });
  audit.record({ userId: 'USR-1', action: 'login' });
  clock += 1000;
  audit.record({ userId: 'USR-1', action: 'team_add', target: 'USR-2', meta: { role: 'staff' } });
  const [latest, first] = audit.recent(10);
  assert.equal(latest.action, 'team_add');
  assert.deepEqual(latest.meta, { role: 'staff' });
  assert.equal(first.action, 'login');
  assert.equal(first.ts, NOW);
  assert.throws(() => audit.record({ userId: 'USR-1', action: 'made_up' }), /unknown audit action/);
  assert.ok(AUDIT_ACTIONS.includes('stage'));
  s.close();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/team.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `services/api/lib/audit.mjs`:

```js
/**
 * Who did what on the dashboard (2026-09-27 design §3.1). Append-only; never a code,
 * never message text. A write that fails to be audited is logged, not thrown: the
 * owner's action already happened, and refusing to show it would only hide it.
 * Phase 2 adds reply_sent, inbox_move, inbox_out, inbox_add and handler.
 */
import { newId } from './db.mjs';

export const AUDIT_ACTIONS = [
  'login', 'logout', 'code_request',
  'team_add', 'team_deactivate', 'team_reactivate', 'team_role',
  'never_add', 'never_remove', 'setting',
  'stage', 'note',
];

export function createAudit(store, { now = () => Date.now(), log = () => {} } = {}) {
  const insert = store.db.prepare('INSERT INTO audit_log (id, ts, user_id, action, target, meta) VALUES (?,?,?,?,?,?)');
  const latest = store.db.prepare('SELECT * FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?');

  function record({ userId = null, action, target = null, meta = null } = {}) {
    if (!AUDIT_ACTIONS.includes(action)) throw new TypeError(`unknown audit action: ${action}`);
    try {
      insert.run(newId('AUD'), now(), userId, action, target == null ? null : String(target), meta == null ? null : JSON.stringify(meta));
    } catch (err) {
      log({ level: 'error', evt: 'audit.failed', action, error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  function recent(limit = 50) {
    return latest.all(Math.max(1, Math.min(500, Number(limit) || 50))).map((r) => {
      let meta = null;
      try { meta = r.meta ? JSON.parse(r.meta) : null; } catch { meta = null; }
      return { ...r, meta };
    });
  }

  return { record, recent };
}
```

- [ ] **Step 4: Run**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/team.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/bona-wt/team-inbox && git add services/api/lib/audit.mjs services/api/test/team.test.mjs
git commit -m "audit: append-only log of dashboard actions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: `lib/wa-send.mjs`

**Files:**
- Create: `services/api/lib/wa-send.mjs`
- Test: `services/api/test/wa-send.test.mjs`

- [ ] **Step 1: Write the failing tests** — create `services/api/test/wa-send.test.mjs`:

```js
/**
 * The one door every message to someone other than the owner goes out through: a 1:1
 * jid only, the owner's sending switch, and limits shared by every sender.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createSender, SEND_PER_MIN, PER_RECIPIENT_PER_MIN } from '../lib/wa-send.mjs';

const NOW = 1_790_500_000_000;
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };

function harness({ reply = () => ({ status: 201, body: { key: { id: 'KEY-1' } } }), env = ENV } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = await reply(calls.length);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  const sender = createSender({ env, team, fetchImpl, now: () => clock });
  return { s, team, sender, calls, tick: (ms) => { clock += ms; } };
}

test('sends the text to that number on the owner instance and returns the WhatsApp message id', async () => {
  const h = harness();
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'hello', kind: 'code' });
  assert.deepEqual(out, { ok: true, keyId: 'KEY-1', status: 201 });
  assert.equal(h.calls[0].url, 'http://evo.test/message/sendText/abdulaziz-personal');
  assert.equal(h.calls[0].init.headers.apikey, 'k');
  assert.deepEqual(h.calls[0].body, { number: '966500000001', text: 'hello' });
  h.s.close();
});

test('never sends to a group, a lid, a broadcast or garbage', async () => {
  const h = harness();
  for (const jid of ['120363135705763548@g.us', '123456789@lid', 'status@broadcast', '966500000001', '', null]) {
    assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'code' }), { ok: false, error: 'bad_recipient' }, String(jid));
  }
  assert.equal(h.calls.length, 0);
  h.s.close();
});

test('the sending switch stops everything except what is allowed to bypass it', async () => {
  const h = harness();
  h.team.setSetting('sending_enabled', '0');
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'sending_disabled' });
  const owner = await h.sender.sendTo({ jid: '966593296933@s.whatsapp.net', text: 'x', kind: 'code', bypassSwitch: true });
  assert.equal(owner.ok, true, "the owner's own login code still goes, or he could never switch it back on");
  h.s.close();
});

test('limits: per recipient per minute, and across every sender', async () => {
  const h = harness();
  const one = '966500000001@s.whatsapp.net';
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) assert.equal((await h.sender.sendTo({ jid: one, text: 'x', kind: 'code' })).ok, true);
  assert.deepEqual(await h.sender.sendTo({ jid: one, text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  let ok = PER_RECIPIENT_PER_MIN;
  for (let n = 2; ok < SEND_PER_MIN; n += 1) {
    if ((await h.sender.sendTo({ jid: `9665000000${String(n).padStart(2, '0')}@s.whatsapp.net`, text: 'x', kind: 'code' })).ok) ok += 1;
  }
  assert.deepEqual(await h.sender.sendTo({ jid: '966599999999@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  h.tick(60_000);
  assert.equal((await h.sender.sendTo({ jid: '966599999999@s.whatsapp.net', text: 'x', kind: 'code' })).ok, true, 'refills');
  h.s.close();
});

test('an HTTP error fails; a timeout is "uncertain", never retried here', async () => {
  const bad = harness({ reply: () => ({ status: 500, body: {} }) });
  assert.deepEqual(await bad.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'http_500' });
  bad.s.close();

  const s = openDb(':memory:');
  const team = createTeam(s);
  const slow = createSender({
    env: ENV, team, timeoutMs: 5,
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  assert.deepEqual(await slow.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'timeout', uncertain: true });
  s.close();
});

test('no Evolution credentials: nothing is attempted', async () => {
  const h = harness({ env: {} });
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'evolution-not-configured' });
  assert.equal(h.calls.length, 0);
  h.s.close();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/wa-send.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `services/api/lib/wa-send.mjs`:

```js
/**
 * Messages from the owner's WhatsApp to anyone other than the owner (2026-09-27 design §4.5).
 *
 * Phase 1 sends only login codes to team members; Phase 2 adds client replies (with an
 * outbox and idempotency) and Phase 4 Dana. They all pass the same gate, because they all
 * spend the same thing — the standing of one personal number on WhatsApp:
 *
 *   - a 1:1 phone jid only (`…@s.whatsapp.net`). A group, a broadcast or an `…@lid` is
 *     refused: `lid` digits are an opaque id, not a phone number (see wa-poller.mjs).
 *   - the owner's Sending switch (`settings.sending_enabled`). Only a caller that says
 *     `bypassSwitch` passes it while it is off — the owner's own login code, or he could
 *     never get back in to switch it on.
 *   - 20 a minute and 500 a day across every sender, 6 a minute to any one recipient,
 *     all asked before any is charged (see lib/ratelimit.mjs `peek`).
 *
 * A timeout does not mean the message was not delivered, so it comes back `uncertain`
 * and nothing here retries it. The owner's new-lead note to his own chat stays in
 * lib/wa.mjs: that one is a message to himself.
 */
import { createLimiter } from './ratelimit.mjs';
import { waConfig } from './wa.mjs';

export const SEND_PER_MIN = 20;
export const SEND_PER_DAY = 500;
export const PER_RECIPIENT_PER_MIN = 6;
const PHONE_JID_RE = /^(\d{8,15})@s\.whatsapp\.net$/;

/**
 * @param {{ env?: object, team: ReturnType<import('./team.mjs').createTeam>,
 *           fetchImpl?: typeof globalThis.fetch, now?: () => number, log?: Function, timeoutMs?: number }} o
 */
export function createSender({ env = {}, team, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {}, timeoutMs = 8000 } = {}) {
  if (!team) throw new TypeError('createSender needs the team store (for the sending switch)');
  const cfg = waConfig(env);
  const perMinute = createLimiter({ capacity: SEND_PER_MIN, perMs: 60_000, now });
  const perDay = createLimiter({ capacity: SEND_PER_DAY, perMs: 86_400_000, now });
  const perRecipient = createLimiter({ capacity: PER_RECIPIENT_PER_MIN, perMs: 60_000, now });

  /**
   * @param {{ jid: string, text: string, kind: 'code', bypassSwitch?: boolean }} o
   * @returns {Promise<{ ok: true, keyId: string|null, status: number } | { ok: false, error: string, uncertain?: true }>}
   */
  async function sendTo({ jid, text, kind, bypassSwitch = false } = {}) {
    const m = PHONE_JID_RE.exec(String(jid ?? ''));
    if (!m) return { ok: false, error: 'bad_recipient' };
    if (!bypassSwitch && !team.sendingEnabled()) return { ok: false, error: 'sending_disabled' };
    if (!cfg.enabled) return { ok: false, error: 'disabled' };
    if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: 'evolution-not-configured' };

    const gates = [[perMinute, 'send:minute'], [perDay, 'send:day'], [perRecipient, `send:to:${m[1]}`]];
    if (gates.some(([limiter, key]) => !limiter.peek(key).ok)) {
      log({ level: 'warn', evt: 'wa.send.rate_limited', kind });
      return { ok: false, error: 'rate_limited' };
    }
    for (const [limiter, key] of gates) limiter.take(key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/message/sendText/${encodeURIComponent(cfg.instance)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
        body: JSON.stringify({ number: m[1], text: String(text ?? '') }),
        signal: controller.signal,
      });
      if (!res.ok) {
        log({ level: 'warn', evt: 'wa.send.failed', kind, status: res.status });
        return { ok: false, error: `http_${res.status}` };
      }
      let keyId = null;
      try {
        const body = JSON.parse(await res.text());
        keyId = typeof body?.key?.id === 'string' ? body.key.id : null;
      } catch { keyId = null; }
      log({ evt: 'wa.send.ok', kind });
      return { ok: true, keyId, status: res.status };
    } catch (err) {
      if (err?.name === 'AbortError') {
        log({ level: 'warn', evt: 'wa.send.uncertain', kind });
        return { ok: false, error: 'timeout', uncertain: true };
      }
      log({ level: 'warn', evt: 'wa.send.failed', kind, error: 'network' });
      return { ok: false, error: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { sendTo };
}
```

- [ ] **Step 4: Run**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/wa-send.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/bona-wt/team-inbox && git add services/api/lib/wa-send.mjs services/api/test/wa-send.test.mjs
git commit -m "wa-send: one gated door for messages from the owner's number

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Per-user login (`auth.mjs` rewrite)

**Files:**
- Rewrite: `services/api/lib/dashboard/auth.mjs`
- Rewrite: `services/api/test/dashboard-auth.test.mjs`

- [ ] **Step 1: Write the failing tests** — replace the whole of `services/api/test/dashboard-auth.test.mjs` with:

```js
/**
 * Dashboard login for a team: a code goes to the person's own WhatsApp, belongs to that
 * person and that browser, and says nothing about who is on the team. The clock is
 * injected, so limits and expiries are asserted exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createAudit } from '../lib/audit.mjs';
import {
  createAuth, COOKIE_NAME, TRY_COOKIE_NAME, parseCookies, hashEquals, generateCode, codeMessage,
  PHONE_CODES, GLOBAL_PER_MIN, CODE_TTL_MS, MAX_CODE_ATTEMPTS,
} from '../lib/dashboard/auth.mjs';

const NOW = 1_790_500_000_000;
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
const codeOf = (text) => /(\d{6})/.exec(text ?? '')?.[1] ?? null;

function harness({ send = async () => ({ ok: true }), random = null } = {}) {
  const db = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(db, { now: () => clock });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const staff = team.addUser({ name: 'Sara', phone: '0500000001', role: 'staff' });
  const audit = createAudit(db, { now: () => clock });
  const sent = [];
  const logs = [];
  const auth = createAuth({
    db, team, audit, cfg: { dashCookieDays: 30 },
    sendCode: async (o) => { sent.push(o); return send(o); },
    now: () => clock, log: (o) => logs.push(o),
    ...(random ? { random } : {}),
  });
  return {
    db, team, audit, auth, owner, staff, sent, logs,
    tick: (ms) => { clock += ms; },
    res: () => {
      const headers = {};
      return {
        getHeader: (k) => headers[k.toLowerCase()],
        setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
        get cookies() { const v = headers['set-cookie']; return v === undefined ? [] : (Array.isArray(v) ? v : [v]); },
      };
    },
  };
}

/** Ask for a code the way the login form does and read the digits off "the phone". */
async function asked(h, phone = '0500000001', ip = '1.1.1.1') {
  const before = h.sent.length;
  const out = await h.auth.requestCode({ phone, ip });
  await h.auth.flush();
  const msg = h.sent.length > before ? h.sent.at(-1) : null;
  return { ...out, msg, code: codeOf(msg?.text) };
}

test('a staff code goes to that person\'s own WhatsApp; the owner\'s may pass the sending switch', async () => {
  const h = harness();
  const s = await asked(h, '0500000001');
  assert.equal(s.ok, true);
  assert.match(s.nonce, /^[0-9a-f]{32}$/);
  assert.equal(s.msg.jid, '966500000001@s.whatsapp.net');
  assert.equal(s.msg.bypassSwitch, false);
  assert.equal(s.msg.text, codeMessage(s.code));
  const o = await asked(h, '+966 59 329 6933', '2.2.2.2');
  assert.equal(o.msg.jid, '966593296933@s.whatsapp.net');
  assert.equal(o.msg.bypassSwitch, true);
  h.db.close();
});

test('a number that is not an active member gets the same answer, a decoy, and no message', async () => {
  const h = harness();
  h.team.deactivateUser(h.staff.user_id);
  for (const phone of ['0511111111', '0500000001']) {
    const out = await asked(h, phone);
    assert.equal(out.ok, true, phone);
    assert.match(out.nonce, /^[0-9a-f]{32}$/);
    assert.equal(out.msg, null, `${phone}: nothing sent`);
    const res = h.auth.verify('123456', null, { nonce: out.nonce });
    assert.deepEqual(res, { ok: false, error: 'bad_code' }, 'a decoy answers exactly like a real code typed wrong');
  }
  assert.equal(h.db.db.prepare('SELECT COUNT(*) AS n FROM auth_challenges WHERE user_id IS NULL').get().n, 2);
  h.db.close();
});

test('a code opens a session for its own person, in its own browser, once', async () => {
  const h = harness();
  const a = await asked(h, '0500000001');
  assert.deepEqual(h.auth.verify(a.code, 'UA', { nonce: null }), { ok: false, error: 'no_request' });
  const other = await asked(h, '0500000001', '3.3.3.3');
  assert.deepEqual(h.auth.verify(a.code, 'UA', { nonce: other.nonce }).error, 'bad_code', "another browser's nonce does not open this code");
  const ok = h.auth.verify(a.code, 'UA', { nonce: a.nonce });
  assert.equal(ok.ok, true);
  assert.equal(ok.user.user_id, h.staff.user_id);
  assert.match(ok.token, /^[0-9a-f]{32}$/);
  assert.equal(h.auth.check(ok.token).user_id, h.staff.user_id, 'check() returns the person');
  assert.equal(h.team.getUser(h.staff.user_id).last_login, NOW);
  assert.deepEqual(h.auth.verify(a.code, 'UA', { nonce: a.nonce }), { ok: false, error: 'used' });
  assert.equal(h.audit.recent(5)[0].action, 'login');
  h.db.close();
});

test('five wrong guesses burn that challenge only; expiry is ten minutes', async () => {
  const h = harness();
  const a = await asked(h, '0500000001');
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) {
    const wrong = a.code === '000000' ? '111111' : '000000';
    assert.equal(h.auth.verify(wrong, null, { nonce: a.nonce }).error, 'bad_code');
  }
  assert.deepEqual(h.auth.verify(a.code, null, { nonce: a.nonce }), { ok: false, error: 'attempts' });
  const b = await asked(h, '0500000001', '4.4.4.4');
  h.tick(CODE_TTL_MS + 1);
  assert.deepEqual(h.auth.verify(b.code, null, { nonce: b.nonce }), { ok: false, error: 'expired' });
  h.db.close();
});

test('Arabic-Indic digits are the same code', async () => {
  const h = harness();
  const a = await asked(h, '٠٥٠٠٠٠٠٠٠١');
  assert.equal(a.msg.jid, '966500000001@s.whatsapp.net', 'the phone field accepts Arabic digits too');
  const arabic = a.code.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  assert.equal(h.auth.verify(arabic, null, { nonce: a.nonce }).ok, true);
  h.db.close();
});

test('deactivation ends a live session and voids a code in flight', async () => {
  const h = harness();
  const a = await asked(h, '0500000001');
  const session = h.auth.verify(a.code, null, { nonce: a.nonce });
  const pending = await asked(h, '0500000001', '5.5.5.5');
  h.team.deactivateUser(h.staff.user_id);
  assert.equal(h.auth.check(session.token), null);
  assert.deepEqual(h.auth.verify(pending.code, null, { nonce: pending.nonce }), { ok: false, error: 'no_request' });
  h.db.close();
});

test('limits: three per phone per ten minutes, six a minute overall, asked before charged', async () => {
  const h = harness();
  for (let i = 0; i < PHONE_CODES; i += 1) assert.equal((await asked(h, '0500000001', `10.0.0.${i}`)).ok, true);
  assert.deepEqual(await h.auth.requestCode({ phone: '0500000001', ip: '10.0.1.1' }), { ok: false, error: 'rate_limited' });
  // 10.0.1.1 was refused by the phone bucket; its own IP bucket was not charged.
  h.tick(60_000);
  for (let i = 0; i < 3; i += 1) assert.equal((await h.auth.requestCode({ phone: `05111111${10 + i}`, ip: '10.0.1.1' })).ok, true, `ip try ${i}`);
  h.tick(60_000);
  for (let i = 0; i < GLOBAL_PER_MIN; i += 1) assert.equal((await h.auth.requestCode({ phone: `05222222${10 + i}`, ip: `10.0.2.${i}` })).ok, true);
  assert.deepEqual(await h.auth.requestCode({ phone: '0533333333', ip: '10.0.3.1' }), { ok: false, error: 'rate_limited' });
  assert.deepEqual(await h.auth.requestCode({ phone: 'abc', ip: '10.0.3.2' }), { ok: false, error: 'bad_phone' });
  h.db.close();
});

test('nothing readable is stored and the code is never logged', async () => {
  // A fixed code that cannot occur inside the timestamps in the dump, so the test cannot flake.
  const h = harness({ random: () => 482913 });
  const a = await asked(h, '0500000001');
  const ok = h.auth.verify(a.code, null, { nonce: a.nonce });
  const dump = JSON.stringify([
    h.db.db.prepare('SELECT * FROM auth_challenges').all(),
    h.db.db.prepare('SELECT * FROM auth_sessions').all(),
    h.db.db.prepare('SELECT * FROM audit_log').all(),
    h.logs,
  ]);
  for (const secret of [a.code, a.nonce, ok.token]) assert.ok(!dump.includes(secret), 'secret leaked');
  assert.ok(dump.includes(sha256(a.nonce)));
  h.db.close();
});

test('a failed send is logged and the login page still says "sent"', async () => {
  const h = harness({ send: async () => ({ ok: false, error: 'http_500' }) });
  const a = await asked(h, '0500000001');
  assert.equal(a.ok, true);
  assert.ok(h.logs.some((l) => l.evt === 'dash.code_send_failed' && l.reason === 'http_500'));
  h.db.close();
});

test('helpers: code shape, message, constant-time compare, cookies', () => {
  assert.equal(generateCode(() => 42), '000042');
  assert.equal(codeMessage('123456'), 'Bona dashboard code: 123456 (valid 10 min)');
  assert.equal(hashEquals(sha256('a'), sha256('a')), true);
  assert.equal(hashEquals(sha256('a'), sha256('b')), false);
  assert.equal(hashEquals('ab', 'abcd'), false);
  assert.deepEqual(parseCookies('a=1; bona_dash=x%20y; bad'), { a: '1', bona_dash: 'x y' });
  const h = harness();
  const res = h.res();
  h.auth.setCookie(res, 'f'.repeat(32));
  h.auth.setTryCookie(res, 'e'.repeat(32));
  assert.match(res.cookies[0], new RegExp(`^${COOKIE_NAME}=f{32}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000$`));
  assert.match(res.cookies[1], new RegExp(`^${TRY_COOKIE_NAME}=e{32}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600$`));
  h.db.close();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/dashboard-auth.test.mjs`
Expected: FAIL (`PHONE_CODES` not exported / `requestCode` signature).

- [ ] **Step 3: Implement** — replace the whole of `services/api/lib/dashboard/auth.mjs` with:

```js
/**
 * Dashboard login: a one-time code sent to a team member's own WhatsApp.
 *
 * Who may log in is the `users` table (lib/team.mjs): the owner, seeded from
 * `BONA_OWNER_JID`, and the people he adds on the Team page. A person types their phone
 * number; if it belongs to an active member, six digits go to that member's WhatsApp from
 * the owner's number (the owner's own code goes to his own chat, as it always did).
 * Possession of that phone IS the credential.
 *
 * Nothing readable is stored: `auth_challenges` holds `sha256(code)` and `sha256(nonce)`,
 * `auth_sessions` holds `sha256(token)`. The code is written in exactly one place, the
 * WhatsApp message — never a log line, a response or the audit log.
 *
 * ## One challenge, one person, one browser
 *
 * A code request creates a challenge: the member it belongs to, the code's hash, and the
 * hash of a `bona_dash_try` nonce handed back as an HttpOnly cookie. `verify()` finds the
 * challenge by that nonce — never by the code — so a code only works in the browser that
 * asked for it and only for the person it was sent to, and five wrong guesses burn that
 * challenge alone. A stranger with no nonce cannot spend anyone's attempts.
 *
 * ## Nothing says who is on the team
 *
 * A number that is not an active member gets the same answer, the same cookie and a decoy
 * challenge whose hash no six digits can match. The answer is returned before the WhatsApp
 * message is sent, so neither the response nor its timing tells a stranger whether a
 * number belongs to the team. The cost: a send that fails is only in the log — the page
 * says "if that number is on the team, a code is on its way" either way.
 *
 * ## Limits
 *
 * Asked before any is charged (charging one and then being refused by the next is how a
 * caller spends an allowance that was never theirs): 3 codes per 10 minutes per phone
 * number and per IP, and across the service 6 a minute and 200 a day. The send itself
 * also passes the shared gate in lib/wa-send.mjs.
 */
import crypto from 'node:crypto';
import { createLimiter } from '../ratelimit.mjs';
import { normalisePhone } from '../phone.mjs';

export const COOKIE_NAME = 'bona_dash';
export const TRY_COOKIE_NAME = 'bona_dash_try';

/**
 * Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits folded to ASCII. An Arabic
 * keyboard is the normal case here: without this the code read off WhatsApp and typed
 * back would be stripped by `\D` and refused.
 */
export function normaliseDigits(input) {
  return String(input ?? '').replace(/[٠-٩۰-۹]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06F0 ? c - 0x06F0 : c - 0x0660);
  });
}

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
export const PHONE_CODES = 3;
export const IP_CODES = 3;
export const CODE_WINDOW_MS = 10 * 60_000;
export const GLOBAL_PER_MIN = 6;
export const GLOBAL_DAILY_CODES = 200;
export const DAY_MS = 86_400_000;

const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

/** Six digits, uniformly drawn, leading zeros kept. */
export function generateCode(random = crypto.randomInt) {
  return String(random(0, 1_000_000)).padStart(6, '0');
}

/** The message a member receives. The only place the code is ever written. */
export const codeMessage = (code) => `Bona dashboard code: ${code} (valid 10 min)`;

/** Equal-length hex compare that does not leak where two values diverge. */
export function hashEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Parse a `Cookie:` header. Values are percent-decoded; a malformed one is skipped. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  }
  return out;
}

const isHex32 = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

/**
 * @param {object} o
 * @param {ReturnType<import('../db.mjs').openDb>} o.db
 * @param {ReturnType<import('../team.mjs').createTeam>} o.team
 * @param {ReturnType<import('../audit.mjs').createAudit>} [o.audit]
 * @param {object} [o.cfg]  `dashCookieDays`
 * @param {(o: { jid: string, text: string, bypassSwitch: boolean }) => Promise<{ ok?: boolean, error?: string }>} o.sendCode
 */
export function createAuth({ db, team, audit = null, cfg = {}, sendCode, now = () => Date.now(), log = () => {}, random = crypto.randomInt } = {}) {
  if (!team) throw new TypeError('createAuth needs the team store');
  const cookieDays = Number(cfg.dashCookieDays ?? 30) > 0 ? Number(cfg.dashCookieDays ?? 30) : 30;
  const sessionTtlMs = cookieDays * DAY_MS;
  const perPhone = createLimiter({ capacity: PHONE_CODES, perMs: CODE_WINDOW_MS, now });
  const perIp = createLimiter({ capacity: IP_CODES, perMs: CODE_WINDOW_MS, now });
  const perMinute = createLimiter({ capacity: GLOBAL_PER_MIN, perMs: 60_000, now });
  const perDay = createLimiter({ capacity: GLOBAL_DAILY_CODES, perMs: DAY_MS, now });
  const inFlight = new Set();

  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = db.db.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  /**
   * Start a login for `phone`. Always `{ ok: true, nonce }` unless a limit refuses or the
   * input is not a phone number — see "Nothing says who is on the team" above.
   * @returns {Promise<{ ok: true, nonce: string } | { ok: false, error: 'rate_limited'|'bad_phone' }>}
   */
  async function requestCode({ phone, ip } = {}) {
    const digits = normalisePhone(normaliseDigits(phone));
    if (!digits) return { ok: false, error: 'bad_phone' };
    const gates = [
      [perMinute, 'dashcode:global'], [perDay, 'dashcode:daily'],
      [perIp, `dashcode:ip:${ip ?? 'unknown'}`], [perPhone, `dashcode:phone:${digits}`],
    ];
    if (gates.some(([limiter, key]) => !limiter.peek(key).ok)) {
      log({ level: 'warn', evt: 'dash.code_rate_limited' });
      return { ok: false, error: 'rate_limited' };
    }
    for (const [limiter, key] of gates) limiter.take(key);

    const t = now();
    const found = team.getUserByPhone(digits);
    const member = found && found.active ? found : null;
    const code = generateCode(random);
    const nonce = crypto.randomBytes(16).toString('hex');
    // A decoy's hash is of 32 random hex characters: no six digits can ever match it.
    const codeHash = sha256(member ? code : crypto.randomBytes(16).toString('hex'));
    prep('DELETE FROM auth_challenges WHERE expires < ?').run(t - DAY_MS);
    prep('INSERT INTO auth_challenges (challenge_id, user_id, code_hash, nonce_hash, created, expires, attempts, used) VALUES (?,?,?,?,?,?,0,0)')
      .run(`CH-${crypto.randomBytes(8).toString('hex')}`, member?.user_id ?? null, codeHash, sha256(nonce), t, t + CODE_TTL_MS);

    if (member) {
      audit?.record({ userId: member.user_id, action: 'code_request' });
      const job = Promise.resolve()
        .then(() => sendCode({ jid: member.wa_jid, text: codeMessage(code), bypassSwitch: member.role === 'owner' }))
        .then((res) => {
          if (res?.ok) log({ evt: 'dash.code_sent', expiresInS: CODE_TTL_MS / 1000 });
          else log({ level: 'error', evt: 'dash.code_send_failed', reason: res?.error ?? 'unknown' });
        })
        .catch((err) => log({ level: 'error', evt: 'dash.code_send_error', error: String(err?.message ?? err).slice(0, 200) }))
        .finally(() => inFlight.delete(job));
      inFlight.add(job);
    }
    return { ok: true, nonce };
  }

  /** Resolves once every code send started so far has finished. Tests and shutdown use it. */
  const flush = () => Promise.all([...inFlight]);

  const refuse = (error) => {
    log({ level: 'warn', evt: 'dash.login_failed', reason: error });
    return { ok: false, error };
  };

  /**
   * Redeem a code for a session.
   * @returns {{ ok: true, token: string, expires: number, user: object } | { ok: false, error: 'no_request'|'used'|'expired'|'attempts'|'bad_code' }}
   */
  function verify(code, ua = null, { nonce = null } = {}) {
    if (!isHex32(nonce)) return refuse('no_request');
    const t = now();
    return db.transaction(() => {
      const row = prep('SELECT * FROM auth_challenges WHERE nonce_hash = ?').get(sha256(nonce));
      if (!row) return refuse('no_request');
      if (row.used) return refuse('used');
      if (row.expires < t) return refuse('expired');
      if (row.attempts >= MAX_CODE_ATTEMPTS) return refuse('attempts');
      prep('UPDATE auth_challenges SET attempts = attempts + 1 WHERE challenge_id = ?').run(row.challenge_id);
      const cleaned = normaliseDigits(code).replace(/\D/g, '');
      if (cleaned.length !== 6 || !hashEquals(sha256(cleaned), row.code_hash) || !row.user_id) return refuse('bad_code');
      const user = team.getUser(row.user_id);
      if (!user || !user.active) return refuse('no_request');
      prep('UPDATE auth_challenges SET used = 1 WHERE challenge_id = ?').run(row.challenge_id);
      const token = crypto.randomBytes(16).toString('hex');
      const { expires } = db.createAuthSession(token, { now: t, ttlMs: sessionTtlMs, ua, userId: user.user_id });
      team.touchLogin(user.user_id);
      audit?.record({ userId: user.user_id, action: 'login' });
      log({ evt: 'dash.login', days: cookieDays, role: user.role });
      return { ok: true, token, expires, user: team.getUser(user.user_id) };
    });
  }

  /**
   * The active member behind a session token, or null. A session whose member has been
   * deactivated (or that belongs to nobody) is deleted on sight.
   */
  function check(token) {
    if (!isHex32(token)) return null;
    const row = db.checkAuthSession(token, { now: now() });
    if (!row || !hashEquals(sha256(token), row.token_hash)) return null;
    const user = row.user_id ? team.getUser(row.user_id) : null;
    if (!user || !user.active) {
      db.deleteAuthSession(token);
      return null;
    }
    return user;
  }

  function logout(token, user = null) {
    if (typeof token !== 'string' || !token) return false;
    if (user) audit?.record({ userId: user.user_id, action: 'logout' });
    return db.deleteAuthSession(token);
  }

  /* -------------------- cookies -------------------- */

  const attributes = 'HttpOnly; Secure; SameSite=Lax; Path=/';
  const cookieValue = (token) => `${COOKIE_NAME}=${token}; ${attributes}; Max-Age=${Math.round(cookieDays * 86_400)}`;
  const clearedCookie = () => `${COOKIE_NAME}=; ${attributes}; Max-Age=0`;
  const tryCookieValue = (nonce) => `${TRY_COOKIE_NAME}=${nonce}; ${attributes}; Max-Age=${CODE_TTL_MS / 1000}`;
  const clearedTryCookie = () => `${TRY_COOKIE_NAME}=; ${attributes}; Max-Age=0`;

  function addCookie(res, value) {
    const existing = res.getHeader?.('Set-Cookie');
    const list = existing === undefined ? [] : (Array.isArray(existing) ? existing : [existing]);
    res.setHeader('Set-Cookie', [...list, value]);
    return res;
  }

  const setCookie = (res, token) => addCookie(res, cookieValue(token));
  const clearCookie = (res) => addCookie(res, clearedCookie());
  const setTryCookie = (res, nonce) => addCookie(res, tryCookieValue(nonce));
  const clearTryCookie = (res) => addCookie(res, clearedTryCookie());

  function readCookie(req) {
    const value = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
    return isHex32(value) ? value : null;
  }
  function readTryCookie(req) {
    const value = parseCookies(req?.headers?.cookie)[TRY_COOKIE_NAME];
    return isHex32(value) ? value : null;
  }

  return {
    requestCode, verify, check, logout, flush,
    setCookie, clearCookie, readCookie,
    setTryCookie, clearTryCookie, readTryCookie,
    cookieValue, clearedCookie,
    cookieDays, sessionTtlMs,
  };
}
```

Note: the old `pendingCount` export is gone. Before deleting it, check that nothing else reads it:
```bash
cd ~/bona-wt/team-inbox && grep -rn "pendingCount" services/ || echo "no callers"
```
Expected: `no callers` (if a caller exists, remove that use in the same commit).

- [ ] **Step 4: Run**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/dashboard-auth.test.mjs`
Expected: PASS (10 tests). `dashboard-routes.test.mjs` still fails until Tasks 8–10.

- [ ] **Step 5: Commit**

```bash
cd ~/bona-wt/team-inbox && git add services/api/lib/dashboard/auth.mjs services/api/test/dashboard-auth.test.mjs
git commit -m "auth: per-person login codes bound to one challenge and one browser

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: Render — phone login, the signed-in person, the Team page

**Files:**
- Modify: `services/api/lib/dashboard/render.mjs`
- Create: `services/api/lib/dashboard/render-team.mjs`
- Test: `services/api/test/dashboard-render-team.test.mjs` (new)

- [ ] **Step 1: Write the failing tests** — create `services/api/test/dashboard-render-team.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, loginPage } from '../lib/dashboard/render.mjs';
import { teamPage } from '../lib/dashboard/render-team.mjs';

const OWNER = { user_id: 'USR-o', name: 'Abdulaziz Zidan', role: 'owner', phone_e164: '966593296933', active: 1, last_login: null };
const STAFF = { user_id: 'USR-s', name: 'Sara <b>', role: 'staff', phone_e164: '966500000001', active: 1, last_login: 1_790_500_000_000 };

test('the rail shows who is signed in, and only an owner sees Team', () => {
  const asOwner = layout({ title: 'Desk', body: '', me: OWNER });
  assert.match(asOwner, /<b>Abdulaziz Zidan<\/b><s>Owner<\/s>/);
  assert.match(asOwner, /aria-hidden="true">AZ<\/span>/);
  assert.match(asOwner, /href="\/dashboard\/team"/);
  const asStaff = layout({ title: 'Desk', body: '', me: STAFF });
  assert.match(asStaff, /<b>Sara &lt;b&gt;<\/b><s>Team<\/s>/);
  assert.doesNotMatch(asStaff, /href="\/dashboard\/team"/);
});

test('the login asks for a phone number and never says whether it is on the team', () => {
  const ask = loginPage({ step: 'request' });
  assert.match(ask, /name="phone"/);
  assert.match(ask, /inputmode="tel"/);
  const sent = loginPage({ step: 'code', sent: true });
  assert.match(sent, /If that number is on the Bona team/);
  assert.match(sent, /name="code"/);
});

test('the Team page lists people with the right buttons and escapes everything', () => {
  const html = teamPage({ me: OWNER, users: [OWNER, STAFF, { ...STAFF, user_id: 'USR-x', name: 'Old', active: 0 }], never: [{ phone_e164: '966511111111', note: 'cousin', ts: 1 }], sendingEnabled: true, ok: 'added' });
  assert.match(html, /Sara &lt;b&gt;/);
  assert.doesNotMatch(html, /Sara <b>/);
  assert.match(html, /action="\/v1\/admin\/team\/USR-s\/deactivate"/);
  assert.match(html, /action="\/v1\/admin\/team\/USR-x\/reactivate"/);
  assert.doesNotMatch(html, /action="\/v1\/admin\/team\/USR-o\/deactivate"/, 'no button to deactivate yourself');
  assert.match(html, /\+966 51 111 1111/);
  assert.match(html, /cousin/);
  assert.match(html, /name="sending_enabled" value="0"/, 'switch offers to turn sending off');
  assert.match(html, /class="ok"/);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/dashboard-render-team.test.mjs`
Expected: FAIL — `render-team.mjs` missing / no phone field.

- [ ] **Step 3a: Implement in `render.mjs`**

1. After the `NAV` array add:
```js
/** Owner-only rail entries. Kept out of `NAV` so a staff page never even contains the link. */
export const OWNER_NAV = [
  ['/dashboard/team', 'Team', '<circle cx="5.5" cy="5.5" r="2.2"/><circle cx="11" cy="6.5" r="1.8"/><path d="M1.8 13.5c0-2.4 1.7-3.8 3.7-3.8s3.7 1.4 3.7 3.8M9.6 13.5c.2-1.9 1.3-3 2.9-3 1.1 0 1.8.4 1.8.4"/>', 'System'],
];

/** `Abdulaziz Zidan` → `AZ`; one word → its first two letters. */
export function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '·';
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words.at(-1)][0]];
  return letters.join('').toUpperCase();
}
```

2. In `layout(...)`: change the signature to
```js
export function layout({ title, body, active = null, chrome = true, counts = {}, subtitle = null, actions = '', me = null }) {
```
change `const items = NAV.map(([href, label, icon, group]) => {` to
```js
  const entries = me?.role === 'owner' ? [...NAV, ...OWNER_NAV] : NAV;
  const items = entries.map(([href, label, icon, group]) => {
```
and replace the line
```js
    <div class="me"><span class="ava" aria-hidden="true">AA</span><span><b>Abdulaziz</b><s>Principal</s></span></div>
```
with
```js
    <div class="me"><span class="ava" aria-hidden="true">${esc(initials(me?.name ?? 'Abdulaziz Aziz'))}</span><span><b>${esc(me?.name ?? 'Abdulaziz')}</b><s>${me ? (me.role === 'owner' ? 'Owner' : 'Team') : 'Principal'}</s></span></div>
```

3. In `MESSAGES` add these entries (keep the existing ones):
```js
  bad_phone: 'That is not a phone number. Type it the way you would dial it, e.g. 05XXXXXXXX.',
  bad_name: 'A name is needed.',
  duplicate_phone: 'That number is already on the team.',
  bad_role: 'A role is owner or team.',
  last_owner: 'There has to be at least one active owner.',
  not_found: 'No such person.',
  bad_setting: 'That switch does not exist.',
  owner_only: 'Only an owner can do that.',
```

4. Replace `loginPage` with:
```js
export function loginPage({ step = 'request', error = null, sent = false } = {}) {
  const message = error ? `<div class="err">${esc(messageFor(error))}</div>` : '';
  const notice = sent && !error
    ? '<div class="ok">If that number is on the Bona team, a code is on its way to its WhatsApp. It is valid for 10 minutes.</div>'
    : '';
  const body = step === 'code'
    ? `<form method="post" action="/dashboard/login/verify">
  <input type="hidden" name="_dash" value="1">
  <div><label for="code">6-digit code</label>
  <input class="code" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9٠-٩۰-۹]{6}" maxlength="6" required autofocus></div>
  <button type="submit">Sign in</button>
</form>
<p class="muted" style="margin-top:1rem"><a href="/dashboard/login">Send another code</a></p>`
    : `<form method="post" action="/dashboard/login/code">
  <input type="hidden" name="_dash" value="1">
  <div><label for="phone">Your WhatsApp number</label>
  <input id="phone" name="phone" inputmode="tel" autocomplete="tel" dir="ltr" placeholder="05XXXXXXXX" maxlength="20" required autofocus></div>
  <button type="submit">Send me a code</button>
</form>`;
  return layout({
    title: 'Sign in',
    chrome: false,
    body: `<div class="login"><h1>Bona</h1>${message}${notice}${body}<footer>Private dashboard</footer></div>`,
  });
}
```

5. Export the two helpers the Team page needs: change `const scrollTable = (head, rows, empty = 'Nothing yet.') =>` to `export const scrollTable = (head, rows, empty = 'Nothing yet.') =>` and `const messageFor = (code) =>` to `export const messageFor = (code) =>`.

6. Thread `me` through every page renderer so the rail is right on every page. For each of these functions add `me = null` to the destructured parameter object and `me,` to its `layout({ ... })` call: `overviewPage`, `leadsPage`, `leadDetailPage`, `listingsPage` (its signature becomes `listingsPage({ rows, me = null })`), `spendPage`, `integrationsPage`, `messagePage` (signature `messagePage({ title, message, me = null })`; it uses `chrome: false`, so `me` is carried but unused — keep it for a uniform call site). `loginPage` and `logoutPage` stay without `me`. Find them with:
```bash
cd ~/bona-wt/team-inbox/services/api/lib/dashboard && grep -n "^export function .*Page(" render.mjs
```

- [ ] **Step 3b: Create `services/api/lib/dashboard/render-team.mjs`**

```js
/**
 * The Team page (owner only): who can log in, the numbers that are never a client, and
 * the switch for everything the dashboard sends from the owner's WhatsApp.
 * Every write is a form post to /v1/admin/*, like the rest of the dashboard.
 */
import { esc, fullPhone, dateTime, layout, scrollTable, knownError, messageFor } from './render.mjs';

export const TEAM_OK = {
  added: 'Added. They can log in with their WhatsApp number now.',
  deactivated: 'Deactivated. They were logged out everywhere.',
  reactivated: 'Reactivated. They can log in again.',
  role: 'Role changed.',
  never_added: 'Added to the never-a-client list.',
  never_removed: 'Removed from the never-a-client list.',
  setting: 'Saved.',
};

const post = (action, label, fields = {}, cls = '') => `<form method="post" action="${esc(action)}" style="display:inline;margin:0 .35rem 0 0">` +
  '<input type="hidden" name="_dash" value="1">' +
  Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('') +
  `<button type="submit"${cls ? ` class="${esc(cls)}"` : ''}>${esc(label)}</button></form>`;

export function teamPage({ me, users = [], never = [], sendingEnabled = true, ok = null, error = null }) {
  const flash = knownError(error)
    ? `<div class="err">${esc(messageFor(error))}</div>`
    : (ok && Object.hasOwn(TEAM_OK, ok) ? `<div class="ok">${esc(TEAM_OK[ok])}</div>` : '');

  const people = users.map((u) => {
    const self = me && u.user_id === me.user_id;
    const buttons = [];
    if (u.active && !self) buttons.push(post(`/v1/admin/team/${u.user_id}/deactivate`, 'Deactivate'));
    if (!u.active) buttons.push(post(`/v1/admin/team/${u.user_id}/reactivate`, 'Reactivate'));
    if (u.active && !self) {
      const to = u.role === 'owner' ? 'staff' : 'owner';
      buttons.push(post(`/v1/admin/team/${u.user_id}/role`, to === 'owner' ? 'Make owner' : 'Make team', { role: to }));
    }
    return `<tr${u.active ? '' : ' style="opacity:.55"'}><td dir="auto">${esc(u.name)}${self ? ' <span class="muted">(you)</span>' : ''}</td>` +
      `<td dir="ltr">${esc(fullPhone(u.phone_e164))}</td><td>${u.role === 'owner' ? 'Owner' : 'Team'}</td>` +
      `<td>${u.active ? 'Active' : 'Deactivated'}</td><td>${u.last_login ? esc(dateTime(u.last_login)) : '—'}</td>` +
      `<td class="wrap">${buttons.join('')}</td></tr>`;
  });

  const nevers = never.map((n) => `<tr><td dir="ltr">${esc(fullPhone(n.phone_e164))}</td><td dir="auto">${esc(n.note ?? '')}</td>` +
    `<td>${post('/v1/admin/never/remove', 'Remove', { phone: n.phone_e164 })}</td></tr>`);

  const body = `${flash}
<h2>People</h2>
<p class="sub">Everyone here logs in with a 6-digit code sent to their own WhatsApp from your number, and sees the same dashboard you do. Only owners see this page.</p>
${scrollTable('<th>Name</th><th>WhatsApp</th><th>Role</th><th>Status</th><th>Last login</th><th></th>', people, 'Nobody yet.')}
<form method="post" action="/v1/admin/team" class="card" style="display:grid;gap:10px;max-width:420px;margin-top:14px">
  <input type="hidden" name="_dash" value="1">
  <b>Add a person</b>
  <label for="t-name">Name</label><input id="t-name" name="name" maxlength="80" required dir="auto">
  <label for="t-phone">WhatsApp number</label><input id="t-phone" name="phone" inputmode="tel" dir="ltr" placeholder="05XXXXXXXX" maxlength="20" required>
  <label for="t-role">Role</label><select id="t-role" name="role"><option value="staff">Team</option><option value="owner">Owner</option></select>
  <button type="submit">Add</button>
</form>

<h2 style="margin-top:28px">Never a client</h2>
<p class="sub">Family, friends, drivers: chats with these numbers are never picked up, stored or shown, whatever they write.</p>
${scrollTable('<th>Number</th><th>Note</th><th></th>', nevers, 'The list is empty.')}
<form method="post" action="/v1/admin/never" class="card" style="display:grid;gap:10px;max-width:420px;margin-top:14px">
  <input type="hidden" name="_dash" value="1">
  <label for="n-phone">Number</label><input id="n-phone" name="phone" inputmode="tel" dir="ltr" placeholder="05XXXXXXXX" maxlength="20" required>
  <label for="n-note">Note (only you see it)</label><input id="n-note" name="note" maxlength="120" dir="auto">
  <button type="submit">Add to the list</button>
</form>

<h2 style="margin-top:28px">Sending from your WhatsApp</h2>
<p class="sub">${sendingEnabled
    ? 'On. The dashboard may send login codes to your team (and, later, replies to clients) from your number.'
    : 'Off. Nothing is sent from your number except your own login code.'}</p>
${post('/v1/admin/settings', sendingEnabled ? 'Turn sending off' : 'Turn sending on', { sending_enabled: sendingEnabled ? '0' : '1' })}`;

  return layout({ title: 'Team', active: '/dashboard/team', me, body: `<h1>Team</h1>${body}` });
}
```

If the stylesheet has no `.card` or `h2` rule the page still renders (unstyled boxes); match the look of `spendPage`'s form by reusing whatever class it uses (`grep -n "<form" render.mjs | head`) and adjust the two `class="card"` attributes accordingly.

- [ ] **Step 4: Run**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/dashboard-render-team.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/bona-wt/team-inbox && git add services/api/lib/dashboard/render.mjs services/api/lib/dashboard/render-team.mjs services/api/test/dashboard-render-team.test.mjs
git commit -m "dashboard: phone login, the signed-in person on every page, Team page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: Routes — the person behind every request, real actors, Team routes

**Files:**
- Modify: `services/api/lib/dashboard/routes.mjs`

- [ ] **Step 1: Imports and factory arguments**

Add to the imports:
```js
import { teamPage } from './render-team.mjs';
import { TeamError } from '../team.mjs';
```
Change the factory signature to accept the new collaborators:
```js
export function createDashboardRoutes({
  db, cfg = {}, inventory = null, fanout = null, app = null,
  sendWhatsApp = null, probeRetell = null,
  team, audit = null, sendCode = null,
  auth = null, stats = null, log = () => {}, now = () => Date.now(),
} = {}) {
  if (!team) throw new TypeError('createDashboardRoutes needs the team store');
  const authenticator = auth ?? createAuth({ db, team, audit, cfg, sendCode, now, log });
```
(`sendWhatsApp` stays: other code in this file may pass it on; it is no longer used for login.)

- [ ] **Step 2: Resolve the person** — replace `signedIn`:
```js
  const sessionToken = (req) => authenticator.readCookie(req);
  /** The active member behind this request's cookie, or null. */
  const currentUser = (req) => {
    const token = sessionToken(req);
    return token ? authenticator.check(token) : null;
  };
  const signedIn = (req) => Boolean(currentUser(req));
```

- [ ] **Step 3: Login by phone** — in `loginCode`, replace
```js
    const out = await authenticator.requestCode(ip);
    if (!out.ok) return toLogin(res, `?step=code&error=${encodeURIComponent(out.error)}`, 303);
```
with
```js
    const out = await authenticator.requestCode({ phone: parsed.fields.phone, ip });
    if (!out.ok) {
      const step = out.error === 'bad_phone' ? '' : 'step=code&';
      return toLogin(res, `?${step}error=${encodeURIComponent(out.error)}`, 303);
    }
```
In `logout`, replace `if (token) authenticator.logout(token);` with `if (token) authenticator.logout(token, currentUser(req));`.

- [ ] **Step 4: Pass `me` to every page** — in `handleHtml`, replace
```js
    /* --- everything else needs the cookie --- */
    if (!signedIn(req)) return toLogin(res);
```
with
```js
    /* --- everything else needs a signed-in, active member --- */
    const me = currentUser(req);
    if (!me) return toLogin(res);
```
and give each view handler `me`: change the dispatch lines to
```js
    if (p === '/dashboard') return overview({ res, url, me });
    if (p === '/dashboard/leads') return leads({ res, url, me });
    const leadMatch = LEAD_PATH.exec(p);
    if (leadMatch) return leadDetail({ res, url, me }, leadMatch[1]);
    if (p === '/dashboard/listings') return listings({ res, me });
    if (p === '/dashboard/spend') return spend({ res, url, me });
    if (p === '/dashboard/integrations') return integrations({ res, me });
    if (p === '/dashboard/team') return teamView({ res, url, me });
    return sendHtml(res, 404, messagePage({ title: 'Not found', message: 'There is no such page.', me }));
```
Then in each handler (`overview`, `leads`, `leadDetail`, `listings`, `spend`, `integrations`) add `me` to the destructured argument and pass `me` into the page renderer call (e.g. `overviewPage({ ..., me })`, `listingsPage({ rows: listingRows(), me })`, and the `messagePage` 404 inside `leadDetail`).

Add the Team view next to the other views:
```js
  function teamView({ res, url, me }) {
    if (me.role !== 'owner') return sendHtml(res, 403, messagePage({ title: 'Owners only', message: 'Only an owner can open the Team page.', me }));
    return sendHtml(res, 200, teamPage({
      me,
      users: team.listUsers(),
      never: team.listNever(),
      sendingEnabled: team.sendingEnabled(),
      ok: url.searchParams.get('ok'),
      error: url.searchParams.get('error'),
    }));
  }
```

- [ ] **Step 5: Real actors on writes** — `setStage` and `addNote` take the person. Change their signatures to `function setStage({ res, fields, form, me }, leadId)` / `function addNote({ res, fields, form, me }, leadId)`; in `setStage` replace `{ actor: 'owner', note, valueSar, now: t }` with `{ actor: me.name, note, valueSar, now: t }` and after the `log({ evt: 'dash.stage', ... })` line add `audit?.record({ userId: me.user_id, action: 'stage', target: leadId, meta: { stage } });`; in `addNote` replace `meta: { note, actor: 'owner' }` with `meta: { note, actor: me.name, actor_id: me.user_id }` and after `log({ evt: 'dash.note', leadId });` add `audit?.record({ userId: me.user_id, action: 'note', target: leadId });`. In `saveSpend`, change the signature to accept `me` too (unused for now, audit comes with Phase 5 reports).

- [ ] **Step 6: Team writes (owner only)** — add these handlers before `/* -------------------- dispatch -------------------- */`:
```js
  /* -------------------- team (owner only) -------------------- */

  const teamBack = (query) => `/dashboard/team?${query}`;
  function teamWrite({ res, form, me }, fn, okKey) {
    try {
      fn();
      return answer(res, { form, back: teamBack(`ok=${okKey}`), status: 200, payload: { ok: true } });
    } catch (err) {
      if (!(err instanceof TeamError)) throw err;
      return answer(res, { form, back: teamBack(`error=${encodeURIComponent(err.code)}`), status: err.code === 'not_found' ? 404 : 400, payload: { error: err.code } });
    }
  }

  function addPerson(ctx) {
    const { fields, me } = ctx;
    return teamWrite(ctx, () => {
      const u = team.addUser({ name: fields.name, phone: fields.phone, role: fields.role === 'owner' ? 'owner' : 'staff' });
      audit?.record({ userId: me.user_id, action: 'team_add', target: u.user_id, meta: { role: u.role } });
    }, 'added');
  }
  function changePerson(ctx, userId, what) {
    const { fields, me } = ctx;
    if (what === 'deactivate') {
      return teamWrite(ctx, () => { team.deactivateUser(userId); audit?.record({ userId: me.user_id, action: 'team_deactivate', target: userId }); }, 'deactivated');
    }
    if (what === 'reactivate') {
      return teamWrite(ctx, () => { team.reactivateUser(userId); audit?.record({ userId: me.user_id, action: 'team_reactivate', target: userId }); }, 'reactivated');
    }
    return teamWrite(ctx, () => {
      const role = String(fields.role ?? '');
      team.setRole(userId, role);
      audit?.record({ userId: me.user_id, action: 'team_role', target: userId, meta: { role } });
    }, 'role');
  }
  function neverWrite(ctx, remove) {
    const { fields, me } = ctx;
    if (remove) {
      return teamWrite(ctx, () => { team.removeNever(fields.phone); audit?.record({ userId: me.user_id, action: 'never_remove' }); }, 'never_removed');
    }
    return teamWrite(ctx, () => { team.addNever({ phone: fields.phone, note: fields.note, by: me.user_id }); audit?.record({ userId: me.user_id, action: 'never_add' }); }, 'never_added');
  }
  function saveSetting(ctx) {
    const { fields, me } = ctx;
    return teamWrite(ctx, () => {
      if (!Object.hasOwn(fields, 'sending_enabled')) throw new TeamError('bad_setting');
      const value = String(fields.sending_enabled) === '0' ? '0' : '1';
      team.setSetting('sending_enabled', value, { by: me.user_id });
      audit?.record({ userId: me.user_id, action: 'setting', target: 'sending_enabled', meta: { value } });
    }, 'setting');
  }
```
(The audit log records never-list changes without the number: the number is on the list itself, and the audit log is not a second copy of personal data.)

- [ ] **Step 7: Dispatch** — add the path matcher next to `ADMIN_LEAD`:
```js
  const ADMIN_TEAM = /^\/v1\/admin\/team\/([A-Za-z0-9_-]{1,64})\/(deactivate|reactivate|role)$/;
```
In `handleAdmin`, replace `if (!signedIn(req)) return sendJson(res, 401, { error: 'unauthorised' });` with
```js
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { error: 'unauthorised' });
```
and replace the block from `const writes = (leadMatch && leadMatch[2]) || (p === '/v1/admin/spend' ? 'spend' : null);` to the end of `handleAdmin` with:
```js
    const teamMatch = ADMIN_TEAM.exec(p);
    const ownerWrite = Boolean(teamMatch) || p === '/v1/admin/team' || p === '/v1/admin/never' || p === '/v1/admin/never/remove' || p === '/v1/admin/settings';
    const writes = (leadMatch && leadMatch[2]) || (p === '/v1/admin/spend' ? 'spend' : null) || (ownerWrite ? 'team' : null);
    if (!writes) return sendJson(res, 404, { error: 'not_found' });

    const parsed = await fieldsOf(req);
    if (!parsed.ok) return refuseBody(req, res, parsed);
    if (!hasMarker(req, parsed.fields)) {
      log({ level: 'warn', evt: 'dash.marker_missing', path: p, ip });
      return sendJson(res, 403, { error: 'forbidden', message: 'X-Bona-Dash: 1 (or _dash=1) is required on a write' });
    }
    if (ownerWrite && me.role !== 'owner') {
      log({ level: 'warn', evt: 'dash.owner_only', path: p });
      return sendJson(res, 403, { error: 'owner_only' });
    }

    const ctx = { res, fields: parsed.fields, form: parsed.form, me };
    if (writes === 'stage') return setStage(ctx, leadMatch[1]);
    if (writes === 'note') return addNote(ctx, leadMatch[1]);
    if (writes === 'spend') return saveSpend(ctx);
    if (teamMatch) return changePerson(ctx, teamMatch[1], teamMatch[2]);
    if (p === '/v1/admin/team') return addPerson(ctx);
    if (p === '/v1/admin/never') return neverWrite(ctx, false);
    if (p === '/v1/admin/never/remove') return neverWrite(ctx, true);
    return saveSetting(ctx);
  }
```

- [ ] **Step 8: Syntax check and commit** (behaviour is tested in Task 10 once `index.mjs` wires `team`):

```bash
cd ~/bona-wt/team-inbox/services && node --check api/lib/dashboard/routes.mjs && echo OK
cd ~/bona-wt/team-inbox && git add services/api/lib/dashboard/routes.mjs
git commit -m "dashboard routes: the person behind every request, real actors, owner-only Team writes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Expected: `OK`.

### Task 9: Poller — team and never-list numbers are not clients

**Files:**
- Modify: `services/api/lib/wa-poller.mjs`
- Modify: `services/api/test/wa-poller.test.mjs`

- [ ] **Step 1: Write the failing test** — in `services/api/test/wa-poller.test.mjs`, change the harness signature to
```js
function harness({ windows = [], env = {}, seedSession = true, isExcluded } = {}) {
```
and pass it through: in the `createPoller({ ... })` call inside the harness add the line `...(isExcluded ? { isExcluded } : {}),`. Then append:
```js
/* ---------------- (m) team and never-list numbers ---------------- */

test('(m) a team or never-a-client number is never a lead or a reply, even with "Bona" or a Ref line', async () => {
  const excluded = new Set(['966500000000']);
  const h = harness({
    isExcluded: (digits) => excluded.has(digits),
    windows: [[
      msg({ id: 'K-code', fromMe: true, text: 'Bona dashboard code: 123456 (valid 10 min)' }),
      msg({ id: 'K-word', text: 'I am handling the Bona client today' }),
      msg({ id: 'K-ref', text: 'Ref BONA-W003 · K7Q2XR' }),
    ]],
  });
  const tally = await h.poller.tick();
  assert.equal(tally.matched, 0);
  assert.equal(tally.replies, 0);
  assert.equal(tally.ignored, 3);
  assert.equal(h.leads().length, 0);
  assert.equal(h.sent.length, 0, 'no new-lead note either');
  h.cleanup();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/wa-poller.test.mjs`
Expected: the new test FAILS (a lead is created from `K-ref`).

- [ ] **Step 3: Implement** — in `services/api/lib/wa-poller.mjs`:

Change the factory signature to
```js
export function createPoller({ db, cfg = {}, findMessages = null, sendWhatsApp = null, isExcluded = () => false, log = () => {}, now = () => Date.now() } = {}) {
```
Add to the module header's list, after rule 5's paragraph: ` * Before any rule: a team member's number (active or not) and a number on the owner's "never a client" list (lib/team.mjs) are skipped outright — not a lead, not a reply, not stored.`

In the tick loop, right after
```js
        if (db.waSeenHas(rec.id)) { tally.ignored += 1; continue; }
```
insert
```js
        // A colleague is not a client (our own login codes to them even say "Bona"), and
        // the owner's never-a-client list is absolute. 2026-09-27 design §3.5.
        const recPhone = jidsOf(rec).phone;
        if (recPhone && isExcluded(recPhone)) { tally.ignored += 1; continue; }
```

- [ ] **Step 4: Run**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/wa-poller.test.mjs`
Expected: PASS (37 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/bona-wt/team-inbox && git add services/api/lib/wa-poller.mjs services/api/test/wa-poller.test.mjs
git commit -m "poller: team and never-a-client numbers are not clients

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: Wiring + route tests

**Files:**
- Modify: `services/api/index.mjs`
- Modify: `services/api/test/dashboard-routes.test.mjs`

- [ ] **Step 1: Wire it** — in `services/api/index.mjs`:

Imports (next to the existing ones):
```js
import { sendText, waConfig } from './lib/wa.mjs';
import { createTeam } from './lib/team.mjs';
import { createAudit } from './lib/audit.mjs';
import { createSender } from './lib/wa-send.mjs';
import { bareJid } from './lib/evolution.mjs';
```
(replace the existing `import { sendText } from './lib/wa.mjs';` line with the first one).

After `const sendWhatsApp = options.sendWhatsApp ?? ((text) => sendText(text, { env: cfg.env }));` add:
```js
  // Team accounts (2026-09-27 design §3). The owner is (re)seeded on every start from
  // BONA_OWNER_JID; everyone else is added on the Team page.
  const team = options.team ?? createTeam(db);
  team.ensureOwner({ phone: bareJid(waConfig(cfg.env ?? {}).ownerJid), name: cfg.env?.BONA_OWNER_NAME ?? 'Abdulaziz' });
  const audit = options.audit ?? createAudit(db, { log });
  const sender = options.sender ?? createSender({ env: cfg.env ?? {}, team, log });
  const sendCode = options.sendCode ?? ((o) => sender.sendTo({ ...o, kind: 'code' }));
```
Change the poller line to pass the exclusion:
```js
  const poller = options.poller ?? (cfg.waPoll ? createPoller({ db, cfg, sendWhatsApp, isExcluded: team.isExcludedPhone, log }) : null);
```
Add `team, audit,` to the `app` object literal (`const app = { cfg, inventory, store, db, retell, tools, limiters, fanout, budget, team, audit, poller: ... }`), and change the dashboard construction to
```js
  const dashboard = options.dashboard ?? createDashboardRoutes({
    db, cfg, inventory, fanout, app, log, sendWhatsApp, probeRetell, team, audit, sendCode,
  });
```

- [ ] **Step 2: Harness logs in by phone** — in `services/api/test/dashboard-routes.test.mjs`:

In `withDash`, next to `const sent = [];` add `const sentTo = [];`, and in the `createApp({ ... })` options add
```js
    sendCode: overrides.sendCode ?? (async ({ jid, text }) => { sent.push(text); sentTo.push(jid); return { ok: true }; }),
```
Replace `askForCode` and `login` with:
```js
  async function askForCode({ phone = '0593296933', ...opts } = {}) {
    const before = sent.length;
    const res = await postForm('/dashboard/login/code', { _dash: '1', phone }, opts);
    await app.dashboard?.auth?.flush?.();
    const code = sent.length > before ? (/(\d{6})/.exec(sent.at(-1) ?? '')?.[1] ?? null) : null;
    const nonce = cookieValue(res, 'bona_dash_try');
    return { res, code, nonce, tryCookie: nonce ? `bona_dash_try=${nonce}` : '' };
  }

  async function login({ phone = '0593296933' } = {}) {
    const asked = await askForCode({ phone });
    assert.equal(asked.res.status, 303, 'the code request redirects to the code form');
    assert.ok(asked.code, `no code was sent to ${phone}`);
    assert.ok(asked.nonce, 'the code request must hand the browser a try nonce');
    const verified = await postForm('/dashboard/login/verify', { _dash: '1', code: asked.code }, { cookie: asked.tryCookie });
    const session = cookieValue(verified, 'bona_dash');
    assert.ok(session, 'the verify step must set the session cookie');
    return { cookie: `bona_dash=${session}`, code: asked.code, nonce: asked.nonce, res: verified };
  }
```
`index.mjs` already sets `app.dashboard = dashboard;` (line ~747), and the routes object exposes `auth`, so `flush()` is reachable. (The send is started in a microtask before the HTTP answer, so it has normally already happened; `flush()` makes that certain.) Add `sentTo` to the object passed to `fn(...)`.

- [ ] **Step 3: Run the old route tests and fix only the intended behaviour changes**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/dashboard-routes.test.mjs 2>&1 | grep -E "^not ok|✖" | head -40`

For each failing test, the failure must be one of these intended changes; update that test's assertion to the new behaviour and nothing else:
1. the code request posts a `phone` field; a missing/invalid phone now answers `303 → /dashboard/login?error=bad_phone` (was: always sent to the owner);
2. the "code sent" notice text is now "If that number is on the Bona team, a code is on its way…";
3. global code limits are now 6/min and 200/day (were 1/min, 60/day) plus 3/10 min per phone — tests asserting "a second request within a minute is refused" now need 7 requests, or the per-phone 4th request;
4. a send failure no longer shows `?error=send_failed` (the answer is returned before sending) — assert the `sent=1` redirect and a `dash.code_send_failed` log line instead;
5. the rail shows the signed-in person (`Abdulaziz` / `Owner`) and, for the owner, a Team link.
Any other failure is a bug in Tasks 6–10: fix the code, not the test.

- [ ] **Step 4: Add route tests for the new behaviour** — append to `services/api/test/dashboard-routes.test.mjs`:
```js
/* ---------------- team accounts ---------------- */

test('an unknown number gets the same answer and nothing is sent', async () => {
  await withDash({}, async ({ askForCode, sent }) => {
    const before = sent.length;
    const asked = await askForCode({ phone: '0511111111' });
    assert.equal(asked.res.status, 303);
    assert.equal(asked.res.headers.get('location'), '/dashboard/login?step=code&sent=1');
    assert.ok(asked.nonce);
    assert.equal(sent.length, before);
  });
});

test('the owner adds a person, who logs in with a code sent to their own WhatsApp and cannot open Team', async () => {
  await withDash({}, async ({ get, postForm, login, sentTo }) => {
    const owner = await login();
    const team = await get('/dashboard/team', { cookie: owner.cookie });
    assert.equal(team.status, 200);
    assertLocked(team);
    const add = await postForm('/v1/admin/team', { _dash: '1', name: 'Sara', phone: '0500000001', role: 'staff' }, { cookie: owner.cookie });
    assert.equal(add.status, 303);
    assert.equal(add.headers.get('location'), '/dashboard/team?ok=added');

    const staff = await login({ phone: '0500000001' });
    assert.equal(sentTo.at(-1), '966500000001@s.whatsapp.net');
    const desk = await (await get('/dashboard', { cookie: staff.cookie })).text();
    assert.match(desk, /<b>Sara<\/b><s>Team<\/s>/);
    assert.doesNotMatch(desk, /href="\/dashboard\/team"/);
    assert.equal((await get('/dashboard/team', { cookie: staff.cookie })).status, 403);
    const denied = await postForm('/v1/admin/team', { _dash: '1', name: 'X', phone: '0500000002' }, { cookie: staff.cookie });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'owner_only' });
  });
});

test('deactivating a person logs them out everywhere at once', async () => {
  await withDash({}, async ({ app, get, postForm, login }) => {
    const owner = await login();
    await postForm('/v1/admin/team', { _dash: '1', name: 'Sara', phone: '0500000001' }, { cookie: owner.cookie });
    const staff = await login({ phone: '0500000001' });
    assert.equal((await get('/dashboard', { cookie: staff.cookie })).status, 200);
    const id = app.team.getUserByPhone('0500000001').user_id;
    const off = await postForm(`/v1/admin/team/${id}/deactivate`, { _dash: '1' }, { cookie: owner.cookie });
    assert.equal(off.headers.get('location'), '/dashboard/team?ok=deactivated');
    const after = await get('/dashboard', { cookie: staff.cookie });
    assert.equal(after.status, 302);
    assert.equal(after.headers.get('location'), '/dashboard/login');
    const me = app.team.getUserByPhone('0593296933').user_id;
    const self = await postForm(`/v1/admin/team/${me}/deactivate`, { _dash: '1' }, { cookie: owner.cookie });
    assert.equal(self.headers.get('location'), '/dashboard/team?error=last_owner');
  });
});

test('a stage change and a note carry the name of the person who made them', async () => {
  await withDash({}, async ({ app, db, postForm, login }) => {
    const id = seedLead(db);
    const owner = await login();
    await postForm('/v1/admin/team', { _dash: '1', name: 'Sara', phone: '0500000001' }, { cookie: owner.cookie });
    const staff = await login({ phone: '0500000001' });
    await postForm(`/v1/admin/leads/${id}/stage`, { _dash: '1', stage: 'contacted' }, { cookie: staff.cookie });
    assert.equal(db.stageHistory(id).at(-1).actor, 'Sara');
    await postForm(`/v1/admin/leads/${id}/note`, { _dash: '1', note: 'called her' }, { cookie: staff.cookie });
    assert.equal(db.touchpointsForLead(id).at(-1).meta.actor, 'Sara');
    // The two may share a millisecond, so assert membership rather than order.
    const actions = app.audit.recent(10).map((r) => r.action);
    assert.ok(actions.includes('note') && actions.includes('stage'), actions.join(','));
  });
});

test('the never list and the sending switch are owner-only and take effect', async () => {
  await withDash({}, async ({ app, postForm, login }) => {
    const owner = await login();
    await postForm('/v1/admin/never', { _dash: '1', phone: '0511111111', note: 'cousin' }, { cookie: owner.cookie });
    assert.equal(app.team.isExcludedPhone('966511111111'), true);
    await postForm('/v1/admin/settings', { _dash: '1', sending_enabled: '0' }, { cookie: owner.cookie });
    assert.equal(app.team.sendingEnabled(), false);
    await postForm('/v1/admin/settings', { _dash: '1', sending_enabled: '1' }, { cookie: owner.cookie });
    assert.equal(app.team.sendingEnabled(), true);
  });
});
```
(`seedLead` seeds a lead whose phone is the owner's number; that is fine here — the poller is not running in route tests.)

- [ ] **Step 5: Full suite**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/*.test.mjs 2>&1 | tail -8`
Expected: `ℹ fail 0`; pass count = baseline − 1 (removed db auth-code test) − old auth tests + new tests.

- [ ] **Step 6: Commit**

```bash
cd ~/bona-wt/team-inbox && git add services/api/index.mjs services/api/test/dashboard-routes.test.mjs
git commit -m "api: wire team accounts; route tests log in by phone

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: Docs, reviews, ship Phase 1

**Files:**
- Modify: `services/README.md` (section `### Dashboard`)

- [ ] **Step 1: README** — in `services/README.md` under `### Dashboard`, replace the paragraph that starts `**Login.**` and the following paragraph about the `bona_dash_try` nonce with:
```markdown
**Login (team accounts, since 2026-09).** `GET /dashboard/login` asks for a WhatsApp number.
`POST /dashboard/login/code` — if the number belongs to an active member of the team
(`users`, managed on the owner-only **Team** page), six digits go to that member's WhatsApp
from the owner's number (the owner's own code goes to his own chat). Any other number gets
the same answer, the same `bona_dash_try` cookie and a decoy challenge no code opens, and the
answer is returned before anything is sent, so the login says nothing about who is on the
team. A challenge belongs to one person and one browser (found by the nonce, never by the
code); five wrong guesses burn it; it lives 10 minutes. Limits: 3 per 10 min per number and
per IP, 6 a minute and 200 a day overall; the send also passes the shared gate in
`lib/wa-send.mjs` (Sending switch on the Team page; 20/min, 500/day, 6/min per recipient).
Sessions carry the member; deactivating someone deletes their sessions and codes at once.
Every stage change and note records who made it, and `audit_log` records logins, team
changes and switches. Team numbers and the owner's never-a-client list are skipped by the
WhatsApp poller.
```

- [ ] **Step 2: Commit docs**
```bash
cd ~/bona-wt/team-inbox && git add services/README.md && git commit -m "docs: dashboard login is per person now

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 3: Claude review** — use superpowers:requesting-code-review on `git diff origin/main...HEAD -- services/`. Focus: auth (decoy, nonce binding, limits order, deactivation), owner-only enforcement on every Team write, no PII/code in logs or audit, migration safety on the live db.

- [ ] **Step 4: Codex review** (second opinion, owner rule):
```bash
cd ~/bona-wt/team-inbox && codex exec --sandbox read-only "Review the diff origin/main...HEAD in services/ (Bona dashboard Phase 1: team accounts). Spec: docs/superpowers/specs/2026-09-27-dashboard-team-inbox-design.md §3. Look for: auth bypass or account enumeration, a staff member reaching owner-only writes, sessions surviving deactivation, codes or phone numbers in logs/audit, migration v3 failing on an existing bona.db (auth_sessions rows without user_id), poller exclusions missing a path. Verdict first, then findings ranked by severity with file:line and a fix."
```
Present both reviews to yourself, fix what is real (with tests), re-run the full suite.

- [ ] **Step 5: Test the migration against a copy of the live db — on the VPS, so client data never leaves it**

Copy the branch's `lib/` up (code only), migrate a *copy* of the live db with the VPS's pinned Node, print counts, delete everything:
```bash
cd ~/bona-wt/team-inbox/services/api
ssh hermes-vps 'rm -rf /tmp/bona-p1 && mkdir -p /tmp/bona-p1'
scp -q -r lib hermes-vps:/tmp/bona-p1/lib
ssh hermes-vps 'set -e; N=/home/azoz/.local/opt/node-v24.19.0-linux-x64/bin/node
  cp ~/bona-data/bona.db /tmp/bona-p1/test.db
  cd /tmp/bona-p1 && $N --input-type=module -e "
    const { openDb } = await import(\"/tmp/bona-p1/lib/db.mjs\");
    const { createTeam } = await import(\"/tmp/bona-p1/lib/team.mjs\");
    const s = openDb(\"/tmp/bona-p1/test.db\");
    const before = s.countLeads({});
    const o = createTeam(s).ensureOwner({ phone: \"966593296933\", name: \"Abdulaziz\" });
    console.log(\"user_version\", s.db.prepare(\"PRAGMA user_version\").get().user_version, \"owner\", o.role,
      \"sessions_without_user\", s.db.prepare(\"SELECT COUNT(*) n FROM auth_sessions WHERE user_id IS NULL\").get().n,
      \"leads\", before, s.countLeads({}));
    s.close();"
  rm -rf /tmp/bona-p1'
```
Expected: `user_version 3 owner owner sessions_without_user 0 leads N N` (same N twice). The live `~/bona-data/bona.db` is untouched; `/tmp/bona-p1` (with the copy) is removed at the end.

- [ ] **Step 6: PR, merge, deploy**
```bash
cd ~/bona-wt/team-inbox && git push -u origin feat/team-inbox
ROLLBACK=$(git rev-parse origin/main)
gh pr create --title "Dashboard: team accounts (Phase 1)" --body "Phase 1 of docs/superpowers/specs/2026-09-27-dashboard-team-inbox-design.md — per-person WhatsApp-code login, owner-only Team page, never-a-client list, sending switch, audit log, poller exclusions. Claude + Codex reviewed. Rollback point: ${ROLLBACK}.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge --squash --delete-branch=false
ssh hermes-vps 'cp ~/bona-data/bona.db ~/bona-data/bona.db.bak-$(date +%Y%m%d-%H%M%S)'
ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh
```
Expected: deploy prints `tests green` and a healthy `/health`. Note: `--delete-branch=false` keeps `feat/team-inbox` for Phases 2–4; after the squash-merge, rebase it on `origin/main` before Phase 2 (`git fetch && git rebase origin/main`), since squash merges make the branch look unmerged (known repo gotcha).

- [ ] **Step 7: Verify live**
```bash
curl -s https://api.bona-real-estate.com/health | head -c 400; echo
~/.claude/scripts/chrome-debug.sh
node ~/.claude/scripts/browse.mjs https://api.bona-real-estate.com/dashboard/login /tmp/claude-1001/p1-login.png
```
Expected: health ok (db ok, poller running); the login page shows the phone field. Do **not** request a code for the owner yourself; the owner's existing session keeps working (sessions were adopted by his user). Ask the owner to open `/dashboard/team`, add one employee, and have them log in.

- [ ] **Step 8: Tell the owner** (plain words, mobile-short): what's live, the Team page link, how to add a person, rollback SHA, what Phase 2 is. Update Claude memory `bona-dashboard-team-inbox-2026-09-27.md` + the MEMORY.md line, and the shared-memory handoff (`--scope claude-project:fed94f6b4de219192b28 --id bona-dashboard-team-inbox-handoff`).

---

## Phase 2 — Bona inbox (outline; expand with writing-plans before coding)

Spec §4. Pre-work: **verify live, read-only** on the VPS (a) the per-jid `findMessages` filter shape (`where: { key: { remoteJid } }`) and paging, (b) the `sendText` response body shape (`key.id`), (c) whether `sendText` to an `…@lid` number is delivered — test only against the owner's own second phone, with the owner. Record results in the Phase 2 detailed plan.

Tasks (each TDD):
1. Schema v4: lead columns `inbox_state`, `inbox_since`, `handler_user_id`, `last_msg_ts`, `needs_human`; tables `wa_messages`, `wa_outbox`, `inbox_reads`, `wa_gaps`; migration assigning `in`/`unsure` to existing leads (§4.1 rules).
2. `lib/inbox/eligibility.mjs` (pure): certain vs unsure for inbound; owner-outbound triggers (Bona link, legacy host, listing id, document named "bona"/listing id); split `KEYWORD_RE`.
3. `lib/inbox/store.mjs`: upsert messages, media placeholders, reads/unread counts, gaps, retention purge (5 years after `last_msg_ts`), `out` purge.
4. Poller: store every record of `in` chats; owner-outbound joins; outbox reconciliation (key id, uncertain resolution); `owner_number` sender; handler default; keep `first_reply_ts`; truncation split (no silent loss); `wa_gaps`; `BONA_WA_POLL_MS` 20 s.
5. `lib/inbox/backfill.mjs`: 24 h on automatic joins, 30 days on owner-button joins.
6. `wa-send.mjs` extension: client replies only to `in` chats, phone-jid resolution + `@lid` refusal, outbox with `send_id` idempotency, uncertain state, stale-view guard input.
7. Screens `render-inbox.mjs`: list (unread first), thread, reply box, handler picker, Unsure tab + Add-by-phone (owner), nav badge; routes + audit actions (`reply_sent`, `inbox_move`, `inbox_out`, `inbox_add`, `handler`).
8. Privacy pages AR/EN (`src/pages/privacy.astro`, `src/pages/ar/privacy.astro`) — site deploy via main.
9. Hostile tests (unsure/never/out chats unreadable and unsendable; double submit sends once; uncertain not retried).
10. Reviews, deploy, **STOP: first real client reply together with the owner**, then report.

Acceptance: a Ref-code test message from the owner's second phone appears in the inbox within a minute; a reply from the dashboard arrives on that phone from the owner's number; the Hermes `bona-unanswered-leads` watchdog still sees `first_reply_ts`.

## Phase 3 — Phone alerts (outline)

Spec §5. Tasks: CSP relaxation for dashboard pages (tests updated from the `default-src 'none'` constant); `manifest.webmanifest`, icons, `sw.js` (scope `/dashboard/`, no caching), `app.js` (subscribe + live refresh); `bin/vapid-keys.mjs` (writes `BONA_VAPID_*` to `~/.secrets/bona-services.env` on the VPS — run once there); `lib/push.mjs` (ES256 VAPID JWT with `node:crypto`, payload-less POST, 404/410 cleanup); `push_subscriptions` (schema v5) + subscribe/unsubscribe routes; recipient rules (handler / everyone / needs_human; not the sender; 1 per chat per user per 2 min); deactivation + logout delete subscriptions (extend `team.deactivateUser`). Acceptance: Android Chrome and iPhone (Home-Screen app, iOS ≥ 16.4) both receive "New Bona message" and open the chat.

## Phase 4 — Dana on WhatsApp (outline)

Spec §6. Tasks: `retell/provision.mjs` creates a separate WhatsApp LLM + chat agent (same KB and tools + `request_human`), ids in `retell/ids.json` — **never touch Lisa's Retell objects or the live site agent**; schema v6 lead columns (`dana_off`, `dana_chat_id`, `dana_chat_ts`, `dana_introduced`, `last_human_out_ts`); `settings.dana_enabled` (default `'0'`, added to `SETTINGS_DEFAULTS`); `lib/dana-wa.mjs` (eligibility incl. 24 h human-quiet rule, batching, Retell session reuse/renewal with last-10 context, cards → links, disclosure prefix in code, pre-send re-fetch, caps 6/chat/hour + 200/day + `budget.mjs`, `request_human`/error → needs_human + push); Team page Dana switch + per-chat toggle; tests with the Retell mock. Acceptance: with Dana ON only for the owner's second phone's chat (per-chat flag), she answers within a minute, discloses herself, goes quiet after a human reply, returns after 24 h. **STOP: owner switches Dana on globally.**

## Phase 5 — later list (not planned yet)
Spec §9 — templates, listing card/brochure, Dana-drafted replies, reminders, staff performance, viewings calendar, media in dashboard. Brainstorm with the owner before planning.
