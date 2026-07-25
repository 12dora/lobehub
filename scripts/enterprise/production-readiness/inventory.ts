/**
 * Enterprise table inventory for recovery drills.
 * Derived from packages/database/src/schemas/platform/** pgTable definitions.
 * Tests fail if schema inventory drifts from this list.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Recovery-drill inventory: tables the recovery seed + digests actually exercise.
 * Must stay in exact lockstep with packages/database platform `pgTable` names
 * discovered by `assertInventoryMatchesSchemas` (two-sided: missing + extra).
 * DB-011 asserts migrated DB presence; this list asserts backup/restore coverage.
 */
export const RECOVERY_ENTERPRISE_TABLES = [
  'platform_admin_mutation_rate_windows',
  'platform_agents',
  'platform_agent_versions',
  'platform_agent_assignments',
  'platform_user_agent_materializations',
  'platform_user_agent_materialization_tombstones',
  'platform_ai_providers',
  'platform_ai_provider_secrets',
  'platform_ai_models',
  'platform_audit_exports',
  'platform_audit_legal_holds',
  'platform_audit_logs',
  'platform_audit_policies',
  'platform_audit_retention_runs',
  'platform_auth_settings',
  'platform_branding',
  'platform_branding_assets',
  'platform_branding_operations',
  'platform_catalog_authority',
  'platform_connectors',
  'platform_connector_governance',
  'platform_connector_secrets',
  'platform_connector_tools',
  'platform_user_connector_bindings',
  'platform_connector_oauth_states',
  'platform_global_credentials',
  'platform_global_credential_secrets',
  'platform_global_credential_uploads',
  'platform_identity_providers',
  'platform_identity_provider_secrets',
  'platform_identity_provider_test_attempts',
  'platform_identity_provider_instances',
  'platform_identity_provider_restart_requests',
  'platform_instance_heartbeats',
  'platform_instance_revision_states',
  'platform_jobs',
  'platform_managed_resource_policies',
  'platform_resource_revisions',
  'platform_settings_bundle',
  'platform_setting_policies',
  'platform_sidebar_layout',
  'platform_skills',
  'platform_skill_versions',
  'user_setting_overrides',
  'user_setting_override_revisions',
] as const;

export type RecoveryEnterpriseTable = (typeof RECOVERY_ENTERPRISE_TABLES)[number];

/** Tables with secret ref / fingerprint columns that must be digest-verified. */
export const SECRET_DOMAIN_TABLES = {
  aiProviders: 'platform_ai_providers',
  aiSecrets: 'platform_ai_provider_secrets',
  connectors: 'platform_connectors',
  connectorSecrets: 'platform_connector_secrets',
  identityProviders: 'platform_identity_providers',
  identitySecrets: 'platform_identity_provider_secrets',
} as const;

/**
 * Pointer domains must match real platform schemas / service write paths:
 *
 * platform_connectors FK:
 *   (published_resource_type, id, published_revision, published_checksum)
 *   → platform_resource_revisions(resource_type, resource_id, revision, checksum)
 *   holderChecksumColumn is mandatory when present on the row (never weak fallback).
 *
 * platform_user_connector_bindings FK:
 *   (revision_resource_type, connector_id, published_revision)
 *   → no holder checksum column
 *
 * identity: services write resource_type='oidc', resource_id=provider id,
 *   holder activation_revision.
 *
 * branding current publication: fixed row id='branding:published' status='published',
 *   revision → resource_type='branding', resource_id='global' (not asset first_published_revision).
 *
 * domain-version: agent/skill version tables with real `checksum` column.
 */
export const BRANDING_PUBLISHED_ROW_ID = 'branding:published' as const;
export const BRANDING_RESOURCE_OWNER = 'global' as const;

