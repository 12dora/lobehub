// @vitest-environment node
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { BASELINE_COMMIT } from './constants';
import { scanForForbiddenReportContent } from './privacy';
import {
  assertBaselineNotCandidate,
  isCorruptedDump,
  rejectDestructiveCommand,
  rejectIdenticalSourceTarget,
} from './recovery';
import { appRollbackEvidenceSchema, backupRestoreEvidenceSchema } from './schemas';
import {
  buildAppRollbackEvidence,
  buildBackupRestoreEvidence,
  FIXTURE_CANDIDATE_SHA,
  sha256Of,
} from './testFixtures';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe('backup restore contracts', () => {
  it('rejects identical source/target identities', () => {
    expect(() => rejectIdenticalSourceTarget('same', 'same')).toThrow(
      /SourceTargetIdentical|identical/i,
    );
    expect(() => rejectIdenticalSourceTarget('a', 'b')).not.toThrow();
  });

  it('detects corrupted/empty dumps', () => {
    expect(isCorruptedDump(Buffer.alloc(0))).toBe(true);
    expect(isCorruptedDump(Buffer.alloc(8))).toBe(true);
    expect(isCorruptedDump(Buffer.alloc(32, 1))).toBe(false);
  });

  it('backup-restore evidence requires positive all-pass assertions for status=passed', () => {
    const bad = buildBackupRestoreEvidence({
      assertions: { failed: 0, passed: 0, skipped: 0, total: 0 },
      status: 'passed',
    });
    expect(backupRestoreEvidenceSchema.safeParse(bad).success).toBe(false);
  });

  it('backup-restore evidence fails when any invariant failed', () => {
    const bad = buildBackupRestoreEvidence({
      invariants: [
        { id: 'audit-logs', result: 'failed' },
        { id: 'publication-pointers', result: 'passed' },
        { id: 'required-tables', result: 'passed' },
        { id: 'resource-revisions', result: 'passed' },
        { id: 'secret-references', result: 'passed' },
        { id: 'source-preserved', result: 'passed' },
      ],
      status: 'passed',
    });
    expect(backupRestoreEvidenceSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts valid backup-restore evidence', () => {
    const ok = buildBackupRestoreEvidence();
    expect(backupRestoreEvidenceSchema.safeParse(ok).success).toBe(true);
    expect(ok.sourceBackupDigest).toMatch(/^[a-f\d]{64}$/);
  });

  it('source backup digest is sha256 of content bytes', () => {
    const dump = Buffer.from('synthetic-custom-format-dump-bytes!!');
    const digest = createHash('sha256').update(dump).digest('hex');
    expect(digest).toBe(sha256Of('synthetic-custom-format-dump-bytes!!'));
  });
});

describe('app rollback contracts', () => {
  it('rejects destructive DROP SQL in rollback window', () => {
    expect(() => rejectDestructiveCommand('DROP TABLE platform_resource_revisions')).toThrow(
      /Destructive/,
    );
    expect(() => rejectDestructiveCommand('ALTER TABLE x DROP COLUMN y')).toThrow(/Destructive/);
    expect(() => rejectDestructiveCommand('SELECT 1 FROM users')).not.toThrow();
  });

  it('rejects baseline/candidate substitution', () => {
    expect(() =>
      assertBaselineNotCandidate(FIXTURE_CANDIDATE_SHA, FIXTURE_CANDIDATE_SHA),
    ).toThrow();
    expect(() => assertBaselineNotCandidate(BASELINE_COMMIT, FIXTURE_CANDIDATE_SHA)).not.toThrow();
    expect(() => assertBaselineNotCandidate('0'.repeat(40), FIXTURE_CANDIDATE_SHA)).toThrow(
      /declared compatibility baseline/,
    );
  });

  it('unverified when baseline not executable cannot be status=passed', () => {
    const bad = buildAppRollbackEvidence({
      baselineExecutable: false,
      status: 'passed',
    });
    expect(appRollbackEvidenceSchema.safeParse(bad).success).toBe(false);

    const unverified = buildAppRollbackEvidence({
      assertions: { failed: 0, passed: 4, skipped: 1, total: 5 },
      baselineExecutable: false,
      status: 'unverified',
    });
    expect(appRollbackEvidenceSchema.safeParse(unverified).success).toBe(true);
  });

  it('requires new tables retained and roll-forward for pass', () => {
    const bad = buildAppRollbackEvidence({
      newTablesRetained: false,
      status: 'passed',
    });
    expect(appRollbackEvidenceSchema.safeParse(bad).success).toBe(false);
  });
});

describe('privacy of recovery evidence', () => {
  it('does not allow raw secret keys in evidence objects', () => {
    const ok = buildBackupRestoreEvidence();
    expect(scanForForbiddenReportContent(ok).result).toBe('passed');

    expect(
      scanForForbiddenReportContent({
        ciphertext: 'blob',
        gate: 'backup-restore',
      }).result,
    ).toBe('failed');
  });
});
