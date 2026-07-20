import { z } from 'zod';

import {
  BASELINE_VERSION,
  CHECK_CATEGORIES,
  VERIFY_MIGRATION_LANE,
  VERIFY_MIGRATION_SCHEMA_VERSION,
} from './constants';
import { isFullGitSha, scanForForbiddenReportContent, shortSha } from './privacy';

export { scanForForbiddenReportContent };

const shortShaSchema = z.string().regex(/^[a-f\d]{7,12}$/u, 'must be a short lowercase git sha');

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u, 'must be a lowercase SHA-256 digest');

const checkResultSchema = z.enum(['passed', 'failed', 'unverified', 'skipped']);

const checkEntrySchema = z
  .object({
    category: z.enum(CHECK_CATEGORIES),
    durationMs: z.number().finite().nonnegative(),
    result: checkResultSchema,
  })
  .strict();

const rowCountMapSchema = z.record(z.string().max(64), z.number().int().nonnegative());

const reportCoreSchema = z
  .object({
    baseline: z
      .object({
        commitShort: shortShaSchema,
        lastTag: z.string().max(96),
        match: z.enum(['passed', 'failed']),
        migrationCount: z.number().int().positive(),
        version: z.literal(BASELINE_VERSION),
      })
      .strict(),
    checks: z.array(checkEntrySchema).min(1),
    cleanupResult: z.enum(['failed', 'passed']),
    elapsed: z.object({ milliseconds: z.number().finite().nonnegative() }).strict(),
    externalDump: z
      .object({
        byteLength: z.number().int().nonnegative().optional(),
        contentSha256: sha256Schema.optional(),
        privacy: z.enum(['passed', 'failed', 'not-applicable']).optional(),
        status: z.enum(['absent', 'privacy-rejected', 'privacy-verified', 'unverified']),
      })
      .strict(),
    fixture: z
      .object({
        rowCounts: rowCountMapSchema,
        source: z.enum(['external-dump', 'synthetic']),
        status: z.enum(['failed', 'loaded', 'skipped']),
      })
      .strict(),
    head: z
      .object({
        commitShort: shortShaSchema,
        postBaselineMigrationCount: z.number().int().nonnegative(),
        totalMigrationCount: z.number().int().positive(),
      })
      .strict(),
    lane: z.literal(VERIFY_MIGRATION_LANE),
    ownedResource: z
      .object({
        kind: z.enum(['container-database', 'none']),
        /** Opaque owned resource id (never a connection string). */
        resourceId: z
          .string()
          .regex(/^[a-z0-9_]{8,64}$/u)
          .optional(),
      })
      .strict(),
    overall: z.enum(['failed', 'passed', 'unverified']),
    rerun: z
      .object({
        mode: z.enum(['explicit-fail', 'idempotent']),
        result: z.enum(['failed', 'passed', 'skipped']),
      })
      .strict(),
    schemaVersion: z.literal(VERIFY_MIGRATION_SCHEMA_VERSION),
    syntheticResult: z.enum(['failed', 'passed']),
  })
  .strict();

export const migrationCompatReportSchema = reportCoreSchema
  .extend({
    redactionScan: z
      .object({
        result: z.enum(['failed', 'passed']),
        violations: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type MigrationCompatReport = z.infer<typeof migrationCompatReportSchema>;
export type MigrationCompatReportCore = z.infer<typeof reportCoreSchema>;
export type CheckEntry = z.infer<typeof checkEntrySchema>;

export const createMigrationCompatReport = (
  input: MigrationCompatReportCore,
): MigrationCompatReport => {
  const redactionScan = scanForForbiddenReportContent(input);
  if (redactionScan.result === 'failed') {
    throw new Error(
      `Migration-compat report redaction rejected ${redactionScan.violations} forbidden field(s)`,
    );
  }

  const core = reportCoreSchema.parse(input);
  return migrationCompatReportSchema.parse({
    ...core,
    redactionScan,
  });
};

export const isPassingSyntheticReport = (report: MigrationCompatReport): boolean => {
  const parsed = migrationCompatReportSchema.safeParse(report);
  if (!parsed.success) return false;
  const { cleanupResult, redactionScan, syntheticResult } = parsed.data;
  return (
    syntheticResult === 'passed' &&
    cleanupResult === 'passed' &&
    redactionScan.result === 'passed' &&
    redactionScan.violations === 0
  );
};

/**
 * Overall "passed" is reserved for a future dump-restore + upgrade path.
 * This Wave2-A foundation never claims production-dump success:
 * - synthetic success + absent/unverified dump → overall=unverified
 * - privacy-verified dump (intake only, not applied) → overall=unverified
 * - privacy-rejected dump or synthetic/cleanup failure → overall=failed
 */
export const deriveOverallResult = (input: {
  cleanupResult: 'failed' | 'passed';
  externalDumpStatus: MigrationCompatReportCore['externalDump']['status'];
  syntheticResult: 'failed' | 'passed';
}): MigrationCompatReportCore['overall'] => {
  if (input.syntheticResult === 'failed' || input.cleanupResult === 'failed') return 'failed';
  if (input.externalDumpStatus === 'privacy-rejected') return 'failed';
  // Foundation does not apply external dumps yet — never overall=passed.
  return 'unverified';
};

export const toReportCommitShort = (fullSha: string): string => {
  if (!isFullGitSha(fullSha) && !/^[a-f\d]{7,40}$/iu.test(fullSha)) {
    throw new Error('Invalid git sha for report');
  }
  return shortSha(fullSha.toLowerCase());
};
