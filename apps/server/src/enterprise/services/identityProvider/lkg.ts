import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import pathModule from 'node:path';

import { checksumPayload } from '@/database/models/platform';

import type { PlatformSecretService } from '../../security/secret';

const LKG_DOMAIN = 'platform-oidc-lkg';
const LKG_FORMAT = 'aihub.platform.oidc-lkg';
const LKG_VERSION = 1;
const DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_REMOTE_STALE_LOCK_MS = 5 * 60_000;
const EMPTY_GENERATION = '0000-01-01T00:00:00.000Z:';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LOCK_BYTES = 4096;

export interface IdentityProviderLkgProvider {
  checksum: string;
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

interface LkgLockRecord {
  createdAt: string;
  generation: string;
  host: string;
  nonce: string;
  pid: number;
  version: typeof LKG_VERSION;
}

interface AcquiredLock {
  handle: OpenHandle;
  record: LkgLockRecord;
  stat: FileStat;
}

export interface IdentityProviderLkgTestHooks {
  afterFileStat?: (path: string) => Promise<void>;
  beforeLockRelease?: (path: string) => Promise<void>;
}

type OpenHandle = Awaited<ReturnType<typeof open>>;
type FileStat = Awaited<ReturnType<OpenHandle['stat']>>;

export type IdentityProviderLkgWriteResult =
  'busy' | 'cleanup_failed' | 'rejected' | 'unchanged' | 'written';

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
    'checksum' | 'payload' | 'providerId' | 'revision' | 'secretFingerprint'
  >[],
): string =>
  checksumPayload(
    providers
      .map((provider) => ({
        checksum: provider.checksum,
        providerId: provider.providerId,
        providerKey: provider.payload.providerKey,
        revision: provider.revision,
        secretFingerprint: provider.secretFingerprint,
      }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId)),
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

const assertSecureFile = (stat: FileStat, maximum = MAX_FILE_BYTES): void => {
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
  if (Number(stat.size) <= 0 || Number(stat.size) > maximum) {
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

const readBoundedHandle = async (
  handle: OpenHandle,
  maximum = MAX_FILE_BYTES,
  afterStat?: () => Promise<void>,
) => {
  const before = await handle.stat();
  assertSecureFile(before, maximum);
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
  return { raw: buffer.subarray(0, expected).toString('utf8'), stat: after };
};

const openAndReadSecure = async (
  path: string,
  maximum = MAX_FILE_BYTES,
  afterStat?: (path: string) => Promise<void>,
) => {
  const handle = await open(
    /* turbopackIgnore: true */ path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    return await readBoundedHandle(handle, maximum, () => afterStat?.(path) ?? Promise.resolve());
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
    Object.keys(row).length !== 6 ||
    typeof row.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.checksum) ||
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
    identityProviderLkgIdentity(providers) !== payload.identityRevision
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_IDENTITY_INVALID');
  }
  return { ...payload, providers } as unknown as IdentityProviderLkgPayload;
};

const parseLock = (value: unknown): LkgLockRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderLkgError('OIDC_LKG_LOCK_INVALID');
  }
  const lock = value as Record<string, unknown>;
  if (
    Object.keys(lock).length !== 6 ||
    lock.version !== LKG_VERSION ||
    typeof lock.createdAt !== 'string' ||
    Number.isNaN(new Date(lock.createdAt).getTime()) ||
    typeof lock.generation !== 'string' ||
    typeof lock.host !== 'string' ||
    lock.host.length === 0 ||
    typeof lock.nonce !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(lock.nonce) ||
    !Number.isInteger(lock.pid) ||
    Number(lock.pid) <= 0
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_LOCK_INVALID');
  }
  return lock as unknown as LkgLockRecord;
};

const maxAgeMs = (env: Record<string, string | undefined>): number => {
  const raw = Number(env.PLATFORM_OIDC_LKG_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365 * 24 * 60 * 60) : 0;
  return seconds * 1000;
};

