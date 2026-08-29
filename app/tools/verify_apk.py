#!/usr/bin/env python3
"""Verify the package and stable signing identity of a PiNest release APK."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys


EXPECTED_PACKAGE = "com.barishamil.pinest"
EXPECTED_CERT_SHA256 = (
    "83:98:6D:18:59:DE:4C:E0:97:9A:E4:3C:9E:18:40:36:"
    "E4:9B:DE:3C:BC:A3:7E:F2:C8:EF:A9:3F:D7:51:A3:F5"
)


class VerificationError(RuntimeError):
    """The APK does not carry the expected release identity."""


def normalize_fingerprint(value: str) -> str:
    return re.sub(r"[^0-9a-f]", "", value.lower())


def sdk_tool(name: str) -> Path:
    sdk_root = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk_root:
        raise VerificationError("ANDROID_HOME or ANDROID_SDK_ROOT must name the Android SDK")

    candidates = sorted(
        Path(sdk_root).glob(f"build-tools/*/{name}"),
        key=lambda path: tuple(int(part) for part in re.findall(r"\d+", path.parent.name)),
        reverse=True,
    )
    if not candidates:
        raise VerificationError(f"Android SDK tool not found: {name}")
    return candidates[0]


def run_tool(*command: str | Path) -> str:
    completed = subprocess.run(
        [str(part) for part in command],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise VerificationError(f"{Path(str(command[0])).name} failed: {detail}")
    return completed.stdout


def apk_package(apk: Path) -> str:
    badging = run_tool(sdk_tool("aapt"), "dump", "badging", apk)
    match = re.search(r"^package: name='([^']+)'", badging, re.MULTILINE)
    if not match:
        raise VerificationError("aapt did not report an APK package name")
    return match.group(1)


def extract_signer_fingerprint(certificates: str) -> str:
    for line in certificates.splitlines():
        match = re.search(r"certificate SHA-256 digest:\s*(.+)", line, re.IGNORECASE)
        if not match:
            continue
        fingerprint = normalize_fingerprint(match.group(1))
        if len(fingerprint) == 64:
            return fingerprint
    raise VerificationError(
        "apksigner did not report a recognizable signer SHA-256 fingerprint; "
        f"output was {certificates!r}",
    )


def signer_fingerprint(apk: Path) -> str:
    certificates = run_tool(sdk_tool("apksigner"), "verify", "--print-certs", apk)
    return extract_signer_fingerprint(certificates)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--expected-package", default=EXPECTED_PACKAGE)
    parser.add_argument("--expected-cert-sha256", default=EXPECTED_CERT_SHA256)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.apk.is_file():
        raise VerificationError(f"APK not found: {args.apk}")

    actual_package = apk_package(args.apk)
    if actual_package != args.expected_package:
        raise VerificationError(
            f"package mismatch: expected {args.expected_package}, found {actual_package}",
        )

    actual_fingerprint = signer_fingerprint(args.apk)
    if normalize_fingerprint(actual_fingerprint) != normalize_fingerprint(
        args.expected_cert_sha256,
    ):
        raise VerificationError(
            "signer mismatch: expected "
            f"{args.expected_cert_sha256}, found {actual_fingerprint}",
        )

    artifact_sha256 = hashlib.sha256(args.apk.read_bytes()).hexdigest()
    print(f"package={actual_package}")
    print(f"signer_sha256={actual_fingerprint.upper()}")
    print(f"artifact_sha256={artifact_sha256}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
