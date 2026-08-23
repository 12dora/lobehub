import { eq } from 'drizzle-orm';
import type { z } from 'zod';

import { PlatformRevisionConflictError } from '@/database/models/platform';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import { platformConnectors } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  adminConnectorArchiveInputSchema,
  adminConnectorPublishInputSchema,
  adminConnectorRevokeAllBindingsInputSchema,
  adminConnectorRollbackInputSchema,
} from '../../contracts/platformConnectors';
import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { PlatformPublisherService } from '../platformPublisher';
import type { ConnectorFailureAuditWriter } from './catalogAudit';
import { sanitizeConnectorReason, withConnectorFailureAudit } from './catalogAudit';
import type { ConnectorCatalogLifecycle, ConnectorCatalogSecretStore } from './catalogTypes';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { PlatformConnectorContractError } from './errors';
import {
  acquireConnectorPublicationDependencyLock,
  createConnectorPublicationPointer,
} from './publicationPointer';
import { preflightPublish, preflightRevision } from './publicationPreflight';
import { revokeConnectorBindings, sanitizeEmergencyReason } from './publicationRevoke';
import { invalidateConnectorPublishedIndex } from './publishedIndex';
import { mapRevisionBoundaryError } from './revisionErrors';
import { sanitizeConnectorRevisionPayload } from './revisionPayload';
import { cleanupConnectorSecretRefs } from './secretCleanup';

export { acquireConnectorPublicationDependencyLock };

type PublishInput = z.input<typeof adminConnectorPublishInputSchema>;
type RollbackInput = z.input<typeof adminConnectorRollbackInputSchema>;
type ArchiveInput = z.input<typeof adminConnectorArchiveInputSchema>;
type RevokeAllInput = z.input<typeof adminConnectorRevokeAllBindingsInputSchema>;

