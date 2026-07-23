'use client';

import { Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, Popover, Select } from '@lobehub/ui/base-ui';
import { DatePicker, type TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import dayjs, { type Dayjs } from 'dayjs';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAuditEventListItem } from '@/enterprise/client/services/adminAudit';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import DataTable from '../../primitives/DataTable';
import {
  useFetchAuditEventFacets,
  useFetchAuditEventsList,
  useFetchAuditEventStats,
} from '../hooks/useAdminAudit';
import AuditStatusTag from '../shared/AuditStatusTag';
import AuditUserSearchSelect from '../shared/AuditUserSearchSelect';
import {
  auditActionLabel,
  auditTargetTypeLabel,
  formatAdminDateTime,
  hasPermission,
  truncateText,
} from '../shared/format';
import { getDefaultAuditTimeWindow } from '../shared/timeWindow';
import { AUDIT_DEFAULT_LIST_LIMIT, useCursorPagination } from '../shared/useCursorPagination';
import EventDetailDrawer from './EventDetailDrawer';

const DEBOUNCE_MS = 300;

const styles = createStaticStyles(({ css }) => ({
  facetRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  `,
  statCard: css`
    cursor: pointer;

    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;

    min-width: 120px;
    padding-block: 12px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};

    transition: border-color 0.15s ease;

    &:hover {
      border-color: ${cssVar.colorPrimary};
    }

    &[data-active='true'] {
      border-color: ${cssVar.colorPrimary};
      box-shadow: 0 0 0 1px ${cssVar.colorPrimary};
    }
  `,
  statValue: css`
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    line-height: 1.2;
  `,
  stats: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  `,
  filterRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;

    @media (width <= 1200px) {
      align-items: stretch;
    }
  `,
  moreBody: css`
    display: flex;
    flex-direction: column;
    gap: 10px;

    min-width: 260px;
    padding: 4px;
  `,
  moreField: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
  `,
}));

interface ListFilters {
  actions: string[];
  actorUserId?: string;
  from: Date;
  requestId?: string;
  results: Array<'success' | 'failure' | 'denied'>;
  targetId?: string;
  targetType?: string;
  to: Date;
}

const emptyFilters = (): ListFilters => {
  const window = getDefaultAuditTimeWindow();
  return {
    actions: [],
    from: window.from,
    results: [],
    to: window.to,
  };
};

