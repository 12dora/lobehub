import { isChatGPTWebSessionToken } from '@lobechat/utils/chatgptWebPaste';

import type { OAuthRenewalKind } from '@/server/services/oauthDeviceFlow';
import { parseOAuthRenewalKind } from '@/server/services/oauthDeviceFlow';

import { providerCredentialKeys } from '../../services/aiCatalog/credentialAdapter';
import type { ChatGPTWebConnection } from '../../services/chatgptWeb/oauthService';

/** Provider-agnostic shape of a freshly obtained shared connection. */
export interface SharedConnectionTokens {
  accessToken: string;
  accountId?: string;
  deviceId?: string;
  email?: string;
  /** Epoch millis. */
  expiresAt?: number;
  refreshToken?: string;
  /** How `refreshToken` must be spent; the closed union, never a free-form label. */
  renewalKind?: OAuthRenewalKind;
}

/**
 * Project a connection onto the provider's credential SHAPE.
 *
 * This used to be a chain of `input.id === ModelProvider.ChatGPT` conditionals, which
 * silently dropped every identity leaf of any other provider. Whether a leaf may be
 * stored is a property of the credential shape (`credentialAdapter` hard-rejects unknown
 * keys), so it is read from there.
 *
 * EVERY optional leaf moves as a UNIT with the credential it describes: a reconnect that
 * returns no email/account id must CLEAR the stored one, or the previous account's
 * identity would be displayed — and its account id sent — next to the new token.
 *
 * The refresh token is the sharpest case. Reconnecting with a PASTED ACCESS TOKEN yields
 * no refresh grant; keeping the previous one would leave the card claiming the connection
 * auto-renews and, at expiry, let the shared refresh redeem the OLD account's grant and
 * overwrite the new connection with a different account's credentials. So it is unset like
 * everything else the new tokens did not provide.
 */
export const buildSharedVault = (
  providerKey: string,
  tokens: SharedConnectionTokens,
): { clearedLeaves: string[]; vault: Record<string, string> } => {
  const allowed = providerCredentialKeys(providerKey);
  const vault: Record<string, string> = { oauthAccessToken: tokens.accessToken };
  const clearedLeaves: string[] = [];

  const put = (leaf: string, value: string | undefined) => {
    if (!allowed.has(leaf)) return;
    if (value) vault[leaf] = value;
    else clearedLeaves.push(leaf);
  };

  put('oauthRefreshToken', tokens.refreshToken);
  /**
   * Moves as a UNIT with the refresh token it labels: a reconnect that switches from a web
   * session to a PKCE grant (or the other way round) must not leave the previous kind
   * behind, or every later renewal would spend the new credential the wrong way.
   */
  put('oauthRenewalKind', tokens.refreshToken ? tokens.renewalKind : undefined);
  put('oauthTokenExpiresAt', tokens.expiresAt ? String(tokens.expiresAt) : undefined);
  put('oauthAccountId', tokens.accountId);
  put('oauthAccountEmail', tokens.email);
  put('oauthDeviceId', tokens.deviceId);
  /**
   * Refresh-lifecycle bookkeeping, mirroring the user path (`lambda/oauthDeviceFlow`).
   * Connect time is the keepalive anchor of a grant that has never been refreshed, so the
   * 3-day forced renewal is measured from here instead of leaving the credential without an
   * anchor. The paired error stamp is CLEARED in the same write: a reconnect must not
   * inherit the dead grant's backoff and sit out the first five minutes of its new life.
   */
  put('oauthLastRefreshAt', String(Date.now()));
  put('oauthLastRefreshErrorAt', undefined);
  /**
   * The reauth marker describes the credential that was just replaced, so it is cleared in the
   * same write — otherwise the card would keep demanding a reconnect the operator has already
   * performed. Both leaves move as a unit (see `sharedOAuthReauthMarker`).
   */
  put('oauthGrantInvalidAt', undefined);
  put('oauthGrantInvalidReason', undefined);

  return { clearedLeaves, vault };
};

export const toSharedTokens = (connection: ChatGPTWebConnection): SharedConnectionTokens => ({
  accessToken: connection.accessToken,
  ...(connection.accountId ? { accountId: connection.accountId } : {}),
  deviceId: connection.deviceId,
  ...(connection.email ? { email: connection.email } : {}),
  ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}),
  ...(connection.refreshToken ? { refreshToken: connection.refreshToken } : {}),
  ...(connection.renewalKind ? { renewalKind: connection.renewalKind } : {}),
});

/**
 * Which credential keeps the connection alive. Shape-sniffing is the fallback for
 * connections stored before `oauthRenewalKind` existed, and an unrecognised stored value is
 * treated as absent rather than echoed back — the contract's enum is the boundary, and
 * `parseOAuthRenewalKind` is the single validator the refresh path uses too.
 */
export const resolveRenewalKind = (
  keyVaults: Record<string, unknown>,
  refreshCredential: string,
): OAuthRenewalKind =>
  parseOAuthRenewalKind(keyVaults.oauthRenewalKind) ??
  (isChatGPTWebSessionToken(refreshCredential) ? 'web_session' : 'oauth');

/** Recognition affordance only — never enough material to reconstruct the account id. */
export const maskAccountId = (accountId: string | undefined): string | null =>
  accountId ? `${accountId.slice(0, 4)}…` : null;

/** Platform vaults hold string leaves; header maps and absent leaves are not projectable. */
export const asVaultString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
