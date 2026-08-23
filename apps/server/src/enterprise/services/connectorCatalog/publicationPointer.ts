import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import {
  checksumPayload,
  PlatformRevisionConflictError,
  type ResourcePointerAdapter,
} from '@/database/models/platform';
import {
  platformConnectors,
  platformConnectorTools,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { parseConnectorRevisionPayload } from './catalogSnapshot';
import type { ConnectorCatalogLifecycle } from './catalogTypes';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { connectorToolInsertValues, loadConnectorDraft } from './draftService';
import { PlatformConnectorContractError } from './errors';
import type { ConnectorPublicationProof } from './publicationProof';
import { revokeConnectorBindings } from './publicationRevoke';
import { revisionSecretFingerprint } from './revisionPayload';
import { parseDiscoveredConnectorTools } from './toolDefinitionValidator';

/** Shared by the production pointer and the real-PostgreSQL lock probe. */
export const acquireConnectorPublicationDependencyLock = async (
  tx: Transaction,
  connectorId: string,
  lifecycle: ConnectorCatalogLifecycle,
): Promise<void> => {
  await acquirePlatformDependencyPublicationLock(tx);
  await lifecycle.afterPublicationDependencyLock?.(connectorId, tx);
};

export const materializeConnectorRevision = async (params: {
  actorUserId: string;
  connectorId: string;
  lifecycle: ConnectorCatalogLifecycle;
  proof: ConnectorPublicationProof;
  rawPayload: Record<string, unknown>;
  revision: number;
  status: 'archived' | 'published';
  storedSecretFingerprint: string | null;
  tx: Transaction;
}): Promise<void> => {
  const payload = parseConnectorRevisionPayload(params.rawPayload);
  if (
    payload.connector.id !== params.connectorId ||
    checksumPayload(payload) !== params.proof.payloadChecksum ||
    payload.connector.endpoint !== params.proof.endpoint
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  const connector = payload.connector;
  if (revisionSecretFingerprint(payload) !== params.storedSecretFingerprint) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  const { oauth, shared } = params.proof.resolved;
  await params.tx
    .update(platformConnectors)
    .set({
      connectorKey: connector.key,
      credentialMode: connector.credentialMode,
      description: connector.description,
      displayName: connector.displayName,
      enabled: params.status === 'published' && connector.enabled,
      endpoint: connector.endpoint,
      legacyConnectionType: 'http',
      legacyMcpServerUrl: connector.endpoint,
      legacyName: connector.displayName,
      oauthClientSecretFingerprint: oauth?.fingerprint ?? null,
      oauthClientSecretRef: oauth?.ref ?? null,
      oauthClientSecretUpdatedAt: oauth?.updatedAt ?? null,
      oauthConfig: connector.oauthConfig,
      sharedSecretFingerprint: shared?.fingerprint ?? null,
      sharedSecretRef: shared?.ref ?? null,
      sharedSecretUpdatedAt: shared?.updatedAt ?? null,
      sort: connector.sort,
      status: params.status,
      transport: 'http',
      updatedAt: new Date(),
      updatedBy: params.actorUserId,
    })
    .where(eq(platformConnectors.id, params.connectorId));
  await params.tx
    .delete(platformConnectorTools)
    .where(eq(platformConnectorTools.connectorId, params.connectorId));
  if (payload.tools.length > 0) {
    const tools = parseDiscoveredConnectorTools(
      payload.tools.map((tool) => ({ ...tool, enabled: true })),
    );
    await params.tx.insert(platformConnectorTools).values(
      connectorToolInsertValues(
        tools.map((tool) => ({
          ...tool,
          id: randomUUID(),
          outputSchema: tool.outputSchema ?? {},
        })),
      ).map((tool) => ({ ...tool, connectorId: params.connectorId })),
    );
  }
  // Published revisions are immutable operation inputs. Keep a binding pinned
  // to its historical revision alive for already-approved operations; new
  // operations on a newer revision will reject it and require reconnect.
  // Archive is the emergency-stop boundary and revokes every binding.
  if (params.status === 'archived') {
    const revoked = await revokeConnectorBindings(params.tx, params.connectorId, params.lifecycle);
    params.proof.cleanupRefs.push(...revoked.cleanupRefs);
  }
};

const assertLockedPublicationState = async (params: {
  connectorId: string;
  lifecycle: ConnectorCatalogLifecycle;
  outbound: ConnectorOutboundClient;
  proof: ConnectorPublicationProof;
  tx: Transaction;
}) => {
  // lockAndGetRevision has already acquired the connector row lock. Joining
  // the shared dependency protocol here serializes Agent exact validation
  // with every publish, rollback and archive pointer/materialization change.
  await acquireConnectorPublicationDependencyLock(params.tx, params.connectorId, params.lifecycle);
  const detail = await loadConnectorDraft(params.tx, params.connectorId);
  if (detail.draftToken !== params.proof.draftToken) throw new PlatformRevisionConflictError();
  if (params.proof.policyVersion !== null) {
    let currentPolicyVersion: number | string;
    try {
      currentPolicyVersion = params.outbound.getPolicyVersion();
    } catch {
      throw new PlatformRevisionConflictError();
    }
    if (currentPolicyVersion !== params.proof.policyVersion) {
      throw new PlatformRevisionConflictError();
    }
  }
  if (params.proof.targetRevision === null) return;
  const target = await params.tx.query.platformResourceRevisions.findFirst({
    where: and(
      eq(platformResourceRevisions.resourceType, 'connector'),
      eq(platformResourceRevisions.resourceId, params.connectorId),
      eq(platformResourceRevisions.revision, params.proof.targetRevision),
      eq(platformResourceRevisions.status, 'published'),
    ),
  });
  if (
    !target ||
    target.checksum !== params.proof.payloadChecksum ||
    target.secretFingerprint !== params.proof.secretFingerprint ||
    checksumPayload(target.payload) !== params.proof.payloadChecksum ||
    parseConnectorRevisionPayload(target.payload).connector.endpoint !== params.proof.endpoint
  ) {
    throw new PlatformRevisionConflictError();
  }
};

export const createConnectorPublicationPointer = (params: {
  actorUserId: string;
  connectorId: string;
  lifecycle: ConnectorCatalogLifecycle;
  outbound: ConnectorOutboundClient;
  proof: ConnectorPublicationProof;
}): ResourcePointerAdapter => ({
  assertLockedState: async (tx) => {
    await assertLockedPublicationState({
      connectorId: params.connectorId,
      lifecycle: params.lifecycle,
      outbound: params.outbound,
      proof: params.proof,
      tx,
    });
  },
  lockAndGetRevision: async (tx) => {
    const [row] = await tx
      .select({ revision: platformConnectors.revision })
      .from(platformConnectors)
      .where(eq(platformConnectors.id, params.connectorId))
      .limit(1)
      .for('update');
    if (!row) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
    return row.revision;
  },
  materializePublished: async (tx, { payload, revision, secretFingerprint, status }) => {
    await materializeConnectorRevision({
      actorUserId: params.actorUserId,
      connectorId: params.connectorId,
      lifecycle: params.lifecycle,
      proof: params.proof,
      rawPayload: payload,
      revision,
      status: status === 'archived' ? 'archived' : 'published',
      storedSecretFingerprint: secretFingerprint ?? null,
      tx,
    });
  },
  prepareLockedPublish: async () => ({
    afterDiff: params.proof.afterDiff,
    payload: params.proof.payload,
  }),
  updatePointer: async (tx, { revision, status }) => {
    const row = await tx.query.platformResourceRevisions.findFirst({
      where: and(
        eq(platformResourceRevisions.resourceType, 'connector'),
        eq(platformResourceRevisions.resourceId, params.connectorId),
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
        updatedBy: params.actorUserId,
      })
      .where(eq(platformConnectors.id, params.connectorId));
  },
});