const OperationLogsPage = memo(() => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const canRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

  const [filters, setFilters] = useState<ListFilters>(emptyFilters);
  const {
    currentCursor,
    hasPrevious,
    limit,
    onNext,
    onPageSizeChange,
    onPrevious,
    reset: resetCursor,
    setLimit,
  } = useCursorPagination();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [requestIdDraft, setRequestIdDraft] = useState('');
  const [targetTypeDraft, setTargetTypeDraft] = useState('');
  const [targetIdDraft, setTargetIdDraft] = useState('');
  const requestIdDebounceRef = useRef<number | null>(null);

  // Debounce requestId: draft keystrokes must not fire list/access-audit per key.
  useEffect(() => {
    if (requestIdDebounceRef.current) window.clearTimeout(requestIdDebounceRef.current);
    requestIdDebounceRef.current = window.setTimeout(() => {
      const next = requestIdDraft.trim() || undefined;
      setFilters((prev) => {
        if (prev.requestId === next) return prev;
        resetCursor();
        return { ...prev, requestId: next };
      });
    }, DEBOUNCE_MS);
    return () => {
      if (requestIdDebounceRef.current) window.clearTimeout(requestIdDebounceRef.current);
    };
  }, [requestIdDraft, resetCursor]);

  const listInput = useMemo(
    () => ({
      actions: filters.actions.length ? filters.actions : undefined,
      actorUserId: filters.actorUserId,
      cursor: currentCursor ?? undefined,
      from: filters.from,
      limit,
      requestId: filters.requestId,
      results: filters.results.length ? filters.results : undefined,
      targetId: filters.targetId,
      targetType: filters.targetType,
      to: filters.to,
    }),
    [currentCursor, filters, limit],
  );

  const { data, error, isLoading, mutate } = useFetchAuditEventsList(listInput, canRead);
  const { data: stats } = useFetchAuditEventStats({ from: filters.from, to: filters.to }, canRead);
  const { data: facets } = useFetchAuditEventFacets(
    { from: filters.from, to: filters.to },
    canRead,
  );

  const items = data?.items ?? [];
  const nextCursor = data?.nextCursor ?? null;

  const patchFilters = useCallback(
    (patch: Partial<ListFilters>) => {
      setFilters((prev) => ({ ...prev, ...patch }));
      resetCursor();
    },
    [resetCursor],
  );

  const toggleResult = useCallback(
    (result: 'success' | 'failure' | 'denied' | null) => {
      if (result === null) {
        patchFilters({ results: [] });
        return;
      }
      setFilters((prev) => {
        const has = prev.results.includes(result);
        const next = has ? prev.results.filter((r) => r !== result) : [result];
        return { ...prev, results: next };
      });
      resetCursor();
    },
    [patchFilters, resetCursor],
  );

  const toggleActionFacet = useCallback(
    (action: string) => {
      setFilters((prev) => {
        const has = prev.actions.includes(action);
        const actions = has ? prev.actions.filter((a) => a !== action) : [...prev.actions, action];
        return { ...prev, actions };
      });
      resetCursor();
    },
    [resetCursor],
  );

  const rangeValue: [Dayjs, Dayjs] = useMemo(
    () => [dayjs(filters.from), dayjs(filters.to)],
    [filters.from, filters.to],
  );

  const columns: TableColumnsType<AdminAuditEventListItem> = useMemo(
    () => [
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        title: t('audit.logs.columns.time'),
        width: 170,
        render: (v: Date) => formatAdminDateTime(v),
      },
      {
        dataIndex: 'action',
        key: 'action',
        title: t('audit.logs.columns.action'),
        ellipsis: true,
        render: (v: string) => auditActionLabel(t, v),
      },
      {
        dataIndex: 'actorUserId',
        key: 'actorUserId',
        title: t('audit.logs.columns.actor'),
        width: 140,
        render: (v: string | null) => v ?? '—',
      },
      {
        dataIndex: 'result',
        key: 'result',
        title: t('audit.logs.columns.result'),
        width: 110,
        render: (v: string) => <AuditStatusTag kind="result" value={v} />,
      },
      {
        key: 'target',
        title: t('audit.logs.columns.target'),
        width: 180,
        render: (_, row) => (
          <Text ellipsis style={{ margin: 0 }} type="secondary">
            {auditTargetTypeLabel(t, row.targetType)}
          </Text>
        ),
      },
      {
        dataIndex: 'reason',
        key: 'reason',
        title: t('audit.logs.columns.reason'),
        render: (v: string | null) => truncateText(v, 48),
      },
    ],
    [t],
  );

  const activeResult = filters.results.length === 1 ? filters.results[0] : null;

  const moreFilterCount = [
    filters.targetType,
    filters.targetId,
    filters.requestId || requestIdDraft.trim(),
  ].filter((v) => Boolean(v && String(v).trim())).length;

  const actionOptions = useMemo(() => {
    const fromFacets = (facets?.actions ?? []).map((a) => ({
      label: `${auditActionLabel(t, a.value)} (${a.count})`,
      value: a.value,
    }));
    // Keep selected actions that dropped out of facets.
    for (const a of filters.actions) {
      if (!fromFacets.some((o) => o.value === a)) {
        fromFacets.push({ label: auditActionLabel(t, a), value: a });
      }
    }
    return fromFacets;
  }, [facets?.actions, filters.actions, t]);

  const clearAllFilters = useCallback(() => {
    setRequestIdDraft('');
    setTargetTypeDraft('');
    setTargetIdDraft('');
    setFilters(emptyFilters());
    setLimit(AUDIT_DEFAULT_LIST_LIMIT);
    resetCursor();
  }, [resetCursor, setLimit]);

  const statCards = [
    {
      key: 'total',
      label: t('audit.logs.stats.total'),
      onClick: () => toggleResult(null),
      value: stats?.total ?? '—',
      active: filters.results.length === 0,
      color: undefined as string | undefined,
    },
    {
      key: 'success',
      label: t('audit.logs.stats.success'),
      onClick: () => toggleResult('success'),
      value: stats?.success ?? '—',
      active: activeResult === 'success',
      color: cssVar.colorSuccess,
    },
    {
      key: 'failure',
      label: t('audit.logs.stats.failure'),
      onClick: () => toggleResult('failure'),
      value: stats?.failure ?? '—',
      active: activeResult === 'failure',
      color: cssVar.colorError,
    },
    {
      key: 'denied',
      label: t('audit.logs.stats.denied'),
      onClick: () => toggleResult('denied'),
      value: stats?.denied ?? '—',
      active: activeResult === 'denied',
      color: cssVar.colorWarning,
    },
  ];

  return (
    <AdminPageTemplate
      description={t('audit.logs.page.desc')}
      title={t('audit.logs.page.title')}
      toolbar={
        <Flexbox gap={12}>
          <div className={styles.stats}>
            {statCards.map((card) => (
              <button
                className={styles.statCard}
                data-active={card.active}
                key={card.key}
                type="button"
                onClick={card.onClick}
              >
                <Text style={{ margin: 0 }} type="secondary">
                  {card.label}
                </Text>
                <p
                  className={styles.statValue}
                  style={card.color ? { color: card.color } : undefined}
                >
                  {card.value}
                </p>
              </button>
            ))}
          </div>

          {facets?.actions?.length ? (
            <div className={styles.facetRow}>
              <Text type="secondary">{t('audit.logs.facets.actions')}</Text>
              {facets.actions.map((item) => {
                const selected = filters.actions.includes(item.value);
                return (
                  <Tag
                    key={item.value}
                    size="small"
                    style={{
                      cursor: 'pointer',
                      opacity: selected ? 1 : 0.75,
                      outline: selected ? `1px solid ${cssVar.colorPrimary}` : undefined,
                    }}
                    onClick={() => toggleActionFacet(item.value)}
                  >
                    {auditActionLabel(t, item.value)} ({item.count})
                  </Tag>
                );
              })}
            </div>
          ) : null}

          <div className={styles.filterRow}>
            <DatePicker.RangePicker
              showTime
              allowClear={false}
              size="small"
              style={{ maxWidth: 360 }}
              value={rangeValue}
              onChange={(vals) => {
                if (!vals?.[0] || !vals[1]) return;
                patchFilters({
                  from: vals[0].toDate(),
                  to: vals[1].toDate(),
                });
              }}
            />
            <Select
              allowClear
              mode="multiple"
              options={actionOptions}
              placeholder={t('audit.logs.filters.action')}
              style={{ minWidth: 160, maxWidth: 280 }}
              value={filters.actions.length ? filters.actions : undefined}
              onChange={(v) => {
                const next = (Array.isArray(v) ? v : v ? [v] : []) as string[];
                patchFilters({ actions: next });
              }}
            />
            <Select
              allowClear
              mode="multiple"
              placeholder={t('audit.logs.filters.result')}
              style={{ minWidth: 140, maxWidth: 220 }}
              value={filters.results.length ? filters.results : undefined}
              options={[
                { label: t('audit.status.result.success'), value: 'success' },
                { label: t('audit.status.result.failure'), value: 'failure' },
                { label: t('audit.status.result.denied'), value: 'denied' },
              ]}
              onChange={(v) => {
                const next = (Array.isArray(v) ? v : v ? [v] : []) as Array<
                  'success' | 'failure' | 'denied'
                >;
                patchFilters({ results: next });
              }}
            />
            <div style={{ minWidth: 180, maxWidth: 240, flex: '1 1 180px' }}>
              <AuditUserSearchSelect
                enabled={canRead}
                placeholder={t('audit.logs.filters.actor')}
                style={{ width: '100%', minWidth: 0 }}
                value={filters.actorUserId}
                onChange={(userId) => patchFilters({ actorUserId: userId })}
              />
            </div>
            <Popover
              trigger="click"
              content={
                <div className={styles.moreBody}>
                  <div className={styles.moreField}>
                    <Text type="secondary">{t('audit.logs.filters.targetType')}</Text>
                    <Input
                      value={targetTypeDraft}
                      onChange={(e) => setTargetTypeDraft(e.target.value)}
                      onBlur={() =>
                        patchFilters({ targetType: targetTypeDraft.trim() || undefined })
                      }
                      onPressEnter={() =>
                        patchFilters({ targetType: targetTypeDraft.trim() || undefined })
                      }
                    />
                  </div>
                  <div className={styles.moreField}>
                    <Text type="secondary">{t('audit.logs.filters.targetId')}</Text>
                    <Input
                      value={targetIdDraft}
                      onBlur={() => patchFilters({ targetId: targetIdDraft.trim() || undefined })}
                      onChange={(e) => setTargetIdDraft(e.target.value)}
                      onPressEnter={() =>
                        patchFilters({ targetId: targetIdDraft.trim() || undefined })
                      }
                    />
                  </div>
                  <div className={styles.moreField}>
                    <Text type="secondary">{t('audit.logs.filters.requestId')}</Text>
                    <Input
                      value={requestIdDraft}
                      onChange={(e) => setRequestIdDraft(e.target.value)}
                      onPressEnter={() => {
                        const next = requestIdDraft.trim() || undefined;
                        patchFilters({ requestId: next });
                      }}
                    />
                  </div>
                </div>
              }
            >
              <Button size="small" type="default">
                {moreFilterCount > 0
                  ? t('audit.logs.filters.moreActive', { count: moreFilterCount })
                  : t('audit.logs.filters.more')}
              </Button>
            </Popover>
            {moreFilterCount > 0 ||
            filters.actions.length > 0 ||
            filters.results.length > 0 ||
            filters.actorUserId ||
            requestIdDraft.trim() ||
            targetTypeDraft.trim() ||
            targetIdDraft.trim() ? (
              <Button size="small" type="text" onClick={clearAllFilters}>
                {t('audit.shared.clearFilters')}
              </Button>
            ) : null}
          </div>
        </Flexbox>
      }
    >
      <DataTable<AdminAuditEventListItem>
        columns={columns}
        dataSource={items}
        emptyDescription={t('audit.logs.empty')}
        error={Boolean(error) && !data}
        loading={isLoading && !data}
        pagination={false}
        rowKey="id"
        scroll={{ x: 1100 }}
        cursorPagination={{
          hasNext: Boolean(nextCursor),
          hasPrevious,
          onNext: () => onNext(nextCursor),
          onPrevious,
          pageSize: limit,
          pageSizeOptions: ['20', '50', '100'],
          onPageSizeChange,
        }}
        onRetry={() => void mutate()}
        onRowActivate={(row) => setDetailId(row.id)}
      />

      <EventDetailDrawer
        eventId={detailId}
        filterWindow={{ from: filters.from, to: filters.to }}
        open={Boolean(detailId)}
        onClose={() => setDetailId(null)}
      />
    </AdminPageTemplate>
  );
});

OperationLogsPage.displayName = 'AuditOperationLogsPage';

export default OperationLogsPage;
