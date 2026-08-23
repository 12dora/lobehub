'use client';

import { memo } from 'react';

import SharedOAuthApiKeyForm from './SharedOAuthApiKeyForm';
import type { SharedOAuthPasteError } from './useAdminSharedOAuthFlow';

interface SharedOAuthApiKeyRouteProps {
  /** The API-key route is mid-round-trip: envelope request or exchange. */
  apiKeyPending: boolean;
  apiKeyRoute: boolean;
  apiKeyUrl?: string;
  name: string;
  offerApiKey: boolean;
  onCancel: () => void;
  onSubmit: (apiKey: string) => void;
  submitError?: SharedOAuthPasteError;
  submitting: boolean;
}

/**
 * The API-key box, wherever it is offered. `defaultOpen` while that route is running, so a
 * failed exchange lands next to the field that produced it instead of behind a closed
 * disclosure.
 */
const SharedOAuthApiKeyRoute = memo<SharedOAuthApiKeyRouteProps>(
  ({
    apiKeyPending,
    apiKeyRoute,
    apiKeyUrl,
    name,
    offerApiKey,
    onCancel,
    onSubmit,
    submitError,
    submitting,
  }) =>
    offerApiKey ? (
      <SharedOAuthApiKeyForm
        apiKeyUrl={apiKeyUrl}
        defaultOpen={apiKeyRoute}
        name={name}
        // ONLY a rejected exchange. A refused envelope never judged the key, and saying
        // "check the key" about a network failure sends the operator to rewrite a good one.
        submitFailed={Boolean(submitError)}
        submitting={apiKeyPending || submitting}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    ) : null,
);

SharedOAuthApiKeyRoute.displayName = 'AdminSharedOAuthApiKeyRoute';

export default SharedOAuthApiKeyRoute;
