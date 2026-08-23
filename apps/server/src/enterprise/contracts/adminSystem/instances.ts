import { z } from 'zod';

import {
  platformConvergenceDomainSchema,
  platformConvergenceErrorCategorySchema,
  platformConvergenceLoadModeSchema,
  platformConvergenceSourceSchema,
  platformConvergenceStatusSchema,
  platformDomainConvergenceSchema,
  platformRevisionTokenSchema,
} from '../platformInstanceStatus';
import { instanceIdSchema, paginationCursorSchema, paginationLimitSchema } from './common';

/**
 * Registry rows are process-registration history, not a live service list. `live` (the default)
 * hides processes whose heartbeat is older than the staleness window.
 */
export const adminSystemInstanceStateSchema = z.enum(['all', 'live', 'offline']);

export const adminSystemGetInstanceRevisionsInputSchema = z
  .object({
    cursor: paginationCursorSchema.optional(),
    limit: paginationLimitSchema.optional(),
    state: adminSystemInstanceStateSchema.optional(),
  })
  .strict()
  .optional();

const adminSystemInstanceDomainSchema = z
  .object({
    domain: platformConvergenceDomainSchema,
    lastErrorCategory: platformConvergenceErrorCategorySchema.nullable(),
    loadedAt: z.date().nullable(),
    loadedToken: platformRevisionTokenSchema.nullable(),
    loadMode: platformConvergenceLoadModeSchema,
    source: platformConvergenceSourceSchema,
    status: platformConvergenceStatusSchema,
  })
  .strict();

const platformInstanceIdSchema = z.union([
  z.string().regex(/^pinst_[a-f0-9]{48}$/),
  instanceIdSchema,
]);

export const adminSystemInstanceRevisionSchema = z
  .object({
    domains: z.array(adminSystemInstanceDomainSchema).min(1).max(7),
    fresh: z.boolean(),
    instanceId: platformInstanceIdSchema,
    instanceKind: z.enum(['identity_startup', 'platform']),
    lagging: z.boolean(),
    lastHeartbeatAt: z.date(),
    pendingRestart: z.boolean(),
    startedAt: z.date(),
  })
  .strict();

export const adminSystemGetInstanceRevisionsOutputSchema = z
  .object({
    /**
     * Registry totals evaluated against this page's snapshot clock, independent of the
     * `state` filter. Attached to the first page only (`null` on cursor pages).
     */
    counts: z
      .object({
        live: z.number().int().nonnegative(),
        offline: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    domains: z.array(platformDomainConvergenceSchema).max(8),
    items: z.array(adminSystemInstanceRevisionSchema).max(50),
    nextCursor: paginationCursorSchema.nullable(),
    snapshotAt: z.date(),
    /**
     * Fingerprint of the domain-target set used to evaluate this page.
     * Clients must not accumulate pages with differing targetRevision values.
     */
    targetRevision: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();

export type AdminSystemGetInstanceRevisionsInput = z.input<
  typeof adminSystemGetInstanceRevisionsInputSchema
>;
export type AdminSystemInstanceState = z.infer<typeof adminSystemInstanceStateSchema>;
