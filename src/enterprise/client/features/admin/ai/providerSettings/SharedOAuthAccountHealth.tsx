'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import type { ReactNode } from 'react';
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

interface SharedOAuthAccountHealthProps {
  account: AccountModel;
  connectDisabled?: boolean;
  name: string;
  onConnect: () => void;
  /**
   * The paste-route remedy pair. Built by the card so the two alerts that offer it share one
   * instance rather than each assembling its own.
   */
  sessionFix: ReactNode;
  webSessionOnly: boolean;
}

/**
 * The one line (or alert) that says how the stored shared credential is doing: dead and
 * waiting on an operator, alive but unable to renew itself, or healthy.
 */
const SharedOAuthAccountHealth = memo<SharedOAuthAccountHealthProps>(
  ({ account, connectDisabled, name, onConnect, sessionFix, webSessionOnly }) => {
    const { t } = useTranslation('admin');

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
  },
);

SharedOAuthAccountHealth.displayName = 'AdminSharedOAuthAccountHealth';

export default SharedOAuthAccountHealth;
