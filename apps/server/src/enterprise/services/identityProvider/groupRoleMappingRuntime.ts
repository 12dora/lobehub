/**
 * Crosses the Better Auth getUserInfo → session.create boundary.
 * getUserInfo knows IdP groups but not userId; session.create has userId.
 */
import type { LobeChatDatabase } from '@/database/type';

import { applyGroupRoleMappingToUser } from './groupRoleMapping';

type PendingGroupRoleMapping = {
  groups: string[];
  groupRoleMapping: Record<string, string>;
  expiresAt: number;
};

const PENDING_TTL_MS = 10 * 60 * 1000;
/** Hard cap so failed logins across many subjects cannot grow process memory without bound. */
const PENDING_MAX_ENTRIES = 10_000;
const pendingBySubject = new Map<string, PendingGroupRoleMapping>();

const subjectKey = (providerKey: string, subject: string) =>
  `${providerKey.toLowerCase()}:${subject}`;

/** Drop expired entries; if still over capacity, evict the soonest-to-expire keys. */
const sweepPendingGroupRoleMappings = (now = Date.now()): void => {
  for (const [key, pending] of pendingBySubject) {
    if (pending.expiresAt < now) pendingBySubject.delete(key);
  }
  if (pendingBySubject.size <= PENDING_MAX_ENTRIES) return;
  const ordered = [...pendingBySubject.entries()].sort(
    (left, right) => left[1].expiresAt - right[1].expiresAt,
  );
  const overflow = pendingBySubject.size - PENDING_MAX_ENTRIES;
  for (let i = 0; i < overflow; i += 1) {
    const entry = ordered[i];
    if (entry) pendingBySubject.delete(entry[0]);
  }
};

export const stashIdentityProviderGroupRoleMapping = (input: {
  groups: string[];
  groupRoleMapping: Record<string, string>;
  providerKey: string;
  subject: string;
}): void => {
  if (Object.keys(input.groupRoleMapping).length === 0) return;
  sweepPendingGroupRoleMappings();
  pendingBySubject.set(subjectKey(input.providerKey, input.subject), {
    expiresAt: Date.now() + PENDING_TTL_MS,
    groupRoleMapping: input.groupRoleMapping,
    groups: input.groups,
  });
};

export const takeIdentityProviderGroupRoleMapping = (input: {
  providerKey: string;
  subject: string;
}): PendingGroupRoleMapping | null => {
  sweepPendingGroupRoleMappings();
  const key = subjectKey(input.providerKey, input.subject);
  const pending = pendingBySubject.get(key);
  if (!pending) return null;
  pendingBySubject.delete(key);
  if (pending.expiresAt < Date.now()) return null;
  return pending;
};

/** Drop a stashed entry on terminal login failure (or any abort before reconcile). */
export const discardIdentityProviderGroupRoleMapping = (input: {
  providerKey: string;
  subject: string;
}): void => {
  pendingBySubject.delete(subjectKey(input.providerKey, input.subject));
};

/** Apply stashed mapping for a platform OIDC login (providerKey + subject). Fail-closed. */
export const reconcileIdentityProviderGroupRoles = async (input: {
  db: LobeChatDatabase;
  providerKey: string;
  subject: string;
  userId: string;
}): Promise<void> => {
  const pending = takeIdentityProviderGroupRoleMapping({
    providerKey: input.providerKey,
    subject: input.subject,
  });
  if (!pending) return;
  // Entry already consumed; re-stash is wrong — failure must not leave a retryable
  // elevated session. Propagate so the login/session path aborts.
  await applyGroupRoleMappingToUser({
    db: input.db,
    groupRoleMapping: pending.groupRoleMapping,
    groups: pending.groups,
    userId: input.userId,
  });
};

export const resetIdentityProviderGroupRoleMappingRuntimeForTest = (): void => {
  pendingBySubject.clear();
};

/** Test seam: current pending map size after optional sweep. */
export const pendingIdentityProviderGroupRoleMappingSizeForTest = (): number => {
  sweepPendingGroupRoleMappings();
  return pendingBySubject.size;
};
