/** Product defaults shared by runtime configuration and provisioning. */

export const DEFAULT_PROVIDER = "opencode-go";
export const DEFAULT_MODEL_ID = "glm-5.3-flash";

/** The only model target provisioned and selected by default. */
export const DEFAULT_MODEL = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`;

/** Start compacting the 1M-context target at roughly 400k tokens. */
export const DEFAULT_COMPACT_AT_TOKENS = 400_000;
