import type { ClientCommand, UserImage } from "./protocol.ts";

export const COMMAND_LIMITS = {
  sessionIdCharacters: 128,
  commandIdCharacters: 128,
  nameCharacters: 200,
  modelFieldCharacters: 256,
  pathBytes: 4096,
  messageTextBytes: 512 * 1024,
  imageCount: 8,
  imageDecodedBytes: 10 * 1024 * 1024,
  imageTotalDecodedBytes: 10 * 1024 * 1024,
  historyPageItems: 200,
} as const;

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const THINKING_LEVELS = new Set([
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const SESSION_COMMAND_TYPES = new Set<ClientCommand["type"]>([
  "user_message",
  "cancel",
  "model_set",
  "thinking_set",
  "session_compact",
  "session_new",
  "list_models",
  "get_history",
  "queue_clear",
  "queue_delete",
  "session_tree_get",
  "session_tree_navigate",
]);

export class CommandValidationError extends Error {}

function fail(message: string): never {
  throw new CommandValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function commandObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) fail("command must be an object");
  return value;
}

function rejectUnknownFields(
  command: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(command).find((key) => !allowedFields.has(key));
  if (unknown) fail(`unknown field ${JSON.stringify(unknown)} for command ${JSON.stringify(command.type)}`);
}

function requiredString(
  command: Record<string, unknown>,
  field: string,
  options: { maxCharacters: number; allowEmpty?: boolean; trim?: boolean },
): string {
  const raw = command[field];
  if (typeof raw !== "string") fail(`${field} must be a string`);
  const value = options.trim ? raw.trim() : raw;
  if (!options.allowEmpty && value.length === 0) fail(`${field} cannot be empty`);
  if (value.length > options.maxCharacters) {
    fail(`${field} must be at most ${options.maxCharacters} characters`);
  }
  if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail(`${field} contains unsupported control characters`);
  }
  return value;
}

function optionalString(
  command: Record<string, unknown>,
  field: string,
  options: {
    maxCharacters: number;
    allowEmpty?: boolean;
    trim?: boolean;
    allowNull?: boolean;
    emptyAsUndefined?: boolean;
  },
): string | undefined {
  const raw = command[field];
  if (raw === undefined || (options.allowNull && raw === null)) return undefined;
  if (options.emptyAsUndefined && typeof raw === "string") {
    const trimmed = options.trim ? raw.trim() : raw;
    if (trimmed.length === 0) return undefined;
  }
  return requiredString(command, field, options);
}

function sessionId(command: Record<string, unknown>, required: boolean): string | undefined {
  const value = optionalString(command, "sessionId", {
    maxCharacters: COMMAND_LIMITS.sessionIdCharacters,
  });
  if (required && value === undefined) fail("sessionId is required");
  if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    fail("sessionId contains unsupported characters");
  }
  return value;
}

function commandId(command: Record<string, unknown>): string | undefined {
  return optionalString(command, "id", {
    maxCharacters: COMMAND_LIMITS.commandIdCharacters,
  });
}

function modelField(command: Record<string, unknown>, field: string): string {
  return requiredString(command, field, {
    maxCharacters: COMMAND_LIMITS.modelFieldCharacters,
    trim: true,
  });
}

function optionalModelField(command: Record<string, unknown>, field: string): string | undefined {
  return optionalString(command, field, {
    maxCharacters: COMMAND_LIMITS.modelFieldCharacters,
    trim: true,
    allowNull: true,
    emptyAsUndefined: true,
  });
}

function pathField(
  command: Record<string, unknown>,
  field: string,
  options: { required: boolean; allowEmpty?: boolean; allowNull?: boolean },
): string | undefined {
  const value = optionalString(command, field, {
    maxCharacters: COMMAND_LIMITS.pathBytes,
    allowEmpty: options.allowEmpty,
    trim: true,
    allowNull: options.allowNull,
  });
  if (options.required && value === undefined) fail(`${field} is required`);
  if (value !== undefined && Buffer.byteLength(value, "utf8") > COMMAND_LIMITS.pathBytes) {
    fail(`${field} must be at most ${COMMAND_LIMITS.pathBytes} UTF-8 bytes`);
  }
  return value;
}

