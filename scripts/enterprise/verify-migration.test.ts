// @vitest-environment node
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { MigrationCompatReportCore } from './verify-migration/index';
import {
  assertSyntheticFixtureIsSecretFree,
  assessExternalDumpContent,
  BASELINE_COMMIT,
  BASELINE_MIGRATION_COUNT,
  BASELINE_VERSION,
  buildSyntheticFixtureStatements,
  createMigrationCompatReport,
  deriveOverallResult,
  hashDumpContent,
  isOwnedResourceToken,
  isPassingSyntheticReport,
  isSecretFreeFixtureText,
  loadExternalDump,
  migrationCompatReportSchema,
  scanDumpPrivacy,
  scanForForbiddenReportContent,
  shortSha,
  toExternalDumpReportFields,
  toReportCommitShort,
  verifyBaseline,
  verifyExpandOnlyPostBaselineSql,
  verifyJournalSnapshotAlignment,
} from './verify-migration/index';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const baseReportInput = (): MigrationCompatReportCore => ({
  baseline: {
    commitShort: shortSha(BASELINE_COMMIT),
    lastTag: '0116_add_task_connector_message_and_verify_updates',
    match: 'passed',
    migrationCount: BASELINE_MIGRATION_COUNT,
    version: BASELINE_VERSION,
  },
  checks: [
    {
      category: 'baseline',
      durationMs: 1,
      result: 'passed',
    },
    {
      category: 'external-dump',
      durationMs: 1,
      result: 'unverified',
    },
    {
      category: 'cleanup',
      durationMs: 1,
      result: 'passed',
    },
  ],
  cleanupResult: 'passed',
  elapsed: { milliseconds: 10 },
  externalDump: { privacy: 'not-applicable', status: 'absent' },
  fixture: {
    rowCounts: { users: 1 },
    source: 'synthetic',
    status: 'loaded',
  },
  head: {
    commitShort: '8b0a0d8',
    postBaselineMigrationCount: 19,
    totalMigrationCount: 136,
  },
  lane: 'enterprise-migration-compat',
  ownedResource: { kind: 'none' },
  overall: 'unverified',
  rerun: { mode: 'idempotent', result: 'passed' },
  schemaVersion: 1,
  syntheticResult: 'passed',
});

describe('migration compat baseline (2.2.10 / 0000-0116)', () => {
  it('confirms fixed baseline commit is release 2.2.10 and migrations 0000-0116 match', () => {
    const result = verifyBaseline(repoRoot);
    expect(result.baselineCommit).toBe(BASELINE_COMMIT);
    expect(result.baselineVersion).toBe('2.2.10');
    expect(result.migrationCount).toBe(117);
    expect(result.match).toBe('passed');
    expect(result.reasons).toEqual([]);
    expect(result.fileMatchCount).toBeGreaterThan(100);
  }, 60_000);

  it('keeps journal entries contiguous with matching snapshots', () => {
    const result = verifyJournalSnapshotAlignment(repoRoot);
    expect(result.match).toBe(true);
    expect(result.totalEntries).toBeGreaterThanOrEqual(117);
  });

  it('treats post-baseline SQL as expand-only for protected core tables', () => {
    const result = verifyExpandOnlyPostBaselineSql(repoRoot);
    expect(result.match).toBe(true);
    expect(result.scannedMigrations).toBeGreaterThan(0);
  });
});

