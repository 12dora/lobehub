'use client';

import { toast } from '@lobehub/ui/base-ui';
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
import type { DraftMap, SaveState } from '../settingsPolicyController';
import { projectPolicyEditorOwnedDraft } from '../settingsPolicyController';
import { runPostCommitRefresh } from '../settingsPolicyPostCommitRefresh';
import { refreshAdminSettingsDraft } from './useAdminSettings';

type DraftSnapshot = AdminSettingsGetDraftOutput;

/**
 * Conflict recovery state. `reloaded` is only reachable after the authoritative reload
 * succeeded; `reloadFailed` keeps the local edits and offers a retry.
 */
export type SettingsPolicyConflictState = 'none' | 'reloaded' | 'reloadFailed';

/** CAS identity + editor state the save command reads and rewrites. */
export interface SettingsPolicySaveBindings {
  activeBaseRevision: number;
  activeDraftToken: string;
  data: DraftSnapshot | undefined;
  draft: DraftMap;
  /**
   * The editor diverges from the published policy. Saveability derives from this effective
   * diff, never from a sticky `dirty` flag: a legacy stranded draft (loaded, not yet edited)
   * must be appliable with one save, and reverting an edit must disable it again.
   */
  hasEffectiveChanges: boolean;
  isServiceModelPublishedPath: (path: string) => boolean;
  observedServerSnapshotRef: MutableRefObject<string | null>;
  saveState: SaveState;
  setActiveBaseRevision: (revision: number) => void;
  setActiveDraftToken: (token: string) => void;
  setDirty: (dirty: boolean) => void;
  setDraft: Dispatch<SetStateAction<DraftMap>>;
}

/** User-facing feedback surface owned by the page. */
export interface SettingsPolicyFeedbackBindings {
  /** Inline "someone else saved" alert — reloaded, or reload failed with a retry. */
  setConflictState: (state: SettingsPolicyConflictState) => void;
  setRefreshError: (error: string | null) => void;
  setSaveError: (error: string | null) => void;
  setSaveState: (state: SaveState) => void;
}

export interface SettingsPolicyPersistenceParams {
  authMethod: AdminReauthAuthMethod | undefined;
  /** Save applies site-wide, so it needs SETTINGS_UPDATE *and* SETTINGS_PUBLISH. */
  canSave: boolean;
  editor: SettingsPolicySaveBindings;
  feedback: SettingsPolicyFeedbackBindings;
  mutate: KeyedMutator<DraftSnapshot>;
  ownPublishedOverrideCount: number;
}

type SaveOutcome = 'conflict' | 'failed' | 'saved';

const mapUserFacingError = (err: unknown, t: TFunction<'admin'>): string => {
  const mapped = mapEnterpriseError(err);
  const generic = t('settingsPolicy.errors.generic', {
    defaultValue: 'The operation failed. Try again.',
  });
  // Never fall back to a wire code or raw exception text (XT-004 / ASI-010).
  if (mapped?.i18nKey) return t(mapped.i18nKey as never, { defaultValue: generic });
  return generic;
};

