/**
 * Enterprise table inventory for recovery drills.
 * Derived from packages/database/src/schemas/platform/** pgTable definitions.
 * Tests fail if schema inventory drifts from this list.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Explicit inventory of every platform_* (and related) enterprise table. */
export const RECOVERY_ENTERPRISE_TABLES = [
  'platform_agents',
  'platform_agent_versions',
  'platform_agent_assignments',
  'platform_user_agent_materializations',
  'platform_ai_providers',
  'platform_ai_provider_secrets',
  'platform_ai_models',
  'platform_audit_logs',
  'platform_branding',
  'platform_branding_assets',
  'platform_branding_operations',
  'platform_connectors',
  'platform_connector_secrets',
  'platform_connector_tools',
  'platform_user_connector_bindings',
  'platform_connector_oauth_states',
  'platform_easyauth_grant_snapshots',
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

/** Tables that carry publication / draft pointers into revisions. */
export const PUBLICATION_POINTER_SOURCES = [
  {
    idColumn: 'id',
    pointerColumn: 'published_revision',
    table: 'platform_branding',
  },
  {
    idColumn: 'id',
    pointerColumn: 'published_revision',
    table: 'platform_connectors',
  },
  {
    idColumn: 'id',
    pointerColumn: 'published_revision',
    table: 'platform_skills',
  },
  {
    idColumn: 'id',
    pointerColumn: 'published_revision',
    table: 'platform_agents',
  },
  {
    idColumn: 'id',
    pointerColumn: 'published_revision',
    table: 'platform_ai_providers',
  },
  {
    idColumn: 'id',
    pointerColumn: 'activation_revision',
    table: 'platform_identity_providers',
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

  const missing = expected.filter((name) => !discoveredSet.has(name));
  const extra = discovered.filter((name) => !expectedSet.has(name));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Recovery inventory drift: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
    );
  }
};
