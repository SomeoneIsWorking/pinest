/**
 * What this host says about where it can be reached.
 *
 * Two destinations, one fact: the runtime record on disk, and the lookup service
 * the app reads. They were separate calls, and they drifted — the tunnel came up
 * with a new hostname, the record was written, and the lookup service kept the
 * one that had died with the last tunnel. The app then dialled a name that could
 * never answer, which is indistinguishable from the machine being gone.
 *
 * So announcing is one action here, not two call sites, and there is no way for
 * one destination to be updated without the other.
 *
 * Written on CHANGE, never on a heartbeat. A quick tunnel renames itself only
 * when it restarts, so this is a handful of writes a month rather than tens of
 * thousands — a heartbeat would spend a monthly budget in a day and return this
 * host to the failure this whole change exists to remove. A refusal is a line,
 * never an interruption: not being found is bad, taking the host down is worse.
 */

import { publishEndpoint, realtimeDatabaseUrl } from "./endpoint-registry.ts";
import { recordTunnelUrl } from "./runtime-record.ts";
import { hostname } from "node:os";

export interface EndpointAnnouncer {
  /** The address clients should dial, or null while the tunnel is starting. */
  tunnelUrl: () => string | null;
  /** The authenticated owner this host publishes under. Null before identity. */
  ownerUid: () => string | null;
  debug: (message: string) => void;
}

export function createEndpointAnnouncer(deps: EndpointAnnouncer): {
  announce: () => Promise<void>;
} {
  return {
    announce(): Promise<void> {
      recordTunnelUrl(deps.tunnelUrl());
      return publish();
    },
  };

  function publish(): Promise<void> {
    const uid = deps.ownerUid();
    if (!uid) return Promise.resolve();
    const doc = { url: deps.tunnelUrl(), online: true, hostname: hostname(), ts: Date.now() };
    return publishEndpoint(doc, {
      ownerUid: uid,
      databaseUrl: realtimeDatabaseUrl(),
      hostname: hostname(),
      online: true,
    }).catch((e: unknown) => deps.debug(`[remote-code] endpoint publish failed: ${(e as Error).message}`));
  }
}
