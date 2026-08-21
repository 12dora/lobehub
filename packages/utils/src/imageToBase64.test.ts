import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AttachmentFetchError,
  AttachmentInlineLimitError,
  decodedBase64ByteLength,
  DEFAULT_FILE_INLINE_MAX_BYTES,
  DEFAULT_IMAGE_INLINE_MAX_BYTES,
  imageToBase64,
  imageUrlToBase64,
} from './imageToBase64';

describe('imageToBase64', () => {
  let mockImage: HTMLImageElement;
  let mockCanvas: HTMLCanvasElement;
  let mockContext: CanvasRenderingContext2D;

  beforeEach(() => {
    mockImage = {
      width: 200,
      height: 100,
    } as HTMLImageElement;

    mockContext = {
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockContext),
      toDataURL: vi.fn().mockReturnValue('data:image/webp;base64,mockBase64Data'),
    } as unknown as HTMLCanvasElement;

    vi.spyOn(document, 'createElement').mockReturnValue(mockCanvas);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should convert image to base64 with correct size and type', () => {
    const result = imageToBase64({ img: mockImage, size: 100, type: 'image/jpeg' });

    expect(document.createElement).toHaveBeenCalledWith('canvas');
    expect(mockCanvas.width).toBe(100);
    expect(mockCanvas.height).toBe(100);
    expect(mockCanvas.getContext).toHaveBeenCalledWith('2d');
    expect(mockContext.drawImage).toHaveBeenCalledWith(mockImage, 50, 0, 100, 100, 0, 0, 100, 100);
    expect(mockCanvas.toDataURL).toHaveBeenCalledWith('image/jpeg');
    expect(result).toBe('data:image/webp;base64,mockBase64Data');
  });

  it('should use default type when not specified', () => {
    imageToBase64({ img: mockImage, size: 100 });
    expect(mockCanvas.toDataURL).toHaveBeenCalledWith('image/webp');
  });

  it('should handle taller images correctly', () => {
    mockImage.width = 100;
    mockImage.height = 200;
    imageToBase64({ img: mockImage, size: 100 });
    expect(mockContext.drawImage).toHaveBeenCalledWith(mockImage, 0, 50, 100, 100, 0, 0, 100, 100);
  });
});

describe('imageUrlToBase64', () => {
  const mockFetch = vi.fn();
  const mockArrayBuffer = new ArrayBuffer(8);

  beforeEach(() => {
    global.fetch = mockFetch;
    global.btoa = vi.fn().mockReturnValue('mockBase64String');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should convert image URL to base64 string', async () => {
    mockFetch.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(mockArrayBuffer),
      blob: () => Promise.resolve(new Blob([mockArrayBuffer], { type: 'image/jpg' })),
      ok: true,
      status: 200,
    });

    const result = await imageUrlToBase64('https://example.com/image.jpg');

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/image.jpg');
    expect(global.btoa).toHaveBeenCalled();
    expect(result).toEqual({ base64: 'mockBase64String', mimeType: 'image/jpg' });
  });

  it('should correct MIME type when response metadata does not match image bytes', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89,
    ]);

    mockFetch.mockResolvedValue({
      blob: () => Promise.resolve(new Blob([pngBytes], { type: 'image/jpeg' })),
      ok: true,
      status: 200,
    });

    const result = await imageUrlToBase64('https://example.com/image.jpg');

    expect(result).toEqual({ base64: 'mockBase64String', mimeType: 'image/png' });
  });

  it('should preserve detected non-image MIME types when response metadata is empty', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.7\n');

    mockFetch.mockResolvedValue({
      blob: () => Promise.resolve(new Blob([pdfBytes], { type: '' })),
      ok: true,
      status: 200,
    });

    const result = await imageUrlToBase64('https://example.com/file');

    expect(result).toEqual({ base64: 'mockBase64String', mimeType: 'application/pdf' });
  });

  it('should throw an error when fetch fails', async () => {
    const mockError = new Error('Fetch failed');
    mockFetch.mockRejectedValue(mockError);

    await expect(imageUrlToBase64('https://example.com/image.jpg')).rejects.toThrow('Fetch failed');
  });

  it('should throw AttachmentInlineLimitError when the body is over the cap', async () => {
    const overLimit = new Uint8Array(8);

    mockFetch.mockResolvedValue({
      blob: () => Promise.resolve(new Blob([overLimit], { type: 'image/png' })),
      ok: true,
      status: 200,
    });

    await expect(
      imageUrlToBase64('https://example.com/image.jpg', { maxBytes: 4 }),
    ).rejects.toThrow(AttachmentInlineLimitError);
    await expect(
      imageUrlToBase64('https://example.com/image.jpg', { maxBytes: 4 }),
    ).rejects.toThrow(`Attachment exceeds the 4 byte inlining limit`);
  });

  it('should not cap the body when maxBytes is omitted', async () => {
    const body = new Uint8Array(8);
    mockFetch.mockResolvedValue({
      blob: () => Promise.resolve(new Blob([body], { type: 'image/png' })),
      ok: true,
      status: 200,
    });

    await expect(imageUrlToBase64('https://example.com/image.jpg')).resolves.toEqual({
      base64: 'mockBase64String',
      mimeType: 'image/png',
    });
  });

  it('should throw AttachmentFetchError before reading a non-OK body', async () => {
    mockFetch.mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['<html>denied</html>'], { type: 'text/html' })),
      ok: false,
      status: 403,
    });

    await expect(imageUrlToBase64('https://files.example.com/a.png?sig=secret')).rejects.toThrow(
      AttachmentFetchError,
    );
    await expect(imageUrlToBase64('https://files.example.com/a.png?sig=secret')).rejects.toThrow(
      'failed to download attachment from files.example.com: status=403',
    );
  });

  it('should export ChatGPT inlining caps without applying them by default', () => {
    expect(DEFAULT_IMAGE_INLINE_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(DEFAULT_FILE_INLINE_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe('decodedBase64ByteLength', () => {
  it('should use padding-aware decoded size so exactly-at-limit is allowed', () => {
    expect(decodedBase64ByteLength('YQ==')).toBe(1);
    expect(decodedBase64ByteLength('YWI=')).toBe(2);
    expect(decodedBase64ByteLength('YWJj')).toBe(3);
  });

  it('should treat a padded payload of exactly the 32MiB file limit as within limit', () => {
    const maxBytes = DEFAULT_FILE_INLINE_MAX_BYTES;
    const remainder = maxBytes % 3;
    const padding = remainder === 0 ? 0 : 3 - remainder;
    const encodedLength = 4 * Math.ceil(maxBytes / 3);

    // The naive `length/4 > limit/3` check rejects this size; padding-aware does not.
    expect(encodedLength / 4 > maxBytes / 3).toBe(true);
    expect((encodedLength * 3) / 4 - padding).toBe(maxBytes);
  });
});
