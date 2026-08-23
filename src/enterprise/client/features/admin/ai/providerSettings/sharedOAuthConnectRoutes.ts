import {
  getProviderApiKeyUrl,
  getProviderPastedCredentialKind,
  isProviderAccessTokenPasteAllowed,
  isProviderWebSessionOnly,
} from 'model-bank/modelProviders';

/**
 * Which connect routes a provider actually has, read from the provider card rather than an id
 * list: this panel serves every rotating-refresh provider, and only the card knows.
 */
export const resolveSharedOAuthConnectRoutes = (providerId: string) => {
  const webSessionOnly = isProviderWebSessionOnly(providerId);
  /**
   * What the provider's paste route actually takes. `'apiKey'` (Cursor) is a dashboard key
   * the server exchanges and then renews from forever — a different object from the access
   * token `'accessToken'` providers accept, and it has to be labelled as one.
   */
  const pastedCredentialKind = getProviderPastedCredentialKind(providerId);
  /**
   * Whether the API-key route exists at all for this provider — read off the card, so it is
   * answerable BEFORE a flow envelope exists. That is the whole point: the durable connect
   * route used to be reachable only from the awaiting state, i.e. only by first firing a real
   * device-code request against the provider and then abandoning the browser login.
   */
  const offerApiKey =
    pastedCredentialKind === 'apiKey' && isProviderAccessTokenPasteAllowed(providerId);

  return {
    /** Where this provider's keys are created; the hint links it instead of describing it. */
    apiKeyUrl: getProviderApiKeyUrl(providerId),
    offerApiKey,
    webSessionOnly,
  };
};

/** The four things a just-stored shared account can mean to members, as i18n keys. */
export type StoredAlertMessageKey =
  | 'aiProviderSettings.sharedOAuth.success.providerOff'
  | 'aiProviderSettings.sharedOAuth.success.needsModels'
  | 'aiProviderSettings.sharedOAuth.success.published'
  | 'aiProviderSettings.sharedOAuth.success.pendingTakeover';

export interface ResolveStoredAlertMessageKeyInput {
  hasPersistedEnabledModel: boolean;
  providerEnabled: boolean;
  takeover: boolean;
}

/**
 * A `success` poll means the account was applied unconditionally — the CREDENTIAL is
 * stored and published. That alone promises nothing to members, so every claim below is
 * read from real state instead, in the order an operator would have to fix them:
 *   - provider off (only first connect enables the row; a reconnect after a disconnect
 *     deliberately leaves it off) ⇒ turn it on;
 *   - no persisted enabled model ⇒ turn one on;
 *   - no platform AI takeover ⇒ members are still on their own accounts;
 *   - otherwise, and only then, the provider really is on for members.
 */
export const resolveStoredAlertMessageKey = ({
  hasPersistedEnabledModel,
  providerEnabled,
  takeover,
}: ResolveStoredAlertMessageKeyInput): StoredAlertMessageKey =>
  !providerEnabled
    ? 'aiProviderSettings.sharedOAuth.success.providerOff'
    : !hasPersistedEnabledModel
      ? 'aiProviderSettings.sharedOAuth.success.needsModels'
      : // Fails closed, unlike the additive hint: "on for members" needs a POSITIVE
        // takeover reading, never merely the absence of one.
        takeover
        ? 'aiProviderSettings.sharedOAuth.success.published'
        : 'aiProviderSettings.sharedOAuth.success.pendingTakeover';
