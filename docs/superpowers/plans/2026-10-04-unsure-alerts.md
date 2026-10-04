# Bona dashboard — "new chat to check" alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an owner's phone says "Bona: new chat to check" within a minute of a stranger writing on the owner's number in a way that lands the chat in the Unsure list; the tap opens that chat at the top of the Unsure page; the owner's *Move to Bona inbox* tap makes it a Bona chat and Dana answers the waiting message within a minute.

**Architecture:** the poller's `inboxAfterInbound` gains a hook for a lead entering `unsure`; `lib/alerts.mjs` gains the reason `check` (owners only, lead must be `unsure`) and remembers each owner's newest check in memory; the service worker asks `GET /dashboard/push/latest` which of its two fixed notifications to show; `GET /dashboard/push/open` lands an owner on `/dashboard/inbox?tab=unsure&focus=<id>` when their check is newer than their unread inbox messages; the three owner joins wake Dana when the chat's newest unanswered client message is under 6 hours old.

**Tech stack:** Node 24 built-ins, `node:sqlite`, `node:test`; Service Worker Push API; no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-04-unsure-alerts-design.md` (U1–U6, binding). Base: the 2026-09-27 design and plan (P3-x, P4-x decisions). Branch `feat/unsure-alerts` from `origin/main` 20d81aa, worktree `~/bona-wt/team-inbox`. Test command: `cd ~/bona-wt/team-inbox/services && node --test api/test/*.test.mjs` (write the baseline count in Task 1 Step 0). Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Ground rules of the 2026-09-27 plan apply (never log a number/name/text; stage files by name; never restart bona-api on the PC; deploy only via `deploy.sh`).

## Interface contract

**`lib/alerts.mjs`**
- `REASONS = inbound | needs_human | check`. `notify(leadId, { reason: 'check', ts })`: the lead must be `unsure` and not excluded (else `{ skipped: 'not_unsure' }`); recipients = every active user with `role = 'owner'` (never `exceptUserId`-filtered differently); the 2-minute mark and the 30-minute freshness as for `inbound`; every owner due is remembered: `checks.set(userId, { leadId, ts: now })` (in memory); `push.sent { reason: 'check', … }`.
- `pendingCheck(userId) → { leadId, ts } | null` — the remembered check, only while that lead is still `unsure` (otherwise it is forgotten and `null` comes back).
- `recipients(lead, { reason: 'check' })` → active owners' ids.

**`lib/wa-poller.mjs`** — `createPoller({ …, onUnsureLead = null })`: called `onUnsureLead(leadId, ts)` (not awaited; a throw is a `poll.alert_failed` warn with the lead id only) inside `inboxAfterInbound` when `next === 'unsure'` and `lead.inbox_state !== 'unsure'` (the chat enters the Unsure list from the client's side). Never on a join, never for a repeat message of an Unsure chat, never from the owner's side.

**`index.mjs`** — poller option `onUnsureLead: (leadId, ts) => { alerts.notify(leadId, { reason: 'check', ts }); }`.

**`lib/dashboard/routes.mjs`**
- `export const MOVE_ANSWER_WINDOW_MS = 6 * 3_600_000`.
- `WORKER_CSP = "default-src 'none'; connect-src 'self'; img-src 'self'"`.
- `GET /dashboard/push/latest` (signed in; otherwise `401 { error: 'unauthorised' }`) → `200 { kind: 'check' | 'inbound' }`. `check` when the member is an owner, `alerts.pendingCheck(me.user_id)` exists, and its `ts` is greater than the newest `last_msg_ts` among the member's inbox rows with `unread > 0` (0 when none).
- `GET /dashboard/push/open`: with kind `check` → `302 /dashboard/inbox?tab=unsure&focus=<leadId>`; else as today.
- Unsure tab: `focus` query parameter (`/^[A-Za-z0-9_-]{1,64}$/`, else ignored) passed to `unsurePage`.
- `wakeDanaAfterJoin(leadId) → boolean`: after `joinHistory` in `inboxMove`, `candidateMove`, `inboxAdd`: when `app.dana?.answer` exists and `inbox.unansweredClientMessages(leadId, { limit: 1 })` has a message with `ts >= now() - MOVE_ANSWER_WINDOW_MS` → `app.dana.answer(leadId, { ts: now() })` (not awaited) and `log({ evt: 'dash.dana_woken', leadId })`, returns true; else false.

**`lib/dashboard/render-inbox.mjs`** — `unsurePage({ …, focus = null })`: the row whose `lead_id === focus` is drawn first with class `lr ix focus` and a `<span class="pl hot">new chat to check</span>` pill after its name.

**`lib/dashboard/assets/sw.js`** — `push`: `event.waitUntil(latestKind().then(show))`; `latestKind()` = one `fetch('/dashboard/push/latest', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(2000) })` → `'check'` only for `{ kind: 'check' }`, anything else (non-2xx, timeout, throw) → `'inbound'`; notifications: check → title `Bona: new chat to check`, body `Someone new wrote to you. Tap to decide.`, tag `bona-check`; inbound → `New Bona message`, `A client wrote in the Bona inbox.`, tag `bona-inbox`; both `icon: '/dashboard/icon-192.png'`, `renotify: true`. Still no `fetch` listener, no `caches`, no `importScripts`; `notificationclick` unchanged.

---

### Task 1: Alerts reason `check`, the poller hook, the wiring

**Files:** modify `services/api/lib/alerts.mjs`, `services/api/lib/wa-poller.mjs`, `services/api/index.mjs`; tests `services/api/test/alerts.test.mjs`, `services/api/test/wa-poller.test.mjs`, `services/api/test/inbox-wiring.test.mjs`.

- [ ] **Step 0: Baseline** — `cd ~/bona-wt/team-inbox/services && node --test api/test/*.test.mjs 2>&1 | tail -4`; write the pass count here: 1196 (2026-10-04, fail 0). (main moved since Phase 4; the count may differ from 1196.)

- [ ] **Step 1: Failing tests**

`test/alerts.test.mjs` (read its harness first — it builds `createAlerts` over an in-memory store with a fake pusher, seeds users/sessions/subscriptions; use its helpers):
```js
test("reason 'check': an Unsure chat alerts active owners only, once per 2 min, and is remembered until the chat leaves Unsure", async () => {
  // owner + staff, each with a live session and one device; a lead in Unsure (no handler)
  const h = harness(); // adapt: must yield { alerts, db, pushes, owner, staff, lead } with lead.inbox_state = 'unsure'
  const out = await h.alerts.notify(h.lead.lead_id, { reason: 'check', ts: NOW - 1000 });
  assert.deepEqual(out, { users: 1, devices: 1, ok: 1, gone: 0, failed: 0 });
  assert.deepEqual(h.pushes.map((p) => p.endpoint), [h.ownerEndpoint], 'the owner only, never staff');
  assert.deepEqual(h.alerts.pendingCheck(h.owner.user_id), { leadId: h.lead.lead_id, ts: NOW });
  assert.equal(h.alerts.pendingCheck(h.staff.user_id), null);
  assert.deepEqual(await h.alerts.notify(h.lead.lead_id, { reason: 'check', ts: NOW }), { skipped: 'quiet' }, 'one per chat per owner per 2 min');
  h.db.updateLead(h.lead.lead_id, { inbox_state: 'in' });
  assert.equal(h.alerts.pendingCheck(h.owner.user_id), null, 'forgotten once the chat is no longer Unsure');
  assert.deepEqual(await h.alerts.notify(h.lead.lead_id, { reason: 'check', ts: NOW }), { skipped: 'not_unsure' }, 'an in chat is not a check');
  assert.ok(h.logs.some((l) => l.evt === 'push.sent' && l.reason === 'check' && l.users === 1));
  assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(h.ownerEndpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
test("reason 'check' keeps the freshness rule and the excluded rule", async () => {
  const h = harness();
  assert.deepEqual(await h.alerts.notify(h.lead.lead_id, { reason: 'check', ts: NOW - 31 * 60_000 }), { skipped: 'old' });
  h.db.updateLead(h.lead.lead_id, { phone_e164: h.staff.phone_e164 });
  assert.deepEqual(await h.alerts.notify(h.lead.lead_id, { reason: 'check', ts: NOW }), { skipped: 'not_unsure' }, 'a colleague\'s number is never a chat to check');
});
test('recipients for check are the active owners, whoever handles the chat', () => {
  const h = harness();
  h.db.updateLead(h.lead.lead_id, { handler_user_id: h.staff.user_id });
  assert.deepEqual(h.alerts.recipients(h.db.getLead(h.lead.lead_id), { reason: 'check' }), [h.owner.user_id]);
  h.team.deactivateUser(h.owner.user_id, …) // adapt: if the harness has no second owner, skip this line; otherwise a deactivated owner is not a recipient
});
```
`test/wa-poller.test.mjs` (its `harness({ inbox: true, history, windows, onClientMessage })` — add `onUnsureLead` passed through like `onClientMessage`):
```js
test('(u) a chat entering the Unsure list from the client\'s side raises one check; a repeat message, a join and the owner\'s side raise none', async () => {
  const checks = [];
  const bona = msg({ id: 'BONA', jid: '966500000009@s.whatsapp.net', ts: NOW - 60_000, text: 'مرحبا بونا' });
  const h = harness({ inbox: true, history: [], windows: [[bona]], onUnsureLead: (leadId, ts) => checks.push([leadId, ts]) });
  await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.inbox_state, 'unsure');
  assert.deepEqual(checks, [[lead.lead_id, NOW - 60_000]]);
  h.push([msg({ id: 'BONA2', jid: '966500000009@s.whatsapp.net', ts: NOW - 30_000, text: 'still bona?' })]);
  await h.poller.tick();
  assert.equal(checks.length, 1, 'already in Unsure: no second check');
  h.push([msg({ id: 'REF', ts: NOW - 20_000, text: 'Ref BONA-W003 · K7Q2XR' })]);
  await h.poller.tick();
  assert.equal(checks.length, 1, 'a chat that joins the inbox is not a check');
  h.push([msg({ id: 'OWN', fromMe: true, jid: '966500000011@s.whatsapp.net', ts: NOW - 10_000, text: 'bona?' })]);
  await h.poller.tick();
  assert.equal(checks.length, 1, 'the owner\'s side never raises a check');
  h.cleanup();
});
test('(u) a check hook that throws is a warn line and changes nothing', async () => {
  const bona = msg({ id: 'BONA', jid: '966500000009@s.whatsapp.net', ts: NOW - 60_000, text: 'مرحبا بونا' });
  const h = harness({ inbox: true, history: [], windows: [[bona]], onUnsureLead: () => { throw new Error('966500000009 boom'); } });
  await h.poller.tick();
  assert.equal(h.leads()[0].inbox_state, 'unsure');
  const line = h.logs.find((l) => l.evt === 'poll.alert_failed');
  assert.equal(line.level, 'warn');
  assert.doesNotMatch(JSON.stringify(line), /966|boom/);
  h.cleanup();
});
```
`test/inbox-wiring.test.mjs` (its `build()`; copy the shape of the Phase 3 push wiring test): the poller stores a `مرحبا بونا` record from an unknown number → the lead is `unsure` → exactly one push, to the OWNER's device (subscribe the owner; also subscribe a staff member and assert that device got nothing); log `push.sent` has `reason: 'check'`; no number/text in logs.

- [ ] **Step 2: Run to see them fail** — `node --test api/test/alerts.test.mjs api/test/wa-poller.test.mjs api/test/inbox-wiring.test.mjs 2>&1 | grep -E "^not ok" | head`.

- [ ] **Step 3: Implement**

`lib/alerts.mjs`: `REASONS` gains `'check'`; a `checks = new Map()`; `recipients`: `if (reason === 'check') users = owners();` where `owners = () => prep("SELECT user_id FROM users WHERE active = 1 AND role = 'owner' ORDER BY user_id").all().map((r) => r.user_id)` (before the `needs_human` branch); in `run`, replace the one state check with:
```js
    const lead = db.getLead(leadId);
    if (why === 'check') {
      // A chat to check lives in the Unsure list (U1); once it joins or leaves, it is no check.
      if (!lead || lead.inbox_state !== 'unsure' || isExcludedLead(lead)) return { skipped: 'not_unsure' };
    } else if (!lead || lead.inbox_state !== 'in' || isExcludedLead(lead)) return { skipped: 'not_in_inbox' };
```
and after `for (const u of due) marks.set(markKey(u, leadId), t);` add `if (why === 'check') for (const u of due) checks.set(u, { leadId, ts: t });`. Add:
```js
  /** The owner's newest "chat to check" alert, while that chat is still in the Unsure list (U4). */
  function pendingCheck(userId) {
    const id = String(userId ?? '');
    const c = checks.get(id);
    if (!c) return null;
    const lead = db.getLead(c.leadId);
    if (!lead || lead.inbox_state !== 'unsure') { checks.delete(id); return null; }
    return { leadId: c.leadId, ts: c.ts };
  }
