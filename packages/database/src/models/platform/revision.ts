import { and, desc, eq, sql } from 'drizzle-orm';

import {
  type PlatformResourceRevisionItem,
  platformResourceRevisions,
  type PlatformResourceType,
  type PlatformRevisionStatus,
} from '../../schemas/platform';
import { platformBranding } from '../../schemas/platform/branding';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformAuditLogModel } from './auditLog';
import { checksumPayload } from './checksum';
import { PlatformRevisionConflictError, PlatformRevisionImmutableError } from './errors';
import { redactSensitive, type RedactSensitiveOptions } from './redact';

export type { PlatformResourceRevisionItem, PlatformResourceType, PlatformRevisionStatus };

export interface ResourcePointerAdapter {
  /**
   * Optional domain CAS check after the pointer row is locked and revision is
   * verified. Used by aggregate resources whose mutable draft is not represented
   * by the published revision alone.
   */
  assertLockedState?: (
    tx: Transaction,
    args: { currentRevision: number; operation: 'publish' | 'rollback' },
  ) => Promise<void>;
  /**
   * Lock the current resource row and return its revision.
   * Must use SELECT ... FOR UPDATE (or equivalent) inside the open transaction.
   */
  lockAndGetRevision: (tx: Transaction) => Promise<number>;
  /**
   * Optional domain materialization inside the **same** publish/rollback transaction,
   * after pointer update and before success audit (M05 settings path policies, etc.).
   * Failure aborts the whole transaction so revision + pointer never commit alone.
   */
  materializePublished?: (
    tx: Transaction,
    args: {
      operation: 'publish' | 'rollback';
      payload: Record<string, unknown>;
      revision: number;
      secretFingerprint?: string | null;
      status: PlatformRevisionStatus;
    },
  ) => Promise<void>;
  /**
   * Build the publish payload from domain state after lock acquisition. The
   * returned payload, checksum, revision row, materialization and audit all use
   * this one locked snapshot. Existing resources may continue passing `payload`.
   */
  prepareLockedPublish?: (
    tx: Transaction,
    args: { currentRevision: number },
  ) => Promise<{
    afterDiff?: Record<string, unknown> | null;
    payload: Record<string, unknown>;
  }>;
  /**
   * Advance the domain table pointer after a successful revision append.
   */
  updatePointer: (
    tx: Transaction,
    args: { revision: number; status: PlatformRevisionStatus },
  ) => Promise<void>;
}

export interface PublishDraftParams {
  actorUserId?: string | null;
  afterDiff?: Record<string, unknown> | null;
  beforeDiff?: Record<string, unknown> | null;
  comment?: string | null;
  expectedRevision: number;
  ipHash?: string | null;
  /** Raw payload — will be redacted before persistence. */
  payload: Record<string, unknown>;
  pointer: ResourcePointerAdapter;
  reason?: string | null;
  redactionOptions?: RedactSensitiveOptions;
  requestId?: string | null;
  resourceId: string;
  resourceType: PlatformResourceType;
  /**
   * Domain-owned strict projection for payloads whose semantic schema contains
   * credential-like property names. The callback must return the only fields
   * that are legal to persist.
   */
  sanitizePayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
  secretFingerprint?: string | null;
  /** Target lifecycle status for the published revision (default: published). */
  status?: Extract<PlatformRevisionStatus, 'published' | 'archived'>;
  userAgent?: string | null;
}

export interface RollbackToRevisionParams {
  actorUserId?: string | null;
  expectedRevision: number;
  ipHash?: string | null;
  pointer: ResourcePointerAdapter;
  reason?: string | null;
  requestId?: string | null;
  resourceId: string;
  resourceType: PlatformResourceType;
  /** The historical revision number to restore as the new published head. */
  targetRevision: number;
  userAgent?: string | null;
}

export interface PublishResult {
  auditId: string;
  revision: PlatformResourceRevisionItem;
}

/**
 * Immutable revision repository + atomic publish / rollback orchestration.
 *
 * Publish transaction steps (all-or-nothing):
 * 1. lock pointer + validate expectedRevision
 * 2. append revision row (redacted payload + checksum)
 * 3. update current pointer
 * 4. append audit log
 */
