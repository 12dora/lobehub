// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES,
  platformGlobalCredentials,
  platformGlobalCredentialSecrets,
  platformGlobalCredentialUploads,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  assertPlatformGlobalCredentialFileSize,
  fingerprintPayload,
  PlatformGlobalCredentialConflictError,
  PlatformGlobalCredentialFileTooLargeError,
  PlatformGlobalCredentialModel,
  PlatformGlobalCredentialNotFoundError,
} from './globalCredential';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformGlobalCredentialSecrets);
  await db.delete(platformGlobalCredentialUploads);
  await db.delete(platformGlobalCredentials);
};

beforeEach(cleanup);
afterEach(cleanup);

const fakeEnvelope = (seed: string) => ({
  ciphertext: `aihub.secret.v1.test.${seed}`,
  fingerprint: fingerprintPayload(seed),
  keyId: 'test-key-v1',
});

describe('PlatformGlobalCredentialModel', () => {
  it('creates a credential, stores envelope, and never returns secret material on list/get', async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const created = await model.create({
      createdBy: 'user-admin-test',
      envelope: fakeEnvelope('kv-plaintext-placeholder'),
      key: 'openai',
      meta: {
        description: 'platform openai',
        maskedPreview: '••••xxxx',
        valueKeys: ['OPENAI_API_KEY'],
      },
      name: 'OpenAI',
      type: 'kv-env',
    });

    expect(created.id).toEqual(expect.any(Number));
    expect(created.key).toBe('openai');
    expect(created).not.toHaveProperty('ciphertext');
    expect(created).not.toHaveProperty('fingerprint');
    expect(created).not.toHaveProperty('ref');
    expect(JSON.stringify(created)).not.toContain('aihub.secret.v1');
    expect(JSON.stringify(created)).not.toContain('kv-plaintext-placeholder');

    const listed = await model.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('aihub.secret.v1');
    expect(JSON.stringify(listed)).not.toContain('kv-plaintext-placeholder');

    const got = await model.getById(created.id);
    expect(got?.name).toBe('OpenAI');
    expect(JSON.stringify(got)).not.toContain('aihub.secret.v1');

    // Envelope round-trip: ciphertext stored and retrievable only via internal accessor
    const envelope = await model.getActiveSecretEnvelope(created.id);
    expect(envelope).toMatchObject({
      ciphertext: 'aihub.secret.v1.test.kv-plaintext-placeholder',
      fingerprint: fingerprintPayload('kv-plaintext-placeholder'),
      keyId: 'test-key-v1',
    });
    expect(envelope?.ref).toMatch(/^kms:\/\/platform-global-credentials\//);

    const secretCount = await model.countSecrets(created.id);
    expect(secretCount).toBe(1);
  });

  it('rejects duplicate keys with a conflict error', async () => {
    const model = new PlatformGlobalCredentialModel(db);
    await model.create({
      envelope: fakeEnvelope('a'),
      key: 'dup-key',
      name: 'First',
      type: 'kv-header',
    });

    await expect(
      model.create({
        envelope: fakeEnvelope('b'),
        key: 'dup-key',
        name: 'Second',
        type: 'kv-header',
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialConflictError);
  });

  it('enforces file size upper bound (256 KiB)', async () => {
    expect(() => assertPlatformGlobalCredentialFileSize(1)).not.toThrow();
    expect(() =>
      assertPlatformGlobalCredentialFileSize(PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES),
    ).not.toThrow();
    expect(() =>
      assertPlatformGlobalCredentialFileSize(PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES + 1),
    ).toThrow(PlatformGlobalCredentialFileTooLargeError);

    const model = new PlatformGlobalCredentialModel(db);
    await expect(
      model.create({
        envelope: fakeEnvelope('file'),
        key: 'big-file',
        meta: { fileName: 'huge.bin', fileSize: PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES + 1 },
        name: 'Huge',
        type: 'file',
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialFileTooLargeError);

    await expect(
      model.stageUpload({
        envelope: fakeEnvelope('upload'),
        expiresAt: new Date(Date.now() + 60_000),
        fileHashId: 'a'.repeat(64),
        fileName: 'huge.bin',
        fileSize: PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES + 10,
        fileType: 'application/octet-stream',
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialFileTooLargeError);
  });

  it('updates meta/name and rotates secret envelope without leaking ciphertext on public views', async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const created = await model.create({
      envelope: fakeEnvelope('v1'),
      key: 'rotate-me',
      meta: { valueKeys: ['A'] },
      name: 'Rotate',
      type: 'kv-env',
    });

    const updated = await model.update({
      envelope: fakeEnvelope('v2'),
      id: created.id,
      meta: { valueKeys: ['A', 'B'], maskedPreview: 'configured' },
      name: 'Rotated',
      updatedBy: 'user-admin-test',
    });

    expect(updated.name).toBe('Rotated');
    expect(updated.valueKeys).toEqual(['A', 'B']);
    expect(JSON.stringify(updated)).not.toContain('aihub.secret.v1');

    const envelope = await model.getActiveSecretEnvelope(created.id);
    expect(envelope?.ciphertext).toBe('aihub.secret.v1.test.v2');
    expect(await model.countSecrets(created.id)).toBe(2);
  });

  it('deletes by id and by key', async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const a = await model.create({
      envelope: fakeEnvelope('del-a'),
      key: 'del-a',
      name: 'A',
      type: 'kv-env',
    });
    const b = await model.create({
      envelope: fakeEnvelope('del-b'),
      key: 'del-b',
      name: 'B',
      type: 'file',
      meta: { fileName: 'b.json', fileSize: 12 },
    });

    await expect(model.deleteById(a.id)).resolves.toBe(true);
    await expect(model.getById(a.id)).resolves.toBeUndefined();
    await expect(model.deleteByKey('del-b')).resolves.toBe(true);
    await expect(model.getByKey('del-b')).resolves.toBeUndefined();
    await expect(model.deleteById(b.id)).resolves.toBe(false);
    await expect(model.update({ id: 9_999_999, name: 'missing' })).rejects.toBeInstanceOf(
      PlatformGlobalCredentialNotFoundError,
    );
  });

  it('stages and consumes file uploads', async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const hash = 'b'.repeat(64);
    await model.stageUpload({
      envelope: fakeEnvelope('upload-body'),
      expiresAt: new Date(Date.now() + 60_000),
      fileHashId: hash,
      fileName: 'sa.json',
      fileSize: 32,
      fileType: 'application/json',
    });

    const consumed = await model.consumeUpload(hash);
    expect(consumed?.fileName).toBe('sa.json');
    expect(consumed?.ciphertext).toBe('aihub.secret.v1.test.upload-body');
    await expect(model.consumeUpload(hash)).resolves.toBeNull();
  });
});
