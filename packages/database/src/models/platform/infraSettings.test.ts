// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultMailConfig,
  createDefaultObjectStorageConfig,
} from '@/types/platform/infraSettings';

import { getTestDB } from '../../core/getTestDB';
import { platformInfraSettings } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformRevisionConflictError } from './errors';
import {
  INFRA_SETTINGS_MAIL_ID,
  INFRA_SETTINGS_OBJECT_STORAGE_ID,
  InfraSettingsModel,
} from './infraSettings';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformInfraSettings);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('InfraSettingsModel', () => {
  it('applies migration tables that match the drizzle schema', async () => {
    const rows = await db.select().from(platformInfraSettings);
    expect(rows).toEqual([]);
    expect(INFRA_SETTINGS_OBJECT_STORAGE_ID).toBe('object_storage');
    expect(INFRA_SETTINGS_MAIL_ID).toBe('mail');
  });

  it('returns null when the row is absent', async () => {
    const model = new InfraSettingsModel(db);
    expect(await model.get(INFRA_SETTINGS_OBJECT_STORAGE_ID)).toBeNull();
    expect(await model.get(INFRA_SETTINGS_MAIL_ID)).toBeNull();
  });

  it('ensureDefault inserts a disabled config once per card', async () => {
    const model = new InfraSettingsModel(db);
    const first = await model.ensureDefault(INFRA_SETTINGS_OBJECT_STORAGE_ID);
    expect(first.id).toBe(INFRA_SETTINGS_OBJECT_STORAGE_ID);
    expect(first.revision).toBe(0);
    expect(first.config).toMatchObject({ enabled: false });

    const second = await model.ensureDefault(INFRA_SETTINGS_OBJECT_STORAGE_ID);
    expect(second.revision).toBe(0);

    const mail = await model.ensureDefault(INFRA_SETTINGS_MAIL_ID);
    expect(mail.id).toBe(INFRA_SETTINGS_MAIL_ID);
    expect(mail.config).toMatchObject({ enabled: false, provider: 'smtp' });

    const rows = await db.select().from(platformInfraSettings);
    expect(rows).toHaveLength(2);
  });

  it('inserts on first update and advances revision via CAS', async () => {
    const model = new InfraSettingsModel(db);
    const config = createDefaultObjectStorageConfig();
    config.enabled = true;
    config.bucket = 'platform-files';
    config.accessKeyId = 'AKIAEXAMPLE';
    config.endpoint = 'https://s3.example.com';

    const next = await model.update({
      config,
      expectedRevision: 0,
      id: INFRA_SETTINGS_OBJECT_STORAGE_ID,
      updatedBy: 'admin-user',
    });
    expect(next.revision).toBe(1);
    expect(next.config).toMatchObject({ bucket: 'platform-files', enabled: true });
    expect(next.updatedBy).toBe('admin-user');

    const reread = await model.get(INFRA_SETTINGS_OBJECT_STORAGE_ID);
    expect(reread).toEqual(next);
  });

  // Concurrent CAS against a real Postgres `SELECT … FOR UPDATE` is not run
  // here: this package's default suite is PGlite, which is laxer than Postgres
  // on lock semantics. The sequential stale-revision case below still pins the
  // application's conflict error. A TEST_SERVER_DB concurrent-writer check
  // belongs with the other platform *.pg.test.ts files when we have infra.
  it('rejects stale expectedRevision (two-writer CAS)', async () => {
    const model = new InfraSettingsModel(db);
    const config = createDefaultMailConfig();
    await model.update({
      config,
      expectedRevision: 0,
      id: INFRA_SETTINGS_MAIL_ID,
      updatedBy: 'admin-a',
    });

    const next = createDefaultMailConfig();
    next.fromAddress = 'ops@example.com';
    await model.update({
      config: next,
      expectedRevision: 1,
      id: INFRA_SETTINGS_MAIL_ID,
      updatedBy: 'admin-a',
    });

    await expect(
      model.update({
        config: createDefaultMailConfig(),
        expectedRevision: 1,
        id: INFRA_SETTINGS_MAIL_ID,
        updatedBy: 'admin-b',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const current = await model.get(INFRA_SETTINGS_MAIL_ID);
    expect(current?.revision).toBe(2);
    expect(current?.config).toMatchObject({ fromAddress: 'ops@example.com' });
  });

  it('keeps object-storage and mail revisions independent', async () => {
    const model = new InfraSettingsModel(db);
    await model.update({
      config: createDefaultObjectStorageConfig(),
      expectedRevision: 0,
      id: INFRA_SETTINGS_OBJECT_STORAGE_ID,
      updatedBy: 'admin',
    });
    await model.update({
      config: createDefaultMailConfig(),
      expectedRevision: 0,
      id: INFRA_SETTINGS_MAIL_ID,
      updatedBy: 'admin',
    });

    const storage = await model.get(INFRA_SETTINGS_OBJECT_STORAGE_ID);
    const mail = await model.get(INFRA_SETTINGS_MAIL_ID);
    expect(storage?.revision).toBe(1);
    expect(mail?.revision).toBe(1);
  });
});
