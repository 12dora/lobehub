/**
 * Initial-password generator for admin-provisioned credential users.
 *
 * - `crypto.getRandomValues` only — never `Math.random`
 * - rejection sampling (no modulo bias)
 * - guarantees ≥1 uppercase, lowercase, digit, and symbol
 * - ambiguous glyphs excluded (I/l/O/0/1) so the one-time panel is transcribable
 * - length 16 satisfies the server policy (`adminUsersCreateInputSchema`: 8–64)
 */

const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';

export const PASSWORD_CHARSET = UPPER + LOWER + DIGITS + SYMBOLS;
export const PASSWORD_LENGTH = 16;

/** Uniform integer in [0, bound) via rejection sampling over one random byte. */
const randomIndex = (bound: number): number => {
  // bound ≤ 87 (full charset) so a single byte always has acceptance room.
  const limit = Math.floor(256 / bound) * bound;
  const buffer = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % bound;
  }
};

const pick = (charset: string): string => charset[randomIndex(charset.length)];

export const generatePassword = (): string => {
  // One guaranteed character per class, remainder from the full charset.
  const chars = [
    pick(UPPER),
    pick(LOWER),
    pick(DIGITS),
    pick(SYMBOLS),
    ...Array.from({ length: PASSWORD_LENGTH - 4 }, () => pick(PASSWORD_CHARSET)),
  ];

  // Fisher–Yates shuffle so the guaranteed classes are not position-biased.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
};