export class PlatformRevisionModel {
  private readonly db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  getPublishedSnapshot = async (
    resourceType: PlatformResourceType,
    resourceId: string,
  ): Promise<PlatformResourceRevisionItem | undefined> => {
    return this.db.query.platformResourceRevisions.findFirst({
      orderBy: [desc(platformResourceRevisions.revision)],
      where: and(
        eq(platformResourceRevisions.resourceType, resourceType),
        eq(platformResourceRevisions.resourceId, resourceId),
        eq(platformResourceRevisions.status, 'published'),
      ),
    });
  };

  getRevision = async (
    resourceType: PlatformResourceType,
    resourceId: string,
    revision: number,
  ): Promise<PlatformResourceRevisionItem | undefined> => {
    return this.db.query.platformResourceRevisions.findFirst({
      where: and(
        eq(platformResourceRevisions.resourceType, resourceType),
        eq(platformResourceRevisions.resourceId, resourceId),
        eq(platformResourceRevisions.revision, revision),
      ),
    });
  };

  listRevisions = async (
    resourceType: PlatformResourceType,
    resourceId: string,
    limit = 50,
  ): Promise<PlatformResourceRevisionItem[]> => {
    return this.db.query.platformResourceRevisions.findMany({
      limit,
      orderBy: [desc(platformResourceRevisions.revision)],
      where: and(
        eq(platformResourceRevisions.resourceType, resourceType),
        eq(platformResourceRevisions.resourceId, resourceId),
      ),
    });
  };

  /**
   * Refuse in-place mutation of any existing revision row.
   * Callers must append a new revision instead.
   */
  assertImmutable = async (revisionId: string): Promise<void> => {
    const row = await this.db.query.platformResourceRevisions.findFirst({
      where: eq(platformResourceRevisions.id, revisionId),
    });
    if (!row) return;
    if (row.status === 'published' || row.status === 'archived' || row.status === 'rolled_back') {
      throw new PlatformRevisionImmutableError();
    }
  };

  /**
   * Atomic publish: validate expectedRevision → write revision → update pointer → audit.
   */
  publishDraft = async (params: PublishDraftParams): Promise<PublishResult> => {
    const status = params.status ?? 'published';
    const nextRevision = params.expectedRevision + 1;

    return this.db.transaction(async (tx) => {
      const current = await params.pointer.lockAndGetRevision(tx);
      if (current !== params.expectedRevision) {
        throw new PlatformRevisionConflictError(undefined, {
          currentRevision: current,
          expectedRevision: params.expectedRevision,
          resourceId: params.resourceId,
          resourceType: params.resourceType,
        });
      }

      await params.pointer.assertLockedState?.(tx, {
        currentRevision: current,
        operation: 'publish',
      });
      const prepared = await params.pointer.prepareLockedPublish?.(tx, {
        currentRevision: current,
      });
      const rawPayload = prepared?.payload ?? params.payload;
      const redactedPayload = params.sanitizePayload
        ? params.sanitizePayload(rawPayload)
        : redactSensitive(rawPayload, params.redactionOptions);
      const checksum = checksumPayload(redactedPayload);

      const now = new Date();
      const [revision] = await tx
        .insert(platformResourceRevisions)
        .values({
          checksum,
          comment: params.comment ?? null,
          createdBy: params.actorUserId ?? null,
          payload: redactedPayload,
          publishedAt: status === 'published' ? now : null,
          publishedBy: params.actorUserId ?? null,
          resourceId: params.resourceId,
          resourceType: params.resourceType,
          revision: nextRevision,
          secretFingerprint: params.secretFingerprint ?? null,
          status,
        })
        .returning();

      await params.pointer.updatePointer(tx, { revision: nextRevision, status });

      if (params.pointer.materializePublished) {
        await params.pointer.materializePublished(tx, {
          operation: 'publish',
          payload: redactedPayload,
          revision: nextRevision,
          secretFingerprint: params.secretFingerprint ?? null,
          status,
        });
      }

      const audit = await new PlatformAuditLogModel(tx).append({
        action: `platform.${params.resourceType}.publish`,
        actorUserId: params.actorUserId,
        afterDiff:
          prepared?.afterDiff === undefined
            ? (params.afterDiff ?? redactedPayload)
            : prepared.afterDiff,
        beforeDiff: params.beforeDiff ?? null,
        configRevision: nextRevision,
        ipHash: params.ipHash,
        reason: params.reason,
        requestId: params.requestId,
        result: 'success',
        targetId: params.resourceId,
        targetType: params.resourceType,
        userAgent: params.userAgent,
      });

      return { auditId: audit.id, revision };
    });
  };

