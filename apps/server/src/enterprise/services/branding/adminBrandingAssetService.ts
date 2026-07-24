import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import {
  checksumPayload,
  type CreatePlatformAuditLogParams,
  type PlatformAuditLogItem,
} from '@/database/models/platform';
import { platformBrandingAssets } from '@/database/schemas/platform';
import type { PlatformBrandingAssetItem } from '@/database/schemas/platform/branding';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  type AdminBrandingDraft,
  type AdminBrandingUploadAssetInput,
  adminBrandingUploadAssetInputSchema,
  platformBrandingAssetIdFromUrl,
} from '../../contracts/adminBranding';
import { PlatformAuditService } from '../platformAudit';
import { BrandingIdempotencyConflictError } from './adminBrandingOperationService';
import type { BrandingAssetStorage, ValidatedBrandingAsset } from './assetStorage';
import {
  BrandingAssetStorageUnavailableError,
  FileBrandingAssetStorage,
  validateBrandingAsset,
} from './assetStorage';

export { BrandingIdempotencyConflictError } from './adminBrandingOperationService';

const ASSET_OPERATION = 'admin.branding.uploadAsset';
const ASSET_ID_PREFIX = 'pba_';
const ASSET_UPLOAD_LEASE_MS = 5 * 60 * 1000;
const ASSET_REPLAY_WAIT_MS = 15 * 1000;
const ASSET_REPLAY_POLL_MS = 100;
const ASSET_GRACE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_LEASE_MS = 5 * 60 * 1000;
const CLEANUP_RETRY_BASE_MS = 60 * 1000;
const CLEANUP_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_LIMIT = 10;
const MAX_SWEEP_LIMIT = 100;

type AuditAppend = (
  db: LobeChatDatabase | Transaction,
  params: CreatePlatformAuditLogParams,
) => Promise<PlatformAuditLogItem>;

export class BrandingAssetUploadInProgressError extends Error {
  constructor() {
    super('BRANDING_ASSET_UPLOAD_IN_PROGRESS');
    this.name = 'BrandingAssetUploadInProgressError';
  }
}

interface BrandingAssetReference {
  kind: PlatformBrandingAssetItem['kind'];
  url: string;
}

interface BrandingAssetReservation {
  asset: PlatformBrandingAssetItem;
  owner: string;
  status: 'acquired';
}

interface BrandingAssetReplay {
  asset: PlatformBrandingAssetItem;
  status: 'replay';
}

interface BrandingAssetWait {
  asset: PlatformBrandingAssetItem;
  status: 'wait';
}

type BrandingAssetReservationResult =
  BrandingAssetReplay | BrandingAssetReservation | BrandingAssetWait;

export interface AdminBrandingAssetServiceOptions {
  appendAudit?: AuditAppend;
  now?: () => Date;
  referenceLookup?: (
    db: LobeChatDatabase | Transaction,
    ids: string[],
  ) => Promise<
    Pick<
      PlatformBrandingAssetItem,
      'cleanupOwner' | 'id' | 'kind' | 'mimeType' | 'objectDeletedAt' | 'status'
    >[]
  >;
  sleep?: (milliseconds: number) => Promise<void>;
  storage?: BrandingAssetStorage;
}

export class BrandingAssetCleanupClaimedError extends Error {
  constructor() {
    super('BRANDING_ASSET_CLEANUP_CLAIMED');
    this.name = 'BrandingAssetCleanupClaimedError';
  }
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const referencesForDraft = (draft: AdminBrandingDraft): BrandingAssetReference[] =>
  [
    { kind: 'desktopIcon', url: draft.desktop.iconUrl },
    { kind: 'favicon', url: draft.faviconUrl },
    { kind: 'icon', url: draft.iconUrl },
    { kind: 'logo', url: draft.logoUrl },
    { kind: 'ogImage', url: draft.ogImageUrl },
  ].filter((reference): reference is BrandingAssetReference => Boolean(reference.url));

const uploadResult = (asset: PlatformBrandingAssetItem) => ({
  height: asset.height,
  mimeType: asset.mimeType as 'image/jpeg' | 'image/png' | 'image/webp',
  orphanPolicy: 'bounded_sweep' as const,
  url: `/f/${asset.id}`,
  width: asset.width,
});

interface AdminBrandingAssetUploadOptions {
  finalizeSuccess?: (tx: Transaction, result: ReturnType<typeof uploadResult>) => Promise<void>;
}

const requestFingerprint = (input: AdminBrandingUploadAssetInput): string => {
  const { requestId: _requestId, ...payload } = input;
  return checksumPayload(payload);
};

export class AdminBrandingAssetService {
  private readonly appendAudit: AuditAppend;
  private readonly db: LobeChatDatabase;
  private readonly now: () => Date;
  private readonly referenceLookup: NonNullable<
    AdminBrandingAssetServiceOptions['referenceLookup']
  >;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly storage: BrandingAssetStorage;

