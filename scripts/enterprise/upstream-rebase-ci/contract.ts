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
  'failure-drills': 'fail-closed',
  'manual-conflict-review': 'fail-closed',
  'migration-upgrade-rollback': 'vitest',
  'patch-ledger-update': 'fail-closed',
  'permission-matrix': 'vitest',
  'privacy-review': 'privacy-scan',
  'spa-route-sync': 'vitest',
  'type-check': 'command',
} as const satisfies Record<KnownGateId, 'command' | 'fail-closed' | 'privacy-scan' | 'vitest'>;

export const FAIL_CLOSED_GATE_IDS = new Set<KnownGateId>([
  'failure-drills',
  'manual-conflict-review',
  'patch-ledger-update',
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
