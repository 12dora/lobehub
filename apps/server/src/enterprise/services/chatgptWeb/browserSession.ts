/**
 * ChatGPT Web adapter over the common Browser Session Context (plan C1/G3/G5/G7/C4).
 *
 * Lookup is provider + AIHub connection owner + origin — never the ChatGPT
 * device id. Two stored connections that happen to share an `oai-did` (the same
 * physical browser pasted for two accounts) therefore cannot share a jar,
 * page session id, bootstrap cache, or Sentinel pool slot.
 */

import { randomUUID } from 'node:crypto';

import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import { isFallbackBrowserProfile } from '@lobechat/model-runtime/browserProfile';
import type {
  ChatGPTWebSessionContext,
  SentinelBundleMintFn,
} from '@lobechat/model-runtime/chatgptWebIdentity';
import {
  getSharedSentinelBundlePool,
  startChatGPTWebSentinelKeepWarm,
  stopChatGPTWebSentinelKeepWarm,
} from '@lobechat/model-runtime/chatgptWebIdentity';
import debug from 'debug';

import {
  assertWritable,
  getBrowserSessionProviderState,
  getBrowserSessionRegistry,
  setBrowserSessionProviderState,
} from '@/server/enterprise/services/browserSession/contextRegistry';
import {
  isAllowedCookieName,
  isCookieFamilyMember,
  readBrowserCookieJar,
  replaceBrowserCookieFamily,
  seedBrowserCookieJar,
} from '@/server/enterprise/services/browserSession/cookieJar';
import {
  buildBrowserSessionBindingDigest,
  normalizeBrowserSessionAcquireInput,
} from '@/server/enterprise/services/browserSession/identity';
import {
  onBrowserSessionBeforeDispose,
  onBrowserSessionInvalidate,
} from '@/server/enterprise/services/browserSession/lifecycle';
import type {
  BrowserSessionContext,
  BrowserSessionWriteFence,
} from '@/server/enterprise/services/browserSession/types';
import {
  BrowserSessionError,
  isBrowserSessionResettingError,
} from '@/server/enterprise/services/browserSession/types';

import { CHATGPT_WEB_SESSION_COOKIE_NAME } from './sessionCookie';
import {
  registerContextCookieJar,
  toContextCookieJarKey,
  unregisterContextCookieJar,
} from './transport/cookieJar';

const log = debug('lobe-server:chatgpt-web-browser-session');

export const CHATGPT_WEB_BROWSER_SESSION_PROVIDER = 'chatgptweb';
export const CHATGPT_WEB_BROWSER_SESSION_ORIGIN = 'https://chatgpt.com';

const PROVIDER_STATE_NS = 'chatgptWeb';
const LIVE_FENCE_STATE_KEY = 'liveFence';

export type ChatGPTWebBrowserSessionOwner =
  | { kind: 'platform'; providerId: string; revision?: number }
  | { kind: 'user'; providerId: string; userId: string; workspaceId?: string };

export interface BindChatGPTWebBrowserSessionParams {
  accountId: string;
  browserProfile: Pick<BrowserDeviceProfile, 'id'>;
  browserProfileRevision?: number;
  deviceId?: string;
  ephemeral?: boolean;
  /**
   * Optional Sentinel mint used to keep-warm the pool after bind/rotate.
   * The handshake lives on ChatGPTWebClient; this adapter never constructs one.
   * Must never throw into the bind path.
   */
  sentinelMint?: SentinelBundleMintFn;
}

/**
 * Stable AIHub connection handle. Must be:
 * - the same across reconnects of THIS stored connection (so jar / bootstrap
 *   cache actually reuse);
 * - different for every other stored connection, even when they share `oai-did`.
 *
 * ChatGPT's own account UUID (`oauthAccountId`) is deliberately NOT used here:
 * it is unknown until after `/api/auth/session` + `/me`, and minting those
 * calls has to share the jar the later runtime will use.
 */
export const buildChatGPTWebBrowserSessionAccountId = (
  owner: ChatGPTWebBrowserSessionOwner,
): string => {
  if (owner.kind === 'platform') {
    return owner.revision == null
      ? `platform:${owner.providerId}`
      : `platform:${owner.providerId}:rev:${owner.revision}`;
  }
  const workspace = owner.workspaceId?.trim() || '_';
  return `user:${owner.userId}:${workspace}:${owner.providerId}`;
};

