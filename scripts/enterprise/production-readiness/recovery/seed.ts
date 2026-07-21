/**
 * Representative non-secret platform seed data for backup/restore drills.
 */
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

export const RECOVERY_PROBE_IDS = {
  aiProviderId: 'paip_m15q06_probe_01',
  aiSecretId: 'pais_m15q06_probe_01',
  auditId: 'paud_m15q06_probe_01',
  connectorId: 'pcon_m15q06_probe_01',
  connectorSecretId: 'pcos_m15q06_probe_01',
  identityId: 'pidp_m15q06_probe_01',
  identitySecretId: 'pids_m15q06_probe_01',
  resourceId: 'm15q06-probe-resource',
  revisionId: 'prev_m15q06_probe_01',
  revisionId2: 'prev_m15q06_probe_02',
  userId: 'usr_m15q06_fixture_01',
} as const;

export const PROBE_FINGERPRINT = createHash('sha256')
  .update('m15q06-probe-fingerprint-seed')
  .digest('hex');

export const PROBE_PAYLOAD_CHECKSUM = createHash('sha256')
  .update('{"displayName":"Recovery Drill Probe"}')
  .digest('hex');

export const PROBE_PAYLOAD_CHECKSUM_V2 = createHash('sha256')
  .update('{"displayName":"Recovery Drill Probe v2"}')
  .digest('hex');

/** Opaque placeholder — not live ciphertext. */
export const PROBE_ENVELOPE_PLACEHOLDER = 'probe-envelope-placeholder-not-a-secret' as const;

/**
 * Minimal DDL for drill tables when full migrations are not applied.
 * Used only for local-harness isolation; production-authorized mode expects real schema.
 */
export const buildMinimalDrillSchemaStatements = (): string[] => [
  `CREATE TABLE IF NOT EXISTS platform_resource_revisions (
     id text PRIMARY KEY,
     resource_type text NOT NULL,
     resource_id text NOT NULL,
     revision integer NOT NULL,
     status text NOT NULL,
     payload jsonb NOT NULL DEFAULT '{}'::jsonb,
     checksum text NOT NULL,
     secret_fingerprint text
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS platform_resource_revisions_type_id_revision_unique
     ON platform_resource_revisions (resource_type, resource_id, revision)`,
  `CREATE TABLE IF NOT EXISTS platform_audit_logs (
     id text PRIMARY KEY,
     action text NOT NULL,
     target_type text,
     target_id text,
     result text NOT NULL,
     after_diff jsonb,
     config_revision integer
   )`,
  `CREATE TABLE IF NOT EXISTS platform_identity_providers (
     id text PRIMARY KEY,
     provider_key text NOT NULL,
     secret_ref text,
     secret_fingerprint text,
     secret_updated_at timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS platform_identity_provider_secrets (
     id text PRIMARY KEY,
     provider_id text NOT NULL REFERENCES platform_identity_providers(id),
     fingerprint text NOT NULL,
     ref text NOT NULL,
     ciphertext text NOT NULL,
     key_id text NOT NULL,
     revision integer NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS platform_ai_providers (
     id text PRIMARY KEY,
     provider_key text NOT NULL,
     secret_fingerprint text,
     secret_key_id text
   )`,
  `CREATE TABLE IF NOT EXISTS platform_ai_provider_secrets (
     id text PRIMARY KEY,
     provider_id text NOT NULL REFERENCES platform_ai_providers(id),
     fingerprint text NOT NULL,
     ciphertext text NOT NULL,
     key_id text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS platform_connectors (
     id text PRIMARY KEY,
     connector_key text NOT NULL,
     shared_secret_ref text,
     shared_secret_fingerprint text,
     oauth_client_secret_ref text,
     oauth_client_secret_fingerprint text
   )`,
  `CREATE TABLE IF NOT EXISTS platform_connector_secrets (
     id text PRIMARY KEY,
     connector_id text,
     fingerprint text NOT NULL,
     ciphertext text NOT NULL,
     key_id text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     id text PRIMARY KEY,
     username text,
     email text
   )`,
];

