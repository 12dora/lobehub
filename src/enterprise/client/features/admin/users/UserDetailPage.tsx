'use client';

import { Alert, Avatar, Skeleton, Text } from '@lobehub/ui';
import { Button, Tabs } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { type PlatformSystemRoleName, resolvePlatformRoleLabel } from '@/const/platform/roles';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import StatusBadge from '../primitives/StatusBadge';
import { useAdminUserMutations, useFetchAdminUserDetail } from './hooks/useAdminUsers';
import {
  getEligibleAssignableRoles,
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
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const { id: userId } = useParams<{ id: string }>();
  const { permissions, roles: actorRoles, authMethod } = useAdminAccess();
  const [tab, setTab] = useState<DetailTab>('overview');

  const canBan = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_BAN);
  const canDelete = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_DELETE);
  const canRevoke = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_SESSION_REVOKE);
  const canManageRoles = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_ROLE_MANAGE);
  const canReadAudit = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

  // Same eligibility the replace-permissions modal uses: non-super actors cannot
  // revoke the super_admin role, so don't offer a button the server would reject.
  const eligibleRoleNames = new Set<string>(getEligibleAssignableRoles(actorRoles));
  const canRevokeRoleName = (roleName: string) => eligibleRoleNames.has(roleName);

  const { data, error, isLoading, mutate } = useFetchAdminUserDetail(userId);
  const { banUser, unbanUser, deleteUser, revokeSessions, replaceGlobalRoles } =
    useAdminUserMutations();

  // Post-commit SWR refresh lives inside useAdminUserMutations (soft — never fails the mutation).
  // Do not await a second mutate() here: a refresh rejection would surface as a mutation failure.

  const openBan = useCallback(() => {
    if (!data || !userId || data.isSelf) return;
    openBanUserModal({
      authMethod,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await banUser(input);
      },
    });
  }, [authMethod, banUser, data, userId]);

  const openUnban = useCallback(() => {
    if (!data || !userId || data.isSelf) return;
    openUnbanUserModal({
      authMethod,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await unbanUser(input);
      },
    });
  }, [authMethod, data, unbanUser, userId]);

  const openDelete = useCallback(() => {
    if (!data || !userId || data.isSelf) return;
    openDeleteUserModal({
      authMethod,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await deleteUser(input);
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
        await revokeSessions(input);
      },
    });
  }, [authMethod, data, revokeSessions, userId]);

  const openRevokeSingle = useCallback(
    (sessionId: string) => {
      if (!data || !userId) return;
      openRevokeSingleSessionModal({
        authMethod,
        isSelf: data.isSelf,
        sessionId,
        targetLabel: displayUserName(data),
        userId,
        onConfirm: async (input) => {
          await revokeSessions(input);
        },
      });
    },
    [authMethod, data, revokeSessions, userId],
  );

  const openUpdatePermissions = useCallback(() => {
    if (!data || !userId) return;
    openReplaceRolesModal({
      actorRoles,
      authMethod,
      // Pass full grants so the modal can preserve per-role expiry and protected roles.
      currentRoles: data.roles.map((r) => ({ expiresAt: r.expiresAt ?? null, name: r.name })),
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await replaceGlobalRoles(input);
      },
    });
  }, [actorRoles, authMethod, data, replaceGlobalRoles, userId]);

  const openRevokeRole = useCallback(
    (roleName: string) => {
      if (!data || !userId) return;
      const remaining = data.roles
        .map((r) => r.name)
        .filter((name) => name !== roleName) as PlatformSystemRoleName[];
      const revoked = data.roles.find((r) => r.name === roleName);
      const revokedRoleLabel = resolvePlatformRoleLabel(
        { displayName: revoked?.displayName, name: roleName },
        (key, options) => String(t(key as never, { defaultValue: options?.defaultValue })),
      );
      openRevokeRoleModal({
        authMethod,
        remainingRoleNames: remaining,
        revokedRoleLabel,
        targetLabel: displayUserName(data),
        userId,
        onConfirm: async (input) => {
          await replaceGlobalRoles(input);
        },
      });
    },
    [authMethod, data, replaceGlobalRoles, t, userId],
  );

  // ── State ordering (UI-R1-03) ────────────────────────────────────────────
  // 1) Loading (no settled data)
  if (isLoading && !data && !error) {
    return (
      <AdminPageTemplate title={t('users.detail.loading')}>
        <div aria-label={t('primitives.dataTable.loading')} className={styles.state} role="status">
          <Skeleton title active={!reduceMotion} paragraph={{ rows: 6 }} />
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
  // Cached detail with a failed revalidation: warn and lock high-risk actions so
  // operators cannot ban/delete/revoke/role-change on obsolete security state.
  const dataStale = Boolean(error) && Boolean(data);
  const allowHighRisk = !dataStale;

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
        {dataStale ? (
          <Alert
            showIcon
            type="warning"
            action={
              <Button size="small" onClick={() => void mutate()}>
                {t('primitives.dataTable.retry')}
              </Button>
            }
            message={t('users.stale.refreshFailed', {
              defaultValue:
                'Showing cached data. High-risk actions are disabled until refresh succeeds.',
            })}
          />
        ) : null}
        {tab === 'overview' ? (
          <OverviewTab
            canBan={canBan && allowHighRisk}
            canDelete={canDelete && allowHighRisk}
            user={data}
            onBan={canBan && allowHighRisk ? openBan : undefined}
            onDelete={canDelete && allowHighRisk ? openDelete : undefined}
            onUnban={canBan && allowHighRisk ? openUnban : undefined}
          />
        ) : null}
        {tab === 'access' ? (
          <AccessTab
            canManageRoles={canManageRoles && allowHighRisk}
            canRevokeRole={canRevokeRoleName}
            user={data}
            onRevokeRole={canManageRoles && allowHighRisk ? openRevokeRole : undefined}
            onUpdatePermissions={
              canManageRoles && allowHighRisk ? openUpdatePermissions : undefined
            }
          />
        ) : null}
        {tab === 'sessions' ? (
          <SessionsTab
            canRevoke={canRevoke && allowHighRisk}
            user={data}
            onRevokeAll={canRevoke && allowHighRisk ? openRevokeAll : undefined}
            onRevokeSession={canRevoke && allowHighRisk ? openRevokeSingle : undefined}
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
