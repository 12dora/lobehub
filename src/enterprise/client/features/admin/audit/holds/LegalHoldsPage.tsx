'use client';

import { Button } from '@lobehub/ui/base-ui';
import type { FilterValue } from 'antd/es/table/interface';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAuditLegalHoldItem } from '@/enterprise/client/services/adminAudit';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import DataTable, { type AdminTableChangeMeta } from '../../primitives/DataTable';
import { useAdminAuditMutations, useFetchAuditHoldsList } from '../hooks/useAdminAudit';
import { hasPermission } from '../shared/format';
import { openAuditReasonModal } from '../shared/openAuditReasonModal';
import { useCursorPagination } from '../shared/useCursorPagination';
import CreateHoldModal from './CreateHoldModal';
import { useLegalHoldColumns } from './useLegalHoldColumns';

const SCOPE_TYPES = ['user', 'session', 'topic', 'workspace', 'global'] as const;

const firstFilterValue = (value: FilterValue | null | undefined): string | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw === '') return undefined;
  return String(raw);
};

const LegalHoldsPage = memo(() => {
  const { t } = useTranslation('admin');
  const { permissions, authMethod } = useAdminAccess();
  const canManage = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE);
  // users.search requires AUDIT_READ; legal-hold-only actors fall back to free-form user ID.
  const canAuditRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);
  const { createLegalHold, releaseLegalHold } = useAdminAuditMutations();

  /** List filter uses stored status only (not projected `expired`). */
  const [status, setStatus] = useState<'active' | 'released' | undefined>();
  const [scopeType, setScopeType] = useState<AdminAuditLegalHoldItem['scopeType'] | undefined>();
  const {
    currentCursor,
    hasPrevious,
    limit,
    onJumpTo,
    onNext,
    onPageSizeChange,
    onPrevious,
    page,
    reset: resetCursor,
  } = useCursorPagination();
  const [createOpen, setCreateOpen] = useState(false);

  const list = useFetchAuditHoldsList(
    {
      cursor: currentCursor,
      limit,
      scopeType,
      status,
    },
    canManage,
  );

  const handleTableChange = useCallback(
    ({ filters }: AdminTableChangeMeta) => {
      const hasStatus = Object.hasOwn(filters, 'status');
      const hasScope = Object.hasOwn(filters, 'scope');
      if (!hasStatus && !hasScope) return;

      const nextStatusRaw = firstFilterValue(filters.status);
      const nextStatus = !hasStatus
        ? status
        : nextStatusRaw === 'active' || nextStatusRaw === 'released'
          ? nextStatusRaw
          : undefined;
      const nextScopeRaw = firstFilterValue(filters.scope);
      const nextScope = !hasScope
        ? scopeType
        : SCOPE_TYPES.includes(nextScopeRaw as (typeof SCOPE_TYPES)[number])
          ? (nextScopeRaw as AdminAuditLegalHoldItem['scopeType'])
          : undefined;

      const statusChanged = nextStatus !== status;
      const scopeChanged = nextScope !== scopeType;
      if (!statusChanged && !scopeChanged) return;
      if (statusChanged) setStatus(nextStatus);
      if (scopeChanged) setScopeType(nextScope);
      resetCursor();
    },
    [resetCursor, scopeType, status],
  );

  const onRelease = useCallback(
    (row: AdminAuditLegalHoldItem) => {
      openAuditReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (releaseReason) => ({ id: row.id, releaseReason }),
        danger: true,
        description: t('audit.holds.release.desc'),
        impact: t('audit.holds.release.impact'),
        onSubmit: async (payload) => {
          await releaseLegalHold(payload as { id: string; releaseReason: string });
          void list.mutate();
        },
        submitLabel: t('audit.holds.release.submit'),
        targetLabel: `${row.scopeType}${row.scopeId ? `:${row.scopeId}` : ''}`,
        title: t('audit.holds.release.title'),
      });
    },
    [authMethod, list, releaseLegalHold, t],
  );

  const columns = useLegalHoldColumns({ onRelease, scopeType, status });

  return (
    <AdminPageTemplate
      description={t('audit.holds.page.desc')}
      title={t('audit.holds.page.title')}
      actions={
        canManage ? (
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            {t('audit.holds.actions.create')}
          </Button>
        ) : undefined
      }
    >
      <DataTable<AdminAuditLegalHoldItem>
        columns={columns}
        dataSource={list.data?.items ?? []}
        emptyDescription={t('audit.holds.empty')}
        error={Boolean(list.error) && !list.data}
        loading={list.isLoading && !list.data}
        pagination={false}
        rowKey="id"
        scroll={{ x: 1100 }}
        cursorPagination={{
          hasNext: Boolean(list.data?.nextCursor),
          hasPrevious,
          onJumpTo,
          onNext: () => onNext(list.data?.nextCursor),
          onPrevious,
          page,
          pageSize: limit,
          onPageSizeChange,
        }}
        onChange={handleTableChange}
        onRetry={() => void list.mutate()}
      />

      <CreateHoldModal
        authMethod={authMethod}
        canAuditRead={canAuditRead}
        createLegalHold={createLegalHold}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void list.mutate()}
      />
    </AdminPageTemplate>
  );
});

LegalHoldsPage.displayName = 'AuditLegalHoldsPage';

export default LegalHoldsPage;
