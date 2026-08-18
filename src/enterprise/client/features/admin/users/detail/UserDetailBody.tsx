'use client';

import { Alert, Avatar, Text } from '@lobehub/ui';
import { Button, Tabs } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import StatusBadge from '../../primitives/StatusBadge';
import { useAdminUserMutations, useFetchAdminUserDetail } from '../hooks/useAdminUsers';
import { useUserDetailActions } from '../hooks/useUserDetailActions';
import { getEligibleAssignableRoles } from '../modals/actions';
import AccessTab from '../tabs/AccessTab';
import AuditTab from '../tabs/AuditTab';
import OverviewTab from '../tabs/OverviewTab';
import SessionsTab from '../tabs/SessionsTab';
import { displayUserName, hasPermission } from '../utils';
import {
  UserDetailError,
  UserDetailLoading,
  UserDetailNotFound,
  UserPanelError,
  UserPanelLoading,
  UserPanelNotFound,
} from './UserDetailStates';

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
  panelHeader: css`
    display: flex;
    gap: 12px;
    align-items: center;

    padding-block-end: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  panelHeaderText: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
  panelRoot: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  `,
}));

type DetailTab = 'overview' | 'access' | 'sessions' | 'audit';

/** Slide-in panel or full page — the body below is identical either way. */
export type UserDetailVariant = 'drawer' | 'page';

export interface UserDetailBodyProps {
  /**
   * Called once the target user is gone (deleted from inside the body).
   * The page variant falls back to returning to the list.
   */
  onDeleted?: () => void;
  /** Drawer variant only: dismiss the panel from a terminal state. */
  onDismiss?: () => void;
  userId: string | undefined;
  variant?: UserDetailVariant;
}

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

/**
 * User detail body — tabs, SWR detail, stale guard and every mutation entry point.
 * Rendered by the `/admin/users/:id` page (full chrome) and by the list's slide-in
 * panel (compact header), so both surfaces stay one implementation.
 */
const UserDetailBody = memo<UserDetailBodyProps>(
  ({ onDeleted, onDismiss, userId, variant = 'page' }) => {
    const { t } = useTranslation('admin');
    const reduceMotion = useReducedMotion();
    const navigate = useNavigate();
    const { permissions, roles: actorRoles, authMethod } = useAdminAccess();
    const [tab, setTab] = useState<DetailTab>('overview');
    const isPanel = variant === 'drawer';

    const canBan = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_BAN);
    const canDelete = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_DELETE);
    const canRevoke = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_SESSION_REVOKE);
    const canManageRoles = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_ROLE_MANAGE);
    const canManageCredentials = hasPermission(
      permissions,
      PLATFORM_PERMISSIONS.USER_CREDENTIAL_MANAGE,
    );
    const canReadAudit = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

    // Same eligibility the replace-permissions modal uses: non-super actors cannot
    // revoke the super_admin role, so don't offer a button the server would reject.
    const eligibleRoleNames = new Set<string>(getEligibleAssignableRoles(actorRoles));
    const canRevokeRoleName = (roleName: string) => eligibleRoleNames.has(roleName);

    const { data, error, isLoading, mutate } = useFetchAdminUserDetail(userId);
    const {
      banUser,
      unbanUser,
      deleteUser,
      disableUserTwoFactor,
      revokeSessions,
      replaceGlobalRoles,
      setUserPassword,
    } = useAdminUserMutations();

    const mutations = useMemo(
      () => ({
        banUser,
        deleteUser,
        disableUserTwoFactor,
        replaceGlobalRoles,
        revokeSessions,
        setUserPassword,
        unbanUser,
      }),
      [
        banUser,
        deleteUser,
        disableUserTwoFactor,
        replaceGlobalRoles,
        revokeSessions,
        setUserPassword,
        unbanUser,
      ],
    );

    const {
      openBan,
      openDelete,
      openDisableTwoFactor,
      openRevokeAll,
      openRevokeRole,
      openRevokeSingle,
      openSetPassword,
      openUnban,
      openUpdatePermissions,
    } = useUserDetailActions({
      actorRoles,
      authMethod,
      data,
      mutations,
      navigate,
      onDeleted,
      t,
      userId,
    });

    // ── State ordering (UI-R1-03) ────────────────────────────────────────────
    // 1) Loading (no settled data)
    if (isLoading && !data && !error) {
      return isPanel ? (
        <UserPanelLoading reduceMotion={reduceMotion} t={t} />
      ) : (
        <UserDetailLoading reduceMotion={reduceMotion} t={t} />
      );
    }

    // 2) Structured not-found only
    if (isNotFoundError(error)) {
      return isPanel ? (
        <UserPanelNotFound t={t} onDismiss={onDismiss} />
      ) : (
        <UserDetailNotFound navigate={navigate} t={t} />
      );
    }

    // 3) Generic network/server error + retry (must be reachable)
    if (error && !data) {
      return isPanel ? (
        <UserPanelError t={t} onRetry={() => void mutate()} />
      ) : (
        <UserDetailError t={t} onRetry={() => void mutate()} />
      );
    }

    // 4) No-data fallback (should be rare after loading/error)
    if (!data || !userId) {
      return isPanel ? (
        <UserPanelNotFound t={t} onDismiss={onDismiss} />
      ) : (
        <UserDetailNotFound navigate={navigate} t={t} />
      );
    }

    const titleName = displayUserName(data);
    // Cached detail with a failed revalidation: warn and lock high-risk actions so
    // operators cannot ban/delete/revoke/role-change on obsolete security state.
    const dataStale = Boolean(error) && Boolean(data);
    const allowHighRisk = !dataStale;

    const tabsNode = (
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
    );

    const bodyNode = (
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
            canManageCredentials={canManageCredentials}
            user={data}
            onBan={canBan && allowHighRisk ? openBan : undefined}
            onDelete={canDelete && allowHighRisk ? openDelete : undefined}
            onSetPassword={canManageCredentials && allowHighRisk ? openSetPassword : undefined}
            onUnban={canBan && allowHighRisk ? openUnban : undefined}
            onDisableTwoFactor={
              canManageCredentials && allowHighRisk ? openDisableTwoFactor : undefined
            }
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
    );

    // Slide-in panel: identity header instead of the page h1 + divider.
    if (isPanel) {
      return (
        <div className={styles.panelRoot}>
          <div className={styles.panelHeader} data-testid="user-panel-header">
            <Avatar avatar={data.avatar ?? undefined} size={40} />
            <div className={styles.panelHeaderText}>
              <Text ellipsis style={{ fontWeight: 600, margin: 0 }}>
                {titleName}
              </Text>
              <Text ellipsis style={{ margin: 0 }} type="secondary">
                {data.email ?? data.id}
              </Text>
            </div>
            <StatusBadge status={data.status} />
            {data.isSelf ? <Text type="secondary">{t('users.detail.youBadge')}</Text> : null}
          </div>
          {tabsNode}
          {bodyNode}
        </div>
      );
    }

    return (
      <AdminPageTemplate
        title={titleName}
        toolbar={tabsNode}
        description={
          <div className={styles.headerMeta}>
            <Avatar avatar={data.avatar ?? undefined} size={40} />
            <Text type="secondary">{data.email ?? data.id}</Text>
            <StatusBadge status={data.status} />
            {data.isSelf ? <Text type="secondary">{t('users.detail.youBadge')}</Text> : null}
          </div>
        }
      >
        {bodyNode}
      </AdminPageTemplate>
    );
  },
);

UserDetailBody.displayName = 'AdminUserDetailBody';

export default UserDetailBody;
