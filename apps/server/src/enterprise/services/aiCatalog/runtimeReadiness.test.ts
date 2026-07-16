// @vitest-environment node
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ENTERPRISE_FEATURE_FLAGS,
  type EnterpriseFeatureFlags,
} from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformResourceRevisions,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogAdminService } from './adminService';
import { AiCatalogExecutionResolver, clearAiCatalogRuntimeCache } from './runtimeAdapter';
import { resolveAiCatalogRuntimeReadiness } from './runtimeReadiness';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(53), keyId: 'readiness-test' }),
  providerId: 'test',
};
const secretService = new PlatformSecretService({ keyProvider });
const managedFlags: EnterpriseFeatureFlags = {
  ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
  ENABLE_PLATFORM_MANAGED_AI: true,
};

const cleanup = async () => {
  clearAiCatalogRuntimeCache();
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformAiProviderSecrets);
  await db.delete(platformAiModels);
  await db.delete(platformAiProviders);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

const publishReadyProvider = async (params: { providerKey: string; secret?: string }) => {
  const service = new AiCatalogAdminService(db, secretService, {
    connectionProbe: async () => {},
  });
  const provider = await service.createProviderDraft('admin', {
    checkModel: 'chat',
    displayName: params.providerKey,
    enabled: true,
    providerKey: params.providerKey,
    reason: 'create',
    secret: params.secret ? { operation: 'replace', value: params.secret } : undefined,
    source: 'custom',
  });
  let detail = await service.getDetail(provider.id);
  await service.createModel('admin', {
    enabled: true,
    expectedDraftToken: detail.draftToken,
    modelKey: 'chat',
    providerId: provider.id,
    reason: 'model',
    type: 'chat',
  });
  await service.testProvider('admin', { id: provider.id, reason: 'test' });
  detail = await service.getDetail(provider.id);
  await service.publishProvider('admin', {
    expectedDraftToken: detail.draftToken,
    expectedRevision: 0,
    id: provider.id,
    reason: 'publish',
  });
  return { provider, service };
};

describe('AI catalog runtime readiness', () => {
  it('is exactly false while the managed runtime flag is disabled without reading DB', async () => {
    const failOnRead = new Proxy(
      {},
      {
        get: () => {
          throw new Error('readiness must not read DB while disabled');
        },
      },
    ) as LobeChatDatabase;
    await expect(
      resolveAiCatalogRuntimeReadiness({
        db: failOnRead,
        flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS },
        secretService: null,
      }),
    ).resolves.toBe(false);
  });

  it('rejects an unsupported-only published catalog before credential resolution', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unused-env-key');
    await db.insert(platformResourceRevisions).values({
      checksum: 'embedding-only-readiness',
      payload: {
        models: [{ enabled: true, modelKey: 'embedding', type: 'embedding' }],
        provider: {
          displayName: 'Embedding only',
          enabled: true,
          providerKey: 'embedding-only',
          source: 'custom',
        },
      },
      resourceId: 'embedding-provider',
      resourceType: 'provider',
      revision: 1,
      status: 'published',
    });
    const resolver = vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    );

    await expect(
      resolveAiCatalogRuntimeReadiness({ db, flags: managedFlags, secretService }),
    ).resolves.toBe(false);
    expect(resolver).not.toHaveBeenCalled();
    resolver.mockRestore();
  });

  it('accepts an environment-only executable chat catalog', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'environment-readiness-key');
    await publishReadyProvider({ providerKey: 'environment-ready' });
    await expect(
      resolveAiCatalogRuntimeReadiness({ db, flags: managedFlags, secretService }),
    ).resolves.toBe(true);
  });

  it('accepts a normal secret-backed executable chat catalog', async () => {
    await publishReadyProvider({ providerKey: 'normal-ready', secret: 'normal-readiness-key' });
    await expect(
      resolveAiCatalogRuntimeReadiness({ db, flags: managedFlags, secretService }),
    ).resolves.toBe(true);
  });

  it('uses only the latest provider head when an older historical revision is polluted', async () => {
    const { provider, service } = await publishReadyProvider({
      providerKey: 'history-ready',
      secret: 'history-readiness-key',
    });
    let detail = await service.getDetail(provider.id);
    await service.updateProviderDraft('admin', {
      description: 'safe v2',
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'update v2',
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test v2' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'publish v2',
    });
    await db
      .update(platformResourceRevisions)
      .set({
        payload: {
          models: [{ enabled: true, modelKey: 'poisoned', type: 'chat' }],
          provider: { enabled: true, providerKey: 'poisoned-history', settings: {} },
        },
      })
      .where(
        and(
          eq(platformResourceRevisions.resourceId, provider.id),
          eq(platformResourceRevisions.revision, 1),
        ),
      );
    clearAiCatalogRuntimeCache();

    await expect(
      resolveAiCatalogRuntimeReadiness({ db, flags: managedFlags, secretService }),
    ).resolves.toBe(true);
  });
});
