'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import { formatAdminDateTime } from '../utils';

interface AccessTabProps {
  canManageRoles: boolean;
  onReplaceRoles?: () => void;
  user: AdminUsersGetOutput;
}

const AccessTab = memo<AccessTabProps>(({ user, canManageRoles, onReplaceRoles }) => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={16}>
      <Flexbox horizontal align="center" justify="space-between">
        <Text as="h3" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
          {t('users.access.globalRoles')}
        </Text>
        {canManageRoles && onReplaceRoles ? (
          <Button size="small" type="primary" onClick={onReplaceRoles}>
            {t('users.actions.replaceRoles')}
          </Button>
        ) : null}
      </Flexbox>
      <Text type="secondary">{t('users.access.workspaceNote')}</Text>
      {user.roles.length === 0 ? (
        <Text type="secondary">{t('users.access.noRoles')}</Text>
      ) : (
        <Flexbox gap={8}>
          {user.roles.map((role) => (
            <Flexbox horizontal align="center" gap={8} key={role.id}>
              <Tag>
                {role.displayName ||
                  t(`users.roles.${role.name}` as never, { defaultValue: role.name })}
              </Tag>
              <Text style={{ fontSize: 12 }} type="secondary">
                {role.expiresAt
                  ? t('users.access.expires', { date: formatAdminDateTime(role.expiresAt) })
                  : t('users.access.noExpiry')}
              </Text>
            </Flexbox>
          ))}
        </Flexbox>
      )}
      {canManageRoles ? (
        <Text style={{ fontSize: 12 }} type="secondary">
          {t('users.access.lastSuperNote')}
        </Text>
      ) : (
        <Text type="secondary">{t('users.access.noPermission')}</Text>
      )}
    </Flexbox>
  );
});

AccessTab.displayName = 'AdminUserAccessTab';

export default AccessTab;
