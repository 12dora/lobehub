/**
 * Storage adapter contracts for admin audit export artifacts.
 */

import type { Readable } from 'node:stream';

import { isRecord } from '@lobechat/utils/object';

export interface AuditExportUploadResult {
  artifactBytes: number;
  artifactChecksum: string;
  storageKey: string;
}

export interface AuditExportObjectMetadata {
  contentLength: number;
  contentType?: string;
}

/** Stable local not-found error for storage adapters that do not expose Smithy metadata. */
export class AuditExportObjectNotFoundError extends Error {
  constructor(storageKey: string) {
    super(`Audit export object not found: ${storageKey}`);
    this.name = 'AuditExportObjectNotFoundError';
  }
}

/** Only structured 404/not-found errors prove that a private object is absent. */
export const isAuditExportObjectNotFoundError = (error: unknown): boolean => {
  if (error instanceof AuditExportObjectNotFoundError) return true;
  if (!isRecord(error)) return false;
  if (error.name === 'NotFound' || error.name === 'NoSuchKey') return true;
  const metadata = error.$metadata;
  return isRecord(metadata) && metadata.httpStatusCode === 404;
};

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
