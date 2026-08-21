import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { createdAt, updatedAt } from '../_helpers';

/**
 * Connector requirement carried by a platform task template.
 * Shape mirrors `TaskTemplateConnector` in `@lobechat/const`; declared locally so the
 * drizzle schema directory stays free of cross-package type imports.
 */
export interface PlatformTaskTemplateConnector {
  identifier: string;
  required: boolean;
  source: 'composio' | 'lobehub';
}

/**
 * Platform-managed task templates ("任务模板") — the admin-owned source for the
 * home 为你推荐 cards and the agent-task empty state.
 *
 * Direct-save family (like `platform_sidebar_layout`): no draft/publish, no
 * `platform_resource_revisions` row. `revision` is a per-row CAS token that the
 * model advances on every successful conditional update.
 *
 * The catalog is platform-managed in every state. Built-in examples are auto-seeded as
 * real rows on first start (`platform_template_catalog_state`). An empty table after
 * that is a deliberate empty catalog — only `enabled` rows are served.
 */
export const platformTaskTemplates = pgTable(
  'platform_task_templates',
  {
    id: text('id').primaryKey().notNull(),

    /** Stable slug; the upsert key for 从推荐库导入 (market imports). */
    identifier: text('identifier').notNull(),

    category: text('category').notNull(),
    connectors: jsonb('connectors')
      .$type<PlatformTaskTemplateConnector[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    cronPattern: text('cron_pattern').notNull(),
    description: text('description').notNull().default(''),
    icon: text('icon'),
    instruction: text('instruction').notNull(),
    interests: jsonb('interests')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    title: text('title').notNull(),

    enabled: boolean('enabled').notNull().default(true),
    /** Ascending display order; ties broken by `updatedAt` (newest first). */
    sortOrder: integer('sort_order').notNull().default(0),
    /** 'market' rows came from 从推荐库导入; 'manual' rows were authored in the console. */
    source: text('source').notNull().default('manual'),

    /** Optimistic concurrency token; update requires expectedRevision match. */
    revision: integer('revision').notNull().default(0),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('platform_task_templates_enabled_idx').on(t.enabled),
    uniqueIndex('platform_task_templates_identifier_unique').on(t.identifier),
    index('platform_task_templates_sort_idx').on(t.sortOrder),
    check('platform_task_templates_revision_check', sql`${t.revision} >= 0`),
    check('platform_task_templates_source_check', sql`${t.source} IN ('market', 'manual')`),
  ],
);

export type PlatformTaskTemplateItem = typeof platformTaskTemplates.$inferSelect;
export type NewPlatformTaskTemplate = typeof platformTaskTemplates.$inferInsert;
