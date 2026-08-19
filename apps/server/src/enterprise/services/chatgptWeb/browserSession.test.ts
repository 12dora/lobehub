import { existsSync, readFileSync } from 'node:fs';

import { generateBrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import { getSharedSentinelBundlePool } from '@lobechat/model-runtime/chatgptWebIdentity';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBrowserSessionRegistry,
  disposeAllBrowserSessions,
  getBrowserSessionRegistry,
  installBrowserSessionRegistryForTests,
  resetBrowserSessionRegistryForTests,
} from '@/server/enterprise/services/browserSession/contextRegistry';
import * as BrowserCookieJar from '@/server/enterprise/services/browserSession/cookieJar';
import {
  readBrowserCookieJar,
  resetBrowserCookieJars,
} from '@/server/enterprise/services/browserSession/cookieJar';

import {
  bindChatGPTWebBrowserSession,
  buildChatGPTWebBrowserSessionAccountId,
  commitStagedChatGPTWebBrowserSession,
  invalidateChatGPTWebBrowserSession,
  rotateChatGPTWebBrowserSession,
  stageChatGPTWebBrowserSession,
} from './browserSession';
import {
  isContextCookieJarKey,
  resetCookieJars,
  resolveCookieJarPath,
  seedCookieJar,
} from './transport';

const profile = generateBrowserDeviceProfile({ seed: 'chatgptweb-g3-g5-g7' });
const SAME_DEVICE = 'oai-did-shared-physical-browser';

afterEach(async () => {
  await Promise.resolve(resetCookieJars());
  await resetBrowserSessionRegistryForTests();
  resetBrowserCookieJars();
  vi.restoreAllMocks();
});

const bind = (
  accountId: string,
  deviceId = SAME_DEVICE,
  browserProfile: typeof profile = profile,
) =>
  bindChatGPTWebBrowserSession({
    accountId,
    browserProfile,
    deviceId,
  });

describe('buildChatGPTWebBrowserSessionAccountId', () => {
  it('is stable for the same stored connection and different across owners', () => {
    const platform = buildChatGPTWebBrowserSessionAccountId({
      kind: 'platform',
      providerId: 'chatgptweb',
    });
    const userA = buildChatGPTWebBrowserSessionAccountId({
      kind: 'user',
      providerId: 'chatgptweb',
      userId: 'user-a',
    });
    const userB = buildChatGPTWebBrowserSessionAccountId({
      kind: 'user',
      providerId: 'chatgptweb',
      userId: 'user-b',
    });

    expect(platform).toBe('platform:chatgptweb');
    expect(platform).toBe(
      buildChatGPTWebBrowserSessionAccountId({ kind: 'platform', providerId: 'chatgptweb' }),
    );
    expect(userA).not.toBe(userB);
    expect(userA).not.toBe(platform);
    expect(userA).not.toContain(SAME_DEVICE);
    expect(platform).not.toContain(SAME_DEVICE);
  });

  it('namespaces workspace-scoped user connections', () => {
    const personal = buildChatGPTWebBrowserSessionAccountId({
      kind: 'user',
      providerId: 'chatgptweb',
      userId: 'user-a',
    });
    const workspace = buildChatGPTWebBrowserSessionAccountId({
      kind: 'user',
      providerId: 'chatgptweb',
      userId: 'user-a',
      workspaceId: 'ws-1',
    });
    expect(personal).not.toBe(workspace);
  });

  it('distinguishes historical platform revisions from the current pointer', () => {
    const current = buildChatGPTWebBrowserSessionAccountId({
      kind: 'platform',
      providerId: 'chatgptweb',
    });
    const revision1 = buildChatGPTWebBrowserSessionAccountId({
      kind: 'platform',
      providerId: 'chatgptweb',
      revision: 1,
    });
    const revision2 = buildChatGPTWebBrowserSessionAccountId({
      kind: 'platform',
      providerId: 'chatgptweb',
      revision: 2,
    });
    expect(current).toBe('platform:chatgptweb');
    expect(revision1).toBe('platform:chatgptweb:rev:1');
    expect(revision2).toBe('platform:chatgptweb:rev:2');
    expect(new Set([current, revision1, revision2]).size).toBe(3);
  });
});

