// @vitest-environment node
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs, platformBrandingAssets, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import type { AdminBrandingUploadAssetInput } from '../../contracts/adminBranding';
import {
  AdminBrandingAssetService,
  BrandingIdempotencyConflictError,
} from './adminBrandingAssetService';

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
  await db.delete(platformAuditLogs);
  await db.delete(platformBrandingAssets);
  await db.delete(users).where(eq(users.id, actorUserId));
};

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values({ id: actorUserId });
});

afterEach(cleanup);

describe('AdminBrandingAssetService', () => {
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
