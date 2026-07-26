// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformIdentityProviderInstances,
  platformInstanceHeartbeats,
  platformInstanceRevisionStates,
  platformSettingsBundle,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformInstanceStatusService } from './statusService';

const db: LobeChatDatabase = await getTestDB();
const checksum = (digit: string) => digit.repeat(64);
const platformId = (digit: string) => `pinst_${digit.repeat(48)}`;
const identityId = (digit: string) => `oidci_${digit.repeat(48)}`;
const localIdentity = {
  hostnameHash: checksum('f'),
  instanceId: identityId('a'),
  startedAt: new Date(Date.now() - 300_000),
};

const cleanup = async () => {
  await db.delete(platformIdentityProviderInstances);
  await db.delete(platformInstanceRevisionStates);
  await db.delete(platformInstanceHeartbeats);
  await db.delete(platformSettingsBundle);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformInstanceStatusService (PGlite)', () => {
  it('always projects request-scoped domains as not-applicable without a target token', async () => {
    const snapshot = await new PlatformInstanceStatusService(db, {
      env: { ENABLE_PLATFORM_MANAGED_CONNECTORS: '1' },
    }).getStatus();

    expect(snapshot.domains.find(({ domain }) => domain === 'connector_catalog')).toMatchObject({
      errorCategory: null,
      status: 'not_applicable',
      targetToken: null,
    });
    expect(snapshot.domains.find(({ domain }) => domain === 'managed_policy')).toMatchObject({
      errorCategory: null,
      status: 'not_applicable',
      targetToken: null,
    });
  });

  it('computes exact fresh convergence counts and excludes stale state', async () => {
    const now = new Date();
    const ids = ['1', '2', '3', '4', '5'].map(platformId);
    await db.insert(platformSettingsBundle).values({
      id: 'global',
      revision: 2,
      status: 'published',
    });
    await db.insert(platformInstanceHeartbeats).values(
      ids.map((instanceId, index) => ({
        instanceId,
        lastHeartbeatAt:
          index === 4 ? new Date(now.getTime() - 120_000) : new Date(now.getTime() - index),
        startedAt: new Date(now.getTime() - 300_000),
      })),
    );
    await db.insert(platformInstanceRevisionStates).values([
      {
        domain: 'settings',
        health: 'healthy',
        instanceId: ids[0],
        loadedRevision: 2,
        loadMode: 'process_cached',
        source: 'database',
      },
      {
        domain: 'settings',
        health: 'healthy',
        instanceId: ids[1],
        loadedRevision: 1,
        loadMode: 'process_cached',
        source: 'cache',
      },
      {
        domain: 'settings',
        errorCategory: 'cache_unavailable',
        health: 'degraded',
        instanceId: ids[2],
        loadedRevision: 2,
        loadMode: 'process_cached',
        source: 'lkg',
      },
      {
        domain: 'settings',
        health: 'healthy',
        instanceId: ids[4],
        loadedRevision: 1,
        loadMode: 'process_cached',
        source: 'database',
      },
    ]);

    const snapshot = await new PlatformInstanceStatusService(db, {
      env: { ENABLE_PLATFORM_SETTINGS_POLICY: '1' },
    }).getStatus();
    const settings = snapshot.domains.find(({ domain }) => domain === 'settings');

    expect(settings).toMatchObject({
      counts: {
        degraded: 1,
        diverged: 1,
        fresh: 4,
        matching: 1,
        stale: 1,
        unreported: 1,
      },
      status: 'degraded',
      targetToken: { kind: 'revision', value: 2 },
    });
    expect(snapshot.freshDiagnostics).toHaveLength(4);
    expect(snapshot.recentStaleDiagnostics).toHaveLength(1);
    expect(
      snapshot.freshDiagnostics[0]?.domains.find(({ domain }) => domain === 'settings')?.status,
    ).not.toBe('converged');
  });

  it('projects identical domain summaries from getStatus and first-page inventory', async () => {
    const now = new Date();
    const ids = ['1', '2', '3'].map(platformId);
    await db.insert(platformSettingsBundle).values({
      id: 'global',
      revision: 3,
      status: 'published',
    });
    await db.insert(platformInstanceHeartbeats).values(
      ids.map((instanceId, index) => ({
        instanceId,
        lastHeartbeatAt: new Date(now.getTime() - index),
        startedAt: new Date(now.getTime() - 300_000),
      })),
    );
    await db.insert(platformInstanceRevisionStates).values(
      ids.map((instanceId, index) => ({
        domain: 'settings' as const,
        health: 'healthy' as const,
        instanceId,
        loadedRevision: index === 0 ? 3 : 2,
        loadMode: 'process_cached' as const,
        source: 'database' as const,
      })),
    );

    const service = new PlatformInstanceStatusService(db, {
      env: { ENABLE_PLATFORM_SETTINGS_POLICY: '1' },
    });
    const status = await service.getStatus();
    const inventory = await service.getRevisionInventoryPage({ includeDomains: true, limit: 10 });

    expect(inventory.domains.length).toBeGreaterThan(0);
    expect(inventory.domains).toEqual(status.domains);
  });

  it('projects OIDC startup state read-only and always degrades LKG fallback', async () => {
    const now = new Date();
    const target = checksum('b');
    await db.insert(platformIdentityProviderInstances).values([
      {
        activeIdentityRevision: target,
        health: 'healthy',
        hostnameHash: checksum('c'),
        instanceId: identityId('b'),
        lastHeartbeat: now,
        loadedAt: new Date(now.getTime() - 1_000),
        startedAt: new Date(now.getTime() - 120_000),
        startupGeneration: 'generation-fresh',
        startupSource: 'database',
      },
      {
        activeIdentityRevision: checksum('d'),
        health: 'healthy',
        hostnameHash: checksum('e'),
        instanceId: identityId('c'),
        lastHeartbeat: new Date(now.getTime() - 120_000),
        loadedAt: new Date(now.getTime() - 121_000),
        startedAt: new Date(now.getTime() - 180_000),
        startupGeneration: 'generation-stale',
        startupSource: 'database',
      },
      {
        activeIdentityRevision: null,
        health: 'healthy',
        hostnameHash: checksum('f'),
        instanceId: identityId('d'),
        lastHeartbeat: now,
        loadedAt: new Date(now.getTime() - 900),
        startedAt: new Date(now.getTime() - 60_000),
        startupGeneration: 'generation-unreported',
        startupSource: 'database',
      },
    ]);
    const snapshot = await new PlatformInstanceStatusService(db, {
      env: { ENABLE_DATABASE_OIDC: '1' },
      getIdentityArtifact: () => ({
        generation: 'local-generation',
        health: 'healthy',
        identityRevision: target,
        lastError: null,
        loadedAt: new Date(now.getTime() - 500),
        source: 'lkg',
      }),
      getIdentityProcess: () => localIdentity,
      getIdentityRegistrationState: () => 'registered',
      loadIdentityTarget: async () => ({
        environmentShadowed: [],
        identityRevision: target,
        providers: [],
      }),
    }).getStatus();
    const identity = snapshot.domains.find(({ domain }) => domain === 'identity');

    expect(identity).toMatchObject({
      counts: { degraded: 1, diverged: 1, fresh: 3, matching: 1, stale: 1, unreported: 0 },
      status: 'degraded',
    });
    const local = snapshot.freshDiagnostics.find(
      ({ instanceId }) => instanceId === localIdentity.instanceId,
    );
    expect(local).toMatchObject({
      domains: [
        {
          errorCategory: 'lkg_unavailable',
          source: 'lkg',
          status: 'degraded',
        },
      ],
      instanceKind: 'identity_startup',
    });
    expect(JSON.stringify(snapshot)).not.toContain('hostnameHash');
    expect(await db.select().from(platformInstanceRevisionStates)).toEqual([]);
  });

  it('projects a local registration failure only when a startup artifact exists', async () => {
    const target = checksum('b');
    const service = (withArtifact: boolean) =>
      new PlatformInstanceStatusService(db, {
        env: { ENABLE_DATABASE_OIDC: '1' },
        getIdentityArtifact: () =>
          withArtifact
            ? {
                generation: 'local-generation',
                health: 'healthy',
                identityRevision: target,
                lastError: null,
                loadedAt: new Date(),
                source: 'database',
              }
            : null,
        getIdentityProcess: () => localIdentity,
        getIdentityRegistrationState: () => 'failed',
        loadIdentityTarget: async () => ({
          environmentShadowed: [],
          identityRevision: target,
          providers: [],
        }),
      });

    const failed = await service(true).getStatus();
    expect(failed.domains.find(({ domain }) => domain === 'identity')).toMatchObject({
      counts: { degraded: 1, fresh: 1 },
      status: 'degraded',
    });
    expect(failed.freshDiagnostics[0]?.domains[0]).toMatchObject({
      errorCategory: 'instance_status_unavailable',
      source: 'unavailable',
      status: 'unavailable',
    });

    const absent = await service(false).getStatus();
    expect(absent.domains.find(({ domain }) => domain === 'identity')).toMatchObject({
      counts: { degraded: 0, fresh: 0 },
      status: 'unreported',
    });
    expect(absent.freshDiagnostics).toEqual([]);
  });

  it('caps diagnostics at 100 while retaining exact counts and truncation flags', async () => {
    const now = new Date();
    const freshCount = 102;
    await db.insert(platformInstanceHeartbeats).values(
      Array.from({ length: freshCount }, (_, index) => ({
        instanceId: `pinst_${index.toString(16).padStart(48, '0')}`,
        lastHeartbeatAt: new Date(now.getTime() - index),
        startedAt: new Date(now.getTime() - 300_000),
      })),
    );
    await db.update(platformInstanceHeartbeats).set({ lastHeartbeatAt: new Date() });

    const snapshot = await new PlatformInstanceStatusService(db, { env: {} }).getStatus();

    expect(snapshot.domains.find(({ domain }) => domain === 'settings')?.counts.fresh).toBe(
      freshCount,
    );
    expect(snapshot.freshDiagnostics).toHaveLength(100);
    expect(snapshot.freshDiagnosticsTruncated).toBe(true);
  });
});