describe('bindChatGPTWebBrowserSession', () => {
  it('reuses one context, page id, and jar across repeated calls for the same account', () => {
    const first = bind('user:alice:_:chatgptweb')!;
    const second = bind('user:alice:_:chatgptweb')!;

    expect(second.contextId).toBe(first.contextId);
    expect(second.logicalPageId).toBe(first.logicalPageId);
    expect(second.cookieJarKey).toBe(first.cookieJarKey);
    expect(first.cookieJarKey.startsWith('ctx:')).toBe(true);
    expect(second.logicalPageId).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
  });

  it('isolates two accounts that share a physical device id', () => {
    const alice = bind('user:alice:_:chatgptweb')!;
    const bob = bind('user:bob:_:chatgptweb')!;

    expect(alice.contextId).not.toBe(bob.contextId);
    expect(alice.logicalPageId).not.toBe(bob.logicalPageId);
    expect(alice.cookieJarKey).not.toBe(bob.cookieJarKey);
    expect(alice.cookieJarKey).not.toBe(SAME_DEVICE);
    expect(bob.cookieJarKey).not.toBe(SAME_DEVICE);
  });

  it('does not put credentials or the raw device id in the jar key', () => {
    const context = bind('user:alice:_:chatgptweb', SAME_DEVICE)!;
    expect(context.cookieJarKey).not.toBe(SAME_DEVICE);
    expect(context.cookieJarKey).not.toMatch(/sk-|session|token/i);
  });

  it('caches bootstrap state on the context so a reconstructed client can reuse it', () => {
    const first = bind('user:alice:_:chatgptweb')!;
    first.setBootstrap({
      clientBuildNumber: '424242',
      clientVersion: 'prod-live',
      powResources: { dataBuild: 'prod-live', scriptSources: ['https://chatgpt.com/cdn/pow.js'] },
    });

    const second = bind('user:alice:_:chatgptweb')!;
    expect(second.getBootstrap()).toEqual({
      clientBuildNumber: '424242',
      clientVersion: 'prod-live',
      powResources: { dataBuild: 'prod-live', scriptSources: ['https://chatgpt.com/cdn/pow.js'] },
    });
  });

  it('invalidates jar, page id, and bootstrap cache when the device changes', () => {
    const original = bind('user:alice:_:chatgptweb', 'device-one')!;
    original.setBootstrap({ clientVersion: 'prod-a' });
    const originalPage = original.logicalPageId;
    const originalJar = original.cookieJarKey;

    const rotated = bind('user:alice:_:chatgptweb', 'device-two')!;
    expect(rotated.contextId).not.toBe(original.contextId);
    expect(rotated.logicalPageId).not.toBe(originalPage);
    expect(rotated.cookieJarKey).not.toBe(originalJar);
    expect(rotated.getBootstrap()).toBeUndefined();
  });

  it('unregisters the old jar path and Sentinel slot when a non-commit bind changes the device', () => {
    const original = bind('user:alice:_:chatgptweb', 'device-one')!;
    const oldId = original.contextId;
    const oldDigest = original.cookieJarKey;
    expect(isContextCookieJarKey(oldDigest)).toBe(true);

    const invalidateSpy = vi.spyOn(getSharedSentinelBundlePool(), 'invalidate');
    const rotated = bind('user:alice:_:chatgptweb', 'device-two')!;

    expect(rotated.contextId).not.toBe(oldId);
    expect(getBrowserSessionRegistry().get(oldId)).toBeUndefined();
    expect(isContextCookieJarKey(oldDigest)).toBe(true);
    expect(() => resolveCookieJarPath(oldDigest)).toThrow(
      'fetch failed: browser session context is gone',
    );
    expect(invalidateSpy).toHaveBeenCalledWith(oldId);
  });

  it('invalidateChatGPTWebBrowserSession drops the account context', () => {
    const original = bind('user:alice:_:chatgptweb')!;
    invalidateChatGPTWebBrowserSession('user:alice:_:chatgptweb');
    const next = bind('user:alice:_:chatgptweb')!;
    expect(next.contextId).not.toBe(original.contextId);
    expect(next.logicalPageId).not.toBe(original.logicalPageId);
  });
});

