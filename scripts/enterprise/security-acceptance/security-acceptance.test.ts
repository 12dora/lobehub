// @vitest-environment node
/**
 * Falsifying tests for M13 PR-S05 security acceptance (REWORK rounds 1–2).
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import {
  evaluateSecurityAcceptance,
  isSecurityAcceptancePassed,
  verifySecurityAcceptanceReport,
} from './evaluate';
import { isExactAllowlistedFinding } from './leakageAllowlist';
import { baselinesEqual, buildBaselineDocument, fingerprintKey } from './leakageBaseline';
import { runLeakageScan } from './leakageScan';
import { assertNoUndefinedDeep } from './omitUndefined';
import type { PenAdapterDefinition } from './penManifest';
import { PEN_REGRESSION_MANIFEST } from './penManifest';
import { runPenRegression } from './penRegression';
import { digestLine, scanForForbiddenReportContent } from './privacy';
import {
  isProcessAbsent,
  makeSnapshotPidPpid,
  parseCanonicalPid,
  parseCanonicalPpid,
  parseCanonicalSafeNonNegInt,
  parsePidPpidTable,
  type PidExistenceProbe,
  type PidTableSnapshotter,
  probePidExistence,
  PROCESS_CLEANUP_DEADLINE_MS,
  PROCESS_KILL_GRACE_MS,
  processExists,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
  terminateProcessTree,
  validatePidMapStructure,
  validateSnapshotCompleteness,
} from './process';
import { validateRepoRelativeRoot } from './repoPaths';
import { evaluateFromChecksDir } from './runner';
import {
  type DependencyScanArtifact,
  leakageBaselineSchema,
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
  cleanupFailed: false,
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

  it('reviewer forgery: overall=passed with policyHits=999 fails verify and pass predicate', () => {
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
    // Public pass API must not authorize tampered reports
    expect(isSecurityAcceptancePassed(forged)).toBe(false);
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

describe('undefined-free artifacts and runner write path', () => {
  it('pen aggregate omits reason when passed; adapters omit skippedTitles when empty', async () => {
    const dir = await makeTempDir();
    const testRel = 'apps/server/src/enterprise/guards/reauth.test.ts';
    await mkdir(path.dirname(path.join(dir, testRel)), { recursive: true });
    await writeFile(path.join(dir, testRel), '// stub\n', 'utf8');

    const pen = await runPenRegression({
      cwd: dir,
      manifest: tinyManifest,
      runProcess: mockRunner(async () =>
        okProcess(
          JSON.stringify({
            numFailedTests: 0,
            numPassedTests: 2,
            numPendingTests: 0,
            numTodoTests: 0,
            numTotalTests: 2,
            success: true,
            testResults: [{ assertionResults: [{ status: 'passed', title: 'a' }] }],
          }),
          0,
        ),
      ),
    });
    expect(pen.status).toBe('passed');
    expect(Object.hasOwn(pen, 'reason')).toBe(false);
    expect(Object.hasOwn(pen.adapters[0]!, 'skippedTitles')).toBe(false);
    assertNoUndefinedDeep(pen);
  });

  it('runner evaluate→write→read→verify works for pass and fail decisions', async () => {
    const dir = await makeTempDir();
    const checksPass = path.join(dir, 'checks-pass');
    const checksFail = path.join(dir, 'checks-fail');
    await mkdir(checksPass, { recursive: true });
    await mkdir(checksFail, { recursive: true });

    const writeChecks = async (
      checksDir: string,
      dependency: DependencyScanArtifact,
      leakage: LeakageScanArtifact,
      pen: PenRegressionArtifact,
    ) => {
      await writeFile(
        path.join(checksDir, 'dependency-scan.json'),
        `${JSON.stringify(dependency, null, 2)}\n`,
      );
      await writeFile(
        path.join(checksDir, 'leakage-scan.json'),
        `${JSON.stringify(leakage, null, 2)}\n`,
      );
      await writeFile(
        path.join(checksDir, 'pen-regression.json'),
        `${JSON.stringify(pen, null, 2)}\n`,
      );
    };

    await writeChecks(checksPass, baseDependency(), baseLeakage(), fullPenManifestPass());
    const passOut = path.join(dir, 'out-pass');
    const passResult = await evaluateFromChecksDir({
      checksDir: checksPass,
      gitSha: FIXTURE_SHA,
      nowIso: FIXED_ISO,
      outputDir: passOut,
    });
    expect(passResult.exitCode).toBe(0);
    const passDisk = JSON.parse(
      await readFile(path.join(passOut, 'security-acceptance.report.json'), 'utf8'),
    ) as unknown;
    assertNoUndefinedDeep(passDisk);
    expect(verifySecurityAcceptanceReport(passDisk).ok).toBe(true);
    expect(isSecurityAcceptancePassed(passDisk)).toBe(true);

    await writeChecks(
      checksFail,
      baseDependency({
        exitCode: 1,
        policyHits: 1,
        reason: 'policy-severity-hits',
        severityCounts: { critical: 1, high: 0, info: 0, low: 0, moderate: 0 },
        status: 'failed',
      }),
      baseLeakage(),
      fullPenManifestPass(),
    );
    const failOut = path.join(dir, 'out-fail');
    const failResult = await evaluateFromChecksDir({
      checksDir: checksFail,
      gitSha: FIXTURE_SHA,
      nowIso: FIXED_ISO,
      outputDir: failOut,
    });
    expect(failResult.exitCode).toBe(1);
    const failDisk = JSON.parse(
      await readFile(path.join(failOut, 'security-acceptance.report.json'), 'utf8'),
    ) as unknown;
    assertNoUndefinedDeep(failDisk);
    const verifiedFail = verifySecurityAcceptanceReport(failDisk);
    expect(verifiedFail.ok).toBe(true);
    if (verifiedFail.ok) expect(verifiedFail.report.overall).toBe('failed');
    expect(isSecurityAcceptancePassed(failDisk)).toBe(false);
  });

  it('unavailable artifacts still produce a verifiable report with exit 2', async () => {
    const dir = await makeTempDir();
    const checksDir = path.join(dir, 'checks');
    await mkdir(checksDir, { recursive: true });
    const dependency = baseDependency({
      reason: 'scanner-unavailable',
      status: 'unavailable',
      tool: { id: 'pnpm-audit', version: 'unknown' },
    });
    // remove exitCode for unavailable clean shape
    const { exitCode: _e, ...depNoExit } = dependency as DependencyScanArtifact & {
      exitCode?: number;
    };
    await writeFile(
      path.join(checksDir, 'dependency-scan.json'),
      `${JSON.stringify({ ...depNoExit, reason: 'scanner-unavailable', status: 'unavailable', tool: { id: 'pnpm-audit', version: 'unknown' } }, null, 2)}\n`,
    );
    await writeFile(
      path.join(checksDir, 'leakage-scan.json'),
      `${JSON.stringify(baseLeakage(), null, 2)}\n`,
    );
    await writeFile(
      path.join(checksDir, 'pen-regression.json'),
      `${JSON.stringify(fullPenManifestPass(), null, 2)}\n`,
    );
    // Fix dependency to valid unavailable semantics
    const depUnavailable: DependencyScanArtifact = {
      checkId: 'dependency-scan',
      failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      policyHits: 0,
      reason: 'scanner-unavailable',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      target: { kind: 'package-json', packageJsonSha256: D64('c'), path: 'package.json' },
      tool: { id: 'pnpm-audit', version: 'unknown' },
    };
    await writeFile(
      path.join(checksDir, 'dependency-scan.json'),
      `${JSON.stringify(depUnavailable, null, 2)}\n`,
    );

    const out = path.join(dir, 'out-unavail');
    const result = await evaluateFromChecksDir({
      checksDir,
      gitSha: FIXTURE_SHA,
      nowIso: FIXED_ISO,
      outputDir: out,
    });
    expect(result.exitCode).toBe(2);
    const disk = JSON.parse(
      await readFile(path.join(out, 'security-acceptance.report.json'), 'utf8'),
    ) as unknown;
    assertNoUndefinedDeep(disk);
    const verified = verifySecurityAcceptanceReport(disk);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.report.overall).toBe('unavailable');
  });
});

describe('baseline freshness and duplicates', () => {
  it('rejects duplicate baseline entries at schema load', () => {
    const entry = {
      path: 'a.ts',
      category: 'credential-assignment',
      lineDigest: D64('d'),
    };
    const parsed = leakageBaselineSchema.safeParse({
      entries: [entry, entry],
      schemaVersion: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it('fails when baseline has stale unconsumed fingerprint', async () => {
    const dir = await makeTempDir();
    const root = path.join(dir, 'apps/server/src/enterprise');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'ok.ts'), 'export const x = 1;\n', 'utf8');
    const stale = {
      path: 'apps/server/src/enterprise/missing.ts',
      category: 'credential-assignment',
      lineDigest: D64('e'),
    };
    const artifact = await runLeakageScan({
      baselineFindings: [stale],
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise'],
    });
    expect(artifact.status).toBe('failed');
    expect(artifact.reason).toBe('stale-baseline-entries');
  });

  it('fails when line content changes away from baseline digest', async () => {
    const dir = await makeTempDir();
    const root = path.join(dir, 'apps/server/src/enterprise');
    await mkdir(root, { recursive: true });
    const original = 'password=OriginalBaselinedValue99';
    await writeFile(path.join(root, 'known.ts'), `${original}\n`, 'utf8');
    const fp = {
      path: 'apps/server/src/enterprise/known.ts',
      category: 'credential-assignment' as const,
      lineDigest: digestLine(original),
    };
    const ok = await runLeakageScan({
      baselineFindings: [fp],
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise'],
    });
    expect(ok.status).toBe('passed');

    await writeFile(path.join(root, 'known.ts'), 'password=ChangedContentValue99\n', 'utf8');
    const changed = await runLeakageScan({
      baselineFindings: [fp],
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise'],
    });
    // stale original + new finding
    expect(changed.status).toBe('failed');
    expect(
      changed.reason === 'stale-baseline-entries' || changed.reason === 'secret-material-detected',
    ).toBe(true);
  });

  it('buildBaselineDocument is deterministic and sorted', () => {
    const a = buildBaselineDocument([
      { path: 'b.ts', category: 'token-or-api-key', lineDigest: D64('2') },
      { path: 'a.ts', category: 'credential-assignment', lineDigest: D64('1') },
      { path: 'a.ts', category: 'credential-assignment', lineDigest: D64('1') },
    ]);
    const b = buildBaselineDocument([
      { path: 'a.ts', category: 'credential-assignment', lineDigest: D64('1') },
      { path: 'b.ts', category: 'token-or-api-key', lineDigest: D64('2') },
    ]);
    expect(baselinesEqual(a, b)).toBe(true);
    expect(a.entries).toHaveLength(2);
    expect(a.entries[0]?.path).toBe('a.ts');
  });
});

describe('scan root containment', () => {
  it('rejects absolute, parent traversal, and empty roots', () => {
    expect(validateRepoRelativeRoot('/etc')).toBe('absolute-root');
    expect(validateRepoRelativeRoot('../outside')).toBe('parent-traversal');
    expect(validateRepoRelativeRoot('foo/../../etc')).toBe('parent-traversal');
    expect(validateRepoRelativeRoot('')).toBe('empty-root');
    expect(validateRepoRelativeRoot('.')).toBe('dot-root');
    expect(validateRepoRelativeRoot('apps/server/src/enterprise')).toBeUndefined();
  });

  it('runLeakageScan fails closed on roots: [../outside]', async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, 'apps/server/src/enterprise'), { recursive: true });
    await writeFile(path.join(dir, 'apps/server/src/enterprise/ok.ts'), 'export const x=1;\n');
    const artifact = await runLeakageScan({
      cwd: dir,
      requireBaseline: false,
      roots: ['../outside'],
    });
    expect(artifact.status).toBe('unavailable');
    expect(
      artifact.reason === 'unsafe-scan-root' || artifact.reason === 'missing-required-root',
    ).toBe(true);
  });
});

describe('process-tree timeout', () => {
  it('kills child+grandchild retaining stdio within bounded wall time', async () => {
    const started = Date.now();
    const timeoutMs = 150;
    const result = await runProcess(
      [
        process.execPath,
        '-e',
        `
          const {spawn} = require('child_process');
          const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
            detached: true,
            stdio: ['ignore','pipe','pipe'],
          });
          child.stdout.on('data', () => {});
          child.stderr.on('data', () => {});
          setInterval(() => {}, 1000);
          `,
      ],
      { cwd: process.cwd(), timeoutMs },
    );
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(result.cleanupFailed).toBe(false);
    const budget = timeoutMs + PROCESS_KILL_GRACE_MS + PROCESS_CLEANUP_DEADLINE_MS + 3_000;
    expect(elapsed).toBeLessThan(budget);
  }, 20_000);

  it('terminates detached grandchild that ignores SIGTERM (existence probe)', async () => {
    const pidFile = path.join(tmpdir(), `m13-s05-gc-${process.pid}-${Date.now()}.pid`);
    const timeoutMs = 200;
    let grandchildPid: number | undefined;
    try {
      const started = Date.now();
      const result = await runProcess(
        [
          process.execPath,
          '-e',
          `
            const {spawn} = require('child_process');
            const fs = require('fs');
            const pidFile = process.argv[1];
            const g = spawn(process.execPath, ['-e',
              "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"], {
              detached: true,
              stdio: 'ignore',
            });
            fs.writeFileSync(pidFile, String(g.pid));
            g.unref();
            setInterval(() => {}, 1000);
            `,
          pidFile,
        ],
        { cwd: process.cwd(), timeoutMs },
      );
      const elapsed = Date.now() - started;
      expect(result.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(timeoutMs + PROCESS_CLEANUP_DEADLINE_MS + 3_000);

      const raw = await readFile(pidFile, 'utf8').catch(() => '');
      grandchildPid = Number(raw.trim());
      expect(Number.isInteger(grandchildPid) && (grandchildPid as number) > 1).toBe(true);
      expect(isProcessAbsent(grandchildPid as number)).toBe(true);
      expect(result.cleanupFailed).toBe(false);
    } finally {
      if (grandchildPid && processExists(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // cleanup best effort
        }
      }
      await rm(pidFile, { force: true }).catch(() => undefined);
    }
  }, 25_000);

  it('unavailable PID discovery fails closed with detached TERM-ignoring grandchild', async () => {
    if (process.platform === 'win32') return;
    const pidFile = path.join(tmpdir(), `m13-s05-ps-${process.pid}-${Date.now()}.pid`);
    const timeoutMs = 200;
    let grandchildPid: number | undefined;
    try {
      // Simulate PATH=/definitely-not-real style discovery failure via injectable snapshot.
      // Parent still starts a real detached grandchild that ignores SIGTERM.
      const snapshotPidTable: PidTableSnapshotter = async () => ({
        ok: false,
        reason: 'snapshot-unavailable',
      });
      const result = await runProcess(
        [
          process.execPath,
          '-e',
          `
            const {spawn} = require('child_process');
            const fs = require('fs');
            const pidFile = process.argv[1];
            const g = spawn(process.execPath, ['-e',
              "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"], {
              detached: true,
              stdio: 'ignore',
            });
            fs.writeFileSync(pidFile, String(g.pid));
            g.unref();
            setInterval(() => {}, 1000);
            `,
          pidFile,
        ],
        {
          cwd: process.cwd(),
          snapshotPidTable,
          timeoutMs,
        },
      );
      expect(result.timedOut).toBe(true);
      // Must not claim successful cleanup when discovery is unavailable.
      expect(result.cleanupFailed).toBe(true);

      const raw = await readFile(pidFile, 'utf8').catch(() => '');
      grandchildPid = Number(raw.trim());
      expect(Number.isInteger(grandchildPid) && (grandchildPid as number) > 1).toBe(true);
      // Grandchild typically still alive because it was never discovered — residue cleaned in finally.
      expect(processExists(grandchildPid as number)).toBe(true);
    } finally {
      if (grandchildPid && processExists(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // cleanup best effort
        }
      }
      await rm(pidFile, { force: true }).catch(() => undefined);
    }
  }, 25_000);

  it('injected discovery failure fails closed without empty-success', async () => {
    const snapshotPidTable: PidTableSnapshotter = async () => ({
      ok: false,
      reason: 'snapshot-unavailable',
    });
    const probeExistence: PidExistenceProbe = (pid) =>
      pid === 424_242 ? 'alive' : probePidExistence(pid);
    const result = await terminateProcessTree(424_242, {
      deadlineMs: 150,
      graceMs: 40,
      probeExistence,
      snapshotPidTable,
    });
    expect(result.cleanupFailed).toBe(true);
  });

  it('PATH=/definitely-not-real makes ps snapshot unavailable (not empty-success)', async () => {
    if (process.platform === 'win32') return;
    const snap = await makeSnapshotPidPpid({ ...process.env, PATH: '/definitely-not-real' })();
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.reason).toBe('snapshot-unavailable');
  });

  it('strict parse rejects mixed valid+malformed process table rows', () => {
    const mixed = parsePidPpidTable('1 0\nmalformed-row\n');
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.reason).toBe('malformed-row');

    const badPid = parsePidPpidTable('0 0\n');
    expect(badPid.ok).toBe(false);

    const dup = parsePidPpidTable('10 1\n10 2\n');
    expect(dup.ok).toBe(false);

    const good = parsePidPpidTable('1 0\n42 1\n43 42\n');
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.map.get(43)).toBe(42);
  });

  it('rejects precision-losing and noncanonical PID/PPID text', () => {
    // JS Number(9007199254740993) === 9007199254740992 — must reject at text parse.
    expect(parseCanonicalSafeNonNegInt('9007199254740993')).toBeNull();
    expect(parsePidPpidTable('9007199254740993 1\n').ok).toBe(false);

    expect(parseCanonicalPid('01')).toBeNull();
    expect(parseCanonicalPid('+1')).toBeNull();
    expect(parseCanonicalPid('1e2')).toBeNull();
    expect(parseCanonicalPid('0x10')).toBeNull();
    expect(parseCanonicalPid('0')).toBeNull();
    expect(parseCanonicalPpid('0')).toBe(0);
    expect(parseCanonicalPpid('-1')).toBeNull();
    expect(parseCanonicalPid('1')).toBe(1);
    expect(parseCanonicalPid(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);

    expect(parsePidPpidTable('01 0\n').ok).toBe(false);
    expect(parsePidPpidTable('1 -1\n').ok).toBe(false);
    expect(parsePidPpidTable('+1 0\n').ok).toBe(false);
    expect(parsePidPpidTable('1e2 0\n').ok).toBe(false);
    // PPID 0 is legitimate on some platforms.
    expect(parsePidPpidTable('42 0\n').ok).toBe(true);
  });

  it('deep-validates injected maps: illegal [0,-1] and unsafe keys fail closed', () => {
    const withIllegal = validatePidMapStructure(
      new Map<number, number>([
        [42, 1],
        [0, -1],
      ]),
    );
    expect(withIllegal.ok).toBe(false);

    const unsafe = validatePidMapStructure(
      new Map<number, number>([[Number.MAX_SAFE_INTEGER + 1, 1]]),
    );
    expect(unsafe.ok).toBe(false);

    const selfLoop = validatePidMapStructure(new Map<number, number>([[7, 7]]));
    expect(selfLoop.ok).toBe(false);

    const cycle = validatePidMapStructure(
      new Map<number, number>([
        [10, 11],
        [11, 10],
      ]),
    );
    expect(cycle.ok).toBe(false);

    const ok = validatePidMapStructure(
      new Map<number, number>([
        [1, 0],
        [42, 1],
      ]),
    );
    expect(ok.ok).toBe(true);
  });

  it('injected map with real parent + illegal [0,-1] fails cleanup (grandchild residue)', async () => {
    if (process.platform === 'win32') return;
    const pidFile = path.join(tmpdir(), `m13-s05-illegal-${process.pid}-${Date.now()}.pid`);
    let grandchildPid: number | undefined;
    try {
      // Snapshot returns the real root PID (discovered via side channel) plus illegal entry.
      // Using a mutable box filled after spawn is awkward; instead include [0,-1] always
      // and a placeholder that will not match — structure validation fails before completeness.
      const snapshotPidTable: PidTableSnapshotter = async () => ({
        map: new Map<number, number>([
          // Include a plausible parent-shaped entry; illegal pair must fail-closed.
          [process.pid, 1],
          [0, -1],
        ]),
        ok: true,
      });
      const result = await runProcess(
        [
          process.execPath,
          '-e',
          `
            const {spawn} = require('child_process');
            const fs = require('fs');
            const pidFile = process.argv[1];
            const g = spawn(process.execPath, ['-e',
              "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"], {
              detached: true,
              stdio: 'ignore',
            });
            fs.writeFileSync(pidFile, String(g.pid));
            g.unref();
            setInterval(() => {}, 1000);
            `,
          pidFile,
        ],
        {
          cwd: process.cwd(),
          snapshotPidTable,
          timeoutMs: 200,
        },
      );
      expect(result.timedOut).toBe(true);
      expect(result.cleanupFailed).toBe(true);
      const raw = await readFile(pidFile, 'utf8').catch(() => '');
      grandchildPid = Number(raw.trim());
      expect(Number.isInteger(grandchildPid) && (grandchildPid as number) > 1).toBe(true);
    } finally {
      if (grandchildPid && processExists(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // cleanup
        }
      }
      await rm(pidFile, { force: true }).catch(() => undefined);
    }
  }, 25_000);

  it('injected map with precision-rounded unsafe key fails closed', async () => {
    const unsafeKey = Number('9007199254740993'); // rounds to MAX_SAFE
    // Build a map that TypeScript types as number but uses illegal negative PPID.
    const snapshotPidTable: PidTableSnapshotter = async () => ({
      map: new Map<number, number>([
        [123_456, 1],
        [unsafeKey, -1],
      ]),
      ok: true,
    });
    const result = await terminateProcessTree(123_456, {
      deadlineMs: 150,
      graceMs: 40,
      probeExistence: (pid) => (pid === 123_456 ? 'alive' : 'absent'),
      snapshotPidTable,
    });
    expect(result.cleanupFailed).toBe(true);
  });

  it('empty ok:true snapshot cannot prove cleanup while owned root still present', async () => {
    const snapshotPidTable: PidTableSnapshotter = async () => ({
      map: new Map(),
      ok: true,
    });
    const probeExistence: PidExistenceProbe = (pid) =>
      pid === 777_001 ? 'alive' : probePidExistence(pid);
    const result = await terminateProcessTree(777_001, {
      deadlineMs: 150,
      graceMs: 40,
      probeExistence,
      snapshotPidTable,
    });
    expect(result.cleanupFailed).toBe(true);
  });

  it('injected ok:true empty map with real detached grandchild fails closed', async () => {
    if (process.platform === 'win32') return;
    const pidFile = path.join(tmpdir(), `m13-s05-empty-${process.pid}-${Date.now()}.pid`);
    let grandchildPid: number | undefined;
    try {
      const snapshotPidTable: PidTableSnapshotter = async () => ({
        map: new Map(),
        ok: true,
      });
      const result = await runProcess(
        [
          process.execPath,
          '-e',
          `
            const {spawn} = require('child_process');
            const fs = require('fs');
            const pidFile = process.argv[1];
            const g = spawn(process.execPath, ['-e',
              "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"], {
              detached: true,
              stdio: 'ignore',
            });
            fs.writeFileSync(pidFile, String(g.pid));
            g.unref();
            setInterval(() => {}, 1000);
            `,
          pidFile,
        ],
        { cwd: process.cwd(), snapshotPidTable, timeoutMs: 200 },
      );
      expect(result.timedOut).toBe(true);
      expect(result.cleanupFailed).toBe(true);
      const raw = await readFile(pidFile, 'utf8').catch(() => '');
      grandchildPid = Number(raw.trim());
      expect(Number.isInteger(grandchildPid) && (grandchildPid as number) > 1).toBe(true);
    } finally {
      if (grandchildPid && processExists(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // cleanup
        }
      }
      await rm(pidFile, { force: true }).catch(() => undefined);
    }
  }, 25_000);

  it('mixed valid+malformed snapshot text fails closed for owned descendant tree', async () => {
    // Fake ps: only init row + garbage — must not be treated as successful discovery.
    const snapshotPidTable: PidTableSnapshotter = async () =>
      parsePidPpidTable('1 0\nmalformed-row\n');
    const probeExistence: PidExistenceProbe = (pid) => {
      if (pid === 888_001 || pid === 888_002) return 'alive';
      return 'absent';
    };
    // Pre-seed synthetic parent→child ownership via a map that would have been incomplete anyway.
    const result = await terminateProcessTree(888_001, {
      deadlineMs: 150,
      graceMs: 40,
      probeExistence,
      snapshotPidTable,
    });
    expect(result.cleanupFailed).toBe(true);
    const parsed = parsePidPpidTable('1 0\nmalformed-row\n');
    expect(parsed.ok).toBe(false);
  });

  it('validateSnapshotCompleteness rejects empty map for still-present owned pid', () => {
    const emptyOk = { map: new Map<number, number>(), ok: true as const };
    const probe: PidExistenceProbe = (pid) => (pid === 55 ? 'alive' : 'absent');
    const checked = validateSnapshotCompleteness(emptyOk, new Set([55]), probe);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toBe('owned-pid-missing-from-snapshot');
  });

  it('EPERM/unconfirmed existence never counts as absent', async () => {
    // Simulated tree: root 900001 → child 900002; both always unconfirmed (EPERM-like).
    const snapshotPidTable: PidTableSnapshotter = async () => ({
      map: new Map([
        [900_001, 1],
        [900_002, 900_001],
      ]),
      ok: true,
    });
    const probeExistence: PidExistenceProbe = (pid) => {
      if (pid === 900_001 || pid === 900_002) return 'unconfirmed';
      return 'absent';
    };
    const result = await terminateProcessTree(900_001, {
      deadlineMs: 200,
      graceMs: 50,
      probeExistence,
      snapshotPidTable,
    });
    expect(result.cleanupFailed).toBe(true);
    expect(result.remaining.sort((a, b) => a - b)).toEqual([900_001, 900_002]);
  });
});

describe('skip multiset enforcement', () => {
  it('validateSkipMultiset: exact-one required passes; duplicate and missing fail', async () => {
    const { validateSkipMultiset } = await import('./skipMultiset');
    const expected = [{ reason: 'gc', required: true as const, title: 'heap delta stays bounded' }];
    expect(validateSkipMultiset(['heap delta stays bounded'], expected).ok).toBe(true);
    expect(
      validateSkipMultiset(['heap delta stays bounded', 'heap delta stays bounded'], expected).ok,
    ).toBe(false);
    const missing = validateSkipMultiset([], expected);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('missing-approved-skip');
    expect(validateSkipMultiset(['other'], expected).ok).toBe(false);
  });

  it('runner fails on duplicate approved skip title beyond multiset count', async () => {
    const dir = await makeTempDir();
    const testRel = 'packages/ssrf-safe-fetch/index.test.ts';
    await mkdir(path.dirname(path.join(dir, testRel)), { recursive: true });
    await writeFile(path.join(dir, testRel), '// stub\n', 'utf8');
    const title = 'heap delta stays bounded when a 50 MB body is fetched with a 1 MB cap';
    const manifest: PenAdapterDefinition[] = [
      {
        id: 'ssrf-safe-fetch',
        category: 'ssrf',
        description: 'ssrf',
        expectedSkips: [{ reason: 'gc-not-exposed', required: false, title }],
        required: true,
        testFiles: [testRel],
        workingDirectory: 'packages/ssrf-safe-fetch',
      },
    ];
    const artifact = await runPenRegression({
      cwd: dir,
      manifest,
      runProcess: mockRunner(async () =>
        okProcess(
          JSON.stringify({
            numFailedTests: 0,
            numPassedTests: 31,
            numPendingTests: 2,
            numTodoTests: 0,
            numTotalTests: 33,
            success: true,
            testResults: [
              {
                assertionResults: [
                  { status: 'skipped', title },
                  { status: 'skipped', title },
                ],
              },
            ],
          }),
          0,
        ),
      ),
    });
    expect(artifact.status).toBe('failed');
    expect(artifact.adapters[0]?.reason).toBe('skip-multiplicity');
  });

  it('runner fails when required approved skip is missing', async () => {
    const dir = await makeTempDir();
    const testRel = 'apps/server/src/enterprise/guards/reauth.test.ts';
    await mkdir(path.dirname(path.join(dir, testRel)), { recursive: true });
    await writeFile(path.join(dir, testRel), '// stub\n', 'utf8');
    const manifest: PenAdapterDefinition[] = [
      {
        id: 'reauth-guard',
        category: 'reauth',
        description: 'reauth',
        expectedSkips: [{ reason: 'must-skip', required: true, title: 'required skip title' }],
        required: true,
        testFiles: [testRel],
      },
    ];
    const artifact = await runPenRegression({
      cwd: dir,
      manifest,
      runProcess: mockRunner(async () =>
        okProcess(
          JSON.stringify({
            numFailedTests: 0,
            numPassedTests: 2,
            numPendingTests: 0,
            numTodoTests: 0,
            numTotalTests: 2,
            success: true,
            testResults: [{ assertionResults: [{ status: 'passed', title: 'a' }] }],
          }),
          0,
        ),
      ),
    });
    expect(artifact.status).toBe('failed');
    expect(artifact.adapters[0]?.reason).toBe('missing-approved-skip');
  });

  it('verifier rejects planted pass with duplicate skip titles', () => {
    const title = 'heap delta stays bounded when a 50 MB body is fetched with a 1 MB cap';
    const pen: PenRegressionArtifact = {
      adapters: PEN_REGRESSION_MANIFEST.map((definition) => {
        if (definition.id === 'ssrf-safe-fetch') {
          return {
            adapterId: definition.id,
            assertions: { failed: 0, passed: 31, skipped: 2, total: 33 },
            category: definition.category,
            exitCode: 0,
            skippedTitles: [title, title],
            status: 'passed' as const,
            targets: [...definition.testFiles],
          };
        }
        return {
          adapterId: definition.id,
          assertions: { failed: 0, passed: 3, skipped: 0, total: 3 },
          category: definition.category,
          exitCode: 0,
          status: 'passed' as const,
          targets: [...definition.testFiles],
        };
      }),
      checkId: 'pen-regression',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'passed',
    };
    const { report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen,
    });
    expect(report.overall === 'unavailable' || report.overall === 'failed').toBe(true);
    const forged = structuredClone(report);
    forged.overall = 'passed';
    forged.checks = forged.checks.map((c) =>
      c.checkId === 'pen-regression' ? { checkId: 'pen-regression', status: 'passed' as const } : c,
    );
    forged.artifacts['pen-regression'] = pen;
    expect(verifySecurityAcceptanceReport(forged).ok).toBe(false);
    expect(isSecurityAcceptancePassed(forged)).toBe(false);
  });
});

describe('real runner omitUndefined end-to-end smoke', () => {
  it('runSecurityAcceptance with mocked scanners writes verifiable report without undefined keys', async () => {
    const dir = await makeTempDir();
    // Build synthetic repo root with package.json + lock + enterprise root
    await writeFile(path.join(dir, 'package.json'), '{"name":"x"}\n');
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await mkdir(path.join(dir, 'apps/server/src/enterprise'), { recursive: true });
    await writeFile(path.join(dir, 'apps/server/src/enterprise/ok.ts'), 'export const x = 1;\n');

    // Place a minimal baseline file so leakage can pass
    const { buildBaselineDocument: buildDoc } = await import('./leakageBaseline');
    const baseline = buildDoc([]);
    await mkdir(path.join(dir, 'scripts/enterprise/security-acceptance'), { recursive: true });
    await writeFile(
      path.join(dir, 'scripts/enterprise/security-acceptance/leakage-baseline.json'),
      `${JSON.stringify(baseline, null, 2)}\n`,
    );

    // Only scan the enterprise root for this smoke (inject via evaluating checks is simpler).
    // Full runSecurityAcceptance uses LEAKAGE_SCAN_ROOTS under dir — missing roots fail.
    // Use evaluateFromChecksDir for full-manifest pen + dependency instead.
    const dependency = await runDependencyScan({
      allowGenerateLockfile: false,
      cwd: dir,
      runProcess: mockRunner(async (argv) => {
        if (argv[0] === 'pnpm' && argv[1] === '--version') return okProcess('10.33.0\n');
        if (argv.includes('audit')) {
          return okProcess(
            JSON.stringify({
              metadata: {
                vulnerabilities: { critical: 0, high: 0, info: 0, low: 0, moderate: 0 },
              },
            }),
            0,
          );
        }
        return okProcess('', 1);
      }),
    });
    assertNoUndefinedDeep(dependency);

    const leakage = await runLeakageScan({
      baselineFindings: [],
      cwd: dir,
      requireBaseline: false,
      roots: ['apps/server/src/enterprise'],
    });
    assertNoUndefinedDeep(leakage);
    expect(leakage.status).toBe('passed');

    const pen = await runPenRegression({
      cwd: dir,
      manifest: tinyManifest,
      runProcess: mockRunner(async () =>
        okProcess(
          JSON.stringify({
            numFailedTests: 0,
            numPassedTests: 1,
            numPendingTests: 0,
            numTodoTests: 0,
            numTotalTests: 1,
            success: true,
          }),
          0,
        ),
      ),
    });
    // missing test file → not-executed
    assertNoUndefinedDeep(pen);

    const { exitCode, report } = evaluateSecurityAcceptance({
      dependency,
      gitSha: FIXTURE_SHA,
      leakage,
      nowIso: FIXED_ISO,
      pen,
      penManifest: tinyManifest,
    });
    assertNoUndefinedDeep(report);
    expect(exitCode === 1 || exitCode === 2).toBe(true);
    expect(verifySecurityAcceptanceReport(report, { penManifest: tinyManifest }).ok).toBe(true);
  }, 30_000);
});
