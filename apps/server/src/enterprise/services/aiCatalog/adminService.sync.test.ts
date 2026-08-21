// @vitest-environment node
import { LobeChatGPTAI } from '@lobechat/model-runtime';
import { eq, sql } from 'drizzle-orm';
import type { ChatModelCard } from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform';
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
import {
  mapCardsToBatchUpdate,
  projectCatalogAfterBatch,
  reconcileChatGPTWebLegacySkus,
  resolveChatGPTWebCheckModelUpgrade,
} from './adminService.sync';
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

describe('reconcileChatGPTWebLegacySkus', () => {
  const familyCard = {
    description: 'Family',
    displayName: 'GPT-5.6 Sol (ChatGPT Web)',
    enabled: true,
    files: true,
    functionCall: false,
    id: 'gpt-5-6',
    imageOutput: true,
    reasoning: true,
    search: true,
    settings: { extendParams: ['chatgptWebReasoningEffort'] as const, searchImpl: 'params' },
    vision: true,
  } satisfies ChatModelCard;

  it('hides Instant/Thinking/Pro and auto rows without disabling them', () => {
    const existing = [
      draftModel({
        abilities: { files: true, vision: true },
        displayName: 'GPT-5.6 (ChatGPT Web)',
        id: 'family-1',
        modelKey: 'gpt-5-6',
      }),
      draftModel({ enabled: true, id: 'instant-1', modelKey: 'gpt-5-6-instant' }),
      draftModel({ enabled: true, id: 'thinking-1', modelKey: 'gpt-5-6-thinking' }),
      draftModel({ enabled: true, id: 'pro-1', modelKey: 'gpt-5-6-pro' }),
      draftModel({ enabled: true, id: 'auto-1', modelKey: 'auto' }),
      draftModel({ enabled: true, id: 'mini-1', modelKey: 'gpt-5-6-mini' }),
    ];

    const mapped = mapCardsToBatchUpdate([familyCard], existing);
    const result = reconcileChatGPTWebLegacySkus([familyCard], existing, mapped);

    const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));
    expect(byId['instant-1']).toEqual({
      id: 'instant-1',
      settings: { legacyAlias: 'gpt-5-6' },
    });
    expect(byId['thinking-1']).toEqual({
      id: 'thinking-1',
      settings: { legacyAlias: 'gpt-5-6' },
    });
    expect(byId['pro-1']).toEqual({
      id: 'pro-1',
      settings: { legacyAlias: 'gpt-5-6' },
    });
    expect(byId['auto-1']).toEqual({
      id: 'auto-1',
      settings: { legacyAlias: 'gpt-5-6' },
    });
    expect(byId['mini-1']).toBeUndefined();
    expect(result.items.every((item) => item.enabled !== false)).toBe(true);
    expect(byId['family-1']).toEqual(
      expect.objectContaining({
        abilities: {
          files: true,
          imageOutput: true,
          reasoning: true,
          search: true,
          vision: true,
        },
        displayName: 'GPT-5.6 Sol (ChatGPT Web)',
        id: 'family-1',
        settings: { extendParams: ['chatgptWebReasoningEffort'], searchImpl: 'params' },
      }),
    );
  });

  it('re-enables a previously disabled SKU and stamps legacyAlias', () => {
    const existing = [
      draftModel({ enabled: false, id: 'thinking-1', modelKey: 'gpt-5-6-thinking' }),
    ];
    const mapped = mapCardsToBatchUpdate([familyCard], existing);
    const result = reconcileChatGPTWebLegacySkus([familyCard], existing, mapped);

    expect(result.items.find((item) => item.id === 'thinking-1')).toEqual(
      expect.objectContaining({
        enabled: true,
        id: 'thinking-1',
        settings: { legacyAlias: 'gpt-5-6' },
      }),
    );
  });

  it('stamps gpt-5-5 SKUs even when that family is absent from the live cards', () => {
    const existing = [
      draftModel({ enabled: true, id: 'thinking-55', modelKey: 'gpt-5-5-thinking' }),
      draftModel({ enabled: true, id: 'pro-55', modelKey: 'gpt-5-5-pro' }),
    ];
    const mapped = mapCardsToBatchUpdate([familyCard], existing);
    const result = reconcileChatGPTWebLegacySkus([familyCard], existing, mapped);
    const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));

    expect(byId['thinking-55']?.settings).toEqual({ legacyAlias: 'gpt-5-5' });
    expect(byId['pro-55']?.settings).toEqual({ legacyAlias: 'gpt-5-5' });
    expect(byId['thinking-55']?.enabled).toBeUndefined();
  });

  it('stamps auto when the live enumeration has no family cards', () => {
    const existing = [draftModel({ enabled: true, id: 'auto-1', modelKey: 'auto' })];
    const o3Card = { displayName: 'o3', id: 'o3', reasoning: true };
    const mapped = mapCardsToBatchUpdate([o3Card], existing);
    const result = reconcileChatGPTWebLegacySkus([o3Card], existing, mapped);

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'auto-1', settings: { legacyAlias: 'gpt-5-6' } }),
      ]),
    );
  });

  it('is idempotent when legacy SKUs already carry legacyAlias and stay enabled', () => {
    const existing = [
      draftModel({
        abilities: {
          files: true,
          imageOutput: true,
          reasoning: true,
          search: true,
          vision: true,
        },
        description: 'Family',
        displayName: 'GPT-5.6 Sol (ChatGPT Web)',
        id: 'family-1',
        modelKey: 'gpt-5-6',
        settings: { extendParams: ['chatgptWebReasoningEffort'], searchImpl: 'params' },
      }),
      draftModel({
        enabled: true,
        id: 'instant-1',
        modelKey: 'gpt-5-6-instant',
        settings: { legacyAlias: 'gpt-5-6' },
      }),
      draftModel({
        enabled: true,
        id: 'auto-1',
        modelKey: 'auto',
        settings: { legacyAlias: 'gpt-5-6' },
      }),
    ];

    const mapped = mapCardsToBatchUpdate([familyCard], existing);
    const result = reconcileChatGPTWebLegacySkus([familyCard], existing, mapped);

    expect(result.items).toEqual(mapped.items);
    expect(result.items.some((item) => item.enabled === false)).toBe(false);
  });
});

