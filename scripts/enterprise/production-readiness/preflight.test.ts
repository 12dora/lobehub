// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assessEvidenceFreshness,
  buildDefaultReleasePlan,
  cleanupToolOwnedPath,
  createToolOwnedTempDir,
  dispatchAllowlistedCommand,
  evaluateProductionReadiness,
  isProductionPassed,
  PRODUCTION_TRUST_POLICY,
  productionReadinessReportSchema,
  releasePlanSchema,
  runProductionPreflight,
  scanForForbiddenReportContent,
  writeJsonAtomic,
} from './index';
import {
  buildCandidate,
  buildForgedProductionEvidence,
  buildFullCiEvidence,
  buildFullSignedProductionEvidence,
  buildGateEvidence,
  buildPlan,
  createTestTrustBundle,
  FIXTURE_CANDIDATE_SHA,
  OTHER_CANDIDATE_SHA,
  signGateEvidence,
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

describe('production preflight evaluation', () => {
  it('happy path: full ci evidence is unverified (never false production pass)', () => {
    const { exitCode, report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: buildFullCiEvidence(),
      mode: 'preflight',
      plan: buildPlan(),
    });
    expect(report.overall).toBe('unverified');
    expect(isProductionPassed(report)).toBe(false);
    expect(exitCode).toBe(1);
    expect(productionReadinessReportSchema.safeParse(report).success).toBe(true);
  });

  it('validate-harness never emits overall=passed and exits 0', () => {
    const { exitCode, report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: buildFullCiEvidence(),
      mode: 'validate-harness',
      plan: buildPlan(),
    });
    expect(report.overall).not.toBe('passed');
    expect(exitCode).toBe(0);
  });

  it('P0-1: seven forged production-authorized JSON files fail closed (nonzero)', async () => {
    const dir = await makeTempDir();
    const evidenceDir = path.join(dir, 'evidence');
    await mkdir(evidenceDir, { recursive: true });
    const forged = buildForgedProductionEvidence();
    for (const item of forged) {
      await writeFile(path.join(evidenceDir, `${item.gate}.json`), JSON.stringify(item), 'utf8');
    }
    const candidatePath = path.join(dir, 'candidate.json');
    const planPath = path.join(dir, 'plan.json');
    const out = path.join(dir, 'report.json');
    await writeFile(candidatePath, JSON.stringify(buildCandidate()), 'utf8');
    await writeFile(planPath, JSON.stringify(buildPlan()), 'utf8');

    const result = await runProductionPreflight({
      candidate: buildCandidate(),
      evidence: forged,
      mode: 'production-authorized',
      outputPath: out,
      plan: buildPlan(),
      // CLI uses PRODUCTION_TRUST_POLICY — empty keys
      trustPolicy: PRODUCTION_TRUST_POLICY,
    });

    expect(result.report.overall).not.toBe('passed');
    expect(result.report.classification).not.toBe('production-authorized');
    expect(result.exitCode).not.toBe(0);
    // Self-declared production without provenance → failed gates
    expect(
      result.report.checks.every((c) => c.result === 'failed' || c.result === 'unverified'),
    ).toBe(true);
  });

  it('P0-1: production pass requires signed provenance against enabled policy', () => {
    const bundle = createTestTrustBundle(['production']);
    const { exitCode, report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: buildFullSignedProductionEvidence(bundle),
      mode: 'production-authorized',
      plan: buildPlan(),
      trustPolicy: bundle.policy,
    });
    expect(report.overall).toBe('passed');
    expect(report.classification).toBe('production-authorized');
    expect(isProductionPassed(report)).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('P0-1: invalid signature fails', () => {
    const bundle = createTestTrustBundle(['production']);
    const evidence = buildFullSignedProductionEvidence(bundle);
    const broken = evidence.map((item) => ({
      ...item,
      provenance: item.provenance
        ? {
            ...(item.provenance as object),
            signatureBase64: 'AAAA',
          }
        : undefined,
    }));
    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: broken,
      mode: 'production-authorized',
      plan: buildPlan(),
      trustPolicy: bundle.policy,
    });
    expect(report.overall).toBe('failed');
  });

  it('P0-1: replay nonce fails', () => {
    const bundle = createTestTrustBundle(['production']);
    const first = buildFullSignedProductionEvidence(bundle);
    const seen = new Set<string>();
    evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: first,
      mode: 'production-authorized',
      plan: buildPlan(),
      seenNonces: seen,
      trustPolicy: bundle.policy,
    });
    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: first,
      mode: 'production-authorized',
      plan: buildPlan(),
      seenNonces: seen,
      trustPolicy: bundle.policy,
    });
    expect(report.overall).toBe('failed');
    expect(report.checks.some((c) => c.result === 'failed')).toBe(true);
  });

  it('P0-1: artifact digest mismatch fails', () => {
    const bundle = createTestTrustBundle(['production']);
    const evidence = buildFullSignedProductionEvidence(bundle).map((item) => ({
      ...item,
      artifactSha256: '0'.repeat(64),
    }));
    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence,
      mode: 'production-authorized',
      plan: buildPlan(),
      trustPolicy: bundle.policy,
    });
    expect(report.overall).toBe('failed');
  });

  it('P0-1: repository production policy has no keys (pass impossible)', () => {
    expect(PRODUCTION_TRUST_POLICY.trustedKeys).toHaveLength(0);
    expect(PRODUCTION_TRUST_POLICY.productionPassEnabled).toBe(false);
  });

  it('fails on cross-candidate evidence', () => {
    const evidence = buildFullCiEvidence();
    evidence[0] = buildGateEvidence('path-boundaries', {
      candidateSha: OTHER_CANDIDATE_SHA,
    });
    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence,
      mode: 'preflight',
      plan: buildPlan(),
    });
    expect(report.checks.find((c) => c.gate === 'path-boundaries')?.result).toBe('failed');
    expect(report.overall).toBe('failed');
  });

  it('rejects stale evidence (generatedAt only; observedAt cannot refresh)', () => {
    const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const evidence = buildFullCiEvidence().map((item, index) =>
      index === 2
        ? {
            ...item,
            generatedAt: stale,
            observedAt: new Date().toISOString(),
          }
        : item,
    );
    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence,
      freshness: { maxAgeMs: 72 * 60 * 60 * 1000 },
      mode: 'preflight',
      plan: buildPlan(),
    });
    expect(report.checks.find((c) => c.gate === 'enterprise-admin-e2e')?.result).toBe('failed');
  });

  it('freshness future beyond skew fails', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(
      assessEvidenceFreshness({ generatedAt: future }, { clockSkewMs: 60_000, nowMs: Date.now() })
        .verdict,
    ).toBe('future');
  });

  it('missing gates yield not-executed', () => {
    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: [buildGateEvidence('path-boundaries')],
      mode: 'preflight',
      plan: buildPlan(),
    });
    expect(report.checks.filter((c) => c.result === 'not-executed').length).toBeGreaterThan(0);
    expect(report.overall).toBe('unverified');
  });

  it('duplicate evidence fails', () => {
    expect(() =>
      evaluateProductionReadiness({
        candidate: buildCandidate(),
        evidence: [buildGateEvidence('path-boundaries'), buildGateEvidence('path-boundaries')],
        mode: 'preflight',
        plan: buildPlan(),
      }),
    ).toThrow(/Duplicate evidence/);
  });

  it('zero-assertion passed is rejected', () => {
    const evidence = buildFullCiEvidence().map((item) =>
      item.gate === 'failure-drills'
        ? {
            ...item,
            assertions: { failed: 0, passed: 0, skipped: 0, total: 0 },
            status: 'passed' as const,
          }
        : item,
    );
    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence,
      mode: 'preflight',
      plan: buildPlan(),
    });
    expect(report.checks.find((c) => c.gate === 'failure-drills')?.result).toBe('failed');
  });

  it('CLI: malformed canonical envelopes/ evidence fails closed (does not fall back to root)', async () => {
    const dir = await makeTempDir();
    const evidenceDir = path.join(dir, 'evidence');
    const envelopesDir = path.join(evidenceDir, 'envelopes');
    await mkdir(envelopesDir, { recursive: true });

    const validRoot = buildGateEvidence('migration-compat');
    // Valid legacy root artifact must NOT be used when envelopes/ exists with corrupt file.
    await writeFile(
      path.join(evidenceDir, 'migration-compat.envelope.json'),
      JSON.stringify(validRoot),
      'utf8',
    );
    await writeFile(
      path.join(envelopesDir, 'migration-compat.envelope.json'),
      '{ not-valid-json',
      'utf8',
    );

    const candidatePath = path.join(dir, 'candidate.json');
    const planPath = path.join(dir, 'plan.json');
    const outPath = path.join(dir, 'report.json');
    await writeFile(candidatePath, JSON.stringify(buildCandidate()), 'utf8');
    await writeFile(planPath, JSON.stringify(buildPlan()), 'utf8');

    const cli = path.resolve(process.cwd(), 'scripts/enterprise/preflight.ts');
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(
        'bun',
        [
          'run',
          cli,
          'preflight',
          '--candidate',
          candidatePath,
          '--plan',
          planPath,
          '--evidence-dir',
          evidenceDir,
          '--output',
          outPath,
        ],
        { cwd: process.cwd(), env: process.env },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });

    // Discriminating assertions (old fallback wrote a report with migration-compat=passed):
    // process dies before runProductionPreflight → no report file; canonical parse error surfaces.
    expect(result.code, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/Malformed JSON:\s*migration-compat\.envelope\.json/);
    await expect(readFile(outPath, 'utf8')).rejects.toThrow();
  }, 30_000);

  it('CLI: valid envelopes/ evidence is preferred over a differing root twin', async () => {
    const dir = await makeTempDir();
    const evidenceDir = path.join(dir, 'evidence');
    const envelopesDir = path.join(evidenceDir, 'envelopes');
    await mkdir(envelopesDir, { recursive: true });

    // Root twin is failed; canonical envelopes/ copy is passed — load must prefer envelopes/.
    const rootFailed = {
      ...buildGateEvidence('migration-compat'),
      status: 'failed' as const,
      assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
    };
    const envelopesPassed = buildGateEvidence('migration-compat');
    await writeFile(
      path.join(evidenceDir, 'migration-compat.envelope.json'),
      JSON.stringify(rootFailed),
      'utf8',
    );
    await writeFile(
      path.join(envelopesDir, 'migration-compat.envelope.json'),
      JSON.stringify(envelopesPassed),
      'utf8',
    );

    const candidatePath = path.join(dir, 'candidate.json');
    const planPath = path.join(dir, 'plan.json');
    const outPath = path.join(dir, 'report.json');
    await writeFile(candidatePath, JSON.stringify(buildCandidate()), 'utf8');
    await writeFile(planPath, JSON.stringify(buildPlan()), 'utf8');

    const cli = path.resolve(process.cwd(), 'scripts/enterprise/preflight.ts');
    const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(
          'bun',
          [
            'run',
            cli,
            'preflight',
            '--candidate',
            candidatePath,
            '--plan',
            planPath,
            '--evidence-dir',
            evidenceDir,
            '--output',
            outPath,
          ],
          { cwd: process.cwd(), env: process.env },
        );
        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr, stdout }));
      },
    );

    // preflight with partial evidence is still non-zero / unverified, but the gate must
    // reflect the envelopes/ twin (passed), not the failed root twin.
    expect(result.code, result.stderr).not.toBe(0);
    const reportRaw = await readFile(outPath, 'utf8');
    const report = JSON.parse(reportRaw) as {
      checks?: Array<{ gate?: string; result?: string }>;
      overall?: string;
    };
    expect(report.overall).not.toBe('passed');
    const migration = report.checks?.find((c) => c.gate === 'migration-compat');
    expect(migration?.result).toBe('passed');
    expect(result.stdout + result.stderr).toMatch(/check gate=migration-compat result=passed/);
  }, 30_000);
});

