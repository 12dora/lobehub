import { randomBytes, randomUUID } from 'node:crypto';

import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import {
  buildClientHintHeaders,
  buildFetchMetadataHeaders,
  DEFAULT_BROWSER_DEVICE_PROFILE,
  PRIORITY_XHR,
  userAgentHeaders,
} from '@lobechat/model-runtime/browserProfile';
import { isChatGPTWebSessionToken } from '@lobechat/utils/chatgptWebPaste';

import type {
  DeviceCodeResponse,
  OAuthRefreshOptions,
  TokenResponse,
} from '@/server/services/oauthDeviceFlow';
import { OAuthInvalidGrantError } from '@/server/services/oauthDeviceFlow';
import type { OAuthDeviceFlowConfig } from '@/types/aiProvider';

import {
  invalidateChatGPTWebBrowserSession,
  rotateChatGPTWebBrowserSession,
} from './browserSession';
import { ChatGPTWebOAuthError } from './oauthErrors';
import type { ChatGPTWebConnection } from './oauthService.identity';
import { ChatGPTWebOAuthSessionOps } from './oauthService.session';
import type { ChatGPTWebPasteEnvelope } from './pasteEnvelope';
import {
  base64url,
  CHATGPT_WEB_ENVELOPE_TTL_MS,
  createDottedState,
  createPkcePair,
  parseCallbackInput,
  parsePasteEnvelope,
} from './pasteEnvelope';
import { deleteCookieJar, getChatGPTWebFetch } from './transport';

export {
  buildChatGPTWebBrowserSessionAccountId,
  type ChatGPTWebBrowserSessionOwner,
} from './browserSession';
export { ChatGPTWebOAuthError, type ChatGPTWebOAuthErrorCode } from './oauthErrors';
export {
  type ChatGPTWebConnection,
  type ChatGPTWebRenewalKind,
  extractChatGPTWebEmail,
  sessionHeaders,
} from './oauthService.identity';
export {
  CHATGPT_WEB_ENVELOPE_TTL_MS,
  type ChatGPTWebPasteEnvelope,
  createPkcePair,
  parseCallbackInput,
  type ParsedCallbackInput,
  parsePasteEnvelope,
} from './pasteEnvelope';

/**
 * Drop the process-local Netscape jar for a ChatGPT Web connection.
 * Best-effort: disconnect / revoke must not fail because the file is already gone.
 */
export const wipeChatGPTWebCookieJar = (deviceId: string | undefined, accountId?: string): void => {
  if (deviceId) {
    try {
      deleteCookieJar(deviceId);
    } catch {
      // unlink already swallows ENOENT; this covers unexpected fs errors.
    }
  }
  if (accountId) {
    try {
      invalidateChatGPTWebBrowserSession(accountId);
    } catch {
      // Best-effort: disconnect must not fail because the context is already gone.
    }
  }
};

/**
 * Device id for a ChatGPT Web connect.
 *
 * `webSessionOnly` pastes must NOT inherit the random authorization-envelope id — that
 * id was minted for a different product's authorize URL. Prefer the pasted Chrome
 * device, then the already-persisted vault id (reconnect with the same browser), and
 * only then let `connectWithSession` generate one and persist it.
 */
export const resolveChatGPTWebConnectDeviceId = ({
  envelopeDeviceId,
  existingDeviceId,
  pastedDeviceId,
  webSessionOnly,
}: {
  envelopeDeviceId: string;
  existingDeviceId?: string;
  pastedDeviceId?: string;
  webSessionOnly: boolean;
}): string | undefined => {
  if (pastedDeviceId) return pastedDeviceId;
  if (webSessionOnly) return existingDeviceId;
  return existingDeviceId ?? envelopeDeviceId;
};

/**
 * ChatGPT Web connect flow: OAuth authorization code + PKCE where the user signs in in
 * their OWN browser and pastes the callback URL back. The redirect URI belongs to
 * OpenAI (`platform.openai.com/auth/callback`) and cannot be repointed at this
 * deployment, so there is no listener — the pasted URL IS the redirect.
 *
 * Nothing about the pending authorization is persisted server-side: the PKCE verifier,
 * the CSRF `state` and the generated device id travel in a client-held envelope that
 * the router hands back on the exchange call.
 */

