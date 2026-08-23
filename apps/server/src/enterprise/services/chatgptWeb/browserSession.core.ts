/**
 * ChatGPT Web adapter over the common Browser Session Context (plan C1/G3/G5/G7/C4).
 *
 * Lookup is provider + AIHub connection owner + origin — never the ChatGPT
 * device id. Two stored connections that happen to share an `oai-did` (the same
 * physical browser pasted for two accounts) therefore cannot share a jar,
 * page session id, bootstrap cache, or Sentinel pool slot.
 */

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
  readBrowserCookieJar,
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
  registerContextCookieJar,
  toContextCookieJarKey,
  unregisterContextCookieJar,
} from './transport/cookieJar';

const log = debug('lobe-server:chatgpt-web-browser-session');

export const CHATGPT_WEB_BROWSER_SESSION_PROVIDER = 'chatgptweb';
export const CHATGPT_WEB_BROWSER_SESSION_ORIGIN = 'https://chatgpt.com';

const PROVIDER_STATE_NS = 'chatgptWeb';

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

export const chatgptWebIdentity = (accountId: string) => ({
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

export const dropChatGPTWebBrowserContext = (context: BrowserSessionContext): void => {
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

export const liveBindingWouldChange = (
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
