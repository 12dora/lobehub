// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformBranding } from '../../schemas/platform/branding';
import type { LobeChatDatabase } from '../../type';
import { PlatformBrandingRepository } from '.';

const serverDB: LobeChatDatabase = await getTestDB();
const repository = new PlatformBrandingRepository(serverDB);

const cleanup = async () => serverDB.delete(platformBranding);

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformBrandingRepository', () => {
  it('returns only Published rows using the anonymous-safe projection', async () => {
    await serverDB.insert(platformBranding).values([
      {
        displayName: 'Draft Brand',
        revision: 4,
        status: 'draft',
        themeDefaults: { secretLookingAdminDetail: true },
      },
      {
        displayName: 'Published Brand',
        logoUrl: '/brand.png',
        revision: 3,
        status: 'published',
        themeDefaults: { primaryColor: '#e4002b', shouldNotLeaveTheDatabase: true },
      },
    ]);

    const rows = await repository.listPublished();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ displayName: 'Published Brand', revision: 3 });
    // The platform primary colour ships with the published row; anything else stored
    // under theme defaults is stripped by the published read service's schema, not here.
    expect(rows[0].themeDefaults).toEqual({
      primaryColor: '#e4002b',
      shouldNotLeaveTheDatabase: true,
    });
    expect(rows[0]).not.toHaveProperty('desktop');
    expect(rows[0]).not.toHaveProperty('createdBy');
  });

  it('returns at most two rows so the model can detect duplicate Published state', async () => {
    await serverDB.insert(platformBranding).values(
      [1, 2, 3].map((revision) => ({
        displayName: `Brand ${revision}`,
        revision,
        status: 'published' as const,
      })),
    );

    const rows = await repository.listPublished();
    expect(rows.map((row) => row.revision)).toEqual([3, 2]);
  });
});
