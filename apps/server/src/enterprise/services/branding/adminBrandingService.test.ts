// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAuditLogs,
  platformBranding,
  platformBrandingAssets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { AdminBrandingPayload } from '../../contracts/adminBranding';
import type { EnterpriseObservabilityEvent } from '../../observability';
import { setEnterprisePlatformObserverForTest } from '../../observability';
import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { AdminBrandingAssetService } from './adminBrandingAssetService';
import {
  AdminBrandingService,
  BRANDING_MIRROR_ROW_ID,
  BRANDING_PUBLISHED_ROW_ID,
  BrandingDraftValidationError,
  BrandingIdempotencyConflictError,
  BrandingOperationFailedReplayError,
  BrandingPersistenceInvariantError,
  PlatformRevisionConflictError,
} from './adminBrandingService';
import { BrandingPublishedReadService } from './publishedReadService';

const db: LobeChatDatabase = await getTestDB();
const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
const storage = {
  delete: vi.fn(async () => {}),
  isConfigured: () => true,
  upload: vi.fn(async () => {}),
};
const assetService = new AdminBrandingAssetService(db, { storage });
const service = new AdminBrandingService(db, { assetService, invalidation });
const observed: EnterpriseObservabilityEvent[] = [];
const publishEvents = () => observed.filter((event) => event.type === 'config_publish');

const branding = (name: string): AdminBrandingPayload => ({
  defaultAgentDisplayName: `${name} AI`,
  desktop: { iconUrl: null, productName: `${name} Desktop` },
  emailFrom: 'hello@example.com',
  emailSenderName: name,
  faviconUrl: null,
  homeUrl: 'https://example.com',
  iconUrl: null,
  legalName: `${name} Ltd`,
  logoUrl: null,
  name,
  ogImageUrl: null,
  pageTitleTemplate: `%s · ${name}`,
  privacyUrl: 'https://example.com/privacy',
  shortName: name,
  supportUrl: 'https://example.com/support',
  termsUrl: 'https://example.com/terms',
  themeDefaults: { primaryColor: '#3366FF' },
});

const request = () => ({ reason: 'operator approved', requestId: crypto.randomUUID() });

/** TRUNCATE bypasses append-only audit/revision immutability triggers (migration 0145). */
const cleanup = async () => {
  await db.execute(
    sql.raw(`
      TRUNCATE TABLE
        platform_audit_logs,
        platform_branding_operations,
        platform_resource_revisions,
        platform_branding,
        platform_branding_assets
      CASCADE
    `),
  );
};

beforeEach(async () => {
  await cleanup();
  invalidation.events.length = 0;
  invalidation.versions.clear();
  observed.length = 0;
  setEnterprisePlatformObserverForTest({ record: (event) => observed.push(event) });
});
afterEach(async () => {
  setEnterprisePlatformObserverForTest(null);
  await cleanup();
});

