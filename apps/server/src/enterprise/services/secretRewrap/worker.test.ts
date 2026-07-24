// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAiProviders,
  platformAiProviderSecrets,
  platformConnectors,
  platformConnectorSecrets,
  platformGlobalCredentials,
  platformGlobalCredentialSecrets,
  platformGlobalCredentialUploads,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
  platformJobs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import {
  type KekMaterial,
  type KeyProvider,
  PlatformSecretService,
  secretNotReadable,
} from '@/server/enterprise/security/secret';

import {
  parsePlatformSecretRewrapInput,
  parsePlatformSecretRewrapResult,
  PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
  PLATFORM_SECRET_REWRAP_JOB_TYPE,
  platformSecretRewrapIdempotencyKey,
} from './contracts';
import { PlatformSecretRewrapCoordinator } from './coordinator';
import { processNextPlatformSecretRewrapBatch } from './worker';

const db: LobeChatDatabase = await getTestDB();
const oldKeyId = 'vault:test-old';
const targetKeyId = 'vault:test-target';
const requestId = '11111111-1111-4111-8111-111111111111';
const fingerprint = 'a'.repeat(64);
/** Expected rotated row count across all PLATFORM_SECRET_ROTATION_DOMAINS. */
const ROTATION_DOMAIN_ROW_COUNT = 7;

class MutableVaultProvider implements KeyProvider {
  activeKeyId = oldKeyId;
  unavailable = false;
  /** Artificial delay (ms) applied to every getKek call for lease-renewal tests. */
  delayMs = 0;
  readonly providerId = 'vault';
  readonly #keys = new Map([
    [oldKeyId, randomBytes(32)],
    [targetKeyId, randomBytes(32)],
  ]);

  getKek = async (keyId?: string): Promise<KekMaterial> => {
    if (this.delayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, this.delayMs);
      });
    }
    if (this.unavailable) throw secretNotReadable('provider unavailable');
    const resolvedKeyId = keyId ?? this.activeKeyId;
    const key = this.#keys.get(resolvedKeyId);
    if (!key) throw secretNotReadable('historical key unavailable', { reason: 'unknown-key-id' });
    return { key: new Uint8Array(key), keyId: resolvedKeyId };
  };

  /** Simulate historical-key retirement after a successful rewrap. */
  retireKey = (keyId: string) => {
    this.#keys.delete(keyId);
  };

  resetKeys = () => {
    this.#keys.clear();
    this.#keys.set(oldKeyId, randomBytes(32));
    this.#keys.set(targetKeyId, randomBytes(32));
  };
}

const provider = new MutableVaultProvider();
const secrets = new PlatformSecretService({ keyProvider: provider });
const coordinator = new PlatformSecretRewrapCoordinator(secrets);

const cleanup = () =>
  db.execute(sql`
    TRUNCATE TABLE
      ${platformJobs},
      ${platformIdentityProviderTestAttempts},
      ${platformIdentityProviderSecrets},
      ${platformIdentityProviders},
      ${platformConnectorSecrets},
      ${platformConnectors},
      ${platformGlobalCredentialSecrets},
      ${platformGlobalCredentialUploads},
      ${platformGlobalCredentials},
      ${platformAiProviderSecrets},
      ${platformAiProviders}
    CASCADE
  `);

beforeEach(async () => {
  await cleanup();
  provider.activeKeyId = oldKeyId;
  provider.unavailable = false;
  provider.delayMs = 0;
  provider.resetKeys();
});
afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

const encrypt = (value: string) => secrets.encrypt(value);

