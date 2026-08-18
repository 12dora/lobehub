import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { OAuthDeviceFlowConfig } from '@/types/aiProvider';

import type { DeviceCodeResponse, OAuthRefreshOptions, PollResult, TokenResponse } from '../index';
import {
  extractOidcEmail,
  extractOidcSubject,
  identityLookupSignal,
  OAuthDeviceFlowService,
  OAuthInvalidGrantError,
  parseJwtExpiry,
} from '../index';

export const CURSOR_USER_AGENT = 'cursor-agent-cli/2026.08.11';
export const CURSOR_AUTH_TIMEOUT_MS = 20_000;
export const CURSOR_LOGIN_TTL_SECONDS = 1400;
export const CURSOR_WEBSITE_ORIGIN = 'https://cursor.com';
export const CURSOR_LOGIN_PATH = '/loginDeepControl';
/** Public Cursor OAuth client used by the CLI for a refresh_token grant. */
export const CURSOR_OAUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
export const CURSOR_API_ORIGIN = 'https://api2.cursor.sh';
/** Connect-RPC DashboardService.GetMe — the CLI's email source. */
export const CURSOR_GET_ME_PATH = '/aiserver.v1.DashboardService/GetMe';

const toBase64Url = (buf: Buffer): string =>
  buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

/** S256 challenge of the verifier *string* (already base64url), matching the CLI. */
export const cursorChallengeFromVerifier = (verifier: string): string =>
  toBase64Url(createHash('sha256').update(verifier).digest());

export const encodeCursorDeviceCode = (uuid: string, verifier: string): string =>
  `${uuid}.${verifier}`;

export const decodeCursorDeviceCode = (deviceCode: string): { uuid: string; verifier: string } => {
  const dot = deviceCode.indexOf('.');
  if (dot <= 0 || dot === deviceCode.length - 1) {
    throw new Error('Invalid Cursor device authorization state');
  }
  return { uuid: deviceCode.slice(0, dot), verifier: deviceCode.slice(dot + 1) };
};

export const buildCursorDeviceAuthorization = (
  verifier: string,
  uuid: string,
  interval: number,
): DeviceCodeResponse => {
  const challenge = cursorChallengeFromVerifier(verifier);
  const verificationUri = `${CURSOR_WEBSITE_ORIGIN}${CURSOR_LOGIN_PATH}`;
  const verificationUriComplete = `${verificationUri}?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=cli`;
  return {
    deviceCode: encodeCursorDeviceCode(uuid, verifier),
    expiresIn: CURSOR_LOGIN_TTL_SECONDS,
    interval,
    userCode: '',
    verificationUri,
    verificationUriComplete,
  };
};

const expiresInFromAccessToken = (accessToken: string): number | undefined => {
  const expMs = parseJwtExpiry(accessToken);
  if (expMs === undefined) return undefined;
  return Math.max(0, Math.floor((expMs - Date.now()) / 1000));
};

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const data: unknown = await response.json().catch(() => ({}));
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
};

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asAccountIdentity = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 320 ? value : undefined;

/**
 * API origin for Cursor dashboard RPCs. Prefers `CURSOR_API_ENDPOINT` (full URL or
 * origin), then the card's token-exchange host, then the public `api2.cursor.sh`.
 */
export const resolveCursorApiOrigin = (
  config?: Pick<OAuthDeviceFlowConfig, 'tokenExchangeEndpoint'>,
): string => {
  for (const raw of [process.env.CURSOR_API_ENDPOINT, config?.tokenExchangeEndpoint]) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      return new URL(value).origin;
    } catch {
      // Fall through to the next candidate.
    }
  }
  return CURSOR_API_ORIGIN;
};

/**
 * Live identity for a Cursor access token. The JWT only has a WorkOS `sub`; the CLI
 * resolves email via DashboardService/GetMe. Failures are swallowed.
 */
