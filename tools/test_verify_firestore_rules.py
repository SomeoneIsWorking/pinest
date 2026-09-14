#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest

import verify_firestore_rules


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRATCH_ROOT = REPOSITORY_ROOT / "scratch"


class FirestoreRulesVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        SCRATCH_ROOT.mkdir(exist_ok=True)
        self.temporary_directory = tempfile.TemporaryDirectory(
            prefix="firestore-verifier-test-", dir=SCRATCH_ROOT
        )
        self.root = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def write_cache(self, mode: int = 0o600) -> Path:
        path = self.root / "auth.json"
        path.write_text(
            json.dumps({"uid": "owner", "refreshToken": "secret"}),
            encoding="utf-8",
        )
        os.chmod(path, mode)
        return path

    def test_private_regular_cache_is_accepted(self) -> None:
        cache = verify_firestore_rules.read_private_auth_cache(self.write_cache())

        self.assertEqual(cache["uid"], "owner")
        self.assertEqual(cache["refreshToken"], "secret")

    def test_group_readable_cache_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            verify_firestore_rules.VerificationError, "expected mode 0600"
        ):
            verify_firestore_rules.read_private_auth_cache(self.write_cache(0o640))

    def test_symlink_cache_is_rejected(self) -> None:
        target = self.write_cache()
        link = self.root / "linked-auth.json"
        link.symlink_to(target)

        with self.assertRaisesRegex(
            verify_firestore_rules.VerificationError, "not a regular file"
        ):
            verify_firestore_rules.read_private_auth_cache(link)

    def test_missing_refresh_token_is_rejected(self) -> None:
        path = self.root / "auth.json"
        path.write_text(json.dumps({"uid": "owner"}), encoding="utf-8")
        os.chmod(path, 0o600)

        with self.assertRaisesRegex(
            verify_firestore_rules.VerificationError, "no refresh token"
        ):
            verify_firestore_rules.read_private_auth_cache(path)

    def test_an_update_mask_is_sent_so_a_merge_is_what_gets_checked(self) -> None:
        # A PATCH with no mask replaces the document, and the presence rule then
        # fails for a reason the app would never hit. The mask is what makes the
        # check exercise the write the app actually performs.
        seen: dict[str, str] = {}

        class FakeResponse:
            status = 200

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *_exc: object) -> None:
                return None

        def fake_open(request: object, timeout: int | None = None) -> FakeResponse:
            seen["url"] = request.full_url  # type: ignore[attr-defined]
            return FakeResponse()

        status = verify_firestore_rules.request_status(
            "https://example.invalid/users/owner",
            "token",
            method="PATCH",
            body=b"{}",
            update_mask=["p2pAnswer", "p2pAnswerTs"],
            open_request=fake_open,
        )

        self.assertEqual(status, 200)
        self.assertIn("updateMask.fieldPaths=p2pAnswer", seen["url"])
        self.assertIn("updateMask.fieldPaths=p2pAnswerTs", seen["url"])

    def test_without_a_mask_the_url_is_untouched(self) -> None:
        seen: dict[str, str] = {}

        class FakeResponse:
            status = 403

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *_exc: object) -> None:
                return None

        def fake_open(request: object, timeout: int | None = None) -> FakeResponse:
            seen["url"] = request.full_url  # type: ignore[attr-defined]
            return FakeResponse()

        verify_firestore_rules.request_status(
            "https://example.invalid/users/owner",
            "token",
            open_request=fake_open,
        )
        self.assertNotIn("updateMask", seen["url"])


if __name__ == "__main__":
    unittest.main()
