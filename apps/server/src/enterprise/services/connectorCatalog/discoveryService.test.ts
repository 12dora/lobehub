// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { ConnectorFailureAuditWriter } from './catalogAudit';
import { cleanupM09ServiceData, MemoryConnectorSecretStore } from './catalogTestUtils';
import { resetConnectorConnectionTestStateForTest } from './connectionTestState';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { ConnectorCatalogDiscoveryService } from './discoveryService';
import { ConnectorCatalogDraftService, loadConnectorDraft } from './draftService';
import { PlatformConnectorContractError } from './errors';
import { ConnectorCatalogPublicationService } from './publicationService';
import { CONNECTOR_TOOL_VALIDATION_CODES } from './toolDefinitionValidator';

const db: LobeChatDatabase = await getTestDB();

beforeEach(() => {
  resetConnectorConnectionTestStateForTest();
  return cleanupM09ServiceData(db);
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetConnectorConnectionTestStateForTest();
  await cleanupM09ServiceData(db);
});

const createHarness = async (failureAuditWriter?: ConnectorFailureAuditWriter) => {
  const secrets = new MemoryConnectorSecretStore(db);
  const draft = await new ConnectorCatalogDraftService(
    db,
    secrets,
    'https://aihub.example.test/oauth/callback',
  ).createDraft('admin-user', {
    credentialMode: 'none',
    displayName: 'Discoverable Connector',
    endpoint: 'https://connector.example.test/mcp',
    key: 'discoverable-connector',
    reason: 'create connector',
    transport: 'http',
  });
  const requestJson = vi.fn();
  const outbound = { requestJson } as unknown as ConnectorOutboundClient;
  const service = new ConnectorCatalogDiscoveryService(
    db,
    outbound,
    secrets,
    {
      getHeaders: async () => ({}),
    },
    failureAuditWriter,
  );
  return { connectorId: draft.draft.id, requestJson, service };
};

