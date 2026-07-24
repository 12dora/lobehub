// @vitest-environment node
import { sql } from 'drizzle-orm';
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
        id: created.id,
        values: { A: PLATFORM_GLOBAL_CREDENTIAL_MASK },
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialValidationError);

    const before = await readKvMap(created.id);

    await svc.update({
      actorUserId: 'admin-1',
      id: created.id,
      name: 'Renamed only',
    });

    expect(await readKvMap(created.id)).toEqual(before);
    expect(before).toEqual({ A: 'alpha-secret', B: 'bravo-secret' });

    await svc.update({
      actorUserId: 'admin-1',
      id: created.id,
      values: { A: 'alpha-rotated' },
    });
    expect(await readKvMap(created.id)).toEqual({ A: 'alpha-rotated', B: 'bravo-secret' });
  });

  it('preservesDisjointConcurrentCredentialUpdates', async () => {
    const created = await service().createKV({
      actorUserId: 'admin-1',
      key: 'concurrent-kv',
      name: 'Concurrent',
      type: 'kv-env',
      values: { A: 'alpha' },
    });

    // Deterministic barrier: first writer holds the row lock after reading the
    // secret map while the second writer is already attempting update (blocks
    // on FOR UPDATE). Without the lock, both would merge from {A} and one key
    // would be lost; with the lock, the second re-reads after the first commits.
    let firstEntered = false;
    let resolveFirstAtSeam!: () => void;
    const firstAtSeam = new Promise<void>((resolve) => {
      resolveFirstAtSeam = resolve;
    });
    let resolveReleaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      resolveReleaseFirst = resolve;
    });

    const svc = new PlatformGlobalCredentialAdminService(db, secrets, {
      lifecycle: {
        afterLockBeforeSecretMerge: async () => {
          if (!firstEntered) {
            firstEntered = true;
            resolveFirstAtSeam();
            await holdFirst;
          }
        },
      },
    });

    const first = svc.update({
      actorUserId: 'admin-b',
      id: created.id,
      values: { B: 'bravo' },
    });
    await firstAtSeam;

    const second = svc.update({
      actorUserId: 'admin-c',
      id: created.id,
      values: { C: 'charlie' },
    });
    // Give the second writer time to block on FOR UPDATE before releasing first.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    resolveReleaseFirst();
    await Promise.all([first, second]);

    expect(await readKvMap(created.id)).toEqual({
      A: 'alpha',
      B: 'bravo',
      C: 'charlie',
    });
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
  });

  it('rejectsNonCanonicalBase64Uploads', async () => {
    const svc = service();
    await expect(
      svc.uploadFile({
        actorUserId: 'admin-1',
        // Valid alphabet chars mixed with invalid "!!!!" — Buffer.from accepts
        // this and produces "abc", but canonical check must reject.
        fileBase64: 'YWJj!!!!',
        fileName: 'bad.bin',
        fileType: 'application/octet-stream',
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialValidationError);
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
