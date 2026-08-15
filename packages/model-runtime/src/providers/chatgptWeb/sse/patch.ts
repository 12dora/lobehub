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

/** A JSON-Pointer array position: a numeric index or the `-` (append) token. */
const isIndexSegment = (segment: string) => /^\d+$/.test(segment) || segment === '-';

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
    if (target.key === '-') {
      target.container.push(value);
      return;
    }
    if (/^\d+$/.test(target.key)) {
      const index = Math.min(Number(target.key), target.container.length);
      target.container.splice(index, 0, value);
      return;
    }
  }
  target.container[target.key] = value;
};

const appendAt = (root: JsonValue, path: string, value: JsonValue): void => {
  const target = getContainer(root, splitPath(path), true);
  if (!target) return;
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
      if (Array.isArray(target.container) && /^\d+$/.test(target.key))
        target.container.splice(Number(target.key), 1);
      else delete target.container[target.key];
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
