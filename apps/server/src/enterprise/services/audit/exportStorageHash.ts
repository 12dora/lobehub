/**
 * Artifact checksum helpers for admin audit export storage.
 */

import { createHash } from 'node:crypto';

import type { AuditExportObjectHash } from './exportStorageTypes';

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
