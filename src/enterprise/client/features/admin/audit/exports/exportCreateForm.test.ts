import { describe, expect, it } from 'vitest';

import {
  buildExportCreateInput,
  type ExportCreateDraft,
  parseExportPrefill,
} from './exportCreateForm';

const window = {
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-01-08T00:00:00.000Z'),
};

const draft = (overrides: Partial<ExportCreateDraft> = {}): ExportCreateDraft => ({
  action: '',
  actorUserId: undefined,
  includeBodies: false,
  kind: 'operation_logs',
  q: '',
  range: [window.from, window.to],
  step: 0,
  topicId: '',
  userId: undefined,
  ...overrides,
});

describe('parseExportPrefill', () => {
  it('defaults to operation_logs at step 0 with empty ids and bodies off', () => {
    const parsed = parseExportPrefill(undefined, window);

    expect(parsed).toEqual({
      action: '',
      actorUserId: undefined,
      includeBodies: false,
      kind: 'operation_logs',
      q: '',
      range: [window.from, window.to],
      step: 0,
      topicId: '',
      userId: undefined,
    });
  });

  it('applies a known kind and conversation filters, and ignores unknown kinds', () => {
    const from = '2026-02-01T00:00:00.000Z';
    const to = '2026-02-08T00:00:00.000Z';
    const parsed = parseExportPrefill(
      new URLSearchParams({
        from,
        kind: 'conversations',
        to,
        topicId: 't1',
        userId: 'u1',
      }),
      window,
    );

    expect(parsed.kind).toBe('conversations');
    expect(parsed.step).toBe(1);
    expect(parsed.userId).toBe('u1');
    expect(parsed.topicId).toBe('t1');
    expect(parsed.range[0].toISOString()).toBe(from);
    expect(parsed.range[1].toISOString()).toBe(to);

    const unknown = parseExportPrefill(new URLSearchParams('kind=foo'), window);
    expect(unknown.kind).toBe('operation_logs');
    expect(unknown.step).toBe(0);
  });

  it('always resets includeBodies on parse when the URL has no includeBodies flag', () => {
    const parsed = parseExportPrefill(new URLSearchParams('kind=conversations&userId=u1'), window);

    expect(parsed.includeBodies).toBe(false);
  });
});

describe('buildExportCreateInput', () => {
  it('omits includeMessageBodies when conversations bodies are requested but not allowed', () => {
    const input = buildExportCreateInput(
      draft({ includeBodies: true, kind: 'conversations', userId: 'u1' }),
      'reason',
      false,
    );

    expect(input).not.toHaveProperty('includeMessageBodies');
  });

  it('sets includeMessageBodies when conversations bodies are requested and allowed', () => {
    const input = buildExportCreateInput(
      draft({ includeBodies: true, kind: 'conversations', userId: 'u1' }),
      'reason',
      true,
    );

    expect(input.includeMessageBodies).toBe(true);
  });

  it('does not copy user/topic/bodies onto operation_logs; user_timeline copies only userId', () => {
    const logs = buildExportCreateInput(
      draft({
        action: '  act  ',
        actorUserId: 'a1',
        includeBodies: true,
        kind: 'operation_logs',
        topicId: 't1',
        userId: 'u1',
      }),
      'r',
      true,
    );

    expect(logs.action).toBe('act');
    expect(logs.actorUserId).toBe('a1');
    expect(logs).not.toHaveProperty('userId');
    expect(logs).not.toHaveProperty('topicId');
    expect(logs).not.toHaveProperty('includeMessageBodies');

    const timeline = buildExportCreateInput(
      draft({
        includeBodies: true,
        kind: 'user_timeline',
        q: 'secret',
        topicId: 't1',
        userId: 'u1',
      }),
      'r',
      true,
    );

    expect(timeline.userId).toBe('u1');
    expect(timeline).not.toHaveProperty('includeMessageBodies');
    expect(timeline).not.toHaveProperty('topicId');
    expect(timeline).not.toHaveProperty('q');
  });
});
