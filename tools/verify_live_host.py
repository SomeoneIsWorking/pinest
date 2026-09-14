#!/usr/bin/env python3
"""Verify the RUNNING machine answers the app's own HTTP path.

Unit tests prove the routes agree with each other; only the live process proves
the app's real requests work over its real origin. This asks the host for its
access key, then sends the requests a phone sends - the same command frames -
both over loopback and, when a tunnel is published, through the public name with
public DNS, because this host's own resolver cannot see it.

Failure here is the failure a phone sees, so it names the case, the status, and
the body: "the send worked in a test and not on the phone" is the bug this
exists to catch.
"""

from __future__ import annotations

import argparse
import http.client
import json
from pathlib import Path
import socket
import ssl
import sys
import time
from dataclasses import dataclass
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))

import reload_host  # noqa: E402  (sibling tool: discovery and the control channel)


PUBLIC_RESOLVERS = ("1.1.1.1", "8.8.8.8")
REQUEST_TIMEOUT_SECONDS = 15


@dataclass(frozen=True)
class Probe:
    """One request the app makes, and what a working machine answers."""

    name: str
    path: str
    body: dict[str, object] | None
    expect_status: int
    expect_pattern: str
    why: str


def command_frame(command: dict[str, object]) -> dict[str, object]:
    """The frame every transport carries, exactly as the app builds it."""
    return {"type": "command", "cmd": command}


def probes() -> list[Probe]:
    return [
        Probe(
            name="an image request reaches the route",
            path="/image/not-a-real-image",
            body=None,
            expect_status=404,
            expect_pattern="imageId",
            why="the route and the access key work at all",
        ),
        Probe(
            name="a bare command is refused as not-a-frame",
            path="/message",
            body={"type": "user_message", "sessionId": "s", "text": "hi"},
            expect_status=400,
            expect_pattern="expected a command frame",
            why="there is one wire shape: the frame",
        ),
        Probe(
            name="a frame inside a frame is refused by name",
            path="/message",
            body={"type": "command", "cmd": command_frame({"type": "user_message", "sessionId": "s", "text": "hi"})},
            expect_status=400,
            expect_pattern='unsupported command type "command"',
            why="this is what every phone send used to fail with",
        ),
        Probe(
            name="a framed message reaches routing",
            path="/message",
            body=command_frame({"type": "user_message", "sessionId": "no-such-session", "text": "hi"}),
            expect_status=409,
            expect_pattern="no-such-session",
            why="a well-formed command the machine refuses is a status code, not a 202",
        ),
    ]


def searchable(body: str) -> str:
    """Everything the reply says, unescaped.

    Substring-matching the raw body fails on JSON escaping - a reason containing
    quotes arrives as `\"command\"`, and this checker called a correct answer
    wrong because of it. The detail may also sit beside `error` rather than in
    it, so every field counts.
    """
    try:
        decoded = json.loads(body)
    except ValueError:
        return body
    if isinstance(decoded, dict):
        # Names and values both: a reply can put the detail in the key of a
        # field ("imageId": ...) as easily as in its text.
        return " | ".join(part for item in decoded.items() for part in (str(item[0]), str(item[1])))
    return body


def evaluate(probe: Probe, status: int, body: str) -> str | None:
    """None when the reply is what the app needs, otherwise why it is not."""
    if status != probe.expect_status:
        return f"HTTP {status}, expected {probe.expect_status} ({probe.why}): {body[:200]}"
    if probe.expect_pattern not in searchable(body):
        return f"HTTP {status} but the reply does not name {probe.expect_pattern!r}: {body[:200]}"
    return None