export const buildRecoverySeedStatements = (): string[] => {
  const ids = RECOVERY_PROBE_IDS;
  const fp = PROBE_FINGERPRINT;
  return [
    `INSERT INTO users (id, username, email)
     VALUES ('${ids.userId}', 'm15q06_fixture_user', 'fixture.recovery@example.invalid')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_resource_revisions
       (id, resource_type, resource_id, revision, status, payload, checksum, secret_fingerprint)
     VALUES
       ('${ids.revisionId}', 'branding', '${ids.resourceId}', 1, 'draft',
        '{"displayName":"Recovery Drill Probe"}'::jsonb, '${PROBE_PAYLOAD_CHECKSUM}', '${fp}'),
       ('${ids.revisionId2}', 'branding', '${ids.resourceId}', 2, 'published',
        '{"displayName":"Recovery Drill Probe v2"}'::jsonb, '${PROBE_PAYLOAD_CHECKSUM_V2}', '${fp}')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_audit_logs
       (id, action, target_type, target_id, result, after_diff, config_revision)
     VALUES
       ('${ids.auditId}', 'platform.recovery.drill.probe', 'branding', '${ids.resourceId}',
        'success', '{"revision":2,"redacted":true,"fields":["displayName"]}'::jsonb, 2)
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_identity_providers
       (id, provider_key, secret_ref, secret_fingerprint, secret_updated_at)
     VALUES
       ('${ids.identityId}', 'm15q06-probe-idp',
        'kms://platform-identity-providers/m15q06-probe', '${fp}', now())
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_identity_provider_secrets
       (id, provider_id, fingerprint, ref, ciphertext, key_id, revision)
     VALUES
       ('${ids.identitySecretId}', '${ids.identityId}', '${fp}',
        'kms://platform-identity-providers/m15q06-probe',
        '${PROBE_ENVELOPE_PLACEHOLDER}', 'probe-key-id', 1)
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_ai_providers (id, provider_key, secret_fingerprint, secret_key_id)
     VALUES ('${ids.aiProviderId}', 'm15q06-ai', '${fp}', 'probe-key-id')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_ai_provider_secrets (id, provider_id, fingerprint, ciphertext, key_id)
     VALUES ('${ids.aiSecretId}', '${ids.aiProviderId}', '${fp}',
             '${PROBE_ENVELOPE_PLACEHOLDER}', 'probe-key-id')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_connectors
       (id, connector_key, shared_secret_ref, shared_secret_fingerprint,
        oauth_client_secret_ref, oauth_client_secret_fingerprint)
     VALUES
       ('${ids.connectorId}', 'm15q06-connector',
        'kms://platform-connectors/m15q06-shared', '${fp}',
        'kms://platform-connectors/m15q06-oauth', '${fp}')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_connector_secrets (id, connector_id, fingerprint, ciphertext, key_id)
     VALUES ('${ids.connectorSecretId}', '${ids.connectorId}', '${fp}',
             '${PROBE_ENVELOPE_PLACEHOLDER}', 'probe-key-id')
     ON CONFLICT (id) DO NOTHING`,
  ];
};

export const seedRecoveryFixture = async (client: PoolClient): Promise<void> => {
  for (const statement of buildMinimalDrillSchemaStatements()) {
    await client.query(statement);
  }
  for (const statement of buildRecoverySeedStatements()) {
    await client.query(statement);
  }
};

export const ENTERPRISE_TABLES_FOR_RETENTION = [
  'platform_resource_revisions',
  'platform_audit_logs',
  'platform_identity_providers',
  'platform_identity_provider_secrets',
  'platform_ai_providers',
  'platform_ai_provider_secrets',
  'platform_connectors',
  'platform_connector_secrets',
] as const;
