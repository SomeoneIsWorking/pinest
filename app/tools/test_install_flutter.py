#!/usr/bin/env python3

from __future__ import annotations

from contextlib import nullcontext
import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from install_flutter import (
    FLUTTER_ARCHIVE_NAME,
    FLUTTER_ARCHIVE_SHA256,
    FLUTTER_ARCHIVE_URL,
    FLUTTER_VERSION,
    InstallError,
    VERSION_MARKER,
    emit_github_metadata,
    install_flutter,
    prepare_archive,
    safe_extract_archive,
    verify_archive,
)


SCRATCH_ROOT = Path(__file__).resolve().parents[2] / "scratch" / "tests"


def archive_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_archive(path: Path, members: list[tuple[tarfile.TarInfo, bytes]]) -> None:
    with tarfile.open(path, mode="w:xz") as archive:
        for member, contents in members:
            archive.addfile(member, io.BytesIO(contents) if member.isfile() else None)


def regular_file(name: str, contents: bytes = b"contents") -> tuple[tarfile.TarInfo, bytes]:
    member = tarfile.TarInfo(name)
    member.size = len(contents)
    member.mode = 0o755
    return member, contents


class FlutterInstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
        self.temporary_directory = tempfile.TemporaryDirectory(dir=SCRATCH_ROOT)
        self.root = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_release_pin_is_exact(self) -> None:
        self.assertEqual(FLUTTER_VERSION, "3.44.5")
        self.assertEqual(FLUTTER_ARCHIVE_NAME, "flutter_linux_3.44.5-stable.tar.xz")
        self.assertEqual(
            FLUTTER_ARCHIVE_URL,
            "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/"
            "flutter_linux_3.44.5-stable.tar.xz",
        )

    def test_emits_machine_readable_github_metadata(self) -> None:
        output = self.root / "github-output"

        emit_github_metadata(output)

        self.assertEqual(
            output.read_text(encoding="utf-8"),
            "version=3.44.5\n"
            "archive_name=flutter_linux_3.44.5-stable.tar.xz\n"
            "archive_sha256="
            "28aa13854feb9de44a317b97c4e886ea3f0af744027418b7e63885cfcd2951f3\n",
        )
        self.assertEqual(
            FLUTTER_ARCHIVE_SHA256,
            "28aa13854feb9de44a317b97c4e886ea3f0af744027418b7e63885cfcd2951f3",
        )

    def test_verifies_archive_checksum(self) -> None:
        archive = self.root / "archive.tar.xz"
        archive.write_bytes(b"archive")
        expected = hashlib.sha256(b"archive").hexdigest()

        verify_archive(archive, expected)
        with self.assertRaisesRegex(InstallError, "checksum mismatch"):
            verify_archive(archive, "0" * 64)

    def test_reuses_verified_cached_archive_without_network(self) -> None:
        cache = self.root / "cache" / FLUTTER_ARCHIVE_NAME
        cache.parent.mkdir()
        cache.write_bytes(b"cached archive")
        expected = hashlib.sha256(cache.read_bytes()).hexdigest()

        def fail_if_called(_: str):
            self.fail("network access must not occur for a verified cache hit")

        prepare_archive(cache, expected_sha256=expected, open_url=fail_if_called)

    def test_refuses_bad_cached_archive_without_network_or_replacement(self) -> None:
        cache = self.root / FLUTTER_ARCHIVE_NAME
        cache.write_bytes(b"tampered")

        def fail_if_called(_: str):
            self.fail("a poisoned cache must fail closed, not trigger a replacement download")

        with self.assertRaisesRegex(InstallError, "checksum mismatch"):
            prepare_archive(cache, expected_sha256="0" * 64, open_url=fail_if_called)
        self.assertEqual(cache.read_bytes(), b"tampered")

    def test_downloads_to_requested_cache_file_and_verifies_before_publish(self) -> None:
        cache = self.root / "cache" / FLUTTER_ARCHIVE_NAME
        payload = b"official archive bytes"
        expected = hashlib.sha256(payload).hexdigest()

        prepare_archive(
            cache,
            expected_sha256=expected,
            open_url=lambda _: nullcontext(io.BytesIO(payload)),
        )

        self.assertEqual(cache.read_bytes(), payload)
        self.assertEqual(list(cache.parent.glob("*.download")), [])

    def test_extracts_valid_flutter_tree_and_internal_symlink(self) -> None:
        archive = self.root / "flutter.tar.xz"
        link = tarfile.TarInfo("flutter/bin/dart")
        link.type = tarfile.SYMTYPE
        link.linkname = "flutter"
        write_archive(
            archive,
            [
                regular_file("flutter/bin/flutter", b"#!/bin/sh\n"),
                (link, b""),
            ],
        )
        destination = self.root / "extract"
        destination.mkdir()

        safe_extract_archive(archive, destination)

        self.assertEqual((destination / "flutter" / "bin" / "flutter").read_bytes(), b"#!/bin/sh\n")
        self.assertEqual((destination / "flutter" / "bin" / "dart").readlink(), Path("flutter"))

    def test_refuses_path_traversal_before_extraction(self) -> None:
        for name in ("../escape", "/absolute", "other/file", "flutter/../../escape"):
            with self.subTest(name=name):
                archive = self.root / (hashlib.sha256(name.encode()).hexdigest() + ".tar.xz")
                write_archive(
                    archive,
                    [regular_file("flutter/first", b"must not extract"), regular_file(name)],
                )
                destination = self.root / (archive.stem + "-extract")
                destination.mkdir()

                with self.assertRaises(InstallError):
                    safe_extract_archive(archive, destination)
                self.assertFalse((destination / "flutter" / "first").exists())

    def test_refuses_link_traversal(self) -> None:
        archive = self.root / "link-traversal.tar.xz"
        link = tarfile.TarInfo("flutter/bin/escape")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../../outside"
        write_archive(archive, [(link, b"")])
        destination = self.root / "extract"
        destination.mkdir()

        with self.assertRaisesRegex(InstallError, "escapes its root"):
            safe_extract_archive(archive, destination)

    def test_installs_atomically_and_publishes_github_path(self) -> None:
        archive = self.root / FLUTTER_ARCHIVE_NAME
        write_archive(archive, [regular_file("flutter/bin/flutter", b"#!/bin/sh\n")])
        github_path = self.root / "github-path"
        install_dir = self.root / "sdk"

        sdk_path = install_flutter(
            install_dir,
            archive,
            github_path=github_path,
            expected_sha256=archive_sha256(archive),
        )

        self.assertEqual(sdk_path, install_dir.resolve() / "flutter")
        self.assertEqual((sdk_path / VERSION_MARKER).read_text(), f"{FLUTTER_VERSION}\n")
        self.assertEqual(github_path.read_text(), f"{sdk_path / 'bin'}\n")
        self.assertEqual(list(install_dir.glob(".flutter-extract-*")), [])

    def test_existing_exact_install_is_idempotent(self) -> None:
        install_dir = self.root / "sdk"
        sdk_path = install_dir / "flutter"
        (sdk_path / "bin").mkdir(parents=True)
        (sdk_path / "bin" / "flutter").write_text("flutter")
        (sdk_path / VERSION_MARKER).write_text(f"{FLUTTER_VERSION}\n")
        github_path = self.root / "github-path"

        result = install_flutter(
            install_dir,
            self.root / "missing-cache",
            github_path=github_path,
        )

        self.assertEqual(result, sdk_path.resolve())
        self.assertEqual(github_path.read_text(), f"{sdk_path.resolve() / 'bin'}\n")

    def test_refuses_to_replace_unrecognized_install(self) -> None:
        install_dir = self.root / "sdk"
        (install_dir / "flutter").mkdir(parents=True)

        with self.assertRaisesRegex(InstallError, "refusing to replace"):
            install_flutter(install_dir, self.root / "missing-cache")


if __name__ == "__main__":
    unittest.main()
