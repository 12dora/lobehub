// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformGlobalCredentialModel } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformGlobalCredentials,
  platformGlobalCredentialSecrets,
  platformGlobalCredentialUploads,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { EnvKeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

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
  await db.delete(platformAuditLogs);
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
