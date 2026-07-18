/**
 * Online predeploy for M10 PR-052 rollout expression indexes.
 *
 * `CREATE INDEX CONCURRENTLY` must run in autocommit mode, so this script intentionally uses a
 * single pg Client without BEGIN/COMMIT. Migration 0126 repeats idempotent non-concurrent forms for
 * fresh/small databases; after this predeploy they are no-ops.
 */
import { Pool, type PoolClient } from 'pg';

const indexes = [
  {
    name: 'platform_jobs_rollout_agent_id_id_idx',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_jobs_rollout_agent_id_id_idx"
     ON "platform_jobs" USING btree (("input"->'snapshot'->>'agentId'), "id")
     WHERE "type" = 'platform.agent.rollout.v1'`,
  },
  {
    name: 'platform_jobs_rollout_transition_parent_status_user_idx',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_jobs_rollout_transition_parent_status_user_idx"
     ON "platform_jobs" USING btree (("input"->>'parentJobId'), "status", ("input"->>'userId'))
     WHERE "type" = 'platform.agent.rollout.transition.v1'`,
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
  if (process.env.M10_ROLLOUT_INDEX_PREDEPLOY_APPROVED !== '1') {
    throw new Error('M10_ROLLOUT_INDEX_PREDEPLOY_APPROVED=1 is required');
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
      const existing = await readIndexState(client, index.name);
      if (existing && (!existing.indisready || !existing.indisvalid)) {
        throw new Error(`M10_INVALID_EXISTING_INDEX:${index.name}`);
      }
      await client.query(index.statement);
      const ready = await readIndexState(client, index.name);
      if (!ready?.indisready || !ready.indisvalid) {
        throw new Error(`M10_INDEX_NOT_READY:${index.name}`);
      }
      console.info(`M10 rollout index ready: ${index.name}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
};

await predeploy();
