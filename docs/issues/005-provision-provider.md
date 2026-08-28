# I-005 — Provision OpenCode Go provider + compact settings

`server/scripts/provision.js` writes/merges (idempotent, no clobber of other
providers):

- `<PI_AGENT_DIR>/models.json` → provider `opencode-go`:
  `baseUrl: https://opencode.ai/zen/go/v1`, `api: openai-completions`,
  `apiKey: $OPENCODE_API_KEY`, model `glm-5.3-flash` (reasoning, input
  text+image, contextWindow 1000000, maxTokens 131072, cost per models.dev).
- `<PI_AGENT_DIR>/settings.json` → `compaction: { enabled: true,
  reserveTokens: 600000, keepRecentTokens: 20000 }` (≈400k trigger on the 1M
  window), `defaultModel: opencode-go/glm-5.3-flash` if unset.

Key source: `$OPENCODE_API_KEY` env, else instruct pi `/login` with provider
`opencode-go`. Never write the key value itself into any tracked file.

Acceptance: script runs twice producing identical output (idempotent), refuses
to overwrite an existing differing provider entry without `--force`.

Affected state items: S5.

**Update (this session):** provider keys are installed in the machine's pi
auth store (OpenRouter + opencode-go, `type: "api_key"` — pi rejects the
opencode-style `"type": "api"`). Real-LLM integration tests pass against a
free OpenRouter model via `RC_TEST_MODEL`; provision.ts (models.json +
settings defaults) still open.
