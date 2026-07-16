/**
 * Safe path get/set for registered settings paths (dot-separated).
 * Never walks prototype; rejects empty / dangerous segments.
 */

const SEGMENT_RE = /^[A-Z]\w*$/i;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export const splitSettingPath = (path: string): string[] => {
  if (!path || typeof path !== 'string') return [];
  const parts = path.split('.');
  if (parts.some((p) => !p || !SEGMENT_RE.test(p) || FORBIDDEN_SEGMENTS.has(p))) return [];
  return parts;
};

export const isValidSettingPathShape = (path: string): boolean => splitSettingPath(path).length > 0;

/**
 * Read a nested value by registered path. Returns `undefined` when missing.
 */
export const getByPath = (root: unknown, path: string): unknown => {
  const parts = splitSettingPath(path);
  if (parts.length === 0) return undefined;

  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(cur, part)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
};

/**
 * Return a shallow-cloned tree with `value` set at `path`.
 * Does not mutate the original root.
 */
export const setByPath = <T extends Record<string, unknown>>(
  root: T,
  path: string,
  value: unknown,
): T => {
  const parts = splitSettingPath(path);
  if (parts.length === 0) return root;

  const clone = { ...root } as Record<string, unknown>;
  let cur: Record<string, unknown> = clone;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    const nextObj =
      next !== null && typeof next === 'object' && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {};
    cur[part] = nextObj;
    cur = nextObj;
  }

  cur[parts.at(-1)!] = value;
  return clone as T;
};

/**
 * Delete a leaf at path; prune empty intermediate objects only when they become empty
 * is intentionally not done — callers own legacy blob shape.
 */
export const deleteByPath = <T extends Record<string, unknown>>(root: T, path: string): T => {
  const parts = splitSettingPath(path);
  if (parts.length === 0) return root;

  const clone = { ...root } as Record<string, unknown>;
  const stack: Array<{ obj: Record<string, unknown>; key: string }> = [];
  let cur: Record<string, unknown> = clone;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      return clone as T;
    }
    const nextObj = { ...(next as Record<string, unknown>) };
    cur[part] = nextObj;
    stack.push({ key: part, obj: cur });
    cur = nextObj;
  }

  delete cur[parts.at(-1)!];
  return clone as T;
};

/**
 * Flatten a nested object into leaf paths under `prefix`.
 * Only plain objects are walked; arrays / primitives are leaves.
 */
export const flattenLeaves = (
  value: unknown,
  prefix = '',
): Array<{ path: string; value: unknown }> => {
  if (value === null || value === undefined) {
    return prefix ? [{ path: prefix, value }] : [];
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [{ path: prefix, value }] : [];
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return prefix ? [{ path: prefix, value }] : [];
  }

  const out: Array<{ path: string; value: unknown }> = [];
  for (const [key, child] of entries) {
    if (!SEGMENT_RE.test(key)) continue;
    const next = prefix ? `${prefix}.${key}` : key;
    out.push(...flattenLeaves(child, next));
  }
  return out;
};
