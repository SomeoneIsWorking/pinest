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
