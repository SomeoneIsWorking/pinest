#!/usr/bin/env python3
"""Regression tests for the owned APK workflow's security boundaries."""

from __future__ import annotations

from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ElementTree

from install_flutter import FLUTTER_ARCHIVE_SHA256
from verify_apk import EXPECTED_CERT_SHA256, EXPECTED_PACKAGE


WORKFLOW_PATH = Path(__file__).resolve().parents[2] / ".github/workflows/apk.yml"
ANDROID_ROOT = Path(__file__).resolve().parents[1] / "android"
GRADLE_PROPERTIES_PATH = ANDROID_ROOT / "gradle.properties"
VERIFICATION_METADATA_PATH = ANDROID_ROOT / "gradle/verification-metadata.xml"
PINNED_ACTION = re.compile(
    r"^\s+(?:-\s+)?uses:\s+[^@\s]+@[0-9a-f]{40}\s+#\s+v\d[^\s]*\s*$",
)
EXPECTED_JOBS = (
    "validate",
    "build_unsigned",
    "sign",
    "verify",
    "attest",
    "publish",
)
RELEASE_CONDITION_PARTS = (
    "github.event_name != 'pull_request'",
    "github.ref == 'refs/heads/main'",
)


def parse_job_blocks(source: str) -> dict[str, str]:
    """Parse top-level job blocks from this workflow's owned YAML shape."""
    lines = source.splitlines()
    try:
        jobs_line = lines.index("jobs:")
    except ValueError:
        return {}

    starts: list[tuple[str, int]] = []
    for index, line in enumerate(lines[jobs_line + 1 :], start=jobs_line + 1):
        match = re.fullmatch(r"  ([a-z][a-z0-9_]*):", line)
        if match:
            starts.append((match.group(1), index))

    blocks: dict[str, str] = {}
    for position, (name, start) in enumerate(starts):
        end = starts[position + 1][1] if position + 1 < len(starts) else len(lines)
        blocks[name] = "\n".join(lines[start:end])
    return blocks


def parse_action_blocks(source: str) -> list[str]:
    """Parse each step-level action invocation and its indented inputs."""
    lines = source.splitlines()
    blocks: list[str] = []
    for index, line in enumerate(lines):
        if not re.match(r"^\s*-\s+(?:id:\s+\S+\s+)?uses:", line):
            continue
        indent = len(line) - len(line.lstrip())
        end = index + 1
        while end < len(lines):
            candidate = lines[end]
            if candidate.strip() and len(candidate) - len(candidate.lstrip()) <= indent:
                break
            end += 1
        blocks.append("\n".join(lines[index:end]))
    return blocks


def parsed_job_permissions(block: str) -> dict[str, str] | None:
    if re.search(r"^    permissions:\s*{}\s*$", block, re.MULTILINE):
        return {}
    match = re.search(r"^    permissions:\s*\n((?:^      [a-z-]+:\s+\w+\s*$\n?)+)", block, re.MULTILINE)
    if not match:
        return None
    permissions: dict[str, str] = {}
    for name, value in re.findall(r"^      ([a-z-]+):\s+(\w+)\s*$", match.group(1), re.MULTILINE):
        permissions[name] = value
    return permissions