export const fetchCursorAccountIdentity = async (
  accessToken: string,
  config?: Pick<OAuthDeviceFlowConfig, 'tokenExchangeEndpoint'>,
  signal?: AbortSignal,
): Promise<{ accountId?: string; email?: string }> => {
  try {
    const response = await fetch(`${resolveCursorApiOrigin(config)}${CURSOR_GET_ME_PATH}`, {
      body: '{}',
      headers: {
        'authorization': `Bearer ${accessToken}`,
        'connect-protocol-version': '1',
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: identityLookupSignal(signal),
    });
    if (!response.ok) return {};
    const body = await readJson(response);
    const email = asAccountIdentity(body.email);
    const accountId = asAccountIdentity(body.authId) ?? asAccountIdentity(body.workosId);
    return {
      ...(accountId ? { accountId } : {}),
      ...(email ? { email } : {}),
    };
  } catch {
    return {};
  }
};

const withCursorIdentity = async (
  tokens: TokenResponse | undefined,
  config?: Pick<OAuthDeviceFlowConfig, 'tokenExchangeEndpoint'>,
  signal?: AbortSignal,
): Promise<TokenResponse | undefined> => {
  if (!tokens || tokens.email) return tokens;
  const fetched = await fetchCursorAccountIdentity(tokens.accessToken, config, signal);
  if (!fetched.email && !fetched.accountId) return tokens;
  return {
    ...tokens,
    ...(fetched.accountId ? { accountId: fetched.accountId } : {}),
    ...(fetched.email ? { email: fetched.email } : {}),
  };
};

const cursorTokensFromBody = (
  body: Record<string, unknown>,
  refreshTokenOverride?: string,
  renewalKind?: TokenResponse['renewalKind'],
): TokenResponse | undefined => {
  const accessToken = asNonEmptyString(body.accessToken) ?? asNonEmptyString(body.access_token);
  if (!accessToken) return undefined;
  const refreshToken =
    refreshTokenOverride ??
    asNonEmptyString(body.refreshToken) ??
    asNonEmptyString(body.refresh_token);
  const idToken = asNonEmptyString(body.idToken) ?? asNonEmptyString(body.id_token);
  const email = extractOidcEmail(idToken, accessToken);
  const accountId = extractOidcSubject(idToken, accessToken);
  return {
    accessToken,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    expiresIn: expiresInFromAccessToken(accessToken) ?? asFiniteExpiresIn(body),
    ...(refreshToken ? { refreshToken } : {}),
    ...(renewalKind ? { renewalKind } : {}),
    tokenType: asNonEmptyString(body.tokenType) ?? asNonEmptyString(body.token_type) ?? 'bearer',
  };
};

const asFiniteExpiresIn = (body: Record<string, unknown>): number | undefined => {
  const raw = body.expiresIn ?? body.expires_in;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
};

const looksLikeCursorApiKey = (value: string): boolean => value.startsWith('key_');

const isTerminalCursorApiKeyRejection = (
  status: number,
  body: Record<string, unknown>,
): boolean => {
  if (status === 400 || status === 401) return true;
  if (status !== 403) return false;
  const error =
    asNonEmptyString(body.error) ??
    asNonEmptyString(body.err) ??
    asNonEmptyString(body.message) ??
    '';
  return (
    error.length === 0 ||
    /invalid_api_key|unauthor|sign_in_policy_violation|invalid.?grant|revoked/i.test(error)
  );
};

const mergeAbortSignals = (extra?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(CURSOR_AUTH_TIMEOUT_MS);
  return extra ? AbortSignal.any([timeout, extra]) : timeout;
};

const cursorFetch = async (
  url: string,
  init: RequestInit & { signal?: AbortSignal },
): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: {
      'User-Agent': CURSOR_USER_AGENT,
      ...init.headers,
    },
    signal: mergeAbortSignals(init.signal),
  });

/**
 * Cursor loginDeepControl + /auth/poll (device-flow *shape*) and dashboard API-key paste.
 *
 * Browser-login refresh uses `POST https://api2.cursor.sh/oauth/token` with a JSON body
 * (form-urlencoded is 415; `/auth/refresh` is 404). A refused grant (400/401) is
 * `OAuthInvalidGrantError` so keepalive stamps needsReauth; other failures stay
 * generic so a blip does not kill a still-valid JWT.
 */
