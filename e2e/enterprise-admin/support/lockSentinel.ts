/**
 * Safe ownership protocol for lock-file sentinel tests.
 * Never follows symlinks; never unlinks foreign/replacement files.
 *
 * Protocol (no-replace, no pathname-unlink race on final dispose):
 * 1) prove ownership via original fd + O_NOFOLLOW verify fd (dev/ino/type/token)
 * 2) create an exclusive private quarantine directory (mkdir fails if exists)
 * 3) hard-link owned path into that dir (link fails with EEXIST — never overwrites)
 * 4) prove quarantine path is the same inode as the owned fd
 * 5) remove original path only when lstat still matches owned identity (else leave foreign)
 * 6) leave the proven object as an owned recovery artifact in the exclusive dir
 *    (no final pathname unlink — eliminates post-proof swap → foreign-unlink race)
 *
 * Global PROJECT_ROOT/.next/lock remains strictly read-only (this module only
 * operates under caller-provided isolated project roots).
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmdirSync,
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

export type UnlinkOwnedLockRaceContext = {
  lockPath: string;
  quarantineDir: string;
  quarantinePath: string;
};

export type UnlinkOwnedLockHooks = {
  /**
   * Invoked after full identity/token verification, with quarantine paths pre-chosen,
   * immediately before exclusive mkdir + no-replace link.
   * Production never sets this. Tests may stage collisions/races without bypassing verification.
   */
  afterVerifyBeforeDestructive?: (ctx: UnlinkOwnedLockRaceContext) => void;
  /**
   * Invoked after quarantine identity proof, immediately before original-path clear.
   * Tests may place a foreign regular/symlink at lockPath — production must not overwrite it.
   */
  afterProofBeforeClear?: (ctx: UnlinkOwnedLockRaceContext) => void;
  /**
   * Invoked after optional original-path clear, before returning the recovery-artifact contract.
   * Tests may swap the quarantine path here — production must not destroy foreign objects.
   */
  afterProofBeforeDispose?: (ctx: UnlinkOwnedLockRaceContext) => void;
};

export type UnlinkOwnedLockResult = {
  /** True when owned content is no longer at lockPath (cleared or never reappeared). */
  lockPathCleared: boolean;
  /** Exclusive private directory holding the proven owned recovery artifact. */
  quarantineDir: string;
  /** Path of the proven owned recovery artifact (hardlink of owned inode). */
  quarantinePath: string;
  /**
   * `contained` — owned object safely held as recovery artifact; lock path cleared when possible.
   * Never uses a final pathname unlink of a replaceable path.
   */
  status: 'contained';
};

const identityMatches = (a: Stats, b: { dev: number | bigint; ino: number | bigint }): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.isFile();

const pathIsAbsent = (p: string): boolean => {
  try {
    lstatSync(p);
    return false;
  } catch {
    return true;
  }
};

/**
 * Race-safe removal of an owned sentinel from the lock path.
 * Final disposition is a recovery artifact in an exclusive private directory —
 * never a pathname unlink that could destroy a swapped-in foreign object.
 */
