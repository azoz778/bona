# Bona WhatsApp on its own number: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Bona's WhatsApp from the owner's personal number (Evolution `abdulaziz-personal`, +966 59 329 6933) to Bona's own number (+966 57 626 7694, Evolution instance `bona`) so that bona-api stops reading `abdulaziz-personal` (A2Z go-live checklist item 7), while lead notes, login codes and the owner seed stay on the owner's personal phone.

**Architecture:** One new setting, `BONA_WA_INSTANCE_JID`, holds the instance's own number. `BONA_OWNER_JID` keeps its identity jobs (where notes and the owner's login codes go, the seeded owner account, the one code that may pass the Sending switch). The poller's own-chat skip, ingest's "sent record's alt names our sender" check and the sender's shared-budget exemption move to the instance's number. Unset, `BONA_WA_INSTANCE_JID` falls back to `BONA_OWNER_JID`, so the code behaves exactly as today: removing the env line is the rollback. The site's WhatsApp number (`site.json` `whatsapp` only; `site.phone` stays) and every hand copy of it move to the new number, the privacy notice and FAQ describe the new number and the AI phone line, and two guards stop the cutover from being undone silently (`sync-secrets.sh`, `verify-integrations.mjs`).

**Tech Stack:** Node 22+/24 ESM, `node:test`, `node:sqlite` (bona-api, `services/api`), Astro 7 site (`src/`), bash deploy scripts (`services/deploy/vps`), Python 3 + PyMuPDF (`services/intake/rebrand_pdf.py`).

**Branch / worktree:** `feat/wa-own-number` at `/home/azoz778/bona-wt/wa-own-number` (from `origin/main` `ed94e60`). Written 2026-11-19 by the plan stage; every file:line below was read on `ed94e60` today.

---

## 0. Hard rules for whoever executes this plan

- Work only in `/home/azoz778/bona-wt/wa-own-number`. Never edit `~/bona` (bona-intake runs from it: `WorkingDirectory=%h/bona`), `~/bona-line`, `~/bona-publish`, `~/bona-search-fix`, `~/bona-intake` or any other `~/bona-wt/*`.
- Never push, merge, open a PR, deploy, restart a service, write to the VPS, create an Evolution instance or call any WhatsApp/Evolution send endpoint. Local commits only: conventional messages, each ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Every test run and script goes through `run-capped` (4 GB box). Bounded runners: `node --test --test-concurrency=4`. For jest (not used here) `npx jest --maxWorkers=4`, never a bare `watchman`. Status 137 / "Killed": stop, run `dmesg -T | grep -E 'oom-kill:|going to be killed' | tail -3`, report; do not re-run or raise the cap yourself.
- No files in `/tmp`. Several tests call `os.tmpdir()`, so every test command sets `TMPDIR=$WT/.scratch/tmp`. `.scratch/` is git-ignored by Task 0.
- Never print secret values (env files, Evolution key, instance token). Never read customer message contents, call files or `bona.db` rows.
- Shell variables used in commands below:

```bash
WT=/home/azoz778/bona-wt/wa-own-number
T="TMPDIR=$WT/.scratch/tmp"
```

- Baseline on `ed94e60` (plan stage, 2026-11-19): `services/api` 1315/1315 pass. `scripts/test` + `services/intake/test` 698/712: the 14 failures are all `ERR_MODULE_NOT_FOUND: sharp` because the fresh worktree has no `node_modules`; Task 0 runs `npm ci` and must bring this to 712/712 before any change.

## 1. Owner decisions this plan builds on (not re-decided here)

- Approvals 2026-11-19 (`~/a2z-brand/docs/approvals.md`, row "Move Bona first"): Bona moves to its own number first; Claude builds the approved design §11 code split ("notes + login codes stay on his personal phone"), the site's WhatsApp button and Bona's privacy/FAQ wording for his OK; then the cutover; then A2Z go-live.
- Design `~/bona-line-handover/2026-11-16/2026-11-16-bona-virtual-assistant-line-design.md` §6.11 (WhatsApp), §6.12 (number switch), §8 ("privacy page updated before going public"), §9 defaults (audio 90 days, old posts unchanged, personal number not polled after P4), D2, D4, D10, O1 (REGA switches too, lawyer OK), O3.
- Out of scope (later Phase 3 or owner by hand): `site.phone`, REGA/FAL records, re-approving the 31 property reviews, re-rendering the 21 published brochures, Meta/IG/FB buttons and click-to-WhatsApp ads, the AI line code (`~/bona-line`), bona-intake's own read of the owner's PDF group.

### Env names and values

| Name | VPS value after cutover | Meaning after this branch |
|---|---|---|
| `BONA_WA_INSTANCE` | `bona` | The Evolution instance every read and send uses (poller, backfill, notes, codes, staff replies, Dana). Unchanged meaning. |
| `BONA_WA_INSTANCE_JID` (new) | `966576267694@s.whatsapp.net` | That instance's own number: the one chat the poller never reads, the number a sent record's alt may name (ingest), outside the shared send budget. Unset or blank: falls back to `BONA_OWNER_JID`. |
| `BONA_OWNER_JID` | unchanged, `966593296933@s.whatsapp.net` | The owner: where lead notes and his login codes go (now sent from the Bona instance), the seeded owner account, the only login code that may pass the Sending switch. |

The PC copy of `~/.secrets/bona-services.env` stays as it is (`abdulaziz-personal`): bona-intake on the PC needs it for the owner's PDF group.

### Behaviour with `BONA_WA_INSTANCE_JID` unset (the rollback state)

`waConfig().instanceJid === waConfig().ownerJid`, so:

| Place | Unset (today) | Set (after cutover) |
|---|---|---|
| Poller own-chat skip, `isIgnorableChat`, self-lid learning (`wa-poller.mjs:363,907-919`) | owner's number | Bona number |
| Ingest sender-alt exemption (`index.mjs:242-245,271` → `inbox/ingest.mjs:101-103,148-150`) | owner's number | Bona number |
| Handler of a chat typed on the instance phone (`index.mjs:248-251`) | owner's account | owner's account (unchanged) |
| Owner seed `ensureOwner` (`index.mjs:214`) | `BONA_OWNER_JID` | `BONA_OWNER_JID` (unchanged; no account for the Bona number) |
| Lead notes (`wa.mjs:41-58`) | to `BONA_OWNER_JID` via `BONA_WA_INSTANCE` | same; the instance is now `bona` |
| Sender switch bypass (`wa-send.mjs:216-219`) | owner's own login code | owner's own login code (unchanged) |
| Sender shared-budget exemption (`wa-send.mjs:122-124,226-235`) | {owner} | {owner, Bona number} |
| `/health` `poller.ownNumber` (new, additive) | `"owner"` | `"instance"` (`"invalid"` if the JID is not a phone JID: treated as unset) |

Proof that unset changes nothing: Tasks 1-4 add tests and do not modify any existing assertion; the full existing suite must stay green.

## 2. Verified touchpoints and corrections to the readiness map

Readiness map: `/home/azoz778/.claude-c/projects/-mnt-c-Users-ASUS/b8378c62-88d2-4a0b-ba6a-29b7a80e785f/subagents/workflows/wf_74b2b76d-eca/journal.jsonl` (bona-refs, skeptic-switch, critic). Every touchpoint it lists was re-read on `ed94e60`; all hold, with these additions and corrections:

