import type { S3Client } from '@aws-sdk/client-s3';
import mime from 'mime';
import { z } from 'zod';

import { fileEnv } from '@/envs/file';
import { getInfraSnapshot } from '@/server/enterprise/services/infraSettings/snapshot';
import { YEAR } from '@/utils/units';

import type { ResolvedFileS3Config } from './resolveFileS3Config';
import { DEFAULT_S3_REGION, resolveFileS3Config } from './resolveFileS3Config';

export const fileSchema = z.object({
  Key: z.string(),
  LastModified: z.date(),
  Size: z.number(),
});

export const listFileSchema = z.array(fileSchema);

export type FileType = z.infer<typeof fileSchema>;

const PUBLIC_READ_ACL_HEADER = 'public-read';

export interface PreSignedUpload {
  headers?: Record<string, string>;
  url: string;
}

export class S3 {
  private client?: S3Client;

  private readonly bucket: string;

  private readonly setAcl: boolean;

  private readonly previewUrlExpireIn: number;

  private readonly clientOptions: {
    credentials: { accessKeyId: string; secretAccessKey: string };
    endpoint: string;
    forcePathStyle?: boolean;
    region: string;
    requestChecksumCalculation: 'WHEN_REQUIRED';
    responseChecksumValidation: 'WHEN_REQUIRED';
  };

  constructor(
    accessKeyId: string | undefined,
    secretAccessKey: string | undefined,
    endpoint: string | undefined,
    options?: {
      bucket?: string;
      forcePathStyle?: boolean;
      previewUrlExpireIn?: number;
      region?: string;
      setAcl?: boolean;
    },
  ) {
    if (!accessKeyId || !secretAccessKey || !endpoint)
      throw new Error('S3 environment variables are not set completely, please check your env');
    if (!options?.bucket) throw new Error('S3 bucket is not set, please check your env');

    this.bucket = options?.bucket;
    this.setAcl = options?.setAcl || false;
    this.previewUrlExpireIn = options?.previewUrlExpireIn ?? fileEnv.S3_PREVIEW_URL_EXPIRE_IN;

    this.clientOptions = {
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      endpoint,
      forcePathStyle: options?.forcePathStyle,
      region: options?.region || DEFAULT_S3_REGION,
      // refs: https://github.com/lobehub/lobe-chat/pull/5479
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
  }

  private async ensureClient(): Promise<S3Client> {
    if (this.client) return this.client;
    const { S3Client } = await import('@aws-sdk/client-s3');
    this.client = new S3Client(this.clientOptions);
    return this.client;
  }

  public async deleteFile(key: string) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return (await this.ensureClient()).send(command);
  }

  public async deleteFiles(keys: string[]) {
    const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
    const command = new DeleteObjectsCommand({
      Bucket: this.bucket,
      Delete: { Objects: keys.map((key) => ({ Key: key })) },
    });

    return (await this.ensureClient()).send(command);
  }