describe('stageChatGPTWebBrowserSession', () => {
  it('copies live cookies into a distinct jar and leaves the live jar untouched', () => {
    const live = bind('user:alice:_:chatgptweb')!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);

    const staged = stageChatGPTWebBrowserSession({
      accountId: 'user:alice:_:chatgptweb',
      browserProfile: profile,
      deviceId: SAME_DEVICE,
    })!;

    expect(staged.context.contextId).not.toBe(live.contextId);
    expect(staged.context.cookieJarKey).not.toBe(live.cookieJarKey);
    expect(staged.accountId).toContain(':pending:');

    const liveCookies = readBrowserCookieJar(livePath);
    expect(
      liveCookies.some((cookie) => cookie.name === '_cfuvid' && cookie.value === 'cf-live'),
    ).toBe(true);
    const stagedCookies = readBrowserCookieJar(resolveCookieJarPath(staged.context.cookieJarKey));
    expect(
      stagedCookies.some((cookie) => cookie.name === '_cfuvid' && cookie.value === 'cf-live'),
    ).toBe(true);

    seedCookieJar(resolveCookieJarPath(staged.context.cookieJarKey), [
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-candidate' },
    ]);
    expect(readFileSync(livePath, 'utf8')).toContain('_cfuvid\tcf-live');
    expect(readFileSync(livePath, 'utf8')).not.toContain('cf-candidate');
  });

  it('does not invalidate the live context when the candidate device id differs', () => {
    const live = bind('user:alice:_:chatgptweb', 'device-live')!;
    const liveId = live.contextId;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedCookieJar(livePath, [
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' },
      {
        domain: '.chatgpt.com',
        name: '__Secure-next-auth.session-token',
        value: 'live-session',
      },
    ]);

    const staged = stageChatGPTWebBrowserSession({
      accountId: 'user:alice:_:chatgptweb',
      browserProfile: profile,
      deviceId: 'device-candidate',
    })!;

    expect(staged.context.contextId).not.toBe(liveId);
    const stillLive = getBrowserSessionRegistry().get(liveId);
    expect(stillLive?.lifecycle).toBe('active');
    expect(live.cookieJarKey).toBe(`ctx:${stillLive?.cookieJar.digest}`);
    expect(existsSync(livePath)).toBe(true);
    expect(readFileSync(livePath, 'utf8')).toContain('live-session');
    expect(readFileSync(livePath, 'utf8')).toContain('_cfuvid\tcf-live');
  });

  it('does not copy the live session-token family into the staged verification jar', () => {
    const live = bind('user:alice:_:chatgptweb')!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedCookieJar(livePath, [
      { domain: '.chatgpt.com', name: '__Secure-next-auth.session-token', value: 'live-session' },
      {
        domain: '.chatgpt.com',
        name: '__Secure-next-auth.session-token.0',
        value: 'live-chunk-0',
      },
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' },
      { domain: '.chatgpt.com', name: 'cf_clearance', value: 'cf-clear' },
      { domain: '.chatgpt.com', name: '__cf_bm', value: 'cf-bm' },
    ]);

    const staged = stageChatGPTWebBrowserSession({
      accountId: 'user:alice:_:chatgptweb',
      browserProfile: profile,
      deviceId: SAME_DEVICE,
    })!;

    const stagedCookies = readBrowserCookieJar(resolveCookieJarPath(staged.context.cookieJarKey));
    expect(stagedCookies.some((cookie) => cookie.name.includes('session-token'))).toBe(false);
    expect(
      stagedCookies.some((cookie) => cookie.name === '_cfuvid' && cookie.value === 'cf-live'),
    ).toBe(true);
    expect(
      stagedCookies.some((cookie) => cookie.name === 'cf_clearance' && cookie.value === 'cf-clear'),
    ).toBe(true);
    expect(
      stagedCookies.some((cookie) => cookie.name === '__cf_bm' && cookie.value === 'cf-bm'),
    ).toBe(true);
    expect(readFileSync(livePath, 'utf8')).toContain('live-session');
  });

  it('does not leak a pending registry entry when staging throws', () => {
    bind('user:alice:_:chatgptweb', 'device-live')!;
    const registry = getBrowserSessionRegistry();
    const acquiredAccountIds: string[] = [];
    const originalAcquire = registry.acquire.bind(registry);
    const acquireSpy = vi.spyOn(registry, 'acquire').mockImplementation((input) => {
      acquiredAccountIds.push(input.accountId);
      return originalAcquire(input);
    });
    const seedSpy = vi.spyOn(BrowserCookieJar, 'seedBrowserCookieJar').mockImplementation(() => {
      throw new Error('seed failed');
    });

    try {
      expect(() =>
        stageChatGPTWebBrowserSession({
          accountId: 'user:alice:_:chatgptweb',
          browserProfile: profile,
          deviceId: 'device-candidate',
        }),
      ).toThrow('seed failed');

      const pendingIds = acquiredAccountIds.filter((id) => id.includes(':pending:'));
      expect(pendingIds.length).toBeGreaterThan(0);
      for (const accountId of pendingIds) {
        expect(
          registry.getForIdentity({
            accountId,
            origin: 'https://chatgpt.com',
            provider: 'chatgptweb',
          }),
        ).toBeUndefined();
      }
      expect(
        registry.getForIdentity({
          accountId: 'user:alice:_:chatgptweb',
          origin: 'https://chatgpt.com',
          provider: 'chatgptweb',
        })?.lifecycle,
      ).toBe('active');
    } finally {
      acquireSpy.mockRestore();
      seedSpy.mockRestore();
    }
  });

  it('promotes staged cookies onto live only on commit', () => {
    const live = bind('user:alice:_:chatgptweb')!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);

    const staged = stageChatGPTWebBrowserSession({
      accountId: 'user:alice:_:chatgptweb',
      browserProfile: profile,
      deviceId: SAME_DEVICE,
    })!;
    seedCookieJar(resolveCookieJarPath(staged.context.cookieJarKey), [
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-verified' },
    ]);

    commitStagedChatGPTWebBrowserSession(
      {
        accountId: 'user:alice:_:chatgptweb',
        browserProfile: profile,
        deviceId: SAME_DEVICE,
      },
      staged.accountId,
    );

    expect(readFileSync(livePath, 'utf8')).toContain('_cfuvid\tcf-verified');
  });

  it('clears a leftover live session-token when committing an access-token staged jar', () => {
    const live = bind('user:alice:_:chatgptweb')!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedCookieJar(livePath, [
      {
        domain: '.chatgpt.com',
        name: '__Secure-next-auth.session-token',
        value: 'old-account-session',
      },
      {
        domain: '.chatgpt.com',
        name: '__Secure-next-auth.session-token.0',
        value: 'old-account-chunk',
      },
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' },
    ]);

    const staged = stageChatGPTWebBrowserSession({
      accountId: 'user:alice:_:chatgptweb',
      browserProfile: profile,
      deviceId: SAME_DEVICE,
    })!;
    seedCookieJar(resolveCookieJarPath(staged.context.cookieJarKey), [
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-verified' },
    ]);

    commitStagedChatGPTWebBrowserSession(
      {
        accountId: 'user:alice:_:chatgptweb',
        browserProfile: profile,
        deviceId: SAME_DEVICE,
      },
      staged.accountId,
    );

    const liveCookies = readBrowserCookieJar(livePath);
    expect(liveCookies.some((cookie) => cookie.name.includes('session-token'))).toBe(false);
    expect(
      liveCookies.some((cookie) => cookie.name === '_cfuvid' && cookie.value === 'cf-verified'),
    ).toBe(true);
  });

  it('unregisters the old jar path and invalidates the old Sentinel slot on a device-changing commit', () => {
    const live = bind('user:alice:_:chatgptweb', 'device-old')!;
    const oldId = live.contextId;
    const oldDigest = live.cookieJarKey;
    expect(isContextCookieJarKey(oldDigest)).toBe(true);

    const invalidateSpy = vi.spyOn(getSharedSentinelBundlePool(), 'invalidate');

    const staged = stageChatGPTWebBrowserSession({
      accountId: 'user:alice:_:chatgptweb',
      browserProfile: profile,
      deviceId: 'device-new',
    })!;
    seedCookieJar(resolveCookieJarPath(staged.context.cookieJarKey), [
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-verified' },
    ]);

    const committed = commitStagedChatGPTWebBrowserSession(
      {
        accountId: 'user:alice:_:chatgptweb',
        browserProfile: profile,
        deviceId: 'device-new',
      },
      staged.accountId,
    )!;

    expect(committed.contextId).not.toBe(oldId);
    expect(getBrowserSessionRegistry().get(oldId)).toBeUndefined();
    expect(isContextCookieJarKey(oldDigest)).toBe(true);
    expect(() => resolveCookieJarPath(oldDigest)).toThrow(
      'fetch failed: browser session context is gone',
    );
    expect(invalidateSpy).toHaveBeenCalledWith(oldId);
    expect(
      readBrowserCookieJar(resolveCookieJarPath(committed.cookieJarKey)).some(
        (cookie) => cookie.name === '_cfuvid' && cookie.value === 'cf-verified',
      ),
    ).toBe(true);
  });
});

