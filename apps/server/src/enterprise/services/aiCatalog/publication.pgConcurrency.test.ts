// @vitest-environment node
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { serverDBEnv } from '@/config/db';
import { getTestDB } from '@/database/core/getTestDB';
import * as schema from '@/database/schemas';
import {
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
  platformSettingsBundle,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { PlatformDependencyTargetNotPublishedError } from '../platformDependencyLock';
import { AdminSettingsService } from '../settings/adminSettingsService';
import { AiCatalogAdminService } from './adminService';

const runPostgresConcurrency = process.env.TEST_SERVER_DB === '1';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe.skipIf(!runPostgresConcurrency)('AI catalog dependency advisory lock (PostgreSQL)', () => {
  it('prevents settings T2 from referencing a model after publish T1 checked its removal', async () => {
    await getTestDB(); // Ensure the shared test database is migrated before opening two pools.
    const connectionString = serverDBEnv.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const firstPool = new Pool({ connectionString, max: 1 });
    const secondPool = new Pool({ connectionString, max: 1 });
    const firstDb = drizzle(firstPool, { schema }) as unknown as LobeChatDatabase;
    const secondDb = drizzle(secondPool, { schema }) as unknown as LobeChatDatabase;
    const cleanup = async () => {
      await firstDb.delete(platformAuditLogs);
      await firstDb.delete(platformResourceRevisions);
      await firstDb.delete(platformSettingPolicies);
      await firstDb.delete(platformSettingsBundle);
      await firstDb.delete(platformAiProviderSecrets);
      await firstDb.delete(platformAiModels);
      await firstDb.delete(platformAiProviders);
    };
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: new Uint8Array(32).fill(47), keyId: 'pg-lock-test' }),
      providerId: 'test',
    };
    const checked = deferred();
    const releasePublish = deferred();

    try {
      await cleanup();
      const seedService = new AiCatalogAdminService(
        firstDb,
        new PlatformSecretService({ keyProvider }),
        {
          connectionProbe: async () => {},
          invalidation: new InMemoryPlatformConfigInvalidationPublisher(),
        },
      );
      const provider = await seedService.createProviderDraft('admin', {
        checkModel: 'chat',
        displayName: 'Lock target',
        enabled: true,
        providerKey: 'lock-target',
        reason: 'create',
        secret: { operation: 'replace', value: 'lock-secret' },
        source: 'custom',
      });
      let detail = await seedService.getDetail(provider.id);
      await seedService.createModel('admin', {
        enabled: true,
        expectedDraftToken: detail.draftToken,
        modelKey: 'chat',
        providerId: provider.id,
        reason: 'model',
        type: 'chat',
      });
      detail = await seedService.getDetail(provider.id);
      const retiredModel = await seedService.createModel('admin', {
        enabled: true,
        expectedDraftToken: detail.draftToken,
        modelKey: 'retired-chat',
        providerId: provider.id,
        reason: 'retired model',
        type: 'chat',
      });
      await seedService.testProvider('admin', { id: provider.id, reason: 'test' });
      detail = await seedService.getDetail(provider.id);
      await seedService.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'publish',
      });
      detail = await seedService.getDetail(provider.id);
      await seedService.deleteModel('admin', {
        expectedDraftToken: detail.draftToken,
        id: retiredModel.id,
        providerId: provider.id,
        reason: 'remove retired model in next revision',
      });
      await seedService.testProvider('admin', { id: provider.id, reason: 'retest after removal' });
      detail = await seedService.getDetail(provider.id);

      const settings = new AdminSettingsService(secondDb, {
        invalidation: new InMemoryPlatformConfigInvalidationPublisher(),
      });
      await settings.saveDraft({
        actorUserId: 'admin',
        draft: {
          'systemAgent.topic.model': {
            mode: 'default',
            schemaVersion: 1,
            value: 'retired-chat',
            visibility: 'visible',
          },
          'systemAgent.topic.provider': {
            mode: 'default',
            schemaVersion: 1,
            value: 'lock-target',
            visibility: 'visible',
          },
        },
        expectedDraftToken: (await settings.getDraft()).draftToken,
        reason: 'prepare concurrent reference',
      });

      detail = await seedService.getDetail(provider.id);
      const publishService = new AiCatalogAdminService(
        firstDb,
        new PlatformSecretService({ keyProvider }),
        {
          connectionProbe: async () => {},
          invalidation: new InMemoryPlatformConfigInvalidationPublisher(),
          lifecycle: {
            afterModelDependencyCheck: async () => {
              checked.resolve();
              await releasePublish.promise;
            },
          },
        },
      );
      const publish = publishService.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 1,
        id: provider.id,
        reason: 'publish model removal',
      });
      await checked.promise;

      let settingsSettled = false;
      const settingsPublish = settings
        .publish({
          actorUserId: 'admin',
          expectedDraftToken: (await settings.getDraft()).draftToken,
          expectedRevision: 0,
          reason: 'publish concurrent reference',
        })
        .finally(() => {
          settingsSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settingsSettled).toBe(false);

      releasePublish.resolve();
      await expect(publish).resolves.toMatchObject({ revision: 2 });
      await expect(settingsPublish).rejects.toBeInstanceOf(
        PlatformDependencyTargetNotPublishedError,
      );
      expect(await firstDb.select().from(platformSettingPolicies)).toEqual([]);
    } finally {
      releasePublish.resolve();
      await cleanup();
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  }, 15_000);

  it('serializes hard-delete against concurrent publish via CAS + lock order', async () => {
    await getTestDB();
    const connectionString = serverDBEnv.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const firstPool = new Pool({ connectionString, max: 1 });
    const secondPool = new Pool({ connectionString, max: 1 });
    const firstDb = drizzle(firstPool, { schema }) as unknown as LobeChatDatabase;
    const secondDb = drizzle(secondPool, { schema }) as unknown as LobeChatDatabase;
    const cleanup = async () => {
      await firstDb.delete(platformAuditLogs);
      await firstDb.delete(platformResourceRevisions);
      await firstDb.delete(platformSettingPolicies);
      await firstDb.delete(platformSettingsBundle);
      await firstDb.delete(platformAiProviderSecrets);
      await firstDb.delete(platformAiModels);
      await firstDb.delete(platformAiProviders);
    };
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: new Uint8Array(32).fill(49), keyId: 'pg-delete-race' }),
      providerId: 'test',
    };
    const heldLock = deferred();
    const releasePublishHold = deferred();

    try {
      await cleanup();
      const seedService = new AiCatalogAdminService(
        firstDb,
        new PlatformSecretService({ keyProvider }),
        {
          connectionProbe: async () => {},
          invalidation: new InMemoryPlatformConfigInvalidationPublisher(),
        },
      );
      const provider = await seedService.createProviderDraft('admin', {
        checkModel: 'chat',
        displayName: 'Delete race',
        enabled: true,
        providerKey: 'delete-race',
        reason: 'create',
        secret: { operation: 'replace', value: 'delete-race-secret' },
        source: 'custom',
      });
      let detail = await seedService.getDetail(provider.id);
      await seedService.createModel('admin', {
        enabled: true,
        expectedDraftToken: detail.draftToken,
        modelKey: 'chat',
        providerId: provider.id,
        reason: 'model',
        type: 'chat',
      });
      await seedService.testProvider('admin', { id: provider.id, reason: 'test' });
      detail = await seedService.getDetail(provider.id);
      await seedService.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'publish',
      });
      detail = await seedService.getDetail(provider.id);
      await seedService.updateProviderDraft('admin', {
        displayName: 'Delete race renamed',
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: provider.id,
        reason: 'rename for concurrent publish',
      });
      detail = await seedService.getDetail(provider.id);

      const cas = {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: provider.id,
      };

      // Publish holds provider + dependency locks mid-flight (same order as hard-delete).
      const publishService = new AiCatalogAdminService(
        firstDb,
        new PlatformSecretService({ keyProvider }),
        {
          connectionProbe: async () => {},
          invalidation: new InMemoryPlatformConfigInvalidationPublisher(),
          lifecycle: {
            afterPublishLock: async () => {
              heldLock.resolve();
              await releasePublishHold.promise;
            },
          },
        },
      );
      const deleteService = new AiCatalogAdminService(
        secondDb,
        new PlatformSecretService({ keyProvider }),
        {
          connectionProbe: async () => {},
          invalidation: new InMemoryPlatformConfigInvalidationPublisher(),
        },
      );

      const publishing = publishService.publishProvider('admin', {
        ...cas,
        reason: 'publish under race',
      });
      await heldLock.promise;

      let deleteSettled = false;
      const deleting = deleteService
        .deleteProvider('admin', { ...cas, reason: 'hard delete under race' })
        .finally(() => {
          deleteSettled = true;
        });
      // Delete must block on the shared lock order while publish holds locks.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deleteSettled).toBe(false);

      releasePublishHold.resolve();
      await expect(publishing).resolves.toMatchObject({ revision: expect.any(Number) });
      // Stale delete CAS (pre-publish draft token/revision) must fail closed.
      await expect(deleting).rejects.toBeTruthy();
      expect(await firstDb.select().from(platformAiProviders)).toHaveLength(1);
    } finally {
      releasePublishHold.resolve();
      await cleanup();
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  }, 15_000);
});
