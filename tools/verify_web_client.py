#!/usr/bin/env python3
"""Run the browser-only client tests, finding a browser to run them in.

The direct (no-tunnel) transport is WebRTC: its whole risk is the browser
interop, which does not exist on the Dart VM, so `flutter test` alone never
touches it. This runs the tagged browser suite in a real Chromium and names the
browser it used, so the check is discoverable instead of being a command in one
person's shell history.

It never downloads a browser. If none is installed it refuses by name and prints
the platform's install command.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Callable, Iterable, Iterator


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
APP_DIR = REPOSITORY_ROOT / "app"
BROWSER_TEST = Path("test") / "direct_channel_web_test.dart"

# Names to try on PATH, in the order a host is most likely to have them.
PATH_CANDIDATES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome")
# Downloaded-by-tooling locations that are already a legitimate local browser.
CACHE_PATTERNS = (
    ".cache/rod/browser/*/chrome",
    ".cache/ms-playwright/chromium-*/chrome-linux/chrome",
)

INSTALL_HINT = {
    "linux": "sudo dnf install chromium   (Fedora)   /   sudo apt install chromium   (Debian, Ubuntu)",
    "darwin": "brew install --cask chromium",
    "win32": "winget install Chromium.Chromium",
}


class BrowserNotFound(RuntimeError):
    """No Chromium to run the browser suite in."""


def candidate_paths(
    home: Path,
    env: dict[str, str],
    which: Callable[[str], str | None] = shutil.which,
    glob: Callable[[Path], Iterable[Path]] | None = None,
) -> Iterator[Path]:
    """Every place a browser may already be, most explicit first.

    Pure enough to test: the environment, the PATH lookup, and the cache glob
    are all injected.
    """
    explicit = env.get("CHROME_EXECUTABLE") or env.get("CHROME_BIN")
    if explicit:
        yield Path(explicit)
    for name in PATH_CANDIDATES:
        found = which(name)
        if found:
            yield Path(found)
    search = glob or (lambda root: sorted(root.glob("*")))
    for pattern in CACHE_PATTERNS:
        root = home / Path(pattern).parts[0]
        if not root.is_dir():
            continue
        for match in sorted(home.glob(pattern)):
            yield match


def discover_browser(
    home: Path,
    env: dict[str, str],
    which: Callable[[str], str | None] = shutil.which,
    glob: Callable[[Path], Iterable[Path]] | None = None,
) -> Path | None:
    for path in candidate_paths(home, env, which, glob):
        if path.is_file() and os.access(path, os.X_OK):
            return path
    return None


def missing_browser_message(platform: str) -> str:
    hint = INSTALL_HINT.get(platform, "install Chromium, or set CHROME_EXECUTABLE")
    return (
        "no Chromium found to run the browser suite.\n"
        f"  Install it: {hint}\n"
        "  Or point at one you already have: CHROME_EXECUTABLE=/path/to/chrome"
    )


def run_browser_suite(browser: Path, extra_args: list[str]) -> int:
    command = [
        "flutter",
        "test",
        "--platform",
        "chrome",
        "--reporter",
        "expanded",
        *extra_args,
        str(BROWSER_TEST),
    ]
    if not shutil.which("flutter"):
        raise BrowserNotFound("flutter is not on PATH (see the app's README for the toolchain)")
    print(f"browser: {browser}")
    environment = {**os.environ, "CHROME_EXECUTABLE": str(browser)}
    return subprocess.run(command, cwd=APP_DIR, env=environment, check=False).returncode


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--browser",
        type=Path,
        help="Chromium binary to use instead of discovering one",
    )
    parser.add_argument(
        "test_args",
        nargs="*",
        help="extra arguments handed to `flutter test` (e.g. --plain-name 'a case')",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    browser = args.browser or discover_browser(Path.home(), dict(os.environ))
    if browser is None or not browser.is_file():
        print(missing_browser_message(sys.platform), file=sys.stderr)
        return 2
    try:
        return run_browser_suite(browser, list(args.test_args))
    except BrowserNotFound as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
