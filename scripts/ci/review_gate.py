#!/usr/bin/env python3
"""Two-model review gate: sets the commit status `two-model-review` on a PR's head commit.

Owner rule (AGENTS.md rule 2): Claude AND Codex review every change, and each verdict is posted as
a PR comment for the head commit, one line each:  Claude review: SHIP <sha7>  /  Codex review: SHIP <sha7>.
The status is `success` only when, for EACH model, the newest verdict-like line written by a trusted
author (comments and submitted, non-dismissed reviews; quotes and code blocks ignored) is exactly a
SHIP for a prefix of the CURRENT head. Anything else is `pending` with a short reason, so a new commit
resets the gate. The `main` ruleset requires this status (and `ci`) before a PR can merge.

The parsing (VERDICT_START, CANONICAL, verdicts) is a verbatim copy of the owner's local merge guard
(~/.claude/hooks/guard-main.py), so the server and the guard read the same comments the same way.
Change both together.

Runs from the default branch on owner PR comments (.github/workflows/review-gate.yml). It reads comments
over the API and never checks out or runs code from the pull request. Python standard library only.

Known limits (docs/auto-merge.md): a commit status belongs to a commit, not to a PR (two PRs with the same
head share it; a branch reset to an approved commit is green again until this re-runs); verdicts in review
bodies count but only comments trigger a re-check; and any workflow in a same-repo PR could post this
status, so this is a process check that the two reviews of the diff back up, not a security boundary.
"""
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

CONTEXT = "two-model-review"
TRUSTED_AUTHORS = {"azoz778"}
MODELS = ("claude", "codex")
API = os.environ.get("GITHUB_API_URL", "https://api.github.com")

# ---- verbatim from guard-main.py -------------------------------------------------------------------
VERDICT_START = re.compile(r"^(?:[\w'-]+\W+){0,5}?(claude|codex)\b(?:\W+[\w-]+){0,3}?\W+(?:re-?review|review|verdict)\b",
                           re.I)
CANONICAL = re.compile(r"(claude|codex) review(?: \(round \d+\))?: ship ([0-9a-f]{7,40})\.?", re.I)


def verdicts(items, head):
    """{model: True if its newest verdict-like line is exactly canonical SHIP for head}."""
    dated = []
    for it in items:
        if ((it.get("author") or {}).get("login") or "").lower() not in TRUSTED_AUTHORS:
            continue
        if "state" in it:  # a review
            if (it.get("state") or "").upper() in ("PENDING", "DISMISSED") or not it.get("submittedAt"):
                continue
        dated.append((it.get("submittedAt") or it.get("createdAt") or "", it.get("body") or ""))
    dated.sort(key=lambda x: x[0])
    out = {}
    for _, body in dated:
        fence = None  # (char, length) of the open code fence, CommonMark rules
        for line in body.splitlines():
            s = line.strip()
            fm = re.match(r"^(?:(?:[-+*]|\d+[.)])\s+)*(`{3,}|~{3,})(.*)$", s)
            if fm:
                mark = fm.group(1)
                if fence is None:
                    fence = (mark[0], len(mark))
                elif mark[0] == fence[0] and len(mark) >= fence[1] and not fm.group(2).strip():
                    fence = None
                continue
            quoted = bool(fence) or s.startswith(">") or line.startswith("    ") or line.startswith("\t")
            clean = re.sub(r"<[^>]{0,200}>", " ", s)            # HTML (<details>, <summary>...)
            clean = re.sub(r"^(?:>\s*)+", "", clean)
            clean = re.sub(r"[*_`]", "", clean)
            clean = re.sub(r"^(?:[-+•|#]+\s*|\d+[.)]\s*)+", "", clean).strip()
            if not (re.search(r"claude|codex", clean, re.I) and re.search(r"review|verdict", clean, re.I)):
                continue  # VERDICT_START cannot match without both; skipping its slow backtracking changes nothing
            m = VERDICT_START.match(clean)
            if not m:
                continue
            c = CANONICAL.fullmatch(clean)
            ship = bool(c) and c.group(1).lower() == m.group(1).lower() and head.startswith(c.group(2).lower())
            if quoted and ship:
                continue  # a SHIP inside a quote or code block never approves; anything else still blocks
            out[m.group(1).lower()] = ship
    return out
# ---- end of the verbatim copy ----------------------------------------------------------------------


def from_comment(c):
    """A REST issue comment in the shape `gh pr view --json comments` gives the guard."""
    return {"author": {"login": (c.get("user") or {}).get("login") or ""},
            "body": c.get("body") or "", "createdAt": c.get("created_at") or ""}


def from_review(r):
    """A REST review in the shape `gh pr view --json reviews` gives the guard."""
    return {"author": {"login": (r.get("user") or {}).get("login") or ""}, "body": r.get("body") or "",
            "state": (r.get("state") or "").upper(), "submittedAt": r.get("submitted_at")}


