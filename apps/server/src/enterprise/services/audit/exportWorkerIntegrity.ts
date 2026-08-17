/** Post-upload size + checksum verification for an audit export artifact. */

import type { AuditExportArtifactStorage, AuditExportUploadResult } from './exportStorage';
import { checksumsMatch } from './exportStorage';
import { safeDeleteOwned } from './exportWorkerTerminal';

export const verifyUploadedArtifact = async (params: {
  assertNotCancelled: () => Promise<void>;
  localChecksum: string;
  storage: AuditExportArtifactStorage;
  storageKey: string;
  totalBytes: number;
  uploaded: AuditExportUploadResult;
}): Promise<void> => {
  const { assertNotCancelled, localChecksum, storage, storageKey, totalBytes, uploaded } = params;

  // Integrity: size + streaming SHA-256 — same-length corruption must fail closed.
  if (!checksumsMatch(uploaded.artifactChecksum, localChecksum)) {
    await safeDeleteOwned(storage, storageKey);
    throw new Error('AUDIT_EXPORT_CHECKSUM_MISMATCH');
  }
  if (uploaded.artifactBytes !== totalBytes) {
    await safeDeleteOwned(storage, storageKey);
    throw new Error('AUDIT_EXPORT_SIZE_MISMATCH');
  }
  await assertNotCancelled();
  const meta = await storage.getObjectMetadata(storageKey);
  if (meta.contentLength !== uploaded.artifactBytes || meta.contentLength !== totalBytes) {
    await safeDeleteOwned(storage, storageKey);
    throw new Error('AUDIT_EXPORT_SIZE_MISMATCH');
  }
  await assertNotCancelled();
  const storedHash = await storage.hashObject(storageKey);
  if (
    storedHash.artifactBytes !== totalBytes ||
    !checksumsMatch(storedHash.artifactChecksum, uploaded.artifactChecksum)
  ) {
    await safeDeleteOwned(storage, storageKey);
    throw new Error('AUDIT_EXPORT_CHECKSUM_MISMATCH');
  }
};
