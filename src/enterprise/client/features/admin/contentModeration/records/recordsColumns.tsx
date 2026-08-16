'use client';

import { Avatar, Text } from '@lobehub/ui';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import type { TFunction } from 'i18next';
import { memo } from 'react';
import { useNavigate } from 'react-router';

import {
  MODERATION_CATEGORIES,
  MODERATION_DECISION_SOURCES,
  MODERATION_EFFECTIVE_ACTIONS,
  MODERATION_REQUEST_KINDS,
} from '@/const/platform/contentModeration';
import type { ContentModerationRecord } from '@/types/platform/contentModeration';

import {
  dateRangeColumnFilter,
  enumColumnFilter,
  searchColumnFilter,
} from '../../primitives/columnFilters';
import { formatAdminDateTime } from '../../users/utils';
import {
  categoryLabel,
  decisionSourceLabel,
  displayModerationUser,
  effectiveActionLabel,
  formatLatency,
  formatModelPair,
  formatScore,
  requestKindLabel,
} from '../format';
import ActionTag from './ActionTag';
import type { RecordsFilters } from './recordsFilters';
import { toRangeEndExclusive, toRangeStart } from './recordsFilters';

/**
 * §6.2 user cell: avatar (initials when the list payload carries no image) + identity, linking
 * to 用户管理. The link stops propagation so it does not also open the detail drawer — the row
 * click still owns the drawer.
 */
const UserCell = memo<{ row: ContentModerationRecord }>(({ row }) => {
  const navigate = useNavigate();
  const label = displayModerationUser(row.userSnapshot, row.userId);
  const secondary = row.userSnapshot?.email?.trim() || row.userSnapshot?.username?.trim() || null;
  const initial = label.trim().slice(0, 1).toUpperCase() || '?';

  const identity = (
    <span style={{ alignItems: 'center', display: 'inline-flex', gap: 6, minWidth: 0 }}>
      <Avatar alt={label} avatar={initial} size={20} />
      <Text ellipsis style={{ margin: 0 }}>
        {secondary && secondary !== label ? `${label} · ${secondary}` : label}
      </Text>
    </span>
  );

  if (!row.userId) return identity;

  return (
    <a
      href={`/admin/users/${row.userId}`}
      style={{ color: 'inherit', minWidth: 0 }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        navigate(`/admin/users/${row.userId}`);
      }}
    >
      {identity}
    </a>
  );
});
UserCell.displayName = 'ModerationRecordUserCell';

export interface BuildRecordsColumnsParams {
  applyFilters: (patch: Partial<RecordsFilters>) => void;
  filters: RecordsFilters;
  t: TFunction<'admin'>;
}

export const buildRecordsColumns = ({
  t,
  filters,
  applyFilters,
}: BuildRecordsColumnsParams): TableColumnsType<ContentModerationRecord> => [
  {
    dataIndex: 'createdAt',
    key: 'createdAt',
    title: t('contentModeration.records.columns.time'),
    width: 170,
    ...dateRangeColumnFilter({
      // The picker shows the inclusive last day; `filters.to` holds the exclusive bound.
      value:
        filters.from || filters.to
          ? [
              filters.from ?? null,
              filters.to ? dayjs(filters.to).subtract(1, 'day').toDate() : null,
            ]
          : null,
      onChange: (range) =>
        applyFilters({
          from: toRangeStart(range?.[0]),
          to: toRangeEndExclusive(range?.[1]),
        }),
    }),
    render: (value: Date) => formatAdminDateTime(value),
  },
  {
    dataIndex: 'userId',
    key: 'userId',
    title: t('contentModeration.records.columns.user'),
    width: 180,
    ellipsis: true,
    ...searchColumnFilter({
      placeholder: t('contentModeration.records.filters.user'),
      value: filters.userQuery,
      onSearch: (value) => applyFilters({ userQuery: value || undefined }),
    }),
    render: (_: unknown, row) => <UserCell row={row} />,
  },
  {
    dataIndex: 'effectiveAction',
    key: 'effectiveAction',
    title: t('contentModeration.records.columns.action'),
    width: 160,
    ...enumColumnFilter({
      multiple: true,
      options: MODERATION_EFFECTIVE_ACTIONS.map((value) => ({
        label: effectiveActionLabel(t, value),
        value,
      })),
      value: filters.actions,
    }),
    render: (_: unknown, row) => (
      <ActionTag effectiveAction={row.effectiveAction} policyAction={row.policyAction} />
    ),
  },
  {
    dataIndex: 'topCategory',
    key: 'topCategory',
    title: t('contentModeration.records.columns.topCategory'),
    width: 130,
    ...enumColumnFilter({
      multiple: true,
      options: MODERATION_CATEGORIES.map((value) => ({
        label: categoryLabel(t, value),
        value,
      })),
      value: filters.categories,
    }),
    render: (value: string | null) => (value ? categoryLabel(t, value) : '—'),
  },
  {
    dataIndex: 'topScore',
    key: 'topScore',
    title: t('contentModeration.records.columns.topScore'),
    width: 80,
    render: (value: number | null) => formatScore(value),
  },
  {
    dataIndex: 'source',
    key: 'source',
    title: t('contentModeration.records.columns.source'),
    width: 130,
    ...enumColumnFilter({
      multiple: true,
      options: MODERATION_DECISION_SOURCES.map((value) => ({
        label: decisionSourceLabel(t, value),
        value,
      })),
      value: filters.sources,
    }),
    render: (value: string) => decisionSourceLabel(t, value),
  },
  {
    dataIndex: 'requestKind',
    key: 'requestKind',
    title: t('contentModeration.records.columns.requestKind'),
    width: 110,
    ...enumColumnFilter({
      multiple: true,
      options: MODERATION_REQUEST_KINDS.map((value) => ({
        label: requestKindLabel(t, value),
        value,
      })),
      value: filters.requestKinds,
    }),
    render: (value: string) => requestKindLabel(t, value),
  },
  {
    key: 'model',
    title: t('contentModeration.records.columns.model'),
    width: 220,
    ellipsis: true,
    render: (_: unknown, row) =>
      row.effectiveModel
        ? `${formatModelPair(row.provider, row.model)} → ${formatModelPair(row.effectiveProvider, row.effectiveModel)}`
        : formatModelPair(row.provider, row.model),
  },
  {
    dataIndex: 'classifierLatencyMs',
    key: 'classifierLatencyMs',
    title: t('contentModeration.records.columns.latency'),
    width: 90,
    render: (value: number | null) => formatLatency(value),
  },
  {
    dataIndex: 'promptExcerpt',
    key: 'promptExcerpt',
    title: t('contentModeration.records.columns.excerpt'),
    ellipsis: true,
    render: (value: string) => (
      <Text ellipsis style={{ margin: 0 }} type="secondary">
        {value || '—'}
      </Text>
    ),
  },
];
