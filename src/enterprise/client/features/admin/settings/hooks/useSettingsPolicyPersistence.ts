'use client';

import { toast } from '@lobehub/ui/base-ui';
import debug from 'debug';
import type { TFunction } from 'i18next';
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyedMutator } from 'swr';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  type AdminReauthAuthMethod,
  withAdminReauthRetry,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminSettingsService } from '@/enterprise/client/services/adminSettings';
import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import { openReasonModal } from '../../users/modals/openReasonModal';
import {
  canMutateAgainstBase,
  type ConflictEvent,
  type ConflictState,
} from '../conflictStateMachine';
import { clearLocalDraft } from '../localDraftStorage';
import type { DraftMap, SaveState } from '../settingsPolicyController';
import {
  clearConflictDraft,
  fingerprintDraft,
  projectPolicyEditorOwnedDraft,
} from '../settingsPolicyController';
import { runPostCommitRefresh } from '../settingsPolicyPostCommitRefresh';
import {
  type ResetPartialFailure,
  runResetDefaultsConfirm,
  runRetryResetRestore,
  type SettingsPolicyResetTransition,
} from '../settingsPolicyReset';
import { refreshAdminSettingsDraft } from './useAdminSettings';

type DraftSnapshot = AdminSettingsGetDraftOutput;

const log = debug('lobe-client:admin:settings-policy');

/**
 * CAS + draft identity the persistence commands mutate against.
 * Split from the 38-parameter god surface (ASI-003) so save/publish/reset share one view.
 */
export interface SettingsPolicyCasBindings {
  activeBaseRevision: number;
  activeDraftToken: string;
  conflictState: ConflictState;
  data: DraftSnapshot | undefined;
  dispatchConflict: Dispatch<ConflictEvent>;
  enterRevisionConflict: () => Promise<void>;
  revisionConflict: boolean;
  setActiveBaseRevision: (revision: number) => void;
  setActiveDraftToken: (token: string) => void;
}

/** Local draft editor state + setters owned by the page/editor hook. */
export interface SettingsPolicyDraftBindings {
  dirty: boolean;
  draft: DraftMap;
  isServiceModelPublishedPath: (path: string) => boolean;
  observedServerSnapshotRef: MutableRefObject<string | null>;
  originalBaseDraftRef: MutableRefObject<DraftMap>;
  setDirty: (dirty: boolean) => void;
  setDraft: Dispatch<SetStateAction<DraftMap>>;
}

/** Validation fingerprint + user-facing feedback surface. */
export interface SettingsPolicyFeedbackBindings {
  impact: { pathsWithOverrides: number; totalOverrideRows: number } | null;
  resetValidation: () => void;
  setImpact: Dispatch<
    SetStateAction<{ pathsWithOverrides: number; totalOverrideRows: number } | null>
  >;
  setRefreshError: (error: string | null) => void;
  setSaveError: (error: string | null) => void;
  setSaveState: (state: SaveState) => void;
  setValidatedBaseRevision: (revision: number | null) => void;
  setValidatedDraftToken: (token: string | null) => void;
  setValidatedFingerprint: (fingerprint: string | null) => void;
  setValidationMsg: (msg: string | null) => void;
  validatedBaseRevision: number | null;
  validatedDraftToken: string | null;
  validatedFingerprint: string | null;
}

export interface SettingsPolicyPersistenceParams {
  authMethod: AdminReauthAuthMethod | undefined;
  canPublish: boolean;
  canUpdate: boolean;
  cas: SettingsPolicyCasBindings;
  draftEditor: SettingsPolicyDraftBindings;
  feedback: SettingsPolicyFeedbackBindings;
  mutate: KeyedMutator<DraftSnapshot>;
  ownPublishedOverrideCount: number;
  /** Partial reset failure — when set, all other mutations must stay locked. */
  resetPartialFailure: ResetPartialFailure | null;
  setResetPartialFailure: (value: ResetPartialFailure | null) => void;
}

const mapUserFacingError = (err: unknown, t: TFunction<'admin'>): string => {
  const mapped = mapEnterpriseError(err);
  const generic = t('settingsPolicy.errors.generic', {
    defaultValue: 'The operation failed. Try again.',
  });
  // Never fall back to a wire code or raw exception text (XT-004 / ASI-010).
  if (mapped?.i18nKey) return t(mapped.i18nKey as never, { defaultValue: generic });
  return generic;
};

