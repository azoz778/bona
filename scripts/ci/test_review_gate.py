"""Tests for review_gate.py. Run: python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v"""
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import review_gate as g  # noqa: E402

HEAD = "abc1234def5678900000000000000000000000ab"


def c(body, login="azoz778", at="2026-11-21T10:00:00Z"):
    """A comment as the REST API returns it."""
    return g.from_comment({"user": {"login": login}, "body": body, "created_at": at})


def rv(body, state="COMMENTED", at="2026-11-21T11:00:00Z", login="azoz778"):
    """A review as the REST API returns it."""
    return g.from_review({"user": {"login": login}, "body": body, "state": state, "submitted_at": at})


BOTH = [c(f"Claude review: SHIP {HEAD[:7]}"), c(f"**Codex review: SHIP** {HEAD[:7]}")]


class Decide(unittest.TestCase):
    def state(self, items, head=HEAD):
        return g.decide(items, head)[0]

    def test_both_ship_for_head(self):
        self.assertEqual(g.decide(BOTH, HEAD), ("success", f"Claude and Codex: SHIP {HEAD[:7]}"))
        self.assertEqual(self.state(BOTH, HEAD.upper()), "success")

    def test_formats_and_review_body(self):
        items = [c(f"- Claude review (round 3): SHIP {HEAD}"), rv(f"1. `Codex review: SHIP {HEAD[:10]}`")]
        self.assertEqual(self.state(items), "success")
        self.assertEqual(self.state([c(f"Claude review: SHIP {HEAD[:7]}."), c(f"Codex review: SHIP {HEAD[:7]}")]),
                         "success")

    def test_missing_one(self):
        state, desc = g.decide([c(f"Claude review: SHIP {HEAD[:7]}")], HEAD)
        self.assertEqual(state, "pending")
        self.assertIn("Claude SHIP", desc)
        self.assertIn("Codex missing", desc)

    def test_verdict_for_old_head(self):
        state, desc = g.decide([c("Claude review: SHIP 1111111"), c("Codex review: SHIP 1111111")], HEAD)
        self.assertEqual(state, "pending")
        self.assertIn("Claude not SHIP", desc)

    def test_new_commit_resets(self):
        self.assertEqual(self.state(BOTH, "fffffff" + HEAD[7:]), "pending")

    def test_untrusted_author_ignored(self):
        self.assertEqual(self.state([BOTH[0], c(f"Codex review: SHIP {HEAD[:7]}", login="someone")]), "pending")
        ghost = g.from_comment({"user": None, "body": f"Codex review: SHIP {HEAD[:7]}", "created_at": "x"})
        self.assertEqual(self.state([BOTH[0], ghost]), "pending")

    def test_newest_non_ship_line_blocks(self):
        for line in [f"Codex review: FIX {HEAD[:7]}", "**Codex review: OWED**", f"Codex re-review: FIX {HEAD[:7]}",
                     f"Codex review: SHIP {HEAD[:7]} (withdrawn)", f"> Codex review: FIX {HEAD[:7]}",
                     f"<details><summary>Codex review: FIX {HEAD[:7]}</summary></details>"]:
            self.assertEqual(self.state(BOTH + [c(line, at="2026-11-21T12:00:00Z")]), "pending", line)

    def test_older_fix_then_ship_passes(self):
        items = [c(f"Codex review: FIX {HEAD[:7]}", at="2026-11-21T09:00:00Z")] + BOTH
        self.assertEqual(self.state(items), "success")

    def test_ship_in_quote_or_code_ignored(self):
        claude = BOTH[0]
        for extra in [c(f"> Codex review: SHIP {HEAD[:7]}"), c(f"```\nCodex review: SHIP {HEAD[:7]}\n```"),
                      c(f"Notes:\n\n    Codex review: SHIP {HEAD[:7]}\n"),
                      c(f"Codex review: SHIP deadbee (superseded by {HEAD[:7]})")]:
            self.assertEqual(self.state([claude, extra]), "pending", extra["body"])

    def test_pending_and_dismissed_reviews_ignored(self):
        for state, at in [("PENDING", None), ("DISMISSED", "2026-11-21T11:00:00Z")]:
            self.assertEqual(self.state([BOTH[0], rv(f"Codex review: SHIP {HEAD[:7]}", state=state, at=at)]),
                             "pending")

    def test_description_fits(self):
        self.assertLessEqual(len(g.decide([], HEAD)[1]), 140)

    def test_untrusted_review_ignored(self):
        self.assertEqual(self.state([BOTH[0], rv(f"Codex review: SHIP {HEAD[:7]}", login="someone")]), "pending")

    def test_dash_and_quote_lines_are_fast(self):
        # Lines like these made VERDICT_START backtrack for seconds to minutes; without a model name and
        # "review"/"verdict" they are now skipped before the regex runs.
        start = time.monotonic()
        lines = ["Findings " + "-" * 80, "'" * 80, "- " + "-" * 80, "| " + "-|" * 60, "Notes " + "'-" * 60]
        self.assertEqual(self.state(BOTH + [c("\n".join(lines), at="2026-11-21T12:00:00Z")]), "success")
        self.assertLess(time.monotonic() - start, 1.0)