describe('release plan high-risk binding', () => {
  it('emits A–F with separate high-risk first-enables and matching commands', () => {
    const plan = buildDefaultReleasePlan({
      candidateGitSha: FIXTURE_CANDIDATE_SHA,
      releaseId: 'rc-demo',
    });
    expect(releasePlanSchema.safeParse(plan).success).toBe(true);
    const firstEnables = plan.windows
      .map((w: { firstEnableCapability: string }) => w.firstEnableCapability)
      .filter((c: string) => c !== 'none');
    expect(new Set(firstEnables).size).toBe(4);
  });

  it('rejects multiple high-risk enable commands in one window', () => {
    const plan = buildPlan();
    const win = plan.windows.find(
      (w: { firstEnableCapability: string }) => w.firstEnableCapability === 'oidc',
    )!;
    (win as { forwardCommandIds: string[] }).forwardCommandIds = [
      'flag-enable-oidc',
      'flag-enable-branding-cutover',
      'monitor-release-window',
    ];
    expect(releasePlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe('command allowlist — no recursive dry-run success', () => {
  it('rejects injection strings', async () => {
    await expect(
      dispatchAllowlistedCommand({
        commandId: 'preflight-validate; rm -rf /',
        confirmExecute: false,
        execute: false,
      }),
    ).rejects.toThrow();
  });

  it('outer execute of release-window-activate actually mutates state (not recursive dry-run)', async () => {
    const dir = await makeTempDir();
    const result = await dispatchAllowlistedCommand({
      commandId: 'release-window-activate',
      confirmExecute: true,
      execute: true,
      stateDir: dir,
      windowId: 'milestone-a',
    });
    expect(result.mode).toBe('executed');
    expect(result.exitCode).toBe(0);
    expect(result.postcondition).toContain('windowActive=milestone-a');
    expect(result.beforeDigest).not.toBe(result.afterDigest);
    const state = JSON.parse(
      await readFile(path.join(dir, 'readiness-command-state.json'), 'utf8'),
    );
    expect(state.windowActive).toBe('milestone-a');

    const again = await dispatchAllowlistedCommand({
      commandId: 'release-window-activate',
      confirmExecute: true,
      execute: true,
      stateDir: dir,
      windowId: 'milestone-a',
    });
    expect(again.mode).toBe('already-satisfied');
    expect(again.beforeDigest).toBe(again.afterDigest);
  });

  it('monitor reports observed not executed', async () => {
    const dir = await makeTempDir();
    const result = await dispatchAllowlistedCommand({
      commandId: 'monitor-release-window',
      confirmExecute: false,
      execute: true,
      stateDir: dir,
    });
    expect(result.mode).toBe('observed');
    expect(result.mutates).toBe(false);
  });

  it('production-authorized drill commands are unavailable (not fake success)', async () => {
    const result = await dispatchAllowlistedCommand({
      commandId: 'backup-restore-drill-production-authorized',
      confirmExecute: true,
      execute: true,
    });
    expect(result.mode).toBe('unavailable');
    expect(result.exitCode).not.toBe(0);
  });
});

describe('privacy and cleanup ownership', () => {
  it('privacy flags connection strings', () => {
    expect(scanForForbiddenReportContent({ note: 'postgres://admin:x@db/internal' }).result).toBe(
      'failed',
    );
  });

  it('cleanup requires ownership proof; prefix alone is insufficient', async () => {
    const parent = await makeTempDir();
    const owned = await createToolOwnedTempDir(parent);
    expect(owned.absolutePath.length).toBeGreaterThan(0);

    // Without proof → skipped
    expect(await cleanupToolOwnedPath(owned.absolutePath)).toBe('skipped');

    // Foreign prefix collision
    const foreign = path.join(parent, 'm15q06-pr-foreign-not-owned');
    await mkdir(foreign);
    expect(
      await cleanupToolOwnedPath(foreign, {
        expectedParentRealpath: owned.parentRealpath,
        ownerToken: owned.ownerToken,
      }),
    ).toBe('skipped');

    // Correct proof
    expect(
      await cleanupToolOwnedPath(owned.absolutePath, {
        expectedParentRealpath: owned.parentRealpath,
        ownerToken: owned.ownerToken,
        dev: owned.dev,
        ino: owned.ino,
      }),
    ).toBe('passed');
  });

  it('atomic write deterministic', async () => {
    const dir = await makeTempDir();
    const out = path.join(dir, 'r.json');
    const { sha256 } = await writeJsonAtomic(out, { ok: true });
    expect(sha256).toMatch(/^[a-f\d]{64}$/);
  });
});

describe('signed production path with test keys only', () => {
  it('test keys never accepted by PRODUCTION_TRUST_POLICY', () => {
    const bundle = createTestTrustBundle(['production']);
    const signed = signGateEvidence(buildGateEvidence('path-boundaries'), bundle, 'production');
    const { report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: [signed, ...buildFullCiEvidence().slice(1)],
      mode: 'production-authorized',
      plan: buildPlan(),
      trustPolicy: PRODUCTION_TRUST_POLICY,
    });
    expect(report.overall).not.toBe('passed');
  });
});
