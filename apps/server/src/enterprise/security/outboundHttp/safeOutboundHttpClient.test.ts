// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import {
  isMetadataHostname,
  isMetadataIp,
  isPrivateIp,
  SafeOutboundHttpClient,
  SafeOutboundHttpError,
  stripCredentialHeaders,
} from './index';
import type { DnsResolver, PinnedTransport, PinnedTransportResponse } from './types';

const okResponse = (overrides: Partial<PinnedTransportResponse> = {}): PinnedTransportResponse => ({
  body: Buffer.from('{"ok":true}'),
  headers: { 'content-type': 'application/json' },
  status: 200,
  statusText: 'OK',
  ...overrides,
});

const resolveTo =
  (entries: { address: string; family?: 4 | 6 }[]): DnsResolver =>
  async () =>
    entries.map((e) => ({ address: e.address, family: e.family ?? 4 }));

describe('policy helpers', () => {
  it('classifies private and loopback addresses', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.5.1')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('identifies cloud metadata IPs and hostnames', () => {
    expect(isMetadataIp('169.254.169.254')).toBe(true);
    expect(isMetadataIp('169.254.170.2')).toBe(true);
    expect(isMetadataIp('fd00:ec2::254')).toBe(true);
    expect(isMetadataIp('10.0.0.1')).toBe(false);
    expect(isMetadataHostname('metadata.google.internal')).toBe(true);
    expect(isMetadataHostname('METADATA.GOOGLE.INTERNAL')).toBe(true);
    expect(isMetadataHostname('api.example.com')).toBe(false);
  });

  it('treats IPv4-mapped IPv6 encodings of IMDS as metadata', () => {
    expect(isMetadataIp('::ffff:169.254.169.254')).toBe(true);
    expect(isMetadataIp('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isMetadataIp('0:0:0:0:0:ffff:169.254.170.2')).toBe(true);
    expect(isMetadataIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('decodes RFC 6052 NAT64/SIIT layouts before metadata classification', () => {
    expect(isMetadataIp('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(isMetadataIp('64:ff9b:1:a9fe:a9:fe00::')).toBe(true);
    expect(isMetadataIp('64:ff9b::808:808')).toBe(false);
  });
});

describe('SafeOutboundHttpClient', () => {
  it('allows private/localhost by default (G-07) and pins DNS', async () => {
    const transport = vi.fn<PinnedTransport>(async (req) => {
      expect(req.pinnedAddress).toBe('127.0.0.1');
      expect(req.url.hostname).toBe('localhost');
      return okResponse({ body: Buffer.from('local-ok') });
    });

    const client = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '127.0.0.1' }]),
      transport,
    });

    const res = await client.fetch('http://localhost:3000/health');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('local-ok');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('allows public IPs when resolved', async () => {
    const transport = vi.fn<PinnedTransport>(async () => okResponse());
    const client = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '93.184.216.34' }]),
      transport,
    });
    const res = await client.fetch('https://example.com/');
    expect(res.ok).toBe(true);
  });

  it('permanently blocks metadata IPv4 literal', async () => {
    const client = new SafeOutboundHttpClient({
      transport: vi.fn(),
    });
    await expect(client.fetch('http://169.254.169.254/latest/meta-data')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
      name: 'SafeOutboundHttpError',
    });
  });

  it('permanently blocks metadata IPv6 literal', async () => {
    const client = new SafeOutboundHttpClient({ transport: vi.fn() });
    await expect(client.fetch('http://[fd00:ec2::254]/latest/meta-data')).rejects.toBeInstanceOf(
      SafeOutboundHttpError,
    );
  });

  it('permanently blocks IPv4-mapped IPv6 metadata literals', async () => {
    const transport = vi.fn();
    const client = new SafeOutboundHttpClient({ transport });
    await expect(
      client.fetch('http://[::ffff:169.254.169.254]/latest/meta-data'),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED });
    await expect(client.fetch('http://[::ffff:a9fe:a9fe]/')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks DNS that returns IPv4-mapped metadata (rebinding)', async () => {
    const transport = vi.fn();
    const client = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '::ffff:169.254.169.254', family: 6 }]),
      transport,
    });
    await expect(client.fetch('https://evil.example/imds')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks NAT64 metadata in literal, DNS, and redirect hops', async () => {
    const nat64Metadata = '64:ff9b::a9fe:a9fe';
    const transport = vi.fn<PinnedTransport>(async () =>
      okResponse({
        headers: { location: `http://[${nat64Metadata}]/latest/meta-data` },
        status: 302,
        statusText: 'Found',
      }),
    );
    const client = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '93.184.216.34' }]),
      transport,
    });
    await expect(client.fetch(`http://[${nat64Metadata}]/`)).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });

    const dnsClient = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: nat64Metadata, family: 6 }]),
      transport,
    });
    await expect(dnsClient.fetch('https://evil.example/imds')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
    await expect(client.fetch('https://safe.example/start')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
  });

  it('permanently blocks metadata.google.internal hostname', async () => {
    const client = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '169.254.169.254' }]),
      transport: vi.fn(),
    });
    await expect(
      client.fetch('http://metadata.google.internal/computeMetadata/v1/'),
    ).rejects.toThrow(/metadata/i);
  });

  it('blocks when DNS resolves to metadata IP (rebinding defense)', async () => {
    const transport = vi.fn();
    const client = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '169.254.169.254' }]),
      transport,
    });
    await expect(client.fetch('https://evil.example/imds')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks redirect to metadata after an allowed first hop', async () => {
    const transport = vi.fn<PinnedTransport>(async (req) => {
      if (req.url.hostname === 'safe.example') {
        return okResponse({
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
          status: 302,
          statusText: 'Found',
        });
      }
      return okResponse();
    });

    const client = new SafeOutboundHttpClient({
      resolve: async (hostname) => {
        if (hostname === 'safe.example') return [{ address: '93.184.216.34', family: 4 }];
        if (hostname === '169.254.169.254') return [{ address: '169.254.169.254', family: 4 }];
        return [{ address: '1.2.3.4', family: 4 }];
      },
      transport,
    });

    await expect(client.fetch('https://safe.example/start')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
  });

  it('re-resolves and re-checks each redirect hop', async () => {
    const resolve = vi.fn<DnsResolver>(async (hostname) => {
      if (hostname === 'a.example') return [{ address: '1.1.1.1', family: 4 }];
      if (hostname === 'b.example') return [{ address: '2.2.2.2', family: 4 }];
      return [{ address: '3.3.3.3', family: 4 }];
    });

    const transport = vi.fn<PinnedTransport>(async (req) => {
      if (req.url.hostname === 'a.example') {
        expect(req.pinnedAddress).toBe('1.1.1.1');
        return okResponse({
          headers: { location: 'https://b.example/next' },
          status: 302,
          statusText: 'Found',
        });
      }
      expect(req.url.hostname).toBe('b.example');
      expect(req.pinnedAddress).toBe('2.2.2.2');
      return okResponse({ body: Buffer.from('final') });
    });

    const client = new SafeOutboundHttpClient({ resolve, transport });
    const res = await client.fetch('https://a.example/');
    expect(await res.text()).toBe('final');
    expect(resolve).toHaveBeenCalledWith('a.example');
    expect(resolve).toHaveBeenCalledWith('b.example');
  });

  it('enforces max redirects', async () => {
    const transport = vi.fn<PinnedTransport>(async () =>
      okResponse({
        headers: { location: 'https://loop.example/r' },
        status: 302,
        statusText: 'Found',
      }),
    );
    const client = new SafeOutboundHttpClient({
      maxRedirects: 2,
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport,
    });
    await expect(client.fetch('https://loop.example/r')).rejects.toThrow(/redirect/i);
  });

  describe('allowlist mode', () => {
    it('blocks hosts not on the allowlist', async () => {
      const client = new SafeOutboundHttpClient({
        allowlist: ['allowed.example'],
        mode: 'allowlist',
        resolve: resolveTo([{ address: '1.2.3.4' }]),
        transport: vi.fn(),
      });
      await expect(client.fetch('https://other.example/')).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
      });
    });

    it('allows allowlisted host after DNS pin', async () => {
      const transport = vi.fn<PinnedTransport>(async (req) => {
        expect(req.pinnedAddress).toBe('9.9.9.9');
        return okResponse({ body: Buffer.from('allowlisted') });
      });
      const client = new SafeOutboundHttpClient({
        allowlist: ['allowed.example'],
        mode: 'allowlist',
        resolve: resolveTo([{ address: '9.9.9.9' }]),
        transport,
      });
      const res = await client.fetch('https://allowed.example/api');
      expect(await res.text()).toBe('allowlisted');
    });

    it('still blocks metadata even if listed in allowlist', async () => {
      const client = new SafeOutboundHttpClient({
        allowlist: ['169.254.169.254', 'metadata.google.internal'],
        mode: 'allowlist',
        transport: vi.fn(),
      });
      await expect(client.fetch('http://169.254.169.254/')).rejects.toThrow(/metadata/i);
      await expect(client.fetch('http://metadata.google.internal/')).rejects.toThrow(/metadata/i);
    });

    it('blocks allowlisted hostname that resolves to metadata', async () => {
      const client = new SafeOutboundHttpClient({
        allowlist: ['sneaky.example'],
        mode: 'allowlist',
        resolve: resolveTo([{ address: '169.254.169.254' }]),
        transport: vi.fn(),
      });
      await expect(client.fetch('https://sneaky.example/')).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
      });
    });
  });

  it('rejects non-http(s) protocols', async () => {
    const client = new SafeOutboundHttpClient({ transport: vi.fn() });
    await expect(client.fetch('file:///etc/passwd')).rejects.toThrow(/protocol/i);
    await expect(client.fetch('gopher://example.com/')).rejects.toThrow(/protocol/i);
  });

  it.each(['key', 'api_key', 'access-token', 'signature', 'X-Amz-Signature'])(
    'rejects sensitive query key %s again at the final outbound boundary',
    async (key) => {
      const transport = vi.fn();
      const client = new SafeOutboundHttpClient({ transport });
      await expect(
        client.fetch(`https://example.test/mcp?${key}=fake-secret`),
      ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('re-reads a versioned policy after DNS and fails closed when it tightens', async () => {
    let reads = 0;
    const transport = vi.fn();
    const client = new SafeOutboundHttpClient({
      policyProvider: () => {
        reads += 1;
        return reads === 1
          ? { policy: { allowlist: [], mode: 'allow-private' }, version: 1 }
          : { policy: { allowlist: ['allowed.example'], mode: 'allowlist' }, version: 2 };
      },
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport,
    });

    await expect(client.fetch('https://blocked.example/mcp')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses one absolute deadline across DNS, redirects, transport, and body', async () => {
    const transport = vi.fn<PinnedTransport>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 12));
      return okResponse({
        headers: { location: 'https://b.example/next' },
        status: 302,
        statusText: 'Found',
      });
    });
    const client = new SafeOutboundHttpClient({
      resolve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 12));
        return [{ address: '1.1.1.1', family: 4 }];
      },
      timeoutMs: 30,
      transport,
    });

    await expect(client.fetch('https://a.example/start')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
    expect(transport.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('passes maxResponseBytes into transport (hard cap, not post-trim)', async () => {
    const transport = vi.fn<PinnedTransport>(async (req) => {
      expect(req.maxResponseBytes).toBe(10);
      // Transport is responsible for the cap; client does not re-buffer/trim.
      return okResponse({ body: Buffer.alloc(10, 0x61), truncated: true });
    });
    const client = new SafeOutboundHttpClient({
      maxResponseBytes: 10,
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport,
    });
    const res = await client.fetch('https://example.com/big');
    expect(res.body.length).toBe(10);
    expect(res.truncated).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects cross-origin redirects for secret-bearing requests', async () => {
    const transport = vi.fn<PinnedTransport>(async (req) => {
      if (req.url.hostname === 'a.example') {
        expect(req.headers.Authorization).toBe('Bearer fake-token-not-real');
        expect(req.headers.Cookie).toBe('sid=fake');
        return okResponse({
          headers: { location: 'https://b.example/next' },
          status: 302,
          statusText: 'Found',
        });
      }
      throw new Error('cross-origin transport must not execute');
    });

    const client = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport,
    });
    await expect(
      client.fetch('https://a.example/start', {
        headers: {
          'Authorization': 'Bearer fake-token-not-real',
          'Cookie': 'sid=fake',
          'X-Custom': 'keep',
        },
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('strips built-in and custom credential headers while retaining benign headers', () => {
    const headers = {
      'Authorization': 'Bearer fake',
      'Cookie': 'sid=fake',
      'X-Api-Key': 'fake-key',
      'X-Custom': 'keep',
      'X-Service-Secret': 'fake-secret',
    };
    stripCredentialHeaders(headers);
    expect(headers).toEqual({ 'X-Custom': 'keep' });
  });

  it.each([307, 308])('rejects secret POST body on cross-origin %s redirect', async (status) => {
    const transport = vi.fn<PinnedTransport>(async () =>
      okResponse({
        headers: { location: 'https://b.example/token' },
        status,
        statusText: 'Redirect',
      }),
    );
    const client = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport,
    });
    await expect(
      client.fetch('https://a.example/token', {
        body: 'client_secret=fake-secret',
        method: 'POST',
        secretBearing: true,
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('keeps credentials on same-origin redirect', async () => {
    const transport = vi.fn<PinnedTransport>(async (req) => {
      if (req.url.pathname === '/start') {
        return okResponse({
          headers: { location: 'https://a.example/next' },
          status: 302,
          statusText: 'Found',
        });
      }
      expect(req.headers.Authorization).toBe('Bearer same-origin');
      return okResponse({ body: Buffer.from('same') });
    });

    const client = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport,
    });
    const res = await client.fetch('https://a.example/start', {
      headers: { Authorization: 'Bearer same-origin' },
    });
    expect(await res.text()).toBe('same');
  });

  it('assertAllowed validates without transport', async () => {
    const transport = vi.fn();
    const client = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '10.0.0.5' }]),
      transport,
    });
    await expect(client.assertAllowed('http://internal.svc/health')).resolves.toBeUndefined();
    expect(transport).not.toHaveBeenCalled();

    await expect(client.assertAllowed('http://169.254.169.254/')).rejects.toBeInstanceOf(
      SafeOutboundHttpError,
    );
  });
});

