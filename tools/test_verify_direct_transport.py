"""The wait semantics of the live direct-transport check.

The check must not report success for a machine that has not loaded the code it
is supposed to be verifying: a reload requested from inside a turn is deferred,
so "verify now" and "verify after the reload" are different questions and the
tool has to answer the one it was asked.
"""

from __future__ import annotations

import contextlib
import io
import unittest
from unittest import mock

import verify_direct_transport as v


class LoadIdentityTest(unittest.TestCase):
    def test_no_record_has_no_identity(self) -> None:
        self.assertEqual(v.load_identity(None), (None, None))

    def test_identity_is_the_fingerprint_and_the_load_time(self) -> None:
        record = {"sourceFingerprint": "abc·55", "at": "2026-09-14T15:30:13.424Z"}
        self.assertEqual(v.load_identity(record), ("abc·55", "2026-09-14T15:30:13.424Z"))

    def test_a_relaunch_of_the_same_sources_is_a_new_load(self) -> None:
        # The same code loaded again has a new timestamp: a machine that
        # restarted is running the code, which is what was asked.
        before = {"sourceFingerprint": "abc·55", "at": "t1"}
        after = {"sourceFingerprint": "abc·55", "at": "t2"}
        self.assertNotEqual(v.load_identity(before), v.load_identity(after))


class WaitForNewLoadTest(unittest.TestCase):
    def _run(self, records: list[dict[str, object] | None], deadline: float = 0.2) -> dict[str, object]:
        # The wait narrates what it sees; the test only wants the result.
        with contextlib.redirect_stdout(io.StringIO()), \
                mock.patch.object(v, "read_runtime_record", side_effect=records + [records[-1]] * 50), \
                mock.patch.object(v.time, "sleep", lambda _s: None), \
                mock.patch.object(v.time, "monotonic", side_effect=[0.0] + [i * 0.05 for i in range(1, 60)]):
            return v.wait_for_new_load(v.load_identity(records[0]), deadline)

    def test_it_returns_as_soon_as_a_different_load_is_reported(self) -> None:
        baseline = {"sourceFingerprint": "abc·55", "at": "t1"}
        same = {"sourceFingerprint": "abc·55", "at": "t1"}
        newer = {"sourceFingerprint": "def·56", "at": "t2"}
        record = self._run([baseline, same, same, newer])
        self.assertEqual(record, newer)

    def test_a_machine_that_never_reloads_is_refused_by_name(self) -> None:
        stuck = {"sourceFingerprint": "abc·55", "at": "t1"}
        with self.assertRaises(v.VerificationError) as caught:
            self._run([stuck], deadline=0.05)
        self.assertIn("did not report a new load", str(caught.exception))
        self.assertIn("abc·55", str(caught.exception), "the refusal names what it did see")


if __name__ == "__main__":
    unittest.main()
