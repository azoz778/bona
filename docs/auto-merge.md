# PR checks and auto-merge

Every pull request into `main` gets two checks. The `main` ruleset requires both, so a PR can merge itself
(GitHub auto-merge) as soon as they are green, and nobody has to watch it.

**Status: live since 2026-11-25 21:13 (+03).** Rollout: the two checks (#74); the owner-approved settings
(below); the owner's local helper (`~/.claude/scripts/automerge-on.py`); live tests on throwaway PRs (#76, #77),
during which #71 became the first real PR to merge itself. What the tests showed:
- The owner's account (repo admin, allowed to bypass the ruleset) sees a PR with pending checks as `blocked`,
  so the helper can arm it, and GitHub does not merge it at once (#76).
- Auto-merge armed by that account still waits for both checks. It stayed blocked with `ci` green and no
  `two-model-review` status, with only one verdict, and with both verdicts for an older head (#76), and with
  both verdicts but `ci` red (#77). Both were closed unmerged.
- The `two-model-review` status written by the workflow token satisfies the check pinned to GitHub Actions:
  #71 merged itself about 20 seconds after its second verdict.
- A new commit pushed to the PR's branch by the owner's account (write access) did not cancel the armed
  auto-merge (still armed, same enabled time), and the new head had no `two-model-review` status, so it waited
  (#76). GitHub's docs say a push by someone without write access does turn auto-merge off.

| Check | Where | Green when |
|---|---|---|
| `ci` | `.github/workflows/ci.yml` | the deploy build job's checks pass on the PR's code: `npm test`, intake tests, review-gate tests, `validate.mjs`, `gen-llms`, `build`, `test:dist` (no TK sync, no Pages). About 6 minutes. |
| `two-model-review` | `.github/workflows/review-gate.yml`, `scripts/ci/review_gate.py` | the newest Claude and Codex verdicts by `azoz778` are exactly `Claude review: SHIP <sha>` and `Codex review: SHIP <sha>` for the **current** head (AGENTS.md rule 2). |

## The flow

1. Open the PR. Turn auto-merge on right away (Claude, on the owner's PC):
   `~/.claude/scripts/automerge-on.py azoz778/bona <N> <full head sha>`.
   It arms GitHub auto-merge (squash; GitHub checks that head when arming) only for a same-repo PR into `main`
   that GitHub reports as blocked, when the rules require both checks; it never merges anything itself. The owner's local
   merge guard keeps refusing `gh pr merge` (with or without `--auto`) until CI and both verdicts are in.
   The owner can use GitHub's "Enable auto-merge" button instead. It skips the helper's checks, so use it only
   on a same-repo PR (never one from a fork) into `main` while the ruleset above is active, and never with the
   "bypass rules" option: the merge must wait for green `ci` and both `SHIP` verdicts for the current head.
2. Claude and Codex review that head. Post both verdicts as PR **comments**, one line each.
3. `two-model-review` turns green; once `ci` is green too, GitHub merges, and `deploy.yml` deploys `main`.
4. A new commit resets the gate: the new head has no `two-model-review` status at all ("Expected"), so the PR
   waits until fresh verdicts for that head are posted. The gate runs only on the owner's PR comments. The armed
   auto-merge stays armed across a push by the owner's account (tested in #76 and #78); a push by someone
   without write access turns it off. If `gh pr view <N> -R azoz778/bona --json autoMergeRequest`
   shows `null`, run the helper again with the new head, unless someone turned it off on purpose ("Stopping a
   PR"); if unsure, ask the owner. If a PR with both checks green has not merged after a few minutes, tell the
   owner rather than trying other ways to merge it.

## Stopping a PR

- `gh pr merge <N> -R azoz778/bona --disable-auto` (as the whole command), or close the PR. These stop it at once.
- Posting a `FIX` verdict or deleting a `SHIP` re-runs the gate, but it is not an instant stop: a run that was
  already reading can still write green just before (see limits). Disable auto-merge when it matters.
- **Before changing or deleting the ruleset, disable auto-merge on every open PR.** Without the ruleset, an
  armed PR merges as soon as GitHub re-evaluates it, with or without verdicts.
- **Do not change the base branch of an armed PR**: disable auto-merge first. The ruleset only covers `main`;
  an armed PR moved to another branch can merge into it without the checks (not tested live).

## Settings (owner-approved 2026-11-25)

- `allow_auto_merge = true`.
- Repository ruleset "main: CI + two-model review" on the default branch: required status checks `ci` and
  `two-model-review`, both from GitHub Actions (integration 15368), not strict (no forced rebases).
- Bypass: the repository admin role, mode "always". The Bona intake (`services/intake/lib/publish.mjs`) pushes
  listings straight to `main` with the owner's token; without the bypass every listing push would be refused.

## When the gate looks stuck

- `two-model-review` says pending with the reason (e.g. "Codex missing"). Post the missing verdict.
- It says `error`: re-run that workflow run (Actions tab, or `gh run rerun <id> -R azoz778/bona`); every run
  reads the current state.
- It says pending because "GitHub's comment list is behind": post a new owner comment (or edit one). Do not
  re-run that old run: it waits for its own comment as it was then, which a later edit has replaced.
- No `two-model-review` status at all on the head ("Expected"): nothing has run for this head yet, e.g. the
  verdicts were posted while GitHub still showed an older head. Any new owner comment (or editing one)
  re-runs the gate.
- Once a run has written `pending` (its first write), a run that dies later leaves the PR blocked, with one
  exception: if GitHub accepts the final `success` but the answer is lost, the run's `error` write is best
  effort (and auto-merge may already have seen the green). A run that fails before its first write
  (checkout, no runner, GitHub down) changes nothing.

## Known limits (a process check, not a security boundary)

- A commit status belongs to a commit, not to a PR. Two PRs with the same head share it, and a branch reset to
  an earlier, approved commit is green again until the owner's next comment re-runs the gate (we only push
  forward, so this does not come up in the normal flow).
- One gate run at a time per PR (job-level concurrency after the owner-only `if`). That a skipped run (someone
  else's comment) never takes the slot or cancels a queued owner run is assumed, not documented by GitHub and
  not tested live.
- A run that fails before its first write (GitHub's API down for all retries, a checkout or runner failure)
  leaves an earlier green in place until the next owner comment. Use `--disable-auto` to stop a PR.
- GitHub keeps at most 1,000 statuses per commit and context; each gate run writes two. Not reachable in
  practice (about 500 owner comments on one commit).
- Verdict lines in review bodies count (as in the local guard), but only comments re-run the gate.
- The required checks are bound to the GitHub Actions app, not to these workflows. Two things satisfy them: a
  check run from a job named `ci` or `two-model-review` in a workflow started by a push or pull-request event
  (not a manual run), and a commit status of that name posted by a job allowed to write statuses
  (`statuses: write`); if both exist under one name, both must pass. A same-repo PR's own workflows, or one
  pushed on another branch, can do either, and a PR can change its own `ci.yml`. A **fork PR's** own workflows
  run too (after a first-time contributor is approved, at once for anyone who has had a change merged before);
  a fork's token cannot write statuses, but a job name is enough. So green checks on a fork PR prove nothing:
  never arm or merge a fork PR on its checks; the helper refuses forks. With auto-merge armed before the
  reviews (owner decision 2026-11-25), such a check could merge a same-repo PR before anyone looks. It is a
  process check for agents that follow these rules, not a security boundary; the owner's token can also bypass
  the ruleset.
- A verdict withdrawn while a gate run is reading can be overwritten by that run's green (the window is the
  length of one read). Use `--disable-auto` to stop a PR.
- A very long run of `-` or `'` on a comment line that also names a model and says "review" or "verdict" makes
  the verdict regex slow (it is the local guard's regex, kept identical). The run then times out and the PR
  stays pending until that comment is edited.
- Ordering by comment creation time and the 7-character SHA prefix are the local guard's rules, kept identical.

## Rollback

Disable auto-merge on open PRs, delete the ruleset (`gh api -X DELETE repos/azoz778/bona/rulesets/<id>`), set
`allow_auto_merge=false`, and revert the commit that added `ci.yml` and `review-gate.yml`.
