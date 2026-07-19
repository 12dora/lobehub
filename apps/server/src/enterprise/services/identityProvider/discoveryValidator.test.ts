// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type {
  DnsResolver,
  PinnedTransport,
  PinnedTransportResponse,
} from '../../security/outboundHttp';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import {
  IdentityProviderDiscoveryValidator,
  IdentityProviderValidationError,
} from './discoveryValidator';

const publicAddress = '93.184.216.34';

const metadata = (overrides: Record<string, unknown> = {}) => ({
  authorization_endpoint: 'https://login.example.com/application/o/authorize/',
  code_challenge_methods_supported: ['S256'],
  id_token_signing_alg_values_supported: ['RS256'],
  issuer: 'https://login.example.com/application/o/work/',
  jwks_uri: 'https://login.example.com/application/o/work/jwks/',
  response_types_supported: ['code'],
  scopes_supported: ['openid', 'profile', 'email', 'dingtalk'],
  subject_types_supported: ['public'],
  token_endpoint: 'https://login.example.com/application/o/token/',
  token_endpoint_auth_methods_supported: ['client_secret_basic'],
  userinfo_endpoint: 'https://login.example.com/application/o/userinfo/',
  ...overrides,
});

const response = (
  body: unknown,
  overrides: Partial<PinnedTransportResponse> = {},
): PinnedTransportResponse => ({
  body: Buffer.from(JSON.stringify(body)),
  headers: { 'content-type': 'application/json; charset=utf-8' },
  status: 200,
  statusText: 'OK',
  ...overrides,
});

const publicResolver: DnsResolver = async () => [{ address: publicAddress, family: 4 }];

const validatorFor = (options: { resolve?: DnsResolver; transport?: PinnedTransport } = {}) =>
  new IdentityProviderDiscoveryValidator(
    new SafeOutboundHttpClient({
      mode: 'public-only',
      resolve: options.resolve ?? publicResolver,
      transport: options.transport ?? (async () => response(metadata())),
    }),
  );

describe('IdentityProviderDiscoveryValidator', () => {
  it('accepts Authentik-compatible metadata and returns a bounded structured contract', async () => {
    const result = await validatorFor().discover('https://login.example.com/application/o/work/');
    expect(result).toMatchObject({
      codeChallengeMethodsSupported: ['S256'],
      issuer: 'https://login.example.com/application/o/work/',
      scopesSupported: ['openid', 'profile', 'email', 'dingtalk'],
      tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
    });
    expect(result).not.toHaveProperty('unknown_server_field');
  });

  it.each([
    'http://login.example.com/application/o/work/',
    'https://login.example.com:8443/application/o/work/',
    'https://user@login.example.com/application/o/work/',
    'https://login.example.com/application/o/work/?tenant=one',
  ])('rejects a non-canonical public HTTPS issuer: %s', async (issuer) => {
    await expect(validatorFor().discover(issuer)).rejects.toMatchObject({
      code: 'OIDC_ISSUER_INVALID',
    });
  });

  it('blocks DNS rebinding to private and metadata addresses before transport', async () => {
    const transport = vi.fn<PinnedTransport>();
    for (const address of ['127.0.0.1', '10.0.0.8', '100.64.0.1', '169.254.169.254', '192.0.2.1']) {
      const validator = validatorFor({
        resolve: async () => [{ address, family: 4 }],
        transport,
      });
      await expect(
        validator.discover('https://login.example.com/application/o/work/'),
      ).rejects.toMatchObject({ code: 'OIDC_NETWORK_BLOCKED' });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects discovery redirects to another origin', async () => {
    const transport = vi.fn<PinnedTransport>(async () =>
      response(
        {},
        { headers: { location: 'https://redirect.example.net/discovery' }, status: 302 },
      ),
    );
    await expect(
      validatorFor({ transport }).discover('https://login.example.com/application/o/work/'),
    ).rejects.toMatchObject({ code: 'OIDC_NETWORK_BLOCKED' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects issuer mismatch, insecure endpoints, unsafe algorithms, and missing PKCE', async () => {
    const cases = [
      metadata({ issuer: 'https://other.example.com/application/o/work/' }),
      metadata({ token_endpoint: 'http://login.example.com/token' }),
      metadata({ id_token_signing_alg_values_supported: ['none'] }),
      metadata({ code_challenge_methods_supported: ['plain'] }),
    ];
    for (const body of cases) {
      const validator = validatorFor({ transport: async () => response(body) });
      await expect(
        validator.discover('https://login.example.com/application/o/work/'),
      ).rejects.toBeInstanceOf(IdentityProviderValidationError);
    }
  });

  it('preflights every discovered endpoint and blocks a private endpoint host', async () => {
    const resolve: DnsResolver = async (hostname) => [
      { address: hostname === 'internal.example.com' ? '192.168.1.10' : publicAddress, family: 4 },
    ];
    const transport: PinnedTransport = async () =>
      response(metadata({ jwks_uri: 'https://internal.example.com/jwks' }));
    await expect(
      validatorFor({ resolve, transport }).discover(
        'https://login.example.com/application/o/work/',
      ),
    ).rejects.toMatchObject({ code: 'OIDC_NETWORK_BLOCKED' });
  });

  it('fails closed for non-JSON, oversized, and malformed discovery responses', async () => {
    const cases = [
      response(metadata(), { headers: { 'content-type': 'text/html' } }),
      response(metadata(), { truncated: true }),
      response({ issuer: 'https://login.example.com/application/o/work/' }),
    ];
    for (const item of cases) {
      await expect(
        validatorFor({ transport: async () => item }).discover(
          'https://login.example.com/application/o/work/',
        ),
      ).rejects.toMatchObject({ code: 'OIDC_DISCOVERY_INVALID' });
    }
  });

  it('enforces the absolute discovery deadline', async () => {
    vi.useFakeTimers();
    try {
      const transport: PinnedTransport = async () => new Promise(() => {});
      const pending = validatorFor({ transport }).discover(
        'https://login.example.com/application/o/work/',
      );
      const expectation = expect(pending).rejects.toMatchObject({ code: 'OIDC_NETWORK_BLOCKED' });
      await vi.advanceTimersByTimeAsync(5001);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
