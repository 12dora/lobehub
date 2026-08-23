import { createHash } from 'node:crypto';

import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import debug from 'debug';

import { findUserAvatarByPrefix, uploadUserAvatar } from './avatar';

const log = debug('lobe-server:auth:provider-avatar');

const PROVIDER_AVATAR_PREFIX = 'provider-';
const PROVIDER_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const PROVIDER_AVATAR_TIMEOUT_MS = 3000;

/**
 * Raster formats only. An SVG is a script-bearing document and this store is served from the app's
 * own origin, so a provider-controlled SVG stays external rather than becoming same-origin content.
 */
const IMAGE_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/tiff': 'tiff',
  'image/vnd.microsoft.icon': 'ico',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
};

interface MaterializeProviderAvatarParams {
  currentAvatarUrl?: string | null;
  sourceUrl: string;
  userId: string;
}

const getProviderAvatarHash = (sourceUrl: string) =>
  createHash('sha256').update(sourceUrl).digest('hex');

const getProviderAvatarFileNamePrefix = (sourceUrl: string) =>
  `${PROVIDER_AVATAR_PREFIX}${getProviderAvatarHash(sourceUrl)}.`;

const getProviderAvatarWebapiPrefix = (userId: string, sourceUrl: string) =>
  `/webapi/user/avatar/${userId}/${getProviderAvatarFileNamePrefix(sourceUrl)}`;

/**
 * Copies an external identity-provider avatar into the immutable local avatar store.
 * Every failure is best-effort: authentication must continue with the original URL.
 */
export const materializeProviderAvatar = async ({
  currentAvatarUrl,
  sourceUrl,
  userId,
}: MaterializeProviderAvatarParams): Promise<string> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    return sourceUrl;
  }

  if (parsedUrl.protocol !== 'https:') {
    if (parsedUrl.protocol === 'http:') {
      log('Refused non-HTTPS provider avatar for userId=%s', userId);
    }
    return sourceUrl;
  }

  const expectedAvatarPrefix = getProviderAvatarWebapiPrefix(userId, sourceUrl);
  if (currentAvatarUrl?.startsWith(expectedAvatarPrefix)) return currentAvatarUrl;

  try {
    // An SSO login with `overrideUserInfo` rewrites the row with the provider URL every time, so
    // the stored value cannot answer "already copied?". The deterministic object name can.
    const stored = await findUserAvatarByPrefix(userId, getProviderAvatarFileNamePrefix(sourceUrl));
    if (stored) return stored;
  } catch (error) {
    log('Failed to look up an existing provider avatar for userId=%s: %O', userId, error);
  }

  try {
    const response = await ssrfSafeFetch(
      sourceUrl,
      { signal: AbortSignal.timeout(PROVIDER_AVATAR_TIMEOUT_MS) },
      {
        allowIPAddressList: [],
        allowPrivateIPAddress: false,
        maxContentLength: PROVIDER_AVATAR_MAX_BYTES + 1,
        redactErrors: true,
      },
    );
    if (!response.ok) throw new Error(`Provider avatar returned HTTP ${response.status}`);

    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (!mimeType?.startsWith('image/')) {
      throw new Error('Provider avatar response is not an image');
    }

    const extension = IMAGE_EXTENSION_BY_CONTENT_TYPE[mimeType];
    if (!extension) throw new Error(`Unsupported provider avatar content type: ${mimeType}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > PROVIDER_AVATAR_MAX_BYTES) {
      throw new Error('Provider avatar exceeds the maximum size');
    }

    return await uploadUserAvatar({
      buffer,
      fileName: `${getProviderAvatarFileNamePrefix(sourceUrl)}${extension}`,
      mimeType,
      userId,
    });
  } catch (error) {
    log('Failed to materialize provider avatar for userId=%s: %O', userId, error);
    return sourceUrl;
  }
};
