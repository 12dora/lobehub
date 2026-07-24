// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformConnectorGovernanceModel,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { users } from '@/database/schemas';
import {
  platformAuditLogs,
  platformConnectorGovernance,
  platformManagedResourcePolicies,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  InMemoryPlatformConfigInvalidationPublisher,
  setPlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import { ConnectorGovernanceAdminService } from './adminService';
import { resolveConnectorGovernance } from './resolve';
import * as governanceService from './service';
import {
  getLastKnownConnectorGovernance,
  resetConnectorGovernanceCacheForTest,
  resolvePublishedConnectorGovernance,
} from './service';

const db: LobeChatDatabase = await getTestDB();

const flagOn = { ENABLE_PLATFORM_MANAGED_CONNECTORS: '1' };
const flagOff = { ENABLE_PLATFORM_MANAGED_CONNECTORS: '0' };

let publisher: InMemoryPlatformConfigInvalidationPublisher;

const cleanup = async () => {
  // Migration 0145 makes audit logs append-only; tests use the session GUC escape hatch.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await tx.delete(platformAuditLogs);
  });
  await db.delete(platformConnectorGovernance);
  await db.delete(platformManagedResourcePolicies);
  await db.delete(users).where(sql`${users.id} LIKE 'gov-%'`);
};

