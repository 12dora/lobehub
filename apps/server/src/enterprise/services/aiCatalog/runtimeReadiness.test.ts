// @vitest-environment node
import debug from 'debug';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DISABLED_ENTERPRISE_FEATURE_FLAGS,
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
import * as moduleSettings from '../moduleSettings';
import { AiCatalogAdminService } from './adminService';
import { AiCatalogExecutionResolver, clearAiCatalogRuntimeCache } from './runtimeAdapter';
import {
  ensureAiCatalogReadinessRegistered,
  resetAiCatalogReadinessRegistrationForTest,
  resolveAiCatalogRuntimeReadiness,
} from './runtimeReadiness';

const AI_READINESS_DEBUG_NS = 'lobe-server:ai-catalog-readiness';

// Enable the namespace before the SUT's `debug(...)` instance is created.
vi.hoisted(() => {
  const ns = 'lobe-server:ai-catalog-readiness';
  process.env.DEBUG = process.env.DEBUG ? `${process.env.DEBUG},${ns}` : ns;
});

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(53), keyId: 'readiness-test' }),
  providerId: 'test',
};
const secretService = new PlatformSecretService({ keyProvider });
const managedFlags: EnterpriseFeatureFlags = {
  ...DISABLED_ENTERPRISE_FEATURE_FLAGS,
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

const applyImmediateProvider = async (params: {
  models?: Array<{ enabled?: boolean; modelKey: string; type: 'chat' | 'embedding' }>;
  providerKey: string;
  secret?: string;
}) => {
  const service = new AiCatalogAdminService(db, secretService, {
    connectionProbe: async () => {},
  });
  const created = await service.applyProviderImmediate('admin', {
    displayName: params.providerKey,
    enabled: true,
    mode: 'create',
    providerKey: params.providerKey,
    reason: 'create',
    secret: params.secret ? { operation: 'replace', value: params.secret } : undefined,
    settings: { sdkType: 'openai' },
    source: 'custom',
  });
  let detail = await service.getDetail(created.draft.id);
  for (const model of params.models ?? []) {
    await service.applyModelImmediate('admin', {
      enabled: model.enabled ?? true,
      expectedDraftToken: detail.draftToken,
      modelKey: model.modelKey,
      operation: 'create',
      providerId: created.draft.id,
      reason: 'model',
      type: model.type,
    });
    detail = await service.getDetail(created.draft.id);
  }
  return { providerId: created.draft.id, providerKey: params.providerKey, service };
};

const expectReadiness = async (expected: { aiModels: boolean; aiProviders: boolean }) => {
  clearAiCatalogRuntimeCache();
  await expect(
    resolveAiCatalogRuntimeReadiness({ db, flags: managedFlags, secretService }),
  ).resolves.toEqual(expected);
};

const stringifyLogArg = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (value instanceof Error) return `${value.name}\n${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const withLogSpies = async (run: (logged: () => string) => Promise<void>) => {
  const previousNamespaces = debug.disable();
  debug.enable(AI_READINESS_DEBUG_NS);
  const writes = vi.fn();
  const sink = (...args: unknown[]) => {
    writes(...args);
  };
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    writes(chunk);
    return true;
  }) as typeof process.stderr.write);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(sink);
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(sink);
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(sink);
  const consoleInfo = vi.spyOn(console, 'info').mockImplementation(sink);
  const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(sink);
  try {
    await run(() =>
      writes.mock.calls.map((args) => args.map(stringifyLogArg).join(' ')).join('\n'),
    );
  } finally {
    stderrWrite.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
    consoleInfo.mockRestore();
    consoleDebug.mockRestore();
    debug.disable();
    if (previousNamespaces) debug.enable(previousNamespaces);
  }
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
        flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS },
        secretService: null,
      }),
    ).resolves.toEqual({ aiModels: false, aiProviders: false });
  });

  it('reports both resources unready when nothing is published, without credential resolution', async () => {
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
    ).resolves.toEqual({ aiModels: false, aiProviders: false });
    expect(resolver).not.toHaveBeenCalled();
    resolver.mockRestore();
  });

  it('accepts an environment-only executable chat catalog', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'environment-readiness-key');
    await publishReadyProvider({ providerKey: 'environment-ready' });
    await expectReadiness({ aiModels: true, aiProviders: true });
  });

  it('accepts a normal secret-backed executable chat catalog', async () => {
    await publishReadyProvider({ providerKey: 'normal-ready', secret: 'normal-readiness-key' });
    await expectReadiness({ aiModels: true, aiProviders: true });
  });

  it('treats applyImmediate secret-backed providers as ready without requiring a chat model', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    await applyImmediateProvider({
      providerKey: 'apply-secret-no-model',
      secret: 'apply-readiness-key',
    });
    await expectReadiness({ aiModels: false, aiProviders: true });
  });

  it('marks both resources ready after applyImmediate adds an enabled chat model', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    const { providerId, service } = await applyImmediateProvider({
      providerKey: 'apply-secret-with-chat',
      secret: 'apply-chat-readiness-key',
    });
    await expectReadiness({ aiModels: false, aiProviders: true });

    const detail = await service.getDetail(providerId);
    await service.applyModelImmediate('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      operation: 'create',
      providerId,
      reason: 'model',
      type: 'chat',
    });
    await expectReadiness({ aiModels: true, aiProviders: true });
  });

  it('skips a broken vault and stays ready when another published provider resolves', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    await applyImmediateProvider({
      models: [{ modelKey: 'chat', type: 'chat' }],
      providerKey: 'good-vault',
      secret: 'good-readiness-key',
    });
    await applyImmediateProvider({
      providerKey: 'broken-vault',
      secret: 'broken-readiness-key',
    });
    const original = AiCatalogExecutionResolver.prototype.resolveProviderExecutionConfig;
    const resolver = vi
      .spyOn(AiCatalogExecutionResolver.prototype, 'resolveProviderExecutionConfig')
      .mockImplementation(async function (this: AiCatalogExecutionResolver, providerKey, options) {
        if (providerKey === 'broken-vault') throw new Error('vault decrypt failed');
        return original.call(this, providerKey, options);
      });

    await expectReadiness({ aiModels: true, aiProviders: true });
    expect(resolver).toHaveBeenCalled();
    resolver.mockRestore();
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

    await expectReadiness({ aiModels: true, aiProviders: true });
  });

  it('swallows catalog-load failures as unready without logging the error message', async () => {
    const marker = 'READINESS_SECRET_MARKER_ai-catalog-snapshot';
    const failOnRead = new Proxy(
      {},
      {
        get: () => {
          throw new Error(marker);
        },
      },
    ) as LobeChatDatabase;

    await withLogSpies(async (logged) => {
      await expect(
        resolveAiCatalogRuntimeReadiness({
          db: failOnRead,
          flags: managedFlags,
          secretService,
        }),
      ).resolves.toEqual({ aiModels: false, aiProviders: false });
      expect(logged()).not.toContain(marker);
    });
  });

  it('treats a rejected module-gate as unready without logging the error message', async () => {
    const marker = 'READINESS_SECRET_MARKER_ai-module-reject';
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '1');
    const gate = vi.spyOn(moduleSettings, 'isModuleEnabled').mockRejectedValue(new Error(marker));
    await withLogSpies(async (logged) => {
      await expect(resolveAiCatalogRuntimeReadiness({ db, secretService })).resolves.toEqual({
        aiModels: false,
        aiProviders: false,
      });
      expect(logged()).not.toContain(marker);
    });
    gate.mockRestore();
  });

  it('treats a synchronous module-gate throw as unready without logging the error message', async () => {
    const marker = 'READINESS_SECRET_MARKER_ai-module-throw';
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '1');
    const gate = vi.spyOn(moduleSettings, 'isModuleEnabled').mockImplementation(() => {
      throw new Error(marker);
    });
    await withLogSpies(async (logged) => {
      await expect(resolveAiCatalogRuntimeReadiness({ db, secretService })).resolves.toEqual({
        aiModels: false,
        aiProviders: false,
      });
      expect(logged()).not.toContain(marker);
    });
    gate.mockRestore();
  });
});

describe('AI catalog readiness registration', () => {
  afterEach(() => {
    resetAiCatalogReadinessRegistrationForTest();
    clearManagedResourceReadinessForTest();
  });

  it('runs the secret-decrypting AI probe once per readiness pass, not once per resource', async () => {
    // `aiProviders` and `aiModels` share one catalog evaluation; the resolver invokes
    // every registered entry concurrently, so an unshared probe would load the catalog
    // and decrypt every provider secret twice on every capability refresh.
    resetAiCatalogReadinessRegistrationForTest();
    clearManagedResourceReadinessForTest();
    const probe = vi.fn().mockResolvedValue({ aiModels: true, aiProviders: true });
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

  it('lets aiProviders and aiModels diverge from one shared catalog evaluation', async () => {
    resetAiCatalogReadinessRegistrationForTest();
    clearManagedResourceReadinessForTest();
    const probe = vi.fn().mockResolvedValue({ aiModels: false, aiProviders: true });
    ensureAiCatalogReadinessRegistered(probe);

    const readiness = await resolveManagedResourceReadiness();

    expect(readiness.aiProviders).toBe(true);
    expect(readiness.aiModels).toBe(false);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('single-flight shares one unready evaluation then re-runs on the next pass', async () => {
    resetAiCatalogReadinessRegistrationForTest();
    clearManagedResourceReadinessForTest();
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ aiModels: false, aiProviders: false })
      .mockResolvedValue({ aiModels: true, aiProviders: true });
    ensureAiCatalogReadinessRegistered(probe);

    const [first, second] = await Promise.all([
      resolveManagedResourceReadiness(),
      resolveManagedResourceReadiness(),
    ]);
    expect(first).toMatchObject({ aiModels: false, aiProviders: false });
    expect(second).toMatchObject({ aiModels: false, aiProviders: false });
    expect(probe).toHaveBeenCalledOnce();

    expect(await resolveManagedResourceReadiness()).toMatchObject({
      aiModels: true,
      aiProviders: true,
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('swallows an injected probe rejection as unready without logging the error message', async () => {
    resetAiCatalogReadinessRegistrationForTest();
    clearManagedResourceReadinessForTest();
    const marker = 'READINESS_SECRET_MARKER_ai-injected-reject';
    const probe = vi.fn().mockRejectedValue(new Error(marker));
    ensureAiCatalogReadinessRegistered(probe);

    await withLogSpies(async (logged) => {
      const readiness = await resolveManagedResourceReadiness();
      expect(readiness).toMatchObject({ aiModels: false, aiProviders: false });
      expect(probe).toHaveBeenCalledOnce();
      expect(logged()).not.toContain(marker);
    });
  });

  it('swallows an injected probe synchronous throw as unready without logging the error message', async () => {
    resetAiCatalogReadinessRegistrationForTest();
    clearManagedResourceReadinessForTest();
    const marker = 'READINESS_SECRET_MARKER_ai-injected-throw';
    const probe = vi.fn(() => {
      throw new Error(marker);
    });
    ensureAiCatalogReadinessRegistered(probe);

    await withLogSpies(async (logged) => {
      const readiness = await resolveManagedResourceReadiness();
      expect(readiness).toMatchObject({ aiModels: false, aiProviders: false });
      expect(probe).toHaveBeenCalledOnce();
      expect(logged()).not.toContain(marker);
    });
  });
});
