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
import select
import socket
import subprocess
import sys
import threading
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
FRAME_READ_TIMEOUT_S = 30.0
ASK_READ_WINDOW_S = 1.5
AUTH_TIMEOUT_S = 20
VERIFY_TIMEOUT_S = 6


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


class WebSocketClosed(WebSocketError):
    """The peer closed the connection, as opposed to nothing having arrived."""


class WebSocket:
    """The smallest WebSocket client that can talk to this host.

    The control channel is a real WebSocket server: a plain socket gets a 400
    and no frames, which is exactly what the first version of this tool hit.
    Implemented here rather than pulled in as a dependency because it is ~50
    lines of framing and the tool must run with no environment set up.
    """

    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, port: int, timeout: float) -> None:
        self._closed = False
        self.close_code: int | None = None
        self.close_reason = ""
        self.frames_seen: list[str] = []
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
                raise WebSocketClosed("the peer closed the connection")
            data += chunk
        return data

    @property
    def closed(self) -> bool:
        return self._closed

    def _send_frame(self, opcode: int, payload: bytes = b"") -> None:
        mask = os.urandom(4)
        header = bytearray([0x80 | opcode])
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

    def _wait_readable(self, wait: float) -> bool:
        if wait <= 0:
            return False
        try:
            readable, _, _ = select.select([self.sock], [], [], wait)
        except (OSError, ValueError):
            return False
        return bool(readable)

    def recv_text(self, wait: float) -> str | None:
        """The next text frame, or None if none arrived within `wait` seconds.

        A frame is always read to completion. Abandoning a partial frame on a
        short timeout desynchronises the stream, after which every later header
        is garbage — which is how an earlier version of this tool invented
        "the host closed the socket" and stale session statuses.
        """
        deadline = time.time() + wait
        while True:
            if not self._wait_readable(deadline - time.time()):
                return None
            # Data has arrived: read the whole frame without a short deadline.
            self.sock.settimeout(FRAME_READ_TIMEOUT_S)
            try:
                first, second = self._read_exactly(2)
                opcode = first & 0x0F
                masked = bool(second & 0x80)
                length = second & 0x7F
                if length == 126:
                    length = int.from_bytes(self._read_exactly(2), "big")
                elif length == 127:
                    length = int.from_bytes(self._read_exactly(8), "big")
                mask = self._read_exactly(4) if masked else b""
                payload = self._read_exactly(length) if length else b""
            except WebSocketClosed:
                self._closed = True
                self.close_reason = self.close_reason or "connection ended without a close frame"
                return None
            except socket.timeout as error:
                raise WebSocketError(f"frame truncated mid-read: {error}") from error
            if masked:
                payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
            if opcode == 0x8:  # close
                self._closed = True
                if len(payload) >= 2:
                    self.close_code = int.from_bytes(payload[:2], "big")
                    self.close_reason = payload[2:].decode(errors="replace")
                return None
            if opcode == 0x9:  # ping — the host expects a pong
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode in (0x1, 0x2, 0x0):
                text = payload.decode(errors="replace")
                self.frames_seen.append(describe_frame(text))
                return text

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def recv_json(ws: WebSocket, wait: float) -> dict[str, Any] | None:
    """The next frame that parses as a JSON object, within `wait` seconds."""
    deadline = time.time() + wait
    while time.time() < deadline:
        text = ws.recv_text(max(0.05, deadline - time.time()))
        if text is None:
            if ws.closed:
                return None
            continue
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            continue
    return None


def format_close(ws: "WebSocket") -> str:
    """The close code AND the reason: the reason is the string that names the
    rule the host refused us under, so dropping it drops the diagnosis."""
    code = f"code {ws.close_code}" if ws.close_code else "no close code"
    reason = f": {ws.close_reason!r}" if ws.close_reason else " (no reason given)"
    return code + reason


def reload_command() -> dict[str, Any]:
    """The reload request, in the envelope the host's dispatcher accepts.

    The WS server routes only three top-level types — `auth`, `command`, and
    `ping` — and answers anything else with `1008 unknown message type`. The
    reload therefore travels inside `cmd`, exactly as the app sends it. Sending
    a bare `{"type":"reload"}` is rejected by the host, not by the reload guard.
    """
    return {"type": "command", "cmd": {"type": "reload"}}


