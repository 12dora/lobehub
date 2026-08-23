'use client';

import { memo } from 'react';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import { detailStyles as styles } from './detailStyles';
import { OverviewAccountActions } from './OverviewAccountActions';
import { OverviewIdentitySection } from './OverviewIdentitySection';
import { OverviewProvidersSection } from './OverviewProvidersSection';
import SecuritySection from './SecuritySection';

export { resolveSetPasswordDisabledReason } from './resolveSetPasswordDisabledReason';

interface OverviewTabProps {
  canBan: boolean;
  canDelete: boolean;
  /** Actor holds USER_CREDENTIAL_MANAGE — gates the two security actions only. */
  canManageCredentials?: boolean;
  onBan?: () => void;
  onDelete?: () => void;
  /** Undefined when the action is unavailable (stale detail data). */
  onDisableTwoFactor?: () => void;
  /** Undefined when the action is unavailable (stale detail data). */
  onSetPassword?: () => void;
  onUnban?: () => void;
  user: AdminUsersGetOutput;
}

const OverviewTab = memo<OverviewTabProps>(
  ({
    user,
    canBan,
    canDelete,
    canManageCredentials = false,
    onBan,
    onDelete,
    onDisableTwoFactor,
    onSetPassword,
    onUnban,
  }) => (
    <div className={styles.root}>
      <OverviewIdentitySection user={user} />

      <OverviewProvidersSection providers={user.providers} />

      <SecuritySection
        canManageCredentials={canManageCredentials}
        user={user}
        onDisableTwoFactor={onDisableTwoFactor}
      />

      <OverviewAccountActions
        canBan={canBan}
        canDelete={canDelete}
        canManageCredentials={canManageCredentials}
        hasPassword={user.hasPassword}
        isBanned={user.status === 'banned'}
        isSelf={user.isSelf}
        onBan={onBan}
        onDelete={onDelete}
        onSetPassword={onSetPassword}
        onUnban={onUnban}
      />
    </div>
  ),
);

OverviewTab.displayName = 'AdminUserOverviewTab';

export default OverviewTab;