describe('ConnectorCatalogDiscoveryService', () => {
  it('routes discovery through the outbound boundary and defaults every remote Tool to deny', async () => {
    const { connectorId, requestJson, service } = await createHarness();
    requestJson.mockResolvedValue({
      body: {
        result: {
          tools: [
            {
              description: 'Remote search',
              inputSchema: { type: 'object' },
              name: 'remote.search',
            },
          ],
        },
      },
      status: 200,
      url: 'https://connector.example.test/mcp',
    });

    await expect(
      service.discover('admin-user', { id: connectorId, reason: 'discover tools' }),
    ).resolves.toMatchObject({
      messageCode: 'connector.operation_succeeded',
      tools: [
        {
          platformPolicy: 'deny',
          requiresConfirmation: true,
          riskLevel: 'high',
          toolKey: 'remote.search',
        },
      ],
    });
    expect(requestJson).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'discover', url: 'https://connector.example.test/mcp' }),
    );
    // Discovered tools must be persisted so a subsequent get/refetch populates the editor.
    const after = await loadConnectorDraft(db, connectorId);
    expect(after.draft.tools).toEqual([
      expect.objectContaining({
        platformPolicy: 'deny',
        requiresConfirmation: true,
        riskLevel: 'high',
        toolKey: 'remote.search',
      }),
    ]);
    expect(after.draft.revision).toBe(1);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.connectors.discover', result: 'success' }),
    );
  });

  it('discover_populates_editor_and_can_be_saved_for_publication', async () => {
    const secrets = new MemoryConnectorSecretStore(db);
    const drafts = new ConnectorCatalogDraftService(
      db,
      secrets,
      'https://aihub.example.test/oauth/callback',
    );
    const created = await drafts.createDraft('admin-user', {
      credentialMode: 'none',
      displayName: 'Discover Then Publish',
      endpoint: 'https://connector.example.test/mcp',
      key: 'discover-then-publish',
      reason: 'create connector',
      transport: 'http',
    });
    const requestJson = vi.fn().mockResolvedValue({
      body: {
        result: {
          tools: [
            {
              description: 'Discovered search',
              inputSchema: { type: 'object' },
              name: 'discovered.search',
            },
          ],
        },
      },
      status: 200,
      url: 'https://connector.example.test/mcp',
    });
    const discovery = new ConnectorCatalogDiscoveryService(
      db,
      { requestJson } as unknown as ConnectorOutboundClient,
      secrets,
      { getHeaders: async () => ({}) },
    );
    await discovery.discover('admin-user', {
      id: created.draft.id,
      reason: 'discover tools for publish',
    });

    // Refetch (editor get) must include discovered tools after CAS persist.
    const refetched = await loadConnectorDraft(db, created.draft.id);
    expect(refetched.draft.tools).toEqual([
      expect.objectContaining({
        platformPolicy: 'deny',
        toolKey: 'discovered.search',
      }),
    ]);

    // Admin enables the discovered tool, saves, then publishes.
    const enabledTools = refetched.draft.tools.map((tool) => ({
      ...tool,
      enabled: true,
      platformPolicy: 'allow' as const,
      requiresConfirmation: false,
      riskLevel: 'low' as const,
    }));
    expect(enabledTools[0]?.toolKey).toBe('discovered.search');
    const saved = await drafts.updateDraft('admin-user', {
      expectedDraftToken: refetched.draftToken,
      expectedRevision: refetched.draft.revision,
      id: created.draft.id,
      reason: 'enable discovered tools',
      tools: enabledTools,
    });
    const outbound = {
      getPolicyVersion: () => 1,
      preflight: vi.fn(async () => ({ policyVersion: 1 })),
      requestJson: vi.fn(),
    } as unknown as ConnectorOutboundClient;
    const publication = new ConnectorCatalogPublicationService(db, outbound, secrets, {});
    await expect(
      publication.publish('admin-user', {
        expectedDraftToken: saved.draftToken,
        expectedRevision: saved.draft.revision,
        id: created.draft.id,
        reason: 'publish after discover',
      }),
    ).resolves.toMatchObject({
      revision: expect.any(Number),
    });
    const published = await loadConnectorDraft(db, created.draft.id);
    expect(published.draft.status).toBe('published');
    expect(published.draft.tools.some((tool) => tool.toolKey === 'discovered.search')).toBe(true);
  });

  it('rejects unsafe discovered schema material with a stable non-echo validator code', async () => {
    const secret = 'Authorization: Bearer discovered-never-echo';
    const { connectorId, requestJson, service } = await createHarness();
    requestJson.mockResolvedValue({
      body: {
        result: {
          tools: [
            {
              inputSchema: { description: secret },
              name: 'unsafe.search',
            },
          ],
        },
      },
      status: 200,
      url: 'https://connector.example.test/mcp',
    });

    try {
      await service.discover('admin-user', { id: connectorId, reason: 'discover unsafe tools' });
      throw new Error('expected discovery validation to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: CONNECTOR_TOOL_VALIDATION_CODES.schemaSecret });
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it('propagates SSRF denial and converts other probe failures to fixed safe output', async () => {
    const { connectorId, requestJson, service } = await createHarness();
    requestJson.mockRejectedValueOnce(
      new PlatformConnectorContractError('PLATFORM_CONNECTOR_SSRF_BLOCKED'),
    );
    await expect(
      service.testConnection('admin-user', { id: connectorId, reason: 'test blocked endpoint' }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_SSRF_BLOCKED' });

    requestJson.mockRejectedValueOnce(new Error('upstream-body-with-private-token'));
    await expect(
      service.testConnection('admin-user', { id: connectorId, reason: 'test failing endpoint' }),
    ).resolves.toEqual({
      errorCategory: 'network',
      latencyMs: null,
      messageCode: 'connector.operation_failed',
      status: 'failure',
      testedAt: expect.any(Date),
    });
    expect(JSON.stringify(await db.select().from(platformAuditLogs))).not.toContain(
      'upstream-body-with-private-token',
    );
  });

  it('preserves SSRF denial when failure-audit persistence also fails', async () => {
    const failureAuditWriter = vi.fn(async () => {
      throw new Error('audit-backend-private-response');
    });
    const { connectorId, requestJson, service } = await createHarness(failureAuditWriter);
    requestJson.mockRejectedValue(
      new PlatformConnectorContractError('PLATFORM_CONNECTOR_SSRF_BLOCKED'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      service.testConnection('admin-user', { id: connectorId, reason: 'safe SSRF reason' }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_SSRF_BLOCKED' });
    expect(failureAuditWriter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'safe SSRF reason' }),
    );
  });

  it('successful_test_survives_refetch_and_unlocks_publish', async () => {
    const { connectorId, requestJson, service } = await createHarness();
    requestJson.mockResolvedValue({
      body: {
        result: {
          tools: [{ inputSchema: { type: 'object' }, name: 'probe.ping' }],
        },
      },
      status: 200,
      url: 'https://connector.example.test/mcp',
    });

    await expect(
      service.testConnection('admin-user', { id: connectorId, reason: 'probe before publish' }),
    ).resolves.toMatchObject({
      messageCode: 'connector.operation_succeeded',
      status: 'success',
    });

    // Refetch must surface a non-stale success bound to the current revision/token.
    const refetched = await loadConnectorDraft(db, connectorId);
    expect(refetched.draft.connectionTest).toMatchObject({
      stale: false,
      status: 'success',
      testedDraftToken: refetched.draftToken,
      testedRevision: refetched.draft.revision,
    });
    // UI gate: success && !stale && revision/token match → Publish unlocks.
    const unlocksPublish =
      refetched.draft.connectionTest?.status === 'success' &&
      !refetched.draft.connectionTest.stale &&
      refetched.draft.connectionTest.testedRevision === refetched.draft.revision &&
      refetched.draft.connectionTest.testedDraftToken === refetched.draftToken;
    expect(unlocksPublish).toBe(true);
  });
});
