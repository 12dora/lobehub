import type { PlatformAgentDependencySnapshot, PlatformAgentVersionConfig } from '@lobechat/types';
import { toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { platformAgentDependencySnapshotSchema } from '@/server/enterprise/contracts/platformAgents';

import type { AgentEditorCas, ReconcileAgentStatus } from './agentEditorSubmit';
import { applyAssignmentPlan, classifySubmitFailure, writeAgentVersion } from './agentEditorSubmit';
import { buildAgentConfig } from './agentEditorValue';
import type { Assignment, AssignmentPlan } from './assignmentDraft';
import { toDependencySnapshot } from './dependencyCatalog';
import { getAdminAgentErrorMessage } from './errorPresentation';
import type { AdminAgentEditorValue, AdminPlatformAgentSaveOutput } from './types';

/** What the submit actually committed, so the caller knows whether a row patch is still enough. */
export interface AgentEditorSaveMeta {
  /** At least one assignment was written — list counters are stale, revalidate rather than patch. */
  assignmentsChanged: boolean;
  created: boolean;
}

/**
 * Apply the committed output to the caches the caller owns and revalidate. A rejection means the
 * caller did NOT handle the failure, and the editor surfaces the refresh-failed warning itself.
 * `output` is null when only assignments changed — there was no new version to apply.
 */
export type AgentEditorSavedHandler = (
  output: AdminPlatformAgentSaveOutput | null,
  meta: AgentEditorSaveMeta,
) => Promise<void> | void;

/** Step 1 — what this submit is allowed to write, and whether it may write it at all. */
export interface AgentCommitPlan {
  config: PlatformAgentVersionConfig | null;
  dependencySnapshot: PlatformAgentDependencySnapshot | null;
  /** False only when a submit that WILL author a version cannot satisfy the version contract. */
  valid: boolean;
  willWriteConfig: boolean;
}

/**
 * Only a submit that will actually author a version has to satisfy the version contract — an
 * assignment-only operator writes no version, so an incomplete config must not block their Save.
 */
export const planAgentCommit = ({
  configDirty,
  configEditable,
  hasIdentity,
  keyValid,
  value,
}: {
  configDirty: boolean;
  configEditable: boolean;
  hasIdentity: boolean;
  keyValid: boolean;
  value: AdminAgentEditorValue;
}): AgentCommitPlan => {
  const config = buildAgentConfig(value);
  const dependencySnapshot = toDependencySnapshot(value.dependencies);
  const willWriteConfig = configEditable && (configDirty || !hasIdentity);
  const valid =
    !willWriteConfig ||
    Boolean(
      config &&
      keyValid &&
      dependencySnapshot &&
      platformAgentDependencySnapshotSchema.safeParse(dependencySnapshot).success,
    );
  return { config, dependencySnapshot, valid, willWriteConfig };
};

/**
 * Everything the chain has committed so far. The failure path needs the PARTIAL result — the CAS
 * the last committed write handed back, and whether the identity itself is already live — so the
 * chain advances this record in place instead of only returning it on success.
 */
export interface AgentCommitProgress {
  cas: AgentEditorCas | null;
  /**
   * Once the identity write is settled, a later failure is an ASSIGNMENT failure — a different
   * story for the operator: the assistant is live, the distribution is not (fully) applied.
   */
  identityCommitted: boolean;
  output: AdminPlatformAgentSaveOutput | null;
}

/** Step 2 — write the version (when this submit authors one), then the frozen assignment plan. */
export const runAgentCommitChain = async (
  progress: AgentCommitProgress,
  {
    agentKey,
    authMethod,
    commitPlan,
    onAssignmentRemoved,
    onAssignmentUpserted,
    onCas,
    onVersionWritten,
    plan,
  }: {
    agentKey: string;
    authMethod: AdminReauthAuthMethod | null;
    commitPlan: AgentCommitPlan;
    onAssignmentRemoved: (assignmentId: string) => void;
    onAssignmentUpserted: (assignment: Assignment) => void;
    onCas: (cas: AgentEditorCas) => void;
    onVersionWritten: (cas: AgentEditorCas, output: AdminPlatformAgentSaveOutput) => void;
    plan: AssignmentPlan;
  },
): Promise<void> => {
  if (commitPlan.willWriteConfig) {
    const written = await writeAgentVersion({
      agentKey,
      authMethod,
      cas: progress.cas,
      config: commitPlan.config!,
      dependencySnapshot: commitPlan.dependencySnapshot!,
    });
    progress.output = written.output;
    progress.cas = written.cas;
    onVersionWritten(written.cas, written.output);
  }
  progress.identityCommitted = true;
  progress.cas = await applyAssignmentPlan({
    authMethod,
    cas: progress.cas,
    onCas,
    onRemoved: onAssignmentRemoved,
    onUpserted: onAssignmentUpserted,
    plan,
  });
};

/** Apply the committed output to the caller's caches, reporting — never swallowing — a failure. */
const applyToCaller = async (
  onSaved: AgentEditorSavedHandler | undefined,
  output: AdminPlatformAgentSaveOutput | null,
  meta: AgentEditorSaveMeta,
  t: TFunction<'admin'>,
): Promise<void> => {
  try {
    await onSaved?.(output, meta);
  } catch {
    // The write already committed, so the modal still closes — but never silently: the caller
    // could not apply/revalidate its cache, and the admin must know the screen is behind.
    toast.warning(t('agentCatalog.recovery.refreshFailed'));
  }
};

/** Step 3 — everything committed: say what landed, hand it to the caller, then close. */
export const announceAgentCommit = async ({
  meta,
  onClose,
  onSaved,
  output,
  t,
}: {
  meta: AgentEditorSaveMeta;
  onClose?: () => void;
  onSaved?: AgentEditorSavedHandler;
  output: AdminPlatformAgentSaveOutput | null;
  t: TFunction<'admin'>;
}): Promise<void> => {
  // A deferred invalidation means the new version is live but some servers still serve the old
  // one — say so instead of claiming an unqualified success.
  if (output?.invalidationStatus === 'deferred') {
    toast.warning(t('agentCatalog.toast.refreshDeferred'));
  } else {
    toast.success(t(meta.created ? 'agentCatalog.toast.created' : 'agentCatalog.toast.saved'));
  }
  await applyToCaller(onSaved, output, meta, t);
  onClose?.();
};

/** Step 3' — the submit was rejected: classify what (if anything) landed and say so. */
export const announceAgentCommitFailure = async ({
  cause,
  created,
  onSaved,
  progress,
  reconcile,
  setConflict,
  setError,
  setResumeBlocked,
  t,
}: {
  cause: unknown;
  created: boolean;
  onSaved?: AgentEditorSavedHandler;
  progress: AgentCommitProgress;
  reconcile: (agentId: string | undefined) => Promise<ReconcileAgentStatus>;
  setConflict: (next: boolean) => void;
  setError: (next: string | null) => void;
  setResumeBlocked: (next: boolean) => void;
  t: TFunction<'admin'>;
}): Promise<void> => {
  switch (
    await classifySubmitFailure({
      cas: progress.cas,
      cause,
      created,
      identityCommitted: progress.identityCommitted,
      reconcile,
    })
  ) {
    case 'conflict': {
      // A revision conflict is the SERVER refusing the write — a definitive "did not commit".
      setConflict(true);
      setError(null);
      return;
    }
    case 'resume-blocked': {
      // We could neither confirm nor rule out a commit. Retrying could duplicate the assistant.
      setResumeBlocked(true);
      setError(t('agentCatalog.editor.resumeBlocked'));
      break;
    }
    case 'partial-assignment': {
      // The assistant itself is live; only the distribution chain broke.
      setError(
        `${t('agentCatalog.assignment.partialFailure')} ${getAdminAgentErrorMessage(cause, t)}`,
      );
      await applyToCaller(onSaved, progress.output, { assignmentsChanged: true, created }, t);
      break;
    }
    case 'identity-failed': {
      setError(getAdminAgentErrorMessage(cause, t));
      break;
    }
  }
};
