import { createHash } from 'node:crypto';

import { eq, inArray, sql } from 'drizzle-orm';

import {
  platformAuditLogs,
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorSecrets,
  platformConnectorTools,
  platformResourceRevisions,
  platformUserConnectorBindings,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';

import type {
  ConnectorCatalogSecretStore,
  ConnectorResolvedSecret,
  ConnectorSecretSlot,
} from './catalogTypes';

export const cleanupM09ServiceData = async (db: LobeChatDatabase): Promise<void> => {
  await db.delete(platformConnectorOAuthStates);
  await db.delete(platformUserConnectorBindings);
  await db.delete(platformConnectorSecrets);
  await db.delete(platformConnectorTools);
  await db.delete(platformConnectors);
  await db
    .delete(platformResourceRevisions)
    .where(eq(platformResourceRevisions.resourceType, 'connector'));
  await db
    .delete(platformAuditLogs)
    .where(inArray(platformAuditLogs.targetType, ['connector', 'connector_binding']));
  await db.delete(users).where(sql`${users.id} LIKE 'm09-service-user-%'`);
};

export class MemoryConnectorSecretStore implements ConnectorCatalogSecretStore {
  private readonly byFingerprint = new Map<string, ConnectorResolvedSecret>();
  private readonly byRef = new Map<string, unknown>();

  constructor(private readonly db: LobeChatDatabase) {}

  persistSecret = async (params: {
    connectorId: string;
    slot: ConnectorSecretSlot;
    value: unknown;
  }) => {
    const fingerprint = createHash('sha256').update(JSON.stringify(params.value)).digest('hex');
    const ref = `vault://connectors/${params.connectorId}/${params.slot}/${fingerprint}`;
    const resolved = { fingerprint, ref, updatedAt: new Date(), value: params.value };
    this.byFingerprint.set(`${params.connectorId}:${params.slot}:${fingerprint}`, resolved);
    this.byRef.set(ref, params.value);
    return resolved;
  };

  resolveSecretVersion = async (params: {
    connectorId: string;
    fingerprint: string;
    slot: ConnectorSecretSlot;
  }) =>
    this.byFingerprint.get(`${params.connectorId}:${params.slot}:${params.fingerprint}`) ?? null;

  resolveSecretRef = async ({
    connectorId,
    ref,
    slot,
  }: {
    connectorId: string;
    ref: string;
    slot: ConnectorSecretSlot;
  }) => {
    const stored = [...this.byFingerprint.entries()].find(
      ([key, candidate]) => key.startsWith(`${connectorId}:${slot}:`) && candidate.ref === ref,
    )?.[1];
    if (!stored) return null;
    const value = this.byRef.get(ref);
    if (value === undefined) return null;
    return stored ? { ...stored, value } : null;
  };

  revokeSecretRef = async ({
    connectorId,
    ref,
    slot,
  }: {
    connectorId: string;
    ref: string;
    slot: ConnectorSecretSlot;
  }) => {
    for (const [key, value] of this.byFingerprint) {
      if (key.startsWith(`${connectorId}:${slot}:`) && value.ref === ref) {
        this.byFingerprint.delete(key);
        this.byRef.delete(ref);
      }
    }
  };

  loadCurrentSecretSources = async (connectorId: string) => {
    const [connector] = await this.db
      .select({
        oauthClientSecretRef: platformConnectors.oauthClientSecretRef,
        sharedSecretRef: platformConnectors.sharedSecretRef,
      })
      .from(platformConnectors)
      .where(eq(platformConnectors.id, connectorId))
      .limit(1);
    return {
      oauthClientSecret: connector?.oauthClientSecretRef
        ? this.byRef.get(connector.oauthClientSecretRef)
        : undefined,
      sharedSecret: connector?.sharedSecretRef
        ? this.byRef.get(connector.sharedSecretRef)
        : undefined,
    };
  };
}

export const connectorToolFixture = (overrides: Record<string, unknown> = {}) => ({
  description: 'Search safely',
  displayName: 'Search',
  enabled: true,
  inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
  outputSchema: { type: 'object' },
  platformPolicy: 'allow' as const,
  requiresConfirmation: false,
  riskLevel: 'low' as const,
  sort: 0,
  toolKey: 'search.v1',
  ...overrides,
});