describe('rotateChatGPTWebBrowserSession', () => {
  it('mints a new page session id and Sentinel slot while keeping cookies', () => {
    const original = bind('user:alice:_:chatgptweb')!;
    const originalPage = original.logicalPageId;
    const originalContext = original.contextId;

    const rotated = rotateChatGPTWebBrowserSession({
      accountId: 'user:alice:_:chatgptweb',
      browserProfile: profile,
      deviceId: SAME_DEVICE,
    })!;

    expect(rotated.contextId).not.toBe(originalContext);
    expect(rotated.logicalPageId).not.toBe(originalPage);
    const cookies = readBrowserCookieJar(resolveCookieJarPath(rotated.cookieJarKey));
    expect(
      cookies.some((cookie) => cookie.name === 'oai-did' && cookie.value === SAME_DEVICE),
    ).toBe(true);
  });

  it('stale setBootstrap after rotate does not populate the replacement context', () => {
    const original = bind('user:alice:_:chatgptweb')!;
    const rotated = rotateChatGPTWebBrowserSession({
      accountId: 'user:alice:_:chatgptweb',
      browserProfile: profile,
      deviceId: SAME_DEVICE,
    })!;

    original.setBootstrap({ clientVersion: 'stale-build' });
    expect(rotated.getBootstrap()).toBeUndefined();
    expect(original.getBootstrap()).toBeUndefined();
  });
});

