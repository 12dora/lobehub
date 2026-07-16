'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import { formatAdminDateTime } from '../utils';

const styles = createStaticStyles(({ css }) => ({
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  hint: css`
    color: ${cssVar.colorTextSecondary};
  `,
  roleCard: css`
    display: flex;
    flex-direction: column;
    gap: 4px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
}));

interface AccessTabProps {
  canManageRoles: boolean;
  onReplaceRoles?: () => void;
  user: AdminUsersGetOutput;
}

const AccessTab = memo<AccessTabProps>(({ user, canManageRoles, onReplaceRoles }) => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={16}>
      <div className={styles.header}>
        <Text as="h3" style={{ fontWeight: 600, margin: 0 }}>
          {t('users.access.globalRoles')}
        </Text>
        {canManageRoles && onReplaceRoles ? (
          <Button size="small" type="primary" onClick={onReplaceRoles}>
            {t('users.actions.replaceRoles')}
          </Button>
        ) : null}
      </div>
      <Text className={styles.hint}>{t('users.access.workspaceNote')}</Text>
      {user.roles.length === 0 ? (
        <Text type="secondary">{t('users.access.noRoles')}</Text>
      ) : (
        <Flexbox gap={8}>
          {user.roles.map((role) => (
            <div className={styles.roleCard} key={role.id}>
              <Flexbox horizontal align="center" gap={8}>
                <Tag>
                  {role.displayName ||
                    t(`users.roles.${role.name}` as never, { defaultValue: role.name })}
                </Tag>
                <Text type="secondary">
                  {role.expiresAt
                    ? t('users.access.expires', { date: formatAdminDateTime(role.expiresAt) })
                    : t('users.access.noExpiry')}
                </Text>
              </Flexbox>
              <Text type="secondary">
                {t(`users.roles.desc.${role.name}` as never, {
                  defaultValue: role.displayName || role.name,
                })}
              </Text>
              <Text type="secondary">
                {t(`users.roles.impact.${role.name}` as never, { defaultValue: '' })}
              </Text>
            </div>
          ))}
        </Flexbox>
      )}
      {canManageRoles ? (
        <Text className={styles.hint}>{t('users.access.lastSuperNote')}</Text>
      ) : (
        <Text type="secondary">{t('users.access.noPermission')}</Text>
      )}
    </Flexbox>
  );
});

AccessTab.displayName = 'AdminUserAccessTab';

export default AccessTab;
