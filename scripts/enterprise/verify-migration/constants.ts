/** Fixed design baseline for enterprise redevelopment (LobeHub 2.2.10). */
export const BASELINE_COMMIT = '4bab1636408e60a7ee17b640490fbf33a310a325' as const;
export const BASELINE_VERSION = '2.2.10' as const;

/** Inclusive migration index range present at the 2.2.10 baseline (0000–0116). */
export const BASELINE_MIGRATION_FIRST_IDX = 0 as const;
export const BASELINE_MIGRATION_LAST_IDX = 116 as const;
export const BASELINE_MIGRATION_COUNT =
  BASELINE_MIGRATION_LAST_IDX - BASELINE_MIGRATION_FIRST_IDX + 1;

export const BASELINE_LAST_TAG = '0116_add_task_connector_message_and_verify_updates' as const;

export const MIGRATIONS_DIR = 'packages/database/migrations' as const;
export const JOURNAL_RELATIVE_PATH = `${MIGRATIONS_DIR}/meta/_journal.json` as const;

export const VERIFY_MIGRATION_LANE = 'enterprise-migration-compat' as const;
export const VERIFY_MIGRATION_SCHEMA_VERSION = 1 as const;

/** Resource identity for owned disposable Postgres (never shared phase0). */
export const OWNED_RESOURCE_PREFIX = 'm15q03' as const;
export const OWNED_CONTAINER_LABEL_TOKEN = 'com.lobehub.migration-compat-token' as const;
export const OWNED_CONTAINER_LABEL_EPHEMERAL = 'com.lobehub.migration-compat-ephemeral' as const;
export const OWNED_POSTGRES_IMAGE = 'paradedb/paradedb:latest-pg17' as const;

/** Core tables seeded in the synthetic 2.2.10 fixture and checked after upgrade. */
export const CORE_FIXTURE_TABLES = [
  'users',
  'sessions',
  'agents',
  'topics',
  'messages',
  'user_settings',
  'api_keys',
] as const;

export type CoreFixtureTable = (typeof CORE_FIXTURE_TABLES)[number];

/** Core application tables that post-baseline migrations must not DROP. */
export const EXPAND_ONLY_PROTECTED_TABLES = [
  'users',
  'sessions',
  'agents',
  'topics',
  'messages',
  'user_settings',
  'api_keys',
  'workspaces',
  'files',
] as const;

export const CHECK_CATEGORIES = [
  'baseline',
  'journal-snapshot',
  'apply-baseline',
  'load-fixture',
  'apply-post-baseline',
  'row-count',
  'foreign-key',
  'revision',
  'audit',
  'secret-reference',
  'expand-only',
  'external-dump',
  'cleanup',
  'rerun',
] as const;

export type CheckCategory = (typeof CHECK_CATEGORIES)[number];
