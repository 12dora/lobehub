// @vitest-environment node
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import { createUnmanagedResourcePolicyMap } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformManagedResourcePolicies,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import {
  MANAGED_POLICY_RESOURCE_ID,
  MANAGED_POLICY_RESOURCE_TYPE,
} from '@/types/platform/managedResources';

import { deletePlatformAuditLogsForTest } from '../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../testing/deletePlatformResourceRevisions';
import {
  isPlatformAiTakeoverActive,
  resetPlatformAiTakeoverCacheForTest,
} from './aiCatalog/enforcement';
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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const FIXTURE_ACTOR_IDS = ['admin-1', 'admin-2'] as const;

const deleteOwnedRevisions = () =>
  deletePlatformResourceRevisionsForTest(serverDB, {
    resourceIds: [MANAGED_POLICY_RESOURCE_ID],
    resourceType: MANAGED_POLICY_RESOURCE_TYPE,
  });

/** Scope whole-table revision assertions to this suite's managed-policy resource (SG-07). */
const ownedRevisions = () =>
  serverDB
    .select()
    .from(platformResourceRevisions)
    .where(
      and(
        eq(platformResourceRevisions.resourceType, MANAGED_POLICY_RESOURCE_TYPE),
        eq(platformResourceRevisions.resourceId, MANAGED_POLICY_RESOURCE_ID),
      ),
    );

beforeEach(async () => {
  await deletePlatformAuditLogsForTest(serverDB, { actorUserIds: FIXTURE_ACTOR_IDS });
  await deleteOwnedRevisions();
  await serverDB.delete(platformManagedResourcePolicies);
});

