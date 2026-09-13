#!/usr/bin/env python3
"""Ask the running host to reload its harness, and verify that it did.

Why this exists: a reload can be requested but silently not happen. pi's TUI
refuses to reload while a session is streaming (`Wait for the current response
to finish before reloading.`), and that warning is only visible in the TUI — an
agent asking for a reload had no way to tell "reloaded" from "refused". This
sends the request over the same authenticated channel the app uses and then
reads the host's own runtime record, so the answer is a fact.

Credentials come from the host's cached owner refresh token; nothing secret is
printed, and no browser profile is touched. Exit code is 0 only when the reload
was observed to take effect.

Usage:
    reload_host.py --status          # what is loaded right now
    reload_host.py --wait-idle       # wait for a non-streaming gap, then reload
    reload_host.py --api-key KEY     # override the (public) Firebase web key
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

AGENT_DIR = Path(os.environ.get("PI_AGENT_DIR", Path.home() / ".pi" / "agent"))
HOST_DIR = AGENT_DIR / "remote-code"
AUTH_PATH = HOST_DIR / "auth.json"
RUNTIME_PATH = Path(os.environ.get("RC_RUNTIME_PATH", HOST_DIR / "runtime.json"))

# Firebase's web API key is a public client identifier (it ships in the built
# web app). It identifies the project, it is not a secret.
DEFAULT_API_KEY = "AIzaSyD1gGGBicszg7el5Qp4wR07cMJucOjBd4I"
TOKEN_URL = "https://securetoken.googleapis.com/v1/token"
AUTH_TIMEOUT_S = 20
VERIFY_TIMEOUT_S = 45


class ReloadError(RuntimeError):
    """A reload that cannot be requested, with the reason stated."""


def read_runtime_record() -> dict[str, Any] | None:
    try:
        return json.loads(RUNTIME_PATH.read_text())
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        raise ReloadError(f"unreadable runtime record at {RUNTIME_PATH}: {error}") from error


def describe_record(record: dict[str, Any] | None) -> str:
    if not record:
        return (
            f"no runtime record at {RUNTIME_PATH} — the process running now has never "
            "recorded a load (its code predates the record, or bootstrapping never ran)"
        )
    fields = [
        f"load={record.get('load')}",
        f"pid={record.get('pid')}",
        f"sources={record.get('sourceFingerprint')}",
        f"factoryEntries={record.get('factoryEntries')}",
        f"at={record.get('at')}",
    ]
    if record.get("reason"):
        fields.append(f"reason={record['reason']!r}")
    if record.get("wsPort"):
        fields.append(f"wsPort={record['wsPort']}")
    return " ".join(fields)


def owner_id_token(api_key: str) -> tuple[str, str]:
    """Exchange the host's cached refresh token for an ID token."""
    try:
        cached = json.loads(AUTH_PATH.read_text())
    except FileNotFoundError as error:
        raise ReloadError(
            f"no cached owner credentials at {AUTH_PATH}; sign in from the app "
            "(or run /pinest-auth in the TUI) before reloading"
        ) from error
    except (OSError, json.JSONDecodeError) as error:
        raise ReloadError(f"unreadable credentials at {AUTH_PATH}: {error}") from error

    refresh_token = cached.get("refreshToken")
    uid = cached.get("uid")
    if not isinstance(refresh_token, str) or not refresh_token:
        raise ReloadError(f"{AUTH_PATH} has no refreshToken; sign in again from the app")

    body = urllib.parse.urlencode(
        {"grant_type": "refresh_token", "refresh_token": refresh_token}
    ).encode()
    request = urllib.request.Request(
        f"{TOKEN_URL}?key={api_key}",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=AUTH_TIMEOUT_S) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:200]
        raise ReloadError(f"Firebase refused the refresh token (HTTP {error.code}): {detail}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise ReloadError(f"cannot reach Firebase to refresh the owner token: {error}") from error

    token = payload.get("id_token")
    if not token:
        raise ReloadError("Firebase returned no id_token for the refreshed credentials")
    return token, (uid if isinstance(uid, str) else "")


def candidate_ws_ports() -> list[int]:
    """Loopback ports owned by a `pi` process — the host's control channel."""
    try:
        listing = subprocess.run(
            ["ss", "-ltnpH"], capture_output=True, text=True, check=True, timeout=10
        ).stdout
    except (OSError, subprocess.SubprocessError) as error:
        raise ReloadError(f"cannot list listening sockets to find the host: {error}") from error

    ports: list[int] = []
    for line in listing.splitlines():
        if '"pi"' not in line or "127.0.0.1:" not in line:
            continue
        match = re.search(r"127\.0\.0\.1:(\d+)", line)
        if match:
            ports.append(int(match.group(1)))
    return sorted(set(ports))


class WebSocketError(RuntimeError):
    """A handshake or frame-level failure on the control channel."""


class WebSocket:
    """The smallest WebSocket client that can talk to this host.

    The control channel is a real WebSocket server: a plain socket gets a 400
    and no frames, which is exactly what the first version of this tool hit.
    Implemented here rather than pulled in as a dependency because it is ~50
    lines of framing and the tool must run with no environment set up.
    """

    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, port: int, timeout: float) -> None:
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (
                f"GET / HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{port}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        headers = b""
        while b"\r\n\r\n" not in headers:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WebSocketError(f"handshake closed early on port {port}")
            headers += chunk
        status = headers.split(b"\r\n", 1)[0].decode(errors="replace")
        if "101" not in status:
            raise WebSocketError(f"handshake rejected on port {port}: {status}")
        expected = base64.b64encode(
            hashlib.sha1((key + self.GUID).encode()).digest()
        ).decode()
        if expected.encode() not in headers:
            raise WebSocketError(f"handshake accept key mismatch on port {port}")

    def send_text(self, text: str) -> None:
        payload = text.encode()
        mask = os.urandom(4)
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(length.to_bytes(2, "big"))
        else:
            header.append(0x80 | 127)
            header.extend(length.to_bytes(8, "big"))
        header.extend(mask)
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _read_exactly(self, count: int) -> bytes:
        data = b""
        while len(data) < count:
            chunk = self.sock.recv(count - len(data))
            if not chunk:
                raise WebSocketError("closed mid-frame")
            data += chunk
        return data

    def recv_text(self, deadline: float) -> str | None:
        """Next text frame, or None when the peer closed."""
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            self.sock.settimeout(remaining)
            try:
                first, second = self._read_exactly(2)
            except (socket.timeout, WebSocketError):
                return None
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = int.from_bytes(self._read_exactly(2), "big")
            elif length == 127:
                length = int.from_bytes(self._read_exactly(8), "big")
            mask = self._read_exactly(4) if masked else b""
            payload = self._read_exactly(length) if length else b""
            if masked:
                payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
            if opcode == 0x8:  # close
                return None
            if opcode in (0x9, 0xA):  # ping/pong
                continue
            if opcode in (0x1, 0x2, 0x0):
                return payload.decode(errors="replace")

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def recv_json(ws: WebSocket, deadline: float) -> dict[str, Any] | None:
    while time.time() < deadline:
        text = ws.recv_text(deadline)
        if text is None:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            continue
    return None


def request_reload(token: str, ports: list[int]) -> int:
    """Connect, authenticate, and ask for a reload. Returns the port used."""
    failures: list[str] = []
    for port in ports:
        ws: WebSocket | None = None
        try:
            ws = WebSocket(port, AUTH_TIMEOUT_S)
            # Firebase verification is a network round trip: wait the full deadline.
            ws.send_text(json.dumps({"type": "auth", "token": token}))
            reply = recv_json(ws, time.time() + AUTH_TIMEOUT_S)
            if reply is None:
                failures.append(f"{port}: closed without answering authentication")
                continue
            if reply.get("type") != "authed":
                failures.append(f"{port}: authentication refused ({reply.get('message', reply.get('type'))})")
                continue
            ws.send_text('{"type":"reload"}')
            # The host reloads (and drops this socket) or refuses; either way the
            # recorded load below is what decides.
            recv_json(ws, time.time() + 3)
            return port
        except (OSError, WebSocketError) as error:
            failures.append(f"{port}: {error}")
        finally:
            if ws is not None:
                ws.close()
    raise ReloadError("no host control channel accepted the request — " + "; ".join(failures))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--status", action="store_true", help="report the loaded build and exit")
    parser.add_argument("--api-key", default=os.environ.get("PINEST_FIREBASE_API_KEY", DEFAULT_API_KEY))
    parser.add_argument("--verify-timeout", type=float, default=VERIFY_TIMEOUT_S)
    parser.add_argument(
        "--delay",
        type=float,
        default=0.0,
        help="seconds to wait before requesting: a reload is refused while a response "
        "is streaming, so a request made from inside a turn must outlive that turn",
    )
    args = parser.parse_args()

    before = read_runtime_record()
    print(f"before: {describe_record(before)}")
    if args.status:
        return 0

    if args.delay > 0:
        print(f"waiting {args.delay:g}s so the requesting turn has finished…", flush=True)
        time.sleep(args.delay)
        before = read_runtime_record()
        print(f"before: {describe_record(before)}")

    token, uid = owner_id_token(args.api_key)
    ports = candidate_ws_ports()
    if not ports:
        raise ReloadError("no `pi` process is listening on loopback; start the host first")
    print(f"asking the host on port(s) {ports} to reload (owner uid {uid[:6]}…)")
    used = request_reload(token, ports)

    deadline = time.time() + args.verify_timeout
    while time.time() < deadline:
        time.sleep(1.5)
        now = read_runtime_record()
        if now is None:
            continue
        changed = (
            now.get("at") != (before or {}).get("at")
            or now.get("factoryEntries", 0) > (before or {}).get("factoryEntries", 0)
        )
        if changed and now.get("load") == "ok":
            print(f"reloaded via {used}: {describe_record(now)}")
            print(f"status: OK — the harness re-initialized on {now.get('sourceFingerprint')}")
            return 0
        if changed and now.get("load") == "failed":
            print(f"reloaded via {used} but bootstrap FAILED: {describe_record(now)}")
            return 2

    after = read_runtime_record()
    print(f"after: {describe_record(after)}")
    print(
        "status: NOT RELOADED — the request was accepted but no new load was recorded. "
        "pi's TUI refuses to reload while the session is streaming, which is the usual cause."
    )
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ReloadError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(3)
