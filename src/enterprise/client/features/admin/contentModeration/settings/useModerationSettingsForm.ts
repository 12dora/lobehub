'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ModerationMode } from '@/const/platform/contentModeration';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import { runAdminMutation } from '../../primitives/runAdminMutation';
import { useUnsavedChangesGuard } from '../../primitives/useUnsavedChangesGuard';
import { resolveConfigValidationMessage } from '../configErrors';
import { invalidateModerationOverview, useModerationSettings } from '../hooks';
import { adminContentModerationService } from '../service';
import { toUpdateConfig, validateKeywordRules } from './draft';
import { useModerationDraftState } from './useModerationDraftState';
import { useModerationValidation } from './useModerationValidation';

export interface UseModerationSettingsFormParams {
  canManage: boolean;
  enabled: boolean;
}

export const useModerationSettingsForm = ({
  canManage,
  enabled,
}: UseModerationSettingsFormParams) => {
  const { t } = useTranslation('admin');
  const { authMethod, permissions } = useAdminAccess();
  const { data, error, isLoading, mutate } = useModerationSettings(enabled);

  const [saving, setSaving] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);

  const {
    applySnapshot,
    baseRevision,
    configDirty,
    conflict,
    deferredKeywords,
    dirty,
    draft,
    fieldError,
    importText,
    keywordsPending,
    patch,
    setAddedKeys,
    setConflict,
    setFieldError,
    setImportText,
  } = useModerationDraftState(data);

  /** Endpoint the stored Moderations keys were saved against (server truth, not the draft). */
  const persistedBaseUrl = data?.settings.classifier.moderationsApi?.baseUrl;

  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('contentModeration.settings.unsaved.stay'),
      content: t('contentModeration.settings.unsaved.desc'),
      okText: t('contentModeration.settings.unsaved.leave'),
      title: t('contentModeration.settings.unsaved.title'),
    }),
    [t],
  );
  useUnsavedChangesGuard({ enabled: dirty, messages: unsavedMessages });

  const { baseIssues, classifierMessage, issues } = useModerationValidation({
    deferredKeywords,
    draft,
    fieldError,
    persistedBaseUrl,
    t,
  });

  const handleModeChange = (mode: ModerationMode) => {
    if (mode !== 'enforce') {
      patch({ mode });
      return;
    }
    openDangerConfirm({
      confirmText: t('contentModeration.settings.enforceConfirmOk'),
      content: t('contentModeration.settings.enforceConfirm'),
      title: t('contentModeration.settings.enforceConfirmTitle'),
      onConfirm: () => patch({ mode }),
    });
  };

  const handleAutoBanToggle = (nextEnabled: boolean) => {
    if (!draft) return;
    if (!nextEnabled) {
      patch({ autoBan: { ...draft.config.autoBan, enabled: false } });
      return;
    }
    openDangerConfirm({
      confirmText: t('contentModeration.settings.autoBan.confirmOk'),
      content: t('contentModeration.settings.autoBan.confirm'),
      title: t('contentModeration.settings.autoBan.confirmTitle'),
      onConfirm: () => patch({ autoBan: { ...draft.config.autoBan, enabled: true } }),
    });
  };

  const handleClearCache = () => {
    if (!canManage || clearingCache) return;
    openDangerConfirm({
      content: t('contentModeration.overview.clearCacheConfirm'),
      title: t('contentModeration.overview.clearCacheTitle'),
      onConfirm: async () => {
        setClearingCache(true);
        try {
          const ok = await runAdminMutation({
            authMethod,
            mapErrorKey: () => 'contentModeration.toast.clearCacheFailed',
            run: async () => {
              const result = await adminContentModerationService.clearDecisionCache();
              toast.success(
                t('contentModeration.toast.clearCacheSuccess', { count: result.deleted }),
              );
            },
          });
          if (ok) await invalidateModerationOverview();
        } finally {
          setClearingCache(false);
        }
      },
    });
  };

  const handleSave = async () => {
    if (!draft || !canManage || saving || baseRevision === null || !configDirty) return;
    if (keywordsPending) {
      toast.error(t('contentModeration.settings.keywordsValidating'));
      return;
    }
    // Re-validate the CURRENT rules synchronously: `keywordIssues` is derived from the deferred
    // copy, so trusting it alone could wave an invalid rule straight through to the server.
    const liveIssues = [...baseIssues, ...validateKeywordRules(draft.config.keywords)];
    if (liveIssues.length > 0) {
      const [first] = liveIssues;
      toast.error(t(`contentModeration.errors.${first.key}` as never, first.params));
      return;
    }
    setSaving(true);
    setFieldError(null);
    try {
      await runAdminMutation({
        authMethod,
        run: async () => {
          const saved = await adminContentModerationService.updateSettings({
            config: toUpdateConfig(draft, { persistedBaseUrl }),
            expectedRevision: baseRevision,
          });
          applySnapshot(saved);
          // Plaintext keys existed only for this request — never keep them in component state.
          setImportText('');
          await mutate(saved, { revalidate: false });
          await invalidateModerationOverview();
          toast.success(t('contentModeration.toast.saveSuccess'));
        },
        onError: async (cause) => {
          if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') {
            setConflict(true);
            toast.error(t('contentModeration.toast.conflict'));
            return;
          }
          const mapped = resolveConfigValidationMessage(
            cause,
            t,
            'contentModeration.toast.saveFailed',
          );
          if (mapped) {
            setFieldError(mapped);
            toast.error(mapped.message);
            return;
          }
          toast.error(t('contentModeration.toast.saveFailed'));
        },
      });
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    const fresh = await mutate();
    if (!fresh) return;
    applySnapshot(fresh);
    setImportText('');
  };

  return {
    classifierMessage,
    clearingCache,
    configDirty,
    conflict,
    data,
    dirty,
    draft,
    error,
    fieldError,
    handleAutoBanToggle,
    handleClearCache,
    handleModeChange,
    handleSave,
    importText,
    isLoading,
    issues,
    keywordsPending,
    mutate,
    patch,
    permissions,
    persistedBaseUrl,
    reload,
    saving,
    setAddedKeys,
    setImportText,
    t,
  };
};
