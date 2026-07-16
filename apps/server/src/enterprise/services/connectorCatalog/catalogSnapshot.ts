import { isPlainRecord } from '@lobechat/utils/object';
import { z } from 'zod';

import { checksumPayload } from '@/database/models/platform';
import {
  PlatformConnectorCatalogRepository,
  type PlatformConnectorRevisionPayload,
  type PlatformConnectorRuntimeRevision,
} from '@/database/repositories/platformConnectorCatalog';
import type { LobeChatDatabase } from '@/database/type';

import {
  adminConnectorOAuthConfigSchema,
  adminPublishedConnectorSchema,
  connectorCredentialModeSchema,
  connectorSharedCredentialSchema,
  managedConnectorSchema,
  trustedPublishedConnectorSchema,
  webConnectorTransportSchema,
} from '../../contracts/platformConnectors';
import { throwStableConnectorSecretError } from './catalogAudit';
import type {
  ConnectorCatalogSecretStore,
  ConnectorResolvedSecret,
  ConnectorSecretSlot,
} from './catalogTypes';
import { PlatformConnectorContractError } from './errors';
import {
  containsConnectorCredentialMaterial,
  parseDiscoveredConnectorTools,
} from './toolDefinitionValidator';

const MAX_SNAPSHOT_CACHE_ENTRIES = 256;

const revisionConnectorSchema = z
  .object({
    credentialMode: connectorCredentialModeSchema,
    description: z.string().max(4000).nullable(),
    displayName: z.string().min(1).max(200),
    enabled: z.boolean(),
    endpoint: z.string().url().max(4096),
    id: z.string().min(1).max(128),
    key: z.string().min(1).max(64),
    oauthClientSecretConfigured: z.boolean(),
    oauthClientSecretFingerprint: z.string().min(1).max(256).nullable(),
    oauthConfig: adminConnectorOAuthConfigSchema.nullable(),
    sharedSecretConfigured: z.boolean(),
    sharedSecretFingerprint: z.string().min(1).max(256).nullable(),
    sort: z.number().int(),
    transport: webConnectorTransportSchema,
  })
  .strict()
  .superRefine((connector, ctx) => {
    const oauthConfigured = connector.oauthClientSecretFingerprint !== null;
    const sharedConfigured = connector.sharedSecretFingerprint !== null;
    if (
      oauthConfigured !== connector.oauthClientSecretConfigured ||
      sharedConfigured !== connector.sharedSecretConfigured
    ) {
      ctx.addIssue({ code: 'custom', message: 'secret state is inconsistent' });
    }
    const modeValid =
      connector.credentialMode === 'none'
        ? !oauthConfigured && !sharedConfigured && connector.oauthConfig === null
        : connector.credentialMode === 'shared_service_account'
          ? !oauthConfigured && connector.oauthConfig === null && sharedConfigured
          : !sharedConfigured && connector.oauthConfig !== null;
    if (!modeValid) ctx.addIssue({ code: 'custom', message: 'credential mode is inconsistent' });
  });

const snapshotCache = new Map<string, PlatformConnectorRevisionPayload>();

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const cloneSnapshot = (
  payload: PlatformConnectorRevisionPayload,
): PlatformConnectorRevisionPayload => structuredClone(payload);

const rememberSnapshot = (key: string, payload: PlatformConnectorRevisionPayload) => {
  snapshotCache.delete(key);
  snapshotCache.set(key, deepFreeze(cloneSnapshot(payload)));
  while (snapshotCache.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest === undefined) break;
    snapshotCache.delete(oldest);
  }
};

export const clearConnectorCatalogRuntimeCache = (): void => snapshotCache.clear();

const assertRevisionContainsNoCredentialReferences = (value: unknown): void => {
  if (typeof value === 'string') {
    if (containsConnectorCredentialMaterial(value)) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertRevisionContainsNoCredentialReferences);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    assertRevisionContainsNoCredentialReferences(key);
    assertRevisionContainsNoCredentialReferences(child);
  }
};

