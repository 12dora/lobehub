export type { BaselineVerification, JournalEntry } from './baseline';
export {
  allJournalEntries,
  isBaselineMigrationPath,
  listBaselineMigrationFiles,
  verifyBaseline,
  verifyBaselineMigrationsMatch,
  verifyBaselinePackageVersion,
  verifyJournalSnapshotAlignment,
} from './baseline';
export type { CheckCategory, CoreFixtureTable } from './constants';
export {
  BASELINE_COMMIT,
  BASELINE_LAST_TAG,
  BASELINE_MIGRATION_COUNT,
  BASELINE_VERSION,
  CHECK_CATEGORIES,
  CORE_FIXTURE_TABLES,
  VERIFY_MIGRATION_LANE,
  VERIFY_MIGRATION_SCHEMA_VERSION,
} from './constants';
export type { CheckEntry, MigrationCompatReport, MigrationCompatReportCore } from './contract';
export {
  createMigrationCompatReport,
  deriveOverallResult,
  isPassingSyntheticReport,
  migrationCompatReportSchema,
  toReportCommitShort,
} from './contract';
export type { ExternalDumpInput, ExternalDumpResult } from './dump';
export {
  assessExternalDumpContent,
  hashDumpContent,
  loadExternalDump,
  toExternalDumpReportFields,
} from './dump';
export {
  assertSyntheticFixtureIsSecretFree,
  buildSyntheticFixtureStatements,
  isSecretFreeFixtureText,
  SYNTHETIC_FIXTURE_IDS,
  SYNTHETIC_FIXTURE_ROW_COUNTS,
} from './fixture';
export {
  baselineEntries,
  postBaselineEntries,
  verifyExpandOnlyPostBaselineSql,
} from './migrations';
export { isOwnedResourceToken } from './ownedPostgres';
export {
  countForbiddenValues,
  scanDumpPrivacy,
  scanForForbiddenReportContent,
  shortSha,
} from './privacy';
export type { VerifyMigrationOptions, VerifyMigrationResult } from './runner';
export { runMigrationCompatVerification } from './runner';
