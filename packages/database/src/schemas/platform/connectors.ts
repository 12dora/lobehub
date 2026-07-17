import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from '../_helpers';
import { users } from '../user';
import type { PlatformResourceStatus } from './common';
import { platformResourceRevisions } from './revisions';

export type PlatformConnectorCredentialMode = 'none' | 'shared_service_account' | 'per_user_oauth';
export type PlatformConnectorTransport = 'http';
export type PlatformConnectorToolPolicy = 'allow' | 'deny';
export type PlatformConnectorToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PlatformConnectorBindingStatus =
  'disconnected' | 'pending' | 'connected' | 'expired' | 'revoked' | 'error';
export type PlatformConnectorOAuthAuthorizationOutcome = 'completed' | 'failed';
export type PlatformConnectorSecretSlot =
  'oauthBindingToken' | 'oauthClientSecret' | 'oauthPkceVerifier' | 'sharedSecret';

export interface PlatformConnectorOAuthConfig {
  authorizationEndpoint: string;
  clientId: string;
  issuer: string;
  redirectUri: string;
  scopes: string[];
  tokenEndpoint: string;
  userInfoEndpoint?: string;
}

export interface PlatformConnectorToolJsonSchema {
  additionalProperties?: boolean | PlatformConnectorToolJsonSchema;
  allOf?: PlatformConnectorToolJsonSchema[];
  anyOf?: PlatformConnectorToolJsonSchema[];
  const?: unknown;
  default?: unknown;
  description?: string;
  enum?: unknown[];
  examples?: unknown[];
  items?: PlatformConnectorToolJsonSchema | PlatformConnectorToolJsonSchema[];
  oneOf?: PlatformConnectorToolJsonSchema[];
  properties?: Record<string, PlatformConnectorToolJsonSchema>;
  required?: string[];
  title?: string;
  type?: string | string[];
}

/**
 * Mutable Connector Draft identity. Published runtime data is read from the
 * immutable `platform_resource_revisions` row referenced by publishedRevision.
 * Secret columns contain only Vault/KMS references and fingerprints.
 */
