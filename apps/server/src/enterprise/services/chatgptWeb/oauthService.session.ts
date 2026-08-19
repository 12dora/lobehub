import { randomUUID } from 'node:crypto';

import debug from 'debug';

import type { OAuthRefreshOptions, TokenResponse } from '@/server/services/oauthDeviceFlow';
import { OAuthInvalidGrantError, parseJwtExpiry } from '@/server/services/oauthDeviceFlow';

import type { StagedChatGPTWebBrowserSession } from './browserSession';
import {
  isChatGPTWebBrowserSessionFenceCurrent,
  peekChatGPTWebBrowserSessionFence,
} from './browserSession';
import { ChatGPTWebOAuthError } from './oauthErrors';
import type { ChatGPTWebConnection } from './oauthService.identity';
import { assertWebCapableAccessToken, ChatGPTWebOAuthIdentityOps } from './oauthService.identity';
import { readRotatedSessionCookie, seedChatGPTWebSessionJar } from './sessionCookie';
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
  webSessionHeaders,
} from './sessionToken';
import { isChatGPTWebTransportUnavailableError, withCookieJarHeader } from './transport';

const log = debug('lobe-server:chatgpt-web-oauth');

/**
 * The endpoint the chatgpt.com web app itself calls to mint an access token from the
 * browser session — the reason the web app never asks anyone to sign in twice.
 */
const SESSION_PATH = '/api/auth/session';

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
 * Carry a rotation the loop adopted into the error that leaves this method.
 *
 * The last attempt may itself have failed WITHOUT a Set-Cookie (the rotation
 * arrived on an earlier try). The loop already swapped `sessionToken` locally;
 * this makes that value visible to the refresh persist path.
 */
const attachAdoptedSessionRotation = (
  error: ChatGPTWebSessionRetryableError,
  sessionToken: string,
  sessionChunks: readonly string[] | undefined,
): ChatGPTWebSessionRetryableError => {
  if (error.rotatedSessionToken === sessionToken) return error;
  return new ChatGPTWebSessionRetryableError(error.classification, error.message, {
    cause: error,
    ...(sessionChunks ? { rotatedSessionChunks: sessionChunks } : {}),
    rotatedSessionToken: sessionToken,
  });
};

interface WebSessionMint {
  accessToken: string;
  email?: string;
  /** Chunk layout that still joins to `sessionToken`, when we have one. */
  sessionChunks?: string[];
  /** Epoch millis from the response's `expires`, when parseable. */
  sessionExpiresAt?: number;
  /** Rotated cookie value when the response carried one, else the presented token. */
  sessionToken: string;
}

/**
 * Web-session mint, retry/rotation, connect, and refresh. Classification is load-bearing:
 * a Cloudflare challenge must stay transient; a 401 / empty session is a dead grant.
 */
