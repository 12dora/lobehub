'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import SharedOAuthBadge from './SharedOAuthBadge';

const styles = createStaticStyles(({ css, cssVar }) => ({
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
}));

interface SharedOAuthConnectHeaderProps {
  badgeVisible: boolean;
  connected: boolean;
  name: string;
  needsReauth: boolean;
  reauthDetail: string;
}

/** What this panel is, for which provider, and where the stored account stands. */
const SharedOAuthConnectHeader = memo<SharedOAuthConnectHeaderProps>(
  ({ badgeVisible, connected, name, needsReauth, reauthDetail }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox horizontal align={'flex-start'} gap={12} justify={'space-between'}>
        <Flexbox gap={2}>
          <Text strong style={{ fontSize: 16 }}>
            {t('aiProviderSettings.sharedOAuth.title')}
          </Text>
          <Text className={styles.hint}>
            {t('aiProviderSettings.sharedOAuth.description', { name })}
          </Text>
        </Flexbox>
        <SharedOAuthBadge
          connected={connected}
          needsReauth={needsReauth}
          reauthDetail={reauthDetail}
          visible={badgeVisible}
        />
      </Flexbox>
    );
  },
);

SharedOAuthConnectHeader.displayName = 'AdminSharedOAuthConnectHeader';

export default SharedOAuthConnectHeader;