function optionalBoolean(command: Record<string, unknown>, field: string): boolean | undefined {
  const value = command[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value;
}

function boundedInteger(
  command: Record<string, unknown>,
  field: string,
  options: { required?: boolean; min: number; max: number },
): number | undefined {
  const value = command[field];
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(`${field} must be a safe integer`);
  }
  if (value < options.min || value > options.max) {
    fail(`${field} must be between ${options.min} and ${options.max}`);
  }
  return value;
}

function decodedBase64Bytes(data: string): number {
  if (data.length === 0 || data.length % 4 !== 0) fail("image data must be padded base64");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const contentLength = data.length - padding;
  if (
    (padding === 2 && contentLength % 4 !== 2)
    || (padding === 1 && contentLength % 4 !== 3)
  ) {
    fail("image data must be valid base64");
  }
  // Avoid a single giant regexp: V8's regexp engine can overflow its stack on
  // an otherwise valid multi-megabyte image, turning validation into a DoS.
  for (let index = 0; index < contentLength; index += 1) {
    const code = data.charCodeAt(index);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) fail("image data must be valid base64");
  }
  return (data.length / 4) * 3 - padding;
}

function images(command: Record<string, unknown>): UserImage[] | undefined {
  const raw = command.images;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail("images must be an array");
  if (raw.length === 0) return [];
  if (raw.length > COMMAND_LIMITS.imageCount) {
    fail(`images must contain at most ${COMMAND_LIMITS.imageCount} items`);
  }

  let totalBytes = 0;
  return raw.map((item, index) => {
    if (!isPlainObject(item)) fail(`images[${index}] must be an object`);
    rejectUnknownFields(item, ["mimeType", "data"]);
    const mimeType = requiredString(item, "mimeType", { maxCharacters: 64, trim: true });
    if (!IMAGE_MIME_TYPES.has(mimeType)) {
      fail(`images[${index}].mimeType is unsupported`);
    }
    const data = requiredString(item, "data", {
      maxCharacters: Math.ceil(COMMAND_LIMITS.imageDecodedBytes / 3) * 4,
    });
    const decodedBytes = decodedBase64Bytes(data);
    if (decodedBytes > COMMAND_LIMITS.imageDecodedBytes) {
      fail(`images[${index}] exceeds the decoded size limit`);
    }
    totalBytes += decodedBytes;
    if (totalBytes > COMMAND_LIMITS.imageTotalDecodedBytes) {
      fail("images exceed the total decoded size limit");
    }
    return { mimeType, data };
  });
}

