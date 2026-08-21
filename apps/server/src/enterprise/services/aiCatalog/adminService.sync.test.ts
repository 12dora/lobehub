// @vitest-environment node
import { LobeChatGPTAI } from '@lobechat/model-runtime';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import {
  platformAgents,
  platformAgentVersions,
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformJobs,
  platformResourceRevisions,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';
import * as ModelRuntime from '@/server/modules/ModelRuntime';

import type { AiProviderDraft } from '../../contracts/aiCatalog';
import { PlatformAuditService } from '../platformAudit';
import {
  AiCatalogAdminService,
  AiCatalogUpstreamSyncError,
  AiCatalogValidationError,
} from './adminService';
import { applyChatGPTWebCatalogSyncPolicy, mapCardsToBatchUpdate } from './adminService.sync';
import { AiCatalogExecutionResolver } from './runtimeAdapter';
import type * as SharedOAuthRefreshModule from './sharedOAuthRefresh';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(71), keyId: 'sync-test' }),
  providerId: 'test',
};

vi.mock('@/server/modules/ModelRuntime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    initModelRuntimeWithUserPayload: vi.fn(),
  };
});

const { mockRefreshSharedOAuthVault } = vi.hoisted(() => ({
  mockRefreshSharedOAuthVault: vi.fn(),
}));

vi.mock('./sharedOAuthRefresh', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedOAuthRefreshModule>();
  return {
    ...actual,
    refreshSharedOAuthVault: mockRefreshSharedOAuthVault,
  };
});

const mockModels = vi.fn();

