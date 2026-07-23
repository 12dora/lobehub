/**
 * Injectable private artifact storage for admin audit exports.
 *
 * Production adapter builds a dedicated S3 client with setAcl:false so audit
 * evidence is never public-read even when global S3_SET_ACL=true.
 * Only short-lived signed GET URLs are issued for download.
 * Never store or return permanent public URLs from list/get surfaces.
 */

import { createHash } from 'node:crypto';

import { fileEnv } from '@/envs/file';
import { S3 } from '@/server/modules/S3';

export const AUDIT_EXPORT_STORAGE_KEY_PREFIX = 'platform-audit-exports';
export const AUDIT_EXPORT_ARTIFACT_FILENAME = 'evidence.ndjson';
export const AUDIT_EXPORT_CONTENT_TYPE = 'application/x-ndjson';

/** Deterministic private object key for idempotent retry of the same export. */
export const buildAuditExportStorageKey = (exportId: string): string =>
  `${AUDIT_EXPORT_STORAGE_KEY_PREFIX}/${exportId}/${AUDIT_EXPORT_ARTIFACT_FILENAME}`;

export interface AuditExportUploadResult {
  artifactBytes: number;
  artifactChecksum: string;
  storageKey: string;
}

export interface AuditExportObjectMetadata {
  contentLength: number;
  contentType?: string;
}

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
   * Private upload of the full NDJSON artifact.
   * Idempotent when the same deterministic key is reused.
   */
  uploadArtifact: (params: {
    body: Buffer;
    contentType?: string;
    storageKey: string;
  }) => Promise<AuditExportUploadResult>;
}

export const sha256Hex = (body: Buffer | string): string =>
  createHash('sha256').update(body).digest('hex');

export const formatArtifactChecksum = (hex: string): string =>
  hex.startsWith('sha256:') ? hex : `sha256:${hex}`;

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

/**
 * Production private S3-backed storage for audit export artifacts.
 * Does not use FileS3 (which may set public-read when S3_SET_ACL=true).
 */
export class AuditExportPrivateS3Storage implements AuditExportArtifactStorage {
  private readonly s3: S3;

  constructor(s3?: S3) {
    this.s3 = s3 ?? createPrivateAuditExportS3();
  }

  /** Test/introspection: whether this adapter will ever request a public ACL. */
  static readonly enforcesPrivateAcl = true as const;

  uploadArtifact = async (params: {
    body: Buffer;
    contentType?: string;
    storageKey: string;
  }): Promise<AuditExportUploadResult> => {
    const checksum = formatArtifactChecksum(sha256Hex(params.body));
    await this.s3.uploadBuffer(
      params.storageKey,
      params.body,
      params.contentType ?? AUDIT_EXPORT_CONTENT_TYPE,
    );
    return {
      artifactBytes: params.body.byteLength,
      artifactChecksum: checksum,
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

  getSignedDownloadUrl = async (storageKey: string, expiresInSeconds: number): Promise<string> => {
    return this.s3.createPreSignedUrlForPreview(storageKey, expiresInSeconds);
  };

  deleteObject = async (storageKey: string): Promise<void> => {
    await this.s3.deleteFile(storageKey);
  };
}

/** In-memory storage for unit tests (no S3 / network). */
export class InMemoryAuditExportArtifactStorage implements AuditExportArtifactStorage {
  readonly objects = new Map<string, Buffer>();

  uploadArtifact = async (params: {
    body: Buffer;
    contentType?: string;
    storageKey: string;
  }): Promise<AuditExportUploadResult> => {
    this.objects.set(params.storageKey, Buffer.from(params.body));
    return {
      artifactBytes: params.body.byteLength,
      artifactChecksum: formatArtifactChecksum(sha256Hex(params.body)),
      storageKey: params.storageKey,
    };
  };

  getObjectMetadata = async (storageKey: string): Promise<AuditExportObjectMetadata> => {
    const body = this.objects.get(storageKey);
    if (!body) throw new Error(`Object not found: ${storageKey}`);
    return { contentLength: body.byteLength, contentType: AUDIT_EXPORT_CONTENT_TYPE };
  };

  getSignedDownloadUrl = async (storageKey: string, expiresInSeconds: number): Promise<string> => {
    if (!this.objects.has(storageKey)) throw new Error(`Object not found: ${storageKey}`);
    // Synthetic URL for tests — never used as a storageKey in API outputs.
    return `https://audit-export.test/signed/${encodeURIComponent(storageKey)}?exp=${expiresInSeconds}`;
  };

  deleteObject = async (storageKey: string): Promise<void> => {
    this.objects.delete(storageKey);
  };
}
