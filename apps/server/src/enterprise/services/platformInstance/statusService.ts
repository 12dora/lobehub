import { createHash } from 'node:crypto';

import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, not, or, sql } from 'drizzle-orm';

import {
  PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT,
  PLATFORM_INSTANCE_STALE_AFTER_MS,
  PLATFORM_INSTANCE_STALE_DIAGNOSTIC_CANDIDATE_LIMIT,
  type PlatformInstanceInventoryCounts,
  type PlatformInstanceInventoryDiagnostic,
  type PlatformInstanceInventoryTarget,
  PlatformInstanceRepository,
  type PlatformInstanceRevisionInventoryCursor,
} from '@/database/repositories/platformInstance';
import {
  type PlatformIdentityProviderInstanceItem,
  platformIdentityProviderInstances,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import {
  PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS,
  PLATFORM_CONVERGENCE_DOMAINS,
  type PlatformConvergenceErrorCategory,
  type PlatformConvergenceStatus,
  type PlatformDomainConvergence,
  type PlatformDomainTarget,
  type PlatformInstanceDiagnostic,
  type PlatformInstanceStatusSnapshot,
  platformInstanceStatusSnapshotSchema,
  type PlatformRevisionToken,
} from '@/server/enterprise/contracts/platformInstanceStatus';

import {
  getIdentityProviderInstanceRegistrationState,
  getIdentityProviderProcessInstance,
} from '../identityProvider/instanceRegistry';
import {
  getIdentityProviderStartupArtifactHealth,
  type IdentityProviderStartupHealth,
} from '../identityProvider/startupArtifact';
import type { loadPublishedIdentityTarget } from '../identityProvider/systemService';
import { PlatformDomainTargetResolver } from './domainTargets';

const ZERO_COUNTS: PlatformInstanceInventoryCounts = {
  degraded: 0,
  diverged: 0,
  fresh: 0,
  matching: 0,
  stale: 0,
  unreported: 0,
};

interface IdentityInventory {
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

const tokensEqual = (left: PlatformRevisionToken | null, right: PlatformRevisionToken | null) =>
  left?.kind === right?.kind && left?.value === right?.value;

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

const safeErrorCategory = (value: string | null): PlatformConvergenceErrorCategory | null => {
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

const platformDiagnostic = (
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
      let status: PlatformConvergenceStatus;
      if (target.status === 'disabled') status = 'disabled';
      else if (target.loadMode === 'request_scoped') status = 'not_applicable';
      else if (target.status === 'unavailable') status = 'unavailable';
      else if (!state) status = 'unreported';
      else if (invalidFallbackSource) status = 'unavailable';
      else if (state.health === 'unavailable') status = 'unavailable';
      else if (state.health === 'degraded') status = 'degraded';
      else status = tokensEqual(loadedToken, target.token) ? 'converged' : 'diverged';
      return {
        domain: target.domain,
        errorCategory:
          status === 'unavailable' || status === 'degraded'
            ? invalidFallbackSource
              ? 'configuration_invalid'
              : safeErrorCategory(state?.errorCategory ?? target.errorCategory)
            : null,
        loadedAt:
          status === 'disabled' || status === 'not_applicable' || status === 'unreported'
            ? null
            : (state?.loadedAt ?? null),
        loadedToken:
          status === 'disabled' ||
          status === 'not_applicable' ||
          status === 'unreported' ||
          status === 'unavailable'
            ? null
            : loadedToken,
        loadMode: target.loadMode,
        source:
          status === 'disabled' ||
          status === 'not_applicable' ||
          status === 'unreported' ||
          status === 'unavailable'
            ? 'unavailable'
            : (state?.source ?? 'unavailable'),
        status,
      };
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

const identityDiagnostic = (
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

const sortDiagnostics = (diagnostics: PlatformInstanceDiagnostic[]) =>
  diagnostics.sort(
    (left, right) =>
      Number(isIssue(right)) - Number(isIssue(left)) ||
      right.lastHeartbeatAt.getTime() - left.lastHeartbeatAt.getTime() ||
      left.instanceId.localeCompare(right.instanceId),
  );

/** Secret-free, read-only projection over platform and OIDC startup inventories. */
export class PlatformInstanceStatusService {
  private readonly env: Record<string, string | undefined>;
  private readonly options: Required<
    Pick<
      PlatformInstanceStatusServiceOptions,
      'getIdentityArtifact' | 'getIdentityProcess' | 'getIdentityRegistrationState'
    >
  > &
    PlatformInstanceStatusServiceOptions;

  constructor(
    private readonly db: LobeChatDatabase,
    options: PlatformInstanceStatusServiceOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.options = {
      ...options,
      getIdentityArtifact: options.getIdentityArtifact ?? getIdentityProviderStartupArtifactHealth,
      getIdentityProcess: options.getIdentityProcess ?? getIdentityProviderProcessInstance,
      getIdentityRegistrationState:
        options.getIdentityRegistrationState ?? getIdentityProviderInstanceRegistrationState,
    };
  }

  private readIdentityInventory = async (
    tx: Transaction,
    target: PlatformDomainTarget,
    snapshotAt: Date,
  ): Promise<IdentityInventory> => {
    if (target.status === 'disabled') {
      return { counts: ZERO_COUNTS, freshCandidates: [], staleCandidates: [] };
    }
    const cutoff = new Date(snapshotAt.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
    const local = this.options.getIdentityProcess();
    const artifact = this.options.getIdentityArtifact();
    const registrationState = this.options.getIdentityRegistrationState();
    const [localRow] = await tx
      .select()
      .from(platformIdentityProviderInstances)
      .where(eq(platformIdentityProviderInstances.instanceId, local.instanceId))
      .limit(1);
    const registrationFailed =
      registrationState === 'failed' || (!localRow && registrationState !== 'registered');
    const localDiagnostic = artifact
      ? identityDiagnostic(
          {
            activeIdentityRevision: artifact.identityRevision,
            degradedCategory: null,
            health: registrationFailed ? 'degraded' : artifact.health,
            instanceId: local.instanceId,
            lastHeartbeat: snapshotAt,
            loadedAt: artifact.loadedAt,
            startedAt: local.startedAt,
            startupSource: artifact.source,
          },
          target,
          registrationFailed,
        )
      : null;
    const targetRevision = target.token?.kind === 'immutable_id' ? target.token.value : null;
    const matches = targetRevision
      ? eq(platformIdentityProviderInstances.activeIdentityRevision, targetRevision)
      : isNull(platformIdentityProviderInstances.activeIdentityRevision);
    const fallback = inArray(platformIdentityProviderInstances.startupSource, [
      'break_glass',
      'lkg',
    ]);
    const remote = and(ne(platformIdentityProviderInstances.instanceId, local.instanceId));
    const fresh = and(remote, gte(platformIdentityProviderInstances.lastHeartbeat, cutoff));
    const stale = and(remote, lt(platformIdentityProviderInstances.lastHeartbeat, cutoff));
    const [aggregate] = await tx
      .select({
        degraded: sql<number>`count(*) filter (where ${platformIdentityProviderInstances.health} = 'degraded' or ${fallback})`,
        diverged: sql<number>`count(*) filter (where ${platformIdentityProviderInstances.health} = 'healthy' and not (${fallback}) and not (${matches}))`,
        fresh: count(),
        matching: sql<number>`count(*) filter (where ${platformIdentityProviderInstances.health} = 'healthy' and not (${fallback}) and ${matches})`,
      })
      .from(platformIdentityProviderInstances)
      .where(fresh);
    const [staleAggregate] = await tx
      .select({ count: count() })
      .from(platformIdentityProviderInstances)
      .where(stale);
    const issueRows = await tx
      .select()
      .from(platformIdentityProviderInstances)
      .where(
        and(
          fresh,
          or(eq(platformIdentityProviderInstances.health, 'degraded'), fallback, not(matches)),
        ),
      )
      .orderBy(
        desc(platformIdentityProviderInstances.lastHeartbeat),
        asc(platformIdentityProviderInstances.instanceId),
      )
      .limit(PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT);
    const baselineRows = await tx
      .select()
      .from(platformIdentityProviderInstances)
      .where(fresh)
      .orderBy(
        desc(platformIdentityProviderInstances.lastHeartbeat),
        asc(platformIdentityProviderInstances.instanceId),
      )
      .limit(PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT);
    const staleRows = await tx
      .select()
      .from(platformIdentityProviderInstances)
      .where(stale)
      .orderBy(
        desc(platformIdentityProviderInstances.lastHeartbeat),
        asc(platformIdentityProviderInstances.instanceId),
      )
      .limit(PLATFORM_INSTANCE_STALE_DIAGNOSTIC_CANDIDATE_LIMIT);
    const freshRows = [...issueRows, ...baselineRows].filter(
      (row, index, all) =>
        all.findIndex(({ instanceId }) => instanceId === row.instanceId) === index,
    );
    const freshCandidates = [
      ...(localDiagnostic ? [localDiagnostic] : []),
      ...freshRows.map((row) => identityDiagnostic(row, target)),
    ];
    const localStatus = localDiagnostic?.domains[0]?.status;
    const localDegraded = localStatus === 'degraded' || localStatus === 'unavailable' ? 1 : 0;
    const localDiverged = localStatus === 'diverged' ? 1 : 0;
    const localMatching = localStatus === 'converged' ? 1 : 0;
    return {
      counts: {
        degraded: Number(aggregate?.degraded ?? 0) + localDegraded,
        diverged: Number(aggregate?.diverged ?? 0) + localDiverged,
        fresh: Number(aggregate?.fresh ?? 0) + Number(Boolean(localDiagnostic)),
        matching: Number(aggregate?.matching ?? 0) + localMatching,
        stale: Number(staleAggregate?.count ?? 0),
        unreported: 0,
      },
      freshCandidates,
      staleCandidates: staleRows.map((row) => identityDiagnostic(row, target)),
    };
  };

  /**
   * Build domain convergence rows from already-resolved targets + inventory
   * counts. Shared by getStatus and first-page inventory so summary + rows share
   * one target resolution.
   */
  private buildDomainConvergence = async (
    tx: Transaction,
    targets: PlatformDomainTarget[],
    snapshotAt: Date,
  ): Promise<PlatformDomainConvergence[]> => {
    const repository = new PlatformInstanceRepository(tx);
    const platformTargets: PlatformInstanceInventoryTarget[] = targets
      .filter(({ domain }) => domain !== 'identity')
      .map(({ domain, loadMode, status, token }) => ({ domain, loadMode, status, token }));
    const platform = await repository.getConvergenceInventorySnapshot(platformTargets, snapshotAt);
    const identityTarget = targets.find(({ domain }) => domain === 'identity')!;
    const identity = await this.readIdentityInventory(tx, identityTarget, snapshotAt);
    const platformCounts = new Map(platform.counts.map((row) => [row.domain, row.counts]));
    return projectDomainConvergence(targets, platformCounts, identity.counts);
  };

  getRevisionInventoryPage = async (input: {
    cursor?: PlatformInstanceRevisionInventoryBoundCursor;
    /** When true (first page), attach domain summary from the same transaction. */
    includeDomains?: boolean;
    limit?: number;
  }) =>
    this.db.transaction(async (tx) => {
      const targets = await new PlatformDomainTargetResolver(tx, {
        env: this.env,
        loadIdentityTarget: this.options.loadIdentityTarget,
      }).resolveAll();
      const targetRevision = fingerprintDomainTargets(targets);
      if (input.cursor?.targetRevision && input.cursor.targetRevision !== targetRevision) {
        throw new PlatformInstanceTargetRevisionMismatchError();
      }
      const repository = new PlatformInstanceRepository(tx);
      const page = await repository.listRevisionInventoryPage({
        cursor: input.cursor
          ? { instanceId: input.cursor.instanceId, lastHeartbeatAt: input.cursor.lastHeartbeatAt }
          : undefined,
        limit: input.limit,
      });
      const identityTarget = targets.find(({ domain }) => domain === 'identity')!;
      const cutoff = new Date(page.snapshotAt.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
      const domains =
        input.includeDomains === true
          ? await this.buildDomainConvergence(tx, targets, page.snapshotAt)
          : [];
      return {
        domains,
        items: page.items.map((item) => {
          const diagnostic =
            item.instanceKind === 'platform'
              ? platformDiagnostic({ instance: item.instance, states: item.states }, targets)
              : identityDiagnostic(item.instance, identityTarget);
          return { fresh: diagnostic.lastHeartbeatAt >= cutoff, item: diagnostic };
        }),
        nextCursor: page.nextCursor
          ? {
              instanceId: page.nextCursor.instanceId,
              lastHeartbeatAt: page.nextCursor.lastHeartbeatAt,
              targetRevision,
            }
          : null,
        snapshotAt: page.snapshotAt,
        targetRevision,
      };
    });

  getStatus = async (): Promise<PlatformInstanceStatusSnapshot> =>
    this.db.transaction(async (tx) => {
      const targets = await new PlatformDomainTargetResolver(tx, {
        env: this.env,
        loadIdentityTarget: this.options.loadIdentityTarget,
      }).resolveAll();
      const repository = new PlatformInstanceRepository(tx);
      const snapshotAt = await repository.readSnapshotAt();
      const platformTargets: PlatformInstanceInventoryTarget[] = targets
        .filter(({ domain }) => domain !== 'identity')
        .map(({ domain, loadMode, status, token }) => ({ domain, loadMode, status, token }));
      const platform = await repository.getConvergenceInventorySnapshot(
        platformTargets,
        snapshotAt,
      );
      const identityTarget = targets.find(({ domain }) => domain === 'identity')!;
      const identity = await this.readIdentityInventory(tx, identityTarget, snapshotAt);
      const platformCounts = new Map(platform.counts.map((row) => [row.domain, row.counts]));
      const domains: PlatformDomainConvergence[] = projectDomainConvergence(
        targets,
        platformCounts,
        identity.counts,
      );
      const freshDiagnostics = sortDiagnostics([
        ...platform.freshCandidates.map((diagnostic) => platformDiagnostic(diagnostic, targets)),
        ...identity.freshCandidates,
      ]).slice(0, 100);
      const recentStaleDiagnostics = [
        ...platform.staleCandidates.map((diagnostic) => platformDiagnostic(diagnostic, targets)),
        ...identity.staleCandidates,
      ]
        .sort(
          (left, right) =>
            right.lastHeartbeatAt.getTime() - left.lastHeartbeatAt.getTime() ||
            left.instanceId.localeCompare(right.instanceId),
        )
        .slice(0, 10);
      return platformInstanceStatusSnapshotSchema.parse({
        domains,
        freshDiagnostics,
        freshDiagnosticsTruncated: platform.freshCount + identity.counts.fresh > 100,
        recentStaleDiagnostics,
        snapshotAt,
        staleDiagnosticsTruncated: platform.staleCount + identity.counts.stale > 10,
      });
    });
}
