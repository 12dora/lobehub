import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from '../_helpers';

/**
 * Platform-global credential type (subset of Market CredType).
 * OAuth is intentionally unsupported for platform-owned secrets.
 */
export type PlatformGlobalCredentialType = 'kv-env' | 'kv-header' | 'file';

/**
 * Public metadata only — never secret values, ciphertext, or fingerprints of plaintext.
 */
export interface PlatformGlobalCredentialMeta {
  description?: string;
  fileName?: string;
  fileSize?: number;
  /** Masked list preview, e.g. "••••xxxx" or "configured". */
  maskedPreview?: string;
  /** Public key names for KV credentials (values never stored here). */
  valueKeys?: string[];
}

/** Max encrypted file payload size (256 KiB). */
export const PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES = 256 * 1024;

/**
 * Platform-owned global credentials shared by all users.
 * Serial integer `id` mirrors Market UserCredSummary.id (number) for UI reuse.
 */
export const platformGlobalCredentials = pgTable(
  'platform_global_credentials',
  {
    id: serial('id').primaryKey().notNull(),
    /** Stable unique key used by skills / injection (e.g. `openai`). */
    key: varchar('key', { length: 100 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    type: varchar('type', { length: 32 }).$type<PlatformGlobalCredentialType>().notNull(),
    meta: jsonb('meta').$type<PlatformGlobalCredentialMeta>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_global_credentials_key_unique').on(t.key),
    index('platform_global_credentials_type_idx').on(t.type),
    index('platform_global_credentials_enabled_idx').on(t.enabled),
    check(
      'platform_global_credentials_type_check',
      sql`${t.type} IN ('kv-env', 'kv-header', 'file')`,
    ),
    check(
      'platform_global_credentials_key_check',
      sql`${t.key} ~ '^[\\w-]+$' AND char_length(${t.key}) >= 1`,
    ),
  ],
);

export type PlatformGlobalCredentialItem = typeof platformGlobalCredentials.$inferSelect;
export type NewPlatformGlobalCredential = typeof platformGlobalCredentials.$inferInsert;

/**
 * Envelope-encrypted secret versions for platform global credentials.
 * Aligns with platform_connector_secrets: fingerprint / ref / ciphertext / keyId / revision.
 * Plaintext never enters this table, audit logs, or API responses.
 */
export const platformGlobalCredentialSecrets = pgTable(
  'platform_global_credential_secrets',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformGlobalCredentialSecrets', 16))
      .primaryKey()
      .notNull(),
    credentialId: integer('credential_id')
      .notNull()
      .references(() => platformGlobalCredentials.id, { onDelete: 'cascade' }),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    /** Opaque application handle; never contains ciphertext or plaintext. */
    ref: text('ref').notNull(),
    /** M13 PlatformSecretService envelope only. */
    ciphertext: text('ciphertext').notNull(),
    /** Duplicated from the envelope header for key-rotation inventory. */
    keyId: varchar('key_id', { length: 256 }).notNull(),
    revision: integer('revision').notNull().default(1),
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('platform_global_credential_secrets_ref_unique').on(t.ref),
    index('platform_global_credential_secrets_lookup_idx').on(
      t.credentialId,
      t.fingerprint,
      t.createdAt,
    ),
    index('platform_global_credential_secrets_key_id_idx').on(t.keyId),
    check(
      'platform_global_credential_secrets_ref_check',
      sql`${t.ref} LIKE 'kms://platform-global-credentials/%'`,
    ),
    check(
      'platform_global_credential_secrets_fingerprint_check',
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check('platform_global_credential_secrets_revision_check', sql`${t.revision} > 0`),
  ],
);

export type PlatformGlobalCredentialSecretItem =
  typeof platformGlobalCredentialSecrets.$inferSelect;
export type NewPlatformGlobalCredentialSecret = typeof platformGlobalCredentialSecrets.$inferInsert;

/**
 * Short-lived staging for file credential uploads (uploadFile → createFile).
 * Ciphertext only; consumed once on createFile or expired by TTL.
 */
export const platformGlobalCredentialUploads = pgTable(
  'platform_global_credential_uploads',
  {
    fileHashId: varchar('file_hash_id', { length: 64 }).primaryKey().notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    fileType: varchar('file_type', { length: 128 }).notNull(),
    fileSize: integer('file_size').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    ref: text('ref').notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyId: varchar('key_id', { length: 256 }).notNull(),
    createdBy: text('created_by'),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('platform_global_credential_uploads_expires_at_idx').on(t.expiresAt),
    check(
      'platform_global_credential_uploads_fingerprint_check',
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'platform_global_credential_uploads_file_size_check',
      // Literal 256 KiB — keep in sync with PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES.
      sql`${t.fileSize} > 0 AND ${t.fileSize} <= 262144`,
    ),
    check(
      'platform_global_credential_uploads_ref_check',
      sql`${t.ref} LIKE 'kms://platform-global-credentials/upload/%'`,
    ),
  ],
);

export type PlatformGlobalCredentialUploadItem =
  typeof platformGlobalCredentialUploads.$inferSelect;
export type NewPlatformGlobalCredentialUpload = typeof platformGlobalCredentialUploads.$inferInsert;
