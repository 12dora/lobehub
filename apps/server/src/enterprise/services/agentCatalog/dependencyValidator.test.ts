import type { PlatformAgentDependencySnapshot } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Transaction } from '@/database/type';

import { assertExactPlatformAgentDependencies } from './dependencyValidator';
import { PlatformAgentDependencyValidationError } from './errors';

const mocks = vi.hoisted(() => ({
  getConnectorByKey: vi.fn(),
  getProviderByKey: vi.fn(),
  getProviderRevision: vi.fn(),
  getPublishedRuntimeRevision: vi.fn(),
  getPublishedExecutionVersionExact: vi.fn(),
}));

vi.mock('@/database/repositories/platformAiCatalog', () => ({
  PlatformAiCatalogRepository: class {
    getProviderByKey = mocks.getProviderByKey;
    getProviderRevision = mocks.getProviderRevision;
  },
}));
vi.mock('@/database/repositories/platformSkillCatalog', () => ({
  PlatformSkillCatalogRepository: class {
    getPublishedExecutionVersionExact = mocks.getPublishedExecutionVersionExact;
  },
}));
vi.mock('@/database/repositories/platformConnectorCatalog', () => ({
  PlatformConnectorCatalogRepository: class {
    getConnectorByKey = mocks.getConnectorByKey;
    getPublishedRuntimeRevision = mocks.getPublishedRuntimeRevision;
  },
}));

const checksum = (value: string) => value.repeat(64);
const snapshot: PlatformAgentDependencySnapshot = {
  connectors: [
    {
      allowedToolKeys: ['search'],
      connectorId: 'connector-id',
      connectorKey: 'web',
      publishedChecksum: checksum('c'),
      publishedRevision: 3,
    },
  ],
  model: {
    modelKey: 'chat-model',
    providerChecksum: checksum('a'),
    providerKey: 'provider',
    providerRevision: 2,
  },
  skills: [{ checksum: checksum('b'), skillKey: 'summary', version: '1.0.0' }],
};

const tx = {} as Transaction;

const arrangeValid = () => {
  mocks.getProviderByKey.mockResolvedValue({ id: 'provider-id', status: 'published' });
  mocks.getProviderRevision.mockResolvedValue({
    checksum: checksum('a'),
    payload: {
      models: [{ enabled: true, modelKey: 'chat-model', type: 'chat' }],
      provider: { enabled: true, providerKey: 'provider' },
    },
    status: 'published',
  });
  mocks.getPublishedExecutionVersionExact.mockResolvedValue({
    payload: { skill: { enabled: true, skillKey: 'summary' } },
    version: { checksum: checksum('b') },
  });
  mocks.getConnectorByKey.mockResolvedValue({
    id: 'connector-id',
    status: 'published',
  });
  mocks.getPublishedRuntimeRevision.mockResolvedValue({
    payload: {
      connector: { enabled: true, id: 'connector-id', key: 'web' },
      tools: [{ platformPolicy: 'allow', toolKey: 'search' }],
    },
    provenance: { checksum: checksum('c') },
  });
};

describe('assertExactPlatformAgentDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arrangeValid();
  });

  it('accepts exact published and enabled M07/M08/M09 references', async () => {
    await expect(assertExactPlatformAgentDependencies(tx, snapshot)).resolves.toBeUndefined();
    expect(mocks.getProviderRevision).toHaveBeenCalledWith('provider-id', 2);
    expect(mocks.getPublishedExecutionVersionExact).toHaveBeenCalledWith('summary', '1.0.0');
    expect(mocks.getPublishedRuntimeRevision).toHaveBeenCalledWith('connector-id', 3);
  });

  it.each([
    [
      'provider checksum drift',
      () =>
        mocks.getProviderRevision.mockResolvedValue({
          checksum: checksum('f'),
          payload: { models: [], provider: { enabled: true, providerKey: 'provider' } },
          status: 'published',
        }),
      'AI_MODEL_UNAVAILABLE',
    ],
    [
      'non-chat model',
      () =>
        mocks.getProviderRevision.mockResolvedValue({
          checksum: checksum('a'),
          payload: {
            models: [{ enabled: true, modelKey: 'chat-model', type: 'embedding' }],
            provider: { enabled: true, providerKey: 'provider' },
          },
          status: 'published',
        }),
      'AI_MODEL_UNAVAILABLE',
    ],
    [
      'skill checksum drift',
      () =>
        mocks.getPublishedExecutionVersionExact.mockResolvedValue({
          payload: { skill: { enabled: true, skillKey: 'summary' } },
          version: { checksum: checksum('f') },
        }),
      'SKILL_UNAVAILABLE',
    ],
    [
      'disabled skill snapshot',
      () =>
        mocks.getPublishedExecutionVersionExact.mockResolvedValue({
          payload: { skill: { enabled: false, skillKey: 'summary' } },
          version: { checksum: checksum('b') },
        }),
      'SKILL_UNAVAILABLE',
    ],
    [
      'connector identity drift',
      () =>
        mocks.getConnectorByKey.mockResolvedValue({
          id: 'different-id',
          status: 'published',
        }),
      'CONNECTOR_UNAVAILABLE',
    ],
    [
      'denied connector tool',
      () =>
        mocks.getPublishedRuntimeRevision.mockResolvedValue({
          payload: {
            connector: { enabled: true, id: 'connector-id', key: 'web' },
            tools: [{ platformPolicy: 'deny', toolKey: 'search' }],
          },
          provenance: { checksum: checksum('c') },
        }),
      'CONNECTOR_TOOL_UNAVAILABLE',
    ],
  ] as const)('rejects %s without exposing dependency details', async (_name, mutate, code) => {
    mutate();
    const error = await assertExactPlatformAgentDependencies(tx, snapshot).catch((cause) => cause);
    expect(error).toBeInstanceOf(PlatformAgentDependencyValidationError);
    expect(error.issueCodes).toContain(code);
    expect(error.message).toBe('PLATFORM_CONFIG_VALIDATION_FAILED');
    expect(error.message).not.toContain('provider');
    expect(error.message).not.toContain('search');
  });
});
