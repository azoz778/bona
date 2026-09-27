# Bona dashboard — team accounts, WhatsApp inbox, phone alerts, Dana on WhatsApp (design, 2026-09-27)

Owner request (2026-09-27): employees log in to the Bona dashboard and answer clients' WhatsApp from it;
suggest other features. Brainstormed with the owner on 2026-09-27 across two sessions (history in
`2026-09-27-dashboard-team-inbox-HANDOVER.md`, same folder). The plan was reviewed by Claude and
Codex before the design was finished; every finding below is folded in.

## 1. Decisions (owner, all confirmed 2026-09-27)

| # | Decision |
|---|---|
| D1 | Staff reply from the owner's **personal number** +966593296933 (Evolution 2.3.7 instance `abdulaziz-personal`). The API now **sends** on this instance (`/message/sendText`). This reverses the old "read-only on this instance" rule; it still never sets a webhook, websocket or queue consumer. |
| D2 | Staff see **inbox chats only** (§4.1). The owner's private chats are never shown or stored. |
| D3 | Staff login = **6-digit code to the employee's own WhatsApp**, sent from the owner's number. |
| D4 | Everyone sees the **same dashboard as the owner**. The only owner-only surface is the **Team page**. |
| D5 | Automatic replies to clients are made by **Dana** inside bona-api (not Lisa). |
| D6 | Alerts = dashboard unread badge + **phone push** (installable PWA, Web Push). Push goes to the chat's handler, or to everyone when there's no handler or the chat needs a human. |
| D7 | **Store transcripts** of inbox chats (in + out, including what the owner types on his phone and what Lisa sends for him). This reverses "never a transcript" for inbox chats only. |
| D8 | Phases: **1 Accounts → 2 Inbox → 3 Phone alerts → 4 Dana on WhatsApp**, each shipped and reviewed separately. **Phase 5 = later list** (§9). |
| D9 | Only **certain** matches join the inbox automatically. Guesses (the word "bona", the ±15-min click window) go to an owner-only **Unsure** list with *Move to Bona inbox* / *Not a client*. Owner can also **Add chat by phone number**. |
| D10 | Owner-only **"never a client" list**: those numbers are never matched, stored or shown. |
| D11 | **Retention: 5 years after the chat's last message** (rolling), then the transcript is deleted automatically. |
| D12 | A chat the **owner starts** joins automatically when he sends a **Bona link, a Bona brochure or a listing number**. Nothing else he types counts (TK and private chats share this number). |
| D13 | Dana answers **immediately** (in practice ≤ ~1 min, the poll interval) in inbox chats; she goes quiet the moment any human replies and **comes back after 24 h without a reply from the team**. |
| D14 | The next session **builds and ships phase by phase** (tests + Claude and Codex review + deploy + tell the owner) and **stops for the owner** (a) before the first real client message is sent from the dashboard and (b) before Dana is switched on, and whenever blocked. |

## 2. Facts that shape the design (verified 2026-09-27)

- **Nothing auto-replies on the personal number today.** `GET /webhook/find/abdulaziz-personal` = `null`;
  websocket/rabbitmq empty; the `evolution-api` container has no global `WEBHOOK_*` env. Lisa (Hermes)
  confirmed that she sends via `sendText`/`sendMedia` (from the VPS, `127.0.0.1:8085`) **only on the owner's
  request**, and reads on demand via `findMessages`. Her sends are `fromMe` records the API cannot tell
  apart from the owner's phone.
- Poller (`services/api/lib/wa-poller.mjs`): polls `findMessages` every `BONA_WA_POLL_MS` = 45 s; 5 match
  rules `ref → phone → ad_meta → keyword → time_window`; `KEYWORD_RE` includes listing ids; unmatched
  records are discarded but marked seen; `fromMe` only stamps `first_reply_ts`; page cap 5 × 100 records
  per window (`wa.poll.truncated` then moves on); a record that fails 3 times is written off.
- Sender (`services/api/lib/wa.mjs#sendText`): owner-only target; `toNumber()` strips the jid suffix, so
  an `…@lid` jid (ad-origin/privacy chats) becomes its opaque digits, which are **not** a phone number;
  the Evolution response body (which carries the message `key.id`) is discarded.
