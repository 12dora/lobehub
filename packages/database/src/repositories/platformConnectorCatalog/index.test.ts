// @vitest-environment node
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorTools,
  platformResourceRevisions,
  platformUserConnectorBindings,
} from '../../schemas/platform';
import type {
  PlatformConnectorOAuthConfig,
  PlatformConnectorToolJsonSchema,
  PlatformUserConnectorBindingItem,
} from '../../schemas/platform/connectors';
import { users } from '../../schemas/user';
import type { LobeChatDatabase } from '../../type';
import {
  MAX_PLATFORM_CONNECTOR_TOOLS,
  PlatformConnectorCatalogRepository,
  type PlatformConnectorRevisionPayload,
  PlatformUserConnectorBindingRepository,
} from '.';

const serverDB: LobeChatDatabase = await getTestDB();
const catalog = new PlatformConnectorCatalogRepository(serverDB);

const connectorPrefix = 'm09-test-';
const userIds = ['m09-user-a', 'm09-user-b', 'm09-user-c', 'm09-user-d'];

/**
 * Temporary compatibility fixture while M08 owns the next migration sequence.
 * Remove this block when the coordinated M08 + M09 migration is generated.
 */
const ensurePendingM09Schema = async () => {
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
    `CREATE UNIQUE INDEX IF NOT EXISTS "m09_test_revision_provenance_unique"
      ON "platform_resource_revisions" ("resource_type", "resource_id", "revision", "checksum")`,
    `ALTER TABLE "platform_connector_oauth_states" DROP CONSTRAINT IF EXISTS "m09_test_oauth_owner_fk"`,
    `DROP INDEX IF EXISTS "m09_test_binding_owner_unique"`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "m09_test_binding_owner_unique"
      ON "platform_user_connector_bindings" ("id", "user_id", "connector_id")`,
  ];

  for (const statement of statements) await serverDB.execute(sql.raw(statement));
};

const ensurePendingM09Constraints = async () => {
  const statements = [
    `ALTER TABLE "platform_connectors" DROP CONSTRAINT IF EXISTS "m09_test_connector_provenance_fk"`,
    `ALTER TABLE "platform_connectors" ADD CONSTRAINT "m09_test_connector_provenance_fk"
      FOREIGN KEY ("published_resource_type", "id", "published_revision", "published_checksum")
      REFERENCES "platform_resource_revisions" ("resource_type", "resource_id", "revision", "checksum")
      ON DELETE RESTRICT`,
    `ALTER TABLE "platform_connectors" DROP CONSTRAINT IF EXISTS "m09_test_connector_revision_check"`,
    `ALTER TABLE "platform_connectors" ADD CONSTRAINT "m09_test_connector_revision_check"
      CHECK ("revision" >= 0 AND "published_resource_type" = 'connector')`,
    `ALTER TABLE "platform_connectors" DROP CONSTRAINT IF EXISTS "m09_test_connector_pointer_check"`,
    `ALTER TABLE "platform_connectors" ADD CONSTRAINT "m09_test_connector_pointer_check" CHECK ((
      ("published_revision" IS NULL AND "published_checksum" IS NULL AND "published_at" IS NULL)
      OR ("published_revision" > 0 AND "published_checksum" ~ '^[a-f0-9]{64}$' AND "published_at" IS NOT NULL)
    ) AND ("status" <> 'published' OR "published_revision" IS NOT NULL))`,
    `ALTER TABLE "platform_connectors" DROP CONSTRAINT IF EXISTS "m09_test_connector_credential_check"`,
    `ALTER TABLE "platform_connectors" ADD CONSTRAINT "m09_test_connector_credential_check" CHECK (
      ("credential_mode" = 'none'
        AND "shared_secret_ref" IS NULL AND "shared_secret_fingerprint" IS NULL AND "shared_secret_updated_at" IS NULL
        AND "oauth_client_secret_ref" IS NULL AND "oauth_client_secret_fingerprint" IS NULL
        AND "oauth_client_secret_updated_at" IS NULL AND "oauth_config" IS NULL)
      OR ("credential_mode" = 'shared_service_account'
        AND "oauth_client_secret_ref" IS NULL AND "oauth_client_secret_fingerprint" IS NULL
        AND "oauth_client_secret_updated_at" IS NULL AND "oauth_config" IS NULL
        AND (("shared_secret_ref" IS NULL AND "shared_secret_fingerprint" IS NULL AND "shared_secret_updated_at" IS NULL)
          OR ("shared_secret_ref" IS NOT NULL AND "shared_secret_fingerprint" IS NOT NULL
            AND "shared_secret_updated_at" IS NOT NULL)))
      OR ("credential_mode" = 'per_user_oauth'
        AND "shared_secret_ref" IS NULL AND "shared_secret_fingerprint" IS NULL AND "shared_secret_updated_at" IS NULL
        AND "oauth_config" IS NOT NULL
        AND (("oauth_client_secret_ref" IS NULL AND "oauth_client_secret_fingerprint" IS NULL
            AND "oauth_client_secret_updated_at" IS NULL)
          OR ("oauth_client_secret_ref" IS NOT NULL AND "oauth_client_secret_fingerprint" IS NOT NULL
            AND "oauth_client_secret_updated_at" IS NOT NULL)))
    )`,
    `ALTER TABLE "platform_connectors" DROP CONSTRAINT IF EXISTS "m09_test_connector_oauth_config_check"`,
    `ALTER TABLE "platform_connectors" ADD CONSTRAINT "m09_test_connector_oauth_config_check" CHECK (
      "oauth_config" IS NULL OR (jsonb_typeof("oauth_config") = 'object'
        AND octet_length("oauth_config"::text) <= 16384
        AND "oauth_config"::text !~* '"(client_?secret|secret|access_?token|refresh_?token|token|password|authorization)"[[:space:]]*:')
    )`,
    `ALTER TABLE "platform_connector_tools" DROP CONSTRAINT IF EXISTS "m09_test_tool_schema_check"`,
    `ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "m09_test_tool_schema_check" CHECK (
      jsonb_typeof("input_schema") = 'object' AND jsonb_typeof("output_schema") = 'object'
      AND octet_length("input_schema"::text) <= 65536 AND octet_length("output_schema"::text) <= 65536
    )`,
    `ALTER TABLE "platform_connector_tools" DROP CONSTRAINT IF EXISTS "m09_test_tool_confirmation_check"`,
    `ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "m09_test_tool_confirmation_check"
      CHECK ("risk_level" NOT IN ('high', 'critical') OR "requires_confirmation" = true)`,
    `ALTER TABLE "platform_user_connector_bindings" DROP CONSTRAINT IF EXISTS "m09_test_binding_revision_check"`,
    `ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "m09_test_binding_revision_check"
      CHECK ("published_revision" > 0 AND "revision" >= 0 AND "revision_resource_type" = 'connector')`,
    `ALTER TABLE "platform_user_connector_bindings" DROP CONSTRAINT IF EXISTS "m09_test_binding_revision_fk"`,
    `ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "m09_test_binding_revision_fk"
      FOREIGN KEY ("revision_resource_type", "connector_id", "published_revision")
      REFERENCES "platform_resource_revisions" ("resource_type", "resource_id", "revision")
      ON DELETE RESTRICT`,
    `ALTER TABLE "platform_user_connector_bindings" DROP CONSTRAINT IF EXISTS "m09_test_binding_token_pair_check"`,
    `ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "m09_test_binding_token_pair_check" CHECK (
      ("oauth_token_ref" IS NULL AND "token_fingerprint" IS NULL)
      OR ("oauth_token_ref" IS NOT NULL AND "token_fingerprint" IS NOT NULL)
    )`,
    `ALTER TABLE "platform_user_connector_bindings" DROP CONSTRAINT IF EXISTS "m09_test_binding_state_check"`,
    `ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "m09_test_binding_state_check" CHECK (
      ("status" = 'connected' AND "oauth_token_ref" IS NOT NULL AND "token_fingerprint" IS NOT NULL
        AND "connected_at" IS NOT NULL AND "revoked_at" IS NULL)
      OR ("status" = 'revoked' AND "oauth_token_ref" IS NULL AND "token_fingerprint" IS NULL
        AND cardinality("scopes") = 0 AND "revoked_at" IS NOT NULL)
      OR ("status" IN ('disconnected', 'pending') AND "oauth_token_ref" IS NULL
        AND "token_fingerprint" IS NULL AND cardinality("scopes") = 0 AND "revoked_at" IS NULL)
      OR ("status" IN ('expired', 'error') AND "revoked_at" IS NULL)
    )`,
    `ALTER TABLE "platform_user_connector_bindings" DROP CONSTRAINT IF EXISTS "m09_test_binding_revoked_check"`,
    `ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "m09_test_binding_revoked_check" CHECK (
      ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
      OR ("status" <> 'revoked' AND "revoked_at" IS NULL)
    )`,
    `ALTER TABLE "platform_connector_oauth_states" DROP CONSTRAINT IF EXISTS "m09_test_oauth_owner_fk"`,
    `ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "m09_test_oauth_owner_fk"
      FOREIGN KEY ("binding_id", "user_id", "connector_id")
      REFERENCES "platform_user_connector_bindings" ("id", "user_id", "connector_id")
      ON DELETE RESTRICT`,
    `ALTER TABLE "platform_connector_oauth_states" DROP CONSTRAINT IF EXISTS "m09_test_oauth_revision_fk"`,
    `ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "m09_test_oauth_revision_fk"
      FOREIGN KEY ("revision_resource_type", "connector_id", "published_revision")
      REFERENCES "platform_resource_revisions" ("resource_type", "resource_id", "revision")
      ON DELETE RESTRICT`,
    `ALTER TABLE "platform_connector_oauth_states" DROP CONSTRAINT IF EXISTS "m09_test_oauth_revision_check"`,
    `ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "m09_test_oauth_revision_check"
      CHECK ("published_revision" > 0 AND "revision_resource_type" = 'connector')`,
    `ALTER TABLE "platform_connector_oauth_states" DROP CONSTRAINT IF EXISTS "m09_test_oauth_terminal_check"`,
    `ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "m09_test_oauth_terminal_check"
      CHECK ("consumed_at" IS NULL OR "revoked_at" IS NULL)`,
    `ALTER TABLE "platform_connector_oauth_states" DROP CONSTRAINT IF EXISTS "m09_test_oauth_pkce_check"`,
    `ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "m09_test_oauth_pkce_check"
      CHECK ("pkce_verifier_ref" LIKE 'vault://%' OR "pkce_verifier_ref" LIKE 'kms://%')`,
    `ALTER TABLE "platform_connector_oauth_states" DROP CONSTRAINT IF EXISTS "m09_test_oauth_hash_check"`,
    `ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "m09_test_oauth_hash_check"
      CHECK ("state_hash" ~ '^[a-f0-9]{64}$')`,
    `ALTER TABLE "platform_connector_oauth_states" DROP CONSTRAINT IF EXISTS "m09_test_oauth_ttl_check"`,
    `ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "m09_test_oauth_ttl_check"
      CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '10 minutes')`,
  ];

  for (const statement of statements) await serverDB.execute(sql.raw(statement));
};

const cleanup = async () => {
  await serverDB
    .delete(platformConnectorOAuthStates)
    .where(
      or(
        sql`${platformConnectorOAuthStates.id} LIKE 'm09-%'`,
        inArray(platformConnectorOAuthStates.userId, userIds),
      ),
    );
  await serverDB
    .delete(platformUserConnectorBindings)
    .where(inArray(platformUserConnectorBindings.userId, userIds));
  await serverDB
    .delete(platformConnectorTools)
    .where(sql`${platformConnectorTools.connectorId} LIKE ${`${connectorPrefix}%`}`);
  await serverDB
    .delete(platformConnectors)
    .where(sql`${platformConnectors.id} LIKE ${`${connectorPrefix}%`}`);
  await serverDB
    .delete(platformResourceRevisions)
    .where(
      and(
        eq(platformResourceRevisions.resourceType, 'connector'),
        sql`${platformResourceRevisions.resourceId} LIKE ${`${connectorPrefix}%`}`,
      ),
    );
  await serverDB.delete(users).where(inArray(users.id, userIds));
};

const createConnector = async (
  suffix: string,
  credentialMode: 'none' | 'per_user_oauth' = 'none',
) =>
  catalog.createConnector({
    connectorKey: `${connectorPrefix}${suffix}`,
    credentialMode,
    displayName: `Connector ${suffix}`,
    endpoint: 'https://connector.example.test/mcp',
    id: `${connectorPrefix}${suffix}`,
    oauthClientSecretRef:
      credentialMode === 'per_user_oauth' ? `vault://connectors/${suffix}/client-secret` : null,
    oauthClientSecretFingerprint: credentialMode === 'per_user_oauth' ? `sha256:${suffix}` : null,
    oauthClientSecretUpdatedAt:
      credentialMode === 'per_user_oauth' ? new Date('2026-07-17T00:00:00Z') : null,
    oauthConfig:
      credentialMode === 'per_user_oauth'
        ? {
            authorizationEndpoint: 'https://id.example.test/authorize',
            clientId: 'm09-client',
            issuer: 'https://id.example.test',
            redirectUri: 'https://aihub.example.test/oauth/callback',
            scopes: ['read'],
            tokenEndpoint: 'https://id.example.test/token',
          }
        : null,
  });

