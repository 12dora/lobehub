// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiProviderModel } from '@/database/models/aiProvider';
import { ChatGPTWebOAuthService } from '@/server/enterprise/services/chatgptWeb/oauthService';

const mocks = vi.hoisted(() => ({
  encrypt: vi.fn(async (value: string) => value),
  getAiProviderById: vi.fn(),
  getOAuthService: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => ({})) }));

vi.mock('@/database/models/aiProvider', () => ({
  AiProviderModel: vi.fn().mockImplementation(() => ({
    getAiProviderById: mocks.getAiProviderById,
    updateConfig: mocks.updateConfig,
  })),
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: {
    getUserKeyVaults: vi.fn(),
    initWithEnvKey: vi.fn(async () => ({ encrypt: mocks.encrypt })),
  },
}));

// The managed-resource guard needs a live database; the real router keeps its guard keys
// (asserted by managedResourceRealRouters.test.ts) — here it is a pass-through.
vi.mock('@/server/enterprise/guards/managedResource', async () => {
  const { trpc } = await import('@/libs/trpc/lambda/init');
  return { withManagedResourceGuard: () => trpc.middleware(async (opts) => opts.next()) };
});

vi.mock('@/server/services/oauthDeviceFlow/providers/githubCopilot', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOAuthService: mocks.getOAuthService };
});

const { oauthDeviceFlowRouter } = await import('./oauthDeviceFlow');

const caller = (ctx: Record<string, unknown> = {}) =>
  oauthDeviceFlowRouter.createCaller({ userId: 'user-1', ...ctx } as any);

const PROVIDER = 'chatgptweb';

let authFetch: ReturnType<typeof vi.fn>;
let transportFetch: ReturnType<typeof vi.fn>;
let service: ChatGPTWebOAuthService;

const jwt = (claims: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'sig',
  ].join('.');

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

const futureExp = Math.floor(Date.now() / 1000) + 86_400;

const startFlow = async () => {
  const initiated = await caller().initiateDeviceCode({ providerId: PROVIDER });
  return initiated;
};

beforeEach(() => {
  vi.clearAllMocks();
  authFetch = vi.fn();
  transportFetch = vi.fn();
  service = new ChatGPTWebOAuthService({
    authFetch: authFetch as unknown as typeof fetch,
    transportFetch: transportFetch as unknown as typeof fetch,
  });
  mocks.getOAuthService.mockReturnValue(service);
  mocks.updateConfig.mockResolvedValue(undefined);
});

describe('oauthDeviceFlow.initiateDeviceCode', () => {
  it('returns the paste-flow shape with an authorize URL and no user code', async () => {
    const result = await startFlow();

    expect(result.flow).toBe('authorization_code_paste');
    expect(result.allowAccessTokenPaste).toBe(true);
    expect(result.userCode).toBe('');
    expect(result.interval).toBe(0);
    expect(result.verificationUri).toContain('https://auth.openai.com/api/accounts/authorize');
    expect(result.verificationUriComplete).toBe(result.verificationUri);
    // The envelope is client-held state: the server persisted nothing.
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });
});