- Auth (`services/api/lib/dashboard/auth.mjs` + `db.mjs`): `auth_codes` is keyed by `sha256(code)` only;
  the browser-nonce binding lives in memory and has no user; `check()` returns a boolean; routes hard-code
  `actor: 'owner'` (`setStage`, notes). Limits: 3 codes/10 min per IP, 1/min and 60/day globally.
- Dashboard responses carry `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src
  'self' data:; form-action 'self'` and `Cache-Control: no-store`: no scripts or service workers today.
- Dana: Retell chat agent `agent_c435e260fdd645681b5b6a07d3` on LLM `llm_e978e39556e56a661a08fcdf0a22`
  (claude-4.6-sonnet), tools `search_properties`/`create_lead` served by bona-api; web-widget output
  (cards, navigate). `lib/budget.mjs` caps Retell chats/day. Never touch Lisa's Retell objects.
- Evolution stores every chat in its own Postgres (`DATABASE_SAVE_DATA_NEW_MESSAGE`). bona.db retention
  does not govern that copy; the privacy page must say so honestly.
- Hermes cron `bona-unanswered-leads` reads `first_reply_ts` from bona.db on the VPS; it must keep working.
- Live runtime: `hermes-vps`, system unit `bona-api`, repo `/opt/bona` (sparse, `bona-repo-sync.timer`
  pulls main every 5 min), data `~/bona-data/bona.db`, deploy
  `ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh` (tests → restart → health; refuses on red).
  bona-api is never restarted on the PC.

## 3. Phase 1 — Team accounts

### 3.1 Data (`db.mjs` migrations, additive)
- `users (user_id PK, name, phone_e164 UNIQUE, wa_jid, role 'owner'|'staff', active, created, last_login, deactivated)`.
  Seeded with the owner from `BONA_OWNER_JID`.
- `auth_challenges (challenge_id PK, user_id, code_hash, nonce_hash UNIQUE, created, expires, attempts, used)`
  replaces `auth_codes` + the in-memory nonce map. A challenge belongs to exactly one user and one browser.
- `auth_sessions` gains `user_id`; migration assigns every existing session to the owner (his login keeps working).
- `audit_log (id PK, ts, user_id, action, target, meta)`: login, logout, code_request (never the code),
  team_add/deactivate/reactivate, never_list add/remove, stage change, note, reply_sent, inbox_move/out/add,
  switch changes, handler changes.
- `never_list (phone_e164 PK, wa_lid, note, added_by, ts)`.
- `settings (key PK, value, updated, updated_by)`: `sending_enabled` (default 1), later `dana_enabled` (default 0).

### 3.2 Login
1. `/dashboard/login` asks for a phone number (Arabic-Indic digits folded, as today).
2. `POST /dashboard/login/code {phone}`: normalise → if an **active** user: create a challenge, set the
   `bona_dash_try` cookie, and send `Bona dashboard code: NNNNNN (valid 10 min)` to **that user's** WhatsApp
   (owner: his own chat, as today). Unknown or inactive number: identical response, nothing sent. The
   response is returned **before** the send completes so timing does not reveal membership.
3. `POST /dashboard/login/verify {code}`: challenge found by nonce → attempts ≤ 5 → user **still active** →
   consume → session with `user_id` → `last_login` + audit.
4. Limits: per phone 3/10 min, per IP 3/10 min, global 6/min and 200/day, all asked before any is charged;
   the code send also passes the shared send gate (§4.5).

### 3.3 Who is signed in
Every protected request resolves the session to an **active user** (`req.user`); a deactivated user's
sessions are deleted and they are redirected to login. All actors come from `req.user`, never from the form:
replace the hard-coded `'owner'` in stage changes and notes.

### 3.4 Team page `/dashboard/team` (owner only; staff get 403 and no nav link)
Add person (name, phone, role), deactivate / reactivate, last login. Deactivation deletes the user's
sessions, pending challenges and (Phase 3) push subscriptions, in one transaction. The last active owner
cannot be deactivated or demoted. Also here: the **never a client** list, the **Sending on/off** switch,
and (Phase 4) **Dana on/off**.

### 3.5 Poller exclusions (ship in Phase 1)
Before classification, the poller drops any record whose chat is a **team member's** number (active or not)
or on the **never list**: not a lead, not stored, not counted as a reply. Staff login codes contain "Bona"
and would otherwise keyword-match.

