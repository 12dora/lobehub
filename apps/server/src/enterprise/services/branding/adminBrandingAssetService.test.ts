// @vitest-environment node
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformBrandingAssets,
  platformBrandingOperations,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import type { AdminBrandingUploadAssetInput } from '../../contracts/adminBranding';
import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import {
  AdminBrandingAssetService,
  BrandingIdempotencyConflictError,
} from './adminBrandingAssetService';
import { AdminBrandingOperationService } from './adminBrandingOperationService';
import { AdminBrandingService } from './adminBrandingService';

const db: LobeChatDatabase = await getTestDB();
const actorUserId = 'branding-asset-admin';

const png = async () =>
  sharp({ create: { background: '#3366ff', channels: 4, height: 16, width: 16 } })
    .png()
    .toBuffer();

const input = async (
  override: Partial<AdminBrandingUploadAssetInput> = {},
): Promise<AdminBrandingUploadAssetInput> => ({
  bytesBase64: (await png()).toString('base64'),
  fileName: 'logo.png',
  kind: 'logo',
  reason: 'upload approved',
  requestId: crypto.randomUUID(),
  ...override,
});

const cleanup = async () => {
  await deletePlatformAuditLogsForTest(db, { actorUserIds: [actorUserId] });
  await db.delete(platformBrandingOperations);
  await db.delete(platformBrandingAssets);
  await db.delete(users).where(eq(users.id, actorUserId));
};

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values({ id: actorUserId });
});

afterEach(cleanup);

