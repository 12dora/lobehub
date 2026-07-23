'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, Switch, toast } from '@lobehub/ui/base-ui';
import { Drawer, type TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import type { TFunction } from 'i18next';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAuditExportItem } from '@/enterprise/client/services/adminAudit';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import DataTable from '../../primitives/DataTable';
import { useAdminAuditMutations, useFetchAuditExportsList } from '../hooks/useAdminAudit';
import AuditStatusTag from '../shared/AuditStatusTag';
import { formatAdminDateTime, hasPermission, humanizeAuditToken } from '../shared/format';
import { openAuditReasonModal } from '../shared/openAuditReasonModal';
import { formatAuditBytes } from '../shared/timeWindow';
import { pollWhileInFlight, useCursorPagination } from '../shared/useCursorPagination';
import CreateExportModal from './CreateExportModal';

const styles = createStaticStyles(({ css }) => ({
  mono: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    word-break: break-all;
  `,
  row: css`
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 8px;
    margin-block-end: 8px;
  `,
}));

const triggerBrowserDownload = (url: string) => {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.target = '_blank';
  document.body.append(a);
  a.click();
  a.remove();
};

/** Internal caps / correlation ids that should not surface in the evidence summary. */
const HIDDEN_FILTER_KEYS = new Set([
  'exportArtifactRetentionDays',
  'maxExportRows',
  'policyRevision',
  'requestId',
]);

const formatFilterSnapshot = (
  snapshot: AdminAuditExportItem['filterSnapshot'],
  t: TFunction<'admin'>,
) => {
  return Object.entries(snapshot)
    .filter(([k, v]) => !HIDDEN_FILTER_KEYS.has(k) && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ({
      // Raw key stays unique for React; label may collide across locales.
      key: k,
      label: t(`audit.exports.filter.${k}` as never, { defaultValue: humanizeAuditToken(k) }),
      value: Array.isArray(v) ? v.join(', ') : String(v),
    }));
};

const ExportsPage = memo(() => {
  const { t } = useTranslation('admin');
  const [searchParams] = useSearchParams();
  const { permissions, authMethod } = useAdminAccess();
  const canExport = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_EXPORT);
  const { createExport, downloadExport, cancelExport } = useAdminAuditMutations();

  const [mine, setMine] = useState(false);
  const {
    currentCursor,
    hasPrevious,
    limit,
    onNext,
    onPageSizeChange,
    onPrevious,
    reset: resetCursor,
  } = useCursorPagination();
  const [createOpen, setCreateOpen] = useState(searchParams.get('create') === '1');
  const [detail, setDetail] = useState<AdminAuditExportItem | null>(null);

  const list = useFetchAuditExportsList({ cursor: currentCursor, limit, mine }, canExport, {
    // Single SWR key: poll only while any row is still in flight.
    refreshInterval: pollWhileInFlight(),
  });

  const data = list.data;
  const rows = data?.items ?? [];
  const nextCursor = data?.nextCursor ?? null;
  const error = list.error;
  const isLoading = list.isLoading;
  const mutate = list.mutate;

  const onDownload = useCallback(
    (row: AdminAuditExportItem) => {
      openAuditReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({ id: row.id, reason }),
        description: t('audit.exports.download.desc'),
        onSubmit: async (payload) => {
          const result = await downloadExport(payload as { id: string; reason: string });
          triggerBrowserDownload(result.downloadUrl);
          toast.success(
            t('audit.exports.download.toast', {
              bytes: formatAuditBytes(result.artifactBytes),
            }),
          );
        },
        submitLabel: t('audit.exports.download.submit'),
        targetLabel: row.id,
        title: t('audit.exports.download.title'),
      });
    },
    [authMethod, downloadExport, t],
  );

  const onCancel = useCallback(
    (row: AdminAuditExportItem) => {
      openAuditReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({ id: row.id, reason }),
        danger: true,
        description: t('audit.exports.cancel.desc'),
        onSubmit: async (payload) => {
          await cancelExport(payload as { id: string; reason: string });
          void mutate();
        },
        submitLabel: t('audit.exports.cancel.submit'),
        targetLabel: row.id,
        title: t('audit.exports.cancel.title'),
      });
    },
    [authMethod, cancelExport, mutate, t],
  );

  const columns: TableColumnsType<AdminAuditExportItem> = useMemo(
    () => [
      {
        dataIndex: 'kind',
        key: 'kind',
        title: t('audit.exports.columns.kind'),
        width: 140,
        render: (v: string) => t(`audit.exports.kind.${v}` as never, { defaultValue: v }),
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('audit.exports.columns.status'),
        width: 120,
        render: (v: string) => <AuditStatusTag kind="export" value={v} />,
      },
      {
        dataIndex: 'requestedBy',
        key: 'requestedBy',
        title: t('audit.exports.columns.requestedBy'),
        width: 140,
      },
      {
        dataIndex: 'rowCount',
        key: 'rowCount',
        title: t('audit.exports.columns.rows'),
        width: 90,
        render: (v: number | null) => v ?? '—',
      },
      {
        dataIndex: 'artifactBytes',
        key: 'artifactBytes',
        title: t('audit.exports.columns.size'),
        width: 100,
        render: (v: number | null) => formatAuditBytes(v),
      },
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        title: t('audit.exports.columns.createdAt'),
        width: 160,
        render: (v: Date) => formatAdminDateTime(v),
      },
      {
        dataIndex: 'finishedAt',
        key: 'finishedAt',
        title: t('audit.exports.columns.finishedAt'),
        width: 160,
        render: (v: Date | null) => formatAdminDateTime(v),
      },
      {
        dataIndex: 'expiresAt',
        key: 'expiresAt',
        title: t('audit.exports.columns.expiresAt'),
        width: 160,
        render: (v: Date | null) => formatAdminDateTime(v),
      },
      {
        key: 'actions',
        title: t('audit.exports.columns.actions'),
        width: 160,
        render: (_, row) => (
          <Flexbox horizontal gap={6}>
            {row.status === 'completed' ? (
              <Button size="small" type="primary" onClick={() => onDownload(row)}>
                {t('audit.exports.actions.download')}
              </Button>
            ) : null}
            {row.status === 'pending' || row.status === 'running' ? (
              <Button danger size="small" onClick={() => onCancel(row)}>
                {t('audit.exports.actions.cancel')}
              </Button>
            ) : null}
            {row.status === 'failed' && row.error ? (
              <Button size="small" type="default" onClick={() => setDetail(row)}>
                {t('audit.exports.actions.viewError')}
              </Button>
            ) : null}
          </Flexbox>
        ),
      },
    ],
    [onCancel, onDownload, t],
  );

  return (
    <AdminPageTemplate
      description={t('audit.exports.page.desc')}
      title={t('audit.exports.page.title')}
      actions={
        canExport ? (
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            {t('audit.exports.actions.create')}
          </Button>
        ) : undefined
      }
      toolbar={
        <Flexbox horizontal align="center" gap={8}>
          <Text type="secondary">{t('audit.exports.filters.mine')}</Text>
          <Switch
            checked={mine}
            onChange={(v) => {
              setMine(Boolean(v));
              resetCursor();
            }}
          />
        </Flexbox>
      }
    >
      <DataTable<AdminAuditExportItem>
        columns={columns}
        dataSource={rows}
        emptyDescription={t('audit.exports.empty')}
        error={Boolean(error) && !data}
        loading={isLoading && !data}
        pagination={false}
        rowKey="id"
        scroll={{ x: 1200 }}
        cursorPagination={{
          hasNext: Boolean(nextCursor),
          hasPrevious,
          onNext: () => onNext(nextCursor),
          onPrevious,
          pageSize: limit,
          onPageSizeChange,
        }}
        onRetry={() => void mutate()}
        onRowActivate={(row) => setDetail(row)}
      />

      <CreateExportModal
        authMethod={authMethod}
        open={createOpen}
        searchParams={searchParams}
        onClose={() => setCreateOpen(false)}
        onSubmit={createExport}
        onCreated={() => {
          setCreateOpen(false);
          void mutate();
        }}
      />

      <Drawer
        destroyOnClose
        open={Boolean(detail)}
        title={t('audit.exports.detail.title')}
        width={480}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <div className={styles.row}>
              <Text type="secondary">{t('audit.exports.columns.status')}</Text>
              <AuditStatusTag kind="export" value={detail.status} />
            </div>
            <div className={styles.row}>
              <Text type="secondary">{t('audit.exports.columns.kind')}</Text>
              <span>{t(`audit.exports.kind.${detail.kind}` as never)}</span>
            </div>
            {detail.error ? (
              <div className={styles.row}>
                <Text type="secondary">{t('audit.exports.detail.error')}</Text>
                <span className={styles.mono}>
                  {detail.error.code ? `${detail.error.code}: ` : ''}
                  {detail.error.message ?? '—'}
                </span>
              </div>
            ) : null}
            <Text style={{ fontWeight: 600, marginBlock: 12 }}>
              {t('audit.exports.detail.filters')}
            </Text>
            {formatFilterSnapshot(detail.filterSnapshot, t).map((item) => (
              <div className={styles.row} key={item.key}>
                <Text type="secondary">{item.label}</Text>
                <span className={styles.mono}>{item.value}</span>
              </div>
            ))}
          </>
        ) : null}
      </Drawer>
    </AdminPageTemplate>
  );
});

ExportsPage.displayName = 'AuditExportsPage';

export default ExportsPage;
