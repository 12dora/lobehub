import { Buffer } from 'node:buffer';

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
import { getRedisConfig } from '@/envs/redis';
import { createRedisWithPrefix, isRedisEnabled } from '@/libs/redis/manager';
import type { BaseRedisProvider, RedisConfig } from '@/libs/redis/types';
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
import { PlatformSecretService } from '../../security/secret';
import {
  PlatformAgentInvalidInputError,
  PlatformAgentRevisionConflictError,
} from '../agentCatalog/errors';
import {
  controlPlatformAgentRolloutJob,
  parsePlatformAgentRolloutInput,
  PLATFORM_AGENT_ROLLOUT_JOB_TYPE,
} from '../agentCatalog/rolloutService';
import { SHARED_OAUTH_KEEPALIVE_JOB_TYPE } from '../aiCatalog/sharedOAuthKeepalive';
import { SHARED_OAUTH_REFRESH_JOB_TYPE } from '../aiCatalog/sharedOAuthRefresh';
import { AUDIT_ACTION, type AuditAction } from '../audit/auditActionCatalog';
import { PLATFORM_AUDIT_EXPORT_JOB_TYPE } from '../audit/exportConstants';
import { PLATFORM_AUDIT_RETENTION_JOB_TYPE } from '../audit/retentionConstants';
import { OAUTH_REFRESH_JOB_TYPE } from '../connectorCatalog/connectorOAuthRefreshCoordinator';
import { CONNECTOR_RUNTIME_JOB_TYPE } from '../connectorCatalog/runtimeExecutionJournal';
import { CONNECTOR_SECRET_CLEANUP_JOB_TYPE } from '../connectorCatalog/secretCleanup';
import { getIdentityProviderStartupArtifactHealth } from '../identityProvider/startupArtifact';
import { IdentityProviderSystemService } from '../identityProvider/systemService';
import { PlatformAuditService } from '../platformAudit';
import {
  PlatformInstanceStatusService,
  PlatformInstanceTargetRevisionMismatchError,
} from '../platformInstance/statusService';
import {
  parsePlatformSecretRewrapInput,
  PLATFORM_SECRET_REWRAP_JOB_TYPE,
} from '../secretRewrap/contracts';
import { PlatformSecretRewrapCoordinator } from '../secretRewrap/coordinator';
import {
  PlatformSecretRewrapConflictError,
  PlatformSecretRewrapInvalidError,
} from '../secretRewrap/errors';
import {
  PlatformSystemJobConflictError,
  PlatformSystemJobInvalidError,
  PlatformSystemJobNotFoundError,
} from './errors';

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_INSTANCE_STATE: AdminSystemInstanceState = 'live';
/** Operator health treats publication failures in the last 24 hours as recent. */
export const RECENT_PUBLISH_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

type DependencyHealth = {
  errorCategory:
    'configuration_incomplete' | 'operation_unavailable' | 'passive_check_only' | 'timeout' | null;
  status: 'degraded' | 'disabled' | 'healthy' | 'unavailable' | 'unknown';
};

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

interface RedisHealthDependencies {
  createRedisWithPrefix: (config: RedisConfig, prefix: string) => Promise<BaseRedisProvider | null>;
  getRedisConfig: () => RedisConfig;
  isRedisEnabled: (config: RedisConfig) => boolean;
}

const defaultRedisHealthDependencies: RedisHealthDependencies = {
  createRedisWithPrefix,
  getRedisConfig,
  isRedisEnabled,
};

const disabledHealth = (): DependencyHealth => ({ errorCategory: null, status: 'disabled' });
const passiveHealth = (): DependencyHealth => ({
  errorCategory: 'passive_check_only',
  status: 'unknown',
});
const incompleteHealth = (): DependencyHealth => ({
  errorCategory: 'configuration_incomplete',
  status: 'degraded',
});

const probeRedis = async (dependencies: RedisHealthDependencies): Promise<DependencyHealth> => {
  const config = dependencies.getRedisConfig();
  if (!dependencies.isRedisEnabled(config)) return disabledHealth();
  let client: BaseRedisProvider | null = null;
  try {
    client = await dependencies.createRedisWithPrefix(config, 'platformSystemHealth');
    if (!client) return disabledHealth();
    return { errorCategory: null, status: 'healthy' };
  } catch (error) {
    return {
      errorCategory:
        error instanceof Error && /timeout/i.test(error.message)
          ? 'timeout'
          : 'operation_unavailable',
      status: 'unavailable',
    };
  } finally {
    if (client) await client.disconnect();
  }
};

