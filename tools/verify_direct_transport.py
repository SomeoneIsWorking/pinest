#!/usr/bin/env python3
"""Verify the direct (no-tunnel) transport on the RUNNING machine.

The live check has one dependency the unit and browser suites cannot cover: the
machine must already be running the code being verified. A verification started
in the same breath as the reload therefore fails for a reason that has nothing to
do with the transport — and a reload requested from inside a turn is deferred
until that turn ends, so the check has to WAIT rather than assume.

This waits for the machine to report a load newer than the one recorded when the
wait began (or accepts the recorded load when asked), then runs
`npm run verify:direct` and reports its output verbatim. Exit 0 means the peer
reached the machine over the direct channel and spoke the protocol; a timeout is
reported as a timeout, never as success.

Usage:
  python3 tools/verify_direct_transport.py                 # wait for a new load
  python3 tools/verify_direct_transport.py --now           # verify what is live
  python3 tools/verify_direct_transport.py --deadline 1800 --timeout-ms 20000
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reload_host import RUNTIME_PATH, describe_record, read_runtime_record  # noqa: E402


class VerificationError(RuntimeError):
    """The check could not run, or the transport did not come up."""


def load_identity(record: dict[str, object] | None) -> tuple[object, object]:
    """What counts as "a different load": the fingerprint and when it landed."""
    if not record:
        return (None, None)
    return (record.get("sourceFingerprint"), record.get("at"))


def wait_for_new_load(baseline: tuple[object, object], deadline_s: float) -> dict[str, object]:
    """Block until the machine reports a load that is not the baseline one.

    Refusing after the deadline is the honest outcome: a machine that never
    reloaded has not been verified, and pretending otherwise is how a check
    becomes a formality.
    """
    stopped_at = time.monotonic() + deadline_s
    last_report = 0.0
    while True:
        record = read_runtime_record()
        if load_identity(record) != baseline:
            print(f"machine reloaded: {describe_record(record)}", flush=True)
            return record or {}
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


def run_probe(timeout_ms: int) -> int:
    """Run the committed peer, streaming its own words rather than a summary."""
    completed = subprocess.run(
        ["npm", "run", "verify:direct", "--", "--timeout-ms", str(timeout_ms)],
        cwd=Path(__file__).resolve().parent.parent,
        text=True,
        capture_output=True,
    )
    for line in (completed.stdout or "").splitlines():
        if line.strip() and not line.startswith(">"):
            print(line, flush=True)
    if completed.returncode != 0 and completed.stderr.strip():
        print(completed.stderr.strip(), file=sys.stderr)
    return completed.returncode


def record_p2p_status() -> str:
    """The machine's own view of its direct transport, from the live host."""
    import verify_live_host

    try:
        _port, state = verify_live_host.live_host()
    except Exception as error:  # the check itself is what matters, not this line
        return f"machine status unavailable: {error}"
    return f"machine status: {state.get('p2p')}"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--now", action="store_true", help="verify the load that is already live")
    parser.add_argument("--deadline", type=float, default=1800.0, help="seconds to wait for a new load")
    parser.add_argument("--timeout-ms", type=int, default=20_000, help="per-stage timeout for the peer")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    baseline = (None, None) if args.now else load_identity(read_runtime_record())
    if args.now:
        print(f"verifying the live load: {describe_record(read_runtime_record())}", flush=True)
    else:
        print(f"baseline: {RUNTIME_PATH} -> {baseline[0]}", flush=True)
    try:
        wait_for_new_load(baseline, args.deadline)
    except VerificationError as error:
        print(f"cannot verify: {error}", file=sys.stderr)
        return 2

    # A reload restarts the control channel on a new port; the peer discovers it.
    code = run_probe(args.timeout_ms)
    print(record_p2p_status(), flush=True)
    if code != 0:
        print("status: FAILED — the direct transport did not carry the protocol", file=sys.stderr)
        return 1
    print("status: OK — the running machine served the direct transport", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
