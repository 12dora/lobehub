import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { platformBrandingOperations } from '@/database/schemas/platform';
import type {
  PlatformBrandingOperationErrorCategory,
  PlatformBrandingOperationItem,
  PlatformBrandingOperationResult,
} from '@/database/schemas/platform/branding';
import type { LobeChatDatabase, Transaction } from '@/database/type';

const OPERATION_LEASE_MS = 5 * 60 * 1000;

export type BrandingOperationName = 'admin.branding.save' | 'admin.branding.uploadAsset';

export interface BrandingOperationClaim {
  fingerprint: string;
  id: string;
  owner: string;
}

interface AcquiredBrandingOperation {
  claim: BrandingOperationClaim;
  state: 'acquired';
}

interface FailedBrandingOperation {
  errorCategory: PlatformBrandingOperationErrorCategory;
  state: 'failed';
}

interface PendingBrandingOperation {
  state: 'pending';
}

interface SucceededBrandingOperation {
  result: PlatformBrandingOperationResult;
  state: 'succeeded';
}

export type BrandingOperationClaimResult =
  | AcquiredBrandingOperation
  | FailedBrandingOperation
  | PendingBrandingOperation
  | SucceededBrandingOperation;

export class BrandingIdempotencyConflictError extends Error {
  constructor() {
    super('BRANDING_IDEMPOTENCY_CONFLICT');
    this.name = 'BrandingIdempotencyConflictError';
  }
}

export class BrandingOperationInProgressError extends Error {
  constructor() {
    super('BRANDING_OPERATION_IN_PROGRESS');
    this.name = 'BrandingOperationInProgressError';
  }
}

export class BrandingOperationOwnershipLostError extends Error {
  constructor() {
    super('BRANDING_OPERATION_OWNERSHIP_LOST');
    this.name = 'BrandingOperationOwnershipLostError';
  }
}

export class BrandingOperationRecoveryPendingError extends Error {
  constructor() {
    super('BRANDING_OPERATION_RECOVERY_PENDING');
    this.name = 'BrandingOperationRecoveryPendingError';
  }
}

export class BrandingOperationFailedReplayError extends Error {
  constructor(readonly category: PlatformBrandingOperationErrorCategory) {
    super(`BRANDING_OPERATION_FAILED:${category}`);
    this.name = 'BrandingOperationFailedReplayError';
  }
}

export interface AdminBrandingOperationServiceOptions {
  now?: () => Date;
}

export class AdminBrandingOperationService {
  private readonly db: LobeChatDatabase;
  private readonly now: () => Date;

  constructor(db: LobeChatDatabase, options: AdminBrandingOperationServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
  }

  private acquireLaneLock = async (
    tx: Transaction,
    params: {
      actorId: string;
      operation: BrandingOperationName;
      requestId: string;
      resource: string;
    },
  ): Promise<void> => {
    const lane = `${params.actorId}:${params.operation}:${params.resource}:${params.requestId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lane})::bigint)`);
  };

  claim = async (params: {
    actorId: string;
    fingerprint: string;
    operation: BrandingOperationName;
    requestId: string;
    resource: string;
  }): Promise<BrandingOperationClaimResult> =>
    this.db.transaction(async (tx) => {
      await this.acquireLaneLock(tx, params);
      const [existing] = await tx
        .select()
        .from(platformBrandingOperations)
        .where(
          and(
            eq(platformBrandingOperations.actorId, params.actorId),
            eq(platformBrandingOperations.operation, params.operation),
            eq(platformBrandingOperations.resource, params.resource),
            eq(platformBrandingOperations.requestId, params.requestId),
          ),
        )
        .limit(1);

      if (existing) return this.resolveExisting(tx, existing, params.fingerprint);

      const owner = randomUUID();
      const now = this.now();
      const [created] = await tx
        .insert(platformBrandingOperations)
        .values({
          actorId: params.actorId,
          fingerprint: params.fingerprint,
          leaseOwner: owner,
          leaseUntil: new Date(now.getTime() + OPERATION_LEASE_MS),
          operation: params.operation,
          requestId: params.requestId,
          resource: params.resource,
          status: 'pending',
        })
        .returning({ id: platformBrandingOperations.id });
      return {
        claim: { fingerprint: params.fingerprint, id: created.id, owner },
        state: 'acquired',
      };
    });

  private resolveExisting = async (
    tx: Transaction,
    existing: PlatformBrandingOperationItem,
    fingerprint: string,
  ): Promise<BrandingOperationClaimResult> => {
    if (existing.fingerprint !== fingerprint) throw new BrandingIdempotencyConflictError();
    if (existing.status === 'succeeded') {
      if (!existing.result) throw new BrandingOperationRecoveryPendingError();
      return { result: existing.result, state: 'succeeded' };
    }
    if (existing.status === 'failed') {
      if (!existing.errorCategory) throw new BrandingOperationRecoveryPendingError();
      return { errorCategory: existing.errorCategory, state: 'failed' };
    }

    const now = this.now();
    if (existing.leaseUntil && existing.leaseUntil > now) return { state: 'pending' };
    const owner = randomUUID();
    const [recovered] = await tx
      .update(platformBrandingOperations)
      .set({
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + OPERATION_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(platformBrandingOperations.id, existing.id),
          eq(platformBrandingOperations.status, 'pending'),
          eq(platformBrandingOperations.leaseOwner, existing.leaseOwner!),
        ),
      )
      .returning({ id: platformBrandingOperations.id });
    if (!recovered) return { state: 'pending' };
    return {
      claim: { fingerprint, id: existing.id, owner },
      state: 'acquired',
    };
  };

  succeed = async (
    tx: Transaction,
    claim: BrandingOperationClaim,
    result: PlatformBrandingOperationResult,
  ): Promise<void> => {
    const [updated] = await tx
      .update(platformBrandingOperations)
      .set({
        errorCategory: null,
        leaseOwner: null,
        leaseUntil: null,
        result,
        status: 'succeeded',
        updatedAt: this.now(),
      })
      .where(
        and(
          eq(platformBrandingOperations.id, claim.id),
          eq(platformBrandingOperations.fingerprint, claim.fingerprint),
          eq(platformBrandingOperations.status, 'pending'),
          eq(platformBrandingOperations.leaseOwner, claim.owner),
        ),
      )
      .returning({ id: platformBrandingOperations.id });
    if (!updated) throw new BrandingOperationOwnershipLostError();
  };

  fail = async (
    claim: BrandingOperationClaim,
    errorCategory: PlatformBrandingOperationErrorCategory,
  ): Promise<void> => {
    try {
      const [updated] = await this.db
        .update(platformBrandingOperations)
        .set({
          errorCategory,
          leaseOwner: null,
          leaseUntil: null,
          result: null,
          status: 'failed',
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(platformBrandingOperations.id, claim.id),
            eq(platformBrandingOperations.fingerprint, claim.fingerprint),
            eq(platformBrandingOperations.status, 'pending'),
            eq(platformBrandingOperations.leaseOwner, claim.owner),
          ),
        )
        .returning({ id: platformBrandingOperations.id });
      if (!updated) throw new BrandingOperationRecoveryPendingError();
    } catch (error) {
      if (error instanceof BrandingOperationRecoveryPendingError) throw error;
      throw new BrandingOperationRecoveryPendingError();
    }
  };
}