export const parseConnectorRevisionPayload = (
  payload: Record<string, unknown>,
): PlatformConnectorRevisionPayload => {
  assertRevisionContainsNoCredentialReferences(payload);
  if (
    payload.schemaVersion !== 'm09-v1' ||
    !isPlainRecord(payload.connector) ||
    !Array.isArray(payload.tools) ||
    Object.keys(payload).some((key) => !['connector', 'schemaVersion', 'tools'].includes(key))
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  const connector = revisionConnectorSchema.safeParse(payload.connector);
  if (!connector.success || connector.data.id.length === 0) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  let tools: ReturnType<typeof parseDiscoveredConnectorTools>;
  try {
    tools = parseDiscoveredConnectorTools(
      payload.tools.map((tool) => ({ ...(isPlainRecord(tool) ? tool : {}), enabled: true })),
    );
  } catch {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  return {
    connector: connector.data,
    schemaVersion: 'm09-v1',
    tools: tools.map(({ enabled: _enabled, ...tool }) => ({
      ...tool,
      outputSchema: tool.outputSchema ?? {},
    })),
  };
};

const parseExactSnapshot = (
  snapshot: PlatformConnectorRuntimeRevision,
): PlatformConnectorRevisionPayload => {
  const cacheKey = [
    snapshot.provenance.connectorId,
    snapshot.provenance.revision,
    snapshot.provenance.checksum,
  ].join(':');
  if (checksumPayload(snapshot.payload) !== snapshot.provenance.checksum) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  const cached = snapshotCache.get(cacheKey);
  if (cached) return parseConnectorRevisionPayload(cloneSnapshot(cached));
  const payload = parseConnectorRevisionPayload(snapshot.payload);
  if (payload.connector.id !== snapshot.provenance.connectorId) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  rememberSnapshot(cacheKey, payload);
  return parseConnectorRevisionPayload(cloneSnapshot(payload));
};

const requireSecret = async (
  secrets: ConnectorCatalogSecretStore,
  connectorId: string,
  slot: ConnectorSecretSlot,
  fingerprint: string | null,
): Promise<ConnectorResolvedSecret> => {
  if (!fingerprint) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  const resolved = await (async (): Promise<ConnectorResolvedSecret | null> => {
    try {
      return await secrets.resolveSecretVersion({ connectorId, fingerprint, slot });
    } catch (error) {
      return throwStableConnectorSecretError(error);
    }
  })();
  if (
    !resolved ||
    resolved.fingerprint !== fingerprint ||
    (!resolved.ref.startsWith('vault://') && !resolved.ref.startsWith('kms://'))
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  return resolved;
};

export class ConnectorCatalogReadService {
  private readonly repository: PlatformConnectorCatalogRepository;

  constructor(
    db: LobeChatDatabase,
    private readonly secrets: ConnectorCatalogSecretStore,
  ) {
    this.repository = new PlatformConnectorCatalogRepository(db);
  }

  getSnapshot = async (connectorId: string) => {
    const snapshot = await this.repository.getCurrentPublishedRuntime(connectorId);
    if (!snapshot) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    const payload = parseExactSnapshot(snapshot);
    if (!payload.connector.enabled) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    return { payload, provenance: snapshot.provenance };
  };

  getAdminPublished = async (connectorId: string) => {
    const { payload, provenance } = await this.getSnapshot(connectorId);
    const connector = payload.connector;
    const common = {
      description: connector.description,
      displayName: connector.displayName,
      enabled: connector.enabled,
      endpoint: connector.endpoint,
      id: connector.id,
      key: connector.key,
      publishedAt: provenance.publishedAt,
      publishedRevision: provenance.revision,
      sort: connector.sort,
      tools: payload.tools,
      transport: connector.transport,
    };
    const empty = { configured: false, fingerprint: null, updatedAt: null } as const;
    return adminPublishedConnectorSchema.parse(
      connector.credentialMode === 'none'
        ? {
            ...common,
            credentialMode: 'none',
            oauthClientSecret: empty,
            oauthConfig: null,
            sharedSecret: empty,
          }
        : connector.credentialMode === 'shared_service_account'
          ? {
              ...common,
              credentialMode: 'shared_service_account',
              oauthClientSecret: empty,
              oauthConfig: null,
              sharedSecret: {
                configured: true,
                fingerprint: connector.sharedSecretFingerprint,
                updatedAt: null,
              },
            }
          : {
              ...common,
              credentialMode: 'per_user_oauth',
              oauthClientSecret: {
                configured: connector.oauthClientSecretConfigured,
                fingerprint: connector.oauthClientSecretFingerprint,
                updatedAt: null,
              },
              oauthConfig: connector.oauthConfig,
              sharedSecret: empty,
            },
    );
  };

  getPublicPublished = async (connectorId: string) => {
    const { payload, provenance } = await this.getSnapshot(connectorId);
    const connector = payload.connector;
    return managedConnectorSchema.parse({
      binding: null,
      credentialMode: connector.credentialMode,
      description: connector.description,
      displayName: connector.displayName,
      id: connector.id,
      key: connector.key,
      publishedRevision: provenance.revision,
      tools: payload.tools.map((tool) => ({
        available: tool.platformPolicy === 'allow',
        description: tool.description,
        displayName: tool.displayName,
        requiresConfirmation: tool.requiresConfirmation,
        riskLevel: tool.riskLevel,
        sort: tool.sort,
        toolKey: tool.toolKey,
      })),
    });
  };

  getTrustedPublished = async (connectorId: string) => {
    const { payload, provenance } = await this.getSnapshot(connectorId);
    const connector = payload.connector;
    const base = {
      connectorId,
      endpoint: connector.endpoint,
      publishedRevision: provenance.revision,
      tools: payload.tools.map((tool, index) => ({
        ...tool,
        enabled: true,
        id: `${connectorId}:published:${index}`,
      })),
      transport: connector.transport,
    };
    if (connector.credentialMode === 'none') {
      return trustedPublishedConnectorSchema.parse({ ...base, credentialMode: 'none' });
    }
    if (connector.credentialMode === 'shared_service_account') {
      const secret = await requireSecret(
        this.secrets,
        connectorId,
        'sharedSecret',
        connector.sharedSecretFingerprint,
      );
      try {
        return trustedPublishedConnectorSchema.parse({
          ...base,
          credentialMode: 'shared_service_account',
          credentials: connectorSharedCredentialSchema.parse(secret.value),
        });
      } catch (error) {
        throwStableConnectorSecretError(error);
      }
    }
    return trustedPublishedConnectorSchema.parse({
      ...base,
      allowedScopes: connector.oauthConfig?.scopes ?? [],
      credentialMode: 'per_user_oauth',
    });
  };
}

export const resolveConnectorSecretVersion = requireSecret;
