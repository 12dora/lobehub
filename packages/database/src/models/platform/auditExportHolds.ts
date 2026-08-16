import type {
  PlatformAuditExportFilterSnapshot,
  PlatformAuditExportKind,
} from '../../schemas/platform';

/**
 * Whether a candidate legal hold intersects an export artifact's frozen filter.
 * Mirrors retention `exportArtifactHeld` for a single hold (DB-001 scoped block).
 */
export const holdIntersectsExportArtifact = (
  hold: { scopeId: string | null; scopeType: string },
  kind: PlatformAuditExportKind,
  filterSnapshot: PlatformAuditExportFilterSnapshot | null | undefined,
): boolean => {
  if (hold.scopeType === 'global') return true;
  if (!hold.scopeId) return false;

  const f = filterSnapshot ?? {};
  const scopeId = hold.scopeId;
  const scopeType = hold.scopeType;

  if (scopeType === 'user') {
    if (f.userId === scopeId || f.actorUserId === scopeId) return true;
    if (f.actorUserIds?.includes(scopeId)) return true;
    if (f.targetId === scopeId && (f.targetType === 'user' || !f.targetType)) return true;
  }
  if (scopeType === 'topic') {
    if (f.topicId === scopeId) return true;
    if (f.targetId === scopeId && (f.targetType === 'topic' || !f.targetType)) return true;
  }
  if (scopeType === 'session') {
    if (f.sessionId === scopeId) return true;
    if (f.targetId === scopeId && (f.targetType === 'session' || !f.targetType)) return true;
  }
  if (scopeType === 'workspace') {
    if (f.workspaceId === scopeId) return true;
    if (f.targetId === scopeId && (f.targetType === 'workspace' || !f.targetType)) return true;
  }

  // Broad filters: a scoped hold may still cover evidence inside the export.
  const hasActorPin = Boolean(f.actorUserId) || Boolean(f.actorUserIds?.length);
  const hasTopicPin = Boolean(f.topicId);
  const hasSessionPin = Boolean(f.sessionId);
  const hasWorkspacePin = Boolean(f.workspaceId);
  const hasAnyTargetPin = Boolean(f.targetId) && Boolean(f.targetType);
  const isOperationLogs = kind === 'operation_logs';
  const isConversationKind = kind === 'conversations' || kind === 'user_timeline';

  if (isOperationLogs && !hasActorPin && !hasAnyTargetPin) return true;
  if (
    isConversationKind &&
    !hasTopicPin &&
    !hasSessionPin &&
    !hasWorkspacePin &&
    (scopeType === 'topic' || scopeType === 'session' || scopeType === 'workspace')
  ) {
    return true;
  }
  // Actor-only op-log pin still overlaps other held users/topics as targets.
  if (isOperationLogs && hasActorPin && !hasAnyTargetPin) return true;

  return false;
};
