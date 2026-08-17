import { z } from 'zod';

import {
  PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS,
  PLATFORM_CONVERGENCE_DOMAINS,
  type PLATFORM_CONVERGENCE_FALLBACK_POLICIES,
  type PLATFORM_CONVERGENCE_LOAD_MODES,
} from './platformInstanceStatus.descriptors';

type RefinementContext = z.RefinementCtx;
export type DomainMetadata = {
  domain: (typeof PLATFORM_CONVERGENCE_DOMAINS)[number];
  loadMode: (typeof PLATFORM_CONVERGENCE_LOAD_MODES)[number];
};

type DomainToken =
  { kind: 'immutable_id'; value: string } | { kind: 'revision'; value: number } | null;

type DomainDiagnostic = DomainMetadata & {
  errorCategory: string | null;
  loadedAt: Date | null;
  loadedToken: DomainToken;
  source: string;
  status: string;
};

type DomainTarget = DomainMetadata & {
  errorCategory: string | null;
  status: string;
  token: DomainToken;
};

type DomainConvergence = DomainMetadata & {
  errorCategory: string | null;
  status: string;
  targetToken: DomainToken;
};

export const addIssue = (context: RefinementContext, message: string, path: string[]): void => {
  context.addIssue({ code: z.ZodIssueCode.custom, message, path });
};

export const validateDomainMetadata = (
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

export const validateDomainToken = (
  domain: DomainMetadata['domain'],
  token: DomainToken,
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

export const checkTargetStatus = (target: DomainTarget, context: RefinementContext): void => {
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
};

export const checkConvergenceStatus = (
  domain: DomainConvergence,
  context: RefinementContext,
): void => {
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
};

export const checkUnloadedDiagnostic = (
  diagnostic: DomainDiagnostic,
  context: RefinementContext,
): void => {
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
};

export const checkUnavailableDiagnostic = (
  diagnostic: DomainDiagnostic,
  context: RefinementContext,
): void => {
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
};

export const checkConvergedDiagnostic = (
  diagnostic: DomainDiagnostic,
  context: RefinementContext,
): void => {
  if (diagnostic.status === 'converged') {
    if (!diagnostic.loadedAt) addIssue(context, 'converged status requires loadedAt', ['loadedAt']);
    if (diagnostic.source === 'unavailable') {
      addIssue(context, 'converged status requires an available source', ['source']);
    }
    if (diagnostic.errorCategory) {
      addIssue(context, 'converged status cannot have error category', ['errorCategory']);
    }
    validateDomainToken(diagnostic.domain, diagnostic.loadedToken, context, 'loadedToken', true);
  }
};

export const checkDivergedDiagnostic = (
  diagnostic: DomainDiagnostic,
  context: RefinementContext,
): void => {
  if (diagnostic.status === 'diverged') {
    if (!diagnostic.loadedAt) addIssue(context, 'diverged status requires loadedAt', ['loadedAt']);
    if (diagnostic.source === 'unavailable') {
      addIssue(context, 'diverged status requires an available source', ['source']);
    }
    if (diagnostic.errorCategory) {
      addIssue(context, 'diverged status cannot have error category', ['errorCategory']);
    }
  }
};

export const checkDegradedDiagnostic = (
  diagnostic: DomainDiagnostic,
  context: RefinementContext,
): void => {
  if (diagnostic.status === 'degraded') {
    if (!diagnostic.loadedAt) addIssue(context, 'degraded status requires loadedAt', ['loadedAt']);
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
};

export const checkIdentitySourceRules = (
  diagnostic: DomainDiagnostic,
  context: RefinementContext,
): void => {
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
};

export const checkRequestScopedStatus = (
  value: { domain: DomainMetadata['domain']; status: string },
  context: RefinementContext,
  messages: { mustBeNotApplicable: string; notApplicable: string },
): void => {
  const requestScoped =
    PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[value.domain].loadMode === 'request_scoped';
  if (value.status === 'not_applicable' && !requestScoped) {
    addIssue(context, messages.notApplicable, ['status']);
  }
  if (
    requestScoped &&
    value.status !== 'disabled' &&
    value.status !== 'not_applicable' &&
    value.status !== 'unavailable'
  ) {
    addIssue(context, messages.mustBeNotApplicable, ['status']);
  }
};

export const checkInstanceDiagnosticDomains = (
  instance: {
    domains: Array<{ domain: DomainMetadata['domain'] }>;
    instanceKind: 'identity_startup' | 'platform';
  },
  context: RefinementContext,
): void => {
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
};

export const checkSnapshotDomains = (
  snapshot: { domains: Array<{ domain: DomainMetadata['domain'] }> },
  context: RefinementContext,
): void => {
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
};
