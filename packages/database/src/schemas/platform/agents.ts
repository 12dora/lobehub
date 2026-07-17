import type {
  PlatformAgentAssignmentMode,
  PlatformAgentAssignmentTargetType,
  PlatformAgentDependencySnapshot,
  PlatformAgentVersionConfig,
  PlatformAgentVersionPolicy,
} from '@lobechat/types';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from '../_helpers';
import { agents } from '../agent';
import { users } from '../user';
import type { PlatformDistribution, PlatformResourceStatus } from './common';

/**
 * Platform Agent identity / system key (M10). Empty shell in Migration 0.
 * `system_key` is partially unique (non-null values only).
 */
export const platformAgents = pgTable(
  'platform_agents',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformAgents', 16))
      .primaryKey()
      .notNull(),

    agentKey: varchar('agent_key', { length: 128 }).notNull(),
    /** Stable system key e.g. `default-inbox`; partially unique when set. */
    systemKey: varchar('system_key', { length: 128 }),
    slug: varchar('slug', { length: 128 }),
    title: text('title').notNull(),
    description: text('description'),
    avatar: text('avatar'),
    backgroundColor: text('background_color'),
    tags: jsonb('tags').$type<string[]>().default([]),
    provider: text('provider'),
    model: text('model'),
    systemRole: text('system_role'),
    params: jsonb('params').$type<Record<string, unknown>>().default({}),
    plugins: jsonb('plugins').$type<unknown[]>().default([]),
    chatConfig: jsonb('chat_config').$type<Record<string, unknown>>().default({}),
    agencyConfig: jsonb('agency_config').$type<Record<string, unknown>>().default({}),
    openingMessage: text('opening_message'),
    openingQuestions: jsonb('opening_questions').$type<string[]>().default([]),
    distribution: varchar('distribution', { length: 32 })
      .$type<PlatformDistribution>()
      .notNull()
      .default('optional'),
    editPolicy: varchar('edit_policy', { length: 32 }).notNull().default('user_override'),
    deletePolicy: varchar('delete_policy', { length: 32 }).notNull().default('hideable'),
    pinPolicy: varchar('pin_policy', { length: 32 }).notNull().default('user'),
    isDefault: boolean('is_default').notNull().default(false),
    /** M01 shell rows are isolated until an administrator validates an exact M10 version. */
    migrationRequired: boolean('migration_required').notNull().default(false),
    /** @deprecated M01 compatibility pointer; M10 uses currentVersionId. */
    currentVersion: text('current_version'),
    /** Exact immutable published version. */
    currentVersionId: text('current_version_id'),
    status: varchar('status', { length: 32 })
      .$type<PlatformResourceStatus>()
      .notNull()
      .default('draft'),
    revision: integer('revision').notNull().default(0),
    /** Monotonic Draft CAS sequence, independent from published revision. */
    draftSequence: integer('draft_sequence').notNull().default(0),
    publishedAt: timestamptz('published_at'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_agents_agent_key_unique').on(t.agentKey),
    uniqueIndex('platform_agents_system_key_unique')
      .on(t.systemKey)
      .where(sql`${t.systemKey} is not null`),
    index('platform_agents_status_idx').on(t.status),
    index('platform_agents_distribution_idx').on(t.distribution),
    index('platform_agents_current_version_id_idx').on(t.currentVersionId),
    foreignKey({
      columns: [t.id, t.currentVersionId],
      foreignColumns: [platformAgentVersions.agentId, platformAgentVersions.id],
      name: 'platform_agents_current_version_same_agent_fk',
    }).onDelete('restrict'),
    check(
      'platform_agents_default_inbox_consistency_check',
      sql`(${t.isDefault} AND ${t.systemKey} = 'default-inbox')
        OR (NOT ${t.isDefault} AND ${t.systemKey} IS DISTINCT FROM 'default-inbox')`,
    ),
    check(
      'platform_agents_published_pointer_check',
      sql`${t.status} <> 'published'
        OR (NOT ${t.migrationRequired}
          AND ${t.currentVersionId} IS NOT NULL
          AND ${t.publishedAt} IS NOT NULL)`,
    ),
    check('platform_agents_revision_check', sql`${t.revision} >= 0 AND ${t.draftSequence} >= 0`),
  ],
);