export const unlinkOwnedLockSentinelOrFail = (
  params: {
    fd: number;
    lockPath: string;
    snapshot: LockSnapshot;
    token: string;
  },
  hooks?: UnlinkOwnedLockHooks,
): UnlinkOwnedLockResult => {
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

  // Pre-choose exclusive quarantine paths so tests can stage collisions without
  // bypassing production no-replace checks.
  const quarantineDir = path.join(
    path.dirname(params.lockPath),
    `.e2e-q-${randomBytes(8).toString('hex')}`,
  );
  const quarantinePath = path.join(quarantineDir, 'owned-lock');
  const raceCtx: UnlinkOwnedLockRaceContext = {
    lockPath: params.lockPath,
    quarantineDir,
    quarantinePath,
  };

  hooks?.afterVerifyBeforeDestructive?.(raceCtx);

  // Exclusive private container — fails if destination already exists (no overwrite).
  try {
    mkdirSync(quarantineDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    throw new Error(
      `refusing unlink: quarantine dir collision or create failed (${code || String(error)}); foreign paths preserved`,
      { cause: error },
    );
  }

  // No-replace hardlink into exclusive dir (link fails with EEXIST if path exists).
  try {
    linkSync(params.lockPath, quarantinePath);
  } catch (error) {
    try {
      rmdirSync(quarantineDir);
    } catch {
      // leave for inspection
    }
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    throw new Error(
      `refusing unlink: no-replace quarantine link failed (${code || String(error)}); foreign paths preserved`,
      { cause: error },
    );
  }

  // Prove quarantine is the owned inode (if path was replaced before link, we linked foreign).
  let qst: Stats;
  try {
    qst = lstatSync(quarantinePath);
  } catch (error) {
    throw new Error(`refusing unlink: quarantine path missing after link: ${String(error)}`, {
      cause: error,
    });
  }

  if (qst.isSymbolicLink() || !qst.isFile() || !identityMatches(qst, ownedFdStat)) {
    // Linked a foreign object — remove only the hardlink we created at quarantine.
    // Foreign remains at lockPath (and any other names). Never delete foreign content.
    try {
      unlinkSync(quarantinePath);
    } catch {
      // leave quarantine for inspection
    }
    try {
      rmdirSync(quarantineDir);
    } catch {
      // leave
    }
    throw new Error(
      'refusing unlink: quarantine identity ≠ owned fd (pathname was replaced; foreign preserved at lock path)',
    );
  }

  // Token proof via open of quarantine (same inode as owned fd)
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
  } catch (error) {
    // Proof failed after we linked owned inode — keep recovery artifact, do not destroy.
    throw error instanceof Error && error.message.startsWith('refusing unlink:')
      ? error
      : new Error(`refusing unlink: post-quarantine proof failed: ${String(error)}`, {
          cause: error,
        });
  } finally {
    try {
      closeSync(qfd);
    } catch {
      // already closed
    }
  }

  // Test seam after proof, before clear — may place foreign at lockPath.
  hooks?.afterProofBeforeClear?.(raceCtx);

  // Clear original path only when it is still our inode. If a foreign object arrived,
  // leave it untouched (no overwrite / no delete). Never rename artifact onto lockPath.
  let lockPathCleared = false;
  if (!pathIsAbsent(params.lockPath)) {
    try {
      const cur = lstatSync(params.lockPath);
      if (
        !cur.isSymbolicLink() &&
        cur.isFile() &&
        identityMatches(cur, ownedFdStat) &&
        identityMatches(cur, params.snapshot)
      ) {
        unlinkSync(params.lockPath);
        lockPathCleared = true;
      }
      // else: foreign regular/symlink at lockPath — preserve both (artifact + foreign)
    } catch {
      // path vanished between checks
      lockPathCleared = pathIsAbsent(params.lockPath);
    }
  } else {
    lockPathCleared = true;
  }

  // Test seam after clear — may swap quarantine path with foreign content.
  hooks?.afterProofBeforeDispose?.(raceCtx);

  // Re-validate artifact still matches owned inode. If swapped, refuse any destructive
  // action on the foreign path; report both objects preserved.
  try {
    const after = lstatSync(quarantinePath);
    if (after.isSymbolicLink() || !after.isFile() || !identityMatches(after, ownedFdStat)) {
      throw new Error(
        `refusing unlink: quarantine path swapped after proof (foreign preserved at ${quarantinePath}; owned fd still held by caller)`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('refusing unlink:')) {
      throw error;
    }
    throw new Error(
      `refusing unlink: quarantine artifact missing or unreadable after proof: ${String(error)}`,
      { cause: error },
    );
  }

  // Success contract: owned content contained as recovery artifact (no final pathname unlink).
  // Outer exclusive owner of the isolated project root removes the artifact directory.
  return {
    lockPathCleared,
    quarantineDir,
    quarantinePath,
    status: 'contained',
  };
};