const AUTH0_CLIENT = 'eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9';

const TOKEN_REQUEST_TIMEOUT_MS = 60_000;
/**
 * Refresh deadline. MUST stay below the shared refresh lease (`LEASE_SECONDS = 30` in
 * `aiCatalog/sharedOAuthRefresh.ts`) with room for the persist that follows it: once the
 * lease expires another instance may refresh with the SAME rotating token, which is the
 * reuse that revokes the grant family for every user of the shared account at once.
 */
const REFRESH_REQUEST_TIMEOUT_MS = 20_000;

export interface ChatGPTWebOAuthServiceOptions {
  /** auth.openai.com is reachable from Node directly — no impersonation needed. */
  authFetch?: typeof fetch;
  /** Installation-wide synthetic browser identity shared with runtime traffic. */
  browserProfile?: BrowserDeviceProfile;
  /**
   * Stable AIHub connection handle for the Browser Session Context. Never a
   * device id — see {@link buildChatGPTWebBrowserSessionAccountId}.
   */
  browserSessionAccountId?: string;
  /** chatgpt.com requires the browser-fingerprinted transport. */
  transportFetch?: typeof fetch;
}

/**
 * The exact header set the web client sends to the token endpoint (E2 §1.4: auth0's
 * `common_headers` with the platform origin/referer on top). auth.openai.com serves this
 * endpoint to the platform SPA only, and an incomplete fetch-metadata set is exactly what
 * a bot filter looks at — so it is reproduced rather than trimmed to "what matters".
 */
const lowercaseHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

const authHeaders = (browserProfile: BrowserDeviceProfile): Record<string, string> => ({
  'accept': 'application/json',
  ...lowercaseHeaders(userAgentHeaders(browserProfile)),
  'auth0-client': AUTH0_CLIENT,
  'cache-control': 'no-cache',
  'content-type': 'application/json',
  'origin': 'https://platform.openai.com',
  'priority': PRIORITY_XHR,
  'referer': 'https://platform.openai.com/',
  ...lowercaseHeaders(buildClientHintHeaders(browserProfile, { entropy: 'low' })),
  ...lowercaseHeaders(buildFetchMetadataHeaders('xhr')),
});

export class ChatGPTWebOAuthService extends ChatGPTWebOAuthSessionOps {
  private readonly authFetch: typeof fetch;
  protected readonly browserProfile: BrowserDeviceProfile;
  private readonly transportFetchOverride?: typeof fetch;

  constructor(options: ChatGPTWebOAuthServiceOptions = {}) {
    super();
    this.authFetch = options.authFetch ?? ((...args) => globalThis.fetch(...args));
    this.browserProfile = options.browserProfile ?? DEFAULT_BROWSER_DEVICE_PROFILE;
    this.browserSessionAccountId = options.browserSessionAccountId;
    this.transportFetchOverride = options.transportFetch;
  }

  /** A successful connect starts a new page session; refresh must not. */
  private rotatePageSessionAfterConnect(deviceId: string): void {
    if (!this.browserSessionAccountId) return;
    const next = rotateChatGPTWebBrowserSession({
      accountId: this.browserSessionAccountId,
      browserProfile: this.browserProfile,
      deviceId,
    });
    // Connect is not a chat turn; do not pin inFlight on the new generation.
    next?.release?.();
  }

  /**
   * Rotate only after persist+commit. Mint/verify no longer promote, so a
   * persist failure cannot leave a rotated live context beside the old vault.
   */
  protected override afterVerifiedSessionCommitted(deviceId: string): void {
    this.rotatePageSessionAfterConnect(deviceId);
  }

  /** Resolved lazily so a deployment without the binary still boots. */
  protected get transportFetch(): typeof fetch {
    return (
      this.transportFetchOverride ??
      getChatGPTWebFetch(undefined, { impersonate: this.browserProfile.impersonateProfile })
    );
  }

