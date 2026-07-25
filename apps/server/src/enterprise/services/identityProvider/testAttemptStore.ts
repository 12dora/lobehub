import { createHash, randomBytes } from 'node:crypto';

import type { PlatformIdentityProviderClaimPreview } from '@lobechat/types';
import { and, asc, eq, exists, gt, inArray, lte, or } from 'drizzle-orm';

import {
  platformIdentityProviders,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { PlatformSecretService } from '../../security/secret';

const ATTEMPT_TTL_MS = 5 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 500;
const STATE_PREFIX = 'aihub-m11-test-v1.';

/** Callbacks normally finish in seconds; this lease leaves ample room for bounded OIDC requests. */
export const IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS = 10 * 60 * 1000;
/** Keep a completed preview briefly so the initiating admin session can fetch it. */
export const IDENTITY_PROVIDER_TEST_TERMINAL_RETENTION_MS = 10 * 60 * 1000;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const randomToken = (): string => randomBytes(32).toString('base64url');

export class IdentityProviderTestAttemptError extends Error {
  constructor(
    public readonly code:
      | 'OIDC_TEST_EXPIRED'
      | 'OIDC_TEST_CLAIM_VALIDATION_FAILED'
      | 'OIDC_TEST_INVALID_STATE'
      | 'OIDC_TEST_PROVIDER_CHANGED'
      | 'OIDC_TEST_REPLAYED',
  ) {
    super(code);
    this.name = 'IdentityProviderTestAttemptError';
  }
}

export interface ReservedIdentityProviderTestAttempt {
  auditReason: string;
  expiresAt: Date;
  id: string;
  nonceHash: string;
  pkceVerifier: string;
  providerId: string;
  providerRevision: number;
  providerSecretFingerprint: string;
  providerSecretRef: string;
  redirectUri: string;
  userId: string;
}

type DatabaseExecutor = LobeChatDatabase | Transaction;

const cleanupEligible = (now: Date) => {
  const processingLeaseCutoff = new Date(
    now.getTime() - IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS,
  );
  const terminalRetentionCutoff = new Date(
    now.getTime() - IDENTITY_PROVIDER_TEST_TERMINAL_RETENTION_MS,
  );
  return or(
    and(
      eq(platformIdentityProviderTestAttempts.status, 'pending'),
      lte(platformIdentityProviderTestAttempts.expiresAt, now),
    ),
    and(
      eq(platformIdentityProviderTestAttempts.status, 'processing'),
      lte(platformIdentityProviderTestAttempts.reservedAt, processingLeaseCutoff),
    ),
    and(
      inArray(platformIdentityProviderTestAttempts.status, ['failed', 'succeeded']),
      lte(platformIdentityProviderTestAttempts.completedAt, terminalRetentionCutoff),
    ),
  );
};

/**
 * Bounded lifecycle reaper. The lifecycle predicate is repeated on the outer DELETE so PostgreSQL
 * rechecks it after a concurrent callback releases its row lock. Callback and reaper therefore
 * have one winner: a fresh terminal outcome survives, while a reaped lease cannot be completed.
 */
export const cleanupExpiredIdentityProviderTestAttempts = async (
  db: DatabaseExecutor,
  limit = CLEANUP_BATCH_SIZE,
  now = new Date(),
): Promise<number> => {
  const boundedLimit = Math.max(1, Math.min(limit, CLEANUP_BATCH_SIZE));
  const expiredIds = db
    .select({ id: platformIdentityProviderTestAttempts.id })
    .from(platformIdentityProviderTestAttempts)
    .where(cleanupEligible(now))
    .orderBy(asc(platformIdentityProviderTestAttempts.expiresAt))
    .limit(boundedLimit);
  const deleted = await db
    .delete(platformIdentityProviderTestAttempts)
    .where(and(inArray(platformIdentityProviderTestAttempts.id, expiredIds), cleanupEligible(now)))
    .returning({ id: platformIdentityProviderTestAttempts.id });
  return deleted.length;
};

/** Durable, one-shot state store. State/nonce are persisted only as SHA-256 digests. */
export class IdentityProviderTestAttemptStore {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly secrets: PlatformSecretService,
  ) {}

  issue = async (input: {
    auditReason: string;
    providerId: string;
    providerRevision: number;
    providerSecretFingerprint: string;
    providerSecretRef: string;
    redirectUri: string;
    sessionId: string;
    userId: string;
  }) => {
    const state = `${STATE_PREFIX}${randomToken()}`;
    const nonce = randomToken();
    const pkceVerifier = randomToken();
    const pkceCiphertext = await this.secrets.encrypt(pkceVerifier);
    const expiresAt = new Date(Date.now() + ATTEMPT_TTL_MS);
    const [attempt] = await this.db
      .insert(platformIdentityProviderTestAttempts)
      .values({
        auditReason: input.auditReason,
        expiresAt,
        nonceHash: digest(nonce),
        pkceCiphertext,
        pkceKeyId: this.secrets.peekKeyId(pkceCiphertext),
        providerId: input.providerId,
        providerRevision: input.providerRevision,
        providerSecretFingerprint: input.providerSecretFingerprint,
        providerSecretRef: input.providerSecretRef,
        redirectUri: input.redirectUri,
        sessionId: input.sessionId,
        stateHash: digest(state),
        userId: input.userId,
      })
      .returning({ id: platformIdentityProviderTestAttempts.id });
    return {
      attemptId: attempt.id,
      codeChallenge: createHash('sha256').update(pkceVerifier).digest('base64url'),
      expiresAt,
      nonce,
      state,
    };
  };

  reserve = async (state: string): Promise<ReservedIdentityProviderTestAttempt> => {
    if (!state.startsWith(STATE_PREFIX) || state.length > 256) {
      throw new IdentityProviderTestAttemptError('OIDC_TEST_INVALID_STATE');
    }
    const now = new Date();
    const [row] = await this.db
      .update(platformIdentityProviderTestAttempts)
      .set({ reservedAt: now, status: 'processing', updatedAt: now })
      .where(
        and(
          eq(platformIdentityProviderTestAttempts.stateHash, digest(state)),
          eq(platformIdentityProviderTestAttempts.status, 'pending'),
          gt(platformIdentityProviderTestAttempts.expiresAt, now),
        ),
      )
      .returning({
        auditReason: platformIdentityProviderTestAttempts.auditReason,
        expiresAt: platformIdentityProviderTestAttempts.expiresAt,
        id: platformIdentityProviderTestAttempts.id,
        nonceHash: platformIdentityProviderTestAttempts.nonceHash,
        pkceCiphertext: platformIdentityProviderTestAttempts.pkceCiphertext,
        providerId: platformIdentityProviderTestAttempts.providerId,
        providerRevision: platformIdentityProviderTestAttempts.providerRevision,
        providerSecretFingerprint: platformIdentityProviderTestAttempts.providerSecretFingerprint,
        providerSecretRef: platformIdentityProviderTestAttempts.providerSecretRef,
        redirectUri: platformIdentityProviderTestAttempts.redirectUri,
        userId: platformIdentityProviderTestAttempts.userId,
      });
    if (!row) {
      const [existing] = await this.db
        .select({
          expiresAt: platformIdentityProviderTestAttempts.expiresAt,
          status: platformIdentityProviderTestAttempts.status,
        })
        .from(platformIdentityProviderTestAttempts)
        .where(eq(platformIdentityProviderTestAttempts.stateHash, digest(state)))
        .limit(1);
      if (!existing) throw new IdentityProviderTestAttemptError('OIDC_TEST_INVALID_STATE');
      if (existing.expiresAt <= now)
        throw new IdentityProviderTestAttemptError('OIDC_TEST_EXPIRED');
      throw new IdentityProviderTestAttemptError('OIDC_TEST_REPLAYED');
    }
    try {
      return {
        auditReason: row.auditReason,
        expiresAt: row.expiresAt,
        id: row.id,
        nonceHash: row.nonceHash,
        pkceVerifier: await this.secrets.decrypt(row.pkceCiphertext),
        providerId: row.providerId,
        providerRevision: row.providerRevision,
        providerSecretFingerprint: row.providerSecretFingerprint,
        providerSecretRef: row.providerSecretRef,
        redirectUri: row.redirectUri,
        userId: row.userId,
      };
    } catch {
      await this.fail(row.id, 'OIDC_TEST_SECRET_UNAVAILABLE');
      throw new IdentityProviderTestAttemptError('OIDC_TEST_INVALID_STATE');
    }
  };

  succeed = async (
    attempt: ReservedIdentityProviderTestAttempt,
    result: PlatformIdentityProviderClaimPreview,
  ): Promise<void> => {
    if (!result.valid) {
      await this.fail(attempt.id, 'OIDC_TEST_CLAIM_VALIDATION_FAILED');
      throw new IdentityProviderTestAttemptError('OIDC_TEST_CLAIM_VALIDATION_FAILED');
    }
    const now = new Date();
    if (attempt.expiresAt <= now) {
      await this.fail(attempt.id, 'OIDC_TEST_EXPIRED');
      throw new IdentityProviderTestAttemptError('OIDC_TEST_EXPIRED');
    }
    const [updated] = await this.db
      .update(platformIdentityProviderTestAttempts)
      .set({ completedAt: now, result, status: 'succeeded', updatedAt: now })
      .where(
        and(
          eq(platformIdentityProviderTestAttempts.id, attempt.id),
          eq(platformIdentityProviderTestAttempts.status, 'processing'),
          gt(platformIdentityProviderTestAttempts.expiresAt, now),
          exists(
            this.db
              .select({ id: platformIdentityProviders.id })
              .from(platformIdentityProviders)
              .where(
                and(
                  eq(platformIdentityProviders.id, attempt.providerId),
                  eq(platformIdentityProviders.revision, attempt.providerRevision),
                  eq(platformIdentityProviders.status, 'draft'),
                  eq(platformIdentityProviders.migrationRequired, false),
                  eq(platformIdentityProviders.secretRef, attempt.providerSecretRef),
                  eq(
                    platformIdentityProviders.secretFingerprint,
                    attempt.providerSecretFingerprint,
                  ),
                ),
              ),
          ),
        ),
      )
      .returning({ id: platformIdentityProviderTestAttempts.id });
    if (!updated) {
      const [current] = await this.db
        .select({
          expiresAt: platformIdentityProviderTestAttempts.expiresAt,
          status: platformIdentityProviderTestAttempts.status,
        })
        .from(platformIdentityProviderTestAttempts)
        .where(eq(platformIdentityProviderTestAttempts.id, attempt.id))
        .limit(1);
      if (current?.status === 'processing' && current.expiresAt <= now) {
        await this.fail(attempt.id, 'OIDC_TEST_EXPIRED');
        throw new IdentityProviderTestAttemptError('OIDC_TEST_EXPIRED');
      }
      throw new IdentityProviderTestAttemptError('OIDC_TEST_PROVIDER_CHANGED');
    }
  };

  fail = async (attemptId: string, errorCode: string): Promise<boolean> => {
    const safeCode = /^[A-Z0-9_]{1,128}$/.test(errorCode) ? errorCode : 'OIDC_TEST_FAILED';
    const now = new Date();
    const failed = await this.db
      .update(platformIdentityProviderTestAttempts)
      .set({ completedAt: now, errorCode: safeCode, status: 'failed', updatedAt: now })
      .where(
        and(
          eq(platformIdentityProviderTestAttempts.id, attemptId),
          eq(platformIdentityProviderTestAttempts.status, 'processing'),
        ),
      )
      .returning({ id: platformIdentityProviderTestAttempts.id });
    return failed.length === 1;
  };

  getResult = async (input: { attemptId: string; sessionId: string; userId: string }) => {
    const [row] = await this.db
      .select({
        attemptId: platformIdentityProviderTestAttempts.id,
        boundProviderId: platformIdentityProviders.id,
        errorCode: platformIdentityProviderTestAttempts.errorCode,
        result: platformIdentityProviderTestAttempts.result,
        status: platformIdentityProviderTestAttempts.status,
      })
      .from(platformIdentityProviderTestAttempts)
      .leftJoin(
        platformIdentityProviders,
        and(
          eq(platformIdentityProviders.id, platformIdentityProviderTestAttempts.providerId),
          eq(
            platformIdentityProviders.revision,
            platformIdentityProviderTestAttempts.providerRevision,
          ),
          eq(platformIdentityProviders.status, 'draft'),
          eq(platformIdentityProviders.migrationRequired, false),
          eq(
            platformIdentityProviders.secretRef,
            platformIdentityProviderTestAttempts.providerSecretRef,
          ),
          eq(
            platformIdentityProviders.secretFingerprint,
            platformIdentityProviderTestAttempts.providerSecretFingerprint,
          ),
        ),
      )
      .where(
        and(
          eq(platformIdentityProviderTestAttempts.id, input.attemptId),
          eq(platformIdentityProviderTestAttempts.sessionId, input.sessionId),
          eq(platformIdentityProviderTestAttempts.userId, input.userId),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    if (row.status === 'succeeded' && !row.boundProviderId) {
      return {
        attemptId: row.attemptId,
        errorCode: 'OIDC_TEST_PROVIDER_CHANGED',
        result: null,
        status: 'failed' as const,
      };
    }
    return {
      attemptId: row.attemptId,
      errorCode: row.errorCode,
      result: row.result,
      status: row.status,
    };
  };

  cleanupExpired = async (limit = CLEANUP_BATCH_SIZE, now = new Date()): Promise<number> =>
    cleanupExpiredIdentityProviderTestAttempts(this.db, limit, now);
}
