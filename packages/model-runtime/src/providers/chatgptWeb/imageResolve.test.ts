// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { ChatGPTWebClient } from './client';
import { ChatGPTWebError } from './errors';
import { mergePointers, resolveImages, samePointerSet } from './imageResolve';

const png = (tint: number) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    0,
    0,
    0,
    4,
    0,
    0,
    0,
    2,
    8,
    6,
    0,
    0,
    tint,
  ]);

const createClient = (overrides: Record<string, any> = {}) =>
  ({
    downloadBytes: vi.fn(async () => ({ bytes: png(1), mimeType: 'image/png' })),
    getAttachmentDownloadUrl: vi.fn(async (_c: string, id: string) => `https://cdn/att/${id}`),
    getFileDownloadUrl: vi.fn(async (id: string) => `https://cdn/file/${id}`),
    ...overrides,
  }) as unknown as ChatGPTWebClient & Record<string, ReturnType<typeof vi.fn>>;

describe('mergePointers', () => {
  it('unions in order and drops the upload placeholder', () => {
    expect(
      mergePointers(
        [
          { fileId: 'a', kind: 'file-service' },
          { fileId: 'file_upload', kind: 'sediment' },
        ],
        [
          { fileId: 'a', kind: 'file-service' },
          { fileId: 'a', kind: 'sediment' },
        ],
      ),
    ).toEqual([
      { fileId: 'a', kind: 'file-service' },
      { fileId: 'a', kind: 'sediment' },
    ]);
  });
});

describe('samePointerSet', () => {
  it('compares by identity, not by order', () => {
    const left = [
      { fileId: 'a', kind: 'file-service' } as const,
      { fileId: 'b', kind: 'sediment' } as const,
    ];
    expect(samePointerSet(left, [left[1], left[0]])).toBe(true);
    expect(samePointerSet(left, [left[0]])).toBe(false);
  });
});

describe('resolveImages', () => {
  it('deduplicates identical bytes reached through different pointers', async () => {
    const client = createClient();

    const images = await resolveImages({
      client,
      conversationId: 'conv-1',
      pointers: [
        { fileId: 'file_one', kind: 'file-service' },
        { fileId: 'file_one', kind: 'sediment' },
      ],
    });

    expect(client.downloadBytes).toHaveBeenCalledTimes(2);
    expect(images).toEqual([{ bytes: png(1), height: 2, mimeType: 'image/png', width: 4 }]);
  });

  it('skips pointers that fail to resolve or download', async () => {
    const client = createClient({
      downloadBytes: vi
        .fn()
        .mockRejectedValueOnce(new Error('gone'))
        .mockResolvedValue({ bytes: png(2), mimeType: 'image/png' }),
      getFileDownloadUrl: vi
        .fn()
        .mockRejectedValueOnce(new Error('404'))
        .mockResolvedValueOnce('https://cdn/file/two')
        .mockResolvedValueOnce('https://cdn/file/three'),
    });

    const images = await resolveImages({
      client,
      pointers: [
        { fileId: 'one', kind: 'file-service' },
        { fileId: 'two', kind: 'file-service' },
        { fileId: 'three', kind: 'file-service' },
      ],
    });

    expect(images).toHaveLength(1);
    expect(images[0].bytes).toEqual(png(2));
  });

  it('cannot resolve sediment pointers without a conversation id', async () => {
    const client = createClient();

    const images = await resolveImages({
      client,
      pointers: [{ fileId: 'file_one', kind: 'sediment' }],
    });

    expect(images).toEqual([]);
    expect(client.getAttachmentDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects bytes whose signature is not a supported image', async () => {
    const client = createClient({
      downloadBytes: vi.fn(async () => ({
        // a 200 carrying an error page must never become `data:text/html`
        bytes: new TextEncoder().encode('<!doctype html><html>denied</html>'),
        mimeType: 'text/html',
      })),
    });

    const images = await resolveImages({
      client,
      pointers: [{ fileId: 'file_one', kind: 'file-service' }],
    });

    expect(images).toEqual([]);
  });

  it('skips an unrecognised payload and keeps the next valid pointer', async () => {
    const client = createClient({
      downloadBytes: vi
        .fn()
        .mockResolvedValueOnce({
          bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
          mimeType: 'image/avif',
        })
        .mockResolvedValue({ bytes: png(3), mimeType: 'image/png' }),
      getFileDownloadUrl: vi
        .fn()
        .mockResolvedValueOnce('https://cdn/file/one')
        .mockResolvedValueOnce('https://cdn/file/two'),
    });

    const images = await resolveImages({
      client,
      pointers: [
        { fileId: 'one', kind: 'file-service' },
        { fileId: 'two', kind: 'file-service' },
      ],
    });

    expect(images).toEqual([{ bytes: png(3), height: 2, mimeType: 'image/png', width: 4 }]);
  });

  it('skips a pointer-specific failure but rethrows a call-wide one', async () => {
    // `not_found` is about this asset — the next pointer may still have it
    const skipped = createClient({
      getFileDownloadUrl: vi
        .fn()
        .mockRejectedValueOnce(new ChatGPTWebError('not_found', 'gone', { status: 404 }))
        .mockResolvedValue('https://cdn/file/two'),
    });

    await expect(
      resolveImages({
        client: skipped,
        pointers: [
          { fileId: 'one', kind: 'file-service' },
          { fileId: 'two', kind: 'file-service' },
        ],
      }),
    ).resolves.toHaveLength(1);

    // a dead token is about the whole call: swallowing it reports
    // `ProviderNoImageGenerated`, which sends the user to fix their prompt
    const auth = new ChatGPTWebError('auth', 'unauthorized', { status: 401 });
    const client = createClient({ getFileDownloadUrl: vi.fn().mockRejectedValue(auth) });

    await expect(
      resolveImages({
        client,
        pointers: [
          { fileId: 'one', kind: 'file-service' },
          { fileId: 'two', kind: 'file-service' },
        ],
      }),
    ).rejects.toBe(auth);
    expect(client.getFileDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it('rethrows a rate limit raised while downloading', async () => {
    const limited = new ChatGPTWebError('rate_limit', 'too many requests', { status: 429 });
    const client = createClient({ downloadBytes: vi.fn().mockRejectedValue(limited) });

    await expect(
      resolveImages({ client, pointers: [{ fileId: 'one', kind: 'file-service' }] }),
    ).rejects.toBe(limited);
  });

  it.each([
    ['resolution', 'getFileDownloadUrl'],
    ['download', 'downloadBytes'],
  ])('rethrows the abort reason when the budget expires during %s', async (_phase, method) => {
    const controller = new AbortController();
    const reason = new ChatGPTWebError('timeout', 'image generation exceeded its 200000ms');
    const client = createClient({
      [method]: vi.fn(async () => {
        controller.abort(reason);
        // whatever the transport turns the cancellation into, the abort reason
        // is the authoritative failure
        throw new Error('socket closed');
      }),
    });

    await expect(
      resolveImages({
        client,
        pointers: [{ fileId: 'one', kind: 'file-service' }],
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it('bounds each download by whatever is left of the shared budget', async () => {
    const client = createClient();

    await resolveImages({
      client,
      deadline: Date.now() + 3000,
      pointers: [{ fileId: 'file_one', kind: 'file-service' }],
    });

    const [, options] = (client.downloadBytes as any).mock.calls[0];
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(3000);
  });
});
