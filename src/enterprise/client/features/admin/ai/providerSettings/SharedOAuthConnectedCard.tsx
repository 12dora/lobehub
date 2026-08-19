'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConnectedCardModel, SharedOAuthConnectionStatus } from './deriveConnectedCardModel';
import { deriveConnectedCardModel } from './deriveConnectedCardModel';
import SharedOAuthSessionFixActions from './SharedOAuthSessionFixActions';

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

type AccountModel = Extract<ConnectedCardModel, { view: 'account' }>;

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

    const renderHealth = (account: AccountModel) => {
      switch (account.health) {
        case 'reauth': {
          /**
           * The one actionable state on this card, so it carries the ONE primary action and
           * the footer drops its duplicate. Pasting a web session is the cheap fix where that
           * route exists; a device-code provider has no paste box and must be sent to its own
           * authorization flow.
           */
          return (
            <Alert
              showIcon
              message={t('aiProviderSettings.sharedOAuth.reauth.message', { name })}
              type={'warning'}
              action={
                account.pasteFlow ? (
                  sessionFix
                ) : (
                  <Flexbox horizontal gap={8}>
                    <Button
                      disabled={connectDisabled}
                      size={'small'}
                      type={'primary'}
                      onClick={onConnect}
                    >
                      {t('aiProviderSettings.sharedOAuth.reconnect')}
                    </Button>
                  </Flexbox>
                )
              }
            />
          );
        }
        case 'cannotRenew': {
          // Copy has to name the remedies that are actually on screen, so a web-session-only
          // provider drops the sentence about the authorization page along with the button.
          let message: string;
          if (account.expiry && webSessionOnly) {
            message = t('aiProviderSettings.sharedOAuth.paste.cannotAutoRenewBeforeSessionOnly', {
              time: account.expiry,
            });
          } else if (account.expiry) {
            message = t('aiProviderSettings.sharedOAuth.paste.cannotAutoRenewBefore', {
              time: account.expiry,
            });
          } else if (webSessionOnly) {
            message = t('aiProviderSettings.sharedOAuth.paste.cannotAutoRenewSessionOnly');
          } else {
            message = t('aiProviderSettings.sharedOAuth.paste.cannotAutoRenew');
          }
          return <Alert showIcon action={sessionFix} message={message} type={'warning'} />;
        }
        case 'healthy': {
          let renewalKindLabel: string | undefined;
          if (account.renewalKind === 'web_session') {
            renewalKindLabel = t('aiProviderSettings.sharedOAuth.renewalKind.webSession');
          } else if (account.renewalKind === 'cursor_api_key') {
            renewalKindLabel = t('aiProviderSettings.sharedOAuth.renewalKind.apiKey');
          } else if (account.renewalKind === 'oauth') {
            renewalKindLabel = t('aiProviderSettings.sharedOAuth.renewalKind.oauth');
          }
          let hint = t('aiProviderSettings.sharedOAuth.autoRefresh');
          if (account.autoRenews && renewalKindLabel) {
            hint = t('aiProviderSettings.sharedOAuth.autoRenewKind', { kind: renewalKindLabel });
          } else if (!account.autoRenews && account.expiry) {
            hint = t('aiProviderSettings.sharedOAuth.expiresAt', { time: account.expiry });
          }
          return <Text className={styles.hint}>{hint}</Text>;
        }
      }
    };

    const renderTokenUntil = (account: AccountModel) => {
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
    };

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
            {renderHealth(model)}
            {model.health === 'reauth' && <Text className={styles.hint}>{reauthDetail}</Text>}
            {renderTokenUntil(model)}
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
