import { describe, expect, it } from 'vitest';

import { computeJsonDiff, formatJsonValue } from './jsonDiff';

describe('computeJsonDiff', () => {
  it('detects added, removed, and changed keys', () => {
    const lines = computeJsonDiff({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, d: 4 });
    const byPath = Object.fromEntries(lines.map((l) => [l.path, l.kind]));
    expect(byPath.a).toBe('same');
    expect(byPath.b).toBe('changed');
    expect(byPath.c).toBe('removed');
    expect(byPath.d).toBe('added');
  });

  it('recurses into nested objects', () => {
    const lines = computeJsonDiff(
      { user: { name: 'a', role: 'x' } },
      { user: { name: 'b', role: 'x' } },
    );
    const name = lines.find((l) => l.path === 'user.name');
    expect(name?.kind).toBe('changed');
    expect(name?.before).toBe('a');
    expect(name?.after).toBe('b');
  });

  it('handles null sides as empty objects for key walk', () => {
    const lines = computeJsonDiff(null, { a: 1 });
    expect(lines.some((l) => l.kind === 'added' && l.path === 'a')).toBe(true);
  });

  it('formats JSON values', () => {
    expect(formatJsonValue({ x: 1 })).toContain('"x"');
    expect(formatJsonValue(undefined)).toBe('undefined');
  });

  it('treats non-serializable values as opaque changes without throwing', () => {
    const before = { n: 1n };
    const after = { n: 2n };
    expect(() => computeJsonDiff(before, after)).not.toThrow();
    const line = computeJsonDiff(before, after).find((l) => l.path === 'n');
    expect(line?.kind).toBe('changed');
    expect(formatJsonValue(1n)).toBe('1');
  });
});
