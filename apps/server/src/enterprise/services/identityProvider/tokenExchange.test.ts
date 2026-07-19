// @vitest-environment node
import type { PlatformOidcDiscoveryMetadata } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import {
  type PinnedTransport,
  type PinnedTransportResponse,
  SafeOutboundHttpClient,
} from '../../security/outboundHttp';
import { exchangePlatformOidcAuthorizationCode } from './tokenExchange';

const publicAddress = '93.184.216.34';
const redirectUri = 'https://app.example.test/api/auth/oauth2/callback/work';
const metadata = (authMethods = ['client_secret_basic']): PlatformOidcDiscoveryMetadata => ({
  authorizationEndpoint: 'https://login.example.test/authorize',
  codeChallengeMethodsSupported: ['S256'],
  idTokenSigningAlgValuesSupported: ['RS256'],
  issuer: 'https://login.example.test/issuer',
  jwksUri: 'https://login.example.test/jwks',
  responseTypesSupported: ['code'],
  scopesSupported: ['openid'],
  subjectTypesSupported: ['public'],
  tokenEndpoint: 'https://login.example.test/token',
  tokenEndpointAuthMethodsSupported: authMethods,
  userinfoEndpoint: 'https://login.example.test/userinfo',
});

const response = (
  body: unknown,
  overrides: Partial<PinnedTransportResponse> = {},
): PinnedTransportResponse => ({
  body: Buffer.from(JSON.stringify(body)),
  headers: { 'content-type': 'application/json' },
  status: 200,
  statusText: 'OK',
  ...overrides,
});

const setup = (transport: PinnedTransport) =>
  new SafeOutboundHttpClient({
    mode: 'public-only',
    resolve: async () => [{ address: publicAddress, family: 4 }],
    transport,
  });

const exchange = (
  outbound: SafeOutboundHttpClient,
  overrides: Partial<Parameters<typeof exchangePlatformOidcAuthorizationCode>[0]> = {},
) =>
  exchangePlatformOidcAuthorizationCode({
    clientId: 'client:id',
    clientSecret: 's&e:cret',
    code: 'authorization-code',
    expectedRedirectUri: redirectUri,
    metadata: metadata(),
    outbound,
    pkceVerifier: 'pkce-verifier',
    redirectUri,
    ...overrides,
  });

describe('safe platform OIDC token exchange', () => {
  it.each([
    ['client_secret_basic', false],
    ['client_secret_post', true],
  ])(
    'uses the advertised %s method over the pinned outbound client',
    async (method, postsSecret) => {
      const transport = vi.fn<PinnedTransport>(async (request) => {
        expect(request.url.toString()).toBe('https://login.example.test/token');
        expect(request.method).toBe('POST');
        expect(request.headers.Accept).toBe('application/json');
        expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        const body = new URLSearchParams(request.body?.toString());
        expect(body.get('code_verifier')).toBe('pkce-verifier');
        expect(body.get('redirect_uri')).toBe(redirectUri);
        expect(body.get('client_secret') !== null).toBe(postsSecret);
        expect(Boolean(request.headers.Authorization)).toBe(!postsSecret);
        return response({ access_token: 'access-token', id_token: 'id-token' });
      });

      const outbound = setup(transport);
      const fetch = vi.spyOn(outbound, 'fetch');
      await expect(exchange(outbound, { metadata: metadata([method]) })).resolves.toMatchObject({
        access_token: 'access-token',
        id_token: 'id-token',
      });
      expect(transport).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        'https://login.example.test/token',
        expect.objectContaining({
          maxRedirects: 0,
          maxResponseBytes: 64 * 1024,
          secretBearing: true,
          timeoutMs: 5000,
        }),
      );
    },
  );

  it.each([
    ['missing PKCE', { pkceVerifier: undefined }],
    ['redirect substitution', { redirectUri: 'https://attacker.example.test/callback' }],
    ['unsupported auth method', { metadata: metadata(['none']) }],
  ])('fails closed before transport for %s', async (_label, overrides) => {
    const transport = vi.fn<PinnedTransport>();
    await expect(exchange(setup(transport), overrides)).rejects.toThrow(
      'PLATFORM_OIDC_TOKEN_RESPONSE_INVALID',
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['non-JSON', response({}, { headers: { 'content-type': 'text/html' } })],
    ['oversized', response({}, { truncated: true })],
    ['HTTP error', response({}, { status: 400 })],
    [
      'redirect',
      response({}, { headers: { location: 'https://login.example.test/other' }, status: 302 }),
    ],
    ['missing ID token', response({ access_token: 'access-token' })],
  ])('rejects a %s token response', async (_label, tokenResponse) => {
    await expect(exchange(setup(async () => tokenResponse))).rejects.toThrow(
      'PLATFORM_OIDC_TOKEN_RESPONSE_INVALID',
    );
  });

  it('enforces the absolute token endpoint deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = exchange(setup(async () => new Promise(() => {})));
      const expectation = expect(pending).rejects.toThrow('PLATFORM_OIDC_TOKEN_RESPONSE_INVALID');
      await vi.advanceTimersByTimeAsync(5001);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
