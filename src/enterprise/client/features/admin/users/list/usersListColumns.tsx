'use client';

import { Avatar, Flexbox, Tag, Text } from '@lobehub/ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import type { TFunction } from 'i18next';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { dateRangeColumnFilter, enumColumnFilter } from '../../primitives/columnFilters';
import StatusBadge from '../../primitives/StatusBadge';
import type { useAdminUserMutations } from '../hooks/useAdminUsers';
import UsersListRowActions from '../UsersListRowActions';
import UserSourceTags from '../UserSourceTags';
import { displayUserName, formatAdminDateTime } from '../utils';
import type { AdminUserListItem } from './useUsersListSelection';

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;
  `,
  identityText: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
}));

const ROLE_OPTIONS = Object.values(PLATFORM_SYSTEM_ROLES);

export interface BuildUsersListColumnsParams {
  actorRoles: readonly { name: string }[];
  authMethod?: AdminReauthAuthMethod | null;
  canBan: boolean;
  canDelete: boolean;
  canManageRoles: boolean;
  createdRange: [Date | null, Date | null] | null;
  currentUserId?: string;
  handleCreatedRange: (value: [Date | null, Date | null] | null) => void;
  mutations: Pick<
    ReturnType<typeof useAdminUserMutations>,
    'banUser' | 'deleteUser' | 'replaceGlobalRoles' | 'unbanUser'
  >;
  role?: string;
  source?: string;
  status?: string;
  t: TFunction<'admin'>;
}

export const buildUsersListColumns = ({
  actorRoles,
  authMethod,
  canBan,
  canDelete,
  canManageRoles,
  createdRange,
  currentUserId,
  handleCreatedRange,
  mutations,
  role,
  source,
  status,
  t,
}: BuildUsersListColumnsParams): TableColumnsType<AdminUserListItem> => [
  {
    key: 'identity',
    title: t('users.list.columns.identity'),
    render: (_, row) => (
      <div className={styles.identity}>
        <Avatar avatar={row.avatar ?? undefined} size={32} />
        <div className={styles.identityText}>
          <Text ellipsis style={{ fontWeight: 600, margin: 0 }}>
            {displayUserName(row)}
          </Text>
          {row.username ? (
            <Text ellipsis style={{ margin: 0 }} type="secondary">
              @{row.username}
            </Text>
          ) : null}
        </div>
      </div>
    ),
  },
  {
    dataIndex: 'email',
    key: 'email',
    title: t('users.list.columns.email'),
    render: (value: string | null) => value ?? '—',
  },
  {
    dataIndex: 'dingtalkTitle',
    key: 'dingtalkTitle',
    title: t('users.list.columns.jobTitle'),
    render: (value: string | null) => (value?.trim() ? value : '—'),
  },
  {
    dataIndex: 'status',
    key: 'status',
    title: t('users.list.columns.status'),
    ...enumColumnFilter({
      options: [
        { label: t('users.status.active'), value: 'active' },
        { label: t('users.status.banned'), value: 'banned' },
      ],
      value: status,
    }),
    render: (value: string) => <StatusBadge status={value} />,
  },
  {
    dataIndex: 'roles',
    key: 'roles',
    title: t('users.list.columns.roles'),
    ...enumColumnFilter({
      options: ROLE_OPTIONS.map((item) => ({
        label: t(`users.roles.${item}` as never, { defaultValue: item }),
        value: item,
      })),
      value: role,
    }),
    render: (roles: string[]) =>
      roles.length ? (
        <Flexbox horizontal gap={4} style={{ flexWrap: 'wrap' }}>
          {roles.map((item) => (
            <Tag key={item} size="small">
              {t(`users.roles.${item}` as never, { defaultValue: item })}
            </Tag>
          ))}
        </Flexbox>
      ) : (
        '—'
      ),
  },
  {
    dataIndex: 'providerIds',
    key: 'source',
    title: t('users.list.columns.source'),
    width: 160,
    ...enumColumnFilter({
      options: [
        { label: t('users.source.local'), value: 'local' },
        { label: t('users.source.sso'), value: 'sso' },
      ],
      value: source,
    }),
    render: (ids: string[]) => <UserSourceTags providerIds={ids ?? []} />,
  },
  {
    dataIndex: 'createdAt',
    key: 'createdAt',
    title: t('users.list.columns.createdAt'),
    ...dateRangeColumnFilter({
      value: createdRange,
      onChange: handleCreatedRange,
    }),
    render: (value: Date) => formatAdminDateTime(value),
  },
  {
    dataIndex: 'lastActiveAt',
    key: 'lastActiveAt',
    title: t('users.list.columns.lastActiveAt'),
    render: (value: Date | null) => formatAdminDateTime(value),
  },
  {
    key: 'actions',
    title: t('users.list.columns.actions'),
    width: 220,
    render: (_, row) => (
      <UsersListRowActions
        actorRoles={actorRoles}
        authMethod={authMethod ?? undefined}
        canBan={canBan}
        canDelete={canDelete}
        canManageRoles={canManageRoles}
        isSelf={row.id === currentUserId}
        row={row}
        onBan={mutations.banUser}
        onDelete={mutations.deleteUser}
        onReplaceRoles={mutations.replaceGlobalRoles}
        onUnban={mutations.unbanUser}
      />
    ),
  },
];
