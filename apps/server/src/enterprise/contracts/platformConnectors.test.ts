import { describe, expect, it } from 'vitest';

import {
  ADMIN_CONNECTOR_PROCEDURE_PERMISSIONS,
  adminConnectorArchiveInputSchema,
  adminConnectorCreateDraftInputSchema,
  adminConnectorDraftSchema,
  adminConnectorUpdateDraftInputSchema,
  connectorEffectiveToolPolicyOutputSchema,
  connectorOAuthCallbackInputSchema,
  connectorOAuthClientSecretMutationSchema,
  connectorOAuthStatePayloadSchema,
  connectorReturnToSchema,
  connectorRuntimeResolutionSchema,
  connectorSafeMessageSchema,
  connectorScopesSchema,
  connectorSharedSecretMutationSchema,
  connectorToolDraftSchema,
  managedConnectorSchema,
  normalizeAdminConnectorUpdateInput,
  userConnectorDisconnectInputSchema,
  userConnectorGetAuthorizationStatusInputSchema,
  userConnectorListManagedInputSchema,
  userConnectorStartAuthorizationInputSchema,
  webConnectorTransportSchema,
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

describe('platform connector contracts', () => {
  it('models independent shared and OAuth client secret mutations', () => {
    expect(connectorSharedSecretMutationSchema.parse({ operation: 'keep' })).toEqual({
      operation: 'keep',
    });
    expect(
      connectorSharedSecretMutationSchema.parse({
        operation: 'replace',
        value: { headers: { Authorization: 'Bearer fake-token' } },
      }),
    ).toEqual({
      operation: 'replace',
      value: { headers: { Authorization: 'Bearer fake-token' } },
    });
    expect(connectorSharedSecretMutationSchema.parse({ operation: 'clear' })).toEqual({
      operation: 'clear',
    });
    expect(
      connectorOAuthClientSecretMutationSchema.parse({ operation: 'replace', value: 'fake' }),
    ).toEqual({ operation: 'replace', value: 'fake' });
    expect(
      connectorOAuthClientSecretMutationSchema.safeParse({
        operation: 'keep',
        value: 'smuggled',
      }).success,
    ).toBe(false);
  });

  it('accepts only HTTP transport in the web contract and fails stdio closed', () => {
    expect(webConnectorTransportSchema.parse('http')).toBe('http');
    expect(webConnectorTransportSchema.safeParse('stdio').success).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        credentialMode: 'none',
        displayName: 'Unsafe',
        endpoint: 'https://example.test',
        key: 'unsafe',
        reason: 'create',
        transport: 'stdio',
      }).success,
    ).toBe(false);
  });

  it('keeps credential modes mutually exclusive', () => {
    const base = {
      displayName: 'Connector',
      endpoint: 'https://example.test',
      key: 'connector',
      reason: 'create',
      transport: 'http',
    };
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        credentialMode: 'none',
        sharedSecret: { operation: 'clear' },
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        credentialMode: 'shared_service_account',
        oauthClientSecret: { operation: 'keep' },
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        credentialMode: 'per_user_oauth',
        oauthConfig: {
          authorizationEndpoint: 'https://identity.example.test/authorize',
          clientId: 'client-id',
          issuer: 'https://identity.example.test',
          scopes: ['issues:read'],
          tokenEndpoint: 'https://identity.example.test/token',
        },
        sharedSecret: { operation: 'replace', value: { apiKey: 'fake' } },
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        credentialMode: 'per_user_oauth',
      }).success,
    ).toBe(false);
  });

  it('revalidates a complete Draft after patch merge and clears incompatible secrets on mode switch', () => {
    const update = {
      credentialMode: 'none' as const,
      expectedDraftToken: 'd'.repeat(64),
      expectedRevision: 0,
      id: 'connector-1',
      reason: 'disable credentials',
    };
    expect(adminConnectorUpdateDraftInputSchema.parse(update)).toEqual(update);
    const normalized = normalizeAdminConnectorUpdateInput(
      draft,
      update,
      'https://aihub.example.test/oauth/connector/callback',
    );
    expect(normalized.candidate).toMatchObject({
      credentialMode: 'none',
      oauthClientSecret: secretState,
      oauthConfig: null,
      sharedSecret: secretState,
    });
    expect(normalized.patch).toMatchObject({
      oauthClientSecret: { operation: 'clear' },
      oauthConfig: null,
      sharedSecret: { operation: 'clear' },
    });
    const noneDraft = adminConnectorDraftSchema.parse({
      ...draft,
      credentialMode: 'none',
      oauthClientSecret: secretState,
      oauthConfig: null,
      sharedSecret: secretState,
    });
    expect(() =>
      normalizeAdminConnectorUpdateInput(
        noneDraft,
        {
          ...update,
          credentialMode: 'per_user_oauth',
          sharedSecret: { operation: 'replace', value: { apiKey: 'fake' } },
        },
        'https://aihub.example.test/oauth/connector/callback',
      ),
    ).toThrow();
  });

  it('rejects credential-bearing endpoints, sensitive JSON, and secret-bearing reason text', () => {
    const base = {
      credentialMode: 'none',
      displayName: 'Connector',
      key: 'connector',
      reason: 'create',
      transport: 'http',
    };
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        endpoint: 'https://user:password@example.test',
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        endpoint: 'https://example.test?access_token=fake',
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        endpoint: 'https://example.test',
        reason: 'Authorization: Bearer fake-token-value',
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        endpoint: 'file:///etc/passwd',
      }).success,
    ).toBe(false);
  });

  it('rejects secret-bearing discover/test messages at the output contract', () => {
    expect(connectorSafeMessageSchema.parse('Connector operation failed')).toBe(
      'Connector operation failed',
    );
    for (const unsafe of [
      'Authorization: Bearer fake-token-value',
      'request failed with sk-abcdefghijklmnopqrstuvwxyz123456',
      'request failed at https://user:password@example.test/path',
    ]) {
      expect(connectorSafeMessageSchema.safeParse(unsafe).success).toBe(false);
    }
  });

  it('returns only secret state in admin projections', () => {
    expect(adminConnectorDraftSchema.parse(draft)).toEqual(draft);
    expect(
      adminConnectorDraftSchema.safeParse({ ...draft, encryptedSharedSecret: 'ciphertext' })
        .success,
    ).toBe(false);
    expect(
      adminConnectorDraftSchema.safeParse({
        ...draft,
        oauthClientSecret: { ...secretState, value: 'plaintext' },
      }).success,
    ).toBe(false);
  });

  it('treats tool input as JSON Schema rather than rejecting sensitive property names', () => {
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

  it('binds callback authority exclusively to server-side state', () => {
    const now = Date.now();
    const state = {
      bindingId: 'binding-1',
      codeChallengeMethod: 'S256',
      codeVerifier: 'a'.repeat(43),
      connectorId: 'connector-1',
      expiresAt: now + 600_000,
      issuedAt: now,
      publishedRevision: 7,
      redirectUri: 'https://aihub.example.test/oauth/connector/callback',
      returnTo: '/settings/connectors?connected=1',
      scopes: ['issues:read'],
      stateHash: 'a'.repeat(64),
      stateId: 'b'.repeat(32),
      userId: 'user-1',
    };
    expect(connectorOAuthStatePayloadSchema.parse(state)).toEqual(state);
    expect(
      connectorOAuthCallbackInputSchema.parse({ code: 'code', state: 's'.repeat(32) }),
    ).toEqual({
      code: 'code',
      state: 's'.repeat(32),
    });
    expect(
      connectorOAuthCallbackInputSchema.safeParse({
        code: 'code',
        connectorId: 'attacker-selected',
        state: 's'.repeat(32),
      }).success,
    ).toBe(false);
    expect(
      connectorOAuthStatePayloadSchema.safeParse({ ...state, expiresAt: now - 1 }).success,
    ).toBe(false);
  });

  it('accepts only site-relative returnTo paths and an allowlisted scope set', () => {
    for (const valid of ['/settings/connectors', '/settings/connectors?status=ok#binding']) {
      expect(connectorReturnToSchema.parse(valid)).toBe(valid);
      expect(
        userConnectorStartAuthorizationInputSchema.safeParse({
          connectorId: 'connector-1',
          returnTo: valid,
        }).success,
      ).toBe(true);
    }
    for (const invalid of [
      'https://evil.example',
      '//evil.example/path',
      '/%2f%2fevil.example/path',
      '/%255c%255cevil.example/path',
      '/%25252525252525252525252f%25252525252525252525252fevil.example/path',
      '/settings%0d%0aLocation:%20https://evil.example',
      '/settings%00/connectors',
      '/settings%7f/connectors',
      '/\\evil.example',
    ]) {
      expect(connectorReturnToSchema.safeParse(invalid).success).toBe(false);
    }
    expect(connectorScopesSchema.parse(['openid', 'issues:read'])).toEqual([
      'openid',
      'issues:read',
    ]);
    expect(connectorScopesSchema.safeParse(['openid', 'openid']).success).toBe(false);
    expect(connectorScopesSchema.safeParse(['openid profile']).success).toBe(false);
  });

  it('defines archive and minimal admin permissions while user inputs never accept userId', () => {
    const publication = {
      expectedDraftToken: 'd'.repeat(64),
      expectedRevision: 2,
      id: 'connector-1',
      reason: 'archive unused connector',
    };
    expect(adminConnectorArchiveInputSchema.parse(publication)).toEqual(publication);
    expect(ADMIN_CONNECTOR_PROCEDURE_PERMISSIONS).toMatchObject({
      archive: 'platform_connector:delete:all',
      create: 'platform_connector:create:all',
      get: 'platform_connector:read:all',
      list: 'platform_connector:read:all',
      test: 'platform_connector:test:all',
      update: 'platform_connector:update:all',
    });
    const userInputs = [
      [userConnectorListManagedInputSchema, { userId: 'other-user' }],
      [userConnectorStartAuthorizationInputSchema, { connectorId: 'connector-1', userId: 'other' }],
      [
        userConnectorGetAuthorizationStatusInputSchema,
        { connectorId: 'connector-1', userId: 'other' },
      ],
      [userConnectorDisconnectInputSchema, { connectorId: 'connector-1', userId: 'other' }],
    ] as const;
    for (const [schema, value] of userInputs) expect(schema.safeParse(value).success).toBe(false);
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
