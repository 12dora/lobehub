import { createHash } from 'node:crypto';

import { PlatformConnectorContractError } from './errors';
import type {
  ConnectorRuntimeAuditWriter,
  ConnectorRuntimePolicyRecord,
  ConnectorRuntimePolicyResolver,
  ConnectorRuntimeRateLimiter,
  PlatformConnectorRuntimeAdapterDependencies,
  PlatformConnectorRuntimeInvocation,
  PlatformConnectorRuntimeResult,
} from './runtimeAdapterTypes';
import { resolveOAuthCredentials, resolveSharedCredentials } from './runtimeCredentials';
import type { ConnectorRuntimeJournalToken } from './runtimeExecutionJournal';
import { BoundedConnectorRuntimeRateLimiter } from './runtimeRateLimiter';
import { parseArguments, parseRuntimeResponse, shouldAuditSharedFailure } from './runtimeResponse';
import {
  resolveConnectorConfirmationPolicy,
  resolveEffectiveConnectorToolPolicy,
} from './toolPolicy';

export { BoundedConnectorRuntimeRateLimiter };
export type {
  ConnectorRuntimeAuditWriter,
  ConnectorRuntimePolicyRecord,
  ConnectorRuntimePolicyResolver,
  ConnectorRuntimeRateLimiter,
  PlatformConnectorRuntimeAdapterDependencies,
  PlatformConnectorRuntimeInvocation,
  PlatformConnectorRuntimeResult,
};

/** Policy/ownership/preflight always precede secret resolution and outbound execution. */
export class PlatformConnectorRuntimeAdapter {
  constructor(private readonly dependencies: PlatformConnectorRuntimeAdapterDependencies) {}

  execute = async (
    invocation: PlatformConnectorRuntimeInvocation,
  ): Promise<PlatformConnectorRuntimeResult> => {
    const admitted = await this.admitInvocation(invocation);
    let journalToken: ConnectorRuntimeJournalToken | undefined;
    let outboundStarted = false;
    try {
      const args = parseArguments(invocation.arguments);
      const credentials = await this.resolveInvocationCredentials(
        invocation,
        admitted.connector,
        admitted.snapshot.proof.publishedRevision,
      );
      // Emergency archive/current-state guard must precede idempotency reservation.
      // A rejected stale manifest must not consume a toolCall key or create a
      // running journal entry that later reconciles as unknown.
      await this.dependencies.assertCurrentPublished?.();
      if (admitted.connector.credentialMode === 'shared_service_account') {
        const reserved = await this.reserveSharedJournal(
          invocation,
          admitted.connector,
          admitted.tool,
          args,
        );
        if (reserved.kind === 'replay') return reserved.result;
        journalToken = reserved.token;
      }
      try {
        // Close the archive race opened between the pre-reservation check and
        // the shared idempotency insert. This remains immediately adjacent to
        // the first possible external side effect.
        await this.dependencies.assertCurrentPublished?.();
      } catch (error) {
        if (journalToken) {
          await this.cancelJournal(journalToken);
          journalToken = undefined;
        }
        throw error;
      }
      if (journalToken) {
        try {
          await this.dependencies.journal.arm(journalToken);
        } catch {
          throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
        }
      }
      outboundStarted = true;
      const response = await this.dependencies.outbound.requestJson({
        body: {
          id: `${invocation.proof.operationId}:${admitted.tool.toolKey}`,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: admitted.tool.toolKey },
        },
        headers: credentials.headers,
        method: 'POST',
        operation: 'runtime',
        secretBearing: credentials.headers !== undefined,
        url: admitted.connector.endpoint,
      });
      const result = parseRuntimeResponse(response.body, credentials.taintedValues);
      const executionResult = {
        confirmation: admitted.confirmation,
        ...result,
        success: true as const,
      };
      if (admitted.connector.credentialMode === 'shared_service_account') {
        await this.finalizeSharedExecution(journalToken!, executionResult);
      }
      return executionResult;
    } catch (error) {
      if (shouldAuditSharedFailure(admitted.connector, outboundStarted, journalToken, error)) {
        try {
          await this.auditShared(invocation, admitted.connector.id, 'failed');
        } catch (auditError) {
          console.error('[connector-runtime] failure audit delivery pending', {
            errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
          });
        }
      }
      if (error instanceof PlatformConnectorContractError) throw error;
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
  };

