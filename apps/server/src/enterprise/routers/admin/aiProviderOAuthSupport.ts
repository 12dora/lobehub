import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import { isChatGPTWebSessionToken } from '@lobechat/utils/chatgptWebPaste';
import debug from 'debug';
import {
  DEFAULT_MODEL_PROVIDER_LIST,
  getProviderOAuthGrantFlow,
  isProviderAccessTokenPasteAllowed,
  isProviderWebSessionOnly,
  isRotatingRefreshOAuthProvider,
} from 'model-bank/modelProviders';
import type { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { LobeChatDatabase } from '@/database/type';
import type { OAuthRenewalKind } from '@/server/services/oauthDeviceFlow';
import {
  extractOidcEmail,
  parseJwtExpiry,
  parseOAuthRenewalKind,
} from '@/server/services/oauthDeviceFlow';
import { getOAuthService } from '@/server/services/oauthDeviceFlow/providers/githubCopilot';
import type { OAuthDeviceFlowConfig } from '@/types/aiProvider';

import type {
  adminAiProviderOAuthPollInputSchema,
  adminAiProviderOAuthPollOutputSchema,
  adminAiProviderOAuthStatusOutputSchema,
} from '../../contracts/aiProviderOAuth';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import type { AiCatalogAdminService } from '../../services/aiCatalog/adminService';
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
import type { ChatGPTWebConnection } from '../../services/chatgptWeb/oauthService';
import {
  ChatGPTWebOAuthError,
  ChatGPTWebOAuthService,
  parsePasteEnvelope,
} from '../../services/chatgptWeb/oauthService';
import type {
  AppendPlatformAuditLogParams,
  PlatformAuditService,
} from '../../services/platformAudit';

const log = debug('lobe-server:admin-ai-provider-oauth');

type AdminAiProviderOAuthPollInput = z.infer<typeof adminAiProviderOAuthPollInputSchema>;
type AdminAiProviderOAuthPollOutput = z.infer<typeof adminAiProviderOAuthPollOutputSchema>;
type AdminAiProviderOAuthStatusOutput = z.infer<typeof adminAiProviderOAuthStatusOutputSchema>;
type SharedProviderDetail = Awaited<ReturnType<AiCatalogAdminService['getDetail']>>;

export interface RotatingOAuthProviderCard {
  /** Builtin default probe model, seeded so admin connectivity check works on first connect. */
  checkModel?: string;
  config: OAuthDeviceFlowConfig;
  description?: string;
  name: string;
  settings: Record<string, unknown>;
}

/**
 * Resolve the builtin card of a provider whose device flow issues ROTATING refresh
 * tokens. Only these providers may hold a shared platform account: an API-key style
 * credential is never valid for them, and whoever stores the token owns its refresh
 * lifecycle. Everything else (including GitHub Copilot) is rejected here.
 */
export const resolveRotatingOAuthCard = (providerKey: string): RotatingOAuthProviderCard => {
  const card = DEFAULT_MODEL_PROVIDER_LIST.find((provider) => provider.id === providerKey);
  const config = card?.settings?.oauthDeviceFlow;

  if (!card || !config || !isRotatingRefreshOAuthProvider(providerKey)) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }

  return {
    checkModel: card.checkModel,
    config,
    description: card.description,
    name: card.name,
    settings: (card.settings ?? {}) as Record<string, unknown>,
  };
};

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

/**
 * Reason recorded on the reauth denial of the initiate step. The contract carries no
 * operator reason there (nothing is persisted), so a server constant is used — it can
 * never contain secret material.
 */
export const INITIATE_REAUTH_REASON =
  'Request a device authorization code for a shared provider account.';

/**
 * The device grant is single-use and every branch below reaches the shared platform
 * credential, so both procedures require the union of the create and update branches.
 * Create-vs-update is decided by server state (does the platform row exist yet), not by
 * client input, and an operator who may open the flow must be able to finish it.
 */
