// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentFetchError, imageUrlToBase64 } from './imageToBase64';

const ssrfSafeFetch = vi.fn();

vi.mock('@lobechat/ssrf-safe-fetch', () => ({
  ssrfSafeFetch: (...args: unknown[]) => ssrfSafeFetch(...args),
}));

describe('imageUrlToBase64 (server)', () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const originalEnv = {
    APP_URL: process.env.APP_URL,
    INTERNAL_APP_URL: process.env.INTERNAL_APP_URL,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ENABLE_PATH_STYLE: process.env.S3_ENABLE_PATH_STYLE,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
  };

  beforeEach(() => {
    delete process.env.APP_URL;
    delete process.env.INTERNAL_APP_URL;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ENABLE_PATH_STYLE;
    delete process.env.S3_ENDPOINT;
    ssrfSafeFetch.mockReset();
    ssrfSafeFetch.mockResolvedValue({
      blob: () => Promise.resolve(new Blob([pngBytes], { type: 'image/png' })),
      ok: true,
      status: 200,
    });
  });

  afterEach(() => {
    const restore = (key: keyof typeof originalEnv, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('APP_URL', originalEnv.APP_URL);
    restore('INTERNAL_APP_URL', originalEnv.INTERNAL_APP_URL);
    restore('S3_BUCKET', originalEnv.S3_BUCKET);
    restore('S3_ENABLE_PATH_STYLE', originalEnv.S3_ENABLE_PATH_STYLE);
    restore('S3_ENDPOINT', originalEnv.S3_ENDPOINT);
    vi.restoreAllMocks();
  });

  it('does not override SSRF_ALLOW_PRIVATE_IP_ADDRESS for default callers', async () => {
    await imageUrlToBase64('https://cdn.example.com/cat.png');

    expect(ssrfSafeFetch).toHaveBeenCalledWith('https://cdn.example.com/cat.png', {}, undefined);
  });

  it('allows private IPs only for allowlisted file origins when ownOriginOnly is set', async () => {
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    process.env.S3_BUCKET = 'bucket';
    process.env.S3_ENABLE_PATH_STYLE = '1';

    await imageUrlToBase64('http://localhost:9000/bucket/cat.png', {
      maxBytes: 20 * 1024 * 1024,
      ownOriginOnly: true,
    });

    expect(ssrfSafeFetch).toHaveBeenCalledWith(
      'http://localhost:9000/bucket/cat.png',
      { redirect: 'manual' },
      expect.objectContaining({
        allowPrivateIPAddress: true,
        maxContentLength: 20 * 1024 * 1024 + 1,
        maxRedirects: 0,
      }),
    );
  });

  it('does not fetch generic loopback when ownOriginOnly is set', async () => {
    await expect(
      imageUrlToBase64('http://127.0.0.1:3000/internal', { ownOriginOnly: true }),
    ).rejects.toThrow(AttachmentFetchError);
    expect(ssrfSafeFetch).not.toHaveBeenCalled();
  });

  it('follows redirects only onto other allowlisted file URLs', async () => {
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    process.env.S3_BUCKET = 'bucket';
    process.env.S3_ENABLE_PATH_STYLE = '1';
    process.env.APP_URL = 'https://app.example.com';

    ssrfSafeFetch
      .mockResolvedValueOnce({
        headers: { get: (name: string) => (name === 'location' ? '/bucket/cat.png' : null) },
        ok: false,
        status: 302,
      })
      .mockResolvedValueOnce({
        blob: () => Promise.resolve(new Blob([pngBytes], { type: 'image/png' })),
        ok: true,
        status: 200,
      });

    await imageUrlToBase64('http://localhost:9000/bucket/redirect.png', { ownOriginOnly: true });

    expect(ssrfSafeFetch).toHaveBeenCalledTimes(2);
    expect(ssrfSafeFetch.mock.calls[1][0]).toBe('http://localhost:9000/bucket/cat.png');
  });

  it('rejects a redirect off the allowlist', async () => {
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    process.env.S3_BUCKET = 'bucket';
    process.env.S3_ENABLE_PATH_STYLE = '1';

    ssrfSafeFetch.mockResolvedValueOnce({
      headers: {
        get: (name: string) => (name === 'location' ? 'http://127.0.0.1:3000/internal' : null),
      },
      ok: false,
      status: 302,
    });

    await expect(
      imageUrlToBase64('http://localhost:9000/bucket/cat.png', { ownOriginOnly: true }),
    ).rejects.toThrow(AttachmentFetchError);
    expect(ssrfSafeFetch).toHaveBeenCalledTimes(1);
  });
});
