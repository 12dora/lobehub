import { randomUUID } from 'node:crypto';

import { isPlainRecord } from '@lobechat/utils/object';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';

import { PlatformRevisionConflictError } from '@/database/models/platform';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import { platformConnectors } from '@/database/schemas/platform';
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
import { recordConnectorConnectionTest } from './connectionTestState';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { connectorToolInsertValues, loadConnectorDraft } from './draftService';
import { PlatformConnectorContractError } from './errors';
import { fixedConnectorOperationResult } from './secretBoundary';
import {
  parseConnectorToolsForWrite,
  parseDiscoveredConnectorTools,
} from './toolDefinitionValidator';

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

  /**
   * Discover remote tools and persist them onto the draft under revision CAS so
   * a subsequent admin get/refetch populates the editor for Save/Publish.
   */
  discover = async (
    actorUserId: string,
    input: z.input<typeof adminConnectorDiscoverInputSchema>,
  ) => {
    const command = adminConnectorDiscoverInputSchema.parse(input);
    const reason = await sanitizeConnectorReason(this.secrets, command.id, command.reason);
    try {
      const detail = await loadConnectorDraft(this.db, command.id);
      const discovered = await this.discoverRemoteTools(detail.draft);
      // Re-validate through the write boundary so insert values match ConnectorDraft tools
      // (required outputSchema + stable id) without optional-default inference drift.
      // Zod `.default({})` can leave `outputSchema` optional on the inferred output type —
      // normalize again after parse so connectorToolInsertValues / draft tools stay required.
      const toolsWithIds = parseConnectorToolsForWrite(
        discovered.map((tool) => ({
          ...tool,
          id: randomUUID(),
          outputSchema: tool.outputSchema ?? {},
        })),
      ).map((tool) => ({
        ...tool,
        outputSchema: tool.outputSchema ?? {},
      }));

      await this.db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: platformConnectors.id, revision: platformConnectors.revision })
          .from(platformConnectors)
          .where(eq(platformConnectors.id, command.id))
          .limit(1)
          .for('update');
        if (!locked) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
        if (locked.revision !== detail.draft.revision) {
          throw new PlatformRevisionConflictError();
        }
        const repository = new PlatformConnectorCatalogRepository(tx);
        const updated = await repository.updateConnectorDraftCas(command.id, locked.revision, {
          updatedBy: actorUserId,
        });
        if (!updated) throw new PlatformRevisionConflictError();
        await repository.replaceTools(command.id, connectorToolInsertValues(toolsWithIds));
        await new PlatformAuditService(tx).append({
          action: 'admin.connectors.discover',
          actorUserId,
          afterDiff: { toolCount: toolsWithIds.length },
          configRevision: updated.revision,
          reason,
          result: 'success',
          targetId: command.id,
          targetType: 'connector',
        });
      });

      // Response omits write-only tool ids (contract uses connectorToolWithoutIdListSchema).
      return adminConnectorDiscoverOutputSchema.parse({
        messageCode: 'connector.operation_succeeded',
        oauthConfig: detail.draft.oauthConfig,
        tools: toolsWithIds.map(({ id: _id, ...tool }) => tool),
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

    // Probe classification only — draft load, preflight, and remote discovery.
    // Success-state persistence and audit delivery are outside this catch so an
    // audit outage cannot rewrite a healthy probe as a network failure.
    let detail: Awaited<ReturnType<typeof loadConnectorDraft>>;
    let output: ReturnType<typeof adminConnectorTestOutputSchema.parse>;
    try {
      detail = await loadConnectorDraft(this.db, command.id);
      await this.discoverRemoteTools(detail.draft);
      output = adminConnectorTestOutputSchema.parse({
        ...fixedConnectorOperationResult('success', null),
        latencyMs: Math.max(0, Date.now() - startedAt),
        testedAt: new Date(),
      });
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
      const failureDetail = await loadConnectorDraft(this.db, command.id).catch(() => null);
      const failureOutput = adminConnectorTestOutputSchema.parse({
        ...fixedConnectorOperationResult('failure', errorCategory),
        latencyMs: null,
        testedAt: new Date(),
      });
      if (failureDetail) {
        await recordConnectorConnectionTest(this.db, command.id, {
          errorCategory: failureOutput.errorCategory,
          latencyMs: null,
          messageCode: failureOutput.messageCode,
          status: 'failure',
          testedAt: failureOutput.testedAt,
          testedDraftToken: failureDetail.draftToken,
          testedRevision: failureDetail.draft.revision,
        });
      }
      try {
        await new PlatformAuditService(this.db).append({
          action: 'admin.connectors.test',
          actorUserId,
          afterDiff: failureDetail
            ? {
                ...failureOutput,
                testedDraftToken: failureDetail.draftToken,
                testedRevision: failureDetail.draft.revision,
              }
            : failureOutput,
          reason,
          result: 'failure',
          targetId: command.id,
          targetType: 'connector',
        });
      } catch (auditError) {
        console.error('[connectorCatalog] failure-test audit append failed', {
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
          targetId: command.id,
        });
      }
      return failureOutput;
    }

    // Durable revision/token-bound success so any instance can publish after refetch.
    await recordConnectorConnectionTest(this.db, command.id, {
      errorCategory: null,
      latencyMs: output.latencyMs,
      messageCode: output.messageCode,
      status: 'success',
      testedAt: output.testedAt,
      testedDraftToken: detail.draftToken,
      testedRevision: detail.draft.revision,
    });
    try {
      await new PlatformAuditService(this.db).append({
        action: 'admin.connectors.test',
        actorUserId,
        afterDiff: {
          ...output,
          testedDraftToken: detail.draftToken,
          testedRevision: detail.draft.revision,
        },
        reason,
        result: 'success',
        targetId: command.id,
        targetType: 'connector',
      });
    } catch (auditError) {
      // Probe + durable success state already committed — do not reclassify as network.
      console.error('[connectorCatalog] success-test audit append failed', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        targetId: command.id,
      });
    }
    return output;
  };
}
