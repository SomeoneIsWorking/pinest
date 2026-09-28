/** Putting a session on a model, and on a thinking level.
 *
 * The rule under test is that asking is not getting. pi applies a model and a
 * reasoning level itself, and silently declines the ones it cannot honour, so
 * every path here reads the result back rather than reporting the request. Two
 * live defects came out of that: a subagent looked for its parent's model
 * anywhere except the session that had to run it, found nothing, and quietly
 * stayed on the default; and a run published "high" for a session holding
 * "off". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionModelService } from "../src/session-models.ts";

/** A model as pi hands it to a session. */
const model = (provider: string, id: string, extra: Record<string, unknown> = {}) => ({
  provider, id, name: `${id} name`, ...extra,
});

/**
 * A session that knows some models. `modelRuntime` is what pi exposes to a
 * live session: the models it can be PUT ON, which for a provider registered by
 * an extension are not the ones in models.json and not the ones in any
 * process-wide registry.
 *
 * The fake is deliberately awkward about both of pi's real behaviours, because
 * both are the bugs this suite is for: a model switch only counts if the session
 * ends up ON it, and a level only counts if the session holds it — pi applies
 * both itself and silently declines what the model cannot do (measured on a
 * real session: asked for `high` on a model with no thinkingLevelMap, it
 * settled for `off`).
 */
function sessionWith(available: any[], current = available[0]) {
  const held = { model: current, level: "off" as any };
  // The session's own model and level are GETTERS over the state pi holds, the
  // way AgentSession reports them — which is why every read back here goes
  // through the session and never through what the caller asked for.
  const session: any = Object.defineProperties({} as any, {
    model: {
      get: () => held.model,
      set: (m: any) => { held.model = m; },
      configurable: true,
      enumerable: true,
    },
    thinkingLevel: {
      get: () => held.level,
      set: (l: any) => { held.level = l; },
      configurable: true,
      enumerable: true,
    },
  });
  session.modelRuntime = {
    getAvailableSnapshot: () => available,
    getAvailable: async () => available,
    refresh: async () => undefined,
  };
  session.setModel = async (m: any) => { session.model = m; };
  session.setThinkingLevel = (level: any) => {
    const map = held.model?.thinkingLevelMap;
    session.thinkingLevel = map && level in map ? level : "off";
  };
  return {
    // The view's own fields are plain data, as a live session's are; the SESSION
    // is where the truth lives, and every read back goes through it.
    view: {
      session,
      model: current ? `${current.provider}/${current.id}` : null,
      modelName: current?.name ?? null,
    },
    held: () => held.model,
  };
}

test("a model the session's own runtime knows is found and applied", async () => {
  const s = sessionWith([model("ext", "hidden")]);
  const service = new SessionModelService("/nonexistent-agent-dir");

  const applied = await service.applyModelTo(s.view, "ext/hidden", true, []);

  assert.equal(s.held()?.id, "hidden");
  assert.equal(applied.model, "ext/hidden");
  assert.equal(applied.modelWarning, undefined, "nothing to warn about when it took");
});

test("a model the session cannot be given produces a warning, not a quiet default", async () => {
  const s = sessionWith([model("ext", "other")]);
  const service = new SessionModelService("/nonexistent-agent-dir");

  const applied = await service.applyModelTo(s.view, "ext/ghost", true, []);

  assert.equal(applied.model, undefined, "nothing was applied");
  assert.match(applied.modelWarning ?? "", /could not use the parent's model ext\/ghost/);
  assert.match(applied.modelWarning ?? "", /ran on ext\/other instead/,
    "and it says what it ran on, so the result is not mistaken for a clean one");
});

test("a switch that lands on a different model than requested is reported", async () => {
  const s = sessionWith([model("ext", "asked")]);
  // A runtime that accepts the call but resolves it to something else: the read
  // back is the only thing that catches this.
  (s.view.session as any).setModel = async () => { (s.view.session as any).model = model("ext", "other"); };
  const service = new SessionModelService("/nonexistent-agent-dir");

  const applied = await service.applyModelTo(s.view, "ext/asked", true, []);

  assert.match(applied.modelWarning ?? "", /was requested but the session holds ext\/other/);
});

test("an ordinary spawn is told a model and is not nagged about it", async () => {
  const s = sessionWith([model("ext", "other")]);
  const service = new SessionModelService("/nonexistent-agent-dir");

  // A user's "spawn on model X" is a request, not an inheritance: the old
  // best-effort behaviour is kept for it.
  const applied = await service.applyModelTo(s.view, "ext/ghost", false, []);

  assert.deepEqual(applied, {}, "no warning about a spawn the user asked for");
});

test("the reported thinking level is the one the session HOLDS", async () => {
  const s = sessionWith([model("ext", "plain")]);
  const service = new SessionModelService("/nonexistent-agent-dir");

  // No thinkingLevelMap: pi has no 'high' for this model, and settles for off —
  // which the app's rule reports as "default", because off means "omit the
  // reasoning param" on such a model.
  const applied = service.applyThinkingTo(s.view, "high");

  assert.equal(applied.thinkingLevel, "default", "the truth, not the request");
  assert.match(applied.thinkingWarning ?? "", /no 'high' reasoning level/);
  assert.equal(s.view.thinkingLevel, "default", "and the view carries the truth");
});

test("a thinking level the model CAN do is applied, with no warning", async () => {
  const s = sessionWith([
    model("ext", "reasoner", { thinkingLevelMap: { off: null, low: "low", high: "high" } }),
  ]);
  const service = new SessionModelService("/nonexistent-agent-dir");

  const applied = service.applyThinkingTo(s.view, "high");

  assert.equal(applied.thinkingLevel, "high");
  assert.equal(applied.thinkingWarning, undefined);
});

test("inheritance reports the model and the level as one story", async () => {
  const s = sessionWith([model("ext", "plain")]);
  const service = new SessionModelService("/nonexistent-agent-dir");

  const warnings = await service.inheritFrom(
    s.view, { model: "ext/ghost", thinking: "high" }, true, [],
  );

  // Both steps failed to take, and the caller gets ONE sentence covering both
  // rather than learning about them one turn at a time.
  assert.match(warnings.modelWarning ?? "", /could not use the parent's model/);
  assert.match(warnings.modelWarning ?? "", /no 'high' reasoning level/);
});

test("inheriting cleanly says nothing", async () => {
  const s = sessionWith([
    model("ext", "reasoner", { thinkingLevelMap: { off: null, low: "low", high: "high" } }),
  ]);
  const service = new SessionModelService("/nonexistent-agent-dir");

  const warnings = await service.inheritFrom(s.view, { model: "ext/reasoner", thinking: "high" }, true, []);

  assert.deepEqual(warnings, {});
  assert.equal(s.view.thinkingLevel, "high");
});
