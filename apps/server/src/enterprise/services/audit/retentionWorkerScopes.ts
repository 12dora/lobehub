/**
 * Scope processors for operation_logs and conversations retention (SAO-009).
 */

import {
  type PlatformAuditLegalHoldItem,
  type PlatformAuditRetentionCounts,
} from '@/database/models/platform';

import { AUDIT_RETENTION_BATCH_LIMIT } from './retentionConstants';
import {
  isHoldTargetType,
  loadHoldIndexForScopes,
  operationLogHeld,
  topicHeld,
} from './retentionWorkerHolds';
import { keysetAfterPage, mergeCounts, type ScopeProcessorParams } from './retentionWorkerShared';

export const processOperationLogs = async (
  params: ScopeProcessorParams,
): Promise<PlatformAuditRetentionCounts> => {
  let counts = params.counts;
  for (;;) {
    await params.renewLease();
    const page = await params.repo.listOperationLogCandidates({
      cursor: params.getKeyset(),
      cutoffAt: params.cutoffAt,
      limit: AUDIT_RETENTION_BATCH_LIMIT,
    });

    if (page.items.length === 0) break;

    // Targeted hold lookup for this batch's actors / targets (F11).
    const scopeRefs: Array<{
      scopeId: string | null;
      scopeType: PlatformAuditLegalHoldItem['scopeType'];
    }> = [];
    for (const row of page.items) {
      if (row.actorUserId) scopeRefs.push({ scopeId: row.actorUserId, scopeType: 'user' });
      if (row.targetId) {
        if (isHoldTargetType(row.targetType)) {
          scopeRefs.push({
            scopeId: row.targetId,
            scopeType: row.targetType as PlatformAuditLegalHoldItem['scopeType'],
          });
        } else {
          // Unknown targetType over-skip: match the id under any hold class.
          for (const scopeType of ['user', 'session', 'topic', 'workspace'] as const) {
            scopeRefs.push({ scopeId: row.targetId, scopeType });
          }
        }
      }
    }
    const holds = await loadHoldIndexForScopes(params.db, scopeRefs);

    const baseDelta: PlatformAuditRetentionCounts = {
      operationLogsScanned: page.items.length,
      skippedLegalHold: 0,
      operationLogsDeleted: 0,
    };

    const toDelete: string[] = [];
    for (const row of page.items) {
      if (operationLogHeld(holds, row)) {
        baseDelta.skippedLegalHold = (baseDelta.skippedLegalHold ?? 0) + 1;
        continue;
      }
      if (params.execute) toDelete.push(row.id);
    }

    const nextKeyset = keysetAfterPage(page, (row) => row.createdAt);
    if (!nextKeyset) break;

    // Atomic: domain delete + counts + cursor in one TX (destruction never precedes checkpoint).
    counts = await params.checkpointBatch(
      mergeCounts(counts, baseDelta),
      nextKeyset,
      async (tx) => {
        const delta: PlatformAuditRetentionCounts = { ...baseDelta };
        if (params.execute && toDelete.length > 0) {
          const deleted = await params.repo.deleteOperationLogsRechecked({
            cutoffAt: params.cutoffAt,
            ids: toDelete,
            tx,
          });
          delta.operationLogsDeleted = deleted;
        }
        return mergeCounts(counts, delta);
      },
    );
    params.setKeyset(nextKeyset);

    if (!page.nextCursor) break;
  }
  return counts;
};

export const processConversations = async (
  params: ScopeProcessorParams,
): Promise<PlatformAuditRetentionCounts> => {
  let counts = params.counts;
  // Explicit: this task never deletes sessions.
  counts = { ...counts, sessionsDeleted: counts.sessionsDeleted ?? 0 };

  for (;;) {
    await params.renewLease();
    const page = await params.repo.listTopicCandidates({
      cursor: params.getKeyset(),
      cutoffAt: params.cutoffAt,
      limit: AUDIT_RETENTION_BATCH_LIMIT,
    });

    if (page.items.length === 0) break;

    const msgCounts = await params.repo.countMessagesForTopics(page.items.map((t) => t.id));

    // Targeted hold lookup for this batch's users / sessions / topics (F11).
    const scopeRefs: Array<{
      scopeId: string | null;
      scopeType: PlatformAuditLegalHoldItem['scopeType'];
    }> = [];
    for (const topic of page.items) {
      if (topic.userId) scopeRefs.push({ scopeId: topic.userId, scopeType: 'user' });
      if (topic.sessionId) scopeRefs.push({ scopeId: topic.sessionId, scopeType: 'session' });
      if (topic.workspaceId) scopeRefs.push({ scopeId: topic.workspaceId, scopeType: 'workspace' });
      scopeRefs.push({ scopeId: topic.id, scopeType: 'topic' });
    }
    const holds = await loadHoldIndexForScopes(params.db, scopeRefs);

    const baseDelta: PlatformAuditRetentionCounts = {
      topicsScanned: page.items.length,
      messagesScanned: 0,
      skippedLegalHold: 0,
      topicsDeleted: 0,
      messagesDeleted: 0,
      sessionsDeleted: 0,
      conversationsScanned: page.items.length,
      conversationsDeleted: 0,
    };

    const freeTopics: Array<{ id: string; msgN: number }> = [];
    for (const topic of page.items) {
      const msgN = msgCounts.get(topic.id) ?? 0;
      baseDelta.messagesScanned = (baseDelta.messagesScanned ?? 0) + msgN;

      if (topicHeld(holds, topic)) {
        baseDelta.skippedLegalHold = (baseDelta.skippedLegalHold ?? 0) + 1;
        continue;
      }

      if (params.execute) freeTopics.push({ id: topic.id, msgN });
    }

    const nextKeyset = keysetAfterPage(page, (row) => row.updatedAt);
    if (!nextKeyset) break;

    // Atomic: topic deletes + counts + cursor (hold recheck inside delete under lock).
    counts = await params.checkpointBatch(
      mergeCounts(counts, baseDelta),
      nextKeyset,
      async (tx) => {
        const delta: PlatformAuditRetentionCounts = { ...baseDelta };
        if (params.execute) {
          for (const topic of freeTopics) {
            const deleted = await params.repo.deleteTopicRechecked({
              cutoffAt: params.cutoffAt,
              topicId: topic.id,
              tx,
            });
            if (deleted) {
              delta.topicsDeleted = (delta.topicsDeleted ?? 0) + 1;
              delta.conversationsDeleted = (delta.conversationsDeleted ?? 0) + 1;
              delta.messagesDeleted = (delta.messagesDeleted ?? 0) + topic.msgN;
            }
          }
        }
        return mergeCounts(counts, delta);
      },
    );
    params.setKeyset(nextKeyset);

    if (!page.nextCursor) break;
  }

  return { ...counts, sessionsDeleted: 0 };
};

/**
 * Resolve held export ids under the retention/hold advisory lock TX.
 * Always re-query holds on the locked connection so claim and authorize see
 * holds activated after the pre-filter scan.
 */
