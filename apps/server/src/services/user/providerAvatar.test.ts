import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFileS3 } from '@/server/modules/S3';

import { materializeProviderAvatar } from './providerAvatar';

vi.mock('@lobechat/ssrf-safe-fetch', () => ({ ssrfSafeFetch: vi.fn() }));
vi.mock('@/server/modules/S3', () => ({ createFileS3: vi.fn() }));

const uploadBuffer = vi.fn();
const deleteFiles = vi.fn();
const listObjectKeysByPrefix = vi.fn<(prefix: string) => Promise<string[]>>();

describe('materializeProviderAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listObjectKeysByPrefix.mockResolvedValue([]);
    vi.mocked(createFileS3).mockResolvedValue({
      deleteFiles,
      listObjectKeysByPrefix,
      uploadBuffer,
    } as never);
  });

  it('downloads and uploads an HTTPS image to the local avatar store', async () => {
    vi.mocked(ssrfSafeFetch).mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png; charset=binary' },
      }),
    );

    const result = await materializeProviderAvatar({
      sourceUrl: 'https://cdn.example.com/avatar.png',
      userId: 'user-1',
    });

    expect(result).toMatch(/^\/webapi\/user\/avatar\/user-1\/provider-[a-f\d]{64}\.png$/);
    expect(ssrfSafeFetch).toHaveBeenCalledWith(
      'https://cdn.example.com/avatar.png',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      {
        allowIPAddressList: [],
        allowPrivateIPAddress: false,
        maxContentLength: 2 * 1024 * 1024 + 1,
        redactErrors: true,
      },
    );
    expect(uploadBuffer).toHaveBeenCalledWith(
      expect.stringMatching(/^user\/avatar\/user-1\/provider-[a-f\d]{64}\.png$/),
      Buffer.from([1, 2, 3]),
      'image/png',
    );
  });

  it.each(['', '/images/avatar.png', 'data:image/png;base64,AA==', 'mailto:user@example.com'])(
    'passes through non-HTTP input %j',
    async (sourceUrl) => {
      await expect(materializeProviderAvatar({ sourceUrl, userId: 'user-1' })).resolves.toBe(
        sourceUrl,
      );
      expect(ssrfSafeFetch).not.toHaveBeenCalled();
    },
  );

  it('refuses a non-HTTPS provider URL', async () => {
    const sourceUrl = 'http://cdn.example.com/avatar.png';

    await expect(materializeProviderAvatar({ sourceUrl, userId: 'user-1' })).resolves.toBe(
      sourceUrl,
    );
    expect(ssrfSafeFetch).not.toHaveBeenCalled();
  });

  it('returns the original URL when the SSRF guard blocks a private host', async () => {
    vi.mocked(ssrfSafeFetch).mockRejectedValue(new Error('SSRF blocked: host=127.0.0.1'));
    const sourceUrl = 'https://127.0.0.1/avatar.png';

    await expect(materializeProviderAvatar({ sourceUrl, userId: 'user-1' })).resolves.toBe(
      sourceUrl,
    );
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('rejects a response body over two megabytes', async () => {
    const sourceUrl = 'https://cdn.example.com/huge.png';
    vi.mocked(ssrfSafeFetch).mockResolvedValue(
      new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'image/png' },
      }),
    );

    await expect(materializeProviderAvatar({ sourceUrl, userId: 'user-1' })).resolves.toBe(
      sourceUrl,
    );
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('rejects a non-image content type', async () => {
    const sourceUrl = 'https://cdn.example.com/avatar';
    vi.mocked(ssrfSafeFetch).mockResolvedValue(
      new Response('not an image', { headers: { 'content-type': 'text/html' } }),
    );

    await expect(materializeProviderAvatar({ sourceUrl, userId: 'user-1' })).resolves.toBe(
      sourceUrl,
    );
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('returns the original URL when fetching fails', async () => {
    const sourceUrl = 'https://cdn.example.com/avatar.png';
    vi.mocked(ssrfSafeFetch).mockRejectedValue(new Error('network unavailable'));

    await expect(materializeProviderAvatar({ sourceUrl, userId: 'user-1' })).resolves.toBe(
      sourceUrl,
    );
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('skips downloading when the current local URL was produced from the same source URL', async () => {
    const sourceUrl = 'https://cdn.example.com/avatar.png';
    vi.mocked(ssrfSafeFetch).mockResolvedValue(
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
    );
    const currentAvatarUrl = await materializeProviderAvatar({ sourceUrl, userId: 'user-1' });
    vi.clearAllMocks();

    await expect(
      materializeProviderAvatar({ currentAvatarUrl, sourceUrl, userId: 'user-1' }),
    ).resolves.toBe(currentAvatarUrl);
    expect(ssrfSafeFetch).not.toHaveBeenCalled();
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  // `overrideUserInfo` rewrites the row with the provider URL on every SSO login, so the stored
  // value cannot answer "already copied?" — the deterministic object name has to.
  it('reuses an already-stored object even when the row still holds the provider URL', async () => {
    const sourceUrl = 'https://cdn.example.com/avatar.png';
    listObjectKeysByPrefix.mockResolvedValue(['user/avatar/user-1/provider-0123456789abcdef.png']);

    await expect(
      materializeProviderAvatar({ currentAvatarUrl: sourceUrl, sourceUrl, userId: 'user-1' }),
    ).resolves.toBe('/webapi/user/avatar/user-1/provider-0123456789abcdef.png');
    expect(ssrfSafeFetch).not.toHaveBeenCalled();
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('deletes the provider objects a rotated source URL left behind', async () => {
    vi.mocked(ssrfSafeFetch).mockResolvedValue(
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
    );
    // First the "already copied?" probe (empty), then the post-upload prune listing.
    listObjectKeysByPrefix
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        'user/avatar/user-1/provider-old.png',
        'user/avatar/user-1/provider-newer.png',
      ]);

    const result = await materializeProviderAvatar({
      sourceUrl: 'https://cdn.example.com/avatar.png',
      userId: 'user-1',
    });

    expect(deleteFiles).toHaveBeenCalledWith([
      'user/avatar/user-1/provider-old.png',
      'user/avatar/user-1/provider-newer.png',
    ]);
    expect(result).toMatch(/^\/webapi\/user\/avatar\/user-1\/provider-[a-f\d]{64}\.png$/);
  });

  it('gives up on the source URL when the object store never answers', async () => {
    vi.useFakeTimers();
    listObjectKeysByPrefix.mockReturnValue(new Promise(() => {}));
    const sourceUrl = 'https://cdn.example.com/avatar.png';

    const pending = materializeProviderAvatar({ sourceUrl, userId: 'user-1' });
    await vi.advanceTimersByTimeAsync(6000);

    await expect(pending).resolves.toBe(sourceUrl);
    vi.useRealTimers();
  });

  it('still downloads when the store has no object for this source URL', async () => {
    vi.mocked(ssrfSafeFetch).mockResolvedValue(
      new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/png' } }),
    );

    await materializeProviderAvatar({
      currentAvatarUrl: 'https://cdn.example.com/old.png',
      sourceUrl: 'https://cdn.example.com/avatar.png',
      userId: 'user-1',
    });
    expect(ssrfSafeFetch).toHaveBeenCalledTimes(1);
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
  });
});
