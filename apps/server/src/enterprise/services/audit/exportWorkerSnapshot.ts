/** Repeatable-read export evidence materialization into a bounded staging stream. */

import { createReadStream, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

import { sql } from 'drizzle-orm';

import type {
  PlatformAuditExportFilterSnapshot,
  PlatformAuditExportItem,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import { AUDIT_EXPORT_BATCH_LIMIT } from './exportConstants';
import { AuditExportArtifactTooLargeError, AuditExportMaxRowsError } from './exportWorkerErrors';
import type { ExportTimeWindow } from './exportWorkerShared';
import { jsonlLine, writeWithBackpressure } from './exportWorkerShared';
import {
  materializeConversations,
  materializeOperationLogs,
  materializeUserTimeline,
} from './exportWorkerSnapshotKinds';

export const materializeExportSnapshot = async (
  db: LobeChatDatabase,
  params: {
    filter: PlatformAuditExportFilterSnapshot;
    includeBodies: boolean;
    kind: PlatformAuditExportItem['kind'];
    /** Remaining artifact bytes after the manifest has been written. */
    maxStagingBytes: number;
    maxExportRows: number;
    /**
     * Test seam (SAO-005): fired for every model method call during materialisation
     * (list / listTopics / getTopic / …). Production never sets this — used to prove
     * total DB model calls scale with pages, not rows.
     */
    onModelCall?: (info: { method: string; model: string }) => void;
    /**
     * Test seam (SAO-005): fired once per keyset page fetch during materialisation.
     * Prefer {@link onModelCall} for N+1 guards — this only sees page seams.
     */
    onPageFetch?: (info: {
      kind: 'operation_logs' | 'conversations_topics' | 'conversations_messages' | 'user_timeline';
    }) => void;
    stagingPath: string;
    window: ExportTimeWindow;
  },
): Promise<{ evidenceCount: number; stagingBytes: number }> => {
  const staging = createWriteStream(params.stagingPath, { flags: 'w' });
  // SAO-006: record stream errors — never rethrow into an unhandled rejection
  // while the snapshot TX awaits further DB pages.
  let stagingClosedIntentionally = false;
  let stagingError: Error | null = null;
  const stagingFinished = finished(staging).catch((err: NodeJS.ErrnoException) => {
    if (stagingClosedIntentionally && err?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    stagingError = err instanceof Error ? err : new Error(String(err));
  });
  let evidenceCount = 0;
  let stagingBytes = 0;

  const writeStaging = async (row: Record<string, unknown>) => {
    if (stagingError) throw stagingError;
    evidenceCount += 1;
    if (evidenceCount > params.maxExportRows) {
      throw new AuditExportMaxRowsError(params.maxExportRows);
    }
    const buf = Buffer.from(jsonlLine(row), 'utf8');
    if (stagingBytes + buf.byteLength > params.maxStagingBytes) {
      throw new AuditExportArtifactTooLargeError();
    }
    stagingBytes += buf.byteLength;
    const pending = writeWithBackpressure(staging, buf);
    if (pending) await pending;
    if (stagingError) throw stagingError;
  };

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const snap = tx as unknown as LobeChatDatabase;

      if (params.kind === 'operation_logs') {
        await materializeOperationLogs(snap, params, writeStaging);
        return;
      }

      if (params.kind === 'conversations') {
        await materializeConversations(snap, params, writeStaging);
        return;
      }

      await materializeUserTimeline(snap, params, writeStaging);
    });

    if (stagingError) throw stagingError;
    staging.end();
    await stagingFinished;
    if (stagingError) throw stagingError;
    return { evidenceCount, stagingBytes };
  } catch (error) {
    stagingClosedIntentionally = true;
    if (!staging.destroyed) staging.destroy();
    await stagingFinished.catch(() => undefined);
    throw error;
  }
};

/** Copy frozen staging lines into the artifact with heartbeats (no live DB reads). */
export const streamStagingIntoArtifact = async (
  stagingPath: string,
  writeLine: (line: string) => Promise<void>,
  heartbeat: () => Promise<void>,
): Promise<void> => {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(stagingPath, { encoding: 'utf8' }),
  });
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    n += 1;
    if (n % AUDIT_EXPORT_BATCH_LIMIT === 1) {
      await heartbeat();
    }
    // Staging lines are already JSON objects without trailing newline handling.
    await writeLine(line.endsWith('\n') ? line : `${line}\n`);
  }
};
