/**
 * Safe ownership protocol for lock-file sentinel tests.
 * Never follows symlinks; never unlinks foreign/replacement files.
 * Destructive unlink uses quarantine-rename + post-rename identity proof so
 * path replacement between verify and destroy cannot delete a foreign object.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export type LockSnapshot = {
  bytes: Buffer;
  ctimeMs: number;
  dev: number | bigint;
  gid: number;
  ino: number | bigint;
  isFile: boolean;
  isSymlink: boolean;
  mode: number;
  mtimeMs: number;
  size: number;
  uid: number;
};

export const snapshotLockPath = (lockPath: string): LockSnapshot => {
  const st = lstatSync(lockPath);
  if (st.isSymbolicLink()) {
    return {
      bytes: Buffer.alloc(0),
      ctimeMs: st.ctimeMs,
      dev: st.dev,
      gid: st.gid,
      ino: st.ino,
      isFile: false,
      isSymlink: true,
      mode: st.mode,
      mtimeMs: st.mtimeMs,
      size: st.size,
      uid: st.uid,
    };
  }
  const bytes = readFileSync(lockPath);
  return {
    bytes,
    ctimeMs: st.ctimeMs,
    dev: st.dev,
    gid: st.gid,
    ino: st.ino,
    isFile: st.isFile(),
    isSymlink: false,
    mode: st.mode,
    mtimeMs: st.mtimeMs,
    size: st.size,
    uid: st.uid,
  };
};

export const snapshotsEqual = (a: LockSnapshot, b: LockSnapshot): boolean =>
  a.bytes.equals(b.bytes) &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.size === b.size &&
  Math.abs(a.mtimeMs - b.mtimeMs) < 1 &&
  a.isFile === b.isFile &&
  a.isSymlink === b.isSymlink;

/**
 * Exclusive-create an owned sentinel under an isolated project root.
 * Parent `.next` is mode 0700 so only the suite owner can write/replace inside.
 */
export const createOwnedLockSentinel = (
  isolatedProjectRoot: string,
): {
  closeFd: () => void;
  fd: number;
  lockPath: string;
  parentDir: string;
  snapshot: LockSnapshot;
  token: string;
} => {
  const lockDir = path.join(isolatedProjectRoot, '.next');
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(lockDir, 0o700);
  } catch {
    // best-effort
  }
  const lockPath = path.join(lockDir, 'lock');
  if (existsSync(lockPath)) {
    throw new Error(`refusing to create sentinel: path already exists ${lockPath}`);
  }
  const token = `e2e-owned-lock-${randomBytes(16).toString('hex')}\n`;
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  writeFileSync(fd, token, 'utf8');
  const st = fstatSync(fd) as Stats;
  const snapshot: LockSnapshot = {
    bytes: Buffer.from(token, 'utf8'),
    ctimeMs: st.ctimeMs,
    dev: st.dev,
    gid: st.gid,
    ino: st.ino,
    isFile: st.isFile(),
    isSymlink: false,
    mode: st.mode,
    mtimeMs: st.mtimeMs,
    size: st.size,
    uid: st.uid,
  };
  return {
    closeFd: () => {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    },
    fd,
    lockPath,
    parentDir: lockDir,
    snapshot,
    token,
  };
};

export type UnlinkOwnedLockHooks = {
  /**
   * Invoked after full identity/token verification, immediately before the
   * destructive quarantine rename. Production never sets this.
   * Tests inject pathname replacement races here without weakening production.
   */
  afterVerifyBeforeDestructive?: () => void;
};

const identityMatches = (a: Stats, b: { dev: number | bigint; ino: number | bigint }): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.isFile();

/**
 * Race-safe removal of an owned sentinel:
 * 1) prove ownership via original fd + O_NOFOLLOW verify fd (dev/ino/type/token)
 * 2) atomic rename to quarantine name in the same private directory
 * 3) prove quarantine path is the same inode as the original fd
 * 4) unlink quarantine only when identity still matches
 *
 * If the pathname was replaced after verify, rename moves the replacement —
 * post-rename identity check fails (≠ original fd), we attempt rollback rename
 * and refuse destruction of the foreign object.
 */
