import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  type DeviceCodeResponse,
  OAuthDeviceFlowService,
  OAuthInvalidGrantError,
  type OAuthRefreshOptions,
  parseJwtExpiry,
  type TokenResponse,
} from '@/server/services/oauthDeviceFlow';
import {
  extractChatGPTAccountEmail,
  extractChatGPTAccountId,
} from '@/server/services/oauthDeviceFlow/providers/chatGPT';
import type { OAuthDeviceFlowConfig } from '@/types/aiProvider';

import { getChatGPTWebFetch, isChatGPTWebTransportUnavailableError } from './transport';

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
const CHATGPT_BASE = 'https://chatgpt.com';
const ACCOUNTS_CHECK_PATH = '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=0';
const ME_PATH = '/backend-api/me';

/** Coherent with the transport's `chrome136` impersonation profile. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const SEC_CH_UA = '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"';

/** The pasted authorization code is single-use and short-lived; so is the envelope. */
export const CHATGPT_WEB_ENVELOPE_TTL_MS = 10 * 60 * 1000;
const MAX_CALLBACK_LENGTH = 4096;
const TOKEN_REQUEST_TIMEOUT_MS = 60_000;
/**
 * Refresh deadline. MUST stay below the shared refresh lease (`LEASE_SECONDS = 30` in
 * `aiCatalog/sharedOAuthRefresh.ts`) with room for the persist that follows it: once the
 * lease expires another instance may refresh with the SAME rotating token, which is the
 * reuse that revokes the grant family for every user of the shared account at once.
 */
const REFRESH_REQUEST_TIMEOUT_MS = 20_000;
const IDENTITY_REQUEST_TIMEOUT_MS = 20_000;
/** The email lookup is a nicety on a path that already holds a redeemed grant. */
const EMAIL_FALLBACK_TIMEOUT_MS = 10_000;

export type ChatGPTWebOAuthErrorCode =
  'access_token_invalid' | 'exchange_failed' | 'expired' | 'invalid_callback' | 'state_mismatch';

/** Stable machine-readable outcome; the message is never shown to a client. */
export class ChatGPTWebOAuthError extends Error {
  constructor(
    readonly code: ChatGPTWebOAuthErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ChatGPTWebOAuthError';
  }
}

/** Client-held pending-authorization state. Never persisted, never logged. */
export interface ChatGPTWebPasteEnvelope {
  createdAt: number;
  deviceId: string;
  state: string;
  v: 1;
  verifier: string;
}

/** Everything the routers persist into the K2 vault leaves. */
export interface ChatGPTWebConnection {
  accessToken: string;
  accountId?: string;
  deviceId: string;
  email?: string;
  /** Epoch millis from the access token's `exp` claim. */
  expiresAt?: number;
  refreshToken?: string;
}

export interface ChatGPTWebOAuthServiceOptions {
  /** auth.openai.com is reachable from Node directly — no impersonation needed. */
  authFetch?: typeof fetch;
  /** chatgpt.com requires the browser-fingerprinted transport. */
  transportFetch?: typeof fetch;
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

/**
 * `<a>.<b>` — the shape the real client uses (E2 §1.3), where the first half identifies
 * the pending session. We hold no server-side session (the envelope does), so BOTH halves
 * are random: the value stays opaque and unguessable, and it is still recognisable to
 * OpenAI's own request logging as a well-formed state.
 */
const createDottedState = (): string =>
  `${randomBytes(16).toString('hex')}.${base64url(randomBytes(16))}`;

/**
 * Email claim, in the order the provider actually populates it:
 * the OIDC `email` on the id_token, then the namespaced profile claim the ACCESS token
 * carries (`https://api.openai.com/profile`.email) — the only place an access-token paste
 * can find it without a network call.
 */
export const extractChatGPTWebEmail = (
  idToken: string | undefined,
  accessToken: string | undefined,
): string | undefined => {
  const standard = extractChatGPTAccountEmail(idToken, accessToken);
  if (standard) return standard;

  for (const token of [idToken, accessToken]) {
    const parts = token?.split('.');
    if (!parts || parts.length !== 3) continue;
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      const profile = claims['https://api.openai.com/profile'] as { email?: unknown } | undefined;
      const email = profile?.email;
      if (typeof email === 'string' && email.length > 0 && email.length <= 320) return email;
    } catch {
      // A non-JWT / unparseable token simply has no claim to read.
    }
  }

  return undefined;
};

export const createPkcePair = (): { challenge: string; verifier: string } => {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier, 'ascii').digest());
  return { challenge, verifier };
};

