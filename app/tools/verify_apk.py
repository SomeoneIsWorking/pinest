#!/usr/bin/env python3
"""Verify the package and stable signing identity of a PiNest release APK."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any


RELEASE_IDENTITY_PATH = Path(__file__).resolve().parents[1] / "release-identity.json"
PROVENANCE_SCHEMA_VERSION = 1
WORKFLOW_PATH = ".github/workflows/apk.yml"
FINGERPRINT_PATTERN = re.compile(
    r"(?:[0-9a-fA-F]{64}|(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2})",
)


class VerificationError(RuntimeError):
    """The APK does not carry the expected release identity."""


def normalize_fingerprint(value: str) -> str:
    if not FINGERPRINT_PATTERN.fullmatch(value):
        raise VerificationError(
            "SHA-256 fingerprint must be exactly 64 hexadecimal digits or "
            "32 colon-separated bytes",
        )
    return value.replace(":", "").lower()


def load_release_identity(path: Path = RELEASE_IDENTITY_PATH) -> tuple[str, str]:
    try:
        identity = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise VerificationError(f"invalid release identity at {path}: {error}") from error
    if not isinstance(identity, dict) or set(identity) != {"package", "certificate_sha256"}:
        raise VerificationError("release identity must contain exactly package and certificate_sha256")
    package = identity["package"]
    certificate = identity["certificate_sha256"]
    if not isinstance(package, str) or not re.fullmatch(r"[a-z][a-z0-9]*(?:[.][a-z][a-z0-9]*)+", package):
        raise VerificationError(f"invalid Android package in release identity: {package!r}")
    if not isinstance(certificate, str):
        raise VerificationError("release certificate fingerprint must be a string")
    return package, normalize_fingerprint(certificate)


EXPECTED_PACKAGE, EXPECTED_CERT_SHA256 = load_release_identity()


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
    signer_lines = [
        line
        for line in certificates.splitlines()
        if re.match(r"Signer #\d+ certificate SHA-256 digest:", line, re.IGNORECASE)
    ]
    if len(signer_lines) != 1:
        raise VerificationError(
            "apksigner must report exactly one APK signer SHA-256 fingerprint; "
            f"found {len(signer_lines)} in {certificates!r}",
        )

    match = re.fullmatch(
        r"Signer #\d+ certificate SHA-256 digest:\s*"
        rf"({FINGERPRINT_PATTERN.pattern})\s*",
        signer_lines[0],
        re.IGNORECASE,
    )
    if not match:
        raise VerificationError(f"apksigner reported a malformed signer digest: {signer_lines[0]!r}")
    return normalize_fingerprint(match.group(1))


def signer_fingerprint(apk: Path) -> str:
    certificates = run_tool(sdk_tool("apksigner"), "verify", "--print-certs", apk)
    return extract_signer_fingerprint(certificates)


def artifact_sha256(artifact: Path) -> str:
    digest = hashlib.sha256()
    with artifact.open("rb") as input_file:
        for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_provenance(args: argparse.Namespace) -> dict[str, str]:
    values = {
        "repository": args.source_repository,
        "commit": args.source_commit,
        "ref": args.source_ref,
        "run_id": args.run_id,
        "run_attempt": args.run_attempt,
    }
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise VerificationError(
            "provenance requires " + ", ".join(f"--{name.replace('_', '-')}" for name in missing),
        )
    return values


def build_provenance(
    apk: Path,
    package: str,
    signer_sha256: str,
    sha256: str,
    source: dict[str, str],
) -> dict[str, Any]:
    return {
        "schema_version": PROVENANCE_SCHEMA_VERSION,
        "artifact": {
            "filename": apk.name,
            "sha256": sha256,
            "package": package,
            "signer_sha256": normalize_fingerprint(signer_sha256),
        },
        "source": source,
        "workflow": WORKFLOW_PATH,
    }


def validate_provenance(
    provenance: object,
    expected: dict[str, Any],
) -> None:
    if not isinstance(provenance, dict):
        raise VerificationError("provenance root must be a JSON object")

    for field in ("schema_version", "artifact", "source", "workflow"):
        if field not in provenance:
            raise VerificationError(f"provenance is missing {field!r}")

    if provenance != expected:
        raise VerificationError(
            "provenance mismatch:\n"
            f"expected {json.dumps(expected, sort_keys=True)}\n"
            f"found {json.dumps(provenance, sort_keys=True)}",
        )


def load_provenance(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise VerificationError(f"provenance not found: {path}") from error
    except json.JSONDecodeError as error:
        raise VerificationError(f"invalid provenance JSON in {path}: {error}") from error


def write_provenance(path: Path, provenance: dict[str, Any]) -> None:
    path.write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--expected-package", default=EXPECTED_PACKAGE)
    parser.add_argument("--expected-cert-sha256", default=EXPECTED_CERT_SHA256)
    provenance = parser.add_mutually_exclusive_group()
    provenance.add_argument("--write-provenance", type=Path)
    provenance.add_argument("--provenance", type=Path)
    parser.add_argument("--source-repository")
    parser.add_argument("--source-commit")
    parser.add_argument("--source-ref")
    parser.add_argument("--run-id")
    parser.add_argument("--run-attempt")
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

    sha256 = artifact_sha256(args.apk)
    source = source_provenance(args) if args.write_provenance or args.provenance else None
    expected_provenance = build_provenance(
        args.apk,
        actual_package,
        actual_fingerprint,
        sha256,
        source or {},
    )

    if args.write_provenance:
        write_provenance(args.write_provenance, expected_provenance)
    elif args.provenance:
        validate_provenance(load_provenance(args.provenance), expected_provenance)

    print(f"package={actual_package}")
    print(f"signer_sha256={actual_fingerprint.upper()}")
    print(f"artifact_sha256={sha256}")
    if args.write_provenance:
        print(f"provenance_written={args.write_provenance}")
    elif args.provenance:
        print(f"provenance_verified={args.provenance}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
