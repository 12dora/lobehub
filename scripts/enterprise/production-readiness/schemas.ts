/**
 * Versioned strict Zod schemas for production preflight, release plans,
 * evidence envelopes, and final readiness reports.
 */
import { z } from 'zod';

import {
  ALLOWLISTED_COMMAND_IDS,
  APP_ROLLBACK_LANE,
  APP_ROLLBACK_SCHEMA_VERSION,
  BACKUP_RESTORE_LANE,
  BACKUP_RESTORE_SCHEMA_VERSION,
  BASELINE_COMMIT,
  CHECK_RESULTS,
  EVIDENCE_SCOPES,
  type EvidenceGateId,
  FIRST_ENABLE_HIGH_RISK,
  HIGH_RISK_CAPABILITIES,
  MILESTONE_WINDOW_IDS,
  PREFLIGHT_MODES,
  PRODUCTION_READINESS_LANE,
  PRODUCTION_READINESS_SCHEMA_VERSION,
  REQUIRED_EVIDENCE_GATES,
} from './constants';
import { scanForForbiddenReportContent } from './privacy';

const fullShaSchema = z.string().regex(/^[a-f\d]{40}$/u, 'must be a full lowercase git sha');
const shortSha12Schema = z.string().regex(/^[a-f\d]{12}$/u, 'must be a 12-char lowercase git sha');
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u, 'must be a lowercase SHA-256 digest');
const isoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime())
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a parseable ISO timestamp');

const safeIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'must be a lowercase kebab identifier');

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

export const releaseCandidateSchema = z
  .object({
    dirty: z.literal(false),
    gitSha: fullShaSchema,
    latestMigrationTag: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.-]+$/u, 'must be a stable migration tag'),
    releaseId: safeIdSchema,
    schemaVersion: z.literal(PRODUCTION_READINESS_SCHEMA_VERSION),
  })
  .strict();

export type ReleaseCandidate = z.infer<typeof releaseCandidateSchema>;

const stopConditionSchema = z
  .object({
    comparator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
    id: safeIdSchema,
    metricId: safeIdSchema,
    threshold: z.number().finite(),
  })
  .strict();

const releaseWindowSchema = z
  .object({
    approval: z.enum(['recorded', 'required']),
    firstEnableCapability: z.enum(HIGH_RISK_CAPABILITIES),
    forwardCommandIds: z.array(z.enum(ALLOWLISTED_COMMAND_IDS)).min(1).max(16),
    id: z.enum(MILESTONE_WINDOW_IDS),
    metricIds: z.array(safeIdSchema).min(1).max(32),
    monitorDurationMinutes: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60),
    order: z.number().int().min(1).max(6),
    ownerRole: safeIdSchema,
    prerequisites: z.array(safeIdSchema).max(32),
    rollbackCommandIds: z.array(z.enum(ALLOWLISTED_COMMAND_IDS)).min(1).max(16),
    rollbackVerificationCommandIds: z.array(z.enum(ALLOWLISTED_COMMAND_IDS)).min(1).max(16),
    stopConditions: z.array(stopConditionSchema).min(1).max(32),
  })
  .strict();

export const releasePlanSchema = z
  .object({
    candidateGitSha: fullShaSchema,
    releaseId: safeIdSchema,
    schemaVersion: z.literal(PRODUCTION_READINESS_SCHEMA_VERSION),
    windows: z.array(releaseWindowSchema).length(MILESTONE_WINDOW_IDS.length),
  })
  .strict()
  .superRefine((plan, context) => {
    const orders = plan.windows.map((window) => window.order).sort((a, b) => a - b);
    if (orders.join(',') !== '1,2,3,4,5,6') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'windows must define unique orders 1..6',
        path: ['windows'],
      });
    }

    const ids = plan.windows.map((window) => window.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'window ids must be unique',
        path: ['windows'],
      });
    }
    for (const expected of MILESTONE_WINDOW_IDS) {
      if (!ids.includes(expected)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing required window id: ${expected}`,
          path: ['windows'],
        });
      }
    }

    const firstEnables = plan.windows
      .map((window) => window.firstEnableCapability)
      .filter((capability) => capability !== 'none');
    if (new Set(firstEnables).size !== firstEnables.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'each high-risk capability may first-enable in only one window',
        path: ['windows'],
      });
    }
    for (const required of FIRST_ENABLE_HIGH_RISK) {
      if (!firstEnables.includes(required)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing first-enable window for high-risk capability: ${required}`,
          path: ['windows'],
        });
      }
    }

    for (const [index, window] of plan.windows.entries()) {
      const commandSets = [
        window.forwardCommandIds,
        window.rollbackCommandIds,
        window.rollbackVerificationCommandIds,
      ];
      for (const set of commandSets) {
        if (new Set(set).size !== set.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'command ids within a list must be unique',
            path: ['windows', index],
          });
        }
      }
      const stopIds = window.stopConditions.map((condition) => condition.id);
      if (new Set(stopIds).size !== stopIds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'stop condition ids must be unique within a window',
          path: ['windows', index, 'stopConditions'],
        });
      }
      for (const condition of window.stopConditions) {
        if (!window.metricIds.includes(condition.metricId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `stop condition metric ${condition.metricId} not listed in metricIds`,
            path: ['windows', index, 'stopConditions'],
          });
        }
      }
    }
  });

