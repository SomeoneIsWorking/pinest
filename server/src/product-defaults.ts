/** Product defaults shared by runtime configuration and provisioning. */

/** The only model target provisioned and selected by default. */
export const DEFAULT_MODEL = "opencode-go/glm-5.3-flash";

/** Start compacting the 1M-context target at roughly 400k tokens. */
export const DEFAULT_COMPACT_AT_TOKENS = 400_000;
