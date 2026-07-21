// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createAzureFetchHttpClient } from './azureFetchHttpClient';

const iterableHeaders = (entries: Record<string, string>) => ({
  toJSON: () => entries,
  [Symbol.iterator]: function* () {
    for (const [k, v] of Object.entries(entries)) yield [k, v] as [string, string];
  },
});

describe('createAzureFetchHttpClient', () => {
  it('routes sendRequest through fetch with typespec-style headers (no forEach)', async () => {
    const calledUrls: string[] = [];
    const fetchImpl = async (url: RequestInfo | URL) => {
      calledUrls.push(String(url));
      return new Response('{"ok":true}', { status: 200 });
    };
    const client = createAzureFetchHttpClient(fetchImpl);

    const result = await client.sendRequest({
      body: '{"x":1}',
      headers: iterableHeaders({ 'api-key': 'secret', 'content-type': 'application/json' }),
      method: 'POST',
      timeout: 0,
      url: 'https://example.openai.azure.com/chat/completions',
    });

    expect(calledUrls).toEqual([
      expect.stringContaining('example.openai.azure.com') as unknown as string,
    ]);
    expect(calledUrls[0]).toContain('example.openai.azure.com');
    expect(result.status).toBe(200);
    expect(result.bodyAsText).toBe('{"ok":true}');
  });

  it('propagates already-aborted signals without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const client = createAzureFetchHttpClient(fetchImpl as never);
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.sendRequest({
        abortSignal: controller.signal,
        headers: iterableHeaders({}),
        method: 'GET',
        url: 'https://example.openai.azure.com/models',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
