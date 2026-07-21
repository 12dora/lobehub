/**
 * Versioned strict Zod contract for security-acceptance reports and check artifacts.
 * Integrity core binds full artifacts (excluding wall-clock envelope fields).
 */
import { z } from 'zod';

import {
  CHECK_STATUSES,
  DEPENDENCY_FAIL_SEVERITIES,
  DEPENDENCY_SCANNER_ID,
  EVIDENCE_CLASS,
  EXTERNAL_PEN_TEST_STATUS,
  OVERALL_STATUSES,
  REQUIRED_CHECK_IDS,
  SECURITY_ACCEPTANCE_LANE,
  SECURITY_ACCEPTANCE_SCHEMA_VERSION,
} from './constants';
import { scanForForbiddenReportContent } from './privacy';

const fullShaSchema = z.string().regex(/^[a-f\d]{40}$/u, 'must be a full lowercase git sha');
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u, 'must be a lowercase SHA-256 digest');
const safeIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'must be a lowercase kebab identifier');

const checkStatusSchema = z.enum(CHECK_STATUSES);

const assertionSummarySchema = z
  .object({
    failed: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine(({ failed, passed, skipped, total }, context) => {
    if (failed + passed + skipped !== total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assertion counts must add up to total',
      });
    }
  });

const severityCountsSchema = z
  .object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    moderate: z.number().int().nonnegative(),
  })
  .strict();

/** Repo-relative only: no absolute, no `..` segments. */
const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w.@/-]+$/u, 'must be a safe repo-relative path');

/** Dependency-scan check artifact (machine-readable evidence). */
export const dependencyScanArtifactSchema = z
  .object({
    checkId: z.literal('dependency-scan'),
    /** Process exit code from the scanner when a process ran. */
    exitCode: z.number().int().min(0).max(255).optional(),
    failSeverities: z.array(z.enum(DEPENDENCY_FAIL_SEVERITIES)).min(1),
    policyHits: z.number().int().nonnegative(),
    reason: safeIdSchema.optional(),
    schemaVersion: z.literal(SECURITY_ACCEPTANCE_SCHEMA_VERSION),
    severityCounts: severityCountsSchema.optional(),
    status: checkStatusSchema,
    target: z
      .object({
        kind: z.enum(['pnpm-lock', 'package-json']),
        lockfileSha256: sha256Schema.optional(),
        packageJsonSha256: sha256Schema.optional(),
        path: relativePathSchema,
      })
      .strict(),
    tool: z
      .object({
        id: z.literal(DEPENDENCY_SCANNER_ID),
        version: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[\w.+-]+$/u, 'must be a short tool version'),
      })
      .strict(),
  })
  .strict();

export type DependencyScanArtifact = z.infer<typeof dependencyScanArtifactSchema>;

const leakageFindingSchema = z
  .object({
    category: safeIdSchema,
    line: z.number().int().positive(),
    lineDigest: sha256Schema,
    path: relativePathSchema,
  })
  .strict();

const leakageCoverageSchema = z
  .object({
    baselinedMatches: z.number().int().nonnegative(),
    filesScanned: z.number().int().nonnegative(),
    oversizedSkipped: z.number().int().nonnegative(),
    rootsMissing: z.number().int().nonnegative(),
    rootsPresent: z.number().int().nonnegative(),
    rootsRequired: z.number().int().positive(),
    symlinkEncounters: z.number().int().nonnegative(),
    unreadableFiles: z.number().int().nonnegative(),
    walkErrors: z.number().int().nonnegative(),
  })
  .strict();

export const leakageScanArtifactSchema = z
  .object({
    allowlistedMatches: z.number().int().nonnegative(),
    baselinedMatches: z.number().int().nonnegative(),
    checkId: z.literal('leakage-scan'),
    coverage: leakageCoverageSchema,
    findings: z.array(leakageFindingSchema).max(500),
    filesScanned: z.number().int().nonnegative(),
    reason: safeIdSchema.optional(),
    schemaVersion: z.literal(SECURITY_ACCEPTANCE_SCHEMA_VERSION),
    status: checkStatusSchema,
    violationCount: z.number().int().nonnegative(),
  })
  .strict();

export type LeakageScanArtifact = z.infer<typeof leakageScanArtifactSchema>;

