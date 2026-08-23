/**
 * Storage I/O for export-artifact purge (prefix-safe delete + existence).
 * Prefix keys without listObjectKeysByPrefix must throw so the outbox stays pending (SAO-002).
 */

import {
  type AuditExportArtifactStorage,
  isAuditExportAttemptsPrefix,
  isAuditExportObjectNotFoundError,
} from './exportStorage';

export const deleteExportArtifactObject = async (
  storage: AuditExportArtifactStorage,
  storageKey: string,
): Promise<void> => {
  // Prefer storage.deleteObject (S3 + InMemory expand attempts/ prefixes).
  // If a custom adapter lacks listObjectKeysByPrefix, refuse prefix keys so
  // the outbox stays pending instead of silently finalizing (SAO-002).
  if (isAuditExportAttemptsPrefix(storageKey) && !storage.listObjectKeysByPrefix) {
    throw new Error('AUDIT_EXPORT_PREFIX_LIST_REQUIRED');
  }
  await storage.deleteObject(storageKey);
};

export const exportArtifactObjectExists = async (
  storage: AuditExportArtifactStorage,
  storageKey: string,
): Promise<boolean> => {
  if (isAuditExportAttemptsPrefix(storageKey)) {
    if (!storage.listObjectKeysByPrefix) {
      throw new Error('AUDIT_EXPORT_PREFIX_LIST_REQUIRED');
    }
    const keys = await storage.listObjectKeysByPrefix(storageKey);
    return keys.length > 0;
  }
  try {
    await storage.getObjectMetadata(storageKey);
    return true;
  } catch (error) {
    if (isAuditExportObjectNotFoundError(error)) return false;
    throw error;
  }
};
