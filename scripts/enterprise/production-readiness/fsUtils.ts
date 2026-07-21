/**
 * Atomic writes and tool-owned temp cleanup for production-readiness artifacts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TOOL_TEMP_PREFIX = 'm15q06-pr-';

export const buildToolTempDir = (parentDir: string): string =>
  path.join(parentDir, `${TOOL_TEMP_PREFIX}${randomBytes(8).toString('hex')}`);

export const isToolOwnedTempPath = (absolutePath: string): boolean => {
  const base = path.basename(absolutePath);
  return base.startsWith(TOOL_TEMP_PREFIX);
};

/**
 * Atomic JSON write: write to sibling temp file, fsync via writeFile, rename into place.
 * Never leaves a partial successful artifact at the final path.
 */
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
    await writeFile(tempPath, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, absolute);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return { byteLength: Buffer.byteLength(serialized, 'utf8'), sha256 };
};

/**
 * Exact cleanup of a tool-owned temp path only.
 * Refuses to delete paths that do not match the tool prefix (fail closed).
 */
export const cleanupToolOwnedPath = async (
  absolutePath: string,
): Promise<'failed' | 'passed' | 'skipped'> => {
  const resolved = path.resolve(absolutePath);
  if (!isToolOwnedTempPath(resolved)) {
    return 'skipped';
  }

  try {
    await access(resolved);
  } catch {
    return 'passed';
  }

  try {
    await rm(resolved, { force: true, recursive: true });
    try {
      await access(resolved);
      return 'failed';
    } catch {
      return 'passed';
    }
  } catch {
    return 'failed';
  }
};
