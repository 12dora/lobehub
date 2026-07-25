// @vitest-environment node
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import * as schema from '@/database/schemas';
import {
  platformBranding,
  platformBrandingAssets,
  platformBrandingOperations,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { AdminBrandingDraft } from '../../contracts/adminBranding';
import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { AdminBrandingAssetService } from './adminBrandingAssetService';
import {
  AdminBrandingService,
  BRANDING_RESOURCE_ID,
  BrandingDraftValidationError,
} from './adminBrandingService';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const INTERLEAVING_PROBE_MS = 100;
const assetId = 'pba_77777777-7777-4777-8777-777777777777';

const draft = (): AdminBrandingDraft => ({
  defaultAgentDisplayName: null,
  desktop: { iconUrl: null, productName: null },
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: null,
  logoUrl: `/f/${assetId}`,
  name: 'Cleanup Race Brand',
  ogImageUrl: null,
  pageTitleTemplate: '%s · Cleanup Race Brand',
  privacyUrl: null,
  shortName: null,
  supportUrl: null,
  termsUrl: null,
  themeDefaults: { primaryColor: null },
});

const createGate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
};

describe.skipIf(!enabled)('Branding cleanup/pin interleavings (PostgreSQL)', () => {
  beforeAll(async () => {
    await getTestDB();
  });

  const withDatabases = async (
    run: (params: { firstDb: LobeChatDatabase; secondDb: LobeChatDatabase }) => Promise<void>,
  ) => {
    const connectionString = process.env.DATABASE_TEST_URL!;
    const firstPool = new Pool({ connectionString, max: 1 });
    const secondPool = new Pool({ connectionString, max: 1 });
    const firstDb = drizzle(firstPool, { schema }) as unknown as LobeChatDatabase;
    const secondDb = drizzle(secondPool, { schema }) as unknown as LobeChatDatabase;
    const cleanup = async () => {
      await deletePlatformAuditLogsForTest(firstDb, { actorUserIds: ['admin-cleanup-race'] });
      await firstDb.delete(platformBrandingOperations);
      await deletePlatformResourceRevisionsForTest(firstDb, {
        resourceIds: [BRANDING_RESOURCE_ID],
        resourceType: 'branding',
      });
      await firstDb.delete(platformBranding);
      await firstDb.delete(platformBrandingAssets);
    };
    try {
      await cleanup();
      await firstDb.insert(platformBrandingAssets).values({
        cleanupAfter: new Date('2000-01-01T00:00:00.000Z'),
        height: 16,
        id: assetId,
        kind: 'logo',
        mimeType: 'image/png',
        objectKey: 'branding/test/cleanup-race.png',
        operation: 'admin.branding.uploadAsset',
        requestActorId: 'admin-cleanup-race',
        requestFingerprint: 'a'.repeat(64),
        requestId: '88888888-8888-4888-8888-888888888888',
        sha256: 'b'.repeat(64),
        size: 68,
        status: 'ready',
        width: 16,
      });
      await run({ firstDb, secondDb });
    } finally {
      await cleanup();
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  };

  it('rejects save when cleanup claims first and never leaves a deleted asset pinned', async () => {
    await withDatabases(async ({ firstDb, secondDb }) => {
      const deleteEntered = createGate();
      const allowDelete = createGate();
      const storage = {
        delete: vi.fn(async () => {
          deleteEntered.open();
          await allowDelete.promise;
        }),
        isConfigured: () => true,
        upload: vi.fn(async () => {}),
      };
      const service = new AdminBrandingService(firstDb, {
        assetService: new AdminBrandingAssetService(firstDb, { storage }),
      });
      const initial = await service.getDraft();
      const sweep = new AdminBrandingAssetService(secondDb, { storage }).sweep({ limit: 1 });
      await deleteEntered.promise;

      await expect(
        service.saveDraft('admin-cleanup-race', {
          draft: draft(),
          expectedDraftToken: initial.draftToken,
          reason: 'save after cleanup claim',
          requestId: crypto.randomUUID(),
        }),
      ).rejects.toBeInstanceOf(BrandingDraftValidationError);
      allowDelete.open();
      await expect(sweep).resolves.toEqual({ deleted: 1, failed: 0, scanned: 1 });
      const [asset] = await firstDb.select().from(platformBrandingAssets);
      expect(asset).toMatchObject({ draftPinned: false, objectDeletedAt: expect.any(Date) });
    });
  });

  it('makes cleanup lose when save pins first', async () => {
    await withDatabases(async ({ firstDb, secondDb }) => {
      const pinEntered = createGate();
      const allowPinCommit = createGate();
      const storage = {
        delete: vi.fn(async () => {}),
        isConfigured: () => true,
        upload: vi.fn(async () => {}),
      };
      const assets = new AdminBrandingAssetService(firstDb, { storage });
      const originalPin = assets.updateDraftPins;
      assets.updateDraftPins = async (tx, ids) => {
        await originalPin(tx, ids);
        pinEntered.open();
        await allowPinCommit.promise;
      };
      const service = new AdminBrandingService(firstDb, { assetService: assets });
      const initial = await service.getDraft();
      const save = service.saveDraft('admin-cleanup-race', {
        draft: draft(),
        expectedDraftToken: initial.draftToken,
        reason: 'pin before cleanup',
        requestId: crypto.randomUUID(),
      });
      await pinEntered.promise;
      const sweep = new AdminBrandingAssetService(secondDb, { storage }).sweep({ limit: 1 });
      await expect(
        Promise.race([
          sweep.then(() => 'finished'),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), INTERLEAVING_PROBE_MS)),
        ]),
      ).resolves.toBe('blocked');
      allowPinCommit.open();

      await expect(save).resolves.toMatchObject({ ok: true });
      await expect(sweep).resolves.toEqual({ deleted: 0, failed: 0, scanned: 0 });
      expect(storage.delete).not.toHaveBeenCalled();
      expect(await firstDb.select().from(platformBrandingAssets)).toEqual([
        expect.objectContaining({ draftPinned: true, objectDeletedAt: null }),
      ]);
    });
  });

  it('makes cleanup lose when publish pins first', async () => {
    await withDatabases(async ({ firstDb, secondDb }) => {
      const pinEntered = createGate();
      const allowPinCommit = createGate();
      const storage = {
        delete: vi.fn(async () => {}),
        isConfigured: () => true,
        upload: vi.fn(async () => {}),
      };
      const assets = new AdminBrandingAssetService(firstDb, { storage });
      const service = new AdminBrandingService(firstDb, {
        assetService: assets,
        invalidation: new InMemoryPlatformConfigInvalidationPublisher(),
      });
      const initial = await service.getDraft();
      const saved = await service.saveDraft('admin-cleanup-race', {
        draft: draft(),
        expectedDraftToken: initial.draftToken,
        reason: 'prepare publish race',
        requestId: crypto.randomUUID(),
      });
      await firstDb
        .update(platformBrandingAssets)
        .set({ cleanupAfter: new Date('2000-01-01T00:00:00.000Z'), draftPinned: false })
        .where(eq(platformBrandingAssets.id, assetId));
      const originalPin = assets.pinPublished;
      assets.pinPublished = async (tx, ids, revision) => {
        await originalPin(tx, ids, revision);
        pinEntered.open();
        await allowPinCommit.promise;
      };
      const publish = service.publish('admin-cleanup-race', {
        expectedDraftToken: saved.draftToken,
        expectedRevision: 0,
        reason: 'publish before cleanup',
        requestId: crypto.randomUUID(),
      });
      await pinEntered.promise;
      const sweep = new AdminBrandingAssetService(secondDb, { storage }).sweep({ limit: 1 });
      await expect(
        Promise.race([
          sweep.then(() => 'finished'),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), INTERLEAVING_PROBE_MS)),
        ]),
      ).resolves.toBe('blocked');
      allowPinCommit.open();

      await expect(publish).resolves.toMatchObject({ revision: 1 });
      await expect(sweep).resolves.toEqual({ deleted: 0, failed: 0, scanned: 0 });
      expect(await firstDb.select().from(platformBrandingAssets)).toEqual([
        expect.objectContaining({ draftPinned: true, firstPublishedRevision: 1 }),
      ]);
    });
  });

  it('rejects publish when cleanup claims first', async () => {
    await withDatabases(async ({ firstDb, secondDb }) => {
      const deleteEntered = createGate();
      const allowDelete = createGate();
      const storage = {
        delete: vi.fn(async () => {
          deleteEntered.open();
          await allowDelete.promise;
        }),
        isConfigured: () => true,
        upload: vi.fn(async () => {}),
      };
      const service = new AdminBrandingService(firstDb, {
        assetService: new AdminBrandingAssetService(firstDb, { storage }),
      });
      const initial = await service.getDraft();
      const saved = await service.saveDraft('admin-cleanup-race', {
        draft: draft(),
        expectedDraftToken: initial.draftToken,
        reason: 'prepare claimed publish',
        requestId: crypto.randomUUID(),
      });
      await firstDb
        .update(platformBrandingAssets)
        .set({ cleanupAfter: new Date('2000-01-01T00:00:00.000Z'), draftPinned: false })
        .where(eq(platformBrandingAssets.id, assetId));
      const sweep = new AdminBrandingAssetService(secondDb, { storage }).sweep({ limit: 1 });
      await deleteEntered.promise;

      await expect(
        service.publish('admin-cleanup-race', {
          expectedDraftToken: saved.draftToken,
          expectedRevision: 0,
          reason: 'publish after cleanup',
          requestId: crypto.randomUUID(),
        }),
      ).rejects.toBeInstanceOf(BrandingDraftValidationError);
      allowDelete.open();
      await sweep;
      expect(await firstDb.select().from(platformResourceRevisions)).toHaveLength(0);
      expect(await firstDb.select().from(platformBrandingAssets)).toEqual([
        expect.objectContaining({ draftPinned: false, objectDeletedAt: expect.any(Date) }),
      ]);
    });
  });
});
