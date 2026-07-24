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
import { PlatformRevisionConflictError } from './errors';
import {
  assertPlatformGlobalCredentialFileSize,
  fingerprintPayload,
  PlatformGlobalCredentialConflictError,
  PlatformGlobalCredentialFileTooLargeError,
  PlatformGlobalCredentialModel,
  PlatformGlobalCredentialNotFoundError,
  PlatformGlobalCredentialValidationError,
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
        createdBy: 'admin-size',
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
    expect(created.revision).toBe(0);

    const updated = await model.update({
      envelope: fakeEnvelope('v2'),
      expectedRevision: created.revision,
      id: created.id,
      meta: { valueKeys: ['A', 'B'], maskedPreview: 'configured' },
      name: 'Rotated',
      updatedBy: 'user-admin-test',
    });

    expect(updated.name).toBe('Rotated');
    expect(updated.valueKeys).toEqual(['A', 'B']);
    expect(updated.revision).toBe(1);
    expect(JSON.stringify(updated)).not.toContain('aihub.secret.v1');

    const envelope = await model.getActiveSecretEnvelope(created.id);
    expect(envelope?.ciphertext).toBe('aihub.secret.v1.test.v2');
    expect(await model.countSecrets(created.id)).toBe(2);
  });

  it('rejects stale expectedRevision with a revision conflict', async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const created = await model.create({
      envelope: fakeEnvelope('cas-v1'),
      key: 'cas-cred',
      name: 'CAS',
      type: 'kv-env',
    });
    await model.update({
      expectedRevision: 0,
      id: created.id,
      name: 'CAS renamed',
      updatedBy: 'admin-a',
    });
    await expect(
      model.update({
        expectedRevision: 0,
        id: created.id,
        name: 'stale writer',
        updatedBy: 'admin-b',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect((await model.getById(created.id))?.name).toBe('CAS renamed');
    expect((await model.getById(created.id))?.revision).toBe(1);
  });

  it('rotates a file credential from a staged upload while preserving id/key', async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const actor = 'admin-file-rotate';
    const created = await model.create({
      createdBy: actor,
      envelope: fakeEnvelope('file-v1'),
      key: 'file-rotate',
      meta: { fileName: 'old.json', fileSize: 8, maskedPreview: 'old.json' },
      name: 'File rotate',
      type: 'file',
    });
    const hash = 'a'.repeat(64);
    await model.stageUpload({
      createdBy: actor,
      envelope: fakeEnvelope('file-v2'),
      expiresAt: new Date(Date.now() + 60_000),
      fileHashId: hash,
      fileName: 'new.json',
      fileSize: 16,
      fileType: 'application/json',
    });

    const rotated = await model.updateFromStagedUpload({
      createdBy: actor,
      expectedRevision: created.revision,
      fileHashId: hash,
      id: created.id,
      name: 'File rotate',
    });
    expect(rotated.id).toBe(created.id);
    expect(rotated.key).toBe('file-rotate');
    expect(rotated.fileName).toBe('new.json');
    expect(rotated.fileSize).toBe(16);
    expect(rotated.revision).toBe(1);
    expect((await model.getActiveSecretEnvelope(created.id))?.ciphertext).toBe(
      'aihub.secret.v1.test.file-v2',
    );
    expect(await model.countSecrets(created.id)).toBe(2);
    await expect(model.getStagedUpload(hash, actor)).resolves.toBeNull();

    // Wrong owner cannot consume another admin's staging row.
    await model.stageUpload({
      createdBy: 'other-admin',
      envelope: fakeEnvelope('file-stolen'),
      expiresAt: new Date(Date.now() + 60_000),
      fileHashId: 'b'.repeat(64),
      fileName: 'x.json',
      fileSize: 4,
      fileType: 'application/json',
    });
    await expect(
      model.updateFromStagedUpload({
        createdBy: actor,
        expectedRevision: rotated.revision,
        fileHashId: 'b'.repeat(64),
        id: created.id,
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialValidationError);
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
    await expect(
      model.update({ expectedRevision: 0, id: 9_999_999, name: 'missing' }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialNotFoundError);
  });

  it('stages and consumes file uploads', async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const hash = 'b'.repeat(64);
    const actor = 'admin-stage-consume';
    await model.stageUpload({
      createdBy: actor,
      envelope: fakeEnvelope('upload-body'),
      expiresAt: new Date(Date.now() + 60_000),
      fileHashId: hash,
      fileName: 'sa.json',
      fileSize: 32,
      fileType: 'application/json',
    });

    const consumed = await model.consumeUpload(hash, actor);
    expect(consumed?.fileName).toBe('sa.json');
    expect(consumed?.ciphertext).toBe('aihub.secret.v1.test.upload-body');
    await expect(model.consumeUpload(hash, actor)).resolves.toBeNull();
  });

  it("rejects replacing another actor's staged upload", async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const hash = 'f'.repeat(64);
    await model.stageUpload({
      createdBy: 'admin-a',
      envelope: fakeEnvelope('a-body'),
      expiresAt: new Date(Date.now() + 60_000),
      fileHashId: hash,
      fileName: 'a.json',
      fileSize: 8,
      fileType: 'application/json',
    });

    // Same content hash, different owner → separate row (no overwrite of A).
    await model.stageUpload({
      createdBy: 'admin-b',
      envelope: fakeEnvelope('b-body'),
      expiresAt: new Date(Date.now() + 60_000),
      fileHashId: hash,
      fileName: 'b.json',
      fileSize: 9,
      fileType: 'application/json',
    });

    const a = await model.getStagedUpload(hash, 'admin-a');
    const b = await model.getStagedUpload(hash, 'admin-b');
    expect(a?.fileName).toBe('a.json');
    expect(a?.ciphertext).toBe('aihub.secret.v1.test.a-body');
    expect(b?.fileName).toBe('b.json');
    expect(b?.ciphertext).toBe('aihub.secret.v1.test.b-body');
    expect(a?.id).not.toBe(b?.id);
  });

  it("rejects consuming another actor's upload", async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const hash = '1'.repeat(64);
    await model.stageUpload({
      createdBy: 'admin-a',
      envelope: fakeEnvelope('owned-by-a'),
      expiresAt: new Date(Date.now() + 60_000),
      fileHashId: hash,
      fileName: 'secret.json',
      fileSize: 12,
      fileType: 'application/json',
    });

    await expect(model.consumeUpload(hash, 'admin-b')).resolves.toBeNull();
    await expect(model.getStagedUpload(hash, 'admin-a')).resolves.toMatchObject({
      fileName: 'secret.json',
    });

    await expect(
      model.createFromStagedUpload({
        createdBy: 'admin-b',
        fileHashId: hash,
        key: 'stolen-key',
        name: 'Stolen',
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialValidationError);

    const created = await model.createFromStagedUpload({
      createdBy: 'admin-a',
      fileHashId: hash,
      key: 'owned-key',
      name: 'Owned',
    });
    expect(created.key).toBe('owned-key');
    expect(created.createdBy).toBe('admin-a');
  });

  it('createFromStagedUpload keeps staging on key conflict and succeeds on retry', async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const actor = 'admin-retry';
    await model.create({
      envelope: fakeEnvelope('existing'),
      key: 'dup-file-key',
      name: 'Existing',
      type: 'kv-env',
    });

    const hash = 'c'.repeat(64);
    await model.stageUpload({
      createdBy: actor,
      envelope: fakeEnvelope('staged-file'),
      expiresAt: new Date(Date.now() + 60_000),
      fileHashId: hash,
      fileName: 'retry.json',
      fileSize: 16,
      fileType: 'application/json',
    });

    await expect(
      model.createFromStagedUpload({
        createdBy: actor,
        fileHashId: hash,
        key: 'dup-file-key',
        name: 'Conflict',
      }),
    ).rejects.toBeInstanceOf(PlatformGlobalCredentialConflictError);

    // Staging must survive the conflict so the admin can retry with a new key.
    await expect(model.getStagedUpload(hash, actor)).resolves.toMatchObject({
      fileName: 'retry.json',
    });

    const created = await model.createFromStagedUpload({
      createdBy: actor,
      fileHashId: hash,
      key: 'unique-file-key',
      name: 'Retry ok',
    });
    expect(created.key).toBe('unique-file-key');
    expect(created.fileName).toBe('retry.json');
    await expect(model.getStagedUpload(hash, actor)).resolves.toBeNull();
  });

  it('stageUpload GCs expired staging rows', async () => {
    const model = new PlatformGlobalCredentialModel(db);
    const actor = 'admin-gc';
    const expired = 'd'.repeat(64);
    const fresh = 'e'.repeat(64);
    await model.stageUpload({
      createdBy: actor,
      envelope: fakeEnvelope('expired'),
      expiresAt: new Date(Date.now() - 1000),
      fileHashId: expired,
      fileName: 'old.bin',
      fileSize: 8,
      fileType: 'application/octet-stream',
    });
    // Expired rows are not returned by getStagedUpload (expiresAt filter),
    // but they still exist until the next stageUpload GCs them.
    await model.stageUpload({
      createdBy: actor,
      envelope: fakeEnvelope('fresh'),
      expiresAt: new Date(Date.now() + 60_000),
      fileHashId: fresh,
      fileName: 'new.bin',
      fileSize: 8,
      fileType: 'application/octet-stream',
    });
    await expect(model.getStagedUpload(fresh, actor)).resolves.toMatchObject({
      fileName: 'new.bin',
    });
  });
});