def workflow_policy_violations(source: str) -> list[str]:
    findings: list[str] = []
    jobs = parse_job_blocks(source)
    actions = parse_action_blocks(source)

    if not re.search(r"^permissions:\s*{}\s*$", source, re.MULTILINE):
        findings.append("top-level permissions must deny all access")
    if not re.search(r"^  cancel-in-progress:\s+false\s*$", source, re.MULTILINE):
        findings.append("release publication must never be cancelled mid-flight")
    if tuple(jobs) != EXPECTED_JOBS:
        findings.append("workflow must define the six ordered trust-boundary jobs")

    expected_permissions = {
        "validate": {"contents": "read"},
        "build_unsigned": {"contents": "read"},
        "sign": {},
        "verify": {"contents": "read"},
        "attest": {"attestations": "write", "contents": "read", "id-token": "write"},
        "publish": {"contents": "write"},
    }
    for name, permissions in expected_permissions.items():
        if parsed_job_permissions(jobs.get(name, "")) != permissions:
            findings.append(f"{name} permissions must be exactly {permissions}")

    action_lines = [line for line in source.splitlines() if re.match(r"^\s+(?:-\s+)?uses:", line)]
    for line in action_lines:
        if not PINNED_ACTION.fullmatch(line):
            findings.append(f"mutable or uncommented action reference: {line.strip()}")
    for block in actions:
        first_line = block.splitlines()[0]
        if "uses: actions/checkout@" in first_line and "persist-credentials: false" not in block:
            findings.append("checkout must not persist job credentials")
    if "subosito/flutter-action" in source:
        findings.append("workflow must use the checksum-pinned repo-owned Flutter installer")
    if source.count("python3 tools/install_flutter.py") != 4:
        findings.append("both read-only build jobs must read and install the authoritative Flutter pin")
    if "steps.flutter-pin.outputs.archive_sha256" not in source:
        findings.append("workflow cache must consume the installer-owned Flutter checksum")
    if FLUTTER_ARCHIVE_SHA256 in source:
        findings.append("workflow must not duplicate the installer-owned Flutter checksum")
    if EXPECTED_PACKAGE in source or EXPECTED_CERT_SHA256 in source.lower():
        findings.append("workflow must consume rather than duplicate the release identity")

    validate = jobs.get("validate", "")
    if "secrets." in validate or "flutter build apk --release" in validate:
        findings.append("validate must remain read-only and release-free")
    if "github.event_name == 'pull_request'" not in validate or "flutter build apk --debug" not in validate:
        findings.append("pull requests must compile only a debug APK")

    for name in EXPECTED_JOBS[1:]:
        for part in RELEASE_CONDITION_PARTS:
            if part not in jobs.get(name, ""):
                findings.append(f"{name} must exclude PRs and require main")

    build_unsigned = jobs.get("build_unsigned", "")
    if "ORG_GRADLE_PROJECT_pinestUnsignedRelease: 'true'" not in build_unsigned:
        findings.append("unsigned build must opt into the fail-closed Gradle mode")
    if "apksigner\" verify release/pinest-unsigned.apk" not in build_unsigned:
        findings.append("unsigned build must prove the APK has no valid signature")

    sign = jobs.get("sign", "")
    sign_code = "\n".join(line for line in sign.splitlines() if not line.lstrip().startswith("#"))
    if (
        "actions/checkout@" in sign_code
        or "app/tools/" in sign_code
        or "flutter " in sign_code
        or "gradle" in sign_code.lower()
    ):
        findings.append("sign must execute no checkout, build tool, or repository code")
    secret_lines = [line for line in sign.splitlines() if "secrets." in line]
    if len(secret_lines) != 4 or "name: Sign aligned APK" not in sign:
        findings.append("all four signing secrets must be confined to the apksigner step")
    if "environment: apk-release" not in sign:
        findings.append("sign must be bound to the protected apk-release environment")
    if "name: Destroy signing material" not in sign:
        findings.append("sign must destroy key material before artifact upload")

    verify = jobs.get("verify", "")
    if "app/tools/verify_apk.py" not in verify or "--write-provenance" not in verify:
        findings.append("read-only verify must check identity and record provenance")
    if "cp app/release-identity.json release/pinest.release-identity.json" not in verify:
        findings.append("verify must transfer the authoritative release identity")
    if "sha256sum pinest.apk > pinest.apk.sha256" not in verify:
        findings.append("verify must create the published APK SHA-256 file")

    attest = jobs.get("attest", "")
    if "actions/attest-build-provenance@" not in attest:
        findings.append("attest must cryptographically attest the verified APK")
    if "gh attestation verify" not in attest or "--bundle release/pinest.apk.attestation.jsonl" not in attest:
        findings.append("attest must verify and transfer its signed bundle")
    if "release/pinest.release-identity.json" not in attest:
        findings.append("attest must cover the authoritative release identity")

    publish = jobs.get("publish", "")
    if "actions/checkout@" in publish or "app/tools/" in publish:
        findings.append("write-enabled publish must execute no repository code")
    if "sha256sum --check pinest.apk.sha256" not in publish:
        findings.append("publish must re-check the APK payload digest")
    if "expected exactly one APK signer" not in publish or "unexpected APK package" not in publish:
        findings.append("publish must re-check package and sole signer")
    if "pinest.release-identity.json" not in publish or "release package disagrees" not in publish:
        findings.append("publish must bind the APK to the attested release identity")
    if "gh attestation verify" not in publish:
        findings.append("publish must re-check signed provenance")
    if "git push" in publish or "--clobber" in publish or "apk-latest" in publish:
        findings.append("publish must not move or overwrite a release")
    if "gh release view" in publish:
        findings.append("publish must not treat every release lookup failure as absence")
    if 'existing_release_id="$(' not in publish or "gh api --paginate" not in publish:
        findings.append("publish must fail closed while checking the release tag")
    explicit_release_repository = (
        'gh release create "$release_tag" \\\n            --repo "$GITHUB_REPOSITORY"',
        'gh release edit "$release_tag" \\\n            --repo "$GITHUB_REPOSITORY"',
    )
    if not all(command in publish for command in explicit_release_repository):
        findings.append("no-checkout release commands must name the repository explicitly")
    if 'release_tag="apk-$GITHUB_SHA"' not in publish or "--draft" not in publish or "--latest" not in publish:
        findings.append("publish must create a unique per-commit release before marking it latest")
    if "current_main=" not in publish or 'current_main" != "$GITHUB_SHA' not in publish:
        findings.append("publish must refuse a stale manual or queued build")
    token_lines = [line for line in publish.splitlines() if "github.token" in line]
    if len(token_lines) != 1 or "name: Publish immutable per-commit release" not in publish:
        findings.append("contents write token must be confined to the publication step")

    for name in EXPECTED_JOBS[1:]:
        block = jobs.get(name, "")
        if "actions/download-artifact@" in block:
            if "artifact-ids:" not in block or "digest-mismatch: error" not in block:
                findings.append(f"{name} must download by immutable ID and fail on digest mismatch")
        if name != "build_unsigned" and "artifact-digest" not in block:
            findings.append(f"{name} must consume or expose the preceding archive digest")

    return findings


class ApkWorkflowPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = WORKFLOW_PATH.read_text(encoding="utf-8")

    def assert_policy_rejects(self, mutated: str, expected: str) -> None:
        self.assertIn(expected, "\n".join(workflow_policy_violations(mutated)))

    def test_current_workflow_satisfies_release_policy(self) -> None:
        self.assertEqual(workflow_policy_violations(self.source), [])

    def test_gradle_dependency_verification_is_strict_and_complete(self) -> None:
        properties = GRADLE_PROPERTIES_PATH.read_text(encoding="utf-8")
        self.assertRegex(
            properties,
            r"(?m)^org[.]gradle[.]dependency[.]verification=strict$",
        )

        root = ElementTree.parse(VERIFICATION_METADATA_PATH).getroot()
        namespace = {"v": "https://schema.gradle.org/dependency-verification"}
        self.assertEqual(root.findtext("v:configuration/v:verify-metadata", namespaces=namespace), "true")
        checksums = [
            element.attrib.get("value", "")
            for element in root.findall("v:components/v:component/v:artifact/v:sha256", namespace)
        ]
        self.assertGreater(len(checksums), 100)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}", value) for value in checksums))

    def test_android_build_does_not_disable_dependency_verification(self) -> None:
        forbidden = (
            "disableDependencyVerification",
            "dependency.verification=lenient",
            "dependency.verification=off",
            "--dependency-verification lenient",
            "--dependency-verification off",
        )
        sources = [WORKFLOW_PATH]
        sources.extend(
            path
            for path in ANDROID_ROOT.rglob("*")
            if path.is_file() and path.suffix in {".gradle", ".kts", ".properties"}
        )
        combined = "\n".join(path.read_text(encoding="utf-8") for path in sources)
        for value in forbidden:
            self.assertNotIn(value, combined)

    def test_rejects_mutable_action_reference(self) -> None:
        mutated = re.sub(r"actions/checkout@[0-9a-f]{40}", "actions/checkout@v7", self.source, count=1)
        self.assert_policy_rejects(mutated, "mutable or uncommented action reference")

    def test_rejects_overbroad_permissions(self) -> None:
        mutated = self.source.replace("permissions: {}", "permissions:\n  contents: write", 1)
        self.assert_policy_rejects(mutated, "top-level permissions")

    def test_rejects_persisted_checkout_credentials(self) -> None:
        mutated = self.source.replace("persist-credentials: false", "persist-credentials: true", 1)
        self.assert_policy_rejects(mutated, "checkout must not persist")

    def test_rejects_cancellable_publication(self) -> None:
        mutated = self.source.replace("cancel-in-progress: false", "cancel-in-progress: true", 1)
        self.assert_policy_rejects(mutated, "never be cancelled")

    def test_rejects_missing_digest_verification(self) -> None:
        mutated = self.source.replace("digest-mismatch: error", "digest-mismatch: warn", 1)
        self.assert_policy_rejects(mutated, "fail on digest mismatch")

    def test_rejects_release_overwrite(self) -> None:
        mutated = self.source.replace("--draft", "--clobber", 1)
        self.assert_policy_rejects(mutated, "must not move or overwrite")

    def test_rejects_static_release_tag(self) -> None:
        mutated = self.source.replace('release_tag="apk-$GITHUB_SHA"', 'release_tag="apk-latest"', 1)
        self.assert_policy_rejects(mutated, "must not move or overwrite")

    def test_rejects_ambiguous_release_lookup_failure(self) -> None:
        mutated = self.source.replace("gh api --paginate", "gh release view", 1)
        self.assert_policy_rejects(mutated, "every release lookup failure as absence")

    def test_rejects_no_checkout_release_without_explicit_repository(self) -> None:
        command = (
            'gh release create "$release_tag" \\\n            --repo "$GITHUB_REPOSITORY"'
        )
        mutated = self.source.replace(command, 'gh release create "$release_tag" \\', 1)
        self.assert_policy_rejects(mutated, "name the repository explicitly")

    def test_rejects_manual_release_without_main_gate(self) -> None:
        mutated = self.source.replace("github.ref == 'refs/heads/main'", "github.ref != ''", 1)
        self.assert_policy_rejects(mutated, "exclude PRs and require main")

    def test_rejects_sign_job_checkout(self) -> None:
        marker = "    steps:\n      - uses: actions/download-artifact@"
        mutated = self.source.replace(marker, "    steps:\n      - uses: actions/checkout@" + "a" * 40 + " # v7\n      - uses: actions/download-artifact@", 1)
        self.assert_policy_rejects(mutated, "sign must execute no checkout")


if __name__ == "__main__":
    unittest.main()
