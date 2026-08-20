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
 * Platform-managed agent templates ("助理模板") — the admin-owned source for the
 * create-agent modal example cards.
 *
 * Direct-save family (like `platform_task_templates`): no draft/publish, no
 * `platform_resource_revisions` row. `revision` is a per-row CAS token that the
 * model advances on every successful conditional update.
 *
 * Emptiness is meaningful: while the table has zero rows the product keeps using the
 * locale-driven built-in examples (`suggestQuestions:agent.NN.*`). As soon as one row
 * exists the platform list is authoritative and only `enabled` rows are served.
 */
export const platformAgentTemplates = pgTable(
  'platform_agent_templates',
  {
    id: text('id').primaryKey().notNull(),

    /** Stable slug; the upsert key for 导入内置示例 (`agent-01` … `agent-40`). */
    identifier: text('identifier').notNull(),

    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    avatar: text('avatar'),
    backgroundColor: text('background_color'),
    /** Prompt inserted into the create-agent ChatInput (today's `agent.NN.prompt`). */
    systemRole: text('system_role').notNull(),
    tags: jsonb('tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    enabled: boolean('enabled').notNull().default(true),
    /** Ascending display order; ties broken by `updatedAt` (newest first). */
    sortOrder: integer('sort_order').notNull().default(0),
    /** 'builtin' rows came from 导入内置示例; 'manual' rows were authored in the console. */
    source: text('source').notNull().default('manual'),

    /** Optimistic concurrency token; update requires expectedRevision match. */
    revision: integer('revision').notNull().default(0),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('platform_agent_templates_enabled_idx').on(t.enabled),
    uniqueIndex('platform_agent_templates_identifier_unique').on(t.identifier),
    index('platform_agent_templates_sort_idx').on(t.sortOrder),
    check('platform_agent_templates_revision_check', sql`${t.revision} >= 0`),
    check('platform_agent_templates_source_check', sql`${t.source} IN ('builtin', 'manual')`),
  ],
);

export type PlatformAgentTemplateItem = typeof platformAgentTemplates.$inferSelect;
export type NewPlatformAgentTemplate = typeof platformAgentTemplates.$inferInsert;
