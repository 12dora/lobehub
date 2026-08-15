// @vitest-environment node
import { and, eq, sql } from 'drizzle-orm';
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
  platformResourceRevisions,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import {
  clearManagedResourceReadinessForTest,
  resolveManagedResourceReadiness,
} from '../managedResourceReadiness';
import { AiCatalogAdminService } from './adminService';
import { AiCatalogExecutionResolver, clearAiCatalogRuntimeCache } from './runtimeAdapter';
import {
  createSingleFlightReadinessProbe,
  ensureAiCatalogReadinessRegistered,
  resetAiCatalogReadinessRegistrationForTest,
  resolveAiCatalogRuntimeReadiness,
} from './runtimeReadiness';

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

const FIXTURE_ACTOR_IDS = ['admin'] as const;
/** Hand-inserted revision fixture not backed by a platform_ai_providers row. */
const FIXTURE_PROVIDER_RESOURCE_IDS = ['embedding-provider'] as const;

const cleanup = async () => {
  clearAiCatalogRuntimeCache();
  await deletePlatformAuditLogsForTest(db, { actorUserIds: FIXTURE_ACTOR_IDS });
  const ownedProviders = await db.select({ id: platformAiProviders.id }).from(platformAiProviders);
  await deletePlatformResourceRevisionsForTest(db, {
    resourceIds: [...FIXTURE_PROVIDER_RESOURCE_IDS, ...ownedProviders.map((row) => row.id)],
    resourceType: 'provider',
  });
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
    // Intentionally corrupt an older immutable revision to prove readiness uses head only.
    // Production rejects UPDATE; tests disable user triggers for this fixture injection.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
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
    });
    clearAiCatalogRuntimeCache();

    await expect(
      resolveAiCatalogRuntimeReadiness({ db, flags: managedFlags, secretService }),
    ).resolves.toBe(true);
  });
});

describe('AI catalog readiness registration', () => {
  afterEach(() => {
    resetAiCatalogReadinessRegistrationForTest();
    clearManagedResourceReadinessForTest();
  });

  it('runs the secret-decrypting AI probe once per readiness pass, not once per resource', async () => {
    // `aiProviders` and `aiModels` share one probe; the resolver invokes every registered
    // entry concurrently, so an unshared probe would load the catalog and decrypt every
    // provider secret twice on every capability refresh.
    resetAiCatalogReadinessRegistrationForTest();
    clearManagedResourceReadinessForTest();
    const probe = vi.fn().mockResolvedValue(true);
    ensureAiCatalogReadinessRegistered(probe);

    const readiness = await resolveManagedResourceReadiness();

    expect(readiness.aiProviders).toBe(true);
    expect(readiness.aiModels).toBe(true);
    expect(probe).toHaveBeenCalledOnce();

    // A later pass re-reads: the single-flight is not a cache.
    expect(await resolveManagedResourceReadiness()).toMatchObject({
      aiModels: true,
      aiProviders: true,
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('single-flight keeps neither results nor rejections beyond the pass', async () => {
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValue(true);
    const singleFlight = createSingleFlightReadinessProbe(probe);

    // Concurrent callers within a pass share the failure …
    const [first, second] = await Promise.allSettled([singleFlight(), singleFlight()]);
    expect(first).toMatchObject({
      reason: expect.objectContaining({ message: 'catalog unavailable' }),
    });
    expect(second).toMatchObject({
      reason: expect.objectContaining({ message: 'catalog unavailable' }),
    });
    expect(probe).toHaveBeenCalledOnce();

    // … and the next pass retries instead of replaying the cached rejection.
    expect(await singleFlight()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('a failed readiness pass still reports both AI resources as not ready', async () => {
    resetAiCatalogReadinessRegistrationForTest();
    clearManagedResourceReadinessForTest();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const probe = vi.fn().mockRejectedValue(new Error('catalog unavailable'));
    ensureAiCatalogReadinessRegistered(probe);

    const readiness = await resolveManagedResourceReadiness();

    expect(readiness).toMatchObject({ aiModels: false, aiProviders: false });
    expect(probe).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
