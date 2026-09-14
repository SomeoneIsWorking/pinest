#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

import verify_web_client


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRATCH_ROOT = REPOSITORY_ROOT / "scratch"


class BrowserDiscoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        SCRATCH_ROOT.mkdir(exist_ok=True)
        self.temporary_directory = tempfile.TemporaryDirectory(
            prefix="web-client-verifier-test-", dir=SCRATCH_ROOT
        )
        self.home = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def make_executable(self, relative: str) -> Path:
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\n", encoding="utf-8")
        path.chmod(0o755)
        return path

    def test_an_explicit_environment_path_wins(self) -> None:
        explicit = self.make_executable("custom/chrome")
        found = verify_web_client.discover_browser(
            self.home,
            {"CHROME_EXECUTABLE": str(explicit)},
            which=lambda _name: None,
        )
        self.assertEqual(found, explicit)

    def test_a_browser_on_the_path_is_found(self) -> None:
        on_path = self.make_executable("bin/chromium")
        found = verify_web_client.discover_browser(
            self.home,
            {},
            which=lambda name: str(on_path) if name == "chromium" else None,
        )
        self.assertEqual(found, on_path)

    def test_a_cached_browser_is_found_without_being_on_the_path(self) -> None:
        cached = self.make_executable(".cache/rod/browser/chromium-1321438/chrome")
        found = verify_web_client.discover_browser(
            self.home,
            {},
            which=lambda _name: None,
        )
        self.assertEqual(found, cached)

    def test_nothing_installed_is_reported_as_missing(self) -> None:
        self.assertIsNone(
            verify_web_client.discover_browser(self.home, {}, which=lambda _name: None)
        )
        message = verify_web_client.missing_browser_message("linux")
        self.assertIn("sudo dnf install chromium", message)
        self.assertIn("CHROME_EXECUTABLE", message)

    def test_a_non_executable_candidate_is_not_accepted(self) -> None:
        path = self.home / "custom" / "chrome"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")
        self.assertIsNone(
            verify_web_client.discover_browser(
                self.home, {"CHROME_EXECUTABLE": str(path)}, which=lambda _name: None
            )
        )

    def test_the_suite_targets_the_browser_tagged_test(self) -> None:
        # The command must name the file, or `flutter test --platform chrome`
        # would try to run VM tests in a browser.
        self.assertTrue((verify_web_client.APP_DIR / verify_web_client.BROWSER_TEST).is_file())

    def test_an_unknown_platform_still_gets_actionable_advice(self) -> None:
        message = verify_web_client.missing_browser_message("plan9")
        self.assertIn("install Chromium", message)
        self.assertIn("CHROME_EXECUTABLE", message)


if __name__ == "__main__":
    unittest.main()
