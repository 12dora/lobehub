'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatExpiry } from './sharedOAuthFormat';

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

interface SharedOAuthConnectionStatus {
  accountEmail?: string | null;
  accountIdMasked?: string | null;
  canRefresh?: boolean;
  connected?: boolean;
  expiresAt?: string | null;
  flow?: string | null;
  lastRefreshAt?: string | null;
  renewalKind?: 'cursor_api_key' | 'oauth' | 'web_session' | null;
}

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

    const expiry = formatExpiry(status?.expiresAt ?? null);
    /**
     * Prefer the full sign-in email: it is the only human-readable identity of the shared
     * account, and an operator needs to recognise WHICH account is connected. `accountIdMasked`
     * is a 4-char prefix of the Codex workspace UUID — it identifies nothing to a human, so it
     * is only the fallback for connections stored before the email was captured.
     */
    const account = status?.accountEmail ?? status?.accountIdMasked ?? null;
    /** Whether a pasted credential is a route at all — a device-code provider has no box. */
    const pasteFlow = status?.flow === 'authorization_code_paste';
    /**
     * K3 addition: an access token pasted by hand has no renewal credential, so nothing
     * renews it. Scoped to the paste flow, so the device-code providers that shipped before
     * it keep their previous connected copy verbatim — and only a POSITIVE `false` warns,
     * because silence must never be read as "this credential will die".
     */
    const cannotAutoRenew = pasteFlow && status?.canRefresh === false;
    /**
     * The good outcome, and only on a POSITIVE reading: the connection holds a renewal
     * credential (an OAuth refresh token, a web session that mints tokens the way the web app
     * does, or an API key the server re-exchanges), so it rolls over on its own and its
     * `expiresAt` is a routine rollover date rather than a deadline. Saying only
     * "expires {{time}}" there reads as a warning it is not.
     *
     * Not gated on the paste flow any more: a device-code provider that stores a renewal
     * credential (Cursor — an API key it re-exchanges, or the refresh token of its browser
     * login) rolls over exactly the same way, and `renewalKind` is the POSITIVE reading that
     * says so. The paste flow keeps its previous condition verbatim so connections stored
     * before the label existed still read as renewable, and a card that reports
     * `canRefresh: false` (GitHub Copilot style) is untouched by either half.
     */
    const autoRenews = status?.canRefresh === true && (pasteFlow || Boolean(status?.renewalKind));
    const lastRefresh = formatExpiry(status?.lastRefreshAt ?? null);
    /** Which credential does the renewing — the operator's cue for what they connected with. */
    const renewalKindLabel =
      status?.renewalKind === 'web_session'
        ? t('aiProviderSettings.sharedOAuth.renewalKind.webSession')
        : status?.renewalKind === 'cursor_api_key'
          ? t('aiProviderSettings.sharedOAuth.renewalKind.apiKey')
          : status?.renewalKind === 'oauth'
            ? t('aiProviderSettings.sharedOAuth.renewalKind.oauth')
            : undefined;

    /**
     * A dead grant still HAS an account (the vault keeps it as the evidence), so the identity
     * block stays on screen while the card asks for a reconnect — replacing it with the
     * "nothing is connected yet" line would hide which account has to be re-authorized.
     */
    const showAccount = Boolean(status?.connected) || needsReauth;

    return (
      <Flexbox gap={12}>
        {showAccount ? (
          <Flexbox gap={4}>
            <Text className={styles.meta}>
              {account
                ? t('aiProviderSettings.sharedOAuth.account', { account })
                : t('aiProviderSettings.sharedOAuth.accountUnknown')}
            </Text>
            {needsReauth ? (
              /**
               * The one actionable state on this card, so it carries the ONE primary action and
               * the footer drops its duplicate. Which remedy that is depends on how the provider
               * connects: pasting a web session is the cheap fix where that route exists (and
               * the only one for a web-session-only provider), while a device-code provider has
               * no paste box at all and must be sent to its own authorization flow.
               */
              <Alert
                showIcon
                message={t('aiProviderSettings.sharedOAuth.reauth.message', { name })}
                type={'warning'}
                action={
                  <Flexbox horizontal gap={8}>
                    {pasteFlow ? (
                      <>
                        <Button
                          disabled={connectDisabled}
                          size={'small'}
                          type={'primary'}
                          onClick={onConnectWithSession}
                        >
                          {t('aiProviderSettings.sharedOAuth.paste.pasteSession')}
                        </Button>
                        {!webSessionOnly && (
                          <Button disabled={connectDisabled} size={'small'} onClick={onConnect}>
                            {t('aiProviderSettings.sharedOAuth.paste.reconnectRenewable')}
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button
                        disabled={connectDisabled}
                        size={'small'}
                        type={'primary'}
                        onClick={onConnect}
                      >
                        {t('aiProviderSettings.sharedOAuth.reconnect')}
                      </Button>
                    )}
                  </Flexbox>
                }
              />
            ) : cannotAutoRenew ? (
              /**
               * A dead end stated as a fact is not actionable: there are now TWO ways out and
               * both are one click away, so the warning carries them in the order of effort.
               * Pasting a web session is the cheaper fix (one paste, no browser round trip)
               * and it is what makes the connection behave like the web app — sign in once.
               */
              <Alert
                showIcon
                type={'warning'}
                action={
                  <Flexbox horizontal gap={8}>
                    <Button
                      disabled={connectDisabled}
                      size={'small'}
                      type={'primary'}
                      onClick={onConnectWithSession}
                    >
                      {t('aiProviderSettings.sharedOAuth.paste.pasteSession')}
                    </Button>
                    {/* Only where that route exists: a web-session-only provider would be
                        offering the one page its own server refuses to complete. */}
                    {!webSessionOnly && (
                      <Button disabled={connectDisabled} size={'small'} onClick={onConnect}>
                        {t('aiProviderSettings.sharedOAuth.paste.reconnectRenewable')}
                      </Button>
                    )}
                  </Flexbox>
                }
                message={
                  /* Two ways out, or one — the copy has to name the remedies that are
                     actually on screen, so a web-session-only provider drops the sentence
                     about the authorization page along with the button. */
                  expiry
                    ? t(
                        webSessionOnly
                          ? 'aiProviderSettings.sharedOAuth.paste.cannotAutoRenewBeforeSessionOnly'
                          : 'aiProviderSettings.sharedOAuth.paste.cannotAutoRenewBefore',
                        { time: expiry },
                      )
                    : t(
                        webSessionOnly
                          ? 'aiProviderSettings.sharedOAuth.paste.cannotAutoRenewSessionOnly'
                          : 'aiProviderSettings.sharedOAuth.paste.cannotAutoRenew',
                      )
                }
              />
            ) : (
              <Text className={styles.hint}>
                {autoRenews
                  ? renewalKindLabel
                    ? t('aiProviderSettings.sharedOAuth.autoRenewKind', { kind: renewalKindLabel })
                    : t('aiProviderSettings.sharedOAuth.autoRefresh')
                  : expiry
                    ? t('aiProviderSettings.sharedOAuth.expiresAt', { time: expiry })
                    : t('aiProviderSettings.sharedOAuth.autoRefresh')}
              </Text>
            )}
            {needsReauth && <Text className={styles.hint}>{reauthDetail}</Text>}
            {autoRenews && expiry && (
              // The rollover date, stated as what it is — the current token's end, not the
              // connection's.
              <Text className={styles.hint}>
                {t('aiProviderSettings.sharedOAuth.currentTokenUntil', { time: expiry })}
              </Text>
            )}
            {autoRenews && lastRefresh && (
              // Proof the rollover is actually happening, not just promised.
              <Text className={styles.hint}>
                {t('aiProviderSettings.sharedOAuth.lastRefreshAt', { time: lastRefresh })}
              </Text>
            )}
            {enforcementHint}
          </Flexbox>
        ) : (
          <Text className={styles.meta}>
            {t('aiProviderSettings.sharedOAuth.disconnectedHint', { name })}
          </Text>
        )}
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
