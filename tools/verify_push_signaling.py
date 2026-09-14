#!/usr/bin/env python3
"""Verify that the machine learns the app's answer by watching, not polling.

Two facts, and the check fails unless both hold.

1. A real Firestore listener, built from the SHIPPING watch
   (`server/src/firestore-listen.ts`), delivers a document change that this
   process never asked for. `npm run verify:push` proves it by provoking an
   external write through the REST API while the watch's own read path is wired
   to fail loudly — a delivery therefore cannot be a poll in disguise.

2. The machine that is RUNNING says it is doing the same thing: its status
   carries `signalingMode`, and "push" there is the only accepted answer. A
   listener proved in a script while the host polls is exactly the gap this
   closes.

Why it matters: the machine used to read the document every two seconds to find
the answer — 43,200 reads a day against a free project's 50,000 — and the
measured consequence was an exhausted quota that made a punch fail with nothing
said at either end (issue #57).

A check started in the same breath as a reload would otherwise grade the OLD
bundle, so the waiting form exists for the same reason it does in
`verify_direct_transport.py`: request the reload, leave, and grade what actually
loaded. Run it DETACHED - a reload reaps the background tasks the agent runtime
holds, including the one waiting for it.

Usage:
  python3 tools/verify_push_signaling.py                       # grade the live host
  python3 tools/verify_push_signaling.py --wait-for-new-load --deadline 1800
  python3 tools/verify_push_signaling.py --timeout-ms 20000

  setsid nohup python3 tools/verify_push_signaling.py --wait-for-new-load \
    > scratch/tasks/push-after-reload.log 2>&1 &
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reload_host import describe_record, read_runtime_record  # noqa: E402
from verify_live_host import live_host  # noqa: E402


class VerificationError(RuntimeError):
    """The check could not run, or push signaling was not what was found."""


REPO = Path(__file__).resolve().parent.parent


def run_probe(timeout_ms: int) -> int:
    """Run the committed listener check, streaming its own words."""
    completed = subprocess.run(
        ["npm", "run", "verify:push", "--", "--timeout-ms", str(timeout_ms)],
        cwd=REPO,
        text=True,
        capture_output=True,
    )
    for line in (completed.stdout or "").splitlines():
        if line.strip() and not line.startswith(">"):
            print(line, flush=True)
    if completed.returncode != 0 and completed.stderr.strip():
        print(completed.stderr.strip(), file=sys.stderr)
    return completed.returncode


def host_mode(state: dict[str, object]) -> str:
    """The mode the RUNNING machine reports, refusing by name when it says none."""
    mode = state.get("signalingMode")
    if mode is None:
        raise VerificationError(
            "the running machine does not report a signalingMode — it is running "
            "an older bundle than the one that watches the document"
        )
    return str(mode)


def load_identity(record: dict[str, object] | None) -> tuple[object, object]:
    """What counts as "a different load": the fingerprint and when it landed."""
    if not record:
        return (None, None)
    return (record.get("sourceFingerprint"), record.get("at"))


def wait_for_new_load(baseline: tuple[object, object], deadline_s: float) -> None:
    """Block until the machine reports a load that is not the baseline one.

    Refusing after the deadline is the honest outcome: a machine that never
    reloaded has not been verified, and pretending otherwise is how a check
    becomes a formality."""
    stopped_at = time.monotonic() + deadline_s
    last_report = 0.0
    while True:
        record = read_runtime_record()
        if load_identity(record) != baseline:
            print(f"machine reloaded: {describe_record(record)}", flush=True)
            return
        now = time.monotonic()
        if now >= stopped_at:
            raise VerificationError(
                f"the machine did not report a new load within {deadline_s:.0f}s "
                f"(it still reports {describe_record(record)})"
            )
        if now - last_report >= 15:
            last_report = now
            print(f"waiting for the reload: {describe_record(record)}", flush=True)
        time.sleep(2)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout-ms", type=int, default=20_000, help="deadline for one write")
    parser.add_argument(
        "--skip-probe",
        action="store_true",
        help="only ask the running machine (no listener is built)",
    )
    parser.add_argument(
        "--wait-for-new-load",
        action="store_true",
        help="first wait for the machine to load code newer than it is running now",
    )
    parser.add_argument("--deadline", type=float, default=1800.0, help="seconds to wait for a load")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.wait_for_new_load:
        baseline = load_identity(read_runtime_record())
        print(f"waiting for a load newer than {baseline[0]}", flush=True)
        wait_for_new_load(baseline, args.deadline)
    exit_code = 0
    if not args.skip_probe:
        exit_code = run_probe(args.timeout_ms)
    try:
        _port, state = live_host()
        mode = host_mode(state)
    except Exception as error:  # the check itself is what matters, not this line
        print(f"running machine: unavailable ({error})")
        return exit_code or 1
    reason = state.get("signalingError")
    print(f"running machine: signalingMode={mode}" + (f", reason={reason}" if reason else ""))
    if mode != "push":
        print(
            "FAILED: the running machine is polling the discovery document "
            f"(signalingMode={mode}); the listener is not in play"
        )
        return 1
    if exit_code != 0:
        return exit_code
    print("PUSH SIGNALING VERIFIED: the machine watches the document and nothing polls it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
