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
    // The image ships more than pip packages; the list the card counts covers all of them.
    expect(result.preinstalled).toEqual(
      expect.arrayContaining([...SANDBOX_PREINSTALLED_PIP_PACKAGES]),
    );
    expect(result.preinstalled).toEqual(expect.arrayContaining(['curl', 'git', 'tsx']));
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

  it('reads "preinstalled" in the manager\'s own namespace, not against the pip list', async () => {
    // apt and npm rows used to be measured against the pip list alone, so everything the image
    // installs with apt-get or npm — curl, git, tsx — was reported as a "candidate" for an image
    // it is already in, while a pip name reused by another manager would have been a false yes.
    await db.insert(platformSandboxPackageInstalls).values([
      { installCount: 9, manager: 'apt', package: 'curl', userId: userA },
      { installCount: 8, manager: 'apt', package: 'vim', userId: userA },
      { installCount: 7, manager: 'npm', package: 'tsx', userId: userA },
      { installCount: 6, manager: 'npm', package: 'lodash', userId: userA },
      // Same spelling, different namespace: neither claim may leak into the other.
      { installCount: 5, manager: 'npm', package: 'requests', userId: userA },
      { installCount: 4, manager: 'pip', package: 'curl', userId: userA },
      { installCount: 3, manager: 'pip', package: 'requests', userId: userA },
    ]);

    const result = await getSandboxPackageStats(db, { days: 30, limit: 20 });
    const flag = (manager: string, name: string) =>
      result.items.find((item) => item.manager === manager && item.package === name)?.preinstalled;

    expect(flag('apt', 'curl')).toBe(true);
    expect(flag('apt', 'vim')).toBe(false);
    expect(flag('npm', 'tsx')).toBe(true);
    expect(flag('npm', 'lodash')).toBe(false);
    expect(flag('npm', 'requests')).toBe(false);
    expect(flag('pip', 'curl')).toBe(false);
    expect(flag('pip', 'requests')).toBe(true);
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
