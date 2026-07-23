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
  deriveGlobalModelActions,
  hasBlockingModelDependents,
} from '../controller';
import { openModelEditorModal } from '../models/openModelEditorModal';
import { commitThenScheduleRefresh } from '../mutationRefresh';
import type {
  AdminAiModelCreateInput,
  AdminAiModelDeleteInput,
  AdminAiModelListItem,
  AdminAiModelReorderInput,
  AdminAiModelUpdateInput,
} from '../types';
import { createAiCatalogWriteEpochGuard } from '../writeEpochGuard';
import { refreshAdminAiModelLists, refreshAdminAiProvider } from './useAdminAiCatalog';

export const useGlobalModelActions = (params: {
  authMethod: AdminReauthAuthMethod | null;
  permissions: AiCatalogPermissions;
}) => {
  const { t } = useTranslation('admin');
  const allowed = deriveGlobalModelActions(params.permissions);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshRetrying, setRefreshRetrying] = useState(false);
  const refreshGenerationRef = useRef(0);
  /** Provider whose detail must be re-invalidated on retry (survives list-only retry bugs). */
  const pendingProviderRefreshRef = useRef<string | undefined>(undefined);
  const writeGuardRef = useRef(createAiCatalogWriteEpochGuard());
  const writeGuard = writeGuardRef.current;
  const reloadRequired = refreshFailed || refreshPending;

  const errorText = useCallback(
    (cause: unknown) => {
      const mapped = mapEnterpriseError(cause);
      return mapped
        ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
        : t('aiCatalog.errors.generic');
    },
    [t],
  );

  /** Invalidate model lists and the owning provider detail (draft token / models). */
  const refreshAfterModelMutation = useCallback(async (providerId?: string) => {
    await refreshAdminAiModelLists();
    if (providerId) await refreshAdminAiProvider(providerId);
  }, []);

  const commitAndRefresh = useCallback(
    async <Result,>(commit: () => Promise<Result>, successKey: string, providerId?: string) => {
      const generation = ++refreshGenerationRef.current;
      if (providerId) pendingProviderRefreshRef.current = providerId;
      return commitThenScheduleRefresh({
        commit,
        refresh: () => refreshAfterModelMutation(providerId),
        onCommitted: () => {
          writeGuard.lock();
          setRefreshFailed(false);
          setRefreshPending(true);
          toast.success(t(successKey as never));
        },
        onRefreshed: () => {
          if (refreshGenerationRef.current === generation) {
            pendingProviderRefreshRef.current = undefined;
            writeGuard.unlock();
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
    [refreshAfterModelMutation, t, writeGuard],
  );

  const retryRefresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const providerId = pendingProviderRefreshRef.current;
    writeGuard.lock();
    setRefreshRetrying(true);
    setRefreshPending(true);
    try {
      // Full invalidation: model lists + provider detail/draft token when applicable.
      await refreshAfterModelMutation(providerId);
      if (refreshGenerationRef.current === generation) {
        pendingProviderRefreshRef.current = undefined;
        writeGuard.unlock();
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
  }, [refreshAfterModelMutation, writeGuard]);

  const handleCreate = useCallback(
    async (providerId: string) => {
      if (!allowed.canCreate) return;
      const epoch = writeGuard.begin();
      if (epoch === null) throw new Error('PLATFORM_REVISION_CONFLICT');
      setActionLoadingId(`provider:${providerId}`);
      try {
        const context = await adminAiCatalogService.getModelCreateDraftContext({ providerId });
        writeGuard.assertCurrent(epoch);
        openModelEditorModal({
          authMethod: params.authMethod ?? undefined,
          onSubmit: async ({ fields, modelKey, reason }) => {
            writeGuard.assertCurrent(epoch);
            setActionLoadingId(`provider:${providerId}`);
            try {
              const input: AdminAiModelCreateInput = {
                ...fields,
                expectedDraftToken: context.draftToken,
                modelKey,
                providerId,
                reason,
              };
              await commitAndRefresh(
                () => adminAiCatalogService.createModel(input),
                'aiCatalog.toast.modelCreated',
                providerId,
              );
            } finally {
              setActionLoadingId(null);
            }
          },
        });
      } catch (cause) {
        toast.error(errorText(cause));
        throw cause;
      } finally {
        setActionLoadingId(null);
      }
    },
    [allowed.canCreate, commitAndRefresh, errorText, params.authMethod, writeGuard],
  );

  const handleEdit = useCallback(
    async (model: AdminAiModelListItem) => {
      if (!allowed.canEdit) return;
      const epoch = writeGuard.begin();
      if (epoch === null) return;
      setActionLoadingId(model.id);
      try {
        const [context, dependents] = await Promise.all([
          adminAiCatalogService.getModelUpdateDraftContext({ providerId: model.providerId }),
          adminAiCatalogService.getModelDependents({
            id: model.id,
            providerId: model.providerId,
          }),
        ]);
        if (!writeGuard.isCurrent(epoch)) return;
        openModelEditorModal({
          authMethod: params.authMethod ?? undefined,
          disableAvailability: model.enabled && hasBlockingModelDependents(dependents),
          model,
          onSubmit: async ({ fields, reason }) => {
            writeGuard.assertCurrent(epoch);
            setActionLoadingId(model.id);
            try {
              const input: AdminAiModelUpdateInput = {
                ...fields,
                expectedDraftToken: context.draftToken,
                expectedRevision: model.revision,
                id: model.id,
                providerId: model.providerId,
                reason,
              };
              await commitAndRefresh(
                () => adminAiCatalogService.updateModel(input),
                'aiCatalog.toast.modelUpdated',
                model.providerId,
              );
            } finally {
              setActionLoadingId(null);
            }
          },
        });
      } catch (cause) {
        if (!writeGuard.isCurrent(epoch)) return;
        toast.error(errorText(cause));
      } finally {
        setActionLoadingId(null);
      }
    },
    [allowed.canEdit, commitAndRefresh, errorText, params.authMethod, writeGuard],
  );

  const handleDelete = useCallback(
    async (model: AdminAiModelListItem) => {
      if (!allowed.canDelete) return;
      const epoch = writeGuard.begin();
      if (epoch === null) return;
      setActionLoadingId(model.id);
      try {
        const [context, dependents] = await Promise.all([
          adminAiCatalogService.getModelDeleteDraftContext({ providerId: model.providerId }),
          adminAiCatalogService.getModelDependents({
            id: model.id,
            providerId: model.providerId,
          }),
        ]);
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
        openReasonModal({
          authMethod: params.authMethod ?? undefined,
          buildPayload: (reason) => ({
            expectedDraftToken: context.draftToken,
            id: model.id,
            providerId: model.providerId,
            reason,
          }),
          danger: true,
          description: t('aiCatalog.actions.deleteModel.desc'),
          onSubmit: async (input) => {
            writeGuard.assertCurrent(epoch);
            setActionLoadingId(model.id);
            try {
              await commitAndRefresh(
                () => adminAiCatalogService.deleteModel(input as AdminAiModelDeleteInput),
                'aiCatalog.toast.modelDeleted',
                model.providerId,
              );
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
        toast.error(errorText(cause));
      } finally {
        setActionLoadingId(null);
      }
    },
    [allowed.canDelete, commitAndRefresh, errorText, params.authMethod, t, writeGuard],
  );

  const handleReorder = useCallback(
    async (model: AdminAiModelListItem, offset: -1 | 1) => {
      if (!allowed.canReorder) return;
      const epoch = writeGuard.begin();
      if (epoch === null) return;
      setActionLoadingId(model.id);
      try {
        const context = await adminAiCatalogService.getModelUpdateDraftContext({
          providerId: model.providerId,
        });
        if (!writeGuard.isCurrent(epoch)) return;
        const index = context.modelIds.indexOf(model.id);
        const target = index + offset;
        if (index < 0 || target < 0 || target >= context.modelIds.length) return;
        const orderedIds = [...context.modelIds];
        [orderedIds[index], orderedIds[target]] = [orderedIds[target]!, orderedIds[index]!];
        const items = buildCompleteModelOrder(context.modelIds, orderedIds);
        if (!items) throw new Error('PLATFORM_REVISION_CONFLICT');
        openReasonModal({
          authMethod: params.authMethod ?? undefined,
          buildPayload: (reason) => ({
            expectedDraftToken: context.draftToken,
            items,
            providerId: model.providerId,
            reason,
          }),
          description: t('aiCatalog.actions.reorder.desc'),
          onSubmit: async (input) => {
            writeGuard.assertCurrent(epoch);
            setActionLoadingId(model.id);
            try {
              await commitAndRefresh(
                () => adminAiCatalogService.reorderModels(input as AdminAiModelReorderInput),
                'aiCatalog.toast.modelsReordered',
                model.providerId,
              );
            } finally {
              setActionLoadingId(null);
            }
          },
          submitLabel: t('aiCatalog.actions.reorder.label'),
          targetLabel: `${model.providerKey}/${model.modelKey}`,
          title: t('aiCatalog.actions.reorder.title'),
        });
      } catch (cause) {
        if (!writeGuard.isCurrent(epoch)) return;
        toast.error(errorText(cause));
      } finally {
        setActionLoadingId(null);
      }
    },
    [allowed.canReorder, commitAndRefresh, errorText, params.authMethod, t, writeGuard],
  );

  return {
    actionLoadingId,
    allowed,
    handleCreate,
    handleDelete,
    handleEdit,
    handleReorder,
    refreshFailed,
    refreshPending,
    refreshRetrying,
    reloadRequired,
    retryRefresh,
  };
};