export const platformConnectors = pgTable(
  'platform_connectors',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformConnectors', 16))
      .primaryKey()
      .notNull(),
    connectorKey: varchar('connector_key', { length: 128 }).notNull(),
    /** @deprecated M01 compatibility shadow; new writes mirror displayName. */
    legacyName: text('name').notNull(),
    /** @deprecated M01 compatibility discriminator. */
    legacySourceType: varchar('source_type', { length: 32 }).notNull().default('custom'),
    /** @deprecated M01 compatibility transport discriminator. */
    legacyConnectionType: varchar('connection_type', { length: 32 }).notNull().default('http'),
    /** @deprecated M01 compatibility URL; new HTTP writes mirror endpoint. */
    legacyMcpServerUrl: text('mcp_server_url'),
    /** @deprecated M01 stdio configuration; never consumed by managed runtime. */
    legacyMcpStdioConfig: jsonb('mcp_stdio_config'),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    description: text('description'),
    /** Nullable during expand: legacy stdio/incomplete rows have no safe HTTP endpoint. */
    endpoint: text('endpoint'),
    /** Fail-closed marker for legacy rows that need an explicit operator migration. */
    migrationRequired: boolean('migration_required').notNull().default(true),
    transport: varchar('transport', { length: 16 })
      .$type<PlatformConnectorTransport>()
      .notNull()
      .default('http'),
    credentialMode: varchar('credential_mode', { length: 64 })
      .$type<PlatformConnectorCredentialMode>()
      .notNull()
      .default('per_user_oauth'),
    /** @deprecated M01 OIDC payload; never copied into secret-free oauthConfig. */
    legacyOidcConfig: jsonb('oidc_config'),
    /** @deprecated M01 encrypted payload; retained only for compatibility reads. */
    legacyEncryptedSharedCredentials: text('encrypted_shared_credentials'),
    /** @deprecated M01 fingerprint paired with legacy encrypted credentials. */
    legacySecretFingerprint: text('secret_fingerprint'),
    /** @deprecated M01 distribution flag. */
    legacyIsRequired: boolean('is_required').notNull().default(false),
    /** Secret-free OAuth metadata. Client secret lives behind oauthClientSecretRef. */
    oauthConfig: jsonb('oauth_config').$type<PlatformConnectorOAuthConfig>(),
    sharedSecretRef: text('shared_secret_ref'),
    sharedSecretFingerprint: varchar('shared_secret_fingerprint', { length: 256 }),
    sharedSecretUpdatedAt: timestamptz('shared_secret_updated_at'),
    oauthClientSecretRef: text('oauth_client_secret_ref'),
    oauthClientSecretFingerprint: varchar('oauth_client_secret_fingerprint', { length: 256 }),
    oauthClientSecretUpdatedAt: timestamptz('oauth_client_secret_updated_at'),
    enabled: boolean('enabled').notNull().default(false),
    sort: integer('sort').notNull().default(0),
    status: varchar('status', { length: 32 })
      .$type<PlatformResourceStatus>()
      .notNull()
      .default('draft'),
    /** CAS version for Draft mutations. */
    revision: integer('revision').notNull().default(0),
    /** Constant discriminator used by the composite immutable-revision FK. */
    publishedResourceType: varchar('published_resource_type', { length: 64 })
      .$type<'connector'>()
      .notNull()
      .default('connector'),
    /** Exact immutable revision used by runtime; null until first publish. */
    publishedRevision: integer('published_revision'),
    publishedChecksum: varchar('published_checksum', { length: 64 }),
    publishedAt: timestamptz('published_at'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_connectors_connector_key_unique').on(t.connectorKey),
    /** @deprecated M01 compatibility index; remove only in a later contract migration. */
    index('platform_connectors_status_idx').on(t.status),
    foreignKey({
      columns: [t.publishedResourceType, t.id, t.publishedRevision, t.publishedChecksum],
      foreignColumns: [
        platformResourceRevisions.resourceType,
        platformResourceRevisions.resourceId,
        platformResourceRevisions.revision,
        platformResourceRevisions.checksum,
      ],
      name: 'platform_connectors_published_revision_fk',
    }).onDelete('restrict'),
    check(
      'platform_connectors_transport_http_check',
      sql`${t.migrationRequired} OR (${t.endpoint} IS NOT NULL AND ${t.transport} = 'http')`,
    ),
    check(
      'platform_connectors_credential_mode_check',
      sql`${t.migrationRequired} OR ${t.credentialMode} IN ('none', 'shared_service_account', 'per_user_oauth')`,
    ),
    check(
      'platform_connectors_credential_slot_check',
      sql`${t.migrationRequired} OR (
        (${t.credentialMode} = 'none'
          AND ${t.sharedSecretRef} IS NULL
          AND ${t.sharedSecretFingerprint} IS NULL
          AND ${t.sharedSecretUpdatedAt} IS NULL
          AND ${t.oauthClientSecretRef} IS NULL
          AND ${t.oauthClientSecretFingerprint} IS NULL
          AND ${t.oauthClientSecretUpdatedAt} IS NULL
          AND ${t.oauthConfig} IS NULL)
        OR (${t.credentialMode} = 'shared_service_account'
          AND ${t.oauthClientSecretRef} IS NULL
          AND ${t.oauthClientSecretFingerprint} IS NULL
          AND ${t.oauthClientSecretUpdatedAt} IS NULL
          AND ${t.oauthConfig} IS NULL
          AND ((${t.sharedSecretRef} IS NULL
              AND ${t.sharedSecretFingerprint} IS NULL
              AND ${t.sharedSecretUpdatedAt} IS NULL)
            OR (${t.sharedSecretRef} IS NOT NULL
              AND ${t.sharedSecretFingerprint} IS NOT NULL
              AND ${t.sharedSecretUpdatedAt} IS NOT NULL)))
        OR (${t.credentialMode} = 'per_user_oauth'
          AND ${t.sharedSecretRef} IS NULL
          AND ${t.sharedSecretFingerprint} IS NULL
          AND ${t.sharedSecretUpdatedAt} IS NULL
          AND ${t.oauthConfig} IS NOT NULL
          AND ((${t.oauthClientSecretRef} IS NULL
              AND ${t.oauthClientSecretFingerprint} IS NULL
              AND ${t.oauthClientSecretUpdatedAt} IS NULL)
            OR (${t.oauthClientSecretRef} IS NOT NULL
              AND ${t.oauthClientSecretFingerprint} IS NOT NULL
              AND ${t.oauthClientSecretUpdatedAt} IS NOT NULL)))
      )`,
    ),
    check(
      'platform_connectors_published_pointer_check',
      sql`${t.migrationRequired} OR ((
        (${t.publishedRevision} IS NULL
          AND ${t.publishedChecksum} IS NULL
          AND ${t.publishedAt} IS NULL)
        OR (${t.publishedRevision} > 0
          AND ${t.publishedChecksum} ~ '^[a-f0-9]{64}$'
          AND ${t.publishedAt} IS NOT NULL)
        ) AND (${t.status} <> 'published' OR ${t.publishedRevision} IS NOT NULL))`,
    ),
    check(
      'platform_connectors_revision_check',
      sql`${t.revision} >= 0 AND ${t.publishedResourceType} = 'connector'`,
    ),
    check(
      'platform_connectors_secret_ref_check',
      sql`(${t.sharedSecretRef} IS NULL OR ${t.sharedSecretRef} LIKE 'vault://%' OR ${t.sharedSecretRef} LIKE 'kms://%')
        AND (${t.oauthClientSecretRef} IS NULL OR ${t.oauthClientSecretRef} LIKE 'vault://%' OR ${t.oauthClientSecretRef} LIKE 'kms://%')`,
    ),
    check(
      'platform_connectors_oauth_config_check',
      sql`${t.oauthConfig} IS NULL
        OR (jsonb_typeof(${t.oauthConfig}) = 'object'
          AND octet_length(${t.oauthConfig}::text) <= 16384
          AND ${t.oauthConfig}::text !~* '"(client_?secret|secret|access_?token|refresh_?token|token|password|authorization)"[[:space:]]*:')`,
    ),
    check(
      'platform_connectors_published_shared_secret_check',
      sql`${t.migrationRequired}
        OR ${t.status} <> 'published'
        OR ${t.credentialMode} <> 'shared_service_account'
        OR (${t.sharedSecretRef} IS NOT NULL
          AND ${t.sharedSecretFingerprint} IS NOT NULL
          AND ${t.sharedSecretUpdatedAt} IS NOT NULL)`,
    ),
  ],
);