afterEach(async () => {
  await deletePlatformAuditLogsForTest(serverDB, { actorUserIds: FIXTURE_ACTOR_IDS });
  await deleteOwnedRevisions();
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

    expect(await ownedRevisions()).toHaveLength(0);
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

  it('drops the platform-AI takeover memo after the publish transaction commits', async () => {
    // Otherwise the publishing instance would keep answering runtime/router reads from the
    // pre-publish regime for the whole memo TTL, and the client's immediate post-transition
    // revalidation would cache the wrong regime permanently.
    resetPlatformAiTakeoverCacheForTest();
    const flags = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true };
    const service = new ManagedResourcePolicyService(serverDB, { readiness: allReady });
    const initial = await service.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.aiProviders = { enforcementMode: 'enforced', managed: true };
    await service.saveDraft({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      reason: 'prepare policy',
    });

    // Warm the memo with the pre-publish answer, then publish.
    expect(await isPlatformAiTakeoverActive(serverDB, flags)).toBe(false);
    await service.publish({
      actorUserId: 'admin-1',
      expectedDraftToken: (await service.get()).draftToken,
      expectedRevision: 0,
      reason: 'publish policy',
    });

    // No TTL wait: the very next read sees the freshly published policy.
    expect(await isPlatformAiTakeoverActive(serverDB, flags)).toBe(true);
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
    expect(await ownedRevisions()).toHaveLength(1);
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
    expect(await ownedRevisions()).toHaveLength(0);
    expect(invalidation.events).toHaveLength(0);
    expect(await serverDB.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.managedResources.publish',
        result: 'failure',
      }),
    );
  });

  it('save-vs-save locked CAS permits exactly one writer', async () => {
    const locked = deferred();
    const release = deferred();
    const first = new ManagedResourcePolicyService(serverDB, {
      lifecycle: {
        afterDraftLock: async () => {
          locked.resolve();
          await release.promise;
        },
      },
      readiness: allReady,
    });
    const second = new ManagedResourcePolicyService(serverDB, { readiness: allReady });
    const shared = (await first.get()).draftToken;
    const firstDraft = createUnmanagedResourcePolicyMap();
    firstDraft.agents = { enforcementMode: 'ui-only', managed: true };
    const secondDraft = createUnmanagedResourcePolicyMap();
    secondDraft.skills = { enforcementMode: 'ui-only', managed: true };

    const firstSave = first.saveDraft({
      actorUserId: 'admin-1',
      draft: firstDraft,
      expectedDraftToken: shared,
      reason: 'first save',
    });
    await locked.promise;
    const secondSave = second.saveDraft({
      actorUserId: 'admin-2',
      draft: secondDraft,
      expectedDraftToken: shared,
      reason: 'second save',
    });
    const secondSaveRejection = expect(secondSave).rejects.toBeInstanceOf(
      PlatformRevisionConflictError,
    );
    release.resolve();

    await expect(firstSave).resolves.toMatchObject({ ok: true });
    await secondSaveRejection;
    expect((await second.get()).draft).toEqual(firstDraft);
    const audits = await serverDB.select().from(platformAuditLogs);
    expect(audits.filter((row) => row.action === 'admin.managedResources.saveDraft')).toMatchObject(
      [
        { actorUserId: 'admin-1', result: 'success' },
        { actorUserId: 'admin-2', result: 'failure' },
      ],
    );
  });

  it('save-vs-publish locked CAS prevents publishing a stale draft token', async () => {
    const locked = deferred();
    const release = deferred();
    const saver = new ManagedResourcePolicyService(serverDB, {
      lifecycle: {
        afterDraftLock: async () => {
          locked.resolve();
          await release.promise;
        },
      },
      readiness: allReady,
    });
    const publisher = new ManagedResourcePolicyService(serverDB, { readiness: allReady });
    const initial = await saver.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.connectors = { enforcementMode: 'ui-only', managed: true };
    const save = saver.saveDraft({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      reason: 'save wins',
    });
    await locked.promise;
    const publish = publisher.publish({
      actorUserId: 'admin-2',
      expectedDraftToken: initial.draftToken,
      expectedRevision: 0,
      reason: 'stale publish',
    });
    const publishRejection = expect(publish).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    release.resolve();

    await expect(save).resolves.toMatchObject({ ok: true });
    await publishRejection;
    expect(await ownedRevisions()).toHaveLength(0);
    expect((await publisher.get()).published).toEqual(createUnmanagedResourcePolicyMap());
    expect(await serverDB.select().from(platformAuditLogs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'admin.managedResources.saveDraft',
          actorUserId: 'admin-1',
          result: 'success',
        }),
        expect.objectContaining({
          action: 'admin.managedResources.publish',
          actorUserId: 'admin-2',
          result: 'failure',
        }),
      ]),
    );
  });

  it('publish-vs-publish permits one revision and one materialized snapshot', async () => {
    const locked = deferred();
    const release = deferred();
    const first = new ManagedResourcePolicyService(serverDB, {
      lifecycle: {
        afterPublishLock: async () => {
          locked.resolve();
          await release.promise;
        },
      },
      readiness: allReady,
    });
    const second = new ManagedResourcePolicyService(serverDB, { readiness: allReady });
    const initial = await first.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.aiModels = { enforcementMode: 'ui-only', managed: true };
    await first.saveDraft({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      reason: 'seed',
    });
    const shared = await first.get();
    const firstPublish = first.publish({
      actorUserId: 'admin-1',
      expectedDraftToken: shared.draftToken,
      expectedRevision: 0,
      reason: 'first publish',
    });
    await locked.promise;
    const secondPublish = second.publish({
      actorUserId: 'admin-2',
      expectedDraftToken: shared.draftToken,
      expectedRevision: 0,
      reason: 'second publish',
    });
    const secondPublishRejection = expect(secondPublish).rejects.toBeInstanceOf(
      PlatformRevisionConflictError,
    );
    release.resolve();

    await expect(firstPublish).resolves.toMatchObject({ revision: 1 });
    await secondPublishRejection;
    expect(await ownedRevisions()).toHaveLength(1);
    const rows = await serverDB.select().from(platformManagedResourcePolicies);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.revision))).toEqual(new Set([1]));
    expect(rows.map((row) => row.config.published)).toEqual(
      expect.arrayContaining(Object.values(draft)),
    );
    expect(await serverDB.select().from(platformAuditLogs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'platform.managed_policy.publish',
          actorUserId: 'admin-1',
          configRevision: 1,
          result: 'success',
        }),
        expect.objectContaining({
          action: 'admin.managedResources.publish',
          actorUserId: 'admin-2',
          result: 'failure',
        }),
      ]),
    );
  });
});
