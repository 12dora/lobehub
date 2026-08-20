// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { messages, topics, users } from '@/database/schemas';
import {
  platformAuditLegalHolds,
  platformAuditLogs,
  platformAuditPolicies,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import * as accessLog from './accessLog';
import { AdminAuditService } from './adminAuditService';
import { resolveAuditTimeWindow } from './timeWindow';

const serverDB: LobeChatDatabase = await getTestDB();
const service = new AdminAuditService(serverDB);

const actor = 'audit-svc-actor';
const userA = 'audit-svc-user-a';
const userB = 'audit-svc-user-b';

const clearAuditLogs = async () => {
  await serverDB.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await tx.delete(platformAuditLogs);
  });
};

beforeEach(async () => {
  await clearAuditLogs();
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
  await clearAuditLogs();
  await serverDB.delete(platformAuditLegalHolds);
  await serverDB.delete(platformAuditPolicies);
  await serverDB.delete(messages);
  await serverDB.delete(topics);
});

describe('AdminAuditService', () => {
  it('redacts fingerprint fields from operation detail reads', async () => {
    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.settings.publish',
      afterDiff: {
        displayName: 'Acme Corp Legal Entity',
        nested: { certificateFingerprint: 'legacy-sensitive-metadata' },
        fingerprint: 'legacy-sensitive-metadata',
      },
      beforeDiff: { displayName: 'Old Name' },
      id: 'op-detail-1',
      result: 'success',
      targetId: 'global',
      targetType: 'settings',
    });

    const detail = await service.getEvent({ actorUserId: actor, id: 'op-detail-1' });
    expect(detail.afterDiff).toEqual({
      displayName: 'Acme Corp Legal Entity',
      nested: {},
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
    expect(page.contentAccessMode).toBe('content_allowed');
    const item = page.items[0];
    expect(item).toBeDefined();
    if (!item || !('content' in item)) {
      throw new Error('expected content_allowed message item with body');
    }
    expect(item.content).toBe(ordinary);
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
    expect(page.contentAccessMode).toBe('content_allowed');
    const item = page.items[0];
    expect(item).toBeDefined();
    if (!item || !('content' in item)) {
      throw new Error('expected content_allowed message item with body');
    }
    expect(item.content).toContain('ACME Corp');
    expect(item.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(item.content).toContain('[REDACTED]');
  });

  it('preserves credentials in message body when content_allowed and redactionProfile is off', async () => {
    const current = await service.getPolicy({ actorUserId: actor });
    await service.updatePolicy({
      actorUserId: actor,
      input: {
        contentAccessMode: 'content_allowed',
        expectedRevision: current.revision,
        reason: 'enable content with redaction off',
        redactionProfile: 'off',
      },
    });

    const body =
      'Please use sk-abcdefghijklmnopqrstuvwxyz012345 for the demo and keep ACME Corp name.';
    await serverDB.insert(topics).values({ id: 't-off', title: 'Keys', userId: userA });
    await serverDB.insert(messages).values({
      content: body,
      id: 'm-off',
      role: 'user',
      topicId: 't-off',
      userId: userA,
    });

    const page = await service.listConversationMessages({
      actorUserId: actor,
      input: { includeBody: true, limit: 5, topicId: 't-off', userId: userA },
    });
    expect(page.contentAccessMode).toBe('content_allowed');
    const item = page.items[0];
    expect(item).toBeDefined();
    if (!item || !('content' in item)) {
      throw new Error('expected content_allowed message item with body');
    }
    expect(item.content).toBe(body);
    expect(item.content).toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('records redactionProfile in policy-update access-log diffs', async () => {
    const before = await service.getPolicy({ actorUserId: actor });
    expect(before.redactionProfile).toBe('strict');

    await service.updatePolicy({
      actorUserId: actor,
      input: {
        expectedRevision: before.revision,
        reason: 'disable conversation credential masking',
        redactionProfile: 'off',
      },
    });

    const logs = await serverDB.select().from(platformAuditLogs);
    const updateLog = logs.find(
      (row) => row.action === 'admin.audit.policy.update' && row.result === 'success',
    );
    expect(updateLog).toBeDefined();
    expect(updateLog!.beforeDiff).toMatchObject({ redactionProfile: 'strict' });
    expect(updateLog!.afterDiff).toMatchObject({ redactionProfile: 'off' });
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
    const item = page.items[0];
    expect(item).toBeDefined();
    if (!item || !('hasContent' in item)) {
      throw new Error('expected metadata-only message item');
    }
    expect(item).not.toHaveProperty('content');
    expect(item.hasContent).toBe(true);
  });

  it('revocation mid-stream: subsequent poll re-checks policy and stops serving bodies', async () => {
    const current = await service.getPolicy({ actorUserId: actor });
    if (current.contentAccessMode !== 'content_allowed') {
      await service.updatePolicy({
        actorUserId: actor,
        input: {
          contentAccessMode: 'content_allowed',
          expectedRevision: current.revision,
          reason: 'enable for mid-stream',
        },
      });
    }

    await serverDB.insert(topics).values({ id: 't-live', title: 'Live', userId: userA });
    await serverDB.insert(messages).values({
      content: 'body-while-authorized',
      id: 'm-live',
      role: 'user',
      topicId: 't-live',
      userId: userA,
    });

    const authorized = await service.listConversationMessages({
      actorUserId: actor,
      input: { includeBody: true, limit: 5, topicId: 't-live', userId: userA },
    });
    expect(authorized.contentAccessMode).toBe('content_allowed');
    const authorizedItem = authorized.items[0];
    if (!authorizedItem || !('content' in authorizedItem)) {
      throw new Error('expected body while authorized');
    }
    expect(authorizedItem.content).toBe('body-while-authorized');

    // Policy revoked mid-stream (between live polls).
    const mid = await service.getPolicy({ actorUserId: actor });
    await service.updatePolicy({
      actorUserId: actor,
      input: {
        contentAccessMode: 'metadata_only',
        expectedRevision: mid.revision,
        reason: 'revoke mid-stream',
      },
    });

    const afterRevoke = await service.listConversationMessages({
      actorUserId: actor,
      input: { includeBody: true, limit: 5, topicId: 't-live', userId: userA },
    });
    expect(afterRevoke.contentAccessMode).toBe('metadata_only');
    const revokedItem = afterRevoke.items[0];
    expect(revokedItem).toBeDefined();
    expect(revokedItem).not.toHaveProperty('content');
    if (!revokedItem || !('hasContent' in revokedItem)) {
      throw new Error('expected metadata-only item after revocation');
    }
    expect(revokedItem.hasContent).toBe(true);
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

  it('rejects non-future legal hold expiresAt and projects elapsed holds as expired', async () => {
    await expect(
      service.createLegalHold({
        actorUserId: actor,
        input: {
          expiresAt: new Date(Date.now() - 60_000),
          reason: 'past expiry must fail',
          scopeId: userA,
          scopeType: 'user',
        },
      }),
    ).rejects.toBeTruthy();

    // Seed an already-elapsed hold at the model layer (service create rejects past dates).
    const past = new Date('2020-01-01T00:00:00.000Z');
    await serverDB.insert(platformAuditLegalHolds).values({
      createdBy: actor,
      expiresAt: past,
      id: 'hold-elapsed-1',
      reason: 'legacy elapsed',
      scopeId: userA,
      scopeType: 'user',
      status: 'active',
    });

    const got = await service.getLegalHold({ actorUserId: actor, id: 'hold-elapsed-1' });
    expect(got.status).toBe('expired');

    const listedActive = await service.listLegalHolds({
      actorUserId: actor,
      input: { limit: 50, status: 'active' },
    });
    expect(listedActive.items.every((h) => h.status === 'active')).toBe(true);
    expect(listedActive.items.some((h) => h.id === 'hold-elapsed-1')).toBe(false);

    const listedAll = await service.listLegalHolds({
      actorUserId: actor,
      input: { limit: 50 },
    });
    const elapsed = listedAll.items.find((h) => h.id === 'hold-elapsed-1');
    expect(elapsed?.status).toBe('expired');
  });
});

describe('AdminAuditService fail-closed audit writes', () => {
  beforeEach(async () => {
    await clearAuditLogs();
    await serverDB.delete(platformAuditLegalHolds);
    await serverDB.delete(platformAuditPolicies);
    await serverDB.delete(messages);
    await serverDB.delete(topics);
    await serverDB.delete(users).where(eq(users.id, actor));
    await serverDB.delete(users).where(eq(users.id, userA));
    await serverDB.insert(users).values([{ id: actor }, { id: userA }]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearAuditLogs();
    await serverDB.delete(platformAuditLegalHolds);
    await serverDB.delete(platformAuditPolicies);
    await serverDB.delete(messages);
    await serverDB.delete(topics);
  });

  it('rejects sensitive body read when required audit write fails (not silently allowed)', async () => {
    const current = await service.getPolicy({ actorUserId: actor });
    if (current.contentAccessMode !== 'content_allowed') {
      await service.updatePolicy({
        actorUserId: actor,
        input: {
          contentAccessMode: 'content_allowed',
          expectedRevision: current.revision,
          reason: 'enable for fail-closed',
        },
      });
    }

    await serverDB.insert(topics).values({ id: 't-fc', title: 'FC', userId: userA });
    await serverDB.insert(messages).values({
      content: 'must-not-leak-without-audit',
      id: 'm-fc',
      role: 'user',
      topicId: 't-fc',
      userId: userA,
    });

    const spy = vi
      .spyOn(accessLog, 'appendAuditAccessLog')
      .mockImplementation(async (_db, params) => {
        if (params.required) {
          throw new Error('INJECTED_AUDIT_WRITE_FAILURE');
        }
      });

    await expect(
      service.listConversationMessages({
        actorUserId: actor,
        input: { includeBody: true, limit: 5, topicId: 't-fc', userId: userA },
      }),
    ).rejects.toThrow(/INJECTED_AUDIT_WRITE_FAILURE|failure/i);

    // Sensitive op must not complete successfully when audit cannot be recorded.
    expect(spy).toHaveBeenCalled();
    const requiredCalls = spy.mock.calls.filter(([, p]) => p.required === true);
    expect(requiredCalls.length).toBeGreaterThan(0);
  });

  it('rolls back policy mutation when required audit write fails', async () => {
    const before = await service.getPolicy({ actorUserId: actor });
    const beforeMode = before.contentAccessMode;
    const beforeRevision = before.revision;

    vi.spyOn(accessLog, 'appendAuditAccessLog').mockImplementation(async (_db, params) => {
      if (params.required && params.action === 'admin.audit.policy.update') {
        throw new Error('INJECTED_AUDIT_WRITE_FAILURE');
      }
    });

    await expect(
      service.updatePolicy({
        actorUserId: actor,
        input: {
          contentAccessMode: beforeMode === 'disabled' ? 'metadata_only' : 'disabled',
          expectedRevision: beforeRevision,
          reason: 'must roll back without audit',
        },
      }),
    ).rejects.toThrow(/INJECTED_AUDIT_WRITE_FAILURE|failure/i);

    // Mutation must not stick — fail closed / transactional audit.
    const after = await service.getPolicy({ actorUserId: actor });
    expect(after.contentAccessMode).toBe(beforeMode);
    expect(after.revision).toBe(beforeRevision);
  });
});