1. `scripts/og/gen-llms.mjs:246` prints `- WhatsApp / phone: ${site.whatsapp.display}`. With only `whatsapp` moving, llms.txt would call the new number the phone. Split into two lines (Task 8).
2. `src/lib/seo.ts:182` JSON-LD `telephone` already uses `site.phone` (stays), `:188-189` contactPoint and `:91,198` sameAs use `site.whatsapp` (move). Correct as is.
3. `services/intake/test/brochure.test.mjs:312` is a fourth pinned assertion (skeptic found it); `:301` and `:312` both read the real `site.json` through `rebrand_pdf.py`. Make both read `site.json` (Task 8), like `SITE_HOST` at `:26-27` already does.
4. `services/api/test/provision.test.mjs:135` is not in CI (deploy.yml runs only `npm test`, the intake tests and `test:dist`), but it fails locally. Make it read `site.json` (Task 9).
5. bona-intake runs from `~/bona` (`systemctl --user cat bona-intake.service`: `WorkingDirectory=%h/bona`), not `~/bona-intake`. New intake brochures pick up the new WhatsApp number when `~/bona` is pulled to the merged main.
6. The social publishers (`bona-daily@.service`, `bona-browser@.service`) run `ops/systemd/sync-publish-tree.sh`, which checks out `origin/main` before every run. From the first run after the merge, captions (`scripts/social/lib/listing.mjs:223-224`) and cards (`cards.mjs:151,178,280`) print the new WhatsApp number. The 31 reviews stay valid: `advertiserSha256` is built from `site.phone` (`social-catalogue.json.ts:10`, `property-daily.mjs:18,139`) and `factsSha256` holds no number.
7. `services/api/retell/provision.mjs:372-395` `ensureEnvFile` only adds missing keys. Leave `BONA_WA_INSTANCE: 'abdulaziz-personal'` there (the PC file is shared with bona-intake) and never add `BONA_WA_INSTANCE_JID` to its defaults: absence is the rollback state (test in Task 5).
8. `services/api/lib/config.mjs:96` `waNumber` (`BONA_WHATSAPP`, personal number) is read nowhere (`git grep waNumber` → only that line). Delete it (Task 5).
9. Dashboard copy says "your number" for the sending number: `render-team.mjs:72,93,95,96,101`, `render-inbox.mjs:230,263`, `render.mjs:784`. After the split the sending number is Bona's, so the copy becomes neutral ("Bona's WhatsApp number"), true in both states (Task 6).
10. Under the split, self-chat lid learning (`wa-poller.mjs:917-920`) finds no `users` row for the Bona number and learns nothing. Safe: every self-chat record is `fromMe`, and a lid-only outbound record never creates a lead (`wa-poller.mjs:739-751`, A7). The owner's personal chat on the Bona instance (our notes to him, his answers) is skipped by the team rule because `ensureOwner` keeps seeding his row and index.mjs always wires `isExcluded: team.isExcludedPhone` (`index.mjs:313`). Tested in Task 2.
11. The sender's switch bypass exists so the owner can always log in to turn Sending back on (`wa-send.mjs:20-31`); design §11 lists login codes under the owner identity. So the bypass stays on `BONA_OWNER_JID`. The brief's "send budget moves to the instance JID" is met by adding the instance's number to the budget exemption; the owner's codes keep theirs (Task 4).
12. `services/deploy/vps/sync-secrets.sh:25` scp's the PC `bona-services.env` over the VPS copy, and `scripts/marketing/verify-integrations.mjs:286` writes `instance ${env.BONA_WA_INSTANCE}` into `src/data/integrations.json` (`:228` is on the public `/dashboard/`). Both fixed (Tasks 7, 10).
13. `services/api/test/vps-deploy.test.mjs` and others use `os.tmpdir()`: run with `TMPDIR` (section 0).
14. The PC `bona-api.service` twin is disabled but its preset is `enabled`; `rollback.sh` starts it with the PC env, which says `abdulaziz-personal`. Documented in Task 12 with the drop-in a PC rollback needs.
15. Peer branches touching the same files: `feat/trump-auto-pdf` (PR #62: `tools.mjs`, `wa-send.mjs`, `wa-send.test.mjs`, `dana-wa.mjs`) and the unpushed `feat/intake-brochure-models` (`rebrand_pdf.py`, `brochure.test.mjs`). Whichever lands second rebases; the overlaps are literal lines.

### Item 7 and bona-intake (finding)

Item 7 as written ("bona-api's poller no longer reads `abdulaziz-personal`") becomes fully true with `BONA_WA_INSTANCE=bona`: the poller, the backfill reads (daily catch-up, thread refresh, Move/Add history, Dana's pre-send refresh), the sender and the notes all take the instance from `waConfig` (`wa.mjs:17`). bona-intake (PC, from `~/bona`) keeps reading `abdulaziz-personal`, but only the owner's own Bona PDF group(s): `fetchAllGroups`, then `findMessages` with `where.key.remoteJid = <group>` (`services/intake/lib/evolution.mjs:74-95`), acting only on the owner's messages (`services/intake/index.mjs:74-90`). It cannot create leads, so it is not the risk item 7 names (the `time_window` rule and ad fan-out). Item 7 is not affected; the evidence must say it covers bona-api. Not changed in this branch. The Hermes `bona` profile also has unscheduled cache scripts that can read `abdulaziz-personal` (`export_waiting_lead_context.py`, `probe_evolution_shapes.py`); nothing runs them.

## 3. File map

| File | Change |
|---|---|
| `.gitignore` | `+ .scratch/` |
| `services/api/lib/wa.mjs` | `waConfig` gains `instanceJid`, `ownNumberFrom`; header comment |
| `services/api/lib/wa-poller.mjs` | own number from `instanceJid`; `status().ownNumber`; header comment |
| `services/api/index.mjs` | owner digits vs instance digits; invalid-jid log; tool_failed note number |
| `services/api/lib/inbox/ingest.mjs` | doc comment only |
| `services/api/lib/wa-send.mjs` | budget exemption set {owner, instance}; doc |
| `services/api/lib/inbox/store.mjs` | `countSentSince` takes `excludeJids` |
| `services/api/lib/config.mjs` | drop dead `waNumber` |
| `services/api/retell/provision.mjs` | comment on `ensureEnvFile` defaults |
| `services/api/retell/prompt.md` | WhatsApp number lines 38, 101, 133 |
| `services/api/lib/tools.mjs` | notes at 124, 265 |
| `services/api/lib/dashboard/render-team.mjs`, `render-inbox.mjs`, `render.mjs` | neutral copy |
| `services/deploy/vps/lib.sh`, `sync-secrets.sh` | keep the VPS's own WhatsApp lines |
| `services/api/test/fixtures/vps-shims/ssh`, `scp` | new shim cases |
| `src/data/site.json` | `whatsapp` block only |
| `src/data/{faq,privacy,content-calendar,integrations}.json`, `marketing/page-meta.json`, `public/site.webmanifest` | hand copies |
| `scripts/og/gen-llms.mjs` | WhatsApp and phone on separate lines |
| `scripts/marketing/verify-integrations.mjs` | no instance name on the board |
| `services/intake/rebrand_pdf.py`, `src/data/LISTING-SCHEMA.md` | fallback + comments |
| `marketing/social-bios.md` | WhatsApp Business profile section, bios |
| `services/README.md`, `docs/OWNER-RUNBOOK.md` | docs |
| `public/llms.txt`, `public/llms-full.txt` | regenerated (separate commit) |
| Tests: `services/api/test/{wa,wa-poller,inbox-wiring,wa-send,inbox-store,provision,tools,dashboard-render-inbox,vps-deploy}.test.mjs`, `scripts/test/{contact-numbers,privacy-policy,verify-integrations}.test.mjs`, `test/seo-jsonld.test.mjs`, `services/intake/test/brochure.test.mjs` | new / updated |
| `/home/azoz778/a2z-golive/2026-11-19/bona-wa-cutover-runbook.md` | new, outside the repo (Task 15) |

---

## Task 0: Worktree hygiene and a green baseline

**Files:** Modify `.gitignore`

- [ ] **Step 1: Ignore the scratch dir**

Append to `$WT/.gitignore`:

```gitignore
# Local scratch for test temp dirs and logs (2026-11-19 WhatsApp move); never committed.
.scratch/
```

- [ ] **Step 2: Install dependencies (the baseline needs `sharp`)**

```bash
mkdir -p $WT/.scratch/tmp && cd $WT && run-capped npm ci
```

Expected: exit 0. If run-capped reports status 125/2 or "Failed to start", stop and report.

- [ ] **Step 3: Baseline all three suites**

```bash
cd $WT/services && env $T run-capped node --test --test-concurrency=4 api/test/*.test.mjs 2>&1 | tail -8
cd $WT && env $T run-capped node --test --test-concurrency=4 scripts/test/*.test.mjs services/intake/test/*.test.mjs 2>&1 | tail -8
```

Expected: `fail 0` in both (1315 and 712 tests). Any other failure: stop and report before changing code.

- [ ] **Step 4: Commit**

```bash
git -C $WT add .gitignore
git -C $WT commit -m "chore: ignore the local .scratch dir

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 1: `waConfig` knows the instance's own number

**Files:**
- Modify: `services/api/lib/wa.mjs:1-22`
- Create: `services/api/test/wa.test.mjs`

- [ ] **Step 1: Write the failing test** (`services/api/test/wa.test.mjs`)

```js
// services/api/test/wa.test.mjs: the owner identity and the instance's own number (2026-11-19, design §11)
import test from 'node:test';
import assert from 'node:assert/strict';
import { waConfig, sendText, DEFAULT_OWNER_JID } from '../lib/wa.mjs';

const OWNER = '966593296933@s.whatsapp.net';
const BONA = '966576267694@s.whatsapp.net';

test('unset or blank BONA_WA_INSTANCE_JID: the instance is the owner\'s own number, as before the split', () => {
  for (const env of [{}, { BONA_WA_INSTANCE_JID: '' }, { BONA_WA_INSTANCE_JID: '   ' }, { BONA_OWNER_JID: OWNER }]) {
    const cfg = waConfig(env);
    assert.equal(cfg.ownerJid, env.BONA_OWNER_JID ?? DEFAULT_OWNER_JID);
    assert.equal(cfg.instanceJid, cfg.ownerJid);
    assert.equal(cfg.ownNumberFrom, 'owner');
  }
});

test('set: the instance has its own number and the owner keeps his', () => {
  const cfg = waConfig({ BONA_WA_INSTANCE: 'bona', BONA_OWNER_JID: OWNER, BONA_WA_INSTANCE_JID: ` ${BONA} ` });
  assert.equal(cfg.instance, 'bona');
  assert.equal(cfg.ownerJid, OWNER);
  assert.equal(cfg.instanceJid, BONA, 'trimmed');
  assert.equal(cfg.ownNumberFrom, 'instance');
});

test('a lead note still goes to the owner\'s personal number, now sent from the Bona instance', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 201 }; };
  const env = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'bona', BONA_OWNER_JID: OWNER, BONA_WA_INSTANCE_JID: BONA };
  const res = await sendText('*Bona — new enquiry*', { env, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://evo.test/message/sendText/bona');
  assert.equal(calls[0].body.number, '966593296933');
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd $WT/services && env $T run-capped node --test api/test/wa.test.mjs
```

Expected: FAIL (`cfg.instanceJid` is `undefined`).

- [ ] **Step 3: Implement** (`services/api/lib/wa.mjs`, replace lines 1-22)

```js
/**
 * WhatsApp note to the owner via the self-hosted Evolution API.
 *
 * Two numbers, kept apart since 2026-11-19 (design 2026-11-16 §11):
 *   - the OWNER (`BONA_OWNER_JID`): where lead notes and his login codes go, the owner account
 *     seeded on every start, the one login code that may pass the Sending switch;
 *   - the INSTANCE (`BONA_WA_INSTANCE`, its own number `BONA_WA_INSTANCE_JID`): what every read
 *     and send goes through. Bona's own WhatsApp Business since the move; before it, the
 *     owner's personal WhatsApp, when the two numbers were one.
 * `BONA_WA_INSTANCE_JID` unset or blank means "the owner's number", exactly as before the
 * split: removing the line is the rollback. We only ever send text here; we never set a
 * webhook, a websocket or a rabbitmq consumer on the instance.
 *
 * Failure is non-fatal: a lead is already on disk before this is attempted.
 */

export const DEFAULT_OWNER_JID = '966593296933@s.whatsapp.net';

export function waConfig(env = {}) {
  const ownerJid = env.BONA_OWNER_JID ?? DEFAULT_OWNER_JID;
  const ownJid = String(env.BONA_WA_INSTANCE_JID ?? '').trim();
  return {
    baseUrl: String(env.EVOLUTION_API_URL ?? '').replace(/\/+$/, ''),
    apiKey: env.EVOLUTION_API_KEY ?? '',
    instance: env.BONA_WA_INSTANCE ?? 'abdulaziz-personal',
    ownerJid,
    /** The instance's own number: the chat the poller never reads, the sender a sent record's alt names. */
    instanceJid: ownJid || ownerJid,
    /** Where that number came from, for /health and the start-up line (never the digits). */
    ownNumberFrom: ownJid ? 'instance' : 'owner',
    groupJid: env.BONA_WA_GROUP_JID ?? null,
    enabled: String(env.BONA_WA_NOTIFY ?? '1') !== '0',
  };
}
```

- [ ] **Step 4: Run the test and the existing wa users**

```bash
cd $WT/services && env $T run-capped node --test --test-concurrency=4 api/test/wa.test.mjs api/test/wa-send.test.mjs api/test/wa-poller.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git -C $WT add services/api/lib/wa.mjs services/api/test/wa.test.mjs
git -C $WT commit -m "feat(api): BONA_WA_INSTANCE_JID gives the WhatsApp instance its own number

Unset or blank it falls back to BONA_OWNER_JID, so nothing changes until the line is set.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 2: The poller's own chat is the instance's

**Files:**
- Modify: `services/api/lib/wa-poller.mjs:10-13` (comment), `:361-363`, `:905-920`, `:1097-1110`
- Test: `services/api/test/wa-poller.test.mjs` (append a section)

- [ ] **Step 1: Write the failing tests** (append to `services/api/test/wa-poller.test.mjs`)

```js
/* ---------------- (z) Bona's own number: BONA_WA_INSTANCE_JID (2026-11-19, design §11) ---------------- */

const BONA = '966576267694@s.whatsapp.net';
const SPLIT = { BONA_WA_INSTANCE: 'bona', BONA_WA_INSTANCE_JID: BONA };

test("(z) unset or blank BONA_WA_INSTANCE_JID: the owner's own chat is still the one never read (the rollback state)", async () => {
  for (const env of [{}, { BONA_WA_INSTANCE_JID: '' }, { BONA_WA_INSTANCE_JID: '  ' }]) {
    const h = harness({ env, windows: [[
      msg({ id: 'O1', jid: OWNER, fromMe: true, text: 'Bona — new enquiry' }),
      msg({ id: 'O2', jid: OWNER, fromMe: false, text: 'Ref BONA-W003 · K7Q2XR' }),
    ]] });
    const tally = await h.poller.tick();
    assert.equal(tally.ignored, 2);
    assert.equal(h.db.countLeads(), 0);
    assert.equal(h.poller.status().ownNumber, 'owner');
    h.cleanup();
  }
});

test("(z) set: the Bona number's own chat is never read, and no lead ever carries the Bona number", async () => {
  const h = harness({ env: SPLIT, windows: [[
    msg({ id: 'B1', jid: BONA, fromMe: true, text: 'Ref BONA-W003 · K7Q2XR' }),
    // A record we sent in a privacy-mode chat whose alt is our own number (key.senderPn).
    msg({ id: 'B2', jid: '101010101010102@lid', jidAlt: BONA, fromMe: true, text: 'https://bona-real-estate.com/properties/bona-w003/' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(tally.ignored, 2);
  assert.equal(h.db.countLeads(), 0);
  const status = h.poller.status();
  assert.equal(status.instance, 'bona');
  assert.equal(status.ownNumber, 'instance');
  assert.doesNotMatch(JSON.stringify(status), /576267694|593296933/, 'status never carries a number');
  h.cleanup();
});

test("(z) set: the owner's personal chat on the Bona instance (our notes, his answers) is a team chat, never a lead", async () => {
  const note = leadNote({
    name: 'Sara', phone_e164: '966500000000', listing_id: 'BONA-W003', source: 'meta', medium: 'paid', ref: 'K7Q2XR', channel: 'whatsapp', created: NOW,
  }, { siteUrl: 'https://bona-real-estate.com' });
  let team = null;
  const h = harness({ inbox: true, env: SPLIT, isExcluded: (digits) => team.isExcludedPhone(digits), windows: [[
    msg({ id: 'P-NOTE', fromMe: true, jid: OWNER, pushName: null, ts: NOW - 90_000, text: note }),
    msg({ id: 'P-IN', jid: OWNER, pushName: 'Abdulaziz', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' }),
  ]] });
  team = h.team;
  const tally = await h.poller.tick();
  assert.equal(tally.ignored, 2);
  assert.equal(h.db.countLeads(), 0);
  assert.equal(h.sent.length, 0, 'no note about our own note');
  h.cleanup();
});

test('(z) set: a client Ref line to the Bona number is a lead and the owner gets his note, as before', async () => {
  const h = harness({ env: SPLIT, windows: [[msg({ id: 'C1', text: 'Hello\nRef BONA-W003 · K7Q2XR' })]] });
  const tally = await h.poller.tick();
  assert.equal(tally.created, 1);
  assert.equal(h.sent.length, 1);
  h.cleanup();
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
cd $WT/services && env $T run-capped node --test --test-name-pattern='^\(z\)' api/test/wa-poller.test.mjs
```

Expected: FAIL (`ownNumber` undefined; B1/B2 not ignored).

- [ ] **Step 3: Implement** (`services/api/lib/wa-poller.mjs`)

Lines 10-13, replace the paragraph with:

```js
 * Read-only, by owner decision. The instance (`BONA_WA_INSTANCE`) is Bona's own WhatsApp since
 * 2026-11-19 (before that, the owner's personal one, shared with another agent): we poll
 * `POST /chat/findMessages` and we never set a webhook. The only thing this module writes back
 * to WhatsApp is the owner's new-lead note, and only for a lead it just created.
```

Line 363:

```js
  // The instance's own number (BONA_WA_INSTANCE_JID; unset = BONA_OWNER_JID, as before the
  // split): its chat with itself is never read, and a sent record whose alt is it is ours.
  const ownerDigits = bareJid(wa.instanceJid);
```

(Keep the variable name `ownerDigits` so lines 907-919 stay byte-identical; only its source changes.)

In `status()` (line ~1100), add one field after `instance,`:

```js
      instance,
      ownNumber: wa.ownNumberFrom,
```

- [ ] **Step 4: Run the poller suite**

```bash
cd $WT/services && env $T run-capped node --test api/test/wa-poller.test.mjs 2>&1 | tail -6
```

Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git -C $WT add services/api/lib/wa-poller.mjs services/api/test/wa-poller.test.mjs
git -C $WT commit -m "feat(api): the poller skips the instance's own chat, not the owner's, once BONA_WA_INSTANCE_JID is set

/health poller.ownNumber says which (\"instance\" or \"owner\"), never the digits.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 3: index.mjs keeps the owner and the instance apart

**Files:**
- Modify: `services/api/index.mjs:208-221`, `:242-251`, `:270-272`
- Modify (comment only): `services/api/lib/inbox/ingest.mjs:12-17`, `:129-132`
- Test: `services/api/test/inbox-wiring.test.mjs` (append)

- [ ] **Step 1: Write the failing tests** (append to `services/api/test/inbox-wiring.test.mjs`)

```js
test('BONA_WA_INSTANCE_JID set: the owner stays his own number, and a sent record whose alt is the Bona number names our sender', async () => {
  const BONA = '966576267694';
  const h = build({ env: { ...ENV, BONA_WA_INSTANCE: 'bona', BONA_WA_INSTANCE_JID: `${BONA}@s.whatsapp.net` } });
  try {
    const { app, db } = h;
    const owners = db.db.prepare("SELECT phone_e164 FROM users WHERE role = 'owner' AND active = 1").all().map((r) => r.phone_e164);
    assert.deepEqual(owners, ['966593296933'], 'seeded from BONA_OWNER_JID (its default here); the Bona number gets no account');
    db.insertLead({
      lead_id: 'LEAD-client', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    const rec = (over) => ({
      id: 'X', jid: '966500000077@s.whatsapp.net', jidAlt: null, fromMe: true, ts: NOW - 1000, text: 'on my way', pushName: null,
      contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false, ...over,
    });
    // Typed on the Bona phone: its own number as the alt names the sender; the owner becomes the handler.
    assert.deepEqual(await app.ingest.ingest(db.getLead('LEAD-client'), rec({ id: 'BONA-1', jidAlt: `${BONA}@s.whatsapp.net` })),
      { stored: true, inserted: true, senderKind: 'owner_number' });
    assert.equal(db.getLead('LEAD-client').handler_user_id, app.team.getUserByPhone('966593296933').user_id);
    // The owner's personal number is no longer our own: a sent record naming it is his chat, a team chat.
    assert.deepEqual(await app.ingest.ingest(db.getLead('LEAD-client'), rec({ id: 'OWN-2', jidAlt: '966593296933@s.whatsapp.net' })),
      { stored: false, reason: 'excluded' });
  } finally {
    await h.close();
  }
});

test('a BONA_WA_INSTANCE_JID that is not a phone jid is said out loud at start-up (no value logged), and the app still builds', async () => {
  const h = build({ env: { ...ENV, BONA_WA_INSTANCE_JID: 'bona@s.whatsapp.net' } });
  try {
    const line = h.logs.find((l) => l.evt === 'wa.instance_jid_invalid');
    assert.ok(line && line.level === 'error');
    assert.doesNotMatch(JSON.stringify(line), /bona@/);
  } finally {
    await h.close();
  }
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
cd $WT/services && env $T run-capped node --test --test-name-pattern='BONA_WA_INSTANCE_JID' api/test/inbox-wiring.test.mjs
```

Expected: FAIL (the BONA-1 record is refused `excluded`; no `wa.instance_jid_invalid` line).

- [ ] **Step 3: Implement** (`services/api/index.mjs`)

At line 213, before `team.ensureOwner(...)`, read the config once:

```js
  const wa = waConfig(cfg.env ?? {});
  try {
    team.ensureOwner({ phone: bareJid(wa.ownerJid), name: cfg.env?.BONA_OWNER_NAME ?? 'Abdulaziz' });
```

(the `try {` and the `catch` below stay as they are; only `waConfig(cfg.env ?? {}).ownerJid` becomes `wa.ownerJid`).

Replace lines 242-251 with:

```js
  // The owner (BONA_OWNER_JID): the handler of a chat typed on the instance's phone. Looked up
  // on every call, so a change on the Team page is seen at once.
  const ownerDigits = bareJid(wa.ownerJid);
  // The instance's own number (BONA_WA_INSTANCE_JID; unset = the owner's, as before the split):
  // a sent record whose alt is this number names its sender, not the chat.
  const selfDigits = bareJid(wa.instanceJid);
  if (wa.ownNumberFrom === 'instance' && !/^\d{8,15}$/.test(selfDigits)) {
    log({ level: 'error', evt: 'wa.instance_jid_invalid' });
  }
  const ownerUserId = () => {
    const owner = ownerDigits ? team.getUserByPhone(ownerDigits) : null;
    return owner && owner.active && owner.role === 'owner' ? owner.user_id : null;
  };
```

Line 271, `ownerPhone: ownerDigits || null` becomes:

```js
    db, inbox: inboxStore, ownerUserId, ownerPhone: selfDigits || null, isExcludedLead: excludedLead, log, now: clock,
```

`services/api/lib/inbox/ingest.mjs` doc only: line 15-16 "That number is the instance's own (`ownerPhone`)" stays; lines 129-130 become:

```js
 * @param {string|(() => string|null)|null} [o.ownerPhone] the instance's own number (digits,
 *        from `BONA_WA_INSTANCE_JID`, else `BONA_OWNER_JID`): a sent record's alt that is this number names the sender, not
```

- [ ] **Step 4: Run the wiring, ingest and dashboard suites**

```bash
cd $WT/services && env $T run-capped node --test --test-concurrency=4 api/test/inbox-wiring.test.mjs api/test/inbox-ingest.test.mjs api/test/dashboard-auth.test.mjs api/test/team.test.mjs
```

Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git -C $WT add services/api/index.mjs services/api/lib/inbox/ingest.mjs services/api/test/inbox-wiring.test.mjs
git -C $WT commit -m "feat(api): ingest names our sender by the instance's number; the owner seed and handler stay BONA_OWNER_JID

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 4: The sender keeps the owner's escape and adds the instance to the budget exemption

**Files:**
- Modify: `services/api/lib/wa-send.mjs:20-31` (doc), `:121-124`, `:216-235`
- Modify: `services/api/lib/inbox/store.mjs:306-316`
- Test: `services/api/test/wa-send.test.mjs`, `services/api/test/inbox-store.test.mjs` (append)

- [ ] **Step 1: Write the failing tests**

Append to `services/api/test/wa-send.test.mjs`:

```js
/* ---------------- Bona's own number (BONA_WA_INSTANCE_JID, 2026-11-19) ---------------- */

const BONA_JID = '966576267694@s.whatsapp.net';
const SPLIT_ENV = { ...ENV, BONA_WA_INSTANCE: 'bona', BONA_WA_INSTANCE_JID: BONA_JID };

test("split: the owner's personal number keeps its login-code bypass; the Bona number gets none", async () => {
  const h = harness({ env: SPLIT_ENV });
  h.team.setSetting('sending_enabled', '0');
  assert.equal((await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code', bypassSwitch: true })).ok, true);
  assert.deepEqual(await h.sender.sendTo({ jid: BONA_JID, text: 'x', kind: 'code', bypassSwitch: true }), { ok: false, error: 'sending_disabled' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'http://evo.test/message/sendText/bona', 'sent from the Bona instance');
  assert.equal(h.calls[0].body.number, '966593296933', "to the owner's personal phone");
  h.s.close();
});

test('split: a full day stops everyone but the owner and the Bona number, both still capped per recipient', async () => {
  const h = harness({ env: SPLIT_ENV });
  seedOutbox(h, SEND_PER_DAY, { created: NOW - 60_000 });
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  assert.equal((await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code', bypassSwitch: true })).ok, true);
  assert.equal((await h.sender.sendTo({ jid: BONA_JID, text: 'x', kind: 'code' })).ok, true);
  for (let i = 1; i < PER_RECIPIENT_PER_MIN; i += 1) assert.equal((await h.sender.sendTo({ jid: BONA_JID, text: 'x', kind: 'code' })).ok, true);
  assert.deepEqual(await h.sender.sendTo({ jid: BONA_JID, text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  h.s.close();
});

test('split: rows to the owner and to the Bona number do not count toward the 500', async () => {
  const h = harness({ env: SPLIT_ENV });
  seedOutbox(h, SEND_PER_DAY, { jid: OWNER_JID, kind: 'code' });
  seedOutbox(h, SEND_PER_DAY, { jid: BONA_JID, kind: 'code' });
  assert.equal((await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a' })).ok, true);
  h.s.close();
});
```

Append to `services/api/test/inbox-store.test.mjs` (same `harness`/`out` helpers as the test at line 499):

```js
test('countSentSince can leave two jids out: the owner\'s and the instance\'s own', () => {
  const { s, inbox, at } = harness();
  at(NOW);
  inbox.insertOutbox(out({ send_id: 'SND-a', jid: '966500000002@s.whatsapp.net', status: 'accepted' }));
  inbox.insertOutbox({ send_id: 'SND-own', jid: OWNER_JID, sender_kind: 'code', status: 'accepted' });
  inbox.insertOutbox({ send_id: 'SND-self', jid: '966576267694@s.whatsapp.net', sender_kind: 'code', status: 'accepted' });
  assert.equal(inbox.countSentSince(NOW - DAY), 3);
  assert.equal(inbox.countSentSince(NOW - DAY, { excludeJids: [OWNER_JID, '966576267694@s.whatsapp.net'] }), 1);
  assert.equal(inbox.countSentSince(NOW - DAY, { excludeJids: [OWNER_JID, OWNER_JID] }), 2, 'a repeated jid is one jid');
  assert.equal(inbox.countSentSince(NOW - DAY, { excludeJid: OWNER_JID }), 2, 'the one-jid form still works');
  assert.throws(() => inbox.countSentSince(NOW - DAY, { excludeJids: ['a', 'b', 'c'] }), TypeError);
  s.close();
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
cd $WT/services && env $T run-capped node --test --test-name-pattern='split:|two jids' api/test/wa-send.test.mjs api/test/inbox-store.test.mjs
```

Expected: FAIL (Bona-number code rate-limited on a full day; `excludeJids` ignored).

- [ ] **Step 3: Implement**

`services/api/lib/inbox/store.mjs`, replace lines 306-316:

```js
  /**
   * Sends that may have gone since `sinceTs` — the durable day cap (P2-4). A failed send
   * never reached WhatsApp, so it does not count; an uncertain one may have. `excludeJid` /
   * `excludeJids` (at most two) leave out the chats outside the shared budget: the owner's
   * and the instance's own (one jid while BONA_WA_INSTANCE_JID is unset).
   */
  function countSentSince(sinceTs, { excludeJid = null, excludeJids = [] } = {}) {
    const ex = [...new Set([excludeJid, ...excludeJids].map(str).filter(Boolean))];
    if (ex.length > 2) throw new TypeError('countSentSince: at most two excluded jids');
    const [a = null, b = null] = ex;
    return prep(`SELECT COUNT(*) AS n FROM wa_outbox
                 WHERE status IN ('pending','accepted','uncertain') AND created >= ?
                   AND (? IS NULL OR jid != ?) AND (? IS NULL OR jid != ?)`)
      .get(num(sinceTs), a, a, b, b).n;
  }
```

`services/api/lib/wa-send.mjs`, replace lines 121-124:

```js
  const cfg = waConfig(env);
  // The switch bypass is the owner's (BONA_OWNER_JID): his login code must always get through,
  // or he could never switch sending back on. Outside the shared budget: his number and the
  // instance's own (BONA_WA_INSTANCE_JID) — one number while that is unset, as before the split.
  const ownerDigits = bareDigits(cfg.ownerJid);
  const unbudgeted = new Set([ownerDigits, bareDigits(cfg.instanceJid)].filter(Boolean));
  // The outbox holds bare jids, so these are compared in that form too.
  const unbudgetedJids = [...unbudgeted].map((d) => `${d}@s.whatsapp.net`);
```

Replace lines 216 and 226-235 (`isOwner` keeps its meaning for the bypass):

```js
    const isOwner = m[1] === ownerDigits;
```

```js
    const free = unbudgeted.has(m[1]);
    const gates = free
      ? [[perRecipient, `send:to:${m[1]}`]]
      : [[perMinute, 'send:minute'], [perRecipient, `send:to:${m[1]}`], ...(userId ? [[perUser, `send:user:${userId}`]] : [])];
    let dayFull = false;
    if (!free) {
      const since = now() - DAY_MS;
      // The caller's own `pending` row is already in the count; it is this send, not an earlier one.
      const own = givenRow && givenRow.created >= since && !unbudgetedJids.includes(givenRow.jid) ? 1 : 0;
      dayFull = inbox.countSentSince(since, { excludeJids: unbudgetedJids }) - own >= SEND_PER_DAY;
    }
```

Doc block lines 20-31: replace "the recipient IS the owner's own jid (`cfg.ownerJid`)" with "the recipient IS the owner's jid (`BONA_OWNER_JID`)", and "Messages to the owner's own jid skip the shared per-minute and daily budget" with "Messages to the owner's jid and to the instance's own number (`BONA_WA_INSTANCE_JID`, the same number while that is unset) skip the shared per-minute and daily budget". Line 2: "Messages from the owner's WhatsApp" becomes "Messages from the WhatsApp instance (`BONA_WA_INSTANCE`; Bona's own number since 2026-11-19)".

- [ ] **Step 4: Run the sender, store, dashboard and Dana suites**

```bash
cd $WT/services && env $T run-capped node --test --test-concurrency=4 api/test/wa-send.test.mjs api/test/inbox-store.test.mjs api/test/dashboard-inbox.test.mjs api/test/dana-wa.test.mjs
```

Expected: `fail 0` (the existing 477/501 tests still prove the unset behaviour).

- [ ] **Step 5: Commit**

```bash
git -C $WT add services/api/lib/wa-send.mjs services/api/lib/inbox/store.mjs services/api/test/wa-send.test.mjs services/api/test/inbox-store.test.mjs
git -C $WT commit -m "feat(api): the instance's own number joins the owner's outside the shared send budget

The Sending-switch bypass stays the owner's login code (BONA_OWNER_JID).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 5: No env default can set the split; drop a dead default

**Files:**
- Modify: `services/api/retell/provision.mjs:371-375` (comment)
- Modify: `services/api/lib/config.mjs:96` (delete)
- Test: `services/api/test/provision.test.mjs` (append; add `ensureEnvFile` to the import at lines 9-14)

- [ ] **Step 1: Write the test**

```js
test('ensureEnvFile never writes BONA_WA_INSTANCE_JID: its absence is the rollback state', () => {
  const { home, cleanup } = tempHome();
  try {
    const first = ensureEnvFile({ home, env: {} });
    assert.ok(!first.keys.includes('BONA_WA_INSTANCE_JID'));
    const again = ensureEnvFile({ home, env: {} });
    assert.ok(!(again.added ?? []).includes('BONA_WA_INSTANCE_JID'));
    assert.doesNotMatch(fs.readFileSync(first.file, 'utf8'), /^BONA_WA_INSTANCE_JID=/m);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run it** (it passes already; it is a guard that must keep passing)

```bash
cd $WT/services && env $T run-capped node --test --test-name-pattern='ensureEnvFile never' api/test/provision.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Comment and delete**

`provision.mjs` above `BONA_WA_INSTANCE: 'abdulaziz-personal',` add:

```js
    // Top-up defaults only (an existing key is never touched). The PC file is shared with
    // bona-intake, which reads the owner's personal instance. BONA_WA_INSTANCE_JID is never
    // defaulted: unset means "the owner's number", the state before the 2026-11-19 move.
```

`config.mjs`: delete line 96 `    waNumber: env.BONA_WHATSAPP ?? '966593296933',`.

- [ ] **Step 4: Run**

```bash
cd $WT/services && env $T run-capped node --test --test-concurrency=4 api/test/provision.test.mjs api/test/config.test.mjs api/test/http.test.mjs
git -C $WT grep -n 'waNumber\|BONA_WHATSAPP' -- services
```

Expected: tests pass; the grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git -C $WT add services/api/retell/provision.mjs services/api/lib/config.mjs services/api/test/provision.test.mjs
git -C $WT commit -m "chore(api): no default ever sets BONA_WA_INSTANCE_JID; drop the unused waNumber default

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 6: Dashboard copy names Bona's number, not "your number"

**Files:**
- Modify: `services/api/lib/dashboard/render-team.mjs:72,93,95,96,101`, `render-inbox.mjs:230,260-263`, `render.mjs:784`
- Test: `services/api/test/dashboard-render-inbox.test.mjs:206,216-217`

- [ ] **Step 1: Update the tests first**

`dashboard-render-inbox.test.mjs:206`: `Your number` becomes `Bona&#39;s phone`. Lines 216-217 become:

```js
  assert.match(asStaff, /<bdi>Bona&#39;s phone<\/bdi>/);
  assert.doesNotMatch(asStaff, /Your number|Owner&#39;s number/);
```

Then `git -C $WT grep -n "from your number\|Sending from your WhatsApp\|Chats on your number\|Your number\|Owner's number" -- services/api/test` and update any other hit the same way.

- [ ] **Step 2: Run to see them fail**

```bash
cd $WT/services && env $T run-capped node --test api/test/dashboard-render-inbox.test.mjs 2>&1 | tail -5
```

Expected: FAIL.

- [ ] **Step 3: Edit the copy** (exact strings)

`render-team.mjs`:
- 72: `…a 6-digit code sent to their own WhatsApp from Bona's WhatsApp number, and sees the same dashboard you do. Only owners see this page.</p>`
- 93: `<h2 style="margin-top:28px">Sending from Bona's WhatsApp</h2>`
- 95: `? "On. The dashboard may send login codes to your team (and, later, replies to clients) from Bona's WhatsApp number."`
- 96: `: "Off. Nothing is sent from Bona's WhatsApp number except your own login code."}</p>`
- 101: `? "On. Everyone on the team can answer Bona inbox chats from the dashboard; the reply goes from Bona's WhatsApp number (while sending above is on)."`

`render-inbox.mjs`:
- 230: `<p class="sub">Chats on Bona's WhatsApp number that talk about property but carry nothing that says Bona: …` (rest unchanged)
- 260-263:

```js
function senderLabel(kind, userId, { names }) {
  if (kind === 'client') return 'Client';
  if (kind === 'dana') return 'Dana';
  if (kind === 'owner_number') return "Bona's phone";
```

`render.mjs:784`: `reply_rate_limited: "Too many messages from Bona's WhatsApp number this minute. Wait a minute and send again.",`

- [ ] **Step 4: Run the dashboard suites**

```bash
cd $WT/services && env $T run-capped node --test --test-concurrency=4 api/test/dashboard-*.test.mjs
```

Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git -C $WT add services/api/lib/dashboard services/api/test
git -C $WT commit -m "fix(dashboard): name Bona's WhatsApp number instead of \"your number\"

True before and after the move; the bubble label for a message typed on the instance phone is \"Bona's phone\".

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 7: `sync-secrets.sh` keeps the VPS's own WhatsApp lines

**Files:**
- Modify: `services/deploy/vps/lib.sh` (after line 45), `services/deploy/vps/sync-secrets.sh` (whole file)
- Modify: `services/api/test/fixtures/vps-shims/ssh`, `services/api/test/fixtures/vps-shims/scp`
- Test: `services/api/test/vps-deploy.test.mjs` (append after the test at line 464)

- [ ] **Step 1: Write the failing tests** (append to `vps-deploy.test.mjs`)

```js
// ---------------------------------------------------------------- sync-secrets keeps the VPS's WhatsApp lines (2026-11-19)
const keepRun = (pc, vps) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bona-keep-'));
  writeFileSync(path.join(dir, 'pc'), pc);
  writeFileSync(path.join(dir, 'vps'), vps);
  const r = bash(['-c', '. ./lib.sh; keep_vps_keys "$1" "$2" "$3"', 'keep', path.join(dir, 'pc'), path.join(dir, 'vps'), path.join(dir, 'out')], { env: { HOME: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '', 'prints nothing');
  return readFileSync(path.join(dir, 'out'), 'utf8');
};

test('keep_vps_keys: the VPS line wins in place, other PC lines keep their order, a key only the VPS has is appended', () => {
  const pc = 'A=1\nBONA_WA_INSTANCE=abdulaziz-personal\nBONA_OWNER_JID=owner\n# BONA_WA_INSTANCE=commented\nZ=9\n';
  const vps = 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n';
  assert.equal(keepRun(pc, vps), 'A=1\nBONA_WA_INSTANCE=bona\nBONA_OWNER_JID=owner\n# BONA_WA_INSTANCE=commented\nZ=9\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n');
});

test('keep_vps_keys: nothing on the VPS means the PC file as it is; a key the VPS lacks keeps the PC line; export is understood', () => {
  const pc = 'A=1\nexport BONA_WA_INSTANCE=abdulaziz-personal\n';
  assert.equal(keepRun(pc, ''), pc);
  assert.equal(keepRun(pc, 'BONA_WA_INSTANCE_JID=x@s.whatsapp.net\n'), `${pc}BONA_WA_INSTANCE_JID=x@s.whatsapp.net\n`);
  assert.equal(keepRun(pc, 'export BONA_WA_INSTANCE=bona\n'), 'A=1\nexport BONA_WA_INSTANCE=bona\n');
});

function syncHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  mkdirSync(path.join(home, '.secrets'), { recursive: true });
  mkdirSync(path.join(home, '.cloudflared'), { recursive: true });
  for (const f of ['retell.env', 'evolution-api.env', 'bona-marketing.env']) writeFileSync(path.join(home, '.secrets', f), 'X=1\n');
  writeFileSync(path.join(home, '.secrets', 'bona-services.env'), 'X=1\nBONA_WA_INSTANCE=abdulaziz-personal\n');
  writeFileSync(path.join(home, '.cloudflared', '9022fbec-de4f-44b9-805e-8fff285d6263.json'), '{}');
  const log = path.join(home, 'shim.log');
  writeFileSync(log, '');
  const capture = path.join(home, 'captured');
  mkdirSync(capture);
  return { home, log, capture };
}

test('sync-secrets.sh copies bona-services.env with the VPS\'s own WhatsApp lines, reads them before any copy, prints no value, leaves no temp file', () => {
  const { home, log, capture } = syncHome();
  const r = bash([path.join(VPS, 'sync-secrets.sh')], { env: {
    PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_SSH: 'fake-vps', SHIM_SCP_CAPTURE: capture,
    SHIM_VPS_KEEP_LINES: 'BONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net',
  } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(path.join(capture, 'bona-services.env'), 'utf8'), 'X=1\nBONA_WA_INSTANCE=bona\nBONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net\n');
  assert.equal(readFileSync(path.join(capture, 'retell.env'), 'utf8'), 'X=1\n', 'the other files go verbatim');
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const readAt = lines.findIndex((l) => /^ssh fake-vps .*grep -E .*BONA_WA_INSTANCE\|BONA_WA_INSTANCE_JID/.test(l));
  const firstScp = lines.findIndex((l) => /^scp /.test(l));
  assert.ok(readAt >= 0 && readAt < firstScp, lines.join('\n'));
  assert.doesNotMatch(r.stdout + r.stderr, /abdulaziz-personal|576267694|=bona/);
  assert.deepEqual(readdirSync(path.join(home, '.secrets')).filter((f) => f.startsWith('.')), [], 'no temp file left behind');
});

test('sync-secrets.sh copies nothing when the VPS lines cannot be read', () => {
  const { home, log } = syncHome();
  const r = bash([path.join(VPS, 'sync-secrets.sh')], { env: {
    PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_SSH: 'fake-vps', SHIM_VPS_KEEP_FAIL: '1',
  } });
  assert.notEqual(r.status, 0);
  assert.ok(!readFileSync(log, 'utf8').split('\n').some((l) => /^scp /.test(l)), 'no scp after a failed read');
  assert.deepEqual(readdirSync(path.join(home, '.secrets')).filter((f) => f.startsWith('.')), []);
});

test('sync-secrets.sh --dry-run names the kept keys and contacts nothing', () => {
  const { home, log } = syncHome();
  const r = bash([path.join(VPS, 'sync-secrets.sh'), '--dry-run'], { env: { PATH: `${SHIMS}:${process.env.PATH}`, HOME: home, SHIM_LOG: log, BONA_VPS_SSH: 'fake-vps' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BONA_WA_INSTANCE BONA_WA_INSTANCE_JID/);
  assert.equal(readFileSync(log, 'utf8'), '');
});
```

- [ ] **Step 2: Run to see them fail**

```bash
cd $WT/services && env $T run-capped node --test --test-name-pattern='keep_vps_keys|sync-secrets' api/test/vps-deploy.test.mjs
```

Expected: FAIL (`keep_vps_keys: command not found`, the verbatim copy).

- [ ] **Step 3: Implement**

`services/deploy/vps/lib.sh`, after line 45 (`SECRET_FILES=…`):

```bash
# bona-services.env is not copied verbatim (2026-11-19): the PC copy keeps the owner's personal
# WhatsApp instance for bona-intake, while the VPS reads Bona's own. For these keys the VPS's
# own line wins; a verbatim copy would silently undo the move (A2Z go-live item 7).
VPS_KEEP_FILE="bona-services.env"
VPS_KEEP_KEYS="BONA_WA_INSTANCE BONA_WA_INSTANCE_JID"
```

and next to the other helpers (after `need()`):

```bash
# The remote command that prints the VPS's own VPS_KEEP_KEYS lines of VPS_KEEP_FILE: nothing
# when the file is missing or has none, exit status 1 when grep itself fails.
vps_keep_grep() {
  local alt; alt=$(printf '%s' "$VPS_KEEP_KEYS" | tr ' ' '|')
  printf '%s' "f=~/.secrets/$VPS_KEEP_FILE; [ -e \"\$f\" ] || exit 0; grep -E '^[[:space:]]*(export[[:space:]]+)?($alt)=' \"\$f\"; [ \$? -le 1 ]"
}

# keep_vps_keys PC_FILE VPS_LINES OUT: OUT is PC_FILE, except that a VPS_KEEP_KEYS line the VPS
# has (VPS_LINES) stands in place of the PC's line for that key, or is appended when the PC has
# none; a kept key the VPS lacks keeps the PC's line. Prints nothing.
keep_vps_keys() {
  awk -v keys="$VPS_KEEP_KEYS" -v vpsfile="$2" '
    function key(line,  k) { k = line; sub(/^[ \t]*(export[ \t]+)?/, "", k); if (k !~ /=/) return ""; sub(/[ \t]*=.*/, "", k); return k }
    BEGIN { n = split(keys, list, " "); for (i = 1; i <= n; i++) want[list[i]] = 1 }
    FILENAME == vpsfile { k = key($0); if (k in want) vps[k] = $0; next }
    { k = key($0)
      if ((k in want) && (k in vps)) { if (!(k in done)) { print vps[k]; done[k] = 1 }; next }
      print }
    END { for (i = 1; i <= n; i++) { k = list[i]; if ((k in vps) && !(k in done)) print vps[k] } }
  ' "$2" "$1" > "$3"
}
```

(`FILENAME == vpsfile`, not `NR == FNR`: with an empty VPS file the classic idiom would treat the PC lines as VPS lines.)

`services/deploy/vps/sync-secrets.sh`, whole file:

```bash
#!/usr/bin/env bash
# Run ON THE PC. Copies the four ~/.secrets/*.env files and the tunnel credentials JSON to the VPS,
# mode 0600, without ever printing their contents. Re-run any time a secret changes on the PC.
# bona-services.env keeps the VPS's own lines for $VPS_KEEP_KEYS (lib.sh): since 2026-11-19 the
# VPS reads Bona's own WhatsApp while the PC copy keeps the owner's personal one for bona-intake.
#   sync-secrets.sh            copy
#   sync-secrets.sh --dry-run  list what would be copied
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need scp; need ssh; need awk

DRY=0; [ "${1:-}" = --dry-run ] && DRY=1
files=()
for f in $SECRET_FILES; do
  [ -f "$SECRETS_DIR/$f" ] || die "missing $SECRETS_DIR/$f on this machine"
  [ "$f" = "$VPS_KEEP_FILE" ] || files+=("$SECRETS_DIR/$f")
done
[ -f "$CF_DIR/$BONA_TUNNEL_ID.json" ] || die "missing tunnel credentials $CF_DIR/$BONA_TUNNEL_ID.json"

say "Secrets to copy to $BONA_VPS_SSH"
for f in "${files[@]}" "$SECRETS_DIR/$VPS_KEEP_FILE" "$CF_DIR/$BONA_TUNNEL_ID.json"; do echo "  $f ($(stat -c %s "$f") bytes)"; done
echo "  $VPS_KEEP_FILE keeps the VPS's own lines for: $VPS_KEEP_KEYS"
[ "$DRY" = 1 ] && { ok "dry run, nothing copied"; exit 0; }

umask 077
keep=$(mktemp "$SECRETS_DIR/.vps-keep.XXXXXX")
merged=$(mktemp "$SECRETS_DIR/.$VPS_KEEP_FILE.sync.XXXXXX")
trap 'rm -f "$keep" "$merged"' EXIT

ssh "$BONA_VPS_SSH" 'install -d -m 700 ~/.secrets ~/.cloudflared'
# The VPS's own lines for the kept keys, into a 0600 file: never echoed, never logged.
ssh "$BONA_VPS_SSH" "$(vps_keep_grep)" > "$keep" || die "could not read the VPS's own $VPS_KEEP_FILE lines; nothing copied"
keep_vps_keys "$SECRETS_DIR/$VPS_KEEP_FILE" "$keep" "$merged"
kept=$(grep -c . "$keep" || true)
scp -q -p "${files[@]}" "$BONA_VPS_SSH:.secrets/"
scp -q -p "$merged" "$BONA_VPS_SSH:.secrets/$VPS_KEEP_FILE"
scp -q -p "$CF_DIR/$BONA_TUNNEL_ID.json" "$BONA_VPS_SSH:.cloudflared/"
remote=""
for f in $SECRET_FILES; do remote="$remote ~/.secrets/$f"; done   # only the files this script copies, never a glob
ssh "$BONA_VPS_SSH" "chmod 600$remote ~/.cloudflared/$BONA_TUNNEL_ID.json && ls -l ~/.secrets ~/.cloudflared | sed 's/^/  /'"
ok "copied ($kept line(s) of $VPS_KEEP_FILE kept from the VPS); now run install-vps.sh --check on the VPS"
```

`services/api/test/fixtures/vps-shims/ssh`: add to the header comment `#   …grep -E… (sync-secrets' read of the kept keys) → prints $SHIM_VPS_KEEP_LINES; exit 255 with SHIM_VPS_KEEP_FAIL=1`, and before the final `*)` case:

```bash
  *grep\ -E*)
    [ "${SHIM_VPS_KEEP_FAIL:-0}" = 1 ] && { echo "ssh: connect to host fake-vps port 22: Connection refused (shim)" >&2; exit 255; }
    [ -n "${SHIM_VPS_KEEP_LINES:-}" ] && printf '%s\n' "$SHIM_VPS_KEEP_LINES"
    exit 0 ;;
```

`services/api/test/fixtures/vps-shims/scp`: add to the header `# SHIM_SCP_CAPTURE=DIR (tests): a local → remote copy is also copied into DIR, under the remote file name when the destination names one (host:dir/NAME), else under the source's name.`, and replace `case "$dest" in *:*) exit 0 ;; esac` with:

```bash
case "$dest" in
  *:*)
    if [ -n "${SHIM_SCP_CAPTURE:-}" ]; then
      rpath=${dest#*:}
      for src in "${args[@]:0:${#args[@]}-1}"; do
        if [ -z "$rpath" ] || [ "${rpath%/}" != "$rpath" ]; then name=$(basename "$src"); else name=$(basename "$rpath"); fi
        cp "$src" "$SHIM_SCP_CAPTURE/$name"
      done
    fi
    exit 0 ;;
esac
```

- [ ] **Step 4: Run the whole deploy suite** (includes `bash -n` of every script and the secret-value scan)

```bash
cd $WT/services && env $T run-capped node --test api/test/vps-deploy.test.mjs 2>&1 | tail -6
```

Expected: `fail 0`, including the existing `sync-secrets.sh chmods the four named secret files` test.

- [ ] **Step 5: Commit**

```bash
git -C $WT add services/deploy/vps/lib.sh services/deploy/vps/sync-secrets.sh services/api/test/fixtures/vps-shims services/api/test/vps-deploy.test.mjs
git -C $WT commit -m "fix(deploy): sync-secrets keeps the VPS's own BONA_WA_INSTANCE / BONA_WA_INSTANCE_JID

A verbatim copy of the PC env (which keeps the personal instance for bona-intake) would silently
undo the WhatsApp move. Fails closed when the VPS lines cannot be read.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 8: The public number switch: site data, privacy notice and FAQ (one commit; privacy/FAQ text is a CANDIDATE)

`site.json` and the policy have to change together: `scripts/test/privacy-policy.test.mjs:77-80` reads `site.whatsapp.display` from `site.json` and looks for it in the policy, so either half alone is red. The privacy and FAQ strings are in **Appendix A**; they are a candidate, and the owner must OK the EN and AR text before the branch is merged (approvals 2026-11-19). The dated change line and `updated` use 2026-11-19; at cutover set both to the merge day (Appendix B, step B3).

**Files:**
- Modify: `src/data/site.json:19-23` (the `whatsapp` block only; `phone` at `:24-27` stays), `marketing/page-meta.json:9-10,135-136`, `public/site.webmanifest:22`, `src/data/content-calendar.json:16-17`, `src/data/integrations.json:81-86,228`, `scripts/og/gen-llms.mjs:246`, `services/intake/rebrand_pdf.py:15,419-420`, `src/data/LISTING-SCHEMA.md:154`
- Modify: `src/data/privacy.json` (lines 2, 21, 25, 77, 78, 84, 85, 100, 105, 171, 178, the new section after `ai-concierge`, the `changes` body, 289, 290), `src/data/faq.json:206-214` (entry `contact`)
- Create: `scripts/test/contact-numbers.test.mjs`
- Test: `scripts/test/privacy-policy.test.mjs` (append), `test/seo-jsonld.test.mjs:386`, `services/intake/test/brochure.test.mjs:26-27,301,312`

- [ ] **Step 1: Write the guard test** (`scripts/test/contact-numbers.test.mjs`)

```js
// Every hand copy of Bona's contact numbers agrees with src/data/site.json (2026-11-19 WhatsApp move).
// site.whatsapp moved to Bona's own number; site.phone stays until Phase 3. A wa.me link is always
// the WhatsApp number, and any Saudi mobile number written out is one of the two.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const site = JSON.parse(read('src/data/site.json'));
const digits = (s) => String(s).replace(/\D/g, '');
const WA = site.whatsapp.wa;
const PHONE = digits(site.phone.e164);
// The repo's example numbers (+966 50 000 00xx), as in the comment at services/api/lib/tools.mjs:62.
const EXAMPLE = /^9665000000\d\d$/;

const FILES = [
  'src/data/faq.json', 'src/data/privacy.json', 'src/data/content-calendar.json', 'src/data/integrations.json',
  'marketing/page-meta.json', 'public/site.webmanifest', 'services/api/retell/prompt.md',
  'services/api/lib/tools.mjs', 'services/api/index.mjs', 'services/intake/rebrand_pdf.py',
];

test('site.json: the three WhatsApp fields name one number', () => {
  assert.equal(digits(site.whatsapp.e164), WA);
  assert.equal(digits(site.whatsapp.display), WA);
  assert.match(WA, /^9665\d{8}$/);
});

test('every wa.me link in the hand copies is site.whatsapp, every Saudi mobile written out is site.whatsapp or site.phone', () => {
  for (const f of FILES) {
    const text = read(f);
    for (const m of text.matchAll(/wa\.me\/(\d+)/g)) assert.equal(m[1], WA, `${f}: wa.me/${m[1]}`);
    for (const m of text.matchAll(/(?:\+|00)?966[\s -]?5\d(?:[\s -]?\d){7}/g)) {
      const n = digits(m[0]);
      assert.ok([WA, PHONE].includes(n) || EXAMPLE.test(n), `${f}: ${m[0]} is neither site.whatsapp nor site.phone`);
    }
  }
});

test('the WhatsApp-only hand copies no longer name the phone number', () => {
  assert.notEqual(WA, PHONE, 'this branch moves WhatsApp only');
  for (const f of ['src/data/content-calendar.json', 'marketing/page-meta.json', 'public/site.webmanifest', 'src/data/integrations.json']) {
    assert.ok(!read(f).includes(PHONE) && !read(f).includes(site.phone.display), `${f} still names the phone number as WhatsApp`);
  }
});
```

- [ ] **Step 2: Write the privacy tests** (append to `scripts/test/privacy-policy.test.mjs`)

```js
test('the AI phone assistant section: who answers, the recording, where the voice goes, how long audio is kept, how to have it deleted', () => {
  const s = section('ai-phone-line');
  assert.ok(s, 'the WhatsApp number is public and callable, and calls to it reach the AI line (design §8)');
  const ids = policy.sections.map((x) => x.id);
  assert.equal(ids.indexOf('ai-phone-line'), ids.indexOf('ai-concierge') + 1);
  const en = body(s, 'en');
  const ar = body(s, 'ar');
  for (const text of [en, ar]) assert.ok(text.includes(site.whatsapp.display), 'the number it answers');
  assert.match(en, /an AI system, not a person/);
  assert.match(en, /the call is recorded/);
  assert.match(en, /sent to OpenAI/);
  assert.match(en, /outside Saudi Arabia/);
  assert.match(en, /up to 90 days/);
  assert.match(en, /no audio recording is kept/);
  assert.match(ar, /الذكاء الاصطناعي/);
  assert.match(ar, /مسجّلة/);
  assert.match(ar, /OpenAI/);
  assert.match(ar, /خارج المملكة/);
  assert.match(ar, /تسعون يوماً/);
  assert.match(ar, /فلا يُحتفظ بأي تسجيل صوتي/);
  assert.match(body(section('sharing'), 'en'), /OpenAI for the AI phone assistant/);
  assert.match(body(section('sharing'), 'ar'), /OpenAI للمساعدة الهاتفية/);
});

test("dashboard replies are said to come from the site's WhatsApp number", () => {
  const s = section('whatsapp-conversations');
  assert.ok(body(s, 'en').includes(`come from Bona’s WhatsApp number, ${site.whatsapp.display}`));
  assert.ok(body(s, 'ar').includes(`من رقم واتساب بونا ${site.whatsapp.display}`));
});
```

- [ ] **Step 3: Run both to see them fail**

```bash
cd $WT && env $T run-capped node --test scripts/test/contact-numbers.test.mjs scripts/test/privacy-policy.test.mjs 2>&1 | tail -8
```

Expected: FAIL (`WA === PHONE` today; no `ai-phone-line` section).

- [ ] **Step 4: Edit the site data**

`src/data/site.json` lines 19-23:

```json
  "whatsapp": {
    "e164": "+966576267694",
    "display": "+966 57 626 7694",
    "wa": "966576267694"
  },
```

`marketing/page-meta.json`: in lines 9, 10, 135 and 136 replace `+966 59 329 6933` with `+966 57 626 7694` (all four are WhatsApp mentions: "WhatsApp +966 …", "واتساب +966 …").

`public/site.webmanifest:22`: `{ "name": "WhatsApp", "url": "https://wa.me/966576267694" }`

`src/data/content-calendar.json:16-17`: `WhatsApp +966 59 329 6933 · link in bio.` becomes `WhatsApp +966 57 626 7694 · link in bio.`; `واتساب +966 59 329 6933 · الرابط في البايو.` becomes `واتساب +966 57 626 7694 · الرابط في البايو.`

`src/data/integrations.json` lines 81-86:

```json
    "name": "WhatsApp +966 57 626 7694",
    "status": "live",
    "owner": "owner",
    "action": "Website deep links and the read-only Bona lead poller use Bona's own WhatsApp Business number; account-side Business profile completeness remains unverified.",
    "link": "https://wa.me/966576267694",
    "detail": "Bona enquiries use +966 57 626 7694, Bona's own WhatsApp Business; Evolution and the lead poller read it.",
```

line 228: `"detail": "Evolution API answers HTTP 200 v2.3.7 at https://wa-api.azoz.uk; instance set",`

`scripts/og/gen-llms.mjs:246`, replace the one line with two:

```js
- WhatsApp: ${site.whatsapp.display} — ${wa}
- Phone: ${site.phone.display}
```

`services/intake/rebrand_pdf.py`: line 15 `<site host> · +966 59 329 6933 · FAL 1100313556 · <listing id>` becomes `<site host> · <site.json whatsapp.display> · FAL 1100313556 · <listing id>`; lines 419-420 (the WhatsApp fallback used only when site.json cannot be read):

```python
    "phone": "+966 57 626 7694",
    "wa": "966576267694",
```

`src/data/LISTING-SCHEMA.md:154`: `bona-real-estate.com · +966 59 329 6933 · FAL 1100313556 ·` becomes `bona-real-estate.com · <site.json whatsapp.display> · FAL 1100313556 ·`.

- [ ] **Step 5: Apply Appendix A** to `src/data/privacy.json` and `src/data/faq.json`, keeping the files' 2-space JSON formatting, then check both still parse:

```bash
cd $WT && node -e "for (const f of ['src/data/privacy.json','src/data/faq.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('ok')"
```

- [ ] **Step 6: Update the pinned tests**

`test/seo-jsonld.test.mjs:386`: in the regex, `wa\.me\/966593296933` becomes `wa\.me\/966576267694` (the list is of verified profiles, so it stays literal).

`services/intake/test/brochure.test.mjs`, replace lines 26-27 with:

```js
const SITE = JSON.parse(fs.readFileSync(new URL('../../../src/data/site.json', import.meta.url), 'utf8'));
const SITE_HOST = SITE.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
```

line 301: `assert.ok(inner.text.includes(SITE.whatsapp.display), \`the footer carries ${SITE.whatsapp.display}\`);`
line 312: `assert.ok(last.text.includes(\`wa.me/${SITE.whatsapp.wa}\`), 'the Enquire page links the WhatsApp number');`

- [ ] **Step 7: Run the site and intake suites**

```bash
cd $WT && env $T run-capped node --test --test-concurrency=4 scripts/test/*.test.mjs services/intake/test/*.test.mjs 2>&1 | tail -6
```

Expected: `fail 0` (the pointer test also checks that the new dated change line points at a real heading in both languages). `services/api/test/provision.test.mjs:135` still passes: prompt.md keeps the old number until Task 9, and `contact-numbers.test.mjs` accepts it there because it is still `site.phone`.

- [ ] **Step 8: Commit**

```bash
git -C $WT add src/data/site.json marketing/page-meta.json public/site.webmanifest src/data/content-calendar.json src/data/integrations.json scripts/og/gen-llms.mjs services/intake/rebrand_pdf.py src/data/LISTING-SCHEMA.md src/data/privacy.json src/data/faq.json scripts/test/contact-numbers.test.mjs scripts/test/privacy-policy.test.mjs test/seo-jsonld.test.mjs services/intake/test/brochure.test.mjs
git -C $WT commit -m "feat(site): Bona's WhatsApp is +966 57 626 7694; the phone line stays +966 59 329 6933

site.json whatsapp only and every hand copy; llms prints WhatsApp and phone separately; pinned
tests read site.json; a guard test keeps hand copies in line with it. Privacy notice and FAQ:
CANDIDATE EN+AR text for the new number and the AI phone assistant (owner OK before merge).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 9: Dana's prompt and the tool notes give the new WhatsApp number

Runs after Task 8: the tests read the WhatsApp number from `site.json`.

**Files:**
- Modify: `services/api/retell/prompt.md:38,101,133`, `services/api/lib/tools.mjs:124,265`, `services/api/index.mjs:903`
- Test: `services/api/test/provision.test.mjs:26,135`, `services/api/test/tools.test.mjs` (append)

- [ ] **Step 1: Make the tests read `site.json`**

In `services/api/test/provision.test.mjs`, after line 26 (`const prompt = ...`):

```js
const site = JSON.parse(fs.readFileSync(new URL('../../../src/data/site.json', import.meta.url), 'utf8'));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
```

Replace line 135 `assert.match(prompt, /\+966 59 329 6933/);` with:

```js
  // Dana hands over on the site's WhatsApp number (src/data/site.json) and quotes no other.
  assert.match(prompt, new RegExp(`hand over: WhatsApp \\*\\*${esc(site.whatsapp.display)}\\*\\*`));
  assert.match(prompt, new RegExp(`offer WhatsApp \\*\\*${esc(site.whatsapp.display)}\\*\\*`));
  assert.match(prompt, new RegExp(`- WhatsApp: \\*\\*${esc(site.whatsapp.display)}\\*\\*\\. Phone: \\*\\*${esc(site.phone.display)}\\*\\*\\.`));
  for (const [n] of prompt.matchAll(/\+966 \d{2} \d{3} \d{4}/g)) assert.ok([site.whatsapp.display, site.phone.display].includes(n), `unknown number in prompt.md: ${n}`);
```

Append to `services/api/test/tools.test.mjs`:

```js
test("the tool notes offer the site's WhatsApp number (src/data/site.json)", async () => {
  const site = JSON.parse(fs.readFileSync(new URL('../../../src/data/site.json', import.meta.url), 'utf8'));
  const h = harness();
  const empty = JSON.parse(await h.tools.run('search_properties', { call: { call_id: 'c1' }, args: { district: 'Atlantis' } }));
  assert.ok(empty.note.includes(`WhatsApp ${site.whatsapp.display}`), empty.note);
  const saved = JSON.parse(await h.tools.run('create_lead', {
    chat: { chat_id: 'chat_9', retell_llm_dynamic_variables: { locale: 'en' } },
    args: { phone: '+966500000000', name: 'Sara', interest: 'villa' },
  }));
  assert.ok(saved.note.includes(`WhatsApp ${site.whatsapp.display}`), saved.note);
  h.cleanup();
});
```

- [ ] **Step 2: Run to see them fail**

```bash
cd $WT/services && env $T run-capped node --test --test-concurrency=4 api/test/provision.test.mjs api/test/tools.test.mjs 2>&1 | tail -8
```

Expected: FAIL (prompt and notes still give +966 59 329 6933).

- [ ] **Step 3: Edit the texts**

`services/api/retell/prompt.md`:
- line 38: `5. If you cannot answer, hand over: WhatsApp **+966 57 626 7694**, Sunday–Thursday`
- line 101: `- WhatsApp: **+966 57 626 7694**. Phone: **+966 59 329 6933**.`
- line 133: `sentence. If the visitor objects to being recorded, offer WhatsApp **+966 57 626 7694**`

`services/api/lib/tools.mjs`:
- line 124: `: 'No match in Bona inventory. Do not invent a property or a price — offer to connect the visitor with a Bona specialist on WhatsApp +966 57 626 7694.',`
- line 265: `return { saved: true, id: record.lead_id, note: 'Enquiry saved. Tell the visitor a Bona principal will be in touch, and offer WhatsApp +966 57 626 7694 to speak now.' };`

`services/api/index.mjs:903`: in `note: 'Tell the visitor you cannot check that right now and offer WhatsApp +966 59 329 6933.'` only the number becomes `+966 57 626 7694` (covered by `contact-numbers.test.mjs`, which scans index.mjs).

`services/api/retell/prompt-whatsapp.md` gives no number: unchanged.

- [ ] **Step 4: Run**

```bash
cd $WT/services && env $T run-capped node --test --test-concurrency=4 api/test/provision.test.mjs api/test/tools.test.mjs
cd $WT && env $T run-capped node --test scripts/test/contact-numbers.test.mjs
```

Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git -C $WT add services/api/retell/prompt.md services/api/lib/tools.mjs services/api/index.mjs services/api/test/provision.test.mjs services/api/test/tools.test.mjs
git -C $WT commit -m "feat(dana): hand over on Bona's own WhatsApp number; the tests follow site.json

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 10: The public board never prints the instance name

**Files:** Modify `scripts/marketing/verify-integrations.mjs:286`; Test `scripts/test/verify-integrations.test.mjs` (append)

- [ ] **Step 1: Write the failing test**

```js
test('Evolution: the board says whether an instance is set, never its name (the board is the public /dashboard/)', async () => {
  const at = (status) => async () => ({ status, ok: status < 400, text: '', json: { version: '2.3.7' } });
  const env = { EVOLUTION_API_URL: 'https://wa.example.test', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };
  const live = await checkEvolution({ env, probe: at(200) });
  assert.equal(live.status, 'live');
  assert.doesNotMatch(live.detail, /abdulaziz-personal/);
  assert.match(live.detail, /instance set$/);
  assert.match((await checkEvolution({ env: { ...env, BONA_WA_INSTANCE: ' ' }, probe: at(200) })).detail, /instance \(unset\)$/);
});
```

- [ ] **Step 2: Run** `cd $WT && env $T run-capped node --test scripts/test/verify-integrations.test.mjs` → Expected: FAIL.

- [ ] **Step 3: Implement** (line 286)

```js
    return row('evolution', 'live', `Evolution API answers HTTP ${res.status}${v} at ${base}; instance ${present(env.BONA_WA_INSTANCE) ? 'set' : '(unset)'}`, { secrets: [key] });
```

- [ ] **Step 4: Run** the same command → Expected: PASS. Also `git -C $WT grep -n abdulaziz -- src public` → prints nothing.

- [ ] **Step 5: Commit**

```bash
git -C $WT add scripts/marketing/verify-integrations.mjs scripts/test/verify-integrations.test.mjs
git -C $WT commit -m "fix(marketing): verify-integrations never writes the WhatsApp instance name to the public board

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 11: WhatsApp Business profile text

**Files:** Modify `marketing/social-bios.md:26-27,50-51,96-104`

- [ ] **Step 1: Edit**
  - Lines 26-27 (X bio) and 50-51 (YouTube): `WhatsApp +966 59 329 6933` / `واتساب +966 59 329 6933` become `+966 57 626 7694` (bios the owner copies when he edits a profile; D2).
  - Line 96 heading: `## WhatsApp Business profile — +966 57 626 7694 (Bona's own number, on the Fold)`.
  - The `Email` row: `| Email | info@bona-real-estate.com |`.
  - Leave the launch texts (lines 79-80, 87) as they are: they were posted in September and old posts stay unchanged (design §9). Add one line under "## Launch announcement texts": `(Posted 2026-09 with the old number; kept as a record. Old posts stay as they are.)`
- [ ] **Step 2: Check** `grep -n '59 329 6933' $WT/marketing/social-bios.md` → only lines 79, 80 and 87 remain.
- [ ] **Step 3: Commit**

```bash
git -C $WT add marketing/social-bios.md
git -C $WT commit -m "docs(marketing): WhatsApp Business profile and bios on +966 57 626 7694

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 12: Docs: env table, /health field, PC twin, owner runbook

**Files:** Modify `services/README.md:326-327,669,988,445-448`, `docs/OWNER-RUNBOOK.md:25,94`, `services/api/lib/evolution.mjs:4-9` (comment), `services/api/lib/dashboard/auth.mjs:5-7` (comment)

- [ ] **Step 1: `services/README.md`**
  - Replace rows 326-327 with:

```markdown
| `BONA_WA_INSTANCE` | `abdulaziz-personal` | the Evolution instance every read and send uses (poller, backfill, notes, codes, replies, Dana). On the VPS `bona` (Bona's own WhatsApp) since the 2026-11-19 move; the PC file keeps `abdulaziz-personal` for bona-intake |
| `BONA_WA_INSTANCE_JID` | unset | that instance's own number (`966576267694@s.whatsapp.net` on the VPS): the chat the poller never reads, the number a sent record's alt may name, outside the shared send budget. Unset or blank = `BONA_OWNER_JID`, the state before the move: removing the line is the rollback. Never defaulted by `provision.mjs` |
| `BONA_OWNER_JID` | `966593296933@s.whatsapp.net` | the owner: where lead notes and his login codes go (sent from the instance), the owner account seeded on every start, the one login code that may pass the Sending switch |
```

  - After the `instance` row of the `/health` → `poller` table (line 669): `| `ownNumber` | `"instance"` when `BONA_WA_INSTANCE_JID` is set, `"owner"` when it falls back to `BONA_OWNER_JID`; never the digits |`
  - Line 988: `*Replies* go out from the instance's number (`BONA_WA_INSTANCE`; Bona's own WhatsApp since 2026-11-19) and only into `in` chats.`
  - After the paragraph ending line 448 ("…`2026-09-08-bona-api-vps-move-design.md`."), add:

```markdown
**The PC `bona-api` twin since the WhatsApp move (2026-11-19).** The user unit is disabled but its
preset is `enabled`, and the PC's `~/.secrets/bona-services.env` keeps
`BONA_WA_INSTANCE=abdulaziz-personal` for bona-intake. Started as it is, the twin would poll the
owner's personal WhatsApp again and undo A2Z go-live item 7. Never start it by hand. `rollback.sh`
starts it: before a rollback to the PC, give it a drop-in whose env file is read after the shared
one (a later `EnvironmentFile=` wins, and the process env wins over the files it loads itself,
`lib/env.mjs`):

    # ~/.config/systemd/user/bona-api.service.d/wa-own-number.conf
    [Service]
    EnvironmentFile=%h/.secrets/bona-api-pc-wa.env
    # ~/.secrets/bona-api-pc-wa.env (0600): BONA_WA_INSTANCE=bona and BONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net

`sync-secrets.sh` keeps the VPS's own `BONA_WA_INSTANCE` / `BONA_WA_INSTANCE_JID` (lib.sh
`VPS_KEEP_KEYS`); run it only from a checkout that has that guard.
```

- [ ] **Step 2: `docs/OWNER-RUNBOOK.md`**: line 25 `## 3. WhatsApp Business profile (+966 57 626 7694, Bona's own number on the Fold)`; line 94 `…a 6-digit code arrives on your WhatsApp (+966 59 329 6933), sent from Bona's number (+966 57 626 7694), within seconds…`.
- [ ] **Step 3: Comments**: `evolution.mjs:4-9` "the instance this talks to (`abdulaziz-personal`) is the owner's *personal* WhatsApp and is already consumed by another agent" becomes "the instance this talks to (`BONA_WA_INSTANCE`: Bona's own WhatsApp since 2026-11-19; before that the owner's personal one, which another agent also uses)"; keep the rest. `auth.mjs:6-7` "from the owner's number (the owner's own code goes to his own chat, as it always did)" becomes "from the instance's number (Bona's WhatsApp; the owner's own code goes to his personal chat)".
- [ ] **Step 4: Run** `cd $WT/services && env $T run-capped node --test --test-concurrency=4 api/test/*.test.mjs 2>&1 | tail -6` → `fail 0`.
- [ ] **Step 5: Commit**

```bash
git -C $WT add services/README.md docs/OWNER-RUNBOOK.md services/api/lib/evolution.mjs services/api/lib/dashboard/auth.mjs
git -C $WT commit -m "docs: BONA_WA_INSTANCE_JID, /health ownNumber, the PC bona-api twin after the WhatsApp move

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 13: Regenerate the committed llms files (separate commit)

CI regenerates them before every build (`deploy.yml:47`); the committed copies are only kept in step. The regeneration also carries listing drift since 2026-11-12 (51 → 53 listings, measured in the plan stage), so it is its own commit that reviewers can skim.

- [ ] **Step 1:** `cd $WT && run-capped node scripts/og/gen-llms.mjs`
- [ ] **Step 2:** `git -C $WT diff --stat public/llms.txt public/llms-full.txt` and `grep -c '593296933' $WT/public/llms.txt` (expected: the phone line only) and `grep -c '576267694' $WT/public/llms.txt` (expected: > 0).
- [ ] **Step 3: Commit**

```bash
git -C $WT add public/llms.txt public/llms-full.txt
git -C $WT commit -m "chore(llms): regenerate (new WhatsApp number, phone on its own line, listing drift since 11-12)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 14: Full verification

- [ ] **Step 1: All unit suites**

```bash
cd $WT/services && env $T run-capped node --test --test-concurrency=4 api/test/*.test.mjs 2>&1 | tail -6
cd $WT && env $T run-capped node --test --test-concurrency=4 scripts/test/*.test.mjs services/intake/test/*.test.mjs 2>&1 | tail -6
```

Expected: `fail 0` in both.

- [ ] **Step 2: Build and dist checks** (as CI does: `deploy.yml:45-51`)

```bash
cd $WT && run-capped node scripts/curate/validate.mjs && run-capped node scripts/og/gen-llms.mjs && run-capped npm run build && env $T run-capped npm run test:dist 2>&1 | tail -6
git -C $WT checkout -- public/llms.txt public/llms-full.txt 2>/dev/null; git -C $WT status --short
```

Expected: build OK, `test:dist` `fail 0`, clean tree. If the build is killed (status 137) at 4 GB, `MEMCAP_MAX=8G run-capped npm run build` once; a second kill: stop and report.

- [ ] **Step 3: Built-site audit**

```bash
cd $WT/dist && grep -rlo 'wa\.me/966593296933' . | head; grep -c '966576267694' contact/index.html; grep -o 'tel:+966[0-9]*' contact/index.html | sort -u; grep -rl 'abdulaziz-personal' . | head
```

Expected: no `wa.me/966593296933`; the new number on /contact/; `tel:+966593296933` only (phone stays); no `abdulaziz-personal` anywhere (the public /dashboard/ included).

- [ ] **Step 4: Repo audit**

```bash
git -C $WT grep -n 'wa\.me/966593296933' -- ':!docs/superpowers' ':!docs/PLAN.md' ':!marketing/captions' ':!marketing/queue' ':!marketing/launch-posts.md' ':!marketing/history' ':!marketing/whatsapp-channel.md' ':!docs/checklists' ':!docs/research' ':!scripts/test' ':!services/api/test' ':!services/api/lib/dashboard/render.mjs'
```

Expected: nothing. Left out by design: old posts and history, checklists, the original site plan, literal test fixtures, a code comment's example (`render.mjs:539`), and `marketing/whatsapp-channel.md` (the WhatsApp Channel lives on the owner's personal account; moving it is one of his by-hand profile steps, runbook B11). `git -C $WT log --oneline origin/main..HEAD` lists Tasks 0-13.

- [ ] **Step 5:** Delete `$WT/dist` and `$WT/.scratch/tmp/*` leftovers (`rm -rf $WT/dist $WT/.scratch/tmp/*`).

## Task 15: Write the cutover runbook

- [ ] **Step 1:** Write **Appendix B** verbatim to `/home/azoz778/a2z-golive/2026-11-19/bona-wa-cutover-runbook.md` (outside the repo; not committed to bona). Replace `<merge-sha>` placeholders only at cutover.
- [ ] **Step 2:** Check it has: instance `bona` with no webhook/websocket/RabbitMQ, the pairing-code link, the two VPS env lines, the restarts, provision.mjs, the Retell knowledge check, the live-ads check, Dana off, the item-7 evidence commands, the rollback.

## Task 16: Two-model review (owner rule 2026-09-01), then stop

- [ ] **Step 1:** Claude review of `origin/main..feat/wa-own-number` (`/code-review high` or `superpowers:requesting-code-review`), focus: the unset path is byte-for-byte today's behaviour; no place still treats `BONA_OWNER_JID` as the instance's number; `sync-secrets.sh` cannot print a value or copy after a failed read; the privacy text matches what the AI line and the gateway really do.
- [ ] **Step 2:** Codex second opinion: `codex exec --skip-git-repo-check "<same review prompt, diff path>" < /dev/null` (the `< /dev/null` avoids the stdin hang). If the Codex quota is out, mark it OWED; never substitute a local model.
- [ ] **Step 3:** Fix rounds: at most two; if findings do not converge, stop and propose a cut (owner feedback 2026-11-17). Report both models' findings and every disagreement.
- [ ] **Step 4:** Stop. No push, PR, merge or deploy from this workflow: the owner's OK of Appendix A and the cutover window come first.

---

## Appendix A: Privacy and FAQ candidate text (EN + AR)

Conventions kept from the files: curly quotes ’ “ ” in English, «» in Arabic, no LRM in privacy.json, LRM (U+200E) before `+966` in faq.json Arabic, as today.

### A.1 `src/data/privacy.json`

- `"updated": "2026-11-19"` (set to the merge day at cutover).

**`who-we-are`** (body en[1], ar[1]):
- EN: `Reach us on WhatsApp at +966 57 626 7694. Email us at info@bona-real-estate.com.`
- AR: `يمكنك التواصل معنا عبر واتساب على الرقم +966 57 626 7694، أو عبر البريد الإلكتروني info@bona-real-estate.com.`

**`whatsapp-conversations`** en[2], ar[2]:
- EN: `The owner of Bona and authorised members of the Bona team can read these conversations and reply to you through a private dashboard that requires sign-in. Replies sent from the dashboard come from Bona’s WhatsApp number, +966 57 626 7694, and the dashboard records which team member sent each one.`
- AR: `ويمكن لمالك المنشأة وأعضاء فريق بونا المخوّلين قراءة هذه المحادثات والرد عليك من خلال لوحة خاصة تتطلب تسجيل الدخول. وتصلك الردود المرسلة من اللوحة من رقم واتساب بونا +966 57 626 7694، وتسجّل اللوحة عضو الفريق الذي أرسل كل ردّ منها.`

**`whatsapp-conversations`** en[3], ar[3]: only the last sentence changes.
- EN last sentence: `To have a conversation deleted from the dashboard, from our gateway server or from our phones, message us on WhatsApp at +966 57 626 7694 or call us on +966 59 329 6933; see “Your rights” below.`
- AR last sentence: `ولطلب حذف محادثة من اللوحة أو من خادم البوابة أو من هواتفنا، راسلنا على واتساب على الرقم +966 57 626 7694 أو اتصل بنا على الرقم +966 59 329 6933، وانظر «حقوقك» أدناه.`

**`ai-concierge`** en[2], ar[2]: only the closing number changes.
- EN: `… To have a concierge conversation, a recording, or the enquiry it produced deleted, write to us on WhatsApp at +966 57 626 7694.`
- AR: `… ولطلب حذف محادثة مع الكونسيرج أو تسجيلها أو الاستفسار الناتج عنها، راسلنا على واتساب: +966 57 626 7694.`

**New section `ai-phone-line`**, inserted right after `ai-concierge`:

```json
    {
      "id": "ai-phone-line",
      "heading": {
        "en": "The AI phone assistant",
        "ar": "المساعدة الهاتفية بالذكاء الاصطناعي"
      },
      "body": {
        "en": [
          "Phone calls to Bona’s number, +966 57 626 7694 (not WhatsApp calls), are answered at any hour by Bona’s virtual assistant, an AI system, not a person. When it answers it says that it is an AI assistant and that the call is recorded. It speaks Arabic or English, answers questions about the homes published on this site at the prices shown here, and notes your name, what you are looking for and how to reach you, so that a principal can call you back. It never asks for ID numbers, bank or payment details. WhatsApp calls to that number do not reach the assistant; please write to us on WhatsApp instead.",
          "During the call your voice and what you say are sent to OpenAI, the AI provider that produces the assistant’s replies, which processes them outside Saudi Arabia. Bona records the call: the audio, a written transcript and the details you give, with the number you call from (or that it was hidden). If you tell the assistant you do not want to be recorded, no audio recording is kept; it notes your details for a callback and ends the call. The written transcript of that call and the details you give are still kept, as described below.",
          "We keep the audio recording for up to 90 days and then delete it. The transcript and your details are kept with the call record on Bona’s own systems until you ask us to delete them. The owner of Bona and authorised members of the Bona team can listen to the recording and read the transcript. To have a call recording, its transcript or your details deleted, message us on WhatsApp at +966 57 626 7694; see “Your rights” below."
        ],
        "ar": [
          "تردّ المساعدة الافتراضية لبونا، وهي نظام يعمل بالذكاء الاصطناعي وليست شخصاً، على المكالمات الهاتفية الواردة إلى رقم بونا +966 57 626 7694 (لا مكالمات واتساب) في أي وقت. وتوضّح عند الرد أنها مساعدة تعمل بالذكاء الاصطناعي وأن المكالمة مسجّلة. وتتحدث بالعربية أو الإنجليزية، وتجيب عن المنازل المنشورة في هذا الموقع بالأسعار المعروضة فيه، وتدوّن اسمك وما تبحث عنه وطريقة التواصل معك ليتصل بك أحد شركاء الدار. ولا تطلب أبداً رقم هوية أو بيانات بنكية أو بيانات دفع. ولا تصل مكالمات واتساب إلى هذا الرقم إلى المساعدة، فراسلنا كتابةً عبر واتساب بدلاً من ذلك.",
          "أثناء المكالمة يُرسل صوتك وما تقوله إلى OpenAI، مزوّد الذكاء الاصطناعي الذي يُعدّ ردود المساعدة، ويعالجه خارج المملكة. وتسجّل بونا المكالمة: الصوت، ونصاً مكتوباً لها، والبيانات التي تذكرها، مع الرقم الذي اتصلت منه (أو أنه كان مخفياً). وإذا أخبرت المساعدة أنك لا ترغب في تسجيل المكالمة، فلا يُحتفظ بأي تسجيل صوتي لها، وتدوّن المساعدة بياناتك ليُعاوَد الاتصال بك ثم تُنهي المكالمة. لكن النص المكتوب لتلك المكالمة والبيانات التي تذكرها يظلّان محفوظَين كما هو موضّح أدناه.",
          "نحتفظ بالتسجيل الصوتي مدةً أقصاها تسعون يوماً ثم نحذفه. أما النص المكتوب وبياناتك فتُحفظ مع سجل المكالمة على أنظمة بونا الخاصة إلى أن تطلب منا حذفها. ويمكن لمالك بونا وأعضاء فريق بونا المخوّلين الاستماع إلى التسجيل وقراءة النص. ولطلب حذف تسجيل مكالمة أو نصها أو بياناتك، راسلنا على واتساب على الرقم +966 57 626 7694، وانظر «حقوقك» أدناه."
        ]
      }
    },
```

**`sharing`** en[1], ar[1]:
- EN: `Service providers include GitHub Pages and Cloudflare for hosting/delivery; Meta for WhatsApp and advertising measurement; Google for analytics; Retell and its AI service providers for the concierge and for Dana’s WhatsApp replies; and OpenAI for the AI phone assistant. Opening an embedded Matterport tour sends technical information to Matterport. These providers also apply their own privacy policies.`
- AR: `تشمل الجهات المقدّمة للخدمة GitHub Pages وCloudflare للاستضافة والإيصال، وMeta لواتساب وقياس الإعلانات، وGoogle للتحليلات، وRetell ومزوّدي خدمات الذكاء الاصطناعي لديها للمساعد ولردود دانة عبر واتساب، وOpenAI للمساعدة الهاتفية بالذكاء الاصطناعي. فتح جولة Matterport المضمّنة يرسل بيانات تقنية إلى Matterport. وتطبّق هذه الجهات سياسات الخصوصية الخاصة بها أيضاً.`

**`changes`**: append one dated line to each language (the 30 September and 1 October lines are past their 30 days; removing them is a separate decision, not part of this branch):
- EN: `19 November 2026: Bona’s WhatsApp moved to its own number, +966 57 626 7694, in place of +966 59 329 6933; replies from the dashboard and Dana’s answers now come from it. We also added “The AI phone assistant”: phone calls to +966 57 626 7694 (not WhatsApp calls) are answered by an AI assistant that says so and records the call, and your voice and what you say are sent to OpenAI to produce its replies.`
- AR: `19 نوفمبر 2026: انتقل واتساب بونا إلى رقم خاص به هو +966 57 626 7694 بدلاً من +966 59 329 6933، ومنه تصلك الآن الردود المرسلة من اللوحة وردود دانة. وأضفنا قسم «المساعدة الهاتفية بالذكاء الاصطناعي»: تردّ على المكالمات الهاتفية إلى الرقم +966 57 626 7694 (لا مكالمات واتساب) مساعدةٌ تعمل بالذكاء الاصطناعي توضّح ذلك وتسجّل المكالمة، ويُرسل صوتك وما تقوله إلى OpenAI لإعداد ردودها.`

**`contact`**:
- EN: `Questions about this policy or your data: WhatsApp +966 57 626 7694, Sunday to Thursday, 10:00–19:00. Bona, Al Rawdah District, Jeddah 23432, Saudi Arabia. Email: info@bona-real-estate.com.`
- AR: `للاستفسار عن هذه السياسة أو عن بياناتك: واتساب +966 57 626 7694، من الأحد إلى الخميس، 10:00–19:00. بونا، حي الروضة، جدة 23432، المملكة العربية السعودية. البريد الإلكتروني: info@bona-real-estate.com.`

**Optional sentence, only if the owner says yes (open point 1b):** appended to `whatsapp-conversations` en[2]/ar[2] and to `ai-phone-line` en[2]/ar[2]:
- EN: `A business partner of the owner of Bona who also uses his AI tools can access them as well.`
- AR: `ويمكن كذلك لشريك أعمال لمالك بونا يستخدم أدوات الذكاء الاصطناعي نفسها الوصول إليها.`

### A.2 `src/data/faq.json`, entry `contact` (3 paragraphs each; the old "handled by the principal rather than passed down a call centre" is replaced, design §12)

```json
      "a": {
        "en": [
          "WhatsApp is fastest: +966 57 626 7694. Our team replies Sunday to Thursday, 10:00 to 19:00 Saudi time, in Arabic or English, and a Bona principal follows up every enquiry personally.",
          "Phone calls to that number (not WhatsApp calls) are answered at any hour by Bona’s virtual assistant. It is an AI, says so when it answers and records the call; it can tell you about the homes on this site and their published prices, and it takes your details so that a principal can call you back. WhatsApp calls do not reach the assistant, so please write to us there instead.",
          "Send the listing reference with your message and you will get a straight answer about that home rather than a brochure."
        ],
        "ar": [
          "واتساب أسرع وسيلة: ‎+966 57 626 7694. يردّ فريقنا من الأحد إلى الخميس، من 10:00 إلى 19:00 بتوقيت المملكة، بالعربية أو الإنجليزية، ويتابع أحد شركاء الدار كل استفسار بنفسه.",
          "وتردّ على المكالمات الهاتفية إلى هذا الرقم (لا مكالمات واتساب) في أي وقت المساعدةُ الافتراضية لبونا، وهي مساعدة تعمل بالذكاء الاصطناعي تُعرّف بنفسها عند الرد وتسجّل المكالمة؛ وتُخبرك عن المنازل المنشورة في هذا الموقع وأسعارها المعلنة، وتدوّن بياناتك ليتصل بك أحد شركاء الدار. ولا تصل مكالمات واتساب إلى المساعدة، فراسلنا كتابةً عبر واتساب بدلاً من ذلك.",
          "أرسل رقم العقار مع رسالتك لتحصل على إجابة مباشرة عن ذلك المنزل بدل أن تصلك نشرة تعريفية."
        ]
      }
```

(The Arabic first paragraph keeps the U+200E mark before `+966`, as the current text does.)

### A.3 Facts the text relies on (checked 2026-11-19)

- The AI line answers phone (SIM) calls only: it sees a ring through the cellular state of SIM slot 0 (`~/bona-line` `line_state.py:20-51`, `agent.py:108-109`), so a WhatsApp voice call to the same number rings WhatsApp Business on the Fold and is not answered by it. Hence "Phone calls … (not WhatsApp calls)" in the FAQ and the notice (review 2026-11-19). Whether Evolution should auto-decline WhatsApp calls with a message (`rejectCall` + `msgCall`) is the owner's choice: Appendix D point 4.
- The AI line (`~/bona-line`, unit `hl-voice-agent-bona`) answers every caller (`CALL_ALLOW=*` since 2026-11-19 11:23), greets with the AI and recording notice (`bona_persona.py:37-48`), uses OpenAI Realtime, never asks for ID/bank/payment details and promises a principal's callback (`bona_persona.py:88-93`), and keeps no WAV or raw audio when the caller declines (`call_record.py:21,236-245`); the record's `turns`, the `<call_id>.txt` transcript and the details stay, so the decline sentence says the transcript and details are still kept (review 2026-11-19). It does not book calendar viewings yet; the text does not claim it does.
- **No enquiry from a call in Phase 1:** `~/bona-line` `catalogue.py` allows only `search_properties` and `show_property` (no `create_lead`), `call_record.py` keeps each record (JSON, `.txt` transcript, WAV) under `~/bona-line/calls/` for a Phase 2 `POST /v1/calls` that does not exist yet, so nothing reaches the enquiry dashboard. The text therefore says the transcript and details are kept "with the call record on Bona’s own systems until you ask us to delete them" (not "as an enquiry, like any other"), and a deletion request about a call must be carried out in `~/bona-line/calls/` too (runbook A4). When Phase 2 ships, the sentence can point at the enquiry retention again.
- **Gate, not an owner question:** the "up to 90 days" audio promise (design §9 default) needs a purge on the bona-line side. Today call records stay in `~/bona-line/calls/` until the Phase 2 upload, which does not exist. The bona-line session must add a daily purge of audio older than 90 days before this text goes live (runbook A4). The oldest public call is of 2026-11-19, so the promise would first be broken on 2027-02-17.

## Appendix B: Cutover runbook (a verbatim copy of `/home/azoz778/a2z-golive/2026-11-19/bona-wa-cutover-runbook.md`, which is outside the repo; review fixes land in both)

```markdown
# Bona WhatsApp cutover: personal number → Bona's own number (+966 57 626 7694)

> **Update 2026-11-26 (owner decisions before the cutover; they override the lines below where they differ):**
> - `site.phone` moves too: every call button and `tel:` link is +966 57 626 7694, answered by the AI phone line.
>   A call alert (~/bona-line `call_alert.py`, `bona-line-call-alert.timer`) sends the owner a WhatsApp note from
>   the Bona number after every call, because the AI line has no Phase 2 upload yet.
> - The REGA advertiser line on property posts keeps the number on the REGA ad licences (`site.advertiser.phone`
>   = +966 59 329 6933), so the 31 approved property reviews stay valid and match REGA. When the owner updates the
>   REGA records, one PR changes that field AND declares the change in marketing/daily/advertiser-change.json
>   (the new advertiser fingerprint, printed by test/social-catalogue-advertiser.test.mjs; the file's header has
>   the steps); after the deploy every property review is drafted and approved again from the live catalogue.
>   Until then the daily property posts stop on their own; an undeclared advertiser change fails the test.
> - Data and deletion requests go by WhatsApp only (the privacy page has no call button); partner sentence added.
> - Dana stays ON (B1 skipped): chats added in B9a/B10 can get a Dana reply.
> - Brochures are printed by `services/intake/brochure_pdf.py` (rebrand_pdf.py was removed in #72); it reads
>   `site.json` phone and WhatsApp, so a re-render prints the new number on both.
> - The Evolution instance is `bona2`, not `bona`: WhatsApp logged out the first linked device (`bona`, 401) at
>   05:19 on 26 Nov, seconds after a profile name/photo update sent through Evolution. Never change the WhatsApp
>   profile through Evolution (set it on the Fold). `bona2` was linked at 05:26 (`BONA_WA_INSTANCE=bona2`), and
>   `bona` was deleted on 26 Nov after an Evolution restart. Read `bona` as `bona2` in the lines below.
> - `/health` `poller.ownNumber` has a third value, `"invalid"`: `BONA_WA_INSTANCE_JID` is set but is not a phone
>   JID, so bona-api treats it as unset (the owner's number) and logs `wa.instance_jid_invalid` at start-up.

Branch: `feat/wa-own-number` in `/home/azoz778/bona-wt/wa-own-number`, on top of `origin/main`
`ed94e60` (NOT pushed; `git log --oneline origin/main..feat/wa-own-number` lists the commits). Plan:
`docs/superpowers/plans/2026-11-19-wa-own-number.md` (Appendix A = the privacy/FAQ candidate text;
Appendix B = a copy of this runbook, kept identical).
Goal: A2Z go-live checklist item 7, bona-api no longer reads Evolution `abdulaziz-personal`.
Never paste a secret or an env value into a terminal log, a chat or this file.

What the branch does (so the steps below make sense):
- New env `BONA_WA_INSTANCE_JID` = the instance's own number. Unset or blank it falls back to
  `BONA_OWNER_JID`, so the merged code behaves exactly as today until the VPS env lines change.
- `BONA_OWNER_JID` stays the owner's personal number: lead notes and his login codes still go to
  his personal phone (now SENT FROM the Bona number), the owner account seed, the Sending-switch
  bypass for his own login code.
- `/health` → `poller.ownNumber` = `"instance"` (set), `"owner"` (fallback) or `"invalid"` (set but not a
  phone JID, so treated as unset); never digits. The same field is in the `wa.poll.init` start-up log line.
- `sync-secrets.sh` keeps the VPS's own `BONA_WA_INSTANCE` / `BONA_WA_INSTANCE_JID` lines and copies
  nothing when it cannot read them.
- Site: `site.json` `whatsapp` and (since 26 Nov) `phone` → +966 57 626 7694, all hand
  copies, Dana's prompt and tool notes, privacy notice + FAQ (CANDIDATE text, owner OK first).

## A. Before the cutover day (nothing public changes)

A1. The branch is reviewed by Claude and Codex (owner rule: two models), CI is green on the PR,
    and the owner has OK'd the EN+AR privacy and FAQ text (plan Appendix A), with or without the
    optional partner sentence (Appendix D point 1).
A2. WhatsApp Business on the Fold (Lebara SIM 0576267694), one attempt (slow-down rule):
    - verify by SMS only; deny WhatsApp the Phone and Call-log permissions first, so it cannot
      fall back to a flash call (the AI line answers every call);
    - two-step verification on; store the PIN as a 0600 file in ~/.secrets/ and run
      `python3 ~/secrets-vault/scripts/secrets-vault.py sync` (never ask the owner to keep it);
      recovery email info@bona-real-estate.com;
    - profile from `marketing/social-bios.md` "WhatsApp Business profile";
    - check the number was not someone else's WhatsApp before (no old chats or groups appear);
    - LOGIN CODES SHOW ON THE FOLD: after B7 every dashboard login code, the owner's own
      included, is sent FROM this account, so it appears in the Fold's chat with that person and
      on every device linked to the account (the owner's companion from A3, Evolution). Whoever
      can read the Fold's WhatsApp can sign in as the owner (Team page, Sending switch, Dana).
      Before B7: a screen lock on the Fold (it has no lock PIN today), WhatsApp Business
      notification text hidden on the lock screen, not a shared staff phone, and no bot or Home
      Lab viewer screen access to WhatsApp Business on it (check with the bona-line session that
      the lock does not stop the AI line answering calls over adb). The owner confirms this in
      the A2Z checklist row 7; the route itself is his decision (design §11), so no code change.
A3. Warm-up (D4, ~3 days): the owner uses it by hand from a linked device on his phone. He
    messages the Bona number once from his personal WhatsApp and saves it as a contact (lead
    notes and his login codes will come from it); each team member does the same (their codes).
A4. AI line privacy gate: the privacy text promises "audio kept up to 90 days". The bona-line must
    delete call audio older than 90 days before that text goes live (confirm with the session that
    runs ~/bona-line-wt/knowledge; not this branch). TK's Fold test calls are done (O3).
    Erasure: until the Phase 2 upload (POST /v1/calls) exists, no call becomes an enquiry, and the
    notice says transcripts and details stay "with the call record on Bona's own systems until you
    ask us to delete them". The bona-line handover must say how a deletion request about a call is
    carried out there, because deleting a lead in the dashboard does not touch it: the caller's
    number → `~/bona-line/calls/records/<call_id>.json` and `.wav`, and
    `~/bona-line/calls/<call_id>.txt`, `-down.tsr`, `-up.tsr` (call_record.py header).
    Since 26 Nov each call also has a WhatsApp alert note to the owner (~/bona-line call_alert.py: sent
    from `bona2` to his personal number, up to 3 copies, each ending "(call <call_id>)"). The privacy
    notice says a request to delete a call covers that note too. In this order: (1) stop the alert, so no
    retry runs meanwhile: `systemctl --user stop bona-line-call-alert.timer`, then wait until
    `systemctl --user is-active bona-line-call-alert.service` says `inactive` or `failed` (Kuma "Bona
    call alert" goes DOWN while it is stopped); (2) delete the call record files above; (3) only then its
    markers `~/bona-line/calls/alerts/<call_id>.sent` and `.sending` (a marker removed while the record
    is still there makes the note go out again); (4) `systemctl --user start bona-line-call-alert.timer`
    right away: the record is gone, so no run can send this note again, and new calls get their alert
    while the rest waits on the phones; (5) every copy of the note in the Bona chat on the Fold
    and in the owner's chat on his phone, and any forward or reply quoting it ("Delete for everyone" from
    the Fold while WhatsApp still offers it, about 2 days; after that delete it on each phone);
    (6) Evolution's stored copies for both instances, `bona2` (sent) and `abdulaziz-personal`
    (received): on hermes-vps, in evolution-postgres, the "Message" rows of those two instances whose
    `message`::text contains "(call <call_id>)" (SELECT them first, then DELETE exactly those rows).
A5. Lebara SIM: validity and credit on a reminder (a lapsed SIM can lose the WhatsApp account).
A6. CLICK-TO-WHATSAPP ADS FIRST: the owner opens Meta Ads Manager, filters Active, and checks for
    any ad whose destination is WhatsApp. Such ads route to the personal number; plan to pause
    them or switch the Page's WhatsApp number to 0576267694 inside the window (by hand; Meta sends
    a code to the new WhatsApp, and ads may go back to review). Do not start B until this is known.
A7. Pick the window: not 20:30–21:45 Riyadh (the social publishers run then, and they check out
    origin/main before every run, so the merge changes their captions and cards at once).

## B. The cutover window (~30 min, one sitting)

B1. Dana off for the first days, chats under test included: the owner switches "Dana on WhatsApp"
    off on the dashboard Team page. Check:
    `curl -s https://api.bona-real-estate.com/health | python3 -c 'import json,sys; print(json.load(sys.stdin)["dana"])'`
    → `'enabled': False`. Note what it was, for R3.
    That switch does NOT stop a Dana test: she still answers a chat the owner armed with "Let Dana
    test on this chat" (dana-wa.mjs:221 `team.danaEnabled() || lead.dana_test === 1`), and such a
    client writing to the new number after B7 would get Dana from it on day 1. So also:
    - read the Team page's Dana line: "Off. Dana answers nobody on WhatsApp, except N chats under
      test" means N tests still run (render-team.mjs:108);
    - list them on the VPS (read-only; prints the count and the lead ids only, nothing personal):

          ssh hermes-vps "~/.local/opt/node-v24.19.0-linux-x64/bin/node -e 'const {DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(process.argv[1],{readOnly:true});const ids=db.prepare(\"SELECT lead_id FROM leads WHERE dana_test=1 AND dana_off=0 AND inbox_state=?\").all(\"in\").map((r)=>r.lead_id);console.log(ids.length, ids.join(\" \"))' ~/bona-data/bona.db"
          # → 0   (the same count as the Team page line, inbox/store.mjs:558)

    - for each id: the owner opens `https://api.bona-real-estate.com/dashboard/inbox/<lead_id>` and
      presses "Stop the Dana test here" (owner only; it clears `dana_test` and leaves the chat's own
      switch alone). Not "Turn Dana off for this chat": that sets `dana_off`, which R3/C1 would
      then have to undo by hand;
    - re-run the list → `0`, and the Team page line has no "except". Write the stopped lead ids
      into the A2Z checklist row 7 (ids only) so R3/C1 can re-arm each test.
    Do not go on to B2 until the list prints `0`.
B2. Create the Evolution instance `bona` on the VPS with NO webhook, websocket, RabbitMQ or SQS
    (Evolution v2; check the version first, the image is `latest`):

        ssh hermes-vps 'set -a; . ~/.secrets/evolution-api.env; set +a; curl -s -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8085/ | head -c 200; echo'
        ssh hermes-vps 'set -a; . ~/.secrets/evolution-api.env; set +a; curl -s -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8085/instance/fetchInstances | python3 -c "import json,sys; print([i.get(\"name\") or i.get(\"instance\",{}).get(\"instanceName\") for i in json.load(sys.stdin)])"'
        # expect no "bona" yet; then create it with NO webhook, websocket, rabbitmq or sqs keys:
        ssh hermes-vps 'set -a; . ~/.secrets/evolution-api.env; set +a; curl -s -X POST http://127.0.0.1:8085/instance/create -H "apikey: $EVOLUTION_API_KEY" -H "Content-Type: application/json" -d "{\"instanceName\":\"bona\",\"integration\":\"WHATSAPP-BAILEYS\",\"qrcode\":false,\"number\":\"966576267694\",\"groupsIgnore\":true,\"alwaysOnline\":false,\"readMessages\":false,\"readStatus\":false,\"syncFullHistory\":false,\"rejectCall\":false}" | python3 -c "import json,sys; d=json.load(sys.stdin); i=d.get(\"instance\",{}); print(i.get(\"instanceName\"), i.get(\"status\"))"'
        # the create answer also carries the instance token ("hash"): the filter above never prints it.
        # "rejectCall":false = WhatsApp calls keep ringing the Fold (the AI line answers SIM calls
        # only; the FAQ and notice say so). The owner may pick "rejectCall":true plus a "msgCall"
        # text instead (plan Appendix D point 4): that also blocks calls he would take by hand.
        for p in webhook websocket rabbitmq; do ssh hermes-vps "set -a; . ~/.secrets/evolution-api.env; set +a; curl -s -H \"apikey: \$EVOLUTION_API_KEY\" http://127.0.0.1:8085/$p/find/bona; echo"; done
        # expect null / enabled:false for all three

    Link by PAIRING CODE (no camera needed): `GET /instance/connect/bona?number=966576267694`
    (same curl form, print only the `pairingCode` field) returns the code. On the Fold: WhatsApp
    Business → ⋮ → Linked devices → Link a device → "Link with phone number instead" → type the
    code (it expires in about a minute). Then the LINK CHECK (prints only the state):

        ssh hermes-vps 'set -a; . ~/.secrets/evolution-api.env; set +a; curl -s -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8085/instance/connectionState/bona | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get(\"instance\") or d).get(\"state\"))"'
        # → open

    One attempt; if it fails, write the manual steps for the owner instead of retrying. The
    linked device may show as "TK-Lisa" (Evolution's CONFIG_SESSION_PHONE_CLIENT): cosmetic; do
    not restart Evolution to change it.
    HARD STOP: anything but `open` ends the cutover here. Do NOT do B3-B7: a merge would send every
    WhatsApp click to a number bona-api does not read, and the env switch would route client reads, lead
    notes and every login code (the owner's included) through an instance that is not connected.
    Nothing public has changed yet; Dana can stay off (or R3) until the owner links it by hand.
B3. If the merge day is not 19 Nov: one commit on the branch setting, to the merge day,
    `src/data/privacy.json` `updated` and the dated change line (EN "19 November 2026: …" and AR
    "19 نوفمبر 2026: …"), `src/data/faq.json` `updated`, and the 30-day cut-off in
    `scripts/test/privacy-policy.test.mjs` ('2026-12-19' → merge day + 30); CI green again.
B4. Gate: run the B2 LINK CHECK again → `open`; anything else: stop, no merge (B2 HARD STOP).
    Then the owner merges the PR. Note `<merge-sha>`.
B5. Code first, env unchanged (the split is inert while BONA_WA_INSTANCE_JID is unset):

        ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh
        ssh hermes-vps git -C /opt/bona rev-parse HEAD      # = <merge-sha>
        ssh hermes-vps 'curl -s http://127.0.0.1:4120/health' | python3 -c 'import json,sys; p=json.load(sys.stdin)["poller"]; print(p["instance"], p.get("ownNumber"))'
        # → abdulaziz-personal owner

B5a. LOCK THE PC TWIN (on the PC, while Pages deploys; nothing public changes). From B7 on, the PC
     bona-api twin's env still reads abdulaziz-personal, so nothing may start it (owner decision
     2026-11-19, "Lock the PC backup"). The drop-in makes systemd refuse every start of the unit
     while the file LOCKED exists (a reboot, `systemctl --user start`, any script), and install.sh
     and rollback.sh refuse before they write, stop or start anything:

         d=~/.config/systemd/user/bona-api.service.d; mkdir -p "$d" && printf '%s\n' '[Unit]' '# The PC twin is locked since the WhatsApp move (cutover runbook B5a): no start while LOCKED is here.' 'AssertPathExists=!%h/.config/systemd/user/bona-api.service.d/LOCKED' > "$d/locked.conf" && printf 'Locked %s at the WhatsApp move. Fall-back: cutover runbook R1 on the VPS. Unlock only with the owner: rm this file.\n' "$(date -Is)" > "$d/LOCKED" && systemctl --user daemon-reload
         # the LOCK CHECK:
         ls ~/.config/systemd/user/bona-api.service.d/LOCKED; systemctl --user show bona-api -p DropInPaths -p NeedDaemonReload -p ActiveState -p UnitFileState
         # → the LOCKED path, DropInPaths= naming …/bona-api.service.d/locked.conf,
         #   NeedDaemonReload=no, ActiveState=inactive, UnitFileState=disabled
         # the tunnel twin gets the same lock (no dead connector on the live tunnel if someone starts it):
         d2=~/.config/systemd/user/cloudflared-bona.service.d; mkdir -p "$d2" && printf '%s\n' '[Unit]' '# Locked with the bona-api twin (cutover runbook B5a).' 'AssertPathExists=!%h/.config/systemd/user/bona-api.service.d/LOCKED' > "$d2/locked.conf" && systemctl --user daemon-reload
         systemctl --user show cloudflared-bona -p DropInPaths -p NeedDaemonReload -p ActiveState
         # → DropInPaths= naming …/cloudflared-bona.service.d/locked.conf, NeedDaemonReload=no, ActiveState=inactive

     Anything else: fix the lock before B7. Undo is one command and only with the owner (R):
     `rm ~/.config/systemd/user/bona-api.service.d/LOCKED`.
B6. Wait for the Pages deploy: `curl -s https://bona-real-estate.com/contact/ | grep -c 966576267694`
    > 0 and `curl -s https://bona-real-estate.com/contact/ | grep -c 'wa.me/966593296933'` = 0.
    Note the time.
B7. Within 10 minutes of B6 (the new instance's first poll looks back 10 min,
    `FIRST_RUN_LOOKBACK_MS`, wa-poller.mjs:87), switch the VPS env. That keeps B9a short; it does
    not make it safe on its own: Pages can be live before B6 sees it. Gate first: the B5a LOCK CHECK
    as shown there (else fix the lock first), then the B2 LINK CHECK → `open`. Anything else: do
    NOT switch the env (bona-api keeps reading abdulaziz-personal and the owner's codes keep
    working); the site already shows the new number, so either the link is
    back within the hour (one attempt, by the owner on the Fold) or do R2 the same day. The values
    are not secret but the file is: never cat it. Works whether or not the file already has the
    lines:

        ssh hermes-vps 'f=~/.secrets/bona-services.env; cp -p "$f" "$f.bak-wa-$(date +%Y%m%d%H%M)" && for kv in BONA_WA_INSTANCE=bona BONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net; do k=${kv%%=*}; if grep -q "^$k=" "$f"; then sed -i "s|^$k=.*|$kv|" "$f"; else printf "%s\n" "$kv" >> "$f"; fi; done && chmod 600 "$f" && grep -cE "^BONA_WA_INSTANCE=bona$|^BONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net$" "$f"'
        # → 2   (note the .bak-wa-<stamp> name for R1)
        ssh hermes-vps sudo systemctl restart bona-api
        # note the restart time for B9

    BONA_OWNER_JID stays as it is. Leave the PC's ~/.secrets/bona-services.env alone: bona-intake
    on the PC needs `abdulaziz-personal` for the owner's PDF group. A later `sync-secrets.sh` from a
    checkout with this branch keeps the VPS's two lines; never run it from an older checkout (C5).
B8. Dana's texts and the Retell knowledge base re-crawl check: on the PC, from a clean worktree at
    <merge-sha> (not ~/bona):
    `node services/api/retell/provision.mjs --dry-run`, then `node services/api/retell/provision.mjs`
    (updates the prompts in place; ids unchanged, so no restart). It also tops up the PC env file
    with missing defaults only; it never adds BONA_WA_INSTANCE_JID (tested).
    Retell knowledge base: it auto-refreshes from the live llms*.txt; within 24 h ask the site
    concierge "What is your WhatsApp number?" and expect +966 57 626 7694. Still the old number
    after 24 h: `provision.mjs --rebuild-kb --dry-run`, then decide (it replaces the knowledge
    base in a safe order).
B9. ITEM 7 EVIDENCE (write the outputs into the A2Z checklist row 7):

        ssh hermes-vps 'curl -s http://127.0.0.1:4120/health' | python3 -c 'import json,sys; p=json.load(sys.stdin)["poller"]; print(p["instance"], p["configured"], p["ownNumber"], p["lagS"])'
        # → bona True instance <small number>
        ssh hermes-vps "sudo journalctl -u bona-api --since '<B7 restart time>' -o cat | grep -F '\"evt\":\"wa.poll.init\"'"
        # → one line with "instance":"bona" and "ownNumber":"instance"
        ssh hermes-vps "sudo journalctl -u bona-api --since '<B7 restart time>' -o cat | grep -c abdulaziz-personal"
        # → 0  (no abdulaziz-personal reads in the journal: every findMessages/sendText URL names the instance)
        ssh hermes-vps "sudo journalctl -u bona-api --since '<B7 restart time>' -o cat | grep -c wa.instance_jid_invalid"
        # → 0
        for u in / /ar/ /contact/ /llms.txt; do printf '%s ' $u; curl -s https://bona-real-estate.com$u | grep -c 'wa.me/966593296933'; done
        # → 0 each

    Scope line for the evidence: "covers bona-api (poller, backfill reads, sender, notes, Dana).
    bona-intake on the PC still reads abdulaziz-personal for the owner's own Bona PDF group only
    (group-filtered findMessages, acts only on the owner's messages, cannot create leads); outside
    item 7 as written."
B9a. RECONCILE what the first poll could not see. A new instance has no poll cursor, so
     bona-api's first successful read on `bona` reaches back only 10 minutes (+2 min overlap). A
     client message that reached the Bona number before that (Pages live before B6 saw it, or the
     relink hour in B7) is never read: no lead, no note to the owner, nothing in the inbox. Once B9
     shows a small `lagS`, on the PC (each command prints a time or counts, nothing personal):

         # U = when the first successful poll began, at the latest: the start-up line, or the last
         # failed poll after it (a UTC time)
         ssh hermes-vps "sudo journalctl -u bona-api --since '<B7 restart time>' -o cat | grep -E '\"evt\":\"wa\.poll\.(init|failed)\"' | tail -n 1" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["ts"])'
         FROM=$(date -u -d '<U> 10 minutes ago' +%FT%TZ); echo "$FROM"; TZ=Asia/Riyadh date -d "$FROM"
         SINCE=$(date -u -d "$(ssh hermes-vps git -C /opt/bona log -1 --format=%cI <merge-sha>)" +%FT%TZ); echo "$SINCE"
         # FROM before SINCE: the first poll reached back past the merge, nothing to reconcile. Else
         # the client messages Evolution holds on bona from the merge to FROM:
         ssh hermes-vps 'set -a; . ~/.secrets/evolution-api.env; set +a; curl -s -X POST http://127.0.0.1:8085/chat/findMessages/bona -H "apikey: $EVOLUTION_API_KEY" -H "Content-Type: application/json" -d "{\"where\":{\"messageTimestamp\":{\"gte\":\"'"$SINCE"'\",\"lte\":\"'"$FROM"'\"}},\"page\":1,\"offset\":1000}" | python3 -c "import json,sys; d=json.load(sys.stdin); b=d.get(\"messages\",d) if isinstance(d,dict) else d; r=b.get(\"records\",[]) if isinstance(b,dict) else b; k=[x.get(\"key\") or {} for x in r]; i=[j for j in k if not j.get(\"fromMe\") and not str(j.get(\"remoteJid\",\"\")).endswith((\"@g.us\",\"broadcast\",\"@newsletter\"))]; print(len(i), len({j.get(\"remoteJid\") for j in i}), len(r), b.get(\"total\") if isinstance(b,dict) else len(r))"'
         # → <client messages> <chats> <records read> <total>; when the last two differ, ask again
         #   with "page":2, 3, … and add the first two up

     `0 0 …`: nothing was missed. Anything else: the owner, in WhatsApp Business on the Fold, takes
     every chat with a client message older than FROM (the Riyadh time printed above) that the
     dashboard Inbox, its Unsure tab included, does not show, and adds it with *Add chat by phone
     number* (owner only: it creates or reuses the lead, `owner_added`, puts it in the Bona inbox
     and pulls its last 30 days), then answers it there by hand (Dana stays on since 26 Nov: she may answer first). Not the
     owner's or a team member's own chat. A Ref line in such a chat stays in the thread; the lead
     does not get its campaign. If the B7 link gate failed and the env was switched later, the
     owner also goes through the Fold's chats from the site update (SINCE, or the verified Pages publication time if earlier) to FROM whatever the count says: what reached
     the number while the instance was not linked is on the Fold only. Write the count and the
     chats added into the A2Z checklist row 7 (counts only).
B10. Functional checks: a non-team phone sends a site Ref line (copy one from a listing's
     WhatsApp button) to 0576267694 → a lead appears and the owner's personal phone gets the note,
     sent from the Bona number. The owner logs in to the dashboard with his personal number → the
     code comes from the Bona number. (Sending switch must be on for a team member's code; the
     owner's own code passes it either way.) A dashboard reply to that test lead arrives from the
     Bona number. Then mark the test lead "Not a client".
B11. Owner by hand, same day: the FB Page / IG WhatsApp button and any click-to-WhatsApp ad
     routing → 0576267694 (A6). Later, slowly, from the checklist: TikTok, LinkedIn, Google
     Business Profile, Snapchat, aqar.fm, the WhatsApp channel (`marketing/whatsapp-channel.md`
     lives on the personal account), the Zoho signature. Repo checklists that still name the old
     WhatsApp number for these profiles: `marketing/instagram-profile.md`,
     `marketing/instagram-connect-checklist.md`, `marketing/instagram-access.md`,
     `marketing/google-business-profile.md` (phone and WhatsApp button both move since 26 Nov).

## C. After

C1. Dana back on when the owner is ready (suggested: after 3 quiet days on the new number), and
    each test stopped in B1 re-armed only if he still wants it: that chat's page → "Let Dana test
    on this chat" (ids in the A2Z checklist row 7).
C2. Brochures (26 Nov): `services/intake/brochure_pdf.py` prints `site.json` phone and WhatsApp. The 21
    published brochures keep the old number (and its wa.me link) until re-rendered; after B7 nothing reads
    that number, so re-render them (intake `brochure <id>`), coordinated with the session that owns the
    intake. New intake brochures follow site.json once ~/bona is pulled to the merged main. Daily property
    posts: only the TikTok reel prints Bona's WhatsApp, site.whatsapp (+966 57 626 7694,
    scripts/social/lib/cards.mjs), in its lower third and on its closing card above the advertiser/FAL line
    (which has no phone); Instagram, Facebook and LinkedIn post the reviewed frames, which print no number.
    Every caption's only number is the REGA advertiser line, which keeps
    site.advertiser.phone (+966593296933, the REGA-registered number; it reaches the owner's personal
    WhatsApp, not the Bona inbox) until the owner updates REGA (Phase 3).
    Done 26 Nov ~13:05: 18 brochures re-rendered through the intake's brochure path (18 commits
    `intake: rebuild brochure <id>`, 0c674db..22aec9b). Left: W011, W018, W024, whose backfill was
    rejected for the owner (district, prices); their old brochures still print the old number (text,
    no link) until he fixes them (a `price` fix rebuilds the brochure) or asks for a rebuild.
C3. Chats still open on the personal number: the owner finishes them by hand from his phone;
    a dashboard reply to such a lead now comes from the Bona number.
C4. Hermes memory (~/.hermes/memories/MEMORY.md lines about the dashboard code and Bona's
    WhatsApp) is out of date: update it in a Hermes session.
C5. The PC bona-api twin stays locked (B5a); its env says abdulaziz-personal. While LOCKED is
    there, `rollback.sh` and `services/deploy/install.sh` from a checkout with this branch refuse
    before they write, stop or start anything (each says why), and systemd refuses every start of
    the unit. Unlock only with the owner (R). Unlocked, a PC rollback still needs the drop-in in
    services/README.md "The PC bona-api twin since the WhatsApp move": `rollback.sh` refuses,
    before it stops anything on the VPS, until the drop-in is there (it prints the steps);
    `--personal-instance` overrides that only for a rollback that also undoes the move (R1 + R2),
    and itself refuses while the drop-in is still loaded (it prints how to take it away);
    `install.sh` has no WhatsApp check (unlocked, it starts the twin on whatever the unit loads).
    An older checkout's rollback.sh and install.sh have no lock check (systemd still refuses the
    start, but an older rollback.sh stops the VPS first): never run them, or sync-secrets.sh, from
    a checkout older than the merge. On this PC `~/bona` IS such an older checkout (ed94e60, not
    auto-pulled) until it is pulled to the merge commit; only ~/bona-publish follows main by itself.
C6. The Evolution API key once leaked into the VPS Caddy log (approvals row 77, "Later"); the
    Bona instance now sits behind the same key.
C7. Public `/health` publishes `poller.instance` (the instance NAME): today "abdulaziz-personal",
    after the cutover "bona". The board on /dashboard/ no longer prints it (verify-integrations).

## R. Rollback

After B7 the fall-back is ONLY the VPS: R1, the two env lines back + `ssh hermes-vps sudo systemctl
restart bona-api` (minutes), with R2 for the site. The PC bona-api twin stays locked (B5a, C5):
rollback.sh and install.sh refuse while it is, and systemd refuses to start it. Unlock
(`rm ~/.config/systemd/user/bona-api.service.d/LOCKED`) only with the owner, and first check
`systemctl --user show bona-api cloudflared-bona -p UnitFileState` says disabled for both (an old
script may have enabled one while it was locked; if so, `systemctl --user disable bona-api
cloudflared-bona` before the rm), or the twin starts on abdulaziz-personal at the next boot.

R1. Env (minutes): restore the backup from B7, or edit the two lines back, then restart:

        ssh hermes-vps 'f=~/.secrets/bona-services.env; cp -p "$f.bak-wa-<stamp>" "$f" && chmod 600 "$f"'
        # or, without the backup:
        ssh hermes-vps 'f=~/.secrets/bona-services.env; sed -i "s/^BONA_WA_INSTANCE=.*/BONA_WA_INSTANCE=abdulaziz-personal/; /^BONA_WA_INSTANCE_JID=/d" "$f" && chmod 600 "$f"'
        ssh hermes-vps sudo systemctl restart bona-api
        ssh hermes-vps 'curl -s http://127.0.0.1:4120/health' | python3 -c 'import json,sys; p=json.load(sys.stdin)["poller"]; print(p["instance"], p.get("ownNumber"))'
        # → abdulaziz-personal owner

    The merged code may stay: with the line gone it behaves exactly as before. The poller resumes
    the abdulaziz-personal cursor from its last tick before the cutover and reads that gap
    (bounded by MAX_PAGES).
R2. Site: revert the merge commit in a PR (CI, then merge) so site.json, the privacy notice, the
    FAQ and Dana's prompt go back; re-run provision.mjs from the reverted main. A site still
    showing the Bona number while the env is rolled back sends WhatsApp clicks to a number
    nothing reads, so do R1 and R2 together.
R3. Dana's setting back to what it was before B1, and the tests B1 stopped re-armed (each id from
    the A2Z checklist row 7: its chat page → "Let Dana test on this chat").
R4. If WhatsApp bans the new number: R1 + R2 the same day (the site, brochures and Page would
    otherwise point at a dead number). The WhatsApp Business account itself is not undone.
```

## Appendix C: Self-review against the brief

| Brief item | Task |
|---|---|
| (1) code split, tests first, unset = today | 1-6 (+ section 1 table) |
| (2) site.json whatsapp only, hand copies, wa.me links | 8, 13 |
| (3) privacy + FAQ EN+AR draft, AI line, dated change line | 8, Appendix A |
| (4) instance name off the public /dashboard/ (integrations.json + verifier) | 8 (`:228`), 10 |
| (5) Retell/Dana prompt and tool texts | 9 |
| (6) pinned tests (seo-jsonld, intake brochure, provision) | 8, 9 |
| (7) sync-secrets guard; PC twin documented | 7, 12 |
| (8) social-bios WhatsApp Business section | 11 |
| Runbook at /home/azoz778/a2z-golive/2026-11-19/bona-wa-cutover-runbook.md | 15, Appendix B |
| Two-model review, no push/merge/deploy | 16 |
| Item 7 vs bona-intake | section 2, "Item 7 and bona-intake" |

## Appendix D: Open points that need the owner

Only what is his to decide or to do; everything else above has a default.

1. **OK the privacy notice and FAQ text (Appendix A, EN and AR)** before the merge. With it, one yes/no: Tarek's full access through Lisa (approvals 2026-11-17) reaches the Evolution gateway and the PC call files, while Bona's notice says only "the owner of Bona and authorised members of the Bona team" read conversations and recordings. Add the optional partner sentence (A2Z's notice v1.1 already says the same for A2Z), or leave it out?
2. **Adverts beside the FAL licence before REGA is updated.** Since the 26 Nov cutover, Bona brochures (all but W011, W018 and W024, which print the old number until rebuilt) and the TikTok reel of the daily property posts (its lower third and closing card; the Instagram, Facebook and LinkedIn frames print no number) print +966 57 626 7694, while the REGA ad licences still list 059 329 6933. The caption's advertiser line next to FAL 1100313556 keeps `site.advertiser.phone` = 059 329 6933, so the 31 reviews stay valid and match REGA (it reaches the owner's personal WhatsApp, not the Bona inbox). `site.phone` moved to the new number too (owner decision 26 Nov). O1 (lawyer OK) already says the REGA line switches too. Default: go ahead, and he updates the REGA records when convenient (Phase 3). The alternative, holding cards and brochures on the old number until then, needs a small code change.
3. **His hands at cutover (no decision):** the ~3 warm-up days on a linked device, one message from his personal WhatsApp to the Bona number, Dana off on the Team page before the switch (and back on later), the Ads Manager check and the FB/IG WhatsApp button, merging the PR.
4. **WhatsApp calls to the Bona number.** The AI line answers phone calls only; the FAQ and the notice now say so and ask callers on WhatsApp to write instead. Default: leave WhatsApp calls ringing (runbook B2 creates the instance with `"rejectCall":false`), so a call he or the team picks up by hand still works. The alternative, `"rejectCall":true` with a `"msgCall"` text (Evolution declines every WhatsApp call and sends that text), also blocks the calls he would take himself.

