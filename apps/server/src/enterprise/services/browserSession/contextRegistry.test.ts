import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBrowserSessionRegistry,
  disposeAllBrowserSessions,
  getBrowserSessionProviderState,
  getBrowserSessionRegistry,
  resetBrowserSessionRegistryForTests,
  setBrowserSessionProviderState,
} from './contextRegistry';
import {
  ensureBrowserCookieJarFile,
  LEGACY_DEVICE_BROWSER_COOKIE_JAR_DIR_NAME,
  readBrowserCookieJar,
  resetBrowserCookieJars,
  seedBrowserCookieJar,
  sweepOrphanBrowserCookieJars,
} from './cookieJar';
import { digestBrowserSessionMaterial } from './identity';
import { onBrowserSessionInvalidate } from './lifecycle';
import type { BrowserSessionAcquireInput } from './types';
import { BrowserSessionError } from './types';

afterEach(() => {
  resetBrowserSessionRegistryForTests();
  resetBrowserCookieJars();
});

const SECRET_TOKEN = 'sk-live-C1C2-SECRET-TOKEN-do-not-log-9f3a';
const SECRET_DEVICE = 'oai-did-SECRET-device-aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee';

const baseInput = (
  overrides: Partial<BrowserSessionAcquireInput> = {},
): BrowserSessionAcquireInput => ({
  accountId: 'conn-account-1',
  browserProfileRevision: 3,
  credentialDigestInput: SECRET_TOKEN,
  deviceId: SECRET_DEVICE,
  origin: 'https://chatgpt.com',
  provider: 'chatgptweb',
  ...overrides,
});

