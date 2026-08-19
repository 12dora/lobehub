import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';

import { type PlatformJobItem, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { PLATFORM_SECRET_REWRAP_JOB_TYPE } from './contracts';
import { platformSecretRewrapJobRevision } from './coordinator';

type RewrapDatabase = LobeChatDatabase | Transaction;

export class PlatformSecretRewrapLeaseLostError extends Error {
  constructor() {
    super('PLATFORM_SECRET_REWRAP_LEASE_LOST');
    this.name = 'PlatformSecretRewrapLeaseLostError';
  }
}

/**
 * Extend the job lease in a short statement between remote crypto calls.
 * No Vault call runs while a database transaction or row lock is held.
 */
export const renewLease = async (
  db: RewrapDatabase,
  params: { jobId: string; leaseMs: number; revision: number; workerId: string },
) => {
  const [renewed] = await db
    .update(platformJobs)
    .set({
      heartbeatAt: sql`clock_timestamp()`,
      leaseUntil: sql`clock_timestamp() + (${params.leaseMs} * interval '1 millisecond')`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(platformJobs.id, params.jobId),
        eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
        eq(platformJobs.status, 'running'),
        eq(platformJobs.leaseOwner, params.workerId),
        eq(platformSecretRewrapJobRevision, params.revision),
      ),
    )
    .returning({ id: platformJobs.id });
  if (!renewed) throw new PlatformSecretRewrapLeaseLostError();
};

/**
 * S02c1-specific claim lane. Eligibility and every lease timestamp use the
 * PostgreSQL clock so application-node skew cannot steal or strand a lease.
 */
export const claimNextPlatformSecretRewrapJob = async (
  db: LobeChatDatabase,
  params: { leaseMs: number; workerId: string },
): Promise<PlatformJobItem | null> =>
  db.transaction(async (tx) => {
    const available = or(
      eq(platformJobs.status, 'pending'),
      and(eq(platformJobs.status, 'running'), lte(platformJobs.leaseUntil, sql`clock_timestamp()`)),
    );
    const [candidate] = await tx
      .select()
      .from(platformJobs)
      .where(and(eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE), available))
      .orderBy(asc(platformJobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!candidate) return null;

    const [claimed] = await tx
      .update(platformJobs)
      .set({
        attempt: sql`${platformJobs.attempt} + 1`,
        heartbeatAt: sql`clock_timestamp()`,
        leaseOwner: params.workerId,
        leaseUntil: sql`clock_timestamp() + (${params.leaseMs} * interval '1 millisecond')`,
        startedAt: sql`COALESCE(${platformJobs.startedAt}, clock_timestamp())`,
        status: 'running',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(platformJobs.id, candidate.id),
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          available,
        ),
      )
      .returning();
    return claimed ?? null;
  });

export const markClaimedDead = async (
  db: LobeChatDatabase,
  params: { category: 'invalid_job_contract'; jobId: string; workerId: string },
) => {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: platformJobs.id })
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          eq(platformJobs.status, 'running'),
          eq(platformJobs.leaseOwner, params.workerId),
          gt(platformJobs.leaseUntil, sql`clock_timestamp()`),
        ),
      )
      .for('update')
      .limit(1);
    if (!current) return;
    await tx
      .update(platformJobs)
      .set({
        finishedAt: sql`clock_timestamp()`,
        lastError: { category: params.category },
        leaseOwner: null,
        leaseUntil: null,
        status: 'dead',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(platformJobs.id, current.id));
  });
};
