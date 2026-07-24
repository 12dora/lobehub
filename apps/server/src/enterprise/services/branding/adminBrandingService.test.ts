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

import type { AdminBrandingDraft } from '../../contracts/adminBranding';
import type { EnterpriseObservabilityEvent } from '../../observability';
import { setEnterprisePlatformObserverForTest } from '../../observability';
import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { AdminBrandingAssetService } from './adminBrandingAssetService';
import {
  AdminBrandingService,
  BRANDING_DRAFT_ROW_ID,
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

const draft = (name: string): AdminBrandingDraft => ({
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
  it('creates only the fixed draft row and never invents a public snapshot', async () => {
    const result = await service.getDraft();
    const rows = await db.select().from(platformBranding);

    expect(result).toMatchObject({
      baseRevision: 0,
      draftMatchesPublished: false,
      published: null,
    });
    expect(result.draft.name).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: BRANDING_DRAFT_ROW_ID, revision: 0, status: 'draft' });
  });

  it('saves a CAS draft with an atomic success audit without changing Published', async () => {
    const initial = await service.getDraft();
    const saveRequest = {
      ...request(),
      draft: draft('Acme'),
      expectedDraftToken: initial.draftToken,
    };
    const saved = await service.saveDraft('admin-1', saveRequest);
    const replay = await service.saveDraft('admin-1', saveRequest);
    const after = await service.getDraft();
    const audits = await db.select().from(platformAuditLogs);

    expect(saved.draftToken).toBe(after.draftToken);
    expect(replay).toEqual(saved);
    expect(after.published).toBeNull();
    expect(after.draftMatchesPublished).toBe(false);
    expect(after.draft.name).toBe('Acme');
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'admin.branding.saveDraft', result: 'success' }),
    );
    expect(audits.filter((audit) => audit.action === 'admin.branding.saveDraft')).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain('hello@example.com');
  });

  it('publishes revision/history/audit/materialization atomically and invalidates after commit', async () => {
    const initial = await service.getDraft();
    const saved = await service.saveDraft('admin-1', {
      ...request(),
      draft: draft('Acme'),
      expectedDraftToken: initial.draftToken,
    });
    const publishRequest = {
      ...request(),
      expectedDraftToken: saved.draftToken,
      expectedRevision: 0,
    };
    const published = await service.publish('admin-1', publishRequest);
    const replay = await service.publish('admin-1', publishRequest);
    const after = await service.getDraft();
    const rows = await db.select().from(platformBranding);
    const revisions = await db.select().from(platformResourceRevisions);

    expect(published).toEqual(replay);
    expect(after.published).toMatchObject({ name: 'Acme', revision: 1 });
    expect(after.draftMatchesPublished).toBe(true);
    expect(after.baseRevision).toBe(1);
    expect(rows.filter((row) => row.status === 'published')).toEqual([
      expect.objectContaining({ id: BRANDING_PUBLISHED_ROW_ID, revision: 1 }),
    ]);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ resourceId: 'global', revision: 1, status: 'published' });
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
    expect(Object.keys(publishEvents()[0]!).sort()).toEqual([
      'domain',
      'durationMs',
      'operation',
      'outcome',
      'type',
    ]);
    expect(JSON.stringify(publishEvents())).not.toContain('operator approved');
    expect(JSON.stringify(publishEvents())).not.toContain(publishRequest.requestId);
  });

  it('observes a publication conflict once and not its failed replay', async () => {
    const initial = await service.getDraft();
    const saved = await service.saveDraft('admin-1', {
      ...request(),
      draft: draft('Acme'),
      expectedDraftToken: initial.draftToken,
    });
    const publishRequest = {
      ...request(),
      expectedDraftToken: saved.draftToken,
      expectedRevision: 1,
    };

    await expect(service.publish('admin-1', publishRequest)).rejects.toBeInstanceOf(
      PlatformRevisionConflictError,
    );
    await expect(service.publish('admin-1', publishRequest)).rejects.toBeInstanceOf(
      BrandingOperationFailedReplayError,
    );

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

  it('observes a publication failure once and not its failed replay', async () => {
    const initial = await service.getDraft();
    const publishRequest = {
      ...request(),
      expectedDraftToken: initial.draftToken,
      expectedRevision: 0,
    };

    await expect(service.publish('admin-1', publishRequest)).rejects.toBeInstanceOf(
      BrandingDraftValidationError,
    );
    await expect(service.publish('admin-1', publishRequest)).rejects.toBeInstanceOf(
      BrandingOperationFailedReplayError,
    );

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

  it('keeps a committed publication successful when the observer throws', async () => {
    const initial = await service.getDraft();
    const saved = await service.saveDraft('admin-1', {
      ...request(),
      draft: draft('Acme'),
      expectedDraftToken: initial.draftToken,
    });
    const publishRequest = {
      ...request(),
      expectedDraftToken: saved.draftToken,
      expectedRevision: 0,
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setEnterprisePlatformObserverForTest({
      record: () => {
        throw new Error('observer unavailable');
      },
    });

    const published = await service.publish('admin-1', publishRequest);

    await expect(service.publish('admin-1', publishRequest)).resolves.toEqual(published);
    expect((await service.getDraft()).published).toMatchObject({ name: 'Acme', revision: 1 });
    expect(consoleError).toHaveBeenCalledWith(
      '[enterprise-observability] metric sink failed',
      expect.objectContaining({ errorClass: 'UnexpectedError' }),
    );
  });

  it('rejects stale draft tokens and records a redacted best-effort failure audit', async () => {
    const initial = await service.getDraft();
    const failedRequest = {
      ...request(),
      draft: draft('Acme'),
      expectedDraftToken: '0'.repeat(64),
    };
    await expect(service.saveDraft('admin-1', failedRequest)).rejects.toBeInstanceOf(
      PlatformRevisionConflictError,
    );

    const after = await service.getDraft();
    expect(after.draft).toEqual(initial.draft);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.branding.saveDraft',
        afterDiff: { error: 'revision_conflict' },
        result: 'failure',
      }),
    );
    await db.execute(sql.raw('TRUNCATE TABLE platform_audit_logs CASCADE'));
    await expect(service.saveDraft('admin-1', failedRequest)).rejects.toMatchObject({
      category: 'revision_conflict',
      name: BrandingOperationFailedReplayError.name,
    });
    await expect(
      service.saveDraft('admin-1', { ...failedRequest, draft: draft('Different') }),
    ).rejects.toBeInstanceOf(BrandingIdempotencyConflictError);
    expect((await service.getDraft()).draft).toEqual(initial.draft);
  });

  it('binds save and publish request IDs to their normalized payload without extra writes', async () => {
    const initial = await service.getDraft();
    const saveRequest = {
      ...request(),
      draft: draft('First'),
      expectedDraftToken: initial.draftToken,
    };
    const saved = await service.saveDraft('admin-1', saveRequest);
    const auditCountAfterSave = (await db.select().from(platformAuditLogs)).length;

    await expect(
      service.saveDraft('admin-1', { ...saveRequest, draft: draft('Different') }),
    ).rejects.toBeInstanceOf(BrandingIdempotencyConflictError);
    expect((await db.select().from(platformAuditLogs)).length).toBe(auditCountAfterSave);
    expect((await service.getDraft()).draft.name).toBe('First');

    const publishRequest = {
      ...request(),
      expectedDraftToken: saved.draftToken,
      expectedRevision: 0,
    };
    await service.publish('admin-1', publishRequest);
    const auditCountAfterPublish = (await db.select().from(platformAuditLogs)).length;
    await expect(
      service.publish('admin-1', { ...publishRequest, reason: 'different publication' }),
    ).rejects.toBeInstanceOf(BrandingIdempotencyConflictError);
    expect((await db.select().from(platformAuditLogs)).length).toBe(auditCountAfterPublish);
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(1);
  });

  it.each([
    ['script markup', { shortName: '<script>alert(1)</script>' }],
    ['control character', { legalName: 'Acme\u0000Ltd' }],
    ['bidi control', { defaultAgentDisplayName: 'Acme\u202EAdmin' }],
    ['credential URL', { supportUrl: 'https://user:pass@example.com/help' }],
  ])('rejects %s before it can invalidate the public snapshot', async (_label, malicious) => {
    const initial = await service.getDraft();
    await expect(
      service.saveDraft('admin-1', {
        ...request(),
        draft: { ...draft('Safe'), ...malicious },
        expectedDraftToken: initial.draftToken,
      }),
    ).rejects.toBeInstanceOf(BrandingDraftValidationError);
    expect((await service.getDraft()).published).toBeNull();
  });

  it('keeps the anonymous Published read valid after malicious save attempts', async () => {
    const initial = await service.getDraft();
    const saved = await service.saveDraft('admin-1', {
      ...request(),
      draft: draft('Safe'),
      expectedDraftToken: initial.draftToken,
    });
    await service.publish('admin-1', {
      ...request(),
      expectedDraftToken: saved.draftToken,
      expectedRevision: 0,
    });
    const current = await service.getDraft();
    for (const malicious of [
      { shortName: '<script>alert(1)</script>' },
      { legalName: 'Acme\u0000Ltd' },
      { defaultAgentDisplayName: 'Acme\u202EAdmin' },
      { supportUrl: 'https://user:pass@example.com/help' },
    ]) {
      await expect(
        service.saveDraft('admin-1', {
          ...request(),
          draft: { ...current.draft, ...malicious },
          expectedDraftToken: current.draftToken,
        }),
      ).rejects.toBeInstanceOf(BrandingDraftValidationError);
    }
    const reader = new BrandingPublishedReadService(db, {
      cacheKey: {},
      getCacheEpoch: async () => 'security-regression',
    });
    await expect(reader.getPublished()).resolves.toMatchObject({ name: 'Safe', revision: '1' });
  });

  it('validates every controlled asset reference in one bounded metadata lookup', async () => {
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
    const target = new AdminBrandingService(db, {
      assetService: targetAssets,
      invalidation,
    });
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
    const initial = await target.getDraft();
    await target.saveDraft('admin-1', {
      ...request(),
      draft: {
        ...draft('Assets'),
        desktop: { iconUrl: `/f/${ids.desktop}`, productName: 'Assets Desktop' },
        faviconUrl: `/f/${ids.favicon}`,
        iconUrl: `/f/${ids.icon}`,
        logoUrl: `/f/${ids.logo}`,
        ogImageUrl: `/f/${ids.og}`,
      },
      expectedDraftToken: initial.draftToken,
    });

    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0]?.[1]).toEqual(Object.values(ids));
  });

  it('restores history into Draft without silently changing Published', async () => {
    const initial = await service.getDraft();
    const firstSave = await service.saveDraft('admin-1', {
      ...request(),
      draft: draft('First'),
      expectedDraftToken: initial.draftToken,
    });
    await service.publish('admin-1', {
      ...request(),
      expectedDraftToken: firstSave.draftToken,
      expectedRevision: 0,
    });
    const afterFirst = await service.getDraft();
    const secondSave = await service.saveDraft('admin-1', {
      ...request(),
      draft: draft('Second'),
      expectedDraftToken: afterFirst.draftToken,
    });
    await service.publish('admin-1', {
      ...request(),
      expectedDraftToken: secondSave.draftToken,
      expectedRevision: 1,
    });
    const beforeRollback = await service.getDraft();
    observed.length = 0;
    const rollbackRequest = {
      ...request(),
      expectedDraftToken: beforeRollback.draftToken,
      expectedRevision: 2,
      targetRevision: 1,
    };
    const restored = await service.rollback('admin-1', rollbackRequest);
    const replay = await service.rollback('admin-1', rollbackRequest);
    const auditCount = (await db.select().from(platformAuditLogs)).length;
    await expect(
      service.rollback('admin-1', { ...rollbackRequest, reason: 'different rollback' }),
    ).rejects.toBeInstanceOf(BrandingIdempotencyConflictError);
    const after = await service.getDraft();

    expect(restored.draft.name).toBe('First');
    expect(replay).toEqual(restored);
    expect(after.draft.name).toBe('First');
    expect(after.published).toMatchObject({ name: 'Second', revision: 2 });
    expect(await db.select().from(platformAuditLogs)).toHaveLength(auditCount);
    expect(invalidation.events).toHaveLength(2);
    expect(observed).toEqual([]);
  });

  it('fails closed instead of silently adopting an active random shell row', async () => {
    await db.insert(platformBranding).values({ id: 'legacy-random', status: 'published' });
    await expect(service.getDraft()).rejects.toBeInstanceOf(BrandingPersistenceInvariantError);
    expect(await db.select().from(platformBranding)).toEqual([
      expect.objectContaining({ id: 'legacy-random' }),
    ]);
  });
});
