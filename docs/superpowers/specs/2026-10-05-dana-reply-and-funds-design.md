# Dana counts as a reply + Retell out-of-credit alert (2026-10-05)

Owner decisions (chat, 5 Oct 2026): "Dana counts" for the unanswered-leads watchdog; a phone
alert when Retell refuses for lack of funds (Dana's first real client, 3 Oct, got only the
hand-over line because Retell answered 402 and nobody knew why).

## R1. Dana's answer stamps `first_reply_ts`

- When `dana-wa.mjs#send` sends an **answer** (not the hand-over line) and the sender says
  `ok`, the same transaction that stores her message sets `first_reply_ts = t` if it is
  NULL (same rule as a staff reply in `wa-send.mjs`). Only while the chat is still `in`
  (the existing guard). `uncertain` sends do not stamp (a missed ping is worse than an
  extra one).
- The hand-over line never stamps: the client is waiting for a person, so the Hermes
  `bona-unanswered-leads` watchdog keeps pinging and the dashboard "waiting" list keeps it.
- The poller still never stamps on Dana's echo (unchanged).
- Side effect, accepted: response-time numbers include Dana's answers.

## R2. Retell out-of-credit watch

- Detection: any Retell call in `dana-wa.mjs` (createChat, createChatCompletion) that fails
  with `err.status === 402` → `funds.out()`. Only a successful **completion**
  (createChatCompletion) → `funds.ok()`: a chat Retell lets her open says nothing about
  whether it will answer, so a working createChat clears nothing. Other statuses are not funds.
- State is durable in `settings`: `retell_funds_out` = ms timestamp of when it started
  (`''`/absent = fine), `retell_funds_alerted` = ms of the last owner alert that reached a
  device. Survives a restart.
- `out()`: sets `retell_funds_out` if not already set (log `dana.funds_out`); if the last
  alert is older than 6 h (or none), stores the alert time (before the send, so a concurrent
  402 is quiet) and pushes **active owners only**. When the push reached no device — push off,
  no owner device, every send failed, an error — the alert time goes back to its previous
  value, so the next 402 tries again.
- `ok()`: clears `retell_funds_out` if set (log `dana.funds_ok`). The alert time stays (so a
  flapping balance cannot alert more than once per 6 h).
- Clients: unchanged — the failed completion still becomes a hand-over (line + needs-human
  alert to everyone).
- Push: payload-less as always. New reason `funds` in `alerts.mjs` (owner-wide, not tied to a
  lead), same device/session/410 handling as the lead alerts. The worker's one
  `/dashboard/push/latest` question answers `{ kind: 'funds' }` iff the member is an active
  owner AND `retell_funds_out` is set AND `now - retell_funds_alerted < 1 h` (push TTL) AND
  no push for another reason (inbound / needs_human / check) **that reached one of that
  owner's devices (2xx)** more than 2 min (`ALERT_EVERY_MS`) after the funds alert time. The
  grace is for the 402's own hand-over, whose needs_human push follows the funds push by
  milliseconds to seconds; without it the owner would never read the funds text. Those chat
  push times are kept in memory (empty after a restart, so a queued funds push still reads as
  funds); the two-minute cooldown marks are unchanged (set for every member due, before the
  sends). Otherwise the usual check > inbound. Worker text: **"Bona: Dana is out of Retell
  credit"**, body "Dana can't answer until Retell is topped up. A client may be waiting — tap
  to open.", tag `bona-funds`.
  `/dashboard/push/open` for kind `funds` → the same chat an inbound alert would open (the
  first unread row of the member's list) when anything is unread — a client may be waiting —
  else `/dashboard/team`.
- Accepted noise: while no owner device accepts the push (sends failing, not 404/410), the
  alert time is rolled back each time, so every later 402 tries the funds push again until
  one is delivered or the device is dropped.
- Team page (owners): while `retell_funds_out` is set, a red banner at the top: "Dana can't
  answer: Retell credit ran out at <Riyadh time>. Top up Retell and she resumes by herself;
  until then clients get the hand-over line." The same banner tops the owners' inbox list,
  where a tapped funds alert usually lands. `/health` `dana` gains `fundsOut: true|false`.
- Nothing logs names, numbers, text or endpoints (counts and ids only, as everywhere).
