#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path
import unittest

from verify_apk import (
    EXPECTED_CERT_SHA256,
    EXPECTED_PACKAGE,
    PROVENANCE_SCHEMA_VERSION,
    WORKFLOW_PATH,
    VerificationError,
    build_provenance,
    extract_signer_fingerprint,
    load_release_identity,
    normalize_fingerprint,
    validate_provenance,
)


class SignerFingerprintTests(unittest.TestCase):
    def test_expected_fingerprint_parser_is_strict(self) -> None:
        contiguous = "83" * 32
        colon_separated = ":".join(["83"] * 32)
        self.assertEqual(normalize_fingerprint(contiguous), contiguous)
        self.assertEqual(normalize_fingerprint(colon_separated), contiguous)

        malformed = (
            "Z".join(contiguous),
            contiguous[:-1],
            contiguous + "0",
            ":".join(["83"] * 31),
            f" {contiguous}",
        )
        for value in malformed:
            with self.subTest(value=value):
                with self.assertRaises(VerificationError):
                    normalize_fingerprint(value)

    def test_reads_contiguous_apksigner_digest(self) -> None:
        output = (
            "Signer #1 certificate DN: CN=PiNest\n"
            "Signer #1 certificate SHA-256 digest: "
            f"{EXPECTED_CERT_SHA256}\n"
        )

        self.assertEqual(
            extract_signer_fingerprint(output),
            EXPECTED_CERT_SHA256,
        )

    def test_reads_colon_separated_uppercase_digest(self) -> None:
        output = (
            "Signer #1 certificate SHA-256 digest: "
            f"{':'.join(EXPECTED_CERT_SHA256[index:index + 2] for index in range(0, 64, 2))}\n"
        )

        self.assertEqual(
            extract_signer_fingerprint(output),
            EXPECTED_CERT_SHA256,
        )

    def test_refuses_missing_or_malformed_digest(self) -> None:
        malformed = (
            "",
            "Signer #1 certificate SHA-256 digest: 1234\n",
            "Signer #1 certificate SHA-256 digest: " + "a" * 63 + "\n",
            "Signer #1 certificate SHA-256 digest: " + "a" * 65 + "\n",
            "Signer #1 certificate SHA-256 digest: " + "Z".join("a" * 64) + "\n",
        )
        for output in malformed:
            with self.subTest(output=output):
                with self.assertRaises(VerificationError):
                    extract_signer_fingerprint(output)

    def test_refuses_multiple_signers_even_when_first_matches(self) -> None:
        output = (
            "Signer #1 certificate SHA-256 digest: " + "a" * 64 + "\n"
            "Signer #2 certificate SHA-256 digest: " + "b" * 64 + "\n"
        )

        with self.assertRaisesRegex(VerificationError, "exactly one"):
            extract_signer_fingerprint(output)

    def test_refuses_valid_signer_followed_by_malformed_signer(self) -> None:
        output = (
            "Signer #1 certificate SHA-256 digest: " + "a" * 64 + "\n"
            "Signer #2 certificate SHA-256 digest: 1234\n"
        )

        with self.assertRaisesRegex(VerificationError, "exactly one"):
            extract_signer_fingerprint(output)


class ProvenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = {
            "repository": "SomeoneIsWorking/pinest",
            "commit": "a" * 40,
            "ref": "refs/heads/main",
            "run_id": "1234",
            "run_attempt": "1",
        }
        self.provenance = build_provenance(
            apk=Path("pinest.apk"),
            package=EXPECTED_PACKAGE,
            signer_sha256="83" * 32,
            sha256="b" * 64,
            source=self.source,
        )

    def test_builds_canonical_release_provenance(self) -> None:
        self.assertEqual(self.provenance["schema_version"], PROVENANCE_SCHEMA_VERSION)
        self.assertEqual(self.provenance["workflow"], WORKFLOW_PATH)
        self.assertEqual(
            self.provenance["artifact"],
            {
                "filename": "pinest.apk",
                "package": EXPECTED_PACKAGE,
                "sha256": "b" * 64,
                "signer_sha256": "83" * 32,
            },
        )
        self.assertEqual(self.provenance["source"], self.source)

    def test_accepts_only_exact_provenance(self) -> None:
        validate_provenance(self.provenance, self.provenance)

        tampered = {
            **self.provenance,
            "artifact": {**self.provenance["artifact"], "sha256": "c" * 64},
        }
        with self.assertRaisesRegex(VerificationError, "provenance mismatch"):
            validate_provenance(tampered, self.provenance)


class ReleaseIdentityTests(unittest.TestCase):
    def test_checked_in_identity_is_the_verifier_default(self) -> None:
        self.assertEqual(load_release_identity(), (EXPECTED_PACKAGE, EXPECTED_CERT_SHA256))


if __name__ == "__main__":
    unittest.main()