export type ReleasePlan = z.infer<typeof releasePlanSchema>;

/** Freshness envelope shared by all evidence inputs. */
const evidenceFreshnessSchema = z
  .object({
    generatedAt: isoTimestampSchema,
    observedAt: isoTimestampSchema.optional(),
  })
  .strict();

const evidenceBaseFields = {
  candidateSha: fullShaSchema,
  freshness: evidenceFreshnessSchema,
  schemaVersion: z.literal(PRODUCTION_READINESS_SCHEMA_VERSION),
  scope: z.enum(EVIDENCE_SCOPES),
  status: z.enum(CHECK_RESULTS),
} as const;

/**
 * Q02 path-boundary evidence. Rejects report-existence-only and non-zero violations.
 */
export const pathBoundariesEvidenceSchema = z
  .object({
    ...evidenceBaseFields,
    gate: z.literal('path-boundaries'),
    filesScanned: z.number().int().positive(),
    violationCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'passed' && value.violationCount !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'path-boundaries passed requires violationCount=0',
        path: ['violationCount'],
      });
    }
    if (value.status === 'passed' && value.filesScanned < 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'path-boundaries passed requires filesScanned>0',
        path: ['filesScanned'],
      });
    }
  });

/**
 * Q03 migration foundation evidence (explicitly not app rollback).
 * overall=passed is reserved for dump-applied production paths; foundation uses gatePassed.
 */
export const migrationCompatEvidenceSchema = z
  .object({
    ...evidenceBaseFields,
    gate: z.literal('migration-compat'),
    foundationGatePassed: z.boolean(),
    headCommitShort: shortSha12Schema.or(z.string().regex(/^[a-f\d]{7,12}$/u)),
    lane: z.literal('enterprise-migration-compat'),
    overall: z.enum(['failed', 'passed', 'unverified']),
    reportSchemaVersion: z.literal(1),
    rerunResult: z.enum(['failed', 'passed', 'skipped']),
    syntheticResult: z.enum(['failed', 'passed']),
    totalMigrationCount: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'passed') {
      if (!value.foundationGatePassed) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'migration passed requires foundationGatePassed',
          path: ['foundationGatePassed'],
        });
      }
      if (value.syntheticResult !== 'passed') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'migration passed requires syntheticResult=passed',
          path: ['syntheticResult'],
        });
      }
      if (value.rerunResult !== 'passed') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'migration passed requires rerunResult=passed (no journal-only substitute)',
          path: ['rerunResult'],
        });
      }
      // Production overall=passed is only valid for dump-applied paths; foundation stays unverified.
      if (value.scope === 'production-authorized' && value.overall !== 'passed') {
        // Foundation-only production claims are not accepted as production migration pass.
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'production-authorized migration status=passed requires overall=passed (dump-applied)',
          path: ['overall'],
        });
      }
    }
    if (value.overall === 'passed' && value.scope !== 'production-authorized') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'overall=passed is reserved for production-authorized dump-applied evidence',
        path: ['overall'],
      });
    }
  });

/**
 * Q04 enterprise-admin E2E evidence. Zero assertions / all-skip / fake never pass.
 */
