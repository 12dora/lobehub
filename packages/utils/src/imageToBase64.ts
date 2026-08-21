import { Buffer } from 'buffer.js';
import debug from 'debug';

import { resolveMimeTypeFromBytes } from './imageMimeType';
import { isOwnDeploymentFileUrl, resolveOwnDeploymentFetchUrl, sanitizedUrlHost } from './url';

const log = debug('lobe-utils:imageToBase64');

/** Codex chat image inlining cap. Callers must pass this explicitly as `maxBytes`. */
export const DEFAULT_IMAGE_INLINE_MAX_BYTES = 20 * 1024 * 1024;

/** Responses `input_file` / document inlining cap. Callers must pass this explicitly. */
export const DEFAULT_FILE_INLINE_MAX_BYTES = 32 * 1024 * 1024;

const OWN_ORIGIN_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

export class AttachmentFetchError extends Error {
  readonly status?: number;

  constructor(host: string, status?: number) {
    super(
      status === undefined
        ? `failed to download attachment from ${host}`
        : `failed to download attachment from ${host}: status=${status}`,
    );
    this.name = 'AttachmentFetchError';
    this.status = status;
  }
}

export interface ImageUrlToBase64Options {
  maxBytes?: number;
  /**
   * Fail closed unless the URL (and every redirect) is an allowlisted
   * deployment file origin + file route. ChatGPT/Codex must pass this.
   */
  ownOriginOnly?: boolean;
}

/**
 * Padding-aware decoded byte length of a base64 payload. Does not allocate the
 * decoded buffer. `length/4 > limit/3` is wrong at limits not divisible by 3.
 */
export const decodedBase64ByteLength = (base64: string): number => {
  const compact = base64.replaceAll(/\s/g, '');
  if (!compact) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return (compact.length * 3) / 4 - padding;
};

export const assertDecodedBase64WithinLimit = (base64: string, maxBytes: number): void => {
  const byteLength = decodedBase64ByteLength(base64);
  if (byteLength > maxBytes) {
    throw new AttachmentInlineLimitError(maxBytes, byteLength);
  }
};

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

const isRedirect = (status: number): boolean => REDIRECT_STATUSES.has(status);

const fetchAttachment = async (
  imageUrl: string,
  options: ImageUrlToBase64Options | undefined,
  isServer: boolean,
): Promise<Response> => {
  const ownOriginOnly = options?.ownOriginOnly === true;
  const maxBytes = options?.maxBytes;
  const ssrfOptions = {
    ...(ownOriginOnly ? { allowPrivateIPAddress: true, maxRedirects: 0 } : {}),
    ...(maxBytes !== undefined ? { maxContentLength: maxBytes + 1 } : {}),
  };
  const requestInit: RequestInit | undefined = ownOriginOnly ? { redirect: 'manual' } : undefined;
  const hasSsrfOptions = Object.keys(ssrfOptions).length > 0;

  if (isServer) {
    const { ssrfSafeFetch } = await import('@lobechat/ssrf-safe-fetch');
    return ssrfSafeFetch(imageUrl, requestInit ?? {}, hasSsrfOptions ? ssrfOptions : undefined);
  }

  return requestInit ? fetch(imageUrl, requestInit) : fetch(imageUrl);
};

const resolveRedirectLocation = (currentUrl: string, response: Response): string => {
  const location = response.headers.get('location');
  if (!location) {
    throw new AttachmentFetchError(sanitizedUrlHost(currentUrl), response.status);
  }
  return new URL(location, currentUrl).href;
};

/**
 * Convert image URL to base64.
 * Uses SSRF-safe fetch on server-side. Defaults match the historical helper:
 * no size cap, `SSRF_ALLOW_PRIVATE_IP_ADDRESS` honored, no own-origin rewrite.
 * ChatGPT callers pass `{ maxBytes, ownOriginOnly: true }`.
 */
export const imageUrlToBase64 = async (
  imageUrl: string,
  options?: ImageUrlToBase64Options,
): Promise<{ base64: string; mimeType: string }> => {
  const ownOriginOnly = options?.ownOriginOnly === true;
  const maxBytes = options?.maxBytes;
  const isServer = typeof window === 'undefined';

  try {
    let currentUrl = ownOriginOnly ? resolveOwnDeploymentFetchUrl(imageUrl) : imageUrl;

    let res: Response | undefined;
    for (let hop = 0; hop <= OWN_ORIGIN_MAX_REDIRECTS; hop += 1) {
      if (ownOriginOnly && !isOwnDeploymentFileUrl(currentUrl)) {
        throw new AttachmentFetchError(sanitizedUrlHost(currentUrl));
      }

      res = await fetchAttachment(currentUrl, options, isServer);

      if (ownOriginOnly && isRedirect(res.status)) {
        currentUrl = resolveRedirectLocation(currentUrl, res);
        continue;
      }
      break;
    }

    if (!res || (ownOriginOnly && isRedirect(res.status))) {
      throw new AttachmentFetchError(sanitizedUrlHost(currentUrl));
    }

    if (!res.ok) {
      throw new AttachmentFetchError(sanitizedUrlHost(currentUrl), res.status);
    }

    const blob = await res.blob();
    const arrayBuffer = await blob.arrayBuffer();
    if (maxBytes !== undefined && arrayBuffer.byteLength > maxBytes) {
      throw new AttachmentInlineLimitError(maxBytes, arrayBuffer.byteLength);
    }
    const mimeType = await resolveMimeTypeFromBytes(blob.type, arrayBuffer);

    const base64 = isServer
      ? Buffer.from(arrayBuffer).toString('base64')
      : btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
        );

    return { base64, mimeType };
  } catch (error) {
    const host = sanitizedUrlHost(imageUrl);
    const name = error instanceof Error ? error.name : 'Error';
    const status = error instanceof AttachmentFetchError ? error.status : undefined;
    log('inline failed: host=%s error=%s status=%s', host, name, status ?? '-');
    throw error;
  }
};