const lockAgeMs = (env: Record<string, string | undefined>, remote: boolean): number => {
  const fallback = remote ? DEFAULT_REMOTE_STALE_LOCK_MS : DEFAULT_STALE_LOCK_MS;
  const key = remote ? 'PLATFORM_OIDC_LKG_REMOTE_STALE_LOCK_MS' : 'PLATFORM_OIDC_LKG_STALE_LOCK_MS';
  const raw = Number(env[key] ?? fallback);
  return Number.isFinite(raw) && raw >= 1000 ? Math.min(raw, 24 * 60 * 60_000) : fallback;
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

const canTakeOverLock = (lock: LkgLockRecord, env: Record<string, string | undefined>): boolean => {
  const age = Date.now() - new Date(lock.createdAt).getTime();
  if (age < 0) return false;
  if (lock.host === hostname()) {
    return age >= lockAgeMs(env, false) && !processExists(lock.pid);
  }
  return age >= lockAgeMs(env, true);
};

const removeStaleLock = async (
  lockPath: string,
  observed: { lock: LkgLockRecord; stat: FileStat },
): Promise<boolean> => {
  const current = await openAndReadSecure(lockPath, MAX_LOCK_BYTES);
  const lock = parseLock(JSON.parse(current.raw));
  if (lock.nonce !== observed.lock.nonce || !sameFile(current.stat, observed.stat)) return false;
  await unlink(lockPath);
  return true;
};

const acquireLock = async (input: {
  env: Record<string, string | undefined>;
  generation: string;
  lockPath: string;
}): Promise<AcquiredLock | null> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created: OpenHandle | null = null;
    try {
      created = await open(
        input.lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const record: LkgLockRecord = {
        createdAt: new Date().toISOString(),
        generation: input.generation,
        host: hostname(),
        nonce: randomUUID(),
        pid: process.pid,
        version: LKG_VERSION,
      };
      await created.writeFile(JSON.stringify(record), { encoding: 'utf8' });
      await created.sync();
      const stat = await created.stat();
      assertSecureFile(stat, MAX_LOCK_BYTES);
      return { handle: created, record, stat };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await created?.close().catch(() => undefined);
        if (created) await removeIfPresent(input.lockPath);
        throw error;
      }
      const observed = await openAndReadSecure(input.lockPath, MAX_LOCK_BYTES);
      const lock = parseLock(JSON.parse(observed.raw));
      if (!canTakeOverLock(lock, input.env)) return null;
      if (!(await removeStaleLock(input.lockPath, { lock, stat: observed.stat }))) return null;
    }
  }
  return null;
};

const releaseOwnedLock = async (lockPath: string, owned: AcquiredLock): Promise<boolean> => {
  let closeSucceeded = true;
  try {
    await owned.handle.close();
  } catch {
    closeSucceeded = false;
  }
  try {
    const current = await openAndReadSecure(lockPath, MAX_LOCK_BYTES);
    const record = parseLock(JSON.parse(current.raw));
    if (record.nonce !== owned.record.nonce || !sameFile(current.stat, owned.stat)) return false;
    await unlink(lockPath);
    return closeSucceeded;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return false;
  }
};

const decodePayload = async (input: {
  enforceAge: boolean;
  env: Record<string, string | undefined>;
  path: string;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgPayload> => {
  const { raw } = await openAndReadSecure(
    input.path,
    MAX_FILE_BYTES,
    input.testHooks?.afterFileStat,
  );
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
        next.secretFingerprint !== existing.secretFingerprint
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

const removeIfPresent = async (path: string): Promise<boolean> => {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
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
  const directory = pathModule.dirname(path);
  await assertSecureDirectory(directory, true);
  const lockPath = `${path}.lock`;
  const lock = await acquireLock({ env: input.env, generation: payload.generation, lockPath });
  if (!lock) return 'busy';

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let result: IdentityProviderLkgWriteResult = 'written';
  let failure: unknown;
  let temporaryCreated = false;
  try {
    await ensureExistingTargetIsSecure(path);
    try {
      const current = await decodePayload({
        enforceAge: false,
        env: input.env,
        path,
        secrets: input.secrets,
      });
      const comparison = compareSnapshots(current, payload);
      if (comparison === 'unchanged' || comparison === 'rejected') {
        result = comparison;
      }
      if (comparison !== 'upgrade') {
        // Unchanged/rejected snapshots only need the lock-protected comparison.
        // The cleanup below still has to run and report failures.
        throw new IdentityProviderLkgError('OIDC_LKG_WRITE_SKIPPED');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

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
    await rename(temporaryPath, path);
    temporaryCreated = false;
    await openAndReadSecure(path);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (error instanceof IdentityProviderLkgError && error.code === 'OIDC_LKG_WRITE_SKIPPED') {
      // Preserve the comparison result while sharing the cleanup path.
    } else {
      failure = error;
    }
  } finally {
    let cleanupFailed = false;
    try {
      await input.testHooks?.beforeLockRelease?.(lockPath);
    } catch {
      cleanupFailed = true;
    }
    if (!(await releaseOwnedLock(lockPath, lock))) cleanupFailed = true;
    if (temporaryCreated && !(await removeIfPresent(temporaryPath))) cleanupFailed = true;
    if (!failure && cleanupFailed) result = 'cleanup_failed';
  }
  if (failure) throw failure;
  return result;
};
