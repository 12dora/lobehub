import { isPlainRecord } from '@lobechat/utils/object';
import { z } from 'zod';

import { containsSensitiveMaterial, isCredentialBearingUrl } from '../../security/redaction';

const MAX_TOOL_COUNT = 1000;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_NODES = 4096;
const MAX_SCHEMA_PROPERTIES = 1024;
const MAX_SCHEMA_ENUM_VALUES = 1024;

export const CONNECTOR_TOOL_VALIDATION_CODES = {
  confirmationRequired: 'PLATFORM_CONNECTOR_TOOL_CONFIRMATION_REQUIRED',
  dangerousKeyword: 'PLATFORM_CONNECTOR_TOOL_SCHEMA_DANGEROUS_KEYWORD',
  duplicateOperation: 'PLATFORM_CONNECTOR_TOOL_OPERATION_DUPLICATE',
  invalidOperation: 'PLATFORM_CONNECTOR_TOOL_OPERATION_INVALID',
  schemaDepth: 'PLATFORM_CONNECTOR_TOOL_SCHEMA_DEPTH_LIMIT',
  schemaEnum: 'PLATFORM_CONNECTOR_TOOL_SCHEMA_ENUM_LIMIT',
  schemaInvalid: 'PLATFORM_CONNECTOR_TOOL_SCHEMA_INVALID',
  schemaNodes: 'PLATFORM_CONNECTOR_TOOL_SCHEMA_NODE_LIMIT',
  schemaProperties: 'PLATFORM_CONNECTOR_TOOL_SCHEMA_PROPERTY_LIMIT',
  schemaSecret: 'PLATFORM_CONNECTOR_TOOL_SCHEMA_SECRET_BLOCKED',
  schemaSize: 'PLATFORM_CONNECTOR_TOOL_SCHEMA_SIZE_LIMIT',
  toolCount: 'PLATFORM_CONNECTOR_TOOL_COUNT_LIMIT',
} as const;

export type ConnectorToolValidationCode =
  (typeof CONNECTOR_TOOL_VALIDATION_CODES)[keyof typeof CONNECTOR_TOOL_VALIDATION_CODES];

const VALIDATION_CODE_SET = new Set<ConnectorToolValidationCode>(
  Object.values(CONNECTOR_TOOL_VALIDATION_CODES),
);
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
const STABLE_OPERATION_KEY = /^[A-Za-z0-9][\w.:/-]{0,199}$/u;

interface ConnectorToolSecurityFields {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requiresConfirmation: boolean;
  riskLevel: 'critical' | 'high' | 'low' | 'medium';
  toolKey: string;
}

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

export class ConnectorToolDefinitionValidationError extends Error {
  constructor(readonly code: ConnectorToolValidationCode) {
    super(code);
    this.name = 'ConnectorToolDefinitionValidationError';
  }
}

const MAX_CREDENTIAL_SCAN_LENGTH = 128 * 1024;
const MAX_PERCENT_DECODE_ROUNDS = 8;
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/iu;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/iu;

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

const addIssue = (ctx: z.RefinementCtx, code: ConnectorToolValidationCode) =>
  ctx.addIssue({ code: 'custom', message: code });

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

const validateSchemaPair = (
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
    addIssue(ctx, code);
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    counters.nodes += 1;
    if (counters.nodes > MAX_SCHEMA_NODES) {
      emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaNodes);
      break;
    }
    if (frame.depth > MAX_SCHEMA_DEPTH) {
      emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaDepth);
      continue;
    }
    if (typeof frame.value === 'string') {
      if (containsConnectorCredentialMaterial(frame.value)) {
        emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaSecret);
      }
      continue;
    }
    if (
      frame.value === null ||
      typeof frame.value === 'boolean' ||
      (typeof frame.value === 'number' && Number.isFinite(frame.value))
    ) {
      continue;
    }
    if (typeof frame.value !== 'object') {
      emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
      continue;
    }
    if (seen.has(frame.value)) {
      emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
      continue;
    }
    seen.add(frame.value);

    if (Array.isArray(frame.value)) {
      if (isExoticJsonArray(frame.value)) {
        emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
        continue;
      }
      const descriptors = Object.getOwnPropertyDescriptors(frame.value);
      const indexKeys = Object.keys(descriptors).filter((key) => key !== 'length');
      for (const key of indexKeys) {
        stack.push({ ...frame, depth: frame.depth + 1, value: descriptors[key]!.value });
      }
      continue;
    }
    if (!isPlainRecord(frame.value)) {
      emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
      continue;
    }

    if (hasUnsafeOwnDescriptors(frame.value)) {
      emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
      continue;
    }

    for (const [key, value] of Object.entries(frame.value)) {
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
  }

  if (!emitted.has(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid)) {
    for (const schema of [inputSchema, outputSchema]) {
      const bytes = byteLength(schema);
      if (bytes === null) emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
      else if (bytes > MAX_SCHEMA_BYTES) emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaSize);
    }
  }
};

