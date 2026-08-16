'use client';

import { Input, Text } from '@lobehub/ui';
import { Button, Modal, Select } from '@lobehub/ui/base-ui';
import { DatePicker, type TableColumnsType } from 'antd';
import type { FilterValue } from 'antd/es/table/interface';
import { createStaticStyles, cssVar } from 'antd-style';
import type dayjs from 'dayjs';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type {
  AdminAuditLegalHoldItem,
  AdminAuditLegalHoldsCreateInput,
} from '@/enterprise/client/services/adminAudit';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import { enumColumnFilter } from '../../primitives/columnFilters';
import DataTable, { type AdminTableChangeMeta } from '../../primitives/DataTable';
import { useAdminAuditMutations, useFetchAuditHoldsList } from '../hooks/useAdminAudit';
import AuditStatusTag from '../shared/AuditStatusTag';
import AuditUserSearchSelect from '../shared/AuditUserSearchSelect';
import { formatAdminDateTime, hasPermission, truncateText } from '../shared/format';
import { openAuditReasonModal } from '../shared/openAuditReasonModal';

const DEFAULT_LIST_LIMIT = 50;

const styles = createStaticStyles(({ css }) => ({
  banner: css`
    margin-block-end: 12px;
    padding-block: 10px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorWarningBorder};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorWarningBg};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-block-end: 12px;
  `,
}));

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
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIST_LIMIT);
  const [createOpen, setCreateOpen] = useState(false);
  const currentCursor = cursorStack.at(-1) ?? null;

  // create form state
  const [newScopeType, setNewScopeType] = useState<(typeof SCOPE_TYPES)[number]>('user');
  const [newScopeId, setNewScopeId] = useState('');
  const [newExpires, setNewExpires] = useState<dayjs.Dayjs | null>(null);

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
      setCursorStack([]);
    },
    [scopeType, status],
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

  const columns: TableColumnsType<AdminAuditLegalHoldItem> = useMemo(
    () => [
      {
        key: 'scope',
        title: t('audit.holds.columns.scope'),
        ...enumColumnFilter({
          options: SCOPE_TYPES.map((scope) => ({
            label: t(`audit.holds.scopeType.${scope}` as never, { defaultValue: scope }),
            value: scope,
          })),
          value: scopeType,
        }),
        render: (_, row) => {
          const scopeLabel = t(`audit.holds.scopeType.${row.scopeType}` as never, {
            defaultValue: row.scopeType,
          });
          if (row.scopeType === 'global') return scopeLabel;
          return row.scopeId ? `${scopeLabel} / ${row.scopeId}` : scopeLabel;
        },
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('audit.holds.columns.status'),
        width: 110,
        ...enumColumnFilter({
          options: [
            { label: t('audit.status.hold.active'), value: 'active' },
            { label: t('audit.status.hold.released'), value: 'released' },
          ],
          value: status,
        }),
        render: (v: string) => <AuditStatusTag kind="hold" value={v} />,
      },
      {
        dataIndex: 'reason',
        key: 'reason',
        title: t('audit.holds.columns.reason'),
        render: (v: string) => truncateText(v, 60),
      },
      {
        dataIndex: 'createdBy',
        key: 'createdBy',
        title: t('audit.holds.columns.createdBy'),
        width: 120,
      },
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        title: t('audit.holds.columns.createdAt'),
        width: 160,
        render: (v: Date) => formatAdminDateTime(v),
      },
      {
        dataIndex: 'expiresAt',
        key: 'expiresAt',
        title: t('audit.holds.columns.expiresAt'),
        width: 160,
        render: (v: Date | null) => formatAdminDateTime(v),
      },
      {
        key: 'release',
        title: t('audit.holds.columns.releaseInfo'),
        render: (_, row) =>
          row.status === 'released'
            ? `${row.releasedBy ?? '—'} · ${formatAdminDateTime(row.releasedAt)}`
            : '—',
      },
      {
        key: 'actions',
        title: t('audit.holds.columns.actions'),
        width: 100,
        render: (_, row) =>
          row.status === 'active' ? (
            <Button danger size="small" onClick={() => onRelease(row)}>
              {t('audit.holds.actions.release')}
            </Button>
          ) : null,
      },
    ],
    [onRelease, scopeType, status, t],
  );

  const submitCreate = () => {
    openAuditReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason): AdminAuditLegalHoldsCreateInput => {
        // Discriminated union: keep scopeType as a literal so TS narrows correctly
        // (avoid assigning a wide scopeType union then patching scopeId).
        const expiresAt = newExpires ? newExpires.toDate() : undefined;
        if (newScopeType === 'global') {
          return { expiresAt, reason, scopeId: null, scopeType: 'global' };
        }
        if (newScopeType === 'user') {
          return { expiresAt, reason, scopeId: newScopeId.trim(), scopeType: 'user' };
        }
        if (newScopeType === 'session') {
          return { expiresAt, reason, scopeId: newScopeId.trim(), scopeType: 'session' };
        }
        if (newScopeType === 'topic') {
          return { expiresAt, reason, scopeId: newScopeId.trim(), scopeType: 'topic' };
        }
        return { expiresAt, reason, scopeId: newScopeId.trim(), scopeType: 'workspace' };
      },
      description: t('audit.holds.create.reasonDesc'),
      onSubmit: async (payload) => {
        await createLegalHold(payload as AdminAuditLegalHoldsCreateInput);
        setCreateOpen(false);
        setNewScopeId('');
        setNewExpires(null);
        void list.mutate();
      },
      submitLabel: t('audit.holds.create.submit'),
      targetLabel: newScopeType,
      title: t('audit.holds.create.title'),
      validateExtra: () => {
        if (newScopeType !== 'global' && !newScopeId.trim()) {
          return 'audit.holds.create.scopeIdRequired';
        }
        if (newExpires && newExpires.valueOf() <= Date.now()) {
          return 'audit.holds.create.expiresAtMustBeFuture';
        }
        return null;
      },
    });
  };

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
          hasPrevious: cursorStack.length > 0,
          onNext: () => {
            const next = list.data?.nextCursor;
            if (next) setCursorStack((p) => [...p, next]);
          },
          onPrevious: () => setCursorStack((p) => p.slice(0, -1)),
          pageSize: limit,
          onPageSizeChange: (size) => {
            setLimit(size);
            setCursorStack([]);
          },
        }}
        onChange={handleTableChange}
        onRetry={() => void list.mutate()}
      />

      <Modal
        okText={t('audit.holds.create.continue')}
        open={createOpen}
        title={t('audit.holds.create.title')}
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
      >
        <div className={styles.banner}>{t('audit.holds.create.warning')}</div>
        <div className={styles.field}>
          <Text>{t('audit.holds.create.scopeType')}</Text>
          <Select
            style={{ width: '100%' }}
            value={newScopeType}
            options={SCOPE_TYPES.map((s) => ({
              label: t(`audit.holds.scopeType.${s}` as never, { defaultValue: s }),
              value: s,
            }))}
            onChange={(v) => setNewScopeType(v as (typeof SCOPE_TYPES)[number])}
          />
        </div>
        {newScopeType !== 'global' ? (
          <div className={styles.field}>
            <Text>{t('audit.holds.create.scopeId')}</Text>
            {newScopeType === 'user' ? (
              <AuditUserSearchSelect
                enabled={canAuditRead}
                value={newScopeId || undefined}
                onChange={(id) => setNewScopeId(id ?? '')}
              />
            ) : (
              <Input value={newScopeId} onChange={(e) => setNewScopeId(e.target.value)} />
            )}
          </div>
        ) : null}
        <div className={styles.field}>
          <Text>{t('audit.holds.create.expiresAt')}</Text>
          <DatePicker
            showTime
            style={{ width: '100%' }}
            value={newExpires}
            disabledDate={(current) => {
              // Disallow past calendar days; submit still requires a future instant.
              if (!current) return false;
              return current.endOf('day').valueOf() < Date.now();
            }}
            onChange={(v) => setNewExpires(v)}
          />
        </div>
      </Modal>
    </AdminPageTemplate>
  );
});

LegalHoldsPage.displayName = 'AuditLegalHoldsPage';

export default LegalHoldsPage;