  /**
   * Build the authorize URL the user opens in their own browser. Returns the paste
   * envelope as `deviceCode`; there is no user code and nothing to poll.
   */
  override async initiateDeviceCode(config: OAuthDeviceFlowConfig): Promise<DeviceCodeResponse> {
    const authorizationCode = config.authorizationCode;
    if (!authorizationCode?.authorizeEndpoint || !authorizationCode.redirectUri) {
      throw new Error('ChatGPT Web authorization endpoints are not configured');
    }

    const { challenge, verifier } = createPkcePair();
    const state = createDottedState();
    const nonce = base64url(randomBytes(32));
    const deviceId = randomUUID();

    const url = new URL(authorizationCode.authorizeEndpoint);
    // Order mirrors the real web client's request; the server accepts any order but
    // matching it keeps the request indistinguishable from a browser's.
    const params: [string, string][] = [
      ['issuer', new URL(authorizationCode.authorizeEndpoint).origin],
      ['client_id', config.clientId],
      ...(authorizationCode.audience
        ? [['audience', authorizationCode.audience] as [string, string]]
        : []),
      ['redirect_uri', authorizationCode.redirectUri],
      ['device_id', deviceId],
      ['screen_hint', 'login_or_signup'],
      ['max_age', '0'],
      ['scope', config.scopes.join(' ')],
      ['response_type', 'code'],
      ['response_mode', 'query'],
      ['state', state],
      ['nonce', nonce],
      ['code_challenge', challenge],
      ['code_challenge_method', 'S256'],
      ['auth0Client', AUTH0_CLIENT],
    ];
    for (const [key, value] of params) url.searchParams.set(key, value);

    const envelope: ChatGPTWebPasteEnvelope = {
      createdAt: Date.now(),
      deviceId,
      state,
      v: 1,
      verifier,
    };

    return {
      deviceCode: JSON.stringify(envelope),
      expiresIn: CHATGPT_WEB_ENVELOPE_TTL_MS / 1000,
      // No polling: the flow advances only when the user pastes the callback back.
      interval: 0,
      userCode: '',
      verificationUri: url.toString(),
      verificationUriComplete: url.toString(),
    };
  }

