import { sql } from 'drizzle-orm';
import {
  boolean,
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
    currentVersion: text('current_version'),
    status: varchar('status', { length: 32 })
      .$type<PlatformResourceStatus>()
      .notNull()
      .default('draft'),
    revision: integer('revision').notNull().default(0),
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
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    dependencyCheck: jsonb('dependency_check').$type<Record<string, unknown>>(),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('platform_agent_versions_agent_id_version_unique').on(t.agentId, t.version),
    index('platform_agent_versions_agent_id_idx').on(t.agentId),
  ],
);

export type PlatformAgentVersionItem = typeof platformAgentVersions.$inferSelect;
export type NewPlatformAgentVersion = typeof platformAgentVersions.$inferInsert;

/**
 * Agent assignments to users / roles / global (M10). Empty shell in Migration 0.
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
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: text('target_id').notNull(),
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
  ],
);

export type PlatformAgentAssignmentItem = typeof platformAgentAssignments.$inferSelect;
export type NewPlatformAgentAssignment = typeof platformAgentAssignments.$inferInsert;
