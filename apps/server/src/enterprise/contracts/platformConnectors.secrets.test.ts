import { describe, expect, it } from 'vitest';

import { CONNECTOR_TOOL_VALIDATION_CODES } from '../services/connectorCatalog/toolDefinitionValidator';
import {
  adminConnectorCreateDraftInputSchema,
  adminConnectorDiscoverOutputSchema,
  adminConnectorDraftSchema,
  adminConnectorUpdateDraftInputSchema,
  collectConnectorSecretLeaves,
  connectorOAuthClientSecretMutationSchema,
  connectorSafeMessageSchema,
  connectorSharedSecretMutationSchema,
  loadTrustedConnectorSecretContext,
  normalizeAdminConnectorCreateInput,
  normalizeAdminConnectorUpdateInput,
  PlatformConnectorContractError,
} from './platformConnectors';

const secretState = { configured: false, fingerprint: null, updatedAt: null } as const;
const encodePercentRounds = (value: string, rounds: number): string => {
  let encoded = value;
  for (let index = 0; index < rounds; index += 1) encoded = encodeURIComponent(encoded);
  return encoded;
};
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

describe('platform connector contracts — secrets', () => {
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
  it('revalidates a complete Draft after patch merge and clears incompatible secrets on mode switch', async () => {
    const secretContext = await trustedSecrets();
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
      secretContext,
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
        secretContext,
      ),
    ).toThrow();
  });
  it('distinguishes undefined/null and reflects Secret clear in the complete candidate', async () => {
    const emptyContext = await trustedSecrets();
    const basePatch = {
      expectedDraftToken: 'd'.repeat(64),
      expectedRevision: 0,
      id: 'connector-1',
      reason: 'rotate credentials',
    };
    expect(() =>
      normalizeAdminConnectorUpdateInput(
        draft,
        { ...basePatch, oauthConfig: null },
        'https://aihub.example.test/oauth/connector/callback',
        emptyContext,
      ),
    ).toThrow();
    const configuredOAuthDraft = adminConnectorDraftSchema.parse({
      ...draft,
      oauthClientSecret: { configured: true, fingerprint: 'fp', updatedAt: null },
    });
    const cleared = normalizeAdminConnectorUpdateInput(
      configuredOAuthDraft,
      { ...basePatch, oauthClientSecret: { operation: 'clear' } },
      'https://aihub.example.test/oauth/connector/callback',
      await trustedSecrets({ oauthClientSecret: 'old-random-secret' }),
    );
    expect(cleared.candidate.oauthClientSecret).toEqual(secretState);
    expect(() =>
      normalizeAdminConnectorUpdateInput(
        configuredOAuthDraft,
        basePatch,
        'https://aihub.example.test/oauth/connector/callback',
        emptyContext,
      ),
    ).toThrowError(PlatformConnectorContractError);
    try {
      normalizeAdminConnectorUpdateInput(
        configuredOAuthDraft,
        basePatch,
        'https://aihub.example.test/oauth/connector/callback',
        { source: 'server-secret-store' },
      );
      expect.unreachable('forged Secret context must be rejected');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED' });
    }
    const wrongConnectorContext = await loadTrustedConnectorSecretContext(
      { loadCurrentSecretSources: async () => ({ oauthClientSecret: 'old-random-secret' }) },
      'other-connector',
      {},
    );
    expect(() =>
      normalizeAdminConnectorUpdateInput(
        configuredOAuthDraft,
        basePatch,
        'https://aihub.example.test/oauth/connector/callback',
        wrongConnectorContext,
      ),
    ).toThrowError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
    expect(() =>
      normalizeAdminConnectorUpdateInput(
        draft,
        { ...basePatch, oauthClientSecret: { operation: 'replace', value: 'replacement-value' } },
        'https://aihub.example.test/oauth/connector/callback',
        emptyContext,
      ),
    ).toThrowError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  });
  it('requires current, patch, and trusted Secret context connector identities to match', async () => {
    const basePatch = {
      expectedDraftToken: 'd'.repeat(64),
      expectedRevision: 0,
      id: 'connector-1',
      reason: 'safe update',
    };
    const context = await trustedSecrets();
    expect(
      normalizeAdminConnectorUpdateInput(
        draft,
        basePatch,
        'https://aihub.example.test/oauth/connector/callback',
        context,
      ).candidate.id,
    ).toBe('connector-1');

    const mismatches = [
      {
        context,
        current: draft,
        patch: { ...basePatch, id: 'other-connector' },
      },
      {
        context: await loadTrustedConnectorSecretContext(
          { loadCurrentSecretSources: async () => ({}) },
          'other-connector',
          {},
        ),
        current: draft,
        patch: basePatch,
      },
      {
        context,
        current: adminConnectorDraftSchema.parse({ ...draft, id: 'other-connector' }),
        patch: basePatch,
      },
    ];
    for (const mismatch of mismatches) {
      try {
        normalizeAdminConnectorUpdateInput(
          mismatch.current,
          mismatch.patch,
          'https://aihub.example.test/oauth/connector/callback',
          mismatch.context,
        );
        expect.unreachable('resource identity mismatch must be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(PlatformConnectorContractError);
        expect(error).toMatchObject({ code: 'PLATFORM_CONNECTOR_RESOURCE_MISMATCH' });
      }
    }
  });
  it('enforces bidirectional Secret slot consistency without cross-slot substitution', async () => {
    const basePatch = {
      expectedDraftToken: 'd'.repeat(64),
      expectedRevision: 0,
      id: 'connector-1',
      reason: 'safe update',
    };
    const configuredOAuthDraft = adminConnectorDraftSchema.parse({
      ...draft,
      oauthClientSecret: { configured: true, fingerprint: 'fp', updatedAt: null },
    });
    for (const invalidContext of [
      await trustedSecrets({ sharedSecret: 'wrong-slot-value' }),
      await trustedSecrets({ oauthClientSecret: 'real-value', sharedSecret: 'unrelated-value' }),
    ]) {
      expect(() =>
        normalizeAdminConnectorUpdateInput(
          configuredOAuthDraft,
          basePatch,
          'https://aihub.example.test/oauth/connector/callback',
          invalidContext,
        ),
      ).toThrowError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
    }
    const unexpectedCurrentContext = await trustedSecrets({
      oauthClientSecret: 'unexpected-value',
    });
    expect(() =>
      normalizeAdminConnectorUpdateInput(
        draft,
        basePatch,
        'https://aihub.example.test/oauth/connector/callback',
        unexpectedCurrentContext,
      ),
    ).toThrowError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
    const wrongReplacementContext = await trustedSecrets({}, { sharedSecret: 'replacement-value' });
    expect(() =>
      normalizeAdminConnectorUpdateInput(
        draft,
        { ...basePatch, oauthClientSecret: { operation: 'replace', value: 'replacement-value' } },
        'https://aihub.example.test/oauth/connector/callback',
        wrongReplacementContext,
      ),
    ).toThrowError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  });
  it('requires create/update normalizers to reject current and replacement secrets in persisted text', async () => {
    const currentSecret = 'old-random-secret-123';
    const replacementSecret = 'new-random-secret-456';
    const secretContext = await trustedSecrets(
      { oauthClientSecret: { [currentSecret]: 'current-secret-value' } },
      { oauthClientSecret: replacementSecret },
    );
    const configuredDraft = adminConnectorDraftSchema.parse({
      ...draft,
      oauthClientSecret: { configured: true, fingerprint: 'fp', updatedAt: null },
    });
    const basePatch = {
      expectedDraftToken: 'd'.repeat(64),
      expectedRevision: 0,
      id: 'connector-1',
      oauthClientSecret: { operation: 'replace' as const, value: replacementSecret },
      reason: 'safe reason',
    };
    for (const patch of [
      { ...basePatch, description: `leak ${currentSecret}` },
      { ...basePatch, description: 'leak current-secret-value' },
      { ...basePatch, displayName: `leak ${replacementSecret}` },
      {
        ...basePatch,
        tools: [
          {
            description: `leak ${currentSecret}`,
            displayName: 'Tool',
            enabled: true,
            id: 'tool-1',
            inputSchema: { properties: { value: { example: replacementSecret } } },
            platformPolicy: 'allow' as const,
            requiresConfirmation: false,
            riskLevel: 'low' as const,
            sort: 0,
            toolKey: 'tool',
          },
        ],
      },
      {
        ...basePatch,
        tools: [
          {
            description: null,
            displayName: 'Tool',
            enabled: true,
            id: 'tool-key-1',
            inputSchema: {
              properties: {
                [currentSecret]: { type: 'string' },
                nested: { [replacementSecret]: { type: 'string' } },
              },
            },
            platformPolicy: 'allow' as const,
            requiresConfirmation: false,
            riskLevel: 'low' as const,
            sort: 0,
            toolKey: 'tool-key',
          },
        ],
      },
    ]) {
      expect(() =>
        normalizeAdminConnectorUpdateInput(
          configuredDraft,
          patch,
          'https://aihub.example.test/oauth/connector/callback',
          secretContext,
        ),
      ).toThrowError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
    }

    const createContext = await trustedSecrets({}, { sharedSecret: { apiKey: replacementSecret } });
    expect(() =>
      normalizeAdminConnectorCreateInput(
        {
          credentialMode: 'shared_service_account',
          displayName: 'Connector',
          endpoint: 'https://example.test',
          key: 'connector',
          reason: `reason ${replacementSecret}`,
          sharedSecret: { operation: 'replace', value: { apiKey: replacementSecret } },
        },
        createDerived,
        createContext,
      ),
    ).toThrowError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
    expect(() =>
      normalizeAdminConnectorCreateInput(
        {
          credentialMode: 'shared_service_account',
          displayName: `Connector ${replacementSecret}`,
          endpoint: 'https://example.test',
          key: 'connector',
          reason: 'create connector',
          sharedSecret: { operation: 'replace', value: { apiKey: replacementSecret } },
        },
        createDerived,
        createContext,
      ),
    ).toThrowError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
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
    for (const reference of [
      'prefix VAULT://connectors/private suffix',
      'reason KmS://tenant/key/version',
      'ｖａｕｌｔ：／／connectors/private',
      '%76ault%3A%2F%2Fconnectors%2Fprivate',
      '%2576ault%253A%252F%252Fconnectors%252Fprivate',
      encodePercentRounds('vault://connectors/private', 5),
      encodePercentRounds('vault://connectors/private', 10),
      encodeURIComponent('ｖａｕｌｔ：／／connectors/private'),
      'malformed percent %',
      'malformed percent %G0',
    ]) {
      expect(
        adminConnectorCreateDraftInputSchema.safeParse({
          ...base,
          endpoint: 'https://example.test',
          reason: reference,
        }).success,
      ).toBe(false);
      expect(
        adminConnectorCreateDraftInputSchema.safeParse({
          ...base,
          description: reference,
          endpoint: 'https://example.test',
        }).success,
      ).toBe(false);
    }
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
    const invalidSecretUrl = 'https://[Authorization:Bearer-invalid-url-never-echo';
    const invalidResult = adminConnectorCreateDraftInputSchema.safeParse({
      ...base,
      endpoint: invalidSecretUrl,
    });
    expect(invalidResult.success).toBe(false);
    if (!invalidResult.success)
      expect(JSON.stringify(invalidResult.error)).not.toContain(invalidSecretUrl);
  });
  it('rejects secret-bearing discover/test messages at the output contract', () => {
    expect(connectorSafeMessageSchema.parse('connector.operation_failed')).toBe(
      'connector.operation_failed',
    );
    for (const unsafe of [
      'Discovery complete',
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
  it('rejects secret-bearing discovery output without echoing the schema leaf', () => {
    const secret = 'Authorization: Bearer discovery-output-never-echo';
    const result = adminConnectorDiscoverOutputSchema.safeParse({
      messageCode: 'connector.operation_succeeded',
      oauthConfig: null,
      tools: [
        {
          description: null,
          displayName: 'Search',
          enabled: true,
          inputSchema: { type: 'object' },
          outputSchema: { examples: [{ [secret]: 'safe' }] },
          platformPolicy: 'deny',
          requiresConfirmation: true,
          riskLevel: 'high',
          sort: 0,
          toolKey: 'search',
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(CONNECTOR_TOOL_VALIDATION_CODES.schemaSecret);
      expect(JSON.stringify(result.error.issues)).not.toContain(secret);
    }
  });
  it('collects Secret leaves schema-aware while preserving known structured field names', () => {
    const dynamicSecretKey = 'dynamic-real-secret-key';
    const leaves = collectConnectorSecretLeaves({
      apiKey: 'api-key-value',
      headers: { [dynamicSecretKey]: 'header-secret-value' },
      nestedDynamicSecret: 'nested-secret-value',
      password: 'password-value',
    });
    expect(leaves).toEqual(
      new Set([
        'api-key-value',
        dynamicSecretKey,
        'header-secret-value',
        'nestedDynamicSecret',
        'nested-secret-value',
        'password-value',
      ]),
    );
    expect(leaves.has('apiKey')).toBe(false);
    expect(leaves.has('password')).toBe(false);
  });
});
