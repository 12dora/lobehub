// @vitest-environment node
import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformIdentityProviderInstances,
  platformIdentityProviderRestartRequests,
  platformIdentityProviders,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  getIdentityProviderProcessInstance,
  markIdentityProviderInstanceRegistrationFailed,
  registerIdentityProviderInstance,
  stopIdentityProviderHeartbeatForTest,
} from './instanceRegistry';
import { identityProviderLkgIdentity } from './lkg';
import type { RestartController } from './restartController';
import {
  commitIdentityProviderStartupSnapshot,
  resetIdentityProviderStartupArtifactForTest,
} from './startupArtifact';
import {
  IDENTITY_PROVIDER_RECENT_STALE_DIAGNOSTIC_LIMIT,
  IdentityProviderSystemService,
  loadPublishedIdentityTarget,
} from './systemService';

const db: LobeChatDatabase = await getTestDB();
const requestId = '550e8400-e29b-41d4-a716-446655440056';
const now = new Date();

const cleanup = async () => {
  // Immutable revisions + append-only audit require trigger bypass for test fixtures.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.delete(platformIdentityProviderRestartRequests);
    await tx.delete(platformIdentityProviderInstances);
    await tx.delete(platformIdentityProviders);
    await tx.delete(platformResourceRevisions);
    await tx.delete(platformAuditLogs);
  });
  resetIdentityProviderStartupArtifactForTest();
  stopIdentityProviderHeartbeatForTest();
};

beforeEach(cleanup);
afterEach(cleanup);

const seedPendingTarget = async () => {
  const payload = {
    autoProvision: true,
    buttonLabel: 'Work account',
    claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
    clientId: 'client-id',
    displayName: 'Work',
    domainAllowlist: [],
    enabled: true,
    groupRoleMapping: {},
    icon: null,
    issuer: 'https://login.example.test',
    providerKey: 'work',
    scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
    secretFingerprint: 'b'.repeat(64),
    secretUpdatedAt: now.toISOString(),
    type: 'generic_oidc' as const,
    usePkce: true as const,
  };
  await db.insert(platformIdentityProviders).values({
    activationRevision: 1,
    buttonLabel: 'Work account',
    displayName: 'Work',
    enabled: true,
    id: 'provider-work',
    providerKey: 'work',
    revision: 1,
    status: 'pending_restart',
  });
  await db.insert(platformResourceRevisions).values({
    checksum: checksumPayload(payload),
    id: 'revision-work-1',
    payload,
    publishedAt: now,
    resourceId: 'provider-work',
    resourceType: 'oidc',
    revision: 1,
    secretFingerprint: 'b'.repeat(64),
    status: 'published',
  });
  return (await loadPublishedIdentityTarget(db)).identityRevision!;
};

const insertInstance = async (input: {
  activeIdentityRevision: string;
  instanceId: string;
  lastHeartbeat?: Date;
}) => {
  await db.insert(platformIdentityProviderInstances).values({
    activeIdentityRevision: input.activeIdentityRevision,
    health: 'healthy',
    hostnameHash: 'c'.repeat(64),
    instanceId: input.instanceId,
    lastHeartbeat: input.lastHeartbeat ?? now,
    loadedAt: now,
    startedAt: new Date(now.getTime() - 120_000),
    startupGeneration: 'generation',
    startupSource: 'database',
  });
};

const commitArtifact = (identityRevision: string) => {
  commitIdentityProviderStartupSnapshot({
    databaseProviders: [],
    generation: 'old-generation',
    health: 'healthy',
    identityRevision,
    lastError: null,
    loadedAt: now,
    providerIds: ['work'],
    source: 'database',
  });
};