describe('createBrowserSessionRegistry', () => {
  it('reuses one context for the same provider/account/origin/binding', () => {
    const registry = createBrowserSessionRegistry();
    const first = registry.acquire(baseInput());
    const second = registry.acquire(baseInput());

    expect(second.contextId).toBe(first.contextId);
    expect(second.logicalPageId).toBe(first.logicalPageId);
    expect(second.cookieJar.path).toBe(first.cookieJar.path);
    expect(second.lifecycle).toBe('active');
    expect(registry.get(first.contextId)).toBe(first);
  });

  it('invalidates atomically when the device, credential, proxy, or profile changes', () => {
    const drain = vi.fn();
    const registry = createBrowserSessionRegistry({
      transportPool: { bind: vi.fn(), drain, has: () => false },
    });

    const original = registry.acquire(baseInput());
    seedBrowserCookieJar(original.cookieJar.path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: SECRET_DEVICE },
    ]);
    const originalId = original.contextId;
    const originalJar = original.cookieJar.path;
    const originalPage = original.logicalPageId;
    const originalPool = original.transportPoolKey;

    const afterDevice = registry.acquire(baseInput({ deviceId: 'device-rotated' }));
    expect(afterDevice.contextId).not.toBe(originalId);
    expect(afterDevice.logicalPageId).not.toBe(originalPage);
    expect(afterDevice.cookieJar.path).not.toBe(originalJar);
    expect(original.lifecycle).toBe('invalidated');
    expect(original.revision).toBe(2);
    expect(existsSync(originalJar)).toBe(false);
    ensureBrowserCookieJarFile(originalJar);
    expect(existsSync(originalJar)).toBe(false);
    expect(registry.get(originalId)).toBeUndefined();
    expect(drain).toHaveBeenCalledWith(originalPool);

    const afterCredential = registry.acquire(
      baseInput({ credentialDigestInput: 'rotated-credential', deviceId: 'device-rotated' }),
    );
    expect(afterCredential.contextId).not.toBe(afterDevice.contextId);
    expect(afterDevice.lifecycle).toBe('invalidated');

    const afterProxy = registry.acquire(
      baseInput({
        credentialDigestInput: 'rotated-credential',
        deviceId: 'device-rotated',
        proxyOutlet: 'egress-us-1',
      }),
    );
    expect(afterProxy.contextId).not.toBe(afterCredential.contextId);

    const afterProfile = registry.acquire(
      baseInput({
        browserProfileRevision: 4,
        credentialDigestInput: 'rotated-credential',
        deviceId: 'device-rotated',
        proxyOutlet: 'egress-us-1',
      }),
    );
    expect(afterProfile.contextId).not.toBe(afterProxy.contextId);
    expect(afterProfile.browserProfileRevision).toBe(4);
  });

  it('never shares jar, page, or transport state across accounts or providers', () => {
    const registry = createBrowserSessionRegistry();
    const chatgptA = registry.acquire(baseInput({ accountId: 'account-a' }));
    const chatgptB = registry.acquire(baseInput({ accountId: 'account-b' }));
    const grok = registry.acquire(baseInput({ accountId: 'account-a', provider: 'grok' }));
    const cursor = registry.acquire(
      baseInput({
        accountId: 'account-a',
        origin: 'https://api2.cursor.sh',
        provider: 'cursor',
      }),
    );

    seedBrowserCookieJar(chatgptA.cookieJar.path, [
      { domain: '.chatgpt.com', name: 'session-token', value: 'cookie-for-a' },
    ]);
    seedBrowserCookieJar(chatgptB.cookieJar.path, [
      { domain: '.chatgpt.com', name: 'session-token', value: 'cookie-for-b' },
    ]);

    const ids = [chatgptA, chatgptB, grok, cursor].map((context) => context.contextId);
    expect(new Set(ids).size).toBe(4);
    expect(new Set([chatgptA, chatgptB, grok, cursor].map((c) => c.cookieJar.path)).size).toBe(4);
    expect(new Set([chatgptA, chatgptB, grok, cursor].map((c) => c.logicalPageId)).size).toBe(4);
    expect(new Set([chatgptA, chatgptB, grok, cursor].map((c) => c.transportPoolKey)).size).toBe(4);

    expect(readFileSync(chatgptA.cookieJar.path, 'utf8')).not.toContain('cookie-for-b');
    expect(readFileSync(chatgptB.cookieJar.path, 'utf8')).not.toContain('cookie-for-a');
    expect(readBrowserCookieJar(grok.cookieJar.path)).toEqual([]);
    expect(readBrowserCookieJar(cursor.cookieJar.path)).toEqual([]);
  });

  it('does not embed credentials in keys, paths, summaries, or serialized context', () => {
    const registry = createBrowserSessionRegistry();
    const context = registry.acquire(
      baseInput({
        accountId: `account-wrapped-${SECRET_TOKEN}`,
        origin: 'https://user:pass@chatgpt.com/backend-api',
      }),
    );
    const summary = registry.summarize(context);
    const serialized = JSON.stringify({ context, summary });

    expect(context.origin).toBe('https://chatgpt.com');
    expect(context.lookupKey).toBe(
      digestBrowserSessionMaterial(
        `v1\0chatgptweb\0account-wrapped-${SECRET_TOKEN}\0https://chatgpt.com`,
      ),
    );
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(SECRET_DEVICE);
    expect(serialized).not.toContain('user:pass');
    expect(context.cookieJar.path).not.toContain(SECRET_TOKEN);
    expect(context.cookieJar.path).not.toContain(SECRET_DEVICE);
    expect(context.lookupKey).not.toContain(SECRET_TOKEN);
    expect(summary.lookupKey).toBe(context.lookupKey);
    expect(JSON.stringify(summary)).not.toContain(SECRET_TOKEN);
  });

  it('touch updates lastUsedAt and no-ops after release', async () => {
    let now = 1_000;
    const registry = createBrowserSessionRegistry({ now: () => now });
    const context = registry.acquire(baseInput());
    expect(context.lastUsedAt).toBe(1_000);

    now = 2_000;
    expect(registry.touch(context.contextId)).toBe(true);
    expect(context.lastUsedAt).toBe(2_000);

    expect(registry.release(context.contextId)).toBe(true);
    expect(context.lifecycle).toBe('released');
    await registry.awaitPendingCleanup();
    expect(existsSync(context.cookieJar.path)).toBe(false);
    expect(registry.touch(context.contextId)).toBe(false);
    expect(registry.get(context.contextId)).toBeUndefined();
  });

  it('getForIdentity peeks the live context without inspecting the binding digest', () => {
    const registry = createBrowserSessionRegistry();
    const context = registry.acquire(baseInput());

    expect(
      registry.getForIdentity({
        accountId: 'conn-account-1',
        origin: 'https://chatgpt.com',
        provider: 'chatgptweb',
      })?.contextId,
    ).toBe(context.contextId);
    expect(context.lifecycle).toBe('active');
    expect(registry.get(context.contextId)).toBe(context);
  });

  it('invalidateForIdentity drops the live context for that account', () => {
    const registry = createBrowserSessionRegistry();
    const context = registry.acquire(baseInput());
    expect(
      registry.invalidateForIdentity({
        accountId: 'conn-account-1',
        origin: 'https://chatgpt.com',
        provider: 'chatgptweb',
      }),
    ).toBe(true);
    expect(context.lifecycle).toBe('invalidated');
    expect(registry.get(context.contextId)).toBeUndefined();
  });

  it('keeps provider state namespaced and independent of the global installation id', () => {
    const installationId = '123e4567-e89b-42d3-a456-426614174000';
    const registry = createBrowserSessionRegistry();
    const context = registry.acquire(baseInput());

    setBrowserSessionProviderState(context, 'chatgptWeb', { buildNumber: 'abc' });
    expect(getBrowserSessionProviderState<{ buildNumber: string }>(context, 'chatgptWeb')).toEqual({
      buildNumber: 'abc',
    });
    expect(context.contextId).not.toBe(installationId);
    expect(context.logicalPageId).not.toBe(installationId);
    expect(JSON.stringify(registry.summarize(context))).not.toContain('abc');
  });

  it('rejects empty identity fields', () => {
    const registry = createBrowserSessionRegistry();
    expect(() => registry.acquire(baseInput({ provider: '  ' }))).toThrow(BrowserSessionError);
    expect(() => registry.acquire(baseInput({ accountId: '' }))).toThrow(BrowserSessionError);
  });
});

