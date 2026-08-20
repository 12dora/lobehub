/**
 * Shared mappers and helpers for AdminAuditService (SAO-009).
 */

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type {
  PlatformAuditLegalHoldItem,
  PlatformAuditLogItem,
  PlatformAuditPolicyItem,
} from '@/database/models/platform';
import { applyAuditConversationRedaction } from '@/database/models/platform';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { toPublicPlatformAuditItem } from '../platformAudit';

export type ConversationsGetInput = { topicId: string; userId: string };
export type EventsStatsInput = { from?: Date; to?: Date };

export const toPolicyPublic = (policy: PlatformAuditPolicyItem) => ({
  contentAccessMode: policy.contentAccessMode,
  conversationRetentionDays: policy.conversationRetentionDays,
  createdAt: policy.createdAt,
  exportArtifactRetentionDays: policy.exportArtifactRetentionDays,
  id: policy.id,
  maxExportRows: policy.maxExportRows,
  maxListWindowDays: policy.maxListWindowDays,
  messageBodyInExport: policy.messageBodyInExport,
  operationLogRetentionDays: policy.operationLogRetentionDays,
  redactionProfile: policy.redactionProfile,
  revision: policy.revision,
  updatedAt: policy.updatedAt,
  updatedBy: policy.updatedBy,
});

export const toEventListItem = (row: PlatformAuditLogItem) => ({
  action: row.action,
  actorUserId: row.actorUserId,
  configRevision: row.configRevision,
  createdAt: row.createdAt,
  id: row.id,
  ipHash: row.ipHash,
  reason: row.reason,
  requestId: row.requestId,
  result: row.result,
  targetId: row.targetId,
  targetType: row.targetType,
  userAgent: row.userAgent,
});

/** Detail projection shares the read-time security boundary used by all audit reads. */
export const toEventDetail = (row: PlatformAuditLogItem) => {
  const publicRow = toPublicPlatformAuditItem(row);
  return {
    ...toEventListItem(publicRow),
    afterDiff: publicRow.afterDiff,
    beforeDiff: publicRow.beforeDiff,
  };
};

/**
 * Project elapsed holds as `expired` even while the stored row is still `active`.
 * Retention's listActive() already excludes past-expiry holds; the admin API must
 * not present them as actionable/active.
 */
export const effectiveLegalHoldStatus = (
  row: PlatformAuditLegalHoldItem,
  now: Date = new Date(),
): 'active' | 'released' | 'expired' => {
  if (row.status === 'released') return 'released';
  if (row.expiresAt != null && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
};

export const toLegalHoldPublic = (row: PlatformAuditLegalHoldItem, now: Date = new Date()) => ({
  createdAt: row.createdAt,
  createdBy: row.createdBy,
  expiresAt: row.expiresAt,
  id: row.id,
  reason: row.reason,
  releaseReason: row.releaseReason,
  releasedAt: row.releasedAt,
  releasedBy: row.releasedBy,
  scopeId: row.scopeId,
  scopeType: row.scopeType,
  status: effectiveLegalHoldStatus(row, now),
  updatedAt: row.updatedAt,
});

export const isNotFoundError = (error: unknown): boolean =>
  getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND;

/** Policy / feature denials that must self-audit as `denied` (not `failure`). */
export const isDeniedError = (error: unknown): boolean => {
  const code = getEnterpriseErrorBody(error)?.code;
  return (
    code === PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED ||
    code === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED ||
    code === ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED ||
    code === ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED ||
    code === ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED
  );
};

export const accessLogResultForError = (error: unknown): 'denied' | 'failure' =>
  isDeniedError(error) ? 'denied' : 'failure';

/** Credential-mask free-text metadata that may contain pasted secrets. */
export const maskOptionalText = (
  value: string | null | undefined,
  profile: PlatformAuditPolicyItem['redactionProfile'] | null | undefined,
): string | null | undefined => {
  if (value == null) return value;
  return applyAuditConversationRedaction(value, profile);
};
