/**
 * Where a host says it can be reached, in Realtime Database rather than Firestore.
 *
 * This exists because a project can run out of Firestore writes while its reads
 * still work, and a host that cannot publish itself is a host nobody can find.
 * Measured on this project: reads succeeded in 862ms while every write timed
 * out, so the document went stale for an hour while the machine ran perfectly.
 *
 * Realtime Database is a different product with a different budget - metered per
 * month rather than per day - and this project already has it, with the same
 * Google accounts already signed into it. So the dependency moves from a bucket
 * that is empty to one that is not, with nothing to sign up for and no domain.
 *
 * Two things make it cheap rather than merely different:
 *
 *   - **The URL is written when it changes, not on a heartbeat.** A quick tunnel
 *     changes its hostname only when it restarts, so this is a handful of writes
 *     a month instead of tens of thousands. A heartbeat here would spend a
 *     monthly budget in a day and be back where it started.
 *   - **It is one small record per host**, so a client reads one path rather than
 *     watching a document that changes for unrelated reasons.
 *
 * Both ends use the same credential they already have: the owner's Google ID
 * token, which the database rules accept because `auth.uid` is the owner.
 */

import { mintOwnerIdToken } from "./auth.ts";
import { firebaseWebConfig } from "./auth.ts";

/**
 * The project's Realtime Database, derived from the project id the app already
 * embeds. Defaults to the region-less host, which every project has.
 */
export function realtimeDatabaseUrl(projectId = firebaseWebConfig().projectId): string {
  return `https://${projectId}-default-rtdb.firebaseio.com`;
}

/** What a host publishes so a client can reach it. */
export interface EndpointDoc {
  /** The public URL, or null when this host has no tunnel right now. */
  url: string | null;
  online: boolean;
  hostname: string;
  /** Unix ms. The client believes a record only while this is fresh. */
  ts: number;
}

/** One host's record, at the path the rules and the app both agree on. */
export function endpointPath(uid: string): string {
  return `users/${encodeURIComponent(uid)}`;
}

export interface PublishEndpointDeps {
  ownerUid: string;
  databaseUrl: string;
  hostname: string;
  online: boolean;
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to the machine's own Google sign-in. */
  idToken?: () => Promise<string | null>;
}

/**
 * Publish where this host can be reached.
 *
 * Returns quietly when there is no token: an unsigned-in machine has nothing to
 * publish to, and that is a state the owner sees elsewhere rather than a crash
 * of a service that was only announcing a hostname.
 */
export async function publishEndpoint(doc: EndpointDoc, deps: PublishEndpointDeps): Promise<void> {
  // Defaulted here rather than at the call site: the seam is optional, and a
  // seam that is present in the type but undefined at runtime is how a publish
  // path ships broken and only fails when it is actually used.
  const doFetch = deps.fetchImpl ?? fetch;
  const token = await (deps.idToken ?? mintOwnerIdToken)({ fetchImpl: doFetch });
  if (!token) return;
  // The token goes in `?auth=`, NOT an `Authorization: Bearer` header.
  // Measured against the live database: a valid, unexpired, correctly-scoped
  // Google ID token presented as a bearer header is answered `401 Unauthorized
  // request`, while the same token in the query parameter is accepted. The
  // difference is invisible until it is tested against the real service, and it
  // presents as a permissions problem when it is really a transport one.
  const response = await doFetch(withAuth(
    `${deps.databaseUrl.replace(/\/+$/, "")}/${endpointPath(deps.ownerUid)}.json`, token), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: doc.url,
      online: doc.online,
      hostname: doc.hostname,
      ts: doc.ts,
    }),
  });
  if (!response.ok) {
    throw new Error(`endpoint publish failed: HTTP ${response.status}`);
  }
}

/** Attach an ID token the way this database accepts one. See publishEndpoint. */
function withAuth(url: string, token: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}auth=${encodeURIComponent(token)}`;
}

/**
 * Read where a host says it can be reached.
 *
 * The token is REQUIRED, not optional: the rules refuse an anonymous read, and
 * a helper that appeared to work without one would only ever answer 401 while
 * looking like a working lookup.
 */
export async function readEndpoint(
  uid: string,
  databaseUrl: string,
  idToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointDoc | null> {
  const response = await fetchImpl(withAuth(
    `${databaseUrl.replace(/\/+$/, "")}/${endpointPath(uid)}.json`, idToken));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`endpoint read failed: HTTP ${response.status}`);
  const body = await response.json() as Partial<EndpointDoc> | null;
  if (!body || typeof body !== "object") return null;
  return {
    url: typeof body.url === "string" ? body.url : null,
    online: body.online === true,
    hostname: typeof body.hostname === "string" ? body.hostname : "",
    ts: typeof body.ts === "number" ? body.ts : 0,
  };
}
