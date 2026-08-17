import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const assertRegularOwnedDirectory = async (path: string): Promise<void> => {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    throw new Error('network proxy data directory must not be a symlink');
  }
  if (!stat.isDirectory()) {
    throw new Error('network proxy path is not a directory');
  }
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) {
    throw new Error('network proxy directory owner is invalid');
  }
  if ((Number(stat.mode) & 0o777) !== 0o700) {
    await chmod(path, 0o700);
    const after = await lstat(path);
    if (after.isSymbolicLink() || !after.isDirectory()) {
      throw new Error('network proxy directory became invalid during chmod');
    }
  }
};

/**
 * Walk every component from `root` down to `dir`. `lstat` runs before any `chmod`.
 * Symlinked ancestors inside `root` are rejected. Missing components may be created 0700.
 */
export const ensureSecureDirectory = async (
  dir: string,
  options: { create?: boolean; root: string },
): Promise<void> => {
  const root = path.resolve(options.root);
  const target = path.resolve(dir);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || rel.startsWith(`..${path.sep}`)) {
    throw new Error('network proxy path escapes the data directory');
  }

  const parts = rel === '' ? [] : rel.split(path.sep).filter(Boolean);
  let current = root;
  const create = options.create === true;

  const ensureOne = async (path: string): Promise<void> => {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(path, { mode: 0o700 });
    }
    await assertRegularOwnedDirectory(path);
  };

  await ensureOne(current);
  for (const part of parts) {
    current = path.join(current, part);
    await ensureOne(current);
  }
};

export const removeIfPresent = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

export const assertSameFilesystem = async (left: string, right: string): Promise<void> => {
  const [a, b] = await Promise.all([lstat(left), lstat(right)]);
  if (Number(a.dev) !== Number(b.dev)) {
    throw new Error('network proxy temp file is not on the same filesystem as the destination');
  }
};

/**
 * Cross-process exclusive lock via `O_CREAT|O_EXCL`. A lock whose pid is dead is stolen.
 */
export const withInstallLock = async <T>(
  lockPath: string,
  work: () => Promise<T>,
  root: string,
): Promise<T> => {
  await ensureSecureDirectory(path.dirname(lockPath), { create: true, root });
  const deadline = Date.now() + 120_000;

  while (true) {
    try {
      const handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(String(process.pid), { encoding: 'utf8' });
      } finally {
        await handle.close();
      }
      try {
        return await work();
      } finally {
        await removeIfPresent(lockPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error('network proxy install lock timed out', { cause: error });
      }
      const raw = await readFile(lockPath, 'utf8').catch(() => '');
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && !isPidAlive(pid)) {
        await removeIfPresent(lockPath);
        continue;
      }
      await sleep(50);
    }
  }
};

/** Atomic write: O_CREAT|O_EXCL|O_NOFOLLOW temp → fsync → same-fs rename → chmod. */
export const writeFileAtomically = async (input: {
  contents: Buffer | string;
  mode: number;
  path: string;
  root: string;
}): Promise<void> => {
  const directory = path.dirname(input.path);
  await ensureSecureDirectory(directory, { create: true, root: input.root });
  const temporaryPath = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(input.contents);
      await handle.sync();
      await handle.chmod(input.mode);
    } finally {
      await handle.close();
    }
    await assertSameFilesystem(directory, temporaryPath);
    await rename(temporaryPath, input.path);
    created = false;
    const after = await lstat(input.path);
    if (after.isSymbolicLink() || !after.isFile()) {
      throw new Error('network proxy destination is not a regular file after rename');
    }
    await chmod(input.path, input.mode);
  } finally {
    if (created) await removeIfPresent(temporaryPath);
  }
};
