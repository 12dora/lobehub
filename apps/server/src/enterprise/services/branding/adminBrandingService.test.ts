// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAuditLogs,
  platformBranding,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { AdminBrandingDraft } from '../../contracts/adminBranding';
import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import {
  AdminBrandingService,
  BRANDING_DRAFT_ROW_ID,
  BRANDING_PUBLISHED_ROW_ID,
  BrandingPersistenceInvariantError,
  PlatformRevisionConflictError,
} from './adminBrandingService';

const db: LobeChatDatabase = await getTestDB();
const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
const storage = {
  isConfigured: () => true,
  upload: vi.fn(async () => ({ url: '/f/branding-asset' })),
};
const service = new AdminBrandingService(db, { assetStorage: storage, invalidation });

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

const cleanup = async () => {
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformBranding);
};

beforeEach(async () => {
  await cleanup();
  invalidation.events.length = 0;
  invalidation.versions.clear();
});
afterEach(cleanup);

describe('AdminBrandingService', () => {
  it('creates only the fixed draft row and never invents a public snapshot', async () => {
    const result = await service.getDraft();
    const rows = await db.select().from(platformBranding);

    expect(result).toMatchObject({ baseRevision: 0, published: null });
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
    expect(after.baseRevision).toBe(1);
    expect(rows.filter((row) => row.status === 'published')).toEqual([
      expect.objectContaining({ id: BRANDING_PUBLISHED_ROW_ID, revision: 1 }),
    ]);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ resourceId: 'global', revision: 1, status: 'published' });
    expect(invalidation.events).toEqual([
      expect.objectContaining({ resourceId: 'global', revision: 1, scopes: ['branding'] }),
    ]);
  });

  it('rejects stale draft tokens and records a redacted best-effort failure audit', async () => {
    const initial = await service.getDraft();
    await expect(
      service.saveDraft('admin-1', {
        ...request(),
        draft: draft('Acme'),
        expectedDraftToken: '0'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const after = await service.getDraft();
    expect(after.draft).toEqual(initial.draft);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.branding.saveDraft', result: 'failure' }),
    );
  });

  it('validates every controlled asset reference in one bounded metadata lookup', async () => {
    const lookup = vi.fn(async (_db, ids: string[]) =>
      ids.map((id) => ({
        fileType: 'image/png',
        id,
        metadata: {
          brandingAsset: true,
          kind: {
            desktop: 'desktopIcon',
            favicon: 'favicon',
            icon: 'icon',
            logo: 'logo',
            og: 'ogImage',
          }[id],
        },
      })),
    );
    const target = new AdminBrandingService(db, {
      assetReferenceLookup: lookup,
      assetStorage: storage,
      invalidation,
    });
    const initial = await target.getDraft();
    await target.saveDraft('admin-1', {
      ...request(),
      draft: {
        ...draft('Assets'),
        desktop: { iconUrl: '/f/desktop', productName: 'Assets Desktop' },
        faviconUrl: '/f/favicon',
        iconUrl: '/f/icon',
        logoUrl: '/f/logo',
        ogImageUrl: '/f/og',
      },
      expectedDraftToken: initial.draftToken,
    });

    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0]?.[1]).toEqual(['desktop', 'favicon', 'icon', 'logo', 'og']);
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
    const rollbackRequest = {
      ...request(),
      expectedDraftToken: beforeRollback.draftToken,
      expectedRevision: 2,
      targetRevision: 1,
    };
    const restored = await service.rollback('admin-1', rollbackRequest);
    const replay = await service.rollback('admin-1', rollbackRequest);
    const after = await service.getDraft();

    expect(restored.draft.name).toBe('First');
    expect(replay).toEqual(restored);
    expect(after.draft.name).toBe('First');
    expect(after.published).toMatchObject({ name: 'Second', revision: 2 });
    expect(invalidation.events).toHaveLength(2);
  });

  it('fails closed instead of silently adopting an active random shell row', async () => {
    await db.insert(platformBranding).values({ id: 'legacy-random', status: 'published' });
    await expect(service.getDraft()).rejects.toBeInstanceOf(BrandingPersistenceInvariantError);
    expect(await db.select().from(platformBranding)).toEqual([
      expect.objectContaining({ id: 'legacy-random' }),
    ]);
  });
});
