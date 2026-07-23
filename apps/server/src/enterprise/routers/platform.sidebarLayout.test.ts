// @vitest-environment node
/**
 * platform.getSidebarLayout defaults when ENABLE_PLATFORM_ADMIN is off,
 * even if a stale platform-mode row remains in the DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformSidebarLayout, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import { DEFAULT_SIDEBAR_LAYOUT_POLICY } from '@/types/platform/sidebarLayout';

import { platformRouter } from './platform';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(platformRouter);
const userId = 'sidebar-layout-user';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await db.delete(platformSidebarLayout);
  await db.delete(users);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
  await db.insert(users).values({ id: userId });
  await db.insert(platformSidebarLayout).values({
    id: 'global',
    layout: {
      hiddenSidebarSections: ['custom'],
      sidebarItems: ['platform-only-order'],
    },
    mode: 'platform',
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('platform.getSidebarLayout defaults when disabled', () => {
  it('returns DEFAULT_SIDEBAR_LAYOUT_POLICY when ENABLE_PLATFORM_ADMIN is off', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '1'); // unrelated enterprise flag still on
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);

    await expect(caller.getSidebarLayout()).resolves.toEqual(DEFAULT_SIDEBAR_LAYOUT_POLICY);
  });

  it('applies persisted platform mode when ENABLE_PLATFORM_ADMIN is on', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);

    await expect(caller.getSidebarLayout()).resolves.toEqual({
      layout: {
        hiddenSidebarSections: ['custom'],
        sidebarItems: ['platform-only-order'],
      },
      managed: true,
    });
  });
});
