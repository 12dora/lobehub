import { describe, expect, it } from 'vitest';

import { cloneFromCanonical, createCanonicalSnapshot, deepFreeze } from './payloadSnapshot';

describe('payloadSnapshot', () => {
  it('createCanonicalSnapshot freezes structure; cloneFromCanonical isolates Date/array mutation', () => {
    const original = {
      expiresAt: new Date('2025-06-01T12:00:00.000Z'),
      reason: 'abuse',
      roleNames: ['user_admin', 'auditor'],
    };

    const canonical = createCanonicalSnapshot(original);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.roleNames)).toBe(true);

    const attempt1 = cloneFromCanonical(canonical);
    // Date internals remain mutable under freeze — must re-clone from canonical.
    attempt1.expiresAt.setTime(0);
    // Structural freeze should reject array/object writes
    expect(() => attempt1.roleNames.push('super_admin')).toThrow();
    expect(() => {
      (attempt1 as { reason: string }).reason = 'mutated';
    }).toThrow();

    const attempt2 = cloneFromCanonical(canonical);
    expect(attempt2.reason).toBe('abuse');
    expect(attempt2.roleNames).toEqual(['user_admin', 'auditor']);
    expect(attempt2.expiresAt.toISOString()).toBe('2025-06-01T12:00:00.000Z');
    // Canonical Date never shared with attempt1
    expect((canonical as { expiresAt: Date }).expiresAt.toISOString()).toBe(
      '2025-06-01T12:00:00.000Z',
    );
  });

  it('deepFreeze is recursive', () => {
    const o = { nested: { a: 1 }, list: [{ b: 2 }] };
    deepFreeze(o);
    expect(Object.isFrozen(o.nested)).toBe(true);
    expect(Object.isFrozen(o.list[0])).toBe(true);
  });
});
