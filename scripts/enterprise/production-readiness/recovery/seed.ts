/**
 * Minimal full-inventory schema + representative seed for harness backup/restore.
 * Covers every RECOVERY_ENTERPRISE_TABLES entry so required-tables can pass.
 */
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { RECOVERY_ENTERPRISE_TABLES } from '../inventory';

export const RECOVERY_PROBE_IDS = {
  agentId: 'pagt_m15q06_probe_01',
  agentVersionId: 'pagv_m15q06_probe_01',
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
  skillId: 'pskl_m15q06_probe_01',
  skillVersionId: 'pskv_m15q06_probe_01',
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

export const PROBE_ENVELOPE_PLACEHOLDER = 'probe-envelope-placeholder-not-a-secret' as const;

const REF_IDP = 'kms://platform-identity-providers/m15q06-probe';
const REF_CONN_SHARED = 'kms://platform-connectors/m15q06-shared';
const REF_CONN_OAUTH = 'kms://platform-connectors/m15q06-oauth';

/**
 * Create every enterprise table with enough columns for invariant queries.
 * Harness-only — production path never uses this against a real source.
 */
export const buildMinimalDrillSchemaStatements = (): string[] => {
  const stmts: string[] = [
    `CREATE TABLE IF NOT EXISTS users (
       id text PRIMARY KEY, username text, email text)`,
    // Legacy 2.2.10 core tables (expand-only retention surface for baseline probe)
    `CREATE TABLE IF NOT EXISTS sessions (
       id text PRIMARY KEY, user_id text, title text)`,
    `CREATE TABLE IF NOT EXISTS agents (
       id text PRIMARY KEY, user_id text, title text)`,
    `CREATE TABLE IF NOT EXISTS topics (
       id text PRIMARY KEY, user_id text, title text)`,
    `CREATE TABLE IF NOT EXISTS messages (
       id text PRIMARY KEY, user_id text, content text)`,
    `CREATE TABLE IF NOT EXISTS user_settings (
       id text PRIMARY KEY, general jsonb)`,
    `CREATE TABLE IF NOT EXISTS api_keys (
       id text PRIMARY KEY, user_id text, name text)`,
    `CREATE TABLE IF NOT EXISTS platform_resource_revisions (
       id text PRIMARY KEY,
       resource_type text NOT NULL,
       resource_id text NOT NULL,
       revision integer NOT NULL,
       status text NOT NULL,
       payload jsonb NOT NULL DEFAULT '{}'::jsonb,
       checksum text NOT NULL,
       secret_fingerprint text)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS platform_resource_revisions_type_id_revision_unique
       ON platform_resource_revisions (resource_type, resource_id, revision)`,
    `CREATE TABLE IF NOT EXISTS platform_audit_logs (
       id text PRIMARY KEY,
       action text NOT NULL,
       target_type text,
       target_id text,
       result text NOT NULL,
       after_diff jsonb,
       config_revision integer)`,
    `CREATE TABLE IF NOT EXISTS platform_identity_providers (
       id text PRIMARY KEY,
       provider_key text NOT NULL,
       secret_ref text,
       secret_fingerprint text,
       secret_updated_at timestamptz,
       activation_revision integer)`,
    `CREATE TABLE IF NOT EXISTS platform_identity_provider_secrets (
       id text PRIMARY KEY,
       provider_id text NOT NULL REFERENCES platform_identity_providers(id),
       fingerprint text NOT NULL,
       ref text NOT NULL,
       ciphertext text NOT NULL,
       key_id text NOT NULL,
       revision integer NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS platform_ai_providers (
       id text PRIMARY KEY,
       provider_key text NOT NULL,
       secret_fingerprint text,
       secret_key_id text,
       published_at timestamptz)`,
    `CREATE TABLE IF NOT EXISTS platform_ai_provider_secrets (
       id text PRIMARY KEY,
       provider_id text NOT NULL REFERENCES platform_ai_providers(id),
       fingerprint text NOT NULL,
       ciphertext text NOT NULL,
       key_id text NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS platform_ai_models (
       id text PRIMARY KEY, provider_id text, model_key text)`,
    `CREATE TABLE IF NOT EXISTS platform_connectors (
       id text PRIMARY KEY,
       connector_key text NOT NULL,
       shared_secret_ref text,
       shared_secret_fingerprint text,
       oauth_client_secret_ref text,
       oauth_client_secret_fingerprint text,
       published_revision integer,
       published_checksum text,
       status text DEFAULT 'draft')`,
    `CREATE TABLE IF NOT EXISTS platform_connector_secrets (
       id text PRIMARY KEY,
       connector_id text,
       fingerprint text NOT NULL,
       ciphertext text NOT NULL,
       key_id text NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS platform_connector_tools (
       id text PRIMARY KEY, connector_id text)`,
    `CREATE TABLE IF NOT EXISTS platform_user_connector_bindings (
       id text PRIMARY KEY, connector_id text, user_id text, published_revision integer)`,
    `CREATE TABLE IF NOT EXISTS platform_connector_oauth_states (
       id text PRIMARY KEY, connector_id text)`,
    `CREATE TABLE IF NOT EXISTS platform_branding (
       id text PRIMARY KEY, display_name text)`,
    `CREATE TABLE IF NOT EXISTS platform_branding_assets (
       id text PRIMARY KEY, branding_id text, first_published_revision integer)`,
    `CREATE TABLE IF NOT EXISTS platform_branding_operations (
       id text PRIMARY KEY, branding_id text)`,
    `CREATE TABLE IF NOT EXISTS platform_skills (
       id text PRIMARY KEY, status text, current_version_id text)`,
    `CREATE TABLE IF NOT EXISTS platform_skill_versions (
       id text PRIMARY KEY, skill_id text NOT NULL, content_digest text)`,
    `CREATE TABLE IF NOT EXISTS platform_agents (
       id text PRIMARY KEY, status text, current_version_id text, published_at timestamptz)`,
    `CREATE TABLE IF NOT EXISTS platform_agent_versions (
       id text PRIMARY KEY, agent_id text NOT NULL, content_digest text)`,
    `CREATE TABLE IF NOT EXISTS platform_agent_assignments (
       id text PRIMARY KEY, agent_id text)`,
    `CREATE TABLE IF NOT EXISTS platform_user_agent_materializations (
       id text PRIMARY KEY, agent_id text, user_id text)`,
    `CREATE TABLE IF NOT EXISTS platform_settings_bundle (
       id text PRIMARY KEY, revision integer)`,
    `CREATE TABLE IF NOT EXISTS platform_setting_policies (
       id text PRIMARY KEY, path text)`,
    `CREATE TABLE IF NOT EXISTS user_setting_overrides (
       id text PRIMARY KEY, user_id text)`,
    `CREATE TABLE IF NOT EXISTS user_setting_override_revisions (
       user_id text PRIMARY KEY, revision integer)`,
    `CREATE TABLE IF NOT EXISTS platform_jobs (
       id text PRIMARY KEY, type text, status text)`,
    `CREATE TABLE IF NOT EXISTS platform_managed_resource_policies (
       id text PRIMARY KEY, resource_type text)`,
    `CREATE TABLE IF NOT EXISTS platform_instance_heartbeats (
       id text PRIMARY KEY, instance_id text)`,
    `CREATE TABLE IF NOT EXISTS platform_instance_revision_states (
       id text PRIMARY KEY, instance_id text)`,
    `CREATE TABLE IF NOT EXISTS platform_easyauth_grant_snapshots (
       id text PRIMARY KEY, subject text)`,
    `CREATE TABLE IF NOT EXISTS platform_identity_provider_test_attempts (
       id text PRIMARY KEY, provider_id text)`,
    `CREATE TABLE IF NOT EXISTS platform_identity_provider_instances (
       id text PRIMARY KEY, provider_id text)`,
    `CREATE TABLE IF NOT EXISTS platform_identity_provider_restart_requests (
       id text PRIMARY KEY, provider_id text)`,
  ];

  // Sanity: every inventory table must appear in CREATE statements.
  for (const table of RECOVERY_ENTERPRISE_TABLES) {
    if (!stmts.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${table}`))) {
      throw new Error(`seed schema missing table ${table}`);
    }
  }
  return stmts;
};

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
       ('${ids.revisionId2}', 'connector', '${ids.connectorId}', 2, 'published',
        '{"displayName":"Recovery Drill Probe v2"}'::jsonb, '${PROBE_PAYLOAD_CHECKSUM_V2}', '${fp}')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_audit_logs
       (id, action, target_type, target_id, result, after_diff, config_revision)
     VALUES
       ('${ids.auditId}', 'platform.recovery.drill.probe', 'branding', '${ids.resourceId}',
        'success', '{"revision":2,"redacted":true,"fields":["displayName"]}'::jsonb, 2)
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_identity_providers
       (id, provider_key, secret_ref, secret_fingerprint, secret_updated_at, activation_revision)
     VALUES
       ('${ids.identityId}', 'm15q06-probe-idp',
        '${REF_IDP}', '${fp}', now(), NULL)
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_identity_provider_secrets
       (id, provider_id, fingerprint, ref, ciphertext, key_id, revision)
     VALUES
       ('${ids.identitySecretId}', '${ids.identityId}', '${fp}',
        '${REF_IDP}', '${PROBE_ENVELOPE_PLACEHOLDER}', 'probe-key-id', 1)
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
        oauth_client_secret_ref, oauth_client_secret_fingerprint,
        published_revision, published_checksum, status)
     VALUES
       ('${ids.connectorId}', 'm15q06-connector',
        '${REF_CONN_SHARED}', '${fp}',
        '${REF_CONN_OAUTH}', '${fp}',
        2, '${PROBE_PAYLOAD_CHECKSUM_V2}', 'published')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_connector_secrets (id, connector_id, fingerprint, ciphertext, key_id)
     VALUES ('${ids.connectorSecretId}', '${ids.connectorId}', '${fp}',
             '${PROBE_ENVELOPE_PLACEHOLDER}', 'probe-key-id')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_skill_versions (id, skill_id, content_digest)
     VALUES ('${ids.skillVersionId}', '${ids.skillId}', '${PROBE_PAYLOAD_CHECKSUM}')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_skills (id, status, current_version_id)
     VALUES ('${ids.skillId}', 'published', '${ids.skillVersionId}')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_agent_versions (id, agent_id, content_digest)
     VALUES ('${ids.agentVersionId}', '${ids.agentId}', '${PROBE_PAYLOAD_CHECKSUM_V2}')
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO platform_agents (id, status, current_version_id)
     VALUES ('${ids.agentId}', 'published', '${ids.agentVersionId}')
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

export const ENTERPRISE_TABLES_FOR_RETENTION = RECOVERY_ENTERPRISE_TABLES;
