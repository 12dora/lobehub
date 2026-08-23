import { createHash } from 'node:crypto';

import type {
  PlatformInstanceInventoryCounts,
  PlatformInstanceInventoryDiagnostic,
} from '@/database/repositories/platformInstance';
import type { PlatformIdentityProviderInstanceItem } from '@/database/schemas/platform';
import {
  PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS,
  PLATFORM_CONVERGENCE_DOMAINS,
  type PlatformConvergenceErrorCategory,
  type PlatformConvergenceStatus,
  type PlatformDomainConvergence,
  type PlatformDomainTarget,
  type PlatformInstanceDiagnostic,
  type PlatformRevisionToken,
} from '@/server/enterprise/contracts/platformInstanceStatus';

import {
  projectDomainDiagnostic,
  resolvePlatformDomainStatus,
  safeErrorCategory,
  tokensEqual,
} from './diagnosticProjection';

export const ZERO_COUNTS: PlatformInstanceInventoryCounts = {
  degraded: 0,
  diverged: 0,
  fresh: 0,
  matching: 0,
  stale: 0,
  unreported: 0,
};

export interface IdentityInventory {
  counts: PlatformInstanceInventoryCounts;
  freshCandidates: PlatformInstanceDiagnostic[];
  staleCandidates: PlatformInstanceDiagnostic[];
}

export interface PlatformInstanceStatusServiceOptions {
  env?: Record<string, string | undefined>;
  getIdentityArtifact?: () => IdentityProviderStartupHealth | null;
  getIdentityProcess?: typeof getIdentityProviderProcessInstance;
  getIdentityRegistrationState?: typeof getIdentityProviderInstanceRegistrationState;
  loadIdentityTarget?: typeof loadPublishedIdentityTarget;
}

/** Cursor bound to the domain-target fingerprint that produced the page. */
export type PlatformInstanceRevisionInventoryBoundCursor =
  PlatformInstanceRevisionInventoryCursor & {
    targetRevision: string;
  };

/**
 * Thrown when a pagination cursor was issued against a different published
 * domain-target set than the one resolved for this request.
 */
export class PlatformInstanceTargetRevisionMismatchError extends Error {
  constructor() {
    super('PLATFORM_INSTANCE_TARGET_REVISION_MISMATCH');
    this.name = 'PlatformInstanceTargetRevisionMismatchError';
  }
}

/** Stable fingerprint of resolved domain targets for pagination binding. */
export const fingerprintDomainTargets = (targets: PlatformDomainTarget[]): string => {
  const payload = targets
    .map((target) =>
      [
        target.domain,
        target.status,
        target.token?.kind ?? '',
        String(target.token?.value ?? ''),
        target.errorCategory ?? '',
      ].join(':'),
    )
    .join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
};

const tokenFromState = (state: {
  loadedRevision: number | null;
  loadedRevisionId: string | null;
}): PlatformRevisionToken | null => {
  if (state.loadedRevision !== null && state.loadedRevisionId === null) {
    return { kind: 'revision', value: state.loadedRevision };
  }
  if (
    state.loadedRevision === null &&
    state.loadedRevisionId !== null &&
    /^[a-f0-9]{64}$/.test(state.loadedRevisionId)
  ) {
    return { kind: 'immutable_id', value: state.loadedRevisionId };
  }
  return null;
};

const tokenFitsDomain = (
  domain: PlatformDomainTarget['domain'],
  token: PlatformRevisionToken | null,
): token is PlatformRevisionToken => {
  if (!token) return false;
  const tokenKind = PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain].tokenKind;
  return token.kind === (tokenKind === 'immutable_id_or_null' ? 'immutable_id' : tokenKind);
};

const convergenceStatus = (
  target: PlatformDomainTarget,
  counts: PlatformInstanceInventoryCounts,
): PlatformConvergenceStatus => {
  if (target.status === 'disabled') return 'disabled';
  if (target.loadMode === 'request_scoped') return 'not_applicable';
  if (target.status === 'unavailable') return 'unavailable';
  if (counts.degraded > 0) return 'degraded';
  if (counts.diverged > 0) return 'diverged';
  if (counts.unreported > 0 || counts.fresh === 0) return 'unreported';
  return 'converged';
};

/**
 * Pure domain-convergence projection shared by getStatus and first-page inventory.
 * Callers supply already-resolved targets + inventory counts — no database I/O here.
 */
