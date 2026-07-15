import { index, integer, jsonb, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, updatedAt } from '../_helpers';
import type { PlatformResourceStatus } from './common';

export type PlatformManagedEnforcement = 'observe' | 'enforced' | 'disabled';

/**
 * Managed resource policies (M06). Empty shell in Migration 0.
 * One row per managed resource identity.
 */
export const platformManagedResourcePolicies = pgTable(
  'platform_managed_resource_policies',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformManagedResourcePolicies', 16))
      .primaryKey()
      .notNull(),

    /** Stable resource identity, e.g. `provider:openai` or `setting:general.language`. */
    resource: text('resource').notNull(),
    enforcement: varchar('enforcement', { length: 32 })
      .$type<PlatformManagedEnforcement>()
      .notNull()
      .default('observe'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    revision: integer('revision').notNull().default(0),
    status: varchar('status', { length: 32 })
      .$type<PlatformResourceStatus>()
      .notNull()
      .default('draft'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_managed_resource_policies_resource_unique').on(t.resource),
    index('platform_managed_resource_policies_status_idx').on(t.status),
  ],
);

export type PlatformManagedResourcePolicyItem = typeof platformManagedResourcePolicies.$inferSelect;
export type NewPlatformManagedResourcePolicy = typeof platformManagedResourcePolicies.$inferInsert;
