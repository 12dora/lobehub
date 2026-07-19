import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import pathModule from 'node:path';

import { checksumPayload } from '@/database/models/platform';

import type { PlatformSecretService } from '../../security/secret';

const LKG_DOMAIN = 'platform-oidc-lkg';
const LKG_FORMAT = 'aihub.platform.oidc-lkg';
const LKG_VERSION = 1;
const DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const EMPTY_GENERATION = '0000-01-01T00:00:00.000Z:';
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface IdentityProviderLkgProvider {
  checksum: string;
  generation: string;
  payload: Record<string, unknown>;
  providerId: string;
  revision: number;
  secretCiphertext: string;
  secretFingerprint: string;
}

export interface IdentityProviderLkgPayload {
  createdAt: string;
  domain: typeof LKG_DOMAIN;
  generation: string;
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

export interface IdentityProviderLkgTestHooks {
  afterFileStat?: (path: string) => Promise<void>;
  beforeRename?: (path: string) => Promise<void>;
}

type OpenHandle = Awaited<ReturnType<typeof open>>;
type FileStat = Awaited<ReturnType<OpenHandle['stat']>>;

export type IdentityProviderLkgWriteResult = 'rejected' | 'unchanged' | 'written';

export class IdentityProviderLkgError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'IdentityProviderLkgError';
  }
}

export const emptyIdentityProviderLkgGeneration = EMPTY_GENERATION;

export const identityProviderLkgIdentity = (
  providers: Pick<
    IdentityProviderLkgProvider,
    'checksum' | 'generation' | 'payload' | 'providerId' | 'revision' | 'secretFingerprint'
  >[],
): string =>
  checksumPayload(
    providers
      .map((provider) => ({
        checksum: provider.checksum,
        generation: provider.generation,
        providerId: provider.providerId,
        providerKey: provider.payload.providerKey,
        revision: provider.revision,
        secretFingerprint: provider.secretFingerprint,
      }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId)),
  );

export const identityProviderLkgGeneration = (
  providers: Pick<IdentityProviderLkgProvider, 'generation'>[],
): string =>
  providers.reduce(
    (latest, provider) => (provider.generation > latest ? provider.generation : latest),
    EMPTY_GENERATION,
  );

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
  if ((Number(stat.mode) & 0o777) !== 0o700) {
    throw new IdentityProviderLkgError('OIDC_LKG_DIRECTORY_PERMISSIONS_INVALID');
  }
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) {
    throw new IdentityProviderLkgError('OIDC_LKG_DIRECTORY_OWNER_INVALID');
  }
};

const assertSecureFile = (stat: FileStat): void => {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_INVALID');
  }
  if (Number(stat.nlink) !== 1) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_LINK_INVALID');
  }
  if ((Number(stat.mode) & 0o777) !== 0o600) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_PERMISSIONS_INVALID');
  }
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_OWNER_INVALID');
  }
  if (Number(stat.size) <= 0 || Number(stat.size) > MAX_FILE_BYTES) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_SIZE_INVALID');
  }
};

const sameFile = (before: FileStat, after: FileStat): boolean =>
  Number(before.dev) === Number(after.dev) &&
  Number(before.ino) === Number(after.ino) &&
  Number(before.mode) === Number(after.mode) &&
  Number(before.nlink) === Number(after.nlink) &&
  Number(before.size) === Number(after.size) &&
  Number(before.uid) === Number(after.uid);

const readBoundedHandle = async (handle: OpenHandle, afterStat?: () => Promise<void>) => {
  const before = await handle.stat();
  assertSecureFile(before);
  await afterStat?.();
  const expected = Number(before.size);
  const buffer = Buffer.alloc(expected + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await handle.stat();
  if (offset !== expected || !sameFile(before, after)) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_CHANGED_DURING_READ');
  }
  return buffer.subarray(0, expected).toString('utf8');
};

const openAndReadSecure = async (path: string, afterStat?: (path: string) => Promise<void>) => {
  const handle = await open(
    /* turbopackIgnore: true */ path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    return await readBoundedHandle(handle, () => afterStat?.(path) ?? Promise.resolve());
  } finally {
    await handle.close();
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

const parseProvider = (value: unknown): IdentityProviderLkgProvider => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderLkgError('OIDC_LKG_PROVIDER_INVALID');
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 7 ||
    typeof row.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.checksum) ||
    typeof row.generation !== 'string' ||
    row.generation.length === 0 ||
    row.generation.length > 512 ||
    !row.payload ||
    typeof row.payload !== 'object' ||
    Array.isArray(row.payload) ||
    typeof row.providerId !== 'string' ||
    row.providerId.length === 0 ||
    row.providerId.length > 255 ||
    !Number.isInteger(row.revision) ||
    Number(row.revision) <= 0 ||
    typeof row.secretCiphertext !== 'string' ||
    !row.secretCiphertext.startsWith('aihub.secret.v1.') ||
    typeof row.secretFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.secretFingerprint) ||
    checksumPayload(row.payload) !== row.checksum ||
    (row.payload as Record<string, unknown>).secretFingerprint !== row.secretFingerprint
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_PROVIDER_INVALID');
  }
  return row as unknown as IdentityProviderLkgProvider;
};

