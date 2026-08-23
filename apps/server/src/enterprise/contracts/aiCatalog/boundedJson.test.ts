import { describe, expect, it } from 'vitest';

import {
  BOUNDED_JSON_MAX_KEYS_PER_OBJECT,
  BOUNDED_JSON_MAX_SERIALIZED_BYTES,
  boundedJsonObjectSchema,
} from './boundedJson';

describe('boundedJsonObjectSchema', () => {
  it('rejects values JSON.stringify cannot serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circularResult = boundedJsonObjectSchema.safeParse(circular);
    expect(circularResult.success).toBe(false);
    if (!circularResult.success) {
      expect(
        circularResult.error.issues.some((issue) => /not serializable/i.test(issue.message)),
      ).toBe(true);
    }

    const bigintResult = boundedJsonObjectSchema.safeParse({ n: 1n });
    expect(bigintResult.success).toBe(false);
    if (!bigintResult.success) {
      expect(
        bigintResult.error.issues.some((issue) => /not serializable/i.test(issue.message)),
      ).toBe(true);
    }
  });

  it('rejects over-size payloads and over-wide objects', () => {
    const overSize = boundedJsonObjectSchema.safeParse({
      blob: 'y'.repeat(BOUNDED_JSON_MAX_SERIALIZED_BYTES),
    });
    expect(overSize.success).toBe(false);
    if (!overSize.success) {
      expect(overSize.error.issues.some((issue) => /serialized size/i.test(issue.message))).toBe(
        true,
      );
    }

    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < BOUNDED_JSON_MAX_KEYS_PER_OBJECT + 1; i += 1) {
      manyKeys[`k${i}`] = i;
    }
    expect(boundedJsonObjectSchema.safeParse(manyKeys).success).toBe(false);
  });

  it('does not walk children of a rejected sensitive key', () => {
    const result = boundedJsonObjectSchema.safeParse({
      apiKey: { nestedSecret: 'still-a-secret-value-that-is-long' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.message === 'sensitive key is not allowed'),
      ).toBe(true);
    }
  });
});