export const useSettingsPolicyPersistence = (params: SettingsPolicyPersistenceParams) => {
  const { t } = useTranslation('admin');
  const { authMethod, canSave, editor, feedback, mutate, ownPublishedOverrideCount } = params;

  const {
    activeBaseRevision,
    activeDraftToken,
    data,
    draft,
    hasEffectiveChanges,
    isServiceModelPublishedPath,
    observedServerSnapshotRef,
    saveState,
    setActiveBaseRevision,
    setActiveDraftToken,
    setDirty,
    setDraft,
  } = editor;

  const { setConflictState, setRefreshError, setSaveError, setSaveState } = feedback;

  /** Load the authoritative snapshot. Returns the user-facing error, or `null` on success. */
  const reloadFromServer = useCallback(async () => {
    const result = await runPostCommitRefresh({
      errorMessage: t('settingsPolicy.refresh.failed'),
      mutate,
      refresh: refreshAdminSettingsDraft,
    });
    if (!result.ok) return result.error;
    // Only allow hydration from SWR after a successful refresh so stale data cannot
    // overwrite the committed local revision/token.
    observedServerSnapshotRef.current = null;
    return null;
  }, [mutate, observedServerSnapshotRef, t]);

  const refreshAfterCommit = useCallback(async () => {
    const error = await reloadFromServer();
    setRefreshError(error);
    return !error;
  }, [reloadFromServer, setRefreshError]);

  const retryRefresh = useCallback(async () => {
    await refreshAfterCommit();
  }, [refreshAfterCommit]);

  /**
   * Someone else saved against the same base — nothing of ours committed. There is no draft
   * to rebase any more, so the recovery is: reload the live policy, then drop the local edits.
   * The edits are dropped ONLY after the reload succeeded; otherwise we would claim "latest
   * values loaded" while showing the old ones, with no way back.
   */
  const reloadAfterStaleBase = useCallback(async () => {
    setSaveError(null);
    setRefreshError(null);
    setSaveState('idle');
    const reloadError = await reloadFromServer();
    if (reloadError) {
      setConflictState('reloadFailed');
      return;
    }
    setDirty(false);
    setConflictState('reloaded');
  }, [reloadFromServer, setConflictState, setDirty, setRefreshError, setSaveError, setSaveState]);

  /** One write: merge owned paths, publish, invalidate — all inside the server transaction. */
  const applyPolicies = useCallback(
    async (policies: DraftMap, reason: string): Promise<SaveOutcome> => {
      setSaveState('saving');
      setSaveError(null);
      setRefreshError(null);
      setConflictState('none');
      try {
        const result = await withAdminReauthRetry(
          () =>
            adminSettingsService.save({
              expectedDraftToken: activeDraftToken,
              expectedRevision: activeBaseRevision,
              policies,
              reason,
            }),
          { authMethod },
        );
        // The committed payload is authoritative even if the post-commit refresh fails.
        setDraft(policies);
        setDirty(false);
        setSaveState('saved');
        setActiveBaseRevision(result.revision);
        setActiveDraftToken(result.draftToken);
        return 'saved';
      } catch (err) {
        if (mapEnterpriseError(err)?.code === 'PLATFORM_REVISION_CONFLICT') {
          await reloadAfterStaleBase();
          return 'conflict';
        }
        setSaveState('failed');
        setSaveError(mapUserFacingError(err, t));
        return 'failed';
      }
    },
    [
      activeBaseRevision,
      activeDraftToken,
      authMethod,
      reloadAfterStaleBase,
      setActiveBaseRevision,
      setActiveDraftToken,
      setConflictState,
      setDirty,
      setDraft,
      setRefreshError,
      setSaveError,
      setSaveState,
    ],
  );

  const handleSave = useCallback(async () => {
    // No effective change → no site-wide revision, audit row, or cache invalidation.
    if (!data || !canSave || saveState === 'saving' || !hasEffectiveChanges) return;
    // Project only policy-editor-owned paths; the server merges foreign service-model rows.
    const owned = projectPolicyEditorOwnedDraft(draft, isServiceModelPublishedPath);
    const outcome = await applyPolicies(owned, t('settingsPolicy.saveReason'));
    if (outcome === 'saved') {
      toast.success(
        t('settingsPolicy.saveSuccess', { defaultValue: 'Settings applied for everyone.' }),
      );
      await refreshAfterCommit();
      return;
    }
    if (outcome === 'failed') {
      toast.error(
        t('settingsPolicy.errors.saveFailed', { defaultValue: 'Could not save. Try again.' }),
      );
    }
  }, [
    applyPolicies,
    canSave,
    data,
    draft,
    hasEffectiveChanges,
    isServiceModelPublishedPath,
    refreshAfterCommit,
    saveState,
    t,
  ]);

  /**
   * Restore defaults: clear owned overrides in one save. Empty owned payload `{}` — server
   * policy-editor ownership preserves foreign service-model rows (never send them from here).
   */
  const handleResetDefaults = useCallback(() => {
    if (
      !data ||
      !canSave ||
      hasEffectiveChanges ||
      saveState === 'saving' ||
      ownPublishedOverrideCount === 0
    ) {
      return;
    }
    openDangerConfirm({
      confirmText: t('settingsPolicy.resetDefaults'),
      content: t('settingsPolicy.resetDefaultsDesc'),
      onConfirm: async () => {
        const outcome = await applyPolicies({}, t('settingsPolicy.resetReason'));
        if (outcome === 'saved') {
          toast.success(
            t('settingsPolicy.resetSuccess', { defaultValue: 'Platform defaults restored.' }),
          );
          await refreshAfterCommit();
          return;
        }
        if (outcome === 'failed') toast.error(t('settingsPolicy.resetFailed'));
      },
      title: t('settingsPolicy.resetDefaults'),
    });
  }, [
    applyPolicies,
    canSave,
    data,
    hasEffectiveChanges,
    ownPublishedOverrideCount,
    refreshAfterCommit,
    saveState,
    t,
  ]);

  return {
    handleResetDefaults,
    handleSave,
    retryConflictReload: reloadAfterStaleBase,
    retryRefresh,
  };
};
