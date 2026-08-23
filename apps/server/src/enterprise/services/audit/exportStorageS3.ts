/**
 * Production private S3 adapter for admin audit export artifacts.
 * Does not use FileS3 (which may set public-read when S3_SET_ACL=true).
 */

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { fileEnv } from '@/envs/file';
import {
  getInfraSnapshot,
  peekInfraSnapshot,
} from '@/server/enterprise/services/infraSettings/snapshot';
import { S3 } from '@/server/modules/S3';

import { formatArtifactChecksum, hashAsyncIterable, sha256Hex } from './exportStorageHash';
import { AUDIT_EXPORT_CONTENT_TYPE, isAuditExportAttemptsPrefix } from './exportStorageKeys';
import type {
  AuditExportArtifactStorage,
  AuditExportObjectHash,
  AuditExportObjectMetadata,
  AuditExportUploadBody,
  AuditExportUploadResult,
} from './exportStorageTypes';

/**
 * S3 constructor options for audit export artifacts.
 * Always private (setAcl:false) — never inherits global S3_SET_ACL public-read.
 * Exported for focused construction/privacy tests without requiring live S3.
 */
export const buildPrivateAuditExportS3Options = (): {
  bucket: string | undefined;
  forcePathStyle: boolean | undefined;
  region: string | undefined;
  setAcl: false;
} => {
  const peeked = peekInfraSnapshot();
  if (peeked?.objectStorage.kind === 'complete') {
    return {
      bucket: peeked.objectStorage.bucket,
      forcePathStyle: peeked.objectStorage.forcePathStyle,
      region: peeked.objectStorage.region,
      setAcl: false,
    };
  }
  return {
    bucket: fileEnv.S3_BUCKET,
    forcePathStyle: fileEnv.S3_ENABLE_PATH_STYLE,
    region: fileEnv.S3_REGION,
    setAcl: false,
  };
};

/** Create the dedicated private S3 client used for audit export artifacts. */
export const createPrivateAuditExportS3 = async (): Promise<S3> => {
  const snapshot = await getInfraSnapshot();
  if (snapshot.objectStorage.kind === 'complete') {
    const config = snapshot.objectStorage;
    return new S3(config.accessKeyId, config.secretAccessKey, config.endpoint, {
      bucket: config.bucket,
      forcePathStyle: config.forcePathStyle,
      region: config.region,
      setAcl: false,
    });
  }
  return new S3(fileEnv.S3_ACCESS_KEY_ID, fileEnv.S3_SECRET_ACCESS_KEY, fileEnv.S3_ENDPOINT, {
    ...buildPrivateAuditExportS3Options(),
  });
};

