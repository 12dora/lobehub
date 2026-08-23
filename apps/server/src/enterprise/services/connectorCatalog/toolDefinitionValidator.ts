import { isPlainRecord } from '@lobechat/utils/object';
import { z } from 'zod';

import { containsConnectorCredentialMaterial, validateSchemaPair } from './toolSchemaWalker';
import {
  CONNECTOR_TOOL_VALIDATION_CODES,
  ConnectorToolDefinitionValidationError,
  type ConnectorToolValidationCode,
} from './toolValidationCodes';

export {
  CONNECTOR_TOOL_VALIDATION_CODES,
  ConnectorToolDefinitionValidationError,
  containsConnectorCredentialMaterial,
};
export type { ConnectorToolValidationCode };

const MAX_TOOL_COUNT = 1000;
const STABLE_OPERATION_KEY = /^[A-Za-z0-9][\w.:/-]{0,199}$/u;
const VALIDATION_CODE_SET = new Set<ConnectorToolValidationCode>(
  Object.values(CONNECTOR_TOOL_VALIDATION_CODES),
);

interface ConnectorToolSecurityFields {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requiresConfirmation: boolean;
  riskLevel: 'critical' | 'high' | 'low' | 'medium';
  toolKey: string;
}

const addIssue = (ctx: z.RefinementCtx, code: ConnectorToolValidationCode) =>
  ctx.addIssue({ code: 'custom', message: code });

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
