/**
 * Redirect the user-config path to a throwaway file, for tests that touch the
 * config directly or transitively.
 *
 * Import this FIRST: `config.ts` resolves its path once, at module load, and
 * ESM evaluates static imports before the importing module's own statements —
 * so assigning `RC_CONFIG_PATH` anywhere further down the file is too late and
 * the test writes the user's real settings. That is exactly how the user's
 * auto-compact threshold was being reset to the default on every test run.
 */
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./tmp.ts";

if (!process.env.RC_CONFIG_PATH) {
  const dir = makeTempDir("rc-config-");
  process.env.RC_CONFIG_PATH = join(dir, "config.json");
  process.on("exit", () => removeTempDir(dir));
}
