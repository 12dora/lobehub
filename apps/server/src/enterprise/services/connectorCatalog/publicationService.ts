import { randomUUID } from 'node:crypto';

import { isPlainRecord } from '@lobechat/utils/object';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';

import {
  checksumPayload,
  PlatformRevisionConflictError,
  PlatformRevisionImmutableError,
  type ResourcePointerAdapter,
} from '@/database/models/platform';
import {
  PlatformConnectorCatalogRepository,
  type PlatformConnectorRevisionPayload,
} from '@/database/repositories/platformConnectorCatalog';
import {
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
  collectConnectorSecretLeaves,
  containsConnectorCredentialMaterial,
} from '../../contracts/platformConnectors';
import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { PlatformPublisherService } from '../platformPublisher';
import type { ConnectorFailureAuditWriter } from './catalogAudit';
import {
  appendConnectorFailureAudit,
  connectorAuditSummary,
  loadConnectorSecretSourcesSafe,
  sanitizeConnectorReason,
} from './catalogAudit';
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
import { invalidateConnectorPublishedIndex } from './publishedIndex';
import { cleanupConnectorSecretRefs, type ConnectorSecretCleanupRef } from './secretCleanup';
import {
  parseConnectorToolsForWrite,
  parseDiscoveredConnectorTools,
} from './toolDefinitionValidator';

type PublishInput = z.input<typeof adminConnectorPublishInputSchema>;
type RollbackInput = z.input<typeof adminConnectorRollbackInputSchema>;
type ArchiveInput = z.input<typeof adminConnectorArchiveInputSchema>;
type RevokeAllInput = z.input<typeof adminConnectorRevokeAllBindingsInputSchema>;

interface ConnectorPublicationProof {
  afterDiff: Record<string, unknown>;
  cleanupRefs: ConnectorSecretCleanupRef[];
  draftToken: string;
  endpoint: string;
  payload: PlatformConnectorRevisionPayload;
  payloadChecksum: string;
  policyVersion: number | string | null;
  resolved: {
    oauth: ConnectorResolvedSecret | null;
    shared: ConnectorResolvedSecret | null;
  };
  secretFingerprint: string | null;
  targetRevision: number | null;
}

const MAX_REVOKE_BINDINGS = 10_000;
const MAX_REVOKE_PAGES = 100;
const REVOKE_PAGE_SIZE = 100;
const EMERGENCY_STOP_AUDIT_REASON = 'emergency_connector_stop';
const PG_ERROR_SEVERITIES = new Set(['ERROR', 'FATAL', 'PANIC']);
const PG_OBJECT_NOT_IN_PREREQUISITE_STATE = '55000';
const MAX_PG_CAUSE_DEPTH = 5;

const revisionSecretFingerprint = (payload: PlatformConnectorRevisionPayload): string | null =>
  payload.connector.credentialMode === 'shared_service_account'
    ? payload.connector.sharedSecretFingerprint
    : payload.connector.credentialMode === 'per_user_oauth'
      ? payload.connector.oauthClientSecretFingerprint
      : null;

