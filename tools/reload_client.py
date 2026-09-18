#!/usr/bin/env python3
"""Ask the BROWSER to reload, and read back what it says about itself.

A stale tab is otherwise something only a human can fix: the machine cannot
refresh a page it does not own. The request travels the channel the app already
watches (the `clientReload` field of its own discovery document) and the app
honours it once, when it is newer than the page it is running.

This tool also prints the app's own report - which browser, which path, which
channels, which candidate pair, and the words of its last failure. That is the
half of a direct connection the machine cannot see, and without it every
diagnosis was one-ended.

Reuses the host's WebSocket client from reload_host.py: one implementation of
"authenticate to the machine's control channel and send one command".
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from reload_host import (
    AUTH_TIMEOUT_S,
    DEFAULT_API_KEY,
    ReloadError,
    WebSocket,
    candidate_ws_ports,
    describe_record,
    owner_id_token,
    read_runtime_record,
    recv_json,
)

REPORT_READ_TIMEOUT_S = 90.0


def reload_client_command(request_id: str) -> dict:
    """The command the host turns into a write into the app's own document."""
    return {"type": "command", "cmd": {"type": "reload_client", "id": request_id}}


def report_from_state(state: dict) -> dict | None:
    client = state.get("client")
    return client if isinstance(client, dict) else None


def describe_report(client: dict | None) -> str:
    """Always a sentence: a report that is absent and one that is unreadable are
    different facts, and 'no report' must never print as an empty line."""
    if client is None:
        return "the machine has not yet read a report from this browser"
    if not client.get("read"):
        return f"the machine could not read a report: {client.get('problem')}"
    age = client.get("at")
    age_text = "unknown age"
    if isinstance(age, int):
        age_text = f"{max(0, int(time.time() * 1000 - age) / 1000):.0f}s ago"
    return (
        f"{age_text} · {client.get('platform')} · "
        f"{'connected via ' + str(client.get('path')) if client.get('connected') else 'not connected'}"
        + (f" · last error: {client['lastError']}" if client.get("lastError") else "")
        + (f" · bundle {client['bundle']}" if client.get("bundle") else "")
        + (f"\n  the machine reads it as: {client['summary']}" if client.get("summary") else "")
    )


def describe_transport(state: dict) -> str:
    """What the machine's own end of the direct channel is doing.

    The other half of `describe_report`, and the half that decides the hard
    cases: a peer can report both labels open and `ice: connected` while the
    machine received nothing at all (that was I-065, and `rawIn` is the field
    that showed it). The counters print even when nothing is connected, because
    "never connected" and "connected and then stopped" are different faults.
    """
    p2p = state.get("p2p")
    if not isinstance(p2p, dict):
        return "this host is not publishing a transport state (no direct offer is being made)"
    if not p2p.get("offerTs"):
        return "the machine has published no direct offer at all"
    age = p2p.get("offerAgeMs")
    age_text = f"newest offer {int(age / 1000)}s old" if isinstance(age, int) else "no offer"
    # `rawIn` counts messages that reached the bridge; the frames are what it
    # relayed onward. Equal numbers mean nothing was refused; rawIn on its own
    # means the bytes arrived and the framing did not.
    traffic = (
        f"{p2p.get('framesToServer', 0)} in / {p2p.get('framesToClient', 0)} out "
        f"({p2p.get('rawIn', 0)} reached the bridge)"
    )
    shape = (
        f"{p2p.get('exchanges', 0)} exchange(s), {p2p.get('channelCloses', 0)} channel(s) closed, "
        f"{p2p.get('bridges', 0)} bridge(s)"
    )
    if p2p.get("channelOpen"):
        head = f"connected now · {traffic} · {shape}"
        head += f"; the socket to itself is {p2p['bridgeSocket']}" if p2p.get("bridgeSocket") else ""
    else:
        head = f"nothing connected now · {traffic} · {shape} · {age_text}"
    # The socket state belongs to the LAST bridge, so it is only meaningful while
    # one is up; `lastError` is likewise whatever went wrong most recently and
    # says nothing about the connection in front of you. Both are labelled so
    # neither reads as current, because both invite a wrong conclusion.
    if p2p.get("lastError"):
        head += f"; an earlier failure: {p2p['lastError']}"
    return head


def read_state(port: int, token: str) -> tuple[dict | None, str]:
    """The machine's current state, with nothing asked of anyone."""
    ws = WebSocket(port, AUTH_TIMEOUT_S)
    try:
        ws.send_text(json.dumps({"type": "auth", "token": token}))
        reply = recv_json(ws, AUTH_TIMEOUT_S)
        if reply is None or reply.get("type") != "authed":
            return None, f"authentication failed: {reply}"
        ws.send_text(json.dumps({"type": "subscribe", "sessionIds": []}))
        deadline = time.time() + 10.0
        while time.time() < deadline:
            frame = ws.recv_text(1.0)
            if not frame:
                continue
            try:
                parsed = json.loads(frame)
            except json.JSONDecodeError:
                continue
            if parsed.get("type") == "state":
                return parsed, "read the machine's current state"
        return None, "the machine sent no state within 10s"
    finally:
        ws.close()


