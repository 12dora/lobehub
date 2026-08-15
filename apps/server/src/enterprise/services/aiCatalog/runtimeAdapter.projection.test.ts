// @vitest-environment node
import { ModelRuntime } from '@lobechat/model-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import {
  createUnmanagedResourcePolicyMap,
  PlatformCatalogAuthorityModel,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { checksumPayload } from '@/database/models/platform/checksum';
import {
  platformAiProviders,
  platformAiProviderSecrets,
  platformManagedResourcePolicies,
  platformResourceRevisions,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import {
  invalidateAiCatalogAuthorityToken,
  loadCurrentAiCatalogSnapshot,
} from '../platformInstance/catalogAuthority';
import { PlatformCatalogTokenInvariantError } from '../platformInstance/catalogTokens';
import { PlatformDomainTargetResolver } from '../platformInstance/domainTargets';
import type { PlatformRuntimeMaterializationReporter } from '../platformInstance/runtimeReporter';
import { AiCatalogAdminService } from './adminService';
import { resetPlatformAiTakeoverCacheForTest } from './enforcement';
import {
  AiCatalogExecutionResolver,
  AiCatalogRuntimeAdapter,
  clearAiCatalogRuntimeCache,
  compareAiCatalogRuntimeStates,
  createAiCatalogModelAllowlistHooks,
  getEmptyAiProviderRuntimeState,
  mergeUnmanagedUpstreamProviders,
  recordAiCatalogShadowComparison,
  resolveAiCatalogRuntimeState,
} from './runtimeAdapter';
import {
  cleanup,
  createPublishedProvider,
  db,
  deferred,
  flags,
  secretService,
  upstreamState,
} from './runtimeAdapter.testFixtures';

beforeEach(cleanup);
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const advanceAiCatalogAuthority = async () => {
  await new PlatformCatalogAuthorityModel(db).bumpGeneration('ai_catalog');
  invalidateAiCatalogAuthorityToken();
};

describe('AiCatalogRuntimeAdapter', () => {
  it('flag-off returns the exact upstream state without reading the catalog', async () => {
    const failOnReadDb = new Proxy(
      {},
      {
        get: () => {
          throw new Error('catalog DB must not be read while the flag is disabled');
        },
      },
    ) as LobeChatDatabase;
    const adapter = new AiCatalogRuntimeAdapter(failOnReadDb);
    const result = await adapter.resolve({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS },
      upstreamState,
    });
    expect(result).toBe(upstreamState);
  });

  it('reports one new immutable runtime build with the exact authoritative target token', async () => {
    const { provider } = await createPublishedProvider();
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const adapter = new AiCatalogRuntimeAdapter(db, { reportRuntimeState });

    await adapter.resolve({ flags, upstreamState });
    await adapter.resolve({ flags, upstreamState });
    const target = await new PlatformDomainTargetResolver(db, {
      env: { ENABLE_PLATFORM_MANAGED_AI: '1' },
    }).resolve('ai_catalog');

    expect(reportRuntimeState).toHaveBeenCalledOnce();
    expect(reportRuntimeState.mock.calls[0]?.[1]).toEqual({
      domain: 'ai_catalog',
      health: 'healthy',
      revisionId: target.token?.value,
      source: 'database',
    });
    expect(target.token?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(reportRuntimeState.mock.calls.map(([, state]) => state))).not.toContain(
      'alpha',
    );

    const [published] = (await loadCurrentAiCatalogSnapshot(db)).revisions;
    await db.insert(platformResourceRevisions).values({
      checksum: checksumPayload(published.payload),
      payload: published.payload,
      resourceId: provider.id,
      resourceType: 'provider',
      revision: 2,
      secretFingerprint: published.secretFingerprint,
      status: 'published',
    });
    await db
      .update(platformAiProviders)
      .set({ revision: 2 })
      .where(eq(platformAiProviders.id, provider.id));
    await advanceAiCatalogAuthority();
    await adapter.resolve({ flags, upstreamState });
    const changedTarget = await new PlatformDomainTargetResolver(db, {
      env: { ENABLE_PLATFORM_MANAGED_AI: '1' },
    }).resolve('ai_catalog');

    expect(reportRuntimeState).toHaveBeenCalledTimes(2);
    expect(reportRuntimeState.mock.calls[1]?.[1]).toMatchObject({
      revisionId: changedTarget.token?.value,
    });
    expect(changedTarget.token?.value).not.toBe(target.token?.value);
  });

  it('ignores higher history, follows rollback pointers, and keeps target/runtime exact', async () => {
    const { provider } = await createPublishedProvider();
    const initial = await loadCurrentAiCatalogSnapshot(db);
    const v1 = initial.revisions[0]!;
    const v2Payload = {
      ...v1.payload,
      provider: { ...(v1.payload.provider as Record<string, unknown>), displayName: 'History v2' },
    };
    await db.insert(platformResourceRevisions).values({
      checksum: checksumPayload(v2Payload),
      payload: v2Payload,
      resourceId: provider.id,
      resourceType: 'provider',
      revision: 2,
      secretFingerprint: v1.secretFingerprint,
      status: 'published',
    });

    clearAiCatalogRuntimeCache();
    const orphanState = await new AiCatalogRuntimeAdapter(db).resolve({ flags, upstreamState });
    expect(orphanState.enabledAiProviders[0]?.name).toBe('Platform Alpha');
    expect((await loadCurrentAiCatalogSnapshot(db)).token.value).toBe(initial.token.value);

    await db
      .update(platformAiProviders)
      .set({ revision: 2 })
      .where(eq(platformAiProviders.id, provider.id));
    await advanceAiCatalogAuthority();
    clearAiCatalogRuntimeCache();
    const forward = await loadCurrentAiCatalogSnapshot(db);
    expect(forward.revisions[0]?.revision).toBe(2);
    expect(
      (await new AiCatalogRuntimeAdapter(db).resolve({ flags, upstreamState }))
        .enabledAiProviders[0]?.name,
    ).toBe('History v2');

    await db
      .update(platformAiProviders)
      .set({ revision: 1 })
      .where(eq(platformAiProviders.id, provider.id));
    await advanceAiCatalogAuthority();
    clearAiCatalogRuntimeCache();
    const rolledBack = await loadCurrentAiCatalogSnapshot(db);
    const target = await new PlatformDomainTargetResolver(db, {
      env: { ENABLE_PLATFORM_MANAGED_AI: '1' },
    }).resolve('ai_catalog');
    expect(rolledBack.token.value).toBe(initial.token.value);
    expect(target.token?.value).toBe(initial.token.value);
    expect(
      (await new AiCatalogRuntimeAdapter(db).resolve({ flags, upstreamState }))
        .enabledAiProviders[0]?.name,
    ).toBe('Platform Alpha');
  });

  it('fails a broken current pointer as one catalog and recovers the exact token after repair', async () => {
    const { provider } = await createPublishedProvider();
    const [savedRevision] = await db
      .select()
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceId, provider.id),
          eq(platformResourceRevisions.revision, 1),
        ),
      );
    // Migration 0145 makes revisions immutable; tests simulate a broken pointer past the trigger.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .delete(platformResourceRevisions)
        .where(
          and(
            eq(platformResourceRevisions.resourceId, provider.id),
            eq(platformResourceRevisions.revision, 1),
          ),
        );
    });
    await advanceAiCatalogAuthority();
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const adapter = new AiCatalogRuntimeAdapter(db, { reportRuntimeState });

    await expect(adapter.resolve({ flags, upstreamState })).rejects.toBeInstanceOf(
      PlatformCatalogTokenInvariantError,
    );
    await expect(
      new PlatformDomainTargetResolver(db, {
        env: { ENABLE_PLATFORM_MANAGED_AI: '1' },
      }).resolve('ai_catalog'),
    ).resolves.toMatchObject({ errorCategory: 'configuration_invalid', status: 'unavailable' });
    expect(reportRuntimeState.mock.calls.map(([, state]) => state.health)).toEqual(['unavailable']);

    await db.insert(platformResourceRevisions).values(savedRevision!);
    await advanceAiCatalogAuthority();
    const repairedTarget = await new PlatformDomainTargetResolver(db, {
      env: { ENABLE_PLATFORM_MANAGED_AI: '1' },
    }).resolve('ai_catalog');
    await adapter.resolve({ flags, upstreamState });
    expect(reportRuntimeState.mock.calls.map(([, state]) => state.health)).toEqual([
      'unavailable',
      'healthy',
    ]);
    expect(reportRuntimeState.mock.calls[1]?.[1]).toMatchObject({
      revisionId: repairedTarget.token?.value,
    });
  });

  it('coalesces a concurrent cold build and reports it once', async () => {
    await createPublishedProvider();
    const snapshot = await loadCurrentAiCatalogSnapshot(db);
    const pending = deferred<typeof snapshot>();
    const loadCurrentSnapshot = vi.fn(() => pending.promise);
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const adapter = new AiCatalogRuntimeAdapter(db, {
      reportRuntimeState,
      loadCurrentSnapshot,
    });

    const first = adapter.resolve({ flags, upstreamState });
    const second = adapter.resolve({ flags, upstreamState });
    await vi.waitFor(() => expect(loadCurrentSnapshot).toHaveBeenCalledOnce());
    pending.resolve(snapshot);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(loadCurrentSnapshot).toHaveBeenCalledOnce();
    expect(reportRuntimeState).toHaveBeenCalledOnce();
  });

  it('does not let a stale invalidated load failure overwrite a newer healthy build', async () => {
    await createPublishedProvider();
    const snapshot = await loadCurrentAiCatalogSnapshot(db);
    const oldRead = deferred<typeof snapshot>();
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const oldAdapter = new AiCatalogRuntimeAdapter(db, {
      reportRuntimeState,
      loadCurrentSnapshot: () => oldRead.promise,
    });
    const oldRequest = oldAdapter.resolve({ flags, upstreamState });
    await Promise.resolve();

    clearAiCatalogRuntimeCache();
    const loadCurrentSnapshot = vi.fn(async () => snapshot);
    const currentAdapter = new AiCatalogRuntimeAdapter(db, {
      reportRuntimeState,
      loadCurrentSnapshot,
    });
    await currentAdapter.resolve({ flags, upstreamState });

    const oldError = new Error('late old catalog failure');
    const oldResult = expect(oldRequest).rejects.toBe(oldError);
    oldRead.reject(oldError);
    await oldResult;
    await currentAdapter.resolve({ flags, upstreamState });

    expect(reportRuntimeState.mock.calls.map(([, state]) => state.health)).toEqual(['healthy']);
    expect(loadCurrentSnapshot).toHaveBeenCalledTimes(2);
  });

  it('reports a failed load then rebuilds the same token without changing the original error', async () => {
    await createPublishedProvider();
    const snapshot = await loadCurrentAiCatalogSnapshot(db);
    const original = Object.assign(new Error('raw AI catalog database detail'), {
      code: 'ECONNREFUSED',
    });
    const loadCurrentSnapshot = vi
      .fn<() => Promise<typeof snapshot>>()
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce(snapshot);
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const adapter = new AiCatalogRuntimeAdapter(db, {
      reportRuntimeState,
      loadCurrentSnapshot,
    });

    await expect(adapter.resolve({ flags, upstreamState })).rejects.toBe(original);
    await adapter.resolve({ flags, upstreamState });

    expect(reportRuntimeState.mock.calls.map(([, state]) => state.health)).toEqual([
      'unavailable',
      'healthy',
    ]);
    expect(JSON.stringify(reportRuntimeState.mock.calls.map(([, state]) => state))).not.toContain(
      'raw AI catalog database detail',
    );
  });

  it('isolates reporter failure and never reports request-scoped secret resolution errors', async () => {
    await createPublishedProvider();
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>(() => {
      throw new Error('raw reporter detail');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = new AiCatalogRuntimeAdapter(db, { reportRuntimeState });

    await expect(adapter.resolve({ flags, upstreamState })).resolves.toMatchObject({
      enabledAiProviders: [expect.objectContaining({ id: 'alpha' })],
    });
    await db.delete(platformAiProviderSecrets);
    await expect(
      new AiCatalogExecutionResolver(db, secretService).resolveProviderExecutionConfig('alpha'),
    ).rejects.toThrow();

    expect(reportRuntimeState).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith('[platform-instance-runtime] reporter unavailable');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('raw reporter detail');
    consoleError.mockRestore();
  });

  it('performs zero repository and reporter work while the managed AI flag is off', async () => {
    const loadCurrentSnapshot = vi.fn();
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const adapter = new AiCatalogRuntimeAdapter(db, {
      reportRuntimeState,
      loadCurrentSnapshot,
    });

    await expect(
      adapter.resolve({ flags: DEFAULT_ENTERPRISE_FEATURE_FLAGS, upstreamState }),
    ).resolves.toBe(upstreamState);
    expect(loadCurrentSnapshot).not.toHaveBeenCalled();
    expect(reportRuntimeState).not.toHaveBeenCalled();
  });

  it('projects enableResponseApi into public runtime config without leaking endpoints or secrets', async () => {
    await createPublishedProvider({
      config: { enableResponseApi: true, endpoint: 'https://private-runtime.example.test/v1' },
    });
    const adapter = new AiCatalogRuntimeAdapter(db);
    const state = await adapter.resolve({ flags, upstreamState });
    expect(state.runtimeConfig.alpha).toEqual({
      config: { enableResponseApi: true },
      fetchOnClient: false,
      keyVaults: {},
      settings: {},
    });
    const publicJson = JSON.stringify(state);
    expect(publicJson).not.toContain('published-key-v1');
    expect(publicJson).not.toContain('private-runtime.example.test');

    // Explicit false is also projected (not treated as default/absent).
    const service = new AiCatalogAdminService(db, secretService, {
      connectionProbe: async () => {},
    });
    let detail = await service.getDetail({ providerKey: 'alpha' });
    await service.updateProviderDraft('admin', {
      config: { enableResponseApi: false, endpoint: 'https://private-runtime.example.test/v1' },
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: detail.draft.id,
      reason: 'disable responses',
    });
    await service.testProvider('admin', { id: detail.draft.id, reason: 'retest' });
    detail = await service.getDetail(detail.draft.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: detail.draft.id,
      reason: 'publish false',
    });
    clearAiCatalogRuntimeCache();
    const after = await adapter.resolve({ flags, upstreamState });
    expect(after.runtimeConfig.alpha.config).toEqual({ enableResponseApi: false });
  });

  it('hands a disabled managed provider back to BYOK (platform takeover ends with the toggle)', async () => {
    const { provider, service } = await createPublishedProvider();
    let detail = await service.getDetail(provider.id);
    await service.updateProviderDraft('admin', {
      enabled: false,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: provider.id,
      reason: 'global disable',
    });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: provider.id,
      reason: 'publish disabled',
    });
    // Platform takeover applies only while the provider is enabled: NOT_FOUND is the signal
    // the ModelRuntime bridge uses to fall back to the user's own configuration. Re-enabling
    // puts the provider back in the snapshot and the platform path wins again.
    const execution = new AiCatalogExecutionResolver(db, secretService);
    await expect(execution.resolveProviderExecutionConfig('alpha')).rejects.toMatchObject({
      code: 'PLATFORM_NOT_FOUND',
    });
  });

  it('hands an archived managed provider back to BYOK', async () => {
    const { provider, service } = await createPublishedProvider();
    const detail = await service.getDetail(provider.id);
    await service.archiveProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: provider.id,
      reason: 'archive managed',
    });
    const execution = new AiCatalogExecutionResolver(db, secretService);
    await expect(execution.resolveProviderExecutionConfig('alpha')).rejects.toMatchObject({
      code: 'PLATFORM_NOT_FOUND',
    });
  });

  it('unions the caller BYOK providers into the managed state without touching the snapshot', async () => {
    await createPublishedProvider();
    clearAiCatalogRuntimeCache();
    const shared = await new AiCatalogRuntimeAdapter(db).resolve({ flags, upstreamState });
    expect(shared.enabledAiProviders.map((item) => item.id)).toEqual(['alpha']);

    const merged = mergeUnmanagedUpstreamProviders(shared, upstreamState);

    // The published provider wins on id collision — the user's own `alpha` row is dropped
    // together with its models and its credentials.
    expect(merged.enabledAiProviders.map((item) => item.id)).toEqual(['alpha', 'user-provider']);
    expect(merged.enabledAiModels.filter((model) => model.providerId === 'alpha')).toEqual(
      shared.enabledAiModels.filter((model) => model.providerId === 'alpha'),
    );
    expect(merged.runtimeConfig.alpha).toEqual(shared.runtimeConfig.alpha);
    expect(JSON.stringify(merged)).not.toContain('user-key-must-not-win');

    // … while the unmanaged provider survives with its models and its own config.
    expect(merged.enabledAiModels.some((model) => model.providerId === 'user-provider')).toBe(true);
    expect(merged.runtimeConfig['user-provider']).toEqual(
      upstreamState.runtimeConfig['user-provider'],
    );

    // The shared snapshot is untouched — it is cached process-wide for every user.
    expect(shared.enabledAiProviders.map((item) => item.id)).toEqual(['alpha']);
    expect(mergeUnmanagedUpstreamProviders(shared, getEmptyAiProviderRuntimeState())).toBe(shared);
  });

  describe('resolveAiCatalogRuntimeState enforcement gate', () => {
    const publishAiProviderPolicy = async (managed: boolean) => {
      const model = new PlatformManagedResourcePolicyModel(db);
      await model.ensureRows();
      const policies = createUnmanagedResourcePolicyMap();
      if (managed) {
        policies.aiProviders = { enforcementMode: 'enforced', managed: true };
        policies.aiModels = { enforcementMode: 'enforced', managed: true };
      }
      await model.materializePublished({ policies, revision: 1 });
      resetPlatformAiTakeoverCacheForTest();
    };

    beforeEach(async () => {
      resetPlatformAiTakeoverCacheForTest();
      await db.delete(platformManagedResourcePolicies);
    });

    afterEach(async () => {
      resetPlatformAiTakeoverCacheForTest();
      await db.delete(platformManagedResourcePolicies);
    });

    it('returns the exact upstream state when 平台托管 is not published', async () => {
      await createPublishedProvider();
      clearAiCatalogRuntimeCache();
      // Policy rows exist but stay at 用户自配 — a published catalog alone authorizes nothing.
      await publishAiProviderPolicy(false);

      const state = await resolveAiCatalogRuntimeState({ db, flags, upstreamState });

      expect(state).toBe(upstreamState);
    });

    it('returns the exact upstream state when the policy is still a draft', async () => {
      await createPublishedProvider();
      clearAiCatalogRuntimeCache();
      const model = new PlatformManagedResourcePolicyModel(db);
      await model.ensureRows();
      const draft = createUnmanagedResourcePolicyMap();
      draft.aiProviders = { enforcementMode: 'enforced', managed: true };
      await model.replaceDraft({ draft });
      resetPlatformAiTakeoverCacheForTest();

      expect(await resolveAiCatalogRuntimeState({ db, flags, upstreamState })).toBe(upstreamState);
    });

    it('overrides with the platform catalog once 平台托管 is published', async () => {
      await createPublishedProvider();
      clearAiCatalogRuntimeCache();
      await publishAiProviderPolicy(true);

      const state = await resolveAiCatalogRuntimeState({ db, flags, upstreamState });

      expect(state).not.toBe(upstreamState);
      expect(state.enabledAiProviders.map((item) => item.id)).toEqual(['alpha', 'user-provider']);
      // Managed provider is credential-free; the caller's own provider keeps its config.
      expect(state.runtimeConfig.alpha?.keyVaults).toEqual({});
      expect(state.runtimeConfig['user-provider']?.keyVaults).toEqual({ apiKey: 'user-only' });
    });

    it('never reads the catalog while the feature flag is off', async () => {
      await publishAiProviderPolicy(true);
      const failOnRead = new Proxy(
        {},
        {
          get() {
            throw new Error('catalog must not be read while ENABLE_PLATFORM_MANAGED_AI is off');
          },
        },
      ) as LobeChatDatabase;

      expect(
        await resolveAiCatalogRuntimeState({
          db: failOnRead,
          flags: DEFAULT_ENTERPRISE_FEATURE_FLAGS,
          upstreamState,
        }),
      ).toBe(upstreamState);
    });
  });

  it('separates public metadata cache from server execution secrets across publish and rollback', async () => {
    const { provider, service } = await createPublishedProvider();
    const adapter = new AiCatalogRuntimeAdapter(db);
    const execution = new AiCatalogExecutionResolver(db, secretService);
    let executionConfig = await execution.resolveProviderExecutionConfig('alpha');
    expect(executionConfig.keyVaults).toEqual({
      apiKey: 'published-key-v1',
      baseURL: 'https://private-runtime.example.test/v1',
    });
    let state = await adapter.resolve({ flags, upstreamState });
    expect(state.enabledAiProviders.map((item) => item.id)).toEqual(['alpha']);
    expect(state.enabledAiModels).toEqual([
      expect.objectContaining({
        abilities: {},
        contextWindowTokens: 128_000,
        id: 'chat',
        providerId: 'alpha',
      }),
    ]);
    expect(state.runtimeConfig.alpha).toEqual({
      // Credential-free allowlist only (enableResponseApi when set); endpoint/secrets stay empty.
      config: {},
      fetchOnClient: false,
      keyVaults: {},
      settings: {},
    });
    expect(state.runtimeConfig).not.toHaveProperty('user-provider');
    const [{ encryptedKeyVaults }] = await db.select().from(platformAiProviders);
    const publicJson = JSON.stringify(state);
    expect(publicJson).not.toContain('published-key-v1');
    expect(publicJson).not.toContain('private-runtime.example.test');
    expect(publicJson).not.toContain(encryptedKeyVaults!);

    let detail = await service.getDetail(provider.id);
    await service.updateProviderDraft('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'clear draft only',
      secret: { operation: 'clear' },
    });
    clearAiCatalogRuntimeCache();
    state = await adapter.resolve({ flags, upstreamState });
    expect(state.runtimeConfig.alpha.keyVaults).toEqual({});
    executionConfig = await execution.resolveProviderExecutionConfig('alpha');
    expect(executionConfig.keyVaults.apiKey).toBe('published-key-v1');

    detail = await service.getDetail(provider.id);
    await service.updateProviderDraft('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'replace draft',
      secret: { operation: 'replace', value: 'published-key-v2' },
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test v2' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'publish v2',
    });
    clearAiCatalogRuntimeCache();
    state = await adapter.resolve({ flags, upstreamState });
    expect(state.runtimeConfig.alpha.keyVaults).toEqual({});
    executionConfig = await execution.resolveProviderExecutionConfig('alpha');
    expect(executionConfig.keyVaults.apiKey).toBe('published-key-v2');

    detail = await service.getDetail(provider.id);
    await service.rollbackProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 2,
      id: provider.id,
      reason: 'rollback v1',
      targetRevision: 1,
    });
    clearAiCatalogRuntimeCache();
    state = await adapter.resolve({ flags, upstreamState });
    expect(state.runtimeConfig.alpha.keyVaults).toEqual({});
    executionConfig = await execution.resolveProviderExecutionConfig('alpha');
    expect(executionConfig.keyVaults.apiKey).toBe('published-key-v1');
    expect(JSON.stringify(state)).not.toContain('published-key');
  });

  it('orders managed providers by catalog sort without falling back to provider id', async () => {
    const { service } = await createPublishedProvider();
    const first = await service.createProviderDraft('admin', {
      checkModel: 'first-chat',
      displayName: 'Sort First',
      enabled: true,
      providerKey: 'zeta-first',
      reason: 'create sorted provider',
      secret: { operation: 'replace', value: 'sort-secret' },
      sort: -10,
      source: 'custom',
    });
    let detail = await service.getDetail(first.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'first-chat',
      providerId: first.id,
      reason: 'model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: first.id, reason: 'test sorted provider' });
    detail = await service.getDetail(first.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: first.id,
      reason: 'publish sorted provider',
    });

    const state = await new AiCatalogRuntimeAdapter(db).resolve({ flags, upstreamState });
    expect(state.enabledAiProviders.map((provider) => provider.id)).toEqual([
      'zeta-first',
      'alpha',
    ]);
  });

  it('merges safe Model Bank metadata before published overrides for Azure and Spark', async () => {
    const azurePayload = {
      models: [
        {
          abilities: {},
          config: {},
          enabled: true,
          modelKey: 'gpt-5.4',
          pricing: {},
          settings: {},
          sort: 0,
          type: 'chat',
        },
      ],
      provider: {
        config: { endpoint: 'https://private-azure.example.test' },
        displayName: 'Azure',
        enabled: true,
        providerKey: 'azure',
        sort: 0,
        source: 'builtin',
      },
    };
    const sparkPayload = {
      models: [
        {
          enabled: true,
          modelKey: 'spark-x2-flash',
          sort: 0,
          type: 'chat',
        },
      ],
      provider: {
        displayName: 'Spark',
        enabled: true,
        providerKey: 'spark',
        sort: 1,
        source: 'builtin',
      },
    };
    await db.insert(platformAiProviders).values([
      {
        displayName: 'Azure',
        enabled: true,
        id: 'azure-provider',
        providerKey: 'azure',
        revision: 1,
        status: 'published',
      },
      {
        displayName: 'Spark',
        enabled: true,
        id: 'spark-provider',
        providerKey: 'spark',
        revision: 1,
        status: 'published',
      },
    ]);
    await db.insert(platformResourceRevisions).values([
      {
        checksum: checksumPayload(azurePayload),
        payload: azurePayload,
        resourceId: 'azure-provider',
        resourceType: 'provider',
        revision: 1,
        status: 'published',
      },
      {
        checksum: checksumPayload(sparkPayload),
        payload: sparkPayload,
        resourceId: 'spark-provider',
        resourceType: 'provider',
        revision: 1,
        status: 'published',
      },
    ]);
    await advanceAiCatalogAuthority();

    const state = await new AiCatalogRuntimeAdapter(db).resolve({ flags, upstreamState });
    expect(state.enabledAiModels.find((model) => model.id === 'gpt-5.4')).toMatchObject({
      abilities: expect.objectContaining({ vision: true }),
      config: { deploymentName: 'gpt-5.4' },
      contextWindowTokens: 1_050_000,
      pricing: expect.objectContaining({ units: expect.any(Array) }),
      settings: expect.objectContaining({ searchImpl: 'params' }),
    });
    expect(state.enabledAiModels.find((model) => model.id === 'spark-x2-flash')).toMatchObject({
      abilities: expect.objectContaining({ reasoning: true }),
      config: { deploymentName: 'spark-x' },
    });
    expect(JSON.stringify(state)).not.toContain('private-azure.example.test');
  });

  it('rejects disabled, unknown, and wrong-operation models before the provider SDK', async () => {
    const service = new AiCatalogAdminService(db, secretService, {
      connectionProbe: async () => {},
    });
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'allow-1',
      displayName: 'Allowlist Provider',
      enabled: true,
      providerKey: 'allowlist-provider',
      reason: 'create allowlist provider',
      secret: { operation: 'replace', value: 'allowlist-secret' },
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    for (const model of [
      { enabled: true, modelKey: 'allow-1', type: 'chat' },
      { enabled: true, modelKey: 'allow-embedding', type: 'embedding' },
      { enabled: true, modelKey: 'allow-tts', type: 'tts' },
      { enabled: true, modelKey: 'allow-asr', type: 'asr' },
      { enabled: false, modelKey: 'deny-1', type: 'chat' },
    ] as const) {
      await service.createModel('admin', {
        ...model,
        expectedDraftToken: detail.draftToken,
        providerId: provider.id,
        reason: `create ${model.modelKey}`,
      });
      detail = await service.getDetail(provider.id);
    }
    await service.testProvider('admin', { id: provider.id, reason: 'test allowlist provider' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: provider.id,
      reason: 'publish allowlist',
    });
    const execution = await new AiCatalogExecutionResolver(
      db,
      secretService,
    ).resolveProviderExecutionConfig('allowlist-provider');
    expect(execution.allowedModels).toEqual([
      { modelKey: 'allow-1', type: 'chat' },
      { modelKey: 'allow-asr', type: 'asr' },
      { modelKey: 'allow-embedding', type: 'embedding' },
      { modelKey: 'allow-tts', type: 'tts' },
    ]);

    const providerSdk = {
      chat: vi.fn().mockResolvedValue(new Response('ok')),
      embeddings: vi.fn().mockResolvedValue([[1, 2, 3]]),
      textToSpeech: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      transcribe: vi.fn().mockResolvedValue({ text: 'ok' }),
    };
    const runtime = new ModelRuntime(
      providerSdk as never,
      createAiCatalogModelAllowlistHooks(execution.allowedModels),
    );

    await expect(runtime.chat({ messages: [], model: 'deny-1' })).rejects.toMatchObject({
      code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
    });
    await expect(runtime.chat({ messages: [], model: 'unknown' })).rejects.toMatchObject({
      code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
    });
    await expect(runtime.embeddings({ input: 'blocked', model: 'allow-1' })).rejects.toMatchObject({
      code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
    });
    await expect(
      runtime.textToSpeech({ input: 'blocked', model: 'deny-tts', voice: 'voice' }),
    ).rejects.toMatchObject({ code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' });
    await expect(runtime.transcribe({ file: new Blob(), model: 'deny-asr' })).rejects.toMatchObject(
      { code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' },
    );
    expect(providerSdk.chat).not.toHaveBeenCalled();
    expect(providerSdk.embeddings).not.toHaveBeenCalled();
    expect(providerSdk.textToSpeech).not.toHaveBeenCalled();
    expect(providerSdk.transcribe).not.toHaveBeenCalled();

    await expect(runtime.chat({ messages: [], model: 'allow-1' })).resolves.toBeInstanceOf(
      Response,
    );
    await expect(
      runtime.embeddings({ input: 'allowed', model: 'allow-embedding' }),
    ).resolves.toEqual([[1, 2, 3]]);
    await expect(
      runtime.textToSpeech({ input: 'allowed', model: 'allow-tts', voice: 'voice' }),
    ).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(runtime.transcribe({ file: new Blob(), model: 'allow-asr' })).resolves.toEqual({
      text: 'ok',
    });
    expect(providerSdk.chat).toHaveBeenCalledOnce();
    expect(providerSdk.embeddings).toHaveBeenCalledOnce();
  });

  it('maps every managed runtime operation to its catalog model type', async () => {
    const hooks = createAiCatalogModelAllowlistHooks([
      { modelKey: 'chat-model', type: 'chat' },
      { modelKey: 'embedding-model', type: 'embedding' },
      { modelKey: 'image-model', type: 'image' },
      { modelKey: 'tts-model', type: 'tts' },
      { modelKey: 'asr-model', type: 'asr' },
      { modelKey: 'video-model', type: 'video' },
    ]);

    await expect(hooks.beforeChat?.({ model: 'chat-model' } as never)).resolves.toBeUndefined();
    await expect(
      hooks.beforeGenerateObject?.({ model: 'chat-model' } as never),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeEmbeddings?.({ model: 'embedding-model' } as never),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeCreateImage?.({ model: 'image-model' } as never),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeCreateVideo?.({ model: 'video-model' } as never),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeTextToSpeech?.({ model: 'tts-model' } as never),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeTranscribe?.({ model: 'asr-model' } as never),
    ).resolves.toBeUndefined();
    await expect(hooks.beforeCreateImage?.({ model: 'chat-model' } as never)).rejects.toMatchObject(
      { errorType: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' },
    );
  });

  it('produces a bounded secret-free shadow comparison', () => {
    const managed = {
      ...upstreamState,
      enabledAiModels: upstreamState.enabledAiModels.slice(0, 1),
      enabledAiProviders: upstreamState.enabledAiProviders.slice(0, 1),
      runtimeConfig: { alpha: upstreamState.runtimeConfig.alpha },
    };
    const comparison = compareAiCatalogRuntimeStates(upstreamState, managed);
    expect(comparison).toMatchObject({
      managedModelCount: 1,
      managedProviderCount: 1,
      providerOnlyInUpstream: ['user-provider'],
    });
    expect(recordAiCatalogShadowComparison(upstreamState, managed)).toEqual(comparison);
    expect(JSON.stringify(comparison)).not.toContain('user-key-must-not-win');
  });

  it('bounds high-cardinality shadow differences and reports exact totals', () => {
    const highCardinality = {
      ...upstreamState,
      enabledAiModels: [],
      enabledAiProviders: Array.from({ length: 150 }, (_, index) => ({
        id: `provider-${index.toString().padStart(3, '0')}`,
        name: `Provider ${index}`,
        source: 'custom' as const,
      })),
    };
    const comparison = compareAiCatalogRuntimeStates(
      highCardinality,
      getEmptyAiProviderRuntimeState(),
    );
    expect(comparison.providerOnlyInUpstream).toHaveLength(100);
    expect(comparison.providerOnlyInUpstreamTotal).toBe(150);
    expect(comparison.differencesTruncated).toBe(true);
  });
});