const revisionPayload = (connectorId: string): PlatformConnectorRevisionPayload => ({
  connector: {
    credentialMode: 'none',
    description: null,
    displayName: 'Published connector',
    enabled: true,
    endpoint: 'https://connector.example.test/mcp',
    id: connectorId,
    key: connectorId,
    oauthClientSecretConfigured: false,
    oauthClientSecretFingerprint: null,
    oauthConfig: null,
    sharedSecretConfigured: false,
    sharedSecretFingerprint: null,
    sort: 0,
    transport: 'http',
  },
  schemaVersion: 'm09-v1',
  tools: [],
});

const ensurePublishedRevision = async (connectorId: string, revision = 1) => {
  await serverDB
    .insert(platformResourceRevisions)
    .values({
      checksum: String(revision).padStart(64, '0'),
      payload: revisionPayload(connectorId),
      publishedAt: new Date(),
      publishedBy: userIds[0],
      resourceId: connectorId,
      resourceType: 'connector',
      revision,
      status: 'published',
    })
    .onConflictDoNothing();
};

const createBinding = async (userId: string, connectorId: string, id: string) => {
  await ensurePublishedRevision(connectorId);
  const repository = new PlatformUserConnectorBindingRepository(serverDB, userId);
  return repository.upsertBinding({
    connectorId,
    id,
    oauthTokenRef: `vault://users/${userId}/connectors/${connectorId}/token`,
    publishedRevision: 1,
    scopes: ['read'],
    status: 'connected',
    tokenFingerprint: `sha256:${userId}`,
    connectedAt: new Date('2026-07-17T00:00:00Z'),
  });
};

