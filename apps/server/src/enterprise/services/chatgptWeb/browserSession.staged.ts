import { randomUUID } from 'node:crypto';

import type { ChatGPTWebSessionContext } from '@lobechat/model-runtime/chatgptWebIdentity';
import debug from 'debug';

import {
  assertWritable,
  getBrowserSessionRegistry,
} from '@/server/enterprise/services/browserSession/contextRegistry';
import {
  isAllowedCookieName,
  isCookieFamilyMember,
  readBrowserCookieJar,
  replaceBrowserCookieFamily,
  seedBrowserCookieJar,
} from '@/server/enterprise/services/browserSession/cookieJar';
import type {
  BrowserSessionContext,
  BrowserSessionWriteFence,
} from '@/server/enterprise/services/browserSession/types';
import {
  BrowserSessionError,
  isBrowserSessionResettingError,
} from '@/server/enterprise/services/browserSession/types';

import {
  bindChatGPTWebBrowserSession,
  type BindChatGPTWebBrowserSessionParams,
  chatgptWebIdentity,
  dropChatGPTWebBrowserContext,
  invalidateChatGPTWebBrowserSession,
  liveBindingWouldChange,
} from './browserSession.core';
import { CHATGPT_WEB_SESSION_COOKIE_NAME } from './sessionCookie';

const log = debug('lobe-server:chatgpt-web-browser-session');

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

const LIVE_FENCE_STATE_KEY = 'liveFence';

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

const abortCommitIfFenceChanged = (
  capturedFence: BrowserSessionWriteFence | null | undefined,
  livePeek: BrowserSessionContext | undefined,
): boolean => {
  // Exact match: absent stays absent; present stays that generation.
  // Absent→created, captured→disappeared, and a newer generation all abort.
  if (capturedFence === undefined) {
    log('commit aborted: staged live fence was not recorded');
    return true;
  }
  if (capturedFence === null) {
    if (livePeek) {
      log('commit aborted: live context appeared after staging');
      return true;
    }
  } else if (!livePeek) {
    log('commit aborted: captured live context disappeared');
    return true;
  } else if (
    livePeek.contextId !== capturedFence.contextId ||
    livePeek.revision !== capturedFence.revision
  ) {
    log('commit aborted: live generation changed under the staged fence');
    return true;
  }
  return false;
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

  if (abortCommitIfFenceChanged(capturedFence, livePeek)) return undefined;

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
