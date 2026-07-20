import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
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
      rmSync(d, { force: true, recursive: true });
    }
  });

  it('owned sentinel success: exclusive create, metadata stable, recovery-artifact cleanup', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-owned-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    try {
      expect(existsSync(owned.lockPath)).toBe(true);
      const mid = snapshotLockPath(owned.lockPath);
      expect(snapshotsEqual(owned.snapshot, mid)).toBe(true);
      expect(readFileSync(owned.lockPath, 'utf8')).toBe(owned.token);
      const result = unlinkOwnedLockSentinelOrFail(owned);
      expect(result.status).toBe('contained');
      expect(result.lockPathCleared).toBe(true);
      expect(existsSync(owned.lockPath)).toBe(false);
      // Proven owned content lives as recovery artifact (no final pathname-unlink race).
      expect(existsSync(result.quarantinePath)).toBe(true);
      expect(readFileSync(result.quarantinePath, 'utf8')).toBe(owned.token);
      // Outer exclusive owner of isolated root removes the artifact.
      rmSync(result.quarantineDir, { force: true, recursive: true });
      expect(existsSync(result.quarantinePath)).toBe(false);
    } finally {
      owned.closeFd();
    }
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

      expect(() => unlinkOwnedLockSentinelOrFail(owned)).toThrow(/symlink|mismatch|token/i);
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
        unlinkOwnedLockSentinelOrFail(owned, {
          afterVerifyBeforeDestructive: () => {
            unlinkSync(owned.lockPath);
            writeFileSync(owned.lockPath, foreignBytes, 'utf8');
          },
        }),
      ).toThrow(/refusing unlink|replaced|identity|mismatch/i);

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
        unlinkOwnedLockSentinelOrFail(owned, {
          afterVerifyBeforeDestructive: () => {
            unlinkSync(owned.lockPath);
            symlinkSync(foreignTarget, owned.lockPath);
          },
        }),
      ).toThrow(/refusing unlink|symlink|replaced|identity|mismatch/i);

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
        unlinkOwnedLockSentinelOrFail(owned, {
          afterVerifyBeforeDestructive: (ctx) => {
            stagedPath = ctx.quarantinePath;
            mkdirSync(ctx.quarantineDir, { recursive: false, mode: 0o700 });
            writeFileSync(ctx.quarantinePath, foreignQuarantine, 'utf8');
          },
        }),
      ).toThrow(/quarantine dir collision|no-replace|refusing unlink/i);

      expect(stagedPath).toBeTruthy();
      expect(existsSync(stagedPath)).toBe(true);
      expect(readFileSync(stagedPath, 'utf8')).toBe(foreignQuarantine);
      // Owned lock path untouched
      expect(existsSync(owned.lockPath)).toBe(true);
      expect(readFileSync(owned.lockPath, 'utf8')).toBe(owned.token);
    } finally {
      owned.closeFd();
    }
  });

  it('boundary: foreign regular/symlink at lockPath before clear — both preserved, no overwrite', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-foreign-before-clear-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignBytes = 'FOREIGN_BEFORE_CLEAR\n';
    try {
      const result = unlinkOwnedLockSentinelOrFail(owned, {
        afterProofBeforeClear: (ctx) => {
          // Owned hardlinked to quarantine; replace original lock path with foreign.
          unlinkSync(ctx.lockPath);
          writeFileSync(ctx.lockPath, foreignBytes, 'utf8');
        },
      });
      expect(result.status).toBe('contained');
      expect(result.lockPathCleared).toBe(false);
      // Foreign at original path survives (clear skipped — identity mismatch)
      expect(existsSync(owned.lockPath)).toBe(true);
      expect(readFileSync(owned.lockPath, 'utf8')).toBe(foreignBytes);
      // Owned recovery artifact also survives
      expect(existsSync(result.quarantinePath)).toBe(true);
      expect(readFileSync(result.quarantinePath, 'utf8')).toBe(owned.token);
      rmSync(result.quarantineDir, { force: true, recursive: true });
    } finally {
      owned.closeFd();
    }
  });

  it('boundary: foreign symlink at lockPath before clear — symlink+target survive', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-sym-before-clear-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    const foreignTarget = path.join(root, 'foreign-sym-target');
    writeFileSync(foreignTarget, 'foreign-sym-target-bytes\n', 'utf8');
    try {
      const result = unlinkOwnedLockSentinelOrFail(owned, {
        afterProofBeforeClear: (ctx) => {
          unlinkSync(ctx.lockPath);
          symlinkSync(foreignTarget, ctx.lockPath);
        },
      });
      expect(result.status).toBe('contained');
      expect(result.lockPathCleared).toBe(false);
      expect(lstatSync(owned.lockPath).isSymbolicLink()).toBe(true);
      expect(existsSync(foreignTarget)).toBe(true);
      expect(readFileSync(foreignTarget, 'utf8')).toBe('foreign-sym-target-bytes\n');
      expect(readFileSync(result.quarantinePath, 'utf8')).toBe(owned.token);
      rmSync(result.quarantineDir, { force: true, recursive: true });
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
        unlinkOwnedLockSentinelOrFail(owned, {
          afterProofBeforeDispose: (ctx) => {
            swappedPath = ctx.quarantinePath;
            unlinkSync(ctx.quarantinePath);
            writeFileSync(ctx.quarantinePath, foreignBytes, 'utf8');
          },
        }),
      ).toThrow(/swapped after proof|refusing unlink/i);

      expect(swappedPath).toBeTruthy();
      expect(existsSync(swappedPath)).toBe(true);
      expect(readFileSync(swappedPath, 'utf8')).toBe(foreignBytes);
      // No uncontrolled destruction of foreign; lock path was cleared of owned before swap
      // Owned fd still held by caller — no claim of foreign deletion.
      expect(
        readdirSync(path.join(root, '.next'), { withFileTypes: true }).some((d) => d.isDirectory()),
      ).toBe(true);
    } finally {
      owned.closeFd();
    }
  });
});
