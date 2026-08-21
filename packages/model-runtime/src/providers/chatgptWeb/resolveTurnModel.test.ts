import { describe, expect, it } from 'vitest';

import {
  chatgptWebFamilyBase,
  deriveChatGPTWebFamilyDisplayName,
  resolveChatGPTWebTurn,
} from './resolveTurnModel';

describe('chatgptWebFamilyBase', () => {
  it('returns the family id for a bare GPT-5.x slug and its Instant/Thinking/Pro SKUs', () => {
    expect(chatgptWebFamilyBase('gpt-5-6')).toBe('gpt-5-6');
    expect(chatgptWebFamilyBase('gpt-5-6-instant')).toBe('gpt-5-6');
    expect(chatgptWebFamilyBase('gpt-5-6-thinking')).toBe('gpt-5-6');
    expect(chatgptWebFamilyBase('gpt-5-6-pro')).toBe('gpt-5-6');
    expect(chatgptWebFamilyBase('gpt-5-5')).toBe('gpt-5-5');
    expect(chatgptWebFamilyBase('gpt-5-5-pro')).toBe('gpt-5-5');
  });

  it('does not treat minis, auto, or o3 as family members', () => {
    expect(chatgptWebFamilyBase('gpt-5-6-mini')).toBeUndefined();
    expect(chatgptWebFamilyBase('gpt-5-3-mini')).toBeUndefined();
    expect(chatgptWebFamilyBase('auto')).toBeUndefined();
    expect(chatgptWebFamilyBase('o3')).toBeUndefined();
  });
});

describe('deriveChatGPTWebFamilyDisplayName', () => {
  it('prefers the bare family title', () => {
    expect(
      deriveChatGPTWebFamilyDisplayName('gpt-5-7', [
        { slug: 'gpt-5-7-thinking', title: 'GPT-5.7 Thinking' },
        { slug: 'gpt-5-7', title: 'GPT-5.7' },
      ]),
    ).toBe('GPT-5.7');
  });

  it('strips Instant / Thinking / Pro from a SKU title when the family has none', () => {
    expect(
      deriveChatGPTWebFamilyDisplayName('gpt-5-7', [
        { slug: 'gpt-5-7-thinking', title: 'GPT-5.7 Thinking' },
        { slug: 'gpt-5-7-instant', title: 'GPT-5.7 Instant' },
      ]),
    ).toBe('GPT-5.7');
  });
});

describe('resolveChatGPTWebTurn', () => {
  describe.each(['gpt-5-6', 'gpt-5-5'] as const)('%s family', (family) => {
    it.each([
      ['instant', `${family}-instant`, undefined],
      ['medium', `${family}-thinking`, 'standard'],
      ['high', `${family}-thinking`, 'extended'],
      ['xhigh', `${family}-thinking`, 'max'],
      ['pro', `${family}-pro`, 'standard'],
      [undefined, `${family}-thinking`, 'standard'],
    ] as const)('maps %s → model %s / thinking_effort %s', (effort, model, thinkingEffort) => {
      expect(resolveChatGPTWebTurn({ effort, model: family })).toEqual(
        thinkingEffort ? { model, thinkingEffort } : { model },
      );
    });
  });

  it('omits thinking_effort for o3 regardless of a leftover effort value', () => {
    expect(resolveChatGPTWebTurn({ effort: 'high', model: 'o3' })).toEqual({ model: 'o3' });
    expect(resolveChatGPTWebTurn({ model: 'o3' })).toEqual({ model: 'o3' });
  });

  describe('legacy SKU pass-through', () => {
    it('leaves auto / instant / thinking / pro / mini ids unchanged', () => {
      expect(resolveChatGPTWebTurn({ model: 'auto' })).toEqual({ model: 'auto' });
      expect(resolveChatGPTWebTurn({ effort: 'high', model: 'gpt-5-6-instant' })).toEqual({
        model: 'gpt-5-6-instant',
        thinkingEffort: 'extended',
      });
      expect(resolveChatGPTWebTurn({ effort: 'xhigh', model: 'gpt-5-6-thinking' })).toEqual({
        model: 'gpt-5-6-thinking',
        thinkingEffort: 'extended',
      });
      expect(resolveChatGPTWebTurn({ model: 'gpt-5-6-pro' })).toEqual({ model: 'gpt-5-6-pro' });
      expect(resolveChatGPTWebTurn({ model: 'gpt-5-6-mini' })).toEqual({ model: 'gpt-5-6-mini' });
    });

    it('still aliases old gpt5_6ReasoningEffort values on a thinking SKU', () => {
      expect(resolveChatGPTWebTurn({ effort: 'low', model: 'gpt-5-6-thinking' })).toEqual({
        model: 'gpt-5-6-thinking',
        thinkingEffort: 'standard',
      });
      expect(resolveChatGPTWebTurn({ effort: 'max', model: 'gpt-5-6-thinking' })).toEqual({
        model: 'gpt-5-6-thinking',
        thinkingEffort: 'max',
      });
    });

    it('never puts instant or pro on the wire as thinking_effort', () => {
      expect(resolveChatGPTWebTurn({ effort: 'instant', model: 'gpt-5-6-thinking' })).toEqual({
        model: 'gpt-5-6-thinking',
      });
      expect(resolveChatGPTWebTurn({ effort: 'pro', model: 'gpt-5-6-thinking' })).toEqual({
        model: 'gpt-5-6-thinking',
      });
    });
  });
});
