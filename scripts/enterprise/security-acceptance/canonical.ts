/**
 * Deterministic canonical JSON for report core digests (no localeCompare).
 * Mirrors production-readiness trust/canonical rules for integer-key order safety.
 */
import { createHash } from 'node:crypto';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

export const canonicalize = (value: unknown): string => serialize(value, new WeakSet<object>());

const serialize = (value: unknown, seen: WeakSet<object>): string => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical JSON rejects non-finite numbers');
    }
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
    const keys = Object.keys(record).sort(compareCodeUnits);
    const parts: string[] = [];
    for (const key of keys) {
      const child = record[key];
      if (child === undefined) {
        throw new Error(`Canonical JSON rejects undefined at key ${key}`);
      }
      parts.push(`${JSON.stringify(key)}:${serialize(child, seen)}`);
    }
    seen.delete(value);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`Canonical JSON rejects type ${typeof value}`);
};

export const digestCanonical = (value: unknown): string =>
  createHash('sha256').update(canonicalize(value)).digest('hex');

export const serializePretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
