// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { messages, topics, users } from '@/database/schemas';
import {
  platformAuditLegalHolds,
  platformAuditLogs,
  platformAuditPolicies,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { AdminAuditService } from './adminAuditService';
import { resolveAuditTimeWindow } from './timeWindow';

const serverDB: LobeChatDatabase = await getTestDB();
const service = new AdminAuditService(serverDB);

const actor = 'audit-svc-actor';
const userA = 'audit-svc-user-a';
const userB = 'audit-svc-user-b';

beforeEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformAuditLegalHolds);
  await serverDB.delete(platformAuditPolicies);
  await serverDB.delete(messages);
  await serverDB.delete(topics);
  await serverDB.delete(users).where(eq(users.id, actor));
  await serverDB.delete(users).where(eq(users.id, userA));
  await serverDB.delete(users).where(eq(users.id, userB));
  await serverDB.insert(users).values([{ id: actor }, { id: userA }, { id: userB }]);
});

afterEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformAuditLegalHolds);
  await serverDB.delete(platformAuditPolicies);
  await serverDB.delete(messages);
  await serverDB.delete(topics);
});

describe('AdminAuditService', () => {
  it('returns operation detail stored diffs without extra read-time redaction', async () => {
    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.settings.publish',
      afterDiff: {
        displayName: 'Acme Corp Legal Entity',
        fingerprint: 'should-remain-on-read-for-admin-audit',
      },
      beforeDiff: { displayName: 'Old Name' },
      id: 'op-detail-1',
      result: 'success',
      targetId: 'global',
      targetType: 'settings',
    });

    const detail = await service.getEvent({ actorUserId: actor, id: 'op-detail-1' });
    expect(detail.afterDiff).toMatchObject({
      displayName: 'Acme Corp Legal Entity',
      fingerprint: 'should-remain-on-read-for-admin-audit',
    });
    expect(detail.beforeDiff).toMatchObject({ displayName: 'Old Name' });

    const list = await service.listEvents({
      actorUserId: actor,
      input: { limit: 10, targetId: 'global' },
    });
    expect(list.items[0]).not.toHaveProperty('afterDiff');
    expect(list.items[0]).not.toHaveProperty('beforeDiff');
  });

  it('preserves long ordinary message body exactly under content_allowed', async () => {
    await service.updatePolicy({
      actorUserId: actor,
      input: {
        contentAccessMode: 'content_allowed',
        expectedRevision: 0,
        reason: 'enable content for test',
      },
    });
    // updatePolicy bumps revision; fetch current
    const policy = await service.getPolicy({ actorUserId: actor });
    expect(policy.contentAccessMode).toBe('content_allowed');

    const ordinary = `Business memo for ACME: ${'paragraph '.repeat(400)} end.`;
    await serverDB.insert(topics).values({ id: 't1', title: 'Memo', userId: userA });
    await serverDB.insert(messages).values({
      content: ordinary,
      id: 'm1',
      role: 'user',
      topicId: 't1',
      userId: userA,
    });

    const page = await service.listConversationMessages({
      actorUserId: actor,
      input: {
        includeBody: true,
        limit: 10,
        topicId: 't1',
        userId: userA,
      },
    });
    expect(page.items[0]!.content).toBe(ordinary);
  });

  it('masks credentials only in message body', async () => {
    // Ensure content_allowed (policy may already exist from prior test isolation)
    const current = await service.getPolicy({ actorUserId: actor });
    if (current.contentAccessMode !== 'content_allowed') {
      await service.updatePolicy({
        actorUserId: actor,
        input: {
          contentAccessMode: 'content_allowed',
          expectedRevision: current.revision,
          reason: 'enable content',
        },
      });
    }

    const body =
      'Please use sk-abcdefghijklmnopqrstuvwxyz012345 for the demo and keep ACME Corp name.';
    await serverDB.insert(topics).values({ id: 't2', title: 'Keys', userId: userA });
    await serverDB.insert(messages).values({
      content: body,
      id: 'm2',
      role: 'user',
      topicId: 't2',
      userId: userA,
    });

    const page = await service.listConversationMessages({
      actorUserId: actor,
      input: { includeBody: true, limit: 5, topicId: 't2', userId: userA },
    });
    expect(page.items[0]!.content).toContain('ACME Corp');
    expect(page.items[0]!.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(page.items[0]!.content).toContain('[REDACTED]');
  });

  it('denies conversation access when policy is disabled and self-audits as denied', async () => {
    const current = await service.getPolicy({ actorUserId: actor });
    await service.updatePolicy({
      actorUserId: actor,
      input: {
        contentAccessMode: 'disabled',
        expectedRevision: current.revision,
        reason: 'disable content',
      },
    });

    await expect(
      service.listConversations({
        actorUserId: actor,
        input: { limit: 10, userId: userA },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const logs = await serverDB.select().from(platformAuditLogs);
    const denied = logs.filter(
      (l) => l.action === 'admin.audit.conversations.list' && l.result === 'denied',
    );
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]!.targetId).toBe(userA);
    // Access log afterDiff is a bounded filter summary — no free-text q / message body.
    const serialized = JSON.stringify(denied);
    expect(serialized).toMatch(/filterSummary|content_access_denied/);
    expect(serialized).not.toMatch(/super-secret|message body|paragraph /i);
  });

  it('omits message bodies under metadata_only even when includeBody requested', async () => {
    const current = await service.getPolicy({ actorUserId: actor });
    await service.updatePolicy({
      actorUserId: actor,
      input: {
        contentAccessMode: 'metadata_only',
        expectedRevision: current.revision,
        reason: 'metadata only',
      },
    });

    await serverDB.insert(topics).values({ id: 't3', title: 'Meta', userId: userA });
    await serverDB.insert(messages).values({
      content: 'secret business body should not appear',
      id: 'm3',
      role: 'user',
      topicId: 't3',
      userId: userA,
    });

    const page = await service.listConversationMessages({
      actorUserId: actor,
      input: { includeBody: true, limit: 5, topicId: 't3', userId: userA },
    });
    expect(page.contentAccessMode).toBe('metadata_only');
    expect(page.items[0]).not.toHaveProperty('content');
    expect(page.items[0]!.hasContent).toBe(true);
  });

  it('writes self-audit without free-text q or message body', async () => {
    await service.searchUsers({
      actorUserId: actor,
      input: { limit: 5, q: 'super-secret-query-term' },
    });

    const logs = await serverDB.select().from(platformAuditLogs);
    const searchLogs = logs.filter((l) => l.action === 'admin.audit.users.search');
    expect(searchLogs.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(searchLogs);
    expect(serialized).not.toContain('super-secret-query-term');
    expect(serialized).toMatch(/hasQ|filterSummary/);
  });

  it('bounds list windows by maxListWindowDays', () => {
    expect(() =>
      resolveAuditTimeWindow({
        from: new Date('2020-01-01T00:00:00.000Z'),
        maxListWindowDays: 30,
        to: new Date('2020-06-01T00:00:00.000Z'),
      }),
    ).toThrow();

    const ok = resolveAuditTimeWindow({
      from: new Date('2020-01-01T00:00:00.000Z'),
      maxListWindowDays: 90,
      to: new Date('2020-02-01T00:00:00.000Z'),
    });
    expect(ok.from.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });
});
