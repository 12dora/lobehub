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

const bothBoundaries = (tool: Record<string, unknown>) => [
  () => parseDiscoveredConnectorTools([tool]),
  () => parseConnectorToolsForWrite([{ ...tool, id: 'tool-1' }]),
];

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

  it('scans every annotation string leaf and dynamic annotation object key', () => {
    const secret = 'Authorization: Bearer annotation-never-echo-this-token';
    const schemas = [
      { description: secret },
      { title: secret },
      { $comment: secret },
      { examples: [{ nested: { value: secret } }] },
      { examples: [{ [secret]: 'safe-value' }] },
    ];
    for (const schema of schemas) {
      for (const operation of bothBoundaries({ ...baseTool, outputSchema: schema })) {
        expectBoundaryCode(operation, CONNECTOR_TOOL_VALIDATION_CODES.schemaSecret, secret);
      }
    }
    for (const operation of bothBoundaries({
      ...baseTool,
      inputSchema: {
        properties: {
          apiKey: { description: 'User-provided API key', type: 'string' },
          password: { type: 'string' },
        },
      },
    })) {
      expect(operation).not.toThrow();
    }
  });

  it('scans all schema strings and dynamic keys while preserving semantic field names', () => {
    const secret = 'Authorization: Bearer schema-wide-never-echo';
    for (const schema of [
      { arbitraryKeyword: secret },
      { properties: { [secret]: { type: 'string' } } },
      { patternProperties: { [secret]: { type: 'string' } } },
      { required: ['apiKey', secret] },
    ]) {
      for (const operation of bothBoundaries({ ...baseTool, inputSchema: schema })) {
        expectBoundaryCode(operation, CONNECTOR_TOOL_VALIDATION_CODES.schemaSecret, secret);
      }
    }
    for (const operation of bothBoundaries({
      ...baseTool,
      inputSchema: {
        properties: {
          apiKey: { type: 'string' },
          password: { type: 'string' },
        },
        required: ['apiKey', 'password'],
      },
    })) {
      expect(operation).not.toThrow();
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

  it('allows only exact local $ref and rejects the complete mixed-case ref family', () => {
    for (const schema of [
      { $ref: 'https://attacker.example/schema.json' },
      { $dynamicRef: '#/$defs/value' },
      { $recursiveRef: '#' },
      { $recursiveAnchor: true },
      { $DynamicRef: '#/$defs/value' },
      { $REF: '#/$defs/value' },
      { $unknownDialect: 'value' },
      { 'x-schema-ref': '#/$defs/value' },
      { ref: '#/$defs/value' },
      { refFamily: '#/$defs/value' },
      { dialectRefTarget: '#/$defs/value' },
      { otherReference: '#/$defs/value' },
      { schemaAnchorTarget: 'value' },
    ]) {
      for (const operation of bothBoundaries({ ...baseTool, inputSchema: schema })) {
        expectBoundaryCode(operation, CONNECTOR_TOOL_VALIDATION_CODES.dangerousKeyword);
      }
    }
    for (const operation of bothBoundaries({
      ...baseTool,
      inputSchema: { $defs: { value: { type: 'string' } }, $ref: '#/$defs/value' },
    })) {
      expect(operation).not.toThrow();
    }
  });

  it('rejects every nested non-JSON domain value instead of relying on JSON.stringify', () => {
    const customPrototype = Object.assign(Object.create({ inherited: true }), { type: 'object' });
    let getterCalled = false;
    const getterObject = {};
    Object.defineProperty(getterObject, 'value', {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return 'unsafe';
      },
    });
    const nonEnumerable = { type: 'object' };
    Object.defineProperty(nonEnumerable, 'hidden', { enumerable: false, value: 'unsafe' });
    const symbolKey = { type: 'object' } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('hidden')] = 'unsafe';
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const invalidValues: unknown[] = [
      new Date(),
      customPrototype,
      getterObject,
      nonEnumerable,
      symbolKey,
      () => 'unsafe',
      undefined,
      Symbol('unsafe'),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      cycle,
    ];

    for (const value of invalidValues) {
      for (const operation of bothBoundaries({
        ...baseTool,
        inputSchema: { properties: { value: { default: value } } },
      })) {
        expectBoundaryCode(operation, CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
      }
    }
    for (const operation of bothBoundaries({ ...baseTool, inputSchema: getterObject })) {
      expectBoundaryCode(operation, CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
    }
    expect(getterCalled).toBe(false);
  });

  it('walks arrays by descriptor and rejects sparse/accessor/exotic arrays without access', () => {
    let getterCalls = 0;
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return { type: 'string' };
      },
    });
    accessorArray.length = 1;
    const nonEnumerableArray: unknown[] = [];
    Object.defineProperty(nonEnumerableArray, '0', {
      enumerable: false,
      value: { type: 'string' },
    });
    nonEnumerableArray.length = 1;
    const sparseArray: unknown[] = [];
    sparseArray.length = 2;
    sparseArray[0] = { type: 'string' };
    const symbolArray = [] as unknown as unknown[] & Record<PropertyKey, unknown>;
    symbolArray[Symbol('hidden')] = 'unsafe';
    const extraPropertyArray = [{ type: 'string' }] as unknown as unknown[] &
      Record<PropertyKey, unknown>;
    extraPropertyArray.extra = 'unsafe';
    const customPrototypeArray: unknown[] = [];
    Object.setPrototypeOf(customPrototypeArray, { custom: true });
    const cycleArray: unknown[] = [];
    cycleArray.push(cycleArray);

    for (const value of [
      accessorArray,
      nonEnumerableArray,
      sparseArray,
      symbolArray,
      extraPropertyArray,
      customPrototypeArray,
      cycleArray,
      [undefined],
      [() => 'unsafe'],
      [1n],
    ]) {
      for (const operation of bothBoundaries({
        ...baseTool,
        inputSchema: { anyOf: value },
      })) {
        expectBoundaryCode(operation, CONNECTOR_TOOL_VALIDATION_CODES.schemaInvalid);
      }
    }
    expect(getterCalls).toBe(0);
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
