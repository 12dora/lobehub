'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { adminAgentTemplatesService } from '@/enterprise/client/services/adminAgentTemplates';

import { openDangerConfirm } from '../primitives/DangerConfirm';
import { runAgentTemplateBulkDelete, toastAgentTemplateBulkSummary } from './bulkDelete';
import { openAgentTemplateEditorModal } from './openAgentTemplateEditorModal';
import { reloadAgentTemplate } from './reloadAgentTemplate';
import type { AdminAgentTemplateItem } from './types';
import { refreshAdminAgentTemplateLists } from './useAdminAgentTemplates';

export const useAgentTemplateActions = (items?: AdminAgentTemplateItem[]) => {
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
        isConflict
          ? t('agentTemplateCatalog.toast.conflict')
          : t('agentTemplateCatalog.toast.error'),
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
        await adminAgentTemplatesService.reorder({
          items: orderedIds.map((id) => ({
            expectedRevision: byId.get(id)!.revision,
            id,
          })),
        });
        toast.success(t('agentTemplateCatalog.toast.reordered'));
        await refreshAdminAgentTemplateLists();
      } catch (error) {
        // Rollback to the server order; a stale drag is a conflict, not a lost write.
        reportMutationFailure(error);
        await refreshAdminAgentTemplateLists();
      } finally {
        setPendingOrder(null);
      }
    },
    [items, reportMutationFailure, t],
  );

  const handleToggle = useCallback(
    async (item: AdminAgentTemplateItem, next: boolean) => {
      setPendingEnabled((current) => ({ ...current, [item.id]: next }));
      try {
        await adminAgentTemplatesService.setEnabled({
          enabled: next,
          expectedRevision: item.revision,
          id: item.id,
        });
        toast.success(
          next ? t('agentTemplateCatalog.toast.enabled') : t('agentTemplateCatalog.toast.disabled'),
        );
        await refreshAdminAgentTemplateLists();
      } catch (error) {
        // A stale row is not a failed write — reload so the operator sees the current state.
        if (reportMutationFailure(error)) {
          await refreshAdminAgentTemplateLists();
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
    (item: AdminAgentTemplateItem) => {
      openDangerConfirm({
        confirmText: t('agentTemplateCatalog.delete.confirm'),
        content: t('agentTemplateCatalog.delete.content', { title: item.title }),
        title: t('agentTemplateCatalog.delete.title'),
        onConfirm: async () => {
          try {
            await adminAgentTemplatesService.delete({
              expectedRevision: item.revision,
              id: item.id,
            });
            toast.success(t('agentTemplateCatalog.toast.deleted'));
            await refreshAdminAgentTemplateLists();
          } catch (error) {
            reportMutationFailure(error);
            await refreshAdminAgentTemplateLists();
          }
        },
      });
    },
    [reportMutationFailure, t],
  );

  /**
   * Bulk delete: one confirmation for the whole selection, then the single-row mutation per
   * row. There is no server bulk procedure, so a partial result is possible and reported.
   */
  const handleBulkDelete = useCallback(
    (targets: readonly AdminAgentTemplateItem[], onDone: () => void) => {
      if (targets.length === 0) return;
      openDangerConfirm({
        confirmText: t('agentTemplateCatalog.bulkDelete.confirm'),
        content: t('agentTemplateCatalog.bulkDelete.content', { count: targets.length }),
        title: t('agentTemplateCatalog.bulkDelete.title'),
        onConfirm: async () => {
          const result = await runAgentTemplateBulkDelete({
            items: targets,
            t,
            mutate: (item) =>
              adminAgentTemplatesService.delete({
                expectedRevision: item.revision,
                id: item.id,
              }),
          });
          toastAgentTemplateBulkSummary(result, t);
          // The list is authoritative again either way — rows that failed stay, and the
          // selection is dropped so no stale CAS token can be replayed.
          await refreshAdminAgentTemplateLists();
          onDone();
        },
      });
    },
    [t],
  );

  const openEditor = useCallback(
    (item?: AdminAgentTemplateItem) => {
      openAgentTemplateEditorModal({
        item,
        // Two separate reads on purpose. The editor needs an *authoritative* row, which the cache
        // refresh cannot give: a matcher mutation resolves out of the SWR cache, and the admin
        // table's pages are filtered and paginated, so a row that still exists can be missing from
        // them and read as "deleted". The refresh is a side effect for the table, and its failure
        // must not downgrade a successful row read to "could not verify".
        onReload: async (stale: AdminAgentTemplateItem) => {
          const result = await reloadAgentTemplate(stale);
          await refreshAdminAgentTemplateLists().catch(() => undefined);
          return result;
        },
        // `current` is the row the editor is bound to *now*. After a conflict reload the modal
        // reopens against the refreshed row, so replaying the revision captured when the editor
        // first opened would lose to the same conflict on every retry.
        onSubmit: async (payload, current) => {
          if (current) {
            await adminAgentTemplatesService.update({
              ...payload,
              expectedRevision: current.revision,
              id: current.id,
            });
            toast.success(t('agentTemplateCatalog.toast.updated'));
          } else {
            await adminAgentTemplatesService.create(payload);
            toast.success(t('agentTemplateCatalog.toast.created'));
          }
          await refreshAdminAgentTemplateLists();
        },
      });
    },
    [t],
  );

  const handleImport = useCallback(() => {
    openDangerConfirm({
      confirmText: t('agentTemplateCatalog.import.confirm'),
      content: t('agentTemplateCatalog.import.content'),
      title: t('agentTemplateCatalog.import.title'),
      onConfirm: async () => {
        setImporting(true);
        try {
          const result = await adminAgentTemplatesService.importBuiltins({
            locale: i18n.resolvedLanguage || i18n.language,
          });
          // Discarded upstream rows are a real outcome, not a detail to swallow.
          const message = t(
            result.skipped > 0
              ? 'agentTemplateCatalog.toast.importedWithSkipped'
              : 'agentTemplateCatalog.toast.imported',
            { created: result.created, skipped: result.skipped, updated: result.updated },
          );
          if (result.skipped > 0) toast.warning(message);
          else toast.success(message);
          await refreshAdminAgentTemplateLists();
        } catch {
          toast.error(t('agentTemplateCatalog.toast.error'));
        } finally {
          setImporting(false);
        }
      },
    });
  }, [i18n.language, i18n.resolvedLanguage, t]);

  return {
    handleBulkDelete,
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
