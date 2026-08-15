/**
 * Generic JSON-patch applier for the conversation stream.
 *
 * The reference implementation hard-codes the single path
 * `/message/content/parts/0`, which silently drops every patch to `thoughts`,
 * `metadata`, `content_references`, `status`, … Applying the `p`/`o`/`v` grammar
 * to a real object tree instead makes reasoning, citations and message status
 * fall out for free.
 */

export type JsonValue = any;

export interface PatchEvent {
  [key: string]: unknown;
  c?: number;
  o?: string;
  p?: string;
  v?: JsonValue;
}

export interface PatchState {
  /**
   * Path of the last `append` we applied — used to resolve the `{"v": "..."}`
   * shorthand, which omits both `p` and `o`.
   */
  lastAppendPath: string;
  /** The document the patches apply to, usually `{ message, conversation_id }`. */
  root: JsonValue;
}

export const createPatchState = (): PatchState => ({
  lastAppendPath: '/message/content/parts/0',
  root: undefined,
});

const splitPath = (path: string): string[] =>
  path
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

/**
 * Path segments an SSE payload must never be allowed to address. Without this
 * a `{"p":"/__proto__/x","o":"add"}` frame from the upstream (or from anyone who
 * can inject one) mutates `Object.prototype` for the whole process.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export const isUnsafePath = (segments: string[]): boolean =>
  segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment));

/**
 * The largest array index we will ever honour. `replace /list/4294967294` is a
 * legal-looking JSON pointer that turns the target into a 4-billion-slot sparse
 * array — every later `parts.filter(…)` then walks billions of positions, which
 * is a CPU/memory kill from a single SSE frame.
 */
const MAX_ARRAY_INDEX = 2 ** 31 - 1;

/**
 * A canonical, non-negative, safe array index: no `-1`, no `+1`, no `01`, no
 * `1e3`, no ` 1`, nothing past {@link MAX_ARRAY_INDEX}.
 */
export const isCanonicalArrayIndex = (segment: string): boolean =>
  /^(?:0|[1-9]\d*)$/.test(segment) && segment.length <= 10 && Number(segment) <= MAX_ARRAY_INDEX;

/** A JSON-Pointer array position: a canonical index or the `-` (append) token. */
const isIndexSegment = (segment: string) => segment === '-' || isCanonicalArrayIndex(segment);

/**
 * Resolve a pointer segment against an array container, or `undefined` when the
 * segment is out of contract.
 *
 * `write` (add / replace / append) may extend the array by AT MOST one slot, so
 * a hostile index can never create a hole; `remove` must address an existing
 * one. `-` is the append token and is only meaningful for a write.
 */
const arrayIndexFor = (
  container: unknown[],
  key: string,
  mode: 'write' | 'remove',
): number | undefined => {
  if (key === '-') return mode === 'write' ? container.length : undefined;
  if (!isCanonicalArrayIndex(key)) return undefined;
  const index = Number(key);
  if (mode === 'remove') return index < container.length ? index : undefined;
  return index <= container.length ? index : undefined;
};

/** Own-property read only — never walk into anything inherited. */
const ownValue = (node: JsonValue, segment: string): JsonValue => {
  if (node === null || typeof node !== 'object') return undefined;
  if (!Object.hasOwn(node, segment)) return undefined;
  return node[segment];
};

const getContainer = (
  root: JsonValue,
  segments: string[],
  create: boolean,
): { container: JsonValue; key: string } | undefined => {
  if (segments.length === 0 || isUnsafePath(segments)) return undefined;

  let node = root;
  for (const [index, segment] of segments.slice(0, -1).entries()) {
    if (node === null || typeof node !== 'object') return undefined;
    // an intermediate array position obeys the same bounds as a leaf write, and
    // `-` is meaningless there (it addresses no existing element)
    if (Array.isArray(node) && (!isCanonicalArrayIndex(segment) || Number(segment) > node.length))
      return undefined;
    let next = ownValue(node, segment);
    if (next === undefined) {
      if (!create) return undefined;
      // the container's shape is decided by the segment that will index it
      next = isIndexSegment(segments[index + 1]) ? [] : {};
      node[segment] = next;
    }
    node = next;
  }
  if (node === null || typeof node !== 'object') return undefined;
  return { container: node, key: segments.at(-1)! };
};

const readAt = (root: JsonValue, path: string): JsonValue => {
  const target = getContainer(root, splitPath(path), false);
  return target ? ownValue(target.container, target.key) : undefined;
};

