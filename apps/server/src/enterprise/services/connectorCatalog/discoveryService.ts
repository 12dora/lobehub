import { isPlainRecord } from '@lobechat/utils/object';
import type { z } from 'zod';

import type { LobeChatDatabase } from '@/database/type';

import {
  adminConnectorDiscoverInputSchema,
  adminConnectorDiscoverOutputSchema,
  adminConnectorTestInputSchema,
  adminConnectorTestOutputSchema,
} from '../../contracts/platformConnectors';
import { PlatformAuditService } from '../platformAudit';
import type { ConnectorFailureAuditWriter } from './catalogAudit';
import {
  appendConnectorFailureAudit,
  sanitizeConnectorReason,
  throwStableConnectorSecretError,
} from './catalogAudit';
import type {
  ConnectorCatalogCredentialProvider,
  ConnectorCatalogSecretStore,
  ConnectorDraft,
} from './catalogTypes';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { loadConnectorDraft } from './draftService';
import { PlatformConnectorContractError } from './errors';
import { fixedConnectorOperationResult } from './secretBoundary';
import { parseDiscoveredConnectorTools } from './toolDefinitionValidator';

export class ConnectorCatalogDiscoveryService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly outbound: ConnectorOutboundClient,
    private readonly secrets: ConnectorCatalogSecretStore,
    private readonly credentials: ConnectorCatalogCredentialProvider,
    private readonly failureAuditWriter?: ConnectorFailureAuditWriter,
  ) {}

  private requestHeaders = async (draft: ConnectorDraft): Promise<Record<string, string>> => {
    try {
      return await this.credentials.getHeaders({
        connectorId: draft.id,
        credentialMode: draft.credentialMode,
      });
    } catch (error) {
      return throwStableConnectorSecretError(error);
    }
  };

  private discoverRemoteTools = async (draft: ConnectorDraft) => {
    const response = await this.outbound.requestJson({
      body: { id: 'aihub-tools-list', jsonrpc: '2.0', method: 'tools/list', params: {} },
      headers: await this.requestHeaders(draft),
      method: 'POST',
      operation: 'discover',
      url: draft.endpoint,
    });
    if (!isPlainRecord(response.body) || !isPlainRecord(response.body.result)) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    const remoteTools = response.body.result.tools;
    if (!Array.isArray(remoteTools)) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    return parseDiscoveredConnectorTools(
      remoteTools.map((tool, index) => {
        if (!isPlainRecord(tool) || typeof tool.name !== 'string') {
          throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
        }
        return {
          description: typeof tool.description === 'string' ? tool.description : null,
          displayName: tool.name,
          enabled: true,
          inputSchema: tool.inputSchema ?? {},
          outputSchema: tool.outputSchema ?? {},
          platformPolicy: 'deny',
          requiresConfirmation: true,
          riskLevel: 'high',
          sort: index,
          toolKey: tool.name,
        };
      }),
    );
  };

  discover = async (
    actorUserId: string,
    input: z.input<typeof adminConnectorDiscoverInputSchema>,
  ) => {
    const command = adminConnectorDiscoverInputSchema.parse(input);
    const reason = await sanitizeConnectorReason(this.secrets, command.id, command.reason);
    try {
      const detail = await loadConnectorDraft(this.db, command.id);
      const tools = await this.discoverRemoteTools(detail.draft);
      await new PlatformAuditService(this.db).append({
        action: 'admin.connectors.discover',
        actorUserId,
        afterDiff: { toolCount: tools.length },
        reason,
        result: 'success',
        targetId: command.id,
        targetType: 'connector',
      });
      return adminConnectorDiscoverOutputSchema.parse({
        messageCode: 'connector.operation_succeeded',
        oauthConfig: detail.draft.oauthConfig,
        tools,
      });
    } catch (error) {
      await appendConnectorFailureAudit(
        this.db,
        {
          action: 'admin.connectors.discover',
          actorUserId,
          reason,
          targetId: command.id,
        },
        this.failureAuditWriter,
      );
      throw error;
    }
  };

  testConnection = async (
    actorUserId: string,
    input: z.input<typeof adminConnectorTestInputSchema>,
  ) => {
    const command = adminConnectorTestInputSchema.parse(input);
    const reason = await sanitizeConnectorReason(this.secrets, command.id, command.reason);
    const startedAt = Date.now();
    try {
      const detail = await loadConnectorDraft(this.db, command.id);
      await this.discoverRemoteTools(detail.draft);
      const output = adminConnectorTestOutputSchema.parse({
        ...fixedConnectorOperationResult('success', null),
        latencyMs: Math.max(0, Date.now() - startedAt),
        testedAt: new Date(),
      });
      await new PlatformAuditService(this.db).append({
        action: 'admin.connectors.test',
        actorUserId,
        afterDiff: output,
        reason,
        result: 'success',
        targetId: command.id,
        targetType: 'connector',
      });
      return output;
    } catch (error) {
      if (
        error instanceof PlatformConnectorContractError &&
        error.code === 'PLATFORM_CONNECTOR_SSRF_BLOCKED'
      ) {
        await appendConnectorFailureAudit(
          this.db,
          {
            action: 'admin.connectors.test',
            actorUserId,
            reason,
            targetId: command.id,
          },
          this.failureAuditWriter,
        );
        throw error;
      }
      const errorCategory =
        error instanceof PlatformConnectorContractError &&
        error.code === 'PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED'
          ? 'invalid_config'
          : 'network';
      const output = adminConnectorTestOutputSchema.parse({
        ...fixedConnectorOperationResult('failure', errorCategory),
        latencyMs: null,
        testedAt: new Date(),
      });
      await new PlatformAuditService(this.db).append({
        action: 'admin.connectors.test',
        actorUserId,
        afterDiff: output,
        reason,
        result: 'failure',
        targetId: command.id,
        targetType: 'connector',
      });
      return output;
    }
  };
}
