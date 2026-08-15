import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToLatin1,
  compareBytes,
  concatBytes,
  decodeBase64Latin1,
  decodeBase64Utf8,
  encodeLatin1Base64,
  encodeUtf8Base64,
  estimateTokens,
  hexToBytes,
  latin1ToBytes,
  randomUuid,
} from './binary';

describe('base64 helpers', () => {
  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['hello world', 'aGVsbG8gd29ybGQ='],
    ['naïve', 'bmHDr3Zl'],
    ['中', '5Lit'],
  ])('round-trips %s', (input, expected) => {
    expect(encodeUtf8Base64(input)).toBe(expected);
    expect(decodeBase64Utf8(expected)).toBe(input);
  });

  it('matches the platform implementation for raw bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const encoded = bytesToBase64(bytes);
    expect([...base64ToBytes(encoded)]).toEqual([...bytes]);
  });

  it('rejects invalid base64', () => {
    expect(() => base64ToBytes('not base64!!')).toThrow(TypeError);
  });
});

describe('hex helpers', () => {
  it('round-trips', () => {
    expect(bytesToHex(hexToBytes('00ff10'))).toBe('00ff10');
    expect(() => hexToBytes('abc')).toThrow(TypeError);
  });

  it.each([
    ['abc', 'odd length'],
    ['0g', 'a non-hex digit that parseInt would silently accept as 0'],
    ['zz', 'non-hex digits'],
    ['00 ff', 'embedded whitespace'],
    ['0x00', 'a 0x prefix'],
  ])('rejects %s (%s)', (input) => {
    expect(() => hexToBytes(input)).toThrow(TypeError);
  });

  it('enforces the byte cap', () => {
    expect(() => hexToBytes('ff'.repeat(65), 64)).toThrow(TypeError);
    expect(hexToBytes('ff'.repeat(64), 64)).toHaveLength(64);
  });
});

describe('latin1 helpers', () => {
  it('maps every byte to the code unit of the same value (atob semantics)', () => {
    const bytes = new Uint8Array(256).map((_value, index) => index);
    const text = bytesToLatin1(bytes);

    expect(text).toHaveLength(256);
    expect(text.codePointAt(0)).toBe(0);
    expect(text.codePointAt(255)).toBe(255);
    expect([...latin1ToBytes(text)]).toEqual([...bytes]);
  });

  it('round-trips through base64 without a UTF-8 decode mangling the bytes', () => {
    // 0xFF 0xFE is not valid UTF-8 — `TextDecoder` would replace it with U+FFFD
    const bytes = new Uint8Array([0xff, 0xfe, 0x41]);
    const encoded = bytesToBase64(bytes);

    expect([...latin1ToBytes(decodeBase64Latin1(encoded))]).toEqual([...bytes]);
    expect(encodeLatin1Base64(decodeBase64Latin1(encoded))).toBe(encoded);
    expect(decodeBase64Utf8(encoded)).not.toBe(decodeBase64Latin1(encoded));
  });
});

describe('compareBytes', () => {
  it.each([
    [[0], [1], -1],
    [[1], [0], 1],
    [[1, 2], [1, 2], 0],
    [[1], [1, 2], -1],
    [[255, 255], [255, 254], 1],
  ])('compares %s with %s', (left, right, expected) => {
    expect(compareBytes(new Uint8Array(left), new Uint8Array(right))).toBe(expected);
  });
});

describe('concatBytes', () => {
  it('joins chunks in order', () => {
    expect([...concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]))]).toEqual([1, 2, 3]);
  });
});

describe('randomUuid', () => {
  it('produces a v4 uuid', () => {
    expect(randomUuid()).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
  });
});

describe('estimateTokens', () => {
  it('counts CJK heavier than ascii', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('中文字')).toBe(3);
  });
});
