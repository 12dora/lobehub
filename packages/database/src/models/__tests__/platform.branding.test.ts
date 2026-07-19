// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformBranding } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformBrandingModel, PlatformBrandingPublicationInvariantError } from '../platform';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformBrandingModel(serverDB);

const cleanup = async () => serverDB.delete(platformBranding);

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformBrandingModel', () => {
  it('returns the unique Published row and ignores drafts', async () => {
    await serverDB.insert(platformBranding).values([
      { displayName: 'Published Brand', revision: 8, status: 'published' },
      { displayName: 'Draft Brand', revision: 9, status: 'draft' },
    ]);

    await expect(model.getPublished()).resolves.toMatchObject({
      displayName: 'Published Brand',
      revision: 8,
    });
  });

  it('fails closed when the database contains duplicate Published rows', async () => {
    await serverDB.insert(platformBranding).values([
      { displayName: 'First', revision: 1, status: 'published' },
      { displayName: 'Second', revision: 2, status: 'published' },
    ]);

    await expect(model.getPublished()).rejects.toBeInstanceOf(
      PlatformBrandingPublicationInvariantError,
    );
  });
});