/** `replace` semantics: overwrite whatever sits at the path. */
const writeAt = (root: JsonValue, path: string, value: JsonValue): void => {
  const target = getContainer(root, splitPath(path), true);
  if (!target) return;
  if (Array.isArray(target.container)) {
    // `-` is not a replace location (RFC 6902); an out-of-range index is refused
    const index =
      target.key === '-' ? undefined : arrayIndexFor(target.container, target.key, 'write');
    if (index === undefined) return;
    target.container[index] = value;
    return;
  }
  target.container[target.key] = value;
};

/**
 * `add` semantics: on an array, an index INSERTS and `-` appends (RFC 6902);
 * everywhere else it behaves like `replace`.
 */
const addAt = (root: JsonValue, path: string, value: JsonValue): void => {
  const target = getContainer(root, splitPath(path), true);
  if (!target) return;
  if (Array.isArray(target.container)) {
    const index = arrayIndexFor(target.container, target.key, 'write');
    // an out-of-contract index is dropped, never clamped: silently appending
    // what claimed to be position 4294967294 corrupts the document just as badly
    if (index === undefined) return;
    target.container.splice(index, 0, value);
    return;
  }
  target.container[target.key] = value;
};

const appendAt = (root: JsonValue, path: string, value: JsonValue): void => {
  const target = getContainer(root, splitPath(path), true);
  if (!target) return;

  if (Array.isArray(target.container)) {
    const index = arrayIndexFor(target.container, target.key, 'write');
    if (index === undefined) return;
    // `-` appends rather than string-concatenating onto a non-existent slot
    if (target.key === '-') {
      target.container.push(value);
      return;
    }
  }

  const current = ownValue(target.container, target.key);
  if (typeof current === 'string' || current === undefined || current === null) {
    target.container[target.key] = `${current ?? ''}${typeof value === 'string' ? value : ''}`;
    return;
  }
  if (Array.isArray(current)) {
    current.push(value);
    return;
  }
  target.container[target.key] = value;
};

const isPlainObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Apply one streamed event to the state. Returns `true` when the tree changed.
 */
export const applyPatchEvent = (state: PatchState, event: PatchEvent): boolean => {
  // A whole message object, either at the top level or under `v`.
  if (isPlainObject(event.message)) {
    state.root = event;
    return true;
  }

  const { o: op, p: path, v: value } = event;

  if (op === 'patch' && Array.isArray(value)) {
    let changed = false;
    for (const item of value)
      if (isPlainObject(item)) changed = applyPatchEvent(state, item) || changed;
    return changed;
  }

  if (op === undefined && Array.isArray(value)) {
    let changed = false;
    for (const item of value)
      if (isPlainObject(item)) changed = applyPatchEvent(state, item) || changed;
    return changed;
  }

  // `{"p": "", "o": "add", "v": { message: … }}` — a brand new document.
  if ((op === 'add' || op === undefined) && (!path || path === '') && isPlainObject(value)) {
    state.root = value;
    return true;
  }

  // The `{"v": "…"}` shorthand: append to whatever we appended to last.
  if (op === undefined && !path && typeof value === 'string') {
    if (state.root === undefined) return false;
    appendAt(state.root, state.lastAppendPath, value);
    return true;
  }

  if (!path) return false;
  if (state.root === undefined) state.root = {};

  switch (op) {
    case 'append': {
      appendAt(state.root, path, value);
      state.lastAppendPath = path;
      return true;
    }
    case 'add': {
      addAt(state.root, path, value);
      return true;
    }
    case 'replace': {
      writeAt(state.root, path, value);
      return true;
    }
    case 'remove': {
      const target = getContainer(state.root, splitPath(path), false);
      if (!target) return false;
      if (Array.isArray(target.container)) {
        const index = arrayIndexFor(target.container, target.key, 'remove');
        if (index === undefined) return false;
        target.container.splice(index, 1);
        return true;
      }
      delete target.container[target.key];
      return true;
    }
    default: {
      // Unknown op with an explicit path and a value: best-effort write, but
      // only when it does not clobber an existing subtree with `undefined`.
      if (value === undefined) return false;
      writeAt(state.root, path, value);
      return true;
    }
  }
};

export const getPatchedValue = (state: PatchState, path: string): JsonValue =>
  state.root === undefined ? undefined : readAt(state.root, path);
