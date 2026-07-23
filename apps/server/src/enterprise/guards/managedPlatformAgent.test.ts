/**
 * ROOT-02 — the ordinary-Agent mutation guard against a platform-managed materialized local id.
 *
 * @vitest-environment node
 */
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import { agents } from '@/database/schemas/agent';
import {
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';
import { PlatformDefaultInboxService } from '@/server/enterprise/services/agentCatalog/defaultInbox';

import { getEnterpriseErrorBody } from './enterpriseErrors';
import {
  assertAgentNotPlatformManaged,
  assertAgentsNotPlatformManaged,
  MANAGED_AGENT_BATCH_LIMIT_CODE,
  MANAGED_AGENT_BATCH_LIMIT_REASON,
  MAX_MANAGED_AGENT_GUARD_IDS,
  pickAgentId,
  pickAgentIds,
  pickDocumentAgentIds,
  pickId,
} from './managedPlatformAgent';

const db: LobeChatDatabase = await getTestDB();
const CHECKSUM = 'a'.repeat(64);

const cleanup = () =>
  db.execute(sql`
    TRUNCATE TABLE
      ${platformUserAgentMaterializations},
      ${platformAgentVersions},
      ${platformAgents},
      ${agents},
      ${users}
    RESTART IDENTITY CASCADE
  `);

const seedMaterialized = async () => {
  await db.insert(platformAgents).values({
    agentKey: 'pa',
    id: 'pa',
    migrationRequired: false,
    status: 'draft',
    title: 'pa',
  });
  await db.insert(platformAgentVersions).values({
    agentId: 'pa',
    checksum: CHECKSUM,
    config: {} as never,
    dependencySnapshot: { connectors: [], model: {}, skills: [] } as never,
    id: 'pa-v1',
    version: '1.0.0',
  });
  await db.insert(agents).values([
    { id: 'agt_materialized', title: 'M', userId: 'user-a' },
    { id: 'agt_ordinary', title: 'O', userId: 'user-a' },
  ]);
  await new PlatformAgentCatalogRepository(db).materializeLocalAgent({
    createLocalAgent: async () => ({ id: 'agt_materialized' }),
    platformAgentId: 'pa',
    platformAgentVersionChecksum: CHECKSUM,
    platformAgentVersionId: 'pa-v1',
    userId: 'user-a',
  });
};

const assertManaged = (agentId: string, userId = 'user-a') =>
  assertAgentNotPlatformManaged({ agentId, db, userId }).then(
    () => null,
    (e) => e,
  );

beforeEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
  await db.insert(users).values([{ id: 'user-a' }, { id: 'user-b' }]);
  await seedMaterialized();
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('assertAgentNotPlatformManaged (ROOT-02)', () => {
  it('rejects a mutation targeting a materialized platform Agent when the flag is on', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const error = await assertManaged('agt_materialized');
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('FORBIDDEN');
  });

  it('allows an ordinary (non-materialized) local Agent', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    expect(await assertManaged('agt_ordinary')).toBeNull();
  });

  it('is owner-scoped: another user is never blocked by user-a’s mapping', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    expect(await assertManaged('agt_materialized', 'user-b')).toBeNull();
  });

  it('is a no-op when the managed flag is off (ordinary local Agents unaffected)', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    expect(await assertManaged('agt_materialized')).toBeNull();
  });

  it('rejects the builtin inbox before its first operation creates a reverse mapping', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await db.insert(agents).values({ id: 'builtin-inbox', slug: 'inbox', userId: 'user-a' });
    const capture = vi
      .spyOn(PlatformDefaultInboxService.prototype, 'capture')
      .mockResolvedValue({} as never);

    const error = await assertManaged('builtin-inbox');
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('FORBIDDEN');
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('fails closed when default-inbox resolution fails during a builtin inbox mutation', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await db.insert(agents).values({ id: 'builtin-inbox', slug: 'inbox', userId: 'user-a' });
    const failure = new Error('resolver unavailable');
    vi.spyOn(PlatformDefaultInboxService.prototype, 'capture').mockRejectedValue(failure);

    await expect(
      assertAgentNotPlatformManaged({ agentId: 'builtin-inbox', db, userId: 'user-a' }),
    ).rejects.toBe(failure);
  });
});

