/**
 * ADM-04 / ADM-05 regression against a real PostgreSQL instance.
 *
 * Runs only when `TEST_SERVER_DB=1` (and DATABASE_TEST_URL is set); otherwise skipped.
 * PGlite / mocks cannot prove row-lock serialization, the default-inbox singleton race,
 * exact SQL aggregate counts, or a constant query count under a growing page — these need
 * a genuine multi-connection Postgres. `getTestDB()` applies the full migration chain
 * (constraints + triggers) to DATABASE_TEST_URL, which every case below relies on.
 *
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import * as schema from '@/database/schemas';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { roles, userRoles } from '@/database/schemas/rbac';
import { users } from '@/database/schemas/user';
import { workspaces } from '@/database/schemas/workspace';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformAgentAdminService } from './adminService';
import {
  PlatformAgentDefaultRequiredError,
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  PlatformAgentResourceInUseError,
  PlatformAgentRevisionConflictError,
} from './errors';
import { translatePlatformAgentPgError } from './pgErrors';
import { platformAgentDraftToken } from './publication';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;

const CHECKSUM = 'a'.repeat(64);

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

run('PlatformAgentAdminService (PostgreSQL) — ADM-04 / ADM-05', () => {
  let db: LobeChatDatabase;
  const connectionString = process.env.DATABASE_TEST_URL!;

  const seedDraftAgent = async (id: string, agentKey: string) => {
    await db.insert(platformAgents).values({
      agentKey,
      id,
      migrationRequired: false,
      status: 'draft',
      title: agentKey,
    });
  };

  /** Seed a fully published Agent (identity + immutable version + published pointer). */
  const seedPublishedAgent = async (id: string, agentKey: string) => {
    const versionId = `${id}-v1`;
    await seedDraftAgent(id, agentKey);
    await db.insert(platformAgentVersions).values({
      agentId: id,
      checksum: CHECKSUM,
      config: config(agentKey),
      dependencySnapshot,
      id: versionId,
      version: '1.0.0',
    });
    await db
      .update(platformAgents)
      .set({
        currentVersionId: versionId,
        publishedAt: new Date(),
        revision: 1,
        status: 'published',
      })
      .where(eq(platformAgents.id, id));
    return versionId;
  };

  const currentIdentity = async (id: string) => {
    const [row] = await db.select().from(platformAgents).where(eq(platformAgents.id, id));
    return row;
  };

  const pointerFor = async (id: string) => {
    const row = await currentIdentity(id);
    return {
      agentId: row.id,
      expectedDraftToken: platformAgentDraftToken(row),
      expectedRevision: row.revision,
    };
  };

  const cleanup = async () => {
    await db.execute(sql`
      TRUNCATE TABLE
        platform_user_agent_materializations,
        platform_agent_assignments,
        platform_agent_versions,
        platform_agents,
        platform_audit_logs,
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

  // ADM-05: keyset pagination first/middle/last page and the >100 clamp.
  describe('list pagination', () => {
    it('walks first/middle/last pages and clamps a >100 page', async () => {
      const total = 120;
      await db.insert(users).values([{ id: 'pg-owner' }]);
      await db.insert(platformAgents).values(
        Array.from({ length: total }, (_, index) => ({
          agentKey: `agent-${String(index).padStart(3, '0')}`,
          id: `page-${String(index).padStart(3, '0')}`,
          migrationRequired: false,
          status: 'draft' as const,
          title: `agent-${index}`,
        })),
      );
      const service = new PlatformAgentAdminService(db);

      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await service.list({ cursor, limit: 50 });
        pages += 1;
        for (const item of page.items) seen.add(item.identity.agentKey);
        cursor = page.nextCursor ?? undefined;
        expect(page.items.length).toBeLessThanOrEqual(50);
      } while (cursor);

      expect(pages).toBe(3); // 50 + 50 + 20
      expect(seen.size).toBe(total);

      // Repository clamps an over-limit page to 100 and still yields a cursor.
      const clamped = await service.list({ limit: 200 });
      expect(clamped.items).toHaveLength(100);
      expect(clamped.nextCursor).not.toBeNull();
    });
  });

  // ADM-05: exact SQL aggregate counts across every assignment target type.
  describe('assignment target counts', () => {
    it('counts global as all users, user as an exact match, and skips expired / workspace / inactive role grants', async () => {
      await db.insert(users).values(['u1', 'u2', 'u3', 'u4', 'owner'].map((id) => ({ id })));
      await db.insert(workspaces).values({
        id: 'ws-1',
        name: 'WS',
        primaryOwnerId: 'owner',
        slug: 'ws-1',
      });
      await db.insert(roles).values([
        { displayName: 'Global', id: 'role-global', isActive: true, name: 'global-role' },
        { displayName: 'Inactive', id: 'role-inactive', isActive: false, name: 'inactive-role' },
      ]);
      const past = new Date(Date.now() - 3_600_000);
      const future = new Date(Date.now() + 3_600_000);
      await db.insert(userRoles).values([
        { roleId: 'role-global', userId: 'u1', workspaceId: null }, // counted
        { expiresAt: past, roleId: 'role-global', userId: 'u2', workspaceId: null }, // expired
        { roleId: 'role-global', userId: 'u3', workspaceId: 'ws-1' }, // workspace-scoped grant
        { expiresAt: future, roleId: 'role-global', userId: 'u4', workspaceId: null }, // counted
        { roleId: 'role-inactive', userId: 'u1', workspaceId: null }, // inactive role
      ]);

      const service = new PlatformAgentAdminService(db);
      // previewAssignment resolves the identity first, so seed a real published Agent.
      await seedPublishedAgent('count-agent', 'count-agent');
      const withAgent = (targetType: 'global' | 'global_role' | 'user', targetId: string) =>
        service.previewAssignment({
          agentId: 'count-agent',
          assignment: {
            enabled: true,
            mode: 'optional',
            pinnedVersionId: null,
            targetId,
            targetType,
            versionPolicy: 'latest_published',
          },
        });

      const [totalUsers] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
      expect((await withAgent('global', '__global__')).estimatedUsers).toBe(totalUsers.count);
      expect((await withAgent('user', 'u1')).estimatedUsers).toBe(1);
      expect((await withAgent('user', 'ghost')).estimatedUsers).toBe(0);
      expect((await withAgent('global_role', 'role-global')).estimatedUsers).toBe(2);
      expect((await withAgent('global_role', 'role-inactive')).estimatedUsers).toBe(0);
    });
  });

  // ADM-01 + ADM-05: the singleton lock serializes concurrent first (bootstrap) promotions.
  describe('default-inbox singleton concurrency', () => {
    it('lets exactly one of two concurrent first promotions win', async () => {
      await seedPublishedAgent('def-a', 'def-a');
      await seedPublishedAgent('def-b', 'def-b');

      const firstPool = new Pool({ connectionString, max: 1 });
      const secondPool = new Pool({ connectionString, max: 1 });
      const firstDb = drizzle(firstPool, { schema }) as unknown as LobeChatDatabase;
      const secondDb = drizzle(secondPool, { schema }) as unknown as LobeChatDatabase;
      try {
        const promote = (
          target: LobeChatDatabase,
          id: string,
          pointer: Awaited<ReturnType<typeof pointerFor>>,
        ) =>
          new PlatformAgentAdminService(target).setDefaultInbox('admin', {
            currentDefault: null,
            nextDefault: pointer,
            reason: 'concurrent first default',
          });

        const results = await Promise.allSettled([
          promote(firstDb, 'def-a', await pointerFor('def-a')),
          promote(secondDb, 'def-b', await pointerFor('def-b')),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(PlatformAgentRevisionConflictError);

        const [defaults] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(platformAgents)
          .where(eq(platformAgents.isDefault, true));
        expect(defaults.count).toBe(1);
      } finally {
        await Promise.all([firstPool.end(), secondPool.end()]);
      }
    }, 20_000);
  });

  // ADM-05: a held `FOR UPDATE` on the default row blocks the next reader until commit.
  describe('default row FOR UPDATE blocking', () => {
    it('blocks a second default lookup until the first transaction commits', async () => {
      await seedPublishedAgent('lock-a', 'lock-a');
      await db
        .update(platformAgents)
        .set({ isDefault: true, systemKey: 'default-inbox' })
        .where(eq(platformAgents.id, 'lock-a'));

      const holderPool = new Pool({ connectionString, max: 1 });
      const waiterPool = new Pool({ connectionString, max: 1 });
      const holder = await holderPool.connect();
      const waiter = await waiterPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM platform_agents WHERE is_default = true FOR UPDATE`);

        let waiterDone = false;
        await waiter.query('BEGIN');
        const waiterSelect = waiter
          .query(`SELECT id FROM platform_agents WHERE is_default = true FOR UPDATE`)
          .then(() => {
            waiterDone = true;
          });

        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(waiterDone).toBe(false); // still blocked behind the holder

        await holder.query('COMMIT');
        await waiterSelect;
        expect(waiterDone).toBe(true);
        await waiter.query('COMMIT');
      } finally {
        holder.release();
        waiter.release();
        await Promise.all([holderPool.end(), waiterPool.end()]);
      }
    }, 20_000);
  });

  // ADM-05: archive optimistic CAS on the identity revision.
  describe('archive CAS', () => {
    it('advances the revision once and rejects a stale pointer', async () => {
      const { PlatformAgentCatalogRepository } =
        await import('@/database/repositories/platformAgentCatalog');
      await seedPublishedAgent('cas-a', 'cas-a');
      const before = await currentIdentity('cas-a');
      const repository = new PlatformAgentCatalogRepository(db);

      const archived = await repository.archiveIdentityCas({
        expectedDraftSequence: before.draftSequence,
        expectedRevision: before.revision,
        id: before.id,
        updatedBy: 'admin',
      });
      expect(archived?.status).toBe('archived');
      expect(archived?.revision).toBe(before.revision + 1);

      const stale = await repository.archiveIdentityCas({
        expectedDraftSequence: before.draftSequence,
        expectedRevision: before.revision,
        id: before.id,
        updatedBy: 'admin',
      });
      expect(stale).toBeUndefined();
    });
  });

  // ADM-02 + ADM-05: service archive rejects referenced Agents and writes a redacted failure audit.
  describe('archive reference protection + audit', () => {
    it('rejects archive with a live assignment and records a stable failure audit', async () => {
      await db.insert(users).values({ id: 'assignee' });
      await seedPublishedAgent('ref-a', 'ref-a');
      await db.insert(platformAgentAssignments).values({
        agentId: 'ref-a',
        enabled: true,
        id: 'assign-1',
        mode: 'optional',
        status: 'active',
        targetId: 'assignee',
        targetType: 'user',
        versionPolicy: 'latest_published',
      });

      const service = new PlatformAgentAdminService(db);
      await expect(
        service.archive('admin', {
          ...(await pointerFor('ref-a')),
          reason: 'archive referenced',
          replacementAgentId: null,
        }),
      ).rejects.toBeInstanceOf(PlatformAgentResourceInUseError);

      // The Agent is untouched (rollback) and still published.
      expect((await currentIdentity('ref-a')).status).toBe('published');
      const audits = await db
        .select()
        .from(platformAuditLogs)
        .where(eq(platformAuditLogs.action, 'admin.agents.archive'));
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('failure');
      expect(audits[0].afterDiff).toEqual({ error: 'resource_in_use' });
      // No target / reference identifier leaks into the audit payload.
      expect(JSON.stringify(audits[0].afterDiff)).not.toMatch(/assign|ref-a/);
    });

    it('requires a replacement to archive the current default', async () => {
      await seedPublishedAgent('def-only', 'def-only');
      await db
        .update(platformAgents)
        .set({ isDefault: true, systemKey: 'default-inbox' })
        .where(eq(platformAgents.id, 'def-only'));

      const service = new PlatformAgentAdminService(db);
      await expect(
        service.archive('admin', {
          ...(await pointerFor('def-only')),
          reason: 'drop the only default',
          replacementAgentId: null,
        }),
      ).rejects.toBeInstanceOf(PlatformAgentDefaultRequiredError);
    });
  });

  // ADM-05: service removeAssignment happy path + success audit + Agent CAS bump.
  describe('removeAssignment', () => {
    it('removes an assignment, bumps the Agent draft, and audits success', async () => {
      await db.insert(users).values({ id: 'assignee-2' });
      await seedPublishedAgent('rm-a', 'rm-a');
      await db.insert(platformAgentAssignments).values({
        agentId: 'rm-a',
        enabled: true,
        id: 'assign-rm',
        mode: 'optional',
        status: 'active',
        targetId: 'assignee-2',
        targetType: 'user',
        versionPolicy: 'latest_published',
      });
      const before = await currentIdentity('rm-a');

      const service = new PlatformAgentAdminService(db);
      await expect(
        service.removeAssignment('admin', {
          agentId: 'rm-a',
          assignmentId: 'assign-rm',
          expectedDraftToken: platformAgentDraftToken(before),
          expectedRevision: before.revision,
          reason: 'remove assignment',
        }),
      ).resolves.toEqual({ removed: true });

      const remaining = await db
        .select()
        .from(platformAgentAssignments)
        .where(eq(platformAgentAssignments.agentId, 'rm-a'));
      expect(remaining).toHaveLength(0);
      expect((await currentIdentity('rm-a')).draftSequence).toBe(before.draftSequence + 1);
      const audits = await db
        .select()
        .from(platformAuditLogs)
        .where(eq(platformAuditLogs.action, 'admin.agents.assignments.remove'));
      expect(audits[0]?.result).toBe('success');
    });
  });

  // ADM-04: list and getDependents issue a constant number of queries regardless of page size.
  describe('constant query count (no N+1)', () => {
    const measure = async (
      agentCount: number,
      action: (service: PlatformAgentAdminService) => Promise<unknown>,
    ) => {
      const countingPool = new Pool({ connectionString, max: 4 });
      const original = countingPool.query.bind(countingPool);
      let queries = 0;

      (countingPool as any).query = (...queryArgs: any[]) => {
        queries += 1;
        return (original as any)(...queryArgs);
      };
      const countingDb = drizzle(countingPool, { schema }) as unknown as LobeChatDatabase;
      try {
        await action(new PlatformAgentAdminService(countingDb));
      } finally {
        await countingPool.end();
      }
      return { agentCount, queries };
    };

    it('keeps list query count constant as the page grows', async () => {
      const seedPage = async (n: number) => {
        await cleanup();
        await db.insert(users).values({ id: 'q-user' });
        for (let index = 0; index < n; index += 1) {
          const id = `q-${String(index).padStart(3, '0')}`;
          await seedPublishedAgent(id, id);
          await db.insert(platformAgentAssignments).values({
            agentId: id,
            enabled: true,
            id: `${id}-assign`,
            mode: 'optional',
            status: 'active',
            targetId: 'q-user',
            targetType: 'user',
            versionPolicy: 'latest_published',
          });
        }
      };

      await seedPage(5);
      const small = await measure(5, (service) => service.list({ limit: 100 }));
      await seedPage(60);
      const large = await measure(60, (service) => service.list({ limit: 100 }));

      // 1 identity page + 1 batched versions + 1 batched assignment counts = 3.
      expect(small.queries).toBe(3);
      expect(large.queries).toBe(3);
    }, 30_000);

    it('keeps getDependents query count constant as dependents grow', async () => {
      const seedDependents = async (n: number) => {
        await cleanup();
        await seedPublishedAgent('dep-agent', 'dep-agent');
        await db.insert(users).values(
          Array.from({ length: n }, (_, index) => ({
            id: `dep-user-${String(index).padStart(3, '0')}`,
          })),
        );
        await db.insert(platformAgentAssignments).values(
          Array.from({ length: n }, (_, index) => ({
            agentId: 'dep-agent',
            enabled: true,
            id: `dep-assign-${String(index).padStart(3, '0')}`,
            mode: 'optional' as const,
            status: 'active',
            targetId: `dep-user-${String(index).padStart(3, '0')}`,
            targetType: 'user' as const,
            versionPolicy: 'latest_published' as const,
          })),
        );
      };

      await seedDependents(5);
      const small = await measure(5, (service) =>
        service.getDependents({ agentId: 'dep-agent', limit: 100 }),
      );
      await seedDependents(60);
      const large = await measure(60, (service) =>
        service.getDependents({ agentId: 'dep-agent', limit: 100 }),
      );

      // 1 assignment page + (no overflow) 1 materialization page + 1 batched versions = 2..3, constant.
      expect(small.queries).toBe(large.queries);
      expect(large.queries).toBeLessThanOrEqual(3);
    }, 30_000);
  });

  // ADM-03: real pg/Drizzle cause chains normalize by actual constraint / trigger, no leak.
  describe('constraint / trigger normalization (real cause chain)', () => {
    const rawErrorOf = async (op: () => Promise<unknown>) => {
      try {
        await op();
        throw new Error('expected a database error');
      } catch (error) {
        return error;
      }
    };

    it('normalizes unique / FK / trigger violations to stable redacted errors', async () => {
      await seedDraftAgent('norm-a', 'norm-a');
      await seedPublishedAgent('norm-pub', 'norm-pub');
      await db.insert(users).values({ id: 'norm-user' });
      await db.insert(roles).values({
        displayName: 'R',
        id: 'norm-role',
        isActive: true,
        name: 'norm-role',
      });

      // agent key unique (23505) → InvalidInput
      const dupKey = await rawErrorOf(() =>
        db.insert(platformAgents).values({
          agentKey: 'norm-a',
          id: 'norm-a-dup',
          migrationRequired: false,
          status: 'draft',
          title: 'norm-a',
        }),
      );
      expect(translatePlatformAgentPgError(dupKey)).toBeInstanceOf(PlatformAgentInvalidInputError);

      // system key unique (23505) → RevisionConflict (default-inbox singleton)
      await db.insert(platformAgents).values({
        agentKey: 'sys-1',
        id: 'sys-1',
        isDefault: true,
        migrationRequired: false,
        status: 'draft',
        systemKey: 'default-inbox',
        title: 'sys-1',
      });
      const dupSystem = await rawErrorOf(() =>
        db.insert(platformAgents).values({
          agentKey: 'sys-2',
          id: 'sys-2',
          isDefault: true,
          migrationRequired: false,
          status: 'draft',
          systemKey: 'default-inbox',
          title: 'sys-2',
        }),
      );
      expect(translatePlatformAgentPgError(dupSystem)).toBeInstanceOf(
        PlatformAgentRevisionConflictError,
      );

      // SemVer version unique (23505) → InvalidInput
      await db.insert(platformAgentVersions).values({
        agentId: 'norm-a',
        checksum: CHECKSUM,
        config: config('norm-a'),
        dependencySnapshot,
        id: 'norm-a-ver1',
        version: '1.0.0',
      });
      const dupVersion = await rawErrorOf(() =>
        db.insert(platformAgentVersions).values({
          agentId: 'norm-a',
          checksum: CHECKSUM,
          config: config('norm-a'),
          dependencySnapshot,
          id: 'norm-a-ver2',
          version: '1.0.0',
        }),
      );
      expect(translatePlatformAgentPgError(dupVersion)).toBeInstanceOf(
        PlatformAgentInvalidInputError,
      );

      // assignment target unique (23505) → InvalidInput
      await db.insert(platformAgentAssignments).values({
        agentId: 'norm-pub',
        enabled: true,
        id: 'norm-assign-1',
        mode: 'optional',
        status: 'active',
        targetId: 'norm-user',
        targetType: 'user',
        versionPolicy: 'latest_published',
      });
      const dupTarget = await rawErrorOf(() =>
        db.insert(platformAgentAssignments).values({
          agentId: 'norm-pub',
          enabled: true,
          id: 'norm-assign-2',
          mode: 'optional',
          status: 'active',
          targetId: 'norm-user',
          targetType: 'user',
          versionPolicy: 'latest_published',
        }),
      );
      expect(translatePlatformAgentPgError(dupTarget)).toBeInstanceOf(
        PlatformAgentInvalidInputError,
      );

      // target trigger, missing user (23503, no constraint) → InvalidInput
      const ghostUser = await rawErrorOf(() =>
        db.insert(platformAgentAssignments).values({
          agentId: 'norm-pub',
          enabled: true,
          id: 'norm-ghost-user',
          mode: 'optional',
          status: 'active',
          targetId: 'ghost-user',
          targetType: 'user',
          versionPolicy: 'latest_published',
        }),
      );
      expect(translatePlatformAgentPgError(ghostUser)).toBeInstanceOf(
        PlatformAgentInvalidInputError,
      );

      // target trigger, missing global role (23503, no constraint) → InvalidInput
      const ghostRole = await rawErrorOf(() =>
        db.insert(platformAgentAssignments).values({
          agentId: 'norm-pub',
          enabled: true,
          id: 'norm-ghost-role',
          mode: 'optional',
          status: 'active',
          targetId: 'ghost-role',
          targetType: 'global_role',
          versionPolicy: 'latest_published',
        }),
      );
      expect(translatePlatformAgentPgError(ghostRole)).toBeInstanceOf(
        PlatformAgentInvalidInputError,
      );

      // The mapped errors carry no SQLSTATE / constraint / target / value.
      for (const raw of [dupKey, dupSystem, dupVersion, dupTarget, ghostUser, ghostRole]) {
        const mapped = translatePlatformAgentPgError(raw) as { code: string; message: string };
        expect(JSON.stringify({ code: mapped.code, message: mapped.message })).not.toMatch(
          /23505|23503|constraint|platform_agents_|platform_agent_|_unique|_fk|norm-user|ghost-|norm-a|__global__/,
        );
      }
    });

    it('rejects a duplicate assignment target through the service with a redacted failure audit', async () => {
      await seedPublishedAgent('svc-dup', 'svc-dup');
      await db.insert(users).values({ id: 'svc-user' });
      const service = new PlatformAgentAdminService(db);
      const upsert = async () =>
        service.upsertAssignment('admin', {
          ...(await pointerFor('svc-dup')),
          enabled: true,
          mode: 'optional',
          pinnedVersionId: null,
          reason: 'assign',
          targetId: 'svc-user',
          targetType: 'user',
          versionPolicy: 'latest_published',
        });
      await upsert();
      await expect(upsert()).rejects.toBeInstanceOf(PlatformAgentInvalidInputError);

      const failures = await db
        .select()
        .from(platformAuditLogs)
        .where(eq(platformAuditLogs.action, 'admin.agents.assignments.create'));
      const failed = failures.find((row) => row.result === 'failure');
      expect(failed?.afterDiff).toEqual({ error: 'invalid_input' });
      expect(JSON.stringify(failed?.afterDiff)).not.toMatch(/svc-user|23505|constraint|_unique/);
    });
  });

  // ADM-02: the shared per-Agent reference lock closes the archive/reference TOCTOU window.
  describe('referenceable-Agent protocol (TOCTOU)', () => {
    const poolService = () => {
      const pool = new Pool({ connectionString, max: 1 });
      const scopedDb = drizzle(pool, { schema }) as unknown as LobeChatDatabase;
      return { pool, service: new PlatformAgentAdminService(scopedDb), scopedDb };
    };
    const assignmentCount = async (agentId: string) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(platformAgentAssignments)
        .where(eq(platformAgentAssignments.agentId, agentId));
      return row.count;
    };
    const materializationCount = async (agentId: string) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(platformUserAgentMaterializations)
        .where(eq(platformUserAgentMaterializations.platformAgentId, agentId));
      return row.count;
    };
    const upsertAssignment = (
      service: PlatformAgentAdminService,
      agentId: string,
      pointer: Awaited<ReturnType<typeof pointerFor>>,
      target: { targetId: string; targetType: 'global' | 'global_role' | 'user' },
    ) =>
      service.upsertAssignment('admin', {
        ...pointer,
        enabled: true,
        mode: 'optional',
        pinnedVersionId: null,
        reason: 'assign',
        versionPolicy: 'latest_published',
        ...target,
      });
    const materialize = (target: LobeChatDatabase, agentId: string, userId: string) =>
      new PlatformAgentCatalogRepository(target).upsertMaterialization({
        platformAgentId: agentId,
        platformAgentVersionChecksum: CHECKSUM,
        platformAgentVersionId: `${agentId}-v1`,
        userId,
      });

    it.each([
      ['global', { targetId: '__global__', targetType: 'global' as const }],
      ['user', { targetId: 'toctou-user', targetType: 'user' as const }],
      ['global_role', { targetId: 'toctou-role', targetType: 'global_role' as const }],
    ])(
      'archive rejects with resource-in-use when a %s assignment committed first',
      async (_label, target) => {
        await seedPublishedAgent('ref-seq', 'ref-seq');
        await db.insert(users).values({ id: 'toctou-user' });
        await db
          .insert(roles)
          .values({ displayName: 'R', id: 'toctou-role', isActive: true, name: 'toctou-role' });
        const service = new PlatformAgentAdminService(db);
        await upsertAssignment(service, 'ref-seq', await pointerFor('ref-seq'), target);

        await expect(
          service.archive('admin', {
            ...(await pointerFor('ref-seq')),
            reason: 'archive after assign',
            replacementAgentId: null,
          }),
        ).rejects.toBeInstanceOf(PlatformAgentResourceInUseError);
        expect((await currentIdentity('ref-seq')).status).toBe('published');
      },
    );

    it('rejects a new assignment against an already-archived Agent (no orphan reference)', async () => {
      await seedPublishedAgent('ref-archived', 'ref-archived');
      await db.insert(users).values({ id: 'toctou-user' });
      const service = new PlatformAgentAdminService(db);
      await service.archive('admin', {
        ...(await pointerFor('ref-archived')),
        reason: 'archive first',
        replacementAgentId: null,
      });
      expect((await currentIdentity('ref-archived')).status).toBe('archived');

      await expect(
        upsertAssignment(service, 'ref-archived', await pointerFor('ref-archived'), {
          targetId: 'toctou-user',
          targetType: 'user',
        }),
      ).rejects.toBeInstanceOf(PlatformAgentNotFoundError);
      expect(await assignmentCount('ref-archived')).toBe(0);
    });

    it('archive rejects when a materialization committed first, and no-ops on an archived Agent', async () => {
      await seedPublishedAgent('ref-mat', 'ref-mat');
      await seedPublishedAgent('ref-mat2', 'ref-mat2');
      await db.insert(users).values([{ id: 'mat-user' }, { id: 'mat-user2' }]);
      const service = new PlatformAgentAdminService(db);

      // materialization first → archive resource-in-use
      await materialize(db, 'ref-mat', 'mat-user');
      await expect(
        service.archive('admin', {
          ...(await pointerFor('ref-mat')),
          reason: 'archive after materialize',
          replacementAgentId: null,
        }),
      ).rejects.toBeInstanceOf(PlatformAgentResourceInUseError);

      // archive first → materialization is rejected (undefined), no row created
      await service.archive('admin', {
        ...(await pointerFor('ref-mat2')),
        reason: 'archive first',
        replacementAgentId: null,
      });
      expect(await materialize(db, 'ref-mat2', 'mat-user2')).toBeUndefined();
      expect(await materializationCount('ref-mat2')).toBe(0);
    });

    it('concurrent archive vs assignment never leaves an archived Agent with a reference', async () => {
      for (let round = 0; round < 6; round += 1) {
        await cleanup();
        const agentId = `race-${round}`;
        await seedPublishedAgent(agentId, agentId);
        await db.insert(users).values({ id: 'race-user' });
        const a = poolService();
        const b = poolService();
        try {
          const pointer = await pointerFor(agentId);
          const results = await Promise.allSettled([
            a.service.archive('admin', {
              ...pointer,
              reason: 'concurrent archive',
              replacementAgentId: null,
            }),
            upsertAssignment(b.service, agentId, pointer, {
              targetId: 'race-user',
              targetType: 'user',
            }),
          ]);
          const fulfilled = results.filter((r) => r.status === 'fulfilled');
          expect(fulfilled).toHaveLength(1);
          const archived = (await currentIdentity(agentId)).status === 'archived';
          const count = await assignmentCount(agentId);
          // Core invariant: never an archived Agent that still owns a reference.
          expect(archived ? count === 0 : count === 1).toBe(true);
        } finally {
          await Promise.all([a.pool.end(), b.pool.end()]);
        }
      }
    }, 30_000);
  });

  // ADM-01: create joins the singleton lock; create / switch / archive / bootstrap never deadlock.
  describe('default singleton lock ordering', () => {
    it('runs concurrent create + setDefault switch + archive without deadlock', async () => {
      await seedPublishedAgent('ord-a', 'ord-a');
      await seedPublishedAgent('ord-b', 'ord-b');
      await seedPublishedAgent('ord-c', 'ord-c');
      // ord-a starts as the default; the switch hands it to ord-b.
      await db
        .update(platformAgents)
        .set({ isDefault: true, systemKey: 'default-inbox' })
        .where(eq(platformAgents.id, 'ord-a'));

      const make = () => {
        const pool = new Pool({ connectionString, max: 1 });
        return { pool, service: new PlatformAgentAdminService(drizzle(pool, { schema }) as never) };
      };
      const [creator, switcher, archiver] = [make(), make(), make()];
      try {
        const results = await Promise.allSettled([
          creator.service.create('admin', {
            agentKey: 'ord-new',
            isDefault: false,
            reason: 'concurrent create',
            systemKey: null,
          }),
          switcher.service.setDefaultInbox('admin', {
            currentDefault: await pointerFor('ord-a'),
            nextDefault: await pointerFor('ord-b'),
            reason: 'concurrent switch',
          }),
          archiver.service.archive('admin', {
            ...(await pointerFor('ord-c')),
            reason: 'concurrent archive',
            replacementAgentId: null,
          }),
        ]);

        // No deadlock: every serialized default mutation completes.
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(String((result.reason as { code?: string })?.code ?? '')).not.toBe('40P01');
          }
        }
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

        const [defaults] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(platformAgents)
          .where(eq(platformAgents.isDefault, true));
        expect(defaults.count).toBe(1);
        expect((await currentIdentity('ord-b')).isDefault).toBe(true);
        expect((await currentIdentity('ord-c')).status).toBe('archived');
      } finally {
        await Promise.all([creator.pool.end(), switcher.pool.end(), archiver.pool.end()]);
      }
    }, 30_000);
  });
});
