#!/usr/bin/env python3
"""Verify the deployed Firestore discovery boundary in both directions."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import stat
import sys
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_INIT_URL = "https://pinest.web.app/__/firebase/init.json"
DEFAULT_AUTH_CACHE = Path.home() / ".pi" / "agent" / "remote-code" / "auth.json"
NEGATIVE_UID = "pinest-live-negative-control"


class VerificationError(RuntimeError):
    """The live rules boundary does not match the intended policy."""


def read_private_auth_cache(path: Path) -> dict[str, Any]:
    file_stat = path.lstat()
    if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode):
        raise VerificationError(f"auth cache is not a regular file: {path}")
    if file_stat.st_mode & 0o077:
        raise VerificationError(f"auth cache is not private (expected mode 0600): {path}")
    try:
        cache = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise VerificationError(f"cannot read auth cache: {path}") from error
    if not isinstance(cache, dict) or not isinstance(cache.get("refreshToken"), str):
        raise VerificationError(f"auth cache has no refresh token: {path}")
    return cache


def fetch_json(request: Request | str) -> dict[str, Any]:
    with urlopen(request, timeout=30) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise VerificationError("Firebase returned a non-object JSON response")
    return value


def refresh_identity(config: dict[str, Any], cache: dict[str, Any]) -> tuple[str, str]:
    api_key = config.get("apiKey")
    if not isinstance(api_key, str) or not api_key:
        raise VerificationError("deployed Firebase config has no API key")
    request = Request(
        f"https://securetoken.googleapis.com/v1/token?key={api_key}",
        data=urlencode(
            {
                "grant_type": "refresh_token",
                "refresh_token": cache["refreshToken"],
            }
        ).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    refreshed = fetch_json(request)
    token = refreshed.get("id_token")
    uid = refreshed.get("user_id")
    if not isinstance(token, str) or not isinstance(uid, str) or not token or not uid:
        raise VerificationError("Firebase refresh response has no token identity")
    cached_uid = cache.get("uid")
    if cached_uid is not None and cached_uid != uid:
        raise VerificationError("refreshed token UID does not match the auth cache UID")
    return token, uid


def request_status(
    url: str,
    token: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    open_request: Callable[..., Any] = urlopen,
) -> int:
    request = Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with open_request(request, timeout=30) as response:
            return response.status
    except HTTPError as error:
        error.read()
        return error.code


def verify_boundary(project_id: str, token: str, uid: str) -> dict[str, int]:
    if uid == NEGATIVE_UID:
        raise VerificationError("negative-control UID unexpectedly equals the owner UID")
    base = (
        f"https://firestore.googleapis.com/v1/projects/{project_id}"
        "/databases/(default)/documents"
    )
    checks = {
        "own_document_get": request_status(f"{base}/users/{uid}", token),
        "foreign_document_get": request_status(f"{base}/users/{NEGATIVE_UID}", token),
        "collection_list": request_status(f"{base}/users?pageSize=1", token),
        "invalid_own_write": request_status(
            f"{base}/users/{uid}",
            token,
            method="PATCH",
            body=json.dumps(
                {"fields": {"online": {"booleanValue": True}}}
            ).encode(),
        ),
    }
    expected = {
        "own_document_get": 200,
        "foreign_document_get": 403,
        "collection_list": 403,
        "invalid_own_write": 403,
    }
    for name, actual in checks.items():
        if actual != expected[name]:
            raise VerificationError(
                f"{name}: HTTP {actual}, expected HTTP {expected[name]}"
            )
    return checks


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--auth-cache",
        type=Path,
        default=Path(os.environ.get("RC_AUTH_PATH", DEFAULT_AUTH_CACHE)),
    )
    parser.add_argument("--init-url", default=DEFAULT_INIT_URL)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cache = read_private_auth_cache(args.auth_cache)
    config = fetch_json(args.init_url)
    project_id = config.get("projectId")
    if not isinstance(project_id, str) or not project_id:
        raise VerificationError("deployed Firebase config has no project ID")
    token, uid = refresh_identity(config, cache)
    for name, status_code in verify_boundary(project_id, token, uid).items():
        print(f"{name}=HTTP {status_code}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, VerificationError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
