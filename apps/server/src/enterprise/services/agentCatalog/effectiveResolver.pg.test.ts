/**
 * Effective Resolver R1 / R2 / R3 regression against a real PostgreSQL instance.
 *
 * Runs only when `TEST_SERVER_DB=1` (and DATABASE_TEST_URL is set); otherwise skipped.
 * The server-authoritative role/scope/expiry filtering (R3) and owner-scoped hidden isolation
 * (R1) are SQL behaviors that a mock cannot prove — they need real Postgres with the full
 * migration chain (constraints + triggers) that `getTestDB()` applies to DATABASE_TEST_URL.
 *
 * @vitest-environment node
 */
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import { createUnmanagedResourcePolicyMap } from '@/database/models/platform';
import {
  acquirePlatformAgentReferenceLock,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import * as schema from '@/database/schemas';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { roles, userRoles } from '@/database/schemas/rbac';
import { users } from '@/database/schemas/user';
import { workspaces } from '@/database/schemas/workspace';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformAgentAdminService } from './adminService';
import { PlatformAgentEffectiveResolver } from './effectiveResolver';
import { PlatformAgentNotFoundError, PlatformAgentResourceInUseError } from './errors';
import { platformAgentDraftToken } from './publication';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;

const CHECKSUM = 'a'.repeat(64);
const flags = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };

const config = (displayName: string) => ({
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName,
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'help',
  tags: [],
});

const dependencySnapshot = {
  connectors: [],
  model: {
    modelKey: 'chat',
    providerChecksum: 'b'.repeat(64),
    providerKey: 'provider',
    providerRevision: 1,
  },
  skills: [],
};

const managedPolicy = () => {
  const published = createUnmanagedResourcePolicyMap();
  published.agents = { enforcementMode: 'enforced' as const, managed: true };
  return {
    draft: createUnmanagedResourcePolicyMap(),
    published,
    revision: 1,
    status: 'published' as const,
  };
};

