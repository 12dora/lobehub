import { describe, expect, it } from 'vitest';

import { SafeOutboundHttpClient } from './safeOutboundHttpClient';
import type { PinnedTransport, PinnedTransportRequest } from './types';

describe('SafeOutboundHttpClient resolvesRemotely', () => {
  it('skips DNS pin when the transport declares resolvesRemotely', async () => {
    const seen: PinnedTransportRequest[] = [];
    const transport: PinnedTransport = async (req) => {
      seen.push(req);
      return {
        body: Buffer.from('ok'),
        headers: { 'content-type': 'text/plain' },
        status: 200,
        statusText: 'OK',
      };
    };
    transport.resolvesRemotely = true;

    const client = new SafeOutboundHttpClient({
      transport,
      streamingTransport: async () => new Response('ok'),
    });
    const response = await client.fetch('https://example.com/via-proxy');
    expect(response.status).toBe(200);
    expect(seen[0]?.pinnedAddress).toBe('0.0.0.0');
  });

  it('attaches a structured egress decision so the transport does not re-route', async () => {
    const seen: PinnedTransportRequest[] = [];
    const transport: PinnedTransport = async (req) => {
      seen.push(req);
      return {
        body: Buffer.from('ok'),
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    };
    transport.resolvesRemotely = async () => ({
      egress: { mode: 'proxy', outlet: 'static', proxyUrl: 'http://127.0.0.1:18080' },
      remote: true,
    });

    const client = new SafeOutboundHttpClient({
      transport,
      streamingTransport: async () => new Response('ok'),
    });
    await client.fetch('https://example.com/via-proxy');
    expect(seen[0]?.egress).toEqual({
      mode: 'proxy',
      outlet: 'static',
      proxyUrl: 'http://127.0.0.1:18080',
    });
    expect(seen[0]?.pinnedAddress).toBe('0.0.0.0');
  });

  it('keeps DNS pin when resolvesRemotely is false', async () => {
    const seen: PinnedTransportRequest[] = [];
    const transport: PinnedTransport = async (req) => {
      seen.push(req);
      return {
        body: Buffer.from('ok'),
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    };
    transport.resolvesRemotely = false;

    const client = new SafeOutboundHttpClient({
      resolve: async () => [{ address: '1.2.3.4', family: 4 }],
      transport,
      streamingTransport: async () => new Response('ok'),
    });
    await client.fetch('https://example.com/direct');
    expect(seen[0]?.pinnedAddress).toBe('1.2.3.4');
  });

  it('decides egress once and reuses it across a redirect chain', async () => {
    const decide = vi.fn(async () => ({
      egress: {
        mode: 'proxy' as const,
        outlet: 'static' as const,
        proxyUrl: 'http://127.0.0.1:18080',
      },
      remote: true,
    }));
    const seen: PinnedTransportRequest[] = [];
    const transport: PinnedTransport = async (req) => {
      seen.push(req);
      if (seen.length === 1) {
        return {
          body: Buffer.alloc(0),
          headers: { location: 'https://internal.example/next' },
          status: 302,
          statusText: 'Found',
        };
      }
      return {
        body: Buffer.from('ok'),
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    };
    transport.resolvesRemotely = decide;

    const client = new SafeOutboundHttpClient({
      streamingTransport: async () => new Response('ok'),
      transport,
    });
    const response = await client.fetch('https://example.com/start');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.egress).toEqual(seen[1]?.egress);
    expect(seen[1]?.url.hostname).toBe('internal.example');
    expect(seen[1]?.pinnedAddress).toBe('0.0.0.0');
  });

  it('freezes the same egress decision for streamFetch redirects', async () => {
    const decide = vi.fn(async () => ({
      egress: {
        mode: 'proxy' as const,
        outlet: 'static' as const,
        proxyUrl: 'http://127.0.0.1:18080',
      },
      remote: true,
    }));
    const seen: PinnedTransportRequest[] = [];
    const streamingTransport = async (req: PinnedTransportRequest) => {
      seen.push(req);
      if (seen.length === 1) {
        return new Response(null, {
          headers: { location: 'https://internal.example/next' },
          status: 302,
        });
      }
      return new Response('stream-ok', { status: 200 });
    };
    streamingTransport.resolvesRemotely = decide;

    const client = new SafeOutboundHttpClient({
      streamingTransport,
      transport: async () => ({
        body: Buffer.from('ok'),
        headers: {},
        status: 200,
        statusText: 'OK',
      }),
    });
    const response = await client.streamFetch('https://example.com/start');
    expect(await response.text()).toBe('stream-ok');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.egress).toEqual(seen[1]?.egress);
    expect(seen[1]?.url.hostname).toBe('internal.example');
  });
});
