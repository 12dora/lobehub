import type { AiProviderRuntimeState } from '@lobechat/types';
import { sql } from 'drizzle-orm';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
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
import { clearAiCatalogRuntimeCache } from './runtimeAdapter';

export const db: LobeChatDatabase = await getTestDB();
export const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(41), keyId: 'runtime-test' }),
  providerId: 'test',
};
export const secretService = new PlatformSecretService({ keyProvider });
export const flags = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true };
export const upstreamState: AiProviderRuntimeState = {
  enabledAiModels: [
    {
      abilities: { vision: true },
      contextWindowTokens: 64_000,
      enabled: true,
      id: 'chat',
      providerId: 'alpha',
      type: 'chat',
    },
    { abilities: {}, enabled: true, id: 'user-only', providerId: 'user-provider', type: 'chat' },
  ],
  enabledAiProviders: [
    { id: 'alpha', name: 'Built-in Alpha', source: 'builtin' },
    { id: 'user-provider', name: 'User', source: 'custom' },
  ],
  enabledChatAiProviders: [],
  enabledImageAiProviders: [],
  enabledVideoAiProviders: [],
  runtimeConfig: {
    'alpha': { config: {}, keyVaults: { apiKey: 'user-key-must-not-win' }, settings: {} },
    'user-provider': { config: {}, keyVaults: { apiKey: 'user-only' }, settings: {} },
  },
};

export const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
};

/** Append-only audit rows cannot be DELETE'd (0145); TRUNCATE bypasses the row trigger. */
export const cleanup = async () => {
  clearAiCatalogRuntimeCache();
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformAiProviderSecrets},
      ${platformAiModels},
      ${platformAiProviders}
    RESTART IDENTITY CASCADE
  `);
};

export const createPublishedProvider = async (options?: {
  config?: Record<string, unknown>;
  providerKey?: string;
}) => {
  const service = new AiCatalogAdminService(db, secretService, {
    connectionProbe: async () => {},
  });
  const provider = await service.createProviderDraft('admin', {
    checkModel: 'chat',
    config: {
      endpoint: 'https://private-runtime.example.test/v1',
      ...options?.config,
    },
    displayName: 'Platform Alpha',
    enabled: true,
    providerKey: options?.providerKey ?? 'alpha',
    reason: 'create',
    secret: { operation: 'replace', value: 'published-key-v1' },
    source: 'custom',
  });
  let detail = await service.getDetail(provider.id);
  await service.createModel('admin', {
    contextWindowTokens: 128_000,
    enabled: true,
    expectedDraftToken: detail.draftToken,
    modelKey: 'chat',
    providerId: provider.id,
    reason: 'model',
    type: 'chat',
  });
  await service.testProvider('admin', { id: provider.id, reason: 'test v1' });
  detail = await service.getDetail(provider.id);
  await service.publishProvider('admin', {
    expectedDraftToken: detail.draftToken,
    expectedRevision: 0,
    id: provider.id,
    reason: 'publish v1',
  });
  return { provider, service };
};
