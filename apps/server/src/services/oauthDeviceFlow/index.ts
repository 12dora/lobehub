import { type OAuthDeviceFlowConfig } from '@/types/aiProvider';

export interface DeviceCodeResponse {
  deviceCode: string;
  expiresIn: number;
  interval: number;
  userCode: string;
  verificationUri: string;
  /**
   * Optional verification URI with the user_code already embedded (RFC 8628
   * §3.3.1), so the user doesn't need to type the code manually.
   */
  verificationUriComplete?: string;
}

export interface TokenResponse {
  accessToken: string;
  accountId?: string;
  /** Human identity of the connected account (OIDC `email`, else `preferred_username`). */
  email?: string;
  expiresIn?: number;
  refreshToken?: string;
  scope?: string;
  tokenType: string;
}

export type PollStatus = 'pending' | 'success' | 'expired' | 'denied' | 'slow_down';

export interface PollResult {
  status: PollStatus;
  tokens?: TokenResponse;
}

/**
 * Thrown by `refreshAccessToken` when the authorization server rejects the
 * refresh_token as invalid/expired/already-consumed (`invalid_grant`).
 * Callers use this signal to re-read persisted credentials (another instance
 * may have rotated the token) before treating the grant as truly dead.
 */
export class OAuthInvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthInvalidGrantError';
  }
}

/**
 * Read a numeric claim (seconds) from a JWT access token as a ms timestamp, WITHOUT
 * verifying the signature. Only used to schedule refreshes — never for trust decisions.
 * Returns undefined for opaque / non-JWT tokens.
 */
