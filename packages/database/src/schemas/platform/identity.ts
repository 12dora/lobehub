import type {
  PlatformIdentityProviderClaimMapping,
  PlatformIdentityProviderClaimPreview,
  PlatformIdentityProviderStatus,
  PlatformIdentityProviderTestAttemptStatus,
  PlatformIdentityProviderType,
} from '@lobechat/types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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

/** External OIDC login provider draft. Secret material lives in the version table below. */
export const platformIdentityProviders = pgTable(
  'platform_identity_providers',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformIdentityProviders', 16))
      .primaryKey()
      .notNull(),
    providerKey: text('provider_key').notNull(),
    type: varchar('type', { length: 32 })
      .$type<PlatformIdentityProviderType>()
      .notNull()
      .default('generic_oidc'),
    displayName: text('display_name').notNull(),
    buttonLabel: text('button_label').notNull().default('使用工作账号登录'),
    icon: text('icon'),
    /** Canonical HTTPS issuer without query, fragment, or embedded credentials. */
    issuer: text('issuer'),
    clientId: text('client_id'),
    /** Preserved legacy columns. They are never exposed by safe projections. */
    legacyDiscoveryUrl: text('discovery_url'),
    legacyEncryptedClientSecret: text('encrypted_client_secret'),
    migrationRequired: boolean('migration_required').notNull().default(false),
    /** Opaque handle only. Ciphertext lives in platform_identity_provider_secrets. */
    secretRef: text('secret_ref'),
    secretFingerprint: text('secret_fingerprint'),
    secretUpdatedAt: timestamptz('secret_updated_at'),
    scopes: jsonb('scopes').$type<string[]>().notNull().default(['openid', 'profile', 'email']),
    usePkce: boolean('use_pkce').notNull().default(true),
    claimMapping: jsonb('claim_mapping')
      .$type<PlatformIdentityProviderClaimMapping>()
      .notNull()
      .default({
        dingtalkTitle: [],
        dingtalkUserId: [],
        email: ['email'],
        name: ['name', 'preferred_username'],
        picture: ['picture'],
        subject: ['sub'],
      }),
    domainAllowlist: jsonb('domain_allowlist').$type<string[]>().notNull().default([]),
    autoProvision: boolean('auto_provision').notNull().default(true),
    groupRoleMapping: jsonb('group_role_mapping')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    enabled: boolean('enabled').notNull().default(false),
    status: varchar('status', { length: 32 })
      .$type<PlatformIdentityProviderStatus>()
      .notNull()
      .default('draft'),
    /** Mutable draft CAS revision. */
    revision: integer('revision').notNull().default(0),
    /** Published revision expected/observed by the startup snapshot lifecycle. */
    activationRevision: integer('activation_revision'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_identity_providers_provider_key_unique').on(t.providerKey),
    index('platform_identity_providers_status_idx').on(t.status),
    index('platform_identity_providers_enabled_status_idx').on(t.enabled, t.status),
    check(
      'platform_identity_providers_key_check',
      sql`${t.migrationRequired} OR ${t.providerKey} ~ '^[a-z0-9][a-z0-9._-]{0,127}$'`,
    ),
    check(
      'platform_identity_providers_type_check',
      sql`${t.type} IN ('authentik', 'generic_oidc')`,
    ),
    check(
      'platform_identity_providers_status_check',
      sql`${t.status} IN ('draft', 'published', 'pending_restart', 'active', 'error', 'disabled', 'archived')`,
    ),
    check(
      'platform_identity_providers_revision_check',
      sql`${t.revision} >= 0 AND (${t.activationRevision} IS NULL OR ${t.activationRevision} > 0)`,
    ),
    check(
      'platform_identity_providers_migration_state_check',
      sql`NOT ${t.migrationRequired} OR (
        NOT ${t.enabled}
        AND ${t.activationRevision} IS NULL
        AND ${t.secretRef} IS NULL
        AND ${t.secretFingerprint} IS NULL
        AND ${t.secretUpdatedAt} IS NULL
        AND ${t.status} IN ('draft', 'error', 'disabled', 'archived')
      )`,
    ),
    check(
      'platform_identity_providers_secret_state_check',
      sql`(${t.secretRef} IS NULL AND ${t.secretFingerprint} IS NULL AND ${t.secretUpdatedAt} IS NULL)
        OR (${t.secretRef} IS NOT NULL
          AND ${t.secretFingerprint} ~ '^[a-f0-9]{64}$'
          AND ${t.secretUpdatedAt} IS NOT NULL)`,
    ),
    check(
      'platform_identity_providers_secret_ref_check',
      sql`${t.secretRef} IS NULL OR ${t.secretRef} LIKE 'kms://platform-identity-providers/%'`,
    ),
    check(
      'platform_identity_providers_scopes_check',
      sql`jsonb_typeof(${t.scopes}) = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(${t.scopes}) = 'array' THEN ${t.scopes} ELSE '[]'::jsonb END) BETWEEN 1 AND 32
        AND ${t.scopes} ? 'openid'
        AND NOT jsonb_path_exists(${t.scopes}, '$[*] ? (@.type() != "string")')
        AND octet_length(${t.scopes}::text) <= 4096`,
    ),
    check('platform_identity_providers_pkce_check', sql`${t.usePkce}`),
    check(
      'platform_identity_providers_claim_mapping_check',
      sql`jsonb_typeof(${t.claimMapping}) = 'object'
        AND ${t.claimMapping} = jsonb_build_object(
          'dingtalkTitle', ${t.claimMapping}->'dingtalkTitle',
          'dingtalkUserId', ${t.claimMapping}->'dingtalkUserId',
          'email', ${t.claimMapping}->'email',
          'name', ${t.claimMapping}->'name',
          'picture', ${t.claimMapping}->'picture',
          'subject', ${t.claimMapping}->'subject'
        )
        AND jsonb_typeof(${t.claimMapping}->'dingtalkTitle') = 'array'
        AND jsonb_typeof(${t.claimMapping}->'dingtalkUserId') = 'array'
        AND jsonb_typeof(${t.claimMapping}->'email') = 'array'
        AND jsonb_typeof(${t.claimMapping}->'picture') = 'array'
        AND jsonb_typeof(${t.claimMapping}->'subject') = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(${t.claimMapping}->'subject') = 'array' THEN ${t.claimMapping}->'subject' ELSE '[]'::jsonb END) > 0
        AND jsonb_typeof(${t.claimMapping}->'name') = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(${t.claimMapping}->'name') = 'array' THEN ${t.claimMapping}->'name' ELSE '[]'::jsonb END) > 0
        AND jsonb_array_length(CASE WHEN jsonb_typeof(${t.claimMapping}->'dingtalkTitle') = 'array' THEN ${t.claimMapping}->'dingtalkTitle' ELSE '[]'::jsonb END) <= 8
        AND jsonb_array_length(CASE WHEN jsonb_typeof(${t.claimMapping}->'dingtalkUserId') = 'array' THEN ${t.claimMapping}->'dingtalkUserId' ELSE '[]'::jsonb END) <= 8
        AND jsonb_array_length(CASE WHEN jsonb_typeof(${t.claimMapping}->'email') = 'array' THEN ${t.claimMapping}->'email' ELSE '[]'::jsonb END) <= 8
        AND jsonb_array_length(CASE WHEN jsonb_typeof(${t.claimMapping}->'name') = 'array' THEN ${t.claimMapping}->'name' ELSE '[]'::jsonb END) <= 8
        AND jsonb_array_length(CASE WHEN jsonb_typeof(${t.claimMapping}->'picture') = 'array' THEN ${t.claimMapping}->'picture' ELSE '[]'::jsonb END) <= 8
        AND jsonb_array_length(CASE WHEN jsonb_typeof(${t.claimMapping}->'subject') = 'array' THEN ${t.claimMapping}->'subject' ELSE '[]'::jsonb END) <= 8
        AND NOT jsonb_path_exists(${t.claimMapping}, '$.*[*] ? (@.type() != "string")')
        AND NOT jsonb_path_exists(${t.claimMapping}, '$.*[*] ? (!(@ like_regex "^[A-Za-z0-9_.:-]{1,128}$"))')
        AND octet_length(${t.claimMapping}::text) <= 8192
        AND ${t.claimMapping}::text !~* '(client.?secret|api.?key|access.?token|refresh.?token|id.?token|password|authorization|bearer|credential)'`,
    ),
    check(
      'platform_identity_providers_policy_json_check',
      sql`jsonb_typeof(${t.domainAllowlist}) = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(${t.domainAllowlist}) = 'array' THEN ${t.domainAllowlist} ELSE '[]'::jsonb END) <= 256
        AND octet_length(${t.domainAllowlist}::text) <= 65536
        AND jsonb_typeof(${t.groupRoleMapping}) = 'object'
        AND octet_length(${t.groupRoleMapping}::text) <= 65536`,
    ),
  ],
);

