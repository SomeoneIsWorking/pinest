/**
 * Pairing: an app that is authorised by a secret, with no Firebase involved.
 *
 * The machine used to need Google for two things — an identity for the app to
 * prove, and a document to be found in. Both are now optional, because a
 * machine reachable at a URL it owns does not need to be *discovered*, and a
 * client holding a secret it was given once does not need an identity provider
 * to be believed.
 *
 * What this does NOT change: the pairing secret is a bearer credential. Anyone
 * who has it owns the machine completely, so it is compared in constant time,
 * is never logged in full, and never travels anywhere except to the app that
 * was handed it.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** How long a pairing handshake stays valid once the secret checks out. Short,
 * because the socket is long-lived and authenticated once: this bounds a stolen
 * link, it does not bound a live connection. */
export const PAIRING_SESSION_TTL_MS = 60 * 60 * 1000;

export interface PairingIdentity {
  uid: string;
  /** Never the secret, and never a prefix of it: this reaches the status line
   * and the logs. */
  label: string;
}

export interface PairingVerifyOptions {
  /** The configured secret, or null when the machine is on the Firebase path. */
  token: string | null;
  /** The stable owner uid for a paired machine. */
  ownerUid: string;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Build the socket's token verifier for a paired machine.
 *
 * Returns null when there is no secret, which the caller reads as "this machine
 * is not paired; use Firebase" rather than as an error.
 */
export function createPairingVerify(
  options: PairingVerifyOptions,
): ((token: string) => Promise<{ uid: string; expiresAt: number } | null>) | null {
  const { token, ownerUid } = options;
  if (!token) return null;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PAIRING_SESSION_TTL_MS;
  return async (presented: string): Promise<{ uid: string; expiresAt: number } | null> => {
    if (!secretsEqual(presented, token)) return null;
    return { uid: ownerUid, expiresAt: now() + ttlMs };
  };
}

/**
 * Compare two secrets without leaking their relationship through timing.
 *
 * Both are hashed first so the comparison is over fixed-length buffers whatever
 * the input lengths are - a plain `===` on secrets is exactly the thing that
 * makes a wrong guess cheaper than a right one.
 */
export function secretsEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * The pairing link an app is given: where the machine is, and the secret that
 * opens it, in one string.
 *
 * A quick tunnel's hostname changes when the tunnel restarts, which would
 * otherwise mean re-pairing by hand every time. The secret is part of the URL
 * so a re-paired link is all that is ever needed - the app keeps the secret and
 * only the host changes.
 */
export function pairingLink(tunnelUrl: string, token: string): string {
  const url = new URL(tunnelUrl);
  url.searchParams.set("t", token);
  return url.toString();
}

/**
 * The pairing link with the secret masked, for anything a person reads on a
 * screen. Copying is a separate, explicit act: a URL in a terminal scrollback
 * or a screenshot is not a secret leak if the secret is not in it.
 */
export function maskedPairingLink(tunnelUrl: string, token: string): string {
  const url = new URL(tunnelUrl);
  url.searchParams.set("t", `${token.slice(0, 4)}…${token.slice(-2)}`);
  return url.toString();
}
