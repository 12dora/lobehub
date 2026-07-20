import { z } from 'zod';

export const PLATFORM_CONVERGENCE_DOMAINS = [
  'agent_catalog',
  'ai_catalog',
  'branding',
  'connector_catalog',
  'identity',
  'managed_policy',
  'settings',
  'skill_catalog',
] as const;

export const PLATFORM_CONVERGENCE_STATUSES = [
  'disabled',
  'not_applicable',
  'converged',
  'diverged',
  'degraded',
  'unreported',
  'unavailable',
] as const;

export const PLATFORM_CONVERGENCE_LOAD_MODES = [
  'process_cached',
  'request_scoped',
  'restart_activated',
] as const;

export const PLATFORM_CONVERGENCE_SOURCES = [
  'cache',
  'database',
  'environment',
  'lkg',
  'break_glass',
  'unavailable',
] as const;

export const PLATFORM_CONVERGENCE_FALLBACK_POLICIES = [
  'none',
  'builtin',
  'lkg_then_break_glass',
] as const;

export const PLATFORM_CONVERGENCE_ERROR_CATEGORIES = [
  'cache_unavailable',
  'configuration_invalid',
  'database_unavailable',
  'instance_status_unavailable',
  'lkg_invalid',
  'lkg_unavailable',
  'load_failed',
  'secret_unavailable',
  'startup_unavailable',
] as const;

export const platformConvergenceDomainSchema = z.enum(PLATFORM_CONVERGENCE_DOMAINS);
export const platformConvergenceStatusSchema = z.enum(PLATFORM_CONVERGENCE_STATUSES);
export const platformConvergenceLoadModeSchema = z.enum(PLATFORM_CONVERGENCE_LOAD_MODES);
export const platformConvergenceSourceSchema = z.enum(PLATFORM_CONVERGENCE_SOURCES);
export const platformConvergenceFallbackPolicySchema = z.enum(
  PLATFORM_CONVERGENCE_FALLBACK_POLICIES,
);
export const platformConvergenceErrorCategorySchema = z.enum(PLATFORM_CONVERGENCE_ERROR_CATEGORIES);

export const platformRevisionTokenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revision'), value: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('immutable_id'), value: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);

export const platformDomainTargetSchema = z
  .object({
    domain: platformConvergenceDomainSchema,
    errorCategory: platformConvergenceErrorCategorySchema.nullable(),
    fallbackPolicy: platformConvergenceFallbackPolicySchema,
    loadMode: platformConvergenceLoadModeSchema,
    status: z.enum(['available', 'disabled', 'unavailable']),
    token: platformRevisionTokenSchema.nullable(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.status === 'available' && !target.token) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'available target requires token' });
    }
    if (target.status === 'unavailable' && !target.errorCategory) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unavailable target requires error category',
      });
    }
    if (target.status !== 'unavailable' && target.errorCategory) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only unavailable target may contain error category',
      });
    }
    if (target.status !== 'available' && target.token) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-available target cannot contain token',
      });
    }
  });

const platformDomainCountSchema = z
  .object({
    degraded: z.number().int().nonnegative(),
    diverged: z.number().int().nonnegative(),
    fresh: z.number().int().nonnegative(),
    matching: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    unreported: z.number().int().nonnegative(),
  })
  .strict();

export const platformDomainConvergenceSchema = z
  .object({
    counts: platformDomainCountSchema,
    domain: platformConvergenceDomainSchema,
    errorCategory: platformConvergenceErrorCategorySchema.nullable(),
    fallbackPolicy: platformConvergenceFallbackPolicySchema,
    loadMode: platformConvergenceLoadModeSchema,
    status: platformConvergenceStatusSchema,
    targetToken: platformRevisionTokenSchema.nullable(),
  })
  .strict();

const platformInstanceDomainDiagnosticSchema = z
  .object({
    domain: platformConvergenceDomainSchema,
    errorCategory: platformConvergenceErrorCategorySchema.nullable(),
    loadedAt: z.date().nullable(),
    loadedToken: platformRevisionTokenSchema.nullable(),
    loadMode: platformConvergenceLoadModeSchema,
    source: platformConvergenceSourceSchema,
    status: platformConvergenceStatusSchema,
  })
  .strict();

const platformInstanceDiagnosticFields = {
  domains: z.array(platformInstanceDomainDiagnosticSchema).max(PLATFORM_CONVERGENCE_DOMAINS.length),
  lastHeartbeatAt: z.date(),
  startedAt: z.date(),
};

export const platformInstanceDiagnosticSchema = z.discriminatedUnion('instanceKind', [
  z
    .object({
      ...platformInstanceDiagnosticFields,
      instanceId: z.string().regex(/^pinst_[a-f0-9]{48}$/),
      instanceKind: z.literal('platform'),
    })
    .strict(),
  z
    .object({
      ...platformInstanceDiagnosticFields,
      instanceId: z.string().regex(/^oidci_[a-f0-9]{48}$/),
      instanceKind: z.literal('identity_startup'),
    })
    .strict(),
]);

export const platformInstanceStatusSnapshotSchema = z
  .object({
    domains: z.array(platformDomainConvergenceSchema).length(PLATFORM_CONVERGENCE_DOMAINS.length),
    freshDiagnostics: z.array(platformInstanceDiagnosticSchema).max(100),
    freshDiagnosticsTruncated: z.boolean(),
    recentStaleDiagnostics: z.array(platformInstanceDiagnosticSchema).max(10),
    snapshotAt: z.date(),
    staleDiagnosticsTruncated: z.boolean(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const domains = new Set(snapshot.domains.map(({ domain }) => domain));
    if (
      domains.size !== PLATFORM_CONVERGENCE_DOMAINS.length ||
      PLATFORM_CONVERGENCE_DOMAINS.some((domain) => !domains.has(domain))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'snapshot must contain every domain exactly once',
        path: ['domains'],
      });
    }
  });

export type PlatformConvergenceDomain = z.infer<typeof platformConvergenceDomainSchema>;
export type PlatformConvergenceErrorCategory = z.infer<
  typeof platformConvergenceErrorCategorySchema
>;
export type PlatformConvergenceFallbackPolicy = z.infer<
  typeof platformConvergenceFallbackPolicySchema
>;
export type PlatformConvergenceLoadMode = z.infer<typeof platformConvergenceLoadModeSchema>;
export type PlatformConvergenceSource = z.infer<typeof platformConvergenceSourceSchema>;
export type PlatformConvergenceStatus = z.infer<typeof platformConvergenceStatusSchema>;
export type PlatformDomainConvergence = z.infer<typeof platformDomainConvergenceSchema>;
export type PlatformDomainTarget = z.infer<typeof platformDomainTargetSchema>;
export type PlatformInstanceDiagnostic = z.infer<typeof platformInstanceDiagnosticSchema>;
export type PlatformInstanceStatusSnapshot = z.infer<typeof platformInstanceStatusSnapshotSchema>;
export type PlatformRevisionToken = z.infer<typeof platformRevisionTokenSchema>;
