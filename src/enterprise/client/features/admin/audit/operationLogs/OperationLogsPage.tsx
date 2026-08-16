'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { DatePicker } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import dayjs, { type Dayjs } from 'dayjs';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAuditEventListItem } from '@/enterprise/client/services/adminAudit';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import type { AdminTableChangeMeta } from '../../primitives/DataTable';
import DataTable from '../../primitives/DataTable';
import {
  useFetchAuditEventFacets,
  useFetchAuditEventsList,
  useFetchAuditEventStats,
} from '../hooks/useAdminAudit';
import { auditActionLabel, hasPermission } from '../shared/format';
import { AUDIT_DEFAULT_LIST_LIMIT, useCursorPagination } from '../shared/useCursorPagination';
import ActionFacetChips from './ActionFacetChips';
import EventDetailDrawer from './EventDetailDrawer';
import {
  type AuditResult,
  emptyFilters,
  firstNonEmpty,
  type ListFilters,
  listFiltersEqual,
  RESULT_VALUES,
  toResultList,
  toStringList,
} from './listFilters';
import { useOperationLogColumns } from './useOperationLogColumns';

const styles = createStaticStyles(({ css }) => ({
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

    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 2px;
    }

    /* Soft filled selected state — hue-independent, no outline ring. */
    &[data-active='true'] {
      border-color: transparent;
      background: ${cssVar.colorFillTertiary};
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
  tableToolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    width: 100%;
  `,
  timeRange: css`
    width: min(360px, 100%);

    &&.ant-picker {
      height: 36px;
    }
  `,
}));

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
  const auxiliaryFailureNotifiedRef = useRef(false);

  const applyFilters = useCallback(
    (patch: Partial<ListFilters>) => {
      setFilters((prev) => {
        const next = { ...prev, ...patch };
        if (listFiltersEqual(prev, next)) return prev;
        resetCursor();
        return next;
      });
    },
    [resetCursor],
  );

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
  const statsResult = useFetchAuditEventStats({ from: filters.from, to: filters.to }, canRead);
  const facetsResult = useFetchAuditEventFacets({ from: filters.from, to: filters.to }, canRead);
  const stats = statsResult.data;
  const facets = facetsResult.data;
  const auxiliaryFailed = Boolean(statsResult.error || facetsResult.error);

  useEffect(() => {
    if (auxiliaryFailed && !auxiliaryFailureNotifiedRef.current) {
      auxiliaryFailureNotifiedRef.current = true;
      toast.error(t('audit.shared.summaryLoadFailed'));
    } else if (!auxiliaryFailed) {
      auxiliaryFailureNotifiedRef.current = false;
    }
  }, [auxiliaryFailed, t]);

  const items = data?.items ?? [];
  const nextCursor = data?.nextCursor ?? null;

  const toggleResult = useCallback(
    (result: AuditResult | null) => {
      if (result === null) {
        applyFilters({ results: [] });
        return;
      }
      setFilters((prev) => {
        const has = prev.results.includes(result);
        const next = {
          ...prev,
          results: has ? prev.results.filter((item) => item !== result) : [result],
        };
        if (listFiltersEqual(prev, next)) return prev;
        resetCursor();
        return next;
      });
    },
    [applyFilters, resetCursor],
  );

  const toggleActionFacet = useCallback(
    (action: string) => {
      setFilters((prev) => {
        const has = prev.actions.includes(action);
        const next = {
          ...prev,
          actions: has ? prev.actions.filter((item) => item !== action) : [...prev.actions, action],
        };
        if (listFiltersEqual(prev, next)) return prev;
        resetCursor();
        return next;
      });
    },
    [resetCursor],
  );

  const handleTableChange = useCallback(
    ({ filters: next }: AdminTableChangeMeta) => {
      applyFilters({
        actions: toStringList(next.action),
        actorUserId: firstNonEmpty(next.actorUserId),
        requestId: firstNonEmpty(next.requestId),
        results: toResultList(next.result),
      });
    },
    [applyFilters],
  );

  const rangeValue: [Dayjs, Dayjs] = useMemo(
    () => [dayjs(filters.from), dayjs(filters.to)],
    [filters.from, filters.to],
  );

  const actionOptions = useMemo(() => {
    const fromFacets = (facets?.actions ?? []).map((item) => ({
      label: `${auditActionLabel(t, item.value)} (${item.count})`,
      value: item.value,
    }));
    for (const action of filters.actions) {
      if (!fromFacets.some((option) => option.value === action)) {
        fromFacets.push({ label: auditActionLabel(t, action), value: action });
      }
    }
    return fromFacets;
  }, [facets?.actions, filters.actions, t]);

  const resultOptions = useMemo(() => {
    const counts = new Map((facets?.results ?? []).map((item) => [item.value, item.count]));
    return RESULT_VALUES.map((value) => ({
      label: counts.has(value)
        ? `${t(`audit.status.result.${value}`)} (${counts.get(value)})`
        : t(`audit.status.result.${value}`),
      value,
    }));
  }, [facets?.results, t]);

  const columns = useOperationLogColumns({
    actionOptions,
    applyFilters,
    canRead,
    filters,
    resultOptions,
  });

  const activeResult = filters.results.length === 1 ? filters.results[0] : null;
  const hasActiveFilters =
    filters.actions.length > 0 ||
    filters.results.length > 0 ||
    Boolean(filters.actorUserId) ||
    Boolean(filters.requestId) ||
    Boolean(filters.targetId) ||
    Boolean(filters.targetType);

  const clearAllFilters = useCallback(() => {
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
          {auxiliaryFailed ? (
            <Alert
              showIcon
              message={t('audit.logs.summaryUnavailable')}
              type="warning"
              action={
                <Button
                  size="small"
                  onClick={() =>
                    void Promise.allSettled([statsResult.mutate(), facetsResult.mutate()])
                  }
                >
                  {t('audit.shared.retryMissingSections')}
                </Button>
              }
            />
          ) : null}
          <div className={styles.stats}>
            {statCards.map((card) => (
              <button
                className={styles.statCard}
                data-active={card.active}
                data-testid={`stat-${card.key}`}
                key={card.key}
                type="button"
                onClick={card.onClick}
              >
                <Text
                  data-testid={`stat-${card.key}-label`}
                  style={{ margin: 0, fontWeight: card.active ? 600 : undefined }}
                  type={card.active ? undefined : 'secondary'}
                >
                  {card.label}
                </Text>
                <p
                  className={styles.statValue}
                  data-testid={`stat-${card.key}-value`}
                  style={card.color ? { color: card.color } : undefined}
                >
                  {card.value}
                </p>
              </button>
            ))}
          </div>
          {facets?.actions?.length ? (
            <ActionFacetChips
              actions={facets.actions}
              selected={filters.actions}
              onToggle={toggleActionFacet}
            />
          ) : null}
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
        scroll={{ x: 1280 }}
        cursorPagination={{
          hasNext: Boolean(nextCursor),
          hasPrevious,
          onNext: () => onNext(nextCursor),
          onPrevious,
          pageSize: limit,
          pageSizeOptions: ['20', '50', '100'],
          onPageSizeChange,
        }}
        toolbar={
          <div className={styles.tableToolbar}>
            <DatePicker.RangePicker
              showTime
              allowClear={false}
              className={styles.timeRange}
              value={rangeValue}
              onChange={(vals) => {
                if (!vals?.[0] || !vals[1]) return;
                applyFilters({
                  from: vals[0].toDate(),
                  to: vals[1].toDate(),
                });
              }}
            />
            {hasActiveFilters ? (
              <Button size="small" type="text" onClick={clearAllFilters}>
                {t('audit.shared.clearFilters')}
              </Button>
            ) : null}
          </div>
        }
        onChange={handleTableChange}
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