const parseJwtNumericClaim = (
  token: string | undefined,
  claim: 'exp' | 'iat',
): number | undefined => {
  if (!token) return undefined;

  const parts = token.split('.');
  if (parts.length < 2) return undefined;

  try {
    const payload = Buffer.from(parts[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    const claims = JSON.parse(payload.toString('utf8'));

    if (typeof claims?.[claim] !== 'number') return undefined;

    return claims[claim] * 1000;
  } catch {
    return undefined;
  }
};

/**
 * Parse the `exp` claim (ms timestamp) from a JWT access token. Only used to decide when
 * to proactively refresh. Returns undefined for opaque / non-JWT tokens.
 */
export const parseJwtExpiry = (token: string | undefined): number | undefined =>
  parseJwtNumericClaim(token, 'exp');

/**
 * Parse the `iat` (issued-at) claim as a ms timestamp. Used as the keepalive anchor when
 * a credential has no recorded refresh yet: a token minted at connect time dates the
 * grant just as well as a refresh stamp would.
 */
export const parseJwtIssuedAt = (token: string | undefined): number | undefined =>
  parseJwtNumericClaim(token, 'iat');

/**
 * Which credential the `oauthRefreshToken` vault leaf actually holds, for providers that can
 * renew in more than one way.
 * - `oauth`: an OAuth refresh token (RFC 6749 §6), spent at the token endpoint.
 * - `web_session`: the chatgpt.com next-auth session cookie, presented to
 *   `/api/auth/session` to mint a fresh access token — exactly what the web app does.
 *
 * The single source of truth for the label: it is written by the connect routers, stored in a
 * non-secret vault leaf, and dispatched on by the provider's `refreshAccessToken`. Spending a
 * credential the wrong way is a silent, terminal failure, so the value is never carried as a
 * free-form string across a boundary — {@link parseOAuthRenewalKind} is the only way in.
 */
export const OAUTH_RENEWAL_KINDS = ['oauth', 'web_session'] as const;

export type OAuthRenewalKind = (typeof OAUTH_RENEWAL_KINDS)[number];

/**
 * Validate a persisted/incoming renewal-kind label.
 *
 * An UNKNOWN value is treated as ABSENT rather than passed through: the vault is durable
 * state that older code (and, for platform vaults, an admin credential edit) can write, and
 * "absent" has a well-defined meaning — fall back to identifying the credential by shape.
 * Passing an unrecognised label through would instead pick the default branch silently, which
 * for ChatGPT Web means presenting a session cookie as an OAuth refresh token.
 */
export const parseOAuthRenewalKind = (value: unknown): OAuthRenewalKind | undefined =>
  typeof value === 'string' && (OAUTH_RENEWAL_KINDS as readonly string[]).includes(value)
    ? (value as OAuthRenewalKind)
    : undefined;

/** Per-call knobs shared by every `refreshAccessToken` implementation. */
export interface OAuthRefreshOptions {
  /**
   * The stable device id the connection was made with (`oauthDeviceId`), for providers that
   * bind a credential to one (ChatGPT Web sends it as the `oai-did` cookie / `oai-device-id`
   * header). Renewing WITHOUT it makes every renewal look like a brand-new device to the
   * upstream bot filter, even though connect presented one.
   */
  deviceId?: string;
  /**
   * Which credential the stored `oauthRefreshToken` leaf actually holds; see
   * {@link OAuthRenewalKind}. Read from the non-secret `oauthRenewalKind` vault leaf and
   * VALIDATED by the caller ({@link parseOAuthRenewalKind}); absent for every provider with a
   * single renewal path, which is why implementations fall back to identifying it by shape.
   */
  renewalKind?: OAuthRenewalKind;
  /** Deadline for the token-endpoint call; see {@link OAuthDeviceFlowService.refreshAccessToken}. */
  signal?: AbortSignal;
}

export class OAuthDeviceFlowService {
  /**
   * Initiate OAuth Device Flow by requesting a device code
   */
  async initiateDeviceCode(config: OAuthDeviceFlowConfig): Promise<DeviceCodeResponse> {
    const response = await fetch(config.deviceCodeEndpoint, {
      body: new URLSearchParams({
        client_id: config.clientId,
        scope: config.scopes.join(' '),
      }).toString(),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to initiate device code: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    return {
      deviceCode: data.device_code,
      expiresIn: data.expires_in,
      interval: data.interval ?? config.defaultPollingInterval ?? 5,
      userCode: data.user_code,
      verificationUri: data.verification_uri || data.verification_url,
      verificationUriComplete: data.verification_uri_complete,
    };
  }

  /**
   * Poll for authorization status
   */
  async pollForToken(config: OAuthDeviceFlowConfig, deviceCode: string): Promise<PollResult> {
    const response = await fetch(config.tokenEndpoint, {
      body: new URLSearchParams({
        client_id: config.clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    });

    const data = await response.json();

    // Handle OAuth error responses
    if (data.error) {
      switch (data.error) {
        case 'authorization_pending': {
          return { status: 'pending' };
        }
        case 'slow_down': {
          return { status: 'slow_down' };
        }
        case 'expired_token': {
          return { status: 'expired' };
        }
        case 'access_denied': {
          return { status: 'denied' };
        }
        default: {
          throw new Error(`OAuth error: ${data.error} - ${data.error_description || ''}`);
        }
      }
    }

    // Success: access_token received
    if (data.access_token) {
      return {
        status: 'success',
        tokens: {
          accessToken: data.access_token,
          expiresIn: data.expires_in,
          refreshToken: data.refresh_token,
          scope: data.scope,
          tokenType: data.token_type || 'bearer',
        },
      };
    }

    throw new Error('Unexpected response from token endpoint');
  }

  /**
   * Exchange a refresh_token for a new access token (RFC 6749 §6).
   *
   * The provider may rotate the refresh_token: when the response carries a new
   * one the old one is invalidated server-side, so callers MUST persist
   * `refreshToken` from the returned tokens before relying on them.
   *
   * `options.signal` bounds the token call. It matters for SHARED credentials: the
   * platform path holds a cross-instance refresh lease across this request, and a call
   * that outlives the lease lets a second instance present the same rotating refresh
   * token — the reuse that revokes the whole grant family.
   */
  async refreshAccessToken(
    config: OAuthDeviceFlowConfig,
    refreshToken: string,
    options?: OAuthRefreshOptions,
  ): Promise<TokenResponse> {
    const response = await fetch(config.tokenEndpoint, {
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.error) {
      // invalid_grant = refresh token expired / revoked / already consumed
      if (data.error === 'invalid_grant') {
        throw new OAuthInvalidGrantError(data.error_description || 'invalid_grant');
      }

      throw new Error(
        `Failed to refresh access token: ${response.status} ${data.error || ''} ${data.error_description || ''}`.trim(),
      );
    }

    if (!data.access_token) throw new Error('Unexpected response from token endpoint');

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      // Rotation is optional per RFC 6749 — keep the old token when the
      // provider doesn't rotate.
      refreshToken: data.refresh_token || refreshToken,
      scope: data.scope,
      tokenType: data.token_type || 'bearer',
    };
  }
}
