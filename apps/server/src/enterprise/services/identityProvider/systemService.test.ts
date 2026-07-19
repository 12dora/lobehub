// @vitest-environment node
import { and, eq } from 'drizzle-orm';
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

import { getIdentityProviderProcessInstance } from './instanceRegistry';
import type { RestartController } from './restartController';
import {
  commitIdentityProviderStartupSnapshot,
  resetIdentityProviderStartupArtifactForTest,
} from './startupArtifact';
import { IdentityProviderSystemService, loadPublishedIdentityTarget } from './systemService';

const db: LobeChatDatabase = await getTestDB();
const requestId = '550e8400-e29b-41d4-a716-446655440056';
const now = new Date();

const cleanup = async () => {
  await db.delete(platformIdentityProviderRestartRequests);
  await db.delete(platformIdentityProviderInstances);
  await db.delete(platformIdentityProviders);
  await db.delete(platformResourceRevisions);
  await db.delete(platformAuditLogs);
  resetIdentityProviderStartupArtifactForTest();
};

beforeEach(cleanup);
afterEach(cleanup);

const seedPendingTarget = async () => {
  const payload = { providerKey: 'work' };
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
      activeIdentityRevision: 'a'.repeat(64),
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
    ).getAuthSnapshotStatus();
    expect(status).toMatchObject({
      active: { allFreshInstancesActive: false, partial: true, staleInstances: 1 },
      pendingRestart: true,
      restart: { reason: null, supported: true },
      targetIdentityRevision: target,
    });
    expect(status.instances).toHaveLength(3);
    const [provider] = await db.select().from(platformIdentityProviders);
    expect(provider.status).toBe('pending_restart');
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
    const service = new IdentityProviderSystemService(db, controller, () => new Date());
    const prepared = await service.prepareRestart('admin-1', {
      reason: 'Activate the tested work login',
      requestId,
    });
    const first = await service.requestRestart('admin-1', {
      intentToken: prepared.intentToken,
      reason: 'Activate the tested work login',
      requestId,
    });
    const duplicate = await service.requestRestart('admin-1', {
      intentToken: prepared.intentToken,
      reason: 'Activate the tested work login',
      requestId,
    });
    expect(first).toMatchObject({ accepted: true, duplicate: false, status: 'signaled' });
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true, status: 'signaled' });
    expect(observations).toEqual(['accepted:1']);
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
    const service = new IdentityProviderSystemService(db, controller, () => now);
    await expect(
      service.prepareRestart('admin-1', { reason: 'Activate work login', requestId }),
    ).rejects.toMatchObject({ code: 'PLATFORM_IDENTITY_RESTART_UNSUPPORTED' });
    expect(signals).toBe(0);
  });
});