describe('assertAgentsNotPlatformManaged (RR2-4 batch)', () => {
  const assertMany = (agentIds: string[], userId = 'user-a') =>
    assertAgentsNotPlatformManaged({ agentIds, db, userId }).then(
      () => null,
      (e) => e,
    );

  it('rejects the whole batch when ANY id is a materialized platform Agent', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    // A managed id smuggled inside an otherwise-ordinary array must still be caught.
    const error = await assertMany(['agt_ordinary', 'agt_materialized']);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('FORBIDDEN');
  });

  it('allows a batch of only ordinary local Agents', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    expect(await assertMany(['agt_ordinary'])).toBeNull();
    expect(await assertMany([])).toBeNull();
  });

  it('is owner-scoped and flag-gated', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    expect(await assertMany(['agt_materialized'], 'user-b')).toBeNull();
    const countingDb = Object.create(db) as LobeChatDatabase;
    countingDb.select = vi.fn(db.select.bind(db)) as never;
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    await expect(
      assertAgentsNotPlatformManaged({
        agentIds: ['agt_materialized'],
        db: countingDb,
        userId: 'user-a',
      }),
    ).resolves.toBeUndefined();
    expect(countingDb.select).not.toHaveBeenCalled();
  });

  it('deduplicates into exactly two owner-scoped batch queries', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const countingDb = Object.create(db) as LobeChatDatabase;
    countingDb.select = vi.fn(db.select.bind(db)) as never;

    await expect(
      assertAgentsNotPlatformManaged({
        agentIds: ['agt_ordinary', 'agt_ordinary'],
        db: countingDb,
        userId: 'user-a',
      }),
    ).resolves.toBeUndefined();
    expect(countingDb.select).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized batches before any query with structured i18n details', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const countingDb = Object.create(db) as LobeChatDatabase;
    countingDb.select = vi.fn(db.select.bind(db)) as never;
    const ids = Array.from({ length: MAX_MANAGED_AGENT_GUARD_IDS + 1 }, (_, i) => `agt_${i}`);

    const error = await assertAgentsNotPlatformManaged({
      agentIds: ids,
      db: countingDb,
      userId: 'user-a',
    }).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('BAD_REQUEST');
    expect((error as TRPCError).message).toBe(MANAGED_AGENT_BATCH_LIMIT_CODE);
    expect(getEnterpriseErrorBody(error)).toEqual({
      code: MANAGED_AGENT_BATCH_LIMIT_CODE,
      details: {
        max: MAX_MANAGED_AGENT_GUARD_IDS,
        reason: MANAGED_AGENT_BATCH_LIMIT_REASON,
      },
      message: MANAGED_AGENT_BATCH_LIMIT_CODE,
    });
    expect(countingDb.select).not.toHaveBeenCalled();
  });

  it('exposes a dedicated batch-limit code + details.max contract for client i18n', () => {
    // Server contract only — client mapper + locale keys are OUT_OF_SCOPE shared-infra/i18n.
    expect(MANAGED_AGENT_BATCH_LIMIT_CODE).toBe('MANAGED_AGENT_BATCH_LIMIT');
    expect(MANAGED_AGENT_BATCH_LIMIT_REASON).toBe('managed_agent_batch_limit');
    // i18n key shape clients must register: enterprise.error.MANAGED_AGENT_BATCH_LIMIT with {{max}}.
    const i18nKey = `enterprise.error.${MANAGED_AGENT_BATCH_LIMIT_CODE}`;
    expect(i18nKey).toBe('enterprise.error.MANAGED_AGENT_BATCH_LIMIT');
    expect(MAX_MANAGED_AGENT_GUARD_IDS).toBe(100);
  });
});

describe('agent-id pickers (RR2-4)', () => {
  it('extract the target agent id(s) from each mutation input shape', () => {
    expect(pickAgentId({ agentId: 'a1' })).toEqual(['a1']);
    expect(pickId({ id: 'a2' })).toEqual(['a2']);
    expect(pickAgentIds({ agentIds: ['a3', 'a4'] })).toEqual(['a3', 'a4']);
    expect(pickDocumentAgentIds({ sourceAgentId: 's', targetAgentId: 't' })).toEqual([
      undefined,
      's',
      't',
    ]);
    // Robust to malformed / missing inputs (guard then simply finds nothing to check).
    expect(pickAgentIds({})).toEqual([]);
    expect(pickAgentId(null)).toEqual([undefined]);
    expect(pickId(undefined)).toEqual([undefined]);
  });
});