/** Streaming S3 client (private ACL) for Put/Get without full buffering (F10). */
const createPrivateAuditExportS3Client = async (): Promise<{
  bucket: string;
  client: S3Client;
}> => {
  const snapshot = await getInfraSnapshot();
  if (snapshot.objectStorage.kind === 'complete') {
    const config = snapshot.objectStorage;
    return {
      bucket: config.bucket,
      client: new S3Client({
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        region: config.region,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      }),
    };
  }
  const accessKeyId = fileEnv.S3_ACCESS_KEY_ID;
  const secretAccessKey = fileEnv.S3_SECRET_ACCESS_KEY;
  const endpoint = fileEnv.S3_ENDPOINT;
  const bucket = fileEnv.S3_BUCKET;
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    throw new Error('S3 environment variables are not set completely, please check your env');
  }
  return {
    bucket,
    client: new S3Client({
      credentials: { accessKeyId, secretAccessKey },
      endpoint,
      forcePathStyle: fileEnv.S3_ENABLE_PATH_STYLE,
      region: fileEnv.S3_REGION || 'us-east-1',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  };
};

/**
 * Production private S3-backed storage for audit export artifacts.
 * Does not use FileS3 (which may set public-read when S3_SET_ACL=true).
 */
export class AuditExportPrivateS3Storage implements AuditExportArtifactStorage {
  private readonly injectedS3?: S3;
  private s3Memo: { fingerprint: string; promise: Promise<S3> } | null = null;
  /** Test injection + last built streaming client. */
  private streamBackend: { bucket: string; client: S3Client } | null = null;
  private streamMemoFingerprint: string | null = null;

  constructor(s3?: S3) {
    this.injectedS3 = s3;
  }

  /** Test/introspection: whether this adapter will ever request a public ACL. */
  static readonly enforcesPrivateAcl = true as const;

  private getFingerprint = async (): Promise<string> => {
    try {
      return (await getInfraSnapshot()).fingerprint;
    } catch {
      return 'env';
    }
  };

  private getS3 = async (): Promise<S3> => {
    if (this.injectedS3) return this.injectedS3;
    const fingerprint = await this.getFingerprint();
    if (this.s3Memo?.fingerprint === fingerprint) return this.s3Memo.promise;
    const promise = createPrivateAuditExportS3().catch((error) => {
      if (this.s3Memo?.promise === promise) this.s3Memo = null;
      throw error;
    });
    this.s3Memo = { fingerprint, promise };
    return promise;
  };

  private getStreamBackend = async (): Promise<{ bucket: string; client: S3Client }> => {
    // Test-injected backend has no fingerprint — do not touch the snapshot.
    if (this.streamBackend && this.streamMemoFingerprint === null) {
      return this.streamBackend;
    }
    const fingerprint = await this.getFingerprint();
    if (this.streamBackend && this.streamMemoFingerprint === fingerprint) {
      return this.streamBackend;
    }
    const backend = await createPrivateAuditExportS3Client();
    this.streamBackend = backend;
    this.streamMemoFingerprint = fingerprint;
    return backend;
  };

  uploadArtifact = async (params: {
    artifactChecksum?: string;
    body: AuditExportUploadBody;
    contentLength?: number;
    contentType?: string;
    storageKey: string;
  }): Promise<AuditExportUploadResult> => {
    const contentType = params.contentType ?? AUDIT_EXPORT_CONTENT_TYPE;

    if (Buffer.isBuffer(params.body)) {
      const checksum = params.artifactChecksum ?? formatArtifactChecksum(sha256Hex(params.body));
      await (await this.getS3()).uploadBuffer(params.storageKey, params.body, contentType);
      return {
        artifactBytes: params.body.byteLength,
        artifactChecksum: formatArtifactChecksum(checksum),
        storageKey: params.storageKey,
      };
    }

    // Stream path: pipe Readable to PutObject without materializing the full body.
    const contentLength = params.contentLength;
    if (contentLength == null || contentLength < 0) {
      throw new Error('AUDIT_EXPORT_STREAM_CONTENT_LENGTH_REQUIRED');
    }
    const { bucket, client } = await this.getStreamBackend();
    await client.send(
      new PutObjectCommand({
        // Always private — never public-read.
        Body: params.body,
        Bucket: bucket,
        ContentLength: contentLength,
        ContentType: contentType,
        Key: params.storageKey,
      }),
    );

    let artifactChecksum = params.artifactChecksum;
    if (!artifactChecksum) {
      // Fallback: stream-hash the just-written object (still bounded memory).
      const hashed = await this.hashObject(params.storageKey);
      artifactChecksum = hashed.artifactChecksum;
    }

    return {
      artifactBytes: contentLength,
      artifactChecksum: formatArtifactChecksum(artifactChecksum),
      storageKey: params.storageKey,
    };
  };

  getObjectMetadata = async (storageKey: string): Promise<AuditExportObjectMetadata> => {
    const meta = await (await this.getS3()).getFileMetadata(storageKey);
    return {
      contentLength: meta.contentLength,
      contentType: meta.contentType,
    };
  };

  hashObject = async (storageKey: string): Promise<AuditExportObjectHash> => {
    const { bucket, client } = await this.getStreamBackend();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: storageKey,
      }),
    );
    if (!response.Body) {
      throw new Error(`No body in response with ${storageKey}`);
    }
    // AWS SDK v3 Body is AsyncIterable in Node.
    return hashAsyncIterable(response.Body as AsyncIterable<Uint8Array>);
  };

  getSignedDownloadUrl = async (storageKey: string, expiresInSeconds: number): Promise<string> => {
    return (await this.getS3()).createPreSignedUrlForPreview(storageKey, expiresInSeconds);
  };

  deleteObject = async (storageKey: string): Promise<void> => {
    // Expand attempts/ prefixes — bare DeleteObject on a non-existent prefix key
    // succeeds on S3 and would silently leave real attempt objects behind (SAO-002).
    if (isAuditExportAttemptsPrefix(storageKey)) {
      const keys = await this.listObjectKeysByPrefix(storageKey);
      for (const key of keys) {
        await (await this.getS3()).deleteFile(key);
      }
      return;
    }
    await (await this.getS3()).deleteFile(storageKey);
  };

  /**
   * ListObjectsV2 + pagination under `prefix`. Required so attempts/ prefix
   * purges expand to real keys instead of DeleteObject-on-prefix (silent success).
   */
  listObjectKeysByPrefix = async (prefix: string): Promise<string[]> => {
    const { bucket, client } = await this.getStreamBackend();
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
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
  };
}
