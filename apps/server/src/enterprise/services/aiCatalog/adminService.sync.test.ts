// @vitest-environment node
import { AgentRuntimeError } from '@lobechat/model-runtime';
import { AgentRuntimeErrorType } from '@lobechat/types';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import * as ModelRuntime from '@/server/modules/ModelRuntime';

import type { AiProviderDraft } from '../../contracts/aiCatalog';
import { PlatformAuditService } from '../platformAudit';
import { AiCatalogAdminService, AiCatalogUpstreamSyncError } from './adminService';
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
      ${platformAiProviders}
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

describe('mapCardsToBatchUpdate', () => {
  it('clears stored abilities when upstream reports every capability as false', () => {
    const existing = draftModel({
      abilities: { reasoning: true, search: true },
      displayName: 'Custom Grok',
      id: 'model-1',
      modelKey: 'grok-custom',
    });

    const result = mapCardsToBatchUpdate(
      [
        {
          displayName: 'Custom Grok',
          id: 'grok-custom',
          reasoning: false,
          search: false,
        },
      ],
      [existing],
    );

    expect(result).toEqual({
      created: 0,
      items: [expect.objectContaining({ abilities: {}, id: 'model-1' })],
      total: 1,
      updated: 1,
    });
    expect(result.items[0]?.abilities).toEqual({});
  });

  it('keeps stored abilities when upstream omits every capability flag', () => {
    const existing = draftModel({
      abilities: { reasoning: true, search: true },
      displayName: 'Custom Grok',
      id: 'model-1',
      modelKey: 'grok-custom',
    });

    const result = mapCardsToBatchUpdate(
      [{ displayName: 'Custom Grok', id: 'grok-custom' }],
      [existing],
    );

    expect(result).toEqual({ created: 0, items: [], total: 1, updated: 0 });
  });
});

describe('AiCatalogAdminService.syncUpstream', () => {
  it('does not sync after a post-exchange refresh persistence failure', async () => {
    const { providerId, service } = await seedProvider('sync-refresh-persist');
    mockModels.mockResolvedValue([{ displayName: 'Should not land', id: 'nope', type: 'chat' }]);
    mockRefreshSharedOAuthVault.mockRejectedValue(
      AgentRuntimeError.createError(AgentRuntimeErrorType.InvalidProviderAPIKey, {
        message: 'OAuth tokens for provider "chatgpt" could not be saved',
      }),
    );

    await expect(service.syncUpstream('admin', { providerId })).rejects.toBeInstanceOf(
      AiCatalogUpstreamSyncError,
    );
    expect(mockModels).not.toHaveBeenCalled();

    const models = await db
      .select()
      .from(platformAiModels)
      .where(eq(platformAiModels.providerId, providerId));
    expect(models).toEqual([]);
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

  it('persists an empty abilities object when upstream turns every capability off', async () => {
    const { providerId, service } = await seedProvider('sync-abilities-clear');
    let detail = await service.getDetail(providerId);
    await service.applyModelImmediate('admin', {
      abilities: { reasoning: true, search: true },
      displayName: 'Custom Grok',
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'grok-custom',
      operation: 'create',
      providerId,
      reason: 'seed existing',
      type: 'chat',
    });

    mockModels.mockResolvedValue([
      {
        displayName: 'Custom Grok',
        id: 'grok-custom',
        reasoning: false,
        search: false,
        type: 'chat',
      },
    ]);

    await expect(service.syncUpstream('admin', { providerId })).resolves.toEqual({
      created: 0,
      total: 1,
      updated: 1,
    });

    detail = await service.getDetail(providerId);
    expect(detail.draft.models.find((model) => model.modelKey === 'grok-custom')).toMatchObject({
      abilities: {},
      displayName: 'Custom Grok',
      enabled: true,
    });
  });
});
