/**
 * Reset-to-defaults orchestration (testable without React).
 *
 * Reset is still a two-step client workflow (save empty draft → publish) until a
 * server-side atomic command exists. Handlers dispatch a single typed transition
 * via `apply` so recovery invariants are not expressed as ad-hoc setter bursts.
 */

import type { DraftMap } from './settingsPolicyController';

export type ResetPartialFailure = {
  /** Draft token of the committed empty draft — required for restore CAS. */
  committedDraftToken: string;
  committedBaseRevision: number;
  /** Prior draft to put back on retry-restore. */
  priorDraft: DraftMap;
  reason: string;
  /** Last error from the failed publish or restore attempt (for footer). */
  lastError: string;
};

/** Single typed state transitions for reset / compensation / restore. */
export type SettingsPolicyResetTransition =
  | {
      kind: 'ADOPT_EMPTY_DRAFT';
      baseRevision: number;
      draftToken: string;
    }
  | {
      kind: 'RESET_PUBLISHED';
      priorBaseRevision: number;
      registryVersion: number;
    }
  | {
      kind: 'RESTORED';
      baseRevision: number;
      draft: DraftMap;
      draftToken: string;
    }
  | {
      kind: 'RESET_PARTIAL_FAILURE';
      partial: ResetPartialFailure;
    }
  | {
      kind: 'OPERATION_FAILED';
      error: string;
    }
  | {
      kind: 'UPDATE_PARTIAL_LAST_ERROR';
      lastError: string;
      prior: ResetPartialFailure;
    }
  | { kind: 'CLEAR_PARTIAL' };

export type ApplyResetTransition = (transition: SettingsPolicyResetTransition) => void;

export type ResetDraftService = {
  publish: (input: {
    expectedDraftToken: string;
    expectedRevision: number;
    reason: string;
  }) => Promise<unknown>;
  saveDraft: (input: {
    draft: DraftMap;
    expectedDraftToken: string;
    reason: string;
  }) => Promise<{ baseRevision: number; draftToken: string }>;
};

export const buildResetPartialFailure = (params: {
  committedBaseRevision: number;
  committedDraftToken: string;
  lastError: string;
  priorDraft: DraftMap;
  reason: string;
}): ResetPartialFailure => ({
  committedBaseRevision: params.committedBaseRevision,
  committedDraftToken: params.committedDraftToken,
  lastError: params.lastError,
  priorDraft: params.priorDraft,
  reason: params.reason,
});

export type ResetOrchestrationDeps = {
  apply: ApplyResetTransition;
  isRevisionConflict: (err: unknown) => boolean;
  mapError: (err: unknown) => string;
  onConflict: () => Promise<void>;
  onRefreshAfterCommit: () => Promise<unknown>;
  onToastError: (kind: 'resetFailed' | 'resetPartial' | 'restoreFailed') => void;
  /** Called after a successful reset publish (or successful retry-restore). */
  onToastSuccess?: (kind: 'reset' | 'retryRestore') => void;
  publishWithReauth: (run: () => Promise<unknown>) => Promise<unknown>;
  service: ResetDraftService;
};

/**
 * Two-phase reset: commit empty owned draft, then publish. On publish failure after
 * commit, restore prior draft; if restore also fails, enter RESET_PARTIAL_FAILURE.
 */
export const runResetDefaultsConfirm = async (
  params: ResetOrchestrationDeps & {
    baseToken: string;
    priorDraft: DraftMap;
    reason: string;
    registryVersion: number;
    priorBaseRevision: number;
  },
): Promise<void> => {
  const {
    apply,
    baseToken,
    isRevisionConflict,
    mapError,
    onConflict,
    onRefreshAfterCommit,
    onToastError,
    onToastSuccess,
    priorBaseRevision,
    priorDraft,
    publishWithReauth,
    reason,
    registryVersion,
    service,
  } = params;

  const resetDraft = {} as DraftMap;
  let saved: { baseRevision: number; draftToken: string } | null = null;

  try {
    saved = await service.saveDraft({
      draft: resetDraft,
      expectedDraftToken: baseToken,
      reason,
    });
    // Adopt the committed empty-draft CAS immediately so any later failure
    // still knows the authoritative server token.
    apply({
      kind: 'ADOPT_EMPTY_DRAFT',
      baseRevision: saved.baseRevision,
      draftToken: saved.draftToken,
    });
    const frozen = Object.freeze({
      expectedDraftToken: saved.draftToken,
      expectedRevision: saved.baseRevision,
      reason,
    });
    await publishWithReauth(() => service.publish({ ...frozen }));
    // Published — do not attempt a restore in the catch below.
    saved = null;
    apply({
      kind: 'RESET_PUBLISHED',
      priorBaseRevision,
      registryVersion,
    });
    // Success is based on the mutation, not the later refresh (XT-008).
    onToastSuccess?.('reset');
    await onRefreshAfterCommit();
  } catch (err) {
    if (isRevisionConflict(err) && !saved) {
      await onConflict();
      return;
    }

    // saveDraft committed an empty draft but publish never landed — attempt restore.
    if (saved) {
      try {
        const restored = await service.saveDraft({
          draft: priorDraft,
          expectedDraftToken: saved.draftToken,
          reason: `${reason} (restore)`,
        });
        apply({
          kind: 'RESTORED',
          baseRevision: restored.baseRevision,
          draft: priorDraft,
          draftToken: restored.draftToken,
        });
        if (isRevisionConflict(err)) {
          await onConflict();
          return;
        }
        apply({ kind: 'OPERATION_FAILED', error: mapError(err) });
        onToastError('resetFailed');
        return;
      } catch (restoreErr) {
        // Compensation failed: lock mutations, retain committed token, surface recovery UI.
        const partial = buildResetPartialFailure({
          committedBaseRevision: saved.baseRevision,
          committedDraftToken: saved.draftToken,
          lastError: `${mapError(err)} · ${mapError(restoreErr)}`,
          priorDraft,
          reason,
        });
        apply({ kind: 'RESET_PARTIAL_FAILURE', partial });
        onToastError('resetPartial');
        return;
      }
    }

    if (isRevisionConflict(err)) {
      await onConflict();
      return;
    }
    apply({ kind: 'OPERATION_FAILED', error: mapError(err) });
    onToastError('resetFailed');
  }
};

/** Retry restore after a partial reset failure (publish + restore both failed). */
export const runRetryResetRestore = async (
  params: ResetOrchestrationDeps & {
    partial: ResetPartialFailure;
  },
): Promise<void> => {
  const {
    apply,
    isRevisionConflict,
    mapError,
    onConflict,
    onRefreshAfterCommit,
    onToastError,
    onToastSuccess,
    partial,
    service,
  } = params;

  try {
    const restored = await service.saveDraft({
      draft: partial.priorDraft,
      expectedDraftToken: partial.committedDraftToken,
      reason: `${partial.reason} (restore)`,
    });
    apply({
      kind: 'RESTORED',
      baseRevision: restored.baseRevision,
      draft: partial.priorDraft,
      draftToken: restored.draftToken,
    });
    await onRefreshAfterCommit();
    onToastSuccess?.('retryRestore');
  } catch (err) {
    if (isRevisionConflict(err)) {
      apply({ kind: 'CLEAR_PARTIAL' });
      await onConflict();
      return;
    }
    const message = mapError(err);
    apply({ kind: 'UPDATE_PARTIAL_LAST_ERROR', lastError: message, prior: partial });
    onToastError('restoreFailed');
  }
};
