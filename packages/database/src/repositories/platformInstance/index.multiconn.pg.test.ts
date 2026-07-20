// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { ensureServerTestDatabase } from '../../../tests/ensureServerTestDatabase';
import * as schema from '../../schemas';
import { platformInstanceHeartbeats, platformInstanceRevisionStates } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformInstanceRepository } from '.';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

describe.skipIf(!enabled)('PlatformInstanceRepository PostgreSQL multi-connection', () => {
  it('converges independent connection upserts without duplicating inventory or state', async () => {
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    await ensureServerTestDatabase(connectionString);
    const firstPool = new Pool({ connectionString, max: 1 });
    const secondPool = new Pool({ connectionString, max: 1 });
    const firstDb = drizzle(firstPool, { schema }) as unknown as LobeChatDatabase;
    const secondDb = drizzle(secondPool, { schema }) as unknown as LobeChatDatabase;
    const testNamespace = randomUUID().replaceAll('-', '');
    const id = `pinst_${testNamespace}${testNamespace.slice(0, 16)}`;

    try {
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

      expect(
        await firstDb
          .select()
          .from(platformInstanceHeartbeats)
          .where(eq(platformInstanceHeartbeats.instanceId, id)),
      ).toHaveLength(1);
      expect(
        await firstDb
          .select()
          .from(platformInstanceRevisionStates)
          .where(
            and(
              eq(platformInstanceRevisionStates.instanceId, id),
              eq(platformInstanceRevisionStates.domain, 'settings'),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await firstDb
        .delete(platformInstanceRevisionStates)
        .where(
          and(
            eq(platformInstanceRevisionStates.instanceId, id),
            eq(platformInstanceRevisionStates.domain, 'settings'),
          ),
        );
      await firstDb
        .delete(platformInstanceHeartbeats)
        .where(eq(platformInstanceHeartbeats.instanceId, id));
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  }, 20_000);
});
