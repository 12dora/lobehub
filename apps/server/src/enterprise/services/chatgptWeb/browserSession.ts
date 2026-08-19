/**
 * ChatGPT Web adapter over the common Browser Session Context (plan C1/G3/G5/G7).
 *
 * Lookup is provider + AIHub connection owner + origin — never the ChatGPT
 * device id. Two stored connections that happen to share an `oai-did` (the same
 * physical browser pasted for two accounts) therefore cannot share a jar,
 * page session id, bootstrap cache, or Sentinel pool slot.
 */

import { randomUUID } from 'node:crypto';

import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import { isFallbackBrowserProfile } from '@lobechat/model-runtime/browserProfile';
import type { ChatGPTWebSessionContext } from '@lobechat/model-runtime/chatgptWebIdentity';
import { getSharedSentinelBundlePool } from '@lobechat/model-runtime/chatgptWebIdentity';

import {
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
import type { BrowserSessionContext } from '@/server/enterprise/services/browserSession/types';

import { CHATGPT_WEB_SESSION_COOKIE_NAME } from './sessionCookie';
import { registerContextCookieJar, unregisterContextCookieJar } from './transport/cookieJar';

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

const wrapHandle = (context: BrowserSessionContext): ChatGPTWebSessionContext => ({
  contextId: context.contextId,
  cookieJarKey: context.cookieJar.digest,
  getBootstrap: () => getBrowserSessionProviderState(context, PROVIDER_STATE_NS),
  logicalPageId: context.logicalPageId,
  setBootstrap: (state) => setBrowserSessionProviderState(context, PROVIDER_STATE_NS, state),
});

const bindJar = (context: BrowserSessionContext, deviceId?: string): void => {
  registerContextCookieJar(context.cookieJar.digest, context.cookieJar.path);
  if (!deviceId) return;
  seedBrowserCookieJar(context.cookieJar.path, [
    { domain: '.chatgpt.com', name: 'oai-did', value: deviceId },
  ]);
};

const toAcquireInput = (params: BindChatGPTWebBrowserSessionParams) => ({
  accountId: params.accountId,
  browserProfileRevision: params.browserProfileRevision ?? 0,
  ...(params.deviceId ? { deviceId: params.deviceId } : {}),
  impersonationProfileRevision: params.browserProfile.id,
  origin: CHATGPT_WEB_BROWSER_SESSION_ORIGIN,
  provider: CHATGPT_WEB_BROWSER_SESSION_PROVIDER,
});

/**
 * Unregister the jar-path mapping and drop the Sentinel slot, then invalidate
 * the registry context. `acquire()`'s binding-mismatch drop does neither of
 * the provider-specific steps — callers that are about to replace a live
 * context must go through this instead.
 */
const dropChatGPTWebBrowserContext = (context: BrowserSessionContext): void => {
  const digest = context.cookieJar.digest;
  const contextId = context.contextId;
  getBrowserSessionRegistry().invalidate(contextId);
  unregisterContextCookieJar(digest);
  getSharedSentinelBundlePool().invalidate(contextId);
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
 */
export const bindChatGPTWebBrowserSession = (
  params: BindChatGPTWebBrowserSessionParams,
): ChatGPTWebSessionContext | undefined => {
  if (!params.accountId.trim()) return undefined;
  if (isFallbackBrowserProfile(params.browserProfile)) return undefined;

  // `acquire()` drops a binding-mismatch context without ChatGPT-specific
  // cleanup (jar-path unregister + Sentinel slot). Peek first and go through
  // the same drop path the staged-commit / rotate callers already use.
  const existing = getBrowserSessionRegistry().getForIdentity(chatgptWebIdentity(params.accountId));
  if (existing && liveBindingWouldChange(params, existing)) {
    dropChatGPTWebBrowserContext(existing);
  }

  const context = getBrowserSessionRegistry().acquire(toAcquireInput(params));
  bindJar(context, params.deviceId);
  return wrapHandle(context);
};

/**
 * Drop the current context (new page session id, new jar, new Sentinel slot)
 * and copy cookies across so Cloudflare clearance minted during connect
 * survives the rotation. Call after a successful connect/reconnect, never on
 * refresh.
 */
export const rotateChatGPTWebBrowserSession = (
  params: BindChatGPTWebBrowserSessionParams,
): ChatGPTWebSessionContext | undefined => {
  const current = bindChatGPTWebBrowserSession(params);
  if (!current) return undefined;

  const registry = getBrowserSessionRegistry();
  const existing = registry.get(current.contextId);
  if (!existing) return current;

  const cookies = readBrowserCookieJar(existing.cookieJar.path);
  dropChatGPTWebBrowserContext(existing);

  const next = bindChatGPTWebBrowserSession(params);
  if (next && cookies.length > 0) {
    const nextContext = registry.get(next.contextId);
    if (nextContext) seedBrowserCookieJar(nextContext.cookieJar.path, cookies);
  }
  return next;
};

export { resetBrowserSessionRegistryForTests } from '@/server/enterprise/services/browserSession/contextRegistry';

const chatgptWebIdentity = (accountId: string) => ({
  accountId,
  origin: CHATGPT_WEB_BROWSER_SESSION_ORIGIN,
  provider: CHATGPT_WEB_BROWSER_SESSION_PROVIDER,
});

export const invalidateChatGPTWebBrowserSession = (accountId: string): void => {
  if (!accountId.trim()) return;
  const registry = getBrowserSessionRegistry();
  const existing = registry.getForIdentity(chatgptWebIdentity(accountId));
  if (existing) {
    unregisterContextCookieJar(existing.cookieJar.digest);
    getSharedSentinelBundlePool().invalidate(existing.contextId);
  }
  registry.invalidateForIdentity(chatgptWebIdentity(accountId));
};

export interface StagedChatGPTWebBrowserSession {
  accountId: string;
  context: ChatGPTWebSessionContext;
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
  options?: { verificationSafeOnly?: boolean },
): void => {
  const registry = getBrowserSessionRegistry();
  const from = registry.get(fromContextId);
  const to = registry.get(toContextId);
  if (!from || !to) return;
  const cookies = readBrowserCookieJar(from.cookieJar.path).filter((cookie) => {
    if (!options?.verificationSafeOnly) return true;
    if (isLiveSessionAuthCookie(cookie.name)) return false;
    return isAllowedCookieName(cookie.name, [...STAGED_VERIFICATION_COOKIE_NAMES]);
  });
  if (cookies.length > 0) seedBrowserCookieJar(to.cookieJar.path, cookies);
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

  try {
    const context = bindChatGPTWebBrowserSession({ ...params, accountId: pendingAccountId });
    if (!context) return undefined;
    if (live) copyContextCookies(live.contextId, context.contextId, { verificationSafeOnly: true });
    return { accountId: pendingAccountId, context };
  } catch (error) {
    invalidateChatGPTWebBrowserSession(pendingAccountId);
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
 */
export const commitStagedChatGPTWebBrowserSession = (
  liveParams: BindChatGPTWebBrowserSessionParams,
  stagedAccountId: string,
): ChatGPTWebSessionContext | undefined => {
  const staged = bindChatGPTWebBrowserSession({ ...liveParams, accountId: stagedAccountId });
  const live = bindChatGPTWebBrowserSession(liveParams);
  if (live) {
    const liveContext = getBrowserSessionRegistry().get(live.contextId);
    if (liveContext) clearSessionAuthCookieFamily(liveContext.cookieJar.path);
  }
  if (staged && live) copyContextCookies(staged.contextId, live.contextId);
  return live;
};
