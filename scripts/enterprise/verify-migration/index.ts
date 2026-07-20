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
  buildFullFailedChecks,
  buildFullPassingChecks,
  createMigrationCompatReport,
  deriveOverallResult,
  gatePassed,
  isPassingSyntheticReport,
  migrationCompatReportSchema,
  REQUIRED_GATE_CATEGORIES,
  REQUIRED_PASSING_CATEGORIES,
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
  isLegacyTagIdxJournalStyle,
  loadOfficialMigrations,
  postBaselineEntries,
  verifyExpandOnlyPostBaselineSql,
} from './migrations';
export { isOwnedResourceToken } from './ownedPostgres';
export {
  countForbiddenValues,
  DUMP_MAX_BYTES,
  DUMP_SCAN_CHUNK_BYTES,
  DUMP_SCAN_OVERLAP_BYTES,
  scanDumpPrivacy,
  scanDumpPrivacyBuffer,
  scanDumpPrivacyFile,
  scanDumpPrivacyStream,
  scanForForbiddenReportContent,
  shortSha,
} from './privacy';
export {
  attemptIllegalSecretMutations,
  buildPlatformProbeStatements,
  PLATFORM_PROBE_IDS,
  PROBE_SECRET_ENVELOPE_PLACEHOLDER,
  PROBE_SECRET_FINGERPRINT,
  PROBE_SECRET_REF,
  REQUIRED_IDENTITY_SECRET_CONSTRAINTS,
  verifyAuditProbes,
  verifyIdentitySecretConstraintsPresent,
  verifyRevisionProbes,
  verifySecretReferenceProbes,
} from './probes';
export type { VerifyMigrationOptions, VerifyMigrationResult } from './runner';
export { runMigrationCompatVerification } from './runner';
