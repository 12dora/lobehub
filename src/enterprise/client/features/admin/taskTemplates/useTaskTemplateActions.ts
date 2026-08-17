'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { adminTaskTemplatesService } from '@/enterprise/client/services/adminTaskTemplates';

import { openDangerConfirm } from '../primitives/DangerConfirm';
import { openTaskTemplateEditorModal } from './openTaskTemplateEditorModal';
import type { AdminTaskTemplateItem } from './types';
import { refreshAdminTaskTemplateLists } from './useAdminTaskTemplates';

export const useTaskTemplateActions = (items?: AdminTaskTemplateItem[]) => {
  const { t, i18n } = useTranslation('admin');
  const [importing, setImporting] = useState(false);
  /** Rows whose switch is optimistically flipped while the mutation is in flight. */
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  /** Optimistic drag result: ids in their new order, discarded once the server answers. */
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  const reportMutationFailure = useCallback(
    (error: unknown) => {
      const isConflict = mapEnterpriseError(error)?.code === 'PLATFORM_REVISION_CONFLICT';
      toast.error(
        isConflict ? t('taskTemplateCatalog.toast.conflict') : t('taskTemplateCatalog.toast.error'),
      );
      return isConflict;
    },
    [t],
  );

  const handleReorder = useCallback(
    async (orderedIds: string[]) => {
      const list = items ?? [];
      const byId = new Map(list.map((item) => [item.id, item]));
      if (orderedIds.some((id) => !byId.has(id))) return;

      // Optimistic: the row lands where it was dropped immediately.
      setPendingOrder(orderedIds);
      try {
        await adminTaskTemplatesService.reorder({
          items: orderedIds.map((id) => ({
            expectedRevision: byId.get(id)!.revision,
            id,
          })),
        });
        toast.success(t('taskTemplateCatalog.toast.reordered'));
        await refreshAdminTaskTemplateLists();
      } catch (error) {
        // Rollback to the server order; a stale drag is a conflict, not a lost write.
        reportMutationFailure(error);
        await refreshAdminTaskTemplateLists();
      } finally {
        setPendingOrder(null);
      }
    },
    [items, reportMutationFailure, t],
  );

  const handleToggle = useCallback(
    async (item: AdminTaskTemplateItem, next: boolean) => {
      setPendingEnabled((current) => ({ ...current, [item.id]: next }));
      try {
        await adminTaskTemplatesService.setEnabled({
          enabled: next,
          expectedRevision: item.revision,
          id: item.id,
        });
        toast.success(
          next ? t('taskTemplateCatalog.toast.enabled') : t('taskTemplateCatalog.toast.disabled'),
        );
        await refreshAdminTaskTemplateLists();
      } catch (error) {
        // A stale row is not a failed write — reload so the operator sees the current state.
        if (reportMutationFailure(error)) {
          await refreshAdminTaskTemplateLists();
        }
      } finally {
        // Rollback the optimistic flag either way: the refreshed row is now authoritative.
        setPendingEnabled((current) => {
          const { [item.id]: _dropped, ...rest } = current;
          return rest;
        });
      }
    },
    [reportMutationFailure, t],
  );

  const handleDelete = useCallback(
    (item: AdminTaskTemplateItem) => {
      openDangerConfirm({
        confirmText: t('taskTemplateCatalog.delete.confirm'),
        content: t('taskTemplateCatalog.delete.content', { title: item.title }),
        title: t('taskTemplateCatalog.delete.title'),
        onConfirm: async () => {
          try {
            await adminTaskTemplatesService.delete({
              expectedRevision: item.revision,
              id: item.id,
            });
            toast.success(t('taskTemplateCatalog.toast.deleted'));
            await refreshAdminTaskTemplateLists();
          } catch (error) {
            reportMutationFailure(error);
            await refreshAdminTaskTemplateLists();
          }
        },
      });
    },
    [reportMutationFailure, t],
  );

  const openEditor = useCallback(
    (item?: AdminTaskTemplateItem) => {
      openTaskTemplateEditorModal({
        item,
        // Conflict path: refresh the table and hand the editor the current server row. Errors and
        // a deleted row both propagate to the modal, which stays open and reports them there.
        onReload: async (stale: AdminTaskTemplateItem) => {
          const refreshed = await refreshAdminTaskTemplateLists();
          return refreshed.find((row) => row.id === stale.id);
        },
        onSubmit: async (payload) => {
          if (item) {
            await adminTaskTemplatesService.update({
              ...payload,
              expectedRevision: item.revision,
              id: item.id,
            });
            toast.success(t('taskTemplateCatalog.toast.updated'));
          } else {
            await adminTaskTemplatesService.create(payload);
            toast.success(t('taskTemplateCatalog.toast.created'));
          }
          await refreshAdminTaskTemplateLists();
        },
      });
    },
    [t],
  );

  const handleImport = useCallback(() => {
    openDangerConfirm({
      confirmText: t('taskTemplateCatalog.import.confirm'),
      content: t('taskTemplateCatalog.import.content'),
      title: t('taskTemplateCatalog.import.title'),
      onConfirm: async () => {
        setImporting(true);
        try {
          const result = await adminTaskTemplatesService.importRecommendations({
            locale: i18n.resolvedLanguage || i18n.language,
          });
          // Discarded upstream rows are a real outcome, not a detail to swallow.
          const message = t(
            result.skipped > 0
              ? 'taskTemplateCatalog.toast.importedWithSkipped'
              : 'taskTemplateCatalog.toast.imported',
            { created: result.created, skipped: result.skipped, updated: result.updated },
          );
          if (result.skipped > 0) toast.warning(message);
          else toast.success(message);
          await refreshAdminTaskTemplateLists();
        } catch {
          toast.error(t('taskTemplateCatalog.toast.error'));
        } finally {
          setImporting(false);
        }
      },
    });
  }, [i18n.language, i18n.resolvedLanguage, t]);

  return {
    handleDelete,
    handleImport,
    handleReorder,
    handleToggle,
    importing,
    openEditor,
    pendingEnabled,
    pendingOrder,
  };
};
