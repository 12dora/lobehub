import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const {
  mockAbandon,
  mockConsume,
  mockFindById,
  mockGetRuntime,
  mockManagedCallback,
  mockSync,
  mockUpdate,
} = vi.hoisted(() => ({
  mockAbandon: vi.fn(),
  mockConsume: vi.fn(),
  mockFindById: vi.fn(),
  mockGetRuntime: vi.fn(() => ({})),
  mockManagedCallback: vi.fn(),
  mockSync: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@/database/server', () => ({ serverDB: {} }));
vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'https://app.example.com' } }));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: vi.fn().mockResolvedValue({}) },
}));
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverAuthorizationServerMetadata: vi
    .fn()
    .mockResolvedValue({ token_endpoint: 'https://as/token' }),
}));
vi.mock('@/server/services/connector/oauth', () => ({
  exchangeConnectorCode: vi.fn().mockResolvedValue({ access_token: 'tok' }),
}));
vi.mock('@/server/services/connector/tokens', () => ({
  tokensToCredentials: vi
    .fn()
    .mockReturnValue({ credentials: { accessToken: 'tok', type: 'oauth2' }, tokenExpiresAt: null }),
}));
vi.mock('@/server/services/connector/stateStore', () => ({
  consumeConnectorOAuthState: mockConsume,
}));
vi.mock('@/database/models/connector', () => ({
  ConnectorModel: vi
    .fn()
    .mockImplementation(() => ({ findById: mockFindById, update: mockUpdate })),
}));
vi.mock('@/database/models/connectorTool', () => ({
  ConnectorToolModel: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@/server/services/connector/sync', () => ({ syncConnectorToolsById: mockSync }));
vi.mock('@/server/enterprise/services/connectorCatalog/oauthRuntime', () => ({
  getConnectorOAuthRuntime: mockGetRuntime,
  MANAGED_CONNECTOR_OAUTH_STATE_PREFIX: 'aihub-m09-v1.',
}));
vi.mock('@/server/enterprise/services/connectorCatalog/userOAuthService', () => ({
  ConnectorOAuthCallbackService: vi.fn().mockImplementation(() => ({
    abandonAuthorization: mockAbandon,
    callback: mockManagedCallback,
  })),
}));

const makeReq = (query = 'code=abc&state=xyz') =>
  ({ nextUrl: { searchParams: new URLSearchParams(query) } }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '0');
  mockAbandon.mockResolvedValue(undefined);
  mockManagedCallback.mockResolvedValue({});
  mockConsume.mockResolvedValue({
    authorizationServerUrl: 'https://as',
    codeVerifier: 'v',
    connectorId: 'c1',
    lobeUserId: 'u1',
  });
  mockFindById.mockResolvedValue({
    id: 'c1',
    mcpServerUrl: 'https://mcp.example.com',
    oidcConfig: {
      clientId: 'cid',
      redirectUri: 'https://app.example.com/oauth/connector/callback',
    },
  });
  mockUpdate.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe('connector OAuth callback', () => {
  it('reports synced:false when auth succeeds but tool sync fails', async () => {
    mockSync.mockRejectedValue(new Error('mcp down'));

    const body = await (await GET(makeReq())).text();

    expect(body).toContain('"success":true');
    expect(body).toContain('"synced":false');
  });

  it('reports synced:true when auth and tool sync both succeed', async () => {
    mockSync.mockResolvedValue({ toolCount: 5 });

    const body = await (await GET(makeReq())).text();

    expect(body).toContain('"success":true');
    expect(body).toContain('"synced":true');
  });

  it('does not reflect provider or internal errors on the legacy-compatible path', async () => {
    const providerError = 'legacy-provider-private-description';
    const denied = await GET(
      makeReq(`error=access_denied&error_description=${providerError}&state=legacy-state`),
    );
    expect(await denied.text()).not.toContain(providerError);

    mockFindById.mockRejectedValueOnce(new Error('legacy-vault-private-response'));
    const failed = await GET(makeReq('code=code&state=legacy-state'));
    expect(await failed.text()).not.toContain('legacy-vault-private-response');
  });

  it('uses the managed callback without reflecting provider errors or private failures', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
    const providerError = 'provider-private-error-description';
    const managedState = `aihub-m09-v1.${'s'.repeat(43)}`;
    const denied = await GET(
      makeReq(`error=access_denied&error_description=${providerError}&state=${managedState}`),
    );
    expect(await denied.text()).toContain('Authorization failed');
    expect(mockAbandon).toHaveBeenCalledWith(managedState);
    expect(
      await (
        await GET(
          makeReq(`error=access_denied&error_description=${providerError}&state=${managedState}`),
        )
      ).text(),
    ).not.toContain(providerError);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(denied.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(mockManagedCallback).not.toHaveBeenCalled();

    mockManagedCallback.mockRejectedValueOnce(new Error('vault-private-response'));
    const failed = await GET(makeReq(`code=abc&state=${managedState}`));
    const failedBody = await failed.text();
    expect(failedBody).toContain('Authorization failed');
    expect(failedBody).not.toContain('vault-private-response');
  });

  it('passes only code and opaque state to the managed callback', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
    const state = `aihub-m09-v1.${'s'.repeat(43)}`;
    const response = await GET(
      makeReq(`code=authorization-code&state=${state}&connectorId=attacker-controlled`),
    );

    expect(await response.text()).toContain('Authorization complete');
    expect(mockGetRuntime).toHaveBeenCalledWith(expect.anything());
    expect(mockManagedCallback).toHaveBeenCalledWith({ code: 'authorization-code', state });
    expect(JSON.stringify(mockManagedCallback.mock.calls)).not.toContain('attacker-controlled');
  });

  it('keeps legacy OAuth working with the flag on and never falls back for managed states', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
    mockSync.mockResolvedValue({ toolCount: 1 });
    const legacy = await GET(makeReq('code=legacy-code&state=legacy-state'));
    expect(await legacy.text()).toContain('"success":true');
    expect(mockConsume).toHaveBeenCalledWith('legacy-state');
    expect(mockManagedCallback).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockManagedCallback.mockRejectedValue(new Error('invalid managed state'));
    const forged = await GET(makeReq(`code=code&state=aihub-m09-v1.${'forged'.repeat(8)}`));
    expect(await forged.text()).toContain('Authorization failed');
    expect(mockManagedCallback).toHaveBeenCalledOnce();
    expect(mockConsume).not.toHaveBeenCalled();
  });
});