export const enterpriseAdminE2eEvidenceSchema = z
  .object({
    ...evidenceBaseFields,
    gate: z.literal('enterprise-admin-e2e'),
    assertions: assertionSummarySchema,
    screenshotCount: z.number().int().nonnegative(),
    suite: z.literal('enterprise-admin'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'passed') {
      if (value.assertions.total < 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'e2e passed requires total assertions > 0',
          path: ['assertions'],
        });
      }
      if (
        value.assertions.passed !== value.assertions.total ||
        value.assertions.failed !== 0 ||
        value.assertions.skipped !== 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'e2e passed requires all assertions passed with zero skipped/failed',
          path: ['assertions'],
        });
      }
      if (value.screenshotCount < 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'e2e passed requires screenshotCount >= 1',
          path: ['screenshotCount'],
        });
      }
    }
  });

/**
 * Q05 upstream rebase dry-run evidence binding.
 * Candidate short SHA must match preflight candidate; foreign reports rejected.
 */
export const upstreamRebaseEvidenceSchema = z
  .object({
    ...evidenceBaseFields,
    gate: z.literal('upstream-rebase'),
    candidateShort: shortSha12Schema,
    cleanupResult: z.enum(['failed', 'passed']),
    lane: z.literal('enterprise-upstream-rebase-dry-run'),
    reportStatus: z.enum(['clean', 'conflicts', 'drift']),
    requiredGateCount: z.number().int().positive(),
    upstreamFreshness: z.enum(['unverified', 'verified-by-ci-fetch']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'passed') {
      if (value.reportStatus !== 'clean') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'upstream-rebase passed requires clean reportStatus',
          path: ['reportStatus'],
        });
      }
      if (value.upstreamFreshness !== 'verified-by-ci-fetch') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'upstream-rebase passed requires verified freshness',
          path: ['upstreamFreshness'],
        });
      }
      if (value.cleanupResult !== 'passed') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'upstream-rebase passed requires cleanupResult=passed',
          path: ['cleanupResult'],
        });
      }
      if (value.candidateShort !== value.candidateSha.slice(0, 12)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'candidateShort must match candidateSha prefix',
          path: ['candidateShort'],
        });
      }
    }
  });

/**
 * O05 failure-drill summary evidence. Local fixtures cannot be production-passed.
 */
export const failureDrillsEvidenceSchema = z
  .object({
    ...evidenceBaseFields,
    gate: z.literal('failure-drills'),
    assertions: assertionSummarySchema,
    cleanupResult: z.enum(['failed', 'passed']),
    lane: z.literal('enterprise-failure-drills'),
    scenarioCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'passed') {
      if (
        value.assertions.total < 1 ||
        value.assertions.passed !== value.assertions.total ||
        value.assertions.failed !== 0 ||
        value.assertions.skipped !== 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'failure-drills passed requires positive all-pass assertions',
          path: ['assertions'],
        });
      }
      if (value.cleanupResult !== 'passed') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'failure-drills passed requires cleanupResult=passed',
          path: ['cleanupResult'],
        });
      }
      if (value.scenarioCount < 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'failure-drills passed requires scenarioCount >= 1',
          path: ['scenarioCount'],
        });
      }
      if (value.scope === 'local-harness') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'local-harness failure-drills cannot claim status=passed for production path',
          path: ['scope'],
        });
      }
    }
  });

const invariantResultSchema = z
  .object({
    id: safeIdSchema,
    result: z.enum(['failed', 'passed']),
  })
  .strict();

/**
 * Batch B backup/restore drill evidence consumed by preflight.
 */
export const backupRestoreEvidenceSchema = z
  .object({
    ...evidenceBaseFields,
    gate: z.literal('backup-restore'),
    assertions: assertionSummarySchema,
    cleanupResult: z.enum(['failed', 'passed']),
    dbSchemaVersionTag: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.-]+$/u),
    invariants: z.array(invariantResultSchema).min(1),
    lane: z.literal(BACKUP_RESTORE_LANE),
    reportSchemaVersion: z.literal(BACKUP_RESTORE_SCHEMA_VERSION),
    sourceBackupDigest: sha256Schema,
    sourcePreserved: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'passed') {
      if (
        value.assertions.total < 1 ||
        value.assertions.passed !== value.assertions.total ||
        value.assertions.failed !== 0 ||
        value.assertions.skipped !== 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'backup-restore passed requires positive all-pass assertions',
          path: ['assertions'],
        });
      }
      if (value.cleanupResult !== 'passed') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'backup-restore passed requires cleanupResult=passed',
          path: ['cleanupResult'],
        });
      }
      if (value.invariants.some((item) => item.result !== 'passed')) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'backup-restore passed requires all invariants passed',
          path: ['invariants'],
        });
      }
    }
  });

