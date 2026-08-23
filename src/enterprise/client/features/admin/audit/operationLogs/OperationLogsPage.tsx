'use client';

import { Alert, Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useState } from 'react';
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
import { hasPermission } from '../shared/format';
import { useSummaryFailureToast } from '../shared/useSummaryFailureToast';
import ActionFacetChips from './ActionFacetChips';
import EventDetailDrawer from './EventDetailDrawer';
import LogsTableToolbar from './LogsTableToolbar';
import LogStatCards from './LogStatCards';
import { useFacetOptions } from './useFacetOptions';
import { useOperationLogColumns } from './useOperationLogColumns';
import { useOperationLogFilters } from './useOperationLogFilters';

const OperationLogsPage = memo(() => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const canRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

  const {
    activeResult,
    applyFilters,
    clearAllFilters,
    cursor,
    filters,
    handleTableChange,
    hasActiveFilters,
    listInput,
    toggleActionFacet,
    toggleResult,
  } = useOperationLogFilters();
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data, error, isLoading, mutate } = useFetchAuditEventsList(listInput, canRead);
  const statsResult = useFetchAuditEventStats({ from: filters.from, to: filters.to }, canRead);
  const facetsResult = useFetchAuditEventFacets({ from: filters.from, to: filters.to }, canRead);
  const stats = statsResult.data;
  const facets = facetsResult.data;
  const auxiliaryFailed = Boolean(statsResult.error || facetsResult.error);

  useSummaryFailureToast(auxiliaryFailed, t);

  const items = data?.items ?? [];
  const nextCursor = data?.nextCursor ?? null;

  const { actionOptions, resultOptions } = useFacetOptions({
    facets,
    selectedActions: filters.actions,
    t,
  });

  const columns = useOperationLogColumns({
    actionOptions,
    applyFilters,
    canRead,
    filters,
    resultOptions,
  });

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
          <LogStatCards
            activeResult={activeResult}
            allActive={filters.results.length === 0}
            stats={stats}
            onToggleResult={toggleResult}
          />
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
          hasPrevious: cursor.hasPrevious,
          onNext: () => cursor.onNext(nextCursor),
          onPrevious: cursor.onPrevious,
          pageSize: cursor.limit,
          onPageSizeChange: cursor.onPageSizeChange,
        }}
        toolbar={
          <LogsTableToolbar
            from={filters.from}
            hasActiveFilters={hasActiveFilters}
            to={filters.to}
            onClearFilters={clearAllFilters}
            onRangeChange={(from, to) => applyFilters({ from, to })}
          />
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
