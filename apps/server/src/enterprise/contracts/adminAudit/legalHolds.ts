import { z } from 'zod';

import {
  ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  adminAuditCursorSchema,
  auditReasonSchema,
  dateInputSchema,
  idSchema,
  limitSchema,
  platformAuditLegalHoldScopeTypeSchema,
  platformAuditLegalHoldStatusSchema,
} from './common';

const scopeIdSchema = z.string().min(1).max(128);

const legalHoldGlobalScopeSchema = z.object({
  scopeId: z.null().optional(),
  scopeType: z.literal('global'),
});

const legalHoldEntityScopeSchema = <T extends 'session' | 'topic' | 'user' | 'workspace'>(
  scopeType: T,
) =>
  z.object({
    scopeId: scopeIdSchema,
    scopeType: z.literal(scopeType),
  });

/**
 * Create/list scope pairing as a discriminated union for precise typing.
 * Built without `.strict()` pairwise intersection (which rejects cross-object keys).
 */
export const adminAuditLegalHoldScopeInputSchema = z.discriminatedUnion('scopeType', [
  legalHoldGlobalScopeSchema,
  legalHoldEntityScopeSchema('user'),
  legalHoldEntityScopeSchema('session'),
  legalHoldEntityScopeSchema('topic'),
  legalHoldEntityScopeSchema('workspace'),
]);

/**
 * Enforce list-filter scope invariants when scopeType is set:
 * - global must not carry a nonempty ID
 * - non-global may omit scopeId (type-only filter is valid; model supports it)
 * - non-global must not carry an explicit null/empty scopeId (contradictory pair)
 *
 * Intentionally uses `=== null` (not `== null`) so omitted `undefined` is allowed
 * while explicit `null` is rejected for entity scopes. Create-hold validation stays
 * stricter via the discriminated-union schema (concrete id required for non-global).
 */
export const refineLegalHoldScopePair = (
  input: {
    scopeId?: string | null;
    scopeType: z.infer<typeof platformAuditLegalHoldScopeTypeSchema>;
  },
  ctx: z.RefinementCtx,
): void => {
  if (input.scopeType === 'global') {
    if (input.scopeId != null && input.scopeId !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scopeId must be null for global legal holds',
        path: ['scopeId'],
      });
    }
    return;
  }

  // Omitted scopeId (undefined) → type-only list filter, allowed.
  // Explicit null or empty → contradictory for non-global, reject.
  if (input.scopeId === null || input.scopeId === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopeId is required for legal hold scopeType=${input.scopeType}`,
      path: ['scopeId'],
    });
  }
};

const refineOptionalListScopePair = (
  input: {
    scopeId?: string | null;
    scopeType?: z.infer<typeof platformAuditLegalHoldScopeTypeSchema>;
  },
  ctx: z.RefinementCtx,
): void => {
  if (input.scopeType === undefined) return;
  refineLegalHoldScopePair({ scopeId: input.scopeId, scopeType: input.scopeType }, ctx);
};

const legalHoldCreateFields = {
  expiresAt: dateInputSchema.nullable().optional(),
  reason: auditReasonSchema,
} as const;

const withLegalHoldCreateFields = <T extends z.ZodRawShape>(scope: z.ZodObject<T>) =>
  scope.extend(legalHoldCreateFields).strict();

// ── legal holds ──────────────────────────────────────────────────────────────

export const adminAuditLegalHoldsListInputSchema = z
  .object({
    createdBy: z.string().min(1).max(128).optional(),
    cursor: adminAuditCursorSchema.optional(),
    limit: limitSchema,
    scopeId: scopeIdSchema.nullable().optional(),
    scopeType: platformAuditLegalHoldScopeTypeSchema.optional(),
    status: platformAuditLegalHoldStatusSchema.optional(),
  })
  .strict()
  .superRefine(refineOptionalListScopePair)
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  }));

export const adminAuditLegalHoldItemSchema = z
  .object({
    createdAt: z.date(),
    createdBy: z.string(),
    expiresAt: z.date().nullable(),
    id: z.string(),
    reason: z.string(),
    releaseReason: z.string().nullable(),
    releasedAt: z.date().nullable(),
    releasedBy: z.string().nullable(),
    scopeId: z.string().nullable(),
    scopeType: platformAuditLegalHoldScopeTypeSchema,
    status: platformAuditLegalHoldStatusSchema,
    updatedAt: z.date(),
  })
  .strict();

export const adminAuditLegalHoldsListOutputSchema = z
  .object({
    items: z.array(adminAuditLegalHoldItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminAuditLegalHoldsGetInputSchema = z
  .object({
    id: idSchema,
  })
  .strict();

export const adminAuditLegalHoldsGetOutputSchema = adminAuditLegalHoldItemSchema;

/**
 * Create contract built from the same scope discriminated-union variants so
 * invalid scopeType/scopeId pairs are rejected at the type and runtime levels.
 * Global scopeId is normalized to null on parse.
 */
export const adminAuditLegalHoldsCreateInputSchema = z
  .discriminatedUnion('scopeType', [
    withLegalHoldCreateFields(legalHoldGlobalScopeSchema),
    withLegalHoldCreateFields(legalHoldEntityScopeSchema('user')),
    withLegalHoldCreateFields(legalHoldEntityScopeSchema('session')),
    withLegalHoldCreateFields(legalHoldEntityScopeSchema('topic')),
    withLegalHoldCreateFields(legalHoldEntityScopeSchema('workspace')),
  ])
  .transform((input) => {
    if (input.scopeType === 'global') {
      return { ...input, scopeId: null };
    }
    return { ...input, scopeId: input.scopeId };
  });

export const adminAuditLegalHoldsCreateOutputSchema = adminAuditLegalHoldItemSchema;

export const adminAuditLegalHoldsReleaseInputSchema = z
  .object({
    id: idSchema,
    releaseReason: auditReasonSchema,
  })
  .strict();

export const adminAuditLegalHoldsReleaseOutputSchema = adminAuditLegalHoldItemSchema;

export type AdminAuditLegalHoldsListInputParsed = z.output<
  typeof adminAuditLegalHoldsListInputSchema
>;
/** Caller-facing create input (scopeId optional for global; required for entity scopes). */
export type AdminAuditLegalHoldsCreateInput = z.input<typeof adminAuditLegalHoldsCreateInputSchema>;
/** Post-parse create payload (global scopeId normalized to null). */
export type AdminAuditLegalHoldsCreateInputParsed = z.output<
  typeof adminAuditLegalHoldsCreateInputSchema
>;
export type AdminAuditLegalHoldsReleaseInput = z.infer<
  typeof adminAuditLegalHoldsReleaseInputSchema
>;
