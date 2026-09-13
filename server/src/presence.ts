/**
 * Publishing the host's reachability so the app can find it.
 *
 * One place decides what "online" means for the owner's presence record, so
 * bootstrap, the heartbeat, and shutdown cannot drift apart.
 */
export interface PresenceSnapshot {
  url: string | null;
  online: boolean;
  ownerEmail?: string;
  hostname: string;
  ts: number;
}

export interface PresenceDeps {
  fb: { publishPresence(uid: string, snapshot: PresenceSnapshot): Promise<void> } | null;
  ownerUid: string | null;
  ownerEmail: string | null;
  tunnelUrl: () => string | null;
  hostname: () => string;
}

/** No owner or no Firebase means nothing to publish — not an error. */
export function publishPresence(deps: PresenceDeps, online: boolean): Promise<void> {
  if (!deps.fb || !deps.ownerUid) {
    return Promise.resolve();
  }
  return deps.fb.publishPresence(deps.ownerUid, {
    url: deps.tunnelUrl(),
    online,
    ownerEmail: deps.ownerEmail ?? undefined,
    hostname: deps.hostname(),
    ts: Date.now(),
  });
}