export class CursorOAuthService extends OAuthDeviceFlowService {
  override async initiateDeviceCode(config: OAuthDeviceFlowConfig): Promise<DeviceCodeResponse> {
    const verifier = toBase64Url(randomBytes(32));
    return buildCursorDeviceAuthorization(
      verifier,
      randomUUID(),
      config.defaultPollingInterval ?? 3,
    );
  }

  override async pollForToken(
    config: OAuthDeviceFlowConfig,
    deviceCode: string,
  ): Promise<PollResult> {
    const { uuid, verifier } = decodeCursorDeviceCode(deviceCode);
    const pollUrl = new URL(config.tokenEndpoint);
    pollUrl.searchParams.set('uuid', uuid);
    pollUrl.searchParams.set('verifier', verifier);

    const response = await cursorFetch(pollUrl.toString(), {
      headers: { 'Content-Type': 'application/json' },
      method: 'GET',
    });

    if (response.status === 404) return { status: 'pending' };

    const body = await readJson(response);

    if (response.status === 403) {
      const error = asNonEmptyString(body.error) ?? asNonEmptyString(body.err);
      if (error === 'sign_in_policy_violation') return { status: 'denied' };
      return { status: 'pending' };
    }

    if (!response.ok) return { status: 'pending' };

    const tokens = await withCursorIdentity(cursorTokensFromBody(body, undefined, 'oauth'), config);
    if (!tokens?.refreshToken) return { status: 'pending' };
    return { status: 'success', tokens };
  }

  override async exchangePastedCredential(
    config: OAuthDeviceFlowConfig,
    pastedValue: string,
  ): Promise<PollResult> {
    const tokens = await this.exchangeApiKey(config, pastedValue);
    return { status: 'success', tokens };
  }

  override async refreshAccessToken(
    config: OAuthDeviceFlowConfig,
    refreshToken: string,
    options?: OAuthRefreshOptions,
  ): Promise<TokenResponse> {
    if (options?.renewalKind === 'cursor_api_key' || looksLikeCursorApiKey(refreshToken)) {
      return this.exchangeApiKey(config, refreshToken, options?.signal);
    }

    const renewed = await this.tryBrowserLoginRefresh(refreshToken, options?.signal);
    if (renewed) return renewed;

    throw new Error(
      'cursor browser-login tokens cannot be renewed; reconnect when the access token expires',
    );
  }

  private async exchangeApiKey(
    config: OAuthDeviceFlowConfig,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<TokenResponse> {
    const endpoint =
      config.tokenExchangeEndpoint ?? `${CURSOR_API_ORIGIN}/auth/exchange_user_api_key`;
    const response = await cursorFetch(endpoint, {
      body: '{}',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal,
    });

    const body = await readJson(response);
    if (!response.ok) {
      if (isTerminalCursorApiKeyRejection(response.status, body)) {
        const detail =
          asNonEmptyString(body.error) ??
          asNonEmptyString(body.err) ??
          asNonEmptyString(body.message) ??
          `HTTP ${response.status}`;
        throw new OAuthInvalidGrantError(detail);
      }
      throw new Error(`Failed to exchange Cursor API key: ${response.status}`);
    }

    const tokens = await withCursorIdentity(
      cursorTokensFromBody(body, apiKey, 'cursor_api_key'),
      config,
      signal,
    );
    if (!tokens) throw new Error('Unexpected response from Cursor API key exchange');
    return tokens;
  }

  /**
   * Live 2026-08-17: `POST /oauth/token` with JSON
   * `{ grant_type, refresh_token, client_id }` returns `{ access_token, id_token }`.
   * Form-urlencoded is 415; `POST /auth/refresh` is 404.
   */
  private async tryBrowserLoginRefresh(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<TokenResponse | undefined> {
    const response = await cursorFetch(`${CURSOR_API_ORIGIN}/oauth/token`, {
      body: JSON.stringify({
        client_id: CURSOR_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal,
    });

    const body = await readJson(response);
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        throw new OAuthInvalidGrantError('cursor browser-login refresh was refused; reconnect');
      }
      throw new Error(`Failed to refresh Cursor browser-login token: ${response.status}`);
    }

    return withCursorIdentity(cursorTokensFromBody(body, refreshToken, 'oauth'), undefined, signal);
  }
}
