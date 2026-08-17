// @vitest-environment node
/**
 * admin.networkProxy — permission gates, dangerous reauth, CAS mapping, audit summaries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { createAdminAuthorizationFixture } from '../../testing/adminAuthorizationFixture';
import { adminRouter } from '../admin';
import type { NetworkProxyRuntime, NetworkProxySettingsRow } from './networkProxySupport';
import { hashNameForAudit, setNetworkProxyRuntimeForTests } from './networkProxySupport';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(adminRouter);
const fixture = createAdminAuthorizationFixture({ namespace: 'network-proxy' });

const appendSpy = vi.hoisted(() => vi.fn());

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('../../services/platformAudit', () => ({
  PlatformAuditService: class {
    append = appendSpy;
  },
}));

const defaultRow = (revision = 1): NetworkProxySettingsRow => ({
  config: createDefaultNetworkProxyConfig(),
  desiredArtifacts: {},
  engineGeneration: 0,
  revision,
  updatedAt: new Date('2026-08-17T00:00:00.000Z'),
});

const toView = (config: ReturnType<typeof createDefaultNetworkProxyConfig>) => ({
  ...config,
  staticProxy: config.staticProxy
    ? {
        hasPassword: Boolean(config.staticProxy.passwordCiphertext),
        port: config.staticProxy.port,
        server: config.staticProxy.server,
        type: config.staticProxy.type,
        username: config.staticProxy.username,
      }
    : undefined,
});

const createRuntime = (overrides: Partial<NetworkProxyRuntime> = {}): NetworkProxyRuntime => {
  const row = defaultRow();
  const engine = {
    getLogs: vi.fn(() => ['line-1']),
    getState: vi.fn(() => ({ proxyUrl: 'http://127.0.0.1:7890', state: 'running' as const })),
    listNodes: vi.fn(async () => [
      { alive: true, delayMs: 42, name: 'node-a', subscriptionId: 'nps_1', type: 'ss' },
    ]),
    refreshSubscriptionNow: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    selectNode: vi.fn(async () => undefined),
    testGroupDelay: vi.fn(async () => [
      { alive: true, delayMs: 10, name: 'node-a', subscriptionId: 'nps_1', type: 'ss' },
    ]),
    testNodeDelay: vi.fn(async () => 10),
  };

  return {
    applyScopeOps: vi.fn((config) => config),
    applyStaticProxyUpdate: vi.fn(async (current) => current),
    buildLocalInstanceStatus: vi.fn(async () => ({
      activeNode: 'node-a',
      aliveNodeCount: 1,
      appliedEngineGeneration: 1,
      appliedRevision: 1,
      arch: 'arm64',
      artifacts: [],
      engineState: 'running' as const,
      engineVersion: 'v1.19.30',
      fallbackCount: 0,
      healing: null,
      instanceId: 'pinst_test',
      lastIssue: null,
      platform: 'linux',
      proxiedCount: 0,
    })),
    artifactManager: {
      getStatus: vi.fn(async () => []),
      installFromDownload: vi.fn(async () => ({ sha256: 'abc', version: 'v1.19.30' })),
      installFromStream: vi.fn(async () => ({
        pinnedDigestMatch: true,
        sha256: 'abc',
        version: 'v1.19.30',
      })),
    },
    assertCanEnable: vi.fn(),
    bumpEngineGeneration: vi.fn(async () => ({
      ...row,
      engineGeneration: 1,
      revision: row.revision + 1,
    })),
    createSubscriptionRecord: vi.fn(async () => ({
      createdAt: '2026-08-17T00:00:00.000Z',
      enabled: true,
      id: 'nps_new',
      kind: 'url' as const,
      lastIssue: null,
      lastUpdateAt: null,
      name: 'sub',
      nodeCount: null,
      sortOrder: 0,
      traffic: null,
      updateIntervalSec: 86_400,
      updatedAt: '2026-08-17T00:00:00.000Z',
      urlHost: 'example.com',
      userAgent: null,
    })),
    deleteSubscriptionRecord: vi.fn(async () => undefined),
    detectEnginePlatform: vi.fn(() => ({ arch: 'arm64', key: 'darwin:arm64', platform: 'darwin' })),
    getDispatcherFor: null,
    getEgressCounters: vi.fn(() => ({ fallbackScopes: [] })),
    getEngineRuntime: vi.fn(() => engine),
    getNetworkProxySettings: vi.fn(async () => row),
    getOutletHealth: vi.fn(() => ({
      activeNode: 'node-a',
      activeNodeDelayMs: 42,
      available: true,
      circuitOpen: false,
      kind: 'engine' as const,
      unavailableReason: null,
    })),
    isLegacyGlobalProxyActive: vi.fn(() => false),
    listFreshInstanceStatuses: vi.fn(async () => []),
    listSubscriptionViews: vi.fn(async () => []),
    peekNetworkProxySnapshot: vi.fn(() => ({ staticProxyUrl: null })),
    publishNetworkProxyInvalidation: vi.fn(async () => undefined),
    redactSecrets: vi.fn((text: string) =>
      text.replaceAll(/trojan:\/\/\S+/g, 'trojan://***').replaceAll(/\?token=\S+/g, '?token=***'),
    ),
    requestSubscriptionRefresh: vi.fn(async () => undefined),
    setDesiredArtifacts: vi.fn(async (_db, patch) => ({
      ...row,
      desiredArtifacts: patch,
      revision: row.revision + 1,
    })),
    toNetworkProxyConfigView: vi.fn((config) => toView(config)),
    updateNetworkProxySettings: vi.fn(async (_db, input) => ({
      ...row,
      config: input.config,
      revision: input.expectedRevision + 1,
    })),
    updateSubscriptionRecord: vi.fn(async (_db, input) => ({
      createdAt: '2026-08-17T00:00:00.000Z',
      enabled: true,
      id: input.id,
      kind: 'url' as const,
      lastIssue: null,
      lastUpdateAt: null,
      name: input.name ?? 'sub',
      nodeCount: null,
      sortOrder: 0,
      traffic: null,
      updateIntervalSec: 86_400,
      updatedAt: '2026-08-17T00:00:00.000Z',
      urlHost: 'example.com',
      userAgent: null,
    })),
    ...overrides,
  };
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  appendSpy.mockReset();
  appendSpy.mockImplementation(async (params: { action: string }) => ({
    action: params.action,
    id: 'audit-ok',
    result: 'success',
  }));
  await fixture.setup(db);
  setNetworkProxyRuntimeForTests(createRuntime());
});

afterEach(async () => {
  setNetworkProxyRuntimeForTests(null);
  await fixture.cleanup(db);
  vi.unstubAllEnvs();
});

const callerFor = async (
  principal: 'auditor' | 'aiAdmin' | 'staleReauthSuper' | 'superAdmin' = 'superAdmin',
) => {
  const contexts = await fixture.createContexts(db);
  return createRootCaller(contexts[principal] as never).networkProxy;
};

describe('admin.networkProxy permissions', () => {
  it('lets an auditor read and denies writes', async () => {
    const reader = await callerFor('auditor');
    await expect(reader.getSettings()).resolves.toMatchObject({
      globalProxyActive: false,
      revision: 1,
    });
    await expect(
      reader.updateScopes({
        expectedRevision: 1,
        ops: [{ enabled: true, target: 'all_features' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not grant manage to ai_admin', async () => {
    const aiAdmin = await callerFor('aiAdmin');
    await expect(aiAdmin.getSettings()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      aiAdmin.updateScopes({
        expectedRevision: 1,
        ops: [{ enabled: true, target: 'all_features' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('admin.networkProxy mutations', () => {
  it('requires recent reauth when masterEnabled changes and audits denial', async () => {
    const caller = await callerFor('staleReauthSuper');
    const config = createDefaultNetworkProxyConfig();
    try {
      await caller.updateSettings({
        config: {
          bypassHosts: config.bypassHosts,
          downloadViaStaticProxy: false,
          engineLogLevel: config.engineLogLevel,
          masterEnabled: true,
          outlet: config.outlet,
          ruleMode: config.ruleMode,
          staticProxy: null,
          subscriptionUpdateViaOutlet: false,
        },
        expectedRevision: 1,
      });
      expect.fail('should throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe('ADMIN_REAUTH_REQUIRED');
    }
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'network_proxy.settings.update',
        result: 'denied',
      }),
    );
  });

  it('allows a non-dangerous engineLogLevel change without reauth', async () => {
    const caller = await callerFor('staleReauthSuper');
    const config = createDefaultNetworkProxyConfig();
    await expect(
      caller.updateSettings({
        config: {
          bypassHosts: config.bypassHosts,
          downloadViaStaticProxy: false,
          engineLogLevel: 'info',
          masterEnabled: false,
          outlet: config.outlet,
          ruleMode: config.ruleMode,
          staticProxy: null,
          subscriptionUpdateViaOutlet: false,
        },
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ revision: 2 });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'network_proxy.settings.update',
        afterDiff: expect.objectContaining({ masterEnabled: false, revision: 2 }),
        result: 'success',
      }),
    );
  });

  it('maps PlatformRevisionConflictError to PLATFORM_REVISION_CONFLICT', async () => {
    setNetworkProxyRuntimeForTests(
      createRuntime({
        updateNetworkProxySettings: vi.fn(async () => {
          throw new PlatformRevisionConflictError('conflict', {
            currentRevision: 3,
            expectedRevision: 1,
          });
        }),
      }),
    );
    const caller = await callerFor();
    const config = createDefaultNetworkProxyConfig();
    try {
      await caller.updateSettings({
        config: {
          bypassHosts: config.bypassHosts,
          downloadViaStaticProxy: false,
          engineLogLevel: 'info',
          masterEnabled: false,
          outlet: config.outlet,
          ruleMode: config.ruleMode,
          staticProxy: null,
          subscriptionUpdateViaOutlet: false,
        },
        expectedRevision: 1,
      });
      expect.fail('should throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      );
    }
  });

  it('calls assertCanEnable before writing settings', async () => {
    const runtime = createRuntime();
    setNetworkProxyRuntimeForTests(runtime);
    const caller = await callerFor();
    const config = createDefaultNetworkProxyConfig();
    await caller.updateSettings({
      config: {
        bypassHosts: config.bypassHosts,
        downloadViaStaticProxy: false,
        engineLogLevel: 'info',
        masterEnabled: false,
        outlet: config.outlet,
        ruleMode: config.ruleMode,
        staticProxy: null,
        subscriptionUpdateViaOutlet: false,
      },
      expectedRevision: 1,
    });
    expect(runtime.assertCanEnable).toHaveBeenCalled();
    expect(runtime.applyStaticProxyUpdate).toHaveBeenCalled();
    expect(runtime.publishNetworkProxyInvalidation).toHaveBeenCalledWith(2);
  });

  it('rejects simple→smart updateSettings without desired geodata', async () => {
    const caller = await callerFor();
    const config = createDefaultNetworkProxyConfig();
    try {
      await caller.updateSettings({
        config: {
          bypassHosts: config.bypassHosts,
          downloadViaStaticProxy: false,
          engineLogLevel: config.engineLogLevel,
          masterEnabled: false,
          outlet: config.outlet,
          ruleMode: 'smart',
          staticProxy: null,
          subscriptionUpdateViaOutlet: false,
        },
        expectedRevision: 1,
      });
      expect.fail('should throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_GEODATA_MISSING,
      );
    }
  });

  it('rejects a smart→smart updateSettings that restates ruleMode without geodata', async () => {
    const row = defaultRow();
    row.config = { ...row.config, ruleMode: 'smart' };
    setNetworkProxyRuntimeForTests(
      createRuntime({
        getNetworkProxySettings: vi.fn(async () => row),
      }),
    );
    const caller = await callerFor();
    try {
      await caller.updateSettings({
        config: {
          bypassHosts: row.config.bypassHosts,
          downloadViaStaticProxy: false,
          engineLogLevel: 'info',
          masterEnabled: false,
          outlet: row.config.outlet,
          ruleMode: 'smart',
          staticProxy: null,
          subscriptionUpdateViaOutlet: false,
        },
        expectedRevision: 1,
      });
      expect.fail('should throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_GEODATA_MISSING,
      );
    }
  });

  it('lets selectNode write an already-smart row without desired geodata', async () => {
    const row = defaultRow();
    row.config = { ...row.config, ruleMode: 'smart' };
    const runtime = createRuntime({
      getNetworkProxySettings: vi.fn(async () => row),
    });
    setNetworkProxyRuntimeForTests(runtime);
    const caller = await callerFor();
    await caller.selectNode({ expectedRevision: 1, nodeName: 'node-a' });
    expect(runtime.updateNetworkProxySettings).toHaveBeenCalled();
  });

  it('audits subscription create with host only', async () => {
    const caller = await callerFor();
    await caller.createSubscription({
      enabled: true,
      kind: 'url',
      name: 'cf',
      sortOrder: 0,
      url: 'https://example.com/sub?token=secret',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'network_proxy.subscription.create',
        afterDiff: expect.objectContaining({ name: 'sub', urlHost: 'example.com' }),
      }),
    );
    const payload = appendSpy.mock.calls.at(-1)?.[0] as { afterDiff: Record<string, unknown> };
    expect(JSON.stringify(payload.afterDiff)).not.toContain('token=secret');
    expect(JSON.stringify(payload.afterDiff)).not.toContain('https://example.com/sub');
  });

  it('never writes a raw node or secret-bearing subscription name in afterDiff', async () => {
    const secretName = 'trojan://password@evil.example';
    setNetworkProxyRuntimeForTests(
      createRuntime({
        createSubscriptionRecord: vi.fn(async () => ({
          createdAt: '2026-08-17T00:00:00.000Z',
          enabled: true,
          id: 'nps_new',
          kind: 'url' as const,
          lastIssue: null,
          lastUpdateAt: null,
          name: secretName,
          nodeCount: null,
          sortOrder: 0,
          traffic: null,
          updateIntervalSec: 86_400,
          updatedAt: '2026-08-17T00:00:00.000Z',
          urlHost: 'evil.example',
          userAgent: null,
        })),
      }),
    );
    const caller = await callerFor();
    await caller.createSubscription({
      enabled: true,
      kind: 'url',
      name: secretName,
      sortOrder: 0,
      url: 'https://evil.example/sub',
    });
    await caller.selectNode({ expectedRevision: 1, nodeName: secretName });

    const diffs = appendSpy.mock.calls.map((call) => JSON.stringify(call[0]?.afterDiff ?? {}));
    expect(diffs.some((diff) => diff.includes('password'))).toBe(false);
    expect(diffs.some((diff) => diff.includes(secretName))).toBe(false);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'network_proxy.outlet.select_node',
        afterDiff: expect.objectContaining({
          nodeNameHash: hashNameForAudit(secretName),
        }),
      }),
    );
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'network_proxy.subscription.create',
        afterDiff: expect.objectContaining({ name: 'trojan://***' }),
      }),
    );
  });

  it('installs artifacts as desired-state then kicks a local download', async () => {
    const runtime = createRuntime();
    setNetworkProxyRuntimeForTests(runtime);
    const caller = await callerFor();
    const result = await caller.installArtifact({ expectedRevision: 1, kind: 'engine' });
    expect(runtime.setDesiredArtifacts).toHaveBeenCalled();
    expect(runtime.publishNetworkProxyInvalidation).toHaveBeenCalled();
    expect(runtime.artifactManager.installFromDownload).toHaveBeenCalledWith('engine', {
      proxyUrl: null,
    });
    expect(result.local).toEqual({ error: null, ok: true });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        afterDiff: expect.objectContaining({
          sha256: 'abc',
          source: 'download',
          version: 'v1.19.30',
        }),
      }),
    );
  });

  it('restarts by bumping generation and calling the local runtime', async () => {
    const runtime = createRuntime();
    setNetworkProxyRuntimeForTests(runtime);
    const caller = await callerFor();
    const result = await caller.restartEngine({ expectedRevision: 1 });
    expect(runtime.bumpEngineGeneration).toHaveBeenCalled();
    expect(runtime.getEngineRuntime().restart).toHaveBeenCalled();
    expect(result.local).toEqual({ error: null, ok: true });
  });

  it('selectNode writes manualNodeName and applies it locally', async () => {
    const runtime = createRuntime();
    setNetworkProxyRuntimeForTests(runtime);
    const caller = await callerFor();
    await caller.selectNode({ expectedRevision: 1, nodeName: 'node-a' });
    expect(runtime.updateNetworkProxySettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        config: expect.objectContaining({
          outlet: expect.objectContaining({ manualNodeName: 'node-a' }),
        }),
      }),
    );
    expect(runtime.getEngineRuntime().selectNode).toHaveBeenCalledWith('node-a');
  });

  it('keeps the CAS write when local restart fails and reports local.error', async () => {
    const runtime = createRuntime();
    runtime.getEngineRuntime().restart = vi.fn(async () => {
      throw new Error('boom');
    });
    setNetworkProxyRuntimeForTests(runtime);
    const caller = await callerFor();
    const result = await caller.restartEngine({ expectedRevision: 1 });
    expect(runtime.bumpEngineGeneration).toHaveBeenCalled();
    expect(result.revision).toBe(2);
    expect(result.local).toEqual({ error: 'unknown', ok: false });
  });

  it('does not 500 a committed restart when the follow-up audit insert fails', async () => {
    appendSpy.mockResolvedValueOnce({ action: 'in-tx', id: 'a1', result: 'success' });
    appendSpy.mockRejectedValueOnce(new Error('audit unavailable'));
    const caller = await callerFor();
    const result = await caller.restartEngine({ expectedRevision: 1 });
    expect(result.revision).toBe(2);
    expect(result.local).toEqual({ error: null, ok: true });
  });

  it('maps CAS conflicts on updateScopes / selectNode / installArtifact / restartEngine', async () => {
    const conflict = () => {
      throw new PlatformRevisionConflictError('conflict', {
        currentRevision: 9,
        expectedRevision: 1,
      });
    };
    const callerForConflict = async (overrides: Partial<NetworkProxyRuntime>) => {
      setNetworkProxyRuntimeForTests(createRuntime(overrides));
      return callerFor();
    };

    try {
      await (
        await callerForConflict({ updateNetworkProxySettings: vi.fn(async () => conflict()) })
      ).updateScopes({
        expectedRevision: 1,
        ops: [{ enabled: true, target: 'all_features' }],
      });
      expect.fail('should throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      );
    }

    try {
      await (
        await callerForConflict({ updateNetworkProxySettings: vi.fn(async () => conflict()) })
      ).selectNode({ expectedRevision: 1, nodeName: 'n' });
      expect.fail('should throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      );
    }

    try {
      await (
        await callerForConflict({ setDesiredArtifacts: vi.fn(async () => conflict()) })
      ).installArtifact({ expectedRevision: 1, kind: 'engine' });
      expect.fail('should throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      );
    }

    try {
      await (
        await callerForConflict({ bumpEngineGeneration: vi.fn(async () => conflict()) })
      ).restartEngine({ expectedRevision: 1 });
      expect.fail('should throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      );
    }
  });
});

describe('admin.networkProxy.installGeodata', () => {
  it('writes both desired artifacts once, then installs geoip then geosite', async () => {
    const runtime = createRuntime();
    setNetworkProxyRuntimeForTests(runtime);
    const caller = await callerFor();
    const result = await caller.installGeodata({ expectedRevision: 1 });

    expect(runtime.setDesiredArtifacts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        geoip: expect.objectContaining({ commit: expect.any(String) }),
        geosite: expect.objectContaining({ commit: expect.any(String) }),
      }),
      expect.objectContaining({ expectedRevision: 1 }),
    );
    expect(runtime.publishNetworkProxyInvalidation).toHaveBeenCalledWith(2);
    expect(runtime.artifactManager.installFromDownload).toHaveBeenNthCalledWith(1, 'geoip', {
      proxyUrl: null,
    });
    expect(runtime.artifactManager.installFromDownload).toHaveBeenNthCalledWith(2, 'geosite', {
      proxyUrl: null,
    });
    expect(result.local).toEqual({ error: null, ok: true });
    expect(result.results).toEqual([
      { error: null, kind: 'geoip', ok: true },
      { error: null, kind: 'geosite', ok: true },
    ]);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'network_proxy.geodata.install',
        afterDiff: expect.objectContaining({
          kinds: ['geoip', 'geosite'],
          source: 'download',
        }),
        result: 'success',
        targetId: 'geodata',
      }),
    );
  });

  it('maps a CAS conflict on the merged desired-artifacts write', async () => {
    setNetworkProxyRuntimeForTests(
      createRuntime({
        setDesiredArtifacts: vi.fn(async () => {
          throw new PlatformRevisionConflictError('conflict', {
            currentRevision: 9,
            expectedRevision: 1,
          });
        }),
      }),
    );
    const caller = await callerFor();
    try {
      await caller.installGeodata({ expectedRevision: 1 });
      expect.fail('should throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      );
    }
  });

  it('keeps the write and aggregates a partial local failure', async () => {
    const runtime = createRuntime();
    runtime.artifactManager.installFromDownload = vi.fn(async (kind) => {
      if (kind === 'geoip') throw Object.assign(new Error('geoip failed'), { name: 'Error' });
      return { sha256: 'def', version: 'c1' };
    });
    setNetworkProxyRuntimeForTests(runtime);
    const caller = await callerFor();
    const result = await caller.installGeodata({ expectedRevision: 1 });

    expect(runtime.setDesiredArtifacts).toHaveBeenCalled();
    expect(runtime.artifactManager.installFromDownload).toHaveBeenCalledTimes(2);
    expect(result.revision).toBe(2);
    expect(result.local.ok).toBe(false);
    expect(result.local.error).toEqual(expect.any(String));
    expect(result.results).toEqual([
      { error: expect.any(String), kind: 'geoip', ok: false },
      { error: null, kind: 'geosite', ok: true },
    ]);
    expect(result.local.error).toBe(result.results[0]?.error);
  });

  it('requires recent reauth and audits the denial', async () => {
    const caller = await callerFor('staleReauthSuper');
    try {
      await caller.installGeodata({ expectedRevision: 1 });
      expect.fail('should throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe('ADMIN_REAUTH_REQUIRED');
    }
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'network_proxy.geodata.install',
        result: 'denied',
      }),
    );
  });
});
