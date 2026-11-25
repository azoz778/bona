"""Tests for review_gate.py. Run: python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v"""
import os
import sys
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


class Events(unittest.TestCase):
    def test_pr_number(self):
        self.assertEqual(g.pr_number({"pull_request": {"number": 5}}), 5)
        self.assertEqual(g.pr_number({"issue": {"number": 6, "pull_request": {"url": "u"}}}), 6)
        self.assertIsNone(g.pr_number({"issue": {"number": 7}}))
        self.assertIsNone(g.pr_number({}))


if __name__ == "__main__":
    unittest.main()
