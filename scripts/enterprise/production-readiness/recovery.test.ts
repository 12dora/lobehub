// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { BASELINE_COMMIT } from './constants';
import {
  assertBaselineNotCandidate,
  assertInventoryMatchesSchemas,
  isCorruptedDump,
  RECOVERY_ENTERPRISE_TABLES,
  rejectDestructiveCommand,
  rejectIdenticalSourceTarget,
  scanForForbiddenReportContent,
} from './index';
import {
  compareDigests,
  digestResourceRevisions,
  verifySecretReferenceDomains,
} from './recovery/invariants';
import { createOwnedPostgres } from './recovery/ownedPostgres';
import { seedRecoveryFixture } from './recovery/seed';
import { appRollbackEvidenceSchema, backupRestoreEvidenceSchema } from './schemas';
import { buildAppRollbackEvidenceShape, FIXTURE_CANDIDATE_SHA, sha256Of } from './testFixtures';

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

const dockerAvailable = async (): Promise<boolean> => {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('docker', ['info'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};

describe('backup restore contracts', () => {
  it('rejects identical source/target', () => {
    expect(() => rejectIdenticalSourceTarget('same', 'same')).toThrow();
    expect(() => rejectIdenticalSourceTarget('a', 'b')).not.toThrow();
  });

  it('detects corrupted dumps', () => {
    expect(isCorruptedDump(Buffer.alloc(0))).toBe(true);
    expect(isCorruptedDump(Buffer.alloc(32, 1))).toBe(false);
  });

  it('backup evidence schema requires all-pass for status=passed', () => {
    const bad = {
      assertions: { failed: 0, passed: 0, skipped: 0, total: 0 },
      candidateSha: FIXTURE_CANDIDATE_SHA,
      cleanupResult: 'passed',
      dbSchemaVersionTag: 'tag',
      freshness: { generatedAt: new Date().toISOString() },
      gate: 'backup-restore',
      invariants: [{ id: 'resource-revisions', result: 'passed' }],
      lane: 'enterprise-backup-restore-drill',
      reportSchemaVersion: 1,
      schemaVersion: 1,
      scope: 'local-harness',
      sourceBackupDigest: sha256Of('x'),
      sourcePreserved: true,
      status: 'passed',
    };
    expect(backupRestoreEvidenceSchema.safeParse(bad).success).toBe(false);
  });
});

describe('app rollback contracts', () => {
  it('rejects destructive SQL', () => {
    expect(() => rejectDestructiveCommand('DROP TABLE x')).toThrow();
    expect(() => rejectDestructiveCommand('SELECT 1')).not.toThrow();
  });

  it('rejects baseline=candidate and wrong baseline', () => {
    expect(() =>
      assertBaselineNotCandidate(FIXTURE_CANDIDATE_SHA, FIXTURE_CANDIDATE_SHA),
    ).toThrow();
    expect(() => assertBaselineNotCandidate(BASELINE_COMMIT, FIXTURE_CANDIDATE_SHA)).not.toThrow();
    expect(() => assertBaselineNotCandidate('0'.repeat(40), FIXTURE_CANDIDATE_SHA)).toThrow();
  });

  it('unverified without baselineExecutable cannot be passed', () => {
    const bad = { ...buildAppRollbackEvidenceShape(), baselineExecutable: false, status: 'passed' };
    expect(appRollbackEvidenceSchema.safeParse(bad).success).toBe(false);
  });
});

describe('inventory drift guard', () => {
  it('matches platform schema tables', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    await assertInventoryMatchesSchemas(repoRoot);
    expect(RECOVERY_ENTERPRISE_TABLES.length).toBeGreaterThan(20);
  });
});

describe('secret/publication mutation detection (docker)', () => {
  it('detects secret ref rewiring and published revision deletion', async () => {
    if (!(await dockerAvailable())) {
      expect(true).toBe(true);
      return;
    }
    const lifecycle = await createOwnedPostgres();
    try {
      await lifecycle.handle.withClient(async (client) => {
        await seedRecoveryFixture(client);
        const beforeSecrets = await verifySecretReferenceDomains(client);
        expect(beforeSecrets.match).toBe(true);

        // Mutate all secret refs
        await client.query(
          `UPDATE platform_identity_providers SET secret_ref = 'kms://rewired/identity'`,
        );
        await client.query(
          `UPDATE platform_connectors SET shared_secret_ref = 'kms://rewired/shared'`,
        );
        const afterRewire = await verifySecretReferenceDomains(client);
        expect(afterRewire.aggregateDigest).not.toBe(beforeSecrets.aggregateDigest);
        // identity match should fail because history ref differs from current
        expect(afterRewire.match).toBe(false);

        // Restore and delete published revision
        await seedRecoveryFixture(client);
        const beforeRev = await digestResourceRevisions(client);
        await client.query(`DELETE FROM platform_resource_revisions WHERE status = 'published'`);
        const afterRev = await digestResourceRevisions(client);
        expect(compareDigests(beforeRev, afterRev)).toBe(false);
      });
    } finally {
      await lifecycle.cleanup();
    }
  }, 120_000);
});

describe('privacy', () => {
  it('blocks ciphertext keys', () => {
    expect(scanForForbiddenReportContent({ ciphertext: 'x' }).result).toBe('failed');
  });
});

void createHash;
void mkdtemp;
void tmpdir;
