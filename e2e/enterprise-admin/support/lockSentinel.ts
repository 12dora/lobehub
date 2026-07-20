/**
 * Safe ownership protocol for lock-file sentinel tests.
 * Never follows symlinks; never unlinks foreign/replacement files.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
 * Exclusive-create an owned sentinel under an isolated directory.
 * Returns fd + token + snapshot for robust unlink ownership proof.
 */
export const createOwnedLockSentinel = (
  isolatedProjectRoot: string,
): {
  closeFd: () => void;
  fd: number;
  lockPath: string;
  snapshot: LockSnapshot;
  token: string;
} => {
  const lockDir = path.join(isolatedProjectRoot, '.next');
  mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, 'lock');
  if (existsSync(lockPath)) {
    throw new Error(`refusing to create sentinel: path already exists ${lockPath}`);
  }
  const token = `e2e-owned-lock-${randomBytes(16).toString('hex')}\n`;
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o644);
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
    snapshot,
    token,
  };
};

/**
 * Unlink only if every ownership check still matches the exclusive-created sentinel.
 * Uses lstat (no follow) + fstat(fd) + token bytes via O_NOFOLLOW open.
 */
export const unlinkOwnedLockSentinelOrFail = (params: {
  fd: number;
  lockPath: string;
  snapshot: LockSnapshot;
  token: string;
}): void => {
  const lst = lstatSync(params.lockPath);
  if (lst.isSymbolicLink()) {
    throw new Error(`refusing unlink: path is a symlink ${params.lockPath}`);
  }
  if (!lst.isFile()) {
    throw new Error(`refusing unlink: not a regular file ${params.lockPath}`);
  }
  const fst = fstatSync(params.fd) as Stats;
  if (fst.ino !== lst.ino || fst.dev !== lst.dev) {
    throw new Error(
      `refusing unlink: fstat/lstat identity mismatch ino=${String(fst.ino)}/${String(lst.ino)}`,
    );
  }
  if (lst.ino !== params.snapshot.ino || lst.dev !== params.snapshot.dev) {
    throw new Error('refusing unlink: inode/dev changed from owned snapshot');
  }
  // Re-open with O_NOFOLLOW and verify exact token bytes
  const verifyFd = openSync(params.lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(params.token.length + 8);
    const n = readSync(verifyFd, buf, 0, buf.length, 0);
    const got = buf.subarray(0, n).toString('utf8');
    if (got !== params.token) {
      throw new Error('refusing unlink: token/bytes mismatch (foreign replacement)');
    }
  } finally {
    closeSync(verifyFd);
  }
  unlinkSync(params.lockPath);
};
