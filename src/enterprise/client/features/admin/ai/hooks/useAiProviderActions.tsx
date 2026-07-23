'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { confirmModal, toast } from '@lobehub/ui/base-ui';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAiCatalogService } from '@/enterprise/client/services/adminAiCatalog';

import {
  type AiCatalogPermissions,
  buildCompleteModelOrder,
  buildProviderUpdatePayload,
  fingerprintAiProviderSnapshot,
  hasBlockingModelDependents,
  isAiProviderSnapshotAdvanced,
  isAiProviderWriteLocked,
  resolveAiProviderPrimaryAction,
} from '../controller';
import { openModelEditorModal } from '../models/openModelEditorModal';
import { commitThenScheduleRefresh } from '../mutationRefresh';
import { openSecretMutationModal } from '../providers/openSecretMutationModal';
import type {
  AdminAiModelCreateInput,
  AdminAiModelDeleteInput,
  AdminAiModelDraft,
  AdminAiModelReorderInput,
  AdminAiModelUpdateInput,
  AdminAiProviderArchiveInput,
  AdminAiProviderGetOutput,
  AdminAiProviderPublishInput,
  AdminAiProviderRollbackInput,
  AdminAiProviderTestInput,
  AdminAiProviderUpdateDraftInput,
  AiSecretMutation,
} from '../types';
import { createAiCatalogWriteEpochGuard } from '../writeEpochGuard';
import { refreshAdminAiProvider } from './useAdminAiCatalog';
import type { useAiProviderEditor } from './useAiProviderEditor';

type ProviderEditor = ReturnType<typeof useAiProviderEditor>;

export interface UseAiProviderActionsParams {
  authMethod: AdminReauthAuthMethod | null;
  data: AdminAiProviderGetOutput;
  editor: ProviderEditor;
  permissions: AiCatalogPermissions;
}

