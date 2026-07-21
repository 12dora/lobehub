/**
 * Deterministic canonical JSON for signature payloads and recovery digests.
 *
 * Encoding rules (v1 bytes; deliberate security surface):
 * - Recursive plain objects / null-prototype objects only.
 * - All own enumerable string keys preserved, including `__proto__` / `constructor`.
 * - Keys sorted by exact UTF-16 code-unit order (`<`/`>`), never localeCompare.
 * - Arrays preserve order; undefined and non-finite numbers rejected.
 *
 * Builds intermediate maps with Object.create(null) + defineProperty so assigning
 * the key "__proto__" never mutates Object.prototype.
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

export const canonicalize = (value: unknown): string => {
  const normalized = normalize(value);
  return JSON.stringify(normalized);
};

const setOwn = (target: Record<string, JsonValue>, key: string, child: JsonValue): void => {
  Object.defineProperty(target, key, {
    value: child,
    enumerable: true,
    writable: true,
    configurable: true,
  });
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
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error('Canonical JSON rejects non-plain objects');
    }
    const record = value as Record<string, unknown>;
    // Own enumerable keys only; includes __proto__ when it is an own data property
    // (e.g. from JSON.parse('{"__proto__":1}')).
    const keys = Object.keys(record).sort(compareCodeUnits);
    const out = Object.create(null) as Record<string, JsonValue>;
    for (const key of keys) {
      // Use getOwnPropertyDescriptor to read own keys without prototype chain.
      const desc = Object.getOwnPropertyDescriptor(record, key);
      if (!desc || !desc.enumerable) continue;
      const child = desc.value;
      if (child === undefined) {
        throw new Error(`Canonical JSON rejects undefined at key ${key}`);
      }
      setOwn(out, key, normalize(child));
    }
    return out;
  }
  throw new Error('Canonical JSON rejects unsupported value types');
};

export const sha256HexOfCanonical = async (value: unknown): Promise<string> =>
  sha256HexOfCanonicalSync(value);

export const sha256HexOfCanonicalSync = (value: unknown): string =>
  createHash('sha256').update(canonicalize(value)).digest('hex');
