import test from "node:test";
import assert from "node:assert/strict";
import {
  assertLifecycleTargetIsNotHost,
  assertNewSessionIdAvailable,
  COMMAND_LIMITS,
  CommandValidationError,
  dispatchClientCommand,
  isSessionCommand,
  parseClientCommand,
  resolveSessionTarget,
} from "../src/command-validation.ts";
import type { ClientCommandDispatcherDeps } from "../src/command-validation.ts";

function rejects(command: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseClientCommand(command),
    (error: unknown) => error instanceof CommandValidationError && pattern.test(error.message),
  );
}

test("every ClientCommand discriminant has a validated route shape", () => {
  const commands: unknown[] = [
    { type: "ping" },
    { type: "user_message", sessionId: "host-1", text: "hello", deliverAs: "steer" },
    { type: "cancel", sessionId: "host-1" },
    { type: "model_set", sessionId: "host-1", provider: "opencode-go", modelId: "glm-5.3-flash" },
    { type: "thinking_set", sessionId: "host-1", level: "default" },
    { type: "session_compact", sessionId: "host-1" },
    { type: "session_new", sessionId: "host-1" },
    { type: "session_spawn", sessionId: "child-1", cwd: "~/repo/project", name: null, model: null },
    { type: "session_despawn", sessionId: "child-1" },
    { type: "session_list" },
    { type: "session_resume", sessionId: "child-1" },
    { type: "session_rename", sessionId: "child-1", name: "project" },
    { type: "session_select", sessionId: "child-1" },
    { type: "session_delete", sessionId: "child-1", deleteHistory: true },
    { type: "list_models", sessionId: "child-1" },
    { type: "get_history", sessionId: "child-1", limit: 50, cursor: 0 },
    { type: "queue_clear", sessionId: "child-1" },
    { type: "queue_delete", sessionId: "child-1", text: "cancel this steer" },
    // Compatibility with the current app: spawn_dialog is correlation context,
    // not a session selector for this global command.
    { type: "list_paths", sessionId: "spawn_dialog", prefix: "~/repo", id: "request-1" },
    { type: "path_check", path: "~/repo", id: "request-2" },
    { type: "folder_create", path: "~/repo/new-folder", id: "request-3" },
    { type: "set_compact_threshold", thresholdTokens: 400_000 },
    { type: "reload" },
  ];

  assert.deepEqual(commands.map((command) => parseClientCommand(command).type), [
    "ping",
    "user_message",
    "cancel",
    "model_set",
    "thinking_set",
    "session_compact",
    "session_new",
    "session_spawn",
    "session_despawn",
    "session_list",
    "session_resume",
    "session_rename",
    "session_select",
    "session_delete",
    "list_models",
    "get_history",
    "queue_clear",
    "queue_delete",
    "list_paths",
    "path_check",
    "folder_create",
    "set_compact_threshold",
    "reload",
  ]);

  const spawn = parseClientCommand(commands[7]);
  assert.equal(spawn.type, "session_spawn");
  if (spawn.type === "session_spawn") {
    assert.equal(spawn.name, undefined);
    assert.equal(spawn.model, undefined);
  }
});

test("session_spawn treats empty or whitespace name and model as undefined", () => {
  const parsedEmpty = parseClientCommand({
    type: "session_spawn",
    cwd: "/tmp",
    name: "",
    model: "",
  });
  assert.equal(parsedEmpty.type, "session_spawn");
  if (parsedEmpty.type === "session_spawn") {
    assert.equal(parsedEmpty.name, undefined);
    assert.equal(parsedEmpty.model, undefined);
  }

  const parsedWhitespace = parseClientCommand({
    type: "session_spawn",
    cwd: "/tmp",
    name: "   ",
    model: "   ",
  });
  assert.equal(parsedWhitespace.type, "session_spawn");
  if (parsedWhitespace.type === "session_spawn") {
    assert.equal(parsedWhitespace.name, undefined);
    assert.equal(parsedWhitespace.model, undefined);
  }
});

test("non-objects, unknown commands, and unknown fields are rejected", () => {
  for (const input of [null, [], "user_message", 42]) {
    rejects(input, /command must be an object/);
  }
  rejects({}, /command type must be a string/);
  rejects({ type: "do_anything" }, /unsupported command type/);
  rejects({ type: "cancel", sessionId: "host", surprise: true }, /unknown field "surprise"/);
});

test("session, name, model, path, text, and enum fields are validated", () => {
  rejects({ type: "cancel", sessionId: "../host" }, /sessionId contains unsupported/);
  rejects({ type: "session_resume" }, /sessionId is required/);
  rejects({ type: "session_rename", sessionId: "s1", name: "   " }, /name cannot be empty/);
  rejects({ type: "model_set", provider: "", modelId: "m" }, /provider cannot be empty/);
  rejects({ type: "thinking_set", level: "extreme" }, /supported thinking level/);
  rejects({ type: "path_check", path: "x\0y" }, /control characters/);
  rejects({ type: "path_check", path: "界".repeat(2_000) }, /UTF-8 bytes/);
  rejects({ type: "user_message", text: "é".repeat(300_000) }, /UTF-8 bytes/);
  rejects({ type: "user_message", text: "hello", deliverAs: "later" }, /deliverAs/);
});

