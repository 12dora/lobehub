import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  containOwnedLockSentinelOrFail,
  createOwnedLockSentinel,
  snapshotLockPath,
  snapshotsEqual,
  unlinkOwnedLockSentinelOrFail,
} from './lockSentinel';

describe('safe lock sentinel ownership protocol', () => {
  const temps: string[] = [];

  afterEach(() => {
    while (temps.length > 0) {
      const d = temps.pop()!;
      // Exclusive owner of disposable isolated root removes whole root (owned + artifacts).
      rmSync(d, { force: true, recursive: true });
    }
  });

  it('owned sentinel success: contained recovery artifact; lockPath NOT unlinked', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-owned-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    try {
      expect(existsSync(owned.lockPath)).toBe(true);
      const mid = snapshotLockPath(owned.lockPath);
      expect(snapshotsEqual(owned.snapshot, mid)).toBe(true);
      expect(readFileSync(owned.lockPath, 'utf8')).toBe(owned.token);

      const result = containOwnedLockSentinelOrFail(owned);
      expect(result.status).toBe('contained');
      // Honest contract: contained ≠ path cleared
      expect(result.originalLockPathUnlinked).toBe(false);
      // Original lock pathname still present (hardlink of owned inode) until outer root cleanup
      expect(existsSync(owned.lockPath)).toBe(true);
      expect(readFileSync(owned.lockPath, 'utf8')).toBe(owned.token);
      // Proven owned content also lives as recovery artifact
      expect(existsSync(result.quarantinePath)).toBe(true);
      expect(readFileSync(result.quarantinePath, 'utf8')).toBe(owned.token);
      // Alias export remains the same implementation
      expect(unlinkOwnedLockSentinelOrFail).toBe(containOwnedLockSentinelOrFail);
    } finally {
      owned.closeFd();
    }
    // Outer exclusive owner of unique mkdtemp root removes residual paths
    rmSync(root, { force: true, recursive: true });
    const idx = temps.indexOf(root);
    if (idx >= 0) temps.splice(idx, 1);
    expect(existsSync(root)).toBe(false);
  });

  it('foreign pre-existing lock: read-only, never write or unlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-foreign-'));
    temps.push(root);
    const lockDir = path.join(root, '.next');
    mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, 'lock');
    const foreign = 'foreign-preexisting-lock-bytes\n';
    writeFileSync(lockPath, foreign, 'utf8');
    const before = snapshotLockPath(lockPath);
    const after = snapshotLockPath(lockPath);
    expect(snapshotsEqual(before, after)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(foreign);
  });

  it('symlink replacement before call must not unlink foreign target', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-symlink-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    try {
      const foreignTarget = path.join(root, 'foreign-target');
      writeFileSync(foreignTarget, 'foreign\n', 'utf8');
      unlinkSync(owned.lockPath);
      symlinkSync(foreignTarget, owned.lockPath);

      expect(() => containOwnedLockSentinelOrFail(owned)).toThrow(
        /symlink|mismatch|token|contain/i,
      );
      expect(existsSync(foreignTarget)).toBe(true);
      expect(readFileSync(foreignTarget, 'utf8')).toBe('foreign\n');
    } finally {
      owned.closeFd();
    }
  });

  it('race: foreign regular file replaces path after verify, before quarantine — foreign survives', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-race-file-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignBytes = 'FOREIGN_REPLACEMENT_REGULAR_FILE\n';
    try {
      expect(() =>
        containOwnedLockSentinelOrFail(owned, {
          afterVerifyBeforeDestructive: () => {
            unlinkSync(owned.lockPath);
            writeFileSync(owned.lockPath, foreignBytes, 'utf8');
          },
        }),
      ).toThrow(/refusing contain|replaced|identity|mismatch/i);

      expect(existsSync(owned.lockPath)).toBe(true);
      expect(readFileSync(owned.lockPath, 'utf8')).toBe(foreignBytes);
    } finally {
      owned.closeFd();
    }
  });

  it('race: symlink replaces path after verify, before quarantine — target survives', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-race-sym-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignTarget = path.join(root, 'foreign-target-race');
    writeFileSync(foreignTarget, 'foreign-symlink-target\n', 'utf8');
    try {
      expect(() =>
        containOwnedLockSentinelOrFail(owned, {
          afterVerifyBeforeDestructive: () => {
            unlinkSync(owned.lockPath);
            symlinkSync(foreignTarget, owned.lockPath);
          },
        }),
      ).toThrow(/refusing contain|symlink|replaced|identity|mismatch/i);

      expect(existsSync(foreignTarget)).toBe(true);
      expect(readFileSync(foreignTarget, 'utf8')).toBe('foreign-symlink-target\n');
    } finally {
      owned.closeFd();
    }
  });

  it('boundary: pre-existing quarantine dir collision — foreign bytes survive, no overwrite', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-q-collision-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignQuarantine = 'FOREIGN_QUARANTINE_COLLISION_BYTES\n';
    let stagedPath = '';
    try {
      expect(() =>
        containOwnedLockSentinelOrFail(owned, {
          afterVerifyBeforeDestructive: (ctx) => {
            stagedPath = ctx.quarantinePath;
            mkdirSync(ctx.quarantineDir, { recursive: false, mode: 0o700 });
            writeFileSync(ctx.quarantinePath, foreignQuarantine, 'utf8');
          },
        }),
      ).toThrow(/quarantine dir collision|no-replace|refusing contain/i);

      expect(stagedPath).toBeTruthy();
      expect(existsSync(stagedPath)).toBe(true);
      expect(readFileSync(stagedPath, 'utf8')).toBe(foreignQuarantine);
      expect(existsSync(owned.lockPath)).toBe(true);
      expect(readFileSync(owned.lockPath, 'utf8')).toBe(owned.token);
    } finally {
      owned.closeFd();
    }
  });

  it('boundary: foreign regular at lockPath after containment (RR11 before-clear seam) — both preserved', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-foreign-before-clear-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignBytes = 'FOREIGN_BEFORE_CLEAR\n';
    try {
      const result = containOwnedLockSentinelOrFail(owned, {
        afterProofBeforeClear: (ctx) => {
          unlinkSync(ctx.lockPath);
          writeFileSync(ctx.lockPath, foreignBytes, 'utf8');
        },
      });
      expect(result.status).toBe('contained');
      expect(result.originalLockPathUnlinked).toBe(false);
      expect(existsSync(owned.lockPath)).toBe(true);
      expect(readFileSync(owned.lockPath, 'utf8')).toBe(foreignBytes);
      expect(existsSync(result.quarantinePath)).toBe(true);
      expect(readFileSync(result.quarantinePath, 'utf8')).toBe(owned.token);
    } finally {
      owned.closeFd();
    }
  });

  it('boundary: foreign symlink at lockPath after containment (RR11 before-clear seam) — target survives', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-sym-before-clear-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignTarget = path.join(root, 'foreign-sym-target');
    writeFileSync(foreignTarget, 'foreign-sym-target-bytes\n', 'utf8');
    try {
      const result = containOwnedLockSentinelOrFail(owned, {
        afterProofBeforeClear: (ctx) => {
          unlinkSync(ctx.lockPath);
          symlinkSync(foreignTarget, ctx.lockPath);
        },
      });
      expect(result.status).toBe('contained');
      expect(result.originalLockPathUnlinked).toBe(false);
      expect(lstatSync(owned.lockPath).isSymbolicLink()).toBe(true);
      expect(existsSync(foreignTarget)).toBe(true);
      expect(readFileSync(foreignTarget, 'utf8')).toBe('foreign-sym-target-bytes\n');
      expect(readFileSync(result.quarantinePath, 'utf8')).toBe(owned.token);
    } finally {
      owned.closeFd();
    }
  });

  it('final-window: foreign regular replaces lockPath after last identity observation — not removed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-final-window-file-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignBytes = 'FOREIGN_FINAL_WINDOW_REGULAR\n';
    try {
      // Hook sits exactly at the former check-then-unlink site (after last quarantine proof).
      const result = containOwnedLockSentinelOrFail(owned, {
        afterContainmentProofBeforeReturn: (ctx) => {
          unlinkSync(ctx.lockPath);
          writeFileSync(ctx.lockPath, foreignBytes, 'utf8');
        },
      });
      expect(result.status).toBe('contained');
      expect(result.originalLockPathUnlinked).toBe(false);
      // Production must not remove/overwrite the foreign file
      expect(existsSync(owned.lockPath)).toBe(true);
      expect(readFileSync(owned.lockPath, 'utf8')).toBe(foreignBytes);
      expect(readFileSync(result.quarantinePath, 'utf8')).toBe(owned.token);
    } finally {
      owned.closeFd();
    }
  });

  it('final-window: foreign symlink replaces lockPath after last identity observation — target survives', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-final-window-sym-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignTarget = path.join(root, 'foreign-final-window-target');
    writeFileSync(foreignTarget, 'foreign-final-window-target-bytes\n', 'utf8');
    try {
      const result = containOwnedLockSentinelOrFail(owned, {
        afterContainmentProofBeforeReturn: (ctx) => {
          unlinkSync(ctx.lockPath);
          symlinkSync(foreignTarget, ctx.lockPath);
        },
      });
      expect(result.status).toBe('contained');
      expect(result.originalLockPathUnlinked).toBe(false);
      expect(lstatSync(owned.lockPath).isSymbolicLink()).toBe(true);
      expect(existsSync(foreignTarget)).toBe(true);
      expect(readFileSync(foreignTarget, 'utf8')).toBe('foreign-final-window-target-bytes\n');
      // Symlink itself not removed
      expect(existsSync(owned.lockPath)).toBe(true);
      expect(readFileSync(result.quarantinePath, 'utf8')).toBe(owned.token);
    } finally {
      owned.closeFd();
    }
  });

  it('link-failure boundary: foreign empty quarantine dir survives former rmdir site', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-link-fail-rmdir-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignMarker = 'FOREIGN_EMPTY_QUARANTINE_DIR\n';
    let foreignDir = '';
    let markerPath = '';
    try {
      expect(() =>
        containOwnedLockSentinelOrFail(owned, {
          afterMkdirBeforeLink: (ctx) => {
            // Keep quarantineDir empty; force linkSync to fail (ENOENT on source).
            renameSync(owned.lockPath, `${owned.lockPath}.aside`);
            void ctx;
          },
          afterLinkFailureBeforePathnameCleanup: (ctx) => {
            // Exact former rmdir(quarantineDir) window: replace exclusive empty dir
            // with a foreign empty directory. Production must not pathname-rmdir it.
            foreignDir = ctx.quarantineDir;
            markerPath = `${ctx.quarantineDir}.foreign-marker`;
            rmdirSync(ctx.quarantineDir);
            mkdirSync(ctx.quarantineDir, { recursive: false, mode: 0o755 });
            writeFileSync(markerPath, foreignMarker, 'utf8');
          },
        }),
      ).toThrow(/no-replace quarantine link failed|refusing contain|foreign paths preserved/i);

      expect(foreignDir).toBeTruthy();
      expect(existsSync(foreignDir)).toBe(true);
      expect(lstatSync(foreignDir).isDirectory()).toBe(true);
      // Foreign empty dir was not removed by opportunistic cleanup
      expect(readdirSync(foreignDir)).toEqual([]);
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, 'utf8')).toBe(foreignMarker);
      // Honest non-destructive contract still applies to lock path
      // (source was moved aside only by the test seam, not by production)
      expect(existsSync(`${owned.lockPath}.aside`)).toBe(true);
    } finally {
      owned.closeFd();
    }
  });

  it('boundary: quarantine path swapped after proof — foreign survives, no foreign unlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-post-proof-swap-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignBytes = 'FOREIGN_POST_PROOF_SWAP\n';
    let swappedPath = '';
    try {
      expect(() =>
        containOwnedLockSentinelOrFail(owned, {
          afterProofBeforeDispose: (ctx) => {
            swappedPath = ctx.quarantinePath;
            unlinkSync(ctx.quarantinePath);
            writeFileSync(ctx.quarantinePath, foreignBytes, 'utf8');
          },
        }),
      ).toThrow(/swapped after proof|refusing contain/i);

      expect(swappedPath).toBeTruthy();
      expect(existsSync(swappedPath)).toBe(true);
      expect(readFileSync(swappedPath, 'utf8')).toBe(foreignBytes);
      // lockPath still never unlinked by production (owned hardlink or residual)
      expect(
        readdirSync(path.join(root, '.next'), { withFileTypes: true }).some((d) => d.isDirectory()),
      ).toBe(true);
    } finally {
      owned.closeFd();
    }
  });
});