class Main(unittest.TestCase):
    """main() against a fake GitHub API: which head, which comments, what it writes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # One (head, comments) snapshot per evaluation; each read of the PR moves to the next one.
        self.posts, self.snapshots, self.now = [], [(HEAD, [])], None
        real_api = g.api
        self.addCleanup(setattr, g, "api", real_api)
        g.api = self.fake_api
        for k, v in {"GITHUB_TOKEN": "t", "GITHUB_REPOSITORY": "o/r", "GITHUB_RUN_ID": "9"}.items():
            old = os.environ.get(k)
            self.addCleanup(lambda k=k, old=old: os.environ.pop(k) if old is None else os.environ.__setitem__(k, old))
            os.environ[k] = v

    def fake_api(self, path, token, method="GET", body=None):
        if method == "POST":
            self.posts.append((path, body))
            return {}
        if path == "/repos/o/r/pulls/5":
            self.now = self.snapshots.pop(0) if len(self.snapshots) > 1 else self.snapshots[0]
            return {"head": {"sha": self.now[0]}}
        page = int(path.rsplit("page=", 1)[1])
        if path.startswith("/repos/o/r/issues/5/comments?per_page=100&page="):
            return self.now[1][(page - 1) * 100:page * 100]
        if path.startswith("/repos/o/r/pulls/5/reviews?per_page=100&page="):
            return []
        raise AssertionError(path)

    def run_main(self, event):
        path = os.path.join(self.tmp.name, "event.json")
        with open(path, "w") as f:
            json.dump(event, f)
        os.environ["GITHUB_EVENT_PATH"] = path
        self.assertEqual(g.main(), 0)

    @staticmethod
    def raw(body, login="azoz778", at="2026-11-21T10:00:00Z"):
        return {"user": {"login": login}, "body": body, "created_at": at}

    def ship(self):
        return [self.raw(f"Claude review: SHIP {HEAD[:7]}"), self.raw(f"Codex review: SHIP {HEAD[:7]}")]

    def test_success_on_current_head_not_event_head(self):
        self.snapshots = [(HEAD, self.ship())]
        self.run_main({"pull_request": {"number": 5, "head": {"sha": "0" * 40}}})
        self.assertEqual([(p, b["state"]) for p, b in self.posts],
                         [(f"/repos/o/r/statuses/{HEAD}", "pending"), (f"/repos/o/r/statuses/{HEAD}", "success")])
        self.assertEqual(self.posts[-1][1]["context"], "two-model-review")

    def test_reads_every_page(self):
        filler = [self.raw("thanks", login="someone")] * 99
        self.snapshots = [(HEAD, [self.ship()[0]] + filler + [self.raw(f"Codex review: SHIP {HEAD[:7]}", at="2026-11-21T11:00:00Z")])]
        self.run_main({"issue": {"number": 5, "pull_request": {"url": "u"}}})
        self.assertEqual(self.posts[-1][1]["state"], "success")

    def test_head_moves_during_check(self):
        self.snapshots = [(HEAD, []), (HEAD, self.ship()), ("f" * 40, self.ship())]
        self.run_main({"pull_request": {"number": 5}})
        path, body = self.posts[-1]
        self.assertEqual((path, body["state"]), ("/repos/o/r/statuses/" + "f" * 40, "pending"))

    def test_verdict_deleted_during_check(self):
        self.snapshots = [(HEAD, []), (HEAD, self.ship()), (HEAD, self.ship()[:1])]
        self.run_main({"pull_request": {"number": 5}})
        self.assertEqual([b["state"] for _, b in self.posts], ["pending", "pending"])

    def test_api_error_leaves_error_not_success(self):
        self.snapshots = [(HEAD, self.ship())]
        real = g.pages

        def broken(path, token):
            raise OSError("HTTP 502")
        g.pages = broken
        self.addCleanup(setattr, g, "pages", real)
        with self.assertRaises(OSError):
            self.run_main({"pull_request": {"number": 5}})
        self.assertEqual([b["state"] for _, b in self.posts], ["pending", "error"])

    def test_plain_issue_comment_writes_nothing(self):
        self.run_main({"issue": {"number": 5}})
        self.assertEqual(self.posts, [])

    def test_missing_verdicts_pending(self):
        self.run_main({"pull_request": {"number": 5}})
        self.assertEqual([b["state"] for _, b in self.posts], ["pending", "pending"])


class Events(unittest.TestCase):
    def test_pr_number(self):
        self.assertEqual(g.pr_number({"pull_request": {"number": 5}}), 5)
        self.assertEqual(g.pr_number({"issue": {"number": 6, "pull_request": {"url": "u"}}}), 6)
        self.assertIsNone(g.pr_number({"issue": {"number": 7}}))
        self.assertIsNone(g.pr_number({}))


if __name__ == "__main__":
    unittest.main()
