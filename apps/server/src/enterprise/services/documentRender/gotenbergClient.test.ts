// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { convertToPdf, resolveMaxConvertedBytes } from './gotenbergClient';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const endpoint = 'http://document-render:3000';

const fetchOk = (init: {
  body?: ReadableStream<Uint8Array> | null;
  contentLength?: string;
  extra?: Uint8Array;
}) =>
  vi.fn(async () => {
    if (init.body) {
      return {
        body: init.body,
        headers: new Headers(
          init.contentLength ? { 'content-length': init.contentLength } : undefined,
        ),
        ok: true,
      } as Response;
    }
    const extra = init.extra ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    return {
      arrayBuffer: async () =>
        extra.buffer.slice(extra.byteOffset, extra.byteOffset + extra.byteLength),
      body: null,
      headers: new Headers(
        init.contentLength ? { 'content-length': init.contentLength } : undefined,
      ),
      ok: true,
    } as Response;
  });

describe('resolveMaxConvertedBytes', () => {
  it('clamps to 4× input with a 16 MiB floor and 256 MiB ceiling', () => {
    expect(resolveMaxConvertedBytes(1024)).toBe(16 * 1024 * 1024);
    expect(resolveMaxConvertedBytes(8 * 1024 * 1024)).toBe(32 * 1024 * 1024);
    expect(resolveMaxConvertedBytes(128 * 1024 * 1024)).toBe(256 * 1024 * 1024);
  });
});

describe('convertToPdf', () => {
  it('rejects when content-length exceeds the converted-byte cap', async () => {
    vi.stubGlobal('fetch', fetchOk({ contentLength: String(1000) }));
    await expect(
      convertToPdf(endpoint, {
        bytes: new Uint8Array(10),
        filename: 'a.docx',
        maxConvertedBytes: 100,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/maxConvertedBytes/);
  });

  it('rejects when streamed bytes exceed the cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(80));
        controller.enqueue(new Uint8Array(80));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', fetchOk({ body: stream }));
    await expect(
      convertToPdf(endpoint, {
        bytes: new Uint8Array(10),
        filename: 'a.docx',
        maxConvertedBytes: 100,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/maxConvertedBytes/);
  });

  it('honours an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('fetch should not run');
      }),
    );
    await expect(
      convertToPdf(endpoint, {
        bytes: new Uint8Array(10),
        filename: 'a.docx',
        signal: controller.signal,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns the PDF when under the cap', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    vi.stubGlobal('fetch', fetchOk({ extra: pdf }));
    await expect(
      convertToPdf(endpoint, {
        bytes: new Uint8Array(10),
        filename: 'a.docx',
        maxConvertedBytes: 100,
        timeoutMs: 1000,
      }),
    ).resolves.toEqual(pdf);
  });
});
