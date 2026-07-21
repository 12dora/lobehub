/**
 * Safe repository-relative path resolution for leakage roots and report paths.
 * Rejects absolute paths, parent traversal, and escapes outside the repo root.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** Repo-relative path for reports/artifacts (no absolute, no `..`). */
export const REPO_RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w.@/-]+$/u;

export type SafeRootResult = { absolute: string; relative: string } | { error: string };

/**
 * Validate a configured scan root is a safe repo-relative path (sync checks only).
 */
export const validateRepoRelativeRoot = (relativeRoot: string): string | undefined => {
  if (typeof relativeRoot !== 'string' || relativeRoot.length === 0) {
    return 'empty-root';
  }
  if (relativeRoot.includes('\0')) return 'null-byte-root';
  // Normalize separators for validation only.
  const normalized = relativeRoot.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(relativeRoot)) {
    return 'absolute-root';
  }
  if (normalized.startsWith('//') || /^[a-zA-Z]:\//u.test(normalized)) {
    return 'absolute-root';
  }
  if (normalized === '.' || normalized === './') return 'dot-root';
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return 'empty-root';
  for (const segment of segments) {
    if (segment === '..') return 'parent-traversal';
    if (segment === '.') return 'dot-segment';
  }
  if (!REPO_RELATIVE_PATH_PATTERN.test(normalized)) {
    return 'unsafe-root-charset';
  }
  return undefined;
};

/**
 * Resolve root under repoRoot; fail if realpath escapes the repository.
 */
export const resolveSafeRepoRoot = async (
  repoRoot: string,
  relativeRoot: string,
): Promise<SafeRootResult> => {
  const validationError = validateRepoRelativeRoot(relativeRoot);
  if (validationError) return { error: validationError };

  const normalizedRelative = relativeRoot.replaceAll('\\', '/');
  let repoReal: string;
  try {
    repoReal = await realpath(repoRoot);
  } catch {
    return { error: 'repo-root-unreadable' };
  }

  const candidate = path.resolve(repoReal, normalizedRelative);
  // Sync containment before realpath (handles missing path via resolve only).
  if (!isPathInside(candidate, repoReal)) {
    return { error: 'root-escapes-repo' };
  }

  // If path exists, realpath and re-check (symlink escape).
  try {
    const real = await realpath(candidate);
    if (!isPathInside(real, repoReal)) {
      return { error: 'root-escapes-repo' };
    }
    return { absolute: real, relative: normalizedRelative };
  } catch {
    // Missing path is handled by caller as rootsMissing after validation.
    return { absolute: candidate, relative: normalizedRelative };
  }
};

export const isPathInside = (absolutePath: string, rootAbsolute: string): boolean => {
  const root = rootAbsolute.endsWith(path.sep) ? rootAbsolute : `${rootAbsolute}${path.sep}`;
  return absolutePath === rootAbsolute || absolutePath.startsWith(root);
};
