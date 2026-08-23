'use client';

import { Tabs } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import { useFetchAdminUserDetail } from '../hooks/useAdminUsers';
import { useUserDetailActions } from '../hooks/useUserDetailActions';
import { getEligibleAssignableRoles } from '../modals/actions';
import { displayUserName } from '../utils';
import { resolveUserDetailActionFlags } from './resolveUserDetailActionFlags';
import { resolveUserDetailPermissions } from './resolveUserDetailPermissions';
import { UserDetailIdentityHeader } from './UserDetailIdentityHeader';
import { renderUserDetailNotFound, renderUserDetailStateFallback } from './UserDetailStateFallback';
import type { UserDetailTab } from './UserDetailTabPanels';
import { UserDetailTabPanels } from './UserDetailTabPanels';
import { useUserDetailMutationBundle } from './useUserDetailMutationBundle';

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

    const { canBan, canDelete, canManageCredentials, canManageRoles, canReadAudit, canRevoke } =
      resolveUserDetailPermissions(permissions);

    // Same eligibility the replace-permissions modal uses: non-super actors cannot
    // revoke the super_admin role, so don't offer a button the server would reject.
    const eligibleRoleNames = new Set<string>(getEligibleAssignableRoles(actorRoles));
    const canRevokeRoleName = (roleName: string) => eligibleRoleNames.has(roleName);

    const { data, error, isLoading, mutate } = useFetchAdminUserDetail(userId);
    const mutations = useUserDetailMutationBundle();

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
    const stateFallback = renderUserDetailStateFallback({
      data,
      error,
      isLoading,
      isPanel,
      navigate,
      onDismiss,
      reduceMotion,
      t,
      onRetry: () => void mutate(),
    });
    if (stateFallback) return stateFallback;

    // 4) No-data fallback (should be rare after loading/error)
    if (!data || !userId) {
      return renderUserDetailNotFound({ isPanel, navigate, onDismiss, t });
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
