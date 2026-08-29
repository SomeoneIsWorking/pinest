#!/usr/bin/env python3

from __future__ import annotations

import unittest

from verify_apk import VerificationError, extract_signer_fingerprint


class SignerFingerprintTests(unittest.TestCase):
    def test_reads_contiguous_apksigner_digest(self) -> None:
        output = (
            "Signer #1 certificate DN: CN=PiNest\n"
            "Signer #1 certificate SHA-256 digest: "
            "83986d1859de4ce0979ae43c9e184036e49bde3cbca37ef2c8efa93fd751a3f5\n"
        )

        self.assertEqual(
            extract_signer_fingerprint(output),
            "83986d1859de4ce0979ae43c9e184036e49bde3cbca37ef2c8efa93fd751a3f5",
        )

    def test_reads_colon_separated_uppercase_digest(self) -> None:
        output = (
            "Signer #1 certificate SHA-256 digest: "
            "83:98:6D:18:59:DE:4C:E0:97:9A:E4:3C:9E:18:40:36:"
            "E4:9B:DE:3C:BC:A3:7E:F2:C8:EF:A9:3F:D7:51:A3:F5\n"
        )

        self.assertEqual(
            extract_signer_fingerprint(output),
            "83986d1859de4ce0979ae43c9e184036e49bde3cbca37ef2c8efa93fd751a3f5",
        )

    def test_refuses_missing_or_malformed_digest(self) -> None:
        for output in ("", "Signer #1 certificate SHA-256 digest: 1234\n"):
            with self.subTest(output=output):
                with self.assertRaises(VerificationError):
                    extract_signer_fingerprint(output)


if __name__ == "__main__":
    unittest.main()
