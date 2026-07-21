// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createFetchRequestHandler } from './fetchRequestHandler';

describe('createFetchRequestHandler abort semantics', () => {
  it('throws AbortError when abortSignal is already aborted', async () => {
    const fetchImpl = vi.fn();
    const handler = createFetchRequestHandler(fetchImpl as never);
    const controller = new AbortController();
    controller.abort();

    await expect(
      handler.handle(
        {
          headers: {},
          hostname: 'bedrock-runtime.us-east-1.amazonaws.com',
          method: 'POST',
          path: '/model/x/invoke',
          protocol: 'https:',
        },
        { abortSignal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates mid-flight abort and cleans up timeout listeners', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('aborted') as Error & { name: string };
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
          setTimeout(() => controller.abort(), 5);
        }),
    );

    const handler = createFetchRequestHandler(fetchImpl as never);
    await expect(
      handler.handle(
        {
          body: '{}',
          headers: { 'content-type': 'application/json' },
          hostname: 'bedrock-runtime.us-east-1.amazonaws.com',
          method: 'POST',
          path: '/model/x/invoke',
          protocol: 'https:',
        },
        { abortSignal: controller.signal, requestTimeout: 30_000 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
