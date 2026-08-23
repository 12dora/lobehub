import { isPlainRecord } from '@lobechat/utils/object';
import type { z } from 'zod';

import { containsSensitiveMaterial, isCredentialBearingUrl } from '../../security/redaction';
import {
  CONNECTOR_TOOL_VALIDATION_CODES,
  type ConnectorToolValidationCode,
} from './toolValidationCodes';

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_NODES = 4096;
const MAX_SCHEMA_PROPERTIES = 1024;
const MAX_SCHEMA_ENUM_VALUES = 1024;
const MAX_CREDENTIAL_SCAN_LENGTH = 128 * 1024;
const MAX_PERCENT_DECODE_ROUNDS = 8;
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/iu;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/iu;

const PROPERTY_CONTAINER_KEYS = new Set([
  '$defs',
  'definitions',
  'dependentschemas',
  'patternproperties',
  'properties',
]);
const DANGEROUS_SCHEMA_KEYS = new Set([
  '$dynamicanchor',
  '$dynamicref',
  '$recursiveanchor',
  '$recursiveref',
  '$id',
  '$schema',
  '__proto__',
  'constructor',
  'contentencoding',
  'contentmediatype',
  'contentschema',
  'externaldocs',
  'prototype',
]);
const DANGEROUS_EXTENSION_TOKEN =
  /callback|command|endpoint|exec|process|script|shell|spawn|stdio|url|webhook/iu;
const DANGEROUS_OPERATION_KEYS = new Set([
  'callback',
  'command',
  'endpoint',
  'exec',
  'process',
  'script',
  'shell',
  'spawn',
  'stdio',
  'url',
  'webhook',
]);
const LOCAL_SCHEMA_REF = /^#\/(?:\$defs|definitions)\/[\w.~/-]+$/u;

interface SchemaFrame {
  depth: number;
  parentKeyword?: string;
  value: unknown;
}

interface SchemaCounters {
  enumValues: number;
  nodes: number;
  properties: number;
}

export const containsConnectorCredentialMaterial = (value: string): boolean => {
  let candidate = value;
  for (let round = 0; round <= MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    if (candidate.length > MAX_CREDENTIAL_SCAN_LENGTH) return true;
    const normalized = candidate.normalize('NFKC');
    if (normalized.length > MAX_CREDENTIAL_SCAN_LENGTH) return true;
    if (/(?:vault|kms):\/\//iu.test(normalized)) return true;
    if (containsSensitiveMaterial(normalized)) return true;
    if (isCredentialBearingUrl(normalized)) return true;
    if ((normalized.match(/https?:\/\/\S+/giu) ?? []).some(isCredentialBearingUrl)) return true;
    if (!normalized.includes('%')) return false;
    if (MALFORMED_PERCENT_ESCAPE.test(normalized)) return true;
    if (round === MAX_PERCENT_DECODE_ROUNDS && PERCENT_ESCAPE.test(normalized)) return true;
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) return false;
      candidate = decoded;
    } catch {
      return true;
    }
  }
  return true;
};

const byteLength = (value: unknown): number | null => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
};

const isDangerousSchemaKeyword = (key: string, value: unknown, parentKeyword?: string): boolean => {
  const normalizedKey = key.normalize('NFKC');
  const normalized = normalizedKey.toLowerCase();
  if (PROPERTY_CONTAINER_KEYS.has(parentKeyword ?? '')) {
    return normalized === '__proto__' || normalized === 'constructor' || normalized === 'prototype';
  }
  if (/[^\u0020-\u007E]/u.test(normalizedKey)) return true;
  if (normalizedKey !== key) return true;
  if (key === '$ref') return typeof value !== 'string' || !LOCAL_SCHEMA_REF.test(value);
  const compact = normalized.replaceAll(/[^a-z$]/g, '');
  if (
    normalized === '$ref' ||
    ['anchor', 'dialect', 'ref', 'reference'].some((token) => compact.includes(token)) ||
    (normalized.startsWith('x-') && compact.includes('ref'))
  ) {
    return true;
  }
  if (normalizedKey.startsWith('$') && !['$comment', '$defs'].includes(normalizedKey)) return true;
  if (DANGEROUS_SCHEMA_KEYS.has(normalized)) return true;
  return (
    DANGEROUS_OPERATION_KEYS.has(normalized) ||
    (normalized.startsWith('x-') && DANGEROUS_EXTENSION_TOKEN.test(normalized))
  );
};

const isExoticJsonArray = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  const indexKeys = Object.keys(descriptors).filter((key) => key !== 'length');
  return (
    Object.getPrototypeOf(value) !== Array.prototype ||
    ownKeys.some((key) => typeof key === 'symbol') ||
    indexKeys.length !== value.length ||
    indexKeys.some((key) => {
      const descriptor = descriptors[key]!;
      const index = Number(key);
      return (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= value.length ||
        String(index) !== key ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      );
    })
  );
};