export type PlatformIdentityProviderItem = typeof platformIdentityProviders.$inferSelect;
export type NewPlatformIdentityProvider = typeof platformIdentityProviders.$inferInsert;

/** Envelope-encrypted immutable OIDC client-secret versions. */
export const platformIdentityProviderSecrets = pgTable(
  'platform_identity_provider_secrets',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformIdentityProviderSecrets', 16))
      .primaryKey()
      .notNull(),
    providerId: text('provider_id')
      .notNull()
      .references(() => platformIdentityProviders.id, { onDelete: 'restrict' }),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    /** Opaque server-side handle; never exposed in API/revision projections. */
    ref: text('ref').notNull(),
    /** M13 PlatformSecretService envelope only. */
    ciphertext: text('ciphertext').notNull(),
    keyId: varchar('key_id', { length: 256 }).notNull(),
    revision: integer('revision').notNull().default(1),
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('platform_identity_provider_secrets_ref_unique').on(t.ref),
    uniqueIndex('platform_identity_provider_secrets_provider_fingerprint_unique').on(
      t.providerId,
      t.fingerprint,
    ),
    index('platform_identity_provider_secrets_lookup_idx').on(
      t.providerId,
      t.fingerprint,
      t.createdAt,
    ),
    index('platform_identity_provider_secrets_key_id_idx').on(t.keyId),
    check(
      'platform_identity_provider_secrets_ref_check',
      sql`${t.ref} LIKE 'kms://platform-identity-providers/%'`,
    ),
    check(
      'platform_identity_provider_secrets_fingerprint_check',
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check('platform_identity_provider_secrets_revision_check', sql`${t.revision} > 0`),
  ],
);

