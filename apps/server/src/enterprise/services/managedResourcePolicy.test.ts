// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { createUnmanagedResourcePolicyMap } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformManagedResourcePolicies,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  ManagedResourceCatalogNotReadyError,
  ManagedResourcePolicyService,
  PlatformRevisionConflictError,
} from './managedResourcePolicy';
import { InMemoryPlatformConfigInvalidationPublisher } from './platformConfigInvalidation';

const serverDB: LobeChatDatabase = await getTestDB();
const allReady = async () => ({
  agents: true,
  aiModels: true,
  aiProviders: true,
  connectors: true,
  skills: true,
});
const noneReady = async () => ({
  agents: false,
  aiModels: false,
  aiProviders: false,
  connectors: false,
  skills: false,
});

beforeEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(platformManagedResourcePolicies);
});

afterEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(platformManagedResourcePolicies);
});

describe('ManagedResourcePolicyService', () => {
  it('gets a closed initial draft and readiness without exposing an internal rule payload', async () => {
    const result = await new ManagedResourcePolicyService(serverDB, { readiness: noneReady }).get();
    expect(result).toMatchObject({
      baseRevision: 0,
      draft: createUnmanagedResourcePolicyMap(),
      published: createUnmanagedResourcePolicyMap(),
      status: 'draft',
    });
    expect(result.draftToken).toMatch(/^[\da-f]{64}$/);
  });

  it('saves draft atomically with audit and rejects stale draft tokens', async () => {
    const service = new ManagedResourcePolicyService(serverDB, { readiness: allReady });
    const initial = await service.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.connectors = { enforcementMode: 'ui-only', managed: true };

    const saved = await service.saveDraft({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      reason: 'prepare connector policy',
    });
    expect(saved.draftToken).not.toBe(initial.draftToken);
    expect((await service.get()).published.connectors.managed).toBe(false);

    await expect(
      service.saveDraft({
        actorUserId: 'admin-2',
        draft: createUnmanagedResourcePolicyMap(),
        expectedDraftToken: initial.draftToken,
        reason: 'stale overwrite',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const audits = await serverDB.select().from(platformAuditLogs);
    expect(audits.map((audit) => [audit.action, audit.result])).toEqual(
      expect.arrayContaining([
        ['admin.managedResources.saveDraft', 'success'],
        ['admin.managedResources.saveDraft', 'failure'],
      ]),
    );
  });

  it('blocks enforced publish until catalog readiness and leaves no partial revision', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new ManagedResourcePolicyService(serverDB, {
      invalidation,
      readiness: noneReady,
    });
    const initial = await service.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.aiProviders = { enforcementMode: 'enforced', managed: true };
    await service.saveDraft({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      reason: 'prepare enforcement',
    });

    await expect(
      service.publish({
        actorUserId: 'admin-1',
        expectedDraftToken: (await service.get()).draftToken,
        expectedRevision: 0,
        reason: 'unsafe publish',
      }),
    ).rejects.toBeInstanceOf(ManagedResourceCatalogNotReadyError);

    expect(await serverDB.select().from(platformResourceRevisions)).toHaveLength(0);
    expect((await service.get()).published.aiProviders.managed).toBe(false);
    expect(invalidation.events).toHaveLength(0);
  });

  it('publishes revision and all five effective rows atomically before invalidation', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new ManagedResourcePolicyService(serverDB, {
      invalidation,
      readiness: allReady,
    });
    const initial = await service.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.aiProviders = { enforcementMode: 'enforced', managed: true };
    draft.skills = { enforcementMode: 'observe', managed: true };
    await service.saveDraft({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      reason: 'prepare policy',
    });
    const result = await service.publish({
      actorUserId: 'admin-1',
      expectedDraftToken: (await service.get()).draftToken,
      expectedRevision: 0,
      reason: 'publish policy',
    });

    expect(result.revision).toBe(1);
    const current = await service.get();
    expect(current.published).toEqual(draft);
    expect(current.baseRevision).toBe(1);
    const rows = await serverDB.select().from(platformManagedResourcePolicies);
    expect(new Set(rows.map((row) => row.revision))).toEqual(new Set([1]));
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(['published']));
    expect(invalidation.events).toHaveLength(1);
    expect(invalidation.events[0]?.scopes).toEqual(['managed-policy', 'capabilities']);
  });

  it('rejects stale expected revision without changing the published snapshot', async () => {
    const service = new ManagedResourcePolicyService(serverDB, { readiness: allReady });
    const initial = await service.get();
    await service.saveDraft({
      actorUserId: 'admin-1',
      draft: initial.draft,
      expectedDraftToken: initial.draftToken,
      reason: 'seed',
    });
    await service.publish({
      actorUserId: 'admin-1',
      expectedDraftToken: (await service.get()).draftToken,
      expectedRevision: 0,
      reason: 'v1',
    });

    await expect(
      service.publish({
        actorUserId: 'admin-1',
        expectedDraftToken: (await service.get()).draftToken,
        expectedRevision: 0,
        reason: 'stale revision',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect((await service.get()).baseRevision).toBe(1);
    expect(await serverDB.select().from(platformResourceRevisions)).toHaveLength(1);
  });

  it('rolls back revision and effective rows when materialization transaction faults', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new ManagedResourcePolicyService(serverDB, {
      invalidation,
      lifecycle: {
        afterMaterialization: async () => {
          throw new Error('injected materialization fault');
        },
      },
      readiness: allReady,
    });
    const initial = await service.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.skills = { enforcementMode: 'ui-only', managed: true };
    await service.saveDraft({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      reason: 'prepare fault test',
    });

    await expect(
      service.publish({
        actorUserId: 'admin-1',
        expectedDraftToken: (await service.get()).draftToken,
        expectedRevision: 0,
        reason: 'faulted publish',
      }),
    ).rejects.toThrow('injected materialization fault');

    const current = await service.get();
    expect(current.baseRevision).toBe(0);
    expect(current.published.skills.managed).toBe(false);
    expect(await serverDB.select().from(platformResourceRevisions)).toHaveLength(0);
    expect(invalidation.events).toHaveLength(0);
    expect(await serverDB.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.managedResources.publish',
        result: 'failure',
      }),
    );
  });
});
