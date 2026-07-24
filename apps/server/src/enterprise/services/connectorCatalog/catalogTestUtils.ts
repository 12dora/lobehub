import { createHash } from 'node:crypto';

import { eq, inArray, sql } from 'drizzle-orm';

import {
  platformAuditLogs,
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorSecrets,
  platformConnectorTools,
  platformJobs,
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
  // Test harness only — not used on production request paths.
  // Connection-test columns come from migration 0153_round2_connector_test_state.
  // Collect connector ids before child rows go away so revision cleanup stays scoped.
  const connectorRows = await db.select({ id: platformConnectors.id }).from(platformConnectors);
  const connectorIds = connectorRows.map((row) => row.id);

  await db.delete(platformConnectorOAuthStates);
  await db.delete(platformUserConnectorBindings);
  await db.delete(platformConnectorSecrets);
  await db.delete(platformConnectorTools);
  await db.delete(platformJobs).where(eq(platformJobs.type, 'connector.oauth.refresh.v1'));
  await db.delete(platformConnectors);
  // Migration 0145: revisions reject row DELETE. Temporarily disable user triggers in
  // this session so we can remove only connector revision rows (not TRUNCATE the
  // whole table, which would wipe unrelated parallel-suite fixtures).
  if (connectorIds.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL session_replication_role = 'replica'`));
      await tx.execute(sql`
        DELETE FROM platform_resource_revisions
        WHERE resource_type = 'connector'
          AND resource_id IN (${sql.join(
            connectorIds.map((id) => sql`${id}`),
            sql`, `,
          )})
      `);
    });
  }
  // Migration 0145: audit logs are append-only; tests use the session GUC escape hatch.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await tx
      .delete(platformAuditLogs)
      .where(inArray(platformAuditLogs.targetType, ['connector', 'connector_binding']));
  });
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
