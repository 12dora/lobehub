import { checksumPayload } from '@/database/models/platform';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import type {
  NewPlatformConnectorTool,
  PlatformConnectorItem,
  PlatformConnectorToolItem,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  ConnectorCurrentSecretLoader,
  ConnectorSecretSlotSources,
  TrustedConnectorSecretContext,
} from '../../contracts/platformConnectors';
import {
  adminConnectorDraftSchema,
  loadTrustedConnectorSecretContext,
} from '../../contracts/platformConnectors';
import { throwStableConnectorSecretError } from './catalogAudit';
import type {
  ConnectorDraft,
  ConnectorDraftDetail,
  ConnectorSecretSlot,
  ConnectorStoredSecret,
} from './catalogTypes';
import { projectConnectorConnectionTestFromRow } from './connectionTestState';
import { PlatformConnectorContractError } from './errors';

export const loadTrustedSecretContextSafe = async (
  loader: ConnectorCurrentSecretLoader,
  connectorId: string,
  replacement: ConnectorSecretSlotSources,
): Promise<TrustedConnectorSecretContext> => {
  try {
    return await loadTrustedConnectorSecretContext(loader, connectorId, replacement);
  } catch (error) {
    return throwStableConnectorSecretError(error);
  }
};

export interface PersistedSecretSlots {
  oauthClientSecretFingerprint: string | null;
  oauthClientSecretRef: string | null;
  oauthClientSecretUpdatedAt: Date | null;
  sharedSecretFingerprint: string | null;
  sharedSecretRef: string | null;
  sharedSecretUpdatedAt: Date | null;
}

export const currentSlot = (
  connector: PlatformConnectorItem | undefined,
  slot: ConnectorSecretSlot,
): ConnectorStoredSecret | null => {
  const prefix = slot === 'oauthClientSecret' ? 'oauthClientSecret' : 'sharedSecret';
  const ref = connector?.[`${prefix}Ref`];
  const fingerprint = connector?.[`${prefix}Fingerprint`];
  const updatedAt = connector?.[`${prefix}UpdatedAt`];
  return ref && fingerprint && updatedAt ? { fingerprint, ref, updatedAt } : null;
};

export const toSlotColumns = (
  oauthClientSecret: ConnectorStoredSecret | null,
  sharedSecret: ConnectorStoredSecret | null,
): PersistedSecretSlots => ({
  oauthClientSecretFingerprint: oauthClientSecret?.fingerprint ?? null,
  oauthClientSecretRef: oauthClientSecret?.ref ?? null,
  oauthClientSecretUpdatedAt: oauthClientSecret?.updatedAt ?? null,
  sharedSecretFingerprint: sharedSecret?.fingerprint ?? null,
  sharedSecretRef: sharedSecret?.ref ?? null,
  sharedSecretUpdatedAt: sharedSecret?.updatedAt ?? null,
});

