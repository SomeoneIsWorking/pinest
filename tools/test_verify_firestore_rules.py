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


if __name__ == "__main__":
    unittest.main()
