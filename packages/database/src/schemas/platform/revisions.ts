import { index, integer, jsonb, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz } from '../_helpers';
import type { PlatformResourceType, PlatformRevisionStatus } from './common';

/**
 * Immutable snapshots for every platform publishable resource.
 * Runtime reads normalized current tables; this table powers rollback, diff, and audit.
 *
 * Uniqueness: (resource_type, resource_id, revision)
 * Published rows must never be updated in place — only new revisions may be appended.
 */
export const platformResourceRevisions = pgTable(
  'platform_resource_revisions',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformResourceRevisions', 16))
      .primaryKey()
      .notNull(),

    resourceType: varchar('resource_type', { length: 64 }).$type<PlatformResourceType>().notNull(),
    resourceId: text('resource_id').notNull(),

    /** Per-resource monotonically increasing revision number (optimistic lock target). */
    revision: integer('revision').notNull(),

    status: varchar('status', { length: 32 }).$type<PlatformRevisionStatus>().notNull(),

    /**
     * Redacted business payload snapshot. Secrets must never appear here —
     * store secret_ref / fingerprint / configured flags only.
     */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),

    /** SHA-256 hex checksum of the canonical JSON payload for integrity checks. */
    checksum: text('checksum').notNull(),

    /** Optional fingerprint of configured secrets (never the secret material). */
    secretFingerprint: text('secret_fingerprint'),

    comment: text('comment'),

    createdBy: text('created_by'),
    publishedBy: text('published_by'),

    createdAt: createdAt(),
    publishedAt: timestamptz('published_at'),
  },
  (t) => [
    uniqueIndex('platform_resource_revisions_type_id_revision_unique').on(
      t.resourceType,
      t.resourceId,
      t.revision,
    ),
    index('platform_resource_revisions_created_at_idx').on(t.createdAt),
    index('platform_resource_revisions_type_id_idx').on(t.resourceType, t.resourceId),
    index('platform_resource_revisions_status_idx').on(t.status),
  ],
);

export type PlatformResourceRevisionItem = typeof platformResourceRevisions.$inferSelect;
export type NewPlatformResourceRevision = typeof platformResourceRevisions.$inferInsert;
