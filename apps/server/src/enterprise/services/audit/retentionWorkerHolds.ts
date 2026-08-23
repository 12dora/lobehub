/**
 * Legal-hold resolution for audit retention worker (SAO-009).
 */

import {
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportKind,
  type PlatformAuditLegalHoldItem,
  PlatformAuditLegalHoldModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  exportIdentityHeld,
  type HoldIndex,
  holdTargetIdHeld,
  isHoldTargetType,
} from './retentionWorkerHoldMatch';

export type { HoldIndex } from './retentionWorkerHoldMatch';
export { isHoldTargetType } from './retentionWorkerHoldMatch';

export const buildHoldIndex = (holds: PlatformAuditLegalHoldItem[]): HoldIndex => {
  const index: HoldIndex = {
    global: false,
    sessions: new Set(),
    topics: new Set(),
    users: new Set(),
    workspaces: new Set(),
  };
  for (const h of holds) {
    if (h.scopeType === 'global') {
      index.global = true;
      continue;
    }
    if (!h.scopeId) continue;
    if (h.scopeType === 'user') index.users.add(h.scopeId);
    else if (h.scopeType === 'session') index.sessions.add(h.scopeId);
    else if (h.scopeType === 'topic') index.topics.add(h.scopeId);
    else if (h.scopeType === 'workspace') index.workspaces.add(h.scopeId);
  }
  return index;
};

/** Sentinel never equal to a real scope id — only makes Set.size > 0 for broad over-skip. */
export const HOLD_CLASS_SENTINEL = '\0hold-class';

/**
 * Build a hold index for a candidate batch via targeted scope lookup + class
 * presence. Avoids reloading the entire active legal-hold table every batch (F11)
 * while preserving conservative broad over-skip (class size checks).
 */
export const loadHoldIndexForScopes = async (
  db: LobeChatDatabase | Transaction,
  scopes: Array<{ scopeId: string | null; scopeType: PlatformAuditLegalHoldItem['scopeType'] }>,
): Promise<HoldIndex> => {
  const model = new PlatformAuditLegalHoldModel(db);
  // Fast path: if any global hold exists, everything is held.
  const classes = await model.summarizeActiveHoldClasses();
  if (classes.global) {
    return {
      global: true,
      sessions: new Set(),
      topics: new Set(),
      users: new Set(),
      workspaces: new Set(),
    };
  }
  const holds = scopes.length > 0 ? await model.findActiveScopes(scopes) : [];
  const index = buildHoldIndex(holds);
  // Class presence for broad over-skip without materializing every hold row.
  if (classes.hasUser) index.users.add(HOLD_CLASS_SENTINEL);
  if (classes.hasTopic) index.topics.add(HOLD_CLASS_SENTINEL);
  if (classes.hasSession) index.sessions.add(HOLD_CLASS_SENTINEL);
  if (classes.hasWorkspace) index.workspaces.add(HOLD_CLASS_SENTINEL);
  return index;
};

export const collectExportFilterHoldScopes = (
  rows: Array<{ filterSnapshot: PlatformAuditExportFilterSnapshot | null | undefined }>,
): Array<{ scopeId: string | null; scopeType: PlatformAuditLegalHoldItem['scopeType'] }> => {
  const scopeRefs: Array<{
    scopeId: string | null;
    scopeType: PlatformAuditLegalHoldItem['scopeType'];
  }> = [];
  for (const row of rows) {
    const snap = row.filterSnapshot;
    if (snap?.userId) scopeRefs.push({ scopeId: snap.userId, scopeType: 'user' });
    if (snap?.actorUserId) scopeRefs.push({ scopeId: snap.actorUserId, scopeType: 'user' });
    if (snap?.topicId) scopeRefs.push({ scopeId: snap.topicId, scopeType: 'topic' });
    if (snap?.sessionId) scopeRefs.push({ scopeId: snap.sessionId, scopeType: 'session' });
    if (snap?.workspaceId) scopeRefs.push({ scopeId: snap.workspaceId, scopeType: 'workspace' });
    if (snap?.targetId && snap.targetType && isHoldTargetType(snap.targetType)) {
      scopeRefs.push({
        scopeId: snap.targetId,
        scopeType: snap.targetType as PlatformAuditLegalHoldItem['scopeType'],
      });
    }
  }
  return scopeRefs;
};

/**
 * Over-skip: if any matching hold could protect the row, skip.
 * Whitelisted targetType+targetId + actorUserId for user holds.
 */
export const operationLogHeld = (
  index: HoldIndex,
  row: {
    actorUserId: string | null;
    targetId: string | null;
    targetType: string;
  },
): boolean => {
  if (index.global) return true;
  if (row.actorUserId && index.users.has(row.actorUserId)) return true;
  if (row.targetId && holdTargetIdHeld(index, row.targetId, row.targetType)) return true;
  return false;
};

export const topicHeld = (
  index: HoldIndex,
  row: {
    id: string;
    sessionId: string | null;
    userId: string;
    workspaceId: string | null;
  },
): boolean => {
  if (index.global) return true;
  if (index.users.has(row.userId)) return true;
  if (index.topics.has(row.id)) return true;
  if (row.sessionId && index.sessions.has(row.sessionId)) return true;
  if (row.workspaceId && index.workspaces.has(row.workspaceId)) return true;
  return false;
};

export const hasAnyScopedHold = (index: HoldIndex): boolean =>
  index.users.size > 0 ||
  index.topics.size > 0 ||
  index.sessions.size > 0 ||
  index.workspaces.size > 0;

