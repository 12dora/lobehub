export type JsonDiffKind = 'added' | 'removed' | 'changed' | 'same';

export interface JsonDiffLine {
  after?: unknown;
  before?: unknown;
  kind: JsonDiffKind;
  /** Path segments joined with `.` (empty for root scalar). */
  path: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pathKey = (base: string, key: string) => (base ? `${base}.${key}` : key);

/** Nodes with no key path of their own are reported under an explicit root label. */
const nodePath = (basePath: string) => basePath || '(root)';

/** Safe equality for values that may include BigInt / circular / non-JSON types. */
const valuesEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Non-serializable (e.g. BigInt): treat as opaque change unless same ref.
    return false;
  }
};

/** Diff for one key present on either side; recurses when either side is itself an object. */
const diffKey = (
  beforeObj: Record<string, unknown>,
  afterObj: Record<string, unknown>,
  key: string,
  nextPath: string,
): JsonDiffLine[] => {
  const hasBefore = Object.prototype.hasOwnProperty.call(beforeObj, key);
  const hasAfter = Object.prototype.hasOwnProperty.call(afterObj, key);

  if (hasBefore && !hasAfter) return [{ path: nextPath, kind: 'removed', before: beforeObj[key] }];
  if (!hasBefore && hasAfter) return [{ path: nextPath, kind: 'added', after: afterObj[key] }];

  const b = beforeObj[key];
  const a = afterObj[key];
  if (isPlainObject(b) || isPlainObject(a)) return computeJsonDiff(b, a, nextPath);

  return [{ path: nextPath, kind: valuesEqual(b, a) ? 'same' : 'changed', before: b, after: a }];
};

/** Key-level walk used when at least one side is a plain object. Keys are reported sorted. */
const diffObjectNode = (before: unknown, after: unknown, basePath: string): JsonDiffLine[] => {
  const beforeObj = isPlainObject(before) ? before : {};
  const afterObj = isPlainObject(after) ? after : {};
  const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  const lines: JsonDiffLine[] = [];

  // If one side is not an object, mark the whole node as changed first.
  if ((!isPlainObject(before) || !isPlainObject(after)) && !valuesEqual(before, after)) {
    lines.push({ path: nodePath(basePath), kind: 'changed', before, after });
  }

  for (const key of [...keys].sort()) {
    lines.push(...diffKey(beforeObj, afterObj, key, pathKey(basePath, key)));
  }

  return lines;
};

/** Leaf comparison for scalars, arrays and other opaque values. */
const diffScalarNode = (before: unknown, after: unknown, basePath: string): JsonDiffLine[] => {
  const path = nodePath(basePath);
  if (valuesEqual(before, after)) return [{ path, kind: 'same', before, after }];
  if (before === undefined) return [{ path, kind: 'added', after }];
  if (after === undefined) return [{ path, kind: 'removed', before }];
  return [{ path, kind: 'changed', before, after }];
};

/**
 * Shallow key-level + recursive object diff for audit before/after snapshots.
 * Arrays are compared by JSON stringify equality (treated as opaque values).
 * Non-serializable values fall back to an opaque "changed" marker.
 */
export const computeJsonDiff = (before: unknown, after: unknown, basePath = ''): JsonDiffLine[] => {
  if (before === undefined && after === undefined) return [];

  return isPlainObject(before) || isPlainObject(after)
    ? diffObjectNode(before, after, basePath)
    : diffScalarNode(before, after, basePath);
};

export const formatJsonValue = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
