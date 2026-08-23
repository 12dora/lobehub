'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useProviderName } from '@/hooks/useProviderName';

import SharedOAuthConnectBody from './SharedOAuthConnectBody';
import SharedOAuthConnectHeader from './SharedOAuthConnectHeader';
import { resolveSharedOAuthConnectRoutes } from './sharedOAuthConnectRoutes';
import SharedOAuthEnforcementHint from './SharedOAuthEnforcementHint';
import { formatExpiry } from './sharedOAuthFormat';
import { useAdminSharedOAuthFlow } from './useAdminSharedOAuthFlow';
import { useSharedOAuthConnectionStatus } from './useSharedOAuthConnectionStatus';
import { useSharedOAuthConnectRoute } from './useSharedOAuthConnectRoute';
import { useSharedOAuthDisconnect } from './useSharedOAuthDisconnect';
import { useSharedOAuthMemberReach } from './useSharedOAuthMemberReach';

export {
  ADMIN_SHARED_OAUTH_STATUS_KEY,
  buildAdminSharedOAuthStatusKey,
  formatExpiry,
} from './sharedOAuthFormat';

interface SharedOAuthConnectProps {
  providerId: string;
}

/**
 * Platform-owned device-flow connect panel for rotating-refresh providers
 * (chatgpt / chatgptweb / supergrok): ONE account is stored in the platform vault and serves
 * every member. Never rendered on the user surface.
 */
const SharedOAuthConnect = memo<SharedOAuthConnectProps>(({ providerId }) => {
  const { t } = useTranslation('admin');
  const name = useProviderName(providerId);
  const { apiKeyUrl, offerApiKey, webSessionOnly } = resolveSharedOAuthConnectRoutes(providerId);
  const { hasPersistedEnabledModel, providerEnabled, showEnforcementHint, takeover } =
    useSharedOAuthMemberReach(providerId);

  const { handleStatusStale, handleStored, isLoading, refreshStatus, status, statusError } =
    useSharedOAuthConnectionStatus(providerId);

  const { disconnecting, handleDisconnect } = useSharedOAuthDisconnect({
    name,
    onStored: handleStored,
    providerId,
  });

  const {
    apiKeyPhase,
    connect,
    deviceCode,
    error,
    reset,
    state,
    submitAccessToken,
    submitApiKey,
    submitCallback,
    submitError,
    submitErrorSource,
    submitSessionToken,
    submitting,
  } = useAdminSharedOAuthFlow({
    onStatusStale: handleStatusStale,
    onSuccess: handleStored,
    providerId,
  });

  const {
    apiKeyRoute,
    handleConnect,
    handleConnectWithSession,
    handleOpenVerification,
    handleReset,
    handleSubmitApiKey,
    openSessionSection,
  } = useSharedOAuthConnectRoute({
    connect,
    deviceCode,
    reset,
    submitApiKey,
    webSessionOnly,
  });

  /** The API-key route is mid-round-trip: envelope request or exchange. */
  const apiKeyPending = apiKeyPhase !== 'idle';

  /**
   * The shared credential was TERMINALLY rejected and only an operator can fix it. Two
   * observations feed one state, because they mean the same thing to the person reading this
   * card: `expired` is this request's own refresh coming back `invalid_grant`, `needsReauth`
   * is the marker an earlier observation wrote into the vault — including a member's chat
   * being answered with 401, which is the case the card used to miss entirely (an unexpired
   * token string sitting in the vault made the refresh a no-op and the badge said 已连接).
   */
  const needsReauth = Boolean(status && (status.needsReauth || status.expired));
  const invalidAt = formatExpiry(status?.invalidAt ?? null);
  const reauthReason = status?.invalidReason
    ? t(`aiProviderSettings.sharedOAuth.reauth.reason.${status.invalidReason}` as any)
    : undefined;
  /** Reason + when, for the badge tooltip — the badge itself stays one short word. */
  const reauthDetail =
    [
      reauthReason,
      invalidAt ? t('aiProviderSettings.sharedOAuth.reauth.observedAt', { time: invalidAt }) : '',
    ]
      .filter(Boolean)
      .join(' · ') || t('aiProviderSettings.sharedOAuth.reauth.message', { name });

  return (
    <Flexbox gap={16}>
      <SharedOAuthConnectHeader
        badgeVisible={!isLoading && !statusError && Boolean(status)}
        connected={Boolean(status?.connected)}
        name={name}
        needsReauth={needsReauth}
        reauthDetail={reauthDetail}
      />
      <SharedOAuthConnectBody
        apiKeyPending={apiKeyPending}
        apiKeyRoute={apiKeyRoute}
        apiKeyUrl={apiKeyUrl}
        deviceCode={deviceCode}
        disconnecting={disconnecting}
        enforcementHint={<SharedOAuthEnforcementHint visible={showEnforcementHint} />}
        error={error}
        hasPersistedEnabledModel={hasPersistedEnabledModel}
        isLoading={isLoading}
        name={name}
        needsReauth={needsReauth}
        offerApiKey={offerApiKey}
        openSessionSection={openSessionSection}
        providerEnabled={providerEnabled}
        reauthDetail={reauthDetail}
        state={state}
        status={status}
        statusError={statusError}
        submitError={submitError}
        submitErrorSource={submitErrorSource}
        submitting={submitting}
        takeover={takeover}
        webSessionOnly={webSessionOnly}
        onConnect={handleConnect}
        onConnectWithSession={handleConnectWithSession}
        onDisconnect={handleDisconnect}
        onOpenVerification={handleOpenVerification}
        onRefreshStatus={() => void refreshStatus()}
        onReset={handleReset}
        onSubmitAccessToken={submitAccessToken}
        onSubmitApiKey={handleSubmitApiKey}
        onSubmitCallback={submitCallback}
        onSubmitSessionToken={submitSessionToken}
      />
    </Flexbox>
  );
});

SharedOAuthConnect.displayName = 'AdminSharedOAuthConnect';

export default SharedOAuthConnect;