const hasUnsafeOwnDescriptors = (value: object): boolean => {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.some((key) => typeof key === 'symbol') ||
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined,
    )
  );
};

type EmitOnce = (code: ConnectorToolValidationCode) => void;

const visitPrimitiveOrInvalid = (frame: SchemaFrame, emitOnce: EmitOnce): boolean => {
  if (typeof frame.value === 'string') {
    if (containsConnectorCredentialMaterial(frame.value)) {
      emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaSecret);
    }
    return true;
  }
  if (
    frame.value === null ||
    typeof frame.value === 'boolean' ||
    (typeof frame.value === 'number' && Number.isFinite(frame.value))
  ) {
    return true;
  }
  if (typeof frame.value !== 'object') {
    emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
    return true;
  }
  return false;
};

const visitSchemaArray = (frame: SchemaFrame, stack: SchemaFrame[], emitOnce: EmitOnce) => {
  if (!Array.isArray(frame.value)) return false;
  if (isExoticJsonArray(frame.value)) {
    emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
    return true;
  }
  const descriptors = Object.getOwnPropertyDescriptors(frame.value);
  const indexKeys = Object.keys(descriptors).filter((key) => key !== 'length');
  for (const key of indexKeys) {
    stack.push({ ...frame, depth: frame.depth + 1, value: descriptors[key]!.value });
  }
  return true;
};

const visitSchemaObjectEntries = (
  record: Record<string, unknown>,
  frame: SchemaFrame,
  stack: SchemaFrame[],
  counters: SchemaCounters,
  emitOnce: EmitOnce,
) => {
  for (const [key, value] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    if (containsConnectorCredentialMaterial(key)) {
      emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaSecret);
    }
    if (isDangerousSchemaKeyword(key, value, frame.parentKeyword)) {
      emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.dangerousKeyword);
    }
    if (
      (normalized === 'properties' || normalized === 'patternproperties') &&
      isPlainRecord(value)
    ) {
      counters.properties += Object.keys(value).length;
      if (counters.properties > MAX_SCHEMA_PROPERTIES)
        emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaProperties);
    }
    if (normalized === 'enum' && Array.isArray(value)) {
      counters.enumValues += value.length;
      if (counters.enumValues > MAX_SCHEMA_ENUM_VALUES)
        emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaEnum);
    }
    stack.push({
      depth: frame.depth + 1,
      parentKeyword: normalized,
      value,
    });
  }
};

const visitSchemaFrame = (
  frame: SchemaFrame,
  stack: SchemaFrame[],
  counters: SchemaCounters,
  seen: WeakSet<object>,
  emitOnce: EmitOnce,
): 'break' | 'continue' => {
  counters.nodes += 1;
  if (counters.nodes > MAX_SCHEMA_NODES) {
    emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaNodes);
    return 'break';
  }
  if (frame.depth > MAX_SCHEMA_DEPTH) {
    emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaDepth);
    return 'continue';
  }
  if (visitPrimitiveOrInvalid(frame, emitOnce)) return 'continue';
  if (typeof frame.value !== 'object' || frame.value === null) return 'continue';
  if (seen.has(frame.value)) {
    emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
    return 'continue';
  }
  seen.add(frame.value);
  if (visitSchemaArray(frame, stack, emitOnce)) return 'continue';
  if (!isPlainRecord(frame.value)) {
    emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
    return 'continue';
  }
  if (hasUnsafeOwnDescriptors(frame.value)) {
    emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
    return 'continue';
  }
  visitSchemaObjectEntries(frame.value, frame, stack, counters, emitOnce);
  return 'continue';
};

const emitSchemaSizeIssues = (
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
  emitted: Set<ConnectorToolValidationCode>,
  emitOnce: EmitOnce,
) => {
  if (emitted.has(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid)) return;
  for (const schema of [inputSchema, outputSchema]) {
    const bytes = byteLength(schema);
    if (bytes === null) emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
    else if (bytes > MAX_SCHEMA_BYTES) emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaSize);
  }
};

export const validateSchemaPair = (
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
  ctx: z.RefinementCtx,
) => {
  const counters: SchemaCounters = { enumValues: 0, nodes: 0, properties: 0 };
  const stack: SchemaFrame[] = [
    { depth: 1, value: inputSchema },
    { depth: 1, value: outputSchema },
  ];
  const seen = new WeakSet<object>();
  const emitted = new Set<ConnectorToolValidationCode>();
  const emitOnce = (code: ConnectorToolValidationCode) => {
    if (emitted.has(code)) return;
    emitted.add(code);
    ctx.addIssue({ code: 'custom', message: code });
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (visitSchemaFrame(frame, stack, counters, seen, emitOnce) === 'break') break;
  }

  emitSchemaSizeIssues(inputSchema, outputSchema, emitted, emitOnce);
};
