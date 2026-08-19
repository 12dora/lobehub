import { randomUUID } from 'node:crypto';

import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import {
  DEFAULT_BROWSER_DEVICE_PROFILE,
  isFallbackBrowserProfile,
  resolveProfileTimezone,
} from '@lobechat/model-runtime/browserProfile';
import {
  buildChatGptWebXhrHeaders,
  deriveSessionId,
} from '@lobechat/model-runtime/chatgptWebIdentity';
import { isRecord } from '@lobechat/utils/object';

import type { OAuthRenewalKind } from '@/server/services/oauthDeviceFlow';
import { OAuthDeviceFlowService, parseJwtExpiry } from '@/server/services/oauthDeviceFlow';
import {
  extractChatGPTAccountEmail,
  extractChatGPTAccountId,
} from '@/server/services/oauthDeviceFlow/providers/chatGPT';

import type {
  BindChatGPTWebBrowserSessionParams,
  StagedChatGPTWebBrowserSession,
} from './browserSession';
import {
  bindChatGPTWebBrowserSession,
  commitStagedChatGPTWebBrowserSession,
  invalidateChatGPTWebBrowserSession,
  stageChatGPTWebBrowserSession,
} from './browserSession';
import { ChatGPTWebOAuthError } from './oauthErrors';
import { CHATGPT_BASE } from './sessionToken';
import {
  isChatGPTWebTransportUnavailableError,
  unregisterContextCookieJar,
  withCookieJarHeader,
} from './transport';

const accountsCheckPath = (profile: BrowserDeviceProfile) =>
  `/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=${resolveProfileTimezone(profile).offsetMinutes}`;