describe('getBrowserSessionRegistry', () => {
  it('returns a process-local singleton that reset tears down', async () => {
    const first = getBrowserSessionRegistry().acquire(baseInput());
    const second = getBrowserSessionRegistry().acquire(baseInput());
    expect(second.contextId).toBe(first.contextId);

    const registry = getBrowserSessionRegistry();
    resetBrowserSessionRegistryForTests();
    await registry.awaitPendingCleanup();
    expect(existsSync(first.cookieJar.path)).toBe(false);

    const third = getBrowserSessionRegistry().acquire(baseInput());
    expect(third.contextId).not.toBe(first.contextId);
  });
});

describe('withContextOwnership', () => {
  it('withContextOwnership increments inFlight and releases in finally', async () => {
    const registry = createBrowserSessionRegistry();
    const context = registry.acquire(baseInput());
    expect(context.inFlight).toBe(0);

    await registry.withContextOwnership(context.contextId, async (ctx) => {
      expect(ctx.inFlight).toBe(1);
      expect(ctx.revision).toBe(1);
    });
    expect(context.inFlight).toBe(0);
  });

  it('withContextOwnership does not serialize two overlapping owners of the same generation', async () => {
    const registry = createBrowserSessionRegistry();
    const context = registry.acquire(baseInput());
    let started = 0;
    let maxInFlight = 0;

    const hold = async () =>
      registry.withContextOwnership(context.contextId, async () => {
        started += 1;
        maxInFlight = Math.max(maxInFlight, context.inFlight);
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      });

    await Promise.all([hold(), hold()]);
    expect(started).toBe(2);
    expect(maxInFlight).toBe(2);
    expect(context.inFlight).toBe(0);
  });

  it('a write after invalidate is rejected even when the caller still holds the context object', () => {
    const registry = createBrowserSessionRegistry();
    const context = registry.acquire(baseInput());
    const fence = { contextId: context.contextId, revision: context.revision };
    setBrowserSessionProviderState(context, 'chatgptWeb', { build: '1' }, fence);

    registry.invalidate(context.contextId);
    setBrowserSessionProviderState(context, 'chatgptWeb', { build: '2' }, fence);
    expect(getBrowserSessionProviderState(context, 'chatgptWeb')).toBeUndefined();
    expect(context.providerState.chatgptWeb).toEqual({ build: '1' });
  });

  it('acquire after rotate uses a new contextId and revision 1; stale fence cannot seed the new jar', async () => {
    const registry = createBrowserSessionRegistry();
    const original = registry.acquire(baseInput());
    const fence = { contextId: original.contextId, revision: original.revision };
    const originalPath = original.cookieJar.path;

    registry.release(original.contextId);
    await registry.awaitPendingCleanup();
    const next = registry.acquire(baseInput());
    expect(next.contextId).not.toBe(original.contextId);
    expect(next.revision).toBe(1);

    seedBrowserCookieJar(originalPath, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'stale' },
    ]);
    expect(existsSync(originalPath)).toBe(false);
    setBrowserSessionProviderState(next, 'chatgptWeb', { build: 'stolen' }, fence);
    expect(getBrowserSessionProviderState(next, 'chatgptWeb')).toBeUndefined();
  });
});

