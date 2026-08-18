'use client';

import { Avatar, Flexbox, Tag, Text } from '@lobehub/ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import type { TFunction } from 'i18next';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

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
  /**
   * The only click target for opening a user. Fills the cell so the whole
   * identity / email area is hittable, without making the row look clickable.
   */
  openTarget: css`
    cursor: pointer;
    display: block;
    min-width: 0;
    border-radius: 4px;

    &:hover {
      color: ${cssVar.colorLinkHover};
      text-decoration: underline;
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 2px;
    }
  `,
}));

interface OpenUserCellProps {
  children: ReactNode;
  label: string;
  onOpen: () => void;
}

/**
 * Keyboard-reachable open control. `stopPropagation` keeps the row checkbox and
 * the row actions untouched — nothing else in the row reacts to a click.
 *
 * `label` names the user it opens: an aria-label overrides the visible text, so a
 * shared one would read every identity and email cell out as the same control.
 */
const OpenUserCell = ({ children, label, onOpen }: OpenUserCellProps) => (
  <div
    aria-label={label}
    className={styles.openTarget}
    role="button"
    tabIndex={0}
    onClick={(event: MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      onOpen();
    }}
    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      onOpen();
    }}
  >
    {children}
  </div>
);

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
  /** Opens the slide-in detail panel. Wired to the identity and email cells only. */
  onOpenUser: (userId: string) => void;
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
  onOpenUser,
  role,
  source,
  status,
  t,
}: BuildUsersListColumnsParams): TableColumnsType<AdminUserListItem> => [
  {
    key: 'identity',
    title: t('users.list.columns.identity'),
    width: 200,
    render: (_, row) => (
      <OpenUserCell
        label={t('users.list.openDetail', { name: displayUserName(row) })}
        onOpen={() => onOpenUser(row.id)}
      >
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
      </OpenUserCell>
    ),
  },
  {
    dataIndex: 'email',
    ellipsis: true,
    key: 'email',
    title: t('users.list.columns.email'),
    width: 230,
    render: (value: string | null, row) => (
      <OpenUserCell
        label={t('users.list.openDetail', { name: displayUserName(row) })}
        onOpen={() => onOpenUser(row.id)}
      >
        {value ?? '—'}
      </OpenUserCell>
    ),
  },
  {
    dataIndex: 'dingtalkTitle',
    ellipsis: true,
    key: 'dingtalkTitle',
    title: t('users.list.columns.jobTitle'),
    width: 110,
    render: (value: string | null) => (value?.trim() ? value : '—'),
  },
  {
    dataIndex: 'status',
    key: 'status',
    title: t('users.list.columns.status'),
    width: 90,
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
    width: 130,
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
    width: 100,
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
    ellipsis: true,
    key: 'createdAt',
    title: t('users.list.columns.createdAt'),
    width: 150,
    ...dateRangeColumnFilter({
      value: createdRange,
      onChange: handleCreatedRange,
    }),
    render: (value: Date) => formatAdminDateTime(value),
  },
  {
    dataIndex: 'lastActiveAt',
    ellipsis: true,
    key: 'lastActiveAt',
    title: t('users.list.columns.lastActiveAt'),
    width: 150,
    render: (value: Date | null) => formatAdminDateTime(value),
  },
  {
    fixed: 'right',
    key: 'actions',
    title: t('users.list.columns.actions'),
    width: 170,
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
