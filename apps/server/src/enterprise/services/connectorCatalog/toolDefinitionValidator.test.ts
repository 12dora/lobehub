import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_TOOL_VALIDATION_CODES,
  ConnectorToolDefinitionValidationError,
  parseConnectorToolsForWrite,
  parseDiscoveredConnectorTools,
} from './toolDefinitionValidator';

const baseTool = {
  description: null,
  displayName: 'Search',
  enabled: true,
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  platformPolicy: 'allow',
  requiresConfirmation: false,
  riskLevel: 'low',
  sort: 0,
  toolKey: 'search.v1',
} as const;

const expectBoundaryCode = (
  operation: () => unknown,
  code: (typeof CONNECTOR_TOOL_VALIDATION_CODES)[keyof typeof CONNECTOR_TOOL_VALIDATION_CODES],
  forbiddenText?: string,
) => {
  try {
    operation();
    throw new Error('Expected connector tool validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorToolDefinitionValidationError);
    expect(error).toMatchObject({ code, message: code });
    if (forbiddenText) expect(JSON.stringify(error)).not.toContain(forbiddenText);
  }
};

const schemaAtDepth = (depth: number) => {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let index = 0; index < depth; index += 1) schema = { allOf: [schema] };
  return schema;
};

describe('connector tool definition validator', () => {
  it('normalizes discovery and write through the same strict object boundary', () => {
    const withoutOutput = { ...baseTool, outputSchema: undefined };
    const discovered = parseDiscoveredConnectorTools([withoutOutput]);
    const writable = parseConnectorToolsForWrite([{ ...withoutOutput, id: 'tool-1' }]);

    expect(discovered[0]).toMatchObject({ outputSchema: {}, toolKey: 'search.v1' });
    expect(writable[0]).toMatchObject({ id: 'tool-1', outputSchema: {}, toolKey: 'search.v1' });
    expectBoundaryCode(
      () => parseDiscoveredConnectorTools([{ ...baseTool, unexpected: true }]),
      CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid,
    );
    expectBoundaryCode(
      () => parseConnectorToolsForWrite([{ ...baseTool, id: 'tool-1', inputSchema: [] }]),
      CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid,
    );
    expectBoundaryCode(
      () => parseDiscoveredConnectorTools([{ ...baseTool, outputSchema: new Date() }]),
      CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid,
    );
  });

  it('enforces the exact 64 KiB UTF-8 bound independently for input and output', () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ description: '' })).byteLength;
    const exact = { description: 'x'.repeat(64 * 1024 - overhead) };
    expect(() =>
      parseDiscoveredConnectorTools([{ ...baseTool, inputSchema: exact }]),
    ).not.toThrow();

    for (const field of ['inputSchema', 'outputSchema'] as const) {
      expectBoundaryCode(
        () =>
          parseDiscoveredConnectorTools([
            { ...baseTool, [field]: { description: `${exact.description}x` } },
          ]),
        CONNECTOR_TOOL_VALIDATION_CODES.schemaSize,
      );
    }
  });

  it('caps aggregate depth, node, property, and enum complexity across both schemas', () => {
    expectBoundaryCode(
      () => parseDiscoveredConnectorTools([{ ...baseTool, inputSchema: schemaAtDepth(21) }]),
      CONNECTOR_TOOL_VALIDATION_CODES.schemaDepth,
    );
    expectBoundaryCode(
      () =>
        parseDiscoveredConnectorTools([
          { ...baseTool, inputSchema: { anyOf: Array.from({ length: 4096 }, () => null) } },
        ]),
      CONNECTOR_TOOL_VALIDATION_CODES.schemaNodes,
    );
    expectBoundaryCode(
      () =>
        parseDiscoveredConnectorTools([
          {
            ...baseTool,
            outputSchema: {
              properties: Object.fromEntries(
                Array.from({ length: 1025 }, (_, index) => [`field-${index}`, {}]),
              ),
            },
          },
        ]),
      CONNECTOR_TOOL_VALIDATION_CODES.schemaProperties,
    );
    expectBoundaryCode(
      () =>
        parseDiscoveredConnectorTools([
          { ...baseTool, outputSchema: { enum: Array.from({ length: 1025 }, () => '') } },
        ]),
      CONNECTOR_TOOL_VALIDATION_CODES.schemaEnum,
    );
  });

  it('blocks Secret-bearing annotation values in input and output without echoing them', () => {
    const secret = 'Authorization: Bearer validator-never-echo-this-token';
    for (const [field, schema] of [
      ['inputSchema', { properties: { token: { default: secret } } }],
      ['outputSchema', { examples: [{ access: secret }] }],
      ['inputSchema', { const: `https://user:${secret}@example.test` }],
      ['outputSchema', { enum: ['safe', secret] }],
    ] as const) {
      expectBoundaryCode(
        () => parseConnectorToolsForWrite([{ ...baseTool, [field]: schema, id: 'tool-1' }]),
        CONNECTOR_TOOL_VALIDATION_CODES.schemaSecret,
        secret,
      );
    }
  });

  it('fails closed on external references and dangerous execution/outbound keywords', () => {
    for (const schema of [
      { $ref: 'https://attacker.example/schema.json' },
      { $schema: 'https://json-schema.org/draft/2020-12/schema' },
      { command: 'run' },
      { 'x-exec-command': 'run' },
      { contentMediaType: 'application/x-sh' },
    ]) {
      expectBoundaryCode(
        () => parseDiscoveredConnectorTools([{ ...baseTool, inputSchema: schema }]),
        CONNECTOR_TOOL_VALIDATION_CODES.dangerousKeyword,
      );
    }
    expect(() =>
      parseDiscoveredConnectorTools([
        {
          ...baseTool,
          inputSchema: {
            $defs: { query: { type: 'string' } },
            $ref: '#/$defs/query',
            properties: { command: { type: 'string' }, url: { type: 'string' } },
          },
        },
      ]),
    ).not.toThrow();
  });

  it('requires confirmation for high and critical tools at both boundaries', () => {
    for (const riskLevel of ['high', 'critical'] as const) {
      expectBoundaryCode(
        () =>
          parseDiscoveredConnectorTools([{ ...baseTool, requiresConfirmation: false, riskLevel }]),
        CONNECTOR_TOOL_VALIDATION_CODES.confirmationRequired,
      );
      expectBoundaryCode(
        () =>
          parseConnectorToolsForWrite([
            { ...baseTool, id: `tool-${riskLevel}`, requiresConfirmation: false, riskLevel },
          ]),
        CONNECTOR_TOOL_VALIDATION_CODES.confirmationRequired,
      );
    }
  });

  it('enforces stable case-insensitive operation identity and bounded lists', () => {
    expectBoundaryCode(
      () => parseDiscoveredConnectorTools([{ ...baseTool, toolKey: 'unsafe operation' }]),
      CONNECTOR_TOOL_VALIDATION_CODES.invalidOperation,
    );
    expectBoundaryCode(
      () =>
        parseDiscoveredConnectorTools([
          baseTool,
          { ...baseTool, displayName: 'Duplicate', toolKey: 'SEARCH.V1' },
        ]),
      CONNECTOR_TOOL_VALIDATION_CODES.duplicateOperation,
    );
    expectBoundaryCode(
      () =>
        parseDiscoveredConnectorTools(
          Array.from({ length: 1001 }, (_, index) => ({
            ...baseTool,
            toolKey: `operation-${index}`,
          })),
        ),
      CONNECTOR_TOOL_VALIDATION_CODES.toolCount,
    );
  });

  it('collapses arbitrary parser details into one stable non-echoing issue', () => {
    const secretField = 'validator-secret-field-never-echo';
    expectBoundaryCode(
      () => parseConnectorToolsForWrite([{ ...baseTool, [secretField]: true, id: 'tool-1' }]),
      CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid,
      secretField,
    );
  });
});