/**
 * Batch B application-version rollback compatibility evidence.
 * Never claims pass when baseline probe was unavailable.
 */
export const appRollbackEvidenceSchema = z
  .object({
    ...evidenceBaseFields,
    gate: z.literal('app-rollback'),
    assertions: assertionSummarySchema,
    baselineExecutable: z.boolean(),
    baselineSha: z.literal(BASELINE_COMMIT),
    cleanupResult: z.enum(['failed', 'passed']),
    destructiveCommandsRejected: z.boolean(),
    lane: z.literal(APP_ROLLBACK_LANE),
    newTablesRetained: z.boolean(),
    reportSchemaVersion: z.literal(APP_ROLLBACK_SCHEMA_VERSION),
    rollForwardOk: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'passed') {
      if (!value.baselineExecutable) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'app-rollback passed requires baselineExecutable=true',
          path: ['baselineExecutable'],
        });
      }
      if (!value.newTablesRetained || !value.destructiveCommandsRejected || !value.rollForwardOk) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'app-rollback passed requires retain/reject/roll-forward invariants',
          path: ['newTablesRetained'],
        });
      }
      if (
        value.assertions.total < 1 ||
        value.assertions.passed !== value.assertions.total ||
        value.assertions.failed !== 0 ||
        value.assertions.skipped !== 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'app-rollback passed requires positive all-pass assertions',
          path: ['assertions'],
        });
      }
      if (value.cleanupResult !== 'passed') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'app-rollback passed requires cleanupResult=passed',
          path: ['cleanupResult'],
        });
      }
    }
    if (!value.baselineExecutable && value.status === 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unavailable baseline cannot pass',
        path: ['status'],
      });
    }
  });

// z.union (not discriminatedUnion): superRefine yields ZodEffects, which
// cannot be members of a Zod discriminated union.
export const evidenceEnvelopeSchema = z.union([
  pathBoundariesEvidenceSchema,
  migrationCompatEvidenceSchema,
  enterpriseAdminE2eEvidenceSchema,
  upstreamRebaseEvidenceSchema,
  failureDrillsEvidenceSchema,
  backupRestoreEvidenceSchema,
  appRollbackEvidenceSchema,
]);

export type EvidenceEnvelope = z.infer<typeof evidenceEnvelopeSchema>;
export type PathBoundariesEvidence = z.infer<typeof pathBoundariesEvidenceSchema>;
export type MigrationCompatEvidence = z.infer<typeof migrationCompatEvidenceSchema>;
export type EnterpriseAdminE2eEvidence = z.infer<typeof enterpriseAdminE2eEvidenceSchema>;
export type UpstreamRebaseEvidence = z.infer<typeof upstreamRebaseEvidenceSchema>;
export type FailureDrillsEvidence = z.infer<typeof failureDrillsEvidenceSchema>;
export type BackupRestoreEvidence = z.infer<typeof backupRestoreEvidenceSchema>;
export type AppRollbackEvidence = z.infer<typeof appRollbackEvidenceSchema>;

const checkEntrySchema = z
  .object({
    durationMs: z.number().finite().nonnegative(),
    gate: z.enum(REQUIRED_EVIDENCE_GATES),
    result: z.enum(CHECK_RESULTS),
    scope: z.enum(EVIDENCE_SCOPES).optional(),
  })
  .strict();

const windowEvalSchema = z
  .object({
    id: z.enum(MILESTONE_WINDOW_IDS),
    order: z.number().int().min(1).max(6),
    result: z.enum(['failed', 'passed']),
  })
  .strict();

