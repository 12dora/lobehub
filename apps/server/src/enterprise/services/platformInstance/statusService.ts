import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';

import {
  PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT,
  PLATFORM_INSTANCE_STALE_AFTER_MS,
  PLATFORM_INSTANCE_STALE_DIAGNOSTIC_CANDIDATE_LIMIT,
  type PlatformInstanceFreshness,
  type PlatformInstanceInventoryTarget,
  PlatformInstanceRepository,
} from '@/database/repositories/platformInstance';
import { platformIdentityProviderInstances } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import {
  type PlatformDomainConvergence,
  type PlatformDomainTarget,
  type PlatformInstanceStatusSnapshot,
  platformInstanceStatusSnapshotSchema,
} from '@/server/enterprise/contracts/platformInstanceStatus';

import {
  getIdentityProviderInstanceRegistrationState,
  getIdentityProviderProcessInstance,
} from '../identityProvider/instanceRegistry';
import { getIdentityProviderStartupArtifactHealth } from '../identityProvider/startupArtifact';
import { PlatformDomainTargetResolver } from './domainTargets';
import {
  fingerprintDomainTargets,
  identityDiagnostic,
  type IdentityInventory,
  platformDiagnostic,
  type PlatformInstanceRevisionInventoryBoundCursor,
  type PlatformInstanceStatusServiceOptions,
  PlatformInstanceTargetRevisionMismatchError,
  projectDomainConvergence,
  sortDiagnostics,
  ZERO_COUNTS,
} from './statusServiceProjection';

export {
  fingerprintDomainTargets,
  type PlatformInstanceRevisionInventoryBoundCursor,
  type PlatformInstanceStatusServiceOptions,
  PlatformInstanceTargetRevisionMismatchError,
  projectDomainConvergence,
} from './statusServiceProjection';

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
      ? sql<boolean>`${platformIdentityProviderInstances.activeIdentityRevision} is not distinct from ${targetRevision}`
      : isNull(platformIdentityProviderInstances.activeIdentityRevision);
    const mismatches = targetRevision
      ? sql<boolean>`${platformIdentityProviderInstances.activeIdentityRevision} is distinct from ${targetRevision}`
      : sql<boolean>`${platformIdentityProviderInstances.activeIdentityRevision} is not null`;
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
        diverged: sql<number>`count(*) filter (where ${platformIdentityProviderInstances.health} = 'healthy' and not (${fallback}) and ${mismatches})`,
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
          or(eq(platformIdentityProviderInstances.health, 'degraded'), fallback, mismatches),
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
    /** When true (first page), attach registry live/offline totals from the same snapshot. */
    includeCounts?: boolean;
    /** When true (first page), attach domain summary from the same transaction. */
    includeDomains?: boolean;
    limit?: number;
    /** Row filter; defaults to the complete registry history. */
    state?: PlatformInstanceFreshness;
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
      // One clock for the rows, the freshness filter and the totals.
      const snapshotAt = await repository.readSnapshotAt();
      const page = await repository.listRevisionInventoryPage({
        cursor: input.cursor
          ? { instanceId: input.cursor.instanceId, lastHeartbeatAt: input.cursor.lastHeartbeatAt }
          : undefined,
        freshness: input.state ?? 'all',
        limit: input.limit,
        snapshotAt,
      });
      const identityTarget = targets.find(({ domain }) => domain === 'identity')!;
      const cutoff = new Date(page.snapshotAt.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
      const counts =
        input.includeCounts === true
          ? await repository.countInstancesByFreshness(page.snapshotAt)
          : null;
      const domains =
        input.includeDomains === true
          ? await this.buildDomainConvergence(tx, targets, page.snapshotAt)
          : [];
      return {
        counts,
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
