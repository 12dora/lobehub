// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import {
  resetConnectorGovernanceCacheForTest,
  resolvePublishedConnectorGovernance,
} from './service';

const db: LobeChatDatabase = await getTestDB();

const flagOn = { ENABLE_PLATFORM_MANAGED_CONNECTORS: '1' };
const flagOff = { ENABLE_PLATFORM_MANAGED_CONNECTORS: '0' };

let publisher: InMemoryPlatformConfigInvalidationPublisher;

const cleanup = async () => {
  await db.delete(platformAuditLogs);
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

  it('fail-opens to the per-user default through resolveConnectorGovernance', async () => {
    const broken = { transaction: () => {} } as unknown as LobeChatDatabase;
    await expect(resolveConnectorGovernance(broken)).resolves.toEqual({
      active: false,
      builtinToolPolicies: {},
      sharedAuthOwnerUserId: null,
    });
  });
});