const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformAgentVersions},
      ${platformAgents},
      ${platformAiModels},
      ${platformAiProviderSecrets},
      ${platformAiProviders},
      ${platformJobs}
    RESTART IDENTITY CASCADE
  `);
};

const createService = () =>
  new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }));

const draftModel = (
  overrides: Partial<AiProviderDraft['models'][number]> &
    Pick<AiProviderDraft['models'][number], 'id' | 'modelKey'>,
): AiProviderDraft['models'][number] => ({
  abilities: {},
  config: null,
  contextWindowTokens: null,
  description: null,
  displayName: overrides.modelKey,
  enabled: true,
  parameters: {},
  pricing: null,
  providerId: 'provider-1',
  revision: 1,
  settings: {},
  sort: 0,
  status: 'published',
  type: 'chat',
  ...overrides,
});

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  mockModels.mockReset();
  vi.mocked(ModelRuntime.initModelRuntimeWithUserPayload).mockReset();
  vi.mocked(ModelRuntime.initModelRuntimeWithUserPayload).mockReturnValue({
    models: mockModels,
  } as never);
  mockRefreshSharedOAuthVault.mockReset();
  mockRefreshSharedOAuthVault.mockImplementation(async (params) => params.keyVaults);
  await cleanup();
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const seedProvider = async (providerKey: string) => {
  const service = createService();
  const created = await service.applyProviderImmediate('admin', {
    displayName: providerKey,
    enabled: true,
    mode: 'create',
    providerKey,
    reason: 'seed provider',
    secret: { operation: 'replace', value: `seed-${providerKey}` },
    settings: { sdkType: 'openai' },
    source: 'custom',
  });
  return { providerId: created.draft.id, service };
};

const listThroughChatGPT = async (data: Array<Record<string, unknown>>) => {
  const instance = new LobeChatGPTAI({ apiKey: 'sync-ability-fixture' });
  vi.spyOn(instance['client'], 'get').mockResolvedValue({ data } as never);
  return instance.models();
};

describe('mapCardsToBatchUpdate', () => {
  it('clears stored abilities when the live Codex payload reports every capability as false', async () => {
    const cards = await listThroughChatGPT([
      {
        displayName: 'Custom Grok',
        id: 'codex-sync-ability-fixture',
        reasoning: false,
        search: false,
      },
    ]);
    const existing = draftModel({
      abilities: { reasoning: true, search: true },
      displayName: cards[0]?.displayName ?? 'codex-sync-ability-fixture',
      id: 'model-1',
      modelKey: 'codex-sync-ability-fixture',
    });

    const result = mapCardsToBatchUpdate(cards, [existing]);

    expect(result.items).toEqual([expect.objectContaining({ abilities: {}, id: 'model-1' })]);
    expect(result.updated).toBe(1);
  });

  it('keeps stored abilities when the live Codex payload is a bare id', async () => {
    const cards = await listThroughChatGPT([{ id: 'codex-sync-ability-fixture' }]);
    const existing = draftModel({
      abilities: { reasoning: true, search: true },
      displayName: cards[0]?.displayName ?? 'codex-sync-ability-fixture',
      id: 'model-1',
      modelKey: 'codex-sync-ability-fixture',
    });

    const result = mapCardsToBatchUpdate(cards, [existing]);

    expect(result.items.every((item) => item.abilities === undefined)).toBe(true);
  });

  it('emits an update when the only change is settings.extendParams', () => {
    const existing = draftModel({
      displayName: 'GPT-5.5',
      id: 'model-1',
      modelKey: 'gpt-5.5',
      settings: { extendParams: ['gpt5_2ReasoningEffort'] },
    });
    const cards = [
      {
        displayName: 'GPT-5.5',
        id: 'gpt-5.5',
        settings: { extendParams: ['gpt5_6ReasoningEffort' as const] },
      },
    ];

    const result = mapCardsToBatchUpdate(cards, [existing]);

    expect(result.updated).toBe(1);
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'model-1',
        settings: { extendParams: ['gpt5_6ReasoningEffort'] },
      }),
    ]);
  });
});

describe('applyChatGPTWebCatalogSyncPolicy', () => {
  it('unstamps leftover family-card settings and normalises thinking/pro/none', () => {
    const existing = [
      draftModel({
        id: 'family-1',
        modelKey: 'gpt-5-6',
        settings: { extendParams: ['chatgptWebReasoningEffort'], searchImpl: 'params' },
      }),
      draftModel({
        enabled: true,
        id: 'thinking-1',
        modelKey: 'gpt-5-6-thinking',
        settings: { extendParams: ['chatgptWebReasoningEffort'] },
      }),
      draftModel({
        enabled: true,
        id: 'pro-1',
        modelKey: 'gpt-5-6-pro',
        settings: { extendParams: ['chatgptWebReasoningEffort'] },
      }),
      draftModel({
        enabled: true,
        id: 'auto-1',
        modelKey: 'auto',
        settings: { extendParams: ['gpt5_6ReasoningEffort'] },
      }),
    ];

    const mapped = mapCardsToBatchUpdate([], existing);
    const result = applyChatGPTWebCatalogSyncPolicy(existing, mapped);
    const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));

    expect(byId['family-1']?.settings).toEqual({ searchImpl: 'params' });
    expect(byId['thinking-1']?.settings).toEqual({
      extendParams: ['chatgptWebThinkingEffort'],
    });
    expect(byId['pro-1']?.settings).toEqual({
      extendParams: ['chatgptWebProThinkingEffort'],
    });
    expect(byId['auto-1']?.settings).toEqual({});
  });

  it('is idempotent when settings already match the 1:1 table', () => {
    const existing = [
      draftModel({
        id: 'thinking-1',
        modelKey: 'gpt-5-6-thinking',
        settings: { extendParams: ['chatgptWebThinkingEffort'] },
      }),
      draftModel({
        id: 'pro-1',
        modelKey: 'gpt-5-6-pro',
        settings: { extendParams: ['chatgptWebProThinkingEffort'] },
      }),
    ];
    const mapped = mapCardsToBatchUpdate([], existing);
    const result = applyChatGPTWebCatalogSyncPolicy(existing, mapped);
    expect(result.items).toEqual(mapped.items);
  });
});

describe('AiCatalogAdminService.syncUpstream', () => {
  it('rejects a disconnected shared account with a typed reason', async () => {
    const service = createService();
    const created = await service.applyProviderImmediate('admin', {
      displayName: 'Grok',
      enabled: true,
      mode: 'create',
      providerKey: 'supergrok',
      reason: 'seed empty shared account',
      source: 'builtin',
    });

    await expect(service.syncUpstream('admin', { providerId: created.draft.id })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AiCatalogValidationError &&
        error.reason === 'shared_account_not_connected',
    );
    expect(mockModels).not.toHaveBeenCalled();
  });

  it('does not sync after a post-exchange refresh persistence failure', async () => {
    const actual = await vi.importActual<typeof SharedOAuthRefreshModule>('./sharedOAuthRefresh');
    mockRefreshSharedOAuthVault.mockImplementation(actual.refreshSharedOAuthVault);

    const secretService = new PlatformSecretService({ keyProvider });
    const service = new AiCatalogAdminService(db, secretService);
    const created = await service.applyProviderImmediate('admin', {
      displayName: 'Shared grok',
      enabled: true,
      mode: 'create',
      providerKey: 'supergrok',
      reason: 'seed oauth',
      secret: {
        operation: 'replace',
        value: {
          oauthAccessToken: 'at-old',
          oauthRefreshToken: 'rt-old',
          oauthTokenExpiresAt: String(Date.now() + 30_000),
        },
      },
      source: 'builtin',
    });
    mockModels.mockResolvedValue([{ displayName: 'Should not land', id: 'nope', type: 'chat' }]);

    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'at-new',
            expires_in: 3600,
            refresh_token: 'rt-new',
            token_type: 'bearer',
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    const encryptSpy = vi
      .spyOn(secretService, 'encrypt')
      .mockRejectedValue(new Error('kek write failed'));

    try {
      await expect(
        service.syncUpstream('admin', { providerId: created.draft.id }),
      ).rejects.toBeInstanceOf(AiCatalogUpstreamSyncError);
      expect(mockModels).not.toHaveBeenCalled();
      expect(globalThis.fetch).toHaveBeenCalled();

      const models = await db
        .select()
        .from(platformAiModels)
        .where(eq(platformAiModels.providerId, created.draft.id));
      expect(models.every((model) => model.modelKey !== 'nope')).toBe(true);
    } finally {
      encryptSpy.mockRestore();
      globalThis.fetch = realFetch;
    }
  });

  it('still lists with the stored vault when the token endpoint fails before exchange', async () => {
    const { providerId, service } = await seedProvider('sync-refresh-blip');
    mockModels.mockResolvedValue([
      { displayName: 'From stored token', id: 'listed', type: 'chat' },
    ]);
    mockRefreshSharedOAuthVault.mockRejectedValue(new Error('token endpoint 503'));

    await expect(service.syncUpstream('admin', { providerId })).resolves.toEqual({
      created: 1,
      total: 1,
      updated: 0,
    });
    expect(mockModels).toHaveBeenCalled();
    expect(ModelRuntime.initModelRuntimeWithUserPayload).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ managedBy: 'platform' }),
    );

    const models = await db
      .select()
      .from(platformAiModels)
      .where(eq(platformAiModels.providerId, providerId));
    expect(models).toEqual([expect.objectContaining({ modelKey: 'listed' })]);
  });

  it('rolls the catalog write back when the sync audit insert fails', async () => {
    const { providerId, service } = await seedProvider('sync-audit-atomic');
    mockModels.mockResolvedValue([{ displayName: 'Brand New', id: 'brand-new', type: 'chat' }]);

    const originalAppend = PlatformAuditService.prototype.append;
    vi.spyOn(PlatformAuditService.prototype, 'append').mockImplementation(async function (
      this: PlatformAuditService,
      params,
    ) {
      if (params.action === 'admin.aiModels.syncUpstream') {
        throw new Error('audit insert failed');
      }
      return originalAppend.call(this, params);
    });

    await expect(service.syncUpstream('admin', { providerId })).rejects.toThrow(
      'audit insert failed',
    );

    const models = await db
      .select()
      .from(platformAiModels)
      .where(eq(platformAiModels.providerId, providerId));
    expect(models).toEqual([]);

    const successAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiModels.syncUpstream' && row.result === 'success',
    );
    expect(successAudits).toEqual([]);
  });

  it('persists an empty abilities object when the live Codex payload turns every capability off', async () => {
    const { providerId, service } = await seedProvider('sync-abilities-clear');
    const cards = await listThroughChatGPT([
      {
        displayName: 'Custom Grok',
        id: 'codex-sync-ability-fixture',
        reasoning: false,
        search: false,
      },
    ]);
    let detail = await service.getDetail(providerId);
    await service.applyModelImmediate('admin', {
      abilities: { reasoning: true, search: true },
      displayName: cards[0]?.displayName ?? 'codex-sync-ability-fixture',
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'codex-sync-ability-fixture',
      operation: 'create',
      providerId,
      reason: 'seed existing',
      type: 'chat',
    });

    mockModels.mockImplementation(async () => cards);

    await expect(service.syncUpstream('admin', { providerId })).resolves.toEqual({
      created: 0,
      total: 1,
      updated: 1,
    });

    detail = await service.getDetail(providerId);
    expect(
      detail.draft.models.find((model) => model.modelKey === 'codex-sync-ability-fixture'),
    ).toMatchObject({
      abilities: {},
      enabled: true,
    });
  });

  const seedChatgptWeb = async (checkModel = 'auto') => {
    const service = createService();
    const created = await service.applyProviderImmediate('admin', {
      checkModel,
      displayName: 'ChatGPT Web',
      enabled: true,
      mode: 'create',
      providerKey: 'chatgptweb',
      reason: 'seed chatgptweb',
      secret: { operation: 'replace', value: { oauthAccessToken: 'shared-access-token' } },
      source: 'builtin',
    });
    return { providerId: created.draft.id, service };
  };

  const liveCards = [
    {
      displayName: 'GPT-5.6 (ChatGPT Web)',
      id: 'gpt-5-6',
      reasoning: false,
      settings: { searchImpl: 'params' },
      type: 'chat' as const,
    },
    {
      displayName: 'GPT-5.6 Thinking (ChatGPT Web)',
      id: 'gpt-5-6-thinking',
      reasoning: true,
      settings: { extendParams: ['chatgptWebThinkingEffort' as const] },
      type: 'chat' as const,
    },
  ];

  it('keeps a thinking SKU on the execution allowlist after sync and assigns the thinking control', async () => {
    const { providerId, service } = await seedChatgptWeb();
    mockModels.mockResolvedValue(liveCards);

    await expect(service.syncUpstream('admin', { providerId })).resolves.toMatchObject({
      created: 0,
    });

    const thinking = (await db.select().from(platformAiModels)).find(
      (row) => row.modelKey === 'gpt-5-6-thinking',
    );
    expect(thinking).toMatchObject({
      enabled: true,
      settings: expect.objectContaining({ extendParams: ['chatgptWebThinkingEffort'] }),
    });

    const execution = new AiCatalogExecutionResolver(
      db,
      new PlatformSecretService({ keyProvider }),
    );
    const config = await execution.resolveProviderExecutionConfig('chatgptweb');
    expect(config.allowedModels.map((model) => model.modelKey)).toContain('gpt-5-6-thinking');
  });

  it('does not abort sync when a published platform agent depends on a thinking SKU', async () => {
    const { providerId, service } = await seedChatgptWeb();

    const repository = new PlatformAgentCatalogRepository(db);
    const agent = await repository.createIdentity({
      agentKey: 'legacy-thinking-agent',
      isDefault: false,
      systemKey: null,
    });
    const version = await repository.appendVersionCas({
      agentId: agent.id,
      config: {
        avatar: null,
        backgroundColor: null,
        description: 'Depends on thinking SKU',
        displayName: 'Thinking dependent',
        modelParameters: {},
        openingMessage: null,
        openingQuestions: [],
        systemRole: 'Use the exact model dependency.',
        tags: [],
      },
      dependencySnapshot: {
        connectors: [],
        model: {
          modelKey: 'gpt-5-6-thinking',
          providerChecksum: 'b'.repeat(64),
          providerKey: 'chatgptweb',
          providerRevision: 1,
        },
        skills: [],
      },
      expectedDraftSequence: 0,
      expectedRevision: 0,
      version: '1.0.0',
    });
    await repository.pointToVersionCas({
      agentId: agent.id,
      expectedDraftSequence: 1,
      expectedRevision: 0,
      publishedAt: new Date(),
      versionId: version!.id,
    });

    mockModels.mockResolvedValue(liveCards);

    await expect(service.syncUpstream('admin', { providerId })).resolves.toMatchObject({
      created: 0,
    });

    const thinking = (await db.select().from(platformAiModels)).find(
      (row) => row.modelKey === 'gpt-5-6-thinking',
    );
    expect(thinking?.enabled).toBe(true);
  });
});
