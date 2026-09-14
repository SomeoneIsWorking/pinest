"""The browser-reload request and the report it comes back with.

These are pure helpers, and they are where the lying happens if they are wrong:
"the browser has not reported" and "the browser reported and it looks fine" must
never print the same, and a request that was never delivered must not read as
success.
"""

from __future__ import annotations

import time
import unittest

from reload_client import describe_report, reload_client_command


class ReloadClientCommandTest(unittest.TestCase):
    def test_the_command_asks_for_exactly_one_thing(self) -> None:
        frame = reload_client_command("abc")
        self.assertEqual(frame["type"], "command")
        self.assertEqual(frame["cmd"]["type"], "reload_client")
        self.assertEqual(frame["cmd"]["id"], "abc")

    def test_the_command_carries_nothing_else(self) -> None:
        # A reload request that grew other fields would be a second way to drive
        # the browser through a field meant for one instruction.
        self.assertEqual(set(reload_client_command("abc")["cmd"]), {"type", "id"})


class DescribeReportTest(unittest.TestCase):
    """Every branch is a sentence: a diagnostic that can print nothing lies."""

    def test_an_absent_report_says_the_machine_has_read_nothing(self) -> None:
        line = describe_report(None)
        self.assertIn("has not yet read a report", line)
        self.assertTrue(line.strip(), "an empty line cannot be told from a failure")

    def test_an_unreadable_report_names_the_problem(self) -> None:
        line = describe_report({"read": False, "problem": "the report is a list, not an object"})
        self.assertIn("could not read", line)
        self.assertIn("the report is a list, not an object", line)

    def test_a_connected_report_names_the_path_and_the_browser(self) -> None:
        at = int(time.time() * 1000) - 12_000
        line = describe_report(
            {
                "read": True,
                "at": at,
                "platform": "Zen",
                "connected": True,
                "path": "direct",
                "lastError": None,
                "bundle": "ec71bd75",
                "summary": "the browser (Zen) reported 12s ago: connected via direct",
            }
        )
        self.assertIn("Zen", line)
        self.assertIn("connected via direct", line)
        self.assertIn("bundle ec71bd75", line)
        self.assertIn("12s ago", line)
        self.assertNotIn("last error", line)

    def test_a_failing_report_names_the_failure(self) -> None:
        line = describe_report(
            {
                "read": True,
                "at": int(time.time() * 1000),
                "platform": "Zen",
                "connected": False,
                "path": "none",
                "lastError": "Failed to connect WebSocket",
            }
        )
        self.assertIn("not connected", line)
        self.assertIn("Failed to connect WebSocket", line)

    def test_the_age_is_never_negative(self) -> None:
        # The app's clock is not this machine's: a report from a browser running
        # ahead must read as "just now", never as a negative age.
        future = int(time.time() * 1000) + 600_000
        line = describe_report({"read": True, "at": future, "platform": "Zen", "connected": False})
        self.assertIn("0s ago", line)


if __name__ == "__main__":
    unittest.main()
