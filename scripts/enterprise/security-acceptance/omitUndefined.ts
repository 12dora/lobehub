/**
 * Strip explicit undefined keys so canonical JSON / digests never see undefined.
 * Zod optional fields and object literals with `reason: undefined` otherwise break digests.
 */

export type Jsonish = null | boolean | number | string | Jsonish[] | { [key: string]: Jsonish };

/**
 * Deep-clone plain data, omitting keys whose value is undefined.
 * Arrays may not contain undefined holes.
 */
export const omitUndefinedDeep = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === undefined) {
        throw new Error('Array element is undefined');
      }
      return omitUndefinedDeep(item);
    }) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // Non-plain objects: return as-is (should not appear in artifacts).
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    out[key] = omitUndefinedDeep(child);
  }
  return out as T;
};

/** Assert no undefined remains (for tests / pre-digest guard). */
export const assertNoUndefinedDeep = (value: unknown, path = '$'): void => {
  if (value === undefined) {
    throw new Error(`Undefined at ${path}`);
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefinedDeep(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertNoUndefinedDeep(child, `${path}.${key}`);
  }
};