describe('defaultPinnedTransport body / deadline bounds (MAJOR-1)', () => {
  it('stops reading when response exceeds maxResponseBytes and does not buffer unbounded', async () => {
    const http = await import('node:http');
    const { defaultPinnedTransport } = await import('./transport');

    let clientAborted = false;
    const chunk = Buffer.alloc(32 * 1024, 0x62); // 32 KiB
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      let writes = 0;
      const pump = () => {
        // Attempt to stream far more than the client cap (would OOM if buffered unboundedly).
        while (writes < 400) {
          writes += 1;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      req.on('aborted', () => {
        clientAborted = true;
      });
      res.on('close', () => {
        if (!res.writableFinished) clientAborted = true;
      });
      pump();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected TCP address');
    const port = addr.port;

    try {
      const maxResponseBytes = 50_000; // ~50 KiB
      const result = await defaultPinnedTransport({
        family: 4,
        headers: {},
        maxResponseBytes,
        method: 'GET',
        pinnedAddress: '127.0.0.1',
        timeoutMs: 5_000,
        url: new URL(`http://127.0.0.1:${port}/flood`),
      });

      expect(result.body.length).toBeLessThanOrEqual(maxResponseBytes);
      expect(result.body.length).toBe(maxResponseBytes);
      expect(result.truncated).toBe(true);
      // Connection should have been torn down (abort/close before full write).
      // Give the event loop a tick for 'close'/'aborted'.
      await new Promise((r) => setTimeout(r, 50));
      expect(clientAborted || result.truncated).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('SafeOutboundHttpClient default transport enforces maxResponseBytes end-to-end', async () => {
    const http = await import('node:http');

    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      // ~200 KiB of body
      res.end(Buffer.alloc(200 * 1024, 0x63));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected TCP address');
    const port = addr.port;

    try {
      const client = new SafeOutboundHttpClient({
        maxResponseBytes: 8_192,
        timeoutMs: 5_000,
      });
      const res = await client.fetch(`http://127.0.0.1:${port}/`);
      expect(res.body.length).toBeLessThanOrEqual(8_192);
      expect(res.truncated).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
