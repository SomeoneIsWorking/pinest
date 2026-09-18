"""The browser-reload request and the report it comes back with.

These are pure helpers, and they are where the lying happens if they are wrong:
"the browser has not reported" and "the browser reported and it looks fine" must
never print the same, and a request that was never delivered must not read as
success.
"""

from __future__ import annotations

import time
import unittest

from reload_client import describe_report, describe_transport, reload_client_command


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


class DescribeTransportTest(unittest.TestCase):
    def test_missing_or_empty_p2p_explains_absence(self) -> None:
        self.assertIn("not publishing a transport state", describe_transport({}))
        self.assertIn("no direct offer at all", describe_transport({"p2p": {}}))

    def test_connected_p2p_reports_traffic_and_bridge_socket(self) -> None:
        p2p = {
            "offerTs": 1000,
            "channelOpen": True,
            "framesToServer": 5,
            "framesToClient": 20,
            "rawIn": 5,
            "exchanges": 2,
            "channelCloses": 1,
            "bridges": 2,
            "bridgeSocket": "open",
        }
        line = describe_transport({"p2p": p2p})
        self.assertIn("connected now", line)
        self.assertIn("5 in / 20 out (5 reached the bridge)", line)
        self.assertIn("the socket to itself is open", line)

    def test_disconnected_p2p_names_earlier_failure_honestly(self) -> None:
        p2p = {
            "offerTs": 1000,
            "offerAgeMs": 3000,
            "channelOpen": False,
            "framesToServer": 0,
            "framesToClient": 0,
            "rawIn": 0,
            "exchanges": 1,
            "channelCloses": 0,
            "bridges": 0,
            "lastError": "authentication expired",
        }
        line = describe_transport({"p2p": p2p})
        self.assertIn("nothing connected now", line)
        self.assertIn("newest offer 3s old", line)
        self.assertIn("an earlier failure: authentication expired", line)



if __name__ == "__main__":
    unittest.main()
