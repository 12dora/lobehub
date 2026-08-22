// @vitest-environment node
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformSandboxPackageInstalls } from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';
import { SANDBOX_PREINSTALLED_PIP_PACKAGES } from '@/server/services/sandbox/preinstalled';

import { getSandboxPackageStats } from './packageStats';

const db: LobeChatDatabase = await getTestDB();
const userA = 'pspi-stats-a';
const userB = 'pspi-stats-b';

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

beforeEach(async () => {
  await db.delete(platformSandboxPackageInstalls);
  await db.delete(users).where(inArray(users.id, [userA, userB]));
  await db.insert(users).values([{ id: userA }, { id: userB }]);
});

afterEach(async () => {
  await db.delete(platformSandboxPackageInstalls);
  await db.delete(users).where(inArray(users.id, [userA, userB]));
});

describe('getSandboxPackageStats', () => {
  it('orders by installs then users, windows by last_at, and flags preinstalled pip packages', async () => {
    await db.insert(platformSandboxPackageInstalls).values([
      {
        installCount: 5,
        lastAt: new Date(),
        manager: 'pip',
        package: 'requests',
        userId: userA,
      },
      {
        installCount: 5,
        lastAt: new Date(),
        manager: 'pip',
        package: 'requests',
        userId: userB,
      },
      {
        installCount: 8,
        lastAt: new Date(),
        manager: 'npm',
        package: 'lodash',
        userId: userA,
      },
      {
        installCount: 3,
        lastAt: new Date(),
        manager: 'pip',
        package: 'obscure-lib',
        userId: userA,
      },
      {
        installCount: 99,
        lastAt: daysAgo(40),
        manager: 'apt',
        package: 'vim',
        userId: userA,
      },
    ]);

    const result = await getSandboxPackageStats(db, { days: 30, limit: 20 });
    expect(result.windowDays).toBe(30);
    expect(result.totalPackages).toBe(3);
    expect(result.preinstalled).toEqual([...SANDBOX_PREINSTALLED_PIP_PACKAGES]);
    expect(result.items.map((item) => item.package)).toEqual(['requests', 'lodash', 'obscure-lib']);
    expect(result.items[0]).toMatchObject({
      installs: 10,
      manager: 'pip',
      package: 'requests',
      preinstalled: true,
      users: 2,
    });
    expect(result.items[1]).toMatchObject({
      installs: 8,
      manager: 'npm',
      package: 'lodash',
      preinstalled: false,
      users: 1,
    });
    expect(result.items[2]).toMatchObject({
      installs: 3,
      package: 'obscure-lib',
      preinstalled: false,
    });
    expect(result.items.every((item) => item.lastInstalledAt instanceof Date)).toBe(true);
    expect(result.generatedAt).toBeInstanceOf(Date);
  });

  it('applies the item limit without shrinking totalPackages', async () => {
    await db.insert(platformSandboxPackageInstalls).values([
      { installCount: 3, manager: 'pip', package: 'alpha', userId: userA },
      { installCount: 2, manager: 'pip', package: 'beta', userId: userA },
      { installCount: 1, manager: 'pip', package: 'gamma', userId: userA },
    ]);

    const result = await getSandboxPackageStats(db, { days: 30, limit: 2 });
    expect(result.totalPackages).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.package)).toEqual(['alpha', 'beta']);
  });
});
