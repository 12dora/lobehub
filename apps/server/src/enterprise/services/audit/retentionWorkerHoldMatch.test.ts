// @vitest-environment node
/**
 * Characterization of holdTargetIdHeld: whitelist exact targetType+targetId,
 * over-skip unknown/missing types. Do not "fix" over-skip to under-skip.
 */
import { describe, expect, it } from 'vitest';

import type { HoldIndex } from './retentionWorkerHoldMatch';
import { holdTargetIdHeld } from './retentionWorkerHoldMatch';

const emptyIndex = (): HoldIndex => ({
  global: false,
  sessions: new Set(),
  topics: new Set(),
  users: new Set(),
  workspaces: new Set(),
});

describe('holdTargetIdHeld', () => {
  it('matches the whitelisted set for a hold-relevant targetType', () => {
    const index: HoldIndex = { ...emptyIndex(), users: new Set(['u1']) };
    expect(holdTargetIdHeld(index, 'u1', 'user')).toBe(true);
    expect(holdTargetIdHeld(index, 'u2', 'user')).toBe(false);
    // Whitelist miss does not fall through to over-skip against other sets.
    expect(holdTargetIdHeld({ ...emptyIndex(), sessions: new Set(['u1']) }, 'u1', 'user')).toBe(
      false,
    );
  });

  it('over-skips unknown or missing targetType against any held id', () => {
    const index: HoldIndex = { ...emptyIndex(), topics: new Set(['x1']) };
    expect(holdTargetIdHeld(index, 'x1', 'settings')).toBe(true);
    expect(holdTargetIdHeld(index, 'x1', undefined)).toBe(true);
    expect(holdTargetIdHeld(index, 'x1', null)).toBe(true);
    expect(holdTargetIdHeld(index, 'x2', 'settings')).toBe(false);
  });
});
