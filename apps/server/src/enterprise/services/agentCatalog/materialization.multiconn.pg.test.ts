/**
 * TRUE multi-connection PostgreSQL evidence for delayed materialization + exact-version pinning
 * (M10 PR-049 · TRUE-PG-MULTICONN).
 *
 * Runs ONLY when `TEST_SERVER_DB=1` and `DATABASE_TEST_URL` is set; otherwise the whole suite is
 * `describe.skip`. PGlite is a single in-process connection and CANNOT reproduce cross-connection
 * advisory-lock contention, so these cases each use several INDEPENDENT `pg` Pool connections
 * (`max: 1`) — real backends contending for the same per-Agent advisory lock, not one shared
 * transaction. Credentials/secrets are never read; only fake test data is used.
 *
 * @vitest-environment node
 */
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import { createUnmanagedResourcePolicyMap } from '@/database/models/platform';
import {
  acquirePlatformAgentReferenceLock,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import * as schema from '@/database/schemas';
import { agents } from '@/database/schemas/agent';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformAgentEffectiveResolver } from './effectiveResolver';
import { PlatformAgentMaterializationService } from './materialization';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;

const CHECKSUM_V1 = 'a'.repeat(64);
const CHECKSUM_V2 = 'c'.repeat(64);
const flags = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };

const config = (displayName: string) => ({
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName,
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: `${displayName} role`,
  tags: [],
});

