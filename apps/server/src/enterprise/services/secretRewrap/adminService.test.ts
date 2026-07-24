// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import {
  type KekMaterial,
  type KeyProvider,
  PlatformSecretService,
} from '@/server/enterprise/security/secret';

import { PlatformSecretRotationAdminService } from './adminService';
import {
  EMPTY_PLATFORM_SECRET_REWRAP_RESULT,
  PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
  PLATFORM_SECRET_REWRAP_JOB_TYPE,
} from './contracts';
import { PlatformSecretRewrapCoordinator } from './coordinator';
import { PlatformSecretRewrapConflictError, PlatformSecretRewrapProviderError } from './errors';
import { processNextPlatformSecretRewrapBatch } from './worker';

const db: LobeChatDatabase = await getTestDB();
const namespace = `secret-rotation-admin-${randomUUID()}`;
const actorUserId = `${namespace}-actor`;
const requestIds = {
  cancel: randomUUID(),
  conflict: randomUUID(),
  retry: randomUUID(),
  start: randomUUID(),
};

class MutableVaultProvider implements KeyProvider {
  activeKeyId = 'vault:admin-a';
  readonly providerId = 'vault';
  readonly #keys = new Map([
    ['vault:admin-a', randomBytes(32)],
    ['vault:admin-b', randomBytes(32)],
  ]);

  getKek = async (keyId?: string): Promise<KekMaterial> => {
    const resolved = keyId ?? this.activeKeyId;
    const key = this.#keys.get(resolved);
    if (!key) throw new Error('unknown test key');
    return { key: new Uint8Array(key), keyId: resolved };
  };
}

const provider = new MutableVaultProvider();
const secrets = new PlatformSecretService({ keyProvider: provider });
const coordinator = new PlatformSecretRewrapCoordinator(secrets);
const service = () => new PlatformSecretRotationAdminService(db, () => coordinator);

