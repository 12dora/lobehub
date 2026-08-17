import type { PlatformJobItem } from '@/database/schemas/platform';
import type { AdminSystemJob } from '@/server/enterprise/contracts/adminSystem';

import {
  parsePlatformAgentRolloutInput,
  PLATFORM_AGENT_ROLLOUT_JOB_TYPE,
} from '../agentCatalog/rolloutService';
import { SHARED_OAUTH_KEEPALIVE_JOB_TYPE } from '../aiCatalog/sharedOAuthKeepalive';
import { SHARED_OAUTH_REFRESH_JOB_TYPE } from '../aiCatalog/sharedOAuthRefresh';
import { PLATFORM_AUDIT_EXPORT_JOB_TYPE } from '../audit/exportConstants';
import { PLATFORM_AUDIT_RETENTION_JOB_TYPE } from '../audit/retentionConstants';
import { OAUTH_REFRESH_JOB_TYPE } from '../connectorCatalog/connectorOAuthRefreshCoordinator';
import { CONNECTOR_RUNTIME_JOB_TYPE } from '../connectorCatalog/runtimeExecutionJournal';
import { CONNECTOR_SECRET_CLEANUP_JOB_TYPE } from '../connectorCatalog/secretCleanup';
import {
  parsePlatformSecretRewrapInput,
  PLATFORM_SECRET_REWRAP_JOB_TYPE,
} from '../secretRewrap/contracts';

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

export const projectJob = (job: {
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

export const fullJobProjection = (job: PlatformJobItem): AdminSystemJob => {
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
