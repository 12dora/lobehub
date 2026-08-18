'use client';

import { toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';

import { AGENT_ARCHIVE_AUTO_REASON } from '@/enterprise/client/features/admin/audit/shared/auditReasonCodes';
import {
  type AdminReauthAuthMethod,
  AdminReauthBlockedError,
  AdminReauthCancelledError,
  isAdminReauthRequiredError,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import {
  openReasonModal,
  type ReasonModalPhase,
} from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import { getAdminAgentErrorMessage } from './errorPresentation';
import { AGENT_DELETE_AUTO_REASON } from './openDeleteAgentModal';
import type { AdminAgentListItem, AdminPlatformAgentGetOutput } from './types';

/** How many names / failures are spelled out before the copy switches to a count. */
const PREVIEW = 3;

export interface AgentBulkTarget {
  id: string;
  label: string;
}

export interface AgentBulkResult {
  /** Re-authentication was cancelled or blocked: the batch stopped before finishing. */
  cancelled: boolean;
  failed: { label: string; reason: string }[];
  /** Targets the batch never got to because it stopped early. */
  pending: number;
  /** Selected rows the action could never apply to (default / system / already archived). */
  skipped: number;
  succeeded: number;
}

/**
 * Per-target outcome, kept outside the modal submit so the one reauth retry re-enters the loop
 * without replaying a committed write.
 */
interface AgentBulkProgress {
  /** target id → already-translated failure reason. */
  failed: Map<string, string>;
  succeeded: Set<string>;
}

/**
 * Archiving is one-way and the default assistant needs a successor picked by hand, so bulk archive
 * only takes published, non-default rows. Everything else is reported as skipped.
 */
export const selectArchivableAgents = (rows: readonly AdminAgentListItem[]): AdminAgentListItem[] =>
  rows.filter((row) => row.identity.status === 'published' && !row.identity.isDefault);

/** The server refuses to hard-delete the default assistant or a system one — mirror that here. */
export const selectDeletableAgents = (rows: readonly AdminAgentListItem[]): AdminAgentListItem[] =>
  rows.filter((row) => !row.identity.isDefault && row.identity.systemKey === null);

export const toAgentBulkTargets = (rows: readonly AdminAgentListItem[]): AgentBulkTarget[] =>
  rows.map((row) => ({ id: row.identity.id, label: row.displayName }));

export const formatAgentBulkLabel = (
  targets: readonly AgentBulkTarget[],
  t: TFunction<'admin'>,
): string => {
  const names = targets.slice(0, PREVIEW).map((target) => target.label);
  if (targets.length <= PREVIEW) return names.join(', ');
  return `${names.join(', ')} ${t('agentCatalog.bulk.more', { count: targets.length - PREVIEW })}`;
};

/**
 * Reauth belongs to the enclosing modal submit, which wraps this loop in a single
 * `withAdminReauthRetry`. Anything reauth-shaped is handed straight back so one prompt covers the
 * whole batch — it must never be recorded as an ordinary per-row failure.
 */
const isReauthSignal = (error: unknown): boolean =>
  isAdminReauthRequiredError(error) ||
  error instanceof AdminReauthCancelledError ||
  error instanceof AdminReauthBlockedError;

const summariseAgentBulkProgress = (params: {
  cancelled: boolean;
  progress: AgentBulkProgress;
  skipped: number;
  targets: readonly AgentBulkTarget[];
}): AgentBulkResult => {
  const { cancelled, progress, skipped, targets } = params;
  // Selection order, not completion order, so the summary reads like the table.
  const failed = targets
    .filter((target) => progress.failed.has(target.id))
    .map((target) => ({ label: target.label, reason: progress.failed.get(target.id)! }));
  const succeeded = targets.filter((target) => progress.succeeded.has(target.id)).length;

  return {
    cancelled,
    failed,
    pending: targets.length - succeeded - failed.length,
    skipped,
    succeeded,
  };
};

/**
 * Sequential loop over the existing single-row procedures — there is no bulk endpoint, and both
 * writes are CAS-guarded dangerous mutations.
 *
 * List rows carry no `draftToken`, so every item reads its authoritative snapshot immediately
 * before writing. The whole loop runs inside the reason modal's reauth-capable submit: a
 * reauth-required write throws out of here, the modal prompts once, and the retry re-enters this
 * loop with the same `progress` so committed targets are skipped rather than written twice.
 */
export const runBulkAgentMutations = async (params: {
  mutate: (snapshot: AdminPlatformAgentGetOutput, target: AgentBulkTarget) => Promise<unknown>;
  progress: AgentBulkProgress;
  skipped: number;
  t: TFunction<'admin'>;
  targets: readonly AgentBulkTarget[];
}): Promise<AgentBulkResult> => {
  const { mutate, progress, targets } = params;

  for (const target of targets) {
    // Settled on an earlier attempt — a committed write is never replayed, and a recorded
    // failure keeps its original reason instead of being re-run behind the operator's back.
    if (progress.succeeded.has(target.id) || progress.failed.has(target.id)) continue;

    try {
      const snapshot = await adminAgentsService.get({ id: target.id });
      await mutate(snapshot, target);
      progress.succeeded.add(target.id);
    } catch (error) {
      // Stop the batch: no further reads or writes while the operator is being asked to
      // re-authenticate, and no second prompt from the next target.
      if (isReauthSignal(error)) throw error;
      progress.failed.set(target.id, getAdminAgentErrorMessage(error, params.t));
    }
  }

  return summariseAgentBulkProgress({
    cancelled: false,
    progress,
    skipped: params.skipped,
    targets,
  });
};

export const toastAgentBulkSummary = (result: AgentBulkResult, t: TFunction<'admin'>) => {
  const skipped =
    result.skipped > 0
      ? ` · ${t('agentCatalog.toast.bulkSkipped', { count: result.skipped })}`
      : '';

  const detail = result.failed
    .slice(0, PREVIEW)
    .map((item) =>
      t('agentCatalog.toast.bulkFailureDetail', { label: item.label, reason: item.reason }),
    )
    .join(' · ');

  const head =
    result.failed.length === 0
      ? t('agentCatalog.toast.bulkDone', { count: result.succeeded })
      : t('agentCatalog.toast.bulkSummary', {
          failed: result.failed.length,
          succeeded: result.succeeded,
        });

  const body = `${head}${skipped}${detail ? ` — ${detail}` : ''}`;

  // A stopped batch is not a failure: lead with what was left untouched, keep what committed.
  if (result.cancelled) {
    const cancelled = t('agentCatalog.toast.bulkCancelled', { count: result.pending });
    // Nothing landed before the stop — the untouched count is the whole story.
    const progress = result.succeeded > 0 || result.failed.length > 0 ? ` · ${body}` : skipped;
    toast.warning(`${cancelled}${progress}`);
    return;
  }

  if (result.failed.length === 0) {
    toast.success(body);
    return;
  }

  toast.warning(body);
};

interface BulkModalParams {
  authMethod?: AdminReauthAuthMethod | null;
  onDone?: () => void | Promise<void>;
  rows: readonly AdminAgentListItem[];
  t: TFunction<'admin'>;
}

/** Selected rows that this action cannot touch, spelled out in the confirmation. */
const skippedNotice = (skipped: number, t: TFunction<'admin'>): string | undefined =>
  skipped > 0 ? t('agentCatalog.bulk.skipped', { count: skipped }) : undefined;

/**
 * One confirmation, one reauth, one summary for the whole batch.
 *
 * The modal's submit already owns the interactive reauth retry, so the loop lives inside it: the
 * first dangerous write may prompt and the recent-reauth window then covers the rest. When the
 * prompt is cancelled or blocked the submit is never re-entered, so the batch is settled from the
 * phase change instead — reporting what committed and revalidating the list.
 */
const openBulkAgentsModal = (params: {
  authMethod?: AdminReauthAuthMethod | null;
  autoReason: string;
  description: string;
  impact?: string;
  mutate: (
    snapshot: AdminPlatformAgentGetOutput,
    target: AgentBulkTarget,
    reason: string,
  ) => Promise<unknown>;
  onDone?: () => void | Promise<void>;
  skipped: number;
  submitLabel: string;
  t: TFunction<'admin'>;
  targets: readonly AgentBulkTarget[];
  title: string;
}) => {
  const { authMethod, mutate, onDone, skipped, t, targets } = params;
  const progress: AgentBulkProgress = { failed: new Map(), succeeded: new Set() };
  let settled = false;
  let previousPhase: ReasonModalPhase = 'idle';

  /**
   * Summarise once and hand the list refresh back to the caller: revalidating the table can take
   * a while, so paths that must not stay open close first and let the refresh run in the
   * background. Returns `undefined` when the batch was already settled.
   */
  const settle = (cancelled: boolean): Promise<void> | undefined => {
    if (settled) return undefined;
    settled = true;
    toastAgentBulkSummary(summariseAgentBulkProgress({ cancelled, progress, skipped, targets }), t);
    return Promise.resolve(onDone?.());
  };

  const instance = openReasonModal({
    authMethod: authMethod ?? undefined,
    autoReason: params.autoReason,
    buildPayload: (reason) => ({ reason }),
    danger: true,
    description: params.description,
    hideReason: true,
    impact: params.impact,
    submitLabel: params.submitLabel,
    targetLabel: formatAgentBulkLabel(targets, t),
    title: params.title,
    onPhaseChange: (phase) => {
      const from = previousPhase;
      previousPhase = phase;
      // Leaving the reauth prompt for idle means it was cancelled, blocked or timed out: the
      // submit never runs again, so close the batch out here rather than leaving the operator
      // with a half-applied selection and a modal waiting on nothing.
      if (from !== 'reauthing' || phase !== 'idle') return;
      // Settle and close in the same tick: while the refresh is in flight the modal would be
      // back at `idle` with the destructive button live again, and a second click would process
      // the pending targets after the batch already reported cancellation.
      const refresh = settle(true);
      instance.close();
      // Nothing left to report — the summary already ran, and the refresh owns its own recovery.
      void refresh?.catch(() => {});
    },
    onSubmit: async (payload) => {
      // The cancelled prompt settles the batch from the phase change above; a late click on a
      // stale submit button must not re-enter the loop for the targets it left pending.
      if (settled) return;
      const { reason } = payload as { reason: string };
      await runBulkAgentMutations({
        progress,
        skipped,
        t,
        targets,
        mutate: (snapshot, target) => mutate(snapshot, target, reason),
      });
      await settle(false);
    },
  });
};

export const openBulkArchiveAgentsModal = ({ authMethod, onDone, rows, t }: BulkModalParams) => {
  const eligible = selectArchivableAgents(rows);
  if (eligible.length === 0) return;
  const targets = toAgentBulkTargets(eligible);
  const skipped = rows.length - eligible.length;

  openBulkAgentsModal({
    authMethod,
    autoReason: AGENT_ARCHIVE_AUTO_REASON,
    description: t('agentCatalog.bulk.archive.description', { count: targets.length }),
    impact: skippedNotice(skipped, t),
    onDone,
    skipped,
    submitLabel: t('agentCatalog.bulk.archive.submit'),
    t,
    targets,
    title: t('agentCatalog.bulk.archive.title'),
    // Only non-default rows reach here, so no successor is ever required.
    mutate: (snapshot, _target, reason) =>
      adminAgentsService.archive({
        agentId: snapshot.identity.id,
        expectedDraftToken: snapshot.draftToken,
        expectedRevision: snapshot.identity.revision,
        reason,
        replacementAgentId: null,
      }),
  });
};

export const openBulkDeleteAgentsModal = ({ authMethod, onDone, rows, t }: BulkModalParams) => {
  const eligible = selectDeletableAgents(rows);
  if (eligible.length === 0) return;
  const targets = toAgentBulkTargets(eligible);
  const skipped = rows.length - eligible.length;

  openBulkAgentsModal({
    authMethod,
    autoReason: AGENT_DELETE_AUTO_REASON,
    description: t('agentCatalog.bulk.delete.description', { count: targets.length }),
    impact: skippedNotice(skipped, t) ?? t('agentCatalog.delete.impact'),
    onDone,
    skipped,
    submitLabel: t('agentCatalog.bulk.delete.submit'),
    t,
    targets,
    title: t('agentCatalog.bulk.delete.title'),
    mutate: (snapshot, _target, reason) =>
      adminAgentsService.delete({
        agentId: snapshot.identity.id,
        expectedDraftToken: snapshot.draftToken,
        expectedRevision: snapshot.identity.revision,
        reason,
      }),
  });
};