export const sharedAccountPermissions = [
  PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE,
  PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
  PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH,
] as const;

/**
 * Withdrawing the shared account only ever UPDATES an existing row and publishes the
 * result — it can never create one. AI_PROVIDER_CREATE is deliberately NOT required:
 * gating the withdrawal of a live shared credential behind a permission the operation
 * does not use would leave an operator unable to stop it. Nothing is deleted either
 * (the provider row survives), so AI_PROVIDER_DELETE is equally wrong.
 */
export const disconnectPermissions = [
  PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
  PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH,
] as const;

export const auditProvider = (
  audit: PlatformAuditService,
  params: Omit<AppendPlatformAuditLogParams, 'targetType'>,
) => audit.append({ ...params, targetType: 'provider' });

export const acquireSharedConnectionTokens = async ({
  actorUserId,
  audit,
  browserProfile,
  card,
  input,
  targetId,
}: {
  actorUserId: string;
  audit: PlatformAuditService;
  browserProfile?: BrowserDeviceProfile;
  card: RotatingOAuthProviderCard;
  input: AdminAiProviderOAuthPollInput;
  targetId: string;
}): Promise<
  | { kind: 'result'; result: AdminAiProviderOAuthPollOutput }
  | { kind: 'tokens'; tokens: SharedConnectionTokens }
> => {
  const unfinished = { error: null, revision: null, stored: false };
  const oauthService = getOAuthService(input.id, browserProfile ? { browserProfile } : undefined);
  let connectionTokens: SharedConnectionTokens;

  if (getProviderOAuthGrantFlow(input.id) === 'authorization_code_paste') {
    if (!(oauthService instanceof ChatGPTWebOAuthService)) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    // Nothing pasted yet: the operator has not finished signing in. No network work,
    // no audit row — the client may poll this the same way it polls a device code.
    if (!input.callbackUrl && !input.accessToken && !input.sessionToken) {
      return { kind: 'result', result: { ...unfinished, status: 'pending' as const } };
    }
    /**
     * A web-session-only provider connects through the pasted chatgpt.com session and
     * nothing else: its authorization page asks for the platform API audience and lands
     * on platform.openai.com, which is NOT the subscription this provider serves — a
     * grant redeemed there can be stored and still fail every conversation. The UI no
     * longer offers it; this refuses it for an older client that still would.
     *
     * Only the code exchange is refused. Connections already stored with
     * `oauthRenewalKind: 'oauth'` keep renewing through `refreshAccessToken`.
     */
    if (input.callbackUrl && isProviderWebSessionOnly(input.id)) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    // One gate for BOTH pasted-credential kinds: whether an operator may hand this
    // provider a credential out of band is one decision, not two.
    if ((input.accessToken || input.sessionToken) && !isProviderAccessTokenPasteAllowed(input.id)) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        httpCode: 'PRECONDITION_FAILED',
      });
    }

    try {
      // Both branches REQUIRE a live envelope: it carries the PKCE verifier for the
      // code exchange and the device id the authorize call was made with. A malformed
      // or stale one is reported (`invalid_callback` / `expired`) rather than silently
      // minting a fresh device id, which would break the sentinel handshake the stored
      // `oai-device-id` is supposed to keep stable.
      const envelope = parsePasteEnvelope(input.deviceCode);
      // Callback URL → PKCE exchange; web session → the renewable paste; access token →
      // the non-renewable fallback. Checked in that order so a paste carrying both a
      // session and a token stores the one that can renew itself.
      const connection = input.callbackUrl
        ? await oauthService.exchangeCallback(card.config, input.deviceCode, input.callbackUrl)
        : input.sessionToken
          ? await oauthService.connectWithSession(input.sessionToken, envelope.deviceId)
          : await oauthService.verifyAccessToken(input.accessToken!, envelope.deviceId);
      connectionTokens = toSharedTokens(connection);
    } catch (error) {
      // Operator-fixable outcomes (bad paste, stale envelope, rejected exchange) are
      // reported with a stable code — the pasted callback carries a live authorization
      // code and must never be audited or logged.
      if (error instanceof ChatGPTWebOAuthError) {
        await auditProvider(audit, {
          action: 'admin.aiProviderOAuth.pollAuthStatus',
          actorUserId,
          afterDiff: { error: error.code, providerKey: input.id },
          result: 'failure',
          targetId,
        });
        return {
          kind: 'result',
          result: { ...unfinished, error: error.code, status: 'error' as const },
        };
      }
      await auditProvider(audit, {
        action: 'admin.aiProviderOAuth.pollAuthStatus',
        actorUserId,
        afterDiff: { error: 'device_token_exchange_failed', providerKey: input.id },
        result: 'failure',
        targetId,
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        httpCode: 'PRECONDITION_FAILED',
      });
    }
  } else {
    let pollResult;
    try {
      if (input.accessToken) {
        if (!isProviderAccessTokenPasteAllowed(input.id)) {
          return throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
            httpCode: 'PRECONDITION_FAILED',
          });
        }
        pollResult = await oauthService.exchangePastedCredential(card.config, input.accessToken);
      } else {
        pollResult = await oauthService.pollForToken(card.config, input.deviceCode);
      }
    } catch {
      await auditProvider(audit, {
        action: 'admin.aiProviderOAuth.pollAuthStatus',
        actorUserId,
        // Provider prose may echo request material — only a stable code is stored.
        afterDiff: { error: 'device_token_exchange_failed', providerKey: input.id },
        result: 'failure',
        targetId,
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        httpCode: 'PRECONDITION_FAILED',
      });
    }

    if (pollResult.status !== 'success' || !pollResult.tokens) {
      return { kind: 'result', result: { ...unfinished, status: pollResult.status } };
    }

    const tokens = pollResult.tokens;
    // Expiry: prefer the explicit expires_in, fall back to the JWT exp claim —
    // some providers (e.g. xAI) don't always return expires_in.
    const expiresAt = tokens.expiresIn
      ? Date.now() + tokens.expiresIn * 1000
      : parseJwtExpiry(tokens.accessToken);
    connectionTokens = {
      accessToken: tokens.accessToken,
      ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
      ...(tokens.email ? { email: tokens.email } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.renewalKind ? { renewalKind: tokens.renewalKind } : {}),
    };
  }

  return { kind: 'tokens', tokens: connectionTokens };
};

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

