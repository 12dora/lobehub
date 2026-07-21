// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { SafeOutboundHttpClient, SafeOutboundHttpError } from '../security/outboundHttp';
import type { PinnedTransportResponse } from '../security/outboundHttp/types';
import { EasyauthClientError, EasyauthPermissionClient } from './easyauthClient';

const config = {
  appKey: 'aihub',
  appToken: 'eat_fake_test_token_not_real',
  baseUrl: 'https://easyauth.example',
  descriptorToken: null,
  manifestSchemaVersion: 1,
  portalUrl: 'https://easyauth.example',
  timeoutMs: 1000,
};

const okSnapshot = {
  app_key: 'aihub',
  catalog_version: 1,
  grant_version: 1,
  grants: [{ permission: 'aihub.access' }],
  groups: [],
  snapshot_version: '1',
  user_id: 'ext-1',
};

const response = (overrides: Partial<PinnedTransportResponse> = {}): PinnedTransportResponse => ({
  body: Buffer.from(JSON.stringify(okSnapshot)),
  headers: { 'content-type': 'application/json' },
  status: 200,
  statusText: 'OK',
  ...overrides,
});

const clientWithTransport = (transport: ReturnType<typeof vi.fn>) =>
  new EasyauthPermissionClient({
    config,
    outbound: new SafeOutboundHttpClient({
      resolve: async () => [{ address: '203.0.113.10', family: 4 }],
      transport,
    }),
  });

describe('EasyauthPermissionClient outbound boundary', () => {
  it('sends the static app token as Authorization and never puts it in the URL', async () => {
    const transport = vi.fn(async (req) => {
      expect(req.url.toString()).not.toContain('eat_');
      expect(req.headers.Authorization).toBe(`Bearer ${config.appToken}`);
      return response();
    });
    const client = clientWithTransport(transport);
    await expect(client.fetchPermissionSnapshot('ext-1')).resolves.toMatchObject({
      app_key: 'aihub',
      user_id: 'ext-1',
    });
    expect(transport.mock.calls[0]?.[0]?.url.toString()).not.toContain('eat_');
    expect(transport.mock.calls[0]?.[0]?.url.toString()).not.toContain(config.appToken);
  });

  it('denies metadata and private network targets', async () => {
    const client = new EasyauthPermissionClient({
      config: { ...config, baseUrl: 'http://169.254.169.254' },
      outbound: new SafeOutboundHttpClient({
        resolve: async () => [{ address: '169.254.169.254', family: 4 }],
        transport: vi.fn(),
      }),
    });
    await expect(client.fetchPermissionSnapshot('ext-1')).rejects.toBeInstanceOf(
      EasyauthClientError,
    );
    await expect(client.fetchPermissionSnapshot('ext-1')).rejects.toMatchObject({
      kind: 'integration',
      message: expect.stringContaining('network policy'),
    });
  });

  it('fails closed on cross-origin redirects for secret-bearing app-token requests', async () => {
    const transport = vi.fn().mockResolvedValueOnce(
      response({
        body: Buffer.alloc(0),
        headers: { location: 'https://other.example/permissions' },
        status: 302,
        statusText: 'Found',
      }),
    );

    const client = clientWithTransport(transport);
    await expect(client.fetchPermissionSnapshot('ext-1')).rejects.toMatchObject({
      kind: 'integration',
      message: expect.stringContaining('network policy'),
    });
    // Secret-bearing policy refuses to follow the redirect; the token never leaves the first hop.
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]?.url.toString()).toContain('easyauth.example');
  });

  it('maps oversized and malformed responses without leaking the token', async () => {
    const oversized = clientWithTransport(
      vi.fn(async () => response({ body: Buffer.alloc(300 * 1024, 1), truncated: true })),
    );
    await expect(oversized.fetchPermissionSnapshot('ext-1')).rejects.toMatchObject({
      kind: 'malformed',
    });

    const malformed = clientWithTransport(
      vi.fn(async () =>
        response({ body: Buffer.from('not-json'), headers: { 'content-type': 'text/plain' } }),
      ),
    );
    await expect(malformed.fetchPermissionSnapshot('ext-1')).rejects.toMatchObject({
      kind: 'malformed',
    });

    try {
      await oversized.fetchPermissionSnapshot('ext-1');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(config.appToken);
      expect(String(error)).not.toContain(config.appToken);
    }
  });

  it('maps timeout and SafeOutbound errors to sanitized integration failures', async () => {
    const client = new EasyauthPermissionClient({
      config,
      outbound: {
        fetch: async () => {
          throw new SafeOutboundHttpError('timeout');
        },
      } as never,
    });
    await expect(client.fetchPermissionSnapshot('ext-1')).rejects.toBeInstanceOf(
      EasyauthClientError,
    );
    await expect(client.fetchPermissionSnapshot('ext-1')).rejects.toMatchObject({
      message: 'EasyAuth permission query failed: network policy',
    });
  });

  it('preserves 401 and 403 credential semantics', async () => {
    const unauthorized = clientWithTransport(
      vi.fn(async () =>
        response({ body: Buffer.from('{}'), status: 401, statusText: 'Unauthorized' }),
      ),
    );
    await expect(unauthorized.fetchPermissionSnapshot('ext-1')).rejects.toMatchObject({
      kind: 'unauthorized',
    });

    const forbidden = clientWithTransport(
      vi.fn(async () =>
        response({ body: Buffer.from('{}'), status: 403, statusText: 'Forbidden' }),
      ),
    );
    await expect(forbidden.fetchPermissionSnapshot('ext-1')).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });
});