def ask_once(port: int, token: str, request_id: str) -> tuple[dict | None, str]:
    """Send the request, and return the first state frame that follows it."""
    ws = WebSocket(port, AUTH_TIMEOUT_S)
    try:
        ws.send_text(json.dumps({"type": "auth", "token": token}))
        reply = recv_json(ws, AUTH_TIMEOUT_S)
        if reply is None or reply.get("type") != "authed":
            return None, f"authentication failed: {reply}"
        # No sessions: this tool watches the machine's report of the browser,
        # and stream deltas are pure waste on a connection that must stay alive.
        ws.send_text(json.dumps({"type": "subscribe", "sessionIds": []}))
        ws.send_text(json.dumps(reload_client_command(request_id)))
        deadline = time.time() + 10.0
        while time.time() < deadline:
            frame = ws.recv_text(1.0)
            if not frame:
                continue
            try:
                parsed = json.loads(frame)
            except json.JSONDecodeError:
                continue
            if parsed.get("type") == "error":
                return None, f"the machine refused: {parsed.get('message')}"
            if parsed.get("type") == "notice":
                return parsed, f"the machine answered: {parsed.get('message')}"
            if parsed.get("type") == "state":
                return parsed, "the machine sent state without a notice"
        return None, "the machine did not answer the request"
    finally:
        ws.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--api-key",
        default=os.environ.get("PINEST_FIREBASE_API_KEY", DEFAULT_API_KEY),
        help="override the (public) Firebase web apiKey",
    )
    parser.add_argument("--status", action="store_true", help="only print the machine's transport view and the app's report")
    parser.add_argument(
        "--wait-for-report",
        type=float,
        default=REPORT_READ_TIMEOUT_S,
        help="after asking, wait this long for the browser's report to become NEWER, "
        "which is what proves the tab actually reloaded",
    )
    parser.add_argument(
        "--deadline",
        type=float,
        default=60.0,
        help="how long to keep asking when a request is accepted but nothing changes",
    )
    args = parser.parse_args()

    record = read_runtime_record()
    print(f"host: {describe_record(record)}", flush=True)
    ports = candidate_ws_ports()
    if not ports:
        raise ReloadError("no `pi` process is listening on loopback; start the host first")

    token, uid = owner_id_token(args.api_key)
    print(f"owner {uid[:6] if uid else '(unknown)'}…", flush=True)

    if args.status:
        # Read-only: no request is sent, so asking for the current report can
        # never itself change anything.
        state, note = read_state(ports[0], token)
        print(note, flush=True)
        print(f"the machine's own view: {describe_transport(state or {})}", flush=True)
        print(f"the app says: {describe_report(report_from_state(state or {}))}", flush=True)
        return 0

    request_id = f"reload-client-{int(time.time() * 1000)}"
    deadline = time.time() + args.deadline
    state: dict | None = None
    while True:
        state, note = ask_once(ports[0], token, request_id)
        print(note, flush=True)
        if note.startswith("the machine answered"):
            break
        if time.time() >= deadline:
            print(
                "status: NOT ASKED — the request never reached the app's document. The machine "
                "writes that field itself, so a failure here is the machine's Firebase access "
                "or its command routing, not the browser's.",
                flush=True,
            )
            return 1
        time.sleep(2)

    before = report_from_state(state or {})
    before_at = before.get("at") if before and before.get("read") else None
    print(f"the app said before the reload: {describe_report(before)}", flush=True)

    # The proof the tab obeyed is its report becoming NEWER than the request:
    # an app that never reloaded keeps reporting the same age forever.
    deadline = time.time() + args.wait_for_report
    while time.time() < deadline:
        state, _ = ask_once(ports[0], token, "watch")
        report = report_from_state(state or {})
        at = report.get("at") if report and report.get("read") else None
        if isinstance(at, int) and (before_at is None or at > before_at):
            print(f"the browser came back: {describe_report(report)}", flush=True)
            print("status: OK — the app reloaded and is reporting again", flush=True)
            return 0
        time.sleep(3)
    print(
        f"status: ASKED BUT UNCHANGED — the request is in the document and no newer report "
        f"arrived within {args.wait_for_report:g}s. An app older than this change does not "
        "watch the field, so this result proves the machine's side only.",
        flush=True,
    )
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ReloadError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(3)
