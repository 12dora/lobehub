import { type LobeChatDatabase } from '@lobechat/database';
import debug from 'debug';

import { FileModel } from '@/database/models/file';
import { fileEnv } from '@/envs/file';
import { getRedisConfig } from '@/envs/redis';
import { initializeRedis, isRedisEnabled } from '@/libs/redis';
import { getInfraSnapshot } from '@/server/enterprise/services/infraSettings/snapshot';
import { createFileS3, FileS3 } from '@/server/modules/S3';

import { buildPublicFileUrl, extractKeyFromS3Pathname, type S3PublicUrlConfig } from './s3Url';
import type { FileServiceImpl, PreSignedUpload } from './type';

const log = debug('lobe-file:s3');

const PRESIGNED_PREVIEW_CACHE_SAFETY_SECONDS = 60;
const PRESIGNED_PREVIEW_CACHE_MAX_SECONDS = 3600;
const PRESIGNED_PREVIEW_CACHE_KEY_PREFIX = 'file:presigned-preview:';

interface PresignedPreviewCacheEntry {
  expiresAt: number;
  url: string;
}

const presignedPreviewUrlCache = new Map<string, PresignedPreviewCacheEntry>();

const createPresignedPreviewCacheKey = (key: string, expiresIn: number, fingerprint: string) =>
  `${PRESIGNED_PREVIEW_CACHE_KEY_PREFIX}${fingerprint}:${expiresIn}:${key}`;

const getPresignedPreviewCacheTtlSeconds = (expiresInSeconds: number) =>
  Math.min(
    Math.max(expiresInSeconds - PRESIGNED_PREVIEW_CACHE_SAFETY_SECONDS, 0),
    PRESIGNED_PREVIEW_CACHE_MAX_SECONDS,
  );

/**
 * S3-based file service implementation
 */
export class S3StaticFileImpl implements FileServiceImpl {
  private _s3?: FileS3;
  private s3Fingerprint?: string;
  private readonly db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  /** Sync accessor for tests / env fallback. Production methods go through {@link getS3}. */
  private get s3(): FileS3 {
    this._s3 ??= new FileS3();
    return this._s3;
  }

  private async getS3(): Promise<FileS3> {
    const fingerprint = await this.getFingerprint();
    if (this._s3 && this.s3Fingerprint === fingerprint) return this._s3;
    try {
      this._s3 = await createFileS3();
      this.s3Fingerprint = fingerprint;
    } catch (error) {
      this._s3 = undefined;
      this.s3Fingerprint = undefined;
      throw error;
    }
    return this._s3;
  }

  private async getFingerprint(): Promise<string> {
    try {
      return (await getInfraSnapshot()).fingerprint;
    } catch {
      return 'env';
    }
  }

  private async getUrlConfig(): Promise<
    S3PublicUrlConfig & { fingerprint: string; previewUrlExpireIn: number }
  > {
    try {
      const snapshot = await getInfraSnapshot();
      if (snapshot.objectStorage.kind === 'complete') {
        return {
          bucket: snapshot.objectStorage.bucket,
          fingerprint: snapshot.fingerprint,
          forcePathStyle: snapshot.objectStorage.forcePathStyle,
          previewUrlExpireIn: snapshot.objectStorage.previewUrlExpireIn,
          publicDomain: snapshot.objectStorage.publicDomain,
          setAcl: snapshot.objectStorage.setAcl,
        };
      }
      return {
        bucket: fileEnv.S3_BUCKET,
        fingerprint: snapshot.fingerprint,
        forcePathStyle: fileEnv.S3_ENABLE_PATH_STYLE,
        previewUrlExpireIn: fileEnv.S3_PREVIEW_URL_EXPIRE_IN,
        publicDomain: fileEnv.S3_PUBLIC_DOMAIN,
        setAcl: fileEnv.S3_SET_ACL,
      };
    } catch {
      return {
        bucket: fileEnv.S3_BUCKET,
        fingerprint: 'env',
        forcePathStyle: fileEnv.S3_ENABLE_PATH_STYLE,
        previewUrlExpireIn: fileEnv.S3_PREVIEW_URL_EXPIRE_IN,
        publicDomain: fileEnv.S3_PUBLIC_DOMAIN,
        setAcl: fileEnv.S3_SET_ACL,
      };
    }
  }

  async deleteFile(key: string) {
    return (await this.getS3()).deleteFile(key);
  }

  async deleteFiles(keys: string[]) {
    return (await this.getS3()).deleteFiles(keys);
  }

  async getFileContent(key: string): Promise<string> {
    return (await this.getS3()).getFileContent(key);
  }

  async getFileByteArray(key: string): Promise<Uint8Array> {
    return (await this.getS3()).getFileByteArray(key);
  }

  async createPreSignedUrl(key: string): Promise<string> {
    return (await this.getS3()).createPreSignedUrl(key);
  }

