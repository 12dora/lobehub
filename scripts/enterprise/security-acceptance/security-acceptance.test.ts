// @vitest-environment node
/**
 * Falsifying tests for M13 PR-S05 security acceptance (REWORK round 1).
 * Covers: artifact-bound integrity, forgeries, leakage baseline/coverage,
 * pen skips/S06 targets, dependency exit matrix, workflow shell semantics.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { digestCanonical } from './canonical';
import {
  DEPENDENCY_FAIL_SEVERITIES,
  EVIDENCE_CLASS,
  EXTERNAL_PEN_TEST_STATUS,
  SECURITY_ACCEPTANCE_SCHEMA_VERSION,
} from './constants';
import { parsePnpmAuditJson, runDependencyScan } from './dependencyScan';
import { evaluateSecurityAcceptance, verifySecurityAcceptanceReport } from './evaluate';
import { isExactAllowlistedFinding } from './leakageAllowlist';
import { fingerprintKey } from './leakageBaseline';
import { runLeakageScan } from './leakageScan';
import type { PenAdapterDefinition } from './penManifest';
import { PEN_REGRESSION_MANIFEST } from './penManifest';
import { runPenRegression } from './penRegression';
import { digestLine, scanForForbiddenReportContent } from './privacy';
import type { ProcessResult, ProcessRunner } from './process';
import {
  type DependencyScanArtifact,
  isSecurityAcceptancePassed,
  type LeakageScanArtifact,
  type PenRegressionArtifact,
  securityAcceptanceReportSchema,
} from './schemas';
import { captureAcceptanceRun, finalAcceptanceGate } from './workflowShell';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'm13-s05-r1-'));
  tempDirs.push(dir);
  return dir;
};

const FIXTURE_SHA = 'a'.repeat(40);
const FIXED_ISO = '2026-07-21T00:00:00.000Z';
const D64 = (ch: string) => ch.repeat(64);

const mockRunner =
  (handler: (argv: readonly string[]) => ProcessResult | Promise<ProcessResult>): ProcessRunner =>
  async (argv) =>
    handler(argv);

const okProcess = (stdout: string, code = 0): ProcessResult => ({
  code,
  outputTruncated: false,
  stderr: '',
  stdout,
  timedOut: false,
});

const baseDependency = (
  overrides: Partial<DependencyScanArtifact> = {},
): DependencyScanArtifact => ({
  checkId: 'dependency-scan',
  exitCode: 0,
  failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
  policyHits: 0,
  schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
  severityCounts: { critical: 0, high: 0, info: 0, low: 0, moderate: 0 },
  status: 'passed',
  target: {
    kind: 'pnpm-lock',
    lockfileSha256: D64('b'),
    packageJsonSha256: D64('c'),
    path: 'pnpm-lock.yaml',
  },
  tool: { id: 'pnpm-audit', version: '10.33.0' },
  ...overrides,
});

const baseLeakage = (overrides: Partial<LeakageScanArtifact> = {}): LeakageScanArtifact => ({
  allowlistedMatches: 0,
  baselinedMatches: 0,
  checkId: 'leakage-scan',
  coverage: {
    baselinedMatches: 0,
    filesScanned: 12,
    oversizedSkipped: 0,
    rootsMissing: 0,
    rootsPresent: 1,
    rootsRequired: 1,
    symlinkEncounters: 0,
    unreadableFiles: 0,
    walkErrors: 0,
  },
  findings: [],
  filesScanned: 12,
  schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
  status: 'passed',
  violationCount: 0,
  ...overrides,
});

const fullPenManifestPass = (): PenRegressionArtifact => ({
  adapters: PEN_REGRESSION_MANIFEST.map((definition) => ({
    adapterId: definition.id,
    assertions: { failed: 0, passed: 3, skipped: 0, total: 3 },
    category: definition.category,
    exitCode: 0,
    status: 'passed' as const,
    targets: [...definition.testFiles],
  })),
  checkId: 'pen-regression',
  schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
  status: 'passed',
});

const tinyManifest: readonly PenAdapterDefinition[] = [
  {
    id: 'reauth-guard',
    category: 'reauth',
    description: 'reauth',
    required: true,
    testFiles: ['apps/server/src/enterprise/guards/reauth.test.ts'],
  },
];

describe('parsePnpmAuditJson', () => {
  it('counts high/critical policy hits', () => {
    const result = parsePnpmAuditJson({
      metadata: {
        vulnerabilities: { critical: 1, high: 9, info: 0, low: 2, moderate: 21 },
      },
    });
    expect(result.policyHits).toBe(10);
  });

  it('rejects malformed output', () => {
    expect(() => parsePnpmAuditJson({})).toThrow(/malformed/i);
    expect(() => parsePnpmAuditJson({ error: { code: 'ERR' } })).toThrow(/audit-tool-error/);
  });
});

describe('dependency exit matrix', () => {
  const setupDir = async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'package.json'), '{"name":"x"}\n', 'utf8');
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    return dir;
  };

  it('marks scanner unavailable when pnpm version cannot be resolved', async () => {
    const dir = await setupDir();
    const artifact = await runDependencyScan({
      allowGenerateLockfile: false,
      cwd: dir,
      runProcess: mockRunner(async (argv) => {
        if (argv[0] === 'pnpm' && argv[1] === '--version') return okProcess('', 1);
        return okProcess('{}', 1);
      }),
    });
    expect(artifact.status).toBe('unavailable');
    expect(artifact.reason).toBe('scanner-unavailable');
  });

  it('fails on high/critical advisories with exit 1', async () => {
    const dir = await setupDir();
    const auditPayload = {
      metadata: {
        vulnerabilities: { critical: 1, high: 9, info: 0, low: 0, moderate: 0 },
      },
    };
    const artifact = await runDependencyScan({
      allowGenerateLockfile: false,
      cwd: dir,
      runProcess: mockRunner(async (argv) => {
        if (argv[0] === 'pnpm' && argv[1] === '--version') return okProcess('10.33.0\n');
        if (argv.includes('audit')) return okProcess(JSON.stringify(auditPayload), 1);
        return okProcess('', 1);
      }),
    });
    expect(artifact.status).toBe('failed');
    expect(artifact.policyHits).toBe(10);
    expect(artifact.exitCode).toBe(1);
  });

  it('treats unexpected exit 99 with zero hits as unavailable (never pass)', async () => {
    const dir = await setupDir();
    const auditPayload = {
      metadata: {
        vulnerabilities: { critical: 0, high: 0, info: 0, low: 0, moderate: 0 },
      },
    };
    const artifact = await runDependencyScan({
      allowGenerateLockfile: false,
      cwd: dir,
      runProcess: mockRunner(async (argv) => {
        if (argv[0] === 'pnpm' && argv[1] === '--version') return okProcess('10.33.0\n');
        if (argv.includes('audit')) return okProcess(JSON.stringify(auditPayload), 99);
        return okProcess('', 1);
      }),
    });
    expect(artifact.status).toBe('unavailable');
    expect(artifact.reason).toBe('unexpected-scanner-exit');
    expect(artifact.exitCode).toBe(99);
  });

  it('treats exit 1 with zero policy hits as unavailable', async () => {
    const dir = await setupDir();
    const auditPayload = {
      metadata: {
        vulnerabilities: { critical: 0, high: 0, info: 0, low: 0, moderate: 0 },
      },
    };
    const artifact = await runDependencyScan({
      allowGenerateLockfile: false,
      cwd: dir,
      runProcess: mockRunner(async (argv) => {
        if (argv[0] === 'pnpm' && argv[1] === '--version') return okProcess('10.33.0\n');
        if (argv.includes('audit')) return okProcess(JSON.stringify(auditPayload), 1);
        return okProcess('', 1);
      }),
    });
    expect(artifact.status).toBe('unavailable');
    expect(artifact.reason).toBe('unexpected-advisory-exit');
  });

  it('passes only on exit 0 with zero high/critical', async () => {
    const dir = await setupDir();
    const auditPayload = {
      metadata: {
        vulnerabilities: { critical: 0, high: 0, info: 0, low: 1, moderate: 2 },
      },
    };
    const artifact = await runDependencyScan({
      allowGenerateLockfile: false,
      cwd: dir,
      runProcess: mockRunner(async (argv) => {
        if (argv[0] === 'pnpm' && argv[1] === '--version') return okProcess('10.33.0\n');
        if (argv.includes('audit')) return okProcess(JSON.stringify(auditPayload), 0);
        return okProcess('', 1);
      }),
    });
    expect(artifact.status).toBe('passed');
    expect(artifact.exitCode).toBe(0);
  });
});

describe('leakage coverage fail-closed', () => {
  it('fails when non-allowlisted secret material is present', async () => {
    const dir = await makeTempDir();
    const root = path.join(dir, 'apps/server/src/enterprise');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'leaky.ts'), 'password=MustFailLeakageScanValue99\n', 'utf8');

    const artifact = await runLeakageScan({
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise'],
    });

    expect(artifact.status).toBe('failed');
    expect(artifact.violationCount).toBeGreaterThan(0);
    expect(JSON.stringify(artifact)).not.toContain('MustFailLeakageScanValue99');
  });

  it('missing required root is unavailable (never pass)', async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, 'apps/server/src/enterprise'), { recursive: true });
    await writeFile(path.join(dir, 'apps/server/src/enterprise/ok.ts'), 'export const x = 1;\n');

    const artifact = await runLeakageScan({
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise', 'missing-root-surface'],
    });

    expect(artifact.status).toBe('unavailable');
    expect(artifact.reason).toBe('missing-required-root');
    expect(artifact.coverage.rootsMissing).toBe(1);
  });

  it('oversized secret-bearing candidate fails closed (not silent pass)', async () => {
    const dir = await makeTempDir();
    const root = path.join(dir, 'apps/server/src/enterprise');
    await mkdir(root, { recursive: true });
    // Write oversized file with secret shape; scanner must not pass by skipping.
    const big = `${'a'.repeat(2 * 1024 * 1024 + 100)}\npassword=OversizedSecretValue99\n`;
    await writeFile(path.join(root, 'big.ts'), big, 'utf8');
    await writeFile(path.join(root, 'ok.ts'), 'export const x = 1;\n', 'utf8');

    const artifact = await runLeakageScan({
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise'],
    });

    expect(artifact.status).toBe('failed');
    expect(artifact.reason).toBe('oversized-files-present');
    expect(artifact.coverage.oversizedSkipped).toBeGreaterThan(0);
  });

  it('symlink file under root fails closed', async () => {
    const dir = await makeTempDir();
    const root = path.join(dir, 'apps/server/src/enterprise');
    await mkdir(root, { recursive: true });
    const outside = path.join(dir, 'outside-secret.txt');
    await writeFile(outside, 'password=SymlinkSecretValue99\n', 'utf8');
    await writeFile(path.join(root, 'ok.ts'), 'export const x = 1;\n', 'utf8');
    await symlink(outside, path.join(root, 'linked.ts'));

    const artifact = await runLeakageScan({
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise'],
    });

    expect(artifact.status).toBe('failed');
    expect(artifact.reason).toBe('symlink-encountered');
    expect(artifact.coverage.symlinkEncounters).toBeGreaterThan(0);
  });

  it('symlink directory under root fails closed', async () => {
    const dir = await makeTempDir();
    const root = path.join(dir, 'apps/server/src/enterprise');
    await mkdir(root, { recursive: true });
    const outsideDir = path.join(dir, 'outside-dir');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, 'secret.ts'), 'password=DirSymlinkSecret99\n', 'utf8');
    await writeFile(path.join(root, 'ok.ts'), 'export const x = 1;\n', 'utf8');
    await symlink(outsideDir, path.join(root, 'linked-dir'));

    const artifact = await runLeakageScan({
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise'],
    });

    expect(artifact.status).toBe('failed');
    expect(artifact.reason).toBe('symlink-encountered');
  });

  it('baseline accepts exact fingerprint; changed content fails', async () => {
    const dir = await makeTempDir();
    const root = path.join(dir, 'apps/server/src/enterprise');
    await mkdir(root, { recursive: true });
    const line = 'password=BaselinedKnownValue99';
    await writeFile(path.join(root, 'known.ts'), `${line}\n`, 'utf8');
    const fp = {
      path: 'apps/server/src/enterprise/known.ts',
      category: 'credential-assignment',
      lineDigest: digestLine(line),
    };

    const baselined = await runLeakageScan({
      baselineFindings: [fp],
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise'],
    });
    expect(baselined.status).toBe('passed');
    expect(baselined.baselinedMatches).toBe(1);

    await writeFile(path.join(root, 'known.ts'), 'password=ChangedNotBaselined99\n', 'utf8');
    const changed = await runLeakageScan({
      baselineFindings: [fp],
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise'],
    });
    expect(changed.status).toBe('failed');
    expect(changed.violationCount).toBe(1);
  });

  it('path-wide allowlist is insufficient: exact digest required', async () => {
    const dir = await makeTempDir();
    const fixtureRel =
      'scripts/enterprise/security-acceptance/fixtures/synthetic-secret.fixture.txt';
    const fixtureAbs = path.join(dir, fixtureRel);
    await mkdir(path.dirname(fixtureAbs), { recursive: true });
    // Same path as allowlisted fixture but different secret content
    await writeFile(fixtureAbs, 'password=ArbitraryReplacementSecret99\n', 'utf8');

    const artifact = await runLeakageScan({
      cwd: dir,
      requireBaseline: false,
      roots: ['scripts/enterprise'],
    });

    expect(artifact.status).toBe('failed');
    expect(artifact.findings.some((f) => f.path === fixtureRel)).toBe(true);
  });

  it('exact allowlist fingerprints match fixture lines', () => {
    const line = 'password=SyntheticFixtureHunter2Value99';
    expect(
      isExactAllowlistedFinding({
        path: 'scripts/enterprise/security-acceptance/fixtures/synthetic-secret.fixture.txt',
        category: 'credential-assignment',
        lineDigest: digestLine(line),
      }),
    ).toBe(true);
    expect(
      isExactAllowlistedFinding({
        path: 'scripts/enterprise/security-acceptance/fixtures/synthetic-secret.fixture.txt',
        category: 'credential-assignment',
        lineDigest: digestLine('password=other'),
      }),
    ).toBe(false);
  });
});

describe('pen regression', () => {
  it('fails closed when S06 rate-limit targets are missing', async () => {
    const dir = await makeTempDir();
    const artifact = await runPenRegression({
      cwd: dir,
      manifest: PEN_REGRESSION_MANIFEST,
      runProcess: mockRunner(async () => okProcess('{}', 0)),
    });
    expect(artifact.status).toBe('failed');
    expect(artifact.reason).toBe('missing-required-adapter');
    const rateLimit = artifact.adapters.filter((a) => a.category === 'admin-rate-limit');
    expect(rateLimit.length).toBe(2);
    expect(rateLimit.every((a) => a.status === 'not-executed')).toBe(true);
    expect(rateLimit[0]?.targets[0]).toContain('adminMutationRateLimiter.test.ts');
    expect(rateLimit[1]?.targets[0]).toContain('adminMutationRateLimit.test.ts');
  });

  it('allows reviewed GC skip title and rejects unexpected skips', async () => {
    const dir = await makeTempDir();
    const testRel = 'packages/ssrf-safe-fetch/index.test.ts';
    await mkdir(path.dirname(path.join(dir, testRel)), { recursive: true });
    await writeFile(path.join(dir, testRel), '// stub\n', 'utf8');

    const manifest: PenAdapterDefinition[] = [
      {
        id: 'ssrf-safe-fetch',
        category: 'ssrf',
        description: 'ssrf',
        expectedSkips: [
          {
            reason: 'gc-not-exposed',
            title: 'heap delta stays bounded when a 50 MB body is fetched with a 1 MB cap',
          },
        ],
        required: true,
        testFiles: [testRel],
        workingDirectory: 'packages/ssrf-safe-fetch',
      },
    ];

    const allowed = await runPenRegression({
      cwd: dir,
      manifest,
      runProcess: mockRunner(async () =>
        okProcess(
          JSON.stringify({
            numFailedTests: 0,
            numPassedTests: 32,
            numPendingTests: 1,
            numTodoTests: 0,
            numTotalTests: 33,
            success: true,
            testResults: [
              {
                assertionResults: [
                  {
                    status: 'skipped',
                    title: 'heap delta stays bounded when a 50 MB body is fetched with a 1 MB cap',
                  },
                ],
              },
            ],
          }),
          0,
        ),
      ),
    });
    expect(allowed.status).toBe('passed');
    expect(allowed.adapters[0]?.assertions?.skipped).toBe(1);

    const unexpected = await runPenRegression({
      cwd: dir,
      manifest,
      runProcess: mockRunner(async () =>
        okProcess(
          JSON.stringify({
            numFailedTests: 0,
            numPassedTests: 32,
            numPendingTests: 1,
            numTodoTests: 0,
            numTotalTests: 33,
            success: true,
            testResults: [
              {
                assertionResults: [{ status: 'skipped', title: 'unrelated flaky skip' }],
              },
            ],
          }),
          0,
        ),
      ),
    });
    expect(unexpected.status).toBe('failed');
    expect(unexpected.adapters[0]?.reason).toBe('unexpected-skip');
  });
});

describe('integrity binding and forgery resistance', () => {
  it('happy path binds artifacts into core digest', () => {
    const { exitCode, report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: fullPenManifestPass(),
    });
    expect(exitCode).toBe(0);
    expect(report.overall).toBe('passed');
    expect(isSecurityAcceptancePassed(report)).toBe(true);

    const core = {
      artifacts: report.artifacts,
      checks: report.checks,
      evidenceClass: report.evidenceClass,
      externalPenetrationTest: report.externalPenetrationTest,
      gitSha: report.gitSha,
      lane: report.lane,
      overall: report.overall,
      policy: report.policy,
      schemaVersion: report.schemaVersion,
    };
    expect(report.integrity.reportCoreSha256).toBe(digestCanonical(core));
    expect(verifySecurityAcceptanceReport(report).ok).toBe(true);
  });

  it('reviewer forgery: overall=passed with policyHits=999 fails verify', () => {
    const { report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: fullPenManifestPass(),
    });

    const forged = structuredClone(report);
    forged.artifacts['dependency-scan'].policyHits = 999;
    forged.artifacts['dependency-scan'].severityCounts = {
      critical: 999,
      high: 0,
      info: 0,
      low: 0,
      moderate: 0,
    };
    // Keep summary overall=passed and old digest
    forged.overall = 'passed';
    forged.checks = report.checks;

    // Schema may still parse shape; verify must recompute semantics
    const verified = verifySecurityAcceptanceReport(forged);
    expect(verified.ok).toBe(false);
  });

  it('reviewer forgery: filesScanned=0 with passed leakage fails verify', () => {
    const { report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: fullPenManifestPass(),
    });

    const forged = structuredClone(report);
    forged.artifacts['leakage-scan'].filesScanned = 0;
    forged.artifacts['leakage-scan'].coverage.filesScanned = 0;
    forged.artifacts['leakage-scan'].status = 'passed';

    const verified = verifySecurityAcceptanceReport(forged);
    expect(verified.ok).toBe(false);
  });

  it('reviewer forgery: single fake pen adapter fails set validation', () => {
    const { report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: fullPenManifestPass(),
    });

    const forged = structuredClone(report);
    forged.artifacts['pen-regression'] = {
      adapters: [
        {
          adapterId: 'fake-only',
          assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
          category: 'ssrf',
          exitCode: 0,
          status: 'passed',
          targets: [
            'apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.test.ts',
          ],
        },
      ],
      checkId: 'pen-regression',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'passed',
    };

    const verified = verifySecurityAcceptanceReport(forged);
    expect(verified.ok).toBe(false);
  });

  it('tampering critical count preserves old digest → verify fails', () => {
    const { report } = evaluateSecurityAcceptance({
      dependency: baseDependency({
        exitCode: 1,
        policyHits: 1,
        reason: 'policy-severity-hits',
        severityCounts: { critical: 1, high: 0, info: 0, low: 0, moderate: 0 },
        status: 'failed',
      }),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: fullPenManifestPass(),
    });

    expect(report.overall).toBe('failed');
    const originalDigest = report.integrity.reportCoreSha256;

    const tampered = structuredClone(report);
    tampered.artifacts['dependency-scan'].severityCounts = {
      critical: 999,
      high: 0,
      info: 0,
      low: 0,
      moderate: 0,
    };
    tampered.artifacts['dependency-scan'].policyHits = 999;
    // Keep old digest (attacker tries to preserve integrity field)
    tampered.integrity.reportCoreSha256 = originalDigest;

    const verified = verifySecurityAcceptanceReport(tampered);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(
        verified.reason === 'report-core-digest-mismatch' ||
          verified.reason.startsWith('semantic-') ||
          verified.reason === 'overall-mismatch' ||
          verified.reason === 'checks-mismatch',
      ).toBe(true);
    }
  });

  it('rejects self-asserted external pen-test completion', () => {
    const { report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: fullPenManifestPass(),
    });
    const forged = {
      ...report,
      externalPenetrationTest: {
        note: report.externalPenetrationTest.note,
        status: 'passed',
      },
    };
    expect(securityAcceptanceReportSchema.safeParse(forged).success).toBe(false);
  });

  it('report privacy scan rejects secret-shaped values', () => {
    expect(
      scanForForbiddenReportContent({
        password: 'hunter2',
        token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      }).result,
    ).toBe('failed');
  });
});

describe('workflow shell semantics', () => {
  it('captures OUTPUT_DIR even when harness exits nonzero', () => {
    const captured = captureAcceptanceRun({
      harnessExit: 1,
      outputDir: '/tmp/evidence',
      reportWritten: true,
    });
    expect(captured.outputDir).toBe('/tmp/evidence');
    expect(captured.harnessExit).toBe(1);
    expect(captured.reportPresent).toBe(true);
  });

  it('final gate fails on missing report after harness failure', () => {
    const gate = finalAcceptanceGate({
      harnessExit: 1,
      reportPresent: false,
      secretScanFailed: false,
      verifyFailed: false,
    });
    expect(gate.exitCode).toBe(2);
    expect(gate.reason).toBe('missing-report');
  });

  it('final gate propagates harness exit after successful verify/upload path', () => {
    const gate = finalAcceptanceGate({
      harnessExit: 1,
      reportPresent: true,
      secretScanFailed: false,
      verifyFailed: false,
    });
    expect(gate.exitCode).toBe(1);
    expect(gate.reason).toBe('failed');
  });

  it('final gate fails when verify fails even if harness passed', () => {
    const gate = finalAcceptanceGate({
      harnessExit: 0,
      reportPresent: true,
      secretScanFailed: false,
      verifyFailed: true,
    });
    expect(gate.exitCode).toBe(1);
    expect(gate.reason).toBe('verify-failed');
  });
});

describe('real repository leakage baseline', () => {
  it('passes against committed reviewed baseline without dumping secrets', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const artifact = await runLeakageScan({ cwd: repoRoot });
    expect(artifact.status).toBe('passed');
    expect(artifact.violationCount).toBe(0);
    expect(artifact.filesScanned).toBeGreaterThan(100);
    expect(artifact.baselinedMatches).toBeGreaterThan(0);
    expect(JSON.stringify(artifact)).not.toMatch(/password=\S+/u);
  }, 120_000);
});

describe('fingerprint stability', () => {
  it('fingerprint keys are path+category+digest only', () => {
    const key = fingerprintKey({
      path: 'a.ts',
      category: 'credential-assignment',
      lineDigest: D64('d'),
    });
    expect(key).toContain('a.ts');
    expect(key).not.toContain('password');
  });
});

describe('evidence class constants', () => {
  it('keeps external pen test not-executed', () => {
    expect(EVIDENCE_CLASS).toBe('repository-automation');
    expect(EXTERNAL_PEN_TEST_STATUS).toBe('not-executed');
  });
});

// silence unused tinyManifest if not used - use it
describe('tiny manifest pending targets', () => {
  it('models missing target fail-closed without weakening', async () => {
    const dir = await makeTempDir();
    const artifact = await runPenRegression({
      cwd: dir,
      manifest: tinyManifest,
      runProcess: mockRunner(async () => okProcess('{}', 0)),
    });
    expect(artifact.status).toBe('failed');
    expect(artifact.adapters[0]?.reason).toBe('missing-test-target');
  });
});
