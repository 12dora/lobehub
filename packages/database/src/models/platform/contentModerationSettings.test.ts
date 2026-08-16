// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import { getTestDB } from '../../core/getTestDB';
import { platformContentModerationSettings } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  PLATFORM_CONTENT_MODERATION_SETTINGS_ID,
  PlatformContentModerationSettingsModel,
} from './contentModerationSettings';
import { PlatformRevisionConflictError } from './errors';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformContentModerationSettings);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformContentModerationSettingsModel', () => {
  it('returns null when the singleton row is absent', async () => {
    const model = new PlatformContentModerationSettingsModel(db);
    expect(await model.get()).toBeNull();
  });

  it('ensureDefault inserts the built-in off-mode config once', async () => {
    const model = new PlatformContentModerationSettingsModel(db);
    const first = await model.ensureDefault();
    expect(first.id).toBe(PLATFORM_CONTENT_MODERATION_SETTINGS_ID);
    expect(first.config.mode).toBe('off');
    expect(first.revision).toBe(0);

    const second = await model.ensureDefault();
    expect(second.revision).toBe(0);
    const rows = await db.select().from(platformContentModerationSettings);
    expect(rows).toHaveLength(1);
  });

  it('inserts on first update and advances revision via CAS', async () => {
    const model = new PlatformContentModerationSettingsModel(db);
    const config = createDefaultContentModerationConfig();
    config.mode = 'observe';

    const next = await model.update({
      config,
      expectedRevision: 0,
      updatedBy: 'admin-user',
    });
    expect(next.revision).toBe(1);
    expect(next.config.mode).toBe('observe');
    expect(next.updatedBy).toBe('admin-user');

    const reread = await model.get();
    expect(reread).toEqual(next);
  });

  it('rejects stale expectedRevision (two-writer CAS)', async () => {
    const model = new PlatformContentModerationSettingsModel(db);
    const config = createDefaultContentModerationConfig();
    await model.update({ config, expectedRevision: 0, updatedBy: 'admin-a' });

    const next = createDefaultContentModerationConfig();
    next.mode = 'enforce';
    await model.update({ config: next, expectedRevision: 1, updatedBy: 'admin-a' });

    await expect(
      model.update({
        config: createDefaultContentModerationConfig(),
        expectedRevision: 1,
        updatedBy: 'admin-b',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const current = await model.get();
    expect(current?.revision).toBe(2);
    expect(current?.config.mode).toBe('enforce');
  });
});