  async createPreSignedUpload(key: string): Promise<PreSignedUpload> {
    return (await this.getS3()).createPreSignedUpload(key);
  }

  async getFileMetadata(key: string): Promise<{ contentLength: number; contentType?: string }> {
    return (await this.getS3()).getFileMetadata(key);
  }

  async createPreSignedUrlForPreview(key: string, expiresIn?: number): Promise<string> {
    return (await this.getS3()).createPreSignedUrlForPreview(key, expiresIn);
  }

  private async getStorageKeyFromUrl(url: string): Promise<string> {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return url;

    const extractedKey = await this.getKeyFromFullUrl(url);
    if (!extractedKey) {
      throw new Error('Key not found from url: ' + url);
    }

    return extractedKey;
  }

  private async getCachedPreSignedUrlForPreview(key: string, expiresIn?: number): Promise<string> {
    const urlConfig = await this.getUrlConfig();
    const expiresInSeconds = expiresIn ?? urlConfig.previewUrlExpireIn;
    const cacheKey = createPresignedPreviewCacheKey(key, expiresInSeconds, urlConfig.fingerprint);
    const ttlSeconds = getPresignedPreviewCacheTtlSeconds(expiresInSeconds);
    const now = Date.now();
    const cached = presignedPreviewUrlCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.url;
    }

    try {
      const redisConfig = getRedisConfig();
      const redis = isRedisEnabled(redisConfig) ? await initializeRedis(redisConfig) : null;
      const cachedUrl = await redis?.get(cacheKey);

      if (cachedUrl) {
        if (ttlSeconds > 0) {
          presignedPreviewUrlCache.set(cacheKey, {
            expiresAt: now + ttlSeconds * 1000,
            url: cachedUrl,
          });
        }

        return cachedUrl;
      }
    } catch (error) {
      log('Failed to read presigned preview URL cache from Redis: %O', error);
    }

    const url = await this.createPreSignedUrlForPreview(key, expiresIn);

    if (ttlSeconds > 0) {
      presignedPreviewUrlCache.set(cacheKey, {
        expiresAt: now + ttlSeconds * 1000,
        url,
      });

      try {
        const redisConfig = getRedisConfig();
        const redis = isRedisEnabled(redisConfig) ? await initializeRedis(redisConfig) : null;
        await redis?.set(cacheKey, url, { ex: ttlSeconds });
      } catch (error) {
        log('Failed to write presigned preview URL cache to Redis: %O', error);
      }
    }

    return url;
  }

  async createCachedPreSignedUrlForPreview(
    url?: string | null,
    expiresIn?: number,
  ): Promise<string> {
    if (!url) return '';

    const key = await this.getStorageKeyFromUrl(url);

    return await this.getCachedPreSignedUrlForPreview(key, expiresIn);
  }

  async uploadContent(path: string, content: string) {
    return (await this.getS3()).uploadContent(path, content);
  }

  async getFullFileUrl(url?: string | null, expiresIn?: number): Promise<string> {
    if (!url) return '';

    const key = await this.getStorageKeyFromUrl(url);

    // If bucket is not set public read, or S3_PUBLIC_DOMAIN is not configured,
    // reuse the same presigned preview URL briefly so repeated chat turns keep
    // stable media URLs and can reuse provider-side prefix caches.
    const publicUrl = buildPublicFileUrl(key, await this.getUrlConfig());
    if (!publicUrl) {
      return await this.getCachedPreSignedUrlForPreview(key, expiresIn);
    }

    return publicUrl;
  }

  async getKeyFromFullUrl(url: string): Promise<string | null> {
    try {
      const urlObject = new URL(url);
      const { pathname } = urlObject;

      // Case 1: File proxy URL pattern /f/{fileId} - query database for S3 key
      if (pathname.startsWith('/f/')) {
        const fileId = pathname.slice(3); // Remove '/f/' prefix
        const file = await FileModel.getFileById(this.db, fileId);
        return file?.url ?? null;
      }

      // Case 2: Legacy S3 URL - extract key from pathname
      const urlConfig = await this.getUrlConfig();
      return extractKeyFromS3Pathname(pathname, urlConfig);
    } catch {
      // If url is not a valid URL, return null
      return null;
    }
  }

  async uploadMedia(key: string, buffer: Buffer): Promise<{ key: string }> {
    await (await this.getS3()).uploadMedia(key, buffer);
    return { key };
  }

  async uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType: string,
    cacheControl?: string,
  ): Promise<{ key: string }> {
    const s3 = await this.getS3();
    if (cacheControl) await s3.uploadBuffer(key, buffer, contentType, cacheControl);
    else await s3.uploadBuffer(key, buffer, contentType);
    return { key };
  }

  async listObjectKeysByPrefix(prefix: string): Promise<string[]> {
    return (await this.getS3()).listObjectKeysByPrefix(prefix);
  }
}