  constructor(db: LobeChatDatabase, options: AdminBrandingAssetServiceOptions = {}) {
    this.db = db;
    this.appendAudit =
      options.appendAudit ??
      ((targetDb, params) => new PlatformAuditService(targetDb).append(params));
    this.now = options.now ?? (() => new Date());
    this.referenceLookup =
      options.referenceLookup ??
      ((targetDb, ids) =>
        targetDb
          .select({
            id: platformBrandingAssets.id,
            cleanupOwner: platformBrandingAssets.cleanupOwner,
            kind: platformBrandingAssets.kind,
            mimeType: platformBrandingAssets.mimeType,
            objectDeletedAt: platformBrandingAssets.objectDeletedAt,
            status: platformBrandingAssets.status,
          })
          .from(platformBrandingAssets)
          .where(inArray(platformBrandingAssets.id, ids)));
    this.sleep = options.sleep ?? defaultSleep;
    this.storage = options.storage ?? new FileBrandingAssetStorage(db);
  }

  isStorageConfigured = (): boolean => this.storage.isConfigured();

  private finalizeReplaySuccess = async (
    asset: PlatformBrandingAssetItem,
    options: AdminBrandingAssetUploadOptions,
  ): Promise<ReturnType<typeof uploadResult>> => {
    const result = uploadResult(asset);
    const finalizeSuccess = options.finalizeSuccess;
    if (finalizeSuccess) {
      await this.db.transaction((tx) => finalizeSuccess(tx, result));
    }
    return result;
  };

  private acquireRequestLock = async (
    tx: Transaction,
    actorUserId: string,
    requestId: string,
  ): Promise<void> => {
    const lane = `${ASSET_OPERATION}:${actorUserId}:${requestId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lane})::bigint)`);
  };

