// @vitest-environment node
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import pathModule from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PlatformSecretService } from '../../security/secret';
import { readIdentityProviderLkg, writeIdentityProviderLkg } from './lkg';

const directories: string[] = [];
const masterKey = Buffer.alloc(32, 61).toString('base64');
const secrets = () =>
  PlatformSecretService.tryFromEnv({
    PLATFORM_MASTER_KEY: masterKey,
    PLATFORM_MASTER_KEY_ID: 'env:lkg-test',
  })!;

const createPath = async () => {
  const directory = await mkdtemp(pathModule.join(await realpath(tmpdir()), 'aihub-oidc-lkg-'));
  directories.push(directory);
  return pathModule.join(directory, 'snapshot.json');
};

const payload = (createdAt = new Date().toISOString()) => ({
  createdAt,
  domain: 'platform-oidc-lkg' as const,
  identityRevision: 'a'.repeat(64),
  providers: [
    {
      payload: { providerKey: 'corp' },
      revision: 3,
      secretCiphertext: 'aihub.secret.v1.test',
    },
  ],
  version: 1 as const,
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('identity provider LKG', () => {
  it('round-trips a signed, encrypted, owner-only snapshot', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    const expected = payload();

    await expect(
      writeIdentityProviderLkg({ env, payload: expected, secrets: secrets() }),
    ).resolves.toBe('written');
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('providerKey');
    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).resolves.toEqual(expected);
  });

  it('rejects ciphertext or signature tampering', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    await writeIdentityProviderLkg({ env, payload: payload(), secrets: secrets() });
    const envelope = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
    envelope.ciphertext = `${envelope.ciphertext}x`;
    await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });

    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).rejects.toThrow(
      'OIDC_LKG_SIGNATURE_INVALID',
    );
  });

  it('rejects stale snapshots', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_MAX_AGE_SECONDS: '1', PLATFORM_OIDC_LKG_PATH: path };
    await writeIdentityProviderLkg({
      env,
      payload: payload(new Date(Date.now() - 60_000).toISOString()),
      secrets: secrets(),
    });

    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).rejects.toThrow(
      'OIDC_LKG_STALE',
    );
  });

  it('refuses an owner-writable-by-others directory', async () => {
    const path = await createPath();
    await chmod(pathModule.dirname(path), 0o770);

    await expect(
      writeIdentityProviderLkg({
        env: { PLATFORM_OIDC_LKG_PATH: path },
        payload: payload(),
        secrets: secrets(),
      }),
    ).rejects.toThrow('OIDC_LKG_DIRECTORY_PERMISSIONS_INVALID');
  });

  it('refuses a symlink target and leaves the link destination untouched', async () => {
    const path = await createPath();
    const destination = pathModule.join(
      await realpath(tmpdir()),
      `aihub-oidc-lkg-destination-${process.pid}`,
    );
    await writeFile(destination, 'untouched', { mode: 0o600 });
    try {
      await symlink(destination, path);
      await expect(
        writeIdentityProviderLkg({
          env: { PLATFORM_OIDC_LKG_PATH: path },
          payload: payload(),
          secrets: secrets(),
        }),
      ).rejects.toThrow('OIDC_LKG_TARGET_SYMLINK_FORBIDDEN');
      await expect(readFile(destination, 'utf8')).resolves.toBe('untouched');
    } finally {
      await unlink(path).catch(() => undefined);
      await unlink(destination).catch(() => undefined);
    }
  });
});