const parsePayload = (value: unknown): IdentityProviderLkgPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderLkgError('OIDC_LKG_PAYLOAD_INVALID');
  }
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).length !== 6 ||
    payload.domain !== LKG_DOMAIN ||
    payload.version !== LKG_VERSION ||
    typeof payload.createdAt !== 'string' ||
    Number.isNaN(new Date(payload.createdAt).getTime()) ||
    typeof payload.generation !== 'string' ||
    payload.generation.length === 0 ||
    payload.generation.length > 512 ||
    typeof payload.identityRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.identityRevision) ||
    !Array.isArray(payload.providers) ||
    payload.providers.length > 100
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_PAYLOAD_INVALID');
  }
  const providers = payload.providers.map(parseProvider);
  if (
    new Set(providers.map((provider) => provider.providerId)).size !== providers.length ||
    identityProviderLkgIdentity(providers) !== payload.identityRevision ||
    identityProviderLkgGeneration(providers) !== payload.generation
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_IDENTITY_INVALID');
  }
  return { ...payload, providers } as unknown as IdentityProviderLkgPayload;
};

const maxAgeMs = (env: Record<string, string | undefined>): number => {
  const raw = Number(env.PLATFORM_OIDC_LKG_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365 * 24 * 60 * 60) : 0;
  return seconds * 1000;
};

const decodePayload = async (input: {
  enforceAge: boolean;
  env: Record<string, string | undefined>;
  path: string;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgPayload> => {
  const raw = await openAndReadSecure(input.path, input.testHooks?.afterFileStat);
  const envelope = parseEnvelope(JSON.parse(raw));
  if (!(await input.secrets.verifyArtifact(LKG_DOMAIN, envelope.ciphertext, envelope.signature))) {
    throw new IdentityProviderLkgError('OIDC_LKG_SIGNATURE_INVALID');
  }
  const payload = parsePayload(JSON.parse(await input.secrets.decrypt(envelope.ciphertext)));
  if (input.enforceAge) {
    const age = Date.now() - new Date(payload.createdAt).getTime();
    if (age < 0 || age > maxAgeMs(input.env)) {
      throw new IdentityProviderLkgError('OIDC_LKG_STALE');
    }
  }
  return payload;
};

export const readIdentityProviderLkg = async (input: {
  env: Record<string, string | undefined>;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgPayload | null> => {
  const path = resolveLkgPath(input.env);
  try {
    await assertSecureDirectory(pathModule.dirname(path), false);
    return await decodePayload({ ...input, enforceAge: true, path });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const compareSnapshots = (
  current: IdentityProviderLkgPayload,
  candidate: IdentityProviderLkgPayload,
): 'rejected' | 'unchanged' | 'upgrade' => {
  if (current.identityRevision === candidate.identityRevision) return 'unchanged';
  if (candidate.generation <= current.generation) return 'rejected';
  const candidateById = new Map(
    candidate.providers.map((provider) => [provider.providerId, provider]),
  );
  let upgraded = false;
  for (const existing of current.providers) {
    const next = candidateById.get(existing.providerId);
    if (!next || next.revision < existing.revision) return 'rejected';
    if (next.revision === existing.revision) {
      if (
        next.checksum !== existing.checksum ||
        next.secretFingerprint !== existing.secretFingerprint ||
        next.generation !== existing.generation
      ) {
        return 'rejected';
      }
    } else {
      upgraded = true;
    }
  }
  if (candidate.providers.length > current.providers.length) upgraded = true;
  return upgraded ? 'upgrade' : 'rejected';
};

const ensureExistingTargetIsSecure = async (path: string): Promise<void> => {
  try {
    await openAndReadSecure(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new IdentityProviderLkgError('OIDC_LKG_TARGET_SYMLINK_FORBIDDEN');
    }
    throw error;
  }
};

const removeIfPresent = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const writeQueues = new Map<string, Promise<void>>();

const withProcessWriteLock = async <T>(path: string, work: () => Promise<T>): Promise<T> => {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  writeQueues.set(path, queued);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (writeQueues.get(path) === queued) writeQueues.delete(path);
  }
};

export const writeIdentityProviderLkg = async (input: {
  env: Record<string, string | undefined>;
  payload: IdentityProviderLkgPayload;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgWriteResult> => {
  const payload = parsePayload(input.payload);
  const path = resolveLkgPath(input.env);
  return withProcessWriteLock(path, async () => {
    const directory = pathModule.dirname(path);
    await assertSecureDirectory(directory, true);
    await ensureExistingTargetIsSecure(path);
    try {
      const current = await decodePayload({
        enforceAge: false,
        env: input.env,
        path,
        secrets: input.secrets,
      });
      const comparison = compareSnapshots(current, payload);
      if (comparison !== 'upgrade') return comparison;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let temporaryCreated = false;
    try {
      const plaintext = JSON.stringify(payload);
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
      temporaryCreated = true;
      try {
        await temporary.writeFile(JSON.stringify(envelope), { encoding: 'utf8' });
        await temporary.sync();
        assertSecureFile(await temporary.stat());
      } finally {
        await temporary.close();
      }
      await input.testHooks?.beforeRename?.(temporaryPath);
      await rename(temporaryPath, path);
      temporaryCreated = false;
      await openAndReadSecure(path);
      const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return 'written';
    } finally {
      if (temporaryCreated) await removeIfPresent(temporaryPath);
    }
  });
};