def decide(items, head):
    """(state, description) for the head commit."""
    head = head.lower()
    v = verdicts(items, head)
    if all(v.get(m) for m in MODELS):
        return "success", f"Claude and Codex: SHIP {head[:7]}"
    said = {True: "SHIP", False: "not SHIP", None: "missing"}
    parts = [f"{m.capitalize()} {said[v.get(m)]}" for m in MODELS]
    return "pending", f"Waiting for both SHIP verdicts for {head[:7]}: {', '.join(parts)}"


def pr_number(event):
    """The pull request this event is about, or None (an issue comment on a plain issue)."""
    if event.get("pull_request"):
        return event["pull_request"].get("number")
    issue = event.get("issue") or {}
    if issue.get("pull_request"):
        return issue.get("number")
    return None


RETRY_WAITS = (3, 10, 30)  # seconds between attempts when GitHub or the network fails
CATCH_UP_WAIT = 5  # seconds before reading the comments again when they do not show this run's event yet


def api(path, token, method="GET", body=None, retry=True):
    """JSON from the GitHub API. With retry, transient failures are tried again: 5xx, 429, a rate-limit 403,
    network errors, a dropped connection, a cut-off or non-JSON body."""
    req = urllib.request.Request(API + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}",
                                          "Accept": "application/vnd.github+json",
                                          "Content-Type": "application/json",
                                          "X-GitHub-Api-Version": "2022-11-28",
                                          "User-Agent": "bona-review-gate"})
    for wait in (RETRY_WAITS if retry else ()) + (None,):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:  # before OSError: HTTPError is one
            headers = e.headers or {}
            limited = e.code == 403 and (headers.get("Retry-After") or headers.get("X-RateLimit-Remaining") == "0")
            if wait is None or not (e.code >= 500 or e.code == 429 or limited):
                raise
        except (OSError, http.client.HTTPException, ValueError):
            if wait is None:
                raise
        time.sleep(wait)


def pages(path, token):
    out, page = [], 1
    while True:
        batch = api(f"{path}?per_page=100&page={page}", token)
        out += batch
        if len(batch) < 100:
            return out
        page += 1


def caught_up(event, comments):
    """False when the comments read from the API do not show yet the comment event that started this run
    (created/edited: present with that body; deleted: gone)."""
    c = event.get("comment") or {}
    if not c.get("id"):
        return True
    found = [x for x in comments if x.get("id") == c["id"]]
    if event.get("action") == "deleted":
        return not found
    return bool(found) and (found[0].get("body") or "") == (c.get("body") or "")


def evaluate(repo, number, token, event):
    """(current head sha, state, description) from the PR's comments and reviews."""
    pr = api(f"/repos/{repo}/pulls/{number}", token)  # the CURRENT head, not the one in the event
    head = pr["head"]["sha"]
    comments = pages(f"/repos/{repo}/issues/{number}/comments", token)
    if not caught_up(event, comments):
        time.sleep(CATCH_UP_WAIT)
        comments = pages(f"/repos/{repo}/issues/{number}/comments", token)
        if not caught_up(event, comments):
            return head, "pending", "GitHub's comment list is behind the comment that started this run; post a new comment"
    items = [from_comment(c) for c in comments]
    items += [from_review(r) for r in pages(f"/repos/{repo}/pulls/{number}/reviews", token)]
    return (head,) + decide(items, head)


def main():
    token, repo = os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"]
    with open(os.environ["GITHUB_EVENT_PATH"]) as f:
        event = json.load(f)
    number = pr_number(event)
    if not number:
        print("not a pull request event; nothing to do")
        return 0
    run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"

    def post(sha, state, description):
        # A success is written once, never retried: a retry could land after a verdict was withdrawn.
        api(f"/repos/{repo}/statuses/{sha}", token, "POST",
            {"state": state, "context": CONTEXT, "description": description[:140], "target_url": run_url},
            retry=state != "success")

    head = None  # an issue_comment event carries no head sha; api() retries before giving up
    try:
        # Pending first: if this run dies (API error, timeout), the head is left blocked, never green.
        head = api(f"/repos/{repo}/pulls/{number}", token)["head"]["sha"]
        post(head, "pending", "Checking the Claude and Codex verdicts")
        head, state, description = evaluate(repo, number, token, event)
        if state == "success":
            # Read everything again right before writing success: a verdict deleted or a commit pushed while
            # this run was reading must not be overwritten by a green status (that event's run waits behind us).
            head2, state, description = evaluate(repo, number, token, event)
            if head2 != head:
                head, state, description = head2, "pending", f"The head moved to {head2[:7]} during the check"
        post(head, state, description)
    except Exception:
        if head:
            try:
                post(head, "error", "The review gate could not read GitHub; re-run it")
            except Exception:
                pass
        raise
    print(f"PR #{number} head {head}: {state}: {description}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
