// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import adminLocale from '@/locales/default/admin';

import { appendAuditAccessLog, type AuditAccessAction, buildAuditFilterSummary } from './accessLog';

const appendMock = vi.fn();

vi.mock('../platformAudit', () => ({
  PlatformAuditService: class {
    append = (...args: unknown[]) => appendMock(...args);
  },
}));

/** Exhaustive catalog of emitted audit access actions (mirrors the type union). */
const AUDIT_ACCESS_ACTIONS: readonly AuditAccessAction[] = [
  'admin.audit.conversations.get',
  'admin.audit.conversations.list',
  'admin.audit.conversations.messages',
  'admin.audit.events.facets',
  'admin.audit.events.get',
  'admin.audit.events.list',
  'admin.audit.events.stats',
  'admin.audit.exports.cancel',
  'admin.audit.exports.create',
  'admin.audit.exports.download',
  'admin.audit.exports.get',
  'admin.audit.exports.list',
  'admin.audit.get',
  'admin.audit.legalHolds.create',
  'admin.audit.legalHolds.get',
  'admin.audit.legalHolds.list',
  'admin.audit.legalHolds.release',
  'admin.audit.list',
  'admin.audit.policy.get',
  'admin.audit.policy.update',
  'admin.audit.retention.cancel',
  'admin.audit.retention.dryRun',
  'admin.audit.retention.getRun',
  'admin.audit.retention.listRuns',
  'admin.audit.retention.run',
  'admin.audit.retention.status',
  'admin.audit.retention.worker',
  'admin.audit.users.search',
  'admin.audit.users.summary',
  'admin.audit.users.timeline',
];

describe('buildAuditFilterSummary', () => {
  it('never copies free-text q or message body into the summary', () => {
    const summary = buildAuditFilterSummary({
      cursor: '2020-01-01T00:00:00.000Z|id',
      from: new Date('2020-01-01T00:00:00.000Z'),
      hasQ: true,
      includeBody: true,
      limit: 50,
      // Intentionally pass only structured flags — callers must not put q/body here.
      topicId: 'topic-1',
      userId: 'user-1',
    });

    expect(summary).toEqual({
      cursorPresent: true,
      fromPresent: true,
      hasQ: true,
      includeBody: true,
      limit: 50,
      topicIdPresent: true,
      userIdPresent: true,
    });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('topic-1');
    expect(serialized).not.toContain('user-1');
    expect(serialized).not.toContain('super-secret-query');
  });

  it('records presence flags for event filters without embedding ids', () => {
    const summary = buildAuditFilterSummary({
      action: 'admin.users.ban',
      actions: ['a', 'b'],
      actorUserId: 'actor',
      requestId: 'req-1',
      result: 'success',
      targetId: 'target',
      targetType: 'user',
      to: new Date(),
    });

    expect(summary.actionPresent).toBe(true);
    expect(summary.actionsCount).toBe(2);
    expect(summary.actorUserIdPresent).toBe(true);
    expect(summary.requestIdPresent).toBe(true);
    expect(summary.resultPresent).toBe(true);
    expect(summary.targetIdPresent).toBe(true);
    expect(summary.targetTypePresent).toBe(true);
    expect(summary.toPresent).toBe(true);
    // Structured presence flags only — never raw filter values / action names / ids.
    expect(summary).not.toHaveProperty('action');
    expect(summary).not.toHaveProperty('actorUserId');
    expect(summary).not.toHaveProperty('requestId');
    expect(summary).not.toHaveProperty('targetId');
    expect(Object.values(summary)).not.toContain('admin.users.ban');
    expect(Object.values(summary)).not.toContain('actor');
    expect(Object.values(summary)).not.toContain('req-1');
    expect(Object.values(summary)).not.toContain('target');
  });
});

describe('AuditAccessAction locale catalog', () => {
  it('has an EN default label for every emitted access action', () => {
    const missing: string[] = [];
    for (const action of AUDIT_ACCESS_ACTIONS) {
      const key = `audit.logs.action.${action}` as keyof typeof adminLocale;
      if (!(key in adminLocale) || !adminLocale[key]) missing.push(action);
    }
    expect(missing).toEqual([]);
  });
});

describe('appendAuditAccessLog fail-closed', () => {
  beforeEach(() => {
    appendMock.mockReset();
  });

  it('swallows append failures by default (low-risk reads)', async () => {
    appendMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      appendAuditAccessLog({} as never, {
        action: 'admin.audit.events.list',
        actorUserId: 'actor',
        result: 'success',
        targetType: 'audit_event',
      }),
    ).resolves.toBeUndefined();
  });

  it('rethrows append failures when required (sensitive reads/mutations)', async () => {
    appendMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      appendAuditAccessLog({} as never, {
        action: 'admin.audit.conversations.messages',
        actorUserId: 'actor',
        required: true,
        result: 'success',
        targetType: 'topic',
      }),
    ).rejects.toThrow('db down');
  });
});
