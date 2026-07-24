// @vitest-environment node
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { MigrationCompatReportCore } from './verify-migration/index';
import {
  assertSyntheticFixtureIsSecretFree,
  assessExternalDumpContent,
  BASELINE_COMMIT,
  BASELINE_MIGRATION_COUNT,
  BASELINE_VERSION,
  buildFullFailedChecks,
  buildFullPassingChecks,
  buildSyntheticFixtureStatements,
  createMigrationCompatReport,
  deriveOverallResult,
  DUMP_SCAN_CHUNK_BYTES,
  DUMP_SCAN_OVERLAP_BYTES,
  gatePassed,
  hashDumpContent,
  isLegacyTagIdxJournalStyle,
  isOwnedResourceToken,
  isSecretFreeFixtureText,
  loadExternalDump,
  loadOfficialMigrations,
  migrationCompatReportSchema,
  REQUIRED_IDENTITY_SECRET_CONSTRAINTS,
  runMigrationCompatVerification,
  scanDumpPrivacy,
  scanDumpPrivacyBuffer,
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
  checks: buildFullPassingChecks(),
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
  ownedResource: { kind: 'container-database', resourceId: `m15q03_${'a'.repeat(16)}` },
  overall: 'unverified',
  rerun: { mode: 'idempotent', result: 'passed' },
  schemaVersion: 1,
  syntheticResult: 'passed',
});

const failedReportInput = (): MigrationCompatReportCore => ({
  baseline: {
    commitShort: shortSha(BASELINE_COMMIT),
    lastTag: '0116_add_task_connector_message_and_verify_updates',
    match: 'passed',
    migrationCount: BASELINE_MIGRATION_COUNT,
    version: BASELINE_VERSION,
  },
  checks: buildFullFailedChecks(),
  cleanupResult: 'passed',
  elapsed: { milliseconds: 10 },
  externalDump: { privacy: 'failed', status: 'privacy-rejected' },
  fixture: {
    rowCounts: {},
    source: 'synthetic',
    status: 'skipped',
  },
  head: {
    commitShort: '8b0a0d8',
    postBaselineMigrationCount: 19,
    totalMigrationCount: 136,
  },
  lane: 'enterprise-migration-compat',
  ownedResource: { kind: 'none' },
  overall: 'failed',
  rerun: { mode: 'idempotent', result: 'skipped' },
  schemaVersion: 1,
  syntheticResult: 'failed',
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

  it('rejects destructive expand-only contract changes (negative fixtures)', async () => {
    const { scanExpandOnlySql } = await import('./verify-migration/migrations');
    const cases: Array<{ sql: string; reasonPrefix: string }> = [
      { reasonPrefix: 'drop-column', sql: 'ALTER TABLE "users" DROP COLUMN "avatar";' },
      { reasonPrefix: 'drop-column', sql: 'ALTER TABLE users DROP COLUMN IF EXISTS email;' },
      {
        reasonPrefix: 'drop-constraint',
        sql: 'ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_fkey";',
      },
      { reasonPrefix: 'drop-table', sql: 'DROP TABLE IF EXISTS public.users;' },
      { reasonPrefix: 'drop-table', sql: 'DROP TABLE "agents";' },
      { reasonPrefix: 'rename', sql: 'ALTER TABLE topics RENAME TO topics_legacy;' },
      {
        reasonPrefix: 'rename',
        sql: 'ALTER TABLE "messages" RENAME COLUMN "content" TO "body";',
      },
      {
        reasonPrefix: 'narrowing-type',
        sql: 'ALTER TABLE user_settings ALTER COLUMN "key" TYPE varchar(8);',
      },
      {
        reasonPrefix: 'narrowing-nullability',
        sql: 'ALTER TABLE api_keys ALTER COLUMN "name" SET NOT NULL;',
      },
      {
        reasonPrefix: 'drop-column',
        sql: '/* comment */ ALTER TABLE public.files DROP COLUMN "size";',
      },
    ];
    for (const fixture of cases) {
      const result = scanExpandOnlySql(fixture.sql);
      expect(result.match, fixture.sql).toBe(false);
      expect(
        result.reasons.some((reason) => reason.startsWith(fixture.reasonPrefix)),
        `${fixture.sql} → ${result.reasons.join(',')}`,
      ).toBe(true);
    }
    // Expand-safe forms still pass.
    expect(scanExpandOnlySql('ALTER TABLE users ADD COLUMN avatar text;').match).toBe(true);
    expect(scanExpandOnlySql('CREATE INDEX ON users (email);').match).toBe(true);
    expect(scanExpandOnlySql('ALTER TABLE users ALTER COLUMN name DROP NOT NULL;').match).toBe(
      true,
    );
  });
});