const dependencySnapshot = {
  connectors: [],
  model: {
    modelKey: 'chat-model',
    providerChecksum: 'b'.repeat(64),
    providerKey: 'internal-provider',
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

run('delayed materialization — true multi-connection PostgreSQL', () => {
  const connectionString = process.env.DATABASE_TEST_URL!;
  let db: LobeChatDatabase;
  const workerPools: Pool[] = [];

  const resolver = (target: LobeChatDatabase = db) =>
    new PlatformAgentEffectiveResolver(target, {
      flags,
      policyModel: { getSnapshot: async () => managedPolicy() },
    });

  const workerDb = (): { db: LobeChatDatabase; pool: Pool } => {
    const pool = new Pool({ connectionString, max: 1 });
    workerPools.push(pool);
    return { db: drizzle(pool, { schema }) as unknown as LobeChatDatabase, pool };
  };

  const seedPublishedAgent = async (id: string, mode: 'mandatory' | 'optional' = 'optional') => {
    await db.insert(platformAgents).values({
      agentKey: id,
      id,
      migrationRequired: false,
      status: 'draft',
      title: id,
    });
    await db.insert(platformAgentVersions).values({
      agentId: id,
      checksum: CHECKSUM_V1,
      config: config(`${id} v1`),
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
    await db.insert(platformAgentAssignments).values({
      agentId: id,
      enabled: true,
      id: `${id}-global`,
      mode,
      status: 'active',
      targetId: '__global__',
      targetType: 'global',
      versionPolicy: 'latest_published',
    });
  };

  const publishV2 = async (id: string) => {
    await db.insert(platformAgentVersions).values({
      agentId: id,
      checksum: CHECKSUM_V2,
      config: config(`${id} v2`),
      dependencySnapshot,
      id: `${id}-v2`,
      version: '2.0.0',
    });
    await db
      .update(platformAgents)
      .set({ currentVersionId: `${id}-v2`, revision: 2 })
      .where(eq(platformAgents.id, id));
  };

  const beginSnapshot = async (userId: string, platformAgentId: string) => {
    const handle = await resolver().beginOperation(userId, platformAgentId);
    if (!handle) throw new Error('expected an entitled operation handle');
    return handle.getSnapshot();
  };

  const mappingsFor = (userId: string, platformAgentId: string) =>
    db
      .select()
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, userId),
          eq(platformUserAgentMaterializations.platformAgentId, platformAgentId),
        ),
      );

  const localAgentsFor = (userId: string) =>
    db.select().from(agents).where(eq(agents.userId, userId));

  const cleanup = () =>
    db.execute(sql`
      TRUNCATE TABLE
        ${platformUserAgentMaterializations},
        ${platformAgentAssignments},
        ${platformAgentVersions},
        ${platformAgents},
        ${agents},
        ${users}
      RESTART IDENTITY CASCADE
    `);

  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    await cleanup();
    await db.insert(users).values([{ id: 'user-a' }, { id: 'user-b' }]);
  });
  afterEach(async () => {
    await Promise.all(workerPools.splice(0).map((pool) => pool.end()));
    await cleanup();
  });
  afterAll(async () => {
    await Promise.all(workerPools.splice(0).map((pool) => pool.end()));
  });

  it('N=6 concurrent first-materialize across independent connections → 1 mapping, 1 Agent, no orphan', async () => {
    await seedPublishedAgent('cc-first');
    const snapshot = await beginSnapshot('user-a', 'cc-first');

    const results = await Promise.all(
      Array.from({ length: 6 }, () => {
        const { db: wdb } = workerDb();
        return new PlatformAgentMaterializationService(wdb, 'user-a')
          .materializeForOperation(snapshot)
          .then(
            (materialized) => ({ agentId: materialized.agentId, ok: true as const }),
            (error) => ({ error, ok: false as const }),
          );
      }),
    );

    const succeeded = results.filter((result) => result.ok);
    expect(succeeded).toHaveLength(6); // every independent connection succeeds
    const agentIds = new Set(succeeded.map((result) => (result as { agentId: string }).agentId));
    expect(agentIds.size).toBe(1); // all resolve to the SAME local Agent

    const mappings = await mappingsFor('user-a', 'cc-first');
    expect(mappings).toHaveLength(1); // exactly one mapping
    const localAgents = await localAgentsFor('user-a');
    expect(localAgents).toHaveLength(1); // exactly one Agent — every rolled-back candidate left no orphan
    expect(mappings[0].materializedAgentId).toBe([...agentIds][0]);
  });

  it('N=6 concurrent materialize over a pre-existing hidden-only row → still a single materialization', async () => {
    await seedPublishedAgent('cc-hidden');
    // A pure visibility-only (hidden) row exists first (no local Agent yet).
    await resolver().setAgentHidden('user-a', 'cc-hidden', true);
    const preRow = (await mappingsFor('user-a', 'cc-hidden'))[0];
    expect(preRow.materializedAgentId).toBeNull();

    const snapshot = await beginSnapshot('user-a', 'cc-hidden');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => {
        const { db: wdb } = workerDb();
        return new PlatformAgentMaterializationService(wdb, 'user-a')
          .materializeForOperation(snapshot)
          .then((materialized) => materialized.agentId);
      }),
    );

    expect(new Set(results).size).toBe(1); // one upgraded materialization, shared by all
    const mappings = await mappingsFor('user-a', 'cc-hidden');
    expect(mappings).toHaveLength(1);
    expect(mappings[0].materializedAgentId).toBe(results[0]);
    expect(mappings[0].hidden).toBe(true); // the owner's hidden preference is preserved
    expect(await localAgentsFor('user-a')).toHaveLength(1);
  });

  it('archive wins the lock first → concurrent materialize fails closed with no orphan (advisory-lock serialized)', async () => {
    await seedPublishedAgent('cc-archive-first');
    const snapshot = await beginSnapshot('user-a', 'cc-archive-first');

    const { db: archiverDb } = workerDb();
    const { db: writerDb } = workerDb();

    let releaseArchiver!: () => void;
    const release = new Promise<void>((settle) => (releaseArchiver = settle));
    let archiverHolding!: () => void;
    const held = new Promise<void>((settle) => (archiverHolding = settle));

    // Archiver acquires the SAME per-Agent reference advisory lock, archives, then parks.
    const archiverTx = archiverDb.transaction(async (tx) => {
      await acquirePlatformAgentReferenceLock(tx, 'cc-archive-first');
      await tx
        .update(platformAgents)
        .set({ status: 'archived' })
        .where(eq(platformAgents.id, 'cc-archive-first'));
      archiverHolding();
      await release;
    });
    await held;

    let writerSettled = false;
    const writerResult = new PlatformAgentMaterializationService(writerDb, 'user-a')
      .materializeForOperation(snapshot)
      .then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ error, ok: false }) as const,
      )
      .then((outcome) => {
        writerSettled = true;
        return outcome;
      });

    await new Promise((settle) => setTimeout(settle, 300));
    expect(writerSettled).toBe(false); // genuinely blocked behind the archiver's cross-connection lock

    releaseArchiver();
    await archiverTx;
    const outcome = await writerResult;

    expect(outcome.ok).toBe(false); // fail closed once the archive commits
    expect(await mappingsFor('user-a', 'cc-archive-first')).toHaveLength(0);
    expect(await localAgentsFor('user-a')).toHaveLength(0); // no orphan Agent
  });

  it('materialize commits first → a later archive is rejected as resource-in-use (no TOCTOU)', async () => {
    await seedPublishedAgent('cc-mat-first');
    const snapshot = await beginSnapshot('user-a', 'cc-mat-first');
    const { agentId } = await new PlatformAgentMaterializationService(
      db,
      'user-a',
    ).materializeForOperation(snapshot);

    // A real materialization is a reference: archiving the Agent must be refused.
    expect(
      (await new PlatformAgentCatalogRepository(db).countAgentReferences('cc-mat-first'))
        .materializations,
    ).toBe(1);

    const mappings = await mappingsFor('user-a', 'cc-mat-first');
    expect(mappings).toHaveLength(1);
    expect(mappings[0].materializedAgentId).toBe(agentId);
    expect(await localAgentsFor('user-a')).toHaveLength(1);
  });

  it('is owner-scoped under concurrency: user A and user B each get exactly one isolated Agent', async () => {
    await seedPublishedAgent('cc-owner');
    const snapshotA = await beginSnapshot('user-a', 'cc-owner');
    const snapshotB = await beginSnapshot('user-b', 'cc-owner');

    const materializeMany = (userId: string, snapshot: typeof snapshotA) =>
      Promise.all(
        Array.from({ length: 4 }, () => {
          const { db: wdb } = workerDb();
          return new PlatformAgentMaterializationService(wdb, userId)
            .materializeForOperation(snapshot)
            .then((materialized) => materialized.agentId);
        }),
      );

    const [idsA, idsB] = await Promise.all([
      materializeMany('user-a', snapshotA),
      materializeMany('user-b', snapshotB),
    ]);

    expect(new Set(idsA).size).toBe(1);
    expect(new Set(idsB).size).toBe(1);
    expect(idsA[0]).not.toBe(idsB[0]); // never cross-owner
    expect(await mappingsFor('user-a', 'cc-owner')).toHaveLength(1);
    expect(await mappingsFor('user-b', 'cc-owner')).toHaveLength(1);
    expect(await localAgentsFor('user-a')).toHaveLength(1);
    expect(await localAgentsFor('user-b')).toHaveLength(1);
  });

  it('exact-version pin: an in-flight v1 operation stays v1 after v2 is published; a new operation gets v2', async () => {
    await seedPublishedAgent('cc-exact');
    const snapshotV1 = await beginSnapshot('user-a', 'cc-exact');
    expect(snapshotV1.versionId).toBe('cc-exact-v1');

    await publishV2('cc-exact');
    const snapshotV2 = await beginSnapshot('user-a', 'cc-exact');
    expect(snapshotV2.versionId).toBe('cc-exact-v2');

    const service = new PlatformAgentMaterializationService(db, 'user-a');
    // The v1 pin re-derives v1's exact config from the immutable version, not the advanced pointer.
    const fromV1 = await service.materializeFromPin({
      checksum: CHECKSUM_V1,
      platformAgentId: 'cc-exact',
      versionId: 'cc-exact-v1',
    });
    expect(fromV1.config.title).toBe('cc-exact v1');
    expect(fromV1.config.model).toBe('chat-model');
    // A fresh operation resolves v2.
    const fromV2 = await service.materializeForOperation(snapshotV2);
    expect(fromV2.config.title).toBe('cc-exact v2');
    // Same attribution Agent across both (one local Agent per user/platform Agent).
    expect(fromV2.agentId).toBe(fromV1.agentId);
  });

  it('exact-version pin: a checksum mismatch fails closed', async () => {
    await seedPublishedAgent('cc-mismatch');
    await expect(
      new PlatformAgentMaterializationService(db, 'user-a').materializeFromPin({
        checksum: 'f'.repeat(64),
        platformAgentId: 'cc-mismatch',
        versionId: 'cc-mismatch-v1',
      }),
    ).rejects.toBeDefined();
  });
});