describe('IdentityProviderSystemService', () => {
  it('derives partial and stale multi-instance state without changing provider status', async () => {
    const target = await seedPendingTarget();
    const local = getIdentityProviderProcessInstance();
    commitArtifact('a'.repeat(64));
    await insertInstance({ activeIdentityRevision: target, instanceId: local.instanceId });
    await insertInstance({
      activeIdentityRevision: target,
      instanceId: `oidci_${'d'.repeat(48)}`,
    });
    await insertInstance({
      activeIdentityRevision: target,
      instanceId: `oidci_${'e'.repeat(48)}`,
      lastHeartbeat: new Date(now.getTime() - 100_000),
    });
    const controller: RestartController = {
      capability: () => ({ reason: null, supported: true }),
      schedule: async () => undefined,
    };
    const status = await new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
    ).getAuthSnapshotStatus();
    expect(status).toMatchObject({
      active: { allFreshInstancesActive: false, partial: true, staleInstances: 1 },
      pendingRestart: true,
      restart: { reason: null, supported: true },
      restartRequest: null,
      targetIdentityRevision: target,
    });
    expect(status.instances).toHaveLength(3);
    const [provider] = await db.select().from(platformIdentityProviders);
    expect(provider.status).toBe('pending_restart');
  });

  it('surfaces terminal schedule failure on the next auth snapshot status poll', async () => {
    await seedPendingTarget();
    const local = getIdentityProviderProcessInstance();
    commitArtifact('a'.repeat(64));
    await insertInstance({ activeIdentityRevision: 'a'.repeat(64), instanceId: local.instanceId });
    const controller: RestartController = {
      capability: () => ({ reason: null, supported: true }),
      schedule: async () => {
        throw new Error('schedule unavailable');
      },
    };
    const afterResponse: Array<() => Promise<void>> = [];
    // Wall-clock now so acceptedAt cannot precede DB-side createdAt (time_check).
    const service = new IdentityProviderSystemService(
      db,
      controller,
      () => new Date(),
      (task) => afterResponse.push(task),
    );
    const prepared = await service.prepareRestart('admin-1', {
      reason: 'Activate the tested work login',
      requestId,
    });
    await service.requestRestart('admin-1', {
      intentToken: prepared.intentToken,
      reason: 'Activate the tested work login',
      requestId,
    });
    await afterResponse.shift()!();
    const status = await service.getAuthSnapshotStatus();
    expect(status.restartRequest).toMatchObject({
      requestId,
      resultCategory: 'signal_schedule_failed',
      status: 'failed',
    });
  });

  it('signals only after accepted state commits and exact duplicates never signal twice', async () => {
    await seedPendingTarget();
    const local = getIdentityProviderProcessInstance();
    commitArtifact('a'.repeat(64));
    await insertInstance({ activeIdentityRevision: 'a'.repeat(64), instanceId: local.instanceId });
    const observations: string[] = [];
    const controller: RestartController = {
      capability: () => ({ reason: null, supported: true }),
      schedule: async ({ requestId: scheduledRequestId }) => {
        const [row] = await db
          .select()
          .from(platformIdentityProviderRestartRequests)
          .where(eq(platformIdentityProviderRestartRequests.requestId, scheduledRequestId));
        const audits = await db
          .select()
          .from(platformAuditLogs)
          .where(
            and(
              eq(platformAuditLogs.requestId, scheduledRequestId),
              eq(platformAuditLogs.action, 'admin.system.requestRestart'),
            ),
          );
        observations.push(`${row.status}:${audits.length}`);
      },
    };
    const afterResponse: Array<() => Promise<void>> = [];
    const acceptedServerTime = new Date(Date.now() + 1000);
    let serverNow = acceptedServerTime;
    const service = new IdentityProviderSystemService(
      db,
      controller,
      () => serverNow,
      (task) => afterResponse.push(task),
    );
    const prepared = await service.prepareRestart('admin-1', {
      reason: 'Activate the tested work login',
      requestId,
    });
    const first = await service.requestRestart('admin-1', {
      intentToken: prepared.intentToken,
      reason: 'Activate the tested work login',
      requestId,
    });
    expect(first).toMatchObject({
      accepted: true,
      acceptedAt: expect.any(Date),
      convergenceDeadlineAt: new Date(acceptedServerTime.getTime() + 120_000),
      duplicate: false,
      expectedIdentityRevision: prepared.expectedIdentityRevision,
      remainingMs: 120_000,
      requestId,
      serverNow: acceptedServerTime,
      status: 'accepted',
    });
    expect(observations).toEqual([]);
    const [acceptedRow] = await db
      .select()
      .from(platformIdentityProviderRestartRequests)
      .where(eq(platformIdentityProviderRestartRequests.requestId, requestId));
    expect(acceptedRow.status).toBe('accepted');
    await afterResponse.shift()!();
    serverNow = new Date(acceptedServerTime.getTime() + 30_000);
    const duplicate = await service.requestRestart('admin-1', {
      intentToken: prepared.intentToken,
      reason: 'Activate the tested work login',
      requestId,
    });
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true, status: 'signaled' });
    expect(duplicate.acceptedAt).toEqual(first.acceptedAt);
    expect(duplicate.convergenceDeadlineAt).toEqual(first.convergenceDeadlineAt);
    expect(duplicate.expectedIdentityRevision).toBe(prepared.expectedIdentityRevision);
    expect(duplicate.remainingMs).toBe(90_000);
    expect(duplicate.serverNow).toEqual(serverNow);
    expect(observations).toEqual(['signaled:1']);
  });

  it('fails closed when restart is unsupported and never schedules', async () => {
    await seedPendingTarget();
    const local = getIdentityProviderProcessInstance();
    commitArtifact('a'.repeat(64));
    await insertInstance({ activeIdentityRevision: 'a'.repeat(64), instanceId: local.instanceId });
    let signals = 0;
    const controller: RestartController = {
      capability: () => ({ reason: 'serverless_runtime', supported: false }),
      schedule: async () => {
        signals += 1;
      },
    };
    const service = new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
    );
    await expect(
      service.prepareRestart('admin-1', { reason: 'Activate work login', requestId }),
    ).rejects.toMatchObject({ code: 'PLATFORM_IDENTITY_RESTART_UNSUPPORTED' });
    expect(signals).toBe(0);
  });

  it('uses startup canonical selection for environment overrides and damaged shadows', async () => {
    await seedPendingTarget();
    const emptyIdentity = identityProviderLkgIdentity([]);
    await expect(loadPublishedIdentityTarget(db, { AUTH_SSO_PROVIDERS: 'work' })).resolves.toEqual({
      environmentShadowed: [{ providerId: 'provider-work', providerKey: 'work' }],
      identityRevision: emptyIdentity,
      providers: [],
    });

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .update(platformResourceRevisions)
        .set({ payload: { providerKey: 'work', secretFingerprint: 'broken' } })
        .where(eq(platformResourceRevisions.resourceId, 'provider-work'));
    });
    await expect(loadPublishedIdentityTarget(db, { AUTH_SSO_PROVIDERS: 'work' })).resolves.toEqual({
      environmentShadowed: [{ providerId: 'provider-work', providerKey: 'work' }],
      identityRevision: emptyIdentity,
      providers: [],
    });
    await expect(loadPublishedIdentityTarget(db, {})).rejects.toMatchObject({
      code: 'PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE',
    });
  });

  it('keeps the current responder fail-closed when instance registration failed', async () => {
    const target = await seedPendingTarget();
    const local = getIdentityProviderProcessInstance();
    commitArtifact(target);
    await insertInstance({ activeIdentityRevision: target, instanceId: local.instanceId });
    markIdentityProviderInstanceRegistrationFailed();
    const controller: RestartController = {
      capability: () => ({ reason: null, supported: true }),
      schedule: async () => undefined,
    };
    const status = await new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
    ).getAuthSnapshotStatus();
    expect(status.active.allFreshInstancesActive).toBe(false);
    expect(status.pendingRestart).toBe(true);
    expect(status.artifact).toMatchObject({
      degradedCategory: 'instance_status_unavailable',
      health: 'degraded',
    });
  });

  it('reconciles pending providers after every fresh instance is active', async () => {
    const target = await seedPendingTarget();
    const local = getIdentityProviderProcessInstance();
    commitArtifact(target);
    await insertInstance({ activeIdentityRevision: target, instanceId: local.instanceId });
    await insertInstance({
      activeIdentityRevision: 'a'.repeat(64),
      instanceId: `oidci_${'f'.repeat(48)}`,
      lastHeartbeat: new Date(now.getTime() - 100_000),
    });
    const controller: RestartController = {
      capability: () => ({ reason: null, supported: true }),
      schedule: async () => undefined,
    };
    const status = await new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
    ).getAuthSnapshotStatus();
    expect(status).toMatchObject({
      active: { allFreshInstancesActive: true, staleInstances: 1 },
      pendingPublished: [],
      pendingRestart: false,
    });
    const [provider] = await db.select().from(platformIdentityProviders);
    expect(provider.status).toBe('active');
  });

  it('returns an active provider to pending when a degraded responder registers', async () => {
    const target = await seedPendingTarget();
    const local = getIdentityProviderProcessInstance();
    commitArtifact(target);
    await insertInstance({ activeIdentityRevision: target, instanceId: local.instanceId });
    const controller: RestartController = {
      capability: () => ({ reason: null, supported: true }),
      schedule: async () => undefined,
    };
    await new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
    ).getAuthSnapshotStatus();
    expect((await db.select().from(platformIdentityProviders))[0]?.status).toBe('active');

    await registerIdentityProviderInstance({
      db,
      env: { ENABLE_DATABASE_OIDC: '1', VERCEL: '1' },
      snapshot: {
        databaseProviders: [],
        generation: null,
        health: 'degraded',
        identityRevision: null,
        lastError: 'secret_unavailable',
        loadedAt: now,
        providerIds: [],
        source: 'break_glass',
      },
    });
    expect((await db.select().from(platformIdentityProviders))[0]?.status).toBe('pending_restart');
  });

  it('demotes an active DB provider blocked by a newly authoritative environment provider', async () => {
    const target = await seedPendingTarget();
    const local = getIdentityProviderProcessInstance();
    commitArtifact(target);
    await insertInstance({ activeIdentityRevision: target, instanceId: local.instanceId });
    const controller: RestartController = {
      capability: () => ({ reason: null, supported: true }),
      schedule: async () => undefined,
    };
    await new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
    ).getAuthSnapshotStatus();
    expect((await db.select().from(platformIdentityProviders))[0]?.status).toBe('active');

    const env = { AUTH_SSO_PROVIDERS: 'work', VERCEL: '1' };
    await registerIdentityProviderInstance({
      db,
      env,
      snapshot: {
        databaseProviders: [],
        generation: null,
        health: 'healthy',
        identityRevision: null,
        lastError: null,
        loadedAt: now,
        providerIds: ['work'],
        source: 'environment',
      },
    });
    commitIdentityProviderStartupSnapshot({
      databaseProviders: [],
      generation: null,
      health: 'healthy',
      identityRevision: null,
      lastError: null,
      loadedAt: now,
      providerIds: ['work'],
      source: 'environment',
    });

    const status = await new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
      env,
    ).getAuthSnapshotStatus();
    expect((await db.select().from(platformIdentityProviders))[0]?.status).toBe('pending_restart');
    expect(status).toMatchObject({
      pendingPublished: [
        {
          blockedCategory: 'environment_provider_shadowed',
          providerId: 'provider-work',
          providerKey: 'work',
        },
      ],
      pendingRestart: true,
      restart: { reason: 'environment_provider_shadowed', supported: false },
      targetIdentityRevision: identityProviderLkgIdentity([]),
    });
  });

  it('does not demote an active row when no published DB revision exists', async () => {
    await db.insert(platformIdentityProviders).values({
      activationRevision: 1,
      buttonLabel: 'Work account',
      displayName: 'Work',
      enabled: true,
      id: 'provider-work',
      providerKey: 'work',
      revision: 1,
      status: 'active',
    });
    await registerIdentityProviderInstance({
      db,
      env: { AUTH_SSO_PROVIDERS: 'work', VERCEL: '1' },
      snapshot: {
        databaseProviders: [],
        generation: null,
        health: 'healthy',
        identityRevision: null,
        lastError: null,
        loadedAt: now,
        providerIds: ['work'],
        source: 'environment',
      },
    });
    expect((await db.select().from(platformIdentityProviders))[0]?.status).toBe('active');
  });

  it('does not ignore a mismatched fresh instance beyond the old 200-row boundary', async () => {
    const target = await seedPendingTarget();
    const local = getIdentityProviderProcessInstance();
    commitArtifact(target);
    await insertInstance({ activeIdentityRevision: target, instanceId: local.instanceId });
    for (let index = 0; index < 201; index += 1) {
      await insertInstance({
        activeIdentityRevision: index === 200 ? 'a'.repeat(64) : target,
        instanceId: `oidci_${index.toString(16).padStart(48, '0')}`,
      });
    }
    const controller: RestartController = {
      capability: () => ({ reason: null, supported: true }),
      schedule: async () => undefined,
    };
    const status = await new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
    ).getAuthSnapshotStatus();
    expect(status.instances).toHaveLength(202);
    expect(status.active.allFreshInstancesActive).toBe(false);
    expect((await db.select().from(platformIdentityProviders))[0]?.status).toBe('pending_restart');
  });

  it('returns every fresh instance plus bounded, stable recent stale diagnostics', async () => {
    const target = await seedPendingTarget();
    const local = getIdentityProviderProcessInstance();
    commitArtifact(target);
    await insertInstance({
      activeIdentityRevision: target,
      instanceId: local.instanceId,
      lastHeartbeat: new Date(now.getTime() - 100_000),
    });
    const remoteFreshId = `oidci_${(900).toString(16).padStart(48, '0')}`;
    await insertInstance({ activeIdentityRevision: target, instanceId: remoteFreshId });
    const staleIds: string[] = [];
    for (let index = 0; index < IDENTITY_PROVIDER_RECENT_STALE_DIAGNOSTIC_LIMIT + 2; index += 1) {
      const instanceId = `oidci_${(1000 + index).toString(16).padStart(48, '0')}`;
      staleIds.push(instanceId);
      await insertInstance({
        activeIdentityRevision: target,
        instanceId,
        lastHeartbeat: new Date(now.getTime() - 100_000 - index * 1000),
      });
    }
    const controller: RestartController = {
      capability: () => ({ reason: null, supported: true }),
      schedule: async () => undefined,
    };
    const status = await new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
    ).getAuthSnapshotStatus();
    expect(status.active.staleInstances).toBe(staleIds.length);
    expect(
      status.instances.find(({ instanceId }) => instanceId === local.instanceId),
    ).toMatchObject({ fresh: true });
    expect(
      status.instances.filter(({ fresh }) => fresh).map(({ instanceId }) => instanceId),
    ).toEqual(expect.arrayContaining([local.instanceId, remoteFreshId]));
    expect(
      status.instances.filter(({ fresh }) => !fresh).map(({ instanceId }) => instanceId),
    ).toEqual(staleIds.slice(0, IDENTITY_PROVIDER_RECENT_STALE_DIAGNOSTIC_LIMIT));
  });
});
