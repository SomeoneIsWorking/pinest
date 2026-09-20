import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionModelService } from "../src/session-models.ts";
import { listModels } from "../src/pi-context-queries.ts";

test("SessionModelService.list includes active session model even if missing from available snapshot", async () => {
  const currentModel = {
    id: "union-alpha",
    name: "Union Alpha Free",
    provider: "opencode-go",
    reasoning: true,
    input: ["text", "image"],
  };

  const fakeSession = {
    model: currentModel,
    modelRuntime: {
      refresh: async () => {},
      getAvailable: async () => [
        { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "opencode-go", reasoning: true },
      ],
      getAvailableSnapshot: () => [
        { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "opencode-go", reasoning: true },
      ],
    },
  };

  const svc = new SessionModelService();
  const models = await svc.list({ session: fakeSession });

  assert.ok(models.some((m) => m.id === "union-alpha" && m.provider === "opencode-go"));
  assert.ok(models.some((m) => m.id === "glm-5.3-flash" && m.provider === "opencode-go"));
  // Active model should be first
  assert.equal(models[0].id, "union-alpha");
});

test("SessionModelService.find finds active session model even if missing from available snapshot", async () => {
  const currentModel = {
    id: "union-alpha",
    name: "Union Alpha Free",
    provider: "opencode-go",
    reasoning: true,
  };

  const fakeSession = {
    model: currentModel,
    modelRuntime: {
      refresh: async () => {},
      getAvailable: async () => [],
      getAvailableSnapshot: () => [],
    },
  };

  const svc = new SessionModelService();
  const found = await svc.find("opencode-go/union-alpha", [{ session: fakeSession }]);
  assert.deepEqual(found, currentModel);

  const foundByName = await svc.find("Union Alpha Free", [{ session: fakeSession }]);
  assert.deepEqual(foundByName, currentModel);
});

test("SessionModelService.find refreshes runtime if model is not in initial snapshot", async () => {
  let refreshed = false;
  const newModel = {
    id: "union-alpha",
    name: "Union Alpha Free",
    provider: "opencode-go",
    reasoning: true,
  };

  const fakeSession = {
    model: null,
    modelRuntime: {
      refresh: async () => {
        refreshed = true;
      },
      getAvailable: async () => (refreshed ? [newModel] : []),
      getAvailableSnapshot: () => (refreshed ? [newModel] : []),
    },
  };

  const svc = new SessionModelService();
  const found = await svc.find("opencode-go/union-alpha", [{ session: fakeSession }]);
  assert.ok(refreshed, "refresh should have been called");
  assert.deepEqual(found, newModel);
});

test("listModels includes active session model even if missing from available snapshot", async () => {
  const currentModel = {
    id: "union-alpha",
    name: "Union Alpha Free",
    provider: "opencode-go",
    reasoning: true,
    input: ["text", "image"],
  };

  const ctx = {
    session: {
      model: currentModel,
      modelRuntime: {
        refresh: async () => {},
        getAvailable: async () => [
          { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "opencode-go" },
        ],
        getAvailableSnapshot: () => [
          { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "opencode-go" },
        ],
      },
    },
  };

  const models = await listModels(ctx);
  assert.ok(models.some((m) => m.id === "union-alpha" && m.provider === "opencode-go"));
  assert.equal(models[0].id, "union-alpha");
});

test("SessionModelService.set switches model and verifies", async () => {
  let setModelArg: any = null;
  const targetModel = {
    id: "union-alpha",
    name: "Union Alpha Free",
    provider: "opencode-go",
  };

  const fakeSession = {
    model: null as any,
    setModel: async (m: any) => {
      setModelArg = m;
      fakeSession.model = m;
    },
    thinkingLevel: "high",
    modelRuntime: {
      refresh: async () => {},
      getAvailable: async () => [targetModel],
      getAvailableSnapshot: () => [targetModel],
    },
  };

  const svc = new SessionModelService();
  const res = await svc.set(
    { session: fakeSession },
    { provider: "opencode-go", modelId: "union-alpha" },
    [{ session: fakeSession }],
  );

  assert.equal(res.model, "opencode-go/union-alpha");
  assert.equal(res.modelName, "Union Alpha Free");
  assert.deepEqual(setModelArg, targetModel);
});
