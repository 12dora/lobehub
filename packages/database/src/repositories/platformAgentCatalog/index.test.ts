// @vitest-environment node
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { checksumPayload } from '../../models/platform/checksum';
import { agents } from '../../schemas/agent';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from '../../schemas/platform';
import { roles, userRoles } from '../../schemas/rbac';
import { users } from '../../schemas/user';
import { workspaces } from '../../schemas/workspace';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformAgentCatalogRepository } from '.';

const serverDB: LobeChatDatabase = await getTestDB();
const repository = new PlatformAgentCatalogRepository(serverDB);
const USER_A = 'm10-repo-user-a';
const USER_B = 'm10-repo-user-b';
const GLOBAL_ROLE = 'm10-repo-global-role';
const WORKSPACE_ROLE = 'm10-repo-workspace-role';
const WORKSPACE = 'm10-repo-workspace';
const LEGACY_ASSIGNMENT_KEYS = [
  'installedVersion',
  'lastError',
  'lastSyncedAt',
  'materializedAgentId',
  'userOverlay',
];

const config = {
  avatar: null,
  backgroundColor: null,
  description: 'Internal research',
  displayName: 'Research Agent',
  modelParameters: { maxTokens: 4096 },
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Use approved sources.',
  tags: ['research'],
};

const dependencySnapshot = {
  connectors: [
    {
      allowedToolKeys: ['search.query'],
      connectorId: 'connector-id',
      connectorKey: 'internal.search',
      publishedChecksum: 'c'.repeat(64),
      publishedRevision: 2,
    },
  ],
  model: {
    modelKey: 'chat-model',
    providerChecksum: 'a'.repeat(64),
    providerKey: 'provider',
    providerRevision: 3,
  },
  skills: [{ checksum: 'b'.repeat(64), skillKey: 'research', version: '1.0.0' }],
};

const cleanup = async () => {
  await serverDB.execute(sql`
    TRUNCATE TABLE
      ${platformUserAgentMaterializations},
      ${platformAgentAssignments},
      ${platformAgentVersions},
      ${platformAgents}
    CASCADE
  `);
  await serverDB.delete(agents).where(inArray(agents.id, ['m10-local-a', 'm10-local-b']));
  await serverDB.delete(userRoles).where(inArray(userRoles.userId, [USER_A, USER_B]));
  await serverDB.delete(roles).where(inArray(roles.id, [GLOBAL_ROLE, WORKSPACE_ROLE]));
  await serverDB.delete(workspaces).where(eq(workspaces.id, WORKSPACE));
  await serverDB.delete(users).where(inArray(users.id, [USER_A, USER_B]));
};

beforeEach(async () => {
  await cleanup();
  await serverDB.insert(users).values([{ id: USER_A }, { id: USER_B }]);
  await serverDB.insert(workspaces).values({
    id: WORKSPACE,
    name: 'M10 repository workspace',
    primaryOwnerId: USER_A,
    slug: WORKSPACE,
  });
  await serverDB.insert(roles).values([
    { displayName: 'Global role', id: GLOBAL_ROLE, name: GLOBAL_ROLE },
    {
      displayName: 'Workspace role',
      id: WORKSPACE_ROLE,
      name: WORKSPACE_ROLE,
      workspaceId: WORKSPACE,
    },
  ]);
});
afterEach(cleanup);

