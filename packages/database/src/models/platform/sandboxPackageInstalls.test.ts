// @vitest-environment node
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformSandboxPackageInstalls } from '../../schemas/platform';
import { users } from '../../schemas/user';
import type { LobeChatDatabase } from '../../type';
import {
  PER_USER_PACKAGE_INSTALL_CAP,
  PlatformSandboxPackageInstallsModel,
} from './sandboxPackageInstalls';

const db: LobeChatDatabase = await getTestDB();
const userId = 'pspi-model-user';
const otherUserId = 'pspi-model-other';

const cleanup = async () => {
  await db.delete(platformSandboxPackageInstalls);
  await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
};

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values([{ id: userId }, { id: otherUserId }]);
});

afterEach(cleanup);

describe('PlatformSandboxPackageInstallsModel', () => {
  it('inserts a row and increments install_count on conflict', async () => {
    const model = new PlatformSandboxPackageInstallsModel(db);
    expect(
      await model.upsert([
        { lastCommand: 'pip install requests', manager: 'pip', package: 'requests', userId },
      ]),
    ).toBe(1);

    const [first] = await db.select().from(platformSandboxPackageInstalls);
    expect(first).toMatchObject({
      installCount: 1,
      lastCommand: 'pip install requests',
      manager: 'pip',
      package: 'requests',
      userId,
    });

    expect(
      await model.upsert([
        { lastCommand: 'pip install requests==2', manager: 'pip', package: 'requests', userId },
      ]),
    ).toBe(1);

    const rows = await db.select().from(platformSandboxPackageInstalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      installCount: 2,
      lastCommand: 'pip install requests==2',
      package: 'requests',
    });
    expect(rows[0]!.lastAt.getTime()).toBeGreaterThanOrEqual(first!.lastAt.getTime());
  });

  it('upserts multiple unique packages in one statement and collapses duplicate keys', async () => {
    const model = new PlatformSandboxPackageInstallsModel(db);
    expect(
      await model.upsert([
        { lastCommand: 'pip install requests pandas', manager: 'pip', package: 'requests', userId },
        { lastCommand: 'pip install requests pandas', manager: 'pip', package: 'pandas', userId },
        { lastCommand: 'pip install requests', manager: 'pip', package: 'requests', userId },
      ]),
    ).toBe(2);

    const rows = await db.select().from(platformSandboxPackageInstalls);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.package).sort()).toEqual(['pandas', 'requests']);
    expect(rows.every((row) => row.installCount === 1)).toBe(true);
  });

  it('isolates rows per user', async () => {
    const model = new PlatformSandboxPackageInstallsModel(db);
    await model.upsert([
      { lastCommand: 'npm i lodash', manager: 'npm', package: 'lodash', userId },
      { lastCommand: 'npm i lodash', manager: 'npm', package: 'lodash', userId: otherUserId },
    ]);

    const rows = await db.select().from(platformSandboxPackageInstalls);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.userId))).toEqual(new Set([userId, otherUserId]));
  });

  it('truncates last_command to 300 characters', async () => {
    const model = new PlatformSandboxPackageInstallsModel(db);
    const lastCommand = `pip install ${'n'.repeat(400)}`;
    await model.upsert([{ lastCommand, manager: 'pip', package: 'numpy', userId }]);
    const [row] = await db.select().from(platformSandboxPackageInstalls);
    expect(row?.lastCommand).toHaveLength(300);
  });

  it('at the per-user cap only updates existing rows and never inserts', async () => {
    const model = new PlatformSandboxPackageInstallsModel(db);
    await db.insert(platformSandboxPackageInstalls).values(
      Array.from({ length: PER_USER_PACKAGE_INSTALL_CAP }, (_, i) => ({
        lastCommand: 'pip install seed',
        manager: 'pip' as const,
        package: `seed-${i}`,
        userId,
      })),
    );

    expect(
      await model.upsert([
        { lastCommand: 'pip install seed-0==2', manager: 'pip', package: 'seed-0', userId },
        { lastCommand: 'pip install newbie', manager: 'pip', package: 'newbie', userId },
      ]),
    ).toBe(1);

    const rows = await db.select().from(platformSandboxPackageInstalls);
    expect(rows).toHaveLength(PER_USER_PACKAGE_INSTALL_CAP);
    expect(rows.some((row) => row.package === 'newbie')).toBe(false);
    expect(rows.find((row) => row.package === 'seed-0')?.installCount).toBe(2);
  });
});
