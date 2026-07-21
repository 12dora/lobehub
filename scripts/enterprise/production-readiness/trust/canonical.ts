/**
 * Deterministic canonical JSON for signature payloads (sorted keys, no whitespace).
 * Rejects non-JSON-safe values and undefined.
 */
import { createHash } from 'node:crypto';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const canonicalize = (value: unknown): string => {
  const normalized = normalize(value);
  return JSON.stringify(normalized);
};

const normalize = (value: unknown): JsonValue => {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Canonical JSON rejects non-finite numbers');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }
  if (value && typeof value === 'object') {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error('Canonical JSON rejects non-plain objects');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b, 'en'));
    const out: { [key: string]: JsonValue } = {};
    for (const key of keys) {
      const child = record[key];
      if (child === undefined) {
        throw new Error(`Canonical JSON rejects undefined at key ${key}`);
      }
      out[key] = normalize(child);
    }
    return out;
  }
  throw new Error('Canonical JSON rejects unsupported value types');
};

export const sha256HexOfCanonical = async (value: unknown): Promise<string> =>
  sha256HexOfCanonicalSync(value);

export const sha256HexOfCanonicalSync = (value: unknown): string =>
  createHash('sha256').update(canonicalize(value)).digest('hex');
