'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import AccessTab from '../tabs/AccessTab';
import AuditTab from '../tabs/AuditTab';
import OverviewTab from '../tabs/OverviewTab';
import SessionsTab from '../tabs/SessionsTab';
import type { UserDetailActionFlags } from './resolveUserDetailActionFlags';

const styles = createStaticStyles(({ css }) => ({
  /** Tab content. `page` variant caps the column so a wide screen does not spread facts out. */
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-block-start: 4px;
  `,
  panelPage: css`
    max-width: 880px;
  `,
}));

export type UserDetailTab = 'overview' | 'access' | 'sessions' | 'audit';

export interface UserDetailTabPanelsProps {
  canRevokeRoleName: (roleName: string) => boolean;
  data: AdminUsersGetOutput;
  dataStale: boolean;
  flags: UserDetailActionFlags;
  isPanel: boolean;
  mutate: () => unknown;
  tab: UserDetailTab;
  userId: string;
}

export const UserDetailTabPanels = memo<UserDetailTabPanelsProps>(
  ({ canRevokeRoleName, data, dataStale, flags, isPanel, mutate, tab, userId }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={isPanel ? styles.panel : `${styles.panel} ${styles.panelPage}`}>
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
            canBan={flags.overview.canBan}
            canDelete={flags.overview.canDelete}
            canManageCredentials={flags.overview.canManageCredentials}
            user={data}
            onBan={flags.overview.onBan}
            onDelete={flags.overview.onDelete}
            onDisableTwoFactor={flags.overview.onDisableTwoFactor}
            onSetPassword={flags.overview.onSetPassword}
            onUnban={flags.overview.onUnban}
          />
        ) : null}
        {tab === 'access' ? (
          <AccessTab
            canManageRoles={flags.access.canManageRoles}
            canRevokeRole={canRevokeRoleName}
            user={data}
            onRevokeRole={flags.access.onRevokeRole}
            onUpdatePermissions={flags.access.onUpdatePermissions}
          />
        ) : null}
        {tab === 'sessions' ? (
          <SessionsTab
            canRevoke={flags.sessions.canRevoke}
            user={data}
            onRevokeAll={flags.sessions.onRevokeAll}
            onRevokeSession={flags.sessions.onRevokeSession}
          />
        ) : null}
        {tab === 'audit' ? (
          <AuditTab
            canReadAudit={flags.audit.canReadAudit}
            enabled={tab === 'audit'}
            userId={userId}
          />
        ) : null}
      </div>
    );
  },
);

UserDetailTabPanels.displayName = 'UserDetailTabPanels';
