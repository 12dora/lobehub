// @vitest-environment node
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { checksumPayload } from './checksum';

/** Independent expected digests — must not call checksumPayload to build them. */
const sha256OfCanonicalJson = (canonical: string) =>
  createHash('sha256').update(canonical).digest('hex');

describe('checksumPayload', () => {
  it('matches hard-coded SHA-256 vectors for primitives and empty object', () => {
    expect(checksumPayload({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    expect(checksumPayload(null)).toBe(
      '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    );
    expect(checksumPayload('hello')).toBe(
      '5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a',
    );
    expect(checksumPayload(42)).toBe(
      '73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049',
    );
    expect(checksumPayload(true)).toBe(
      'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
    );
  });

  it('is stable under object key insertion order (top-level and nested)', () => {
    const expected = sha256OfCanonicalJson('{"a":1,"b":2}');
    expect(checksumPayload({ a: 1, b: 2 })).toBe(expected);
    expect(checksumPayload({ b: 2, a: 1 })).toBe(expected);

    const nestedExpected = sha256OfCanonicalJson('{"outer":{"a":1,"b":2}}');
    expect(checksumPayload({ outer: { a: 1, b: 2 } })).toBe(nestedExpected);
    expect(checksumPayload({ outer: { b: 2, a: 1 } })).toBe(nestedExpected);
    // Outer key order also canonicalized.
    expect(checksumPayload({ z: 0, outer: { b: 2, a: 1 } })).toBe(
      checksumPayload({ outer: { a: 1, b: 2 }, z: 0 }),
    );
  });

  it('preserves array element order while canonicalizing nested objects', () => {
    const expected = sha256OfCanonicalJson('[1,{"a":1,"b":2}]');
    expect(checksumPayload([1, { a: 1, b: 2 }])).toBe(expected);
    expect(checksumPayload([1, { b: 2, a: 1 }])).toBe(expected);

    // Array order is semantic — reordering elements must change the digest.
    expect(checksumPayload([1, 2])).not.toBe(checksumPayload([2, 1]));
  });

  it('rejects non-JSON-compatible values that JSON.stringify cannot encode', () => {
    // JSON.stringify(undefined) returns undefined (not a string) → .update throws.
    expect(() => checksumPayload(undefined)).toThrow();
    // BigInt is not JSON-serializable.
    expect(() => checksumPayload({ n: 1n })).toThrow();
  });
});
