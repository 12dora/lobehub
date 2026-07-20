// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { RebaseReport } from '../rebase-report';
import { collectUpstreamRebaseEvidence } from './collect';
import {
  createUpstreamRebaseEvidence,
  isPassingUpstreamRebaseEvidence,
  KNOWN_GATE_IDS,
  scanUpstreamRebaseEvidence,
  UPSTREAM_REBASE_CI_LANE,
  UPSTREAM_REBASE_CI_SCHEMA_VERSION,
} from './contract';
import { GATE_DEFINITIONS, resolveGateDefinition, VITEST_OUTPUT_PLACEHOLDER } from './gates';
import {
  buildOfficialFetchUrl,
  validateUpstreamInputs,
  validateUpstreamRef,
  validateUpstreamRepository,
} from './validateInputs';

const WORKFLOW_PATH = path.resolve(
  process.cwd(),
  '.github/workflows/enterprise-upstream-rebase.yml',
);
const SYNC_WORKFLOW_PATH = path.resolve(process.cwd(), '.github/workflows/sync.yml');

const FULL_SHA = 'a'.repeat(40);
const SHORT = FULL_SHA.slice(0, 12);

const baseReport = (): RebaseReport => ({
  analysis: {
    networkAccess: 'not-used',
    upstreamFreshness: 'unverified',
    upstreamFreshnessReason: 'upstream-remote-not-configured',
    worktreeMutation: 'none',
  },
  commits: {
    base: SHORT,
    candidate: SHORT,
    mergeBase: SHORT,
    upstream: SHORT,
  },
  conflicts: [],
  directModificationHotspots: [],
  patchDrift: [],
  requiredGates: [
    { id: 'bun-check-changed', reason: 'changed' },
    { id: 'privacy-review', reason: 'privacy' },
    { id: 'type-check', reason: 'types' },
  ],
  schemaVersion: 1,
  status: 'clean',
  summary: {
    candidateChangedPaths: 1,
    conflicts: 0,
    directModificationHotspots: 0,
    patchDrift: 0,
    upstreamChangedPaths: 1,
  },
});

const extractRunBlocks = (workflowSource: string): string[] => {
  const document = parse(workflowSource) as {
    jobs: Record<string, { steps: Array<{ run?: string }> }>;
  };
  const blocks: string[] = [];
  for (const job of Object.values(document.jobs)) {
    for (const step of job.steps) {
      if (typeof step.run === 'string' && step.run.trim().length > 0) {
        blocks.push(step.run);
      }
    }
  }
  return blocks;
};

describe('validateUpstreamInputs', () => {
  it('accepts official owner/name defaults and builds a credential-free HTTPS URL', () => {
    const validated = validateUpstreamInputs({});
    expect(validated).toEqual({
      fetchUrl: 'https://github.com/lobehub/lobehub.git',
      ref: 'main',
      repository: 'lobehub/lobehub',
    });
    expect(buildOfficialFetchUrl('lobehub/lobehub')).toBe('https://github.com/lobehub/lobehub.git');
  });

  it('rejects arbitrary URLs, credentials, and shell metacharacters', () => {
    expect(() => validateUpstreamRepository('https://github.com/lobehub/lobehub.git')).toThrow(
      /owner\/name|URL/,
    );
    expect(() => validateUpstreamRepository('lobehub/lobehub.git')).toThrow();
    expect(() => validateUpstreamRepository('user:token@host/repo')).toThrow();
    expect(() => validateUpstreamRepository('lobehub/lobehub;rm -rf /')).toThrow();
    expect(() => validateUpstreamRepository('../etc/passwd')).toThrow();
    expect(() => validateUpstreamRef('main;curl evil')).toThrow();
    expect(() => validateUpstreamRef('refs/heads/main`id`')).toThrow();
    expect(() => validateUpstreamRef('-nefarious')).toThrow();
    expect(() => validateUpstreamRef('feature/../main')).toThrow();
    expect(() =>
      validateUpstreamInputs({
        ref: 'main',
        repository: 'lobehub/lobehub\nmalicious',
      }),
    ).toThrow();
  });

  it('accepts safe branch, tag, and full-sha refs', () => {
    expect(validateUpstreamRef('canary')).toBe('canary');
    expect(validateUpstreamRef('v2.2.10')).toBe('v2.2.10');
    expect(validateUpstreamRef('feature/upstream-sync')).toBe('feature/upstream-sync');
    expect(validateUpstreamRef(FULL_SHA)).toBe(FULL_SHA);
  });
});

