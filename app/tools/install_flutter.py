#!/usr/bin/env python3
"""Install the repository-pinned Flutter SDK for Linux CI."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile
from typing import BinaryIO, Callable
from urllib.request import urlopen


FLUTTER_VERSION = "3.44.5"
FLUTTER_ARCHIVE_NAME = f"flutter_linux_{FLUTTER_VERSION}-stable.tar.xz"
FLUTTER_ARCHIVE_URL = (
    "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/"
    f"{FLUTTER_ARCHIVE_NAME}"
)
FLUTTER_ARCHIVE_SHA256 = "28aa13854feb9de44a317b97c4e886ea3f0af744027418b7e63885cfcd2951f3"
FLUTTER_ARCHIVE_ROOT = "flutter"
VERSION_MARKER = ".pinest-flutter-version"
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ARCHIVE_CACHE = REPOSITORY_ROOT / "scratch" / "cache" / FLUTTER_ARCHIVE_NAME

OpenUrl = Callable[[str], BinaryIO]


class InstallError(RuntimeError):
    """The pinned Flutter SDK could not be installed safely."""


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_archive(path: Path, expected_sha256: str = FLUTTER_ARCHIVE_SHA256) -> None:
    actual_sha256 = file_sha256(path)
    if actual_sha256 != expected_sha256:
        raise InstallError(
            f"Flutter archive checksum mismatch for {path}: "
            f"expected {expected_sha256}, found {actual_sha256}",
        )


def download_archive(
    destination: Path,
    *,
    archive_url: str = FLUTTER_ARCHIVE_URL,
    expected_sha256: str = FLUTTER_ARCHIVE_SHA256,
    open_url: OpenUrl = urlopen,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{destination.name}.",
            suffix=".download",
            dir=destination.parent,
            delete=False,
        ) as output_file:
            temporary_path = Path(output_file.name)
            with open_url(archive_url) as response:
                shutil.copyfileobj(response, output_file)
            output_file.flush()
            os.fsync(output_file.fileno())

        verify_archive(temporary_path, expected_sha256)
        os.replace(temporary_path, destination)
        temporary_path = None
    except InstallError:
        raise
    except Exception as error:
        raise InstallError(f"failed to download Flutter archive from {archive_url}: {error}") from error
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def prepare_archive(
    cache_path: Path,
    *,
    expected_sha256: str = FLUTTER_ARCHIVE_SHA256,
    open_url: OpenUrl = urlopen,
) -> None:
    if cache_path.exists():
        if not cache_path.is_file():
            raise InstallError(f"Flutter archive cache is not a file: {cache_path}")
        verify_archive(cache_path, expected_sha256)
        return

    download_archive(
        cache_path,
        expected_sha256=expected_sha256,
        open_url=open_url,
    )


def _normalized_archive_path(path: PurePosixPath) -> PurePosixPath:
    parts: list[str] = []
    for part in path.parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                raise InstallError(f"archive path escapes its root: {path}")
            parts.pop()
            continue
        parts.append(part)
    return PurePosixPath(*parts)


def _require_flutter_path(path: str, *, description: str) -> PurePosixPath:
    if "\\" in path:
        raise InstallError(f"{description} contains a backslash: {path!r}")
    archive_path = PurePosixPath(path)
    if archive_path.is_absolute():
        raise InstallError(f"{description} is absolute: {path!r}")
    normalized = _normalized_archive_path(archive_path)
    if not normalized.parts or normalized.parts[0] != FLUTTER_ARCHIVE_ROOT:
        raise InstallError(
            f"{description} must remain under {FLUTTER_ARCHIVE_ROOT}/: {path!r}",
        )
    return normalized


def validate_archive_member(member: tarfile.TarInfo) -> None:
    member_path = _require_flutter_path(member.name, description="archive member")
    if member.ischr() or member.isblk() or member.isfifo():
        raise InstallError(f"archive contains a special file: {member.name!r}")

    if not (member.issym() or member.islnk()):
        return

    link_path = PurePosixPath(member.linkname)
    if link_path.is_absolute():
        raise InstallError(f"archive link target is absolute: {member.linkname!r}")
    if member.issym():
        link_path = member_path.parent / link_path
    _require_flutter_path(str(link_path), description="archive link target")


def safe_extract_archive(archive_path: Path, destination: Path) -> None:
    data_filter = getattr(tarfile, "data_filter", None)
    if data_filter is None:
        raise InstallError("safe Flutter extraction requires Python 3.12 or a patched Python 3.11")

    try:
        with tarfile.open(archive_path, mode="r:xz") as archive:
            members = archive.getmembers()
            for member in members:
                validate_archive_member(member)

            def extraction_filter(member: tarfile.TarInfo, target: str) -> tarfile.TarInfo | None:
                try:
                    return data_filter(member, target)
                except tarfile.FilterError as error:
                    raise InstallError(f"unsafe archive member {member.name!r}: {error}") from error

            archive.extractall(destination, members=members, filter=extraction_filter)
    except InstallError:
        raise
    except (tarfile.TarError, OSError) as error:
        raise InstallError(f"failed to extract Flutter archive {archive_path}: {error}") from error


def _is_complete_install(sdk_path: Path) -> bool:
    marker = sdk_path / VERSION_MARKER
    executable = sdk_path / "bin" / "flutter"
    try:
        return marker.read_text(encoding="utf-8").strip() == FLUTTER_VERSION and executable.is_file()
    except FileNotFoundError:
        return False


def publish_github_path(sdk_path: Path, github_path: Path | None) -> None:
    if github_path is None:
        return
    with github_path.open("a", encoding="utf-8") as output_file:
        output_file.write(f"{sdk_path / 'bin'}\n")


def emit_github_metadata(output_path: Path) -> None:
    with output_path.open("a", encoding="utf-8") as output_file:
        output_file.write(f"version={FLUTTER_VERSION}\n")
        output_file.write(f"archive_name={FLUTTER_ARCHIVE_NAME}\n")
        output_file.write(f"archive_sha256={FLUTTER_ARCHIVE_SHA256}\n")


def install_flutter(
    install_dir: Path,
    archive_cache: Path,
    *,
    github_path: Path | None = None,
    expected_sha256: str = FLUTTER_ARCHIVE_SHA256,
    open_url: OpenUrl = urlopen,
) -> Path:
    install_dir = install_dir.resolve()
    archive_cache = archive_cache.resolve()
    sdk_path = install_dir / FLUTTER_ARCHIVE_ROOT

    if _is_complete_install(sdk_path):
        publish_github_path(sdk_path, github_path)
        return sdk_path
    if sdk_path.exists():
        raise InstallError(
            f"refusing to replace an unrecognized Flutter installation at {sdk_path}",
        )

    prepare_archive(
        archive_cache,
        expected_sha256=expected_sha256,
        open_url=open_url,
    )
    install_dir.mkdir(parents=True, exist_ok=True)

    staging_path = Path(
        tempfile.mkdtemp(
            prefix=f".{FLUTTER_ARCHIVE_ROOT}-extract-",
            dir=install_dir,
        ),
    )
    try:
        safe_extract_archive(archive_cache, staging_path)
        staged_sdk = staging_path / FLUTTER_ARCHIVE_ROOT
        flutter_executable = staged_sdk / "bin" / "flutter"
        if not flutter_executable.is_file():
            raise InstallError(
                f"Flutter archive did not contain {FLUTTER_ARCHIVE_ROOT}/bin/flutter",
            )
        (staged_sdk / VERSION_MARKER).write_text(f"{FLUTTER_VERSION}\n", encoding="utf-8")
        staged_sdk.rename(sdk_path)
    finally:
        if staging_path.exists():
            shutil.rmtree(staging_path)

    publish_github_path(sdk_path, github_path)
    return sdk_path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--install-dir",
        type=Path,
        help="parent directory in which the pinned flutter/ SDK is installed",
    )
    parser.add_argument(
        "--archive-cache",
        type=Path,
        default=DEFAULT_ARCHIVE_CACHE,
        help=f"exact archive file cache path (default: {DEFAULT_ARCHIVE_CACHE})",
    )
    parser.add_argument(
        "--github-path",
        type=Path,
        help="GitHub Actions path-output file (defaults to GITHUB_PATH when set)",
    )
    parser.add_argument(
        "--emit-github-metadata",
        type=Path,
        help="write the pinned version, archive name, and SHA-256 as GitHub step outputs",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.emit_github_metadata:
        if args.install_dir:
            raise InstallError("--emit-github-metadata cannot be combined with --install-dir")
        emit_github_metadata(args.emit_github_metadata)
        return 0
    if args.install_dir is None:
        raise InstallError("--install-dir is required unless --emit-github-metadata is used")

    github_path = args.github_path
    if github_path is None and os.environ.get("GITHUB_PATH"):
        github_path = Path(os.environ["GITHUB_PATH"])

    sdk_path = install_flutter(
        args.install_dir,
        args.archive_cache,
        github_path=github_path,
    )
    print(f"flutter_version={FLUTTER_VERSION}")
    print(f"flutter_sdk={sdk_path}")
    print(f"flutter_archive={args.archive_cache.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except InstallError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