export const useAiProviderActions = ({
  authMethod,
  data,
  editor,
  permissions,
}: UseAiProviderActionsParams) => {
  const { t } = useTranslation('admin');
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshRetrying, setRefreshRetrying] = useState(false);
  const refreshGenerationRef = useRef(0);
  const committedBaseFingerprintRef = useRef<string | null>(null);
  const writeGuardRef = useRef(createAiCatalogWriteEpochGuard());
  const writeGuard = writeGuardRef.current;
  const reloadRequired = isAiProviderWriteLocked({ refreshFailed, refreshPending });

  const errorText = useCallback(
    (cause: unknown) => {
      const mapped = mapEnterpriseError(cause);
      return mapped
        ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
        : t('aiCatalog.errors.generic');
    },
    [t],
  );

  const handleMutationError = useCallback(
    async (cause: unknown) => {
      const mapped = mapEnterpriseError(cause);
      if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
        writeGuard.invalidate();
        editor.setConflict(true);
        try {
          await refreshAdminAiProvider(data.draft.id);
        } catch {
          // The local public draft remains persisted; the conflict banner offers another retry.
        }
      }
      editor.setActionError(errorText(cause));
    },
    [data.draft.id, editor, errorText, writeGuard],
  );

  const commitAndRefresh = useCallback(
    async <Result,>(params: {
      clearTest?: boolean;
      commit: () => Promise<Result>;
      onCommitted?: (result: Result) => void;
    }) => {
      const generation = ++refreshGenerationRef.current;
      const previousFingerprint = fingerprintAiProviderSnapshot(data);
      return commitThenScheduleRefresh({
        commit: params.commit,
        refresh: async () => {
          const latest = await refreshAdminAiProvider(data.draft.id);
          if (!isAiProviderSnapshotAdvanced(previousFingerprint, latest)) {
            throw new Error('Committed Provider snapshot has not advanced');
          }
        },
        onCommitted: (result) => {
          writeGuard.lock();
          committedBaseFingerprintRef.current = previousFingerprint;
          if (params.clearTest !== false) editor.invalidateTest();
          editor.setActionError(null);
          setRefreshFailed(false);
          setRefreshPending(true);
          params.onCommitted?.(result);
        },
        onRefreshed: () => {
          if (refreshGenerationRef.current === generation) {
            writeGuard.unlock();
            committedBaseFingerprintRef.current = null;
            setRefreshFailed(false);
            setRefreshPending(false);
          }
        },
        onRefreshFailed: () => {
          if (refreshGenerationRef.current === generation) {
            setRefreshFailed(true);
            setRefreshPending(false);
          }
        },
      });
    },
    [data, editor, writeGuard],
  );

  /** Begin a write epoch when `enabled`; returns null when blocked or locked. */
  const beginGuardedWrite = useCallback(
    (enabled: boolean): number | null => {
      if (!enabled) return null;
      return writeGuard.begin();
    },
    [writeGuard],
  );

  /**
   * Shared commit path for every guarded mutation (reason modal or custom modal):
   * assertCurrent → beforeCommit → optional loadingId → commitAndRefresh → afterError/handleMutationError.
   */
  const runGuardedCommit = useCallback(
    async <Result, Input = unknown>(
      epoch: number,
      input: Input,
      options: {
        afterError?: (cause: unknown) => void | Promise<void>;
        beforeCommit?: () => void;
        clearTest?: boolean;
        commit: (input: Input) => Promise<Result>;
        loadingId?: string;
        onCommitted?: (result: Result) => void;
      },
    ): Promise<void> => {
      writeGuard.assertCurrent(epoch);
      options.beforeCommit?.();
      if (options.loadingId !== undefined) setActionLoadingId(options.loadingId);
      try {
        await commitAndRefresh({
          clearTest: options.clearTest,
          commit: () => options.commit(input),
          onCommitted: options.onCommitted,
        });
      } catch (cause) {
        await options.afterError?.(cause);
        await handleMutationError(cause);
        throw cause;
      } finally {
        if (options.loadingId !== undefined) setActionLoadingId(null);
      }
    },
    [commitAndRefresh, handleMutationError, writeGuard],
  );

  /**
   * Shared scaffold for epoch-guarded reason modals:
   * begin epoch (or reuse `epoch`) → openReasonModal → runGuardedCommit.
   */
  const openGuardedReasonMutation = useCallback(
    <Result, Input = unknown>(options: {
      afterError?: (cause: unknown) => void | Promise<void>;
      beforeCommit?: () => void;
      buildPayload: (reason: string) => Input;
      clearTest?: boolean;
      commit: (input: Input) => Promise<Result>;
      danger?: boolean;
      description: string;
      /** When `epoch` is omitted, start a new epoch only if true. Default true. */
      enabled?: boolean;
      /** Pre-started epoch from `beginGuardedWrite` (skips begin). */
      epoch?: number;
      impact?: string;
      loadingId?: string;
      onCommitted?: (result: Result) => void;
      submitLabel: string;
      targetLabel: string;
      title: string;
    }) => {
      const epoch = options.epoch ?? beginGuardedWrite(options.enabled ?? true);
      if (epoch === null) return;
      openReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => options.buildPayload(reason) as unknown,
        danger: options.danger,
        description: options.description,
        impact: options.impact,
        onSubmit: async (input) => {
          await runGuardedCommit(epoch, input as Input, {
            afterError: options.afterError,
            beforeCommit: options.beforeCommit,
            clearTest: options.clearTest,
            commit: options.commit,
            loadingId: options.loadingId,
            onCommitted: options.onCommitted,
          });
        },
        submitLabel: options.submitLabel,
        targetLabel: options.targetLabel,
        title: options.title,
      });
    },
    [authMethod, beginGuardedWrite, runGuardedCommit],
  );

  const retryRefresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    writeGuard.lock();
    setRefreshRetrying(true);
    setRefreshPending(true);
    try {
      const latest = await refreshAdminAiProvider(data.draft.id);
      const previousFingerprint = committedBaseFingerprintRef.current;
      if (!previousFingerprint || !isAiProviderSnapshotAdvanced(previousFingerprint, latest)) {
        throw new Error('Committed Provider snapshot has not advanced');
      }
      if (refreshGenerationRef.current === generation) {
        writeGuard.unlock();
        committedBaseFingerprintRef.current = null;
        setRefreshFailed(false);
        setRefreshPending(false);
      }
    } catch {
      if (refreshGenerationRef.current === generation) {
        setRefreshFailed(true);
        setRefreshPending(false);
      }
    } finally {
      if (refreshGenerationRef.current === generation) setRefreshRetrying(false);
    }
  }, [data.draft.id, writeGuard]);

  const openSave = useCallback(() => {
    if (!editor.draft) return;
    const draftSnapshot = structuredClone(editor.draft);
    openGuardedReasonMutation({
      afterError: () => {
        editor.setSaveState('failed');
      },
      beforeCommit: () => {
        editor.setSaveState('saving');
      },
      buildPayload: (reason) =>
        buildProviderUpdatePayload({
          draft: draftSnapshot,
          draftToken: data.draftToken,
          id: data.draft.id,
          reason,
          revision: data.baseRevision,
        }),
      commit: (input) =>
        adminAiCatalogService.updateProvider(input as AdminAiProviderUpdateDraftInput),
      description: t('aiCatalog.actions.save.desc'),
      enabled:
        !reloadRequired &&
        !editor.conflict &&
        editor.dirty &&
        editor.valid &&
        permissions.canUpdateProvider,
      onCommitted: () => {
        editor.markSaved();
        toast.success(t('aiCatalog.toast.draftSaved'));
      },
      submitLabel: t('aiCatalog.actions.save.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.save.title'),
    });
  }, [data, editor, openGuardedReasonMutation, permissions, reloadRequired, t]);

  const openTest = useCallback(() => {
    openGuardedReasonMutation({
      buildPayload: (reason) => ({ id: data.draft.id, reason }),
      clearTest: false,
      commit: (input) => adminAiCatalogService.testProvider(input as AdminAiProviderTestInput),
      description: t('aiCatalog.actions.test.desc'),
      enabled:
        !reloadRequired &&
        !editor.dirty &&
        !editor.conflict &&
        editor.valid &&
        permissions.canTestProvider,
      onCommitted: (result) => {
        toast[result.status === 'success' ? 'success' : 'warning'](
          t(`aiCatalog.toast.test.${result.status}` as never),
        );
      },
      submitLabel: t('aiCatalog.actions.test.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.test.title'),
    });
  }, [data.draft, editor, openGuardedReasonMutation, permissions, reloadRequired, t]);

  const openPublish = useCallback(() => {
    const snapshot = {
      expectedDraftToken: data.draftToken,
      expectedRevision: data.baseRevision,
      id: data.draft.id,
    };
    openGuardedReasonMutation({
      buildPayload: (reason) => ({ ...snapshot, reason }),
      commit: (input) =>
        adminAiCatalogService.publishProvider(input as AdminAiProviderPublishInput),
      description: t('aiCatalog.actions.publish.desc'),
      enabled:
        !editor.dirty &&
        !reloadRequired &&
        !editor.conflict &&
        editor.valid &&
        editor.connectionTest.canPublish &&
        permissions.canPublishProvider,
      impact: t('aiCatalog.actions.publish.impact'),
      onCommitted: () => toast.success(t('aiCatalog.toast.published')),
      submitLabel: t('aiCatalog.actions.publish.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.publish.title'),
    });
  }, [data, editor, openGuardedReasonMutation, permissions, reloadRequired, t]);

  const primaryAction = reloadRequired
    ? 'none'
    : resolveAiProviderPrimaryAction({
        canPublish: permissions.canPublishProvider && data.draft.status !== 'archived',
        canSave: permissions.canUpdateProvider && editor.valid,
        canTest:
          permissions.canTestProvider &&
          editor.valid &&
          data.draft.status !== 'archived' &&
          !(editor.connectionTest.state?.status === 'pending' && !editor.connectionTest.stale),
        conflict: editor.conflict,
        dirty: editor.dirty,
        saveState: editor.saveState,
        testPassed: editor.connectionTest.canPublish,
      });

  const handlePrimary = useCallback(() => {
    if (primaryAction === 'save' || primaryAction === 'retry') openSave();
    else if (primaryAction === 'test') openTest();
    else if (primaryAction === 'publish') openPublish();
  }, [openPublish, openSave, openTest, primaryAction]);

  const handleSecret = useCallback(() => {
    const epoch = beginGuardedWrite(
      !reloadRequired && !editor.dirty && !editor.conflict && permissions.canUpdateProvider,
    );
    if (epoch === null) return;
    const snapshot = {
      expectedDraftToken: data.draftToken,
      expectedRevision: data.baseRevision,
      id: data.draft.id,
    };
    openSecretMutationModal({
      authMethod: authMethod ?? undefined,
      configured: data.draft.secret.configured,
      providerName: data.draft.displayName,
      onSubmit: async ({ reason, secret }: { reason: string; secret: AiSecretMutation }) => {
        await runGuardedCommit(
          epoch,
          { reason, secret },
          {
            commit: ({ reason: nextReason, secret: nextSecret }) =>
              adminAiCatalogService.updateProvider({
                ...snapshot,
                reason: nextReason,
                secret: nextSecret,
              }),
            onCommitted: () => {
              editor.markSaved();
              toast.success(t('aiCatalog.toast.secretUpdated'));
            },
          },
        );
      },
    });
  }, [
    authMethod,
    beginGuardedWrite,
    data,
    editor,
    permissions,
    reloadRequired,
    runGuardedCommit,
    t,
  ]);

  const handleArchive = useCallback(() => {
    const snapshot = {
      expectedDraftToken: data.draftToken,
      expectedRevision: data.baseRevision,
      id: data.draft.id,
    };
    openGuardedReasonMutation({
      buildPayload: (reason) => ({ ...snapshot, reason }),
      commit: (input) =>
        adminAiCatalogService.archiveProvider(input as AdminAiProviderArchiveInput),
      danger: true,
      description: t('aiCatalog.actions.archive.desc'),
      enabled:
        !editor.dirty &&
        !reloadRequired &&
        !editor.conflict &&
        data.draft.status !== 'archived' &&
        permissions.canArchiveProvider,
      onCommitted: () => toast.success(t('aiCatalog.toast.archived')),
      submitLabel: t('aiCatalog.actions.archive.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.archive.title'),
    });
  }, [data, editor, openGuardedReasonMutation, permissions, reloadRequired, t]);

  const handleRollback = useCallback(
    (targetRevision: number) => {
      const snapshot = {
        expectedDraftToken: data.draftToken,
        expectedRevision: data.baseRevision,
        id: data.draft.id,
        targetRevision,
      };
      openGuardedReasonMutation({
        buildPayload: (reason) => ({ ...snapshot, reason }),
        commit: (input) =>
          adminAiCatalogService.rollbackProvider(input as AdminAiProviderRollbackInput),
        danger: true,
        description: t('aiCatalog.actions.rollback.desc', { revision: targetRevision }),
        enabled:
          !reloadRequired && !editor.dirty && !editor.conflict && permissions.canPublishProvider,
        onCommitted: () => toast.success(t('aiCatalog.toast.rolledBack')),
        submitLabel: t('aiCatalog.actions.rollback.label'),
        targetLabel: data.draft.displayName,
        title: t('aiCatalog.actions.rollback.title'),
      });
    },
    [data, editor, openGuardedReasonMutation, permissions, reloadRequired, t],
  );

  const handleCreateModel = useCallback(() => {
    const epoch = beginGuardedWrite(
      !reloadRequired && !editor.dirty && !editor.conflict && permissions.canCreateModel,
    );
    if (epoch === null) return;
    const draftToken = data.draftToken;
    openModelEditorModal({
      authMethod: authMethod ?? undefined,
      onSubmit: async ({ fields, modelKey, reason }) => {
        const input: AdminAiModelCreateInput = {
          ...fields,
          expectedDraftToken: draftToken,
          modelKey,
          providerId: data.draft.id,
          reason,
        };
        await runGuardedCommit(epoch, input, {
          commit: (payload) => adminAiCatalogService.createModel(payload),
          loadingId: 'models',
          onCommitted: () => toast.success(t('aiCatalog.toast.modelCreated')),
        });
      },
    });
  }, [
    authMethod,
    beginGuardedWrite,
    data,
    editor,
    permissions,
    reloadRequired,
    runGuardedCommit,
    t,
  ]);

  const handleEditModel = useCallback(
    async (model: AdminAiModelDraft) => {
      const epoch = beginGuardedWrite(
        !editor.dirty &&
          !reloadRequired &&
          !editor.conflict &&
          permissions.canReadModels &&
          permissions.canUpdateModel,
      );
      if (epoch === null) return;
      setActionLoadingId(model.id);
      try {
        const dependents = await adminAiCatalogService.getModelDependents({
          id: model.id,
          providerId: data.draft.id,
        });
        if (!writeGuard.isCurrent(epoch)) return;
        const draftToken = data.draftToken;
        openModelEditorModal({
          authMethod: authMethod ?? undefined,
          disableAvailability: model.enabled && hasBlockingModelDependents(dependents),
          model,
          onSubmit: async ({ fields, reason }) => {
            const input: AdminAiModelUpdateInput = {
              ...fields,
              expectedDraftToken: draftToken,
              expectedRevision: model.revision,
              id: model.id,
              providerId: data.draft.id,
              reason,
            };
            await runGuardedCommit(epoch, input, {
              commit: (payload) => adminAiCatalogService.updateModel(payload),
              loadingId: model.id,
              onCommitted: () => toast.success(t('aiCatalog.toast.modelUpdated')),
            });
          },
        });
      } catch (cause) {
        if (!writeGuard.isCurrent(epoch)) return;
        editor.setActionError(errorText(cause));
        toast.error(errorText(cause));
      } finally {
        setActionLoadingId(null);
      }
    },
    [
      authMethod,
      beginGuardedWrite,
      data,
      editor,
      errorText,
      permissions.canReadModels,
      permissions.canUpdateModel,
      reloadRequired,
      runGuardedCommit,
      t,
      writeGuard,
    ],
  );

  const handleDeleteModel = useCallback(
    async (model: AdminAiModelDraft) => {
      const epoch = beginGuardedWrite(
        !editor.dirty &&
          !reloadRequired &&
          !editor.conflict &&
          permissions.canDeleteModel &&
          permissions.canReadModels,
      );
      if (epoch === null) return;
      setActionLoadingId(model.id);
      try {
        const dependents = await adminAiCatalogService.getModelDependents({
          id: model.id,
          providerId: data.draft.id,
        });
        if (!writeGuard.isCurrent(epoch)) return;
        const blockers = dependents.items.filter((item) => item.blocking);
        if (blockers.length > 0) {
          confirmModal({
            cancelText: t('aiCatalog.dependents.close'),
            content: (
              <Flexbox gap={8}>
                <Text type="secondary">{t('aiCatalog.dependents.desc')}</Text>
                {blockers.map((item) => (
                  <Text key={`${item.resourceType}:${item.resourceId}`}>{item.label}</Text>
                ))}
              </Flexbox>
            ),
            okText: t('aiCatalog.dependents.close'),
            title: t('aiCatalog.dependents.title'),
          });
          return;
        }
        const draftToken = data.draftToken;
        openGuardedReasonMutation({
          buildPayload: (reason) =>
            ({
              expectedDraftToken: draftToken,
              id: model.id,
              providerId: data.draft.id,
              reason,
            }) satisfies AdminAiModelDeleteInput,
          commit: (input) => adminAiCatalogService.deleteModel(input),
          danger: true,
          description: t('aiCatalog.actions.deleteModel.desc'),
          epoch,
          loadingId: model.id,
          onCommitted: () => toast.success(t('aiCatalog.toast.modelDeleted')),
          submitLabel: t('aiCatalog.models.actions.delete'),
          targetLabel: model.displayName || model.modelKey,
          title: t('aiCatalog.actions.deleteModel.title'),
        });
      } catch (cause) {
        if (!writeGuard.isCurrent(epoch)) return;
        editor.setActionError(errorText(cause));
        toast.error(errorText(cause));
      } finally {
        setActionLoadingId(null);
      }
    },
    [
      beginGuardedWrite,
      data,
      editor,
      errorText,
      openGuardedReasonMutation,
      permissions.canDeleteModel,
      permissions.canReadModels,
      reloadRequired,
      t,
      writeGuard,
    ],
  );

  const handleReorderModels = useCallback(
    (orderedIds: string[]) => {
      if (reloadRequired || editor.dirty || editor.conflict || !permissions.canReorderModels) {
        return;
      }
      const items = buildCompleteModelOrder(
        data.draft.models.map((model) => model.id),
        orderedIds,
      );
      if (!items) {
        toast.error(t('aiCatalog.errors.incompleteModelOrder'));
        return;
      }
      const draftToken = data.draftToken;
      openGuardedReasonMutation({
        buildPayload: (reason) =>
          ({
            expectedDraftToken: draftToken,
            items,
            providerId: data.draft.id,
            reason,
          }) satisfies AdminAiModelReorderInput,
        commit: (input) => adminAiCatalogService.reorderModels(input),
        description: t('aiCatalog.actions.reorder.desc'),
        loadingId: 'models',
        onCommitted: () => toast.success(t('aiCatalog.toast.modelsReordered')),
        submitLabel: t('aiCatalog.actions.reorder.label'),
        targetLabel: data.draft.displayName,
        title: t('aiCatalog.actions.reorder.title'),
      });
    },
    [data, editor, openGuardedReasonMutation, permissions, reloadRequired, t],
  );

  return {
    actionLoadingId,
    handleArchive,
    handleCreateModel,
    handleDeleteModel,
    handleEditModel,
    handlePrimary,
    handleReorderModels,
    handleRollback,
    handleSecret,
    primaryAction,
    refreshFailed,
    refreshPending,
    refreshRetrying,
    reloadRequired,
    retryRefresh,
  };
};
