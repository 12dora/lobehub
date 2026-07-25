/**
 * Shared helpers for audit retention worker (SAO-009).
 */

import {
  encodeRetentionCursor,
  type PlatformAuditRetentionCounts,
  type PlatformAuditRetentionRepository,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

export const mergeCounts = (
  base: PlatformAuditRetentionCounts,
  delta: PlatformAuditRetentionCounts,
): PlatformAuditRetentionCounts => {
  const out: PlatformAuditRetentionCounts = { ...base };
  for (const [key, value] of Object.entries(delta) as [
    keyof PlatformAuditRetentionCounts,
    number | undefined,
  ][]) {
    if (typeof value !== 'number') continue;
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
};

export const progressFromCounts = (counts: PlatformAuditRetentionCounts): number =>
  (counts.operationLogsScanned ?? 0) +
  (counts.topicsScanned ?? 0) +
  (counts.exportArtifactsScanned ?? 0);

export type ScopeProcessorParams = {
  checkpointBatch: (
    counts: PlatformAuditRetentionCounts,
    keyset: string,
    destructiveWork?: (tx: Transaction) => Promise<PlatformAuditRetentionCounts | void>,
  ) => Promise<PlatformAuditRetentionCounts>;
  counts: PlatformAuditRetentionCounts;
  cutoffAt: Date;
  db: LobeChatDatabase;
  execute: boolean;
  getKeyset: () => string | undefined;
  renewLease: () => Promise<void>;
  repo: PlatformAuditRetentionRepository;
  /** Domain run id — used for atomic delete attribution (export_artifacts / F7). */
  runId?: string;
  setKeyset: (cursor: string | undefined) => void;
};

/**
 * Always advance keyset past the last processed item — including the final page
 * (when nextCursor is null) so retries never re-scan that page.
 */
export const keysetAfterPage = <T extends { id: string }>(
  page: { items: T[]; nextCursor: string | null },
  sortAtOf: (item: T) => Date,
): string | undefined => {
  const last = page.items.at(-1);
  if (!last) return undefined;
  return page.nextCursor ?? encodeRetentionCursor(sortAtOf(last), last.id);
};
