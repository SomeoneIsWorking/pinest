#!/usr/bin/env python3

from __future__ import annotations

import json
import unittest

import verify_live_host


class ProbeTableTests(unittest.TestCase):
    def test_every_probe_names_why_it_exists(self) -> None:
        for probe in verify_live_host.probes():
            self.assertTrue(probe.why, f"{probe.name} does not say what it proves")
            self.assertEqual(probe.expect_pattern.strip(), probe.expect_pattern)

    def test_the_frame_builder_matches_the_wire_contract(self) -> None:
        # The same shape the server's commandFromFrame accepts and the app
        # builds: a mismatch here would make this tool agree with nobody.
        self.assertEqual(
            verify_live_host.command_frame({"type": "ping"}),
            {"type": "command", "cmd": {"type": "ping"}},
        )

    def test_a_frame_carrying_a_frame_is_probed(self) -> None:
        # The exact body a phone sent when every send failed: the envelope
        # dispatched as if it were the command.
        doubled = [probe for probe in verify_live_host.probes() if probe.expect_pattern.startswith("unsupported")]
        self.assertEqual(len(doubled), 1, "the old failure has a witness")
        body = doubled[0].body
        self.assertEqual(body["type"], "command")
        self.assertEqual(body["cmd"]["type"], "command")


class EvaluationTests(unittest.TestCase):
    def probe(self) -> verify_live_host.Probe:
        return verify_live_host.Probe(
            name="a case",
            path="/message",
            body=None,
            expect_status=400,
            expect_pattern="expected a command frame",
            why="because the frame is the wire shape",
        )

    def test_a_matching_reply_passes(self) -> None:
        self.assertIsNone(
            verify_live_host.evaluate(self.probe(), 400, '{"error":"expected a command frame"}')
        )

    def test_a_wrong_status_fails_and_says_what_arrived(self) -> None:
        finding = verify_live_host.evaluate(self.probe(), 500, '{"error":"boom"}')
        self.assertIsNotNone(finding)
        self.assertIn("HTTP 500", finding)
        self.assertIn("expected 400", finding)

    def test_a_reason_with_quotes_matches_through_its_escaping(self) -> None:
        # The first live run of this checker failed a correct answer because the
        # server's reason contains quotes and arrives JSON-escaped.
        probe = verify_live_host.Probe(
            name="a doubled frame",
            path="/message",
            body=None,
            expect_status=400,
            expect_pattern='unsupported command type "command"',
            why="the old failure is refused by name",
        )
        raw = json.dumps({"error": 'unsupported command type "command"'})
        self.assertIn('\\"command\\"', raw, "the body really is escaped")
        self.assertIsNone(verify_live_host.evaluate(probe, 400, raw))

    def test_a_detail_beside_the_error_field_still_counts(self) -> None:
        probe = verify_live_host.Probe(
            name="an image request",
            path="/image/x",
            body=None,
            expect_status=404,
            expect_pattern="imageId",
            why="the route names what it could not find",
        )
        body = json.dumps({"error": "unknown image", "imageId": "not-a-real-image"})
        self.assertIsNone(verify_live_host.evaluate(probe, 404, body))

    def test_a_right_status_with_the_wrong_reason_fails(self) -> None:
        # A 400 for a different reason is not the same answer: this is how a
        # refusal passes for the wrong cause and hides the real one.
        finding = verify_live_host.evaluate(self.probe(), 400, '{"error":"sessionId is required over HTTP"}')
        self.assertIsNotNone(finding)
        self.assertIn("does not name", finding)

    def test_an_unreachable_origin_is_a_finding_not_a_pass(self) -> None:
        findings = verify_live_host.verify(
            "http://127.0.0.1:1",
            "key",
            lambda probe: (_ for _ in ()).throw(verify_live_host.ProbeUnreachable("no route")),
            "loopback",
        )
        self.assertEqual(len(findings), len(verify_live_host.probes()))
        self.assertTrue(all("unreachable" in finding for finding in findings))


if __name__ == "__main__":
    unittest.main()