describe('commit fences', () => {
  it('commit aborts when live revision/contextId changed under the staged fence', () => {
    bind('user:alice:_:chatgptweb')!;
    const staged = stageChatGPTWebBrowserSession({
      accountId: 'user:alice:_:chatgptweb',
      browserProfile: profile,
      deviceId: SAME_DEVICE,
    })!;
    seedCookieJar(resolveCookieJarPath(staged.context.cookieJarKey), [
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-staged' },
    ]);

    const rotated = rotateChatGPTWebBrowserSession({
      accountId: 'user:alice:_:chatgptweb',
      browserProfile: profile,
      deviceId: SAME_DEVICE,
    })!;
    const rotatedPath = resolveCookieJarPath(rotated.cookieJarKey);

    const committed = commitStagedChatGPTWebBrowserSession(
      {
        accountId: 'user:alice:_:chatgptweb',
        browserProfile: profile,
        deviceId: SAME_DEVICE,
      },
      staged.accountId,
    );

    expect(committed).toBeUndefined();
    expect(getBrowserSessionRegistry().get(rotated.contextId)?.lifecycle).toBe('active');
    expect(readFileSync(rotatedPath, 'utf8')).not.toContain('cf-staged');
  });
});

describe('C4 isolation and inFlight', () => {
  it('drop via acquire binding-mismatch still unregisters jar mapping and Sentinel (onInvalidate)', async () => {
    const original = bind('user:alice:_:chatgptweb', 'device-one')!;
    const oldId = original.contextId;
    const oldDigest = original.cookieJarKey;
    original.release?.();

    const invalidateSpy = vi.spyOn(getSharedSentinelBundlePool(), 'invalidate');
    const registry = getBrowserSessionRegistry();
    registry.acquire({
      accountId: 'user:alice:_:chatgptweb',
      browserProfileRevision: 0,
      deviceId: 'device-two',
      impersonationProfileRevision: profile.id,
      origin: 'https://chatgpt.com',
      provider: 'chatgptweb',
    });
    await registry.awaitPendingCleanup();

    expect(getBrowserSessionRegistry().get(oldId)).toBeUndefined();
    expect(isContextCookieJarKey(oldDigest)).toBe(true);
    expect(() => resolveCookieJarPath(oldDigest)).toThrow(
      'fetch failed: browser session context is gone',
    );
    expect(invalidateSpy).toHaveBeenCalledWith(oldId);
  });

  it('cleanup of account A does not drain account B transport or jar', async () => {
    const drained: string[] = [];
    const pool = {
      bind: vi.fn(),
      drain: (key: string) => {
        drained.push(key);
      },
      drainAll: vi.fn(),
      has: () => false,
    };
    const registry = createBrowserSessionRegistry({ transportPool: pool });
    installBrowserSessionRegistryForTests(registry);

    const alice = bind('user:alice:_:chatgptweb')!;
    const bob = bind('user:bob:_:chatgptweb')!;
    const bobPath = resolveCookieJarPath(bob.cookieJarKey);
    const alicePool = registry.get(alice.contextId)!.transportPoolKey;
    const bobPool = registry.get(bob.contextId)!.transportPoolKey;

    invalidateChatGPTWebBrowserSession('user:alice:_:chatgptweb');
    await registry.awaitPendingCleanup();

    expect(drained).toEqual([alicePool]);
    expect(drained).not.toContain(bobPool);
    expect(registry.get(alice.contextId)).toBeUndefined();
    expect(registry.get(bob.contextId)?.lifecycle).toBe('active');
    expect(existsSync(bobPath)).toBe(true);
  });

  it('failed staging at capacity leaves the live context and jar untouched', () => {
    const registry = createBrowserSessionRegistry({ maxContexts: 1 });
    installBrowserSessionRegistryForTests(registry);
    const live = bind('user:alice:_:chatgptweb')!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);

    expect(
      stageChatGPTWebBrowserSession({
        accountId: 'user:alice:_:chatgptweb',
        browserProfile: profile,
        deviceId: SAME_DEVICE,
      }),
    ).toBeUndefined();

    expect(registry.get(live.contextId)?.lifecycle).toBe('active');
    expect(existsSync(livePath)).toBe(true);
    expect(readFileSync(livePath, 'utf8')).toContain('cf-live');
  });

  it('failed staging at maxContexts 1 does not evict a TTL-expired live context', () => {
    let now = 1_000;
    const registry = createBrowserSessionRegistry({
      idleTtlMs: 1_000,
      maxContexts: 1,
      now: () => now,
    });
    installBrowserSessionRegistryForTests(registry);
    const live = bind('user:alice:_:chatgptweb')!;
    live.release?.();
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);
    now = 10_000;

    expect(
      stageChatGPTWebBrowserSession({
        accountId: 'user:alice:_:chatgptweb',
        browserProfile: profile,
        deviceId: SAME_DEVICE,
      }),
    ).toBeUndefined();

    expect(registry.get(live.contextId)?.lifecycle).toBe('active');
    expect(existsSync(livePath)).toBe(true);
    expect(readFileSync(livePath, 'utf8')).toContain('cf-live');
  });

  it('bind throws a retryable BrowserSessionError while the registry is resetting', async () => {
    let releaseDrain: (() => void) | undefined;
    const hanging = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const registry = createBrowserSessionRegistry({
      transportPool: {
        bind: vi.fn(),
        drain: () => hanging,
        drainAll: () => hanging,
        has: () => false,
      },
    });
    installBrowserSessionRegistryForTests(registry);
    bind('user:alice:_:chatgptweb');
    const resetting = disposeAllBrowserSessions();
    expect(() => bind('user:bob:_:chatgptweb')).toThrow(/browser session registry is resetting/);
    expect(() => bind('user:bob:_:chatgptweb')).toThrow(
      expect.objectContaining({ code: 'BROWSER_SESSION_RESETTING', retryable: true }),
    );
    expect(() =>
      stageChatGPTWebBrowserSession({
        accountId: 'user:bob:_:chatgptweb',
        browserProfile: profile,
        deviceId: SAME_DEVICE,
      }),
    ).toThrow(expect.objectContaining({ code: 'BROWSER_SESSION_RESETTING', retryable: true }));
    releaseDrain?.();
    await resetting;
  });

  it('in-flight bind inFlight prevents idle eviction of that account only', () => {
    const held = bind('user:held:_:chatgptweb')!;
    const idle = bind('user:idle:_:chatgptweb')!;
    idle.release?.();

    const heldCtx = getBrowserSessionRegistry().get(held.contextId)!;
    const idleCtx = getBrowserSessionRegistry().get(idle.contextId)!;
    expect(heldCtx.inFlight).toBeGreaterThan(0);
    expect(idleCtx.inFlight).toBe(0);

    heldCtx.lastUsedAt = 0;
    idleCtx.lastUsedAt = 0;
    getBrowserSessionRegistry().sweepIdleAndBound(Date.now());

    expect(getBrowserSessionRegistry().get(held.contextId)).toBe(heldCtx);
    expect(getBrowserSessionRegistry().get(idle.contextId)).toBeUndefined();
    held.release?.();
  });
});