  /**
   * Rollback: append a new published head that copies a historical revision payload.
   * Prior published rows stay immutable (status/payload unchanged); history is
   * reconstructed from monotonically increasing revision numbers.
   */
  rollbackToRevision = async (params: RollbackToRevisionParams): Promise<PublishResult> => {
    return this.db.transaction(async (tx) => {
      const current = await params.pointer.lockAndGetRevision(tx);
      if (current !== params.expectedRevision) {
        throw new PlatformRevisionConflictError(undefined, {
          currentRevision: current,
          expectedRevision: params.expectedRevision,
          resourceId: params.resourceId,
          resourceType: params.resourceType,
        });
      }

      await params.pointer.assertLockedState?.(tx, {
        currentRevision: current,
        operation: 'rollback',
      });

      const target = await tx.query.platformResourceRevisions.findFirst({
        where: and(
          eq(platformResourceRevisions.resourceType, params.resourceType),
          eq(platformResourceRevisions.resourceId, params.resourceId),
          eq(platformResourceRevisions.revision, params.targetRevision),
        ),
      });

      if (!target) {
        throw new Error(
          `Target revision ${params.targetRevision} not found for ${params.resourceType}:${params.resourceId}`,
        );
      }

      // Published rows stay immutable (payload + status). Rollback appends a new head
      // that copies the target payload; history is reconstructed from revision numbers.
      const nextRevision = params.expectedRevision + 1;
      const now = new Date();
      const [revision] = await tx
        .insert(platformResourceRevisions)
        .values({
          checksum: target.checksum,
          comment: params.reason ?? `rollback to revision ${params.targetRevision}`,
          createdBy: params.actorUserId ?? null,
          payload: target.payload,
          publishedAt: now,
          publishedBy: params.actorUserId ?? null,
          resourceId: params.resourceId,
          resourceType: params.resourceType,
          revision: nextRevision,
          secretFingerprint: target.secretFingerprint,
          status: 'published',
        })
        .returning();

      await params.pointer.updatePointer(tx, { revision: nextRevision, status: 'published' });

      if (params.pointer.materializePublished) {
        await params.pointer.materializePublished(tx, {
          operation: 'rollback',
          payload: (target.payload ?? {}) as Record<string, unknown>,
          revision: nextRevision,
          secretFingerprint: target.secretFingerprint,
          status: 'published',
        });
      }

      const audit = await new PlatformAuditLogModel(tx).append({
        action: `platform.${params.resourceType}.rollback`,
        actorUserId: params.actorUserId,
        afterDiff: { restoredFromRevision: params.targetRevision, revision: nextRevision },
        beforeDiff: { revision: current },
        configRevision: nextRevision,
        ipHash: params.ipHash,
        reason: params.reason,
        requestId: params.requestId,
        result: 'success',
        targetId: params.resourceId,
        targetType: params.resourceType,
        userAgent: params.userAgent,
      });

      return { auditId: audit.id, revision };
    });
  };
}

/**
 * FOR UPDATE pointer adapter for `platform_branding` — used as the M01 example resource.
 * Domain modules should provide equivalent adapters for their own pointer columns.
 */
export const createBrandingPointerAdapter = (brandingId: string): ResourcePointerAdapter => ({
  lockAndGetRevision: async (tx) => {
    const result = await tx.execute(
      sql`SELECT "revision" FROM "platform_branding" WHERE "id" = ${brandingId} FOR UPDATE`,
    );
    const rows =
      (result as unknown as { rows?: { revision: number }[] }).rows ??
      (result as unknown as { revision: number }[]);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      throw new Error(`Branding resource not found: ${brandingId}`);
    }
    return Number(row.revision);
  },
  updatePointer: async (tx, { revision, status }) => {
    await tx
      .update(platformBranding)
      .set({
        revision,
        status: status as 'draft' | 'published' | 'archived',
        updatedAt: new Date(),
      })
      .where(eq(platformBranding.id, brandingId));
  },
});
