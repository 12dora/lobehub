import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checksumPayload } from '@/database/models/platform';
import type * as PlatformConnectorCatalogModule from '@/database/repositories/platformConnectorCatalog';
import type { LobeChatDatabase } from '@/database/type';

import type * as RuntimeEffectiveStateModule from './runtimeEffectiveState';
import {
  buildManagedConnectorManifests,
  createConnectorApprovalReceipt,
  matchesConnectorApprovalReceipt,
  matchesConnectorDependencySelection,
} from './runtimeIntegration';

const mocks = vi.hoisted(() => ({
  currentRevision: 1,
  getConnectorByKey: vi.fn(),
  getCurrentPublishedRuntime: vi.fn(),
  getPublishedRuntimeRevision: vi.fn(),
}));

vi.mock('@/database/models/connector', () => ({
  ConnectorModel: vi.fn().mockImplementation(() => ({ queryByIdentifiers: vi.fn(async () => []) })),
}));
vi.mock('@/database/models/connectorTool', () => ({
  ConnectorToolModel: vi.fn().mockImplementation(() => ({
    queryAllByConnectorIds: vi.fn(async () => []),
  })),
}));
vi.mock('@/database/repositories/platformConnectorCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformConnectorCatalogModule>();
  return {
    ...actual,
    PlatformConnectorCatalogRepository: vi.fn().mockImplementation(() => ({
      getConnectorByKey: mocks.getConnectorByKey,
      getCurrentPublishedRuntime: mocks.getCurrentPublishedRuntime,
      getPublishedRuntimeRevision: mocks.getPublishedRuntimeRevision,
    })),
  };
});
vi.mock('./runtimeEffectiveState', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEffectiveStateModule>()),
  getConnectorRuntimeEffectiveState: vi.fn(async () => ({ mode: 'enforced', revision: 8 })),
}));

const env = {
  ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true',
  PLATFORM_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
};
const payload = (revision: number) => ({
  connector: {
    credentialMode: 'none' as const,
    description: null,
    displayName: `Catalog v${revision}`,
    enabled: true,
    endpoint: `https://connector.example.test/v${revision}`,
    id: 'connector-1',
    key: 'catalog',
    oauthClientSecretConfigured: false,
    oauthClientSecretFingerprint: null,
    oauthConfig: null,
    sharedSecretConfigured: false,
    sharedSecretFingerprint: null,
    sort: 0,
    transport: 'http' as const,
  },
  schemaVersion: 'm09-v1' as const,
  tools: [
    {
      description: null,
      displayName: 'Search',
      inputSchema: { type: 'object' },
      outputSchema: {},
      platformPolicy: 'allow' as const,
      requiresConfirmation: true,
      riskLevel: 'high' as const,
      sort: 0,
      toolKey: 'search',
    },
  ],
});
const runtime = (revision: number) => {
  const value = payload(revision);
  return {
    payload: value,
    provenance: {
      checksum: checksumPayload(value),
      connectorId: 'connector-1',
      publishedAt: new Date(),
      revision,
      revisionId: `revision-${revision}`,
    },
  };
};
const connector = (revision: number, status: 'archived' | 'published' = 'published') => ({
  connectorKey: 'catalog',
  enabled: status === 'published',
  id: 'connector-1',
  publishedChecksum: runtime(revision).provenance.checksum,
  publishedRevision: revision,
  status,
});

