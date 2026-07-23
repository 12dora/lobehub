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

/** Single source of truth for every domain's operational contract. */
export const PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS = {
  agent_catalog: {
    fallbackPolicy: 'none',
    loadMode: 'request_scoped',
    tokenKind: 'immutable_id',
  },
  ai_catalog: {
    fallbackPolicy: 'none',
    loadMode: 'process_cached',
    tokenKind: 'immutable_id',
  },
  branding: {
    fallbackPolicy: 'builtin',
    loadMode: 'process_cached',
    tokenKind: 'revision',
  },
  connector_catalog: {
    fallbackPolicy: 'none',
    loadMode: 'request_scoped',
    tokenKind: 'immutable_id',
  },
  identity: {
    fallbackPolicy: 'lkg_then_break_glass',
    loadMode: 'restart_activated',
    tokenKind: 'immutable_id_or_null',
  },
  managed_policy: {
    fallbackPolicy: 'none',
    loadMode: 'request_scoped',
    tokenKind: 'revision',
  },
  settings: {
    fallbackPolicy: 'none',
    loadMode: 'process_cached',
    tokenKind: 'revision',
  },
  skill_catalog: {
    fallbackPolicy: 'none',
    loadMode: 'process_cached',
    tokenKind: 'immutable_id',
  },
} as const satisfies Record<
  (typeof PLATFORM_CONVERGENCE_DOMAINS)[number],
  {
    fallbackPolicy: (typeof PLATFORM_CONVERGENCE_FALLBACK_POLICIES)[number];
    loadMode: (typeof PLATFORM_CONVERGENCE_LOAD_MODES)[number];
    tokenKind: 'immutable_id' | 'immutable_id_or_null' | 'revision';
  }
>;

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

type RefinementContext = z.RefinementCtx;
type DomainMetadata = {
  domain: (typeof PLATFORM_CONVERGENCE_DOMAINS)[number];
  loadMode: (typeof PLATFORM_CONVERGENCE_LOAD_MODES)[number];
};

const addIssue = (context: RefinementContext, message: string, path: string[]): void => {
  context.addIssue({ code: z.ZodIssueCode.custom, message, path });
};

const validateDomainMetadata = (
  value: DomainMetadata & {
    fallbackPolicy?: (typeof PLATFORM_CONVERGENCE_FALLBACK_POLICIES)[number];
  },
  context: RefinementContext,
): void => {
  const descriptor = PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[value.domain];
  if (value.loadMode !== descriptor.loadMode) {
    addIssue(context, 'domain load mode does not match descriptor', ['loadMode']);
  }
  if (value.fallbackPolicy && value.fallbackPolicy !== descriptor.fallbackPolicy) {
    addIssue(context, 'domain fallback policy does not match descriptor', ['fallbackPolicy']);
  }
};

