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

---

## Phase 2 — detailed (expanded 2026-09-28 against origin/main 51c3802)

> Branch `feat/team-inbox-p2`, cut from `origin/main` (51c3802 = Phase 1 #27 + TikTok #28; schema still v3).
> Worktree `~/bona-wt/team-inbox`. Baseline: `cd ~/bona-wt/team-inbox/services && node --test api/test/*.test.mjs` → **622 pass, 0 fail**.
> Commit trailer for this phase: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Pre-work results (live, read-only, 2026-09-28)

Probed `POST /chat/findMessages/abdulaziz-personal` on the VPS (`127.0.0.1:8085`, Evolution 2.3.7) printing counts and shapes only.

1. **Per-jid filter works.** `where: { key: { remoteJid } }` returns only that chat; `page`/`offset` page it newest-first with no overlap between pages; it combines with `messageTimestamp: { gte, lte }`. An unknown jid returns 0. `key.fromMe` inside `where` is ignored (as documented). `where: { key: { remoteJidAlt } }` also works.
2. **The paged response states its size**: `{ messages: { total, pages, currentPage, records } }`. So a reader knows whether a window is complete without guessing.
3. **Chats are split across two jids.** 26 of 27 leads are privacy-mode `@lid` chats. Inbound messages and messages typed on the owner's phone are stored under the **lid** (with `key.remoteJidAlt` = the client's phone jid: 418/420 inbound, 190/191 outbound — never the owner's own number). Messages sent through the API **to a phone number** are stored under the **phone jid** (67 such records across those leads). A per-chat read must therefore ask for the lid, the phone jid, and `remoteJidAlt` = phone jid, and de-duplicate by `key.id`.
4. **No lead is lid-only today** (0 of 27): every lid lead also has its phone from `remoteJidAlt`. Replies go to the phone jid. `@lid` sending stays refused (spec §4.5); the owner's second-phone test at the STOP can confirm delivery to a lid-addressed chat through its phone number.
5. **sendText returns `key.id`**: the one live Phase 1 login code logged `wa.send.ok`, which `lib/wa-send.mjs` only logs when the 2xx body carries a `key.id` string.
6. **Load**: a window query takes ~20 ms (45 s, 10 min and 1 h windows; 0–1 records at 04:30). Polling every 20 s is negligible. Note the VPS env pins `BONA_WA_POLL_MS=45000` in `~/.secrets/bona-services.env`, so the new 20 s default only takes effect after the deploy step edits that line.
7. Stored records carry `messageType`, `MessageUpdate[].status` (e.g. `SERVER_ACK`), `source` (`android` = typed on the phone, `web` = sent through WhatsApp Web / the API) and `messageTimestamp` in seconds.
8. Live db: `user_version 3`, SQLite 3.53.3 (`json_extract`/`json_valid` available; local Node has the same), 27 leads (16 `ad_meta` + 2 `ref` chats, 6 `keyword` + 2 `time_window` chats, 1 legacy `form` lead with no chat; the 2 first snippets that carry a listing id belong to the 2 Ref leads), 1 owner + 2 staff users.

### Decisions taken while expanding (inside the spec; each is binding for the tasks below)

- **P2-1 Chat = a lead with `wa_jid` or `wa_lid`.** A form/concierge lead with only a phone is `in` but has no chat until that person writes on WhatsApp (the poller then matches it by phone and stores from there). The inbox list and thread show chats only.
- **P2-2 Per-chat read = three clauses** `{key:{remoteJidAlt: phoneJid}}`, `{key:{remoteJid: phoneJid}}`, `{key:{remoteJid: lid}}` (the lid clause is re-derived after the first two, because a lid can be learned from them), de-duplicated by `key.id`, groups/broadcasts skipped. Used by join backfill, thread refresh and the pre-send refresh.
- **P2-3 No silent loss** (spec §4.3): `lib/evolution.mjs` `readWindow` reads a window in pieces and never drops a record quietly; pieces are returned oldest-first. A piece whose first page states a `total` above `MAX_PAGES × PAGE_SIZE` (500) is cut in two on a whole second and each half is read the same way, the older half first, recursively to depth `MAX_SPLIT_DEPTH` = 4 (at most 16 kept pieces ≈ 8,000 records). Evolution compares whole seconds, so a piece can be cut whenever it takes in two or more seconds, however few ms wide, and each half keeps at least one. A piece that fits is paged — reading on past its stated pages while the rows it held are fewer than the largest `total` any of its pages stated and the last page came back full (a late delivery keeps its sender's timestamp and pushes the oldest record down a page) — and counted: it is complete when its distinct ids, plus, per id, the extra rows it had on the ONE page that held the most of them (one LIMIT/OFFSET page cannot return a row twice, so that is a record stored twice under one `key.id`, not a slide; never summed over pages, since the same rows can show up on two), reach the largest `total` any of its pages stated. A piece that comes back short is **cut and its halves re-read** while it can still be cut, not accepted: records slid between pages, because PostgreSQL does not keep same-second ties in one order across LIMIT/OFFSET values (a photo album on a page boundary comes back partly twice, partly never) and deliveries or deletions between page requests shift the pages. A bare-array response (no `total`) falls back to page-until-short per piece and counts the rows its pages held instead of `total`; a bare piece the page cap stops with its last page full is cut too. Only a piece that cannot be cut again — at `maxDepth`, or a single whole second — is accepted short: `truncated`, and its shortfall added to `missing` (a bare cut-off there is `truncated` and adds nothing to `missing`: what lies past it cannot be counted). The poller logs that `wa.poll.truncated` with `missing` — re-asking would return the same newest pages, so holding the cursor there would loop for ever. `missing` is an upper bound: a newcomer landing on a page already read, or a record leaving mid-read, can count one too many (the poller reaches back only `OVERLAP_MS` = 120 s, so it is counted rather than assumed found). One call makes at most `maxPages × (2^(maxDepth+1) − 1)` = 155 requests. A 2xx answer whose body cannot be read, is not JSON or holds no records throws `EvolutionError` — returned as no records it would read as an empty window and move the cursor past every message in it. Open check before Task 9 switches the poller to `readWindow`: whether Evolution 2.3.7 stores two rows under one `key.id` (e.g. an API send stored by the send path and again by the Baileys echo) is unverified; a read-only live comparison of `messages.total` against distinct `key.id`s for a window holding a known API-sent message settles it (such rows on different pages cost extra cuts and, at the floor, a false `missing`). (Quality reviews of Task 2, 2026-09-28.)
- **P2-4 The daily cap is durable**: every `sender.sendTo` writes a `wa_outbox` row before the HTTP call (a login `code` row with `text` NULL, `lead_id` NULL); the 500/day cap is a rolling-24 h `COUNT(*)` of rows in `pending|accepted|uncertain` whose `jid` is not the owner's. Per-minute limits (20 global, 6 per recipient, 30 per user) stay in memory. There is still exactly one sender: `app.sender` (`createSender` in `index.mjs`).
- **P2-5 Owner-started chats** (`match_method` `owner_outbound` from the poller, `owner_added` from *Add chat by phone number*) are created through `createOrMergeLead`, never fan out to the ad platforms (no click behind them), never send the owner a new-lead note, and are born `inbox_state='in'`, `first_inbound_ts=NULL`, `first_reply_ts=<creation ts>` (the owner already wrote or vouched, so the waiting queue and the Hermes `bona-unanswered-leads` watchdog must not flag them).
- **P2-6 Form and concierge leads are certain**: `createOrMergeLead` sets `inbox_state='in'` for channels `form`/`concierge_chat`/`concierge_voice` on create, and upgrades `NULL`/`unsure` → `in` on merge. It never touches `out`, and never sets a state for channel `whatsapp` (the poller decides those).
- **P2-7 Never-list add purges**: adding a number to the never list on the Team page moves its lead (if any) to `out` and purges its transcript at once. Reads also refuse any lead whose phone is excluded (team or never list).
- **P2-8 Unread** = inbound messages newer than `COALESCE(inbox_reads.last_read_ts, users.created)`, so a newly added team member does not start with every historical message unread.
- **P2-9 Reply errors render the thread directly** (status 4xx/5xx, text kept in the textarea, fresh `send_id`) — never a redirect carrying message text in a URL. Success → 303 to the thread `?ok=sent`; uncertain → 303 `?error=send_uncertain` (text not kept: it may have gone).
- **P2-10 Opening a thread refreshes that chat** from Evolution first (bounded, errors swallowed), and the reply route refreshes again right before the stale-view check.
- **P2-11 Poll default 20 s** (`config.mjs`); the deploy step edits the VPS env line (P-work §6).
- **P2-12 Privacy page** says what Phase 2 does now (stored, team reads and replies, 5 years after the last message, Evolution/phone copies, how to ask for deletion). The Dana sentence ships with Phase 4, when it becomes true.
- **P2-13 Migration v4 rules** for existing leads: `in` when `match_method IN ('ref','ad_meta')`, or channel `form`/`concierge_chat`/`concierge_voice` with `legacy_id IS NULL`, or the `lead_created` touchpoint's `meta.snippet` contains `BONA-###`/`BONA-W###`; every other lead `unsure` (keyword, time_window, legacy imports). `inbox_since = created` for `in`. Live expectation (read-only SELECT of the same CASE on 2026-09-28): **18 `in`** (16 ad_meta + 2 ref), **9 `unsure`** (6 keyword, 2 time_window, 1 legacy form).
- **P2-14 Stored text** is capped at 8,000 characters; media are placeholders only (`[voice note]`, `[audio]`, `[image]`, `[video]`, `[document: name]`, `[location]`, `[contact]`, `[sticker]`, unknown non-noise → `[message]`) plus caption. Reactions, protocol messages (deletes/edits), poll updates and key-distribution records are **noise**: never stored as bubbles. So are edit events (`messageType` `editedMessage`, or an edit wrapper holding a protocolMessage), encrypted reactions, album headers (the photos arrive as records of their own), pins and keep-in-chat records (quality review of Task 2, 2026-09-28). An edit wrapper alone makes a record noise only when the record names no `messageType` of its own: Baileys reports an edit as an update to the ORIGINAL, its content set to `{ editedMessage: { message: <new content> } }`, so a record typed `conversation`, `imageMessage` … that holds one is the client's message with its new content and is kept — dropping it would be silent loss whenever a chat is first read after an edit (second quality review of Task 2, 2026-09-28). Open check, read-only, alongside P2-3's: for records with `status` `EDITED`, print only `messageType` and the top-level `message` keys (no text, no jids) to see how Evolution 2.3.7 stores an edited original (bare new content, or inside an edit wrapper) and what type an edit event is stored under.
- **P2-15 Handler**: first dashboard replier becomes handler when there is none; an `owner_number` outbound sets the env owner when there is none; anyone can reassign to an active user or nobody; audited `handler`.
- **P2-16 `needs_human`** is cleared (0) by any human outbound (staff reply accepted, or an `owner_number` record). Phase 4 sets it.
- **P2-17 Outbox reconciliation**: an outbound record whose `key.id` equals an outbox `key_id` inherits that row's sender; otherwise the oldest outbox row of the same **lead** with status `uncertain`/`pending`, no `key_id`, identical text and `|created − record ts| ≤ 2 min` is resolved (status `accepted`, `key_id` set) and the record inherits its sender (lead-level, not jid-level, because the record may carry the lid while the row carries the phone jid). A process restart marks `pending` rows older than 2 min `uncertain` (`error='interrupted'`).
- **P2-18 Maintenance** (on start, then every 24 h, `unref`): retention purge (transcripts of chats whose `last_msg_ts` is older than 5 years; lead rows stay), prune `code` outbox rows older than 2 days, mark stale `pending` rows `uncertain`.

- **P2-19 Dashboard replies ship switched off** (Task 14): owner setting `inbox_replies`, default `'0'`, fails closed like `sending_enabled`. While off, `sender.reply` refuses `replies_off` before writing anything, the thread shows a sentence instead of the reply box, the route answers 503. Only an owner turns it on (Team page, audited `setting`). Login codes do not depend on it. This is what makes the D14 STOP hold after the deploy: the team can read the inbox, but no client gets a dashboard message until the owner switches replies on, together with the first test send.
- **P2-20 Exclusion sweep**: the v4 migration classifies by match rules only, and P2-7 only purges on a NEW never-list add, so `app.inboxMaintenance()` also moves every `in`/`unsure` lead whose number is a team or never-list number to `out` (with `leaveInbox`), and adding a team member does the same for that number at once. Every read path refuses such leads too (`team.isExcludedLead`).
- **P2-21 Login codes are never stored as messages**: an outbound record whose outbox row is a `code` row is refused by ingest (`reason: 'code'`), even inside an `in` chat.

### Amendments A1–A10 (supersede the contract where they differ)

- **A1 History floor (privacy).** No per-chat read may store messages older than the chat's history floor. `backfill.refresh(lead)` reads only `[floor, now]` where `floor = (lead.inbox_since ?? now()) - JOIN_HISTORY_MS` (newest `REFRESH_LIMIT` per clause inside that window, `messageTimestamp: { gte, lte }` on every clause). Owner-button joins already stored their 30 days at join time (`history(..., { sinceTs: now - OWNER_HISTORY_MS })`), so the refresh never needs to reach further back. Without this, opening an automatically-joined chat would store months of earlier private conversation — the thing the 24 h rule (spec §4.1) exists to prevent.
- **A2 Refresh is cheap and bounded.** `refresh(lead, { budgetMs = 3000, minIntervalMs = 5000 } = {})`: skipped (returns `{ skipped: 'recent' }`) when the same lead was refreshed less than `minIntervalMs` ago (in-memory map keyed by `lead_id`, pruned to 1,000 entries); each clause's request uses `timeoutMs = min(remaining budget, 2500)`; once the budget is spent the remaining clauses are skipped (`{ ..., partial: true }`). It never throws. The thread page and the pre-send refresh both call it; a page never waits on Evolution for more than ~3 s.
- **A3 Catch-up for chats that joined without history** (the v4 migration's 18 `in` chats). `inboxStore.inChatsWithoutMessages({ limit = 200 })` → `in` leads with `wa_jid` or `wa_lid` and no `wa_messages` row. `app.inboxMaintenance()` becomes **async** and, after the P2-18 steps, runs `backfill.history(lead, { sinceTs: (lead.inbox_since ?? lead.created) - JOIN_HISTORY_MS, untilTs: now })` for each of them, sequentially, logging `inbox.catchup` with counts only. The same history a live automatic join takes (the joining message, the 24 h before it, everything since) — so the migrated chats show a real thread on day one, and a chat whose history is empty simply stays empty (the next run re-asks, cheaply).
- **A4 Poller interval note.** Unchanged 20 s default; tests must not depend on it.
- **A5 Arabic word bounds** (quality review of Task 3, 2026-09-28, Claude + Codex). `BONA_WORD_RE = /\bbona\b|(?<![\p{L}\p{M}])بونا(?![\p{L}\p{M}])/iu`, and the document rule is `/(?<![\p{L}\p{M}])bona(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])بونا(?![\p{L}\p{M}])/iu` (`_`, digits and punctuation still bound it, so `Bona_Villa.pdf` joins). The unbounded Arabic side matched كوبونات (coupons), أبونا (our father), طلبونا, زبوناً, جربونا, حاسبونا, so an owner's document named or captioned that way pulled a private or TK chat into the inbox with 24 h of history. A clitic form (وبونا) is missed on purpose: that fails safe, the owner still has the Move button. **Task 9:** the poller's `KEYWORD_RE` (`/\bbona\b|بونا|BONA-W?\d{3}/i`) and private `LISTING_RE` are copies that still have the unbounded Arabic side, so "عندكم كوبونات؟" from a stranger still makes a `keyword` lead that lands on the Unsure list. Task 9 imports `LISTING_ID_RE` and `BONA_WORD_RE` from `lib/inbox/eligibility.mjs` (no heavy dependencies) instead of keeping its own copies (the v4 migration's GLOB is a third, looser copy that also matches `BONA-0031`; it runs once, and P2-13's live expectation was measured with it, so it stays). Reuse each imported pattern by calling `.test()` on it, or rebuild it with `'iu'`, never `'i'` alone: the bounds are `\p{…}` classes, which without the `u` flag become literal character sets, so joining the `.source` strings under `/i` lets "عندكم كوبونات؟" match again (the eligibility test asserts `BONA_WORD_RE.unicode`). A8 replaces both A5 patterns with one.
- **A6 A Ref line is certain only in the site's shape** (same review). `inboundSignal({ text = '', hasAdMeta = false, refKnown = false } = {})`: `'certain'` when `parseRef(text)` finds the listing part (the site always writes one: `refLine()` in `src/scripts/attribution.js` and `EnquiryForm.astro` fall back to `Ref BONA · <code>`), or when `refKnown === true`; any other Ref-shaped line is `'unsure'`, so a real code a client retyped by hand still reaches the owner. `parseRef` checks only the shape (`Ref` + 5–6 characters of the code alphabet, any case), so "ref please", "Ref check done", "what is the ref 23456" and "TK booking Ref ABCDEF" read as codes and would have joined a TK chat by themselves with 24 h of history. `hasAdMeta` and `refKnown` count only when exactly `true`. **Task 9:** `handleInbound` also returns `refKnown: match.method === 'ref' && Boolean(match.sessionId)` (`classify` already looks the code up with `db.getSessionByRef`), and `inboxAfterInbound` passes it to `inboundSignal`; add poller tests that a bare `Ref K7Q2XR` whose session exists joins and one with no session goes to Unsure. Known inconsistency with no live effect: P2-13's migration puts every `match_method = 'ref'` lead `in`; both live ref leads carry a listing id in their first snippet, so the snippet rule puts them `in` anyway. A8 narrows "with its listing part" to the exact shape the site writes (`SITE_REF_RE`). **Task 13:** the README's inbox bullets follow this rule, not the task text: Certain is "a Ref line as the site writes it (with its listing part), or a code a site session holds" (plus ad context and a listing id); Unsure gains "a bare Ref-shaped code no session holds" next to the word and the click window.
- **A7 Tighter link and listing-id bounds** (same review). `SITE_LINK_RE`'s lookahead is `(?![a-z0-9@-]|\.[a-z0-9])`: a longer host (`bona-real-estate.com.evil.example`, `bona-real-estate.com.sa`) and the user part of `bona.azoz.uk@evil.example` no longer count, while `Visit bona-real-estate.com.` still does. A Bona domain in another site's path (`example.org/bona-real-estate.com`) still counts: only the owner's own text reaches this rule, and a mention of the domain is about Bona. `LISTING_ID_RE = /\bBONA-W?\d{3}(?![\w٠-٩۰-۹])/i`: `\b` knows only ASCII digits, so `BONA-W003٤` (a four-digit id) was read as `BONA-W003`. **Task 9:** the poller's own new-lead note (`leadNote` in `lib/leads.mjs`) carries a Bona link, the listing id and a Ref line, so `ownerOutboundJoins(note)` is true; it is safe only because the owner's chat is a team number. Keep the team and never-list exclusions and `OWN_NOTE_RE` ahead of the `ownerOutboundJoins` call, and add a poller test for it. Open for the owner (Codex rated it Important, Claude a spec decision): ad context is certain by §4.1 and P2-13 relies on it; if TK runs click-to-WhatsApp ads to the same personal number, the poller should check the ad's `source_id`/`source_url` against Bona's ad account before passing `hasAdMeta`. Also open for the owner (second review of Task 3, questions, not defects): (1) "Bona" is also a wood-floor-finish brand (Bona AB). TK Estate & Design may send "Bona Traffic HD datasheet.pdf" to a TK client or contractor, and under D12 that joins the chat; no pattern can tell the two apart. Should the word on a document still join by itself, or should a document need a listing id or a site link, with a word-only document going to Unsure? (2) A client pasting a site link with no listing id is only Unsure (§4.1 does not name it), while the owner sending the same link joins; a test pins this. Should a client's site link count as certain? Record the answers here.
- **A8 "bona fide", the site's Ref shape, cut file names** (second quality review of Task 3, 2026-09-28, Claude + Codex). (1) `BONA_WORD_RE` is one pattern for both rules, bounded in both scripts by anything that is not a letter or a mark, and it leaves out the Latin phrase: `/(?<![\p{L}\p{M}])(?:bona(?![\p{L}\p{M}])(?![\s_.-]*fides?(?![\p{L}\p{M}]))|بونا(?![\p{L}\p{M}]))/iu`. "Bona Fide Purchaser Declaration.pdf", or a caption "a bona fide offer", pulled a TK chat into the inbox with 24 h of history (the A5 harm). The document rule uses the same pattern (the private `DOC_BONA_RE` is gone), so "bona2" and "Bona_Villa" from a client are now Unsure like "بونا2", and "Bonaé" says nothing. (2) A Ref line is certain only in the site's exact shape, `SITE_REF_RE = /\bRef\s+BONA(?:-W?\d{3})?\s*[·:|-]\s*[A-HJ-NP-Z2-9]{5,6}(?![\p{L}\p{N}_])/iu` (separator required, nothing carrying the code on), or with `refKnown`: `parseRef` read "Ref bona please" as BONA + PLEASE and "Ref BONA · K7Q2XR٤" as a code. Any other `parseRef` hit is Unsure. (3) `SITE_LINK_RE` has the `u` flag and the lookahead `(?![\p{L}\p{M}\p{N}@-]|[.。．｡][\p{L}\p{M}\p{N}]|:[^\s/]*@)`: user-info with a port or password (`bona.azoz.uk:443@evil.example`), an Arabic top-level domain, the dots browsers read in a host (`。．｡`) and a letter straight after the host no longer count; a port (`bona-real-estate.com:443/ar/`) and a sentence-ending full stop still do. (4) `normaliseRecord` adds `fileNameTruncated` (the document name was cut at 120 code points). `ownerOutboundJoins` reads a cut name as if a letter followed the cut, so "x…x Bonanza.pdf" cut to "… Bona" no longer joins; a listing id at the cut still joins through the word `BONA`, as the full name would. (5) `inboundSignal(null)`, `ownerOutboundJoins(null)` and `nextInboxState(s, null)` no longer throw (`o ?? {}`), and `nextInboxState` reads a `current` outside the three states as undecided instead of passing it through (the store's CHECK makes that unreachable; the answer is now always a state or null). (6) Follow-ups, same day. `REF_RE` (`lib/attribution.mjs`, its own commit) is now `/\bRef\s+(?:(BONA(?:-W?\d{3})?)\s*)?(?:[·\-:|]\s*)?([A-HJ-NP-Z2-9]{5,6})\b/i`: the old one's three whitespace runs could share the same spaces, so a failed match was cubic ("Ref" + 2,000 spaces ≈ 2.3 s) on text the live poller reads from any stranger; it matches the same lines with the same captures. A cut document name is no longer read as if a letter followed the cut ("…Bona fi|de" read as "Bona fix" and joined), and not simply without its last 16 code points either ("…Bona| fide" left "…Bona"): it is read without its last 16 code points, without our name at the new end when what was left out could change it, and by the word rule only (a listing id counts through its `BONA`), so a cut name joins only where the whole name would. `SITE_LINK_RE`'s lookahead is `(?![\p{L}\p{M}\p{N}_@-]|[.。．｡][\p{L}\p{M}\p{N}@]|:(?:[^\s/@]{0,256}@|[^\s/@]{257}))`: `bona.azoz.uk_evil…` and `bona.azoz.uk.@evil.example` no longer count, and the user-info look-ahead is bounded at 256 characters (longer is refused), because unbounded it was quadratic on `bona.azoz.uk:` repeated. `INBOX_STATES` is frozen; `lib/evolution.mjs` works out the placeholder name and `fileName`/`fileNameTruncated` in one helper (`fileNameOf`). **Task 9:** hand the normalised record to `ownerOutboundJoins` as it is (it carries `fileNameTruncated`); `KEYWORD_RE` built from `BONA_WORD_RE` inherits the "bona fide" exclusion and the letter bounds.
- **A9 A per-chat read keeps only what answers its question** (quality review of Task 6, 2026-09-28, Claude + Codex). (1) Privacy, next to A1: `backfill` keeps a record only when it answers the question asked — a `remoteJidAlt` question takes `jidAlt` = that jid (or `jid` = that jid, since the normaliser drops an alt equal to the jid), a `remoteJid` question takes `jid` = that jid. Anything else is counted and logged once per question as `inbox.backfill.foreign` `{ leadId, clause, count }`, never handed to ingest. Evolution applies the key filter today, but ingest's `sameChat` only limits what a lead may learn, not what is stored, so an Evolution that stopped applying the filter (an upgrade renaming `remoteJidAlt`, a proxy, a cache) would have filed every private chat on the owner's phone inside the window under one client's thread, for the whole team, for five years. Not covered: a wrong `wa_lid` on the row itself (the lid question then asks for another chat by name); ingest's learning guards are what keep it right. (2) The two phone questions are stored together, oldest first, then the lid question is asked and its new records stored (the lid can still be learned from the first two). Ingest matches an uncertain outbox row by text and picks the handler from the first human sender it sees, so storing question by question could let a newer owner-phone line (under the lid) become the handler before an older staff send (under the phone jid) was matched. What the first question brought is stored even when the second fails. (3) A refresh question cut off by its own timeout (the reader aborts it and throws `failed: timeout`) makes the result `partial` like a spent budget, keeps what earlier questions stored, and the questions still inside the budget are asked; any other failure, and any timeout on a history read, is `{ error }`. (4) `errorCode` reads the kind first: a body that breaks off after a 2xx (`failed: timeout` / `failed: network` with status 200) is `timeout` / `network`, not `http_200`. An error's `name` is logged only from a fixed list of kinds. A logger that throws never makes a read throw. (5) `history` refuses `sinceTs > untilTs` as `bad_window`, and `maxPages` is a whole number from 1 up to `BACKFILL_MAX_PAGES` (anything else reads the cap; `Infinity` no longer pages until Evolution stops). **Task 9 / Task 11:** `history` has no overall time limit, only 8 s per request, up to 30 requests (3 questions × 10 pages), and the poller awaits it inline on a join; decide there whether a join or the A3 catch-up needs a budget (the refresh's deadline path in `readChat` can take one) or runs the history outside the poll loop.
- **A10 The window is ours to keep too** (second quality review of Task 6, 2026-09-28, Claude + Codex). (1) Privacy, next to A1 and A9: a per-chat read keeps a record only when `Number.isFinite(rec.ts)` and it lies inside the window the question carried (`history`: `[max(sinceTs, now − RETENTION_MS), untilTs]`; `refresh`: `[floor, now]`); anything else is counted and logged once per question as `inbox.backfill.outside_window` `{ leadId, clause, count }`, never handed to ingest. A1's floor rested on Evolution's `messageTimestamp` filter alone, which 2.3.7 already skips unless both bounds are sent; a stub that honoured the key but not the time had `refresh` store a record from 90 days before the floor, and a record with `ts: null` stamped with the current time. (2) What a question fetched before a later page (or the second phone question) failed is stored, oldest first, before the `{ error }` comes back (A9(2) held only across questions). (3) Once the chat has left the inbox mid-read (the owner pressed *Not a client*), neither the second phone question nor the lid question is sent. (4) `history` clamps `sinceTs` to the retention horizon itself, as `refresh` does; a window wholly older than it returns `{ stored: 0, scanned: 0, truncated: false }` without asking. (5) `refresh` returns `truncated: false` always: reading the newest `REFRESH_LIMIT` is the point, and `true` would flag every active chat. (6) A `refresh` inside `minIntervalMs` while the same chat's read is still under way awaits that read (capped by its budget) before returning `{ skipped: 'recent' }`, so the pre-send stale-view check never runs on data the read in flight has not stored yet. (7) `budgetMs`/`minIntervalMs` that are not a finite number from 0 read the defaults (3,000 / 5,000; a NaN pause switched the pause off), and each question's `timeoutMs` is a whole number of at least 1 ms (`AbortSignal.timeout` throws on `1000.5`, which came back as `{ error: 'network' }` with nothing sent).


### Owner decisions D15–D17 (2026-09-28, answered in chat; binding like D1–D14)
- **D15** TK click-to-WhatsApp ads go to the TK company number only; any ad-origin chat on the personal number is a Bona client (ad context stays certain).
- **D16** A chat joins when the owner sends it a property document: a brochure on its own; a floor plan / price list / payment plan / master plan / fact sheet / booklet / plan only next to a property word (villa, apartment, unit, project…), a listing id or a Bona site link (owner answer 2026-09-28: TK design work uses those words); or a listing id / Bona site link as before. A document naming Bona joins only through a listing id or a site link (Bona AB floor finishes); a document naming TK never joins (it becomes a candidate).
  *Owner answer of 2026-09-28, as Task 15 implements it:* "brochure" joins on its own (`brochure(s)`, `بروشور` / `بروشورات`, `BROCHURE_RE`); the other document words — floor plan, price list, payment plan, master plan, fact sheet, كتيب / كتيّب, مخطط / مخططات, قائمة / جدول (ال)أسعار, خطة الدفع / السداد, جدول الدفعات / السداد (`QUALIFIED_DOC_RE`) — join only when the same file name or caption also has a property word (`PROPERTY_NOUN_RE`: villa, apartment, unit, project, tower, residence, townhouse, duplex, penthouse, compound, plot, land, property; فيلا, شقة, مشروع, وحدة, برج, عمارة, دوبلكس, بنتهاوس, تاون هاوس, مجمع سكني, أرض (without ال), عقار), a listing id or a Bona site link, because TK design work uses those words ("Payment plan - kitchen works.pdf", "مخطط الكهرباء.pdf", "كتيب الصيانة.pdf"). So `Price List Sep.pdf`, `payment_plan.pdf` and `قائمة الأسعار.pdf` no longer join by themselves. `PROPERTY_DOC_RE` stays exported as the union of the two document patterns: Task 16's `property document` candidate marker uses it, so a qualified-word document that did not join still reaches the owner's Unsure list. The second question (a document naming Bona joins only by a listing id or a site link) stands as Task 15 wrote it.
  *Open for the owner (quality review of Task 15, 2026-09-29; Task 17 asks him, record the answer here):* some property words on his list are not only real estate, so a fit-out or unrelated paper still joins when one sits next to a document word: `Kitchen unit price list.pdf`, `AC unit fact sheet.pdf`, `Payment plan - kitchen project.pdf`, `جدول الدفعات - مشروع الديكور.pdf` (unit, project, مشروع), `مخطط كهرباء الفيلا.pdf` (a TK electrical plan for a villa), `مخطط عمارة داخلية.pdf` (عمارة is also architecture; العمارة with the article no longer counts), `Toyota Land Cruiser price list.pdf` (land), `Compound interest fact sheet.pdf` (compound). The Arabic nouns also count with the article (الفيلا, الشقة, الوحدة …), which his list named only for مشروع. Should unit / project / مشروع / land / compound go, or should a fit-out word next to a property word (kitchen, electrical, أعمال, ديكور, كهرباء, مطبخ …) keep the chat out and send it to the Unsure list instead? A test (`inbox-eligibility.test.mjs`, "the property words are the owner's list as it stands") pins today's answer, so a reply changes it on purpose.
  *Review fix of 2026-09-29 (Task 15):* a file name gets the same two readings as a caption for TK and Bona — as sent, where an invisible character keeps the words either side apart, and with every invisible character gone (`X\u200BTK` reads both `X TK` and `XTK`) — and either reading naming TK or Bona sets `fileNameTk` / `fileNameBona`, so a string never joins as a file name while it stays out as a caption.
  *Test timing (same review):* every wall-clock check in the services tests takes the fastest of three runs of the same call and allows 500 ms, because one run can be stretched by a garbage-collection pause or a loaded machine while a super-linear pattern takes seconds at the tested sizes on every run.
- **D17** Other real-estate chats (property words, either direction) go to the owner-only Unsure list as candidates (`inbox_candidates`: ids, WhatsApp name, matched property words; never text; open rows pruned 30 days after the last such message; dismissed rows keep only the chat's ids for a year). Nothing auto-joins without a sure signal; TK chats stay out. Tasks 15 (D16) and 16 (D17) implement these; the ship task is now Task 17.

### Task order

1 Schema v4 · 2 Evolution reads · 3 Eligibility rules · 4 Inbox store · 5 Ingest · 6 Backfill · 7 Sender (outbox, caps, reply) · 8 Leads · 9 Poller · 10 Inbox screens · 11 Wiring + maintenance · 12 Routes · 13 Privacy page + README · 14 Replies ship off (D14) · 15 Property documents join (D16) · 16 Real-estate chats to the owner's Unsure list (D17) · 17 Reviews, rehearsal, ship, STOP.
Each task: implementer subagent (TDD) → spec review → quality review, fix loops until both pass (superpowers:subagent-driven-development). Tasks run in order; each builds on the code the previous ones leave.

### File map — Phase 2

| File | Status | Responsibility |
|---|---|---|
| `services/api/lib/db.mjs` | modify | schema v4 (lead inbox columns, `wa_messages`, `wa_outbox`, `inbox_reads`, `wa_gaps`, v4 state migration); `COLUMNS.leads` gains the new columns |
| `services/api/lib/evolution.mjs` | modify | `findMessagesPage` (any `where`, returns `total`/`pages`), `readWindow` (P2-3), `mediaOf`, `isNoise`, `normaliseRecord` adds `media`/`fileName`/`fileNameTruncated`/`noise` |
| `services/api/lib/inbox/eligibility.mjs` | create | pure rules: inbound signal, owner-outbound trigger, next inbox state |
| `services/api/lib/inbox/store.mjs` | create | all SQL for `wa_messages`, `wa_outbox`, `inbox_reads`, `wa_gaps`, inbox state/handler/needs_human, lists, unread, purge, retention |
| `services/api/lib/inbox/ingest.mjs` | create | one Evolution record of an `in` chat → one stored message (sender resolution, outbox reconciliation, handler default, lid learning) |
| `services/api/lib/inbox/backfill.mjs` | create | per-chat Evolution reads: join history (24 h / 30 days) and thread refresh |
| `services/api/lib/wa-send.mjs` | modify | outbox ledger + durable day cap, `userId` + 30/min per user, kinds `code`+`staff`, `reply()` (idempotency, recipient resolution, lid refusal, exclusion, stale guard), `recoverInterrupted()`, `replyJidFor` |
| `services/api/lib/leads.mjs` | modify | `owner_outbound`/`owner_added` methods (P2-5), form/concierge → `in` (P2-6) |
| `services/api/lib/wa-poller.mjs` | modify | state transitions, owner-outbound joins, store `in`-chat records, join backfill, `wa_gaps` for written-off records, `readWindow` default |
| `services/api/lib/audit.mjs` | modify | actions `reply_sent`, `inbox_move`, `inbox_out`, `inbox_add`, `handler` |
| `services/api/lib/dashboard/render.mjs` | modify | Inbox nav entry + unread badge (`me.unread`), lead page inbox links/buttons, new messages |
| `services/api/lib/dashboard/render-inbox.mjs` | create | inbox list, Unsure list, thread |
| `services/api/lib/dashboard/routes.mjs` | modify | inbox pages, reply/handler/move/out/add writes, never-list purge, `me.unread` |
| `services/api/index.mjs` | modify | wire inbox store, ingest, backfill, sender(inbox), poller(inbox), routes(inbox), maintenance timer |
| `services/api/lib/config.mjs` | modify | `waPollMs` default 20 000 |
| `src/data/privacy.json` | modify | WhatsApp conversations section (EN + AR) |
| `services/README.md` | modify | Dashboard → Inbox |
| `services/api/lib/team.mjs` | modify | `isExcludedLead` (Task 11), `inbox_replies` setting + `repliesEnabled()` (Task 14) |
| `services/api/lib/dashboard/render-team.mjs` | modify | the *Replies to clients from the dashboard* switch (Task 14) |
| `services/api/retell/provision.mjs` | modify | `--ensure-env` default poll 20 s for a fresh install (Task 11) |
| tests | create/modify | `db`, `evolution`, `inbox-eligibility`, `inbox-store`, `inbox-ingest`, `inbox-backfill`, `wa-send`, `leads`, `wa-poller`, `dashboard-render-inbox`, `dashboard-inbox`, `config` |

### Interface contract (every task must match these names and shapes exactly)

**`lib/db.mjs`**
- `SCHEMA_VERSION = 4`. Migration `{ version: 4, sql }`:
  ```sql
  ALTER TABLE leads ADD COLUMN inbox_state TEXT CHECK (inbox_state IN ('in','unsure','out'));
  ALTER TABLE leads ADD COLUMN inbox_since INTEGER;
  ALTER TABLE leads ADD COLUMN handler_user_id TEXT;
  ALTER TABLE leads ADD COLUMN last_msg_ts INTEGER;
  ALTER TABLE leads ADD COLUMN needs_human INTEGER NOT NULL DEFAULT 0 CHECK (needs_human IN (0,1));
  CREATE INDEX IF NOT EXISTS leads_inbox ON leads(inbox_state, last_msg_ts);
  CREATE TABLE IF NOT EXISTS wa_messages (
    key_id TEXT NOT NULL PRIMARY KEY, lead_id TEXT NOT NULL, jid TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    sender_kind TEXT NOT NULL CHECK (sender_kind IN ('client','staff','dana','owner_number')),
    sender_user_id TEXT, text TEXT, media_type TEXT, ts INTEGER NOT NULL, status TEXT,
    CHECK ((direction = 'in') = (sender_kind = 'client'))
  );
  CREATE INDEX IF NOT EXISTS wa_messages_lead ON wa_messages(lead_id, ts);
  CREATE TABLE IF NOT EXISTS wa_outbox (
    send_id TEXT NOT NULL PRIMARY KEY, lead_id TEXT, jid TEXT NOT NULL, text TEXT, user_id TEXT,
    sender_kind TEXT NOT NULL CHECK (sender_kind IN ('staff','dana','code','note')),
    status TEXT NOT NULL CHECK (status IN ('pending','accepted','failed','uncertain')),
    key_id TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, error TEXT,
    CHECK (sender_kind <> 'code' OR text IS NULL)
  );
  CREATE INDEX IF NOT EXISTS wa_outbox_key ON wa_outbox(key_id);
  CREATE INDEX IF NOT EXISTS wa_outbox_lead ON wa_outbox(lead_id, created);
  CREATE INDEX IF NOT EXISTS wa_outbox_created ON wa_outbox(created);
  CREATE TABLE IF NOT EXISTS inbox_reads (user_id TEXT NOT NULL, lead_id TEXT NOT NULL, last_read_ts INTEGER NOT NULL, PRIMARY KEY (user_id, lead_id));
  CREATE TABLE IF NOT EXISTS wa_gaps (key_id TEXT NOT NULL PRIMARY KEY, lead_id TEXT, jid TEXT, ts INTEGER, reason TEXT);
  CREATE INDEX IF NOT EXISTS wa_gaps_lead ON wa_gaps(lead_id, ts);
  UPDATE leads SET
    inbox_state = CASE WHEN match_method IN ('ref','ad_meta')
        OR (channel IN ('form','concierge_chat','concierge_voice') AND legacy_id IS NULL)
        OR EXISTS (SELECT 1 FROM touchpoints t WHERE t.lead_id = leads.lead_id AND t.event_type = 'lead_created'
                   AND CASE WHEN json_valid(t.meta) IS NOT 1 THEN 0
                            WHEN json_type(t.meta, '$.snippet') IS NOT 'text' THEN 0
                            ELSE upper(json_extract(t.meta, '$.snippet')) GLOB '*BONA-[0-9][0-9][0-9]*'
                              OR upper(json_extract(t.meta, '$.snippet')) GLOB '*BONA-W[0-9][0-9][0-9]*' END)
      THEN 'in' ELSE 'unsure' END;
  UPDATE leads SET inbox_since = created WHERE inbox_state = 'in';
  ```
  Add a comment block above it in the house style (why each rule, "migrations here only ever add", P2-13).
- `COLUMNS.leads` gains, in this order at the end: `'inbox_state', 'inbox_since', 'handler_user_id', 'last_msg_ts', 'needs_human'` (so `insertLead`/`updateLead` accept them).

**`lib/evolution.mjs`** (keeps its read-only header; still only ever calls `POST /chat/findMessages`)
- `export const MAX_SPLIT_DEPTH = 4;`
- `export async function findMessagesPage({ baseUrl, apiKey, instance, where, page = 1, offset = PAGE_SIZE, fetchImpl = globalThis.fetch, timeoutMs = 10_000 })` → `{ records: NormalisedRecord[], raw, total: number|null, pages: number|null }` (`total`/`pages` from `payload.messages.total/.pages` when numeric, else null). Throws `EvolutionError` exactly like `findMessagesWindow` does today, and also on a 2xx whose body cannot be read (message `failed: timeout|network`), is not JSON, or holds no records (Evolution's empty answer `{ messages: { total: 0, records: [] } }` is not an error); those errors carry `body: null`, and `EvolutionError.body` is never enumerable — callers log `err.message`, never `err.body`. `where` is checked in the form it is sent (`JSON.parse(JSON.stringify(where))`), and that form is what goes out. Refuses with a `TypeError` (one fixed message, never the filter), before any request, a `where` that is not an allowlisted narrowing filter — Evolution drops a falsy key filter, ignores a one-sided time filter and ignores every field it does not know, and each slip reads every chat. The guard is an allowlist at every level: the top level holds only `key` and `messageTimestamp` (at least one of them); `key` only non-empty string `remoteJid`/`remoteJidAlt` (verified live 2026-09-28; `key.id` is not accepted until a caller needs it and a read-only live probe shows Evolution applies it); `messageTimestamp` only ISO 8601 date-time `gte` AND `lte` (seconds and a zone required, as `toIso` writes them; `'2026'` or `'Sep 1'` is refused although `Date.parse` reads it). Anything else — a null jid, a top-level `remoteJid`, `fromMe`, `participants`, a `gt` bound — is refused even beside a filter that does narrow.
- `findMessagesWindow(opts)` becomes a wrapper: `findMessagesPage({ ...opts, where: { messageTimestamp: { gte: toIso(gte), lte: toIso(lte) } } })`; still returns `records` and `raw` (plus `total`, `pages`).
- `fetchWindow` unchanged (kept for compatibility; nothing new uses it).
- `export async function readWindow({ gte, lte, maxPages = MAX_PAGES, offset = PAGE_SIZE, maxDepth = MAX_SPLIT_DEPTH, ...opts })` → `{ records: NormalisedRecord[] /* de-duplicated by id, in piece order */, pieces: number, truncated: boolean, missing: number }` implementing P2-3. A piece can be cut when `Math.floor(lteMs / 1000) > Math.floor(gteMs / 1000)` (two or more whole seconds) and `depth < maxDepth`; the cut is `mid = Math.max(Math.floor(gteMs / 1000) + 1, Math.floor((gteMs + lteMs) / 2000)) * 1000`, left `[gte, mid - 1]`, right `[mid, lte]` (each half keeps at least one whole second). It is cut when its first page states `total > maxPages × offset`; otherwise it is paged — `min(pages, maxPages)` pages, reading on past them while the rows held are fewer than the largest `total` any page of the piece stated and pages come back full — and cut after all when it came back short (`short = largestTotal − distinctIds − samePageRepeats > 0`, where `samePageRepeats` sums, per id, its most rows on any one page minus one; for a bare array `rows − distinctIds − samePageRepeats`) or is a bare array whose last page under the cap was full. A piece that cannot be cut is kept: `missing += short`, `truncated` when `short > 0` or a bare piece was cut off. At most `maxPages × (2^(maxDepth+1) − 1)` = 155 requests per call; `missing` is an upper bound.
- `export function mediaOf(record)` → placeholder string or null (P2-14): `audioMessage` → `[voice note]` if `.ptt` else `[audio]`; `imageMessage` → `[image]`; `videoMessage`/`ptvMessage` → `[video]`; `documentMessage` → `[document: <name>]` (name = `fileName` with every control, format and default-ignorable character removed except U+200C, U+200D and U+FE00–U+FE0F, whitespace collapsed, max 120 code points; `[document]` when empty); `locationMessage`/`liveLocationMessage` → `[location]`; `contactMessage`/`contactsArrayMessage` → `[contact]`; `stickerMessage` → `[sticker]`. Uses `unwrapMessage` first.
- `export function isNoise(record)` → true when the unwrapped message has `protocolMessage`, `reactionMessage`, `pollUpdateMessage`, `editedMessage`, `encReactionMessage`, `albumMessage`, `pinInChatMessage` or `keepInChatMessage`, or has no keys other than `messageContextInfo`/`senderKeyDistributionMessage`; or `record.messageType` is one of those kinds; or the record has no `messageType` and an `editedMessage` wrapper sits on the way in (unwrapping removes it). A record whose `messageType` names another kind is judged by its unwrapped content, so an original holding its edited content is kept (P2-14).
- `normaliseRecord` adds `media: mediaOf(record)`, `fileName: <documentMessage.fileName cleaned as above, or null>`, `fileNameTruncated: boolean` (the name was cut at 120 code points, A8), `noise: isNoise(record)`. The `NormalisedRecord` typedef is updated.

**`lib/inbox/eligibility.mjs`** (pure; imports only `parseRef` from `../attribution.mjs`)
- `export const LISTING_ID_RE = /\bBONA-W?\d{3}(?![\w٠-٩۰-۹])/i;` (A7)
- `export const BONA_WORD_RE = /(?<![\p{L}\p{M}])(?:bona(?![\p{L}\p{M}])(?![\s_.-]*fides?(?![\p{L}\p{M}]))|بونا(?![\p{L}\p{M}]))/iu;` (A5, A8)
- `export const SITE_LINK_RE = /(?:^|[^a-z0-9.-])(?:www\.)?(?:bona-real-estate\.com|bona\.azoz\.uk)(?![\p{L}\p{M}\p{N}_@-]|[.。．｡][\p{L}\p{M}\p{N}@]|:(?:[^\s/@]{0,256}@|[^\s/@]{257}))/iu;` (A7, A8)
- `export const INBOX_STATES = Object.freeze(['in', 'unsure', 'out']);`
- `export function inboundSignal(o)` (`{ text = '', hasAdMeta = false, refKnown = false } = o ?? {}`) → `'certain'` (a Ref line in the site's exact shape, private `SITE_REF_RE` (A8), or any `parseRef` line when `refKnown === true`; `hasAdMeta === true`; or a listing id), `'unsure'` (any other `parseRef` line, or `BONA_WORD_RE`), else `null`. Non-string text is `''`; `hasAdMeta`/`refKnown` count only when exactly `true` (A6).
- `export function ownerOutboundJoins(o)` (`{ text = '', fileName = null, fileNameTruncated = false, media = null } = o ?? {}`) → boolean: text/caption has a site link or listing id; or `media` starts with `[document` and (`fileName` or text) matches `LISTING_ID_RE` or `BONA_WORD_RE` (A5, A8); a truthy `fileNameTruncated` reads the name by `BONA_WORD_RE` alone, without its last 16 code points and without our name at the new end when what was cut could change it (A8).
- `export function nextInboxState(current, o)` (`{ signal = null, method = null } = o ?? {}`; a `current` outside `INBOX_STATES` reads as `null`, A8) → `'out'`/`'in'` stay as they are; else `'certain'` → `'in'`; `'unsure'` signal or `method` `keyword`/`time_window` → `'unsure'`; else the (read) current, `'unsure'` or `null`.

**`lib/inbox/store.mjs`** — `export const RETENTION_MS = Math.round(5 * 365.25 * 86_400_000);` `export const MAX_STORED_TEXT = 8000;` `export const SENDER_KINDS = ['client','staff','dana','owner_number'];` `export const OUTBOX_KINDS = ['staff','dana','code','note'];` `export const OUTBOX_STATUSES = ['pending','accepted','failed','uncertain'];`
`export function createInboxStore(store, { now = () => Date.now() } = {})` (own prepared-statement cache like `team.mjs`; uses `store.transaction`) returns:
- `upsertMessage({ key_id, lead_id, jid = null, direction, sender_kind, sender_user_id = null, text = null, media_type = null, ts, status = null })` → `{ inserted: boolean }`. RangeError on a bad `direction`/`sender_kind` or missing `key_id`/`lead_id`/`ts`. `text` capped at `MAX_STORED_TEXT`. `ON CONFLICT(key_id) DO UPDATE`: upgrades `sender_kind`/`sender_user_id` only from `owner_number` to `staff`/`dana`; `status = COALESCE(excluded.status, status)`; nothing else changes. In the same transaction: `UPDATE leads SET last_msg_ts = MAX(COALESCE(last_msg_ts, 0), ?) WHERE lead_id = ?`.
- `messagesFor(leadId, { limit = 200 } = {})` → the newest `limit` rows, returned oldest-first (`ORDER BY ts, rowid`).
- `newestTs(leadId)` → `MAX(ts)` or `null`. `hasMessages(leadId)` → boolean.
- `insertOutbox({ send_id, lead_id = null, jid, text = null, user_id = null, sender_kind, status = 'pending' })` → `{ inserted: boolean, row }` (`INSERT OR IGNORE`; `row` is the stored row either way; RangeError on bad kind/status/missing send_id/jid; `created = updated = now()`).
- `getOutbox(sendId)` → row|null. `outboxByKey(keyId)` → row|null.
- `updateOutbox(sendId, { status, key_id = undefined, error = undefined })` → boolean (`updated = now()`; RangeError on bad status; `error` capped 200).
- `resolveUncertain({ leadId, text, ts, windowMs = 120_000 })` → the oldest row with that `lead_id`, `status IN ('uncertain','pending')`, `key_id IS NULL`, `text = ?`, `ABS(created - ?) <= windowMs`, or null. Read-only.
- `openOutboxFor(leadId, { sinceTs = 0 } = {})` → rows `status IN ('pending','uncertain','failed')`, `sender_kind IN ('staff','dana')`, `created >= sinceTs`, newest 20, returned oldest-first.
- `countSentSince(sinceTs, { excludeJid = null } = {})` → `COUNT(*)` of rows `status IN ('pending','accepted','uncertain') AND created >= ? AND (? IS NULL OR jid != ?)`.
- `markStalePending(beforeTs)` → changes (`status='uncertain', error='interrupted', updated=now()` where `status='pending' AND created < ?`).
- `pruneCodeRows(beforeTs)` → changes (`DELETE ... WHERE sender_kind = 'code' AND created < ?`).
- `markRead(userId, leadId, ts)` → upsert `last_read_ts = MAX(last_read_ts, excluded.last_read_ts)`.
- `listInbox({ userId, userCreated = 0, limit = 200 } = {})` → rows = every lead column + `unread` (int), `last_text`, `last_media`, `last_direction`, `last_sender_kind`, `handler_name` (active handler's name or null); `WHERE inbox_state = 'in' AND (wa_jid IS NOT NULL OR wa_lid IS NOT NULL)`; `ORDER BY (unread > 0) DESC, COALESCE(last_msg_ts, inbox_since, created) DESC, rowid DESC`. Unread = inbound rows with `ts > COALESCE(r.last_read_ts, userCreated)`.
- `unreadTotal({ userId, userCreated = 0 } = {})` → int, same rule summed over the `in` chats.
- `listUnsure({ limit = 200 } = {})` → lead columns + `snippet` (from the `lead_created` touchpoint's `meta.snippet`, guarded with `json_valid`), `WHERE (inbox_state = 'unsure' OR inbox_state IS NULL) AND (wa_jid IS NOT NULL OR wa_lid IS NOT NULL)`, newest first. `countUnsure()` → int, same WHERE.
- `addGap({ key_id, lead_id, jid = null, ts, reason })` → boolean (`INSERT OR IGNORE`). `gapsFor(leadId)` → rows oldest-first.
- `setInboxState(leadId, state, { since = now() } = {})` → boolean. RangeError on a state outside `in|unsure|out`. `in`: `inbox_since = CASE WHEN inbox_state = 'in' THEN inbox_since ELSE ? END`; `out`/`unsure`: `inbox_since = NULL`. Also sets `updated = now()`.
- `setHandler(leadId, userId)` (null clears) → boolean. `setNeedsHuman(leadId, flag)` → boolean (0/1).
- `purgeLead(leadId)` → `{ messages, outbox, gaps, reads }`: one transaction deleting that lead's `wa_messages`, `wa_outbox` rows with `sender_kind IN ('staff','dana')`, `wa_gaps`, `inbox_reads`, then `last_msg_ts = NULL`.
- `leaveInbox(leadId)` → one transaction: `setInboxState(leadId,'out')`, `purgeLead`, handler NULL, `needs_human = 0`; returns the purge counts.
- `retentionPurge(beforeTs)` → `{ leads, messages }`: `purgeLead` for every lead with `last_msg_ts < beforeTs` that still has messages.

**`lib/inbox/ingest.mjs`** — `export const RESOLVE_WINDOW_MS = 120_000;`
`export function createIngest({ db, inbox, ownerUserId = () => null, log = () => {}, now = () => Date.now() })` returns `{ ingest(lead, rec) }` → `{ stored: false, reason: 'not_in_inbox'|'no_id'|'noise' }` or `{ stored: true, inserted: boolean, senderKind }`:
- refuses when `lead?.inbox_state !== 'in'`, `!rec?.id`, or `rec.noise`.
- direction `out` when `rec.fromMe`; `ts = Number.isFinite(rec.ts) ? rec.ts : now()`; `text = rec.text || null`; `media_type = rec.media ?? (text ? null : '[message]')`.
- out: `inbox.outboxByKey(rec.id)` → sender = row's kind if `staff`/`dana` else `owner_number`, `sender_user_id = row.user_id`, and `updateOutbox(row.send_id, { status: 'accepted', key_id: rec.id })` when the row is not yet accepted. Else `inbox.resolveUncertain({ leadId, text: rec.text, ts, windowMs: RESOLVE_WINDOW_MS })` → same inheritance + `updateOutbox(..., { status: 'accepted', key_id: rec.id })`. Else `owner_number`. Any human outbound (`staff` or `owner_number`) → `setNeedsHuman(lead_id, 0)`. `owner_number` and `lead.handler_user_id` null → `setHandler(lead_id, ownerUserId())` when that returns a user id.
- in: `client`.
- fills only-empty lead fields from `jidsOf(rec)` (import from `../wa-poller.mjs`): `wa_lid`, `wa_jid`, `phone_e164` — never overwrites (`db.updateLead`).
- `inbox.upsertMessage({ key_id: rec.id, lead_id, jid: rec.jid, direction, sender_kind, sender_user_id, text, media_type, ts })`.
- Never logs text, numbers or names.

**`lib/inbox/backfill.mjs`** — `export const JOIN_HISTORY_MS = 24 * 3_600_000; export const OWNER_HISTORY_MS = 30 * 86_400_000; export const BACKFILL_MAX_PAGES = 10; export const REFRESH_LIMIT = 50;`
`export function createBackfill({ env = {}, db, ingest, find = null, fetchImpl = globalThis.fetch, log = () => {}, now = () => Date.now(), timeoutMs = 8000 })` — `find({ where, page, offset })` → `{ records, total, pages }`, defaulting to `findMessagesPage` against `waConfig(env)`; `configured = Boolean(find) || Boolean(baseUrl && apiKey)`. Returns:
- `configured` (boolean), `phoneJidOf(lead)` (the lead's `@s.whatsapp.net` jid, device suffix stripped, else `${phone_e164}@s.whatsapp.net` when `phone_e164` is 8–15 digits not starting with 0, else null).
- `async history(lead, { sinceTs, untilTs = now(), maxPages = BACKFILL_MAX_PAGES } = {})` → `{ stored, scanned, truncated }` or `{ error }`: re-reads the lead, runs the P2-2 clauses each with `messageTimestamp: { gte: ISO(sinceTs), lte: ISO(untilTs) }`, pages `1..min(pages ?? 1, maxPages)` (stops early on a short page when `pages` is null), skips groups/broadcasts and already-seen ids, calls `ingest(db.getLead(id), rec)` per record. `truncated` when any clause has more pages than `maxPages` (logged `inbox.backfill.truncated`, counts only). Never throws: failures return `{ error }` and log `inbox.backfill.failed`. Not configured → `{ stored: 0, scanned: 0, truncated: false, skipped: 'not_configured' }`.
- `async refresh(lead)` → same without the time filter: page 1 with `offset = REFRESH_LIMIT` per clause.

**`lib/wa-send.mjs`** — additions: `export const PER_USER_PER_MIN = 30;` kinds `new Set(['code', 'staff'])`; `const SEND_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;` `export function replyJidFor(lead)` (phone jid per `phoneJidOf` rule above, or null for a lid-only lead).
`createSender({ env, team, inbox, db = null, fetchImpl, now, log, timeoutMs })` — `inbox` (a `createInboxStore`) is **required** (TypeError, like `team`); `db` (the `openDb` store) is required only by `reply` (it reads and stamps the lead). Returns `{ sendTo, reply, recoverInterrupted }`:
- `sendTo({ jid, text, kind, userId = null, bypassSwitch = false, leadId = null, sendId = null })`: validation as today; then switch/config checks; then gates — owner: `[perRecipient]`; others: `[perMinute, perRecipient]` + `perUser` when `userId` + the durable day check `inbox.countSentSince(now() - 86_400_000, { excludeJid: <owner jid> }) < SEND_PER_DAY`. A refusal after validation marks a given `sendId` row `failed` with that error. Then the outbox row: the given `sendId`'s row, or a new `insertOutbox({ send_id: newId('SND'), lead_id: leadId, jid: <bare 1:1 jid>, text: kind === 'code' ? null : text, user_id: userId, sender_kind: kind })`. HTTP exactly as today; then `updateOutbox` → `accepted` + `key_id` / `uncertain` / `failed` + error. Returns today's shapes plus `sendId`.
- `async reply({ sendId, leadId, userId, text, seenTs })` → `{ ok: true, status: 'accepted', sendId, keyId }` | `{ ok: false, error, status?, sendId?, duplicate?: true, uncertain?: true }`. Order: `bad_send_id` (regex) → existing row for `sendId` (a different lead or user → `bad_send_id`; else `{ ok: status === 'accepted', duplicate: true, status, sendId, error }` — never re-sent) → `bad_text` (string, trimmed non-empty, ≤ `MAX_TEXT_LEN`) → `not_found` → `not_in_inbox` (`inbox_state !== 'in'`) → `lid_only` (`replyJidFor` null) → `excluded` (`team.isExcludedPhone`) → `stale` (`seenTs` not finite, or `inbox.newestTs(leadId) > seenTs`) → `insertOutbox(pending, sender_kind 'staff')` (lost race → duplicate path) → `sendTo({ ..., kind: 'staff', userId, leadId, sendId })`. On `ok`: `inbox.upsertMessage({ key_id, lead_id, jid, direction: 'out', sender_kind: 'staff', sender_user_id: userId, text, ts: now(), status: 'sent' })`, handler := `userId` when none, `needs_human = 0`, `first_reply_ts = now()` when null.
- `recoverInterrupted()` → `inbox.markStalePending(now() - 120_000)`.

**`lib/leads.mjs`** — `MATCH_METHODS` gains `'owner_outbound', 'owner_added'`; `export const OWNER_METHODS = new Set(['owner_outbound', 'owner_added']);` P2-5 and P2-6 behaviour inside `createOrMergeLead`.

**`lib/wa-poller.mjs`** — `createPoller({ ..., inboxStore = null, ingest = null, backfill = null })`; when `ingest` is null the poller behaves exactly as in Phase 1 (every existing test keeps passing unchanged). Default `find` = `readWindow(...)`. New tally fields `stored`, `joined`. Per record (after the unchanged exclusions): inbound → today's `handleInbound` then `nextInboxState(lead.inbox_state, { signal: inboundSignal({ text, hasAdMeta: Boolean(adMetaOf(rec.contextInfo)), refKnown }), method })` (`refKnown` per A6); a transition is stored with `setInboxState(..., { since: ts })`; a fresh join awaits `backfill.history(lead, { sinceTs: ts - JOIN_HISTORY_MS, untilTs: ts })`; an `in` lead then gets `ingest(lead, rec)`. Outbound → today's `recordReply`, then: `in` lead → `ingest`; `out` → nothing; else `ownerOutboundJoins(rec)` → create (`owner_outbound`, name null — a `fromMe` pushName is the owner's) or reuse the lead, `setInboxState('in')`, backfill 24 h, `ingest`, log `inbox.join` `{ leadId, via }`. A written-off record of an `in` lead → `inboxStore.addGap({ reason: 'failed' })`. `answer.truncated` → `wa.poll.truncated` with `missing`.

**`lib/audit.mjs`** — `AUDIT_ACTIONS` gains `'reply_sent', 'inbox_move', 'inbox_out', 'inbox_add', 'handler'`.

**`lib/dashboard/render.mjs`** — `NAV` gains `['/dashboard/inbox', 'Inbox', <icon>, 'Workspace']` right after Desk; `layout()` shows `me.unread` (when > 0) as the Inbox count (explicit `counts` still win); `leadDetailPage` shows the inbox state and: `in` chat → "Open chat" link; owner + not `in` → *Move to Bona inbox* form (`POST /v1/admin/inbox/:id/move`); owner + `in`/`unsure` → *Not a client* form (`POST /v1/admin/inbox/:id/out`). `MESSAGES` gains `stale`, `lid_only`, `not_in_inbox`, `excluded`, `sending_disabled`, `send_uncertain`, `bad_text`, `bad_send_id`, `bad_handler`, `reply_rate_limited`, `not_a_chat`.

**`lib/dashboard/render-inbox.mjs`** — `export const INBOX_OK = { sent, handler, moved, out, added }` (messages); `inboxPage({ me, rows, unsureCount = 0, ok = null, error = null, now = Date.now() })`, `unsurePage({ me, rows, ok = null, error = null, now = Date.now() })`, `threadPage({ me, lead, messages, gaps = [], outbox = [], users = [], sendId, seenTs, sendingEnabled, canReply, draft = '', ok = null, error = null, now = Date.now() })`. Server-rendered, no script, existing CSS/classes, masked phones in lists, whole number only on the thread header, every value through `esc`, names in `<bdi>`, bubbles labelled client / staff name / Dana / "Your number" (owner viewer) or "Owner's number" (staff viewer).

**`lib/dashboard/routes.mjs`** — `createDashboardRoutes({ ..., inbox = null, sender = null, backfill = null })`. `GET /dashboard/inbox` (`?tab=unsure` owner-only else 403), `GET /dashboard/inbox/:leadId` (404 "not in the Bona inbox" unless `in` chat and not excluded; refresh; mark read), `POST /v1/admin/inbox/:leadId/reply|handler` (any member), `POST /v1/admin/inbox/:leadId/move|out` and `POST /v1/admin/inbox/add` (owner). Audit `reply_sent` (meta `{ status }`), `handler` (meta `{ to }`), `inbox_move`, `inbox_out`, `inbox_add` — never text or numbers. Never-list add → `inbox.leaveInbox` for that number's lead (P2-7). Every signed-in HTML page's `me` carries `unread`.

**`index.mjs`** — `createInboxStore(db)`, `createSender({ env, team, inbox, db, log })` + `recoverInterrupted()`, `createIngest(...)`, `createBackfill(...)`, poller and routes wired with them, `app.inboxStore/ingest/backfill`, `app.inboxMaintenance()` (P2-18) run in the real server's start-up block and every 24 h (`unref`).

---

### Task 1: Schema v4 — inbox columns and tables (`lib/db.mjs`)

**Files:**
- Modify: `services/api/lib/db.mjs` (`SCHEMA_VERSION`, `MIGRATIONS` gains `version: 4`, `COLUMNS.leads`, `migrate` exported with an `upTo` option)
- Modify: `services/api/test/db.test.mjs` (import, table list, the v2 upgrade test rebuilt on `migrate`, four new v4 tests)
- Modify: `services/api/test/team.test.mjs` (its schema test stops pinning the number 3)

Why the `migrate` seam: the v4 migration does more than add things — its two `UPDATE`s place every lead that already exists (P2-13). The only honest test of that is a genuine v3 file holding real rows, upgraded by the real chain. `MIGRATIONS` and `migrate()` are internal today, so `migrate(db, { upTo })` is exported: `openDb` still always runs the whole chain, and tests can stop it early on a raw `DatabaseSync`. The same seam fixes the existing v2 upgrade test, which built a file holding only `auth_sessions`; v4 alters `leads` and reads `touchpoints`, so that file would no longer open at all.

- [ ] **Step 1: Write the failing tests**

In `services/api/test/db.test.mjs`, change the import line
```js
import { openDb, newId, STAGES, FANOUT_DESTS, SCHEMA_VERSION } from '../lib/db.mjs';
```
to:
```js
import { openDb, newId, STAGES, FANOUT_DESTS, SCHEMA_VERSION, migrate } from '../lib/db.mjs';
```

In the first test (`'openDb creates an owner-only file inside an owner-only directory and migrates once'`), change the table-list line
```js
  for (const name of ['sessions', 'events', 'leads', 'touchpoints', 'lead_stage_history', 'wa_cursor', 'wa_seen', 'ad_spend', 'fanout', 'auth_codes', 'auth_sessions', 'users', 'auth_challenges', 'audit_log', 'never_list', 'settings']) {
```
to:
```js
  for (const name of ['sessions', 'events', 'leads', 'touchpoints', 'lead_stage_history', 'wa_cursor', 'wa_seen', 'ad_spend', 'fanout', 'auth_codes', 'auth_sessions', 'users', 'auth_challenges', 'audit_log', 'never_list', 'settings', 'wa_messages', 'wa_outbox', 'inbox_reads', 'wa_gaps']) {
```

Replace the whole test that begins
```js
test('a v2-era file db upgrades to v3, an existing session survives with a null user_id, and reopening is a no-op', () => {
```
— from that line through its closing `});` (the line after `  cleanup();`, just above the blank line before `test('newId is prefix, base-36 time and four hex characters', () => {`) — with these five tests:
```js
test('a v2-era file db upgrades to the current schema, an existing session survives with a null user_id, and reopening is a no-op', () => {
  // `migrate(db, { upTo })` runs the real migration chain only as far as asked, so the
  // file below is a genuine v2 database — every table v1 and v2 made, from the same SQL
  // start-up runs — not a hand-built imitation that could drift from it. (v4 alters
  // `leads` and reads `touchpoints`, so a file holding only `auth_sessions` would no
  // longer open at all.) `openDb` then applies the rest of the chain exactly as start-up
  // on the VPS does, including v3's bare `ALTER TABLE auth_sessions ADD COLUMN user_id`.
  const { file, cleanup } = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const seed = new DatabaseSync(file);
  migrate(seed, { upTo: 2 });
  assert.equal(seed.prepare('PRAGMA user_version').get().user_version, 2);
  seed.prepare('INSERT INTO auth_sessions (token_hash, created, expires, ua) VALUES (?,?,?,?)').run('deadbeef', 1000, 99_999_999_999, 'UA');
  seed.close();

  const a = openDb(file);
  assert.equal(a.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'v3 onwards is applied on top of the v2 file');
  const row = a.db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get('deadbeef');
  assert.ok(row, 'the pre-existing session row survives the migration');
  assert.equal(row.user_id, null, 'a session opened before user accounts existed has no user');
  a.close();

  const b = openDb(file);
  assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'reopening an up-to-date file is a no-op');
  b.close();
  cleanup();
});

test('schema v4 gives leads their inbox columns and adds the transcript, outbox, read-mark and gap tables', () => {
  const s = openDb(':memory:');
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 4);
  const info = (table) => s.db.prepare(`PRAGMA table_info(${table})`).all();
  const names = (table) => info(table).map((c) => c.name);
  const leadCols = info('leads');
  assert.deepEqual(leadCols.slice(-5).map((c) => c.name), ['inbox_state', 'inbox_since', 'handler_user_id', 'last_msg_ts', 'needs_human']);
  const needsHuman = leadCols.find((c) => c.name === 'needs_human');
  assert.equal(needsHuman.notnull, 1);
  assert.equal(needsHuman.dflt_value, '0');
  assert.deepEqual(names('wa_messages'), ['key_id', 'lead_id', 'jid', 'direction', 'sender_kind', 'sender_user_id', 'text', 'media_type', 'ts', 'status']);
  assert.deepEqual(names('wa_outbox'), ['send_id', 'lead_id', 'jid', 'text', 'user_id', 'sender_kind', 'status', 'key_id', 'created', 'updated', 'error']);
  assert.deepEqual(names('inbox_reads'), ['user_id', 'lead_id', 'last_read_ts']);
  assert.deepEqual(names('wa_gaps'), ['key_id', 'lead_id', 'jid', 'ts', 'reason']);
  const indexes = new Set(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
  for (const name of ['leads_inbox', 'wa_messages_lead', 'wa_outbox_key', 'wa_outbox_lead', 'wa_outbox_created', 'wa_gaps_lead']) assert.ok(indexes.has(name), name);
  s.close();
});

test('the v4 CHECKs refuse an inbox state, direction, sender or outbox status the inbox never writes', () => {
  const s = openDb(':memory:');
  s.insertLead({ lead_id: 'L1', created: 1, updated: 1 });
  assert.equal(s.getLead('L1').inbox_state, null, 'undecided until a rule or the owner decides');
  assert.equal(s.getLead('L1').needs_human, 0, 'nobody has asked for a human yet');
  for (const state of ['in', 'unsure', 'out']) assert.equal(s.updateLead('L1', { inbox_state: state }), true, state);
  assert.throws(() => s.updateLead('L1', { inbox_state: 'maybe' }), /CHECK/);
  assert.throws(() => s.updateLead('L1', { needs_human: 2 }), /CHECK/);
  assert.throws(() => s.updateLead('L1', { needs_human: null }), /NOT NULL/);

  const msg = s.db.prepare('INSERT INTO wa_messages (key_id, lead_id, direction, sender_kind, ts) VALUES (?,?,?,?,?)');
  msg.run('K-client', 'L1', 'in', 'client', 10);
  for (const kind of ['staff', 'dana', 'owner_number']) msg.run(`K-${kind}`, 'L1', 'out', kind, 11);
  assert.throws(() => msg.run('K-2', 'L1', 'sideways', 'client', 12), /CHECK/);
  assert.throws(() => msg.run('K-3', 'L1', 'out', 'owner', 12), /CHECK/);
  assert.throws(() => msg.run('K-4', 'L1', 'in', 'client', null), /NOT NULL/, 'a message always has a time');
  assert.throws(() => msg.run('K-client', 'L1', 'in', 'client', 13), /UNIQUE/, 'one row per WhatsApp message id');

  const out = s.db.prepare('INSERT INTO wa_outbox (send_id, jid, sender_kind, status, created, updated) VALUES (?,?,?,?,?,?)');
  for (const kind of ['staff', 'dana', 'code', 'note']) out.run(`S-${kind}`, '966500000001@s.whatsapp.net', kind, 'pending', 1, 1);
  for (const status of ['accepted', 'failed', 'uncertain']) out.run(`S-${status}`, '966500000001@s.whatsapp.net', 'staff', status, 1, 1);
  assert.throws(() => out.run('S-x', '966500000001@s.whatsapp.net', 'client', 'pending', 1, 1), /CHECK/);
  assert.throws(() => out.run('S-y', '966500000001@s.whatsapp.net', 'staff', 'sent', 1, 1), /CHECK/);
  assert.throws(() => out.run('S-z', null, 'staff', 'pending', 1, 1), /NOT NULL/, 'a send always names its recipient');

  const read = s.db.prepare('INSERT INTO inbox_reads (user_id, lead_id, last_read_ts) VALUES (?,?,?)');
  read.run('USR-1', 'L1', 5);
  read.run('USR-2', 'L1', 6);
  assert.throws(() => read.run('USR-1', 'L1', 7), /UNIQUE/, 'one read mark per person per chat');
  s.close();
});

test('a v3 file db moves to v4: each existing lead is placed by what is certain about it, nothing else changes, and reopening is a no-op', () => {
  const { file, cleanup } = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const seed = new DatabaseSync(file);
  migrate(seed, { upTo: 3 });
  assert.equal(seed.prepare('PRAGMA user_version').get().user_version, 3);
  assert.ok(!seed.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'inbox_state'), 'a genuine v3 file: no inbox columns yet');

  // One lead per P2-13 rule. Each gets the lead_created touchpoint lib/leads.mjs writes,
  // with `snippet` as its first message; `meta` replaces that JSON (a legacy import's),
  // `rawMeta` replaces the stored text outright (a broken row), `later` adds a second,
  // non-creation touchpoint whose snippet must not count.
  const cases = [
    { id: 'L-ref', channel: 'whatsapp', method: 'ref', snippet: 'Hello\nRef K7Q2XR', want: 'in' },
    { id: 'L-ad', channel: 'whatsapp', method: 'ad_meta', snippet: 'Hi', want: 'in' },
    { id: 'L-form', channel: 'form', method: 'form', want: 'in' },
    { id: 'L-chat', channel: 'concierge_chat', method: 'concierge', want: 'in' },
    { id: 'L-voice', channel: 'concierge_voice', method: 'concierge', want: 'in' },
    { id: 'L-old-form', channel: 'form', method: 'form', legacy: 'lead-2025-017', meta: { legacy_id: 'lead-2025-017', conversation_id: null, page: null }, want: 'unsure' },
    { id: 'L-old-chat', channel: 'concierge_chat', method: 'concierge', legacy: 'lead-2025-018', meta: { legacy_id: 'lead-2025-018', conversation_id: null, page: null }, want: 'unsure' },
    { id: 'L-kw-id', channel: 'whatsapp', method: 'keyword', snippet: 'Is BONA-W003 still available?', want: 'in' },
    { id: 'L-kw-id-ar', channel: 'whatsapp', method: 'keyword', snippet: 'السلام عليكم، أبغى تفاصيل bona-012', want: 'in' },
    { id: 'L-kw-word', channel: 'whatsapp', method: 'keyword', snippet: 'I saw Bona on Instagram', later: 'and BONA-W009?', want: 'unsure' },
    { id: 'L-tw', channel: 'whatsapp', method: 'time_window', snippet: 'Hello', want: 'unsure' },
    { id: 'L-tw-id', channel: 'whatsapp', method: 'time_window', snippet: 'Hello, BONA-W021 please', want: 'in' },
    { id: 'L-bad-json', channel: 'whatsapp', method: 'keyword', rawMeta: '{"snippet": "BONA-W003"', want: 'unsure' },
  ];
  const T0 = 1_757_140_000_000;
  const createdOf = (i) => T0 + i * 1000;
  const insLead = seed.prepare('INSERT INTO leads (lead_id, created, updated, channel, match_method, legacy_id, stage, first_reply_ts) VALUES (?,?,?,?,?,?,?,?)');
  const insTp = seed.prepare('INSERT INTO touchpoints (id, lead_id, ts, channel, event_type, meta) VALUES (?,?,?,?,?,?)');
  cases.forEach((c, i) => {
    insLead.run(c.id, createdOf(i), createdOf(i) + 1, c.channel, c.method, c.legacy ?? null, 'new', i % 2 ? createdOf(i) + 60_000 : null);
    const meta = c.rawMeta ?? JSON.stringify(c.meta ?? { match_method: c.method, ref: null, session_id: null, event_id: null, ad_meta: null, snippet: c.snippet ?? null });
    insTp.run(`tp-${c.id}`, c.id, createdOf(i), c.channel, 'lead_created', meta);
    if (c.later) insTp.run(`tp-${c.id}-2`, c.id, createdOf(i) + 5000, c.channel, 'inbound_message', JSON.stringify({ snippet: c.later }));
  });
  const snapshot = (db) => db.prepare('SELECT * FROM leads ORDER BY lead_id').all().map((r) => ({ ...r }));
  const countOf = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const before = snapshot(seed);
  const touchpointsBefore = countOf(seed, 'touchpoints');
  seed.close();

  const a = openDb(file);
  assert.equal(a.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  const added = ['inbox_state', 'inbox_since', 'handler_user_id', 'last_msg_ts', 'needs_human'];
  const after = snapshot(a.db);
  assert.equal(after.length, before.length, 'no lead is added or lost');
  assert.equal(countOf(a.db, 'touchpoints'), touchpointsBefore);
  assert.deepEqual(after.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !added.includes(k)))), before, 'every v3 column is untouched');
  cases.forEach((c, i) => {
    const row = a.getLead(c.id);
    assert.equal(row.inbox_state, c.want, c.id);
    assert.equal(row.inbox_since, c.want === 'in' ? createdOf(i) : null, `${c.id}: in since the lead was created, and only if in`);
    assert.equal(row.needs_human, 0, c.id);
    assert.equal(row.handler_user_id, null, c.id);
    assert.equal(row.last_msg_ts, null, c.id);
  });
  for (const table of ['wa_messages', 'wa_outbox', 'inbox_reads', 'wa_gaps']) assert.equal(countOf(a.db, table), 0, table);

  // The owner moves one guess in and rules one certain lead out. Reopening must not run
  // the v4 placement again and undo either.
  a.updateLead('L-kw-word', { inbox_state: 'in', inbox_since: T0 + 99_000 });
  a.updateLead('L-ref', { inbox_state: 'out', inbox_since: null });
  a.close();
  const b = openDb(file);
  assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'reopening an up-to-date file is a no-op');
  assert.equal(b.getLead('L-kw-word').inbox_state, 'in');
  assert.equal(b.getLead('L-kw-word').inbox_since, T0 + 99_000);
  assert.equal(b.getLead('L-ref').inbox_state, 'out');
  assert.equal(b.getLead('L-ref').inbox_since, null);
  b.close();
  cleanup();
});

test('insertLead and updateLead carry the inbox columns', () => {
  const s = openDb(':memory:');
  const l = s.insertLead({
    lead_id: 'L1', created: 1, updated: 1, wa_jid: '966500000001@s.whatsapp.net',
    inbox_state: 'in', inbox_since: 1, handler_user_id: 'USR-1', last_msg_ts: 7, needs_human: true,
  });
  assert.deepEqual([l.inbox_state, l.inbox_since, l.handler_user_id, l.last_msg_ts, l.needs_human], ['in', 1, 'USR-1', 7, 1]);
  assert.equal(s.updateLead('L1', { inbox_state: 'out', inbox_since: null, handler_user_id: null, last_msg_ts: null, needs_human: false }), true);
  const after = s.getLead('L1');
  assert.deepEqual([after.inbox_state, after.inbox_since, after.handler_user_id, after.last_msg_ts, after.needs_human], ['out', null, null, null, 0]);
  s.close();
});
```

In `services/api/test/team.test.mjs`, inside `test('schema v3 adds the team tables and a user on every session', …)`, replace
```js
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 3);
```
with:
```js
  // The newest schema's number is pinned in db.test.mjs; this test only needs v3's tables.
  assert.ok(SCHEMA_VERSION >= 3);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
```

(`grep -rn "user_version\|SCHEMA_VERSION" services/api/test` finds no other test that pins the schema number.)

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/db.test.mjs api/test/team.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../lib/db.mjs' does not provide an export named 'migrate'`, so db.test.mjs does not load (`ℹ fail 1`). team.test.mjs still passes (`ℹ pass 24`): its schema test no longer pins a number.

- [ ] **Step 3: Implement** — four edits in `services/api/lib/db.mjs`.

Change
```js
export const SCHEMA_VERSION = 3;
```
to:
```js
export const SCHEMA_VERSION = 4;
```

Append a fourth entry to `MIGRATIONS`, after the `version: 3` object. The current end of the array is
```js
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, updated_by TEXT);
    `,
  },
];
```
Insert the block below between that `  },` and the closing `];`:
```js
  {
    // The Bona inbox (2026-09-27 design §4.1–4.2, Phase 2). Whether the team may read a
    // chat is STORED on the lead (`inbox_state`: 'in' | 'unsure' | 'out', NULL = not decided
    // yet) and never re-derived from the match rules, so a lead that was only guessed (the
    // word "bona", the ±15-min click window) cannot drift into the inbox later through the
    // `phone` rule. `needs_human` is Phase 4's hand-over flag; any human reply clears it.
    // `wa_messages` holds the transcripts of `in` chats only; only the client writes `in`,
    // and everyone on the owner's side writes `out`, which a CHECK holds. `wa_outbox` is
    // every send from the owner's number through lib/wa-send.mjs, and its rolling-24 h
    // count is the daily cap, so a restart cannot reset it. A login `code` row never holds
    // its text (the code itself is only ever stored hashed, in auth_challenges); that is a
    // CHECK too, because SQLite cannot add one to a table later without rebuilding it.
    // `wa_gaps` is a message the poller could not read: the thread says so instead of
    // silently skipping it. Their text keys are NOT NULL because a rowid table's TEXT
    // PRIMARY KEY otherwise takes NULL, as many times as it is given one.
    // The two UPDATEs place the leads that already exist (P2-13). Certain → `in`, counted
    // from the day the lead was created: a Ref code or ad context, a web form or concierge
    // lead with no legacy_id (neither imported from nor merged with the old leads.jsonl
    // log), or a listing id in the first message. Everything else — the keyword and
    // click-window guesses, legacy imports — goes to the owner's Unsure list. The GLOBs
    // are deliberately a little looser than LISTING_ID_RE in lib/inbox/eligibility.mjs (no
    // word boundary on either side) and were checked against the live data on 2026-09-28
    // (18 in / 9 unsure). `json_extract` raises on malformed JSON, and one bad touchpoint
    // must not stop bona-api starting, so it only runs in the last branch of a CASE, after
    // json_valid(...) and json_type(...) = 'text': SQLite evaluates a CASE lazily, but
    // promises no order for the two sides of an AND. Only a string snippet counts, since
    // json_extract returns an object or array as its JSON text, which a GLOB would match.
    // Team and never-list numbers are not excluded here; app.inboxMaintenance() moves them
    // out on start (P2-20). No foreign keys, as in v3. Migrations here only ever add.
    version: 4,
    sql: `
      ALTER TABLE leads ADD COLUMN inbox_state TEXT CHECK (inbox_state IN ('in','unsure','out'));
      ALTER TABLE leads ADD COLUMN inbox_since INTEGER;
      ALTER TABLE leads ADD COLUMN handler_user_id TEXT;
      ALTER TABLE leads ADD COLUMN last_msg_ts INTEGER;
      ALTER TABLE leads ADD COLUMN needs_human INTEGER NOT NULL DEFAULT 0 CHECK (needs_human IN (0,1));
      CREATE INDEX IF NOT EXISTS leads_inbox ON leads(inbox_state, last_msg_ts);
      CREATE TABLE IF NOT EXISTS wa_messages (
        key_id TEXT NOT NULL PRIMARY KEY, lead_id TEXT NOT NULL, jid TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        sender_kind TEXT NOT NULL CHECK (sender_kind IN ('client','staff','dana','owner_number')),
        sender_user_id TEXT, text TEXT, media_type TEXT, ts INTEGER NOT NULL, status TEXT,
        CHECK ((direction = 'in') = (sender_kind = 'client'))
      );
      CREATE INDEX IF NOT EXISTS wa_messages_lead ON wa_messages(lead_id, ts);
      CREATE TABLE IF NOT EXISTS wa_outbox (
        send_id TEXT NOT NULL PRIMARY KEY, lead_id TEXT, jid TEXT NOT NULL, text TEXT, user_id TEXT,
        sender_kind TEXT NOT NULL CHECK (sender_kind IN ('staff','dana','code','note')),
        status TEXT NOT NULL CHECK (status IN ('pending','accepted','failed','uncertain')),
        key_id TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, error TEXT,
        CHECK (sender_kind <> 'code' OR text IS NULL)
      );
      CREATE INDEX IF NOT EXISTS wa_outbox_key ON wa_outbox(key_id);
      CREATE INDEX IF NOT EXISTS wa_outbox_lead ON wa_outbox(lead_id, created);
      CREATE INDEX IF NOT EXISTS wa_outbox_created ON wa_outbox(created);
      CREATE TABLE IF NOT EXISTS inbox_reads (user_id TEXT NOT NULL, lead_id TEXT NOT NULL, last_read_ts INTEGER NOT NULL, PRIMARY KEY (user_id, lead_id));
      CREATE TABLE IF NOT EXISTS wa_gaps (key_id TEXT NOT NULL PRIMARY KEY, lead_id TEXT, jid TEXT, ts INTEGER, reason TEXT);
      CREATE INDEX IF NOT EXISTS wa_gaps_lead ON wa_gaps(lead_id, ts);
      UPDATE leads SET
        inbox_state = CASE WHEN match_method IN ('ref','ad_meta')
            OR (channel IN ('form','concierge_chat','concierge_voice') AND legacy_id IS NULL)
            OR EXISTS (SELECT 1 FROM touchpoints t WHERE t.lead_id = leads.lead_id AND t.event_type = 'lead_created'
                       AND CASE WHEN json_valid(t.meta) IS NOT 1 THEN 0
                                WHEN json_type(t.meta, '$.snippet') IS NOT 'text' THEN 0
                                ELSE upper(json_extract(t.meta, '$.snippet')) GLOB '*BONA-[0-9][0-9][0-9]*'
                                  OR upper(json_extract(t.meta, '$.snippet')) GLOB '*BONA-W[0-9][0-9][0-9]*' END)
          THEN 'in' ELSE 'unsure' END;
      UPDATE leads SET inbox_since = created WHERE inbox_state = 'in';
    `,
  },
```

In `COLUMNS`, change the last line of `leads`
```js
    'consent_ads', 'consent_analytics'],
```
to:
```js
    'consent_ads', 'consent_analytics', 'inbox_state', 'inbox_since', 'handler_user_id', 'last_msg_ts', 'needs_human'],
```
(`insertLead` and `updateLead` build their SQL from `COLUMNS.leads`, so this is all they need.)

At the bottom of the file, replace
```js
function migrate(db) {
  for (const m of MIGRATIONS) {
```
with:
```js
/**
 * Bring `db` (a raw DatabaseSync) up to `upTo`, one migration per transaction. `openDb`
 * always runs the whole chain; `upTo` exists so the tests can stop it early, build a
 * genuine older file and upgrade that — the only honest way to test a step that places
 * rows already in the file (v4).
 */
export function migrate(db, { upTo = SCHEMA_VERSION } = {}) {
  for (const m of MIGRATIONS) {
    if (m.version > upTo) continue;
```
(The rest of `migrate` — the `BEGIN IMMEDIATE` comment and body — stays exactly as it is. `openDb` keeps calling `migrate(db)`, which runs the whole chain.)

- [ ] **Step 4: Run**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/db.test.mjs api/test/team.test.mjs`
Expected: PASS — `ℹ pass 41` (17 in db.test.mjs, 24 in team.test.mjs), `ℹ fail 0`.

- [ ] **Step 5: Full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: `ℹ pass 626`, `ℹ fail 0` (baseline 622 + 4 new tests; the rebuilt v2 test replaces the old one).

- [ ] **Step 6: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/db.mjs services/api/test/db.test.mjs services/api/test/team.test.mjs
git commit -m "db: schema v4 — inbox state on leads, transcripts, outbox, read marks, gaps

Existing leads are placed once by what is certain about them (Ref code, ad
context, web form or concierge, a listing id in the first message); every
other lead goes to the owner's Unsure list. migrate() is exported with an
upTo option so the tests upgrade a genuine v3 file.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Note: this task tests the upgrade on a v3 file built by the real migration chain. The live-schema rehearsal (read-only `sqlite_master` dump from hermes-vps, rebuilt locally, opened with `openDb`) belongs to this phase's deploy section, before `deploy.sh`.

---

### Task 2: Evolution reads — any filter, whole windows without silent loss, media placeholders, noise

Implements the `lib/evolution.mjs` part of the interface contract and decision P2-3 (no silent loss) and the media/noise part of P2-14. The module stays read-only: it still only ever calls `POST /chat/findMessages/{instance}`. `fetchWindow` is left exactly as it is (the poller switches to `readWindow` in its own task).

**Files:**
- Modify: `services/api/lib/evolution.mjs`
- Test: `services/api/test/evolution.test.mjs` (modify: the import and one expected object; append 16 tests)

- [ ] **Step 1: Write the failing tests** — three edits to `services/api/test/evolution.test.mjs`.

**1a.** The import at the top of the file. Replace:

```js
import {
  EvolutionError, MAX_PAGES, PAGE_SIZE, bareJid, contextOf, fetchWindow, findMessagesWindow,
  normaliseRecord, oldestFirst, recordsOf, textOf, toMs,
} from '../lib/evolution.mjs';
```

with:

```js
import {
  EvolutionError, MAX_PAGES, MAX_SPLIT_DEPTH, PAGE_SIZE, bareJid, contextOf, fetchWindow,
  findMessagesPage, findMessagesWindow, isNoise, mediaOf, normaliseRecord, oldestFirst,
  readWindow, recordsOf, textOf, toMs,
} from '../lib/evolution.mjs';
```

**1b.** The existing test `a text message flattens to the shape the poller reasons about` compares the whole normalised record, so its expected object gains the three new fields. Replace:

```js
    pushName: 'Sara',
    contextInfo: null,
    messageType: 'conversation',
  });
});
```

with:

```js
    pushName: 'Sara',
    contextInfo: null,
    messageType: 'conversation',
    media: null,
    fileName: null,
    noise: false,
  });
});
```

**1c.** Append to the end of the file (after the last test, `fetchWindow stops on the first short page and drops ids seen twice`). The fake below behaves like the live instance as probed on 2026-09-28: it keeps a record set, applies the time filter in whole seconds with both bounds inclusive, matches `key.remoteJid` (or `key.remoteJidAlt`), sorts newest-first, pages with `page`/`offset`, and answers boxed with `total`/`pages` or as a bare array.

```js
/* ---------------- Phase 2: reads with any filter, and no silent loss ---------------- */

const BASE = { baseUrl: 'https://wa-api.example/', apiKey: 'evo-key', instance: 'abdulaziz-personal' };
const T0 = Date.UTC(2026, 8, 28, 9, 0, 0);
const S0 = T0 / 1000;
const CLIENT = '966500000000@s.whatsapp.net';
const iso = (ms) => new Date(ms).toISOString();

/** A stored record as Evolution keeps it: `messageTimestamp` in whole seconds. */
const stored = (id, sec, key = {}) => ({
  key: { id, fromMe: false, remoteJid: CLIENT, ...key },
  messageType: 'conversation',
  message: { conversation: 'hi' },
  messageTimestamp: sec,
});

/**
 * A stand-in for the live instance, answering `POST /chat/findMessages` the way Evolution
 * 2.3.7 does: both time bounds cut down to whole seconds and inclusive (and only applied
 * when both are given), `key.remoteJid` matched exactly (or, without it, `key.remoteJidAlt`),
 * newest first, `offset` records per page from `page` 1 — boxed as
 * `{ messages: { total, pages, currentPage, records } }`, or a bare array when `bare`.
 */
function fakeEvolution(records, { bare = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const { where = {}, page = 1, offset = 50 } = body;
    const w = where.messageTimestamp;
    const both = Boolean(w?.gte && w?.lte);
    const lo = both ? Math.floor(Date.parse(w.gte) / 1000) : -Infinity;
    const hi = both ? Math.floor(Date.parse(w.lte) / 1000) : Infinity;
    const key = where.key ?? {};
    const hits = records
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.messageTimestamp >= lo && r.messageTimestamp <= hi)
      .filter(({ r }) => (key.remoteJid ? r.key.remoteJid === key.remoteJid
        : !key.remoteJidAlt || r.key.remoteJidAlt === key.remoteJidAlt))
      .sort((a, b) => b.r.messageTimestamp - a.r.messageTimestamp || b.i - a.i)
      .map(({ r }) => r);
    const slice = hits.slice(offset * (page - 1), offset * page);
    const payload = bare ? slice
      : { messages: { total: hits.length, pages: Math.ceil(hits.length / offset), currentPage: page, records: slice } };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, calls };
}

/** `[from - T0, to - T0, page]` for every request — which piece was read, in what order. */
const asked = (calls) => calls.map((c) => [
  Date.parse(c.body.where.messageTimestamp.gte) - T0,
  Date.parse(c.body.where.messageTimestamp.lte) - T0,
  c.body.page,
]);
/** Ids `M<to>` down to `M<from>`: one piece as Evolution hands it over, newest first. */
const desc = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, k) => `${prefix}${to - k}`);

test('findMessagesPage sends any where filter as given and reads total and pages off the boxed answer', async () => {
  const evo = fakeEvolution([
    stored('A', S0 + 1),
    stored('B', S0 + 2, { remoteJid: '272516946294519@lid', remoteJidAlt: '966500000001@s.whatsapp.net' }),
    stored('C', S0 + 3),
  ]);
  const one = await findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, offset: 1, fetchImpl: evo.fetchImpl });
  assert.equal(evo.calls[0].url, 'https://wa-api.example/chat/findMessages/abdulaziz-personal');
  assert.equal(evo.calls[0].headers.apikey, 'evo-key');
  assert.deepEqual(evo.calls[0].body, { where: { key: { remoteJid: CLIENT } }, page: 1, offset: 1 });
  assert.deepEqual(one.records.map((r) => r.id), ['C'], 'one chat only, newest first');
  assert.equal(one.total, 2, 'the size of everything the filter matched, not of this page');
  assert.equal(one.pages, 2);
  assert.equal(one.raw.messages.currentPage, 1);

  const alt = await findMessagesPage({ ...BASE, where: { key: { remoteJidAlt: '966500000001@s.whatsapp.net' } }, page: 1, fetchImpl: evo.fetchImpl });
  assert.equal(evo.calls[1].body.offset, PAGE_SIZE);
  assert.deepEqual(alt.records.map((r) => r.id), ['B'], 'a lid chat found through its phone jid');
  assert.equal(alt.records[0].jid, '272516946294519@lid');

  const both = await findMessagesPage({
    ...BASE, fetchImpl: evo.fetchImpl,
    where: { key: { remoteJid: CLIENT }, messageTimestamp: { gte: iso(T0), lte: iso(T0 + 2000) } },
  });
  assert.deepEqual(both.records.map((r) => r.id), ['A'], 'a chat and a window together');
  assert.equal(both.total, 1);
});

test('total and pages are null when the answer does not state them', async () => {
  const bare = await findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, fetchImpl: fakeEvolution([stored('A', S0)], { bare: true }).fetchImpl });
  assert.deepEqual(bare.records.map((r) => r.id), ['A']);
  assert.equal(bare.total, null);
  assert.equal(bare.pages, null);

  const odd = recorder([{ status: 200, body: { messages: { total: '1', pages: -1, records: [textRecord()] } } }]);
  const out = await findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, fetchImpl: odd.fetchImpl });
  assert.equal(out.records.length, 1);
  assert.equal(out.total, null, 'a size that is not a whole number is not a size');
  assert.equal(out.pages, null);
});

test('findMessagesPage refuses a missing or empty filter, which would read every chat', async () => {
  const { fetchImpl, calls } = recorder();
  await assert.rejects(() => findMessagesPage({ ...BASE, fetchImpl }), TypeError);
  await assert.rejects(() => findMessagesPage({ ...BASE, where: {}, fetchImpl }), TypeError);
  await assert.rejects(() => findMessagesPage({ ...BASE, where: [], fetchImpl }), TypeError);
  await assert.rejects(() => findMessagesPage({ ...BASE, baseUrl: '', where: { key: { remoteJid: CLIENT } }, fetchImpl }), TypeError);
  assert.equal(calls.length, 0);

  const bad = recorder([{ status: 500, body: { error: 'boom' } }]);
  await assert.rejects(() => findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, fetchImpl: bad.fetchImpl }), (err) => {
    assert.ok(err instanceof EvolutionError);
    assert.equal(err.status, 500);
    return true;
  });
});

test('findMessagesWindow is the window case of findMessagesPage and passes the sizes through', async () => {
  const { fetchImpl } = recorder([{ status: 200, body: boxed([textRecord()]) }]);
  const out = await findMessagesWindow({ ...OPTS, fetchImpl });
  assert.equal(out.records[0].id, 'KEY1');
  assert.equal(out.total, 1);
  assert.equal(out.pages, 1);
});

test('readWindow: a window that fits is one piece, one request, complete', async () => {
  const evo = fakeEvolution([stored('A', S0 + 5), stored('B', S0 + 10), stored('LATER', S0 + 120)]);
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 60_000, fetchImpl: evo.fetchImpl });
  assert.deepEqual(out.records.map((r) => r.id), ['B', 'A']);
  assert.equal(out.pieces, 1);
  assert.equal(out.truncated, false);
  assert.equal(out.missing, 0);
  assert.deepEqual(evo.calls.map((c) => c.body), [
    { where: { messageTimestamp: { gte: iso(T0), lte: iso(T0 + 60_000) } }, page: 1, offset: PAGE_SIZE },
  ]);
});

test('readWindow pages a window of exactly what one read can reach, without splitting it', async () => {
  const evo = fakeEvolution(Array.from({ length: 500 }, (_, i) => stored(`M${i}`, S0 + i)));
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 600_000, fetchImpl: evo.fetchImpl });
  assert.deepEqual(asked(evo.calls), [1, 2, 3, 4, 5].map((p) => [0, 600_000, p]), '500 is not more than 500');
  assert.deepEqual(out.records.map((r) => r.id), desc('M', 0, 499));
  assert.equal(out.pieces, 1);
  assert.equal(out.truncated, false);
  assert.equal(out.missing, 0);
});

test('readWindow splits 1,200 messages into complete pieces on whole seconds, older piece first, each message once', async () => {
  // One message a second for 20 minutes: more than the 500 one read can reach.
  const evo = fakeEvolution(Array.from({ length: 1200 }, (_, i) => stored(`M${i}`, S0 + i)));
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_199_000, fetchImpl: evo.fetchImpl });

  assert.deepEqual(asked(evo.calls), [
    [0, 1_199_000, 1], // 1,200: too many — cut at 599 s
    [0, 598_999, 1], // 599: still too many — cut at 299 s
    [0, 298_999, 1], [0, 298_999, 2], [0, 298_999, 3],
    [299_000, 598_999, 1], [299_000, 598_999, 2], [299_000, 598_999, 3],
    [599_000, 1_199_000, 1], // 601: cut at 899 s
    [599_000, 898_999, 1], [599_000, 898_999, 2], [599_000, 898_999, 3],
    [899_000, 1_199_000, 1], [899_000, 1_199_000, 2], [899_000, 1_199_000, 3], [899_000, 1_199_000, 4],
  ]);
  assert.ok(evo.calls.every((c) => c.body.page <= MAX_PAGES));
  assert.deepEqual(out.records.map((r) => r.id), [
    ...desc('M', 0, 298), ...desc('M', 299, 598), ...desc('M', 599, 898), ...desc('M', 899, 1199),
  ]);
  assert.equal(new Set(out.records.map((r) => r.id)).size, 1200, 'every message exactly once');
  assert.equal(out.pieces, 4);
  assert.equal(out.truncated, false);
  assert.equal(out.missing, 0);
});

test('readWindow stops cutting at the depth cap and says exactly how many it could not read', async () => {
  // 5,000 messages inside one second (a restored backup, say) with one message either side.
  const burst = Array.from({ length: 5000 }, (_, i) => stored(`B${i}`, S0 + 30));
  const evo = fakeEvolution([stored('EARLY', S0 + 5), ...burst, stored('LATE', S0 + 50)]);
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 60_000, fetchImpl: evo.fetchImpl });

  assert.equal(MAX_SPLIT_DEPTH, 4);
  assert.deepEqual(asked(evo.calls), [
    [0, 60_000, 1],
    [0, 29_999, 1], // depth 1: EARLY, complete
    [30_000, 60_000, 1],
    [30_000, 44_999, 1],
    [30_000, 36_999, 1],
    // depth 4 = the cap: the burst's piece is read partially, newest five pages
    [30_000, 32_999, 1], [30_000, 32_999, 2], [30_000, 32_999, 3], [30_000, 32_999, 4], [30_000, 32_999, 5],
    [33_000, 36_999, 1],
    [37_000, 44_999, 1],
    [45_000, 60_000, 1], // LATE, complete
  ]);
  assert.deepEqual(out.records.map((r) => r.id), ['EARLY', ...desc('B', 4500, 4999), 'LATE']);
  assert.equal(out.pieces, 5);
  assert.equal(out.truncated, true);
  assert.equal(out.missing, 4500);
});

test('readWindow never cuts a window under two seconds wide, and maxDepth 0 never cuts at all', async () => {
  const two = [...Array.from({ length: 300 }, (_, i) => stored(`X${i}`, S0)), ...Array.from({ length: 300 }, (_, i) => stored(`Y${i}`, S0 + 1))];
  const narrow = fakeEvolution(two);
  const a = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_999, fetchImpl: narrow.fetchImpl });
  assert.equal(narrow.calls.length, MAX_PAGES, 'no whole second inside the window to cut at');
  assert.equal(a.pieces, 1);
  assert.equal(a.records.length, 500);
  assert.equal(a.truncated, true);
  assert.equal(a.missing, 100);

  const flat = fakeEvolution(Array.from({ length: 1200 }, (_, i) => stored(`M${i}`, S0 + i)));
  const b = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_199_000, maxDepth: 0, fetchImpl: flat.fetchImpl });
  assert.equal(flat.calls.length, MAX_PAGES);
  assert.deepEqual(b.records.map((r) => r.id), desc('M', 700, 1199), 'the newest 500');
  assert.equal(b.pieces, 1);
  assert.equal(b.truncated, true);
  assert.equal(b.missing, 700);
});

test('readWindow falls back to paging until a short page when the answer is a bare array', async () => {
  const small = fakeEvolution(Array.from({ length: 250 }, (_, i) => stored(`M${i}`, S0 + i)), { bare: true });
  const a = await readWindow({ ...BASE, gte: T0, lte: T0 + 300_000, fetchImpl: small.fetchImpl });
  assert.deepEqual(small.calls.map((c) => c.body.page), [1, 2, 3], 'the third page is short: done');
  assert.equal(a.records.length, 250);
  assert.equal(a.pieces, 1);
  assert.equal(a.truncated, false);
  assert.equal(a.missing, 0);

  const big = fakeEvolution(Array.from({ length: 1200 }, (_, i) => stored(`M${i}`, S0 + i)), { bare: true });
  const b = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_199_000, fetchImpl: big.fetchImpl });
  assert.deepEqual(asked(big.calls), [1, 2, 3, 4, 5].map((p) => [0, 1_199_000, p]), 'no size to decide a cut on');
  assert.deepEqual(b.records.map((r) => r.id), desc('M', 700, 1199));
  assert.equal(b.pieces, 1);
  assert.equal(b.truncated, true);
  assert.equal(b.missing, 0, 'nobody can count what a bare array left out');
});

test('readWindow drops an id seen twice, keeps records that have no id, and reads on for the one a late arrival pushed down', async () => {
  const k = (id) => textRecord({ key: { id, fromMe: false, remoteJid: CLIENT } });
  const noId = textRecord({ key: { fromMe: false, remoteJid: CLIENT } });
  // Four messages, two a page: A, B, the one with no id, C. A message arriving after page 1
  // pushes every older record one place down, so B comes back at the top of page 2 and C
  // falls past the two pages the first answer stated.
  const answers = [
    { status: 200, body: { messages: { total: 4, pages: 2, currentPage: 1, records: [k('A'), k('B')] } } },
    { status: 200, body: { messages: { total: 5, pages: 3, currentPage: 2, records: [k('B'), noId] } } },
    { status: 200, body: { messages: { total: 5, pages: 3, currentPage: 3, records: [k('C')] } } },
  ];
  const { fetchImpl, calls } = recorder(answers);
  const out = await readWindow({ ...OPTS, offset: 2, fetchImpl });
  assert.deepEqual(calls.map((c) => c.body.page), [1, 2, 3], 'two full pages kept three of four: one page more');
  assert.deepEqual(out.records.map((r) => r.id), ['A', 'B', null, 'C']);
  assert.equal(out.missing, 0);
  assert.equal(out.truncated, false);

  // With no page left under the cap, the record pushed out is counted, never lost quietly.
  const capped = recorder(answers);
  const short = await readWindow({ ...OPTS, offset: 2, maxPages: 2, fetchImpl: capped.fetchImpl });
  assert.equal(capped.calls.length, 2);
  assert.deepEqual(short.records.map((r) => r.id), ['A', 'B', null]);
  assert.equal(short.missing, 1);
  assert.equal(short.truncated, true);
});

test('readWindow needs both bounds', async () => {
  const { fetchImpl, calls } = recorder();
  await assert.rejects(() => readWindow({ ...BASE, gte: T0, fetchImpl }), TypeError);
  await assert.rejects(() => readWindow({ ...BASE, lte: T0, fetchImpl }), TypeError);
  assert.equal(calls.length, 0);
});

/* ---------------- media placeholders and noise ---------------- */

test('media become placeholders: a voice note is not just audio, a round video is a video', () => {
  const m = (message) => mediaOf({ message });
  assert.equal(m({ audioMessage: { ptt: true, seconds: 7 } }), '[voice note]');
  assert.equal(m({ audioMessage: { ptt: false, seconds: 7 } }), '[audio]');
  assert.equal(m({ audioMessage: {} }), '[audio]');
  assert.equal(m({ imageMessage: { caption: 'the view' } }), '[image]');
  assert.equal(m({ videoMessage: {} }), '[video]');
  assert.equal(m({ ptvMessage: {} }), '[video]');
  assert.equal(m({ documentMessage: { fileName: 'Brochure BONA-W014.pdf' } }), '[document: Brochure BONA-W014.pdf]');
  assert.equal(m({ documentMessage: {} }), '[document]');
  assert.equal(m({ documentMessage: { fileName: 42 } }), '[document]');
  assert.equal(m({ locationMessage: { degreesLatitude: 21.5, degreesLongitude: 39.2 } }), '[location]');
  assert.equal(m({ liveLocationMessage: {} }), '[location]');
  assert.equal(m({ contactMessage: { displayName: 'x' } }), '[contact]');
  assert.equal(m({ contactsArrayMessage: { contacts: [] } }), '[contact]');
  assert.equal(m({ stickerMessage: {} }), '[sticker]');
  assert.equal(m({ viewOnceMessageV2: { message: { imageMessage: {} } } }), '[image]');
  assert.equal(m({ conversation: 'hello' }), null);
  assert.equal(m({ extendedTextMessage: { text: 'hello' } }), null);
  assert.equal(m({ someFutureMessage: {} }), null, 'unknown kinds are left to the caller ([message])');
  assert.equal(mediaOf({}), null);
  assert.equal(mediaOf(null), null);
});

test('a document name loses control and bidi characters, is capped at 120 code points, and is found inside wrappers', () => {
  const doc = (fileName) => ({ documentMessage: { fileName, caption: 'the plan' } });
  // ephemeral (disappearing messages) around documentWithCaption around the document
  const wrapped = (fileName) => ({ message: { ephemeralMessage: { message: { documentWithCaptionMessage: { message: doc(fileName) } } } } });

  const spoof = 'Villa\u202Efdp.exe  \t plan\u0000.pdf';
  assert.equal(mediaOf(wrapped(spoof)), '[document: Villafdp.exe plan.pdf]');
  const arabic = '\u2067مخطط\u2069 \u200Fالفيلا\u061C\u202A.pdf\u202C\n';
  assert.equal(mediaOf(wrapped(arabic)), '[document: مخطط الفيلا.pdf]');
  assert.equal(mediaOf({ message: doc('floor\tplan\nv2.pdf') }), '[document: floor plan v2.pdf]', 'a tab or line break still separates words');
  assert.equal(mediaOf(wrapped('\u202E\u0007 \u2066 ')), '[document]', 'nothing usable left');

  const long = '📄'.repeat(50) + 'a'.repeat(150);
  assert.equal(Array.from(long).length, 200);
  const capped = '📄'.repeat(50) + 'a'.repeat(70);
  assert.equal(mediaOf({ message: doc(long) }), `[document: ${capped}]`);
  assert.equal(Array.from(normaliseRecord({ key: { id: 'D1' }, message: doc(long) }).fileName).length, 120);
});

test('reactions, deletes and edits, poll votes and key-distribution records are noise; a message is not', () => {
  const n = (message, messageType) => isNoise({ message, messageType });
  assert.equal(n({ reactionMessage: { text: '👍', key: { id: 'X' } } }), true);
  assert.equal(n({ protocolMessage: { type: 0, key: { id: 'X' } } }), true, 'a delete for everyone');
  assert.equal(n({ protocolMessage: { type: 14, editedMessage: { conversation: 'fixed' } } }), true, 'an edit');
  assert.equal(n({ editedMessage: { message: { protocolMessage: { type: 14 } } } }), true, 'an edit, wrapped');
  assert.equal(n({ pollUpdateMessage: { vote: {} } }), true);
  assert.equal(n({ ephemeralMessage: { message: { reactionMessage: { text: '❤' } } } }), true);
  assert.equal(n({ senderKeyDistributionMessage: { groupId: 'g' }, messageContextInfo: {} }), true, 'key distribution only');
  assert.equal(n({ senderKeyDistributionMessage: { groupId: 'g' } }), true);
  assert.equal(n({ messageContextInfo: { deviceListMetadata: {} } }), true, 'device metadata only');
  for (const type of ['reactionMessage', 'protocolMessage', 'pollUpdateMessage']) {
    assert.equal(n(undefined, type), true, `${type} by messageType alone`);
  }

  assert.equal(n({ conversation: 'hello', messageContextInfo: {} }, 'conversation'), false);
  assert.equal(n({ extendedTextMessage: { text: 'x' }, senderKeyDistributionMessage: {} }), false, 'a real message riding with a key');
  assert.equal(n({ imageMessage: {} }, 'imageMessage'), false);
  assert.equal(n({ someFutureMessage: {} }), false, 'an unknown kind shows as [message], never vanishes');
  assert.equal(n({}), false, 'no body at all may be a message the phone could not decrypt');
  assert.equal(n(null), false);
});

test('normaliseRecord carries the placeholder, the cleaned file name and the noise flag', () => {
  const voice = normaliseRecord(textRecord({ messageType: 'audioMessage', message: { audioMessage: { ptt: true }, messageContextInfo: {} } }));
  assert.equal(voice.media, '[voice note]');
  assert.equal(voice.text, '');
  assert.equal(voice.fileName, null);
  assert.equal(voice.noise, false);

  const brochure = normaliseRecord(textRecord({
    messageType: 'documentWithCaptionMessage',
    message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'BONA-W014\u202E.pdf', caption: 'as promised' } } } },
  }));
  assert.equal(brochure.media, '[document: BONA-W014.pdf]');
  assert.equal(brochure.fileName, 'BONA-W014.pdf');
  assert.equal(brochure.text, 'as promised');
  assert.equal(brochure.noise, false);

  const reaction = normaliseRecord(textRecord({ messageType: 'reactionMessage', message: { reactionMessage: { text: '👍' } } }));
  assert.equal(reaction.noise, true);
  assert.equal(reaction.media, null);
  assert.equal(reaction.fileName, null);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/evolution.test.mjs`
Expected: FAIL — the whole file fails to load with `SyntaxError: The requested module '../lib/evolution.mjs' does not provide an export named 'MAX_SPLIT_DEPTH'` (none of `MAX_SPLIT_DEPTH`, `findMessagesPage`, `readWindow`, `mediaOf`, `isNoise` exists yet).

- [ ] **Step 3: Implement** — seven edits to `services/api/lib/evolution.mjs`.

**3a.** The module header: say who reads what now, and where sends go. Replace:

```js
 * Evolution API 2.3.7 (Baileys) — the READ half, for the WhatsApp poller.
 *
 * IMPORTANT: the instance this talks to (`abdulaziz-personal`) is the owner's
 * *personal* WhatsApp and is already consumed by another agent. This module only ever
 * calls `POST /chat/findMessages/{instance}`. It never sets a webhook, a websocket or
 * a rabbitmq consumer — doing so would steal the other agent's events — and it never
 * sends: the one outbound message the API service writes goes through `lib/wa.mjs`.
```

with:

```js
 * Evolution API 2.3.7 (Baileys) — the READ half, for the WhatsApp poller and the Bona inbox.
 *
 * IMPORTANT: the instance this talks to (`abdulaziz-personal`) is the owner's
 * *personal* WhatsApp and is already consumed by another agent. This module only ever
 * calls `POST /chat/findMessages/{instance}`. It never sets a webhook, a websocket or
 * a rabbitmq consumer — doing so would steal the other agent's events — and it never
 * sends: what the API service sends goes through `lib/wa-send.mjs` (login codes and,
 * from Phase 2, the team's replies) and `lib/wa.mjs` (the owner's note to himself).
 *
 * It asks two kinds of question, both through that one read-only route:
 *   - a time window across every chat (`readWindow`), for the poller;
 *   - one chat (`findMessagesPage` with `where.key.remoteJid` or `where.key.remoteJidAlt`),
 *     for the Bona inbox: a joining chat's history, and the refresh when a thread is
 *     opened (lib/inbox/backfill.mjs). A privacy-mode chat is stored under two jids —
 *     what the client sends and what the owner types under the lid, what the API sent
 *     to a phone number under the phone jid — so the inbox asks for both.
 * Reading is not keeping: the window read sees every chat on the number, and only the
 * callers decide what is stored (the inbox keeps chats in the Bona inbox, nothing else).
```

**3b.** The quirks list: the time filter works in whole seconds, the per-chat filter, the stated size. Replace:

```js
 *   - the `messageTimestamp` filter applies only when BOTH `gte` and `lte` are given.
```

with:

```js
 *   - the `messageTimestamp` filter applies only when BOTH `gte` and `lte` are given, and
 *     it compares whole seconds: both ISO bounds are cut down to the second, both inclusive.
 *   - `where.key.remoteJid` and `where.key.remoteJidAlt` narrow a read to one chat and
 *     combine with the time filter (verified live 2026-09-28).
 *   - the boxed answer states the size of everything the filter matched, not just this
 *     page (`total`, `pages`), so a reader can tell a complete read from a cut-off one.
```

**3c.** The split depth, after `PAGE_SIZE`. Replace:

```js
/** `offset` in the request body: how many records one page holds. */
export const PAGE_SIZE = 100;
```

with:

```js
/** `offset` in the request body: how many records one page holds. */
export const PAGE_SIZE = 100;
/**
 * How many times `readWindow` may halve a window that holds more than one read can reach:
 * 4 levels = at most 16 pieces of `MAX_PAGES × PAGE_SIZE`, about 8,000 messages.
 */
export const MAX_SPLIT_DEPTH = 4;
```

**3d.** `mediaOf`, `isNoise` and the file-name cleaner go right above `normaliseRecord`, and the typedef gains the three new fields. Replace:

```js
/**
 * One Evolution record, flattened to what the poller reasons about.
 * @typedef {{ id: string|null, jid: string|null, jidAlt: string|null, fromMe: boolean,
 *             ts: number|null, text: string, pushName: string|null,
 *             contextInfo: object|null, messageType: string|null }} NormalisedRecord
 */
export function normaliseRecord(record) {
```

with:

```js
/**
 * Control characters and the bidi overrides, isolates and marks. A file name is chosen by
 * whoever sent the file: a right-to-left override can make `fdp.exe` read as `exe.pdf`,
 * and escaping for HTML does nothing about that, so they go before the name is shown.
 */
const CONTROL_OR_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Longest document name kept, in code points (an emoji is one, not two). */
const MAX_FILE_NAME = 120;

/** A sender-chosen file name made safe to show: `''` when nothing usable is left. */
function cleanFileName(name) {
  if (typeof name !== 'string') return '';
  // Whitespace first, so a tab or a line break between two words leaves a space, not a join.
  const flat = name.replace(/\s+/g, ' ').replace(CONTROL_OR_BIDI_RE, '').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, MAX_FILE_NAME).join('').trim();
}

/**
 * What stands in for a media message in a transcript (2026-09-27 design §4.2): the kind
 * only, never the file. A caption, when there is one, is the record's `text`. `null` for a
 * text message and for kinds not listed here (the inbox shows those as `[message]`).
 * @returns {string|null}
 */
export function mediaOf(record) {
  const m = unwrapMessage(record?.message);
  if (!m || typeof m !== 'object') return null;
  // A voice note is an audioMessage with `ptt` set; staff answer it differently from a file.
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (m.imageMessage) return '[image]';
  // ptvMessage is the round "video note".
  if (m.videoMessage || m.ptvMessage) return '[video]';
  if (m.documentMessage) {
    const name = cleanFileName(m.documentMessage.fileName);
    return name ? `[document: ${name}]` : '[document]';
  }
  if (m.locationMessage || m.liveLocationMessage) return '[location]';
  if (m.contactMessage || m.contactsArrayMessage) return '[contact]';
  if (m.stickerMessage) return '[sticker]';
  return null;
}

/** Record kinds that change or decorate another message instead of being one. */
const NOISE_KINDS = new Set(['protocolMessage', 'reactionMessage', 'pollUpdateMessage']);
/** Parts that ride along with a message and never carry anything a person wrote. */
const ENVELOPE_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);

/**
 * True for a record that is not a message of its own and must never become a bubble:
 * a reaction, a protocol message (a delete, an edit), a poll vote, or a record that is
 * only encryption/device envelope. A record with no message body at all is NOT noise —
 * it may be a client message the phone could not decrypt, so it shows as `[message]`
 * rather than vanishing (design §4.3, no silent loss).
 */
export function isNoise(record) {
  if (NOISE_KINDS.has(record?.messageType)) return true;
  const m = unwrapMessage(record?.message);
  if (!m || typeof m !== 'object') return false;
  const keys = Object.keys(m);
  if (keys.some((k) => NOISE_KINDS.has(k))) return true;
  return keys.length > 0 && keys.every((k) => ENVELOPE_KEYS.has(k));
}

/**
 * One Evolution record, flattened to what the poller and the inbox reason about.
 * `media` is `mediaOf`'s placeholder, `fileName` a document's cleaned name (null for
 * anything else), `noise` is `isNoise`.
 * @typedef {{ id: string|null, jid: string|null, jidAlt: string|null, fromMe: boolean,
 *             ts: number|null, text: string, pushName: string|null,
 *             contextInfo: object|null, messageType: string|null,
 *             media: string|null, fileName: string|null, noise: boolean }} NormalisedRecord
 */
export function normaliseRecord(record) {
```

**3e.** The end of `normaliseRecord`. Replace:

```js
    messageType: typeof record?.messageType === 'string' ? record.messageType : null,
  };
}
```

with:

```js
    messageType: typeof record?.messageType === 'string' ? record.messageType : null,
    media: mediaOf(record),
    fileName: cleanFileName(unwrapMessage(record?.message)?.documentMessage?.fileName) || null,
    noise: isNoise(record),
  };
}
```

**3f.** `findMessagesWindow` becomes a wrapper around the new `findMessagesPage` (same request, same errors, any `where`). Replace the whole of `findMessagesWindow`, doc comment included:

```js
/**
 * One page of the messages sent or received in a time window, across every chat.
 *
 * The `messageTimestamp` filter only bites when both bounds are present, so both are
 * required here; `fromMe` is deliberately not sent, because the server ignores it.
 *
 * @param {{ baseUrl: string, apiKey: string, instance: string,
 *           gte: number|string|Date, lte: number|string|Date,
 *           page?: number, offset?: number,
 *           fetchImpl?: typeof globalThis.fetch, timeoutMs?: number }} o
 * @returns {Promise<{ records: NormalisedRecord[], raw: any }>}
 */
export async function findMessagesWindow({
  baseUrl, apiKey, instance, gte, lte, page = 1, offset = PAGE_SIZE,
  fetchImpl = globalThis.fetch, timeoutMs = 10_000,
} = {}) {
  if (!baseUrl) throw new TypeError('evolution: baseUrl required');
  if (!instance) throw new TypeError('evolution: instance required');
  const root = String(baseUrl).replace(/\/+$/, '');
  const route = `/chat/findMessages/${encodeURIComponent(instance)}`;
  const body = { where: { messageTimestamp: { gte: toIso(gte), lte: toIso(lte) } }, page, offset };

  let res;
  try {
    res = await fetchImpl(`${root}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey ?? '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new EvolutionError(`POST ${route} failed: ${err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network'}`, 0, null);
  }
  const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new EvolutionError(`POST ${route} -> HTTP ${res.status}`, res.status, json);
  return { records: recordsOf(json).map(normaliseRecord), raw: json };
}
```

with:

```js
/** A size Evolution states about the whole filtered set, or null when it did not state one. */
const countOf = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * One page of the messages matching `where`, newest first.
 *
 * `where` goes to Evolution as given: `{ messageTimestamp: { gte, lte } }` (ISO strings —
 * both, or the filter is ignored) for a window across every chat, `{ key: { remoteJid } }`
 * or `{ key: { remoteJidAlt } }` for one chat, or a chat and a window together. An empty
 * filter is refused: it would page through every chat on the owner's personal WhatsApp.
 * `fromMe` is never worth sending — the server ignores it.
 *
 * `total` and `pages` describe everything the filter matched, not this page, when the
 * answer is boxed; both are null for a bare array, and the caller then cannot tell a
 * complete read from a cut-off one.
 *
 * @param {{ baseUrl: string, apiKey: string, instance: string, where: object,
 *           page?: number, offset?: number,
 *           fetchImpl?: typeof globalThis.fetch, timeoutMs?: number }} o
 * @returns {Promise<{ records: NormalisedRecord[], raw: any, total: number|null, pages: number|null }>}
 */
export async function findMessagesPage({
  baseUrl, apiKey, instance, where, page = 1, offset = PAGE_SIZE,
  fetchImpl = globalThis.fetch, timeoutMs = 10_000,
} = {}) {
  if (!baseUrl) throw new TypeError('evolution: baseUrl required');
  if (!instance) throw new TypeError('evolution: instance required');
  if (!where || typeof where !== 'object' || Array.isArray(where) || Object.keys(where).length === 0) {
    throw new TypeError('evolution: a where filter is required');
  }
  const root = String(baseUrl).replace(/\/+$/, '');
  const route = `/chat/findMessages/${encodeURIComponent(instance)}`;
  const body = { where, page, offset };

  let res;
  try {
    res = await fetchImpl(`${root}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey ?? '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new EvolutionError(`POST ${route} failed: ${err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network'}`, 0, null);
  }
  const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new EvolutionError(`POST ${route} -> HTTP ${res.status}`, res.status, json);
  return {
    records: recordsOf(json).map(normaliseRecord),
    raw: json,
    total: countOf(json?.messages?.total),
    pages: countOf(json?.messages?.pages),
  };
}

/**
 * One page of the messages sent or received in a time window, across every chat: the
 * poller's question, as `findMessagesPage` with the time filter filled in.
 *
 * The `messageTimestamp` filter only bites when both bounds are present, so both are
 * required here; `fromMe` is deliberately not sent, because the server ignores it.
 *
 * @param {{ baseUrl: string, apiKey: string, instance: string,
 *           gte: number|string|Date, lte: number|string|Date,
 *           page?: number, offset?: number,
 *           fetchImpl?: typeof globalThis.fetch, timeoutMs?: number }} o
 * @returns {Promise<{ records: NormalisedRecord[], raw: any, total: number|null, pages: number|null }>}
 */
export async function findMessagesWindow({ gte, lte, ...opts } = {}) {
  return findMessagesPage({ ...opts, where: { messageTimestamp: { gte: toIso(gte), lte: toIso(lte) } } });
}
```

**3g.** `readWindow` goes after `fetchWindow` (which stays as it is), at the end of the file. Replace the last lines of `fetchWindow`:

```js
    if (page === maxPages) truncated = true;
  }
  return { records, pages, truncated };
}
```

with:

```js
    if (page === maxPages) truncated = true;
  }
  return { records, pages, truncated };
}

/**
 * Every message in a time window across every chat, without silent loss (2026-09-27
 * design §4.3).
 *
 * Records come back NEWEST first and one read stops at `maxPages`, so paging alone cannot
 * reach the older messages of a window that holds more than `maxPages × offset` — asking
 * again returns the same newest pages. The boxed answer says how many the window holds
 * (`total`), so a window that is too big is cut in two on a whole second and each half is
 * read the same way, the older half first, down to `maxDepth` levels. Evolution compares
 * whole seconds, so the halves `[gte, mid - 1 ms]` and `[mid, lte]` neither overlap nor
 * leave a second out.
 *
 * A message that arrives while a piece is being paged pushes that piece's older records one
 * place down: the next page repeats a record, and the oldest slides past the last page the
 * first answer stated. So ids are de-duplicated, a piece measures the records it KEPT — not
 * the rows its pages held — against the `total` its first answer stated, and it reads on
 * past the stated pages while that count is short and the pages still come back full. The
 * newcomer is stamped about now, the newest thing in the window, so the caller's next
 * window reaches it.
 *
 * Only a piece that is still too big when it cannot be cut again — at `maxDepth`, or under
 * two seconds wide with no whole second left to cut at — is read partially: its newest
 * `maxPages` pages, `truncated` set, and `missing` saying how many were left unread. A piece
 * whose kept count is still short when the page cap comes first is reported the same way.
 * The caller logs that and moves on; holding its cursor there would re-read the same newest
 * pages for ever.
 *
 * A bare-array answer states no size. That piece falls back to paging until a short page,
 * exactly like `fetchWindow`; a cut-off there is `truncated`, and adds nothing to `missing`
 * because nobody can count it.
 *
 * Within a piece the records keep Evolution's newest-first order (the poller sorts with
 * `oldestFirst`); the pieces come oldest first. A failed request throws as it is — nothing
 * is half-returned — so the caller keeps its cursor and asks again next time.
 *
 * @returns {Promise<{ records: NormalisedRecord[], pieces: number, truncated: boolean, missing: number }>}
 */
export async function readWindow({
  gte, lte, maxPages = MAX_PAGES, offset = PAGE_SIZE, maxDepth = MAX_SPLIT_DEPTH, ...opts
} = {}) {
  const gteMs = toMs(gte);
  const lteMs = toMs(lte);
  if (gteMs === null || lteMs === null) throw new TypeError('readWindow needs both gte and lte');
  const records = [];
  const seen = new Set();
  let pieces = 0;
  let truncated = false;
  let missing = 0;

  /** Adds the records not kept yet, in order; returns how many that was. */
  const keep = (batch) => {
    let added = 0;
    for (const rec of batch) {
      // A record with no id cannot be matched against anything, so it is kept as it is.
      if (rec.id) {
        if (seen.has(rec.id)) continue;
        seen.add(rec.id);
      }
      records.push(rec);
      added += 1;
    }
    return added;
  };
  const readPage = (from, to, page) => findMessagesPage({
    ...opts, where: { messageTimestamp: { gte: toIso(from), lte: toIso(to) } }, page, offset,
  });

  async function read(from, to, depth) {
    const first = await readPage(from, to, 1);
    if (first.total === null) {
      pieces += 1;
      keep(first.records);
      let last = first.records.length;
      for (let page = 2; page <= maxPages && last >= offset; page += 1) {
        const next = await readPage(from, to, page);
        keep(next.records);
        last = next.records.length;
      }
      if (last >= offset) truncated = true;
      return;
    }
    const cap = maxPages * offset;
    if (first.total > cap && to - from >= 2000 && depth < maxDepth) {
      const mid = Math.floor((from + to) / 2000) * 1000;
      await read(from, mid - 1, depth + 1);
      await read(mid, to, depth + 1);
      return;
    }
    pieces += 1;
    // Kept, not rows on the pages: a repeat that a late arrival pushed down must not stand
    // in for the record it pushed past the last stated page.
    let kept = keep(first.records);
    let last = first.records.length;
    const stated = Math.min(first.pages ?? Math.ceil(first.total / offset), maxPages);
    for (let page = 2; page <= maxPages && (page <= stated || (kept < first.total && last >= offset)); page += 1) {
      const next = await readPage(from, to, page);
      kept += keep(next.records);
      last = next.records.length;
    }
    // Over the cap at the deepest level, or short when the page cap came first.
    if (kept < first.total) {
      truncated = true;
      missing += first.total - kept;
    }
  }

  await read(gteMs, lteMs, 0);
  return { records, pieces, truncated, missing };
}
```

- [ ] **Step 4: Run the task's tests**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/evolution.test.mjs`
Expected: PASS — 29 tests (13 existing, 16 new), 0 fail.

- [ ] **Step 5: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail — 16 more tests than after Task 1 (622 + Task 1's new tests + 16). Nothing outside `evolution.test.mjs` compares a whole normalised record, and the poller still calls `fetchWindow`, so no other test changes.

- [ ] **Step 6: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/evolution.mjs services/api/test/evolution.test.mjs
git commit -m "evolution: per-chat pages, whole-window reads without silent loss, media placeholders, noise

findMessagesPage takes any where filter and returns Evolution's total/pages;
readWindow splits a window too big for one read on whole seconds (depth 4)
and reports what it could not reach; mediaOf/isNoise feed the inbox.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Eligibility rules (`lib/inbox/eligibility.mjs`)

**Files:**
- Create: `services/api/lib/inbox/eligibility.mjs`
- Test: `services/api/test/inbox-eligibility.test.mjs`

Pure rules, no I/O: which client message is certain or a guess, which owner message joins a chat (D12), and the state a chat moves to after an inbound message. The poller calls them (a later task of this phase); nothing here touches the database. `parseRef` (lib/attribution.mjs) is the only import, so Ref lines are read exactly as the poller's `ref` rule reads them.

- [ ] **Step 1: Write the failing tests** — create `services/api/test/inbox-eligibility.test.mjs`:

```js
/**
 * Which chats the Bona inbox takes (design §4.1): only what is certain joins by itself, a
 * guess waits for the owner, the owner's own messages count only when they carry
 * something that can only be Bona, and nothing a message says ever moves a chat out of
 * `in` or `out`. Pure rules, so every case is a table row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, INBOX_STATES,
  inboundSignal, ownerOutboundJoins, nextInboxState,
} from '../lib/inbox/eligibility.mjs';

/* ---------------- shared patterns ---------------- */

test('the states and patterns are what the store and the poller rely on', () => {
  assert.deepEqual(INBOX_STATES, ['in', 'unsure', 'out']);
  for (const re of [LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE]) {
    assert.ok(re instanceof RegExp);
    assert.equal(re.global, false, `${re} has no /g, so .test() never carries a position over`);
    assert.equal(re.sticky, false, `${re} has no /y`);
  }
});

/* ---------------- a client's message ---------------- */

test('a client message is certain on a Ref code, ad context or a listing id', () => {
  for (const [text, hasAdMeta] of [
    ['Hello\nRef BONA-W003 · K7Q2XR', false],
    ['ref bona - k7q2xr', false],
    ['Ref K7Q2X', false],
    ['مرحبا، مهتم بالفيلا\nRef BONA-005: ABCDEF', false],
    ['', true],
    ['Hi, is this still available?', true],
    ['Is BONA-W012 still available?', false],
    ['bona-w012 price?', false],
    ['السلام عليكم، أبغى تفاصيل BONA-005', false],
    ['https://bona-real-estate.com/properties/bona-w003/', false],
  ]) {
    assert.equal(inboundSignal({ text, hasAdMeta }), 'certain', `${JSON.stringify(text)} ad=${hasAdMeta}`);
  }
});

test('the word bona on its own is only a guess', () => {
  for (const text of ['I saw Bona on Instagram', 'BONA', 'bona?', 'بونا', 'شفت إعلان بونا', 'BONA-W0031']) {
    assert.equal(inboundSignal({ text }), 'unsure', text);
  }
});

test('anything else says nothing, and text that is not a string reads as empty', () => {
  for (const text of ['Hello', 'Bonanza', 'kabona', 'Refund 12345', 'السلام عليكم', '']) {
    assert.equal(inboundSignal({ text }), null, JSON.stringify(text));
  }
  assert.equal(inboundSignal({ text: 'Hello', hasAdMeta: false }), null);
  assert.equal(inboundSignal({ text: null }), null);
  assert.equal(inboundSignal({ text: 42 }), null);
  assert.equal(inboundSignal({ text: { toString: () => 'BONA-W003' } }), null, 'never coerced');
  assert.equal(inboundSignal({}), null);
  assert.equal(inboundSignal(), null);
});

/* ---------------- a message the owner sends ---------------- */

test('the owner joins a chat by sending a Bona link or a listing id', () => {
  for (const text of [
    'https://bona-real-estate.com/properties/bona-w003/',
    'bona-real-estate.com',
    'www.bona-real-estate.com/ar/',
    'Have a look: https://www.bona-real-estate.com/villas?utm_source=wa',
    'Visit bona-real-estate.com.',
    'HTTPS://BONA-REAL-ESTATE.COM/EN/',
    'http://bona.azoz.uk/properties/',
    'bona.azoz.uk',
    'تفضل الرابط: https://bona-real-estate.com/ar/properties/',
    'الرابطbona-real-estate.com',
    'Details for BONA-W003 attached',
    'رقم العقار BONA-005',
  ]) {
    assert.equal(ownerOutboundJoins({ text }), true, text);
  }
});

test('lookalike links and plain mentions of bona do not join a chat', () => {
  for (const text of [
    'notbona-real-estate.com',
    'https://notbona-real-estate.com/x',
    'bona-real-estate.company',
    'bona-real-estate.co',
    'bona-realestate.com',
    'mybona.azoz.uk',
    'bona',
    'Bona villa is ready, call me',
    'بونا',
    'BONA-W0031',
    'Hello',
    '',
  ]) {
    assert.equal(ownerOutboundJoins({ text }), false, JSON.stringify(text));
  }
});

test('a document joins when its file name or caption says Bona or a listing id', () => {
  const doc = (fileName, text = null) => ({ text, fileName, media: fileName ? `[document: ${fileName}]` : '[document]' });
  for (const rec of [
    doc('Bona_Villa.pdf'),
    doc('Villa-Bona.pdf'),
    doc('BONA brochure.pdf'),
    doc('BONA-W003.pdf'),
    doc('brochure bona-005 v2.pdf'),
    doc('بونا - فيلا الشاطئ.pdf'),
    doc('villa.pdf', 'Brochure from Bona'),
    doc('villa.pdf', 'بروشور بونا'),
    doc(null, 'bona'),
  ]) {
    assert.equal(ownerOutboundJoins(rec), true, `${rec.fileName} / ${rec.text}`);
  }
  for (const rec of [
    doc('Bonanza.pdf'),
    doc('Kabona_offer.pdf'),
    doc('TK_Villa.pdf', 'here you go'),
    doc(null),
  ]) {
    assert.equal(ownerOutboundJoins(rec), false, `${rec.fileName} / ${rec.text}`);
  }
});

test('the word bona counts only on a document, never on plain text, a photo or a voice note', () => {
  assert.equal(ownerOutboundJoins({ text: 'bona', media: null }), false);
  assert.equal(ownerOutboundJoins({ text: 'bona', media: '[image]' }), false);
  assert.equal(ownerOutboundJoins({ text: 'Bona villa', media: '[voice note]' }), false);
  assert.equal(ownerOutboundJoins({ text: 'bona.azoz.uk/villas', media: '[image]' }), true, 'a link in a caption still counts');
  assert.equal(ownerOutboundJoins({ text: null, fileName: null, media: null }), false);
  assert.equal(ownerOutboundJoins({ text: null, fileName: 'Bona_Villa.pdf', media: '[document: Bona_Villa.pdf]' }), true, 'a document without a caption');
  assert.equal(ownerOutboundJoins({}), false);
  assert.equal(ownerOutboundJoins(), false);
});

/* ---------------- the next state ---------------- */

const SIGNALS = [null, 'unsure', 'certain'];
const METHODS = [null, 'ref', 'phone', 'ad_meta', 'keyword', 'time_window', 'concierge', 'form'];
const OPEN = [null, undefined, 'unsure'];

test('in and out never move on a message, whatever it says', () => {
  for (const current of ['in', 'out']) {
    for (const signal of SIGNALS) {
      for (const method of METHODS) assert.equal(nextInboxState(current, { signal, method }), current, `${current} ${signal} ${method}`);
    }
    assert.equal(nextInboxState(current), current);
  }
  assert.equal(nextInboxState('out', { signal: 'certain', method: 'ref' }), 'out', '"not a client" is never undone by a Ref code');
  assert.equal(nextInboxState('in', { signal: 'unsure', method: 'keyword' }), 'in', 'a guess never demotes a certain chat');
});

test('an undecided or unsure chat becomes in on anything certain, whatever rule matched it', () => {
  for (const current of OPEN) {
    for (const method of METHODS) assert.equal(nextInboxState(current, { signal: 'certain', method }), 'in', `${current} ${method}`);
  }
});

test('a guess — the word, or a keyword or click-window match — makes it unsure', () => {
  for (const current of OPEN) {
    for (const method of METHODS) assert.equal(nextInboxState(current, { signal: 'unsure', method }), 'unsure', `${current} unsure ${method}`);
    for (const method of ['keyword', 'time_window']) assert.equal(nextInboxState(current, { signal: null, method }), 'unsure', `${current} ${method}`);
  }
});

test('with no signal and no guessing rule the state is left as it was', () => {
  for (const method of [null, 'ref', 'phone', 'ad_meta', 'concierge', 'form']) {
    assert.equal(nextInboxState(null, { method }), null, `null ${method}`);
    assert.equal(nextInboxState(undefined, { method }), null, `undefined ${method}`);
    assert.equal(nextInboxState('unsure', { method }), 'unsure', `unsure ${method}`);
  }
  assert.equal(nextInboxState(null), null);
  assert.equal(nextInboxState(undefined), null);
  assert.equal(nextInboxState('unsure'), 'unsure');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/inbox-eligibility.test.mjs`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/services/api/lib/inbox/eligibility.mjs'` (`ℹ fail 1`): the folder `lib/inbox/` and the module do not exist yet.

- [ ] **Step 3: Implement** — create `services/api/lib/inbox/eligibility.mjs`:

```js
/**
 * Which WhatsApp chats belong in the Bona inbox (2026-09-27 design §4.1, D9 and D12).
 *
 * The team reads and answers these chats from the dashboard, and they arrive on the
 * owner's personal number, which his TK clients and private conversations share. So a
 * chat joins only on something that can only be about Bona:
 *
 *   - a client's message carrying a site Ref code, click-to-WhatsApp ad context or a
 *     listing id (`BONA-W003`) is certain;
 *   - a client's message that only says "bona" / "بونا" is a guess. It goes to the
 *     owner's Unsure list, never into the inbox by itself. The other guess, the ±15-min
 *     click window, arrives here as the lead's match method (`time_window`);
 *   - a message the OWNER sends joins a chat only when it carries a Bona site link, a
 *     listing id, or a document (a brochure) whose file name or caption says Bona or a
 *     listing id. Nothing else he types counts: "bona" in a text to a TK client proves
 *     nothing.
 *
 * The answer is stored on the lead (`leads.inbox_state`), and a message only ever moves it
 * forward: a guess can become certain, but `in` is never demoted by a later message and
 * `out` (the owner said "not a client") is never left automatically. Only the owner's
 * buttons move a chat out of either (lib/inbox/store.mjs `setInboxState`).
 *
 * Pure functions, no I/O and no logging: the poller asks, the store records.
 */
import { parseRef } from '../attribution.mjs';

/** A whole listing id: `BONA-W003`, `bona-005` — not `BONA-W0031`, not `XBONA-W003`. */
export const LISTING_ID_RE = /\bBONA-W?\d{3}\b/i;
/** Our name as a word, in either script. A guess on its own: TK and private chats say it too. */
export const BONA_WORD_RE = /\bbona\b|بونا/i;
/**
 * The site (or its legacy host) as a link, with or without a scheme and `www.`. The
 * characters either side must not carry on a host name, so `notbona-real-estate.com`
 * and `bona-real-estate.company` are not ours. A full stop straight after is allowed:
 * a sentence can end with the link.
 */
export const SITE_LINK_RE = /(?:^|[^a-z0-9.-])(?:www\.)?(?:bona-real-estate\.com|bona\.azoz\.uk)(?![a-z0-9-])/i;
export const INBOX_STATES = ['in', 'unsure', 'out'];

/**
 * "bona" in a document's name or caption, bounded by anything that is not a letter.
 * `\b` would miss `Bona_Villa.pdf` (`_` counts as a word character) and a letter-only
 * bound keeps `Bonanza.pdf` out.
 */
const DOC_BONA_RE = /(?:^|[^a-z])bona(?:[^a-z]|$)|بونا/i;

/** Anything that is not a string reads as empty: a record's text or caption may be null. */
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * What one message from a client says about the chat.
 * @param {{ text?: unknown, hasAdMeta?: boolean }} [o]
 * @returns {'certain'|'unsure'|null}
 */
export function inboundSignal({ text = '', hasAdMeta = false } = {}) {
  const t = str(text);
  if (parseRef(t) || hasAdMeta || LISTING_ID_RE.test(t)) return 'certain';
  if (BONA_WORD_RE.test(t)) return 'unsure';
  return null;
}

/**
 * Does a message the owner sent make this a Bona chat (D12)? Takes a normalised record
 * (lib/evolution.mjs): `text` is the body or the caption, `media` the placeholder
 * (`[document: name]`, `[image]`, …) and `fileName` a document's cleaned name.
 * @param {{ text?: unknown, fileName?: unknown, media?: unknown }} [o]
 * @returns {boolean}
 */
export function ownerOutboundJoins({ text = '', fileName = null, media = null } = {}) {
  const t = str(text);
  if (SITE_LINK_RE.test(t) || LISTING_ID_RE.test(t)) return true;
  if (!str(media).startsWith('[document')) return false;
  const name = str(fileName);
  return LISTING_ID_RE.test(name) || DOC_BONA_RE.test(name) || DOC_BONA_RE.test(t);
}

/**
 * The chat's inbox state after one inbound message. `in` and `out` stay as they are; an
 * undecided or unsure chat becomes `in` on anything certain and `unsure` on a guess (the
 * word, or a lead the poller matched only by keyword or click window); otherwise it is
 * left as it was.
 * @param {'in'|'unsure'|'out'|null|undefined} current
 * @param {{ signal?: 'certain'|'unsure'|null, method?: string|null }} [o]
 * @returns {'in'|'unsure'|'out'|null}
 */
export function nextInboxState(current, { signal = null, method = null } = {}) {
  if (current === 'out' || current === 'in') return current;
  if (signal === 'certain') return 'in';
  if (signal === 'unsure' || method === 'keyword' || method === 'time_window') return 'unsure';
  return current ?? null;
}
```

- [ ] **Step 4: Run**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/inbox-eligibility.test.mjs`
Expected: PASS — `ℹ pass 12`, `ℹ fail 0`.

- [ ] **Step 5: Full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: `ℹ fail 0`; `ℹ pass` = the count after Task 2 plus 12 (626 + Task 2's new tests + 12).

- [ ] **Step 6: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/inbox/eligibility.mjs services/api/test/inbox-eligibility.test.mjs
git commit -m "inbox: eligibility rules — what joins by itself, what is a guess, what never moves

A client message is certain on a Ref code, ad context or a listing id and a
guess on the word bona. An owner message joins a chat only with a Bona link,
a listing id or a Bona document. in and out never move on a message.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Inbox store (`lib/inbox/store.mjs`)

All SQL for the Phase 2 tables (`wa_messages`, `wa_outbox`, `inbox_reads`, `wa_gaps`) and the inbox columns on `leads` (`inbox_state`, `inbox_since`, `handler_user_id`, `last_msg_ts`, `needs_human`) lives in this one module. It relies on Task 1 (schema v4, `COLUMNS.leads` taking the new columns, so `db.insertLead` can seed them) and Task 3 (`INBOX_STATES` exported from `lib/inbox/eligibility.mjs`). It creates new files only, so no existing test changes.

**Files:**
- Create: `services/api/lib/inbox/store.mjs`
- Test: `services/api/test/inbox-store.test.mjs`

- [ ] **Step 1: Write the failing tests** — create `services/api/test/inbox-store.test.mjs`:

```js
/**
 * The inbox store: every SQL statement behind the Bona inbox — stored messages, the send
 * outbox, read marks, unloadable-message gaps and the inbox columns on a lead. The clock
 * is injected, so every timestamp is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import {
  createInboxStore, RETENTION_MS, MAX_STORED_TEXT, SENDER_KINDS, OUTBOX_KINDS, OUTBOX_STATUSES,
} from '../lib/inbox/store.mjs';

const NOW = 1_790_500_000_000;
const DAY = 86_400_000;
const JID = '966500000001@s.whatsapp.net';
const OWNER_JID = '966593296933@s.whatsapp.net';

function harness() {
  const s = openDb(':memory:');
  let clock = NOW;
  const inbox = createInboxStore(s, { now: () => clock });
  const team = createTeam(s, { now: () => clock });
  return { s, inbox, team, tick: (ms) => { clock += ms; }, at: (t) => { clock = t; } };
}

/** A lead with only what a test needs; `over` wins. */
const lead = (s, id, over = {}) => s.insertLead({ lead_id: id, created: NOW - DAY, updated: NOW - DAY, channel: 'whatsapp', stage: 'new', ...over });
/** A chat in the Bona inbox. */
const chat = (s, id, over = {}) => lead(s, id, { wa_jid: JID, inbox_state: 'in', inbox_since: NOW - DAY, ...over });
const msg = (over = {}) => ({ key_id: 'K-1', lead_id: 'L-1', jid: JID, direction: 'in', sender_kind: 'client', text: 'hello', ts: NOW, ...over });
const out = (over = {}) => ({ send_id: 'SND-1', lead_id: 'L-1', jid: JID, text: 'on my way', user_id: 'USR-1', sender_kind: 'staff', ...over });
const count = (s, table) => s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const row = (s, keyId) => ({ ...s.db.prepare('SELECT * FROM wa_messages WHERE key_id = ?').get(keyId) });

test('the vocabularies are the ones the schema allows, and retention is five years', () => {
  assert.deepEqual(SENDER_KINDS, ['client', 'staff', 'dana', 'owner_number']);
  assert.deepEqual(OUTBOX_KINDS, ['staff', 'dana', 'code', 'note']);
  assert.deepEqual(OUTBOX_STATUSES, ['pending', 'accepted', 'failed', 'uncertain']);
  assert.equal(MAX_STORED_TEXT, 8000);
  assert.equal(RETENTION_MS, 157_788_000_000);
});

test('upsertMessage stores a message once; seen again it is not a second row', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  assert.deepEqual(inbox.upsertMessage(msg()), { inserted: true });
  assert.deepEqual(row(s, 'K-1'), {
    key_id: 'K-1', lead_id: 'L-1', jid: JID, direction: 'in', sender_kind: 'client', sender_user_id: null,
    text: 'hello', media_type: null, ts: NOW, status: null,
  });
  assert.equal(s.getLead('L-1').last_msg_ts, NOW);
  assert.deepEqual(inbox.upsertMessage(msg()), { inserted: false });
  assert.equal(count(s, 'wa_messages'), 1);
  s.close();
});

test('a message stored as the owner\'s number is upgraded to the staff member or Dana who sent it, never the other way', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  inbox.upsertMessage(msg({ key_id: 'K-out', direction: 'out', sender_kind: 'owner_number', text: 'on my way' }));
  inbox.upsertMessage(msg({ key_id: 'K-out', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-1', text: 'on my way' }));
  assert.equal(row(s, 'K-out').sender_kind, 'staff');
  assert.equal(row(s, 'K-out').sender_user_id, 'USR-1');
  // A later poll that cannot find the outbox row must not demote a known sender.
  inbox.upsertMessage(msg({ key_id: 'K-out', direction: 'out', sender_kind: 'owner_number', text: 'on my way' }));
  assert.equal(row(s, 'K-out').sender_kind, 'staff');
  assert.equal(row(s, 'K-out').sender_user_id, 'USR-1');
  inbox.upsertMessage(msg({ key_id: 'K-out', direction: 'out', sender_kind: 'dana', text: 'on my way' }));
  assert.equal(row(s, 'K-out').sender_kind, 'staff', 'only owner_number is ever upgraded');

  inbox.upsertMessage(msg({ key_id: 'K-dana', direction: 'out', sender_kind: 'owner_number', text: 'Hello from Bona' }));
  inbox.upsertMessage(msg({ key_id: 'K-dana', direction: 'out', sender_kind: 'dana', text: 'Hello from Bona' }));
  assert.equal(row(s, 'K-dana').sender_kind, 'dana');
  assert.equal(row(s, 'K-dana').sender_user_id, null);

  inbox.upsertMessage(msg({ key_id: 'K-in' }));
  inbox.upsertMessage(msg({ key_id: 'K-in', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-1', text: 'changed', jid: 'x@lid', ts: NOW + 5, media_type: '[image]' }));
  assert.deepEqual(row(s, 'K-in'), {
    key_id: 'K-in', lead_id: 'L-1', jid: JID, direction: 'in', sender_kind: 'client', sender_user_id: null,
    text: 'hello', media_type: null, ts: NOW, status: null,
  }, "a client's message is never anyone else's, and nothing else about it changes");
  s.close();
});

test('status is filled in or moved on by a write that carries one, and kept by a write that does not', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  inbox.upsertMessage(msg({ direction: 'out', sender_kind: 'owner_number' }));
  assert.equal(row(s, 'K-1').status, null);
  inbox.upsertMessage(msg({ direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-1', status: 'sent' }));
  assert.equal(row(s, 'K-1').status, 'sent');
  inbox.upsertMessage(msg({ direction: 'out', sender_kind: 'owner_number' }));
  assert.equal(row(s, 'K-1').status, 'sent');
  inbox.upsertMessage(msg({ direction: 'out', sender_kind: 'owner_number', status: 'read' }));
  assert.equal(row(s, 'K-1').status, 'read');
  s.close();
});

test('the chat\'s last-message time only moves forward, and a message seen again keeps its first time', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  inbox.upsertMessage(msg({ key_id: 'K-1', ts: NOW }));
  inbox.upsertMessage(msg({ key_id: 'K-2', ts: NOW - 5000 }));
  assert.equal(s.getLead('L-1').last_msg_ts, NOW, 'an older message arriving late does not move it back');
  inbox.upsertMessage(msg({ key_id: 'K-3', ts: NOW + 5000 }));
  assert.equal(s.getLead('L-1').last_msg_ts, NOW + 5000);
  inbox.upsertMessage(msg({ key_id: 'K-1', ts: NOW + 99_999 }));
  assert.equal(s.getLead('L-1').last_msg_ts, NOW + 5000);
  assert.equal(row(s, 'K-1').ts, NOW);
  s.close();
});

test('stored text is capped at MAX_STORED_TEXT code points, never splitting a pair; a media message may have none', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  inbox.upsertMessage(msg({ key_id: 'K-long', text: 'a'.repeat(9000) }));
  assert.equal(row(s, 'K-long').text, 'a'.repeat(MAX_STORED_TEXT));
  inbox.upsertMessage(msg({ key_id: 'K-emoji', text: `${'a'.repeat(7999)}\u{1F600}b` }));
  const kept = row(s, 'K-emoji').text;
  assert.equal([...kept].length, MAX_STORED_TEXT);
  assert.ok(kept.endsWith('\u{1F600}'), 'the emoji is kept whole');
  inbox.upsertMessage(msg({ key_id: 'K-media', text: null, media_type: '[voice note]' }));
  assert.equal(row(s, 'K-media').text, null);
  assert.equal(row(s, 'K-media').media_type, '[voice note]');
  s.close();
});

test('upsertMessage refuses a bad direction or sender, and a missing key, lead or time', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  for (const bad of [
    { direction: 'sideways' }, { sender_kind: 'lisa' }, { sender_kind: undefined },
    { key_id: undefined }, { key_id: '' }, { lead_id: null },
    { ts: undefined }, { ts: null }, { ts: 'soon' },
  ]) {
    assert.throws(() => inbox.upsertMessage(msg(bad)), RangeError, JSON.stringify(bad));
  }
  assert.equal(count(s, 'wa_messages'), 0);
  assert.equal(s.getLead('L-1').last_msg_ts, null);
  s.close();
});

test('messagesFor returns the newest N of one chat, oldest first; a tie keeps the order they were stored in', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  chat(s, 'L-2');
  for (const [key, ts] of [['K-3', NOW + 3000], ['K-1', NOW + 1000], ['K-5', NOW + 5000], ['K-2', NOW + 2000], ['K-4a', NOW + 4000], ['K-4b', NOW + 4000]]) {
    inbox.upsertMessage(msg({ key_id: key, ts }));
  }
  inbox.upsertMessage(msg({ key_id: 'K-other', lead_id: 'L-2', ts: NOW + 9000 }));
  assert.deepEqual(inbox.messagesFor('L-1', { limit: 3 }).map((m) => m.key_id), ['K-4a', 'K-4b', 'K-5']);
  assert.deepEqual(inbox.messagesFor('L-1').map((m) => m.key_id), ['K-1', 'K-2', 'K-3', 'K-4a', 'K-4b', 'K-5']);
  assert.deepEqual(inbox.messagesFor('L-nope'), []);
  s.close();
});

test('newestTs and hasMessages look at one chat only', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  chat(s, 'L-2');
  assert.equal(inbox.newestTs('L-1'), null);
  assert.equal(inbox.hasMessages('L-1'), false);
  inbox.upsertMessage(msg({ key_id: 'K-1', ts: NOW }));
  inbox.upsertMessage(msg({ key_id: 'K-2', ts: NOW + 700, direction: 'out', sender_kind: 'owner_number' }));
  assert.equal(inbox.newestTs('L-1'), NOW + 700, 'either direction counts');
  assert.equal(inbox.hasMessages('L-1'), true);
  assert.equal(inbox.newestTs('L-2'), null);
  assert.equal(inbox.hasMessages('L-2'), false);
  s.close();
});

test('insertOutbox writes a pending row once; a second insert of the same send_id returns the row already there', () => {
  const { s, inbox, tick } = harness();
  const first = inbox.insertOutbox(out());
  assert.equal(first.inserted, true);
  assert.deepEqual(first.row, {
    send_id: 'SND-1', lead_id: 'L-1', jid: JID, text: 'on my way', user_id: 'USR-1', sender_kind: 'staff',
    status: 'pending', key_id: null, created: NOW, updated: NOW, error: null,
  });
  tick(1000);
  const again = inbox.insertOutbox(out({ text: 'something else', user_id: 'USR-2' }));
  assert.equal(again.inserted, false);
  assert.deepEqual(again.row, first.row);
  assert.equal(count(s, 'wa_outbox'), 1);
  s.close();
});

test('a login-code row never stores its text, whatever the caller passes', () => {
  const { s, inbox } = harness();
  const { row: code } = inbox.insertOutbox({ send_id: 'SND-code', jid: '966500000002@s.whatsapp.net', text: 'Bona dashboard code: 123456 (valid 10 min)', sender_kind: 'code' });
  assert.equal(code.text, null);
  assert.equal(code.lead_id, null);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE text LIKE '%123456%'").get().n, 0);
  s.close();
});

test('insertOutbox refuses an unknown kind or status and a missing send_id or jid', () => {
  const { s, inbox } = harness();
  for (const bad of [{ sender_kind: 'sms' }, { status: 'sent' }, { send_id: undefined }, { send_id: '' }, { jid: null }, { jid: '' }]) {
    assert.throws(() => inbox.insertOutbox(out(bad)), RangeError, JSON.stringify(bad));
  }
  assert.equal(count(s, 'wa_outbox'), 0);
  s.close();
});

test('getOutbox, outboxByKey and updateOutbox: a key is recorded, an error is capped, a missing field is kept', () => {
  const { s, inbox, tick } = harness();
  inbox.insertOutbox(out());
  inbox.insertOutbox(out({ send_id: 'SND-2' }));
  assert.equal(inbox.getOutbox('SND-nope'), null);
  assert.equal(inbox.outboxByKey(null), null);
  assert.equal(inbox.outboxByKey(''), null, 'rows still waiting for a key are not "the row for" an empty key');

  tick(2000);
  assert.equal(inbox.updateOutbox('SND-1', { status: 'accepted', key_id: 'KEY-9' }), true);
  const accepted = inbox.getOutbox('SND-1');
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.key_id, 'KEY-9');
  assert.equal(accepted.updated, NOW + 2000);
  assert.equal(accepted.created, NOW);
  assert.equal(inbox.outboxByKey('KEY-9').send_id, 'SND-1');
  assert.equal(inbox.outboxByKey('KEY-nope'), null);

  assert.equal(inbox.updateOutbox('SND-2', { status: 'failed', error: 'x'.repeat(500) }), true);
  assert.equal(inbox.getOutbox('SND-2').error.length, 200);
  inbox.updateOutbox('SND-2', { status: 'uncertain' });
  assert.equal(inbox.getOutbox('SND-2').error, 'x'.repeat(200), 'left out means kept');
  assert.equal(inbox.getOutbox('SND-2').key_id, null);
  inbox.updateOutbox('SND-2', { status: 'uncertain', error: null });
  assert.equal(inbox.getOutbox('SND-2').error, null, 'null clears');

  assert.equal(inbox.updateOutbox('SND-nope', { status: 'failed' }), false);
  assert.throws(() => inbox.updateOutbox('SND-1', { status: 'sent' }), RangeError);
  assert.throws(() => inbox.updateOutbox('SND-1', {}), RangeError);
  s.close();
});

test('resolveUncertain finds the oldest unresolved send of the same lead with the same text; accepted and keyed rows never match', () => {
  const { s, inbox, at } = harness();
  const text = 'see you at 5';
  at(NOW - 1000);
  inbox.insertOutbox(out({ send_id: 'SND-accepted', text, status: 'accepted' }));
  inbox.insertOutbox(out({ send_id: 'SND-keyed', text, status: 'uncertain' }));
  inbox.updateOutbox('SND-keyed', { status: 'uncertain', key_id: 'KEY-7' });
  inbox.insertOutbox(out({ send_id: 'SND-failed', text, status: 'failed' }));
  at(NOW);
  inbox.insertOutbox(out({ send_id: 'SND-old', text, status: 'uncertain' }));
  inbox.insertOutbox(out({ send_id: 'SND-other-text', text: 'see you at 6', status: 'uncertain' }));
  inbox.insertOutbox(out({ send_id: 'SND-other-lead', lead_id: 'L-2', text, status: 'uncertain' }));
  at(NOW + 10_000);
  inbox.insertOutbox(out({ send_id: 'SND-new', text }));

  assert.equal(inbox.resolveUncertain({ leadId: 'L-1', text, ts: NOW + 5000 }).send_id, 'SND-old', 'the oldest wins');
  assert.equal(inbox.resolveUncertain({ leadId: 'L-2', text, ts: NOW + 5000 }).send_id, 'SND-other-lead');
  assert.equal(inbox.resolveUncertain({ leadId: 'L-1', text: 'see you at 6', ts: NOW }).send_id, 'SND-other-text');
  assert.equal(inbox.resolveUncertain({ leadId: 'L-1', text: 'see you at 5 ', ts: NOW }), null, 'the text must be identical');
  assert.equal(inbox.resolveUncertain({ leadId: 'L-1', text: 'See you at 5', ts: NOW }), null);
  assert.equal(inbox.resolveUncertain({ leadId: 'L-1', text: null, ts: NOW }), null);
  assert.equal(inbox.resolveUncertain({ leadId: 'L-3', text, ts: NOW }), null);
  assert.equal(inbox.getOutbox('SND-old').status, 'uncertain', 'read-only: nothing is resolved here');
  assert.equal(inbox.getOutbox('SND-old').key_id, null);
  s.close();
});

test('resolveUncertain matches within two minutes of the send either way, edges included', () => {
  const { s, inbox } = harness();
  inbox.insertOutbox(out({ send_id: 'SND-edge', lead_id: 'L-3', text: 'ok', status: 'pending' }));
  const find = (ts, extra = {}) => inbox.resolveUncertain({ leadId: 'L-3', text: 'ok', ts, ...extra })?.send_id ?? null;
  assert.equal(find(NOW + 120_000), 'SND-edge');
  assert.equal(find(NOW + 120_001), null);
  assert.equal(find(NOW - 120_000), 'SND-edge');
  assert.equal(find(NOW - 120_001), null);
  assert.equal(find(NOW + 1000, { windowMs: 1000 }), 'SND-edge');
  assert.equal(find(NOW + 1001, { windowMs: 1000 }), null);
  s.close();
});

test('openOutboxFor lists the staff and Dana sends of one chat that did not surely go: newest 20, oldest first', () => {
  const { s, inbox, tick } = harness();
  inbox.insertOutbox(out({ send_id: 'SND-p' }));
  tick(1000);
  inbox.insertOutbox(out({ send_id: 'SND-u', sender_kind: 'dana', user_id: null, status: 'uncertain' }));
  tick(1000);
  inbox.insertOutbox(out({ send_id: 'SND-f', status: 'failed' }));
  tick(1000);
  inbox.insertOutbox(out({ send_id: 'SND-a', status: 'accepted' }));
  inbox.insertOutbox(out({ send_id: 'SND-code', sender_kind: 'code', status: 'failed' }));
  inbox.insertOutbox(out({ send_id: 'SND-note', sender_kind: 'note', status: 'failed' }));
  inbox.insertOutbox(out({ send_id: 'SND-x', lead_id: 'L-2', status: 'failed' }));
  assert.deepEqual(inbox.openOutboxFor('L-1').map((r) => r.send_id), ['SND-p', 'SND-u', 'SND-f']);
  assert.deepEqual(inbox.openOutboxFor('L-1', { sinceTs: NOW + 1000 }).map((r) => r.send_id), ['SND-u', 'SND-f']);

  for (let i = 1; i <= 20; i += 1) {
    tick(1000);
    inbox.insertOutbox(out({ send_id: `SND-f${String(i).padStart(2, '0')}`, status: 'failed' }));
  }
  const open = inbox.openOutboxFor('L-1').map((r) => r.send_id);
  assert.equal(open.length, 20);
  assert.equal(open[0], 'SND-f01');
  assert.equal(open[19], 'SND-f20');
  s.close();
});

test('countSentSince counts what may have gone in the window, and can leave the owner\'s own chat out', () => {
  const { s, inbox, at } = harness();
  const since = NOW - DAY;
  at(since - 1);
  inbox.insertOutbox(out({ send_id: 'SND-before', status: 'accepted' }));
  at(since);
  inbox.insertOutbox(out({ send_id: 'SND-edge', status: 'accepted' }));
  at(NOW);
  inbox.insertOutbox(out({ send_id: 'SND-p' }));
  inbox.insertOutbox(out({ send_id: 'SND-a', jid: '966500000002@s.whatsapp.net', status: 'accepted' }));
  inbox.insertOutbox(out({ send_id: 'SND-u', jid: '966500000003@s.whatsapp.net', status: 'uncertain' }));
  inbox.insertOutbox(out({ send_id: 'SND-f', jid: '966500000004@s.whatsapp.net', status: 'failed' }));
  inbox.insertOutbox({ send_id: 'SND-own', jid: OWNER_JID, sender_kind: 'code', status: 'accepted' });
  assert.equal(inbox.countSentSince(since), 5, 'the edge row counts; the failed one and the older one do not');
  assert.equal(inbox.countSentSince(since, { excludeJid: OWNER_JID }), 4);
  assert.equal(inbox.countSentSince(since + 1), 4);
  assert.equal(inbox.countSentSince(since, { excludeJid: null }), 5);
  s.close();
});

test('markStalePending turns pending rows older than the cutoff into uncertain (interrupted), once', () => {
  const { s, inbox, at } = harness();
  at(NOW - 200_000);
  inbox.insertOutbox(out({ send_id: 'SND-stale' }));
  inbox.insertOutbox(out({ send_id: 'SND-accepted', status: 'accepted' }));
  at(NOW - 300_000);
  inbox.insertOutbox(out({ send_id: 'SND-uncertain', status: 'uncertain' }));
  at(NOW - 120_000);
  inbox.insertOutbox(out({ send_id: 'SND-edge' }));
  at(NOW);
  inbox.insertOutbox(out({ send_id: 'SND-fresh' }));
  assert.equal(inbox.markStalePending(NOW - 120_000), 1);
  const stale = inbox.getOutbox('SND-stale');
  assert.equal(stale.status, 'uncertain');
  assert.equal(stale.error, 'interrupted');
  assert.equal(stale.updated, NOW);
  assert.equal(inbox.getOutbox('SND-edge').status, 'pending', 'exactly at the cutoff is not older than it');
  assert.equal(inbox.getOutbox('SND-fresh').status, 'pending');
  assert.equal(inbox.getOutbox('SND-accepted').status, 'accepted');
  assert.equal(inbox.getOutbox('SND-uncertain').error, null);
  assert.equal(inbox.markStalePending(NOW - 120_000), 0);
  s.close();
});

test('pruneCodeRows deletes only login-code rows older than the cutoff', () => {
  const { s, inbox, at } = harness();
  at(NOW - 3 * DAY);
  inbox.insertOutbox({ send_id: 'SND-code-old', jid: JID, sender_kind: 'code', status: 'accepted' });
  inbox.insertOutbox(out({ send_id: 'SND-staff-old', status: 'accepted' }));
  at(NOW - DAY);
  inbox.insertOutbox({ send_id: 'SND-code-new', jid: JID, sender_kind: 'code', status: 'accepted' });
  assert.equal(inbox.pruneCodeRows(NOW - 2 * DAY), 1);
  assert.equal(inbox.getOutbox('SND-code-old'), null);
  assert.ok(inbox.getOutbox('SND-code-new'));
  assert.ok(inbox.getOutbox('SND-staff-old'));
  s.close();
});

test('markRead never moves backwards, is per person, and shrugs off a chat with nothing to mark', () => {
  const { s, inbox } = harness();
  const mark = (user, leadId) => s.db.prepare('SELECT last_read_ts FROM inbox_reads WHERE user_id = ? AND lead_id = ?').get(user, leadId)?.last_read_ts ?? null;
  assert.equal(inbox.markRead('USR-1', 'L-1', NOW), true);
  assert.equal(mark('USR-1', 'L-1'), NOW);
  inbox.markRead('USR-1', 'L-1', NOW - 50);
  assert.equal(mark('USR-1', 'L-1'), NOW, 'an old page submitted late does not un-read anything');
  inbox.markRead('USR-1', 'L-1', NOW + 200);
  assert.equal(mark('USR-1', 'L-1'), NOW + 200);
  inbox.markRead('USR-2', 'L-1', NOW - 999);
  assert.equal(mark('USR-2', 'L-1'), NOW - 999);
  assert.equal(mark('USR-1', 'L-1'), NOW + 200);
  assert.equal(inbox.markRead('USR-1', 'L-1', null), false);
  assert.equal(inbox.markRead(null, 'L-1', NOW), false);
  assert.equal(inbox.markRead('USR-1', '', NOW), false);
  assert.equal(count(s, 'inbox_reads'), 2);
  s.close();
});

/**
 * Chats for the list tests. For a reader with no read marks and an account from before
 * every message: B has 2 unread, G 1; A was read up to its last inbound message; C has no
 * messages yet. D (no WhatsApp id), E (unsure) and F (out) are not inbox chats.
 */
function listScene() {
  const h = harness();
  const { s, inbox, team } = h;
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: 'Sara', phone: '0500000011' });
  const gone = team.addUser({ name: 'Gone', phone: '0500000012' });
  team.deactivateUser(gone.user_id);
  chat(s, 'A', { wa_jid: '966500000021@s.whatsapp.net', handler_user_id: sara.user_id, click_ids: { fbclid: 'IwAR1' } });
  chat(s, 'B', { wa_jid: null, wa_lid: '272516946294519@lid' });
  chat(s, 'C', { wa_jid: '966500000023@s.whatsapp.net', inbox_since: NOW - 1000 });
  chat(s, 'D', { wa_jid: null, phone_e164: '966500000024', channel: 'form' });
  chat(s, 'E', { wa_jid: '966500000025@s.whatsapp.net', inbox_state: 'unsure', inbox_since: null });
  chat(s, 'F', { wa_jid: '966500000026@s.whatsapp.net', inbox_state: 'out', inbox_since: null });
  chat(s, 'G', { wa_jid: '966500000027@s.whatsapp.net', handler_user_id: gone.user_id });
  inbox.upsertMessage(msg({ key_id: 'A-1', lead_id: 'A', text: 'is the villa free?', ts: NOW - 5000 }));
  inbox.upsertMessage(msg({ key_id: 'A-2', lead_id: 'A', direction: 'out', sender_kind: 'staff', sender_user_id: sara.user_id, text: 'yes, come on Sunday', ts: NOW - 4000 }));
  inbox.upsertMessage(msg({ key_id: 'B-1', lead_id: 'B', text: 'hello', ts: NOW - 9000 }));
  inbox.upsertMessage(msg({ key_id: 'B-2', lead_id: 'B', text: null, media_type: '[image]', ts: NOW - 8000 }));
  inbox.upsertMessage(msg({ key_id: 'E-1', lead_id: 'E', ts: NOW - 100 }));
  inbox.upsertMessage(msg({ key_id: 'F-1', lead_id: 'F', ts: NOW - 100 }));
  inbox.upsertMessage(msg({ key_id: 'G-1', lead_id: 'G', ts: NOW - 20_000 }));
  inbox.markRead(owner.user_id, 'A', NOW - 5000);
  return { ...h, owner, sara };
}

test('listInbox shows inbox chats only: unread first, then the most recent, with the last message and the handler', () => {
  const { s, inbox, owner } = listScene();
  const rows = inbox.listInbox({ userId: owner.user_id });
  assert.deepEqual(rows.map((r) => r.lead_id), ['B', 'G', 'C', 'A']);
  assert.deepEqual(rows.map((r) => r.unread), [2, 1, 0, 0]);

  const a = rows.find((r) => r.lead_id === 'A');
  assert.equal(a.last_text, 'yes, come on Sunday');
  assert.equal(a.last_media, null);
  assert.equal(a.last_direction, 'out');
  assert.equal(a.last_sender_kind, 'staff');
  assert.equal(a.handler_name, 'Sara');
  assert.equal(a.stage, 'new');
  assert.equal(a.inbox_state, 'in');
  assert.equal(a.last_msg_ts, NOW - 4000);
  assert.deepEqual(a.click_ids, { fbclid: 'IwAR1' }, 'JSON columns read the way getLead() reads them');

  const b = rows.find((r) => r.lead_id === 'B');
  assert.equal(b.last_text, null);
  assert.equal(b.last_media, '[image]');
  assert.equal(b.last_direction, 'in');
  assert.equal(b.last_sender_kind, 'client');
  assert.equal(b.handler_name, null);

  const c = rows.find((r) => r.lead_id === 'C');
  assert.equal(c.last_text, null);
  assert.equal(c.last_direction, null);
  assert.equal(rows.find((r) => r.lead_id === 'G').handler_name, null, 'a deactivated handler is nobody');

  assert.deepEqual(inbox.listInbox({ userId: owner.user_id, limit: 2 }).map((r) => r.lead_id), ['B', 'G']);
  s.close();
});

test('unread counts only messages after the person\'s read mark, or after their account was made', () => {
  const { s, inbox, owner, sara } = listScene();
  // Sara's account is newer than G's message: it is not unread for her.
  const late = inbox.listInbox({ userId: sara.user_id, userCreated: NOW - 10_000 });
  assert.deepEqual(late.map((r) => r.lead_id), ['A', 'B', 'C', 'G']);
  assert.deepEqual(late.map((r) => r.unread), [1, 2, 0, 0], 'A-1 is unread for Sara: the owner\'s read mark is his own');
  inbox.markRead(owner.user_id, 'B', NOW - 9000);
  assert.equal(inbox.listInbox({ userId: owner.user_id }).find((r) => r.lead_id === 'B').unread, 1);
  s.close();
});

test('unreadTotal is the same rule summed over every inbox chat, and nothing outside it', () => {
  const { s, inbox, owner, sara } = listScene();
  const sum = (rows) => rows.reduce((n, r) => n + r.unread, 0);
  assert.equal(inbox.unreadTotal({ userId: owner.user_id }), 3, 'E and F have unread messages but are not inbox chats');
  assert.equal(inbox.unreadTotal({ userId: owner.user_id }), sum(inbox.listInbox({ userId: owner.user_id })));
  assert.equal(inbox.unreadTotal({ userId: sara.user_id, userCreated: NOW - 10_000 }), 3);
  assert.equal(inbox.unreadTotal({ userId: sara.user_id, userCreated: NOW - 10_000 }), sum(inbox.listInbox({ userId: sara.user_id, userCreated: NOW - 10_000 })));
  inbox.markRead(owner.user_id, 'B', NOW);
  inbox.markRead(owner.user_id, 'G', NOW);
  assert.equal(inbox.unreadTotal({ userId: owner.user_id }), 0);
  assert.equal(inbox.unreadTotal({}), 4, 'no reader: every inbound message of every chat');
  s.close();
});

test('listInbox breaks a tie by the newest row', () => {
  const { s, inbox } = harness();
  chat(s, 'T-1', { inbox_since: NOW - 1000 });
  chat(s, 'T-2', { inbox_since: NOW - 1000 });
  assert.deepEqual(inbox.listInbox({ userId: 'USR-1' }).map((r) => r.lead_id), ['T-2', 'T-1']);
  s.close();
});

test('listUnsure and countUnsure: unsure or unplaced chats only, newest first, with the first message\'s snippet', () => {
  const { s, inbox } = harness();
  lead(s, 'U1', { created: NOW - 3000, wa_jid: '966500000031@s.whatsapp.net', inbox_state: 'unsure' });
  s.addTouchpoint({ lead_id: 'U1', ts: NOW - 3000, channel: 'whatsapp', event_type: 'lead_created', meta: { match_method: 'keyword', snippet: 'is this bona?' } });
  lead(s, 'U2', { created: NOW - 2000, wa_lid: '111222333@lid' });
  s.db.prepare('INSERT INTO touchpoints (id, lead_id, ts, event_type, meta) VALUES (?,?,?,?,?)').run('tp-bad', 'U2', NOW - 2000, 'lead_created', '{not json');
  lead(s, 'U3', { created: NOW - 500, phone_e164: '966500000033', inbox_state: 'unsure' });
  lead(s, 'U4', { created: NOW - 400, wa_jid: '966500000034@s.whatsapp.net', inbox_state: 'in' });
  lead(s, 'U5', { created: NOW - 300, wa_jid: '966500000035@s.whatsapp.net', inbox_state: 'out' });
  lead(s, 'U6', { created: NOW - 1000, wa_jid: '966500000036@s.whatsapp.net', inbox_state: 'unsure' });
  s.addTouchpoint({ lead_id: 'U6', ts: NOW - 900, channel: 'whatsapp', event_type: 'stage_change', meta: { snippet: 'not the first message' } });

  const rows = inbox.listUnsure();
  assert.deepEqual(rows.map((r) => r.lead_id), ['U6', 'U2', 'U1']);
  assert.deepEqual(rows.map((r) => r.snippet), [null, null, 'is this bona?'], 'bad JSON meta shows no snippet instead of failing');
  assert.equal(rows[1].inbox_state, null, 'a chat not placed yet counts as unsure');
  assert.equal(inbox.countUnsure(), 3);
  assert.deepEqual(inbox.listUnsure({ limit: 1 }).map((r) => r.lead_id), ['U6']);
  s.close();
});

test('addGap records a message that could not be read, once; gapsFor lists one chat oldest first', () => {
  const { s, inbox } = harness();
  assert.equal(inbox.addGap({ key_id: 'G-2', lead_id: 'L-1', jid: JID, ts: NOW + 10, reason: 'failed' }), true);
  assert.equal(inbox.addGap({ key_id: 'G-1', lead_id: 'L-1', ts: NOW, reason: 'failed' }), true);
  assert.equal(inbox.addGap({ key_id: 'G-1', lead_id: 'L-1', ts: NOW, reason: 'failed' }), false);
  inbox.addGap({ key_id: 'G-x', lead_id: 'L-2', ts: NOW, reason: 'failed' });
  assert.deepEqual(inbox.gapsFor('L-1'), [
    { key_id: 'G-1', lead_id: 'L-1', jid: null, ts: NOW, reason: 'failed' },
    { key_id: 'G-2', lead_id: 'L-1', jid: JID, ts: NOW + 10, reason: 'failed' },
  ]);
  assert.throws(() => inbox.addGap({ lead_id: 'L-1', ts: NOW, reason: 'failed' }), RangeError);
  s.close();
});

test('setInboxState keeps the first joining time, sets it on joining, and clears it on leaving', () => {
  const { s, inbox, tick } = harness();
  lead(s, 'X', { wa_jid: JID, inbox_state: 'unsure' });
  lead(s, 'Y', { wa_jid: '966500000041@s.whatsapp.net' });
  lead(s, 'Z', { wa_jid: '966500000042@s.whatsapp.net', inbox_state: 'in', inbox_since: null });

  tick(1000);
  assert.equal(inbox.setInboxState('X', 'in', { since: NOW - 500 }), true);
  assert.equal(s.getLead('X').inbox_state, 'in');
  assert.equal(s.getLead('X').inbox_since, NOW - 500);
  assert.equal(s.getLead('X').updated, NOW + 1000);

  tick(1000);
  inbox.setInboxState('X', 'in', { since: NOW + 999 });
  assert.equal(s.getLead('X').inbox_since, NOW - 500, 'already in: the first joining time stays');
  assert.equal(s.getLead('X').updated, NOW + 2000);

  inbox.setInboxState('Y', 'in');
  assert.equal(s.getLead('Y').inbox_since, NOW + 2000, 'since defaults to now');
  inbox.setInboxState('Z', 'in', { since: NOW - 7 });
  assert.equal(s.getLead('Z').inbox_since, NOW - 7, 'an in chat missing its time gets one');

  inbox.setInboxState('X', 'unsure');
  assert.equal(s.getLead('X').inbox_state, 'unsure');
  assert.equal(s.getLead('X').inbox_since, null);
  inbox.setInboxState('X', 'in', { since: NOW + 3000 });
  assert.equal(s.getLead('X').inbox_since, NOW + 3000, 'joining again starts again');
  inbox.setInboxState('X', 'out');
  assert.equal(s.getLead('X').inbox_state, 'out');
  assert.equal(s.getLead('X').inbox_since, null);

  assert.throws(() => inbox.setInboxState('X', 'maybe'), RangeError);
  assert.throws(() => inbox.setInboxState('X', null), RangeError);
  assert.equal(s.getLead('X').inbox_state, 'out');
  assert.equal(inbox.setInboxState('L-nope', 'in'), false);
  s.close();
});

test('setHandler and setNeedsHuman write the lead and say whether there was one', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  assert.equal(inbox.setHandler('L-1', 'USR-1'), true);
  assert.equal(s.getLead('L-1').handler_user_id, 'USR-1');
  assert.equal(inbox.setHandler('L-1', null), true);
  assert.equal(s.getLead('L-1').handler_user_id, null);
  assert.equal(inbox.setHandler('L-nope', 'USR-1'), false);

  assert.equal(inbox.setNeedsHuman('L-1', 1), true);
  assert.equal(s.getLead('L-1').needs_human, 1);
  inbox.setNeedsHuman('L-1', 0);
  assert.equal(s.getLead('L-1').needs_human, 0);
  inbox.setNeedsHuman('L-1', true);
  assert.equal(s.getLead('L-1').needs_human, 1);
  assert.equal(inbox.setNeedsHuman('L-nope', 1), false);
  s.close();
});

/** Two chats with a transcript each; L-1 also has a login-code row that names it. */
function purgeScene() {
  const h = harness();
  const { s, inbox } = h;
  chat(s, 'L-1', { handler_user_id: 'USR-1', needs_human: 1 });
  chat(s, 'L-2', { wa_jid: '966500000002@s.whatsapp.net' });
  inbox.upsertMessage(msg({ key_id: 'K-1', ts: NOW - 2000 }));
  inbox.upsertMessage(msg({ key_id: 'K-2', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-1', ts: NOW - 1000 }));
  inbox.upsertMessage(msg({ key_id: 'K-9', lead_id: 'L-2', ts: NOW - 500 }));
  inbox.insertOutbox(out({ send_id: 'SND-staff' }));
  inbox.insertOutbox(out({ send_id: 'SND-dana', sender_kind: 'dana', user_id: null }));
  inbox.insertOutbox({ send_id: 'SND-code-lead', lead_id: 'L-1', jid: JID, sender_kind: 'code' });
  inbox.insertOutbox({ send_id: 'SND-code', jid: JID, sender_kind: 'code' });
  inbox.insertOutbox(out({ send_id: 'SND-l2', lead_id: 'L-2' }));
  inbox.addGap({ key_id: 'G-1', lead_id: 'L-1', ts: NOW - 1500, reason: 'failed' });
  inbox.addGap({ key_id: 'G-9', lead_id: 'L-2', ts: NOW - 400, reason: 'failed' });
  inbox.markRead('USR-1', 'L-1', NOW);
  inbox.markRead('USR-2', 'L-1', NOW);
  inbox.markRead('USR-1', 'L-2', NOW);
  return h;
}

test('purgeLead deletes one chat\'s transcript and keeps login-code rows and every other chat', () => {
  const { s, inbox } = purgeScene();
  assert.deepEqual(inbox.purgeLead('L-1'), { messages: 2, outbox: 2, gaps: 1, reads: 2 });
  const l1 = s.getLead('L-1');
  assert.equal(l1.last_msg_ts, null);
  assert.equal(l1.inbox_state, 'in', 'purging is not leaving');
  assert.equal(inbox.hasMessages('L-1'), false);
  assert.ok(inbox.getOutbox('SND-code-lead'));
  assert.ok(inbox.getOutbox('SND-code'));
  assert.equal(inbox.getOutbox('SND-staff'), null);
  assert.equal(inbox.getOutbox('SND-dana'), null);
  assert.deepEqual(inbox.gapsFor('L-1'), []);

  assert.deepEqual(inbox.messagesFor('L-2').map((m) => m.key_id), ['K-9']);
  assert.equal(s.getLead('L-2').last_msg_ts, NOW - 500);
  assert.ok(inbox.getOutbox('SND-l2'));
  assert.equal(inbox.gapsFor('L-2').length, 1);
  assert.equal(count(s, 'inbox_reads'), 1);
  assert.deepEqual(inbox.purgeLead('L-1'), { messages: 0, outbox: 0, gaps: 0, reads: 0 });
  s.close();
});

test('leaveInbox moves a chat out, purges it, and clears its handler and needs-human flag', () => {
  const { s, inbox } = purgeScene();
  assert.deepEqual(inbox.leaveInbox('L-1'), { messages: 2, outbox: 2, gaps: 1, reads: 2 });
  const l1 = s.getLead('L-1');
  assert.equal(l1.inbox_state, 'out');
  assert.equal(l1.inbox_since, null);
  assert.equal(l1.handler_user_id, null);
  assert.equal(l1.needs_human, 0);
  assert.equal(l1.last_msg_ts, null);
  assert.equal(inbox.hasMessages('L-1'), false);
  assert.equal(inbox.hasMessages('L-2'), true);
  s.close();
});

test('leaveInbox is all or nothing: a failure half-way leaves the chat in, with its transcript', () => {
  const { s, inbox } = purgeScene();
  s.db.exec('DROP TABLE inbox_reads');
  assert.throws(() => inbox.leaveInbox('L-1'), /inbox_reads/);
  const l1 = s.getLead('L-1');
  assert.equal(l1.inbox_state, 'in');
  assert.equal(l1.handler_user_id, 'USR-1');
  assert.equal(l1.needs_human, 1);
  assert.equal(l1.last_msg_ts, NOW - 1000);
  assert.deepEqual(inbox.messagesFor('L-1').map((m) => m.key_id), ['K-1', 'K-2']);
  assert.ok(inbox.getOutbox('SND-staff'));
  s.close();
});

test('retentionPurge deletes the transcripts of chats silent since before the cutoff; lead rows stay', () => {
  const { s, inbox } = harness();
  const cutoff = NOW - RETENTION_MS;
  chat(s, 'OLD');
  chat(s, 'EDGE', { wa_jid: '966500000051@s.whatsapp.net' });
  chat(s, 'NEW', { wa_jid: '966500000052@s.whatsapp.net' });
  chat(s, 'EMPTY', { wa_jid: '966500000053@s.whatsapp.net', last_msg_ts: cutoff - 99 });
  inbox.upsertMessage(msg({ key_id: 'O-1', lead_id: 'OLD', ts: cutoff - 5000 }));
  inbox.upsertMessage(msg({ key_id: 'O-2', lead_id: 'OLD', ts: cutoff - 1 }));
  inbox.insertOutbox(out({ send_id: 'SND-old', lead_id: 'OLD' }));
  inbox.upsertMessage(msg({ key_id: 'E-1', lead_id: 'EDGE', ts: cutoff }));
  inbox.upsertMessage(msg({ key_id: 'N-1', lead_id: 'NEW', ts: NOW - 1000 }));

  assert.deepEqual(inbox.retentionPurge(cutoff), { leads: 1, messages: 2 });
  assert.ok(s.getLead('OLD'), 'the lead row stays: it is attribution data');
  assert.equal(s.getLead('OLD').last_msg_ts, null);
  assert.equal(inbox.hasMessages('OLD'), false);
  assert.equal(inbox.getOutbox('SND-old'), null);
  assert.equal(inbox.hasMessages('EDGE'), true, 'exactly at the cutoff is not older than it');
  assert.equal(inbox.hasMessages('NEW'), true);
  assert.equal(s.getLead('EMPTY').last_msg_ts, cutoff - 99, 'nothing to delete: not counted, not touched');
  assert.deepEqual(inbox.retentionPurge(cutoff), { leads: 0, messages: 0 });
  s.close();
});

test('statements are prepared once per store, not on every call', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  let prepares = 0;
  const realPrepare = s.db.prepare.bind(s.db);
  s.db.prepare = (sql) => { prepares += 1; return realPrepare(sql); };
  inbox.newestTs('L-1');
  inbox.newestTs('L-1');
  inbox.hasMessages('L-1');
  inbox.hasMessages('L-1');
  assert.equal(prepares, 2);
  s.db.prepare = realPrepare;
  s.close();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/inbox-store.test.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`: `services/api/lib/inbox/store.mjs` does not exist yet (0 tests run).

- [ ] **Step 3: Implement** — create `services/api/lib/inbox/store.mjs`:

```js
/**
 * Everything the Bona inbox keeps (2026-09-27 design §4.1–4.2): the stored transcript of
 * each inbox chat, the outbox every send from the owner's number is written to before it
 * goes, who has read what, the messages that could not be loaded, and the inbox columns
 * on the lead itself.
 *
 * Only this file writes SQL for `wa_messages`, `wa_outbox`, `inbox_reads` and `wa_gaps`.
 * Which chat belongs in the inbox is decided in `eligibility.mjs` and by the owner; this
 * file only records the outcome, so a guessed lead can never slip in by being re-derived.
 *
 * Message text is personal data. Nothing here logs, and nothing here puts text into an
 * error message. A login code never reaches the file: a `code` outbox row stores NULL
 * text whatever the caller passes (design §4.2).
 */
import { INBOX_STATES } from './eligibility.mjs';

/** Transcripts are kept for 5 years after the chat's last message (D11). */
export const RETENTION_MS = Math.round(5 * 365.25 * 86_400_000);
export const MAX_STORED_TEXT = 8000;
export const SENDER_KINDS = ['client', 'staff', 'dana', 'owner_number'];
export const OUTBOX_KINDS = ['staff', 'dana', 'code', 'note'];
export const OUTBOX_STATUSES = ['pending', 'accepted', 'failed', 'uncertain'];
const DIRECTIONS = ['in', 'out'];
const MAX_ERROR = 200;

/** JSON columns of `leads` — the same three `db.mjs` parses — so a list row reads like `getLead()`. */
const LEAD_JSON = ['click_ids', 'first_touch', 'last_touch'];

const plain = (row) => (row ? { ...row } : null);
const str = (v) => (v === null || v === undefined ? null : String(v));
const hasNumber = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const toTs = (v) => Math.trunc(Number(v));
/**
 * A cutoff or a start time. Anything unusable becomes 0, the harmless end for every caller
 * here: a purge, prune or stale-mark given garbage touches nothing, and the day-cap count
 * counts everything (so it refuses rather than overspends).
 */
const num = (v) => (hasNumber(v) ? Number(v) : 0);
// A fractional LIMIT is truncated rather than passed through, the same as `waitingLeads()`
// in db.mjs.
const clampLimit = (limit, fallback) => Math.trunc(Math.max(1, Math.min(1000, Number(limit) || fallback)));

function leadRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const col of LEAD_JSON) {
    if (out[col] === null || out[col] === undefined) { out[col] = null; continue; }
    try { out[col] = JSON.parse(out[col]); } catch { out[col] = null; }
  }
  return out;
}

/**
 * At most `MAX_STORED_TEXT` code points, never splitting a surrogate pair. That many code
 * points always fit in the first 2 × MAX_STORED_TEXT UTF-16 units, so a huge string is
 * never spread into an array whole.
 */
function capText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (s.length <= MAX_STORED_TEXT) return s;
  return Array.from(s.slice(0, MAX_STORED_TEXT * 2)).slice(0, MAX_STORED_TEXT).join('');
}

// A chat is a lead in the inbox that has a WhatsApp id (P2-1): a form lead with only a
// phone number is `in` but has nothing to show until that person writes.
const IN_CHAT = "l.inbox_state = 'in' AND (l.wa_jid IS NOT NULL OR l.wa_lid IS NOT NULL)";
// NULL counts as unsure: a WhatsApp lead the poller has not placed yet is a guess until
// the owner decides.
const UNSURE_CHAT = "(l.inbox_state = 'unsure' OR l.inbox_state IS NULL) AND (l.wa_jid IS NOT NULL OR l.wa_lid IS NOT NULL)";

/**
 * @param {ReturnType<import('../db.mjs').openDb>} store
 * @param {{ now?: () => number }} [o]
 */
export function createInboxStore(store, { now = () => Date.now() } = {}) {
  const { db, transaction } = store;
  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  /* -------------------- messages -------------------- */

  /**
   * Store one message of an inbox chat, once. A message seen again (a re-poll, a thread
   * refresh, the dashboard's own write after a send) changes only two things:
   *
   *   - the sender, and only from `owner_number` to `staff`/`dana`. The poller can read a
   *     sent message back before the send that made it has recorded its key (both wait on
   *     the network) and store it as the owner's number; the send's own write corrects
   *     that. Never the other way: a later poll that cannot find the outbox row must not
   *     demote a known sender, and a client's message is never anyone else's.
   *   - `status`, when the new write carries one.
   *
   * The chat's `last_msg_ts` only ever moves forward, and a message seen again counts with
   * the time it was first stored at, so it cannot push the chat anywhere new.
   *
   * @returns {{ inserted: boolean }}
   */
  function upsertMessage({ key_id, lead_id, jid = null, direction, sender_kind, sender_user_id = null, text = null, media_type = null, ts, status = null } = {}) {
    if (!key_id) throw new RangeError('key_id is required');
    if (!lead_id) throw new RangeError('lead_id is required');
    if (!hasNumber(ts)) throw new RangeError('ts is required');
    if (!DIRECTIONS.includes(direction)) throw new RangeError(`unknown direction ${direction}`);
    if (!SENDER_KINDS.includes(sender_kind)) throw new RangeError(`unknown sender_kind ${sender_kind}`);
    return transaction(() => {
      const existing = prep('SELECT lead_id, ts FROM wa_messages WHERE key_id = ?').get(String(key_id));
      prep(`INSERT INTO wa_messages (key_id, lead_id, jid, direction, sender_kind, sender_user_id, text, media_type, ts, status)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(key_id) DO UPDATE SET
              sender_kind = CASE WHEN sender_kind = 'owner_number' AND excluded.sender_kind IN ('staff','dana') THEN excluded.sender_kind ELSE sender_kind END,
              sender_user_id = CASE WHEN sender_kind = 'owner_number' AND excluded.sender_kind IN ('staff','dana') THEN excluded.sender_user_id ELSE sender_user_id END,
              status = COALESCE(excluded.status, status)`)
        .run(String(key_id), String(lead_id), str(jid), direction, sender_kind, str(sender_user_id), capText(text), str(media_type), toTs(ts), str(status));
      const at = existing ?? { lead_id: String(lead_id), ts: toTs(ts) };
      prep('UPDATE leads SET last_msg_ts = MAX(COALESCE(last_msg_ts, 0), ?) WHERE lead_id = ?').run(at.ts, at.lead_id);
      return { inserted: !existing };
    });
  }

  /** The newest `limit` messages of a chat, returned oldest first (how a thread reads). */
  function messagesFor(leadId, { limit = 200 } = {}) {
    return prep('SELECT * FROM wa_messages WHERE lead_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?')
      .all(String(leadId ?? ''), clampLimit(limit, 200)).map(plain).reverse();
  }

  const newestTs = (leadId) => prep('SELECT MAX(ts) AS ts FROM wa_messages WHERE lead_id = ?').get(String(leadId ?? '')).ts ?? null;
  const hasMessages = (leadId) => Boolean(prep('SELECT 1 FROM wa_messages WHERE lead_id = ? LIMIT 1').get(String(leadId ?? '')));

  /* -------------------- outbox -------------------- */

  const getOutbox = (sendId) => plain(prep('SELECT * FROM wa_outbox WHERE send_id = ?').get(String(sendId ?? '')));
  // A NULL key never matches: a row still waiting for its key is not "the row for" anything.
  const outboxByKey = (keyId) => (keyId
    ? plain(prep('SELECT * FROM wa_outbox WHERE key_id = ? ORDER BY created ASC, rowid ASC LIMIT 1').get(String(keyId)))
    : null);

  /**
   * Written before the HTTP call, so a send that dies half-way still counts against the
   * day cap and can still be matched to the message it became. A `send_id` already there
   * is left exactly as it is: a double submit gets the row the first submit made.
   *
   * @returns {{ inserted: boolean, row: object }}
   */
  function insertOutbox({ send_id, lead_id = null, jid, text = null, user_id = null, sender_kind, status = 'pending' } = {}) {
    if (!send_id) throw new RangeError('send_id is required');
    if (!jid) throw new RangeError('jid is required');
    if (!OUTBOX_KINDS.includes(sender_kind)) throw new RangeError(`unknown outbox kind ${sender_kind}`);
    if (!OUTBOX_STATUSES.includes(status)) throw new RangeError(`unknown outbox status ${status}`);
    const t = now();
    const stored = sender_kind === 'code' ? null : capText(text);
    const { changes } = prep(`INSERT OR IGNORE INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error)
                              VALUES (?,?,?,?,?,?,?,NULL,?,?,NULL)`)
      .run(String(send_id), str(lead_id), String(jid), stored, str(user_id), sender_kind, status, t, t);
    return { inserted: changes === 1, row: getOutbox(send_id) };
  }

  /** `key_id`/`error` left out (undefined) are kept as they are; null clears them. */
  function updateOutbox(sendId, { status, key_id = undefined, error = undefined } = {}) {
    if (!OUTBOX_STATUSES.includes(status)) throw new RangeError(`unknown outbox status ${status}`);
    const sets = ['status = ?', 'updated = ?'];
    const vals = [status, now()];
    if (key_id !== undefined) { sets.push('key_id = ?'); vals.push(str(key_id)); }
    if (error !== undefined) { sets.push('error = ?'); vals.push(error === null ? null : String(error).slice(0, MAX_ERROR)); }
    vals.push(String(sendId ?? ''));
    return prep(`UPDATE wa_outbox SET ${sets.join(', ')} WHERE send_id = ?`).run(...vals).changes === 1;
  }

  /**
   * The send an outbound record most likely is, when its key was never recorded (a
   * timeout, a restart mid-send): the oldest unresolved row of the same LEAD with the
   * identical text, created within `windowMs` of the record either way. Lead-level, not
   * jid-level, because the record may carry the chat's lid while the row carries its
   * phone jid (P2-17). Read-only: the caller decides to resolve it.
   */
  function resolveUncertain({ leadId, text, ts, windowMs = 120_000 } = {}) {
    if (!leadId || text === null || text === undefined || text === '' || !hasNumber(ts)) return null;
    return plain(prep(`SELECT * FROM wa_outbox
                       WHERE lead_id = ? AND status IN ('uncertain','pending') AND key_id IS NULL
                         AND text = ? AND ABS(created - ?) <= ?
                       ORDER BY created ASC, rowid ASC LIMIT 1`)
      .get(String(leadId), capText(text), toTs(ts), num(windowMs)));
  }

  /** Staff and Dana sends of one chat that did not (surely) go: the newest 20, oldest first. */
  function openOutboxFor(leadId, { sinceTs = 0 } = {}) {
    return prep(`SELECT * FROM wa_outbox
                 WHERE lead_id = ? AND status IN ('pending','uncertain','failed') AND sender_kind IN ('staff','dana') AND created >= ?
                 ORDER BY created DESC, rowid DESC LIMIT 20`)
      .all(String(leadId ?? ''), num(sinceTs)).map(plain).reverse();
  }

  /**
   * Sends that may have gone since `sinceTs` — the durable day cap (P2-4). A failed send
   * never reached WhatsApp, so it does not count; an uncertain one may have. `excludeJid`
   * leaves the owner's own chat out: messages to himself cost nothing.
   */
  function countSentSince(sinceTs, { excludeJid = null } = {}) {
    const ex = str(excludeJid);
    return prep(`SELECT COUNT(*) AS n FROM wa_outbox
                 WHERE status IN ('pending','accepted','uncertain') AND created >= ? AND (? IS NULL OR jid != ?)`)
      .get(num(sinceTs), ex, ex).n;
  }

  /** A `pending` row this old belongs to a process that died mid-send: it may have gone. */
  const markStalePending = (beforeTs) => prep("UPDATE wa_outbox SET status = 'uncertain', error = 'interrupted', updated = ? WHERE status = 'pending' AND created < ?")
    .run(now(), num(beforeTs)).changes;

  /** Login-code rows only ever feed the day cap, so they go once they are out of its window. */
  const pruneCodeRows = (beforeTs) => prep("DELETE FROM wa_outbox WHERE sender_kind = 'code' AND created < ?").run(num(beforeTs)).changes;

  /* -------------------- read marks -------------------- */

  /**
   * Mark a chat read up to `ts` for one person. Never moves backwards (two tabs, an old
   * page submitted late). Opening a chat with nothing in it has nothing to mark, so an
   * unusable `ts` or id is `false`, never a thrown error on a page load.
   */
  function markRead(userId, leadId, ts) {
    if (!userId || !leadId || !hasNumber(ts)) return false;
    prep(`INSERT INTO inbox_reads (user_id, lead_id, last_read_ts) VALUES (?,?,?)
          ON CONFLICT(user_id, lead_id) DO UPDATE SET last_read_ts = MAX(last_read_ts, excluded.last_read_ts)`)
      .run(String(userId), String(leadId), toTs(ts));
    return true;
  }

  /* -------------------- lists -------------------- */

  /**
   * The inbox list for one person: every chat, unread first, then the most recent. A chat
   * with no stored message yet sorts by when it joined. Unread counts inbound messages
   * after this person's read mark or, with none, after their account was made (P2-8) —
   * a new colleague does not start with every old message unread. `handler_name` is null
   * for a handler who has been deactivated: the chat has nobody on it now.
   */
  function listInbox({ userId = null, userCreated = 0, limit = 200 } = {}) {
    return prep(`SELECT l.*,
                   (SELECT COUNT(*) FROM wa_messages m
                     WHERE m.lead_id = l.lead_id AND m.direction = 'in'
                       AND m.ts > COALESCE((SELECT r.last_read_ts FROM inbox_reads r WHERE r.user_id = ? AND r.lead_id = l.lead_id), ?)) AS unread,
                   lm.text AS last_text, lm.media_type AS last_media, lm.direction AS last_direction, lm.sender_kind AS last_sender_kind,
                   u.name AS handler_name
                 FROM leads l
                 LEFT JOIN wa_messages lm ON lm.rowid = (SELECT m2.rowid FROM wa_messages m2 WHERE m2.lead_id = l.lead_id ORDER BY m2.ts DESC, m2.rowid DESC LIMIT 1)
                 LEFT JOIN users u ON u.user_id = l.handler_user_id AND u.active = 1
                 WHERE ${IN_CHAT}
                 ORDER BY (unread > 0) DESC, COALESCE(l.last_msg_ts, l.inbox_since, l.created) DESC, l.rowid DESC
                 LIMIT ?`)
      .all(str(userId), num(userCreated), clampLimit(limit, 200)).map(leadRow);
  }

  /** The nav badge: the same unread rule as `listInbox`, summed over every chat (not just a page of them). */
  function unreadTotal({ userId = null, userCreated = 0 } = {}) {
    return prep(`SELECT COUNT(*) AS n FROM wa_messages m
                 JOIN leads l ON l.lead_id = m.lead_id
                 LEFT JOIN inbox_reads r ON r.user_id = ? AND r.lead_id = m.lead_id
                 WHERE ${IN_CHAT} AND m.direction = 'in' AND m.ts > COALESCE(r.last_read_ts, ?)`)
      .get(str(userId), num(userCreated)).n;
  }

  /**
   * The owner's Unsure list, newest first, each with the first message's snippet so he
   * can decide without opening WhatsApp. The snippet comes from the `lead_created`
   * touchpoint; a row whose meta is not valid JSON shows none rather than failing the page.
   */
  function listUnsure({ limit = 200 } = {}) {
    return prep(`SELECT l.*,
                   (SELECT CASE WHEN json_valid(t.meta) THEN json_extract(t.meta, '$.snippet') END
                      FROM touchpoints t WHERE t.lead_id = l.lead_id AND t.event_type = 'lead_created'
                      ORDER BY t.ts ASC, t.rowid ASC LIMIT 1) AS snippet
                 FROM leads l
                 WHERE ${UNSURE_CHAT}
                 ORDER BY l.created DESC, l.rowid DESC
                 LIMIT ?`)
      .all(clampLimit(limit, 200)).map(leadRow);
  }

  const countUnsure = () => prep(`SELECT COUNT(*) AS n FROM leads l WHERE ${UNSURE_CHAT}`).get().n;

  /* -------------------- gaps -------------------- */

  /** A message that could not be read, shown in the thread instead of silently missing. */
  function addGap({ key_id, lead_id, jid = null, ts, reason } = {}) {
    if (!key_id) throw new RangeError('key_id is required');
    return prep('INSERT OR IGNORE INTO wa_gaps (key_id, lead_id, jid, ts, reason) VALUES (?,?,?,?,?)')
      .run(String(key_id), str(lead_id), str(jid), hasNumber(ts) ? toTs(ts) : null, reason === null || reason === undefined ? null : String(reason).slice(0, MAX_ERROR)).changes === 1;
  }

  const gapsFor = (leadId) => prep('SELECT * FROM wa_gaps WHERE lead_id = ? ORDER BY ts ASC, rowid ASC').all(String(leadId ?? '')).map(plain);

  /* -------------------- inbox columns on the lead -------------------- */

  /**
   * Joining keeps the time a chat first joined: a chat already `in` keeps its
   * `inbox_since` (one still missing it gets `since`). Leaving — `out` or back to
   * `unsure` — clears it.
   */
  function setInboxState(leadId, state, { since = now() } = {}) {
    if (!INBOX_STATES.includes(state)) throw new RangeError(`unknown inbox state ${state}`);
    const t = now();
    const id = String(leadId ?? '');
    if (state === 'in') {
      const at = hasNumber(since) ? toTs(since) : t;
      return prep("UPDATE leads SET inbox_since = CASE WHEN inbox_state = 'in' THEN COALESCE(inbox_since, ?) ELSE ? END, inbox_state = 'in', updated = ? WHERE lead_id = ?")
        .run(at, at, t, id).changes === 1;
    }
    return prep('UPDATE leads SET inbox_state = ?, inbox_since = NULL, updated = ? WHERE lead_id = ?').run(state, t, id).changes === 1;
  }

  /** `userId` null clears it. Who may be a handler is the caller's check (an active user). */
  const setHandler = (leadId, userId) => prep('UPDATE leads SET handler_user_id = ? WHERE lead_id = ?')
    .run(userId ? String(userId) : null, String(leadId ?? '')).changes === 1;

  const setNeedsHuman = (leadId, flag) => prep('UPDATE leads SET needs_human = ? WHERE lead_id = ?')
    .run(flag ? 1 : 0, String(leadId ?? '')).changes === 1;

  /* -------------------- purge -------------------- */

  /**
   * Delete a chat's transcript: its messages, its staff and Dana sends, its gaps and read
   * marks, in one transaction. The lead row stays (attribution data), and so do login-code
   * rows, which hold no text and only feed the day cap.
   *
   * @returns {{ messages: number, outbox: number, gaps: number, reads: number }}
   */
  function purgeLead(leadId) {
    const id = String(leadId ?? '');
    return transaction(() => {
      const counts = {
        messages: prep('DELETE FROM wa_messages WHERE lead_id = ?').run(id).changes,
        outbox: prep("DELETE FROM wa_outbox WHERE lead_id = ? AND sender_kind IN ('staff','dana')").run(id).changes,
        gaps: prep('DELETE FROM wa_gaps WHERE lead_id = ?').run(id).changes,
        reads: prep('DELETE FROM inbox_reads WHERE lead_id = ?').run(id).changes,
      };
      prep('UPDATE leads SET last_msg_ts = NULL WHERE lead_id = ?').run(id);
      return counts;
    });
  }

  /**
   * *Not a client*: out of the inbox, transcript gone, nobody handling it, nothing
   * pending — all or nothing, so a failure half-way never leaves a purged chat `in`.
   */
  function leaveInbox(leadId) {
    return transaction(() => {
      setInboxState(leadId, 'out');
      const counts = purgeLead(leadId);
      prep('UPDATE leads SET handler_user_id = NULL, needs_human = 0 WHERE lead_id = ?').run(String(leadId ?? ''));
      return counts;
    });
  }

  /**
   * D11: the transcript of every chat whose last message is older than `beforeTs`. Lead
   * rows stay. A chat with nothing left to delete is not counted.
   *
   * @returns {{ leads: number, messages: number }}
   */
  function retentionPurge(beforeTs) {
    return transaction(() => {
      const ids = prep(`SELECT lead_id FROM leads
                        WHERE last_msg_ts < ? AND EXISTS (SELECT 1 FROM wa_messages m WHERE m.lead_id = leads.lead_id)`)
        .all(num(beforeTs)).map((r) => r.lead_id);
      let messages = 0;
      for (const id of ids) messages += purgeLead(id).messages;
      return { leads: ids.length, messages };
    });
  }

  return {
    upsertMessage, messagesFor, newestTs, hasMessages,
    insertOutbox, getOutbox, outboxByKey, updateOutbox, resolveUncertain, openOutboxFor, countSentSince, markStalePending, pruneCodeRows,
    markRead, listInbox, unreadTotal, listUnsure, countUnsure,
    addGap, gapsFor,
    setInboxState, setHandler, setNeedsHuman,
    purgeLead, leaveInbox, retentionPurge,
  };
}
```

- [ ] **Step 4: Run**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/inbox-store.test.mjs`
Expected: PASS (33 tests, 0 fail).

- [ ] **Step 5: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail — exactly 33 more tests than after Task 3. This task only adds files, so no earlier test changes. (Checked against a copy of the tree with the contract's schema v4 applied: 622 baseline + 33 = 655. The only failures there were the two `SCHEMA_VERSION === 3` assertions that Task 1 updates.)

- [ ] **Step 6: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/inbox/store.mjs services/api/test/inbox-store.test.mjs
git commit -m "inbox: one store for messages, outbox, read marks, gaps and inbox state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Ingest — `lib/inbox/ingest.mjs`

One Evolution record of an `in` chat becomes one stored message. The poller (its Phase 2 task), the join backfill (Task 6) and the thread refresh all go through this one function, so sender resolution (P2-17), the handler default (P2-15), `needs_human` (P2-16), media placeholders and noise (P2-14) and lid/phone learning are decided in one place. So are two refusals the contract's list does not name, because no caller should be trusted to make them: a team member's or never-list chat (§3.5, P2-7: the join catch-up of amendment A3 reads migrated chats that nothing else screened) stores nothing, reason `excluded`; and an outbound record whose WhatsApp id is a login code's outbox row stores nothing, reason `code` (§4.2: a login code is never written anywhere but the WhatsApp message). Builds on Task 1 (schema v4 lead columns in `COLUMNS.leads`), Task 2 (`NormalisedRecord` carries `media`, `fileName`, `noise`) and Task 4 (`createInboxStore`).

**Files:**
- Create: `services/api/lib/inbox/ingest.mjs`
- Test: `services/api/test/inbox-ingest.test.mjs`

- [ ] **Step 1: Write the failing tests** — create `services/api/test/inbox-ingest.test.mjs`:

```js
/**
 * One WhatsApp record of an inbox chat becomes one stored message: who sent it, whether it
 * is the dashboard's own send coming back, and what the lead learns from it. Real store,
 * real inbox store, real team accounts; the clock is injected so every time is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam, learnTeamLid } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createIngest, RESOLVE_WINDOW_MS } from '../lib/inbox/ingest.mjs';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const LEAD_ID = 'LEAD-20260928-0000aaaa';
const OTHER_LEAD_ID = 'LEAD-20260928-0000bbbb';
const PHONE = '966500000001';
const PHONE_JID = `${PHONE}@s.whatsapp.net`;
const LID = '111222333444555@lid';
const TEXT = 'Is BONA-W003 still available?';
const REPLY = 'Yes it is. When would you like to view it?';
const TYPED = 'Welcome, here is the brochure';

/** A lead that is in the inbox, reached on a privacy-mode chat whose phone is known. */
const LEAD = {
  lead_id: LEAD_ID, created: NOW - 3_600_000, updated: NOW - 3_600_000, phone_e164: PHONE, wa_jid: PHONE_JID, wa_lid: LID,
  channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', inbox_since: NOW - 3_600_000,
};

/** One normalised record, as lib/evolution.mjs hands them over: inbound, under the lid, phone as alt. */
const rec = (over = {}) => ({
  id: 'IN-1', jid: LID, jidAlt: PHONE_JID, fromMe: false, ts: NOW - 60_000, text: TEXT, pushName: 'Sara',
  contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false, ...over,
});

/** `isExcludedLead` is left out unless a test hands one in: the default reads the team tables. */
function harness({ lead = {}, ownerUserId = null, isExcludedLead = null } = {}) {
  const s = openDb(':memory:');
  const clock = NOW;
  const team = createTeam(s, { now: () => clock });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const staff = team.addUser({ name: 'Sara Staff', phone: '0500000009', role: 'staff' });
  const inbox = createInboxStore(s, { now: () => clock });
  const logs = [];
  const { ingest } = createIngest({
    db: s, inbox, ownerUserId: ownerUserId ?? (() => owner.user_id), log: (o) => logs.push(o), now: () => clock,
    ...(isExcludedLead ? { isExcludedLead } : {}),
  });
  s.insertLead({ ...LEAD, ...lead });
  return { s, team, inbox, ingest, owner, staff, logs, lead: () => s.getLead(LEAD_ID) };
}

const MESSAGE_FIELDS = ['key_id', 'lead_id', 'jid', 'direction', 'sender_kind', 'sender_user_id', 'text', 'media_type', 'ts'];
const pick = (row) => Object.fromEntries(MESSAGE_FIELDS.map((k) => [k, row[k]]));

/** Every phone number, lid, name and message text these tests use. None may reach a log line. */
const PERSONAL = [PHONE, '111222333444555', '966593296933', '966500000009', 'Sara', 'Abdulaziz', TEXT, REPLY, TYPED];
function assertClean(logs) {
  const out = JSON.stringify(logs);
  for (const needle of PERSONAL) assert.equal(out.includes(needle), false, 'a log line carries personal data');
}

test('refuses a chat outside the inbox, a record with no id and noise — and stores nothing', () => {
  const h = harness();
  assert.throws(() => createIngest({ db: h.s }), TypeError);
  for (const state of [null, 'unsure', 'out']) {
    h.s.updateLead(LEAD_ID, { inbox_state: state });
    assert.deepEqual(h.ingest(h.lead(), rec()), { stored: false, reason: 'not_in_inbox' }, String(state));
  }
  // The row is read again: a chat marked "Not a client" a moment ago is not written back by
  // a caller still holding its old `in` row.
  assert.deepEqual(h.ingest({ ...LEAD }, rec()), { stored: false, reason: 'not_in_inbox' });
  assert.deepEqual(h.ingest(null, rec()), { stored: false, reason: 'not_in_inbox' });
  h.s.updateLead(LEAD_ID, { inbox_state: 'in' });
  assert.deepEqual(h.ingest(h.lead(), rec({ id: null })), { stored: false, reason: 'no_id' });
  assert.deepEqual(h.ingest(h.lead(), null), { stored: false, reason: 'no_id' });
  assert.deepEqual(h.ingest(h.lead(), rec({ noise: true, text: '' })), { stored: false, reason: 'noise' });
  assert.equal(h.inbox.hasMessages(LEAD_ID), false);
  h.s.close();
});

test("a team member's or a never-list chat stores nothing, whichever caller hands the record over", () => {
  // The staff member's own chat, `in` from before she joined the team (a migrated Ref lead).
  const member = harness({ lead: { phone_e164: '966500000009', wa_jid: '966500000009@s.whatsapp.net', wa_lid: null } });
  assert.deepEqual(member.ingest(member.lead(), rec({ jid: '966500000009@s.whatsapp.net', jidAlt: null })), { stored: false, reason: 'excluded' });
  assert.equal(member.inbox.hasMessages(LEAD_ID), false);
  assert.equal(member.lead().last_msg_ts, null);
  member.s.close();

  // No phone on the row, but its phone jid's number is on the never list.
  const never = harness({ lead: { phone_e164: null } });
  never.team.addNever({ phone: PHONE, note: 'family' });
  assert.deepEqual(never.ingest(never.lead(), rec()), { stored: false, reason: 'excluded' });
  assert.equal(never.lead().phone_e164, null, 'nothing is learned from it either');
  never.s.close();

  // Known only by a lid the poller learned for a team member.
  const lid = harness({ lead: { phone_e164: null, wa_jid: null } });
  learnTeamLid(lid.s, '0500000009', LID);
  assert.deepEqual(lid.ingest(lid.lead(), rec({ id: 'OWN-L', fromMe: true, text: TYPED })), { stored: false, reason: 'excluded' });
  assert.equal(lid.lead().handler_user_id, null);
  lid.s.close();

  // The check can be handed in instead of read from the team tables.
  const handed = harness({ isExcludedLead: (l) => l.lead_id === LEAD_ID });
  assert.deepEqual(handed.ingest(handed.lead(), rec()), { stored: false, reason: 'excluded' });
  handed.s.close();
});

test('a login code coming back in a chat is never stored, and its outbox row is left as it was', () => {
  // Belt and braces: a code only ever goes to a team member, whose chat the exclusion above
  // already refuses. The code must still never reach wa_messages (design §4.2).
  const h = harness();
  const code = 'Bona dashboard code: 482913 (valid 10 min)';
  h.inbox.insertOutbox({ send_id: 'SND-code-1', jid: PHONE_JID, sender_kind: 'code' });
  h.inbox.updateOutbox('SND-code-1', { status: 'accepted', key_id: 'CODE-1' });
  const before = h.inbox.getOutbox('SND-code-1');
  assert.deepEqual(
    h.ingest(h.lead(), rec({ id: 'CODE-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: code })),
    { stored: false, reason: 'code' },
  );
  assert.equal(h.inbox.hasMessages(LEAD_ID), false);
  assert.deepEqual(h.inbox.getOutbox('SND-code-1'), before, 'the row is not touched');
  assert.equal(h.lead().handler_user_id, null, 'a login code makes nobody the handler');
  assert.equal(h.lead().last_msg_ts, null);
  assert.equal(JSON.stringify(h.logs).includes('482913'), false);
  h.s.close();
});

test("an inbound record is stored as the client's message and moves the chat's last-message time", () => {
  const h = harness();
  assert.deepEqual(h.ingest(h.lead(), rec()), { stored: true, inserted: true, senderKind: 'client' });
  const rows = h.inbox.messagesFor(LEAD_ID);
  assert.equal(rows.length, 1);
  assert.deepEqual(pick(rows[0]), {
    key_id: 'IN-1', lead_id: LEAD_ID, jid: LID, direction: 'in', sender_kind: 'client', sender_user_id: null,
    text: TEXT, media_type: null, ts: NOW - 60_000,
  });
  assert.equal(h.lead().last_msg_ts, NOW - 60_000);
  assert.equal(h.lead().handler_user_id, null, 'a client message makes nobody the handler');
  h.s.close();
});

test('media arrive as placeholders: a caption stays as text, an unknown bare message is "[message]"', () => {
  const h = harness();
  h.ingest(h.lead(), rec({ id: 'M-1', media: '[image]', text: 'Front view', messageType: 'imageMessage' }));
  h.ingest(h.lead(), rec({ id: 'M-2', media: '[voice note]', text: '', messageType: 'audioMessage', ts: NOW - 50_000 }));
  h.ingest(h.lead(), rec({ id: 'M-3', media: null, text: '', messageType: 'pollCreationMessageV3', ts: null }));
  const byId = Object.fromEntries(h.inbox.messagesFor(LEAD_ID).map((m) => [m.key_id, m]));
  assert.deepEqual([byId['M-1'].media_type, byId['M-1'].text], ['[image]', 'Front view']);
  assert.deepEqual([byId['M-2'].media_type, byId['M-2'].text], ['[voice note]', null]);
  assert.deepEqual([byId['M-3'].media_type, byId['M-3'].text], ['[message]', null]);
  assert.equal(byId['M-3'].ts, NOW, 'a record with no usable time is stamped with now');
  h.s.close();
});

test('an outbound record the dashboard sent is found by its message id: staff, that user, row accepted', () => {
  const h = harness();
  h.inbox.insertOutbox({ send_id: 'SND-key-1', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff' });
  h.inbox.updateOutbox('SND-key-1', { status: 'accepted', key_id: 'OUT-1' });
  const out = h.ingest(h.lead(), rec({ id: 'OUT-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: REPLY, ts: NOW + 1_000 }));
  assert.deepEqual(out, { stored: true, inserted: true, senderKind: 'staff' });
  const [m] = h.inbox.messagesFor(LEAD_ID);
  assert.deepEqual([m.direction, m.sender_kind, m.sender_user_id], ['out', 'staff', h.staff.user_id]);
  const row = h.inbox.getOutbox('SND-key-1');
  assert.deepEqual([row.status, row.key_id], ['accepted', 'OUT-1']);
  // The poller read the record before the reply had stored it: whoever replied first is still the handler.
  assert.equal(h.lead().handler_user_id, h.staff.user_id);
  assert.equal(h.logs.some((e) => e.evt === 'inbox.outbox.resolved'), false, 'an accepted row has nothing to resolve');
  h.s.close();
});

test('a Dana send found by its id is Dana\'s, and leaves "needs a human" and the handler alone', () => {
  const h = harness({ lead: { needs_human: 1 } });
  h.inbox.insertOutbox({ send_id: 'SND-dana-1', lead_id: LEAD_ID, jid: PHONE_JID, text: 'Hello, I am Dana', sender_kind: 'dana' });
  h.inbox.updateOutbox('SND-dana-1', { status: 'accepted', key_id: 'DANA-1' });
  const out = h.ingest(h.lead(), rec({ id: 'DANA-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: 'Hello, I am Dana' }));
  assert.equal(out.senderKind, 'dana');
  assert.equal(h.inbox.messagesFor(LEAD_ID)[0].sender_user_id, null);
  assert.equal(h.lead().needs_human, 1, 'Dana is not a human reply');
  assert.equal(h.lead().handler_user_id, null);
  h.s.close();
});

for (const status of ['uncertain', 'pending']) {
  test(`a reply left ${status} is resolved by its text within two minutes, at the lead, though it comes back under the lid`, () => {
    const h = harness({ lead: { needs_human: 1 } });
    // The reply went to the phone jid (the outbox row says so); the record comes back under the lid.
    h.inbox.insertOutbox({ send_id: 'SND-unsure-1', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff', status });
    const out = h.ingest(h.lead(), rec({ id: 'OUT-2', fromMe: true, jid: LID, jidAlt: PHONE_JID, text: REPLY, ts: NOW + RESOLVE_WINDOW_MS }));
    assert.deepEqual(out, { stored: true, inserted: true, senderKind: 'staff' });
    const row = h.inbox.getOutbox('SND-unsure-1');
    assert.deepEqual([row.status, row.key_id], ['accepted', 'OUT-2']);
    assert.equal(h.inbox.messagesFor(LEAD_ID)[0].sender_user_id, h.staff.user_id);
    assert.equal(h.lead().needs_human, 0, 'a staff reply is a human reply');
    assert.equal(h.lead().handler_user_id, h.staff.user_id);
    assert.ok(h.logs.some((e) => e.evt === 'inbox.outbox.resolved' && e.sendId === 'SND-unsure-1' && e.via === 'text'));
    assertClean(h.logs);
    h.s.close();
  });
}

test("two minutes and one millisecond, other words, or another chat: the owner's own number, and the row stays unsure", () => {
  const cases = [
    ['too late', { ts: NOW + RESOLVE_WINDOW_MS + 1, text: REPLY }, LEAD_ID],
    ['other words', { ts: NOW + 1_000, text: `${REPLY}!` }, LEAD_ID],
    ['another chat', { ts: NOW + 1_000, text: REPLY }, OTHER_LEAD_ID],
  ];
  for (const [label, over, outboxLead] of cases) {
    const h = harness();
    h.inbox.insertOutbox({ send_id: 'SND-unsure-2', lead_id: outboxLead, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff', status: 'uncertain' });
    const out = h.ingest(h.lead(), rec({ id: 'OUT-3', fromMe: true, jid: LID, jidAlt: PHONE_JID, ...over }));
    assert.equal(out.senderKind, 'owner_number', label);
    const row = h.inbox.getOutbox('SND-unsure-2');
    assert.deepEqual([row.status, row.key_id], ['uncertain', null], label);
    assert.equal(h.inbox.messagesFor(LEAD_ID)[0].sender_user_id, null, label);
    h.s.close();
  }
});

test('an owner_number record makes the owner the handler only when nobody handles the chat', () => {
  const typed = rec({ id: 'OWN-1', fromMe: true, text: TYPED });

  const free = harness();
  assert.equal(free.ingest(free.lead(), typed).senderKind, 'owner_number');
  assert.equal(free.lead().handler_user_id, free.owner.user_id);
  free.s.close();

  const taken = harness();
  taken.inbox.setHandler(LEAD_ID, taken.staff.user_id);
  taken.ingest(taken.lead(), typed);
  assert.equal(taken.lead().handler_user_id, taken.staff.user_id, 'an existing handler is kept');
  taken.s.close();

  const noOwner = harness({ ownerUserId: () => null });
  noOwner.ingest(noOwner.lead(), typed);
  assert.equal(noOwner.lead().handler_user_id, null, 'no owner account, no handler');
  noOwner.s.close();
});

test('a human outbound clears "needs a human"; a client message does not', () => {
  const h = harness({ lead: { needs_human: 1 } });
  h.ingest(h.lead(), rec({ id: 'IN-9' }));
  assert.equal(h.lead().needs_human, 1);
  h.ingest(h.lead(), rec({ id: 'OWN-9', fromMe: true, text: TYPED, ts: NOW - 30_000 }));
  assert.equal(h.lead().needs_human, 0);
  h.s.close();
});

test('a lead learns its lid, phone jid and phone from a record it received, only into empty fields', () => {
  // Phone known, jids not yet: both come from the lid chat and its alt.
  const a = harness({ lead: { wa_jid: null, wa_lid: null } });
  a.ingest(a.lead(), rec());
  assert.deepEqual([a.lead().wa_lid, a.lead().wa_jid, a.lead().phone_e164], [LID, PHONE_JID, PHONE]);
  assert.ok(a.logs.some((e) => e.evt === 'inbox.learned' && e.fields.includes('wa_lid') && e.fields.includes('wa_jid')));
  assertClean(a.logs);
  a.s.close();

  // Never overwrites.
  const b = harness({ lead: { wa_lid: '999888777666555@lid' } });
  b.ingest(b.lead(), rec());
  assert.equal(b.lead().wa_lid, '999888777666555@lid');
  b.s.close();

  // A lid-only chat learns its phone.
  const c = harness({ lead: { phone_e164: null, wa_jid: null } });
  c.ingest(c.lead(), rec());
  assert.deepEqual([c.lead().phone_e164, c.lead().wa_jid], [PHONE, PHONE_JID]);
  c.s.close();

  // Not from a record we sent: its alt may be our own number.
  const d = harness({ lead: { wa_jid: null, wa_lid: null } });
  d.ingest(d.lead(), rec({ id: 'OWN-2', fromMe: true }));
  assert.deepEqual([d.lead().wa_lid, d.lead().wa_jid], [null, null]);
  d.s.close();

  // Never a phone or jid another lead already holds (phone_e164 is unique).
  const e = harness({ lead: { phone_e164: null, wa_jid: null } });
  e.s.insertLead({ ...LEAD, lead_id: OTHER_LEAD_ID, wa_lid: null });
  assert.equal(e.ingest(e.lead(), rec()).stored, true, 'the message is still stored');
  assert.deepEqual([e.lead().phone_e164, e.lead().wa_jid], [null, null]);
  e.s.close();
});

test('re-ingesting a record changes nothing: one row, and a reassignment to nobody is not undone', () => {
  const h = harness();
  const typed = rec({ id: 'OWN-3', fromMe: true, text: TYPED });
  assert.deepEqual(h.ingest(h.lead(), typed), { stored: true, inserted: true, senderKind: 'owner_number' });
  assert.equal(h.lead().handler_user_id, h.owner.user_id);
  h.inbox.setHandler(LEAD_ID, null); // someone reassigned the chat to nobody
  assert.deepEqual(h.ingest(h.lead(), typed), { stored: true, inserted: false, senderKind: 'owner_number' });
  assert.equal(h.lead().handler_user_id, null);
  h.ingest(h.lead(), rec());
  h.ingest(h.lead(), rec());
  assert.equal(h.inbox.messagesFor(LEAD_ID).length, 2);
  h.s.close();
});

test("a reply first stored as the owner's number becomes staff once its outbox row carries the message id", () => {
  const h = harness();
  h.inbox.insertOutbox({ send_id: 'SND-slow-1', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff' });
  const record = rec({ id: 'OUT-4', fromMe: true, jid: PHONE_JID, jidAlt: null, text: REPLY, ts: NOW + 3 * 60_000 });
  assert.equal(h.ingest(h.lead(), record).senderKind, 'owner_number', 'too far from the send to be matched by its text');
  h.inbox.updateOutbox('SND-slow-1', { status: 'accepted', key_id: 'OUT-4' }); // the slow send finally answered
  assert.deepEqual(h.ingest(h.lead(), record), { stored: true, inserted: false, senderKind: 'staff' });
  const [m] = h.inbox.messagesFor(LEAD_ID);
  assert.deepEqual([m.sender_kind, m.sender_user_id], ['staff', h.staff.user_id]);
  h.s.close();
});

test('logs carry ids and field names only — never text, a phone number, a lid or a name', () => {
  const h = harness({ lead: { wa_jid: null, wa_lid: null } });
  h.inbox.insertOutbox({ send_id: 'SND-log-1', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff', status: 'uncertain' });
  h.ingest(h.lead(), rec({ pushName: 'Sara' }));
  h.ingest(h.lead(), rec({ id: 'OUT-5', fromMe: true, text: REPLY, ts: NOW }));
  h.ingest(h.lead(), rec({ id: 'OWN-5', fromMe: true, text: TYPED, ts: NOW + 1_000 }));
  assert.ok(h.logs.length >= 2, 'the learning and the resolution were both logged');
  assertClean(h.logs);
  h.s.close();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/inbox-ingest.test.mjs`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/services/api/lib/inbox/ingest.mjs'` (the store from Task 4 exists; the ingest module does not yet).

- [ ] **Step 3: Implement** — create `services/api/lib/inbox/ingest.mjs`:

```js
/**
 * One WhatsApp record of a Bona inbox chat → one stored message (2026-09-27 design §4.2–§4.3).
 *
 * The poller, the join backfill and the thread refresh all hand records over here, so what
 * a stored message says about itself is decided in one place:
 *
 *   - only a chat that is `in` the inbox is stored (P2-1). The lead is read again first: a
 *     chat the owner marked *Not a client* a moment ago has just had its transcript purged,
 *     and a caller still holding the old row must not write it back.
 *   - a team member's or a never-list number is never a client's chat (§3.5, P2-7), however
 *     the row came to be `in` — a Ref lead from before its number joined the team, say. The
 *     check is made here, not left to each caller: the poller screens its records, but a
 *     per-chat read (join history, catch-up, refresh) goes straight to a lead.
 *   - a record with no id cannot be de-duplicated, and noise — reactions, deletes and edits,
 *     poll votes, key-distribution records — is never a bubble (P2-14). Neither is stored.
 *   - a login code the sender sent is never stored (§4.2: the code lives only in the WhatsApp
 *     message). Its outbox row keeps the message id for the day's count, so the record is
 *     recognised by that id and refused before anything is written.
 *   - who sent an outbound record (P2-17). The dashboard's own sends are found by the
 *     WhatsApp message id their send came back with. A send that never came back
 *     (`uncertain`, or `pending` when a restart cut it off) is found by its exact text within
 *     two minutes, anywhere in the LEAD's chat — the reply went to the phone jid, but
 *     Evolution may file the record under the chat's `@lid`. Anything else was typed on the
 *     owner's phone or sent by Lisa for him, which cannot be told apart: `owner_number`.
 *   - a human outbound seen for the first time clears "needs a human" (P2-16) and gives a
 *     chat nobody handles a handler (P2-15): the staff member who replied, or the owner for
 *     his own number. Only the first time — a refresh reads old records again, and must not
 *     undo a later "needs a human" or somebody's reassignment of the chat to nobody.
 *   - a lead learns its lid, phone jid and phone from a record it RECEIVED, into empty
 *     fields only.
 *
 * Nothing here logs text, a phone number, a lid or a name — ids and field names only.
 */
import { createTeam, isTeamLid } from '../team.mjs';
import { jidsOf } from '../wa-poller.mjs';

/** How far apart an unconfirmed send and the record that confirms it may be (P2-17). */
export const RESOLVE_WINDOW_MS = 120_000;

/** Outbound senders that are a person answering — as opposed to Dana. */
const HUMAN_SENDERS = new Set(['staff', 'owner_number']);

/**
 * A team member's or a never-list number, however the lead row holds it: its phone, the
 * number in its phone jid, or a lid the poller learned for a team member. `createTeam` only
 * prepares statements when they are first used, so this second instance costs nothing.
 */
function excludedByTeam(db) {
  const team = createTeam(db);
  return (lead) => team.isExcludedPhone(lead.phone_e164)
    || team.isExcludedPhone(jidsOf({ jid: lead.wa_jid }).phone)
    || isTeamLid(db, lead.wa_lid);
}

/**
 * @param {object} o
 * @param {ReturnType<import('../db.mjs').openDb>} o.db
 * @param {ReturnType<import('./store.mjs').createInboxStore>} o.inbox
 * @param {() => string|null} [o.ownerUserId] the env owner's `users.user_id`: the handler of a
 *        chat his own phone answers first
 * @param {((lead: object) => boolean)|null} [o.isExcludedLead] true for a chat that is never a
 *        client's; defaults to the team and never-list tables in `db`
 * @param {(e: object) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createIngest({
  db, inbox, ownerUserId = () => null, isExcludedLead = null, log = () => {}, now = () => Date.now(),
} = {}) {
  if (!db || !inbox) throw new TypeError('createIngest needs the store and the inbox store');
  const isExcluded = isExcludedLead ?? excludedByTeam(db);

  /** The outbox row an outbound record is, when the dashboard sent it; `via` says how it was found. */
  function outboxRowFor(leadId, rec, body, ts) {
    const byKey = inbox.outboxByKey(rec.id);
    if (byKey) return { row: byKey, via: 'key' };
    if (!body) return null;
    const byText = inbox.resolveUncertain({ leadId, text: body, ts, windowMs: RESOLVE_WINDOW_MS });
    return byText ? { row: byText, via: 'text' } : null;
  }

  /**
   * Fill the lead's empty lid / phone jid / phone from a record it received. Not from one we
   * sent: lib/evolution.mjs folds `key.senderPn` into the same `jidAlt`, and on an outbound
   * record that can be our own number — the same caution as the poller's team pairing. Never
   * a value another lead already holds: `phone_e164` is unique, and two leads on one jid would
   * make every later lookup by that jid a coin toss.
   */
  function learn(lead, rec) {
    const { phone, waJid, waLid } = jidsOf(rec);
    const free = (holder) => !holder || holder.lead_id === lead.lead_id;
    const patch = {};
    if (waLid && !lead.wa_lid && free(db.getLeadByJid(waLid))) patch.wa_lid = waLid;
    if (waJid && !lead.wa_jid && free(db.getLeadByJid(waJid))) patch.wa_jid = waJid;
    if (phone && !lead.phone_e164 && free(db.getLeadByPhone(phone))) patch.phone_e164 = phone;
    const fields = Object.keys(patch);
    if (!fields.length) return;
    db.updateLead(lead.lead_id, { ...patch, updated: now() });
    log({ evt: 'inbox.learned', leadId: lead.lead_id, fields });
  }

  /**
   * @param {object|null} lead  a `leads` row; only its `lead_id` is trusted, the row is read again
   * @param {import('../evolution.mjs').NormalisedRecord} rec
   * @returns {{ stored: false, reason: 'not_in_inbox'|'excluded'|'no_id'|'noise'|'code' }
   *          | { stored: true, inserted: boolean, senderKind: 'client'|'staff'|'dana'|'owner_number' }}
   */
  function ingest(lead, rec) {
    const leadId = lead?.lead_id ?? null;
    return db.transaction(() => {
      const current = leadId ? db.getLead(leadId) : null;
      if (current?.inbox_state !== 'in') return { stored: false, reason: 'not_in_inbox' };
      if (isExcluded(current)) return { stored: false, reason: 'excluded' };
      if (!rec?.id) return { stored: false, reason: 'no_id' };
      if (rec.noise) return { stored: false, reason: 'noise' };

      const direction = rec.fromMe ? 'out' : 'in';
      const ts = Number.isFinite(rec.ts) ? rec.ts : now();
      const body = typeof rec.text === 'string' ? rec.text : '';
      const text = body || null;
      // A photo keeps its caption as text; a record with neither text nor a known media
      // type still shows up as a bubble, so the team knows something arrived.
      const mediaType = rec.media ?? (text ? null : '[message]');

      let senderKind = 'client';
      let senderUserId = null;
      let match = null;
      if (direction === 'out') {
        match = outboxRowFor(current.lead_id, rec, body, ts);
        // Refused before anything is written, the row's status included.
        if (match?.row.sender_kind === 'code') return { stored: false, reason: 'code' };
        const kind = match?.row.sender_kind;
        senderKind = kind === 'staff' || kind === 'dana' ? kind : 'owner_number';
        senderUserId = senderKind === 'owner_number' ? null : (match.row.user_id ?? null);
      } else {
        learn(current, rec);
      }

      const { inserted } = inbox.upsertMessage({
        key_id: rec.id, lead_id: current.lead_id, jid: rec.jid ?? null, direction,
        sender_kind: senderKind, sender_user_id: senderUserId, text, media_type: mediaType, ts,
      });

      if (match && match.row.status !== 'accepted') {
        inbox.updateOutbox(match.row.send_id, { status: 'accepted', key_id: rec.id });
        log({ evt: 'inbox.outbox.resolved', leadId: current.lead_id, sendId: match.row.send_id, via: match.via });
      }

      if (inserted && HUMAN_SENDERS.has(senderKind)) {
        if (current.needs_human) inbox.setNeedsHuman(current.lead_id, 0);
        if (!current.handler_user_id) {
          const handler = senderKind === 'staff' ? senderUserId : ownerUserId();
          if (handler) inbox.setHandler(current.lead_id, handler);
        }
      }
      return { stored: true, inserted, senderKind };
    });
  }

  return { ingest };
}
```

- [ ] **Step 4: Run**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/inbox-ingest.test.mjs`
Expected: PASS (16 tests, 0 fail).

- [ ] **Step 5: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail (the Task 4 total plus these 16). No existing test changes: nothing imports `lib/inbox/ingest.mjs` yet, and `jidsOf` in `lib/wa-poller.mjs` and `createTeam`/`isTeamLid` in `lib/team.mjs` are only imported, not changed.

- [ ] **Step 6: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/inbox/ingest.mjs services/api/test/inbox-ingest.test.mjs
git commit -m "inbox: ingest one Evolution record of an inbox chat

Sender from the outbox (by key id, else an uncertain/pending send by its
text within 2 min at lead level), owner_number otherwise; first human
outbound clears needs_human and sets a missing handler; lid/phone learned
only from received records into empty fields; noise and id-less records
refused. Ingest makes its own exclusion check (team numbers, never list,
learned team lids) whatever the caller, and never stores a login code
recognised by its outbox key id; nothing logged but ids and field names.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Backfill — `lib/inbox/backfill.mjs`

Per-chat Evolution reads (P2-2): the join history (24 h automatic, 30 days owner-vouched) and the thread refresh (amendments A1 and A2: the newest 50 per question from the chat's history floor — 24 h before it joined, never past the five-year retention horizon — to now; about 3 s at most, each request capped at 2.5 s or what is left, the rest skipped and the result `partial` once the budget is spent; the same chat not read again within 5 s). One chat is three questions — `remoteJidAlt` = phone jid, `remoteJid` = phone jid, `remoteJid` = lid — de-duplicated by `key.id`, groups and broadcasts skipped; the lid question is derived from a fresh read of the lead after the first two, because ingest (Task 5) can learn the lid from them. Uses Task 2's `findMessagesPage` by default; never throws.

**Files:**
- Create: `services/api/lib/inbox/backfill.mjs`
- Test: `services/api/test/inbox-backfill.test.mjs`

- [ ] **Step 1: Write the failing tests** — create `services/api/test/inbox-backfill.test.mjs`:

```js
/**
 * Per-chat reads for the Bona inbox. Evolution is never contacted: every test injects
 * `find` and records each question it is asked (`where`, `page`, `offset`, and a refresh's
 * `timeoutMs`), except the last, which stubs `fetchImpl` to prove the default wiring builds
 * the request the live instance answered on 2026-09-28. Records go through the real ingest
 * into a real store. The clock is injected; a slow Evolution is a `find` that moves it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { EvolutionError, PAGE_SIZE } from '../lib/evolution.mjs';
import { createInboxStore, RETENTION_MS } from '../lib/inbox/store.mjs';
import { createIngest } from '../lib/inbox/ingest.mjs';
import {
  BACKFILL_MAX_PAGES, JOIN_HISTORY_MS, OWNER_HISTORY_MS, REFRESH_LIMIT, createBackfill, phoneJidOf,
} from '../lib/inbox/backfill.mjs';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const LEAD_ID = 'LEAD-20260928-0000aaaa';
const PHONE = '966500000001';
const PHONE_JID = `${PHONE}@s.whatsapp.net`;
const LID = '111222333444555@lid';
/** `messageTimestamp` for a 24 h join ending now. */
const DAY = { gte: '2026-09-27T12:00:00.000Z', lte: '2026-09-28T12:00:00.000Z' };

const LEAD = {
  lead_id: LEAD_ID, created: NOW - 3_600_000, updated: NOW - 3_600_000, phone_e164: PHONE, wa_jid: PHONE_JID, wa_lid: LID,
  channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', inbox_since: NOW - 3_600_000,
};
/** LEAD's history floor (amendment A1): 24 h before it joined the inbox. */
const FLOOR = LEAD.inbox_since - JOIN_HISTORY_MS;
/** `messageTimestamp` for a refresh of LEAD at NOW: from its floor to now. */
const SINCE_JOIN = { gte: '2026-09-27T11:00:00.000Z', lte: '2026-09-28T12:00:00.000Z' };

/** One normalised record, as lib/evolution.mjs hands them over: inbound, under the lid, phone as alt. */
const rec = (over = {}) => ({
  id: 'K1', jid: LID, jidAlt: PHONE_JID, fromMe: false, ts: NOW - 600_000, text: 'Hi', pushName: 'Sara',
  contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false, ...over,
});

/** Answers each question from a table: `alt:<jid>` / `jid:<jid>` → pages of records, newest first. */
function router(table) {
  return ({ where, page }) => {
    const k = where.key.remoteJidAlt ? `alt:${where.key.remoteJidAlt}` : `jid:${where.key.remoteJid}`;
    const pages = table[k] ?? [];
    return { records: pages[page - 1] ?? [], total: pages.flat().length, pages: pages.length };
  };
}

/**
 * Evolution's per-chat read over one pool of records, answered the way the live instance
 * answered it on 2026-09-28: the key clause, the `messageTimestamp` window (both bounds),
 * newest first, `offset` records a page, with the sizes stated.
 */
function pool(records) {
  return ({ where, page, offset }) => {
    const { key, messageTimestamp: span } = where;
    const hits = records
      .filter((r) => (key.remoteJidAlt ? r.jidAlt === key.remoteJidAlt : r.jid === key.remoteJid))
      .filter((r) => !span || (r.ts >= Date.parse(span.gte) && r.ts <= Date.parse(span.lte)))
      .sort((a, b) => b.ts - a.ts);
    return { records: hits.slice((page - 1) * offset, page * offset), total: hits.length, pages: Math.ceil(hits.length / offset) };
  };
}

/** `serve(q, { tick })` answers each question; `tick(ms)` moves the one clock every part reads. */
function harness({ serve = router({}), lead = {}, env = {}, injectFind = true, fetchImpl = undefined, ingest = undefined } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const tick = (ms) => { clock += ms; };
  const team = createTeam(s, { now: () => clock });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const inbox = createInboxStore(s, { now: () => clock });
  const logs = [];
  const log = (o) => logs.push(o);
  const real = createIngest({ db: s, inbox, ownerUserId: () => owner.user_id, log, now: () => clock });
  const ingested = [];
  const calls = [];
  const backfill = createBackfill({
    env, db: s, log, now: () => clock,
    ingest: ingest ?? ((l, r) => { ingested.push(r.id); return real.ingest(l, r); }),
    ...(injectFind ? { find: async (q) => { calls.push(q); return serve(q, { tick }); } } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  s.insertLead({ ...LEAD, ...lead });
  return { s, inbox, backfill, calls, ingested, logs, tick, now: () => clock, lead: () => s.getLead(LEAD_ID) };
}

/** Every phone number, lid and name these tests use. None may reach a log line. */
const PERSONAL = [PHONE, '111222333444555', '966593296933', 'Sara', 'Abdulaziz'];
function assertClean(logs) {
  const out = JSON.stringify(logs);
  for (const needle of PERSONAL) assert.equal(out.includes(needle), false, 'a log line carries personal data');
}

test("phoneJidOf: the lead's phone jid without its device, else one built from a real international phone", () => {
  assert.equal(phoneJidOf({ wa_jid: '966500000001:12@s.whatsapp.net', phone_e164: '966599999999' }), PHONE_JID);
  assert.equal(phoneJidOf({ wa_jid: null, phone_e164: PHONE }), PHONE_JID);
  assert.equal(phoneJidOf({ wa_jid: LID, phone_e164: PHONE }), PHONE_JID, 'a lid in the jid column is not a phone');
  assert.equal(phoneJidOf({ wa_jid: '0500000001@s.whatsapp.net', phone_e164: null }), null, 'local trunk format');
  for (const phone of ['0500000001', '1234567', '1234567890123456', 'abc', '', null]) {
    assert.equal(phoneJidOf({ wa_jid: null, phone_e164: phone }), null, String(phone));
  }
  assert.equal(phoneJidOf({ wa_jid: null, wa_lid: LID, phone_e164: null }), null, 'lid-only: no phone to build');
  assert.equal(phoneJidOf(null), null);
  const h = harness();
  assert.equal(h.backfill.phoneJidOf(h.lead()), PHONE_JID);
  assert.equal(h.backfill.configured, true);
  h.s.close();
});

test('history asks the three questions in the join window, de-duplicates by id and stores each record once', async () => {
  const h = harness({
    serve: router({
      [`alt:${PHONE_JID}`]: [[rec({ id: 'K2', ts: NOW - 300_000 }), rec({ id: 'K1', ts: NOW - 600_000 })]],
      // Sent through the API to the phone number: filed under the phone jid itself.
      [`jid:${PHONE_JID}`]: [[rec({ id: 'K3', jid: PHONE_JID, jidAlt: null, fromMe: true, text: 'Welcome', ts: NOW - 420_000 })]],
      [`jid:${LID}`]: [[rec({ id: 'K4', jidAlt: null, ts: NOW - 120_000 }), rec({ id: 'K2', ts: NOW - 300_000 })]],
    }),
  });
  const out = await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.deepEqual(out, { stored: 4, scanned: 5, truncated: false });
  assert.deepEqual(h.calls, [
    { where: { key: { remoteJidAlt: PHONE_JID }, messageTimestamp: DAY }, page: 1, offset: PAGE_SIZE },
    { where: { key: { remoteJid: PHONE_JID }, messageTimestamp: DAY }, page: 1, offset: PAGE_SIZE },
    { where: { key: { remoteJid: LID }, messageTimestamp: DAY }, page: 1, offset: PAGE_SIZE },
  ]);
  assert.deepEqual(h.ingested, ['K1', 'K2', 'K3', 'K4'], 'each id once, oldest first within each question');
  const stored = h.inbox.messagesFor(LEAD_ID);
  assert.deepEqual(stored.map((m) => m.key_id), ['K1', 'K3', 'K2', 'K4']);
  assert.equal(stored.find((m) => m.key_id === 'K3').sender_kind, 'owner_number');
  // Asking again stores nothing new.
  assert.deepEqual(await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { stored: 0, scanned: 5, truncated: false });
  h.s.close();
});

test('a lid learned from the remoteJidAlt question is then asked for; with no lid there are only two questions', async () => {
  const learns = harness({
    lead: { wa_lid: null },
    serve: router({
      [`alt:${PHONE_JID}`]: [[rec({ id: 'K1' })]],
      [`jid:${LID}`]: [[rec({ id: 'K9', jidAlt: null, ts: NOW - 60_000 })]],
    }),
  });
  const out = await learns.backfill.history(learns.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.equal(learns.lead().wa_lid, LID);
  assert.equal(learns.calls.length, 3);
  assert.deepEqual(learns.calls[2].where.key, { remoteJid: LID });
  assert.deepEqual(learns.ingested, ['K1', 'K9']);
  assert.equal(out.stored, 2);
  learns.s.close();

  const none = harness({ lead: { wa_lid: null } });
  await none.backfill.history(none.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.deepEqual(none.calls.map((c) => c.where.key), [{ remoteJidAlt: PHONE_JID }, { remoteJid: PHONE_JID }]);
  none.s.close();
});

test('a lid-only chat is asked for by its lid alone, here over the 30 days an owner join reads', async () => {
  const h = harness({
    lead: { phone_e164: null, wa_jid: null },
    serve: router({ [`jid:${LID}`]: [[rec({ id: 'K5', jidAlt: null })]] }),
  });
  const out = await h.backfill.history(h.lead(), { sinceTs: NOW - OWNER_HISTORY_MS, untilTs: NOW });
  assert.deepEqual(h.calls, [{
    where: { key: { remoteJid: LID }, messageTimestamp: { gte: '2026-08-29T12:00:00.000Z', lte: '2026-09-28T12:00:00.000Z' } },
    page: 1, offset: PAGE_SIZE,
  }]);
  assert.deepEqual(out, { stored: 1, scanned: 1, truncated: false });
  h.s.close();
});

test('paging follows the stated page count up to the cap, and says so — in counts — when a question has more', async () => {
  const pages = (n, prefix) => Array.from({ length: n }, (_, i) => [rec({ id: `${prefix}-${i}`, ts: NOW - 100_000 + i })]);
  const altPages = (h) => h.calls.filter((c) => c.where.key.remoteJidAlt).map((c) => c.page);

  const short = harness({ serve: router({ [`alt:${PHONE_JID}`]: pages(3, 'S') }) });
  assert.deepEqual(await short.backfill.history(short.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { stored: 3, scanned: 3, truncated: false });
  assert.deepEqual(altPages(short), [1, 2, 3]);
  assert.equal(short.logs.some((e) => e.evt === 'inbox.backfill.truncated'), false);
  short.s.close();

  const long = harness({ serve: router({ [`alt:${PHONE_JID}`]: pages(12, 'L') }) });
  const out = await long.backfill.history(long.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.deepEqual(out, { stored: BACKFILL_MAX_PAGES, scanned: BACKFILL_MAX_PAGES, truncated: true });
  assert.deepEqual(altPages(long), Array.from({ length: BACKFILL_MAX_PAGES }, (_, i) => i + 1));
  assert.deepEqual(long.logs.find((e) => e.evt === 'inbox.backfill.truncated'), {
    level: 'warn', evt: 'inbox.backfill.truncated', leadId: LEAD_ID, clause: 'phone_alt', pages: 12, total: 12, maxPages: BACKFILL_MAX_PAGES,
  });
  assertClean(long.logs);
  long.s.close();

  // An answer that does not state its pages is read until a short page.
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => rec({ id: `F-${i}`, ts: NOW - 500_000 + i }));
  const unsized = ({ where, page }) => {
    if (!where.key.remoteJidAlt) return { records: [], total: null, pages: null };
    return { records: page === 1 ? full : [rec({ id: 'F-last', ts: NOW - 600_000 })], total: null, pages: null };
  };
  const bare = harness({ serve: unsized });
  assert.deepEqual(await bare.backfill.history(bare.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { stored: PAGE_SIZE + 1, scanned: PAGE_SIZE + 1, truncated: false });
  assert.deepEqual(altPages(bare), [1, 2]);
  bare.s.close();
  const capped = harness({ serve: unsized });
  assert.equal((await capped.backfill.history(capped.lead(), { sinceTs: NOW - JOIN_HISTORY_MS, maxPages: 1 })).truncated, true, 'a full last page may hide more');
  assert.deepEqual(altPages(capped), [1]);
  capped.s.close();
});

test('groups and broadcasts are skipped whatever they carry', async () => {
  const h = harness({
    serve: router({
      [`alt:${PHONE_JID}`]: [[
        rec({ id: 'G1', jid: '120363135705763548@g.us' }),
        rec({ id: 'B1', jid: 'status@broadcast' }),
        rec({ id: 'K1' }),
      ]],
    }),
  });
  const out = await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.deepEqual(h.ingested, ['K1']);
  assert.deepEqual(out, { stored: 1, scanned: 3, truncated: false });
  h.s.close();
});

test('refresh reads only from 24 h before the chat joined: every question carries the window, nothing older is stored', async () => {
  const h = harness({
    serve: pool([
      // Private conversation from before the chat had anything to do with Bona.
      rec({ id: 'OLD', ts: FLOOR - 60_000 }),
      rec({ id: 'EDGE', ts: FLOOR }),
      rec({ id: 'NEW', ts: NOW - 60_000 }),
      // Sent through the API to the phone number: filed under the phone jid itself.
      rec({ id: 'API', jid: PHONE_JID, jidAlt: null, fromMe: true, text: 'Welcome', ts: NOW - 30_000 }),
    ]),
  });
  const out = await h.backfill.refresh(h.lead());
  assert.equal(Date.parse(SINCE_JOIN.gte), FLOOR);
  assert.deepEqual(h.calls, [
    { where: { key: { remoteJidAlt: PHONE_JID }, messageTimestamp: SINCE_JOIN }, page: 1, offset: REFRESH_LIMIT, timeoutMs: 2_500 },
    { where: { key: { remoteJid: PHONE_JID }, messageTimestamp: SINCE_JOIN }, page: 1, offset: REFRESH_LIMIT, timeoutMs: 2_500 },
    { where: { key: { remoteJid: LID }, messageTimestamp: SINCE_JOIN }, page: 1, offset: REFRESH_LIMIT, timeoutMs: 2_500 },
  ]);
  assert.deepEqual(out, { stored: 3, scanned: 5, truncated: false });
  assert.deepEqual(h.ingested, ['EDGE', 'NEW', 'API']);
  assert.deepEqual(h.inbox.messagesFor(LEAD_ID).map((m) => m.key_id), ['EDGE', 'NEW', 'API'], 'OLD never reaches the store');
  h.s.close();
});

test('the floor never reaches past the retention horizon, and is 24 h before now for a row with no join time', async () => {
  const old = harness({ lead: { inbox_since: NOW - 6 * 365 * 86_400_000 } });
  await old.backfill.refresh(old.lead());
  const horizon = { gte: new Date(NOW - RETENTION_MS).toISOString(), lte: SINCE_JOIN.lte };
  assert.deepEqual(old.calls.map((c) => c.where.messageTimestamp), [horizon, horizon, horizon],
    'a transcript the five-year purge emptied is not stored again');
  old.s.close();

  const unset = harness({ lead: { inbox_since: null } });
  await unset.backfill.refresh(unset.lead());
  assert.deepEqual(unset.calls.map((c) => c.where.messageTimestamp), [DAY, DAY, DAY]);
  unset.s.close();
});

test('a long chat is read for its newest 50 per question, and that is not truncation news', async () => {
  const many = Array.from({ length: REFRESH_LIMIT + 1 }, (_, i) => rec({ id: `R-${i}`, ts: NOW - 100_000 + i }));
  const h = harness({ serve: pool(many) });
  const out = await h.backfill.refresh(h.lead());
  assert.deepEqual(out, { stored: REFRESH_LIMIT, scanned: 2 * REFRESH_LIMIT, truncated: true });
  const stored = h.inbox.messagesFor(LEAD_ID);
  assert.equal(stored.length, REFRESH_LIMIT);
  assert.equal(stored[0].key_id, 'R-1', 'the 51st newest is not fetched');
  assert.equal(h.logs.some((e) => e.evt === 'inbox.backfill.truncated'), false, 'reading only the newest page is the point');
  h.s.close();
});

test('a second refresh within 5 s asks nothing; at 5 s it reads again; 1,000 chats are remembered, the stalest forgotten', async () => {
  const h = harness();
  assert.deepEqual(await h.backfill.refresh(h.lead()), { stored: 0, scanned: 0, truncated: false });
  assert.equal(h.calls.length, 3);
  h.tick(4_999);
  assert.deepEqual(await h.backfill.refresh(h.lead()), { skipped: 'recent' });
  assert.equal(h.calls.length, 3, 'the thread page and the reply right after it: one read');
  h.tick(1);
  assert.deepEqual(await h.backfill.refresh(h.lead()), { stored: 0, scanned: 0, truncated: false });
  assert.equal(h.calls.length, 6);
  await h.backfill.refresh(h.lead(), { minIntervalMs: 0 });
  assert.equal(h.calls.length, 9, 'a caller may ask for no pause');

  // 1,000 other chats refreshed since (no phone and no lid, so nothing is asked for them):
  // this one is forgotten, and is read again at once.
  for (let i = 0; i < 1_000; i += 1) {
    const id = `LEAD-20260928-${String(i).padStart(8, '0')}`;
    h.s.insertLead({ lead_id: id, created: NOW, updated: NOW, channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', inbox_since: NOW });
    await h.backfill.refresh({ lead_id: id });
  }
  assert.equal(h.calls.length, 9);
  await h.backfill.refresh(h.lead());
  assert.equal(h.calls.length, 12);
  h.s.close();
});

test('refresh keeps to its budget: each question waits at most 2.5 s or what is left, and a spent budget skips the rest', async () => {
  const answer = pool([
    rec({ id: 'K1' }),
    rec({ id: 'API', jid: PHONE_JID, jidAlt: null, fromMe: true, text: 'Welcome', ts: NOW - 30_000 }),
  ]);
  // Evolution takes 1.5 s over every question.
  const slow = harness({ serve: (q, { tick }) => { tick(1_500); return answer(q); } });
  const out = await slow.backfill.refresh(slow.lead());
  assert.deepEqual(slow.calls.map((c) => [c.where.key, c.timeoutMs]), [
    [{ remoteJidAlt: PHONE_JID }, 2_500],
    [{ remoteJid: PHONE_JID }, 1_500],
  ], 'the lid question was never asked');
  assert.deepEqual(out, { stored: 2, scanned: 2, truncated: false, partial: true });
  assert.equal(slow.now() - NOW, 3_000, 'the page waited no longer than the budget');
  assert.deepEqual(slow.logs.find((e) => e.evt === 'inbox.refresh.partial'), {
    level: 'warn', evt: 'inbox.refresh.partial', leadId: LEAD_ID, budgetMs: 3_000,
  });
  assertClean(slow.logs);
  slow.s.close();

  const tight = harness({ serve: (q, { tick }) => { tick(1_000); return answer(q); } });
  assert.deepEqual(await tight.backfill.refresh(tight.lead(), { budgetMs: 1_000 }), { stored: 1, scanned: 1, truncated: false, partial: true });
  assert.deepEqual(tight.calls.map((c) => c.timeoutMs), [1_000]);
  tight.s.close();
});

test('a chat outside the inbox, an unknown lead, or no Evolution configured: nothing is read', async () => {
  const unsure = harness({ lead: { inbox_state: 'unsure' } });
  const skip = { stored: 0, scanned: 0, truncated: false };
  assert.deepEqual(await unsure.backfill.history(unsure.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { ...skip, skipped: 'not_in_inbox' });
  assert.deepEqual(await unsure.backfill.refresh(unsure.lead()), { ...skip, skipped: 'not_in_inbox' });
  assert.deepEqual(await unsure.backfill.refresh({ lead_id: 'LEAD-20260928-00000000' }), { ...skip, skipped: 'not_found' });
  assert.deepEqual(await unsure.backfill.refresh(null), { ...skip, skipped: 'not_found' });
  assert.equal(unsure.calls.length, 0);
  unsure.s.close();

  const fetched = [];
  const off = harness({ injectFind: false, env: {}, fetchImpl: async (...args) => { fetched.push(args); throw new Error('must not be called'); } });
  assert.equal(off.backfill.configured, false);
  assert.deepEqual(await off.backfill.history(off.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { ...skip, skipped: 'not_configured' });
  assert.deepEqual(await off.backfill.refresh(off.lead()), { ...skip, skipped: 'not_configured' });
  assert.equal(fetched.length, 0);
  off.s.close();
});

test('a failed read never throws: it comes back as { error } and logs inbox.backfill.failed without numbers', async () => {
  const throwing = (err) => () => { throw err; };
  const cases = [
    [new Error(`boom for ${PHONE_JID} and ${LID}`), 'failed'],
    [new EvolutionError('POST /chat/findMessages/abdulaziz-personal -> HTTP 500', 500, { detail: PHONE }), 'http_500'],
    [new EvolutionError('POST /chat/findMessages/abdulaziz-personal failed: network', 0, null), 'network'],
    [new EvolutionError('POST /chat/findMessages/abdulaziz-personal failed: timeout', 0, null), 'timeout'],
  ];
  for (const [err, code] of cases) {
    const h = harness({ serve: throwing(err) });
    assert.deepEqual(await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { error: code });
    assert.deepEqual(await h.backfill.refresh(h.lead()), { error: code });
    const failures = h.logs.filter((e) => e.evt === 'inbox.backfill.failed');
    assert.equal(failures.length, 2, code);
    assert.deepEqual([failures[0].leadId, failures[0].error, failures[0].level], [LEAD_ID, code, 'warn']);
    assertClean(h.logs);
    assert.equal(JSON.stringify(h.logs).includes('boom'), false, 'the thrown message is not logged');
    h.s.close();
  }

  // A store failure inside ingest is caught the same way.
  const broken = harness({
    serve: router({ [`alt:${PHONE_JID}`]: [[rec()]] }),
    ingest: () => { throw new Error(`SQLITE_BUSY while storing ${PHONE}`); },
  });
  assert.deepEqual(await broken.backfill.history(broken.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { error: 'failed' });
  assertClean(broken.logs);
  broken.s.close();

  // A window that is not two times is refused before anything is asked.
  const window = harness();
  assert.deepEqual(await window.backfill.history(window.lead()), { error: 'bad_window' });
  assert.deepEqual(await window.backfill.history(window.lead(), { sinceTs: NOW - JOIN_HISTORY_MS, untilTs: 'now' }), { error: 'bad_window' });
  assert.equal(window.calls.length, 0);
  window.s.close();
});

test('default wiring: the real findMessages request body, answered and stored through the normaliser', async () => {
  const requests = [];
  const raw = {
    key: { id: 'WIRE-1', fromMe: false, remoteJid: LID, remoteJidAlt: PHONE_JID },
    pushName: 'Sara', messageType: 'conversation',
    message: { conversation: 'Hello from the site' },
    messageTimestamp: Math.floor((NOW - 60_000) / 1000),
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const first = requests.length === 1;
    const body = { messages: { total: first ? 1 : 0, pages: first ? 1 : 0, currentPage: 1, records: first ? [raw] : [] } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const h = harness({ injectFind: false, env: { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k' }, fetchImpl });
  assert.equal(h.backfill.configured, true);
  assert.deepEqual(await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { stored: 1, scanned: 1, truncated: false });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, 'http://evo.test/chat/findMessages/abdulaziz-personal');
  assert.equal(requests[0].headers.apikey, 'k');
  assert.deepEqual(requests[0].body, { where: { key: { remoteJidAlt: PHONE_JID }, messageTimestamp: DAY }, page: 1, offset: PAGE_SIZE });
  assert.deepEqual(requests[1].body.where.key, { remoteJid: PHONE_JID });
  assert.deepEqual(requests[2].body.where.key, { remoteJid: LID });
  const [m] = h.inbox.messagesFor(LEAD_ID);
  assert.deepEqual([m.key_id, m.text, m.ts, m.sender_kind], ['WIRE-1', 'Hello from the site', NOW - 60_000, 'client']);

  requests.length = 0;
  await h.backfill.refresh(h.lead());
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].body, { where: { key: { remoteJidAlt: PHONE_JID }, messageTimestamp: SINCE_JOIN }, page: 1, offset: REFRESH_LIMIT });
  assert.ok(requests.every((r) => r.body.where.messageTimestamp.gte === SINCE_JOIN.gte), 'no request reaches before the floor');
  h.s.close();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/inbox-backfill.test.mjs`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/services/api/lib/inbox/backfill.mjs'`.

- [ ] **Step 3: Implement** — create `services/api/lib/inbox/backfill.mjs`:

```js
/**
 * Per-chat reads from Evolution for the Bona inbox (2026-09-27 design §4.1, §4.3; P2-2).
 *
 * The poller reads every chat in one time window. This reads ONE chat, at two moments:
 *
 *   - `history`: a chat has just joined the inbox, so store what led up to the joining
 *     message — the preceding 24 h for an automatic join (the "Hi" before the Ref code, the
 *     owner's opening line), 30 days when the owner vouched for the chat himself.
 *   - `refresh`: someone opens a thread or is about to reply, so fetch its newest messages
 *     first — the page, and the stale-view check before a send, must not be one poll behind.
 *     Never from further back than the chat's history floor, 24 h before it joined
 *     (amendment A1): an automatic join only ever brings that much of a chat's past, and
 *     without the floor, opening the thread would store months of the owner's earlier
 *     private conversation. And cheap (A2): about 3 s at most, whatever Evolution is
 *     doing, and the same chat is not read again within 5 s.
 *
 * Evolution files one WhatsApp chat under two jids (verified live 2026-09-28): what the
 * client sends and what the owner types on his phone sit under the chat's privacy-mode
 * `@lid`, with the client's phone jid alongside as `key.remoteJidAlt`; what the API sends to
 * a phone number sits under the phone jid itself. So one chat is three questions —
 * `remoteJidAlt` = phone jid, `remoteJid` = phone jid, `remoteJid` = lid — de-duplicated by
 * message id. The lid question is asked last, from a fresh read of the lead: the first two
 * can teach a lead its lid.
 *
 * Read-only, like lib/evolution.mjs: it only ever asks `POST /chat/findMessages`. What is
 * stored is decided by lib/inbox/ingest.mjs, record by record. A read that fails never
 * throws — the chat stays as it was, and the poller or the next refresh brings the messages
 * in. Nothing here logs a phone number, a lid or text.
 */
import { EvolutionError, PAGE_SIZE, findMessagesPage, oldestFirst } from '../evolution.mjs';
import { waConfig } from '../wa.mjs';
import { RETENTION_MS } from './store.mjs';

/** An automatic join stores this much of the chat before the joining message. */
export const JOIN_HISTORY_MS = 24 * 3_600_000;
/** An owner-button join (Move to Bona inbox, Add chat by phone number) stores this much. */
export const OWNER_HISTORY_MS = 30 * 86_400_000;
/** Pages per question on a history read: 10 × 100 records is more than any real chat window. */
export const BACKFILL_MAX_PAGES = 10;
/** How many of the newest records a refresh asks for, per question. */
export const REFRESH_LIMIT = 50;

/** No single refresh question waits longer than this, whatever is left of the budget (A2). */
const REFRESH_REQUEST_MS = 2_500;
/** How many chats' last refresh times are kept; past that, the stalest is forgotten (A2). */
const REFRESH_MEMORY = 1_000;
const iso = (ms) => new Date(ms).toISOString();

const PHONE_JID_RE = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/;
/** International digits: 8–15 of them, never the local trunk `0` first (see wa-send.mjs). */
const PHONE_RE = /^[1-9]\d{7,14}$/;
const isLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
/** A group or a broadcast is never a client's chat, whatever alt it happens to carry. */
const isGroupOrBroadcast = (jid) => typeof jid === 'string' && (jid.endsWith('@g.us') || jid.endsWith('@broadcast'));

/**
 * The lead's phone-number jid: its stored `@s.whatsapp.net` jid with any device suffix
 * stripped, else one built from `phone_e164`. Null for a chat known only by its lid —
 * a lid's digits are an opaque id, never a phone number.
 * @returns {string|null}
 */
export function phoneJidOf(lead) {
  const m = PHONE_JID_RE.exec(String(lead?.wa_jid ?? ''));
  if (m && !m[1].startsWith('0')) return `${m[1]}@s.whatsapp.net`;
  const phone = String(lead?.phone_e164 ?? '');
  return PHONE_RE.test(phone) ? `${phone}@s.whatsapp.net` : null;
}

/** What a failed read says about itself: a status or a kind of failure, never an error message — one could carry a jid. */
function errorCode(err) {
  if (err instanceof EvolutionError) {
    if (err.status) return `http_${err.status}`;
    return /timeout/.test(String(err.message)) ? 'timeout' : 'network';
  }
  return 'failed';
}

/**
 * @param {object} o
 * @param {object} [o.env]          for `waConfig`: Evolution URL, key and instance
 * @param {ReturnType<import('../db.mjs').openDb>} o.db
 * @param {(lead: object, rec: object) => any} o.ingest  lib/inbox/ingest.mjs `createIngest().ingest`
 * @param {(q: { where: object, page: number, offset: number, timeoutMs?: number }) => Promise<{ records: object[], total: number|null, pages: number|null }>} [o.find]
 *        injected in tests; defaults to `findMessagesPage` against the instance in `env`.
 *        A refresh adds `timeoutMs`, its per-question share of the budget.
 * @param {typeof globalThis.fetch} [o.fetchImpl]
 * @param {(e: object) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {number} [o.timeoutMs]  a history question's timeout
 */
export function createBackfill({
  env = {}, db, ingest, find = null, fetchImpl = globalThis.fetch, log = () => {}, now = () => Date.now(), timeoutMs = 8000,
} = {}) {
  if (!db) throw new TypeError('createBackfill needs the store');
  if (typeof ingest !== 'function') throw new TypeError('createBackfill needs the ingest function');
  const wa = waConfig(env);
  const configured = Boolean(find) || Boolean(wa.baseUrl && wa.apiKey);
  const read = find ?? (({ where, page, offset, timeoutMs: requestMs = timeoutMs }) => findMessagesPage({
    baseUrl: wa.baseUrl, apiKey: wa.apiKey, instance: wa.instance, where, page, offset, fetchImpl, timeoutMs: requestMs,
  }));
  const skipped = (reason) => ({ stored: 0, scanned: 0, truncated: false, skipped: reason });
  /** lead_id → when it was last refreshed. A Map keeps insertion order, so the first key is the stalest. */
  const refreshedAt = new Map();

  function failed(leadId, error, name = null) {
    log({ level: 'warn', evt: 'inbox.backfill.failed', leadId, error, ...(name ? { name } : {}) });
    return { error };
  }

  /** The lead as it is now, or why a per-chat read has no business with it. */
  function inboxLead(leadId) {
    const lead = leadId ? db.getLead(leadId) : null;
    if (!lead) return { skip: skipped('not_found') };
    // Ingest would refuse every record of a chat that is not in the inbox anyway, and a
    // chat the inbox has no business with should not even be fetched.
    if (lead.inbox_state !== 'in') return { skip: skipped('not_in_inbox') };
    return { lead };
  }

  /**
   * The three questions for one chat, each paged newest-first inside `time` (the
   * `messageTimestamp` window every question carries). With a `deadline` (a refresh), each
   * question waits at most what is left of it, and none starts once it has passed: the
   * tally then says `partial`.
   */
  async function readChat(lead, { time, offset, maxPages, noteTruncation, deadline = null }) {
    const leadId = lead.lead_id;
    const seen = new Set();
    const tally = { stored: 0, scanned: 0, truncated: false };

    async function ask(clause, key) {
      const where = { key, messageTimestamp: time };
      const batch = [];
      for (let page = 1; page <= maxPages; page += 1) {
        let query = { where, page, offset };
        if (deadline !== null) {
          const left = deadline - now();
          if (left <= 0) {
            tally.partial = true;
            break;
          }
          query = { ...query, timeoutMs: Math.min(left, REFRESH_REQUEST_MS) };
        }
        const answer = await read(query);
        const records = Array.isArray(answer) ? answer : (Array.isArray(answer?.records) ? answer.records : []);
        tally.scanned += records.length;
        for (const rec of records) {
          if (!rec?.id || seen.has(rec.id) || isGroupOrBroadcast(rec.jid)) continue;
          seen.add(rec.id);
          batch.push(rec);
        }
        // Evolution says how many pages the question has; an answer that does not is read
        // until a short page, the way lib/evolution.mjs `fetchWindow` always has.
        const pages = Number.isFinite(answer?.pages) ? answer.pages : null;
        const more = pages === null ? records.length >= offset : page < pages;
        if (!more) break;
        if (page === maxPages) {
          tally.truncated = true;
          if (noteTruncation) {
            log({
              level: 'warn', evt: 'inbox.backfill.truncated', leadId, clause, pages,
              total: Number.isFinite(answer?.total) ? answer.total : null, maxPages,
            });
          }
        }
      }
      // Oldest first, the order they happened in — like the poller.
      for (const rec of oldestFirst(batch)) {
        const out = await ingest(db.getLead(leadId), rec);
        if (out?.stored && out.inserted) tally.stored += 1;
      }
    }

    const phoneJid = phoneJidOf(lead);
    if (phoneJid) {
      await ask('phone_alt', { remoteJidAlt: phoneJid });
      await ask('phone', { remoteJid: phoneJid });
    }
    // Read again: the two questions above may have taught this lead its lid.
    const lid = db.getLead(leadId)?.wa_lid ?? null;
    if (isLid(lid)) await ask('lid', { remoteJid: lid });
    return tally;
  }

  /**
   * Store a chat's messages between `sinceTs` and `untilTs` (ms).
   * @returns {Promise<{ stored: number, scanned: number, truncated: boolean, skipped?: string } | { error: string }>}
   */
  async function history(lead, { sinceTs, untilTs = now(), maxPages = BACKFILL_MAX_PAGES } = {}) {
    if (!configured) return skipped('not_configured');
    const leadId = lead?.lead_id ?? null;
    if (!Number.isFinite(sinceTs) || !Number.isFinite(untilTs)) return failed(leadId, 'bad_window');
    try {
      const { lead: current, skip } = inboxLead(leadId);
      if (skip) return skip;
      const cap = Math.max(1, Math.trunc(Number(maxPages)) || BACKFILL_MAX_PAGES);
      return await readChat(current, {
        time: { gte: iso(sinceTs), lte: iso(untilTs) }, offset: PAGE_SIZE, maxPages: cap, noteTruncation: true,
      });
    } catch (err) {
      return failed(leadId, errorCode(err), err?.name ?? null);
    }
  }

  /**
   * Store a chat's newest `REFRESH_LIMIT` records per question, from its history floor to
   * now (A1). The floor is 24 h before the chat joined — an owner-button join already stored
   * its 30 days when it joined, so a refresh never needs to reach further — and never past
   * the retention horizon, or a refresh would store again what the daily purge removed.
   * Reading only the newest page is the point, so a longer chat is not "truncated" news.
   *
   * Bounded (A2): the thread page and the reply right after it both ask, so the same chat
   * is not read again within `minIntervalMs`; and the read keeps to `budgetMs`, each question
   * waiting at most 2.5 s or what is left. The time is noted before the read, so a failing
   * Evolution is not asked again on every click either. Never throws.
   * @returns {Promise<{ stored: number, scanned: number, truncated: boolean, partial?: true, skipped?: string }
   *          | { skipped: 'recent' } | { error: string }>}
   */
  async function refresh(lead, { budgetMs = 3000, minIntervalMs = 5000 } = {}) {
    if (!configured) return skipped('not_configured');
    const leadId = lead?.lead_id ?? null;
    try {
      const { lead: current, skip } = inboxLead(leadId);
      if (skip) return skip;
      const t = now();
      const last = refreshedAt.get(leadId);
      if (last !== undefined && t - last < minIntervalMs) return { skipped: 'recent' };
      refreshedAt.delete(leadId); // re-added at the end: the most recently refreshed
      refreshedAt.set(leadId, t);
      if (refreshedAt.size > REFRESH_MEMORY) refreshedAt.delete(refreshedAt.keys().next().value);
      const floor = Math.max((current.inbox_since ?? t) - JOIN_HISTORY_MS, t - RETENTION_MS);
      const out = await readChat(current, {
        time: { gte: iso(floor), lte: iso(t) }, offset: REFRESH_LIMIT, maxPages: 1, noteTruncation: false, deadline: t + budgetMs,
      });
      if (out.partial) log({ level: 'warn', evt: 'inbox.refresh.partial', leadId, budgetMs });
      return out;
    } catch (err) {
      return failed(leadId, errorCode(err), err?.name ?? null);
    }
  }

  return { configured, phoneJidOf, history, refresh };
}
```

- [ ] **Step 4: Run**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/inbox-backfill.test.mjs`
Expected: PASS (14 tests, 0 fail).

- [ ] **Step 5: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail (the Task 5 total plus these 14). No existing test changes: nothing imports `lib/inbox/backfill.mjs` yet. `backfill.mjs` deliberately does not import `lib/wa-poller.mjs`, so the poller task can import `JOIN_HISTORY_MS` from it without an import cycle; its one new import, `RETENTION_MS` from `./store.mjs`, adds none (the store imports only `./eligibility.mjs`).

- [ ] **Step 6: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/inbox/backfill.mjs services/api/test/inbox-backfill.test.mjs
git commit -m "inbox: per-chat history and refresh reads from Evolution

Three findMessages questions per chat (remoteJidAlt = phone jid,
remoteJid = phone jid, remoteJid = lid re-derived after the first two),
de-duplicated by key id, groups and broadcasts skipped, stored oldest-first
through ingest. History pages to BACKFILL_MAX_PAGES and logs truncation in
counts only. Refresh (amendments A1, A2) stores the newest 50 per clause
since 24 h before the chat joined, never past the retention horizon, in a
~3 s budget (2.5 s per request at most; the rest skipped as partial), and
not twice in 5 s for one chat. Never throws: failures come back as
{ error } with a status code, never a message.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Sender — outbox ledger, durable day cap, per-user cap and staff replies (`lib/wa-send.mjs`)

> Builds on Task 1 (schema v4: `wa_outbox`, `wa_messages`, the lead inbox columns in `COLUMNS.leads`) and Task 4 (`createInboxStore`). Implements P2-4 and the `lib/wa-send.mjs` block of the interface contract. `inbox` becomes a required argument of `createSender`, so this task also hands it over in `index.mjs` (Step 5) — without that, every test that builds the app fails with `TypeError: createSender needs the inbox store`. The fuller Phase 2 wiring (`recoverInterrupted()` at start-up, `app.inboxStore`, maintenance timer) stays with the `index.mjs` task.

**Files:**
- Modify: `services/api/lib/wa-send.mjs` (whole file replaced — most of it changes)
- Modify: `services/api/index.mjs` (one import; the one sender gets the inbox store and the db)
- Test: `services/api/test/wa-send.test.mjs` (whole file replaced: the 18 Phase 1 tests are kept — the harness now passes `inbox` + `db`, results that reached the outbox are compared without their random `sendId`, and the kind / switch / `BONA_WA_NOTIFY` tests also cover `staff` and `dana` — plus 31 new tests)

- [ ] **Step 1: Write the failing tests** — replace the whole of `services/api/test/wa-send.test.mjs` with:

```js
/**
 * The one door every message to someone other than the owner goes out through: a 1:1
 * jid only, the owner's sending switch, limits shared by every sender, an outbox row
 * written before every call, and team members' replies that are never sent twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import {
  createSender, replyJidFor, SEND_PER_MIN, SEND_PER_DAY, PER_RECIPIENT_PER_MIN, PER_USER_PER_MIN,
} from '../lib/wa-send.mjs';

const NOW = 1_790_500_000_000;
const DAY = 86_400_000;
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };
const OWNER_JID = '966593296933@s.whatsapp.net';
const CLIENT = '966511111111';
const CLIENT_JID = `${CLIENT}@s.whatsapp.net`;
const SID = 'sid_0123456789abcdef';

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const netError = (code) => Object.assign(new Error('boom'), { cause: { code } });

/**
 * `reply(n)` answers the n-th HTTP call: `{ status, body }`, or `{ throws: err }` to
 * make the call itself fail. Each call also records how many outbox rows were
 * `pending` at that moment — the row must be written before the call, not after.
 */
function harness({ reply = () => ({ status: 201, body: { key: { id: 'KEY-1' } } }), env = ENV, limits } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  const inbox = createInboxStore(s, { now: () => clock });
  const calls = [];
  const logs = [];
  const pendingNow = () => s.db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE status = 'pending'").get().n;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body), pending: pendingNow() });
    const r = await reply(calls.length);
    if (r.throws) throw r.throws;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  const sender = createSender({ env, team, inbox, db: s, fetchImpl, now: () => clock, log: (o) => logs.push(o), limits });
  return { s, team, inbox, sender, calls, logs, now: () => clock, tick: (ms) => { clock += ms; } };
}

/** A result that reached the outbox carries its send id; the rest compares as it always did. */
function withoutSendId(out) {
  assert.match(out.sendId, /^SND-/);
  const rest = { ...out };
  delete rest.sendId;
  return rest;
}

const outboxRows = (h) => h.s.db.prepare('SELECT * FROM wa_outbox ORDER BY created, rowid').all();

let seedSeq = 0;
/** Rows written straight into the outbox, with a chosen age — the ledger a busy day leaves. */
function seedOutbox(h, n, { created = h.now(), jid = '966502000000@s.whatsapp.net', status = 'accepted', kind = 'staff' } = {}) {
  const stmt = h.s.db.prepare(`INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error)
                               VALUES (?, NULL, ?, NULL, NULL, ?, ?, NULL, ?, ?, NULL)`);
  h.s.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      seedSeq += 1;
      stmt.run(`SEED-${seedSeq}`, jid, kind, status, created, created);
    }
  });
}

/** An inbox chat with a phone jid and one message from the client a minute ago. */
function seedChat(h, patch = {}) {
  const lead = h.s.insertLead({
    lead_id: 'L-1', created: NOW - 3_600_000, updated: NOW - 3_600_000, phone_e164: CLIENT, wa_jid: CLIENT_JID,
    channel: 'whatsapp', match_method: 'ref', inbox_state: 'in', inbox_since: NOW - 3_600_000, ...patch,
  });
  h.inbox.upsertMessage({ key_id: `IN-${lead.lead_id}`, lead_id: lead.lead_id, jid: CLIENT_JID, direction: 'in', sender_kind: 'client', text: 'hi', ts: NOW - 60_000 });
  return lead;
}

const staffOf = (h) => h.team.addUser({ name: 'Sara', phone: '966500000077' });
const replyArgs = (staff, patch = {}) => ({ sendId: SID, leadId: 'L-1', userId: staff.user_id, text: 'hello', seenTs: NOW - 60_000, ...patch });

/* ------------------------------ the gate (Phase 1, kept) ------------------------------ */

test('sends the text to that number on the owner instance and returns the WhatsApp message id', async () => {
  const h = harness();
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'hello', kind: 'code' });
  assert.deepEqual(withoutSendId(out), { ok: true, keyId: 'KEY-1', status: 201 });
  assert.equal(h.calls[0].url, 'http://evo.test/message/sendText/abdulaziz-personal');
  assert.equal(h.calls[0].init.headers.apikey, 'k');
  assert.deepEqual(h.calls[0].body, { number: '966500000001', text: 'hello' });
  h.s.close();
});

test('never sends to a group, a lid, a broadcast, a local-format number or garbage', async () => {
  const h = harness();
  const bad = ['120363135705763548@g.us', '123456789@lid', 'status@broadcast', '966500000001', '', null, '0500000001@s.whatsapp.net'];
  for (const jid of bad) {
    assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'code' }), { ok: false, error: 'bad_recipient' }, String(jid));
  }
  assert.equal(h.calls.length, 0);
  h.s.close();
});

test('bad_text: empty, oversized, or not a string at all', async () => {
  const h = harness();
  const jid = '966500000001@s.whatsapp.net';
  assert.deepEqual(await h.sender.sendTo({ jid, text: '', kind: 'code' }), { ok: false, error: 'bad_text' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: undefined, kind: 'code' }), { ok: false, error: 'bad_text' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'a'.repeat(4097), kind: 'code' }), { ok: false, error: 'bad_text' });
  assert.equal(h.calls.length, 0, 'none of the bad texts reach the network');
  assert.equal((await h.sender.sendTo({ jid, text: 'a'.repeat(4096), kind: 'code' })).ok, true, '4096 exactly is fine');
  h.s.close();
});

test('bad_kind: "code" and "staff" are the real kinds in Phase 2; Dana waits for Phase 4', async () => {
  const h = harness();
  const jid = '966500000001@s.whatsapp.net';
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'reply' }), { ok: false, error: 'bad_kind' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'dana' }), { ok: false, error: 'bad_kind' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'note' }), { ok: false, error: 'bad_kind' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'x' }), { ok: false, error: 'bad_kind' });
  assert.equal(h.calls.length, 0);
  assert.equal((await h.sender.sendTo({ jid, text: 'x', kind: 'staff' })).ok, true);
  h.s.close();
});

test('the sending switch stops everything except what is allowed to bypass it', async () => {
  const h = harness();
  h.team.setSetting('sending_enabled', '0');
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'sending_disabled' });
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'staff' }), { ok: false, error: 'sending_disabled' });
  const owner = await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code', bypassSwitch: true });
  assert.equal(owner.ok, true, "the owner's own login code still goes, or he could never switch it back on");
  h.s.close();
});

test('bypassSwitch is decided here, not trusted from the caller: it only ever works for the owner\'s own code', async () => {
  const h = harness();
  h.team.setSetting('sending_enabled', '0');
  // a caller claiming bypassSwitch for someone other than the owner is still refused.
  assert.deepEqual(
    await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code', bypassSwitch: true }),
    { ok: false, error: 'sending_disabled' },
  );
  // nor for a reply, even one addressed to the owner.
  assert.deepEqual(
    await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'staff', bypassSwitch: true }),
    { ok: false, error: 'sending_disabled' },
  );
  assert.equal(h.calls.length, 0, 'a non-owner bypass attempt never reaches the network');
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

test('a limiter refusal leaves the other limiters untouched (peek before take)', async () => {
  const h = harness();
  const hot = '966500000001@s.whatsapp.net';
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) assert.equal((await h.sender.sendTo({ jid: hot, text: 'x', kind: 'code' })).ok, true);
  // burn a handful of refusals against the per-recipient limiter alone
  for (let i = 0; i < 5; i += 1) assert.deepEqual(await h.sender.sendTo({ jid: hot, text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  // if those refusals had also charged the shared per-minute bucket, this would stall below SEND_PER_MIN
  let ok = PER_RECIPIENT_PER_MIN;
  for (let n = 100; ok < SEND_PER_MIN && n < 200; n += 1) {
    if ((await h.sender.sendTo({ jid: `966500000${n}@s.whatsapp.net`, text: 'x', kind: 'code' })).ok) ok += 1;
  }
  assert.equal(ok, SEND_PER_MIN, 'the refusals spent nothing from the shared bucket');
  h.s.close();
});

test("the owner's own jid skips the shared per-minute/per-day budget, but not the per-recipient one", async () => {
  const h = harness();
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) assert.equal((await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code' })).ok, true);
  assert.deepEqual(await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' }, 'still capped per-recipient');
  // immediately after, in the same minute, a fresh recipient still gets the FULL shared allowance
  let ok = 0;
  for (let n = 0; ok < SEND_PER_MIN && n < 100; n += 1) {
    if ((await h.sender.sendTo({ jid: `96652220${String(n).padStart(4, '0')}@s.whatsapp.net`, text: 'x', kind: 'code' })).ok) ok += 1;
  }
  assert.equal(ok, SEND_PER_MIN, "the owner's sends never spent the shared budget");
  h.s.close();
});

test('bypass is still subject to the per-recipient limit', async () => {
  const h = harness();
  h.team.setSetting('sending_enabled', '0');
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) {
    assert.equal((await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code', bypassSwitch: true })).ok, true);
  }
  assert.deepEqual(
    await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code', bypassSwitch: true }),
    { ok: false, error: 'rate_limited' },
  );
  h.s.close();
});

test('an HTTP error fails; a timeout is "uncertain", never retried here', async () => {
  const bad = harness({ reply: () => ({ status: 500, body: {} }) });
  assert.deepEqual(withoutSendId(await bad.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })), { ok: false, error: 'http_500' });
  bad.s.close();

  const s = openDb(':memory:');
  const team = createTeam(s);
  const slow = createSender({
    env: ENV, team, inbox: createInboxStore(s), timeoutMs: 5,
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError()))),
  });
  assert.deepEqual(withoutSendId(await slow.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })), { ok: false, error: 'timeout', uncertain: true });
  s.close();
});

test('a 502 or 504 is "uncertain": the request may well have gone through', async () => {
  for (const status of [502, 504]) {
    const h = harness({ reply: () => ({ status, body: {} }) });
    assert.deepEqual(
      withoutSendId(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })),
      { ok: false, error: `http_${status}`, uncertain: true },
      String(status),
    );
    h.s.close();
  }
});

test('a definite pre-connection failure (refused, unknown host, DNS) is not "uncertain"', async () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  const inbox = createInboxStore(s);
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    const sender = createSender({ env: ENV, team, inbox, fetchImpl: async () => { throw netError(code); } });
    assert.deepEqual(
      withoutSendId(await sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })),
      { ok: false, error: 'network' },
      code,
    );
  }
  s.close();
});

test('any other thrown error is "network" but "uncertain" — we cannot tell if it sent', async () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  const inbox = createInboxStore(s);
  const causes = [
    netError('ECONNRESET'),
    Object.assign(new Error('mystery'), {}),
    new TypeError('fetch failed'),
  ];
  for (const err of causes) {
    const sender = createSender({ env: ENV, team, inbox, fetchImpl: async () => { throw err; } });
    assert.deepEqual(
      withoutSendId(await sender.sendTo({ jid: '966500000002@s.whatsapp.net', text: 'x', kind: 'code' })),
      { ok: false, error: 'network', uncertain: true },
      err.message,
    );
  }
  s.close();
});

test('a 2xx counts as sent only when the body carries a WhatsApp message id', async () => {
  const h = harness({ reply: () => ({ status: 200, body: { success: true, note: 'super-secret-body-marker' } }) });
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' });
  assert.deepEqual(withoutSendId(out), { ok: false, error: 'no_ack', uncertain: true });
  const entry = h.logs.find((l) => l.evt === 'wa.send.no_key');
  assert.ok(entry, 'logs that the ack was missing');
  assert.ok(!JSON.stringify(entry).includes('super-secret-body-marker'), 'never logs the response body');
  h.s.close();
});

test('a timeout while reading the body is also "no key", not "network"', async () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  const logs = [];
  const sender = createSender({
    env: ENV, team, inbox: createInboxStore(s), timeoutMs: 5, log: (o) => logs.push(o),
    fetchImpl: (url, init) => Promise.resolve({
      ok: true,
      status: 200,
      text: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError()))),
    }),
  });
  assert.deepEqual(
    withoutSendId(await sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })),
    { ok: false, error: 'no_ack', uncertain: true },
  );
  assert.ok(logs.some((l) => l.evt === 'wa.send.no_key'));
  s.close();
});

test('BONA_WA_NOTIFY=0 does not block a login code (only other kinds would need it)', async () => {
  const h = harness({ env: { ...ENV, BONA_WA_NOTIFY: '0' } });
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' });
  assert.equal(out.ok, true);
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000002@s.whatsapp.net', text: 'x', kind: 'staff' }), { ok: false, error: 'disabled' });
  assert.equal(h.calls.length, 1, 'the reply never reached the network');
  h.s.close();
});

test('no Evolution credentials: nothing is attempted', async () => {
  const h = harness({ env: {} });
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'evolution-not-configured' });
  assert.equal(h.calls.length, 0);
  h.s.close();
});

/* ------------------------------ construction ------------------------------ */

test('createSender needs the inbox store; reply also needs the db', async () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  assert.throws(() => createSender({ env: ENV, team }), TypeError);
  assert.throws(() => createSender({ env: ENV, inbox: createInboxStore(s) }), TypeError);
  const noDb = createSender({ env: ENV, team, inbox: createInboxStore(s), fetchImpl: async () => { throw new Error('never called'); } });
  await assert.rejects(noDb.reply({ sendId: SID, leadId: 'L-1', userId: 'U', text: 'x', seenTs: 0 }), TypeError);
  s.close();
});

/* ------------------------------ the outbox ledger ------------------------------ */

test('every send is written to the outbox before the call, then marked with what came back', async () => {
  const cases = [
    { name: 'ok', reply: () => ({ status: 201, body: { key: { id: 'KEY-9' } } }), status: 'accepted', key_id: 'KEY-9', error: null },
    { name: 'timeout', reply: () => ({ throws: abortError() }), status: 'uncertain', key_id: null, error: 'timeout' },
    { name: '502', reply: () => ({ status: 502 }), status: 'uncertain', key_id: null, error: 'http_502' },
    { name: '504', reply: () => ({ status: 504 }), status: 'uncertain', key_id: null, error: 'http_504' },
    { name: 'no_ack', reply: () => ({ status: 200, body: { success: true } }), status: 'uncertain', key_id: null, error: 'no_ack' },
    { name: '400', reply: () => ({ status: 400 }), status: 'failed', key_id: null, error: 'http_400' },
    { name: 'refused', reply: () => ({ throws: netError('ECONNREFUSED') }), status: 'failed', key_id: null, error: 'network' },
    { name: 'reset', reply: () => ({ throws: netError('ECONNRESET') }), status: 'uncertain', key_id: null, error: 'network' },
  ];
  for (const c of cases) {
    const h = harness({ reply: c.reply });
    const out = await h.sender.sendTo({ jid: CLIENT_JID, text: 'hello', kind: 'staff', userId: 'USR-a', leadId: 'L-1' });
    assert.equal(h.calls.length, 1, c.name);
    assert.equal(h.calls[0].pending, 1, `${c.name}: the row was pending while the call was in flight`);
    assert.equal(out.ok, c.status === 'accepted', c.name);
    assert.equal(out.uncertain, c.status === 'uncertain' ? true : undefined, c.name);
    const row = h.inbox.getOutbox(out.sendId);
    assert.deepEqual(
      { lead_id: row.lead_id, jid: row.jid, text: row.text, user_id: row.user_id, sender_kind: row.sender_kind, status: row.status, key_id: row.key_id, error: row.error },
      { lead_id: 'L-1', jid: CLIENT_JID, text: 'hello', user_id: 'USR-a', sender_kind: 'staff', status: c.status, key_id: c.key_id, error: c.error },
      c.name,
    );
    assert.equal(row.created, NOW, c.name);
    h.s.close();
  }
});

test('a login code row keeps neither the code nor a lead', async () => {
  const h = harness();
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'Your Bona code is 482915', kind: 'code', leadId: 'L-1' });
  assert.equal(out.ok, true);
  const row = h.inbox.getOutbox(out.sendId);
  assert.equal(row.sender_kind, 'code');
  assert.equal(row.text, null);
  assert.equal(row.lead_id, null);
  assert.equal(row.status, 'accepted');
  assert.ok(!JSON.stringify(outboxRows(h)).includes('482915'), 'the code is nowhere in the outbox');
  h.s.close();
});

test('a refusal before the call writes no row of its own', async () => {
  const h = harness();
  await h.sender.sendTo({ jid: '123456789@lid', text: 'x', kind: 'staff' });
  h.team.setSetting('sending_enabled', '0');
  await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff' });
  h.team.setSetting('sending_enabled', '1');
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff' });
  assert.deepEqual(await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff' }), { ok: false, error: 'rate_limited' });
  assert.equal(outboxRows(h).length, PER_RECIPIENT_PER_MIN, 'only the sends that were attempted');
  h.s.close();
});

test('a refusal closes a row the caller already wrote, so it never lingers as pending', async () => {
  const h = harness();
  h.inbox.insertOutbox({ send_id: SID, lead_id: 'L-1', jid: CLIENT_JID, text: 'x', user_id: 'USR-a', sender_kind: 'staff' });
  h.team.setSetting('sending_enabled', '0');
  assert.deepEqual(
    await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a', leadId: 'L-1', sendId: SID }),
    { ok: false, error: 'sending_disabled', sendId: SID },
  );
  const row = h.inbox.getOutbox(SID);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'sending_disabled');
  assert.equal(h.calls.length, 0);
  h.s.close();
});

test('a send id that has already been decided is never sent again', async () => {
  const h = harness();
  for (const status of ['uncertain', 'accepted', 'failed']) {
    const sendId = `${SID}_${status}`;
    h.inbox.insertOutbox({ send_id: sendId, lead_id: 'L-1', jid: CLIENT_JID, text: 'x', user_id: 'USR-a', sender_kind: 'staff', status });
    assert.deepEqual(
      await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a', leadId: 'L-1', sendId }),
      { ok: false, error: 'duplicate', sendId },
      status,
    );
    assert.equal(h.inbox.getOutbox(sendId).status, status, `${status} row left as it was`);
  }
  assert.equal(h.calls.length, 0);
  h.s.close();
});

/* ------------------------------ the durable day cap ------------------------------ */

test('500 sends in the last 24 hours stop everyone but the owner — and a restart does not reset it', async () => {
  const h = harness();
  seedOutbox(h, SEND_PER_DAY, { created: NOW - 60_000 });
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  assert.deepEqual(await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a' }), { ok: false, error: 'rate_limited' });
  assert.ok(h.logs.some((l) => l.evt === 'wa.send.rate_limited' && l.limit === 'day'));
  assert.equal((await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code', bypassSwitch: true })).ok, true, "the owner's own code still goes");
  assert.equal(h.calls.length, 1);

  // A fresh process over the same file: the in-memory limiters are new, the ledger is not.
  const again = createSender({ env: ENV, team: h.team, inbox: createInboxStore(h.s, { now: h.now }), db: h.s, now: h.now, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(await again.sendTo({ jid: '966500000003@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  h.s.close();
});

test('499 in the last 24 hours (codes and replies alike): one more goes, and that one fills the day', async () => {
  const h = harness();
  seedOutbox(h, 250, { created: NOW - 3_600_000, kind: 'code' });
  seedOutbox(h, SEND_PER_DAY - 1 - 250, { created: NOW - 3_600_000, kind: 'staff', status: 'uncertain' });
  assert.equal((await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a' })).ok, true);
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  h.s.close();
});

test('rows older than 24 hours, rows to the owner and failed rows do not count', async () => {
  const h = harness();
  seedOutbox(h, SEND_PER_DAY, { created: NOW - DAY - 1 });
  seedOutbox(h, SEND_PER_DAY, { jid: OWNER_JID, kind: 'code' });
  seedOutbox(h, SEND_PER_DAY, { status: 'failed' });
  assert.equal((await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a' })).ok, true);
  h.s.close();
});

test('the day is rolling: a send becomes possible the moment the oldest of the 500 turns 24 hours old', async () => {
  const h = harness();
  seedOutbox(h, SEND_PER_DAY, { created: NOW - DAY + 1_000 });
  h.tick(1_000);
  assert.deepEqual(await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff' }), { ok: false, error: 'rate_limited' }, 'exactly 24 hours old still counts');
  h.tick(1);
  assert.equal((await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff' })).ok, true);
  h.s.close();
});

/* ------------------------------ per user ------------------------------ */

test('per user: 30 a minute from one team member; another member and a login code still go', async () => {
  // The shipped 20 a minute across everyone always refuses before one person's 30 could,
  // so the shared limit is widened here to reach the per-user one.
  const h = harness({ limits: { perMinute: 100 } });
  const to = (n) => `9665010${String(n).padStart(5, '0')}@s.whatsapp.net`;
  for (let i = 0; i < PER_USER_PER_MIN; i += 1) {
    assert.equal((await h.sender.sendTo({ jid: to(i), text: 'x', kind: 'staff', userId: 'USR-a' })).ok, true, `send ${i + 1}`);
  }
  assert.deepEqual(await h.sender.sendTo({ jid: to(100), text: 'x', kind: 'staff', userId: 'USR-a' }), { ok: false, error: 'rate_limited' });
  assert.equal((await h.sender.sendTo({ jid: to(101), text: 'x', kind: 'staff', userId: 'USR-b' })).ok, true, 'another member has their own allowance');
  assert.equal((await h.sender.sendTo({ jid: to(102), text: 'x', kind: 'code' })).ok, true, 'a login code has no member behind it');
  h.tick(60_000);
  assert.equal((await h.sender.sendTo({ jid: to(103), text: 'x', kind: 'staff', userId: 'USR-a' })).ok, true, 'refills');
  h.s.close();
});

/* ------------------------------ where a reply goes ------------------------------ */

test('replyJidFor: the phone jid (device suffix stripped), else the stored number, never a lid', () => {
  assert.equal(replyJidFor({ wa_jid: '966511111111@s.whatsapp.net' }), '966511111111@s.whatsapp.net');
  assert.equal(replyJidFor({ wa_jid: '966511111111:7@s.whatsapp.net' }), '966511111111@s.whatsapp.net');
  assert.equal(replyJidFor({ wa_jid: null, wa_lid: '123456789012@lid', phone_e164: '966522222222' }), '966522222222@s.whatsapp.net');
  assert.equal(replyJidFor({ wa_jid: '0501234567@s.whatsapp.net', phone_e164: '966533333333' }), '966533333333@s.whatsapp.net');
  assert.equal(replyJidFor({ wa_jid: null, wa_lid: '123456789012@lid', phone_e164: null }), null);
  assert.equal(replyJidFor({ phone_e164: '0501234567' }), null, 'a local-format number is not an address');
  assert.equal(replyJidFor({ phone_e164: '1234567' }), null, 'too short');
  assert.equal(replyJidFor(null), null);
});

/* ------------------------------ reply ------------------------------ */

test('reply: sent to the phone jid, stored as the member\'s message, and the chat marked answered', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h, { needs_human: 1 });
  const out = await h.sender.reply(replyArgs(staff));
  assert.deepEqual(out, { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-1' });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].body, { number: CLIENT, text: 'hello' });

  const row = h.inbox.getOutbox(SID);
  assert.deepEqual(
    { lead_id: row.lead_id, jid: row.jid, text: row.text, user_id: row.user_id, sender_kind: row.sender_kind, status: row.status, key_id: row.key_id },
    { lead_id: 'L-1', jid: CLIENT_JID, text: 'hello', user_id: staff.user_id, sender_kind: 'staff', status: 'accepted', key_id: 'KEY-1' },
  );
  const last = h.inbox.messagesFor('L-1').at(-1);
  assert.deepEqual(
    { key_id: last.key_id, jid: last.jid, direction: last.direction, sender_kind: last.sender_kind, sender_user_id: last.sender_user_id, text: last.text, ts: last.ts, status: last.status },
    { key_id: 'KEY-1', jid: CLIENT_JID, direction: 'out', sender_kind: 'staff', sender_user_id: staff.user_id, text: 'hello', ts: NOW, status: 'sent' },
  );
  const lead = h.s.getLead('L-1');
  assert.equal(lead.handler_user_id, staff.user_id, 'the first to reply becomes the handler');
  assert.equal(lead.first_reply_ts, NOW);
  assert.equal(lead.needs_human, 0);
  assert.equal(lead.last_msg_ts, NOW);
  h.s.close();
});

test('reply: an existing handler and an earlier first reply are left alone', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h, { handler_user_id: 'USR-other', first_reply_ts: NOW - 5_000 });
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true);
  const lead = h.s.getLead('L-1');
  assert.equal(lead.handler_user_id, 'USR-other');
  assert.equal(lead.first_reply_ts, NOW - 5_000);
  h.s.close();
});

test('reply: the text goes out trimmed, with browser line breaks made plain', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  assert.equal((await h.sender.reply(replyArgs(staff, { text: '  line one\r\nline two \r\n' }))).ok, true);
  assert.equal(h.calls[0].body.text, 'line one\nline two');
  assert.equal(h.inbox.getOutbox(SID).text, 'line one\nline two', 'the ledger holds what WhatsApp will hand back');
  h.s.close();
});

test('reply: bad_send_id for anything that is not a form send id', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  for (const sendId of [undefined, null, 42, '', 'short', 'has spaces in it 0123', 'x'.repeat(65), 'sid_<script>alert1']) {
    assert.deepEqual(await h.sender.reply(replyArgs(staff, { sendId })), { ok: false, error: 'bad_send_id' }, String(sendId));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  h.s.close();
});

test('reply: a double submit with the same send id makes one call and returns the first answer', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true);
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: true, duplicate: true, status: 'accepted', sendId: SID, error: null });
  assert.equal(h.calls.length, 1);
  assert.equal(h.inbox.messagesFor('L-1').filter((m) => m.direction === 'out').length, 1);
  h.s.close();
});

test('reply: two submits at once make one call; the second is told the first is on its way', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  const [first, second] = await Promise.all([h.sender.reply(replyArgs(staff)), h.sender.reply(replyArgs(staff))]);
  assert.deepEqual(first, { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-1' });
  assert.deepEqual(second, { ok: false, duplicate: true, status: 'pending', sendId: SID, error: 'pending', uncertain: true });
  assert.equal(h.calls.length, 1);
  h.s.close();
});

test('reply: an uncertain first attempt is never retried by a second submit', async () => {
  const h = harness({ reply: (n) => (n === 1 ? { status: 504 } : { status: 201, body: { key: { id: 'KEY-2' } } }) });
  const staff = staffOf(h);
  seedChat(h);
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'http_504', status: 'uncertain', sendId: SID, uncertain: true });
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, duplicate: true, status: 'uncertain', sendId: SID, error: 'http_504', uncertain: true });
  assert.equal(h.calls.length, 1, 'the second submit never reached the network');
  assert.equal(h.inbox.messagesFor('L-1').filter((m) => m.direction === 'out').length, 0, 'nothing stored: the poller decides once WhatsApp shows it');
  assert.equal(h.s.getLead('L-1').first_reply_ts, null);
  h.s.close();
});

test('reply: a send id reused on another chat or by another member is bad_send_id', async () => {
  const h = harness();
  const staff = staffOf(h);
  const other = h.team.addUser({ name: 'Omar', phone: '966500000088' });
  seedChat(h);
  seedChat(h, { lead_id: 'L-2', phone_e164: '966522222222', wa_jid: '966522222222@s.whatsapp.net' });
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true);
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { leadId: 'L-2' })), { ok: false, error: 'bad_send_id' });
  assert.deepEqual(await h.sender.reply(replyArgs(other)), { ok: false, error: 'bad_send_id' });
  assert.equal(h.calls.length, 1);
  h.s.close();
});

test('reply: bad_text for empty, blank, oversized or missing text — and nothing is written', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  for (const text of ['', '   \n\t ', 'a'.repeat(4097), undefined, null, 12]) {
    assert.deepEqual(await h.sender.reply(replyArgs(staff, { text })), { ok: false, error: 'bad_text' }, String(text).slice(0, 10));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  assert.equal((await h.sender.reply(replyArgs(staff, { text: 'a'.repeat(4096) }))).ok, true, '4096 exactly is fine');
  h.s.close();
});

test('reply: not_found, and not_in_inbox for an unsure, out or never-sorted chat', async () => {
  const h = harness();
  const staff = staffOf(h);
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { leadId: 'L-nope' })), { ok: false, error: 'not_found' });
  seedChat(h, { lead_id: 'L-u', inbox_state: 'unsure', phone_e164: '966522222201', wa_jid: '966522222201@s.whatsapp.net' });
  seedChat(h, { lead_id: 'L-o', inbox_state: 'out', phone_e164: '966522222202', wa_jid: '966522222202@s.whatsapp.net' });
  seedChat(h, { lead_id: 'L-n', inbox_state: null, phone_e164: '966522222203', wa_jid: '966522222203@s.whatsapp.net' });
  for (const leadId of ['L-u', 'L-o', 'L-n']) {
    assert.deepEqual(await h.sender.reply(replyArgs(staff, { leadId })), { ok: false, error: 'not_in_inbox' }, leadId);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  h.s.close();
});

test('reply: lid_only for a chat we only know by its lid ("reply from your phone")', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h, { phone_e164: null, wa_jid: null, wa_lid: '123456789012@lid' });
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'lid_only' });
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  h.s.close();
});

test('reply: excluded for a team number or a never-list number, even on an in chat', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h, { lead_id: 'L-t', phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net' });
  h.team.addNever({ phone: '966522222299' });
  seedChat(h, { lead_id: 'L-x', phone_e164: '966522222299', wa_jid: '966522222299@s.whatsapp.net' });
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { leadId: 'L-t' })), { ok: false, error: 'excluded' });
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { leadId: 'L-x' })), { ok: false, error: 'excluded' });
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  h.s.close();
});

test('reply: stale when a newer message exists (either direction) or the form did not say what it saw', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  h.inbox.upsertMessage({ key_id: 'OUT-phone', lead_id: 'L-1', jid: CLIENT_JID, direction: 'out', sender_kind: 'owner_number', text: 'on it', ts: NOW - 10_000 });
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'stale' }, 'the owner answered from his phone meanwhile');
  for (const seenTs of [undefined, null, NaN, String(NOW)]) {
    assert.deepEqual(await h.sender.reply(replyArgs(staff, { seenTs })), { ok: false, error: 'stale' }, String(seenTs));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  assert.equal((await h.sender.reply(replyArgs(staff, { seenTs: NOW - 10_000 }))).ok, true, 'having seen the newest, it goes');
  h.s.close();
});

test('reply: with the sending switch off nothing is sent and the row is closed as failed', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  h.team.setSetting('sending_enabled', '0');
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'sending_disabled', status: 'failed', sendId: SID });
  assert.equal(h.calls.length, 0);
  const row = h.inbox.getOutbox(SID);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'sending_disabled');
  const lead = h.s.getLead('L-1');
  assert.equal(lead.handler_user_id, null);
  assert.equal(lead.first_reply_ts, null);
  h.s.close();
});

test('reply: its own pending row is not counted twice against the day', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  seedOutbox(h, SEND_PER_DAY - 1);
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true, '499 before it: this one is the 500th');

  const full = harness();
  const staff2 = staffOf(full);
  seedChat(full);
  seedOutbox(full, SEND_PER_DAY);
  assert.deepEqual(await full.sender.reply(replyArgs(staff2)), { ok: false, error: 'rate_limited', status: 'failed', sendId: SID });
  assert.equal(full.inbox.getOutbox(SID).status, 'failed');
  assert.equal(full.calls.length, 0);
  h.s.close();
  full.s.close();
});

test('reply: once sent, a failure to record it still answers ok (saying otherwise would invite a second send)', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  const brittle = { ...h.inbox, upsertMessage: () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); } };
  const logs = [];
  const sender = createSender({
    env: ENV, team: h.team, inbox: brittle, db: h.s, now: h.now, log: (o) => logs.push(o),
    fetchImpl: async () => ({ ok: true, status: 201, text: async () => JSON.stringify({ key: { id: 'KEY-7' } }) }),
  });
  assert.deepEqual(await sender.reply(replyArgs(staff)), { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-7' });
  assert.equal(h.inbox.getOutbox(SID).status, 'accepted', 'the ledger already says it went');
  assert.ok(logs.some((l) => l.evt === 'wa.reply.record_failed'));
  assert.ok(!JSON.stringify(logs).includes('hello'), 'never logs the text');
  h.s.close();
});

test('reply: a chat marked "Not a client" while the message was on its way stays purged', async () => {
  let answer;
  const h = harness({ reply: () => new Promise((resolve) => { answer = resolve; }) });
  const staff = staffOf(h);
  seedChat(h);
  const sending = h.sender.reply(replyArgs(staff));
  assert.equal(h.calls.length, 1, 'the call is in flight and WhatsApp has not answered yet');
  // Meanwhile the owner presses *Not a client* (a never-list add does the same).
  h.inbox.leaveInbox('L-1');
  answer({ status: 201, body: { key: { id: 'KEY-1' } } });
  assert.deepEqual(await sending, { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-1' }, 'it did go: saying otherwise would invite a second send');
  assert.equal(h.inbox.hasMessages('L-1'), false, 'no transcript is started again for a purged chat');
  const lead = h.s.getLead('L-1');
  assert.equal(lead.inbox_state, 'out');
  assert.equal(lead.last_msg_ts, null);
  assert.equal(lead.handler_user_id, null, 'nobody is made handler of a chat that left the inbox');
  assert.equal(lead.needs_human, 0);
  assert.equal(lead.first_reply_ts, NOW, 'the client was still answered, and the watchdog must know');
  // A second submit of the same form is refused, never sent again.
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'not_in_inbox' });
  assert.equal(h.calls.length, 1);
  h.s.close();
});

test('reply: never logs the text or the number', async () => {
  const h = harness({ reply: () => ({ status: 500 }) });
  const staff = staffOf(h);
  seedChat(h);
  await h.sender.reply(replyArgs(staff, { text: 'secret-reply-marker' }));
  const logged = JSON.stringify(h.logs);
  assert.ok(!logged.includes('secret-reply-marker'));
  assert.ok(!logged.includes(CLIENT));
  h.s.close();
});

/* ------------------------------ after a restart ------------------------------ */

test('recoverInterrupted: a send pending for over two minutes becomes uncertain, nothing else changes', async () => {
  const h = harness();
  seedOutbox(h, 1, { created: NOW - 121_000, status: 'pending' });
  seedOutbox(h, 1, { created: NOW - 60_000, status: 'pending' });
  seedOutbox(h, 1, { created: NOW - 3_600_000, status: 'accepted' });
  assert.equal(h.sender.recoverInterrupted(), 1);
  const rows = outboxRows(h);
  assert.deepEqual(rows.map((r) => [r.status, r.error]), [['accepted', null], ['uncertain', 'interrupted'], ['pending', null]]);
  h.s.close();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/wa-send.test.mjs`
Expected: FAIL — the file does not load: `SyntaxError: The requested module '../lib/wa-send.mjs' does not provide an export named 'PER_USER_PER_MIN'` (`replyJidFor` is missing too, and `createSender` has no `reply`/`recoverInterrupted` yet). 0 of its tests run.

- [ ] **Step 3: Implement** — replace the whole of `services/api/lib/wa-send.mjs` with:

```js
/**
 * Messages from the owner's WhatsApp to anyone other than the owner (2026-09-27 design §4.5).
 *
 * Phase 1 sent only login codes to team members. Phase 2 adds team members' replies to
 * clients (`reply`, below); Phase 4 will add Dana. There is still exactly one sender —
 * `app.sender` (`createSender` in index.mjs) — because every message spends the same
 * thing, the standing of one personal number on WhatsApp, and the per-minute limits live
 * in this object's memory: a second instance would be a second, independent budget.
 * Every send passes the same gate:
 *
 *   - a 1:1 phone jid only (`…@s.whatsapp.net`, digits not starting with the local trunk
 *     `0`). A group, a broadcast, an `…@lid`, or a local-format number that never got
 *     turned into an international one, is refused: `lid` digits are an opaque id, not a
 *     phone number (see wa-poller.mjs).
 *   - a real `kind` — 'code' (a login code) or 'staff' (a team member's reply; 'dana' is
 *     refused until Phase 4 builds her own caps) — and a `text` that is a non-empty string
 *     of at most 4096 characters.
 *   - the owner's Sending switch (`settings.sending_enabled`). It is bypassed only when
 *     the recipient IS the owner's own jid (`cfg.ownerJid`) AND the message is a login
 *     `code` — `bypassSwitch` is a hint from the caller, never trusted on its own, because
 *     a caller that could bypass the switch for anyone else could use it to spam past the
 *     owner's own kill switch. Without this the owner could never get back in to switch
 *     sending back on.
 *   - 20 a minute across every sender, 6 a minute to any one recipient and 30 a minute
 *     from any one team member, all asked before any is charged (see lib/ratelimit.mjs
 *     `peek`), and 500 in any 24 hours, counted from the outbox (below) so that a restart
 *     cannot hand out a fresh day. Messages to the owner's own jid skip the shared
 *     per-minute and daily budget (still capped per-recipient), so a busy day of
 *     team-member codes cannot lock the owner out of logging in.
 *   - `BONA_WA_NOTIFY=0` (`cfg.enabled`) was built to stop the lead note (see
 *     services/README.md); a login `code` only needs Evolution to be configured
 *     (`baseUrl`/`apiKey`) — otherwise the owner could be locked out by an env var that was
 *     never about dashboard logins. Every other kind still needs it on.
 *
 * Every send that passes the gate is written to `wa_outbox` BEFORE the HTTP call, then
 * marked with what came back. A login code's row has no text (a code is never written
 * anywhere but the WhatsApp message) and no lead. The ledger is what makes the daily cap
 * survive a restart, what turns a send cut off by a crash into `uncertain` instead of
 * forgotten (`recoverInterrupted`), and what lets the poller tell a team member's reply
 * from the owner typing on his phone.
 *
 * A send is `accepted` only when the response is 2xx AND its body carries a `key.id`
 * string — the WhatsApp message id. Anything else (a non-2xx status, a 2xx with no id, a
 * timeout reading the body, or any other thrown error) is a failure we come back with
 * honestly: `uncertain` whenever the message might still have gone out. Only a handful of
 * pre-connection errors (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) are treated as
 * definitely-not-sent (`failed`). Nothing here retries, and a send id that has been
 * decided once is never sent again: the reply form carries a `send_id`, and a second
 * submit of it gets the first one's answer back — an `uncertain` one included.
 *
 * The owner's new-lead note to his own chat stays in lib/wa.mjs: that one is a message to
 * himself.
 */
import { createLimiter } from './ratelimit.mjs';
import { waConfig } from './wa.mjs';
import { newId } from './db.mjs';

export const SEND_PER_MIN = 20;
export const SEND_PER_DAY = 500;
export const PER_RECIPIENT_PER_MIN = 6;
export const PER_USER_PER_MIN = 30;
export const MAX_TEXT_LEN = 4096;
/** The kinds Phase 2 sends. Extend this, not the gate, when Phase 4 adds Dana. */
const VALID_KINDS = new Set(['code', 'staff']);
const PHONE_JID_RE = /^(\d{8,15})@s\.whatsapp\.net$/;
/** What the reply form's hidden `send_id` must look like; anything else is not ours. */
const SEND_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Failures we can be sure never reached the other side — no ambiguity, so not "uncertain". */
const DEFINITE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const DAY_MS = 86_400_000;
/** A send still `pending` this long after it was written was cut off by a restart. */
const INTERRUPTED_MS = 120_000;

/** Strip a jid's device suffix (`966…:12@s.whatsapp.net` → `966…@s.whatsapp.net`) before comparing. */
const bareDigits = (jid) => String(jid ?? '').replace(/@.*$/, '').replace(/:.*$/, '');

/**
 * Where a reply to this lead goes: its phone jid (device suffix stripped), else its
 * stored phone number as a jid — or null for a chat we only know by its `@lid`, which is
 * an opaque id, not a number (spec §4.5: "reply from your phone").
 * @param {object|null} lead
 * @returns {string|null}
 */
export function replyJidFor(lead) {
  const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(String(lead?.wa_jid ?? ''));
  if (m && !m[1].startsWith('0')) return `${m[1]}@s.whatsapp.net`;
  const phone = String(lead?.phone_e164 ?? '');
  return /^[1-9]\d{7,14}$/.test(phone) ? `${phone}@s.whatsapp.net` : null;
}

/**
 * @param {{ env?: object, team: ReturnType<import('./team.mjs').createTeam>,
 *           inbox: ReturnType<import('./inbox/store.mjs').createInboxStore>,
 *           db?: ReturnType<import('./db.mjs').openDb>|null,
 *           fetchImpl?: typeof globalThis.fetch, now?: () => number, log?: Function, timeoutMs?: number,
 *           limits?: { perMinute?: number, perUser?: number } }} o
 */
export function createSender({
  env = {}, team, inbox, db = null, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {}, timeoutMs = 8000, limits = {},
} = {}) {
  if (!team) throw new TypeError('createSender needs the team store (for the sending switch)');
  if (!inbox) throw new TypeError('createSender needs the inbox store (for the outbox and the daily cap)');
  const cfg = waConfig(env);
  const ownerDigits = bareDigits(cfg.ownerJid);
  // The outbox holds bare jids, so the owner's is compared in that form too.
  const ownerJid = ownerDigits ? `${ownerDigits}@s.whatsapp.net` : null;
  const perMinute = createLimiter({ capacity: limits.perMinute ?? SEND_PER_MIN, perMs: 60_000, now });
  const perRecipient = createLimiter({ capacity: PER_RECIPIENT_PER_MIN, perMs: 60_000, now });
  // With the shipped 20/min across everyone this cannot bind; it is here so that raising
  // the shared limit can never let one account alone send faster than this.
  const perUser = createLimiter({ capacity: limits.perUser ?? PER_USER_PER_MIN, perMs: 60_000, now });

  /** The HTTP call and nothing else: what came back, as honestly as we can tell. */
  async function post(number, text, kind) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/message/sendText/${encodeURIComponent(cfg.instance)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
          body: JSON.stringify({ number, text }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') {
          log({ level: 'warn', evt: 'wa.send.uncertain', kind, error: 'timeout' });
          return { ok: false, error: 'timeout', uncertain: true };
        }
        const definite = DEFINITE_NETWORK_CODES.has(err?.cause?.code);
        log({ level: 'warn', evt: definite ? 'wa.send.failed' : 'wa.send.uncertain', kind, error: 'network' });
        return definite ? { ok: false, error: 'network' } : { ok: false, error: 'network', uncertain: true };
      }

      if (!res.ok) {
        const uncertain = res.status === 502 || res.status === 504;
        log({ level: 'warn', evt: 'wa.send.failed', kind, status: res.status, uncertain: uncertain || undefined });
        return uncertain ? { ok: false, error: `http_${res.status}`, uncertain: true } : { ok: false, error: `http_${res.status}` };
      }

      let text2xx;
      try {
        text2xx = await res.text();
      } catch {
        // The send may well have gone through — we just could not read the ack.
        log({ level: 'warn', evt: 'wa.send.no_key', kind });
        return { ok: false, error: 'no_ack', uncertain: true };
      }
      let keyId = null;
      try {
        const body = JSON.parse(text2xx);
        keyId = typeof body?.key?.id === 'string' ? body.key.id : null;
      } catch { keyId = null; }
      if (typeof keyId !== 'string') {
        log({ level: 'warn', evt: 'wa.send.no_key', kind });
        return { ok: false, error: 'no_ack', uncertain: true };
      }
      log({ evt: 'wa.send.ok', kind });
      return { ok: true, keyId, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {{ jid: string, text: string, kind: 'code'|'staff', userId?: string|null, bypassSwitch?: boolean,
   *           leadId?: string|null, sendId?: string|null }} o
   * @returns {Promise<{ ok: true, keyId: string, status: number, sendId: string }
   *                 | { ok: false, error: string, uncertain?: true, sendId?: string }>}
   *   `sendId` is there whenever an outbox row stands behind the answer.
   */
  async function sendTo({ jid, text, kind, userId = null, bypassSwitch = false, leadId = null, sendId = null } = {}) {
    const given = sendId ? String(sendId) : null;
    const givenRow = given ? inbox.getOutbox(given) : null;
    // Decided once — accepted, failed, or perhaps delivered — so never sent a second time.
    if (givenRow && givenRow.status !== 'pending') return { ok: false, error: 'duplicate', sendId: given };
    // A refusal closes a row the caller already wrote, so it is never left `pending` —
    // which a restart would turn into "not sure it went" for a message that never left.
    const refuse = (error) => {
      if (givenRow) inbox.updateOutbox(given, { status: 'failed', error });
      return givenRow ? { ok: false, error, sendId: given } : { ok: false, error };
    };

    const m = PHONE_JID_RE.exec(String(jid ?? ''));
    if (!m || m[1].startsWith('0')) return refuse('bad_recipient');
    if (!VALID_KINDS.has(kind)) return refuse('bad_kind');
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LEN) return refuse('bad_text');

    const isOwner = m[1] === ownerDigits;
    // A caller's `bypassSwitch` is only ever honoured for the owner's own login code —
    // never trusted for anyone else, or it would be a way to spam past the kill switch.
    const bypassAllowed = bypassSwitch && kind === 'code' && isOwner;
    if (!bypassAllowed && !team.sendingEnabled()) return refuse('sending_disabled');
    // BONA_WA_NOTIFY only ever promised to stop the lead note (services/README.md); a
    // login code does not need it, or the owner could be locked out by an unrelated switch.
    if (kind !== 'code' && !cfg.enabled) return refuse('disabled');
    if (!cfg.baseUrl || !cfg.apiKey) return refuse('evolution-not-configured');

    const gates = isOwner
      ? [[perRecipient, `send:to:${m[1]}`]]
      : [[perMinute, 'send:minute'], [perRecipient, `send:to:${m[1]}`], ...(userId ? [[perUser, `send:user:${userId}`]] : [])];
    let dayFull = false;
    if (!isOwner) {
      const since = now() - DAY_MS;
      // The caller's own `pending` row is already in the count; it is this send, not an earlier one.
      const own = givenRow && givenRow.created >= since && givenRow.jid !== ownerJid ? 1 : 0;
      dayFull = inbox.countSentSince(since, { excludeJid: ownerJid }) - own >= SEND_PER_DAY;
    }
    if (dayFull || gates.some(([limiter, key]) => !limiter.peek(key).ok)) {
      log({ level: 'warn', evt: 'wa.send.rate_limited', kind, limit: dayFull ? 'day' : 'minute' });
      return refuse('rate_limited');
    }
    for (const [limiter, key] of gates) limiter.take(key);

    // Written before the call, so a crash in the middle leaves a trace (`recoverInterrupted`).
    const row = givenRow ?? inbox.insertOutbox({
      send_id: given ?? newId('SND'),
      lead_id: kind === 'code' ? null : leadId,
      jid: `${m[1]}@s.whatsapp.net`,
      text: kind === 'code' ? null : text,
      user_id: userId,
      sender_kind: kind,
    }).row;

    const out = await post(m[1], text, kind);
    if (out.ok) inbox.updateOutbox(row.send_id, { status: 'accepted', key_id: out.keyId });
    else inbox.updateOutbox(row.send_id, { status: out.uncertain ? 'uncertain' : 'failed', error: out.error });
    return { ...out, sendId: row.send_id };
  }

  /** A second submit of a send id gets the first one's answer — never a second message. */
  function answerFor(row, { leadId, userId }) {
    if (row.sender_kind !== 'staff' || row.lead_id !== String(leadId ?? '') || row.user_id !== (userId ?? null)) {
      return { ok: false, error: 'bad_send_id' };
    }
    const out = {
      ok: row.status === 'accepted',
      duplicate: true,
      status: row.status,
      sendId: row.send_id,
      error: row.status === 'accepted' ? null : (row.error ?? row.status),
    };
    // Still on its way, or perhaps delivered: the thread says "not sure it went — check WhatsApp".
    if (row.status === 'uncertain' || row.status === 'pending') out.uncertain = true;
    return out;
  }

  /**
   * A team member's reply from the inbox thread (spec §4.5). Every check that can refuse
   * runs before anything is written, in this order, so the answer names the first reason.
   * @param {{ sendId: string, leadId: string, userId: string, text: string, seenTs: number }} o
   * @returns {Promise<{ ok: true, status: 'accepted', sendId: string, keyId: string }
   *   | { ok: false, error: string, status?: string, sendId?: string, duplicate?: true, uncertain?: true }>}
   */
  async function reply({ sendId, leadId, userId, text, seenTs } = {}) {
    if (!db) throw new TypeError('reply needs the db store: pass `db` to createSender');
    if (typeof sendId !== 'string' || !SEND_ID_RE.test(sendId)) return { ok: false, error: 'bad_send_id' };
    const existing = inbox.getOutbox(sendId);
    if (existing) return answerFor(existing, { leadId, userId });

    // A browser posts a textarea's line breaks as CRLF; WhatsApp keeps LF. The outbox row
    // must hold exactly what WhatsApp will hand back, or the poller could not match it.
    const body = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
    if (!body || body.length > MAX_TEXT_LEN) return { ok: false, error: 'bad_text' };

    const lead = db.getLead(leadId);
    if (!lead) return { ok: false, error: 'not_found' };
    if (lead.inbox_state !== 'in') return { ok: false, error: 'not_in_inbox' };
    const jid = replyJidFor(lead);
    if (!jid) return { ok: false, error: 'lid_only' };
    if (team.isExcludedPhone(bareDigits(jid)) || (lead.phone_e164 && team.isExcludedPhone(lead.phone_e164))) {
      return { ok: false, error: 'excluded' };
    }
    // The form carries the newest message the writer saw. Anything newer, in either
    // direction, means they are answering a conversation that has moved on.
    const newest = inbox.newestTs(lead.lead_id);
    if (!Number.isFinite(seenTs) || (newest !== null && newest > seenTs)) return { ok: false, error: 'stale' };

    const ins = inbox.insertOutbox({
      send_id: sendId, lead_id: lead.lead_id, jid, text: body, user_id: userId ?? null, sender_kind: 'staff', status: 'pending',
    });
    if (!ins.inserted) return answerFor(ins.row, { leadId, userId });

    const out = await sendTo({ jid, text: body, kind: 'staff', userId: userId ?? null, leadId: lead.lead_id, sendId });
    if (!out.ok) {
      const res = { ok: false, error: out.error, status: out.uncertain ? 'uncertain' : 'failed', sendId };
      if (out.uncertain) res.uncertain = true;
      return res;
    }

    try {
      const t = now();
      db.transaction(() => {
        // Re-read: the lead may have changed while the message was on its way. If the owner
        // marked it *Not a client*, or put its number on the never list, its transcript was
        // purged on purpose — storing this reply would start a new one for a chat he just
        // threw out, so only an `in` chat gets the message, the handler and the flag.
        const fresh = db.getLead(lead.lead_id);
        if (fresh?.inbox_state === 'in') {
          inbox.upsertMessage({
            key_id: out.keyId, lead_id: lead.lead_id, jid, direction: 'out', sender_kind: 'staff',
            sender_user_id: userId ?? null, text: body, ts: t, status: 'sent',
          });
          if (!fresh.handler_user_id && userId) inbox.setHandler(lead.lead_id, userId);
          inbox.setNeedsHuman(lead.lead_id, 0);
        }
        // The client was answered either way. The Hermes `bona-unanswered-leads` watchdog
        // reads this column.
        if (fresh && fresh.first_reply_ts == null) db.updateLead(lead.lead_id, { first_reply_ts: t });
      });
    } catch (err) {
      // The message went. Saying otherwise would invite a second send; the poller stores
      // it from WhatsApp's own copy, matched to this row by its key.
      log({ level: 'error', evt: 'wa.reply.record_failed', error: err?.code ?? err?.name ?? 'error' });
    }
    return { ok: true, status: 'accepted', sendId, keyId: out.keyId };
  }

  /** On start-up: a send still `pending` after two minutes was cut off mid-flight. */
  const recoverInterrupted = () => inbox.markStalePending(now() - INTERRUPTED_MS);

  return { sendTo, reply, recoverInterrupted };
}
```

- [ ] **Step 4: Run the task tests**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/wa-send.test.mjs`
Expected: PASS — 49 tests, 0 fail.

- [ ] **Step 5: Hand the inbox store to the one sender** — two edits in `services/api/index.mjs`.

(a) Find:

```js
import { createSender } from './lib/wa-send.mjs';
```

Replace with:

```js
import { createSender } from './lib/wa-send.mjs';
import { createInboxStore } from './lib/inbox/store.mjs';
```

(b) Find:

```js
  // The ONE sender for messages from the owner's number to anyone else: its rate limits
  // live in memory, so a second instance would be a second, independent budget.
  const sender = options.sender ?? createSender({ env: cfg.env ?? {}, team, log });
```

Replace with:

```js
  // The Bona inbox tables (2026-09-27 design §4.2). The sender already needs them: every
  // send is written to the outbox first, and the daily cap is counted from it.
  const inboxStore = options.inboxStore ?? createInboxStore(db);
  // The ONE sender for messages from the owner's number to anyone else: its per-minute
  // limits live in memory, so a second instance would be a second, independent budget.
  const sender = options.sender ?? createSender({ env: cfg.env ?? {}, team, inbox: inboxStore, db, log });
```

(`sendCode` on the next line is unchanged: login codes still go through `sender.sendTo({ ...o, kind: 'code' })`, and now leave a text-less `code` row in the outbox.)

- [ ] **Step 6: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail — 31 more tests than after Task 6. (Had Step 5 been skipped, every test that builds the app through `createApp` — in `http`, `legacy` and `dashboard-routes` — would fail with `TypeError: createSender needs the inbox store (for the outbox and the daily cap)`.)

- [ ] **Step 7: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/wa-send.mjs services/api/index.mjs services/api/test/wa-send.test.mjs
git commit -m "wa-send: outbox ledger, durable day cap, per-user cap and staff replies

Every send that passes the gate is written to wa_outbox before the HTTP call
and marked accepted / uncertain / failed after it. The 500-a-day cap is now a
rolling 24 h count of that ledger (the owner's own jid excluded), so a restart
cannot hand out a fresh day. Adds kind 'staff' ('dana' still refused), a
30-a-minute cap per team member, reply() with send_id idempotency (a decided
send, uncertain included, is never sent again), phone-jid-only recipients
(lid-only chats refused), the exclusion and stale-view guards, and
recoverInterrupted() for sends a restart cut off. A reply that lands after
its chat was marked Not a client is not stored, so the purge stays a purge.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Leads — owner-started chats and certain enquiries join the inbox (`lib/leads.mjs`)

**Files:**
- Modify: `services/api/lib/leads.mjs`
- Test: `services/api/test/leads.test.mjs`

Contract P2-5 / P2-6. `OWNER_METHODS` chats are born `inbox_state='in'`, `first_inbound_ts=NULL`, `first_reply_ts=<creation ts>`, and never reach the ad fan-out queue; a later merge by an owner method never touches `first_inbound_ts`. Form and concierge leads are born `in`; a merge from one of those channels (or an owner method) lifts `NULL`/`unsure` to `in` and never touches `out`. A `whatsapp` channel call gets no state from here (the poller decides, Task 9). The new-lead note is not sent from here, so "no note for owner-started chats" is the poller's job (Task 9).

One rule on top of P2-5's birth values (it keeps them, and only acts on a later merge): an `owner_added` lead was only *vouched for*, so when that client's first own WhatsApp message merges in while `first_reply_ts` is still the add's own stamp (`=== created`), `first_reply_ts` goes back to NULL. The client is then in the waiting queue, so the Hermes `bona-unanswered-leads` watchdog sees an unanswered client, exactly as the merge rule "vouching is not answering" says. An `owner_outbound` lead keeps its stamp, because the owner really did write first and the client is answering him. **Owner report and memory file:** say that a chat added by number starts the reply clock at the client's first message after the add.

- [ ] **Step 1: Write the failing tests** — in `services/api/test/leads.test.mjs` make these two exact edits, then append the block below to the end of the file.

**Edit 1 — the import.** Replace:

```js
import { createOrMergeLead, leadNote, appendLead, CHANNELS, MATCH_METHODS } from '../lib/leads.mjs';
```

with:

```js
import { createOrMergeLead, leadNote, appendLead, CHANNELS, MATCH_METHODS, OWNER_METHODS } from '../lib/leads.mjs';
```

**Edit 2 — the vocabulary test.** Replace:

```js
  assert.deepEqual(MATCH_METHODS, ['ref', 'phone', 'keyword', 'time_window', 'concierge', 'form', 'ad_meta']);
});
```

with:

```js
  assert.deepEqual(MATCH_METHODS, ['ref', 'phone', 'keyword', 'time_window', 'concierge', 'form', 'ad_meta', 'owner_outbound', 'owner_added']);
  assert.deepEqual([...OWNER_METHODS], ['owner_outbound', 'owner_added']);
});
```

**Then append** to the end of `services/api/test/leads.test.mjs`:

```js
/* ---------------- the Bona inbox state (2026-09-28 plan P2-5, P2-6) ---------------- */

test('a chat the owner started is in the inbox from birth, already answered, and never reported as an ad lead', () => {
  const h = harness();
  const cases = [['owner_outbound', '0522222222', '966522222222@s.whatsapp.net'], ['owner_added', '0533333333', '966533333333@s.whatsapp.net']];
  for (const [matchMethod, phone, waJid] of cases) {
    const { lead, created } = createOrMergeLead(h.db, { phone, waJid }, { channel: 'whatsapp', matchMethod, now: NOW, dataDir: h.dataDir });
    assert.equal(created, true, matchMethod);
    assert.equal(lead.match_method, matchMethod);
    assert.equal(lead.channel, 'whatsapp');
    assert.equal(lead.inbox_state, 'in', `${matchMethod}: the owner already vouched for it`);
    assert.equal(lead.inbox_since, NOW);
    assert.equal(lead.first_inbound_ts, null, `${matchMethod}: the client has not written in — the owner did`);
    assert.equal(lead.first_reply_ts, NOW, `${matchMethod}: so nobody is waiting for a first reply`);
    assert.deepEqual(h.db.touchpointsForLead(lead.lead_id).map((t) => [t.event_type, t.meta.match_method]), [['lead_created', matchMethod]]);
  }
  assert.deepEqual(h.db.dueFanout(NOW + 1000), [], 'no click behind either, so the ad platforms hear nothing');
  assert.equal(h.db.fanoutCounts().pending, 0);
  assert.equal(h.db.countWaitingLeads(), 0, 'neither is in the waiting queue the Hermes watchdog reads');
  assert.equal(h.db.recentEvents({ name: 'lead_created' }).length, 2, 'each keeps its own history row; only the ad queue is skipped');
  assert.equal(h.jsonl().length, 2, 'both are still enquiries in the raw log');
  h.cleanup();
});

test('an owner method merging into a lead never moves when the client first wrote, and vouching is not answering', () => {
  const h = harness();
  const wrote = createOrMergeLead(h.db, { phone: '0500000010' }, { channel: 'whatsapp', matchMethod: 'keyword', now: NOW });
  assert.equal(wrote.lead.first_inbound_ts, NOW);
  const added = createOrMergeLead(h.db, { phone: '0500000010' }, { channel: 'whatsapp', matchMethod: 'owner_added', now: NOW + 5000 });
  assert.equal(added.created, false);
  assert.equal(added.lead.lead_id, wrote.lead.lead_id);
  assert.equal(added.lead.first_inbound_ts, NOW, "still measured from the client's own first message");
  assert.equal(added.lead.first_reply_ts, null, 'the owner vouching for a chat does not answer it');
  assert.equal(added.lead.inbox_state, 'in');
  assert.equal(added.lead.inbox_since, NOW + 5000);
  assert.deepEqual(h.db.touchpointsForLead(wrote.lead.lead_id).map((t) => t.event_type), ['lead_created', 'owner_contact'], 'the owner reaching out is not an inbound message');

  // A lead that never wrote in at all keeps no inbound time through an owner merge either.
  const form = createOrMergeLead(h.db, { phone: '0500000011' }, { channel: 'form', matchMethod: 'form', now: NOW });
  const reached = createOrMergeLead(h.db, { phone: '0500000011', waJid: '966500000011@s.whatsapp.net' }, { channel: 'whatsapp', matchMethod: 'owner_outbound', now: NOW + 1 });
  assert.equal(reached.lead.lead_id, form.lead.lead_id);
  assert.equal(reached.lead.first_inbound_ts, null);
  assert.equal(reached.lead.wa_jid, '966500000011@s.whatsapp.net', 'the merge still fills what is empty');
  assert.equal(h.db.fanoutCounts().pending, 8, 'only the two creations fanned out; the merges added nothing');
  h.cleanup();
});

test('a form or a concierge conversation is a certain enquiry: in the inbox the moment it exists', () => {
  const h = harness();
  for (const [channel, matchMethod, phone] of [['form', 'form', '0500000020'], ['concierge_chat', 'concierge', '0500000021'], ['concierge_voice', 'concierge', '0500000022']]) {
    const { lead } = createOrMergeLead(h.db, { phone }, { channel, matchMethod, now: NOW });
    assert.equal(lead.inbox_state, 'in', channel);
    assert.equal(lead.inbox_since, NOW, channel);
    assert.equal(lead.first_reply_ts, null, `${channel}: a real enquiry is still owed a reply`);
  }
  assert.equal(h.db.fanoutCounts().pending, 12, 'and each is still reported to the ad platforms');
  h.cleanup();
});

test('a form or concierge merge lifts a missing or unsure state to in, and never pulls a chat back from out', () => {
  const h = harness();
  const make = (phone, state) => {
    const { lead } = createOrMergeLead(h.db, { phone }, { channel: 'whatsapp', matchMethod: 'keyword', now: NOW });
    if (state) h.db.updateLead(lead.lead_id, { inbox_state: state, inbox_since: state === 'in' ? NOW : null });
    return lead.lead_id;
  };
  const none = make('0500000030', null);
  const unsure = make('0500000031', 'unsure');
  const out = make('0500000032', 'out');
  const already = make('0500000033', 'in');
  createOrMergeLead(h.db, { phone: '0500000030' }, { channel: 'form', matchMethod: 'form', now: NOW + 1000 });
  createOrMergeLead(h.db, { phone: '0500000031' }, { channel: 'concierge_chat', matchMethod: 'concierge', now: NOW + 1000 });
  createOrMergeLead(h.db, { phone: '0500000032' }, { channel: 'form', matchMethod: 'form', now: NOW + 1000 });
  createOrMergeLead(h.db, { phone: '0500000033' }, { channel: 'concierge_voice', matchMethod: 'concierge', now: NOW + 1000 });
  const state = (id) => { const l = h.db.getLead(id); return [l.inbox_state, l.inbox_since]; };
  assert.deepEqual(state(none), ['in', NOW + 1000]);
  assert.deepEqual(state(unsure), ['in', NOW + 1000]);
  assert.deepEqual(state(out), ['out', null], '"not a client" is the owner\'s word, and a form cannot overrule it');
  assert.deepEqual(state(already), ['in', NOW], 'already in: the date it joined stays');
  h.cleanup();
});

test('a WhatsApp message never decides the inbox here — the poller does — and neither does a manual lead', () => {
  const h = harness();
  ['ref', 'phone', 'keyword', 'time_window', 'ad_meta'].forEach((matchMethod, i) => {
    const { lead } = createOrMergeLead(h.db, { phone: `05000000${40 + i}` }, { channel: 'whatsapp', matchMethod, now: NOW });
    assert.deepEqual([lead.inbox_state, lead.inbox_since], [null, null], matchMethod);
  });
  const manual = createOrMergeLead(h.db, { phone: '0500000050' }, { channel: 'manual', now: NOW });
  assert.equal(manual.lead.inbox_state, null);

  const guessed = createOrMergeLead(h.db, { phone: '0500000051' }, { channel: 'whatsapp', matchMethod: 'keyword', now: NOW });
  h.db.updateLead(guessed.lead.lead_id, { inbox_state: 'unsure' });
  const again = createOrMergeLead(h.db, { phone: '0500000051' }, { channel: 'whatsapp', matchMethod: 'ref', ref: 'K7Q2XR', now: NOW + 1 });
  assert.equal(again.lead.inbox_state, 'unsure', 'even a Ref line merging here leaves the state to the poller');
  h.cleanup();
});

test('a number the owner only added is owed a reply once the client writes; a chat he opened by writing is not', () => {
  const h = harness();
  const added = createOrMergeLead(h.db, { phone: '0500000060', waJid: '966500000060@s.whatsapp.net' }, { channel: 'whatsapp', matchMethod: 'owner_added', now: NOW });
  const opened = createOrMergeLead(h.db, { phone: '0500000061', waJid: '966500000061@s.whatsapp.net' }, { channel: 'whatsapp', matchMethod: 'owner_outbound', now: NOW });
  assert.equal(h.db.countWaitingLeads(), 0, 'nobody has written in yet, so nobody is waiting');

  const wrote = createOrMergeLead(h.db, { phone: '0500000060' }, { channel: 'whatsapp', matchMethod: 'phone', now: NOW + 60_000 });
  assert.equal(wrote.lead.lead_id, added.lead.lead_id);
  assert.equal(wrote.lead.first_inbound_ts, NOW + 60_000);
  assert.equal(wrote.lead.first_reply_ts, null, 'adding a number is not answering it: the client\'s own message starts the clock');
  assert.equal(wrote.lead.inbox_state, 'in');

  const answered = createOrMergeLead(h.db, { phone: '0500000061' }, { channel: 'whatsapp', matchMethod: 'phone', now: NOW + 60_000 });
  assert.equal(answered.lead.lead_id, opened.lead.lead_id);
  assert.equal(answered.lead.first_inbound_ts, NOW + 60_000);
  assert.equal(answered.lead.first_reply_ts, NOW, 'the owner wrote first, so this client is answering him');

  assert.deepEqual(h.db.waitingLeads().map((l) => l.lead_id), [added.lead.lead_id], 'the Hermes watchdog reads this queue');
  assert.equal(h.db.countWaitingLeads(), 1);

  // Once somebody has answered, a later message never takes that answer back.
  h.db.updateLead(added.lead.lead_id, { first_reply_ts: NOW + 120_000 });
  const later = createOrMergeLead(h.db, { phone: '0500000060' }, { channel: 'whatsapp', matchMethod: 'phone', now: NOW + 180_000 });
  assert.equal(later.lead.first_reply_ts, NOW + 120_000);
  assert.equal(later.lead.first_inbound_ts, NOW + 60_000);
  assert.equal(h.db.countWaitingLeads(), 0);
  h.cleanup();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/leads.test.mjs`
Expected: FAIL — the file does not load: `SyntaxError: The requested module '../lib/leads.mjs' does not provide an export named 'OWNER_METHODS'`. (Adding only the export is not enough: the five inbox tests about owner methods, form/concierge creation and merges, and the reply clock of an added number then fail on their assertions. The last one fails on `first_reply_ts` until Edit 5's `owner_added` rule is in, and the others fail until Edits 4–7 are. The WhatsApp test already passes — it pins behaviour that must not change.)

- [ ] **Step 3: Implement** — in `services/api/lib/leads.mjs`, seven exact edits:

**Edit 1 — the vocabularies.** Replace:

```js
export const CHANNELS = ['whatsapp', 'form', 'concierge_chat', 'concierge_voice', 'manual'];
export const MATCH_METHODS = ['ref', 'phone', 'keyword', 'time_window', 'concierge', 'form', 'ad_meta'];
```

with:

```js
export const CHANNELS = ['whatsapp', 'form', 'concierge_chat', 'concierge_voice', 'manual'];
export const MATCH_METHODS = ['ref', 'phone', 'keyword', 'time_window', 'concierge', 'form', 'ad_meta', 'owner_outbound', 'owner_added'];
/**
 * Chats the owner started rather than the client: `owner_outbound` when the poller sees him
 * send a Bona link, brochure or listing number to a new number, `owner_added` when he adds a
 * number on the dashboard (2026-09-28 plan P2-5). No click is behind them, so the ad
 * platforms are never told; he has already written (or vouched), so nobody is waiting for a
 * first reply and the Hermes `bona-unanswered-leads` watchdog must not flag them. Vouching
 * is not answering, though: once an `owner_added` client writes in, the merge below opens
 * the reply clock again (an `owner_outbound` client is answering him, so it stays shut).
 */
export const OWNER_METHODS = new Set(['owner_outbound', 'owner_added']);
/** Channels whose every lead is a real enquiry, so it joins the Bona inbox at once (P2-6). */
const CERTAIN_CHANNELS = new Set(['form', 'concierge_chat', 'concierge_voice']);
```

**Edit 2 — the JSDoc of `createOrMergeLead`.** Replace:

```js
 *           matchMethod?: 'ref'|'phone'|'keyword'|'time_window'|'concierge'|'form'|'ad_meta',
```

with:

```js
 *           matchMethod?: 'ref'|'phone'|'keyword'|'time_window'|'concierge'|'form'|'ad_meta'|'owner_outbound'|'owner_added',
```

**Edit 3 — the end of that JSDoc.** Replace:

```js
 *   `raw` holds extra fields for the raw-log line only (e.g. the Retell conversation id).
 * @returns {{ lead: object, created: boolean }}
```

with:

```js
 *   `raw` holds extra fields for the raw-log line only (e.g. the Retell conversation id).
 *
 * The Bona inbox state is set here only where this call is certain (2026-09-28 plan P2-5,
 * P2-6): a form or concierge lead, and a chat the owner started, are `in`; a merge of one of
 * those lifts a missing or `unsure` state to `in` and never touches `out` — "not a client"
 * is the owner's word. A WhatsApp message gets no state from here: the poller judges those
 * (lib/inbox/eligibility.mjs).
 * @returns {{ lead: object, created: boolean }}
```

**Edit 4 — after the match method is resolved.** Replace:

```js
    : (channel === 'form' ? 'form' : channel.startsWith('concierge') ? 'concierge' : 'phone');

  const phone = normalisePhone(input.phone);
```

with:

```js
    : (channel === 'form' ? 'form' : channel.startsWith('concierge') ? 'concierge' : 'phone');
  const ownerStarted = OWNER_METHODS.has(matchMethod);
  const certain = ownerStarted || CERTAIN_CHANNELS.has(channel);

  const phone = normalisePhone(input.phone);
```

**Edit 5 — the merge.** Replace:

```js
      if (channel === 'whatsapp' && !existing.first_inbound_ts) patch.first_inbound_ts = now;
      db.updateLead(existing.lead_id, patch);
      db.addTouchpoint({
        lead_id: existing.lead_id, ts: now, channel, event_type: MERGE_EVENT[channel],
```

with:

```js
      // The owner writing to (or vouching for) a lead is not the client writing in: the
      // response clock starts only at the client's own first message.
      if (channel === 'whatsapp' && !ownerStarted && !existing.first_inbound_ts) {
        patch.first_inbound_ts = now;
        // A number the owner only added was born "answered" so it would not wait in the
        // queue before anyone had written. Now the client has: whatever was said before,
        // this message is owed a reply, and the Hermes watchdog has to be able to see it.
        // `first_reply_ts` still equal to `created` is the stamp the add itself left (a
        // real reply only ever fills an empty one), so it is the add's to take back.
        if (existing.match_method === 'owner_added' && existing.first_reply_ts === existing.created) patch.first_reply_ts = null;
      }
      if (certain && (existing.inbox_state == null || existing.inbox_state === 'unsure')) Object.assign(patch, { inbox_state: 'in', inbox_since: now });
      db.updateLead(existing.lead_id, patch);
      db.addTouchpoint({
        lead_id: existing.lead_id, ts: now, channel, event_type: ownerStarted ? 'owner_contact' : MERGE_EVENT[channel],
```

**Edit 6 — the insert.** Replace:

```js
      first_inbound_ts: channel === 'whatsapp' ? now : null, first_reply_ts: null, legacy_id: null,
      consent_ads: session?.consent_ads ?? 0, consent_analytics: session?.consent_analytics ?? 0,
    });
```

with:

```js
      first_inbound_ts: channel === 'whatsapp' && !ownerStarted ? now : null, first_reply_ts: ownerStarted ? now : null, legacy_id: null,
      consent_ads: session?.consent_ads ?? 0, consent_analytics: session?.consent_analytics ?? 0,
      inbox_state: certain ? 'in' : null, inbox_since: certain ? now : null,
    });
```

**Edit 7 — the fan-out.** Replace:

```js
    const browserEvent = meta.eventId ? db.getEvent(meta.eventId) : null;
    db.enqueueFanout(browserEvent ? meta.eventId : event.event_id, LEAD_FANOUT, { now });
```

with:

```js
    // An owner-started chat is not an ad conversion at all: nobody clicked anything, and
    // reporting it would credit a campaign that never reached this person. Its event row
    // above stays — it is the lead's own history — only the ad queue is skipped.
    const browserEvent = meta.eventId ? db.getEvent(meta.eventId) : null;
    if (!ownerStarted) db.enqueueFanout(browserEvent ? meta.eventId : event.event_id, LEAD_FANOUT, { now });
```

- [ ] **Step 4: Run**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/leads.test.mjs`
Expected: PASS (19 tests).

- [ ] **Step 5: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail. (Form and concierge leads created elsewhere in the suite — `http`, `tools`, `import-legacy`, the dashboard tests — are now born `inbox_state='in'`; no existing test asserts on that column.)

- [ ] **Step 6: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/leads.mjs services/api/test/leads.test.mjs
git commit -m "leads: owner-started chats and certain enquiries join the inbox

Owner-started chats (owner_outbound, owner_added) are born in the inbox,
already answered, with no inbound time and no ad fan-out. A number the
owner only added is owed a reply again once the client writes in. Form and
concierge leads are born in; their merges lift a missing or unsure state,
never out.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Poller — inbox states, owner-started joins, transcripts of `in` chats (`lib/wa-poller.mjs`)

**Files:**
- Modify: `services/api/lib/wa-poller.mjs`
- Test: `services/api/test/wa-poller.test.mjs`

`createPoller` gains `inboxStore`, `ingest` and `backfill` (all default `null`). With `ingest` null nothing below runs and the poller is the Phase 1 poller — every one of the 50 existing tests passes unchanged. The only changes visible without the inbox are the default reader (`readWindow`, Task 2), `missing` on `wa.poll.truncated`, and two zero tally fields (`stored`, `joined`). Per record, after the unchanged exclusions: inbound → `handleInbound` (unchanged, now also returning the lead) → `nextInboxState` → transition stored with `setInboxState(..., { since: ts })` → a fresh join awaits `backfill.history(lead, { sinceTs: ts - JOIN_HISTORY_MS, untilTs: ts })` (when that answers `{ error }`, a `wa_gaps` row `join:<leadId>:<ts>`, reason `history_failed`, goes just before the joining message and `inbox.join_history_failed` is logged; the joining message is then stored, so amendment A3's catch-up, which only picks chats with nothing stored, would never retry the history, and the gap is how the thread shows the loss) → an `in` lead gets `ingest`. Outbound → `recordReply` (unchanged: `first_reply_ts` is stamped exactly as before) → `in` lead: `ingest`; `out`: nothing; otherwise `ownerOutboundJoins` → create (`owner_outbound`, name null) or reuse the lead, `setInboxState('in')`, 24 h backfill, `ingest`, log `inbox.join`. A written-off record of an `in` chat → `addGap({ reason: 'failed' })`. `index.mjs` wiring is a later task.

- [ ] **Step 1: Write the failing tests** — in `services/api/test/wa-poller.test.mjs` make these four exact edits (imports, two harness helpers after `msg`, the opt-in inbox wiring of `harness`), then append the block below to the end of the file.

**Edit 1 — the imports.** Replace:

```js
import {
  CLICK_WINDOW_MS, FIRST_RUN_LOOKBACK_MS, MAX_RECORD_ATTEMPTS, MAX_WINDOW_MS, OVERLAP_MS,
  SEEN_TTL_MS, adMetaOf, adSourceOf, createPoller, isIgnorableChat, jidsOf,
} from '../lib/wa-poller.mjs';
```

with:

```js
import {
  CLICK_WINDOW_MS, FIRST_RUN_LOOKBACK_MS, MAX_RECORD_ATTEMPTS, MAX_WINDOW_MS, OVERLAP_MS,
  SEEN_TTL_MS, adMetaOf, adSourceOf, createPoller, isIgnorableChat, jidsOf,
} from '../lib/wa-poller.mjs';
import { JOIN_HISTORY_MS, createBackfill } from '../lib/inbox/backfill.mjs';
import { createIngest } from '../lib/inbox/ingest.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
```

**Edit 2 — the fixtures, right after `msg`.** Replace:

```js
  text: '', pushName: 'Sara', contextInfo: null, messageType: 'conversation', ...over,
});
```

with:

```js
  text: '', pushName: 'Sara', contextInfo: null, messageType: 'conversation', ...over,
});

/**
 * Evolution's per-chat read (`findMessages` with a `key` filter) over a fixed pool: the
 * `remoteJid` / `remoteJidAlt` filters and the time window honoured the way the live
 * instance honours them (2026-09-28 pre-work), newest first, paged by `offset`. `fail`
 * records the question and then throws, the way a read does while Evolution is down.
 */
function chatReader(pool, { fail = false } = {}) {
  const calls = [];
  const find = async ({ where = {}, page = 1, offset = 100 } = {}) => {
    calls.push({ where, page, offset });
    if (fail) throw new Error('connect ECONNREFUSED 127.0.0.1:8085');
    const key = where.key ?? {};
    const t = where.messageTimestamp ?? null;
    const hits = pool
      .filter((r) => (key.remoteJid === undefined || r.jid === key.remoteJid)
        && (key.remoteJidAlt === undefined || r.jidAlt === key.remoteJidAlt)
        && (!t || (r.ts >= Date.parse(t.gte) && r.ts <= Date.parse(t.lte))))
      .sort((a, b) => b.ts - a.ts);
    return { records: hits.slice((page - 1) * offset, page * offset), total: hits.length, pages: Math.max(1, Math.ceil(hits.length / offset)) };
  };
  return { calls, find };
}

/** The Bona inbox wired the way index.mjs wires it, with the owner seeded and the per-chat reader spied on. */
function inboxWiring({ db, history, historyFails = false, logs, now }) {
  const team = createTeam(db, { now });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const inbox = createInboxStore(db, { now });
  const log = (obj) => logs.push(obj);
  const ingestor = createIngest({ db, inbox, ownerUserId: () => owner.user_id, log, now });
  const ingest = (lead, rec) => ingestor.ingest(lead, rec);
  const reader = chatReader(history, { fail: historyFails });
  const backfill = createBackfill({ env: {}, db, ingest, find: reader.find, log, now });
  return { team, owner, inbox, ingest, backfill, findCalls: reader.calls };
}
```

**Edit 3 — the harness's comment and signature.** Replace:

```js
/**
 * A store with the visitor session behind Ref `K7Q2XR`, a poller wired to a queue of
 * windows (one per tick), and the owner's note sender recorded rather than sent.
 */
function harness({ windows = [], env = {}, seedSession = true, isExcluded } = {}) {
```

with:

```js
/**
 * A store with the visitor session behind Ref `K7Q2XR`, a poller wired to a queue of
 * windows (one per tick), and the owner's note sender recorded rather than sent.
 *
 * `inbox: true` also wires the Bona inbox (`inboxWiring` above): the real inbox store,
 * ingest and backfill over the same db, except that the backfill's per-chat reader is a
 * spy over `history`, so no test reaches Evolution; `historyFails` makes that reader throw,
 * as it does when Evolution is down. `ingestOverride` replaces only the poller's ingest
 * (the backfill keeps the real one), for a store that fails.
 */
function harness({ windows = [], env = {}, seedSession = true, isExcluded, inbox = false, history = [], historyFails = false, ingestOverride = null } = {}) {
```

**Edit 4 — the harness's poller and return value.** Replace:

```js
  let clock = NOW;
  const poller = createPoller({
    db,
    cfg: { env: { BONA_OWNER_JID: OWNER, ...env }, siteUrl: 'https://bona-real-estate.com', dataDir, waPollMs: 0 },
    findMessages: async (window) => { asked.push(window); return { records: queue.length ? queue.shift() : [] }; },
    sendWhatsApp: async (text) => { sent.push(text); return { ok: true }; },
    ...(isExcluded ? { isExcluded } : {}),
    log: (obj) => logs.push(obj),
    now: () => clock,
  });
  return {
    db, poller, asked, sent, logs, dataDir,
```

with:

```js
  let clock = NOW;
  const wiring = inbox ? inboxWiring({ db, history, historyFails, logs, now: () => clock }) : null;
  const poller = createPoller({
    db,
    cfg: { env: { BONA_OWNER_JID: OWNER, ...env }, siteUrl: 'https://bona-real-estate.com', dataDir, waPollMs: 0 },
    findMessages: async (window) => { asked.push(window); return { records: queue.length ? queue.shift() : [] }; },
    sendWhatsApp: async (text) => { sent.push(text); return { ok: true }; },
    ...(isExcluded ? { isExcluded } : {}),
    ...(wiring ? { inboxStore: wiring.inbox, ingest: ingestOverride ?? wiring.ingest, backfill: wiring.backfill } : {}),
    log: (obj) => logs.push(obj),
    now: () => clock,
  });
  return {
    db, poller, asked, sent, logs, dataDir,
    inbox: wiring?.inbox ?? null, team: wiring?.team ?? null, owner: wiring?.owner ?? null, findCalls: wiring?.findCalls ?? [],
```

**Then append** to the end of `services/api/test/wa-poller.test.mjs`:

```js
/* ---------------- (l) the default reader trusts the size Evolution states ---------------- */

test('(l) one full page that says it is the whole window is read once, not paged to the cap', async () => {
  const db = openDb(':memory:');
  const logs = [];
  const poller = createPoller({
    db,
    cfg: { env: { EVOLUTION_API_URL: 'https://wa-api.example', EVOLUTION_API_KEY: 'evo-key', BONA_OWNER_JID: OWNER } },
    log: (o) => logs.push(o),
    now: () => NOW,
  });
  const page = Array.from({ length: 100 }, (_, i) => wire({ key: { id: `P${i}`, fromMe: false, remoteJid: SENDER }, message: { conversation: 'hi' } }));
  await withStubbedFetch({ messages: { total: 100, pages: 1, currentPage: 1, records: page } }, async (calls) => {
    const tally = await poller.tick();
    assert.equal(calls.length, 1, 'total says 100 on one page, so there is no page 2 to ask for');
    assert.equal(tally.scanned, 100);
  });
  assert.equal(logs.some((l) => l.evt === 'wa.poll.truncated'), false);
  db.close();
});

test('a truncated window says how many messages it could not read', async () => {
  const db = openDb(':memory:');
  const logs = [];
  const poller = createPoller({
    db,
    cfg: { env: { BONA_OWNER_JID: OWNER } },
    findMessages: async () => ({ records: [msg({ text: 'hi' })], truncated: true, missing: 42 }),
    log: (o) => logs.push(o),
    now: () => NOW,
  });
  await poller.tick();
  const warned = logs.find((l) => l.evt === 'wa.poll.truncated');
  assert.equal(warned.level, 'warn');
  assert.equal(warned.missing, 42);
  db.close();
});

/* ---------------- (t) the Bona inbox (2026-09-27 design §4) ---------------- */

const iso = (ms) => new Date(ms).toISOString();
const STRANGER = '966522222222@s.whatsapp.net';
const STRANGER2 = '966533333333@s.whatsapp.net';
/** A chat's stored transcript, oldest first, as [id, direction, sender]. */
const rows = (h, leadId) => h.inbox.messagesFor(leadId).map((m) => [m.key_id, m.direction, m.sender_kind]);
/** Every per-chat read the backfill made asked for exactly the 24 h before the join. */
function assertHistoryWindow(h, joinTs) {
  assert.ok(h.findCalls.length > 0, 'the history before the join was asked for');
  for (const c of h.findCalls) assert.deepEqual(c.where.messageTimestamp, { gte: iso(joinTs - JOIN_HISTORY_MS), lte: iso(joinTs) });
}
/** A lead already in the inbox, as a certain match (or the migration) would have left it. */
const seedInLead = (h, over = {}) => h.db.insertLead({
  lead_id: 'LEAD-in', phone_e164: '966500000000', wa_jid: SENDER, inbox_state: 'in', inbox_since: NOW - 3_600_000,
  created: NOW - 3_600_000, updated: NOW - 3_600_000, ...over,
});

test('(t) with no inbox wired the poller stays the Phase 1 poller: no state, no transcript', async () => {
  const h = harness({ windows: [[
    msg({ text: 'Ref BONA-W003 · K7Q2XR' }),
    msg({ id: 'OUT', fromMe: true, ts: NOW - 30_000, pushName: null, text: 'Ahlan!' }),
  ]] });
  const tally = await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.inbox_state, null);
  assert.equal(lead.first_reply_ts, NOW - 30_000);
  assert.equal(createInboxStore(h.db).hasMessages(lead.lead_id), false);
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 0, stored: 0 });
  h.cleanup();
});

test('(t) an inbox ingest without the inbox store is a wiring mistake, refused at once', () => {
  const db = openDb(':memory:');
  assert.throws(() => createPoller({ db, ingest: () => ({ stored: false }) }), TypeError);
  db.close();
});

test('(t) a Ref line puts the chat in the inbox: stored, with the 24 h before it', async () => {
  const hi = msg({ id: 'HI', ts: NOW - 3_600_000, text: 'Hi' });
  const ref = msg({ id: 'REF', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' });
  const h = harness({ inbox: true, history: [hi, ref], windows: [[ref]] });
  const tally = await h.poller.tick();

  const [lead] = h.leads();
  assert.equal(lead.inbox_state, 'in');
  assert.equal(lead.inbox_since, NOW - 60_000, 'in since the message that joined it');
  assertHistoryWindow(h, NOW - 60_000);
  assert.deepEqual(rows(h, lead.lead_id), [['HI', 'in', 'client'], ['REF', 'in', 'client']], 'the "Hi" before the Ref line is there too, and nothing twice');
  assert.deepEqual(h.inbox.gapsFor(lead.lead_id), [], 'a history that was read leaves no gap');
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 1, stored: 1 });
  assert.equal(h.sent.length, 1, 'a client-started lead still tells the owner');
  const joined = h.logs.find((l) => l.evt === 'inbox.join');
  assert.equal(joined.leadId, lead.lead_id);
  assert.equal(joined.via, 'inbound');
  h.cleanup();
});

test('(t) the word "bona" alone is a guess: the Unsure list, nothing stored, no history pulled', async () => {
  const h = harness({ inbox: true, windows: [[msg({ text: 'مرحبا بونا، عندكم شقق في الشاطئ؟' })]] });
  const tally = await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'keyword', 'still a lead, for the stats');
  assert.equal(lead.inbox_state, 'unsure');
  assert.equal(lead.inbox_since, null);
  assert.equal(h.inbox.hasMessages(lead.lead_id), false);
  assert.equal(h.findCalls.length, 0);
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 0, stored: 0 });
  h.cleanup();
});

test('(t) a join whose history Evolution cannot give leaves a gap where that history belongs, and keeps the joining message', async () => {
  const hi = msg({ id: 'HI', ts: NOW - 3_600_000, text: 'Hi' });
  const ref = msg({ id: 'REF', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' });
  const h = harness({ inbox: true, history: [hi, ref], historyFails: true, windows: [[ref]] });
  const tally = await h.poller.tick();

  const [lead] = h.leads();
  assert.equal(lead.inbox_state, 'in');
  assert.equal(tally.joined, 1);
  assert.ok(h.findCalls.length > 0, 'the history was asked for');
  assert.deepEqual(rows(h, lead.lead_id), [['REF', 'in', 'client']], 'the joining message is kept; the "Hi" before it could not be read');
  assert.deepEqual(h.inbox.gapsFor(lead.lead_id).map((g) => [g.key_id, g.lead_id, g.jid, g.ts, g.reason]), [
    [`join:${lead.lead_id}:${NOW - 60_000}`, lead.lead_id, null, NOW - 60_001, 'history_failed'],
  ], 'the chat now has a message, so the daily catch-up will not ask again: the thread has to say what is missing, just before the joining message');
  const warned = h.logs.find((l) => l.evt === 'inbox.join_history_failed');
  assert.deepEqual([warned.level, warned.leadId, warned.error], ['warn', lead.lead_id, 'failed']);
  assert.equal(JSON.stringify(h.logs).includes('966500000000'), false, 'no number in any log line');
  h.cleanup();
});

test('(t) a listing id is certain: in, and stored', async () => {
  const h = harness({ inbox: true, windows: [[msg({ text: 'BONA-W012 السعر؟' })]] });
  await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'keyword');
  assert.equal(lead.inbox_state, 'in');
  assert.deepEqual(rows(h, lead.lead_id), [['KEY1', 'in', 'client']]);
  h.cleanup();
});

test('(t) a click-window match is a guess too: Unsure, nothing stored', async () => {
  const h = harness({ inbox: true, windows: [[msg({ text: 'مرحبا' })]] });
  h.db.upsertSession({ session_id: 'clk1-9zad', anon_id: ANON2, started: NOW - 700_000, last_seen: NOW - 300_000, pages: 2, locale: 'ar' });
  h.db.insertEvent({ event_id: 'ev-click-1', ts: NOW - 300_000, name: 'whatsapp_click', anon_id: ANON2, session_id: 'clk1-9zad', listing_id: 'BONA-W007' });
  await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'time_window');
  assert.equal(lead.inbox_state, 'unsure');
  assert.equal(h.inbox.hasMessages(lead.lead_id), false);
  h.cleanup();
});

test('(t) an Unsure chat that later sends a Ref line joins, and its earlier messages come with it', async () => {
  const guess = msg({ id: 'W1', ts: NOW - 120_000, text: 'مرحبا بونا' });
  const ref = msg({ id: 'W2', ts: NOW - 30_000, text: 'Ref BONA-W003 · K7Q2XR' });
  const h = harness({ inbox: true, history: [guess, ref], windows: [[guess], [ref]] });
  await h.poller.tick();
  const [before] = h.leads();
  assert.equal(before.inbox_state, 'unsure');
  assert.equal(h.inbox.hasMessages(before.lead_id), false);

  const tally = await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.inbox_state, 'in');
  assert.equal(lead.inbox_since, NOW - 30_000);
  assert.equal(tally.joined, 1);
  assertHistoryWindow(h, NOW - 30_000);
  assert.deepEqual(rows(h, lead.lead_id), [['W1', 'in', 'client'], ['W2', 'in', 'client']], 'the message the poller already saw as a guess is pulled back in');
  h.cleanup();
});

test('(t) an out chat never comes back on its own — not on a Ref line, not on a Bona link', async () => {
  const h = harness({ inbox: true });
  seedInLead(h, { lead_id: 'LEAD-out', inbox_state: 'out', inbox_since: null });
  h.push([
    msg({ id: 'O-IN', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' }),
    msg({ id: 'O-OUT', fromMe: true, ts: NOW - 30_000, pushName: null, text: 'https://bona-real-estate.com/properties/bona-w003/' }),
  ]);
  const tally = await h.poller.tick();
  assert.equal(h.db.getLead('LEAD-out').inbox_state, 'out');
  assert.equal(h.inbox.hasMessages('LEAD-out'), false);
  assert.equal(h.findCalls.length, 0);
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 0, stored: 0 });
  h.cleanup();
});

test("(t) an in chat is stored both ways; the owner's own reply is 'owner_number', makes him the handler, and still stops the clock", async () => {
  const h = harness({ inbox: true, windows: [
    [msg({ id: 'IN1', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' })],
    [
      msg({ id: 'IN2', ts: NOW - 50_000, text: 'أي جديد؟' }),
      msg({ id: 'OUT1', fromMe: true, ts: NOW - 40_000, pushName: 'Abdulaziz', text: 'Ahlan! Let me check.' }),
    ],
  ] });
  await h.poller.tick();
  const second = await h.poller.tick();
  assert.equal(second.replies, 1);
  assert.equal(second.stored, 2);
  const [lead] = h.leads();
  assert.equal(lead.first_reply_ts, NOW - 40_000, 'the reply clock stops exactly as before — the Hermes watchdog reads it');
  assert.equal(lead.handler_user_id, h.owner.user_id, 'his number answered first, so the chat is his until someone takes it');
  assert.deepEqual(h.inbox.messagesFor(lead.lead_id).map((m) => [m.key_id, m.direction, m.sender_kind, m.text]), [
    ['IN1', 'in', 'client', 'Ref BONA-W003 · K7Q2XR'],
    ['IN2', 'in', 'client', 'أي جديد؟'],
    ['OUT1', 'out', 'owner_number', 'Ahlan! Let me check.'],
  ]);
  h.cleanup();
});

test('(t) a Bona link the owner sends to a stranger starts a chat: in, no note, already answered, no ad fan-out', async () => {
  const opener = msg({ id: 'OPEN', fromMe: true, jid: STRANGER, pushName: 'Abdulaziz', ts: NOW - 600_000, text: 'Salam, this is Abdulaziz from Bona' });
  const link = msg({ id: 'LINK', fromMe: true, jid: STRANGER, pushName: 'Abdulaziz', ts: NOW - 60_000, text: 'Here it is: https://bona-real-estate.com/properties/bona-w003/' });
  const h = harness({ inbox: true, history: [opener, link], windows: [[link]] });
  const tally = await h.poller.tick();

  const [lead] = h.leads();
  assert.equal(lead.match_method, 'owner_outbound');
  assert.equal(lead.channel, 'whatsapp');
  assert.equal(lead.phone_e164, '966522222222');
  assert.equal(lead.name, null, "a fromMe pushName is the owner's own, never the client's");
  assert.equal(lead.listing_id, 'BONA-W003');
  assert.equal(lead.inbox_state, 'in');
  assert.equal(lead.inbox_since, NOW - 60_000);
  assert.equal(lead.first_inbound_ts, null);
  assert.equal(lead.first_reply_ts, NOW - 60_000, 'he wrote first, so nobody is waiting on him');
  assert.equal(lead.handler_user_id, h.owner.user_id);
  assert.equal(h.db.countWaitingLeads(), 0);
  assert.equal(h.sent.length, 0, 'no new-lead note: the owner started this chat himself');
  assert.deepEqual(h.db.dueFanout(NOW + 1000), [], 'no click behind it, so the ad platforms hear nothing');
  assertHistoryWindow(h, NOW - 60_000);
  assert.deepEqual(rows(h, lead.lead_id), [['OPEN', 'out', 'owner_number'], ['LINK', 'out', 'owner_number']], 'his opening line comes with it');
  assert.equal(tally.joined, 1);
  const joined = h.logs.find((l) => l.evt === 'inbox.join');
  assert.deepEqual({ leadId: joined.leadId, via: joined.via, created: joined.created }, { leadId: lead.lead_id, via: 'owner_outbound', created: true });
  h.cleanup();
});

test('(t) nothing else the owner types to a stranger counts — not chat, not even the word Bona', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'P1', fromMe: true, jid: STRANGER, pushName: null, text: 'see you at 6' }),
    msg({ id: 'P2', fromMe: true, jid: STRANGER2, pushName: null, ts: NOW - 30_000, text: 'I work at Bona now' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 0);
  assert.equal(h.findCalls.length, 0);
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 0, stored: 0 });
  h.cleanup();
});

test('(t) a Bona brochure the owner sends starts a chat; a file that only looks like one does not', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'DOC', fromMe: true, jid: STRANGER, pushName: null, messageType: 'documentMessage', media: '[document: Bona Brochure.pdf]', fileName: 'Bona Brochure.pdf' }),
    msg({ id: 'NOTDOC', fromMe: true, jid: STRANGER2, pushName: null, ts: NOW - 30_000, messageType: 'documentMessage', media: '[document: Bonanza menu.pdf]', fileName: 'Bonanza menu.pdf' }),
  ]] });
  await h.poller.tick();
  assert.equal(h.db.countLeads(), 1);
  const [lead] = h.leads();
  assert.equal(lead.phone_e164, '966522222222');
  assert.equal(lead.match_method, 'owner_outbound');
  assert.equal(lead.inbox_state, 'in');
  assert.deepEqual(h.inbox.messagesFor(lead.lead_id).map((m) => [m.key_id, m.direction, m.sender_kind, m.text, m.media_type]), [
    ['DOC', 'out', 'owner_number', null, '[document: Bona Brochure.pdf]'],
  ]);
  h.cleanup();
});

test("(t) an outbound record carrying our own outbox row's WhatsApp id is the staff member's, not the owner's", async () => {
  const h = harness({ inbox: true, windows: [[msg({ id: 'IN1', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' })]] });
  await h.poller.tick();
  const [lead] = h.leads();
  const mona = h.team.addUser({ name: 'Mona', phone: '0511112222', role: 'staff' });
  h.inbox.insertOutbox({ send_id: 'SND-test-0001', lead_id: lead.lead_id, jid: SENDER, text: 'Welcome to Bona', user_id: mona.user_id, sender_kind: 'staff' });
  h.inbox.updateOutbox('SND-test-0001', { status: 'accepted', key_id: 'K-STAFF' });
  h.push([msg({ id: 'K-STAFF', fromMe: true, ts: NOW - 30_000, pushName: null, text: 'Welcome to Bona' })]);

  const tally = await h.poller.tick();
  assert.equal(tally.stored, 1);
  const row = h.inbox.messagesFor(lead.lead_id).find((m) => m.key_id === 'K-STAFF');
  assert.equal(row.direction, 'out');
  assert.equal(row.sender_kind, 'staff');
  assert.equal(row.sender_user_id, mona.user_id);
  assert.equal(h.db.getLead(lead.lead_id).first_reply_ts, NOW - 30_000, 'a staff reply stops the clock too');
  h.cleanup();
});

test('(t) a team or never-list number is never stored, even when its lead is in the inbox', async () => {
  const h = harness({ inbox: true, isExcluded: (digits) => digits === '966500000000' });
  seedInLead(h);
  h.push([
    msg({ id: 'X-IN', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' }),
    msg({ id: 'X-OUT', fromMe: true, ts: NOW - 30_000, pushName: null, text: 'https://bona-real-estate.com/properties/bona-w003/' }),
  ]);
  const tally = await h.poller.tick();
  assert.equal(tally.ignored, 2);
  assert.equal(tally.stored, 0);
  assert.equal(h.inbox.hasMessages('LEAD-in'), false);
  assert.equal(h.findCalls.length, 0);
  h.cleanup();
});

test('(t) a record of an in chat that is written off leaves a gap in the thread, not silence', async () => {
  const h = harness({ inbox: true, ingestOverride: () => { throw new Error('disk I/O error'); } });
  seedInLead(h);
  const bad = msg({ id: 'BAD', ts: NOW - 60_000, text: 'أي جديد؟' });
  for (let i = 1; i <= MAX_RECORD_ATTEMPTS; i += 1) {
    h.push([bad]);
    await h.poller.tick(); // eslint-disable-line no-await-in-loop
    if (i < MAX_RECORD_ATTEMPTS) assert.deepEqual(h.inbox.gapsFor('LEAD-in'), [], 'while it is still owed a retry it is not a gap');
  }
  assert.equal(h.logs.filter((l) => l.evt === 'wa.poll.record_failed').at(-1).writtenOff, true);
  assert.deepEqual(h.inbox.gapsFor('LEAD-in').map((g) => [g.key_id, g.lead_id, g.jid, g.ts, g.reason]), [['BAD', 'LEAD-in', SENDER, NOW - 60_000, 'failed']]);
  assert.equal(h.inbox.hasMessages('LEAD-in'), false);
  h.cleanup();
});

test('(t) the inbox never puts a number, a name or a message into a log line', async () => {
  const lid = '272516946294519@lid';
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'L-IN', jid: lid, jidAlt: SENDER, ts: NOW - 90_000, text: 'Hi there, Ref BONA-W003 · K7Q2XR' }),
    msg({ id: 'L-OUT', jid: lid, jidAlt: SENDER, fromMe: true, pushName: 'Abdulaziz', ts: NOW - 60_000, text: 'Ahlan Sara, sending photos' }),
    msg({ id: 'S-OUT', fromMe: true, jid: STRANGER, pushName: 'Abdulaziz', ts: NOW - 30_000, text: 'Here it is: https://bona-real-estate.com/properties/bona-w003/' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(tally.joined, 2, 'both kinds of join happened, so both kinds of log line were written');
  assert.equal(tally.stored, 3);
  const dump = JSON.stringify(h.logs);
  for (const secret of ['966500000000', '966522222222', '272516946294519', 'Hi there', 'Ahlan', 'Here it is', 'Sara', 'Abdulaziz']) {
    assert.ok(!dump.includes(secret), `a log line carries ${secret}`);
  }
  h.cleanup();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/wa-poller.test.mjs`
Expected: FAIL — 19 of 69 tests fail, the 19 new ones: the tally has no `stored`/`joined`, `createPoller` ignores `inboxStore`/`ingest`/`backfill` (so no state is set, nothing is stored, no history is asked for, no owner-started lead is created, no gap row is written, neither for a written-off record nor for a join whose history read failed, and no `TypeError` is thrown), the default reader (`fetchWindow`) pages a full page all the way to the 5-page cap, and `wa.poll.truncated` carries no `missing`. The 50 existing tests pass.

- [ ] **Step 3: Implement** — in `services/api/lib/wa-poller.mjs`, twelve exact edits:

**Edit 1 — the end of the module header, and the imports.** Replace:

```js
 * Anything else — the owner's private conversations, which this loop can also see — is
 * discarded in memory. It is counted (`status().unmatched`) and never written to disk,
 * never logged, never sent anywhere. For the same reason nothing here logs a phone
 * number, a name or message text.
 */
import { parseRef } from './attribution.mjs';
import { MAX_PAGES, PAGE_SIZE, bareJid, fetchWindow, oldestFirst } from './evolution.mjs';
import { createOrMergeLead, leadNote } from './leads.mjs';
```

with:

```js
 * Anything else — the owner's private conversations, which this loop can also see — is
 * discarded in memory. It is counted (`status().unmatched`) and never written to disk,
 * never logged, never sent anywhere. For the same reason nothing here logs a phone
 * number, a name or message text.
 *
 * **The Bona inbox** (2026-09-27 design §4). Wired only when `ingest` is passed; without it
 * this loop is exactly the matched-only poller described above. With it, a lead also
 * carries an inbox state, judged by lib/inbox/eligibility.mjs: a certain signal on an
 * inbound message (a Ref code, ad context, a listing id) puts the chat `in`; a guess (the
 * word "bona", the click window) puts it on the owner's Unsure list; the owner's own
 * message puts a chat `in` only when it carries a Bona link, a listing number or a Bona
 * brochure (D12 — TK and private chats share this number, so nothing else he types
 * counts). Only `in` chats are kept as transcripts (lib/inbox/ingest.mjs), both directions,
 * from the joining message plus the 24 h before it. An `out` chat never comes back on its
 * own. Every other conversation is still discarded exactly as above.
 */
import { parseRef } from './attribution.mjs';
import { MAX_PAGES, PAGE_SIZE, bareJid, oldestFirst, readWindow } from './evolution.mjs';
import { JOIN_HISTORY_MS } from './inbox/backfill.mjs';
import { inboundSignal, nextInboxState, ownerOutboundJoins } from './inbox/eligibility.mjs';
import { createOrMergeLead, leadNote } from './leads.mjs';
```

**Edit 2 — the `MAX_WINDOW_MS` comment.** Replace:

```js
 * says `wa.poll.truncated` if the gap holds more messages than the page cap can read.
```

with:

```js
 * says `wa.poll.truncated` if even `readWindow`'s time-splitting cannot read the whole gap.
```

**Edit 3 — the `findMessages` JSDoc line.** Replace:

```js
 *        injected in tests; defaults to `fetchWindow()` against the instance in `cfg.env`
```

with:

```js
 *        injected in tests; defaults to `readWindow()` against the instance in `cfg.env`,
 *        which splits a window too crowded to read in one go (lib/evolution.mjs)
```

**Edit 4 — the end of the JSDoc and the signature.** Replace:

```js
 * @param {(obj: object) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createPoller({
  db, cfg = {}, findMessages = null, sendWhatsApp = null, isExcluded = NO_EXCLUSIONS, log = () => {}, now = () => Date.now(),
} = {}) {
```

with:

```js
 * @param {(obj: object) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {ReturnType<import('./inbox/store.mjs').createInboxStore>} [o.inboxStore]
 *        inbox states and gaps; required whenever `ingest` is given
 * @param {((lead: object, rec: object) => object) | { ingest: Function }} [o.ingest]
 *        lib/inbox/ingest.mjs: stores one record of an `in` chat. Null (older wiring and
 *        every Phase 1 test) means no inbox at all — the poller behaves exactly as before.
 * @param {ReturnType<import('./inbox/backfill.mjs').createBackfill>} [o.backfill]
 *        pulls the 24 h before a join; without it a join stores from its own message on
 */
export function createPoller({
  db, cfg = {}, findMessages = null, sendWhatsApp = null, isExcluded = NO_EXCLUSIONS, log = () => {}, now = () => Date.now(),
  inboxStore = null, ingest = null, backfill = null,
} = {}) {
  // `createIngest()` hands back `{ ingest }`; the bare function is accepted as well.
  const ingestOne = typeof ingest === 'function' ? ingest : (typeof ingest?.ingest === 'function' ? ingest.ingest : null);
  const inboxOn = Boolean(ingestOne);
  if (inboxOn && !inboxStore) throw new TypeError('createPoller: an inbox ingest needs the inbox store (for states and gaps)');
```

**Edit 5 — the default reader.** Replace:

```js
  const find = findMessages ?? (({ gte, lte }) => fetchWindow({
    baseUrl: wa.baseUrl, apiKey: wa.apiKey, instance, gte, lte, offset: PAGE_SIZE, maxPages: MAX_PAGES,
  }));
```

with:

```js
  const find = findMessages ?? (({ gte, lte }) => readWindow({
    baseUrl: wa.baseUrl, apiKey: wa.apiKey, instance, gte, lte, offset: PAGE_SIZE, maxPages: MAX_PAGES,
  }));
```

**Edit 6 — what `handleInbound` returns.** Replace:

```js
    return { method: match.method, created };
```

with:

```js
    return { method: match.method, created, lead: fresh };
```

**Edit 7 — a new section right before the tick.** Replace:

```js
  /* -------------------- the tick -------------------- */
```

with:

```js
  /* -------------------- the Bona inbox -------------------- */

  /** One record into the transcript of an `in` chat, the lead read fresh (a backfill may just have filled its jids). */
  async function storeRecord(leadId, rec, tally) {
    const res = await ingestOne(db.getLead(leadId), rec);
    if (res?.stored) tally.stored += 1;
  }

  /**
   * A chat that has just joined: its state first — ingest refuses anything that is not
   * `in`, so the history below would otherwise be thrown away — then the 24 h before the
   * joining message, where the "Hi" before a Ref line or the owner's opening words live
   * (design §4.1). Counts only in the log line: never a number or a name.
   *
   * A history Evolution could not give us (`{ error }`) is not dropped silently (design
   * §4.3): the joining message is about to be stored, so the chat is no longer one the
   * daily catch-up asks again for (it only picks chats with nothing stored). A gap just
   * before the joining message makes the thread say "a message could not be loaded —
   * check WhatsApp" where that history belongs.
   */
  async function join(leadId, ts, via, tally, extra = {}) {
    inboxStore.setInboxState(leadId, 'in', { since: ts });
    if (backfill) {
      const got = await backfill.history(db.getLead(leadId), { sinceTs: ts - JOIN_HISTORY_MS, untilTs: ts });
      if (got?.error) {
        inboxStore.addGap({ key_id: `join:${leadId}:${ts}`, lead_id: leadId, ts: ts - 1, reason: 'history_failed' });
        log({ level: 'warn', evt: 'inbox.join_history_failed', leadId, error: got.error });
      }
    }
    tally.joined += 1;
    log({ evt: 'inbox.join', leadId, via, ...extra });
  }

  /**
   * What an inbound message means for the inbox, once `handleInbound` has matched it. A
   * certain signal puts the chat `in`, a guess puts it on the Unsure list, and `in`/`out`
   * never move from here (lib/inbox/eligibility.mjs `nextInboxState`). Unsure keeps
   * nothing: a guessed chat is never stored or shown until the owner moves it in.
   */
  async function inboxAfterInbound(rec, ts, { lead, method }, tally) {
    const text = typeof rec.text === 'string' ? rec.text : '';
    const signal = inboundSignal({ text, hasAdMeta: Boolean(adMetaOf(rec.contextInfo)) });
    const next = nextInboxState(lead.inbox_state, { signal, method });
    if (next === 'in' && lead.inbox_state !== 'in') await join(lead.lead_id, ts, 'inbound', tally);
    else if (next && next !== lead.inbox_state) inboxStore.setInboxState(lead.lead_id, next, { since: ts });
    if (next === 'in') await storeRecord(lead.lead_id, rec, tally);
  }

  /**
   * What the owner's own message means for the inbox, once `recordReply` has stamped the
   * reply clock exactly as before (the Hermes `bona-unanswered-leads` watchdog reads
   * `first_reply_ts`). In an `in` chat it is stored: typed on his phone or sent by Lisa,
   * which nothing can tell apart, unless lib/inbox/ingest.mjs finds our own dashboard send
   * in the outbox. An `out` chat never comes back on its own. Any other chat joins only on
   * a Bona link, a listing number or a Bona brochure (D12). A stranger he writes to that
   * way becomes an `owner_outbound` lead — no ad fan-out and no new-lead note, because he
   * started it (lib/leads.mjs `OWNER_METHODS`) — with no name: a `fromMe` record's
   * pushName is his own.
   */
  async function inboxAfterOutbound(rec, ts, tally) {
    const jids = jidsOf(rec);
    let lead = findLead(jids);
    if (lead?.inbox_state === 'out') return;
    if (lead?.inbox_state !== 'in') {
      const text = typeof rec.text === 'string' ? rec.text : '';
      const fileName = typeof rec.fileName === 'string' ? rec.fileName : null;
      if (!ownerOutboundJoins({ text, fileName, media: rec.media ?? null })) return;
      let created = false;
      if (!lead) {
        ({ lead, created } = createOrMergeLead(db, {
          name: null, phone: jids.phone, waJid: jids.waJid, waLid: jids.waLid,
          listingId: listingIdIn(`${text} ${fileName ?? ''}`),
        }, { channel: 'whatsapp', matchMethod: 'owner_outbound', now: ts, dataDir: cfg.dataDir ?? undefined }));
      }
      await join(lead.lead_id, ts, 'owner_outbound', tally, { created });
    }
    await storeRecord(lead.lead_id, rec, tally);
  }

  /**
   * A record of an `in` chat that has failed for the last time is not dropped silently
   * (design §4.2): its id, chat and time go to `wa_gaps`, and the thread shows "a message
   * could not be loaded — check WhatsApp" in its place. Never the text. Called from the
   * per-record `catch`, so nothing in here may throw.
   */
  function recordGapSafely(rec, ts) {
    if (!inboxOn) return;
    try {
      const lead = findLead(jidsOf(rec));
      if (lead?.inbox_state === 'in') inboxStore.addGap({ key_id: rec.id, lead_id: lead.lead_id, jid: rec.jid ?? null, ts, reason: 'failed' });
    } catch (err) {
      log({ level: 'warn', evt: 'inbox.gap_failed', error: String(err?.message ?? err) });
    }
  }

  /* -------------------- the tick -------------------- */
```

**Edit 8 — the tally.** Replace:

```js
      const tally = { scanned: records.length, matched: 0, unmatched: 0, created: 0, merged: 0, replies: 0, ignored: 0, lidOnlyUnexcludable: 0 };
```

with:

```js
      const tally = { scanned: records.length, matched: 0, unmatched: 0, created: 0, merged: 0, replies: 0, ignored: 0, lidOnlyUnexcludable: 0, stored: 0, joined: 0 };
```

**Edit 9 — the per-record handling.** Replace:

```js
        try {
          if (rec.fromMe) {
            if (recordReply(rec, ts)) tally.replies += 1;
          } else {
            const out = await handleInbound(rec, ts);
            if (!out) tally.unmatched += 1;
            else {
              tally.matched += 1;
              if (out.created) tally.created += 1; else tally.merged += 1;
            }
          }
```

with:

```js
        try {
          if (rec.fromMe) {
            if (recordReply(rec, ts)) tally.replies += 1;
            if (inboxOn) await inboxAfterOutbound(rec, ts, tally);
          } else {
            const out = await handleInbound(rec, ts);
            if (!out) tally.unmatched += 1;
            else {
              tally.matched += 1;
              if (out.created) tally.created += 1; else tally.merged += 1;
              if (inboxOn) await inboxAfterInbound(rec, ts, out, tally);
            }
          }
```

**Edit 10 — the write-off.** Replace:

```js
          if (writtenOff) {
            db.waSeenAdd(rec.id, ts);
            failures.delete(rec.id);
          } else {
```

with:

```js
          if (writtenOff) {
            db.waSeenAdd(rec.id, ts);
            failures.delete(rec.id);
            recordGapSafely(rec, ts);
          } else {
```

**Edit 11 — the truncation warning.** Replace:

```js
      // Newest-first paging means a window that overflowed the page cap hides its OLDEST
      // messages, and asking again returns the same newest ones — so this is a loss, and
      // it says so. It takes downtime long enough for 500 messages to pile up.
      if (answer?.truncated) log({ level: 'warn', evt: 'wa.poll.truncated', scanned: records.length, gte, lte });
```

with:

```js
      // `readWindow` splits a crowded window by time until every piece fits the page cap, so
      // this now takes a piece still over the cap at the deepest split — thousands of
      // messages inside a few minutes. Newest-first paging hides that piece's OLDEST
      // messages and asking again returns the same newest ones, so this is a loss, and it
      // says so, with how many it could not read (`missing`, from Evolution's own `total`).
      if (answer?.truncated) log({ level: 'warn', evt: 'wa.poll.truncated', scanned: records.length, missing: Number.isFinite(answer.missing) ? answer.missing : null, gte, lte });
```

**Edit 12 — the tick log.** Replace:

```js
      if (tally.matched || tally.replies) log({ evt: 'wa.poll.tick', ...tally });
```

with:

```js
      if (tally.matched || tally.replies || tally.stored || tally.joined) log({ evt: 'wa.poll.tick', ...tally });
```

- [ ] **Step 4: Run**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/wa-poller.test.mjs`
Expected: PASS (69 tests).

- [ ] **Step 5: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail. (`http.test.mjs` builds the poller with no Evolution credentials, so the new default reader is never reached there. `wa-poller.mjs` now imports `inbox/backfill.mjs` and `inbox/eligibility.mjs`, and `inbox/ingest.mjs` imports `jidsOf` from `wa-poller.mjs`; if `backfill.mjs` also imports from `wa-poller.mjs` that is an ES module cycle, which stays safe because each side reads the other's exports only inside functions, never while loading.)

- [ ] **Step 6: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/wa-poller.mjs services/api/test/wa-poller.test.mjs
git commit -m "wa-poller: inbox states, owner-started joins, transcripts of in chats

Certain inbound signals put a chat in the inbox (with the 24 h before the
join), guesses go to Unsure, out chats never come back on their own. The
owner's Bona link, listing number or brochure to a stranger starts an
owner_outbound chat with no note and no ad fan-out. In chats are stored both
ways; first_reply_ts is stamped exactly as before. Written-off records of in
chats, and a join whose history read failed, become wa_gaps rows; the
default reader is readWindow and a truncated
window logs how many messages it missed. Without an ingest wired the poller
is unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Inbox screens — `render-inbox.mjs`, the Inbox rail entry, lead-page inbox controls, audit actions

The three inbox screens as pure render functions (called directly by the tests; Task 12's routes call them), the rail's Inbox entry with the viewer's own unread count, the lead page's inbox state and buttons, the inbox error copy, and the five inbox audit actions. Server-rendered, no script (CSP `default-src 'none'`), every value through `esc`, names in `<bdi>`, masked numbers in both lists, the whole number only on the thread header.

Form fields this task fixes, which Task 12's routes must read:

| Form | `action` | Fields |
|---|---|---|
| Reply | `POST /v1/admin/inbox/:leadId/reply` | `_dash=1`, `send_id`, `seen_ts`, `text` (textarea, `maxlength` = `MAX_TEXT_LEN` 4096) |
| Handler picker | `POST /v1/admin/inbox/:leadId/handler` | `_dash=1`, `user_id` (`''` = Nobody; options = active users only) |
| Move to Bona inbox | `POST /v1/admin/inbox/:leadId/move` | `_dash=1` |
| Not a client | `POST /v1/admin/inbox/:leadId/out` | `_dash=1` |
| Add chat by phone number | `POST /v1/admin/inbox/add` | `_dash=1`, `phone` |

Lead ids are `encodeURIComponent`-ed before they become a path segment (same rule as the Team page's user ids). No existing test asserts the `NAV` entries or the `MESSAGES` keys (checked with `grep -rn "NAV\|MESSAGES" services/api/test/`); the rail assertions in `dashboard-render-team.test.mjs` and `dashboard-routes.test.mjs` check the signed-in name and the absence of the Team link for staff, and both still hold, so no existing test changes.

**Files:**
- Create: `services/api/lib/dashboard/render-inbox.mjs`
- Modify: `services/api/lib/dashboard/render.mjs`
- Modify: `services/api/lib/audit.mjs`
- Test: `services/api/test/dashboard-render-inbox.test.mjs` (create)
- Test: `services/api/test/team.test.mjs` (one audit test added)

- [ ] **Step 1: Write the failing tests** — create `services/api/test/dashboard-render-inbox.test.mjs`:

```js
/**
 * The inbox screens, rendered directly: the chat list, the owner's Unsure list, one
 * thread, and the inbox parts of the rail and the lead page. Every value that came from
 * a client or a team member is hostile until escaped; a list never shows a whole number;
 * an owner-only control never reaches a staff page, not even as a link.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, loginPage, leadDetailPage, knownError, NAV } from '../lib/dashboard/render.mjs';
import { inboxPage, unsurePage, threadPage, INBOX_OK } from '../lib/dashboard/render-inbox.mjs';

const NOW = 1_790_500_000_000;
const HOUR = 3_600_000;
const EVIL = '<img src=x onerror=alert(1)>';

const OWNER = { user_id: 'USR-o', name: 'Abdulaziz Zidan', role: 'owner', phone_e164: '966593296933', active: 1, created: 1 };
const STAFF = { user_id: 'USR-s', name: 'Sara', role: 'staff', phone_e164: '966500000001', active: 1, created: 1 };
const GONE = { user_id: 'USR-g', name: 'Omar Old', role: 'staff', phone_e164: '966500000003', active: 0, created: 1 };
const USERS = [OWNER, STAFF, GONE];

const LEAD = {
  lead_id: 'LEAD-20260928-aaaa0001', name: 'Mona', phone_e164: '966512345678',
  wa_jid: '966512345678@s.whatsapp.net', wa_lid: '111222333@lid', stage: 'new', match_method: 'ad_meta',
  inbox_state: 'in', inbox_since: NOW - 48 * HOUR, handler_user_id: null, needs_human: 0,
  last_msg_ts: NOW - HOUR, created: NOW - 48 * HOUR, stage_ts: NOW - 48 * HOUR, channel: 'whatsapp',
};

const row = (over = {}) => ({
  ...LEAD, unread: 0, last_text: null, last_media: null, last_direction: 'in', last_sender_kind: 'client', handler_name: null, ...over,
});

const msg = (over = {}) => ({
  key_id: 'K1', lead_id: LEAD.lead_id, jid: LEAD.wa_lid, direction: 'in', sender_kind: 'client',
  sender_user_id: null, text: 'hello', media_type: null, ts: NOW - 2 * HOUR, status: null, ...over,
});

const thread = (over = {}) => threadPage({
  me: OWNER, lead: LEAD, messages: [], gaps: [], outbox: [], users: USERS,
  sendId: 'SND-abcdefghijklmnop', seenTs: NOW - HOUR, sendingEnabled: true, canReply: true, now: NOW, ...over,
});

/* ---------------- the rail ---------------- */

test('the rail has an Inbox entry right after Desk, with the viewer\'s own unread count, and still no Team link for staff', () => {
  assert.deepEqual(NAV.slice(0, 2).map(([href, label]) => [href, label]), [['/dashboard', 'Desk'], ['/dashboard/inbox', 'Inbox']]);

  const staff = layout({ title: 'Desk', body: '', me: { ...STAFF, unread: 3 } });
  assert.match(staff, /Desk<\/a><a class="it" href="\/dashboard\/inbox">/);
  assert.match(staff, /Inbox<span class="c">3<\/span><\/a>/);
  assert.doesNotMatch(staff, /href="\/dashboard\/team"/);

  const none = layout({ title: 'Desk', body: '', me: { ...STAFF, unread: 0 } });
  assert.match(none, /Inbox<\/a>/, 'nothing unread: no number at all, not a 0');

  const owner = layout({ title: 'Desk', body: '', me: { ...OWNER, unread: 2 } });
  assert.match(owner, /Inbox<span class="c">2<\/span><\/a>/);
  assert.match(owner, /href="\/dashboard\/team"/);

  const explicit = layout({ title: 'Inbox', body: '', me: { ...STAFF, unread: 3 }, counts: { '/dashboard/inbox': 9 } });
  assert.match(explicit, /Inbox<span class="c">9<\/span><\/a>/, 'a count the page passes itself wins');
});

test('the inbox error codes are real messages, and the login page shows none of them', () => {
  for (const code of ['stale', 'lid_only', 'not_in_inbox', 'excluded', 'sending_disabled', 'send_uncertain',
    'bad_text', 'bad_send_id', 'bad_handler', 'reply_rate_limited', 'not_a_chat']) {
    assert.equal(knownError(code), code, code);
    assert.doesNotMatch(loginPage({ step: 'request', error: code }), /class="err"/, code);
  }
});

/* ---------------- the chat list ---------------- */

test('the chat list: escaped names in bdi, masked numbers, last message, time, stage, handler, unread and Needs a human', () => {
  const html = inboxPage({
    me: STAFF,
    now: NOW,
    rows: [
      row({ name: EVIL, unread: 2, needs_human: 1, last_text: 'x'.repeat(100), handler_name: 'Sara <b>' }),
      row({ lead_id: 'LEAD-20260928-aaaa0002', name: 'Khalid', phone_e164: '966598765432', stage: 'viewing',
        last_media: '[voice note]', last_direction: 'out', last_sender_kind: 'staff', last_msg_ts: NOW - 3 * HOUR }),
      row({ lead_id: 'LEAD-20260928-aaaa0003', name: null, phone_e164: null, wa_jid: null, last_text: 'السلام <script>',
        last_direction: 'out', last_sender_kind: 'dana' }),
    ],
  });
  assert.ok(!html.includes('<img'), 'a name is text, never markup');
  assert.ok(!html.includes('<script'), 'a message is text, never markup');
  assert.match(html, /<bdi>&lt;img src=x onerror=alert\(1\)&gt;<\/bdi>/);
  assert.match(html, /…5678/);
  assert.match(html, /…5432/);
  assert.doesNotMatch(html, /966512345678|966598765432|\+966 51/, 'a list never shows a whole number');
  assert.ok(html.includes(`${'x'.repeat(80)}…`), 'the last message is cut at 80 characters');
  assert.ok(!html.includes('x'.repeat(81)));
  assert.match(html, /Bona: \[voice note\]/, 'a media message shows its placeholder, and our side is marked');
  assert.match(html, /Dana: السلام &lt;script&gt;/);
  assert.match(html, /<span>1\sh<\/span>/, 'time since the last message');
  assert.match(html, /<span>3\sh<\/span>/);
  assert.match(html, /<span class="pl gold">2 new<\/span>/);
  assert.match(html, /<span class="pl hot">Needs a human<\/span>/);
  assert.equal(html.match(/Needs a human/g).length, 1, 'only the chat that needs one');
  assert.match(html, /<span class="pl done">New<\/span>/);
  assert.match(html, /<span class="pl done">Viewing<\/span>/);
  assert.match(html, /Handler: <bdi>Sara &lt;b&gt;<\/bdi>/);
  assert.match(html, /No handler/);
  assert.match(html, /<bdi>Unnamed<\/bdi>/);
  assert.match(html, /href="\/dashboard\/inbox\/LEAD-20260928-aaaa0001"/);
  assert.match(html, /href="\/dashboard\/inbox\/LEAD-20260928-aaaa0002"/);
  assert.match(html, /3 chats, 1 with new messages/);
  assert.ok(!/<script/i.test(html));
});

test('only the owner sees the Unsure tab, its count and "Add chat by phone number"', () => {
  const owner = inboxPage({ me: OWNER, rows: [row()], unsureCount: 4, now: NOW });
  assert.match(owner, /<a class="on" href="\/dashboard\/inbox">Inbox<\/a><a href="\/dashboard\/inbox\?tab=unsure">Unsure · 4<\/a>/);
  assert.match(owner, /action="\/v1\/admin\/inbox\/add"/);
  assert.match(owner, /<input type="hidden" name="_dash" value="1">/);
  assert.match(owner, /name="phone" inputmode="tel"/);

  const staff = inboxPage({ me: STAFF, rows: [row()], unsureCount: 4, now: NOW });
  assert.doesNotMatch(staff, /tab=unsure/);
  assert.doesNotMatch(staff, /Unsure/);
  assert.doesNotMatch(staff, /\/v1\/admin\/inbox\/add/);
  assert.doesNotMatch(staff, /href="\/dashboard\/team"/);
});

test('an empty inbox says so, and a banner shows only for a code it knows', () => {
  const empty = inboxPage({ me: STAFF, rows: [], now: NOW });
  assert.match(empty, /No chats in the Bona inbox yet/);

  assert.ok(inboxPage({ me: OWNER, rows: [], ok: 'added', now: NOW }).includes(`<div class="ok">${INBOX_OK.added}</div>`));
  assert.match(inboxPage({ me: OWNER, rows: [], error: 'not_a_chat', now: NOW }), /<div class="err">That lead has no WhatsApp chat yet/);
  const odd = inboxPage({ me: OWNER, rows: [], ok: 'constructor', error: 'toString', now: NOW });
  assert.doesNotMatch(odd, /class="ok"|class="err"/, 'a prototype name is not a message');
});

/* ---------------- Unsure ---------------- */

test('the Unsure list: escaped snippet, masked number, why it is unsure, and the two decisions', () => {
  const html = unsurePage({
    me: OWNER,
    now: NOW,
    rows: [
      { ...LEAD, inbox_state: 'unsure', match_method: 'keyword', name: 'Ali', snippet: 'is bona <b>real</b>?' },
      { ...LEAD, lead_id: 'LEAD/1?x=1', inbox_state: null, match_method: 'time_window', name: EVIL, snippet: null },
    ],
  });
  assert.match(html, /is bona &lt;b&gt;real&lt;\/b&gt;\?/);
  assert.ok(!html.includes('<b>real</b>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /…5678/);
  assert.doesNotMatch(html, /966512345678/);
  assert.match(html, /wrote the word “bona”/);
  assert.match(html, /wrote within 15 minutes of a tap on the site/);
  assert.match(html, /action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/move"/);
  assert.match(html, /action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/out"/);
  assert.match(html, />Move to Bona inbox<\/button>/);
  assert.match(html, />Not a client<\/button>/);
  assert.match(html, /action="\/v1\/admin\/inbox\/LEAD%2F1%3Fx%3D1\/move"/, 'an odd id stays one path segment');
  assert.doesNotMatch(html, /action="\/v1\/admin\/inbox\/LEAD\/1/);
  assert.match(html, /<a href="\/dashboard\/inbox">Inbox<\/a><a class="on" href="\/dashboard\/inbox\?tab=unsure">Unsure · 2<\/a>/);
  assert.match(unsurePage({ me: OWNER, rows: [], now: NOW }), /Nothing to decide/);
});

/* ---------------- one chat ---------------- */

test('a thread: client bubbles left, ours right, each labelled; media shows its placeholder and caption', () => {
  const messages = [
    msg({ key_id: 'K1', text: `hi ${EVIL}`, ts: NOW - 5 * HOUR }),
    msg({ key_id: 'K2', direction: 'out', sender_kind: 'owner_number', text: 'Welcome', ts: NOW - 4 * HOUR }),
    msg({ key_id: 'K3', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-s', text: 'Here is the villa', ts: NOW - 3 * HOUR }),
    msg({ key_id: 'K4', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-g', text: 'Old reply', ts: NOW - 170 * 60_000 }),
    msg({ key_id: 'K5', direction: 'out', sender_kind: 'dana', text: 'Dana here', ts: NOW - 160 * 60_000 }),
    msg({ key_id: 'K6', media_type: '[image]', text: 'the view', ts: NOW - 150 * 60_000 }),
    msg({ key_id: 'K7', media_type: '[document: <b>plan</b>.pdf]', text: null, ts: NOW - 140 * 60_000 }),
    msg({ key_id: 'K8', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-unknown', text: 'who?', ts: NOW - 130 * 60_000 }),
  ];
  const html = thread({ messages });
  assert.ok(!html.includes('<img'), 'message text is escaped');
  assert.ok(!html.includes('<b>plan</b>'), 'a file name is escaped');
  assert.match(html, /\[document: &lt;b&gt;plan&lt;\/b&gt;\.pdf\]/);
  assert.match(html, /<div class="bub in"><span class="who"><bdi>Client<\/bdi><\/span><div class="tx" dir="auto">hi &lt;img/);
  assert.match(html, /<div class="bub out"><span class="who"><bdi>Your number<\/bdi><\/span><div class="tx" dir="auto">Welcome/);
  assert.match(html, /<div class="bub out"><span class="who"><bdi>Sara<\/bdi><\/span><div class="tx" dir="auto">Here is the villa/);
  assert.match(html, /<bdi>Omar Old<\/bdi><\/span><div class="tx" dir="auto">Old reply/, 'a reply keeps its author after they leave');
  assert.match(html, /<div class="bub out"><span class="who"><bdi>Dana<\/bdi><\/span>/);
  assert.match(html, /<bdi>Team<\/bdi><\/span><div class="tx" dir="auto">who\?/, 'an author we cannot name is still "Team"');
  assert.match(html, /<span class="md">\[image\]<\/span><div class="tx" dir="auto">the view<\/div>/);
  assert.ok(html.indexOf('K1') === -1, 'no WhatsApp message id is printed');
  assert.ok(html.indexOf('hi &lt;img') < html.indexOf('Welcome') && html.indexOf('Welcome') < html.indexOf('Here is the villa'), 'oldest first');

  const asStaff = thread({ me: STAFF, messages });
  assert.match(asStaff, /<bdi>Owner&#39;s number<\/bdi>/);
  assert.doesNotMatch(asStaff, /Your number/);
});

test('the thread header shows the whole number, the stage, the handler and a link to the lead', () => {
  const html = thread({ lead: { ...LEAD, handler_user_id: 'USR-s', needs_human: 1, stage: 'viewing', name: 'Mona <i>' } });
  assert.match(html, /<span dir="ltr">\+966 51 234 5678<\/span>/);
  assert.match(html, /Viewing/);
  assert.match(html, /Handler: <bdi>Sara<\/bdi>/);
  assert.match(html, /<span class="pl hot">Needs a human<\/span>/);
  assert.match(html, /<h2><bdi>Mona &lt;i&gt;<\/bdi><\/h2>/);
  assert.match(html, /href="\/dashboard\/leads\/LEAD-20260928-aaaa0001"/);
  assert.match(html, /href="\/dashboard\/inbox">← Inbox<\/a>/);
  assert.match(thread({ lead: { ...LEAD, handler_user_id: 'USR-g' } }), /No handler/, 'a deactivated handler is nobody');
  assert.match(thread(), /No messages stored for this chat yet/);
});

test('gaps and unconfirmed replies sit in time order with an honest status line', () => {
  const html = thread({
    messages: [msg({ key_id: 'K1', text: 'first', ts: NOW - 5 * HOUR }), msg({ key_id: 'K9', text: 'last', ts: NOW - HOUR })],
    gaps: [{ key_id: 'G1', lead_id: LEAD.lead_id, jid: LEAD.wa_lid, ts: NOW - 4 * HOUR, reason: 'failed' }],
    outbox: [
      { send_id: 'S1', lead_id: LEAD.lead_id, text: 'going <now>', user_id: 'USR-s', sender_kind: 'staff', status: 'pending', key_id: null, created: NOW - 3 * HOUR, error: null },
      { send_id: 'S2', lead_id: LEAD.lead_id, text: 'maybe', user_id: 'USR-s', sender_kind: 'staff', status: 'uncertain', key_id: null, created: NOW - 2.5 * HOUR, error: 'timeout' },
      { send_id: 'S3', lead_id: LEAD.lead_id, text: 'refused', user_id: 'USR-o', sender_kind: 'staff', status: 'failed', key_id: null, created: NOW - 2.2 * HOUR, error: 'http_500' },
      { send_id: 'S4', lead_id: LEAD.lead_id, text: 'too fast', user_id: 'USR-o', sender_kind: 'staff', status: 'failed', key_id: null, created: NOW - 2.1 * HOUR, error: 'rate_limited' },
      { send_id: 'S5', lead_id: LEAD.lead_id, text: 'odd', user_id: 'USR-o', sender_kind: 'staff', status: 'failed', key_id: null, created: NOW - 2 * HOUR, error: 'constructor' },
      { send_id: 'S6', lead_id: LEAD.lead_id, text: 'last', user_id: 'USR-s', sender_kind: 'staff', status: 'uncertain', key_id: 'K9', created: NOW - HOUR, error: null },
    ],
  });
  assert.match(html, /<div class="wgap">A message could not be loaded — check WhatsApp\.<\/div>/);
  assert.match(html, /<div class="bub out pend"><span class="who"><bdi>Sara<\/bdi><\/span><div class="tx" dir="auto">going &lt;now&gt;<\/div>/);
  assert.match(html, /Sending…/);
  assert.match(html, /Not sure it went — check WhatsApp\./);
  assert.match(html, /Not sent — WhatsApp refused it \(HTTP 500\)\./);
  assert.match(html, /Not sent — too many messages this minute, try again shortly\./);
  assert.match(html, /Not sent — something went wrong\./, 'an unknown code is not printed');
  assert.doesNotMatch(html, /constructor|function/);
  const order = ['first', 'A message could not be loaded', 'going &lt;now&gt;', 'maybe', 'refused', 'too fast', '>odd<', '>last<'].map((s) => html.indexOf(s));
  assert.ok(order.every((at) => at >= 0), 'every item is on the page');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in time order');
  assert.equal(html.match(/>last</g).length, 1, 'an outbox row that is already a stored message is not shown twice');
});

test('the reply form carries send_id, seen_ts and the kept draft, and posts to this chat', () => {
  const html = thread({ draft: 'my text </textarea><script>x</script>', error: 'stale' });
  assert.match(html, /<form class="reply" method="post" action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/reply">/);
  assert.match(html, /<input type="hidden" name="_dash" value="1">/);
  assert.match(html, /<input type="hidden" name="send_id" value="SND-abcdefghijklmnop">/);
  assert.match(html, new RegExp(`<input type="hidden" name="seen_ts" value="${NOW - HOUR}">`));
  assert.match(html, /<textarea id="r-text" name="text" maxlength="4096" dir="auto" required>my text &lt;\/textarea&gt;&lt;script&gt;x&lt;\/script&gt;<\/textarea>/);
  assert.ok(!/<script/i.test(html));
  assert.match(html, /<div class="err">New activity since you opened this chat/);
  assert.match(html, /it goes from your WhatsApp/);
  assert.match(thread({ me: STAFF }), /it goes from the owner&#39;s WhatsApp/);
});

test('no reply box for a chat with no phone number, or while sending is off', () => {
  const lid = thread({ lead: { ...LEAD, phone_e164: null, wa_jid: null }, canReply: false });
  assert.match(lid, /This chat has no phone number — reply from your phone\./);
  assert.doesNotMatch(lid, /\/reply"/);
  assert.doesNotMatch(lid, /name="text"/);
  assert.match(lid, /<span dir="ltr">—<\/span>/, 'no number to show');

  const offStaff = thread({ me: STAFF, sendingEnabled: false });
  assert.match(offStaff, /Sending is off \(Team page\)\./);
  assert.doesNotMatch(offStaff, /\/reply"/);
  assert.doesNotMatch(offStaff, /href="\/dashboard\/team"/, 'a staff page never carries the Team link');

  const offOwner = thread({ sendingEnabled: false });
  assert.match(offOwner, /Sending is off \(<a href="\/dashboard\/team">Team page<\/a>\)\./);

  const both = thread({ lead: { ...LEAD, phone_e164: null, wa_jid: null }, canReply: false, sendingEnabled: false });
  assert.match(both, /reply from your phone/, 'turning sending on would not help a chat with no number, so that is what it says');
  assert.doesNotMatch(both, /Sending is off/);
});

test('the handler picker offers active people and Nobody, with the current handler chosen', () => {
  const html = thread({ lead: { ...LEAD, handler_user_id: 'USR-s' }, users: [...USERS, { ...STAFF, user_id: 'USR-x', name: 'X <b>', active: 1 }] });
  assert.match(html, /<form class="row" method="post" action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/handler"/);
  assert.match(html, /<select id="h-user" name="user_id"><option value="">Nobody<\/option>/);
  assert.match(html, /<option value="USR-o" dir="auto">Abdulaziz Zidan<\/option>/);
  assert.match(html, /<option value="USR-s" dir="auto" selected>Sara<\/option>/);
  assert.match(html, /<option value="USR-x" dir="auto">X &lt;b&gt;<\/option>/);
  assert.doesNotMatch(html, /value="USR-g"/, 'a deactivated person cannot be picked');
  assert.match(thread(), /<option value="" selected>Nobody<\/option>/);
});

test('only the owner gets "Not a client" on a thread; nobody gets Move there', () => {
  const owner = thread();
  assert.match(owner, /action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/out"/);
  assert.doesNotMatch(owner, /\/move"/);
  const staff = thread({ me: STAFF });
  assert.doesNotMatch(staff, /\/out"/);
  assert.doesNotMatch(staff, /Not a client/);
  assert.doesNotMatch(staff, /\/move"/);
  assert.match(thread({ ok: 'sent' }), /<div class="ok">Sent\.<\/div>/);
});

test('rows full of nulls render without "undefined", "NaN", "[object" or a 1970 date', () => {
  const blank = Object.fromEntries(Object.keys(row({ snippet: null })).map((k) => [k, null]));
  blank.lead_id = 'n';
  const blankMsg = Object.fromEntries(Object.keys(msg()).map((k) => [k, null]));
  const pages = [
    inboxPage({ me: null, rows: [blank] }),
    inboxPage({ me: null, rows: null }),
    unsurePage({ me: null, rows: [blank] }),
    threadPage({
      me: null, lead: blank, messages: [blankMsg], gaps: [{ ts: null }], outbox: [{ status: 'failed', created: null, error: null, text: null }],
      users: null, sendId: null, seenTs: null, sendingEnabled: true, canReply: true,
    }),
    threadPage({ me: null, lead: blank, messages: null, gaps: null, outbox: null, users: null }),
  ];
  for (const html of pages) assert.doesNotMatch(html, /undefined|NaN|\[object|1970-01-01/);
});

/* ---------------- the lead page ---------------- */

test('the lead page offers the inbox controls that fit the viewer and the lead', () => {
  const page = (lead, me) => leadDetailPage({ lead: { ...LEAD, ...lead }, journey: [], now: NOW, me });
  const OPEN = /<a class="btn pri" href="\/dashboard\/inbox\/LEAD-20260928-aaaa0001">Open chat<\/a>/;
  const MOVE = /action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/move"/;
  const OUT = /action="\/v1\/admin\/inbox\/LEAD-20260928-aaaa0001\/out"/;

  const ownerIn = page({ inbox_state: 'in' }, OWNER);
  assert.match(ownerIn, OPEN);
  assert.match(ownerIn, OUT);
  assert.doesNotMatch(ownerIn, MOVE);
  assert.match(ownerIn, /<dt>Inbox<\/dt><dd dir="auto">In the Bona inbox<\/dd>/);

  const ownerUnsure = page({ inbox_state: 'unsure' }, OWNER);
  assert.match(ownerUnsure, MOVE);
  assert.match(ownerUnsure, OUT);
  assert.doesNotMatch(ownerUnsure, OPEN);
  assert.match(ownerUnsure, /Unsure — waiting for your decision/);

  const ownerOut = page({ inbox_state: 'out' }, OWNER);
  assert.match(ownerOut, MOVE, 'the owner can change his mind');
  assert.doesNotMatch(ownerOut, OUT);
  assert.match(ownerOut, /<dd dir="auto">Not a client<\/dd>/);

  const ownerNone = page({ inbox_state: null }, OWNER);
  assert.match(ownerNone, MOVE);
  assert.doesNotMatch(ownerNone, OUT);

  const noChat = page({ inbox_state: 'in', wa_jid: null, wa_lid: null, channel: 'form' }, OWNER);
  assert.doesNotMatch(noChat, OPEN, 'nothing to open until they write on WhatsApp');
  assert.match(noChat, /In the Bona inbox — no WhatsApp chat yet/);

  const staffIn = page({ inbox_state: 'in' }, STAFF);
  assert.match(staffIn, OPEN);
  assert.doesNotMatch(staffIn, MOVE);
  assert.doesNotMatch(staffIn, OUT);

  const staffUnsure = page({ inbox_state: 'unsure' }, STAFF);
  assert.doesNotMatch(staffUnsure, MOVE);
  assert.doesNotMatch(staffUnsure, OUT);
  assert.doesNotMatch(staffUnsure, OPEN);
  assert.doesNotMatch(staffUnsure, /Unsure/, 'Unsure is the owner\'s word');
  assert.match(staffUnsure, /Not in the Bona inbox/);

  const odd = page({ lead_id: 'LEAD/1?x=1', inbox_state: 'unsure' }, OWNER);
  assert.match(odd, /action="\/v1\/admin\/inbox\/LEAD%2F1%3Fx%3D1\/move"/);
});
```

Then in `services/api/test/team.test.mjs`, add a test right after the existing audit test. Find:

```js
  assert.ok(AUDIT_ACTIONS.includes('stage'));
  s.close();
});
```

Replace with:

```js
  assert.ok(AUDIT_ACTIONS.includes('stage'));
  s.close();
});

test('the audit log accepts the inbox actions, with a target and no text', () => {
  const s = openDb(':memory:');
  const audit = createAudit(s, { now: () => NOW });
  for (const action of ['reply_sent', 'inbox_move', 'inbox_out', 'inbox_add', 'handler']) {
    assert.ok(AUDIT_ACTIONS.includes(action), action);
    audit.record({ userId: 'USR-1', action, target: 'LEAD-1', meta: action === 'handler' ? { to: 'USR-2' } : null });
  }
  const rows = audit.recent(10);
  assert.deepEqual(rows.map((r) => r.action).sort(), ['handler', 'inbox_add', 'inbox_move', 'inbox_out', 'reply_sent']);
  assert.deepEqual(rows.find((r) => r.action === 'handler').meta, { to: 'USR-2' });
  assert.ok(rows.every((r) => r.target === 'LEAD-1'));
  s.close();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/dashboard-render-inbox.test.mjs api/test/team.test.mjs`
Expected: FAIL — `dashboard-render-inbox.test.mjs` cannot load (`ERR_MODULE_NOT_FOUND` for `lib/dashboard/render-inbox.mjs`); in `team.test.mjs` only the new test fails (`reply_sent` is not in `AUDIT_ACTIONS` yet), every other test in that file passes.

- [ ] **Step 3: Implement the audit actions** — two edits in `services/api/lib/audit.mjs`.

Find:

```js
 * owner's action already happened, and refusing to show it would only hide it.
 * Phase 2 adds reply_sent, inbox_move, inbox_out, inbox_add and handler.
 */
```

Replace with:

```js
 * owner's action already happened, and refusing to show it would only hide it.
 * The inbox actions carry no text and no number either: a reply is audited with its
 * send status, a handler change with the user it went to.
 */
```

Find:

```js
  'stage', 'note',
];
```

Replace with:

```js
  'stage', 'note',
  'reply_sent', 'inbox_move', 'inbox_out', 'inbox_add', 'handler',
];
```

- [ ] **Step 4: Implement the shared chrome** — ten edits in `services/api/lib/dashboard/render.mjs`. Each "Find" block exists exactly once in the file.

**(a) STYLE — the inbox classes, placed just above the narrow-screen block.** Find:

```css
/* ---- narrow: the rail becomes a top strip, content stacks ---------- */
```

Replace with:

```css
/* ---- inbox: chat rows, and a thread that reads like WhatsApp ------
   The client's bubbles sit on the left, everything sent from Bona's side
   on the right. A reply still on its way, or one we are not sure went,
   gets a dashed outline: WhatsApp has not confirmed it. */
.rail a.it[href="/dashboard/inbox"] .c{color:#12100a;background:var(--gold);border-radius:99px;padding:0 6px;font-weight:600}
.lr.ix{grid-template-columns:30px minmax(0,1fr)}
a.lr.ix:hover{background:var(--l1)}
.thread{display:flex;flex-direction:column;gap:8px;max-width:760px}
.bub{align-self:flex-start;max-width:min(80%,34rem);padding:7px 11px 6px;border-radius:12px;
background:var(--l2);border:1px solid var(--bd);overflow-wrap:anywhere}
.bub.out{align-self:flex-end;background:var(--goldt);border-color:transparent}
.bub.pend{background:transparent;border:1px dashed var(--bd2)}
.bub .who{display:block;font-size:10.5px;font-weight:600;color:var(--t3);margin-bottom:2px}
.bub .md{display:block;font-size:12px;color:var(--t4);font-style:italic}
.bub .tx{white-space:pre-wrap;font-size:13.5px}
.bub .at{display:block;margin-top:3px;font-size:10.5px;color:var(--t4);text-align:end;font-variant-numeric:tabular-nums}
.bub .st{display:block;margin-top:2px;font-size:11.5px;color:var(--amber)}
.bub .st.bad{color:var(--red)}
.wgap{align-self:center;font-size:11.5px;color:var(--t4);padding:4px 11px;border:1px dashed var(--bd2);border-radius:99px}
form.reply{display:grid;gap:8px;max-width:760px;margin-top:14px}

/* ---- narrow: the rail becomes a top strip, content stacks ---------- */
```

**(b) STYLE — the phone rule (the thread goes full width under 720px), placed just above the reduced-motion rule.** Find:

```css
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
```

Replace with:

```css
/* A phone reads a chat full width: the list and the thread are two screens. */
@media (max-width:720px){
  .thread,form.reply{max-width:none}
  .bub{max-width:90%}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
```

**(c) `NAV` — the Inbox entry, right after Desk.** Find:

```js
  ['/dashboard', 'Desk', '<path d="M2 8h3l1.8-4.4L9.2 12l1.7-4H14"/>', 'Workspace'],
```

Replace with:

```js
  ['/dashboard', 'Desk', '<path d="M2 8h3l1.8-4.4L9.2 12l1.7-4H14"/>', 'Workspace'],
  ['/dashboard/inbox', 'Inbox', '<path d="M2 9.2 3.9 3.3h8.2L14 9.2v3.5H2z"/><path d="M2 9.2h3.3l.9 1.6h3.6l.9-1.6H14"/>', 'Workspace'],
```

**(d) `stageName` becomes an export (render-inbox.mjs labels stages the same way).** Find:

```js
/** Prototype-safe: `?stage=constructor` must not print a function. */
const stageName = (s) =>
```

Replace with:

```js
/** Prototype-safe: `?stage=constructor` must not print a function. */
export const stageName = (s) =>
```

**(e) `layout()` — the Inbox count comes from `me.unread`; a page's own `counts` still win.** Find:

```js
  const entries = me?.role === 'owner' ? [...NAV, ...OWNER_NAV] : NAV;
  const items = entries.map(([href, label, icon, group]) => {
    const c = counts && Object.hasOwn(counts, href) && Number.isFinite(Number(counts[href]))
      ? `<span class="c">${esc(number(counts[href]))}</span>` : '';
```

Replace with:

```js
  const entries = me?.role === 'owner' ? [...NAV, ...OWNER_NAV] : NAV;
  // The Inbox count is the signed-in person's own unread messages. It rides on `me` so
  // every page shows it without each route having to pass it; a page that passes its
  // own Inbox count in `counts` still decides.
  const unread = Number(me?.unread);
  const railCounts = {
    ...(Number.isFinite(unread) && unread > 0 ? { '/dashboard/inbox': unread } : {}),
    ...(counts ?? {}),
  };
  const items = entries.map(([href, label, icon, group]) => {
    const c = Object.hasOwn(railCounts, href) && Number.isFinite(Number(railCounts[href]))
      ? `<span class="c">${esc(number(railCounts[href]))}</span>` : '';
```

**(f) `postButton` — a one-button form post, right after `scrollTable`.** Find:

```js
    : `<p class="muted">${esc(empty)}</p>`);
```

Replace with:

```js
    : `<p class="muted">${esc(empty)}</p>`);

/**
 * A write offered as one button: a plain form post with the hidden `_dash` marker every
 * dashboard form carries (see routes.mjs). `action` is escaped here; a caller that puts
 * an id in it encodes the id first, so the id stays one inert path segment.
 */
export const postButton = (action, label, fields = {}) =>
  `<form method="post" action="${esc(action)}" style="display:inline;margin:0 .35rem 0 0">` +
  '<input type="hidden" name="_dash" value="1">' +
  Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('') +
  `<button type="submit">${esc(label)}</button></form>`;
```

**(g) `MESSAGES` — the inbox error codes.** Find:

```js
  owner_only: 'Only an owner can do that.',
};
```

Replace with:

```js
  owner_only: 'Only an owner can do that.',
  stale: 'New activity since you opened this chat. Read it, then send again — your text is still in the box.',
  lid_only: 'This chat has no phone number — reply from your phone.',
  not_in_inbox: 'That chat is not in the Bona inbox.',
  excluded: 'That number is on the team or the never-a-client list, so it is not a client chat.',
  sending_disabled: 'Sending is off (Team page).',
  send_uncertain: 'Not sure it went — check WhatsApp before you send it again.',
  bad_text: 'A reply has to have some text, and at most 4,096 characters.',
  bad_send_id: 'That reply form is out of date. Reload the chat and send again.',
  bad_handler: 'A handler has to be an active member of the team, or nobody.',
  reply_rate_limited: 'Too many messages from your number this minute. Wait a minute and send again.',
  not_a_chat: 'That lead has no WhatsApp chat yet — it joins once they write on WhatsApp.',
};
```

**(h) `leadDetailPage` — the inbox label helper and the inbox buttons (top of the function).** Find:

```js
export function leadDetailPage({ lead, journey, saved = null, error = null, now = Date.now(), me = null }) {
  const field = (k, v) => `<dt>${esc(k)}</dt><dd dir="auto">${esc(v ?? '—')}</dd>`;
```

Replace with:

```js
/**
 * Where a lead stands with the Bona inbox, in words. "Unsure" is the owner's call and
 * only the owner sees the word (D9); to a team member, anything not in the inbox is
 * simply not in it.
 */
function inboxLabel(lead, owner) {
  if (lead.inbox_state === 'in') return lead.wa_jid || lead.wa_lid ? 'In the Bona inbox' : 'In the Bona inbox — no WhatsApp chat yet';
  if (owner && lead.inbox_state === 'unsure') return 'Unsure — waiting for your decision';
  if (owner && lead.inbox_state === 'out') return 'Not a client';
  return 'Not in the Bona inbox';
}

export function leadDetailPage({ lead, journey, saved = null, error = null, now = Date.now(), me = null }) {
  const field = (k, v) => `<dt>${esc(k)}</dt><dd dir="auto">${esc(v ?? '—')}</dd>`;
  const owner = me?.role === 'owner';
  const state = lead.inbox_state ?? null;
  const leadPath = encodeURIComponent(lead.lead_id);
  // Only a chat can be opened; only an owner moves a lead in or out (D9). "Not a
  // client" is offered while there is something to take out: in, or waiting on him.
  const inboxActions = [
    state === 'in' && (lead.wa_jid || lead.wa_lid) ? `<a class="btn pri" href="${esc(`/dashboard/inbox/${leadPath}`)}">Open chat</a>` : '',
    owner && state !== 'in' ? postButton(`/v1/admin/inbox/${leadPath}/move`, 'Move to Bona inbox') : '',
    owner && (state === 'in' || state === 'unsure') ? postButton(`/v1/admin/inbox/${leadPath}/out`, 'Not a client') : '',
  ].join('');
```

**(i) `leadDetailPage` — the Inbox row in the Contact card.** Find:

```js
    ${field('Channel', lead.channel)}
    ${field('First reply', responded)}
```

Replace with:

```js
    ${field('Channel', lead.channel)}
    ${field('Inbox', inboxLabel(lead, owner))}
    ${field('First reply', responded)}
```

**(j) `leadDetailPage` — the "Bona inbox" section, just above Notes.** Find:

```js
<h2>Notes</h2>
<div class="card"><p dir="auto" style="white-space:pre-wrap;margin:0">
```

Replace with:

```js
<h2>Bona inbox</h2>
<p class="sub">${esc(inboxLabel(lead, owner))}</p>
${inboxActions ? `<div class="acts" style="flex-wrap:wrap">${inboxActions}</div>` : ''}

<h2>Notes</h2>
<div class="card"><p dir="auto" style="white-space:pre-wrap;margin:0">
```

- [ ] **Step 5: Implement the inbox screens** — create `services/api/lib/dashboard/render-inbox.mjs`:

```js
/**
 * The Bona inbox (2026-09-27 design §4.4): the chat list, the owner's Unsure list, and
 * one chat's thread with its reply box.
 *
 * Same rules as render.mjs: no script (the CSP forbids it), every value through `esc`,
 * every write a plain form post to /v1/admin/*. Without script a page is as fresh as
 * its last load, so the list says so: reload to see new messages.
 *
 * Numbers: a list shows the last four digits only; the thread header shows the whole
 * number, because that page exists to talk to that one person. Names sit in `<bdi>`, so
 * an Arabic name cannot reorder the words around it.
 *
 * Who wrote a bubble: the client, a team member by name, Dana, or the owner's own phone,
 * which the owner reads as "Your number" and everyone else as "Owner's number". What he
 * types on that phone and what Lisa sends for him look the same to the API, so the
 * label never claims more than "it came from that number".
 */
import {
  esc, maskPhone, fullPhone, agoSince, dateTime, layout, knownError, messageFor, stageName, postButton,
} from './render.mjs';
import { MAX_TEXT_LEN } from '../wa-send.mjs';

export const INBOX_OK = {
  sent: 'Sent.',
  handler: 'Handler saved.',
  moved: 'Moved to the Bona inbox.',
  out: 'Marked not a client. What the dashboard stored from that chat is deleted.',
  added: 'Added to the Bona inbox.',
};

/** One banner. A known error wins over an ok; a code nobody knows shows nothing. */
function flash(ok, error) {
  if (knownError(error)) return `<div class="err">${esc(messageFor(error))}</div>`;
  return typeof ok === 'string' && Object.hasOwn(INBOX_OK, ok) ? `<div class="ok">${esc(INBOX_OK[ok])}</div>` : '';
}

// A lead id reaches these templates as-is, so it is encoded before it becomes a path
// segment: a `/` or `?` inside it must not be able to reshape a link or a form action.
const threadHref = (leadId) => `/dashboard/inbox/${encodeURIComponent(leadId)}`;
const leadHref = (leadId) => `/dashboard/leads/${encodeURIComponent(leadId)}`;
const writeHref = (leadId, what) => `/v1/admin/inbox/${encodeURIComponent(leadId)}/${what}`;

/** One line of at most `max` characters: whitespace folded, cut on a whole character. */
function preview(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

const firstLetter = (name) => (name ? [...name][0] : '·');

/** The owner's two lists. Staff never get this strip: Unsure is the owner's call (D9). */
function tabs(active, unsureCount) {
  const n = Number(unsureCount);
  return `<div class="seg"><a${active === 'inbox' ? ' class="on"' : ''} href="/dashboard/inbox">Inbox</a>` +
    `<a${active === 'unsure' ? ' class="on"' : ''} href="/dashboard/inbox?tab=unsure">Unsure${Number.isFinite(n) && n > 0 ? ` · ${esc(n)}` : ''}</a></div>`;
}

/* ------------------------------------------------------------------ */
/* The chat list                                                       */
/* ------------------------------------------------------------------ */

/** The last message in a word or two: who sent it from our side, then what it said. */
function lastLine(row) {
  const said = preview([row.last_media, row.last_text].filter(Boolean).join(' '), 80);
  if (!said) return '';
  if (row.last_direction !== 'out') return said;
  return `${row.last_sender_kind === 'dana' ? 'Dana' : 'Bona'}: ${said}`;
}

function inboxRow(row, now) {
  const name = String(row.name ?? '').trim();
  const unread = Number(row.unread) || 0;
  const last = lastLine(row);
  const pills = [
    unread > 0 ? `<span class="pl gold">${esc(unread)} new</span>` : '',
    Number(row.needs_human) === 1 ? '<span class="pl hot">Needs a human</span>' : '',
    `<span class="pl done">${esc(stageName(row.stage))}</span>`,
  ].join('');
  const handler = row.handler_name ? `Handler: <bdi>${esc(row.handler_name)}</bdi>` : 'No handler';
  return `<a class="lr ix" href="${esc(threadHref(row.lead_id))}">
  <span class="av2" aria-hidden="true"><span dir="auto">${esc(firstLetter(name))}</span></span>
  <div>
    <div class="l1"><span class="nm"><bdi>${esc(name || 'Unnamed')}</bdi></span>${pills}</div>
    <div class="l2"><span class="tel">${esc(maskPhone(row.phone_e164))}</span><span>·</span><span>${esc(agoSince(now, row.last_msg_ts ?? row.inbox_since ?? row.created))}</span><span>·</span><span>${handler}</span></div>
    ${last ? `<div class="l2"><span dir="auto">${esc(last)}</span></div>` : ''}
  </div>
</a>`;
}

/**
 * Every chat in the Bona inbox, in the order the store gives them (unread first, then
 * newest). The owner also gets the Unsure tab and "Add chat by phone number"; a team
 * member sees neither, not even as a link.
 */
export function inboxPage({ me, rows, unsureCount = 0, ok = null, error = null, now = Date.now() }) {
  const owner = me?.role === 'owner';
  const list = Array.isArray(rows) ? rows : [];
  const withNew = list.filter((r) => (Number(r.unread) || 0) > 0).length;

  const block = list.length
    ? `<p class="sub">${esc(list.length)} ${list.length === 1 ? 'chat' : 'chats'}${withNew ? `, ${esc(withNew)} with new messages` : ''}. Reload the page to see new messages.</p>
<div class="card cp">${list.map((r) => inboxRow(r, now)).join('')}</div>`
    : '<p class="muted">No chats in the Bona inbox yet. A chat joins when a client writes from an ad, with a Ref code or with a listing number, or when the owner\'s number sends them a Bona link, a brochure or a listing number.</p>';

  const add = owner
    ? `<h2 style="margin-top:22px">Add chat by phone number</h2>
<p class="sub">For a client who is not in the list yet. The chat's last 30 days are copied in from WhatsApp.</p>
<form class="row" method="post" action="/v1/admin/inbox/add">
  <input type="hidden" name="_dash" value="1">
  <div><label for="a-phone">WhatsApp number</label><input id="a-phone" name="phone" inputmode="tel" dir="ltr" placeholder="05XXXXXXXX" maxlength="20" required></div>
  <div><button type="submit">Add chat</button></div>
</form>`
    : '';

  return layout({
    title: 'Inbox',
    active: '/dashboard/inbox',
    me,
    actions: owner ? tabs('inbox', unsureCount) : '',
    body: `${flash(ok, error)}${block}${add}`,
  });
}

/* ------------------------------------------------------------------ */
/* Unsure (owner only)                                                 */
/* ------------------------------------------------------------------ */

const WHY_UNSURE = {
  keyword: 'wrote the word “bona”',
  time_window: 'wrote within 15 minutes of a tap on the site',
};

function unsureRow(row, now) {
  const name = String(row.name ?? '').trim();
  const why = typeof row.match_method === 'string' && Object.hasOwn(WHY_UNSURE, row.match_method)
    ? WHY_UNSURE[row.match_method]
    : 'no sure sign it is about Bona';
  const snippet = preview(row.snippet, 160);
  return `<div class="lr ix">
  <span class="av2" aria-hidden="true"><span dir="auto">${esc(firstLetter(name))}</span></span>
  <div>
    <div class="l1"><span class="nm"><a href="${esc(leadHref(row.lead_id))}"><bdi>${esc(name || 'Unnamed')}</bdi></a></span><span class="pl warm">${esc(why)}</span></div>
    <div class="l2"><span class="tel">${esc(maskPhone(row.phone_e164))}</span><span>·</span><span>${esc(agoSince(now, row.created))}</span></div>
    ${snippet ? `<div class="l2"><span dir="auto">${esc(snippet)}</span></div>` : ''}
    <div class="acts" style="margin-top:8px">${postButton(writeHref(row.lead_id, 'move'), 'Move to Bona inbox')}${postButton(writeHref(row.lead_id, 'out'), 'Not a client')}</div>
  </div>
</div>`;
}

/** Chats that might be about Bona. Only the owner decides, so only the owner sees them. */
export function unsurePage({ me, rows, ok = null, error = null, now = Date.now() }) {
  const list = Array.isArray(rows) ? rows : [];
  const body = `${flash(ok, error)}
<p class="sub">Chats that might be about Bona but carry no ad, Ref code or listing number. Only owners see this list. <b>Move to Bona inbox</b> copies in the chat's last 30 days so the team can read and reply; <b>Not a client</b> keeps it out of the inbox, and it never comes back on its own.</p>
${list.length ? `<div class="card cp">${list.map((r) => unsureRow(r, now)).join('')}</div>` : '<p class="muted">Nothing to decide.</p>'}`;
  return layout({ title: 'Unsure', active: '/dashboard/inbox', me, actions: tabs('unsure', list.length), body });
}

/* ------------------------------------------------------------------ */
/* One chat                                                            */
/* ------------------------------------------------------------------ */

/** Why a send failed, in words. Own-property lookup: an error code is data, not a key into anything. */
const FAIL_REASON = {
  rate_limited: 'too many messages this minute, try again shortly',
  sending_disabled: 'sending is off',
  disabled: 'WhatsApp sending is switched off on the server',
  'evolution-not-configured': 'WhatsApp is not set up on the server',
  network: 'WhatsApp could not be reached',
  bad_recipient: 'there is no phone number to send to',
};

function failReason(code) {
  if (typeof code !== 'string') return 'something went wrong';
  if (Object.hasOwn(FAIL_REASON, code)) return FAIL_REASON[code];
  const http = /^http_(\d{3})$/.exec(code);
  return http ? `WhatsApp refused it (HTTP ${http[1]})` : 'something went wrong';
}

function senderLabel(kind, userId, { owner, names }) {
  if (kind === 'client') return 'Client';
  if (kind === 'dana') return 'Dana';
  if (kind === 'owner_number') return owner ? 'Your number' : "Owner's number";
  // A reply keeps its author's name after they leave the team, so the lookup covers
  // every user, not only the active ones.
  if (kind === 'staff') return names.get(userId) ?? 'Team';
  return 'Bona';
}

function bubble({ side, label, media = null, text = null, ts, status = '', pending = false }) {
  return `<div class="bub ${side}${pending ? ' pend' : ''}">` +
    `<span class="who"><bdi>${esc(label)}</bdi></span>` +
    (media ? `<span class="md">${esc(media)}</span>` : '') +
    (text ? `<div class="tx" dir="auto">${esc(text)}</div>` : '') +
    `<span class="at">${esc(dateTime(ts))}</span>${status}</div>`;
}

/** A reply the dashboard sent (or tried to) that WhatsApp has not confirmed. */
function outboxStatus(row) {
  if (row.status === 'pending') return '<span class="st">Sending…</span>';
  if (row.status === 'uncertain') return '<span class="st">Not sure it went — check WhatsApp.</span>';
  if (row.status === 'failed') return `<span class="st bad">Not sent — ${esc(failReason(row.error))}.</span>`;
  return '';
}

/**
 * The thread: stored messages, the gaps where a message could not be read, and the
 * dashboard's own replies that WhatsApp has not confirmed yet, merged by time.
 *
 * The reply box is replaced by one plain sentence when a reply cannot go: a chat with
 * no phone number (an `@lid` is not something we send to), or the owner's Sending switch
 * off. The form carries `send_id` (a double tap sends once) and `seen_ts`, the newest
 * message this page showed, so a reply written against an old view is held back.
 */
export function threadPage({
  me, lead, messages, gaps = [], outbox = [], users = [], sendId, seenTs, sendingEnabled, canReply,
  draft = '', ok = null, error = null, now = Date.now(),
}) {
  const owner = me?.role === 'owner';
  const people = Array.isArray(users) ? users : [];
  const names = new Map(people.map((u) => [u.user_id, u.name]));
  const msgs = Array.isArray(messages) ? messages : [];
  const shown = new Set(msgs.map((m) => m.key_id));
  const who = { owner, names };

  const items = [
    ...msgs.map((m) => ({
      ts: Number(m.ts) || 0,
      html: bubble({
        side: m.direction === 'out' ? 'out' : 'in',
        label: senderLabel(m.sender_kind, m.sender_user_id, who),
        media: m.media_type,
        text: m.text,
        ts: m.ts,
      }),
    })),
    ...(Array.isArray(gaps) ? gaps : []).map((g) => ({
      ts: Number(g.ts) || 0,
      html: '<div class="wgap">A message could not be loaded — check WhatsApp.</div>',
    })),
    // A row whose WhatsApp id is already a stored message is that message; showing both
    // would print one reply twice.
    ...(Array.isArray(outbox) ? outbox : []).filter((o) => !(o.key_id && shown.has(o.key_id))).map((o) => ({
      ts: Number(o.created) || 0,
      html: bubble({
        side: 'out',
        label: senderLabel(o.sender_kind, o.user_id, who),
        text: o.text,
        ts: o.created,
        status: outboxStatus(o),
        pending: true,
      }),
    })),
  ].map((it, i) => ({ ...it, i })).sort((a, b) => a.ts - b.ts || a.i - b.i);

  const name = String(lead.name ?? '').trim();
  const handler = people.find((u) => u.active && u.user_id === lead.handler_user_id) ?? null;

  const head = `<div class="card cp">
  <div class="hd"><div><h2><bdi>${esc(name || 'Unnamed')}</bdi></h2>
    <div class="s"><span dir="ltr">${esc(fullPhone(lead.phone_e164))}</span> · ${esc(stageName(lead.stage))} · ${handler ? `Handler: <bdi>${esc(handler.name)}</bdi>` : 'No handler'}${Number(lead.needs_human) === 1 ? ' <span class="pl hot">Needs a human</span>' : ''}</div></div>
    <a class="r" href="${esc(leadHref(lead.lead_id))}">Lead record →</a></div>
</div>`;

  const thread = items.length
    ? `<div class="thread">${items.map((it) => it.html).join('')}</div>`
    : '<p class="muted">No messages stored for this chat yet.</p>';

  let reply;
  if (!canReply) {
    reply = '<p class="muted">This chat has no phone number — reply from your phone.</p>';
  } else if (!sendingEnabled) {
    // Only an owner can open the Team page, so only an owner gets it as a link: a
    // staff page never contains that link at all (Phase 1 rule).
    reply = `<p class="muted">Sending is off (${owner ? '<a href="/dashboard/team">Team page</a>' : 'Team page'}).</p>`;
  } else {
    reply = `<form class="reply" method="post" action="${esc(writeHref(lead.lead_id, 'reply'))}">
  <input type="hidden" name="_dash" value="1">
  <input type="hidden" name="send_id" value="${esc(sendId)}">
  <input type="hidden" name="seen_ts" value="${esc(seenTs)}">
  <label for="r-text">${esc(owner ? 'Reply — it goes from your WhatsApp' : "Reply — it goes from the owner's WhatsApp")}</label>
  <textarea id="r-text" name="text" maxlength="${esc(MAX_TEXT_LEN)}" dir="auto" required>${esc(draft)}</textarea>
  <div><button type="submit">Send</button></div>
</form>`;
  }

  const options = [`<option value=""${handler ? '' : ' selected'}>Nobody</option>`,
    ...people.filter((u) => u.active).map((u) =>
      `<option value="${esc(u.user_id)}" dir="auto"${handler && u.user_id === handler.user_id ? ' selected' : ''}>${esc(u.name)}</option>`)].join('');
  const picker = `<form class="row" method="post" action="${esc(writeHref(lead.lead_id, 'handler'))}" style="margin-top:18px">
  <input type="hidden" name="_dash" value="1">
  <div><label for="h-user">Handler</label><select id="h-user" name="user_id">${options}</select></div>
  <div><button type="submit">Save handler</button></div>
</form>`;

  const notClient = owner
    ? `<div style="margin-top:18px">${postButton(writeHref(lead.lead_id, 'out'), 'Not a client')}<span class="muted">Deletes what the dashboard stored from this chat; it never comes back on its own.</span></div>`
    : '';

  return layout({
    title: 'Chat',
    active: '/dashboard/inbox',
    me,
    actions: `<div class="seg"><a href="/dashboard/inbox">← Inbox</a><a href="${esc(threadHref(lead.lead_id))}">Reload</a></div>`,
    body: `${flash(ok, error)}${head}${thread}${reply}${picker}${notClient}`,
  });
}
```

- [ ] **Step 6: Run**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/dashboard-render-inbox.test.mjs api/test/team.test.mjs`
Expected: PASS — 15 tests in `dashboard-render-inbox.test.mjs`, and every test in `team.test.mjs` (the new audit test included).

- [ ] **Step 7: Run the hostile-input render scripts** (not part of `*.test.mjs`; they render every page with null-heavy and attacking input, and now cover the new lead-page section)

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node api/test/dashboard-hostile.mjs && node api/test/dashboard-regression.mjs`
Expected: the last lines are `ALL PAGES RENDER CLEAN UNDER HOSTILE INPUT` and `ALL REGRESSION CHECKS PASS`.

- [ ] **Step 8: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail — 16 more tests than after Task 9 (15 in the new file, 1 in `team.test.mjs`).

- [ ] **Step 9: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/dashboard/render-inbox.mjs services/api/lib/dashboard/render.mjs services/api/lib/audit.mjs services/api/test/dashboard-render-inbox.test.mjs services/api/test/team.test.mjs
git commit -m "dashboard: inbox screens, Inbox rail entry with unread count, lead-page inbox controls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Wiring — `index.mjs` + `lib/config.mjs`

Everything Tasks 1–10 built, put behind one app: one inbox store, handed to the one sender, the ingest, the backfill, the poller and the dashboard; `app.inboxMaintenance()` (P2-18 + amendment A3) on start and daily; the poll interval default down to 20 s (P2-11). Builds on Task 7's two `index.mjs` edits (the `createInboxStore` import and the `inboxStore` → sender hand-over): the anchors below are the file as Task 7 leaves it. Amendment A3's `inboxStore.inChatsWithoutMessages()` is not in Task 4's store, so it is added here, where its only caller is.

The upkeep starts with an exclusion sweep. Migration v4 (Task 1) marks leads `in` by how they matched and never looks at `users` or `never_list`, and a number can join the team or the never list after its chat joined — so without the sweep the catch-up would fetch and store the private chat of a colleague or a never-list number, which the spec says is "ignored entirely" (D10, §3.5), and the badge would count messages from chats nobody may open. The sweep uses the inbox's one exclusion test, `isExcludedLead(team, store, lead)`, added to `lib/team.mjs` next to `isTeamLid` so Task 12's routes use the very same rule, and one new store read, `inboxStore.listedLeads()`.

**Files:**
- Modify: `services/api/index.mjs`
- Modify: `services/api/lib/config.mjs`
- Modify: `services/api/lib/inbox/store.mjs` (`inChatsWithoutMessages`, amendment A3; `listedLeads`, for the exclusion sweep)
- Modify: `services/api/lib/team.mjs` (`isExcludedLead`: the inbox's one exclusion test, shared with Task 12's routes)
- Modify: `services/api/retell/provision.mjs` (the `--ensure-env` default for a fresh install, so it no longer pins 45 s)
- Modify: `services/api/test/config.test.mjs`
- Modify: `services/api/test/team.test.mjs`
- Modify: `services/api/test/inbox-store.test.mjs`
- Create: `services/api/test/inbox-wiring.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to the end of `services/api/test/config.test.mjs` (after the last test, which ends with `assert.equal(new Set(dflt.origins).size, dflt.origins.length, 'no duplicate origins');` and `});`):

```js

test('the WhatsApp poller reads every 20 s by default, and the environment still wins', () => {
  // The inbox (2026-09-27 design §4.3, P2-11): a staff member waits at most one interval
  // to see a client's message. The VPS env file pins its own value, which still wins.
  assert.equal(loadConfig({ env: {}, ids: {} }).waPollMs, 20_000);
  assert.equal(loadConfig({ env: { BONA_WA_POLL_MS: '45000' }, ids: {} }).waPollMs, 45_000);
});
```

In `services/api/test/team.test.mjs`, replace the import line

```js
import { createTeam, TeamError, isTeamLid, learnTeamLid } from '../lib/team.mjs';
```

with

```js
import { createTeam, TeamError, isTeamLid, learnTeamLid, isExcludedLead } from '../lib/team.mjs';
```

Append to the end of `services/api/test/team.test.mjs` (after Task 10's audit test, which ends with `assert.ok(rows.every((r) => r.target === 'LEAD-1'));`, `s.close();`, `});`):

```js

test('isExcludedLead: a lead is a colleague\'s or a never-list number\'s by its phone, its phone jid or a learned team lid', () => {
  const { s, team } = teamHarness();
  team.addUser({ name: 'Sara', phone: '0500000001', role: 'staff' });
  const gone = team.addUser({ name: 'Old Hand', phone: '0500000002', role: 'staff' });
  team.deactivateUser(gone.user_id);
  team.addNever({ phone: '0500000003' });
  learnTeamLid(s, '966500000001', '272516946294519@lid');
  const lead = (over) => ({ lead_id: 'LEAD-1', phone_e164: null, wa_jid: null, wa_lid: null, ...over });
  assert.equal(isExcludedLead(team, s, lead({ phone_e164: '966500000001' })), true, 'a team number');
  assert.equal(isExcludedLead(team, s, lead({ phone_e164: '966500000002' })), true, 'a deactivated one too');
  assert.equal(isExcludedLead(team, s, lead({ phone_e164: '966500000003' })), true, 'a never-list number');
  assert.equal(isExcludedLead(team, s, lead({ wa_jid: '966500000003:12@s.whatsapp.net' })), true, 'by its phone jid, device suffix and all');
  assert.equal(isExcludedLead(team, s, lead({ wa_lid: '272516946294519@lid' })), true, 'by a lid learned as a colleague\'s');
  assert.equal(isExcludedLead(team, s, lead({ phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net', wa_lid: '111@lid' })), false, 'a client');
  // A lid's digits are an opaque id, never a phone number, even when they spell a colleague's.
  assert.equal(isExcludedLead(team, s, lead({ wa_jid: '966500000001@lid' })), false);
  assert.equal(isExcludedLead(team, s, null), false);
  s.close();
});
```

Append to the end of `services/api/test/inbox-store.test.mjs` (after its last test, which ends with `assert.equal(prepares, 2);`, `s.db.prepare = realPrepare;`, `s.close();`, `});`):

```js

test('inChatsWithoutMessages: in chats with nothing stored yet, oldest joiner first (amendment A3)', () => {
  const { s, inbox } = harness();
  chat(s, 'L-new', { wa_jid: '966500000002@s.whatsapp.net', inbox_since: NOW - DAY });
  chat(s, 'L-old', { wa_jid: '966500000003@s.whatsapp.net', inbox_since: NOW - 3 * DAY });
  chat(s, 'L-lid', { wa_jid: null, wa_lid: '123456789@lid', inbox_since: NOW - 2 * DAY });
  chat(s, 'L-talked', { wa_jid: '966500000004@s.whatsapp.net' });
  inbox.upsertMessage(msg({ lead_id: 'L-talked' }));
  lead(s, 'L-form', { phone_e164: '966500000005', inbox_state: 'in', inbox_since: NOW - 4 * DAY });
  lead(s, 'L-unsure', { wa_jid: '966500000006@s.whatsapp.net', inbox_state: 'unsure' });
  lead(s, 'L-out', { wa_jid: '966500000007@s.whatsapp.net', inbox_state: 'out' });
  assert.deepEqual(inbox.inChatsWithoutMessages().map((l) => l.lead_id), ['L-old', 'L-lid', 'L-new'],
    'a chat with a message, a form lead with no chat, a guess and a "not a client" are not in it');
  assert.deepEqual(inbox.inChatsWithoutMessages({ limit: 1 }).map((l) => l.lead_id), ['L-old']);
  s.close();
});

test('listedLeads: every lead an inbox page can list or count, for the upkeep\'s exclusion sweep', () => {
  const { s, inbox } = harness();
  chat(s, 'L-in', { phone_e164: '966500000002', wa_jid: '966500000002@s.whatsapp.net' });
  lead(s, 'L-form', { phone_e164: '966500000005', inbox_state: 'in' });
  lead(s, 'L-unsure', { wa_jid: '966500000006@s.whatsapp.net', inbox_state: 'unsure' });
  lead(s, 'L-unplaced', { wa_lid: '123456789@lid' });
  lead(s, 'L-out', { wa_jid: '966500000007@s.whatsapp.net', inbox_state: 'out' });
  lead(s, 'L-legacy', { phone_e164: '966500000008', channel: 'form' });
  assert.deepEqual(inbox.listedLeads().map((l) => l.lead_id).sort(), ['L-form', 'L-in', 'L-unplaced', 'L-unsure'],
    'a "not a client" and a lead that is neither in nor a chat are on no inbox page');
  assert.deepEqual(inbox.listedLeads().find((l) => l.lead_id === 'L-in'),
    { lead_id: 'L-in', phone_e164: '966500000002', wa_jid: '966500000002@s.whatsapp.net', wa_lid: null, inbox_state: 'in' },
    'only what the exclusion test reads');
  s.close();
});
```

Create `services/api/test/inbox-wiring.test.mjs`:

```js
/**
 * The inbox as createApp wires it (2026-09-27 design §4): one inbox store behind the one
 * sender, the ingest and the backfill; a login code recorded in the outbox without its
 * text; a send the last process left pending given up on at start-up; and the daily
 * upkeep. Nothing leaves the process — the sender's fetch is a fake, and the backfill is
 * a spy where the test needs one. No server is listened on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.mjs';
import { openDb } from '../lib/db.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';
import { createInboxStore, RETENTION_MS } from '../lib/inbox/store.mjs';
import { JOIN_HISTORY_MS } from '../lib/inbox/backfill.mjs';

const NOW = 1_790_500_000_000;
const DAY = 86_400_000;
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });

/** createApp on an in-memory store with a pinned clock. `env` decides whether Evolution is "there". */
function build({ env = {}, ...options } = {}) {
  const db = options.db ?? openDb(':memory:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-inbox-wiring-'));
  const logs = [];
  const app = createApp({
    config: {
      port: 0, host: '127.0.0.1', siteUrl: 'https://bona.azoz.uk', publicApi: 'https://bona-api.azoz.uk',
      dataDir, inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS, toolToken: 'a'.repeat(32),
      retellApiKey: 'test', retellMock: true, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice',
      maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, toolRatePerMin: 600, toolAuthFailRatePerMin: 10,
      allowQueryToken: false, maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40, dashCookieDays: 30,
      env, ids: {}, version: '1.0.0', trustedProxies: [],
    },
    inventory, probeRetell: async () => 'ok', sendWhatsApp: async () => ({ ok: true }),
    log: (e) => logs.push(e), now: () => NOW,
    ...options,
    db,
  });
  return {
    app, db, logs,
    close: async () => {
      await app.dashboard.auth.flush();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('createApp exposes the inbox pieces, and what the ingest stores the inbox store reads back', async () => {
  const h = build();
  try {
    const { app, db } = h;
    for (const fn of ['upsertMessage', 'messagesFor', 'listInbox', 'unreadTotal', 'retentionPurge']) {
      assert.equal(typeof app.inboxStore[fn], 'function', fn);
    }
    assert.equal(typeof app.ingest.ingest, 'function');
    assert.equal(typeof app.backfill.history, 'function');
    assert.equal(typeof app.backfill.refresh, 'function');
    assert.equal(app.backfill.configured, false, 'no Evolution credentials here: the backfill reads nothing');
    assert.equal(typeof app.sender.reply, 'function');
    assert.equal(typeof app.inboxMaintenance, 'function');

    // One store, not two: a record the ingest takes is a message the inbox store lists.
    db.insertLead({
      lead_id: 'LEAD-20260928-0000aaaa', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077',
      wa_jid: '966500000077@s.whatsapp.net', channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY,
      inbox_state: 'in', inbox_since: NOW - DAY,
    });
    const out = await app.ingest.ingest(db.getLead('LEAD-20260928-0000aaaa'), {
      id: 'MSG-1', jid: '966500000077@s.whatsapp.net', jidAlt: null, fromMe: false, ts: NOW - 1000,
      text: 'is BONA-012 free?', pushName: null, contextInfo: null, messageType: 'conversation',
      media: null, fileName: null, noise: false,
    });
    assert.equal(out.stored, true);
    assert.deepEqual(app.inboxStore.messagesFor('LEAD-20260928-0000aaaa').map((m) => m.key_id), ['MSG-1']);
  } finally {
    await h.close();
  }
});

test('a send the last process left pending is "uncertain" as soon as the app is built', async () => {
  const db = openDb(':memory:');
  createInboxStore(db, { now: () => NOW - 10 * 60_000 }).insertOutbox({
    send_id: 'SND-left-pending', lead_id: 'LEAD-x', jid: '966500000077@s.whatsapp.net', text: 'hello', user_id: 'USR-1', sender_kind: 'staff',
  });
  const h = build({ db });
  try {
    const row = h.app.inboxStore.getOutbox('SND-left-pending');
    assert.equal(row.status, 'uncertain', 'nobody knows whether it went, so it is never retried');
    assert.equal(row.error, 'interrupted');
  } finally {
    await h.close();
  }
});

test('a login code goes out through the one real sender and leaves an outbox row without its text', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => JSON.stringify({ key: { id: 'KEY-CODE-1' } }) };
  };
  const h = build({ env: ENV, fetchImpl });
  try {
    assert.equal(typeof h.app.inboxMaintenance, 'function', 'the inbox wiring this test relies on');
    const asked = await h.app.dashboard.auth.requestCode({ phone: '0593296933', ip: '127.0.0.1' });
    assert.equal(asked.ok, true);
    await h.app.dashboard.auth.flush();

    assert.equal(calls.length, 1, 'exactly one request, through the fetch createApp was given');
    assert.equal(calls[0].url, 'http://evo.test/message/sendText/abdulaziz-personal');
    assert.equal(calls[0].body.number, '966593296933');
    const code = /^Bona dashboard code: (\d{6}) \(valid 10 min\)$/.exec(calls[0].body.text)?.[1];
    assert.ok(code, 'the code went to WhatsApp');

    const rows = h.db.db.prepare('SELECT * FROM wa_outbox').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sender_kind, 'code');
    assert.equal(rows[0].text, null, 'a login code is never written anywhere but the WhatsApp message');
    assert.equal(rows[0].error, null);
    assert.equal(rows[0].status, 'accepted');
    assert.equal(rows[0].key_id, 'KEY-CODE-1');
    assert.equal(rows[0].jid, '966593296933@s.whatsapp.net');
    assert.equal(rows[0].lead_id, null);
    assert.ok(!JSON.stringify(h.logs).includes(code), 'nor in the log');
  } finally {
    await h.close();
  }
});

test('the daily upkeep: old transcripts and code rows go, stale sends become uncertain, empty chats get their history', async () => {
  const asked = [];
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async (lead, { sinceTs, untilTs }) => {
      asked.push({ leadId: lead.lead_id, sinceTs, untilTs });
      return { stored: lead.lead_id === 'LEAD-empty' ? 3 : 0, scanned: 3, truncated: false };
    },
    refresh: async () => ({ stored: 0, scanned: 0, truncated: false }),
  };
  const h = build({ backfill });
  try {
    const { app, db } = h;
    const chat = (id, phone, since) => db.insertLead({
      lead_id: id, created: since, updated: since, phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`,
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: since, inbox_state: 'in', inbox_since: since,
    });
    chat('LEAD-old', '966500000077', NOW - 7 * 365 * DAY);
    chat('LEAD-recent', '966500000078', NOW - 30 * DAY);
    chat('LEAD-empty', '966500000079', NOW - 2 * DAY);
    app.inboxStore.upsertMessage({
      key_id: 'OLD-1', lead_id: 'LEAD-old', jid: '966500000077@s.whatsapp.net', direction: 'in', sender_kind: 'client',
      text: 'an old question', ts: NOW - RETENTION_MS - DAY,
    });
    app.inboxStore.upsertMessage({
      key_id: 'NEW-1', lead_id: 'LEAD-recent', jid: '966500000078@s.whatsapp.net', direction: 'in', sender_kind: 'client',
      text: 'a new question', ts: NOW - DAY,
    });
    // Outbox rows written at other moments: the same store over the same file, another clock.
    const at = (ts) => createInboxStore(db, { now: () => ts });
    const owner = '966593296933@s.whatsapp.net';
    const client = '966500000078@s.whatsapp.net';
    at(NOW - 3 * DAY).insertOutbox({ send_id: 'SND-code-three-days', jid: owner, sender_kind: 'code', status: 'accepted' });
    at(NOW - DAY).insertOutbox({ send_id: 'SND-code-one-day', jid: owner, sender_kind: 'code', status: 'accepted' });
    at(NOW - 3 * DAY).insertOutbox({ send_id: 'SND-staff-three-days', lead_id: 'LEAD-recent', jid: client, text: 'on my way', user_id: 'USR-1', sender_kind: 'staff', status: 'accepted' });
    at(NOW - 10 * 60_000).insertOutbox({ send_id: 'SND-stale', lead_id: 'LEAD-recent', jid: client, text: 'hello', user_id: 'USR-1', sender_kind: 'staff' });
    at(NOW - 30_000).insertOutbox({ send_id: 'SND-fresh', lead_id: 'LEAD-recent', jid: client, text: 'hello again', user_id: 'USR-1', sender_kind: 'staff' });

    const counts = await app.inboxMaintenance();
    assert.deepEqual(counts, { excludedOut: 0, purgedChats: 1, purgedMessages: 1, codeRows: 1, interrupted: 1, caughtUp: 2, caughtUpStored: 3 });

    assert.equal(app.inboxStore.hasMessages('LEAD-old'), false, 'five years after the last message the transcript goes');
    assert.ok(db.getLead('LEAD-old'), 'the lead row stays: it is the attribution record');
    assert.equal(db.getLead('LEAD-old').last_msg_ts, null);
    assert.equal(app.inboxStore.hasMessages('LEAD-recent'), true);
    assert.equal(app.inboxStore.getOutbox('SND-code-three-days'), null);
    assert.ok(app.inboxStore.getOutbox('SND-code-one-day'), 'still inside the rolling day the cap counts');
    assert.ok(app.inboxStore.getOutbox('SND-staff-three-days'), 'only login-code rows are pruned');
    assert.equal(app.inboxStore.getOutbox('SND-stale').status, 'uncertain');
    assert.equal(app.inboxStore.getOutbox('SND-stale').error, 'interrupted');
    assert.equal(app.inboxStore.getOutbox('SND-fresh').status, 'pending', 'a send still inside its two minutes is left alone');

    // Chats with nothing stored get the history an automatic join takes (amendment A3),
    // never further back than the retention horizon — or the purge above would be undone.
    assert.deepEqual([...asked].sort((a, b) => a.leadId.localeCompare(b.leadId)), [
      { leadId: 'LEAD-empty', sinceTs: NOW - 2 * DAY - JOIN_HISTORY_MS, untilTs: NOW },
      { leadId: 'LEAD-old', sinceTs: NOW - RETENTION_MS, untilTs: NOW },
    ]);

    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.maintenance'), { evt: 'inbox.maintenance', ...counts });
    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.catchup'), { evt: 'inbox.catchup', chats: 2, stored: 3 });
    const dump = JSON.stringify(h.logs);
    for (const secret of ['966500000077', '966500000078', 'an old question', 'hello']) assert.ok(!dump.includes(secret), secret);

    // One run at a time: a second call while the first is still fetching does nothing.
    const [first, second] = await Promise.all([app.inboxMaintenance(), app.inboxMaintenance()]);
    assert.deepEqual(second, { skipped: 'running' });
    assert.equal(first.purgedChats, 0);
  } finally {
    await h.close();
  }
});

test('the upkeep takes a colleague\'s or a never-list number\'s chat out of the inbox before any history is fetched', async () => {
  const asked = [];
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async (lead) => { asked.push(lead.lead_id); return { stored: 0, scanned: 0, truncated: false }; },
    refresh: async () => ({ stored: 0, scanned: 0, truncated: false }),
  };
  const h = build({ backfill });
  try {
    const { app, db } = h;
    // Leads migration v4 sorted by how they matched, before anyone checked the numbers.
    const lead = (id, phone, state) => db.insertLead({
      lead_id: id, created: NOW - DAY, updated: NOW - DAY, phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`,
      channel: 'whatsapp', match_method: state === 'in' ? 'ad_meta' : 'keyword', stage: 'new', stage_ts: NOW - DAY,
      inbox_state: state, inbox_since: state === 'in' ? NOW - DAY : null,
    });
    app.team.addUser({ name: 'Sara', phone: '0500000001', role: 'staff' });
    app.team.addNever({ phone: '0500000080' });
    app.team.addNever({ phone: '0500000081' });
    lead('LEAD-staff', '966500000001', 'in');
    lead('LEAD-never', '966500000080', 'in');
    lead('LEAD-never-guess', '966500000081', 'unsure');
    lead('LEAD-client', '966500000077', 'in');
    // What the join history would have kept of the colleague's chat: her side of it.
    app.inboxStore.upsertMessage({
      key_id: 'T-1', lead_id: 'LEAD-staff', jid: '966500000001@s.whatsapp.net', direction: 'in', sender_kind: 'client',
      text: 'my code did not come', ts: NOW - 1000,
    });
    assert.equal(app.inboxStore.unreadTotal({ userId: 'USR-anyone' }), 1, 'the control: before the upkeep it counts');

    const counts = await app.inboxMaintenance();
    assert.deepEqual(counts, { excludedOut: 3, purgedChats: 0, purgedMessages: 0, codeRows: 0, interrupted: 0, caughtUp: 1, caughtUpStored: 0 });
    for (const id of ['LEAD-staff', 'LEAD-never', 'LEAD-never-guess']) assert.equal(db.getLead(id).inbox_state, 'out', id);
    assert.equal(app.inboxStore.hasMessages('LEAD-staff'), false, 'her words are gone, not merely hidden');
    assert.equal(app.inboxStore.unreadTotal({ userId: 'USR-anyone' }), 0, 'and no badge counts them');
    assert.deepEqual(asked, ['LEAD-client'], 'history is fetched for the client alone');
    assert.equal(db.getLead('LEAD-client').inbox_state, 'in');

    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.excluded_out'), { level: 'warn', evt: 'inbox.excluded_out', count: 3 });
    const dump = JSON.stringify(h.logs);
    for (const secret of ['500000001', '500000080', '500000081', 'Sara', 'my code did not come']) assert.ok(!dump.includes(secret), secret);

    // Nothing left to take out: the next run finds nothing and says nothing about it.
    const again = await app.inboxMaintenance();
    assert.equal(again.excludedOut, 0);
    assert.equal(h.logs.filter((e) => e.evt === 'inbox.excluded_out').length, 1);
  } finally {
    await h.close();
  }
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/config.test.mjs api/test/team.test.mjs api/test/inbox-store.test.mjs api/test/inbox-wiring.test.mjs`
Expected: FAIL — config: `45000 !== 20000` (the default is still 45 s); team: the file does not load (`SyntaxError: The requested module '../lib/team.mjs' does not provide an export named 'isExcludedLead'`); inbox-store: the two new tests fail with `TypeError: inbox.inChatsWithoutMessages is not a function` and `TypeError: inbox.listedLeads is not a function`; inbox-wiring: all five fail, because `createApp` has no `app.inboxStore` / `app.inboxMaintenance` yet (`TypeError: Cannot read properties of undefined (reading 'upsertMessage')` / `'getOutbox'`, and `'undefined' !== 'function'` in the login-code test, which checks the wiring before it sends anything).

- [ ] **Step 3: Implement**

**3a. `services/api/lib/config.mjs`** — replace

```js
    waPollMs: Number(env.BONA_WA_POLL_MS ?? 45_000),
```

with

```js
    // 20 s since the inbox (P2-11): a staff member waits at most one interval to see a
    // client's message. Each tick is one ~20 ms read on the VPS (measured 2026-09-28).
    waPollMs: Number(env.BONA_WA_POLL_MS ?? 20_000),
```

**3b. `services/api/retell/provision.mjs`** — in `ensureServicesEnv`'s defaults, replace

```js
    BONA_WA_POLL_MS: '45000',
```

with

```js
    BONA_WA_POLL_MS: '20000',
```

(`--ensure-env` only appends keys a file lacks, so this changes a fresh install only; the live VPS line is edited by hand in the ship task.)

**3c. `services/api/lib/inbox/store.mjs`** — two edits. After `countUnsure`, replace

```js
  const countUnsure = () => prep(`SELECT COUNT(*) AS n FROM leads l WHERE ${UNSURE_CHAT}`).get().n;
```

with

```js
  const countUnsure = () => prep(`SELECT COUNT(*) AS n FROM leads l WHERE ${UNSURE_CHAT}`).get().n;

  /**
   * `in` chats with nothing stored yet (amendment A3): the chats migration v4 let in
   * without their history, or whose history was empty when they joined. The daily upkeep
   * (index.mjs `inboxMaintenance`) fetches for each what an automatic join would have
   * taken, oldest joiner first, so a long backlog is worked in the order it built up.
   */
  function inChatsWithoutMessages({ limit = 200 } = {}) {
    return prep(`SELECT l.* FROM leads l
                 WHERE ${IN_CHAT} AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.lead_id = l.lead_id)
                 ORDER BY COALESCE(l.inbox_since, l.created) ASC, l.rowid ASC
                 LIMIT ?`)
      .all(clampLimit(limit, 200)).map(leadRow);
  }

  /**
   * Every lead an inbox page can list or count — an `in` lead, or one on the Unsure list —
   * with only what the exclusion test reads. The daily upkeep puts out any whose number is
   * a colleague's or on the never list (index.mjs `inboxMaintenance`). No limit: a sweep
   * that stopped part-way would leave the rest listed.
   */
  const listedLeads = () => prep(`SELECT l.lead_id, l.phone_e164, l.wa_jid, l.wa_lid, l.inbox_state FROM leads l
                                  WHERE l.inbox_state = 'in' OR ${UNSURE_CHAT}
                                  ORDER BY l.rowid ASC`).all().map(plain);
```

and in the returned object replace

```js
    markRead, listInbox, unreadTotal, listUnsure, countUnsure,
```

with

```js
    markRead, listInbox, unreadTotal, listUnsure, countUnsure, inChatsWithoutMessages, listedLeads,
```

**3d. `services/api/lib/team.mjs`** — the inbox's one exclusion test, next to the lid helpers it uses. Replace

```js
export function isTeamLid(store, lid) {
  if (!lid) return false;
  return Boolean(lidStmt(store.db, 'SELECT 1 FROM users WHERE wa_lid = ?').get(String(lid)));
}
```

with

```js
export function isTeamLid(store, lid) {
  if (!lid) return false;
  return Boolean(lidStmt(store.db, 'SELECT 1 FROM users WHERE wa_lid = ?').get(String(lid)));
}

/**
 * True when a lead's chat is a team member's (active or not) or a never-list number's,
 * however the row holds it: its phone, the number in its phone jid, or a lid learned as
 * a colleague's by `learnTeamLid`. The Bona inbox's one exclusion test (§3.5, P2-7): the
 * dashboard routes refuse such a chat, and the daily upkeep takes it out of the inbox. A
 * lid's own digits are an opaque id, never read as a phone number.
 *
 * @param {ReturnType<typeof createTeam>} team
 * @param {ReturnType<import('./db.mjs').openDb>} store
 * @param {{ phone_e164?: string|null, wa_jid?: string|null, wa_lid?: string|null }|null} lead
 */
export function isExcludedLead(team, store, lead) {
  if (!lead) return false;
  const jid = typeof lead.wa_jid === 'string' && lead.wa_jid.endsWith('@s.whatsapp.net') ? lead.wa_jid : null;
  return team.isExcludedPhone(lead.phone_e164)
    || Boolean(jid && team.isExcludedPhone(jid.split('@')[0].split(':')[0]))
    || isTeamLid(store, lead.wa_lid);
}
```

**3e. `services/api/index.mjs`** — seven edits, on the file as Task 7 left it.

(1) Imports. Replace

```js
import { createSender } from './lib/wa-send.mjs';
import { createInboxStore } from './lib/inbox/store.mjs';
```

with

```js
import { createSender } from './lib/wa-send.mjs';
import { createInboxStore, RETENTION_MS } from './lib/inbox/store.mjs';
import { createIngest } from './lib/inbox/ingest.mjs';
import { createBackfill, JOIN_HISTORY_MS } from './lib/inbox/backfill.mjs';
```

(2) The exclusion test the upkeep's sweep uses. Replace

```js
import { createTeam, TeamError } from './lib/team.mjs';
```

with

```js
import { createTeam, TeamError, isExcludedLead } from './lib/team.mjs';
```

(3) Constants. Replace

```js
const jsonLog = (level, obj) => {
```

with

```js
/** Login-code outbox rows exist only to count the day's sends; two days covers any rolling 24 h. */
const CODE_ROW_TTL_MS = 2 * 86_400_000;
/** lib/wa-send.mjs `recoverInterrupted`'s own rule: a send pending longer than this lost its process. */
const INTERRUPTED_SEND_MS = 120_000;
/** How often the real server runs `app.inboxMaintenance()`. */
const INBOX_UPKEEP_EVERY_MS = 24 * 3_600_000;

const jsonLog = (level, obj) => {
```

(4) The wiring. Replace this block (from the audit line to the poller line, Task 7's inbox-store lines included):

```js
  const audit = options.audit ?? createAudit(db, { log });
  // The Bona inbox tables (2026-09-27 design §4.2). The sender already needs them: every
  // send is written to the outbox first, and the daily cap is counted from it.
  const inboxStore = options.inboxStore ?? createInboxStore(db);
  // The ONE sender for messages from the owner's number to anyone else: its per-minute
  // limits live in memory, so a second instance would be a second, independent budget.
  const sender = options.sender ?? createSender({ env: cfg.env ?? {}, team, inbox: inboxStore, db, log });
  const sendCode = options.sendCode ?? ((o) => sender.sendTo({ ...o, kind: 'code' }));
  // The WhatsApp Ref-code poller. Read-only, and only when `BONA_WA_POLL` says so —
  // constructing it contacts nothing; the real server (below) is what puts it on a timer.
  const poller = options.poller ?? (cfg.waPoll ? createPoller({ db, cfg, sendWhatsApp, isExcluded: team.isExcludedPhone, log }) : null);
```

with

```js
  const audit = options.audit ?? createAudit(db, { log });
  // The clock the inbox pieces read. Only tests pin it; everything else in this file
  // keeps reading Date.now() as before.
  const clock = options.now ?? (() => Date.now());
  // The fetch the sender and the backfill go out through. A test hands in a fake so
  // nothing leaves the process; left undefined, each falls back to the global fetch.
  const fetchImpl = options.fetchImpl;
  // The Bona inbox (2026-09-27 design §4): transcripts of inbox chats, the outbox every
  // send is written to before it goes, unread marks, and the gaps a thread owns up to.
  const inboxStore = options.inboxStore ?? createInboxStore(db, { now: clock });
  // The ONE sender for messages from the owner's number to anyone else. Its per-minute
  // limits live in memory, so a second instance would be a second, independent budget;
  // the day's cap is counted from the outbox, so a restart no longer resets it.
  const sender = options.sender ?? createSender({ env: cfg.env ?? {}, team, inbox: inboxStore, db, fetchImpl, now: clock, log });
  // A send that was in flight when the last process died is not known to have failed:
  // it becomes "uncertain" — shown as such, never retried — rather than pending for ever.
  const interrupted = sender.recoverInterrupted?.() ?? 0;
  if (interrupted) log({ level: 'warn', evt: 'wa.send.interrupted', count: interrupted });
  const sendCode = options.sendCode ?? ((o) => sender.sendTo({ ...o, kind: 'code' }));
  // A message typed on the owner's own phone makes him the chat's handler when it has
  // none. Looked up on every call, so a change on the Team page is seen at once.
  const ownerDigits = bareJid(waConfig(cfg.env ?? {}).ownerJid);
  const ownerUserId = () => {
    const owner = ownerDigits ? team.getUserByPhone(ownerDigits) : null;
    return owner && owner.active && owner.role === 'owner' ? owner.user_id : null;
  };
  const ingest = options.ingest ?? createIngest({ db, inbox: inboxStore, ownerUserId, log, now: clock });
  // The backfill and the poller take the one-record function, not the object.
  const ingestRecord = (lead, rec) => ingest.ingest(lead, rec);
  // Per-chat reads from Evolution: history when a chat joins, a refresh when a thread is
  // opened or answered. Read-only, like the poller; constructing it contacts nothing.
  const backfill = options.backfill ?? createBackfill({ env: cfg.env ?? {}, db, ingest: ingestRecord, fetchImpl, log, now: clock });
  // The WhatsApp Ref-code poller. Read-only, and only when `BONA_WA_POLL` says so —
  // constructing it contacts nothing; the real server (below) is what puts it on a timer.
  const poller = options.poller ?? (cfg.waPoll ? createPoller({
    db, cfg, sendWhatsApp, isExcluded: team.isExcludedPhone, log, inboxStore, ingest: ingestRecord, backfill,
  }) : null);
```

(5) The app object and the upkeep. Replace

```js
  const app = {
    cfg, inventory, store, db, retell, tools, limiters, fanout, budget, team, audit, sender,
    poller: options.poller ?? null,
  };
```

with

```js
  const app = {
    cfg, inventory, store, db, retell, tools, limiters, fanout, budget, team, audit, sender,
    inboxStore, ingest, backfill,
    poller: options.poller ?? null,
  };

  /**
   * The inbox's upkeep (P2-18, amendment A3), run once at start-up and then daily by the
   * real server below. In order: a chat whose number is a colleague's or on the never list
   * leaves the inbox and its transcript goes (§3.5 — migration v4 sorted leads by how they
   * matched, and a number can join the team or the never list after its chat joined);
   * transcripts of chats silent for five years go (the lead rows stay — they are the
   * attribution record); login-code outbox rows older than two days go (they only ever
   * counted the day's sends); a send left pending by a process that died becomes
   * uncertain; then every `in` chat with nothing stored yet gets the history an automatic
   * join takes — never reaching past the retention horizon, or the purge would be undone
   * the same morning. Counts only in the log: never a number, a name or a word of a
   * message. One run at a time, and it never rejects: upkeep that fails is a line in the
   * log, not a crashed server.
   */
  let upkeepRunning = false;
  app.inboxMaintenance = async function inboxMaintenance() {
    if (upkeepRunning) return { skipped: 'running' };
    upkeepRunning = true;
    try {
      const t = clock();
      // First, so the catch-up below never fetches a private chat's history.
      let excludedOut = 0;
      for (const lead of inboxStore.listedLeads()) {
        if (!isExcludedLead(team, db, lead)) continue;
        inboxStore.leaveInbox(lead.lead_id);
        excludedOut += 1;
      }
      if (excludedOut) log({ level: 'warn', evt: 'inbox.excluded_out', count: excludedOut });
      const retention = inboxStore.retentionPurge(t - RETENTION_MS);
      const counts = {
        excludedOut,
        purgedChats: retention.leads,
        purgedMessages: retention.messages,
        codeRows: inboxStore.pruneCodeRows(t - CODE_ROW_TTL_MS),
        interrupted: inboxStore.markStalePending(t - INTERRUPTED_SEND_MS),
        caughtUp: 0,
        caughtUpStored: 0,
      };
      if (backfill.configured) {
        for (const lead of inboxStore.inChatsWithoutMessages()) {
          // A number that joined the team while an earlier fetch was running is not fetched.
          if (isExcludedLead(team, db, lead)) continue;
          const sinceTs = Math.max((lead.inbox_since ?? lead.created ?? t) - JOIN_HISTORY_MS, t - RETENTION_MS);
          const got = await backfill.history(lead, { sinceTs, untilTs: t });
          // A chat that left the inbox meanwhile comes back `skipped`: nothing was read for it.
          if (got && !got.error && !got.skipped) {
            counts.caughtUp += 1;
            counts.caughtUpStored += Number(got.stored) || 0;
          }
        }
        log({ evt: 'inbox.catchup', chats: counts.caughtUp, stored: counts.caughtUpStored });
      }
      log({ evt: 'inbox.maintenance', ...counts });
      return counts;
    } catch (err) {
      log({ level: 'error', evt: 'inbox.maintenance_failed', error: String(err?.message ?? err).slice(0, 200) });
      return { error: 'failed' };
    } finally {
      upkeepRunning = false;
    }
  };
```

(6) The dashboard gets the inbox. Replace

```js
  const dashboard = options.dashboard ?? createDashboardRoutes({
    db, cfg, inventory, fanout, app, log, sendWhatsApp, probeRetell, team, audit, sendCode,
  });
```

with

```js
  const dashboard = options.dashboard ?? createDashboardRoutes({
    db, cfg, inventory, fanout, app, log, sendWhatsApp, probeRetell, team, audit, sendCode,
    inbox: inboxStore, sender, backfill,
  });
```

(Task 12 teaches `createDashboardRoutes` to use the three new options; until then it ignores them.)

(7) The real server's start-up block. Replace

```js
  if (app.poller) {
    const pollStarted = app.poller.start({ intervalMs: app.cfg.waPollMs });
    jsonLog('info', { evt: 'wa.poll.init', started: pollStarted, everyMs: app.cfg.waPollMs, ...app.poller.status() });
  }
  app.server.listen(app.cfg.port, app.cfg.host, () => {
```

with

```js
  if (app.poller) {
    const pollStarted = app.poller.start({ intervalMs: app.cfg.waPollMs });
    jsonLog('info', { evt: 'wa.poll.init', started: pollStarted, everyMs: app.cfg.waPollMs, ...app.poller.status() });
  }
  // Inbox upkeep (P2-18): once now, then daily. It logs its own counts and never rejects;
  // like the poller, it is never the reason the process stays alive.
  app.inboxMaintenance();
  setInterval(() => { app.inboxMaintenance(); }, INBOX_UPKEEP_EVERY_MS).unref();
  app.server.listen(app.cfg.port, app.cfg.host, () => {
```

- [ ] **Step 4: Run the tests**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/config.test.mjs api/test/team.test.mjs api/test/inbox-store.test.mjs api/test/inbox-wiring.test.mjs`
Expected: PASS (6 config tests, every team test plus the new one, Task 4's store tests plus the two new ones, 5 inbox-wiring tests).

- [ ] **Step 5: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail (`http.test.mjs` and `dashboard-routes.test.mjs` build the app through the new wiring; their Evolution-less env means the sender and backfill contact nothing).

- [ ] **Step 6: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/index.mjs services/api/lib/config.mjs services/api/lib/inbox/store.mjs services/api/lib/team.mjs services/api/retell/provision.mjs services/api/test/config.test.mjs services/api/test/team.test.mjs services/api/test/inbox-store.test.mjs services/api/test/inbox-wiring.test.mjs
git commit -m "inbox: wire one store behind the sender, ingest, backfill, poller and dashboard; daily upkeep that first puts out colleagues' and never-list chats; poll every 20 s

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Routes — the inbox pages and writes (`lib/dashboard/routes.mjs`)

`GET /dashboard/inbox` (and the owner's `?tab=unsure`), `GET /dashboard/inbox/:leadId`, `POST /v1/admin/inbox/:leadId/reply|handler` (anyone on the team), `POST /v1/admin/inbox/:leadId/move|out` and `POST /v1/admin/inbox/add` (owner), the never-list purge (P2-7) and the same purge when a colleague is added on the Team page (§3.5), and `me.unread` on every signed-in page. Every exclusion check goes through Task 11's `isExcludedLead`, and the badge and the Unsure count are counted from the rows the lists show, so no number ever counts a chat that rule 1 hides.

Form fields, exactly as Task 10's `render-inbox.mjs` draws them: reply → `_dash`, `send_id`, `seen_ts`, `text` (`<form class="reply" method="post" action="/v1/admin/inbox/<leadId>/reply">`, hidden `send_id`/`seen_ts` inputs; no form at all when the chat is lid-only or sending is off); handler picker → `_dash`, `user_id` (`''` = nobody); add → `_dash`, `phone`; move / Not a client → `_dash`. Task 7's `sender.reply` is what refuses or sends; this task maps its answers to pages (P2-9).

**Files:**
- Modify: `services/api/lib/dashboard/routes.mjs`
- Test: `services/api/test/dashboard-inbox.test.mjs` (create)

- [ ] **Step 1: Write the failing tests** — create `services/api/test/dashboard-inbox.test.mjs`:

```js
/**
 * The Bona inbox through the real HTTP server (2026-09-27 design §4, and the hostile list
 * in §8): who may read a chat, who may answer it, and that an answer goes out exactly
 * once — through the one real sender, over a fake Evolution that counts every request.
 * The backfill is a spy: it records what it is asked for and, when a test says so,
 * "finds" a message that arrived while the page was open. Login codes go to a spy of
 * their own, so the only requests the fake Evolution ever sees are replies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.mjs';
import { openDb } from '../lib/db.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';
import { createTeam } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { OWNER_HISTORY_MS } from '../lib/inbox/backfill.mjs';
import { createSender } from '../lib/wa-send.mjs';

const NOW = 1_790_500_000_000;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'";
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const OWNER_PHONE = '966593296933';
const STAFF_PHONE = '966500000001';
const CLIENT = '966500000077';

/** The inbox opens nothing in the CSP: same four headers as every dashboard answer. */
function assertLocked(res) {
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-security-policy'), CSP);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
}

/** The value of a named form field on a page, whatever order the input's attributes come in. */
function fieldOf(html, name) {
  const tag = new RegExp(`<input[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0];
  return tag ? (/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? null) : null;
}

async function withInbox(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-inbox-'));
  const db = openDb(':memory:');
  let clock = NOW;
  const now = () => clock;
  const logs = [];
  const log = (e) => logs.push(e);
  // The team's clock is pinned too: `users.created` is where a person's unread count
  // starts (P2-8), and every seeded message below is newer than it.
  const team = createTeam(db, { now });
  const inboxStore = createInboxStore(db, { now });

  // Evolution's sendText, faked. Every request is counted; `evo.reply` decides the answer
  // ('timeout' throws the AbortError a real timeout produces); `evo.hold()` parks the
  // next request at WhatsApp until the test releases it — the double-click race.
  const evo = { calls: [], reply: (n) => ({ status: 201, body: { key: { id: `KEY-${n}` } } }), gate: null };
  evo.hold = () => {
    let release;
    let entered;
    const released = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    evo.gate = { released, entered };
    return { reached, release };
  };
  const fetchImpl = async (url, init) => {
    evo.calls.push({ url, body: JSON.parse(init.body) });
    const gate = evo.gate;
    if (gate) {
      evo.gate = null;
      gate.entered();
      await gate.released;
    }
    const r = evo.reply(evo.calls.length);
    if (r === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  const sender = createSender({ env: ENV, team, inbox: inboxStore, db, fetchImpl, now, log });

  const spy = { history: [], refresh: [], onRefresh: null };
  const backfill = {
    configured: true,
    phoneJidOf: (lead) => (lead?.phone_e164 ? `${lead.phone_e164}@s.whatsapp.net` : null),
    async history(lead, opts = {}) {
      spy.history.push({ leadId: lead?.lead_id ?? null, sinceTs: opts.sinceTs, untilTs: opts.untilTs });
      return { stored: 0, scanned: 0, truncated: false };
    },
    async refresh(lead) {
      spy.refresh.push(lead?.lead_id ?? null);
      spy.onRefresh?.(lead);
      return { stored: 0, scanned: 0, truncated: false };
    },
  };

  const codes = [];
  const notes = [];
  const app = createApp({
    config: {
      port: 0, host: '127.0.0.1', siteUrl: 'https://bona.azoz.uk', publicApi: 'https://bona-api.azoz.uk',
      dataDir, inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS, toolToken: 'a'.repeat(32),
      retellApiKey: 'test', retellMock: true, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice',
      maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, env: ENV, ids: {}, version: '1.0.0',
      toolRatePerMin: 600, toolAuthFailRatePerMin: 10, allowQueryToken: false, trustedProxies: [],
      maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40, dashCookieDays: 30,
    },
    inventory, db, team, inboxStore, sender, backfill, now, log,
    probeRetell: async () => 'ok',
    sendWhatsApp: async (text) => { notes.push(text); return { ok: true }; },
    sendCode: async ({ text }) => { codes.push(text); return { ok: true }; },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const go = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const get = (p, { cookie } = {}) => go(p, { headers: cookie ? { Cookie: cookie } : {} });
  /** Every write carries the form marker, as our own pages do. */
  const postForm = (p, fields, { cookie } = {}) => go(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams({ _dash: '1', ...fields }).toString(),
  });
  const cookieOf = (res, name) => {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      if (pair.slice(0, pair.indexOf('=')) === name && !c.includes('Max-Age=0')) return pair.slice(pair.indexOf('=') + 1);
    }
    return null;
  };
  /** The whole login, as a browser does it: ask, read the code off the "phone", type it back. */
  async function login(phone) {
    const before = codes.length;
    const asked = await postForm('/dashboard/login/code', { phone });
    assert.equal(asked.status, 303);
    await app.dashboard.auth.flush();
    assert.equal(codes.length, before + 1, 'one code went out');
    const code = /(\d{6})/.exec(codes.at(-1))[1];
    const verified = await postForm('/dashboard/login/verify', { code }, { cookie: `bona_dash_try=${cookieOf(asked, 'bona_dash_try')}` });
    assert.equal(verified.status, 303);
    return `bona_dash=${cookieOf(verified, 'bona_dash')}`;
  }

  const staffUser = team.addUser({ name: 'Sara', phone: STAFF_PHONE, role: 'staff' });
  const owner = team.getUserByPhone(OWNER_PHONE);
  try {
    await fn({
      app, db, team, inboxStore, evo, spy, notes, logs, staffUser, owner, get, postForm,
      staff: () => login('0500000001'),
      boss: () => login('0593296933'),
      tick: (ms) => { clock += ms; },
    });
  } finally {
    await app.dashboard.auth.flush();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** One lead in whatever inbox state the test needs, with its stored messages (inbound unless said). */
function seedChat(h, { id, name, phone = CLIENT, jid = phone ? `${phone}@s.whatsapp.net` : null, lid = null, state = 'in', messages = [] }) {
  h.db.insertLead({
    lead_id: id, created: NOW - 3_600_000, updated: NOW - 3_600_000, phone_e164: phone, wa_jid: jid, wa_lid: lid, name,
    channel: 'whatsapp', source: 'meta', medium: 'paid', match_method: state === 'in' ? 'ad_meta' : 'keyword',
    stage: 'new', stage_ts: NOW - 3_600_000, first_inbound_ts: NOW - 3_600_000,
    inbox_state: state, inbox_since: state === 'in' ? NOW - 3_600_000 : null,
  });
  for (const m of messages) h.inboxStore.upsertMessage({ lead_id: id, jid: jid ?? lid, direction: 'in', sender_kind: 'client', ...m });
  return id;
}

/**
 * The cast most tests share: a client in the inbox, a lid-only client in the inbox, and
 * one of every chat that must never be shown — a guess (unsure), a "not a client" (out),
 * a never-list number and a team member's number (both still marked `in`, as a lead can
 * be when its number was listed after it joined), and a form lead with no chat at all.
 */
function seedScene(h) {
  seedChat(h, { id: 'LEAD-A', name: 'Alya Client', messages: [{ key_id: 'A-1', text: 'Is BONA-012 still free?', ts: NOW + 60_000 }] });
  seedChat(h, { id: 'LEAD-L', name: 'Layla Lid', phone: null, lid: '123456789012345@lid', messages: [{ key_id: 'L-1', text: 'hello from a lid chat', ts: NOW + 50_000 }] });
  seedChat(h, { id: 'LEAD-U', name: 'Umar Unsure', phone: '966500000078', state: 'unsure' });
  seedChat(h, { id: 'LEAD-O', name: 'Omar Out', phone: '966500000079', state: 'out' });
  seedChat(h, { id: 'LEAD-N', name: 'Nadia Never', phone: '966500000080', messages: [{ key_id: 'N-1', text: 'never words', ts: NOW + 40_000 }] });
  h.team.addNever({ phone: '966500000080', note: 'family' });
  seedChat(h, { id: 'LEAD-T', name: 'Tariq Team', phone: STAFF_PHONE, messages: [{ key_id: 'T-1', text: 'team words', ts: NOW + 30_000 }] });
  seedChat(h, { id: 'LEAD-F', name: 'Farah Form', phone: '966500000081', jid: null });
}

const replyTo = (h, leadId, fields, cookie) => h.postForm(`/v1/admin/inbox/${leadId}/reply`, fields, { cookie });

/* ---------------- who sees what ---------------- */

test('the inbox lists only chats that are in, to everyone; the Unsure list is the owner\'s alone', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    // A guess whose number went on the never list after it arrived: on no list, in no count.
    seedChat(h, { id: 'LEAD-NU', name: 'Noor Never Guess', phone: '966500000082', state: 'unsure' });
    h.team.addNever({ phone: '966500000082' });
    const staff = await h.staff();
    const boss = await h.boss();
    for (const cookie of [staff, boss]) {
      const res = await h.get('/dashboard/inbox', { cookie });
      assert.equal(res.status, 200);
      assertLocked(res);
      const html = await res.text();
      assert.doesNotMatch(html, /<script/i, 'the inbox ships no script');
      for (const name of ['Alya Client', 'Layla Lid']) assert.ok(html.includes(name), name);
      for (const hidden of ['Umar Unsure', 'Omar Out', 'Nadia Never', 'Tariq Team', 'Farah Form', 'Noor Never Guess', 'never words', 'team words']) {
        assert.ok(!html.includes(hidden), hidden);
      }
      // The badge counts what the list shows: Alya's and Layla's messages, never the
      // never-list or the colleague's chat still marked `in`.
      assert.match(html, /Inbox<span class="c">2<\/span>/);
    }
    const tabs = await (await h.get('/dashboard/inbox', { cookie: boss })).text();
    assert.match(tabs, /Unsure · 1<\/a>/, 'Umar alone: the never-list guess is not counted either');
    const denied = await h.get('/dashboard/inbox?tab=unsure', { cookie: staff });
    assert.equal(denied.status, 403);
    assertLocked(denied);
    assert.ok(!(await denied.text()).includes('Umar Unsure'));
    const unsure = await h.get('/dashboard/inbox?tab=unsure', { cookie: boss });
    assert.equal(unsure.status, 200);
    assertLocked(unsure);
    const list = await unsure.text();
    assert.ok(list.includes('Umar Unsure'));
    assert.ok(!list.includes('Alya Client'), 'the Unsure list is the guesses only');
    assert.ok(!list.includes('Noor Never Guess'));
  });
});

test('a chat that is not in the inbox cannot be opened or answered, and nothing goes out', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const boss = await h.boss();
    // The control: the one chat that IS in opens, so every 404 below is a refusal, not a missing route.
    assert.equal((await h.get('/dashboard/inbox/LEAD-A', { cookie: staff })).status, 200);
    for (const id of ['LEAD-U', 'LEAD-O', 'LEAD-N', 'LEAD-T', 'LEAD-F', 'LEAD-nope']) {
      for (const cookie of [staff, boss]) {
        const page = await h.get(`/dashboard/inbox/${id}`, { cookie });
        assert.equal(page.status, 404, id);
        assertLocked(page);
        const html = await page.text();
        assert.ok(!html.includes('never words') && !html.includes('team words'), id);
      }
      const reply = await replyTo(h, id, { text: 'hello there', send_id: `send-${id}-000000000000`, seen_ts: String(NOW + 60_000) }, staff);
      assert.equal(reply.status, 404, id);
    }
    assert.equal(h.evo.calls.length, 0, 'not one request reached WhatsApp');
    assert.equal(h.db.db.prepare('SELECT COUNT(*) AS n FROM wa_outbox').get().n, 0);
    assert.deepEqual(h.spy.refresh, ['LEAD-A'], 'a refused chat does not even cost an Evolution read');
  });
});

test('a lid-only chat opens but has no reply box, and a reply to it is refused unsent', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const page = await h.get('/dashboard/inbox/LEAD-L', { cookie: staff });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('hello from a lid chat'));
    assert.doesNotMatch(html, /action="\/v1\/admin\/inbox\/LEAD-L\/reply"/, 'WhatsApp gave no number to send to');
    const reply = await replyTo(h, 'LEAD-L', { text: 'hi', send_id: 'send-lid-0000000000001', seen_ts: String(NOW + 60_000) }, staff);
    assert.equal(reply.status, 409);
    assertLocked(reply);
    assert.equal(h.evo.calls.length, 0);
    assert.equal(h.inboxStore.getOutbox('send-lid-0000000000001'), null);
  });
});

/* ---------------- replying ---------------- */

test('a reply goes out once from the owner\'s number: 303 ok=sent, in the thread, handler set, audited without the words', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const page = await h.get('/dashboard/inbox/LEAD-A', { cookie: staff });
    assert.equal(page.status, 200);
    assertLocked(page);
    const html = await page.text();
    assert.ok(html.includes('Is BONA-012 still free?'));
    assert.match(html, /action="\/v1\/admin\/inbox\/LEAD-A\/reply"/);
    assert.deepEqual(h.spy.refresh, ['LEAD-A'], 'opening the thread fetched it from WhatsApp first');

    h.tick(120_000);
    const text = 'Yes it is, when can you visit';
    const res = await replyTo(h, 'LEAD-A', { text, send_id: 'send-ok-000000000000001', seen_ts: String(NOW + 60_000) }, staff);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');
    assert.deepEqual(h.spy.refresh, ['LEAD-A', 'LEAD-A'], 'and again right before the reply was checked');
    assert.equal(h.evo.calls.length, 1);
    assert.equal(h.evo.calls[0].url, 'http://evo.test/message/sendText/abdulaziz-personal');
    assert.deepEqual(h.evo.calls[0].body, { number: CLIENT, text });

    assert.equal(h.db.getLead('LEAD-A').handler_user_id, h.staffUser.user_id, 'the first to reply becomes the handler');
    const row = h.inboxStore.getOutbox('send-ok-000000000000001');
    assert.equal(row.status, 'accepted');
    assert.equal(row.key_id, 'KEY-1');
    assert.equal(row.user_id, h.staffUser.user_id);
    const mine = h.inboxStore.messagesFor('LEAD-A').find((m) => m.direction === 'out');
    assert.equal(mine.text, text);
    assert.equal(mine.sender_kind, 'staff');
    assert.equal(mine.sender_user_id, h.staffUser.user_id);

    const audited = h.app.audit.recent(50).filter((r) => r.action === 'reply_sent');
    assert.equal(audited.length, 1);
    assert.equal(audited[0].user_id, h.staffUser.user_id);
    assert.equal(audited[0].target, 'LEAD-A');
    assert.deepEqual(audited[0].meta, { status: 'accepted' });
    assert.ok(!JSON.stringify(h.app.audit.recent(50)).includes('when can you visit'), 'never the words');

    const after = await (await h.get('/dashboard/inbox/LEAD-A?ok=sent', { cookie: staff })).text();
    assert.ok(after.includes(text), 'the reply is in the thread');
  });
});

test('a double submit with one send_id sends once, whether the second click lands after the first or during it', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    h.tick(120_000);
    const form = { text: 'On my way', send_id: 'send-twice-00000000001', seen_ts: String(NOW + 60_000) };
    const first = await replyTo(h, 'LEAD-A', form, staff);
    const again = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(first.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');
    assert.equal(again.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent', 'the resubmit reports the send it repeats');
    assert.equal(h.evo.calls.length, 1);

    // The real double click: the second post arrives while the first is still at WhatsApp.
    h.tick(60_000);
    const race = { text: 'See you at five', send_id: 'send-race-000000000001', seen_ts: String(NOW + 120_000) };
    const held = h.evo.hold();
    const firstOfRace = replyTo(h, 'LEAD-A', race, staff);
    await held.reached;
    const secondOfRace = await replyTo(h, 'LEAD-A', race, staff);
    assert.equal(secondOfRace.status, 303);
    assert.equal(secondOfRace.headers.get('location'), '/dashboard/inbox/LEAD-A?error=send_uncertain', 'in flight: not sure yet, and not sent again');
    held.release();
    assert.equal((await firstOfRace).headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');

    assert.equal(h.evo.calls.length, 2, 'one request per send_id');
    assert.equal(h.inboxStore.messagesFor('LEAD-A').filter((m) => m.direction === 'out').length, 2);
    assert.equal(h.app.audit.recent(50).filter((r) => r.action === 'reply_sent').length, 2);
  });
});

test('a timeout is "not sure it went", shown as such, and resubmitting it sends nothing', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    h.tick(120_000);
    h.evo.reply = () => 'timeout';
    const form = { text: 'Calling you now', send_id: 'send-slow-000000000001', seen_ts: String(NOW + 60_000) };
    const res = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox/LEAD-A?error=send_uncertain', 'and no words in the URL');
    assert.equal(h.inboxStore.getOutbox('send-slow-000000000001').status, 'uncertain');
    assert.ok(!h.inboxStore.messagesFor('LEAD-A').some((m) => m.text === 'Calling you now'), 'not drawn as sent: it may not have gone');
    assert.deepEqual(h.app.audit.recent(50).find((r) => r.action === 'reply_sent').meta, { status: 'uncertain' });

    h.evo.reply = (n) => ({ status: 201, body: { key: { id: `KEY-${n}` } } });
    const again = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(again.headers.get('location'), '/dashboard/inbox/LEAD-A?error=send_uncertain');
    assert.equal(h.evo.calls.length, 1, 'an uncertain send is never retried');
    assert.equal((await h.get('/dashboard/inbox/LEAD-A?error=send_uncertain', { cookie: staff })).status, 200);
  });
});

test('a refused reply is drawn again with the words kept and a fresh send_id, and nothing is sent', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    await h.get('/dashboard/inbox/LEAD-A', { cookie: staff });
    // A message that arrived while the page was open, found by the refresh the reply makes.
    let played = false;
    h.spy.onRefresh = (lead) => {
      if (played || lead.lead_id !== 'LEAD-A') return;
      played = true;
      h.inboxStore.upsertMessage({
        key_id: 'A-2', lead_id: 'LEAD-A', jid: `${CLIENT}@s.whatsapp.net`, direction: 'in', sender_kind: 'client',
        text: 'Or is BONA-014 better?', ts: NOW + 90_000,
      });
    };
    const draft = 'Draft about the villa';
    const stale = await replyTo(h, 'LEAD-A', { text: draft, send_id: 'send-stale-00000000001', seen_ts: String(NOW + 60_000) }, staff);
    assert.equal(stale.status, 409, 'new activity since the page was opened');
    assertLocked(stale);
    const html = await stale.text();
    assert.ok(html.includes(draft), 'the words are still in the box');
    assert.ok(html.includes('Or is BONA-014 better?'), 'and the new message is on the page');
    assert.ok(!html.includes('send-stale-00000000001'), 'the old send_id is not handed out again');
    const fresh = fieldOf(html, 'send_id');
    assert.match(fresh, /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(fieldOf(html, 'seen_ts'), String(NOW + 90_000));

    const empty = await replyTo(h, 'LEAD-A', { text: '   ', send_id: fresh, seen_ts: String(NOW + 90_000) }, staff);
    assert.equal(empty.status, 400);

    h.team.setSetting('sending_enabled', '0');
    const off = await replyTo(h, 'LEAD-A', { text: draft, send_id: fresh, seen_ts: String(NOW + 90_000) }, staff);
    assert.equal(off.status, 503, 'the owner switched sending off');
    assert.equal(h.evo.calls.length, 0, 'none of the three reached WhatsApp');

    h.team.setSetting('sending_enabled', '1');
    h.tick(120_000);
    const sent = await replyTo(h, 'LEAD-A', { text: draft, send_id: 'send-after-00000000001', seen_ts: String(NOW + 90_000) }, staff);
    assert.equal(sent.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent');
    assert.equal(h.evo.calls.length, 1);
  });
});

test('a reply keeps its author\'s name after they leave the team, and they are no longer offered as handler', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const gone = h.team.addUser({ name: 'Hadi Former', phone: '0500000002', role: 'staff' });
    h.inboxStore.upsertMessage({
      key_id: 'A-out-1', lead_id: 'LEAD-A', jid: `${CLIENT}@s.whatsapp.net`, direction: 'out', sender_kind: 'staff',
      sender_user_id: gone.user_id, text: 'Happy to show you round', ts: NOW + 61_000,
    });
    h.team.deactivateUser(gone.user_id);
    const staff = await h.staff();
    const page = await h.get('/dashboard/inbox/LEAD-A', { cookie: staff });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('Happy to show you round'));
    assert.ok(html.includes('<bdi>Hadi Former</bdi>'), 'the bubble still names who wrote it, not just "Team"');
    assert.ok(!html.includes(`value="${gone.user_id}"`), 'but nobody can hand the chat to someone who has left');
    assert.ok(html.includes(`value="${h.staffUser.user_id}"`), 'the control: the picker is on the page');
  });
});

test('anyone on the team can hand a chat to someone else, and it is audited by id', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const to = await h.postForm('/v1/admin/inbox/LEAD-A/handler', { user_id: h.owner.user_id }, { cookie: staff });
    assert.equal(to.status, 303);
    assert.equal(to.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=handler');
    assert.equal(h.db.getLead('LEAD-A').handler_user_id, h.owner.user_id);
    const none = await h.postForm('/v1/admin/inbox/LEAD-A/handler', { user_id: '' }, { cookie: staff });
    assert.equal(none.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=handler');
    assert.equal(h.db.getLead('LEAD-A').handler_user_id, null);

    const gone = h.team.addUser({ name: 'Old Hand', phone: '0500000002', role: 'staff' });
    h.team.deactivateUser(gone.user_id);
    for (const userId of ['USR-nobody', gone.user_id]) {
      const bad = await h.postForm('/v1/admin/inbox/LEAD-A/handler', { user_id: userId }, { cookie: staff });
      assert.equal(bad.headers.get('location'), '/dashboard/inbox/LEAD-A?error=bad_handler', userId);
    }
    assert.equal(h.db.getLead('LEAD-A').handler_user_id, null);
    const refused = await h.postForm('/v1/admin/inbox/LEAD-U/handler', { user_id: h.owner.user_id }, { cookie: staff });
    assert.equal(refused.status, 404, 'not a chat anyone may pick up');

    const rows = h.app.audit.recent(50).filter((r) => r.action === 'handler');
    assert.deepEqual(rows.map((r) => r.meta).reverse(), [{ to: h.owner.user_id }, { to: null }]);
    assert.ok(rows.every((r) => r.user_id === h.staffUser.user_id && r.target === 'LEAD-A'));
  });
});

/* ---------------- the owner's moves ---------------- */

test('move, Not a client and add by phone are the owner\'s alone', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    for (const [p, fields] of [['/v1/admin/inbox/LEAD-U/move', {}], ['/v1/admin/inbox/LEAD-A/out', {}], ['/v1/admin/inbox/add', { phone: '0500000088' }]]) {
      const res = await h.postForm(p, fields, { cookie: staff });
      assert.equal(res.status, 403, p);
      assertLocked(res);
      assert.deepEqual(await res.json(), { error: 'owner_only' }, p);
    }
    assert.equal(h.db.getLead('LEAD-U').inbox_state, 'unsure');
    assert.equal(h.db.getLead('LEAD-A').inbox_state, 'in');
    assert.equal(h.inboxStore.hasMessages('LEAD-A'), true);
    assert.equal(h.db.getLeadByPhone('966500000088'), null);
    assert.deepEqual(h.spy.history, []);
    assert.ok(!h.app.audit.recent(50).some((r) => r.action.startsWith('inbox_')));
  });
});

test('the owner moves a guess into the inbox, and it brings its last 30 days', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const boss = await h.boss();
    const res = await h.postForm('/v1/admin/inbox/LEAD-U/move', {}, { cookie: boss });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox/LEAD-U?ok=moved');
    const lead = h.db.getLead('LEAD-U');
    assert.equal(lead.inbox_state, 'in');
    assert.ok(Number.isFinite(lead.inbox_since));
    assert.equal(h.spy.history.length, 1);
    assert.equal(h.spy.history[0].leadId, 'LEAD-U');
    assert.equal(h.spy.history[0].untilTs - h.spy.history[0].sinceTs, OWNER_HISTORY_MS);
    const audited = h.app.audit.recent(50).find((r) => r.action === 'inbox_move');
    assert.equal(audited.target, 'LEAD-U');
    assert.equal(audited.user_id, h.owner.user_id);
    const staff = await h.staff();
    assert.ok((await (await h.get('/dashboard/inbox', { cookie: staff })).text()).includes('Umar Unsure'), 'the team sees it now');
  });
});

test('Not a client: the chat leaves the inbox and its transcript is purged at once', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    h.inboxStore.setHandler('LEAD-A', h.staffUser.user_id);
    const boss = await h.boss();
    const res = await h.postForm('/v1/admin/inbox/LEAD-A/out', {}, { cookie: boss });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox?ok=out');
    const lead = h.db.getLead('LEAD-A');
    assert.equal(lead.inbox_state, 'out');
    assert.equal(lead.handler_user_id, null);
    assert.equal(h.inboxStore.hasMessages('LEAD-A'), false);
    assert.equal((await h.get('/dashboard/inbox/LEAD-A', { cookie: boss })).status, 404);
    assert.equal(h.app.audit.recent(50).find((r) => r.action === 'inbox_out').target, 'LEAD-A');
    // From the Unsure list it lands back on the Unsure list.
    const fromUnsure = await h.postForm('/v1/admin/inbox/LEAD-U/out', {}, { cookie: boss });
    assert.equal(fromUnsure.headers.get('location'), '/dashboard/inbox?tab=unsure&ok=out');
    assert.equal(h.db.getLead('LEAD-U').inbox_state, 'out');
  });
});

test('add by phone: a new chat joins with 30 days of history; team, never-list and bad numbers are refused', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const boss = await h.boss();
    const leadsBefore = h.db.countLeads();
    for (const [phone, error] of [['0500000001', 'excluded'], ['0500000080', 'excluded'], ['hello', 'bad_phone'], ['123456789@lid', 'bad_phone']]) {
      const res = await h.postForm('/v1/admin/inbox/add', { phone }, { cookie: boss });
      assert.equal(res.status, 303, phone);
      assert.equal(res.headers.get('location'), `/dashboard/inbox?error=${error}`, phone);
    }
    assert.equal(h.db.countLeads(), leadsBefore);
    assert.deepEqual(h.spy.history, []);

    const res = await h.postForm('/v1/admin/inbox/add', { phone: '0500000088' }, { cookie: boss });
    assert.equal(res.status, 303);
    const id = /^\/dashboard\/inbox\/(LEAD-[A-Za-z0-9-]+)\?ok=added$/.exec(res.headers.get('location'))?.[1];
    assert.ok(id, res.headers.get('location'));
    const lead = h.db.getLead(id);
    assert.equal(lead.phone_e164, '966500000088');
    assert.equal(lead.wa_jid, '966500000088@s.whatsapp.net');
    assert.equal(lead.match_method, 'owner_added');
    assert.equal(lead.inbox_state, 'in');
    assert.equal(h.spy.history.at(-1).leadId, id);
    assert.equal(h.spy.history.at(-1).untilTs - h.spy.history.at(-1).sinceTs, OWNER_HISTORY_MS);
    assert.equal(h.app.audit.recent(50).find((r) => r.action === 'inbox_add').target, id);
    assert.deepEqual(h.notes, [], 'no new-lead note to the owner for a chat he added himself');

    const known = await h.postForm('/v1/admin/inbox/add', { phone: '0500000078' }, { cookie: boss });
    assert.equal(known.headers.get('location'), '/dashboard/inbox/LEAD-U?ok=added', 'a number already on a lead brings that lead in');
    assert.equal(h.db.getLead('LEAD-U').inbox_state, 'in');
  });
});

test('adding a number to the never list takes its chat out of the inbox and purges it at once', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const boss = await h.boss();
    const res = await h.postForm('/v1/admin/never', { phone: '0500000077', note: 'cousin' }, { cookie: boss });
    assert.equal(res.headers.get('location'), '/dashboard/team?ok=never_added');
    assert.equal(h.db.getLead('LEAD-A').inbox_state, 'out');
    assert.equal(h.inboxStore.hasMessages('LEAD-A'), false);
    assert.equal((await h.get('/dashboard/inbox/LEAD-A', { cookie: boss })).status, 404);
    assert.ok(h.app.audit.recent(50).some((r) => r.action === 'inbox_out' && r.target === 'LEAD-A'));
    assert.doesNotMatch(JSON.stringify(h.app.audit.recent(50)), /500000077|cousin/);
  });
});

test('adding a colleague whose number already has a chat takes it out of the inbox and purges it at once', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const boss = await h.boss();
    const res = await h.postForm('/v1/admin/team', { name: 'Alya Now Staff', phone: '0500000077', role: 'staff' }, { cookie: boss });
    assert.equal(res.headers.get('location'), '/dashboard/team?ok=added');
    assert.equal(h.db.getLead('LEAD-A').inbox_state, 'out');
    assert.equal(h.inboxStore.hasMessages('LEAD-A'), false, 'a colleague\'s words are never kept (§3.5)');
    assert.equal((await h.get('/dashboard/inbox/LEAD-A', { cookie: boss })).status, 404);
    assert.ok(h.app.audit.recent(50).some((r) => r.action === 'inbox_out' && r.target === 'LEAD-A'));
    // A number with no chat: the person is added and nothing else moves.
    const fresh = await h.postForm('/v1/admin/team', { name: 'New Hand', phone: '0500000090', role: 'staff' }, { cookie: boss });
    assert.equal(fresh.headers.get('location'), '/dashboard/team?ok=added');
    assert.equal(h.app.audit.recent(50).filter((r) => r.action === 'inbox_out').length, 1);
    assert.equal(h.db.getLead('LEAD-U').inbox_state, 'unsure');
    assert.doesNotMatch(JSON.stringify(h.app.audit.recent(50)), /500000077|Alya/);
  });
});

/* ---------------- unread, logs ---------------- */

test('unread: the nav badge counts it on every page, and opening the thread marks it read for that person only', async () => {
  await withInbox(async (h) => {
    seedChat(h, { id: 'LEAD-A', name: 'Alya Client', messages: [
      { key_id: 'A-1', text: 'Hello', ts: NOW + 60_000 },
      { key_id: 'A-2', text: 'Is BONA-012 free?', ts: NOW + 70_000 },
    ] });
    const staff = await h.staff();
    const boss = await h.boss();
    for (const p of ['/dashboard', '/dashboard/leads', '/dashboard/spend']) {
      assert.match(await (await h.get(p, { cookie: staff })).text(), /Inbox<span class="c">2<\/span>/, p);
    }
    assert.equal((await h.get('/dashboard/inbox/LEAD-A', { cookie: staff })).status, 200);
    assert.doesNotMatch(await (await h.get('/dashboard/leads', { cookie: staff })).text(), /Inbox<span class="c">/);
    const read = h.db.db.prepare('SELECT last_read_ts FROM inbox_reads WHERE user_id = ? AND lead_id = ?').get(h.staffUser.user_id, 'LEAD-A');
    assert.equal(read.last_read_ts, NOW + 70_000, 'read up to the newest message on the page, not "now"');
    assert.match(await (await h.get('/dashboard/leads', { cookie: boss })).text(), /Inbox<span class="c">2<\/span>/, 'the owner has not read it');
  });
});

test('nothing the inbox writes to the log carries message text, a phone number or a name', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const staff = await h.staff();
    const boss = await h.boss();
    await h.get('/dashboard/inbox', { cookie: staff });
    await h.get('/dashboard/inbox/LEAD-A', { cookie: staff });
    h.tick(120_000);
    await replyTo(h, 'LEAD-A', { text: 'Secret reply words', send_id: 'send-log-0000000000001', seen_ts: String(NOW + 60_000) }, staff);
    h.evo.reply = () => 'timeout';
    await replyTo(h, 'LEAD-A', { text: 'Second secret words', send_id: 'send-log-0000000000002', seen_ts: String(NOW + 120_000) }, staff);
    await h.postForm('/v1/admin/inbox/LEAD-A/handler', { user_id: h.owner.user_id }, { cookie: staff });
    await h.postForm('/v1/admin/inbox/add', { phone: '0500000088' }, { cookie: boss });
    await h.postForm('/v1/admin/inbox/LEAD-U/move', {}, { cookie: boss });
    await h.postForm('/v1/admin/never', { phone: '0500000077' }, { cookie: boss });
    assert.ok(h.logs.some((e) => e.evt === 'dash.reply'), 'the replies were logged');
    const dump = JSON.stringify(h.logs);
    for (const secret of ['Secret reply words', 'Second secret words', 'Is BONA-012 still free?', '500000077', '500000088', '500000078', '500000001', 'Alya', 'Sara']) {
      assert.ok(!dump.includes(secret), secret);
    }
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/dashboard-inbox.test.mjs`
Expected: FAIL — all 17. `/dashboard/inbox` and `/dashboard/inbox/:id` are still "There is no such page." (404 where 200 is expected — the hostile test fails on its control, `LEAD-A` must open, and the departed-author test on its first status check); `/v1/admin/inbox/*` answers `404 {"error":"not_found"}` where 303/403/409 is expected; the never-list test finds `LEAD-A` still `in`, and so does the colleague test (`/v1/admin/team` already answers `303 ok=added`, but nothing is purged yet); the unread test finds no `Inbox<span class="c">2</span>` (routes do not set `me.unread` yet); the log test finds no `dash.reply` line.

- [ ] **Step 3: Implement** — ten edits to `services/api/lib/dashboard/routes.mjs`.

(1) Imports. Replace

```js
import { teamPage } from './render-team.mjs';
import { TeamError } from '../team.mjs';
```

with

```js
import { teamPage } from './render-team.mjs';
import { inboxPage, unsurePage, threadPage, INBOX_OK } from './render-inbox.mjs';
import { TeamError, isExcludedLead } from '../team.mjs';
import { createOrMergeLead } from '../leads.mjs';
import { normalisePhone } from '../phone.mjs';
import { randomId } from '../store.mjs';
import { replyJidFor } from '../wa-send.mjs';
import { OWNER_HISTORY_MS } from '../inbox/backfill.mjs';
```

(2) A timestamp field. Replace

```js
const posInt = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
```

with

```js
const posInt = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
/**
 * The reply form's `seen_ts`: digits from a form, a number from JSON. Anything else is
 * NaN, which the sender reads as "cannot tell what you saw" and holds as stale.
 */
const asTs = (v) => {
  if (typeof v === 'number') return v;
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{1,16}$/.test(s) ? Number(s) : NaN;
};
```

(3) The factory's options. Replace

```js
 * @param {Function} [o.sendCode]                     the shared sender's `sendTo`, for login codes
 */
export function createDashboardRoutes({
  db, cfg = {}, inventory = null, fanout = null, app = null,
  sendWhatsApp = null, probeRetell = null,
  team = null, audit = null, sendCode = null,
  auth = null, stats = null, tiktokAccounts = null, log = () => {}, now = () => Date.now(),
} = {}) {
```

with

```js
 * @param {Function} [o.sendCode]                     the shared sender's `sendTo`, for login codes
 * @param {ReturnType<import('../inbox/store.mjs').createInboxStore>} [o.inbox]     the Bona inbox; without it the inbox pages are 404
 * @param {ReturnType<import('../wa-send.mjs').createSender>} [o.sender]             the one sender; its `reply` answers a chat
 * @param {ReturnType<import('../inbox/backfill.mjs').createBackfill>} [o.backfill]  per-chat Evolution reads: refresh, join history
 */
export function createDashboardRoutes({
  db, cfg = {}, inventory = null, fanout = null, app = null,
  sendWhatsApp = null, probeRetell = null,
  team = null, audit = null, sendCode = null,
  inbox = null, sender = null, backfill = null,
  auth = null, stats = null, tiktokAccounts = null, log = () => {}, now = () => Date.now(),
} = {}) {
```

(4) A colleague's number is purged like a never-list one (§3.5). Replace

```js
  function addPerson(ctx) {
    const { fields, me } = ctx;
    return teamWrite(ctx, () => {
      const u = team.addUser({ name: asText(fields.name), phone: asText(fields.phone), role: fields.role === 'owner' ? 'owner' : 'staff' });
      audit?.record({ userId: me.user_id, action: 'team_add', target: u.user_id, meta: { role: u.role } });
    }, 'added');
  }
```

with

```js
  /**
   * A number that has just become a colleague's or a never-list one is never a client
   * (§3.5, P2-7): the chat stored under it, if any, leaves the inbox and its transcript
   * goes now, not at the next daily upkeep. Audited by lead id only. Built without the
   * inbox (older tests, tools), there is nothing stored to take out.
   */
  function leaveInboxFor(digits, me) {
    if (!inbox || !digits) return;
    const lead = db.getLeadByPhone(digits) ?? db.getLeadByJid(`${digits}@s.whatsapp.net`);
    if (!lead || lead.inbox_state === 'out') return;
    inbox.leaveInbox(lead.lead_id);
    audit?.record({ userId: me.user_id, action: 'inbox_out', target: lead.lead_id });
  }

  function addPerson(ctx) {
    const { fields, me } = ctx;
    return teamWrite(ctx, () => {
      const u = team.addUser({ name: asText(fields.name), phone: asText(fields.phone), role: fields.role === 'owner' ? 'owner' : 'staff' });
      audit?.record({ userId: me.user_id, action: 'team_add', target: u.user_id, meta: { role: u.role } });
      leaveInboxFor(u.phone_e164, me);
    }, 'added');
  }
```

(Reactivating someone or changing their role needs nothing: `team.isExcludedPhone` counts every team number, active or not, so neither can bring a number onto the team. The owner seeded from `BONA_OWNER_JID` at start-up is covered by the start-up upkeep's sweep, Task 11.)

(5) The never list purges (P2-7). Replace

```js
    return teamWrite(ctx, () => {
      team.addNever({ phone: asText(fields.phone), note: asText(fields.note), by: me.user_id });
      audit?.record({ userId: me.user_id, action: 'never_add' });
    }, 'never_added');
```

with

```js
    return teamWrite(ctx, () => {
      const row = team.addNever({ phone: asText(fields.phone), note: asText(fields.note), by: me.user_id });
      audit?.record({ userId: me.user_id, action: 'never_add' });
      leaveInboxFor(row.phone_e164, me);
    }, 'never_added');
```

(6) The inbox section and the new paths. Replace

```js
  /* -------------------- dispatch -------------------- */

  const LEAD_PATH = /^\/dashboard\/leads\/([A-Za-z0-9_-]{1,64})$/;
  const ADMIN_LEAD = /^\/v1\/admin\/leads\/([A-Za-z0-9_-]{1,64})(?:\/(stage|note))?$/;
  const ADMIN_TEAM = /^\/v1\/admin\/team\/([A-Za-z0-9_-]{1,64})\/(deactivate|reactivate|role)$/;
  const OWNER_WRITES = new Set(['/v1/admin/team', '/v1/admin/never', '/v1/admin/never/remove', '/v1/admin/settings']);
```

with

```js
  /* -------------------- the Bona inbox -------------------- */
  //
  // Phase 2 of the 2026-09-27 design (§4). Three rules hold on every route here; the
  // sender (lib/wa-send.mjs `reply`) checks the send-side ones again on its own:
  //
  //   1. A chat can be read or answered only while it is `in`, has a WhatsApp jid or lid
  //      (P2-1), and its number is neither a team member's nor on the never list (§3.5,
  //      P2-7). Anything else is the same 404, so no page tells anyone which numbers are
  //      guesses, private, or colleagues.
  //   2. Message text stays on the page it was typed on. A refused reply is drawn again
  //      with the words still in the box (P2-9); a redirect, the audit log and the
  //      process log carry ids and outcomes — never words, never numbers.
  //   3. The Unsure list, Move, Not a client and Add by phone are the owner's (D9).

  /** A colleague's or a never-list number, however the lead row holds it (lib/team.mjs). */
  const excludedLead = (lead) => isExcludedLead(team, db, lead);

  /** Rule 1: the one test every inbox read and write goes through first. */
  const openChat = (lead) => Boolean(lead && lead.inbox_state === 'in' && (lead.wa_jid || lead.wa_lid) && !excludedLead(lead));

  /**
   * The signed-in person as a page draws them: their row plus `unread`, the Inbox badge.
   * Summed over the very rows the inbox list shows, so the badge never counts a chat
   * rule 1 hides (the store's `unreadTotal` knows nothing of the team or the never list).
   * Unread chats sort first, so the list's cap only ever leaves out chats that add 0.
   * Built without the inbox (older tests, tools), the row stays as it was. A count that
   * fails is a missing badge, never a page that will not open.
   */
  function withUnread(user) {
    if (!inbox) return user;
    try {
      const rows = inbox.listInbox({ userId: user.user_id, userCreated: user.created ?? 0, limit: 1000 }).filter((l) => !excludedLead(l));
      return { ...user, unread: rows.reduce((n, r) => n + (Number(r.unread) || 0), 0) };
    } catch (err) {
      log({ level: 'warn', evt: 'dash.unread_failed', error: String(err?.message ?? err).slice(0, 200) });
      return { ...user, unread: 0 };
    }
  }

  /** `?ok=` codes the inbox pages know; own properties only, like `knownError`. */
  const inboxOk = (v) => (typeof v === 'string' && Object.hasOwn(INBOX_OK, v) ? v : null);
  const noSuchPage = (res, me) => sendHtml(res, 404, messagePage({ title: 'Not found', message: 'There is no such page.', me }));
  const notInInbox = (res, me) => sendHtml(res, 404, messagePage({ title: 'Not in the inbox', message: 'That chat is not in the Bona inbox.', me }));
  /** Rule 1's refusal for both callers: a form gets the page, JSON gets the code. */
  const refuseChat = (res, form, me) => (form ? notInInbox(res, withUnread(me)) : sendJson(res, 404, { error: 'not_in_inbox' }));
  /** One reply form's id: 24 hex characters, inside wa-send's SEND_ID_RE. */
  const newSendId = () => randomId(12);

  /**
   * Fetch the chat from WhatsApp before it is drawn or answered (P2-10), so a reply is
   * checked against what is really there rather than the last poll. The backfill bounds
   * it (amendment A2) and promises never to throw; this catch is for one that breaks the
   * promise. Either way a slow Evolution leaves the page with what is already stored.
   */
  async function refreshChat(lead) {
    if (!backfill) return;
    try {
      await backfill.refresh(lead);
    } catch (err) {
      log({ level: 'warn', evt: 'dash.refresh_failed', leadId: lead.lead_id, error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  /** The owner vouched for this chat, so it brings its last 30 days (design §4.1). */
  async function joinHistory(leadId, t) {
    if (!backfill) return;
    try {
      await backfill.history(db.getLead(leadId), { sinceTs: t - OWNER_HISTORY_MS, untilTs: t });
    } catch (err) {
      log({ level: 'warn', evt: 'dash.history_failed', leadId, error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  /**
   * Draw one chat and mark it read — up to the newest message on the page, never "now":
   * a message the poller stores a moment later with an earlier WhatsApp timestamp must
   * still count as unread. `seenTs` rides in the form for the sender's stale-view guard.
   */
  function renderThread(res, { status = 200, user, lead, draft = '', ok = null, error = null }) {
    const seenTs = inbox.newestTs(lead.lead_id) ?? 0;
    if (seenTs) inbox.markRead(user.user_id, lead.lead_id, seenTs);
    return sendHtml(res, status, threadPage({
      me: withUnread(user),
      lead,
      messages: inbox.messagesFor(lead.lead_id),
      gaps: inbox.gapsFor(lead.lead_id),
      outbox: inbox.openOutboxFor(lead.lead_id),
      // Everyone, not only the active: a reply keeps its author's name after they leave.
      // threadPage offers only active people as handlers.
      users: team.listUsers(),
      sendId: newSendId(),
      seenTs,
      sendingEnabled: team.sendingEnabled(),
      canReply: replyJidFor(lead) !== null,
      draft,
      ok: inboxOk(ok),
      error: knownError(error),
      now: now(),
    }));
  }

  function inboxList({ res, url, me }) {
    if (!inbox) return noSuchPage(res, me);
    const ok = inboxOk(url.searchParams.get('ok'));
    const error = knownError(url.searchParams.get('error'));
    if (url.searchParams.get('tab') === 'unsure') {
      if (me.role !== 'owner') return sendHtml(res, 403, messagePage({ title: 'Owners only', message: 'Only an owner can see the Unsure list.', me }));
      return sendHtml(res, 200, unsurePage({ me, rows: inbox.listUnsure().filter((l) => !excludedLead(l)), ok, error, now: now() }));
    }
    return sendHtml(res, 200, inboxPage({
      me,
      rows: inbox.listInbox({ userId: me.user_id, userCreated: me.created ?? 0 }).filter((l) => !excludedLead(l)),
      // Counted from the rows the Unsure list shows, never the store's raw `countUnsure`.
      unsureCount: me.role === 'owner' ? inbox.listUnsure({ limit: 1000 }).filter((l) => !excludedLead(l)).length : 0,
      ok,
      error,
      now: now(),
    }));
  }

  async function inboxThread({ res, url, user }, leadId) {
    if (!inbox) return noSuchPage(res, withUnread(user));
    if (!openChat(db.getLead(leadId))) return notInInbox(res, withUnread(user));
    await refreshChat(db.getLead(leadId));
    // Read again: the refresh may have learned the chat's lid or phone jid.
    const lead = db.getLead(leadId);
    if (!openChat(lead)) return notInInbox(res, withUnread(user));
    return renderThread(res, { user, lead, ok: url.searchParams.get('ok'), error: url.searchParams.get('error') });
  }

  /** How each of `sender.reply`'s refusals is answered: HTTP status, then the page's message code. */
  const REPLY_REFUSALS = {
    stale: [409, 'stale'],
    lid_only: [409, 'lid_only'],
    bad_text: [400, 'bad_text'],
    bad_send_id: [400, 'bad_send_id'],
    sending_disabled: [503, 'sending_disabled'],
    rate_limited: [429, 'reply_rate_limited'],
  };
  /** Refusals that mean the chat itself may not be answered (rule 1): no page of it is drawn. */
  const NOT_ANSWERABLE = new Set(['not_found', 'not_in_inbox', 'excluded']);

  async function inboxReply({ res, fields, form, me }, leadId) {
    if (!sender) return sendJson(res, 404, { error: 'not_found' });
    const back = `/dashboard/inbox/${encodeURIComponent(leadId)}`;
    // Asked here as well as in the sender, and before the refresh: a chat that is not in
    // the inbox must not cost an Evolution read, let alone a send.
    if (!openChat(db.getLead(leadId))) return refuseChat(res, form, me);
    await refreshChat(db.getLead(leadId));

    const text = asText(fields.text).replace(/\r\n?/g, '\n').trim();
    const out = await sender.reply({ sendId: asText(fields.send_id), leadId, userId: me.user_id, text, seenTs: asTs(fields.seen_ts) });
    const inFlight = out.duplicate && (out.status === 'pending' || out.status === 'uncertain');
    const outcome = out.ok ? 'accepted' : (out.uncertain || inFlight) ? 'uncertain' : 'failed';
    // Audited once per request that reached WhatsApp (sent, perhaps sent, or turned away
    // by it) — never a refusal made here first, never a resubmit — with the outcome only.
    const attempted = out.ok || out.uncertain || out.error === 'network' || String(out.error ?? '').startsWith('http_');
    if (!out.duplicate && attempted) {
      audit?.record({ userId: me.user_id, action: 'reply_sent', target: leadId, meta: { status: outcome } });
      log({ evt: 'dash.reply', leadId, status: outcome });
    }
    if (outcome === 'accepted') return answer(res, { form, back: `${back}?ok=sent`, status: 200, payload: { ok: true, status: outcome, send_id: out.sendId } });
    // It may well have gone. Say so and let the person look at WhatsApp: never retried,
    // and the words are not kept for a resubmit that could send them twice.
    if (outcome === 'uncertain') return answer(res, { form, back: `${back}?error=send_uncertain`, status: 202, payload: { ok: false, error: 'send_uncertain', send_id: out.sendId } });
    if (NOT_ANSWERABLE.has(out.error)) return refuseChat(res, form, me);
    const [status, error] = !out.duplicate && Object.hasOwn(REPLY_REFUSALS, out.error) ? REPLY_REFUSALS[out.error] : [502, 'send_failed'];
    if (!form) return sendJson(res, status, { error });
    const lead = db.getLead(leadId);
    if (!openChat(lead)) return notInInbox(res, withUnread(me));
    // The page again, the words still in the box and a fresh send_id: nothing in a URL (P2-9).
    return renderThread(res, { status, user: me, lead, draft: text, error });
  }

  function inboxHandler({ res, fields, form, me }, leadId) {
    const back = `/dashboard/inbox/${encodeURIComponent(leadId)}`;
    if (!openChat(db.getLead(leadId))) return refuseChat(res, form, me);
    // Anyone on the team may hand a chat to any active person, or to nobody (P2-15).
    const raw = asText(fields.user_id).trim();
    const target = raw ? team.getUser(raw) : null;
    if (raw && !(target && target.active)) return answer(res, { form, back: `${back}?error=bad_handler`, status: 400, payload: { error: 'bad_handler' } });
    const to = target ? target.user_id : null;
    inbox.setHandler(leadId, to);
    audit?.record({ userId: me.user_id, action: 'handler', target: leadId, meta: { to } });
    log({ evt: 'dash.handler', leadId });
    return answer(res, { form, back: `${back}?ok=handler`, status: 200, payload: { ok: true, handler_user_id: to } });
  }

  async function inboxMove({ res, form, me }, leadId) {
    const lead = db.getLead(leadId);
    const leadPage = `/dashboard/leads/${encodeURIComponent(leadId)}`;
    if (!lead) return answer(res, { form, back: '/dashboard/inbox?error=not_a_chat', status: 404, payload: { error: 'not_found' } });
    if (excludedLead(lead)) return answer(res, { form, back: `${leadPage}?error=excluded`, status: 400, payload: { error: 'excluded' } });
    // Nothing to read a chat by: no jid, no lid, no phone to make a jid of.
    if (!lead.wa_jid && !lead.wa_lid && !lead.phone_e164) return answer(res, { form, back: `${leadPage}?error=not_a_chat`, status: 400, payload: { error: 'not_a_chat' } });
    const t = now();
    inbox.setInboxState(leadId, 'in', { since: t });
    audit?.record({ userId: me.user_id, action: 'inbox_move', target: leadId });
    log({ evt: 'dash.inbox_move', leadId });
    await joinHistory(leadId, t);
    // A phone-only lead becomes a chat once its history names a jid; until then, the list.
    const back = openChat(db.getLead(leadId)) ? `/dashboard/inbox/${encodeURIComponent(leadId)}?ok=moved` : '/dashboard/inbox?ok=moved';
    return answer(res, { form, back, status: 200, payload: { ok: true, lead_id: leadId } });
  }

  function inboxOut({ res, form, me }, leadId) {
    const lead = db.getLead(leadId);
    if (!lead) return answer(res, { form, back: '/dashboard/inbox?error=not_a_chat', status: 404, payload: { error: 'not_found' } });
    // Not a client (design §4.1): out now, the transcript gone now, and it never comes
    // back on its own — only the owner's Move or Add brings it in again.
    const purged = inbox.leaveInbox(leadId);
    audit?.record({ userId: me.user_id, action: 'inbox_out', target: leadId });
    log({ evt: 'dash.inbox_out', leadId, messages: purged.messages });
    const back = lead.inbox_state === 'in' ? '/dashboard/inbox?ok=out' : '/dashboard/inbox?tab=unsure&ok=out';
    return answer(res, { form, back, status: 200, payload: { ok: true, purged } });
  }

  async function inboxAdd({ res, fields, form, me }) {
    const raw = asText(fields.phone);
    // A number the owner typed: never a lid or a jid, and international once normalised.
    const digits = /[@:a-zA-Z]/.test(raw) ? null : normalisePhone(raw);
    if (!digits || digits.startsWith('0')) return answer(res, { form, back: '/dashboard/inbox?error=bad_phone', status: 400, payload: { error: 'bad_phone' } });
    if (team.isExcludedPhone(digits)) return answer(res, { form, back: '/dashboard/inbox?error=excluded', status: 400, payload: { error: 'excluded' } });
    const t = now();
    // The one lead write path; `owner_added` never fans out and is born in the inbox (P2-5).
    const { lead } = createOrMergeLead(db, { phone: digits, waJid: `${digits}@s.whatsapp.net` }, {
      channel: 'whatsapp', matchMethod: 'owner_added', now: t, dataDir: cfg.dataDir,
    });
    inbox.setInboxState(lead.lead_id, 'in', { since: t });
    audit?.record({ userId: me.user_id, action: 'inbox_add', target: lead.lead_id });
    log({ evt: 'dash.inbox_add', leadId: lead.lead_id });
    await joinHistory(lead.lead_id, t);
    return answer(res, { form, back: `/dashboard/inbox/${encodeURIComponent(lead.lead_id)}?ok=added`, status: 200, payload: { ok: true, lead_id: lead.lead_id } });
  }

  /* -------------------- dispatch -------------------- */

  const LEAD_PATH = /^\/dashboard\/leads\/([A-Za-z0-9_-]{1,64})$/;
  const INBOX_PATH = /^\/dashboard\/inbox\/([A-Za-z0-9_-]{1,64})$/;
  const ADMIN_LEAD = /^\/v1\/admin\/leads\/([A-Za-z0-9_-]{1,64})(?:\/(stage|note))?$/;
  const ADMIN_TEAM = /^\/v1\/admin\/team\/([A-Za-z0-9_-]{1,64})\/(deactivate|reactivate|role)$/;
  const ADMIN_INBOX = /^\/v1\/admin\/inbox\/([A-Za-z0-9_-]{1,64})\/(reply|handler|move|out)$/;
  /** Inbox writes only an owner makes (D9); reply and handler are anyone's on the team. */
  const OWNER_INBOX_WRITES = new Set(['move', 'out']);
  const OWNER_WRITES = new Set(['/v1/admin/team', '/v1/admin/never', '/v1/admin/never/remove', '/v1/admin/settings', '/v1/admin/inbox/add']);
```

(7) Every signed-in page carries `unread`; the thread is dispatched before it. Replace

```js
    /* --- everything else needs a signed-in, active member --- */
    const me = currentUser(req);
    if (!me) return toLogin(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });

    if (p === '/dashboard') return overview({ res, url, me });
```

with

```js
    /* --- everything else needs a signed-in, active member --- */
    const user = currentUser(req);
    if (!user) return toLogin(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
    // A thread marks itself read before it is drawn, so it counts its own badge.
    const threadMatch = INBOX_PATH.exec(p);
    if (threadMatch) return inboxThread({ res, url, user }, threadMatch[1]);
    // Every other signed-in page carries the person's unread count for the Inbox badge.
    const me = withUnread(user);

    if (p === '/dashboard') return overview({ res, url, me });
```

(8) The list page. Replace

```js
    if (p === '/dashboard/team') return teamView({ res, url, me });
    return sendHtml(res, 404, messagePage({ title: 'Not found', message: 'There is no such page.', me }));
```

with

```js
    if (p === '/dashboard/team') return teamView({ res, url, me });
    if (p === '/dashboard/inbox') return inboxList({ res, url, me });
    return sendHtml(res, 404, messagePage({ title: 'Not found', message: 'There is no such page.', me }));
```

(9) Which admin writes exist, and which are the owner's. Replace

```js
    const teamMatch = ADMIN_TEAM.exec(p);
    const ownerWrite = Boolean(teamMatch || tiktokMatch) || OWNER_WRITES.has(p);
    const writes = (leadMatch && leadMatch[2]) || (p === '/v1/admin/spend' ? 'spend' : null) || (ownerWrite ? 'team' : null);
    if (!writes) return sendJson(res, 404, { error: 'not_found' });
```

with

```js
    const teamMatch = ADMIN_TEAM.exec(p);
    const inboxMatch = ADMIN_INBOX.exec(p);
    const ownerWrite = Boolean(teamMatch || tiktokMatch || OWNER_WRITES.has(p) || (inboxMatch && OWNER_INBOX_WRITES.has(inboxMatch[2])));
    const writes = (leadMatch && leadMatch[2]) || (p === '/v1/admin/spend' ? 'spend' : null)
      || ((inboxMatch || p === '/v1/admin/inbox/add') ? 'inbox' : null) || (ownerWrite ? 'team' : null);
    if (!writes) return sendJson(res, 404, { error: 'not_found' });
```

(10) The owner gate names the path without an id; the inbox writes are dispatched. Replace

```js
    if (ownerWrite && me.role !== 'owner') {
      log({ level: 'warn', evt: 'dash.owner_only', path: teamMatch ? '/v1/admin/team/:id' : p });
      return sendJson(res, 403, { error: 'owner_only' });
    }

    const ctx = { res, fields: parsed.fields, form: parsed.form, me };
    if (tiktokMatch) return tiktokWrite({ ...ctx, req }, tiktokMatch[1]);
```

with

```js
    if (ownerWrite && me.role !== 'owner') {
      const shown = teamMatch ? '/v1/admin/team/:id' : inboxMatch ? `/v1/admin/inbox/:id/${inboxMatch[2]}` : p;
      log({ level: 'warn', evt: 'dash.owner_only', path: shown });
      return sendJson(res, 403, { error: 'owner_only' });
    }

    const ctx = { res, fields: parsed.fields, form: parsed.form, me };
    if (tiktokMatch) return tiktokWrite({ ...ctx, req, me: withUnread(me) }, tiktokMatch[1]);
    if (writes === 'inbox') {
      // index.mjs always wires the inbox; routes built without it (older tests, tools) have none.
      if (!inbox) return sendJson(res, 404, { error: 'not_found' });
      if (!inboxMatch) return inboxAdd(ctx);
      const [, leadId, what] = inboxMatch;
      if (what === 'reply') return inboxReply(ctx, leadId);
      if (what === 'handler') return inboxHandler(ctx, leadId);
      if (what === 'move') return inboxMove(ctx, leadId);
      return inboxOut(ctx, leadId);
    }
```

- [ ] **Step 4: Run the tests**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/dashboard-inbox.test.mjs`
Expected: PASS (17 tests).

- [ ] **Step 5: Run the dashboard suites, then the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/dashboard-routes.test.mjs api/test/dashboard-inbox.test.mjs`
Expected: PASS — `withTeamRoutes` builds the routes without an inbox (no badge, inbox pages 404, never-list and team adds unchanged); `withDash` builds them through createApp (inbox wired, badge absent at 0 unread).

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/dashboard/routes.mjs services/api/test/dashboard-inbox.test.mjs
git commit -m "dashboard: the Bona inbox — list, Unsure, thread, reply once, handler, move/out/add, never-list and team-add purge, unread badge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Privacy page and README say what the Bona inbox does

P2-12: the site's privacy page says what Phase 2 does from the day it ships — Bona stores its
WhatsApp conversations with clients, the owner and authorised team members read and answer
them from a private dashboard, they are kept up to 5 years after the last message and then
deleted automatically, copies stay in the WhatsApp service our number runs on and on our phones,
and how to ask for deletion. Dana is not mentioned: that sentence ships with Phase 4, when it
becomes true. The page promises that "material changes will be flagged here for 30 days", so the
*Changes* section gets a dated line too. `services/README.md` gets the operator's view of the same
thing under `### Dashboard`, plus the lines elsewhere in it that Phase 2 made wrong (the 45 s poll
default, the 500-message truncation).

No runtime code changes here. The site is not deployed by `deploy.sh`: `src/data/privacy.json` goes
live through `.github/workflows/deploy.yml` (GitHub Pages) when the phase is merged to `main`.

**Files:**
- Create: `scripts/test/privacy-policy.test.mjs`
- Modify: `src/data/privacy.json` (new section `whatsapp-conversations` right after `whatsapp-enquiries`; a dated line in `changes`)
- Modify: `services/README.md` (§4 env table, §8 data files, §10 Store and Poller, `### Dashboard` → **Inbox** and its routes)

- [ ] **Step 1: Write the failing test** — create `scripts/test/privacy-policy.test.mjs`:

```js
// src/data/privacy.json — the policy the site renders at /privacy/ and /ar/privacy/.
// PrivacyPage.astro quietly drops a section with no id or heading and falls back to English
// for a missing Arabic body, so a broken entry would ship as a hole nobody sees in review.
// The WhatsApp conversations section is what Phase 2 of the team inbox (2026-09-27 design
// §4.6) has to say before a single transcript is stored: what is kept, who reads it, for
// how long, where other copies stay, and how to have it deleted. Dana is left out of it on
// purpose until she answers on WhatsApp (Phase 4) — a policy that promises what the service
// does not do is as wrong as one that hides what it does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const policy = read('../../src/data/privacy.json');
const site = read('../../src/data/site.json');
const section = (id) => policy.sections.find((s) => s.id === id);
const body = (s, locale) => s.body[locale].join(' ');

test('every section has an id, both headings and the same number of EN and AR paragraphs', () => {
  assert.match(policy.updated, /^\d{4}-\d{2}-\d{2}$/);
  const ids = policy.sections.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'section ids are the page anchors, so they must be unique');
  for (const s of policy.sections) {
    assert.match(s.id, /^[a-z0-9-]+$/, `${s.id}: the page rewrites anything else in an id`);
    for (const locale of ['en', 'ar']) {
      assert.equal(typeof s.heading?.[locale], 'string', `${s.id} heading.${locale}`);
      assert.ok(s.heading[locale].trim(), `${s.id} heading.${locale} is empty`);
      assert.ok(Array.isArray(s.body?.[locale]) && s.body[locale].length > 0, `${s.id} body.${locale}`);
      for (const p of s.body[locale]) assert.ok(typeof p === 'string' && p.trim(), `${s.id} body.${locale} has an empty paragraph`);
    }
    assert.equal(s.body.en.length, s.body.ar.length, `${s.id}: the Arabic text is the authoritative one, so it says everything the English does`);
  }
});

test('the WhatsApp conversations section says what is stored, who reads it, for how long and how to have it deleted', () => {
  const s = section('whatsapp-conversations');
  assert.ok(s, 'Phase 2 stores WhatsApp transcripts; the policy has to say so before it does');
  const ids = policy.sections.map((x) => x.id);
  assert.equal(ids.indexOf('whatsapp-conversations'), ids.indexOf('whatsapp-enquiries') + 1, 'it follows the WhatsApp enquiries section it extends');
  assert.ok(policy.updated >= '2026-09-28', 'the date at the top is the version date and must move with a material change');

  const en = body(s, 'en');
  assert.match(en, /stores that conversation/);
  assert.match(en, /authorised members of the Bona team/);
  assert.match(en, /private dashboard/);
  assert.match(en, /five years after its last message/);
  assert.match(en, /deleted automatically/);
  assert.match(en, /on our phones/, 'the copies bona.db retention does not govern are named, not hidden');
  assert.match(en, /WhatsApp’s own terms/);

  const ar = body(s, 'ar');
  assert.match(ar, /تحتفظ بونا بتلك المحادثة/);
  assert.match(ar, /فريق بونا/);
  assert.match(ar, /لوحة خاصة/);
  assert.match(ar, /خمس سنوات/);
  assert.match(ar, /تلقائي/);
  assert.match(ar, /هواتفنا/);
  assert.match(ar, /شروط واتساب/);

  // The deletion route is the one the page's contact block and buttons offer (site.json).
  for (const text of [en, ar, policy.contact.en, policy.contact.ar]) {
    assert.ok(text.includes(site.whatsapp.display), 'WhatsApp number');
  }
  assert.ok(en.includes(site.phone.display) && ar.includes(site.phone.display), 'phone number');
});

test('Dana is not named in that section until she answers on WhatsApp (Phase 4)', () => {
  const s = section('whatsapp-conversations');
  assert.ok(s, 'the section is missing');
  const all = [s.heading.en, s.heading.ar, body(s, 'en'), body(s, 'ar')].join(' ');
  assert.doesNotMatch(all, /\bDana\b|دانة|دانا|\bAI\b|artificial intelligence|الذكاء الاصطناعي|المساعد الذكي|الكونسيرج/i);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox && node --test scripts/test/privacy-policy.test.mjs`
Expected: FAIL — `ℹ pass 1`, `ℹ fail 2`. The shape test passes on today's file (every section already has both languages with matching paragraph counts); the other two fail with `Phase 2 stores WhatsApp transcripts; the policy has to say so before it does` and `the section is missing`, because there is no section with id `whatsapp-conversations` yet.

- [ ] **Step 3: Add the section** — in `src/data/privacy.json`:

Find (verbatim, once) in `src/data/privacy.json`:
```json
    },
    {
      "id": "ai-concierge",
```
Replace with:
```json
    },
    {
      "id": "whatsapp-conversations",
      "heading": {
        "en": "WhatsApp conversations with our team",
        "ar": "محادثات واتساب مع فريق بونا"
      },
      "body": {
        "en": [
          "When you contact Bona on WhatsApp about a property or an enquiry, or when we write to you about one, Bona stores that conversation — your messages and our replies — so that we can serve your enquiry. For a photo, voice note or file we keep only a note of its type, a document’s file name and any caption, not the item itself. Private chats on the same number are not stored, and if a conversation turns out not to be about a Bona enquiry, the messages we stored from it are deleted straight away.",
          "The owner of Bona and authorised members of the Bona team can read these conversations and reply to you through a private dashboard that requires sign-in. Replies sent from the dashboard come from Bona’s WhatsApp number, +966 59 329 6933, and the dashboard records which team member sent each one.",
          "We keep a stored conversation for up to five years after its last message; it is then deleted automatically. The five years apply to the messages; your enquiry record itself follows “How long we keep it” below. A copy of the conversation also stays in the WhatsApp service our number runs on and on our phones, under WhatsApp’s own terms, and the automatic deletion does not reach those copies. To ask for a conversation to be deleted, message us on WhatsApp or call us on +966 59 329 6933; see “Your rights” below."
        ],
        "ar": [
          "عندما تتواصل مع بونا عبر واتساب بشأن عقار أو استفسار، أو عندما نراسلك نحن بشأنه، تحتفظ بونا بتلك المحادثة — رسائلك وردودنا عليها — لخدمة استفسارك. وبالنسبة للصور والرسائل الصوتية والملفات، لا نحتفظ إلا بإشارة إلى نوعها، وباسم المستند، وبأي نص مرفق بها، دون المحتوى نفسه. ولا نحتفظ بالمحادثات الخاصة على الرقم نفسه، وإذا تبيّن أن محادثةً ما لا تتعلق باستفسار لدى بونا، حُذفت الرسائل التي حفظناها منها فوراً.",
          "ويمكن لمالك المنشأة وأعضاء فريق بونا المخوّلين قراءة هذه المحادثات والرد عليك من خلال لوحة خاصة تتطلب تسجيل الدخول. وتصلك الردود المرسلة من اللوحة من رقم واتساب بونا +966 59 329 6933، وتسجّل اللوحة عضو الفريق الذي أرسل كل ردّ منها.",
          "نحتفظ بالمحادثة مدةً أقصاها خمس سنوات بعد آخر رسالة فيها، ثم تُحذف تلقائياً. وتسري هذه المدة على الرسائل، أما سجل الاستفسار نفسه فيخضع لما ورد في «مدة الاحتفاظ بالبيانات» أدناه. وتبقى نسخة من المحادثة كذلك في خدمة واتساب التي يعمل عليها رقمنا وعلى هواتفنا، وفق شروط واتساب الخاصة، ولا يشمل الحذف التلقائي تلك النسخ. ولطلب حذف محادثة، راسلنا على واتساب أو اتصل بنا على الرقم +966 59 329 6933، وانظر «حقوقك» أدناه."
        ]
      }
    },
    {
      "id": "ai-concierge",
```

Then flag the change in the *Changes to this policy* section, as the page promises (both languages; remove these two lines again on or after 2026-10-28, when the 30 days are up — the test does not pin them, so removing them needs no test change).

Find (verbatim, once) in `src/data/privacy.json`:
```json
          "We will update this page when our practices change, for example if we enable analytics or change how we handle your data. The date at the top shows the current version; material changes will be flagged here for 30 days."
        ],
```
Replace with:
```json
          "We will update this page when our practices change, for example if we enable analytics or change how we handle your data. The date at the top shows the current version; material changes will be flagged here for 30 days.",
          "28 September 2026: we added “WhatsApp conversations with our team”. Bona now stores its WhatsApp conversations with clients about their enquiries, and authorised team members can read and answer them from a private dashboard."
        ],
```

Find (verbatim, once) in `src/data/privacy.json`:
```json
          "سنحدّث هذه الصفحة عند تغيّر ممارساتنا، مثلاً إذا فعّلنا أدوات التحليل أو غيّرنا طريقة تعاملنا مع بياناتك. ويُبيّن التاريخ في أعلى الصفحة الإصدار الحالي. وسنشير إلى التغييرات الجوهرية في هذه الصفحة لمدة ثلاثين يوماً."
        ]
```
Replace with:
```json
          "سنحدّث هذه الصفحة عند تغيّر ممارساتنا، مثلاً إذا فعّلنا أدوات التحليل أو غيّرنا طريقة تعاملنا مع بياناتك. ويُبيّن التاريخ في أعلى الصفحة الإصدار الحالي. وسنشير إلى التغييرات الجوهرية في هذه الصفحة لمدة ثلاثين يوماً.",
          "28 سبتمبر 2026: أضفنا قسم «محادثات واتساب مع فريق بونا». فقد أصبحت بونا تحتفظ بمحادثات واتساب مع عملائها بشأن استفساراتهم، ويمكن لأعضاء فريقها المخوّلين قراءتها والرد عليها من خلال لوحة خاصة."
        ]
```

Leave `"updated": "2026-09-28"` as it is: `origin/main` (51c3802) already carries that date and it is the day this phase is built. If the phase merges on a later day, set it to the merge day — the page shows it as the version date and in its JSON-LD `dateModified`, and the test only requires it to be 2026-09-28 or later.

- [ ] **Step 4: Run the test and check the JSON**

Run: `cd /home/azoz778/bona-wt/team-inbox && node --test scripts/test/privacy-policy.test.mjs`
Expected: PASS (3 tests, `ℹ fail 0`).

Run: `cd /home/azoz778/bona-wt/team-inbox && node -e "const p = JSON.parse(require('fs').readFileSync('src/data/privacy.json', 'utf8')); console.log(p.updated, p.sections.length, p.sections.map((s) => s.id).join(' '))"`
Expected: `2026-09-28 15 who-we-are what-this-site-collects whatsapp-enquiries whatsapp-conversations ai-concierge data-we-hold legal-basis retention sharing internal-dashboard international-transfers your-rights children security changes`

- [ ] **Step 5: README** — eight exact replacements in `services/README.md`, in six places (a)–(f).

(a) §4, the environment table: the poll default is 20 s now (P2-11).

Find (verbatim, once) in `services/README.md`:
```markdown
| `BONA_WA_POLL_MS` | `45000` | poll interval; each tick reads the last 2 minutes of `chat/findMessages` |
```
Replace with:
```markdown
| `BONA_WA_POLL_MS` | `20000` | poll interval; each tick reads the last 2 minutes of `chat/findMessages`. 20 s since Phase 2 of the team inbox (it was 45 s); the VPS sets it in `bona-services.env`, and a value there wins over this default |
```

(b) §8, the data files table: `bona.db` now holds the inbox.

Find (verbatim, once) in `services/README.md`:
```markdown
WhatsApp poller cursor, ad spend, fan-out queue, dashboard logins. Migrations run on start
```
Replace with:
```markdown
WhatsApp poller cursor, ad spend, fan-out queue, dashboard logins, the WhatsApp inbox (transcripts, outbox, read marks, gaps). Migrations run on start
```

(c) §10 **Store**: say where the transcripts live.

Find (verbatim, once) in `services/README.md`:
```markdown
touchpoints, stage history, spend, fan-out queue, dashboard auth. The JSONL files stay as
```
Replace with:
```markdown
touchpoints, stage history, spend, fan-out queue, dashboard auth, and the transcripts of
the chats in the Bona inbox (Dashboard → Inbox, below). The JSONL files stay as
```

(d) §10 **Poller**: windows are read by `readWindow` now (P2-3), in two places.

Find (verbatim, once) in `services/README.md`:
```markdown
lte: <now> } }` — both bounds, because 2.3.7 ignores the filter without them — up to 5
pages of 100, newest first, deduplicated on `key.id` (`wa_seen`, pruned after 7 days).
```
Replace with:
```markdown
lte: <now> } }` — both bounds, because 2.3.7 ignores the filter without them — read by
`readWindow`: pages of 100, newest first, up to 5, and a window whose `total` is larger than
that is split in halves by time instead (below); deduplicated on `key.id` (`wa_seen`,
pruned after 7 days).
```

Find (verbatim, once) in `services/README.md`:
```markdown
(`wa.poll.abandoned`). Windows are read newest-first inside Evolution, so one holding more
than 500 messages hides its *oldest* ones and cannot be asked again for them — that is a
loss, not a deferral, and the log says `wa.poll.truncated`. It takes downtime long enough
for 500 messages to pile up in a single window.
```
Replace with:
```markdown
(`wa.poll.abandoned`). Evolution answers newest-first and 5 pages of 100 is the cap, so a
window holding more than 500 messages would hide its *oldest* ones. Its answer says how many
the window holds (`total`), so `readWindow` (`lib/evolution.mjs`) splits such a window in
halves on whole-second boundaries, at most 4 levels deep (16 pieces, about 8,000 messages),
and hands the pieces over oldest-first. Only a piece still over the cap at the deepest level
is read partially — a loss, not a deferral, because asking again returns the same newest
pages — and the log says `wa.poll.truncated` with the number missed. That takes downtime long
enough for thousands of messages to pile up in one window. An answer without a `total` falls
back to reading pages until a short one.
```

(e) §10, the match paragraph: the 200-character snippet is no longer the only text kept.

Find (verbatim, once) in `services/README.md`:
```markdown
characters are kept on the touchpoint of a *new* lead only. You get the note once, on
```
Replace with:
```markdown
characters are kept on the touchpoint of a *new* lead only (a chat in the Bona inbox keeps its
whole conversation as well — Dashboard → Inbox, below). You get the note once, on
```

(f) `### Dashboard`: the whole number is also shown on a thread's header, then the **Inbox** paragraphs, then the inbox routes in the route table.

Find (verbatim, once) in `services/README.md`:
```markdown
on `GET /dashboard/leads/:id` and `GET /v1/admin/leads/:id`.
```
Replace with:
```markdown
on `GET /dashboard/leads/:id`, `GET /v1/admin/leads/:id` and the header of a chat
(`GET /dashboard/inbox/:leadId`).

**Inbox (since 2026-09).** `GET /dashboard/inbox` is where the team reads and answers the
Bona chats on the owner's number (design §4, 2026-09-27). A *chat* is a lead with a `wa_jid`
or a `wa_lid`. Whether it belongs is **stored** in `leads.inbox_state` (`in`, `unsure`,
`out`) and never re-derived, so a guess cannot slip in later through the `phone` rule:

- *Certain*: an inbound message with a Ref code, click-to-WhatsApp ad context or a listing
  id (`BONA-###`, `BONA-W###`) puts the chat `in` by itself, together with the 24 h of that
  chat before it (the "Hi" before the Ref line). Web-form and concierge leads are certain
  too; they become a chat once that person writes on WhatsApp.
- *Unsure*: only the word Bona/بونا, or only the ±15-min click window. The lead is kept for
  the statistics as before and goes to the owner-only **Unsure** tab (`?tab=unsure`; staff
  get 403), where *Move to Bona inbox* or *Not a client* settles it.
- *Owner-started*: the owner's own message in a 1:1 chat that carries a Bona site link
  (`bona-real-estate.com`, legacy `bona.azoz.uk`), a listing id, or a document whose name or
  caption says Bona or a listing id, puts that chat `in` (a new lead gets `match_method =
  'owner_outbound'`) with the 24 h before it. Nothing else he types counts — TK and private
  chats share the number. These leads fan out to no ad platform (no click is behind them),
  send him no new-lead note, and are born answered (`first_reply_ts` set, `first_inbound_ts`
  empty), so neither the waiting queue nor the Hermes `bona-unanswered-leads` watchdog flags
  them.
- *Owner buttons*: *Move to Bona inbox* (Unsure tab or the lead page) and *Add chat by phone
  number* (`owner_added`) put a chat `in` and pull its last 30 days — he vouched for it.
  *Not a client* puts it `out`: its transcript is purged there and then, and it never comes
  back on its own.
- *Never*: team numbers and the never-a-client list are not matched, stored or shown.
  Adding a number to the never list moves its lead `out` and purges its transcript at once,
  and every inbox page also refuses an excluded number.

Schema v4 sorted the leads that already existed: `in` for `ref` / `ad_meta`, for web-form and
concierge leads that are not legacy imports, and for a listing id in the first snippet;
everything else `unsure`, for the owner to settle (expected on the live db at the Phase 2
deploy: 18 in, 9 unsure).

*What is stored* (`wa_messages`, `in` chats only): every message in both directions and who
sent it — the client, a team member (by user id), Dana (from Phase 4), or `owner_number`
(typed on the owner's phone, or sent for him by Lisa: WhatsApp cannot tell those apart).
Text is capped at 8,000 characters. Media are placeholders only (`[voice note]`, `[audio]`,
`[image]`, `[video]`, `[document: name]`, `[location]`, `[contact]`, `[sticker]`, else
`[message]`) plus the caption, never the file. Reactions, deletes and edits, poll votes and
key-distribution records are noise and are never stored. Evolution files one conversation
under two jids — what arrives and what the owner types under the `@lid`, what the API sends
to a number under the phone jid — so every per-chat read (join history, opening a thread,
the check before a reply) asks for both and de-duplicates on `key.id`. A message the poller
writes off after three tries becomes a `wa_gaps` row, shown in the thread as a message that
could not be loaded, instead of vanishing. Unread means inbound messages newer than the last
time that person opened the thread (a new member starts from the day the account was made);
the total is the Inbox count in the nav.

*Retention.* Five years after a chat's last message (`leads.last_msg_ts`) its transcript —
messages, reply outbox rows, gaps and read marks — is deleted; the lead row stays for
attribution. *Not a client* and a never-list add purge at once. A login code's outbox row
never holds the code (`text` is NULL) and is pruned after 2 days. The privacy page says all
of this, including the copies that stay in Evolution's own database and on the phones, which
this retention does not reach.

*Replies* go out from the owner's number (`BONA_WA_INSTANCE`) and only into `in` chats.
`POST /v1/admin/inbox/:leadId/reply` sends to the lead's **phone** jid (`…@s.whatsapp.net`);
a chat known only by its `@lid` is refused (`lid_only`) and answered from the phone, because
`lid` digits are not a phone number. Every reply passes the gate the login codes pass
(`lib/wa-send.mjs`): the Sending switch, 20 a minute overall, 6 a minute per recipient,
30 a minute per person, and 500 a day — counted from `wa_outbox` over a rolling 24 h
(messages to the owner's own chat do not count), so a restart does not reset it. The form
carries a random `send_id`, and its outbox row is written before the HTTP call, so a double
submit gets the first answer back, never a second message. A reply is `accepted` only when
Evolution answers with a `key.id`. A timeout, a 502/504 or a 2xx without an id is
`uncertain`: the thread says to check WhatsApp, the text is not put back (it may have gone),
and nothing retries it. When the message turns up in a poll the row is settled — by its
`key.id`, or else the same lead and the same text within 2 minutes — and the bubble gets its
sender; a row interrupted by a restart becomes `uncertain` (`interrupted`). The form also
carries the newest message time the person saw, and the chat is refreshed from Evolution
just before the check: anything newer, in either direction, holds the reply (`stale`) with
the text kept in the box. The first person to reply becomes the chat's handler when it has
none (a reply typed on the owner's phone makes the owner the handler); anyone can hand it to
another active member or to nobody. Audit rows `reply_sent`, `handler`, `inbox_move`,
`inbox_out` and `inbox_add` carry ids and a status — never text or a number. The first real
client reply from the dashboard is sent with the owner beside it (design D14).

*Polling and upkeep.* The poller runs every 20 s (`BONA_WA_POLL_MS`, §4). The VPS sets it in
`~/.secrets/bona-services.env`, and a value there wins over the default — a stale
`BONA_WA_POLL_MS=45000` keeps the old pace. Opening a thread also reads that chat at once,
but only messages since 24 h before it joined the inbox, and never for more than ~3 s.
Inbox upkeep (`app.inboxMaintenance()`) runs at start-up and then every 24 h: the 5-year
purge, login-code rows older than 2 days, and `pending` sends older than 2 minutes marked
`uncertain` (a process that died mid-send cannot know whether the message went); then every
`in` chat with nothing stored yet fetches the history an automatic join takes (logged
`inbox.catchup`). That is how the chats schema v4 put `in` get a thread on day one; one whose
history comes back empty stays empty and is asked again on the next run.
```

Find (verbatim, once) in `services/README.md`:
```markdown
| `POST /v1/admin/spend` | `{day, platform, campaign_id, campaign_name, spend_sar, clicks?, impressions?}`, upserted on `(day, platform, campaign_id)` |
```
Replace with:
```markdown
| `POST /v1/admin/spend` | `{day, platform, campaign_id, campaign_name, spend_sar, clicks?, impressions?}`, upserted on `(day, platform, campaign_id)` |
| `GET /dashboard/inbox` | the Bona chats, unread first, then newest: name, masked number, last message, stage, handler, *Needs a human*. The owner also gets the **Unsure** tab (`?tab=unsure`; 403 for staff) and *Add chat by phone number* |
| `GET /dashboard/inbox/:leadId` | one chat, refreshed from Evolution first and then marked read: bubbles labelled client / team member / Dana / the owner's number, gaps, sends still open, the reply box and the handler picker; the number in full in the header. 404 unless it is an `in` chat and not excluded |
| `POST /v1/admin/inbox/:leadId/reply` | any member: one reply through the shared gate. Sent → 303 to the thread `?ok=sent`; uncertain → 303 `?error=send_uncertain`; any other refusal renders the thread again with the text kept and a fresh `send_id` — never a redirect with message text in the URL |
| `POST /v1/admin/inbox/:leadId/handler` | any member: hand the chat to an active member, or to nobody |
| `POST /v1/admin/inbox/:leadId/move` · `…/out` | owner: *Move to Bona inbox* (pulls 30 days) · *Not a client* (`out`, transcript purged now) |
| `POST /v1/admin/inbox/add` | owner: *Add chat by phone number* — creates or reuses the lead (`owner_added`), puts it `in`, pulls 30 days |
```

- [ ] **Step 6: Check the README edits landed**

Run: `cd /home/azoz778/bona-wt/team-inbox && grep -c -e '^\*\*Inbox (since 2026-09)\.\*\*' -e '^| `BONA_WA_POLL_MS` | `20000`' -e '^| `GET /dashboard/inbox/:leadId` |' -e 'at most 4 levels deep' -e 'dashboard logins, the WhatsApp inbox' services/README.md`
Expected: `5`

- [ ] **Step 7: Run the suites**

Run: `cd /home/azoz778/bona-wt/team-inbox && npm test`
Expected in this worktree: `ℹ tests 142`, `ℹ pass 140`, `ℹ fail 2`. The two failures are `scripts/test/approval-package.test.mjs` and `scripts/test/social-quality.test.mjs`, which cannot load the `sharp` package: this worktree has no `node_modules` (the same 2 fail at 51c3802 before this task — 139 tests, 137 pass). Do not install anything to fix them; they do not read `privacy.json`. For a clean gate without them:

Run: `cd /home/azoz778/bona-wt/team-inbox && node --test $(ls scripts/test/*.test.mjs | grep -v -e approval-package -e social-quality)`
Expected: `ℹ tests 140`, `ℹ pass 140`, `ℹ fail 0`.

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, `ℹ fail 0` — the same count as after Task 12 (this task adds no services test and no services test reads the README or the privacy page).

- [ ] **Step 8: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add scripts/test/privacy-policy.test.mjs src/data/privacy.json services/README.md
git commit -m "Privacy page and README: say what the Bona inbox stores and who reads it

The privacy page gets a WhatsApp conversations section (EN + AR): what is
stored, who can read and reply, five years after the last message, the copies
in the WhatsApp service and on our phones, and how to ask for deletion. Dana
stays out of it until Phase 4. The README documents the inbox for the
operator and corrects the poll default and the truncation note.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Dashboard replies ship switched off; the owner turns them on (D14)

Why this is its own task: after the deploy (Task 15, Step 9), every signed-in team member can open the inbox, and Sending is on by default (`SETTINGS_DEFAULTS.sending_enabled = '1'`, 2 staff exist). Without a switch of its own, a staff member could send the first real client message from the dashboard before the owner has been asked, and D14 says that first message happens with him. So replies ship **off**. A new owner setting, `inbox_replies`, defaults to `'0'` and fails closed like `sending_enabled`. While it is off: the thread draws a sentence where the reply box would be, `sender.reply` refuses `{ ok: false, error: 'replies_off' }` before it writes anything, and the route answers 503. The owner turns it on with one button on the Team page (owner-only, audited `setting`) at the STOP in Task 15. It is not the Sending switch: login codes still go while replies are off, so staff can still sign in and read the inbox.

No migration: the `settings` table exists since v3, and a missing row reads as the default `'0'`. Dana (Phase 4) sends through `sendTo` under her own `dana_enabled` switch, so this switch only covers `reply`.

**Files:**
- Modify: `services/api/lib/team.mjs` (`inbox_replies` in `SETTINGS_DEFAULTS`/`SETTINGS_ALLOWED`, `repliesEnabled()`)
- Modify: `services/api/lib/wa-send.mjs` (`reply` refuses `replies_off` right after the send-id checks)
- Modify: `services/api/lib/dashboard/render-inbox.mjs` (`threadPage` gains `repliesEnabled = false`)
- Modify: `services/api/lib/dashboard/render.mjs` (`MESSAGES.replies_off`)
- Modify: `services/api/lib/dashboard/render-team.mjs` (the Team page switch)
- Modify: `services/api/lib/dashboard/routes.mjs` (Team page and thread pass the switch; `saveSetting` takes either switch; `replies_off` → 503)
- Modify: `services/README.md` (the Replies paragraph Task 13 wrote)
- Test: `services/api/test/team.test.mjs` (one test)
- Test: `services/api/test/wa-send.test.mjs` (the harness turns replies on; one test)
- Test: `services/api/test/dashboard-render-inbox.test.mjs` (the `thread()` helper passes `repliesEnabled: true`; one test)
- Test: `services/api/test/dashboard-render-team.test.mjs` (one test)
- Test: `services/api/test/dashboard-inbox.test.mjs` (the `withInbox` harness turns replies on; one test)

- [ ] **Step 1: Write the failing test for the setting**

In `services/api/test/team.test.mjs`, find:

```js
  assert.equal(codeOf(() => team.setSetting('dana_enabled', '1')), 'bad_setting', 'Phase 4 adds that key');
  s.close();
});
```

Replace with:

```js
  assert.equal(codeOf(() => team.setSetting('dana_enabled', '1')), 'bad_setting', 'Phase 4 adds that key');
  s.close();
});

test('replies to clients from the dashboard ship off, go on only with an exact "1", and fail closed', () => {
  const { s, team } = teamHarness();
  assert.equal(team.getSetting('inbox_replies'), '0');
  assert.equal(team.repliesEnabled(), false, 'off until the owner turns them on (design D14)');
  assert.equal(team.sendingEnabled(), true, 'a separate switch: login codes do not wait for it');
  team.setSetting('inbox_replies', '1', { by: 'USR-1' });
  assert.equal(team.repliesEnabled(), true);
  assert.equal(s.db.prepare("SELECT updated_by FROM settings WHERE key = 'inbox_replies'").get().updated_by, 'USR-1');
  team.setSetting('inbox_replies', '0');
  assert.equal(team.repliesEnabled(), false);
  assert.equal(codeOf(() => team.setSetting('inbox_replies', 'yes')), 'bad_setting_value');
  assert.equal(codeOf(() => team.setSetting('inbox_replies', '')), 'bad_setting_value');
  s.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated, updated_by) VALUES ('inbox_replies','true',?,NULL)").run(NOW);
  assert.equal(team.repliesEnabled(), false, "fail closed on anything but exactly '1'");
  s.close();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/team.test.mjs`
Expected: FAIL — exactly the new test, on its first assertion: `getSetting('inbox_replies')` is `null` where `'0'` is expected, because the key does not exist yet.

- [ ] **Step 3: Add the setting**

In `services/api/lib/team.mjs`, find:

```js
/** Every setting that exists, with its default. Phase 4 adds `dana_enabled: '0'`. */
export const SETTINGS_DEFAULTS = { sending_enabled: '1' };
/** The only values each setting may hold. A key with no entry here accepts any string. */
export const SETTINGS_ALLOWED = { sending_enabled: ['0', '1'] };
```

Replace with:

```js
/**
 * Every setting that exists, with its default. Phase 4 adds `dana_enabled: '0'`.
 * `inbox_replies` ships '0': the team can read the Bona inbox from the day it goes live,
 * but no reply reaches a client until the owner turns replies on — the first real client
 * message from the dashboard is sent with him (design D14).
 */
export const SETTINGS_DEFAULTS = { sending_enabled: '1', inbox_replies: '0' };
/** The only values each setting may hold. A key with no entry here accepts any string. */
export const SETTINGS_ALLOWED = { sending_enabled: ['0', '1'], inbox_replies: ['0', '1'] };
```

Then find:

```js
  /** Fail closed: only an exact `'1'` is ON. Anything else — including old or corrupt data — is OFF. */
  const sendingEnabled = () => getSetting('sending_enabled') === '1';

  return {
    ensureOwner, getUser, getUserByPhone, listUsers, addUser, deactivateUser, reactivateUser, setRole, touchLogin,
    addNever, removeNever, listNever, isExcludedPhone,
    getSetting, setSetting, sendingEnabled,
  };
```

Replace with:

```js
  /** Fail closed: only an exact `'1'` is ON. Anything else — including old or corrupt data — is OFF. */
  const sendingEnabled = () => getSetting('sending_enabled') === '1';
  /** Replies to clients from the dashboard: fails closed the same way, and ships off. */
  const repliesEnabled = () => getSetting('inbox_replies') === '1';

  return {
    ensureOwner, getUser, getUserByPhone, listUsers, addUser, deactivateUser, reactivateUser, setRole, touchLogin,
    addNever, removeNever, listNever, isExcludedPhone,
    getSetting, setSetting, sendingEnabled, repliesEnabled,
  };
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/team.test.mjs`
Expected: PASS — every test in the file, the new one included (the existing `dana_enabled` test still gets `bad_setting`: that key is still unknown).

- [ ] **Step 5: Write the failing sender test.** The harness turns replies on, so the reply tests Task 7 wrote keep testing what a reply does once the owner has switched them on. `replies: false` is the state that ships.

In `services/api/test/wa-send.test.mjs`, find:

```js
function harness({ reply = () => ({ status: 201, body: { key: { id: 'KEY-1' } } }), env = ENV, limits } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
```

Replace with:

```js
function harness({ reply = () => ({ status: 201, body: { key: { id: 'KEY-1' } } }), env = ENV, limits, replies = true } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  // Dashboard replies ship switched off (design D14). These tests are about what a reply
  // does once the owner has turned them on; `replies: false` is the state that ships.
  if (replies) team.setSetting('inbox_replies', '1');
```

Then insert the new test before the day-count reply test. Find:

```js
test('reply: its own pending row is not counted twice against the day', async () => {
```

Replace with:

```js
test('reply: replies_off until the owner turns dashboard replies on — nothing written, nothing sent, codes still go', async () => {
  const h = harness({ replies: false, reply: (n) => ({ status: 201, body: { key: { id: `KEY-${n}` } } }) });
  const staff = staffOf(h);
  seedChat(h);
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'replies_off' });
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0, 'no row, so the same send id still works once replies are on');
  const lead = h.s.getLead('L-1');
  assert.equal(lead.handler_user_id, null);
  assert.equal(lead.first_reply_ts, null);

  // A login code is not a reply: the team can still sign in while replies are off.
  const code = await h.sender.sendTo({ jid: '966500000077@s.whatsapp.net', text: 'Bona dashboard code: 123456 (valid 10 min)', kind: 'code' });
  assert.equal(code.ok, true);
  assert.equal(h.calls.length, 1);

  h.team.setSetting('inbox_replies', '1');
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-2' });

  // Off again: the reply that went keeps its answer; a new one is refused before anything is written.
  h.team.setSetting('inbox_replies', '0');
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: true, duplicate: true, status: 'accepted', sendId: SID, error: null });
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { sendId: 'sid_fedcba9876543210' })), { ok: false, error: 'replies_off' });
  assert.equal(h.inbox.getOutbox('sid_fedcba9876543210'), null);
  assert.equal(h.calls.length, 2);
  h.s.close();
});

test('reply: its own pending row is not counted twice against the day', async () => {
```

- [ ] **Step 6: Run it to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/wa-send.test.mjs`
Expected: FAIL — 1 of 49, the new test. The reply goes out (`{ ok: true, status: 'accepted', keyId: 'KEY-1', … }` where `{ ok: false, error: 'replies_off' }` is expected), because `reply` does not ask the switch yet. The other 48 pass: the harness turns replies on, and nothing reads the setting yet.

- [ ] **Step 7: The sender refuses while replies are off.** In `services/api/lib/wa-send.mjs` (inside `reply`, as Task 7 wrote it), find:

```js
    const existing = inbox.getOutbox(sendId);
    if (existing) return answerFor(existing, { leadId, userId });
```

Replace with:

```js
    const existing = inbox.getOutbox(sendId);
    if (existing) return answerFor(existing, { leadId, userId });
    // Replies to clients ship switched off; the owner turns them on from the Team page
    // (design D14: the first real client message from the dashboard is sent with him).
    // Asked before anything is written, so a refusal leaves no row and the same send id
    // still works once they are on. A send id decided above keeps its own answer.
    if (!team.repliesEnabled()) return { ok: false, error: 'replies_off' };
```

- [ ] **Step 8: Run it to see it pass**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/wa-send.test.mjs`
Expected: PASS — 49 tests, 0 fail.

- [ ] **Step 9: Write the failing screen and route tests**

In `services/api/test/dashboard-render-inbox.test.mjs`, the `thread()` helper draws a thread with replies on, the way every existing thread test means it. Find:

```js
  sendId: 'SND-abcdefghijklmnop', seenTs: NOW - HOUR, sendingEnabled: true, canReply: true, now: NOW, ...over,
```

Replace with:

```js
  sendId: 'SND-abcdefghijklmnop', seenTs: NOW - HOUR, sendingEnabled: true, canReply: true, repliesEnabled: true, now: NOW, ...over,
```

Then, in the same file, find:

```js
test('the handler picker offers active people and Nobody, with the current handler chosen', () => {
```

Replace with:

```js
test('no reply box until the owner turns dashboard replies on, and only an owner is pointed to the Team page', () => {
  const offOwner = thread({ repliesEnabled: false });
  assert.match(offOwner, /Replies from the dashboard are not switched on yet \(<a href="\/dashboard\/team">Team page<\/a>\)\./);
  assert.doesNotMatch(offOwner, /\/reply"/);
  assert.doesNotMatch(offOwner, /name="text"/);
  assert.doesNotMatch(offOwner, /name="send_id"/);

  const offStaff = thread({ me: STAFF, repliesEnabled: false });
  assert.match(offStaff, /Replies from the dashboard are not switched on yet — the owner turns them on\./);
  assert.doesNotMatch(offStaff, /\/reply"/);
  assert.doesNotMatch(offStaff, /href="\/dashboard\/team"/, 'a staff page never carries the Team link');

  assert.match(thread({ repliesEnabled: 'yes' }), /not switched on yet/, 'only a real true turns the box on');
  const leftOut = threadPage({
    me: OWNER, lead: LEAD, messages: [], users: USERS, sendId: 'SND-abcdefghijklmnop', seenTs: NOW, sendingEnabled: true, canReply: true, now: NOW,
  });
  assert.match(leftOut, /not switched on yet/, 'a caller that does not say gets no reply box');

  const bothOff = thread({ repliesEnabled: false, sendingEnabled: false });
  assert.match(bothOff, /Sending is off/, 'the switch that stops everything is named first');
  assert.doesNotMatch(bothOff, /not switched on yet/);
  const lid = thread({ repliesEnabled: false, lead: { ...LEAD, phone_e164: null, wa_jid: null }, canReply: false });
  assert.match(lid, /reply from your phone/, 'a chat with no number says so, whatever the switches are');

  assert.match(thread({ repliesEnabled: false, error: 'replies_off' }), /<div class="err">Replies from the dashboard are not switched on yet\.<\/div>/);
  assert.equal(knownError('replies_off'), 'replies_off');
  assert.doesNotMatch(loginPage({ step: 'request', error: 'replies_off' }), /class="err"/, 'never on the login page');
});

test('the handler picker offers active people and Nobody, with the current handler chosen', () => {
```

In `services/api/test/dashboard-render-team.test.mjs` (the last test in the file), find:

```js
  assert.match(html, /action="\/v1\/admin\/team\/USR%2F1%3Fx%3D1\/deactivate"/);
  assert.doesNotMatch(html, /action="\/v1\/admin\/team\/USR\/1/);
});
```

Replace with:

```js
  assert.match(html, /action="\/v1\/admin\/team\/USR%2F1%3Fx%3D1\/deactivate"/);
  assert.doesNotMatch(html, /action="\/v1\/admin\/team\/USR\/1/);
});

test('the Team page carries the owner\'s switch for replies to clients, off until he turns it on', () => {
  const off = teamPage({ me: OWNER, users: [OWNER], sendingEnabled: true });
  assert.match(off, /<h2 style="margin-top:28px">Replies to clients from the dashboard<\/h2>/);
  assert.match(off, /Off\. Nobody can send a client a message from the dashboard yet/);
  assert.match(off, /name="inbox_replies" value="1"/, 'offers to turn replies on');
  assert.match(off, /Turn replies on/);
  assert.match(off, /name="sending_enabled" value="0"/, 'the Sending switch is still its own form');

  const on = teamPage({ me: OWNER, users: [OWNER], sendingEnabled: true, repliesEnabled: true });
  assert.match(on, /On\. Everyone on the team can answer Bona inbox chats/);
  assert.match(on, /name="inbox_replies" value="0"/);
  assert.match(on, /Turn replies off/);
  assert.doesNotMatch(on, /name="inbox_replies" value="1"/);

  assert.match(teamPage({ me: OWNER, users: [OWNER], repliesEnabled: 'yes' }), /name="inbox_replies" value="1"/, 'only a real true counts as on');
});
```

In `services/api/test/dashboard-inbox.test.mjs` (the `withInbox` harness), find:

```js
  const team = createTeam(db, { now });
  const inboxStore = createInboxStore(db, { now });
```

Replace with:

```js
  const team = createTeam(db, { now });
  // Dashboard replies ship switched off (design D14). These tests are about what a reply
  // does once the owner has turned them on; the switch itself has its own test.
  team.setSetting('inbox_replies', '1');
  const inboxStore = createInboxStore(db, { now });
```

Then, in the same file, find:

```js
test('anyone on the team can hand a chat to someone else, and it is audited by id', async () => {
```

Replace with:

```js
test('replies ship switched off: the chat reads but has no reply box, a posted reply goes nowhere, and only the owner turns them on', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    h.team.setSetting('inbox_replies', '0');
    const staff = await h.staff();
    const boss = await h.boss();

    const page = await h.get('/dashboard/inbox/LEAD-A', { cookie: staff });
    assert.equal(page.status, 200, 'the chat can still be read');
    const html = await page.text();
    assert.ok(html.includes('Is BONA-012 still free?'));
    assert.match(html, /Replies from the dashboard are not switched on yet/);
    assert.doesNotMatch(html, /action="\/v1\/admin\/inbox\/LEAD-A\/reply"/);

    h.tick(120_000);
    const form = { text: 'First words to a client', send_id: 'send-off-0000000000001', seen_ts: String(NOW + 60_000) };
    const refused = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(refused.status, 503);
    assertLocked(refused);
    assert.match(await refused.text(), /<div class="err">Replies from the dashboard are not switched on yet\.<\/div>/);
    assert.equal(h.evo.calls.length, 0, 'nothing reached WhatsApp');
    assert.equal(h.inboxStore.getOutbox('send-off-0000000000001'), null, 'and nothing was written');
    assert.ok(!h.app.audit.recent(50).some((r) => r.action === 'reply_sent'));

    const denied = await h.postForm('/v1/admin/settings', { inbox_replies: '1' }, { cookie: staff });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'owner_only' });
    assert.equal(h.team.repliesEnabled(), false);

    const both = await h.postForm('/v1/admin/settings', { inbox_replies: '1', sending_enabled: '1' }, { cookie: boss });
    assert.equal(both.headers.get('location'), '/dashboard/team?error=bad_setting', 'one switch per post');
    assert.equal(h.team.repliesEnabled(), false);

    assert.match(await (await h.get('/dashboard/team', { cookie: boss })).text(), /name="inbox_replies" value="1"/, 'the Team page offers to turn them on');
    const on = await h.postForm('/v1/admin/settings', { inbox_replies: '1' }, { cookie: boss });
    assert.equal(on.status, 303);
    assert.equal(on.headers.get('location'), '/dashboard/team?ok=setting');
    assert.equal(h.team.repliesEnabled(), true);
    const audited = h.app.audit.recent(50).filter((r) => r.action === 'setting');
    assert.equal(audited.length, 1);
    assert.equal(audited[0].user_id, h.owner.user_id);
    assert.equal(audited[0].target, 'inbox_replies');
    assert.deepEqual(audited[0].meta, { value: '1' });

    const sent = await replyTo(h, 'LEAD-A', form, staff);
    assert.equal(sent.headers.get('location'), '/dashboard/inbox/LEAD-A?ok=sent', 'the same form goes once they are on');
    assert.equal(h.evo.calls.length, 1);
  });
});

test('anyone on the team can hand a chat to someone else, and it is audited by id', async () => {
```

- [ ] **Step 10: Run them to see them fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/dashboard-render-inbox.test.mjs api/test/dashboard-render-team.test.mjs api/test/dashboard-inbox.test.mjs`
Expected: FAIL — exactly the three new tests, one per file. `render-inbox`: the thread still draws the reply form with `repliesEnabled: false` (no "not switched on yet" sentence). `render-team`: there is no *Replies to clients from the dashboard* section. `dashboard-inbox`: the thread still has the reply box, so the test fails on its first `not switched on yet` match. (A posted reply would come back 502 `send_failed`, because the route has no mapping for `replies_off` yet.) Every other test in the three files passes: both harnesses turn replies on.

- [ ] **Step 11: Implement the screens and the routes**

(a) The thread. In `services/api/lib/dashboard/render-inbox.mjs`, find:

```js
 * The reply box is replaced by one plain sentence when a reply cannot go: a chat with
 * no phone number (an `@lid` is not something we send to), or the owner's Sending switch
 * off. The form carries `send_id` (a double tap sends once) and `seen_ts`, the newest
 * message this page showed, so a reply written against an old view is held back.
 */
export function threadPage({
  me, lead, messages, gaps = [], outbox = [], users = [], sendId, seenTs, sendingEnabled, canReply,
  draft = '', ok = null, error = null, now = Date.now(),
}) {
```

Replace with:

```js
 * The reply box is replaced by one plain sentence when a reply cannot go: a chat with
 * no phone number (an `@lid` is not something we send to), the owner's Sending switch
 * off, or replies from the dashboard not switched on yet (they ship off, design D14,
 * and only a real `true` turns them on). The form carries `send_id` (a double tap sends
 * once) and `seen_ts`, the newest message this page showed, so a reply written against
 * an old view is held back.
 */
export function threadPage({
  me, lead, messages, gaps = [], outbox = [], users = [], sendId, seenTs, sendingEnabled, canReply, repliesEnabled = false,
  draft = '', ok = null, error = null, now = Date.now(),
}) {
```

Then, in the same file, find:

```js
  } else if (!sendingEnabled) {
    // Only an owner can open the Team page, so only an owner gets it as a link: a
    // staff page never contains that link at all (Phase 1 rule).
    reply = `<p class="muted">Sending is off (${owner ? '<a href="/dashboard/team">Team page</a>' : 'Team page'}).</p>`;
  } else {
```

Replace with:

```js
  } else if (!sendingEnabled) {
    // Only an owner can open the Team page, so only an owner gets it as a link: a
    // staff page never contains that link at all (Phase 1 rule).
    reply = `<p class="muted">Sending is off (${owner ? '<a href="/dashboard/team">Team page</a>' : 'Team page'}).</p>`;
  } else if (repliesEnabled !== true) {
    // Replies ship switched off until the owner turns them on (design D14). Same link
    // rule as above; the sender refuses a posted reply (`replies_off`) on its own too.
    reply = owner
      ? '<p class="muted">Replies from the dashboard are not switched on yet (<a href="/dashboard/team">Team page</a>).</p>'
      : '<p class="muted">Replies from the dashboard are not switched on yet — the owner turns them on.</p>';
  } else {
```

(b) The message a refused reply shows. In `services/api/lib/dashboard/render.mjs` (the end of `MESSAGES` as Task 10 left it), find:

```js
  not_a_chat: 'That lead has no WhatsApp chat yet — it joins once they write on WhatsApp.',
};
```

Replace with:

```js
  not_a_chat: 'That lead has no WhatsApp chat yet — it joins once they write on WhatsApp.',
  replies_off: 'Replies from the dashboard are not switched on yet.',
};
```

(c) The Team page switch. In `services/api/lib/dashboard/render-team.mjs`, find:

```js
 * The Team page (owner only): who can log in, the numbers that are never a client, and
 * the switch for everything the dashboard sends from the owner's WhatsApp.
```

Replace with:

```js
 * The Team page (owner only): who can log in, the numbers that are never a client, and
 * the switches for what the dashboard sends from the owner's WhatsApp — everything
 * (Sending), and replies to clients (off until the owner turns them on, design D14).
```

Then find:

```js
export function teamPage({ me, users = [], never = [], sendingEnabled = true, ok = null, error = null }) {
```

Replace with:

```js
export function teamPage({ me, users = [], never = [], sendingEnabled = true, repliesEnabled = false, ok = null, error = null }) {
  // Fails closed like the setting itself: only a real `true` from team.repliesEnabled() is on.
  const repliesOn = repliesEnabled === true;
```

Then find:

```js
${post('/v1/admin/settings', sendingEnabled ? 'Turn sending off' : 'Turn sending on', { sending_enabled: sendingEnabled ? '0' : '1' })}`;
```

Replace with:

```js
${post('/v1/admin/settings', sendingEnabled ? 'Turn sending off' : 'Turn sending on', { sending_enabled: sendingEnabled ? '0' : '1' })}

<h2 style="margin-top:28px">Replies to clients from the dashboard</h2>
<p class="sub">${repliesOn
    ? 'On. Everyone on the team can answer Bona inbox chats from the dashboard; the reply goes from your number (while sending above is on).'
    : 'Off. Nobody can send a client a message from the dashboard yet; the team can still read the inbox, and login codes still go.'}</p>
${post('/v1/admin/settings', repliesOn ? 'Turn replies off' : 'Turn replies on', { inbox_replies: repliesOn ? '0' : '1' })}`;
```

(d) The routes. In `services/api/lib/dashboard/routes.mjs` (`teamView`), find:

```js
      never: team.listNever(),
      sendingEnabled: team.sendingEnabled(),
```

Replace with:

```js
      never: team.listNever(),
      sendingEnabled: team.sendingEnabled(),
      repliesEnabled: team.repliesEnabled(),
```

Then (`saveSetting`, unchanged since Phase 1), find:

```js
  function saveSetting(ctx) {
    const { fields, me } = ctx;
    return teamWrite(ctx, () => {
      if (!Object.hasOwn(fields, 'sending_enabled')) throw new TeamError('bad_setting');
      // Fails closed: `asText` turns anything that is not literally a string (a JSON
      // `false`, `null`, a number) into `''`, and `team.setSetting` itself refuses any
      // value outside `SETTINGS_ALLOWED` — including `''`, `"off"`, `"true"` — before
      // it ever reaches the row. Coercing here (the old `=== '0' ? '0' : '1'`) would
      // have defeated that check by handing it only ever '0' or '1' to approve.
      const value = asText(fields.sending_enabled);
      team.setSetting('sending_enabled', value, { by: me.user_id });
      audit?.record({ userId: me.user_id, action: 'setting', target: 'sending_enabled', meta: { value } });
    }, 'setting');
  }
```

Replace with:

```js
  /** The owner's switches, as the Team page posts them: one per form. */
  const SWITCHES = ['sending_enabled', 'inbox_replies'];

  function saveSetting(ctx) {
    const { fields, me } = ctx;
    return teamWrite(ctx, () => {
      // Exactly one switch per post, the way the Team page's buttons send it: none, or
      // two at once, is refused rather than guessed at.
      const keys = SWITCHES.filter((k) => Object.hasOwn(fields, k));
      if (keys.length !== 1) throw new TeamError('bad_setting');
      const [key] = keys;
      // Fails closed: `asText` turns anything that is not literally a string (a JSON
      // `false`, `null`, a number) into `''`, and `team.setSetting` itself refuses any
      // value outside `SETTINGS_ALLOWED` — including `''`, `"off"`, `"true"` — before
      // it ever reaches the row. Coercing here (the old `=== '0' ? '0' : '1'`) would
      // have defeated that check by handing it only ever '0' or '1' to approve.
      const value = asText(fields[key]);
      team.setSetting(key, value, { by: me.user_id });
      audit?.record({ userId: me.user_id, action: 'setting', target: key, meta: { value } });
    }, 'setting');
  }
```

Then (`REPLY_REFUSALS`, from Task 12), find:

```js
    sending_disabled: [503, 'sending_disabled'],
```

Replace with:

```js
    sending_disabled: [503, 'sending_disabled'],
    replies_off: [503, 'replies_off'],
```

Then (`renderThread`, from Task 12), find:

```js
      sendingEnabled: team.sendingEnabled(),
      canReply: replyJidFor(lead) !== null,
```

Replace with:

```js
      sendingEnabled: team.sendingEnabled(),
      canReply: replyJidFor(lead) !== null,
      repliesEnabled: team.repliesEnabled(),
```

(e) The README. In `services/README.md` (the *Replies* paragraph Task 13 wrote), find:

```markdown
`inbox_out` and `inbox_add` carry ids and a status — never text or a number. The first real
client reply from the dashboard is sent with the owner beside it (design D14).
```

Replace with:

```markdown
`inbox_out` and `inbox_add` carry ids and a status — never text or a number. Replies ship
**switched off** (`settings.inbox_replies` = `'0'`): the thread shows "not switched on yet"
in place of the box, and `reply` refuses `replies_off` (503) before anything is written,
until the owner switches *Replies to clients from the dashboard* on from the Team page
(one switch per post, audited `setting`). That is how the first real client reply from the
dashboard is sent with the owner beside it (design D14). Login codes do not wait for it.
```

- [ ] **Step 12: Run the task's tests and the hostile-input scripts**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/team.test.mjs api/test/wa-send.test.mjs api/test/dashboard-render-inbox.test.mjs api/test/dashboard-render-team.test.mjs api/test/dashboard-inbox.test.mjs api/test/dashboard-routes.test.mjs`
Expected: PASS, 0 fail. That is 49 in `wa-send`, 16 in `dashboard-render-inbox`, 7 in `dashboard-render-team` and 16 in `dashboard-inbox`. `dashboard-routes` is unchanged: its `sending_enabled` tests still pass, and a post with no switch is still `bad_setting`.

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node api/test/dashboard-hostile.mjs && node api/test/dashboard-regression.mjs`
Expected: the last lines are `ALL PAGES RENDER CLEAN UNDER HOSTILE INPUT` and `ALL REGRESSION CHECKS PASS`.

- [ ] **Step 13: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail — 5 more tests than after Task 13.

- [ ] **Step 14: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/team.mjs services/api/lib/wa-send.mjs services/api/lib/dashboard/render-inbox.mjs services/api/lib/dashboard/render.mjs services/api/lib/dashboard/render-team.mjs services/api/lib/dashboard/routes.mjs services/README.md services/api/test/team.test.mjs services/api/test/wa-send.test.mjs services/api/test/dashboard-render-inbox.test.mjs services/api/test/dashboard-render-team.test.mjs services/api/test/dashboard-inbox.test.mjs
git commit -m "dashboard: replies to clients ship switched off; the owner turns them on (Team page)

The team can read the Bona inbox from the day it ships, but no reply reaches
a client until the owner switches inbox_replies on (design D14: the first real
client message from the dashboard is sent with him). While it is off the
thread shows no reply box, sender.reply refuses replies_off before writing an
outbox row, and the route answers 503. The switch is owner-only, one per post
and audited. Login codes do not depend on it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Property documents join the inbox; the word Bona, Bona AB's papers and TK documents do not (D16)

Owner decisions of 2026-09-28 (binding, same weight as D1–D14):

- **D15** TK's click-to-WhatsApp ads go to the TK company number only, so an ad-origin chat on the owner's personal number is a Bona client: ad context stays a **certain** signal. No code changes; this task records it in `lib/inbox/eligibility.mjs` and the README (it settles the question A7 left open).
- **D16** A chat joins the Bona inbox when the owner sends it **any property document** — a brochure, floor plan, price list, payment plan, master plan or fact sheet, from any developer, in English or Arabic, by its file name or caption — or, as before, a listing id or a Bona site link in the text, caption or file name. The bare word "Bona" on a document **no longer** joins (Bona AB makes wood-floor finishes: "Bona Traffic HD datasheet.pdf" must not pull a TK chat in; this settles A7's other open question). A document whose file name or caption names **TK** (`TK` as a word, `T.K.`, `tk-estates`, `تي كي` / `تى كى`) never joins by itself, whatever else it says; Task 16 puts such a chat on the owner's list of real-estate chats to check instead (D17).

What changes, as Task 3 and its amendments A5–A8 left the rules:

- `PROPERTY_DOC_RE` (new, exported): the document words, bounded like `BONA_WORD_RE` by anything that is not a letter or a mark; two English words may be joined by a space, `-`, `_` or nothing; the Arabic single words also with the article (البروشور), which the brief's list did not name but a caption like "هذا البروشور" needs. Linear time (every alternative starts with a fixed word and repeats nothing).
- `TK_RE` (new, exported): `TK` bounded by anything that is not a letter or a digit, `T.K.` / `T.K`, `tk-estates` / `TKEstates`, and `تي كي` **bounded** like `بونا`, with ي or ى in either place: Saudi typing often ends a word with ى, so `بروشور تى كى.pdf` and `بروشور تي كى.pdf` name TK too (the brief's `تي\s?كي` missed them, and each joined with 24 h of history). The brief's pattern also left the Arabic side unbounded, which is exactly A5's mistake: بلاستيكي / بلاستيكى (plastic) and أوتوماتيكي (automatic) contain تيكي, and every document so named would read as TK. Bounded, a TK name still counts when it is its own word.
- `isTkDocument(o)` (new, exported): a document whose file name or caption matches `TK_RE`.
- `ownerOutboundJoins(o)`: text and non-document captions are unchanged (site link or listing id). A document: `TK_RE` in its file name or caption → `false`, first; then a site link or a listing id in the caption or the file name → `true`; then our name (`BONA_WORD_RE`) in the file name or caption → `false`; else `PROPERTY_DOC_RE` in the caption or the file name → `true`. In a file name `_` stands for a space, so `Villa_BONA-W003_EN.pdf` still joins as it did before (it used to join through the word `BONA`; `LISTING_ID_RE`'s `\b` alone would now miss it). `BONA_WORD_RE` no longer joins anything.
- **A document that names Bona joins only by a listing id or a site link** (decided inside D16, fail-safe; the owner is asked below). D16's own example, "Bona Traffic HD datasheet.pdf", matches no document word, but Bona AB publishes brochures, price lists and fact sheets too, and TK Estate & Design sends them to TK clients: "Bona Traffic HD brochure.pdf", "Bona Price List 2026.pdf" and "Bona Traffic HD Fact Sheet.pdf" would each pull a TK chat into the inbox with 24 h of history — the harm D16 was written to stop — while the owner's words are "if it's related to real estate". Our name next to a document word cannot tell Bona AB from us, so it is not a sure sign (D17): such a chat goes on the owner's list of real-estate chats to check (Task 16 notes it as a `property document`), one tap from the inbox. The price is a brochure of ours named "Bona Villa brochure.pdf" with no listing id: it no longer joins by itself.
- **Cut names.** A name cut at 120 code points is still read without its last 16 (`CUT_MARGIN`), and there a property word or a listing id counts only when a character that cannot carry it on follows it inside what is read (so `…Brochure` cut from `…BrochureX` is never read as `brochure`); a site link, whose look-ahead reaches 257 characters, is not read in a cut name at all. `WORD_AT_END_RE` goes: it only guarded the word Bona as a reason to join, which it no longer is. But TK or Bona can sit in the part the cut hid ("Villa Brochure …(110 characters)… TK.pdf", "… Bona.pdf"), and then the visible name joins where the whole name would not. No rule on the cut name can see that, so `lib/evolution.mjs` `normaliseRecord` gains **`fileNameTk`** and **`fileNameBona`**: `TK_RE` and `BONA_WORD_RE` on the whole cleaned name before it is cut (one bit each, not a second, uncapped copy of a sender-chosen name). For a cut name, TK and Bona are judged by those bits and by what is left of the name as well (a TK or Bona the visible part shows counts even when its bit says no: "…TK" may be the start of "…TKO", and that only means fewer joins), and a cut name without a boolean bit of exactly `false` is read as naming it (fewer joins, never more). So a cut name still joins only where the whole name would, which the fuzz test now checks with TK, Bona and property words among its pieces.
- The fuzz test's generator changes to mulberry32: with the old `(seed * 1103515245 + 12345) & 0x7fffffff`, `next() % 48` reaches only 10 of 48 pieces (its low bits repeat with a short period), so most new pieces would never be tried.

**Open for the owner** (review of this task, 2026-09-28; record the answers in context.md). (1) D16's words include some that are not only real estate: *payment plan* / خطة الدفع / خطة السداد / جدول الدفعات / جدول السداد (TK Estate & Design sends payment schedules for fit-out work), *price list*, *fact sheet*, كتيب (any booklet: a maintenance manual) and a bare مخطط (any drawing: an electrical plan). As D16 is written each joins by itself, so `Payment plan - kitchen works.pdf`, `جدول الدفعات - أعمال الديكور.pdf`, `كتيب الصيانة.pdf` and `مخطط الكهرباء.pdf` sent to a TK client pull that chat in with 24 h of history; a test pins this, so an answer changes it on purpose. Should these words join only with a property word (villa, apartment, فيلا, شقة …), a listing id or a link next to them, and go to the owner's list to check otherwise? `brochure`, `floor plan`, `master plan` and بروشور would stay as they are; but the brief's own examples `Price List Sep.pdf`, `payment_plan.pdf` and `قائمة الأسعار.pdf` would stop joining, so the answer changes D16. (2) Is keeping a document that names Bona without a listing id or link out of the inbox (above) what he wants?

The poller's code does not change (`inboxAfterOutbound` already calls `ownerOutboundJoins(rec)` on the normalised record, which now carries `fileNameTk` and `fileNameBona`); two of its comments still describe the D12 rule ("a Bona brochure") and are brought up to date. Two poller tests change and one is added: Task 9's "a Bona brochure the owner sends starts a chat" sent `Bona Brochure.pdf`, which names Bona and so stays out now (it becomes one of the files that must not join, and the brochure that does is `Palm Villa Brochure.pdf`); the A8 cut-name test hands in hand-made cut records, which now need `fileNameTk: false` and `fileNameBona: false` (plus one with `fileNameTk: true`), and its brochure's name no longer starts with "Bona"; and one new end-to-end test shows D16 in the poller. No other existing test asserts the old document rule (checked on the branch up to 232b9f8 with `grep -rn "Bona_Villa\|DOC_BONA\|Bona Brochure\|ownerOutboundJoins\|fileNameTruncated" services/api/test/`: only `inbox-eligibility`, `evolution` and the three `wa-poller` places here; the lid test 232b9f8 added also sends a `Bona Brochure.pdf`, but its chat joins by a link, so it passes either way). Tasks 10–14 do not touch these files; Task 13's README bullet is updated here.

**Files:**
- Modify: `services/api/lib/inbox/eligibility.mjs` (whole file replaced)
- Modify: `services/api/lib/evolution.mjs` (`fileNameTk`, `fileNameBona`)
- Modify: `services/api/lib/wa-poller.mjs` (two comments only)
- Modify: `services/README.md` (Task 13's *Owner-started* bullet; the D15 line)
- Test: `services/api/test/inbox-eligibility.test.mjs`
- Test: `services/api/test/evolution.test.mjs`
- Test: `services/api/test/wa-poller.test.mjs`

- [ ] **Step 1: Write the failing tests**

**(a) `services/api/test/evolution.test.mjs`** — four edits.

Find:

```js
    fileNameTruncated: false,
    noise: false,
  });
```

Replace with:

```js
    fileNameTruncated: false,
    fileNameTk: false,
    fileNameBona: false,
    noise: false,
  });
```

Find:

```js
  assert.equal(voice.fileNameTruncated, false);
  assert.equal(voice.noise, false);
```

Replace with:

```js
  assert.equal(voice.fileNameTruncated, false);
  assert.equal(voice.fileNameTk, false);
  assert.equal(voice.fileNameBona, false);
  assert.equal(voice.noise, false);
```

Find:

```js
  assert.equal(brochure.fileNameTruncated, false);
  assert.equal(brochure.text, 'as promised');
```

Replace with:

```js
  assert.equal(brochure.fileNameTruncated, false);
  assert.equal(brochure.fileNameTk, false);
  assert.equal(brochure.fileNameBona, true, 'a listing id names Bona too (it joins by the id)');
  assert.equal(brochure.text, 'as promised');
```

Find:

```js
test('reactions, deletes and edits, poll votes and key-distribution records are noise; a message is not', () => {
```

Replace with:

```js
test('fileNameTk and fileNameBona say whether the whole name names TK or Bona, even where the cut hides it (D16)', () => {
  const rec = (fileName) => normaliseRecord({ key: { id: 'D4' }, message: { documentMessage: { fileName } } });
  // TK after the 120th code point: the name the record carries no longer shows it.
  const hidden = rec(`Villa Brochure ${'x'.repeat(120)} TK.pdf`);
  assert.equal(hidden.fileNameTruncated, true);
  assert.ok(!hidden.fileName.includes('TK'), 'the cut hides it');
  assert.equal(hidden.fileNameTk, true, 'but the record still says so');
  assert.equal(hidden.fileNameBona, false);
  const bona = rec(`Villa Brochure ${'x'.repeat(120)} Bona.pdf`);
  assert.ok(!bona.fileName.includes('Bona'), 'the cut hides our name too');
  assert.deepEqual([bona.fileNameBona, bona.fileNameTk], [true, false], 'and the record says so');
  for (const [fileName, tk] of [
    ['TK Brochure Villa.pdf', true],
    ['T.K. Estates brochure.pdf', true],
    ['tk-estates price list.pdf', true],
    ['TKEstates_floorplan.pdf', true],
    ['بروشور تي كي.pdf', true],
    ['بروشور تى كى.pdf', true],
    ['بروشور تي كى.pdf', true],
    // An invisible character cannot hide it: the name is cleaned before it is read.
    ['T\u200BK Brochure.pdf', true],
    [`Villa Brochure ${'x'.repeat(120)}.pdf`, false],
    ['TKO brochure.pdf', false],
    ['Stock2TK9.pdf', false],
    ['بلاستيكي.pdf', false],
    ['بلاستيكى.pdf', false],
    ['Knightsbridge_Phase 2_Brochure_EN.pdf', false],
  ]) {
    assert.equal(rec(fileName).fileNameTk, tk, JSON.stringify(fileName));
  }
  for (const [fileName, named] of [
    ['Bona Traffic HD brochure.pdf', true],
    ['BONA-W003 brochure.pdf', true],
    ['بونا - فيلا الشاطئ.pdf', true],
    ['Bona Fide Purchaser Declaration.pdf', false],
    ['Bonanza brochure.pdf', false],
    ['Knightsbridge_Phase 2_Brochure_EN.pdf', false],
  ]) {
    assert.equal(rec(fileName).fileNameBona, named, JSON.stringify(fileName));
  }
  for (const r of [rec(''), normaliseRecord(textRecord())]) {
    assert.deepEqual([r.fileNameTk, r.fileNameBona], [false, false], 'no usable name, or no document');
  }
});

test('reactions, deletes and edits, poll votes and key-distribution records are noise; a message is not', () => {
```

**(b) `services/api/test/inbox-eligibility.test.mjs`** — six edits.

(b1) The import. Find:

```js
import {
  LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, INBOX_STATES,
  inboundSignal, ownerOutboundJoins, nextInboxState,
} from '../lib/inbox/eligibility.mjs';
```

Replace with:

```js
import {
  LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE, INBOX_STATES,
  inboundSignal, ownerOutboundJoins, isTkDocument, nextInboxState,
} from '../lib/inbox/eligibility.mjs';
```

(b2) The pattern checks. Find:

```js
  for (const re of [LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE]) {
    assert.ok(re instanceof RegExp);
```

Replace with:

```js
  for (const re of [LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE]) {
    assert.ok(re instanceof RegExp);
```

Find:

```js
  for (const re of [BONA_WORD_RE, SITE_LINK_RE]) assert.equal(re.unicode, true, `${re} needs /u`);
```

Replace with:

```js
  for (const re of [BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE]) assert.equal(re.unicode, true, `${re} needs /u`);
  for (const re of [PROPERTY_DOC_RE, TK_RE]) assert.equal(re.ignoreCase, true, `${re} ignores case`);
```

(b3) The end of the "bona fide" test: the word next to the phrase still counts for a client, and on a document only a property word joins now. Find:

```js
  assert.equal(ownerOutboundJoins(doc('Bona_Villa.pdf')), true);
  assert.equal(ownerOutboundJoins(doc('offer.pdf', 'Bona villa, a bona fide offer')), true, 'the name next to the phrase still counts');
});
```

Replace with:

```js
  assert.equal(inboundSignal({ text: 'Bona villa, a bona fide offer' }), 'unsure', 'the name next to the phrase still counts');
  assert.equal(ownerOutboundJoins(doc('Bona Fide Purchaser Declaration - Brochure.pdf')), true, 'a brochure joins, whatever Latin is on it');
});
```

(b4) The document tests and every cut-name test are replaced. Delete everything from the line

```js
test('a document joins when its file name or caption says Bona or a listing id', () => {
```

down to, but not including, the line

```js
/* ---------------- time ---------------- */
```

(that range holds, in order: "a document joins when its file name or caption says Bona or a listing id", "the word bona counts only on a document, …", "a document name cut at 120 characters cannot make a word or an id at the cut", the `ownerDoc` / `wholeDoc` helpers, "a cut name never joins where the whole name would not: …", "a cut name joins only where the whole name joins, …" and "any truthy cut flag reads the name as cut: …"), and put in its place:

```js
test('a property document the owner sends joins the chat, from any developer (D16)', () => {
  const doc = (fileName, text = null) => ({ text, fileName, media: fileName ? `[document: ${fileName}]` : '[document]' });
  for (const rec of [
    doc('Knightsbridge_Phase 2_Brochure_EN.pdf'),
    doc('Floor-Plan_Type-A.pdf'),
    doc('floorplan.pdf'),
    doc('Floor plans v2.pdf'),
    doc('Price List Sep.pdf'),
    doc('pricelist.pdf'),
    doc('payment_plan.pdf'),
    doc('Master-Plan.pdf'),
    doc('Fact sheet 2026.pdf'),
    doc('brochure2.pdf'),
    doc('Brochures.zip'),
    doc('بروشور المشروع.pdf'),
    doc('البروشور.pdf'),
    doc('بروشورات.pdf'),
    doc('كتيّب المشروع.pdf'),
    doc('كتيب.pdf'),
    doc('مخطط الدور الأرضي.pdf'),
    doc('المخططات.pdf'),
    doc('قائمة الأسعار.pdf'),
    doc('قائمة_الاسعار.pdf'),
    doc('جدول الأسعار.pdf'),
    doc('خطة الدفع.pdf'),
    doc('خطة السداد.pdf'),
    doc('جدول الدفعات.pdf'),
    doc('جدول السداد.pdf'),
    doc('doc.pdf', 'price list attached'),
    doc('scan.pdf', 'هذا البروشور'),
    doc(null, 'Floor plan'),
    doc('BONA-W003 brochure.pdf'),
    doc('Brochure BONA-W014.pdf'),
    doc('BONA-W003.pdf'),
    doc('Villa_BONA-W003_EN.pdf'),
    doc('Bona Villa BONA-W003 brochure.pdf'),
    doc('bona-real-estate.com villa.pdf'),
    doc('Bona brochure.pdf', 'https://bona-real-estate.com/ar/'),
    doc('scan.pdf', 'BONA-005'),
    doc('scan.pdf', 'https://bona-real-estate.com/ar/'),
  ]) {
    assert.equal(ownerOutboundJoins(rec), true, `${rec.fileName} / ${rec.text}`);
  }
});

test('D16 as written: the generic document words join by themselves, fit-out papers too (open for the owner)', () => {
  // TK Estate & Design sends such papers to TK clients. D16 names payment plans, price lists
  // and fact sheets, and its Arabic words include كتيب and a bare مخطط, so each of these joins.
  // The owner is asked whether they should need a property word, a listing id or a link next
  // to them (Task 15, "Open for the owner"): an answer changes this test on purpose.
  const doc = (fileName) => ({ text: null, fileName, media: `[document: ${fileName}]` });
  for (const fileName of ['Payment plan - kitchen works.pdf', 'جدول الدفعات - أعمال الديكور.pdf', 'كتيب الصيانة.pdf', 'مخطط الكهرباء.pdf']) {
    assert.equal(ownerOutboundJoins(doc(fileName)), true, fileName);
  }
});

test('the word Bona, or any other file, no longer joins a chat by itself, and a document that names Bona needs a listing id or a link (D16)', () => {
  const doc = (fileName, text = null) => ({ text, fileName, media: fileName ? `[document: ${fileName}]` : '[document]' });
  // Bona AB makes wood-floor finishes, with brochures, price lists and fact sheets of its own:
  // TK Estate & Design sends them to TK clients.
  for (const rec of [
    doc('Bona Traffic HD datasheet.pdf'),
    doc('Bona Traffic HD brochure.pdf'),
    doc('Bona Price List 2026.pdf'),
    doc('Bona Traffic HD Fact Sheet.pdf'),
    doc('Bona_Villa_Brochure.pdf'),
    doc('بروشور بونا.pdf'),
    doc('brochure.pdf', 'Bona'),
    doc('Floor plan.pdf', 'from بونا'),
    doc('Bona.pdf'),
    doc('Bona_Villa.pdf'),
    doc('بونا - فيلا الشاطئ.pdf'),
    doc('villa.pdf', 'Files from Bona'),
    doc(null, 'bona'),
    doc('Invoice 1234.pdf'),
    doc('XBONA-W003.pdf'),
    doc('BONA-W0031.pdf'),
    doc('Stock brochureX.pdf'),
    doc('Brochureware.pdf'),
    doc('datasheet.pdf'),
    doc('Floor.pdf'),
    doc('وبروشور.pdf'),
    doc('Bona Fide Purchaser Declaration.pdf'),
    doc(null),
  ]) {
    assert.equal(ownerOutboundJoins(rec), false, `${rec.fileName} / ${rec.text}`);
  }
  // "brochure" typed as text, or on a photo, is not a document.
  for (const media of [null, '[image]', '[voice note]']) {
    assert.equal(ownerOutboundJoins({ text: 'BONA brochure', media }), false, String(media));
    assert.equal(ownerOutboundJoins({ text: 'price list', media }), false, String(media));
  }
  assert.equal(ownerOutboundJoins({ text: 'bona.azoz.uk/villas', media: '[image]' }), true, 'a link in a caption still counts');
  assert.equal(ownerOutboundJoins({ text: 'BONA-W003 on the photo', media: '[image]' }), true, 'so does a listing id');
});

test('a document that names TK never joins, whatever else it says, and isTkDocument says so (D16, D17)', () => {
  const doc = (fileName, text = null) => ({ text, fileName, media: fileName ? `[document: ${fileName}]` : '[document]' });
  for (const rec of [
    doc('TK Brochure Villa.pdf'),
    doc('brochure.pdf', 'TK Estates brochure'),
    doc('بروشور تي كي.pdf'),
    doc('بروشور تى كى.pdf'),
    doc('بروشور تي كى.pdf'),
    doc('T.K. Estates brochure.pdf'),
    doc('TK_Price_List.pdf'),
    doc('tk-estates floor plan.pdf'),
    doc('TKEstates brochure.pdf'),
    doc('Brochure BONA-W014 TK.pdf'),
    doc('scan.pdf', 'TK · https://bona-real-estate.com/ar/'),
    doc('Brochure.pdf', 'from تي كي'),
  ]) {
    assert.equal(ownerOutboundJoins(rec), false, `${rec.fileName} / ${rec.text}`);
    assert.equal(isTkDocument(rec), true, `${rec.fileName} / ${rec.text}`);
  }
  // TK only as part of a longer word or number, and Arabic words that only contain the letters.
  for (const rec of [doc('TKO brochure.pdf'), doc('Brochure TK2.pdf'), doc('Stock brochure.pdf', 'atk ok'), doc('St.Kitts brochure.pdf'),
    doc('مخطط بلاستيكي.pdf'), doc('مخطط بلاستيكى.pdf'), doc('بلاستيكى floor plan.pdf'), doc('brochure.pdf', 'أوتوماتيكي')]) {
    assert.equal(isTkDocument(rec), false, `${rec.fileName} / ${rec.text}`);
    assert.equal(ownerOutboundJoins(rec), true, `${rec.fileName} / ${rec.text}`);
  }
  // Only a document is a TK document: text and photos keep the rules they had.
  assert.equal(isTkDocument({ text: 'TK brochure', media: null }), false);
  assert.equal(isTkDocument({ text: 'TK brochure', media: '[image]' }), false);
  assert.equal(ownerOutboundJoins({ text: 'TK · BONA-W003', media: null }), true, 'a listing id in a text still joins');
  assert.equal(isTkDocument({}), false);
  assert.equal(isTkDocument(), false);
  assert.equal(isTkDocument(null), false);
  assert.equal(isTkDocument({ fileName: 42, text: {}, media: '[document]' }), false);
});

test('a cut name is TK or Bona by what the whole name said and by what is left of it; without the answer it may be either', () => {
  const cutName = `Villa Brochure ${'x'.repeat(100)}`;
  const cut = (over = {}) => ({ fileName: cutName, fileNameTruncated: true, fileNameTk: false, fileNameBona: false, media: `[document: ${cutName}]`, ...over });
  const withFlag = (key, v) => {
    const rec = cut();
    if (v === undefined) delete rec[key]; else rec[key] = v;
    return rec;
  };
  assert.equal(ownerOutboundJoins(cut()), true, 'the whole name named neither');
  assert.equal(isTkDocument(cut()), false);
  assert.equal(ownerOutboundJoins(cut({ fileNameTk: true })), false, 'it named TK, past the cut');
  assert.equal(isTkDocument(cut({ fileNameTk: true })), true);
  assert.equal(ownerOutboundJoins(cut({ fileNameBona: true })), false, 'it named Bona, past the cut');
  assert.equal(isTkDocument(cut({ fileNameBona: true })), false, 'which is not TK');
  for (const v of [undefined, null, 0, 'false']) {
    assert.equal(ownerOutboundJoins(withFlag('fileNameTk', v)), false, `TK unknown (${JSON.stringify(v)}): fewer joins, never more`);
    assert.equal(isTkDocument(withFlag('fileNameTk', v)), true, JSON.stringify(v));
    assert.equal(ownerOutboundJoins(withFlag('fileNameBona', v)), false, `Bona unknown (${JSON.stringify(v)})`);
  }
  // What is left of the name counts too, whatever the bits say ("…TK" may be the start of "…TKO").
  const shows = (fileName) => cut({ fileName, media: `[document: ${fileName}]` });
  assert.equal(ownerOutboundJoins(shows(`Villa Brochure TK ${'x'.repeat(100)}`)), false);
  assert.equal(isTkDocument(shows(`Villa Brochure TK ${'x'.repeat(100)}`)), true);
  assert.equal(ownerOutboundJoins(shows(`Bona Villa Brochure ${'x'.repeat(100)}`)), false);
  assert.equal(ownerOutboundJoins(shows(`Bona Villa BONA-W003 ${'x'.repeat(100)}`)), true, 'a listing id still joins');
  // A name that was not cut is read as it is; a bit of exactly true still counts.
  const whole = (over = {}) => ({ fileName: 'Villa Brochure.pdf', media: '[document: Villa Brochure.pdf]', ...over });
  assert.equal(ownerOutboundJoins(whole()), true);
  assert.equal(ownerOutboundJoins(whole({ fileNameTk: true })), false);
  assert.equal(ownerOutboundJoins(whole({ fileNameBona: true })), false);
});

/** A document record sent by the owner, through normaliseRecord (which cuts the name). */
const ownerDoc = (fileName) => normaliseRecord({
  key: { id: 'D1', fromMe: true, remoteJid: '1@lid' },
  message: { documentMessage: { fileName } },
});
/** The same document if its whole name had been kept (normaliseRecord cleans before it cuts). */
const wholeDoc = (fileName) => ({ text: '', fileName, fileNameTruncated: false, media: `[document: ${fileName}]` });

test('a document name cut at 120 characters cannot make a word or an id at the cut', () => {
  // Through normaliseRecord, which cuts the name: what follows the cut is unknown, so the
  // last word may be the start of a longer one (Bonanza cut to Bona).
  const rec = (fileName, caption) => normaliseRecord({
    key: { id: 'D1', fromMe: true, remoteJid: '1@lid' },
    message: { documentMessage: { fileName, ...(caption ? { caption } : {}) } },
  });
  const bonanza = rec('x'.repeat(115) + ' Bonanza.pdf');
  assert.ok(bonanza.fileName.endsWith(' Bona'), 'the cut leaves "Bona" at the end');
  assert.equal(bonanza.fileNameTruncated, true);
  assert.equal(ownerOutboundJoins(bonanza), false);
  // "…BrochureX.pdf" cut straight after "Brochure": the word is not read at the cut.
  const brochureX = rec(`${'x'.repeat(111)} BrochureX.pdf`);
  assert.ok(brochureX.fileName.endsWith(' Brochure'), 'the cut leaves "Brochure" at the end');
  assert.equal(ownerOutboundJoins(brochureX), false);
  assert.equal(ownerOutboundJoins(wholeDoc(`${'x'.repeat(111)} BrochureX.pdf`)), false, 'nor does the whole name join');
  // Anything before the cut still counts, and a caption is never cut.
  assert.equal(ownerOutboundJoins(rec('Villa brochure ' + 'x'.repeat(200) + '.pdf')), true);
  assert.equal(ownerOutboundJoins(rec('BONA-W003 ' + 'x'.repeat(200) + '.pdf')), true);
  assert.equal(ownerOutboundJoins(rec(`${'x'.repeat(111)} BrochureX.pdf`, 'price list attached')), true);
  // But "Bona" left at the cut may be our name as much as the start of Bonanza, so it keeps
  // a caption's brochure out, as our name does anywhere on a document (fewer joins, never more).
  assert.equal(ownerOutboundJoins(rec('x'.repeat(115) + ' Bonanza.pdf', 'the brochure')), false);
  // TK or Bona past the cut is still there: the record says so (fileNameTk, fileNameBona).
  assert.equal(ownerOutboundJoins(rec('Villa brochure ' + 'x'.repeat(200) + ' TK.pdf')), false);
  assert.equal(ownerOutboundJoins(rec('Villa brochure ' + 'x'.repeat(200) + ' Bona.pdf')), false);
  assert.equal(ownerOutboundJoins(rec('BONA-W003 brochure ' + 'x'.repeat(200) + ' Bona.pdf')), true, 'a listing id joins whatever names Bona');
  // A name that was not cut ends where it ends.
  const short = rec('Villa Brochure');
  assert.equal(short.fileNameTruncated, false);
  assert.equal(ownerOutboundJoins(short), true);
});

test('a cut name never joins where the whole name would not: "bona fide", Bonanza, BrochureX, TK and Bona AB at every cut', () => {
  // Reading the cut as if a letter followed it turned "…Bona fi|de declaration" into
  // "…Bona fix", which is not the Latin phrase, so the cut name joined. Leaving the end out
  // is not enough on its own either: "…Bona| fide" left "…Bona" at the new end. The same
  // goes for a property word at the cut (…Brochure|X, …Price List|ing), a listing id
  // (…BONA-W003|1), a TK brochure, whichever side of the cut TK falls, and Bona AB's papers.
  let cuts = 0;
  for (const tail of ['Bona fide declaration.pdf', 'Bonanza.pdf', 'Bona-fides.pdf', 'بونات.pdf',
    'BrochureX.pdf', 'Price Listing.pdf', 'Floor Planner.pdf', 'BONA-W0031.pdf', '_TK Brochure.pdf', 'Brochure TK.pdf',
    'بروشور تي كي.pdf', 'بروشور تى كى.pdf', '_T.K. Brochure.pdf', 'Bona Traffic HD datasheet.pdf', 'Bona Traffic HD brochure.pdf',
    'Bona Price List 2026.pdf']) {
    for (const sep of [' ', '_', '-', '1']) {
      for (let pad = 80; pad <= 125; pad += 1) {
        const name = `${'x'.repeat(pad)}${sep}${tail}`;
        const rec = ownerDoc(name);
        if (rec.fileNameTruncated) cuts += 1;
        assert.equal(ownerOutboundJoins(wholeDoc(name)), false, `${pad} ${tail}: the whole name does not join`);
        assert.equal(ownerOutboundJoins(rec), false, `${pad} ${JSON.stringify(sep)} ${tail}: nor may the cut one`);
      }
    }
  }
  assert.ok(cuts > 1200, `the longer ones are cut (${cuts})`);
});

test('a brochure at every cut: the whole name joins, the cut one only where what is read holds the word', () => {
  let cuts = 0;
  let cutJoins = 0;
  for (const tail of ['Brochure.pdf', 'Floor Plan.pdf', 'BONA-W003 plan.pdf', 'قائمة الأسعار.pdf']) {
    for (const sep of [' ', '_', '-']) {
      for (let pad = 80; pad <= 125; pad += 1) {
        const name = `${'x'.repeat(pad)}${sep}${tail}`;
        const rec = ownerDoc(name);
        assert.equal(ownerOutboundJoins(wholeDoc(name)), true, `${pad} ${tail}: the whole name joins`);
        if (!rec.fileNameTruncated) {
          assert.equal(ownerOutboundJoins(rec), true, `${pad} ${tail}: not cut, so it joins`);
          continue;
        }
        cuts += 1;
        if (ownerOutboundJoins(rec)) cutJoins += 1;
      }
    }
  }
  assert.ok(cuts > 200, `the longer ones are cut (${cuts})`);
  // Each word sits in the last 16 code points of what a cut leaves, so no cut one joins by
  // it: a missed join, which the owner's list of real-estate chats catches (D17; Task 16
  // notes it there as a `property document`).
  assert.equal(cutJoins, 0);
  // A property word before the cut, TK after it: the whole name names TK, so neither joins.
  for (const word of ['Brochure', 'BONA-W003', 'Floor Plan', 'بروشور']) {
    for (let pad = 90; pad <= 130; pad += 5) {
      const name = `${word} ${'x'.repeat(pad)} TK.pdf`;
      assert.equal(ownerOutboundJoins(wholeDoc(name)), false, `${word} ${pad}: the whole name names TK`);
      assert.equal(ownerOutboundJoins(ownerDoc(name)), false, `${word} ${pad}: so the cut one does not join`);
    }
  }
  // Our name before the cut or after it: such a document joins only by a listing id, cut or not.
  for (let pad = 90; pad <= 130; pad += 5) {
    for (const [name, joins] of [
      [`Brochure ${'x'.repeat(pad)} Bona.pdf`, false],
      [`Bona ${'x'.repeat(pad)} Brochure.pdf`, false],
      [`BONA-W003 ${'x'.repeat(pad)} Bona.pdf`, true],
    ]) {
      assert.equal(ownerOutboundJoins(wholeDoc(name)), joins, `${name.slice(0, 12)} ${pad}: the whole name`);
      assert.equal(ownerOutboundJoins(ownerDoc(name)), joins, `${name.slice(0, 12)} ${pad}: the one the record carries`);
    }
  }
});

test('a cut name joins only where the whole name joins, whatever the name is made of', () => {
  // Names built from the pieces that decide the rules, cut through normaliseRecord at every
  // kind of place: whenever the cut record joins, the whole name must join too. The pieces
  // are picked by mulberry32: the old `(seed * 1103515245 + 12345) & 0x7fffffff` repeats in
  // its low bits, so with 48 pieces `% pieces.length` reached only 10 of them (51 now).
  const pieces = ['bona', 'Bona', 'BONA', 'بونا', 'fide', 'fides', 'fi', 'f', 'fid', 'nza', 'x', 'é', 'ſ', ' ', ' ',
    '_', '-', '.', '-W003', '-005', 'W', '1', '٤', '\u0301', 'ت', 'BONA-W003', 'BONA-005', 'pdf', '(', 'ب', 'bon', 'de', 's',
    'brochure', 'Brochure', 'floor', 'Plan', 'price', 'list', 'بروشور', 'مخطط', 'قائمة', 'الأسعار', 'X', 'TK', 'tk', 'تي', 'كي',
    'تى', 'كى', 'T.K.'];
  let seed = 20260928;
  const next = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  let cuts = 0;
  let cutJoins = 0;
  let keptOutByTk = 0;
  let keptOutByBona = 0;
  for (let i = 0; i < 4000; i += 1) {
    let name = `${'x'.repeat(60 + (next() % 45))} `;
    while (Array.from(name).length < 125 + (next() % 15)) name += pieces[next() % pieces.length];
    const rec = ownerDoc(name);
    if (!rec.fileNameTruncated) continue;
    cuts += 1;
    // Would have joined but for TK, or our name, in the part of the whole name the cut hid.
    if (rec.fileNameTk && ownerOutboundJoins({ ...rec, fileNameTk: false })) keptOutByTk += 1;
    if (rec.fileNameBona && ownerOutboundJoins({ ...rec, fileNameBona: false })) keptOutByBona += 1;
    if (!ownerOutboundJoins(rec)) continue;
    cutJoins += 1;
    const whole = name.replace(/\s+/g, ' ').trim();
    assert.equal(ownerOutboundJoins(wholeDoc(whole)), true, JSON.stringify(name));
  }
  assert.ok(cuts > 3900, `the names are cut (${cuts})`);
  assert.ok(cutJoins > 150, `and a cut name can still join (${cutJoins})`);
  assert.ok(keptOutByTk > 2, `and TK in the whole name keeps some out (${keptOutByTk})`);
  assert.ok(keptOutByBona > 50, `and so does our name (${keptOutByBona})`);
});

test('any truthy cut flag reads the name as cut: that only ever means fewer joins', () => {
  const doc = (fileName, over = {}) => ({ fileName, fileNameTk: false, fileNameBona: false, media: '[document: …]', ...over });
  const name = `${'x'.repeat(100)} Brochure`;
  assert.equal(ownerOutboundJoins(doc(name)), true, 'uncut, it ends with the word');
  for (const fileNameTruncated of [true, 1, 'yes']) {
    assert.equal(ownerOutboundJoins(doc(name, { fileNameTruncated })), false, String(fileNameTruncated));
  }
  assert.equal(ownerOutboundJoins(doc(`Villa_Brochure ${'x'.repeat(100)}`, { fileNameTruncated: true })), true, 'far from the cut, the word counts');
  assert.equal(ownerOutboundJoins(doc(`BONA-W003 ${'x'.repeat(100)}`, { fileNameTruncated: true })), true, 'and so does a listing id');
  assert.equal(ownerOutboundJoins(doc(`bona-real-estate.com ${'x'.repeat(100)}`, { fileNameTruncated: true })), false, 'a site link is not read in a cut name');
  assert.equal(ownerOutboundJoins(doc(`bona-real-estate.com ${'x'.repeat(100)}`)), true, 'it is in a whole one');
});

```

(b5) The timing test reads the new patterns. Find:

```js
    fill('bona.azoz.uk.', n), fill('bona.azoz.uk@', n), fill('bona.azoz.uk_', n),
  ];
```

Replace with:

```js
    fill('bona.azoz.uk.', n), fill('bona.azoz.uk@', n), fill('bona.azoz.uk_', n),
    fill('floor ', n), fill('floor-', n), fill('floor_plan', n), fill('brochur', n), fill('brochureX', n), fill('price ', n),
    fill('payment_', n), fill('fact sheet', n), fill('قائمة ', n), fill('جدول ال', n), fill('خطة ', n), fill('البروشور', n), fill('كتي', n),
    fill('tk', n), fill('tk ', n), fill('tk-estate', n), fill('tk_', n), fill('تي ', n), fill('تي', n), fill('تيكي', n),
    fill('t.k', n), fill('t.', n), fill('تى ', n), fill('تى', n), fill('تيكى', n),
  ];
```

(b6) Find:

```js
    ['ownerOutboundJoins cut name', (s) => ownerOutboundJoins({ fileName: s, fileNameTruncated: true, media: '[document: x.pdf]' })],
  ];
```

Replace with (a cut name with no `fileNameTk` or `fileNameBona` now stops at the TK or Bona check, so the cut-name reading is timed with both `false`):

```js
    ['ownerOutboundJoins cut name', (s) => ownerOutboundJoins({ fileName: s, fileNameTruncated: true, fileNameTk: false, fileNameBona: false, media: '[document: x.pdf]' })],
    ['isTkDocument', (s) => isTkDocument({ text: s, fileName: s, media: '[document: x.pdf]' })],
    ['PROPERTY_DOC_RE', (s) => PROPERTY_DOC_RE.test(s)],
    ['TK_RE', (s) => TK_RE.test(s)],
  ];
```

**(c) `services/api/test/wa-poller.test.mjs`** — three edits (on the file as Task 9 left it, checked against its commits up to 232b9f8; if a test below has moved, make the same change to it as Task 9 left it: only the lines shown change).

(c0) Task 9's Bona brochure test. Find:

```js
test('(t) a Bona brochure the owner sends starts a chat; a file that only looks like one does not', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'DOC', fromMe: true, jid: STRANGER, pushName: null, messageType: 'documentMessage', media: '[document: Bona Brochure.pdf]', fileName: 'Bona Brochure.pdf' }),
```

Replace with:

```js
test('(t) a brochure the owner sends starts a chat; a file that only looks like one does not, nor one that names Bona (D16)', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'DOC', fromMe: true, jid: STRANGER, pushName: null, messageType: 'documentMessage', media: '[document: Palm Villa Brochure.pdf]', fileName: 'Palm Villa Brochure.pdf' }),
    msg({ id: 'BONADOC', fromMe: true, jid: '966544444444@s.whatsapp.net', pushName: null, ts: NOW - 40_000, messageType: 'documentMessage', media: '[document: Bona Brochure.pdf]', fileName: 'Bona Brochure.pdf' }),
```

and, a few lines below in the same test, find:

```js
    ['DOC', 'out', 'owner_number', null, '[document: Bona Brochure.pdf]'],
```

Replace with:

```js
    ['DOC', 'out', 'owner_number', null, '[document: Palm Villa Brochure.pdf]'],
```

(c1) Find the test `'(t) a document name cut at 120 characters starts a chat only where the whole name would (A8)'` as Task 9 left it, and replace its opening, from its `test(` line through its `assert.equal(h.db.countLeads(), 1, 'only the brochure');` line:

```js
test('(t) a document name cut at 120 characters starts a chat only where the whole name would (A8)', async () => {
  // What is left of "… Bonanza menu.pdf" and of a real brochure's long name after the cut.
  const cutBonanza = `${'x'.repeat(115)} Bona`;
  const cutBrochure = `Bona Villa brochure ${'x'.repeat(100)}`;
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'CUT1', fromMe: true, jid: STRANGER, pushName: null, ts: NOW - 60_000, messageType: 'documentMessage', media: `[document: ${cutBonanza}]`, fileName: cutBonanza, fileNameTruncated: true }),
    msg({ id: 'CUT2', fromMe: true, jid: STRANGER2, pushName: null, ts: NOW - 30_000, messageType: 'documentMessage', media: `[document: ${cutBrochure}]`, fileName: cutBrochure, fileNameTruncated: true }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 1, 'only the brochure');
```

with:

```js
test('(t) a document name cut at 120 characters starts a chat only where the whole name would (A8, D16)', async () => {
  // What is left of "… Bonanza menu.pdf" and of a real brochure's long name after the cut;
  // the record says whether the whole name named TK or Bona (lib/evolution.mjs `fileNameTk`,
  // `fileNameBona`). A brochure that names Bona would stay out now, so this one does not.
  const cutBonanza = `${'x'.repeat(115)} Bona`;
  const cutBrochure = `Palm Villa brochure ${'x'.repeat(100)}`;
  const cut = { messageType: 'documentMessage', fileNameTruncated: true, fileNameTk: false, fileNameBona: false };
  const h = harness({ inbox: true, windows: [[
    msg({ ...cut, id: 'CUT1', fromMe: true, jid: STRANGER, pushName: null, ts: NOW - 60_000, media: `[document: ${cutBonanza}]`, fileName: cutBonanza }),
    msg({ ...cut, id: 'CUT2', fromMe: true, jid: STRANGER2, pushName: null, ts: NOW - 30_000, media: `[document: ${cutBrochure}]`, fileName: cutBrochure }),
    msg({ ...cut, id: 'CUT3', fromMe: true, jid: '966544444444@s.whatsapp.net', pushName: null, ts: NOW - 20_000, media: `[document: ${cutBrochure}]`, fileName: cutBrochure, fileNameTk: true }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 1, 'only the brochure whose whole name did not name TK');
```

(the rest of that test — the lead is `966533333333`, `in`, holds `CUT2`, `tally.joined` is 1 — stays as it is).

(c2) Append to the end of the file (after its last test, as Task 9 left it):

```js

test('(t) any developer\'s price list the owner sends starts a chat; a floor-finish brochure named Bona and a TK brochure do not (D16)', async () => {
  const doc = (id, jid, fileName, ts, extra = {}) => msg({
    id, fromMe: true, jid, pushName: null, ts, messageType: 'documentMessage', media: `[document: ${fileName}]`, fileName, ...extra,
  });
  const h = harness({ inbox: true, windows: [[
    doc('D-PRICE', STRANGER, 'Price List Sep.pdf', NOW - 60_000),
    doc('D-BONA', STRANGER2, 'Bona Traffic HD brochure.pdf', NOW - 50_000),
    doc('D-TK', '966544444444@s.whatsapp.net', 'TK Brochure Villa.pdf', NOW - 40_000, { fileNameTk: true }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 1, 'only the price list');
  const [lead] = h.leads();
  assert.equal(lead.phone_e164, '966522222222');
  assert.equal(lead.match_method, 'owner_outbound');
  assert.equal(lead.inbox_state, 'in');
  assert.deepEqual(rows(h, lead.lead_id), [['D-PRICE', 'out', 'owner_number']]);
  assert.equal(tally.joined, 1);
  h.cleanup();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/inbox-eligibility.test.mjs api/test/evolution.test.mjs api/test/wa-poller.test.mjs`
Expected: FAIL — `inbox-eligibility.test.mjs` does not load (`SyntaxError: The requested module '../lib/inbox/eligibility.mjs' does not provide an export named 'PROPERTY_DOC_RE'`); in `evolution.test.mjs` three tests fail because records carry no `fileNameTk` or `fileNameBona` yet ("a text message flattens …", "normaliseRecord carries the placeholder …", "fileNameTk and fileNameBona say …"); in `wa-poller.test.mjs` three fail, each because only the word Bona joins a document yet: the brochure test (`Palm Villa Brochure.pdf` does not join and `Bona Brochure.pdf` does, so the one lead is `966544444444`), the A8/D16 cut test (no brochure joins: `0 !== 1`) and the D16 test (the price list does not join and the Bona brochure does, so the lead is `966533333333`). Every other test passes.

- [ ] **Step 3: Implement the rules** — replace the whole of `services/api/lib/inbox/eligibility.mjs` with:

```js
/**
 * Which WhatsApp chats belong in the Bona inbox (2026-09-27 design §4.1, D9, D12, D16).
 *
 * The team reads and answers these chats from the dashboard, and they arrive on the
 * owner's personal number, which his TK clients and private conversations share. So a
 * chat joins only on something that can only be about Bona:
 *
 *   - a client's message carrying a site Ref line (with its listing part, or a code a site
 *     session holds), click-to-WhatsApp ad context or a listing id (`BONA-W003`) is certain.
 *     TK runs no click-to-WhatsApp ads to this number (owner, D15), so ad context stays
 *     certain;
 *   - a client's message that only says "bona" / "بونا", or carries a bare Ref-shaped code
 *     no session holds, is a guess. It goes to the owner's Unsure list, never into the
 *     inbox by itself. The other guess, the ±15-min click window, arrives here as the
 *     lead's match method (`time_window`);
 *   - a message the OWNER sends joins a chat when it carries a Bona site link or a listing
 *     id, or when it is a property document — a brochure, floor plan, price list, payment
 *     plan, master plan or fact sheet, from any developer (D16) — by its file name or
 *     caption. A document that names TK (`TK`, `T.K.`, `tk-estates`, `تي كي`) never joins
 *     by itself: TK chats stay out (D17). Nor does a document that names Bona without a
 *     listing id or a site link: Bona AB makes wood-floor finishes, so "Bona Traffic HD
 *     brochure.pdf" to a TK contractor proves nothing (the poller puts such a chat on the
 *     owner's list to check, D17). Nothing else he sends counts, and the word "Bona" joins
 *     nothing by itself.
 *
 * The answer is stored on the lead (`leads.inbox_state`), and a message only ever moves it
 * forward: a guess can become certain, but `in` is never demoted by a later message and
 * `out` (the owner said "not a client") is never left automatically. Only the owner's
 * buttons move a chat out of either (lib/inbox/store.mjs `setInboxState`).
 *
 * Pure functions, no I/O and no logging: the poller asks, the store records.
 */
import { parseRef } from '../attribution.mjs';

/**
 * A whole listing id: `BONA-W003`, `bona-005` — not `BONA-W0031`, not `XBONA-W003`, and not
 * `BONA-W003٤` (`\b` knows only ASCII digits, so the Arabic-Indic and Persian ones are named).
 */
export const LISTING_ID_RE = /\bBONA-W?\d{3}(?![\w٠-٩۰-۹])/i;
/**
 * Our name as a word, in either script. A guess on its own: TK and private chats say it too.
 * Both scripts are bounded by anything that is not a letter or a mark, so `_`, digits and
 * punctuation end the word (`Bona_Villa`, `Bona2026`, `(بونا)`) while `Bonanza`, `Bonaé` and
 * the Arabic words that only contain the four letters do not count: كوبونات (coupons),
 * أبونا (our father), طلبونا, زبوناً … A clitic form (وبونا) is missed on purpose: that
 * fails safe, the owner still has the Move button.
 *
 * "bona fide" / "bona fides" is Latin, common in English real-estate papers ("Bona Fide
 * Purchaser Declaration"), and never our name.
 *
 * The bounds are `\p{…}` classes, which mean something only with the `u` flag: reuse this
 * pattern by calling `.test()` on it, or rebuild it with `'iu'`, never `'i'` alone.
 */
export const BONA_WORD_RE = /(?<![\p{L}\p{M}])(?:bona(?![\p{L}\p{M}])(?![\s_.-]*fides?(?![\p{L}\p{M}]))|بونا(?![\p{L}\p{M}]))/iu;
/**
 * The site (or its legacy host) as a link, with or without a scheme and `www.`. The
 * characters either side must not carry on a host name, so `notbona-real-estate.com`,
 * `bona-real-estate.company`, `bona-real-estate.com.evil.example`, `….com.السعودية`,
 * `bona.azoz.uk。evil.example` (browsers read `。．｡` as a dot in a host), `bona.azoz.uk_evil…`
 * and the user part of `bona.azoz.uk@evil.example`, `bona.azoz.uk.@evil.example` or
 * `bona.azoz.uk:443@evil.example` are not ours. A full stop that ends the text or is
 * followed by anything but a host character is allowed: a sentence can end with the link.
 * So is a port (`bona-real-estate.com:443/ar/`).
 *
 * After a colon, the `@` of user-info is looked for only within 256 characters, and a colon
 * followed by more than 256 characters with no space, `/` or `@` is refused as well (fewer
 * joins, never more). Unbounded, that look-ahead re-read the rest of the text from every
 * copy of the host in it (`bona.azoz.uk:bona.azoz.uk:…@`), quadratic in the text's length.
 */
export const SITE_LINK_RE = /(?:^|[^a-z0-9.-])(?:www\.)?(?:bona-real-estate\.com|bona\.azoz\.uk)(?![\p{L}\p{M}\p{N}_@-]|[.。．｡][\p{L}\p{M}\p{N}@]|:(?:[^\s/@]{0,256}@|[^\s/@]{257}))/iu;
export const INBOX_STATES = Object.freeze(['in', 'unsure', 'out']);

/**
 * The kinds of property document a developer or an agent sends (D16), in English and
 * Arabic, each a whole word: bounded, like `BONA_WORD_RE`, by anything that is not a letter
 * or a mark, so `_`, `-`, digits and punctuation end it (`Phase 2_Brochure_EN.pdf`,
 * `brochure2.pdf`) while `brochureX` does not count. Two English words may be written with a
 * space, `-`, `_` or nothing between them (`Floor-Plan`, `floorplan`, `price_list`). The
 * Arabic single words also count with the article (البروشور, المخطط); a clitic before them
 * (وبروشور) is missed on purpose, which fails safe like وبونا. `كتيّب` may carry its shadda.
 *
 * Every alternative starts with a fixed word and repeats nothing, so a failed match costs a
 * bounded amount at each position: linear in the text's length.
 */
const DOC_WORDS = String.raw`(?:brochures?|floor[\s_-]?plans?|price[\s_-]?lists?|payment[\s_-]?plans?|master[\s_-]?plans?|fact[\s_-]?sheets?`
  + String.raw`|(?:ال)?بروشور(?:ات)?|(?:ال)?كتي\u0651?ب|(?:ال)?مخطط(?:ات)?`
  + String.raw`|(?:قائمة|جدول)[\s_-]?ال[أا]سعار|خطة[\s_-]?(?:الدفع|السداد)|جدول[\s_-]?(?:الدفعات|السداد))`;
export const PROPERTY_DOC_RE = new RegExp(String.raw`(?<![\p{L}\p{M}])${DOC_WORDS}(?![\p{L}\p{M}])`, 'iu');
/**
 * The same words inside a cut document name, where the end of what is read is not the end
 * of the name: a word counts only when something that is not a letter or a mark follows it
 * inside what is read, so `…brochure` cut from `…brochureX` is never read as `brochure`.
 */
const PROPERTY_DOC_CUT_RE = new RegExp(String.raw`(?<![\p{L}\p{M}])${DOC_WORDS}(?=[^\p{L}\p{M}])`, 'iu');
/**
 * A listing id in a file name, where `_` stands for a space (`Villa_BONA-W003_EN.pdf`):
 * `LISTING_ID_RE` with `_` allowed on either side. `XBONA-W003` and `BONA-W0031` still do
 * not count. The second is the same inside a cut name: something that cannot carry the id
 * on follows it inside what is read.
 */
const LISTING_ID_NAME_RE = /(?<![A-Za-z0-9])BONA-W?\d{3}(?![A-Za-z0-9٠-٩۰-۹])/i;
const LISTING_ID_NAME_CUT_RE = /(?<![A-Za-z0-9])BONA-W?\d{3}(?=[^A-Za-z0-9٠-٩۰-۹])/i;

/**
 * TK Estate & Design, the owner's other company, named on a document: `TK` as a word
 * (bounded by anything that is not a letter or a digit, so `TK_Villa` and `TK-Estates`
 * count and `TKO` or `TK2` do not), `T.K.` / `T.K`, `tk-estates` / `TKEstates`, or `تي كي`
 * as its own word, with ي or ى in either place (Saudi typing often ends a word with ى: تى
 * كى), bounded like `بونا` (بلاستيكي, بلاستيكى and أوتوماتيكي only contain the letters). A
 * document that matches never joins a chat by itself (D16, D17). Every alternative starts
 * with a fixed letter and repeats nothing: linear in the text.
 */
export const TK_RE = /(?<![\p{L}\p{N}])tk(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])t\.k\.?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])tk[\s_-]?estates?|(?<![\p{L}\p{M}])ت[يى][\s_.-]?ك[يى](?![\p{L}\p{M}])/iu;

/**
 * Code points left out at the end of a document name that was cut (`fileNameTruncated`):
 * nothing close to the cut is read.
 */
const CUT_MARGIN = 16;

/** What a cut document name can be read by: all but its last `CUT_MARGIN` code points. */
function readableCutName(name) {
  return Array.from(name).slice(0, -CUT_MARGIN).join('');
}

/**
 * A Ref line exactly as the site writes it: `Ref BONA-W003 · K7Q2XR`, or `Ref BONA · K7Q2XR`
 * from a page without a listing (`refLine()` in src/scripts/attribution.js, EnquiryForm.astro).
 * The listing part and a separator are always there, and nothing carries the code on.
 * `parseRef` is looser — no separator needed, ASCII bounds — so it also reads "Ref bona
 * please" as listing BONA + code PLEASE. Every line this matches, parseRef reads too.
 */
const SITE_REF_RE = /\bRef\s+BONA(?:-W?\d{3})?\s*[·:|-]\s*[A-HJ-NP-Z2-9]{5,6}(?![\p{L}\p{N}_])/iu;

/** Anything that is not a string reads as empty: a record's text or caption may be null. */
const str = (v) => (typeof v === 'string' ? v : '');
const isDocument = (media) => str(media).startsWith('[document');

/**
 * Does the document's file name name TK (`TK_RE`) or Bona (`BONA_WORD_RE`)? A name cut at
 * 120 code points hides its end, so for a cut name the answer comes from what
 * lib/evolution.mjs worked out on the whole name before it was cut (`fileNameTk`,
 * `fileNameBona`: `wholeSays`); a cut name without that answer may name it in the part
 * nobody saw, and is read as if it did. What is left of the name is read as well, cut or
 * not ("…TK" cut from "…TKO" reads as TK): either way that only ever means fewer joins.
 * A `wholeSays` of exactly `true` counts for a name that was not cut too.
 */
function nameSays(re, name, fileNameTruncated, wholeSays) {
  return (fileNameTruncated ? wholeSays !== false : wholeSays === true) || re.test(name);
}

/**
 * What one message from a client says about the chat.
 *
 * A Ref line is certain only in the shape the site writes it (`SITE_REF_RE`), or when the
 * poller found a site session holding the code (`refKnown`, from `db.getSessionByRef`).
 * `parseRef` checks only the shape, so a bare `Ref K7Q2X` is also "ref please", "Ref check
 * done" or a TK booking reference: a guess, never a join by itself. `hasAdMeta` and
 * `refKnown` count only when exactly `true`, like the text, never coerced. A site link
 * with no listing id is only a guess too (spec §4.1 does not name it); the owner decides.
 * @param {{ text?: unknown, hasAdMeta?: boolean, refKnown?: boolean }|null} [o]
 * @returns {'certain'|'unsure'|null}
 */
export function inboundSignal(o) {
  const { text = '', hasAdMeta = false, refKnown = false } = o ?? {};
  const t = str(text);
  const ref = parseRef(t);
  if (SITE_REF_RE.test(t) || (ref && refKnown === true)) return 'certain';
  if (hasAdMeta === true || LISTING_ID_RE.test(t)) return 'certain';
  if (ref || BONA_WORD_RE.test(t)) return 'unsure';
  return null;
}

/**
 * Is this a document that names TK, by its file name or its caption (D16)? The poller
 * puts such a chat on the owner's list of real-estate chats to check instead of joining
 * it (D17). Takes a normalised record (lib/evolution.mjs); a cut name is judged as in
 * `nameSays`.
 * @param {{ text?: unknown, fileName?: unknown, fileNameTruncated?: boolean, fileNameTk?: boolean, media?: unknown }|null} [o]
 * @returns {boolean}
 */
export function isTkDocument(o) {
  const { text = '', fileName = null, fileNameTruncated = false, fileNameTk = null, media = null } = o ?? {};
  if (!isDocument(media)) return false;
  return TK_RE.test(str(text)) || nameSays(TK_RE, str(fileName), Boolean(fileNameTruncated), fileNameTk);
}

/**
 * Does a message the owner sent make this a Bona chat (D12, D16)? Takes a normalised
 * record (lib/evolution.mjs): `text` is the body or the caption, `media` the placeholder
 * (`[document: name]`, `[image]`, …), `fileName` a document's cleaned name, and
 * `fileNameTk` / `fileNameBona` whether the whole name named TK / Bona.
 *
 * Any message: a Bona site link or a listing id in the text or caption joins. A document
 * that names TK (`TK_RE`) in its file name or caption never joins, whatever else it says.
 * Otherwise a document joins by a site link or a listing id in its caption or file name,
 * or by a property-document word (`PROPERTY_DOC_RE`) in either — but a document that names
 * Bona (`BONA_WORD_RE`) joins only by a site link or a listing id: "Bona Traffic HD
 * brochure.pdf" is Bona AB's floor finish as often as ours, and the poller puts it on the
 * owner's list to check instead (D17). The word "Bona" joins nothing by itself.
 *
 * A name cut at 120 code points (`fileNameTruncated`) may go on past the cut: "…Brochure"
 * may be "…BrochureX", "…BONA-W003" may be "…BONA-W0031". So a cut name is read without its
 * last 16 code points (`CUT_MARGIN`), and there a word or an id counts only when a
 * character that cannot carry it on follows it inside what is read; a site link, whose
 * look-ahead reaches much further, is not read in a cut name at all. Whatever is then found
 * in it is found in the whole name too, and TK and Bona are judged on the whole name
 * (`fileNameTk`, `fileNameBona`) as well as on what is left of it, so a cut name joins only
 * where the whole name would join. Any truthy flag counts as cut: that only ever means
 * fewer joins.
 * @param {{ text?: unknown, fileName?: unknown, fileNameTruncated?: boolean, fileNameTk?: boolean, fileNameBona?: boolean, media?: unknown }|null} [o]
 * @returns {boolean}
 */
export function ownerOutboundJoins(o) {
  const { text = '', fileName = null, fileNameTruncated = false, fileNameTk = null, fileNameBona = null, media = null } = o ?? {};
  const t = str(text);
  if (!isDocument(media)) return SITE_LINK_RE.test(t) || LISTING_ID_RE.test(t);
  const name = str(fileName);
  const cut = Boolean(fileNameTruncated);
  if (TK_RE.test(t) || nameSays(TK_RE, name, cut, fileNameTk)) return false;
  const readable = cut ? readableCutName(name) : name;
  if (SITE_LINK_RE.test(t) || LISTING_ID_RE.test(t)) return true;
  if (cut ? LISTING_ID_NAME_CUT_RE.test(readable) : LISTING_ID_NAME_RE.test(name) || SITE_LINK_RE.test(name)) return true;
  if (BONA_WORD_RE.test(t) || nameSays(BONA_WORD_RE, name, cut, fileNameBona)) return false;
  return PROPERTY_DOC_RE.test(t) || (cut ? PROPERTY_DOC_CUT_RE : PROPERTY_DOC_RE).test(readable);
}

/**
 * The chat's inbox state after one inbound message. `in` and `out` stay as they are; an
 * undecided or unsure chat becomes `in` on anything certain and `unsure` on a guess (the
 * word, or a lead the poller matched only by keyword or click window); otherwise it is
 * left as it was. A `current` that is not one of the three states reads as undecided
 * (the store's CHECK allows only those and NULL), so the answer is always a state or null.
 * @param {'in'|'unsure'|'out'|null|undefined} current
 * @param {{ signal?: 'certain'|'unsure'|null, method?: string|null }|null} [o]
 * @returns {'in'|'unsure'|'out'|null}
 */
export function nextInboxState(current, o) {
  const { signal = null, method = null } = o ?? {};
  const cur = INBOX_STATES.includes(current) ? current : null;
  if (cur === 'out' || cur === 'in') return cur;
  if (signal === 'certain') return 'in';
  if (signal === 'unsure' || method === 'keyword' || method === 'time_window') return 'unsure';
  return cur;
}
```

- [ ] **Step 4: The record says whether the whole name named TK or Bona** — five edits in `services/api/lib/evolution.mjs` (it keeps its read-only header; the import is the module's first). Find:

```js
/**
 * The most pages one read asks for; `readWindow` cuts a window that holds more than
```

Replace with:

```js
import { BONA_WORD_RE, TK_RE } from './inbox/eligibility.mjs';

/**
 * The most pages one read asks for; `readWindow` cuts a window that holds more than
```

Find:

```js
/**
 * A record's document name made safe to show (`name`, null when there is no document or
 * nothing usable is left) and whether it had to be cut at `MAX_FILE_NAME` code points to get
 * there (`truncated`; what cleaning removes is not a cut). The one place both are worked out,
 * so `mediaOf`'s placeholder and `normaliseRecord`'s `fileName`/`fileNameTruncated` agree.
 * @returns {{ name: string|null, truncated: boolean }}
 */
function fileNameOf(record) {
  const flat = flatFileName(unwrapMessage(record?.message)?.documentMessage?.fileName);
  const name = capCodePoints(flat, MAX_FILE_NAME).trim() || null;
  return { name, truncated: name !== null && name !== flat };
}
```

Replace with:

```js
/**
 * A record's document name made safe to show (`name`, null when there is no document or
 * nothing usable is left), whether it had to be cut at `MAX_FILE_NAME` code points to get
 * there (`truncated`; what cleaning removes is not a cut), and whether the whole cleaned
 * name, before any cut, names TK or Bona (`tk`, `bona`: lib/inbox/eligibility.mjs `TK_RE`,
 * `BONA_WORD_RE`). The one place all four are worked out, so `mediaOf`'s placeholder and
 * `normaliseRecord`'s `fileName`/`fileNameTruncated`/`fileNameTk`/`fileNameBona` agree.
 * @returns {{ name: string|null, truncated: boolean, tk: boolean, bona: boolean }}
 */
function fileNameOf(record) {
  const flat = flatFileName(unwrapMessage(record?.message)?.documentMessage?.fileName);
  const name = capCodePoints(flat, MAX_FILE_NAME).trim() || null;
  return {
    name,
    truncated: name !== null && name !== flat,
    tk: name !== null && TK_RE.test(flat),
    bona: name !== null && BONA_WORD_RE.test(flat),
  };
}
```

Find:

```js
 * read the end of it), both from `fileNameOf`, `noise` is `isNoise`. A document's name is chosen by its sender
```

Replace with:

```js
 * read the end of it), `fileNameTk` / `fileNameBona` true when the whole name, cut or not,
 * names TK / Bona — the two things about the part a cut hides that the inbox rules need
 * (D16) — all four from `fileNameOf`, `noise` is `isNoise`. A document's name is chosen by its sender
```

Find:

```js
 *             media: string|null, fileName: string|null, fileNameTruncated: boolean,
 *             noise: boolean }} NormalisedRecord
 */
export function normaliseRecord(record) {
  const key = record?.key ?? {};
  const jid = typeof key.remoteJid === 'string' ? key.remoteJid : null;
  const alt = key.remoteJidAlt ?? record?.remoteJidAlt ?? key.senderPn ?? null;
  const { name: fileName, truncated: fileNameTruncated } = fileNameOf(record);
```

Replace with:

```js
 *             media: string|null, fileName: string|null, fileNameTruncated: boolean,
 *             fileNameTk: boolean, fileNameBona: boolean, noise: boolean }} NormalisedRecord
 */
export function normaliseRecord(record) {
  const key = record?.key ?? {};
  const jid = typeof key.remoteJid === 'string' ? key.remoteJid : null;
  const alt = key.remoteJidAlt ?? record?.remoteJidAlt ?? key.senderPn ?? null;
  const { name: fileName, truncated: fileNameTruncated, tk: fileNameTk, bona: fileNameBona } = fileNameOf(record);
```

and, in the object it returns, find:

```js
    fileNameTruncated,
    noise: isNoise(record),
```

Replace with:

```js
    fileNameTruncated,
    fileNameTk,
    fileNameBona,
    noise: isNoise(record),
```

(No import cycle: `eligibility.mjs` imports only `../attribution.mjs`, which imports only `./cors.mjs`; neither reaches `evolution.mjs`.)

- [ ] **Step 5: The poller's comments** — two edits in `services/api/lib/wa-poller.mjs` (comments only; the code already hands `ownerOutboundJoins` the normalised record). In the module header, find:

```js
 * own message puts a chat `in` only when it carries a Bona link, a listing number or a Bona
 * brochure (D12 — TK and private chats share this number, so nothing else he types
 * counts). Only `in` chats are kept as transcripts (lib/inbox/ingest.mjs), both directions,
 * from the joining message plus the 24 h before it. An `out` chat never comes back on its
 * own. Every other conversation is still discarded exactly as above.
```

Replace with:

```js
 * own message puts a chat `in` only when it carries a Bona link or a listing number, or is a
 * property document that names neither TK nor Bona (D12, D16 — TK and private chats share
 * this number, so nothing else he sends counts; lib/inbox/eligibility.mjs has the rules).
 * Only `in` chats are kept as transcripts (lib/inbox/ingest.mjs), both directions, from the
 * joining message plus the 24 h before it. An `out` chat never comes back on its own.
 * Every other conversation is still discarded exactly as above.
```

In the doc comment of `inboxAfterOutbound`, find:

```js
   * in the outbox. An `out` chat never comes back on its own. Any other chat joins only on
   * a Bona link, a listing number or a Bona brochure (D12), judged on the normalised record
   * as it is, so a document name cut at 120 code points is read as cut (A8). A stranger he
   * writes to that way becomes an `owner_outbound` lead — no ad fan-out and no new-lead
   * note, because he started it (lib/leads.mjs `OWNER_METHODS`) — with no name: a `fromMe`
   * record's pushName is his own.
```

Replace with:

```js
   * in the outbox. An `out` chat never comes back on its own. Any other chat joins only on
   * a Bona link, a listing number or a property document that names neither TK nor Bona
   * (D12, D16), judged on the normalised record as it is, so a document name cut at 120
   * code points is read as cut, with what the whole name said (A8, `fileNameTk`,
   * `fileNameBona`). A stranger he writes to that way becomes an `owner_outbound` lead — no
   * ad fan-out and no new-lead note, because he started it (lib/leads.mjs `OWNER_METHODS`) —
   * with no name: a `fromMe` record's pushName is his own.
```

- [ ] **Step 6: Run the three files**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/inbox-eligibility.test.mjs api/test/evolution.test.mjs api/test/wa-poller.test.mjs`
Expected: PASS, 0 fail. (`inbox-eligibility`: 4 tests more than before — the two old document tests are replaced by five, and the "brochure at every cut" sweep is new; `evolution`: 1 more; `wa-poller`: 1 more. The timing test stays well under its 100 ms per call: the slowest new case measured 17 ms at 200,000 characters.)

- [ ] **Step 7: README** — in `services/README.md`, in the **Inbox** paragraphs Task 13 wrote under `### Dashboard`:

(a) D15. Find the line that starts `- *Unsure*:` and insert, directly above it (so it continues the *Certain* bullet):

```markdown
  Ad context stays certain: TK runs no click-to-WhatsApp ads to this number (owner,
  2026-09-28, D15), so an ad-origin chat here is a Bona client.
```

(b) D16. Replace the whole *Owner-started* bullet — from the line that starts `- *Owner-started*:` down to, not including, the line that starts `- *Owner buttons*:` — with:

```markdown
- *Owner-started*: the owner's own message in a 1:1 chat puts that chat `in` (a new lead gets
  `match_method = 'owner_outbound'`) with the 24 h before it when it carries a Bona site link
  (`bona-real-estate.com`, legacy `bona.azoz.uk`) or a listing id, or when it is a property
  document (D16): a brochure, floor plan, price list, payment plan, master plan or fact sheet
  from any developer, in English or Arabic, named in its file name or caption, or a document
  whose file name carries a listing id or a site link. A document whose file name or caption
  names TK (`TK`, `T.K.`, `tk-estates`, `تي كي` / `تى كى`) never joins, whatever else it says.
  A document that names Bona joins only by a listing id or a site link: Bona AB also makes
  wood-floor finishes, with brochures and price lists of its own, so "Bona Traffic HD
  brochure.pdf" goes on the owner's list of real-estate chats to check instead. A document
  name cut at 120 characters joins only where the whole name would (`fileNameTk` and
  `fileNameBona` carry whether the whole name named TK or Bona). Nothing else he types
  counts — TK and private chats share the number. These leads fan out to no ad platform (no
  click is behind them), send him no new-lead note, and are born answered (`first_reply_ts`
  set, `first_inbound_ts` empty), so neither the waiting queue nor the Hermes
  `bona-unanswered-leads` watchdog flags them.
```

Check: `cd /home/azoz778/bona-wt/team-inbox && grep -c -e 'D15), so an ad-origin chat' -e 'document (D16): a brochure' services/README.md` → `2`.

- [ ] **Step 8: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail — 6 more tests than after Task 14 (checked on a copy of the tree with Tasks 1–14 applied: 899 → 905, all pass).

- [ ] **Step 9: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/inbox/eligibility.mjs services/api/lib/evolution.mjs services/api/lib/wa-poller.mjs services/README.md services/api/test/inbox-eligibility.test.mjs services/api/test/evolution.test.mjs services/api/test/wa-poller.test.mjs
git commit -m "inbox: any property document the owner sends joins the chat; the word Bona and a TK document do not

Owner decisions D15 and D16 (2026-09-28). A brochure, floor plan, price list,
payment plan, master plan or fact sheet in the file name or caption joins, as do
a listing id or a site link. The bare word Bona on a document no longer does,
and a document that names Bona joins only by a listing id or a link (Bona AB
makes floor finishes and has brochures of its own). A document naming TK
(TK, T.K., tk-estates, تي كي / تى كى) never joins. The record carries
fileNameTk and fileNameBona, worked out on the whole name, so a cut name still
joins only where the whole name would.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Owner answer 2026-09-28 (binding; supersedes the task text above where they differ — "only clear property documents join")
The owner chose: **"brochure" joins on its own; the other document words join only next to a property word, a listing id or a Bona site link**, because TK design work uses them too ("Payment plan - kitchen works.pdf", "مخطط الكهرباء.pdf", "كتيب الصيانة.pdf", a fit-out floor plan). Implement it this way:
- Split the document words into two exported patterns in `lib/inbox/eligibility.mjs` (both `iu`, linear, bounded by non-letters, same style as `PROPERTY_DOC_RE`):
  - `BROCHURE_RE` — `brochure(s)`, `بروشور`/`بروشورات`: joins on its own (still subject to the TK and Bona document rules).
  - `QUALIFIED_DOC_RE` — `floor ?plan(s)`, `price ?list(s)`, `payment ?plan(s)`, `master ?plan(s)`, `fact ?sheet(s)`, `كتيب`/`كتيّب`, `مخطط`/`مخططات`, `قائمة الأسعار`/`قائمة الاسعار`, `جدول الأسعار`/`جدول الاسعار`, `خطة الدفع`/`خطة السداد`, `جدول الدفعات`/`جدول السداد`: joins only when the same file name or caption ALSO matches `PROPERTY_NOUN_RE`, a listing id or a site link.
  - `PROPERTY_NOUN_RE` (exported) — English `villa(s)`, `apartment(s)`, `unit(s)`, `project(s)`, `tower(s)`, `residence(s)`, `townhouse(s)`, `duplex`, `penthouse(s)`, `compound`, `plot(s)`, `land`, `property`/`properties`; Arabic `فيلا`/`فلل`/`فله`/`فلة`, `شقة`/`شقق`/`شقه`, `مشروع`/`مشاريع` (with or without `ال`), `وحدة`/`وحدات`, `برج`/`أبراج`, `عمارة`, `دوبلكس`, `بنتهاوس`, `تاون هاوس`, `مجمع سكني`, `أرض`/`ارض`/`أراضي` (without `ال`), `عقار`/`عقارات`.
  - `PROPERTY_DOC_RE` stays exported as the union of `BROCHURE_RE` and `QUALIFIED_DOC_RE` (Task 16's `'property document'` candidate marker keeps using it, so a qualified word that did not join still reaches the owner's Unsure list).
- Tests (replace the task text's cases where they differ): JOIN — `Knightsbridge_Phase 2_Brochure_EN.pdf`, `بروشور المشروع.pdf`, `Villa floor plan.pdf`, `مخطط فيلا.pdf`, `Project price list.pdf`, `Unit payment plan.pdf`, `قائمة أسعار الشقق.pdf`, `Tower A fact sheet.pdf`, `floor plan BONA-W003.pdf`, caption "price list for the villa" on `doc.pdf`; DO NOT JOIN (and are candidates in Task 16) — `Floor-Plan_Type-A.pdf`, `Price List Sep.pdf`, `payment_plan.pdf`, `مخطط الدور الأرضي.pdf`, `قائمة الأسعار.pdf`, `Payment plan - kitchen works.pdf`, `مخطط الكهرباء.pdf`, `كتيب الصيانة.pdf`, `Master plan.pdf`; the Bona/TK/invoice cases stay as the task text says. Extend the cut-name sweep and the timing test to the three patterns.
- Record the answer in the plan's Phase 2 section next to D16 (one paragraph) when you commit.

---

### Task 16: Real-estate chats go to the owner's Unsure list (D17)

Owner decision of 2026-09-28 (binding, same weight as D1–D14): **D17** Any chat on his number that looks like real estate — property words, in either direction — but carries no sure signal goes to the **owner-only Unsure list** as a *candidate*, for him to check and tap *Move to Bona inbox* or *Not a client*. Nothing joins automatically without a sure signal (a Ref line in the site's shape or a code a session holds, ad context, a listing id, an owner-sent Bona link or property document, Task 15). TK clients who write to the personal number stay out of the Bona inbox this way (never list, or *Not a client*).

A candidate is **not a lead**: no touchpoint, no ad fan-out, no new-lead note, no transcript, never the message text. It is one row per chat in a new table `inbox_candidates` — the number and jid (and lid, when WhatsApp shows one), the name WhatsApp shows for the client (never the owner's own name on a message he sent), the property words used (canonical forms, at most 8), first and last time, how many messages, who wrote last. Staff never see one, in HTML or JSON.

Decisions taken while writing this task (inside D17 and the brief):

- **Schema.** v4 has not shipped (the ship task runs after this one), so the table goes into the v4 migration, in a later commit than the rest of v4 (the comment says so). Every existing v4 test stays green and gains assertions for the new table. `words` is the comma-joined canonical words.
- **Words** (`PROPERTY_WORD_RE`, `propertyWordsIn`): the brief's list, bounded like `BONA_WORD_RE`. Two additions for recall on typed Arabic, both only ever adding a chat to the owner's list, never joining one: ه for ة (فله, شقه, غرفه, عموله), and the article on most nouns (الفيلا, الشقة, العقار, الإيجار) — not on أرض and غرفة, where "الأرض" (the ground) and "الغرفة" (the room) are everyday words. The shown form is the canonical one (`إيجار` for للإيجار, `sqm` for m²).
- **Documents and document words.** A TK document the owner sends (Task 15's `isTkDocument`) is a candidate even with no property word; its words start with `tk document`. A property-document word (Task 15's `PROPERTY_DOC_RE`: brochure, price list, بروشور …) in the text, the caption or a document's file name, in either direction, adds `property document`: so every owner-sent property document that did not join — one that names Bona without a listing id (Task 15), one whose name was cut too close to the word — is a candidate, and so is a client asking for "the price list". The owner sees why a chat is there. A document's file name counts for property words in either direction too.
- **Only a chat with a phone number.** A record whose only id is a lid is never noted, like A7's rule that no lead is made from one: a lid cannot be checked against the team or the never list (it may be a colleague whose lid is not learned yet, with their name), cannot be replied to, and the exclusion sweep cannot catch it later. Nor is a jid that is not a phone's (`…@newsletter`, a WhatsApp channel the instance follows: every "فيلا للبيع" post would be a candidate). *Move* refuses such a row too, should one exist.
- **Dismissed keeps only the ids.** *Not a client* clears the row's name, words, count and last writer, sets both times to the moment of the dismissal, and keeps it (state `dismissed`) only so the chat is not listed again; `noteCandidate` leaves a dismissed row untouched. Open rows are pruned 30 days after their last property message — so a chat that keeps writing about property stays until 30 days after its last such message, and the privacy page says exactly that, not "up to 30 days" — and dismissed rows a year after the dismissal (`CANDIDATE_KEEP_MS`, `DISMISSED_KEEP_MS`); the privacy page says both.
- **A chat that becomes a lead leaves the list.** The poller removes its rows the moment a record of that chat has a lead behind it (created, merged, joined or already there, in any state), and so do the owner's *Add chat by phone number* and *Move to Bona inbox* on a lead. A lead made elsewhere (a web form) is caught when read: `listCandidates` and `countCandidates` leave out, in SQL, a candidate whose number, jid or lid is on a lead — that lead's own state decides — until the poller sees that chat again or the 30-day prune takes the row. The Unsure tab also leaves out one whose number is a colleague's or on the never list (the store knows no team, like Task 12's rule 1).
- **Counting.** `countUnsure()` keeps its contract (unsure leads only). The owner's tab label on the inbox page and on the Unsure page counts the guesses plus the candidates the tab shows — one list (at most 200, newest first) for both, so the label and the list never disagree. Task 10's rail has no Unsure count (its only badge is the viewer's unread Inbox count), so there is no nav number to change.
- **The poller never fails a record for the list.** Noting a candidate runs after the record is handled, in its own `try`: a failure is logged `inbox.candidate_failed` with the kind of error only (Task 9's `errorKind`, never its message: no numbers, no words) and the record is not retried for it, because a retry would handle the record a second time.
- **Move** uses `createOrMergeLead({ name, phone, waJid, waLid }, { channel: 'whatsapp', matchMethod: 'owner_added' })` as the brief says: no fan-out, no note, born answered (P2-5); the name is the client's WhatsApp name, when the candidate has one. Born answered even when the client wrote last (`last_dir = 'in'`), on purpose: `last_dir` follows only the messages with property words, so it cannot tell "asked and nobody answered" from "asked, and the owner answered without a property word"; and `lib/leads.mjs` already puts an `owner_added` lead back on the waiting queue at the client's next message (its `first_reply_ts` still equal to `created` is cleared). Open for the owner: should a moved chat whose client wrote last be on the waiting queue at once? Audit rows carry the candidate id as `target` (plus `{ lead_id }` for a move), never a number.

**Files:**
- Modify: `services/api/lib/db.mjs` (v4 gains `inbox_candidates`)
- Modify: `services/api/lib/inbox/store.mjs` (the candidate functions)
- Modify: `services/api/lib/inbox/eligibility.mjs` (`PROPERTY_WORD_RE`, `MAX_PROPERTY_WORDS`, `propertyWordsIn`)
- Modify: `services/api/lib/wa-poller.mjs` (`candidateWordsOf`, `TK_DOCUMENT_WORD`, `PROPERTY_DOCUMENT_WORD`, noting candidates, the `candidates` tally)
- Modify: `services/api/lib/dashboard/render-inbox.mjs` (the "Real-estate chats to check" section, `INBOX_OK.dismissed`)
- Modify: `services/api/lib/dashboard/render.mjs` (`MESSAGES.candidate_gone`, `MESSAGES.candidate_no_number`)
- Modify: `services/api/lib/dashboard/routes.mjs` (the Unsure tab and its count, move/dismiss, removal on a never-list or team add, *Add chat* and *Move* on a lead)
- Modify: `services/api/index.mjs` (the upkeep prunes candidates)
- Modify: `services/README.md`, `src/data/privacy.json`
- Test: `services/api/test/db.test.mjs`, `services/api/test/inbox-store.test.mjs`, `services/api/test/inbox-eligibility.test.mjs`, `services/api/test/wa-poller.test.mjs`, `services/api/test/dashboard-render-inbox.test.mjs`, `services/api/test/dashboard-inbox.test.mjs`, `services/api/test/inbox-wiring.test.mjs`, `scripts/test/privacy-policy.test.mjs`

Four commits, one per part (A the table, the property words and the store; B the poller; C the screens, routes and upkeep; D the privacy page and README). Each part runs the full suite before it commits.

#### Part A — the table, the property words and the store

- [ ] **Step 1: Write the failing tests**

In `services/api/test/db.test.mjs`, six edits.

Find:

```js
'never_list', 'settings', 'wa_messages', 'wa_outbox', 'inbox_reads', 'wa_gaps']) {
    assert.ok(tables.includes(name), name);
```

Replace with:

```js
'never_list', 'settings', 'wa_messages', 'wa_outbox', 'inbox_reads', 'wa_gaps', 'inbox_candidates']) {
    assert.ok(tables.includes(name), name);
```

Find:

```js
test('schema v4 gives leads their inbox columns and adds the transcript, outbox, read-mark and gap tables', () => {
```

Replace with:

```js
test('schema v4 gives leads their inbox columns and adds the transcript, outbox, read-mark, gap and candidate tables', () => {
```

Find:

```js
  assert.deepEqual(names('wa_gaps'), ['key_id', 'lead_id', 'jid', 'ts', 'reason']);
  const indexes = new Set(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
  for (const name of ['leads_inbox', 'wa_messages_lead', 'wa_outbox_key', 'wa_outbox_lead', 'wa_outbox_created', 'wa_gaps_lead']) assert.ok(indexes.has(name), name);
```

Replace with:

```js
  assert.deepEqual(names('wa_gaps'), ['key_id', 'lead_id', 'jid', 'ts', 'reason']);
  assert.deepEqual(names('inbox_candidates'), ['cand_id', 'jid', 'lid', 'phone_e164', 'name', 'first_ts', 'last_ts', 'hits', 'words', 'last_dir', 'state', 'updated']);
  assert.ok(!names('inbox_candidates').some((c) => /text|snippet|body/.test(c)), 'a candidate never holds what was written');
  const indexes = new Set(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
  for (const name of ['leads_inbox', 'wa_messages_lead', 'wa_outbox_key', 'wa_outbox_lead', 'wa_outbox_created', 'wa_gaps_lead', 'inbox_candidates_state']) assert.ok(indexes.has(name), name);
```

Find (the end of the v4 CHECKs test):

```js
  assert.throws(() => read.run('USR-1', 'L1', 7), /UNIQUE/, 'one read mark per person per chat');
  s.close();
});
```

Replace with:

```js
  assert.throws(() => read.run('USR-1', 'L1', 7), /UNIQUE/, 'one read mark per person per chat');

  const cand = s.db.prepare('INSERT INTO inbox_candidates (cand_id, jid, lid, phone_e164, first_ts, last_ts, last_dir, state, updated) VALUES (?,?,?,?,?,?,?,?,?)');
  cand.run('CND-1', '966500000001@s.whatsapp.net', null, '966500000001', 1, 1, 'in', 'open', 1);
  cand.run('CND-2', null, '111@lid', null, 1, 1, 'out', 'dismissed', 1);
  cand.run('CND-3', null, null, '966500000003', 1, 1, null, 'open', 1);
  cand.run('CND-4', null, null, null, 1, 1, null, 'open', 1);
  cand.run('CND-5', null, null, null, 1, 1, null, 'open', 1);
  assert.equal(s.db.prepare("SELECT hits FROM inbox_candidates WHERE cand_id = 'CND-1'").get().hits, 1, 'a new row is one message');
  assert.throws(() => cand.run('CND-6', null, null, '966500000001', 1, 1, 'in', 'open', 1), /UNIQUE/, 'one row per number');
  assert.throws(() => cand.run('CND-7', '966500000001@s.whatsapp.net', null, null, 1, 1, 'in', 'open', 1), /UNIQUE/, 'one row per jid');
  assert.throws(() => cand.run('CND-8', null, '111@lid', null, 1, 1, 'in', 'open', 1), /UNIQUE/, 'one row per lid');
  assert.throws(() => cand.run('CND-9', null, null, null, 1, 1, 'sideways', 'open', 1), /CHECK/);
  assert.throws(() => cand.run('CND-10', null, null, null, 1, 1, 'in', 'maybe', 1), /CHECK/);
  assert.throws(() => cand.run(null, null, null, null, 1, 1, 'in', 'open', 1), /NOT NULL/, 'a candidate always has its id');
  assert.throws(() => cand.run('CND-11', null, null, null, null, 1, 'in', 'open', 1), /NOT NULL/);
  assert.throws(() => cand.run('CND-12', null, null, null, 1, 1, 'in', 'open', null), /NOT NULL/);
  s.close();
});
```

Find (in the v3 → v4 test):

```js
  for (const table of ['wa_messages', 'wa_outbox', 'inbox_reads', 'wa_gaps']) assert.equal(countOf(a.db, table), 0, table);
```

Replace with:

```js
  for (const table of ['wa_messages', 'wa_outbox', 'inbox_reads', 'wa_gaps', 'inbox_candidates']) assert.equal(countOf(a.db, table), 0, table);
```

Find (in the part-way failure test):

```js
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'wa_messages'").get().n, 0, 'the CREATEs were rolled back');
```

Replace with:

```js
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'wa_messages'").get().n, 0, 'the CREATEs were rolled back');
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'inbox_candidates'").get().n, 0, 'the candidates table too');
```

In `services/api/test/inbox-eligibility.test.mjs` (as Task 15 left it), six edits.

Find:

```js
import {
  LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE, INBOX_STATES,
  inboundSignal, ownerOutboundJoins, isTkDocument, nextInboxState,
} from '../lib/inbox/eligibility.mjs';
```

Replace with:

```js
import {
  LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE, PROPERTY_WORD_RE, MAX_PROPERTY_WORDS, INBOX_STATES,
  inboundSignal, ownerOutboundJoins, isTkDocument, propertyWordsIn, nextInboxState,
} from '../lib/inbox/eligibility.mjs';
```

Find:

```js
  for (const re of [LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE]) {
    assert.ok(re instanceof RegExp);
```

Replace with:

```js
  for (const re of [LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE, PROPERTY_WORD_RE]) {
    assert.ok(re instanceof RegExp);
```

Find:

```js
  for (const re of [BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE]) assert.equal(re.unicode, true, `${re} needs /u`);
  for (const re of [PROPERTY_DOC_RE, TK_RE]) assert.equal(re.ignoreCase, true, `${re} ignores case`);
```

Replace with:

```js
  for (const re of [BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE, PROPERTY_WORD_RE]) assert.equal(re.unicode, true, `${re} needs /u`);
  for (const re of [PROPERTY_DOC_RE, TK_RE, PROPERTY_WORD_RE]) assert.equal(re.ignoreCase, true, `${re} ignores case`);
```

Find:

```js
/* ---------------- time ---------------- */
```

Replace with:

```js
/* ---------------- property words (D17) ---------------- */

test('property words come out as the forms the owner\'s list shows: each once, in order, at most eight', () => {
  assert.equal(MAX_PROPERTY_WORDS, 8);
  for (const [text, words] of [
    ['عندكم شقة للإيجار؟', ['شقة', 'إيجار']],
    ['the villa is 3M', ['villa']],
    ['Villas and apartments for rent, 300m², 4 bedrooms', ['villa', 'apartment', 'rent', 'sqm', 'bedroom']],
    ['Flat to let? Lease or rental, a plot of land, 2 properties', ['flat', 'lease', 'rent', 'plot', 'land', 'property']],
    ['Real-estate broker, commission 2.5%', ['real estate', 'broker', 'commission']],
    ['DUPLEX penthouse Town House compound listing 250 sqm', ['duplex', 'penthouse', 'townhouse', 'compound', 'listing', 'sqm']],
    ['الفيلا فله فلل فلة فيلا', ['فيلا']],
    ['شقه، الشقق', ['شقة']],
    ['ايجار الإيجار للايجار', ['إيجار']],
    ['أرض للبيع، ارض، الأراضي', ['أرض', 'للبيع']],
    ['عقار العقارات دوبلكس البنتهاوس', ['عقار', 'دوبلكس', 'بنتهاوس']],
    ['تاون هاوس في مجمع سكني', ['تاون هاوس', 'مجمع سكني']],
    ['غرفة غرف غرفه', ['غرفة']],
    ['الصك مع السمسار، العمولة ٢٫٥', ['صك', 'سمسار', 'عمولة']],
    ['مخطط الشاطئ', ['مخطط']],
    ['villa apartment flat rent lease land plot property duplex penthouse', ['villa', 'apartment', 'flat', 'rent', 'lease', 'land', 'plot', 'property']],
  ]) {
    assert.deepEqual(propertyWordsIn(text), words, text);
  }
});

test('words that only contain a property word, everyday Arabic and non-strings are no property words', () => {
  for (const text of ['Hello', 'villager', 'parent', 'current', 'island', 'landlord', 'flatter', 'rented a car', 'plotted',
    'commissioner', 'broken', 'propertyX', 'km²', 'طحت على الأرض', 'الغرفة باردة', 'والفيلا', 'بالإيجار', 'كوبونات', 'Bona', '']) {
    assert.deepEqual(propertyWordsIn(text), [], text);
    assert.equal(PROPERTY_WORD_RE.test(text), false, text);
  }
  for (const text of [null, undefined, 42, {}, ['villa']]) assert.deepEqual(propertyWordsIn(text), [], String(text));
  assert.equal(PROPERTY_WORD_RE.test('a villa'), true);
  assert.equal(PROPERTY_WORD_RE.lastIndex, 0, 'no /g: nothing is carried over');
});

/* ---------------- time ---------------- */
```

and in the timing test, find:

```js
    fill('t.k', n), fill('t.', n), fill('تى ', n), fill('تى', n), fill('تيكى', n),
  ];
```

Replace with:

```js
    fill('t.k', n), fill('t.', n), fill('تى ', n), fill('تى', n), fill('تيكى', n),
    fill('villa ', n), fill('villax', n), fill('real ', n), fill('town-', n), fill('rent', n), fill('الفي', n), fill('ال', n),
    fill('تاون ', n), fill('مجمع ', n), fill('شقة ', n),
  ];
```

Find:

```js
    ['TK_RE', (s) => TK_RE.test(s)],
  ];
```

Replace with:

```js
    ['TK_RE', (s) => TK_RE.test(s)],
    ['propertyWordsIn', (s) => propertyWordsIn(s)],
    ['PROPERTY_WORD_RE', (s) => PROPERTY_WORD_RE.test(s)],
  ];
```

In `services/api/test/inbox-store.test.mjs`, replace the import

```js
import {
  createInboxStore, RETENTION_MS, MAX_STORED_TEXT, SENDER_KINDS, OUTBOX_KINDS, OUTBOX_STATUSES,
} from '../lib/inbox/store.mjs';
```

with

```js
import {
  createInboxStore, RETENTION_MS, MAX_STORED_TEXT, SENDER_KINDS, OUTBOX_KINDS, OUTBOX_STATUSES, CANDIDATE_KEEP_MS, DISMISSED_KEEP_MS,
} from '../lib/inbox/store.mjs';
```

and append to the end of the file (after Task 11's `listedLeads` test):

```js

/* ---------------- real-estate chats to check (D17) ---------------- */

const PHONE = '966500000077';
const PJID = `${PHONE}@s.whatsapp.net`;
const LID = '272516946294519@lid';
const cand = (s, id) => ({ ...s.db.prepare('SELECT * FROM inbox_candidates WHERE cand_id = ?').get(id) });

test('a candidate is kept 30 days after its last property message, a dismissed one a year', () => {
  assert.equal(CANDIDATE_KEEP_MS, 30 * DAY);
  assert.equal(DISMISSED_KEEP_MS, 365 * DAY);
});

test('noteCandidate makes one row per chat: who, when, which words and who wrote last — never what was written', () => {
  const { s, inbox, at } = harness();
  const first = inbox.noteCandidate({ jid: PJID, phone: PHONE, name: '  Umm   Khalid ', ts: NOW - 5000, words: ['شقة', 'إيجار'], dir: 'in' });
  assert.equal(first.state, 'open');
  assert.equal(first.created, true);
  assert.match(first.cand_id, /^CND-[0-9a-z]+-[0-9a-f]{4}$/);
  assert.deepEqual(cand(s, first.cand_id), {
    cand_id: first.cand_id, jid: PJID, lid: null, phone_e164: PHONE, name: 'Umm Khalid',
    first_ts: NOW - 5000, last_ts: NOW - 5000, hits: 1, words: 'شقة,إيجار', last_dir: 'in', state: 'open', updated: NOW,
  });

  // The same chat again, now by its lid with the phone jid alongside: the same row.
  at(NOW + 1000);
  const again = inbox.noteCandidate({ jid: PJID, lid: LID, name: 'Someone Else', ts: NOW - 1000, words: ['villa', 'شقة'], dir: 'out' });
  assert.deepEqual(again, { state: 'open', cand_id: first.cand_id, created: false });
  assert.deepEqual(cand(s, first.cand_id), {
    cand_id: first.cand_id, jid: PJID, lid: LID, phone_e164: PHONE, name: 'Umm Khalid',
    first_ts: NOW - 5000, last_ts: NOW - 1000, hits: 2, words: 'شقة,إيجار,villa', last_dir: 'out', state: 'open', updated: NOW + 1000,
  }, 'a name it has is kept; the lid it lacked is filled');

  // An older message read late (the poll overlap) counts, but moves neither the last time nor the last writer.
  inbox.noteCandidate({ lid: LID, ts: NOW - 9000, words: [], dir: 'in' });
  const row = cand(s, first.cand_id);
  assert.deepEqual([row.first_ts, row.last_ts, row.last_dir, row.hits], [NOW - 9000, NOW - 1000, 'out', 3]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox_candidates').get().n, 1);
  s.close();
});

test('noteCandidate keeps at most eight words, each once, no commas, strings only', () => {
  const { s, inbox } = harness();
  const { cand_id } = inbox.noteCandidate({ phone: PHONE, ts: NOW, words: ['villa', 'villa', 'a,b', 42, null, '  ', 'flat'], dir: 'in' });
  assert.equal(cand(s, cand_id).words, 'villa,a b,flat');
  inbox.noteCandidate({ phone: PHONE, ts: NOW, words: ['land', 'plot', 'rent', 'lease', 'sqm', 'broker', 'duplex'], dir: 'in' });
  assert.equal(cand(s, cand_id).words, 'villa,a b,flat,land,plot,rent,lease,sqm', 'the first eight, in order');
  assert.deepEqual(inbox.getCandidate(cand_id).words, ['villa', 'a b', 'flat', 'land', 'plot', 'rent', 'lease', 'sqm']);
  const none = inbox.noteCandidate({ jid: 'x@s.whatsapp.net', ts: NOW, dir: 'out' });
  assert.equal(cand(s, none.cand_id).words, null);
  assert.deepEqual(inbox.getCandidate(none.cand_id).words, []);
  s.close();
});

test('noteCandidate never fills an id another row already holds, and refuses a chat with no id, no time or no direction', () => {
  const { s, inbox } = harness();
  const byLid = inbox.noteCandidate({ lid: LID, ts: NOW, words: ['villa'], dir: 'in' });
  const byPhone = inbox.noteCandidate({ phone: PHONE, ts: NOW, words: ['flat'], dir: 'in' });
  // A record that shows both: found by its number first, and the lid stays with its own row.
  assert.equal(inbox.noteCandidate({ phone: PHONE, lid: LID, ts: NOW + 1, words: [], dir: 'in' }).cand_id, byPhone.cand_id);
  assert.equal(cand(s, byPhone.cand_id).lid, null);
  assert.equal(cand(s, byLid.cand_id).lid, LID);
  assert.throws(() => inbox.noteCandidate({ ts: NOW, dir: 'in' }), RangeError);
  assert.throws(() => inbox.noteCandidate({ phone: '  ', jid: '', ts: NOW, dir: 'in' }), RangeError);
  assert.throws(() => inbox.noteCandidate({ phone: PHONE, ts: 'soon', dir: 'in' }), RangeError);
  assert.throws(() => inbox.noteCandidate({ phone: PHONE, ts: NOW, dir: 'sideways' }), RangeError);
  assert.throws(() => inbox.noteCandidate(), RangeError);
  s.close();
});

test('a dismissed candidate stays dismissed: a later message neither reopens nor counts it, and only its ids are left', () => {
  const { s, inbox, at } = harness();
  const { cand_id } = inbox.noteCandidate({ jid: PJID, phone: PHONE, name: 'Umm Khalid', ts: NOW - 9000, words: ['villa'], dir: 'in' });
  inbox.noteCandidate({ phone: PHONE, ts: NOW - 1000, words: ['شقة'], dir: 'out' });
  at(NOW + 5000);
  assert.equal(inbox.dismissCandidate(cand_id), true);
  assert.equal(inbox.dismissCandidate(cand_id), false, 'once');
  assert.equal(inbox.dismissCandidate('CND-nope'), false);
  const row = cand(s, cand_id);
  assert.deepEqual(row, {
    cand_id, jid: PJID, lid: null, phone_e164: PHONE, name: null,
    first_ts: NOW + 5000, last_ts: NOW + 5000, hits: 0, words: null, last_dir: null, state: 'dismissed', updated: NOW + 5000,
  }, 'no name, words, count, last writer or message times: only the ids and when it was dismissed');
  at(NOW + 9000);
  assert.deepEqual(inbox.noteCandidate({ phone: PHONE, name: 'Umm Khalid', ts: NOW + 8000, words: ['شقة'], dir: 'in' }), { state: 'dismissed', cand_id, created: false });
  assert.deepEqual(cand(s, cand_id), row, 'not touched at all');
  assert.equal(inbox.countCandidates(), 0);
  assert.deepEqual(inbox.listCandidates(), []);
  s.close();
});

test('listCandidates and countCandidates: open rows only, the latest message first', () => {
  const { s, inbox } = harness();
  const a = inbox.noteCandidate({ phone: '966500000001', ts: NOW - 3000, words: ['villa'], dir: 'in' });
  const b = inbox.noteCandidate({ phone: '966500000002', ts: NOW - 1000, words: ['flat'], dir: 'out' });
  const c = inbox.noteCandidate({ phone: '966500000003', ts: NOW - 2000, words: ['land'], dir: 'in' });
  const d = inbox.noteCandidate({ phone: '966500000004', ts: NOW, words: ['plot'], dir: 'in' });
  inbox.dismissCandidate(d.cand_id);
  assert.deepEqual(inbox.listCandidates().map((r) => r.cand_id), [b.cand_id, c.cand_id, a.cand_id]);
  assert.deepEqual(inbox.listCandidates({ limit: 1 }).map((r) => r.cand_id), [b.cand_id]);
  assert.equal(inbox.countCandidates(), 3);
  assert.deepEqual(inbox.listCandidates()[0].words, ['flat']);
  assert.equal(inbox.getCandidate('CND-nope'), null);
  s.close();
});

test('listCandidates and countCandidates leave out a chat that has become a lead since, by its number, jid or lid', () => {
  const { s, inbox } = harness();
  const byPhone = inbox.noteCandidate({ phone: '966500000001', ts: NOW - 1000, words: ['villa'], dir: 'in' });
  const byJid = inbox.noteCandidate({ phone: '966500000002', jid: '966500000002@s.whatsapp.net', ts: NOW - 2000, words: ['villa'], dir: 'in' });
  const byLid = inbox.noteCandidate({ phone: '966500000003', lid: LID, ts: NOW - 3000, words: ['villa'], dir: 'in' });
  const stays = inbox.noteCandidate({ phone: '966500000004', ts: NOW - 4000, words: ['villa'], dir: 'in' });
  assert.equal(inbox.countCandidates(), 4);
  lead(s, 'LEAD-p', { phone_e164: '966500000001' });
  lead(s, 'LEAD-j', { wa_jid: '966500000002@s.whatsapp.net' });
  lead(s, 'LEAD-l', { wa_lid: LID });
  assert.deepEqual(inbox.listCandidates().map((r) => r.cand_id), [stays.cand_id]);
  assert.equal(inbox.countCandidates(), 1, 'the count is the list');
  // Still there to be read and removed: the lead decides, the row waits for the poller or the prune.
  for (const c of [byPhone, byJid, byLid]) assert.equal(inbox.getCandidate(c.cand_id).state, 'open');
  s.close();
});

test('removeCandidate and removeCandidatesFor: one row, or every row of a chat by any of its ids, open or dismissed', () => {
  const { s, inbox } = harness();
  const byPhone = inbox.noteCandidate({ phone: PHONE, ts: NOW, words: ['villa'], dir: 'in' });
  const byLid = inbox.noteCandidate({ lid: LID, ts: NOW, words: ['villa'], dir: 'in' });
  const other = inbox.noteCandidate({ phone: '966500000001', jid: '966500000001@s.whatsapp.net', ts: NOW, words: ['flat'], dir: 'in' });
  inbox.dismissCandidate(byLid.cand_id);
  assert.equal(inbox.removeCandidatesFor({ phone: PHONE, jid: PJID, lid: LID }), 2);
  assert.equal(inbox.getCandidate(byPhone.cand_id), null);
  assert.equal(inbox.getCandidate(byLid.cand_id), null);
  assert.ok(inbox.getCandidate(other.cand_id), 'another chat stays');
  assert.equal(inbox.removeCandidatesFor({}), 0, 'no id, nothing removed');
  assert.equal(inbox.removeCandidatesFor({ phone: null, jid: '', lid: undefined }), 0);
  assert.equal(inbox.removeCandidatesFor({ jid: '966500000001@s.whatsapp.net' }), 1);
  const last = inbox.noteCandidate({ phone: PHONE, ts: NOW, words: [], dir: 'in' });
  assert.equal(inbox.removeCandidate(last.cand_id), true);
  assert.equal(inbox.removeCandidate(last.cand_id), false);
  s.close();
});

test('pruneCandidates: open rows by their last message, dismissed rows by when they were dismissed; a cutoff is not older than itself', () => {
  const { s, inbox, at } = harness();
  const openOld = inbox.noteCandidate({ phone: '966500000001', ts: NOW - 31 * DAY, words: ['villa'], dir: 'in' });
  const openEdge = inbox.noteCandidate({ phone: '966500000002', ts: NOW - 30 * DAY, words: ['villa'], dir: 'in' });
  const openNew = inbox.noteCandidate({ phone: '966500000003', ts: NOW - DAY, words: ['villa'], dir: 'in' });
  const gone = inbox.noteCandidate({ phone: '966500000004', ts: NOW - 400 * DAY, words: ['villa'], dir: 'in' });
  const kept = inbox.noteCandidate({ phone: '966500000005', ts: NOW - 400 * DAY, words: ['villa'], dir: 'in' });
  at(NOW - 366 * DAY);
  inbox.dismissCandidate(gone.cand_id);
  at(NOW - 365 * DAY);
  inbox.dismissCandidate(kept.cand_id);
  at(NOW);
  assert.deepEqual(inbox.pruneCandidates({ openBefore: NOW - 30 * DAY, dismissedBefore: NOW - 365 * DAY }), { open: 1, dismissed: 1 });
  assert.equal(inbox.getCandidate(openOld.cand_id), null);
  assert.ok(inbox.getCandidate(openEdge.cand_id), 'exactly 30 days is not older than the cutoff');
  assert.ok(inbox.getCandidate(openNew.cand_id));
  assert.equal(inbox.getCandidate(gone.cand_id), null);
  assert.ok(inbox.getCandidate(kept.cand_id), 'dismissed exactly a year ago stays, so it is still not listed again');
  assert.deepEqual(inbox.pruneCandidates({ openBefore: 'x', dismissedBefore: null }), { open: 0, dismissed: 0 }, 'garbage deletes nothing');
  assert.deepEqual(inbox.pruneCandidates(), { open: 0, dismissed: 0 });
  s.close();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/db.test.mjs api/test/inbox-eligibility.test.mjs api/test/inbox-store.test.mjs`
Expected: FAIL — `inbox-eligibility.test.mjs` does not load (`SyntaxError: The requested module '../lib/inbox/eligibility.mjs' does not provide an export named 'MAX_PROPERTY_WORDS'` — Node names one of the three new imports), nor does `inbox-store.test.mjs` (`… '../lib/inbox/store.mjs' does not provide an export named 'CANDIDATE_KEEP_MS'`); in `db.test.mjs` four tests fail, because there is no `inbox_candidates` table ("openDb creates …", "schema v4 gives leads …", "the v4 CHECKs refuse …" with `no such table: inbox_candidates`, "a v3 file db moves to v4 …"); the part-way failure test passes (the table is absent either way).

- [ ] **Step 3: The table** — two edits in `services/api/lib/db.mjs`.

Find:

```js
    // Team and never-list numbers are not excluded here; app.inboxMaintenance() moves them
    // out on start (P2-20). No foreign keys, as in v3. Migrations here only ever add.
    version: 4,
```

Replace with:

```js
    // Team and never-list numbers are not excluded here; app.inboxMaintenance() moves them
    // out on start (P2-20).
    // `inbox_candidates` (added to v4 on 2026-09-28 in a later commit than the rest of v4,
    // before v4 ever shipped: no file anywhere is at v4 without it) is the owner's list of
    // real-estate chats to check (D17): a chat that used property words, in either
    // direction, but gave no sure sign it is about Bona. It is not a lead and holds no
    // message text: only who (number, jid, lid, the name WhatsApp shows for them), when
    // (first and last message, how many), which property words (`words`, comma-joined, at
    // most 8) and who wrote last. `dismissed` is the owner's "Not a client": the row stays,
    // emptied of everything but its ids, only so the chat is not listed again. One row per
    // number, jid and lid (UNIQUE; NULLs do not collide). No foreign keys, as in v3.
    // Migrations here only ever add.
    version: 4,
```

Find:

```js
      CREATE INDEX IF NOT EXISTS wa_gaps_lead ON wa_gaps(lead_id, ts);
      UPDATE leads SET
```

Replace with:

```js
      CREATE INDEX IF NOT EXISTS wa_gaps_lead ON wa_gaps(lead_id, ts);
      CREATE TABLE IF NOT EXISTS inbox_candidates (
        cand_id TEXT NOT NULL PRIMARY KEY, jid TEXT UNIQUE, lid TEXT UNIQUE, phone_e164 TEXT UNIQUE, name TEXT,
        first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 1, words TEXT,
        last_dir TEXT CHECK (last_dir IN ('in','out')),
        state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','dismissed')), updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_candidates_state ON inbox_candidates(state, last_ts);
      UPDATE leads SET
```

(`CREATE … IF NOT EXISTS` like the rest of v4. A development file already opened at v4 before this commit would lack the table; none exists outside the tests' temporary files, and the live db is still v3.)

- [ ] **Step 4: The words** — in `services/api/lib/inbox/eligibility.mjs` (as Task 15 left it), find the cut-name margin:

```js
/**
 * Code points left out at the end of a document name that was cut (`fileNameTruncated`):
 * nothing close to the cut is read.
 */
const CUT_MARGIN = 16;
```

Replace with:

```js
/**
 * Words that say a chat is about property, each with the one form the owner's list shows
 * (D17). English and Arabic, bounded like `BONA_WORD_RE` by anything that is not a letter or
 * a mark (`3villas` and `villa2` count, `villager` does not). Arabic words written with ه
 * for ة (فله, شقه) count too, as people type them, and most Arabic nouns also with the
 * article (الفيلا, العقار); أرض and غرفة do not, because with it they are everyday words (the
 * ground, the room). A clitic before a word (والفيلا, بالإيجار) is missed: that only means
 * the owner does not see that chat on his list, never that anything joins.
 *
 * A match only ever puts a chat on the owner's list of chats to check; it never joins one.
 * Every alternative starts with a fixed word and repeats nothing: linear in the text.
 */
const PROPERTY_WORDS = [
  ['villa', 'villas?'],
  ['apartment', 'apartments?'],
  ['flat', 'flats?'],
  ['rent', 'rent(?:al)?s?'],
  ['lease', 'leases?'],
  ['land', 'lands?'],
  ['plot', 'plots?'],
  ['property', 'propert(?:y|ies)'],
  ['real estate', String.raw`real[\s_-]?estate`],
  ['duplex', 'duplex(?:es)?'],
  ['penthouse', 'penthouses?'],
  ['townhouse', String.raw`town[\s_-]?houses?`],
  ['compound', 'compounds?'],
  ['bedroom', 'bedrooms?'],
  ['sqm', 'sqm|m²'],
  ['listing', 'listings?'],
  ['broker', 'brokers?'],
  ['commission', 'commissions?'],
  ['فيلا', '(?:ال)?(?:فيلا|فلل|فلة|فله)'],
  ['شقة', '(?:ال)?(?:شقة|شقه|شقق)'],
  ['إيجار', '(?:ال|لل)?[إا]يجار'],
  ['للبيع', 'للبيع'],
  ['أرض', '[أا]رض|(?:ال)?[أا]راضي'],
  ['عقار', '(?:ال)?عقارات?'],
  ['دوبلكس', '(?:ال)?دوبلكس'],
  ['بنتهاوس', '(?:ال)?بنتهاوس'],
  ['تاون هاوس', String.raw`تاون[\s_-]?هاوس`],
  ['مجمع سكني', String.raw`مجمع[\s_-]?سكني`],
  ['غرفة', 'غرفة|غرفه|غرف'],
  ['صك', '(?:ال)?صك'],
  ['سمسار', '(?:ال)?سمسار'],
  ['عمولة', '(?:ال)?(?:عمولة|عموله)'],
  ['مخطط', '(?:ال)?مخطط'],
];
const WORDS_SOURCE = String.raw`(?<![\p{L}\p{M}])(?:${PROPERTY_WORDS.map(([, src]) => `(${src})`).join('|')})(?![\p{L}\p{M}])`;
/**
 * Any property word (one capture group per word, in `PROPERTY_WORDS` order). No `g`, like
 * every pattern here, so `.test()` never carries a position over; `propertyWordsIn` scans
 * with its own global copy.
 */
export const PROPERTY_WORD_RE = new RegExp(WORDS_SOURCE, 'iu');
const PROPERTY_WORDS_ALL = new RegExp(WORDS_SOURCE, 'giu');
/** At most this many words are kept for one chat. */
export const MAX_PROPERTY_WORDS = 8;

/**
 * The property words a text uses, as the forms the owner's list shows (`villa`, `شقة`,
 * `إيجار` …): lower case, each once, in the order they first appear, at most
 * `MAX_PROPERTY_WORDS`. Never the text itself. Anything that is not a string has none.
 * @param {unknown} text
 * @returns {string[]}
 */
export function propertyWordsIn(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  for (const m of text.matchAll(PROPERTY_WORDS_ALL)) {
    const word = PROPERTY_WORDS[m.findIndex((g, i) => i > 0 && g !== undefined) - 1][0];
    if (!out.includes(word)) out.push(word);
    if (out.length === MAX_PROPERTY_WORDS) break;
  }
  return out;
}

/**
 * Code points left out at the end of a document name that was cut (`fileNameTruncated`):
 * nothing close to the cut is read.
 */
const CUT_MARGIN = 16;
```

- [ ] **Step 5: The store** — five edits in `services/api/lib/inbox/store.mjs`.

Find:

```js
 * Only this file writes SQL for `wa_messages`, `wa_outbox`, `inbox_reads` and `wa_gaps`.
```

Replace with:

```js
 * Only this file writes SQL for `wa_messages`, `wa_outbox`, `inbox_reads`, `wa_gaps` and
 * `inbox_candidates` (the owner's list of real-estate chats to check, D17).
```

Find:

```js
import { INBOX_STATES } from './eligibility.mjs';
```

Replace with:

```js
import { newId } from '../db.mjs';
import { INBOX_STATES, MAX_PROPERTY_WORDS } from './eligibility.mjs';
```

Find:

```js
/** The day cap's window (lib/wa-send.mjs): a send younger than this still counts against it. */
const SEND_DAY_MS = 86_400_000;
```

Replace with:

```js
/** The day cap's window (lib/wa-send.mjs): a send younger than this still counts against it. */
const SEND_DAY_MS = 86_400_000;
/**
 * A real-estate chat to check (D17) is kept this long after its last property message, and
 * a dismissed one (the owner's "Not a client") this long after he dismissed it, only so it
 * is not listed again. The privacy page states both.
 */
export const CANDIDATE_KEEP_MS = 30 * 86_400_000;
export const DISMISSED_KEEP_MS = 365 * 86_400_000;
/** Longest name kept for a candidate, in code points: what WhatsApp shows, never more. */
const MAX_CANDIDATE_NAME = 100;
```

Find:

```js
  return {
    upsertMessage, messagesFor, newestTs, hasMessages, messageByKey,
```

Replace with:

```js
  /* -------------------- real-estate chats to check (D17) -------------------- */
  //
  // A chat that used property words (lib/inbox/eligibility.mjs `propertyWordsIn`) but gave
  // no sure sign it is about Bona: not a lead, never shown to staff, and never its words —
  // only who, when, how often, which property words and who wrote last.

  const idOf = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const nameOf = (v) => {
    if (typeof v !== 'string') return null;
    return Array.from(v.replace(/\s+/g, ' ').trim()).slice(0, MAX_CANDIDATE_NAME).join('') || null;
  };
  /** Strings only, no commas (the column is comma-joined), each once, at most `MAX_PROPERTY_WORDS`. */
  function wordsOf(list) {
    const out = [];
    for (const w of Array.isArray(list) ? list : []) {
      const v = typeof w === 'string' ? w.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      if (v && !out.includes(v)) out.push(v);
      if (out.length === MAX_PROPERTY_WORDS) break;
    }
    return out;
  }
  const splitWords = (v) => (typeof v === 'string' && v ? v.split(',') : []);
  const candidateRow = (row) => (row ? { ...row, words: splitWords(row.words) } : null);

  /** One chat's row: by number first, then jid, then lid. */
  function findCandidate({ phone, jid, lid }) {
    return (phone ? prep('SELECT * FROM inbox_candidates WHERE phone_e164 = ?').get(phone) : null)
      ?? (jid ? prep('SELECT * FROM inbox_candidates WHERE jid = ?').get(jid) : null)
      ?? (lid ? prep('SELECT * FROM inbox_candidates WHERE lid = ?').get(lid) : null)
      ?? null;
  }

  /**
   * One more property message from a chat that is not a lead. A new chat gets a row; an
   * open row counts it (`hits`), moves `last_ts` forward, adds the words (at most 8), fills
   * a number, jid, lid or name it did not have yet (never one another row holds: each is
   * UNIQUE) and says who wrote last. A dismissed row is left exactly as it is: the owner
   * said "Not a client", and a later message does not ask him again.
   *
   * @returns {{ state: 'open'|'dismissed', cand_id: string, created: boolean }}
   */
  function noteCandidate({ jid = null, lid = null, phone = null, name = null, ts, words = [], dir } = {}) {
    const ids = { phone: idOf(phone), jid: idOf(jid), lid: idOf(lid) };
    if (!ids.phone && !ids.jid && !ids.lid) throw new RangeError('a candidate needs a phone, jid or lid');
    if (!hasNumber(ts)) throw new RangeError('ts is required');
    if (!DIRECTIONS.includes(dir)) throw new RangeError(`unknown direction ${dir}`);
    const at = toTs(ts);
    const said = wordsOf(words);
    const who = nameOf(name);
    return transaction(() => {
      const found = findCandidate(ids);
      if (found?.state === 'dismissed') return { state: 'dismissed', cand_id: found.cand_id, created: false };
      if (found) {
        const free = (col, v) => (found[col] || !v || prep(`SELECT 1 FROM inbox_candidates WHERE ${col} = ?`).get(v) ? found[col] : v);
        const all = wordsOf([...splitWords(found.words), ...said]);
        prep(`UPDATE inbox_candidates SET phone_e164 = ?, jid = ?, lid = ?, name = COALESCE(name, ?),
                first_ts = MIN(first_ts, ?), last_dir = CASE WHEN ? >= last_ts THEN ? ELSE last_dir END,
                last_ts = MAX(last_ts, ?), hits = hits + 1, words = ?, updated = ?
              WHERE cand_id = ?`)
          .run(free('phone_e164', ids.phone), free('jid', ids.jid), free('lid', ids.lid), who,
            at, at, dir, at, all.join(',') || null, now(), found.cand_id);
        return { state: 'open', cand_id: found.cand_id, created: false };
      }
      const candId = newId('CND');
      prep(`INSERT INTO inbox_candidates (cand_id, jid, lid, phone_e164, name, first_ts, last_ts, hits, words, last_dir, state, updated)
            VALUES (?,?,?,?,?,?,?,1,?,?,'open',?)`)
        .run(candId, ids.jid, ids.lid, ids.phone, who, at, at, said.join(',') || null, dir, now());
      return { state: 'open', cand_id: candId, created: true };
    });
  }

  /**
   * Open rows whose chat is not a lead by now: no lead holds the candidate's number, jid or
   * lid (a web form or *Add chat* may have made one since it was noted, and that lead's own
   * inbox state decides the chat). In SQL, so a hidden row never takes a listed one's place.
   */
  const OPEN_NOT_A_LEAD = `c.state = 'open' AND NOT EXISTS (
      SELECT 1 FROM leads l WHERE l.phone_e164 = c.phone_e164 OR l.wa_jid IN (c.jid, c.lid) OR l.wa_lid IN (c.jid, c.lid))`;

  /** The owner's list: open rows of chats that are not leads, the latest message first. `words` comes back as an array. */
  function listCandidates({ limit = 200 } = {}) {
    return prep(`SELECT c.* FROM inbox_candidates c WHERE ${OPEN_NOT_A_LEAD} ORDER BY c.last_ts DESC, c.rowid DESC LIMIT ?`)
      .all(clampLimit(limit, 200)).map(candidateRow);
  }

  /** How many rows `listCandidates` would list with no limit. */
  const countCandidates = () => prep(`SELECT COUNT(*) AS n FROM inbox_candidates c WHERE ${OPEN_NOT_A_LEAD}`).get().n;
  const getCandidate = (candId) => candidateRow(prep('SELECT * FROM inbox_candidates WHERE cand_id = ?').get(String(candId ?? '')));

  /**
   * *Not a client*: the row stays only so the chat is not listed again, so everything but
   * its ids goes now — the name, the words, the count, who wrote last, and the times (both
   * become the moment of the dismissal). An unknown or already dismissed id is `false`.
   */
  function dismissCandidate(candId) {
    const t = now();
    return prep(`UPDATE inbox_candidates SET state = 'dismissed', name = NULL, words = NULL, hits = 0, last_dir = NULL,
                   first_ts = ?, last_ts = ?, updated = ?
                 WHERE cand_id = ? AND state = 'open'`).run(t, t, t, String(candId ?? '')).changes === 1;
  }

  const removeCandidate = (candId) => prep('DELETE FROM inbox_candidates WHERE cand_id = ?').run(String(candId ?? '')).changes === 1;

  /**
   * Every row of one chat, open or dismissed, by any of its ids: the chat became a lead (its
   * own inbox state rules from now on), or its number went on the never list. Returns how
   * many rows went.
   */
  function removeCandidatesFor({ phone = null, jid = null, lid = null } = {}) {
    const ids = [idOf(phone), idOf(jid), idOf(lid)];
    if (!ids.some(Boolean)) return 0;
    return prep('DELETE FROM inbox_candidates WHERE phone_e164 = ? OR jid = ? OR lid = ?').run(...ids).changes;
  }

  /**
   * Open rows whose last property message is older than `openBefore`, and dismissed rows
   * dismissed before `dismissedBefore`. Exactly at a cutoff is not older than it; a cutoff
   * that is not a number deletes nothing.
   *
   * @returns {{ open: number, dismissed: number }}
   */
  function pruneCandidates({ openBefore, dismissedBefore } = {}) {
    return transaction(() => ({
      open: prep("DELETE FROM inbox_candidates WHERE state = 'open' AND last_ts < ?").run(num(openBefore)).changes,
      dismissed: prep("DELETE FROM inbox_candidates WHERE state = 'dismissed' AND updated < ?").run(num(dismissedBefore)).changes,
    }));
  }

  return {
    upsertMessage, messagesFor, newestTs, hasMessages, messageByKey,
```

Find:

```js
    purgeLead, leaveInbox, retentionPurge,
  };
}
```

Replace with:

```js
    purgeLead, leaveInbox, retentionPurge,
    noteCandidate, listCandidates, countCandidates, getCandidate, dismissCandidate, removeCandidate, removeCandidatesFor, pruneCandidates,
  };
}
```

(`db.mjs` imports only `lib/store.mjs`, never the inbox store, so the new `newId` import makes no cycle.)

- [ ] **Step 6: Run**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/db.test.mjs api/test/inbox-eligibility.test.mjs api/test/inbox-store.test.mjs`
Expected: PASS, 0 fail (`inbox-eligibility`: 2 more tests; `inbox-store`: 9 more; the slowest new timing case measured 6 ms at 200,000 characters).

- [ ] **Step 7: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail — 11 more tests than after Task 15 (905 → 916 on the copy).

- [ ] **Step 8: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/db.mjs services/api/lib/inbox/eligibility.mjs services/api/lib/inbox/store.mjs services/api/test/db.test.mjs services/api/test/inbox-eligibility.test.mjs services/api/test/inbox-store.test.mjs
git commit -m "inbox: v4 also keeps the owner's list of real-estate chats to check (D17)

Added to the v4 migration before v4 ships: one row per chat that used
property words with no sure sign it is about Bona. Never the text: the ids,
the client's WhatsApp name, the property words (propertyWordsIn, English and
Arabic, as the forms the list shows), first and last time, how many, who
wrote last. A dismissed row keeps only its ids, so the chat is not listed
again.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Part B — the poller

- [ ] **Step 9: Write the failing tests**

In `services/api/test/wa-poller.test.mjs`, find the import (as Task 9 left it):

```js
import {
  CLICK_WINDOW_MS, FIRST_RUN_LOOKBACK_MS, MAX_RECORD_ATTEMPTS, MAX_WINDOW_MS, OVERLAP_MS,
  SEEN_TTL_MS, adMetaOf, adSourceOf, createPoller, isIgnorableChat, jidsOf,
} from '../lib/wa-poller.mjs';
```

Replace with:

```js
import {
  CLICK_WINDOW_MS, FIRST_RUN_LOOKBACK_MS, MAX_RECORD_ATTEMPTS, MAX_WINDOW_MS, OVERLAP_MS,
  SEEN_TTL_MS, PROPERTY_DOCUMENT_WORD, TK_DOCUMENT_WORD, adMetaOf, adSourceOf, candidateWordsOf, createPoller, isIgnorableChat, jidsOf,
} from '../lib/wa-poller.mjs';
```

and append to the end of the file (after Task 15's D16 test):

```js

/* ---------------- (u) real-estate chats to check (D17) ---------------- */

/** Every candidate row, as stored. */
const candidates = (h) => h.db.db.prepare('SELECT * FROM inbox_candidates ORDER BY rowid').all().map((r) => ({ ...r }));

test('(u) candidateWordsOf: property words from the text and a document\'s name, "property document" for a document word, "tk document" for a TK document the owner sent', () => {
  assert.equal(TK_DOCUMENT_WORD, 'tk document');
  assert.equal(PROPERTY_DOCUMENT_WORD, 'property document');
  assert.deepEqual(candidateWordsOf(msg({ text: 'عندكم شقة للإيجار؟' })), ['شقة', 'إيجار']);
  assert.deepEqual(candidateWordsOf(msg({ text: 'see the plan', media: '[document: Villa 12 photos.pdf]', fileName: 'Villa 12 photos.pdf' })), ['villa']);
  assert.deepEqual(candidateWordsOf(msg({ text: 'villa', media: '[image]', fileName: 'Flat.pdf' })), ['villa'], 'only a document has a file name');
  // A document word, in either direction, in the text or a document's name (D16's words).
  assert.deepEqual(candidateWordsOf(msg({ text: 'Can I get the price list and payment plan?' })), [PROPERTY_DOCUMENT_WORD]);
  assert.deepEqual(candidateWordsOf(msg({ text: 'ابغى البروشور وقائمة الأسعار' })), [PROPERTY_DOCUMENT_WORD]);
  assert.deepEqual(candidateWordsOf(msg({ fromMe: true, text: '', media: '[document: Bona Traffic HD brochure.pdf]', fileName: 'Bona Traffic HD brochure.pdf' })), [PROPERTY_DOCUMENT_WORD]);
  assert.deepEqual(candidateWordsOf(msg({ text: 'price list', media: '[image]', fileName: 'x' })), [PROPERTY_DOCUMENT_WORD], 'a caption counts');
  const tkDoc = { fromMe: true, text: '', media: '[document: TK Brochure Villa.pdf]', fileName: 'TK Brochure Villa.pdf', fileNameTruncated: false, fileNameTk: true };
  assert.deepEqual(candidateWordsOf(msg(tkDoc)), [TK_DOCUMENT_WORD, PROPERTY_DOCUMENT_WORD, 'villa']);
  assert.deepEqual(candidateWordsOf(msg({ ...tkDoc, fromMe: false })), [PROPERTY_DOCUMENT_WORD, 'villa'], 'a client\'s file that says TK is only its words');
  assert.deepEqual(candidateWordsOf(msg({ ...tkDoc, fileName: 'TK Villa 12.pdf', media: '[document: TK Villa 12.pdf]' })), [TK_DOCUMENT_WORD, 'villa']);
  assert.deepEqual(candidateWordsOf(msg({ ...tkDoc, fileName: 'TK invoice.pdf', media: '[document: TK invoice.pdf]' })), [TK_DOCUMENT_WORD]);
  assert.deepEqual(candidateWordsOf(msg({ ...tkDoc, text: 'villa apartment flat rent lease land plot property duplex' })),
    [TK_DOCUMENT_WORD, PROPERTY_DOCUMENT_WORD, 'villa', 'apartment', 'flat', 'rent', 'lease', 'land'], 'the markers first, then at most eight in all');
  assert.deepEqual(candidateWordsOf(msg({ text: 'see you at 6' })), []);
  assert.deepEqual(candidateWordsOf(null), []);
});

test('(u) a stranger asking about property goes on the owner\'s list: no lead, no note, no text, no history', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'Q1', jid: STRANGER, pushName: 'Umm Khalid', ts: NOW - 60_000, text: 'عندكم شقة للإيجار؟' }),
    msg({ id: 'Q2', jid: STRANGER2, pushName: null, ts: NOW - 30_000, text: '', messageType: 'documentMessage', media: '[document: Villa 12 photos.pdf]', fileName: 'Villa 12 photos.pdf' }),
    msg({ id: 'P1', jid: '966544444444@s.whatsapp.net', ts: NOW - 20_000, text: 'see you at 6' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 0, 'nothing sure: not a lead');
  assert.equal(h.sent.length, 0, 'the owner is not sent a note');
  assert.equal(h.findCalls.length, 0, 'no history is read');
  assert.equal(tally.unmatched, 3);
  assert.equal(tally.candidates, 2);
  const rows = candidates(h);
  assert.deepEqual(rows.map((r) => [r.phone_e164, r.jid, r.name, r.words, r.last_dir, r.hits, r.first_ts, r.state]), [
    ['966522222222', STRANGER, 'Umm Khalid', 'شقة,إيجار', 'in', 1, NOW - 60_000, 'open'],
    ['966533333333', STRANGER2, null, 'villa', 'in', 1, NOW - 30_000, 'open'],
  ]);
  assert.ok(!JSON.stringify(rows).includes('عندكم'), 'never the text');
  assert.equal(h.db.db.prepare('SELECT COUNT(*) AS n FROM wa_messages').get().n, 0);
  h.cleanup();
});

test('(u) the owner writing about property to a stranger puts that chat on the list too — as "you wrote", never with his own name', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'O1', fromMe: true, jid: STRANGER, pushName: 'Abdulaziz', ts: NOW - 60_000, text: 'the villa is 3M' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 0);
  assert.equal(tally.candidates, 1);
  const [row] = candidates(h);
  assert.deepEqual([row.phone_e164, row.name, row.words, row.last_dir], ['966522222222', null, 'villa', 'out']);
  h.cleanup();
});

test('(u) a TK document the owner sends is a chat to check, never a join', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'TK1', fromMe: true, jid: STRANGER, pushName: 'Abdulaziz', ts: NOW - 60_000, text: '', messageType: 'documentMessage',
      media: '[document: TK Brochure Villa.pdf]', fileName: 'TK Brochure Villa.pdf', fileNameTruncated: false, fileNameTk: true }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 0, 'TK chats stay out of the Bona inbox');
  assert.equal(tally.joined, 0);
  assert.equal(h.findCalls.length, 0);
  const [row] = candidates(h);
  assert.deepEqual([row.phone_e164, row.name, row.words, row.last_dir], ['966522222222', null, 'tk document,property document,villa', 'out']);
  h.cleanup();
});

test('(u) a property document the owner sends that does not join is a chat to check: a cut name, or one that names Bona', async () => {
  // "…(111 x) Brochure.pdf" cut at 120 code points: the word is in the part a cut name is not
  // read by (Task 15), so it cannot join; the owner's list is where he sees it.
  const cutName = `${'x'.repeat(111)} Brochure`;
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'CUTB', fromMe: true, jid: STRANGER, pushName: 'Abdulaziz', ts: NOW - 60_000, text: '', messageType: 'documentMessage',
      media: `[document: ${cutName}]`, fileName: cutName, fileNameTruncated: true, fileNameTk: false, fileNameBona: false }),
    msg({ id: 'BONAB', fromMe: true, jid: STRANGER2, pushName: 'Abdulaziz', ts: NOW - 30_000, text: '', messageType: 'documentMessage',
      media: '[document: Bona Traffic HD brochure.pdf]', fileName: 'Bona Traffic HD brochure.pdf' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 0, 'no lead');
  assert.equal(tally.joined, 0);
  assert.equal(h.findCalls.length, 0);
  assert.equal(tally.candidates, 2);
  assert.deepEqual(candidates(h).map((r) => [r.phone_e164, r.name, r.words, r.last_dir]), [
    ['966522222222', null, 'property document', 'out'],
    ['966533333333', null, 'property document', 'out'],
  ]);
  h.cleanup();
});

test('(u) a stranger asking for the price list is a chat to check', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'PL1', jid: STRANGER, pushName: 'Umm Fahad', ts: NOW - 60_000, text: 'Can I get the price list and payment plan?' }),
    msg({ id: 'PL2', jid: STRANGER2, pushName: null, ts: NOW - 30_000, text: 'ابغى البروشور وقائمة الأسعار' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 0);
  assert.equal(tally.candidates, 2);
  assert.deepEqual(candidates(h).map((r) => [r.phone_e164, r.name, r.words, r.last_dir]), [
    ['966522222222', 'Umm Fahad', 'property document', 'in'],
    ['966533333333', null, 'property document', 'in'],
  ]);
  h.cleanup();
});

test('(u) a chat with no number is never a candidate: a lid alone, or a WhatsApp channel', async () => {
  const h = harness({ inbox: true, windows: [[
    // A lid alone may be a colleague whose lid is not learned yet: it cannot be checked (A7).
    msg({ id: 'LID1', jid: '272516946294519@lid', jidAlt: null, pushName: 'Maybe Mona', ts: NOW - 60_000, text: 'the villa keys are with me' }),
    msg({ id: 'LID2', fromMe: true, jid: '272516946294520@lid', jidAlt: null, pushName: null, ts: NOW - 50_000, text: 'rent is due' }),
    // A channel the instance follows posts listings all day long.
    msg({ id: 'CH1', jid: '120363025246125486@newsletter', pushName: 'Jeddah Villas', ts: NOW - 40_000, text: 'فيلا للبيع في الشاطئ' }),
    msg({ id: 'CH2', jid: '12036302524@newsletter', pushName: 'Villas', ts: NOW - 30_000, text: 'villa for rent' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(tally.candidates, 0);
  assert.deepEqual(candidates(h), []);
  assert.equal(h.db.countLeads(), 0);
  h.cleanup();
});

test('(u) a chat on the list that later sends a Ref line becomes a lead and leaves the list', async () => {
  const h = harness({ inbox: true, windows: [[msg({ id: 'Q1', jid: STRANGER, ts: NOW - 120_000, text: 'Is the apartment still for rent?' })]] });
  await h.poller.tick();
  assert.equal(candidates(h).length, 1);
  h.push([msg({ id: 'R1', jid: STRANGER, ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' })]);
  await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.phone_e164, '966522222222');
  assert.equal(lead.inbox_state, 'in');
  assert.deepEqual(candidates(h), [], 'it is a lead now: its own inbox state decides');
  h.cleanup();
});

test('(u) a chat that is already a lead is never a candidate, whatever it says', async () => {
  const h = harness({ inbox: true });
  seedInLead(h, { inbox_state: 'out', inbox_since: null });
  h.db.insertLead({ lead_id: 'LEAD-guess', phone_e164: '966522222222', wa_jid: STRANGER, inbox_state: 'unsure', created: NOW - 3_600_000, updated: NOW - 3_600_000 });
  h.push([
    msg({ id: 'A1', ts: NOW - 60_000, text: 'still want the villa' }),
    msg({ id: 'A2', fromMe: true, pushName: null, ts: NOW - 50_000, text: 'the villa is sold' }),
    msg({ id: 'B1', jid: STRANGER, ts: NOW - 40_000, text: 'any apartment?' }),
  ]);
  const tally = await h.poller.tick();
  assert.equal(tally.candidates, 0);
  assert.deepEqual(candidates(h), []);
  assert.equal(h.db.getLead('LEAD-in').inbox_state, 'out', '"Not a client" stays');
  h.cleanup();
});

test('(u) a dismissed chat stays dismissed: later property messages neither reopen nor count it', async () => {
  const h = harness({ inbox: true, windows: [[msg({ id: 'Q1', jid: STRANGER, ts: NOW - 120_000, text: 'أبغى فيلا' })]] });
  await h.poller.tick();
  const [row] = candidates(h);
  h.inbox.dismissCandidate(row.cand_id);
  h.push([msg({ id: 'Q2', jid: STRANGER, ts: NOW - 60_000, text: 'وش صار على الفيلا؟ عندكم شقة؟' })]);
  const tally = await h.poller.tick();
  assert.equal(tally.candidates, 0);
  const [after] = candidates(h);
  assert.deepEqual([after.state, after.hits, after.words, after.name, after.last_dir], ['dismissed', 0, null, null, null]);
  assert.equal(h.inbox.countCandidates(), 0);
  h.cleanup();
});

test('(u) team and never-list numbers never become candidates', async () => {
  const h = harness({ inbox: true, isExcluded: (digits) => digits === '966522222222' || digits === '966533333333' });
  h.push([
    msg({ id: 'T1', jid: STRANGER, ts: NOW - 60_000, text: 'the villa keys are with me' }),
    msg({ id: 'T2', fromMe: true, jid: STRANGER2, pushName: null, ts: NOW - 30_000, text: 'rent is due' }),
  ]);
  const tally = await h.poller.tick();
  assert.equal(tally.ignored, 2);
  assert.deepEqual(candidates(h), []);
  h.cleanup();
});

test('(u) without the inbox the poller keeps no list: Phase 1 is unchanged', async () => {
  const h = harness({ windows: [[msg({ id: 'Q1', jid: STRANGER, text: 'عندكم شقة للإيجار؟' })]] });
  const tally = await h.poller.tick();
  assert.equal(tally.unmatched, 1);
  assert.equal(tally.candidates, 0);
  assert.equal(createInboxStore(h.db).countCandidates(), 0);
  h.cleanup();
});

test('(u) a list that cannot be written never fails the record, and says so by the kind of error only', async () => {
  const h = harness({ inbox: true, windows: [[msg({ id: 'Q1', jid: STRANGER, pushName: 'Umm Khalid', text: 'عندكم شقة للإيجار؟' })]] });
  h.inbox.noteCandidate = () => { throw new Error('disk I/O error on 966522222222'); };
  const tally = await h.poller.tick();
  assert.equal(tally.unmatched, 1);
  assert.equal(h.db.waSeenHas('Q1'), true, 'handled: it is not read again');
  assert.ok(!h.logs.some((l) => l.evt === 'wa.poll.record_failed'));
  const failed = h.logs.find((l) => l.evt === 'inbox.candidate_failed');
  assert.deepEqual(failed, { level: 'warn', evt: 'inbox.candidate_failed', error: 'Error' }, 'the kind of error, never its message (Task 9, c9e3145)');
  const dump = JSON.stringify(h.logs);
  for (const secret of ['disk I/O', '966522222222']) assert.ok(!dump.includes(secret), secret);
  h.cleanup();
});

test('(u) nothing about a candidate reaches a log line: no number, name, lid or word', async () => {
  const lid = '272516946294519@lid';
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'Q1', jid: lid, jidAlt: STRANGER, pushName: 'Umm Khalid', ts: NOW - 60_000, text: 'عندكم شقة للإيجار؟' }),
    msg({ id: 'O1', fromMe: true, jid: STRANGER2, pushName: 'Abdulaziz', ts: NOW - 30_000, text: 'the villa is 3M' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(tally.candidates, 2);
  const tick = h.logs.find((l) => l.evt === 'wa.poll.tick');
  assert.equal(tick.candidates, 2, 'the count is logged');
  const dump = JSON.stringify(h.logs);
  for (const secret of ['966522222222', '966533333333', '272516946294519', 'Umm Khalid', 'Abdulaziz', 'شقة', 'villa', 'عندكم']) {
    assert.ok(!dump.includes(secret), `a log line carries ${secret}`);
  }
  h.cleanup();
});
```

- [ ] **Step 10: Run to see them fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/wa-poller.test.mjs`
Expected: FAIL — the file does not load (`SyntaxError: The requested module '../lib/wa-poller.mjs' does not provide an export named 'TK_DOCUMENT_WORD'`).

- [ ] **Step 11: The poller** — seven edits in `services/api/lib/wa-poller.mjs`, on the file as Tasks 9 and 15 left it (the anchors below match Task 9's commits up to 232b9f8 and Task 15's comment edit; if one of those lines has moved since, make the same change to the line as they left it — each edit only adds to it).

(a) The module header (as Task 15 left it). Find:

```js
 * joining message plus the 24 h before it. An `out` chat never comes back on its own.
 * Every other conversation is still discarded exactly as above.
 */
```

Replace with:

```js
 * joining message plus the 24 h before it. An `out` chat never comes back on its own.
 *
 * **Real-estate chats to check** (D17). A message that ends up with no lead behind it — a
 * stranger's that matched no rule, or the owner's to a stranger that did not join — but
 * uses property words (`propertyWordsIn`) or a property-document word (`PROPERTY_DOC_RE`),
 * or is a document of his that names TK, puts its chat on the owner's list
 * (lib/inbox/store.mjs `noteCandidate`) when the chat has a phone number: the number and
 * jid (and lid, when WhatsApp shows one), the name WhatsApp shows for a client (never the
 * owner's own, on a message he sent), the property words and the time. Never the text,
 * never a lead, never a note to anyone; the owner moves it into the inbox or marks it not a
 * client. A chat that becomes a lead leaves the list. Every other conversation is still
 * discarded exactly as above.
 */
```

(b) The import. Find:

```js
import {
  BONA_WORD_RE, LISTING_ID_RE, inboundSignal, nextInboxState, ownerOutboundJoins,
} from './inbox/eligibility.mjs';
```

Replace with:

```js
import {
  BONA_WORD_RE, LISTING_ID_RE, MAX_PROPERTY_WORDS, PROPERTY_DOC_RE, inboundSignal, isTkDocument, nextInboxState, ownerOutboundJoins,
  propertyWordsIn,
} from './inbox/eligibility.mjs';
```

(c) The words of one record. Find:

```js
/** How often one record may fail before it is written off rather than retried for ever. */
export const MAX_RECORD_ATTEMPTS = 3;
```

Replace with:

```js
/** How often one record may fail before it is written off rather than retried for ever. */
export const MAX_RECORD_ATTEMPTS = 3;
/** What the owner's list shows for a document of his that names TK (D16, D17). */
export const TK_DOCUMENT_WORD = 'tk document';
/**
 * What it shows for a property-document word (lib/inbox/eligibility.mjs `PROPERTY_DOC_RE`:
 * brochure, price list, بروشور …) in a message or a document's name that did not join.
 */
export const PROPERTY_DOCUMENT_WORD = 'property document';

/**
 * Why a record's chat belongs on the owner's list of real-estate chats to check (D17): the
 * property words in its text or caption and, for a document, in its file name — after
 * `tk document` when it is a document the owner sent that names TK, and `property document`
 * when the text, the caption or a document's name has a property-document word, in either
 * direction. So every owner-sent property document that did not join (it names Bona, or its
 * name was cut too close to the word, Task 15) is on the list, and so is a client asking
 * for "the price list". Canonical words only, never the text. A word at the end of a name
 * cut at 120 characters may be the start of a longer one; that only ever puts a chat on the
 * list to check, never in the inbox.
 * @returns {string[]} at most `MAX_PROPERTY_WORDS`
 */
export function candidateWordsOf(rec) {
  const text = typeof rec?.text === 'string' ? rec.text : '';
  const doc = typeof rec?.media === 'string' && rec.media.startsWith('[document');
  const name = doc && typeof rec.fileName === 'string' ? rec.fileName : '';
  const markers = [];
  if (rec?.fromMe === true && isTkDocument(rec)) markers.push(TK_DOCUMENT_WORD);
  if (PROPERTY_DOC_RE.test(text) || (name && PROPERTY_DOC_RE.test(name))) markers.push(PROPERTY_DOCUMENT_WORD);
  return [...markers, ...propertyWordsIn(name ? `${text}\n${name}` : text)].slice(0, MAX_PROPERTY_WORDS);
}
```

(d) Noting a candidate, next to the other inbox helpers. Find:

```js
  /* -------------------- the tick -------------------- */
```

Replace with:

```js
  /**
   * D17: after a record is handled, a chat that is a lead leaves the owner's list of
   * real-estate chats to check (its inbox state rules now), and a chat that is not one goes
   * on it when the record gives a reason (`candidateWordsOf`) — only a person's chat with a
   * phone number. A WhatsApp channel (`…@newsletter`) is nobody's chat. A lid alone is not
   * noted, for the reasons A7 makes no lead of one: it cannot be checked against the team or
   * the never list (it may be a colleague whose lid is not learned yet), cannot be replied
   * to, and the exclusion sweep cannot catch it later. A client's name is kept, the name on
   * a record the owner sent is his own and never is. It is only a list for the owner to look
   * at, so it never fails the record: a failure is logged by its kind only (`errorKind`: no
   * message, so no numbers, no words) and the record is not retried for it — a retry would
   * handle the record a second time.
   */
  function noteCandidateSafely(rec, ts, tally) {
    try {
      const jids = jidsOf(rec);
      if (jids.waJid && !jids.waJid.endsWith('@s.whatsapp.net')) return;
      if (!jids.phone && !jids.waJid && !jids.waLid) return;
      if (findLead(jids)) {
        inboxStore.removeCandidatesFor({ phone: jids.phone, jid: jids.waJid, lid: jids.waLid });
        return;
      }
      if (!jids.phone) return;
      const words = candidateWordsOf(rec);
      if (!words.length) return;
      const res = inboxStore.noteCandidate({
        jid: jids.waJid, lid: jids.waLid, phone: jids.phone, name: rec.fromMe ? null : (rec.pushName ?? null),
        ts, words, dir: rec.fromMe ? 'out' : 'in',
      });
      if (res.state === 'open') tally.candidates += 1;
    } catch (err) {
      log({ level: 'warn', evt: 'inbox.candidate_failed', ...errorKind(err) });
    }
  }

  /* -------------------- the tick -------------------- */
```

(e) The tally. Find:

```js
      const tally = { scanned: records.length, matched: 0, unmatched: 0, created: 0, merged: 0, replies: 0, ignored: 0, lidOnlyUnexcludable: 0, stored: 0, joined: 0 };
```

Replace with:

```js
      const tally = { scanned: records.length, matched: 0, unmatched: 0, created: 0, merged: 0, replies: 0, ignored: 0, lidOnlyUnexcludable: 0, stored: 0, joined: 0, candidates: 0 };
```

(f) After the record is handled, inside the per-record `try`, just before it is marked seen. Find:

```js
          // Remembered once it is safely handled, so a transient store failure costs a
```

Replace with:

```js
          if (inboxOn) noteCandidateSafely(rec, ts, tally);
          // Remembered once it is safely handled, so a transient store failure costs a
```

(The team, never-list, own-chat, group and seen checks all `continue` before this point, so an excluded number never becomes a candidate. A retried inbound record — Task 9's `handled` path — reaches it too, and finds its lead.)

(g) The tick's log line counts candidates. Find:

```js
      if (tally.matched || tally.replies || tally.stored || tally.joined) log({ evt: 'wa.poll.tick', ...tally });
```

Replace with:

```js
      if (tally.matched || tally.replies || tally.stored || tally.joined || tally.candidates) log({ evt: 'wa.poll.tick', ...tally });
```

- [ ] **Step 12: Run**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/wa-poller.test.mjs`
Expected: PASS, 0 fail (14 more tests than before).

- [ ] **Step 13: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail — 14 more tests than after Part A (916 → 930).

- [ ] **Step 14: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/wa-poller.mjs services/api/test/wa-poller.test.mjs
git commit -m "wa-poller: a chat that talks about property with no sure sign goes on the owner's list (D17)

A record with no lead behind it that uses property words or a
property-document word, or a TK document the owner sends, notes a candidate
when its chat has a phone number: never a lead, never the text, never a
note, never the owner's own name. A chat that becomes a lead leaves the list.
Noting never fails the record, and a failure is logged by its kind only.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Part C — the Unsure tab, move and dismiss, the upkeep

- [ ] **Step 15: Write the failing tests**

Append to the end of `services/api/test/dashboard-render-inbox.test.mjs` (after Task 14's test):

```js

/* ---------------- real-estate chats to check (D17) ---------------- */

const cand = (over = {}) => ({
  cand_id: 'CND-mf3k2a-1a2b', jid: '966512340077@s.whatsapp.net', lid: null, phone_e164: '966512340077', name: 'Umm Khalid',
  first_ts: NOW - 50 * HOUR, last_ts: NOW - HOUR, hits: 3, words: ['شقة', 'إيجار'], last_dir: 'in', state: 'open', updated: NOW - HOUR, ...over,
});

test('the owner\'s Unsure tab lists the real-estate chats to check: name or masked number, words, times, count, who wrote last, two decisions', () => {
  const html = unsurePage({
    me: OWNER,
    now: NOW,
    rows: [],
    candidates: [
      cand(),
      cand({ cand_id: 'CND/1?x=1', name: EVIL, phone_e164: '966598760011', words: ['villa', '<b>x</b>'], hits: 1, last_dir: 'out', first_ts: NOW - 30_000, last_ts: NOW - 30_000 }),
      cand({ cand_id: 'CND-3', name: null, phone_e164: '966555550022', words: [], last_dir: null }),
    ],
  });
  assert.match(html, /<h2[^>]*>Real-estate chats to check<\/h2>/);
  assert.match(html, /<bdi>Umm Khalid<\/bdi>/);
  assert.match(html, /<bdi>&lt;img src=x onerror=alert\(1\)&gt;<\/bdi>/);
  assert.ok(!html.includes('<img'), 'a name is text, never markup');
  assert.ok(!html.includes('<b>x</b>'), 'so is a word');
  assert.match(html, /شقة · إيجار/);
  assert.match(html, /…0077/);
  assert.match(html, /<span class="nm"><span class="tel">…0022<\/span><\/span>/, 'no name: the masked number stands in');
  assert.doesNotMatch(html, /966512340077|966598760011|966555550022/, 'never a whole number');
  assert.match(html, /first 2\sd ago/);
  assert.match(html, /last 1\sh ago/);
  assert.match(html, /last just now/);
  assert.match(html, /3 messages/);
  assert.match(html, /1 message</);
  assert.match(html, /they wrote last/);
  assert.match(html, /you wrote last/);
  assert.match(html, /action="\/v1\/admin\/inbox\/candidates\/CND-mf3k2a-1a2b\/move"/);
  assert.match(html, /action="\/v1\/admin\/inbox\/candidates\/CND-mf3k2a-1a2b\/dismiss"/);
  assert.match(html, /action="\/v1\/admin\/inbox\/candidates\/CND%2F1%3Fx%3D1\/move"/, 'an odd id stays one path segment');
  assert.equal(html.match(/>Move to Bona inbox<\/button>/g).length, 3);
  assert.equal(html.match(/>Not a client<\/button>/g).length, 3);
  assert.match(html, /Unsure · 3<\/a>/, 'the tab counts the chats to check');
  assert.match(html, /until 30 days after the last such message/, 'how long, as the privacy page says');
  assert.match(html, /No chats that mention Bona to decide/);
  assert.doesNotMatch(html, /Nothing to decide/);
});

test('the Unsure tab counts guesses and chats to check together, and says so when there is neither', () => {
  const both = unsurePage({ me: OWNER, now: NOW, rows: [{ ...LEAD, inbox_state: 'unsure', match_method: 'keyword', snippet: 'bona?' }], candidates: [cand()] });
  assert.match(both, /Unsure · 2<\/a>/);
  assert.match(both, /wrote the word “bona”/);
  assert.match(both, /Real-estate chats to check/);
  const none = unsurePage({ me: OWNER, now: NOW, rows: [], candidates: [] });
  assert.match(none, /Nothing to decide/);
  assert.doesNotMatch(none, /Real-estate chats to check/);
});

test('only an owner\'s page ever draws a chat to check, even when one is passed', () => {
  for (const me of [STAFF, null, { ...OWNER, role: 'staff' }]) {
    const html = unsurePage({ me, now: NOW, rows: [], candidates: [cand()] });
    assert.doesNotMatch(html, /Umm Khalid|Real-estate chats to check|\/candidates\/|…0077|شقة/, JSON.stringify(me?.role ?? null));
    assert.doesNotMatch(html, /Unsure · \d/, 'and it counts none');
  }
});

test('a chat to check full of nulls renders without "undefined", "NaN", "[object" or a 1970 date', () => {
  const blank = Object.fromEntries(Object.keys(cand()).map((k) => [k, null]));
  blank.cand_id = 'n';
  const html = unsurePage({ me: OWNER, now: NOW, rows: [], candidates: [blank, { cand_id: 'w', words: 'villa,flat' }] });
  assert.doesNotMatch(html, /undefined|NaN|\[object|1970-01-01/);
  assert.match(html, /villa · flat/, 'words stored as text still read as words');
  assert.match(html, /action="\/v1\/admin\/inbox\/candidates\/n\/dismiss"/);
});

test('a chat to check has its own banners: dismissed, gone, and no number to move in', () => {
  assert.equal(knownError('candidate_gone'), 'candidate_gone');
  assert.equal(knownError('candidate_no_number'), 'candidate_no_number');
  assert.match(unsurePage({ me: OWNER, rows: [], error: 'candidate_no_number', now: NOW }), /<div class="err">That chat has no phone number/);
  assert.ok(unsurePage({ me: OWNER, rows: [], ok: 'dismissed', now: NOW }).includes(`<div class="ok">${INBOX_OK.dismissed}</div>`));
  assert.match(unsurePage({ me: OWNER, rows: [], error: 'candidate_gone', now: NOW }), /<div class="err">That chat is no longer on the list/);
});
```

Append to the end of `services/api/test/dashboard-inbox.test.mjs` (after Task 14's test):

```js

/* ---------------- real-estate chats to check (D17) ---------------- */

const CAND_PHONE = '966500000091';
/** One chat on the owner's list, as the poller would have noted it. */
const noteCand = (h, { phone = CAND_PHONE, name = 'Candi Date', words = ['شقة', 'إيجار'], dir = 'in', ts = NOW + 10_000 } = {}) =>
  h.inboxStore.noteCandidate({ phone, jid: `${phone}@s.whatsapp.net`, name, ts, words, dir }).cand_id;

test('the owner\'s Unsure tab lists and counts the real-estate chats to check; a never-list one is on no list', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const id = noteCand(h);
    h.team.addNever({ phone: '966500000092' });
    noteCand(h, { phone: '966500000092', name: 'Never Cand' });
    const boss = await h.boss();
    assert.match(await (await h.get('/dashboard/inbox', { cookie: boss })).text(), /Unsure · 2<\/a>/, 'Umar and Candi, not the never-list chat');
    const res = await h.get('/dashboard/inbox?tab=unsure', { cookie: boss });
    assert.equal(res.status, 200);
    assertLocked(res);
    const html = await res.text();
    assert.match(html, /Real-estate chats to check/);
    assert.ok(html.includes('Candi Date'));
    assert.ok(html.includes('Umar Unsure'), 'the guesses are still there');
    assert.match(html, /شقة · إيجار/);
    assert.ok(html.includes(`action="/v1/admin/inbox/candidates/${id}/move"`));
    assert.ok(html.includes(`action="/v1/admin/inbox/candidates/${id}/dismiss"`));
    assert.ok(!html.includes('Never Cand'));
    assert.ok(!html.includes(CAND_PHONE), 'a masked number only');
  });
});

test('a chat to check that has become a lead meanwhile is on no list and in no count: the lead decides', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    noteCand(h);
    noteCand(h, { phone: '966500000078', name: 'Umar Again' });
    const boss = await h.boss();
    const html = await (await h.get('/dashboard/inbox?tab=unsure', { cookie: boss })).text();
    assert.ok(html.includes('Candi Date'));
    assert.ok(!html.includes('Umar Again'), 'LEAD-U already holds that number');
    assert.match(await (await h.get('/dashboard/inbox', { cookie: boss })).text(), /Unsure · 2<\/a>/, 'Umar once, as the guess he is, and Candi');
  });
});

test('staff never see a chat to check: not on any page, not in any JSON', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    noteCand(h);
    const staff = await h.staff();
    for (const p of ['/dashboard', '/dashboard/inbox', '/dashboard/leads', '/dashboard/inbox?tab=unsure', '/v1/admin/leads']) {
      const res = await h.get(p, { cookie: staff });
      const body = await res.text();
      for (const secret of ['Candi Date', 'candidates/', 'شقة · إيجار', CAND_PHONE, '…0091']) assert.ok(!body.includes(secret), `${p}: ${secret}`);
    }
  });
});

test('the owner moves a chat to check into the inbox: an owner_added lead, in, 30 days of history, off the list, audited by ids only', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const id = noteCand(h);
    const boss = await h.boss();
    const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/move`, {}, { cookie: boss });
    assert.equal(res.status, 303);
    const leadId = /^\/dashboard\/inbox\/(LEAD-[A-Za-z0-9-]+)\?ok=moved$/.exec(res.headers.get('location'))?.[1];
    assert.ok(leadId, res.headers.get('location'));
    const lead = h.db.getLead(leadId);
    assert.equal(lead.phone_e164, CAND_PHONE);
    assert.equal(lead.wa_jid, `${CAND_PHONE}@s.whatsapp.net`);
    assert.equal(lead.name, 'Candi Date');
    assert.equal(lead.match_method, 'owner_added');
    assert.equal(lead.inbox_state, 'in');
    assert.equal(h.spy.history.at(-1).leadId, leadId);
    assert.equal(h.spy.history.at(-1).untilTs - h.spy.history.at(-1).sinceTs, OWNER_HISTORY_MS);
    assert.equal(h.inboxStore.getCandidate(id), null, 'it is a lead now: off the list');
    assert.deepEqual(h.notes, [], 'no new-lead note: the owner vouched for it himself');
    const audited = h.app.audit.recent(50).find((r) => r.action === 'inbox_move');
    assert.equal(audited.target, id);
    assert.deepEqual(audited.meta, { lead_id: leadId });
    assert.equal(audited.user_id, h.owner.user_id);
    const staff = await h.staff();
    assert.ok((await (await h.get('/dashboard/inbox', { cookie: staff })).text()).includes('Candi Date'), 'the team sees it now');
    const again = await h.postForm(`/v1/admin/inbox/candidates/${id}/move`, {}, { cookie: boss });
    assert.equal(again.headers.get('location'), '/dashboard/inbox?tab=unsure&error=candidate_gone');
    const dump = JSON.stringify([h.app.audit.recent(50), h.logs]);
    for (const secret of [CAND_PHONE, '500000091', 'Candi', 'شقة']) assert.ok(!dump.includes(secret), secret);
  });
});

test('Not a client on a chat to check: off the list, not listed again, audited by its id only', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const id = noteCand(h);
    const boss = await h.boss();
    const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/dismiss`, {}, { cookie: boss });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard/inbox?tab=unsure&ok=dismissed');
    assert.equal(h.inboxStore.getCandidate(id).state, 'dismissed');
    assert.equal(h.db.getLeadByPhone(CAND_PHONE), null, 'not a lead either');
    const html = await (await h.get('/dashboard/inbox?tab=unsure&ok=dismissed', { cookie: boss })).text();
    assert.ok(!html.includes('Candi Date'));
    assert.match(html, /<div class="ok">Marked not a client/);
    assert.equal(h.inboxStore.noteCandidate({ phone: CAND_PHONE, ts: NOW + 99_000, words: ['villa'], dir: 'in' }).state, 'dismissed', 'a later message does not ask again');
    const audited = h.app.audit.recent(50).find((r) => r.action === 'inbox_out');
    assert.equal(audited.target, id);
    const again = await h.postForm(`/v1/admin/inbox/candidates/${id}/dismiss`, {}, { cookie: boss });
    assert.equal(again.headers.get('location'), '/dashboard/inbox?tab=unsure&error=candidate_gone');
    assert.ok(!JSON.stringify([h.app.audit.recent(50), h.logs]).includes('500000091'));
  });
});

test('a chat to check whose number is a colleague\'s or on the never list is never moved in, and leaves the list', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const never = noteCand(h, { phone: '966500000092', name: 'Never Cand' });
    const colleague = noteCand(h, { phone: '966500000001', name: 'Sara Again' });
    h.team.addNever({ phone: '966500000092' });
    const boss = await h.boss();
    const leadsBefore = h.db.countLeads();
    for (const id of [never, colleague]) {
      const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/move`, {}, { cookie: boss });
      assert.equal(res.headers.get('location'), '/dashboard/inbox?tab=unsure&error=excluded', id);
      assert.equal(h.inboxStore.getCandidate(id), null, id);
    }
    assert.equal(h.db.countLeads(), leadsBefore);
    assert.deepEqual(h.spy.history, []);
  });
});

test('move and Not a client on a chat to check are the owner\'s alone', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const id = noteCand(h);
    const staff = await h.staff();
    for (const what of ['move', 'dismiss']) {
      const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/${what}`, {}, { cookie: staff });
      assert.equal(res.status, 403, what);
      assertLocked(res);
      assert.deepEqual(await res.json(), { error: 'owner_only' }, what);
      assert.ok(h.logs.some((e) => e.evt === 'dash.owner_only' && e.path === `/v1/admin/inbox/candidates/:id/${what}`), what);
    }
    assert.equal(h.inboxStore.getCandidate(id).state, 'open');
    assert.equal(h.db.getLeadByPhone(CAND_PHONE), null);
    assert.deepEqual(h.spy.history, []);
  });
});

test('a number added to the never list or the team leaves the list of chats to check at once', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const never = noteCand(h, { phone: '966500000093', name: 'Cousin' });
    const hire = noteCand(h, { phone: '966500000094', name: 'New Hire' });
    const boss = await h.boss();
    assert.equal((await h.postForm('/v1/admin/never', { phone: '0500000093' }, { cookie: boss })).headers.get('location'), '/dashboard/team?ok=never_added');
    assert.equal(h.inboxStore.getCandidate(never), null);
    assert.equal((await h.postForm('/v1/admin/team', { name: 'New Hire', phone: '0500000094', role: 'staff' }, { cookie: boss })).headers.get('location'), '/dashboard/team?ok=added');
    assert.equal(h.inboxStore.getCandidate(hire), null);
  });
});

test('Add chat by phone number, and Move on a lead, take that chat off the list of chats to check at once', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const added = noteCand(h, { phone: '966500000095', name: 'Added Later' });
    const umar = noteCand(h, { phone: '966500000078', name: 'Umar Again' });
    const boss = await h.boss();
    assert.match((await h.postForm('/v1/admin/inbox/add', { phone: '0500000095' }, { cookie: boss })).headers.get('location'), /\?ok=added$/);
    assert.equal(h.inboxStore.getCandidate(added), null, 'a lead now: the row is gone, not only hidden');
    assert.equal((await h.postForm('/v1/admin/inbox/LEAD-U/move', {}, { cookie: boss })).headers.get('location'), '/dashboard/inbox/LEAD-U?ok=moved');
    assert.equal(h.inboxStore.getCandidate(umar), null, 'LEAD-U holds that number, and it is in now');
  });
});

test('a chat to check with no phone number, a lid alone or a WhatsApp channel, is never moved in, and leaves the list', async () => {
  await withInbox(async (h) => {
    seedScene(h);
    const note = (ids) => h.inboxStore.noteCandidate({ ...ids, name: 'No Number', ts: NOW + 10_000, words: ['villa'], dir: 'in' }).cand_id;
    const lidOnly = note({ lid: '272516946294599@lid' });
    const channel = note({ phone: '12036302524', jid: '12036302524@newsletter' });
    const boss = await h.boss();
    const leadsBefore = h.db.countLeads();
    for (const id of [lidOnly, channel]) {
      const res = await h.postForm(`/v1/admin/inbox/candidates/${id}/move`, {}, { cookie: boss });
      assert.equal(res.headers.get('location'), '/dashboard/inbox?tab=unsure&error=candidate_no_number', id);
      assert.equal(h.inboxStore.getCandidate(id), null, id);
    }
    assert.equal(h.db.countLeads(), leadsBefore);
    assert.deepEqual(h.spy.history, []);
  });
});
```

In `services/api/test/inbox-wiring.test.mjs` (Task 11), the upkeep's counts gain two keys. Find:

```js
    assert.deepEqual(counts, { excludedOut: 0, purgedChats: 1, purgedMessages: 1, codeRows: 1, interrupted: 1, caughtUp: 2, caughtUpStored: 3 });
```

Replace with:

```js
    assert.deepEqual(counts, { excludedOut: 0, purgedChats: 1, purgedMessages: 1, codeRows: 1, interrupted: 1, candidatesExpired: 0, dismissalsExpired: 0, caughtUp: 2, caughtUpStored: 3 });
```

Find:

```js
    assert.deepEqual(counts, { excludedOut: 3, purgedChats: 0, purgedMessages: 0, codeRows: 0, interrupted: 0, caughtUp: 1, caughtUpStored: 0 });
```

Replace with:

```js
    assert.deepEqual(counts, { excludedOut: 3, purgedChats: 0, purgedMessages: 0, codeRows: 0, interrupted: 0, candidatesExpired: 0, dismissalsExpired: 0, caughtUp: 1, caughtUpStored: 0 });
```

and append to the end of that file:

```js

test('the daily upkeep prunes the real-estate chats to check: open ones after 30 days, dismissed ones after a year', async () => {
  const h = build();
  try {
    const { app, db } = h;
    // Rows written at other moments: the same store over the same file, another clock.
    const at = (ts) => createInboxStore(db, { now: () => ts });
    const note = (phone, ts) => app.inboxStore.noteCandidate({ phone, ts, words: ['villa'], dir: 'in' }).cand_id;
    const stale = note('966500000071', NOW - 31 * DAY);
    const fresh = note('966500000072', NOW - 29 * DAY);
    const oldNo = note('966500000073', NOW - 400 * DAY);
    const newNo = note('966500000074', NOW - 400 * DAY);
    at(NOW - 366 * DAY).dismissCandidate(oldNo);
    at(NOW - 10 * DAY).dismissCandidate(newNo);

    const counts = await app.inboxMaintenance();
    assert.equal(counts.candidatesExpired, 1);
    assert.equal(counts.dismissalsExpired, 1);
    assert.equal(app.inboxStore.getCandidate(stale), null);
    assert.ok(app.inboxStore.getCandidate(fresh));
    assert.equal(app.inboxStore.getCandidate(oldNo), null);
    assert.equal(app.inboxStore.getCandidate(newNo).state, 'dismissed', 'still not listed again');
    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.maintenance'), { evt: 'inbox.maintenance', ...counts });
    assert.ok(!JSON.stringify(h.logs).includes('96650000007'), 'counts only');
  } finally {
    await h.close();
  }
});
```

- [ ] **Step 16: Run to see them fail**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/dashboard-render-inbox.test.mjs api/test/dashboard-inbox.test.mjs api/test/inbox-wiring.test.mjs`
Expected: FAIL — render: 4 of the 5 new tests (the page ignores `candidates`, so there is no section, no count and no banner; "only an owner's page ever draws a chat to check" passes already, since nothing draws one yet); routes: 9 of the 10 new tests (the tab shows no candidates, `/v1/admin/inbox/candidates/:id/move|dismiss` answers `404 {"error":"not_found"}` even for staff, the never-list and team adds, *Add chat* and *Move* on a lead leave the candidate; "staff never see a chat to check" passes already); wiring: the two edited upkeep tests and the new one (no `candidatesExpired` / `dismissalsExpired`, nothing pruned). Every other test passes.

- [ ] **Step 17: The screen** — in `services/api/lib/dashboard/render-inbox.mjs` (as Tasks 10 and 14 left it), two edits.

Find:

```js
  added: 'Added to the Bona inbox.',
};
```

Replace with:

```js
  added: 'Added to the Bona inbox.',
  dismissed: 'Marked not a client. It is off the list, and only its number is kept, so it is not listed again.',
};
```

Find the function `unsurePage` as Task 10 left it — from its doc comment line `/** Chats that might be about Bona. Only the owner decides, so only the owner sees them. */` through the function's closing `}` — and replace that whole block with:

```js
/* ------------------------------------------------------------------ */
/* Real-estate chats to check (owner only, D17)                        */
/* ------------------------------------------------------------------ */

const candidateHref = (candId, what) => `/v1/admin/inbox/candidates/${encodeURIComponent(candId)}/${what}`;

/**
 * One chat that talks about property with nothing that says Bona. No lead is behind it and
 * nothing it said was kept: the name WhatsApp shows for the client, or the masked number
 * when there is none; the property words; when it first and last wrote; how many messages;
 * and whether the last one was the owner's or theirs.
 */
function candidateRow(c, now) {
  const name = String(c.name ?? '').trim();
  const masked = maskPhone(c.phone_e164);
  const words = (Array.isArray(c.words) ? c.words : String(c.words ?? '').split(',')).filter((w) => typeof w === 'string' && w);
  const hits = Number(c.hits) || 0;
  const when = (ts) => {
    const a = agoSince(now, ts);
    return a === '—' || a === 'just now' ? a : `${a} ago`;
  };
  const last = c.last_dir === 'out' ? 'you wrote last' : c.last_dir === 'in' ? 'they wrote last' : '';
  const facts = [
    name ? `<span class="tel">${esc(masked)}</span>` : '',
    `<span>first ${esc(when(c.first_ts))}</span>`,
    `<span>last ${esc(when(c.last_ts))}</span>`,
    hits ? `<span>${esc(hits)} ${hits === 1 ? 'message' : 'messages'}</span>` : '',
    last ? `<span>${esc(last)}</span>` : '',
  ].filter(Boolean).join('<span>·</span>');
  return `<div class="lr ix">
  <span class="av2" aria-hidden="true"><span dir="auto">${esc(firstLetter(name))}</span></span>
  <div>
    <div class="l1"><span class="nm">${name ? `<bdi>${esc(name)}</bdi>` : `<span class="tel">${esc(masked)}</span>`}</span>${words.length ? `<span class="pl warm" dir="auto">${esc(words.join(' · '))}</span>` : ''}</div>
    <div class="l2">${facts}</div>
    <div class="acts" style="margin-top:8px">${postButton(candidateHref(c.cand_id, 'move'), 'Move to Bona inbox')}${postButton(candidateHref(c.cand_id, 'dismiss'), 'Not a client')}</div>
  </div>
</div>`;
}

/**
 * Chats that might be about Bona: the guessed leads, then the real-estate chats to check
 * (D17). Only the owner decides, so only the owner sees them; the chats to check are drawn
 * only for an owner even if a caller passes them for someone else. The tab counts both.
 */
export function unsurePage({ me, rows, candidates = [], ok = null, error = null, now = Date.now() }) {
  const list = Array.isArray(rows) ? rows : [];
  const cands = me?.role === 'owner' && Array.isArray(candidates) ? candidates : [];
  const guesses = list.length
    ? `<div class="card cp">${list.map((r) => unsureRow(r, now)).join('')}</div>`
    : `<p class="muted">${cands.length ? 'No chats that mention Bona to decide.' : 'Nothing to decide.'}</p>`;
  const toCheck = cands.length
    ? `<h2 style="margin-top:22px">Real-estate chats to check</h2>
<p class="sub">Chats on your number that talk about property but carry nothing that says Bona: a TK client, someone you know, or a new Bona client. Nothing they wrote is kept, only the number, the name WhatsApp shows and the property words, until 30 days after the last such message. <b>Move to Bona inbox</b> makes it a Bona chat and copies in its last 30 days; <b>Not a client</b> takes it off this list, and it is not listed again for a year.</p>
<div class="card cp">${cands.map((c) => candidateRow(c, now)).join('')}</div>`
    : '';
  const body = `${flash(ok, error)}
<p class="sub">Chats that might be about Bona but carry no ad, Ref code or listing number. Only owners see this list. <b>Move to Bona inbox</b> copies in the chat's last 30 days so the team can read and reply; <b>Not a client</b> keeps it out of the inbox, and it never comes back on its own.</p>
${guesses}${toCheck}`;
  return layout({ title: 'Unsure', active: '/dashboard/inbox', me, actions: tabs('unsure', list.length + cands.length), body });
}
```

(The `/* One chat */` banner that follows stays as it is, one blank line below.)

In `services/api/lib/dashboard/render.mjs`, find (Task 10's `MESSAGES`):

```js
  not_a_chat: 'That lead has no WhatsApp chat yet — it joins once they write on WhatsApp.',
```

Replace with:

```js
  not_a_chat: 'That lead has no WhatsApp chat yet — it joins once they write on WhatsApp.',
  candidate_gone: 'That chat is no longer on the list: it was moved or marked already.',
  candidate_no_number: 'That chat has no phone number, so it cannot be moved in. If you know the number, use Add chat by phone number.',
```

- [ ] **Step 18: The routes** — nine edits in `services/api/lib/dashboard/routes.mjs`, on the file as Tasks 12 and 14 left it.

(a) A number that joins the team or the never list leaves the list too. Replace the whole function `leaveInboxFor` (with its doc comment) as Task 12 left it:

```js
  /**
   * A number that has just become a colleague's or a never-list one is never a client
   * (§3.5, P2-7): the chat stored under it, if any, leaves the inbox and its transcript
   * goes now, not at the next daily upkeep. Audited by lead id only. Built without the
   * inbox (older tests, tools), there is nothing stored to take out.
   */
  function leaveInboxFor(digits, me) {
    if (!inbox || !digits) return;
    const lead = db.getLeadByPhone(digits) ?? db.getLeadByJid(`${digits}@s.whatsapp.net`);
    if (!lead || lead.inbox_state === 'out') return;
    inbox.leaveInbox(lead.lead_id);
    audit?.record({ userId: me.user_id, action: 'inbox_out', target: lead.lead_id });
  }
```

with:

```js
  /**
   * A number that has just become a colleague's or a never-list one is never a client
   * (§3.5, P2-7): the chat stored under it, if any, leaves the inbox and its transcript
   * goes now, not at the next daily upkeep, and it leaves the owner's list of real-estate
   * chats to check (D17). Audited by lead id only. Built without the inbox (older tests,
   * tools), there is nothing stored to take out.
   */
  function leaveInboxFor(digits, me) {
    if (!inbox || !digits) return;
    inbox.removeCandidatesFor({ phone: digits, jid: `${digits}@s.whatsapp.net` });
    const lead = db.getLeadByPhone(digits) ?? db.getLeadByJid(`${digits}@s.whatsapp.net`);
    if (!lead || lead.inbox_state === 'out') return;
    inbox.leaveInbox(lead.lead_id);
    audit?.record({ userId: me.user_id, action: 'inbox_out', target: lead.lead_id });
  }
```

(b) The Unsure tab lists the candidates and both tab labels count them. Replace the whole function `inboxList` as Task 12 left it (from `  function inboxList({ res, url, me }) {` through its closing `  }`) with:

```js
  /**
   * A real-estate chat to check (D17) whose number is a colleague's or a never-list one is
   * on no list and in no count, like a lead rule 1 hides: the store knows no team.
   */
  const excludedCandidate = (c) => excludedLead({ phone_e164: c.phone_e164, wa_jid: c.jid, wa_lid: c.lid });
  /**
   * The lead a chat to check has become since it was noted (a web form, *Add chat by phone
   * number* …), if any: that lead's own inbox state decides the chat from then on.
   */
  const leadOfCandidate = (c) => (c.phone_e164 ? db.getLeadByPhone(c.phone_e164) : null)
    ?? (c.jid ? db.getLeadByJid(c.jid) : null) ?? (c.lid ? db.getLeadByJid(c.lid) : null);
  /** The most chats to check the Unsure tab lists, and counts: one list for both. */
  const CANDIDATES_SHOWN = 200;
  /**
   * The owner's real-estate chats to check, as his Unsure tab lists and counts them. The
   * store already leaves out, in SQL, a chat that has become a lead; a colleague's or a
   * never-list number is left out here (one team check per row, at most 200 rows).
   */
  const candidatesShown = () => inbox.listCandidates({ limit: CANDIDATES_SHOWN }).filter((c) => !excludedCandidate(c));

  function inboxList({ res, url, me }) {
    if (!inbox) return noSuchPage(res, me);
    const ok = inboxOk(url.searchParams.get('ok'));
    const error = knownError(url.searchParams.get('error'));
    const owner = me.role === 'owner';
    if (url.searchParams.get('tab') === 'unsure') {
      if (!owner) return sendHtml(res, 403, messagePage({ title: 'Owners only', message: 'Only an owner can see the Unsure list.', me }));
      return sendHtml(res, 200, unsurePage({
        me, rows: inbox.listUnsure().filter((l) => !excludedLead(l)), candidates: candidatesShown(), ok, error, now: now(),
      }));
    }
    return sendHtml(res, 200, inboxPage({
      me,
      rows: inbox.listInbox({ userId: me.user_id, userCreated: me.created ?? 0 }).filter((l) => !excludedLead(l)),
      // Counted from the rows the Unsure tab shows (the guesses and the chats to check),
      // never the store's raw counts. Staff get none: the tab is not theirs.
      unsureCount: owner ? inbox.listUnsure({ limit: 1000 }).filter((l) => !excludedLead(l)).length + candidatesShown().length : 0,
      ok,
      error,
      now: now(),
    }));
  }
```

(c) Move and dismiss. Find:

```js
  /* -------------------- dispatch -------------------- */
```

Replace with:

```js
  /**
   * *Move to Bona inbox* on a real-estate chat to check (D17). The owner vouches for it, so
   * it becomes an `owner_added` lead through the one lead write path — no ad fan-out, no
   * new-lead note, born answered (P2-5) — goes `in`, brings its last 30 days, and leaves
   * the list. A colleague's or a never-list number is refused and taken off the list, and
   * so is a row with no phone number (a lid alone, or a WhatsApp channel's jid): A7 makes no
   * lead of one, and the poller notes none. Audited and logged by the candidate's and the
   * lead's ids, never a number.
   */
  async function candidateMove({ res, form, me }, candId) {
    const unsure = '/dashboard/inbox?tab=unsure';
    const c = inbox.getCandidate(candId);
    if (!c || c.state !== 'open') return answer(res, { form, back: `${unsure}&error=candidate_gone`, status: 404, payload: { error: 'not_found' } });
    if (!c.phone_e164 || (c.jid && !c.jid.endsWith('@s.whatsapp.net'))) {
      inbox.removeCandidate(c.cand_id);
      return answer(res, { form, back: `${unsure}&error=candidate_no_number`, status: 400, payload: { error: 'candidate_no_number' } });
    }
    const ids = { phone: c.phone_e164, jid: c.jid, lid: c.lid };
    const existing = leadOfCandidate(c);
    if (excludedCandidate(c) || (existing && excludedLead(existing))) {
      inbox.removeCandidatesFor(ids);
      return answer(res, { form, back: `${unsure}&error=excluded`, status: 400, payload: { error: 'excluded' } });
    }
    const t = now();
    const { lead } = createOrMergeLead(db, { name: c.name, phone: c.phone_e164, waJid: c.jid, waLid: c.lid }, {
      channel: 'whatsapp', matchMethod: 'owner_added', now: t, dataDir: cfg.dataDir,
    });
    inbox.setInboxState(lead.lead_id, 'in', { since: t });
    inbox.removeCandidatesFor(ids);
    audit?.record({ userId: me.user_id, action: 'inbox_move', target: c.cand_id, meta: { lead_id: lead.lead_id } });
    log({ evt: 'dash.candidate_move', candId: c.cand_id, leadId: lead.lead_id });
    await joinHistory(lead.lead_id, t);
    const back = openChat(db.getLead(lead.lead_id)) ? `/dashboard/inbox/${encodeURIComponent(lead.lead_id)}?ok=moved` : '/dashboard/inbox?ok=moved';
    return answer(res, { form, back, status: 200, payload: { ok: true, lead_id: lead.lead_id } });
  }

  /** *Not a client* on a real-estate chat to check: off the list, and not listed again (D17). */
  function candidateDismiss({ res, form, me }, candId) {
    const unsure = '/dashboard/inbox?tab=unsure';
    if (!inbox.dismissCandidate(candId)) return answer(res, { form, back: `${unsure}&error=candidate_gone`, status: 404, payload: { error: 'not_found' } });
    audit?.record({ userId: me.user_id, action: 'inbox_out', target: candId });
    log({ evt: 'dash.candidate_dismiss', candId });
    return answer(res, { form, back: `${unsure}&ok=dismissed`, status: 200, payload: { ok: true } });
  }

  /* -------------------- dispatch -------------------- */
```

(d) Their paths. Find:

```js
  const OWNER_INBOX_WRITES = new Set(['move', 'out']);
```

Replace with:

```js
  const OWNER_INBOX_WRITES = new Set(['move', 'out']);
  /** The owner's decisions on a real-estate chat to check (D17): his alone. */
  const ADMIN_CANDIDATE = /^\/v1\/admin\/inbox\/candidates\/([A-Za-z0-9_-]{1,64})\/(move|dismiss)$/;
```

(`ADMIN_INBOX` cannot match these paths: its id segment admits no `/`.)

(e) They are owner writes of the inbox. Find:

```js
    const inboxMatch = ADMIN_INBOX.exec(p);
    const ownerWrite = Boolean(teamMatch || tiktokMatch || OWNER_WRITES.has(p) || (inboxMatch && OWNER_INBOX_WRITES.has(inboxMatch[2])));
    const writes = (leadMatch && leadMatch[2]) || (p === '/v1/admin/spend' ? 'spend' : null)
      || ((inboxMatch || p === '/v1/admin/inbox/add') ? 'inbox' : null) || (ownerWrite ? 'team' : null);
```

Replace with:

```js
    const inboxMatch = ADMIN_INBOX.exec(p);
    const candMatch = ADMIN_CANDIDATE.exec(p);
    const ownerWrite = Boolean(teamMatch || tiktokMatch || candMatch || OWNER_WRITES.has(p) || (inboxMatch && OWNER_INBOX_WRITES.has(inboxMatch[2])));
    const writes = (leadMatch && leadMatch[2]) || (p === '/v1/admin/spend' ? 'spend' : null)
      || ((inboxMatch || candMatch || p === '/v1/admin/inbox/add') ? 'inbox' : null) || (ownerWrite ? 'team' : null);
```

(f) The owner gate logs the path without the id. Find:

```js
      const shown = teamMatch ? '/v1/admin/team/:id' : inboxMatch ? `/v1/admin/inbox/:id/${inboxMatch[2]}` : p;
```

Replace with:

```js
      const shown = teamMatch ? '/v1/admin/team/:id' : inboxMatch ? `/v1/admin/inbox/:id/${inboxMatch[2]}`
        : candMatch ? `/v1/admin/inbox/candidates/:id/${candMatch[2]}` : p;
```

(g) Dispatch. Find:

```js
      if (!inbox) return sendJson(res, 404, { error: 'not_found' });
      if (!inboxMatch) return inboxAdd(ctx);
```

Replace with:

```js
      if (!inbox) return sendJson(res, 404, { error: 'not_found' });
      if (candMatch) return candMatch[2] === 'move' ? candidateMove(ctx, candMatch[1]) : candidateDismiss(ctx, candMatch[1]);
      if (!inboxMatch) return inboxAdd(ctx);
```

(h) *Add chat by phone number* takes the chat off the list: it is a lead now. In the function `inboxAdd` as Task 12 left it, find:

```js
    inbox.setInboxState(lead.lead_id, 'in', { since: t });
    audit?.record({ userId: me.user_id, action: 'inbox_add', target: lead.lead_id });
```

Replace with:

```js
    inbox.setInboxState(lead.lead_id, 'in', { since: t });
    // A lead now: off the owner's list of real-estate chats to check (D17).
    inbox.removeCandidatesFor({ phone: digits, jid: `${digits}@s.whatsapp.net` });
    audit?.record({ userId: me.user_id, action: 'inbox_add', target: lead.lead_id });
```

(i) So does *Move to Bona inbox* on a lead. In the function `inboxMove` as Task 12 left it, find:

```js
    inbox.setInboxState(leadId, 'in', { since: t });
    audit?.record({ userId: me.user_id, action: 'inbox_move', target: leadId });
```

Replace with:

```js
    inbox.setInboxState(leadId, 'in', { since: t });
    // Off the owner's list of real-estate chats to check, if it was there (D17).
    inbox.removeCandidatesFor({ phone: lead.phone_e164, jid: lead.wa_jid, lid: lead.wa_lid });
    audit?.record({ userId: me.user_id, action: 'inbox_move', target: leadId });
```

(`createOrMergeLead`, `excludedLead`, `openChat`, `joinHistory`, `answer`, `inboxOk` and `knownError` are all already in the file from Task 12; nothing new is imported.)

- [ ] **Step 19: The upkeep prunes the list** — two edits in `services/api/index.mjs` (as Task 11 left it).

Find:

```js
import { createInboxStore, RETENTION_MS } from './lib/inbox/store.mjs';
```

Replace with:

```js
import { createInboxStore, RETENTION_MS, CANDIDATE_KEEP_MS, DISMISSED_KEEP_MS } from './lib/inbox/store.mjs';
```

Find:

```js
      const retention = inboxStore.retentionPurge(t - RETENTION_MS);
      const counts = {
        excludedOut,
        purgedChats: retention.leads,
        purgedMessages: retention.messages,
        codeRows: inboxStore.pruneCodeRows(t - CODE_ROW_TTL_MS),
        interrupted: inboxStore.markStalePending(t - INTERRUPTED_SEND_MS),
        caughtUp: 0,
        caughtUpStored: 0,
      };
```

Replace with:

```js
      const retention = inboxStore.retentionPurge(t - RETENTION_MS);
      // The owner's list of real-estate chats to check (D17): an open one 30 days after its
      // last property message, a dismissed one a year after he dismissed it.
      const candidates = inboxStore.pruneCandidates({ openBefore: t - CANDIDATE_KEEP_MS, dismissedBefore: t - DISMISSED_KEEP_MS });
      const counts = {
        excludedOut,
        purgedChats: retention.leads,
        purgedMessages: retention.messages,
        codeRows: inboxStore.pruneCodeRows(t - CODE_ROW_TTL_MS),
        interrupted: inboxStore.markStalePending(t - INTERRUPTED_SEND_MS),
        candidatesExpired: candidates.open,
        dismissalsExpired: candidates.dismissed,
        caughtUp: 0,
        caughtUpStored: 0,
      };
```

- [ ] **Step 20: Run, then the hostile-input render scripts**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/dashboard-render-inbox.test.mjs api/test/dashboard-inbox.test.mjs api/test/inbox-wiring.test.mjs api/test/dashboard-routes.test.mjs`
Expected: PASS, 0 fail.

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node api/test/dashboard-hostile.mjs && node api/test/dashboard-regression.mjs`
Expected: the last lines are `ALL PAGES RENDER CLEAN UNDER HOSTILE INPUT` and `ALL REGRESSION CHECKS PASS`.

- [ ] **Step 21: Run the full suite**

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail — 16 more tests than after Part B (930 → 946).

- [ ] **Step 22: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add services/api/lib/dashboard/render-inbox.mjs services/api/lib/dashboard/render.mjs services/api/lib/dashboard/routes.mjs services/api/index.mjs services/api/test/dashboard-render-inbox.test.mjs services/api/test/dashboard-inbox.test.mjs services/api/test/inbox-wiring.test.mjs
git commit -m "dashboard: the owner's real-estate chats to check — on his Unsure tab, moved in or marked not a client (D17)

The Unsure tab gains the candidates (name or masked number, words, times,
count, who wrote last) and both tab labels count the one list it shows. Move
makes an owner_added lead, puts it in and pulls 30 days, and refuses a row
with no phone number; Not a client keeps only its ids. Owner-only, audited by
ids. A candidate that became a lead, or whose number is a colleague's or on
the never list, is never shown; never-list and team adds, Add chat and Move
on a lead remove it. The daily upkeep prunes the list.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Part D — the privacy page and the README

- [ ] **Step 23: Write the failing test** — append to the end of `scripts/test/privacy-policy.test.mjs` (Task 13):

```js

test('the chats kept only to be checked are named: what is kept, for how long, and that the conversation is not (D17)', () => {
  const s = section('whatsapp-conversations');
  assert.ok(s, 'the section is missing');
  const en = body(s, 'en');
  assert.match(en, /looks like a property enquiry/);
  assert.match(en, /the property words it used/);
  assert.match(en, /until 30 days after the last such message/);
  assert.doesNotMatch(en, /for up to 30 days/, 'a chat that keeps writing is kept as long as it does');
  assert.match(en, /The conversation itself is not stored unless/);
  assert.match(en, /for up to a year/);
  const ar = body(s, 'ar');
  assert.match(ar, /استفساراً عقارياً/);
  assert.match(ar, /الكلمات العقارية/);
  assert.match(ar, /حتى ثلاثين يوماً من آخر رسالة من هذا النوع/);
  assert.match(ar, /ولا تُحفظ المحادثة نفسها/);
  assert.match(ar, /مدةً أقصاها سنة/);
});
```

- [ ] **Step 24: Run to see it fail**

Run: `cd /home/azoz778/bona-wt/team-inbox && node --test scripts/test/privacy-policy.test.mjs`
Expected: FAIL — `ℹ pass 3`, `ℹ fail 1`: the new test, at its first `looks like a property enquiry` match.

- [ ] **Step 25: The privacy page** — in `src/data/privacy.json`, in the `whatsapp-conversations` section as Task 13 left it, a second paragraph in each language, right after the first (the shape test needs the same number of paragraphs in both).

Find the end of the first English paragraph:

```json
the messages we stored from it are deleted straight away.",
```

Replace with:

```json
the messages we stored from it are deleted straight away.",
          "There is one narrow exception. When a message on our number looks like a property enquiry but does not make clear that it is for Bona, we keep only the number, the name WhatsApp shows for it and the property words it used (such as “villa” or “for rent”), until 30 days after the last such message, so that the owner of Bona can check whether it is a Bona enquiry. The conversation itself is not stored unless he adds it to the Bona inbox. If he marks it as not a Bona client, only the number, or the id WhatsApp gives the chat, is kept, for up to a year, so that it is not shown to him again.",
```

Find the end of the first Arabic paragraph:

```json
حُذفت الرسائل التي حفظناها منها فوراً.",
```

Replace with:

```json
حُذفت الرسائل التي حفظناها منها فوراً.",
          "وهناك استثناء محدود: إذا بدت رسالة على رقمنا استفساراً عقارياً دون أن يتضح أنها موجّهة إلى بونا، لا نحتفظ منها إلا بالرقم، والاسم الذي يُظهره واتساب له، والكلمات العقارية الواردة فيها (مثل «فيلا» أو «للإيجار»)، وذلك حتى ثلاثين يوماً من آخر رسالة من هذا النوع، ليتحقق مالك بونا مما إذا كانت استفساراً لدى بونا. ولا تُحفظ المحادثة نفسها ما لم يُضفها إلى صندوق محادثات بونا. وإذا حدّد أنها لا تخص عميلاً لبونا، لا نحتفظ إلا بالرقم أو بمعرّف واتساب للمحادثة، مدةً أقصاها سنة، حتى لا تُعرض عليه مجدداً.",
```

(The first paragraph's "Private chats on the same number are not stored" stays true of the conversations themselves; the new paragraph, which follows it at once, names the one thing that is kept.)

- [ ] **Step 26: README** — three edits in `services/README.md`, in what Task 13 wrote under `### Dashboard`.

(a) Find the line that starts `- *Never*: team numbers and the never-a-client list are not matched, stored or shown.` and insert, directly above it:

```markdown
- *Real-estate chats to check* (D17): a chat with no lead behind it whose message uses
  property words (`propertyWordsIn`: villa, apartment, rent, land, فيلا, شقة, للإيجار, أرض,
  عقار …) or a property-document word (brochure, price list, بروشور …), in either direction,
  or a document of the owner's that names TK, goes on a second list on the owner's
  **Unsure** tab (`inbox_candidates`) — so does every property document he sends that did
  not join (one that names Bona, or a name cut too close to the word). Only a chat with a
  phone number: never a lid alone or a WhatsApp channel. Kept: the number and jid (and lid),
  the name WhatsApp shows for the client (never the name on a message the owner sent), the
  property words, first and last time, how many messages and who wrote last — never the
  text, never a lead, no note to anyone — until 30 days after its last such message.
  *Move to Bona inbox* makes it an `owner_added` lead, puts it `in` and pulls its last 30
  days; *Not a client* keeps only its ids, so it is not listed again. A chat that becomes a
  lead leaves the list, team and never-list numbers are never on it, and staff never see
  it. This is how TK clients who write to this number stay out of the inbox: nothing joins
  without a sure signal.
```

(b) Find the sentence that ends the *Polling and upkeep.* paragraph:

```markdown
history comes back empty stays empty and is asked again on the next run.
```

Replace with:

```markdown
history comes back empty stays empty and is asked again on the next run. The upkeep also
prunes the real-estate chats to check: an open one 30 days after its last property message, a
dismissed one a year after it was dismissed (`candidatesExpired`, `dismissalsExpired` in the
`inbox.maintenance` line).
```

(c) In the route table, find the row that starts ``| `POST /v1/admin/inbox/add` |`` and insert, directly below it:

```markdown
| `POST /v1/admin/inbox/candidates/:candId/move` · `…/dismiss` | owner: a real-estate chat to check → *Move to Bona inbox* (an `owner_added` lead, `in`, pulls 30 days, off the list; a team or never-list number is refused `excluded` and taken off) · *Not a client* (off the list; kept dismissed for a year so it is not listed again) |
```

- [ ] **Step 27: Run the test, check the JSON and the README**

Run: `cd /home/azoz778/bona-wt/team-inbox && node --test scripts/test/privacy-policy.test.mjs`
Expected: PASS (4 tests, `ℹ fail 0`).

Run: `cd /home/azoz778/bona-wt/team-inbox && node -e "const p = JSON.parse(require('fs').readFileSync('src/data/privacy.json', 'utf8')); const s = p.sections.find((x) => x.id === 'whatsapp-conversations'); console.log(s.body.en.length, s.body.ar.length)"`
Expected: `4 4`.

Run: `cd /home/azoz778/bona-wt/team-inbox && grep -c -e '^- \*Real-estate chats to check\* (D17)' -e 'prunes the real-estate chats to check' -e '^| `POST /v1/admin/inbox/candidates/:candId/move`' services/README.md`
Expected: `3`.

- [ ] **Step 28: Run the suites**

Run: `cd /home/azoz778/bona-wt/team-inbox && node --test $(ls scripts/test/*.test.mjs | grep -v -e approval-package -e social-quality)`
Expected: all pass, `ℹ fail 0` — one test more than after Task 13 (the two left out need `sharp`, which this worktree does not install; see Task 13).

Run: `cd /home/azoz778/bona-wt/team-inbox/services && node --test api/test/*.test.mjs`
Expected: all pass, 0 fail — the same count as after Part C.

- [ ] **Step 29: Commit**

```bash
cd /home/azoz778/bona-wt/team-inbox && git add scripts/test/privacy-policy.test.mjs src/data/privacy.json services/README.md
git commit -m "Privacy page and README: the real-estate chats kept only for the owner to check (D17)

For a message that looks like a property enquiry but is not clearly for
Bona, only the number, the WhatsApp name and the property words are kept,
until 30 days after the last such message; the conversation is not stored
unless the owner moves it in, and a chat he marks not a client keeps only
its number for a year.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Controller notes for Task 16 (binding; from the Task 11–14 reviews)
- Review fixes after this text was drafted moved several anchors: the upkeep block in `services/api/index.mjs` (Task 11 fixes 10c373c/1accb15: each step runs on its own, never rejects), the count assertions in `test/inbox-wiring.test.mjs`, the privacy section in `src/data/privacy.json` and its test, and the README Inbox paragraphs (Task 13 fixes 5c6f166/1b90e96, Task 14 48b965a). Find the equivalent place in the code as it is now and make the same change; keep the upkeep's "each step on its own, never rejects, counts only" style for the new prune step.
- The privacy page and README currently say (section 10 of privacy.json / the README privacy boundary) that everything else the poller sees is never written to disk. Candidates make that partly untrue: reword it in EN and AR to say that, for a message that looks like a property enquiry but is not clearly for Bona, only the chat's number, the name WhatsApp shows and the property words are kept until 30 days after the last such message (a dismissed chat keeps only its ids for a year) — and update the privacy test to match.
- Set `updated` in privacy.json to the day this task is committed (2026-09-29 or later).
- Task 15's owner answer (brochure alone; the other document words only next to a property noun / listing id / link) is binding: the `'property document'` candidate marker uses `PROPERTY_DOC_RE` (the union), so a qualified-word document that did not join still reaches the Unsure list. Add a poller test for `Price List Sep.pdf` sent by the owner to a stranger → candidate with `'property document'`, no lead.

---

### Task 17: Reviews, migration rehearsal, ship Phase 2, STOP for the owner

**Files:** none new (fixes from the reviews land in the files they concern, each with a test).

- [ ] **Step 1: Full suite on the finished branch**

Run: `cd ~/bona-wt/team-inbox/services && node --test api/test/*.test.mjs 2>&1 | tail -8`
Expected: `fail 0`; the pass count is 622 plus every test Phase 2 added.

- [ ] **Step 2: Rehearse migration v4 on the live SCHEMA (client data never leaves the VPS)**

Copying the live db is not allowed, so dump only its schema, read-only, rebuild it locally with one synthetic lead per live class, and migrate that with the branch's `openDb`:
```bash
SP=/tmp/claude-1001/-mnt-c-Users-ASUS/46575771-95e9-46bf-9b61-ed963502e756/scratchpad
ssh hermes-vps '/home/azoz/.local/opt/node-v24.19.0-linux-x64/bin/node --input-type=module -e "
import { DatabaseSync } from \"node:sqlite\";
const db = new DatabaseSync(process.env.HOME + \"/bona-data/bona.db\", { readOnly: true });
console.log(JSON.stringify({ version: db.prepare(\"PRAGMA user_version\").get().user_version,
  objects: db.prepare(\"SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE ? ORDER BY rowid\").all(\"sqlite_%\") }));
" 2>/dev/null' > $SP/live-schema.json
cat > $SP/rehearse-v4.mjs <<'EOF'
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [schemaFile, file] = process.argv.slice(2);
const { version, objects } = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
fs.rmSync(file, { force: true });
const raw = new DatabaseSync(file);
for (const o of objects.filter((x) => x.type === 'table')) raw.exec(o.sql);
for (const o of objects.filter((x) => x.type !== 'table')) raw.exec(o.sql);
raw.exec(`PRAGMA user_version = ${version}`);
const lead = raw.prepare('INSERT INTO leads (lead_id, created, updated, phone_e164, wa_jid, wa_lid, channel, match_method, legacy_id, stage) VALUES (?,?,?,?,?,?,?,?,?,?)');
const tp = raw.prepare('INSERT INTO touchpoints (id, lead_id, ts, channel, event_type, meta) VALUES (?,?,?,?,?,?)');
const rows = [
  ['L-ad', 'whatsapp', 'ad_meta', null, '{"snippet":"hello"}'],
  ['L-ref', 'whatsapp', 'ref', null, '{"snippet":"Ref BONA-W003 · K7Q2XR"}'],
  ['L-kw', 'whatsapp', 'keyword', null, '{"snippet":"is this bona?"}'],
  ['L-kwid', 'whatsapp', 'keyword', null, '{"snippet":"about bona-w012 please"}'],
  ['L-tw', 'whatsapp', 'time_window', null, '{"snippet":"hi"}'],
  ['L-legacy', 'form', 'form', 'LEG-1', null],
  ['L-badjson', 'whatsapp', 'keyword', null, 'not json'],
];
rows.forEach(([id, channel, mm, legacy, meta], i) => {
  lead.run(id, 1_790_000_000_000 + i, 1_790_000_000_000 + i, `96650000000${i}`, `96650000000${i}@s.whatsapp.net`, `1${i}@lid`, channel, mm, legacy, 'new');
  tp.run(`tp-${id}`, id, 1_790_000_000_000 + i, channel, 'lead_created', meta);
});
raw.close();
const { openDb } = await import(process.env.HOME + '/bona-wt/team-inbox/services/api/lib/db.mjs');
const s = openDb(file);
const out = {
  from: version,
  to: s.db.prepare('PRAGMA user_version').get().user_version,
  states: Object.fromEntries(s.db.prepare('SELECT lead_id, inbox_state FROM leads ORDER BY lead_id').all().map((r) => [r.lead_id, r.inbox_state])),
  since: s.db.prepare("SELECT COUNT(*) n FROM leads WHERE inbox_state = 'in' AND inbox_since = created").get().n,
  tables: s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('wa_messages','wa_outbox','inbox_reads','wa_gaps','inbox_candidates') ORDER BY name").all().map((r) => r.name),
  sessionsKept: s.db.prepare('SELECT COUNT(*) n FROM auth_sessions').get().n,
};
s.close();
fs.rmSync(file, { force: true }); fs.rmSync(`${file}-wal`, { force: true }); fs.rmSync(`${file}-shm`, { force: true });
console.log(JSON.stringify(out));
EOF
node $SP/rehearse-v4.mjs $SP/live-schema.json $SP/rehearse.db 2>&1 | grep -v ExperimentalWarning
```
Expected: `{"from":3,"to":4,"states":{"L-ad":"in","L-badjson":"unsure","L-kw":"unsure","L-kwid":"in","L-legacy":"unsure","L-ref":"in","L-tw":"unsure"},"since":3,"tables":["inbox_candidates","inbox_reads","wa_gaps","wa_messages","wa_outbox"],"sessionsKept":0}`. Any SQL error here stops the ship: fix the migration (a NEW commit on this branch), re-run Steps 1–2. (Task 14's replies switch needs no migration: with no `settings` row, `inbox_replies` reads as its default `'0'`.)

- [ ] **Step 3: Claude review** — use superpowers:requesting-code-review on `git diff origin/main...HEAD -- services/ src/data/privacy.json`. Focus: (1) a guessed/unsure/out/never-list/team chat can never be read or sent to; (2) staff cannot reach Unsure, move, out or add; (3) every send passes the one sender's gate (switch, 20/min, 6/min per recipient, 30/min per user, durable 500/day) and an uncertain send is never retried; (4) the history floor (A1) holds on every per-chat read; (5) no message text, phone number, name or code in logs, audit meta, URLs or redirects; (6) migration v4 on the live schema; (7) `first_reply_ts` behaviour the Hermes watchdog depends on; (8) the poller's no-silent-loss read and cursor; (9) no reply can reach a client while `settings.inbox_replies` is not `'1'` (Task 14: it ships `'0'`; `sender.reply` refuses before writing, the thread draws no box, only an owner can switch it, and login codes do not depend on it).

- [ ] **Step 4: Codex review** (second opinion, owner rule):
```bash
cd ~/bona-wt/team-inbox && codex exec --sandbox read-only "Review the diff origin/main...HEAD in services/ and src/data/privacy.json (Bona dashboard Phase 2: WhatsApp inbox). Spec: docs/superpowers/specs/2026-09-27-dashboard-team-inbox-design.md section 4; plan: docs/superpowers/plans/2026-09-27-dashboard-team-inbox.md '## Phase 2 — detailed' (decisions P2-1..P2-21 and amendments A1-A7). Look for: a message sent to a chat that is not 'in', to a team or never-list number, to a lid-only chat or a group, or without the shared gate; a double send (idempotency, uncertain retried, poller/outbox reconciliation mistakes); a reply that can reach a client while settings.inbox_replies is not '1' (it ships '0' and only the owner may switch it on, design D14); staff reaching owner-only inbox actions; unsure/out/never-list transcripts readable; history older than the floor stored; message text, phone numbers, names or codes in logs/audit/URLs; migration v4 failing or misclassifying on an existing bona.db; the poller losing records (readWindow split, cursor) or changing first_reply_ts semantics; SQL injection or XSS in the new pages. Verdict first, then findings ranked by severity with file:line and a fix."
```

- [ ] **Step 5: Fix what is real, report the disagreement.** For each finding from either model: reproduce with a failing test, fix, re-run the suite. Write down which model found what and where they disagree (kept for the owner's report and the memory file). Commit each fix with the trailer.

- [ ] **Step 6: PR and squash-merge**
```bash
cd ~/bona-wt/team-inbox && git fetch origin && ROLLBACK=$(git rev-parse origin/main) && echo "rollback=$ROLLBACK"
git push -u origin feat/team-inbox-p2
gh pr create --base main --head feat/team-inbox-p2 --title "Dashboard: Bona WhatsApp inbox (Phase 2)" --body "Phase 2 of docs/superpowers/specs/2026-09-27-dashboard-team-inbox-design.md (§4): certain-match chats join a team inbox (unsure list, owner-started chats, never list), transcripts stored for inbox chats only (5-year retention), replies from the owner's number through the one sender (outbox, send_id idempotency, uncertain never retried, stale-view guard, lid-only refused, durable day cap, 30/min per person), no-silent-loss poller reads, privacy page. Dashboard replies ship switched off (Team page switch the owner turns on for the first send, D14). Schema v4 (additive). Claude + Codex reviewed. Rollback point: ${ROLLBACK}.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge --squash --delete-branch=false
git fetch origin && git log --oneline -1 origin/main
```
Expected: the PR merges; `origin/main` is the squash commit. If main moved since the branch was cut and the merge conflicts, rebase onto a NEW branch name (force-push is not allowed), re-run Steps 1–2, and open the PR from that branch.

- [ ] **Step 7: Back up the live db — consistently (WAL included)**
```bash
ssh hermes-vps 'cd ~/bona-data && STAMP=$(date +%Y%m%d-%H%M%S) && /home/azoz/.local/opt/node-v24.19.0-linux-x64/bin/node --input-type=module -e "
import { DatabaseSync } from \"node:sqlite\";
const db = new DatabaseSync(\"bona.db\");
db.exec(\"VACUUM INTO \x27bona.db.snap-$STAMP\x27\");
db.close();" 2>/dev/null && chmod 600 bona.db.snap-$STAMP && ls -la bona.db.snap-$STAMP'
```
Expected: one new `bona.db.snap-<stamp>` of roughly the live size, mode `-rw-------`.

- [ ] **Step 8: Poll every 20 s on the VPS** (the env file pins 45 s, so the new code default alone changes nothing there)
```bash
ssh hermes-vps 'F=~/.secrets/bona-services.env; cp -p $F $F.bak-$(date +%Y%m%d) && sed -i "s/^BONA_WA_POLL_MS=45000$/BONA_WA_POLL_MS=20000/" $F && grep -c "^BONA_WA_POLL_MS=20000$" $F && stat -c %a $F'
```
Expected: `1` then `600`.

- [ ] **Step 9: Deploy**
Run: `ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh`
Expected: tests green on the VPS, restart, healthy `/health`. A red run leaves the old process running — stop and fix.

- [ ] **Step 10: Verify live** (read-only checks, no code requested for anyone)
```bash
curl -s https://api.bona-real-estate.com/health | head -c 600; echo
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://api.bona-real-estate.com/dashboard/inbox
ssh hermes-vps 'journalctl -u bona-api --since "-10 min" --no-pager | grep -oE "\"evt\":\"(wa\.poll\.[a-z_]+|inbox\.[a-z_.]+|wa\.send\.[a-z_]+)\"[^}]{0,120}" | tail -20'
ssh hermes-vps '/home/azoz/.local/opt/node-v24.19.0-linux-x64/bin/node --input-type=module -e "
import { DatabaseSync } from \"node:sqlite\";
const db = new DatabaseSync(process.env.HOME + \"/bona-data/bona.db\", { readOnly: true });
console.log(JSON.stringify({ v: db.prepare(\"PRAGMA user_version\").get().user_version,
  states: db.prepare(\"SELECT inbox_state, COUNT(*) n FROM leads GROUP BY 1\").all(),
  messages: db.prepare(\"SELECT COUNT(*) n, COUNT(DISTINCT lead_id) chats FROM wa_messages\").get(),
  outbox: db.prepare(\"SELECT sender_kind, status, COUNT(*) n FROM wa_outbox GROUP BY 1,2\").all(),
  replies: db.prepare(\"SELECT value FROM settings WHERE key = ?\").get(\"inbox_replies\")?.value ?? null }));
" 2>/dev/null'
~/.claude/scripts/chrome-debug.sh
node ~/.claude/scripts/browse.mjs https://api.bona-real-estate.com/dashboard/login /tmp/claude-1001/p2-login.png
gh run list --workflow deploy.yml --limit 1
node ~/.claude/scripts/browse.mjs https://bona-real-estate.com/privacy/ --text | grep -i -A3 whatsapp | head -20
node ~/.claude/scripts/browse.mjs https://bona-real-estate.com/ar/privacy/ --text | grep -A3 "واتساب" | head -20
```
Expected: health ok with `poller.running: true` and a small `lagS`; `/dashboard/inbox` signed out → `302 …/dashboard/login`; logs show `wa.poll.init` with `everyMs: 20000`, `inbox.catchup` counts and no `wa.poll.failed`; `v: 4`, states `in 18 / unsure 9` (plus any lead that arrived since), `messages.chats` > 0 after the catch-up; `replies: null` (no row, so the shipped default `'0'`: nobody can reply from the dashboard yet) and no `staff` row in `outbox`; the login page renders; the site deploy run succeeded and both privacy pages carry the new WhatsApp section. If `replies` is `'1'` or `outbox` has a `staff` row, replies were switched on or a reply was attempted before the owner was asked: stop and tell him at once.

- [ ] **Step 11: STOP — the first real client message is sent with the owner (D14).** Replies are off until he turns them on (Task 14), so nothing can go before this step. Tell the owner, mobile-short: Phase 2 is live (what staff now see: the inbox, read-only for now; the Unsure list; the rollback SHA), replies from the dashboard are OFF until he switches them on, and ask to do the first send together from his second phone: (1) he opens `https://api.bona-real-estate.com/dashboard/inbox` on his phone and confirms the list looks right; (2) from his second phone he sends his own number a message containing a site Ref line (or a listing id); (3) within about a minute it shows in the inbox, and the thread says "Replies from the dashboard are not switched on yet"; (4) he opens the Team page and taps **Turn replies on** under *Replies to clients from the dashboard*. Only he does this: Claude has no owner session, and a switch is never flipped by writing to the live db. (5) He (or I, on his "go") replies from the thread; (6) it arrives on the second phone from his number. Note whether that chat is `@lid` (it proves delivery to a lid-addressed chat through its phone number). (7) Check the lead's `first_reply_ts` is stamped and the audit log has one `setting` row (`inbox_replies`, `1`, his user id) and one `reply_sent`. (8) He decides whether replies stay on for the team now; if not, he taps **Turn replies off** again. Record his choice. Do not send any dashboard message to a real client before this.

- [ ] **Step 12: Memory and handoff** — update Claude memory `bona-dashboard-team-inbox-2026-09-27.md` (status, main SHA, rollback, backups, review disagreements, gotchas, whether dashboard replies were left on or off after the first send) and its `MEMORY.md` line, and the shared-memory handoff (same id: `--scope claude-project:fed94f6b4de219192b28 --id bona-dashboard-team-inbox-handoff`).
