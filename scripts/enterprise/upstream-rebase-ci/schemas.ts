import { z } from 'zod';

import {
  EXPECTED_GATE_KINDS,
  FAIL_CLOSED_GATE_IDS,
  KNOWN_GATE_IDS,
  type KnownGateId,
  refineGateResultAssertions,
  STRUCTURED_COMMAND_GATE_IDS,
} from './contract';

const SHORT_HASH_LENGTH = 12;
const fullShaSchema = z.string().regex(/^[a-f\d]{40}$/u, 'must be a full lowercase git sha');
const shortShaSchema = z.string().regex(/^[a-f\d]{12}$/u, 'must be a 12-char lowercase git sha');

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

const gateIdSchema = z.string().min(1).max(64);

const requiredGateSchema = z
  .object({
    id: gateIdSchema,
    reason: z.string().min(1).max(500),
  })
  .strict();

export const rebaseReportSchema = z
  .object({
    analysis: z
      .object({
        networkAccess: z.enum(['not-used']),
        upstreamFreshness: z.enum(['unverified']),
        upstreamFreshnessReason: z.enum([
          'caller-provided-ref-not-fetched',
          'upstream-remote-not-configured',
        ]),
        worktreeMutation: z.enum(['none']),
      })
      .strict(),
    commits: z
      .object({
        base: shortShaSchema,
        candidate: shortShaSchema,
        mergeBase: shortShaSchema,
        upstream: shortShaSchema,
      })
      .strict(),
    conflicts: z.array(z.string().min(1).max(512)),
    directModificationHotspots: z.array(
      z
        .object({
          modules: z.array(z.string()),
          path: z.string().min(1).max(512),
          risk: z.enum(['high', 'low', 'medium', 'unknown']),
          upstreamChanged: z.boolean(),
        })
        .strict(),
    ),
    patchDrift: z.array(
      z
        .object({
          path: z.string().min(1).max(512),
          reason: z.enum(['unregistered-upstream-direct-edit']),
        })
        .strict(),
    ),
    requiredGates: z.array(requiredGateSchema).min(1).max(32),
    schemaVersion: z.literal(1),
    status: z.enum(['clean', 'conflicts', 'drift']),
    summary: z
      .object({
        candidateChangedPaths: z.number().int().nonnegative(),
        conflicts: z.number().int().nonnegative(),
        directModificationHotspots: z.number().int().nonnegative(),
        patchDrift: z.number().int().nonnegative(),
        upstreamChangedPaths: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.summary.conflicts !== report.conflicts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'summary.conflicts must equal conflicts.length',
        path: ['summary', 'conflicts'],
      });
    }
    if (report.summary.patchDrift !== report.patchDrift.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'summary.patchDrift must equal patchDrift.length',
        path: ['summary', 'patchDrift'],
      });
    }
    if (report.summary.directModificationHotspots !== report.directModificationHotspots.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'summary.directModificationHotspots must equal array length',
        path: ['summary', 'directModificationHotspots'],
      });
    }

    const gateIds = report.requiredGates.map((gate) => gate.id);
    if (new Set(gateIds).size !== gateIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'requiredGates ids must be unique',
        path: ['requiredGates'],
      });
    }

    if (
      report.status === 'clean' &&
      (report.conflicts.length > 0 || report.patchDrift.length > 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clean status cannot include conflicts or patch drift',
        path: ['status'],
      });
    }
    if (report.status === 'conflicts' && report.conflicts.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'conflicts status requires conflict paths',
        path: ['status'],
      });
    }
    if (
      report.status === 'drift' &&
      report.patchDrift.length === 0 &&
      report.conflicts.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'drift status requires patch drift entries',
        path: ['status'],
      });
    }
  });

export type ParsedRebaseReport = z.infer<typeof rebaseReportSchema>;

export const commitsFileSchema = z
  .object({
    base: fullShaSchema,
    candidate: fullShaSchema,
    mergeBase: fullShaSchema,
    upstream: fullShaSchema,
  })
  .strict();

