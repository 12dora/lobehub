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
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import { createUnmanagedResourcePolicyMap } from '@/database/models/platform';
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

import { PlatformAgentEffectiveResolver } from './effectiveResolver';
import { PlatformAgentNotFoundError } from './errors';

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

  // Real repository + injected managed policy, so the tests exercise the real resolver SQL
  // without seeding the managed-policy tables.
  const resolver = () =>
    new PlatformAgentEffectiveResolver(db, {
      flags,
      policyModel: { getSnapshot: async () => managedPolicy() },
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

  // R2: operation snapshot pins the exact version even across a real publish of v2.
  describe('operation snapshot (R2)', () => {
    it('keeps an in-flight operation on v1 while a new operation sees the published v2', async () => {
      await db.insert(users).values({ id: 'op-user' });
      await seedPublishedAgent('op-agent');
      await assign('op-agent', { targetId: '__global__', targetType: 'global' });

      const operationA = await resolver().resolveOperationSnapshot('op-user', 'op-agent');
      expect(operationA?.versionId).toBe('op-agent-v1');

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

      const operationB = await resolver().resolveOperationSnapshot('op-user', 'op-agent');
      expect(operationB?.versionId).toBe('op-agent-v2');
      expect(operationB?.config.displayName).toBe('op-agent-v2');
      // The already-captured operation A is a pinned, immutable value — still v1.
      expect(operationA?.versionId).toBe('op-agent-v1');
      expect(operationA?.config.displayName).toBe('op-agent');
      expect(Object.isFrozen(operationA)).toBe(true);
    });
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
      // Dirty "workspace role as global_role target" state is unreachable: the assignment
      // target trigger requires workspace_id IS NULL, so it can never be created.
      await seedPublishedAgent('wsrole-agent');
      await expect(
        assign('wsrole-agent', { targetId: 'role-ws', targetType: 'global_role' }),
      ).rejects.toThrow();
    });
  });
});