def describe_frame(text: str) -> str:
    """A frame's type, for reporting what the host actually said back."""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return "unparseable"
    if isinstance(parsed, dict):
        kind = str(parsed.get("type", "?"))
        if kind == "error":
            return f"error: {parsed.get('message', '')}"
        return kind
    return "unparseable"


def host_status_from_state(state: dict[str, Any]) -> str:
    """The TUI session's own status, from a state frame.

    The reload is refused while that session is streaming, so "what did the host
    think it was doing when we asked" is the whole diagnosis.
    """
    sessions = state.get("sessions")
    if not isinstance(sessions, list):
        return "unknown"
    for row in sessions:
        if isinstance(row, dict) and row.get("isHost"):
            return str(row.get("status", "unknown"))
    return "no host row"


def ask_repeatedly(token: str, port: int, deadline: float, interval: float) -> None:
    """Hold a connection open and re-ask until the deadline.

    Asking a handful of times and stopping lands every attempt inside the turn
    that launched this tool — precisely when the reload is refused. A refusal is
    instant and silent, so the only thing that works is asking continuously
    until one lands in an idle moment. Every reply and every close is reported,
    so "nothing happened" is never confused with "nobody answered".
    """
    attempts = 0
    while time.time() < deadline:
        ws: WebSocket | None = None
        try:
            ws = WebSocket(port, AUTH_TIMEOUT_S)
            ws.send_text(json.dumps({"type": "auth", "token": token}))
            reply = recv_json(ws, AUTH_TIMEOUT_S)
            if reply is None or reply.get("type") != "authed":
                print(f"authentication failed: {reply}", flush=True)
                time.sleep(2)
                continue
            status = "unknown"
            status_at = 0.0
            while time.time() < deadline:
                attempts += 1
                try:
                    ws.send_text(json.dumps(reload_command()))
                except OSError as error:
                    print(f"ask {attempts}: socket write failed ({error}); reconnecting", flush=True)
                    break
                # The host answers a reload only by acting on it: read whatever
                # it does send (state frames, errors) before asking again.
                frame = ws.recv_text(ASK_READ_WINDOW_S)
                while frame is not None:
                    kind = describe_frame(frame)
                    if kind == "state":
                        try:
                            status = host_status_from_state(json.loads(frame))
                            status_at = time.time()
                        except json.JSONDecodeError:
                            pass
                    elif kind != "state":
                        print(f"ask {attempts}: host replied with {kind}", flush=True)
                    frame = ws.recv_text(ASK_READ_WINDOW_S)
                if ws.closed:
                    detail = format_close(ws)
                    print(f"ask {attempts}: host closed the connection ({detail}); reconnecting", flush=True)
                    break
                if attempts == 1 or attempts % 20 == 0:
                    age = f"{time.time() - status_at:.0f}s ago" if status_at else "never"
                    print(f"ask {attempts}: accepted, no load yet (host said its session was {status}, sampled {age})", flush=True)
                time.sleep(interval)
        except (OSError, WebSocketError) as error:
            print(f"connection error: {error}", flush=True)
            time.sleep(2)
        finally:
            if ws is not None:
                ws.close()