const cleanup = async () => {
  const parents = await db
    .select({ id: platformJobs.id })
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
        eq(platformJobs.requestedBy, actorUserId),
      ),
    );
  const parentIds = parents.map(({ id }) => id);
  if (parentIds.length > 0) {
    await db
      .delete(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_FAILURE_TYPE),
          inArray(sql<string>`${platformJobs.input}->>'parentJobId'`, parentIds),
        ),
      );
    await db.delete(platformJobs).where(inArray(platformJobs.id, parentIds));
  }
  // Append-only audit trigger blocks DELETE; replica role bypasses it for test cleanup only.
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL session_replication_role = 'replica'`));
    await tx.delete(platformAuditLogs).where(eq(platformAuditLogs.actorUserId, actorUserId));
  });
};

beforeEach(async () => {
  provider.activeKeyId = 'vault:admin-a';
  await cleanup();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const start = (requestId = requestIds.start) =>
  service().start(actorUserId, {
    reason: 'rotate the platform envelopes',
    requestId,
    targetKeyId: provider.activeKeyId,
  });

describe('PlatformSecretRotationAdminService', () => {
  it('starts idempotently and stores a sanitized success audit in the same transaction', async () => {
    const first = await start();
    const duplicate = await start(randomUUID());
    expect(duplicate.jobId).toBe(first.jobId);
    expect(duplicate.counts).toMatchObject({
      externalArtifactGate: 'identity_lkg_instance_convergence_required',
      historicalKeyRemovalReady: false,
    });

    const audits = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.actorUserId, actorUserId));
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'admin.security.secretRotation.start',
          result: 'success',
          targetType: 'secret_rotation',
        }),
      ]),
    );
    expect(JSON.stringify(audits)).not.toMatch(/ciphertext|secret=|Bearer/i);
  });

  it('enforces one worker-active target and permits a new target after cancellation', async () => {
    const first = await start();
    provider.activeKeyId = 'vault:admin-b';
    await expect(start(requestIds.conflict)).rejects.toBeInstanceOf(
      PlatformSecretRewrapConflictError,
    );

    await service().cancel(actorUserId, {
      expectedRevision: first.revision,
      expectedStatus: 'pending',
      jobId: first.jobId,
      reason: 'cancel before switching active key',
      requestId: requestIds.cancel,
    });
    const next = await start(randomUUID());
    expect(next.targetKeyId).toBe('vault:admin-b');
    expect(next.jobId).not.toBe(first.jobId);
  });

  it('allows get, list, cancel, and retry when Vault configuration is unavailable', async () => {
    const job = await start();
    const vaultDown = () => {
      throw new PlatformSecretRewrapProviderError('vault_unavailable');
    };
    // Default db-only factory; crypto factory always fails.
    const recovery = new PlatformSecretRotationAdminService(db, vaultDown);

    await expect(recovery.get(job.jobId)).resolves.toMatchObject({
      jobId: job.jobId,
      status: 'pending',
    });
    const listed = await recovery.list({ limit: 10 });
    expect(listed.items.some((item) => item.jobId === job.jobId)).toBe(true);

    // Fail + ledger, then re-queue while Vault is down (retry is pure DB).
    await db.update(platformJobs).set({ status: 'failed' }).where(eq(platformJobs.id, job.jobId));
    await db.insert(platformJobs).values({
      idempotencyKey: `${namespace}-vault-down-ledger`,
      input: { parentJobId: job.jobId },
      requestedBy: actorUserId,
      status: 'failed',
      type: PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
    });
    const retried = await recovery.retry(actorUserId, {
      expectedRevision: job.revision,
      expectedStatus: 'failed',
      jobId: job.jobId,
      reason: 'retry during vault outage',
      requestId: randomUUID(),
    });
    expect(retried).toMatchObject({ jobId: job.jobId, status: 'pending' });

    await expect(
      recovery.cancel(actorUserId, {
        expectedRevision: retried.revision,
        expectedStatus: 'pending',
        jobId: job.jobId,
        reason: 'cancel during vault outage',
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ status: 'cancelled' });

    // New rotations still require Vault even when recovery ops work.
    await expect(
      recovery.start(actorUserId, {
        reason: 'must still require vault',
        requestId: randomUUID(),
        targetKeyId: provider.activeKeyId,
      }),
    ).rejects.toBeInstanceOf(PlatformSecretRewrapProviderError);
  });

  it('protects pending, reserved, and running rows while terminal rows release retry capacity', async () => {
    const first = await start();
    const contenderInput = {
      control: { phase: 'scan' as const, revision: 0 },
      reason: 'contending active job',
      requestId: randomUUID(),
      schemaVersion: 1 as const,
      targetKeyId: 'vault:admin-b',
    };
    const insertContender = (idempotencyKey: string, status: 'pending' | 'reserved') =>
      db.insert(platformJobs).values({
        idempotencyKey,
        input: contenderInput,
        requestedBy: actorUserId,
        resultSummary: EMPTY_PLATFORM_SECRET_REWRAP_RESULT,
        status,
        type: PLATFORM_SECRET_REWRAP_JOB_TYPE,
      });

    await expect(insertContender(`${namespace}-pending`, 'pending')).rejects.toThrow();
    await db
      .update(platformJobs)
      .set({ status: 'reserved' })
      .where(eq(platformJobs.id, first.jobId));
    await expect(insertContender(`${namespace}-reserved`, 'reserved')).rejects.toThrow();
    await db
      .update(platformJobs)
      .set({ status: 'running' })
      .where(eq(platformJobs.id, first.jobId));
    await expect(insertContender(`${namespace}-running`, 'pending')).rejects.toThrow();

    await db
      .update(platformJobs)
      .set({ status: 'cancelled' })
      .where(eq(platformJobs.id, first.jobId));
    const [second] = await insertContender(`${namespace}-after-terminal`, 'reserved').returning();
    expect(second.status).toBe('reserved');

    await db.update(platformJobs).set({ status: 'failed' }).where(eq(platformJobs.id, second.id));
    await db.insert(platformJobs).values({
      idempotencyKey: `${namespace}-terminal-ledger`,
      input: { parentJobId: second.id },
      requestedBy: actorUserId,
      status: 'failed',
      type: PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
    });
    await expect(
      service().retry(actorUserId, {
        expectedRevision: 0,
        expectedStatus: 'failed',
        jobId: second.id,
        reason: 'retry after terminal failure',
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('retries only a failed parent with a failed ledger and advances the control revision', async () => {
    const job = await start();
    await db.update(platformJobs).set({ status: 'failed' }).where(eq(platformJobs.id, job.jobId));
    await db.insert(platformJobs).values({
      idempotencyKey: `${namespace}-ledger`,
      input: { parentJobId: job.jobId },
      requestedBy: actorUserId,
      status: 'failed',
      type: PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
    });

    const retried = await service().retry(actorUserId, {
      expectedRevision: job.revision,
      expectedStatus: 'failed',
      jobId: job.jobId,
      reason: 'retry the exact failed ledger',
      requestId: requestIds.retry,
    });
    expect(retried).toMatchObject({ revision: job.revision + 1, status: 'pending' });
  });

  it('restarts a cancelled job to pending and advances the control revision', async () => {
    const job = await start();
    // Leave stale progress from a partial run so restart must clear both counters.
    await db
      .update(platformJobs)
      .set({ progressDone: 3, progressTotal: 10 })
      .where(eq(platformJobs.id, job.jobId));
    const cancelled = await service().cancel(actorUserId, {
      expectedRevision: job.revision,
      expectedStatus: 'pending',
      jobId: job.jobId,
      reason: 'cancel before restart',
      requestId: randomUUID(),
    });
    expect(cancelled.status).toBe('cancelled');

    const restartRequestId = randomUUID();
    const restarted = await service().restart(actorUserId, {
      expectedRevision: cancelled.revision,
      expectedStatus: 'cancelled',
      jobId: cancelled.jobId,
      reason: 'restart cancelled rotation',
      requestId: restartRequestId,
    });
    expect(restarted).toMatchObject({
      jobId: cancelled.jobId,
      revision: cancelled.revision + 1,
      status: 'pending',
      targetKeyId: cancelled.targetKeyId,
    });

    const [row] = await db.select().from(platformJobs).where(eq(platformJobs.id, cancelled.jobId));
    expect(row).toMatchObject({
      attempt: 0,
      leaseOwner: null,
      progressDone: 0,
      progressTotal: null,
      status: 'pending',
    });

    const [audit] = await db
      .select()
      .from(platformAuditLogs)
      .where(
        and(
          eq(platformAuditLogs.actorUserId, actorUserId),
          eq(platformAuditLogs.action, 'admin.security.secretRotation.restart'),
          eq(platformAuditLogs.requestId, restartRequestId),
        ),
      );
    expect(audit).toMatchObject({
      beforeDiff: {
        jobId: cancelled.jobId,
        progressDone: 3,
        progressTotal: 10,
        revision: cancelled.revision,
        status: 'cancelled',
        targetKeyId: cancelled.targetKeyId,
      },
      result: 'success',
    });
    expect(audit.afterDiff).toMatchObject({
      jobId: cancelled.jobId,
      revision: cancelled.revision + 1,
      status: 'pending',
    });
  });

  it('restarts a dead job to pending, resets progress, and audits terminal diagnostics', async () => {
    const job = await start();
    const terminalCounts = {
      ...EMPTY_PLATFORM_SECRET_REWRAP_RESULT,
      examined: 4,
      failed: 1,
      rotated: 3,
    };
    await db
      .update(platformJobs)
      .set({
        attempt: 5,
        finishedAt: sql`clock_timestamp()`,
        lastError: { category: 'invalid_job_contract' },
        leaseOwner: 'dead-worker',
        progressDone: 7,
        progressTotal: 12,
        resultSummary: terminalCounts,
        status: 'dead',
      })
      .where(eq(platformJobs.id, job.jobId));

    const restartRequestId = randomUUID();
    const restarted = await service().restart(actorUserId, {
      expectedRevision: job.revision,
      expectedStatus: 'dead',
      jobId: job.jobId,
      reason: 'restart dead rotation',
      requestId: restartRequestId,
    });
    expect(restarted).toMatchObject({
      jobId: job.jobId,
      revision: job.revision + 1,
      status: 'pending',
    });

    const [row] = await db.select().from(platformJobs).where(eq(platformJobs.id, job.jobId));
    expect(row).toMatchObject({
      attempt: 0,
      lastError: null,
      leaseOwner: null,
      progressDone: 0,
      progressTotal: null,
      resultSummary: EMPTY_PLATFORM_SECRET_REWRAP_RESULT,
      status: 'pending',
    });
    expect(row.finishedAt).toBeNull();

    const [audit] = await db
      .select()
      .from(platformAuditLogs)
      .where(
        and(
          eq(platformAuditLogs.actorUserId, actorUserId),
          eq(platformAuditLogs.action, 'admin.security.secretRotation.restart'),
          eq(platformAuditLogs.requestId, restartRequestId),
        ),
      );
    expect(audit.beforeDiff).toMatchObject({
      attempt: 5,
      counts: terminalCounts,
      jobId: job.jobId,
      lastError: { category: 'invalid_job_contract' },
      progressDone: 7,
      progressTotal: 12,
      revision: job.revision,
      status: 'dead',
    });
  });

  it('rejects restart of running or pending jobs', async () => {
    const pending = await start();
    await expect(
      service().restart(actorUserId, {
        expectedRevision: pending.revision,
        expectedStatus: 'cancelled',
        jobId: pending.jobId,
        reason: 'cannot restart active pending job',
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PlatformSecretRewrapConflictError);

    await db
      .update(platformJobs)
      .set({ status: 'running' })
      .where(eq(platformJobs.id, pending.jobId));
    await expect(
      service().restart(actorUserId, {
        expectedRevision: pending.revision,
        expectedStatus: 'dead',
        jobId: pending.jobId,
        reason: 'cannot restart running job',
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PlatformSecretRewrapConflictError);
  });

  it('restarts a worker-produced invalid_job_contract dead job through the service (no DB repair)', async () => {
    const job = await start();
    // Corrupt wire input so the worker marks the claim dead (invalid_job_contract).
    // Leave the row unrepaired: restart must recover via the service, not a hand-fixed payload.
    await db
      .update(platformJobs)
      .set({
        input: {
          control: { phase: 'scan', revision: job.revision },
          // missing required fields → parsePlatformSecretRewrapInput fails
          schemaVersion: 1,
        },
        progressDone: 2,
        progressTotal: 8,
      })
      .where(eq(platformJobs.id, job.jobId));

    const batch = await processNextPlatformSecretRewrapBatch(db, secrets, 'dead-worker-test');
    expect(batch).toMatchObject({ claimed: true, jobId: job.jobId, terminal: true });
    const [deadRow] = await db.select().from(platformJobs).where(eq(platformJobs.id, job.jobId));
    expect(deadRow).toMatchObject({
      lastError: { category: 'invalid_job_contract' },
      status: 'dead',
    });
    // Prove the stored payload is still invalid (would fail a precondition parse).
    expect(deadRow.input).not.toHaveProperty('targetKeyId');
    expect(deadRow.input).not.toHaveProperty('requestId');
    expect(deadRow.input).not.toHaveProperty('reason');

    const restartRequestId = randomUUID();
    const restarted = await service().restart(actorUserId, {
      expectedRevision: job.revision,
      expectedStatus: 'dead',
      jobId: job.jobId,
      reason: 'restart worker-produced dead job',
      requestId: restartRequestId,
    });
    expect(restarted).toMatchObject({
      jobId: job.jobId,
      revision: job.revision + 1,
      status: 'pending',
      targetKeyId: provider.activeKeyId,
    });
    const [row] = await db.select().from(platformJobs).where(eq(platformJobs.id, job.jobId));
    expect(row).toMatchObject({
      lastError: null,
      progressDone: 0,
      progressTotal: null,
      status: 'pending',
    });
    expect(row.input).toMatchObject({
      control: { phase: 'scan', revision: job.revision + 1 },
      reason: 'restart worker-produced dead job',
      requestId: restartRequestId,
      schemaVersion: 1,
      targetKeyId: provider.activeKeyId,
    });
  });

  it('replays the same restart requestId as an idempotent success', async () => {
    const job = await start();
    const cancelled = await service().cancel(actorUserId, {
      expectedRevision: job.revision,
      expectedStatus: 'pending',
      jobId: job.jobId,
      reason: 'cancel for restart replay',
      requestId: randomUUID(),
    });

    const restartRequestId = randomUUID();
    const intent = {
      expectedRevision: cancelled.revision,
      expectedStatus: 'cancelled' as const,
      jobId: cancelled.jobId,
      reason: 'restart with replayable requestId',
      requestId: restartRequestId,
    };
    const first = await service().restart(actorUserId, intent);
    expect(first).toMatchObject({
      jobId: cancelled.jobId,
      revision: cancelled.revision + 1,
      status: 'pending',
    });

    // Identical client retry must not conflict — returns the already-restarted generation.
    const replay = await service().restart(actorUserId, intent);
    expect(replay).toEqual(first);

    const [row] = await db.select().from(platformJobs).where(eq(platformJobs.id, cancelled.jobId));
    expect(row).toMatchObject({
      status: 'pending',
    });
    expect(row.input).toMatchObject({
      control: { revision: cancelled.revision + 1 },
      requestId: restartRequestId,
    });

    // A different requestId against the already-restarted row still conflicts.
    await expect(
      service().restart(actorUserId, {
        ...intent,
        reason: 'different restart generation',
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PlatformSecretRewrapConflictError);
  });

  // Concurrent double-restart CAS is proven under real multi-connection PostgreSQL in
  // adminService.multiconn.pg.test.ts (TEST_SERVER_DB=1). PGlite cannot prove independent sessions.

  it('rolls back the business mutation when the success audit append fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auditFailure = new Error('injected audit sink failure');
    const failingAuditService = new PlatformSecretRotationAdminService(
      db,
      () => coordinator,
      () => ({
        append: vi.fn(async () => {
          throw auditFailure;
        }),
      }),
    );

    await expect(
      failingAuditService.start(actorUserId, {
        reason: 'rotate with an unavailable audit sink',
        requestId: requestIds.start,
        targetKeyId: provider.activeKeyId,
      }),
    ).rejects.toThrow('injected audit sink failure');
    expect(
      await db
        .select()
        .from(platformJobs)
        .where(
          and(
            eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
            eq(platformJobs.requestedBy, actorUserId),
          ),
        ),
    ).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith(
      '[admin.security.secretRotation] failure audit unavailable',
      { errorClass: 'Error' },
    );
  });

  it('records only a stable category when an unexpected mutation failure contains secrets', async () => {
    const failing = new PlatformSecretRotationAdminService(db, () => {
      throw new Error('ciphertext=raw Authorization: Bearer leaked-secret stack');
    });
    await expect(
      failing.start(actorUserId, {
        reason: 'safe operational reason',
        requestId: randomUUID(),
        targetKeyId: 'vault:admin-a',
      }),
    ).rejects.toThrow('leaked-secret');

    const [audit] = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.actorUserId, actorUserId));
    expect(audit).toMatchObject({
      afterDiff: { error: 'rotation_mutation_failed' },
      result: 'failure',
    });
    expect(JSON.stringify(audit)).not.toMatch(/raw|Bearer|leaked-secret|ciphertext/i);
  });
});
