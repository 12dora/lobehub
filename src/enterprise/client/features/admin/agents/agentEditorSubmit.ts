import type { PlatformAgentDependencySnapshot, PlatformAgentVersionConfig } from '@lobechat/types';

import {
  mapEnterpriseError,
  PLATFORM_ERROR_CODES,
} from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { Assignment, AssignmentPlan } from './assignmentDraft';
import type { AdminAgentDetailOutput, AdminPlatformAgentSaveOutput } from './types';
import { fetchAdminAgentDetail } from './useAdminAgents';

/** The compare-and-swap pointer every write must echo back, advanced by each committed write. */
export interface AgentEditorCas {
  agentId: string;
  draftToken: string;
  revision: number;
}

export type ReconcileAgentStatus = 'absent' | 'found' | 'unknown';

export type SubmitFailureKind =
  'conflict' | 'identity-failed' | 'partial-assignment' | 'resume-blocked';

const isRevisionConflict = (cause: unknown): boolean => {
  if (mapEnterpriseError(cause)?.code === PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT) {
    return true;
  }
  return cause instanceof Error && cause.message.includes('CONFLICT');
};

/**
 * Create or save the version. Each response hands back the CAS the next write must echo —
 * the hook advances identity from `{ output, cas }`, never by re-GET.
 */
export const writeAgentVersion = async ({
  agentKey,
  authMethod,
  cas,
  config,
  dependencySnapshot,
}: {
  agentKey: string;
  authMethod: AdminReauthAuthMethod | null;
  cas: AgentEditorCas | null;
  config: PlatformAgentVersionConfig;
  dependencySnapshot: PlatformAgentDependencySnapshot;
}): Promise<{ cas: AgentEditorCas; output: AdminPlatformAgentSaveOutput }> => {
  const output = cas
    ? await withAdminReauthRetry(
        () =>
          adminAgentsService.save({
            agentId: cas.agentId,
            config,
            dependencySnapshot,
            expectedDraftToken: cas.draftToken,
            expectedRevision: cas.revision,
          }),
        { authMethod },
      )
    : await withAdminReauthRetry(
        () =>
          adminAgentsService.create({
            agentKey,
            config,
            dependencySnapshot,
            isDefault: false,
            systemKey: null,
          }),
        { authMethod },
      );
  return {
    cas: {
      agentId: output.identity.id,
      draftToken: output.draftToken,
      revision: output.identity.revision,
    },
    output,
  };
};

/**
 * Assignment writes are dangerous and each one advances the CAS, so the token from the
 * previous response feeds the next call — no re-GET in between. Removals always run first so a
 * dropped-and-re-added target cannot collide with the unique `(agent, target)` index.
 */
export const applyAssignmentPlan = async ({
  authMethod,
  cas,
  onCas,
  onRemoved,
  onUpserted,
  plan,
}: {
  authMethod: AdminReauthAuthMethod | null;
  cas: AgentEditorCas | null;
  onCas: (cas: AgentEditorCas) => void;
  onRemoved: (assignmentId: string) => void;
  onUpserted: (assignment: Assignment) => void;
  plan: AssignmentPlan;
}): Promise<AgentEditorCas | null> => {
  let next = cas;
  for (const assignmentId of plan.removals) {
    const step: AgentEditorCas = next!;
    const result = await withAdminReauthRetry(
      () =>
        adminAgentsService.removeAssignment({
          agentId: step.agentId,
          assignmentId,
          expectedDraftToken: step.draftToken,
          expectedRevision: step.revision,
        }),
      { authMethod },
    );
    next = {
      agentId: step.agentId,
      draftToken: result.draftToken,
      revision: result.identity.revision,
    };
    onCas(next);
    onRemoved(assignmentId);
  }
  for (const entry of plan.upserts) {
    const step: AgentEditorCas = next!;
    const result = await withAdminReauthRetry(
      () =>
        adminAgentsService.upsertAssignment({
          agentId: step.agentId,
          ...(entry.id ? { assignmentId: entry.id } : {}),
          enabled: entry.enabled,
          expectedDraftToken: step.draftToken,
          expectedRevision: step.revision,
          mode: entry.mode,
          // Always written as literals: versions left the UI, so every write un-pins a legacy
          // `pinned` row rather than carrying its policy forward invisibly.
          pinnedVersionId: null,
          targetId: entry.targetId,
          targetType: entry.targetType,
          versionPolicy: 'latest_published' as const,
        }),
      { authMethod },
    );
    next = {
      agentId: step.agentId,
      draftToken: result.draftToken,
      revision: result.identity.revision,
    };
    onCas(next);
    onUpserted(result.assignment);
  }
  return next;
};

/**
 * Ask the server what actually landed after an ambiguous failure. Returns `'found'` when the
 * assistant exists (caller must re-base state from `onFound`), `'absent'` when the create
 * provably never happened, and `'unknown'` when we could not tell — the one case where
 * retrying could create a second assistant.
 */
export const reconcileAgentAfterFailure = async ({
  agentId,
  agentKey,
  onFound,
}: {
  agentId: string | undefined;
  agentKey: string;
  onFound: (fresh: AdminAgentDetailOutput) => void;
}): Promise<ReconcileAgentStatus> => {
  let resolvedId = agentId;
  if (!resolvedId) {
    // The create response never arrived. The agent key is unique, so a targeted list read
    // settles whether the row exists — we must never blind-retry a create.
    if (!agentKey) return 'absent';
    try {
      const page = await adminAgentsService.list({ limit: 100, query: agentKey });
      resolvedId = page.items.find(({ identity: row }) => row.agentKey === agentKey)?.identity.id;
    } catch {
      return 'unknown';
    }
    if (!resolvedId) return 'absent';
  }
  try {
    const fresh = await fetchAdminAgentDetail(resolvedId, adminAgentsService, false);
    onFound(fresh);
    return 'found';
  } catch {
    // The row exists (or was created) but we cannot re-base on it. Resuming would author
    // writes against a CAS we no longer trust.
    return 'unknown';
  }
};

/**
 * Decide how a rejected submit should recover. A revision conflict is a definitive non-commit
 * and must not be folded into reconcile — re-reading would only mask the notice the operator
 * must see.
 */
export const classifySubmitFailure = async ({
  cas,
  cause,
  created,
  identityCommitted,
  reconcile,
}: {
  cas: AgentEditorCas | null;
  cause: unknown;
  created: boolean;
  identityCommitted: boolean;
  reconcile: (agentId: string | undefined) => Promise<ReconcileAgentStatus>;
}): Promise<SubmitFailureKind> => {
  if (!identityCommitted && isRevisionConflict(cause)) {
    return 'conflict';
  }
  const reconciled = await reconcile(cas?.agentId);
  if (reconciled === 'unknown') {
    return 'resume-blocked';
  }
  if (identityCommitted || (created && reconciled === 'found')) {
    return 'partial-assignment';
  }
  return 'identity-failed';
};
