// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformDocumentRenderSettings } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  PLATFORM_DOCUMENT_RENDER_SETTINGS_ID,
  PlatformDocumentRenderSettingsModel,
} from './documentRenderSettings';
import { PlatformRevisionConflictError } from './errors';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformDocumentRenderSettings);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformDocumentRenderSettingsModel', () => {
  it('returns built-in defaults (env-owned) when the row is absent', async () => {
    const model = new PlatformDocumentRenderSettingsModel(db);
    expect(await model.get()).toEqual({ enabled: false, revision: 0 });
  });

  it('inserts the singleton row on first update', async () => {
    const model = new PlatformDocumentRenderSettingsModel(db);
    const next = await model.update('admin-user', {
      enabled: true,
      endpoint: 'http://document-render:3000',
      expectedRevision: 0,
      trigger: 'onUpload',
    });

    expect(next).toEqual({
      enabled: true,
      endpoint: 'http://document-render:3000',
      revision: 1,
      trigger: 'onUpload',
    });

    const [row] = await db.select().from(platformDocumentRenderSettings);
    expect(row?.id).toBe(PLATFORM_DOCUMENT_RENDER_SETTINGS_ID);
    expect(await model.get()).toEqual(next);
  });

  it('replaces the stored config with CAS revision advance', async () => {
    const model = new PlatformDocumentRenderSettingsModel(db);
    await model.update('admin-user', {
      enabled: true,
      endpoint: 'http://document-render:3000',
      expectedRevision: 0,
    });

    const merged = await model.update('other-admin', {
      enabled: false,
      expectedRevision: 1,
    });
    expect(merged).toEqual({ enabled: false, revision: 2 });

    const rows = await db.select().from(platformDocumentRenderSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedBy).toBe('other-admin');
  });

  it('rejects stale expectedRevision (two-writer CAS)', async () => {
    const model = new PlatformDocumentRenderSettingsModel(db);
    await model.update('admin-a', {
      enabled: true,
      expectedRevision: 0,
      trigger: 'onDemand',
    });

    await expect(
      model.update('admin-b', { enabled: true, expectedRevision: 0, trigger: 'onUpload' }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    expect(await model.get()).toMatchObject({ revision: 1, trigger: 'onDemand' });
  });
});