describe('official drizzle migration semantics', () => {
  it('loads real SHA-256 hashes and journal.when folderMillis (not tag/idx)', () => {
    const official = loadOfficialMigrations(repoRoot);
    expect(official.length).toBeGreaterThanOrEqual(117);
    const first = official[0]!;
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.hash.startsWith('tag:')).toBe(false);
    expect(first.folderMillis).toBeGreaterThan(10_000);
    expect(isLegacyTagIdxJournalStyle(first.hash, first.folderMillis)).toBe(false);
    expect(isLegacyTagIdxJournalStyle(`tag:${first.tag}`, 0)).toBe(true);
    expect(isLegacyTagIdxJournalStyle('tag:0116_x', 116)).toBe(true);
    expect(first.hash).toHaveLength(64);
    expect(first.sql.length).toBeGreaterThan(0);
  });

  it('regression: legacy tag/idx journal style is rejected by official-rerun gate helper', () => {
    expect(isLegacyTagIdxJournalStyle('tag:0000_init', 0)).toBe(true);
    expect(
      isLegacyTagIdxJournalStyle(createHash('sha256').update('x').digest('hex'), 1_700_000_000_000),
    ).toBe(false);
  });
});

describe('migration compat report contract', () => {
  it('accepts a full secret-free report and rejects forbidden fields', () => {
    const report = createMigrationCompatReport(baseReportInput());
    expect(migrationCompatReportSchema.safeParse(report).success).toBe(true);
    expect(gatePassed(report)).toBe(true);
    expect(report.redactionScan).toEqual({ result: 'passed', violations: 0 });

    expect(() =>
      createMigrationCompatReport({
        ...baseReportInput(),
        connectionString: 'postgres://user:pass@localhost/db',
      } as never),
    ).toThrow(/redaction/i);
  });

  it('rejects overall=passed and incomplete synthetic success shapes', () => {
    expect(() =>
      createMigrationCompatReport({
        ...baseReportInput(),
        overall: 'passed',
      }),
    ).toThrow();

    expect(() =>
      createMigrationCompatReport({
        ...baseReportInput(),
        checks: buildFullPassingChecks().slice(0, 3),
      }),
    ).toThrow(/missing required check category|exactly the required/i);

    expect(() =>
      createMigrationCompatReport({
        ...baseReportInput(),
        checks: [
          ...buildFullPassingChecks(),
          { category: 'baseline', durationMs: 1, result: 'passed' },
        ],
      }),
    ).toThrow(/duplicate/i);

    expect(() =>
      createMigrationCompatReport({
        ...baseReportInput(),
        checks: buildFullPassingChecks({ revision: 'failed' }),
      }),
    ).toThrow(/required check must pass/i);

    expect(() =>
      createMigrationCompatReport({
        ...baseReportInput(),
        rerun: { mode: 'idempotent', result: 'skipped' },
      }),
    ).toThrow();

    expect(() =>
      createMigrationCompatReport({
        ...baseReportInput(),
        ownedResource: { kind: 'none' },
      }),
    ).toThrow();
  });

  it('requires complete 14-category shape for failed reports and overall=failed when synthetic fails', () => {
    const failed = createMigrationCompatReport(failedReportInput());
    expect(failed.syntheticResult).toBe('failed');
    expect(failed.overall).toBe('failed');
    expect(failed.checks).toHaveLength(14);
    expect(gatePassed(failed)).toBe(false);

    // Missing categories on failed path rejected.
    expect(() =>
      createMigrationCompatReport({
        ...failedReportInput(),
        checks: buildFullFailedChecks().slice(0, 1),
      }),
    ).toThrow(/missing required check category|exactly the required/i);

    // Duplicate categories on failed path rejected.
    expect(() =>
      createMigrationCompatReport({
        ...failedReportInput(),
        checks: [
          ...buildFullFailedChecks(),
          { category: 'cleanup', durationMs: 1, result: 'passed' },
        ],
      }),
    ).toThrow(/duplicate/i);

    // synthetic=failed + overall=unverified is contradictory.
    expect(() =>
      createMigrationCompatReport({
        ...failedReportInput(),
        overall: 'unverified',
      }),
    ).toThrow(/syntheticResult=failed requires overall=failed/i);

    // Cross-field cleanup mismatch on failed path.
    expect(() =>
      createMigrationCompatReport({
        ...failedReportInput(),
        cleanupResult: 'failed',
        checks: buildFullFailedChecks({ cleanup: 'passed' }),
      }),
    ).toThrow(/cleanupResult\/check mismatch/i);
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
    ).toBe('unverified');
    expect(
      deriveOverallResult({
        cleanupResult: 'failed',
        externalDumpStatus: 'privacy-verified',
        syntheticResult: 'passed',
      }),
    ).toBe('failed');
    expect(
      deriveOverallResult({
        cleanupResult: 'passed',
        externalDumpStatus: 'absent',
        syntheticResult: 'failed',
      }),
    ).toBe('failed');
  });

  it('exposes only short SHAs in report helpers', () => {
    expect(toReportCommitShort(BASELINE_COMMIT)).toBe('4bab163');
    expect(shortSha(BASELINE_COMMIT)).toHaveLength(7);
  });
});