export const PUBLICATION_POINTER_SOURCES = [
  {
    holderChecksumColumn: 'published_checksum' as const,
    holderIdColumn: 'id' as const,
    holderResourceTypeColumn: 'published_resource_type' as const,
    kind: 'resource-revision' as const,
    pointerColumn: 'published_revision' as const,
    resourceOwnerColumn: 'id' as const,
    resourceType: 'connector' as const,
    table: 'platform_connectors' as const,
  },
  {
    holderChecksumColumn: null,
    holderIdColumn: 'id' as const,
    holderResourceTypeColumn: 'revision_resource_type' as const,
    kind: 'resource-revision' as const,
    pointerColumn: 'published_revision' as const,
    resourceOwnerColumn: 'connector_id' as const,
    resourceType: 'connector' as const,
    table: 'platform_user_connector_bindings' as const,
  },
  {
    holderChecksumColumn: null,
    holderIdColumn: 'id' as const,
    holderResourceTypeColumn: null,
    kind: 'resource-revision' as const,
    pointerColumn: 'activation_revision' as const,
    resourceOwnerColumn: 'id' as const,
    /** Actual service write path uses 'oidc', not 'identity_provider'. */
    resourceType: 'oidc' as const,
    table: 'platform_identity_providers' as const,
  },
  {
    /** Fixed published config row (admin branding service). */
    holderIdColumn: 'id' as const,
    holderIdValue: BRANDING_PUBLISHED_ROW_ID,
    holderStatusColumn: 'status' as const,
    holderStatusValue: 'published' as const,
    kind: 'fixed-holder-revision' as const,
    pointerColumn: 'revision' as const,
    resourceOwnerConstant: BRANDING_RESOURCE_OWNER,
    resourceType: 'branding' as const,
    table: 'platform_branding' as const,
  },
  {
    checksumColumn: 'checksum' as const,
    holderIdColumn: 'id' as const,
    kind: 'domain-version' as const,
    ownerColumn: 'skill_id' as const,
    pointerColumn: 'current_version_id' as const,
    table: 'platform_skills' as const,
    versionTable: 'platform_skill_versions' as const,
  },
  {
    checksumColumn: 'checksum' as const,
    holderIdColumn: 'id' as const,
    kind: 'domain-version' as const,
    ownerColumn: 'agent_id' as const,
    pointerColumn: 'current_version_id' as const,
    table: 'platform_agents' as const,
    versionTable: 'platform_agent_versions' as const,
  },
] as const;

/** Matches pgTable('name' | "name") including multiline form. */
const PGTABLE_NAME_PATTERN = /pgTable\(\s*['"]([a-z][a-z0-9_]*)['"]/gu;

/**
 * Scan platform schema sources for pgTable('name') declarations.
 */
export const discoverPlatformTableNamesFromSchemas = async (
  repoRoot: string,
): Promise<string[]> => {
  const dir = path.join(repoRoot, 'packages/database/src/schemas/platform');
  const entries = await readdir(dir);
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
    const text = await readFile(path.join(dir, entry), 'utf8');
    PGTABLE_NAME_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PGTABLE_NAME_PATTERN.exec(text)) !== null) {
      names.add(match[1]!);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'en'));
};

export const assertInventoryMatchesSchemas = async (repoRoot: string): Promise<void> => {
  const discovered = await discoverPlatformTableNamesFromSchemas(repoRoot);
  const expected = [...RECOVERY_ENTERPRISE_TABLES].sort((a, b) => a.localeCompare(b, 'en'));
  const discoveredSet = new Set<string>(discovered);
  const expectedSet = new Set<string>(expected);

  // Two-sided drift: inventory must cover every schema table (backup/restore gate),
  // and must not name tables the schema no longer exports.
  const missing = expected.filter((name) => !discoveredSet.has(name));
  const extra = discovered.filter((name) => !expectedSet.has(name));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Recovery inventory drift: missing=[${missing.join(',')}] extra=[${extra.join(',')}] ` +
        `(discovered=${discovered.length}, inventory=${expected.length})`,
    );
  }
};