def selftest() -> int:
    """Prove the outbound request matches the host's dispatcher contract.

    The host routes `auth`, `command`, and `ping`; every other top-level type is
    closed with 1008. A reload sent as `{"type":"reload"}` looks like a working
    request from inside this tool and is a protocol error on the wire, so the
    shape itself has to be checked.
    """
    message = reload_command()
    failures: list[str] = []
    if message.get("type") != "command":
        failures.append(f"top-level type must be 'command', got {message.get('type')!r}")
    cmd = message.get("cmd")
    if not isinstance(cmd, dict) or cmd.get("type") != "reload":
        failures.append(f"reload must travel as cmd.type, got {cmd!r}")
    encoded = json.dumps(message)
    if encoded != '{"type": "command", "cmd": {"type": "reload"}}':
        failures.append(f"wire form changed: {encoded}")
    for failure in failures:
        print(f"selftest FAIL: {failure}")
    if failures:
        return 1
    print(f"selftest OK: sends {encoded}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--status", action="store_true", help="report the loaded build and exit")
    parser.add_argument("--selftest", action="store_true", help="check the outbound request shape and exit")
    parser.add_argument(
        "--watch-status",
        type=float,
        default=0.0,
        help="watch the host session's own status for this many seconds. The reload is "
        "refused while that session is streaming, so this measures the condition instead "
        "of inferring it.",
    )
    parser.add_argument("--api-key", default=os.environ.get("PINEST_FIREBASE_API_KEY", DEFAULT_API_KEY))
    parser.add_argument(
        "--verify-timeout",
        type=float,
        default=VERIFY_TIMEOUT_S,
        help="seconds to wait for a load after each request before trying again",
    )
    parser.add_argument(
        "--retry-interval",
        type=float,
        default=3.0,
        help="seconds between attempts. A refusal is instant and silent, so a request is "
        "worth repeating often: the only thing that decides is whether the session happens "
        "to be idle at that instant.",
    )
    parser.add_argument(
        "--deadline",
        type=float,
        default=300.0,
        help="keep re-requesting until a load is observed, for this many seconds. "
        "A reload is refused while a response is streaming, so a single request is a "
        "race against the requesting session; the request is retried instead.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.0,
        help="seconds to wait before the first request, so the requesting turn has ended",
    )
    args = parser.parse_args()

    if args.selftest:
        return selftest()
    before = read_runtime_record()
    print(f"before: {describe_record(before)}", flush=True)
    if args.status:
        return 0
    if args.watch_status > 0:
        token, _uid = owner_id_token(args.api_key)
        ports = candidate_ws_ports()
        ws = WebSocket(ports[0], AUTH_TIMEOUT_S)
        ws.send_text(json.dumps({"type": "auth", "token": token}))
        recv_json(ws, time.time() + AUTH_TIMEOUT_S)
        print("watching the host session status (state frames arrive on every change)", flush=True)
        deadline = time.time() + args.watch_status
        last = None
        while time.time() < deadline:
            frame = ws.recv_text(1.0)
            if not frame:
                continue
            try:
                parsed = json.loads(frame)
            except json.JSONDecodeError:
                continue
            if parsed.get("type") != "state":
                continue
            status = host_status_from_state(parsed)
            if status != last:
                print(f"{time.strftime('%H:%M:%S')} host session status → {status}", flush=True)
                last = status
        ws.close()
        return 0

    if args.delay > 0:
        print(f"waiting {args.delay:g}s so the requesting turn has finished…", flush=True)
        time.sleep(args.delay)

    token, uid = owner_id_token(args.api_key)
    ports = candidate_ws_ports()
    if not ports:
        raise ReloadError("no `pi` process is listening on loopback; start the host first")
    print(f"owner {uid[:6]}… · control channel port(s) {ports}", flush=True)

    deadline = time.time() + args.deadline
    print(f"asking the host to reload until a load is observed (deadline {args.deadline:g}s)", flush=True)
    # Ask in the background while this loop watches the record: a successful
    # reload writes it from the fresh instance, so the record is the signal.
    asker = threading.Thread(
        target=ask_repeatedly, args=(token, ports[0], deadline, args.retry_interval), daemon=True
    )
    asker.start()
    while time.time() < deadline:
        now = read_runtime_record()
        if now is not None:
            changed = (
                now.get("at") != (before or {}).get("at")
                or now.get("factoryEntries", 0) > (before or {}).get("factoryEntries", 0)
            )
            if changed and now.get("load") in ("ok", "pending"):
                if now.get("load") == "pending":
                    continue  # mid-load; wait for the outcome
                print(f"reloaded: {describe_record(now)}", flush=True)
                print(f"status: OK — the harness re-initialized on {now.get('sourceFingerprint')}", flush=True)
                return 0
            if changed and now.get("load") == "failed":
                print(f"reloaded but bootstrap FAILED: {describe_record(now)}", flush=True)
                return 2
        time.sleep(0.5)

    print(f"after the deadline: {describe_record(read_runtime_record())}", flush=True)
    print(
        "status: NOT RELOADED — every request was accepted but no load was recorded. "
        "pi's TUI refuses a reload while a session is streaming, which is the usual cause.",
        flush=True,
    )
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ReloadError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(3)