export type PlatformConnectorItem = typeof platformConnectors.$inferSelect;
export type NewPlatformConnector = typeof platformConnectors.$inferInsert;

/**
 * Envelope-encrypted Connector secret versions.
 *
 * `ref` is an opaque `kms://` application handle, not a remote KMS locator. It
 * is resolved only by the ConnectorCatalogSecretStore, which decrypts the
 * ciphertext through M13 PlatformSecretService. Plaintext never enters this
 * table, revisions, bindings, OAuth states, or audit logs.
 */
export const platformConnectorSecrets = pgTable(
  'platform_connector_secrets',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformConnectorSecrets', 16))
      .primaryKey()
      .notNull(),
    connectorId: text('connector_id')
      .notNull()
      .references(() => platformConnectors.id, { onDelete: 'restrict' }),
    slot: varchar('slot', { length: 32 }).$type<PlatformConnectorSecretSlot>().notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    /** Opaque application handle; never contains ciphertext or plaintext. */
    ref: text('ref').notNull(),
    /** M13 PlatformSecretService envelope only. */
    ciphertext: text('ciphertext').notNull(),
    /** Duplicated from the envelope header to support key-rotation inventory. */
    keyId: varchar('key_id', { length: 256 }).notNull(),
    revision: integer('revision').notNull().default(1),
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('platform_connector_secrets_ref_unique').on(t.ref),
    index('platform_connector_secrets_lookup_idx').on(
      t.connectorId,
      t.slot,
      t.fingerprint,
      t.createdAt,
    ),
    index('platform_connector_secrets_key_id_idx').on(t.keyId),
    check(
      'platform_connector_secrets_slot_check',
      sql`${t.slot} IN ('oauthBindingToken', 'oauthClientSecret', 'oauthPkceVerifier', 'sharedSecret')`,
    ),
    check('platform_connector_secrets_ref_check', sql`${t.ref} LIKE 'kms://platform-connectors/%'`),
    check('platform_connector_secrets_fingerprint_check', sql`${t.fingerprint} ~ '^[a-f0-9]{64}$'`),
    check('platform_connector_secrets_revision_check', sql`${t.revision} > 0`),
  ],
);

