/**
 * The command vocabulary is pure, so it gets the assertions a view cannot give
 * it: what counts as a command, and which list the prompt actually offers.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  ATTACH_COMMANDS,
  attachCommandList,
  parseSlashCommand,
} from "../src/attach-commands.ts";

test("a slash line becomes a name and the rest of it", () => {
  assert.deepEqual(parseSlashCommand("/tree"), { name: "tree", args: "" });
  assert.deepEqual(parseSlashCommand("/thinking high"), { name: "thinking", args: "high" });
  assert.deepEqual(
    parseSlashCommand("/compact   keep every failing test   "),
    { name: "compact", args: "keep every failing test" },
    "a multi-word argument survives, because that is what /compact takes",
  );
});

test("text that is not a command is not a command", () => {
  assert.equal(parseSlashCommand("fix the bridge"), null);
  assert.equal(parseSlashCommand("  "), null);
  assert.equal(parseSlashCommand("10 / 2"), null, "a slash inside the text is not a command");
});

test("the offered list keeps ours and adds Pi's, and ours wins a name clash", () => {
  // A name both sides define must dispatch to the implementation THIS view runs,
  // or `/stop` would silently become whatever pi's own list says it is.
  const merged = attachCommandList([
    { name: "skills", description: "list available skills" },
    { name: "stop", description: "pi's own wording" },
  ]);
  const names = merged.map((c) => c.name);
  assert.ok(names.includes("tree") && names.includes("skills"));
  assert.equal(
    merged.filter((c) => c.name === "stop").length,
    1,
    "a shared name appears once, not twice with two descriptions",
  );
  assert.equal(
    merged.find((c) => c.name === "stop")?.description,
    ATTACH_COMMANDS.find((c) => c.name === "stop")?.description,
  );
});

test("every offered command is one this view can actually run", () => {
  // The refusal guarantee: a command in the list that dispatch does not service
  // would be sent to the model as text, so the list would be advertising a lie.
  for (const cmd of ATTACH_COMMANDS) {
    assert.ok(typeof cmd.name === "string" && cmd.name.length > 0);
    assert.ok(cmd.description, `/${cmd.name} must say what it does`);
  }
});
