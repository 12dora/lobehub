/**
 * Injectable private artifact storage for admin audit exports.
 *
 * Production adapter builds a dedicated S3 client with setAcl:false so audit
 * evidence is never public-read even when global S3_SET_ACL=true.
 * Only short-lived signed GET URLs are issued for download.
 * Never store or return permanent public URLs from list/get surfaces.
 *
 * Upload / integrity verification prefer streaming I/O (F10) so a multi‑hundred‑MiB
 * artifact is never fully buffered twice in the worker or download path.
 */

import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { fileEnv } from '@/envs/file';
import { S3 } from '@/server/modules/S3';

export const AUDIT_EXPORT_STORAGE_KEY_PREFIX = 'platform-audit-exports';
export const AUDIT_EXPORT_ARTIFACT_FILENAME = 'evidence.ndjson';
export const AUDIT_EXPORT_CONTENT_TYPE = 'application/x-ndjson';

/** Deterministic private object key (legacy; attempt-unique keys are preferred). */
export const buildAuditExportStorageKey = (exportId: string): string =>
  `${AUDIT_EXPORT_STORAGE_KEY_PREFIX}/${exportId}/${AUDIT_EXPORT_ARTIFACT_FILENAME}`;

/**
 * Prefix under which all attempt-unique publication keys for an export live.
 * Dead-letter reconcile / multi-attempt purge use this when individual keys are
 * unknown — never the legacy deterministic filename (no attempt writes there).
 */
export const buildAuditExportAttemptsPrefix = (exportId: string): string =>
  `${AUDIT_EXPORT_STORAGE_KEY_PREFIX}/${exportId}/attempts/`;

/** True when a purge outbox entry is the attempts/ prefix (not a single object key). */
export const isAuditExportAttemptsPrefix = (storageKey: string): boolean =>
  storageKey.endsWith('/attempts/') || /\/attempts\/$/u.test(storageKey);

/**
 * Attempt-unique object key for fenced publication (SAO-002).
 * Each worker attempt uploads to its own key; only the fenced `complete()` winner
 * publishes that key onto the domain row. Losers delete only their own attempt key.
 */
export const buildAuditExportAttemptStorageKey = (
  exportId: string,
  attemptToken: string,
): string => {
  // Sanitize token for S3 key safety (jobId:attempt → jobId_attempt).
  const safe = attemptToken.replaceAll(/[^\w.-]+/g, '_').slice(0, 128);
  return `${AUDIT_EXPORT_STORAGE_KEY_PREFIX}/${exportId}/attempts/${safe}/${AUDIT_EXPORT_ARTIFACT_FILENAME}`;
};

/** Build a fencing token from platform_jobs claim identity. */
export const buildAuditExportAttemptToken = (jobId: string, attempt: number): string =>
  `${jobId}:${attempt}`;

export interface AuditExportUploadResult {
  artifactBytes: number;
  artifactChecksum: string;
  storageKey: string;
}

export interface AuditExportObjectMetadata {
  contentLength: number;
  contentType?: string;
}

export interface AuditExportObjectHash {
  artifactBytes: number;
  artifactChecksum: string;
}

/** Upload body: Buffer for small/test paths; Readable for production streaming. */
export type AuditExportUploadBody = Buffer | Readable;

