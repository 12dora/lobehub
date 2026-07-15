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
import { createdAt, updatedAt } from '../_helpers';
import type { PlatformDistribution, PlatformResourceStatus } from './common';

/**
 * Stable Skill identity (M08). Empty shell in Migration 0.
 */
export const platformSkills = pgTable(
  'platform_skills',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformSkills', 16))
      .primaryKey()
      .notNull(),

    skillKey: varchar('skill_key', { length: 128 }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    source: varchar('source', { length: 32 }).notNull().default('uploaded'),
    distribution: varchar('distribution', { length: 32 })
      .$type<PlatformDistribution>()
      .notNull()
      .default('optional'),
    enabled: boolean('enabled').notNull().default(false),
    currentVersion: text('current_version'),
    status: varchar('status', { length: 32 })
      .$type<PlatformResourceStatus>()
      .notNull()
      .default('draft'),
    revision: integer('revision').notNull().default(0),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().default({}),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_skills_skill_key_unique').on(t.skillKey),
    index('platform_skills_status_idx').on(t.status),
    index('platform_skills_enabled_idx').on(t.enabled),
  ],
);

export type PlatformSkillItem = typeof platformSkills.$inferSelect;
export type NewPlatformSkill = typeof platformSkills.$inferInsert;

/**
 * Immutable skill versions (M08). Empty shell in Migration 0.
 */
export const platformSkillVersions = pgTable(
  'platform_skill_versions',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformSkillVersions', 16))
      .primaryKey()
      .notNull(),

    skillId: text('skill_id')
      .notNull()
      .references(() => platformSkills.id, { onDelete: 'restrict' }),
    version: text('version').notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull().default({}),
    contentRef: text('content_ref'),
    zipHash: text('zip_hash'),
    validationResult: jsonb('validation_result').$type<Record<string, unknown>>(),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('platform_skill_versions_skill_id_version_unique').on(t.skillId, t.version),
    index('platform_skill_versions_skill_id_idx').on(t.skillId),
  ],
);

export type PlatformSkillVersionItem = typeof platformSkillVersions.$inferSelect;
export type NewPlatformSkillVersion = typeof platformSkillVersions.$inferInsert;