describe('PlatformAgentCatalogRepository', () => {
  it('uses revision plus draft sequence CAS and appends one immutable canonical version', async () => {
    const agent = await repository.createIdentity({
      agentKey: 'research',
      createdBy: USER_A,
      isDefault: false,
      systemKey: null,
    });
    expect(agent.migrationRequired).toBe(false);

    const attempts = await Promise.all([
      repository.appendVersionCas({
        agentId: agent.id,
        config,
        createdBy: USER_A,
        dependencySnapshot,
        expectedDraftSequence: 0,
        expectedRevision: 0,
        version: '1.0.0',
      }),
      repository.appendVersionCas({
        agentId: agent.id,
        config: { ...config, displayName: 'Stale write' },
        createdBy: USER_A,
        dependencySnapshot,
        expectedDraftSequence: 0,
        expectedRevision: 0,
        version: '1.0.1',
      }),
    ]);
    const created = attempts.filter((item) => item !== undefined);
    expect(created).toHaveLength(1);
    expect(created[0]?.checksum).toBe(
      checksumPayload({ config: created[0]?.config, dependencySnapshot }),
    );
    expect((await repository.getIdentity(agent.id))?.draftSequence).toBe(1);
    expect(await repository.getExactVersion(agent.id, created[0]!.id)).toMatchObject({
      checksum: created[0]!.checksum,
      dependencySnapshot,
      id: created[0]!.id,
    });
    await expect(
      serverDB
        .update(platformAgentVersions)
        .set({ version: '9.9.9' })
        .where(eq(platformAgentVersions.id, created[0]!.id)),
    ).rejects.toThrow();
  });

  it('moves the published pointer with same-Agent and stale-CAS protection', async () => {
    const first = await repository.createIdentity({
      agentKey: 'first',
      isDefault: false,
      systemKey: null,
    });
    const second = await repository.createIdentity({
      agentKey: 'second',
      isDefault: false,
      systemKey: null,
    });
    const firstVersion = await repository.appendVersionCas({
      agentId: first.id,
      config,
      dependencySnapshot,
      expectedDraftSequence: 0,
      expectedRevision: 0,
      version: '1.0.0',
    });
    const secondVersion = await repository.appendVersionCas({
      agentId: second.id,
      config,
      dependencySnapshot,
      expectedDraftSequence: 0,
      expectedRevision: 0,
      version: '1.0.0',
    });

    expect(
      await repository.pointToVersionCas({
        agentId: first.id,
        expectedDraftSequence: 1,
        expectedRevision: 0,
        publishedAt: new Date('2026-07-17T00:00:00Z'),
        versionId: secondVersion!.id,
      }),
    ).toBeUndefined();
    const published = await repository.pointToVersionCas({
      agentId: first.id,
      expectedDraftSequence: 1,
      expectedRevision: 0,
      publishedAt: new Date('2026-07-17T00:00:00Z'),
      versionId: firstVersion!.id,
    });
    expect(published).toMatchObject({
      currentVersionId: firstVersion!.id,
      draftSequence: 2,
      revision: 1,
      status: 'published',
    });
    expect(
      await repository.pointToVersionCas({
        agentId: first.id,
        expectedDraftSequence: 1,
        expectedRevision: 0,
        publishedAt: new Date(),
        versionId: firstVersion!.id,
      }),
    ).toBeUndefined();
  });

  it('keeps Draft identity writes behind two-dimensional CAS', async () => {
    const agent = await repository.createIdentity({
      agentKey: 'draft-cas',
      isDefault: false,
      systemKey: null,
    });
    expect(
      await repository.updateDraftCas({
        expectedDraftSequence: 9,
        expectedRevision: 0,
        id: agent.id,
        patch: { updatedBy: USER_A },
      }),
    ).toBeUndefined();
    expect(
      await repository.updateDraftCas({
        expectedDraftSequence: 0,
        expectedRevision: 0,
        id: agent.id,
        patch: { updatedBy: USER_A },
      }),
    ).toMatchObject({ draftSequence: 1, updatedBy: USER_A });
  });

  it('queries only active global/role/user assignment inputs in deterministic priority order', async () => {
    const agent = await repository.createIdentity({
      agentKey: 'effective',
      isDefault: false,
      systemKey: null,
    });
    const version1 = await repository.appendVersionCas({
      agentId: agent.id,
      config,
      dependencySnapshot,
      expectedDraftSequence: 0,
      expectedRevision: 0,
      version: '1.0.0',
    });
    const version2 = await repository.appendVersionCas({
      agentId: agent.id,
      config: { ...config, displayName: 'Pinned' },
      dependencySnapshot,
      expectedDraftSequence: 1,
      expectedRevision: 0,
      version: '2.0.0',
    });
    await repository.pointToVersionCas({
      agentId: agent.id,
      expectedDraftSequence: 2,
      expectedRevision: 0,
      publishedAt: new Date(),
      versionId: version1!.id,
    });
    await serverDB.insert(userRoles).values({ roleId: GLOBAL_ROLE, userId: USER_A });
    await repository.createAssignment({
      agentId: agent.id,
      enabled: true,
      mode: 'default',
      pinnedVersionId: null,
      targetId: '__global__',
      targetType: 'global',
      versionPolicy: 'latest_published',
    });
    await repository.createAssignment({
      agentId: agent.id,
      enabled: true,
      mode: 'mandatory',
      pinnedVersionId: null,
      targetId: GLOBAL_ROLE,
      targetType: 'global_role',
      versionPolicy: 'latest_published',
    });
    const userAssignment = (await repository.createAssignment({
      agentId: agent.id,
      enabled: true,
      mode: 'optional',
      pinnedVersionId: version2!.id,
      targetId: USER_A,
      targetType: 'user',
      versionPolicy: 'pinned',
    }))!;
    await serverDB
      .update(platformAgentAssignments)
      .set({
        installedVersion: 'legacy-poison',
        lastError: 'legacy poison must not cross the repository boundary',
        lastSyncedAt: new Date(),
        materializedAgentId: 'legacy-poison-local-agent',
        userOverlay: { secretLikeLegacyValue: 'must-not-leak' },
      })
      .where(eq(platformAgentAssignments.id, userAssignment.id));

    const inputs = await repository.listEffectiveInputs(USER_A);
    expect(inputs.map(({ targetPriority }) => targetPriority)).toEqual([3, 2, 1]);
    for (const { assignment } of inputs) {
      expect(Object.keys(assignment)).not.toEqual(expect.arrayContaining(LEGACY_ASSIGNMENT_KEYS));
    }
    expect(inputs[0]).toMatchObject({
      assignment: { id: userAssignment.id },
      version: { id: version2!.id },
    });
    expect(inputs[1]?.version.id).toBe(version1!.id);
    expect(
      (await repository.listEffectiveInputs(USER_B)).map(({ targetPriority }) => targetPriority),
    ).toEqual([1]);

    await expect(
      repository.createAssignment({
        agentId: agent.id,
        enabled: true,
        mode: 'default',
        pinnedVersionId: null,
        targetId: WORKSPACE_ROLE,
        targetType: 'global_role',
        versionPolicy: 'latest_published',
      }),
    ).rejects.toThrow();
    expect(
      await repository.updateAssignment(agent.id, userAssignment.id, {
        enabled: false,
        mode: 'optional',
        pinnedVersionId: version2!.id,
        targetId: USER_A,
        targetType: 'user',
        versionPolicy: 'pinned',
      }),
    ).toMatchObject({ enabled: false, id: userAssignment.id });
    const updatedAssignment = await repository.getAssignment(agent.id, userAssignment.id);
    expect(updatedAssignment).toMatchObject({ enabled: false });
    expect(Object.keys(updatedAssignment!)).not.toEqual(
      expect.arrayContaining(LEGACY_ASSIGNMENT_KEYS),
    );
    expect(await repository.deleteAssignment(agent.id, userAssignment.id)).toMatchObject({
      id: userAssignment.id,
    });
  });

  it('CAS-rolls materialization forward while preserving stable owner-scoped state', async () => {
    const agent = await repository.createIdentity({
      agentKey: 'materialized',
      isDefault: false,
      systemKey: null,
    });
    const version1 = await repository.appendVersionCas({
      agentId: agent.id,
      config,
      dependencySnapshot,
      expectedDraftSequence: 0,
      expectedRevision: 0,
      version: '1.0.0',
    });
    const version2 = await repository.appendVersionCas({
      agentId: agent.id,
      config: { ...config, displayName: 'Research Agent v2' },
      dependencySnapshot,
      expectedDraftSequence: 1,
      expectedRevision: 0,
      version: '2.0.0',
    });
    const version3 = await repository.appendVersionCas({
      agentId: agent.id,
      config: { ...config, displayName: 'Research Agent v3' },
      dependencySnapshot,
      expectedDraftSequence: 2,
      expectedRevision: 0,
      version: '3.0.0',
    });
    await serverDB.insert(agents).values([
      { id: 'm10-local-a', title: 'Local A', userId: USER_A },
      { id: 'm10-local-b', title: 'Local B', userId: USER_B },
    ]);

    const writes = await Promise.all([
      repository.upsertMaterialization({
        hidden: true,
        platformAgentId: agent.id,
        platformAgentVersionChecksum: version1!.checksum,
        platformAgentVersionId: version1!.id,
        userId: USER_A,
      }),
      repository.upsertMaterialization({
        hidden: true,
        platformAgentId: agent.id,
        platformAgentVersionChecksum: version1!.checksum,
        platformAgentVersionId: version1!.id,
        userId: USER_A,
      }),
    ]);
    expect(writes.every(Boolean)).toBe(true);
    expect(new Set(writes.map((item) => item!.id)).size).toBe(1);

    const materialized = await repository.upsertMaterialization({
      expectedCurrent: { checksum: version1!.checksum, versionId: version1!.id },
      materializedAgentId: 'm10-local-a',
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version1!.checksum,
      platformAgentVersionId: version1!.id,
      userId: USER_A,
    });
    expect(materialized).toMatchObject({
      hidden: true,
      materializedAgentId: 'm10-local-a',
      status: 'materialized',
    });

    const rolledForward = await repository.upsertMaterialization({
      expectedCurrent: { checksum: version1!.checksum, versionId: version1!.id },
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version2!.checksum,
      platformAgentVersionId: version2!.id,
      userId: USER_A,
    });
    expect(rolledForward).toMatchObject({
      hidden: true,
      materializedAgentId: 'm10-local-a',
      platformAgentVersionId: version2!.id,
      status: 'materialized',
    });

    expect(
      await repository.upsertMaterialization({
        expectedCurrent: { checksum: version1!.checksum, versionId: version1!.id },
        platformAgentId: agent.id,
        platformAgentVersionChecksum: version3!.checksum,
        platformAgentVersionId: version3!.id,
        userId: USER_A,
      }),
    ).toBeUndefined();
    expect(
      await repository.upsertMaterialization({
        expectedCurrent: { checksum: version1!.checksum, versionId: version1!.id },
        platformAgentId: agent.id,
        platformAgentVersionChecksum: version2!.checksum,
        platformAgentVersionId: version2!.id,
        userId: USER_A,
      }),
    ).toMatchObject({ id: materialized!.id, platformAgentVersionId: version2!.id });

    expect(
      await repository.upsertMaterialization({
        expectedCurrent: { checksum: version2!.checksum, versionId: version2!.id },
        materializedAgentId: 'm10-local-b',
        platformAgentId: agent.id,
        platformAgentVersionChecksum: version2!.checksum,
        platformAgentVersionId: version2!.id,
        userId: USER_A,
      }),
    ).toBeUndefined();
    expect(
      await repository.upsertMaterialization({
        expectedCurrent: { checksum: version2!.checksum, versionId: version2!.id },
        materializedAgentId: null,
        platformAgentId: agent.id,
        platformAgentVersionChecksum: version2!.checksum,
        platformAgentVersionId: version2!.id,
        userId: USER_A,
      }),
    ).toBeUndefined();

    const errored = await repository.upsertMaterialization({
      expectedCurrent: { checksum: version2!.checksum, versionId: version2!.id },
      lastErrorCategory: 'materialization_failed',
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version2!.checksum,
      platformAgentVersionId: version2!.id,
      status: 'error',
      userId: USER_A,
    });
    expect(errored).toMatchObject({
      hidden: true,
      lastErrorCategory: 'materialization_failed',
      materializedAgentId: 'm10-local-a',
      status: 'error',
    });
    expect(
      await repository.upsertMaterialization({
        expectedCurrent: { checksum: version2!.checksum, versionId: version2!.id },
        platformAgentId: agent.id,
        platformAgentVersionChecksum: version2!.checksum,
        platformAgentVersionId: version2!.id,
        userId: USER_A,
      }),
    ).toMatchObject({
      lastErrorCategory: 'materialization_failed',
      materializedAgentId: 'm10-local-a',
      status: 'error',
    });
    expect(await serverDB.select().from(platformUserAgentMaterializations)).toHaveLength(1);
  });

  it('upgrades a visibility-only hidden row to a real materialization instead of a bypass early-return', async () => {
    const agent = await repository.createIdentity({
      agentKey: 'vis-then-materialize',
      isDefault: false,
      systemKey: null,
    });
    const version1 = await repository.appendVersionCas({
      agentId: agent.id,
      config,
      dependencySnapshot,
      expectedDraftSequence: 0,
      expectedRevision: 0,
      version: '1.0.0',
    });

    // 1) hide first → a visibility-only row (last_synced_at NULL), NOT an archive reference.
    await repository.setMaterializationHidden({
      hidden: true,
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version1!.checksum,
      platformAgentVersionId: version1!.id,
      userId: USER_A,
    });
    const hiddenRow = await repository.getMaterialization(USER_A, agent.id);
    expect(hiddenRow!.lastSyncedAt).toBeNull();
    expect(hiddenRow!.hidden).toBe(true);
    expect((await repository.countAgentReferences(agent.id)).materializations).toBe(0);

    // 2) materialize (no expectedCurrent) with the SAME version/checksum. Pre-fix this hit
    //    matchesDesiredState and early-returned the visibility-only row, leaving last_synced_at
    //    NULL — a real pending materialization that archive would silently ignore.
    const materialized = await repository.upsertMaterialization({
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version1!.checksum,
      platformAgentVersionId: version1!.id,
      userId: USER_A,
    });
    expect(materialized).toBeDefined();
    const upgraded = await repository.getMaterialization(USER_A, agent.id);
    expect(upgraded!.lastSyncedAt).not.toBeNull(); // upgraded to a real materialization
    expect(upgraded!.hidden).toBe(true); // owner hidden preference preserved
    expect(upgraded!.status).toBe('pending');
    expect(upgraded!.platformAgentVersionId).toBe(version1!.id);
    expect((await repository.countAgentReferences(agent.id)).materializations).toBe(1);

    // 3) idempotent: a second materialize at the same desired real state does not refresh state.
    const stampedAt = upgraded!.lastSyncedAt;
    const again = await repository.upsertMaterialization({
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version1!.checksum,
      platformAgentVersionId: version1!.id,
      userId: USER_A,
    });
    expect(again!.lastSyncedAt).toEqual(stampedAt);
    expect(await serverDB.select().from(platformUserAgentMaterializations)).toHaveLength(1);
  });

  it('never overwrites a real materialization on a no-expectedCurrent call for a different version (CAS)', async () => {
    const agent = await repository.createIdentity({
      agentKey: 'cas-no-expected',
      isDefault: false,
      systemKey: null,
    });
    const version1 = await repository.appendVersionCas({
      agentId: agent.id,
      config,
      dependencySnapshot,
      expectedDraftSequence: 0,
      expectedRevision: 0,
      version: '1.0.0',
    });
    const version2 = await repository.appendVersionCas({
      agentId: agent.id,
      config: { ...config, displayName: 'v2' },
      dependencySnapshot,
      expectedDraftSequence: 1,
      expectedRevision: 0,
      version: '2.0.0',
    });

    // A real v1 materialization (fresh insert stamps last_synced_at).
    const v1mat = await repository.upsertMaterialization({
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version1!.checksum,
      platformAgentVersionId: version1!.id,
      userId: USER_A,
    });
    expect(v1mat!.lastSyncedAt).not.toBeNull();
    const before = await repository.getMaterialization(USER_A, agent.id);

    // No-expectedCurrent v2 must NOT clobber the real v1 — it returns undefined (fails pre-fix).
    const attempt = await repository.upsertMaterialization({
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version2!.checksum,
      platformAgentVersionId: version2!.id,
      userId: USER_A,
    });
    expect(attempt).toBeUndefined();
    const after = await repository.getMaterialization(USER_A, agent.id);
    expect(after!.platformAgentVersionId).toBe(version1!.id);
    expect(after!.platformAgentVersionChecksum).toBe(version1!.checksum);
    expect(after!.status).toBe(before!.status);
    expect(after!.lastSyncedAt).toEqual(before!.lastSyncedAt);
  });

  it('upgrades a visibility-only row with a correct expectedCurrent but rejects a wrong one (CAS)', async () => {
    const agent = await repository.createIdentity({
      agentKey: 'cas-expected',
      isDefault: false,
      systemKey: null,
    });
    const version1 = await repository.appendVersionCas({
      agentId: agent.id,
      config,
      dependencySnapshot,
      expectedDraftSequence: 0,
      expectedRevision: 0,
      version: '1.0.0',
    });
    const version2 = await repository.appendVersionCas({
      agentId: agent.id,
      config: { ...config, displayName: 'v2' },
      dependencySnapshot,
      expectedDraftSequence: 1,
      expectedRevision: 0,
      version: '2.0.0',
    });

    // hide → visibility-only row at v1 (last_synced_at NULL).
    await repository.setMaterializationHidden({
      hidden: true,
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version1!.checksum,
      platformAgentVersionId: version1!.id,
      userId: USER_A,
    });
    expect((await repository.getMaterialization(USER_A, agent.id))!.lastSyncedAt).toBeNull();

    // Wrong expectedCurrent (v2) must not upgrade the visibility-only row.
    const wrong = await repository.upsertMaterialization({
      expectedCurrent: { checksum: version2!.checksum, versionId: version2!.id },
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version1!.checksum,
      platformAgentVersionId: version1!.id,
      userId: USER_A,
    });
    expect(wrong).toBeUndefined();
    expect((await repository.getMaterialization(USER_A, agent.id))!.lastSyncedAt).toBeNull();

    // Correct expectedCurrent (v1, matching the visibility-only row) upgrades it to real.
    const right = await repository.upsertMaterialization({
      expectedCurrent: { checksum: version1!.checksum, versionId: version1!.id },
      platformAgentId: agent.id,
      platformAgentVersionChecksum: version1!.checksum,
      platformAgentVersionId: version1!.id,
      userId: USER_A,
    });
    expect(right).toBeDefined();
    const upgraded = await repository.getMaterialization(USER_A, agent.id);
    expect(upgraded!.lastSyncedAt).not.toBeNull();
    expect(upgraded!.hidden).toBe(true);
    expect(upgraded!.platformAgentVersionId).toBe(version1!.id);
  });

  describe('materializeLocalAgent + listMaterializedAgentIds (M10 PR-049)', () => {
    const seedVersion = async (agentKey: string) => {
      const agent = await repository.createIdentity({
        agentKey,
        isDefault: false,
        systemKey: null,
      });
      const version = await repository.appendVersionCas({
        agentId: agent.id,
        config,
        dependencySnapshot,
        expectedDraftSequence: 0,
        expectedRevision: 0,
        version: '1.0.0',
      });
      return { agentId: agent.id, version: version! };
    };

    // Each caller proposes its own local Agent id; only the winner's row must survive.
    const createLocalAgentFor = (userId: string, localId: string) => async (tx: Transaction) => {
      const [row] = await tx
        .insert(agents)
        .values({ id: localId, title: 'Materialized', userId })
        .returning({ id: agents.id });
      return row;
    };

    it('creates one local Agent + mapping on first materialize and reuses it on repeat', async () => {
      const { agentId, version } = await seedVersion('mat-first');

      const first = await repository.materializeLocalAgent({
        createLocalAgent: createLocalAgentFor(USER_A, 'm10-local-a'),
        platformAgentId: agentId,
        platformAgentVersionChecksum: version.checksum,
        platformAgentVersionId: version.id,
        userId: USER_A,
      });
      expect(first).toEqual({ agentId: 'm10-local-a', created: true, ok: true });

      // Repeat reuses the same local Agent and never runs the (throwing) creator again.
      const repeat = await repository.materializeLocalAgent({
        createLocalAgent: async () => {
          throw new Error('must not create a second Agent');
        },
        platformAgentId: agentId,
        platformAgentVersionChecksum: version.checksum,
        platformAgentVersionId: version.id,
        userId: USER_A,
      });
      expect(repeat).toEqual({ agentId: 'm10-local-a', created: false, ok: true });

      expect(await repository.listMaterializedAgentIds(USER_A)).toEqual(new Set(['m10-local-a']));
      const row = await repository.getMaterialization(USER_A, agentId);
      expect(row).toMatchObject({
        materializedAgentId: 'm10-local-a',
        platformAgentVersionChecksum: version.checksum,
        platformAgentVersionId: version.id,
        status: 'materialized',
      });
    });

    it('leaves exactly one mapping + one Agent under N concurrent materializations (no orphan)', async () => {
      const { agentId, version } = await seedVersion('mat-concurrent');

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          repository.materializeLocalAgent({
            createLocalAgent: createLocalAgentFor(USER_A, `m10-conc-${index}`),
            platformAgentId: agentId,
            platformAgentVersionChecksum: version.checksum,
            platformAgentVersionId: version.id,
            userId: USER_A,
          }),
        ),
      );

      const winners = new Set(results.map((r) => (r.ok ? r.agentId : 'none')));
      expect(winners.size).toBe(1);
      const [winner] = [...winners];
      // Only the winner's local Agent survived; every rolled-back candidate left no orphan row.
      const survivors = await serverDB
        .select({ id: agents.id })
        .from(agents)
        .where(
          inArray(agents.id, [
            'm10-conc-0',
            'm10-conc-1',
            'm10-conc-2',
            'm10-conc-3',
            'm10-conc-4',
          ]),
        );
      expect(survivors).toEqual([{ id: winner }]);
      expect(await repository.listMaterializedAgentIds(USER_A)).toEqual(new Set([winner]));
    });

    it('rejects materializing an archived Agent without creating an orphan local Agent', async () => {
      const { agentId, version } = await seedVersion('mat-archived');
      await serverDB
        .update(platformAgents)
        .set({ status: 'archived' })
        .where(eq(platformAgents.id, agentId));

      const result = await repository.materializeLocalAgent({
        createLocalAgent: createLocalAgentFor(USER_A, 'm10-archived-local'),
        platformAgentId: agentId,
        platformAgentVersionChecksum: version.checksum,
        platformAgentVersionId: version.id,
        userId: USER_A,
      });
      expect(result).toEqual({ ok: false, reason: 'archived' });

      const orphan = await serverDB
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, 'm10-archived-local'));
      expect(orphan).toEqual([]);
      expect(await repository.listMaterializedAgentIds(USER_A)).toEqual(new Set());
    });

    it('is owner-scoped: each user gets an isolated mapping, never the other user’s', async () => {
      const { agentId, version } = await seedVersion('mat-owner');

      await repository.materializeLocalAgent({
        createLocalAgent: createLocalAgentFor(USER_A, 'm10-owner-a'),
        platformAgentId: agentId,
        platformAgentVersionChecksum: version.checksum,
        platformAgentVersionId: version.id,
        userId: USER_A,
      });
      await repository.materializeLocalAgent({
        createLocalAgent: createLocalAgentFor(USER_B, 'm10-owner-b'),
        platformAgentId: agentId,
        platformAgentVersionChecksum: version.checksum,
        platformAgentVersionId: version.id,
        userId: USER_B,
      });

      expect(await repository.listMaterializedAgentIds(USER_A)).toEqual(new Set(['m10-owner-a']));
      expect(await repository.listMaterializedAgentIds(USER_B)).toEqual(new Set(['m10-owner-b']));
    });
  });
});