export interface AuditExportArtifactStorage {
  /** Best-effort delete (cancel / fail cleanup). */
  deleteObject: (storageKey: string) => Promise<void>;
  /** Head object for post-upload integrity check. */
  getObjectMetadata: (storageKey: string) => Promise<AuditExportObjectMetadata>;
  /**
   * Short-lived signed HTTPS GET URL. Never return the raw storage key to clients.
   * @param expiresInSeconds TTL for the signed URL
   */
  getSignedDownloadUrl: (storageKey: string, expiresInSeconds: number) => Promise<string>;
  /**
   * Stream-hash object bytes (bounded memory). Same checksum semantics as
   * `formatArtifactChecksum(sha256Hex(fullBuffer))`. Single integrity path (SAO-011).
   */
  hashObject: (storageKey: string) => Promise<AuditExportObjectHash>;
  /**
   * List object keys under a prefix (attempts/ purge fallback).
   * Required for production S3 so a prefix outbox entry expands to real keys
   * instead of a silent DeleteObject on a non-existent ".../attempts/" key.
   */
  listObjectKeysByPrefix?: (prefix: string) => Promise<string[]>;
  /**
   * Private upload of the NDJSON artifact.
   * Accepts a Buffer or a Readable stream. When streaming, pass `contentLength`
   * and preferably a precomputed `artifactChecksum` (worker hashes while writing).
   * Idempotent when the same deterministic key is reused.
   */
  uploadArtifact: (params: {
    /** Precomputed `sha256:…` when `body` is a stream (avoids a second full read). */
    artifactChecksum?: string;
    body: AuditExportUploadBody;
    /** Required when `body` is a stream (S3 Content-Length / result bytes). */
    contentLength?: number;
    contentType?: string;
    storageKey: string;
  }) => Promise<AuditExportUploadResult>;
}

/** Compare two checksum strings after normalizing the `sha256:` prefix. */
export const checksumsMatch = (
  actual: string | null | undefined,
  expected: string | null | undefined,
): boolean => {
  if (!actual || !expected) return false;
  return formatArtifactChecksum(actual) === formatArtifactChecksum(expected);
};

export const sha256Hex = (body: Buffer | string): string =>
  createHash('sha256').update(body).digest('hex');

export const formatArtifactChecksum = (hex: string): string =>
  hex.startsWith('sha256:') ? hex : `sha256:${hex}`;

/** Incremental SHA-256 over an async byte source (F10 streaming verify). */
export const hashAsyncIterable = async (
  source: AsyncIterable<Uint8Array | Buffer>,
): Promise<AuditExportObjectHash> => {
  const hasher = createHash('sha256');
  let artifactBytes = 0;
  for await (const chunk of source) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hasher.update(buf);
    artifactBytes += buf.byteLength;
  }
  return {
    artifactBytes,
    artifactChecksum: formatArtifactChecksum(hasher.digest('hex')),
  };
};

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
} => ({
  bucket: fileEnv.S3_BUCKET,
  forcePathStyle: fileEnv.S3_ENABLE_PATH_STYLE,
  region: fileEnv.S3_REGION,
  setAcl: false,
});

/** Create the dedicated private S3 client used for audit export artifacts. */
export const createPrivateAuditExportS3 = (): S3 =>
  new S3(fileEnv.S3_ACCESS_KEY_ID, fileEnv.S3_SECRET_ACCESS_KEY, fileEnv.S3_ENDPOINT, {
    ...buildPrivateAuditExportS3Options(),
  });

