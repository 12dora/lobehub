/**
 * TRUE multi-connection PostgreSQL evidence for rollout worker coordination (M10 PR-052).
 *
 * Runs only with `TEST_SERVER_DB=1` and `DATABASE_TEST_URL`; the always-on PGlite suite covers the
 * same cursor/checkpoint behavior in-process. Independent one-connection pools are required here to
 * exercise `FOR UPDATE SKIP LOCKED`, leases, and JSON revision checkpoints across real sessions.
 *
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform/checksum';
import * as schema from '@/database/schemas';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
  platformJobs,
  platformUserAgentMaterializations,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { runPlatformAgentRolloutBatches } from '../../jobs/agentRollout';
import { platformAgentDraftToken } from './publication';
import { PlatformAgentRolloutService } from './rolloutService';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;
const checksum = 'a'.repeat(64);
const dependencies = {
  connectors: [],
  model: {
    modelKey: 'chat',
    providerChecksum: checksum,
    providerKey: 'provider',
    providerRevision: 1,
  },
  skills: [],
};
const config = (displayName: string) => ({
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName,
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Support',
  tags: [],
});

run('Platform Agent rollout — true multi-connection PostgreSQL', () => {
  const connectionString = process.env.DATABASE_TEST_URL!;
  const pools: Pool[] = [];
  let db: LobeChatDatabase;

  const workerDb = (): LobeChatDatabase => {
    const pool = new Pool({ connectionString, max: 1 });
    pools.push(pool);
    return drizzle(pool, { schema }) as unknown as LobeChatDatabase;
  };
  const cleanup = () =>
    db.execute(sql`
      TRUNCATE TABLE
        ${platformAuditLogs},
        ${platformJobs},
        ${platformAgentAssignments},
        ${platformUserAgentMaterializations},
        ${platformAgentVersions},
        ${platformAgents},
        ${users}
      RESTART IDENTITY CASCADE
    `);

  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await cleanup();
    await db.insert(users).values([
      { id: 'admin' },
      ...Array.from({ length: 202 }, (_, index) => ({
        id: `worker-target-${String(index).padStart(4, '0')}`,
      })),
    ]);
    await db.insert(platformAgents).values({
      agentKey: 'pg-rollout',
      currentVersionId: null,
      id: 'pg-agent',
      migrationRequired: false,
      publishedAt: new Date(),
      revision: 2,
      status: 'published',
      title: 'PG rollout',
    });
    await db.insert(platformAgentVersions).values([
      {
        agentId: 'pg-agent',
        checksum: checksumPayload({ config: config('PG v1'), dependencySnapshot: dependencies }),
        config: config('PG v1'),
        dependencySnapshot: dependencies,
        id: 'pg-version-1',
        version: '1.0.0',
      },
      {
        agentId: 'pg-agent',
        checksum: checksumPayload({ config: config('PG v2'), dependencySnapshot: dependencies }),
        config: config('PG v2'),
        dependencySnapshot: dependencies,
        id: 'pg-version-2',
        version: '2.0.0',
      },
    ]);
    await db
      .update(platformAgents)
      .set({ currentVersionId: 'pg-version-2' })
      .where(eq(platformAgents.id, 'pg-agent'));
    await db.insert(platformAgentAssignments).values({
      agentId: 'pg-agent',
      enabled: true,
      id: 'pg-assignment',
      mode: 'mandatory',
      status: 'active',
      targetId: '__global__',
      targetType: 'global',
      versionPolicy: 'latest_published',
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await cleanup();
  });
  afterAll(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('coordinates two independent workers over multiple pages without duplicate targets', async () => {
    const service = new PlatformAgentRolloutService(db);
    const [identity] = await db
      .select()
      .from(platformAgents)
      .where(eq(platformAgents.id, 'pg-agent'));
    const started = await service.start('admin', {
      agentId: identity.id,
      assignmentId: 'pg-assignment',
      expectedDraftToken: platformAgentDraftToken(identity),
      expectedRevision: identity.revision,
      reason: 'real PostgreSQL rollout evidence',
    });

    await Promise.all([
      runPlatformAgentRolloutBatches(workerDb(), 10),
      runPlatformAgentRolloutBatches(workerDb(), 10),
    ]);

    await expect(
      service.get({ agentId: identity.id, jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 203, failed: 0, status: 'completed', total: 203 });
    const materializations = await db
      .select()
      .from(platformUserAgentMaterializations)
      .where(eq(platformUserAgentMaterializations.platformAgentId, identity.id));
    expect(materializations).toHaveLength(203);
    expect(new Set(materializations.map(({ userId }) => userId)).size).toBe(203);
  });
});
