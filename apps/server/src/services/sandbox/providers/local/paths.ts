import path from 'node:path';

import { SANDBOX_WORKSPACE } from './constants';

const NUL = '\0';

/**
 * Resolve a user-supplied path under `/mnt/data`. Relative paths are rooted at
 * the workspace. Absolute paths must already live under it. `..` is normalised
 * before the prefix check so `/mnt/data/../etc/passwd` is rejected.
 *
 * This is the Node-side jail. Symlinks are resolved inside the container
 * (python `os.path.realpath`) before the same prefix check.
 */
export const resolveSandboxPath = (
  input: string | undefined,
  workspace = SANDBOX_WORKSPACE,
): string => {
  if (typeof input === 'string' && input.includes(NUL)) {
    throw new Error('path escapes sandbox workspace: path contains NUL');
  }

  const raw = (input ?? '').trim() || '.';
  const absolute = raw.startsWith('/') ? raw : path.posix.join(workspace, raw);
  const normalized = path.posix.normalize(absolute);

  if (!isInsideWorkspace(normalized, workspace)) {
    throw new Error(`path escapes sandbox workspace: ${input || raw}`);
  }

  return normalized;
};

export const isInsideWorkspace = (
  normalizedAbsolute: string,
  workspace = SANDBOX_WORKSPACE,
): boolean => {
  return normalizedAbsolute === workspace || normalizedAbsolute.startsWith(`${workspace}/`);
};

export const sandboxRelative = (absolute: string, workspace = SANDBOX_WORKSPACE): string => {
  if (absolute === workspace) return '.';
  if (absolute.startsWith(`${workspace}/`)) return absolute.slice(workspace.length + 1);
  return path.posix.basename(absolute);
};
