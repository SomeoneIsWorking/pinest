/**
 * Provision the machine for remote-code:
 *   - settings.json: compaction (auto-compact ≈400k on the 1M GLM window)
 *     and defaultModel = opencode-go/glm-5.3-flash
 *   - verify: the model resolves in pi's registry and auth is configured
 *
 * Idempotent: running twice reports "already provisioned". Existing settings
 * are merged (unknown fields preserved). Never touches auth stores.
 *
 * Run: node --experimental-strip-types scripts/provision.ts
 * (plain `node scripts/provision.ts` on Node >= 23.6 / 24)
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { buildSettingsPatch, DEFAULT_MODEL } from "../src/provision-core.ts";

const AGENT_DIR = process.env.RC_AGENT_DIR || join(homedir(), ".pi", "agent");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`error: ${path} is not valid JSON — fix or remove it first`);
    process.exit(1);
  }
}

function atomicWrite(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

// ── settings.json ───────────────────────────────────────────────────────────
const existing = readJson(SETTINGS_PATH);
const { patch, changes, replaced } = buildSettingsPatch(existing);

if (changes.length === 0) {
  console.log(`settings.json: already provisioned (${SETTINGS_PATH})`);
} else {
  for (const c of changes) console.log(`settings.json: ${c}`);
  for (const [k, v] of Object.entries(replaced)) {
    console.log(`  (replaced ${k}: ${JSON.stringify(v)})`);
  }
  atomicWrite(SETTINGS_PATH, { ...existing, ...patch });
  console.log(`settings.json written: ${SETTINGS_PATH}`);
}

// ── verify model + auth ─────────────────────────────────────────────────────
const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
const runtime = await ModelRuntime.create({
  authPath: join(AGENT_DIR, "auth.json"),
  modelsPath: join(AGENT_DIR, "models.json"),
});
const reg = new ModelRegistry(runtime);
await reg.refresh().catch(() => undefined);
const slash = DEFAULT_MODEL.indexOf("/");
const model = reg.find(DEFAULT_MODEL.slice(0, slash), DEFAULT_MODEL.slice(slash + 1));

if (!model) {
  console.error(`error: ${DEFAULT_MODEL} not found in pi's registry — is the network available (models.dev)?`);
  process.exit(1);
}
console.log(`model ok: ${DEFAULT_MODEL} (context ${model.contextWindow?.toLocaleString()})`);

if (!reg.hasConfiguredAuth(model)) {
  console.error(`error: no API key for provider "${model.provider}" — run \`pi\` then /login ${model.provider}, or install the key in ${join(AGENT_DIR, "auth.json")}`);
  process.exit(1);
}
console.log(`auth ok for ${model.provider}`);
console.log("provisioned.");
