// @vitest-environment node
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { serverDBEnv } from '@/config/db';
import { getTestDB } from '@/database/core/getTestDB';
import * as schema from '@/database/schemas';
import {
  platformAuditLogs,
  platformBranding,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { AdminBrandingDraft } from '../../contracts/adminBranding';
import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { AdminBrandingService, PlatformRevisionConflictError } from './adminBrandingService';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

const draft: AdminBrandingDraft = {
  defaultAgentDisplayName: null,
  desktop: { iconUrl: null, productName: null },
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: null,
  logoUrl: null,
  name: 'Concurrent Brand',
  ogImageUrl: null,
  pageTitleTemplate: '%s · Concurrent Brand',
  privacyUrl: null,
  shortName: null,
  supportUrl: null,
  termsUrl: null,
  themeDefaults: { primaryColor: null },
};

describe.skipIf(!enabled)('AdminBrandingService advisory lock (PostgreSQL)', () => {
  it('serializes two publishers into one immutable revision and fixed Published row', async () => {
    await getTestDB();
    const connectionString = serverDBEnv.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const firstPool = new Pool({ connectionString, max: 1 });
    const secondPool = new Pool({ connectionString, max: 1 });
    const firstDb = drizzle(firstPool, { schema }) as unknown as LobeChatDatabase;
    const secondDb = drizzle(secondPool, { schema }) as unknown as LobeChatDatabase;
    const storage = { isConfigured: () => false, upload: async () => ({ url: '/f/unused' }) };
    const first = new AdminBrandingService(firstDb, {
      assetStorage: storage,
      invalidation: new InMemoryPlatformConfigInvalidationPublisher(),
    });
    const second = new AdminBrandingService(secondDb, {
      assetStorage: storage,
      invalidation: new InMemoryPlatformConfigInvalidationPublisher(),
    });
    const cleanup = async () => {
      await firstDb.delete(platformAuditLogs);
      await firstDb.delete(platformResourceRevisions);
      await firstDb.delete(platformBranding);
    };

    try {
      await cleanup();
      const initial = await first.getDraft();
      const saved = await first.saveDraft('admin', {
        draft,
        expectedDraftToken: initial.draftToken,
        reason: 'prepare concurrent publication',
        requestId: crypto.randomUUID(),
      });
      const results = await Promise.allSettled([
        first.publish('admin', {
          expectedDraftToken: saved.draftToken,
          expectedRevision: 0,
          reason: 'first contender',
          requestId: crypto.randomUUID(),
        }),
        second.publish('admin', {
          expectedDraftToken: saved.draftToken,
          expectedRevision: 0,
          reason: 'second contender',
          requestId: crypto.randomUUID(),
        }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({ reason: expect.any(PlatformRevisionConflictError) });
      expect(await firstDb.select().from(platformResourceRevisions)).toHaveLength(1);
      const rows = await firstDb.select().from(platformBranding);
      expect(rows.filter((row) => row.id === 'branding:draft')).toHaveLength(1);
      expect(rows.filter((row) => row.id === 'branding:published')).toEqual([
        expect.objectContaining({ revision: 1, status: 'published' }),
      ]);
    } finally {
      await cleanup();
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  }, 15_000);
});
