import { z } from 'zod';

import { scanForSecrets } from './secretScan';

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

/** Deterministic kind expected for each known gate (shared by runner + schema). */
export const EXPECTED_GATE_KINDS = {
  'auth-e2e': 'vitest',
  'bun-check-changed': 'command',
  'desktop-release': 'vitest',
  'failure-drills': 'command',
  'manual-conflict-review': 'fail-closed',
  'migration-upgrade-rollback': 'command',
  'patch-ledger-update': 'fail-closed',
  'permission-matrix': 'vitest',
  'privacy-review': 'privacy-scan',
  'spa-route-sync': 'vitest',
  'type-check': 'command',
} as const satisfies Record<KnownGateId, 'command' | 'fail-closed' | 'privacy-scan' | 'vitest'>;

export const FAIL_CLOSED_GATE_IDS = new Set<KnownGateId>([
  'manual-conflict-review',
  'patch-ledger-update',
]);

/**
 * Command gates that always carry structured assertion counts (Q03 / failure-drills).
 * Both passed and failed outcomes require assertions.
 */
export const STRUCTURED_COMMAND_GATE_IDS = new Set<KnownGateId>([
  'failure-drills',
  'migration-upgrade-rollback',
]);

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

export const assertionSummarySchema = z
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

const isAllPassAssertions = (assertions: {
  failed: number;
  passed: number;
  skipped: number;
  total: number;
}) =>
  assertions.total > 0 &&
  assertions.passed === assertions.total &&
  assertions.failed === 0 &&
  assertions.skipped === 0;

/**
 * Shared per-gate assertion rules used by both raw gate-result and final evidence schemas.
 */
export const refineGateResultAssertions = (
  gate: {
    assertions?: {
      failed: number;
      passed: number;
      skipped: number;
      total: number;
    };
    id: string;
    kind: 'command' | 'fail-closed' | 'privacy-scan' | 'vitest';
    outcome: 'failed' | 'passed';
  },
  context: z.RefinementCtx,
) => {
  const structured =
    (KNOWN_GATE_IDS as readonly string[]).includes(gate.id) &&
    STRUCTURED_COMMAND_GATE_IDS.has(gate.id as KnownGateId);
  const requiresAssertions = gate.kind === 'vitest' || structured;

  if (requiresAssertions && !gate.assertions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `gate "${gate.id}" requires assertions`,
      path: ['assertions'],
    });
    return;
  }

  if (
    (gate.kind === 'fail-closed' || gate.kind === 'privacy-scan') &&
    gate.assertions !== undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${gate.kind} gates must not include assertions`,
      path: ['assertions'],
    });
  }

  if (!gate.assertions) return;

  if (gate.outcome === 'passed' && !isAllPassAssertions(gate.assertions)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'passing gate with assertions requires positive all-pass counts',
      path: ['assertions'],
    });
  }

  if (gate.outcome === 'failed' && isAllPassAssertions(gate.assertions)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'failed gate must not claim all-pass assertions',
      path: ['assertions'],
    });
  }
};

export const evidenceGateResultSchema = z
  .object({
    assertions: assertionSummarySchema.optional(),
    id: z.string().min(1).max(64),
    kind: z.enum(['command', 'fail-closed', 'privacy-scan', 'vitest']),
    outcome: z.enum(['failed', 'passed']),
    reason: z.string().min(1).max(240),
  })
  .strict()
  .superRefine((gate, context) => {
    refineGateResultAssertions(gate, context);
  });

const refineEvidenceGateBijection = (
  value: {
    gates: Array<{
      assertions?: {
        failed: number;
        passed: number;
        skipped: number;
        total: number;
      };
      id: string;
      kind: 'command' | 'fail-closed' | 'privacy-scan' | 'vitest';
      outcome: 'failed' | 'passed';
    }>;
    requiredGateIds: string[];
  },
  context: z.RefinementCtx,
) => {
  const required = value.requiredGateIds;
  if (new Set(required).size !== required.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'requiredGateIds must be unique',
      path: ['requiredGateIds'],
    });
  }

  const resultIds = value.gates.map((gate) => gate.id);
  if (new Set(resultIds).size !== resultIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'gate result ids must be unique',
      path: ['gates'],
    });
  }

  if (required.length !== value.gates.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'gates length must equal requiredGateIds length',
      path: ['gates'],
    });
  }

  const requiredSet = new Set(required);
  const resultSet = new Set(resultIds);
  if (requiredSet.size !== resultSet.size || required.some((id) => !resultSet.has(id))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'gate result ids must exactly match requiredGateIds',
      path: ['gates'],
    });
  }

  for (const [index, gate] of value.gates.entries()) {
    const known = (KNOWN_GATE_IDS as readonly string[]).includes(gate.id);
    if (!known) {
      if (gate.kind !== 'fail-closed' || gate.outcome !== 'failed') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown gate "${gate.id}" must be fail-closed failed`,
          path: ['gates', index],
        });
      }
      continue;
    }

    const expectedKind = EXPECTED_GATE_KINDS[gate.id as KnownGateId];
    if (gate.kind !== expectedKind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `gate "${gate.id}" kind ${gate.kind} does not match ${expectedKind}`,
        path: ['gates', index, 'kind'],
      });
    }

    if (
      FAIL_CLOSED_GATE_IDS.has(gate.id as KnownGateId) &&
      (gate.kind !== 'fail-closed' || gate.outcome !== 'failed')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `fail-closed gate "${gate.id}" cannot pass`,
        path: ['gates', index, 'outcome'],
      });
    }
  }
};

const evidenceCoreObjectSchema = z
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
    gates: z.array(evidenceGateResultSchema).max(32),
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

export const evidenceCoreSchema = evidenceCoreObjectSchema.superRefine(refineEvidenceGateBijection);

export const upstreamRebaseEvidenceSchema = evidenceCoreObjectSchema
  .extend({
    redactionScan: z
      .object({
        result: z.enum(['failed', 'passed']),
        violations: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine(refineEvidenceGateBijection);

export type UpstreamRebaseEvidence = z.infer<typeof upstreamRebaseEvidenceSchema>;
export type UpstreamRebaseEvidenceCore = z.infer<typeof evidenceCoreObjectSchema>;
export type GateResult = z.infer<typeof evidenceGateResultSchema>;

export const scanUpstreamRebaseEvidence = (value: unknown) => scanForSecrets(value);

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

/**
 * Passing evidence must satisfy the strict schema (including unique/bijection rules)
 * plus clean report status, cleanup, verified freshness, redaction, and all-gate pass.
 */
export const isPassingUpstreamRebaseEvidence = (evidence: unknown): boolean => {
  const parsed = upstreamRebaseEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return false;

  const { cleanupResult, gates, redactionScan, reportStatus, requiredGateIds, upstream } =
    parsed.data;

  if (reportStatus !== 'clean') return false;
  if (cleanupResult !== 'passed') return false;
  if (upstream.freshness !== 'verified-by-ci-fetch') return false;
  if (redactionScan.result !== 'passed' || redactionScan.violations !== 0) return false;
  if (requiredGateIds.length === 0) return false;

  return gates.every((gate) => gate.outcome === 'passed');
};
