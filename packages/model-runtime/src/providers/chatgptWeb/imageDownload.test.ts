// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { ChatGPTWebClient, MAX_DOWNLOAD_BYTES } from './client';
import { resolveImages } from './imageResolve';

/**
 * Integration coverage for the image download path: the review flagged
 * `downloadBytes()` as reading a `ManagedResponse` like a native `Response`.
 * These tests drive the REAL client through a fake `fetch` so a regression on
 * the managed-response contract (status/headers/body under `.response`, the
 * deadline released in `finally`) fails here rather than in production.
 */

const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...u32be(13),
  0x49,
  0x48,
  0x44,
  0x52,
  ...u32be(16),
  ...u32be(9),
  8,
  6,
  0,
  0,
  0,
]);

/** `Uint8Array` is a valid body at runtime; the DOM lib type omits it. */
const asBody = (input: Uint8Array): BodyInit => input as unknown as BodyInit;

/** A body produced lazily, so "32 MiB + 1" costs one chunk at a time. */
const lazyBody = (totalBytes: number, headers: HeadersInit = {}) => {
  const chunk = 1024 * 1024;
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunk, totalBytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size));
      },
    }),
    { headers, status: 200 },
  );
};

const clientWith = (fetchMock: ReturnType<typeof vi.fn>) =>
  new ChatGPTWebClient({
    accessToken: 'access-token',
    deviceId: 'device-1',
    fetch: fetchMock as unknown as typeof fetch,
    sessionId: 'session-1',
  });

describe('ChatGPTWebClient.downloadBytes over a fake transport', () => {
  it('returns image bytes and the content type for a 200', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(asBody(PNG), { headers: { 'content-type': 'image/png' }, status: 200 }),
    );

    const result = await clientWith(fetchMock).downloadBytes('https://blob.example.com/signed');

    expect([...result.bytes]).toEqual([...PNG]);
    expect(result.mimeType).toBe('image/png');
  });

  it('rejects a body one byte over the default 32 MiB ceiling', async () => {
    const fetchMock = vi.fn(async () => lazyBody(MAX_DOWNLOAD_BYTES + 1));

    await expect(
      clientWith(fetchMock).downloadBytes('https://blob.example.com/huge'),
    ).rejects.toMatchObject({ kind: 'upstream', name: 'ChatGPTWebError' });
  });

  it('rejects a non-2xx response instead of returning its body', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<html>Access denied</html>', {
          headers: { 'content-type': 'text/html' },
          status: 403,
        }),
    );

    await expect(
      clientWith(fetchMock).downloadBytes('https://blob.example.com/denied'),
    ).rejects.toMatchObject({ name: 'ChatGPTWebError', status: 403 });
  });

  it('feeds real bytes through the resolve pipeline and drops an error page', async () => {
    // every pointer is resolved to a URL first, then the URLs are downloaded
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ download_url: 'https://blob.example.com/one' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ download_url: 'https://blob.example.com/two' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      // the first asset answers 200 with an HTML error page — not an image
      .mockResolvedValueOnce(
        new Response('<html>oops</html>', {
          headers: { 'content-type': 'text/html' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(asBody(PNG), { headers: { 'content-type': 'image/png' }, status: 200 }),
      );

    const images = await resolveImages({
      client: clientWith(fetchMock),
      pointers: [
        { fileId: 'file_000000001111222233334444', kind: 'file-service' },
        { fileId: 'file_000000005555666677778888', kind: 'file-service' },
      ],
    });

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ height: 9, mimeType: 'image/png', width: 16 });
  });
});
