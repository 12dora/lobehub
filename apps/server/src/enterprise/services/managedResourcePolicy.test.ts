// @vitest-environment node
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
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
  isPlatformAgentTakeoverActive,
  resetPlatformAgentTakeoverCacheForTest,
} from './agentCatalog/enforcement';
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

  it('applies the policy atomically with audit and rejects stale draft tokens', async () => {
    const service = new ManagedResourcePolicyService(serverDB, { readiness: allReady });
    const initial = await service.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.connectors = { enforcementMode: 'ui-only', managed: true };

    const saved = await service.save({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      expectedRevision: initial.baseRevision,
      reason: 'roll out connector policy',
    });
    expect(saved.revision).toBe(1);
    const after = await service.get();
    expect(after.published.connectors.managed).toBe(true);
    // Draft column aligned with published: no pending state survives a save.
    expect(after.draft).toEqual(after.published);
    expect(after.status).toBe('published');

    await expect(
      service.save({
        actorUserId: 'admin-2',
        draft: createUnmanagedResourcePolicyMap(),
        expectedDraftToken: initial.draftToken,
        expectedRevision: initial.baseRevision,
        reason: 'stale overwrite',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const audits = await serverDB.select().from(platformAuditLogs);
    expect(audits.map((audit) => [audit.action, audit.result])).toEqual(
      expect.arrayContaining([
        ['admin.managedResources.save', 'success'],
        ['admin.managedResources.save', 'failure'],
      ]),
    );
  });

  it('blocks an enforced save until catalog readiness and leaves no partial revision', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new ManagedResourcePolicyService(serverDB, {
      invalidation,
      readiness: noneReady,
    });
    const initial = await service.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.aiProviders = { enforcementMode: 'enforced', managed: true };

    await expect(
      service.save({
        actorUserId: 'admin-1',
        draft,
        expectedDraftToken: initial.draftToken,
        expectedRevision: initial.baseRevision,
        reason: 'unsafe enforcement',
      }),
    ).rejects.toBeInstanceOf(ManagedResourceCatalogNotReadyError);

    expect(await ownedRevisions()).toHaveLength(0);
    const after = await service.get();
    expect(after.published.aiProviders.managed).toBe(false);
    // The blocked save must not leave the rejected map behind as a draft either.
    expect(after.draft.aiProviders.managed).toBe(false);
    expect(invalidation.events).toHaveLength(0);
  });

  it('blocks an enforced agents save until catalog readiness and leaves no partial revision', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new ManagedResourcePolicyService(serverDB, {
      invalidation,
      readiness: noneReady,
    });
    const initial = await service.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.agents = { enforcementMode: 'enforced', managed: true };

    await expect(
      service.save({
        actorUserId: 'admin-1',
        draft,
        expectedDraftToken: initial.draftToken,
        expectedRevision: initial.baseRevision,
        reason: 'unsafe agent enforcement',
      }),
    ).rejects.toBeInstanceOf(ManagedResourceCatalogNotReadyError);

    expect(await ownedRevisions()).toHaveLength(0);
    const after = await service.get();
    expect(after.published.agents.managed).toBe(false);
    expect(after.draft.agents.managed).toBe(false);
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

    const result = await service.save({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      expectedRevision: initial.baseRevision,
      reason: 'apply policy',
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

  it('drops the platform-AI takeover memo after the save transaction commits', async () => {
    // Otherwise the publishing instance would keep answering runtime/router reads from the
    // pre-publish regime for the whole memo TTL, and the client's immediate post-transition
    // revalidation would cache the wrong regime permanently.
    resetPlatformAiTakeoverCacheForTest();
    const flags = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true };
    const service = new ManagedResourcePolicyService(serverDB, { readiness: allReady });
    const initial = await service.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.aiProviders = { enforcementMode: 'enforced', managed: true };

    // Warm the memo with the pre-save answer, then save.
    expect(await isPlatformAiTakeoverActive(serverDB, flags)).toBe(false);
    await service.save({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      expectedRevision: initial.baseRevision,
      reason: 'apply policy',
    });

    // No TTL wait: the very next read sees the freshly published policy.
    expect(await isPlatformAiTakeoverActive(serverDB, flags)).toBe(true);
  });

  it('drops the platform-agent takeover memo after the save transaction commits', async () => {
    resetPlatformAgentTakeoverCacheForTest();
    const flags = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };
    const service = new ManagedResourcePolicyService(serverDB, { readiness: allReady });
    const initial = await service.get();
    const draft = createUnmanagedResourcePolicyMap();
    draft.agents = { enforcementMode: 'enforced', managed: true };

    expect(await isPlatformAgentTakeoverActive(serverDB, flags)).toBe(false);
    await service.save({
      actorUserId: 'admin-1',
      draft,
      expectedDraftToken: initial.draftToken,
      expectedRevision: initial.baseRevision,
      reason: 'apply policy',
    });

    expect(await isPlatformAgentTakeoverActive(serverDB, flags)).toBe(true);
  });

  it('rejects a stale expected revision without changing the published snapshot', async () => {
    const service = new ManagedResourcePolicyService(serverDB, { readiness: allReady });
    const initial = await service.get();
    await service.save({
      actorUserId: 'admin-1',
      draft: initial.draft,
      expectedDraftToken: initial.draftToken,
      expectedRevision: initial.baseRevision,
      reason: 'v1',
    });

    const current = await service.get();
    await expect(
      service.save({
        actorUserId: 'admin-1',
        draft: current.draft,
        expectedDraftToken: current.draftToken,
        expectedRevision: 0,
        reason: 'stale revision',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect((await service.get()).baseRevision).toBe(1);
    expect(await ownedRevisions()).toHaveLength(1);
  });

  it('rejects a save whose expected revision is current but whose draft token is stale', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new ManagedResourcePolicyService(serverDB, {
      invalidation,
      readiness: allReady,
    });
    const base = await service.get();
    // A stranded legacy draft moves the token without moving the revision.
    const stranded = createUnmanagedResourcePolicyMap();
    stranded.skills = { enforcementMode: 'ui-only', managed: true };
    await new PlatformManagedResourcePolicyModel(serverDB).replaceDraft({
      draft: stranded,
      updatedBy: 'admin-1',
    });
    const current = await service.get();
    expect(current.baseRevision).toBe(base.baseRevision);
    expect(current.draftToken).not.toBe(base.draftToken);

    const next = createUnmanagedResourcePolicyMap();
    next.agents = { enforcementMode: 'ui-only', managed: true };
    await expect(
      service.save({
        actorUserId: 'admin-1',
        draft: next,
        expectedDraftToken: base.draftToken,
        expectedRevision: current.baseRevision,
        reason: 'token-only stale base',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(await ownedRevisions()).toHaveLength(0);
    expect(invalidation.events).toHaveLength(0);
    expect((await service.get()).published.agents.managed).toBe(false);

    // Same revision, matching token → the save goes through.
    await expect(
      service.save({
        actorUserId: 'admin-1',
        draft: next,
        expectedDraftToken: current.draftToken,
        expectedRevision: current.baseRevision,
        reason: 'token-matched save',
      }),
    ).resolves.toMatchObject({ revision: 1 });
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

    await expect(
      service.save({
        actorUserId: 'admin-1',
        draft,
        expectedDraftToken: initial.draftToken,
        expectedRevision: initial.baseRevision,
        reason: 'faulted save',
      }),
    ).rejects.toThrow('injected materialization fault');

    const current = await service.get();
    expect(current.baseRevision).toBe(0);
    expect(current.published.skills.managed).toBe(false);
    expect(current.draft.skills.managed).toBe(false);
    expect(await ownedRevisions()).toHaveLength(0);
    expect(invalidation.events).toHaveLength(0);
    expect(await serverDB.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.managedResources.save',
        result: 'failure',
      }),
    );
  });

  it('save-vs-save locked CAS permits exactly one writer and one revision', async () => {
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
    const shared = await first.get();
    const firstDraft = createUnmanagedResourcePolicyMap();
    firstDraft.agents = { enforcementMode: 'ui-only', managed: true };
    const secondDraft = createUnmanagedResourcePolicyMap();
    secondDraft.skills = { enforcementMode: 'ui-only', managed: true };

    const firstSave = first.save({
      actorUserId: 'admin-1',
      draft: firstDraft,
      expectedDraftToken: shared.draftToken,
      expectedRevision: shared.baseRevision,
      reason: 'first save',
    });
    await locked.promise;
    const secondSave = second.save({
      actorUserId: 'admin-2',
      draft: secondDraft,
      expectedDraftToken: shared.draftToken,
      expectedRevision: shared.baseRevision,
      reason: 'second save',
    });
    const secondSaveRejection = expect(secondSave).rejects.toBeInstanceOf(
      PlatformRevisionConflictError,
    );
    release.resolve();

    await expect(firstSave).resolves.toMatchObject({ revision: 1 });
    await secondSaveRejection;
    expect((await second.get()).published).toEqual(firstDraft);
    expect(await ownedRevisions()).toHaveLength(1);
    const rows = await serverDB.select().from(platformManagedResourcePolicies);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.revision))).toEqual(new Set([1]));
    expect(await serverDB.select().from(platformAuditLogs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'platform.managed_policy.publish',
          actorUserId: 'admin-1',
          configRevision: 1,
          result: 'success',
        }),
        expect.objectContaining({
          action: 'admin.managedResources.save',
          actorUserId: 'admin-1',
          configRevision: 1,
          result: 'success',
        }),
        expect.objectContaining({
          action: 'admin.managedResources.save',
          actorUserId: 'admin-2',
          result: 'failure',
        }),
      ]),
    );
  });
});