const seedAllDomains = async () => {
  const aiCiphertext = await encrypt('ai-secret');
  await db.insert(platformAiProviders).values({
    displayName: 'AI provider',
    encryptedKeyVaults: aiCiphertext,
    id: 'ai-a',
    providerKey: 'ai-a',
    secretFingerprint: fingerprint,
    secretKeyId: oldKeyId,
    secretKeyVersion: 1,
  });
  await db.insert(platformAiProviderSecrets).values({
    ciphertext: aiCiphertext,
    fingerprint,
    id: 'ai-version-a',
    keyId: oldKeyId,
    keyVersion: 1,
    providerId: 'ai-a',
  });
  await db.insert(platformConnectors).values({
    connectorKey: 'connector-a',
    displayName: 'Connector A',
    id: 'connector-a',
    legacyName: 'Connector A',
    migrationRequired: true,
  });
  await db.insert(platformConnectorSecrets).values({
    ciphertext: await encrypt('connector-secret'),
    connectorId: 'connector-a',
    fingerprint,
    id: 'connector-secret-a',
    keyId: oldKeyId,
    ref: 'kms://platform-connectors/connector-a/shared',
    revokedAt: new Date(),
    revision: 3,
    slot: 'sharedSecret',
  });
  await db.insert(platformIdentityProviders).values({
    displayName: 'Identity A',
    id: 'identity-a',
    providerKey: 'identity-a',
  });
  await db.insert(platformIdentityProviderSecrets).values({
    ciphertext: await encrypt('identity-secret'),
    fingerprint,
    id: 'identity-secret-a',
    keyId: oldKeyId,
    providerId: 'identity-a',
    ref: 'kms://platform-identity-providers/identity-a/secret',
    revokedAt: new Date(),
    revision: 4,
  });
  const createdAt = new Date(Date.now() - 20 * 60 * 1000);
  await db.insert(platformIdentityProviderTestAttempts).values({
    auditReason: 'secret rewrap test',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
    id: 'identity-test-a',
    nonceHash: 'b'.repeat(64),
    pkceCiphertext: await encrypt('pkce-verifier'),
    pkceKeyId: oldKeyId,
    providerId: 'identity-a',
    providerRevision: 0,
    providerSecretFingerprint: fingerprint,
    providerSecretRef: 'kms://platform-identity-providers/identity-a/secret',
    redirectUri: 'https://example.test/oidc/callback',
    sessionId: 'session-a',
    stateHash: 'c'.repeat(64),
    userId: 'user-a',
  });

  const [credential] = await db
    .insert(platformGlobalCredentials)
    .values({
      key: 'global-a',
      name: 'Global A',
      type: 'kv-env',
    })
    .returning();
  await db.insert(platformGlobalCredentialSecrets).values({
    ciphertext: await encrypt(JSON.stringify({ API_KEY: 'global-secret' })),
    credentialId: credential!.id,
    fingerprint,
    id: 'global-secret-a',
    keyId: oldKeyId,
    ref: 'kms://platform-global-credentials/1/a',
    revision: 1,
  });
  await db.insert(platformGlobalCredentialUploads).values({
    ciphertext: await encrypt('upload-bytes'),
    createdBy: 'admin-a',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    fileHashId: 'd'.repeat(64),
    fileName: 'secret.bin',
    fileSize: 12,
    fileType: 'application/octet-stream',
    fingerprint,
    id: 'global-upload-a',
    keyId: oldKeyId,
    ref: 'kms://platform-global-credentials/upload/a',
  });
};

/** @deprecated alias — keep call sites compiling while migrating. */
const seedFiveDomains = seedAllDomains;

const enqueue = async () => {
  provider.activeKeyId = targetKeyId;
  return coordinator.enqueue(db, {
    reason: 'rotate the active Vault key',
    requestId,
    requestedBy: 'internal-test',
    targetKeyId,
  });
};

const getJob = async (jobId: string) => {
  const [job] = await db.select().from(platformJobs).where(eq(platformJobs.id, jobId)).limit(1);
  if (!job) throw new Error('expected test job');
  return job;
};

const expireLease = (jobId: string) =>
  db
    .update(platformJobs)
    .set({ leaseUntil: new Date(Date.now() - 1000) })
    .where(eq(platformJobs.id, jobId));

