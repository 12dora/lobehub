import { describe, expect, it } from 'vitest';

import { isAnswerInThinkingSalvageFinishReason } from './serverCallLlmExecutor';

describe('isAnswerInThinkingSalvageFinishReason', () => {
  it('keys salvage on stop and end_turn only', () => {
    expect(isAnswerInThinkingSalvageFinishReason('stop')).toBe(true);
    expect(isAnswerInThinkingSalvageFinishReason('end_turn')).toBe(true);
  });

  it('does not salvage tool_calls, length, or content_filter turns', () => {
    expect(isAnswerInThinkingSalvageFinishReason('tool_calls')).toBe(false);
    expect(isAnswerInThinkingSalvageFinishReason('length')).toBe(false);
    expect(isAnswerInThinkingSalvageFinishReason('content_filter')).toBe(false);
    expect(isAnswerInThinkingSalvageFinishReason(undefined)).toBe(false);
  });
});