const sanitizeEmergencyReason = async (
  secrets: ConnectorCatalogSecretStore,
  connectorId: string,
  reason: string | null | undefined,
): Promise<string | null> => {
  try {
    return await sanitizeConnectorReason(secrets, connectorId, reason);
  } catch (error) {
    console.error('[connectorCatalog] emergency reason sanitization unavailable', {
      connectorId,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return EMERGENCY_STOP_AUDIT_REASON;
  }
};

/**
 * Revisions are append-only (migration 0145). Any attempt to UPDATE/DELETE a
 * revision row, or a CAS race that surfaces as a PG immutability error, is a
 * revision conflict at the service boundary — never leak raw driver errors.
 */
const mapRevisionBoundaryError = (error: unknown): unknown => {
  if (error instanceof PlatformRevisionConflictError) return error;
  if (error instanceof PlatformRevisionImmutableError) {
    return new PlatformRevisionConflictError();
  }

  let current: unknown = error;
  for (let depth = 0; depth < MAX_PG_CAUSE_DEPTH && current; depth += 1) {
    if (current instanceof PlatformRevisionConflictError) return current;
    if (current instanceof PlatformRevisionImmutableError) {
      return new PlatformRevisionConflictError();
    }

    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      severity?: unknown;
    };
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    const code = typeof candidate.code === 'string' ? candidate.code : undefined;
    const severity = typeof candidate.severity === 'string' ? candidate.severity : undefined;
    const isPg =
      typeof severity === 'string' && PG_ERROR_SEVERITIES.has(severity) && typeof code === 'string';
    if (
      (isPg && code === PG_OBJECT_NOT_IN_PREREQUISITE_STATE) ||
      /platform_resource_revisions are immutable/i.test(message)
    ) {
      return new PlatformRevisionConflictError();
    }
    current = candidate.cause;
  }

  return error;
};

const assertNoRevisionCredentialMaterial = (
  value: unknown,
  secretLeaves: ReadonlySet<string>,
): void => {
  if (typeof value === 'string') {
    if (
      containsConnectorCredentialMaterial(value) ||
      [...secretLeaves].some((secret) => value.includes(secret))
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoRevisionCredentialMaterial(item, secretLeaves));
    return;
  }
  if (!isPlainRecord(value)) return;
  Object.entries(value).forEach(([key, child]) => {
    assertNoRevisionCredentialMaterial(key, secretLeaves);
    assertNoRevisionCredentialMaterial(child, secretLeaves);
  });
};

const revisionPayload = (draft: ConnectorDraft): PlatformConnectorRevisionPayload =>
  parseConnectorRevisionPayload({
    connector: {
      credentialMode: draft.credentialMode,
      description: draft.description,
      displayName: draft.displayName,
      enabled: draft.enabled,
      endpoint: draft.endpoint,
      id: draft.id,
      key: draft.key,
      // Draft slot views already project ref-presence + fingerprints from the connector row.
      oauthClientSecretConfigured: draft.oauthClientSecret.configured,
      oauthClientSecretFingerprint: draft.oauthClientSecret.fingerprint,
      oauthConfig: draft.oauthConfig,
      sharedSecretConfigured: draft.sharedSecret.configured,
      sharedSecretFingerprint: draft.sharedSecret.fingerprint,
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

/**
 * Strict persisted projection. Do not use the generic key-name redactor here:
 * OAuth and JSON Schema deliberately contain semantic names such as
 * `authorizationEndpoint`, `apiKey`, and `password`.
 */
const sanitizeConnectorRevisionPayload = (
  rawPayload: Record<string, unknown>,
): PlatformConnectorRevisionPayload => {
  const payload = parseConnectorRevisionPayload(rawPayload);
  const connector = payload.connector;
  return {
    connector: {
      credentialMode: connector.credentialMode,
      description: connector.description,
      displayName: connector.displayName,
      enabled: connector.enabled,
      endpoint: connector.endpoint,
      id: connector.id,
      key: connector.key,
      oauthClientSecretConfigured: connector.oauthClientSecretConfigured,
      oauthClientSecretFingerprint: connector.oauthClientSecretFingerprint,
      oauthConfig: connector.oauthConfig
        ? {
            authorizationEndpoint: connector.oauthConfig.authorizationEndpoint,
            clientId: connector.oauthConfig.clientId,
            issuer: connector.oauthConfig.issuer,
            redirectUri: connector.oauthConfig.redirectUri,
            scopes: [...connector.oauthConfig.scopes],
            tokenEndpoint: connector.oauthConfig.tokenEndpoint,
          }
        : null,
      sharedSecretConfigured: connector.sharedSecretConfigured,
      sharedSecretFingerprint: connector.sharedSecretFingerprint,
      sort: connector.sort,
      transport: connector.transport,
    },
    schemaVersion: 'm09-v1',
    tools: payload.tools.map((tool) => ({
      description: tool.description,
      displayName: tool.displayName,
      inputSchema: structuredClone(tool.inputSchema),
      outputSchema: structuredClone(tool.outputSchema),
      platformPolicy: tool.platformPolicy,
      requiresConfirmation: tool.requiresConfirmation,
      riskLevel: tool.riskLevel,
      sort: tool.sort,
      toolKey: tool.toolKey,
    })),
  };
};

/** Shared by the production pointer and the real-PostgreSQL lock probe. */
export const acquireConnectorPublicationDependencyLock = async (
  tx: Transaction,
  connectorId: string,
  lifecycle: ConnectorCatalogLifecycle,
): Promise<void> => {
  await acquirePlatformDependencyPublicationLock(tx);
  await lifecycle.afterPublicationDependencyLock?.(connectorId, tx);
};

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

  private prepareRevisionPayload = (
    draft: ConnectorDraft,
    secretLeaves: ReadonlySet<string>,
  ): PlatformConnectorRevisionPayload => {
    const payload = revisionPayload(draft);
    assertNoRevisionCredentialMaterial(payload, secretLeaves);
    return payload;
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

  private preflightPublish = async (
    connectorId: string,
    expectedDraftToken: string,
  ): Promise<ConnectorPublicationProof> => {
    // Single connector select (includes durable connection-test columns) + tools.
    // No request-time DDL, no separate connection-test query, no process-local fallback.
    const detail = await loadConnectorDraft(this.db, connectorId);
    if (detail.draftToken !== expectedDraftToken) throw new PlatformRevisionConflictError();
    parseConnectorToolsForWrite(detail.draft.tools);
    if (!detail.draft.enabled || !detail.draft.tools.some((tool) => tool.enabled)) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    // Fail closed: publish requires a durable, non-stale, non-expired success bound
    // to the exact draft revision + token. Absent/unreadable durable state denies.
    const connectionTest = detail.draft.connectionTest;
    if (
      !connectionTest ||
      connectionTest.status !== 'success' ||
      connectionTest.stale ||
      connectionTest.testedRevision !== detail.draft.revision ||
      connectionTest.testedDraftToken !== detail.draftToken
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const outboundProof = await this.outbound.preflight(detail.draft.endpoint);
    const sources = await loadConnectorSecretSourcesSafe(this.secrets, connectorId);
    const payload = this.prepareRevisionPayload(
      detail.draft,
      collectConnectorSecretLeaves(sources.oauthClientSecret, sources.sharedSecret),
    );
    return {
      afterDiff: { connector: connectorAuditSummary(detail.draft) },
      cleanupRefs: [],
      draftToken: detail.draftToken,
      endpoint: payload.connector.endpoint,
      payload,
      payloadChecksum: checksumPayload(payload),
      policyVersion: outboundProof.policyVersion,
      resolved: await this.resolvePayloadSecrets(payload),
      secretFingerprint: revisionSecretFingerprint(payload),
      targetRevision: null,
    };
  };

  private preflightRevision = async (
    connectorId: string,
    expectedDraftToken: string,
    targetRevision: number,
    mode: 'archive' | 'rollback',
  ): Promise<ConnectorPublicationProof> => {
    const detail = await loadConnectorDraft(this.db, connectorId);
    if (detail.draftToken !== expectedDraftToken) throw new PlatformRevisionConflictError();
    const target = await this.db.query.platformResourceRevisions.findFirst({
      where: and(
        eq(platformResourceRevisions.resourceType, 'connector'),
        eq(platformResourceRevisions.resourceId, connectorId),
        eq(platformResourceRevisions.revision, targetRevision),
        eq(platformResourceRevisions.status, 'published'),
      ),
    });
    if (!target || checksumPayload(target.payload) !== target.checksum) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const payload = parseConnectorRevisionPayload(target.payload);
    if (
      payload.connector.id !== connectorId ||
      revisionSecretFingerprint(payload) !== target.secretFingerprint
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    let policyVersion: number | string | null = null;
    if (mode === 'rollback') {
      parseDiscoveredConnectorTools(payload.tools.map((tool) => ({ ...tool, enabled: true })));
      if (!payload.connector.enabled || payload.tools.length === 0) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
      }
      policyVersion = (await this.outbound.preflight(payload.connector.endpoint)).policyVersion;
    }
    return {
      afterDiff:
        mode === 'archive'
          ? { connectorId, status: 'archived' }
          : { restoredFromRevision: targetRevision },
      cleanupRefs: [],
      draftToken: detail.draftToken,
      endpoint: payload.connector.endpoint,
      payload,
      payloadChecksum: target.checksum,
      policyVersion,
      resolved:
        mode === 'archive'
          ? { oauth: null, shared: null }
          : await this.resolvePayloadSecrets(payload),
      secretFingerprint: target.secretFingerprint,
      targetRevision,
    };
  };

  private revokeBindings = async (
    tx: Transaction,
    connectorId: string,
  ): Promise<{ cleanupRefs: ConnectorSecretCleanupRef[]; revoked: number }> => {
    const repository = new PlatformConnectorCatalogRepository(tx);
    const cleanupRefs: ConnectorSecretCleanupRef[] = [];
    let cursor: string | undefined;
    let revoked = 0;
    const seenCursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < MAX_REVOKE_PAGES; pageIndex += 1) {
      const page = await repository.revokeAllBindingsPage({
        afterId: cursor,
        connectorId,
        limit: REVOKE_PAGE_SIZE,
      });
      revoked += page.revoked;
      cleanupRefs.push(
        ...page.tokenRefs.map((ref) => ({ connectorId, ref, slot: 'oauthBindingToken' as const })),
        ...page.pkceVerifierRefs.map((ref) => ({
          connectorId,
          ref,
          slot: 'oauthPkceVerifier' as const,
        })),
      );
      if (revoked > MAX_REVOKE_BINDINGS) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
      }
      const nextCursor = page.nextCursor ?? undefined;
      if (!nextCursor) {
        await this.lifecycle.afterRevokeAll?.(connectorId, tx);
        return { cleanupRefs, revoked };
      }
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  };

  private materializeRevision = async (
    tx: Transaction,
    connectorId: string,
    rawPayload: Record<string, unknown>,
    revision: number,
    status: 'archived' | 'published',
    actorUserId: string,
    storedSecretFingerprint: string | null,
    proof: ConnectorPublicationProof,
  ): Promise<void> => {
    const payload = parseConnectorRevisionPayload(rawPayload);
    if (
      payload.connector.id !== connectorId ||
      checksumPayload(payload) !== proof.payloadChecksum ||
      payload.connector.endpoint !== proof.endpoint
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const connector = payload.connector;
    if (revisionSecretFingerprint(payload) !== storedSecretFingerprint) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const { oauth, shared } = proof.resolved;
    await tx
      .update(platformConnectors)
      .set({
        connectorKey: connector.key,
        credentialMode: connector.credentialMode,
        description: connector.description,
        displayName: connector.displayName,
        enabled: status === 'published' && connector.enabled,
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
    // Published revisions are immutable operation inputs. Keep a binding pinned
    // to its historical revision alive for already-approved operations; new
    // operations on a newer revision will reject it and require reconnect.
    // Archive is the emergency-stop boundary and revokes every binding.
    if (status === 'archived') {
      const revoked = await this.revokeBindings(tx, connectorId);
      proof.cleanupRefs.push(...revoked.cleanupRefs);
    }
  };

  private pointer = (
    connectorId: string,
    actorUserId: string,
    proof: ConnectorPublicationProof,
  ): ResourcePointerAdapter => ({
    assertLockedState: async (tx) => {
      // lockAndGetRevision has already acquired the connector row lock. Joining
      // the shared dependency protocol here serializes Agent exact validation
      // with every publish, rollback and archive pointer/materialization change.
      await acquireConnectorPublicationDependencyLock(tx, connectorId, this.lifecycle);
      const detail = await loadConnectorDraft(tx, connectorId);
      if (detail.draftToken !== proof.draftToken) throw new PlatformRevisionConflictError();
      if (proof.policyVersion !== null) {
        let currentPolicyVersion: number | string;
        try {
          currentPolicyVersion = this.outbound.getPolicyVersion();
        } catch {
          throw new PlatformRevisionConflictError();
        }
        if (currentPolicyVersion !== proof.policyVersion) {
          throw new PlatformRevisionConflictError();
        }
      }
      if (proof.targetRevision !== null) {
        const target = await tx.query.platformResourceRevisions.findFirst({
          where: and(
            eq(platformResourceRevisions.resourceType, 'connector'),
            eq(platformResourceRevisions.resourceId, connectorId),
            eq(platformResourceRevisions.revision, proof.targetRevision),
            eq(platformResourceRevisions.status, 'published'),
          ),
        });
        if (
          !target ||
          target.checksum !== proof.payloadChecksum ||
          target.secretFingerprint !== proof.secretFingerprint ||
          checksumPayload(target.payload) !== proof.payloadChecksum ||
          parseConnectorRevisionPayload(target.payload).connector.endpoint !== proof.endpoint
        ) {
          throw new PlatformRevisionConflictError();
        }
      }
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
        proof,
      );
    },
    prepareLockedPublish: async () => ({ afterDiff: proof.afterDiff, payload: proof.payload }),
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
      const proof = await this.preflightPublish(command.id, command.expectedDraftToken);
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
    } catch (error) {
      await appendConnectorFailureAudit(
        this.db,
        {
          action: 'admin.connectors.publish',
          actorUserId,
          reason,
          targetId: command.id,
        },
        this.failureAuditWriter,
      );
      throw mapRevisionBoundaryError(error);
    }
  };

  rollback = async (actorUserId: string, input: RollbackInput) => {
    const command = adminConnectorRollbackInputSchema.parse(input);
    const reason = await sanitizeConnectorReason(this.secrets, command.id, command.reason);
    try {
      const proof = await this.preflightRevision(
        command.id,
        command.expectedDraftToken,
        command.targetRevision,
        'rollback',
      );
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
    } catch (error) {
      await appendConnectorFailureAudit(
        this.db,
        {
          action: 'admin.connectors.rollback',
          actorUserId,
          reason,
          targetId: command.id,
        },
        this.failureAuditWriter,
      );
      throw mapRevisionBoundaryError(error);
    }
  };

  archive = async (actorUserId: string, input: ArchiveInput) => {
    const command = adminConnectorArchiveInputSchema.parse(input);
    const reason = await sanitizeEmergencyReason(this.secrets, command.id, command.reason);
    try {
      const connector = await new PlatformConnectorCatalogRepository(this.db).getConnector(
        command.id,
      );
      if (!connector?.publishedRevision) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
      }
      const proof = await this.preflightRevision(
        command.id,
        command.expectedDraftToken,
        connector.publishedRevision,
        'archive',
      );
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
    } catch (error) {
      await appendConnectorFailureAudit(
        this.db,
        {
          action: 'admin.connectors.archive',
          actorUserId,
          reason,
          targetId: command.id,
        },
        this.failureAuditWriter,
      );
      throw mapRevisionBoundaryError(error);
    }
  };

  revokeAllBindings = async (actorUserId: string, input: RevokeAllInput) => {
    const command = adminConnectorRevokeAllBindingsInputSchema.parse(input);
    const reason = await sanitizeEmergencyReason(this.secrets, command.id, command.reason);
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
    } catch (error) {
      await appendConnectorFailureAudit(
        this.db,
        {
          action: 'admin.connectors.revokeAllBindings',
          actorUserId,
          reason,
          targetId: command.id,
        },
        this.failureAuditWriter,
      );
      throw error;
    }
  };
}