describe('idle expiry and bounded count', () => {
  it('idle TTL evicts LRU unused context and does not evict another account', () => {
    let now = 1_000;
    const registry = createBrowserSessionRegistry({
      idleTtlMs: 1_000,
      maxContexts: 16,
      now: () => now,
    });
    const a = registry.acquire(baseInput({ accountId: 'account-a' }));
    now = 1_500;
    const b = registry.acquire(baseInput({ accountId: 'account-b' }));

    now = 2_100;
    registry.sweepIdleAndBound();
    expect(registry.get(a.contextId)).toBeUndefined();
    expect(a.lifecycle).toBe('released');
    expect(registry.get(b.contextId)).toBe(b);
  });

  it('idle TTL skips contexts with inFlight > 0', () => {
    let now = 1_000;
    const registry = createBrowserSessionRegistry({ idleTtlMs: 500, now: () => now });
    const context = registry.acquire(baseInput());
    context.inFlight = 1;
    now = 10_000;
    registry.sweepIdleAndBound();
    expect(registry.get(context.contextId)).toBe(context);
  });

  it('bounded maxContexts evicts idle LRU, never an in-flight context', () => {
    let now = 1_000;
    const registry = createBrowserSessionRegistry({
      idleTtlMs: 60_000,
      maxContexts: 2,
      now: () => now,
    });
    const a = registry.acquire(baseInput({ accountId: 'a' }));
    now = 2_000;
    const b = registry.acquire(baseInput({ accountId: 'b' }));
    b.inFlight = 1;
    now = 3_000;
    const c = registry.acquire(baseInput({ accountId: 'c' }));

    expect(registry.get(a.contextId)).toBeUndefined();
    expect(registry.get(b.contextId)).toBe(b);
    expect(registry.get(c.contextId)).toBe(c);
  });

  it('ephemeral/pending contexts are preferred for eviction', () => {
    let now = 1_000;
    const registry = createBrowserSessionRegistry({
      idleTtlMs: 60_000,
      maxContexts: 2,
      now: () => now,
    });
    const live = registry.acquire(baseInput({ accountId: 'live' }));
    now = 2_000;
    const pending = registry.acquire(baseInput({ accountId: 'live:pending:1' }));
    pending.providerState.ephemeral = true;
    now = 3_000;
    const other = registry.acquire(baseInput({ accountId: 'other' }));

    expect(registry.get(pending.contextId)).toBeUndefined();
    expect(registry.get(live.contextId)).toBe(live);
    expect(registry.get(other.contextId)).toBe(other);
  });

  it('disposeAll / dispose drains every transport key then unlinks jars', async () => {
    const drain = vi.fn();
    const drainAll = vi.fn();
    const registry = createBrowserSessionRegistry({
      transportPool: { bind: vi.fn(), drain, drainAll, has: () => false },
    });
    const a = registry.acquire(baseInput({ accountId: 'a' }));
    const b = registry.acquire(baseInput({ accountId: 'b' }));
    const pathA = a.cookieJar.path;
    const pathB = b.cookieJar.path;

    registry.dispose();
    await registry.awaitPendingCleanup();
    expect(drain).toHaveBeenCalledWith(a.transportPoolKey);
    expect(drain).toHaveBeenCalledWith(b.transportPoolKey);
    expect(drainAll).toHaveBeenCalled();
    expect(existsSync(pathA)).toBe(false);
    expect(existsSync(pathB)).toBe(false);
  });

  it('ephemeral acquire at capacity only evicts another ephemeral entry', () => {
    const registry = createBrowserSessionRegistry({ idleTtlMs: 60_000, maxContexts: 1 });
    const live = registry.acquire(baseInput({ accountId: 'live' }));
    expect(() => registry.acquire(baseInput({ accountId: 'pending', ephemeral: true }))).toThrow(
      BrowserSessionError,
    );
    expect(registry.get(live.contextId)).toBe(live);
    expect(existsSync(live.cookieJar.path)).toBe(true);
  });

  it('sweepOrphanBrowserCookieJars deletes leftover txt files and keeps pending-wipe-*', () => {
    const contextDir = nodePath.join(tmpdir(), 'aihub-browser-session-jars');
    const legacyDir = nodePath.join(tmpdir(), LEGACY_DEVICE_BROWSER_COOKIE_JAR_DIR_NAME);
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    const orphan = nodePath.join(contextDir, 'orphan-c4.txt');
    const tmpWriter = nodePath.join(contextDir, 'orphan-c4.tmp');
    const staleDevice = nodePath.join(legacyDir, 'stale-device.txt');
    const pendingWipe = nodePath.join(legacyDir, 'pending-wipe-provider-1');
    writeFileSync(orphan, 'x');
    writeFileSync(tmpWriter, 'x');
    writeFileSync(staleDevice, 'x');
    writeFileSync(pendingWipe, 'x');

    sweepOrphanBrowserCookieJars();

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(tmpWriter)).toBe(false);
    expect(existsSync(staleDevice)).toBe(false);
    expect(existsSync(pendingWipe)).toBe(true);
  });
});

describe('disposeAllBrowserSessions', () => {
  it('disposes the singleton registry', async () => {
    const context = getBrowserSessionRegistry().acquire(baseInput());
    const path = context.cookieJar.path;
    await disposeAllBrowserSessions();
    expect(existsSync(path)).toBe(false);
  });
});

describe('onInvalidate order', () => {
  it('fires provider listeners when a context is dropped', async () => {
    const seen: string[] = [];
    const unsubscribe = onBrowserSessionInvalidate((context) => {
      seen.push(context.contextId);
    });
    const registry = createBrowserSessionRegistry();
    const context = registry.acquire(baseInput());
    const id = context.contextId;
    registry.invalidate(id);
    await registry.awaitPendingCleanup();
    expect(seen).toContain(id);
    unsubscribe();
  });
});