  /**
   * List object keys under `prefix` via ListObjectsV2 pagination.
   * Used by document-render artifact cleanup (and similar prefix deletes).
   */
  public async listObjectKeysByPrefix(prefix: string): Promise<string[]> {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = await this.ensureClient();
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ContinuationToken: continuationToken,
          Prefix: prefix,
        }),
      );
      for (const obj of response.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  /**
   * Like {@link listObjectKeysByPrefix} but also returns object sizes.
   * Used by the document-render GC sweep to report artifact totals.
   */
  public async listObjectsByPrefix(prefix: string): Promise<Array<{ key: string; size: number }>> {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = await this.ensureClient();
    const objects: Array<{ key: string; size: number }> = [];
    let continuationToken: string | undefined;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ContinuationToken: continuationToken,
          Prefix: prefix,
        }),
      );
      for (const obj of response.Contents ?? []) {
        if (obj.Key) objects.push({ key: obj.Key, size: obj.Size ?? 0 });
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  /** Server-side copy inside the bucket (document-render sha256 artifact reuse). */
  public async copyObject(sourceKey: string, targetKey: string): Promise<void> {
    const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.ensureClient();
    await client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeURIComponent(sourceKey).replaceAll('%2F', '/')}`,
        Key: targetKey,
      }),
    );
  }

  public async getFileContent(key: string): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await (await this.ensureClient()).send(command);

    if (!response.Body) {
      throw new Error(`No body in response with ${key}`);
    }

    return response.Body.transformToString();
  }

  public async getFileByteArray(key: string): Promise<Uint8Array> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await (await this.ensureClient()).send(command);

    if (!response.Body) {
      throw new Error(`No body in response with ${key}`);
    }

    return response.Body.transformToByteArray();
  }

  /**
   * Get file metadata from S3 using HeadObject
   * This is used to verify actual file size from S3 instead of trusting client-provided values
   */
  public async getFileMetadata(
    key: string,
  ): Promise<{ contentLength: number; contentType?: string }> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await (await this.ensureClient()).send(command);

    return {
      contentLength: response.ContentLength ?? 0,
      contentType: response.ContentType,
    };
  }

  public async createPreSignedUrl(key: string): Promise<string> {
    const upload = await this.createPreSignedUpload(key);
    return upload.url;
  }

  public async createPreSignedUpload(key: string): Promise<PreSignedUpload> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const command = new PutObjectCommand({
      ACL: this.setAcl ? PUBLIC_READ_ACL_HEADER : undefined,
      Bucket: this.bucket,
      Key: key,
    });

    const url = await getSignedUrl(await this.ensureClient(), command, { expiresIn: 3600 });

    return {
      headers: this.setAcl ? { 'x-amz-acl': PUBLIC_READ_ACL_HEADER } : undefined,
      url,
    };
  }

  public async createPreSignedUrlForPreview(key: string, expiresIn?: number): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(await this.ensureClient(), command, {
      expiresIn: expiresIn ?? this.previewUrlExpireIn,
    });
  }

  /**
   * Upload buffer with specified content type
   */
  public async uploadBuffer(
    path: string,
    buffer: Buffer,
    contentType?: string,
    cacheControl?: string,
  ) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const command = new PutObjectCommand({
      ACL: this.setAcl ? 'public-read' : undefined,
      Body: buffer,
      Bucket: this.bucket,
      CacheControl: cacheControl,
      ContentType: contentType,
      Key: path,
    });

    return (await this.ensureClient()).send(command);
  }

  public async uploadContent(path: string, content: string) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const command = new PutObjectCommand({
      ACL: this.setAcl ? 'public-read' : undefined,
      Body: content,
      Bucket: this.bucket,
      Key: path,
    });

    return (await this.ensureClient()).send(command);
  }

  /**
   * Upload media file (images only) with long-term cache
   */
  public async uploadMedia(key: string, buffer: Buffer) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const contentType = mime.getType(key) || 'application/octet-stream';
    const command = new PutObjectCommand({
      ACL: this.setAcl ? 'public-read' : undefined,
      Body: buffer,
      Bucket: this.bucket,
      CacheControl: `public, max-age=${YEAR}`,
      ContentType: contentType,
      Key: key,
    });

    await (await this.ensureClient()).send(command);
  }
}

type CompleteFileS3Config = Extract<ResolvedFileS3Config, { kind: 'complete' }> & {
  previewUrlExpireIn?: number;
};

export class FileS3 extends S3 {
  /** Env-only constructor. Prefer {@link FileS3.create} / {@link createFileS3} for DB-effective config. */
  constructor(resolved?: CompleteFileS3Config) {
    const config = resolved ?? FileS3.resolveEnv();
    super(config.accessKeyId, config.secretAccessKey, config.endpoint, {
      bucket: config.bucket,
      forcePathStyle: config.forcePathStyle,
      previewUrlExpireIn: resolved?.previewUrlExpireIn,
      region: config.region,
      setAcl: config.setAcl,
    });
  }

  private static resolveEnv(): Extract<ResolvedFileS3Config, { kind: 'complete' }> {
    const config = resolveFileS3Config(fileEnv);
    if (config.kind !== 'complete') {
      if (!fileEnv.S3_ACCESS_KEY_ID || !fileEnv.S3_SECRET_ACCESS_KEY || !fileEnv.S3_ENDPOINT) {
        throw new Error('S3 environment variables are not set completely, please check your env');
      }
      throw new Error('S3 bucket is not set, please check your env');
    }
    return config;
  }

  static async create(): Promise<FileS3> {
    return createFileS3();
  }
}

let createFileS3Memo: { fingerprint: string; promise: Promise<FileS3> } | null = null;

const buildFileS3FromSnapshot = async (): Promise<FileS3> => {
  try {
    const snapshot = await getInfraSnapshot();
    if (snapshot.objectStorage.kind === 'complete') {
      return new FileS3({
        ...snapshot.objectStorage,
        previewUrlExpireIn: snapshot.objectStorage.previewUrlExpireIn,
      });
    }
  } catch {
    // Fail open to env — FileS3 ctor throws the same errors as before.
  }
  return new FileS3();
};

/** Async factory: DB-effective object storage when configured, otherwise env. */
export const createFileS3 = async (): Promise<FileS3> => {
  const fingerprint = await getInfraSnapshot()
    .then((snapshot) => snapshot.fingerprint)
    .catch(() => 'env');
  if (createFileS3Memo?.fingerprint === fingerprint) return createFileS3Memo.promise;

  const promise = buildFileS3FromSnapshot().catch((error) => {
    if (createFileS3Memo?.promise === promise) createFileS3Memo = null;
    throw error;
  });
  createFileS3Memo = { fingerprint, promise };
  return promise;
};

export const resetCreateFileS3ForTest = (): void => {
  createFileS3Memo = null;
};
