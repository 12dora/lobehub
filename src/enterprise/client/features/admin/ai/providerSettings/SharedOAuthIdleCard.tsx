'use client';

import { Alert, Flexbox } from '@lobehub/ui';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { SharedOAuthConnectionStatus } from './deriveConnectedCardModel';
import SharedOAuthApiKeyRoute from './SharedOAuthApiKeyRoute';
import SharedOAuthConnectedCard from './SharedOAuthConnectedCard';
import type {
  SharedOAuthFlowError,
  SharedOAuthFlowState,
  SharedOAuthPasteError,
} from './useAdminSharedOAuthFlow';

interface SharedOAuthIdleCardProps {
  apiKeyPending: boolean;
  apiKeyRoute: boolean;
  apiKeyUrl?: string;
  disconnecting: boolean;
  enforcementHint: ReactNode;
  error?: SharedOAuthFlowError;
  name: string;
  needsReauth: boolean;
  offerApiKey: boolean;
  onConnect: () => void;
  onConnectWithSession: () => void;
  onDisconnect: () => void;
  onReset: () => void;
  onSubmitApiKey: (apiKey: string) => void;
  reauthDetail: string;
  state: SharedOAuthFlowState;
  status?: SharedOAuthConnectionStatus;
  submitError?: SharedOAuthPasteError;
  submitting: boolean;
  webSessionOnly: boolean;
}

/**
 * The idle card, with the API-key route's own failure surface above it.
 *
 * ONE shape, whichever half is showing: a failed envelope must not swap the card for a
 * different tree, or the key form is torn down and rebuilt — taking the key the operator
 * has just typed with it. The flow's own words for the flow's own failure; a rejected key
 * is reported inside the form instead.
 */
const SharedOAuthIdleCard = memo<SharedOAuthIdleCardProps>(
  ({
    apiKeyPending,
    apiKeyRoute,
    apiKeyUrl,
    disconnecting,
    enforcementHint,
    error,
    name,
    needsReauth,
    offerApiKey,
    onConnect,
    onConnectWithSession,
    onDisconnect,
    onReset,
    onSubmitApiKey,
    reauthDetail,
    state,
    status,
    submitError,
    submitting,
    webSessionOnly,
  }) => {
    const { t } = useTranslation('admin');

    const apiKeyForm = (
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
    );

    return (
      <Flexbox gap={12}>
        {apiKeyRoute && state === 'error' && (
          <Alert
            message={t(`aiProviderSettings.sharedOAuth.error.${error ?? 'authError'}` as never)}
            type={'error'}
          />
        )}
        <SharedOAuthConnectedCard
          apiKeyForm={apiKeyForm}
          // No competing run while the API-key route holds an envelope in flight: a browser login
          // started here would retire the one the exchange is about to use.
          connectDisabled={apiKeyPending}
          disconnecting={disconnecting}
          enforcementHint={enforcementHint}
          name={name}
          needsReauth={needsReauth}
          reauthDetail={reauthDetail}
          status={status}
          webSessionOnly={webSessionOnly}
          onConnect={onConnect}
          onConnectWithSession={onConnectWithSession}
          onDisconnect={onDisconnect}
        />
      </Flexbox>
    );
  },
);

SharedOAuthIdleCard.displayName = 'AdminSharedOAuthIdleCard';

export default SharedOAuthIdleCard;
