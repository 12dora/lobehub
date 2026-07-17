import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from './agents';

const checkNames = (items: Array<{ name: string }>) => items.map((item) => item.name);
const foreignKeyNames = (items: Array<{ getName: () => string }>) =>
  items.map((item) => item.getName());
const indexNames = (items: Array<{ config: { name?: string } }>) =>
  items.map((item) => item.config.name);
const checkSql = (table: Parameters<typeof getTableConfig>[0], name: string) => {
  const item = getTableConfig(table).checks.find((check) => check.name === name);
  if (!item) throw new Error(`Missing check: ${name}`);
  return new PgDialect().sqlToQuery(item.value).sql;
};

describe('platform Agent persistence invariants', () => {
  it('pins a published identity to a version from the same Agent', () => {
    const config = getTableConfig(platformAgents);
    expect(foreignKeyNames(config.foreignKeys)).toContain(
      'platform_agents_current_version_same_agent_fk',
    );
    expect(indexNames(config.indexes)).toContain('platform_agents_current_version_id_idx');
    expect(checkNames(config.checks)).toEqual(
      expect.arrayContaining([
        'platform_agents_default_inbox_consistency_check',
        'platform_agents_published_pointer_check',
        'platform_agents_revision_check',
      ]),
    );
    expect(checkSql(platformAgents, 'platform_agents_published_pointer_check')).toMatch(
      /published.*migration_required.*current_version_id.*published_at/s,
    );
    const reference = config.foreignKeys
      .find((item) => item.getName() === 'platform_agents_current_version_same_agent_fk')
      ?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual(['id', 'current_version_id']);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual(['agent_id', 'id']);
  });

  it('keeps exact version fields paired while allowing isolated M01 legacy rows', () => {
    const config = getTableConfig(platformAgentVersions);
    expect(indexNames(config.indexes)).toEqual(
      expect.arrayContaining([
        'platform_agent_versions_agent_id_id_unique',
        'platform_agent_versions_agent_id_id_checksum_unique',
      ]),
    );
    expect(indexNames(config.indexes)).not.toContain('platform_agent_versions_checksum_idx');
    expect(
      checkSql(platformAgentVersions, 'platform_agent_versions_exact_snapshot_pair_check'),
    ).toMatch(/checksum.*dependency_snapshot.*NULL.*checksum.*dependency_snapshot.*NOT NULL/s);
  });

  it('enforces assignment target, mode, policy, and same-Agent pinned pointer shapes', () => {
    const config = getTableConfig(platformAgentAssignments);
    expect(foreignKeyNames(config.foreignKeys)).toContain(
      'platform_agent_assignments_pinned_version_same_agent_fk',
    );
    expect(checkNames(config.checks)).toEqual(
      expect.arrayContaining([
        'platform_agent_assignments_mode_check',
        'platform_agent_assignments_target_check',
        'platform_agent_assignments_version_policy_check',
      ]),
    );
    expect(checkSql(platformAgentAssignments, 'platform_agent_assignments_target_check')).toMatch(
      /global.*__global__.*global_role.*user/s,
    );
    const reference = config.foreignKeys
      .find((item) => item.getName() === 'platform_agent_assignments_pinned_version_same_agent_fk')
      ?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual([
      'agent_id',
      'pinned_version_id',
    ]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual(['agent_id', 'id']);
  });

  it('stores per-user materialization outside shared assignments with exact version identity', () => {
    const config = getTableConfig(platformUserAgentMaterializations);
    expect(indexNames(config.indexes)).toEqual(
      expect.arrayContaining([
        'platform_user_agent_materializations_local_agent_unique',
        'platform_user_agent_materializations_user_agent_unique',
      ]),
    );
    expect(foreignKeyNames(config.foreignKeys)).toEqual(
      expect.arrayContaining([
        'platform_user_agent_materializations_exact_version_fk',
        'platform_user_agent_materializations_materialized_agent_id_agents_id_fk',
      ]),
    );
    const reference = config.foreignKeys
      .find((item) => item.getName() === 'platform_user_agent_materializations_exact_version_fk')
      ?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual([
      'platform_agent_id',
      'platform_agent_version_id',
      'platform_agent_version_checksum',
    ]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual([
      'agent_id',
      'id',
      'checksum',
    ]);
  });
});
