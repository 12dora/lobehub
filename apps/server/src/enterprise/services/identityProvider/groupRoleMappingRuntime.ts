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
const pendingBySubject = new Map<string, PendingGroupRoleMapping>();

const subjectKey = (providerKey: string, subject: string) =>
  `${providerKey.toLowerCase()}:${subject}`;

export const stashIdentityProviderGroupRoleMapping = (input: {
  groups: string[];
  groupRoleMapping: Record<string, string>;
  providerKey: string;
  subject: string;
}): void => {
  if (Object.keys(input.groupRoleMapping).length === 0) return;
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
  const key = subjectKey(input.providerKey, input.subject);
  const pending = pendingBySubject.get(key);
  if (!pending) return null;
  pendingBySubject.delete(key);
  if (pending.expiresAt < Date.now()) return null;
  return pending;
};

/** Apply stashed mapping for a platform OIDC login (providerKey + subject). */
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
