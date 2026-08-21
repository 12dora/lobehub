// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { imageUrlToBase64 } from './imageToBase64';

const ssrfSafeFetch = vi.fn();

vi.mock('@lobechat/ssrf-safe-fetch', () => ({
  ssrfSafeFetch: (...args: unknown[]) => ssrfSafeFetch(...args),
}));

describe('imageUrlToBase64 (server)', () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  beforeEach(() => {
    ssrfSafeFetch.mockReset();
    ssrfSafeFetch.mockResolvedValue({
      blob: () => Promise.resolve(new Blob([pngBytes], { type: 'image/png' })),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows private IPs only for this deployment's file hosts", async () => {
    await imageUrlToBase64('http://localhost:9000/bucket/cat.png');

    expect(ssrfSafeFetch).toHaveBeenCalledWith(
      'http://localhost:9000/bucket/cat.png',
      {},
      expect.objectContaining({
        allowPrivateIPAddress: true,
        maxContentLength: 20 * 1024 * 1024 + 1,
      }),
    );
  });

  it('keeps SSRF blocking for arbitrary public hosts', async () => {
    await imageUrlToBase64('https://cdn.example.com/cat.png');

    expect(ssrfSafeFetch).toHaveBeenCalledWith(
      'https://cdn.example.com/cat.png',
      {},
      expect.objectContaining({
        allowPrivateIPAddress: false,
      }),
    );
  });
});
