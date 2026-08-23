'use client';

import { Skeleton } from '@lobehub/ui';
import type { ReactNode } from 'react';
import { memo } from 'react';

import type { SharedOAuthConnectionStatus } from './deriveConnectedCardModel';
import SharedOAuthApiKeyRoute from './SharedOAuthApiKeyRoute';
import { resolveStoredAlertMessageKey } from './sharedOAuthConnectRoutes';
import SharedOAuthFlowStates from './SharedOAuthFlowStates';
import SharedOAuthIdleCard from './SharedOAuthIdleCard';
import SharedOAuthPasteForm from './SharedOAuthPasteForm';
import SharedOAuthStatusRetry from './SharedOAuthStatusRetry';
import SharedOAuthSuccessPanel from './SharedOAuthSuccessPanel';
import type {
  SharedOAuthDeviceCode,
  SharedOAuthFlowError,
  SharedOAuthFlowState,
  SharedOAuthPasteError,
  SharedOAuthPasteSource,
} from './useAdminSharedOAuthFlow';

interface SharedOAuthConnectBodyProps {
  apiKeyPending: boolean;
  apiKeyRoute: boolean;
  apiKeyUrl?: string;
  deviceCode?: SharedOAuthDeviceCode;
  disconnecting: boolean;
  enforcementHint: ReactNode;
  error?: SharedOAuthFlowError;
  hasPersistedEnabledModel: boolean;
  isLoading: boolean;
  name: string;
  needsReauth: boolean;
  offerApiKey: boolean;
  onConnect: () => void;
  onConnectWithSession: () => void;
  onDisconnect: () => void;
  onOpenVerification: () => void;
  onRefreshStatus: () => void;
  onReset: () => void;
  onSubmitAccessToken: (accessToken: string, extras?: { deviceId?: string }) => void;
  onSubmitApiKey: (apiKey: string) => void;
  onSubmitCallback: (callbackUrl: string) => void;
  onSubmitSessionToken: (
    sessionToken: string,
    extras?: { deviceId?: string; sessionChunks?: string[] },
  ) => void;
  openSessionSection: boolean;
  providerEnabled: boolean;
  reauthDetail: string;
  state: SharedOAuthFlowState;
  status?: SharedOAuthConnectionStatus;
  statusError?: unknown;
  submitError?: SharedOAuthPasteError;
  submitErrorSource?: SharedOAuthPasteSource;
  submitting: boolean;
  takeover: boolean;
  webSessionOnly: boolean;
}

/** Which of the panel's states the operator is actually looking at. */
const SharedOAuthConnectBody = memo<SharedOAuthConnectBodyProps>((props) => {
  const {
    apiKeyPending,
    apiKeyRoute,
    apiKeyUrl,
    deviceCode,
    disconnecting,
    enforcementHint,
    error,
    hasPersistedEnabledModel,
    isLoading,
    name,
    needsReauth,
    offerApiKey,
    onConnect,
    onConnectWithSession,
    onDisconnect,
    onOpenVerification,
    onRefreshStatus,
    onReset,
    onSubmitAccessToken,
    onSubmitApiKey,
    onSubmitCallback,
    onSubmitSessionToken,
    openSessionSection,
    providerEnabled,
    reauthDetail,
    state,
    status,
    statusError,
    submitError,
    submitErrorSource,
    submitting,
    takeover,
    webSessionOnly,
  } = props;

  const idleCard = (
    <SharedOAuthIdleCard
      apiKeyPending={apiKeyPending}
      apiKeyRoute={apiKeyRoute}
      apiKeyUrl={apiKeyUrl}
      disconnecting={disconnecting}
      enforcementHint={enforcementHint}
      error={error}
      name={name}
      needsReauth={needsReauth}
      offerApiKey={offerApiKey}
      reauthDetail={reauthDetail}
      state={state}
      status={status}
      submitError={submitError}
      submitting={submitting}
      webSessionOnly={webSessionOnly}
      onConnect={onConnect}
      onConnectWithSession={onConnectWithSession}
      onDisconnect={onDisconnect}
      onReset={onReset}
      onSubmitApiKey={onSubmitApiKey}
    />
  );

  /**
   * The API-key route runs the same flow underneath, but it is not a browser login: keep the
   * operator on the card they are looking at rather than flashing the device-code chrome at
   * them, until the credential is actually stored.
   */
  if (apiKeyRoute && state !== 'success') return idleCard;

  if (state === 'awaiting' && deviceCode?.flow === 'authorization_code_paste') {
    return (
      <SharedOAuthPasteForm
        allowAccessTokenPaste={deviceCode.allowAccessTokenPaste}
        authorizeUri={deviceCode.verificationUriComplete || deviceCode.verificationUri}
        defaultSessionOpen={openSessionSection}
        submitError={submitError}
        submitErrorSource={submitErrorSource}
        submitting={submitting}
        webSessionOnly={webSessionOnly}
        onCancel={onReset}
        onOpenAuthorizePage={onOpenVerification}
        onRegenerate={onConnect}
        onSubmitAccessToken={onSubmitAccessToken}
        onSubmitCallback={onSubmitCallback}
        onSubmitSessionToken={onSubmitSessionToken}
      />
    );
  }

  if (state === 'requesting' || state === 'error' || (state === 'awaiting' && deviceCode)) {
    /**
     * The API-key route rides ALONGSIDE the browser login rather than replacing it: both
     * connect the same account, and only one of them survives the sign-in expiry. Offered
     * strictly off the card — a provider whose pasted credential is an access token keeps
     * its own (web-session) chrome — and only once the envelope says the paste is allowed.
     */
    const offerApiKeyHere =
      state === 'awaiting' && Boolean(deviceCode?.allowAccessTokenPaste) && offerApiKey;

    return (
      <SharedOAuthFlowStates
        deviceCode={deviceCode}
        error={error}
        name={name}
        state={state}
        alternativeRoute={
          offerApiKeyHere ? (
            <SharedOAuthApiKeyRoute
              apiKeyPending={apiKeyPending}
              apiKeyRoute={apiKeyRoute}
              apiKeyUrl={apiKeyUrl}
              name={name}
              offerApiKey={offerApiKey}
              submitError={submitError}
              submitting={submitting}
              onCancel={onReset}
              onSubmit={onSubmitApiKey}
            />
          ) : undefined
        }
        onConnect={onConnect}
        onOpenVerification={onOpenVerification}
        onReset={onReset}
      />
    );
  }

  if (state === 'success') {
    return (
      <SharedOAuthSuccessPanel
        enforcementHint={enforcementHint}
        messageKey={resolveStoredAlertMessageKey({
          hasPersistedEnabledModel,
          providerEnabled,
          takeover,
        })}
        onDone={onReset}
      />
    );
  }

  if (isLoading) return <Skeleton active paragraph={{ rows: 1 }} title={false} />;

  if (statusError) return <SharedOAuthStatusRetry onRetry={onRefreshStatus} />;

  return idleCard;
});

SharedOAuthConnectBody.displayName = 'AdminSharedOAuthConnectBody';

export default SharedOAuthConnectBody;
