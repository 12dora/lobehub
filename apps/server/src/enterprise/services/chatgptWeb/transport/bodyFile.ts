import { randomBytes } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

/** Owner-only directory under the system temp dir holding in-flight request bodies. */
const TEMP_BODY_DIR = 'aihub-chatgptweb';

/**
 * Stage the request body where curl can read it back with `data-binary = "@path"`.
 *
 * `0600` inside a `0700` directory, an unguessable name, and `wx` (fail if it exists, and
 * never follow a symlink) so a pre-planted entry in a shared `/tmp` cannot redirect the
 * write. The path is never logged and never appears in argv — only inside the config that
 * travels down the child's stdin pipe.
 */
export const writeRequestBodyFile = (body: Uint8Array): string => {
  const directory = nodePath.join(tmpdir(), TEMP_BODY_DIR);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const path = nodePath.join(directory, randomBytes(16).toString('hex'));
  writeFileSync(path, body, { flag: 'wx', mode: 0o600 });
  return path;
};

export const removeQuietly = (path: string | undefined): void => {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or the directory was cleaned underneath us.
  }
};
