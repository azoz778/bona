# QA — the concierge (Dana)

The widget lives in `src/components/concierge/` (`Concierge.astro` markup, `client.ts` controller, `api.ts` HTTP,
`call.ts` voice, `render.ts` DOM builders) and is mounted for every page by `src/layouts/Base.astro`. It talks to the
concierge API described in `docs/superpowers/specs/2026-09-05-wa-intake-concierge-hero-design.md` §3.

Nothing here needs the real API: `scripts/dev/concierge-stub.mjs` answers the whole contract locally.

## Pointing the widget at a local API

```bash
node scripts/dev/concierge-stub.mjs --port 4111     # terminal 1
npm run build && npm run preview                    # terminal 2  (http://localhost:4321)
```

then open

```
http://localhost:4321/?concierge_api=http://127.0.0.1:4111
```

**The override is deliberately narrow.** `?concierge_api=` is honoured only when *both* are true:

1. the page itself is served from `localhost` / `127.0.0.1` / `[::1]` (dev or `npm run preview`), and
2. the target is an `http(s)` URL whose host is one of those same localhost names.

Anywhere else the parameter is ignored *and* any override still sitting in `sessionStorage` is deleted, so a link like
`https://bona.azoz.uk/?concierge_api=https://evil.example` cannot re-point a visitor's chat, call tokens or call
context at someone else's server. A valid override stays sticky for the tab, so it survives the `navigate` action.

For a host where the query parameter is refused (production, a preview deploy), set it by hand in the console — only
the person already at the keyboard can do that:

```js
window.BONA_CONCIERGE_API = 'http://127.0.0.1:4111';   // then reload
```

Otherwise the widget uses `src/data/site.json` → `concierge.apiBase`.

## The drills

Run each in EN and AR (`/` and `/ar/`), at 375 and 1440.

| # | Drill | What to look for |
|---|---|---|
| 1 | Open the pill | Greeting bubble, quick replies, focus lands in the composer |
| 2 | "show me an apartment" | An inline listing card, image, price, "View →" pointing at a local `/properties/…` path |
| 3 | "show me the houses you represent" | "Opening the page…" note, then a soft navigation; the panel stays open |
| 4 | "talk to a person" | A WhatsApp button carrying the pre-filled message |
| 5 | API unreachable — point at a dead port, e.g. `?concierge_api=http://127.0.0.1:4998` | The calm offline card, composer disabled, WhatsApp link and "Try again" |
| 6 | Expired session — `curl http://127.0.0.1:4111/__stub/expire-next`, then send a message | The 404 is invisible to the visitor: a new session is opened, the message is resent once, the reply arrives, **no** offline card. One `404 (Not Found)` line in the console is the drill itself |
| 7 | Call tab → Start | The stub hands out a deliberately fake token, so the Retell SDK fails its own handshake: the panel must land on "We could not connect" with the phone/WhatsApp fallback, and the orb must be clickable again |
| 8 | Close the panel mid-connect | The call is cancelled: state goes to `ended`, no LiveKit socket is opened when the late token lands, focus returns to the pill |
| 9 | In-site navigation during a call | The call keeps running and the panel re-opens on the **Call** tab, so End/Mute are never out of reach. Leaving the site (`pagehide`) disposes it |
| 10 | "New conversation" | The log empties, `sessionStorage['bona.chat.<locale>']` is cleared, a fresh greeting arrives |

### Accessibility

- The closed panel is `inert` **in the server-rendered HTML**, so nothing inside it is focusable before the script binds.
- Desktop (≥ 640 px) is a non-modal drawer: `Tab` may leave it, the page is not `inert`, there is no `aria-modal`. `Esc`
  still closes it and focus returns to the pill.
- Mobile (< 640 px) is a modal sheet: `aria-modal`, `main`/`footer`/header `inert`, body scroll locked, `Tab` trapped.
- The tablist takes Arrow Left/Right (mirrored in RTL — in Arabic, Arrow **Left** moves forward), Home and End, and
  focus follows the selection.
- The call timer updates a child `<span data-cg-timer-value>`, so the visually hidden "Call duration:" label survives
  every tick.

### State kept in the browser

`sessionStorage['bona.chat.<locale>']` is `{ v: 1, savedAt, sessionId, items, greeted, quickUsed }`. It is ignored if
the version differs or it is older than two hours, every item is validated before it is rendered, and at most 60 items
are kept. This is disclosed in `src/data/privacy.json` → `ai-concierge`.

### Expected console noise

Zero console errors, with two exceptions, both deliberate:

- drill 6 logs one `404 (Not Found)` for `/v1/chat/message` — that *is* the expired-session drill;
- drill 7 logs the Retell SDK's own `401` and `ConnectionError: could not establish signal connection: invalid
  authorization token`, because the stub's token is fake by design.

## Screenshots

`NN-state-<locale>-<width>.png`:

| Prefix | State |
|---|---|
| `01-cluster` | The floating cluster, panel closed |
| `02-open` | Panel open on Chat with the greeting |
| `03-card` | An inline listing card |
| `04-call` | The Call tab, idle |
| `05-call-error` | A call that could not be connected, with the phone/WhatsApp fallback |
| `06-navigated` | After a `navigate` action |
| `07-closed` | Closed again, focus back on the pill |
| `08-fallback` | The API unreachable |
| `09`–`11` | "Ask Dana" entry points on the Contact and listing pages |

## Follow-ups

- **No CSP `<meta>` tag yet.** The panel loads the Retell web SDK and opens a LiveKit WebRTC/WebSocket connection, and
  those hosts are not enumerated anywhere yet (the SDK picks a LiveKit region at runtime — a fake-token run reached
  `wss://retell-ai-*.livekit.cloud`). A `connect-src`/`script-src` policy written from guesses would break real calls,
  so the tag is deliberately left out until the backend workstream publishes the host list. Add it then, and re-run
  drills 7–9.
- The Call tab cannot be exercised end-to-end locally without a real Retell token; drill 7 only proves the failure path.
