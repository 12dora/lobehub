/**
 * Shared helpers for AdminAuditExportService (SAO-009).
 */

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import {
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportItem,
  type PlatformAuditExportKind,
} from '@/database/models/platform';

import type { AdminAuditExportsCreateInputParsed } from '../../contracts/adminAudit';
import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { toPublicJobError } from './jobError';

export const CONVERSATION_EXPORT_KINDS: readonly PlatformAuditExportKind[] = [
  'conversations',
  'user_timeline',
];

export const isConversationExportKind = (kind: PlatformAuditExportKind | undefined): boolean =>
  kind === 'conversations' || kind === 'user_timeline';

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

/** Public projection — never includes storageKey or raw/purge error payloads. */
export const toExportPublic = (row: PlatformAuditExportItem) => ({
  artifactBytes: row.artifactBytes,
  artifactChecksum: row.artifactChecksum,
  createdAt: row.createdAt,
  // Strict code-only DTO (F3/F5/F6) — drop message / purgeStorageKey.
  error: toPublicJobError(row.error as { code?: string } | null, 'EXPORT_FAILED'),
  expiresAt: row.expiresAt,
  filterSnapshot: row.filterSnapshot ?? {},
  finishedAt: row.finishedAt,
  id: row.id,
  includesMessageBodies: row.includesMessageBodies,
  jobId: row.jobId,
  kind: row.kind,
  requestedBy: row.requestedBy,
  rowCount: row.rowCount,
  startedAt: row.startedAt,
  status: row.status,
  updatedAt: row.updatedAt,
});

export const freezeFilterSnapshot = (
  input: AdminAuditExportsCreateInputParsed,
  window: { from: Date; to: Date },
  policy: {
    exportArtifactRetentionDays: number;
    maxExportRows: number;
    revision: number;
  },
): PlatformAuditExportFilterSnapshot => {
  const snap: PlatformAuditExportFilterSnapshot = {
    exportArtifactRetentionDays: policy.exportArtifactRetentionDays,
    from: window.from.toISOString(),
    maxExportRows: policy.maxExportRows,
    policyRevision: policy.revision,
    to: window.to.toISOString(),
  };
  if (input.kind === 'operation_logs') {
    if (input.action) snap.action = input.action;
    if (input.actions?.length) snap.actions = input.actions;
    if (input.actorUserId) snap.actorUserId = input.actorUserId;
    if (input.requestId) snap.requestId = input.requestId;
    if (input.result) snap.result = input.result;
    if (input.results?.length) snap.results = input.results;
    if (input.targetId) snap.targetId = input.targetId;
    if (input.targetType) snap.targetType = input.targetType;
  }
  if ((input.kind === 'conversations' || input.kind === 'user_timeline') && input.userId)
    snap.userId = input.userId;
  if (input.kind === 'conversations') {
    if (input.q) snap.q = input.q;
    if (input.topicId) snap.topicId = input.topicId;
  }
  return snap;
};

export type ActorAuthParams = {
  actorPermissions?: readonly string[];
  actorUserId: string;
};
