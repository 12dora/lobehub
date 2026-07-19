import { createHash, randomBytes } from 'node:crypto';

import type { PlatformIdentityProviderClaimPreview } from '@lobechat/types';
import { and, eq, gt } from 'drizzle-orm';

import { platformIdentityProviderTestAttempts } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { PlatformSecretService } from '../../security/secret';

const ATTEMPT_TTL_MS = 5 * 60 * 1000;
const STATE_PREFIX = 'aihub-m11-test-v1.';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const randomToken = (): string => randomBytes(32).toString('base64url');

export class IdentityProviderTestAttemptError extends Error {
  constructor(
    public readonly code: 'OIDC_TEST_EXPIRED' | 'OIDC_TEST_INVALID_STATE' | 'OIDC_TEST_REPLAYED',
  ) {
    super(code);
    this.name = 'IdentityProviderTestAttemptError';
  }
}

export interface ReservedIdentityProviderTestAttempt {
  id: string;
  nonceHash: string;
  pkceVerifier: string;
  providerId: string;
  providerRevision: number;
  redirectUri: string;
}

/** Durable, one-shot state store. State/nonce are persisted only as SHA-256 digests. */
export class IdentityProviderTestAttemptStore {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly secrets: PlatformSecretService,
  ) {}

  issue = async (input: {
    providerId: string;
    providerRevision: number;
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
        expiresAt,
        nonceHash: digest(nonce),
        pkceCiphertext,
        pkceKeyId: this.secrets.peekKeyId(pkceCiphertext),
        providerId: input.providerId,
        providerRevision: input.providerRevision,
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
        id: platformIdentityProviderTestAttempts.id,
        nonceHash: platformIdentityProviderTestAttempts.nonceHash,
        pkceCiphertext: platformIdentityProviderTestAttempts.pkceCiphertext,
        providerId: platformIdentityProviderTestAttempts.providerId,
        providerRevision: platformIdentityProviderTestAttempts.providerRevision,
        redirectUri: platformIdentityProviderTestAttempts.redirectUri,
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
        id: row.id,
        nonceHash: row.nonceHash,
        pkceVerifier: await this.secrets.decrypt(row.pkceCiphertext),
        providerId: row.providerId,
        providerRevision: row.providerRevision,
        redirectUri: row.redirectUri,
      };
    } catch {
      await this.fail(row.id, 'OIDC_TEST_SECRET_UNAVAILABLE');
      throw new IdentityProviderTestAttemptError('OIDC_TEST_INVALID_STATE');
    }
  };

  succeed = async (
    attemptId: string,
    result: PlatformIdentityProviderClaimPreview,
  ): Promise<void> => {
    const now = new Date();
    const [updated] = await this.db
      .update(platformIdentityProviderTestAttempts)
      .set({ completedAt: now, result, status: 'succeeded', updatedAt: now })
      .where(
        and(
          eq(platformIdentityProviderTestAttempts.id, attemptId),
          eq(platformIdentityProviderTestAttempts.status, 'processing'),
        ),
      )
      .returning({ id: platformIdentityProviderTestAttempts.id });
    if (!updated) throw new IdentityProviderTestAttemptError('OIDC_TEST_REPLAYED');
  };

  fail = async (attemptId: string, errorCode: string): Promise<void> => {
    const safeCode = /^[A-Z0-9_]{1,128}$/.test(errorCode) ? errorCode : 'OIDC_TEST_FAILED';
    const now = new Date();
    await this.db
      .update(platformIdentityProviderTestAttempts)
      .set({ completedAt: now, errorCode: safeCode, status: 'failed', updatedAt: now })
      .where(
        and(
          eq(platformIdentityProviderTestAttempts.id, attemptId),
          eq(platformIdentityProviderTestAttempts.status, 'processing'),
        ),
      );
  };

  getResult = async (input: { attemptId: string; sessionId: string; userId: string }) => {
    const [row] = await this.db
      .select({
        attemptId: platformIdentityProviderTestAttempts.id,
        errorCode: platformIdentityProviderTestAttempts.errorCode,
        result: platformIdentityProviderTestAttempts.result,
        status: platformIdentityProviderTestAttempts.status,
      })
      .from(platformIdentityProviderTestAttempts)
      .where(
        and(
          eq(platformIdentityProviderTestAttempts.id, input.attemptId),
          eq(platformIdentityProviderTestAttempts.sessionId, input.sessionId),
          eq(platformIdentityProviderTestAttempts.userId, input.userId),
        ),
      )
      .limit(1);
    return row;
  };
}

export const hashIdentityProviderTestValue = digest;
