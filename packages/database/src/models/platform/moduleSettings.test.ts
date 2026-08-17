// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformModuleSettings } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformRevisionConflictError } from './errors';
import { PLATFORM_MODULE_SETTINGS_ID, PlatformModuleSettingsModel } from './moduleSettings';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformModuleSettings);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformModuleSettingsModel', () => {
  it('returns null when the singleton row is absent (missing row ≠ all off)', async () => {
    const model = new PlatformModuleSettingsModel(db);
    expect(await model.get()).toBeNull();
  });

  it('inserts the singleton row on first CAS write and re-reads it', async () => {
    const model = new PlatformModuleSettingsModel(db);
    const next = await model.upsertWithCas({
      expectedRevision: 0,
      modules: { audit: false },
      setupCompletedAt: new Date('2026-08-17T00:00:00.000Z'),
      updatedBy: 'admin-user',
    });

    expect(next.id).toBe(PLATFORM_MODULE_SETTINGS_ID);
    expect(next.revision).toBe(1);
    expect(next.modules).toEqual({ audit: false });
    expect(next.setupCompletedAt?.toISOString()).toBe('2026-08-17T00:00:00.000Z');
    expect(next.updatedBy).toBe('admin-user');
    expect(await model.get()).toMatchObject({
      modules: { audit: false },
      revision: 1,
    });
  });

  it('replaces modules with CAS revision advance', async () => {
    const model = new PlatformModuleSettingsModel(db);
    await model.upsertWithCas({
      expectedRevision: 0,
      modules: { audit: false },
      updatedBy: 'admin-a',
    });

    const next = await model.upsertWithCas({
      expectedRevision: 1,
      modules: { audit: false, moderation: false },
      updatedBy: 'admin-b',
    });
    expect(next.revision).toBe(2);
    expect(next.modules).toEqual({ audit: false, moderation: false });
    expect(next.updatedBy).toBe('admin-b');
  });

  it('rejects stale expectedRevision (two-writer CAS)', async () => {
    const model = new PlatformModuleSettingsModel(db);
    await model.upsertWithCas({
      expectedRevision: 0,
      modules: { audit: true },
      updatedBy: 'admin-a',
    });
    await model.upsertWithCas({
      expectedRevision: 1,
      modules: { audit: false },
      updatedBy: 'admin-a',
    });

    await expect(
      model.upsertWithCas({
        expectedRevision: 1,
        modules: { branding: false },
        updatedBy: 'admin-b',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const current = await model.get();
    expect(current?.modules).toEqual({ audit: false });
    expect(current?.revision).toBe(2);
  });

  it('preserves setupCompletedAt when the caller omits it', async () => {
    const model = new PlatformModuleSettingsModel(db);
    const completedAt = new Date('2026-01-01T12:00:00.000Z');
    await model.upsertWithCas({
      expectedRevision: 0,
      modules: {},
      setupCompletedAt: completedAt,
      updatedBy: 'admin-user',
    });

    const next = await model.upsertWithCas({
      expectedRevision: 1,
      modules: { platformStats: false },
      updatedBy: 'admin-user',
    });
    expect(next.setupCompletedAt?.toISOString()).toBe(completedAt.toISOString());
  });
});
