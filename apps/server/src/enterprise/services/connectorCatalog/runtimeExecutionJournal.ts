import { createHash, randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

const JOURNAL_TYPE = 'connector.runtime.shared-call.v1';
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
  complete: (
    token: ConnectorRuntimeJournalToken,
    result: ConnectorRuntimeJournalResult,
  ) => Promise<void>;
  markAudited: (token: ConnectorRuntimeJournalToken) => Promise<void>;
}

export class DatabaseConnectorRuntimeExecutionJournal implements ConnectorRuntimeExecutionJournal {
  constructor(private readonly db: LobeChatDatabase) {}

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
        // A reserved call is never automatically reclaimed: the remote side
        // effect may have happened even if this process lost the response.
        leaseUntil: new Date('9999-12-31T23:59:59.999Z'),
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
    if (!existing || existing.status !== 'succeeded' || !parsed.success) {
      return { status: 'reserved' };
    }
    const { auditStatus, ...result } = parsed.data;
    return {
      auditPending: auditStatus === 'pending',
      result,
      status: 'replay',
      token: { jobId: existing.id, owner: existing.leaseOwner ?? owner },
    };
  };

  complete: ConnectorRuntimeExecutionJournal['complete'] = async (token, result) => {
    const now = new Date();
    const [completed] = await this.db
      .update(platformJobs)
      .set({
        finishedAt: now,
        leaseOwner: token.owner,
        leaseUntil: null,
        resultSummary: { ...result, auditStatus: 'pending' },
        status: 'succeeded',
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

  markAudited: ConnectorRuntimeExecutionJournal['markAudited'] = async (token) => {
    const row = await this.db.query.platformJobs.findFirst({
      where: and(eq(platformJobs.id, token.jobId), eq(platformJobs.status, 'succeeded')),
    });
    const parsed = journalResultSchema.safeParse(row?.resultSummary);
    if (!row || !parsed.success) throw new Error('Connector runtime journal result missing');
    await this.db
      .update(platformJobs)
      .set({ resultSummary: { ...parsed.data, auditStatus: 'complete' }, updatedAt: new Date() })
      .where(and(eq(platformJobs.id, token.jobId), eq(platformJobs.status, 'succeeded')));
  };
}
