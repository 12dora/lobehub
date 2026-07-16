// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { ConnectorFailureAuditWriter } from './catalogAudit';
import {
  cleanupM09ServiceData,
  ensurePendingM09ServiceSchema,
  MemoryConnectorSecretStore,
} from './catalogTestUtils';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { ConnectorCatalogDiscoveryService } from './discoveryService';
import { ConnectorCatalogDraftService } from './draftService';
import { PlatformConnectorContractError } from './errors';
import { CONNECTOR_TOOL_VALIDATION_CODES } from './toolDefinitionValidator';

const db: LobeChatDatabase = await getTestDB();

beforeAll(() => ensurePendingM09ServiceSchema(db));
beforeEach(() => cleanupM09ServiceData(db));
afterEach(async () => {
  vi.restoreAllMocks();
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
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.connectors.discover', result: 'success' }),
    );
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
});