describe('migration compat report contract', () => {
  it('accepts a minimal secret-free report and rejects forbidden fields', () => {
    const report = createMigrationCompatReport(baseReportInput());
    expect(migrationCompatReportSchema.safeParse(report).success).toBe(true);
    expect(isPassingSyntheticReport(report)).toBe(true);
    expect(report.redactionScan).toEqual({ result: 'passed', violations: 0 });

    const leakScan = scanForForbiddenReportContent({
      connectionString: 'postgres://x',
      password: 'nope',
      sql: 'SELECT 1',
    });
    expect(leakScan.result).toBe('failed');
    expect(leakScan.violations).toBeGreaterThan(0);

    expect(() =>
      createMigrationCompatReport({
        ...baseReportInput(),
        connectionString: 'postgres://user:pass@localhost/db',
      } as never),
    ).toThrow(/redaction/i);
  });

  it('derives overall=unverified when production dump is absent (never pass)', () => {
    expect(
      deriveOverallResult({
        cleanupResult: 'passed',
        externalDumpStatus: 'absent',
        syntheticResult: 'passed',
      }),
    ).toBe('unverified');
    expect(
      deriveOverallResult({
        cleanupResult: 'passed',
        externalDumpStatus: 'privacy-verified',
        syntheticResult: 'passed',
      }),
    ).toBe('passed');
    expect(
      deriveOverallResult({
        cleanupResult: 'failed',
        externalDumpStatus: 'privacy-verified',
        syntheticResult: 'passed',
      }),
    ).toBe('failed');
  });

  it('exposes only short SHAs in report helpers', () => {
    expect(toReportCommitShort(BASELINE_COMMIT)).toBe('4bab163');
    expect(shortSha(BASELINE_COMMIT)).toHaveLength(7);
  });
});

describe('external dump privacy contract', () => {
  it('records only hash metadata and never requires a path in the report slice', async () => {
    const clean = "-- sanitized fixture dump\nINSERT INTO users (id) VALUES ('u1');\n";
    const assessment = assessExternalDumpContent(clean);
    expect(assessment.status).toBe('privacy-verified');
    expect(assessment.contentSha256).toBe(hashDumpContent(clean).sha256);
    expect(toExternalDumpReportFields(assessment)).toEqual({
      byteLength: assessment.byteLength,
      contentSha256: assessment.contentSha256,
      privacy: 'passed',
      status: 'privacy-verified',
    });
    expect(JSON.stringify(toExternalDumpReportFields(assessment))).not.toMatch(
      /path|postgres:\/\/|password|localhost/i,
    );

    const absent = await loadExternalDump(undefined);
    expect(absent).toEqual({ status: 'absent' });
    expect(toExternalDumpReportFields(absent).status).toBe('absent');
  });

  it('rejects dumps containing private keys or connection strings', () => {
    expect(scanDumpPrivacy('-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----')).toBe(
      'failed',
    );
    expect(scanDumpPrivacy('postgres://user:secret@db.internal:5432/app')).toBe('failed');
    expect(assessExternalDumpContent('password=supersecret').status).toBe('privacy-rejected');
  });
});

describe('synthetic fixture', () => {
  it('is secret-free and covers core tables', () => {
    expect(() => assertSyntheticFixtureIsSecretFree()).not.toThrow();
    const sql = buildSyntheticFixtureStatements().join('\n');
    expect(isSecretFreeFixtureText(sql)).toBe(true);
    expect(sql).toContain('usr_m15q03_fixture_01');
    expect(sql).not.toMatch(/postgres:\/\//i);
    expect(sql).not.toMatch(/BEGIN PRIVATE KEY/);
  });
});

describe('owned resource token shape', () => {
  it('accepts only m15q03 opaque tokens', () => {
    expect(isOwnedResourceToken(`m15q03_${'a'.repeat(16)}`)).toBe(true);
    expect(isOwnedResourceToken('aihub-dev')).toBe(false);
    expect(isOwnedResourceToken('phase0')).toBe(false);
    expect(isOwnedResourceToken('postgres://localhost/db')).toBe(false);
  });
});

describe('report serialization privacy', () => {
  it('serialized reports never include raw error text, SQL, or connection strings', () => {
    const report = createMigrationCompatReport(baseReportInput());
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(serialized).not.toMatch(/connectionString/i);
    expect(serialized).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(serialized).not.toMatch(/SELECT |INSERT |ALTER /i);
    // short sha only
    expect(serialized).toContain(shortSha(BASELINE_COMMIT));
    expect(serialized).not.toContain(BASELINE_COMMIT);
  });
});

describe('hash stability', () => {
  it('hashes dump content deterministically', () => {
    const body = 'hello-fixture';
    expect(hashDumpContent(body).sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });
});