export const assertStoredSecret = (value: ConnectorStoredSecret): ConnectorStoredSecret => {
  if (
    (!value.ref.startsWith('vault://') && !value.ref.startsWith('kms://')) ||
    value.fingerprint.length === 0
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
  return value;
};

/** Connection-test bookkeeping never changes the catalog draft identity. */
export const connectorDraftToken = (draft: ConnectorDraft): string => {
  const { connectionTest: _connectionTest, ...catalogDraft } = draft;
  return checksumPayload({ draft: catalogDraft, revision: draft.revision });
};

export const connectorToolInsertValues = (
  tools: ConnectorDraft['tools'],
): Array<Omit<NewPlatformConnectorTool, 'connectorId'>> =>
  tools.map((tool) => ({
    description: tool.description,
    displayName: tool.displayName,
    enabled: tool.enabled,
    id: tool.id,
    inputSchema: tool.inputSchema,
    legacyAllowUserStricterPolicy: true,
    legacyManifest: {
      description: tool.description ?? undefined,
      inputSchema: tool.inputSchema,
      name: tool.toolKey,
      outputSchema: tool.outputSchema,
    },
    legacyPermissionPolicy: 'needs_approval',
    outputSchema: tool.outputSchema,
    platformPolicy: tool.platformPolicy,
    requiresConfirmation: tool.requiresConfirmation,
    riskLevel: tool.riskLevel,
    sort: tool.sort,
    toolKey: tool.toolKey,
  }));

export const toDraft = (
  connector: PlatformConnectorItem,
  tools: PlatformConnectorToolItem[],
): ConnectorDraft => {
  if (connector.migrationRequired || !connector.endpoint) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  const common = {
    // Token excludes connectionTest; attach after parse so stale/fresh is token-bound.
    connectionTest: null,
    description: connector.description,
    displayName: connector.displayName,
    enabled: connector.enabled,
    endpoint: connector.endpoint,
    id: connector.id,
    key: connector.connectorKey,
    revision: connector.revision,
    sort: connector.sort,
    status: connector.status,
    tools: tools.map((tool) => ({
      description: tool.description,
      displayName: tool.displayName,
      enabled: tool.enabled,
      id: tool.id,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      platformPolicy: tool.platformPolicy,
      requiresConfirmation: tool.requiresConfirmation,
      riskLevel: tool.riskLevel,
      sort: tool.sort,
      toolKey: tool.toolKey,
    })),
    transport: connector.transport,
  } as const;
  const empty = { configured: false, fingerprint: null, updatedAt: null } as const;
  let draft: ConnectorDraft;
  if (connector.credentialMode === 'none') {
    draft = adminConnectorDraftSchema.parse({
      ...common,
      credentialMode: 'none',
      oauthClientSecret: empty,
      oauthConfig: null,
      sharedSecret: empty,
    });
  } else if (connector.credentialMode === 'shared_service_account') {
    draft = adminConnectorDraftSchema.parse({
      ...common,
      credentialMode: 'shared_service_account',
      oauthClientSecret: empty,
      oauthConfig: null,
      sharedSecret: {
        configured: connector.sharedSecretRef !== null,
        fingerprint: connector.sharedSecretFingerprint,
        updatedAt: connector.sharedSecretUpdatedAt,
      },
    });
  } else {
    draft = adminConnectorDraftSchema.parse({
      ...common,
      credentialMode: 'per_user_oauth',
      oauthClientSecret: {
        configured: connector.oauthClientSecretRef !== null,
        fingerprint: connector.oauthClientSecretFingerprint,
        updatedAt: connector.oauthClientSecretUpdatedAt,
      },
      oauthConfig: connector.oauthConfig,
      sharedSecret: empty,
    });
  }
  const draftToken = connectorDraftToken(draft);
  // Durable columns only (multi-instance). Projected from the already-loaded row —
  // no extra query and no process-local authorization fallback.
  const fromRow = projectConnectorConnectionTestFromRow(connector, {
    draftToken,
    revision: draft.revision,
  });
  return fromRow ? { ...draft, connectionTest: fromRow } : draft;
};

const listAllTools = async (
  db: LobeChatDatabase | Transaction,
  connectorId: string,
): Promise<PlatformConnectorToolItem[]> => {
  const repository = new PlatformConnectorCatalogRepository(db);
  const tools: PlatformConnectorToolItem[] = [];
  let cursor: Awaited<ReturnType<typeof repository.listTools>>['nextCursor'] = null;
  do {
    const page = await repository.listTools({
      connectorId,
      cursor: cursor ?? undefined,
      limit: 100,
    });
    tools.push(...page.items);
    if (tools.length > 1000) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
};

export const loadConnectorDraft = async (
  db: LobeChatDatabase | Transaction,
  connectorId: string,
): Promise<ConnectorDraftDetail> => {
  const repository = new PlatformConnectorCatalogRepository(db);
  const connector = await repository.getConnector(connectorId);
  if (!connector) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
  // Single connector read already includes durable connection-test columns.
  const draft = toDraft(connector, await listAllTools(db, connectorId));
  return { draft, draftToken: connectorDraftToken(draft) };
};

/**
 * Bulk draft load: 1 connectors query + 1 tools query.
 * Connection-test state is projected from already-loaded rows (no per-id N+1).
 * Missing ids are absent from the map (caller reports failedIds).
 */
export const loadConnectorDraftsBatch = async (
  db: LobeChatDatabase | Transaction,
  connectorIds: string[],
): Promise<Map<string, ConnectorDraftDetail>> => {
  const result = new Map<string, ConnectorDraftDetail>();
  if (connectorIds.length === 0) return result;

  const repository = new PlatformConnectorCatalogRepository(db);
  const connectors = await repository.getConnectorsByIds(connectorIds);
  if (connectors.length === 0) return result;

  const tools = await repository.listToolsForConnectors(connectors.map((c) => c.id));
  const toolsByConnector = new Map<string, PlatformConnectorToolItem[]>();
  for (const tool of tools) {
    const bucket = toolsByConnector.get(tool.connectorId);
    if (bucket) bucket.push(tool);
    else toolsByConnector.set(tool.connectorId, [tool]);
  }

  for (const connector of connectors) {
    const connectorTools = toolsByConnector.get(connector.id) ?? [];
    if (connectorTools.length > 1000) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    try {
      const draft = toDraft(connector, connectorTools);
      result.set(connector.id, { draft, draftToken: connectorDraftToken(draft) });
    } catch {
      // Invalid / migration-required rows are treated as not found for partial batch success.
    }
  }
  return result;
};
