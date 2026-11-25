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

Runs from the default branch (.github/workflows/review-gate.yml). It reads comments over the API and
never checks out or runs code from the pull request. Python standard library only.
"""
import json
import os
import re
import sys
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


def api(path, token, method="GET", body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}",
                                          "Accept": "application/vnd.github+json",
                                          "X-GitHub-Api-Version": "2022-11-28",
                                          "User-Agent": "bona-review-gate"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def pages(path, token):
    out, page = [], 1
    while True:
        batch = api(f"{path}?per_page=100&page={page}", token)
        out += batch
        if len(batch) < 100:
            return out
        page += 1


def main():
    token, repo = os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"]
    with open(os.environ["GITHUB_EVENT_PATH"]) as f:
        event = json.load(f)
    number = pr_number(event)
    if not number:
        print("not a pull request event; nothing to do")
        return 0
    pr = api(f"/repos/{repo}/pulls/{number}", token)  # the CURRENT head, not the one in the event
    head = pr["head"]["sha"]
    items = [from_comment(c) for c in pages(f"/repos/{repo}/issues/{number}/comments", token)]
    items += [from_review(r) for r in pages(f"/repos/{repo}/pulls/{number}/reviews", token)]
    state, description = decide(items, head)
    run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
    api(f"/repos/{repo}/statuses/{head}", token, "POST",
        {"state": state, "context": CONTEXT, "description": description[:140], "target_url": run_url})
    print(f"PR #{number} head {head}: {state}: {description}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
