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

/**
 * Shallow key-level + recursive object diff for audit before/after snapshots.
 * Arrays are compared by JSON stringify equality (treated as opaque values).
 */
export const computeJsonDiff = (before: unknown, after: unknown, basePath = ''): JsonDiffLine[] => {
  if (before === undefined && after === undefined) return [];

  if (isPlainObject(before) || isPlainObject(after)) {
    const beforeObj = isPlainObject(before) ? before : {};
    const afterObj = isPlainObject(after) ? after : {};
    const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
    const lines: JsonDiffLine[] = [];

    // If one side is not an object, mark the whole node as changed first.
    if (
      (!isPlainObject(before) || !isPlainObject(after)) &&
      JSON.stringify(before) !== JSON.stringify(after)
    ) {
      lines.push({ path: basePath || '(root)', kind: 'changed', before, after });
    }

    for (const key of [...keys].sort()) {
      const nextPath = pathKey(basePath, key);
      const hasBefore = Object.prototype.hasOwnProperty.call(beforeObj, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(afterObj, key);

      if (hasBefore && !hasAfter) {
        lines.push({ path: nextPath, kind: 'removed', before: beforeObj[key] });
        continue;
      }
      if (!hasBefore && hasAfter) {
        lines.push({ path: nextPath, kind: 'added', after: afterObj[key] });
        continue;
      }

      const b = beforeObj[key];
      const a = afterObj[key];
      if (isPlainObject(b) || isPlainObject(a)) {
        lines.push(...computeJsonDiff(b, a, nextPath));
        continue;
      }
      if (JSON.stringify(b) === JSON.stringify(a)) {
        lines.push({ path: nextPath, kind: 'same', before: b, after: a });
      } else {
        lines.push({ path: nextPath, kind: 'changed', before: b, after: a });
      }
    }
    return lines;
  }

  if (JSON.stringify(before) === JSON.stringify(after)) {
    return [{ path: basePath || '(root)', kind: 'same', before, after }];
  }
  if (before === undefined) {
    return [{ path: basePath || '(root)', kind: 'added', after }];
  }
  if (after === undefined) {
    return [{ path: basePath || '(root)', kind: 'removed', before }];
  }
  return [{ path: basePath || '(root)', kind: 'changed', before, after }];
};

export const formatJsonValue = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
