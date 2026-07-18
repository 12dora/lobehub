// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0126_m10_rollout_job_indexes';
const sql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const predeploy = readFileSync(
  path.join(
    import.meta.dirname,
    '../../../../../scripts/migrateServerDB/predeployM10RolloutIndexes.ts',
  ),
  'utf8',
);
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe('M10 rollout job indexes migration', () => {
  it('adds only bounded partial expression indexes with idempotent fallback', () => {
    expect(sql).not.toMatch(/\b(?:ALTER TABLE|DROP|RENAME)\b/i);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "platform_jobs_rollout_agent_id_id_idx"');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "platform_jobs_rollout_transition_parent_status_user_idx"',
    );
    expect(sql).toContain('WHERE "platform_jobs"."type" = \'platform.agent.rollout.v1\'');
    expect(sql).toContain(
      'WHERE "platform_jobs"."type" = \'platform.agent.rollout.transition.v1\'',
    );
  });

  it('provides an autocommit CONCURRENTLY predeploy for online production rollout', () => {
    expect(predeploy.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g)).toHaveLength(2);
    expect(predeploy).toContain('M10_ROLLOUT_INDEX_PREDEPLOY_APPROVED');
    expect(predeploy).toContain('indisready');
    expect(predeploy).toContain('indisvalid');
    expect(predeploy).not.toContain("client.query('BEGIN')");
    expect(predeploy).not.toContain("client.query('COMMIT')");
  });

  it('advances journal and snapshots exactly once to 0126', () => {
    expect(journal.entries).toHaveLength(127);
    expect(journal.entries.at(-1)).toMatchObject({ idx: 126, tag: migrationName });
    expect(
      readdirSync(path.join(migrations, 'meta')).filter((file) => file.endsWith('_snapshot.json')),
    ).toHaveLength(127);
  });
});
