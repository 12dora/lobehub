import { describe, expect, it } from 'vitest';

import {
  createDefaultNetworkProxyConfig,
  egressScopeIdSchema,
  egressScopeOpSchema,
  networkProxyConfigSchema,
  networkProxyConfigUpdateSchema,
  normalizeNetworkProxyConfig,
  staticProxyUpdateSchema,
  subscriptionCreateSchema,
} from './networkProxy';

describe('networkProxy types', () => {
  it('default config validates and is off by default', () => {
    const cfg = createDefaultNetworkProxyConfig();
    expect(() => networkProxyConfigSchema.parse(cfg)).not.toThrow();
    expect(cfg.masterEnabled).toBe(false);
    expect(Object.keys(cfg.scopes.features)).toHaveLength(5);
    expect(cfg.scopes.features.market).toEqual({ enabled: false, onUnavailable: 'direct' });
  });

  it('normalizes partial / legacy JSON to a full config', () => {
    const cfg = normalizeNetworkProxyConfig({
      masterEnabled: true,
      scopes: { providers: { openai: { enabled: true, onUnavailable: 'fail' } } },
    });
    expect(cfg.masterEnabled).toBe(true);
    expect(cfg.scopes.providers.openai.onUnavailable).toBe('fail');
    expect(cfg.scopes.features.mcp.enabled).toBe(false);
    expect(cfg.outlet.latencyTestUrl).toContain('generate_204');
    expect(normalizeNetworkProxyConfig(null).masterEnabled).toBe(false);
  });

  it('rejects unknown keys and bad bypass entries', () => {
    const cfg = createDefaultNetworkProxyConfig() as Record<string, unknown>;
    expect(networkProxyConfigSchema.safeParse({ ...cfg, extra: 1 }).success).toBe(false);
    expect(networkProxyConfigSchema.safeParse({ ...cfg, bypassHosts: ['bad host'] }).success).toBe(
      false,
    );
    expect(
      networkProxyConfigSchema.safeParse({
        ...cfg,
        bypassHosts: ['*.corp.local', '10.0.0.0/8', '::1'],
      }).success,
    ).toBe(true);
  });

  it('scope ids and ops', () => {
    expect(egressScopeIdSchema.safeParse('provider:openai').success).toBe(true);
    expect(egressScopeIdSchema.safeParse('feature:market').success).toBe(true);
    expect(egressScopeIdSchema.safeParse('feature:x').success).toBe(false);
    expect(egressScopeOpSchema.safeParse({ target: 'all_features', enabled: true }).success).toBe(
      true,
    );
    expect(
      egressScopeOpSchema.safeParse({
        target: 'all_providers',
        enabled: true,
        providerIds: ['openai'],
      }).success,
    ).toBe(true);
  });

  it('static proxy password update is explicit keep/replace/clear', () => {
    expect(
      staticProxyUpdateSchema.parse({ server: 'p', port: 8080, type: 'http' }).password,
    ).toEqual({ action: 'keep' });
    expect(
      staticProxyUpdateSchema.safeParse({
        server: 'p',
        port: 8080,
        type: 'http',
        password: { action: 'replace' },
      }).success,
    ).toBe(false);
    const { scopes: _scopes, ...rest } = createDefaultNetworkProxyConfig();
    expect(networkProxyConfigUpdateSchema.safeParse({ ...rest, staticProxy: null }).success).toBe(
      true,
    );
    expect(
      networkProxyConfigUpdateSchema.safeParse({ ...rest, scopes: _scopes, staticProxy: null })
        .success,
    ).toBe(false);
  });

  it('subscription create discriminates url / manual', () => {
    expect(
      subscriptionCreateSchema.safeParse({
        kind: 'url',
        name: 'a',
        enabled: true,
        sortOrder: 0,
        url: 'https://x.y/sub',
      }).success,
    ).toBe(true);
    expect(
      subscriptionCreateSchema.safeParse({
        kind: 'url',
        name: 'a',
        enabled: true,
        sortOrder: 0,
        url: 'ftp://x.y/sub',
      }).success,
    ).toBe(false);
    expect(
      subscriptionCreateSchema.safeParse({
        kind: 'manual',
        name: 'a',
        enabled: true,
        sortOrder: 0,
        payload: 'ss://abc',
      }).success,
    ).toBe(true);
  });
});
