/**
 * Versioned strict Zod contract for security-acceptance reports and check artifacts.
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

/** Dependency-scan check artifact (machine-readable evidence). */
export const dependencyScanArtifactSchema = z
  .object({
    checkId: z.literal('dependency-scan'),
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
        path: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[\w./-]+$/u, 'must be a safe relative path'),
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
    path: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\w.@/-]+$/u, 'must be a safe relative path'),
  })
  .strict();

export const leakageScanArtifactSchema = z
  .object({
    allowlistedMatches: z.number().int().nonnegative(),
    checkId: z.literal('leakage-scan'),
    findings: z.array(leakageFindingSchema).max(500),
    filesScanned: z.number().int().nonnegative(),
    reason: safeIdSchema.optional(),
    schemaVersion: z.literal(SECURITY_ACCEPTANCE_SCHEMA_VERSION),
    status: checkStatusSchema,
    violationCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.violationCount !== artifact.findings.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'violationCount must equal findings length',
        path: ['violationCount'],
      });
    }
  });

export type LeakageScanArtifact = z.infer<typeof leakageScanArtifactSchema>;

const penAdapterResultSchema = z
  .object({
    adapterId: safeIdSchema,
    assertions: assertionSummarySchema.optional(),
    category: safeIdSchema,
    exitCode: z.number().int().min(0).max(255).optional(),
    reason: safeIdSchema.optional(),
    status: checkStatusSchema,
    targets: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .regex(/^[\w.@/-]+$/u, 'must be a safe relative path'),
      )
      .min(1)
      .max(32),
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

/**
 * Report core is digested without wall-clock fields.
 * `generatedAt` lives only on the envelope outside the core digest input.
 * Base object is kept extendable; refinements attach after extend.
 */
const securityAcceptanceReportCoreObjectSchema = z
  .object({
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

const refineReportCore = (
  core: z.infer<typeof securityAcceptanceReportCoreObjectSchema>,
  context: z.RefinementCtx,
) => {
  const ids = core.checks.map((check) => check.checkId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'check ids must be unique',
      path: ['checks'],
    });
  }
  for (const required of REQUIRED_CHECK_IDS) {
    if (!ids.includes(required)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `missing required check: ${required}`,
        path: ['checks'],
      });
    }
  }
};

export const securityAcceptanceReportCoreSchema =
  securityAcceptanceReportCoreObjectSchema.superRefine(refineReportCore);

export type SecurityAcceptanceReportCore = z.infer<typeof securityAcceptanceReportCoreSchema>;

export const securityAcceptanceReportSchema = securityAcceptanceReportCoreObjectSchema
  .extend({
    artifacts: z
      .object({
        'dependency-scan': dependencyScanArtifactSchema,
        'leakage-scan': leakageScanArtifactSchema,
        'pen-regression': penRegressionArtifactSchema,
      })
      .strict(),
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
    refineReportCore(report, context);

    // Overall must never be passed when any required check is non-passing.
    const nonPass = report.checks.filter((check) => check.status !== 'passed');
    if (report.overall === 'passed' && nonPass.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'overall=passed requires every required check to pass',
        path: ['overall'],
      });
    }
    // Artifacts must agree with summary statuses.
    for (const check of report.checks) {
      const artifact = report.artifacts[check.checkId];
      if (artifact.status !== check.status) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `artifact status mismatch for ${check.checkId}`,
          path: ['artifacts', check.checkId, 'status'],
        });
      }
    }
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

export const isSecurityAcceptancePassed = (report: SecurityAcceptanceReport): boolean => {
  const parsed = securityAcceptanceReportSchema.safeParse(report);
  if (!parsed.success) return false;
  return (
    parsed.data.overall === 'passed' &&
    parsed.data.evidenceClass === EVIDENCE_CLASS &&
    parsed.data.externalPenetrationTest.status === EXTERNAL_PEN_TEST_STATUS &&
    parsed.data.checks.every((check) => check.status === 'passed') &&
    parsed.data.integrity.redactionScan.result === 'passed' &&
    parsed.data.integrity.schemaValid === true
  );
};
