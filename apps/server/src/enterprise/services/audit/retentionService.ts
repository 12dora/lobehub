/**
 * Admin audit A3 retention orchestration (dryRun / run / listRuns / getRun / cancel).
 * Self-audits success/failure/denial without free text, bodies, or secrets.
 *
 * Scope `all` fans out into three persisted single-scope rows + jobs.
 * Partial fan-out is marked deterministically (never silent success).
 */

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import {
  PlatformAuditPolicyModel,
  type PlatformAuditRetentionCounts,
  type PlatformAuditRetentionMode,
  type PlatformAuditRetentionRunItem,
  PlatformAuditRetentionRunModel,
  type PlatformAuditRetentionScope,
  PlatformJobModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  AdminAuditRetentionCancelInput,
  AdminAuditRetentionCreateInput,
  AdminAuditRetentionListRunsInputParsed,
} from '../../contracts/adminAudit';
import { getEnterpriseErrorBody, throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import type { AuditExportArtifactStorage } from './exportStorage';
import { AuditExportPrivateS3Storage } from './exportStorage';
import {
  AUDIT_RETENTION_MAX_ATTEMPTS,
  AUDIT_RETENTION_STORED_SCOPES,
  buildAuditRetentionJobIdempotencyKey,
  PLATFORM_AUDIT_RETENTION_JOB_TYPE,
} from './retentionConstants';

const isDeniedError = (error: unknown): boolean => {
  const code = getEnterpriseErrorBody(error)?.code;
  return (
    code === PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED ||
    code === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED ||
    code === ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED ||
    code === ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED ||
    code === ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED
  );
};

const accessLogResultForError = (error: unknown): 'denied' | 'failure' =>
  isDeniedError(error) ? 'denied' : 'failure';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const emptyCounts = (): PlatformAuditRetentionCounts => ({});

export const toRetentionPublic = (row: PlatformAuditRetentionRunItem) => ({
  counts: row.counts ?? emptyCounts(),
  createdAt: row.createdAt,
  cutoffAt: row.cutoffAt,
  error: row.error,
  finishedAt: row.finishedAt,
  id: row.id,
  jobId: row.jobId,
  mode: row.mode,
  policyRevision: row.policyRevision,
  progressDone: row.progressDone,
  progressTotal: row.progressTotal,
  requestedBy: row.requestedBy,
  scope: row.scope,
  startedAt: row.startedAt,
  status: row.status,
  updatedAt: row.updatedAt,
});

const resolveScopes = (
  scope: AdminAuditRetentionCreateInput['scope'],
): readonly PlatformAuditRetentionScope[] => {
  if (scope === 'all') return AUDIT_RETENTION_STORED_SCOPES;
  return [scope];
};

const cutoffForScope = (
  scope: PlatformAuditRetentionScope,
  policy: {
    conversationRetentionDays: number;
    exportArtifactRetentionDays: number;
    operationLogRetentionDays: number;
  },
  now: Date,
): Date => {
  const days =
    scope === 'operation_logs'
      ? policy.operationLogRetentionDays
      : scope === 'conversations'
        ? policy.conversationRetentionDays
        : policy.exportArtifactRetentionDays;
  return new Date(now.getTime() - Math.max(1, days) * MS_PER_DAY);
};

export type AdminAuditRetentionServiceOptions = {
  /**
   * Test seam: invoked after a run row is created and tracked, before job enqueue.
   * Throw to simulate partial fan-out failure (orphaned-pending prevention).
   */
  afterCreateRun?: (info: {
    index: number;
    runId: string;
    scope: PlatformAuditRetentionScope;
  }) => Promise<void> | void;
  storage?: AuditExportArtifactStorage;
};

export class AdminAuditRetentionService {
  private readonly runsModel: PlatformAuditRetentionRunModel;
  private readonly jobsModel: PlatformJobModel;
  private readonly policyModel: PlatformAuditPolicyModel;
  private readonly injectedStorage?: AuditExportArtifactStorage;
  private readonly afterCreateRun?: AdminAuditRetentionServiceOptions['afterCreateRun'];
  private lazyProductionStorage?: AuditExportArtifactStorage;

  constructor(
    private readonly db: LobeChatDatabase | Transaction,
    options?: AdminAuditRetentionServiceOptions,
  ) {
    this.runsModel = new PlatformAuditRetentionRunModel(db);
    this.jobsModel = new PlatformJobModel(db as LobeChatDatabase);
    this.policyModel = new PlatformAuditPolicyModel(db);
    // Lazy private S3: dryRun/list/status/non-artifact scopes never need storage env.
    this.injectedStorage = options?.storage;
    this.afterCreateRun = options?.afterCreateRun;
  }

  /**
   * Artifact storage for export_artifacts retention only.
   * Injected storage is returned as-is; otherwise private S3 is created on first use.
   */
  getArtifactStorage = (): AuditExportArtifactStorage => {
    if (this.injectedStorage) return this.injectedStorage;
    if (!this.lazyProductionStorage) {
      this.lazyProductionStorage = new AuditExportPrivateS3Storage();
    }
    return this.lazyProductionStorage;
  };

  private createFanout = async (params: {
    actorUserId: string;
    input: AdminAuditRetentionCreateInput;
    mode: PlatformAuditRetentionMode;
  }) => {
    const filterSummary = buildAuditFilterSummary({
      mode: params.mode,
      scope: params.input.scope,
    });
    const action =
      params.mode === 'dry_run' ? 'admin.audit.retention.dryRun' : 'admin.audit.retention.run';

    try {
      const policy = await this.policyModel.getOrCreate();
      const now = new Date();
      const scopes = resolveScopes(params.input.scope);
      // Track immediately on create (before job link) so failures never orphan pending rows.
      const tracked: { jobId: string | null; runId: string }[] = [];
      const created: PlatformAuditRetentionRunItem[] = [];

      const compensateTracked = async () => {
        // Deterministic cleanup: every tracked run/job is failed or cancelled so
        // unaudited / partial fan-out work cannot execute.
        for (const entry of tracked) {
          const current = await this.runsModel.get(entry.runId);
          const jobId = entry.jobId ?? current?.jobId ?? null;

          if (current && !PlatformAuditRetentionRunModel.isTerminal(current.status)) {
            if (!jobId) {
              await this.runsModel.fail(entry.runId, {
                code: 'PARTIAL_FANOUT',
                message: 'retention fan-out failed before job link',
              });
            } else {
              await this.runsModel.cancel(entry.runId);
            }
          }

          if (jobId) {
            await this.jobsModel.cancel(jobId).catch(() => undefined);
          }
        }
      };

      try {
        for (let index = 0; index < scopes.length; index++) {
          const scope = scopes[index]!;
          const cutoffAt = cutoffForScope(scope, policy, now);
          const run = await this.runsModel.create({
            cutoffAt,
            mode: params.mode,
            policyRevision: policy.revision,
            requestedBy: params.actorUserId,
            scope,
          });
          tracked.push({ jobId: null, runId: run.id });

          if (this.afterCreateRun) {
            await this.afterCreateRun({ index, runId: run.id, scope });
          }

          const { job } = await this.jobsModel.enqueue({
            idempotencyKey: buildAuditRetentionJobIdempotencyKey(run.id),
            input: { runId: run.id },
            maxAttempts: AUDIT_RETENTION_MAX_ATTEMPTS,
            requestedBy: params.actorUserId,
            type: PLATFORM_AUDIT_RETENTION_JOB_TYPE,
          });
          tracked.at(-1)!.jobId = job.id;

          const linked =
            (await this.runsModel.setJobId(run.id, job.id)) ?? (await this.runsModel.get(run.id));
          const row = linked ?? { ...run, jobId: job.id };
          created.push(row);
        }

        // Required audit must succeed or all fan-out work is compensated (fail closed).
        await appendAuditAccessLog(this.db, {
          action,
          actorUserId: params.actorUserId,
          afterDiff: {
            itemCount: created.length,
            mode: params.mode,
            scope: params.input.scope,
            statuses: created.map((r) => r.status),
          },
          filterSummary,
          reason: params.input.reason,
          required: true,
          result: 'success',
          targetType: 'audit_retention_run',
        });
      } catch (fanoutOrAuditError) {
        await compensateTracked();
        throw fanoutOrAuditError;
      }

      return { items: created.map(toRetentionPublic) };
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action,
        actorUserId: params.actorUserId,
        afterDiff: {
          error: accessLogResultForError(error),
          mode: params.mode,
          scope: params.input.scope,
        },
        filterSummary,
        reason: params.input.reason,
        result: accessLogResultForError(error),
        targetType: 'audit_retention_run',
      });
      throw error;
    }
  };

  dryRun = async (params: { actorUserId: string; input: AdminAuditRetentionCreateInput }) =>
    this.createFanout({ ...params, mode: 'dry_run' });

  run = async (params: { actorUserId: string; input: AdminAuditRetentionCreateInput }) =>
    this.createFanout({ ...params, mode: 'execute' });

  listRuns = async (params: {
    actorUserId: string;
    input: AdminAuditRetentionListRunsInputParsed;
  }) => {
    const filterSummary = buildAuditFilterSummary({
      cursor: params.input.cursor,
      limit: params.input.limit,
      mode: params.input.mode,
      scope: params.input.scope,
      status: params.input.status,
    });
    try {
      const page = await this.runsModel.list({
        cursor: params.input.cursor,
        limit: params.input.limit,
        mode: params.input.mode,
        requestedBy: params.input.mine ? params.actorUserId : undefined,
        scope: params.input.scope,
        status: params.input.status,
      });

      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.retention.listRuns',
        actorUserId: params.actorUserId,
        afterDiff: { itemCount: page.items.length },
        filterSummary,
        result: 'success',
        targetType: 'audit_retention_run',
      });

      return {
        items: page.items.map(toRetentionPublic),
        nextCursor: page.nextCursor,
      };
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.retention.listRuns',
        actorUserId: params.actorUserId,
        afterDiff: { error: accessLogResultForError(error) },
        filterSummary,
        result: accessLogResultForError(error),
        targetType: 'audit_retention_run',
      });
      throw error;
    }
  };

  getRun = async (params: {
    actorUserId: string;
    id: string;
    /** Access-log action (getRun vs status alias). */
    accessAction?: 'admin.audit.retention.getRun' | 'admin.audit.retention.status';
  }) => {
    const action = params.accessAction ?? 'admin.audit.retention.getRun';
    const filterSummary = buildAuditFilterSummary({});
    try {
      const row = await this.runsModel.get(params.id);
      if (!row) {
        await appendAuditAccessLog(this.db, {
          action,
          actorUserId: params.actorUserId,
          afterDiff: { error: 'not_found' },
          filterSummary,
          result: 'failure',
          targetId: params.id,
          targetType: 'audit_retention_run',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          httpCode: 'NOT_FOUND',
        });
      }

      await appendAuditAccessLog(this.db, {
        action,
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetId: row.id,
        targetType: 'audit_retention_run',
      });
      return toRetentionPublic(row);
    } catch (error) {
      if (getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND) {
        throw error;
      }
      await appendAuditAccessLog(this.db, {
        action,
        actorUserId: params.actorUserId,
        afterDiff: { error: accessLogResultForError(error) },
        filterSummary,
        result: accessLogResultForError(error),
        targetId: params.id,
        targetType: 'audit_retention_run',
      });
      throw error;
    }
  };

  status = async (params: { actorUserId: string; id: string }) =>
    this.getRun({
      accessAction: 'admin.audit.retention.status',
      actorUserId: params.actorUserId,
      id: params.id,
    });

  cancel = async (params: { actorUserId: string; input: AdminAuditRetentionCancelInput }) => {
    const filterSummary = buildAuditFilterSummary({});
    try {
      const existing = await this.runsModel.get(params.input.id);
      if (!existing) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.retention.cancel',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'not_found' },
          filterSummary,
          reason: params.input.reason,
          result: 'failure',
          targetId: params.input.id,
          targetType: 'audit_retention_run',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          httpCode: 'NOT_FOUND',
        });
      }

      if (PlatformAuditRetentionRunModel.isTerminal(existing.status)) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.retention.cancel',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'already_terminal', status: existing.status },
          filterSummary,
          reason: params.input.reason,
          result: 'failure',
          targetId: existing.id,
          targetType: 'audit_retention_run',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
          details: { reason: 'retention_already_terminal', status: existing.status },
          httpCode: 'BAD_REQUEST',
          message: 'Retention run is already terminal',
        });
      }

      // Cancel + required audit: if audit cannot be recorded, surface failure
      // (domain cancel already applied — status is terminal and safe).
      const cancelled = await this.runsModel.cancel(existing.id);
      if (existing.jobId) {
        await this.jobsModel.cancel(existing.jobId);
      }

      const row = cancelled ?? (await this.runsModel.get(existing.id)) ?? existing;

      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.retention.cancel',
        actorUserId: params.actorUserId,
        afterDiff: { mode: row.mode, scope: row.scope, status: row.status },
        filterSummary,
        reason: params.input.reason,
        required: true,
        result: 'success',
        targetId: row.id,
        targetType: 'audit_retention_run',
      });

      return toRetentionPublic(row);
    } catch (error) {
      if (
        getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND ||
        getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT
      ) {
        throw error;
      }
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.retention.cancel',
        actorUserId: params.actorUserId,
        afterDiff: { error: accessLogResultForError(error) },
        filterSummary,
        reason: params.input.reason,
        result: accessLogResultForError(error),
        targetId: params.input.id,
        targetType: 'audit_retention_run',
      });
      throw error;
    }
  };
}