/** Parse the untrusted WebSocket payload into the one command shape the router accepts. */
export function parseClientCommand(input: unknown): ClientCommand {
  const command = commandObject(input);
  if (typeof command.type !== "string") fail("command type must be a string");

  switch (command.type) {
    case "ping":
      rejectUnknownFields(command, ["type"]);
      return { type: "ping" };
    case "user_message": {
      rejectUnknownFields(command, ["type", "sessionId", "text", "id", "images", "deliverAs"]);
      const text = requiredString(command, "text", {
        maxCharacters: COMMAND_LIMITS.messageTextBytes,
        allowEmpty: true,
      });
      if (Buffer.byteLength(text, "utf8") > COMMAND_LIMITS.messageTextBytes) {
        fail(`text must be at most ${COMMAND_LIMITS.messageTextBytes} UTF-8 bytes`);
      }
      const deliverAs = command.deliverAs;
      if (deliverAs !== undefined && deliverAs !== "steer" && deliverAs !== "followUp") {
        fail("deliverAs must be steer or followUp");
      }
      return {
        type: "user_message",
        sessionId: sessionId(command, false),
        text,
        id: commandId(command),
        images: images(command),
        deliverAs,
      };
    }
    case "cancel":
    case "session_compact":
    case "session_new":
    case "list_models":
    case "queue_clear": {
      rejectUnknownFields(command, ["type", "sessionId"]);
      return { type: command.type, sessionId: sessionId(command, false) };
    }
    case "queue_delete": {
      rejectUnknownFields(command, ["type", "sessionId", "text"]);
      const rawText = command.text;
      if (typeof rawText !== "string" || rawText.length === 0) {
        fail("command.text must be a non-empty string");
      }
      return {
        type: "queue_delete",
        sessionId: sessionId(command, false),
        text: rawText,
      };
    }
    case "session_tree_get": {
      rejectUnknownFields(command, ["type", "sessionId", "id"]);
      return {
        type: "session_tree_get",
        sessionId: sessionId(command, false),
        id: commandId(command),
      };
    }
    case "session_tree_navigate": {
      rejectUnknownFields(command, ["type", "sessionId", "entryId", "summarize", "id"]);
      const entryId = requiredString(command, "entryId", { maxCharacters: 128, trim: true });
      return {
        type: "session_tree_navigate",
        sessionId: sessionId(command, false),
        entryId,
        summarize: typeof command.summarize === "boolean" ? command.summarize : undefined,
        id: commandId(command),
      };
    }
    case "model_set":
      rejectUnknownFields(command, ["type", "sessionId", "provider", "modelId"]);
      return {
        type: "model_set",
        sessionId: sessionId(command, false),
        provider: modelField(command, "provider"),
        modelId: modelField(command, "modelId"),
      };
    case "thinking_set": {
      rejectUnknownFields(command, ["type", "sessionId", "level"]);
      const level = requiredString(command, "level", { maxCharacters: 16, trim: true });
      if (!THINKING_LEVELS.has(level)) fail("level is not a supported thinking level");
      return { type: "thinking_set", sessionId: sessionId(command, false), level };
    }
    case "session_spawn":
      rejectUnknownFields(command, ["type", "sessionId", "cwd", "name", "model"]);
      return {
        type: "session_spawn",
        sessionId: sessionId(command, false),
        cwd: pathField(command, "cwd", { required: false, allowNull: true }),
        name: optionalString(command, "name", {
          maxCharacters: COMMAND_LIMITS.nameCharacters,
          trim: true,
          allowNull: true,
          emptyAsUndefined: true,
        }),
        model: optionalModelField(command, "model"),
      };
    case "session_despawn":
    case "session_resume":
    case "session_select": {
      rejectUnknownFields(command, ["type", "sessionId"]);
      return { type: command.type, sessionId: sessionId(command, true)! };
    }
    case "session_rename":
      rejectUnknownFields(command, ["type", "sessionId", "name"]);
      return {
        type: "session_rename",
        sessionId: sessionId(command, true)!,
        name: requiredString(command, "name", {
          maxCharacters: COMMAND_LIMITS.nameCharacters,
          trim: true,
        }),
      };
    case "session_delete":
      rejectUnknownFields(command, ["type", "sessionId", "deleteHistory"]);
      return {
        type: "session_delete",
        sessionId: sessionId(command, true)!,
        deleteHistory: optionalBoolean(command, "deleteHistory"),
      };
    case "session_list":
      rejectUnknownFields(command, ["type"]);
      return { type: "session_list" };
    case "get_history":
      rejectUnknownFields(command, ["type", "sessionId", "limit", "cursor"]);
      return {
        type: "get_history",
        sessionId: sessionId(command, false),
        limit: boundedInteger(command, "limit", {
          min: 1,
          max: COMMAND_LIMITS.historyPageItems,
        }),
        cursor: boundedInteger(command, "cursor", {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        }),
      };
    case "list_paths":
      // The current app sends a spawn-dialog correlation sentinel in
      // sessionId. It is validated but deliberately does not select a session.
      rejectUnknownFields(command, ["type", "sessionId", "prefix", "id"]);
      return {
        type: "list_paths",
        sessionId: sessionId(command, false),
        prefix: pathField(command, "prefix", { required: false, allowEmpty: true }),
        id: commandId(command),
      };
    case "path_check":
    case "folder_create":
      rejectUnknownFields(command, ["type", "path", "id"]);
      return {
        type: command.type,
        path: pathField(command, "path", { required: true })!,
        id: commandId(command),
      };
    case "set_compact_threshold":
      rejectUnknownFields(command, ["type", "thresholdTokens"]);
      return {
        type: "set_compact_threshold",
        thresholdTokens: boundedInteger(command, "thresholdTokens", {
          required: true,
          min: 1_000,
          max: Number.MAX_SAFE_INTEGER,
        })!,
      };
    case "reload":
      rejectUnknownFields(command, ["type"]);
      return { type: "reload" };
    default:
      fail(`unsupported command type ${JSON.stringify(command.type)}`);
  }
}