const objectStorageHealth = (env: Record<string, string | undefined>): DependencyHealth => {
  const values = [env.S3_BUCKET, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY, env.S3_ENDPOINT];
  if (values.every((value) => !value?.trim())) return disabledHealth();
  if (
    !env.S3_BUCKET?.trim() ||
    !env.S3_ACCESS_KEY_ID?.trim() ||
    !env.S3_SECRET_ACCESS_KEY?.trim() ||
    (!env.S3_ENDPOINT?.trim() && !env.S3_REGION?.trim())
  ) {
    return incompleteHealth();
  }
  return passiveHealth();
};

const mailHealth = (env: Record<string, string | undefined>): DependencyHealth => {
  const provider = env.EMAIL_SERVICE_PROVIDER?.trim().toLowerCase();
  const configured = [
    provider,
    env.RESEND_API_KEY,
    env.RESEND_FROM,
    env.SMTP_FROM,
    env.SMTP_HOST,
  ].some((value) => value?.trim());
  if (!configured) return disabledHealth();
  if (provider === 'resend') {
    return env.RESEND_API_KEY?.trim() && env.RESEND_FROM?.trim()
      ? passiveHealth()
      : incompleteHealth();
  }
  if (provider === 'nodemailer') {
    return env.SMTP_HOST?.trim() && env.SMTP_FROM?.trim() ? passiveHealth() : incompleteHealth();
  }
  return incompleteHealth();
};

const keyManagementHealth = (env: Record<string, string | undefined>): DependencyHealth => {
  try {
    const service = PlatformSecretService.tryFromEnv(env);
    return service ? passiveHealth() : disabledHealth();
  } catch {
    return incompleteHealth();
  }
};

