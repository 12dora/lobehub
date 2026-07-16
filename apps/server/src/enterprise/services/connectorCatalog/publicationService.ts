import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';

import {
  PlatformRevisionConflictError,
  type RedactSensitiveOptions,
  type ResourcePointerAdapter,
} from '@/database/models/platform';
import {
  PlatformConnectorCatalogRepository,
  type PlatformConnectorRevisionPayload,
} from '@/database/repositories/platformConnectorCatalog';
import {
  type PlatformConnectorItem,
  platformConnectors,
  platformConnectorTools,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  adminConnectorArchiveInputSchema,
  adminConnectorPublishInputSchema,
  adminConnectorRevokeAllBindingsInputSchema,
  adminConnectorRollbackInputSchema,
} from '../../contracts/platformConnectors';
import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { PlatformPublisherService } from '../platformPublisher';
import { appendConnectorFailureAudit, sanitizeConnectorReason } from './catalogAudit';
import { parseConnectorRevisionPayload, resolveConnectorSecretVersion } from './catalogSnapshot';
import type {
  ConnectorCatalogLifecycle,
  ConnectorCatalogSecretStore,
  ConnectorDraft,
  ConnectorResolvedSecret,
} from './catalogTypes';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { connectorToolInsertValues, loadConnectorDraft } from './draftService';
import { PlatformConnectorContractError } from './errors';
import {
  parseConnectorToolsForWrite,
  parseDiscoveredConnectorTools,
} from './toolDefinitionValidator';

type PublishInput = z.input<typeof adminConnectorPublishInputSchema>;
type RollbackInput = z.input<typeof adminConnectorRollbackInputSchema>;
type ArchiveInput = z.input<typeof adminConnectorArchiveInputSchema>;
type RevokeAllInput = z.input<typeof adminConnectorRevokeAllBindingsInputSchema>;

const M09_REVISION_REDACTION_OPTIONS: RedactSensitiveOptions = {
  isBenignKey: (key) =>
    [
      'credentialmode',
      'oauthclientsecretconfigured',
      'oauthclientsecretfingerprint',
      'sharedsecretconfigured',
      'sharedsecretfingerprint',
    ].includes(key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()),
};

const activeSecretFingerprint = (draft: ConnectorDraft): string | null =>
  draft.credentialMode === 'shared_service_account'
    ? draft.sharedSecret.fingerprint
    : draft.credentialMode === 'per_user_oauth'
      ? draft.oauthClientSecret.fingerprint
      : null;

const revisionPayload = (
  connector: PlatformConnectorItem,
  draft: ConnectorDraft,
): PlatformConnectorRevisionPayload =>
  parseConnectorRevisionPayload({
    connector: {
      credentialMode: draft.credentialMode,
      description: draft.description,
      displayName: draft.displayName,
      enabled: draft.enabled,
      endpoint: draft.endpoint,
      id: draft.id,
      key: draft.key,
      oauthClientSecretConfigured: connector.oauthClientSecretRef !== null,
      oauthClientSecretFingerprint: connector.oauthClientSecretFingerprint,
      oauthConfig: draft.oauthConfig,
      sharedSecretConfigured: connector.sharedSecretRef !== null,
      sharedSecretFingerprint: connector.sharedSecretFingerprint,
      sort: draft.sort,
      transport: 'http',
    },
    schemaVersion: 'm09-v1',
    tools: draft.tools
      .filter((tool) => tool.enabled)
      .map((tool) => ({
        description: tool.description,
        displayName: tool.displayName,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        platformPolicy: tool.platformPolicy,
        requiresConfirmation: tool.requiresConfirmation,
        riskLevel: tool.riskLevel,
        sort: tool.sort,
        toolKey: tool.toolKey,
      })),
  });

