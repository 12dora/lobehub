'use client';

import { Avatar, Flexbox, Text } from '@lobehub/ui';
import { Button, Tabs } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import StatusBadge from '../primitives/StatusBadge';
import { useAdminUserMutations, useFetchAdminUserDetail } from './hooks/useAdminUsers';
import {
  openBanUserModal,
  openReplaceRolesModal,
  openRevokeSessionsModal,
  openUnbanUserModal,
} from './modals/actions';
import AccessTab from './tabs/AccessTab';
import AuditTab from './tabs/AuditTab';
import OverviewTab from './tabs/OverviewTab';
import SessionsTab from './tabs/SessionsTab';
import { displayUserName, hasPermission } from './utils';

const styles = createStaticStyles(({ css }) => ({
  headerMeta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  `,
  notFound: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;

    padding-block: 32px;
  `,
  panel: css`
    padding-block-start: 8px;
  `,
}));

type DetailTab = 'overview' | 'access' | 'sessions' | 'audit';

const UserDetailPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { id: userId } = useParams<{ id: string }>();
  const { permissions } = useAdminAccess();
  const [tab, setTab] = useState<DetailTab>('overview');

  const canBan = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_BAN);
  const canRevoke = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_SESSION_REVOKE);
  const canManageRoles = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_ROLE_MANAGE);
  const canReadAudit = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

  const { data, error, isLoading, mutate } = useFetchAdminUserDetail(userId);
  const { banUser, unbanUser, revokeSessions, replaceGlobalRoles } = useAdminUserMutations();

  // Prefer structured not-found over generic empty when server returns PLATFORM_NOT_FOUND
  const isNotFoundError =
    Boolean(error) &&
    /PLATFORM_NOT_FOUND|NOT_FOUND/i.test(
      String((error as { message?: string })?.message ?? '') +
        JSON.stringify((error as { data?: unknown })?.data ?? {}),
    );

  const titleName = data ? displayUserName(data) : t('users.detail.title');

  const actions = useMemo(() => {
    if (!data || !userId) return null;
    const targetLabel = displayUserName(data);
    return (
      <Flexbox horizontal gap={8} style={{ flexWrap: 'wrap' }}>
        {canBan && data.status !== 'banned' ? (
          <Button
            danger
            size="small"
            onClick={() =>
              openBanUserModal({
                targetLabel,
                userId,
                onConfirm: async (input) => {
                  await banUser({ ...input, userId });
                  await mutate();
                },
              })
            }
          >
            {t('users.actions.ban')}
          </Button>
        ) : null}
        {canBan && data.status === 'banned' ? (
          <Button
            size="small"
            onClick={() =>
              openUnbanUserModal({
                targetLabel,
                userId,
                onConfirm: async (input) => {
                  await unbanUser({ ...input, userId });
                  await mutate();
                },
              })
            }
          >
            {t('users.actions.unban')}
          </Button>
        ) : null}
        {canRevoke ? (
          <Button
            danger
            size="small"
            onClick={() =>
              openRevokeSessionsModal({
                selfTarget: false,
                targetLabel,
                userId,
                onConfirm: async (input) => {
                  await revokeSessions({ ...input, userId });
                  await mutate();
                },
              })
            }
          >
            {t('users.actions.revokeSessions')}
          </Button>
        ) : null}
        {canManageRoles ? (
          <Button
            size="small"
            type="primary"
            onClick={() =>
              openReplaceRolesModal({
                currentRoles: data.roles.map((r) => r.name),
                targetLabel,
                userId,
                onConfirm: async (input) => {
                  await replaceGlobalRoles({ ...input, userId });
                  await mutate();
                },
              })
            }
          >
            {t('users.actions.replaceRoles')}
          </Button>
        ) : null}
      </Flexbox>
    );
  }, [
    banUser,
    canBan,
    canManageRoles,
    canRevoke,
    data,
    mutate,
    replaceGlobalRoles,
    revokeSessions,
    t,
    unbanUser,
    userId,
  ]);

  if (isLoading && !data) {
    return (
      <AdminPageTemplate title={t('users.detail.loading')}>
        <Text type="secondary">{t('primitives.dataTable.loading')}</Text>
      </AdminPageTemplate>
    );
  }

  if (isNotFoundError || (!data && !isLoading)) {
    return (
      <AdminPageTemplate title={t('users.detail.notFoundTitle')}>
        <div className={styles.notFound}>
          <Text>{t('users.detail.notFoundDesc')}</Text>
          <Button type="default" onClick={() => navigate('/admin/users')}>
            {t('users.detail.backToList')}
          </Button>
        </div>
      </AdminPageTemplate>
    );
  }

  if (error && !data) {
    return (
      <AdminPageTemplate title={t('users.detail.title')}>
        <div className={styles.notFound} role="alert">
          <Text>{t('primitives.dataTable.error')}</Text>
          <Button type="primary" onClick={() => void mutate()}>
            {t('primitives.dataTable.retry')}
          </Button>
        </div>
      </AdminPageTemplate>
    );
  }

  if (!data || !userId) return null;

  return (
    <AdminPageTemplate
      actions={actions}
      title={titleName}
      description={
        <div className={styles.headerMeta}>
          <Avatar avatar={data.avatar ?? undefined} size={40} />
          <Text type="secondary">{data.email ?? data.id}</Text>
          <StatusBadge status={data.status} />
        </div>
      }
      toolbar={
        <Tabs
          activeKey={tab}
          items={[
            { key: 'overview', label: t('users.tabs.overview') },
            { key: 'access', label: t('users.tabs.access') },
            { key: 'sessions', label: t('users.tabs.sessions') },
            { key: 'audit', label: t('users.tabs.audit') },
          ]}
          onChange={(key) => setTab(key as DetailTab)}
        />
      }
    >
      <div className={styles.panel} style={{ borderColor: cssVar.colorBorderSecondary }}>
        {tab === 'overview' ? <OverviewTab user={data} /> : null}
        {tab === 'access' ? (
          <AccessTab
            canManageRoles={canManageRoles}
            user={data}
            onReplaceRoles={
              canManageRoles
                ? () =>
                    openReplaceRolesModal({
                      currentRoles: data.roles.map((r) => r.name),
                      targetLabel: displayUserName(data),
                      userId,
                      onConfirm: async (input) => {
                        await replaceGlobalRoles({ ...input, userId });
                        await mutate();
                      },
                    })
                : undefined
            }
          />
        ) : null}
        {tab === 'sessions' ? (
          <SessionsTab
            canRevoke={canRevoke}
            user={data}
            onRevoke={
              canRevoke
                ? () =>
                    openRevokeSessionsModal({
                      selfTarget: false,
                      targetLabel: displayUserName(data),
                      userId,
                      onConfirm: async (input) => {
                        await revokeSessions({ ...input, userId });
                        await mutate();
                      },
                    })
                : undefined
            }
          />
        ) : null}
        {tab === 'audit' ? (
          <AuditTab canReadAudit={canReadAudit} enabled={tab === 'audit'} userId={userId} />
        ) : null}
      </div>
    </AdminPageTemplate>
  );
});

UserDetailPage.displayName = 'AdminUserDetailPage';

export default UserDetailPage;