const drain = async (batchSize = 50) => {
  for (let index = 0; index < 20; index += 1) {
    const result = await processNextPlatformSecretRewrapBatch(db, secrets, `worker-${index}`, {
      batchSize,
    });
    if (!result.claimed || result.terminal) return result;
  }
  throw new Error('secret rewrap test did not terminate');
};

const expectAllTarget = async () => {
  const [ai] = await db
    .select()
    .from(platformAiProviders)
    .where(eq(platformAiProviders.id, 'ai-a'));
  const [aiImmutable] = await db
    .select()
    .from(platformAiProviderSecrets)
    .where(eq(platformAiProviderSecrets.id, 'ai-version-a'));
  const [connector] = await db
    .select()
    .from(platformConnectorSecrets)
    .where(eq(platformConnectorSecrets.id, 'connector-secret-a'));
  const [identity] = await db
    .select()
    .from(platformIdentityProviderSecrets)
    .where(eq(platformIdentityProviderSecrets.id, 'identity-secret-a'));
  const [pkce] = await db
    .select()
    .from(platformIdentityProviderTestAttempts)
    .where(eq(platformIdentityProviderTestAttempts.id, 'identity-test-a'));
  const [globalSecret] = await db
    .select()
    .from(platformGlobalCredentialSecrets)
    .where(eq(platformGlobalCredentialSecrets.id, 'global-secret-a'));
  const [globalUpload] = await db
    .select()
    .from(platformGlobalCredentialUploads)
    .where(eq(platformGlobalCredentialUploads.id, 'global-upload-a'));
  expect([
    ai.secretKeyId,
    aiImmutable.keyId,
    connector.keyId,
    identity.keyId,
    pkce.pkceKeyId,
    globalSecret.keyId,
    globalUpload.keyId,
  ]).toEqual(Array.from({ length: ROTATION_DOMAIN_ROW_COUNT }, () => targetKeyId));
  expect([
    secrets.peekKeyId(ai.encryptedKeyVaults!),
    secrets.peekKeyId(aiImmutable.ciphertext),
    secrets.peekKeyId(connector.ciphertext),
    secrets.peekKeyId(identity.ciphertext),
    secrets.peekKeyId(pkce.pkceCiphertext),
    secrets.peekKeyId(globalSecret.ciphertext),
    secrets.peekKeyId(globalUpload.ciphertext),
  ]).toEqual(Array.from({ length: ROTATION_DOMAIN_ROW_COUNT }, () => targetKeyId));
  // Post-rotation decryptability of global credential envelopes.
  expect(JSON.parse(await secrets.decrypt(globalSecret.ciphertext))).toEqual({
    API_KEY: 'global-secret',
  });
  expect(await secrets.decrypt(globalUpload.ciphertext)).toBe('upload-bytes');
};