export type SessionCommand = Extract<ClientCommand, {
  type:
    | "user_message"
    | "cancel"
    | "model_set"
    | "thinking_set"
    | "session_compact"
    | "session_new"
    | "list_models"
    | "get_history"
    | "queue_clear"
    | "queue_delete"
    | "session_tree_get"
    | "session_tree_navigate";
}>;

export function isSessionCommand(command: ClientCommand): command is SessionCommand {
  return SESSION_COMMAND_TYPES.has(command.type);
}

export type SessionTarget =
  | { kind: "host" }
  | { kind: "spawned"; sessionId: string };

/** Resolve a validated session command without ever treating an unknown ID as the host. */
export function resolveSessionTarget(
  sessionIdValue: string | undefined,
  options: {
    hostSessionId: string;
    isLiveSpawned: (sessionId: string) => boolean;
    isRegistered: (sessionId: string) => boolean;
  },
): SessionTarget {
  if (sessionIdValue === undefined || sessionIdValue === options.hostSessionId) {
    return { kind: "host" };
  }
  if (options.isLiveSpawned(sessionIdValue)) {
    return { kind: "spawned", sessionId: sessionIdValue };
  }
  if (options.isRegistered(sessionIdValue)) {
    fail(`session ${sessionIdValue} is not running; resume it first`);
  }
  fail(`unknown session ${sessionIdValue}`);
}

export type RoutedClientCommand =
  | { target: "global"; command: Exclude<ClientCommand, SessionCommand> }
  | { target: "host"; command: SessionCommand }
  | { target: "spawned"; command: SessionCommand & { sessionId: string } };

/** Validate once, then classify command ownership for the orchestration layer. */
export function parseCommandRoute(
  input: unknown,
  options: {
    hostSessionId: string;
    isLiveSpawned: (sessionId: string) => boolean;
    isRegistered: (sessionId: string) => boolean;
  },
): RoutedClientCommand {
  const command = parseClientCommand(input);
  if (!isSessionCommand(command)) return { target: "global", command };
  const target = resolveSessionTarget(command.sessionId, options);
  if (target.kind === "host") return { target: "host", command };
  return {
    target: "spawned",
    command: { ...command, sessionId: target.sessionId },
  };
}

export function assertLifecycleTargetIsNotHost(
  sessionIdValue: string,
  options: { hostSessionId: string; isRegisteredHost: (sessionId: string) => boolean },
  operation: string,
): void {
  if (
    operation !== "despawn"
    && (sessionIdValue === options.hostSessionId || options.isRegisteredHost(sessionIdValue))
  ) {
    fail(`cannot ${operation} the host session`);
  }
}

export function assertNewSessionIdAvailable(
  sessionIdValue: string,
  options: { hostSessionId: string; isInUse: (sessionId: string) => boolean },
): void {
  if (sessionIdValue === options.hostSessionId || options.isInUse(sessionIdValue)) {
    fail(`session ID ${sessionIdValue} is already in use`);
  }
}

export class SessionIdReservations {
  private readonly reserved = new Set<string>();

  assertIdle(sessionIdValue: string): void {
    if (this.reserved.has(sessionIdValue)) {
      fail(`session ${sessionIdValue} already has an operation in progress`);
    }
  }

  async runExclusive<T>(sessionIdValue: string, action: () => Promise<T>): Promise<T> {
    this.assertIdle(sessionIdValue);
    this.reserved.add(sessionIdValue);
    try {
      return await action();
    } finally {
      this.reserved.delete(sessionIdValue);
    }
  }

  async run<T>(
    sessionIdValue: string,
    options: { hostSessionId: string; isInUse: (sessionId: string) => boolean },
    action: () => Promise<T>,
  ): Promise<T> {
    assertNewSessionIdAvailable(sessionIdValue, {
      hostSessionId: options.hostSessionId,
      isInUse: (id) => this.reserved.has(id) || options.isInUse(id),
    });
    return this.runExclusive(sessionIdValue, action);
  }
}

const sessionIdReservations = new SessionIdReservations();

