import { describe, expect, it } from 'vitest';

import {
  findBuiltinProviderName,
  getModelDisplayName,
  getProviderDisplayName,
} from './modelDisplayName';

describe('getModelDisplayName', () => {
  it('resolves the card of the exact provider/model pair', () => {
    expect(getModelDisplayName('gpt-5-6', 'chatgptweb')).toBe('GPT-5.6 Sol (ChatGPT Web)');
    expect(getModelDisplayName('gpt-5-5', 'chatgptweb')).toBe('GPT-5.5 (ChatGPT Web)');
    expect(getModelDisplayName('o3', 'chatgptweb')).toBe('o3 (ChatGPT Web)');
  });

  it('falls back to the first card carrying the id when the provider has no such card', () => {
    // Heterogeneous rows store the agent (`codex`) as provider, never the model vendor.
    expect(getModelDisplayName('gpt-5.6-luna', 'codex')).toBe('GPT-5.6 Luna');
  });

  it('resolves without a provider hint', () => {
    expect(getModelDisplayName('gpt-5.6-luna')).toBe('GPT-5.6 Luna');
  });

  it('keeps ids model-bank does not describe', () => {
    expect(getModelDisplayName('unknown-x', 'p')).toBe('unknown-x');
    expect(getModelDisplayName('unknown-x')).toBe('unknown-x');
  });

  it('passes aggregate sentinels through untouched', () => {
    expect(getModelDisplayName('__other__')).toBe('__other__');
  });

  it('renders empty for missing ids', () => {
    expect(getModelDisplayName(null)).toBe('');
    expect(getModelDisplayName(undefined)).toBe('');
    expect(getModelDisplayName('')).toBe('');
  });
});

describe('getProviderDisplayName', () => {
  it('resolves builtin provider cards', () => {
    expect(getProviderDisplayName('chatgptweb')).toBe('ChatGPT Web');
    expect(getProviderDisplayName('openai')).toBe('OpenAI');
  });

  it('keeps ids that are not builtin providers', () => {
    // `codex` / `claude-code` are labelled by the client-side wrapper, not here.
    expect(getProviderDisplayName('codex')).toBe('codex');
    expect(getProviderDisplayName('unknown-provider')).toBe('unknown-provider');
  });

  it('renders empty for missing ids', () => {
    expect(getProviderDisplayName(null)).toBe('');
    expect(getProviderDisplayName(undefined)).toBe('');
  });
});

describe('findBuiltinProviderName', () => {
  it('reports whether the id is a builtin provider at all', () => {
    expect(findBuiltinProviderName('chatgptweb')).toBe('ChatGPT Web');
    expect(findBuiltinProviderName('codex')).toBeUndefined();
    expect(findBuiltinProviderName(undefined)).toBeUndefined();
  });
});