/** Map server validation issue codes to safe, path-interpolated copy — never issue.message. */
const formatValidationIssue = (
  issue: { code: string; path: string },
  t: TFunction<'admin'>,
): string => {
  const path = issue.path || '';
  const key = `settingsPolicy.validation.${issue.code}`;
  return t(key as never, {
    defaultValue: t('settingsPolicy.validation.generic', {
      defaultValue: 'Invalid value at {{path}}',
      path,
    }),
    path,
  });
};

export const useSettingsPolicyPersistence = (params: SettingsPolicyPersistenceParams) => {
  const { t } = useTranslation('admin');
  const {
    authMethod,
    canPublish,
    canUpdate,
    cas,
    draftEditor,
    feedback,
    mutate,
    ownPublishedOverrideCount,
    resetPartialFailure,
    setResetPartialFailure,
  } = params;

  const {
    activeBaseRevision,
    activeDraftToken,
    conflictState,
    data,
    dispatchConflict,
    enterRevisionConflict,
    revisionConflict,
    setActiveBaseRevision,
    setActiveDraftToken,
  } = cas;

  const {
    dirty,
    draft,
    isServiceModelPublishedPath,
    observedServerSnapshotRef,
    originalBaseDraftRef,
    setDirty,
    setDraft,
  } = draftEditor;

  const {
    impact,
    resetValidation,
    setImpact,
    setRefreshError,
    setSaveError,
    setSaveState,
    setValidatedBaseRevision,
    setValidatedDraftToken,
    setValidatedFingerprint,
    setValidationMsg,
    validatedBaseRevision,
    validatedDraftToken,
    validatedFingerprint,
  } = feedback;

  const mutationsLocked = Boolean(resetPartialFailure) || revisionConflict;

  const refreshAfterCommit = useCallback(async () => {
    const result = await runPostCommitRefresh({
      errorMessage: t('settingsPolicy.refresh.failed'),
      mutate,
      refresh: refreshAdminSettingsDraft,
    });
    if (result.ok) {
      // Only allow hydration from SWR after a successful refresh so stale data cannot
      // overwrite the committed local revision/token.
      observedServerSnapshotRef.current = null;
      setRefreshError(null);
      return true;
    }
    setRefreshError(result.error);
    return false;
  }, [mutate, observedServerSnapshotRef, setRefreshError, t]);

  const retryRefresh = useCallback(async () => {
    await refreshAfterCommit();
  }, [refreshAfterCommit]);

  const handleSaveDraft = useCallback(async () => {
    if (mutationsLocked) return;
    if (
      !data ||
      !canUpdate ||
      revisionConflict ||
      activeBaseRevision !== data.baseRevision ||
      activeDraftToken !== data.draftToken ||
      !canMutateAgainstBase(conflictState, activeBaseRevision, activeDraftToken)
    ) {
      if (data && !revisionConflict) await enterRevisionConflict();
      return;
    }
    setSaveState('saving');
    setSaveError(null);
    setRefreshError(null);
    // Project only policy-editor-owned paths; server merges foreign service-model rows.
    const ownedDraft = projectPolicyEditorOwnedDraft(draft, isServiceModelPublishedPath);
    try {
      const result = await adminSettingsService.saveDraft({
        draft: ownedDraft,
        expectedDraftToken: activeDraftToken,
        reason: t('settingsPolicy.saveReason'),
      });
      clearLocalDraft(data.registryVersion, activeBaseRevision);
      clearConflictDraft();
      // Committed local state is authoritative even if post-commit refresh fails.
      setDraft(ownedDraft);
      setDirty(false);
      setSaveState('saved');
      resetValidation();
      setActiveBaseRevision(result.baseRevision);
      setActiveDraftToken(result.draftToken);
      originalBaseDraftRef.current = ownedDraft;
      dispatchConflict({ type: 'CLEAR' });
      await refreshAfterCommit();
    } catch (err) {
      const mapped = mapEnterpriseError(err);
      if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
        await enterRevisionConflict();
        return;
      }
      setSaveState('failed');
      setSaveError(mapUserFacingError(err, t));
      toast.error(
        t('settingsPolicy.errors.saveFailed', {
          defaultValue: 'Could not save the draft. Try again.',
        }),
      );
    }
  }, [
    activeBaseRevision,
    activeDraftToken,
    canUpdate,
    conflictState,
    data,
    dispatchConflict,
    draft,
    enterRevisionConflict,
    isServiceModelPublishedPath,
    mutationsLocked,
    originalBaseDraftRef,
    refreshAfterCommit,
    resetValidation,
    revisionConflict,
    setActiveBaseRevision,
    setActiveDraftToken,
    setDirty,
    setDraft,
    setRefreshError,
    setSaveError,
    setSaveState,
    t,
  ]);

  const handleValidate = useCallback(async () => {
    if (mutationsLocked) return;
    if (
      dirty ||
      revisionConflict ||
      activeBaseRevision !== data?.baseRevision ||
      activeDraftToken !== data?.draftToken
    ) {
      setValidationMsg(t('settingsPolicy.validateRequiresSaved'));
      return;
    }
    setValidationMsg(null);
    try {
      const result = await adminSettingsService.validateDraft({ draft });
      setImpact(result.impactEstimate);
      if (result.ok) {
        setValidationMsg(t('settingsPolicy.validateOk'));
        setValidatedFingerprint(fingerprintDraft(draft));
        setValidatedDraftToken(activeDraftToken);
        setValidatedBaseRevision(activeBaseRevision);
      } else {
        resetValidation();
        const firstIssue = result.issues[0];
        const first = firstIssue
          ? formatValidationIssue(firstIssue, t)
          : t('settingsPolicy.validation.generic', {
              defaultValue: 'Invalid value',
              path: '',
            });
        setValidationMsg(
          t('settingsPolicy.validateFail', {
            count: result.issues.length,
            first,
          }),
        );
      }
    } catch (err) {
      resetValidation();
      setValidationMsg(
        t('settingsPolicy.validateRequestFailed', {
          defaultValue: 'Could not validate the draft. Try again.',
        }),
      );
      // Keep the technical cause out of the UI; log mapped label for diagnostics only.
      log('validate request failed: %s %O', mapUserFacingError(err, t), err);
    }
  }, [
    activeBaseRevision,
    activeDraftToken,
    data?.baseRevision,
    data?.draftToken,
    dirty,
    draft,
    mutationsLocked,
    resetValidation,
    revisionConflict,
    setImpact,
    setValidatedBaseRevision,
    setValidatedDraftToken,
    setValidatedFingerprint,
    setValidationMsg,
    t,
  ]);

  const handlePublish = useCallback(() => {
    if (mutationsLocked) return;
    if (
      !data ||
      !canPublish ||
      dirty ||
      revisionConflict ||
      activeBaseRevision !== data.baseRevision ||
      activeDraftToken !== data.draftToken ||
      !canMutateAgainstBase(conflictState, activeBaseRevision, activeDraftToken)
    ) {
      if (
        data &&
        !revisionConflict &&
        (activeBaseRevision !== data.baseRevision || activeDraftToken !== data.draftToken)
      ) {
        void enterRevisionConflict();
      }
      return;
    }
    if (
      validatedFingerprint !== fingerprintDraft(draft) ||
      validatedDraftToken !== activeDraftToken ||
      validatedBaseRevision !== activeBaseRevision
    ) {
      setValidationMsg(t('settingsPolicy.publishRequiresValidate'));
      return;
    }
    const confirmationDraftToken = activeDraftToken;
    const confirmationBaseRevision = activeBaseRevision;
    openReasonModal({
      authMethod,
      buildPayload: (reason) => ({
        expectedDraftToken: confirmationDraftToken,
        expectedRevision: confirmationBaseRevision,
        reason,
      }),
      description: t('settingsPolicy.publishDesc'),
      impact: impact
        ? t('settingsPolicy.impactSummary', {
            paths: impact.pathsWithOverrides,
            rows: impact.totalOverrideRows,
          })
        : undefined,
      onSubmit: async (payload) => {
        try {
          await adminSettingsService.publish(
            payload as { expectedDraftToken: string; expectedRevision: number; reason: string },
          );
          clearLocalDraft(data.registryVersion, data.baseRevision);
          clearConflictDraft();
          setDirty(false);
          dispatchConflict({ type: 'CLEAR' });
          setRefreshError(null);
          // Success is based on the mutation, not the later refresh (XT-008).
          toast.success(
            t('settingsPolicy.publishSuccess', {
              defaultValue: 'Settings policy published.',
            }),
          );
          // Publish committed — refresh is retry-only so a failure never re-publishes.
          await refreshAfterCommit();
        } catch (err) {
          const mapped = mapEnterpriseError(err);
          if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
            await enterRevisionConflict();
          }
          throw err;
        }
      },
      submitLabel: t('settingsPolicy.publish'),
      targetLabel: t('settingsPolicy.title'),
      title: t('settingsPolicy.publish'),
    });
  }, [
    activeBaseRevision,
    activeDraftToken,
    authMethod,
    canPublish,
    conflictState,
    data,
    dirty,
    dispatchConflict,
    draft,
    enterRevisionConflict,
    impact,
    mutationsLocked,
    refreshAfterCommit,
    revisionConflict,
    setDirty,
    setRefreshError,
    setValidationMsg,
    t,
    validatedFingerprint,
    validatedDraftToken,
    validatedBaseRevision,
  ]);

  /**
   * Apply one reset/compensation transition. All coordinated setter bursts for
   * reset live here so handlers only call `apply(transition)` once (ASI-003).
   */
  const applyResetTransition = useCallback(
    (transition: SettingsPolicyResetTransition) => {
      switch (transition.kind) {
        case 'ADOPT_EMPTY_DRAFT': {
          setActiveBaseRevision(transition.baseRevision);
          setActiveDraftToken(transition.draftToken);
          return;
        }
        case 'RESET_PUBLISHED': {
          clearLocalDraft(transition.registryVersion, transition.priorBaseRevision);
          clearConflictDraft();
          setDraft({});
          setDirty(false);
          setSaveState('idle');
          setSaveError(null);
          setValidationMsg(null);
          setImpact(null);
          resetValidation();
          setRefreshError(null);
          setResetPartialFailure(null);
          return;
        }
        case 'RESTORED': {
          setDraft(transition.draft);
          setDirty(false);
          setActiveBaseRevision(transition.baseRevision);
          setActiveDraftToken(transition.draftToken);
          originalBaseDraftRef.current = transition.draft;
          setSaveState('idle');
          setSaveError(null);
          setValidationMsg(null);
          setImpact(null);
          resetValidation();
          setResetPartialFailure(null);
          dispatchConflict({ type: 'CLEAR' });
          return;
        }
        case 'RESET_PARTIAL_FAILURE': {
          const { partial } = transition;
          setResetPartialFailure(partial);
          setActiveBaseRevision(partial.committedBaseRevision);
          setActiveDraftToken(partial.committedDraftToken);
          setDraft({});
          setDirty(false);
          setSaveState('failed');
          setSaveError(partial.lastError);
          return;
        }
        case 'OPERATION_FAILED': {
          setSaveState('failed');
          setSaveError(transition.error);
          return;
        }
        case 'UPDATE_PARTIAL_LAST_ERROR': {
          setResetPartialFailure({
            ...transition.prior,
            lastError: transition.lastError,
          });
          setSaveState('failed');
          setSaveError(transition.lastError);
          return;
        }
        case 'CLEAR_PARTIAL': {
          setResetPartialFailure(null);
          return;
        }
        default: {
          const _exhaustive: never = transition;
          return _exhaustive;
        }
      }
    },
    [
      dispatchConflict,
      originalBaseDraftRef,
      resetValidation,
      setActiveBaseRevision,
      setActiveDraftToken,
      setDirty,
      setDraft,
      setImpact,
      setRefreshError,
      setResetPartialFailure,
      setSaveError,
      setSaveState,
      setValidationMsg,
    ],
  );

  const isRevisionConflict = useCallback(
    (err: unknown) => mapEnterpriseError(err)?.code === 'PLATFORM_REVISION_CONFLICT',
    [],
  );

  const mapError = useCallback((err: unknown) => mapUserFacingError(err, t), [t]);

  const toastResetError = useCallback(
    (kind: 'resetFailed' | 'resetPartial' | 'restoreFailed') => {
      if (kind === 'resetFailed') toast.error(t('settingsPolicy.resetFailed'));
      else if (kind === 'resetPartial') toast.error(t('settingsPolicy.resetPartial.title'));
      else toast.error(t('settingsPolicy.resetPartial.restoreFailed'));
    },
    [t],
  );

  const toastResetSuccess = useCallback(() => {
    toast.success(
      t('settingsPolicy.resetSuccess', {
        defaultValue: 'Platform defaults restored.',
      }),
    );
  }, [t]);

  const retryResetRestore = useCallback(async () => {
    if (!resetPartialFailure) return;
    await runRetryResetRestore({
      apply: applyResetTransition,
      isRevisionConflict,
      mapError,
      onConflict: enterRevisionConflict,
      onRefreshAfterCommit: refreshAfterCommit,
      onToastError: toastResetError,
      onToastSuccess: () => {
        toast.success(t('settingsPolicy.resetPartial.retryRestore'));
      },
      partial: resetPartialFailure,
      publishWithReauth: (run) => withAdminReauthRetry(run, { authMethod }),
      service: adminSettingsService,
    });
  }, [
    applyResetTransition,
    authMethod,
    enterRevisionConflict,
    isRevisionConflict,
    mapError,
    refreshAfterCommit,
    resetPartialFailure,
    t,
    toastResetError,
  ]);

  // Clear partial recovery only after a successful refresh — a failed refresh must keep
  // the committed empty-draft token and Retry restore affordance (ASI-002 via dismiss path).
  const dismissResetPartialByRefresh = useCallback(async () => {
    const ok = await refreshAfterCommit();
    if (!ok) return;
    setResetPartialFailure(null);
    setSaveState('idle');
    setSaveError(null);
  }, [refreshAfterCommit, setResetPartialFailure, setSaveError, setSaveState]);

  // Restore defaults: clear owned overrides and publish. Empty owned payload `{}` — server
  // policy-editor ownership preserves foreign service-model rows (do not send them from the client).
  const handleResetDefaults = useCallback(() => {
    if (
      mutationsLocked ||
      !data ||
      !canPublish ||
      !canUpdate ||
      dirty ||
      revisionConflict ||
      activeBaseRevision !== data.baseRevision ||
      activeDraftToken !== data.draftToken ||
      ownPublishedOverrideCount === 0
    ) {
      return;
    }
    const registryVersion = data.registryVersion;
    const baseToken = activeDraftToken;
    const priorBaseRevision = activeBaseRevision;
    // Current (clean) draft — restored if saveDraft commits but publish fails.
    const priorDraft = draft;
    openDangerConfirm({
      confirmText: t('settingsPolicy.resetDefaults'),
      content: t('settingsPolicy.resetDefaultsDesc'),
      onConfirm: async () => {
        await runResetDefaultsConfirm({
          apply: applyResetTransition,
          baseToken,
          isRevisionConflict,
          mapError,
          onConflict: enterRevisionConflict,
          onRefreshAfterCommit: refreshAfterCommit,
          onToastError: toastResetError,
          onToastSuccess: toastResetSuccess,
          priorBaseRevision,
          priorDraft,
          publishWithReauth: (run) => withAdminReauthRetry(run, { authMethod }),
          reason: t('settingsPolicy.resetReason'),
          registryVersion,
          service: adminSettingsService,
        });
      },
      title: t('settingsPolicy.resetDefaults'),
    });
  }, [
    activeBaseRevision,
    activeDraftToken,
    applyResetTransition,
    authMethod,
    canPublish,
    canUpdate,
    data,
    dirty,
    draft,
    enterRevisionConflict,
    isRevisionConflict,
    mapError,
    mutationsLocked,
    ownPublishedOverrideCount,
    refreshAfterCommit,
    revisionConflict,
    t,
    toastResetError,
    toastResetSuccess,
  ]);

  return {
    dismissResetPartialByRefresh,
    handlePublish,
    handleResetDefaults,
    handleSaveDraft,
    handleValidate,
    retryRefresh,
    retryResetRestore,
  };
};
