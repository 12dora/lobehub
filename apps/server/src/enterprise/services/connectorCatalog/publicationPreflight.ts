import { and, eq } from 'drizzle-orm';

import { checksumPayload, PlatformRevisionConflictError } from '@/database/models/platform';
import type { PlatformConnectorRevisionPayload } from '@/database/repositories/platformConnectorCatalog';
import { platformResourceRevisions } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { collectConnectorSecretLeaves } from '../../contracts/platformConnectors';
import { connectorAuditSummary, loadConnectorSecretSourcesSafe } from './catalogAudit';
import { parseConnectorRevisionPayload, resolveConnectorSecretVersion } from './catalogSnapshot';
import type {
  ConnectorCatalogSecretStore,
  ConnectorDraft,
  ConnectorResolvedSecret,
} from './catalogTypes';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { loadConnectorDraft } from './draftService';
import { PlatformConnectorContractError } from './errors';
import type { ConnectorPublicationProof } from './publicationProof';
import {
  assertNoRevisionCredentialMaterial,
  revisionPayload,
  revisionSecretFingerprint,
} from './revisionPayload';
import {
  parseConnectorToolsForWrite,
  parseDiscoveredConnectorTools,
} from './toolDefinitionValidator';

export const prepareRevisionPayload = (
  draft: ConnectorDraft,
  secretLeaves: ReadonlySet<string>,
): PlatformConnectorRevisionPayload => {
  const payload = revisionPayload(draft);
  assertNoRevisionCredentialMaterial(payload, secretLeaves);
  return payload;
};

export const resolvePayloadSecrets = async (
  secrets: ConnectorCatalogSecretStore,
  payload: PlatformConnectorRevisionPayload,
): Promise<{
  oauth: ConnectorResolvedSecret | null;
  shared: ConnectorResolvedSecret | null;
}> => {
  const connector = payload.connector;
  const oauth = connector.oauthClientSecretConfigured
    ? await resolveConnectorSecretVersion(
        secrets,
        connector.id,
        'oauthClientSecret',
        connector.oauthClientSecretFingerprint,
      )
    : null;
  const shared = connector.sharedSecretConfigured
    ? await resolveConnectorSecretVersion(
        secrets,
        connector.id,
        'sharedSecret',
        connector.sharedSecretFingerprint,
      )
    : null;
  return { oauth, shared };
};

export const preflightPublish = async (params: {
  connectorId: string;
  db: LobeChatDatabase;
  expectedDraftToken: string;
  outbound: ConnectorOutboundClient;
  secrets: ConnectorCatalogSecretStore;
}): Promise<ConnectorPublicationProof> => {
  // Single connector select (includes durable connection-test columns) + tools.
  // No request-time DDL, no separate connection-test query, no process-local fallback.
  const detail = await loadConnectorDraft(params.db, params.connectorId);
  if (detail.draftToken !== params.expectedDraftToken) throw new PlatformRevisionConflictError();
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
  const outboundProof = await params.outbound.preflight(detail.draft.endpoint);
  const sources = await loadConnectorSecretSourcesSafe(params.secrets, params.connectorId);
  const payload = prepareRevisionPayload(
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
    resolved: await resolvePayloadSecrets(params.secrets, payload),
    secretFingerprint: revisionSecretFingerprint(payload),
    targetRevision: null,
  };
};

export const preflightRevision = async (params: {
  connectorId: string;
  db: LobeChatDatabase;
  expectedDraftToken: string;
  mode: 'archive' | 'rollback';
  outbound: ConnectorOutboundClient;
  secrets: ConnectorCatalogSecretStore;
  targetRevision: number;
}): Promise<ConnectorPublicationProof> => {
  const detail = await loadConnectorDraft(params.db, params.connectorId);
  if (detail.draftToken !== params.expectedDraftToken) throw new PlatformRevisionConflictError();
  const target = await params.db.query.platformResourceRevisions.findFirst({
    where: and(
      eq(platformResourceRevisions.resourceType, 'connector'),
      eq(platformResourceRevisions.resourceId, params.connectorId),
      eq(platformResourceRevisions.revision, params.targetRevision),
      eq(platformResourceRevisions.status, 'published'),
    ),
  });
  if (!target || checksumPayload(target.payload) !== target.checksum) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  const payload = parseConnectorRevisionPayload(target.payload);
  if (
    payload.connector.id !== params.connectorId ||
    revisionSecretFingerprint(payload) !== target.secretFingerprint
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  let policyVersion: number | string | null = null;
  if (params.mode === 'rollback') {
    parseDiscoveredConnectorTools(payload.tools.map((tool) => ({ ...tool, enabled: true })));
    if (!payload.connector.enabled || payload.tools.length === 0) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    policyVersion = (await params.outbound.preflight(payload.connector.endpoint)).policyVersion;
  }
  return {
    afterDiff:
      params.mode === 'archive'
        ? { connectorId: params.connectorId, status: 'archived' }
        : { restoredFromRevision: params.targetRevision },
    cleanupRefs: [],
    draftToken: detail.draftToken,
    endpoint: payload.connector.endpoint,
    payload,
    payloadChecksum: target.checksum,
    policyVersion,
    resolved:
      params.mode === 'archive'
        ? { oauth: null, shared: null }
        : await resolvePayloadSecrets(params.secrets, payload),
    secretFingerprint: target.secretFingerprint,
    targetRevision: params.targetRevision,
  };
};