export class ConnectorCatalogPublicationService {
  private readonly publisher: PlatformPublisherService;

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly outbound: ConnectorOutboundClient,
    private readonly secrets: ConnectorCatalogSecretStore,
    private readonly lifecycle: ConnectorCatalogLifecycle,
    private readonly invalidation?: PlatformConfigInvalidationPublisher,
  ) {
    this.publisher = new PlatformPublisherService(db, invalidation);
  }

  private assertSecretVersionAvailable = async (
    connectorId: string,
    draft: ConnectorDraft,
  ): Promise<void> => {
    if (draft.credentialMode === 'shared_service_account') {
      await resolveConnectorSecretVersion(
        this.secrets,
        connectorId,
        'sharedSecret',
        draft.sharedSecret.fingerprint,
      );
    } else if (draft.credentialMode === 'per_user_oauth' && draft.oauthClientSecret.configured) {
      await resolveConnectorSecretVersion(
        this.secrets,
        connectorId,
        'oauthClientSecret',
        draft.oauthClientSecret.fingerprint,
      );
    }
  };

  private assertPublishable = async (
    tx: Transaction,
    connectorId: string,
    expectedDraftToken: string,
  ): Promise<{ connector: PlatformConnectorItem; draft: ConnectorDraft }> => {
    const repository = new PlatformConnectorCatalogRepository(tx);
    const connector = await repository.getConnector(connectorId);
    if (!connector) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
    const detail = await loadConnectorDraft(tx, connectorId);
    if (detail.draftToken !== expectedDraftToken) throw new PlatformRevisionConflictError();
    await this.outbound.assertAllowed(detail.draft.endpoint);
    parseConnectorToolsForWrite(detail.draft.tools);
    if (!detail.draft.enabled || !detail.draft.tools.some((tool) => tool.enabled)) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    await this.assertSecretVersionAvailable(connectorId, detail.draft);
    return { connector, draft: detail.draft };
  };

  private resolvePayloadSecrets = async (
    payload: PlatformConnectorRevisionPayload,
  ): Promise<{
    oauth: ConnectorResolvedSecret | null;
    shared: ConnectorResolvedSecret | null;
  }> => {
    const connector = payload.connector;
    const oauth = connector.oauthClientSecretConfigured
      ? await resolveConnectorSecretVersion(
          this.secrets,
          connector.id,
          'oauthClientSecret',
          connector.oauthClientSecretFingerprint,
        )
      : null;
    const shared = connector.sharedSecretConfigured
      ? await resolveConnectorSecretVersion(
          this.secrets,
          connector.id,
          'sharedSecret',
          connector.sharedSecretFingerprint,
        )
      : null;
    return { oauth, shared };
  };

  private revokeBindings = async (tx: Transaction, connectorId: string): Promise<number> => {
    const repository = new PlatformConnectorCatalogRepository(tx);
    let cursor: string | undefined;
    let revoked = 0;
    do {
      const page = await repository.revokeAllBindingsPage({
        afterId: cursor,
        connectorId,
        limit: 100,
      });
      revoked += page.revoked;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    await this.lifecycle.afterRevokeAll?.(connectorId, tx);
    return revoked;
  };

  private materializeRevision = async (
    tx: Transaction,
    connectorId: string,
    rawPayload: Record<string, unknown>,
    revision: number,
    status: 'archived' | 'published',
    actorUserId: string,
    revisionSecretFingerprint: string | null,
  ): Promise<void> => {
    const payload = parseConnectorRevisionPayload(rawPayload);
    if (payload.connector.id !== connectorId) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const connector = payload.connector;
    const payloadSecretFingerprint =
      connector.credentialMode === 'shared_service_account'
        ? connector.sharedSecretFingerprint
        : connector.credentialMode === 'per_user_oauth'
          ? connector.oauthClientSecretFingerprint
          : null;
    if (payloadSecretFingerprint !== revisionSecretFingerprint) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const { oauth, shared } = await this.resolvePayloadSecrets(payload);
    await tx
      .update(platformConnectors)
      .set({
        connectorKey: connector.key,
        credentialMode: connector.credentialMode,
        description: connector.description,
        displayName: connector.displayName,
        enabled: status === 'published' && connector.enabled,
        endpoint: connector.endpoint,
        oauthClientSecretFingerprint: oauth?.fingerprint ?? null,
        oauthClientSecretRef: oauth?.ref ?? null,
        oauthClientSecretUpdatedAt: oauth?.updatedAt ?? null,
        oauthConfig: connector.oauthConfig,
        sharedSecretFingerprint: shared?.fingerprint ?? null,
        sharedSecretRef: shared?.ref ?? null,
        sharedSecretUpdatedAt: shared?.updatedAt ?? null,
        sort: connector.sort,
        status,
        transport: 'http',
        updatedAt: new Date(),
        updatedBy: actorUserId,
      })
      .where(eq(platformConnectors.id, connectorId));
    await tx
      .delete(platformConnectorTools)
      .where(eq(platformConnectorTools.connectorId, connectorId));
    if (payload.tools.length > 0) {
      const tools = parseDiscoveredConnectorTools(
        payload.tools.map((tool) => ({ ...tool, enabled: true })),
      );
      await tx.insert(platformConnectorTools).values(
        connectorToolInsertValues(
          tools.map((tool) => ({
            ...tool,
            id: randomUUID(),
            outputSchema: tool.outputSchema ?? {},
          })),
        ).map((tool) => ({ ...tool, connectorId })),
      );
    }
    await this.revokeBindings(tx, connectorId);
  };

  private pointer = (
    connectorId: string,
    actorUserId: string,
    expectedDraftToken: string,
    mode: 'archive' | 'publish' | 'rollback',
  ): ResourcePointerAdapter => ({
    assertLockedState: async (tx) => {
      await this.lifecycle.afterPublishLock?.(tx);
      const detail = await loadConnectorDraft(tx, connectorId);
      if (detail.draftToken !== expectedDraftToken) throw new PlatformRevisionConflictError();
    },
    lockAndGetRevision: async (tx) => {
      const [row] = await tx
        .select({ revision: platformConnectors.revision })
        .from(platformConnectors)
        .where(eq(platformConnectors.id, connectorId))
        .limit(1)
        .for('update');
      if (!row) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
      return row.revision;
    },
    materializePublished: async (tx, { payload, revision, secretFingerprint, status }) => {
      await this.materializeRevision(
        tx,
        connectorId,
        payload,
        revision,
        status === 'archived' ? 'archived' : 'published',
        actorUserId,
        secretFingerprint ?? null,
      );
    },
    prepareLockedPublish: async (tx) => {
      if (mode === 'archive') {
        const current = await new PlatformConnectorCatalogRepository(tx).getCurrentPublishedRuntime(
          connectorId,
        );
        if (!current) {
          throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
        }
        return { afterDiff: { connectorId, status: 'archived' }, payload: current.payload };
      }
      const { connector, draft } = await this.assertPublishable(
        tx,
        connectorId,
        expectedDraftToken,
      );
      return {
        afterDiff: {
          connectorId,
          credentialMode: draft.credentialMode,
          toolCount: draft.tools.filter((tool) => tool.enabled).length,
        },
        payload: revisionPayload(connector, draft),
      };
    },
    updatePointer: async (tx, { revision, status }) => {
      const row = await tx.query.platformResourceRevisions.findFirst({
        where: and(
          eq(platformResourceRevisions.resourceType, 'connector'),
          eq(platformResourceRevisions.resourceId, connectorId),
          eq(platformResourceRevisions.revision, revision),
        ),
      });
      if (!row) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
      await tx
        .update(platformConnectors)
        .set({
          publishedAt: row.publishedAt ?? row.createdAt,
          publishedChecksum: row.checksum,
          publishedRevision: revision,
          revision,
          status: status === 'archived' ? 'archived' : 'published',
          updatedAt: new Date(),
          updatedBy: actorUserId,
        })
        .where(eq(platformConnectors.id, connectorId));
    },
  });

  private publishInvalidation = async (connectorId: string, revision: number): Promise<void> => {
    if (!this.invalidation) return;
    try {
      await this.invalidation.publish({
        at: new Date().toISOString(),
        resourceId: connectorId,
        resourceType: 'connector',
        revision,
        scopes: ['connector-bindings', 'connector-runtime'],
      });
    } catch (error) {
      console.error('[connectorCatalog] invalidation delivery failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
        resourceId: connectorId,
        resourceType: 'connector',
        revision,
      });
    }
  };

  publish = async (actorUserId: string, input: PublishInput) => {
    const command = adminConnectorPublishInputSchema.parse(input);
    const reason = await sanitizeConnectorReason(this.secrets, command.id, command.reason);
    try {
      const current = await loadConnectorDraft(this.db, command.id);
      const result = await this.publisher.publish({
        actorUserId,
        expectedRevision: command.expectedRevision,
        invalidationScopes: ['connector-catalog', 'connector-runtime'],
        payload: {},
        pointer: this.pointer(command.id, actorUserId, command.expectedDraftToken, 'publish'),
        reason,
        redactionOptions: M09_REVISION_REDACTION_OPTIONS,
        resourceId: command.id,
        resourceType: 'connector',
        secretFingerprint: activeSecretFingerprint(current.draft),
      });
      return { auditId: result.auditId, revision: result.revision.revision };
    } catch (error) {
      await appendConnectorFailureAudit(this.db, {
        action: 'admin.connectors.publish',
        actorUserId,
        reason,
        targetId: command.id,
      });
      throw error;
    }
  };

  rollback = async (actorUserId: string, input: RollbackInput) => {
    const command = adminConnectorRollbackInputSchema.parse(input);
    const reason = await sanitizeConnectorReason(this.secrets, command.id, command.reason);
    try {
      const target = await new PlatformConnectorCatalogRepository(
        this.db,
      ).getPublishedRuntimeRevision(command.id, command.targetRevision);
      if (!target) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
      const result = await this.publisher.rollback({
        actorUserId,
        expectedRevision: command.expectedRevision,
        invalidationScopes: ['connector-catalog', 'connector-runtime'],
        pointer: this.pointer(command.id, actorUserId, command.expectedDraftToken, 'rollback'),
        reason,
        resourceId: command.id,
        resourceType: 'connector',
        targetRevision: command.targetRevision,
      });
      return { auditId: result.auditId, revision: result.revision.revision };
    } catch (error) {
      await appendConnectorFailureAudit(this.db, {
        action: 'admin.connectors.rollback',
        actorUserId,
        reason,
        targetId: command.id,
      });
      throw error;
    }
  };

  archive = async (actorUserId: string, input: ArchiveInput) => {
    const command = adminConnectorArchiveInputSchema.parse(input);
    const reason = await sanitizeConnectorReason(this.secrets, command.id, command.reason);
    try {
      const current = await loadConnectorDraft(this.db, command.id);
      const result = await this.publisher.publish({
        actorUserId,
        expectedRevision: command.expectedRevision,
        invalidationScopes: ['connector-catalog', 'connector-runtime'],
        payload: {},
        pointer: this.pointer(command.id, actorUserId, command.expectedDraftToken, 'archive'),
        reason,
        redactionOptions: M09_REVISION_REDACTION_OPTIONS,
        resourceId: command.id,
        resourceType: 'connector',
        secretFingerprint: activeSecretFingerprint(current.draft),
        status: 'archived',
      });
      return { auditId: result.auditId, revision: result.revision.revision };
    } catch (error) {
      await appendConnectorFailureAudit(this.db, {
        action: 'admin.connectors.archive',
        actorUserId,
        reason,
        targetId: command.id,
      });
      throw error;
    }
  };

  revokeAllBindings = async (actorUserId: string, input: RevokeAllInput) => {
    const command = adminConnectorRevokeAllBindingsInputSchema.parse(input);
    const reason = await sanitizeConnectorReason(this.secrets, command.id, command.reason);
    try {
      const result = await this.db.transaction(async (tx) => {
        const [connector] = await tx
          .select()
          .from(platformConnectors)
          .where(eq(platformConnectors.id, command.id))
          .limit(1)
          .for('update');
        if (!connector) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
        if (connector.publishedRevision !== command.expectedRevision) {
          throw new PlatformRevisionConflictError();
        }
        const revoked = await this.revokeBindings(tx, command.id);
        const audit = await new PlatformAuditService(tx).append({
          action: 'admin.connectors.revokeAllBindings',
          actorUserId,
          afterDiff: { revoked },
          configRevision: command.expectedRevision,
          reason,
          result: 'success',
          targetId: command.id,
          targetType: 'connector',
        });
        return { auditId: audit.id, revoked };
      });
      await this.publishInvalidation(command.id, command.expectedRevision);
      return result;
    } catch (error) {
      await appendConnectorFailureAudit(this.db, {
        action: 'admin.connectors.revokeAllBindings',
        actorUserId,
        reason,
        targetId: command.id,
      });
      throw error;
    }
  };
}