describe('AdminBrandingService', () => {
  it('creates only the fixed mirror row and never invents a public snapshot', async () => {
    const result = await service.get();
    const rows = await db.select().from(platformBranding);

    expect(result).toMatchObject({ revision: 0, updatedAt: null, updatedBy: null });
    expect(result.branding.name).toBeNull();
    expect(result.token).toHaveLength(64);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: BRANDING_MIRROR_ROW_ID, revision: 0, status: 'draft' });
  });

  it('saves live: published row, revision head, mirror row, audits and post-commit invalidation', async () => {
    const initial = await service.get();
    const saveRequest = {
      ...request(),
      branding: branding('Acme'),
      expectedRevision: initial.revision,
      expectedToken: initial.token,
    };
    const saved = await service.save('admin-1', saveRequest);
    const replay = await service.save('admin-1', saveRequest);
    const after = await service.get();
    const rows = await db.select().from(platformBranding);
    const revisions = await db.select().from(platformResourceRevisions);
    const audits = await db.select().from(platformAuditLogs);

    expect(saved).toEqual(replay);
    expect(saved).toMatchObject({ revision: 1, updatedBy: 'admin-1' });
    expect(saved.branding.name).toBe('Acme');
    expect(after).toEqual(saved);
    expect(rows.filter((row) => row.status === 'published')).toEqual([
      expect.objectContaining({ id: BRANDING_PUBLISHED_ROW_ID, revision: 1 }),
    ]);
    expect(rows.find((row) => row.id === BRANDING_MIRROR_ROW_ID)).toMatchObject({
      displayName: 'Acme',
      revision: 1,
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ resourceId: 'global', revision: 1, status: 'published' });
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'admin.branding.save', result: 'success' }),
    );
    expect(audits.filter((audit) => audit.action === 'admin.branding.save')).toHaveLength(1);
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'platform.branding.publish', result: 'success' }),
    );
    expect(JSON.stringify(audits)).not.toContain('hello@example.com');
    expect(invalidation.events).toEqual([
      expect.objectContaining({ resourceId: 'global', revision: 1, scopes: ['branding'] }),
    ]);
    expect(publishEvents()).toEqual([
      {
        domain: 'branding',
        durationMs: expect.any(Number),
        operation: 'publish',
        outcome: 'success',
        type: 'config_publish',
      },
    ]);
    expect(JSON.stringify(publishEvents())).not.toContain('operator approved');
    expect(JSON.stringify(publishEvents())).not.toContain(saveRequest.requestId);
  });

  it('serves the anonymous published snapshot from the first save', async () => {
    const initial = await service.get();
    await service.save('admin-1', {
      ...request(),
      branding: branding('Safe'),
      expectedRevision: initial.revision,
      expectedToken: initial.token,
    });
    const reader = new BrandingPublishedReadService(db, {
      cacheKey: {},
      getCacheEpoch: async () => 'branding-de-draft',
    });

    await expect(reader.getPublished()).resolves.toMatchObject({ name: 'Safe', revision: '1' });
  });

  it('rejects a stale CAS token, keeps Published intact and audits the redacted failure', async () => {
    const initial = await service.get();
    await service.save('admin-1', {
      ...request(),
      branding: branding('First'),
      expectedRevision: initial.revision,
      expectedToken: initial.token,
    });
    await db.execute(sql.raw('TRUNCATE TABLE platform_audit_logs CASCADE'));
    observed.length = 0;
    const staleRequest = {
      ...request(),
      branding: branding('Stale'),
      expectedRevision: 1,
      expectedToken: initial.token,
    };

    await expect(service.save('admin-1', staleRequest)).rejects.toBeInstanceOf(
      PlatformRevisionConflictError,
    );

    const after = await service.get();
    expect(after.branding.name).toBe('First');
    expect(after.revision).toBe(1);
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(1);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.branding.save',
        afterDiff: { error: 'revision_conflict' },
        result: 'failure',
      }),
    );
    await expect(service.save('admin-1', staleRequest)).rejects.toMatchObject({
      category: 'revision_conflict',
      name: BrandingOperationFailedReplayError.name,
    });
    await expect(
      service.save('admin-1', { ...staleRequest, branding: branding('Other') }),
    ).rejects.toBeInstanceOf(BrandingIdempotencyConflictError);
    expect(publishEvents()).toEqual([
      {
        domain: 'branding',
        durationMs: expect.any(Number),
        errorClass: 'ConflictError',
        operation: 'publish',
        outcome: 'conflict',
        type: 'config_publish',
      },
    ]);
  });

  it('rejects a stale expected revision behind an unchanged payload token', async () => {
    const initial = await service.get();
    await service.save('admin-1', {
      ...request(),
      branding: branding('First'),
      expectedRevision: initial.revision,
      expectedToken: initial.token,
    });
    const current = await service.get();

    await expect(
      service.save('admin-1', {
        ...request(),
        branding: branding('Second'),
        expectedRevision: 0,
        expectedToken: current.token,
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect((await service.get()).revision).toBe(1);
  });

  it('leaves no revision, publication or invalidation behind an invalid payload', async () => {
    const initial = await service.get();
    const invalidRequest = {
      ...request(),
      branding: { ...branding('Acme'), name: null },
      expectedRevision: initial.revision,
      expectedToken: initial.token,
    };

    await expect(service.save('admin-1', invalidRequest)).rejects.toBeInstanceOf(
      BrandingDraftValidationError,
    );
    await expect(service.save('admin-1', invalidRequest)).rejects.toBeInstanceOf(
      BrandingOperationFailedReplayError,
    );

    expect(await db.select().from(platformResourceRevisions)).toHaveLength(0);
    expect((await service.get()).branding.name).toBeNull();
    expect(invalidation.events).toEqual([]);
    expect(publishEvents()).toEqual([
      {
        domain: 'branding',
        durationMs: expect.any(Number),
        errorClass: 'ValidationError',
        operation: 'publish',
        outcome: 'failure',
        type: 'config_publish',
      },
    ]);
  });

  it('keeps a committed save successful when the observer throws', async () => {
    const initial = await service.get();
    const saveRequest = {
      ...request(),
      branding: branding('Acme'),
      expectedRevision: initial.revision,
      expectedToken: initial.token,
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setEnterprisePlatformObserverForTest({
      record: () => {
        throw new Error('observer unavailable');
      },
    });

    const saved = await service.save('admin-1', saveRequest);

    await expect(service.save('admin-1', saveRequest)).resolves.toEqual(saved);
    expect((await service.get()).branding.name).toBe('Acme');
    expect(consoleError).toHaveBeenCalledWith(
      '[enterprise-observability] metric sink failed',
      expect.objectContaining({ errorClass: 'UnexpectedError' }),
    );
  });

  it('binds the request ID to its payload without extra writes', async () => {
    const initial = await service.get();
    const saveRequest = {
      ...request(),
      branding: branding('First'),
      expectedRevision: initial.revision,
      expectedToken: initial.token,
    };
    await service.save('admin-1', saveRequest);
    const auditCount = (await db.select().from(platformAuditLogs)).length;

    await expect(
      service.save('admin-1', { ...saveRequest, reason: 'different publication' }),
    ).rejects.toBeInstanceOf(BrandingIdempotencyConflictError);

    expect((await db.select().from(platformAuditLogs)).length).toBe(auditCount);
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(1);
    expect((await service.get()).branding.name).toBe('First');
  });

  it.each([
    ['script markup', { shortName: '<script>alert(1)</script>' }],
    ['control character', { legalName: 'Acme\u0000Ltd' }],
    ['bidi control', { defaultAgentDisplayName: 'Acme\u202EAdmin' }],
    ['credential URL', { supportUrl: 'https://user:pass@example.com/help' }],
  ])('rejects %s before it can reach the public snapshot', async (_label, malicious) => {
    const initial = await service.get();

    await expect(
      service.save('admin-1', {
        ...request(),
        branding: { ...branding('Safe'), ...malicious },
        expectedRevision: initial.revision,
        expectedToken: initial.token,
      }),
    ).rejects.toBeInstanceOf(BrandingDraftValidationError);
    expect((await service.get()).revision).toBe(0);
  });

  it('validates and publishes every controlled asset reference in one bounded lookup', async () => {
    const ids = {
      desktop: 'pba_11111111-1111-4111-8111-111111111111',
      favicon: 'pba_22222222-2222-4222-8222-222222222222',
      icon: 'pba_33333333-3333-4333-8333-333333333333',
      logo: 'pba_44444444-4444-4444-8444-444444444444',
      og: 'pba_55555555-5555-4555-8555-555555555555',
    };
    const kindById = new Map([
      [ids.desktop, 'desktopIcon'],
      [ids.favicon, 'favicon'],
      [ids.icon, 'icon'],
      [ids.logo, 'logo'],
      [ids.og, 'ogImage'],
    ] as const);
    const lookup = vi.fn(async (_db, requestedIds: string[]) =>
      requestedIds.map((id) => ({
        cleanupOwner: null,
        id,
        kind: kindById.get(id)!,
        mimeType: 'image/png',
        objectDeletedAt: null,
        status: 'ready' as const,
      })),
    );
    const targetAssets = new AdminBrandingAssetService(db, { referenceLookup: lookup, storage });
    const target = new AdminBrandingService(db, { assetService: targetAssets, invalidation });
    await db.insert(platformBrandingAssets).values(
      Object.entries(ids).map(([name, id]) => ({
        cleanupAfter: new Date('2099-01-01T00:00:00.000Z'),
        height: 16,
        id,
        kind: kindById.get(id)!,
        mimeType: 'image/png',
        objectKey: `branding/test/${name}.png`,
        operation: 'admin.branding.uploadAsset',
        requestActorId: 'admin-1',
        requestFingerprint: name.padEnd(64, '0'),
        requestId: crypto.randomUUID(),
        sha256: name.padEnd(64, 'a'),
        size: 68,
        status: 'ready' as const,
        width: 16,
      })),
    );
    const initial = await target.get();
    await target.save('admin-1', {
      ...request(),
      branding: {
        ...branding('Assets'),
        desktop: { iconUrl: `/f/${ids.desktop}`, productName: 'Assets Desktop' },
        faviconUrl: `/f/${ids.favicon}`,
        iconUrl: `/f/${ids.icon}`,
        logoUrl: `/f/${ids.logo}`,
        ogImageUrl: `/f/${ids.og}`,
      },
      expectedRevision: initial.revision,
      expectedToken: initial.token,
    });
    const assets = await db.select().from(platformBrandingAssets);

    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0]?.[1]).toEqual(Object.values(ids));
    expect(assets).toHaveLength(5);
    for (const asset of assets) {
      expect(asset).toMatchObject({ draftPinned: true, firstPublishedRevision: 1 });
    }
  });

  it('fails closed instead of silently adopting an active random shell row', async () => {
    await db.insert(platformBranding).values({ id: 'legacy-random', status: 'published' });
    await expect(service.get()).rejects.toBeInstanceOf(BrandingPersistenceInvariantError);
    expect(await db.select().from(platformBranding)).toEqual([
      expect.objectContaining({ id: 'legacy-random' }),
    ]);
  });
});
