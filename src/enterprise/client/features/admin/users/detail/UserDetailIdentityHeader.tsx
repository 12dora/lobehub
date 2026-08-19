'use client';

import { Avatar, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import StatusBadge from '../../primitives/StatusBadge';

const styles = createStaticStyles(({ css }) => ({
  headerMeta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  `,
  panelHeader: css`
    display: flex;
    gap: 12px;
    align-items: center;

    padding-block-end: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  panelHeaderText: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
}));

export interface UserDetailIdentityHeaderProps {
  avatar?: string | null;
  emailOrId: string;
  isSelf: boolean;
  name: string;
  status: string | null | undefined;
  variant: 'page' | 'panel';
}

export const UserDetailIdentityHeader = memo<UserDetailIdentityHeaderProps>(
  ({ avatar, emailOrId, isSelf, name, status, variant }) => {
    const { t } = useTranslation('admin');
    const youBadge = isSelf ? <Text type="secondary">{t('users.detail.youBadge')}</Text> : null;

    if (variant === 'panel') {
      return (
        <div className={styles.panelHeader} data-testid="user-panel-header">
          <Avatar avatar={avatar ?? undefined} size={40} />
          <div className={styles.panelHeaderText}>
            <Text ellipsis style={{ fontWeight: 600, margin: 0 }}>
              {name}
            </Text>
            <Text ellipsis style={{ margin: 0 }} type="secondary">
              {emailOrId}
            </Text>
          </div>
          <StatusBadge status={status} />
          {youBadge}
        </div>
      );
    }

    return (
      <div className={styles.headerMeta}>
        <Avatar avatar={avatar ?? undefined} size={40} />
        <Text type="secondary">{emailOrId}</Text>
        <StatusBadge status={status} />
        {youBadge}
      </div>
    );
  },
);

UserDetailIdentityHeader.displayName = 'UserDetailIdentityHeader';
