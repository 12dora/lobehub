/**
 * In-memory storage for admin audit export unit tests (no S3 / network).
 */

import { createHash } from 'node:crypto';

import { formatArtifactChecksum, sha256Hex } from './exportStorageHash';
import { AUDIT_EXPORT_CONTENT_TYPE, isAuditExportAttemptsPrefix } from './exportStorageKeys';
import type {
  AuditExportArtifactStorage,
  AuditExportObjectHash,
  AuditExportObjectMetadata,
  AuditExportUploadBody,
  AuditExportUploadResult,
} from './exportStorageTypes';
import { AuditExportObjectNotFoundError } from './exportStorageTypes';

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
    if (!body) throw new AuditExportObjectNotFoundError(storageKey);
    return { contentLength: body.byteLength, contentType: AUDIT_EXPORT_CONTENT_TYPE };
  };

  hashObject = async (storageKey: string): Promise<AuditExportObjectHash> => {
    const body = this.objects.get(storageKey);
    if (!body) throw new AuditExportObjectNotFoundError(storageKey);
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
    if (!this.objects.has(storageKey)) throw new AuditExportObjectNotFoundError(storageKey);
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
