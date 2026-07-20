// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformSettingsBundle } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformDomainTargetResolver } from './domainTargets';

const db: LobeChatDatabase = await getTestDB();
const env = { ENABLE_PLATFORM_SETTINGS_POLICY: '1' };

beforeEach(async () => db.delete(platformSettingsBundle));
afterEach(async () => db.delete(platformSettingsBundle));

describe('PlatformDomainTargetResolver (PGlite)', () => {
  it('uses revision zero only when the global settings bundle is absent', async () => {
    const resolver = new PlatformDomainTargetResolver(db, { env });
    await expect(resolver.resolve('settings')).resolves.toMatchObject({
      status: 'available',
      token: { kind: 'revision', value: 0 },
    });

    await db.insert(platformSettingsBundle).values({
      id: 'global',
      revision: 2,
      status: 'published',
    });
    await expect(resolver.resolve('settings')).resolves.toMatchObject({
      status: 'available',
      token: { kind: 'revision', value: 2 },
    });
  });

  it('fails closed when a positive settings pointer is not published', async () => {
    await db.insert(platformSettingsBundle).values({ id: 'global', revision: 1, status: 'draft' });

    await expect(
      new PlatformDomainTargetResolver(db, { env }).resolve('settings'),
    ).resolves.toMatchObject({
      errorCategory: 'configuration_invalid',
      status: 'unavailable',
      token: null,
    });
  });
});
