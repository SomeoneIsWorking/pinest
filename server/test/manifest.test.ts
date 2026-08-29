// Tests the package MANIFEST — the thing pi's loader actually reads to discover
// the extension. This is what was missing (we had npm "main" but no "pi"
// manifest, so pi never loaded the extension → no /pinest command).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));

test("package.json declares a 'pi.extensions' manifest", () => {
  assert.ok(pkg.pi, "package.json must have a 'pi' field");
  assert.ok(Array.isArray(pkg.pi.extensions), "pi.extensions must be an array");
  assert.ok(pkg.pi.extensions.length > 0, "pi.extensions must declare at least one entry");
});

test("every declared extension entry file exists", () => {
  for (const entry of pkg.pi?.extensions ?? []) {
    const p = resolve(ROOT, entry);
    assert.ok(existsSync(p), `declared entry '${entry}' not found at ${p}`);
  }
});

test("every declared extension entry loads and exports an ExtensionFactory", async () => {
  for (const entry of pkg.pi?.extensions ?? []) {
    const p = resolve(ROOT, entry);
    const mod = await import(pathToFileURL(p).href + "?t=" + Date.now());
    assert.equal(typeof mod.default, "function", `'${entry}' default export must be a factory function`);
  }
});

test("pi would discover this package: manifest OR root index.js", () => {
  // Mirrors resolveExtensionEntries() in pi's loader.
  const hasManifest = pkg.pi?.extensions?.length > 0;
  const hasRootIndex = existsSync(resolve(ROOT, "index.js")) || existsSync(resolve(ROOT, "index.ts"));
  assert.ok(hasManifest || hasRootIndex, "pi cannot discover this extension — add a 'pi' manifest or a root index.js");
});
