// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformSidebarLayout } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PLATFORM_SIDEBAR_LAYOUT_ID, PlatformSidebarLayoutModel } from './sidebarLayout';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformSidebarLayout);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformSidebarLayoutModel', () => {
  it('returns the built-in default (mode user, no layout) when the row is absent', async () => {
    const model = new PlatformSidebarLayoutModel(db);
    expect(await model.get()).toEqual({ layout: null, mode: 'user' });
  });

  it('persists a platform-managed layout and reads it back', async () => {
    const model = new PlatformSidebarLayoutModel(db);
    const layout = {
      hiddenSidebarSections: ['image'],
      sidebarItems: ['agent', 'recents', 'pages', 'image'],
    };

    const next = await model.update('admin-user', { layout, mode: 'platform' });
    expect(next).toEqual({ layout, mode: 'platform' });

    const [row] = await db.select().from(platformSidebarLayout);
    expect(row?.id).toBe(PLATFORM_SIDEBAR_LAYOUT_ID);
    expect(await model.get()).toEqual({ layout, mode: 'platform' });
  });

  it('upserts the single row on repeated writes (mode toggled back to user)', async () => {
    const model = new PlatformSidebarLayoutModel(db);
    await model.update('a', {
      layout: { hiddenSidebarSections: [], sidebarItems: ['agent'] },
      mode: 'platform',
    });
    await model.update('b', { layout: null, mode: 'user' });

    const rows = await db.select().from(platformSidebarLayout);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedBy).toBe('b');
    expect(await model.get()).toEqual({ layout: null, mode: 'user' });
  });
});