describe('external dump privacy contract (full-file + boundaries)', () => {
  it('records only hash metadata and never requires a path in the report slice', async () => {
    const clean = "-- sanitized fixture dump\nINSERT INTO users (id) VALUES ('u1');\n";
    const assessment = await assessExternalDumpContent(clean);
    expect(assessment.status).toBe('privacy-verified');
    expect(assessment.contentSha256).toBe(hashDumpContent(clean).sha256);
    expect(toExternalDumpReportFields(assessment)).toEqual({
      byteLength: assessment.byteLength,
      contentSha256: assessment.contentSha256,
      privacy: 'passed',
      status: 'privacy-verified',
    });

    const absent = await loadExternalDump(undefined);
    expect(absent).toEqual({ status: 'absent' });
  });

  it('rejects dumps containing private keys or connection strings', async () => {
    expect(scanDumpPrivacy('-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----')).toBe(
      'failed',
    );
    expect(scanDumpPrivacy('postgres://user:secret@db.internal:5432/app')).toBe('failed');
    expect((await assessExternalDumpContent('password=supersecret')).status).toBe(
      'privacy-rejected',
    );
  });

  it('detects a secret at offset ~500000 in a ~2MB dump (not window sampling)', async () => {
    const secret = 'password=supersecret-midfile-token';
    const prefix = Buffer.alloc(500_000, 0x61);
    const suffix = Buffer.alloc(1_500_000, 0x62);
    const dump = Buffer.concat([prefix, Buffer.from(secret, 'utf8'), suffix]);
    expect(dump.byteLength).toBeGreaterThan(1_900_000);
    expect(scanDumpPrivacyBuffer(dump)).toBe('failed');
    expect((await assessExternalDumpContent(dump)).status).toBe('privacy-rejected');
  });

  it('detects a forbidden token that crosses a chunk boundary', async () => {
    const marker = 'password=boundary-cross-secret';
    const left = marker.slice(0, Math.floor(marker.length / 2));
    const right = marker.slice(Math.floor(marker.length / 2));
    const pad = DUMP_SCAN_CHUNK_BYTES - left.length;
    const dump = `${'x'.repeat(pad)}${left}${right}${'y'.repeat(1024)}`;
    expect(scanDumpPrivacyBuffer(Buffer.from(dump, 'utf8'))).toBe('failed');
    expect(DUMP_SCAN_OVERLAP_BYTES).toBeGreaterThanOrEqual(marker.length);
  });

  it('privacy reject never provisions owned DB (factory injection, in-memory dump)', async () => {
    const createOwned = vi.fn(async () => {
      throw new Error('owned factory must not be called on privacy reject');
    });

    const { report } = await runMigrationCompatVerification({
      createOwnedPostgres: createOwned,
      externalDump: { content: 'innocuous\npassword=leaked\n' },
      repoRoot,
    });

    expect(report.externalDump.status).toBe('privacy-rejected');
    expect(report.overall).toBe('failed');
    expect(report.syntheticResult).toBe('failed');
    expect(report.checks).toHaveLength(14);
    expect(report.ownedResource.kind).toBe('none');
    expect(createOwned).toHaveBeenCalledTimes(0);
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

describe('probe secret history + constraints (unit shape)', () => {
  it('seeds history row and lists production constraint names', async () => {
    const {
      buildPlatformProbeStatements,
      PROBE_SECRET_REF,
      PROBE_SECRET_FINGERPRINT,
      PROBE_SECRET_ENVELOPE_PLACEHOLDER,
      PLATFORM_PROBE_IDS,
    } = await import('./verify-migration/probes');
    const sql = buildPlatformProbeStatements().join('\n');
    expect(sql).toContain(PROBE_SECRET_REF);
    expect(sql).toContain(PROBE_SECRET_FINGERPRINT);
    expect(sql).toContain(PROBE_SECRET_ENVELOPE_PLACEHOLDER);
    expect(sql).toContain('platform_identity_provider_secrets');
    expect(sql).toContain(PLATFORM_PROBE_IDS.secretHistoryId);
    expect(sql).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(sql).not.toMatch(/postgres:\/\//i);
    expect(REQUIRED_IDENTITY_SECRET_CONSTRAINTS).toContain(
      'platform_identity_providers_secret_state_check',
    );
    expect(REQUIRED_IDENTITY_SECRET_CONSTRAINTS).toContain(
      'platform_identity_providers_secret_ref_check',
    );
    expect(REQUIRED_IDENTITY_SECRET_CONSTRAINTS).toContain(
      'platform_identity_provider_secrets_ref_check',
    );
    expect(REQUIRED_IDENTITY_SECRET_CONSTRAINTS).toContain(
      'platform_identity_provider_secrets_fingerprint_check',
    );
  });
});
