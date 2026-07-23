import { describe, expect, it } from 'vitest';

import { CONNECTOR_TOOL_VALIDATION_CODES } from '../services/connectorCatalog/toolDefinitionValidator';
import {
  adminConnectorDraftSchema,
  connectorConnectionTestStateSchema,
  connectorEffectiveToolPolicyOutputSchema,
  connectorRuntimeResolutionSchema,
  connectorToolDraftSchema,
  managedConnectorSchema,
} from './platformConnectors';

const secretState = { configured: false, fingerprint: null, updatedAt: null } as const;
const draft = adminConnectorDraftSchema.parse({
  connectionTest: null,
  credentialMode: 'per_user_oauth',
  description: 'Issue tracker',
  displayName: 'Issues',
  enabled: true,
  endpoint: 'https://mcp.example.test/v1',
  id: 'connector-1',
  key: 'issues',
  oauthClientSecret: secretState,
  oauthConfig: {
    authorizationEndpoint: 'https://identity.example.test/authorize',
    clientId: 'client-id',
    issuer: 'https://identity.example.test',
    redirectUri: 'https://aihub.example.test/oauth/connector/callback',
    scopes: ['issues:read'],
    tokenEndpoint: 'https://identity.example.test/token',
  },
  revision: 0,
  sharedSecret: secretState,
  sort: 0,
  status: 'draft',
  tools: [],
  transport: 'http',
});

describe('platform connector contracts — projections/runtime', () => {
  it('binds connection-test status to exactly one message code', () => {
    const base = {
      errorCategory: null,
      latencyMs: 1,
      stale: false,
      status: 'success' as const,
      testedAt: new Date(),
      testedDraftToken: 'd'.repeat(64),
      testedRevision: 1,
    };
    expect(
      connectorConnectionTestStateSchema.safeParse({
        ...base,
        messageCode: 'connector.operation_succeeded',
      }).success,
    ).toBe(true);
    expect(
      connectorConnectionTestStateSchema.safeParse({
        ...base,
        messageCode: 'connector.operation_failed',
      }).success,
    ).toBe(false);
  });
  it('validates input/output JSON Schema without rejecting sensitive property names', () => {
    const baseTool = {
      description: null,
      displayName: 'Login',
      enabled: true,
      id: 'tool-1',
      platformPolicy: 'allow',
      requiresConfirmation: true,
      riskLevel: 'high',
      sort: 0,
      toolKey: 'login',
    } as const;
    expect(
      connectorToolDraftSchema.safeParse({
        ...baseTool,
        inputSchema: {
          properties: { apiKey: { type: 'string' }, password: { type: 'string' } },
          required: ['apiKey', 'password'],
          type: 'object',
        },
      }).success,
    ).toBe(true);
    for (const inputSchema of [
      { properties: { apiKey: { default: 'Authorization: Bearer fake-token-value' } } },
      { properties: { password: { example: 'Authorization: Bearer fake-token-value' } } },
      { properties: { token: { const: 'https://user:password@example.test' } } },
    ]) {
      expect(connectorToolDraftSchema.safeParse({ ...baseTool, inputSchema }).success).toBe(false);
    }
    const secretOutput = connectorToolDraftSchema.safeParse({
      ...baseTool,
      inputSchema: {},
      outputSchema: { example: 'Authorization: Bearer output-token' },
    });
    expect(secretOutput.success).toBe(false);
    if (!secretOutput.success) {
      expect(secretOutput.error.issues[0]?.message).toBe(
        CONNECTOR_TOOL_VALIDATION_CODES.schemaSecret,
      );
    }
    const unconfirmed = connectorToolDraftSchema.safeParse({
      ...baseTool,
      inputSchema: {},
      requiresConfirmation: false,
    });
    expect(unconfirmed.success).toBe(false);
    if (!unconfirmed.success) {
      expect(unconfirmed.error.issues[0]?.message).toBe(
        CONNECTOR_TOOL_VALIDATION_CODES.confirmationRequired,
      );
    }
  });
  it('never exposes endpoint, OAuth client, or secret metadata to ordinary users', () => {
    const managed = {
      binding: null,
      credentialMode: 'per_user_oauth',
      description: 'Issue tracker',
      displayName: 'Issues',
      id: 'connector-1',
      key: 'issues',
      publishedRevision: 4,
      tools: [],
    };
    expect(managedConnectorSchema.parse(managed)).toEqual(managed);
    for (const leaked of [
      { endpoint: 'https://mcp.example.test' },
      { oauthConfig: draft.oauthConfig },
      { oauthClientSecret: secretState },
      { sharedSecret: secretState },
      { transport: 'http' },
    ]) {
      expect(managedConnectorSchema.safeParse({ ...managed, ...leaked }).success).toBe(false);
    }
    expect(
      managedConnectorSchema.safeParse({
        ...managed,
        description: 'Authorization: Bearer fake-token-value',
      }).success,
    ).toBe(false);
  });
  it('keeps server-only runtime credentials discriminated and policy outputs relational', () => {
    const runtime = {
      connectorId: 'connector-1',
      credentialMode: 'none',
      endpoint: 'https://mcp.example.test/v1',
      publishedRevision: 2,
      tool: {
        description: null,
        displayName: 'Search',
        inputSchema: { type: 'object' },
        outputSchema: {},
        platformPolicy: 'allow',
        requiresConfirmation: false,
        riskLevel: 'low',
        sort: 0,
        toolKey: 'search',
      },
      transport: 'http',
    };
    expect(connectorRuntimeResolutionSchema.parse(runtime)).toEqual(runtime);
    expect(
      connectorRuntimeResolutionSchema.safeParse({ ...runtime, credentials: { apiKey: 'fake' } })
        .success,
    ).toBe(false);
    expect(
      connectorEffectiveToolPolicyOutputSchema.safeParse({ allowed: true, deniedBy: 'platform' })
        .success,
    ).toBe(false);
    expect(
      connectorEffectiveToolPolicyOutputSchema.safeParse({ allowed: false, deniedBy: null })
        .success,
    ).toBe(false);
  });
});
