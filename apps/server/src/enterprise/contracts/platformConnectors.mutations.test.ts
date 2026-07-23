import { describe, expect, it } from 'vitest';

import {
  adminConnectorArchiveInputSchema,
  adminConnectorDraftSchema,
  loadTrustedConnectorSecretContext,
  normalizeAdminConnectorCreateInput,
  PlatformConnectorContractError,
  userConnectorDisconnectInputSchema,
  userConnectorGetAuthorizationStatusInputSchema,
  userConnectorListManagedInputSchema,
  userConnectorStartAuthorizationInputSchema,
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

const trustedSecrets = (
  current: { oauthClientSecret?: unknown; sharedSecret?: unknown } = {},
  replacement: { oauthClientSecret?: unknown; sharedSecret?: unknown } = {},
) =>
  loadTrustedConnectorSecretContext(
    { loadCurrentSecretSources: async () => current },
    'connector-1',
    replacement,
  );
const createDerived = {
  id: 'connector-1',
  serverRedirectUri: 'https://aihub.example.test/oauth/connector/callback',
  toolIds: [],
};

describe('platform connector contracts — mutations', () => {
  it('constructs create Draft only from the command and server-derived identity', async () => {
    const context = await trustedSecrets();
    const command = {
      credentialMode: 'none' as const,
      displayName: 'None Connector',
      endpoint: 'https://none.example.test/mcp',
      key: 'none-connector',
      reason: 'create connector',
    };
    const normalized = normalizeAdminConnectorCreateInput(command, createDerived, context);
    expect(normalized.draft).toMatchObject({
      credentialMode: 'none',
      displayName: 'None Connector',
      endpoint: 'https://none.example.test/mcp',
      id: 'connector-1',
      key: 'none-connector',
      oauthConfig: null,
      status: 'draft',
    });
    for (const untrustedDerived of [
      draft as never,
      { ...createDerived, extraMetadata: 'attacker-controlled' } as never,
      { ...createDerived, toolIds: ['unexpected-tool-id'] },
    ]) {
      try {
        normalizeAdminConnectorCreateInput(command, untrustedDerived, context);
        expect.unreachable('untrusted create Draft metadata must be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(PlatformConnectorContractError);
        expect(error).toMatchObject({ code: 'PLATFORM_CONNECTOR_RESOURCE_MISMATCH' });
      }
    }
  });
  it('validates archive input and rejects userId on user-facing inputs', () => {
    const publication = {
      expectedDraftToken: 'd'.repeat(64),
      expectedRevision: 2,
      id: 'connector-1',
      reason: 'archive unused connector',
    };
    expect(adminConnectorArchiveInputSchema.parse(publication)).toEqual(publication);
    const userInputs = [
      [userConnectorListManagedInputSchema, { userId: 'other-user' }],
      [userConnectorStartAuthorizationInputSchema, { connectorId: 'connector-1', userId: 'other' }],
      [
        userConnectorGetAuthorizationStatusInputSchema,
        { attemptId: 'a'.repeat(32), connectorId: 'connector-1', userId: 'other' },
      ],
      [userConnectorDisconnectInputSchema, { connectorId: 'connector-1', userId: 'other' }],
    ] as const;
    for (const [schema, value] of userInputs) expect(schema.safeParse(value).success).toBe(false);
  });
});
