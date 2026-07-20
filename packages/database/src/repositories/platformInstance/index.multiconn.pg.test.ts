// @vitest-environment node
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import * as schema from '../../schemas';
import { platformInstanceHeartbeats, platformInstanceRevisionStates } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformInstanceRepository } from '.';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

describe.skipIf(!enabled)('PlatformInstanceRepository PostgreSQL multi-connection', () => {
  it('converges independent connection upserts without duplicating inventory or state', async () => {
    await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const firstPool = new Pool({ connectionString, max: 1 });
    const secondPool = new Pool({ connectionString, max: 1 });
    const firstDb = drizzle(firstPool, { schema }) as unknown as LobeChatDatabase;
    const secondDb = drizzle(secondPool, { schema }) as unknown as LobeChatDatabase;
    const id = `pinst_${'b'.repeat(48)}`;

    try {
      await firstDb.delete(platformInstanceRevisionStates);
      await firstDb.delete(platformInstanceHeartbeats);
      const first = new PlatformInstanceRepository(firstDb);
      const second = new PlatformInstanceRepository(secondDb);

      await Promise.all([first.upsertHeartbeat(id), second.upsertHeartbeat(id)]);
      await Promise.all([
        first.upsertRevisionState({
          domain: 'settings',
          health: 'healthy',
          instanceId: id,
          loadedRevision: 1,
          loadMode: 'process_cached',
          source: 'database',
        }),
        second.upsertRevisionState({
          domain: 'settings',
          health: 'healthy',
          instanceId: id,
          loadedRevision: 2,
          loadMode: 'process_cached',
          source: 'cache',
        }),
      ]);

      expect(await firstDb.select().from(platformInstanceHeartbeats)).toHaveLength(1);
      expect(await firstDb.select().from(platformInstanceRevisionStates)).toHaveLength(1);
    } finally {
      await firstDb.delete(platformInstanceRevisionStates);
      await firstDb.delete(platformInstanceHeartbeats);
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  }, 20_000);
});
