// @vitest-environment node
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { SafeOutboundHttpClient, SafeOutboundHttpError, stripCredentialHeaders } from './index';
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

describe('SafeOutboundHttpClient', () => {
  it('returns AbortError when aborted during DNS resolution (before DNS resolves)', async () => {
    const controller = new AbortController();
    let releaseDns!: () => void;
    const dnsGate = new Promise<void>((resolve) => {
      releaseDns = resolve;
    });
    let dnsResolved = false;
    const client = new SafeOutboundHttpClient({
      mode: 'allow-private',
      resolve: async () => {
        await dnsGate;
        dnsResolved = true;
        return [{ address: '1.1.1.1', family: 4 }];
      },
      timeoutMs: 5_000,
    });
    const pending = client.streamFetch('https://slow-dns.example/events', {
      signal: controller.signal,
    });
    // Abort while DNS is still gated — must reject before the resolver completes.
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(dnsResolved).toBe(false);
    releaseDns();
  });

  it('streams SSE incrementally and propagates AbortSignal to the pinned socket', async () => {
    let closed = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: first\n\n');
      response.on('close', () => {
        closed = true;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const controller = new AbortController();
    const client = new SafeOutboundHttpClient({ mode: 'allow-private', timeoutMs: 5000 });
    try {
      const response = await client.streamFetch(`http://127.0.0.1:${address.port}/events`, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('data: first');
      expect(first.done).toBe(false);
      controller.abort();
      await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(closed).toBe(true));
    } finally {
      server.close();
    }
  });

  it('enforces streaming byte and absolute timeout limits while reading', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (request.url === '/large') response.end('data: '.padEnd(128, 'x'));
      else response.flushHeaders();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const client = new SafeOutboundHttpClient({ mode: 'allow-private' });
    try {
      const large = await client.streamFetch(`http://127.0.0.1:${address.port}/large`, {
        maxResponseBytes: 16,
      });
      await expect(large.text()).rejects.toThrow('exceeded byte limit');

      const stalled = await client.streamFetch(`http://127.0.0.1:${address.port}/stalled`, {
        timeoutMs: 50,
      });
      await expect(stalled.text()).rejects.toThrow('deadline exceeded');
    } finally {
      server.close();
    }
  });

  it('tears down continuous redirect and accepted-response sockets on body cancel', async () => {
    let redirectClosed = false;
    let acceptedClosed = false;
    const server = createServer((request, response) => {
      const interval = setInterval(() => response.write('still-streaming'), 5);
      response.on('close', () => {
        clearInterval(interval);
        if (request.url === '/redirect') redirectClosed = true;
        if (request.url === '/accepted') acceptedClosed = true;
      });
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/accepted' });
        response.write('redirect-body');
      } else {
        response.writeHead(202, { 'Content-Type': 'text/event-stream' });
        response.write('accepted-body');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const client = new SafeOutboundHttpClient({ mode: 'allow-private', timeoutMs: 5000 });
    try {
      const response = await client.streamFetch(`http://127.0.0.1:${address.port}/redirect`);
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(redirectClosed).toBe(true));
      await response.body?.cancel();
      await vi.waitFor(() => expect(acceptedClosed).toBe(true));
    } finally {
      server.close();
    }
  });

  it.each([204, 205, 304])(
    'constructs bodyless %s responses and terminates a peer that advertises a body',
    async (status) => {
      let closed = false;
      const server = createNetServer((socket) => {
        socket.once('data', () => {
          socket.write(
            `HTTP/1.1 ${status} Test\r\nContent-Length: 999999\r\nContent-Type: text/event-stream\r\nX-Untrusted-Header: preserved\r\nConnection: keep-alive\r\n\r\nmalicious-body`,
          );
          const interval = setInterval(() => socket.write('still-malicious'), 5);
          socket.on('close', () => clearInterval(interval));
        });
        socket.on('close', () => {
          closed = true;
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('test server address unavailable');
      }
      try {
        const client = new SafeOutboundHttpClient({ mode: 'allow-private', timeoutMs: 5000 });
        const response = await client.streamFetch(`http://127.0.0.1:${address.port}/bodyless`);
        expect(response.status).toBe(status);
        expect(response.body).toBeNull();
        expect(response.headers.get('x-untrusted-header')).toBe('preserved');
        await vi.waitFor(() => expect(closed).toBe(true));
      } finally {
        server.close();
      }
    },
  );

  it('rejects private/localhost by default (public-only) and pins DNS for public hosts', async () => {
    const transport = vi.fn<PinnedTransport>(async () => okResponse());

    const defaultClient = new SafeOutboundHttpClient({
      resolve: resolveTo([{ address: '127.0.0.1' }]),
      transport,
    });
    await expect(defaultClient.fetch('http://localhost:3000/health')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
      message: expect.stringContaining('non-public address'),
    });
    expect(transport).not.toHaveBeenCalled();

    for (const address of ['10.0.0.9', '192.168.1.1', '169.254.1.1', '::1']) {
      await expect(
        new SafeOutboundHttpClient({
          resolve: resolveTo([{ address }]),
          transport,
        }).fetch('http://internal.example/health'),
      ).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
        message: expect.stringContaining('non-public address'),
      });
    }

    const privateClient = new SafeOutboundHttpClient({
      mode: 'allow-private',
      resolve: resolveTo([{ address: '127.0.0.1' }]),
      transport: vi.fn<PinnedTransport>(async (req) => {
        expect(req.pinnedAddress).toBe('127.0.0.1');
        expect(req.url.hostname).toBe('localhost');
        return okResponse({ body: Buffer.from('local-ok') });
      }),
    });
    const res = await privateClient.fetch('http://localhost:3000/health');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('local-ok');
  });

  it('allows public IPs when resolved', async () => {
    const transport = vi.fn<PinnedTransport>(async () => okResponse());
    const client = new SafeOutboundHttpClient({
      mode: 'allow-private',
      resolve: resolveTo([{ address: '93.184.216.34' }]),
      transport,
    });
    const res = await client.fetch('https://example.com/');
    expect(res.ok).toBe(true);
  });

  it('public-only mode blocks private/loopback while retaining DNS pinning for public hosts', async () => {
    const transport = vi.fn<PinnedTransport>(async () => okResponse());
    const privateClient = new SafeOutboundHttpClient({
      mode: 'public-only',
      resolve: resolveTo([{ address: '10.0.0.9' }]),
      transport,
    });
    await expect(privateClient.fetch('https://login.example.com/')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
    expect(transport).not.toHaveBeenCalled();

    const publicClient = new SafeOutboundHttpClient({
      mode: 'public-only',
      resolve: resolveTo([{ address: '93.184.216.34' }]),
      transport,
    });
    await expect(publicClient.fetch('https://login.example.com/')).resolves.toMatchObject({
      ok: true,
    });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedAddress: '93.184.216.34' }),
    );
  });

  it('permanently blocks metadata IPv4 literal', async () => {
    const client = new SafeOutboundHttpClient({ mode: 'allow-private', transport: vi.fn() });
    await expect(client.fetch('http://169.254.169.254/latest/meta-data')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
      name: 'SafeOutboundHttpError',
    });
  });

  it('permanently blocks metadata IPv6 literal', async () => {
    const client = new SafeOutboundHttpClient({ mode: 'allow-private', transport: vi.fn() });
    await expect(client.fetch('http://[fd00:ec2::254]/latest/meta-data')).rejects.toBeInstanceOf(
      SafeOutboundHttpError,
    );
  });

  it('permanently blocks IPv4-mapped IPv6 metadata literals', async () => {
    const transport = vi.fn();
    const client = new SafeOutboundHttpClient({ mode: 'allow-private', transport });
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
      mode: 'allow-private',
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
      mode: 'allow-private',
      resolve: resolveTo([{ address: '93.184.216.34' }]),
      transport,
    });
    await expect(client.fetch(`http://[${nat64Metadata}]/`)).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });

    const dnsClient = new SafeOutboundHttpClient({
      mode: 'allow-private',
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
      mode: 'allow-private',
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
      mode: 'allow-private',
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
      mode: 'allow-private',
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

    const client = new SafeOutboundHttpClient({ mode: 'allow-private', resolve, transport });
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
      mode: 'allow-private',
      maxRedirects: 2,
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport,
    });
    await expect(client.fetch('https://loop.example/r')).rejects.toThrow(/redirect/i);
  });

  it('rejects non-http(s) protocols', async () => {
    const client = new SafeOutboundHttpClient({ mode: 'allow-private', transport: vi.fn() });
    await expect(client.fetch('file:///etc/passwd')).rejects.toThrow(/protocol/i);
    await expect(client.fetch('gopher://example.com/')).rejects.toThrow(/protocol/i);
  });

  it.each([
    'key',
    'api_key',
    'access-token',
    'signature',
    'subscription-key',
    'Ocp-Apim-Subscription-Key',
    'X-Amz-Signature',
  ])('rejects sensitive query key %s again at the final outbound boundary', async (key) => {
    const transport = vi.fn();
    const client = new SafeOutboundHttpClient({ mode: 'allow-private', transport });
    await expect(client.fetch(`https://example.test/mcp?${key}=fake-secret`)).rejects.toMatchObject(
      { code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED },
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    '?subscription-key=fake-secret',
    'https://other.example/next?Ocp-Apim-Subscription-Key=fake-secret',
  ])('rejects sensitive query keys introduced by redirect: %s', async (location) => {
    const transport = vi.fn<PinnedTransport>(async () =>
      okResponse({ headers: { location }, status: 302, statusText: 'Found' }),
    );
    const client = new SafeOutboundHttpClient({
      mode: 'allow-private',
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport,
    });
    await expect(client.fetch('https://safe.example/start')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('re-reads a versioned policy after DNS and fails closed when it tightens', async () => {
    let reads = 0;
    const transport = vi.fn();
    const client = new SafeOutboundHttpClient({
      mode: 'allow-private',
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

  it('returns the exact stable policy version used by DNS preflight', async () => {
    const policyProvider = vi.fn(() => ({
      policy: { allowlist: [], mode: 'allow-private' as const },
      version: 'policy-v7',
    }));
    const client = new SafeOutboundHttpClient({
      mode: 'allow-private',
      policyProvider,
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport: vi.fn(),
    });

    await expect(client.preflight('https://connector.example/mcp')).resolves.toBe('policy-v7');
    expect(client.getPolicyVersion()).toBe('policy-v7');
    expect(policyProvider).toHaveBeenCalledTimes(3);
  });

  it.each([
    { policy: { allowlist: [], mode: 'invalid' }, version: 1 },
    { policy: { allowlist: 'example.test', mode: 'allowlist' }, version: 1 },
    { policy: { allowlist: [], mode: 'allow-private' }, version: '' },
    { extra: true, policy: { allowlist: [], mode: 'allow-private' }, version: 1 },
  ])('fails closed for malformed dynamic policy snapshot %#', async (snapshot) => {
    const transport = vi.fn();
    const client = new SafeOutboundHttpClient({
      mode: 'allow-private',
      policyProvider: () => snapshot as never,
      transport,
    });
    await expect(client.fetch('https://example.test/mcp')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails closed when a dynamic policy provider throws', async () => {
    const client = new SafeOutboundHttpClient({
      mode: 'allow-private',
      policyProvider: () => {
        throw new Error('backend unavailable with sensitive details');
      },
      transport: vi.fn(),
    });
    await expect(client.fetch('https://example.test/mcp')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
      message: expect.not.stringContaining('sensitive details'),
    });
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
      mode: 'allow-private',
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
      mode: 'allow-private',
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
      mode: 'allow-private',
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
      mode: 'allow-private',
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

  it.each([301, 302, 303, 307, 308])(
    'rejects arbitrary caller headers on cross-origin %s redirects',
    async (status) => {
      const transport = vi.fn<PinnedTransport>(async () =>
        okResponse({
          headers: { location: 'https://b.example/next' },
          status,
          statusText: 'Redirect',
        }),
      );
      const client = new SafeOutboundHttpClient({
        mode: 'allow-private',
        resolve: resolveTo([{ address: '1.1.1.1' }]),
        transport,
      });
      await expect(
        client.fetch('https://a.example/start', {
          headers: { 'X-Random': 'ordinary-random-secret-with-no-known-shape' },
        }),
      ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED });
      expect(transport).toHaveBeenCalledOnce();
    },
  );

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
      mode: 'allow-private',
      resolve: resolveTo([{ address: '1.1.1.1' }]),
      transport,
    });
    const res = await client.fetch('https://a.example/start', {
      headers: { Authorization: 'Bearer same-origin' },
    });
    expect(await res.text()).toBe('same');
  });

  it('streamFetch and fetch share secret-bearing cross-origin rejection (fixed for whole chain)', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: 'https://b.example/next' });
        response.end('redirect-body');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('should-not-reach');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const client = new SafeOutboundHttpClient({
      mode: 'allow-private',
      resolve: async (hostname) => {
        if (hostname === 'b.example') return [{ address: '1.1.1.1', family: 4 }];
        return [{ address: '127.0.0.1', family: 4 }];
      },
      timeoutMs: 2000,
    });
    try {
      await expect(
        client.streamFetch(`http://127.0.0.1:${address.port}/start`, {
          headers: { Authorization: 'Bearer stream-token' },
        }),
      ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED });

      const transport = vi.fn<PinnedTransport>(async (req) => {
        if (req.url.hostname === 'a.example') {
          return okResponse({
            headers: { location: 'https://b.example/next' },
            status: 302,
            statusText: 'Found',
          });
        }
        throw new Error('cross-origin hop must not run');
      });
      const fetchClient = new SafeOutboundHttpClient({
        mode: 'allow-private',
        resolve: resolveTo([{ address: '1.1.1.1' }]),
        transport,
      });
      await expect(
        fetchClient.fetch('https://a.example/start', {
          headers: { Authorization: 'Bearer fetch-token' },
        }),
      ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED });
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      server.close();
    }
  });

  it('streamFetch cancels intermediate redirect body before rejecting secret cross-origin hop', async () => {
    let redirectClosed = false;
    const server = createServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, {
          'Content-Type': 'text/plain',
          'Location': 'https://b.example/stolen',
        });
        const interval = setInterval(() => response.write('still-streaming-redirect'), 5);
        response.on('close', () => {
          clearInterval(interval);
          redirectClosed = true;
        });
        response.write('redirect-body');
        return;
      }
      response.writeHead(200);
      response.end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const client = new SafeOutboundHttpClient({
      mode: 'allow-private',
      resolve: async (hostname) => {
        if (hostname === 'b.example') return [{ address: '1.1.1.1', family: 4 }];
        return [{ address: '127.0.0.1', family: 4 }];
      },
      timeoutMs: 2000,
    });
    try {
      await expect(
        client.streamFetch(`http://127.0.0.1:${address.port}/start`, {
          headers: { Authorization: 'Bearer cancel-on-reject' },
        }),
      ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED });
      await vi.waitFor(() => expect(redirectClosed).toBe(true));
    } finally {
      server.close();
    }
  });

  it('assertAllowed validates without transport', async () => {
    const transport = vi.fn();
    const client = new SafeOutboundHttpClient({
      mode: 'allow-private',
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
