#!/usr/bin/env python3
"""Keep every generated platform shell on the PiNest product identity."""

from __future__ import annotations

import json
from pathlib import Path
import unittest

from verify_apk import EXPECTED_PACKAGE


APP_ROOT = Path(__file__).resolve().parents[1]


class ApplicationIdentityTests(unittest.TestCase):
    def test_platform_application_identifiers_match_release_package(self) -> None:
        android = (APP_ROOT / "android/app/build.gradle.kts").read_text(encoding="utf-8")
        self.assertIn(f'namespace = "{EXPECTED_PACKAGE}"', android)
        self.assertIn(f'applicationId = "{EXPECTED_PACKAGE}"', android)
        self.assertEqual(android.count(EXPECTED_PACKAGE), 2)

        activity = APP_ROOT / "android/app/src/main/kotlin/com/barishamil/pinest/MainActivity.kt"
        self.assertTrue(activity.is_file())
        self.assertIn(f"package {EXPECTED_PACKAGE}", activity.read_text(encoding="utf-8"))
        services_file = APP_ROOT / "android/app/google-services.json"
        if not services_file.is_file():
            services_file = APP_ROOT / "android/app/google-services.template.json"
        services = json.loads(services_file.read_text(encoding="utf-8"))
        android_packages = {
            client["client_info"]["android_client_info"]["package_name"]
            for client in services["client"]
        }
        self.assertEqual(android_packages, {EXPECTED_PACKAGE})

        linux = (APP_ROOT / "linux/CMakeLists.txt").read_text(encoding="utf-8")
        self.assertIn(f'set(APPLICATION_ID "{EXPECTED_PACKAGE}")', linux)

        macos = (APP_ROOT / "macos/Runner/Configs/AppInfo.xcconfig").read_text(encoding="utf-8")
        self.assertIn(f"PRODUCT_BUNDLE_IDENTIFIER = {EXPECTED_PACKAGE}", macos)

        ios = (APP_ROOT / "ios/Runner.xcodeproj/project.pbxproj").read_text(encoding="utf-8")
        identifiers = {
            line.split("=", 1)[1].strip(" ;")
            for line in ios.splitlines()
            if "PRODUCT_BUNDLE_IDENTIFIER =" in line
        }
        self.assertEqual(identifiers, {EXPECTED_PACKAGE, f"{EXPECTED_PACKAGE}.RunnerTests"})

    def test_obsolete_fork_product_name_is_absent(self) -> None:
        shells = (
            APP_ROOT / "android",
            APP_ROOT / "ios",
            APP_ROOT / "linux",
            APP_ROOT / "macos",
            APP_ROOT / "windows",
        )
        for root in shells:
            for path in root.rglob("*"):
                if path.is_file() and path.suffix.lower() in {
                    ".cc", ".cmake", ".cpp", ".h", ".kts", ".kt", ".plist",
                    ".pbxproj", ".rc", ".txt", ".xcconfig", ".xcscheme",
                }:
                    self.assertNotIn("remote_pi_app", path.read_text(encoding="utf-8"), path)


if __name__ == "__main__":
    unittest.main()
