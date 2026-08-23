'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { SharedOAuthConnectionStatus } from './deriveConnectedCardModel';
import { deriveConnectedCardModel } from './deriveConnectedCardModel';
import SharedOAuthAccountHealth from './SharedOAuthAccountHealth';
import SharedOAuthSessionFixActions from './SharedOAuthSessionFixActions';
import SharedOAuthTokenUntil from './SharedOAuthTokenUntil';

const styles = createStaticStyles(({ css, cssVar }) => ({
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

interface SharedOAuthConnectedCardProps {
  /**
   * The provider's second connect route, when it has one. Rendered under the connect button
   * and only while nothing is connected: it is an alternative to connecting, not to the
   * account that is already stored.
   */
  apiKeyForm?: ReactNode;
  /**
   * A connect run is already in flight elsewhere on this card (the API-key route requesting
   * or redeeming its envelope). Starting a browser login now would retire that envelope, so
   * every action that starts one stands down until it settles.
   */
  connectDisabled?: boolean;
  disconnecting: boolean;
  enforcementHint: ReactNode;
  name: string;
  needsReauth: boolean;
  onConnect: () => void;
  onConnectWithSession: () => void;
  onDisconnect: () => void;
  reauthDetail: string;
  status?: SharedOAuthConnectionStatus;
  webSessionOnly: boolean;
}

const SharedOAuthConnectedCard = memo<SharedOAuthConnectedCardProps>(
  ({
    apiKeyForm,
    connectDisabled,
    disconnecting,
    enforcementHint,
    name,
    needsReauth,
    onConnect,
    onConnectWithSession,
    onDisconnect,
    reauthDetail,
    status,
    webSessionOnly,
  }) => {
    const { t } = useTranslation('admin');
    const model = deriveConnectedCardModel({ name, needsReauth, status, webSessionOnly });
    const showAccount = model.view === 'account';

    const sessionFix = (
      <SharedOAuthSessionFixActions
        connectDisabled={connectDisabled}
        webSessionOnly={webSessionOnly}
        onConnect={onConnect}
        onConnectWithSession={onConnectWithSession}
      />
    );

    let body: ReactNode;
    switch (model.view) {
      case 'disconnected': {
        body = (
          <Text className={styles.meta}>
            {t('aiProviderSettings.sharedOAuth.disconnectedHint', { name })}
          </Text>
        );
        break;
      }
      case 'account': {
        body = (
          <Flexbox gap={4}>
            {/* Only when there IS an identity to name. The badge in the header already says
                the account is connected, so a body line repeating it added a row and no
                information — and it is the row an operator scans for WHICH account. */}
            {model.account && (
              <Text className={styles.meta}>
                {t('aiProviderSettings.sharedOAuth.account', { account: model.account })}
              </Text>
            )}
            <SharedOAuthAccountHealth
              account={model}
              connectDisabled={connectDisabled}
              name={name}
              sessionFix={sessionFix}
              webSessionOnly={webSessionOnly}
              onConnect={onConnect}
            />
            {model.health === 'reauth' && <Text className={styles.hint}>{reauthDetail}</Text>}
            <SharedOAuthTokenUntil account={model} />
            {enforcementHint}
          </Flexbox>
        );
        break;
      }
    }

    return (
      <Flexbox gap={12}>
        {body}
        <Flexbox horizontal gap={8}>
          {/* While the account needs re-authorizing the ONE primary action lives in the alert
              above; repeating it here would offer the same remedy twice, in two shapes. */}
          {!needsReauth && (
            <Button
              disabled={connectDisabled}
              type={showAccount ? 'default' : 'primary'}
              onClick={onConnect}
            >
              {t(
                showAccount
                  ? 'aiProviderSettings.sharedOAuth.reconnect'
                  : 'aiProviderSettings.sharedOAuth.connect',
              )}
            </Button>
          )}
          {/* Withdrawing must stay available for a dead credential too — it is still stored. */}
          {showAccount && (
            <Button danger loading={disconnecting} onClick={onDisconnect}>
              {t('aiProviderSettings.sharedOAuth.disconnect')}
            </Button>
          )}
        </Flexbox>
        {/*
          The other way in, as a closed disclosure right under the primary one. It used to be
          reachable only from the awaiting state, which meant an operator holding a dashboard
          key had to start a real browser login against the provider and then abandon it — the
          harder path to the connection that actually lasts.
        */}
        {!showAccount && apiKeyForm}
      </Flexbox>
    );
  },
);

SharedOAuthConnectedCard.displayName = 'AdminSharedOAuthConnectedCard';

export default SharedOAuthConnectedCard;