/** `randomUUID()` output, which is what {@link ChatGPTWebOAuthService.initiateDeviceCode} mints. */
const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
/** RFC 7636 §4.1 code_verifier charset; ours is a 64-byte base64url string (86 chars). */
const PKCE_VERIFIER = /^[\w.~-]{43,128}$/;
/** `<a>.<b>`, both halves non-empty — the dotted shape `createDottedState` produces. */
const DOTTED_STATE = /^[\w-]+\.[\w-]+$/;
/**
 * A client clock running ahead is normal; an envelope minted in the FUTURE beyond this is
 * not something this server ever issued.
 */
const ENVELOPE_FUTURE_SKEW_MS = 60_000;

/**
 * Parse and VALIDATE the client-held envelope.
 *
 * Shape checks are not enough: the envelope comes back from the client, and every field is
 * used for something load-bearing — the verifier IS the PKCE proof, the state is the CSRF
 * binding, and the device id is persisted and then sent as `oai-device-id` on every later
 * request (an empty or foreign one silently breaks the sentinel handshake). So each field
 * is checked against exactly the shape this service generates; anything else is a
 * fabricated envelope, not a usable one.
 */
export const parsePasteEnvelope = (deviceCode: string): ChatGPTWebPasteEnvelope => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(deviceCode);
  } catch {
    throw new ChatGPTWebOAuthError('invalid_callback', 'malformed authorization envelope');
  }

  const envelope = parsed as Partial<ChatGPTWebPasteEnvelope>;
  if (
    envelope?.v !== 1 ||
    typeof envelope.verifier !== 'string' ||
    typeof envelope.state !== 'string' ||
    typeof envelope.deviceId !== 'string' ||
    typeof envelope.createdAt !== 'number' ||
    !Number.isFinite(envelope.createdAt) ||
    !PKCE_VERIFIER.test(envelope.verifier) ||
    !DOTTED_STATE.test(envelope.state) ||
    !UUID_V4.test(envelope.deviceId)
  ) {
    throw new ChatGPTWebOAuthError('invalid_callback', 'malformed authorization envelope');
  }

  // A far-future timestamp would make the TTL below unbounded — it is a malformed envelope,
  // not an expired one.
  if (envelope.createdAt - Date.now() > ENVELOPE_FUTURE_SKEW_MS) {
    throw new ChatGPTWebOAuthError('invalid_callback', 'malformed authorization envelope');
  }

  if (Date.now() - envelope.createdAt > CHATGPT_WEB_ENVELOPE_TTL_MS) {
    throw new ChatGPTWebOAuthError('expired');
  }

  return envelope as ChatGPTWebPasteEnvelope;
};

export interface ParsedCallbackInput {
  code: string;
  /** True when the user pasted the redirect URL rather than a bare code. */
  fromUrl: boolean;
  state?: string;
}

/**
 * The user may paste the whole redirect URL or just the `code` query value.
 *
 * A pasted URL ALWAYS carries the state the authorization server echoed back, so a URL
 * without one is not a CSRF-safe input — it is a hand-edited or forged callback and is
 * rejected by {@link ChatGPTWebOAuthService.exchangeCallback}. A bare code carries no
 * state by construction and is bound instead by the single-use PKCE verifier + the
 * envelope's 10-minute TTL.
 */
