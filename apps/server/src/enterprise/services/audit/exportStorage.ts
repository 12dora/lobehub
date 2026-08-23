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
 *
 * Split: key builders, contracts, checksums, S3 adapter, and in-memory test adapter
 * live in sibling modules; this file remains the public barrel.
 */

export {
  checksumsMatch,
  formatArtifactChecksum,
  hashAsyncIterable,
  sha256Hex,
} from './exportStorageHash';
export {
  AUDIT_EXPORT_ARTIFACT_FILENAME,
  AUDIT_EXPORT_CONTENT_TYPE,
  AUDIT_EXPORT_STORAGE_KEY_PREFIX,
  buildAuditExportAttemptsPrefix,
  buildAuditExportAttemptStorageKey,
  buildAuditExportAttemptToken,
  buildAuditExportStorageKey,
  isAuditExportAttemptsPrefix,
} from './exportStorageKeys';
export { InMemoryAuditExportArtifactStorage } from './exportStorageMemory';
export {
  AuditExportPrivateS3Storage,
  buildPrivateAuditExportS3Options,
  createPrivateAuditExportS3,
} from './exportStorageS3';
export type {
  AuditExportArtifactStorage,
  AuditExportObjectHash,
  AuditExportObjectMetadata,
  AuditExportUploadBody,
  AuditExportUploadResult,
} from './exportStorageTypes';
export {
  AuditExportObjectNotFoundError,
  isAuditExportObjectNotFoundError,
} from './exportStorageTypes';
