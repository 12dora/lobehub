import { Pool, type PoolClient } from 'pg';

const indexes = [
  {
    duplicateQuery: `SELECT count(*)::integer AS count FROM (
      SELECT 1 FROM platform_user_connector_bindings
      GROUP BY id, user_id, connector_id HAVING count(*) > 1 LIMIT 1
    ) duplicates`,
    name: 'platform_user_connector_bindings_oauth_state_owner_unique',
    statement: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
      platform_user_connector_bindings_oauth_state_owner_unique
      ON platform_user_connector_bindings (id, user_id, connector_id)`,
  },
  {
    duplicateQuery: `SELECT count(*)::integer AS count FROM (
      SELECT 1 FROM platform_resource_revisions
      GROUP BY resource_type, resource_id, revision, checksum HAVING count(*) > 1 LIMIT 1
    ) duplicates`,
    name: 'platform_resource_revisions_type_id_revision_checksum_unique',
    statement: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
      platform_resource_revisions_type_id_revision_checksum_unique
      ON platform_resource_revisions (resource_type, resource_id, revision, checksum)`,
  },
] as const;

const assertIndexReady = async (client: PoolClient, name: string) => {
  const result = await client.query<{
    indisready: boolean;
    indisunique: boolean;
    indisvalid: boolean;
  }>(
    `SELECT index.indisready, index.indisunique, index.indisvalid
     FROM pg_index index
     JOIN pg_class relation ON relation.oid = index.indexrelid
     WHERE relation.relname = $1`,
    [name],
  );
  const state = result.rows[0];
  if (!state?.indisready || !state.indisunique || !state.indisvalid) {
    throw new Error(`M09_INDEX_NOT_READY:${name}`);
  }
};

const predeploy = async () => {
  if (process.env.M09_INDEX_PREDEPLOY_APPROVED !== '1') {
    throw new Error('M09_INDEX_PREDEPLOY_APPROVED=1 is required');
  }
  const connectionString =
    process.env.TEST_SERVER_DB === '1' ? process.env.DATABASE_TEST_URL : process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    // CREATE INDEX CONCURRENTLY must remain in autocommit mode. Never add BEGIN here.
    await client.query(`SET lock_timeout = '5s'`);
    await client.query(`SET statement_timeout = '30min'`);
    for (const index of indexes) {
      const existing = await client.query<{ indisready: boolean; indisvalid: boolean }>(
        `SELECT candidate.indisready, candidate.indisvalid
         FROM pg_index candidate JOIN pg_class relation ON relation.oid = candidate.indexrelid
         WHERE relation.relname = $1`,
        [index.name],
      );
      if (existing.rows[0] && (!existing.rows[0].indisready || !existing.rows[0].indisvalid)) {
        throw new Error(`M09_INVALID_EXISTING_INDEX:${index.name}`);
      }
      const duplicates = await client.query<{ count: number }>(index.duplicateQuery);
      if ((duplicates.rows[0]?.count ?? 0) > 0) {
        throw new Error(`M09_DUPLICATE_INDEX_KEY:${index.name}`);
      }
      await client.query(index.statement);
      await assertIndexReady(client, index.name);
      console.info(`M09 index ready: ${index.name}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
};

await predeploy();