export const unlinkOwnedLockSentinelOrFail = (
  params: {
    fd: number;
    lockPath: string;
    snapshot: LockSnapshot;
    token: string;
  },
  hooks?: UnlinkOwnedLockHooks,
): void => {
  const ownedFdStat = fstatSync(params.fd) as Stats;
  if (!ownedFdStat.isFile()) {
    throw new Error('refusing unlink: owned fd is not a regular file');
  }
  if (ownedFdStat.ino !== params.snapshot.ino || ownedFdStat.dev !== params.snapshot.dev) {
    throw new Error('refusing unlink: owned fd identity drifted from snapshot');
  }

  const lst = lstatSync(params.lockPath);
  if (lst.isSymbolicLink()) {
    throw new Error(`refusing unlink: path is a symlink ${params.lockPath}`);
  }
  if (!lst.isFile()) {
    throw new Error(`refusing unlink: not a regular file ${params.lockPath}`);
  }
  if (!identityMatches(lst, params.snapshot)) {
    throw new Error('refusing unlink: path lstat identity mismatch vs owned snapshot');
  }
  if (!identityMatches(ownedFdStat, { dev: lst.dev, ino: lst.ino })) {
    throw new Error('refusing unlink: owned fd vs path lstat identity mismatch');
  }

  // O_NOFOLLOW verification open — compare verifyFd identity to owned fd
  const verifyFd = openSync(params.lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const vst = fstatSync(verifyFd) as Stats;
    if (!identityMatches(vst, params.snapshot) || !identityMatches(vst, ownedFdStat)) {
      throw new Error('refusing unlink: verifyFd identity mismatch');
    }
    const buf = Buffer.alloc(params.token.length + 8);
    const n = readSync(verifyFd, buf, 0, buf.length, 0);
    const got = buf.subarray(0, n).toString('utf8');
    if (got !== params.token) {
      throw new Error('refusing unlink: token/bytes mismatch (foreign replacement)');
    }
  } finally {
    closeSync(verifyFd);
  }

  // Narrow production-safe test seam (no-op in production).
  hooks?.afterVerifyBeforeDestructive?.();

  const quarantinePath = `${params.lockPath}.e2e-quarantine-${randomBytes(8).toString('hex')}`;
  try {
    renameSync(params.lockPath, quarantinePath);
  } catch (error) {
    throw new Error(
      `refusing unlink: quarantine rename failed (path may have been replaced): ${String(error)}`,
      { cause: error },
    );
  }

  // Post-rename: quarantine must be the same inode as the still-open owned fd.
  try {
    const qst = lstatSync(quarantinePath);
    if (qst.isSymbolicLink() || !qst.isFile()) {
      // Foreign/symlink quarantine — try to restore path, refuse unlink
      try {
        renameSync(quarantinePath, params.lockPath);
      } catch {
        // leave quarantine for operator inspection
      }
      throw new Error('refusing unlink: quarantine is not a regular file (rollback attempted)');
    }
    if (!identityMatches(qst, ownedFdStat) || !identityMatches(qst, params.snapshot)) {
      // Renamed a replacement, not our inode — restore and refuse
      try {
        renameSync(quarantinePath, params.lockPath);
      } catch {
        // leave for inspection
      }
      throw new Error(
        'refusing unlink: quarantine identity ≠ owned fd (pathname was replaced; foreign restored if possible)',
      );
    }
    // Prove token still readable at quarantine
    const qfd = openSync(quarantinePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const qfst = fstatSync(qfd) as Stats;
      if (!identityMatches(qfst, ownedFdStat)) {
        throw new Error('refusing unlink: quarantine open fd identity mismatch');
      }
      const buf = Buffer.alloc(params.token.length + 8);
      const n = readSync(qfd, buf, 0, buf.length, 0);
      if (buf.subarray(0, n).toString('utf8') !== params.token) {
        throw new Error('refusing unlink: quarantine token mismatch');
      }
    } finally {
      closeSync(qfd);
    }
    // Safe: quarantine is proven-owned object
    unlinkSync(quarantinePath);
  } catch (error) {
    // If unlink already happened, rethrow; otherwise attempt leave state safe
    if (error instanceof Error && error.message.startsWith('refusing unlink:')) {
      throw error;
    }
    throw new Error(`refusing unlink: post-quarantine proof failed: ${String(error)}`, {
      cause: error,
    });
  }
};