describe('gate mapping', () => {
  it('maps every known gate deterministically and fail-closes unknown ids', () => {
    for (const id of KNOWN_GATE_IDS) {
      const definition = resolveGateDefinition(id);
      expect(definition.id).toBe(id);
      expect(GATE_DEFINITIONS[id]).toBeDefined();
    }

    expect(resolveGateDefinition('not-a-real-gate')).toMatchObject({
      failClosed: true,
      kind: 'fail-closed',
    });
    expect(resolveGateDefinition('not-a-real-gate').reason).toMatch(/Unknown required gate/);

    expect(GATE_DEFINITIONS['manual-conflict-review'].failClosed).toBe(true);
    expect(GATE_DEFINITIONS['patch-ledger-update'].failClosed).toBe(true);
    expect(GATE_DEFINITIONS['permission-matrix'].argv?.join(' ')).toContain(
      'permissionMatrix.test.ts',
    );
    expect(GATE_DEFINITIONS['migration-upgrade-rollback'].argv?.join(' ')).toContain(
      'drizzleMigration.test.ts',
    );
    expect(GATE_DEFINITIONS['spa-route-sync'].argv?.join(' ')).toContain(
      'desktopRouter.sync.test.tsx',
    );
    expect(GATE_DEFINITIONS['type-check'].argv).toEqual(['bun', 'run', 'type-check']);
    expect(GATE_DEFINITIONS['privacy-review'].kind).toBe('privacy-scan');
    expect(GATE_DEFINITIONS['auth-e2e'].kind).toBe('vitest');

    for (const id of KNOWN_GATE_IDS) {
      const definition = GATE_DEFINITIONS[id];
      if (definition.kind !== 'vitest') continue;
      expect(definition.argv).toContain('--outputFile');
      expect(definition.argv).toContain(VITEST_OUTPUT_PLACEHOLDER);
      expect(
        definition.argv?.some((argument) => argument.includes('enterprise-upstream-rebase-raw')),
      ).toBe(false);
    }
  });
});