export type ParsedCommitsFile = z.infer<typeof commitsFileSchema>;

export const gateResultSchema = z
  .object({
    assertions: assertionSummarySchema.optional(),
    id: gateIdSchema,
    kind: z.enum(['command', 'fail-closed', 'privacy-scan', 'vitest']),
    outcome: z.enum(['failed', 'passed']),
    reason: z.string().min(1).max(240),
  })
  .strict()
  .superRefine((gate, context) => {
    refineGateResultAssertions(gate, context);
  });

export type ParsedGateResult = z.infer<typeof gateResultSchema>;

const shortHash = (full: string) => full.slice(0, SHORT_HASH_LENGTH);

export const parseRebaseReportStrict = (value: unknown): ParsedRebaseReport =>
  rebaseReportSchema.parse(value);

export const parseCommitsFileStrict = (value: unknown): ParsedCommitsFile =>
  commitsFileSchema.parse(value);

/**
 * Validate gate results against required gate ids and known definitions.
 * Required ids and result ids must each be unique and form the exact same set.
 */
export const parseGateResultsStrict = (
  value: unknown,
  requiredGateIds: string[],
): ParsedGateResult[] => {
  if (!Array.isArray(value)) {
    throw new Error('Gate results must be an array');
  }

  const results = value.map((entry, index) => {
    try {
      return gateResultSchema.parse(entry);
    } catch (error) {
      throw new Error(
        `Gate result[${index}] is malformed: ${error instanceof Error ? error.message : 'invalid'}`,
        { cause: error },
      );
    }
  });

  const requiredUnique = [...new Set(requiredGateIds)];
  if (requiredUnique.length !== requiredGateIds.length) {
    throw new Error('Required gate ids must be unique');
  }

  const resultIds = results.map((gate) => gate.id);
  if (new Set(resultIds).size !== resultIds.length) {
    throw new Error('Gate result ids must be unique');
  }

  const requiredSet = new Set(requiredUnique);
  const resultSet = new Set(resultIds);
  if (requiredSet.size !== resultSet.size || requiredUnique.some((id) => !resultSet.has(id))) {
    throw new Error('Gate result ids must exactly match required gate ids');
  }

  for (const gate of results) {
    const known = (KNOWN_GATE_IDS as readonly string[]).includes(gate.id);
    if (!known) {
      if (gate.kind !== 'fail-closed' || gate.outcome !== 'failed') {
        throw new Error(`Unknown gate "${gate.id}" must be fail-closed failed`);
      }
      continue;
    }

    const expectedKind = EXPECTED_GATE_KINDS[gate.id as KnownGateId];
    if (expectedKind !== gate.kind) {
      throw new Error(
        `Gate "${gate.id}" kind ${gate.kind} does not match definition ${expectedKind}`,
      );
    }
    if (
      FAIL_CLOSED_GATE_IDS.has(gate.id as KnownGateId) &&
      (gate.kind !== 'fail-closed' || gate.outcome !== 'failed')
    ) {
      throw new Error(`Fail-closed gate "${gate.id}" must report fail-closed failed`);
    }
    if (STRUCTURED_COMMAND_GATE_IDS.has(gate.id as KnownGateId) && gate.assertions === undefined) {
      throw new Error(`Structured command gate "${gate.id}" requires assertions`);
    }
  }

  return results.sort((left, right) => left.id.localeCompare(right.id, 'en'));
};

export const assertReportCommitsMatch = (
  report: ParsedRebaseReport,
  commits: ParsedCommitsFile,
) => {
  const expected = {
    base: shortHash(commits.base),
    candidate: shortHash(commits.candidate),
    mergeBase: shortHash(commits.mergeBase),
    upstream: shortHash(commits.upstream),
  };
  for (const key of ['base', 'candidate', 'mergeBase', 'upstream'] as const) {
    if (report.commits[key] !== expected[key]) {
      throw new Error(`Report short ${key} does not match fetch commits`);
    }
  }
  if (commits.mergeBase !== commits.base) {
    throw new Error('Explicit base must equal unique merge-base');
  }
};