const refineReportCore = (
  report: {
    checks: Array<{ gate: string; result: string; scope?: string }>;
    classification: string;
    cleanupResult: string;
    mode: string;
    overall: string;
    windows: Array<{ id: string; result: string }>;
  },
  context: z.RefinementCtx,
): void => {
  const gates = report.checks.map((check) => check.gate);
  if (new Set(gates).size !== gates.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'duplicate check gates are not allowed',
      path: ['checks'],
    });
  }
  for (const required of REQUIRED_EVIDENCE_GATES) {
    if (!gates.includes(required)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `missing required check gate: ${required}`,
        path: ['checks'],
      });
    }
  }
  if (report.checks.length !== REQUIRED_EVIDENCE_GATES.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'checks must include exactly the required evidence gates',
      path: ['checks'],
    });
  }

  if (report.overall === 'passed' && report.classification !== 'production-authorized') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'overall=passed requires classification=production-authorized',
      path: ['overall'],
    });
  }
  if (report.mode === 'validate-harness' && report.overall === 'passed') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'validate-harness mode must never emit overall=passed',
      path: ['overall'],
    });
  }
  if (report.overall === 'passed') {
    for (const check of report.checks) {
      if (check.result !== 'passed') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'overall=passed requires every check passed',
          path: ['checks'],
        });
        break;
      }
      if (check.scope !== 'production-authorized') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'overall=passed requires every check scope=production-authorized',
          path: ['checks'],
        });
        break;
      }
    }
    if (report.cleanupResult !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'overall=passed requires cleanupResult=passed',
        path: ['cleanupResult'],
      });
    }
    if (report.windows.some((window) => window.result !== 'passed')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'overall=passed requires every release window valid',
        path: ['windows'],
      });
    }
  }

  const windowIds = report.windows.map((window) => window.id);
  if (new Set(windowIds).size !== windowIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'window evaluation ids must be unique',
      path: ['windows'],
    });
  }
};

const productionReadinessReportObjectSchema = z
  .object({
    candidate: z
      .object({
        gitSha: fullShaSchema,
        gitShaShort: shortSha12Schema,
        latestMigrationTag: z.string().min(1).max(128),
        releaseId: safeIdSchema,
      })
      .strict(),
    checks: z.array(checkEntrySchema).min(1),
    classification: z.enum(EVIDENCE_SCOPES),
    cleanupResult: z.enum(['failed', 'passed']),
    elapsed: z.object({ milliseconds: z.number().finite().nonnegative() }).strict(),
    lane: z.literal(PRODUCTION_READINESS_LANE),
    mode: z.enum(PREFLIGHT_MODES),
    overall: z.enum(['failed', 'passed', 'unverified']),
    schemaVersion: z.literal(PRODUCTION_READINESS_SCHEMA_VERSION),
    windows: z.array(windowEvalSchema).length(MILESTONE_WINDOW_IDS.length),
  })
  .strict();

export const productionReadinessReportCoreSchema =
  productionReadinessReportObjectSchema.superRefine(refineReportCore);

export type ProductionReadinessReportCore = z.infer<typeof productionReadinessReportObjectSchema>;

export const productionReadinessReportSchema = productionReadinessReportObjectSchema
  .extend({
    redactionScan: z
      .object({
        result: z.enum(['failed', 'passed']),
        violations: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    refineReportCore(report, context);
    if (
      report.overall === 'passed' &&
      (report.redactionScan.result !== 'passed' || report.redactionScan.violations !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'overall=passed requires redactionScan.passed',
        path: ['redactionScan'],
      });
    }
  });

export type ProductionReadinessReport = z.infer<typeof productionReadinessReportSchema>;

export const createProductionReadinessReport = (
  input: ProductionReadinessReportCore,
): ProductionReadinessReport => {
  const redactionScan = scanForForbiddenReportContent(input);
  if (redactionScan.result === 'failed') {
    throw new Error(
      `Production-readiness report redaction rejected ${redactionScan.violations} forbidden field(s)`,
    );
  }
  const core = productionReadinessReportCoreSchema.parse(input);
  return productionReadinessReportSchema.parse({
    ...core,
    redactionScan,
  });
};

export const isProductionPassed = (report: ProductionReadinessReport): boolean => {
  const parsed = productionReadinessReportSchema.safeParse(report);
  if (!parsed.success) return false;
  const data = parsed.data;
  return (
    data.overall === 'passed' &&
    data.classification === 'production-authorized' &&
    data.mode === 'production-authorized' &&
    data.cleanupResult === 'passed' &&
    data.redactionScan.result === 'passed' &&
    data.redactionScan.violations === 0 &&
    data.checks.every(
      (check) => check.result === 'passed' && check.scope === 'production-authorized',
    ) &&
    data.windows.every((window) => window.result === 'passed')
  );
};

export const sortChecksDeterministic = <T extends { gate: EvidenceGateId }>(checks: T[]): T[] => {
  const order = new Map(REQUIRED_EVIDENCE_GATES.map((gate, index) => [gate, index]));
  return [...checks].sort(
    (left, right) => (order.get(left.gate) ?? 999) - (order.get(right.gate) ?? 999),
  );
};

export const sortWindowsDeterministic = <T extends { order: number }>(windows: T[]): T[] =>
  [...windows].sort((left, right) => left.order - right.order);
