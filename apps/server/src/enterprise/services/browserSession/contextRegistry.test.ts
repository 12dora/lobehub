import { existsSync, readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBrowserSessionRegistry,
  getBrowserSessionProviderState,
  getBrowserSessionRegistry,
  resetBrowserSessionRegistryForTests,
  setBrowserSessionProviderState,
} from './contextRegistry';
import { readBrowserCookieJar, resetBrowserCookieJars, seedBrowserCookieJar } from './cookieJar';
import { digestBrowserSessionMaterial } from './identity';
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

  it('touch updates lastUsedAt and no-ops after release', () => {
    let now = 1_000;
    const registry = createBrowserSessionRegistry({ now: () => now });
    const context = registry.acquire(baseInput());
    expect(context.lastUsedAt).toBe(1_000);

    now = 2_000;
    expect(registry.touch(context.contextId)).toBe(true);
    expect(context.lastUsedAt).toBe(2_000);

    expect(registry.release(context.contextId)).toBe(true);
    expect(context.lifecycle).toBe('released');
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
  it('returns a process-local singleton that reset tears down', () => {
    const first = getBrowserSessionRegistry().acquire(baseInput());
    const second = getBrowserSessionRegistry().acquire(baseInput());
    expect(second.contextId).toBe(first.contextId);

    resetBrowserSessionRegistryForTests();
    expect(existsSync(first.cookieJar.path)).toBe(false);

    const third = getBrowserSessionRegistry().acquire(baseInput());
    expect(third.contextId).not.toBe(first.contextId);
  });
});