## 4. Phase 2 — Bona inbox

### 4.1 Which chats (a "chat" is a lead with a WhatsApp jid)
New lead columns: `inbox_state` (`in` | `unsure` | `out` | NULL), `inbox_since`, `handler_user_id`,
`last_msg_ts`, `needs_human` (0/1), plus Phase 4 Dana columns. Eligibility is **stored**, never re-derived
through the `phone` rule, so a guessed lead cannot slip in later.

| Trigger | Result |
|---|---|
| Inbound with a Ref code, ad context (`ad_meta`), or a listing id (`BONA-W###`) | `in` (automatic) |
| Owner outbound (`fromMe`, 1:1, not self) whose text/caption contains a Bona site link (`bona-real-estate.com`, legacy `bona.azoz.uk`), a listing id, or a document whose file name/caption contains "bona" or a listing id | `in` (automatic); creates the lead if new (`match_method = 'owner_outbound'`, channel whatsapp, no campaign) |
| Inbound matched only by the word "bona" or the ±15-min click window | lead as today (stats) with `unsure` |
| Owner taps *Move to Bona inbox* (Unsure list or lead page) / *Add chat by phone number* | `in` |
| Owner taps *Not a client* | `out`: transcript purged now, never re-enters automatically |
| Team number or never-list number | ignored entirely (§3.5) |

Migration for existing leads: `match_method` in (`ref`, `ad_meta`) or a listing id in the first snippet,
or channel web form / Dana concierge → `in`; keyword / time_window / legacy import → `unsure`.

