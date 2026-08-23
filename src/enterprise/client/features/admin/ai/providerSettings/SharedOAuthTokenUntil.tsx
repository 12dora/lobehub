'use client';

import { Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConnectedCardModel } from './deriveConnectedCardModel';

const styles = createStaticStyles(({ css, cssVar }) => ({
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
}));

type AccountModel = Extract<ConnectedCardModel, { view: 'account' }>;

interface SharedOAuthTokenUntilProps {
  account: AccountModel;
}

/**
 * The rollover line of a self-renewing connection: how long the CURRENT token is good for and
 * when it was last renewed. A connection that renews nothing has no rollover to report.
 */
const SharedOAuthTokenUntil = memo<SharedOAuthTokenUntilProps>(({ account }) => {
  const { t } = useTranslation('admin');

  if (!account.autoRenews || (!account.expiry && !account.lastRefresh)) return null;
  const { expiry, lastRefresh } = account;
  let message: string;
  if (expiry && lastRefresh) {
    message = t('aiProviderSettings.sharedOAuth.tokenUntilWithLastRefresh', {
      lastRefresh,
      time: expiry,
    });
  } else if (expiry) {
    message = t('aiProviderSettings.sharedOAuth.currentTokenUntil', { time: expiry });
  } else {
    message = t('aiProviderSettings.sharedOAuth.lastRefreshAt', { time: lastRefresh });
  }
  return <Text className={styles.hint}>{message}</Text>;
});

SharedOAuthTokenUntil.displayName = 'AdminSharedOAuthTokenUntil';

export default SharedOAuthTokenUntil;