/** Streaming S3 client (private ACL) for Put/Get without full buffering (F10). */
const createPrivateAuditExportS3Client = (): { bucket: string; client: S3Client } => {
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
  private readonly s3: S3;
  /** Lazy streaming client — only built when a stream upload/hash is needed. */
  private streamBackend: { bucket: string; client: S3Client } | null = null;

  constructor(s3?: S3) {
    this.s3 = s3 ?? createPrivateAuditExportS3();
  }

  /** Test/introspection: whether this adapter will ever request a public ACL. */
  static readonly enforcesPrivateAcl = true as const;

  private getStreamBackend = (): { bucket: string; client: S3Client } => {
    if (!this.streamBackend) {
      this.streamBackend = createPrivateAuditExportS3Client();
    }
    return this.streamBackend;
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
      await this.s3.uploadBuffer(params.storageKey, params.body, contentType);
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
    const { bucket, client } = this.getStreamBackend();
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
    const meta = await this.s3.getFileMetadata(storageKey);
    return {
      contentLength: meta.contentLength,
      contentType: meta.contentType,
    };
  };

  hashObject = async (storageKey: string): Promise<AuditExportObjectHash> => {
    const { bucket, client } = this.getStreamBackend();
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
    return this.s3.createPreSignedUrlForPreview(storageKey, expiresInSeconds);
  };

  deleteObject = async (storageKey: string): Promise<void> => {
    // Expand attempts/ prefixes — bare DeleteObject on a non-existent prefix key
    // succeeds on S3 and would silently leave real attempt objects behind (SAO-002).
    if (isAuditExportAttemptsPrefix(storageKey)) {
      const keys = await this.listObjectKeysByPrefix(storageKey);
      for (const key of keys) {
        await this.s3.deleteFile(key);
      }
      return;
    }
    await this.s3.deleteFile(storageKey);
  };

  /**
   * ListObjectsV2 + pagination under `prefix`. Required so attempts/ prefix
   * purges expand to real keys instead of DeleteObject-on-prefix (silent success).
   */
  listObjectKeysByPrefix = async (prefix: string): Promise<string[]> => {
    const { bucket, client } = this.getStreamBackend();
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

/** In-memory storage for unit tests (no S3 / network). */
export class InMemoryAuditExportArtifactStorage implements AuditExportArtifactStorage {
  readonly objects = new Map<string, Buffer>();

  /**
   * Peak single allocation observed during upload (Buffer.byteLength or stream chunk).
   * Streaming uploads should never allocate a single buffer equal to the full artifact
   * when the producer is a multi-chunk Readable (F10 regression seam).
   */
  peakUploadChunkBytes = 0;

  uploadArtifact = async (params: {
    artifactChecksum?: string;
    body: AuditExportUploadBody;
    contentLength?: number;
    contentType?: string;
    storageKey: string;
  }): Promise<AuditExportUploadResult> => {
    let body: Buffer;
    if (Buffer.isBuffer(params.body)) {
      this.peakUploadChunkBytes = Math.max(this.peakUploadChunkBytes, params.body.byteLength);
      body = Buffer.from(params.body);
    } else {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of params.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.peakUploadChunkBytes = Math.max(this.peakUploadChunkBytes, buf.byteLength);
        chunks.push(buf);
        total += buf.byteLength;
      }
      body = Buffer.concat(chunks, total);
    }
    this.objects.set(params.storageKey, body);
    const checksum = params.artifactChecksum ?? formatArtifactChecksum(sha256Hex(body));
    return {
      artifactBytes: body.byteLength,
      artifactChecksum: formatArtifactChecksum(checksum),
      storageKey: params.storageKey,
    };
  };

  getObjectMetadata = async (storageKey: string): Promise<AuditExportObjectMetadata> => {
    const body = this.objects.get(storageKey);
    if (!body) throw new Error(`Object not found: ${storageKey}`);
    return { contentLength: body.byteLength, contentType: AUDIT_EXPORT_CONTENT_TYPE };
  };

  hashObject = async (storageKey: string): Promise<AuditExportObjectHash> => {
    const body = this.objects.get(storageKey);
    if (!body) throw new Error(`Object not found: ${storageKey}`);
    // Simulate streaming: hash in fixed-size windows rather than one-shot over the
    // whole buffer (same digest as sha256Hex(body)).
    const hasher = createHash('sha256');
    const window = 64 * 1024;
    for (let offset = 0; offset < body.byteLength; offset += window) {
      hasher.update(body.subarray(offset, Math.min(offset + window, body.byteLength)));
    }
    return {
      artifactBytes: body.byteLength,
      artifactChecksum: formatArtifactChecksum(hasher.digest('hex')),
    };
  };

  getSignedDownloadUrl = async (storageKey: string, expiresInSeconds: number): Promise<string> => {
    if (!this.objects.has(storageKey)) throw new Error(`Object not found: ${storageKey}`);
    // Synthetic URL for tests — never used as a storageKey in API outputs.
    return `https://audit-export.test/signed/${encodeURIComponent(storageKey)}?exp=${expiresInSeconds}`;
  };

  deleteObject = async (storageKey: string): Promise<void> => {
    if (isAuditExportAttemptsPrefix(storageKey)) {
      for (const key of await this.listObjectKeysByPrefix(storageKey)) {
        this.objects.delete(key);
      }
      return;
    }
    this.objects.delete(storageKey);
  };

  listObjectKeysByPrefix = async (prefix: string): Promise<string[]> => {
    const keys: string[] = [];
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  };
}
