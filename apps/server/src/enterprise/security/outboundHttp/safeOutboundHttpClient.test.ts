// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import {
  isMetadataHostname,
  isMetadataIp,
  isPrivateIp,
  SafeOutboundHttpClient,
  SafeOutboundHttpError,
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

  it('truncates response body to maxResponseBytes', async () => {
    const transport = vi.fn<PinnedTransport>(async () =>
      okResponse({ body: Buffer.alloc(100, 0x61) }),
    );
    const client = new SafeOutboundHttpClient({
      maxResponseBytes: 10,
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport,
    });
    const res = await client.fetch('https://example.com/big');
    expect(res.body.length).toBe(10);
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
