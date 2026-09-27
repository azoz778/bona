# Dashboard: team accounts + WhatsApp inbox — HANDOVER (2026-09-27)

Status: **brainstorming, design half-approved.** No code written. The next session resumes the
`superpowers:brainstorming` flow at "present Sections 3–4", then writes the full spec, then
`superpowers:writing-plans`. Every phase gets a Claude + Codex review (owner rule).

Dashboard: https://bona-api.azoz.uk/dashboard (= api.bona-real-estate.com/dashboard), code in
`services/api/lib/dashboard/{auth,routes,render,stats}.mjs`, store `services/api/lib/db.mjs`
(node:sqlite), poller `services/api/lib/wa-poller.mjs`, sender `services/api/lib/wa.mjs#sendText`.
Live runtime is on the VPS (`hermes-vps`, system unit `bona-api`, repo `/opt/bona`, deploy
`ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh`). Never restart bona-api on the PC.

## Owner request (verbatim intent)
1. Add employee accounts that can log in.
2. Employees see the WhatsApp messages and answer clients from the dashboard.
3. Other dashboard features — suggestions wanted.

## Decisions LOCKED by the owner this session
| # | Question | Answer |
|---|---|---|
| D1 | Which number do staff reply from? | **Owner's personal number** +966593296933 (Evolution instance `abdulaziz-personal`). ⇒ reverses the old "read-only on this instance" rule: the API will SEND via `/message/sendText`. |
| D2 | What chats can staff see? | **All Bona-matched chats** (the poller's existing 5 match rules: ref, phone, ad_meta, keyword, time_window). Owner's private chats never shown/stored. |
| D3 | Staff login | **6-digit code to the employee's own WhatsApp** (sent from owner's number), same flow as today's owner login. |
| D4 | Permissions | **Everyone sees the same dashboard as the owner** — "don't build something new". Only extra: owner-only Team page to add/remove people. |
| D5 | Lisa | Lisa MAY auto-reply, **but only to Bona clients** (never personal contacts, delivery drivers, etc.). **When an employee (or owner) replies, Lisa stops in that chat and hands over.** Lisa lives in Hermes and uses the Evolution webhook on this instance — the handover switch must be built on Lisa's side, fed by the dashboard (which chats a human owns). |
| D6 | Staff alerts | **Dashboard unread badge + phone push notification** (dashboard as installable PWA, Web Push). |
| D7 | Inbox data | **Option A: store Bona-matched chat transcripts** (in + out, incl. replies the owner types on the phone). Reverses the old "never a transcript" rule for matched chats only. |
| D8 | Phase order | **1 Accounts → 2 Inbox → 3 Phone alerts → 4 Lisa client-only + handover.** Each ships + reviewed separately. |

## Design presented (Sections 1–2) — owner has NOT yet said "approved"
**S1 Team accounts:** `users` table (name, phone_e164, role owner|staff, active, created, last_login);
owner seeded. Login: phone → if active user, code to *their* WhatsApp; unknown phone gets the same
"code sent" screen, no message (no enumeration). `auth_sessions` gains `user_id`; deactivation kills
all sessions at once. Owner-only Team page (add / deactivate / last login). `audit_log` (login, reply,
stage change, team change, with actor). Keep hashed codes + browser nonce binding; rate limits become
per-phone as well as global.

**S2 Inbox:** poller stores messages for matched chats only (`wa_messages`: key_id, lead_id, jid,
direction, from_me, sender_user_id, text, ts, status); **retention 12 months (owner to confirm)**;
private chats still discarded in memory. UI: chat list (unread first, last msg, stage, handler) +
thread + reply box; mobile = two screens. Reply = Evolution sendText from owner's number, logged
with sender user; client sees only the owner's WhatsApp. "Handling" = first replier claims, anyone
can reassign. v1 text only; per-minute send cap (ban protection); sending refused to non-matched jids.

