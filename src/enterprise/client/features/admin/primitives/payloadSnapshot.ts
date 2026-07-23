/**
 * Canonical immutable mutation payloads for admin danger modals.
 *
 * - structuredClone at confirm time creates a private canonical snapshot
 * - deepFreeze hardens plain objects/arrays (Date internals remain mutable in JS)
 * - each mutation attempt receives a fresh structuredClone of the canonical
 *   so first-call mutation of arrays/objects/Dates cannot affect retry
 */

/** Deep-freeze plain objects and arrays. Date objects are frozen but note:
 *  freeze does not block Date mutators — re-clone from canonical per attempt. */
export const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') return value;

  Object.freeze(value);

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return value;
  }

  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
};

/** Private canonical snapshot — never hand this reference to onSubmit. */
export const createCanonicalSnapshot = <T>(value: T): T => {
  const clone = structuredClone(value);
  return deepFreeze(clone);
};

/** Fresh attempt clone derived from the untouched canonical. */
export const cloneFromCanonical = <T>(canonical: T): T => {
  const next = structuredClone(canonical);
  return deepFreeze(next);
};
