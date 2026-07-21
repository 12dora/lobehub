// @vitest-environment node
/**
 * Falsifying tests for M13 PR-S05 security acceptance harness.
 * Covers: scanner unavailable, high advisory, malformed output, secret match,
 * missing test target, failed adapter, report tamper/schema mismatch, allowlist boundaries.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { isLeakageAllowlisted } from './leakageAllowlist';
import { runLeakageScan } from './leakageScan';
import type { PenAdapterDefinition } from './penManifest';
import { runPenRegression } from './penRegression';
import { scanForForbiddenReportContent } from './privacy';
import type { ProcessResult, ProcessRunner } from './process';
import { extractFirstJsonObject } from './process';
import {
  type DependencyScanArtifact,
  isSecurityAcceptancePassed,
  type LeakageScanArtifact,
  type PenRegressionArtifact,
  securityAcceptanceReportSchema,
} from './schemas';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'm13-s05-'));
  tempDirs.push(dir);
  return dir;
};

const FIXTURE_SHA = 'a'.repeat(40);
const FIXED_ISO = '2026-07-21T00:00:00.000Z';

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
  failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
  policyHits: 0,
  schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
  severityCounts: { critical: 0, high: 0, info: 0, low: 0, moderate: 0 },
  status: 'passed',
  target: {
    kind: 'pnpm-lock',
    lockfileSha256: 'b'.repeat(64),
    packageJsonSha256: 'c'.repeat(64),
    path: 'pnpm-lock.yaml',
  },
  tool: { id: 'pnpm-audit', version: '10.33.0' },
  ...overrides,
});

const baseLeakage = (overrides: Partial<LeakageScanArtifact> = {}): LeakageScanArtifact => ({
  allowlistedMatches: 0,
  checkId: 'leakage-scan',
  findings: [],
  filesScanned: 12,
  schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
  status: 'passed',
  violationCount: 0,
  ...overrides,
});

const basePen = (overrides: Partial<PenRegressionArtifact> = {}): PenRegressionArtifact => ({
  adapters: [
    {
      adapterId: 'ssrf-outbound',
      assertions: { failed: 0, passed: 3, skipped: 0, total: 3 },
      category: 'ssrf',
      exitCode: 0,
      status: 'passed',
      targets: ['apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.test.ts'],
    },
  ],
  checkId: 'pen-regression',
  schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
  status: 'passed',
  ...overrides,
});

describe('parsePnpmAuditJson', () => {
  it('counts high/critical policy hits', () => {
    const result = parsePnpmAuditJson({
      metadata: {
        vulnerabilities: { critical: 1, high: 2, info: 0, low: 3, moderate: 4 },
      },
    });
    expect(result.policyHits).toBe(3);
    expect(result.severityCounts.critical).toBe(1);
  });

  it('rejects malformed output', () => {
    expect(() => parsePnpmAuditJson({})).toThrow(/malformed/i);
    expect(() => parsePnpmAuditJson({ error: { code: 'ERR' } })).toThrow(/audit-tool-error/);
  });
});

describe('dependency scan fail-closed', () => {
  it('marks scanner unavailable when pnpm version cannot be resolved', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'package.json'), '{"name":"x"}\n', 'utf8');
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');

    const artifact = await runDependencyScan({
      allowGenerateLockfile: false,
      cwd: dir,
      runProcess: mockRunner(async (argv) => {
        if (argv[0] === 'pnpm' && argv[1] === '--version') {
          return okProcess('', 1);
        }
        return okProcess('{}', 1);
      }),
    });

    expect(artifact.status).toBe('unavailable');
    expect(artifact.reason).toBe('scanner-unavailable');
  });

  it('fails on high/critical advisories from real parser path', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'package.json'), '{"name":"x"}\n', 'utf8');
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');

    const auditPayload = {
      metadata: {
        vulnerabilities: { critical: 1, high: 1, info: 0, low: 0, moderate: 0 },
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
    expect(artifact.policyHits).toBe(2);
    expect(artifact.reason).toBe('policy-severity-hits');
  });

  it('treats malformed audit JSON as unavailable (never pass)', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'package.json'), '{"name":"x"}\n', 'utf8');
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');

    const artifact = await runDependencyScan({
      allowGenerateLockfile: false,
      cwd: dir,
      runProcess: mockRunner(async (argv) => {
        if (argv[0] === 'pnpm' && argv[1] === '--version') return okProcess('10.33.0\n');
        if (argv.includes('audit')) return okProcess('not-json-at-all', 0);
        return okProcess('', 1);
      }),
    });

    expect(artifact.status).toBe('unavailable');
    expect(artifact.reason).toBe('malformed-audit-output');
  });

  it('treats missing lockfile without generation as unavailable', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'package.json'), '{"name":"x"}\n', 'utf8');

    const artifact = await runDependencyScan({
      allowGenerateLockfile: false,
      cwd: dir,
      runProcess: mockRunner(async (argv) => {
        if (argv[0] === 'pnpm' && argv[1] === '--version') return okProcess('10.33.0\n');
        return okProcess('', 1);
      }),
    });

    expect(artifact.status).toBe('unavailable');
    expect(artifact.reason).toBe('lockfile-missing');
  });
});

describe('leakage scan', () => {
  it('fails when non-allowlisted secret material is present', async () => {
    const dir = await makeTempDir();
    const root = path.join(dir, 'apps/server/src/enterprise');
    await mkdir(root, { recursive: true });
    // Bare assignment form (detector requires explicit credential scalars).
    await writeFile(path.join(root, 'leaky.ts'), 'password=MustFailLeakageScanValue99\n', 'utf8');

    const artifact = await runLeakageScan({
      cwd: dir,
      roots: ['apps/server/src/enterprise'],
    });

    expect(artifact.status).toBe('failed');
    expect(artifact.violationCount).toBeGreaterThan(0);
    expect(artifact.findings[0]?.path).toBe('apps/server/src/enterprise/leaky.ts');
    // Must not embed secret text in findings
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain('MustFailLeakageScanValue99');
    expect(artifact.findings[0]?.lineDigest).toMatch(/^[a-f\d]{64}$/u);
  });

  it('allowlists reviewed fixtures without failing', async () => {
    const dir = await makeTempDir();
    const fixtureRel =
      'scripts/enterprise/security-acceptance/fixtures/synthetic-secret.fixture.txt';
    const fixtureAbs = path.join(dir, fixtureRel);
    await mkdir(path.dirname(fixtureAbs), { recursive: true });
    await writeFile(fixtureAbs, 'password=SyntheticFixtureHunter2Value99\n', 'utf8');

    expect(isLeakageAllowlisted(fixtureRel)).toBe(true);

    const artifact = await runLeakageScan({
      cwd: dir,
      roots: ['scripts/enterprise'],
    });

    expect(artifact.status).toBe('passed');
    expect(artifact.violationCount).toBe(0);
    expect(artifact.allowlistedMatches).toBeGreaterThan(0);
  });

  it('does not allowlist arbitrary sibling paths', async () => {
    const dir = await makeTempDir();
    const root = path.join(dir, 'scripts/enterprise/security-acceptance/fixtures');
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'rogue-not-allowlisted.txt'),
      'password=RogueNotAllowlistedValue99\n',
      'utf8',
    );

    const artifact = await runLeakageScan({
      cwd: dir,
      roots: ['scripts/enterprise'],
    });

    expect(artifact.status).toBe('failed');
    expect(artifact.findings.some((f) => f.path.includes('rogue-not-allowlisted'))).toBe(true);
  });
});

describe('pen regression orchestration', () => {
  it('fails closed when a required test target is missing (rate-limit S06 path)', async () => {
    const dir = await makeTempDir();
    const manifest: PenAdapterDefinition[] = [
      {
        id: 'admin-rate-limit',
        category: 'admin-rate-limit',
        description: 'reserved',
        required: true,
        testFiles: ['apps/server/src/enterprise/security/rateLimit/adminMutationRateLimit.test.ts'],
      },
    ];

    const artifact = await runPenRegression({
      cwd: dir,
      manifest,
      runProcess: mockRunner(async () => okProcess('{}', 0)),
    });

    expect(artifact.status).toBe('failed');
    expect(artifact.reason).toBe('missing-required-adapter');
    expect(artifact.adapters[0]?.status).toBe('not-executed');
    expect(artifact.adapters[0]?.reason).toBe('missing-test-target');
  });

  it('records failed adapter exit without renaming as external pen test', async () => {
    const dir = await makeTempDir();
    const testRel = 'apps/server/src/enterprise/guards/reauth.test.ts';
    await mkdir(path.dirname(path.join(dir, testRel)), { recursive: true });
    await writeFile(path.join(dir, testRel), '// stub\n', 'utf8');

    const manifest: PenAdapterDefinition[] = [
      {
        id: 'reauth-guard',
        category: 'reauth',
        description: 'reauth',
        required: true,
        testFiles: [testRel],
      },
    ];

    const vitestJson = JSON.stringify({
      numFailedTests: 2,
      numPassedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTests: 3,
      success: false,
    });

    const artifact = await runPenRegression({
      cwd: dir,
      manifest,
      runProcess: mockRunner(async () => okProcess(vitestJson, 1)),
    });

    expect(artifact.status).toBe('failed');
    expect(artifact.adapters[0]?.status).toBe('failed');
    expect(artifact.adapters[0]?.assertions?.failed).toBe(2);
    expect(JSON.stringify(artifact)).not.toMatch(/external.?pen/i);
  });

  it('does not pass on zero exit without parseable assertions', async () => {
    const dir = await makeTempDir();
    const testRel = 'apps/server/src/enterprise/guards/reauth.test.ts';
    await mkdir(path.dirname(path.join(dir, testRel)), { recursive: true });
    await writeFile(path.join(dir, testRel), '// stub\n', 'utf8');

    const artifact = await runPenRegression({
      cwd: dir,
      manifest: [
        {
          id: 'reauth-guard',
          category: 'reauth',
          description: 'reauth',
          required: true,
          testFiles: [testRel],
        },
      ],
      runProcess: mockRunner(async () => okProcess('no json here', 0)),
    });

    expect(artifact.adapters[0]?.status).toBe('failed');
    expect(artifact.adapters[0]?.reason).toBe('missing-assertions');
  });
});

describe('report evaluate / integrity', () => {
  it('happy path: all checks passed yields overall passed and integrity digest', () => {
    const { exitCode, report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: basePen(),
    });

    expect(exitCode).toBe(0);
    expect(report.overall).toBe('passed');
    expect(report.evidenceClass).toBe(EVIDENCE_CLASS);
    expect(report.externalPenetrationTest.status).toBe(EXTERNAL_PEN_TEST_STATUS);
    expect(isSecurityAcceptancePassed(report)).toBe(true);
    expect(securityAcceptanceReportSchema.safeParse(report).success).toBe(true);

    const core = {
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
  });

  it('never emits overall=passed when dependency is unavailable', () => {
    const { exitCode, report } = evaluateSecurityAcceptance({
      dependency: baseDependency({ reason: 'scanner-unavailable', status: 'unavailable' }),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: basePen(),
    });

    expect(report.overall).toBe('unavailable');
    expect(exitCode).toBe(2);
    expect(isSecurityAcceptancePassed(report)).toBe(false);
  });

  it('fails closed on secret match in leakage artifact', () => {
    const { exitCode, report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage({
        findings: [
          {
            category: 'credential-assignment',
            line: 3,
            lineDigest: 'd'.repeat(64),
            path: 'apps/server/src/enterprise/leaky.ts',
          },
        ],
        reason: 'secret-material-detected',
        status: 'failed',
        violationCount: 1,
      }),
      nowIso: FIXED_ISO,
      pen: basePen(),
    });

    expect(report.overall).toBe('failed');
    expect(exitCode).toBe(1);
  });

  it('detects report core tamper via verify', () => {
    const { report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: basePen(),
    });

    const tampered = {
      ...report,
      integrity: {
        ...report.integrity,
        reportCoreSha256: 'e'.repeat(64),
      },
    };

    const verified = verifySecurityAcceptanceReport(tampered);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('report-core-digest-mismatch');
  });

  it('rejects schema mismatch and planted overall pass', () => {
    const schemaMismatch = verifySecurityAcceptanceReport({ overall: 'passed' });
    expect(schemaMismatch.ok).toBe(false);

    const { report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: basePen(),
    });

    const planted = {
      ...report,
      checks: report.checks.map((check) =>
        check.checkId === 'dependency-scan' ? { ...check, status: 'failed' as const } : check,
      ),
      // keep overall=passed while a check failed — schema superRefine rejects
      overall: 'passed' as const,
    };

    expect(securityAcceptanceReportSchema.safeParse(planted).success).toBe(false);
    const verified = verifySecurityAcceptanceReport(planted);
    expect(verified.ok).toBe(false);
  });

  it('rejects self-asserted external penetration test completion', () => {
    const { report } = evaluateSecurityAcceptance({
      dependency: baseDependency(),
      gitSha: FIXTURE_SHA,
      leakage: baseLeakage(),
      nowIso: FIXED_ISO,
      pen: basePen(),
    });

    const forged = {
      ...report,
      externalPenetrationTest: {
        note: 'External human production penetration testing is residual and is not claimed by repository automation.',
        status: 'passed',
      },
    };

    expect(securityAcceptanceReportSchema.safeParse(forged).success).toBe(false);
  });

  it('report privacy scan rejects secret-shaped values', () => {
    const dirty = {
      password: 'hunter2',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    };
    expect(scanForForbiddenReportContent(dirty).result).toBe('failed');
  });
});

describe('extractFirstJsonObject', () => {
  it('parses JSON after pnpm warning noise', () => {
    const raw =
      'WARN something\n{"metadata":{"vulnerabilities":{"high":0,"critical":0,"low":0,"moderate":0,"info":0}}}\n';
    const parsed = extractFirstJsonObject(raw) as {
      metadata: { vulnerabilities: { high: number } };
    };
    expect(parsed.metadata.vulnerabilities.high).toBe(0);
  });
});

describe('real repo allowlist integrity', () => {
  it('allowlist paths used by fixtures exist in this repository', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const fixture = path.join(
      repoRoot,
      'scripts/enterprise/security-acceptance/fixtures/synthetic-secret.fixture.txt',
    );
    const text = await readFile(fixture, 'utf8');
    expect(text).toContain('synthetic');
    expect(
      isLeakageAllowlisted(
        'scripts/enterprise/security-acceptance/fixtures/synthetic-secret.fixture.txt',
      ),
    ).toBe(true);
  });
});
