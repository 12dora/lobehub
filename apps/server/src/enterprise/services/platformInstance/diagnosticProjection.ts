import type { PlatformInstanceInventoryDiagnostic } from '@/database/repositories/platformInstance';
import type {
  PlatformConvergenceErrorCategory,
  PlatformConvergenceStatus,
  PlatformDomainTarget,
  PlatformInstanceDiagnostic,
  PlatformRevisionToken,
} from '@/server/enterprise/contracts/platformInstanceStatus';

type DomainState = PlatformInstanceInventoryDiagnostic['states'][number];

type DomainDiagnostic = PlatformInstanceDiagnostic['domains'][number];

export const tokensEqual = (
  left: PlatformRevisionToken | null,
  right: PlatformRevisionToken | null,
) => left?.kind === right?.kind && left?.value === right?.value;

export const safeErrorCategory = (
  value: string | null,
): PlatformConvergenceErrorCategory | null => {
  switch (value) {
    case 'cache_unavailable':
    case 'configuration_invalid':
    case 'database_unavailable':
    case 'instance_status_unavailable':
    case 'lkg_invalid':
    case 'lkg_unavailable':
    case 'load_failed':
    case 'secret_unavailable':
    case 'startup_unavailable': {
      return value;
    }
    default: {
      return value ? 'load_failed' : null;
    }
  }
};

export const resolvePlatformDomainStatus = (params: {
  invalidFallbackSource: boolean;
  loadedToken: PlatformRevisionToken | null;
  state: DomainState | undefined;
  target: PlatformDomainTarget;
}): PlatformConvergenceStatus => {
  const { target, state, invalidFallbackSource, loadedToken } = params;
  if (target.status === 'disabled') return 'disabled';
  if (target.loadMode === 'request_scoped') return 'not_applicable';
  if (target.status === 'unavailable') return 'unavailable';
  if (!state) return 'unreported';
  if (invalidFallbackSource) return 'unavailable';
  if (state.health === 'unavailable') return 'unavailable';
  if (state.health === 'degraded') return 'degraded';
  return tokensEqual(loadedToken, target.token) ? 'converged' : 'diverged';
};

export const projectDomainDiagnostic = (params: {
  invalidFallbackSource: boolean;
  loadedToken: PlatformRevisionToken | null;
  state: DomainState | undefined;
  status: PlatformConvergenceStatus;
  target: PlatformDomainTarget;
}): DomainDiagnostic => {
  const { target, state, status, invalidFallbackSource, loadedToken } = params;
  const unloaded = status === 'disabled' || status === 'not_applicable' || status === 'unreported';
  const suppressed = unloaded || status === 'unavailable';
  return {
    domain: target.domain,
    errorCategory:
      status === 'unavailable' || status === 'degraded'
        ? invalidFallbackSource
          ? 'configuration_invalid'
          : safeErrorCategory(state?.errorCategory ?? target.errorCategory)
        : null,
    loadedAt: unloaded ? null : (state?.loadedAt ?? null),
    loadedToken: suppressed ? null : loadedToken,
    loadMode: target.loadMode,
    source: suppressed ? 'unavailable' : (state?.source ?? 'unavailable'),
    status,
  };
};
