import { describe, expect, it } from 'vitest';

import { EFFORT_CONTROL_KEYS, pickChatConfigEffortFields } from './effortControlRegistry';

describe('pickChatConfigEffortFields', () => {
  it('returns an empty object for a missing chatConfig', () => {
    expect(pickChatConfigEffortFields(undefined)).toEqual({});
    expect(pickChatConfigEffortFields(null)).toEqual({});
  });

  it('keeps every registry effort key and drops everything else', () => {
    const picked = pickChatConfigEffortFields({
      displayMode: 'chat',
      enableHistoryCount: true,
      gpt5_6ReasoningEffort: 'high',
      historyCount: 8,
      searchMode: 'auto',
      thinking: 'enabled',
    } as any);

    expect(picked).toEqual({ gpt5_6ReasoningEffort: 'high', thinking: 'enabled' });
  });

  it('ignores keys explicitly set to undefined', () => {
    expect(pickChatConfigEffortFields({ reasoningEffort: undefined } as any)).toEqual({});
  });

  it('does not copy token-budget params, which have no discrete level', () => {
    const picked = pickChatConfigEffortFields({
      reasoningBudgetToken: 4096,
      thinkingBudget: 1024,
    } as any);

    expect(picked).toEqual({});
    expect(EFFORT_CONTROL_KEYS).not.toContain('thinkingBudget');
  });
});
