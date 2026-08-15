'use client';

import { CheckCircleFilled } from '@ant-design/icons';
import { ProviderIcon } from '@lobehub/icons';
import { Alert, CopyButton, Flexbox, Icon } from '@lobehub/ui';
import { Button, confirmModal } from '@lobehub/ui/base-ui';
import { Avatar, Typography } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { ExternalLinkIcon, Loader2Icon, LogOutIcon, UnplugIcon } from 'lucide-react';
import { getProviderOAuthGrantFlow } from 'model-bank/modelProviders';
import { type ReactNode } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';
import { lambdaQuery } from '@/libs/trpc/client';

import PasteFlowPanel from './PasteFlowPanel';
import { useOAuthDeviceFlow } from './useOAuthDeviceFlow';

const { Text, Link } = Typography;

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    overflow: hidden;

    width: 100%;
    margin-block-end: 24px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
  `,
  codeBox: css`
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;

    padding-block: 16px;
    padding-inline: 24px;
    border-radius: 12px;

    font-family: monospace;
    font-size: 28px;
    font-weight: 600;
    letter-spacing: 6px;

    background: ${cssVar.colorFillTertiary};
  `,
  content: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
    align-items: center;

    margin-block: 0 40px;
    padding-inline: 48px;
  `,
  errorText: css`
    color: ${cssVar.colorError};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;

    padding-block: 16px;
    padding-inline: 24px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  hero: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;
    justify-content: center;

    padding-block: 48px 32px;
    padding-inline: 24px;
    border-radius: 16px 16px 0 0;
  `,
  pollingHint: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;

    padding-block: 12px;
    padding-inline: 16px;
    border-radius: 8px;

    font-size: 13px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillQuaternary};
  `,
  serviceNote: css`
    font-size: 13px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  successBadge: css`
    display: flex;
    gap: 6px;
    align-items: center;

    font-size: 13px;
    color: ${cssVar.colorSuccess};
  `,
  userAvatar: css`
    border: 2px solid ${cssVar.colorBorderSecondary};
    box-shadow: 0 4px 12px ${cssVar.colorFillSecondary};
  `,
  userInfo: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
  `,
  username: css`
    font-size: 16px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
}));

/** Vault timestamps arrive as epoch millis (string or number); anything unparsable is unknown. */
const formatExpiry = (expiresAt?: number | string): string | undefined => {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') return undefined;
  const millis = Number(expiresAt);
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  return new Date(millis).toLocaleString();
};

export interface OAuthDeviceFlowAuthProps {
  extra?: ReactNode;
  name: string;
  onAuthChange?: () => void;
  providerId: string;
  title?: ReactNode;
}

