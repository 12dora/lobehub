/**
 * Isomorphic byte helpers. `packages/model-runtime` is bundled into the browser
 * SPA, so nothing here may touch `node:*` or `Buffer`.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8Encode = (input: string): Uint8Array => encoder.encode(input);

export const utf8Decode = (bytes: Uint8Array): string => decoder.decode(bytes);

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (with padding) of raw bytes. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 63];
  }
  return out;
};

const BASE64_LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export const base64ToBytes = (input: string): Uint8Array => {
  const clean = input.replaceAll(/[\n\r\t ]/g, '').replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let index = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? BASE64_LOOKUP[code] : -1;
    if (value < 0) throw new TypeError('invalid base64 input');
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (acc >> bits) & 0xff;
      index += 1;
    }
  }
  return out.subarray(0, index);
};

export const encodeUtf8Base64 = (input: string): string => bytesToBase64(utf8Encode(input));

export const decodeBase64Utf8 = (input: string): string => utf8Decode(base64ToBytes(input));

/**
 * `atob`/`btoa` semantics: one character per byte, code points 0-255. The
 * turnstile program is decoded this way in the browser, so a UTF-8 decode would
 * mangle the bytes the XOR step depends on.
 */
export const bytesToLatin1 = (bytes: Uint8Array): string => {
  let out = '';
  // chunked to stay clear of the argument-count limit on large payloads
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
};

export const latin1ToBytes = (input: string): Uint8Array => {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) out[i] = input.charCodeAt(i) & 0xff;
  return out;
};

export const decodeBase64Latin1 = (input: string): string => bytesToLatin1(base64ToBytes(input));

export const encodeLatin1Base64 = (input: string): string => bytesToBase64(latin1ToBytes(input));

export const bytesToHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
};

const HEX_RE = /^[\da-f]*$/i;

/**
 * `Number.parseInt('0g', 16)` happily returns `0`, so a per-pair parse silently
 * accepts malformed input — validate the whole string up front instead.
 *
 * @param maxBytes reject anything longer (the sentinel difficulty is ≤ 64 bytes)
 */
export const hexToBytes = (hex: string, maxBytes?: number): Uint8Array => {
  if (hex.length % 2 !== 0) throw new TypeError('hex string must have an even length');
  if (!HEX_RE.test(hex)) throw new TypeError('invalid hex string');
  if (maxBytes !== undefined && hex.length / 2 > maxBytes)
    throw new TypeError(`hex string exceeds ${maxBytes} bytes`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Lexicographic byte comparison: -1 / 0 / 1. */
export const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
};

export const concatBytes = (...chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export const randomUuid = (): string => {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoRef?.getRandomValues) cryptoRef.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Cheap token estimator used for usage reporting when the upstream gives us no
 * counters. ASCII ≈ 4 chars/token, CJK ≈ 1 char/token.
 */
export const estimateTokens = (text: string | undefined | null): number => {
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x2e_80 && code <= 0x9f_ff) ||
      (code >= 0xac_00 && code <= 0xd7_af) ||
      (code >= 0xf9_00 && code <= 0xfa_ff)
    )
      cjk += 1;
  }
  const rest = [...text].length - cjk;
  return Math.ceil(cjk + rest / 4);
};
