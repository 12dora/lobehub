import type { PlatformAgentDependencySnapshot } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  assertExactPlatformAgentDependencies,
  validateExactPlatformAgentDependencies,
} from './dependencyValidator';
import { PlatformAgentDependencyValidationError } from './errors';

const mocks = vi.hoisted(() => ({
  acquireValidationLock: vi.fn(),
  getProviderByKey: vi.fn(),
  getProviderRevision: vi.fn(),
  getPublishedExecutionVersionsExact: vi.fn(),
  getPublishedRuntimeRevisionsExact: vi.fn(),
}));

vi.mock('../platformDependencyLock', () => ({
  acquirePlatformDependencyValidationLock: mocks.acquireValidationLock,
}));

vi.mock('@/database/repositories/platformAiCatalog', () => ({
  PlatformAiCatalogRepository: class {
    getProviderByKey = mocks.getProviderByKey;
    getProviderRevision = mocks.getProviderRevision;
  },
}));
vi.mock('@/database/repositories/platformSkillCatalog', () => ({
  PlatformSkillCatalogRepository: class {
    getPublishedExecutionVersionsExact = mocks.getPublishedExecutionVersionsExact;
  },
}));
vi.mock('@/database/repositories/platformConnectorCatalog', () => ({
  PlatformConnectorCatalogRepository: class {
    getPublishedRuntimeRevisionsExact = mocks.getPublishedRuntimeRevisionsExact;
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

const skillRow = (overrides: Record<string, unknown> = {}) => ({
  payload: { skill: { enabled: true, skillKey: 'summary' } },
  version: { checksum: checksum('b') },
  ...overrides,
});

const connectorRow = (overrides: Record<string, unknown> = {}) => ({
  connector: { connectorKey: 'web', id: 'connector-id', status: 'published' },
  payload: {
    connector: { enabled: true, id: 'connector-id', key: 'web' },
    tools: [{ platformPolicy: 'allow', toolKey: 'search' }],
  },
  provenance: { checksum: checksum('c') },
  ...overrides,
});

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
  mocks.getPublishedExecutionVersionsExact.mockResolvedValue(
    new Map([['summary\0' + '1.0.0', skillRow()]]),
  );
  mocks.getPublishedRuntimeRevisionsExact.mockResolvedValue(
    new Map([['connector-id\0' + 3, connectorRow()]]),
  );
};

describe('assertExactPlatformAgentDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arrangeValid();
  });

  it('accepts exact published and enabled M07/M08/M09 references', async () => {
    await expect(assertExactPlatformAgentDependencies(tx, snapshot)).resolves.toBeUndefined();
    expect(mocks.getProviderRevision).toHaveBeenCalledWith('provider-id', 2);
    expect(mocks.getPublishedExecutionVersionsExact).toHaveBeenCalledOnce();
    expect(mocks.getPublishedExecutionVersionsExact).toHaveBeenCalledWith(snapshot.skills);
    expect(mocks.getPublishedRuntimeRevisionsExact).toHaveBeenCalledOnce();
    expect(mocks.getPublishedRuntimeRevisionsExact).toHaveBeenCalledWith(snapshot.connectors);
  });

  it('takes the shared validation lock before any exact catalog read', async () => {
    const db = {
      transaction: vi.fn(async (run: (transaction: Transaction) => Promise<unknown>) => run(tx)),
    } as unknown as LobeChatDatabase;

    await expect(validateExactPlatformAgentDependencies(db, snapshot)).resolves.toEqual({
      valid: true,
    });
    expect(mocks.acquireValidationLock).toHaveBeenCalledWith(tx);
    expect(mocks.acquireValidationLock).toHaveBeenCalledBefore(mocks.getProviderByKey);
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
        mocks.getPublishedExecutionVersionsExact.mockResolvedValue(
          new Map([['summary\0' + '1.0.0', skillRow({ version: { checksum: checksum('f') } })]]),
        ),
      'SKILL_UNAVAILABLE',
    ],
    [
      'disabled skill snapshot',
      () =>
        mocks.getPublishedExecutionVersionsExact.mockResolvedValue(
          new Map([
            [
              'summary\0' + '1.0.0',
              skillRow({ payload: { skill: { enabled: false, skillKey: 'summary' } } }),
            ],
          ]),
        ),
      'SKILL_UNAVAILABLE',
    ],
    [
      'connector identity drift',
      () =>
        mocks.getPublishedRuntimeRevisionsExact.mockResolvedValue(
          new Map([
            [
              'connector-id\0' + 3,
              connectorRow({
                connector: { connectorKey: 'web', id: 'different-id', status: 'published' },
              }),
            ],
          ]),
        ),
      'CONNECTOR_UNAVAILABLE',
    ],
    [
      'denied connector tool',
      () =>
        mocks.getPublishedRuntimeRevisionsExact.mockResolvedValue(
          new Map([
            [
              'connector-id\0' + 3,
              connectorRow({
                payload: {
                  connector: { enabled: true, id: 'connector-id', key: 'web' },
                  tools: [{ platformPolicy: 'deny', toolKey: 'search' }],
                },
              }),
            ],
          ]),
        ),
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

  it('keeps the maximum Skill/Connector snapshot to one batch query per catalog', async () => {
    const largeSnapshot = {
      ...snapshot,
      connectors: Array.from({ length: 100 }, (_, index) => ({
        ...snapshot.connectors[0],
        connectorId: `connector-${index}`,
        connectorKey: `connector-${index}`,
      })),
      skills: Array.from({ length: 100 }, (_, index) => ({
        ...snapshot.skills[0],
        skillKey: `skill-${index}`,
      })),
    };
    mocks.getPublishedExecutionVersionsExact.mockResolvedValue(
      new Map(
        largeSnapshot.skills.map((reference) => [
          `${reference.skillKey}\0${reference.version}`,
          skillRow({ payload: { skill: { enabled: true, skillKey: reference.skillKey } } }),
        ]),
      ),
    );
    mocks.getPublishedRuntimeRevisionsExact.mockResolvedValue(
      new Map(
        largeSnapshot.connectors.map((reference) => [
          `${reference.connectorId}\0${reference.publishedRevision}`,
          connectorRow({
            connector: {
              connectorKey: reference.connectorKey,
              id: reference.connectorId,
              status: 'published',
            },
            payload: {
              connector: {
                enabled: true,
                id: reference.connectorId,
                key: reference.connectorKey,
              },
              tools: [{ platformPolicy: 'allow', toolKey: 'search' }],
            },
          }),
        ]),
      ),
    );

    await expect(assertExactPlatformAgentDependencies(tx, largeSnapshot)).resolves.toBeUndefined();
    expect(mocks.getPublishedExecutionVersionsExact).toHaveBeenCalledOnce();
    expect(mocks.getPublishedRuntimeRevisionsExact).toHaveBeenCalledOnce();
  });
});