  private admitInvocation = async (invocation: PlatformConnectorRuntimeInvocation) => {
    const snapshot = await this.dependencies.snapshots.resolveExact(invocation.proof);
    if (snapshot.proof.operationId !== invocation.proof.operationId) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const connector = snapshot.payload.connector;
    const tool = snapshot.payload.tools.find(
      (candidate) => candidate.toolKey === invocation.toolKey,
    );
    if (!tool) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');

    const policyRecord = await this.dependencies.policy.resolve({
      agentId: invocation.agentId,
      connectorId: connector.id,
      connectorKey: connector.key,
      toolKey: tool.toolKey,
      userId: invocation.userId,
    });
    const effectivePolicy = resolveEffectiveConnectorToolPolicy({
      agentAllowed: policyRecord.agentAllowed,
      platformPolicy: tool.platformPolicy,
      userEnabled: policyRecord.userEnabled,
    });
    if (!effectivePolicy.allowed) {
      if (connector.credentialMode === 'shared_service_account') {
        await this.auditShared(invocation, connector.id, 'denied');
      }
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    const confirmation = resolveConnectorConfirmationPolicy({
      legacyRequiresConfirmation: policyRecord.legacyRequiresConfirmation,
      requiresConfirmation: tool.requiresConfirmation,
      riskLevel: tool.riskLevel,
    });
    if (confirmation && !invocation.humanApproved) {
      if (connector.credentialMode === 'shared_service_account') {
        await this.auditShared(invocation, connector.id, 'denied');
      }
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CONFIRMATION_REQUIRED');
    }
    return { confirmation, connector, snapshot, tool };
  };

  private resolveInvocationCredentials = async (
    invocation: PlatformConnectorRuntimeInvocation,
    connector: Awaited<ReturnType<PlatformConnectorRuntimeAdapter['admitInvocation']>>['connector'],
    publishedRevision: number,
  ): Promise<{ headers: Record<string, string> | undefined; taintedValues: string[] }> => {
    if (connector.credentialMode === 'shared_service_account') {
      return resolveSharedCredentials(this.dependencies, invocation, connector, this.auditShared);
    }
    if (connector.credentialMode === 'per_user_oauth') {
      return resolveOAuthCredentials(this.dependencies, invocation, connector, publishedRevision);
    }
    await this.dependencies.outbound.preflight(connector.endpoint);
    return { headers: undefined, taintedValues: [] };
  };

  private finalizeSharedExecution = async (
    journalToken: ConnectorRuntimeJournalToken,
    executionResult: PlatformConnectorRuntimeResult,
  ) => {
    try {
      await this.completeJournal(journalToken, executionResult);
    } catch (error) {
      console.error('[connector-runtime] terminal result journal pending', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
    }
    try {
      await this.deliverJournalAudit(journalToken);
    } catch (error) {
      console.error('[connector-runtime] terminal audit delivery pending', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  };

  private reserveSharedJournal = async (
    invocation: PlatformConnectorRuntimeInvocation,
    connector: { id: string },
    tool: { toolKey: string },
    args: Record<string, unknown>,
  ): Promise<
    | { kind: 'replay'; result: PlatformConnectorRuntimeResult }
    | { kind: 'reserved'; token: ConnectorRuntimeJournalToken }
  > => {
    const journal = await this.dependencies.journal.begin({
      connectorId: connector.id,
      operationId: invocation.proof.operationId,
      requestFingerprint: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      toolCallId: invocation.toolCallId,
      toolKey: tool.toolKey,
      userId: invocation.userId,
    });
    if (journal.status === 'reserved') {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    if (journal.status === 'replay') {
      if (journal.auditPending) {
        try {
          await this.deliverJournalAudit(journal.token);
        } catch (error) {
          console.error('[connector-runtime] terminal audit reconciliation pending', {
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      }
      return { kind: 'replay', result: journal.result };
    }
    return { kind: 'reserved', token: journal.token };
  };

  private cancelJournal = async (token: ConnectorRuntimeJournalToken): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.dependencies.journal.cancel(token);
        return;
      } catch (error) {
        if (attempt === 2) {
          console.error('[connector-runtime] reserved journal cleanup deferred', {
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      }
    }
    // Preserve the stable business rejection. A best-effort retry can converge
    // immediately; the audit worker also deletes expired `reserved` rows.
    void this.dependencies.journal.cancel(token).catch((error) => {
      console.error('[connector-runtime] deferred reserved journal cleanup pending', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    });
  };

  private completeJournal = async (
    token: ConnectorRuntimeJournalToken,
    result: PlatformConnectorRuntimeResult,
  ): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.dependencies.journal.complete(token, result);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  private deliverJournalAudit = async (token: ConnectorRuntimeJournalToken): Promise<void> => {
    await this.dependencies.journal.deliverAudit(token, (record) =>
      this.dependencies.audit.appendSharedCall(record),
    );
  };

  private auditShared = async (
    invocation: PlatformConnectorRuntimeInvocation,
    connectorId: string,
    outcome: 'admitted' | 'allowed' | 'denied' | 'failed' | 'rate_limited',
  ): Promise<void> => {
    await this.dependencies.audit.appendSharedCall({
      connectorId,
      operationId: invocation.proof.operationId,
      outcome,
      toolKey: invocation.toolKey,
      userId: invocation.userId,
    });
  };
}
