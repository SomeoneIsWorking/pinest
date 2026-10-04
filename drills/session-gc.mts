/**
 * One-off maintenance drill: delete every registry session the running host
 * still lists that is NOT this host's own interactive session.
 *
 * Stale rows accumulate because nothing marks a row closed when the process
 * that owned it dies (no startup reconciliation), so the app shows sessions
 * that no longer exist. Deleting them goes through the real client command
 * path (`session_delete` on the authenticated local-agent socket), so the live
 * host performs the removal instead of the registry file being hand-edited
 * under a process that owns it in memory.
 *
 * Dry run by default; `--apply` performs the deletions. Session HISTORY is
 * kept (`deleteHistory` is not set): the pi JSONL stays on disk and resumable.
 *
 * Usage: node --experimental-strip-types drills/session-gc.mts [--apply]
 */
import { LocalAgentClient } from "../server/src/local-agent-client.ts";

const apply = process.argv.includes("--apply");
const client = await LocalAgentClient.connect();
const sessions = client.sessions();
const host = sessions.filter((s) => s.isHost);
if (host.length !== 1) {
  console.error(`refusing: expected exactly 1 host session, found ${host.length}`);
  client.close();
  process.exit(1);
}
const hostId = host[0]!.id;
const stale = sessions.filter((s) => s.id !== hostId);
console.log(`${sessions.length} listed, ${stale.length} stale, host ${hostId}`);
for (const s of stale) {
  console.log(`  ${s.id}  ${s.status.padEnd(7)}  ${s.model ?? "?"}  ${s.cwd ?? "?"}  ${s.name ?? "(unnamed)"}`);
}
if (!apply) {
  console.log("dry run; pass --apply to delete these rows (history kept)");
  client.close();
  process.exit(0);
}

let removed = 0;
const refused: string[] = [];
for (const s of stale) {
  const answer = client.next(
    (frame) => (frame.type === "session_deleted" && frame.sessionId === s.id)
      || (frame.type === "error" && frame.sessionId === s.id),
    15_000,
  );
  client.send({ type: "session_delete", sessionId: s.id });
  const frame = await answer;
  if (frame.type === "error") {
    refused.push(`${s.id}: ${frame.message}`);
    continue;
  }
  if (frame.deleted) removed += 1;
}
await client.untilState(() => client.sessions().length === 1, 15_000).catch(() => {});
console.log(`removed ${removed}, refused ${refused.length}, now listed: ${client.sessions().length}`);
for (const line of refused) console.log(`  refused ${line}`);
client.close();
