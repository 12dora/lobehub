import { z } from 'zod';

export const FAILURE_DRILL_SCHEMA_VERSION = 1 as const;
export const FAILURE_DRILL_LANE = 'enterprise-failure-drills' as const;

const safeIdentifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'must be a lowercase classification identifier');

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u, 'must be a lowercase SHA-256 digest');
const dependencyVersionSchema = z
  .string()
  .max(32)
  .regex(
    /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?(?:-[a-z\d.-]+)?$/u,
    'must be a short numeric dependency version',
  );

export const failureDrillDependenciesSchema = z
  .object({
    bun: dependencyVersionSchema,
    node: dependencyVersionSchema,
    postgres: dependencyVersionSchema,
    redis: dependencyVersionSchema,
  })
  .strict();

export const injectionClassificationSchema = z.enum([
  'postgres-concurrent-writers',
  'postgres-lock-owner-termination',
  'postgres-revision-lag',
  'redis-version-key-loss',
]);

export const recoveryClassificationSchema = z.enum([
  'database-source-reload',
  'postgres-advisory-lock-release',
  'postgres-reconciled-revision',
  'postgres-serialized-outcome',
]);

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

const evidenceCoreSchema = z
  .object({
    artifact: z.object({ sha256: sha256Schema }).strict(),
    assertions: assertionSummarySchema,
    cleanupResult: z.enum(['failed', 'passed']),
    dependencies: failureDrillDependenciesSchema,
    elapsed: z.object({ milliseconds: z.number().finite().nonnegative() }).strict(),
    gitSha: z.string().regex(/^[a-f\d]{40}$/u, 'must be a lowercase full Git SHA'),
    injection: injectionClassificationSchema,
    lane: z.literal(FAILURE_DRILL_LANE),
    recovery: recoveryClassificationSchema,
    scenarioId: safeIdentifierSchema,
    schemaVersion: z.literal(FAILURE_DRILL_SCHEMA_VERSION),
  })
  .strict();

export const failureDrillEvidenceSchema = evidenceCoreSchema
  .extend({
    redactionScan: z
      .object({
        result: z.enum(['failed', 'passed']),
        violations: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type FailureDrillEvidence = z.infer<typeof failureDrillEvidenceSchema>;
export type FailureDrillEvidenceCore = z.infer<typeof evidenceCoreSchema>;
export type FailureDrillDependencies = z.infer<typeof failureDrillDependenciesSchema>;
export type InjectionClassification = z.infer<typeof injectionClassificationSchema>;
export type RecoveryClassification = z.infer<typeof recoveryClassificationSchema>;

const FORBIDDEN_KEY_PATTERN =
  /ciphertext|connectionstring|hostname|instanceid|password|payload|secret|token|uri|url/iu;
const FORBIDDEN_VALUE_PATTERNS = [
  /(?:https?|postgres(?:ql)?|rediss?):\/\//iu,
  /(?:^|[^a-z\d])(?:localhost|host\.docker\.internal)(?:[^a-z\d]|$)/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:bearer|password|secret|token)\s*[:=]\s*\S+/iu,
] as const;

const countForbiddenEvidenceValues = (value: unknown, key?: string): number => {
  const violations = key && FORBIDDEN_KEY_PATTERN.test(key) ? 1 : 0;

  if (typeof value === 'string') {
    return violations + FORBIDDEN_VALUE_PATTERNS.filter((pattern) => pattern.test(value)).length;
  }

  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countForbiddenEvidenceValues(item), violations);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).reduce(
      (total, [childKey, childValue]) => total + countForbiddenEvidenceValues(childValue, childKey),
      violations,
    );
  }

  return violations;
};

export const scanFailureDrillEvidence = (value: unknown) => {
  const violations = countForbiddenEvidenceValues(value);

  return {
    result: violations === 0 ? ('passed' as const) : ('failed' as const),
    violations,
  };
};

export const createFailureDrillEvidence = (
  input: FailureDrillEvidenceCore,
): FailureDrillEvidence => {
  const redactionScan = scanFailureDrillEvidence(input);

  if (redactionScan.result === 'failed') {
    throw new Error(
      `Failure-drill evidence redaction rejected ${redactionScan.violations} forbidden field(s)`,
    );
  }

  const core = evidenceCoreSchema.parse(input);

  return failureDrillEvidenceSchema.parse({
    ...core,
    redactionScan,
  });
};

export const isPassingFailureDrillEvidence = (evidence: FailureDrillEvidence): boolean => {
  const parsed = failureDrillEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return false;

  const { assertions, cleanupResult, redactionScan } = parsed.data;

  return (
    assertions.total > 0 &&
    assertions.passed === assertions.total &&
    assertions.failed === 0 &&
    assertions.skipped === 0 &&
    cleanupResult === 'passed' &&
    redactionScan.result === 'passed' &&
    redactionScan.violations === 0
  );
};
