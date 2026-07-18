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

import { assertAgentNotPlatformManaged } from './managedPlatformAgent';

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
});