const ME_PATH = '/backend-api/me';
const IDENTITY_REQUEST_TIMEOUT_MS = 20_000;
/** The email lookup is a nicety on a path that already holds a redeemed grant. */
const EMAIL_FALLBACK_TIMEOUT_MS = 10_000;

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
export const assertWebCapableAccessToken = (accessToken: string): void => {
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

export const sessionHeaders = (
  accessToken: string,
  deviceId: string,
  sessionId?: string,
  browserProfile: BrowserDeviceProfile = DEFAULT_BROWSER_DEVICE_PROFILE,
): Record<string, string> =>
  buildChatGptWebXhrHeaders({
    accessToken,
    browserProfile,
    deviceId,
    sessionId: sessionId ?? deriveSessionId(deviceId, browserProfile),
  });

/**
 * Identity probes and access-token paste verify. Host supplies the browser-fingerprinted
 * transport so a deployment without the binary still boots.
 */
export abstract class ChatGPTWebOAuthIdentityOps extends OAuthDeviceFlowService {
  protected abstract readonly browserProfile: BrowserDeviceProfile;
  protected abstract get transportFetch(): typeof fetch;
  /**
   * AIHub stored-connection handle (`platform:<id>` / `user:<uid>:<ws>:<id>`).
   * When omitted, identity probes fall back to the legacy device-id jar.
   */
  protected browserSessionAccountId?: string;
  /**
   * Staged candidate held after upstream verification succeeds. Promoted only
   * after the router persists the vault row — never as a side effect of mint.
   */
  private pendingVerificationSession?: {
    deviceId: string;
    staged: StagedChatGPTWebBrowserSession;
  };

  /**
   * The jar's `cf_clearance` / `__cf_bm` were minted under the PERSISTED identity. While
   * running on the degraded fallback identity (database unavailable) the User-Agent and
   * the TLS profile differ, so replaying them provokes the very Cloudflare challenge the
   * profile exists to avoid — go jarless and leave the jar intact.
   *
   * When a Browser Session Context is bound, the jar key is the context digest — never
   * the raw device id — so two accounts that share an `oai-did` cannot share cookies.
   */
  protected cookieJarKeyFor(deviceId?: string): string | undefined {
    if (isFallbackBrowserProfile(this.browserProfile) || !deviceId) return undefined;
    const context = this.bindBrowserSession(deviceId);
    return context?.cookieJarKey ?? deviceId;
  }

  protected bindBrowserSession(deviceId?: string) {
    const params = this.liveBrowserSessionParams(deviceId);
    if (!params) return undefined;
    return bindChatGPTWebBrowserSession(params);
  }

  protected liveBrowserSessionParams(
    deviceId?: string,
  ): BindChatGPTWebBrowserSessionParams | undefined {
    if (!this.browserSessionAccountId) return undefined;
    return {
      accountId: this.browserSessionAccountId,
      browserProfile: this.browserProfile,
      ...(deviceId ? { deviceId } : {}),
    };
  }

  /**
   * Candidate-credential probe. Writes go to a throwaway jar so a failed
   * reconnect cannot corrupt the live connection, and a different ChatGPT
   * account cannot ride the live cookie family mid-verification.
   */
  protected stageVerificationSession(
    deviceId?: string,
  ): StagedChatGPTWebBrowserSession | undefined {
    const params = this.liveBrowserSessionParams(deviceId);
    if (!params) return undefined;
    return stageChatGPTWebBrowserSession(params);
  }

  protected commitVerificationSession(
    deviceId: string | undefined,
    staged: StagedChatGPTWebBrowserSession | undefined,
  ): void {
    if (!staged) return;
    const params = this.liveBrowserSessionParams(deviceId);
    if (!params) return;
    commitStagedChatGPTWebBrowserSession(params, staged.accountId);
  }

  protected discardVerificationSession(staged: StagedChatGPTWebBrowserSession | undefined): void {
    if (!staged) return;
    unregisterContextCookieJar(staged.context.cookieJarKey);
    invalidateChatGPTWebBrowserSession(staged.accountId);
  }

  /**
   * Drop a leftover staged candidate from a previous connect/verify on this
   * instance, then remember the new one (if any) for a later commit.
   */
  protected rememberPendingVerificationSession(
    deviceId: string,
    staged: StagedChatGPTWebBrowserSession | undefined,
  ): void {
    this.discardVerifiedChatGPTWebSession();
    if (staged) this.pendingVerificationSession = { deviceId, staged };
  }

  /**
   * Discard a staged candidate without touching the live context. Call when
   * durable persist failed, or when a new verify supersedes an uncommitted one.
   */
  discardVerifiedChatGPTWebSession(): void {
    const pending = this.pendingVerificationSession;
    this.pendingVerificationSession = undefined;
    this.discardVerificationSession(pending?.staged);
  }

  /**
   * Promote the staged candidate into the live context. Call only after the
   * vault write has succeeded. No-op when nothing was staged (fallback profile,
   * no account handle, or the OAuth-code path that never stages).
   */
  commitVerifiedChatGPTWebSession(deviceId?: string): void {
    const pending = this.pendingVerificationSession;
    this.pendingVerificationSession = undefined;
    if (!pending) return;
    try {
      this.commitVerificationSession(deviceId ?? pending.deviceId, pending.staged);
    } finally {
      // The pending `:pending:` context must never survive this call, even if
      // the filesystem commit itself throws partway through.
      this.discardVerificationSession(pending.staged);
    }
    this.afterVerifiedSessionCommitted(deviceId ?? pending.deviceId);
  }

  /**
   * Hook for the concrete service: rotate the page session after a successful
   * persist+commit. Identity probes must not rotate.
   */
  protected afterVerifiedSessionCommitted(_deviceId: string): void {
    // ChatGPTWebOAuthService starts a new page session after connect.
  }

  protected pageSessionId(deviceId: string): string {
    return (
      this.bindBrowserSession(deviceId)?.logicalPageId ??
      deriveSessionId(deviceId, this.browserProfile)
    );
  }

  protected buildSessionHeaders(accessToken: string, deviceId: string): Record<string, string> {
    return sessionHeaders(accessToken, deviceId, this.pageSessionId(deviceId), this.browserProfile);
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
    // Prove the token against a staged jar, never the live one. A failed
    // reconnect must leave the previous connection's Cloudflare / session
    // cookies intact, and a candidate for a different account must not ride
    // the live cookie family while `/me` is still in flight.
    //
    // Promotion is the router's job AFTER the vault write succeeds. Committing
    // here would leave the live jar holding the new session if persist then
    // failed, mixing the old vault credential with the new cookie family.
    this.discardVerifiedChatGPTWebSession();
    let staged: StagedChatGPTWebBrowserSession | undefined;
    let response: Response;
    try {
      staged = this.stageVerificationSession(resolvedDeviceId);
      try {
        response = await this.transportFetch(`${CHATGPT_BASE}${ME_PATH}`, {
          headers: withCookieJarHeader(
            sessionHeaders(
              token,
              resolvedDeviceId,
              staged?.context.logicalPageId ?? this.pageSessionId(resolvedDeviceId),
              this.browserProfile,
            ),
            staged?.context.cookieJarKey ?? this.cookieJarKeyFor(resolvedDeviceId),
          ),
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

      let me: unknown;
      try {
        me = await response.json();
      } catch {
        throw new ChatGPTWebOAuthError('access_token_invalid');
      }
      if (!isRecord(me)) {
        throw new ChatGPTWebOAuthError('access_token_invalid');
      }

      const connection = await this.buildConnection({
        accessToken: token,
        deviceId: resolvedDeviceId,
        fallbackEmail: typeof me.email === 'string' ? me.email : undefined,
        ...(staged
          ? {
              cookieJarKey: staged.context.cookieJarKey,
              sessionId: staged.context.logicalPageId,
            }
          : {}),
      });
      this.rememberPendingVerificationSession(resolvedDeviceId, staged);
      return connection;
    } catch (error) {
      this.discardVerificationSession(staged);
      throw error;
    }
  }

  /**
   * Fill the identity leaves. Both lookups are best-effort: a connection without an
   * account id still chats (the header is optional), and a failed probe must never
   * discard a freshly redeemed, single-use grant.
   */
  protected async buildConnection(params: {
    accessToken: string;
    /**
     * Staged verification jar. When present, identity probes must use this
     * instead of binding the live context with the candidate device id.
     */
    cookieJarKey?: string;
    deviceId: string;
    fallbackEmail?: string;
    idToken?: string;
    refreshToken?: string;
    sessionId?: string;
    /** Caller's whole-operation deadline; each probe intersects it with its own cap. */
    signal?: AbortSignal;
  }): Promise<ChatGPTWebConnection> {
    const probe = {
      ...(params.cookieJarKey ? { cookieJarKey: params.cookieJarKey } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    };
    const email =
      extractChatGPTWebEmail(params.idToken, params.accessToken) ??
      params.fallbackEmail ??
      // Code exchange with a token that carries no email claim (org accounts do this):
      // ask the backend, best-effort. The admin card names the shared account, so an
      // unnamed connection is a real usability loss — but never worth failing a grant for.
      (await this.fetchEmail(params.accessToken, params.deviceId, params.signal, probe));
    const accountId =
      extractChatGPTAccountId(params.idToken, params.accessToken) ??
      (await this.fetchAccountId(params.accessToken, params.deviceId, params.signal, probe));
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

  private identityProbeHeaders(
    accessToken: string,
    deviceId: string,
    probe?: { cookieJarKey?: string; sessionId?: string },
  ): Record<string, string> {
    return withCookieJarHeader(
      sessionHeaders(
        accessToken,
        deviceId,
        probe?.sessionId ?? this.pageSessionId(deviceId),
        this.browserProfile,
      ),
      probe?.cookieJarKey ?? this.cookieJarKeyFor(deviceId),
    );
  }

  /** Best-effort `/backend-api/me`; a failure only costs the account's display name. */
  private async fetchEmail(
    accessToken: string,
    deviceId: string,
    budget?: AbortSignal,
    probe?: { cookieJarKey?: string; sessionId?: string },
  ): Promise<string | undefined> {
    try {
      const response = await this.transportFetch(`${CHATGPT_BASE}${ME_PATH}`, {
        headers: this.identityProbeHeaders(accessToken, deviceId, probe),
        method: 'GET',
        signal: ChatGPTWebOAuthIdentityOps.probeSignal(EMAIL_FALLBACK_TIMEOUT_MS, budget),
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
    probe?: { cookieJarKey?: string; sessionId?: string },
  ): Promise<string | undefined> {
    try {
      const response = await this.transportFetch(
        `${CHATGPT_BASE}${accountsCheckPath(this.browserProfile)}`,
        {
          headers: this.identityProbeHeaders(accessToken, deviceId, probe),
          method: 'GET',
          signal: ChatGPTWebOAuthIdentityOps.probeSignal(IDENTITY_REQUEST_TIMEOUT_MS, budget),
        },
      );
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
