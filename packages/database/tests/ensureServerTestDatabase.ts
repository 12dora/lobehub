import { Pool } from 'pg';

import { getTestDB } from '../src/core/getTestDB';

/** Serializes only cross-process migration bootstrap; test bodies remain fully concurrent. */
export const ensureServerTestDatabase = async (connectionString: string): Promise<void> => {
  const coordinationPool = new Pool({ connectionString, max: 1 });
  const client = await coordinationPool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(1295005, 135)');
    await getTestDB();
  } finally {
    await client.query('SELECT pg_advisory_unlock(1295005, 135)');
    client.release();
    await coordinationPool.end();
  }
};
