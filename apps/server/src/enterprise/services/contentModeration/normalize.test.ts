import { describe, expect, it } from 'vitest';

import { MODERATION_LIMITS } from '@/const/platform/contentModeration';

import {
  extractGenerationPrompt,
  extractPromptText,
  hashPrompt,
  normalizeModerationText,
} from './normalize';

describe('extractPromptText', () => {
  it('takes the last user message, joins text parts, strips reminders, collapses space', () => {
    const text = extractPromptText({
      messages: [
        { content: 'ignored assistant', role: 'assistant' },
        { content: 'first user', role: 'user' },
        {
          content: [
            { text: 'hello', type: 'text' },
            { image_url: { url: 'x' }, type: 'image_url' },
            { text: '<system-reminder>secret</system-reminder>  world', type: 'text' },
          ],
          role: 'user',
        },
      ],
    });
    expect(text).toBe('hello world');
  });

  it('returns empty string when there is no user text', () => {
    expect(extractPromptText({ messages: [{ content: 'hi', role: 'assistant' }] })).toBe('');
    expect(extractPromptText({})).toBe('');
  });
});

describe('extractGenerationPrompt', () => {
  it('reads the prompt field', () => {
    expect(extractGenerationPrompt({ prompt: '  a   cat ' })).toBe('a cat');
  });
});

describe('normalizeModerationText', () => {
  it('caps at EXTRACT_MAX_CHARS', () => {
    const text = 'x'.repeat(MODERATION_LIMITS.EXTRACT_MAX_CHARS + 50);
    expect(normalizeModerationText(text)).toHaveLength(MODERATION_LIMITS.EXTRACT_MAX_CHARS);
  });
});

describe('hashPrompt', () => {
  it('returns a stable sha256 hex digest', () => {
    const a = hashPrompt('hello');
    const b = hashPrompt('hello');
    expect(a).toHaveLength(64);
    expect(a).toBe(b);
    expect(hashPrompt('hello!')).not.toBe(a);
  });
});
