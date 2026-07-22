import { describe, expect, it } from 'vitest';

import { generatePassword, PASSWORD_CHARSET, PASSWORD_LENGTH } from './generatePassword';

const UPPER = /[A-Z]/;
const LOWER = /[a-z]/;
const DIGIT = /\d/;
const SYMBOL = /[!@#$%^&*\-_=+?]/;

const ITERATIONS = 500;

describe('generatePassword', () => {
  it('always produces the fixed length within the server policy (8–64)', () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(PASSWORD_LENGTH);
      expect(password.length).toBeGreaterThanOrEqual(8);
      expect(password.length).toBeLessThanOrEqual(64);
    }
  });

  it('guarantees at least one upper, lower, digit, and symbol on every draw', () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const password = generatePassword();
      expect(password).toMatch(UPPER);
      expect(password).toMatch(LOWER);
      expect(password).toMatch(DIGIT);
      expect(password).toMatch(SYMBOL);
    }
  });

  it('only draws from the allowed charset (no ambiguous glyphs)', () => {
    const allowed = new Set(PASSWORD_CHARSET);
    for (let i = 0; i < ITERATIONS; i += 1) {
      for (const char of generatePassword()) {
        expect(allowed.has(char)).toBe(true);
      }
    }
    // Ambiguous glyphs are excluded from the charset itself.
    for (const ambiguous of ['I', 'l', 'O', '0', '1', 'i', 'o', 'L']) {
      expect(allowed.has(ambiguous)).toBe(false);
    }
  });

  it('produces distinct passwords across draws', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(seen.size).toBe(50);
  });
});
