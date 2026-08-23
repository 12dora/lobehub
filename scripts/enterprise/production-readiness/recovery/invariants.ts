/**
 * Full post-restore invariants: tables digests, secrets, publications, audits.
 */
export {
  canonicalizeTableRow,
  compareTableDigests,
  digestAllRequiredTables,
  digestAuditLogs,
  digestCanonicalRecords,
  digestCanonicalValue,
  digestResourceRevisions,
  TABLE_DIGEST_ENCODING_VERSION,
} from './invariants.digest';
export {
  buildSourceManifestCore,
  compareDigests,
  verifyRequiredTablesPresent,
} from './invariants.manifest';
export {
  RESOURCE_REVISION_PUBLISHED_STATUS,
  verifyPublicationPointers,
} from './invariants.pointers';
export { verifySecretReferenceDomains } from './invariants.secrets';
export type { AggregateDigestResult, BooleanInvariant, TableDigestEntry } from './invariants.types';
