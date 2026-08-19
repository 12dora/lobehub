import { Button } from '@lobehub/ui/base-ui';
import { type TableColumnsType } from 'antd';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditLegalHoldItem } from '@/enterprise/client/services/adminAudit';

import { enumColumnFilter } from '../../primitives/columnFilters';
import AuditStatusTag from '../shared/AuditStatusTag';
import { formatAdminDateTime, truncateText } from '../shared/format';

const SCOPE_TYPES = ['user', 'session', 'topic', 'workspace', 'global'] as const;

export const useLegalHoldColumns = ({
  onRelease,
  scopeType,
  status,
}: {
  onRelease: (row: AdminAuditLegalHoldItem) => void;
  scopeType: AdminAuditLegalHoldItem['scopeType'] | undefined;
  status: 'active' | 'released' | undefined;
}): TableColumnsType<AdminAuditLegalHoldItem> => {
  const { t } = useTranslation('admin');

  return useMemo(
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
};