export const parseCallbackInput = (input: string): ParsedCallbackInput => {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_CALLBACK_LENGTH) {
    throw new ChatGPTWebOAuthError('invalid_callback');
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ChatGPTWebOAuthError('invalid_callback');
    }
    const code = url.searchParams.get('code');
    if (!code) throw new ChatGPTWebOAuthError('invalid_callback');
    const state = url.searchParams.get('state');
    return { code, fromUrl: true, ...(state ? { state } : {}) };
  }

  // A bare code never contains whitespace or a query separator.
  if (/[\s&?#]/.test(trimmed)) throw new ChatGPTWebOAuthError('invalid_callback');
  return { code: trimmed, fromUrl: false };
};

/**
 * The exact header set the web client sends to the token endpoint (E2 §1.4: auth0's
 * `common_headers` with the platform origin/referer on top). auth.openai.com serves this
 * endpoint to the platform SPA only, and an incomplete fetch-metadata set is exactly what
 * a bot filter looks at — so it is reproduced rather than trimmed to "what matters".
 */
const authHeaders = (): Record<string, string> => ({
  'accept': 'application/json',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en-US,en;q=0.9',
  'auth0-client': AUTH0_CLIENT,
  'cache-control': 'no-cache',
  'connection': 'keep-alive',
  'content-type': 'application/json',
  'dnt': '1',
  'origin': 'https://platform.openai.com',
  'priority': 'u=1, i',
  'referer': 'https://platform.openai.com/',
  'sec-ch-ua': SEC_CH_UA,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'sec-gpc': '1',
  'user-agent': USER_AGENT,
});

const sessionHeaders = (accessToken: string, deviceId: string): Record<string, string> => ({
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'authorization': `Bearer ${accessToken}`,
  'oai-device-id': deviceId,
  'oai-language': 'en-US',
  'referer': `${CHATGPT_BASE}/`,
  'sec-ch-ua': SEC_CH_UA,
  'sec-ch-ua-mobile': '?0',
  'user-agent': USER_AGENT,
});

export class ChatGPTWebOAuthService extends OAuthDeviceFlowService {
  private readonly authFetch: typeof fetch;
  private readonly transportFetchOverride?: typeof fetch;

  constructor(options: ChatGPTWebOAuthServiceOptions = {}) {
    super();
    this.authFetch = options.authFetch ?? ((...args) => globalThis.fetch(...args));
    this.transportFetchOverride = options.transportFetch;
  }

  /** Resolved lazily so a deployment without the binary still boots. */
  private get transportFetch(): typeof fetch {
    return this.transportFetchOverride ?? getChatGPTWebFetch();
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
        headers: authHeaders(),
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

    return this.buildConnection({
      accessToken: tokens.access_token,
      deviceId: envelope.deviceId,
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
    });
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

    let response: Response;
    try {
      response = await this.authFetch(config.tokenEndpoint, {
        body: new URLSearchParams({
          client_id: config.clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
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

  /**
   * Access-token paste fallback: prove the token works against the real backend before
   * storing it. There is no refresh token on this path, so it cannot be auto-renewed.
   */
  async verifyAccessToken(accessToken: string, deviceId?: string): Promise<ChatGPTWebConnection> {
    const token = accessToken.trim();
    if (!token) throw new ChatGPTWebOAuthError('access_token_invalid');

    const resolvedDeviceId = deviceId ?? randomUUID();

    let response: Response;
    try {
      response = await this.transportFetch(`${CHATGPT_BASE}${ME_PATH}`, {
        headers: sessionHeaders(token, resolvedDeviceId),
        method: 'GET',
        signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A missing transport is an operator problem, not an invalid token — let it out.
      if (isChatGPTWebTransportUnavailableError(error)) throw error;
      throw new ChatGPTWebOAuthError('access_token_invalid');
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ChatGPTWebOAuthError('access_token_invalid');
    }

    const me = (await response.json().catch(() => ({}))) as { email?: string; id?: string };

    return this.buildConnection({
      accessToken: token,
      deviceId: resolvedDeviceId,
      fallbackEmail: me.email,
    });
  }

  /**
   * Fill the identity leaves. Both lookups are best-effort: a connection without an
   * account id still chats (the header is optional), and a failed probe must never
   * discard a freshly redeemed, single-use grant.
   */
  private async buildConnection(params: {
    accessToken: string;
    deviceId: string;
    fallbackEmail?: string;
    idToken?: string;
    refreshToken?: string;
  }): Promise<ChatGPTWebConnection> {
    const email =
      extractChatGPTWebEmail(params.idToken, params.accessToken) ??
      params.fallbackEmail ??
      // Code exchange with a token that carries no email claim (org accounts do this):
      // ask the backend, best-effort. The admin card names the shared account, so an
      // unnamed connection is a real usability loss — but never worth failing a grant for.
      (await this.fetchEmail(params.accessToken, params.deviceId));
    const accountId =
      extractChatGPTAccountId(params.idToken, params.accessToken) ??
      (await this.fetchAccountId(params.accessToken, params.deviceId));
    const expiresAt = parseJwtExpiry(params.accessToken);

    return {
      accessToken: params.accessToken,
      ...(accountId ? { accountId } : {}),
      deviceId: params.deviceId,
      ...(email ? { email } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(params.refreshToken ? { refreshToken: params.refreshToken } : {}),
    };
  }

  /** Best-effort `/backend-api/me`; a failure only costs the account's display name. */
  private async fetchEmail(accessToken: string, deviceId: string): Promise<string | undefined> {
    try {
      const response = await this.transportFetch(`${CHATGPT_BASE}${ME_PATH}`, {
        headers: sessionHeaders(accessToken, deviceId),
        method: 'GET',
        signal: AbortSignal.timeout(EMAIL_FALLBACK_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const me = (await response.json()) as { email?: unknown };
      return typeof me?.email === 'string' && me.email.length > 0 ? me.email : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchAccountId(accessToken: string, deviceId: string): Promise<string | undefined> {
    try {
      const response = await this.transportFetch(`${CHATGPT_BASE}${ACCOUNTS_CHECK_PATH}`, {
        headers: sessionHeaders(accessToken, deviceId),
        method: 'GET',
        signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const payload = (await response.json()) as {
        accounts?: { default?: { account?: { account_id?: string; id?: string } } };
      };
      const account = payload?.accounts?.default?.account;
      const accountId = account?.account_id ?? account?.id;
      return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
    } catch {
      // Best-effort only: never fail a connect because the account probe was blocked.
      return undefined;
    }
  }
}
