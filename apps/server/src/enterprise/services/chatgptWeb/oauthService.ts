import { randomBytes, randomUUID } from 'node:crypto';

import { isChatGPTWebSessionToken } from '@lobechat/utils/chatgptWebPaste';
import debug from 'debug';

import {
  type DeviceCodeResponse,
  OAuthDeviceFlowService,
  OAuthInvalidGrantError,
  type OAuthRefreshOptions,
  type OAuthRenewalKind,
  parseJwtExpiry,
  type TokenResponse,
} from '@/server/services/oauthDeviceFlow';
import {
  extractChatGPTAccountEmail,
  extractChatGPTAccountId,
} from '@/server/services/oauthDeviceFlow/providers/chatGPT';
import type { OAuthDeviceFlowConfig } from '@/types/aiProvider';

import { ChatGPTWebOAuthError } from './oauthErrors';
import {
  base64url,
  CHATGPT_WEB_ENVELOPE_TTL_MS,
  type ChatGPTWebPasteEnvelope,
  createDottedState,
  createPkcePair,
  parseCallbackInput,
  parsePasteEnvelope,
} from './pasteEnvelope';
import { readRotatedSessionToken } from './sessionCookie';
import {
  ChatGPTWebSessionRetryableError,
  classifySessionStatus,
  isRetryableSessionStatus,
  SESSION_RETRY_DELAYS_MS,
  SESSION_RETRY_JITTER,
  sleepWithinBudget,
} from './sessionRetry';
import {
  assertSessionTokenShape,
  CHATGPT_BASE,
  isUsableSessionToken,
  SEC_CH_UA,
  USER_AGENT,
  webSessionHeaders,
} from './sessionToken';
import { getChatGPTWebFetch, isChatGPTWebTransportUnavailableError } from './transport';

export { ChatGPTWebOAuthError, type ChatGPTWebOAuthErrorCode } from './oauthErrors';
export {
  CHATGPT_WEB_ENVELOPE_TTL_MS,
  type ChatGPTWebPasteEnvelope,
  createPkcePair,
  parseCallbackInput,
  type ParsedCallbackInput,
  parsePasteEnvelope,
} from './pasteEnvelope';

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

const log = debug('lobe-server:chatgpt-web-oauth');

const AUTH0_CLIENT = 'eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9';
const ACCOUNTS_CHECK_PATH = '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=0';
const ME_PATH = '/backend-api/me';
/**
 * The endpoint the chatgpt.com web app itself calls to mint an access token from the
 * browser session — the reason the web app never asks anyone to sign in twice.
 */
const SESSION_PATH = '/api/auth/session';

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

/**
 * `/api/auth/session` is behind Cloudflare and answers a bot challenge (403 `cf-mitigated:
 * challenge`) a large fraction of the time — measured at roughly two calls in three from a
 * datacentre IP. It is NOT a broken session: the very next call usually returns 200.
 *
 * A single-shot call would therefore fail an operator's "connect" click, and most renewals,
 * most of the time. So the transient outcomes are retried INSIDE the session call, before
 * anything upstream sees a failure. Terminal outcomes (401, a session that mints no token)
 * are never retried — retrying a dead session only wastes the budget.
 *
 * Whole-operation budget for connect: the session mint AND the identity probes that follow it
 * live inside this one deadline, so an operator's click is bounded by it end to end. The
 * refresh path does NOT get its own budget: it inherits the caller's, which is already
 * bounded below the 30 s shared refresh lease.
 */
const CONNECT_SESSION_TIMEOUT_MS = 25_000;
/**
 * Bound on ONE attempt, so a single wedged connection cannot silently spend the whole
 * budget and leave no retries behind. Always intersected with the overall budget, which
 * therefore still governs the total.
 */
const SESSION_ATTEMPT_TIMEOUT_MS = 8000;
/** Total attempts (not retries). Connect is user-visible; refresh gets another chance later. */
const SESSION_CONNECT_ATTEMPTS = 4;
const SESSION_REFRESH_ATTEMPTS = 3;

/**
 * Which credential the stored connection renews itself WITH — the provider-local name of the
 * shared {@link OAuthRenewalKind} union (`'oauth' | 'web_session'`), which lives with the
 * refresh pipeline because the pipeline is what dispatches on it.
 *
 * Both kinds live in the same `oauthRefreshToken` vault leaf, so every existing mechanism
 * (`canRefresh`, the skew/keepalive/backoff policy, the cross-instance refresh lease, the
 * invalid_grant self-heal) applies to a session connection unchanged. The label only says
 * how to SPEND it, and is deliberately non-secret so status views can name the path.
 */