const OAuthDeviceFlowAuth = memo<OAuthDeviceFlowAuthProps>(
  ({ providerId, name, onAuthChange, title, extra }) => {
    const { t } = useTranslation('modelProvider');
    const { allowed: canManageProvider } = usePermission('manage_provider_key');
    const [isAuthenticating, setIsAuthenticating] = useState(false);
    const hasAutoClosedRef = useRef(false);

    const utils = lambdaQuery.useUtils();

    const { data: authStatus } = lambdaQuery.oauthDeviceFlow.getAuthStatus.useQuery(
      { providerId },
      { refetchOnWindowFocus: true },
    );
    const isAuthenticated = authStatus?.status === 'ACTIVE';
    const username = authStatus?.username;
    const avatarUrl = authStatus?.avatarUrl;
    /**
     * K3's identity/expiry additions belong to the authorization-code paste flow, whose
     * credential really can die without notice. They must NOT change the connected card of
     * the providers that shipped before it: `canRefresh` is false for GitHub Copilot by
     * design (it stores a stable OAuth token that mints new bearer tokens), so a generic
     * reading would warn its users to reconnect before an expiry that never bites.
     */
    const isPasteFlowProvider =
      getProviderOAuthGrantFlow(providerId) === 'authorization_code_paste';
    const accountEmail = isPasteFlowProvider ? authStatus?.email : undefined;
    const expiresAtLabel = isPasteFlowProvider ? formatExpiry(authStatus?.expiresAt) : undefined;
    // Only a POSITIVE "cannot refresh" reading warns: silence must never be read as a
    // credential that will die without notice.
    const cannotAutoRenew = isPasteFlowProvider && authStatus?.canRefresh === false;
    // The mirror image, and equally positive-only: a renewable connection holds either an
    // OAuth refresh token or a chatgpt.com web session, so its expiry is a routine rollover
    // date rather than a deadline — say so, or the bare "Expires {{time}}" line reads as a
    // warning it is not.
    const autoRenews = isPasteFlowProvider && authStatus?.canRefresh === true;
    /** Which credential does the renewing; absent for connections that predate the label. */
    const renewalKindLabel =
      authStatus?.renewalKind === 'web_session'
        ? t('providerModels.config.oauth.renewalKind.webSession')
        : authStatus?.renewalKind === 'oauth'
          ? t('providerModels.config.oauth.renewalKind.oauth')
          : undefined;

    /**
     * The flow reported the credential stored and the status query has not caught up yet.
     * Owned here instead of read off the flow's `state === 'success'`: the hook keeps that
     * value until the next run, so after a disconnect it would strand the card on a
     * "connected" badge with no way to connect again.
     */
    const [justConnected, setJustConnected] = useState(false);

    const revokeAuth = lambdaQuery.oauthDeviceFlow.revokeAuth.useMutation({
      onSuccess: () => {
        setJustConnected(false);
        utils.oauthDeviceFlow.getAuthStatus.invalidate({ providerId });
        onAuthChange?.();
      },
    });

    /**
     * Whether the flow was started from the "cannot renew itself" warning's primary fix, in
     * which case the paste panel must open ON the web-session box rather than making the
     * user hunt for the section they just asked for.
     */
    const [openSessionSection, setOpenSessionSection] = useState(false);

    const handleSuccess = useCallback(() => {
      /**
       * Tear the paste form down FIRST, synchronously.
       *
       * That form still holds the raw material the user pasted — a chatgpt.com session cookie
       * or an access token, in plain text on screen. Awaiting the status revalidation before
       * clearing this flag kept the credential rendered for the whole round trip, and a
       * REJECTED revalidation kept it rendered for good (and surfaced as an unhandled
       * rejection, since the flow calls this without awaiting). Nothing about a cache read may
       * decide how long a secret stays visible.
       */
      setIsAuthenticating(false);
      setOpenSessionSection(false);
      setJustConnected(true);
      onAuthChange?.();
      // Background, and caught: a failed revalidation is a stale view the next focus refetch
      // fixes, never a user-visible error and never a reason to keep the form alive.
      void utils.oauthDeviceFlow.getAuthStatus.invalidate({ providerId }).catch(() => {});
    }, [onAuthChange, providerId, utils.oauthDeviceFlow.getAuthStatus]);

    const handleStatusStale = useCallback(() => {
      // A run the user walked away from can still have stored a credential server-side:
      // re-read the status so the card cannot keep claiming "not connected". A failing
      // revalidation is a stale view only, never a user-visible error.
      void utils.oauthDeviceFlow.getAuthStatus.invalidate({ providerId }).catch(() => {});
    }, [providerId, utils.oauthDeviceFlow.getAuthStatus]);

    const {
      state,
      deviceCodeInfo,
      error,
      startAuth,
      cancelAuth,
      submitAccessToken,
      submitCallback,
      submitError,
      submitErrorSource,
      submitSessionToken,
      submitting,
    } = useOAuthDeviceFlow({
      onStatusStale: handleStatusStale,
      onSuccess: handleSuccess,
      providerId,
    });

    const isPasteFlow = deviceCodeInfo?.flow === 'authorization_code_paste';

    const handleDisconnect = useCallback(() => {
      if (!canManageProvider) return;

      confirmModal({
        content: t('providerModels.config.oauth.disconnectConfirm'),
        okButtonProps: { danger: true },
        okText: t('providerModels.config.oauth.disconnect'),
        onOk: async () => {
          await revokeAuth.mutateAsync({ providerId });
        },
        title: t('providerModels.config.oauth.disconnect'),
      });
    }, [canManageProvider, providerId, revokeAuth, t]);

    const handleStartAuth = useCallback(async () => {
      if (!canManageProvider) return;

      setOpenSessionSection(false);
      setJustConnected(false);
      hasAutoClosedRef.current = false;
      setIsAuthenticating(true);
      const info = await startAuth();

      // The paste flow opens the authorization page from its own explicit step: the user
      // has to come back with the callback URL, so throwing them into a browser tab before
      // they have read what to bring back is exactly the wrong order.
      if (info?.flow === 'authorization_code_paste') return;

      // Auto-open the verification page right away — the Connect click still
      // counts as transient user activation, so popup blockers normally allow
      // it. The manual "open browser" button stays as a fallback when blocked.
      const uri = info?.verificationUriComplete || info?.verificationUri;
      // noopener/noreferrer: the provider's page must never get a handle on this window.
      if (uri) window.open(uri, '_blank', 'noopener,noreferrer');
    }, [canManageProvider, startAuth]);

    /** Same flow, landing on the web-session box — the one-paste route to auto-renewal. */
    const handleStartAuthWithSession = useCallback(async () => {
      if (!canManageProvider) return;

      setOpenSessionSection(true);
      setJustConnected(false);
      hasAutoClosedRef.current = false;
      setIsAuthenticating(true);
      await startAuth();
    }, [canManageProvider, startAuth]);

    const handleCancelAuth = useCallback(() => {
      setIsAuthenticating(false);
      setJustConnected(false);
      cancelAuth();
    }, [cancelAuth]);

    const handleOpenBrowser = useCallback(() => {
      // Prefer the code-prefilled URI so the user doesn't need to type the code
      const uri = deviceCodeInfo?.verificationUriComplete || deviceCodeInfo?.verificationUri;
      if (uri) {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }
    }, [deviceCodeInfo?.verificationUri, deviceCodeInfo?.verificationUriComplete]);

    // Reset hasAutoClosedRef when starting new auth
    useEffect(() => {
      if (state === 'success' && !hasAutoClosedRef.current) {
        hasAutoClosedRef.current = true;
      }
    }, [state]);

    // Render Hero section with provider logo
    const renderHero = () => (
      <div className={styles.hero}>
        <ProviderIcon provider={providerId} size={72} type={'avatar'} />
      </div>
    );

    // Render content based on authentication state
    const renderContent = () => {
      // Authenticated state - show user info
      // Show when authenticated and not in the middle of authenticating process
      if (isAuthenticated && !isAuthenticating) {
        return (
          <div className={styles.content}>
            <Flexbox align="center" gap={16}>
              {avatarUrl && <Avatar className={styles.userAvatar} size={56} src={avatarUrl} />}
              <div className={styles.userInfo}>
                {username && <span className={styles.username}>{username}</span>}
                {accountEmail && (
                  <Text type="secondary">
                    {t('providerModels.config.oauth.paste.connectedEmail', { email: accountEmail })}
                  </Text>
                )}
                <div className={styles.successBadge}>
                  <CheckCircleFilled />
                  <span>{t('providerModels.config.oauth.connected')}</span>
                </div>
                {/*
                 * The bare date, and ONLY when neither branch below owns it. A connection
                 * that renews itself has no deadline to state (its expiry is the current
                 * token's rollover, spelled out as such underneath), and a connection that
                 * cannot renew has exactly one deadline — the warning's, which would
                 * otherwise be printed twice in two different voices.
                 */}
                {expiresAtLabel && !autoRenews && !cannotAutoRenew && (
                  <Text style={{ fontSize: 13 }} type="secondary">
                    {t('providerModels.config.oauth.paste.expiresAt', { time: expiresAtLabel })}
                  </Text>
                )}
                {autoRenews && (
                  <Text style={{ fontSize: 13 }} type="secondary">
                    {renewalKindLabel
                      ? t('providerModels.config.oauth.paste.autoRenewKind', {
                          kind: renewalKindLabel,
                        })
                      : t('providerModels.config.oauth.paste.autoRenew')}
                  </Text>
                )}
                {autoRenews && expiresAtLabel && (
                  // The rollover date, stated as what it is: the current token's end, not
                  // the connection's.
                  <Text style={{ fontSize: 13 }} type="secondary">
                    {t('providerModels.config.oauth.paste.currentTokenUntil', {
                      time: expiresAtLabel,
                    })}
                  </Text>
                )}
              </div>
            </Flexbox>
            {cannotAutoRenew && (
              /**
               * A dead end stated in warning-coloured body text is neither loud enough to
               * read as a problem nor actionable where it stands. Same surface as the admin
               * panel: one alert that owns the deadline AND both ways out, in order of
               * effort. Pasting a web session is the cheap one (one paste, no browser round
               * trip) and it is what makes this connection behave like the web app — sign in
               * once, never again. The authorization page stays available next to it, and
               * the pair wraps rather than overflowing a narrow card.
               */
              <Alert
                showIcon
                style={{ width: '100%' }}
                type="warning"
                action={
                  <Flexbox horizontal gap={8} wrap="wrap">
                    <Button
                      disabled={!canManageProvider}
                      size="small"
                      type="primary"
                      onClick={handleStartAuthWithSession}
                    >
                      {t('providerModels.config.oauth.paste.pasteSession')}
                    </Button>
                    <Button
                      disabled={!canManageProvider}
                      icon={<Icon icon={ExternalLinkIcon} />}
                      size="small"
                      onClick={handleStartAuth}
                    >
                      {t('providerModels.config.oauth.paste.reconnectRenewable')}
                    </Button>
                  </Flexbox>
                }
                message={
                  expiresAtLabel
                    ? t('providerModels.config.oauth.paste.cannotAutoRenewBefore', {
                        time: expiresAtLabel,
                      })
                    : t('providerModels.config.oauth.paste.cannotAutoRenew')
                }
              />
            )}
            <Button
              disabled={!canManageProvider}
              icon={<Icon icon={LogOutIcon} />}
              loading={revokeAuth.isPending}
              onClick={handleDisconnect}
            >
              {t('providerModels.config.oauth.disconnect')}
            </Button>
            <div className={styles.serviceNote}>
              {t('providerModels.config.oauth.serviceNote', { name })}
            </div>
          </div>
        );
      }

      /**
       * The credential is stored. Nothing below this line may render again — the paste panel
       * still holds the raw session cookie in its textarea, and it must not survive the
       * success even for the length of a status revalidation (or forever, if that read
       * fails). `handleSuccess` already drops `isAuthenticating`; this is the guard that does
       * not depend on it, and it stands until the refetched status swaps in the connected
       * card above.
       */
      if (justConnected) {
        return (
          <div className={styles.content}>
            <div className={styles.successBadge}>
              <CheckCircleFilled />
              <span>{t('providerModels.config.oauth.connected')}</span>
            </div>
            <div className={styles.serviceNote}>
              {t('providerModels.config.oauth.serviceNote', { name })}
            </div>
          </div>
        );
      }

      // Authenticating state - show device code
      if (isAuthenticating) {
        // Error state — BEFORE the loading guard on purpose: a failed initiation (or
        // regeneration) drops the envelope, so `!deviceCodeInfo` would otherwise swallow the
        // retry/cancel UI and leave the user staring at a spinner that never resolves.
        if (state === 'error' && error) {
          const errorKey = `providerModels.config.oauth.${error}`;
          return (
            <div className={styles.content}>
              <Flexbox horizontal align="center" gap={8}>
                <Icon color={cssVar.colorError} icon={UnplugIcon} size={20} />
                <Text className={styles.errorText}>{t(errorKey as any)}</Text>
              </Flexbox>
              <Flexbox gap={12} style={{ width: '100%' }} width={280}>
                <Button
                  block
                  disabled={!canManageProvider}
                  type="primary"
                  onClick={handleStartAuth}
                >
                  {t('providerModels.config.oauth.retry')}
                </Button>
                <Button block type="text" onClick={handleCancelAuth}>
                  {t('providerModels.config.oauth.cancel')}
                </Button>
              </Flexbox>
            </div>
          );
        }

        // Loading state
        if (state === 'requesting' || !deviceCodeInfo) {
          return (
            <div className={styles.content}>
              <Icon spin icon={Loader2Icon} size={24} />
              <Text type="secondary">{t('providerModels.config.oauth.connecting')}</Text>
            </div>
          );
        }

        // Authorization-code paste flow: open the provider's page, come back with the URL.
        if (isPasteFlow) {
          return (
            <div className={styles.content}>
              <PasteFlowPanel
                allowAccessTokenPaste={deviceCodeInfo.allowAccessTokenPaste}
                defaultSessionOpen={openSessionSection}
                disabled={!canManageProvider}
                submitError={submitError}
                submitErrorSource={submitErrorSource}
                submitting={submitting}
                authorizeUri={
                  deviceCodeInfo.verificationUriComplete || deviceCodeInfo.verificationUri
                }
                onCancel={handleCancelAuth}
                onOpenAuthorizePage={handleOpenBrowser}
                onRegenerate={handleStartAuth}
                onSubmitAccessToken={submitAccessToken}
                onSubmitCallback={submitCallback}
                onSubmitSessionToken={submitSessionToken}
              />
            </div>
          );
        }

        // Device code display
        return (
          <div className={styles.content}>
            <Flexbox align="center" gap={12} style={{ width: '100%' }} width={320}>
              <Text type="secondary">{t('providerModels.config.oauth.enterCode')}</Text>
              <Flexbox horizontal align="center" gap={12} style={{ width: '100%' }}>
                <div className={styles.codeBox}>{deviceCodeInfo.userCode}</div>
                <CopyButton content={deviceCodeInfo.userCode} />
              </Flexbox>
            </Flexbox>

            <Flexbox gap={12} style={{ width: '100%' }} width={280}>
              <Button
                block
                icon={<Icon icon={ExternalLinkIcon} />}
                size="large"
                type="primary"
                onClick={handleOpenBrowser}
              >
                {t('providerModels.config.oauth.openBrowser')}
              </Button>
            </Flexbox>

            <Link
              href={deviceCodeInfo.verificationUri}
              style={{ fontSize: 13 }}
              target="_blank"
              type="secondary"
            >
              {deviceCodeInfo.verificationUri}
            </Link>

            <div className={styles.pollingHint}>
              <Icon spin icon={Loader2Icon} />
              <span>{t('providerModels.config.oauth.polling')}</span>
            </div>

            <Button type="text" onClick={handleCancelAuth}>
              {t('providerModels.config.oauth.cancel')}
            </Button>
          </div>
        );
      }

      // Error state (not authenticating)
      if (state === 'error' && error) {
        const errorKey = `providerModels.config.oauth.${error}`;
        return (
          <div className={styles.content}>
            <Flexbox horizontal align="center" gap={8}>
              <Icon color={cssVar.colorError} icon={UnplugIcon} size={18} />
              <Text className={styles.errorText}>{t(errorKey as any)}</Text>
            </Flexbox>
            <Button
              disabled={!canManageProvider}
              size="large"
              type="primary"
              onClick={handleStartAuth}
            >
              {t('providerModels.config.oauth.connect', { name })}
            </Button>
            <div className={styles.serviceNote}>
              {t('providerModels.config.oauth.serviceNote', { name })}
            </div>
          </div>
        );
      }

      // Default state - show connect button
      return (
        <div className={styles.content}>
          <Button
            disabled={!canManageProvider}
            size="large"
            type="primary"
            onClick={handleStartAuth}
          >
            {t('providerModels.config.oauth.connect', { name })}
          </Button>
          <div className={styles.serviceNote}>
            {t('providerModels.config.oauth.serviceNote', { name })}
          </div>
        </div>
      );
    };

    return (
      <div className={styles.card}>
        {(title || extra) && (
          <div className={styles.header}>
            <div>{title}</div>
            <div>{extra}</div>
          </div>
        )}
        {renderHero()}
        {renderContent()}
      </div>
    );
  },
);

OAuthDeviceFlowAuth.displayName = 'OAuthDeviceFlowAuth';

export default OAuthDeviceFlowAuth;
