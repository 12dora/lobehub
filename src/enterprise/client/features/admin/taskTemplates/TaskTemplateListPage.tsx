'use client';

import { Alert, Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, Select, Switch, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminTaskTemplatesService } from '@/enterprise/client/services/adminTaskTemplates';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { openDangerConfirm } from '../primitives/DangerConfirm';
import DataTable from '../primitives/DataTable';
import { deriveTaskTemplatePermissions } from './controller';
import { openTaskTemplateEditorModal } from './openTaskTemplateEditorModal';
import { formatTaskTemplateSchedule } from './schedule';
import type { AdminTaskTemplateItem, AdminTaskTemplateListQuery } from './types';
import { refreshAdminTaskTemplateLists, useFetchAdminTaskTemplates } from './useAdminTaskTemplates';

const DEFAULT_PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
  rowActions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
}));

const TaskTemplateListPage = memo(() => {
  const { t, i18n } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const { canCreate, canDelete, canRead, canUpdate } = deriveTaskTemplatePermissions(permissions);
  // Import both creates rows and overwrites existing content — it needs both permissions,
  // exactly like the server's compound gate.
  const canImport = canCreate && canUpdate;
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get('q') ?? '';
  const normalizedQuery = query.trim();
  const enabledParam = searchParams.get('enabled');
  const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;

  const [queryDraft, setQueryDraft] = useState(query);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [importing, setImporting] = useState(false);
  /** Rows whose switch is optimistically flipped while the mutation is in flight. */
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  const searchTimerRef = useRef<number | null>(null);

  const input = useMemo<AdminTaskTemplateListQuery>(
    () => ({
      enabled,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      query: normalizedQuery || undefined,
    }),
    [enabled, normalizedQuery, page, pageSize],
  );
  const { data, error, isLoading, mutate } = useFetchAdminTaskTemplates(input, canRead);

  const patchFilter = useCallback(
    (key: 'enabled' | 'q', value?: string) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      setSearchParams(next, { replace: true });
      setPage(1);
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => setQueryDraft(query), [query]);
  useEffect(() => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    if (queryDraft === query) return;
    searchTimerRef.current = window.setTimeout(
      () => patchFilter('q', queryDraft.trim() || undefined),
      SEARCH_DEBOUNCE_MS,
    );
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, [patchFilter, query, queryDraft]);

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
        if (mapEnterpriseError(error)?.code === 'PLATFORM_REVISION_CONFLICT') {
          toast.error(t('taskTemplateCatalog.toast.conflict'));
          await refreshAdminTaskTemplateLists();
        } else {
          toast.error(t('taskTemplateCatalog.toast.error'));
        }
      } finally {
        // Rollback the optimistic flag either way: the refreshed row is now authoritative.
        setPendingEnabled((current) => {
          const { [item.id]: _dropped, ...rest } = current;
          return rest;
        });
      }
    },
    [t],
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
            if (mapEnterpriseError(error)?.code === 'PLATFORM_REVISION_CONFLICT') {
              toast.error(t('taskTemplateCatalog.toast.conflict'));
            } else {
              toast.error(t('taskTemplateCatalog.toast.error'));
            }
            await refreshAdminTaskTemplateLists();
          }
        },
      });
    },
    [t],
  );

  const openEditor = useCallback(
    (item?: AdminTaskTemplateItem) => {
      openTaskTemplateEditorModal({
        item,
        // Conflict path: refresh the table and hand the editor the current server row. Errors and
        // a deleted row both propagate to the modal, which stays open and reports them there.
        onReload: async (stale: AdminTaskTemplateItem) => {
          const rows = await refreshAdminTaskTemplateLists();
          return rows.find((row) => row.id === stale.id);
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

  const columns = useMemo<TableColumnsType<AdminTaskTemplateItem>>(
    () => [
      {
        key: 'template',
        title: t('taskTemplateCatalog.list.columns.template'),
        render: (_, item) => (
          <div className={styles.identity}>
            <Text ellipsis strong>
              {item.title}
            </Text>
            <Text ellipsis type="secondary">
              {item.description || item.identifier}
            </Text>
          </div>
        ),
      },
      {
        dataIndex: 'category',
        key: 'category',
        title: t('taskTemplateCatalog.list.columns.category'),
        render: (value: AdminTaskTemplateItem['category']) =>
          t(`taskTemplateCatalog.category.${value}` as never),
      },
      {
        dataIndex: 'cronPattern',
        key: 'schedule',
        title: t('taskTemplateCatalog.list.columns.schedule'),
        render: (value: string) =>
          formatTaskTemplateSchedule(value, t as never, i18n.resolvedLanguage || i18n.language),
      },
      {
        dataIndex: 'connectors',
        key: 'connectors',
        title: t('taskTemplateCatalog.list.columns.connectors'),
        render: (value: AdminTaskTemplateItem['connectors']) =>
          value.length === 0 ? (
            <Text type="secondary">{t('taskTemplateCatalog.list.connectors.none')}</Text>
          ) : (
            <Flexbox horizontal gap={4} wrap="wrap">
              {value.map((connector) => (
                <Tag key={`${connector.source}:${connector.identifier}`}>
                  {connector.identifier}
                </Tag>
              ))}
            </Flexbox>
          ),
      },
      {
        dataIndex: 'enabled',
        key: 'enabled',
        title: t('taskTemplateCatalog.list.columns.enabled'),
        render: (value: boolean, item) => (
          <Switch
            aria-label={t('taskTemplateCatalog.list.columns.enabled')}
            checked={pendingEnabled[item.id] ?? value}
            disabled={!canUpdate || item.id in pendingEnabled}
            onChange={(next) => void handleToggle(item, next)}
          />
        ),
      },
      {
        dataIndex: 'source',
        key: 'source',
        title: t('taskTemplateCatalog.list.columns.source'),
        render: (value: AdminTaskTemplateItem['source']) =>
          t(`taskTemplateCatalog.source.${value}` as never),
      },
      {
        dataIndex: 'updatedAt',
        key: 'updatedAt',
        title: t('taskTemplateCatalog.list.columns.updatedAt'),
        render: (value: Date) => new Date(value).toLocaleString(),
      },
      {
        key: 'actions',
        title: t('taskTemplateCatalog.list.columns.actions'),
        render: (_, item) => (
          <div className={styles.rowActions}>
            {canUpdate ? (
              <Button size="small" onClick={() => openEditor(item)}>
                {t('taskTemplateCatalog.actions.edit')}
              </Button>
            ) : null}
            {canDelete ? (
              <Button danger size="small" onClick={() => handleDelete(item)}>
                {t('taskTemplateCatalog.actions.delete')}
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [
      canDelete,
      canUpdate,
      handleDelete,
      handleToggle,
      i18n.language,
      i18n.resolvedLanguage,
      openEditor,
      pendingEnabled,
      t,
    ],
  );

  const filtered = Boolean(normalizedQuery || enabled !== undefined);
  const headerActions = (
    <>
      {canImport ? (
        <Button loading={importing} onClick={handleImport}>
          {t('taskTemplateCatalog.actions.import')}
        </Button>
      ) : null}
      {canCreate ? (
        <Button type="primary" onClick={() => openEditor()}>
          {t('taskTemplateCatalog.actions.create')}
        </Button>
      ) : null}
    </>
  );

  return (
    <AdminPageTemplate
      actions={headerActions}
      description={t('taskTemplateCatalog.desc')}
      title={t('taskTemplateCatalog.title')}
      toolbar={
        <Flexbox horizontal gap={8} wrap="wrap">
          <Input
            allowClear
            aria-label={t('taskTemplateCatalog.list.filters.query')}
            placeholder={t('taskTemplateCatalog.list.filters.query')}
            style={{ minWidth: 240 }}
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
          />
          <Select
            allowClear
            aria-label={t('taskTemplateCatalog.list.filters.enabled')}
            placeholder={t('taskTemplateCatalog.list.filters.enabled')}
            style={{ minWidth: 140 }}
            value={enabledParam === 'true' || enabledParam === 'false' ? enabledParam : undefined}
            options={[
              { label: t('taskTemplateCatalog.boolean.true'), value: 'true' },
              { label: t('taskTemplateCatalog.boolean.false'), value: 'false' },
            ]}
            onChange={(value) => patchFilter('enabled', value as string | undefined)}
          />
        </Flexbox>
      }
    >
      <DataTable<AdminTaskTemplateItem>
        columns={columns}
        dataSource={data?.items}
        error={Boolean(error) && !data}
        loading={isLoading && !data}
        rowKey="id"
        emptyDescription={
          filtered
            ? t('taskTemplateCatalog.list.empty.filtered')
            : t('taskTemplateCatalog.list.empty.default')
        }
        pagination={{
          current: page,
          pageSize,
          total: data?.totalFiltered ?? 0,
        }}
        onRetry={() => void mutate()}
        onPaginationChange={(nextPage, nextPageSize) => {
          setPage(nextPage);
          setPageSize(nextPageSize);
        }}
      />
      {error && data ? (
        <Alert
          showIcon
          message={t('taskTemplateCatalog.list.error.page')}
          type="error"
          extra={
            <Button onClick={() => void mutate()}>{t('taskTemplateCatalog.actions.retry')}</Button>
          }
        />
      ) : null}
    </AdminPageTemplate>
  );
});

TaskTemplateListPage.displayName = 'AdminTaskTemplateListPage';

export default TaskTemplateListPage;