run('PlatformAgentEffectiveResolver (PostgreSQL) — R1 / R2 / R3', () => {
  let db: LobeChatDatabase;
  const connectionString = process.env.DATABASE_TEST_URL!;

  // Real repository + injected managed policy, so the tests exercise the real resolver SQL
  // without seeding the managed-policy tables.
  const resolverOn = (target: LobeChatDatabase) =>
    new PlatformAgentEffectiveResolver(target, {
      flags,
      policyModel: { getSnapshot: async () => managedPolicy() },
    });
  const resolver = () => resolverOn(db);

  const materializationRow = async (userId: string, platformAgentId: string) => {
    const [materialized] = await db
      .select()
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, userId),
          eq(platformUserAgentMaterializations.platformAgentId, platformAgentId),
        ),
      );
    return materialized;
  };

  const clearAssignments = (agentId: string) =>
    db.delete(platformAgentAssignments).where(eq(platformAgentAssignments.agentId, agentId));

  const archiveAgent = async (agentId: string) => {
    const [current] = await db.select().from(platformAgents).where(eq(platformAgents.id, agentId));
    return new PlatformAgentAdminService(db).archive('admin', {
      agentId: current.id,
      expectedDraftToken: platformAgentDraftToken(current),
      expectedRevision: current.revision,
      reason: 'archive',
      replacementAgentId: null,
    });
  };

  // A real materialization stamps last_synced_at, making the row a genuine archive reference.
  const realMaterialize = (userId: string, agentId: string) =>
    new PlatformAgentCatalogRepository(db).upsertMaterialization({
      platformAgentId: agentId,
      platformAgentVersionChecksum: CHECKSUM,
      platformAgentVersionId: `${agentId}-v1`,
      userId,
    });

  const seedPublishedAgent = async (id: string) => {
    await db.insert(platformAgents).values({
      agentKey: id,
      id,
      migrationRequired: false,
      status: 'draft',
      title: id,
    });
    await db.insert(platformAgentVersions).values({
      agentId: id,
      checksum: CHECKSUM,
      config: config(id),
      dependencySnapshot,
      id: `${id}-v1`,
      version: '1.0.0',
    });
    await db
      .update(platformAgents)
      .set({
        currentVersionId: `${id}-v1`,
        publishedAt: new Date(),
        revision: 1,
        status: 'published',
      })
      .where(eq(platformAgents.id, id));
    return `${id}-v1`;
  };

  const assign = async (
    agentId: string,
    target: { targetId: string; targetType: 'global' | 'global_role' | 'user' },
  ) => {
    await db.insert(platformAgentAssignments).values({
      agentId,
      enabled: true,
      id: `${agentId}-${target.targetType}-${target.targetId}`,
      mode: 'optional',
      status: 'active',
      targetId: target.targetId,
      targetType: target.targetType,
      versionPolicy: 'latest_published',
    });
  };

  const cleanup = async () => {
    await db.execute(sql`
      TRUNCATE TABLE
        platform_user_agent_materializations,
        platform_agent_assignments,
        platform_agent_versions,
        platform_agents,
        rbac_user_roles,
        rbac_roles,
        workspaces,
        users
      RESTART IDENTITY CASCADE
    `);
  };

  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(cleanup);
  afterAll(cleanup);

  // R1: owner-scoped hidden — A/B isolation, three distributions, adversarial owner.
  describe('owner-scoped hidden (R1)', () => {
    it('hides default/optional for the owner only, never mandatory, and isolates other users', async () => {
      await db.insert(users).values([{ id: 'user-a' }, { id: 'user-b' }]);
      await seedPublishedAgent('mand');
      await seedPublishedAgent('def');
      await seedPublishedAgent('opt');
      // Distribution is carried by the assignment mode.
      await db.insert(platformAgentAssignments).values([
        {
          agentId: 'mand',
          enabled: true,
          id: 'a-mand',
          mode: 'mandatory',
          status: 'active',
          targetId: '__global__',
          targetType: 'global',
          versionPolicy: 'latest_published',
        },
        {
          agentId: 'def',
          enabled: true,
          id: 'a-def',
          mode: 'default',
          status: 'active',
          targetId: '__global__',
          targetType: 'global',
          versionPolicy: 'latest_published',
        },
        {
          agentId: 'opt',
          enabled: true,
          id: 'a-opt',
          mode: 'optional',
          status: 'active',
          targetId: '__global__',
          targetType: 'global',
          versionPolicy: 'latest_published',
        },
      ]);

      const ids = async (userId: string) =>
        (await resolver().getEffectiveList(userId)).agents.map((a) => a.platformAgentId).sort();

      expect(await ids('user-a')).toEqual(['def', 'mand', 'opt']);

      // user-a hides all three; only the mandatory one survives for A.
      await resolver().setAgentHidden('user-a', 'mand', true);
      await resolver().setAgentHidden('user-a', 'def', true);
      await resolver().setAgentHidden('user-a', 'opt', true);
      expect(await ids('user-a')).toEqual(['mand']);

      // user-b is unaffected — hidden is strictly owner-scoped.
      expect(await ids('user-b')).toEqual(['def', 'mand', 'opt']);

      // Un-hide restores visibility for the owner.
      await resolver().setAgentHidden('user-a', 'def', false);
      expect(await ids('user-a')).toEqual(['def', 'mand']);
    });

    it('rejects hiding an Agent the user is not entitled to (no forged scope)', async () => {
      await db.insert(users).values({ id: 'user-a' });
      await seedPublishedAgent('unassigned');
      // No assignment → not authorized for user-a.
      await expect(resolver().setAgentHidden('user-a', 'unassigned', true)).rejects.toBeInstanceOf(
        PlatformAgentNotFoundError,
      );
      const [rowCount] = await db.select().from(platformUserAgentMaterializations);
      expect(rowCount).toBeUndefined(); // nothing written
    });
  });

  // R2: an operation handle pins the exact version even across a real publish of v2.
  describe('operation handle (R2)', () => {
    it('keeps an in-flight handle on v1 while a new handle sees the published v2', async () => {
      await db.insert(users).values({ id: 'op-user' });
      await seedPublishedAgent('op-agent');
      await assign('op-agent', { targetId: '__global__', targetType: 'global' });

      const operationA = await resolver().beginOperation('op-user', 'op-agent');
      expect(operationA!.getSnapshot().versionId).toBe('op-agent-v1');

      // Publish v2: append an immutable version and move the current pointer.
      await db.insert(platformAgentVersions).values({
        agentId: 'op-agent',
        checksum: CHECKSUM,
        config: config('op-agent-v2'),
        dependencySnapshot,
        id: 'op-agent-v2',
        version: '2.0.0',
      });
      await db
        .update(platformAgents)
        .set({ currentVersionId: 'op-agent-v2', publishedAt: new Date(), revision: 2 })
        .where(eq(platformAgents.id, 'op-agent'));

      const operationB = await resolver().beginOperation('op-user', 'op-agent');
      expect(operationB!.getSnapshot().versionId).toBe('op-agent-v2');
      expect(operationB!.getSnapshot().config.displayName).toBe('op-agent-v2');
      // Handle A replays its pinned capture no matter how often it is read — still v1.
      expect(operationA!.getSnapshot().versionId).toBe('op-agent-v1');
      expect(operationA!.getSnapshot().versionId).toBe('op-agent-v1');
      expect(operationA!.getSnapshot().config.displayName).toBe('op-agent');
      expect(Object.isFrozen(operationA!.getSnapshot())).toBe(true);
    });
  });

  // R1-01: a hidden preference must never permanently block archive.
  describe('visibility-only rows do not block archive (R1-01)', () => {
    const seedGlobalAgent = async (agentId: string, mode: 'default' | 'mandatory' | 'optional') => {
      await seedPublishedAgent(agentId);
      await db.insert(platformAgentAssignments).values({
        agentId,
        enabled: true,
        id: `${agentId}-a`,
        mode,
        status: 'active',
        targetId: '__global__',
        targetType: 'global',
        versionPolicy: 'latest_published',
      });
    };

    beforeEach(async () => {
      await db.insert(users).values({ id: 'vis-user' });
    });

    it('archives after a hide→unhide cycle leaves no residual row', async () => {
      await seedGlobalAgent('vis-a', 'optional');
      await resolver().setAgentHidden('vis-user', 'vis-a', true);
      await resolver().setAgentHidden('vis-user', 'vis-a', false);
      // Unhiding a visibility-only row deletes it — no archive blocker remains.
      expect(await materializationRow('vis-user', 'vis-a')).toBeUndefined();

      await clearAssignments('vis-a');
      await archiveAgent('vis-a');
      expect(
        (await db.select().from(platformAgents).where(eq(platformAgents.id, 'vis-a')))[0].status,
      ).toBe('archived');
    });

    it('archives while a hidden visibility-only row still exists', async () => {
      await seedGlobalAgent('vis-b', 'optional');
      await resolver().setAgentHidden('vis-user', 'vis-b', true);
      // Invariant: a hidden preference row carries no materialization state.
      const rowB = await materializationRow('vis-user', 'vis-b');
      expect(rowB.hidden).toBe(true);
      expect(rowB.materializedAgentId).toBeNull();
      expect(rowB.lastSyncedAt).toBeNull();

      await clearAssignments('vis-b');
      await archiveAgent('vis-b'); // visibility-only row is ignored by countAgentReferences
      expect(
        (await db.select().from(platformAgents).where(eq(platformAgents.id, 'vis-b')))[0].status,
      ).toBe('archived');
    });

    it('archives after hiding a mandatory Agent (no invalid blocker)', async () => {
      await seedGlobalAgent('vis-m', 'mandatory');
      await resolver().setAgentHidden('vis-user', 'vis-m', true);
      await clearAssignments('vis-m');
      await archiveAgent('vis-m');
      expect(
        (await db.select().from(platformAgents).where(eq(platformAgents.id, 'vis-m')))[0].status,
      ).toBe('archived');
    });

    it('still blocks archive for a real (synced) materialization — ADM-02 preserved', async () => {
      await seedGlobalAgent('vis-real', 'optional');
      await realMaterialize('vis-user', 'vis-real');
      await clearAssignments('vis-real');
      await expect(archiveAgent('vis-real')).rejects.toBeInstanceOf(
        PlatformAgentResourceInUseError,
      );
    });

    it('materializing AFTER hide upgrades the visibility-only row and still blocks archive', async () => {
      await seedGlobalAgent('vis-upgrade', 'optional');
      // hide first → visibility-only row (last_synced_at NULL).
      await resolver().setAgentHidden('vis-user', 'vis-upgrade', true);
      expect((await materializationRow('vis-user', 'vis-upgrade')).lastSyncedAt).toBeNull();

      // then a real materialization at the same version must upgrade the row, not bypass it.
      await realMaterialize('vis-user', 'vis-upgrade');
      const upgraded = await materializationRow('vis-user', 'vis-upgrade');
      expect(upgraded.lastSyncedAt).not.toBeNull();
      expect(upgraded.hidden).toBe(true);
      expect(upgraded.platformAgentVersionId).toBe('vis-upgrade-v1');
      expect(upgraded.status).toBe('pending');

      // archive must now see a real materialization reference and refuse (fails pre-fix).
      await clearAssignments('vis-upgrade');
      await expect(archiveAgent('vis-upgrade')).rejects.toBeInstanceOf(
        PlatformAgentResourceInUseError,
      );
      expect(
        (await db.select().from(platformAgents).where(eq(platformAgents.id, 'vis-upgrade')))[0]
          .status,
      ).toBe('published');
    });

    it('keeps blocking archive when a real materialization is also hidden', async () => {
      await seedGlobalAgent('vis-realhidden', 'optional');
      await realMaterialize('vis-user', 'vis-realhidden');
      await resolver().setAgentHidden('vis-user', 'vis-realhidden', true);
      // The hidden flag flips but the real materialization state (last_synced_at) is preserved.
      const row = await materializationRow('vis-user', 'vis-realhidden');
      expect(row.hidden).toBe(true);
      expect(row.lastSyncedAt).not.toBeNull();
      await clearAssignments('vis-realhidden');
      await expect(archiveAgent('vis-realhidden')).rejects.toBeInstanceOf(
        PlatformAgentResourceInUseError,
      );
    });
  });

  // R1-02: a lost archive race must reject the hidden write, not silently succeed.
  describe('archive race on hidden write (R1-02)', () => {
    it('rejects setAgentHidden with a stable NotFound and writes no row when archive wins', async () => {
      await db.insert(users).values({ id: 'race-user' });
      await seedPublishedAgent('race-agent');
      await assign('race-agent', { targetId: '__global__', targetType: 'global' });

      const archiverPool = new Pool({ connectionString, max: 1 });
      const writerPool = new Pool({ connectionString, max: 1 });
      const archiverDb = drizzle(archiverPool, { schema }) as unknown as LobeChatDatabase;
      const writerResolver = resolverOn(
        drizzle(writerPool, { schema }) as unknown as LobeChatDatabase,
      );
      let releaseArchiver!: () => void;
      const release = new Promise<void>((settle) => {
        releaseArchiver = settle;
      });
      let holding!: () => void;
      const held = new Promise<void>((settle) => {
        holding = settle;
      });
      try {
        // Archiver holds the SAME per-Agent reference lock, archives the row, then waits.
        const archiverTx = archiverDb.transaction(async (tx) => {
          await acquirePlatformAgentReferenceLock(tx, 'race-agent');
          await tx
            .update(platformAgents)
            .set({ isDefault: false, status: 'archived', systemKey: null })
            .where(eq(platformAgents.id, 'race-agent'));
          holding();
          await release;
        });
        await held;

        // Writer resolves authorization (still published via MVCC), then blocks on the lock.
        let writerSettled = false;
        const writerResult = writerResolver
          .setAgentHidden('race-user', 'race-agent', true)
          .then(
            () => ({ ok: true }) as const,
            (error: unknown) => ({ error }) as const,
          )
          .then((outcome) => {
            writerSettled = true;
            return outcome;
          });

        await new Promise((settle) => setTimeout(settle, 300));
        expect(writerSettled).toBe(false); // queued behind the archiver's shared lock

        releaseArchiver();
        await archiverTx;
        const outcome = await writerResult;

        expect('error' in outcome && outcome.error).toBeInstanceOf(PlatformAgentNotFoundError);
        expect(await materializationRow('race-user', 'race-agent')).toBeUndefined();
      } finally {
        await Promise.all([archiverPool.end(), writerPool.end()]);
      }
    }, 20_000);
  });

  // R3: server-authoritative role scope / expiry / workspace filtering (real Postgres).
  describe('global_role authorization filtering (R3)', () => {
    const seedRoleAgent = async (agentId: string) => {
      await seedPublishedAgent(agentId);
      await assign(agentId, { targetId: 'role-global', targetType: 'global_role' });
    };

    beforeEach(async () => {
      await db.insert(users).values({ id: 'role-user' });
      await db.insert(workspaces).values({
        id: 'ws-1',
        name: 'WS',
        primaryOwnerId: 'role-user',
        slug: 'ws-1',
      });
      await db.insert(roles).values([
        { displayName: 'Global', id: 'role-global', isActive: true, name: 'role-global' },
        { displayName: 'Inactive', id: 'role-inactive', isActive: false, name: 'role-inactive' },
        {
          displayName: 'WsRole',
          id: 'role-ws',
          isActive: true,
          name: 'role-ws',
          workspaceId: 'ws-1',
        },
      ]);
    });

    const visibleTo = async (userId: string) =>
      (await resolver().getEffectiveList(userId)).agents.map((a) => a.platformAgentId);

    it('matches an active, unexpired, non-workspace global role grant', async () => {
      await seedRoleAgent('role-agent');
      await db
        .insert(userRoles)
        .values({ roleId: 'role-global', userId: 'role-user', workspaceId: null });
      expect(await visibleTo('role-user')).toContain('role-agent');
    });

    it('does not match an expired global role grant', async () => {
      await seedRoleAgent('role-agent');
      await db.insert(userRoles).values({
        expiresAt: new Date(Date.now() - 3_600_000),
        roleId: 'role-global',
        userId: 'role-user',
        workspaceId: null,
      });
      expect(await visibleTo('role-user')).not.toContain('role-agent');
    });

    it('does not match a workspace-scoped role grant (workspaceId IS NULL required)', async () => {
      await seedRoleAgent('role-agent');
      await db.insert(userRoles).values({
        roleId: 'role-global',
        userId: 'role-user',
        workspaceId: 'ws-1',
      });
      expect(await visibleTo('role-user')).not.toContain('role-agent');
    });

    it('excludes an inactive-role grant (resolver isActive filter)', async () => {
      // The target trigger allows assigning a global (workspace-null) role even when inactive;
      // the resolver's server-side isActive filter is the authoritative exclusion.
      await seedPublishedAgent('inactive-agent');
      await assign('inactive-agent', { targetId: 'role-inactive', targetType: 'global_role' });
      await db
        .insert(userRoles)
        .values({ roleId: 'role-inactive', userId: 'role-user', workspaceId: null });
      expect(await visibleTo('role-user')).not.toContain('inactive-agent');
    });

    it('rejects a workspace-scoped role as an assignment target (write-layer defense)', async () => {
      // Dirty "workspace role as global_role target" state is unreachable via normal writes: the
      // assignment target trigger requires workspace_id IS NULL, so it can never be created.
      await seedPublishedAgent('wsrole-agent');
      await expect(
        assign('wsrole-agent', { targetId: 'role-ws', targetType: 'global_role' }),
      ).rejects.toThrow();
    });

    it('excludes legacy workspace-role-target dirty data injected past the triggers', async () => {
      // Simulate legacy / corrupted rows: temporarily disable triggers with SET LOCAL (auto-reverts
      // at transaction end, so the constraints are always restored) and inject a global_role
      // assignment pointing at a workspace-scoped role plus a workspace-null grant of it. The
      // resolver's server-authoritative isNull(roles.workspaceId) filter must still exclude it.
      await seedPublishedAgent('wsdirty-agent');
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.insert(platformAgentAssignments).values({
          agentId: 'wsdirty-agent',
          enabled: true,
          id: 'wsdirty-a',
          mode: 'optional',
          status: 'active',
          targetId: 'role-ws',
          targetType: 'global_role',
          versionPolicy: 'latest_published',
        });
        await tx
          .insert(userRoles)
          .values({ roleId: 'role-ws', userId: 'role-user', workspaceId: null });
      });

      // The injected dirty rows persist but must not grant visibility (resolver filter).
      expect(await visibleTo('role-user')).not.toContain('wsdirty-agent');
      // Triggers are restored (SET LOCAL reverted at commit): a normal workspace-role-target
      // assignment is rejected again.
      await seedPublishedAgent('wsdirty-check');
      await expect(
        assign('wsdirty-check', { targetId: 'role-ws', targetType: 'global_role' }),
      ).rejects.toThrow();
    });
  });
});
