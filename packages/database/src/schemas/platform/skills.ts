import {
  type AnyPgColumn,
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

export type PlatformSkillSource = 'builtin' | 'uploaded';

export interface PlatformSkillToolDependency {
  optional: boolean;
  toolKey: string;
}

export interface PlatformSkillDependency {
  optional: boolean;
  skillKey: string;
  version: string;
}

export interface PlatformSkillManifest {
  description: string;
  displayName: string;
  localizedDescriptions: Record<string, string>;
  localizedDisplayNames: Record<string, string>;
  permissions: {
    filesystem: 'none' | 'read';
    network: { allowedHosts: string[]; enabled: boolean };
    tools: { allow: string[] };
  };
  skillDependencies: PlatformSkillDependency[];
  toolDependencies: PlatformSkillToolDependency[];
}

export type PlatformSkillValidationIssueCode =
  | 'builtin_override_forbidden'
  | 'checksum_mismatch'
  | 'content_too_large'
  | 'dangerous_instruction'
  | 'dependency_cycle'
  | 'manifest_invalid'
  | 'permissions_invalid'
  | 'secret_material_detected'
  | 'unknown_skill_dependency'
  | 'unknown_tool_dependency'
  | 'version_conflict';

export interface PlatformSkillValidationIssue {
  code: PlatformSkillValidationIssueCode;
  message: string;
  path: Array<number | string>;
  severity: 'error' | 'warning';
}

export interface PlatformSkillValidationResult {
  issues: PlatformSkillValidationIssue[];
  validatedAt: string;
  validatorVersion: string;
}

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
    source: varchar('source', { length: 32 })
      .$type<PlatformSkillSource>()
      .notNull()
      .default('uploaded'),
    distribution: varchar('distribution', { length: 32 })
      .$type<PlatformDistribution>()
      .notNull()
      .default('optional'),
    /** Explicitly reviewed collision with a built-in Skill key. Hidden from public metadata. */
    allowBuiltinOverride: boolean('allow_builtin_override').notNull().default(false),
    enabled: boolean('enabled').notNull().default(false),
    /** Published pointer. Explicit historical versions remain resolvable after archive. */
    currentVersionId: text('current_version_id').references(
      (): AnyPgColumn => platformSkillVersions.id,
      { onDelete: 'restrict' },
    ),
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
    uniqueIndex('platform_skills_skill_key_unique').on(t.skillKey),
    index('platform_skills_status_idx').on(t.status),
    index('platform_skills_enabled_idx').on(t.enabled),
    index('platform_skills_distribution_idx').on(t.distribution),
    index('platform_skills_current_version_id_idx').on(t.currentVersionId),
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
    manifest: jsonb('manifest').$type<PlatformSkillManifest>().notNull(),
    /** Canonical UTF-8 Skill markdown/prompt. Immutable after insert. */
    content: text('content').notNull(),
    contentRef: text('content_ref'),
    /** SHA-256 over the canonical manifest and content payload. */
    checksum: text('checksum').notNull(),
    validationResult: jsonb('validation_result').$type<PlatformSkillValidationResult>(),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('platform_skill_versions_skill_id_version_unique').on(t.skillId, t.version),
    index('platform_skill_versions_skill_id_idx').on(t.skillId),
    index('platform_skill_versions_checksum_idx').on(t.checksum),
  ],
);

export type PlatformSkillVersionItem = typeof platformSkillVersions.$inferSelect;
export type NewPlatformSkillVersion = typeof platformSkillVersions.$inferInsert;
