/**
 * Export evidence inventory materialization + staging stream (SAO-009).
 */
/**
 * Functional worker for platform.audit.export.v1 jobs.
 * Keyset-batched DB reads, lease renewal, cancellation checks.
 * Builds NDJSON (manifest + evidence). Hard-fails if maxExportRows+1 would be written.
 * No generic redaction / summarization / body truncation; credential-only masking for messages.
 *
 * Evidence is materialised under a PostgreSQL REPEATABLE READ snapshot (plus an
 * export-start watermark on `to`) into a staging temp file so concurrent mutations
 * cannot reshape content after freeze. Staging lines are then copied into the
 * artifact with heartbeats outside the snapshot TX. NDJSON streams to a temp file
 * with incremental SHA-256 — O(batch) memory during write.
 *
 * Publication is a durable two-phase fenced state machine (SAO-001/002):
 * each attempt binds a fencing token, uploads to an attempt-unique object key,
 * renews the lease across remote I/O, and completes only if the token still owns
 * the row. Losers never delete a key they do not own.
 *
 * Reliability: unknown/transient storage/DB errors requeue via platform_jobs (maxAttempts);
 * domain stays `running` and only the attempt's own object is cleaned. Domain is marked
 * failed only when the job becomes `dead`. Contract/data errors are terminal immediately.
 * Terminal domain/job outcomes append a required audit event in the same DB transaction.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

import { sql } from 'drizzle-orm';

import {
  maskAuditConversationEvidence,
  PlatformAuditConversationModel,
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportItem,
  PlatformAuditLogModel,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import { AUDIT_EXPORT_BATCH_LIMIT } from './exportConstants';
import { AuditExportInvalidFilterError, AuditExportMaxRowsError } from './exportWorkerErrors';
import { type ExportTimeWindow, jsonlLine, toIso } from './exportWorkerShared';

/** Wrap a model so every method call is tallied (SAO-005 N+1 regression guard). */
const wrapModelForQueryCount = <T extends object>(
  model: T,
  onModelCall?: (info: { method: string; model: string }) => void,
  modelName?: string,
): T => {
  if (!onModelCall) return model;
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && typeof prop === 'string') {
        return (...args: unknown[]) => {
          onModelCall({ method: prop, model: modelName ?? 'model' });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
};

export const materializeExportSnapshot = async (
  db: LobeChatDatabase,
  params: {
    filter: PlatformAuditExportFilterSnapshot;
    includeBodies: boolean;
    kind: PlatformAuditExportItem['kind'];
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
): Promise<{ evidenceCount: number }> => {
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

  const writeStaging = async (row: Record<string, unknown>) => {
    if (stagingError) throw stagingError;
    evidenceCount += 1;
    if (evidenceCount > params.maxExportRows) {
      throw new AuditExportMaxRowsError(params.maxExportRows);
    }
    const buf = Buffer.from(jsonlLine(row), 'utf8');
    if (!staging.write(buf)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          staging.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          staging.off('drain', onDrain);
          reject(err);
        };
        staging.once('drain', onDrain);
        staging.once('error', onError);
      });
    }
    if (stagingError) throw stagingError;
  };

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const snap = tx as unknown as LobeChatDatabase;

      if (params.kind === 'operation_logs') {
        const model = wrapModelForQueryCount(
          new PlatformAuditLogModel(snap),
          params.onModelCall,
          'PlatformAuditLogModel',
        );
        let cursor: string | undefined;
        for (;;) {
          // list() returns full rows — freeze content under RR (batched pages).
          params.onPageFetch?.({ kind: 'operation_logs' });
          const page = await model.list({
            action: params.filter.action,
            actions: params.filter.actions,
            actorUserId: params.filter.actorUserId,
            cursor,
            from: params.window.from,
            limit: AUDIT_EXPORT_BATCH_LIMIT,
            requestId: params.filter.requestId,
            result: params.filter.result,
            results: params.filter.results,
            targetId: params.filter.targetId,
            targetType: params.filter.targetType,
            to: params.window.to,
          });
          for (const row of page.items) {
            await writeStaging({
              action: row.action,
              actorUserId: row.actorUserId,
              afterDiff: row.afterDiff,
              beforeDiff: row.beforeDiff,
              configRevision: row.configRevision,
              createdAt: toIso(row.createdAt),
              id: row.id,
              ipHash: row.ipHash,
              reason: row.reason,
              requestId: row.requestId,
              result: row.result,
              targetId: row.targetId,
              targetType: row.targetType,
              type: 'operation_log',
              userAgent: row.userAgent,
            });
          }
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        return;
      }

      if (params.kind === 'conversations') {
        const userId = params.filter.userId;
        if (!userId) {
          throw new AuditExportInvalidFilterError(
            'userId required in frozen filter for conversations export',
          );
        }
        const model = wrapModelForQueryCount(
          new PlatformAuditConversationModel(snap),
          params.onModelCall,
          'PlatformAuditConversationModel',
        );
        let topicCursor: string | undefined;

        for (;;) {
          params.onPageFetch?.({ kind: 'conversations_topics' });
          const topicPage = await model.listTopics({
            cursor: topicCursor,
            from: params.window.from,
            limit: AUDIT_EXPORT_BATCH_LIMIT,
            q: params.filter.q,
            to: params.window.to,
            userId,
          });

          for (const topic of topicPage.items) {
            if (params.filter.topicId && topic.id !== params.filter.topicId) continue;

            // listTopics already selects every field written to staging — no
            // per-topic getTopic (SAO-005 N+1). Same-RR visibility makes a second
            // probe redundant; write straight from the list row + mask.
            await writeStaging({
              agentId: topic.agentId,
              createdAt: toIso(topic.createdAt),
              description:
                topic.description == null ? null : maskAuditConversationEvidence(topic.description),
              id: topic.id,
              model: topic.model,
              provider: topic.provider,
              sessionId: topic.sessionId,
              status: topic.status,
              title: topic.title == null ? null : maskAuditConversationEvidence(topic.title),
              type: 'conversation_topic',
              updatedAt: toIso(topic.updatedAt),
              userId: topic.userId,
            });

            if (!params.includeBodies) continue;

            let msgCursor: string | undefined;
            for (;;) {
              // Full message bodies under the same RR snapshot (batched).
              params.onPageFetch?.({ kind: 'conversations_messages' });
              const msgPage = await model.listMessageDetails({
                cursor: msgCursor,
                from: params.window.from,
                limit: AUDIT_EXPORT_BATCH_LIMIT,
                to: params.window.to,
                topicId: topic.id,
                userId,
              });
              for (const msg of msgPage.items) {
                await writeStaging({
                  agentId: msg.agentId,
                  content: msg.content == null ? null : maskAuditConversationEvidence(msg.content),
                  createdAt: toIso(msg.createdAt),
                  editorData:
                    msg.editorData == null ? null : maskAuditConversationEvidence(msg.editorData),
                  error: msg.error == null ? null : maskAuditConversationEvidence(msg.error),
                  id: msg.id,
                  model: msg.model,
                  parentId: msg.parentId,
                  provider: msg.provider,
                  role: msg.role,
                  sessionId: msg.sessionId,
                  topicId: msg.topicId,
                  type: 'conversation_message',
                  updatedAt: toIso(msg.updatedAt),
                  userId: msg.userId,
                });
              }
              if (!msgPage.nextCursor) break;
              msgCursor = msgPage.nextCursor;
            }
          }

          if (!topicPage.nextCursor) break;
          topicCursor = topicPage.nextCursor;
        }
        return;
      }

      // user_timeline — freeze projected timeline items under RR (batched pages).
      const userId = params.filter.userId;
      if (!userId) {
        throw new AuditExportInvalidFilterError(
          'userId required in frozen filter for user_timeline export',
        );
      }
      const model = wrapModelForQueryCount(
        new PlatformAuditConversationModel(snap),
        params.onModelCall,
        'PlatformAuditConversationModel',
      );
      let cursor: string | undefined;
      for (;;) {
        params.onPageFetch?.({ kind: 'user_timeline' });
        const page = await model.listUserTimeline({
          cursor,
          from: params.window.from,
          limit: AUDIT_EXPORT_BATCH_LIMIT,
          to: params.window.to,
          userId,
        });
        for (const item of page.items) {
          await writeStaging({
            createdAt: toIso(item.createdAt),
            id: item.id,
            kind: item.kind,
            sessionId: item.sessionId,
            title: item.title == null ? null : maskAuditConversationEvidence(item.title),
            topicId: item.topicId,
            type: 'user_timeline_item',
            updatedAt: toIso(item.updatedAt),
            userId,
          });
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    });

    if (stagingError) throw stagingError;
    staging.end();
    await stagingFinished;
    if (stagingError) throw stagingError;
    return { evidenceCount };
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

/** Process up to `batchLimit` jobs (for poller / tests). */
