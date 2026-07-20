import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

  it('owned sentinel success: exclusive create, metadata stable, robust unlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-owned-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    try {
      expect(existsSync(owned.lockPath)).toBe(true);
      const mid = snapshotLockPath(owned.lockPath);
      expect(snapshotsEqual(owned.snapshot, mid)).toBe(true);
      expect(readFileSync(owned.lockPath, 'utf8')).toBe(owned.token);
      unlinkOwnedLockSentinelOrFail(owned);
      expect(existsSync(owned.lockPath)).toBe(false);
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

    // Simulate read-only observation (never open for write)
    const after = snapshotLockPath(lockPath);
    expect(snapshotsEqual(before, after)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(foreign);
  });

  it('symlink replacement must not unlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-lock-symlink-'));
    temps.push(root);
    const owned = createOwnedLockSentinel(root);
    try {
      // Replace owned path with a symlink to a foreign target
      const foreignTarget = path.join(root, 'foreign-target');
      writeFileSync(foreignTarget, 'foreign\n', 'utf8');
      unlinkSync(owned.lockPath);
      symlinkSync(foreignTarget, owned.lockPath);

      expect(() => unlinkOwnedLockSentinelOrFail(owned)).toThrow(/symlink|mismatch|token/i);
      // Foreign target must remain
      expect(existsSync(foreignTarget)).toBe(true);
      expect(readFileSync(foreignTarget, 'utf8')).toBe('foreign\n');
    } finally {
      owned.closeFd();
    }
  });
});
