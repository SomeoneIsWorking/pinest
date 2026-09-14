"""The push-signaling check must not accept a machine that is polling.

The gap this closes is specific: a listener can be proved in a script while the
RUNNING machine still reads the document on a timer, and only one of those is the
thing being claimed. So the host's own report is part of the gate, not a footnote.
"""

from __future__ import annotations

import contextlib
import io
import unittest
from unittest import mock

import verify_push_signaling as v


class HostModeTest(unittest.TestCase):
    def test_a_polling_machine_is_not_push(self) -> None:
        self.assertEqual(v.host_mode({"signalingMode": "poll"}), "poll")

    def test_a_listening_machine_reports_push(self) -> None:
        self.assertEqual(v.host_mode({"signalingMode": "push"}), "push")

    def test_a_machine_that_says_nothing_is_refused_by_name(self) -> None:
        # An older bundle carries no mode at all, and "absent" must never be read
        # as "probably push".
        with self.assertRaises(v.VerificationError) as caught:
            v.host_mode({})
        self.assertIn("signalingMode", str(caught.exception))


class MainTest(unittest.TestCase):
    def _run(self, state: dict[str, object], probe: int = 0) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
                mock.patch.object(v, "run_probe", return_value=probe), \
                mock.patch.object(v, "live_host", return_value=(1234, state)):
            code = v.main([])
        return code, out.getvalue()

    def test_a_polling_machine_fails_the_check(self) -> None:
        code, output = self._run({"signalingMode": "poll"})
        self.assertEqual(code, 1)
        self.assertIn("is polling", output)

    def test_a_listening_machine_passes(self) -> None:
        code, output = self._run({"signalingMode": "push"})
        self.assertEqual(code, 0)
        self.assertIn("VERIFIED", output)

    def test_a_failed_probe_fails_even_when_the_machine_looks_right(self) -> None:
        # The listener proof and the machine's claim are separate facts; either
        # one failing is a failure.
        code, _ = self._run({"signalingMode": "push"}, probe=3)
        self.assertEqual(code, 3)

    def test_a_machine_that_cannot_be_reached_is_not_a_pass(self) -> None:
        code, output = self._run({"signalingMode": "push"})
        with mock.patch.object(v, "live_host", side_effect=RuntimeError("no live host")):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), mock.patch.object(v, "run_probe", return_value=0):
                code = v.main([])
        self.assertEqual(code, 1)
        self.assertIn("unavailable", out.getvalue())


class WaitTest(unittest.TestCase):
    def test_the_baseline_is_the_running_load(self) -> None:
        record = {"sourceFingerprint": "abc·55", "at": "2026-09-14T16:48:09.170Z"}
        self.assertEqual(v.load_identity(record), ("abc·55", "2026-09-14T16:48:09.170Z"))
        self.assertEqual(v.load_identity(None), (None, None))

    def test_a_machine_that_never_reloads_is_refused(self) -> None:
        # Grading the old bundle while claiming to have verified the new one is
        # the failure this waiting form exists to prevent.
        with mock.patch.object(v, "read_runtime_record", return_value={"sourceFingerprint": "same"}), \
                mock.patch.object(v, "describe_record", return_value="same"), \
                mock.patch.object(v.time, "monotonic", side_effect=[0.0, 0.0, 99.0]), \
                mock.patch.object(v.time, "sleep", lambda _s: None):
            with self.assertRaises(v.VerificationError) as caught:
                v.wait_for_new_load(("same", None), 1.0)
        self.assertIn("did not report a new load", str(caught.exception))

    def test_a_landed_reload_ends_the_wait(self) -> None:
        records = [{"sourceFingerprint": "old"}, {"sourceFingerprint": "new"}]
        with mock.patch.object(v, "read_runtime_record", side_effect=records), \
                mock.patch.object(v, "describe_record", return_value="new"), \
                mock.patch.object(v.time, "sleep", lambda _s: None):
            v.wait_for_new_load(("old", None), 60.0)


if __name__ == "__main__":
    unittest.main()