const penAdapterResultSchema = z
  .object({
    adapterId: safeIdSchema,
    assertions: assertionSummarySchema.optional(),
    category: safeIdSchema,
    exitCode: z.number().int().min(0).max(255).optional(),
    reason: safeIdSchema.optional(),
    /** Exact vitest assertion titles that were skipped (order stable by title). */
    skippedTitles: z.array(z.string().min(1).max(256)).max(32).optional(),
    status: checkStatusSchema,
    targets: z.array(relativePathSchema).min(1).max(32),
  })
  .strict();

export const penRegressionArtifactSchema = z
  .object({
    adapters: z.array(penAdapterResultSchema).min(1).max(32),
    checkId: z.literal('pen-regression'),
    reason: safeIdSchema.optional(),
    schemaVersion: z.literal(SECURITY_ACCEPTANCE_SCHEMA_VERSION),
    status: checkStatusSchema,
  })
  .strict();

export type PenRegressionArtifact = z.infer<typeof penRegressionArtifactSchema>;

const checkSummarySchema = z
  .object({
    checkId: z.enum(REQUIRED_CHECK_IDS),
    reason: safeIdSchema.optional(),
    status: checkStatusSchema,
  })
  .strict();

const artifactsSchema = z
  .object({
    'dependency-scan': dependencyScanArtifactSchema,
    'leakage-scan': leakageScanArtifactSchema,
    'pen-regression': penRegressionArtifactSchema,
  })
  .strict();

/**
 * Integrity core: deterministic, no wall-clock. Includes full artifacts so
 * forgeries that change counts/status without rebinding digests fail verify.
 */
export const securityAcceptanceReportCoreObjectSchema = z
  .object({
    artifacts: artifactsSchema,
    checks: z.array(checkSummarySchema).length(REQUIRED_CHECK_IDS.length),
    evidenceClass: z.literal(EVIDENCE_CLASS),
    externalPenetrationTest: z
      .object({
        note: z.literal(
          'External human production penetration testing is residual and is not claimed by repository automation.',
        ),
        status: z.literal(EXTERNAL_PEN_TEST_STATUS),
      })
      .strict(),
    gitSha: fullShaSchema,
    lane: z.literal(SECURITY_ACCEPTANCE_LANE),
    overall: z.enum(OVERALL_STATUSES),
    policy: z
      .object({
        dependencyFailSeverities: z.array(z.enum(DEPENDENCY_FAIL_SEVERITIES)).min(1),
      })
      .strict(),
    schemaVersion: z.literal(SECURITY_ACCEPTANCE_SCHEMA_VERSION),
  })
  .strict();

export const securityAcceptanceReportCoreSchema = securityAcceptanceReportCoreObjectSchema;

export type SecurityAcceptanceReportCore = z.infer<typeof securityAcceptanceReportCoreSchema>;

export const securityAcceptanceReportSchema = securityAcceptanceReportCoreObjectSchema
  .extend({
    generatedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
    integrity: z
      .object({
        redactionScan: z
          .object({
            result: z.enum(['failed', 'passed']),
            violations: z.number().int().nonnegative(),
          })
          .strict(),
        reportCoreSha256: sha256Schema,
        schemaValid: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.integrity.redactionScan.result !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'report failed redaction scan',
        path: ['integrity', 'redactionScan'],
      });
    }
    const privacy = scanForForbiddenReportContent(report);
    if (privacy.result !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `forbidden report content (${privacy.violations})`,
        path: ['integrity'],
      });
    }
  });

export type SecurityAcceptanceReport = z.infer<typeof securityAcceptanceReportSchema>;

/** Baseline file schema (reviewed exact fingerprints; no secret text). */
export const leakageBaselineSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            category: safeIdSchema,
            lineDigest: sha256Schema,
            path: relativePathSchema,
          })
          .strict(),
      )
      .max(50_000),
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((baseline, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of baseline.entries.entries()) {
      const key = `${entry.path}\u0000${entry.category}\u0000${entry.lineDigest}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'duplicate baseline fingerprint',
          path: ['entries', index],
        });
      }
      seen.add(key);
    }
  });

export type LeakageBaseline = z.infer<typeof leakageBaselineSchema>;