describe('resolveChatGPTWebCheckModelUpgrade', () => {
  it('upgrades auto and Instant/Thinking/Pro to an enabled family row', () => {
    const existing = [
      draftModel({ enabled: true, id: 'family-1', modelKey: 'gpt-5-6' }),
      draftModel({ enabled: true, id: 'auto-1', modelKey: 'auto' }),
    ];
    expect(resolveChatGPTWebCheckModelUpgrade('auto', existing)).toBe('gpt-5-6');
    expect(resolveChatGPTWebCheckModelUpgrade('gpt-5-6-thinking', existing)).toBe('gpt-5-6');
    expect(resolveChatGPTWebCheckModelUpgrade('gpt-5-6', existing)).toBeUndefined();
  });

  it('leaves checkModel unchanged when the catalog is o3-only', () => {
    const existing = [draftModel({ enabled: true, id: 'o3-1', modelKey: 'o3' })];
    expect(resolveChatGPTWebCheckModelUpgrade('auto', existing)).toBeUndefined();
  });

  it('leaves checkModel unchanged when every family row is disabled', () => {
    const existing = [
      draftModel({ enabled: false, id: 'family-1', modelKey: 'gpt-5-6' }),
      draftModel({ enabled: false, id: 'family-2', modelKey: 'gpt-5-5' }),
    ];
    expect(resolveChatGPTWebCheckModelUpgrade('auto', existing)).toBeUndefined();
  });

  it('does not pick a newly discovered family card created disabled', () => {
    const existing = [draftModel({ enabled: true, id: 'o3-1', modelKey: 'o3' })];
    const catalog = projectCatalogAfterBatch(existing, [
      { enabled: false, id: 'gpt-5-6', type: 'chat' },
    ]);
    expect(resolveChatGPTWebCheckModelUpgrade('auto', catalog)).toBeUndefined();
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

  const addLegacySku = async (
    service: AiCatalogAdminService,
    providerId: string,
    modelKey: string,
  ) => {
    const detail = await service.getDetail(providerId);
    await service.applyModelImmediate('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey,
      operation: 'create',
      providerId,
      reason: 'seed legacy sku',
      type: 'chat',
    });
  };

  const familyLiveCards = [
    {
      displayName: 'GPT-5.6 Sol (ChatGPT Web)',
      id: 'gpt-5-6',
      reasoning: true,
      settings: { extendParams: ['chatgptWebReasoningEffort' as const] },
      type: 'chat' as const,
    },
  ];

  it('keeps a legacy SKU on the execution allowlist after sync and hides it from the picker', async () => {
    const { providerId, service } = await seedChatgptWeb();
    await addLegacySku(service, providerId, 'gpt-5-6-thinking');
    mockModels.mockResolvedValue(familyLiveCards);

    await expect(service.syncUpstream('admin', { providerId })).resolves.toMatchObject({
      created: 0,
    });

    const thinking = (await db.select().from(platformAiModels)).find(
      (row) => row.modelKey === 'gpt-5-6-thinking',
    );
    expect(thinking).toMatchObject({
      enabled: true,
      settings: expect.objectContaining({ legacyAlias: 'gpt-5-6' }),
    });

    const execution = new AiCatalogExecutionResolver(
      db,
      new PlatformSecretService({ keyProvider }),
    );
    const config = await execution.resolveProviderExecutionConfig('chatgptweb');
    expect(config.allowedModels.map((model) => model.modelKey)).toContain('gpt-5-6-thinking');
  });

  it('does not abort sync when a published platform agent depends on a legacy SKU', async () => {
    const { providerId, service } = await seedChatgptWeb();
    await addLegacySku(service, providerId, 'gpt-5-6-thinking');

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

    mockModels.mockResolvedValue(familyLiveCards);

    await expect(service.syncUpstream('admin', { providerId })).resolves.toMatchObject({
      created: 0,
    });

    const thinking = (await db.select().from(platformAiModels)).find(
      (row) => row.modelKey === 'gpt-5-6-thinking',
    );
    expect(thinking?.enabled).toBe(true);
  });

  it('migrates a persisted checkModel of auto to gpt-5-6 during sync', async () => {
    const { providerId, service } = await seedChatgptWeb('auto');
    mockModels.mockResolvedValue(familyLiveCards);

    await service.syncUpstream('admin', { providerId });

    const [provider] = await db.select().from(platformAiProviders);
    expect(provider.checkModel).toBe('gpt-5-6');

    const audits = await db.select().from(platformAuditLogs);
    expect(
      audits.some(
        (row) =>
          row.action === 'admin.aiModels.syncUpstream' &&
          row.result === 'success' &&
          (row.afterDiff as { checkModel?: string } | null)?.checkModel === 'gpt-5-6',
      ),
    ).toBe(true);
  });

  const disableFamilyRows = async (service: AiCatalogAdminService, providerId: string) => {
    const detail = await service.getDetail(providerId);
    for (const model of detail.draft.models) {
      if (!/^gpt-5-\d+$/.test(model.modelKey) || !model.enabled) continue;
      const latest = await service.getDetail(providerId);
      const current = latest.draft.models.find((row) => row.id === model.id);
      if (!current) continue;
      await service.applyModelImmediate('admin', {
        enabled: false,
        expectedDraftToken: latest.draftToken,
        expectedRevision: current.revision,
        id: current.id,
        operation: 'update',
        providerId,
        reason: 'disable family',
      });
    }
  };

  it('leaves checkModel unchanged when enumeration is o3-only and families are disabled', async () => {
    const { providerId, service } = await seedChatgptWeb('auto');
    await disableFamilyRows(service, providerId);
    mockModels.mockResolvedValue([{ displayName: 'o3', id: 'o3', type: 'chat' }]);

    await service.syncUpstream('admin', { providerId });

    const [provider] = await db.select().from(platformAiProviders);
    expect(provider.checkModel).toBe('auto');
  });

  it('does not migrate checkModel onto a newly created disabled family card', async () => {
    const { providerId, service } = await seedChatgptWeb('auto');
    await disableFamilyRows(service, providerId);
    mockModels.mockResolvedValue([{ displayName: 'GPT-5.7', id: 'gpt-5-7', type: 'chat' }]);

    await service.syncUpstream('admin', { providerId });

    const [provider] = await db.select().from(platformAiProviders);
    expect(provider.checkModel).toBe('auto');
    const created = (await db.select().from(platformAiModels)).find(
      (row) => row.modelKey === 'gpt-5-7',
    );
    expect(created?.enabled).toBe(false);
  });

  it('CAS-rejects a stale check-model-only sync after a concurrent checkModel write', async () => {
    const { providerId, service } = await seedChatgptWeb('auto');
    mockModels.mockImplementation(async () => {
      const detail = await service.getDetail(providerId);
      await service.applyProviderImmediate('admin', {
        checkModel: 'o3',
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.draft.revision,
        id: providerId,
        mode: 'update',
        reason: 'concurrent checkModel',
      });
      return [];
    });

    await expect(service.syncUpstream('admin', { providerId })).rejects.toBeInstanceOf(
      PlatformRevisionConflictError,
    );

    const [provider] = await db.select().from(platformAiProviders);
    expect(provider.checkModel).toBe('o3');
  });
});