const validateDomainToken = (
  domain: DomainMetadata['domain'],
  token: z.infer<typeof platformRevisionTokenSchema> | null,
  context: RefinementContext,
  path: string,
  nullableIdentity: boolean,
): void => {
  const tokenKind = PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain].tokenKind;
  if (!token) {
    if (!(nullableIdentity && tokenKind === 'immutable_id_or_null')) {
      addIssue(context, 'domain requires its declared token kind', [path]);
    }
    return;
  }
  const expectedKind = tokenKind === 'immutable_id_or_null' ? 'immutable_id' : tokenKind;
  if (token.kind !== expectedKind) {
    addIssue(context, 'token kind does not match domain descriptor', [path]);
  }
};

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
    if (target.status === 'available') {
      validateDomainToken(target.domain, target.token, context, 'token', true);
    }
    if (target.status === 'unavailable' && !target.errorCategory) {
      addIssue(context, 'unavailable target requires error category', ['errorCategory']);
    }
    if (target.status !== 'unavailable' && target.errorCategory) {
      addIssue(context, 'only unavailable target may contain error category', ['errorCategory']);
    }
    if (target.status !== 'available' && target.token) {
      addIssue(context, 'non-available target cannot contain token', ['token']);
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
  .strict()
  .superRefine((domain, context) => {
    validateDomainMetadata(domain, context);
    if (domain.status === 'unavailable' && !domain.errorCategory) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unavailable domain requires error category',
        path: ['errorCategory'],
      });
    }
    if (domain.status !== 'unavailable' && domain.errorCategory) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only unavailable domain may contain error category',
        path: ['errorCategory'],
      });
    }
    if (
      (domain.status === 'disabled' ||
        domain.status === 'not_applicable' ||
        domain.status === 'unavailable') &&
      domain.targetToken
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'disabled or not-applicable domain cannot contain target token',
        path: ['targetToken'],
      });
    }
    const requestScoped =
      PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain.domain].loadMode === 'request_scoped';
    if (domain.status === 'not_applicable' && !requestScoped) {
      addIssue(context, 'only request-scoped domains may be not-applicable', ['status']);
    }
    if (
      requestScoped &&
      domain.status !== 'disabled' &&
      domain.status !== 'not_applicable' &&
      domain.status !== 'unavailable'
    ) {
      addIssue(context, 'request-scoped domain must be not-applicable', ['status']);
    }
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
    const descriptor = PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[diagnostic.domain];
    if (diagnostic.loadedToken) {
      validateDomainToken(diagnostic.domain, diagnostic.loadedToken, context, 'loadedToken', true);
    }
    const unloaded =
      diagnostic.status === 'disabled' ||
      diagnostic.status === 'not_applicable' ||
      diagnostic.status === 'unreported';
    if (unloaded) {
      if (diagnostic.loadedAt)
        addIssue(context, 'unloaded status cannot have loadedAt', ['loadedAt']);
      if (diagnostic.loadedToken) {
        addIssue(context, 'unloaded status cannot have loaded token', ['loadedToken']);
      }
      if (diagnostic.source !== 'unavailable') {
        addIssue(context, 'unloaded status requires unavailable source', ['source']);
      }
      if (diagnostic.errorCategory) {
        addIssue(context, 'unloaded status cannot have error category', ['errorCategory']);
      }
    }
    if (diagnostic.status === 'unavailable') {
      if (diagnostic.source !== 'unavailable') {
        addIssue(context, 'unavailable status requires unavailable source', ['source']);
      }
      if (!diagnostic.errorCategory) {
        addIssue(context, 'unavailable status requires error category', ['errorCategory']);
      }
      if (diagnostic.loadedToken) {
        addIssue(context, 'unavailable status cannot have loaded token', ['loadedToken']);
      }
    }
    if (diagnostic.status === 'converged') {
      if (!diagnostic.loadedAt)
        addIssue(context, 'converged status requires loadedAt', ['loadedAt']);
      if (diagnostic.source === 'unavailable') {
        addIssue(context, 'converged status requires an available source', ['source']);
      }
      if (diagnostic.errorCategory) {
        addIssue(context, 'converged status cannot have error category', ['errorCategory']);
      }
      validateDomainToken(diagnostic.domain, diagnostic.loadedToken, context, 'loadedToken', true);
    }
    if (diagnostic.status === 'diverged') {
      if (!diagnostic.loadedAt)
        addIssue(context, 'diverged status requires loadedAt', ['loadedAt']);
      if (diagnostic.source === 'unavailable') {
        addIssue(context, 'diverged status requires an available source', ['source']);
      }
      if (diagnostic.errorCategory) {
        addIssue(context, 'diverged status cannot have error category', ['errorCategory']);
      }
    }
    if (diagnostic.status === 'degraded') {
      if (!diagnostic.loadedAt)
        addIssue(context, 'degraded status requires loadedAt', ['loadedAt']);
      if (diagnostic.source === 'unavailable') {
        addIssue(context, 'degraded status requires an available source', ['source']);
      }
      if (!diagnostic.errorCategory) {
        addIssue(context, 'degraded status requires error category', ['errorCategory']);
      }
    }
    if (
      diagnostic.status !== 'degraded' &&
      diagnostic.status !== 'unavailable' &&
      diagnostic.errorCategory
    ) {
      addIssue(context, 'healthy diagnostic cannot contain error category', ['errorCategory']);
    }
    if (
      diagnostic.domain !== 'identity' &&
      (diagnostic.source === 'lkg' || diagnostic.source === 'break_glass')
    ) {
      addIssue(context, 'fallback startup sources are identity-only', ['source']);
    }
    if (diagnostic.domain === 'identity' && diagnostic.source === 'cache') {
      addIssue(context, 'identity startup cannot use cache source', ['source']);
    }
    if (
      diagnostic.domain === 'identity' &&
      (diagnostic.source === 'lkg' || diagnostic.source === 'break_glass') &&
      diagnostic.status !== 'degraded'
    ) {
      addIssue(context, 'identity fallback sources must be degraded', ['status']);
    }
    if (diagnostic.status === 'not_applicable' && descriptor.loadMode !== 'request_scoped') {
      addIssue(context, 'only request-scoped diagnostic may be not-applicable', ['status']);
    }
    if (
      descriptor.loadMode === 'request_scoped' &&
      diagnostic.status !== 'disabled' &&
      diagnostic.status !== 'not_applicable' &&
      diagnostic.status !== 'unavailable'
    ) {
      addIssue(context, 'request-scoped diagnostic must be not-applicable', ['status']);
    }
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
    if (instance.instanceKind === 'identity_startup') {
      if (instance.domains[0]?.domain !== 'identity') {
        addIssue(context, 'identity startup diagnostic requires exactly identity domain', [
          'domains',
        ]);
      }
      return;
    }
    const domains = instance.domains.map(({ domain }) => domain);
    if (domains.includes('identity')) {
      addIssue(context, 'platform diagnostic cannot contain identity domain', ['domains']);
    }
    if (new Set(domains).size !== domains.length) {
      addIssue(context, 'platform diagnostic domains must be unique', ['domains']);
    }
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
export type PlatformConvergenceStatus = z.infer<typeof platformConvergenceStatusSchema>;
export type PlatformDomainConvergence = z.infer<typeof platformDomainConvergenceSchema>;
export type PlatformDomainTarget = z.infer<typeof platformDomainTargetSchema>;
export type PlatformInstanceDiagnostic = z.infer<typeof platformInstanceDiagnosticSchema>;
export type PlatformInstanceStatusSnapshot = z.infer<typeof platformInstanceStatusSnapshotSchema>;
export type PlatformRevisionToken = z.infer<typeof platformRevisionTokenSchema>;
