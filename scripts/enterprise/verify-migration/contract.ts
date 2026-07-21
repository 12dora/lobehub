import { z } from 'zod';

import {
  BASELINE_VERSION,
  CHECK_CATEGORIES,
  VERIFY_MIGRATION_LANE,
  VERIFY_MIGRATION_SCHEMA_VERSION,
} from './constants';
import { isFullGitSha, scanForForbiddenReportContent, shortSha } from './privacy';

export { scanForForbiddenReportContent };

/** Categories that must appear exactly once on a Wave2-A synthetic foundation report. */
export const REQUIRED_GATE_CATEGORIES = CHECK_CATEGORIES;

/** Categories that must result in `passed` for gatePassed (external-dump may be unverified). */
export const REQUIRED_PASSING_CATEGORIES = CHECK_CATEGORIES.filter(
  (category) => category !== 'external-dump',
);

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
    /** Full lowercase candidate SHA when known (Q06 binding). */
    candidateSha: z
      .string()
      .regex(/^[a-f\d]{40}$/u)
      .optional(),
    /** Immutable seal time (ISO) for freshness (Q06). */
    generatedAt: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
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

const checkCategoryIndex = (checks: Array<{ category: string; result: string }>) => {
  const byCategory = new Map<string, string>();
  for (const check of checks) {
    if (byCategory.has(check.category)) {
      return { duplicate: check.category as (typeof CHECK_CATEGORIES)[number], map: byCategory };
    }
    byCategory.set(check.category, check.result);
  }
  return { duplicate: undefined, map: byCategory };
};

const refineReportConsistency = (
  value: z.infer<typeof reportCoreSchema>,
  context: z.RefinementCtx,
): void => {
  // Wave2-A: external dump is never applied — overall may never be passed.
  if (value.overall === 'passed') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Wave2-A overall cannot be passed (external dump not applied)',
      path: ['overall'],
    });
  }

  const { duplicate, map } = checkCategoryIndex(value.checks);
  if (duplicate) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `duplicate check category: ${duplicate}`,
      path: ['checks'],
    });
  }

  // Owned resource pairing.
  if (value.ownedResource.kind === 'none' && value.ownedResource.resourceId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'ownedResource.kind=none cannot carry resourceId',
      path: ['ownedResource'],
    });
  }
  if (value.ownedResource.kind === 'container-database' && !value.ownedResource.resourceId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'container-database requires resourceId',
      path: ['ownedResource'],
    });
  }

  // Cross-field: cleanupResult must match cleanup check when present.
  const cleanupCheck = map.get('cleanup');
  if (cleanupCheck) {
    if (value.cleanupResult === 'passed' && cleanupCheck !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cleanupResult/check mismatch',
        path: ['cleanupResult'],
      });
    }
    if (value.cleanupResult === 'failed' && cleanupCheck === 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cleanupResult/check mismatch',
        path: ['cleanupResult'],
      });
    }
  }

  // Cross-field: rerun.result must match rerun check when present.
  const rerunCheck = map.get('rerun');
  if (rerunCheck && value.rerun.result !== rerunCheck) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'rerun.result/check mismatch',
      path: ['rerun'],
    });
  }

  // Cross-field: baseline.match must match baseline check when present.
  const baselineCheck = map.get('baseline');
  if (baselineCheck) {
    if (value.baseline.match === 'passed' && baselineCheck !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseline.match/check mismatch',
        path: ['baseline'],
      });
    }
    if (value.baseline.match === 'failed' && baselineCheck === 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseline.match/check mismatch',
        path: ['baseline'],
      });
    }
  }

  // Every schemaVersion=1 report must list each required category exactly once.
  for (const category of REQUIRED_GATE_CATEGORIES) {
    if (!map.has(category)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `missing required check category: ${category}`,
        path: ['checks'],
      });
    }
  }
  if (value.checks.length !== REQUIRED_GATE_CATEGORIES.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'report requires exactly the required check categories (no extras)',
      path: ['checks'],
    });
  }

  // syntheticResult=failed always forces overall=failed (align with deriveOverallResult).
  if (value.syntheticResult === 'failed' && value.overall !== 'failed') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'syntheticResult=failed requires overall=failed',
      path: ['overall'],
    });
  }

  // Synthetic success requires the full gate shape.
  if (value.syntheticResult === 'passed') {
    if (value.overall !== 'unverified') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'synthetic success must leave overall=unverified',
        path: ['overall'],
      });
    }
    if (value.baseline.match !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'synthetic success requires baseline.match=passed',
        path: ['baseline'],
      });
    }
    if (value.fixture.status !== 'loaded' || value.fixture.source !== 'synthetic') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'synthetic success requires loaded synthetic fixture',
        path: ['fixture'],
      });
    }
    if (value.cleanupResult !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'synthetic success requires cleanupResult=passed',
        path: ['cleanupResult'],
      });
    }
    if (value.rerun.result !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'synthetic success requires rerun.result=passed',
        path: ['rerun'],
      });
    }
    if (value.ownedResource.kind !== 'container-database' || !value.ownedResource.resourceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'synthetic success requires owned container-database resourceId',
        path: ['ownedResource'],
      });
    }
    if (
      value.externalDump.status === 'privacy-rejected' ||
      value.externalDump.privacy === 'failed'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'synthetic success cannot pair with rejected dump privacy',
        path: ['externalDump'],
      });
    }

    for (const category of REQUIRED_PASSING_CATEGORIES) {
      if (map.get(category) !== 'passed') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `required check must pass: ${category}`,
          path: ['checks'],
        });
      }
    }

    const externalDumpResult = map.get('external-dump');
    if (externalDumpResult !== 'passed' && externalDumpResult !== 'unverified') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'external-dump must be passed or unverified for synthetic success',
        path: ['checks'],
      });
    }
  }
};

