/**
 * Shared legal-hold target matching for retention skip predicates.
 * Whitelist exact targetType+targetId; over-skip unknown/missing types.
 */

import type { PlatformAuditExportFilterSnapshot } from '@/database/models/platform';
import { RETENTION_OP_LOG_HOLD_TARGET_TYPES } from '@/database/models/platform';

export type HoldIndex = {
  global: boolean;
  sessions: Set<string>;
  topics: Set<string>;
  users: Set<string>;
  workspaces: Set<string>;
};

export const isHoldTargetType = (targetType: string): boolean =>
  (RETENTION_OP_LOG_HOLD_TARGET_TYPES as readonly string[]).includes(targetType);

export const idInAnyHoldSet = (index: HoldIndex, id: string): boolean =>
  index.users.has(id) || index.sessions.has(id) || index.topics.has(id) || index.workspaces.has(id);

/**
 * Whitelisted targetType+targetId, plus over-skip for unknown/missing types.
 * Extracted so `operationLogHeld` / `exactScopeHeld` share one predicate.
 */
export const holdTargetIdHeld = (
  index: HoldIndex,
  targetId: string,
  targetType: string | null | undefined,
): boolean => {
  if (targetType && isHoldTargetType(targetType)) {
    if (targetType === 'user' && index.users.has(targetId)) return true;
    if (targetType === 'session' && index.sessions.has(targetId)) return true;
    if (targetType === 'topic' && index.topics.has(targetId)) return true;
    if (targetType === 'workspace' && index.workspaces.has(targetId)) return true;
    return false;
  }
  return idInAnyHoldSet(index, targetId);
};

/** Exact identity / scope fields frozen on an export filter snapshot. */
export const exportIdentityHeld = (
  index: HoldIndex,
  f: PlatformAuditExportFilterSnapshot,
): boolean => {
  if (f.userId && index.users.has(f.userId)) return true;
  if (f.actorUserId && index.users.has(f.actorUserId)) return true;
  if (f.actorUserIds?.some((id) => index.users.has(id))) return true;
  if (f.topicId && index.topics.has(f.topicId)) return true;
  if (f.sessionId && index.sessions.has(f.sessionId)) return true;
  if (f.workspaceId && index.workspaces.has(f.workspaceId)) return true;
  return false;
};
