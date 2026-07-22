'use client';

import { Avatar, Text } from '@lobehub/ui';
import { Button, Tabs } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { PlatformSystemRoleName } from '@/const/platform/roles';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import StatusBadge from '../primitives/StatusBadge';
import { useAdminUserMutations, useFetchAdminUserDetail } from './hooks/useAdminUsers';
import {
  openBanUserModal,
  openDeleteUserModal,
  openReplaceRolesModal,
  openRevokeRoleModal,
  openRevokeSessionsModal,
  openRevokeSingleSessionModal,
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
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding-block-start: 8px;
  `,
  state: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;

    padding-block: 32px;
  `,
}));

type DetailTab = 'overview' | 'access' | 'sessions' | 'audit';

const isNotFoundError = (error: unknown): boolean => {
  if (!error) return false;
  const mapped = mapEnterpriseError(error);
  if (mapped?.code === 'PLATFORM_NOT_FOUND') return true;
  const message = String((error as { message?: string })?.message ?? '');
  const dataCode = String(
    (error as { data?: { code?: string; errorData?: { code?: string } } })?.data?.errorData?.code ??
      (error as { data?: { code?: string } })?.data?.code ??
      '',
  );
  return /PLATFORM_NOT_FOUND/.test(message) || dataCode === 'PLATFORM_NOT_FOUND';
};

const UserDetailPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { id: userId } = useParams<{ id: string }>();
  const { permissions, roles: actorRoles, authMethod } = useAdminAccess();
  const [tab, setTab] = useState<DetailTab>('overview');

  const canBan = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_BAN);
  const canDelete = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_DELETE);
  const canRevoke = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_SESSION_REVOKE);
  const canManageRoles = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_ROLE_MANAGE);
  const canReadAudit = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

  const { data, error, isLoading, mutate } = useFetchAdminUserDetail(userId);
  const { banUser, unbanUser, deleteUser, revokeSessions, replaceGlobalRoles } =
    useAdminUserMutations();

  const openBan = useCallback(() => {
    if (!data || !userId || data.isSelf) return;
    openBanUserModal({
      authMethod,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await banUser({ ...input, userId });
        await mutate();
      },
    });
  }, [authMethod, banUser, data, mutate, userId]);

  const openUnban = useCallback(() => {
    if (!data || !userId || data.isSelf) return;
    openUnbanUserModal({
      authMethod,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await unbanUser({ ...input, userId });
        await mutate();
      },
    });
  }, [authMethod, data, mutate, unbanUser, userId]);

  const openDelete = useCallback(() => {
    if (!data || !userId || data.isSelf) return;
    openDeleteUserModal({
      authMethod,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await deleteUser({ ...input, userId });
        // The user is gone — return to the list.
        navigate('/admin/users');
      },
    });
  }, [authMethod, data, deleteUser, navigate, userId]);

  const openRevokeAll = useCallback(() => {
    if (!data || !userId) return;
    openRevokeSessionsModal({
      authMethod,
      isSelf: data.isSelf,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await revokeSessions({ ...input, userId });
        await mutate();
      },
    });
  }, [authMethod, data, mutate, revokeSessions, userId]);

  const openRevokeSingle = useCallback(
    (sessionId: string) => {
      if (!data || !userId) return;
      openRevokeSingleSessionModal({
        authMethod,
        sessionId,
        targetLabel: displayUserName(data),
        userId,
        onConfirm: async (input) => {
          await revokeSessions({ ...input, userId });
          await mutate();
        },
      });
    },
    [authMethod, data, mutate, revokeSessions, userId],
  );

  const openUpdatePermissions = useCallback(() => {
    if (!data || !userId) return;
    openReplaceRolesModal({
      actorRoles,
      authMethod,
      currentRoles: data.roles.map((r) => r.name),
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await replaceGlobalRoles({ ...input, userId });
        await mutate();
      },
    });
  }, [actorRoles, authMethod, data, mutate, replaceGlobalRoles, userId]);

  const openRevokeRole = useCallback(
    (roleName: string) => {
      if (!data || !userId) return;
      const remaining = data.roles
        .map((r) => r.name)
        .filter((name) => name !== roleName) as PlatformSystemRoleName[];
      const revoked = data.roles.find((r) => r.name === roleName);
      const revokedRoleLabel =
        revoked?.displayName || t(`users.roles.${roleName}` as never, { defaultValue: roleName });
      openRevokeRoleModal({
        authMethod,
        remainingRoleNames: remaining,
        revokedRoleLabel,
        targetLabel: displayUserName(data),
        userId,
        onConfirm: async (input) => {
          await replaceGlobalRoles({ ...input, userId });
          await mutate();
        },
      });
    },
    [authMethod, data, mutate, replaceGlobalRoles, t, userId],
  );

  // ── State ordering (UI-R1-03) ────────────────────────────────────────────
  // 1) Loading (no settled data)
  if (isLoading && !data && !error) {
    return (
      <AdminPageTemplate title={t('users.detail.loading')}>
        <div className={styles.state} role="status">
          <Text type="secondary">{t('primitives.dataTable.loading')}</Text>
        </div>
      </AdminPageTemplate>
    );
  }

  // 2) Structured not-found only
  if (isNotFoundError(error)) {
    return (
      <AdminPageTemplate title={t('users.detail.notFoundTitle')}>
        <div className={styles.state}>
          <Text>{t('users.detail.notFoundDesc')}</Text>
          <Button type="default" onClick={() => navigate('/admin/users')}>
            {t('users.detail.backToList')}
          </Button>
        </div>
      </AdminPageTemplate>
    );
  }

  // 3) Generic network/server error + retry (must be reachable)
  if (error && !data) {
    return (
      <AdminPageTemplate title={t('users.detail.title')}>
        <div className={styles.state} role="alert">
          <Text>{t('primitives.dataTable.error')}</Text>
          <Button type="primary" onClick={() => void mutate()}>
            {t('primitives.dataTable.retry')}
          </Button>
        </div>
      </AdminPageTemplate>
    );
  }

  // 4) No-data fallback (should be rare after loading/error)
  if (!data || !userId) {
    return (
      <AdminPageTemplate title={t('users.detail.notFoundTitle')}>
        <div className={styles.state}>
          <Text>{t('users.detail.notFoundDesc')}</Text>
          <Button type="default" onClick={() => navigate('/admin/users')}>
            {t('users.detail.backToList')}
          </Button>
        </div>
      </AdminPageTemplate>
    );
  }

  const titleName = displayUserName(data);

  return (
    <AdminPageTemplate
      title={titleName}
      description={
        <div className={styles.headerMeta}>
          <Avatar avatar={data.avatar ?? undefined} size={40} />
          <Text type="secondary">{data.email ?? data.id}</Text>
          <StatusBadge status={data.status} />
          {data.isSelf ? <Text type="secondary">{t('users.detail.youBadge')}</Text> : null}
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
      <div className={styles.panel}>
        {tab === 'overview' ? (
          <OverviewTab
            canBan={canBan}
            canDelete={canDelete}
            user={data}
            onBan={canBan ? openBan : undefined}
            onDelete={canDelete ? openDelete : undefined}
            onUnban={canBan ? openUnban : undefined}
          />
        ) : null}
        {tab === 'access' ? (
          <AccessTab
            canManageRoles={canManageRoles}
            user={data}
            onRevokeRole={canManageRoles ? openRevokeRole : undefined}
            onUpdatePermissions={canManageRoles ? openUpdatePermissions : undefined}
          />
        ) : null}
        {tab === 'sessions' ? (
          <SessionsTab
            canRevoke={canRevoke}
            user={data}
            onRevokeAll={canRevoke ? openRevokeAll : undefined}
            onRevokeSession={canRevoke ? openRevokeSingle : undefined}
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
