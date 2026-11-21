# bona: agent rules

## Rules for every agent (Claude, Codex, Hermes, ...)

Owner rules, written down 2026-11-21. They apply to every change in this repo.

1. **Never push to `main` directly.** Cut a branch from `origin/main`, push it, open a PR.
   Exception, by design: the Bona intake service publishes by pushing to `main` itself
   (`services/intake/lib/publish.mjs`). Do not "fix" that; it is not an agent.
2. **Two-model review, always.** Claude AND Codex review every change before it merges.
   Post each verdict as a PR comment for the PR head commit, one line each:
   `Claude review: SHIP <sha7>` and `Codex review: SHIP <sha7>`.
   A new commit needs fresh verdicts. If the two models disagree, tell the owner what each said.
   If Codex is out of quota, mark the review OWED and wait. Never use a local model instead.
3. **Merge only with evidence that the head commit works.** This repo has no PR CI yet: run the tests and
   the build locally on the PR head, paste the output in the PR, and let the owner merge.
4. **No secrets in git.** There is no secret scan on commit in this repo, so check every diff yourself.
   Secrets live in the owner's secrets vault, never in this repo.
5. **Show the evidence.** Do not say "fixed" or "done" without the test/build output.
6. **After a production change**, record the rollback commit and tell the owner what shipped.

## This repo
- **This repo is PUBLIC.** Never commit client data, phone numbers, prices that are withheld from the
  public site, or anything private. Everything here can be read by anyone.
- Production: every push to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`), and so do
  the daily 06:00 Riyadh rebuild and manual runs.
- A local pre-push guard (W009) runs on push; do not bypass it.
