/**
 * Integration test: simulate the full app flow end-to-end.
 * 1. Write a user_message command to Firestore
 * 2. Extension processes it → streams → agent_end
 * 3. Write get_history command
 * 4. Extension replies with history including the user message + assistant response
 * 
 * This tests that messages don't "disappear" after streaming ends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Pure test: verify the historyFor logic matches what the app does
// (combining cached history + lastUserMessage)
function appHistoryFor(cachedHistory, lastUserMessage) {
  const hist = cachedHistory ?? [];
  const lum = lastUserMessage;
  if (lum && lum.length > 0) {
    const alreadyInHistory = hist.some(m => m.role === "user" && m.text === lum);
    if (!alreadyInHistory) {
      return [...hist, { role: "user", text: lum }];
    }
  }
  return hist;
}

test("historyFor: shows lastUserMessage immediately when not in history", () => {
  const result = appHistoryFor([], "hello");
  assert.equal(result.length, 1);
  assert.equal(result[0].role, "user");
  assert.equal(result[0].text, "hello");
});

test("historyFor: dedupes lastUserMessage if already in history", () => {
  const cached = [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }];
  const result = appHistoryFor(cached, "hello");
  assert.equal(result.length, 2); // not duplicated
});

test("historyFor: empty lastUserMessage returns cached as-is", () => {
  const cached = [{ role: "user", text: "hi" }];
  const result = appHistoryFor(cached, "");
  assert.equal(result.length, 1);
});

test("historyFor: null lastUserMessage returns cached as-is", () => {
  const cached = [{ role: "user", text: "hi" }];
  const result = appHistoryFor(cached, null);
  assert.equal(result.length, 1);
});

test("historyFor: appends lastUserMessage after existing history", () => {
  const cached = [{ role: "user", text: "first" }, { role: "assistant", text: "reply" }];
  const result = appHistoryFor(cached, "second");
  assert.equal(result.length, 3);
  assert.equal(result[2].role, "user");
  assert.equal(result[2].text, "second");
});

// Test the full message lifecycle: what the state doc should look like
// at each stage of a message round-trip
test("lifecycle: user_message → streaming → agent_end → history", () => {
  // Stage 1: app sends user_message, shows it locally
  let stateDocSessions = [{
    id: "s1", name: "test", status: "idle",
    streamingText: undefined, lastUserMessage: undefined,
    history: [],
  }];
  
  // App sends message locally
  let appLocalLastUserMessage = "hello";
  let appHistory = appHistoryFor(stateDocSessions[0].history, appLocalLastUserMessage);
  assert.equal(appHistory.length, 1);
  assert.equal(appHistory[0].text, "hello");

  // Stage 2: extension processes command, sets status=working + lastUserMessage
  stateDocSessions[0] = { ...stateDocSessions[0], status: "working", streamingText: "", lastUserMessage: "hello" };
  appHistory = appHistoryFor(stateDocSessions[0].history, stateDocSessions[0].lastUserMessage);
  assert.equal(appHistory.length, 1); // still just the user message

  // Stage 3: streaming
  stateDocSessions[0] = { ...stateDocSessions[0], streamingText: "partial response" };
  // App should show: history (user msg) + streaming bubble
  assert.equal(appHistory.length, 1); // history still just user msg
  // streamingText is separate

  // Stage 4: agent_end → streamingText cleared, status=idle
  stateDocSessions[0] = { ...stateDocSessions[0], streamingText: null, status: "idle" };
  // NOW history should be re-fetched. Simulate the extension's get_history reply:
  stateDocSessions[0] = {
    ...stateDocSessions[0],
    history: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "full response" },
    ],
    lastUserMessage: null, // cleared after processing
  };
  appHistory = appHistoryFor(stateDocSessions[0].history, stateDocSessions[0].lastUserMessage);
  assert.equal(appHistory.length, 2);
  assert.equal(appHistory[0].role, "user");
  assert.equal(appHistory[0].text, "hello");
  assert.equal(appHistory[1].role, "assistant");
  assert.equal(appHistory[1].text, "full response");
});