export type PlatformConnectorSecretItem = typeof platformConnectorSecrets.$inferSelect;
export type NewPlatformConnectorSecret = typeof platformConnectorSecrets.$inferInsert;

/** Current Draft tools. Published tools are embedded in the immutable revision snapshot. */
export const platformConnectorTools = pgTable(
  'platform_connector_tools',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformConnectorTools', 16))
      .primaryKey()
      .notNull(),
    connectorId: text('connector_id')
      .notNull()
      .references(() => platformConnectors.id, { onDelete: 'restrict' }),
    toolKey: varchar('tool_key', { length: 128 }).notNull(),
    /** @deprecated M01 tool payload retained for one stable compatibility window. */
    legacyManifest: jsonb('manifest').notNull().default({}),
    /** @deprecated M01 permission policy shadow. */
    legacyPermissionPolicy: varchar('permission_policy', { length: 32 })
      .notNull()
      .default('needs_approval'),
    /** @deprecated M01 user-policy flag. */
    legacyAllowUserStricterPolicy: boolean('allow_user_stricter_policy').notNull().default(true),
    /** @deprecated M01 limit configuration. */
    legacyLimitConfig: jsonb('limit_config'),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    description: text('description'),
    inputSchema: jsonb('input_schema')
      .$type<PlatformConnectorToolJsonSchema>()
      .notNull()
      .default({}),
    outputSchema: jsonb('output_schema')
      .$type<PlatformConnectorToolJsonSchema>()
      .notNull()
      .default({}),
    enabled: boolean('enabled').notNull().default(true),
    platformPolicy: varchar('platform_policy', { length: 16 })
      .$type<PlatformConnectorToolPolicy>()
      .notNull()
      .default('deny'),
    riskLevel: varchar('risk_level', { length: 16 })
      .$type<PlatformConnectorToolRiskLevel>()
      .notNull()
      .default('high'),
    requiresConfirmation: boolean('requires_confirmation').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** @deprecated M01 compatibility index; remove only in a later contract migration. */
    index('platform_connector_tools_connector_id_idx').on(t.connectorId),
    uniqueIndex('platform_connector_tools_connector_id_tool_key_unique').on(
      t.connectorId,
      t.toolKey,
    ),
    check('platform_connector_tools_policy_check', sql`${t.platformPolicy} IN ('allow', 'deny')`),
    check(
      'platform_connector_tools_risk_check',
      sql`${t.riskLevel} IN ('low', 'medium', 'high', 'critical')`,
    ),
    check(
      'platform_connector_tools_schema_check',
      sql`jsonb_typeof(${t.inputSchema}) = 'object'
        AND jsonb_typeof(${t.outputSchema}) = 'object'
        AND octet_length(${t.inputSchema}::text) <= 65536
        AND octet_length(${t.outputSchema}::text) <= 65536`,
    ),
    check(
      'platform_connector_tools_confirmation_check',
      sql`${t.riskLevel} NOT IN ('high', 'critical') OR ${t.requiresConfirmation} = true`,
    ),
  ],
);

export type PlatformConnectorToolItem = typeof platformConnectorTools.$inferSelect;
export type NewPlatformConnectorTool = typeof platformConnectorTools.$inferInsert;