const chatgptWebIdentity = (accountId: string) => ({
  accountId,
  origin: CHATGPT_WEB_BROWSER_SESSION_ORIGIN,
  provider: CHATGPT_WEB_BROWSER_SESSION_PROVIDER,
});

const cookieJarKeyFor = (context: BrowserSessionContext): string =>
  toContextCookieJarKey(context.cookieJar.digest);

onBrowserSessionBeforeDispose((context) => {
  if (context.provider !== CHATGPT_WEB_BROWSER_SESSION_PROVIDER) return;
  unregisterContextCookieJar(cookieJarKeyFor(context));
});

onBrowserSessionInvalidate((context) => {
  if (context.provider !== CHATGPT_WEB_BROWSER_SESSION_PROVIDER) return;
  getSharedSentinelBundlePool().invalidate(context.contextId);
  stopChatGPTWebSentinelKeepWarm(context.contextId);
});

const wrapHandle = (context: BrowserSessionContext): ChatGPTWebSessionContext => {
  const fence: BrowserSessionWriteFence = {
    contextId: context.contextId,
    revision: context.revision,
  };
  let released = false;
  context.inFlight += 1;
  context.lastUsedAt = Date.now();
  return {
    contextId: context.contextId,
    cookieJarKey: cookieJarKeyFor(context),
    getBootstrap: () => getBrowserSessionProviderState(context, PROVIDER_STATE_NS),
    logicalPageId: context.logicalPageId,
    release: () => {
      if (released) return;
      released = true;
      if (context.inFlight > 0) context.inFlight -= 1;
    },
    revision: context.revision,
    setBootstrap: (state) =>
      setBrowserSessionProviderState(context, PROVIDER_STATE_NS, state, fence),
  };
};

const bindJar = (context: BrowserSessionContext, deviceId?: string): void => {
  if (!assertWritable(context)) return;
  registerContextCookieJar(
    cookieJarKeyFor(context),
    context.cookieJar.path,
    context.transportPoolKey,
  );
  if (!deviceId) return;
  seedBrowserCookieJar(context.cookieJar.path, [
    { domain: '.chatgpt.com', name: 'oai-did', value: deviceId },
  ]);
};

const toAcquireInput = (params: BindChatGPTWebBrowserSessionParams) => ({
  accountId: params.accountId,
  browserProfileRevision: params.browserProfileRevision ?? 0,
  ...(params.deviceId ? { deviceId: params.deviceId } : {}),
  ...(params.ephemeral ? { ephemeral: true } : {}),
  impersonationProfileRevision: params.browserProfile.id,
  origin: CHATGPT_WEB_BROWSER_SESSION_ORIGIN,
  provider: CHATGPT_WEB_BROWSER_SESSION_PROVIDER,
});

const dropChatGPTWebBrowserContext = (context: BrowserSessionContext): void => {
  unregisterContextCookieJar(cookieJarKeyFor(context));
  getSharedSentinelBundlePool().invalidate(context.contextId);
  stopChatGPTWebSentinelKeepWarm(context.contextId);
  getBrowserSessionRegistry().invalidate(context.contextId);
};

/**
 * Mint a Sentinel bundle for this context without blocking bind/rotate.
 * Failures are logged; a missing mint is a no-op (the next chat still acquires).
 */
export const warmChatGPTWebSentinelAfterBind = (
  context: ChatGPTWebSessionContext | undefined,
  params: BindChatGPTWebBrowserSessionParams,
): void => {
  try {
    if (!context || !params.sentinelMint) return;
    startChatGPTWebSentinelKeepWarm(
      {
        contextKey: context.contextId,
        deviceId: params.deviceId ?? context.logicalPageId,
        profileId: params.browserProfile.id,
        sessionId: context.logicalPageId,
      },
      params.sentinelMint,
    );
  } catch (error) {
    log('sentinel warm after bind failed: %s', error instanceof Error ? error.message : error);
  }
};

const liveBindingWouldChange = (
  params: BindChatGPTWebBrowserSessionParams,
  existing: BrowserSessionContext,
): boolean =>
  existing.bindingDigest !==
  buildBrowserSessionBindingDigest(normalizeBrowserSessionAcquireInput(toAcquireInput(params)));

