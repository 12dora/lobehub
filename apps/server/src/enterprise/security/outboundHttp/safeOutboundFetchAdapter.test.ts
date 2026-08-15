// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { ssrfBlocked } from './errors';
import {
  createSafeOutboundFetchAdapter,
  DEFAULT_ADAPTER_MAX_REQUEST_BODY_BYTES,
} from './safeOutboundFetchAdapter';
import type { SafeOutboundHttpClient } from './safeOutboundHttpClient';
import type { SafeOutboundRequestInit, SafeOutboundResponse } from './types';

const okClientResponse = (): SafeOutboundResponse => ({
  arrayBuffer: async () => new ArrayBuffer(0),
  body: Buffer.from('ok'),
  headers: new Headers({ 'content-type': 'text/plain' }),
  json: async () => ({}),
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => 'ok',
  truncated: false,
  url: 'https://example.test/',
});

describe('createSafeOutboundFetchAdapter', () => {
  it('forwards Request.signal when init is omitted', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init?: SafeOutboundRequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return okClientResponse();
    });
    const client = { fetch: fetchMock } as unknown as SafeOutboundHttpClient;
    const adapter = createSafeOutboundFetchAdapter(client, { timeoutMs: 5_000 });

    const request = new Request('https://example.test/probe', {
      method: 'GET',
      signal: controller.signal,
    });
    await adapter(request);

    expect(fetchMock).toHaveBeenCalledOnce();
    const forwarded = fetchMock.mock.calls[0]?.[1];
    expect(forwarded?.signal).toBeTruthy();
  });

  it('aborts body stream normalization when Request.signal aborts before first read', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => okClientResponse());
    const client = { fetch: fetchMock } as unknown as SafeOutboundHttpClient;
    const adapter = createSafeOutboundFetchAdapter(client, { timeoutMs: 5_000 });

    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new Uint8Array([1, 2, 3]));
        // Never close — hang until aborted.
        controller.abort();
      },
    });

    const request = new Request('https://example.test/upload', {
      // @ts-expect-error duplex required by undici for streaming bodies
      duplex: 'half',
      body: stream,
      method: 'POST',
      signal: controller.signal,
    });

    await expect(adapter(request)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts after the first stream chunk when signal aborts mid-read', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => okClientResponse());
    const client = { fetch: fetchMock } as unknown as SafeOutboundHttpClient;
    const adapter = createSafeOutboundFetchAdapter(client, { timeoutMs: 5_000 });

    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        pullCount += 1;
        if (pullCount === 1) {
          streamController.enqueue(new Uint8Array([1, 2, 3]));
          // Abort only after the first read has resolved — exercises interruptible read.
          queueMicrotask(() => controller.abort());
          return;
        }
        // Subsequent pull never enqueues or closes — would hang without signal-aware read.
      },
    });

    const request = new Request('https://example.test/upload', {
      // @ts-expect-error duplex required by undici for streaming bodies
      duplex: 'half',
      body: stream,
      method: 'POST',
      signal: controller.signal,
    });

    await expect(adapter(request)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pullCount).toBeGreaterThanOrEqual(1);
  });

  it('rejects a permanently silent stream body when the adapter deadline fires', async () => {
    const fetchMock = vi.fn(async () => okClientResponse());
    const client = { fetch: fetchMock } as unknown as SafeOutboundHttpClient;
    const adapter = createSafeOutboundFetchAdapter(client, { timeoutMs: 50 });

    // Never enqueues or closes — body normalization must not hang past timeoutMs.
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* stalled source: no enqueue, no close */
      },
    });

    await expect(
      adapter('https://example.test/upload', {
        // @ts-expect-error duplex required by undici for streaming bodies
        duplex: 'half',
        body: stream,
        method: 'POST',
      }),
    ).rejects.toMatchObject({
      message: 'Safe outbound adapter deadline exceeded',
      name: 'TimeoutError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects request bodies one byte over the adapter limit before the client runs', async () => {
    const fetchMock = vi.fn(async () => okClientResponse());
    const client = { fetch: fetchMock } as unknown as SafeOutboundHttpClient;
    const maxRequestBodyBytes = 16;
    const adapter = createSafeOutboundFetchAdapter(client, {
      maxRequestBodyBytes,
      timeoutMs: 5_000,
    });

    const body = Buffer.alloc(maxRequestBodyBytes + 1, 0x61);
    await expect(
      adapter('https://example.test/upload', {
        body,
        method: 'POST',
      }),
    ).rejects.toThrow(/exceeds 16 bytes/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(DEFAULT_ADAPTER_MAX_REQUEST_BODY_BYTES).toBeGreaterThan(0);
  });

  it('passes remaining timeout budget after body normalization', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: SafeOutboundRequestInit) => {
      expect(init?.timeoutMs).toBeDefined();
      expect(init!.timeoutMs!).toBeLessThanOrEqual(200);
      expect(init!.timeoutMs!).toBeGreaterThan(0);
      return okClientResponse();
    });
    const client = { fetch: fetchMock } as unknown as SafeOutboundHttpClient;
    const adapter = createSafeOutboundFetchAdapter(client, { timeoutMs: 200 });

    await adapter('https://example.test/', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a soft-truncated response instead of handing back a prefix', async () => {
    // The client marks a body cut short at maxResponseBytes. Dropping that flag turned an
    // enforced limit into a silent "here is half a JSON document".
    const fetchMock = vi.fn(async () => ({ ...okClientResponse(), truncated: true }));
    const client = { fetch: fetchMock } as unknown as SafeOutboundHttpClient;
    const adapter = createSafeOutboundFetchAdapter(client, { timeoutMs: 5_000 });

    await expect(adapter('https://example.test/', { method: 'GET' })).rejects.toMatchObject({
      name: 'SafeOutboundTruncatedError',
    });
  });

  describe('streaming mode', () => {
    const openStream = (onCancel?: () => void) =>
      new ReadableStream<Uint8Array>({
        cancel: onCancel,
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: first\n\n'));
          // Never closes — a buffering hop would hang here.
        },
      });

    it('returns an un-buffered Response from streamFetch without touching the buffered hop', async () => {
      const fetchMock = vi.fn(async () => okClientResponse());
      const streamFetchMock = vi.fn(
        async () =>
          new Response(openStream(), { headers: { 'content-type': 'text/event-stream' } }),
      );
      const client = {
        fetch: fetchMock,
        streamFetch: streamFetchMock,
      } as unknown as SafeOutboundHttpClient;
      const adapter = createSafeOutboundFetchAdapter(client, { streaming: true, timeoutMs: 5_000 });

      const response = await adapter('https://example.test/responses', { method: 'POST' });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(streamFetchMock).toHaveBeenCalledOnce();
      expect(response.body).toBeTruthy();
      const first = await response.body!.getReader().read();
      expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
    });

    it('keeps policy / redirect / byte-cap guards and the enterprise denial wrapper', async () => {
      const streamFetchMock = vi.fn(async (_url: string, init?: SafeOutboundRequestInit) => {
        // Guards run inside the client; the adapter must forward the bounds that arm them.
        expect(init?.maxRedirects).toBe(1);
        expect(init?.maxResponseBytes).toBe(2048);
        expect(init?.secretBearing).toBe(true);
        expect(init?.timeoutMs).toBeGreaterThan(0);
        throw ssrfBlocked('secret_redirect', 'cross-origin redirect rejected');
      });
      const client = {
        fetch: vi.fn(),
        streamFetch: streamFetchMock,
      } as unknown as SafeOutboundHttpClient;
      const adapter = createSafeOutboundFetchAdapter(client, {
        maxRedirects: 1,
        maxResponseBytes: 2048,
        secretBearing: true,
        streaming: true,
        timeoutMs: 5_000,
      });

      await expect(
        adapter('https://example.test/responses', { method: 'POST' }),
      ).rejects.toMatchObject({
        message: 'Outbound request blocked by enterprise network policy',
        name: 'SafeOutboundFetchError',
      });
    });

    it('still forwards a caller abort after the streaming response was handed back', async () => {
      // The response outlives the adapter call. Dropping the abort wiring on return left the
      // socket running until the transport deadline even though the caller had hung up.
      let clientSignal: AbortSignal | null | undefined;
      const streamFetchMock = vi.fn(async (_url: string, init?: SafeOutboundRequestInit) => {
        clientSignal = init?.signal;
        return new Response(openStream());
      });
      const client = {
        fetch: vi.fn(),
        streamFetch: streamFetchMock,
      } as unknown as SafeOutboundHttpClient;
      const adapter = createSafeOutboundFetchAdapter(client, { streaming: true, timeoutMs: 5_000 });
      const controller = new AbortController();

      await adapter('https://example.test/responses', {
        method: 'POST',
        signal: controller.signal,
      });

      expect(clientSignal?.aborted).toBe(false);
      controller.abort();
      expect(clientSignal?.aborted).toBe(true);
    });
  });

  it('removes each abort listener after a highly fragmented stream completes', async () => {
    const addListener = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    const fetchMock = vi.fn(async () => okClientResponse());
    const client = { fetch: fetchMock } as unknown as SafeOutboundHttpClient;
    const adapter = createSafeOutboundFetchAdapter(client, { timeoutMs: 5_000 });
    const controller = new AbortController();
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (chunks === 128) {
          streamController.close();
          return;
        }
        chunks += 1;
        streamController.enqueue(new Uint8Array([chunks]));
      },
    });

    await adapter('https://example.test/upload', {
      // @ts-expect-error duplex required by undici for streaming bodies
      duplex: 'half',
      body: stream,
      method: 'POST',
      signal: controller.signal,
    });

    const abortAdds = addListener.mock.calls.filter(([type]) => type === 'abort').length;
    const abortRemoves = removeListener.mock.calls.filter(([type]) => type === 'abort').length;
    expect(chunks).toBe(128);
    expect(abortRemoves).toBe(abortAdds);
  });
});