describe('managed Connector operation integration security', () => {
  const db = {} as LobeChatDatabase;

  beforeEach(() => {
    mocks.currentRevision = 1;
    mocks.getConnectorByKey
      .mockReset()
      .mockImplementation(async () => connector(mocks.currentRevision));
    mocks.getCurrentPublishedRuntime
      .mockReset()
      .mockImplementation(async () => runtime(mocks.currentRevision));
    mocks.getPublishedRuntimeRevision
      .mockReset()
      .mockImplementation(async (_id, revision) => runtime(revision));
  });

  it('rejects a client-selected published connector absent from the persisted Agent allowlist', async () => {
    const result = await buildManagedConnectorManifests({
      agentId: 'agent-1',
      connectorKeys: ['catalog'],
      db,
      env,
      operationId: 'operation-injected',
      serverAllowedConnectorKeys: [],
      userId: 'user-1',
    });

    expect(result.manifests).toEqual([]);
    expect(mocks.getConnectorByKey).not.toHaveBeenCalled();
  });

  it('restores the exact v1 proof after approval even after current publish moves to v2', async () => {
    const first = await buildManagedConnectorManifests({
      agentId: 'agent-1',
      connectorKeys: ['catalog'],
      db,
      env,
      operationId: 'operation-v1',
      serverAllowedConnectorKeys: ['catalog'],
      userId: 'user-1',
    });
    const manifest = first.manifests[0]!;
    const receipt = createConnectorApprovalReceipt({
      agentId: 'agent-1',
      apiName: 'search',
      arguments: '{"query":"docs"}',
      env,
      identifier: 'catalog',
      manifest,
      operationId: 'operation-v1',
      toolCallId: 'tool-call-1',
      type: 'mcp',
      userId: 'user-1',
    })!;
    mocks.currentRevision = 2;

    const resumed = await buildManagedConnectorManifests({
      agentId: 'agent-1',
      approvedReceipt: receipt,
      connectorKeys: ['catalog'],
      db,
      env,
      operationId: 'operation-resume',
      serverAllowedConnectorKeys: ['catalog'],
      userId: 'user-1',
    });

    expect(resumed.manifests[0]?.platformConnectorProof).toMatchObject({
      operationId: 'operation-resume',
      publishedRevision: 1,
    });
    expect(resumed.manifests[0]?.meta.title).toBe('Catalog v1');
    const resumedProof = resumed.manifests[0]!.platformConnectorProof!;
    const resumedSelection = resumed.manifests[0]!.platformConnectorAgentPolicy.selections[0];
    expect(
      matchesConnectorDependencySelection({
        apiName: 'search',
        proof: resumedProof,
        selection: resumedSelection,
      }),
    ).toBe(true);
    expect(
      matchesConnectorDependencySelection({
        apiName: 'client-injected-tool',
        proof: resumedProof,
        selection: resumedSelection,
      }),
    ).toBe(false);
    expect(
      matchesConnectorApprovalReceipt({
        apiName: 'search',
        arguments: { query: 'docs' },
        identifier: 'catalog',
        proof: resumedProof,
        receipt,
        toolCallId: 'tool-call-1',
        toolType: 'mcp',
      }),
    ).toBe(true);
    expect(
      matchesConnectorApprovalReceipt({
        apiName: 'search',
        arguments: { query: 'next' },
        identifier: 'catalog',
        proof: resumedProof,
        receipt,
        toolCallId: 'tool-call-2',
        toolType: 'mcp',
      }),
    ).toBe(false);
  });

  it('does not restore an approved connector after the agent policy removes its key', async () => {
    const first = await buildManagedConnectorManifests({
      agentId: 'agent-1',
      connectorKeys: ['catalog'],
      db,
      env,
      operationId: 'operation-v1',
      serverAllowedConnectorKeys: ['catalog'],
      userId: 'user-1',
    });
    const receipt = createConnectorApprovalReceipt({
      agentId: 'agent-1',
      apiName: 'search',
      arguments: '{"query":"docs"}',
      env,
      identifier: 'catalog',
      manifest: first.manifests[0],
      operationId: 'operation-v1',
      toolCallId: 'tool-call-1',
      type: 'mcp',
      userId: 'user-1',
    })!;

    const resumed = await buildManagedConnectorManifests({
      agentId: 'agent-1',
      approvedReceipt: receipt,
      connectorKeys: [],
      db,
      env,
      operationId: 'operation-resume',
      serverAllowedConnectorKeys: ['catalog'],
      userId: 'user-1',
    });

    expect(resumed.manifests).toEqual([]);
    expect(mocks.getPublishedRuntimeRevision).not.toHaveBeenCalled();
  });

  it.each([
    ['archived', connector(1, 'archived')],
    ['disabled', { ...connector(1), enabled: false }],
  ])(
    'gives the current %s emergency stop priority over an approved historical proof',
    async (_, stopped) => {
      const first = await buildManagedConnectorManifests({
        agentId: 'agent-1',
        connectorKeys: ['catalog'],
        db,
        env,
        operationId: 'operation-before-stop',
        serverAllowedConnectorKeys: ['catalog'],
        userId: 'user-1',
      });
      const receipt = createConnectorApprovalReceipt({
        agentId: 'agent-1',
        apiName: 'search',
        arguments: '{}',
        env,
        identifier: 'catalog',
        manifest: first.manifests[0],
        operationId: 'operation-before-stop',
        toolCallId: 'tool-call-before-stop',
        type: 'mcp',
        userId: 'user-1',
      })!;
      mocks.getConnectorByKey.mockResolvedValue(stopped);

      await expect(
        buildManagedConnectorManifests({
          agentId: 'agent-1',
          approvedReceipt: receipt,
          connectorKeys: ['catalog'],
          db,
          env,
          operationId: 'operation-after-stop',
          serverAllowedConnectorKeys: ['catalog'],
          userId: 'user-1',
        }),
      ).rejects.toThrow('PLATFORM_CONNECTOR_NOT_PUBLISHED');
      expect(mocks.getPublishedRuntimeRevision).not.toHaveBeenCalled();
    },
  );

  it('emits a tombstone for an archived managed key instead of allowing same-name fallback', async () => {
    mocks.getConnectorByKey.mockResolvedValue(connector(1, 'archived'));
    const result = await buildManagedConnectorManifests({
      agentId: 'agent-1',
      connectorKeys: ['catalog'],
      db: {} as LobeChatDatabase,
      env,
      operationId: 'operation-2',
      serverAllowedConnectorKeys: ['catalog'],
      userId: 'user-1',
    });

    expect(result.manifests).toEqual([
      expect.objectContaining({
        api: [],
        identifier: 'catalog',
        platformConnectorTombstone: true,
      }),
    ]);
  });
});
