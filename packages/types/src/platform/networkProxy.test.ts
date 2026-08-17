import { describe, expect, it } from 'vitest';

import {
  createDefaultNetworkProxyConfig,
  egressScopeIdSchema,
  egressScopeOpSchema,
  engineIssueSchema,
  instanceStatusViewSchema,
  networkProxyConfigSchema,
  networkProxyConfigUpdateSchema,
  normalizeNetworkProxyConfig,
  staticProxyUpdateSchema,
  subscriptionCreateSchema,
  subscriptionIssueSchema,
  subscriptionViewSchema,
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

  it('engineIssueSchema is strict and instance status uses lastIssue + healing', () => {
    const issue = {
      at: '2026-08-17T00:00:00.000Z',
      code: 'health_timeout' as const,
      detail: 'aborted',
    };
    expect(engineIssueSchema.parse(issue)).toEqual(issue);
    expect(engineIssueSchema.safeParse({ ...issue, extra: 1 }).success).toBe(false);
    expect(engineIssueSchema.safeParse({ ...issue, code: 'TimeoutError' }).success).toBe(false);
    expect(engineIssueSchema.safeParse({ ...issue, detail: 'x'.repeat(201) }).success).toBe(false);

    const view = {
      activeNode: null,
      aliveNodeCount: 0,
      appliedRevision: 1,
      arch: 'arm64',
      artifacts: [],
      engineState: 'error' as const,
      engineVersion: null,
      fallbackCount: 0,
      healing: { attempt: 1, nextAttemptAt: '2026-08-17T00:00:30.000Z' },
      instanceId: 'pinst_a',
      isCurrent: true,
      lastHeartbeatAt: '2026-08-17T00:00:00.000Z',
      lastIssue: issue,
      platform: 'darwin',
      proxiedCount: 0,
      updatedAt: '2026-08-17T00:00:00.000Z',
    };
    expect(instanceStatusViewSchema.parse(view)).toEqual(view);
    expect(instanceStatusViewSchema.safeParse({ ...view, lastError: 'x' }).success).toBe(false);
    expect(instanceStatusViewSchema.safeParse({ ...view, lastIssue: undefined }).success).toBe(
      false,
    );
  });

  it('subscriptionIssueSchema is strict and subscription view uses lastIssue', () => {
    const issue = {
      at: '2026-08-17T00:00:00.000Z',
      code: 'timeout' as const,
      detail: 'aborted',
    };
    expect(subscriptionIssueSchema.parse(issue)).toEqual(issue);
    expect(subscriptionIssueSchema.safeParse({ ...issue, extra: 1 }).success).toBe(false);
    expect(subscriptionIssueSchema.safeParse({ ...issue, code: 'TimeoutError' }).success).toBe(
      false,
    );
    expect(subscriptionIssueSchema.safeParse({ ...issue, detail: 'x'.repeat(201) }).success).toBe(
      false,
    );

    const view = {
      createdAt: '2026-08-17T00:00:00.000Z',
      enabled: true,
      id: 'nps_1',
      kind: 'url' as const,
      lastIssue: issue,
      lastUpdateAt: null,
      name: 'Main',
      nodeCount: 2,
      sortOrder: 0,
      traffic: null,
      updateIntervalSec: 86_400,
      updatedAt: '2026-08-17T00:00:00.000Z',
      urlHost: 'sub.example.com',
      userAgent: null,
    };
    expect(subscriptionViewSchema.parse(view)).toEqual(view);
    expect(subscriptionViewSchema.safeParse({ ...view, lastError: 'x' }).success).toBe(false);
    expect(subscriptionViewSchema.safeParse({ ...view, lastIssue: undefined }).success).toBe(false);
  });
});