/**
 * Acquire (or reuse) the ChatGPT Web Browser Session Context for this stored
 * connection. Returns undefined on the degraded fallback profile so we never
 * replay a persisted jar behind a different UA/TLS fingerprint.
 *
 * Increments `inFlight`. Callers that are not holding a turn must `release()`.
 */
export const bindChatGPTWebBrowserSession = (
  params: BindChatGPTWebBrowserSessionParams,
): ChatGPTWebSessionContext | undefined => {
  if (!params.accountId.trim()) return undefined;
  if (isFallbackBrowserProfile(params.browserProfile)) return undefined;

  const existing = getBrowserSessionRegistry().getForIdentity(chatgptWebIdentity(params.accountId));
  if (existing && liveBindingWouldChange(params, existing)) {
    dropChatGPTWebBrowserContext(existing);
  }

  const context = getBrowserSessionRegistry().acquire(toAcquireInput(params));
  bindJar(context, params.deviceId);
  const handle = wrapHandle(context);
  warmChatGPTWebSentinelAfterBind(handle, params);
  return handle;
};

/**
 * Drop the current context (new page session id, new jar, new Sentinel slot)
 * and copy cookies across so Cloudflare clearance minted during connect
 * survives the rotation. Call after a successful connect/reconnect, never on
 * refresh.
 *
 * After rotate, fire-and-forget Sentinel keep-warm when a mint is supplied
 * (OAuth connect / tests). Never throws into the bind path.
 */
export const rotateChatGPTWebBrowserSession = (
  params: BindChatGPTWebBrowserSessionParams,
): ChatGPTWebSessionContext | undefined => {
  const current = bindChatGPTWebBrowserSession(params);
  if (!current) return undefined;

  const registry = getBrowserSessionRegistry();
  const existing = registry.get(current.contextId);
  if (!existing) {
    current.release?.();
    return current;
  }

  const fence: BrowserSessionWriteFence = {
    contextId: existing.contextId,
    revision: existing.revision,
  };
  const cookies = assertWritable(existing, fence)
    ? readBrowserCookieJar(existing.cookieJar.path)
    : [];
  dropChatGPTWebBrowserContext(existing);
  current.release?.();

  const next = bindChatGPTWebBrowserSession(params);
  if (next && cookies.length > 0) {
    const nextContext = registry.get(next.contextId);
    if (nextContext && nextContext.revision === 1) {
      seedBrowserCookieJar(nextContext.cookieJar.path, cookies);
    }
  }
  return next;
};

export {
  installBrowserSessionRegistryForTests,
  resetBrowserSessionRegistryForTests,
} from '@/server/enterprise/services/browserSession/contextRegistry';

export const invalidateChatGPTWebBrowserSession = (accountId: string): void => {
  if (!accountId.trim()) return;
  const registry = getBrowserSessionRegistry();
  const existing = registry.getForIdentity(chatgptWebIdentity(accountId));
  if (existing) {
    unregisterContextCookieJar(cookieJarKeyFor(existing));
    getSharedSentinelBundlePool().invalidate(existing.contextId);
  }
  registry.invalidateForIdentity(chatgptWebIdentity(accountId));
};

export interface StagedChatGPTWebBrowserSession {
  accountId: string;
  context: ChatGPTWebSessionContext;
  /** Exact live generation at stage time. `null` means no live context existed. */
  liveFence: BrowserSessionWriteFence | null;
}

/**
 * Anti-bot cookies that are safe to copy onto a verification probe. The
 * NextAuth session-token family is never in this list — an access-token
 * `/me` probe must not authenticate via an inherited live session cookie.
 */
const STAGED_VERIFICATION_COOKIE_NAMES = ['cf_clearance', '__cf_bm', '_cfuvid'] as const;

const isLiveSessionAuthCookie = (name: string): boolean =>
  isCookieFamilyMember(name, CHATGPT_WEB_SESSION_COOKIE_NAME);

const CHATGPT_WEB_SESSION_COOKIE_DOMAIN = '.chatgpt.com';
const CHATGPT_WEB_SESSION_COOKIE_PATH = '/';

