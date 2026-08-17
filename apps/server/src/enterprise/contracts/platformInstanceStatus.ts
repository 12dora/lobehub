import { z } from 'zod';

import {
  PLATFORM_CONVERGENCE_DOMAINS,
  PLATFORM_CONVERGENCE_FALLBACK_POLICIES,
  PLATFORM_CONVERGENCE_LOAD_MODES,
} from './platformInstanceStatus.descriptors';
import {
  checkConvergedDiagnostic,
  checkConvergenceStatus,
  checkDegradedDiagnostic,
  checkDivergedDiagnostic,
  checkIdentitySourceRules,
  checkInstanceDiagnosticDomains,
  checkRequestScopedStatus,
  checkSnapshotDomains,
  checkTargetStatus,
  checkUnavailableDiagnostic,
  checkUnloadedDiagnostic,
  validateDomainMetadata,
  validateDomainToken,
} from './platformInstanceStatus.refinements';

export {
  PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS,
  PLATFORM_CONVERGENCE_DOMAINS,
  PLATFORM_CONVERGENCE_FALLBACK_POLICIES,
  PLATFORM_CONVERGENCE_LOAD_MODES,
} from './platformInstanceStatus.descriptors';

export const PLATFORM_CONVERGENCE_STATUSES = [
  'disabled',
  'not_applicable',
  'converged',
  'diverged',
  'degraded',
  'unreported',
  'unavailable',
] as const;

export const PLATFORM_CONVERGENCE_SOURCES = [
  'cache',
  'database',
  'environment',
  'lkg',
  'break_glass',
  'unavailable',
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
    validateDomainMetadata(target, context);
    checkTargetStatus(target, context);
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
  .strict()
  .superRefine((domain, context) => {
    validateDomainMetadata(domain, context);
    checkConvergenceStatus(domain, context);
    checkRequestScopedStatus(domain, context, {
      mustBeNotApplicable: 'request-scoped domain must be not-applicable',
      notApplicable: 'only request-scoped domains may be not-applicable',
    });
    if (
      domain.status !== 'disabled' &&
      domain.status !== 'not_applicable' &&
      domain.status !== 'unavailable'
    ) {
      validateDomainToken(domain.domain, domain.targetToken, context, 'targetToken', true);
    }
  });

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
  .strict()
  .superRefine((diagnostic, context) => {
    validateDomainMetadata(diagnostic, context);
    if (diagnostic.loadedToken) {
      validateDomainToken(diagnostic.domain, diagnostic.loadedToken, context, 'loadedToken', true);
    }
    checkUnloadedDiagnostic(diagnostic, context);
    checkUnavailableDiagnostic(diagnostic, context);
    checkConvergedDiagnostic(diagnostic, context);
    checkDivergedDiagnostic(diagnostic, context);
    checkDegradedDiagnostic(diagnostic, context);
    checkIdentitySourceRules(diagnostic, context);
    checkRequestScopedStatus(diagnostic, context, {
      mustBeNotApplicable: 'request-scoped diagnostic must be not-applicable',
      notApplicable: 'only request-scoped diagnostic may be not-applicable',
    });
  });

const platformInstanceDiagnosticFields = {
  lastHeartbeatAt: z.date(),
  startedAt: z.date(),
};

export const platformInstanceDiagnosticSchema = z
  .discriminatedUnion('instanceKind', [
    z
      .object({
        ...platformInstanceDiagnosticFields,
        domains: z.array(platformInstanceDomainDiagnosticSchema).min(1).max(7),
        instanceId: z.string().regex(/^pinst_[a-f0-9]{48}$/),
        instanceKind: z.literal('platform'),
      })
      .strict(),
    z
      .object({
        ...platformInstanceDiagnosticFields,
        domains: z.array(platformInstanceDomainDiagnosticSchema).length(1),
        instanceId: z.string().regex(/^oidci_[a-f0-9]{48}$/),
        instanceKind: z.literal('identity_startup'),
      })
      .strict(),
  ])
  .superRefine((instance, context) => {
    checkInstanceDiagnosticDomains(instance, context);
  });

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
    checkSnapshotDomains(snapshot, context);
  });

export type PlatformConvergenceDomain = z.infer<typeof platformConvergenceDomainSchema>;
export type PlatformConvergenceErrorCategory = z.infer<
  typeof platformConvergenceErrorCategorySchema
>;
export type PlatformConvergenceFallbackPolicy = z.infer<
  typeof platformConvergenceFallbackPolicySchema
>;
export type PlatformConvergenceLoadMode = z.infer<typeof platformConvergenceLoadModeSchema>;
export type PlatformConvergenceStatus = z.infer<typeof platformConvergenceStatusSchema>;
export type PlatformDomainConvergence = z.infer<typeof platformDomainConvergenceSchema>;
export type PlatformDomainTarget = z.infer<typeof platformDomainTargetSchema>;
export type PlatformInstanceDiagnostic = z.infer<typeof platformInstanceDiagnosticSchema>;
export type PlatformInstanceStatusSnapshot = z.infer<typeof platformInstanceStatusSnapshotSchema>;
export type PlatformRevisionToken = z.infer<typeof platformRevisionTokenSchema>;
