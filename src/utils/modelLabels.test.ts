import { describe, expect, it } from 'vitest';

import { getModelDisplayName, getProviderLabel } from '@/utils/modelLabels';

describe('getProviderLabel', () => {
  it('resolves builtin provider cards', () => {
    expect(getProviderLabel('chatgptweb')).toBe('ChatGPT Web');
  });

  it('resolves heterogeneous agent providers, which have no model-bank card', () => {
    expect(getProviderLabel('codex')).toBe('Codex');
    expect(getProviderLabel('claude-code')).toBe('Claude Code');
  });

  it('keeps unknown ids and renders empty for missing ones', () => {
    expect(getProviderLabel('cached-provider')).toBe('cached-provider');
    expect(getProviderLabel(null)).toBe('');
  });
});

describe('getModelDisplayName re-export', () => {
  it('is the shared model-bank lookup', () => {
    expect(getModelDisplayName('gpt-5-6', 'chatgptweb')).toBe('GPT-5.6 Sol (ChatGPT Web)');
    expect(getModelDisplayName('gpt')).toBe('gpt');
  });
});
