/**
 * Building the options a session is created with.
 *
 * One function, because the parts have to agree: the resource loader decides
 * which extensions and providers a session may see, the model runtime is built
 * from the same agent directory, and the tool set is assembled last so a
 * session's tools reflect the level it was born at. Assembled in two places,
 * a session spawned from a subagent and one resumed from disk drift apart in
 * exactly the ways that are hard to notice.
 */
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundProcessManager } from "./bash-tool.ts";
import { createAutoBackgroundBashTool } from "./bash-tool.ts";
import { createBackgroundTools } from "./background-tools.ts";
import { contextBudgetExtension } from "./context-budget.ts";
import { imageBudgetExtension } from "./image-budget.ts";
import { isPinestExtension } from "./session-identity.ts";
import { MAX_SUBAGENT_LEVEL } from "./subagent.ts";

export interface SessionOptionsInput {
  cwd: string;
  agentDir: string;
  /** Reopening an existing pi session rather than starting one. */
  sessionManager?: SessionManager;
  /** Present when a background-process manager is available; without it a
   * session gets no shell tooling at all. */
  bgManager?: BackgroundProcessManager;
  /** Depth in the subagent tree (1 = not a subagent). */
  level?: number;
  /** The `subagent` tool set for this build, or none at the tree's last level. */
  subagentTools: () => unknown[];
  /** The image cap these sessions run under, read per call so a settings
   * change is not frozen into the options a session was born with. */
  maxImageBytes: () => number;
}

export async function buildSessionOptions(input: SessionOptionsInput): Promise<{
  cwd: string; agentDir?: string; sessionManager?: SessionManager;
  resourceLoader?: unknown; modelRuntime?: unknown; customTools?: unknown[];
}> {
  const { cwd, agentDir } = input;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // Spawned sessions deliberately exclude pinest itself, so the image cap
    // travels as its own inline extension or these sessions would be the ones
    // a too-large screenshot could still poison (413 on every later request).
    // The context-budget statement rides along for the same reason: spawned
    // sessions are where agents invented a budget and stopped.
    extensionFactories: [imageBudgetExtension(input.maxImageBytes), contextBudgetExtension()],
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((ext) => !isPinestExtension(ext.path, ext.resolvedPath)),
    }),
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const extRes = resourceLoader.getExtensions();
  for (const { name, config } of extRes.runtime.pendingProviderRegistrations) {
    try { modelRuntime.registerProvider(name, config); } catch { /* */ }
  }
  for (const { provider } of extRes.runtime.pendingNativeProviderRegistrations) {
    try { modelRuntime.registerNativeProvider(provider); } catch { /* */ }
  }
  await modelRuntime.refresh({ allowNetwork: false });
  const opts: {
    cwd: string; agentDir?: string; sessionManager?: SessionManager; resourceLoader?: unknown;
    modelRuntime?: unknown; customTools?: unknown[];
  } = { cwd, resourceLoader, modelRuntime };
  opts.agentDir = agentDir;
  if (input.sessionManager) opts.sessionManager = input.sessionManager;
  if (input.bgManager) {
    opts.customTools = [
      createAutoBackgroundBashTool({ bgManager: input.bgManager, cwd }),
      ...createBackgroundTools(input.bgManager),
    ];
  }
  // A session at the LAST level of the tree is given no `subagent` tool at all,
  // so the depth rule holds for a session that never asks; the service refuses
  // it again by name, for a definition that predates the rule.
  if ((input.level ?? 1) < MAX_SUBAGENT_LEVEL) {
    opts.customTools = [...(opts.customTools ?? []), ...input.subagentTools()];
  }
  return opts;
}