export const applySharedConnectionVault = ({
  card,
  clearedIdentityLeaves,
  detail,
  providerKey,
  reason,
  service,
  userId,
  vault,
}: {
  card: RotatingOAuthProviderCard;
  clearedIdentityLeaves: string[];
  detail: SharedProviderDetail | undefined;
  providerKey: string;
  reason: string;
  service: AiCatalogAdminService;
  userId: string;
  vault: Record<string, string>;
}) =>
  detail
    ? service.applyProviderImmediate(userId, {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: detail.draft.id,
        mode: 'update',
        reason,
        secret: {
          operation: 'merge',
          ...(clearedIdentityLeaves.length > 0 ? { unset: clearedIdentityLeaves } : {}),
          value: vault,
        },
      })
    : service.applyProviderImmediate(userId, {
        // Without a check model the admin connectivity probe cannot run at all; the
        // builtin card already names the right default.
        checkModel: card.checkModel ?? null,
        description: card.description,
        displayName: card.name,
        // Connecting a shared account IS the activation intent, and the row is created
        // here for the first time — so first connect lands enabled and live. The update
        // branch above deliberately omits `enabled`: a reconnect must never re-enable a
        // provider the admin turned off on purpose.
        enabled: true,
        mode: 'create',
        providerKey,
        reason,
        secret: { operation: 'replace', value: vault },
        settings: card.settings,
        source: 'builtin',
      });
