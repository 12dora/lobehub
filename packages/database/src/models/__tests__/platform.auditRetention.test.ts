// @vitest-environment node
/**
 * Retention repository: export artifact eligibility, storageKey gate, finishedAt keyset,
 * conservative topic status allowlist (null legacy + purgeable only).
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { topics, users } from '../../schemas';
import { platformAuditExports, platformAuditLegalHolds } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAuditLegalHoldModel } from '../platform/auditLegalHold';
import {
  encodeRetentionCursor,
  PlatformAuditRetentionRepository,
  RETENTION_PROTECTED_TOPIC_STATUSES,
  RETENTION_PURGEABLE_TOPIC_STATUSES,
} from '../platform/auditRetention';

const serverDB: LobeChatDatabase = await getTestDB();
const repo = new PlatformAuditRetentionRepository(serverDB);

const oldDate = new Date('2020-01-01T00:00:00.000Z');
const recentDate = new Date(Date.now() - 60_000);
const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const now = new Date();
const topicUserId = 'audit-ret-topic-user';

afterEach(async () => {
  await serverDB.delete(platformAuditExports);
  await serverDB.delete(platformAuditLegalHolds);
  await serverDB.delete(topics);
  await serverDB.delete(users).where(eq(users.id, topicUserId));
});

describe('PlatformAuditRetentionRepository.listExportArtifactCandidates', () => {
  it('requires storageKey IS NOT NULL so cleared expired rows never reappear', async () => {
    await serverDB.insert(platformAuditExports).values([
      {
        artifactBytes: 10,
        artifactChecksum: 'sha256:a',
        createdAt: oldDate,
        expiresAt: oldDate,
        finishedAt: oldDate,
        id: 'paex_ret_cleared',
        kind: 'operation_logs',
        requestedBy: 'admin-1',
        status: 'expired',
        storageKey: null,
      },
      {
        artifactBytes: 10,
        artifactChecksum: 'sha256:b',
        createdAt: oldDate,
        expiresAt: oldDate,
        finishedAt: oldDate,
        id: 'paex_ret_live',
        kind: 'operation_logs',
        requestedBy: 'admin-1',
        status: 'completed',
        storageKey: 'audit-exports/live.jsonl',
      },
    ]);

    const page = await repo.listExportArtifactCandidates({ cutoffAt: cutoff, now });
    expect(page.items.map((i) => i.id)).toEqual(['paex_ret_live']);
    expect(page.items[0]?.storageKey).toBeTruthy();
    expect(page.items[0]?.sortAt).toBeInstanceOf(Date);
    // Legal-hold policy branches on actual kind — must be selected through.
    expect(page.items[0]?.kind).toBe('operation_logs');
  });

  it('eligibility uses finishedAt (not createdAt): recently completed long-ago-created is not purged', async () => {
    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 10,
      artifactChecksum: 'sha256:c',
      // Created long ago, completed just now — must NOT match finishedAt < cutoff
      createdAt: oldDate,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      finishedAt: recentDate,
      id: 'paex_ret_recent_finish',
      kind: 'conversations',
      requestedBy: 'admin-1',
      status: 'completed',
      storageKey: 'audit-exports/recent-finish.jsonl',
    });

    const page = await repo.listExportArtifactCandidates({ cutoffAt: cutoff, now });
    expect(page.items.map((i) => i.id)).not.toContain('paex_ret_recent_finish');
  });

  it('includes rows past expiresAt even when finishedAt is recent', async () => {
    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 10,
      artifactChecksum: 'sha256:d',
      createdAt: recentDate,
      expiresAt: oldDate,
      finishedAt: recentDate,
      id: 'paex_ret_expired_ttl',
      kind: 'operation_logs',
      requestedBy: 'admin-1',
      status: 'completed',
      storageKey: 'audit-exports/ttl.jsonl',
    });

    const page = await repo.listExportArtifactCandidates({ cutoffAt: cutoff, now });
    expect(page.items.map((i) => i.id)).toContain('paex_ret_expired_ttl');
  });

  it('keyset uses sortAt from finishedAt and exposes sortAt on candidates', async () => {
    const t1 = new Date('2020-01-01T00:00:00.000Z');
    const t2 = new Date('2020-01-02T00:00:00.000Z');
    await serverDB.insert(platformAuditExports).values([
      {
        artifactChecksum: 'a',
        createdAt: oldDate,
        expiresAt: oldDate,
        finishedAt: t2,
        id: 'paex_ret_k2',
        kind: 'operation_logs',
        requestedBy: 'admin-1',
        status: 'completed',
        storageKey: 'k2',
      },
      {
        artifactChecksum: 'b',
        createdAt: oldDate,
        expiresAt: oldDate,
        finishedAt: t1,
        id: 'paex_ret_k1',
        kind: 'operation_logs',
        requestedBy: 'admin-1',
        status: 'completed',
        storageKey: 'k1',
      },
    ]);

    const page1 = await repo.listExportArtifactCandidates({ cutoffAt: cutoff, limit: 1, now });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.id).toBe('paex_ret_k1');
    expect(page1.items[0]!.sortAt.toISOString()).toBe(t1.toISOString());
    expect(page1.nextCursor).toBe(encodeRetentionCursor(t1, 'paex_ret_k1'));

    const page2 = await repo.listExportArtifactCandidates({
      cursor: page1.nextCursor!,
      cutoffAt: cutoff,
      limit: 10,
      now,
    });
    expect(page2.items.map((i) => i.id)).toEqual(['paex_ret_k2']);
    expect(page2.nextCursor).toBeNull();
  });
});

describe('PlatformAuditRetentionRepository topic status allowlist', () => {
  beforeEach(async () => {
    await serverDB.delete(topics);
    await serverDB.delete(users).where(eq(users.id, topicUserId));
    await serverDB.insert(users).values({ id: topicUserId });
  });

  it('scans/deletes only null legacy + RETENTION_PURGEABLE_TOPIC_STATUSES (never unknown)', async () => {
    // Ensure constants stay intentional (protected must not be inverted into purge).
    expect(RETENTION_PURGEABLE_TOPIC_STATUSES).toEqual([
      'active',
      'completed',
      'failed',
      'archived',
      'unread',
    ]);
    expect(RETENTION_PROTECTED_TOPIC_STATUSES).toEqual(['running', 'paused', 'waitingForHuman']);

    await serverDB.insert(topics).values([
      {
        id: 'topic-null-legacy',
        status: null,
        title: 'legacy null',
        updatedAt: oldDate,
        userId: topicUserId,
      },
      {
        id: 'topic-purgeable-completed',
        status: 'completed',
        title: 'completed',
        updatedAt: oldDate,
        userId: topicUserId,
      },
      {
        id: 'topic-protected-running',
        status: 'running',
        title: 'running',
        updatedAt: oldDate,
        userId: topicUserId,
      },
      {
        id: 'topic-protected-paused',
        status: 'paused',
        title: 'paused',
        updatedAt: oldDate,
        userId: topicUserId,
      },
      // Unknown/future status: not protected and not purgeable — must never enter candidates.
      {
        id: 'topic-unknown-future',
        // text column accepts values beyond the TS enum; simulate a future status string.
        status: 'scheduledForReview' as 'active',
        title: 'future status',
        updatedAt: oldDate,
        userId: topicUserId,
      },
    ]);

    const page = await repo.listTopicCandidates({ cutoffAt: cutoff });
    const ids = page.items.map((i) => i.id).sort();
    expect(ids).toEqual(['topic-null-legacy', 'topic-purgeable-completed']);
    expect(ids).not.toContain('topic-unknown-future');
    expect(ids).not.toContain('topic-protected-running');
    expect(ids).not.toContain('topic-protected-paused');

    // Delete recheck uses the same allowlist.
    expect(
      await repo.deleteTopicRechecked({ cutoffAt: cutoff, topicId: 'topic-null-legacy' }),
    ).toBe(true);
    expect(
      await repo.deleteTopicRechecked({ cutoffAt: cutoff, topicId: 'topic-purgeable-completed' }),
    ).toBe(true);
    expect(
      await repo.deleteTopicRechecked({ cutoffAt: cutoff, topicId: 'topic-protected-running' }),
    ).toBe(false);
    expect(
      await repo.deleteTopicRechecked({ cutoffAt: cutoff, topicId: 'topic-unknown-future' }),
    ).toBe(false);

    const remaining = await serverDB.select({ id: topics.id }).from(topics);
    const remainingIds = remaining.map((r) => r.id).sort();
    expect(remainingIds).toEqual([
      'topic-protected-paused',
      'topic-protected-running',
      'topic-unknown-future',
    ]);
  });

  it('refuses to delete a purgeable topic covered by an active legal hold', async () => {
    await serverDB.insert(topics).values({
      id: 'topic-held-purgeable',
      status: 'completed',
      title: 'held',
      updatedAt: oldDate,
      userId: topicUserId,
    });

    await new PlatformAuditLegalHoldModel(serverDB).create({
      createdBy: 'admin-hold',
      reason: 'litigation',
      scopeId: 'topic-held-purgeable',
      scopeType: 'topic',
    });

    expect(
      await repo.deleteTopicRechecked({
        cutoffAt: cutoff,
        topicId: 'topic-held-purgeable',
      }),
    ).toBe(false);

    const stillThere = await serverDB
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.id, 'topic-held-purgeable'));
    expect(stillThere).toHaveLength(1);
  });
});

describe('PlatformAuditRetentionRepository export artifact purge outbox race', () => {
  const exportId = 'paex_purge_race';
  const storageKey = 'audit-exports/purge-race/evidence.ndjson';

  beforeEach(async () => {
    await serverDB.delete(platformAuditExports);
    await serverDB.delete(platformAuditLegalHolds);
    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 10,
      artifactChecksum: 'sha256:race',
      createdAt: oldDate,
      expiresAt: oldDate,
      filterSnapshot: { userId: 'user-held-export' },
      finishedAt: oldDate,
      id: exportId,
      kind: 'conversations',
      requestedBy: 'admin-1',
      status: 'completed',
      storageKey,
    });
  });

  it('aborts object delete when a legal hold is inserted between claim and authorize', async () => {
    // Phase 1: claim under lock with no holds — durable outbox + clear storageKey.
    const claimed = await repo.claimExportArtifactsRechecked({
      cutoffAt: cutoff,
      ids: [exportId],
      now,
      resolveHeldIds: async () => new Set(),
    });
    expect(claimed).toEqual([{ id: exportId, storageKey }]);

    const afterClaim = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(afterClaim[0]?.status).toBe('expired');
    expect(afterClaim[0]?.storageKey).toBeNull();
    expect(afterClaim[0]?.error?.code).toBe('ARTIFACT_PURGE_PENDING');
    expect(afterClaim[0]?.error?.purgeStorageKey).toBe(storageKey);

    // Interleave: legal hold created AFTER claim-commit, BEFORE external object delete.
    await new PlatformAuditLegalHoldModel(serverDB).create({
      createdBy: 'admin-hold',
      reason: 'litigation mid-flight',
      scopeId: 'user-held-export',
      scopeType: 'user',
    });

    // Phase 2: recheck holds immediately before object delete — must abort/defer.
    // resolveHeldIds must use the locked TX (PGlite single-connection; no outer DB).
    const authorized = await repo.authorizeExportArtifactObjectDeletes({
      ids: [exportId],
      resolveHeldIds: async (tx, rows) => {
        const holds = await new PlatformAuditLegalHoldModel(tx).findActiveScopes([
          { scopeId: 'user-held-export', scopeType: 'user' },
        ]);
        const held = new Set<string>();
        if (holds.length > 0) {
          for (const row of rows) held.add(row.id);
        }
        return held;
      },
    });
    expect(authorized).toEqual([]);

    // Evidence remains addressable; outbox deferred — must NOT complete as deleted.
    const afterAbort = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(afterAbort[0]?.storageKey).toBe(storageKey);
    expect(afterAbort[0]?.error?.code).toBe('ARTIFACT_PURGE_DEFERRED_HOLD');

    // Completing a deferred outbox is a no-op (object must still exist).
    expect(await repo.completeExportArtifactObjectDeletes([exportId])).toBe(0);
    const still = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(still[0]?.storageKey).toBe(storageKey);
  });

  it('authorizes then completes outbox only after successful object-delete path', async () => {
    const claimed = await repo.claimExportArtifactsRechecked({
      cutoffAt: cutoff,
      ids: [exportId],
      now,
      resolveHeldIds: async () => new Set(),
    });
    expect(claimed).toHaveLength(1);

    const authorized = await repo.authorizeExportArtifactObjectDeletes({
      ids: [exportId],
      resolveHeldIds: async () => new Set(),
    });
    expect(authorized).toEqual([{ id: exportId, storageKey }]);

    // Simulate successful external delete, then mark outbox complete.
    expect(await repo.completeExportArtifactObjectDeletes([exportId])).toBe(1);

    const done = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(done[0]?.status).toBe('expired');
    expect(done[0]?.storageKey).toBeNull();
    expect(done[0]?.error).toBeNull();
    // History retained
    expect(done[0]?.artifactChecksum).toBe('sha256:race');
  });
});