describe('PlatformSecretRewrapCoordinator and worker', () => {
  it('rotates all domains with real envelopes, AI dual synchronization, and cursor resume', async () => {
    await seedAllDomains();
    const job = await enqueue();
    const first = await processNextPlatformSecretRewrapBatch(db, secrets, 'worker-first', {
      batchSize: 2,
    });
    expect(first).toMatchObject({ claimed: true, terminal: false });
    const checkpoint = await getJob(job.jobId);
    expect(checkpoint.status).toBe('pending');
    expect(checkpoint.cursor).toEqual({ domain: 'aiImmutable', lastId: 'ai-version-a' });

    await drain(2);
    const completed = await getJob(job.jobId);
    expect(completed.status).toBe('succeeded');
    expect(parsePlatformSecretRewrapResult(completed.resultSummary)).toMatchObject({
      examined: ROTATION_DOMAIN_ROW_COUNT,
      failed: 0,
      historicalKeyRemovalReady: false,
      noOp: 0,
      rotated: ROTATION_DOMAIN_ROW_COUNT,
    });
    await expectAllTarget();

    const same = await coordinator.enqueue(db, {
      reason: 'a second request for the same target',
      requestId: '22222222-2222-4222-8222-222222222222',
      requestedBy: 'internal-test-2',
      targetKeyId,
    });
    expect(same.jobId).toBe(job.jobId);
    expect(same.status).toBe('succeeded');
  });

  it('rewrapsPlatformGlobalCredentialSecretsAndStagedUploads', async () => {
    await seedAllDomains();
    const beforeSecret = await secrets.decrypt(
      (
        await db
          .select()
          .from(platformGlobalCredentialSecrets)
          .where(eq(platformGlobalCredentialSecrets.id, 'global-secret-a'))
      )[0]!.ciphertext,
    );
    const beforeUpload = await secrets.decrypt(
      (
        await db
          .select()
          .from(platformGlobalCredentialUploads)
          .where(eq(platformGlobalCredentialUploads.id, 'global-upload-a'))
      )[0]!.ciphertext,
    );
    expect(JSON.parse(beforeSecret)).toEqual({ API_KEY: 'global-secret' });
    expect(beforeUpload).toBe('upload-bytes');

    const job = await enqueue();
    await drain();
    const completed = await getJob(job.jobId);
    expect(completed.status).toBe('succeeded');
    await expectAllTarget();

    // Historical key retirement readiness: after rewrap, decrypt with only the target key.
    provider.retireKey(oldKeyId);
    const [globalSecret] = await db
      .select()
      .from(platformGlobalCredentialSecrets)
      .where(eq(platformGlobalCredentialSecrets.id, 'global-secret-a'));
    const [globalUpload] = await db
      .select()
      .from(platformGlobalCredentialUploads)
      .where(eq(platformGlobalCredentialUploads.id, 'global-upload-a'));
    expect(JSON.parse(await secrets.decrypt(globalSecret!.ciphertext))).toEqual({
      API_KEY: 'global-secret',
    });
    expect(await secrets.decrypt(globalUpload!.ciphertext)).toBe('upload-bytes');
  });

  it('treatsRevokedGlobalCredentialBetweenScanAndCasAsNoOp', async () => {
    await seedAllDomains();
    const job = await enqueue();
    let revoked = false;
    await processNextPlatformSecretRewrapBatch(db, secrets, 'worker-revoke-race', {
      lifecycle: {
        beforeCandidateCas: async ({ candidate, db: tx }) => {
          if (candidate.domain !== 'globalCredentialSecret' || revoked) return;
          revoked = true;
          await tx
            .update(platformGlobalCredentialSecrets)
            .set({ revokedAt: new Date() })
            .where(eq(platformGlobalCredentialSecrets.id, candidate.id));
        },
      },
    });
    const completed = await getJob(job.jobId);
    expect(completed.status).toBe('succeeded');
    expect(parsePlatformSecretRewrapResult(completed.resultSummary)).toMatchObject({
      categories: { concurrent_change: 0 },
      failed: 0,
      noOp: 1,
      rotated: ROTATION_DOMAIN_ROW_COUNT - 1,
    });
    // Revoked row stays on the historical key — inventory-excluded, not a failure.
    const [globalSecret] = await db
      .select()
      .from(platformGlobalCredentialSecrets)
      .where(eq(platformGlobalCredentialSecrets.id, 'global-secret-a'));
    expect(globalSecret!.keyId).toBe(oldKeyId);
    expect(globalSecret!.revokedAt).not.toBeNull();
  });

  it('treatsExpiredGlobalCredentialUploadBetweenScanAndCasAsNoOp', async () => {
    await seedAllDomains();
    const job = await enqueue();
    let expired = false;
    await processNextPlatformSecretRewrapBatch(db, secrets, 'worker-expire-race', {
      lifecycle: {
        beforeCandidateCas: async ({ candidate, db: tx }) => {
          if (candidate.domain !== 'globalCredentialUpload' || expired) return;
          expired = true;
          await tx
            .update(platformGlobalCredentialUploads)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(platformGlobalCredentialUploads.id, candidate.id));
        },
      },
    });
    const completed = await getJob(job.jobId);
    expect(completed.status).toBe('succeeded');
    expect(parsePlatformSecretRewrapResult(completed.resultSummary)).toMatchObject({
      categories: { concurrent_change: 0 },
      failed: 0,
      noOp: 1,
      rotated: ROTATION_DOMAIN_ROW_COUNT - 1,
    });
    const [globalUpload] = await db
      .select()
      .from(platformGlobalCredentialUploads)
      .where(eq(platformGlobalCredentialUploads.id, 'global-upload-a'));
    expect(globalUpload!.keyId).toBe(oldKeyId);
  });

  it('resolvesMissingFailureLedgerRowsAsNoOpOnRetry', async () => {
    await seedAllDomains();
    // Seed a parent job already in failed (retry) phase with a ledger pointing at a revoked secret.
    provider.activeKeyId = targetKeyId;
    const [parent] = await db
      .insert(platformJobs)
      .values({
        cursor: null,
        idempotencyKey: platformSecretRewrapIdempotencyKey(targetKeyId),
        input: {
          control: { phase: 'failed', revision: 1 },
          reason: 'retry missing inventory',
          requestId,
          schemaVersion: 1,
          targetKeyId,
        },
        requestedBy: 'internal-test',
        resultSummary: {
          categories: {
            ciphertext_not_readable: 0,
            concurrent_change: 1,
            historical_key_unavailable: 0,
            invalid_ciphertext: 0,
          },
          examined: 1,
          externalArtifactGate: 'identity_lkg_instance_convergence_required',
          failed: 1,
          historicalKeyRemovalReady: false,
          noOp: 0,
          rotated: 0,
          schemaVersion: 1,
        },
        status: 'pending',
        type: PLATFORM_SECRET_REWRAP_JOB_TYPE,
      })
      .returning();
    await db.insert(platformJobs).values({
      idempotencyKey: `${parent!.id}:globalCredentialSecret:global-secret-a`,
      input: {
        category: 'concurrent_change',
        domain: 'globalCredentialSecret',
        parentJobId: parent!.id,
        parentRevision: 1,
        requestId,
        rowId: 'global-secret-a',
        schemaVersion: 1,
        targetKeyId,
      },
      requestedBy: 'internal-test',
      status: 'failed',
      type: PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
    });
    await db
      .update(platformGlobalCredentialSecrets)
      .set({ revokedAt: new Date() })
      .where(eq(platformGlobalCredentialSecrets.id, 'global-secret-a'));

    await drain();
    const completed = await getJob(parent!.id);
    expect(completed.status).toBe('succeeded');
    expect(parsePlatformSecretRewrapResult(completed.resultSummary)).toMatchObject({
      categories: { concurrent_change: 0 },
      failed: 0,
      noOp: 1,
    });
    const ledgers = await db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_FAILURE_TYPE),
          eq(platformJobs.status, 'failed'),
        ),
      );
    expect(ledgers).toHaveLength(0);
  });

  it('renewsLeaseDuringSlowVaultBatch', async () => {
    await seedAllDomains();
    // Each candidate performs multiple getKek calls; a per-call delay that would
    // exceed a short lease without mid-batch renewals proves the renew path.
    provider.delayMs = 50;
    const job = await enqueue();
    const result = await processNextPlatformSecretRewrapBatch(db, secrets, 'worker-slow', {
      batchSize: 3,
      leaseMs: 120,
    });
    expect(result).toMatchObject({ claimed: true, terminal: false });
    const checkpoint = await getJob(job.jobId);
    expect(checkpoint.status).toBe('pending');
    expect(parsePlatformSecretRewrapResult(checkpoint.resultSummary).rotated).toBeGreaterThan(0);

    // Drain remaining batches with a normal provider.
    provider.delayMs = 0;
    await drain(3);
    const completed = await getJob(job.jobId);
    expect(completed.status).toBe('succeeded');
    expect(parsePlatformSecretRewrapResult(completed.resultSummary)).toMatchObject({
      examined: ROTATION_DOMAIN_ROW_COUNT,
      failed: 0,
      rotated: ROTATION_DOMAIN_ROW_COUNT,
    });
  }, 60_000);

  it('checkpointsWhenSingleProviderCallExceedsLease', async () => {
    await seedAllDomains();
    // One awaited getKek longer than leaseMs — checkpoint must still succeed
    // (ownership under FOR UPDATE, no leaseUntil>now predicate).
    provider.delayMs = 200;
    const job = await enqueue();
    const result = await processNextPlatformSecretRewrapBatch(db, secrets, 'worker-long-call', {
      batchSize: 1,
      leaseMs: 50,
    });
    expect(result).toMatchObject({ claimed: true, terminal: false });
    const checkpoint = await getJob(job.jobId);
    expect(checkpoint.status).toBe('pending');
    expect(parsePlatformSecretRewrapResult(checkpoint.resultSummary).rotated).toBe(1);

    provider.delayMs = 0;
    await drain(1);
    const completed = await getJob(job.jobId);
    expect(completed.status).toBe('succeeded');
  }, 60_000);

  it('requeuesRewrapWhenSucceededJobPredatesDomainSetExpansion', async () => {
    await seedAllDomains();
    provider.activeKeyId = targetKeyId;
    // Simulate a pre-fix succeeded job that used the unversioned idempotency key
    // and therefore never scanned global credential domains.
    await db.insert(platformJobs).values({
      finishedAt: new Date(),
      idempotencyKey: `rewrap:${targetKeyId}`,
      input: {
        control: { phase: 'scan', revision: 1 },
        reason: 'legacy pre-domain-set rewrap',
        requestId: '99999999-9999-4999-8999-999999999999',
        schemaVersion: 1,
        targetKeyId,
      },
      requestedBy: 'legacy',
      resultSummary: {
        categories: {
          ciphertext_not_readable: 0,
          concurrent_change: 0,
          historical_key_unavailable: 0,
          invalid_ciphertext: 0,
        },
        examined: 5,
        externalArtifactGate: 'identity_lkg_instance_convergence_required',
        failed: 0,
        historicalKeyRemovalReady: false,
        noOp: 0,
        rotated: 5,
        schemaVersion: 1,
      },
      status: 'succeeded',
      type: PLATFORM_SECRET_REWRAP_JOB_TYPE,
    });

    const job = await enqueue();
    expect(job.status).toBe('pending');
    // New domain-set version must not reuse the legacy idempotency key.
    expect(platformSecretRewrapIdempotencyKey(targetKeyId)).toMatch(/^rewrap:d2:/);
    const [row] = await db.select().from(platformJobs).where(eq(platformJobs.id, job.jobId));
    expect(row!.idempotencyKey).toBe(platformSecretRewrapIdempotencyKey(targetKeyId));
    expect(row!.idempotencyKey).not.toBe(`rewrap:${targetKeyId}`);

    await drain();
    const completed = await getJob(job.jobId);
    expect(completed.status).toBe('succeeded');
    await expectAllTarget();
  });

  it('isolates a malformed row, retries exactly its failed ledger, and preserves safe output', async () => {
    await seedAllDomains();
    await db
      .update(platformConnectorSecrets)
      .set({ ciphertext: 'malformed-envelope' })
      .where(eq(platformConnectorSecrets.id, 'connector-secret-a'));
    const job = await enqueue();
    await drain();
    const failed = await getJob(job.jobId);
    expect(failed.status).toBe('failed');
    expect(parsePlatformSecretRewrapResult(failed.resultSummary)).toMatchObject({
      categories: { invalid_ciphertext: 1 },
      examined: ROTATION_DOMAIN_ROW_COUNT,
      failed: 1,
      rotated: ROTATION_DOMAIN_ROW_COUNT - 1,
    });
    expect(JSON.stringify(failed.resultSummary)).not.toMatch(
      /"(?:rowId|ciphertext|fingerprint|provider|ref)"/i,
    );
    const ledgers = await db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_FAILURE_TYPE),
          eq(platformJobs.status, 'failed'),
        ),
      );
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]!.lastError).toEqual({ category: 'invalid_ciphertext' });

    provider.activeKeyId = oldKeyId;
    const repaired = await encrypt('connector-secret-repaired');
    provider.activeKeyId = targetKeyId;
    await db
      .update(platformConnectorSecrets)
      .set({ ciphertext: repaired, keyId: oldKeyId })
      .where(eq(platformConnectorSecrets.id, 'connector-secret-a'));
    const revision = parsePlatformSecretRewrapInput(failed).control.revision;
    await coordinator.retry(db, {
      expectedRevision: revision,
      expectedStatus: 'failed',
      jobId: job.jobId,
    });
    await drain();
    const retried = await getJob(job.jobId);
    expect(retried.status).toBe('succeeded');
    expect(parsePlatformSecretRewrapResult(retried.resultSummary)).toMatchObject({
      categories: { invalid_ciphertext: 0 },
      examined: ROTATION_DOMAIN_ROW_COUNT,
      failed: 0,
      rotated: ROTATION_DOMAIN_ROW_COUNT,
    });
  });

  it('treats a concurrent replacement already at target as a no-op', async () => {
    await seedFiveDomains();
    const job = await enqueue();
    const targetCiphertext = await encrypt('replacement-at-target');
    let replaced = false;
    await processNextPlatformSecretRewrapBatch(db, secrets, 'worker-cas', {
      lifecycle: {
        beforeCandidateCas: async ({ candidate, db: tx }) => {
          if (candidate.domain !== 'connector' || replaced) return;
          replaced = true;
          await tx
            .update(platformConnectorSecrets)
            .set({ ciphertext: targetCiphertext, keyId: targetKeyId, revision: 4 })
            .where(eq(platformConnectorSecrets.id, candidate.id));
        },
      },
    });
    const completed = await getJob(job.jobId);
    expect(completed.status).toBe('succeeded');
    expect(parsePlatformSecretRewrapResult(completed.resultSummary)).toMatchObject({
      failed: 0,
      noOp: 1,
      rotated: ROTATION_DOMAIN_ROW_COUNT - 1,
    });
  });

  it('cancels safely after claim without rolling back already stored rows', async () => {
    await seedFiveDomains();
    const job = await enqueue();
    const result = await processNextPlatformSecretRewrapBatch(db, secrets, 'worker-cancel', {
      lifecycle: {
        afterClaim: async (claimed) => {
          const input = parsePlatformSecretRewrapInput(claimed);
          await coordinator.cancel(db, {
            expectedRevision: input.control.revision,
            expectedStatus: 'running',
            jobId: claimed.id,
          });
        },
      },
    });
    expect(result).toMatchObject({ claimed: true, terminal: false });
    expect((await getJob(job.jobId)).status).toBe('cancelled');
    const [connector] = await db
      .select()
      .from(platformConnectorSecrets)
      .where(eq(platformConnectorSecrets.id, 'connector-secret-a'));
    expect(connector.keyId).toBe(oldKeyId);
    expect(await secrets.decrypt(connector.ciphertext)).toBe('connector-secret');
  });

  it('rolls back data and checkpoint together, then reclaims an expired lease', async () => {
    await seedFiveDomains();
    const job = await enqueue();
    await expect(
      processNextPlatformSecretRewrapBatch(db, secrets, 'worker-crash', {
        lifecycle: {
          beforeCheckpoint: async () => {
            throw new Error('injected checkpoint failure');
          },
        },
      }),
    ).rejects.toThrow('injected checkpoint failure');
    const claimed = await getJob(job.jobId);
    expect(claimed.status).toBe('running');
    expect(claimed.cursor).toBeNull();
    const [connector] = await db
      .select()
      .from(platformConnectorSecrets)
      .where(eq(platformConnectorSecrets.id, 'connector-secret-a'));
    expect(connector.keyId).toBe(oldKeyId);

    await expireLease(job.jobId);
    await drain();
    expect((await getJob(job.jobId)).status).toBe('succeeded');
    await expectAllTarget();
  });

  it('rolls back the whole batch on Vault outage or active-key drift', async () => {
    await seedFiveDomains();
    const outageJob = await enqueue();
    provider.unavailable = true;
    await expect(
      processNextPlatformSecretRewrapBatch(db, secrets, 'worker-outage'),
    ).rejects.toThrow('PLATFORM_SECRET_REWRAP_VAULT_UNAVAILABLE');
    provider.unavailable = false;
    expect((await getJob(outageJob.jobId)).cursor).toBeNull();
    await expireLease(outageJob.jobId);
    await drain();

    await cleanup();
    provider.activeKeyId = oldKeyId;
    await seedFiveDomains();
    const driftJob = await enqueue();
    await expect(
      processNextPlatformSecretRewrapBatch(db, secrets, 'worker-drift', {
        lifecycle: {
          afterClaim: async () => {
            provider.activeKeyId = oldKeyId;
          },
        },
      }),
    ).rejects.toThrow('PLATFORM_SECRET_REWRAP_ACTIVE_KEY_CHANGED');
    expect((await getJob(driftJob.jobId)).cursor).toBeNull();
  });

  it('rejects env-backed enqueue and prevents a second worker from stealing a live lease', async () => {
    const envService = new PlatformSecretService({
      keyProvider: { getKek: provider.getKek, providerId: 'env' },
    });
    const envCoordinator = new PlatformSecretRewrapCoordinator(envService);
    await expect(
      envCoordinator.enqueue(db, {
        reason: 'must be rejected',
        requestId,
        requestedBy: 'internal-test',
        targetKeyId,
      }),
    ).rejects.toThrow('PLATFORM_SECRET_REWRAP_VAULT_REQUIRED');

    await seedFiveDomains();
    await enqueue();
    let competingClaim:
      Awaited<ReturnType<typeof processNextPlatformSecretRewrapBatch>> | undefined;
    await processNextPlatformSecretRewrapBatch(db, secrets, 'worker-owner', {
      batchSize: 1,
      lifecycle: {
        afterClaim: async () => {
          competingClaim = await processNextPlatformSecretRewrapBatch(
            db,
            secrets,
            'worker-contender',
          );
        },
      },
    });
    expect(competingClaim).toEqual({ claimed: false });
  });

  it('protects a DB-live lease and reclaims it only after DB expiry', async () => {
    await seedFiveDomains();
    const job = await enqueue();
    await db
      .update(platformJobs)
      .set({
        heartbeatAt: sql`clock_timestamp()`,
        leaseOwner: 'existing-owner',
        leaseUntil: sql`clock_timestamp() + interval '1 hour'`,
        startedAt: sql`clock_timestamp()`,
        status: 'running',
      })
      .where(eq(platformJobs.id, job.jobId));

    await expect(
      processNextPlatformSecretRewrapBatch(db, secrets, 'live-lease-contender'),
    ).resolves.toEqual({ claimed: false });

    await db
      .update(platformJobs)
      .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(platformJobs.id, job.jobId));
    let reclaimedClaim: typeof platformJobs.$inferSelect | undefined;
    await expect(
      processNextPlatformSecretRewrapBatch(db, secrets, 'expired-lease-reclaimer', {
        lifecycle: {
          afterClaim: async (claimed) => {
            reclaimedClaim = claimed;
          },
        },
      }),
    ).resolves.toMatchObject({ claimed: true, terminal: true });

    expect(reclaimedClaim).toBeDefined();
    expect(reclaimedClaim!.heartbeatAt!.getUTCFullYear()).toBeGreaterThan(2025);
    expect(reclaimedClaim!.leaseUntil!.getTime()).toBeGreaterThan(
      reclaimedClaim!.heartbeatAt!.getTime(),
    );
    const completed = await getJob(job.jobId);
    expect(completed.status).toBe('succeeded');
    expect(completed.leaseOwner).toBeNull();
  });
});
