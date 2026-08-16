import type { AdminAuditRetentionRunItem } from '@/enterprise/client/services/adminAudit';

export const SCOPES = ['all', 'operation_logs', 'conversations', 'export_artifacts'] as const;

export const CONTENT_ACCESS_MODE_KEYS = {
  content_allowed: 'audit.retention.policy.mode.content_allowed',
  disabled: 'audit.retention.policy.mode.disabled',
  metadata_only: 'audit.retention.policy.mode.metadata_only',
} as const;

export const clampInt = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value) : min));

// Single source of truth for retention-policy field bounds, referenced by both the
// number inputs and the submit-time clamp so the two can never drift apart.
export const POLICY_BOUNDS = {
  conversationRetentionDays: { max: 3650, min: 1 },
  exportArtifactRetentionDays: { max: 365, min: 1 },
  maxExportRows: { max: 1_000_000, min: 1 },
  maxListWindowDays: { max: 365, min: 1 },
  operationLogRetentionDays: { max: 3650, min: 1 },
} as const;
export const clampField = (name: keyof typeof POLICY_BOUNDS, value: number) =>
  clampInt(value, POLICY_BOUNDS[name].min, POLICY_BOUNDS[name].max);

export const totalDeleted = (counts: AdminAuditRetentionRunItem['counts']) =>
  (counts.operationLogsDeleted ?? 0) +
  (counts.conversationsDeleted ?? 0) +
  (counts.messagesDeleted ?? 0) +
  (counts.topicsDeleted ?? 0) +
  (counts.sessionsDeleted ?? 0) +
  (counts.exportArtifactsDeleted ?? 0);

export const isRetentionRunInFlight = (status: AdminAuditRetentionRunItem['status']) =>
  status === 'pending' || status === 'running';