const encodeCursor = (value: Record<string, string>): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const decodeCursor = (cursor: string | undefined): Record<string, unknown> | null => {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const parseJobCursor = (cursor: string | undefined) => {
  if (!cursor) return undefined;
  const value = decodeCursor(cursor);
  const createdAt = typeof value?.createdAt === 'string' ? new Date(value.createdAt) : null;
  if (
    !createdAt ||
    Number.isNaN(createdAt.getTime()) ||
    typeof value?.id !== 'string' ||
    !/^pjob_[0-9A-Za-z]{16}$/.test(value.id)
  ) {
    throw new PlatformSystemJobInvalidError();
  }
  return { createdAt, id: value.id };
};

/**
 * Every queue type an operator can see in 近期任务. Missing entries render as
 * `unknown`, so `jobKindCoverage.test.ts` fails when a new queue forgets to register here.
 */
export const JOB_KIND_BY_TYPE: Readonly<Record<string, AdminSystemJob['kind']>> = {
  [CONNECTOR_RUNTIME_JOB_TYPE]: 'connector_runtime',
  [CONNECTOR_SECRET_CLEANUP_JOB_TYPE]: 'connector_secret_cleanup',
  [OAUTH_REFRESH_JOB_TYPE]: 'connector_oauth_refresh',
  [PLATFORM_AGENT_ROLLOUT_JOB_TYPE]: 'agent_rollout',
  [PLATFORM_AUDIT_EXPORT_JOB_TYPE]: 'audit_export',
  [PLATFORM_AUDIT_RETENTION_JOB_TYPE]: 'audit_retention',
  [PLATFORM_SECRET_REWRAP_JOB_TYPE]: 'secret_rewrap',
  [SHARED_OAUTH_KEEPALIVE_JOB_TYPE]: 'ai_oauth_keepalive',
  [SHARED_OAUTH_REFRESH_JOB_TYPE]: 'ai_oauth_refresh',
};

export const jobKind = (type: string): AdminSystemJob['kind'] =>
  JOB_KIND_BY_TYPE[type] ?? 'unknown';

/** Operational metadata only; a malformed stored type degrades to null instead of failing the page. */
const jobTypeId = (type: string): string | null => (/^[a-z0-9.-]{1,64}$/.test(type) ? type : null);

const projectJob = (job: {
  attempt: number;
  createdAt: Date;
  failedCount: number | null;
  finishedAt: Date | null;
  hasError: boolean;
  id: string;
  maxAttempts: number | null;
  progressDone: number;
  progressTotal: number | null;
  revision: number | null;
  startedAt: Date | null;
  status: PlatformJobItem['status'];
  type: string;
  updatedAt: Date;
}): AdminSystemJob => {
  const kind = jobKind(job.type);
  // Security invariant: only these two queues expose cancel / retry / revision. Adding a kind
  // to JOB_KIND_BY_TYPE must never widen the mutable surface.
  const supported = kind === 'agent_rollout' || kind === 'secret_rewrap';
  return {
    attempt: job.attempt,
    canCancel: supported && (job.status === 'pending' || job.status === 'running'),
    canRetry:
      (kind === 'agent_rollout' && ['cancelled', 'dead', 'failed'].includes(job.status)) ||
      (kind === 'secret_rewrap' && job.status === 'failed'),
    createdAt: job.createdAt,
    errorCategory:
      job.hasError || job.status === 'failed' || job.status === 'dead' ? 'operation_failed' : null,
    failedCount: job.failedCount,
    finishedAt: job.finishedAt,
    jobId: job.id,
    kind,
    maxAttempts: job.maxAttempts,
    progress: { done: job.progressDone, total: job.progressTotal },
    revision: supported ? job.revision : null,
    startedAt: job.startedAt,
    status: job.status,
    typeId: jobTypeId(job.type),
    updatedAt: job.updatedAt,
  };
};

const fullJobProjection = (job: PlatformJobItem): AdminSystemJob => {
  let revision: number | null = null;
  let failedCount: number | null = null;
  try {
    if (job.type === PLATFORM_AGENT_ROLLOUT_JOB_TYPE) {
      revision = parsePlatformAgentRolloutInput(job).control.revision;
    } else if (job.type === PLATFORM_SECRET_REWRAP_JOB_TYPE) {
      revision = parsePlatformSecretRewrapInput(job).control.revision;
    }
  } catch {
    revision = null;
  }
  const failed = job.resultSummary?.failed;
  if (typeof failed === 'number' && Number.isInteger(failed) && failed >= 0) failedCount = failed;
  return projectJob({
    ...job,
    failedCount,
    hasError: job.lastError !== null,
    revision,
  });
};

const publicationDomains = {
  // 平台助理 de-drafted: `.save` is the live write, `.publish` is kept so historical
  // failures still roll up into publish health.
  'admin.agents.publish': 'agent_catalog',
  'admin.agents.save': 'agent_catalog',
  'admin.aiProviders.publish': 'ai_catalog',
  // 品牌自定义 de-drafted: `.save` is the live write, `.publish` is kept so historical
  // failures still roll up into publish health.
  'admin.branding.publish': 'branding',
  'admin.branding.save': 'branding',
  'admin.connectors.publish': 'connector_catalog',
  'admin.identityProviders.publish': 'identity',
  // 统一管理 de-drafted: `.save` is the live write, `.publish` is kept so historical
  // failures still roll up into publish health.
  'admin.managedResources.publish': 'managed_policy',
  'admin.managedResources.save': 'managed_policy',
  'admin.settings.publish': 'settings',
  'admin.settings.save': 'settings',
  'admin.skills.publish': 'skill_catalog',
} as const;

const failureCategory = (value: unknown) => {
  if (typeof value !== 'string') return 'unknown' as const;
  if (value.includes('conflict')) return 'conflict' as const;
  if (value.includes('invalid') || value.includes('validation')) return 'validation' as const;
  if (value.includes('dependency')) return 'dependency_unavailable' as const;
  if (value.includes('unavailable') || value.includes('failed'))
    return 'operation_unavailable' as const;
  return 'unknown' as const;
};

const mutationFailureCategory = (error: unknown): string => {
  if (error instanceof PlatformSystemJobNotFoundError) return 'not_found';
  if (error instanceof PlatformSystemJobConflictError) return 'revision_conflict';
  if (error instanceof PlatformSystemJobInvalidError) return 'invalid_input';
  return 'operation_unavailable';
};

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
    // Fail closed: if the canonical ledger is unavailable, do not claim "active".
    const pendingRestart = authSnapshot
      ? authSnapshot.pendingRestart
      : Boolean(flags.ENABLE_DATABASE_OIDC && artifact);
    return {
      build: { gitSha, version: CURRENT_VERSION },
      dependencies: {
        database:
          databaseResult.status === 'fulfilled'
            ? ({ errorCategory: null, status: 'healthy' } as const)
            : ({ errorCategory: 'operation_unavailable', status: 'unavailable' } as const),
        keyManagement: keyManagementHealth(this.env),
        mail: mailHealth(this.env),
        objectStorage: objectStorageHealth(this.env),
        redis:
          redisResult.status === 'fulfilled'
            ? redisResult.value
            : ({ errorCategory: 'operation_unavailable', status: 'unavailable' } as const),
      },
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
      oidc: !flags.ENABLE_DATABASE_OIDC
        ? ({
            activeRevision: null,
            configured: false,
            pendingRestart: false,
            source: 'disabled',
            status: 'disabled',
          } as const)
        : artifact
          ? ({
              activeRevision: artifact.identityRevision,
              configured: true,
              pendingRestart,
              source: artifact.source,
              // Prefer artifact health when the ledger is available; mark unavailable
              // when the canonical restart status could not be loaded.
              status: authSnapshot ? artifact.health : ('unavailable' as const),
            } as const)
          : ({
              activeRevision: null,
              configured: true,
              pendingRestart: true,
              source: 'unknown',
              status: 'unavailable',
            } as const),
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