export type PlatformAgentItem = typeof platformAgents.$inferSelect;
export type NewPlatformAgent = typeof platformAgents.$inferInsert;

/**
 * Immutable agent version snapshots (M10). Empty shell in Migration 0.
 */
export const platformAgentVersions = pgTable(
  'platform_agent_versions',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformAgentVersions', 16))
      .primaryKey()
      .notNull(),

    agentId: text('agent_id')
      .notNull()
      .references(() => platformAgents.id, { onDelete: 'restrict' }),
    version: text('version').notNull(),
    config: jsonb('config')
      .$type<PlatformAgentVersionConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** @deprecated M01 compatibility result; M10 uses the exact dependency snapshot. */
    dependencyCheck: jsonb('dependency_check').$type<Record<string, unknown>>(),
    dependencySnapshot: jsonb('dependency_snapshot').$type<PlatformAgentDependencySnapshot>(),
    /** SHA-256 over canonical config and dependencySnapshot. */
    checksum: varchar('checksum', { length: 64 }),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('platform_agent_versions_agent_id_version_unique').on(t.agentId, t.version),
    uniqueIndex('platform_agent_versions_agent_id_id_unique').on(t.agentId, t.id),
    uniqueIndex('platform_agent_versions_agent_id_id_checksum_unique').on(
      t.agentId,
      t.id,
      t.checksum,
    ),
    index('platform_agent_versions_agent_id_idx').on(t.agentId),
    check('platform_agent_versions_checksum_check', sql`${t.checksum} ~ '^[a-f0-9]{64}$'`),
    check(
      'platform_agent_versions_exact_snapshot_pair_check',
      sql`(${t.checksum} IS NULL AND ${t.dependencySnapshot} IS NULL)
        OR (${t.checksum} IS NOT NULL AND ${t.dependencySnapshot} IS NOT NULL)`,
    ),
  ],
);

export type PlatformAgentVersionItem = typeof platformAgentVersions.$inferSelect;
export type NewPlatformAgentVersion = typeof platformAgentVersions.$inferInsert;

/**
 * Agent assignments to users / roles / global (M10). Empty shell in Migration 0.
 * M10 database triggers enforce that role targets stay global and user targets
 * cannot become orphans even though one polymorphic target column stores both.
 */
export const platformAgentAssignments = pgTable(
  'platform_agent_assignments',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformAgentAssignments', 16))
      .primaryKey()
      .notNull(),

    agentId: text('agent_id')
      .notNull()
      .references(() => platformAgents.id, { onDelete: 'restrict' }),
    targetType: varchar('target_type', { length: 32 })
      .$type<PlatformAgentAssignmentTargetType>()
      .notNull(),
    targetId: text('target_id').notNull(),
    mode: varchar('mode', { length: 32 })
      .$type<PlatformAgentAssignmentMode>()
      .notNull()
      .default('optional'),
    versionPolicy: varchar('version_policy', { length: 32 })
      .$type<PlatformAgentVersionPolicy>()
      .notNull()
      .default('latest_published'),
    pinnedVersionId: text('pinned_version_id'),
    enabled: boolean('enabled').notNull().default(true),
    /** @deprecated M01 compatibility field; materialization has its own owner-scoped table. */
    materializedAgentId: text('materialized_agent_id'),
    installedVersion: text('installed_version'),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    userOverlay: jsonb('user_overlay').$type<Record<string, unknown>>(),
    lastSyncedAt: timestamptz('last_synced_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_agent_assignments_agent_target_unique').on(
      t.agentId,
      t.targetType,
      t.targetId,
    ),
    index('platform_agent_assignments_agent_id_idx').on(t.agentId),
    index('platform_agent_assignments_target_idx').on(t.targetType, t.targetId),
    index('platform_agent_assignments_status_idx').on(t.status),
    foreignKey({
      columns: [t.agentId, t.pinnedVersionId],
      foreignColumns: [platformAgentVersions.agentId, platformAgentVersions.id],
      name: 'platform_agent_assignments_pinned_version_same_agent_fk',
    }).onDelete('restrict'),
    check(
      'platform_agent_assignments_target_check',
      sql`(${t.targetType} = 'global' AND ${t.targetId} = '__global__')
        OR (${t.targetType} IN ('global_role', 'user')
          AND length(${t.targetId}) > 0
          AND ${t.targetId} <> '__global__')`,
    ),
    check(
      'platform_agent_assignments_mode_check',
      sql`${t.mode} IN ('mandatory', 'default', 'optional')`,
    ),
    check(
      'platform_agent_assignments_version_policy_check',
      sql`(${t.versionPolicy} = 'latest_published' AND ${t.pinnedVersionId} IS NULL)
        OR (${t.versionPolicy} = 'pinned' AND ${t.pinnedVersionId} IS NOT NULL)`,
    ),
  ],
);