export type PlatformIdentityProviderSecretItem =
  typeof platformIdentityProviderSecrets.$inferSelect;
export type NewPlatformIdentityProviderSecret = typeof platformIdentityProviderSecrets.$inferInsert;

/** One-shot, admin-only OIDC test flow. Never consumed by the production login runtime. */
export const platformIdentityProviderTestAttempts = pgTable(
  'platform_identity_provider_test_attempts',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformIdentityProviderTestAttempts', 16))
      .primaryKey()
      .notNull(),
    providerId: text('provider_id')
      .notNull()
      .references(() => platformIdentityProviders.id, { onDelete: 'cascade' }),
    providerRevision: integer('provider_revision').notNull(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    stateHash: varchar('state_hash', { length: 64 }).notNull(),
    nonceHash: varchar('nonce_hash', { length: 64 }).notNull(),
    /** Envelope-encrypted PKCE verifier; never selected by admin result projections. */
    pkceCiphertext: text('pkce_ciphertext').notNull(),
    pkceKeyId: varchar('pkce_key_id', { length: 256 }).notNull(),
    redirectUri: text('redirect_uri').notNull(),
    status: varchar('status', { length: 32 })
      .$type<PlatformIdentityProviderTestAttemptStatus>()
      .notNull()
      .default('pending'),
    result: jsonb('result').$type<PlatformIdentityProviderClaimPreview>(),
    errorCode: varchar('error_code', { length: 128 }),
    expiresAt: timestamptz('expires_at').notNull(),
    reservedAt: timestamptz('reserved_at'),
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_identity_provider_test_attempts_state_hash_unique').on(t.stateHash),
    index('platform_identity_provider_test_attempts_user_provider_idx').on(
      t.userId,
      t.providerId,
      t.createdAt,
    ),
    index('platform_identity_provider_test_attempts_expires_idx').on(t.expiresAt),
    check(
      'platform_identity_provider_test_attempts_hash_check',
      sql`${t.stateHash} ~ '^[a-f0-9]{64}$' AND ${t.nonceHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'platform_identity_provider_test_attempts_status_check',
      sql`${t.status} IN ('pending', 'processing', 'succeeded', 'failed')`,
    ),
    check(
      'platform_identity_provider_test_attempts_revision_check',
      sql`${t.providerRevision} >= 0`,
    ),
    check(
      'platform_identity_provider_test_attempts_terminal_check',
      sql`(${t.status} = 'pending' AND ${t.reservedAt} IS NULL AND ${t.completedAt} IS NULL AND ${t.result} IS NULL AND ${t.errorCode} IS NULL)
        OR (${t.status} = 'processing' AND ${t.reservedAt} IS NOT NULL AND ${t.completedAt} IS NULL AND ${t.result} IS NULL AND ${t.errorCode} IS NULL)
        OR (${t.status} = 'succeeded' AND ${t.completedAt} IS NOT NULL AND ${t.result} IS NOT NULL AND ${t.errorCode} IS NULL)
        OR (${t.status} = 'failed' AND ${t.completedAt} IS NOT NULL AND ${t.result} IS NULL AND ${t.errorCode} IS NOT NULL)`,
    ),
    check(
      'platform_identity_provider_test_attempts_ttl_check',
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '10 minutes'`,
    ),
  ],
);

export type PlatformIdentityProviderTestAttemptItem =
  typeof platformIdentityProviderTestAttempts.$inferSelect;
export type NewPlatformIdentityProviderTestAttempt =
  typeof platformIdentityProviderTestAttempts.$inferInsert;
