import { createHash, randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { PlatformJobModel } from '@/database/models/platform/job';
import { platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

const JOURNAL_TYPE = 'connector.runtime.shared-call.v1';
const AUDIT_LEASE_MS = 30_000;
const journalInputSchema = z
  .object({
    connectorId: z.string(),
    operationId: z.string(),
    requestFingerprint: z.string(),
    toolCallId: z.string(),
    toolKey: z.string(),
    userId: z.string(),
  })
  .strict();
const journalResultSchema = z
  .object({
    auditStatus: z.enum(['complete', 'pending']),
    confirmation: z.literal('always').nullable(),
    content: z.string(),
    state: z.record(z.string(), z.unknown()).optional(),
    success: z.literal(true),
  })
  .strict();

export type ConnectorRuntimeJournalResult = Omit<
  z.infer<typeof journalResultSchema>,
  'auditStatus'
>;

export interface ConnectorRuntimeJournalToken {
  jobId: string;
  owner: string;
}

export interface ConnectorRuntimeAuditRecord {
  connectorId: string;
  idempotencyKey: string;
  operationId: string;
  outcome: 'allowed' | 'unknown';
  toolKey: string;
  userId: string;
}

export type ConnectorRuntimeJournalBegin =
  | { status: 'acquired'; token: ConnectorRuntimeJournalToken }
  | {
      auditPending: boolean;
      result: ConnectorRuntimeJournalResult;
      status: 'replay';
      token: ConnectorRuntimeJournalToken;
    }
  | { status: 'reserved' };

export interface ConnectorRuntimeExecutionJournal {
  begin: (params: {
    connectorId: string;
    operationId: string;
    requestFingerprint: string;
    toolCallId: string;
    toolKey: string;
    userId: string;
  }) => Promise<ConnectorRuntimeJournalBegin>;
  cancel: (token: ConnectorRuntimeJournalToken) => Promise<void>;
  complete: (
    token: ConnectorRuntimeJournalToken,
    result: ConnectorRuntimeJournalResult,
  ) => Promise<void>;
  deliverAudit: (
    token: ConnectorRuntimeJournalToken,
    delivery: (record: ConnectorRuntimeAuditRecord) => Promise<void>,
  ) => Promise<boolean>;
}

export class DatabaseConnectorRuntimeExecutionJournal implements ConnectorRuntimeExecutionJournal {
  private readonly jobs: PlatformJobModel;

  constructor(private readonly db: LobeChatDatabase) {
    this.jobs = new PlatformJobModel(db);
  }

  begin: ConnectorRuntimeExecutionJournal['begin'] = async (params) => {
    const idempotencyKey = createHash('sha256')
      .update(
        JSON.stringify([
          params.operationId,
          params.toolCallId,
          params.connectorId,
          params.toolKey,
          params.userId,
        ]),
      )
      .digest('hex');
    const owner = randomUUID();
    const now = new Date();
    const [created] = await this.db
      .insert(platformJobs)
      .values({
        attempt: 1,
        heartbeatAt: now,
        idempotencyKey,
        input: {
          connectorId: params.connectorId,
          operationId: params.operationId,
          requestFingerprint: params.requestFingerprint,
          toolCallId: params.toolCallId,
          toolKey: params.toolKey,
          userId: params.userId,
        },
        leaseOwner: owner,
        // Expiry transfers only terminal reconciliation ownership. Workers
        // never redispatch the remote call.
        leaseUntil: new Date(now.getTime() + AUDIT_LEASE_MS),
        requestedBy: params.userId,
        startedAt: now,
        status: 'running',
        type: JOURNAL_TYPE,
      })
      .onConflictDoNothing({ target: [platformJobs.type, platformJobs.idempotencyKey] })
      .returning({ id: platformJobs.id });
    if (created) return { status: 'acquired', token: { jobId: created.id, owner } };

    const existing = await this.db.query.platformJobs.findFirst({
      where: and(
        eq(platformJobs.type, JOURNAL_TYPE),
        eq(platformJobs.idempotencyKey, idempotencyKey),
      ),
    });
    if (existing?.input.requestFingerprint !== params.requestFingerprint) {
      return { status: 'reserved' };
    }
    const parsed = journalResultSchema.safeParse(existing?.resultSummary);
    if (!existing || !parsed.success) {
      return { status: 'reserved' };
    }
    const { auditStatus, ...result } = parsed.data;
    return {
      auditPending: auditStatus === 'pending' && existing.status !== 'succeeded',
      result,
      status: 'replay',
      token: { jobId: existing.id, owner: existing.leaseOwner ?? owner },
    };
  };

  cancel: ConnectorRuntimeExecutionJournal['cancel'] = async (token) => {
    const [removed] = await this.db
      .delete(platformJobs)
      .where(
        and(
          eq(platformJobs.id, token.jobId),
          eq(platformJobs.leaseOwner, token.owner),
          eq(platformJobs.status, 'running'),
        ),
      )
      .returning({ id: platformJobs.id });
    if (!removed) throw new Error('Connector runtime journal cancellation conflict');
  };

  complete: ConnectorRuntimeExecutionJournal['complete'] = async (token, result) => {
    const now = new Date();
    const [completed] = await this.db
      .update(platformJobs)
      .set({
        finishedAt: now,
        leaseOwner: null,
        leaseUntil: null,
        resultSummary: { ...result, auditStatus: 'pending' },
        status: 'pending',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformJobs.id, token.jobId),
          eq(platformJobs.leaseOwner, token.owner),
          eq(platformJobs.status, 'running'),
        ),
      )
      .returning({ id: platformJobs.id });
    if (!completed) throw new Error('Connector runtime journal completion conflict');
  };

  private deliverClaimed = async (
    job: typeof platformJobs.$inferSelect,
    workerId: string,
    delivery: (record: ConnectorRuntimeAuditRecord) => Promise<void>,
  ): Promise<boolean> => {
    const input = journalInputSchema.safeParse(job.input);
    if (!input.success) {
      await this.jobs.fail({
        error: { code: 'CONNECTOR_RUNTIME_JOURNAL_INPUT_INVALID' },
        jobId: job.id,
        terminal: true,
        workerId,
      });
      return false;
    }
    const result = journalResultSchema.safeParse(job.resultSummary);
    const outcome = result.success ? 'allowed' : 'unknown';
    try {
      await delivery({
        connectorId: input.data.connectorId,
        idempotencyKey: `connector-runtime-audit:${job.id}`,
        operationId: input.data.operationId,
        outcome,
        toolKey: input.data.toolKey,
        userId: input.data.userId,
      });
      if (result.success) {
        await this.jobs.complete({
          jobId: job.id,
          resultSummary: { ...result.data, auditStatus: 'complete' },
          workerId,
        });
      } else {
        await this.jobs.fail({
          error: { code: 'CONNECTOR_RUNTIME_OUTCOME_UNKNOWN' },
          jobId: job.id,
          terminal: true,
          workerId,
        });
      }
      return true;
    } catch (error) {
      await this.jobs.fail({
        error: { code: 'CONNECTOR_RUNTIME_AUDIT_DELIVERY_FAILED' },
        jobId: job.id,
        workerId,
      });
      throw error;
    }
  };

  deliverAudit: ConnectorRuntimeExecutionJournal['deliverAudit'] = async (token, delivery) => {
    const workerId = randomUUID();
    const now = new Date();
    const [claimed] = await this.db
      .update(platformJobs)
      .set({
        attempt: 2,
        heartbeatAt: now,
        leaseOwner: workerId,
        leaseUntil: new Date(now.getTime() + AUDIT_LEASE_MS),
        startedAt: now,
        status: 'running',
        updatedAt: now,
      })
      .where(and(eq(platformJobs.id, token.jobId), eq(platformJobs.status, 'pending')))
      .returning();
    return claimed ? this.deliverClaimed(claimed, workerId, delivery) : false;
  };

  /** Background worker entry point: claims pending audits or expired unknown outcomes. */
  reconcileNext = async (
    delivery: (record: ConnectorRuntimeAuditRecord) => Promise<void>,
  ): Promise<boolean> => {
    const workerId = randomUUID();
    const claimed = await this.jobs.claimNext({ types: [JOURNAL_TYPE], workerId });
    return claimed ? this.deliverClaimed(claimed, workerId, delivery) : false;
  };
}
