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
import { PlatformSecretRewrapConflictError } from './errors';

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
  await db.delete(platformAuditLogs).where(eq(platformAuditLogs.actorUserId, actorUserId));
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