```
exported; header comment: the `check` reason in one sentence. `notify`'s JSDoc return union gains `'not_unsure'`.

`lib/wa-poller.mjs`: option `onUnsureLead = null` (JSDoc like `onClientMessage`); in `inboxAfterInbound`:
```js
    if (next === 'in' && lead.inbox_state !== 'in') await join(lead.lead_id, ts, 'inbound', tally);
    else if (next && next !== lead.inbox_state) {
      inboxStore.setInboxState(lead.lead_id, next, { since: ts });
      // The chat has just entered the Unsure list from the client's side: the owner is told (U1).
      if (next === 'unsure' && onUnsureLead) {
        try { onUnsureLead(lead.lead_id, ts); } catch { log({ level: 'warn', evt: 'poll.alert_failed', leadId: lead.lead_id }); }
      }
    }
```
`index.mjs`: the poller gets `onUnsureLead: (leadId, ts) => { alerts.notify(leadId, { reason: 'check', ts }); },` next to `onClientMessage` (comment: U1/U2).

- [ ] **Step 4: Run the three files, then the whole suite** → `fail 0`.
- [ ] **Step 5: Commit** — `git add` the six files by name; message `alerts: "new chat to check" — the poller tells the owners when a chat enters the Unsure list`.

---

### Task 2: The worker's two notifications, `push/latest`, `push/open` for a check, the focused Unsure row

**Files:** modify `services/api/lib/dashboard/routes.mjs`, `services/api/lib/dashboard/render-inbox.mjs`, `services/api/lib/dashboard/assets/sw.js`; tests `services/api/test/dashboard-assets.test.mjs`, `services/api/test/dashboard-push.test.mjs`, `services/api/test/dashboard-render-inbox.test.mjs`, `services/api/test/dashboard-inbox.test.mjs`.

- [ ] **Step 1: Failing tests**

`dashboard-assets.test.mjs`: extend the P3-3 test: the source still has no `caches`/`fetch` listener/`importScripts`; it contains exactly one `fetch(` and that call names `'/dashboard/push/latest'` and `credentials: 'include'`; both titles `Bona: new chat to check` and `New Bona message` and both tags appear; `AbortSignal.timeout(2000)`. The `WORKER_CSP` assertion (find it; it asserts the served CSP of `/dashboard/sw.js`) becomes `default-src 'none'; connect-src 'self'; img-src 'self'`.

`dashboard-push.test.mjs` (listening server, `withPush({ config, appOptions })`, login helpers): (a) `GET /dashboard/push/latest` signed out → 401 JSON; signed in as staff → `{ kind: 'inbound' }` with the JSON security headers and `no-store`; (b) seed an `unsure` lead and call `app.alerts.notify(leadId, { reason: 'check', ts: NOW })` with the owner subscribed → owner's `push/latest` → `{ kind: 'check' }`; owner's `push/open` → `302 /dashboard/inbox?tab=unsure&focus=<leadId>`; staff's `push/open` → the inbox as before; (c) then an `in` chat gets an unread client message newer than the check → owner's `push/latest` → `inbound` and `push/open` → that chat; (d) move the unsure lead to `in` (`db.updateLead`) → `push/latest` → `inbound` (the check is forgotten).

`dashboard-render-inbox.test.mjs`: `unsurePage({ me: OWNER, rows: [A, B], focus: B.lead_id })` draws B first with `class="lr ix focus"` and the pill `new chat to check`; without `focus`, the order is as given and no pill; a `focus` that matches nothing changes nothing.

`dashboard-inbox.test.mjs`: owner `GET /dashboard/inbox?tab=unsure&focus=LEAD-U` → 200, LEAD-U's row first with the pill; `focus=../x` → 200 without the pill; staff → 403 as before.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement**

`routes.mjs`: `WORKER_CSP` gains `connect-src 'self'` (comment: the worker's one request, to learn which fixed notification to show — U3); add
```js
  /**
   * Which of the worker's two fixed notifications a push is (U3/U4): an owner's newest "chat
   * to check" while it is newer than their newest unread inbox message; otherwise an inbox
   * message. Decided here, signed in: the push itself carries nothing.
   */
  function alertKind(me) {
    const check = me.role === 'owner' && alerts ? alerts.pendingCheck(me.user_id) : null;
    if (!check) return { kind: 'inbound', check: null };
    const rows = inbox ? inboxRowsFor(me) : [];
    const newestUnread = rows.filter((r) => (Number(r.unread) || 0) > 0).reduce((m, r) => Math.max(m, Number(r.last_msg_ts) || 0), 0);
    return check.ts > newestUnread ? { kind: 'check', check } : { kind: 'inbound', check: null };
  }
  function pushLatest({ res, me }) { return sendJson(res, 200, { kind: alertKind(me).kind }); }
  function pushOpen({ res, me }) {
    const { kind, check } = alertKind(me);
    if (kind === 'check') return redirect(res, `/dashboard/inbox?tab=unsure&focus=${encodeURIComponent(check.leadId)}`, 302);
    const rows = inbox ? inboxRowsFor(me) : [];
    const first = rows.find((r) => (Number(r.unread) || 0) > 0) ?? rows[0] ?? null;
    return redirect(res, first ? `/dashboard/inbox/${encodeURIComponent(first.lead_id)}` : '/dashboard/inbox', 302);
  }
```
Dispatch `GET /dashboard/push/latest` beside `/dashboard/push/open`: signed in → `pushLatest`; signed out → `sendJson(res, 401, { error: 'unauthorised' })` (not the login redirect: the caller is the worker). In `inboxList`'s unsure branch: `const focusRaw = url.searchParams.get('focus'); const focus = /^[A-Za-z0-9_-]{1,64}$/.test(focusRaw ?? '') ? focusRaw : null;` → `unsurePage({ …, focus })`.

`render-inbox.mjs`: `unsureRow(row, now, { focused = false } = {})` → `<div class="lr ix${focused ? ' focus' : ''}">` and after the name span `${focused ? '<span class="pl hot">new chat to check</span>' : ''}`; `unsurePage({ …, focus = null })`: `const ordered = focus ? [...list.filter((r) => r.lead_id === focus), ...list.filter((r) => r.lead_id !== focus)] : list;` and `ordered.map((r) => unsureRow(r, now, { focused: r.lead_id === focus }))`.

`sw.js`: replace the `push` handler with the contract's `latestKind()` + `NOTIFICATIONS` table; header comment updated (one same-origin request per push, never a cache, never an intercept; iOS still always gets a notification).

- [ ] **Step 4: Run the four files, then the whole suite** → `fail 0`.
- [ ] **Step 5: Commit** — `push: the worker shows "Bona: new chat to check" for an owner's Unsure alert; the tap opens that chat first on the Unsure page`.

---

### Task 3: The owner's Move wakes Dana; README

**Files:** modify `services/api/lib/dashboard/routes.mjs`, `services/README.md`; test `services/api/test/dashboard-inbox.test.mjs`.

- [ ] **Step 1: Failing tests** (`dashboard-inbox.test.mjs`; `withInbox` builds the app — pass `appOptions`/inject `app.dana` as a spy `{ configured: true, answer: (id, o) => { calls.push([id, o]); return Promise.resolve({ answered: true }); } }` the way the file injects other doubles; if the harness cannot inject `dana`, set `h.app.dana = spy` after build):
  - Move an Unsure chat whose history (the fake Evolution `findMessages` the harness uses for `joinHistory`) holds a client message stamped 10 minutes ago → `303 …?ok=moved`, `spy` called once with `[leadId, { ts: <now> }]`, log `dash.dana_woken { leadId }` and nothing else in it.
  - Move a chat whose newest client message is 7 hours old → not called.
  - Move a chat whose newest message is the owner's → not called (nothing unanswered).
  - `candidateMove` and `inboxAdd` call it the same way (one case each).
  - Without `app.dana` (older harness) nothing throws.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** in `routes.mjs`:
```js
/** After an owner's join, Dana answers the waiting message only when it is this recent (U5). */
export const MOVE_ANSWER_WINDOW_MS = 6 * 3_600_000;
…
  /**
   * The owner just vouched for this chat (Move, a candidate's Move, Add by number) and its
   * history is in: if the client's newest unanswered message is recent, Dana answers it now
   * under all her own rules (U5). Never awaited; `answer` never rejects. An older message is
   * the team's to answer — a bot must not answer a two-week-old "hi".
   */
  function wakeDanaAfterJoin(leadId) {
    const dana = app?.dana;
    if (!dana || typeof dana.answer !== 'function') return false;
    const waiting = inbox.unansweredClientMessages(leadId, { limit: 1 });
    const newest = waiting.length ? Number(waiting[waiting.length - 1].ts) : NaN;
    if (!Number.isFinite(newest) || newest < now() - MOVE_ANSWER_WINDOW_MS) return false;
    dana.answer(leadId, { ts: now() });
    log({ evt: 'dash.dana_woken', leadId });
    return true;
  }
```
called right after each `await joinHistory(...)` in `inboxMove`, `candidateMove`, `inboxAdd` (the lead id each has in hand).

`services/README.md`: in Inbox → the Unsure paragraph: a new Unsure chat alerts the owners ("Bona: new chat to check"); the tap opens it first on the Unsure page; Move pulls 30 days and, when the client's newest unanswered message is under 6 hours old, Dana answers it within a minute under her usual rules. In Phone alerts: the worker's one same-origin request per push (`/dashboard/push/latest`) and the two fixed notifications; `WORKER_CSP` line updated where the README prints it.

- [ ] **Step 4: Run the file, then the whole suite** → `fail 0`.
- [ ] **Step 5: Commit** — `inbox: an owner's Move wakes Dana for a recent waiting message; README`.

---

### Task 4: Reviews, ship, verify, STOP

- [ ] Step 1: whole suite green. Step 2: Claude whole-branch review (focus: owners only; a staff member can never receive or see a check; `push/latest` leaks nothing but a word; the worker's fetch is same-origin only and a slow/failed fetch still shows a notification; `pushOpen` precedence; the hook never fires for joins/repeats/owner side; the wake respects every Dana rule and the 6 h window; no number/name/text in logs). Step 3: Codex (`codex exec --sandbox read-only - < prompt`). Step 4: fix, re-check both. Step 5: PR → squash-merge → `ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh` (no migration: no backup needed, but take a VACUUM INTO anyway) → verify: `/health` ok, `curl -s -D - https://api.bona-real-estate.com/dashboard/sw.js | grep -i content-security` shows `connect-src 'self'`, `curl https://api.bona-real-estate.com/dashboard/push/latest` → 401, logs clean. The phone picks the new worker up on its next page load (no-store). Step 6: tell the owner; memory + handoff.
