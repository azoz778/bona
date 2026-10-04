# Bona dashboard — "new chat to check" alerts (design, 2026-10-04)

Owner request (2026-10-04): "I get alerted and the second I tap, they join." Chosen in chat: **(A)** alert on
new Unsure leads only (not the D17 "chats to check" candidates); **(1)** two taps — the alert opens the
Unsure page with that chat at the top, the second tap moves it in, and Dana answers within a minute.
Extends the 2026-09-27 design (D9 Unsure list, §5 phone alerts, §6 Dana).

## 1. Decisions

| # | Decision |
|---|---|
| U1 | **What alerts:** a chat that enters the Unsure list from the client's side — the poller classified an inbound record and the lead's `inbox_state` became `unsure` for the first time: a new lead, or a lead that had no state yet (a website-form or web-chat enquiry whose first WhatsApp message carries no sure signal is set to `unsure` explicitly at that moment — Task 1 review; until then such a lead sat on the Unsure page by its jid without ever entering the state). Not a chat already in Unsure writing again, not a D17 candidate, not anything the owner sent, not a chat that joins the inbox (that is §5's "New Bona message"). |
| U2 | **Who:** active **owners** only (the Unsure list is owner-only, D9; `pendingCheck` re-checks that too), on their live devices, one check per chat per owner per 2 minutes (marked apart from the inbound mark, so a Move inside those 2 minutes does not silence the chat's first inbox alert), only for a message under 30 minutes old — the §5 rules, with `reason: 'check'`. |
| U3 | **What the phone shows:** "Bona: new chat to check" with body "Someone new wrote to you. Tap to decide." — distinct from "New Bona message". The push still carries nothing; the service worker asks the server once, same-origin, `GET /dashboard/push/latest` → `{ kind: 'check' \| 'inbound' }` (cookie-authenticated, no names, no text), 2 s timeout, fallback "New Bona message". The worker still never caches or intercepts; its CSP gains `connect-src 'self'` for that one request (amends P3-3). |
| U4 | **Where the tap lands:** `GET /dashboard/push/open` sends an owner whose newest pending check alert is newer than their newest unread inbox message to `/dashboard/inbox?tab=unsure&focus=<leadId>`; everyone else lands as today (newest unread chat → newest chat → inbox). The Unsure page draws the focused chat first, marked "new", with its *Move to Bona inbox* button right there. Pending checks live in memory (`alerts.pendingCheck(userId)`), are forgotten once the chat leaves Unsure, and are lost on restart (then the tap lands on the inbox — acceptable). |
| U5 | **The second tap:** the existing owner-only `POST /v1/admin/inbox/:id/move` (and *Add chat by phone number*, and a D17 candidate Move) now also **wakes Dana** after the 30-day history is in: when the chat's newest unanswered client message is at most 6 hours old, `dana.answer(leadId)` runs (never awaited, never rejects) — so the message that raised the alert gets her answer within about a minute, under every existing rule (her global switch or the chat's test flag, no human in 24 h, caps, hand-over). An older unanswered message is left to the team: a bot must not answer a two-week-old "hi". |
| U6 | **Nothing else changes:** no new data stored, no privacy-page change (the Unsure list and the alerts are already described; a check alert carries nothing). |

## 2. Units
- `lib/wa-poller.mjs`: `createPoller({ …, onUnsureLead })` — called `onUnsureLead(leadId, ts)` (not awaited, a throw logged `poll.alert_failed`) when `inboxAfterInbound` moves a lead INTO `unsure` from no state or creation.
- `lib/alerts.mjs`: reason `check` (lead must be `unsure` and not excluded; recipients = active owners; marks as today), `pendingCheck(userId) → { leadId, ts } | null` (only while that lead is still `unsure`; cleared otherwise), log `push.sent { reason: 'check' }`.
- `lib/dashboard/routes.mjs`: `GET /dashboard/push/latest` (JSON `{ kind }`, signed in), `pushOpen` decision, `focus` on the Unsure tab, `wakeDanaAfterJoin(leadId)` in the three owner joins (`MOVE_ANSWER_WINDOW_MS = 6 h`), `WORKER_CSP` + `connect-src 'self'`.
- `lib/dashboard/render-inbox.mjs`: `unsurePage({ …, focus })` — the focused row first with a "new chat to check" mark.
- `lib/dashboard/assets/sw.js`: the one fetch, the two fixed notifications (tags `bona-check` / `bona-inbox`).
- `index.mjs`: wires `onUnsureLead: (leadId, ts) => alerts.notify(leadId, { reason: 'check', ts })`.
- README: Inbox (Unsure) + Phone alerts paragraphs.

## 3. Testing
Poller: the hook fires once on entering Unsure (new lead; NULL → unsure), never for a repeat message, a join, an owner message or an excluded number. Alerts: `check` reaches active owners only, needs `unsure`, marks/freshness as `inbound`, `pendingCheck` set and cleared. Routes: `push/latest` kinds; `push/open` redirect for an owner with a pending check vs a staff member vs a newer unread message; `focus` validated and drawn; each owner join wakes Dana only when the newest unanswered client message is within the window (spy `app.dana.answer`). Service worker source: one fetch to `/dashboard/push/latest` only, no `caches`/`fetch` listener, both titles; `WORKER_CSP`. Wiring: an unsure lead stored by the poller → one push to the owner's device, none to staff.

## 4. Risks
An owner who ignores a check alert gets no repeat (one alert per chat; the Unsure page keeps it). A chat moved after 6 h gets no automatic Dana answer — the team answers. The worker's fetch is same-origin only; a slow server degrades to the generic title, never to a missed notification (iOS withdraws subscriptions of workers that show nothing).
