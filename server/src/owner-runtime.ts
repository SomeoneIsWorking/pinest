export interface OwnerIdentity {
  uid: string;
  email: string;
}

export interface ExpiringIdentity {
  uid?: string;
  expiresAt?: number;
}

export function verifiedOwnerToken(
  identity: ExpiringIdentity | null,
  now = Date.now(),
): { uid: string; expiresAt: number } | null {
  if (!identity?.uid || !Number.isFinite(identity.expiresAt) || identity.expiresAt! <= now) {
    return null;
  }
  return { uid: identity.uid, expiresAt: identity.expiresAt! };
}

export interface ReauthenticateOwnerDeps {
  currentUid: string | null;
  forceReLogin: (expectedUid?: string) => Promise<OwnerIdentity>;
  setOwner: (owner: OwnerIdentity) => void;
  hasRemoteStack: () => boolean;
  closeAuthenticatedClients: () => void;
  publishPresence: () => Promise<void>;
  bootstrap: () => Promise<void>;
}

/** Rotate owner credentials without tearing down live agent sessions. */
export async function reauthenticateRemoteOwner(
  deps: ReauthenticateOwnerDeps,
): Promise<OwnerIdentity> {
  const owner = await deps.forceReLogin(deps.currentUid ?? undefined);
  if (deps.currentUid !== null && owner.uid !== deps.currentUid) {
    throw new Error("re-authenticated account does not match the current owner");
  }
  deps.setOwner(owner);
  if (deps.hasRemoteStack()) {
    deps.closeAuthenticatedClients();
    await deps.publishPresence();
  } else {
    await deps.bootstrap();
  }
  return owner;
}
