import { createHash } from 'node:crypto';

import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import debug from 'debug';

import { findUserAvatarByPrefix, pruneUserAvatars, uploadUserAvatar } from './avatar';

const log = debug('lobe-server:auth:provider-avatar');

const PROVIDER_AVATAR_PREFIX = 'provider-';
const PROVIDER_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const PROVIDER_AVATAR_TIMEOUT_MS = 3000;
/**
 * Ceiling for the whole copy — the object-store LIST/PUT have no deadline of their own, and this
 * runs inside the SSO callback. A blackholed bucket must cost a login this much and no more.
 */
const PROVIDER_AVATAR_BUDGET_MS = 6000;

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

const copyProviderAvatar = async ({
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

    const avatarUrl = await uploadUserAvatar({
      buffer,
      fileName: `${getProviderAvatarFileNamePrefix(sourceUrl)}${extension}`,
      mimeType,
      userId,
    });

    try {
      await pruneUserAvatars(userId, PROVIDER_AVATAR_PREFIX, avatarUrl);
    } catch (error) {
      log('Failed to prune superseded provider avatars for userId=%s: %O', userId, error);
    }

    return avatarUrl;
  } catch (error) {
    log('Failed to materialize provider avatar for userId=%s: %O', userId, error);
    return sourceUrl;
  }
};

/**
 * Copies an external identity-provider avatar into the immutable local avatar store.
 * Every failure is best-effort: authentication must continue with the original URL, and the whole
 * copy is bounded so a stalled provider or object store cannot hold an SSO login open.
 */
export const materializeProviderAvatar = async (
  params: MaterializeProviderAvatarParams,
): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      log('Provider avatar copy exceeded its budget for userId=%s', params.userId);
      resolve(params.sourceUrl);
    }, PROVIDER_AVATAR_BUDGET_MS);
  });

  try {
    return await Promise.race([copyProviderAvatar(params), budget]);
  } finally {
    clearTimeout(timer);
  }
};
