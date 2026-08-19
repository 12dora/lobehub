import { and, asc, eq, gt, sql } from 'drizzle-orm';

import {
  PLATFORM_SECRET_ROTATION_DOMAINS,
  type PlatformSecretRotationDomain,
} from '@/database/repositories/platformSecretRotation';
import { type PlatformJobItem, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
  type PlatformSecretRewrapCursor,
  type PlatformSecretRewrapFailureCategory,
  type PlatformSecretRewrapFailureInput,
  platformSecretRewrapFailureInputSchema,
  type PlatformSecretRewrapJobInput,
  type PlatformSecretRewrapResult,
} from './contracts';
import { PlatformSecretRewrapInvalidError } from './errors';
import type { CandidateOutcome } from './workerCandidate';

const failureRowId = sql<string>`${platformJobs.input}->>'rowId'`;
type RewrapDatabase = LobeChatDatabase | Transaction;

interface FailedLedgerItem {
  category: PlatformSecretRewrapFailureCategory;
  domain: PlatformSecretRotationDomain;
  rowId: string;
}

interface FailedLedgerPage {
  items: FailedLedgerItem[];
  nextCursor: PlatformSecretRewrapCursor | null;
}

export const listFailedLedgers = async (
  db: RewrapDatabase,
  params: {
    cursor: PlatformSecretRewrapCursor | null;
    input: PlatformSecretRewrapJobInput;
    jobId: string;
    limit: number;
  },
): Promise<FailedLedgerPage> => {
  const startIndex = params.cursor
    ? PLATFORM_SECRET_ROTATION_DOMAINS.indexOf(params.cursor.domain)
    : 0;
  if (startIndex < 0) throw new PlatformSecretRewrapInvalidError();

  const items: FailedLedgerItem[] = [];
  for (let index = startIndex; index < PLATFORM_SECRET_ROTATION_DOMAINS.length; index += 1) {
    const domain = PLATFORM_SECRET_ROTATION_DOMAINS[index]!;
    const rows = await db
      .select({ input: platformJobs.input })
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_FAILURE_TYPE),
          eq(platformJobs.status, 'failed'),
          sql`${platformJobs.input}->>'parentJobId' = ${params.jobId}`,
          sql`${platformJobs.input}->>'domain' = ${domain}`,
          index === startIndex && params.cursor
            ? gt(failureRowId, params.cursor.lastId)
            : undefined,
        ),
      )
      .orderBy(asc(failureRowId))
      .limit(params.limit + 1 - items.length);
    for (const row of rows) {
      const parsed = platformSecretRewrapFailureInputSchema.safeParse(row.input);
      if (
        !parsed.success ||
        parsed.data.parentJobId !== params.jobId ||
        parsed.data.targetKeyId !== params.input.targetKeyId ||
        parsed.data.requestId !== params.input.requestId ||
        parsed.data.domain !== domain
      ) {
        throw new PlatformSecretRewrapInvalidError();
      }
      items.push({
        category: parsed.data.category,
        domain: parsed.data.domain,
        rowId: parsed.data.rowId,
      });
    }
    if (items.length > params.limit) break;
  }

  const pageItems = items.slice(0, params.limit);
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    nextCursor:
      items.length > params.limit && last ? { domain: last.domain, lastId: last.rowId } : null,
  };
};

const failureIdempotencyKey = (parentJobId: string, domain: string, rowId: string) =>
  `${parentJobId}:${domain}:${rowId}`;

export const upsertFailureLedger = async (
  tx: Transaction,
  params: {
    category: PlatformSecretRewrapFailureCategory;
    domain: PlatformSecretRotationDomain;
    input: PlatformSecretRewrapJobInput;
    job: PlatformJobItem;
    rowId: string;
  },
) => {
  const input: PlatformSecretRewrapFailureInput = {
    category: params.category,
    domain: params.domain,
    parentJobId: params.job.id,
    parentRevision: params.input.control.revision,
    requestId: params.input.requestId,
    rowId: params.rowId,
    schemaVersion: 1,
    targetKeyId: params.input.targetKeyId,
  };
  const rows = await tx
    .insert(platformJobs)
    .values({
      finishedAt: sql`clock_timestamp()`,
      idempotencyKey: failureIdempotencyKey(params.job.id, params.domain, params.rowId),
      input,
      lastError: { category: params.category },
      maxAttempts: 1,
      progressDone: 0,
      progressTotal: 1,
      status: 'failed',
      type: PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
    })
    .onConflictDoUpdate({
      set: {
        finishedAt: sql`clock_timestamp()`,
        input,
        lastError: { category: params.category },
        progressDone: 0,
        status: 'failed',
        updatedAt: sql`clock_timestamp()`,
      },
      target: [platformJobs.type, platformJobs.idempotencyKey],
      where: and(
        sql`${platformJobs.input}->>'parentJobId' = ${params.job.id}`,
        sql`${platformJobs.input}->>'domain' = ${params.domain}`,
        sql`${platformJobs.input}->>'rowId' = ${params.rowId}`,
      ),
    })
    .returning({ id: platformJobs.id });
  if (rows.length !== 1) throw new PlatformSecretRewrapInvalidError();
};

export const markFailureResolved = async (
  tx: Transaction,
  params: { domain: PlatformSecretRotationDomain; jobId: string; rowId: string },
) => {
  const [updated] = await tx
    .update(platformJobs)
    .set({
      finishedAt: sql`clock_timestamp()`,
      lastError: null,
      progressDone: 1,
      status: 'succeeded',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(platformJobs.type, PLATFORM_SECRET_REWRAP_FAILURE_TYPE),
        eq(
          platformJobs.idempotencyKey,
          failureIdempotencyKey(params.jobId, params.domain, params.rowId),
        ),
        eq(platformJobs.status, 'failed'),
        sql`${platformJobs.input}->>'parentJobId' = ${params.jobId}`,
        sql`${platformJobs.input}->>'domain' = ${params.domain}`,
        sql`${platformJobs.input}->>'rowId' = ${params.rowId}`,
      ),
    )
    .returning({ id: platformJobs.id });
  if (!updated) throw new PlatformSecretRewrapInvalidError();
};

const copyResult = (result: PlatformSecretRewrapResult): PlatformSecretRewrapResult => ({
  ...result,
  categories: { ...result.categories },
});

export const applyOutcome = (
  result: PlatformSecretRewrapResult,
  outcome: CandidateOutcome,
  previousFailure?: PlatformSecretRewrapFailureCategory,
) => {
  const next = copyResult(result);
  if (previousFailure) {
    next.failed -= 1;
    next.categories[previousFailure] -= 1;
  } else {
    next.examined += 1;
  }
  if (outcome.kind === 'rotated') next.rotated += 1;
  if (outcome.kind === 'no_op') next.noOp += 1;
  if (outcome.kind === 'failed') {
    next.failed += 1;
    next.categories[outcome.category] += 1;
  }
  return next;
};