export const connectorJsonObjectSchema = z.custom<Record<string, unknown>>(isPlainRecord, {
  message: CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid,
});

export const addConnectorToolSecurityIssues = (
  tool: ConnectorToolSecurityFields,
  ctx: z.RefinementCtx,
) => {
  if (!STABLE_OPERATION_KEY.test(tool.toolKey)) {
    addIssue(ctx, CONNECTOR_TOOL_VALIDATION_CODES.invalidOperation);
  }
  if ((tool.riskLevel === 'high' || tool.riskLevel === 'critical') && !tool.requiresConfirmation) {
    addIssue(ctx, CONNECTOR_TOOL_VALIDATION_CODES.confirmationRequired);
  }
  validateSchemaPair(tool.inputSchema, tool.outputSchema, ctx);
};

export const addConnectorToolListIssues = (
  tools: Array<{ toolKey: string }>,
  ctx: z.RefinementCtx,
) => {
  if (tools.length > MAX_TOOL_COUNT) addIssue(ctx, CONNECTOR_TOOL_VALIDATION_CODES.toolCount);
  const operations = new Set<string>();
  for (const tool of tools) {
    const normalized = tool.toolKey.toLowerCase();
    if (operations.has(normalized)) {
      addIssue(ctx, CONNECTOR_TOOL_VALIDATION_CODES.duplicateOperation);
      return;
    }
    operations.add(normalized);
  }
};

const connectorToolBaseObjectSchema = z
  .object({
    description: z.string().trim().max(4000).nullable(),
    displayName: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
    inputSchema: connectorJsonObjectSchema,
    outputSchema: connectorJsonObjectSchema.default({}),
    platformPolicy: z.enum(['allow', 'deny']),
    requiresConfirmation: z.boolean(),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
    sort: z.number().int(),
    toolKey: z.string().trim().min(1).max(200),
  })
  .strict();

const connectorToolBaseSchema = connectorToolBaseObjectSchema.superRefine(
  addConnectorToolSecurityIssues,
);
const writableConnectorToolSchema = connectorToolBaseObjectSchema
  .extend({ id: z.string().trim().min(1).max(128) })
  .strict()
  .superRefine(addConnectorToolSecurityIssues);

const discoveredConnectorToolsSchema = z
  .array(connectorToolBaseSchema)
  .max(MAX_TOOL_COUNT, CONNECTOR_TOOL_VALIDATION_CODES.toolCount)
  .superRefine(addConnectorToolListIssues);
const writableConnectorToolsSchema = z
  .array(writableConnectorToolSchema)
  .max(MAX_TOOL_COUNT, CONNECTOR_TOOL_VALIDATION_CODES.toolCount)
  .superRefine(addConnectorToolListIssues);

const parseAtBoundary = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const message = result.error.issues[0]?.message;
  const code = VALIDATION_CODE_SET.has(message as ConnectorToolValidationCode)
    ? (message as ConnectorToolValidationCode)
    : CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid;
  throw new ConnectorToolDefinitionValidationError(code);
};

/** Normalize and validate untrusted discovery results before they enter a Draft. */
export const parseDiscoveredConnectorTools = (input: unknown) =>
  parseAtBoundary(discoveredConnectorToolsSchema, input);

/** Validate the canonical tool list again immediately before persistence. */
export const parseConnectorToolsForWrite = (input: unknown) =>
  parseAtBoundary(writableConnectorToolsSchema, input);
