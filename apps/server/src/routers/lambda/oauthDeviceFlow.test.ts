// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiProviderModel } from '@/database/models/aiProvider';
import { ChatGPTWebOAuthService } from '@/server/enterprise/services/chatgptWeb/oauthService';

const mocks = vi.hoisted(() => ({
  encrypt: vi.fn(async (value: string) => value),
  getAiProviderById: vi.fn(),
  getOAuthService: vi.fn(),
  updateConfig: vi.fn(),
  wipeChatGPTWebCookieJar: vi.fn(),
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

vi.mock('@/server/enterprise/services/chatgptWeb/oauthService', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, wipeChatGPTWebCookieJar: mocks.wipeChatGPTWebCookieJar };
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

  /**
   * The authorization page of this provider asks for the platform API audience and lands on
   * platform.openai.com — a different product from the chatgpt.com subscription the runtime
   * talks to, so a grant redeemed there can be stored and still fail every conversation. The
   * card declares `webSessionOnly` and the router refuses the exchange, including for an
   * older client that still offers the button.
   */
  it.each([
    ['a pasted callback URL', 'https://platform.openai.com/auth/callback?code=the-code&state=s'],
    ['a bare authorization code', 'the-code'],
  ])('refuses %s for a web-session-only provider', async (_label, callbackUrl) => {
    const { deviceCode } = await startFlow();

    await expect(
      caller().pollAuthStatus({ callbackUrl, deviceCode, providerId: PROVIDER }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Refused before any exchange: the code is never spent and nothing is stored.
    expect(authFetch).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  /**
   * An empty callback is a malformed submit, not "nothing pasted yet". Accepted by the
   * contract it slipped past the truthiness gates into the pending branch, so the one client
   * this refusal exists for — an older build that still shows the authorization page — was
   * told to keep polling instead of being told to stop.
   */
  it('rejects an empty callback URL instead of reading it as nothing pasted', async () => {
    const { deviceCode } = await startFlow();

    await expect(
      caller().pollAuthStatus({ callbackUrl: '', deviceCode, providerId: PROVIDER }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(authFetch).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
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
      'oauthRenewalKind',
      'oauthTokenExpiresAt',
    ]);
    expect(stored.oauthRefreshToken).toBeUndefined();
    // The label moves as a unit with the credential it describes.
    expect(stored.oauthRenewalKind).toBeUndefined();
    expect(stored.oauthAccountEmail).toBeUndefined();
    expect(stored.oauthAccountId).toBeUndefined();
  });

  it('stores a pasted web session as the renewal credential, labelled as such', async () => {
    const { deviceCode } = await startFlow();
    // next-auth compact JWE: `dir` header, empty encrypted-key segment.
    const sessionJwe = [
      Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url'),
      '',
      'aXY',
      'Y3Q',
      'dGFn',
    ].join('.');
    transportFetch.mockImplementation(async (url: string) =>
      String(url).endsWith('/api/auth/session')
        ? new Response(
            JSON.stringify({
              accessToken: jwt({ exp: futureExp }),
              user: { email: 'me@example.com' },
            }),
            {
              headers: new Headers({
                'content-type': 'application/json',
                'set-cookie': '__Secure-next-auth.session-token=rotated-jwe; Path=/',
              }),
              status: 200,
            },
          )
        : jsonResponse({ accounts: { default: { account: { id: 'acct-1' } } } }),
    );

    const result = await caller().pollAuthStatus({
      deviceCode,
      providerId: PROVIDER,
      sessionToken: sessionJwe,
    });

    expect(result).toEqual({ status: 'success' });
    const stored = mocks.updateConfig.mock.calls[0][1].keyVaults;
    // The ROTATED cookie, in the same leaf an OAuth refresh token would occupy.
    expect(stored.oauthRefreshToken).toBe('rotated-jwe');
    expect(stored.oauthRenewalKind).toBe('web_session');
    expect(stored.oauthAccountEmail).toBe('me@example.com');
    expect(stored.oauthDeviceId).toBe(JSON.parse(deviceCode).deviceId);
    // No OAuth token endpoint is involved on this path.
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('reports a dead web session with a stable code and stores nothing', async () => {
    const { deviceCode } = await startFlow();
    transportFetch.mockResolvedValue(jsonResponse({ WARNING_BANNER: 'do not paste' }));

    const result = await caller().pollAuthStatus({
      deviceCode,
      providerId: PROVIDER,
      sessionToken: 'not-a-live-session',
    });

    expect(result).toEqual({ error: 'session_invalid', status: 'error' });
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  /**
   * The pasted session is interpolated into a `Cookie:` header on the request that mints the
   * access token, so a value carrying cookie/header delimiters is refused by the INPUT schema
   * — before the provider service, and before any network call.
   */
  it.each([
    ['a cookie separator', 'jwe; oai-did=attacker'],
    ['an assignment', 'jwe=attacker'],
    ['a CRLF header break', 'jwe\r\nX-Injected: 1'],
    ['a control character', 'jwe\u0001attacker'],
  ])('rejects %s in a pasted web session', async (_label, pasted) => {
    const { deviceCode } = await startFlow();
    transportFetch.mockReset();

    await expect(
      caller().pollAuthStatus({ deviceCode, providerId: PROVIDER, sessionToken: pasted }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(transportFetch).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
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
      // Nothing renews it, so there is no renewal path to name.
      renewalKind: null,
      status: 'ACTIVE',
    });
  });

  it('names the renewal path from the stored label', async () => {
    mocks.getAiProviderById.mockResolvedValue({
      keyVaults: {
        oauthAccessToken: 'token',
        oauthRefreshToken: 'session-jwe',
        oauthRenewalKind: 'web_session',
      },
    });

    expect(await caller().getAuthStatus({ providerId: PROVIDER })).toMatchObject({
      canRefresh: true,
      renewalKind: 'web_session',
    });
  });

  it('falls back to the credential shape for connections stored before the label', async () => {
    const sessionJwe = [
      Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url'),
      '',
      'aXY',
      'Y3Q',
      'dGFn',
    ].join('.');
    mocks.getAiProviderById.mockResolvedValue({
      keyVaults: { oauthAccessToken: 'token', oauthRefreshToken: sessionJwe },
    });

    expect(await caller().getAuthStatus({ providerId: PROVIDER })).toMatchObject({
      renewalKind: 'web_session',
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

  it('wipes the cookie jar for the vault device id before clearing', async () => {
    mocks.getAiProviderById.mockResolvedValue({
      keyVaults: { oauthDeviceId: 'old-device-id' },
    });

    await caller().revokeAuth({ providerId: PROVIDER });

    expect(mocks.wipeChatGPTWebCookieJar).toHaveBeenCalledWith('old-device-id');
    expect(mocks.updateConfig).toHaveBeenCalled();
  });

  it('still revokes when the jar wipe throws', async () => {
    mocks.getAiProviderById.mockResolvedValue({
      keyVaults: { oauthDeviceId: 'old-device-id' },
    });
    mocks.wipeChatGPTWebCookieJar.mockImplementation(() => {
      throw new Error('fs');
    });

    await expect(caller().revokeAuth({ providerId: PROVIDER })).resolves.toEqual({ success: true });
    expect(mocks.updateConfig).toHaveBeenCalled();
  });

  it('does not wipe a jar for a non-chatgptweb provider', async () => {
    mocks.getAiProviderById.mockResolvedValue({
      keyVaults: { oauthDeviceId: 'old-device-id' },
    });

    await caller().revokeAuth({ providerId: 'githubcopilot' });

    expect(mocks.wipeChatGPTWebCookieJar).not.toHaveBeenCalled();
  });
});
