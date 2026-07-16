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
    if (
      !editor.draft ||
      reloadRequired ||
      editor.conflict ||
      !editor.dirty ||
      !editor.valid ||
      !permissions.canUpdateProvider
    ) {
      return;
    }
    const epoch = writeGuard.begin();
    if (epoch === null) return;
    const draftSnapshot = structuredClone(editor.draft);
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) =>
        buildProviderUpdatePayload({
          draft: draftSnapshot,
          draftToken: data.draftToken,
          id: data.draft.id,
          reason,
          revision: data.baseRevision,
        }),
      description: t('aiCatalog.actions.save.desc'),
      onSubmit: async (input) => {
        writeGuard.assertCurrent(epoch);
        editor.setSaveState('saving');
        try {
          await commitAndRefresh({
            commit: () =>
              adminAiCatalogService.updateProvider(input as AdminAiProviderUpdateDraftInput),
            onCommitted: () => {
              editor.markSaved();
              toast.success(t('aiCatalog.toast.draftSaved'));
            },
          });
        } catch (cause) {
          editor.setSaveState('failed');
          await handleMutationError(cause);
          throw cause;
        }
      },
      submitLabel: t('aiCatalog.actions.save.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.save.title'),
    });
  }, [
    authMethod,
    commitAndRefresh,
    data,
    editor,
    handleMutationError,
    permissions,
    reloadRequired,
    t,
    writeGuard,
  ]);

  const openTest = useCallback(() => {
    if (
      reloadRequired ||
      editor.dirty ||
      editor.conflict ||
      !editor.valid ||
      !permissions.canTestProvider
    ) {
      return;
    }
    const epoch = writeGuard.begin();
    if (epoch === null) return;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({ id: data.draft.id, reason }),
      description: t('aiCatalog.actions.test.desc'),
      onSubmit: async (input) => {
        writeGuard.assertCurrent(epoch);
        try {
          await commitAndRefresh({
            clearTest: false,
            commit: () => adminAiCatalogService.testProvider(input as AdminAiProviderTestInput),
            onCommitted: (result) => {
              toast[result.status === 'success' ? 'success' : 'warning'](
                t(`aiCatalog.toast.test.${result.status}` as never),
              );
            },
          });
        } catch (cause) {
          await handleMutationError(cause);
          throw cause;
        }
      },
      submitLabel: t('aiCatalog.actions.test.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.test.title'),
    });
  }, [
    authMethod,
    commitAndRefresh,
    data.draft,
    editor,
    handleMutationError,
    permissions,
    reloadRequired,
    t,
    writeGuard,
  ]);

  const openPublish = useCallback(() => {
    if (
      editor.dirty ||
      reloadRequired ||
      editor.conflict ||
      !editor.valid ||
      !editor.connectionTest.canPublish ||
      !permissions.canPublishProvider
    ) {
      return;
    }
    const epoch = writeGuard.begin();
    if (epoch === null) return;
    const snapshot = {
      expectedDraftToken: data.draftToken,
      expectedRevision: data.baseRevision,
      id: data.draft.id,
    };
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({ ...snapshot, reason }),
      description: t('aiCatalog.actions.publish.desc'),
      impact: t('aiCatalog.actions.publish.impact'),
      onSubmit: async (input) => {
        writeGuard.assertCurrent(epoch);
        try {
          await commitAndRefresh({
            commit: () =>
              adminAiCatalogService.publishProvider(input as AdminAiProviderPublishInput),
            onCommitted: () => toast.success(t('aiCatalog.toast.published')),
          });
        } catch (cause) {
          await handleMutationError(cause);
          throw cause;
        }
      },
      submitLabel: t('aiCatalog.actions.publish.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.publish.title'),
    });
  }, [
    authMethod,
    commitAndRefresh,
    data,
    editor,
    handleMutationError,
    permissions,
    reloadRequired,
    t,
    writeGuard,
  ]);

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
    if (reloadRequired || editor.dirty || editor.conflict || !permissions.canUpdateProvider) return;
    const epoch = writeGuard.begin();
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
        writeGuard.assertCurrent(epoch);
        try {
          await commitAndRefresh({
            commit: () => adminAiCatalogService.updateProvider({ ...snapshot, reason, secret }),
            onCommitted: () => {
              editor.markSaved();
              toast.success(t('aiCatalog.toast.secretUpdated'));
            },
          });
        } catch (cause) {
          await handleMutationError(cause);
          throw cause;
        }
      },
    });
  }, [
    authMethod,
    commitAndRefresh,
    data,
    editor,
    handleMutationError,
    permissions,
    reloadRequired,
    t,
    writeGuard,
  ]);

  const handleArchive = useCallback(() => {
    if (
      editor.dirty ||
      reloadRequired ||
      editor.conflict ||
      data.draft.status === 'archived' ||
      !permissions.canArchiveProvider
    ) {
      return;
    }
    const epoch = writeGuard.begin();
    if (epoch === null) return;
    const snapshot = {
      expectedDraftToken: data.draftToken,
      expectedRevision: data.baseRevision,
      id: data.draft.id,
    };
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({ ...snapshot, reason }),
      danger: true,
      description: t('aiCatalog.actions.archive.desc'),
      onSubmit: async (input) => {
        writeGuard.assertCurrent(epoch);
        try {
          await commitAndRefresh({
            commit: () =>
              adminAiCatalogService.archiveProvider(input as AdminAiProviderArchiveInput),
            onCommitted: () => toast.success(t('aiCatalog.toast.archived')),
          });
        } catch (cause) {
          await handleMutationError(cause);
          throw cause;
        }
      },
      submitLabel: t('aiCatalog.actions.archive.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.archive.title'),
    });
  }, [
    authMethod,
    commitAndRefresh,
    data,
    editor,
    handleMutationError,
    permissions,
    reloadRequired,
    t,
    writeGuard,
  ]);

  const handleRollback = useCallback(
    (targetRevision: number) => {
      if (reloadRequired || editor.dirty || editor.conflict || !permissions.canPublishProvider) {
        return;
      }
      const epoch = writeGuard.begin();
      if (epoch === null) return;
      const snapshot = {
        expectedDraftToken: data.draftToken,
        expectedRevision: data.baseRevision,
        id: data.draft.id,
        targetRevision,
      };
      openReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({ ...snapshot, reason }),
        danger: true,
        description: t('aiCatalog.actions.rollback.desc', { revision: targetRevision }),
        onSubmit: async (input) => {
          writeGuard.assertCurrent(epoch);
          try {
            await commitAndRefresh({
              commit: () =>
                adminAiCatalogService.rollbackProvider(input as AdminAiProviderRollbackInput),
              onCommitted: () => toast.success(t('aiCatalog.toast.rolledBack')),
            });
          } catch (cause) {
            await handleMutationError(cause);
            throw cause;
          }
        },
        submitLabel: t('aiCatalog.actions.rollback.label'),
        targetLabel: data.draft.displayName,
        title: t('aiCatalog.actions.rollback.title'),
      });
    },
    [
      authMethod,
      commitAndRefresh,
      data,
      editor,
      handleMutationError,
      permissions,
      reloadRequired,
      t,
      writeGuard,
    ],
  );

  const handleCreateModel = useCallback(() => {
    if (reloadRequired || editor.dirty || editor.conflict || !permissions.canCreateModel) return;
    const epoch = writeGuard.begin();
    if (epoch === null) return;
    const draftToken = data.draftToken;
    openModelEditorModal({
      authMethod: authMethod ?? undefined,
      onSubmit: async ({ fields, modelKey, reason }) => {
        writeGuard.assertCurrent(epoch);
        setActionLoadingId('models');
        try {
          const input: AdminAiModelCreateInput = {
            ...fields,
            expectedDraftToken: draftToken,
            modelKey,
            providerId: data.draft.id,
            reason,
          };
          await commitAndRefresh({
            commit: () => adminAiCatalogService.createModel(input),
            onCommitted: () => toast.success(t('aiCatalog.toast.modelCreated')),
          });
        } catch (cause) {
          await handleMutationError(cause);
          throw cause;
        } finally {
          setActionLoadingId(null);
        }
      },
    });
  }, [
    authMethod,
    commitAndRefresh,
    data,
    editor,
    handleMutationError,
    permissions,
    reloadRequired,
    t,
    writeGuard,
  ]);

  const handleEditModel = useCallback(
    async (model: AdminAiModelDraft) => {
      if (
        editor.dirty ||
        reloadRequired ||
        editor.conflict ||
        !permissions.canReadModels ||
        !permissions.canUpdateModel
      ) {
        return;
      }
      const epoch = writeGuard.begin();
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
            writeGuard.assertCurrent(epoch);
            setActionLoadingId(model.id);
            try {
              const input: AdminAiModelUpdateInput = {
                ...fields,
                expectedDraftToken: draftToken,
                expectedRevision: model.revision,
                id: model.id,
                providerId: data.draft.id,
                reason,
              };
              await commitAndRefresh({
                commit: () => adminAiCatalogService.updateModel(input),
                onCommitted: () => toast.success(t('aiCatalog.toast.modelUpdated')),
              });
            } catch (cause) {
              await handleMutationError(cause);
              throw cause;
            } finally {
              setActionLoadingId(null);
            }
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
      data,
      editor,
      errorText,
      handleMutationError,
      permissions.canReadModels,
      permissions.canUpdateModel,
      commitAndRefresh,
      reloadRequired,
      t,
      writeGuard,
    ],
  );

  const handleDeleteModel = useCallback(
    async (model: AdminAiModelDraft) => {
      if (
        editor.dirty ||
        reloadRequired ||
        editor.conflict ||
        !permissions.canDeleteModel ||
        !permissions.canReadModels
      ) {
        return;
      }
      const epoch = writeGuard.begin();
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
        openReasonModal({
          authMethod: authMethod ?? undefined,
          buildPayload: (reason) => ({
            expectedDraftToken: draftToken,
            id: model.id,
            providerId: data.draft.id,
            reason,
          }),
          danger: true,
          description: t('aiCatalog.actions.deleteModel.desc'),
          onSubmit: async (input) => {
            writeGuard.assertCurrent(epoch);
            setActionLoadingId(model.id);
            try {
              await commitAndRefresh({
                commit: () => adminAiCatalogService.deleteModel(input as AdminAiModelDeleteInput),
                onCommitted: () => toast.success(t('aiCatalog.toast.modelDeleted')),
              });
            } catch (cause) {
              await handleMutationError(cause);
              throw cause;
            } finally {
              setActionLoadingId(null);
            }
          },
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
      authMethod,
      data,
      editor,
      errorText,
      handleMutationError,
      permissions.canDeleteModel,
      permissions.canReadModels,
      commitAndRefresh,
      reloadRequired,
      t,
      writeGuard,
    ],
  );

  const handleReorderModels = useCallback(
    (orderedIds: string[]) => {
      if (reloadRequired || editor.dirty || editor.conflict || !permissions.canReorderModels)
        return;
      const epoch = writeGuard.begin();
      if (epoch === null) return;
      const items = buildCompleteModelOrder(
        data.draft.models.map((model) => model.id),
        orderedIds,
      );
      if (!items) {
        toast.error(t('aiCatalog.errors.incompleteModelOrder'));
        return;
      }
      const draftToken = data.draftToken;
      openReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({
          expectedDraftToken: draftToken,
          items,
          providerId: data.draft.id,
          reason,
        }),
        description: t('aiCatalog.actions.reorder.desc'),
        onSubmit: async (input) => {
          writeGuard.assertCurrent(epoch);
          setActionLoadingId('models');
          try {
            await commitAndRefresh({
              commit: () => adminAiCatalogService.reorderModels(input as AdminAiModelReorderInput),
              onCommitted: () => toast.success(t('aiCatalog.toast.modelsReordered')),
            });
          } catch (cause) {
            await handleMutationError(cause);
            throw cause;
          } finally {
            setActionLoadingId(null);
          }
        },
        submitLabel: t('aiCatalog.actions.reorder.label'),
        targetLabel: data.draft.displayName,
        title: t('aiCatalog.actions.reorder.title'),
      });
    },
    [
      authMethod,
      commitAndRefresh,
      data,
      editor,
      handleMutationError,
      permissions,
      reloadRequired,
      t,
      writeGuard,
    ],
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
