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
const SECRET_BEARING_SCHEMA_KEYS = new Set(['const', 'default', 'enum', 'example', 'examples']);
const PROPERTY_CONTAINER_KEYS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);
const DANGEROUS_SCHEMA_KEYS = new Set([
  '$dynamicanchor',
  '$dynamicref',
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
  secretBearing: boolean;
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

export const containsConnectorCredentialMaterial = (value: string): boolean => {
  if (containsSensitiveMaterial(value)) return true;
  if (isCredentialBearingUrl(value)) return true;
  return (value.match(/https?:\/\/\S+/giu) ?? []).some(isCredentialBearingUrl);
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
  const normalized = key.toLowerCase();
  if (normalized === '$ref') return typeof value !== 'string' || !LOCAL_SCHEMA_REF.test(value);
  if (DANGEROUS_SCHEMA_KEYS.has(normalized)) return true;
  if (PROPERTY_CONTAINER_KEYS.has(parentKeyword ?? '')) {
    return normalized === '__proto__' || normalized === 'constructor' || normalized === 'prototype';
  }
  return (
    DANGEROUS_OPERATION_KEYS.has(normalized) ||
    (normalized.startsWith('x-') && DANGEROUS_EXTENSION_TOKEN.test(normalized))
  );
};

const validateSchemaPair = (
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
  ctx: z.RefinementCtx,
) => {
  for (const schema of [inputSchema, outputSchema]) {
    const bytes = byteLength(schema);
    if (bytes === null) addIssue(ctx, CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
    else if (bytes > MAX_SCHEMA_BYTES) addIssue(ctx, CONNECTOR_TOOL_VALIDATION_CODES.schemaSize);
  }

  const counters: SchemaCounters = { enumValues: 0, nodes: 0, properties: 0 };
  const stack: SchemaFrame[] = [
    { depth: 1, secretBearing: false, value: inputSchema },
    { depth: 1, secretBearing: false, value: outputSchema },
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
    if (typeof frame.value === 'string' && frame.secretBearing) {
      if (containsConnectorCredentialMaterial(frame.value))
        emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaSecret);
      continue;
    }
    if (Array.isArray(frame.value)) {
      for (const value of frame.value) {
        stack.push({ ...frame, depth: frame.depth + 1, value });
      }
      continue;
    }
    if (!isPlainRecord(frame.value)) continue;
    if (seen.has(frame.value)) {
      emitOnce(CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
      continue;
    }
    seen.add(frame.value);

    for (const [key, value] of Object.entries(frame.value)) {
      const normalized = key.toLowerCase();
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
        secretBearing: frame.secretBearing || SECRET_BEARING_SCHEMA_KEYS.has(normalized),
        value,
      });
    }
  }
};

export const connectorJsonObjectSchema = z
  .custom<Record<string, unknown>>(isPlainRecord, {
    message: CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid,
  })
  .pipe(z.record(z.string(), z.unknown()));

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
