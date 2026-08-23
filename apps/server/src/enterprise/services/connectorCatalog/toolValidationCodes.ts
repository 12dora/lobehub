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

export class ConnectorToolDefinitionValidationError extends Error {
  constructor(readonly code: ConnectorToolValidationCode) {
    super(code);
    this.name = 'ConnectorToolDefinitionValidationError';
  }
}