  /**
   * Exchange the pasted callback (or bare code) for tokens.
   * Every failure is a stable {@link ChatGPTWebOAuthError} code — provider prose never
   * crosses the boundary, and neither the code nor the tokens are ever logged.
   */
  async exchangeCallback(
    config: OAuthDeviceFlowConfig,
    deviceCode: string,
    callbackInput: string,
  ): Promise<ChatGPTWebConnection> {
    const envelope = parsePasteEnvelope(deviceCode);
    const { code, fromUrl, state } = parseCallbackInput(callbackInput);

    // A pasted redirect URL always echoes the state back; one without it has been edited
    // or fabricated, so "no state" is a mismatch rather than an unchecked input.
    if (fromUrl && state === undefined) throw new ChatGPTWebOAuthError('state_mismatch');
    if (state !== undefined && state !== envelope.state) {
      throw new ChatGPTWebOAuthError('state_mismatch');
    }

    const endpoint = config.tokenExchangeEndpoint;
    const redirectUri = config.authorizationCode?.redirectUri;
    if (!endpoint || !redirectUri) {
      throw new ChatGPTWebOAuthError('exchange_failed', 'token exchange is not configured');
    }

    let response: Response;
    try {
      response = await this.authFetch(endpoint, {
        body: JSON.stringify({
          client_id: config.clientId,
          code,
          code_verifier: envelope.verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
        headers: authHeaders(this.browserProfile),
        method: 'POST',
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ChatGPTWebOAuthError('exchange_failed');
    }

    const tokens = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      id_token?: string;
      refresh_token?: string;
    };

    if (!response.ok || !tokens.access_token) {
      throw new ChatGPTWebOAuthError('exchange_failed');
    }

    /**
     * A code exchange without a refresh token is NOT a success: it would store a
     * connection that silently dies at the access token's `exp` (~10 days) with no way to
     * renew it, while the UI — which reads `canRefresh` from the stored leaves — would
     * have reported the connection as self-renewing until the moment it broke. Only the
     * access-token paste path is allowed to produce a non-renewable connection, because
     * there the user explicitly chose it.
     */
    if (!tokens.refresh_token) {
      throw new ChatGPTWebOAuthError(
        'exchange_failed',
        'no refresh_token — scope offline_access missing or code already used',
      );
    }

    const connection = await this.buildConnection({
      accessToken: tokens.access_token,
      deviceId: envelope.deviceId,
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
    });
    this.rotatePageSessionAfterConnect(connection.deviceId);
    return connection;
  }

  /**
   * Refresh with the wire the provider expects (E2 §1.5): form-encoded, the platform
   * User-Agent, and a hard bound. The inherited implementation is otherwise identical, but
   * it sends no UA and is unbounded by default — a hung token endpoint would pin the shared
   * refresh lease for as long as the socket stayed open.
   *
   * The bound is {@link REFRESH_REQUEST_TIMEOUT_MS}, deliberately BELOW the shared refresh
   * lease (`sharedOAuthRefresh.ts` `LEASE_SECONDS`): a call that outlived the lease would
   * let a second instance present the same rotating refresh token, and providers answer
   * that reuse by revoking the entire grant family.
   */
  override async refreshAccessToken(
    config: OAuthDeviceFlowConfig,
    refreshToken: string,
    options?: OAuthRefreshOptions,
  ): Promise<TokenResponse> {
    const deadline = AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS);
    // The caller's own bound never widens ours; whichever fires first wins.
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

    /**
     * Which credential is in the leaf. The stored `oauthRenewalKind` is authoritative (the
     * caller has already validated it — an unrecognised label arrives as `undefined`); the
     * shape sniff only covers connections stored before that leaf existed (and costs
     * nothing, since an OAuth refresh token is never a five-segment `dir` JWE).
     */
    const renewalKind =
      options?.renewalKind ??
      (isChatGPTWebSessionToken(refreshToken) ? 'web_session' : ('oauth' as const));

    if (renewalKind === 'web_session') {
      return this.refreshFromWebSession(refreshToken, signal, options);
    }

    return this.refreshFromOAuthGrant(config, refreshToken, signal);
  }

  private async refreshFromOAuthGrant(
    config: OAuthDeviceFlowConfig,
    refreshToken: string,
    signal: AbortSignal,
  ): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.authFetch(config.tokenEndpoint, {
        body: new URLSearchParams({
          client_id: config.clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        headers: {
          ...authHeaders(this.browserProfile),
          'content-type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
        signal,
      });
    } catch (error) {
      // Never provider prose: the message is composed here from the error class only.
      // The cause carries the transport failure for the server-side log, not the client.
      throw new Error(
        `Failed to refresh access token: ${error instanceof Error ? error.name : 'network error'}`,
        { cause: error },
      );
    }

    const data = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
      expires_in?: number;
      id_token?: string;
      refresh_token?: string;
      scope?: string;
      token_type?: string;
    };

    if (!response.ok || data.error) {
      // invalid_grant = refresh token expired / revoked / already consumed. The caller
      // re-reads the persisted vault on this signal before declaring the grant dead.
      if (data.error === 'invalid_grant') {
        throw new OAuthInvalidGrantError(data.error_description || 'invalid_grant');
      }
      throw new Error(
        `Failed to refresh access token: ${response.status} ${data.error ?? ''}`.trim(),
      );
    }

    if (!data.access_token) throw new Error('Unexpected response from token endpoint');

    return {
      accessToken: data.access_token,
      ...(data.expires_in ? { expiresIn: data.expires_in } : {}),
      // Rotation is optional per RFC 6749 — keep the old token when the provider does not
      // rotate, or the next refresh would have nothing to present.
      refreshToken: data.refresh_token || refreshToken,
      ...(data.scope ? { scope: data.scope } : {}),
      tokenType: data.token_type || 'bearer',
    };
  }
}