export const migrationCompatReportCoreSchema =
  reportCoreSchema.superRefine(refineReportConsistency);

export const migrationCompatReportSchema = reportCoreSchema
  .extend({
    redactionScan: z
      .object({
        result: z.enum(['failed', 'passed']),
        violations: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    refineReportConsistency(value, context);
    if (
      (value.redactionScan.result !== 'passed' || value.redactionScan.violations !== 0) && // Still allow constructing reports that failed redaction only via createMigrationCompatReport throw.
      // If present on a synthetic success, reject.
      value.syntheticResult === 'passed'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'synthetic success requires redactionScan.passed',
        path: ['redactionScan'],
      });
    }
  });

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

  const core = migrationCompatReportCoreSchema.parse(input);
  return migrationCompatReportSchema.parse({
    ...core,
    redactionScan,
  });
};

/**
 * Gate semantics for Wave2-A synthetic foundation success.
 * External dump remains unapplied → overall must be unverified (never passed).
 */
export const gatePassed = (report: MigrationCompatReport): boolean => {
  const parsed = migrationCompatReportSchema.safeParse(report);
  if (!parsed.success) return false;
  const data = parsed.data;
  if (data.overall === 'passed') return false;
  if (data.syntheticResult !== 'passed') return false;
  if (data.overall !== 'unverified') return false;
  if (data.baseline.match !== 'passed') return false;
  if (data.fixture.status !== 'loaded' || data.fixture.source !== 'synthetic') return false;
  if (data.cleanupResult !== 'passed') return false;
  if (data.rerun.result !== 'passed') return false;
  if (data.redactionScan.result !== 'passed' || data.redactionScan.violations !== 0) return false;
  if (data.ownedResource.kind !== 'container-database' || !data.ownedResource.resourceId) {
    return false;
  }
  if (data.externalDump.status === 'privacy-rejected') return false;

  const { duplicate, map } = checkCategoryIndex(data.checks);
  if (duplicate) return false;
  if (data.checks.length !== REQUIRED_GATE_CATEGORIES.length) return false;
  for (const category of REQUIRED_GATE_CATEGORIES) {
    if (!map.has(category)) return false;
  }
  for (const category of REQUIRED_PASSING_CATEGORIES) {
    if (map.get(category) !== 'passed') return false;
  }
  const externalDumpResult = map.get('external-dump');
  if (externalDumpResult !== 'passed' && externalDumpResult !== 'unverified') return false;
  return true;
};

/** @deprecated Prefer gatePassed — same synthetic foundation gate. */
export const isPassingSyntheticReport = (report: MigrationCompatReport): boolean =>
  gatePassed(report);

/**
 * Overall "passed" is reserved for a future dump-restore + upgrade path.
 * This Wave2-A foundation never claims production-dump success.
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

/** Build a complete checks array for unit fixtures (every required category once). */
export const buildFullPassingChecks = (
  overrides: Partial<Record<(typeof CHECK_CATEGORIES)[number], CheckEntry['result']>> = {},
): CheckEntry[] =>
  CHECK_CATEGORIES.map((category) => ({
    category,
    durationMs: 1,
    result:
      overrides[category] ??
      (category === 'external-dump' ? ('unverified' as const) : ('passed' as const)),
  }));

/**
 * Complete failed-path fixture: all 14 categories present; most skipped/failed.
 * Used to prove schema accepts only full-shape failure reports.
 */
export const buildFullFailedChecks = (
  overrides: Partial<Record<(typeof CHECK_CATEGORIES)[number], CheckEntry['result']>> = {},
): CheckEntry[] =>
  CHECK_CATEGORIES.map((category) => ({
    category,
    durationMs: 1,
    result:
      overrides[category] ??
      (category === 'baseline' || category === 'journal-snapshot' || category === 'expand-only'
        ? ('passed' as const)
        : category === 'external-dump'
          ? ('failed' as const)
          : category === 'cleanup'
            ? ('passed' as const)
            : ('skipped' as const)),
  }));