export abstract class ChatGPTWebOAuthSessionOps extends ChatGPTWebOAuthIdentityOps {
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
    /**
     * Staged (or live) jar key. Connect/verify pass a staged key so the live
     * jar is not overwritten until the candidate is proven. Refresh omits this
     * and uses the live context.
     */
    cookieJarKey?: string;
    deviceId?: string;
    onInvalidSession: () => never;
    sessionChunks?: readonly string[];
    sessionId?: string;
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
    let sessionChunks = params.sessionChunks;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.mintFromWebSessionOnce({ ...params, sessionChunks, sessionToken });
      } catch (error) {
        // Terminal outcomes (dead session), operator problems (no transport binary) and a
        // spent budget all leave through here untouched — only a retryable attempt loops.
        if (!(error instanceof ChatGPTWebSessionRetryableError)) throw error;
        if (error.rotatedSessionToken) {
          sessionToken = error.rotatedSessionToken;
          sessionChunks = error.rotatedSessionChunks;
        }
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
    // A rotation adopted during the loop must travel with the thrown error so the
    // refresh pipeline can CAS-persist it before this failure surfaces. Otherwise
    // the vault keeps the consumed token, the next refresh 401s, and the connection
    // is marked dead even though a live replacement was observed.
    if (sessionToken !== params.sessionToken) {
      throw attachAdoptedSessionRotation(lastRetryable!, sessionToken, sessionChunks);
    }
    throw lastRetryable!;
  }

  /** ONE call to `/api/auth/session`, with the outcome classified for {@link mintFromWebSession}. */
  private async mintFromWebSessionOnce(params: {
    cookieJarKey?: string;
    deviceId?: string;
    onInvalidSession: () => never;
    sessionChunks?: readonly string[];
    sessionId?: string;
    sessionToken: string;
    signal: AbortSignal;
  }): Promise<WebSessionMint> {
    // Built OUTSIDE the try: a malformed credential is a terminal input problem, and the
    // catch below would otherwise reclassify it as a retryable network failure.
    const cookieJarKey = params.cookieJarKey ?? this.cookieJarKeyFor(params.deviceId);
    const sessionId =
      params.sessionId ?? (params.deviceId ? this.pageSessionId(params.deviceId) : undefined);
    // Refresh writes the live jar. A reconnect that rotated live mid-mint must
    // not seed the replacement. Staged connect passes `cookieJarKey` and is
    // fenced by the staged context's own tombstone.
    const liveFence =
      params.cookieJarKey || !this.browserSessionAccountId
        ? undefined
        : peekChatGPTWebBrowserSessionFence(this.browserSessionAccountId);
    const jarStillWritable = (): boolean =>
      !liveFence || isChatGPTWebBrowserSessionFenceCurrent(liveFence);
    const headers = withCookieJarHeader(
      webSessionHeaders(
        params.sessionToken,
        params.deviceId,
        this.browserProfile,
        params.sessionChunks,
        sessionId,
        cookieJarKey,
      ),
      cookieJarKey,
    );
    if (cookieJarKey && jarStillWritable()) {
      seedChatGPTWebSessionJar(
        cookieJarKey,
        params.sessionToken,
        params.sessionChunks,
        params.deviceId,
      );
    }

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
    const rotated = readRotatedSessionCookie(response);

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // 401 is the only status that means "this session is gone".
      if (response.status === 401) params.onInvalidSession();
      const message = `ChatGPT Web session request failed: ${response.status}`;
      if (!isRetryableSessionStatus(response.status)) throw new Error(message);
      throw new ChatGPTWebSessionRetryableError(classifySessionStatus(response), message, {
        ...(rotated
          ? {
              ...(rotated.chunks ? { rotatedSessionChunks: rotated.chunks } : {}),
              rotatedSessionToken: rotated.token,
            }
          : {}),
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
        ...(rotated
          ? {
              ...(rotated.chunks ? { rotatedSessionChunks: rotated.chunks } : {}),
              rotatedSessionToken: rotated.token,
            }
          : {}),
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
    const sessionToken = rotated?.token ?? params.sessionToken;
    const sessionChunks = rotated ? rotated.chunks : params.sessionChunks;
    // Vault wins: the jar is a cache. Re-seed so a curl-written session cookie
    // cannot disagree with the value we are about to persist. Chunk layout is
    // transport state derived from that token (paste chunks, else size-split).
    if (cookieJarKey && jarStillWritable()) {
      seedChatGPTWebSessionJar(cookieJarKey, sessionToken, sessionChunks, params.deviceId);
    } else if (params.deviceId && jarStillWritable()) {
      seedChatGPTWebSessionJar(params.deviceId, sessionToken, sessionChunks);
    }

    return {
      accessToken,
      ...(email ? { email } : {}),
      ...(sessionChunks && sessionChunks.length > 1 ? { sessionChunks: [...sessionChunks] } : {}),
      ...(Number.isFinite(expires) ? { sessionExpiresAt: expires } : {}),
      sessionToken,
    };
  }

  /**
   * Connect with a pasted chatgpt.com web session instead of an authorization code.
   *
   * The session token is stored in the SAME `oauthRefreshToken` leaf an OAuth refresh token
   * would occupy (tagged by `oauthRenewalKind`), so it inherits every renewal mechanism
   * already in place rather than adding a second lifecycle to keep in sync.
   */
  async connectWithSession(
    sessionToken: string,
    deviceId?: string,
    options?: { sessionChunks?: readonly string[] },
  ): Promise<ChatGPTWebConnection> {
    const token = sessionToken.trim();
    // Boundary check, not a formatting nicety: this value is interpolated into a Cookie
    // header, so a delimiter or control character in it is a header-injection primitive.
    assertSessionTokenShape(token);

    const sessionChunks =
      options?.sessionChunks && options.sessionChunks.join('') === token
        ? options.sessionChunks
        : undefined;

    const resolvedDeviceId = deviceId ?? randomUUID();
    // Prove the candidate against a staged jar. `seedChatGPTWebSessionJar` still
    // replaces the session-token family — but on the staged context, so a failed
    // reconnect cannot corrupt the live connection, and a candidate for a
    // different ChatGPT account cannot ride the live cookie family mid-mint.
    let staged: StagedChatGPTWebBrowserSession | undefined;
    /**
     * ONE deadline for the WHOLE connect, not just the mint.
     *
     * The mint's own budget used to be the only bound, while the identity probes that follow
     * added up to ~30 s more on top of it — so a wedged upstream could hold an operator's
     * "connect" click (and its HTTP request) for nearly a minute. Every request below
     * intersects this signal with its own per-request cap, so the total can never exceed it.
     */
    const budget = AbortSignal.timeout(CONNECT_SESSION_TIMEOUT_MS);
    // Promotion is the router's job AFTER the vault write succeeds. Committing
    // here would leave the live jar holding the new session if persist then
    // failed, mixing the old vault credential with the new cookie family.
    this.discardVerifiedChatGPTWebSession();
    try {
      staged = this.stageVerificationSession(resolvedDeviceId);
      const minted = await this.mintFromWebSession({
        // An operator is watching this one, and a Cloudflare challenge is far more likely
        // than not — so it gets the widest retry budget of the two paths.
        attempts: SESSION_CONNECT_ATTEMPTS,
        ...(staged
          ? {
              cookieJarKey: staged.context.cookieJarKey,
              sessionId: staged.context.logicalPageId,
            }
          : {}),
        deviceId: resolvedDeviceId,
        onInvalidSession: () => {
          throw new ChatGPTWebOAuthError('session_invalid');
        },
        ...(sessionChunks ? { sessionChunks } : {}),
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
        ...(staged
          ? {
              cookieJarKey: staged.context.cookieJarKey,
              sessionId: staged.context.logicalPageId,
            }
          : {}),
      });
      this.rememberPendingVerificationSession(resolvedDeviceId, staged);

      return {
        ...connection,
        renewalKind: 'web_session',
        ...(minted.sessionExpiresAt ? { sessionExpiresAt: minted.sessionExpiresAt } : {}),
      };
    } catch (error) {
      this.discardVerificationSession(staged);
      throw error;
    }
  }

  protected async refreshFromWebSession(
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
}