export const projectDomainConvergence = (
  targets: PlatformDomainTarget[],
  platformCounts: Map<string, PlatformInstanceInventoryCounts>,
  identityCounts: PlatformInstanceInventoryCounts,
): PlatformDomainConvergence[] =>
  PLATFORM_CONVERGENCE_DOMAINS.map((domain) => {
    const target = targets.find((candidate) => candidate.domain === domain)!;
    const counts =
      domain === 'identity' ? identityCounts : (platformCounts.get(domain) ?? ZERO_COUNTS);
    const status = convergenceStatus(target, counts);
    return {
      counts,
      domain,
      errorCategory: status === 'unavailable' ? target.errorCategory : null,
      fallbackPolicy: target.fallbackPolicy,
      loadMode: target.loadMode,
      status,
      targetToken: status === 'disabled' || status === 'not_applicable' ? null : target.token,
    };
  });

export const platformDiagnostic = (
  diagnostic: PlatformInstanceInventoryDiagnostic,
  targets: PlatformDomainTarget[],
): PlatformInstanceDiagnostic => ({
  domains: targets
    .filter(({ domain }) => domain !== 'identity')
    .map((target) => {
      const state = diagnostic.states.find(({ domain }) => domain === target.domain);
      const candidateToken = state ? tokenFromState(state) : null;
      const loadedToken = tokenFitsDomain(target.domain, candidateToken) ? candidateToken : null;
      const invalidFallbackSource = target.domain !== 'identity' && state?.source === 'lkg';
      const status = resolvePlatformDomainStatus({
        invalidFallbackSource,
        loadedToken,
        state,
        target,
      });
      return projectDomainDiagnostic({
        invalidFallbackSource,
        loadedToken,
        state,
        status,
        target,
      });
    }),
  instanceId: diagnostic.instance.instanceId,
  instanceKind: 'platform',
  lastHeartbeatAt: diagnostic.instance.lastHeartbeatAt,
  startedAt: diagnostic.instance.startedAt,
});

const identityErrorCategory = (input: {
  degradedCategory: string | null;
  registrationFailed?: boolean;
  source: PlatformIdentityProviderInstanceItem['startupSource'];
}): PlatformConvergenceErrorCategory | null => {
  if (input.registrationFailed) return 'instance_status_unavailable';
  if (input.source === 'lkg') return 'lkg_unavailable';
  if (input.source === 'break_glass') return 'startup_unavailable';
  return safeErrorCategory(input.degradedCategory);
};

export const identityDiagnostic = (
  row: Omit<PlatformIdentityProviderInstanceItem, 'hostnameHash' | 'startupGeneration'>,
  target: PlatformDomainTarget,
  registrationFailed = false,
): PlatformInstanceDiagnostic => {
  const loadedToken: PlatformRevisionToken | null = row.activeIdentityRevision
    ? /^[a-f0-9]{64}$/.test(row.activeIdentityRevision)
      ? { kind: 'immutable_id', value: row.activeIdentityRevision }
      : null
    : null;
  const fallback = row.startupSource === 'lkg' || row.startupSource === 'break_glass';
  const status: PlatformConvergenceStatus =
    target.status === 'disabled'
      ? 'disabled'
      : target.status === 'unavailable'
        ? 'unavailable'
        : registrationFailed
          ? 'unavailable'
          : row.health === 'degraded' || fallback
            ? 'degraded'
            : tokensEqual(loadedToken, target.token)
              ? 'converged'
              : 'diverged';
  return {
    domains: [
      {
        domain: 'identity',
        errorCategory:
          status === 'unavailable'
            ? registrationFailed
              ? 'instance_status_unavailable'
              : target.errorCategory
            : status === 'degraded'
              ? identityErrorCategory({
                  degradedCategory: row.degradedCategory,
                  registrationFailed,
                  source: row.startupSource,
                })
              : null,
        loadedAt: status === 'disabled' ? null : row.loadedAt,
        loadedToken: status === 'disabled' || status === 'unavailable' ? null : loadedToken,
        loadMode: 'restart_activated',
        source:
          status === 'disabled' || status === 'unavailable' ? 'unavailable' : row.startupSource,
        status,
      },
    ],
    instanceId: row.instanceId,
    instanceKind: 'identity_startup',
    lastHeartbeatAt: row.lastHeartbeat,
    startedAt: row.startedAt,
  };
};

const isIssue = (diagnostic: PlatformInstanceDiagnostic): boolean =>
  diagnostic.domains.some(
    ({ status }) =>
      status === 'degraded' ||
      status === 'diverged' ||
      status === 'unavailable' ||
      status === 'unreported',
  );

export const sortDiagnostics = (diagnostics: PlatformInstanceDiagnostic[]) =>
  diagnostics.sort(
    (left, right) =>
      Number(isIssue(right)) - Number(isIssue(left)) ||
      right.lastHeartbeatAt.getTime() - left.lastHeartbeatAt.getTime() ||
      left.instanceId.localeCompare(right.instanceId),
  );
