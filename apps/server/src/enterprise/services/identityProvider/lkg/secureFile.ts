import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import pathModule from 'node:path';

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface IdentityProviderLkgTestHooks {
  afterFileStat?: (path: string) => Promise<void>;
  beforeRename?: (path: string) => Promise<void>;
}

type OpenHandle = Awaited<ReturnType<typeof open>>;
type FileStat = Awaited<ReturnType<OpenHandle['stat']>>;

export class IdentityProviderLkgError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'IdentityProviderLkgError';
  }
}

export const assertSecureDirectory = async (directory: string, create: boolean): Promise<void> => {
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

export const openAndReadSecure = async (
  path: string,
  afterStat?: (path: string) => Promise<void>,
) => {
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

export const ensureExistingTargetIsSecure = async (path: string): Promise<void> => {
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

/**
 * Process-local write serialization for LKG paths.
 *
 * ACCEPTABLE for the single-instance demo: overlapping Disable/LKG advances in the
 * same Node process queue through `writeQueues` so read→merge→rename cannot interleave.
 *
 * DEFERRED LIMITATION (multi-instance): there is no cross-process filesystem lock or
 * persisted-generation CAS. Concurrent Disable from separate processes/replicas can
 * still race on the LKG file. Documented as identity/F10 single-instance scope; do not
 * treat the overlap unit test as multi-process proof.
 */
const writeQueues = new Map<string, Promise<void>>();

export const withProcessWriteLock = async <T>(path: string, work: () => Promise<T>): Promise<T> => {
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

export const writeSecureFileAtomically = async (input: {
  contents: string;
  path: string;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<void> => {
  const directory = pathModule.dirname(input.path);
  const temporaryPath = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const temporary = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    try {
      await temporary.writeFile(input.contents, { encoding: 'utf8' });
      await temporary.sync();
      assertSecureFile(await temporary.stat());
    } finally {
      await temporary.close();
    }
    await input.testHooks?.beforeRename?.(temporaryPath);
    await rename(temporaryPath, input.path);
    temporaryCreated = false;
    await openAndReadSecure(input.path);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryCreated) await removeIfPresent(temporaryPath);
  }
};
