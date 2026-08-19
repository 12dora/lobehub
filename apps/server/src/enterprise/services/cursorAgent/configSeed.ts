import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import nodePath from 'node:path';

/** Hex prefix of sha256 used as the per-connection config-seed directory name. */
export const CURSOR_CONFIG_SEED_DIGEST_LENGTH = 32;

/** Path namespace under `config-seed/` for stored-connection account ids. */
export const CURSOR_CONFIG_SEED_ACCOUNT_NS = 'account';
/** Path namespace under `config-seed/` for bearer-token fallback. */
export const CURSOR_CONFIG_SEED_TOKEN_NS = 'token';

const CONFIG_SEED_FILES = ['cli-config.json', 'statsig-cache.json'] as const;

const safeErrorClass = (error: unknown): string =>
  error instanceof Error ? error.name || 'Error' : typeof error;

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === code;

/**
 * Stored-connection owner. Same shape as ChatGPT Web's Browser Session account id:
 * `platform:<providerId>[:rev:<n>]` / `user:<userId>:<workspace>:<providerId>`.
 */
export type CursorAgentAccountOwner =
  | { kind: 'platform'; providerId: string; revision?: number }
  | { kind: 'user'; providerId: string; userId: string; workspaceId?: string };

/**
 * Stable handle for one stored Cursor connection. Must be the same across reconnects
 * of THIS connection (so the CLI config seed actually reuses) and different for every
 * other stored connection.
 */
export const buildCursorAgentAccountId = (owner: CursorAgentAccountOwner): string => {
  if (owner.kind === 'platform') {
    return owner.revision == null
      ? `platform:${owner.providerId}`
      : `platform:${owner.providerId}:rev:${owner.revision}`;
  }
  const workspace = owner.workspaceId?.trim() || '_';
  return `user:${owner.userId}:${workspace}:${owner.providerId}`;
};

/** sha256 hex prefix — safe as a directory name. Never the raw id or token. */
export const digestCursorConfigSeedIdentity = (value: string): string =>
  createHash('sha256')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, CURSOR_CONFIG_SEED_DIGEST_LENGTH);

/**
 * Current (unpinned) platform-managed connection. Historical `rev:N` ids and every
 * user/BYOK id are excluded: the pre-isolation global seed belonged to the shared
 * platform account, not to a pinned revision or a personal connection.
 */
export const isCurrentPlatformCursorAccountId = (accountId: string): boolean =>
  /^platform:[^:]+$/.test(accountId);

const ensureDir = (path: string): void => {
  fs.mkdirSync(path, { mode: 0o700, recursive: true });
  try {
    fs.chmodSync(path, 0o700);
  } catch {
    // Best effort: some filesystems ignore chmod (the mode at create still applied).
  }
};

const isRegularFile = (path: string): boolean => {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
};

export const cursorAgentAccountConfigSeedDir = (seedRoot: string, accountId: string): string =>
  nodePath.join(seedRoot, CURSOR_CONFIG_SEED_ACCOUNT_NS, digestCursorConfigSeedIdentity(accountId));

export const cursorAgentTokenConfigSeedDir = (seedRoot: string, token: string): string =>
  nodePath.join(seedRoot, CURSOR_CONFIG_SEED_TOKEN_NS, digestCursorConfigSeedIdentity(token));

/**
 * Write a complete 0600 temp file in the destination directory, then install it
 * with `linkSync` so an existing dest (a concurrent replica, or a newer copy-back)
 * is never replaced. Each seed file is independent: a missing sibling is retried
 * on a later turn.
 */
const installLegacySeedFileNoClobber = (src: string, dest: string): void => {
  if (fs.existsSync(dest) || !isRegularFile(src)) return;

  const tmp = nodePath.join(
    nodePath.dirname(dest),
    `.${nodePath.basename(dest)}.${randomUUID()}.tmp`,
  );
  try {
    fs.copyFileSync(src, tmp);
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // Best effort against umask.
    }
    try {
      fs.linkSync(tmp, dest);
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return;
      throw error;
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort: dest may already own the inode.
    }
  }
};

/**
 * Copy pre-isolation files that sit directly in `config-seed/` into the
 * platform-managed per-account dir. Per file, no-clobber, never deleted from
 * the legacy location.
 */
const migrateLegacyConfigSeed = (seedRoot: string, destDir: string): void => {
  for (const file of CONFIG_SEED_FILES) {
    try {
      installLegacySeedFileNoClobber(nodePath.join(seedRoot, file), nodePath.join(destDir, file));
    } catch (error) {
      console.error('Cursor Agent legacy config seed migration skipped:', safeErrorClass(error));
    }
  }
};

export interface ResolveCursorAgentConfigSeedDirParams {
  /**
   * Stored-connection account id from `x-aihub-account`. When absent (legacy callers /
   * tests), the bearer token is digested instead so two tokens still never share a seed.
   */
  accountId?: string;
  /** Parent `<stateDir>/config-seed`. */
  seedRoot: string;
  token: string;
}

/**
 * Per-connection persistent seed directory at 0700:
 * `<seedRoot>/account/<sha256(accountId)[:32]>/` when the account header is present,
 * otherwise `<seedRoot>/token/<sha256(token)[:32]>/`.
 *
 * The two namespaces are distinct path components, so a bearer token that happens
 * to equal a canonical account id cannot resolve to that account's directory.
 *
 * Never returns the legacy global `config-seed/` itself. Growth is bounded by the
 * number of stored connections (plus headerless tokens) that have actually run a
 * turn; there is no side index. Retired dirs are left for the operator, same as
 * `home-*`.
 */
export const resolveCursorAgentConfigSeedDir = (
  params: ResolveCursorAgentConfigSeedDirParams,
): string => {
  const destDir = params.accountId
    ? cursorAgentAccountConfigSeedDir(params.seedRoot, params.accountId)
    : cursorAgentTokenConfigSeedDir(params.seedRoot, params.token);
  ensureDir(destDir);

  if (params.accountId && isCurrentPlatformCursorAccountId(params.accountId)) {
    migrateLegacyConfigSeed(params.seedRoot, destDir);
  }

  return destDir;
};
