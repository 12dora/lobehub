import type { TableColumnsType } from 'antd';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditConversationListItem } from '@/enterprise/client/services/adminAudit';
import { getModelDisplayName, useProviderLabel } from '@/utils/modelLabels';

import { dateRangeColumnFilter, searchColumnFilter } from '../../primitives/columnFilters';
import { formatAdminDateTime } from '../shared/format';

export const useConversationColumns = ({
  applyDateRange,
  applyTitleQuery,
  from,
  q,
  to,
}: {
  applyDateRange: (range: [Date | null, Date | null] | null) => void;
  applyTitleQuery: (next: string) => void;
  from: Date;
  q: string;
  to: Date;
}): TableColumnsType<AdminAuditConversationListItem> => {
  const { t } = useTranslation('admin');
  const providerLabel = useProviderLabel();

  return useMemo(
    () => [
      {
        dataIndex: 'title',
        key: 'title',
        title: t('audit.conversations.columns.title'),
        ...searchColumnFilter({
          placeholder: t('audit.conversations.user.searchTitle'),
          value: q,
          onSearch: applyTitleQuery,
        }),
        render: (v: string | null) => v || t('audit.conversations.untitled'),
      },
      {
        key: 'model',
        title: t('audit.conversations.columns.model'),
        render: (_, row) =>
          [providerLabel(row.provider), getModelDisplayName(row.model, row.provider)]
            .filter(Boolean)
            .join(' / ') || '—',
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('audit.conversations.columns.status'),
        width: 100,
        render: (v: string | null) =>
          v ? t(`audit.conversations.status.${v}` as never, { defaultValue: v }) : '—',
      },
      {
        dataIndex: 'updatedAt',
        key: 'updatedAt',
        title: t('audit.conversations.columns.updatedAt'),
        width: 170,
        ...dateRangeColumnFilter({
          value: [from, to],
          onChange: applyDateRange,
        }),
        render: (v: Date) => formatAdminDateTime(v),
      },
    ],
    [applyDateRange, applyTitleQuery, from, providerLabel, q, t, to],
  );
};