type FilterPins = {
  hasActorPin: boolean;
  hasAnyTargetPin: boolean;
  hasHoldTargetPin: boolean;
  hasSessionPin: boolean;
  hasTopicPin: boolean;
  hasWorkspacePin: boolean;
};

const computeFilterPins = (f: PlatformAuditExportFilterSnapshot): FilterPins => ({
  hasActorPin: Boolean(f.actorUserId) || Boolean(f.actorUserIds?.length),
  hasAnyTargetPin: Boolean(f.targetId) && Boolean(f.targetType),
  hasHoldTargetPin: Boolean(f.targetId) && Boolean(f.targetType) && isHoldTargetType(f.targetType!),
  hasSessionPin: Boolean(f.sessionId),
  hasTopicPin: Boolean(f.topicId),
  hasWorkspacePin: Boolean(f.workspaceId),
});

const exactScopeHeld = (index: HoldIndex, f: PlatformAuditExportFilterSnapshot): boolean => {
  if (exportIdentityHeld(index, f)) return true;
  if (f.targetId && holdTargetIdHeld(index, f.targetId, f.targetType)) return true;
  return false;
};

const broadOperationLogHeld = (index: HoldIndex, pins: FilterPins): boolean => {
  // Broad operation-log filters (time/action/result/q, or empty): any scoped hold.
  // Do not infer kind from `q` — it is a valid operation_logs filter field.
  if (!pins.hasActorPin && !pins.hasAnyTargetPin) {
    return true;
  }

  // Actor pin without hold-relevant target pin: held users can still appear as
  // targets; held topics/sessions/workspaces can appear as targets.
  if (pins.hasActorPin && !pins.hasHoldTargetPin) {
    if (index.users.size > 0) return true;
    if (index.topics.size > 0 || index.sessions.size > 0 || index.workspaces.size > 0) {
      return true;
    }
  }
  // Hold-relevant target pin without actor pin: held users can appear as actors.
  if (pins.hasHoldTargetPin && !pins.hasActorPin && index.users.size > 0) {
    return true;
  }
  // Non-hold target type (e.g. settings) without actor pin: held users as actors.
  if (pins.hasAnyTargetPin && !pins.hasHoldTargetPin && !pins.hasActorPin && index.users.size > 0) {
    return true;
  }

  return false;
};

const broadConversationHeld = (index: HoldIndex, pins: FilterPins): boolean => {
  // Broad conversation / user_timeline: userId or title query without a tighter pin
  // can include held topics, sessions, or workspaces under that user.
  if (
    !pins.hasTopicPin &&
    !pins.hasSessionPin &&
    !pins.hasWorkspacePin &&
    (index.topics.size > 0 || index.sessions.size > 0 || index.workspaces.size > 0)
  ) {
    return true;
  }

  // Exact topic pin does not prove session/workspace membership is free of holds.
  if (pins.hasTopicPin && (index.sessions.size > 0 || index.workspaces.size > 0)) {
    return true;
  }
  // Exact session pin does not prove nested topics/workspaces are free of holds.
  if (
    pins.hasSessionPin &&
    !pins.hasTopicPin &&
    (index.topics.size > 0 || index.workspaces.size > 0)
  ) {
    return true;
  }
  // Exact workspace pin does not prove nested topics/sessions are free of holds.
  if (
    pins.hasWorkspacePin &&
    !pins.hasTopicPin &&
    !pins.hasSessionPin &&
    (index.topics.size > 0 || index.sessions.size > 0)
  ) {
    return true;
  }

  return false;
};

/**
 * Conservative legal-hold gate for derived export artifacts.
 *
 * Exports are frozen evidence packages. Prefer over-retention: if the frozen
 * filter can include evidence under any active legal hold, skip purge.
 *
 * Policy branches on the actual export `kind` (`operation_logs` vs
 * `conversations` / `user_timeline`), never on filter-field heuristics.
 * (`q` is valid for operation-log exports and must not reclassify them.)
 *
 * Covered:
 * - Exact scopes: userId, actorUserId(s), topicId, sessionId, workspaceId
 * - Whitelisted / over-skip targetType+targetId (mirrors operationLogHeld)
 * - Broad operation-log filters when any non-global hold exists
 * - Broad conversation/user_timeline filters when topic/session/workspace holds
 *   could still fall inside the export (userId/q without a tighter pin)
 * - Partially narrowed filters that still cannot exclude remaining hold classes
 *
 * Sister predicate: `holdIntersectsExportArtifact` in the audit-export model
 * (single-hold create-time collision check). The two already diverge on the
 * actor-pin branch and must not be unified.
 */
export const exportArtifactHeld = (
  index: HoldIndex,
  kind: PlatformAuditExportKind,
  filterSnapshot: PlatformAuditExportFilterSnapshot | null | undefined,
): boolean => {
  if (index.global) return true;
  if (!hasAnyScopedHold(index)) return false;

  const f = filterSnapshot ?? {};

  if (exactScopeHeld(index, f)) return true;

  const pins = computeFilterPins(f);
  const isOperationLogs = kind === 'operation_logs';
  const isConversationKind = kind === 'conversations' || kind === 'user_timeline';

  if (isOperationLogs && broadOperationLogHeld(index, pins)) return true;
  if (isConversationKind && broadConversationHeld(index, pins)) return true;

  return false;
};
