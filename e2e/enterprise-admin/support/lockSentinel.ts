/**
 * Safe ownership protocol for lock-file sentinel tests.
 * Never follows symlinks; never unlinks foreign/replacement files.
 *
 * Protocol (fully non-destructive on pathnames):
 * 1) prove ownership via original fd + O_NOFOLLOW verify fd (dev/ino/type/token)
 * 2) create an exclusive private quarantine directory (mkdir fails if exists)
 * 3) hard-link owned path into that dir (link fails with EEXIST — never overwrites)
 * 4) prove quarantine path is the same inode as the owned fd + token
 * 5) return contained recovery-artifact state
 *
 * Never pathname-unlink / rmdir / rm / rename-overwrite any replaceable path on
 * failure or success. Plain Node unlink/rmdir after checks is prohibited.
 * On mkdir/link/proof failure: throw fail-closed and leave all created paths
 * for the exclusive outer mkdtemp root owner to remove.
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
  type Stats,
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

export type ContainOwnedLockRaceContext = {
  lockPath: string;
  quarantineDir: string;
  quarantinePath: string;
};

export type ContainOwnedLockHooks = {
  /**
   * Invoked after full identity/token verification, with quarantine paths pre-chosen,
   * immediately before exclusive mkdir + no-replace link.
   * Production never sets this. Tests may stage collisions/races without bypassing verification.
   */
  afterVerifyBeforeDestructive?: (ctx: ContainOwnedLockRaceContext) => void;
  /**
   * Invoked after exclusive quarantine mkdir succeeds, immediately before linkSync.
   * Production never sets this. Tests may force link failure while the exclusive dir is empty.
   */
  afterMkdirBeforeLink?: (ctx: ContainOwnedLockRaceContext) => void;
  /**
   * Invoked on linkSync failure at the former pathname rmdir(quarantineDir) site.
   * Production never rmdirs. Tests may replace the empty exclusive dir with a foreign
   * empty directory here to prove opportunistic cleanup cannot destroy it.
   */
  afterLinkFailureBeforePathnameCleanup?: (ctx: ContainOwnedLockRaceContext) => void;
  /**
   * Invoked after the last successful identity observation of the quarantine artifact
   * (token proof via open fd), at the site of the former check-then-unlink of lockPath.
   * Production never unlinks lockPath. Tests inject foreign regular/symlink here to prove
   * this exact final window cannot destroy replacements.
   */
  afterContainmentProofBeforeReturn?: (ctx: ContainOwnedLockRaceContext) => void;
  /**
   * @deprecated Same seam as afterContainmentProofBeforeReturn (former clear site).
   * Kept so RR11 foreign-before-clear tests retain an explicit hook name.
   */
  afterProofBeforeClear?: (ctx: ContainOwnedLockRaceContext) => void;
  /**
   * Invoked after containment proof (+ optional afterContainmentProofBeforeReturn),
   * before final artifact re-validation / return.
   * Tests may swap the quarantine path — production must not destroy foreign objects.
   */
  afterProofBeforeDispose?: (ctx: ContainOwnedLockRaceContext) => void;
};

export type ContainOwnedLockResult = {
  /**
   * Always false. This protocol never pathname-unlinks lockPath.
   * Callers must not treat `contained` as "path cleared".
   * Outer exclusive owner of the isolated mkdtemp root removes residual paths.
   */
  originalLockPathUnlinked: false;
  /** Exclusive private directory holding the proven owned recovery artifact. */
  quarantineDir: string;
  /** Path of the proven owned recovery artifact (hardlink of owned inode). */
  quarantinePath: string;
  /**
   * `contained` — owned inode is hardlinked into the exclusive quarantine dir.
   * Does NOT mean lockPath was cleared or unlinked.
   */
  status: 'contained';
};

const identityMatches = (a: Stats, b: { dev: number | bigint; ino: number | bigint }): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.isFile();

/**
 * Race-safe containment of an owned sentinel.
 * Establishes a hardlinked recovery artifact in an exclusive private directory.
 * Never pathname-unlinks/rmdirs/rms any replaceable path (no check-then-destroy).
 */