describe('evidence contract', () => {
  it('rejects secretful evidence and requires verified freshness plus passing gates', () => {
    const secretful = {
      note: 'token=abc',
      url: 'https://example.invalid/x',
    };
    expect(scanUpstreamRebaseEvidence(secretful).result).toBe('failed');

    const gates = [
      {
        id: 'bun-check-changed',
        kind: 'command' as const,
        outcome: 'passed' as const,
        reason: 'lint',
      },
      {
        id: 'privacy-review',
        kind: 'privacy-scan' as const,
        outcome: 'passed' as const,
        reason: 'privacy',
      },
      {
        id: 'type-check',
        kind: 'command' as const,
        outcome: 'passed' as const,
        reason: 'types',
      },
    ];

    const evidence = createUpstreamRebaseEvidence({
      analysis: {
        mode: 'dry-run-evidence',
        networkAccess: 'ci-fetch-only',
        productionRebase: false,
        push: false,
        worktreeMutation: 'isolated-temp-only',
      },
      cleanupResult: 'passed',
      commits: {
        base: SHORT,
        candidate: SHORT,
        mergeBase: SHORT,
        upstream: SHORT,
      },
      gates,
      lane: UPSTREAM_REBASE_CI_LANE,
      reportStatus: 'clean',
      requiredGateIds: ['bun-check-changed', 'privacy-review', 'type-check'],
      schemaVersion: UPSTREAM_REBASE_CI_SCHEMA_VERSION,
      summary: {
        candidateChangedPaths: 1,
        conflicts: 0,
        directModificationHotspots: 0,
        patchDrift: 0,
        upstreamChangedPaths: 1,
      },
      upstream: {
        freshness: 'verified-by-ci-fetch',
        ref: 'main',
        repository: 'lobehub/lobehub',
        sha: FULL_SHA,
      },
    });

    expect(isPassingUpstreamRebaseEvidence(evidence)).toBe(true);

    expect(
      isPassingUpstreamRebaseEvidence({
        ...evidence,
        upstream: { ...evidence.upstream, freshness: 'unverified' },
      }),
    ).toBe(false);

    expect(
      isPassingUpstreamRebaseEvidence({
        ...evidence,
        reportStatus: 'conflicts',
      }),
    ).toBe(false);

    expect(
      isPassingUpstreamRebaseEvidence({
        ...evidence,
        cleanupResult: 'failed',
      }),
    ).toBe(false);

    expect(
      isPassingUpstreamRebaseEvidence({
        ...evidence,
        gates: evidence.gates.map((gate) =>
          gate.id === 'type-check' ? { ...gate, outcome: 'failed' } : gate,
        ),
      }),
    ).toBe(false);

    expect(
      isPassingUpstreamRebaseEvidence({
        ...evidence,
        gates: [
          ...evidence.gates,
          {
            assertions: { failed: 0, passed: 0, skipped: 0, total: 0 },
            id: 'spa-route-sync',
            kind: 'vitest',
            outcome: 'passed',
            reason: 'zero tests must not pass',
          },
        ],
        requiredGateIds: [...evidence.requiredGateIds, 'spa-route-sync'],
      }),
    ).toBe(false);
  });

  it('collect fails closed on conflicts, drift, unverified freshness, and missing gates', async () => {
    const report = baseReport();
    const temp = await mkdtemp(path.join(tmpdir(), 'upstream-rebase-evidence-'));

    try {
      await expect(
        collectUpstreamRebaseEvidence({
          cleanupResult: 'passed',
          fullCommits: {
            base: FULL_SHA,
            candidate: FULL_SHA,
            mergeBase: FULL_SHA,
            upstream: FULL_SHA,
          },
          gateResults: [
            {
              id: 'bun-check-changed',
              kind: 'command',
              outcome: 'passed',
              reason: 'lint',
            },
            {
              id: 'privacy-review',
              kind: 'privacy-scan',
              outcome: 'passed',
              reason: 'privacy',
            },
            {
              id: 'type-check',
              kind: 'command',
              outcome: 'passed',
              reason: 'types',
            },
          ],
          outputDirectory: path.join(temp, 'ok'),
          report,
          upstreamFreshness: 'verified-by-ci-fetch',
          upstreamRef: 'main',
          upstreamRepository: 'lobehub/lobehub',
        }),
      ).resolves.toMatchObject({
        reportStatus: 'clean',
        upstream: { freshness: 'verified-by-ci-fetch', repository: 'lobehub/lobehub' },
      });

      await expect(
        collectUpstreamRebaseEvidence({
          cleanupResult: 'passed',
          fullCommits: {
            base: FULL_SHA,
            candidate: FULL_SHA,
            mergeBase: FULL_SHA,
            upstream: FULL_SHA,
          },
          gateResults: [],
          outputDirectory: path.join(temp, 'conflict'),
          report: {
            ...report,
            conflicts: ['src/x.ts'],
            status: 'conflicts',
            summary: { ...report.summary, conflicts: 1 },
          },
          upstreamFreshness: 'verified-by-ci-fetch',
          upstreamRef: 'main',
          upstreamRepository: 'lobehub/lobehub',
        }),
      ).rejects.toThrow(/conflicts|status/i);

      await expect(
        collectUpstreamRebaseEvidence({
          cleanupResult: 'passed',
          fullCommits: {
            base: FULL_SHA,
            candidate: FULL_SHA,
            mergeBase: FULL_SHA,
            upstream: FULL_SHA,
          },
          gateResults: [],
          outputDirectory: path.join(temp, 'fresh'),
          report,
          upstreamFreshness: 'unverified',
          upstreamRef: 'main',
          upstreamRepository: 'lobehub/lobehub',
        }),
      ).rejects.toThrow(/freshness/i);

      await expect(
        collectUpstreamRebaseEvidence({
          cleanupResult: 'passed',
          fullCommits: {
            base: FULL_SHA,
            candidate: FULL_SHA,
            mergeBase: FULL_SHA,
            upstream: FULL_SHA,
          },
          gateResults: [
            {
              id: 'bun-check-changed',
              kind: 'command',
              outcome: 'passed',
              reason: 'lint',
            },
          ],
          outputDirectory: path.join(temp, 'missing-gates'),
          report,
          upstreamFreshness: 'verified-by-ci-fetch',
          upstreamRef: 'main',
          upstreamRepository: 'lobehub/lobehub',
        }),
      ).rejects.toThrow(/gate/i);
    } finally {
      await rm(temp, { force: true, maxRetries: 3, recursive: true });
    }
  });
});

