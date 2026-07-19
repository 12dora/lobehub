import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import pathModule from 'node:path';

import type { PlatformSecretService } from '../../security/secret';

const LKG_DOMAIN = 'platform-oidc-lkg';
const LKG_FORMAT = 'aihub.platform.oidc-lkg';
const LKG_VERSION = 1;
const DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface IdentityProviderLkgProvider {
  payload: Record<string, unknown>;
  revision: number;
  secretCiphertext: string;
}

export interface IdentityProviderLkgPayload {
  createdAt: string;
  domain: typeof LKG_DOMAIN;
  identityRevision: string;
  providers: IdentityProviderLkgProvider[];
  version: typeof LKG_VERSION;
}

interface IdentityProviderLkgEnvelope {
  ciphertext: string;
  format: typeof LKG_FORMAT;
  signature: string;
  version: typeof LKG_VERSION;
}

export class IdentityProviderLkgError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'IdentityProviderLkgError';
  }
}

const resolveLkgPath = (env: Record<string, string | undefined>): string => {
  const configured = env.PLATFORM_OIDC_LKG_PATH?.trim();
  if (!configured) return pathModule.join(process.cwd(), '.lobe', 'platform-oidc-lkg.v1.json');
  if (!pathModule.isAbsolute(configured) || pathModule.normalize(configured) !== configured) {
    throw new IdentityProviderLkgError('OIDC_LKG_PATH_INVALID');
  }
  return configured;
};

const assertSecureDirectory = async (directory: string, create: boolean): Promise<void> => {
  if (create) await mkdir(directory, { mode: 0o700, recursive: true });
  const canonical = await realpath(directory);
  if (canonical !== pathModule.normalize(directory)) {
    throw new IdentityProviderLkgError('OIDC_LKG_DIRECTORY_SYMLINK_FORBIDDEN');
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new IdentityProviderLkgError('OIDC_LKG_DIRECTORY_INVALID');
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    throw new IdentityProviderLkgError('OIDC_LKG_DIRECTORY_PERMISSIONS_INVALID');
  }
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) {
    throw new IdentityProviderLkgError('OIDC_LKG_DIRECTORY_OWNER_INVALID');
  }
};

const assertSecureFile = (stat: Awaited<ReturnType<typeof lstat>>): void => {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_INVALID');
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_PERMISSIONS_INVALID');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_OWNER_INVALID');
  }
  if (stat.size <= 0 || stat.size > MAX_FILE_BYTES) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_SIZE_INVALID');
  }
};

const parseEnvelope = (value: unknown): IdentityProviderLkgEnvelope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderLkgError('OIDC_LKG_ENVELOPE_INVALID');
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 4 ||
    envelope.format !== LKG_FORMAT ||
    envelope.version !== LKG_VERSION ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.signature !== 'string'
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_ENVELOPE_INVALID');
  }
  return envelope as unknown as IdentityProviderLkgEnvelope;
};

const parsePayload = (value: unknown): IdentityProviderLkgPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderLkgError('OIDC_LKG_PAYLOAD_INVALID');
  }
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).length !== 5 ||
    payload.domain !== LKG_DOMAIN ||
    payload.version !== LKG_VERSION ||
    typeof payload.createdAt !== 'string' ||
    Number.isNaN(new Date(payload.createdAt).getTime()) ||
    typeof payload.identityRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.identityRevision) ||
    !Array.isArray(payload.providers) ||
    payload.providers.length > 100
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_PAYLOAD_INVALID');
  }
  for (const provider of payload.providers) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      throw new IdentityProviderLkgError('OIDC_LKG_PROVIDER_INVALID');
    }
    const row = provider as Record<string, unknown>;
    if (
      Object.keys(row).length !== 3 ||
      !row.payload ||
      typeof row.payload !== 'object' ||
      Array.isArray(row.payload) ||
      !Number.isInteger(row.revision) ||
      Number(row.revision) <= 0 ||
      typeof row.secretCiphertext !== 'string' ||
      !row.secretCiphertext.startsWith('aihub.secret.v1.')
    ) {
      throw new IdentityProviderLkgError('OIDC_LKG_PROVIDER_INVALID');
    }
  }
  return payload as unknown as IdentityProviderLkgPayload;
};

const maxAgeMs = (env: Record<string, string | undefined>): number => {
  const raw = Number(env.PLATFORM_OIDC_LKG_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365 * 24 * 60 * 60) : 0;
  return seconds * 1000;
};

export const readIdentityProviderLkg = async (input: {
  env: Record<string, string | undefined>;
  secrets: PlatformSecretService;
}): Promise<IdentityProviderLkgPayload | null> => {
  const path = resolveLkgPath(input.env);
  const directory = pathModule.dirname(path);
  try {
    await assertSecureDirectory(directory, false);
    const handle = await open(
      /* turbopackIgnore: true */ path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let raw: string;
    try {
      assertSecureFile(await handle.stat());
      raw = await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }
    const envelope = parseEnvelope(JSON.parse(raw));
    if (
      !(await input.secrets.verifyArtifact(LKG_DOMAIN, envelope.ciphertext, envelope.signature))
    ) {
      throw new IdentityProviderLkgError('OIDC_LKG_SIGNATURE_INVALID');
    }
    const payload = parsePayload(JSON.parse(await input.secrets.decrypt(envelope.ciphertext)));
    const age = Date.now() - new Date(payload.createdAt).getTime();
    if (age < 0 || age > maxAgeMs(input.env)) {
      throw new IdentityProviderLkgError('OIDC_LKG_STALE');
    }
    return payload;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

export const writeIdentityProviderLkg = async (input: {
  env: Record<string, string | undefined>;
  payload: IdentityProviderLkgPayload;
  secrets: PlatformSecretService;
}): Promise<'busy' | 'written'> => {
  const path = resolveLkgPath(input.env);
  const directory = pathModule.dirname(path);
  await assertSecureDirectory(directory, true);
  const lockPath = `${path}.lock`;
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'busy';
    throw error;
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const plaintext = JSON.stringify(input.payload);
    const ciphertext = await input.secrets.encrypt(plaintext);
    const envelope: IdentityProviderLkgEnvelope = {
      ciphertext,
      format: LKG_FORMAT,
      signature: await input.secrets.signArtifact(LKG_DOMAIN, ciphertext),
      version: LKG_VERSION,
    };
    const temporary = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await temporary.writeFile(JSON.stringify(envelope), { encoding: 'utf8' });
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      const target = await lstat(path);
      if (target.isSymbolicLink()) {
        throw new IdentityProviderLkgError('OIDC_LKG_TARGET_SYMLINK_FORBIDDEN');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return 'written';
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
};
