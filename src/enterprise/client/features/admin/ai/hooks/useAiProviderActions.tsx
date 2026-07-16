'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { confirmModal, toast } from '@lobehub/ui/base-ui';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAiCatalogService } from '@/enterprise/client/services/adminAiCatalog';

import {
  type AiCatalogPermissions,
  buildCompleteModelOrder,
  buildProviderUpdatePayload,
  hasBlockingModelDependents,
  resolveAiProviderPrimaryAction,
} from '../controller';
import { openModelEditorModal } from '../models/openModelEditorModal';
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
    (cause: unknown) => {
      const mapped = mapEnterpriseError(cause);
      if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
        editor.setConflict(true);
      }
      editor.setActionError(errorText(cause));
    },
    [editor, errorText],
  );

  const refresh = useCallback(
    async (clearTest = true) => {
      if (clearTest) editor.setTestResult(null);
      await refreshAdminAiProvider(data.draft.id);
    },
    [data.draft.id, editor],
  );

  const openSave = useCallback(() => {
    if (!editor.draft || editor.conflict || !editor.dirty || !permissions.canUpdateProvider) return;
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
        editor.setSaveState('saving');
        try {
          await adminAiCatalogService.updateProvider(input as AdminAiProviderUpdateDraftInput);
          editor.markSaved();
          await refresh(false);
          toast.success(t('aiCatalog.toast.draftSaved'));
        } catch (cause) {
          editor.setSaveState('failed');
          handleMutationError(cause);
          throw cause;
        }
      },
      submitLabel: t('aiCatalog.actions.save.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.save.title'),
    });
  }, [authMethod, data, editor, handleMutationError, permissions.canUpdateProvider, refresh, t]);

  const openTest = useCallback(() => {
    if (editor.dirty || editor.conflict || !permissions.canTestProvider) return;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({ id: data.draft.id, reason }),
      description: t('aiCatalog.actions.test.desc'),
      onSubmit: async (input) => {
        try {
          const result = await adminAiCatalogService.testProvider(
            input as AdminAiProviderTestInput,
          );
          editor.setActionError(null);
          editor.setTestResult(result);
          toast[result.status === 'success' ? 'success' : 'warning'](
            t(`aiCatalog.toast.test.${result.status}` as never),
          );
        } catch (cause) {
          handleMutationError(cause);
          throw cause;
        }
      },
      submitLabel: t('aiCatalog.actions.test.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.test.title'),
    });
  }, [authMethod, data.draft, editor, handleMutationError, permissions.canTestProvider, t]);

  const openPublish = useCallback(() => {
    if (
      editor.dirty ||
      editor.conflict ||
      editor.testResult?.status !== 'success' ||
      !permissions.canPublishProvider
    ) {
      return;
    }
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
        try {
          await adminAiCatalogService.publishProvider(input as AdminAiProviderPublishInput);
          editor.setActionError(null);
          await refresh();
          toast.success(t('aiCatalog.toast.published'));
        } catch (cause) {
          handleMutationError(cause);
          throw cause;
        }
      },
      submitLabel: t('aiCatalog.actions.publish.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.publish.title'),
    });
  }, [authMethod, data, editor, handleMutationError, permissions.canPublishProvider, refresh, t]);

  const primaryAction = resolveAiProviderPrimaryAction({
    canPublish: permissions.canPublishProvider && data.draft.status !== 'archived',
    canSave: permissions.canUpdateProvider,
    canTest: permissions.canTestProvider && data.draft.status !== 'archived',
    conflict: editor.conflict,
    dirty: editor.dirty,
    saveState: editor.saveState,
    testPassed: editor.testResult?.status === 'success',
  });

  const handlePrimary = useCallback(() => {
    if (primaryAction === 'save' || primaryAction === 'retry') openSave();
    else if (primaryAction === 'test') openTest();
    else if (primaryAction === 'publish') openPublish();
  }, [openPublish, openSave, openTest, primaryAction]);

  const handleSecret = useCallback(() => {
    if (editor.dirty || editor.conflict || !permissions.canUpdateProvider) return;
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
        try {
          await adminAiCatalogService.updateProvider({ ...snapshot, reason, secret });
          editor.markSaved();
          await refresh();
          toast.success(t('aiCatalog.toast.secretUpdated'));
        } catch (cause) {
          handleMutationError(cause);
          throw cause;
        }
      },
    });
  }, [authMethod, data, editor, handleMutationError, permissions.canUpdateProvider, refresh, t]);

  const handleArchive = useCallback(() => {
    if (
      editor.dirty ||
      editor.conflict ||
      data.draft.status === 'archived' ||
      !permissions.canArchiveProvider
    ) {
      return;
    }
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
        try {
          await adminAiCatalogService.archiveProvider(input as AdminAiProviderArchiveInput);
          editor.setActionError(null);
          await refresh();
          toast.success(t('aiCatalog.toast.archived'));
        } catch (cause) {
          handleMutationError(cause);
          throw cause;
        }
      },
      submitLabel: t('aiCatalog.actions.archive.label'),
      targetLabel: data.draft.displayName,
      title: t('aiCatalog.actions.archive.title'),
    });
  }, [authMethod, data, editor, handleMutationError, permissions.canArchiveProvider, refresh, t]);

  const handleRollback = useCallback(
    (targetRevision: number) => {
      if (editor.dirty || editor.conflict || !permissions.canPublishProvider) return;
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
          try {
            await adminAiCatalogService.rollbackProvider(input as AdminAiProviderRollbackInput);
            editor.setActionError(null);
            await refresh();
            toast.success(t('aiCatalog.toast.rolledBack'));
          } catch (cause) {
            handleMutationError(cause);
            throw cause;
          }
        },
        submitLabel: t('aiCatalog.actions.rollback.label'),
        targetLabel: data.draft.displayName,
        title: t('aiCatalog.actions.rollback.title'),
      });
    },
    [authMethod, data, editor, handleMutationError, permissions.canPublishProvider, refresh, t],
  );

  const handleCreateModel = useCallback(() => {
    if (editor.dirty || editor.conflict || !permissions.canCreateModel) return;
    const draftToken = data.draftToken;
    openModelEditorModal({
      authMethod: authMethod ?? undefined,
      onSubmit: async ({ fields, modelKey, reason }) => {
        setActionLoadingId('models');
        try {
          const input: AdminAiModelCreateInput = {
            ...fields,
            expectedDraftToken: draftToken,
            modelKey,
            providerId: data.draft.id,
            reason,
          };
          await adminAiCatalogService.createModel(input);
          editor.setActionError(null);
          await refresh();
          toast.success(t('aiCatalog.toast.modelCreated'));
        } catch (cause) {
          handleMutationError(cause);
          throw cause;
        } finally {
          setActionLoadingId(null);
        }
      },
    });
  }, [authMethod, data, editor, handleMutationError, permissions.canCreateModel, refresh, t]);

  const handleEditModel = useCallback(
    async (model: AdminAiModelDraft) => {
      if (
        editor.dirty ||
        editor.conflict ||
        !permissions.canReadModels ||
        !permissions.canUpdateModel
      ) {
        return;
      }
      setActionLoadingId(model.id);
      try {
        const dependents = await adminAiCatalogService.getModelDependents({
          id: model.id,
          providerId: data.draft.id,
        });
        const draftToken = data.draftToken;
        openModelEditorModal({
          authMethod: authMethod ?? undefined,
          disableAvailability: model.enabled && hasBlockingModelDependents(dependents),
          model,
          onSubmit: async ({ fields, reason }) => {
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
              await adminAiCatalogService.updateModel(input);
              editor.setActionError(null);
              await refresh();
              toast.success(t('aiCatalog.toast.modelUpdated'));
            } catch (cause) {
              handleMutationError(cause);
              throw cause;
            } finally {
              setActionLoadingId(null);
            }
          },
        });
      } catch (cause) {
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
      refresh,
      t,
    ],
  );

  const handleDeleteModel = useCallback(
    async (model: AdminAiModelDraft) => {
      if (
        editor.dirty ||
        editor.conflict ||
        !permissions.canDeleteModel ||
        !permissions.canReadModels
      ) {
        return;
      }
      setActionLoadingId(model.id);
      try {
        const dependents = await adminAiCatalogService.getModelDependents({
          id: model.id,
          providerId: data.draft.id,
        });
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
            setActionLoadingId(model.id);
            try {
              await adminAiCatalogService.deleteModel(input as AdminAiModelDeleteInput);
              editor.setActionError(null);
              await refresh();
              toast.success(t('aiCatalog.toast.modelDeleted'));
            } catch (cause) {
              handleMutationError(cause);
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
      refresh,
      t,
    ],
  );

  const handleReorderModels = useCallback(
    (orderedIds: string[]) => {
      if (editor.dirty || editor.conflict || !permissions.canReorderModels) return;
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
          setActionLoadingId('models');
          try {
            await adminAiCatalogService.reorderModels(input as AdminAiModelReorderInput);
            editor.setActionError(null);
            await refresh();
            toast.success(t('aiCatalog.toast.modelsReordered'));
          } catch (cause) {
            handleMutationError(cause);
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
    [authMethod, data, editor, handleMutationError, permissions.canReorderModels, refresh, t],
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
  };
};
