/**
 * Deterministic canonical JSON for signature payloads and recovery digests.
 *
 * Encoding rules (v1.1 bytes — direct recursive serializer):
 * - Primitives use strict JSON semantics (JSON.stringify for strings/numbers).
 * - Arrays preserve order and recursively serialize elements.
 * - Objects: plain Object.prototype or null prototype only; own enumerable
 *   string keys only (including `__proto__`, integer-like keys, Unicode).
 * - Keys sorted by exact UTF-16 code-unit order (`a < b` / `a > b`); equality
 *   only for identical strings. Never localeCompare / Unicode normalization.
 * - Emit `JSON.stringify(key) + ':' + canonical(value)` in sort order.
 *   Do **not** rebuild a JS object and call `JSON.stringify` on it: ECMAScript
 *   reorders integer-index keys numerically, which would break code-unit order
 *   (e.g. keys "10" then "2" must stay `{"10":…,"2":…}`, not `{"2":…,"10":…}`).
 * - Reject undefined, non-finite numbers, accessors, cycles, non-plain objects.
 *
 * Version note: v1 intermediate-object + JSON.stringify mis-ordered integer-like
 * keys. v1.1 fixes emission order without changing ordinary string-key payload
 * shapes used by provenance signatures. Fixtures that depend on integer-like
 * key order must assert exact bytes under this serializer.
 */
import { createHash } from 'node:crypto';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** UTF-16 code-unit total order; equality only for exact string identity. */
export const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/**
 * Direct recursive canonical JSON string. Safe for signature material.
 */
export const canonicalize = (value: unknown): string => serialize(value, new WeakSet<object>());

const serialize = (value: unknown, seen: WeakSet<object>): string => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical JSON rejects non-finite numbers');
    }
    // JSON number form (no leading +, no hex); matches JSON.stringify for finite numbers.
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error('Canonical JSON rejects cyclic structures');
    }
    seen.add(value);
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      if (item === undefined) {
        throw new Error(`Canonical JSON rejects undefined at array index ${i}`);
      }
      parts.push(serialize(item, seen));
    }
    seen.delete(value);
    return `[${parts.join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error('Canonical JSON rejects non-plain objects');
    }
    if (seen.has(value)) {
      throw new Error('Canonical JSON rejects cyclic structures');
    }
    seen.add(value);

    const record = value as Record<string, unknown>;
    // Own enumerable string keys only; includes __proto__ when own data property.
    const keys = Object.keys(record).sort(compareCodeUnits);
    const parts: string[] = [];
    for (const key of keys) {
      const desc = Object.getOwnPropertyDescriptor(record, key);
      if (!desc || !desc.enumerable) continue;
      if (typeof desc.get === 'function' || typeof desc.set === 'function') {
        throw new Error(`Canonical JSON rejects accessor property at key ${key}`);
      }
      const child = desc.value;
      if (child === undefined) {
        throw new Error(`Canonical JSON rejects undefined at key ${key}`);
      }
      parts.push(`${JSON.stringify(key)}:${serialize(child, seen)}`);
    }
    seen.delete(value);
    return `{${parts.join(',')}}`;
  }
  throw new Error('Canonical JSON rejects unsupported value types');
};

export const sha256HexOfCanonical = async (value: unknown): Promise<string> =>
  sha256HexOfCanonicalSync(value);

export const sha256HexOfCanonicalSync = (value: unknown): string =>
  createHash('sha256').update(canonicalize(value)).digest('hex');