test("history pagination and compact threshold accept bounded safe integers only", () => {
  rejects({ type: "get_history", limit: 0 }, /limit must be between/);
  rejects(
    { type: "get_history", limit: COMMAND_LIMITS.historyPageItems + 1 },
    /limit must be between/,
  );
  rejects({ type: "get_history", limit: 1.5 }, /safe integer/);
  rejects({ type: "get_history", cursor: -1 }, /cursor must be between/);
  rejects({ type: "get_history", cursor: "0" }, /safe integer/);
  rejects({ type: "set_compact_threshold", thresholdTokens: 999 }, /thresholdTokens must be between/);
  rejects({ type: "set_compact_threshold", thresholdTokens: 1_000.5 }, /safe integer/);
});

test("images require known MIME, canonical base64, and bounded count and decoded sizes", () => {
  const image = (mimeType: string, data: string): unknown => ({ mimeType, data });
  const message = (images: unknown[]): unknown => ({ type: "user_message", text: "image", images });

  assert.equal(
    parseClientCommand(message([image("image/png", "AA==")])).type,
    "user_message",
  );
  rejects(message([image("image/svg+xml", "AA==")]), /mimeType is unsupported/);
  rejects(message([image("image/png", "not-base64")]), /valid base64|padded base64/);
  rejects({ type: "user_message", text: "image", images: "AA==" }, /images must be an array/);
  rejects(
    message(Array.from({ length: COMMAND_LIMITS.imageCount + 1 }, () => image("image/png", "AA=="))),
    /at most .* items/,
  );

  const tooLarge = Buffer.alloc(COMMAND_LIMITS.imageDecodedBytes + 1).toString("base64");
  rejects(message([image("image/png", tooLarge)]), /at most|decoded size limit/);

  const maxImage = Buffer.alloc(COMMAND_LIMITS.imageDecodedBytes).toString("base64");
  rejects(
    message([image("image/png", maxImage), image("image/jpeg", maxImage), image("image/gif", "AA==")]),
    /total decoded size limit/,
  );
  rejects(message([{ mimeType: "image/png", data: "AA==", extra: true }]), /unknown field "extra"/);
});

test("session routing never falls through unknown or stale IDs to the host", () => {
  const options = {
    hostSessionId: "host",
    isLiveSpawned: (id: string) => id === "live",
    isRegistered: (id: string) => id === "live" || id === "stale",
  };

  assert.deepEqual(resolveSessionTarget(undefined, options), { kind: "host" });
  assert.deepEqual(resolveSessionTarget("host", options), { kind: "host" });
  assert.deepEqual(resolveSessionTarget("live", options), { kind: "spawned", sessionId: "live" });
  assert.throws(() => resolveSessionTarget("stale", options), /not running; resume it first/);
  assert.throws(() => resolveSessionTarget("typo", options), /unknown session typo/);
});

test("only commands with session semantics enter the session router", () => {
  assert.equal(isSessionCommand(parseClientCommand({ type: "cancel" })), true);
  assert.equal(isSessionCommand(parseClientCommand({ type: "get_history" })), true);
  assert.equal(
    isSessionCommand(parseClientCommand({ type: "list_paths", sessionId: "spawn_dialog" })),
    false,
  );
  assert.equal(isSessionCommand(parseClientCommand({ type: "reload" })), false);
});

test("host lifecycle targets and duplicate spawn IDs are refused", () => {
  const lifecycleOptions = {
    hostSessionId: "host-live",
    isRegisteredHost: (id: string) => id === "host-registry",
  };
  assert.throws(
    () => assertLifecycleTargetIsNotHost("host-live", lifecycleOptions, "delete"),
    /cannot delete the host session/,
  );
  assert.throws(
    () => assertLifecycleTargetIsNotHost("host-registry", lifecycleOptions, "resume"),
    /cannot resume the host session/,
  );
  assert.doesNotThrow(() => assertLifecycleTargetIsNotHost("child", lifecycleOptions, "despawn"));

  const availability = {
    hostSessionId: "host-live",
    isInUse: (id: string) => id === "live-child" || id === "closed-row",
  };
  assert.throws(
    () => assertNewSessionIdAvailable("host-live", availability),
    /already in use/,
  );
  assert.throws(
    () => assertNewSessionIdAvailable("live-child", availability),
    /already in use/,
  );
  assert.throws(
    () => assertNewSessionIdAvailable("closed-row", availability),
    /already in use/,
  );
  assert.doesNotThrow(() => assertNewSessionIdAvailable("fresh", availability));
});

