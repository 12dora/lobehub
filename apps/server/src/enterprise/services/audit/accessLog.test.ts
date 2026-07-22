// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildAuditFilterSummary } from './accessLog';

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