describe('oauthDeviceFlow.pollAuthStatus (paste flow)', () => {
  it('stays pending — and does NO network work — until something is pasted', async () => {
    const { deviceCode } = await startFlow();

    const result = await caller().pollAuthStatus({ deviceCode, providerId: PROVIDER });

    expect(result).toEqual({ status: 'pending' });
    expect(authFetch).not.toHaveBeenCalled();
    expect(transportFetch).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it('exchanges a pasted callback URL and stores every identity leaf', async () => {
    const { deviceCode } = await startFlow();
    const state = JSON.parse(deviceCode).state;
    authFetch.mockResolvedValue(
      jsonResponse({
        access_token: jwt({ exp: futureExp }),
        id_token: jwt({
          'email': 'user@example.com',
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' },
        }),
        refresh_token: 'refresh-1',
      }),
    );

    const result = await caller().pollAuthStatus({
      callbackUrl: `https://platform.openai.com/auth/callback?code=the-code&state=${state}`,
      deviceCode,
      providerId: PROVIDER,
    });

    expect(result).toEqual({ status: 'success' });
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      PROVIDER,
      {
        keyVaults: {
          oauthAccessToken: jwt({ exp: futureExp }),
          oauthAccountEmail: 'user@example.com',
          oauthAccountId: 'acct-42',
          oauthDeviceId: JSON.parse(deviceCode).deviceId,
          // Connect time anchors the 3-day keepalive for a grant never yet refreshed.
          oauthLastRefreshAt: expect.any(String),
          oauthLastRefreshErrorAt: undefined,
          oauthRefreshToken: 'refresh-1',
          oauthTokenExpiresAt: String(futureExp * 1000),
        },
      },
      expect.anything(),
      expect.anything(),
    );
  });

  it('stores a pasted access token without a refresh token, reusing the envelope device id', async () => {
    const { deviceCode } = await startFlow();
    transportFetch.mockResolvedValue(jsonResponse({ email: 'me@example.com', id: 'user-9' }));

    const result = await caller().pollAuthStatus({
      accessToken: jwt({ exp: futureExp }),
      deviceCode,
      providerId: PROVIDER,
    });

    expect(result).toEqual({ status: 'success' });
    const stored = mocks.updateConfig.mock.calls[0][1].keyVaults;
    expect(stored.oauthRefreshToken).toBeUndefined();
    expect(stored.oauthAccountEmail).toBe('me@example.com');
    expect(stored.oauthDeviceId).toBe(JSON.parse(deviceCode).deviceId);
    expect(authFetch).not.toHaveBeenCalled();
  });

  /**
   * The user-side twin of the shared-account finding: a personal connection reconnected
   * with a pasted access token must not keep the previous grant. `updateConfig` merges
   * `{...existing, ...new}` and drops explicit `undefined`s on serialization, so every
   * leaf the new tokens do not provide has to be present-and-undefined here.
   */
  it('revokes the leaves a pasted access token does not provide', async () => {
    const { deviceCode } = await startFlow();
    transportFetch.mockResolvedValue(jsonResponse({}));

    await caller().pollAuthStatus({
      accessToken: jwt({ exp: futureExp }),
      deviceCode,
      providerId: PROVIDER,
    });

    const stored = mocks.updateConfig.mock.calls[0][1].keyVaults;
    expect(Object.keys(stored).sort()).toEqual([
      'oauthAccessToken',
      'oauthAccountEmail',
      'oauthAccountId',
      'oauthDeviceId',
      'oauthLastRefreshAt',
      'oauthLastRefreshErrorAt',
      'oauthRefreshToken',
      'oauthTokenExpiresAt',
    ]);
    expect(stored.oauthRefreshToken).toBeUndefined();
    expect(stored.oauthAccountEmail).toBeUndefined();
    expect(stored.oauthAccountId).toBeUndefined();
  });

  it.each([
    ['malformed json', async () => 'not-json', 'invalid_callback'],
    [
      'a well-formed but stale envelope',
      async () => {
        const { deviceCode } = await startFlow();
        return JSON.stringify({
          ...JSON.parse(deviceCode),
          createdAt: Date.now() - 11 * 60 * 1000,
        });
      },
      'expired',
    ],
  ])('rejects an access-token paste carrying %s', async (_label, buildDeviceCode, code) => {
    const result = await caller().pollAuthStatus({
      accessToken: jwt({ exp: futureExp }),
      deviceCode: await buildDeviceCode(),
      providerId: PROVIDER,
    });

    // Silently minting a new device id would break the stable `oai-device-id` contract.
    expect(result).toEqual({ error: code, status: 'error' });
    expect(transportFetch).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it('rejects a device code larger than the contract bound', async () => {
    await expect(
      caller().pollAuthStatus({
        accessToken: 'x',
        deviceCode: 'a'.repeat(8193),
        providerId: PROVIDER,
      }),
    ).rejects.toThrow();
  });

  it.each([
    [
      'state_mismatch',
      async (deviceCode: string) => ({
        callbackUrl: 'https://platform.openai.com/auth/callback?code=c&state=forged',
        deviceCode,
        providerId: PROVIDER,
      }),
    ],
    [
      'state_mismatch',
      async (deviceCode: string) => ({
        // A pasted redirect URL always echoes state back; one without it is fabricated.
        callbackUrl: 'https://platform.openai.com/auth/callback?code=c',
        deviceCode,
        providerId: PROVIDER,
      }),
    ],
    [
      'invalid_callback',
      async (deviceCode: string) => ({ callbackUrl: '   ', deviceCode, providerId: PROVIDER }),
    ],
  ])('maps a bad paste to %s and stores nothing', async (code, buildInput) => {
    const { deviceCode } = await startFlow();

    const result = await caller().pollAuthStatus(await buildInput(deviceCode));

    expect(result).toEqual({ error: code, status: 'error' });
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it('maps a stale envelope to expired', async () => {
    const { deviceCode } = await startFlow();
    const envelope = JSON.parse(deviceCode);
    envelope.createdAt = Date.now() - 11 * 60 * 1000;

    const result = await caller().pollAuthStatus({
      callbackUrl: 'the-code',
      deviceCode: JSON.stringify(envelope),
      providerId: PROVIDER,
    });

    expect(result).toEqual({ error: 'expired', status: 'error' });
  });

  it('maps a rejected exchange to exchange_failed without echoing provider prose', async () => {
    const { deviceCode } = await startFlow();
    authFetch.mockResolvedValue(
      jsonResponse({ error: 'invalid_grant', error_description: 'code already used' }, 400),
    );

    const result = await caller().pollAuthStatus({
      callbackUrl: 'the-code',
      deviceCode,
      providerId: PROVIDER,
    });

    expect(result).toEqual({ error: 'exchange_failed', status: 'error' });
    expect(JSON.stringify(result)).not.toContain('already used');
  });

  /**
   * The access-token paste path takes the DEVICE ID out of the envelope and persists it —
   * it is then sent as `oai-device-id` on every later request. A shape-only check let an
   * empty (or fabricated) id through, so the envelope is validated field by field and a bad
   * one is refused before any token is verified or stored.
   */
  it.each([
    ['an empty device id', { deviceId: '' }],
    ['a non-uuid device id', { deviceId: 'device-1' }],
    ['an empty verifier', { verifier: '' }],
    ['an undotted state', { state: 'nodot' }],
    ['a future createdAt', { createdAt: Date.now() + 5 * 60 * 1000 }],
  ])('refuses an access-token paste carrying %s', async (_label, patch) => {
    const { deviceCode } = await startFlow();

    const result = await caller().pollAuthStatus({
      accessToken: 'some-token',
      deviceCode: JSON.stringify({ ...JSON.parse(deviceCode), ...patch }),
      providerId: PROVIDER,
    });

    expect(result).toEqual({ error: 'invalid_callback', status: 'error' });
    expect(transportFetch).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it('maps an unusable access token to access_token_invalid', async () => {
    const { deviceCode } = await startFlow();
    transportFetch.mockResolvedValue(jsonResponse({ detail: 'nope' }, 401));

    const result = await caller().pollAuthStatus({
      accessToken: 'dead-token',
      deviceCode,
      providerId: PROVIDER,
    });

    expect(result).toEqual({ error: 'access_token_invalid', status: 'error' });
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });
});

describe('oauthDeviceFlow.getAuthStatus', () => {
  it('reports the connected identity and that it can auto-renew', async () => {
    mocks.getAiProviderById.mockResolvedValue({
      keyVaults: {
        oauthAccessToken: 'token',
        oauthAccountEmail: 'user@example.com',
        oauthRefreshToken: 'refresh',
        oauthTokenExpiresAt: '1700000000000',
      },
    });

    expect(await caller().getAuthStatus({ providerId: PROVIDER })).toMatchObject({
      canRefresh: true,
      email: 'user@example.com',
      expiresAt: '1700000000000',
      status: 'ACTIVE',
    });
  });

  it('reports canRefresh: false for a pasted access token', async () => {
    mocks.getAiProviderById.mockResolvedValue({
      keyVaults: { oauthAccessToken: 'token', oauthTokenExpiresAt: '1700000000000' },
    });

    expect(await caller().getAuthStatus({ providerId: PROVIDER })).toMatchObject({
      canRefresh: false,
      status: 'ACTIVE',
    });
  });
});

/**
 * Every OAuth procedure shares ONE provider model, so the scope it is built with decides
 * which row connect/status/revoke touches. Built without the workspace id, a member acting
 * inside a workspace would silently read and overwrite their PERSONAL provider credential.
 */
describe('oauthDeviceFlow workspace scoping', () => {
  const scopeOfLastModel = () => {
    const calls = vi.mocked(AiProviderModel).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls.at(-1)!;
  };

  beforeEach(() => {
    mocks.getAiProviderById.mockResolvedValue(undefined);
  });

  it.each([
    [
      'getAuthStatus',
      (ctx: Record<string, unknown>) => caller(ctx).getAuthStatus({ providerId: PROVIDER }),
    ],
    [
      'revokeAuth',
      (ctx: Record<string, unknown>) => caller(ctx).revokeAuth({ providerId: PROVIDER }),
    ],
    [
      'initiateDeviceCode',
      (ctx: Record<string, unknown>) => caller(ctx).initiateDeviceCode({ providerId: PROVIDER }),
    ],
    [
      'pollAuthStatus',
      async (ctx: Record<string, unknown>) => {
        const { deviceCode } = await caller(ctx).initiateDeviceCode({ providerId: PROVIDER });
        return caller(ctx).pollAuthStatus({ deviceCode, providerId: PROVIDER });
      },
    ],
  ])('%s builds the provider model in the workspace scope', async (_name, invoke) => {
    await invoke({ workspaceId: 'ws-1' });

    expect(scopeOfLastModel()).toEqual([expect.anything(), 'user-1', 'ws-1']);
  });

  it.each([
    ['no workspace on the context', {}],
    ['an explicitly null workspace', { workspaceId: null }],
  ])('stays personal with %s', async (_label, ctx) => {
    await caller(ctx).getAuthStatus({ providerId: PROVIDER });

    expect(scopeOfLastModel()).toEqual([expect.anything(), 'user-1', undefined]);
  });
});

describe('oauthDeviceFlow.revokeAuth', () => {
  it('clears the ChatGPT Web identity leaves too', async () => {
    await caller().revokeAuth({ providerId: PROVIDER });

    expect(mocks.updateConfig.mock.calls[0][1].keyVaults).toMatchObject({
      oauthAccessToken: undefined,
      oauthAccountEmail: undefined,
      oauthAccountId: undefined,
      oauthDeviceId: undefined,
      oauthRefreshToken: undefined,
      oauthTokenExpiresAt: undefined,
    });
  });
});
