// @vitest-environment node
/**
 * Retention repository: export artifact eligibility, storageKey gate, finishedAt keyset,
 * conservative topic status allowlist (null legacy + purgeable only).
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { topics, users } from '../../schemas';
import { platformAuditExports } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
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
});
