// @vitest-environment node
import { LobeChatGPTAI } from '@lobechat/model-runtime';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
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
import { mapCardsToBatchUpdate } from './adminService.sync';
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
});
