import { CURRENT_VERSION } from '@lobechat/const';
import { and, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';

import { PlatformJobModel } from '@/database/models/platform';
import {
  PLATFORM_JOB_LEDGER_TYPES,
  platformAuditLogs,
  type PlatformJobItem,
  platformJobs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  AdminSystemCancelJobInput,
  AdminSystemGetInstanceRevisionsInput,
  AdminSystemGetJobsInput,
  AdminSystemInstanceState,
  AdminSystemJob,
  AdminSystemRetryJobInput,
} from '@/server/enterprise/contracts/adminSystem';
import type { PlatformConvergenceDomain } from '@/server/enterprise/contracts/platformInstanceStatus';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import {
  PlatformAgentInvalidInputError,
  PlatformAgentRevisionConflictError,
} from '../agentCatalog/errors';
import {
  controlPlatformAgentRolloutJob,
  PLATFORM_AGENT_ROLLOUT_JOB_TYPE,
} from '../agentCatalog/rolloutService';
import { AUDIT_ACTION, type AuditAction } from '../audit/auditActionCatalog';
import { getIdentityProviderStartupArtifactHealth } from '../identityProvider/startupArtifact';
import {
  IdentityProviderSystemService,
  loadPublishedIdentityTarget,
} from '../identityProvider/systemService';
import { PlatformAuditService } from '../platformAudit';
import {
  PlatformInstanceStatusService,
  PlatformInstanceTargetRevisionMismatchError,
} from '../platformInstance/statusService';
import { PLATFORM_SECRET_REWRAP_JOB_TYPE } from '../secretRewrap/contracts';
import { PlatformSecretRewrapCoordinator } from '../secretRewrap/coordinator';
import {
  PlatformSecretRewrapConflictError,
  PlatformSecretRewrapInvalidError,
} from '../secretRewrap/errors';
import { decodeCursor, encodeCursor, parseJobCursor } from './cursors';
import {
  PlatformSystemJobConflictError,
  PlatformSystemJobInvalidError,
  PlatformSystemJobNotFoundError,
} from './errors';
import { fullJobProjection, projectJob } from './jobProjection';
import {
  defaultRedisHealthDependencies,
  type DependencyHealth,
  failureCategory,
  mutationFailureCategory,
  probeRedis,
  projectDependencies,
  projectOidcStatus,
  publicationDomains,
  type RedisHealthDependencies,
} from './statusProjection';

export { JOB_KIND_BY_TYPE, jobKind } from './jobProjection';

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_INSTANCE_STATE: AdminSystemInstanceState = 'live';
/** Operator health treats publication failures in the last 24 hours as recent. */
export const RECENT_PUBLISH_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface PlatformSystemAdminServiceOptions {
  env?: Record<string, string | undefined>;
  jobSummary?: () => Promise<{ active: number; completed: number; failed: number; total: number }>;
  now?: () => Date;
  publishFailureSummary?: () => Promise<{
    count: number;
    errorCategory: null;
    items: {
      category:
        'conflict' | 'dependency_unavailable' | 'operation_unavailable' | 'unknown' | 'validation';
      domain: PlatformConvergenceDomain;
      occurredAt: Date;
    }[];
    status: 'healthy';
  }>;
  redisDependencies?: RedisHealthDependencies;
  redisProbe?: () => Promise<DependencyHealth>;
}

export class PlatformSystemAdminService {
  private readonly env: Record<string, string | undefined>;
  private readonly jobSummary: NonNullable<PlatformSystemAdminServiceOptions['jobSummary']>;
  private readonly now: () => Date;
  private readonly publishFailureSummary: NonNullable<
    PlatformSystemAdminServiceOptions['publishFailureSummary']
  >;
  private readonly redisProbe: NonNullable<PlatformSystemAdminServiceOptions['redisProbe']>;

  constructor(
    private readonly db: LobeChatDatabase,
    options: PlatformSystemAdminServiceOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.jobSummary = options.jobSummary ?? (() => new PlatformJobModel(this.db).getAdminSummary());
    this.now = options.now ?? (() => new Date());
    this.publishFailureSummary =
      options.publishFailureSummary ?? (() => this.getRecentPublishFailures());
    this.redisProbe =
      options.redisProbe ??
      (() => probeRedis(options.redisDependencies ?? defaultRedisHealthDependencies));
  }

  private appendFailureAudit = async (
    actorUserId: string,
    input: AdminSystemCancelJobInput | AdminSystemRetryJobInput,
    action: typeof AUDIT_ACTION.SYSTEM_JOBS_CANCEL | typeof AUDIT_ACTION.SYSTEM_JOBS_RETRY,
    error: unknown,
  ): Promise<void> => {
    try {
      await new PlatformAuditService(this.db).append({
        action,
        actorUserId,
        afterDiff: { error: mutationFailureCategory(error) },
        reason: input.reason,
        requestId: input.requestId,
        result: 'failure',
        targetId: input.jobId,
        targetType: 'platform_job',
      });
    } catch (auditError) {
      console.error('[admin.system.jobs] failure audit unavailable', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
  };

  private mutateJob = async (
    actorUserId: string,
    input: AdminSystemCancelJobInput | AdminSystemRetryJobInput,
    action: 'cancel' | 'retry',
  ): Promise<AdminSystemJob> => {
    const auditAction: AuditAction =
      action === 'cancel' ? AUDIT_ACTION.SYSTEM_JOBS_CANCEL : AUDIT_ACTION.SYSTEM_JOBS_RETRY;
    try {
      return await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(platformJobs)
          .where(
            and(
              eq(platformJobs.id, input.jobId),
              notInArray(platformJobs.type, [...PLATFORM_JOB_LEDGER_TYPES]),
            ),
          )
          .for('update')
          .limit(1);
        if (!current) throw new PlatformSystemJobNotFoundError();
        const updated = await this.controlKnownJob(tx, current, input, action);
        if (!updated) throw new PlatformSystemJobInvalidError();
        const projected = fullJobProjection(updated);
        await new PlatformAuditService(tx).append({
          action: auditAction,
          actorUserId,
          afterDiff: {
            jobId: projected.jobId,
            kind: projected.kind,
            revision: projected.revision,
            status: projected.status,
          },
          reason: input.reason,
          requestId: input.requestId,
          result: 'success',
          targetId: input.jobId,
          targetType: 'platform_job',
        });
        return projected;
      });
    } catch (error) {
      await this.appendFailureAudit(actorUserId, input, auditAction, error);
      throw error;
    }
  };

  private controlKnownJob = async (
    tx: Transaction,
    current: PlatformJobItem,
    input: AdminSystemCancelJobInput | AdminSystemRetryJobInput,
    action: 'cancel' | 'retry',
  ): Promise<PlatformJobItem> => {
    try {
      if (current.type === PLATFORM_AGENT_ROLLOUT_JOB_TYPE) {
        return await controlPlatformAgentRolloutJob(tx, {
          action,
          expectedRevision: input.expectedRevision,
          expectedStatus: input.expectedStatus,
          jobId: input.jobId,
        });
      }
      if (current.type !== PLATFORM_SECRET_REWRAP_JOB_TYPE) {
        throw new PlatformSystemJobInvalidError();
      }
      const coordinator = new PlatformSecretRewrapCoordinator();
      if (action === 'cancel') {
        if (input.expectedStatus !== 'pending' && input.expectedStatus !== 'running') {
          throw new PlatformSystemJobConflictError();
        }
        await coordinator.cancel(tx, {
          expectedRevision: input.expectedRevision,
          expectedStatus: input.expectedStatus,
          jobId: input.jobId,
        });
      } else {
        if (input.expectedStatus !== 'failed') throw new PlatformSystemJobConflictError();
        await coordinator.retry(tx, {
          expectedRevision: input.expectedRevision,
          expectedStatus: input.expectedStatus,
          jobId: input.jobId,
        });
      }
      const [updated] = await tx
        .select()
        .from(platformJobs)
        .where(eq(platformJobs.id, input.jobId))
        .limit(1);
      if (!updated) throw new PlatformSystemJobNotFoundError();
      return updated;
    } catch (error) {
      if (
        error instanceof PlatformAgentRevisionConflictError ||
        error instanceof PlatformSecretRewrapConflictError
      ) {
        throw new PlatformSystemJobConflictError();
      }
      if (
        error instanceof PlatformAgentInvalidInputError ||
        error instanceof PlatformSecretRewrapInvalidError
      ) {
        throw new PlatformSystemJobInvalidError();
      }
      throw error;
    }
  };

  cancelJob = async (actorUserId: string, input: AdminSystemCancelJobInput) =>
    this.mutateJob(actorUserId, input, 'cancel');

  getInstanceRevisions = async (input: AdminSystemGetInstanceRevisionsInput) => {
    const limit = Math.min(Math.max(Math.floor(input?.limit ?? DEFAULT_PAGE_SIZE), 1), 50);
    const state = input?.state ?? DEFAULT_INSTANCE_STATE;
    const cursor = decodeCursor(input?.cursor);
    const cursorHeartbeat =
      typeof cursor?.lastHeartbeatAt === 'string' ? new Date(cursor.lastHeartbeatAt) : null;
    const cursorTargetRevision =
      typeof cursor?.targetRevision === 'string' ? cursor.targetRevision : null;
    if (
      input?.cursor &&
      (!cursor ||
        typeof cursor.id !== 'string' ||
        !/^(?:oidci_|pinst_)[a-f0-9]{48}$/.test(cursor.id) ||
        !cursorHeartbeat ||
        Number.isNaN(cursorHeartbeat.getTime()) ||
        !cursorTargetRevision ||
        !/^[a-f0-9]{32}$/.test(cursorTargetRevision) ||
        // The cursor is bound to the filter it was issued for; switching filters mid-pagination
        // would otherwise splice rows from two different row sets into one list.
        cursor.state !== state)
    ) {
      throw new PlatformSystemJobInvalidError();
    }
    const statusService = new PlatformInstanceStatusService(this.db, {
      env: this.env,
    });
    // First page: inventory rows + domain summary share one target resolution
    // and one transaction. Later pages bind the cursor to that targetRevision so
    // a mid-pagination publish cannot mix rows evaluated against different targets.
    let page: Awaited<ReturnType<typeof statusService.getRevisionInventoryPage>>;
    try {
      page = await statusService.getRevisionInventoryPage({
        cursor:
          cursorHeartbeat && typeof cursor?.id === 'string' && cursorTargetRevision
            ? {
                instanceId: cursor.id,
                lastHeartbeatAt: cursorHeartbeat,
                targetRevision: cursorTargetRevision,
              }
            : undefined,
        includeCounts: !cursor,
        includeDomains: !cursor,
        limit,
        state,
      });
    } catch (error) {
      if (error instanceof PlatformInstanceTargetRevisionMismatchError) {
        throw new PlatformSystemJobInvalidError();
      }
      throw error;
    }
    return {
      counts: page.counts,
      domains: page.domains,
      items: page.items.map(({ fresh, item }) => ({
        domains: item.domains.map(({ errorCategory, ...domain }) => ({
          ...domain,
          lastErrorCategory: errorCategory,
        })),
        fresh,
        instanceId: item.instanceId,
        instanceKind: item.instanceKind,
        lagging: item.domains.some(({ status }) => status === 'diverged'),
        lastHeartbeatAt: item.lastHeartbeatAt,
        pendingRestart: item.domains.some(
          ({ domain, loadMode, status }) =>
            domain === 'identity' && loadMode === 'restart_activated' && status === 'diverged',
        ),
        startedAt: item.startedAt,
      })),
      nextCursor: page.nextCursor
        ? encodeCursor({
            id: page.nextCursor.instanceId,
            lastHeartbeatAt: page.nextCursor.lastHeartbeatAt.toISOString(),
            state,
            targetRevision: page.nextCursor.targetRevision,
          })
        : null,
      snapshotAt: page.snapshotAt,
      targetRevision: page.targetRevision,
    };
  };

  getJobs = async (input: AdminSystemGetJobsInput) => {
    const page = await new PlatformJobModel(this.db).listForAdmin({
      cursor: parseJobCursor(input?.cursor),
      limit: input?.limit,
    });
    return {
      items: page.items.map(projectJob),
      nextCursor: page.nextCursor
        ? encodeCursor({
            createdAt: page.nextCursor.createdAt.toISOString(),
            id: page.nextCursor.id,
          })
        : null,
    };
  };

  private getRecentPublishFailures = async () => {
    const since = new Date(this.now().getTime() - RECENT_PUBLISH_FAILURE_WINDOW_MS);
    const rows = await this.db
      .select({
        action: platformAuditLogs.action,
        afterDiff: platformAuditLogs.afterDiff,
        occurredAt: platformAuditLogs.createdAt,
        total: sql<number>`count(*) over()::int`,
      })
      .from(platformAuditLogs)
      .where(
        and(
          eq(platformAuditLogs.result, 'failure'),
          inArray(platformAuditLogs.action, Object.keys(publicationDomains)),
          gte(platformAuditLogs.createdAt, since),
        ),
      )
      .orderBy(desc(platformAuditLogs.createdAt), desc(platformAuditLogs.id))
      .limit(10);
    return {
      count: Number(rows[0]?.total ?? 0),
      errorCategory: null,
      items: rows.map((row) => ({
        category: failureCategory(row.afterDiff?.error),
        domain: publicationDomains[row.action as keyof typeof publicationDomains],
        occurredAt: row.occurredAt,
      })),
      status: 'healthy' as const,
    };
  };

  getStatus = async () => {
    const flags = parseEnterpriseFeatureFlags(this.env);
    const [
      databaseResult,
      instanceResult,
      jobsResult,
      redisResult,
      publishFailureResult,
      authSnapshotResult,
    ] = await Promise.allSettled([
      this.db.execute(sql`select 1`),
      new PlatformInstanceStatusService(this.db, { env: this.env }).getStatus(),
      this.jobSummary(),
      this.redisProbe(),
      this.publishFailureSummary(),
      // Canonical pending-restart ledger (includes environment-shadowed rows and
      // reconciliation). Do not re-derive pendingRestart from artifact ≠ target alone.
      flags.ENABLE_DATABASE_OIDC
        ? new IdentityProviderSystemService(
            this.db,
            undefined,
            this.now,
            undefined,
            this.env,
          ).getAuthSnapshotStatus()
        : Promise.resolve(null),
    ]);
    const instance = instanceResult.status === 'fulfilled' ? instanceResult.value : null;
    const rawGitSha = this.env.VERCEL_GIT_COMMIT_SHA ?? this.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
    const gitSha = rawGitSha && /^[a-f0-9]{7,40}$/.test(rawGitSha) ? rawGitSha : null;
    const artifact = flags.ENABLE_DATABASE_OIDC ? getIdentityProviderStartupArtifactHealth() : null;
    const authSnapshot =
      authSnapshotResult.status === 'fulfilled' ? authSnapshotResult.value : null;
    // Same published-selection as getAuthSnapshotStatus (live, enabled, not env-shadowed).
    let oidcConfiguredWithoutArtifact = false;
    if (flags.ENABLE_DATABASE_OIDC && !artifact) {
      try {
        const target = await loadPublishedIdentityTarget(this.db, this.env);
        oidcConfiguredWithoutArtifact = target.providers.length > 0;
      } catch {
        oidcConfiguredWithoutArtifact = false;
      }
    }
    return {
      build: { gitSha, version: CURRENT_VERSION },
      dependencies: projectDependencies({
        databaseResult,
        env: this.env,
        redisResult,
      }),
      domains: instance?.domains ?? [],
      featureFlags: {
        databaseOidc: flags.ENABLE_DATABASE_OIDC,
        managedAgents: flags.ENABLE_PLATFORM_MANAGED_AGENTS,
        managedAi: flags.ENABLE_PLATFORM_MANAGED_AI,
        managedConnectors: flags.ENABLE_PLATFORM_MANAGED_CONNECTORS,
        managedSkills: flags.ENABLE_PLATFORM_MANAGED_SKILLS,
        platformAdmin: flags.ENABLE_PLATFORM_ADMIN,
        runtimeBranding: flags.ENABLE_RUNTIME_BRANDING,
        settingsPolicy: flags.ENABLE_PLATFORM_SETTINGS_POLICY,
      },
      instanceStatus: instance
        ? ({ errorCategory: null, status: 'healthy' } as const)
        : ({ errorCategory: 'operation_unavailable', status: 'unavailable' } as const),
      jobs:
        jobsResult.status === 'fulfilled'
          ? { ...jobsResult.value, errorCategory: null, status: 'healthy' as const }
          : {
              active: 0,
              completed: 0,
              errorCategory: 'operation_unavailable' as const,
              failed: 0,
              status: 'unavailable' as const,
              total: 0,
            },
      oidc: projectOidcStatus({
        artifact,
        authSnapshot,
        flags,
        oidcConfiguredWithoutArtifact,
      }),
      recentPublishFailures:
        publishFailureResult.status === 'fulfilled'
          ? publishFailureResult.value
          : {
              count: 0,
              errorCategory: 'operation_unavailable' as const,
              items: [],
              status: 'unavailable' as const,
            },
      snapshotAt: this.now(),
    };
  };

  retryJob = async (actorUserId: string, input: AdminSystemRetryJobInput) =>
    this.mutateJob(actorUserId, input, 'retry');
}
