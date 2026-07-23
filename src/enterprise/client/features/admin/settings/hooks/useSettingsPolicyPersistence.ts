'use client';

import { toast } from '@lobehub/ui/base-ui';
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
import { refreshAdminSettingsDraft } from './useAdminSettings';

type DraftSnapshot = AdminSettingsGetDraftOutput;

export const useSettingsPolicyPersistence = (params: {
  activeBaseRevision: number;
  activeDraftToken: string;
  /** Trusted server auth method from getMyAccess — closed union for reauth APIs. */
  authMethod: AdminReauthAuthMethod | undefined;
  canPublish: boolean;
  canUpdate: boolean;
  conflictState: ConflictState;
  data: DraftSnapshot | undefined;
  dirty: boolean;
  dispatchConflict: Dispatch<ConflictEvent>;
  draft: DraftMap;
  enterRevisionConflict: () => Promise<void>;
  hydratedRef: MutableRefObject<boolean>;
  impact: { pathsWithOverrides: number; totalOverrideRows: number } | null;
  isServiceModelPublishedPath: (path: string) => boolean;
  mutate: KeyedMutator<DraftSnapshot>;
  originalBaseDraftRef: MutableRefObject<DraftMap>;
  ownPublishedOverrideCount: number;
  resetValidation: () => void;
  revisionConflict: boolean;
  setActiveBaseRevision: (revision: number) => void;
  setActiveDraftToken: (token: string) => void;
  setDirty: (dirty: boolean) => void;
  setDraft: Dispatch<SetStateAction<DraftMap>>;
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
}) => {
  const { t } = useTranslation('admin');
  const {
    activeBaseRevision,
    activeDraftToken,
    authMethod,
    canPublish,
    canUpdate,
    conflictState,
    data,
    dirty,
    dispatchConflict,
    draft,
    enterRevisionConflict,
    hydratedRef,
    impact,
    isServiceModelPublishedPath,
    mutate,
    originalBaseDraftRef,
    ownPublishedOverrideCount,
    resetValidation,
    revisionConflict,
    setActiveBaseRevision,
    setActiveDraftToken,
    setDirty,
    setDraft,
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
  } = params;

  const refreshAfterCommit = useCallback(async () => {
    const result = await runPostCommitRefresh({
      errorMessage: t('settingsPolicy.refresh.failed'),
      mutate,
      refresh: refreshAdminSettingsDraft,
    });
    if (result.ok) {
      // Only allow hydration from SWR after a successful refresh so stale data cannot
      // overwrite the committed local revision/token.
      hydratedRef.current = false;
      setRefreshError(null);
      return true;
    }
    setRefreshError(result.error);
    return false;
  }, [hydratedRef, mutate, setRefreshError, t]);

  const retryRefresh = useCallback(async () => {
    await refreshAfterCommit();
  }, [refreshAfterCommit]);

  const handleSaveDraft = useCallback(async () => {
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
      setSaveError(
        mapped ? t(mapped.i18nKey as never, { defaultValue: mapped.code }) : String(err),
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
        setValidationMsg(
          t('settingsPolicy.validateFail', {
            count: result.issues.length,
            first: result.issues[0]?.message ?? '',
          }),
        );
      }
    } catch (err) {
      resetValidation();
      const mapped = mapEnterpriseError(err);
      setValidationMsg(mapped ? mapped.code : String(err));
    }
  }, [
    activeBaseRevision,
    activeDraftToken,
    data?.baseRevision,
    data?.draftToken,
    dirty,
    draft,
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

  // Restore defaults: clear owned overrides and publish. Empty owned payload `{}` — server
  // policy-editor ownership preserves foreign service-model rows (do not send them from the client).
  const handleResetDefaults = useCallback(() => {
    if (
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
    const baseRevision = activeBaseRevision;
    // Current (clean) draft — restored if saveDraft commits but publish fails.
    const priorDraft = draft;
    const resetDraft = {} as DraftMap;
    openDangerConfirm({
      confirmText: t('settingsPolicy.resetDefaults'),
      content: t('settingsPolicy.resetDefaultsDesc'),
      onConfirm: async () => {
        const reason = t('settingsPolicy.resetReason');
        let saved: Awaited<ReturnType<typeof adminSettingsService.saveDraft>> | null = null;
        try {
          saved = await adminSettingsService.saveDraft({
            draft: resetDraft,
            expectedDraftToken: baseToken,
            reason,
          });
          const frozen = Object.freeze({
            expectedDraftToken: saved.draftToken,
            expectedRevision: saved.baseRevision,
            reason,
          });
          await withAdminReauthRetry(() => adminSettingsService.publish({ ...frozen }), {
            authMethod,
          });
          // Published — do not attempt a restore in the catch below.
          saved = null;
          clearLocalDraft(registryVersion, baseRevision);
          clearConflictDraft();
          setDraft({});
          setDirty(false);
          setSaveState('idle');
          setSaveError(null);
          setValidationMsg(null);
          setImpact(null);
          resetValidation();
          setRefreshError(null);
          await refreshAfterCommit();
        } catch (err) {
          // saveDraft committed an empty draft but publish never landed — put the prior
          // draft back so the server draft is not left cleared. Best-effort only.
          if (saved) {
            try {
              await adminSettingsService.saveDraft({
                draft: priorDraft,
                expectedDraftToken: saved.draftToken,
                reason: `${reason} (restore)`,
              });
            } catch {
              /* best-effort restore */
            }
          }
          const mapped = mapEnterpriseError(err);
          if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
            await enterRevisionConflict();
            return;
          }
          setSaveState('failed');
          setSaveError(
            mapped ? t(mapped.i18nKey as never, { defaultValue: mapped.code }) : String(err),
          );
          toast.error(t('settingsPolicy.resetFailed'));
        }
      },
      title: t('settingsPolicy.resetDefaults'),
    });
  }, [
    activeBaseRevision,
    activeDraftToken,
    authMethod,
    canPublish,
    canUpdate,
    data,
    dirty,
    draft,
    enterRevisionConflict,
    ownPublishedOverrideCount,
    refreshAfterCommit,
    resetValidation,
    revisionConflict,
    setDirty,
    setDraft,
    setImpact,
    setRefreshError,
    setSaveError,
    setSaveState,
    setValidationMsg,
    t,
  ]);

  return {
    handlePublish,
    handleResetDefaults,
    handleSaveDraft,
    handleValidate,
    retryRefresh,
  };
};
