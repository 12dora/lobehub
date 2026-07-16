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

export const ensurePendingM09ServiceSchema = async (db: LobeChatDatabase): Promise<void> => {
  const statements = [
    `ALTER TABLE "platform_connectors" ALTER COLUMN "name" DROP NOT NULL`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "display_name" varchar(200)`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "endpoint" text`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "transport" varchar(16) DEFAULT 'http'`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "oauth_config" jsonb`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "shared_secret_ref" text`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "shared_secret_fingerprint" varchar(256)`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "shared_secret_updated_at" timestamptz`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "oauth_client_secret_ref" text`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "oauth_client_secret_fingerprint" varchar(256)`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "oauth_client_secret_updated_at" timestamptz`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "sort" integer DEFAULT 0 NOT NULL`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "published_resource_type" varchar(64) DEFAULT 'connector' NOT NULL`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "published_revision" integer`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "published_checksum" varchar(64)`,
    `ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "published_at" timestamptz`,
    `ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "display_name" varchar(200)`,
    `ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "description" text`,
    `ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL`,
    `ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL`,
    `ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL`,
    `ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "platform_policy" varchar(16) DEFAULT 'deny' NOT NULL`,
    `ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "risk_level" varchar(16) DEFAULT 'high' NOT NULL`,
    `ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "requires_confirmation" boolean DEFAULT true NOT NULL`,
    `ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "sort" integer DEFAULT 0 NOT NULL`,
    `ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "published_revision" integer`,
    `ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "revision_resource_type" varchar(64) DEFAULT 'connector' NOT NULL`,
    `ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "oauth_token_ref" text`,
    `ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "token_fingerprint" varchar(256)`,
    `ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "scopes" varchar(200)[] DEFAULT ARRAY[]::varchar[] NOT NULL`,
    `ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz`,
    `ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "last_error_category" varchar(32)`,
    `ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL`,
    `CREATE TABLE IF NOT EXISTS "platform_connector_oauth_states" (
      "id" text PRIMARY KEY NOT NULL,
      "state_id" varchar(32) NOT NULL UNIQUE,
      "state_hash" varchar(64) NOT NULL UNIQUE,
      "binding_id" text NOT NULL,
      "user_id" text NOT NULL,
      "connector_id" text NOT NULL,
      "revision_resource_type" varchar(64) DEFAULT 'connector' NOT NULL,
      "published_revision" integer NOT NULL,
      "pkce_verifier_ref" text NOT NULL,
      "redirect_uri" text NOT NULL,
      "return_to" text,
      "scopes" varchar(200)[] DEFAULT ARRAY[]::varchar[] NOT NULL,
      "expires_at" timestamptz NOT NULL,
      "consumed_at" timestamptz,
      "revoked_at" timestamptz,
      "created_at" timestamptz DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS "platform_connector_secrets" (
      "id" text PRIMARY KEY NOT NULL,
      "connector_id" text NOT NULL,
      "slot" varchar(32) NOT NULL,
      "fingerprint" varchar(64) NOT NULL,
      "ref" text NOT NULL UNIQUE,
      "ciphertext" text NOT NULL,
      "key_id" varchar(256) NOT NULL,
      "revision" integer DEFAULT 1 NOT NULL,
      "revoked_at" timestamptz,
      "created_at" timestamptz DEFAULT now() NOT NULL
    )`,
  ];
  for (const statement of statements) await db.execute(sql.raw(statement));
};

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
