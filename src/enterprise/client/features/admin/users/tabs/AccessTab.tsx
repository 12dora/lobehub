'use client';

import { Flexbox, Icon, Tag, Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Info } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { resolvePlatformRoleDescription, resolvePlatformRoleLabel } from '@/const/platform/roles';
import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import { formatAdminDateTime } from '../utils';
import { detailStyles } from './detailStyles';

const styles = createStaticStyles(({ css }) => ({
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  heading: css`
    display: flex;
    gap: 6px;
    align-items: center;
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  infoIcon: css`
    cursor: help;
    display: inline-flex;
    color: ${cssVar.colorTextTertiary};
  `,
  roleCard: css`
    display: flex;
    flex-direction: column;
    gap: 4px;

    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    font-size: 13px;
  `,
  roleCardHeader: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
}));

interface AccessTabProps {
  canManageRoles: boolean;
  /** Whether the actor may revoke this specific role (e.g. only super admins revoke super_admin). */
  canRevokeRole?: (roleName: string) => boolean;
  /** Revoke a single global role by name. */
  onRevokeRole?: (roleName: string) => void;
  onUpdatePermissions?: () => void;
  user: AdminUsersGetOutput;
}

const AccessTab = memo<AccessTabProps>(
  ({ user, canManageRoles, onUpdatePermissions, onRevokeRole, canRevokeRole }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={detailStyles.root}>
        <section className={detailStyles.section}>
          <div className={styles.header}>
            <div className={styles.heading}>
              <Text as="h3" className={detailStyles.sectionTitle}>
                {t('users.access.globalRoles')}
              </Text>
              <Tooltip title={t('users.access.workspaceNote')}>
                <span className={styles.infoIcon}>
                  <Icon icon={Info} size={14} />
                </span>
              </Tooltip>
            </div>
            {canManageRoles && onUpdatePermissions ? (
              <Button size="small" type="primary" onClick={onUpdatePermissions}>
                {t('users.actions.replaceRoles')}
              </Button>
            ) : null}
          </div>
          {user.roles.length === 0 ? (
            <Text type="secondary">{t('users.access.noRoles')}</Text>
          ) : (
            <Flexbox gap={8}>
              {user.roles.map((role) => (
                <div className={styles.roleCard} key={role.id}>
                  <div className={styles.roleCardHeader}>
                    <Flexbox horizontal align="center" gap={8}>
                      <Tag>
                        {/* System roles: i18n only — never fall back to stored English seed displayName. */}
                        {resolvePlatformRoleLabel(role, (key, options) =>
                          String(t(key as never, { defaultValue: options?.defaultValue })),
                        )}
                      </Tag>
                      <Text type="secondary">
                        {role.expiresAt
                          ? t('users.access.expires', { date: formatAdminDateTime(role.expiresAt) })
                          : t('users.access.noExpiry')}
                      </Text>
                    </Flexbox>
                    {canManageRoles && onRevokeRole && (canRevokeRole?.(role.name) ?? true) ? (
                      <Button
                        danger
                        size="small"
                        type="text"
                        onClick={() => onRevokeRole(role.name)}
                      >
                        {t('users.modals.revokeRole.confirm')}
                      </Button>
                    ) : null}
                  </div>
                  <Text type="secondary">
                    {resolvePlatformRoleDescription(role, (key, options) =>
                      String(t(key as never, { defaultValue: options?.defaultValue })),
                    )}
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
            <Text className={styles.hint}>{t('users.access.noPermission')}</Text>
          )}
        </section>
      </div>
    );
  },
);

AccessTab.displayName = 'AdminUserAccessTab';

export default AccessTab;
