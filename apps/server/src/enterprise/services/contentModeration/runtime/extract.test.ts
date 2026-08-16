// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { extractGenerationPrompt, extractPromptText } from './extract';

describe('extractPromptText', () => {
  it('takes the last user message and strips system-reminder blocks', () => {
    expect(
      extractPromptText({
        messages: [
          { content: 'ignored assistant', role: 'assistant' },
          {
            content: 'hello <system-reminder>secret</system-reminder> world',
            role: 'user',
          },
        ],
      }),
    ).toBe('hello world');
  });

  it('joins type:text parts', () => {
    expect(
      extractPromptText({
        messages: [
          {
            content: [
              { text: 'foo', type: 'text' },
              { image_url: { url: 'x' }, type: 'image_url' },
              { text: ' bar', type: 'text' },
            ],
            role: 'user',
          },
        ],
      }),
    ).toBe('foo bar');
  });

  it('returns null for empty / missing user text', () => {
    expect(extractPromptText({ messages: [] })).toBeNull();
    expect(extractPromptText({ messages: [{ content: '   ', role: 'user' }] })).toBeNull();
  });
});

describe('extractGenerationPrompt', () => {
  it('reads params.prompt', () => {
    expect(extractGenerationPrompt({ params: { prompt: 'a cat' } })).toBe('a cat');
  });

  it('returns null when prompt is missing', () => {
    expect(extractGenerationPrompt({ params: {} })).toBeNull();
  });
});