def request_via_origin(origin: str, key: str, probe: Probe) -> tuple[int, str]:
    """One probe against an http(s) origin, with the app's header."""
    headers = {"x-pinest-key": key}
    data: bytes | None = None
    if probe.body is not None:
        data = json.dumps(probe.body).encode()
        headers["content-type"] = "application/json"
    request = Request(f"{origin}{probe.path}", data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except URLError as error:
        raise ProbeUnreachable(f"{origin}{probe.path}: {error.reason}") from error


def resolve_public(hostname: str, resolver: Callable[[str], list[str]]) -> str:
    addresses = resolver(hostname)
    if not addresses:
        raise ProbeUnreachable(f"public resolvers know no address for {hostname}")
    return addresses[0]


def resolve_with_public_dns(hostname: str) -> list[str]:
    """Ask a public resolver over DNS-over-HTTPS.

    No resolver library and no local resolver: the local one answers NXDOMAIN
    for healthy tunnel names, and the point is a vantage that can see the name.
    """
    query = urlencode({"name": hostname, "type": "A"})
    request = Request(
        f"https://{PUBLIC_RESOLVERS[0]}/dns-query?{query}",
        headers={"accept": "application/dns-json"},
    )
    with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        answer = json.load(response)
    return [
        record["data"]
        for record in answer.get("Answer", [])
        if record.get("type") == 1 and isinstance(record.get("data"), str)
    ]


def request_via_tunnel(origin: str, key: str, probe: Probe, resolver: Callable[[str], list[str]]) -> tuple[int, str]:
    """One probe through the public name.

    The request carries the tunnel's own certificate name and Host header to the
    address public DNS returns: this host's resolver answers NXDOMAIN for
    healthy tunnel names, so trusting it would fail a working tunnel.
    """
    parsed = origin.removeprefix("https://").removeprefix("http://")
    hostname, _, port_text = parsed.partition(":")
    port = int(port_text) if port_text else 443
    if port != 443:
        raise ProbeUnreachable(f"unexpected tunnel port {port}")
    address = resolve_public(hostname, resolver)
    context = ssl.create_default_context()
    connection = socket.create_connection((address, port), timeout=REQUEST_TIMEOUT_SECONDS)
    with context.wrap_socket(connection, server_hostname=hostname) as tls:
        body = b"" if probe.body is None else json.dumps(probe.body).encode()
        head = [
            f"{'POST' if body else 'GET'} {probe.path} HTTP/1.1",
            f"Host: {hostname}",
            f"x-pinest-key: {key}",
            "connection: close",
        ]
        if body:
            head.append("content-type: application/json")
            head.append(f"content-length: {len(body)}")
        tls.sendall(("\r\n".join(head) + "\r\n\r\n").encode() + body)
        response = http.client.HTTPResponse(tls)
        response.begin()
        return response.status, response.read().decode("utf-8", "replace")


class ProbeUnreachable(RuntimeError):
    """The origin did not answer at all."""


def host_state(port: int, token: str) -> dict[str, object]:
    """The host's own state frame: what the app is told when it connects."""
    socket_client = reload_host.WebSocket(port, 5.0)
    try:
        socket_client.send_text(json.dumps({"type": "auth", "token": token}))
        deadline = time.time() + 15
        while time.time() < deadline:
            frame = reload_host.recv_json(socket_client, 2.0)
            if frame and frame.get("type") == "state":
                return frame
        raise ProbeUnreachable("the host sent no state frame")
    finally:
        socket_client.close()


def live_host() -> tuple[int, dict[str, object]]:
    record = reload_host.read_runtime_record()
    ports = [int(record["wsPort"])] if record and "wsPort" in record else reload_host.candidate_ws_ports()
    if not ports:
        raise ProbeUnreachable("no control port: is the machine running pinest?")
    token, _uid = reload_host.owner_id_token(reload_host.DEFAULT_API_KEY)
    last: Exception | None = None
    for port in ports:
        try:
            return port, host_state(port, token)
        except (ProbeUnreachable, OSError, reload_host.WebSocketError) as error:
            last = error
    raise ProbeUnreachable(f"no control port answered ({last})")


def verify(origin: str, key: str, send: Callable[[Probe], tuple[int, str]], label: str) -> list[str]:
    findings: list[str] = []
    for probe in probes():
        try:
            status, body = send(probe)
        except ProbeUnreachable as error:
            findings.append(f"{label}: {probe.name}: unreachable ({error})")
            continue
        problem = evaluate(probe, status, body)
        if problem is None:
            print(f"  ok   {label}: {probe.name}")
            continue
        findings.append(f"{label}: {probe.name}: {problem}")
        print(f"  FAIL {label}: {probe.name}: {problem}")
    return findings


def idle_survival(port: int, token: str, seconds: float) -> str | None:
    """Hold a connection open the way the app does, and see if it stays open.

    The app sends a ping framed as a command every 20 seconds and closes its own
    connection after a minute of silence. The machine used to drop that framed
    ping on the floor, so a healthy, idle app disconnected itself once a minute -
    which is what a phone reads as "connected, then immediately lost".
    """
    socket_client = reload_host.WebSocket(port, 5.0)
    try:
        socket_client.send_text(json.dumps({"type": "auth", "token": token}))
        authed = False
        deadline = time.time() + seconds
        next_ping = 0.0
        while time.time() < deadline:
            if socket_client.close_code is not None:
                return f"the machine closed a healthy idle connection ({reload_host.format_close(socket_client)})"
            if not authed:
                frame = reload_host.recv_json(socket_client, 3.0)
                if frame is None:
                    continue
                authed = frame.get("type") == "authed"
                continue
            if time.time() >= next_ping:
                socket_client.send_text(json.dumps(command_frame({"type": "ping"})))
                next_ping = time.time() + 20
                # A busy machine pushes state frames whenever it changes, so the
                # pong is looked for among them rather than insisted upon first.
                seen: list[str] = []
                pong_deadline = time.time() + 5
                while time.time() < pong_deadline:
                    reply = reload_host.recv_json(socket_client, 1.0)
                    if reply is None:
                        continue
                    if reply.get("type") == "pong":
                        break
                    seen.append(str(reply.get("type")))
                else:
                    detail = ", ".join(sorted(set(seen))) or "nothing"
                    return f"a framed ping was not answered with a pong (saw {detail})"
                continue
            reload_host.recv_json(socket_client, 1.0)
        return None
    finally:
        socket_client.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--local-only",
        action="store_true",
        help="skip the published tunnel and check only the machine's own loopback",
    )
    parser.add_argument(
        "--idle-seconds",
        type=float,
        default=0.0,
        help="hold an authenticated connection open this long, pinging as the app does",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        port, state = live_host()
    except ProbeUnreachable as error:
        print(f"cannot verify: {error}", file=sys.stderr)
        return 2

    token, _uid = reload_host.owner_id_token(reload_host.DEFAULT_API_KEY)
    key = state.get("httpKey")
    if not isinstance(key, str) or not key:
        print("cannot verify: the state frame carried no access key", file=sys.stderr)
        return 2
    print(f"machine on port {port}: online={state.get('online')} provider={state.get('tunnelProvider')}")

    findings: list[str] = []
    local_origin = f"http://127.0.0.1:{port}"
    findings += verify(local_origin, key, lambda probe: request_via_origin(local_origin, key, probe), "loopback")

    tunnel = state.get("tunnelUrl")
    if args.local_only:
        print("tunnel: skipped (--local-only)")
    elif isinstance(tunnel, str) and tunnel:
        try:
            findings += verify(
                tunnel,
                key,
                lambda probe: request_via_tunnel(tunnel, key, probe, resolve_with_public_dns),
                "tunnel",
            )
        except ProbeUnreachable as error:
            findings.append(f"tunnel: {tunnel}: unreachable ({error})")
    else:
        print("tunnel: none published, so the app has no remote origin to use")

    if args.idle_seconds > 0:
        problem = idle_survival(port, token, args.idle_seconds)
        if problem is None:
            print(f"  ok   loopback: an authenticated connection survives {args.idle_seconds:.0f}s of idling")
        else:
            findings.append(f"loopback: idle survival: {problem}")
            print(f"  FAIL loopback: idle survival: {problem}")

    if findings:
        print("\nunmet expectations:", file=sys.stderr)
        for finding in findings:
            print(f"  - {finding}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
