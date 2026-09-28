/**
 * Who this machine is, and how a client proves it.
 *
 * Identity is always Google. That is not a choice this module makes, and it is
 * not negotiable per machine: a client signs in with its own Google account, the
 * host verifies that ID token through Google's Identity Toolkit, and both sides
 * are talking about the same person. There is deliberately no second credential
 * here — a shared pairing secret would be a second opinion on who a client is,
 * and two opinions that can disagree are how a host ends up trusting a stranger.
 *
 * What IS optional is Firestore, and the separation is the point:
 *
 *   - **Identity** (who you are) — Google's Identity Toolkit REST API. Free, and
 *     not a document store, so it has no daily quota to exhaust. Verified above,
 *     while the project's Firestore quota was at zero and refusing every call.
 *
 *   - **Discovery** (how a client finds this host) — the Firestore document the
 *     app watches for a machine's URL. Useful, and the only thing that actually
 *     depends on the quota.
 *
 * A host with `discovery: "none"` serves a URL it owns and is told where it is
 * once, at pairing time, so it never has to publish presence. It touches no
 * Google service except the one that answers identity questions.
 */

import { createFirebase, verifyGoogleToken, type FirebaseAuth } from "./auth.ts";
import { readCachedAuth } from "./auth-cache.ts";
import { loadConfig } from "./config.ts";
import { verifiedOwnerToken } from "./owner-runtime.ts";

/** The shape the socket's token verifier must have. */
export type HostVerify = (token: string) => Promise<{ uid: string; expiresAt: number } | null>;

export interface HostIdentity {
  uid: string;
  email: string;
  /** The client's Google ID token, verified by Google. Never anything else. */
  verify: HostVerify;
  /**
   * The Firestore client used for presence, discovery and signaling - or null
   * when this host is reachable by its own URL and needs to publish nothing.
   * Null is the whole point of `discovery: "none"`: no client is constructed,
   * so no metered request can be made by accident.
   */
  discovery: FirebaseAuth | null;
}

export interface ResolveHostIdentityOptions {
  /**
   * Whether a person is at the TUI. Only then may a browser sign-in window be
   * opened: a headless run that opens one waits forever for a human who is not
   * there, which is indistinguishable from a host that has hung.
   */
  interactive: boolean;
}

/** Google's answer, shaped for the socket: null unless the token is ours and live. */
async function verify(token: string): Promise<{ uid: string; expiresAt: number } | null> {
  return verifiedOwnerToken(await verifyGoogleToken(token));
}

/**
 * The owner, from the credential we already hold, without touching Firestore.
 *
 * The refresh credential is a Google sign-in that has already happened; reading
 * it is a local file read, not a network call. This is what lets a
 * `discovery: "none"` host still know its own uid at boot, which is what the
 * durable session registry is bound to.
 */
function cachedOwner(): { uid: string; email: string } | null {
  const cached = readCachedAuth();
  if (!cached?.uid) return null;
  return { uid: cached.uid, email: cached.email ?? cached.uid };
}

export async function resolveHostIdentity(
  options: ResolveHostIdentityOptions,
): Promise<HostIdentity> {
  if (loadConfig().discovery === "none") {
    const owner = cachedOwner();
    if (!owner) {
      throw new Error(
        "discovery is off and this machine has no cached Google sign-in, so there is " +
        "no owner to bind to. Run /pinest-auth once with a browser to sign in, or " +
        "set discovery back to \"firestore\".",
      );
    }
    return { ...owner, verify, discovery: null };
  }

  const discovery = await createFirebase();
  const owner = await discovery.resolveOwner({ interactive: options.interactive });
  return { uid: owner.uid, email: owner.email, verify, discovery };
}
