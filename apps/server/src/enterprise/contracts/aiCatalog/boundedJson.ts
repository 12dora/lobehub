import { z } from 'zod';

import {
  containsSensitiveMaterial,
  isCredentialBearingUrl,
  isSensitiveKey,
  M07_REDACTION_OPTIONS,
} from '../../security/redaction';

/** Hard bounds for provider/model JSON config trees (iterative walk — no stack blow-up). */
export const BOUNDED_JSON_MAX_DEPTH = 32;
export const BOUNDED_JSON_MAX_NODES = 4096;
export const BOUNDED_JSON_MAX_KEYS_PER_OBJECT = 256;
export const BOUNDED_JSON_MAX_SERIALIZED_BYTES = 256 * 1024;

type JsonWalkFrame = {
  depth: number;
  path: Array<number | string>;
  value: unknown;
};

type JsonValueKind = 'leaf' | 'container';

const measureSerializedBytes = (root: unknown, ctx: z.RefinementCtx): number | undefined => {
  let serializedBytes: number;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(root), 'utf8');
  } catch {
    ctx.addIssue({ code: 'custom', message: 'JSON value is not serializable' });
    return undefined;
  }
  if (serializedBytes > BOUNDED_JSON_MAX_SERIALIZED_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `JSON exceeds max serialized size of ${BOUNDED_JSON_MAX_SERIALIZED_BYTES} bytes`,
    });
    return undefined;
  }
  return serializedBytes;
};

const exceedsNodeBudget = (
  nodes: number,
  path: Array<number | string>,
  ctx: z.RefinementCtx,
): boolean => {
  if (nodes > BOUNDED_JSON_MAX_NODES) {
    ctx.addIssue({
      code: 'custom',
      message: `JSON exceeds max node count of ${BOUNDED_JSON_MAX_NODES}`,
      path,
    });
    return true;
  }
  return false;
};

const exceedsMaxDepth = (
  depth: number,
  path: Array<number | string>,
  ctx: z.RefinementCtx,
): boolean => {
  if (depth > BOUNDED_JSON_MAX_DEPTH) {
    ctx.addIssue({
      code: 'custom',
      message: `JSON exceeds max depth of ${BOUNDED_JSON_MAX_DEPTH}`,
      path,
    });
    return true;
  }
  return false;
};

/**
 * Accept only JSON values: null, string, boolean, finite number, array, plain object.
 * Reject undefined, non-finite numbers, and non-plain objects before size/secret checks
 * so JSONB persistence cannot reshape accepted input.
 */
const inspectJsonValue = (
  value: unknown,
  path: Array<number | string>,
  ctx: z.RefinementCtx,
): JsonValueKind => {
  if (value === null || typeof value === 'boolean') {
    return 'leaf';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'non-finite number is not allowed in JSON',
        path,
      });
    }
    return 'leaf';
  }

  if (typeof value === 'string') {
    if (containsSensitiveMaterial(value)) {
      ctx.addIssue({ code: 'custom', message: 'secret material is not allowed', path });
    }
    if (isCredentialBearingUrl(value)) {
      ctx.addIssue({ code: 'custom', message: 'credential-bearing URL is not allowed', path });
    }
    return 'leaf';
  }

  if (typeof value === 'undefined') {
    ctx.addIssue({ code: 'custom', message: 'undefined is not allowed in JSON', path });
    return 'leaf';
  }

  if (typeof value !== 'object') {
    ctx.addIssue({
      code: 'custom',
      message: `JSON value type '${typeof value}' is not allowed`,
      path,
    });
    return 'leaf';
  }

  return 'container';
};

const enqueueArrayChildren = (
  stack: JsonWalkFrame[],
  value: unknown[],
  path: Array<number | string>,
  depth: number,
): void => {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    stack.push({ depth: depth + 1, path: [...path, index], value: value[index] });
  }
};

/** Nearest named ancestor key (skipping array indexes, matching walkRedact's array semantics). */
const nearestNamedAncestorKey = (path: Array<number | string>): string | undefined => {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const segment = path[i];
    if (typeof segment === 'string') {
      return segment;
    }
  }
  return undefined;
};

type ObjectEnqueueResult = 'ok' | 'stop';

const enqueuePlainObjectChildren = (
  stack: JsonWalkFrame[],
  value: object,
  path: Array<number | string>,
  depth: number,
  ctx: z.RefinementCtx,
): ObjectEnqueueResult => {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    ctx.addIssue({
      code: 'custom',
      message: 'non-plain object is not allowed in JSON',
      path,
    });
    return 'ok';
  }

  if (exceedsMaxDepth(depth, path, ctx)) {
    return 'stop';
  }

  const entries = Object.entries(value);
  if (entries.length > BOUNDED_JSON_MAX_KEYS_PER_OBJECT) {
    ctx.addIssue({
      code: 'custom',
      message: `JSON object exceeds max key count of ${BOUNDED_JSON_MAX_KEYS_PER_OBJECT}`,
      path,
    });
    return 'stop';
  }

  // Parent key of this object's entries = nearest named ancestor key (undefined at the blob
  // root). Lets the M07 predicate position-scope OAuth config keys.
  const parentKey = nearestNamedAncestorKey(path);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [key, child] = entries[i]!;
    // `child` is passed so the predicate can shape-check the value too: a configuration
    // key name (`authorizationCode`, `allowAccessTokenPaste`, `grantFlow`) must not let an
    // opaque credential through this boundary just because it sits in the right place.
    if (isSensitiveKey(key) && !M07_REDACTION_OPTIONS.isBenignKey(key, parentKey, child)) {
      ctx.addIssue({
        code: 'custom',
        message: 'sensitive key is not allowed',
        path: [...path, key],
      });
      continue;
    }
    stack.push({ depth: depth + 1, path: [...path, key], value: child });
  }
  return 'ok';
};

const validateNonSecretJson = (root: unknown, ctx: z.RefinementCtx): void => {
  if (measureSerializedBytes(root, ctx) === undefined) {
    return;
  }

  const stack: JsonWalkFrame[] = [{ depth: 0, path: [], value: root }];
  let nodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    nodes += 1;
    if (exceedsNodeBudget(nodes, frame.path, ctx)) {
      return;
    }

    const { value, path, depth } = frame;

    if (inspectJsonValue(value, path, ctx) === 'leaf') {
      continue;
    }

    if (Array.isArray(value)) {
      // Depth limit applies to nested containers, not primitive leaves under a max-depth object.
      if (exceedsMaxDepth(depth, path, ctx)) {
        return;
      }
      enqueueArrayChildren(stack, value, path, depth);
      continue;
    }

    // Everything that is neither a leaf nor an array is an object, by elimination above.
    if (enqueuePlainObjectChildren(stack, value as object, path, depth, ctx) === 'stop') {
      return;
    }
  }
};

export const boundedJsonObjectSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => validateNonSecretJson(value, ctx));
