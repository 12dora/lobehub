// @vitest-environment node
import {
  appendFile,
  chmod,
  link,
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

import { checksumPayload } from '@/database/models/platform';

import { PlatformSecretService } from '../../security/secret';
import type { IdentityProviderLkgPayload } from './lkg';
import {
  advanceIdentityProviderLkgAfterTombstone,
  IDENTITY_PROVIDER_LKG_VERSION,
  IDENTITY_PROVIDER_LKG_VERSION_V1,
  identityProviderLkgIdentity,
  readIdentityProviderLkg,
  writeIdentityProviderLkg,
} from './lkg';

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

const payload = (
  createdAt = new Date().toISOString(),
  revision = 3,
  options?: { providerId?: string; providerKey?: string },
): IdentityProviderLkgPayload => {
  const providerId = options?.providerId ?? 'provider-1';
  const published = {
    providerKey: options?.providerKey ?? 'corp',
    secretFingerprint: 'a'.repeat(64),
    secretUpdatedAt: '2026-07-19T00:00:00.000Z',
  };
  const generation = `2026-01-01T00:00:00.000Z:${revision}`;
  const providers = [
    {
      checksum: checksumPayload(published),
      generation,
      payload: published,
      providerId,
      revision,
      secretCiphertext: 'aihub.secret.v1.test',
      secretFingerprint: published.secretFingerprint,
    },
  ];
  return {
    createdAt,
    domain: 'platform-oidc-lkg' as const,
    generation,
    identityRevision: identityProviderLkgIdentity(providers),
    providerTombstones: [] as Array<{ generation: string; providerId: string }>,
    providers,
    version: IDENTITY_PROVIDER_LKG_VERSION,
  };
};

/** Strict legacy v1 six-field snapshot (no providerTombstones key). */
const legacyV1Payload = (createdAt = new Date().toISOString(), revision = 3) => {
  const published = {
    providerKey: 'corp',
    secretFingerprint: 'a'.repeat(64),
    secretUpdatedAt: '2026-07-19T00:00:00.000Z',
  };
  const generation = `2026-01-01T00:00:00.000Z:${revision}`;
  const providers = [
    {
      checksum: checksumPayload(published),
      generation,
      payload: published,
      providerId: 'provider-1',
      revision,
      secretCiphertext: 'aihub.secret.v1.test',
      secretFingerprint: published.secretFingerprint,
    },
  ];
  return {
    createdAt,
    domain: 'platform-oidc-lkg' as const,
    generation,
    identityRevision: identityProviderLkgIdentity(providers),
    providers,
    version: IDENTITY_PROVIDER_LKG_VERSION_V1,
  };
};

const multiProviderPayload = (createdAt = new Date().toISOString()): IdentityProviderLkgPayload => {
  const left = payload(createdAt, 3, { providerId: 'provider-a', providerKey: 'corp-a' });
  const right = payload(createdAt, 4, { providerId: 'provider-b', providerKey: 'corp-b' });
  const providers = [...left.providers, ...right.providers];
  const generation = providers.reduce(
    (latest, provider) => (provider.generation > latest ? provider.generation : latest),
    '0000-01-01T00:00:00.000Z:',
  );
  return {
    createdAt,
    domain: 'platform-oidc-lkg' as const,
    generation,
    identityRevision: identityProviderLkgIdentity(providers),
    providerTombstones: [] as Array<{ generation: string; providerId: string }>,
    providers,
    version: IDENTITY_PROVIDER_LKG_VERSION,
  };
};

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

  it('loads a legacy v1 six-field LKG (no providerTombstones) and round-trips v2 writes (identity/F10)', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    const service = secrets();
    const legacy = legacyV1Payload();
    // Manually seal a strict v1 envelope so we prove the reader still accepts pre-tombstone files.
    const ciphertext = await service.encrypt(JSON.stringify(legacy));
    const envelope = {
      ciphertext,
      format: 'aihub.platform.oidc-lkg',
      signature: await service.signArtifact('platform-oidc-lkg', ciphertext),
      version: IDENTITY_PROVIDER_LKG_VERSION_V1,
    };
    await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });

    const loaded = await readIdentityProviderLkg({ env, secrets: service });
    expect(loaded).toMatchObject({
      generation: legacy.generation,
      identityRevision: legacy.identityRevision,
      providerTombstones: [],
      providers: legacy.providers,
      version: IDENTITY_PROVIDER_LKG_VERSION_V1,
    });
    // New writes always persist the current version with an explicit tombstone list.
    const next = payload(new Date().toISOString(), 4);
    await expect(writeIdentityProviderLkg({ env, payload: next, secrets: service })).resolves.toBe(
      'written',
    );
    await expect(readIdentityProviderLkg({ env, secrets: service })).resolves.toEqual({
      ...next,
      providerTombstones: [],
      version: IDENTITY_PROVIDER_LKG_VERSION,
    });
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

  it('requires exact directory and file modes', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    await chmod(pathModule.dirname(path), 0o500);
    await expect(
      writeIdentityProviderLkg({ env, payload: payload(), secrets: secrets() }),
    ).rejects.toThrow('OIDC_LKG_DIRECTORY_PERMISSIONS_INVALID');

    await chmod(pathModule.dirname(path), 0o700);
    await writeIdentityProviderLkg({ env, payload: payload(), secrets: secrets() });
    await chmod(path, 0o400);
    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).rejects.toThrow(
      'OIDC_LKG_FILE_PERMISSIONS_INVALID',
    );
  });

  it('rejects hard-linked snapshots', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    const secondLink = `${path}.copy`;
    await writeIdentityProviderLkg({ env, payload: payload(), secrets: secrets() });
    await link(path, secondLink);

    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).rejects.toThrow(
      'OIDC_LKG_FILE_LINK_INVALID',
    );
  });

  it('rejects a file that grows after the verified descriptor stat', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    await writeIdentityProviderLkg({ env, payload: payload(), secrets: secrets() });

    await expect(
      readIdentityProviderLkg({
        env,
        secrets: secrets(),
        testHooks: { afterFileStat: async () => appendFile(path, 'x') },
      }),
    ).rejects.toThrow('OIDC_LKG_FILE_CHANGED_DURING_READ');
  });

  it('refuses a checksum-valid shape whose full-set identity was not updated', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    const original = payload();
    await writeIdentityProviderLkg({ env, payload: original, secrets: secrets() });
    const tampered = structuredClone(payload(new Date().toISOString(), 4));
    tampered.providers[0].payload.providerKey = 'tampered';
    tampered.providers[0].checksum = checksumPayload(tampered.providers[0].payload);

    await expect(
      writeIdentityProviderLkg({ env, payload: tampered, secrets: secrets() }),
    ).rejects.toThrow('OIDC_LKG_IDENTITY_INVALID');
    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).resolves.toEqual(original);
  });

  it('does not let a lower generation overwrite the current LKG', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    const newer = payload(new Date().toISOString(), 4);
    await writeIdentityProviderLkg({ env, payload: newer, secrets: secrets() });

    await expect(
      writeIdentityProviderLkg({ env, payload: payload(), secrets: secrets() }),
    ).resolves.toBe('rejected');
    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).resolves.toEqual(newer);
  });

  it('permits authenticated monotonic provider removal (tombstone / outage fallback)', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    const withProvider = payload(new Date().toISOString(), 3);
    await writeIdentityProviderLkg({ env, payload: withProvider, secrets: secrets() });

    // Higher generation with empty provider set = signed revoke must stick.
    // Generation may exceed the (empty) provider max because the tombstone floor advanced it.
    const emptyProviders: typeof withProvider.providers = [];
    const revoked = {
      ...withProvider,
      createdAt: new Date().toISOString(),
      generation: '2026-12-01T00:00:00.000Z:tombstone',
      identityRevision: identityProviderLkgIdentity(emptyProviders),
      providers: emptyProviders,
    };
    await expect(
      writeIdentityProviderLkg({ env, payload: revoked, secrets: secrets() }),
    ).resolves.toBe('written');
    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).resolves.toMatchObject({
      generation: revoked.generation,
      providers: [],
    });
    // Outage must not resurrect the revoked provider via lower-generation LKG write.
    await expect(
      writeIdentityProviderLkg({ env, payload: withProvider, secrets: secrets() }),
    ).resolves.toBe('rejected');
  });

  it('advances LKG after tombstone so immediate total-outage cannot resurrect (identity/F10)', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    const withProvider = payload(new Date().toISOString(), 3);
    await writeIdentityProviderLkg({ env, payload: withProvider, secrets: secrets() });

    await expect(
      advanceIdentityProviderLkgAfterTombstone({
        env,
        removedProviderId: 'provider-1',
        secrets: secrets(),
        tombstoneGeneration: '2026-12-01T12:00:00.000Z:tombstone-row',
      }),
    ).resolves.toBe('written');

    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).resolves.toMatchObject({
      providerTombstones: [
        {
          generation: '2026-12-01T12:00:00.000Z:tombstone-row',
          providerId: 'provider-1',
        },
      ],
      providers: [],
    });
    // Lower-generation pre-tombstone snapshot cannot overwrite the advanced LKG.
    await expect(
      writeIdentityProviderLkg({ env, payload: withProvider, secrets: secrets() }),
    ).resolves.toBe('rejected');
  });

  it('merges overlapping provider disables so neither provider is resurrected (identity/F10)', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    const both = multiProviderPayload(new Date().toISOString());
    await writeIdentityProviderLkg({ env, payload: both, secrets: secrets() });

    let enterRename = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enterRename = resolve;
    });
    let releaseRename = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });

    // First disable holds the write lock through rename; second must merge, not overwrite.
    const first = advanceIdentityProviderLkgAfterTombstone({
      env,
      removedProviderId: 'provider-a',
      secrets: secrets(),
      testHooks: {
        beforeRename: async () => {
          enterRename();
          await released;
        },
      },
      tombstoneGeneration: '2026-12-01T12:00:00.000Z:tombstone-a',
    });
    await entered;
    const second = advanceIdentityProviderLkgAfterTombstone({
      env,
      removedProviderId: 'provider-b',
      secrets: secrets(),
      tombstoneGeneration: '2026-12-01T12:00:01.000Z:tombstone-b',
    });
    releaseRename();

    await expect(first).resolves.toBe('written');
    await expect(second).resolves.toBe('written');
    const advanced = await readIdentityProviderLkg({ env, secrets: secrets() });
    expect(advanced?.providers.map((provider) => provider.providerId)).toEqual([]);
    expect(advanced?.providerTombstones).toEqual(
      expect.arrayContaining([
        {
          generation: '2026-12-01T12:00:00.000Z:tombstone-a',
          providerId: 'provider-a',
        },
        {
          generation: '2026-12-01T12:00:01.000Z:tombstone-b',
          providerId: 'provider-b',
        },
      ]),
    );
  });

  it('rejects a delayed/stale tombstone after a newer re-enable (identity/F10)', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    const original = payload(new Date().toISOString(), 3);
    await writeIdentityProviderLkg({ env, payload: original, secrets: secrets() });

    await expect(
      advanceIdentityProviderLkgAfterTombstone({
        env,
        removedProviderId: 'provider-1',
        secrets: secrets(),
        tombstoneGeneration: '2026-06-01T00:00:00.000Z:tombstone-old',
      }),
    ).resolves.toBe('written');

    // Re-enable with a strictly newer provider generation than the old tombstone.
    const reenabledBase = payload(new Date().toISOString(), 9);
    const reenabledGeneration = '2026-12-01T00:00:00.000Z:9';
    const reenabledProviders = reenabledBase.providers.map((provider) => ({
      ...provider,
      generation: reenabledGeneration,
    }));
    const reenabled = {
      ...reenabledBase,
      generation: reenabledGeneration,
      identityRevision: identityProviderLkgIdentity(reenabledProviders),
      providers: reenabledProviders,
    };
    await expect(
      writeIdentityProviderLkg({ env, payload: reenabled, secrets: secrets() }),
    ).resolves.toBe('written');
    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).resolves.toMatchObject({
      providerTombstones: [],
      providers: [expect.objectContaining({ providerId: 'provider-1', revision: 9 })],
    });

    // Delayed older tombstone must not remove the re-enabled provider.
    await expect(
      advanceIdentityProviderLkgAfterTombstone({
        env,
        removedProviderId: 'provider-1',
        secrets: secrets(),
        tombstoneGeneration: '2026-06-01T00:00:00.000Z:tombstone-old',
      }),
    ).resolves.toEqual({ outcome: 'skipped', reason: 'stale_tombstone' });

    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).resolves.toMatchObject({
      providers: [expect.objectContaining({ providerId: 'provider-1', revision: 9 })],
    });
  });

  it('serializes old/new writes and cannot downgrade after interleaving', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    let enterRename = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enterRename = resolve;
    });
    let releaseRename = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const older = payload(new Date().toISOString(), 3);
    const newer = payload(new Date().toISOString(), 4);
    const oldWrite = writeIdentityProviderLkg({
      env,
      payload: older,
      secrets: secrets(),
      testHooks: {
        beforeRename: async () => {
          enterRename();
          await released;
        },
      },
    });
    await entered;
    const newWrite = writeIdentityProviderLkg({ env, payload: newer, secrets: secrets() });
    releaseRename();

    await expect(oldWrite).resolves.toBe('written');
    await expect(newWrite).resolves.toBe('written');
    await expect(readIdentityProviderLkg({ env, secrets: secrets() })).resolves.toEqual(newer);
    await expect(
      writeIdentityProviderLkg({ env, payload: older, secrets: secrets() }),
    ).resolves.toBe('rejected');
  });

  it('cleans an interrupted unique temporary write without a recoverable lock file', async () => {
    const path = await createPath();
    const env = { PLATFORM_OIDC_LKG_PATH: path };
    await expect(
      writeIdentityProviderLkg({
        env,
        payload: payload(),
        secrets: secrets(),
        testHooks: {
          beforeRename: async () => {
            throw new Error('SIMULATED_PROCESS_INTERRUPTION');
          },
        },
      }),
    ).rejects.toThrow('SIMULATED_PROCESS_INTERRUPTION');

    await expect(
      writeIdentityProviderLkg({ env, payload: payload(), secrets: secrets() }),
    ).resolves.toBe('written');
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
