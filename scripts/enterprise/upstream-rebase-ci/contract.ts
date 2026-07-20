import { z } from 'zod';

export const UPSTREAM_REBASE_CI_SCHEMA_VERSION = 1 as const;
export const UPSTREAM_REBASE_CI_LANE = 'enterprise-upstream-rebase-dry-run' as const;
export const DEFAULT_UPSTREAM_REPOSITORY = 'lobehub/lobehub' as const;
export const DEFAULT_UPSTREAM_REF = 'main' as const;
export const OFFICIAL_GITHUB_HOST = 'github.com' as const;

/** Gate ids emitted by scripts/enterprise/rebase-report.ts */
export const KNOWN_GATE_IDS = [
  'auth-e2e',
  'bun-check-changed',
  'desktop-release',
  'failure-drills',
  'manual-conflict-review',
  'migration-upgrade-rollback',
  'patch-ledger-update',
  'permission-matrix',
  'privacy-review',
  'spa-route-sync',
  'type-check',
] as const;

export type KnownGateId = (typeof KNOWN_GATE_IDS)[number];

const shortShaSchema = z.string().regex(/^[a-f\d]{12}$/u, 'must be a 12-char lowercase git sha');
const fullShaSchema = z.string().regex(/^[a-f\d]{40}$/u, 'must be a full lowercase git sha');
const repositorySlugSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/u, 'must be owner/name');
const refSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][\w./-]*$/u, 'must be a safe git ref');

export const validatedUpstreamInputSchema = z
  .object({
    fetchUrl: z
      .string()
      .regex(
        /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/u,
        'must be an official HTTPS GitHub git URL without credentials',
      ),
    repository: repositorySlugSchema,
    ref: refSchema,
  })
  .strict();

export type ValidatedUpstreamInput = z.infer<typeof validatedUpstreamInputSchema>;

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

const gateResultSchema = z
  .object({
    assertions: assertionSummarySchema.optional(),
    id: z.string().min(1).max(64),
    kind: z.enum(['command', 'fail-closed', 'privacy-scan', 'vitest']),
    outcome: z.enum(['failed', 'passed']),
    reason: z.string().min(1).max(240),
  })
  .strict();

const evidenceCoreSchema = z
  .object({
    analysis: z
      .object({
        mode: z.literal('dry-run-evidence'),
        networkAccess: z.enum(['ci-fetch-only', 'not-used']),
        productionRebase: z.literal(false),
        push: z.literal(false),
        worktreeMutation: z.enum(['isolated-temp-only', 'none']),
      })
      .strict(),
    cleanupResult: z.enum(['failed', 'passed']),
    commits: z
      .object({
        base: shortShaSchema,
        candidate: shortShaSchema,
        mergeBase: shortShaSchema,
        upstream: shortShaSchema,
      })
      .strict(),
    gates: z.array(gateResultSchema).max(32),
    lane: z.literal(UPSTREAM_REBASE_CI_LANE),
    reportStatus: z.enum(['clean', 'conflicts', 'drift']),
    requiredGateIds: z.array(z.string().min(1).max(64)).max(32),
    schemaVersion: z.literal(UPSTREAM_REBASE_CI_SCHEMA_VERSION),
    summary: z
      .object({
        candidateChangedPaths: z.number().int().nonnegative(),
        conflicts: z.number().int().nonnegative(),
        directModificationHotspots: z.number().int().nonnegative(),
        patchDrift: z.number().int().nonnegative(),
        upstreamChangedPaths: z.number().int().nonnegative(),
      })
      .strict(),
    upstream: z
      .object({
        freshness: z.enum(['unverified', 'verified-by-ci-fetch']),
        ref: refSchema,
        repository: repositorySlugSchema,
        sha: fullShaSchema,
      })
      .strict(),
  })
  .strict();

export const upstreamRebaseEvidenceSchema = evidenceCoreSchema
  .extend({
    redactionScan: z
      .object({
        result: z.enum(['failed', 'passed']),
        violations: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type UpstreamRebaseEvidence = z.infer<typeof upstreamRebaseEvidenceSchema>;
export type UpstreamRebaseEvidenceCore = z.infer<typeof evidenceCoreSchema>;
export type GateResult = z.infer<typeof gateResultSchema>;

const FORBIDDEN_KEY_PATTERN =
  /ciphertext|connectionstring|credential|hostname|password|payload|secret|token|uri|url/iu;
const FORBIDDEN_VALUE_PATTERNS = [
  /(?:https?|postgres(?:ql)?|rediss?):\/\//iu,
  /git@[\w.-]+/u,
  /(?:^|[^a-z\d])(?:localhost|host\.docker\.internal)(?:[^a-z\d]|$)/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:bearer|password|secret|token)\s*[:=]\s*\S+/iu,
  /gh[pousr]_\w{20,}/u,
  /github_pat_\w{20,}/u,
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

export const scanUpstreamRebaseEvidence = (value: unknown) => {
  const violations = countForbiddenEvidenceValues(value);
  return {
    result: violations === 0 ? ('passed' as const) : ('failed' as const),
    violations,
  };
};

export const createUpstreamRebaseEvidence = (
  input: UpstreamRebaseEvidenceCore,
): UpstreamRebaseEvidence => {
  const redactionScan = scanUpstreamRebaseEvidence(input);
  if (redactionScan.result === 'failed') {
    throw new Error(
      `Upstream rebase evidence redaction rejected ${redactionScan.violations} forbidden field(s)`,
    );
  }

  const core = evidenceCoreSchema.parse(input);
  return upstreamRebaseEvidenceSchema.parse({
    ...core,
    redactionScan,
  });
};

export const isPassingUpstreamRebaseEvidence = (evidence: UpstreamRebaseEvidence): boolean => {
  const parsed = upstreamRebaseEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return false;

  const { cleanupResult, gates, redactionScan, reportStatus, requiredGateIds, upstream } =
    parsed.data;

  if (reportStatus !== 'clean') return false;
  if (cleanupResult !== 'passed') return false;
  if (upstream.freshness !== 'verified-by-ci-fetch') return false;
  if (redactionScan.result !== 'passed' || redactionScan.violations !== 0) return false;
  if (requiredGateIds.length === 0) return false;
  if (gates.length !== requiredGateIds.length) return false;

  const gateIds = new Set(gates.map((gate) => gate.id));
  if (requiredGateIds.some((id) => !gateIds.has(id))) return false;

  return gates.every((gate) => {
    if (gate.outcome !== 'passed') return false;
    if (gate.kind === 'vitest') {
      const assertions = gate.assertions;
      return (
        !!assertions &&
        assertions.total > 0 &&
        assertions.passed === assertions.total &&
        assertions.failed === 0 &&
        assertions.skipped === 0
      );
    }
    return true;
  });
};
