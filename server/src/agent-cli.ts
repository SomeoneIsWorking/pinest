#!/usr/bin/env node
/**
 * `pinest-agent`: drive the host's sessions from another agent on this machine.
 *
 * Every agent is one session in the host's single pi process, so a fan-out of
 * ten agents costs one process, not ten. Sessions are named `agent:<NAME>`;
 * they appear in the app like any other session.
 *
 *   node server/src/agent-cli.ts spawn NAME --cwd DIR [--model P/ID] (--brief FILE | --message TEXT)
 *   node server/src/agent-cli.ts send NAME TEXT [--follow-up]
 *   node server/src/agent-cli.ts status [NAME]
 *   node server/src/agent-cli.ts tail NAME [-n N]
 *   node server/src/agent-cli.ts wait NAME [--timeout SECONDS]
 *   node server/src/agent-cli.ts cancel NAME
 *   node server/src/agent-cli.ts stop NAME
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { LocalAgentClient } from "./local-agent-client.ts";
import type { ClientCommand, HistoryItem, SessionSnapshot } from "./protocol.ts";

const AGENT_PREFIX = "agent:";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SPAWN_TIMEOUT_MS = 60_000;
const TEXT_PREVIEW_CHARS = 600;

function sessionIdOf(name: string | undefined): string {
  if (!name || !NAME_PATTERN.test(name)) throw new Error(`invalid agent name: ${JSON.stringify(name)}`);
  return `${AGENT_PREFIX}${name}`;
}

function isBusy(session: SessionSnapshot | undefined): boolean {
  return !!session && (session.status === "working" || (session.pendingMessages?.length ?? 0) > 0);
}

function describe(session: SessionSnapshot): string {
  const pending = session.pendingMessages?.length ?? 0;
  return [
    session.id.slice(AGENT_PREFIX.length).padEnd(24),
    session.status.padEnd(8),
    (session.model ?? "-").padEnd(28),
    pending ? `${pending} queued ` : "",
    session.cwd ?? "",
  ].join(" ");
}

function printItem(item: HistoryItem): void {
  if (item.text.trim()) console.log(`[${item.role}] ${item.text.trim()}`);
  for (const tool of item.tools) {
    const args = JSON.stringify(tool.args ?? {});
    console.log(`  - ${tool.name}${tool.isError ? " (error)" : ""} ${args.slice(0, 160)}`);
    const result = (tool.result ?? "").split("\n").slice(0, 3).join("\n    ");
    if (result.trim()) console.log(`    ${result}`);
  }
}

async function spawn(client: LocalAgentClient, id: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { cwd: { type: "string" }, model: { type: "string" }, brief: { type: "string" }, message: { type: "string" } },
  });
  if (!values.cwd) throw new Error("spawn needs --cwd DIR");
  if (!!values.brief === !!values.message) throw new Error("spawn needs exactly one of --brief FILE or --message TEXT");
  if (client.session(id)) throw new Error(`${id} is already running; stop it first`);
  const text = values.brief ? readFileSync(values.brief, "utf8") : values.message!;
  client.send({
    type: "session_spawn",
    sessionId: id,
    cwd: resolve(values.cwd),
    name: id,
    ...(values.model ? { model: values.model } : {}),
  } as ClientCommand);
  await client.untilState(() => !!client.session(id), SPAWN_TIMEOUT_MS);
  client.send({ type: "user_message", sessionId: id, text } as ClientCommand);
  console.log(`spawned ${id} in ${resolve(values.cwd)}`);
}

async function send(client: LocalAgentClient, id: string, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "follow-up": { type: "boolean" } } });
  const text = positionals.join(" ").trim();
  if (!text) throw new Error("send needs TEXT");
  const session = client.session(id);
  if (!session) throw new Error(`${id} is not running`);
  const deliverAs = !isBusy(session) ? undefined : values["follow-up"] ? "followUp" : "steer";
  client.send({ type: "user_message", sessionId: id, text, ...(deliverAs ? { deliverAs } : {}) } as ClientCommand);
  console.log(`${id}: sent as ${deliverAs ?? "prompt"}`);
}

async function status(client: LocalAgentClient, id: string | undefined): Promise<void> {
  const agents = client.sessions().filter((session) => session.id.startsWith(AGENT_PREFIX));
  const shown = id ? agents.filter((session) => session.id === id) : agents;
  if (id && shown.length === 0) throw new Error(`${id} is not running`);
  for (const session of shown) console.log(describe(session));
  if (!id) {
    console.log(`${agents.length} agent session(s) of ${client.sessions().length} on this host`);
    return;
  }
  const history = await client.history(id, 4);
  const last = [...history].reverse().find((item) => item.role === "assistant");
  const tools = history.flatMap((item) => item.tools).slice(-3);
  for (const tool of tools) console.log(`tool  ${tool.name} ${JSON.stringify(tool.args ?? {}).slice(0, 140)}`);
  if (last?.text.trim()) console.log(`last  ${last.text.trim().slice(0, TEXT_PREVIEW_CHARS)}`);
}

async function tail(client: LocalAgentClient, id: string, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { n: { type: "string", short: "n" } } });
  const count = Number(values.n ?? "10");
  if (!Number.isInteger(count) || count < 1) throw new Error("-n takes a positive integer");
  for (const item of await client.history(id, count)) printItem(item);
}

async function wait(client: LocalAgentClient, id: string, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { timeout: { type: "string" } } });
  const timeoutMs = values.timeout ? Number(values.timeout) * 1000 : undefined;
  if (!client.session(id)) throw new Error(`${id} is not running`);
  try {
    await client.untilState(() => !isBusy(client.session(id)), timeoutMs);
  } catch {
    console.log(`${id}: still working after ${values.timeout} s`);
    return 2;
  }
  const last = [...await client.history(id, 3)].reverse().find((item) => item.role === "assistant");
  console.log(last?.text.trim() || `${id}: idle`);
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const [command, name, ...rest] = argv;
  const client = await LocalAgentClient.connect();
  try {
    if (command === "status") {
      await status(client, name ? sessionIdOf(name) : undefined);
      return 0;
    }
    const id = sessionIdOf(name);
    switch (command) {
      case "spawn": await spawn(client, id, rest); return 0;
      case "send": await send(client, id, rest); return 0;
      case "tail": await tail(client, id, rest); return 0;
      case "wait": return await wait(client, id, rest);
      case "cancel":
        client.send({ type: "cancel", sessionId: id } as ClientCommand);
        console.log(`${id}: cancel sent`);
        return 0;
      case "stop":
        client.send({ type: "cancel", sessionId: id } as ClientCommand);
        client.send({ type: "session_despawn", sessionId: id } as ClientCommand);
        await client.untilState(() => !client.session(id), 30_000);
        console.log(`${id}: stopped`);
        return 0;
      default:
        throw new Error(`unknown command ${JSON.stringify(command)} (spawn, send, status, tail, wait, cancel, stop)`);
    }
  } finally {
    client.close();
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`pinest-agent: ${(error as Error).message}`);
    process.exit(1);
  },
);