**History on joining:** automatic joins store from the joining message plus the **preceding 24 h** of that
chat (the "Hi" before the Ref code, the owner's opening line). Owner-button joins pull the **last 30 days**
(the owner vouched for the chat). Backfill uses a per-jid `findMessages` query (filter shape verified live
in the first Phase-2 task).

### 4.2 Storage
- `wa_messages (key_id PK, lead_id, jid, direction 'in'|'out', sender_kind 'client'|'staff'|'dana'|'owner_number',
  sender_user_id, text, media_type, ts, status)`. `owner_number` = typed on the owner's phone or sent by Lisa
  (they can't be told apart). Media stored as a type placeholder only (`[voice note]`, `[image]`, `[video]`,
  `[document: name]`, `[location]`, `[contact]`, `[sticker]`) plus caption.
- `wa_outbox (send_id PK, lead_id, jid, text, user_id, sender_kind 'staff'|'dana'|'code'|'note', status
  'pending'|'accepted'|'failed'|'uncertain', key_id, created, updated, error)`. For `code` rows `text` is
  always NULL (a login code is never written anywhere but the WhatsApp message); `note` = the owner's
  new-lead note to his own chat.
- `inbox_reads (user_id, lead_id, last_read_ts, PK(user_id, lead_id))` for unread counts.
- `wa_gaps (key_id PK, lead_id, jid, ts, reason)`: a message that could not be read is shown in the thread
  as "a message could not be loaded — check WhatsApp", never silently dropped.
- Retention job (daily): delete `wa_messages` (+ outbox rows) of chats whose `last_msg_ts` is older than
  5 years; the lead row stays (attribution data). `out` purges immediately.

### 4.3 Poller changes (`wa-poller.mjs`)
- Split `KEYWORD_RE`: listing id → certain; the word "bona"/"بونا" → unsure.
- For `in` chats: upsert every record (in and out) into `wa_messages`; an outbound record whose `key_id`
  matches `wa_outbox.key_id` inherits that row's sender; an `uncertain` outbox row is resolved by a `fromMe`
  record in the same jid with the same text within 2 min.
- `fromMe` in an `in` chat not found in the outbox → `sender_kind = 'owner_number'`; sets the handler to
  the owner when there is none; keeps stamping `first_reply_ts` (the Hermes watchdog depends on it).
- **No silent loss:** a truncated window is split in halves by time and each half fetched oldest-first
  (bounded depth); the cursor only advances past fully read pieces. Records that fail 3 times go to `wa_gaps`.
- Interval lowered to 20 s (`BONA_WA_POLL_MS`), measured against Evolution load in Phase 2. Opening a
  thread also fetches that jid immediately.

### 4.4 Screens (server-rendered, same look as the approved dashboard)
- `/dashboard/inbox`: chat list (unread first, then newest; name/number, last message, stage, handler,
  "Needs a human" badge). Owner additionally sees an **Unsure** tab and **Add chat by phone number**.
- `/dashboard/inbox/:leadId`: thread (bubbles with sender label: client / staff name / Dana / "your number"),
  reply box, handler picker, link to the lead page. Phone = two screens (list → thread).
- Nav gets an unread badge. Without JavaScript the pages work with a manual refresh; `app.js` (Phase 3)
  adds live refresh.

### 4.5 Sending (`lib/wa-send.mjs`, new; used by codes, replies and Dana)
- **Recipient resolution server-side:** client replies only to `in` chats; use the lead's phone jid; an
  `@lid`-only chat is refused ("reply from your phone") unless live testing in Phase 2 proves Evolution
  delivers to `…@lid`. Staff codes only to active users. Never a group, never a fallback target.
- **Shared gate** for every send from the owner's number: `settings.sending_enabled`, a global limiter
  (default 20/min, 500/day), per-recipient 6/min, per-user 30/min; Dana has her own caps (§6).
- **Idempotency:** the reply form carries a random `send_id`; a double submit returns the same outbox row.
  The Evolution response `key.id` is stored. A timeout is `uncertain`: shown as "not sure it went — check
  WhatsApp", **never retried automatically**.
- **Stale-view guard:** the form carries the newest message ts the user saw; if a newer message (either
  direction) exists, the reply is held with "new activity since you opened this chat" and the text kept.
- **Handler:** the first user to reply from the dashboard becomes the handler when there is none; anyone
  can reassign; audit logged.
- The first real client reply from the dashboard happens **with the owner** (D14).

### 4.6 Privacy page (site, AR + EN)
`src/pages/privacy.astro` + `src/pages/ar/privacy.astro`: Bona stores WhatsApp conversations with clients
who contact Bona to serve their enquiry; team members can read and reply; kept up to 5 years after the last
message; an AI assistant (Dana) may reply (Phase 4); contact to request deletion. Ships with Phase 2.

## 5. Phase 3 — Phone alerts
- `/dashboard/manifest.webmanifest`, `/dashboard/sw.js` (scope `/dashboard/`), icons, `/dashboard/app.js`.
  CSP for dashboard pages opens only `script-src 'self'; worker-src 'self'; connect-src 'self'; manifest-src 'self'`.
- The service worker never caches dashboard pages or API responses (`no-store` stays).
- **Turn on alerts** button → `PushManager.subscribe` with the VAPID public key → `POST /dashboard/push/subscribe`.
  `push_subscriptions (id PK, user_id, endpoint UNIQUE, p256dh, auth, created, last_ok, fail_count)`.
- **Payload-less Web Push** (no message body: no RFC 8291 encryption code, no client text through Apple or
  Google): `POST endpoint` with `TTL`, `Urgency: high`, `Authorization: vapid t=<ES256 JWT>, k=<pub>` signed with
  `node:crypto`. The SW always shows a notification (iOS revokes silent pushes): "New Bona message", tap →
  `/dashboard/inbox` (or the chat, from `/dashboard/push/latest`, cookie-authenticated).
- Recipients: new inbound in an `in` chat → handler if set and active, else every active user; `needs_human`
  → everyone; never the user who just sent. Max 1 push per chat per user per 2 min. 404/410 from the push
  service deletes the subscription; deactivation and logout delete the user's subscriptions.
- VAPID keys generated once on the VPS by `bin/vapid-keys.mjs` into `~/.secrets/bona-services.env`
  (`BONA_VAPID_PUBLIC`, `BONA_VAPID_PRIVATE`, `BONA_VAPID_SUBJECT`).
- iPhone: needs iOS 16.4+ and "Add to Home Screen" first; the page explains this.

## 6. Phase 4 — Dana on WhatsApp
- **Separate Retell objects** for WhatsApp (own LLM + chat agent, provisioned by `retell/provision.mjs`,
  ids in `retell/ids.json`) so the live site widget is untouched. Same knowledge base and inventory tools,
  plus a new tool `request_human(reason)`. Prompt: short plain WhatsApp text in the client's language, listing
  links instead of cards, prices only from brochures, never TK, never negotiate or promise, hand over for
  viewings / price negotiation / "talk to a person" / unsure.
- Lead columns: `dana_off` (per-chat toggle), `dana_chat_id`, `dana_chat_ts`, `dana_introduced`,
  `last_human_out_ts`.
- **When Dana answers:** new inbound stored for an `in` chat AND `settings.dana_enabled` AND not `dana_off`
  AND no human outbound in the last 24 h (`last_human_out_ts`; humans = staff, owner's number, Lisa) AND
  caps OK. Messages that arrived together are answered once.
- **Retell session per chat:** reuse `dana_chat_id` while active (< 24 h idle); otherwise create a new chat
  with dynamic variables (channel `whatsapp`, language, lead facts, the last 10 messages as context).
- **Before sending:** re-fetch that jid from Evolution; if a human outbound newer than the triggering
  message exists, drop the reply. The first Dana message in a chat is prefixed in code (not only in the
  prompt) with a disclosure line: "Dana — Bona's AI assistant" (AR/EN).
- `request_human` or a Retell error → reply "the team will reply shortly" (once), `needs_human = 1`,
  push to everyone; Dana stays quiet in that chat until a human replies and then 24 h pass.
- Caps: 6 Dana messages per chat per hour, 200/day overall, plus `lib/budget.mjs` chat ceilings; any cap hit
  → `needs_human`. Kill switches: Team page (global, default **off**) and per chat.
- Dana is switched on only with the owner (D14), after a test from a second phone.

## 7. Units and files
- `lib/team.mjs` (users, never list, settings), `lib/audit.mjs`, `lib/wa-send.mjs` (resolution, gate,
  outbox, idempotency), `lib/inbox/eligibility.mjs` (pure rules), `lib/inbox/store.mjs` (messages, reads,
  gaps, retention), `lib/inbox/backfill.mjs`, `lib/push.mjs` (VAPID JWT, dispatch), `lib/dana-wa.mjs`.
- `lib/dashboard/render-team.mjs`, `render-inbox.mjs` (render.mjs is already 1.5k lines; new screens get
  their own files), routes mounted from `routes.mjs`.
- Changed: `auth.mjs`, `db.mjs` (migrations), `wa-poller.mjs`, `wa.mjs` (owner note keeps working through
  `wa-send`), `index.mjs` wiring, `config.mjs`, `retell/provision.mjs`, privacy pages.
- bona-api stays dependency-free (Node 24 built-ins only).

## 8. Testing, review, deploy
- `node --test` per unit with fake fetch/clock (existing style: `services/api/test/*.test.mjs`), plus
  route tests with a real in-memory db. Hostile tests: staff cannot reach Team routes; deactivated sessions
  die; a guessed/unsure/never-list chat is never readable or sendable; `@lid` refusal; double submit sends once;
  uncertain send is not retried; poller exclusions; retention purge; push recipients; Dana quiet rules.
- Each phase: branch in a worktree under `~/bona-wt/`, full test suite green, **Claude review then Codex
  review** (owner rule), fixes, PR to main, merge, deploy with `deploy.sh`, verify `/health` and the new
  screens on the live dashboard (browser), tell the owner. Rollback = previous main commit + `deploy.sh`.
- Migrations are additive (new tables/columns); nothing is dropped from bona.db. Back up
  `~/bona-data/bona.db` on the VPS before each deploy that migrates.

## 9. Phase 5 — later (planned, not built now)
Quick-reply templates (AR/EN) · send listing card / brochure from the reply box · Dana-drafted replies in
human chats · follow-up reminders and "no reply in X min" alerts · staff performance (replies, response
time, conversions) · viewings calendar · open voice notes / photos / files in the dashboard.

## 10. Risks
- **WhatsApp ban risk** on a personal Baileys number that now sends staff replies, codes and Dana: shared
  gate, caps, kill switches; replies only to people who wrote first or whom the owner contacted.
- **Double replies** between staff and Dana: pre-send re-check, stale-view guard, 24 h quiet rule.
- **Privacy:** only certain matches auto-join; never list; team numbers excluded; Unsure is owner-only;
  audit log; privacy page; 5-year retention. Evolution keeps its own copy (stated).
- **Poll latency** (20–45 s) bounds how "live" the inbox and Dana feel.
- Shared `~/bona` working tree: all work in worktrees; the VPS pulls main every 5 min, deploys only via `deploy.sh`.
