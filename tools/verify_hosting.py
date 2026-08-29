#!/usr/bin/env python3
"""Verify the canonical PiNest Hosting site and legacy redirect."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen


CANONICAL_URL = "https://pinest.web.app"
LEGACY_URL = "https://pinest-app.web.app"


class VerificationError(RuntimeError):
    """The deployed Hosting state does not match the intended release."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def fetch(url: str) -> bytes:
    request = Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "pinest-verifier"})
    with urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise VerificationError(f"{url} returned HTTP {response.status}")
        return response.read()


def verify_redirect(path: str) -> None:
    url = f"{LEGACY_URL}{path}"
    try:
        build_opener(_NoRedirect).open(
            Request(url, headers={"User-Agent": "pinest-verifier"}),
            timeout=30,
        )
    except HTTPError as error:
        if error.code != 301:
            raise VerificationError(f"{url} returned HTTP {error.code}, expected 301") from error
        expected = f"{CANONICAL_URL}{path}"
        actual = error.headers.get("Location")
        if actual != expected:
            raise VerificationError(f"legacy redirect mismatch: expected {expected}, found {actual}")
        return
    raise VerificationError(f"{url} did not redirect")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bundle",
        type=Path,
        default=Path("app/build/web/main.dart.js"),
        help="local release bundle that must match the deployed bundle",
    )
    parser.add_argument("--expected-sha256", help="override the expected bundle hash")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.bundle.is_file():
        raise VerificationError(f"local bundle not found: {args.bundle}")

    local_hash = hashlib.sha256(args.bundle.read_bytes()).hexdigest()
    expected_hash = args.expected_sha256 or local_hash
    query = urlencode({"verify": expected_hash})
    deployed = fetch(f"{CANONICAL_URL}/main.dart.js?{query}")
    deployed_hash = hashlib.sha256(deployed).hexdigest()
    if deployed_hash != expected_hash:
        raise VerificationError(
            f"bundle mismatch: expected {expected_hash}, found {deployed_hash}",
        )

    index = fetch(f"{CANONICAL_URL}/?{query}")
    if b"<title>PiNest</title>" not in index:
        raise VerificationError("canonical site did not serve the PiNest index")
    verify_redirect("/")
    verify_redirect("/release-verification")

    print(f"canonical_url={CANONICAL_URL}")
    print(f"bundle_sha256={deployed_hash}")
    print(f"legacy_redirect={LEGACY_URL}/ -> {CANONICAL_URL}/")
    print(f"legacy_redirect={LEGACY_URL}/release-verification -> {CANONICAL_URL}/release-verification")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