/**
 * Remove the NextAuth session-token family (base name and `.N` chunks) from a
 * jar. `seedBrowserCookieJar` only replaces families present in the incoming
 * set, so a staged access-token jar — which never carries a session cookie —
 * would otherwise leave a previous account's token sitting on the live jar.
 */
const clearSessionAuthCookieFamily = (jarPath: string): void => {
  const locations = new Map<string, { domain: string; path: string }>([
    [
      `${CHATGPT_WEB_SESSION_COOKIE_DOMAIN}\0${CHATGPT_WEB_SESSION_COOKIE_PATH}`,
      {
        domain: CHATGPT_WEB_SESSION_COOKIE_DOMAIN,
        path: CHATGPT_WEB_SESSION_COOKIE_PATH,
      },
    ],
  ]);
  for (const cookie of readBrowserCookieJar(jarPath)) {
    if (!isLiveSessionAuthCookie(cookie.name)) continue;
    locations.set(`${cookie.domain}\0${cookie.path}`, {
      domain: cookie.domain,
      path: cookie.path,
    });
  }
  for (const { domain, path } of locations.values()) {
    replaceBrowserCookieFamily(jarPath, {
      cookies: [],
      domain,
      familyName: CHATGPT_WEB_SESSION_COOKIE_NAME,
      path,
    });
  }
};

const copyContextCookies = (
  fromContextId: string,
  toContextId: string,
  options?: { expectedLiveFence?: BrowserSessionWriteFence; verificationSafeOnly?: boolean },
): boolean => {
  const registry = getBrowserSessionRegistry();
  const from = registry.get(fromContextId);
  const to = registry.get(toContextId);
  if (!from || !to) return false;
  if (from.lifecycle !== 'active' || to.lifecycle !== 'active') return false;
  if (options?.expectedLiveFence && !assertWritable(to, options.expectedLiveFence)) return false;
  const cookies = readBrowserCookieJar(from.cookieJar.path).filter((cookie) => {
    if (!options?.verificationSafeOnly) return true;
    if (isLiveSessionAuthCookie(cookie.name)) return false;
    return isAllowedCookieName(cookie.name, [...STAGED_VERIFICATION_COOKIE_NAMES]);
  });
  if (cookies.length > 0) seedBrowserCookieJar(to.cookieJar.path, cookies);
  return true;
};

type StoredLiveFence = { present: false } | { present: true; contextId: string; revision: number };

const rememberLiveFence = (
  staged: BrowserSessionContext,
  liveFence: BrowserSessionWriteFence | null,
): void => {
  const stored: StoredLiveFence = liveFence
    ? { contextId: liveFence.contextId, present: true, revision: liveFence.revision }
    : { present: false };
  staged.providerState[LIVE_FENCE_STATE_KEY] = stored;
};