export type ChatGPTWebRenewalKind = OAuthRenewalKind;

/** Everything the routers persist into the K2 vault leaves. */
export interface ChatGPTWebConnection {
  accessToken: string;
  accountId?: string;
  deviceId: string;
  email?: string;
  /** Epoch millis from the access token's `exp` claim. */
  expiresAt?: number;
  refreshToken?: string;
  /** Absent only on the non-renewable access-token paste path. */
  renewalKind?: ChatGPTWebRenewalKind;
  /**
   * Epoch millis the WEB SESSION itself expires (`expires` from `/api/auth/session`).
   * Informational: the session rotates whenever it is used, so this is not a deadline.
   */
  sessionExpiresAt?: number;
}

/**
 * OAuth clients whose access tokens are NOT accepted for chatgpt.com web traffic.
 *
 * `app_EMoamEEZ73f0CkXaXp7hrann` is the Codex CLI client: its tokens are valid at the
 * Responses/Codex surface (that is what the sibling `chatgpt` provider uses) but carry no
 * web permission, so a connection made with one looks healthy and then fails every chat.
 * Rejecting it at connect turns a confusing runtime failure into an actionable message.
 *
 * Known-good, for reference: `app_X8zY6vW2pQ9tR3dE7nK1jL5gH` (the client the real web app's
 * session tokens carry) and `app_2SKx67EdpoN0G6j64rFvigXD` (our PKCE client, the same one
 * the chatgpt2api reference implementation uses for web chat). Any OTHER client id is
 * ALLOWED: the client list is not a documented contract, an unknown id is more likely a new
 * web client than a wrong one, and the token is still proven against `/backend-api/me`
 * before it is stored.
 */
const NON_WEB_OAUTH_CLIENT_IDS = new Set(['app_EMoamEEZ73f0CkXaXp7hrann']);

/**
 * Reject a token minted for a client that has no chatgpt.com web permission.
 * A token with no readable `client_id` claim passes: opaque and future token shapes must
 * not be blocked by a check that exists to catch ONE well-known wrong paste.
 */
const assertWebCapableAccessToken = (accessToken: string): void => {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return;
  let clientId: unknown;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    clientId = claims['client_id'];
  } catch {
    return;
  }
  if (typeof clientId === 'string' && NON_WEB_OAUTH_CLIENT_IDS.has(clientId)) {
    throw new ChatGPTWebOAuthError('token_not_web');
  }
};

export interface ChatGPTWebOAuthServiceOptions {
  /** auth.openai.com is reachable from Node directly — no impersonation needed. */
  authFetch?: typeof fetch;
  /** chatgpt.com requires the browser-fingerprinted transport. */
  transportFetch?: typeof fetch;
}

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