## Still to do next session (in order)
1. Get owner's OK on S1+S2 and the **12-month retention** number.
2. Present **S3 phone alerts** (PWA manifest + service worker + VAPID Web Push, subscriptions per user,
   push on new inbound in matched chat; iOS needs "Add to Home Screen").
3. Present **S4 Lisa handover** — first inspect read-only where Lisa's WhatsApp auto-reply runs in
   Hermes (`~/.hermes`, whatsapp profile / Evolution webhook consumer). Proposed contract: the API
   exposes "human-owned chats" (or Lisa checks `wa_messages` for a human outbound in the last N hours);
   Lisa replies only when the jid is Bona-matched AND not human-owned. Don't touch Lisa's Retell objects.
4. Offer the **extras menu** for a Phase 5 (owner asked for suggestions): quick-reply templates AR/EN;
   send listing card/brochure; Dana-drafted reply suggestion; follow-up reminders + "no reply in X min"
   alert; internal notes; per-agent performance (replies, response time, conversion); viewings calendar.
5. Write full spec `docs/superpowers/specs/2026-09-27-dashboard-team-inbox-design.md`, self-review,
   owner reviews, then `superpowers:writing-plans`.

## Risks / gotchas to carry into the spec
- **WhatsApp ban risk**: personal number now sends staff replies + staff login codes; keep send caps.
- **Double replies**: Lisa + staff on the same chat until Phase 4 ships — until then staff should know
  Lisa may answer. Consider shipping a minimal "human replied → Lisa quiet" signal early.
- **PDPL**: storing transcripts needs retention + privacy-page wording + audit log.
- Evolution 2.3.7 quirks: `fromMe` filter ignored, needs gte+lte, `@lid` jids (use `remoteJidAlt`).
- Login codes currently go only to the owner; `auth.mjs` limits (1/min, 60/day global) must be
  re-thought for several users.
- `~/bona` working tree is shared by other sessions → do the build in a worktree under `~/bona-wt/`.
- This handover file is **not committed** (untracked) — commit it with the spec.

## Update 2026-09-27 (later): Claude + Codex plan review + owner answers
Full findings: Claude memory `bona-dashboard-team-inbox-2026-09-27.md`. Must go into the spec:
- **Lisa** (confirmed by Hermes): sends from this instance only on owner request (sendText/sendMedia via VPS 127.0.0.1:8085); no auto-reply, no webhook. `webhook/find` = null, no websocket/rabbitmq/global webhook. ⇒ **D5 replaced: Phase 4 auto-replies = Dana inside bona-api.** Lisa's sends show as "sent from owner's number".
- **D9 (owner):** only CERTAIN matches reach the inbox (Ref code, ad_meta, listing id). keyword + time_window guesses never do. Store inbox eligibility on the lead at the first certain match; never re-derive through the `phone` rule.
- **D10 (owner):** owner-only "never a client" list; those jids are never matched, stored or shown.
- **D11 (owner):** retention = 5 years after the chat's last message (rolling).
- Exclude staff phones from matching (login code text "Bona dashboard code" keyword-matches).
- Auth: code challenge carries user_id (auth_codes are keyed by code hash only; nonce binding has no user); recheck active at verify; deactivation voids pending codes + sessions + push subs; routes hard-code actor 'owner' (setStage, notes) → real user; never remove the last owner.
- Sending: `toNumber()` strips `@lid` → resolve the phone jid server-side, refuse unresolved; store Evolution's returned message id at send, poller upserts on it; timeout = "uncertain", never blind-retry; one shared send limiter + kill switch (codes, replies, Dana).
- Inbox completeness: 500-record page cap + 3-strike write-off are unfit for an inbox → catch-up without advancing past unread pages; media placeholders ([voice note]/[image]); poll 45 s ⇒ ~1 min latency.
- PWA: CSP `default-src 'none'` blocks SW/scripts → open narrowly; SW must not cache transcripts; payload-less push (no client text via Apple/Google, no RFC 8291 code).
- Evolution's own DB keeps every chat regardless of bona.db retention → privacy-page wording.