const createPublishedOAuthConnector = async (suffix: string) => {
  const connector = await createConnector(suffix, 'per_user_oauth');
  await ensurePublishedRevision(connector.id);
  await catalog.setPublishedPointerCas({
    checksum: '1'.padStart(64, '0'),
    connectorId: connector.id,
    expectedRevision: 0,
    publishedAt: new Date(),
    publishedRevision: 1,
  });
  await serverDB
    .update(platformConnectors)
    .set({ enabled: true })
    .where(eq(platformConnectors.id, connector.id));
  return connector;
};

beforeAll(async () => {
  await ensurePendingM09Schema();
  await cleanup();
  await ensurePendingM09Constraints();
});
beforeEach(async () => {
  await cleanup();
  await serverDB.insert(users).values(userIds.map((id) => ({ id })));
});
afterAll(cleanup);

describe('pending M09 database constraints', () => {
  it('rejects incomplete credential triples and nested OAuth secret keys', async () => {
    await expect(
      catalog.createConnector({
        connectorKey: `${connectorPrefix}none-with-fingerprint`,
        credentialMode: 'none',
        displayName: 'Invalid none',
        endpoint: 'https://connector.example.test/mcp',
        id: `${connectorPrefix}none-with-fingerprint`,
        sharedSecretFingerprint: 'sha256:orphan',
      }),
    ).rejects.toThrow();
    await expect(
      catalog.createConnector({
        connectorKey: `${connectorPrefix}shared-incomplete`,
        credentialMode: 'shared_service_account',
        displayName: 'Invalid shared',
        endpoint: 'https://connector.example.test/mcp',
        id: `${connectorPrefix}shared-incomplete`,
        sharedSecretRef: 'vault://connectors/incomplete',
      }),
    ).rejects.toThrow();
    const oauthConfig = {
      authorizationEndpoint: 'https://id.example.test/authorize',
      clientId: 'm09-client',
      issuer: 'https://id.example.test',
      nested: { clientSecret: 'must-never-enter-json' },
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      tokenEndpoint: 'https://id.example.test/token',
    } as unknown as PlatformConnectorOAuthConfig;
    await expect(
      catalog.createConnector({
        connectorKey: `${connectorPrefix}oauth-sensitive-json`,
        credentialMode: 'per_user_oauth',
        displayName: 'Invalid OAuth JSON',
        endpoint: 'https://connector.example.test/mcp',
        id: `${connectorPrefix}oauth-sensitive-json`,
        oauthConfig,
      }),
    ).rejects.toThrow();
  });

  it('rejects zero/non-hex and cross-revision publication pointers', async () => {
    const connector = await createConnector('invalid-pointer');
    const publishedAt = new Date('2026-07-17T00:00:00Z');
    await catalog.createPublishedRevision({
      checksum: 'a'.repeat(64),
      connectorId: connector.id,
      payload: revisionPayload(connector.id),
      publishedAt,
      publishedBy: userIds[0],
      revision: 1,
    });
    await catalog.createPublishedRevision({
      checksum: 'b'.repeat(64),
      connectorId: connector.id,
      payload: revisionPayload(connector.id),
      publishedAt,
      publishedBy: userIds[0],
      revision: 2,
    });

    await expect(
      serverDB
        .update(platformConnectors)
        .set({
          publishedAt,
          publishedChecksum: 'not-a-checksum',
          publishedRevision: 0,
          status: 'published',
        })
        .where(eq(platformConnectors.id, connector.id)),
    ).rejects.toThrow();
    await expect(
      serverDB
        .update(platformConnectors)
        .set({
          publishedAt,
          publishedChecksum: 'b'.repeat(64),
          publishedRevision: 1,
          status: 'published',
        })
        .where(eq(platformConnectors.id, connector.id)),
    ).rejects.toThrow();
  });

  it('accepts every valid binding state and rejects inconsistent terminal/token fields', async () => {
    const connector = await createConnector('binding-matrix', 'per_user_oauth');
    await ensurePublishedRevision(connector.id);
    const base = {
      connectorId: connector.id,
      publishedRevision: 1,
      userId: userIds[0],
    };
    const validStates: Array<
      Pick<
        PlatformUserConnectorBindingItem,
        'connectedAt' | 'oauthTokenRef' | 'revokedAt' | 'scopes' | 'status' | 'tokenFingerprint'
      >
    > = [
      {
        connectedAt: null,
        oauthTokenRef: null,
        revokedAt: null,
        scopes: [],
        status: 'disconnected',
        tokenFingerprint: null,
      },
      {
        connectedAt: null,
        oauthTokenRef: null,
        revokedAt: null,
        scopes: [],
        status: 'pending',
        tokenFingerprint: null,
      },
      {
        connectedAt: new Date('2026-07-17T00:00:00Z'),
        oauthTokenRef: 'vault://users/m09/token',
        revokedAt: null,
        scopes: ['read'],
        status: 'connected',
        tokenFingerprint: 'sha256:connected',
      },
      {
        connectedAt: new Date('2026-07-17T00:00:00Z'),
        oauthTokenRef: 'kms://users/m09/expired-token',
        revokedAt: null,
        scopes: ['read'],
        status: 'expired',
        tokenFingerprint: 'sha256:expired',
      },
      {
        connectedAt: new Date('2026-07-17T00:00:00Z'),
        oauthTokenRef: null,
        revokedAt: new Date('2026-07-17T00:05:00Z'),
        scopes: [],
        status: 'revoked',
        tokenFingerprint: null,
      },
      {
        connectedAt: null,
        oauthTokenRef: null,
        revokedAt: null,
        scopes: [],
        status: 'error',
        tokenFingerprint: null,
      },
    ];
    for (const [index, state] of validStates.entries()) {
      const id = `m09-matrix-${index}`;
      await expect(
        serverDB.insert(platformUserConnectorBindings).values({ ...base, ...state, id }),
      ).resolves.toBeDefined();
      await serverDB
        .delete(platformUserConnectorBindings)
        .where(eq(platformUserConnectorBindings.id, id));
    }

    await expect(
      serverDB.insert(platformUserConnectorBindings).values({
        ...base,
        id: 'm09-matrix-connected-missing-fingerprint',
        oauthTokenRef: 'vault://users/m09/token',
        scopes: ['read'],
        status: 'connected',
        connectedAt: new Date('2026-07-17T00:00:00Z'),
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformUserConnectorBindings).values({
        ...base,
        id: 'm09-matrix-revoked-missing-time',
        scopes: [],
        status: 'revoked',
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformUserConnectorBindings).values({
        ...base,
        id: 'm09-matrix-zero-revision',
        publishedRevision: 0,
        scopes: [],
        status: 'disconnected',
      }),
    ).rejects.toThrow();
  });

  it('enforces OAuth owner/revision identity and the (0, 10 minute] TTL boundary', async () => {
    const connector = await createConnector('oauth-constraints', 'per_user_oauth');
    await ensurePublishedRevision(connector.id);
    const bindingA = await new PlatformUserConnectorBindingRepository(
      serverDB,
      userIds[0],
    ).upsertBinding({
      connectorId: connector.id,
      id: 'm09-constraint-binding-a',
      publishedRevision: 1,
      scopes: [],
      status: 'pending',
    });
    await new PlatformUserConnectorBindingRepository(serverDB, userIds[1]).upsertBinding({
      connectorId: connector.id,
      id: 'm09-constraint-binding-b',
      publishedRevision: 1,
      scopes: [],
      status: 'pending',
    });
    const createdAt = new Date('2026-07-17T00:00:00Z');
    const stateBase = {
      bindingId: bindingA.id,
      connectorId: connector.id,
      createdAt,
      pkceVerifierRef: 'vault://oauth/constraint/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      userId: userIds[0],
    };

    await expect(
      serverDB.insert(platformConnectorOAuthStates).values({
        ...stateBase,
        expiresAt: new Date('2026-07-17T00:10:00Z'),
        id: 'm09-state-cross-owner',
        stateHash: '1'.repeat(64),
        stateId: 'm09-state-cross-owner',
        userId: userIds[1],
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformConnectorOAuthStates).values({
        ...stateBase,
        expiresAt: new Date('2026-07-17T00:10:00Z'),
        id: 'm09-state-cross-revision',
        publishedRevision: 2,
        stateHash: '2'.repeat(64),
        stateId: 'm09-state-cross-revision',
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformConnectorOAuthStates).values({
        ...stateBase,
        expiresAt: createdAt,
        id: 'm09-state-zero-ttl',
        stateHash: '3'.repeat(64),
        stateId: 'm09-state-zero-ttl',
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformConnectorOAuthStates).values({
        ...stateBase,
        expiresAt: new Date('2026-07-17T00:10:00.001Z'),
        id: 'm09-state-long-ttl',
        stateHash: '4'.repeat(64),
        stateId: 'm09-state-long-ttl',
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformConnectorOAuthStates).values({
        ...stateBase,
        expiresAt: new Date('2026-07-17T00:10:00Z'),
        id: 'm09-state-max-ttl',
        stateHash: '5'.repeat(64),
        stateId: 'm09-state-max-ttl',
      }),
    ).resolves.toBeDefined();
  });

  it('rejects non-object/oversized tool schemas and unsafe confirmation settings', async () => {
    const connector = await createConnector('tool-constraints');
    await expect(
      serverDB.insert(platformConnectorTools).values({
        connectorId: connector.id,
        displayName: 'Array input',
        id: 'm09-tool-array-input',
        inputSchema: [] as unknown as PlatformConnectorToolJsonSchema,
        toolKey: 'array-input',
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformConnectorTools).values({
        connectorId: connector.id,
        displayName: 'Large output',
        id: 'm09-tool-large-output',
        outputSchema: {
          description: 'x'.repeat(65_536),
          type: 'object',
        },
        toolKey: 'large-output',
      }),
    ).rejects.toThrow();
    for (const riskLevel of ['high', 'critical'] as const) {
      await expect(
        serverDB.insert(platformConnectorTools).values({
          connectorId: connector.id,
          displayName: `Unsafe ${riskLevel}`,
          id: `m09-tool-unsafe-${riskLevel}`,
          requiresConfirmation: false,
          riskLevel,
          toolKey: `unsafe-${riskLevel}`,
        }),
      ).rejects.toThrow();
    }
    await expect(
      serverDB.insert(platformConnectorTools).values({
        connectorId: connector.id,
        displayName: 'Low risk',
        id: 'm09-tool-low-risk',
        requiresConfirmation: false,
        riskLevel: 'low',
        toolKey: 'low-risk',
      }),
    ).resolves.toBeDefined();
  });
});

describe('PlatformConnectorCatalogRepository', () => {
  it('bounds connector pagination and uses a stable composite cursor', async () => {
    await serverDB.insert(platformConnectors).values(
      Array.from({ length: 101 }, (_, index) => ({
        connectorKey: `${connectorPrefix}page-${String(index).padStart(3, '0')}`,
        credentialMode: 'none' as const,
        displayName: `Page ${index}`,
        endpoint: 'https://connector.example.test/mcp',
        id: `${connectorPrefix}page-${String(index).padStart(3, '0')}`,
      })),
    );

    const first = await catalog.listConnectors({ limit: 10_000 });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toEqual({
      connectorKey: `${connectorPrefix}page-099`,
      id: `${connectorPrefix}page-099`,
    });
    const second = await catalog.listConnectors({ cursor: first.nextCursor!, limit: 100 });
    expect(second.items.map((item) => item.id)).toEqual([`${connectorPrefix}page-100`]);
    expect(second.nextCursor).toBeNull();
  });

  it('replaces tools with deterministic pagination and enforces the hard bound', async () => {
    const connector = await createConnector('tools');
    await catalog.replaceTools(connector.id, [
      { displayName: 'Zulu', id: 'm09-tool-z', sort: 2, toolKey: 'zulu' },
      { displayName: 'Alpha', id: 'm09-tool-a', sort: 1, toolKey: 'alpha' },
      { displayName: 'Beta', id: 'm09-tool-b', sort: 1, toolKey: 'beta' },
    ]);

    const first = await catalog.listTools({ connectorId: connector.id, limit: 2 });
    expect(first.items.map((item) => item.toolKey)).toEqual(['alpha', 'beta']);
    const second = await catalog.listTools({
      connectorId: connector.id,
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.items.map((item) => item.toolKey)).toEqual(['zulu']);
    await expect(
      catalog.replaceTools(
        connector.id,
        Array.from({ length: MAX_PLATFORM_CONNECTOR_TOOLS + 1 }, (_, index) => ({
          displayName: `Tool ${index}`,
          toolKey: `tool-${index}`,
        })),
      ),
    ).rejects.toThrow('PLATFORM_CONNECTOR_TOOL_LIMIT_EXCEEDED');

    await expect(
      catalog.replaceTools(connector.id, [
        { displayName: 'Duplicate A', id: 'm09-tool-duplicate-a', toolKey: 'duplicate' },
        { displayName: 'Duplicate B', id: 'm09-tool-duplicate-b', toolKey: 'duplicate' },
      ]),
    ).rejects.toThrow();
    const afterRollback = await catalog.listTools({ connectorId: connector.id, limit: 100 });
    expect(afterRollback.items.map((item) => item.toolKey)).toEqual(['alpha', 'beta', 'zulu']);
  });

  it('serializes concurrent full replacements under the connector row lock', async () => {
    const connector = await createConnector('tools-concurrent');
    const replacementA = [
      { displayName: 'A1', id: 'm09-tool-a1', toolKey: 'a1' },
      { displayName: 'A2', id: 'm09-tool-a2', toolKey: 'a2' },
    ];
    const replacementB = [
      { displayName: 'B1', id: 'm09-tool-b1', toolKey: 'b1' },
      { displayName: 'B2', id: 'm09-tool-b2', toolKey: 'b2' },
    ];

    await Promise.all([
      catalog.replaceTools(connector.id, replacementA),
      catalog.replaceTools(connector.id, replacementB),
    ]);
    const result = await catalog.listTools({ connectorId: connector.id, limit: 100 });
    expect([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]).toContainEqual(result.items.map((tool) => tool.toolKey));
    await expect(catalog.replaceTools('m09-test-missing', replacementA)).rejects.toThrow(
      'PLATFORM_CONNECTOR_NOT_FOUND',
    );
  });

  it('uses CAS and resolves runtime from the exact immutable published revision', async () => {
    const connector = await createConnector('runtime');
    const publishedAt = new Date('2026-07-17T00:00:00Z');
    const payload = revisionPayload(connector.id);
    const revision = await catalog.createPublishedRevision({
      checksum: 'a'.repeat(64),
      connectorId: connector.id,
      payload,
      publishedAt,
      publishedBy: userIds[0],
      revision: 1,
    });
    await catalog.createPublishedRevision({
      checksum: 'b'.repeat(64),
      connectorId: connector.id,
      payload: { ...payload, schemaVersion: 'm09-v1' },
      publishedAt,
      publishedBy: userIds[0],
      revision: 2,
    });

    const published = await catalog.setPublishedPointerCas({
      checksum: 'a'.repeat(64),
      connectorId: connector.id,
      expectedRevision: 0,
      publishedAt,
      publishedRevision: 1,
    });
    expect(published?.revision).toBe(1);
    await expect(
      catalog.setPublishedPointerCas({
        checksum: 'b'.repeat(64),
        connectorId: connector.id,
        expectedRevision: 0,
        publishedAt,
        publishedRevision: 2,
      }),
    ).resolves.toBeUndefined();

    const runtime = await catalog.getCurrentPublishedRuntime(connector.id);
    expect(runtime).toEqual({
      payload,
      provenance: {
        checksum: 'a'.repeat(64),
        connectorId: connector.id,
        publishedAt,
        revision: 1,
        revisionId: revision.id,
      },
    });
    await expect(catalog.getPublishedRuntimeRevision(connector.id, 2)).resolves.toMatchObject({
      provenance: { checksum: 'b'.repeat(64), connectorId: connector.id, revision: 2 },
    });
    await expect(
      serverDB
        .update(platformConnectors)
        .set({ publishedChecksum: 'b'.repeat(64) })
        .where(eq(platformConnectors.id, connector.id)),
    ).rejects.toThrow();
    await expect(catalog.getCurrentPublishedRuntime(connector.id)).resolves.toEqual(runtime);
  });

  it('atomically consumes a live OAuth state only once under concurrency', async () => {
    const connector = await createConnector('oauth-state', 'per_user_oauth');
    const binding = await createBinding(userIds[0], connector.id, 'm09-binding-state');
    const userRepository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const stateHash = 'c'.repeat(64);
    await userRepository.createOAuthState({
      bindingId: binding.id,
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      id: 'm09-oauth-state',
      pkceVerifierRef: 'vault://oauth/state/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash,
      stateId: 'm09-state-id',
    });

    const attempts = await Promise.all([
      catalog.consumeOAuthState(stateHash),
      catalog.consumeOAuthState(stateHash),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(attempts.find(Boolean)).toMatchObject({
      consumedAt: expect.any(Date),
      id: 'm09-oauth-state',
    });
    await expect(catalog.consumeOAuthState(stateHash)).resolves.toBeUndefined();
  });

  it('terminates expired OAuth states and rejects already revoked states', async () => {
    const connector = await createConnector('oauth-terminal', 'per_user_oauth');
    const binding = await createBinding(userIds[0], connector.id, 'm09-binding-terminal');
    const createdAt = new Date(Date.now() - 10 * 60 * 1000);
    await serverDB.insert(platformConnectorOAuthStates).values({
      bindingId: binding.id,
      connectorId: connector.id,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
      id: 'm09-expired-state',
      pkceVerifierRef: 'vault://oauth/expired/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash: 'e'.repeat(64),
      stateId: 'm09-expired-state-id',
      userId: userIds[0],
    });
    await serverDB.insert(platformConnectorOAuthStates).values({
      bindingId: binding.id,
      connectorId: connector.id,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 6 * 60 * 1000),
      id: 'm09-revoked-state',
      pkceVerifierRef: 'kms://oauth/revoked/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      revokedAt: new Date(createdAt.getTime() + 60_000),
      stateHash: 'f'.repeat(64),
      stateId: 'm09-revoked-state-id',
      userId: userIds[0],
    });

    await expect(catalog.consumeOAuthState('e'.repeat(64))).resolves.toBeUndefined();
    await expect(catalog.consumeOAuthState('f'.repeat(64))).resolves.toBeUndefined();
    const rows = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(inArray(platformConnectorOAuthStates.id, ['m09-expired-state', 'm09-revoked-state']));
    expect(rows.every((row) => row.consumedAt === null && row.revokedAt instanceof Date)).toBe(
      true,
    );
  });

  it('keeps OAuth state target revision independent while a binding upgrades', async () => {
    const connector = await createConnector('oauth-revision-upgrade', 'per_user_oauth');
    const binding = await createBinding(userIds[0], connector.id, 'm09-binding-revision-upgrade');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    await repository.createOAuthState({
      bindingId: binding.id,
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      id: 'm09-state-revision-one',
      pkceVerifierRef: 'vault://oauth/revision-one/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash: 'b'.repeat(64),
      stateId: 'm09-state-revision-one',
    });
    await ensurePublishedRevision(connector.id, 2);

    await expect(
      repository.updateBindingCas(connector.id, 0, {
        expiresAt: null,
        oauthTokenRef: null,
        publishedRevision: 2,
        revokedAt: null,
        scopes: [],
        status: 'pending',
        tokenFingerprint: null,
      }),
    ).resolves.toMatchObject({ publishedRevision: 2, revision: 1, status: 'pending' });
    await expect(catalog.consumeOAuthState('b'.repeat(64))).resolves.toMatchObject({
      publishedRevision: 1,
    });
    await expect(
      repository.createOAuthState({
        bindingId: binding.id,
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        id: 'm09-state-revision-two',
        pkceVerifierRef: 'vault://oauth/revision-two/pkce',
        publishedRevision: 2,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        stateHash: 'c'.repeat(64),
        stateId: 'm09-state-revision-two',
      }),
    ).resolves.toMatchObject({ publishedRevision: 2 });

    const historical = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.id, 'm09-state-revision-one'));
    expect(historical[0]).toMatchObject({
      consumedAt: expect.any(Date),
      publishedRevision: 1,
      revokedAt: null,
    });
  });

  it('linearizes consume and revoke without leaving a replayable state', async () => {
    const connector = await createConnector('oauth-consume-revoke', 'per_user_oauth');
    const binding = await createBinding(userIds[0], connector.id, 'm09-binding-consume-revoke');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const stateHash = 'd'.repeat(64);
    await repository.createOAuthState({
      bindingId: binding.id,
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      id: 'm09-state-consume-revoke',
      pkceVerifierRef: 'vault://oauth/consume-revoke/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash,
      stateId: 'm09-consume-revoke',
    });

    const [consumed] = await Promise.all([
      catalog.consumeOAuthState(stateHash),
      repository.revokeBinding(connector.id),
    ]);
    const [state] = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.id, 'm09-state-consume-revoke'));
    expect(state).toMatchObject({ consumedAt: null, revokedAt: expect.any(Date) });
    expect(consumed === undefined || consumed.id === state.id).toBe(true);
    await expect(catalog.consumeOAuthState(stateHash)).resolves.toBeUndefined();
    await expect(repository.getBinding(connector.id)).resolves.toMatchObject({ status: 'revoked' });
  });

  it('covers both create/revoke lock orderings without an outstanding post-revoke state', async () => {
    const firstConnector = await createConnector('oauth-create-first', 'per_user_oauth');
    const firstBinding = await createBinding(
      userIds[0],
      firstConnector.id,
      'm09-binding-create-first',
    );
    const firstRepository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    await firstRepository.createOAuthState({
      bindingId: firstBinding.id,
      connectorId: firstConnector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      id: 'm09-state-create-first',
      pkceVerifierRef: 'vault://oauth/create-first/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash: 'e'.repeat(64),
      stateId: 'm09-create-first',
    });
    await firstRepository.revokeBinding(firstConnector.id);

    const secondConnector = await createConnector('oauth-revoke-first', 'per_user_oauth');
    const secondBinding = await createBinding(
      userIds[1],
      secondConnector.id,
      'm09-binding-revoke-first',
    );
    const secondRepository = new PlatformUserConnectorBindingRepository(serverDB, userIds[1]);
    await secondRepository.revokeBinding(secondConnector.id);
    await expect(
      secondRepository.createOAuthState({
        bindingId: secondBinding.id,
        connectorId: secondConnector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        id: 'm09-state-revoke-first',
        pkceVerifierRef: 'vault://oauth/revoke-first/pkce',
        publishedRevision: 1,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        stateHash: 'f'.repeat(64),
        stateId: 'm09-revoke-first',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');

    const states = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(inArray(platformConnectorOAuthStates.bindingId, [firstBinding.id, secondBinding.id]));
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ consumedAt: null, revokedAt: expect.any(Date) });
  });

  it('revokes all bindings in bounded idempotent pages and clears token metadata', async () => {
    const connector = await createConnector('revoke-all', 'per_user_oauth');
    for (const [index, userId] of userIds.entries()) {
      const binding = await createBinding(userId, connector.id, `m09-binding-${index}`);
      await new PlatformUserConnectorBindingRepository(serverDB, userId).createOAuthState({
        bindingId: binding.id,
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        id: `m09-revoke-all-state-${index}`,
        pkceVerifierRef: `vault://oauth/revoke-all/${index}`,
        publishedRevision: 1,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        stateHash: String(index + 6).repeat(64),
        stateId: `m09-revoke-all-${index}`,
      });
    }
    const first = await catalog.revokeAllBindingsPage({
      connectorId: connector.id,
      limit: 2,
    });
    expect(first).toEqual({
      nextCursor: 'm09-binding-1',
      pkceVerifierRefs: ['vault://oauth/revoke-all/0', 'vault://oauth/revoke-all/1'],
      revoked: 2,
      tokenRefs: userIds
        .slice(0, 2)
        .map((userId) => `vault://users/${userId}/connectors/${connector.id}/token`),
    });
    const second = await catalog.revokeAllBindingsPage({
      afterId: first.nextCursor!,
      connectorId: connector.id,
      limit: 2,
    });
    expect(second).toEqual({
      nextCursor: null,
      pkceVerifierRefs: ['vault://oauth/revoke-all/2', 'vault://oauth/revoke-all/3'],
      revoked: 2,
      tokenRefs: userIds
        .slice(2)
        .map((userId) => `vault://users/${userId}/connectors/${connector.id}/token`),
    });
    await expect(
      catalog.revokeAllBindingsPage({ connectorId: connector.id, limit: 100 }),
    ).resolves.toEqual({ nextCursor: null, pkceVerifierRefs: [], revoked: 0, tokenRefs: [] });

    const rows = await serverDB
      .select()
      .from(platformUserConnectorBindings)
      .where(eq(platformUserConnectorBindings.connectorId, connector.id));
    expect(rows).toHaveLength(4);
    expect(
      rows.every(
        (row) =>
          row.expiresAt === null &&
          row.oauthTokenRef === null &&
          row.scopes.length === 0 &&
          row.tokenFingerprint === null,
      ),
    ).toBe(true);
    expect(rows.every((row) => row.status === 'revoked' && row.revision === 1)).toBe(true);
    const states = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.connectorId, connector.id));
    expect(states).toHaveLength(4);
    expect(
      states.every((state) => state.consumedAt === null && state.revokedAt instanceof Date),
    ).toBe(true);
  });
});

describe('PlatformUserConnectorBindingRepository', () => {
  it('never finalizes after a reserved state is disconnected', async () => {
    const connector = await createPublishedOAuthConnector('oauth-reserve-disconnect');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const stateHash = 'b'.repeat(64);
    await repository.prepareOAuthAuthorization({
      bindingId: 'm09-oauth-reserve-disconnect-binding',
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      pkceVerifierRef: 'vault://oauth/reserve-disconnect/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      stateHash,
      stateId: 'b'.repeat(32),
    });
    const reservation = await catalog.reserveOAuthState(stateHash);
    if (reservation.status !== 'reserved') throw new Error('state was not reserved');
    const revoked = await repository.revokeBindingWithPreviousSecret(connector.id);
    expect(revoked?.pkceVerifierRefs).toEqual(['vault://oauth/reserve-disconnect/pkce']);

    await expect(
      repository.finalizeOAuthAuthorization({
        connectedAt: new Date(),
        connectorId: connector.id,
        expiresAt: null,
        expectedBindingRevision: reservation.bindingRevision,
        oauthTokenRef: 'vault://oauth/reserve-disconnect/token',
        publishedRevision: 1,
        reservedAt: reservation.reservedAt,
        scopes: ['read'],
        stateHash,
        tokenFingerprint: 'sha256:reserve-disconnect',
      }),
    ).rejects.toThrow();
    await expect(repository.getBinding(connector.id)).resolves.toMatchObject({
      oauthTokenRef: null,
      status: 'revoked',
    });
    const [state] = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.stateHash, stateHash));
    expect(state).toMatchObject({ consumedAt: null, revokedAt: expect.any(Date) });
  });

  it('never finalizes after admin revokeAll and keeps the shared lock order terminating', async () => {
    const connector = await createPublishedOAuthConnector('oauth-reserve-admin-revoke');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[1]);
    const stateHash = 'c'.repeat(64);
    await repository.prepareOAuthAuthorization({
      bindingId: 'm09-oauth-reserve-admin-binding',
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      pkceVerifierRef: 'vault://oauth/reserve-admin/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      stateHash,
      stateId: 'c'.repeat(32),
    });
    const reservation = await catalog.reserveOAuthState(stateHash);
    if (reservation.status !== 'reserved') throw new Error('state was not reserved');
    const revoked = await catalog.revokeAllBindingsPage({ connectorId: connector.id, limit: 100 });
    expect(revoked).toMatchObject({
      pkceVerifierRefs: ['vault://oauth/reserve-admin/pkce'],
      revoked: 1,
    });

    const finalize = repository.finalizeOAuthAuthorization({
      connectedAt: new Date(),
      connectorId: connector.id,
      expiresAt: null,
      expectedBindingRevision: reservation.bindingRevision,
      oauthTokenRef: 'vault://oauth/reserve-admin/token',
      publishedRevision: 1,
      reservedAt: reservation.reservedAt,
      scopes: ['read'],
      stateHash,
      tokenFingerprint: 'sha256:reserve-admin',
    });
    await expect(
      Promise.race([
        finalize.then(
          () => 'finalized',
          () => 'rejected',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('deadlock'), 2000)),
      ]),
    ).resolves.toBe('rejected');
    await expect(repository.getBinding(connector.id)).resolves.toMatchObject({ status: 'revoked' });
  });

  it('prepares, reserves, releases, finalizes, and revokes one owner-scoped OAuth binding', async () => {
    const connector = await createConnector('oauth-lifecycle', 'per_user_oauth');
    await ensurePublishedRevision(connector.id);
    await catalog.setPublishedPointerCas({
      checksum: '1'.padStart(64, '0'),
      connectorId: connector.id,
      expectedRevision: 0,
      publishedAt: new Date(),
      publishedRevision: 1,
    });
    await serverDB
      .update(platformConnectors)
      .set({ enabled: true })
      .where(eq(platformConnectors.id, connector.id));
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const stateHash = '9'.repeat(64);
    const prepared = await repository.prepareOAuthAuthorization({
      bindingId: 'm09-oauth-lifecycle-binding',
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      pkceVerifierRef: 'vault://oauth/lifecycle/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      stateHash,
      stateId: '9'.repeat(32),
    });
    const binding = prepared.binding;
    expect(binding).toMatchObject({ status: 'pending', userId: userIds[0] });
    await expect(
      new PlatformUserConnectorBindingRepository(serverDB, userIds[1]).getBinding(connector.id),
    ).resolves.toBeUndefined();

    const reservations = await Promise.all([
      catalog.reserveOAuthState(stateHash),
      catalog.reserveOAuthState(stateHash),
    ]);
    const winner = reservations.find((result) => result.status === 'reserved');
    expect(reservations.filter((result) => result.status === 'reserved')).toHaveLength(1);
    expect(reservations.filter((result) => result.status === 'replayed')).toHaveLength(1);
    if (!winner || winner.status !== 'reserved') throw new Error('missing reservation winner');
    await expect(catalog.releaseOAuthStateReservation(stateHash, winner.reservedAt)).resolves.toBe(
      true,
    );
    const retried = await catalog.reserveOAuthState(stateHash);
    if (retried.status !== 'reserved') throw new Error('state was not retryable after release');
    const finalized = await repository.finalizeOAuthAuthorization({
      connectedAt: new Date(),
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 60_000),
      oauthTokenRef: 'vault://oauth/lifecycle/token-v1',
      publishedRevision: 1,
      expectedBindingRevision: retried.bindingRevision,
      reservedAt: retried.reservedAt,
      scopes: ['read'],
      stateHash,
      tokenFingerprint: 'sha256:token-v1',
    });
    expect(finalized).toMatchObject({
      binding: { status: 'connected', userId: userIds[0] },
      previousTokenRef: null,
    });

    await ensurePublishedRevision(connector.id, 2);
    await catalog.setPublishedPointerCas({
      checksum: '2'.padStart(64, '0'),
      connectorId: connector.id,
      expectedRevision: 1,
      publishedAt: new Date(),
      publishedRevision: 2,
    });
    const reauthorization = await repository.prepareOAuthAuthorization({
      bindingId: 'ignored-new-binding-id',
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      pkceVerifierRef: 'vault://oauth/lifecycle/pkce-v2',
      publishedRevision: 2,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      stateHash: '8'.repeat(64),
      stateId: '8'.repeat(32),
    });
    expect(reauthorization.binding).toMatchObject({
      id: binding.id,
      oauthTokenRef: 'vault://oauth/lifecycle/token-v1',
      publishedRevision: 1,
      status: 'connected',
    });
    const [reauthorizationState] = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.stateHash, '8'.repeat(64)));
    expect(reauthorizationState.publishedRevision).toBe(2);

    const revisionTwoReservation = await catalog.reserveOAuthState('8'.repeat(64));
    if (revisionTwoReservation.status !== 'reserved') {
      throw new Error('revision two state was not reservable');
    }
    await expect(
      repository.finalizeOAuthAuthorization({
        connectedAt: new Date(),
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 60_000),
        expectedBindingRevision: revisionTwoReservation.bindingRevision,
        oauthTokenRef: 'vault://oauth/lifecycle/token-v2',
        publishedRevision: 2,
        reservedAt: revisionTwoReservation.reservedAt,
        scopes: ['read'],
        stateHash: '8'.repeat(64),
        tokenFingerprint: 'sha256:token-v2',
      }),
    ).resolves.toMatchObject({
      binding: { oauthTokenRef: 'vault://oauth/lifecycle/token-v2', publishedRevision: 2 },
      previousTokenRef: 'vault://oauth/lifecycle/token-v1',
    });

    await expect(repository.revokeBindingWithPreviousSecret(connector.id)).resolves.toMatchObject({
      binding: { oauthTokenRef: null, status: 'revoked' },
      previousTokenRef: 'vault://oauth/lifecycle/token-v2',
    });
    await expect(repository.revokeBindingWithPreviousSecret(connector.id)).resolves.toBeUndefined();
  });

  it('isolates bindings and OAuth state creation by user ownership', async () => {
    const connector = await createConnector('isolation', 'per_user_oauth');
    const bindingA = await createBinding(userIds[0], connector.id, 'm09-binding-user-a');
    const bindingB = await createBinding(userIds[1], connector.id, 'm09-binding-user-b');
    const repositoryA = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const repositoryB = new PlatformUserConnectorBindingRepository(serverDB, userIds[1]);

    await expect(repositoryA.getBinding(connector.id)).resolves.toMatchObject({ id: bindingA.id });
    await expect(repositoryB.getBinding(connector.id)).resolves.toMatchObject({ id: bindingB.id });
    await expect(
      repositoryA.createOAuthState({
        bindingId: bindingB.id,
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        pkceVerifierRef: 'kms://oauth/pkce',
        publishedRevision: 1,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        stateHash: 'd'.repeat(64),
        stateId: 'm09-cross-user-state',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');

    await repositoryA.createOAuthState({
      bindingId: bindingA.id,
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      id: 'm09-isolation-owned-state',
      pkceVerifierRef: 'vault://oauth/isolation/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash: 'a'.repeat(64),
      stateId: 'm09-isolation-owned',
    });

    await expect(repositoryA.revokeBinding(connector.id)).resolves.toMatchObject({
      oauthTokenRef: null,
      status: 'revoked',
      tokenFingerprint: null,
    });
    await expect(repositoryB.getBinding(connector.id)).resolves.toMatchObject({
      id: bindingB.id,
      status: 'connected',
    });
    const [state] = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.id, 'm09-isolation-owned-state'));
    expect(state).toMatchObject({ consumedAt: null, revokedAt: expect.any(Date) });
  });

  it('fails closed when direct attach entry points receive unknown managed secret handles', async () => {
    const connector = await createPublishedOAuthConnector('managed-attach-proof');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const missingTokenRef = `kms://platform-connectors/${connector.id}/oauthBindingToken/missing`;
    const missingPkceRef = `kms://platform-connectors/${connector.id}/oauthPkceVerifier/missing`;

    await expect(
      repository.upsertBinding({
        connectedAt: new Date(),
        connectorId: connector.id,
        id: 'm09-managed-attach-binding',
        oauthTokenRef: missingTokenRef,
        publishedRevision: 1,
        scopes: ['read'],
        status: 'connected',
        tokenFingerprint: 'sha256:missing',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');

    const binding = await repository.upsertBinding({
      connectorId: connector.id,
      id: 'm09-managed-attach-binding',
      publishedRevision: 1,
      status: 'pending',
    });
    await expect(
      repository.updateBindingCas(connector.id, binding.revision, {
        connectedAt: new Date(),
        oauthTokenRef: missingTokenRef,
        scopes: ['read'],
        status: 'connected',
        tokenFingerprint: 'sha256:missing',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    await expect(
      repository.createOAuthState({
        bindingId: binding.id,
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        pkceVerifierRef: missingPkceRef,
        publishedRevision: 1,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        stateHash: 'c'.repeat(64),
        stateId: 'm09-managed-attach-state',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    await expect(
      repository.prepareOAuthAuthorization({
        bindingId: binding.id,
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        pkceVerifierRef: missingPkceRef,
        publishedRevision: 1,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        scopes: ['read'],
        stateHash: 'b'.repeat(64),
        stateId: 'm09-managed-prepare-state',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  });

  it('applies binding CAS and keeps list pagination bounded and user-scoped', async () => {
    const connectors = await Promise.all([
      createConnector('binding-1', 'per_user_oauth'),
      createConnector('binding-2', 'per_user_oauth'),
    ]);
    await createBinding(userIds[0], connectors[0].id, 'm09-binding-list-1');
    await createBinding(userIds[0], connectors[1].id, 'm09-binding-list-2');
    await createBinding(userIds[1], connectors[0].id, 'm09-binding-list-other');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);

    const updated = await repository.updateBindingCas(connectors[0].id, 0, {
      scopes: ['read', 'write'],
    });
    expect(updated?.revision).toBe(1);
    await expect(
      repository.updateBindingCas(connectors[0].id, 0, { scopes: ['stale'] }),
    ).resolves.toBeUndefined();
    const first = await repository.listBindings({ limit: 1 });
    expect(first.items).toHaveLength(1);
    const second = await repository.listBindings({ cursor: first.nextCursor!, limit: 1000 });
    expect(second.items).toHaveLength(1);
    expect([...first.items, ...second.items].every((item) => item.userId === userIds[0])).toBe(
      true,
    );
  });
});
