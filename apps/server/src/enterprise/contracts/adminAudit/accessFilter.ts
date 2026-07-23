import { z } from 'zod';

// ── stable filter summary for access logs (never free text / body) ───────────

export const adminAuditAccessFilterSummarySchema = z
  .object({
    actionPresent: z.boolean().optional(),
    actionsCount: z.number().int().nonnegative().optional(),
    actorUserIdPresent: z.boolean().optional(),
    cursorPresent: z.boolean().optional(),
    fromPresent: z.boolean().optional(),
    hasQ: z.boolean().optional(),
    includeBody: z.boolean().optional(),
    /** Structured export kind enum value only. */
    kind: z.string().optional(),
    limit: z.number().int().optional(),
    /** Structured retention mode enum value only. */
    mode: z.string().optional(),
    requestIdPresent: z.boolean().optional(),
    resultPresent: z.boolean().optional(),
    /** Structured retention scope enum value only. */
    scope: z.string().optional(),
    scopeType: z.string().optional(),
    /** Structured export/retention status enum value only. */
    status: z.string().optional(),
    targetIdPresent: z.boolean().optional(),
    targetTypePresent: z.boolean().optional(),
    toPresent: z.boolean().optional(),
    topicIdPresent: z.boolean().optional(),
    userIdPresent: z.boolean().optional(),
  })
  .strict();

export type AdminAuditAccessFilterSummary = z.infer<typeof adminAuditAccessFilterSummarySchema>;
