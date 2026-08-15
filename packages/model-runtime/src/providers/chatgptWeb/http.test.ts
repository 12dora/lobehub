import { describe, expect, it, vi } from 'vitest';

import { ChatGPTWebClient } from './client';
import { MAX_ERROR_BODY_BYTES, readBodySafely } from './http';

/**
 * A response whose HEADERS arrive immediately but whose BODY trickles in later —
 * the shape that used to slip past the request deadline, because the deadline
 * was torn down the moment `fetch` resolved.
 */
const slowBodyResponse = (body: string, delayMs: number, signal?: AbortSignal) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        }, delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            controller.error(signal.reason);
          },
          { once: true },
        );
      },
    }),
    { headers: { 'content-type': 'application/json' }, status: 200 },
  );

const createClient = (fetchImpl: typeof fetch) =>
  new ChatGPTWebClient({
    accessToken: 'access-token',
    deviceId: 'device-1',
    fetch: fetchImpl,
    sessionId: 'session-1',
  });

describe('request deadlines cover body consumption', () => {
  it('times out a body that never arrives, although the headers did', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      slowBodyResponse('{"ok":true}', 5000, init.signal ?? undefined),
    );

    const client = createClient(fetchMock as unknown as typeof fetch);
    await expect(
      (client as any).requestJson({ context: 'probe', path: '/backend-api/me', timeoutMs: 30 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('completes normally when the body arrives inside the deadline', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      slowBodyResponse('{"email":"a@b.co"}', 5, init.signal ?? undefined),
    );

    await expect(createClient(fetchMock as unknown as typeof fetch).getMe()).resolves.toMatchObject(
      {
        email: 'a@b.co',
      },
    );
  });

  it('keeps the caller signal wired while the body is being read', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      setTimeout(() => controller.abort(), 10);
      return slowBodyResponse('{"ok":true}', 5000, init.signal ?? undefined);
    });

    await expect(
      createClient(fetchMock as unknown as typeof fetch).getMe(controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('caller cancellation vs internal deadline', () => {
  it('re-throws the caller abort reason untouched', async () => {
    const controller = new AbortController();
    const sentinel = Object.assign(new Error('user pressed stop'), { name: 'AbortError' });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort(sentinel);
      throw init.signal?.reason ?? sentinel;
    });

    await expect(
      createClient(fetchMock as unknown as typeof fetch).getMe(controller.signal),
    ).rejects.toBe(sentinel);
  });

  it('reports the internal deadline as a provider timeout', async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    );

    // `getMe` uses a 20s deadline; drive it through the generic path instead
    const client = createClient(fetchMock as unknown as typeof fetch);
    await expect(
      (client as any).requestJson({ context: 'probe', path: '/backend-api/me', timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('readBodySafely', () => {
  it('reads at most the diagnostic limit and cancels the rest', async () => {
    let produced = 0;
    let cancelled = false;
    const endless = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        pull(controller) {
          produced += 1;
          controller.enqueue(new TextEncoder().encode('x'.repeat(512)));
        },
      }),
      { status: 500 },
    );

    const body = await readBodySafely(endless);

    expect(body).toHaveLength(MAX_ERROR_BODY_BYTES);
    // an unbounded body is hung up on, never drained
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThan(16);
  });

  it('never buffers a huge error body through the request path', async () => {
    let produced = 0;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              produced += 1;
              controller.enqueue(new TextEncoder().encode('e'.repeat(1024)));
            },
          }),
          { status: 500 },
        ),
    );

    await expect(
      (createClient(fetchMock as unknown as typeof fetch) as any).requestJson({
        context: 'probe',
        path: '/backend-api/me',
      }),
    ).rejects.toMatchObject({ kind: 'upstream' });

    expect(produced).toBeLessThan(8);
  });

  it('rethrows a caller abort raised while the error body is read', async () => {
    const controller = new AbortController();
    const sentinel = Object.assign(new Error('user pressed stop'), { name: 'AbortError' });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          controller.abort(sentinel);
          throw sentinel;
        },
      }),
      { status: 500 },
    );

    await expect(
      readBodySafely(response, () => (controller.signal.reason as Error) ?? sentinel),
    ).rejects.toBe(sentinel);
  });

  it('degrades to no body for an ordinary read failure', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new TypeError('stream broke');
        },
      }),
      { status: 500 },
    );

    await expect(readBodySafely(response)).resolves.toBeUndefined();
  });
});
