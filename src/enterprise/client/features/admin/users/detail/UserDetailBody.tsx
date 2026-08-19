'use client';

import { Tabs } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import { useAdminUserMutations, useFetchAdminUserDetail } from '../hooks/useAdminUsers';
import { useUserDetailActions } from '../hooks/useUserDetailActions';
import { getEligibleAssignableRoles } from '../modals/actions';
import { displayUserName, hasPermission } from '../utils';
import { isNotFoundError } from './isNotFoundError';
import { resolveUserDetailActionFlags } from './resolveUserDetailActionFlags';
import { UserDetailIdentityHeader } from './UserDetailIdentityHeader';
import {
  UserDetailError,
  UserDetailLoading,
  UserDetailNotFound,
  UserPanelError,
  UserPanelLoading,
  UserPanelNotFound,
} from './UserDetailStates';
import type { UserDetailTab } from './UserDetailTabPanels';
import { UserDetailTabPanels } from './UserDetailTabPanels';

const styles = createStaticStyles(({ css }) => ({
  panelRoot: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  `,
}));

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
    const [tab, setTab] = useState<UserDetailTab>('overview');
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

    const flags = resolveUserDetailActionFlags({
      allowHighRisk,
      canBan,
      canDelete,
      canManageCredentials,
      canManageRoles,
      canReadAudit,
      canRevoke,
      openers: {
        openBan,
        openDelete,
        openDisableTwoFactor,
        openRevokeAll,
        openRevokeRole,
        openRevokeSingle,
        openSetPassword,
        openUnban,
        openUpdatePermissions,
      },
    });

    const tabsNode = (
      <Tabs
        activeKey={tab}
        items={[
          { key: 'overview', label: t('users.tabs.overview') },
          { key: 'access', label: t('users.tabs.access') },
          { key: 'sessions', label: t('users.tabs.sessions') },
          { key: 'audit', label: t('users.tabs.audit') },
        ]}
        onChange={(key) => setTab(key as UserDetailTab)}
      />
    );

    const panels = (
      <UserDetailTabPanels
        canRevokeRoleName={canRevokeRoleName}
        data={data}
        dataStale={dataStale}
        flags={flags}
        isPanel={isPanel}
        mutate={mutate}
        tab={tab}
        userId={userId}
      />
    );

    // Slide-in panel: identity header instead of the page h1 + divider.
    if (isPanel) {
      return (
        <div className={styles.panelRoot}>
          <UserDetailIdentityHeader
            avatar={data.avatar}
            emailOrId={data.email ?? data.id}
            isSelf={data.isSelf}
            name={titleName}
            status={data.status}
            variant="panel"
          />
          {tabsNode}
          {panels}
        </div>
      );
    }

    return (
      <AdminPageTemplate
        title={titleName}
        toolbar={tabsNode}
        description={
          <UserDetailIdentityHeader
            avatar={data.avatar}
            emailOrId={data.email ?? data.id}
            isSelf={data.isSelf}
            name={titleName}
            status={data.status}
            variant="page"
          />
        }
      >
        {panels}
      </AdminPageTemplate>
    );
  },
);

UserDetailBody.displayName = 'AdminUserDetailBody';

export default UserDetailBody;