export type PlatformAgentAssignmentItem = typeof platformAgentAssignments.$inferSelect;
export type NewPlatformAgentAssignment = typeof platformAgentAssignments.$inferInsert;

export type PlatformUserAgentMaterializationStatus = 'error' | 'materialized' | 'pending';

/**
 * Owner-scoped delayed materialization state. The assignment remains shared;
 * per-user visibility and local Agent mapping live only in this table.
 * A database trigger verifies that a non-null local Agent belongs to userId.
 */
export const platformUserAgentMaterializations = pgTable(
  'platform_user_agent_materializations',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformUserAgentMaterializations', 16))
      .primaryKey()
      .notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platformAgentId: text('platform_agent_id')
      .notNull()
      .references(() => platformAgents.id, { onDelete: 'restrict' }),
    platformAgentVersionId: text('platform_agent_version_id').notNull(),
    platformAgentVersionChecksum: varchar('platform_agent_version_checksum', {
      length: 64,
    }).notNull(),
    /** Null until a feature actually needs a local user-owned Agent row. */
    materializedAgentId: text('materialized_agent_id').references((): AnyPgColumn => agents.id, {
      onDelete: 'restrict',
    }),
    hidden: boolean('hidden').notNull().default(false),
    status: varchar('status', { length: 32 })
      .$type<PlatformUserAgentMaterializationStatus>()
      .notNull()
      .default('pending'),
    lastError: text('last_error'),
    lastSyncedAt: timestamptz('last_synced_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_user_agent_materializations_user_agent_unique').on(
      t.userId,
      t.platformAgentId,
    ),
    uniqueIndex('platform_user_agent_materializations_local_agent_unique')
      .on(t.materializedAgentId)
      .where(sql`${t.materializedAgentId} is not null`),
    index('platform_user_agent_materializations_user_id_idx').on(t.userId),
    index('platform_user_agent_materializations_platform_agent_id_idx').on(t.platformAgentId),
    foreignKey({
      columns: [t.platformAgentId, t.platformAgentVersionId, t.platformAgentVersionChecksum],
      foreignColumns: [
        platformAgentVersions.agentId,
        platformAgentVersions.id,
        platformAgentVersions.checksum,
      ],
      name: 'platform_user_agent_materializations_exact_version_fk',
    }).onDelete('restrict'),
    check(
      'platform_user_agent_materializations_checksum_check',
      sql`${t.platformAgentVersionChecksum} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'platform_user_agent_materializations_status_check',
      sql`${t.status} IN ('pending', 'materialized', 'error')`,
    ),
    check(
      'platform_user_agent_materializations_local_status_check',
      sql`(${t.status} = 'materialized' AND ${t.materializedAgentId} IS NOT NULL)
        OR (${t.status} <> 'materialized')`,
    ),
  ],
);

export type PlatformUserAgentMaterializationItem =
  typeof platformUserAgentMaterializations.$inferSelect;
export type NewPlatformUserAgentMaterialization =
  typeof platformUserAgentMaterializations.$inferInsert;
