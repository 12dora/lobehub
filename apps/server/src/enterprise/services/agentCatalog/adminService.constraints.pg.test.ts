/**
 * ADM-03 / ADM-01 constraint, reference lock, singleton ordering regressions (real PostgreSQL).
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  acquirePlatformAgentReferenceLock,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import * as schema from '@/database/schemas';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
  platformUserAgentMaterializations,
  roles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { mapAgentServiceError } from '../../routers/admin/agentsSupport';
import { PlatformAgentAdminService } from './adminService';
import {
  CHECKSUM,
  config,
  createAdminPgFixture,
  dependencySnapshot,
  enabled,
} from './adminService.pg.fixture';
import {
  PlatformAgentDefaultRequiredError,
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  PlatformAgentResourceInUseError,
  PlatformAgentRevisionConflictError,
} from './errors';
import { translatePlatformAgentPgError } from './pgErrors';

const run = enabled ? describe : describe.skip;

run('PlatformAgentAdminService (PostgreSQL) — constraints / locks', () => {
  const fx = createAdminPgFixture();
  const seedDraftAgent = (...args: Parameters<typeof fx.seedDraftAgent>) =>
    fx.seedDraftAgent(...args);
  const seedPublishedAgent = (...args: Parameters<typeof fx.seedPublishedAgent>) =>
    fx.seedPublishedAgent(...args);
  const currentIdentity = (...args: Parameters<typeof fx.currentIdentity>) =>
    fx.currentIdentity(...args);
  const pointerFor = (...args: Parameters<typeof fx.pointerFor>) => fx.pointerFor(...args);
  const deferred = () => fx.deferred();
  const rawErrorOf = (...args: Parameters<typeof fx.rawErrorOf>) => fx.rawErrorOf(...args);
  const connectionString = process.env.DATABASE_TEST_URL!;
  let db: LobeChatDatabase;
  beforeAll(() => {
    db = fx.db;
  });

  // ADM-03: real pg/Drizzle cause chains normalize by actual constraint / trigger, no leak.
  describe('constraint / trigger normalization (real cause chain)', () => {
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

    /**
     * Barrier-driven proof that repository reference writers share the archive lock.
     *
     * An archiver holds the SAME per-Agent reference lock (the production
     * `acquirePlatformAgentReferenceLock`) inside an open transaction that has already flipped
     * the row to 'archived', then a real repository write is launched on a separate connection.
     *
     * Structural assertion (`writerBlocked`): the writer must still be pending while the archiver
     * holds the lock. Pre-fix, the write took no shared lock and the FK KEY SHARE lock does not
     * conflict with the archiver's NO KEY UPDATE, so it would have committed a reference against
     * the doomed Agent immediately — settling before release and leaving an orphan. Post-fix it
     * blocks on the advisory lock, wakes after commit, re-reads status='archived', and rejects.
     */
    const archiveHolderBarrier = async (
      agentId: string,
      writer: (repo: PlatformAgentCatalogRepository) => Promise<unknown>,
    ) => {
      const archiverPool = new Pool({ connectionString, max: 1 });
      const writerPool = new Pool({ connectionString, max: 1 });
      const archiverDb = drizzle(archiverPool, { schema }) as unknown as LobeChatDatabase;
      const writerRepo = new PlatformAgentCatalogRepository(
        drizzle(writerPool, { schema }) as unknown as LobeChatDatabase,
      );
      const holding = deferred();
      const release = deferred();
      try {
        const archiverTx = archiverDb.transaction(async (tx) => {
          await acquirePlatformAgentReferenceLock(tx, agentId);
          await tx
            .update(platformAgents)
            .set({ isDefault: false, status: 'archived', systemKey: null })
            .where(eq(platformAgents.id, agentId));
          holding.resolve();
          await release.promise;
        });
        await holding.promise;

        let writerBlocked = true;
        const writerResult = writer(writerRepo).then((value) => {
          writerBlocked = false;
          return value;
        });
        await new Promise((settle) => setTimeout(settle, 300));
        expect(writerBlocked).toBe(true); // still queued behind the archiver's shared lock

        release.resolve();
        await archiverTx;
        const result = await writerResult;
        return result;
      } finally {
        await Promise.all([archiverPool.end(), writerPool.end()]);
      }
    };

    it('repository materialization write waits on the shared lock, then rejects (archive-first)', async () => {
      await seedPublishedAgent('bar-mat', 'bar-mat');
      await db.insert(users).values({ id: 'bar-user' });
      const result = await archiveHolderBarrier('bar-mat', (repo) =>
        repo.upsertMaterialization({
          platformAgentId: 'bar-mat',
          platformAgentVersionChecksum: CHECKSUM,
          platformAgentVersionId: 'bar-mat-v1',
          userId: 'bar-user',
        }),
      );
      expect(result).toBeUndefined();
      expect(await materializationCount('bar-mat')).toBe(0);
      expect((await currentIdentity('bar-mat')).status).toBe('archived');
    }, 20_000);

    it('repository assignment create waits on the shared lock, then rejects (archive-first)', async () => {
      await seedPublishedAgent('bar-asg', 'bar-asg');
      await db.insert(users).values({ id: 'bar-user' });
      const result = await archiveHolderBarrier('bar-asg', (repo) =>
        repo.createAssignment({
          agentId: 'bar-asg',
          enabled: true,
          mode: 'optional',
          pinnedVersionId: null,
          targetId: 'bar-user',
          targetType: 'user',
          versionPolicy: 'latest_published',
        }),
      );
      expect(result).toBeUndefined();
      expect(await assignmentCount('bar-asg')).toBe(0);
      expect((await currentIdentity('bar-asg')).status).toBe('archived');
    }, 20_000);

    it('reference committed first blocks the archiver, which then rejects resource-in-use', async () => {
      await seedPublishedAgent('bar-first', 'bar-first');
      await db.insert(users).values({ id: 'bar-user' });
      const holderPool = new Pool({ connectionString, max: 1 });
      const archiverPool = new Pool({ connectionString, max: 1 });
      const archiverService = new PlatformAgentAdminService(
        drizzle(archiverPool, { schema }) as unknown as LobeChatDatabase,
      );
      const holding = deferred();
      const release = deferred();
      try {
        // Writer opens a tx, takes the shared lock, inserts a materialization, then holds.
        const holderTx = (
          drizzle(holderPool, { schema }) as unknown as LobeChatDatabase
        ).transaction(async (tx) => {
          await new PlatformAgentCatalogRepository(tx).upsertMaterialization({
            platformAgentId: 'bar-first',
            platformAgentVersionChecksum: CHECKSUM,
            platformAgentVersionId: 'bar-first-v1',
            userId: 'bar-user',
          });
          holding.resolve();
          await release.promise;
        });
        await holding.promise;

        let archiverBlocked = true;
        const archiveResult = archiverService
          .archive('admin', {
            ...(await pointerFor('bar-first')),
            reason: 'archive behind reference writer',
            replacementAgentId: null,
          })
          .then(
            () => ({ ok: true }) as const,
            (error: unknown) => {
              archiverBlocked = false;
              return { error } as const;
            },
          );
        await new Promise((settle) => setTimeout(settle, 300));
        expect(archiverBlocked).toBe(true); // archiver queued behind the reference writer's lock

        release.resolve();
        await holderTx;
        const outcome = await archiveResult;
        expect('error' in outcome && outcome.error).toBeInstanceOf(PlatformAgentResourceInUseError);
        expect(await materializationCount('bar-first')).toBe(1);
        expect((await currentIdentity('bar-first')).status).toBe('published');
      } finally {
        await Promise.all([holderPool.end(), archiverPool.end()]);
      }
    }, 20_000);
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

  // ADM-03 finding: real foreign-key cause chains (not just unique / trigger) normalize + redact.
  describe('foreign-key cause-chain normalization (real pg)', () => {
    // Dig the raw pg diagnostics out of the wrapped Drizzle error's `.cause` chain, mirroring
    // what the production normalizer walks — so we assert against the ACTUAL constraint name.
    const pgFields = (error: unknown): { code?: string; constraint?: string } => {
      let current = error as { cause?: unknown; code?: unknown; constraint?: unknown } | undefined;
      for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
        if (typeof current.code === 'string') {
          return { code: current.code, constraint: current.constraint as string | undefined };
        }
        current = current.cause as typeof current;
      }
      return {};
    };

    it('normalizes cross-agent pinned-version and materialization exact-version FK without leak', async () => {
      await seedPublishedAgent('fk-a', 'fk-a'); // exact version fk-a-v1
      await seedPublishedAgent('fk-b', 'fk-b'); // exact version fk-b-v1
      await db.insert(users).values({ id: 'fk-user' });

      // Pinned version belongs to a DIFFERENT Agent → composite same-agent FK (23503).
      const pinnedFk = await rawErrorOf(() =>
        db.insert(platformAgentAssignments).values({
          agentId: 'fk-a',
          enabled: true,
          id: 'fk-assign',
          mode: 'optional',
          pinnedVersionId: 'fk-b-v1',
          status: 'active',
          targetId: '__global__',
          targetType: 'global',
          versionPolicy: 'pinned',
        }),
      );
      expect(pgFields(pinnedFk).code).toBe('23503');
      expect(pgFields(pinnedFk).constraint).toBe(
        'platform_agent_assignments_pinned_version_same_agent_fk',
      );
      expect(translatePlatformAgentPgError(pinnedFk)).toBeInstanceOf(
        PlatformAgentInvalidInputError,
      );

      // Materialization with a checksum that matches no exact version → exact-version FK (23503).
      const matFk = await rawErrorOf(() =>
        db.insert(platformUserAgentMaterializations).values({
          platformAgentId: 'fk-a',
          platformAgentVersionChecksum: 'c'.repeat(64),
          platformAgentVersionId: 'fk-a-v1',
          userId: 'fk-user',
        }),
      );
      expect(pgFields(matFk).code).toBe('23503');
      expect(pgFields(matFk).constraint).toBe(
        'platform_user_agent_materializations_exact_version_fk',
      );
      expect(translatePlatformAgentPgError(matFk)).toBeInstanceOf(PlatformAgentInvalidInputError);

      // Raw errors DO carry the constraint/target; the normalized error + public Router body must not.
      for (const raw of [pinnedFk, matFk]) {
        const mapped = translatePlatformAgentPgError(raw) as { code: string; message: string };
        let body: unknown;
        try {
          mapAgentServiceError(mapped);
        } catch (routerError) {
          body = getEnterpriseErrorBody(routerError);
        }
        expect((body as { code?: string })?.code).toBe('PLATFORM_INVALID_INPUT');
        const blob = JSON.stringify({ body, code: mapped.code, message: mapped.message });
        expect(blob).not.toMatch(/23503|constraint|_fk|fk-a|fk-b|fk-user|__global__/);
      }
    });
  });

  // ADM-02 finding: archiving the current default with a bad replacement rolls back atomically.
  describe('archive replacement failure rollback', () => {
    it('leaves the default published and untouched when the replacement is not published', async () => {
      await seedPublishedAgent('repl-current', 'repl-current');
      await db
        .update(platformAgents)
        .set({ isDefault: true, systemKey: 'default-inbox' })
        .where(eq(platformAgents.id, 'repl-current'));
      await seedDraftAgent('repl-draft', 'repl-draft'); // never published

      const before = await currentIdentity('repl-current');
      const service = new PlatformAgentAdminService(db);
      await expect(
        service.archive('admin', {
          ...(await pointerFor('repl-current')),
          reason: 'archive default with unpublished replacement',
          replacementAgentId: 'repl-draft',
        }),
      ).rejects.toBeInstanceOf(PlatformAgentDefaultRequiredError);

      // Whole transaction rolled back: the archive CAS ran then the replacement check threw, so
      // the current default reverts to published/default and the replacement never changed.
      const current = await currentIdentity('repl-current');
      expect(current.status).toBe('published');
      expect(current.isDefault).toBe(true);
      expect(current.revision).toBe(before.revision);
      expect(current.draftSequence).toBe(before.draftSequence);
      const draft = await currentIdentity('repl-draft');
      expect(draft.status).toBe('draft');
      expect(draft.isDefault).toBe(false);

      // Only a stable, redacted failure audit — no target / replacement identifier.
      const audits = await db
        .select()
        .from(platformAuditLogs)
        .where(eq(platformAuditLogs.action, 'admin.agents.archive'));
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('failure');
      expect(audits[0].afterDiff).toEqual({ error: 'default_required' });
      expect(JSON.stringify(audits[0].afterDiff)).not.toMatch(/repl-draft|repl-current/);
    });

    it('promotes the replacement and archives the current default when the replacement is published', async () => {
      await seedPublishedAgent('repl-cur2', 'repl-cur2');
      await seedPublishedAgent('repl-next', 'repl-next');
      await db
        .update(platformAgents)
        .set({ isDefault: true, systemKey: 'default-inbox' })
        .where(eq(platformAgents.id, 'repl-cur2'));

      const service = new PlatformAgentAdminService(db);
      await service.archive('admin', {
        ...(await pointerFor('repl-cur2')),
        reason: 'archive default with published replacement',
        replacementAgentId: 'repl-next',
      });

      expect((await currentIdentity('repl-cur2')).status).toBe('archived');
      expect((await currentIdentity('repl-cur2')).isDefault).toBe(false);
      const next = await currentIdentity('repl-next');
      expect(next.isDefault).toBe(true);
      expect(next.systemKey).toBe('default-inbox');
      const [defaults] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(platformAgents)
        .where(eq(platformAgents.isDefault, true));
      expect(defaults.count).toBe(1);
    });
  });
});