function dispatcherDeps(
  overrides: Partial<ClientCommandDispatcherDeps> = {},
): ClientCommandDispatcherDeps {
  return {
    hostSessionId: "host",
    isLiveSpawned: (id) => id === "live",
    isRegistered: (id) => id === "live" || id === "stale" || id === "host",
    isRegisteredHost: (id) => id === "host",
    isSessionIdInUse: (id) => id === "live" || id === "stale" || id === "host",
    newSessionId: () => "generated",
    host: () => undefined,
    spawned: () => undefined,
    spawn: () => undefined,
    despawn: () => undefined,
    sessionList: () => undefined,
    resume: () => undefined,
    rename: () => undefined,
    select: () => undefined,
    delete: () => undefined,
    pathCheck: () => undefined,
    folderCreate: () => undefined,
    compactThreshold: () => undefined,
    reload: () => undefined,
    ...overrides,
  };
}

test("dispatcher sends only exact host/live targets and rejects stale or unknown IDs", async () => {
  const events: string[] = [];
  const deps = dispatcherDeps({
    host: (command) => { events.push(`host:${command.type}`); },
    spawned: (command) => { events.push(`spawned:${command.sessionId}:${command.type}`); },
  });

  await dispatchClientCommand({ type: "cancel", sessionId: "host" }, deps);
  await dispatchClientCommand({ type: "cancel", sessionId: "live" }, deps);
  await assert.rejects(
    () => dispatchClientCommand({ type: "session_new", sessionId: "stale" }, deps),
    /not running/,
  );
  await assert.rejects(
    () => dispatchClientCommand({ type: "user_message", sessionId: "typo", text: "do not inject" }, deps),
    /unknown session/,
  );
  assert.deepEqual(events, ["host:cancel", "spawned:live:cancel"]);
});

test("dispatcher reserves a spawning ID across awaits and releases it afterward", async () => {
  let releaseFirst!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let spawnCalls = 0;
  const deps = dispatcherDeps({
    spawn: async () => {
      spawnCalls += 1;
      if (spawnCalls === 1) {
        markEntered();
        await blocked;
      }
    },
  });

  const first = dispatchClientCommand({ type: "session_spawn", sessionId: "race", cwd: "." }, deps);
  await entered;
  await assert.rejects(
    () => dispatchClientCommand({ type: "session_spawn", sessionId: "race", cwd: "." }, deps),
    /already in use/,
  );
  assert.equal(spawnCalls, 1, "the colliding command must not create an orphan session");
  releaseFirst();
  await first;
  await dispatchClientCommand({ type: "session_spawn", sessionId: "race", cwd: "." }, deps);
  assert.equal(spawnCalls, 2, "the reservation is released after spawn settles");
});

test("dispatcher reserves a durable ID across awaited resume", async () => {
  let releaseFirst!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let resumeCalls = 0;
  const deps = dispatcherDeps({
    resume: async () => {
      resumeCalls += 1;
      if (resumeCalls === 1) {
        markEntered();
        await blocked;
      }
    },
  });

  const first = dispatchClientCommand({ type: "session_resume", sessionId: "stale" }, deps);
  await entered;
  await assert.rejects(
    () => dispatchClientCommand({ type: "session_resume", sessionId: "stale" }, deps),
    /operation in progress/,
  );
  await assert.rejects(
    () => dispatchClientCommand({ type: "session_delete", sessionId: "stale" }, deps),
    /operation in progress/,
  );
  assert.equal(resumeCalls, 1, "the colliding request must not instantiate a second agent");
  releaseFirst();
  await first;
  await dispatchClientCommand({ type: "session_resume", sessionId: "stale" }, deps);
  assert.equal(resumeCalls, 2, "the reservation is released after resume settles");
});

test("dispatcher blocks host lifecycle commands before their handlers", async () => {
  const events: string[] = [];
  const deps = dispatcherDeps({
    resume: () => { events.push("resume"); },
    despawn: () => { events.push("despawn"); },
    delete: () => { events.push("delete"); },
  });
  for (const type of ["session_resume", "session_delete"] as const) {
    await assert.rejects(
      () => dispatchClientCommand({ type, sessionId: "host" }, deps),
      /host session/,
    );
  }
  await assert.rejects(
    () => dispatchClientCommand({ type: "session_spawn", sessionId: "host" }, deps),
    /already in use/,
  );
  await dispatchClientCommand({ type: "session_despawn", sessionId: "host" }, deps);
  assert.deepEqual(events, ["despawn"]);
});

test("rename and select preserve stale-row support but reject unknown IDs", async () => {
  const events: string[] = [];
  const deps = dispatcherDeps({
    rename: (command) => { events.push(`rename:${command.sessionId}`); },
    select: (command) => { events.push(`select:${command.sessionId}`); },
  });

  await dispatchClientCommand({ type: "session_rename", sessionId: "stale", name: "renamed" }, deps);
  await dispatchClientCommand({ type: "session_select", sessionId: "stale" }, deps);
  await assert.rejects(
    () => dispatchClientCommand({ type: "session_rename", sessionId: "unknown", name: "no" }, deps),
    /unknown session unknown/,
  );
  await assert.rejects(
    () => dispatchClientCommand({ type: "session_select", sessionId: "unknown" }, deps),
    /unknown session unknown/,
  );
  assert.deepEqual(events, ["rename:stale", "select:stale"]);
});