  private reserve = async (params: {
    actorUserId: string;
    asset: ValidatedBrandingAsset;
    fingerprint: string;
    input: AdminBrandingUploadAssetInput;
  }): Promise<BrandingAssetReservationResult> => {
    return this.db.transaction(async (tx) => {
      await this.acquireRequestLock(tx, params.actorUserId, params.input.requestId);
      const [existing] = await tx
        .select()
        .from(platformBrandingAssets)
        .where(
          and(
            eq(platformBrandingAssets.requestActorId, params.actorUserId),
            eq(platformBrandingAssets.operation, ASSET_OPERATION),
            eq(platformBrandingAssets.requestId, params.input.requestId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.requestFingerprint !== params.fingerprint) {
          throw new BrandingIdempotencyConflictError();
        }
        if (existing.cleanupOwner) throw new BrandingAssetCleanupClaimedError();
        if (existing.status === 'ready') return { asset: existing, status: 'replay' };
        const now = this.now();
        if (
          existing.status === 'uploading' &&
          existing.uploadLeaseUntil &&
          existing.uploadLeaseUntil > now
        ) {
          return { asset: existing, status: 'wait' };
        }
        const owner = randomUUID();
        const leaseUntil = new Date(now.getTime() + ASSET_UPLOAD_LEASE_MS);
        const [claimed] = await tx
          .update(platformBrandingAssets)
          .set({
            cleanupAfter: leaseUntil,
            lastCleanupError: null,
            objectDeletedAt: null,
            status: 'uploading',
            updatedAt: now,
            uploadLeaseUntil: leaseUntil,
            uploadOwner: owner,
          })
          .where(
            and(
              eq(platformBrandingAssets.id, existing.id),
              isNull(platformBrandingAssets.cleanupOwner),
            ),
          )
          .returning();
        if (!claimed) throw new BrandingAssetCleanupClaimedError();
        return { asset: claimed, owner, status: 'acquired' };
      }

      const now = this.now();
      const id = `${ASSET_ID_PREFIX}${randomUUID()}`;
      const owner = randomUUID();
      const leaseUntil = new Date(now.getTime() + ASSET_UPLOAD_LEASE_MS);
      const [created] = await tx
        .insert(platformBrandingAssets)
        .values({
          cleanupAfter: leaseUntil,
          createdBy: params.actorUserId,
          height: params.asset.height,
          id,
          kind: params.input.kind,
          mimeType: params.asset.mimeType,
          objectKey: `branding/${params.input.kind}/${id}.${params.asset.extension}`,
          operation: ASSET_OPERATION,
          requestActorId: params.actorUserId,
          requestFingerprint: params.fingerprint,
          requestId: params.input.requestId,
          sha256: createHash('sha256').update(params.asset.bytes).digest('hex'),
          size: params.asset.bytes.length,
          status: 'uploading',
          uploadLeaseUntil: leaseUntil,
          uploadOwner: owner,
          width: params.asset.width,
        })
        .returning();
      return { asset: created, owner, status: 'acquired' };
    });
  };

  private waitForReplay = async (assetId: string): Promise<PlatformBrandingAssetItem | null> => {
    const deadline = Date.now() + ASSET_REPLAY_WAIT_MS;
    while (Date.now() < deadline) {
      await this.sleep(ASSET_REPLAY_POLL_MS);
      const [asset] = await this.db
        .select()
        .from(platformBrandingAssets)
        .where(eq(platformBrandingAssets.id, assetId))
        .limit(1);
      if (!asset) return null;
      if (asset.status === 'ready') return asset;
      if (asset.status !== 'uploading') return null;
    }
    throw new BrandingAssetUploadInProgressError();
  };

  private markCompensated = async (
    reservation: BrandingAssetReservation,
    deletionError: unknown,
  ): Promise<void> => {
    const now = this.now();
    const deletionSucceeded = deletionError === null;
    try {
      await this.db
        .update(platformBrandingAssets)
        .set({
          cleanupAfter: deletionSucceeded
            ? new Date(now.getTime() + ASSET_GRACE_MS)
            : new Date(now.getTime() + CLEANUP_RETRY_BASE_MS),
          cleanupAttempts: sql`${platformBrandingAssets.cleanupAttempts} + 1`,
          lastCleanupError:
            deletionError instanceof Error ? deletionError.name.slice(0, 128) : null,
          objectDeletedAt: deletionSucceeded ? now : null,
          status: 'orphaned',
          updatedAt: now,
          uploadLeaseUntil: null,
          uploadOwner: null,
        })
        .where(
          and(
            eq(platformBrandingAssets.id, reservation.asset.id),
            eq(platformBrandingAssets.uploadOwner, reservation.owner),
          ),
        );
    } catch (error) {
      console.error('[admin.branding:assetCompensationPersistenceFailure]', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  };

  private compensate = async (reservation: BrandingAssetReservation): Promise<void> => {
    const [current] = await this.db
      .select({ uploadOwner: platformBrandingAssets.uploadOwner })
      .from(platformBrandingAssets)
      .where(eq(platformBrandingAssets.id, reservation.asset.id))
      .limit(1);
    if (current?.uploadOwner !== reservation.owner) return;
    let deletionError: unknown = null;
    try {
      await this.storage.delete(reservation.asset.objectKey);
    } catch (error) {
      deletionError = error;
    }
    await this.markCompensated(reservation, deletionError);
  };

  upload = async (
    actorUserId: string,
    rawInput: AdminBrandingUploadAssetInput,
    options: AdminBrandingAssetUploadOptions = {},
  ) => {
    if (!this.storage.isConfigured()) throw new BrandingAssetStorageUnavailableError();
    const input = adminBrandingUploadAssetInputSchema.parse(rawInput);
    const asset = await validateBrandingAsset(input);
    const fingerprint = requestFingerprint(input);

    let reservation = await this.reserve({ actorUserId, asset, fingerprint, input });
    if (reservation.status === 'replay') {
      return this.finalizeReplaySuccess(reservation.asset, options);
    }
    if (reservation.status === 'wait') {
      const replay = await this.waitForReplay(reservation.asset.id);
      if (replay) {
        return this.finalizeReplaySuccess(replay, options);
      }
      reservation = await this.reserve({ actorUserId, asset, fingerprint, input });
      if (reservation.status === 'replay') {
        return this.finalizeReplaySuccess(reservation.asset, options);
      }
      if (reservation.status === 'wait') throw new BrandingAssetUploadInProgressError();
    }

    try {
      // Sweep only after the request lane is accepted, and inside the compensated
      // try so a cleanup discovery failure releases the uploading reservation.
      await this.sweep({ limit: DEFAULT_SWEEP_LIMIT });
      await this.storage.upload({ asset, objectKey: reservation.asset.objectKey });
      const ready = await this.db.transaction(async (tx) => {
        await this.acquireRequestLock(tx, actorUserId, input.requestId);
        const now = this.now();
        const [updated] = await tx
          .update(platformBrandingAssets)
          .set({
            cleanupAfter: new Date(now.getTime() + ASSET_GRACE_MS),
            objectDeletedAt: null,
            status: 'ready',
            updatedAt: now,
            uploadLeaseUntil: null,
            uploadOwner: null,
          })
          .where(
            and(
              eq(platformBrandingAssets.id, reservation.asset.id),
              eq(platformBrandingAssets.requestFingerprint, fingerprint),
              eq(platformBrandingAssets.status, 'uploading'),
              isNull(platformBrandingAssets.cleanupOwner),
              eq(platformBrandingAssets.uploadOwner, reservation.owner),
            ),
          )
          .returning();
        if (!updated) throw new BrandingAssetUploadInProgressError();
        await this.appendAudit(tx, {
          action: ASSET_OPERATION,
          actorUserId,
          afterDiff: {
            assetId: updated.id,
            height: updated.height,
            kind: updated.kind,
            mimeType: updated.mimeType,
            requestFingerprint: fingerprint,
            size: updated.size,
            width: updated.width,
          },
          reason: input.reason,
          requestId: input.requestId,
          result: 'success',
          targetId: 'global',
          targetType: 'branding',
        });
        await options.finalizeSuccess?.(tx, uploadResult(updated));
        return updated;
      });
      return uploadResult(ready);
    } catch (error) {
      await this.compensate(reservation);
      throw error;
    }
  };

  assertControlledReferences = async (
    db: LobeChatDatabase | Transaction,
    draft: AdminBrandingDraft,
  ): Promise<string[]> => {
    const references = referencesForDraft(draft);
    if (references.length === 0) return [];
    const ids = references.map(({ url }) => platformBrandingAssetIdFromUrl(url));
    if (ids.some((id) => !id)) throw new Error('BRANDING_DRAFT_INVALID');
    const rows = await this.referenceLookup(db, ids as string[]);
    for (const reference of references) {
      const id = platformBrandingAssetIdFromUrl(reference.url);
      const row = rows.find((item) => item.id === id);
      if (
        !row ||
        row.cleanupOwner !== null ||
        row.status !== 'ready' ||
        row.objectDeletedAt !== null ||
        row.kind !== reference.kind ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(row.mimeType)
      ) {
        throw new Error('BRANDING_DRAFT_INVALID');
      }
    }
    return ids as string[];
  };

  updateDraftPins = async (tx: Transaction, assetIds: string[]): Promise<void> => {
    const now = this.now();
    await tx
      .update(platformBrandingAssets)
      .set({
        cleanupAfter: new Date(now.getTime() + ASSET_GRACE_MS),
        draftPinned: false,
        updatedAt: now,
      })
      .where(
        and(
          eq(platformBrandingAssets.draftPinned, true),
          isNull(platformBrandingAssets.firstPublishedRevision),
        ),
      );
    const uniqueAssetIds = [...new Set(assetIds)];
    if (uniqueAssetIds.length === 0) return;
    const pinned = await tx
      .update(platformBrandingAssets)
      .set({ draftPinned: true, updatedAt: now })
      .where(
        and(
          inArray(platformBrandingAssets.id, uniqueAssetIds),
          eq(platformBrandingAssets.status, 'ready'),
          isNull(platformBrandingAssets.objectDeletedAt),
          isNull(platformBrandingAssets.cleanupOwner),
        ),
      )
      .returning({ id: platformBrandingAssets.id });
    if (pinned.length !== uniqueAssetIds.length) throw new BrandingAssetCleanupClaimedError();
  };

  pinPublished = async (tx: Transaction, assetIds: string[], revision: number): Promise<void> => {
    const uniqueAssetIds = [...new Set(assetIds)];
    if (uniqueAssetIds.length === 0) return;
    const pinned = await tx
      .update(platformBrandingAssets)
      .set({
        draftPinned: true,
        firstPublishedRevision: sql`COALESCE(${platformBrandingAssets.firstPublishedRevision}, ${revision})`,
        updatedAt: this.now(),
      })
      .where(
        and(
          inArray(platformBrandingAssets.id, uniqueAssetIds),
          eq(platformBrandingAssets.status, 'ready'),
          isNull(platformBrandingAssets.objectDeletedAt),
          isNull(platformBrandingAssets.cleanupOwner),
        ),
      )
      .returning({ id: platformBrandingAssets.id });
    if (pinned.length !== uniqueAssetIds.length) throw new BrandingAssetCleanupClaimedError();
  };

  private claimCleanupCandidates = async (
    now: Date,
    limit: number,
  ): Promise<PlatformBrandingAssetItem[]> =>
    this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(platformBrandingAssets)
        .where(
          and(
            lte(platformBrandingAssets.cleanupAfter, now),
            isNull(platformBrandingAssets.objectDeletedAt),
            eq(platformBrandingAssets.draftPinned, false),
            isNull(platformBrandingAssets.firstPublishedRevision),
            or(
              isNull(platformBrandingAssets.cleanupOwner),
              lte(platformBrandingAssets.cleanupLeaseUntil, now),
            ),
            or(
              eq(platformBrandingAssets.status, 'ready'),
              eq(platformBrandingAssets.status, 'orphaned'),
              and(
                eq(platformBrandingAssets.status, 'uploading'),
                or(
                  isNull(platformBrandingAssets.uploadLeaseUntil),
                  lte(platformBrandingAssets.uploadLeaseUntil, now),
                ),
              ),
            ),
          ),
        )
        .limit(limit);

      const claimed: PlatformBrandingAssetItem[] = [];
      for (const candidate of candidates) {
        const owner = randomUUID();
        const [asset] = await tx
          .update(platformBrandingAssets)
          .set({
            cleanupLeaseUntil: new Date(now.getTime() + CLEANUP_LEASE_MS),
            cleanupOwner: owner,
            draftPinned: false,
            status: 'orphaned',
            updatedAt: now,
            uploadLeaseUntil: null,
            uploadOwner: null,
          })
          .where(
            and(
              eq(platformBrandingAssets.id, candidate.id),
              lte(platformBrandingAssets.cleanupAfter, now),
              isNull(platformBrandingAssets.objectDeletedAt),
              eq(platformBrandingAssets.draftPinned, false),
              isNull(platformBrandingAssets.firstPublishedRevision),
              or(
                isNull(platformBrandingAssets.cleanupOwner),
                lte(platformBrandingAssets.cleanupLeaseUntil, now),
              ),
              or(
                eq(platformBrandingAssets.status, 'ready'),
                eq(platformBrandingAssets.status, 'orphaned'),
                and(
                  eq(platformBrandingAssets.status, 'uploading'),
                  or(
                    isNull(platformBrandingAssets.uploadLeaseUntil),
                    lte(platformBrandingAssets.uploadLeaseUntil, now),
                  ),
                ),
              ),
            ),
          )
          .returning();
        if (asset) claimed.push(asset);
      }
      return claimed;
    });

  sweep = async ({ limit = DEFAULT_SWEEP_LIMIT }: { limit?: number } = {}) => {
    const boundedLimit = Math.max(1, Math.min(limit, MAX_SWEEP_LIMIT));
    const now = this.now();
    const candidates = await this.claimCleanupCandidates(now, boundedLimit);

    let deleted = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await this.storage.delete(candidate.objectKey);
        const deletedRows = await this.db
          .update(platformBrandingAssets)
          .set({
            cleanupAttempts: sql`${platformBrandingAssets.cleanupAttempts} + 1`,
            cleanupLeaseUntil: null,
            cleanupOwner: null,
            draftPinned: false,
            lastCleanupError: null,
            objectDeletedAt: now,
            status: 'orphaned',
            updatedAt: now,
            uploadLeaseUntil: null,
            uploadOwner: null,
          })
          .where(
            and(
              eq(platformBrandingAssets.id, candidate.id),
              eq(platformBrandingAssets.cleanupOwner, candidate.cleanupOwner!),
              eq(platformBrandingAssets.status, 'orphaned'),
            ),
          )
          .returning({ id: platformBrandingAssets.id });
        if (deletedRows.length === 1) deleted += 1;
      } catch (error) {
        const attempts = candidate.cleanupAttempts + 1;
        const retryMs = Math.min(CLEANUP_RETRY_BASE_MS * 2 ** (attempts - 1), CLEANUP_RETRY_MAX_MS);
        const retryAt = new Date(now.getTime() + retryMs);
        const failedRows = await this.db
          .update(platformBrandingAssets)
          .set({
            cleanupAfter: retryAt,
            cleanupAttempts: attempts,
            cleanupLeaseUntil: retryAt,
            lastCleanupError: error instanceof Error ? error.name.slice(0, 128) : 'UnknownError',
            status: 'orphaned',
            updatedAt: now,
            uploadLeaseUntil: null,
            uploadOwner: null,
          })
          .where(
            and(
              eq(platformBrandingAssets.id, candidate.id),
              eq(platformBrandingAssets.cleanupOwner, candidate.cleanupOwner!),
              eq(platformBrandingAssets.status, 'orphaned'),
            ),
          )
          .returning({ id: platformBrandingAssets.id });
        if (failedRows.length === 1) failed += 1;
      }
    }
    return { deleted, failed, scanned: candidates.length };
  };
}