interface WebSessionMint {
  accessToken: string;
  email?: string;
  /** Epoch millis from the response's `expires`, when parseable. */
  sessionExpiresAt?: number;
  /** Rotated cookie value when the response carried one, else the presented token. */
  sessionToken: string;
}

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
   * Mint an access token from a chatgpt.com WEB SESSION — the same call the web app makes,
   * which is why a session connection behaves like the web app: sign in once, never again.
   *
   * Failure classification is the whole point of this method:
   * - a session that mints nothing (401, `{}`, the unauthenticated warning-only body) is
   *   TERMINAL — the caller decides whether that is a rejected connect or a dead grant;
   * - a Cloudflare challenge (403 `cf-mitigated`), 429, 5xx or a timeout is TRANSIENT and
   *   must never be mistaken for an expired session: the endpoint answers 200 most of the
   *   time and challenges intermittently, so treating a challenge as terminal would kill a
   *   perfectly good shared credential.
   *
   * No provider prose crosses this boundary and no credential is ever logged.
   */
  private async mintFromWebSession(params: {
    /** Total attempts, backoff included. See {@link SESSION_CONNECT_ATTEMPTS}. */
    attempts: number;
    deviceId?: string;
    onInvalidSession: () => never;
    sessionToken: string;
    /** Whole-operation budget: every attempt AND every backoff lives inside it. */
    signal: AbortSignal;
  }): Promise<WebSessionMint> {
    const attempts = Math.max(1, params.attempts);
    let lastRetryable: ChatGPTWebSessionRetryableError | undefined;
    /**
     * Carries a rotation across attempts. An attempt can rotate the cookie and STILL fail
     * (the body never arrives, the connection drops after the headers): the value we
     * presented is invalid from that moment on, so every later attempt — and the mint's
     * returned credential — must use the rotated one.
     */
    let sessionToken = params.sessionToken;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.mintFromWebSessionOnce({ ...params, sessionToken });
      } catch (error) {
        // Terminal outcomes (dead session), operator problems (no transport binary) and a
        // spent budget all leave through here untouched — only a retryable attempt loops.
        if (!(error instanceof ChatGPTWebSessionRetryableError)) throw error;
        if (error.rotatedSessionToken) sessionToken = error.rotatedSessionToken;
        lastRetryable = error;
        if (attempt >= attempts || params.signal.aborted) break;

        const base = SESSION_RETRY_DELAYS_MS[Math.min(attempt, SESSION_RETRY_DELAYS_MS.length) - 1];
        const wait = Math.round(base * (1 + Math.random() * SESSION_RETRY_JITTER));
        // Attempt count and failure CLASS only: no status body, no headers, no credential.
        log(
          'chatgpt.com session attempt %d/%d failed (%s); retrying in %dms',
          attempt,
          attempts,
          error.classification,
          wait,
        );
        await sleepWithinBudget(wait, params.signal);
      }
    }

    // Unreachable with attempts >= 1: the loop either returns or records a retryable error.
    throw lastRetryable!;
  }

  /** ONE call to `/api/auth/session`, with the outcome classified for {@link mintFromWebSession}. */
  private async mintFromWebSessionOnce(params: {
    deviceId?: string;
    onInvalidSession: () => never;
    sessionToken: string;
    signal: AbortSignal;
  }): Promise<WebSessionMint> {
    // Built OUTSIDE the try: a malformed credential is a terminal input problem, and the
    // catch below would otherwise reclassify it as a retryable network failure.
    const headers = webSessionHeaders(params.sessionToken, params.deviceId);

    let response: Response;
    try {
      response = await this.transportFetch(`${CHATGPT_BASE}${SESSION_PATH}`, {
        headers,
        method: 'GET',
        // The overall budget is always part of it, so per-attempt bounding can never
        // extend the total the caller (or the shared refresh lease) allowed.
        signal: AbortSignal.any([params.signal, AbortSignal.timeout(SESSION_ATTEMPT_TIMEOUT_MS)]),
      });
    } catch (error) {
      // A missing transport binary is an operator problem, not a dead session — let it out.
      if (isChatGPTWebTransportUnavailableError(error)) throw error;
      const message = `ChatGPT Web session request failed: ${error instanceof Error ? error.name : 'network error'}`;
      // The WHOLE budget is spent (caller deadline / refresh lease): another attempt would
      // be dead on arrival, and on the refresh path it would run past the lease.
      if (params.signal.aborted) throw new Error(message, { cause: error });
      // A per-attempt timeout or a network blip: worth one more call.
      throw new ChatGPTWebSessionRetryableError('network', message, { cause: error });
    }

    // Read the rotation BEFORE the body: a failed JSON parse must not lose it.
    const rotated = readRotatedSessionToken(response);

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // 401 is the only status that means "this session is gone".
      if (response.status === 401) params.onInvalidSession();
      const message = `ChatGPT Web session request failed: ${response.status}`;
      if (!isRetryableSessionStatus(response.status)) throw new Error(message);
      throw new ChatGPTWebSessionRetryableError(classifySessionStatus(response), message, {
        ...(rotated ? { rotatedSessionToken: rotated } : {}),
      });
    }

    /**
     * A body that cannot be READ is not an answer about the session.
     *
     * Collapsing it into `{}` used to make a dropped connection, a truncated response or a
     * Cloudflare interstitial served with a 200 indistinguishable from "this session mints
     * nothing" — i.e. TERMINAL, which kills a shared credential every user depends on and
     * demands an operator reconnect for a network blip. Only a body we actually parsed can
     * answer that question; anything else is transient and gets another attempt.
     */
    let body: {
      accessToken?: unknown;
      expires?: unknown;
      user?: { email?: unknown } | null;
    };
    try {
      body = (await response.json()) as typeof body;
    } catch (error) {
      const message = 'ChatGPT Web session response could not be read';
      // The whole budget is spent: another attempt would be dead on arrival, and on the
      // refresh path it would run past the shared lease.
      if (params.signal.aborted) throw new Error(message, { cause: error });
      throw new ChatGPTWebSessionRetryableError('network', message, {
        cause: error,
        // If this attempt already rotated the cookie, the presented one is gone: the retry
        // must present the rotation, not the value the upstream just invalidated.
        ...(rotated ? { rotatedSessionToken: rotated } : {}),
      });
    }

    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    // An unauthenticated session answers 200 with a PARSED `{}` or warning-only banner body —
    // the session really is gone, so this one is terminal.
    if (!accessToken) params.onInvalidSession();

    const email =
      typeof body?.user?.email === 'string' && body.user.email.length > 0
        ? body.user.email
        : undefined;
    const expires = typeof body?.expires === 'string' ? Date.parse(body.expires) : Number.NaN;

    return {
      accessToken,
      ...(email ? { email } : {}),
      ...(Number.isFinite(expires) ? { sessionExpiresAt: expires } : {}),
      sessionToken: rotated ?? params.sessionToken,
    };
  }

  /**
   * Connect with a pasted chatgpt.com web session instead of an authorization code.
   *
   * The session token is stored in the SAME `oauthRefreshToken` leaf an OAuth refresh token
   * would occupy (tagged by `oauthRenewalKind`), so it inherits every renewal mechanism
   * already in place rather than adding a second lifecycle to keep in sync.
   */
  async connectWithSession(sessionToken: string, deviceId?: string): Promise<ChatGPTWebConnection> {
    const token = sessionToken.trim();
    // Boundary check, not a formatting nicety: this value is interpolated into a Cookie
    // header, so a delimiter or control character in it is a header-injection primitive.
    assertSessionTokenShape(token);

    const resolvedDeviceId = deviceId ?? randomUUID();
    /**
     * ONE deadline for the WHOLE connect, not just the mint.
     *
     * The mint's own budget used to be the only bound, while the identity probes that follow
     * added up to ~30 s more on top of it — so a wedged upstream could hold an operator's
     * "connect" click (and its HTTP request) for nearly a minute. Every request below
     * intersects this signal with its own per-request cap, so the total can never exceed it.
     */
    const budget = AbortSignal.timeout(CONNECT_SESSION_TIMEOUT_MS);
    const minted = await this.mintFromWebSession({
      // An operator is watching this one, and a Cloudflare challenge is far more likely
      // than not — so it gets the widest retry budget of the two paths.
      attempts: SESSION_CONNECT_ATTEMPTS,
      deviceId: resolvedDeviceId,
      onInvalidSession: () => {
        throw new ChatGPTWebOAuthError('session_invalid');
      },
      sessionToken: token,
      signal: budget,
    });

    // A session belonging to a client without web permission would connect and then fail
    // every chat; say so here instead.
    assertWebCapableAccessToken(minted.accessToken);

    const connection = await this.buildConnection({
      accessToken: minted.accessToken,
      deviceId: resolvedDeviceId,
      fallbackEmail: minted.email,
      refreshToken: minted.sessionToken,
      // Whatever the mint left of the connect budget is all the identity probes may spend.
      signal: budget,
    });

    return {
      ...connection,
      renewalKind: 'web_session',
      ...(minted.sessionExpiresAt ? { sessionExpiresAt: minted.sessionExpiresAt } : {}),
    };
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

  private async refreshFromWebSession(
    refreshToken: string,
    signal: AbortSignal,
    options?: OAuthRefreshOptions,
  ): Promise<TokenResponse> {
    /**
     * The stored credential is durable state that reaches a Cookie header, so it is held to
     * the same boundary rule as a pasted one. `invalid_grant` (not a transient error) is the
     * right outcome: it makes the pipeline re-read durable state — a concurrent reconnect
     * may have replaced this leaf — and otherwise ends in the actionable "reconnect this
     * provider", which is exactly what an unusable stored credential needs.
     */
    if (!isUsableSessionToken(refreshToken)) {
      throw new OAuthInvalidGrantError('stored web session credential is malformed');
    }

    const minted = await this.mintFromWebSession({
      /**
       * One fewer attempt than connect: this whole call has to finish inside the caller's
       * bound (20 s, below the 30 s shared refresh lease), and an exhausted renewal is not
       * fatal — the 5-minute backoff retries it long before the 24 h window closes.
       */
      attempts: SESSION_REFRESH_ATTEMPTS,
      /**
       * The device this connection was made with (`oauthDeviceId`), carried by the refresh
       * pipeline. Connect presents `oai-did`; a renewal that omitted it looked like a
       * brand-new device on every call — to a host whose bot filter is the main reason this
       * path needs an impersonating transport at all.
       */
      ...(options?.deviceId ? { deviceId: options.deviceId } : {}),
      // A dead session is the session-path equivalent of `invalid_grant`: the refresh
      // pipeline's self-heal (re-read durable state, retry once) and its terminal
      // "reconnect this provider" outcome are exactly the right handling.
      onInvalidSession: () => {
        throw new OAuthInvalidGrantError('web session expired');
      },
      sessionToken: refreshToken,
      // The caller's own deadline IS the budget; the retries live inside it.
      signal,
    });
    const expiresAt = parseJwtExpiry(minted.accessToken);
    const expiresIn = expiresAt ? Math.floor((expiresAt - Date.now()) / 1000) : undefined;

    return {
      accessToken: minted.accessToken,
      ...(expiresIn && expiresIn > 0 ? { expiresIn } : {}),
      // Rotation is the norm here: presenting a rotated-away session would 401 next time.
      refreshToken: minted.sessionToken,
      tokenType: 'bearer',
    };
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

    // Before spending a request on it: a Codex CLI token authenticates fine against some
    // OpenAI surfaces but has no chatgpt.com web permission, and "invalid token" would send
    // the operator looking for the wrong problem.
    assertWebCapableAccessToken(token);

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
    /** Caller's whole-operation deadline; each probe intersects it with its own cap. */
    signal?: AbortSignal;
  }): Promise<ChatGPTWebConnection> {
    const email =
      extractChatGPTWebEmail(params.idToken, params.accessToken) ??
      params.fallbackEmail ??
      // Code exchange with a token that carries no email claim (org accounts do this):
      // ask the backend, best-effort. The admin card names the shared account, so an
      // unnamed connection is a real usability loss — but never worth failing a grant for.
      (await this.fetchEmail(params.accessToken, params.deviceId, params.signal));
    const accountId =
      extractChatGPTAccountId(params.idToken, params.accessToken) ??
      (await this.fetchAccountId(params.accessToken, params.deviceId, params.signal));
    const expiresAt = parseJwtExpiry(params.accessToken);

    return {
      accessToken: params.accessToken,
      ...(accountId ? { accountId } : {}),
      deviceId: params.deviceId,
      ...(email ? { email } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(params.refreshToken ? { refreshToken: params.refreshToken } : {}),
      // Default for every path that redeems an authorization code; `connectWithSession`
      // overrides it, and the access-token paste stores no renewal credential at all.
      ...(params.refreshToken ? { renewalKind: 'oauth' as const } : {}),
    };
  }

  /**
   * Intersect a per-request cap with the caller's whole-operation deadline, when there is
   * one. Without this the identity probes would each start a FRESH budget after the call that
   * already spent the caller's, which is how a bounded connect turned into an unbounded one.
   */
  private static probeSignal(capMs: number, budget?: AbortSignal): AbortSignal {
    const cap = AbortSignal.timeout(capMs);
    return budget ? AbortSignal.any([budget, cap]) : cap;
  }

  /** Best-effort `/backend-api/me`; a failure only costs the account's display name. */
  private async fetchEmail(
    accessToken: string,
    deviceId: string,
    budget?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const response = await this.transportFetch(`${CHATGPT_BASE}${ME_PATH}`, {
        headers: sessionHeaders(accessToken, deviceId),
        method: 'GET',
        signal: ChatGPTWebOAuthService.probeSignal(EMAIL_FALLBACK_TIMEOUT_MS, budget),
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

  private async fetchAccountId(
    accessToken: string,
    deviceId: string,
    budget?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const response = await this.transportFetch(`${CHATGPT_BASE}${ACCOUNTS_CHECK_PATH}`, {
        headers: sessionHeaders(accessToken, deviceId),
        method: 'GET',
        signal: ChatGPTWebOAuthService.probeSignal(IDENTITY_REQUEST_TIMEOUT_MS, budget),
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