const readLiveFence = (
  staged: BrowserSessionContext,
): BrowserSessionWriteFence | null | undefined => {
  const raw = staged.providerState[LIVE_FENCE_STATE_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const stored = raw as Partial<StoredLiveFence> & { present?: unknown };
  if (stored.present === false) return null;
  if (
    stored.present === true &&
    typeof stored.contextId === 'string' &&
    typeof stored.revision === 'number'
  ) {
    return { contextId: stored.contextId, revision: stored.revision };
  }
  return undefined;
};

/**
 * A throwaway context for connect/verify. Candidate session cookies are written
 * here so a failed reconnect cannot corrupt the live jar, and a candidate for a
 * different ChatGPT account cannot ride the live account's cookie family.
 *
 * Live Cloudflare cookies are copied in (read-only) so clearance minted under
 * the same device can still help the verification request. The live session
 * cookie family is never copied — access-token `/me` must depend only on the
 * candidate Bearer token.
 *
 * The live context is peeked by lookup key, never re-acquired with the
 * candidate device id: a changed device must not drop a working connection
 * as a side effect of merely staging a probe.
 */
export const stageChatGPTWebBrowserSession = (
  params: BindChatGPTWebBrowserSessionParams,
): StagedChatGPTWebBrowserSession | undefined => {
  if (!params.accountId.trim()) return undefined;
  const pendingAccountId = `${params.accountId}:pending:${randomUUID()}`;
  const live = getBrowserSessionRegistry().getForIdentity(chatgptWebIdentity(params.accountId));
  const liveFence: BrowserSessionWriteFence | null = live
    ? { contextId: live.contextId, revision: live.revision }
    : null;

  try {
    const context = bindChatGPTWebBrowserSession({
      ...params,
      accountId: pendingAccountId,
      ephemeral: true,
    });
    if (!context) return undefined;
    const stagedContext = getBrowserSessionRegistry().get(context.contextId);
    if (stagedContext) rememberLiveFence(stagedContext, liveFence);
    if (live) copyContextCookies(live.contextId, context.contextId, { verificationSafeOnly: true });
    // Staged contexts must stay evictable on the 2-minute ephemeral TTL.
    context.release?.();
    return { accountId: pendingAccountId, context, liveFence };
  } catch (error) {
    invalidateChatGPTWebBrowserSession(pendingAccountId);
    if (isBrowserSessionResettingError(error)) throw error;
    if (error instanceof BrowserSessionError) return undefined;
    throw error;
  }
};

/**
 * After durable persist succeeds, copy the staged jar (candidate session + any
 * CF cookies minted during the probe) onto the live context. Must not run
 * before the vault write: a persist failure would otherwise leave the live
 * jar holding the new account's session next to the old vault credential.
 *
 * Does not rotate the page session — the connect path does that once the
 * whole operation commits. The staged identity is left for the caller to
 * invalidate.
 *
 * A device-changing bind drops the previous live context with the same
 * provider-specific cleanup as {@link rotateChatGPTWebBrowserSession} (jar-path
 * unregister + Sentinel slot invalidate) rather than relying on `acquire()`'s
 * bare binding-mismatch drop. Cookie copy onto the replacement is not
 * transactional: a mid-copy failure can leave the old context already gone.
 *
 * If live `contextId` / `revision` changed since stage and this commit is not
 * itself the device-change drop, abort and leave live untouched.
 */
export const commitStagedChatGPTWebBrowserSession = (
  liveParams: BindChatGPTWebBrowserSessionParams,
  stagedAccountId: string,
): ChatGPTWebSessionContext | undefined => {
  const registry = getBrowserSessionRegistry();
  const stagedContext = registry.getForIdentity(chatgptWebIdentity(stagedAccountId));
  if (!stagedContext || stagedContext.lifecycle !== 'active') return undefined;

  const capturedFence = readLiveFence(stagedContext);
  const livePeek = registry.getForIdentity(chatgptWebIdentity(liveParams.accountId));

  // Exact match: absent stays absent; present stays that generation.
  // Absent→created, captured→disappeared, and a newer generation all abort.
  if (capturedFence === undefined) {
    log('commit aborted: staged live fence was not recorded');
    return undefined;
  }
  if (capturedFence === null) {
    if (livePeek) {
      log('commit aborted: live context appeared after staging');
      return undefined;
    }
  } else if (!livePeek) {
    log('commit aborted: captured live context disappeared');
    return undefined;
  } else if (
    livePeek.contextId !== capturedFence.contextId ||
    livePeek.revision !== capturedFence.revision
  ) {
    log('commit aborted: live generation changed under the staged fence');
    return undefined;
  }

  // Device-changing commit may drop ONLY the exact captured generation.
  if (livePeek && liveBindingWouldChange(liveParams, livePeek)) {
    dropChatGPTWebBrowserContext(livePeek);
  }

  const live = bindChatGPTWebBrowserSession(liveParams);
  if (live) {
    const liveContext = registry.get(live.contextId);
    if (liveContext) clearSessionAuthCookieFamily(liveContext.cookieJar.path);
  }
  if (live) copyContextCookies(stagedContext.contextId, live.contextId);
  live?.release?.();
  return live;
};

export const peekChatGPTWebBrowserSessionFence = (
  accountId: string,
): BrowserSessionWriteFence | undefined => {
  const context = getBrowserSessionRegistry().getForIdentity(chatgptWebIdentity(accountId));
  if (!context) return undefined;
  return { contextId: context.contextId, revision: context.revision };
};

export const isChatGPTWebBrowserSessionFenceCurrent = (
  fence: BrowserSessionWriteFence | undefined,
): boolean => {
  if (!fence) return false;
  const context = getBrowserSessionRegistry().get(fence.contextId);
  return Boolean(context && assertWritable(context, fence));
};
