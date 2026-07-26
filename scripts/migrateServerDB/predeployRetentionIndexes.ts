import { Pool, type PoolClient } from 'pg';

const indexes = [
  {
    name: 'topics_retention_updated_at_id_idx',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "topics_retention_updated_at_id_idx"
      ON "topics" ("updated_at", "id")
      WHERE "status" IS NULL
         OR "status" IN ('active', 'completed', 'failed', 'archived', 'unread')`,
  },
  {
    name: 'platform_audit_exports_retention_sort_at_id_idx',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_exports_retention_sort_at_id_idx"
      ON "platform_audit_exports" ((coalesce("finished_at", "created_at")), "id")
      WHERE "storage_key" IS NOT NULL AND "status" IN ('completed', 'expired')`,
  },
  {
    name: 'platform_audit_exports_purge_outbox_updated_at_id_v2_idx',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_exports_purge_outbox_updated_at_id_v2_idx"
      ON "platform_audit_exports" ("updated_at", "id")
      WHERE "storage_key" IS NULL
        AND "status" IN ('expired', 'failed', 'cancelled')
        AND (
          coalesce("error"->>'purgeStorageKey', '') <> ''
          OR jsonb_typeof("error"->'purgeStorageKeys') = 'array'
        )`,
  },
  {
    name: 'platform_audit_exports_purge_status_deleting_idx',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_exports_purge_status_deleting_idx"
      ON "platform_audit_exports" ("id")
      WHERE coalesce("error"->>'purgeStatus', '') = 'deleting'`,
  },
  {
    name: 'platform_audit_exports_purge_storage_key_expr_v2_idx',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_exports_purge_storage_key_expr_v2_idx"
      ON "platform_audit_exports" ((coalesce("error"->>'purgeStorageKey', '')))
      WHERE coalesce("error"->>'purgeStorageKey', '') <> ''
         OR (
           jsonb_typeof("error"->'purgeStorageKeys') = 'array'
           AND jsonb_array_length("error"->'purgeStorageKeys') > 0
         )`,
  },
] as const;

const readIndexState = async (client: PoolClient, name: string) => {
  const result = await client.query<{ indisready: boolean; indisvalid: boolean }>(
    `SELECT candidate.indisready, candidate.indisvalid
     FROM pg_index candidate
     JOIN pg_class relation ON relation.oid = candidate.indexrelid
     WHERE relation.relname = $1`,
    [name],
  );
  return result.rows[0];
};

const predeploy = async () => {
  if (process.env.RETENTION_INDEX_PREDEPLOY_APPROVED !== '1') {
    throw new Error('RETENTION_INDEX_PREDEPLOY_APPROVED=1 is required');
  }
  const connectionString =
    process.env.TEST_SERVER_DB === '1' ? process.env.DATABASE_TEST_URL : process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`SET lock_timeout = '5s'`);
    await client.query(`SET statement_timeout = '30min'`);
    for (const index of indexes) {
      const existing = await readIndexState(client, index.name);
      if (existing && (!existing.indisready || !existing.indisvalid)) {
        throw new Error(`RETENTION_INVALID_EXISTING_INDEX:${index.name}`);
      }
      await client.query(index.statement);
      const ready = await readIndexState(client, index.name);
      if (!ready?.indisready || !ready.indisvalid) {
        throw new Error(`RETENTION_INDEX_NOT_READY:${index.name}`);
      }
      console.info(`Retention index ready: ${index.name}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
};

await predeploy();