/** User-owned OAuth binding. Token columns contain opaque Vault/KMS references only. */
export const platformUserConnectorBindings = pgTable(
  'platform_user_connector_bindings',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformUserConnectorBindings', 16))
      .primaryKey()
      .notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id')
      .notNull()
      .references(() => platformConnectors.id, { onDelete: 'restrict' }),
    revisionResourceType: varchar('revision_resource_type', { length: 64 })
      .$type<'connector'>()
      .notNull()
      .default('connector'),
    /** Nullable during expand for bindings created before immutable connector revisions. */
    publishedRevision: integer('published_revision'),
    /** @deprecated M01 row lifecycle; managed OAuth uses bindingStatus. */
    legacyStatus: varchar('status', { length: 32 }).notNull().default('active'),
    /** @deprecated M01 authentication lifecycle. */
    legacyAuthStatus: varchar('auth_status', { length: 32 }).notNull().default('disconnected'),
    /** @deprecated M01 encrypted credentials; never populated by M09. */
    legacyEncryptedCredentials: text('encrypted_credentials'),
    /** @deprecated M01 free-form error; managed OAuth uses lastErrorCategory. */
    legacyLastError: text('last_error'),
    status: varchar('binding_status', { length: 32 })
      .$type<PlatformConnectorBindingStatus>()
      .notNull()
      .default('disconnected'),
    oauthTokenRef: text('oauth_token_ref'),
    tokenFingerprint: varchar('token_fingerprint', { length: 256 }),
    scopes: varchar('scopes', { length: 200 })
      .array()
      .notNull()
      .default(sql`ARRAY[]::varchar[]`),
    expiresAt: timestamptz('expires_at'),
    connectedAt: timestamptz('connected_at'),
    revokedAt: timestamptz('revoked_at'),
    lastErrorCategory: varchar('last_error_category', { length: 32 }),
    revision: integer('revision').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_user_connector_bindings_user_connector_unique').on(
      t.userId,
      t.connectorId,
    ),
    uniqueIndex('platform_user_connector_bindings_oauth_state_owner_unique').on(
      t.id,
      t.userId,
      t.connectorId,
    ),
    /** @deprecated M01 compatibility indexes; retained during expand. */
    index('platform_user_connector_bindings_user_id_idx').on(t.userId),
    index('platform_user_connector_bindings_connector_id_idx').on(t.connectorId),
    index('platform_user_connector_bindings_status_idx').on(t.legacyStatus),
    foreignKey({
      columns: [t.revisionResourceType, t.connectorId, t.publishedRevision],
      foreignColumns: [
        platformResourceRevisions.resourceType,
        platformResourceRevisions.resourceId,
        platformResourceRevisions.revision,
      ],
      name: 'platform_user_connector_bindings_revision_fk',
    }).onDelete('restrict'),
    check(
      'platform_user_connector_bindings_status_check',
      sql`${t.status} IN ('disconnected', 'pending', 'connected', 'expired', 'revoked', 'error')`,
    ),
    check(
      'platform_user_connector_bindings_revision_check',
      sql`${t.publishedRevision} IS NULL OR (${t.publishedRevision} > 0
        AND ${t.revision} >= 0
        AND ${t.revisionResourceType} = 'connector')`,
    ),
    check(
      'platform_user_connector_bindings_token_ref_check',
      sql`(${t.oauthTokenRef} IS NULL AND ${t.tokenFingerprint} IS NULL)
        OR (${t.oauthTokenRef} IS NOT NULL AND ${t.tokenFingerprint} IS NOT NULL)`,
    ),
    check(
      'platform_user_connector_bindings_state_fields_check',
      sql`(${t.status} = 'connected'
          AND ${t.oauthTokenRef} IS NOT NULL
          AND ${t.tokenFingerprint} IS NOT NULL
          AND ${t.connectedAt} IS NOT NULL
          AND ${t.revokedAt} IS NULL)
        OR (${t.status} = 'revoked'
          AND ${t.oauthTokenRef} IS NULL
          AND ${t.tokenFingerprint} IS NULL
          AND cardinality(${t.scopes}) = 0
          AND ${t.revokedAt} IS NOT NULL)
        OR (${t.status} IN ('disconnected', 'pending')
          AND ${t.oauthTokenRef} IS NULL
          AND ${t.tokenFingerprint} IS NULL
          AND cardinality(${t.scopes}) = 0
          AND ${t.revokedAt} IS NULL)
        OR (${t.status} IN ('expired', 'error') AND ${t.revokedAt} IS NULL)`,
    ),
    check(
      'platform_user_connector_bindings_revoked_check',
      sql`(${t.status} = 'revoked' AND ${t.revokedAt} IS NOT NULL)
        OR (${t.status} <> 'revoked' AND ${t.revokedAt} IS NULL)`,
    ),
    check(
      'platform_user_connector_bindings_token_ref_format_check',
      sql`${t.oauthTokenRef} IS NULL OR ${t.oauthTokenRef} LIKE 'vault://%' OR ${t.oauthTokenRef} LIKE 'kms://%'`,
    ),
  ],
);

