// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import {
  appendConnectorFailureAudit,
  connectorAuditSummary,
  sanitizeConnectorReason,
} from './catalogAudit';
import type { ConnectorDraft } from './catalogTypes';

describe('connector catalog audit boundaries', () => {
  it('summarizes 1000 maximum-size Tool schemas without persisting any schema body', () => {
    const schemaMarker = `schema-body-marker-${'x'.repeat(64 * 1024)}`;
    const draft = {
      connectionTest: null,
      credentialMode: 'none',
      description: null,
      displayName: 'Large Connector',
      enabled: true,
      endpoint: 'https://connector.example.test/mcp',
      id: 'large-connector',
      key: 'large-connector',
      oauthClientSecret: { configured: false, fingerprint: null, updatedAt: null },
      oauthConfig: null,
      revision: 7,
      sharedSecret: { configured: false, fingerprint: null, updatedAt: null },
      sort: 0,
      status: 'draft',
      tools: Array.from({ length: 1000 }, (_, index) => ({
        description: null,
        displayName: `Tool ${index}`,
        enabled: true,
        id: `tool-${index}`,
        inputSchema: { description: schemaMarker },
        outputSchema: { description: schemaMarker },
        platformPolicy: 'deny' as const,
        requiresConfirmation: true,
        riskLevel: 'high' as const,
        sort: index,
        toolKey: `tool.${index}`,
      })),
      transport: 'http',
    } satisfies ConnectorDraft;

    const serialized = JSON.stringify(connectorAuditSummary(draft, ['tools']));
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(4096);
    expect(serialized).toContain('"toolCount":1000');
    expect(serialized).not.toContain('schema-body-marker');
    expect(serialized).not.toContain('inputSchema');
  });

  it('swallows only failure-audit persistence faults without exposing the backend error', async () => {
    const append = vi.fn().mockRejectedValue(new Error('audit-backend-private-response'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      appendConnectorFailureAudit(
        {} as LobeChatDatabase,
        {
          action: 'admin.connectors.updateDraft',
          actorUserId: 'admin-user',
          reason: 'safe reason',
          targetId: 'connector-id',
        },
        append,
      ),
    ).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'safe reason' }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('audit-backend-private-response');
  });

  it('maps current Secret loader failures to one stable non-echo code', async () => {
    const rawError = 'kms-loader-private-response';
    try {
      await sanitizeConnectorReason(
        {
          loadCurrentSecretSources: async () => {
            throw new Error(rawError);
          },
        },
        'connector-id',
        'safe reason',
      );
      expect.unreachable('Secret loader failure must reject');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED' });
      expect(JSON.stringify(error)).not.toContain(rawError);
    }
  });
});