describe('enterprise-upstream-rebase workflow', () => {
  it('is read-only dry-run with pinned actions, fork safety, and no push/write', async () => {
    const source = await readFile(WORKFLOW_PATH, 'utf8');
    const workflow = parse(source) as {
      concurrency: { 'cancel-in-progress': boolean; 'group': string };
      jobs: Record<
        string,
        {
          'if'?: string;
          'runs-on': string;
          'steps': Array<Record<string, unknown>>;
          'timeout-minutes'?: number;
        }
      >;
      on: Record<string, unknown>;
      permissions: Record<string, string>;
    };

    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.permissions).not.toHaveProperty('pull-requests');
    expect(workflow.permissions).not.toHaveProperty('issues');
    expect(workflow.concurrency['cancel-in-progress']).toBe(true);
    expect(workflow.concurrency.group).toContain('github.workflow');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on).toHaveProperty('schedule');

    const schedule = workflow.on.schedule as Array<{ cron: string }>;
    expect(schedule).toHaveLength(1);
    expect(schedule[0].cron).toBe('17 3 * * 1');

    const inputs = (
      workflow.on.workflow_dispatch as {
        inputs: Record<string, { default: string }>;
      }
    ).inputs;
    expect(inputs.upstream_repository.default).toBe('lobehub/lobehub');
    expect(inputs.upstream_ref.default).toBe('main');

    const job = workflow.jobs['dry-run'];
    expect(job['timeout-minutes']).toBe(90);
    expect(job.if).toContain('workflow_dispatch');
    expect(job.if).toContain('fork');

    const uses = job.steps
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === 'string');
    expect(uses).toContain('actions/checkout@v6');
    expect(uses).toContain('actions/upload-artifact@v6');
    expect(uses).toContain('./.github/actions/setup-env');
    for (const action of uses) {
      if (action.startsWith('actions/')) {
        expect(action).toMatch(/@v\d+$/u);
      }
    }

    const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v6');
    expect(checkout?.with).toMatchObject({
      'fetch-depth': 0,
      'persist-credentials': false,
    });

    // Existing sync bot must remain unchanged and separate.
    const syncSource = await readFile(SYNC_WORKFLOW_PATH, 'utf8');
    expect(syncSource).toContain('Fork-Sync-With-Upstream-action');
    expect(syncSource).toContain('contents: write');
    expect(source).not.toContain('Fork-Sync-With-Upstream-action');
    expect(source).not.toContain('contents: write');
  });

  it('parses every shell block for safety, failure propagation, cleanup, and artifact boundary', async () => {
    const source = await readFile(WORKFLOW_PATH, 'utf8');
    const workflow = parse(source) as {
      jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
    };
    const job = workflow.jobs['dry-run'];
    const runBlocks = extractRunBlocks(source);
    expect(runBlocks.length).toBeGreaterThanOrEqual(6);

    const joined = runBlocks.join('\n');

    // No push / write / PR mutation / main rewrite.
    expect(joined).not.toMatch(/\bgit\s+push\b/u);
    expect(joined).not.toMatch(/\bgit\s+reset\b/u);
    expect(joined).not.toMatch(/\bgit\s+merge\b/u);
    expect(joined).not.toMatch(/\bgh\s+pr\b/u);
    expect(joined).not.toMatch(/secrets\.[A-Z0-9_]+/u);
    expect(joined).not.toContain('GITHUB_TOKEN');
    expect(joined).not.toMatch(/target_sync_branch:\s*main/u);

    // Official input validation path.
    expect(joined).toContain('validate-inputs');
    expect(joined).toContain('upstream-rebase-ci/index.ts fetch');
    expect(joined).toContain('upstream-rebase-ci/index.ts run-gates');
    expect(joined).toContain('upstream-rebase-ci/index.ts collect');
    expect(joined).toContain('pnpm install');

    // continue-on-error steps must have final outcome assertions.
    const continueOnErrorSteps = job.steps.filter((step) => step['continue-on-error'] === true);
    expect(continueOnErrorSteps.length).toBeGreaterThan(0);
    for (const step of continueOnErrorSteps) {
      expect(typeof step.id).toBe('string');
    }
    expect(joined).toContain('FETCH_STEP_OUTCOME');
    expect(joined).toContain('GATES_STEP_OUTCOME');
    expect(joined).toMatch(/test "\$FETCH_STEP_OUTCOME" = success/u);
    expect(joined).toMatch(/test "\$GATES_STEP_OUTCOME" = success/u);
    expect(joined).toContain('UPSTREAM_REBASE_REPORT_OUTCOME');
    expect(joined).toContain('UPSTREAM_REBASE_CLEANUP_RESULT');
    expect(joined).toContain('UPSTREAM_REBASE_WIPE_RESULT');

    // Cleanup must be exact and fail closed.
    const cleanupStep = job.steps.find((step) => step.id === 'cleanup');
    expect(cleanupStep?.if).toBe('always()');
    expect(String(cleanupStep?.run)).toContain('rm -rf "$UPSTREAM_REBASE_TEMP_ROOT"');
    expect(String(cleanupStep?.run)).toContain('cleanup_result=failed');

    const wipeStep = job.steps.find((step) => step.id === 'wipe_raw');
    expect(wipeStep?.if).toBe('always()');
    expect(String(wipeStep?.run)).toContain('rm -rf "$UPSTREAM_REBASE_RAW_DIR"');

    // Artifact boundary: upload redacted record dir only, never raw.
    const upload = job.steps.find((step) => step.uses === 'actions/upload-artifact@v6');
    expect(upload?.with).toMatchObject({
      'if-no-files-found': 'error',
      'path': '.records/enterprise-upstream-rebase/${{ github.run_id }}-${{ github.run_attempt }}',
    });
    expect(JSON.stringify(upload?.with)).not.toContain('enterprise-upstream-rebase-raw');
    expect(source).toContain('dry-run');
    expect(source).toMatch(/NOT a sync bot|not a production rebase/i);

    // Shell syntax: every block uses strict mode or explicit set +e for cleanup.
    for (const block of runBlocks) {
      expect(block).toMatch(/set -euo pipefail|set \+e/u);
    }
  });

  it('documents actionlint unavailability when the binary is missing', async () => {
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync('actionlint', ['-version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      // Do not fake actionlint. Record the real availability for operators.
      expect(probe.error?.message ?? probe.stderr ?? 'actionlint unavailable').toMatch(
        /actionlint|ENOENT|not found|unavailable/i,
      );
      return;
    }
    const lint = spawnSync('actionlint', [WORKFLOW_PATH], { encoding: 'utf8' });
    expect(lint.status).toBe(0);
  });
});
