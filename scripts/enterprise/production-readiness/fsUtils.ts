/**
 * Atomic writes and strongly-owned temp cleanup for production-readiness.
 * Never delete based on basename prefix alone.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TOOL_TEMP_PREFIX = 'm15q06-pr-';
const OWNER_TOKEN_FILE = '.m15q06-owner-token';

export interface ToolOwnedTempHandle {
  absolutePath: string;
  /** Snapshot after creation. */
  dev: number;
  ino: number;
  ownerToken: string;
  parentRealpath: string;
}

export const buildToolTempDirName = (): string =>
  `${TOOL_TEMP_PREFIX}${randomBytes(8).toString('hex')}`;

/**
 * Create a tool-owned directory under parentDir with atomic owner token.
 */
export const createToolOwnedTempDir = async (parentDir: string): Promise<ToolOwnedTempHandle> => {
  const parentRealpath = await realpath(parentDir);
  const absolutePath = path.join(parentRealpath, buildToolTempDirName());
  await mkdir(absolutePath, { recursive: false, mode: 0o700 });
  const ownerToken = randomBytes(32).toString('hex');
  const tokenPath = path.join(absolutePath, OWNER_TOKEN_FILE);
  const handle = await open(tokenPath, 'wx', 0o600);
  try {
    await handle.writeFile(ownerToken, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const st = await lstat(absolutePath);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error('ToolOwnedTempNotDirectory');
  }
  return {
    absolutePath,
    dev: st.dev,
    ino: st.ino,
    ownerToken,
    parentRealpath,
  };
};

export interface CleanupProof {
  /** Optional dev+ino from creation. */
  dev?: number;
  expectedParentRealpath: string;
  ino?: number;
  ownerToken: string;
}

const readOwnerTokenExact = async (dirPath: string, expectedToken: string): Promise<boolean> => {
  const tokenPath = path.join(dirPath, OWNER_TOKEN_FILE);
  let st: Stats;
  try {
    st = await lstat(tokenPath);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || !st.isFile()) return false;
  if (
    (st.mode & 0o777) !== 0o600 &&
    (st.mode & 0o777) !== 0o400 && // Accept 0600/0400 only.
    (st.mode & 0o077) !== 0
  )
    return false;
  const handle = await open(tokenPath, 'r');
  try {
    const buf = Buffer.alloc(expectedToken.length + 8);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    return text === expectedToken;
  } finally {
    await handle.close();
  }
};

/**
 * Strong ownership cleanup. Fail closed → skipped (leave recovery artifact).
 * Never recursive-delete on basename prefix alone.
 */
export const cleanupToolOwnedPath = async (
  absolutePath: string,
  proof?: CleanupProof,
): Promise<'failed' | 'passed' | 'skipped'> => {
  if (!proof) {
    // Without proof, never delete.
    return 'skipped';
  }

  let resolved: string;
  try {
    // realpath fails on dangling; use lstat path resolution carefully.
    const parent = path.dirname(path.resolve(absolutePath));
    const parentReal = await realpath(parent);
    if (parentReal !== proof.expectedParentRealpath) {
      return 'skipped';
    }
    resolved = path.join(parentReal, path.basename(absolutePath));
  } catch {
    return 'skipped';
  }

  // Basename must match tool prefix AND ownership token must verify.
  if (!path.basename(resolved).startsWith(TOOL_TEMP_PREFIX)) {
    return 'skipped';
  }

  let st: Stats;
  try {
    st = await lstat(resolved);
  } catch {
    return 'passed'; // already gone
  }

  if (st.isSymbolicLink()) {
    return 'skipped';
  }
  if (!st.isDirectory()) {
    return 'skipped';
  }
  if (
    proof.dev !== undefined &&
    proof.ino !== undefined &&
    (st.dev !== proof.dev || st.ino !== proof.ino)
  ) {
    return 'skipped'; // replaced
  }

  const tokenOk = await readOwnerTokenExact(resolved, proof.ownerToken);
  if (!tokenOk) {
    return 'skipped';
  }

  try {
    await rm(resolved, { force: true, recursive: true });
    try {
      await lstat(resolved);
      return 'failed';
    } catch {
      return 'passed';
    }
  } catch {
    return 'failed';
  }
};

export const writeJsonAtomic = async (
  filePath: string,
  value: unknown,
): Promise<{ byteLength: number; sha256: string }> => {
  const absolute = path.resolve(filePath);
  const directory = path.dirname(absolute);
  await mkdir(directory, { recursive: true });

  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const tempPath = path.join(
    directory,
    `.${path.basename(absolute)}.${randomBytes(6).toString('hex')}.tmp`,
  );

  try {
    await writeFile(tempPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(tempPath, absolute);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return { byteLength: Buffer.byteLength(serialized, 'utf8'), sha256 };
};

export const readFileSha256 = async (filePath: string): Promise<string> => {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
};

/** @deprecated Prefer createToolOwnedTempDir + cleanup with proof. */
export const isToolOwnedTempPath = (absolutePath: string): boolean =>
  path.basename(absolutePath).startsWith(TOOL_TEMP_PREFIX);

export const buildToolTempDir = (parentDir: string): string =>
  path.join(parentDir, buildToolTempDirName());
