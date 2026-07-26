// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformGlobalCredentialModel } from '@/database/models/platform';
import {
  platformGlobalCredentials,
  platformGlobalCredentialSecrets,
  platformGlobalCredentialUploads,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { EnvKeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';
import type { PlatformAuditService } from '@/server/enterprise/services/platformAudit';

import {
  assertNoMaskedSecretValues,
  filterNonEmptySecretValues,
  PLATFORM_GLOBAL_CREDENTIAL_MASK,
  PlatformGlobalCredentialAdminService,
  PlatformGlobalCredentialValidationError,
  PlatformRevisionConflictError,
} from './adminService';

const db: LobeChatDatabase = await getTestDB();

const FAKE_MASTER_KEY_B64 = Buffer.alloc(32, 0x37).toString('base64');
const secrets = new PlatformSecretService({
  keyProvider: new EnvKeyProvider({
    keyId: 'env:test-creds',
    masterKeyBase64: FAKE_MASTER_KEY_B64,
  }),
});

const cleanup = async () => {
  // Audit logs are append-only (row triggers); TRUNCATE is the test cleanup path.
  await db.execute(sql.raw('TRUNCATE TABLE platform_audit_logs CASCADE'));
  await db.delete(platformGlobalCredentialSecrets);
  await db.delete(platformGlobalCredentialUploads);
  await db.delete(platformGlobalCredentials);
};

beforeEach(cleanup);
afterEach(cleanup);

const service = () => new PlatformGlobalCredentialAdminService(db, secrets);

const readKvMap = async (id: number): Promise<Record<string, string>> => {
  const model = new PlatformGlobalCredentialModel(db);
  const envelope = await model.getActiveSecretEnvelope(id);
  if (!envelope) return {};
  return JSON.parse(await secrets.decrypt(envelope.ciphertext)) as Record<string, string>;
};

describe('assertNoMaskedSecretValues / filterNonEmptySecretValues', () => {
  it('rejects the fixed mask string', () => {
    expect(() => assertNoMaskedSecretValues({ KEY: PLATFORM_GLOBAL_CREDENTIAL_MASK })).toThrow(
      PlatformGlobalCredentialValidationError,
    );
  });

  it('drops empty fields', () => {
    expect(filterNonEmptySecretValues({ A: 'x', B: '' })).toEqual({ A: 'x' });
    expect(filterNonEmptySecretValues({ A: '', B: '' })).toEqual({});
  });
});

describe('PlatformGlobalCredentialAdminService', () => {
  it('get(decrypt) returns masks never plaintext', async () => {
    const svc = service();
    const created = await svc.createKV({
      actorUserId: 'admin-1',
      key: 'mask-get',
      name: 'Mask Get',
      type: 'kv-env',
      values: { OPENAI_API_KEY: 'sk-test-placeholder-not-real' },
    });

    const detail = await svc.get({ decrypt: true, id: created.id });
    expect(detail.configured).toBe(true);
    expect(detail.plaintext).toEqual({ OPENAI_API_KEY: PLATFORM_GLOBAL_CREDENTIAL_MASK });
    expect(JSON.stringify(detail)).not.toContain('sk-test-placeholder-not-real');
  });

  it('update rejects mask literals; metadata-only leaves secret; partial merge keeps rest', async () => {
    const svc = service();
    const created = await svc.createKV({
      actorUserId: 'admin-1',
      key: 'merge-kv',
      name: 'Merge',
      type: 'kv-env',
      values: { A: 'alpha-secret', B: 'bravo-secret' },
    });

    await expect(
      svc.update({
        actorUserId: 'admin-1',
        expectedRevision: created.revision,
        id: created.id,
        values: { A: PLATFORM_GLOBAL_CREDENTIAL_MASK },
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialValidationError);

    const before = await readKvMap(created.id);

    const renamed = await svc.update({
      actorUserId: 'admin-1',
      expectedRevision: created.revision,
      id: created.id,
      name: 'Renamed only',
    });

    expect(await readKvMap(created.id)).toEqual(before);
    expect(before).toEqual({ A: 'alpha-secret', B: 'bravo-secret' });
    expect(renamed.revision).toBe(created.revision + 1);

    await svc.update({
      actorUserId: 'admin-1',
      expectedRevision: renamed.revision,
      id: created.id,
      values: { A: 'alpha-rotated' },
    });
    expect(await readKvMap(created.id)).toEqual({ A: 'alpha-rotated', B: 'bravo-secret' });
  });

  it('rejectsStaleExpectedRevisionOnConcurrentMetadataUpdate', async () => {
    const created = await service().createKV({
      actorUserId: 'admin-1',
      key: 'cas-meta',
      name: 'Original',
      type: 'kv-env',
      values: { A: 'alpha' },
    });
    const svc = service();
    const first = await svc.update({
      actorUserId: 'admin-a',
      expectedRevision: created.revision,
      id: created.id,
      name: 'Writer A',
    });
    await expect(
      svc.update({
        actorUserId: 'admin-b',
        expectedRevision: created.revision,
        id: created.id,
        name: 'Writer B stale',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect((await svc.get({ id: created.id })).name).toBe('Writer A');
    expect(first.revision).toBe(1);
  });

  it('preservesDisjointCredentialUpdatesUnderCAS', async () => {
    // PGlite is single-connection: true FOR UPDATE interleaving cannot run here.
    // Prove the regression-relevant contracts without a scheduler delay:
    // 1) stale expectedRevision is rejected (CAS)
    // 2) a writer that re-reads revision merges disjoint keys without loss
    const created = await service().createKV({
      actorUserId: 'admin-1',
      key: 'concurrent-kv',
      name: 'Concurrent',
      type: 'kv-env',
      values: { A: 'alpha' },
    });
    const svc = service();

    const afterB = await svc.update({
      actorUserId: 'admin-b',
      expectedRevision: created.revision,
      id: created.id,
      values: { B: 'bravo' },
    });
    expect(afterB.revision).toBe(created.revision + 1);

    await expect(
      svc.update({
        actorUserId: 'admin-c',
        expectedRevision: created.revision,
        id: created.id,
        values: { C: 'charlie' },
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    // Fresh CAS token after re-read: merge C onto {A,B} without dropping B.
    const head = await svc.get({ id: created.id });
    await svc.update({
      actorUserId: 'admin-c',
      expectedRevision: head.revision,
      id: created.id,
      values: { C: 'charlie' },
    });

    expect(await readKvMap(created.id)).toEqual({
      A: 'alpha',
      B: 'bravo',
      C: 'charlie',
    });
  });

  it('allowsOnlyOneConcurrentMutationForTheSameExpectedRevision', async () => {
    // No scheduler delay: both writers fire with the identical expectedRevision.
    // PGlite serializes connections, but CAS still admits exactly one commit — the loser
    // must be PlatformRevisionConflictError and must not merge its keys.
    const created = await service().createKV({
      actorUserId: 'admin-1',
      key: 'cas-race-kv',
      name: 'Race',
      type: 'kv-env',
      values: { A: 'alpha' },
    });
    const svc = service();
    const results = await Promise.allSettled([
      svc.update({
        actorUserId: 'admin-a',
        expectedRevision: created.revision,
        id: created.id,
        values: { A: 'from-a' },
      }),
      svc.update({
        actorUserId: 'admin-b',
        expectedRevision: created.revision,
        id: created.id,
        values: { B: 'from-b' },
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.any(PlatformRevisionConflictError),
    });

    const head = await svc.get({ id: created.id });
    expect(head.revision).toBe(created.revision + 1);
    const map = await readKvMap(created.id);
    // Exactly one writer's secret keys land; the stale writer is fully rejected.
    if (fulfilled[0]!.status === 'fulfilled') {
      const winner = fulfilled[0].value;
      expect(winner.name).toBe('Race');
    }
    expect(
      (map.A === 'from-a' && map.B === undefined) || (map.A === 'alpha' && map.B === 'from-b'),
    ).toBe(true);
    expect(Object.keys(map).sort()).toEqual(map.B === 'from-b' ? ['A', 'B'] : ['A']);
  });

  it('rotatesFileCredentialFromStagedUpload', async () => {
    const svc = service();
    const bodyV1 = Buffer.from('file-v1-bytes');
    const stagedV1 = await svc.uploadFile({
      actorUserId: 'admin-1',
      fileBase64: bodyV1.toString('base64'),
      fileName: 'v1.bin',
      fileType: 'application/octet-stream',
    });
    const created = await svc.createFile({
      actorUserId: 'admin-1',
      fileHashId: stagedV1.fileHashId,
      fileName: 'v1.bin',
      key: 'file-rot',
      name: 'File',
    });
    expect(created.revision).toBe(0);

    const bodyV2 = Buffer.from('file-v2-rotated-bytes');
    const stagedV2 = await svc.uploadFile({
      actorUserId: 'admin-1',
      fileBase64: bodyV2.toString('base64'),
      fileName: 'v2.bin',
      fileType: 'application/octet-stream',
    });
    const rotated = await svc.update({
      actorUserId: 'admin-1',
      expectedRevision: created.revision,
      fileHashId: stagedV2.fileHashId,
      fileName: 'v2.bin',
      id: created.id,
    });
    expect(rotated.id).toBe(created.id);
    expect(rotated.key).toBe('file-rot');
    expect(rotated.fileName).toBe('v2.bin');
    expect(rotated.revision).toBe(1);

    // Wrong owner cannot rotate with another admin's staged upload.
    const otherStaged = await svc.uploadFile({
      actorUserId: 'admin-other',
      fileBase64: Buffer.from('other').toString('base64'),
      fileName: 'other.bin',
      fileType: 'application/octet-stream',
    });
    await expect(
      svc.update({
        actorUserId: 'admin-1',
        expectedRevision: rotated.revision,
        fileHashId: otherStaged.fileHashId,
        id: created.id,
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialValidationError);
  });

  it('rejectsExpiredStagedUploadOnFileRotationAndKeepsPriorSecret', async () => {
    const svc = service();
    const bodyV1 = Buffer.from('file-v1-keep');
    const stagedV1 = await svc.uploadFile({
      actorUserId: 'admin-1',
      fileBase64: bodyV1.toString('base64'),
      fileName: 'keep.bin',
      fileType: 'application/octet-stream',
    });
    const created = await svc.createFile({
      actorUserId: 'admin-1',
      fileHashId: stagedV1.fileHashId,
      fileName: 'keep.bin',
      key: 'file-expired-stage',
      name: 'File',
    });
    const fingerprintBefore = (
      await new PlatformGlobalCredentialModel(db).getActiveSecretEnvelope(created.id)
    )?.fingerprint;

    const bodyV2 = Buffer.from('file-v2-expired-stage');
    const stagedV2 = await svc.uploadFile({
      actorUserId: 'admin-1',
      fileBase64: bodyV2.toString('base64'),
      fileName: 'next.bin',
      fileType: 'application/octet-stream',
    });
    // Expire the staged replacement without consuming it.
    await db
      .update(platformGlobalCredentialUploads)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(platformGlobalCredentialUploads.fileHashId, stagedV2.fileHashId));

    await expect(
      svc.update({
        actorUserId: 'admin-1',
        expectedRevision: created.revision,
        fileHashId: stagedV2.fileHashId,
        fileName: 'next.bin',
        id: created.id,
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialValidationError);

    const head = await svc.get({ id: created.id });
    expect(head.revision).toBe(created.revision);
    expect(head.fileName).toBe('keep.bin');
    expect(
      (await new PlatformGlobalCredentialModel(db).getActiveSecretEnvelope(created.id))
        ?.fingerprint,
    ).toBe(fingerprintBefore);
  });

  it('rejectsConcurrentSameRevisionFileRotationsLeavingOneWinner', async () => {
    const svc = service();
    const bodyV1 = Buffer.from('file-v1-cas');
    const stagedV1 = await svc.uploadFile({
      actorUserId: 'admin-1',
      fileBase64: bodyV1.toString('base64'),
      fileName: 'v1.bin',
      fileType: 'application/octet-stream',
    });
    const created = await svc.createFile({
      actorUserId: 'admin-1',
      fileHashId: stagedV1.fileHashId,
      fileName: 'v1.bin',
      key: 'file-cas-rot',
      name: 'File',
    });

    const stagedA = await svc.uploadFile({
      actorUserId: 'admin-1',
      fileBase64: Buffer.from('rot-a-bytes').toString('base64'),
      fileName: 'a.bin',
      fileType: 'application/octet-stream',
    });
    const stagedB = await svc.uploadFile({
      actorUserId: 'admin-1',
      fileBase64: Buffer.from('rot-b-bytes').toString('base64'),
      fileName: 'b.bin',
      fileType: 'application/octet-stream',
    });

    // PGlite serializes connections; still proves same-revision CAS rejects the loser.
    const results = await Promise.allSettled([
      svc.update({
        actorUserId: 'admin-1',
        expectedRevision: created.revision,
        fileHashId: stagedA.fileHashId,
        fileName: 'a.bin',
        id: created.id,
      }),
      svc.update({
        actorUserId: 'admin-1',
        expectedRevision: created.revision,
        fileHashId: stagedB.fileHashId,
        fileName: 'b.bin',
        id: created.id,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.any(PlatformRevisionConflictError),
    });

    const head = await svc.get({ id: created.id });
    expect(head.revision).toBe(created.revision + 1);
    expect(['a.bin', 'b.bin']).toContain(head.fileName);
    // Loser's staged upload must remain for a retry with a fresh expectedRevision.
    const winnerHash = head.fileName === 'a.bin' ? stagedA.fileHashId : stagedB.fileHashId;
    const loserHash = head.fileName === 'a.bin' ? stagedB.fileHashId : stagedA.fileHashId;
    expect(
      await new PlatformGlobalCredentialModel(db).getStagedUpload(winnerHash, 'admin-1'),
    ).toBeNull();
    expect(
      await new PlatformGlobalCredentialModel(db).getStagedUpload(loserHash, 'admin-1'),
    ).not.toBeNull();
  });

  it('rollsBackCredentialMutationWhenAuditAppendFails', async () => {
    const failingAudit = {
      append: async () => {
        throw new Error('audit ledger unavailable');
      },
    } as unknown as PlatformAuditService;
    const failing = () =>
      new PlatformGlobalCredentialAdminService(db, secrets, {
        createAudit: () => failingAudit,
      });

    await expect(
      failing().createKV({
        actorUserId: 'admin-1',
        key: 'audit-fail-kv',
        name: 'Audit fail',
        type: 'kv-env',
        values: { K: 'v' },
      }),
    ).rejects.toThrow(/audit ledger unavailable/);
    expect(await new PlatformGlobalCredentialModel(db).list()).toHaveLength(0);

    const stagedBody = Buffer.from('staged-bytes');
    await expect(
      failing().uploadFile({
        actorUserId: 'admin-1',
        fileBase64: stagedBody.toString('base64'),
        fileName: 'x.bin',
        fileType: 'application/octet-stream',
      }),
    ).rejects.toThrow(/audit ledger unavailable/);
    expect(await db.select().from(platformGlobalCredentialUploads)).toHaveLength(0);

    // Seed with a real audit path, then fail update/delete/createFile audits.
    const ok = await service().createKV({
      actorUserId: 'admin-1',
      key: 'audit-seed',
      name: 'Seed',
      type: 'kv-env',
      values: { A: '1' },
    });

    await expect(
      failing().update({
        actorUserId: 'admin-1',
        expectedRevision: ok.revision,
        id: ok.id,
        name: 'Should roll back',
      }),
    ).rejects.toThrow(/audit ledger unavailable/);
    expect((await new PlatformGlobalCredentialModel(db).getById(ok.id))?.name).toBe('Seed');

    await expect(failing().delete({ actorUserId: 'admin-1', id: ok.id })).rejects.toThrow(
      /audit ledger unavailable/,
    );
    expect(await new PlatformGlobalCredentialModel(db).getById(ok.id)).toBeDefined();

    await expect(
      failing().deleteByKey({ actorUserId: 'admin-1', key: 'audit-seed' }),
    ).rejects.toThrow(/audit ledger unavailable/);
    expect(await new PlatformGlobalCredentialModel(db).getByKey('audit-seed')).toBeDefined();

    const staged = await service().uploadFile({
      actorUserId: 'admin-1',
      fileBase64: Buffer.from('file-body').toString('base64'),
      fileName: 'f.bin',
      fileType: 'application/octet-stream',
    });
    await expect(
      failing().createFile({
        actorUserId: 'admin-1',
        fileHashId: staged.fileHashId,
        fileName: 'f.bin',
        key: 'audit-file',
        name: 'File',
      }),
    ).rejects.toThrow(/audit ledger unavailable/);
    expect(await new PlatformGlobalCredentialModel(db).getByKey('audit-file')).toBeUndefined();
    // Staging consume rolls back with the txn — upload row still present.
    expect(
      (await db.select().from(platformGlobalCredentialUploads)).some(
        (row) => row.fileHashId === staged.fileHashId,
      ),
    ).toBe(true);

    // File rotation path: audit failure must restore prior secret + keep staged replacement.
    const bodyV1 = Buffer.from('audit-rot-v1');
    const stagedV1 = await service().uploadFile({
      actorUserId: 'admin-1',
      fileBase64: bodyV1.toString('base64'),
      fileName: 'rot-v1.bin',
      fileType: 'application/octet-stream',
    });
    const fileCred = await service().createFile({
      actorUserId: 'admin-1',
      fileHashId: stagedV1.fileHashId,
      fileName: 'rot-v1.bin',
      key: 'audit-file-rot',
      name: 'Rotate',
    });
    const fingerprintBefore = (
      await new PlatformGlobalCredentialModel(db).getActiveSecretEnvelope(fileCred.id)
    )?.fingerprint;
    const bodyV2 = Buffer.from('audit-rot-v2');
    const stagedV2 = await service().uploadFile({
      actorUserId: 'admin-1',
      fileBase64: bodyV2.toString('base64'),
      fileName: 'rot-v2.bin',
      fileType: 'application/octet-stream',
    });
    await expect(
      failing().update({
        actorUserId: 'admin-1',
        expectedRevision: fileCred.revision,
        fileHashId: stagedV2.fileHashId,
        fileName: 'rot-v2.bin',
        id: fileCred.id,
      }),
    ).rejects.toThrow(/audit ledger unavailable/);
    const afterFailedRotate = await service().get({ id: fileCred.id });
    expect(afterFailedRotate.revision).toBe(fileCred.revision);
    expect(afterFailedRotate.fileName).toBe('rot-v1.bin');
    expect(
      (await new PlatformGlobalCredentialModel(db).getActiveSecretEnvelope(fileCred.id))
        ?.fingerprint,
    ).toBe(fingerprintBefore);
    expect(
      await new PlatformGlobalCredentialModel(db).getStagedUpload(stagedV2.fileHashId, 'admin-1'),
    ).not.toBeNull();
  });

  it('rejectsNonCanonicalBase64Uploads', async () => {
    const svc = service();
    let thrown: unknown;
    try {
      await svc.uploadFile({
        actorUserId: 'admin-1',
        // Valid alphabet chars mixed with invalid "!!!!" — Buffer.from accepts
        // this and produces "abc", but canonical check must reject.
        fileBase64: 'YWJj!!!!',
        fileName: 'bad.bin',
        fileType: 'application/octet-stream',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PlatformGlobalCredentialValidationError);
    expect(thrown).toMatchObject({
      message: 'PLATFORM_GLOBAL_CREDENTIAL_FILE_PAYLOAD_INVALID',
      validationCode: 'PLATFORM_GLOBAL_CREDENTIAL_FILE_PAYLOAD_INVALID',
    });
  });

  it('createFile keeps staging on key conflict and succeeds on retry', async () => {
    const svc = service();
    await svc.createKV({
      actorUserId: 'admin-1',
      key: 'file-conflict',
      name: 'Taken',
      type: 'kv-header',
      values: { H: 'v' },
    });

    const fileBody = Buffer.from('{"type":"service_account","placeholder":true}');
    const staged = await svc.uploadFile({
      actorUserId: 'admin-1',
      fileBase64: fileBody.toString('base64'),
      fileName: 'sa.json',
      fileType: 'application/json',
    });

    await expect(
      svc.createFile({
        actorUserId: 'admin-1',
        fileHashId: staged.fileHashId,
        fileName: 'sa.json',
        key: 'file-conflict',
        name: 'Clash',
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_GLOBAL_CREDENTIAL_CONFLICT' });

    const created = await svc.createFile({
      actorUserId: 'admin-1',
      fileHashId: staged.fileHashId,
      fileName: 'sa.json',
      key: 'file-ok',
      name: 'OK',
    });
    expect(created.key).toBe('file-ok');
    expect(created.fileName).toBe('sa.json');
  });
});
