// Test temp dirs live under the repo's gitignored scratch/ — never /tmp
// (RAM-backed tmpfs with a small quota on this machine).
//
// Lives in server/support/ (NOT test/) because node's default test discovery
// runs every .js file under any test/ directory.
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH_TMP = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "scratch", "tmp");

/** Create a unique temp dir under <repo>/scratch/tmp/. Returns its path. */
export function makeTempDir(prefix: string): string {
  mkdirSync(SCRATCH_TMP, { recursive: true });
  return mkdtempSync(join(SCRATCH_TMP, prefix));
}

/** Remove a temp dir made by makeTempDir (force, best-effort). */
export function removeTempDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
