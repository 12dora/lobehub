import debug from 'debug';
import type { getProviderOAuthGrantFlow } from 'model-bank/modelProviders';
import type { z } from 'zod';

import type { LobeChatDatabase } from '@/database/type';
import { extractOidcEmail } from '@/server/services/oauthDeviceFlow';

import type { adminAiProviderOAuthStatusOutputSchema } from '../../contracts/aiProviderOAuth';
import { providerCredentialKeys } from '../../services/aiCatalog/credentialAdapter';
import type {
  AiCatalogSecretManager,
  PlatformProviderKeyVaults,
} from '../../services/aiCatalog/secretManager';
import { readSharedOAuthReauthMarker } from '../../services/aiCatalog/sharedOAuthReauthMarker';
import {
  isOAuthAuthorizationExpiredError,
  refreshSharedOAuthVault,
} from '../../services/aiCatalog/sharedOAuthRefresh';
import { asVaultString, maskAccountId, resolveRenewalKind } from './aiProviderOAuthSupport.vault';

const log = debug('lobe-server:admin-ai-provider-oauth');

type AdminAiProviderOAuthStatusOutput = z.infer<typeof adminAiProviderOAuthStatusOutputSchema>;

export const refreshStatusVault = async ({
  db,
  keyVaults,
  provider,
  providerKey,
  secretManager,
}: {
  db: LobeChatDatabase;
  keyVaults: PlatformProviderKeyVaults;
  provider: {
    encryptedKeyVaults: string;
    id: string;
    secretFingerprint: string | null;
  };
  providerKey: string;
  secretManager: AiCatalogSecretManager;
}): Promise<{ expired: boolean; keyVaults: PlatformProviderKeyVaults }> => {
  let expired = false;
  let next = keyVaults;
  if (provider.secretFingerprint) {
    try {
      next = await refreshSharedOAuthVault({
        ciphertext: provider.encryptedKeyVaults,
        db,
        fingerprint: provider.secretFingerprint,
        keyVaults,
        providerKey,
        providerRowId: provider.id,
        secrets: secretManager,
      });
    } catch (error) {
      // Only a dead grant is actionable for the operator. Everything else (network, token
      // endpoint 5xx, lost lease) degrades to the stored values — the card still renders.
      if (isOAuthAuthorizationExpiredError(error)) expired = true;
      // Stable category + provider key only. This path is polled by any admin with
      // AI_PROVIDER_READ, and a refresh failure carries provider-controlled prose
      // (`error_description`) that must never be copied into logs.
      else log('status refresh for %s degraded to stored values', providerKey);
    }
  }
  return { expired, keyVaults: next };
};

/**
 * Presence + expiry + masked account only. Token material must never appear here —
 * the caller already decrypted; this only projects leaves the operator may see.
 */
export const projectSharedConnectionStatus = ({
  expired,
  flow,
  keyVaults,
  providerKey,
  secretConfigured,
}: {
  expired: boolean;
  flow: ReturnType<typeof getProviderOAuthGrantFlow>;
  keyVaults: PlatformProviderKeyVaults;
  providerKey: string;
  secretConfigured: boolean;
}): AdminAiProviderOAuthStatusOutput => {
  const accessToken = asVaultString(keyVaults.oauthAccessToken);
  const accountId = asVaultString(keyVaults.oauthAccountId);
  const expiresAt = asVaultString(keyVaults.oauthTokenExpiresAt);
  // Raw epoch-ms string, exactly like `expiresAt`: both mirror the vault leaf type, and
  // formatting belongs to the panel that renders them in the operator's locale.
  const lastRefreshAt = asVaultString(keyVaults.oauthLastRefreshAt);
  // Connections stored before the email leaf existed keep working: decode the claim from
  // the access token we already hold, then (for x.ai / Cursor) one network fetch.
  //
  // Gated on the credential SHAPE. Shared-account providers that allow
  // `oauthAccountEmail` (ChatGPT, ChatGPT Web, SuperGrok, Grok, Cursor) project it.
  const emailProjectable = providerCredentialKeys(providerKey).has('oauthAccountEmail');
  const accountEmail = emailProjectable
    ? (asVaultString(keyVaults.oauthAccountEmail) ??
      extractOidcEmail(undefined, accessToken) ??
      null)
    : null;

  const connected = !expired && Boolean(accessToken);
  const refreshCredential = asVaultString(keyVaults.oauthRefreshToken);
  /**
   * Terminal auth failures recorded by the refresh path or by a real execution through the
   * shared account. This is what closes the gap the operator kept hitting: a token string
   * sitting in the vault, unexpired, that chatgpt.com has already stopped accepting — the
   * refresh above is a no-op in that state, so presence alone said "已连接" while every
   * member's chat came back 需要重新授权.
   */
  const marker = readSharedOAuthReauthMarker(keyVaults);

  return {
    accountEmail,
    accountIdMasked: maskAccountId(accountId),
    // A pasted access token has no renewal credential at all: it dies at `expiresAt` and
    // only a manual reconnect brings it back. A web session counts — it mints fresh
    // access tokens exactly like an OAuth refresh token does.
    canRefresh: Boolean(refreshCredential),
    connected,
    expired,
    expiresAt: expiresAt ?? null,
    flow,
    // Null unless `needsReauth` — the pair is written and cleared as a unit.
    invalidAt: expired ? (marker.invalidAt ?? String(Date.now())) : marker.invalidAt,
    invalidReason: expired ? (marker.invalidReason ?? 'invalidGrant') : marker.invalidReason,
    // Stamped at connect and moved forward by every successful renewal (including the
    // one this query just ran), so an operator can tell a connection that is quietly
    // rolling over from one nothing has touched since it was made.
    lastRefreshAt: lastRefreshAt ?? null,
    /**
     * `expired` is this request's own observation (the refresh above threw `invalid_grant`);
     * the marker is what an EARLIER observation — from any instance, including a member's
     * failing chat — wrote down. Either one means the same thing to the operator, so they
     * are surfaced as one state instead of two badges nobody can tell apart.
     */
    needsReauth: expired || Boolean(marker.invalidAt),
    /**
     * Names the renewal path so the panel can say WHY the connection keeps working.
     * The stored label wins; connections made before the leaf existed are identified by
     * the credential's shape (a next-auth session JWE is unmistakable), and anything
     * else is the OAuth refresh token it can only be.
     */
    renewalKind: refreshCredential ? resolveRenewalKind(keyVaults, refreshCredential) : null,
    secretConfigured,
  };
};
