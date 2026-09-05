#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

import check_structure


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRATCH_ROOT = REPOSITORY_ROOT / "scratch"


class StructureCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        SCRATCH_ROOT.mkdir(exist_ok=True)
        self.temporary_directory = tempfile.TemporaryDirectory(
            prefix="structure-check-test-", dir=SCRATCH_ROOT
        )
        self.root = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def write_lines(self, relative_path: str, line_count: int) -> Path:
        path = self.root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("source line\n" * line_count, encoding="utf-8")
        return path

    def test_source_at_default_limit_passes(self) -> None:
        self.write_lines("server/src/bounded.ts", check_structure.DEFAULT_LINE_LIMIT)

        self.assertEqual(check_structure.find_violations(self.root), [])

    def test_main_returns_success_for_bounded_sources(self) -> None:
        self.write_lines("app/lib/bounded.dart", check_structure.DEFAULT_LINE_LIMIT)
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            result = check_structure.main(["--root", str(self.root)])

        self.assertEqual(result, 0)
        self.assertIn("Source structure check passed", output.getvalue())

    def test_legacy_limits_match_head_baselines(self) -> None:
        self.assertEqual(
            check_structure.LEGACY_LINE_LIMITS,
            {
                Path("server/src/index.ts"): 1_220,
            },
        )

    def test_oversized_source_reports_exact_path_count_and_limit(self) -> None:
        line_count = check_structure.DEFAULT_LINE_LIMIT + 1
        self.write_lines("server/src/oversized.ts", line_count)

        violations = check_structure.find_violations(self.root)

        self.assertEqual(
            violations,
            [
                check_structure.Violation(
                    Path("server/src/oversized.ts"),
                    line_count,
                    check_structure.DEFAULT_LINE_LIMIT,
                )
            ],
        )
        self.assertEqual(
            check_structure.format_violation(violations[0]),
            "server/src/oversized.ts: 1201 lines (limit 1200)",
        )

    def test_legacy_file_cannot_grow_past_its_baseline(self) -> None:
        relative_path = Path("server/src/index.ts")
        legacy_limit = check_structure.LEGACY_LINE_LIMITS[relative_path]
        self.write_lines(relative_path.as_posix(), legacy_limit + 1)

        self.assertEqual(
            check_structure.find_violations(self.root),
            [
                check_structure.Violation(
                    relative_path, legacy_limit + 1, legacy_limit
                )
            ],
        )

    def test_generated_vendor_build_and_scratch_sources_are_skipped(self) -> None:
        oversized = check_structure.DEFAULT_LINE_LIMIT + 1
        self.write_lines("vendor/library.dart", oversized)
        self.write_lines("app/build/output.ts", oversized)
        self.write_lines("scratch/probe.py", oversized)
        generated = self.write_lines("app/lib/generated_config.dart", oversized)
        generated.write_text(
            "// GENERATED CODE - DO NOT MODIFY\n" + generated.read_text(encoding="utf-8"),
            encoding="utf-8",
        )

        self.assertEqual(check_structure.find_violations(self.root), [])

    def test_main_returns_failure_and_prints_measured_violation(self) -> None:
        self.write_lines("app/lib/too_large.dart", 1_234)
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            result = check_structure.main(["--root", str(self.root)])

        self.assertEqual(result, 1)
        self.assertIn(
            "app/lib/too_large.dart: 1234 lines (limit 1200)", output.getvalue()
        )


if __name__ == "__main__":
    unittest.main()