beforeEach(async () => {
  resetConnectorGovernanceCacheForTest();
  publisher = new InMemoryPlatformConfigInvalidationPublisher();
  setPlatformConfigInvalidationPublisher(publisher);
  await cleanup();
  await db.insert(users).values([{ id: 'gov-admin' }, { id: 'gov-owner' }]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetConnectorGovernanceCacheForTest();
  setPlatformConfigInvalidationPublisher(null);
  await cleanup();
});

const publishEnforcedConnectorPolicy = async () => {
  const policyModel = new PlatformManagedResourcePolicyModel(db);
  await policyModel.ensureRows();
  const policies = createUnmanagedResourcePolicyMap();
  policies.connectors = { enforcementMode: 'enforced', managed: true };
  await policyModel.materializePublished({ policies, revision: 1 });
};

const publishGovernanceDoc = async (ownerUserId: string | null = 'gov-owner') => {
  const service = new ConnectorGovernanceAdminService(db, {
    env: flagOn,
    invalidation: publisher,
  });
  await service.updateBuiltinToolPolicy({
    actorUserId: 'gov-admin',
    expectedRevision: 0,
    policies: { 'lobe-task': { createTask: 'disabled' } },
    reason: 'seed governance matrix',
  });
  await service.setSharedAuthorization({
    actorUserId: 'gov-admin',
    expectedRevision: 1,
    ownerUserId,
    reason: 'seed shared identity',
  });
};

describe('resolvePublishedConnectorGovernance', () => {
  it('is inactive with the empty doc when nothing is configured', async () => {
    await expect(resolvePublishedConnectorGovernance(db, { env: flagOn })).resolves.toEqual({
      active: false,
      builtinToolPolicies: {},
      sharedAuthOwnerUserId: null,
    });
  });

  it('returns the matrix but stays inactive while the policy is not effectively enforced', async () => {
    await publishGovernanceDoc();
    await expect(resolvePublishedConnectorGovernance(db, { env: flagOn })).resolves.toEqual({
      active: false,
      builtinToolPolicies: { 'lobe-task': { createTask: 'disabled' } },
      sharedAuthOwnerUserId: null,
    });
  });

  it('activates and exposes the shared owner when flag + managed + enforced all hold', async () => {
    await publishEnforcedConnectorPolicy();
    await publishGovernanceDoc();
    await expect(resolvePublishedConnectorGovernance(db, { env: flagOn })).resolves.toEqual({
      active: true,
      builtinToolPolicies: { 'lobe-task': { createTask: 'disabled' } },
      sharedAuthOwnerUserId: 'gov-owner',
    });
  });

  it('deactivates when the feature flag is off even with an enforced policy', async () => {
    await publishEnforcedConnectorPolicy();
    await publishGovernanceDoc();
    await expect(resolvePublishedConnectorGovernance(db, { env: flagOff })).resolves.toEqual({
      active: false,
      builtinToolPolicies: { 'lobe-task': { createTask: 'disabled' } },
      sharedAuthOwnerUserId: null,
    });
  });

  it('serves from cache within TTL and drops it when publish bumps the invalidation scope', async () => {
    await publishEnforcedConnectorPolicy();
    const now = Date.now();
    const first = await resolvePublishedConnectorGovernance(db, { env: flagOn, now: () => now });
    expect(first.sharedAuthOwnerUserId).toBeNull();

    // Direct model write without an invalidation bump: cache stays warm.
    await new PlatformConnectorGovernanceModel(db).publishGovernance({
      doc: {
        builtinToolPolicies: {},
        sharedAuthorization: { ownerUserId: 'gov-owner' },
      },
      expectedRevision: 0,
    });
    await expect(
      resolvePublishedConnectorGovernance(db, { env: flagOn, now: () => now + 1000 }),
    ).resolves.toMatchObject({ sharedAuthOwnerUserId: null });

    // Admin-service publish bumps `connector-governance`; the epoch change invalidates.
    await new ConnectorGovernanceAdminService(db, {
      env: flagOn,
      invalidation: publisher,
    }).setSharedAuthorization({
      actorUserId: 'gov-admin',
      expectedRevision: 1,
      ownerUserId: 'gov-owner',
      reason: 'switch shared identity',
    });
    await expect(
      resolvePublishedConnectorGovernance(db, { env: flagOn, now: () => now + 2000 }),
    ).resolves.toMatchObject({ sharedAuthOwnerUserId: 'gov-owner' });
  });

  it('governance_read_failure_always_denies_including_same_epoch_lkg', async () => {
    const { CONNECTOR_GOVERNANCE_DENY_SHARED_OWNER, DENIED_CONNECTOR_GOVERNANCE } =
      await import('./types');
    const broken = { transaction: () => {} } as unknown as LobeChatDatabase;
    // Unknown source → deny-all shape upstream already enforces.
    const denied = await resolveConnectorGovernance(broken);
    expect(denied.active).toBe(true);
    expect(denied.sharedAuthOwnerUserId).toBe(CONNECTOR_GOVERNANCE_DENY_SHARED_OWNER);
    expect('unavailable' in denied).toBe(false);
    // At least one known builtin API must be explicitly disabled (execution gate).
    const sampleDisabled = Object.values(denied.builtinToolPolicies).some((apis) =>
      Object.values(apis).includes('disabled'),
    );
    expect(sampleDisabled).toBe(true);
    expect(denied).toEqual(DENIED_CONNECTOR_GOVERNANCE);

    // Successful resolve still seeds process-local LKG for diagnostics/cache.
    await publishEnforcedConnectorPolicy();
    await publishGovernanceDoc();
    const epoch = 'gov-epoch-1';
    const lkg = await resolvePublishedConnectorGovernance(db, {
      env: flagOn,
      getCacheEpoch: async () => epoch,
    });
    expect(lkg).toMatchObject({
      active: true,
      builtinToolPolicies: { 'lobe-task': { createTask: 'disabled' } },
      sharedAuthOwnerUserId: 'gov-owner',
    });
    expect(getLastKnownConnectorGovernance(db)).toEqual(lkg);
    expect(governanceService.getLastKnownConnectorGovernanceEpoch(db)).toBe(epoch);

    // Same epoch → LKG helper still reports eligibility (internal/diagnostic).
    await expect(
      governanceService.getLastKnownConnectorGovernanceIfCurrent(db, {
        getCacheEpoch: async () => epoch,
      }),
    ).resolves.toEqual(lkg);

    // After policy invalidation (epoch advanced), LKG helper must not return it.
    await expect(
      governanceService.getLastKnownConnectorGovernanceIfCurrent(db, {
        getCacheEpoch: async () => 'gov-epoch-2-after-restrict',
      }),
    ).resolves.toBeNull();

    // Public resolve path never restores LKG — including same-epoch — because a
    // restrictive commit can stick in DB while invalidation (epoch bump) is lost.
    vi.spyOn(governanceService, 'resolvePublishedConnectorGovernance').mockRejectedValue(
      new Error('simulated governance read failure'),
    );
    await expect(resolveConnectorGovernance(db)).resolves.toEqual(DENIED_CONNECTOR_GOVERNANCE);
    // Even when LKG is same-epoch and would have been "current", deny.
    vi.spyOn(governanceService, 'getLastKnownConnectorGovernanceIfCurrent').mockResolvedValue(lkg);
    await expect(resolveConnectorGovernance(db)).resolves.toEqual(DENIED_CONNECTOR_GOVERNANCE);
    vi.restoreAllMocks();
  });

  it('invalidation_failure_does_not_reclassify_committed_governance_mutation', async () => {
    await publishEnforcedConnectorPolicy();
    const failingPublisher = {
      publish: vi.fn().mockRejectedValue(new Error('bus down')),
    };
    const service = new ConnectorGovernanceAdminService(db, {
      env: flagOn,
      invalidation: failingPublisher as never,
    });
    const before = await service.get();
    await expect(
      service.setSharedAuthorization({
        actorUserId: 'gov-admin',
        expectedRevision: before.revision,
        ownerUserId: 'gov-owner',
        reason: 'commit must succeed when only invalidation fails',
      }),
    ).resolves.toMatchObject({ revision: before.revision + 1 });
    // Authoritative document advanced despite invalidation failure.
    await expect(service.get()).resolves.toMatchObject({
      doc: { sharedAuthorization: { ownerUserId: 'gov-owner' } },
      revision: before.revision + 1,
    });
    expect(failingPublisher.publish).toHaveBeenCalled();
  });

  it('success_audit_failure_rolls_back_governance_mutation', async () => {
    await publishEnforcedConnectorPolicy();
    const service = new ConnectorGovernanceAdminService(db, {
      env: flagOn,
      invalidation: { publish: vi.fn(async () => {}) } as never,
    });
    const before = await service.get();
    // PlatformAuditService.append is an instance field — mock the constructor.
    const platformAudit = await import('../platformAudit');
    vi.spyOn(platformAudit, 'PlatformAuditService').mockImplementation(
      () =>
        ({
          append: vi.fn().mockRejectedValue(new Error('audit backend unavailable')),
        }) as never,
    );
    await expect(
      service.setSharedAuthorization({
        actorUserId: 'gov-admin',
        expectedRevision: before.revision,
        ownerUserId: 'gov-owner',
        reason: 'must not commit without success audit',
      }),
    ).rejects.toThrow(/audit backend unavailable/);
    // Mutation must not stick when the success audit cannot be written.
    await expect(service.get()).resolves.toMatchObject({
      doc: { sharedAuthorization: { ownerUserId: null } },
      revision: before.revision,
    });
  });
});