export class ConnectorCatalogPublicationService {
  private readonly publisher: PlatformPublisherService;

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly outbound: ConnectorOutboundClient,
    private readonly secrets: ConnectorCatalogSecretStore,
    private readonly lifecycle: ConnectorCatalogLifecycle,
    private readonly invalidation?: PlatformConfigInvalidationPublisher,
    private readonly failureAuditWriter?: ConnectorFailureAuditWriter,
  ) {
    this.publisher = new PlatformPublisherService(db, invalidation);
  }

  private pointer = (
    connectorId: string,
    actorUserId: string,
    proof: Parameters<typeof createConnectorPublicationPointer>[0]['proof'],
  ) =>
    createConnectorPublicationPointer({
      actorUserId,
      connectorId,
      lifecycle: this.lifecycle,
      outbound: this.outbound,
      proof,
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
    return withConnectorFailureAudit(
      this.db,
      {
        action: 'admin.connectors.publish',
        actorUserId,
        mapError: mapRevisionBoundaryError,
        reason,
        targetId: command.id,
        writer: this.failureAuditWriter,
      },
      async () => {
        const proof = await preflightPublish({
          connectorId: command.id,
          db: this.db,
          expectedDraftToken: command.expectedDraftToken,
          outbound: this.outbound,
          secrets: this.secrets,
        });
        await this.lifecycle.afterPublicationPreflight?.(command.id);
        const result = await this.publisher.publish({
          actorUserId,
          expectedRevision: command.expectedRevision,
          invalidationScopes: ['connector-catalog', 'connector-runtime'],
          payload: {},
          pointer: this.pointer(command.id, actorUserId, proof),
          reason,
          resourceId: command.id,
          resourceType: 'connector',
          sanitizePayload: sanitizeConnectorRevisionPayload,
          secretFingerprint: proof.secretFingerprint,
        });
        invalidateConnectorPublishedIndex(this.db, command.id);
        await cleanupConnectorSecretRefs(this.secrets, proof.cleanupRefs, { db: this.db });
        return { auditId: result.auditId, revision: result.revision.revision };
      },
    );
  };

  rollback = async (actorUserId: string, input: RollbackInput) => {
    const command = adminConnectorRollbackInputSchema.parse(input);
    const reason = await sanitizeConnectorReason(this.secrets, command.id, command.reason);
    return withConnectorFailureAudit(
      this.db,
      {
        action: 'admin.connectors.rollback',
        actorUserId,
        mapError: mapRevisionBoundaryError,
        reason,
        targetId: command.id,
        writer: this.failureAuditWriter,
      },
      async () => {
        const proof = await preflightRevision({
          connectorId: command.id,
          db: this.db,
          expectedDraftToken: command.expectedDraftToken,
          mode: 'rollback',
          outbound: this.outbound,
          secrets: this.secrets,
          targetRevision: command.targetRevision,
        });
        await this.lifecycle.afterPublicationPreflight?.(command.id);
        const result = await this.publisher.rollback({
          actorUserId,
          expectedRevision: command.expectedRevision,
          invalidationScopes: ['connector-catalog', 'connector-runtime'],
          pointer: this.pointer(command.id, actorUserId, proof),
          reason,
          resourceId: command.id,
          resourceType: 'connector',
          targetRevision: command.targetRevision,
        });
        invalidateConnectorPublishedIndex(this.db, command.id);
        await cleanupConnectorSecretRefs(this.secrets, proof.cleanupRefs, { db: this.db });
        return { auditId: result.auditId, revision: result.revision.revision };
      },
    );
  };

  archive = async (actorUserId: string, input: ArchiveInput) => {
    const command = adminConnectorArchiveInputSchema.parse(input);
    const reason = await sanitizeEmergencyReason(this.secrets, command.id, command.reason);
    return withConnectorFailureAudit(
      this.db,
      {
        action: 'admin.connectors.archive',
        actorUserId,
        mapError: mapRevisionBoundaryError,
        reason,
        targetId: command.id,
        writer: this.failureAuditWriter,
      },
      async () => {
        const connector = await new PlatformConnectorCatalogRepository(this.db).getConnector(
          command.id,
        );
        if (!connector?.publishedRevision) {
          throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
        }
        const proof = await preflightRevision({
          connectorId: command.id,
          db: this.db,
          expectedDraftToken: command.expectedDraftToken,
          mode: 'archive',
          outbound: this.outbound,
          secrets: this.secrets,
          targetRevision: connector.publishedRevision,
        });
        await this.lifecycle.afterPublicationPreflight?.(command.id);
        const result = await this.publisher.publish({
          actorUserId,
          expectedRevision: command.expectedRevision,
          invalidationScopes: ['connector-catalog', 'connector-runtime'],
          payload: {},
          pointer: this.pointer(command.id, actorUserId, proof),
          reason,
          resourceId: command.id,
          resourceType: 'connector',
          sanitizePayload: sanitizeConnectorRevisionPayload,
          secretFingerprint: proof.secretFingerprint,
          status: 'archived',
        });
        invalidateConnectorPublishedIndex(this.db, command.id);
        await cleanupConnectorSecretRefs(this.secrets, proof.cleanupRefs, { db: this.db });
        return { auditId: result.auditId, revision: result.revision.revision };
      },
    );
  };

  revokeAllBindings = async (actorUserId: string, input: RevokeAllInput) => {
    const command = adminConnectorRevokeAllBindingsInputSchema.parse(input);
    const reason = await sanitizeEmergencyReason(this.secrets, command.id, command.reason);
    return withConnectorFailureAudit(
      this.db,
      {
        action: 'admin.connectors.revokeAllBindings',
        actorUserId,
        reason,
        targetId: command.id,
        writer: this.failureAuditWriter,
      },
      async () => {
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
          const revoked = await revokeConnectorBindings(tx, command.id, this.lifecycle);
          const audit = await new PlatformAuditService(tx).append({
            action: 'admin.connectors.revokeAllBindings',
            actorUserId,
            afterDiff: { revoked: revoked.revoked },
            configRevision: command.expectedRevision,
            reason,
            result: 'success',
            targetId: command.id,
            targetType: 'connector',
          });
          return { auditId: audit.id, ...revoked };
        });
        await cleanupConnectorSecretRefs(this.secrets, result.cleanupRefs, { db: this.db });
        await this.publishInvalidation(command.id, command.expectedRevision);
        return { auditId: result.auditId, revoked: result.revoked };
      },
    );
  };
}
