import { Buffer } from 'buffer.js';

import { resolveMimeTypeFromBytes } from './imageMimeType';
import { isOwnDeploymentFileUrl, resolveOwnDeploymentFetchUrl } from './url';

/** Codex and other remote vision APIs cannot fetch our file URLs; cap inlined image bytes. */
export const DEFAULT_IMAGE_INLINE_MAX_BYTES = 20 * 1024 * 1024;

/** Responses `input_file` / document inlining cap (GPT-5.6 file_data). */
export const DEFAULT_FILE_INLINE_MAX_BYTES = 32 * 1024 * 1024;

export class AttachmentInlineLimitError extends Error {
  readonly byteLength: number;
  readonly maxBytes: number;

  constructor(maxBytes: number, byteLength: number) {
    super(`Attachment exceeds the ${maxBytes} byte inlining limit`);
    this.name = 'AttachmentInlineLimitError';
    this.byteLength = byteLength;
    this.maxBytes = maxBytes;
  }
}

export interface ImageUrlToBase64Options {
  maxBytes?: number;
}

export const imageToBase64 = ({
  size,
  img,
  type = 'image/webp',
}: {
  img: HTMLImageElement;
  size: number;
  type?: string;
}) => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  let startX = 0;
  let startY = 0;

  if (img.width > img.height) {
    startX = (img.width - img.height) / 2;
  } else {
    startY = (img.height - img.width) / 2;
  }

  canvas.width = size;
  canvas.height = size;

  ctx.drawImage(
    img,
    startX,
    startY,
    Math.min(img.width, img.height),
    Math.min(img.width, img.height),
    0,
    0,
    size,
    size,
  );

  return canvas.toDataURL(type);
};

/**
 * Convert image URL to base64
 * Uses SSRF-safe fetch on server-side to prevent SSRF attacks.
 * Own-deployment hosts (localhost, APP_URL, S3) are allowed so providers that
 * cannot fetch our file URLs can still inline them. Arbitrary private IPs stay blocked.
 */
export const imageUrlToBase64 = async (
  imageUrl: string,
  options?: ImageUrlToBase64Options,
): Promise<{ base64: string; mimeType: string }> => {
  const maxBytes = options?.maxBytes ?? DEFAULT_IMAGE_INLINE_MAX_BYTES;

  try {
    const isServer = typeof window === 'undefined';
    const fetchUrl = resolveOwnDeploymentFetchUrl(imageUrl);

    // Use SSRF-safe fetch on server-side to prevent SSRF attacks
    const res = isServer
      ? await import('@lobechat/ssrf-safe-fetch').then((m) =>
          m.ssrfSafeFetch(
            fetchUrl,
            {},
            {
              allowPrivateIPAddress: isOwnDeploymentFileUrl(fetchUrl),
              maxContentLength: maxBytes + 1,
            },
          ),
        )
      : await fetch(fetchUrl);

    const blob = await res.blob();
    const arrayBuffer = await blob.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new AttachmentInlineLimitError(maxBytes, arrayBuffer.byteLength);
    }
    const mimeType = await resolveMimeTypeFromBytes(blob.type, arrayBuffer);

    // Client-side uses btoa, server-side uses Buffer
    const base64 = isServer
      ? Buffer.from(arrayBuffer).toString('base64')
      : btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
        );

    return { base64, mimeType };
  } catch (error) {
    if (!(error instanceof AttachmentInlineLimitError)) {
      console.error('Error converting image to base64:', error);
    }
    throw error;
  }
};
