# bona: agent rules

## Rules for every agent (Claude, Codex, Hermes, ...)

Owner rules, written down 2026-11-21. They apply to every change in this repo.

1. **Never push to `main` directly.** Cut a branch from `origin/main`, push it, open a PR.
2. **Two-model review, always.** Claude AND Codex review every change before it merges.
   Post each verdict as a PR comment for the PR head commit, one line each:
   `Claude review: SHIP <sha7>` and `Codex review: SHIP <sha7>`.
   A new commit needs fresh verdicts. If the two models disagree, tell the owner what each said.
   If Codex is out of quota, mark the review OWED and wait. Never use a local model instead.
3. **Merge only when CI is green on the head commit.** If CI is red, pending or did not run, stop and tell the owner.
4. **No secrets in git.** A gitleaks check runs on commit; do not bypass it with `--no-verify`.
   Secrets live in `~/secrets-vault` (owner PC), never in this repo.
5. **Show the evidence.** Do not say "fixed" or "done" without the test/build output.
6. **After a production change**, record the rollback commit and tell the owner what shipped.

## This repo
- **This repo is PUBLIC.** Never commit client data, phone numbers, prices that are withheld from the
  public site, or anything private. Everything here can be read by anyone.
- Production: every push to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`).
- A local pre-push guard (W009) runs on push; do not bypass it.