describe('AdminBrandingAssetService', () => {
  it('compensates an accepted reservation when sweep fails before upload', async () => {
    const storage = {
      delete: vi.fn(async () => {}),
      isConfigured: () => true,
      upload: vi.fn(async () => {}),
    };
    const service = new AdminBrandingAssetService(db, { storage });
    vi.spyOn(service, 'sweep').mockRejectedValueOnce(new Error('sweep discovery failed'));
    const request = await input();

    await expect(service.upload(actorUserId, request)).rejects.toThrow('sweep discovery failed');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(await db.select().from(platformBrandingAssets)).toEqual([
      expect.objectContaining({ status: 'orphaned', uploadOwner: null }),
    ]);
  });

  it('coalesces concurrent identical requests into one object write and exact replay', async () => {
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const storage = {
      delete: vi.fn(async () => {}),
      isConfigured: () => true,
      upload: vi.fn(async () => uploadGate),
    };
    const service = new AdminBrandingAssetService(db, { storage });
    const request = await input();

    const first = service.upload(actorUserId, request);
    await vi.waitFor(() => expect(storage.upload).toHaveBeenCalledOnce());
    const second = service.upload(actorUserId, request);
    releaseUpload();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(await db.select().from(platformBrandingAssets)).toEqual([
      expect.objectContaining({ status: 'ready' }),
    ]);
    expect(
      (await db.select().from(platformAuditLogs)).filter(
        (audit) => audit.action === 'admin.branding.uploadAsset' && audit.result === 'success',
      ),
    ).toHaveLength(1);
  });

  it('finalizes a recovered operation when the second reservation replays a completed upload', async () => {
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const storage = {
      delete: vi.fn(async () => {}),
      isConfigured: () => true,
      upload: vi.fn(async () => uploadGate),
    };
    const request = await input();
    const { requestId: _requestId, ...payload } = request;
    const operationParams = {
      actorId: actorUserId,
      fingerprint: checksumPayload(payload),
      operation: 'admin.branding.uploadAsset' as const,
      requestId: request.requestId,
      resource: 'branding:global',
    };
    const operationService = new AdminBrandingOperationService(db);
    const operation = await operationService.claim(operationParams);
    if (operation.state !== 'acquired') throw new Error('expected operation claim');

    const writerAssets = new AdminBrandingAssetService(db, { storage });
    const writerUpload = writerAssets.upload(actorUserId, request);
    await vi.waitFor(() => expect(storage.upload).toHaveBeenCalledOnce());

    const recoveryAssets = new AdminBrandingAssetService(db, { storage });
    const recoveryHarness = recoveryAssets as unknown as {
      waitForReplay: (assetId: string) => Promise<null>;
    };
    vi.spyOn(recoveryHarness, 'waitForReplay').mockImplementation(async () => {
      releaseUpload();
      await writerUpload;
      return null;
    });

    const recovered = await recoveryAssets.upload(actorUserId, request, {
      finalizeSuccess: (tx, result) =>
        operationService.succeed(tx, operation.claim, { kind: 'uploadAsset', ...result }),
    });
    const written = await writerUpload;
    expect(recovered).toEqual(written);
    expect(storage.upload).toHaveBeenCalledOnce();

    const [persistedOperation] = await db.select().from(platformBrandingOperations);
    expect(persistedOperation).toMatchObject({
      leaseOwner: null,
      leaseUntil: null,
      result: { kind: 'uploadAsset', ...recovered },
      status: 'succeeded',
    });

    const immediateService = new AdminBrandingService(db, {
      assetService: recoveryAssets,
      operationService,
    });
    await expect(immediateService.uploadAsset(actorUserId, request)).resolves.toEqual(recovered);

    const expiredOperationService = new AdminBrandingOperationService(db, {
      now: () => new Date('2099-01-01T00:00:00.000Z'),
    });
    const expiredService = new AdminBrandingService(db, {
      assetService: recoveryAssets,
      operationService: expiredOperationService,
    });
    await expect(expiredService.uploadAsset(actorUserId, request)).resolves.toEqual(recovered);
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(await db.select().from(platformBrandingOperations)).toEqual([persistedOperation]);
  });

  it('rejects a reused request ID with different normalized payload before writes or audit', async () => {
    let now = new Date('2026-07-19T00:00:00.000Z');
    const storage = {
      delete: vi.fn(async () => {}),
      isConfigured: () => true,
      upload: vi.fn(async () => {}),
    };
    const service = new AdminBrandingAssetService(db, { now: () => now, storage });
    const request = await input();
    await service.upload(actorUserId, request);
    const auditCount = (await db.select().from(platformAuditLogs)).length;
    const assetsBeforeConflict = await db.select().from(platformBrandingAssets);
    now = new Date('2026-07-21T00:00:00.000Z');

    await expect(
      service.upload(actorUserId, { ...request, reason: 'different approval' }),
    ).rejects.toBeInstanceOf(BrandingIdempotencyConflictError);
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await db.select().from(platformAuditLogs)).toHaveLength(auditCount);
    expect(await db.select().from(platformBrandingAssets)).toEqual(assetsBeforeConflict);
  });

  it('deletes the object and leaves a resumable tombstone when the ready transaction fails', async () => {
    const storage = {
      delete: vi.fn(async () => {}),
      isConfigured: () => true,
      upload: vi.fn(async () => {}),
    };
    const service = new AdminBrandingAssetService(db, {
      appendAudit: async () => {
        throw new Error('AUDIT_WRITE_FAILED');
      },
      storage,
    });

    await expect(service.upload(actorUserId, await input())).rejects.toThrow('AUDIT_WRITE_FAILED');
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledOnce();
    expect(await db.select().from(platformBrandingAssets)).toEqual([
      expect.objectContaining({ objectDeletedAt: expect.any(Date), status: 'orphaned' }),
    ]);
  });

  it('retries failed compensation with a bounded sweep and backoff', async () => {
    let now = new Date('2026-07-19T00:00:00.000Z');
    const storage = {
      delete: vi
        .fn()
        .mockRejectedValueOnce(new Error('S3_DELETE_FAILED'))
        .mockResolvedValue(undefined),
      isConfigured: () => true,
      upload: vi.fn(async () => {}),
    };
    const service = new AdminBrandingAssetService(db, {
      appendAudit: async () => {
        throw new Error('AUDIT_WRITE_FAILED');
      },
      now: () => now,
      storage,
    });
    await expect(service.upload(actorUserId, await input())).rejects.toThrow('AUDIT_WRITE_FAILED');
    let [asset] = await db.select().from(platformBrandingAssets);
    expect(asset).toMatchObject({ objectDeletedAt: null, status: 'orphaned' });

    now = new Date(asset.cleanupAfter.getTime() + 1);
    await expect(service.sweep({ limit: 1 })).resolves.toEqual({
      deleted: 1,
      failed: 0,
      scanned: 1,
    });
    [asset] = await db.select().from(platformBrandingAssets);
    expect(asset.objectDeletedAt).toBeInstanceOf(Date);
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it('keeps a platform asset ready after its uploading administrator is deleted', async () => {
    const storage = {
      delete: vi.fn(async () => {}),
      isConfigured: () => true,
      upload: vi.fn(async () => {}),
    };
    const service = new AdminBrandingAssetService(db, { storage });
    const result = await service.upload(actorUserId, await input());
    await db.delete(users).where(eq(users.id, actorUserId));
    const [asset] = await db.select().from(platformBrandingAssets);

    expect(asset).toMatchObject({ createdBy: null, requestActorId: actorUserId, status: 'ready' });
    expect(result.url).toBe(`/f/${asset.id}`);
  });

  it('sweeps only unpinned ready objects after grace and permanently retains published assets', async () => {
    let now = new Date('2026-07-19T00:00:00.000Z');
    const storage = {
      delete: vi.fn(async () => {}),
      isConfigured: () => true,
      upload: vi.fn(async () => {}),
    };
    const service = new AdminBrandingAssetService(db, { now: () => now, storage });
    const first = await service.upload(actorUserId, await input());
    const second = await service.upload(actorUserId, await input());
    const publishedId = second.url.slice('/f/'.length);
    await db
      .update(platformBrandingAssets)
      .set({ firstPublishedRevision: 1 })
      .where(eq(platformBrandingAssets.id, publishedId));
    const rows = await db.select().from(platformBrandingAssets);
    now = new Date(Math.max(...rows.map((row) => row.cleanupAfter.getTime())) + 1);

    await expect(service.sweep({ limit: 1000 })).resolves.toEqual({
      deleted: 1,
      failed: 0,
      scanned: 1,
    });
    expect(storage.delete).toHaveBeenCalledWith(
      expect.stringContaining(first.url.slice('/f/'.length)),
    );
    expect(storage.delete).not.toHaveBeenCalledWith(expect.stringContaining(publishedId));
  });

  it('rejects a draft pin after cleanup has atomically claimed the asset', async () => {
    let now = new Date('2026-07-19T00:00:00.000Z');
    let deleteEntered!: () => void;
    let allowDelete!: () => void;
    const entered = new Promise<void>((resolve) => {
      deleteEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      allowDelete = resolve;
    });
    const storage = {
      delete: vi.fn(async () => {
        deleteEntered();
        await gate;
      }),
      isConfigured: () => true,
      upload: vi.fn(async () => {}),
    };
    const service = new AdminBrandingAssetService(db, { now: () => now, storage });
    const uploaded = await service.upload(actorUserId, await input());
    const id = uploaded.url.slice('/f/'.length);
    const [ready] = await db.select().from(platformBrandingAssets);
    now = new Date(ready.cleanupAfter.getTime() + 1);
    const sweep = service.sweep({ limit: 1 });
    await entered;

    await expect(db.transaction((tx) => service.updateDraftPins(tx, [id]))).rejects.toThrow(
      'BRANDING_ASSET_CLEANUP_CLAIMED',
    );
    allowDelete();
    await expect(sweep).resolves.toEqual({ deleted: 1, failed: 0, scanned: 1 });
    expect(await db.select().from(platformBrandingAssets)).toEqual([
      expect.objectContaining({ draftPinned: false, objectDeletedAt: expect.any(Date) }),
    ]);
  });

  it('keeps a failed cleanup claim fenced through backoff and recovers it after lease expiry', async () => {
    let now = new Date('2026-07-19T00:00:00.000Z');
    const storage = {
      delete: vi
        .fn()
        .mockRejectedValueOnce(new Error('S3_DELETE_FAILED'))
        .mockResolvedValue(undefined),
      isConfigured: () => true,
      upload: vi.fn(async () => {}),
    };
    const service = new AdminBrandingAssetService(db, { now: () => now, storage });
    const uploaded = await service.upload(actorUserId, await input());
    const id = uploaded.url.slice('/f/'.length);
    let [asset] = await db.select().from(platformBrandingAssets);
    now = new Date(asset.cleanupAfter.getTime() + 1);

    await expect(service.sweep({ limit: 1 })).resolves.toEqual({
      deleted: 0,
      failed: 1,
      scanned: 1,
    });
    [asset] = await db.select().from(platformBrandingAssets);
    expect(asset).toMatchObject({ cleanupOwner: expect.any(String), objectDeletedAt: null });
    await expect(db.transaction((tx) => service.updateDraftPins(tx, [id]))).rejects.toThrow(
      'BRANDING_ASSET_CLEANUP_CLAIMED',
    );

    now = new Date(asset.cleanupLeaseUntil!.getTime() + 1);
    await expect(service.sweep({ limit: 1 })).resolves.toEqual({
      deleted: 1,
      failed: 0,
      scanned: 1,
    });
    [asset] = await db.select().from(platformBrandingAssets);
    expect(asset).toMatchObject({ cleanupOwner: null, objectDeletedAt: expect.any(Date) });
  });
});
