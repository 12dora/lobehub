import { describe, expect, it, vi } from 'vitest';

import type { SafeOutboundResponse } from '../../security/outboundHttp';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { ConnectorOutboundClient } from './connectorOutboundClient';

const response = (overrides: Partial<SafeOutboundResponse> = {}): SafeOutboundResponse => ({
  arrayBuffer: async () => new ArrayBuffer(0),
  body: Buffer.from('{}'),
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => ({ tools: [] }),
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => '{}',
  truncated: false,
  url: 'https://mcp.example.test/v1',
  ...overrides,
});

describe('ConnectorOutboundClient', () => {
  it('routes discovery, tests, and runtime through SafeOutboundHttpClient with bounded options', async () => {
    const safeClient = new SafeOutboundHttpClient();
    const fetchSpy = vi.spyOn(safeClient, 'fetch').mockResolvedValue(response());
    const client = new ConnectorOutboundClient(safeClient);

    for (const operation of ['discover', 'test', 'runtime'] as const) {
      await expect(
        client.requestJson({ operation, url: 'https://mcp.example.test/v1' }),
      ).resolves.toMatchObject({ body: { tools: [] }, status: 200 });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      'https://mcp.example.test/v1',
      expect.objectContaining({
        maxRedirects: 3,
        maxResponseBytes: 1024 * 1024,
        timeoutMs: 10_000,
      }),
    );
  });

  it('encodes OAuth form bodies and marks them secret-bearing at the safe boundary', async () => {
    const safeClient = new SafeOutboundHttpClient();
    const fetchSpy = vi.spyOn(safeClient, 'fetch').mockResolvedValue(response());
    const client = new ConnectorOutboundClient(safeClient);

    await client.requestJson({
      body: { client_id: 'client', client_secret: 'fake-secret', grant_type: 'client_credentials' },
      bodyEncoding: 'form',
      operation: 'oauth_token',
      secretBearing: true,
      url: 'https://identity.example.test/token',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://identity.example.test/token',
      expect.objectContaining({
        body: 'client_id=client&client_secret=fake-secret&grant_type=client_credentials',
        secretBearing: true,
      }),
    );
  });

  it.each([
    ['form', 1024 * 1024 - 'value='.length],
    ['json', 1024 * 1024 - '{"value":""}'.length],
  ] as const)(
    'accepts exact %s body limit and rejects one byte over',
    async (bodyEncoding, size) => {
      const safeClient = new SafeOutboundHttpClient();
      const fetchSpy = vi.spyOn(safeClient, 'fetch').mockResolvedValue(response());
      const client = new ConnectorOutboundClient(safeClient);
      const request = {
        bodyEncoding,
        operation: 'test' as const,
        url: 'https://mcp.example.test/v1',
      };

      await expect(
        client.requestJson({ ...request, body: { value: 'x'.repeat(size) } }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        client.requestJson({ ...request, body: { value: 'x'.repeat(size + 1) } }),
      ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED' });
      expect(fetchSpy).toHaveBeenCalledOnce();
    },
  );

  it('automatically marks OAuth operations secret-bearing and ignores a false caller hint', async () => {
    const safeClient = new SafeOutboundHttpClient();
    const fetchSpy = vi.spyOn(safeClient, 'fetch').mockResolvedValue(response());
    const client = new ConnectorOutboundClient(safeClient);
    await client.requestJson({
      operation: 'oauth_userinfo',
      secretBearing: false,
      url: 'https://identity.example.test/userinfo',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://identity.example.test/userinfo',
      expect.objectContaining({ secretBearing: true }),
    );
  });

  it('rejects non-JSON, truncated, invalid JSON, and unsuccessful responses without returning bodies', async () => {
    const safeClient = new SafeOutboundHttpClient();
    const client = new ConnectorOutboundClient(safeClient);
    const cases = [
      response({ headers: new Headers({ 'content-type': 'text/html' }) }),
      response({ truncated: true }),
      response({
        json: async () => {
          throw new Error('invalid JSON');
        },
      }),
      response({ ok: false, status: 500 }),
    ];

    for (const item of cases) {
      vi.spyOn(safeClient, 'fetch').mockResolvedValueOnce(item);
      await expect(
        client.requestJson({ operation: 'test', url: 'https://mcp.example.test/v1' }),
      ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED' });
    }
  });

  it('allows private endpoints by G-07 default and permanently blocks metadata', async () => {
    const safeClient = new SafeOutboundHttpClient();
    const client = new ConnectorOutboundClient(safeClient);

    await expect(client.assertAllowed('http://127.0.0.1:8080/mcp')).resolves.toBeUndefined();
    await expect(
      client.assertAllowed('http://169.254.169.254/latest/meta-data'),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_SSRF_BLOCKED' });
  });

  it('honors a tightened allowlist immediately without allowing metadata exceptions', async () => {
    const client = new ConnectorOutboundClient(
      new SafeOutboundHttpClient({
        allowlist: ['10.0.0.2', '169.254.169.254'],
        mode: 'allowlist',
      }),
    );

    await expect(client.assertAllowed('http://10.0.0.2:8080/mcp')).resolves.toBeUndefined();
    await expect(client.assertAllowed('http://127.0.0.1:8080/mcp')).rejects.toMatchObject({
      code: 'PLATFORM_CONNECTOR_SSRF_BLOCKED',
    });
    await expect(
      client.assertAllowed('http://169.254.169.254/latest/meta-data'),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_SSRF_BLOCKED' });
  });
});
