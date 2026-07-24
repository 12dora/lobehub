// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformSidebarLayout } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformRevisionConflictError } from './errors';
import { PLATFORM_SIDEBAR_LAYOUT_ID, PlatformSidebarLayoutModel } from './sidebarLayout';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformSidebarLayout);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformSidebarLayoutModel', () => {
  it('returns the built-in default (mode user, no layout, revision 0) when the row is absent', async () => {
    const model = new PlatformSidebarLayoutModel(db);
    expect(await model.get()).toEqual({ layout: null, mode: 'user', revision: 0 });
  });

  it('inserts the singleton row on first update and advances revision 0 → 1', async () => {
    const model = new PlatformSidebarLayoutModel(db);
    const layout = {
      hiddenSidebarSections: ['image'],
      sidebarItems: ['agent', 'recents', 'pages', 'image'],
    };

    const next = await model.update('admin-user', { layout, mode: 'platform' }, 0);
    expect(next).toEqual({ layout, mode: 'platform', revision: 1 });

    const [row] = await db.select().from(platformSidebarLayout);
    expect(row?.id).toBe(PLATFORM_SIDEBAR_LAYOUT_ID);
    expect(row?.revision).toBe(1);
    expect(await model.get()).toEqual(next);
  });

  it('matching expectedRevision succeeds and increments revision', async () => {
    const model = new PlatformSidebarLayoutModel(db);
    await model.update(
      'a',
      {
        layout: { hiddenSidebarSections: [], sidebarItems: ['agent'] },
        mode: 'platform',
      },
      0,
    );

    const second = await model.update('b', { layout: null, mode: 'user' }, 1);
    expect(second).toEqual({ layout: null, mode: 'user', revision: 2 });

    const rows = await db.select().from(platformSidebarLayout);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedBy).toBe('b');
    expect(rows[0]?.revision).toBe(2);
  });

  it('rejects stale expectedRevision (two-writer CAS)', async () => {
    const model = new PlatformSidebarLayoutModel(db);
    await model.update('admin-a', { layout: null, mode: 'user' }, 0);
    // Writer A switches to platform.
    await model.update(
      'admin-a',
      {
        layout: { hiddenSidebarSections: [], sidebarItems: ['home'] },
        mode: 'platform',
      },
      1,
    );
    // Writer B still holds revision 1 and would switch back to user — must conflict.
    await expect(model.update('admin-b', { layout: null, mode: 'user' }, 1)).rejects.toBeInstanceOf(
      PlatformRevisionConflictError,
    );

    const current = await model.get();
    expect(current.mode).toBe('platform');
    expect(current.revision).toBe(2);
  });

  it('concurrent double-save with the same expectedRevision: exactly one wins', async () => {
    const model = new PlatformSidebarLayoutModel(db);
    await model.update('seed', { layout: null, mode: 'user' }, 0);

    const results = await Promise.allSettled([
      model.update(
        'admin-a',
        {
          layout: { hiddenSidebarSections: [], sidebarItems: ['a'] },
          mode: 'platform',
        },
        1,
      ),
      model.update(
        'admin-b',
        {
          layout: { hiddenSidebarSections: [], sidebarItems: ['b'] },
          mode: 'platform',
        },
        1,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      PlatformRevisionConflictError,
    );

    const current = await model.get();
    expect(current.revision).toBe(2);
    expect(current.mode).toBe('platform');
    // Exactly one of the two layouts is stored.
    expect(['a', 'b']).toContain(current.layout?.sidebarItems[0]);
  });

  it('rejects invalid mode at the model boundary (fail closed)', async () => {
    const model = new PlatformSidebarLayoutModel(db);
    await expect(
      model.update('admin', { layout: null, mode: 'bogus' as 'user' }, 0),
    ).rejects.toThrow(/Invalid sidebar layout mode/);
  });
});