export type PlatformUserConnectorBindingItem = typeof platformUserConnectorBindings.$inferSelect;
export type NewPlatformUserConnectorBinding = typeof platformUserConnectorBindings.$inferInsert;

/** Single-use OAuth state. Raw state, PKCE verifier, and tokens never enter PostgreSQL. */
export const platformConnectorOAuthStates = pgTable(
  'platform_connector_oauth_states',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformConnectorOAuthStates', 16))
      .primaryKey()
      .notNull(),
    stateId: varchar('state_id', { length: 32 }).notNull(),
    stateHash: varchar('state_hash', { length: 64 }).notNull(),
    bindingId: text('binding_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id')
      .notNull()
      .references(() => platformConnectors.id, { onDelete: 'restrict' }),
    revisionResourceType: varchar('revision_resource_type', { length: 64 })
      .$type<'connector'>()
      .notNull()
      .default('connector'),
    publishedRevision: integer('published_revision').notNull(),
    pkceVerifierRef: text('pkce_verifier_ref').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    returnTo: text('return_to'),
    scopes: varchar('scopes', { length: 200 })
      .array()
      .notNull()
      .default(sql`ARRAY[]::varchar[]`),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
    /** Terminal callback outcome; null while the attempt is pending or exchanging a code. */
    authorizationOutcome: varchar('authorization_outcome', {
      length: 16,
    }).$type<PlatformConnectorOAuthAuthorizationOutcome>(),
    /** Written atomically with authorizationOutcome after callback success/failure. */
    finishedAt: timestamptz('finished_at'),
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('platform_connector_oauth_states_state_id_unique').on(t.stateId),
    uniqueIndex('platform_connector_oauth_states_state_hash_unique').on(t.stateHash),
    foreignKey({
      columns: [t.bindingId, t.userId, t.connectorId],
      foreignColumns: [
        platformUserConnectorBindings.id,
        platformUserConnectorBindings.userId,
        platformUserConnectorBindings.connectorId,
      ],
      name: 'platform_connector_oauth_states_binding_owner_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.revisionResourceType, t.connectorId, t.publishedRevision],
      foreignColumns: [
        platformResourceRevisions.resourceType,
        platformResourceRevisions.resourceId,
        platformResourceRevisions.revision,
      ],
      name: 'platform_connector_oauth_states_revision_fk',
    }).onDelete('restrict'),
    index('platform_connector_oauth_states_binding_created_idx').on(t.bindingId, t.createdAt),
    index('platform_connector_oauth_states_user_connector_idx').on(t.userId, t.connectorId),
    index('platform_connector_oauth_states_expires_idx').on(t.expiresAt),
    check(
      'platform_connector_oauth_states_terminal_check',
      sql`${t.consumedAt} IS NULL OR ${t.revokedAt} IS NULL`,
    ),
    check(
      'platform_connector_oauth_states_outcome_check',
      sql`(${t.authorizationOutcome} IS NULL AND ${t.finishedAt} IS NULL)
        OR (${t.authorizationOutcome} IN ('completed', 'failed') AND ${t.finishedAt} IS NOT NULL)`,
    ),
    check(
      'platform_connector_oauth_states_pkce_ref_check',
      sql`${t.pkceVerifierRef} LIKE 'vault://%' OR ${t.pkceVerifierRef} LIKE 'kms://%'`,
    ),
    check('platform_connector_oauth_states_hash_check', sql`${t.stateHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'platform_connector_oauth_states_revision_check',
      sql`${t.publishedRevision} > 0 AND ${t.revisionResourceType} = 'connector'`,
    ),
    check(
      'platform_connector_oauth_states_ttl_check',
      sql`${t.expiresAt} > ${t.createdAt}
        AND ${t.expiresAt} <= ${t.createdAt} + interval '10 minutes'`,
    ),
  ],
);

export type PlatformConnectorOAuthStateItem = typeof platformConnectorOAuthStates.$inferSelect;
export type NewPlatformConnectorOAuthState = typeof platformConnectorOAuthStates.$inferInsert;
