// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformSandboxSettings } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformRevisionConflictError } from './errors';
import { PLATFORM_SANDBOX_SETTINGS_ID, PlatformSandboxSettingsModel } from './sandboxSettings';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformSandboxSettings);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformSandboxSettingsModel', () => {
  it('returns built-in defaults (env-owned) when the row is absent', async () => {
    const model = new PlatformSandboxSettingsModel(db);
    expect(await model.get()).toEqual({ enabled: false, revision: 0 });
  });

  it('inserts the singleton row on first update', async () => {
    const model = new PlatformSandboxSettingsModel(db);
    const next = await model.update('admin-user', {
      enabled: true,
      expectedRevision: 0,
      image: 'aihub-sandbox:dev',
      provider: 'local',
    });

    expect(next).toEqual({
      enabled: true,
      image: 'aihub-sandbox:dev',
      provider: 'local',
      revision: 1,
    });

    const [row] = await db.select().from(platformSandboxSettings);
    expect(row?.id).toBe(PLATFORM_SANDBOX_SETTINGS_ID);
    expect(await model.get()).toEqual(next);
  });

  it('replaces the stored config with CAS revision advance', async () => {
    const model = new PlatformSandboxSettingsModel(db);
    await model.update('admin-user', {
      enabled: true,
      expectedRevision: 0,
      provider: 'local',
    });

    const merged = await model.update('other-admin', {
      enabled: false,
      expectedRevision: 1,
    });
    expect(merged).toEqual({ enabled: false, revision: 2 });

    const rows = await db.select().from(platformSandboxSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedBy).toBe('other-admin');
  });

  it('rejects stale expectedRevision (two-writer CAS)', async () => {
    const model = new PlatformSandboxSettingsModel(db);
    await model.update('admin-a', { enabled: true, expectedRevision: 0, provider: 'market' });

    await expect(
      model.update('admin-b', { enabled: true, expectedRevision: 0, provider: 'local' }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    expect(await model.get()).toMatchObject({ provider: 'market', revision: 1 });
  });
});
