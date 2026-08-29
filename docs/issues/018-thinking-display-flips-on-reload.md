# I-018 — "Default" thinking level keeps reverting to "off" in the app

## Symptom

User sets thinking to "Default"; the app's `/thinking` label keeps flipping
back to "off" (purple highlight lost) although the session's actual level
never changed.

## Root cause

`server/src/index.ts` bootstrap() re-registered the host session with the RAW
pi level:

```ts
const initThinking = (_ctx as any)?.getThinkingLevel?.() ?? "off";
```

Two defects in one line: `ExtensionContext` has no `getThinkingLevel()` (the
level lives on `_ctx.thinkingLevel` — `currentHostThinkingLevel()` reads it
correctly), so the fallback made it `"off"` unconditionally; and the raw level
skips `reportThinkingLevel()`, which maps pi's `off` → `default` on
omit-capable models (GLM's `off` is null on the wire). Every extension hot
reload re-ran bootstrap, flipping the app display from `default` to `off`.

## Fix

`const initThinking = reportThinkingLevel(initModel, currentHostThinkingLevel());`
— same mapping as `thinking_set` and the host `model_set` path.

## Verification

- `npm test` (161) and `npm run typecheck` — pass.
- Live: set Default, touch an extension file (hot reload), label stays Default.
