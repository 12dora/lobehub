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

  it('marks the whole node changed when only one side is an object, then walks its keys', () => {
    const lines = computeJsonDiff(1, { a: 1 });
    expect(lines[0]).toMatchObject({ after: { a: 1 }, before: 1, kind: 'changed', path: '(root)' });
    expect(lines[1]).toMatchObject({ after: 1, kind: 'added', path: 'a' });
  });

  it('reports keys in sorted order', () => {
    const lines = computeJsonDiff({ b: 1, a: 1 }, { b: 1, a: 1 });
    expect(lines.map((l) => l.path)).toEqual(['a', 'b']);
  });

  it('treats arrays as opaque values rather than recursing', () => {
    expect(computeJsonDiff({ a: [1, 2] }, { a: [1, 2] })[0].kind).toBe('same');
    const changed = computeJsonDiff({ a: [1, 2] }, { a: [1, 3] });
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ kind: 'changed', path: 'a' });
  });

  it('reports root scalars as added / removed / same', () => {
    expect(computeJsonDiff(undefined, undefined)).toEqual([]);
    expect(computeJsonDiff('x', undefined)[0]).toMatchObject({ kind: 'removed', path: '(root)' });
    expect(computeJsonDiff(undefined, 'x')[0]).toMatchObject({ kind: 'added', path: '(root)' });
    expect(computeJsonDiff('x', 'x')[0]).toMatchObject({ kind: 'same', path: '(root)' });
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