type GlobalCommand = Exclude<ClientCommand, SessionCommand>;

export interface ClientCommandDispatcherDeps {
  hostSessionId: string;
  isLiveSpawned: (sessionId: string) => boolean;
  isRegistered: (sessionId: string) => boolean;
  isRegisteredHost: (sessionId: string) => boolean;
  isSessionIdInUse: (sessionId: string) => boolean;
  newSessionId: () => string;
  host: (command: SessionCommand | Extract<ClientCommand, { type: "list_paths" }>) => void | Promise<void>;
  spawned: (command: SessionCommand & { sessionId: string }) => void | Promise<void>;
  spawn: (command: Extract<ClientCommand, { type: "session_spawn" }> & { sessionId: string }) => void | Promise<void>;
  despawn: (command: Extract<ClientCommand, { type: "session_despawn" }>) => void | Promise<void>;
  sessionList: () => void | Promise<void>;
  resume: (command: Extract<ClientCommand, { type: "session_resume" }>) => void | Promise<void>;
  rename: (command: Extract<ClientCommand, { type: "session_rename" }>) => void | Promise<void>;
  select: (command: Extract<ClientCommand, { type: "session_select" }>) => void | Promise<void>;
  delete: (command: Extract<ClientCommand, { type: "session_delete" }>) => void | Promise<void>;
  pathCheck: (command: Extract<ClientCommand, { type: "path_check" }>) => void | Promise<void>;
  folderCreate: (command: Extract<ClientCommand, { type: "folder_create" }>) => void | Promise<void>;
  compactThreshold: (command: Extract<ClientCommand, { type: "set_compact_threshold" }>) => void | Promise<void>;
  reload: () => void | Promise<void>;
}

/** Validate, authorize the target, reserve new IDs, and dispatch exactly once. */
export async function dispatchClientCommand(
  input: unknown,
  deps: ClientCommandDispatcherDeps,
): Promise<void> {
  const route = parseCommandRoute(input, deps);
  if (route.target === "spawned") {
    sessionIdReservations.assertIdle(route.command.sessionId);
    return void await deps.spawned(route.command);
  }
  if (route.target === "host") return void await deps.host(route.command);

  const command: GlobalCommand = route.command;
  switch (command.type) {
    case "session_spawn": {
      const sessionIdValue = command.sessionId ?? deps.newSessionId();
      await sessionIdReservations.run(sessionIdValue, {
        hostSessionId: deps.hostSessionId,
        isInUse: deps.isSessionIdInUse,
      }, () => Promise.resolve(deps.spawn({ ...command, sessionId: sessionIdValue })));
      return;
    }
    case "session_despawn":
    case "session_resume":
    case "session_delete": {
      assertLifecycleTargetIsNotHost(command.sessionId, deps, command.type.slice("session_".length));
      assertKnownSession(command.sessionId, deps);
      await sessionIdReservations.runExclusive(command.sessionId, async () => {
        if (command.type === "session_despawn") return void await deps.despawn(command);
        if (command.type === "session_resume") return void await deps.resume(command);
        return void await deps.delete(command);
      });
      return;
    }
    case "session_list": return void await deps.sessionList();
    case "session_rename":
      assertKnownSession(command.sessionId, deps);
      return void await sessionIdReservations.runExclusive(
        command.sessionId,
        () => Promise.resolve(deps.rename(command)),
      );
    case "session_select":
      assertKnownSession(command.sessionId, deps);
      return void await deps.select(command);
    case "path_check": return void await deps.pathCheck(command);
    case "folder_create": return void await deps.folderCreate(command);
    case "set_compact_threshold": return void await deps.compactThreshold(command);
    case "reload": return void await deps.reload();
    case "list_paths": return void await deps.host(command);
    case "ping": return;
  }
}

function assertKnownSession(
  sessionIdValue: string,
  deps: Pick<ClientCommandDispatcherDeps, "hostSessionId" | "isLiveSpawned" | "isRegistered">,
): void {
  if (
    sessionIdValue !== deps.hostSessionId
    && !deps.isLiveSpawned(sessionIdValue)
    && !deps.isRegistered(sessionIdValue)
  ) {
    fail(`unknown session ${sessionIdValue}`);
  }
}
