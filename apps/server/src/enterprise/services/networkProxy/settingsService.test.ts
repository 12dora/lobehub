import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import {
  applyScopeOps,
  applyStaticProxyUpdate,
  assertCanEnable,
  isLegacyGlobalProxyActive,
  toNetworkProxyConfigView,
} from './settingsService';

vi.mock('./secrets', () => ({
  sealNetworkProxySecret: vi.fn(async (plain: string) => `sealed:${plain}`),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('applyScopeOps', () => {
  it('updates one provider and one feature without clobbering the other field', () => {
    const config = createDefaultNetworkProxyConfig();
    const next = applyScopeOps(config, [
      { enabled: true, scope: 'provider:openai', target: 'one' },
      { onUnavailable: 'fail', scope: 'feature:market', target: 'one' },
    ]);
    expect(next.scopes.providers.openai).toEqual({ enabled: true, onUnavailable: 'direct' });
    expect(next.scopes.features.market).toEqual({ enabled: false, onUnavailable: 'fail' });
    expect(next.scopes.features.web_search).toEqual({ enabled: false, onUnavailable: 'direct' });
  });

  it('applies all_providers and all_features in order', () => {
    const config = createDefaultNetworkProxyConfig();
    const next = applyScopeOps(config, [
      { enabled: true, providerIds: ['openai', 'anthropic'], target: 'all_providers' },
      { enabled: true, onUnavailable: 'fail', target: 'all_features' },
      { enabled: false, scope: 'provider:openai', target: 'one' },
    ]);
    expect(next.scopes.providers.openai?.enabled).toBe(false);
    expect(next.scopes.providers.anthropic?.enabled).toBe(true);
    expect(next.scopes.features.mcp).toEqual({ enabled: true, onUnavailable: 'fail' });
  });
});

describe('applyStaticProxyUpdate', () => {
  it('clears the whole static proxy when update is null', async () => {
    expect(
      await applyStaticProxyUpdate(
        { passwordCiphertext: 'old', port: 8080, server: 'p.example', type: 'http' },
        null,
      ),
    ).toBeUndefined();
  });

  it('seals a replaced password and keeps the previous ciphertext on keep', async () => {
    const current = {
      passwordCiphertext: 'old-seal',
      port: 1080,
      server: 'socks.example',
      type: 'socks5' as const,
      username: 'alice',
    };
    const replaced = await applyStaticProxyUpdate(current, {
      password: { action: 'replace', value: 'n3w' },
      port: 1080,
      server: 'socks.example',
      type: 'socks5',
      username: 'alice',
    });
    expect(replaced?.passwordCiphertext).toBe('sealed:n3w');

    const kept = await applyStaticProxyUpdate(current, {
      password: { action: 'keep' },
      port: 1081,
      server: 'socks.example',
      type: 'socks5',
      username: 'alice',
    });
    expect(kept?.passwordCiphertext).toBe('old-seal');
    expect(kept?.port).toBe(1081);

    const cleared = await applyStaticProxyUpdate(current, {
      password: { action: 'clear' },
      port: 1080,
      server: 'socks.example',
      type: 'socks5',
    });
    expect(cleared?.passwordCiphertext).toBeUndefined();
    expect(cleared?.username).toBeUndefined();
  });
});

describe('assertCanEnable / isLegacyGlobalProxyActive', () => {
  it('allows masterEnabled when PROXY_URL is unset', () => {
    vi.stubEnv('PROXY_URL', '');
    expect(isLegacyGlobalProxyActive()).toBe(false);
    expect(() =>
      assertCanEnable({ ...createDefaultNetworkProxyConfig(), masterEnabled: true }),
    ).not.toThrow();
  });

  it('throws PLATFORM_NETWORK_PROXY_GLOBAL_PROXY_ACTIVE when PROXY_URL is set', () => {
    vi.stubEnv('PROXY_URL', 'socks5://127.0.0.1:1080');
    expect(isLegacyGlobalProxyActive()).toBe(true);
    try {
      assertCanEnable({ ...createDefaultNetworkProxyConfig(), masterEnabled: true });
      throw new Error('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_GLOBAL_PROXY_ACTIVE,
      );
    }
    expect(() => assertCanEnable(createDefaultNetworkProxyConfig())).not.toThrow();
  });
});

describe('toNetworkProxyConfigView', () => {
  it('masks the static-proxy password', () => {
    const config = createDefaultNetworkProxyConfig();
    config.staticProxy = {
      passwordCiphertext: 'sealed',
      port: 8080,
      server: 'p.example',
      type: 'https',
      username: 'alice',
    };
    const view = toNetworkProxyConfigView(config);
    expect(view.staticProxy).toEqual({
      hasPassword: true,
      port: 8080,
      server: 'p.example',
      type: 'https',
      username: 'alice',
    });
    expect(view).not.toHaveProperty('passwordCiphertext');
  });
});
