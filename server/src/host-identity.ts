/**
 * Who this machine is, and how a client is allowed to prove it.
 *
 * Two ways to run, and exactly one is in force on any given machine:
 *
 *   - **Firebase** (the default). The host has an owner identity, publishes
 *     presence into a discovery document, and a client proves who it is with a
 *     Firebase token. Everything the client needs to find the host is in that
 *     document, which is also what makes the host dependable on a metered
 *     service: its daily quota can reach zero, and a host that cannot publish
 *     cannot be found.
 *
 *   - **Paired.** The host owns its URL and has been handed a secret. There is
 *     nothing to discover and nothing to signal — the tunnel is already the
 *     client's path in — and a client holding the secret needs no identity
 *     provider to be believed. No Google service is touched at all, so there is
 *     no quota to exhaust.
 *
 * This module owns that choice, so the rest of the host never branches on it and
 * never has to know that "paired" exists. It is deliberately the ONLY place that
 * reads the pairing secret: a second reader would be a second opinion on
 * whether the machine is off Firebase, and the two could disagree.
 */

import { createFirebase, type FirebaseAuth } from "./auth.ts";
import { ensurePairingToken, PAIRED_OWNER_UID } from "./config.ts";
import { createPairingVerify } from "./pairing.ts";
import { verifiedOwnerToken } from "./owner-runtime.ts";

/** The shape the socket's token verifier must have. */
export type HostVerify = (token: string) => Promise<{ uid: string; expiresAt: number } | null>;

export type HostIdentity =
  | {
    kind: "paired";
    uid: string;
    email: string;
    /** Null: a paired host has no Firebase client, and must not acquire one. */
    fb: null;
    verify: HostVerify;
  }
  | {
    kind: "firebase";
    uid: string;
    email: string;
    fb: FirebaseAuth;
    verify: HostVerify;
  };

export interface ResolveHostIdentityOptions {
  /**
   * Whether a person is at the TUI. Only then may a browser sign-in window be
   * opened: a headless run that opens one waits forever for a human who is not
   * there, which is indistinguishable from a host that has hung.
   */
  interactive: boolean;
}

/**
 * Resolve who this machine is.
 *
 * A paired machine returns without constructing a Firebase client at all, which
 * is the point: constructing one is harmless, but anything that then *uses* it
 * is a metered request, and the whole reason pairing exists is that there are
 * none.
 */
export async function resolveHostIdentity(
  options: ResolveHostIdentityOptions,
): Promise<HostIdentity> {
  const verify = createPairingVerify({ token: ensurePairingToken(), ownerUid: PAIRED_OWNER_UID });
  if (verify) {
    return { kind: "paired", uid: PAIRED_OWNER_UID, email: "paired", fb: null, verify };
  }
  const fb = await createFirebase();
  const owner = await fb.resolveOwner({ interactive: options.interactive });
  return {
    kind: "firebase",
    uid: owner.uid,
    email: owner.email,
    fb,
    // A Firebase token is verified by Firebase, through the same check the
    // socket has always used; pairing is decided above and never re-consulted,
    // so a client cannot pick which door it comes through.
    verify: async (token) => verifiedOwnerToken(await fb.verifyToken(token)),
  };
}
