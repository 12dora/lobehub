import { describe, expect, it } from 'vitest';

import { isEmptyModelCompletion } from './modelEmptyCompletion';

describe('isEmptyModelCompletion', () => {
  const base = {
    content: '',
    imageCount: 0,
    outputTokens: 0,
    reasoning: '',
    toolCallCount: 0,
  };

  it('treats a turn with real text content as non-empty', () => {
    expect(isEmptyModelCompletion({ ...base, content: 'hello' })).toBe(false);
  });

  it('treats a reasoning-only turn as non-empty', () => {
    expect(isEmptyModelCompletion({ ...base, reasoning: 'thinking...' })).toBe(false);
  });

  it('treats a tool-call turn as non-empty', () => {
    expect(isEmptyModelCompletion({ ...base, toolCallCount: 1 })).toBe(false);
  });

  it('treats an image turn as non-empty', () => {
    expect(isEmptyModelCompletion({ ...base, imageCount: 1 })).toBe(false);
  });

  it('flags a truly blank turn (no content, ~0 output tokens) as empty', () => {
    expect(isEmptyModelCompletion({ ...base, outputTokens: 1 })).toBe(true);
  });

  it('flags a blank turn with undefined output tokens as empty', () => {
    expect(isEmptyModelCompletion({ ...base, outputTokens: undefined })).toBe(true);
  });

  it('flags empty content with high output tokens as empty when no grounding is present', () => {
    expect(isEmptyModelCompletion({ ...base, outputTokens: 25_220 })).toBe(true);
  });

  it('does not flag empty content with high output tokens when grounding is present', () => {
    expect(isEmptyModelCompletion({ ...base, hasGrounding: true, outputTokens: 25_220 })).toBe(
      false,
    );
  });

  it('ignores grounding when it did not consume output tokens', () => {
    expect(isEmptyModelCompletion({ ...base, hasGrounding: true, outputTokens: 1 })).toBe(true);
  });
});