export const containOwnedLockSentinelOrFail = (
  params: {
    fd: number;
    lockPath: string;
    snapshot: LockSnapshot;
    token: string;
  },
  hooks?: ContainOwnedLockHooks,
): ContainOwnedLockResult => {
  const ownedFdStat = fstatSync(params.fd) as Stats;
  if (!ownedFdStat.isFile()) {
    throw new Error('refusing contain: owned fd is not a regular file');
  }
  if (ownedFdStat.ino !== params.snapshot.ino || ownedFdStat.dev !== params.snapshot.dev) {
    throw new Error('refusing contain: owned fd identity drifted from snapshot');
  }

  const lst = lstatSync(params.lockPath);
  if (lst.isSymbolicLink()) {
    throw new Error(`refusing contain: path is a symlink ${params.lockPath}`);
  }
  if (!lst.isFile()) {
    throw new Error(`refusing contain: not a regular file ${params.lockPath}`);
  }
  if (!identityMatches(lst, params.snapshot)) {
    throw new Error('refusing contain: path lstat identity mismatch vs owned snapshot');
  }
  if (!identityMatches(ownedFdStat, { dev: lst.dev, ino: lst.ino })) {
    throw new Error('refusing contain: owned fd vs path lstat identity mismatch');
  }

  // O_NOFOLLOW verification open — compare verifyFd identity to owned fd
  const verifyFd = openSync(params.lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const vst = fstatSync(verifyFd) as Stats;
    if (!identityMatches(vst, params.snapshot) || !identityMatches(vst, ownedFdStat)) {
      throw new Error('refusing contain: verifyFd identity mismatch');
    }
    const buf = Buffer.alloc(params.token.length + 8);
    const n = readSync(verifyFd, buf, 0, buf.length, 0);
    const got = buf.subarray(0, n).toString('utf8');
    if (got !== params.token) {
      throw new Error('refusing contain: token/bytes mismatch (foreign replacement)');
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
  const raceCtx: ContainOwnedLockRaceContext = {
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
      `refusing contain: quarantine dir collision or create failed (${code || String(error)}); foreign paths preserved`,
      { cause: error },
    );
  }

  hooks?.afterMkdirBeforeLink?.(raceCtx);

  // No-replace hardlink into exclusive dir (link fails with EEXIST if path exists).
  // On failure: fail-closed and leave quarantineDir for outer isolated-root cleanup.
  // Never rmdir/unlink by pathname — the directory path can be replaced before destroy.
  try {
    linkSync(params.lockPath, quarantinePath);
  } catch (error) {
    hooks?.afterLinkFailureBeforePathnameCleanup?.(raceCtx);
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    throw new Error(
      `refusing contain: no-replace quarantine link failed (${code || String(error)}); foreign paths preserved; quarantine dir left for outer root cleanup`,
      { cause: error },
    );
  }

  // Prove quarantine is the owned inode (if path was replaced before link, we linked foreign).
  let qst: Stats;
  try {
    qst = lstatSync(quarantinePath);
  } catch (error) {
    throw new Error(`refusing contain: quarantine path missing after link: ${String(error)}`, {
      cause: error,
    });
  }

  if (qst.isSymbolicLink() || !qst.isFile() || !identityMatches(qst, ownedFdStat)) {
    // Linked a foreign object — leave quarantine hardlink for inspection.
    // Never pathname-unlink quarantine (check-then-unlink could destroy a later swap).
    // Foreign remains at lockPath (and quarantine hardlink if still same inode).
    throw new Error(
      'refusing contain: quarantine identity ≠ owned fd (pathname was replaced; foreign preserved at lock path and quarantine for inspection)',
    );
  }

  // Token proof via open of quarantine (same inode as owned fd) — last identity observation
  // of the owned recovery artifact before return.
  const qfd = openSync(quarantinePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const qfst = fstatSync(qfd) as Stats;
    if (!identityMatches(qfst, ownedFdStat)) {
      throw new Error('refusing contain: quarantine open fd identity mismatch');
    }
    const buf = Buffer.alloc(params.token.length + 8);
    const n = readSync(qfd, buf, 0, buf.length, 0);
    if (buf.subarray(0, n).toString('utf8') !== params.token) {
      throw new Error('refusing contain: quarantine token mismatch');
    }
  } catch (error) {
    // Proof failed after we linked owned inode — keep recovery artifact, do not destroy.
    throw error instanceof Error && error.message.startsWith('refusing contain:')
      ? error
      : new Error(`refusing contain: post-quarantine proof failed: ${String(error)}`, {
          cause: error,
        });
  } finally {
    try {
      closeSync(qfd);
    } catch {
      // already closed
    }
  }

  // Exact former check-then-unlink site: production never unlinks lockPath.
  // Tests inject foreign regular/symlink here to prove the final window is non-destructive.
  hooks?.afterContainmentProofBeforeReturn?.(raceCtx);
  hooks?.afterProofBeforeClear?.(raceCtx);

  // Test seam — may swap quarantine path with foreign content after containment proof.
  hooks?.afterProofBeforeDispose?.(raceCtx);

  // Re-validate artifact still matches owned inode. If swapped, refuse any destructive
  // action on the foreign path; report both objects preserved (no unlink of foreign).
  try {
    const after = lstatSync(quarantinePath);
    if (after.isSymbolicLink() || !after.isFile() || !identityMatches(after, ownedFdStat)) {
      throw new Error(
        `refusing contain: quarantine path swapped after proof (foreign preserved at ${quarantinePath}; owned fd still held by caller; lockPath never unlinked)`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('refusing contain:')) {
      throw error;
    }
    throw new Error(
      `refusing contain: quarantine artifact missing or unreadable after proof: ${String(error)}`,
      { cause: error },
    );
  }

  // Success: owned content contained as recovery artifact. lockPath is intentionally left
  // alone (may still name the owned inode or a later foreign). Outer exclusive owner of the
  // isolated project root removes residual paths after the test lifecycle.
  return {
    originalLockPathUnlinked: false,
    quarantineDir,
    quarantinePath,
    status: 'contained',
  };
};

/**
 * @deprecated Name retained for call-site continuity. Does not unlink pathnames —
 * see containOwnedLockSentinelOrFail (same implementation).
 */
export const unlinkOwnedLockSentinelOrFail = containOwnedLockSentinelOrFail;
