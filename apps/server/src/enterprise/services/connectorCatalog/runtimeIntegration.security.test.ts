import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checksumPayload } from '@/database/models/platform';
import type * as PlatformConnectorCatalogModule from '@/database/repositories/platformConnectorCatalog';
import type { LobeChatDatabase } from '@/database/type';

import type * as RuntimeEffectiveStateModule from './runtimeEffectiveState';
import { getConnectorRuntimeEffectiveState } from './runtimeEffectiveState';
import {
  buildManagedConnectorManifests,
  buildPinnedManagedConnectorManifests,
  createConnectorApprovalReceipt,
  executeManagedConnectorTool,
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
vi.mock('../connectorGovernance/resolve', () => ({
  resolveConnectorGovernance: vi.fn(async () => ({
    active: false,
    builtinToolPolicies: {},
    sharedAuthOwnerUserId: null,
  })),
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
        meta: expect.objectContaining({ description: '' }),
        platformConnectorTombstone: true,
        platformConnectorTombstoneMessageCode: 'connectorCatalog.tombstone.unavailable',
      }),
    ]);
    // User-visible description stays empty; code is a dedicated machine field.
    expect(result.manifests[0]?.meta?.description).toBe('');
  });

  it('rejects dispatch when the connector archives after manifest construction', async () => {
    const built = await buildManagedConnectorManifests({
      agentId: 'agent-1',
      connectorKeys: ['catalog'],
      db,
      env,
      operationId: 'operation-toctou',
      serverAllowedConnectorKeys: ['catalog'],
      userId: 'user-1',
    });
    const receipt = createConnectorApprovalReceipt({
      agentId: 'agent-1',
      apiName: 'search',
      arguments: '{}',
      env,
      identifier: 'catalog',
      manifest: built.manifests[0],
      operationId: 'operation-toctou',
      toolCallId: 'tool-call-toctou',
      type: 'mcp',
      userId: 'user-1',
    });
    mocks.getConnectorByKey.mockResolvedValue(connector(1, 'archived'));

    await expect(
      executeManagedConnectorTool({
        agentId: 'agent-1',
        apiName: 'search',
        approvalReceipt: receipt,
        arguments: '{}',
        db,
        env,
        identifier: 'catalog',
        manifest: built.manifests[0],
        operationId: 'operation-toctou',
        toolCallId: 'tool-call-toctou',
        toolType: 'mcp',
        userId: 'user-1',
      }),
    ).resolves.toMatchObject({
      handled: true,
      result: { error: { code: 'PLATFORM_CONNECTOR_NOT_PUBLISHED' }, success: false },
    });
  });

  // CONNECTOR-EXACT: a platform Agent's Connector manifests come from its immutable pinned refs —
  // the exact historical revision + pinned allowlist — not the moving catalog head.
  describe('buildPinnedManagedConnectorManifests (CONNECTOR-EXACT)', () => {
    const pinnedRef = (revision: number) => ({
      allowedToolKeys: ['search'],
      connectorId: 'connector-1',
      connectorKey: 'catalog',
      publishedChecksum: runtime(revision).provenance.checksum,
      publishedRevision: revision,
    });

    it('injects the exact pinned v1 manifest + allowlist even after the head moves to v2', async () => {
      // Current head is v2, but the operation pinned v1.
      mocks.currentRevision = 2;
      const result = await buildPinnedManagedConnectorManifests({
        agentId: 'agent-1',
        db,
        env,
        operationId: 'operation-v1',
        pinnedConnectors: [pinnedRef(1)],
        userId: 'user-1',
      });

      const manifest = result.manifests[0]!;
      // Exact v1 — title + proof revision are v1, not the v2 head.
      expect(manifest.meta.title).toBe('Catalog v1');
      expect(manifest.platformConnectorProof?.publishedRevision).toBe(1);
      // Only the pinned allowlisted tool is exposed.
      expect(manifest.api.map((tool) => tool.name)).toEqual(['search']);
      expect(manifest.platformConnectorAgentPolicy.selections[0].allowedToolKeys).toEqual([
        'search',
      ]);
      // The exact revision was resolved by ref (not the current head).
      expect(mocks.getPublishedRuntimeRevision).toHaveBeenCalledWith('connector-1', 1);

      // Rebuild after the head advances to v2 → still v1 (deterministic, pinned).
      const resumed = await buildPinnedManagedConnectorManifests({
        agentId: 'agent-1',
        db,
        env,
        operationId: 'operation-resume',
        pinnedConnectors: [pinnedRef(1)],
        userId: 'user-1',
      });
      expect(resumed.manifests[0]?.meta.title).toBe('Catalog v1');
      expect(resumed.manifests[0]?.platformConnectorProof?.publishedRevision).toBe(1);
    });

    it('fails closed when a pinned allowed tool is not allow-listed in the exact revision (escalation)', async () => {
      await expect(
        buildPinnedManagedConnectorManifests({
          agentId: 'agent-1',
          db,
          env,
          operationId: 'operation-escalate',
          pinnedConnectors: [{ ...pinnedRef(1), allowedToolKeys: ['search', 'ghost-tool'] }],
          userId: 'user-1',
        }),
      ).rejects.toThrow('PLATFORM_CONNECTOR_TOOL_DENIED');
    });

    it('fails closed on a checksum mismatch for a pinned Connector', async () => {
      await expect(
        buildPinnedManagedConnectorManifests({
          agentId: 'agent-1',
          db,
          env,
          operationId: 'operation-tamper',
          pinnedConnectors: [{ ...pinnedRef(1), publishedChecksum: 'f'.repeat(64) }],
          userId: 'user-1',
        }),
      ).rejects.toThrow('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    });

    it('fails closed when the Agent pinned Connectors but managed Connectors are not enforced', async () => {
      vi.mocked(getConnectorRuntimeEffectiveState).mockResolvedValueOnce({
        epoch: 0,
        mode: 'legacy',
        revision: 8,
      });
      await expect(
        buildPinnedManagedConnectorManifests({
          agentId: 'agent-1',
          db,
          env,
          operationId: 'operation-off',
          pinnedConnectors: [pinnedRef(1)],
          userId: 'user-1',
        }),
      ).rejects.toThrow('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    });

    it('returns an empty manifest set with zero catalog I/O when there are no pinned Connectors', async () => {
      const result = await buildPinnedManagedConnectorManifests({
        agentId: 'agent-1',
        db,
        env,
        operationId: 'operation-empty',
        pinnedConnectors: [],
        userId: 'user-1',
      });
      expect(result.manifests).toEqual([]);
      expect(mocks.getPublishedRuntimeRevision).not.toHaveBeenCalled();
    });
  });
});
